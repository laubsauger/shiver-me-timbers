/**
 * Water lighting TSL node (§V.34, §T.32) — ONE hook that carries everything
 * the sea does to an object floating in it:
 *
 *   1. caustics      refracted sun-ray divergence below the line, and the
 *                    sun reflected off the waves onto the hull above it.
 *   2. bounce fill   the sea is a huge bright turquoise surface; downward-
 *                    facing timber near the water picks it up. This is the
 *                    term that actually welds the ship to the sea.
 *   3. wetness       darker, more saturated, much smoother, and flatter in
 *                    the grain — tracking where the water LAPPED, with a
 *                    drying memory (hullWetline.ts), not a painted stripe.
 *   4. absorption    hull below the line is lit through water: dimmer and
 *                    losing red with depth, matching §V.24's model.
 *
 * The palette is deliberately keyed to ocean/surfaceMaterial's own colours —
 * a bounce tint picked independently would light the ship as if a different
 * sea were underneath it.
 *
 * OUTPUT CONTRACT: every field is a MODULATION of the receiver's material,
 * never a replacement. `tint` and `roughnessScale`/`reliefScale` multiply;
 * `addLight` adds. Whatever relief/grain/normal work the hull material does
 * survives untouched.
 *
 * §V.23: functional mix(a,b,t) / smoothstep(e0,e1,x) throughout.
 * §V.31: `*Color` params enter via color(hex); the absorption VECTOR is an
 * extinction coefficient in 1/m and must NOT get an sRGB transfer.
 */
import * as THREE from 'three/webgpu';
import { color, float, mix, smoothstep, texture, uniform, vec2, vec3 } from 'three/tsl';
import type { OceanSimulation } from '../ocean/oceanCascades';
import { causticsParams as cp } from '../params/caustics';
import {
  causticsNode,
  waterHeightNode,
  type CausticsUniforms,
  type TslNode,
} from './causticsNode';
import type { HullWetline } from './hullWetline';

export interface WaterLightingUniforms {
  causticColor: TslNode;
  bounceColor: TslNode;
  bounce: TslNode; // (strength, heightFalloff, sunFloor, sunGain)
  bounceFlicker: TslNode;
  wetTint: TslNode;
  wetBand: TslNode; // (above, below)
  wetRoughness: TslNode;
  wetRelief: TslNode;
  wetRise: TslNode;
  wetSideBlend: TslNode;
  pathScale: TslNode;
}

export function createWaterLightingUniforms(): WaterLightingUniforms {
  return {
    causticColor: uniform(color(cp.causticColor)),
    bounceColor: uniform(color(cp.bounceColor)),
    bounce: uniform(
      new THREE.Vector4(
        cp.bounceStrength, cp.bounceHeightFalloff, cp.bounceSunFloor, cp.bounceSunGain,
      ),
    ),
    bounceFlicker: uniform(cp.bounceFlicker),
    wetTint: uniform(color(cp.wetTintColor)),
    wetBand: uniform(new THREE.Vector2(cp.wetBandAbove, cp.wetBandBelow)),
    wetRoughness: uniform(cp.wetRoughness),
    wetRelief: uniform(cp.wetReliefFlatten),
    wetRise: uniform(cp.wetRise),
    wetSideBlend: uniform(cp.wetSideBlend),
    pathScale: uniform(cp.submergedPathScale),
  };
}

export function refreshWaterLightingUniforms(u: WaterLightingUniforms): void {
  (u.causticColor.value as THREE.Color).set(cp.causticColor);
  (u.bounceColor.value as THREE.Color).set(cp.bounceColor);
  (u.bounce.value as THREE.Vector4).set(
    cp.bounceStrength, cp.bounceHeightFalloff, cp.bounceSunFloor, cp.bounceSunGain,
  );
  u.bounceFlicker.value = cp.bounceFlicker;
  (u.wetTint.value as THREE.Color).set(cp.wetTintColor);
  (u.wetBand.value as THREE.Vector2).set(cp.wetBandAbove, cp.wetBandBelow);
  u.wetRoughness.value = cp.wetRoughness;
  u.wetRelief.value = cp.wetReliefFlatten;
  u.wetRise.value = cp.wetRise;
  u.wetSideBlend.value = cp.wetSideBlend;
  u.pathScale.value = cp.submergedPathScale;
}

export interface WaterReceiver {
  /** world position of the shaded point (vec3 node) — required */
  worldPos: TslNode;
  /** world normal (vec3 node). Defaults to +Y, which zeroes the bounce. */
  normal?: TslNode;
  /**
   * metres below the sea surface, positive submerged. Supply it when the
   * receiver already knows (seabed depth field); otherwise the node samples
   * the ocean displacement textures itself for 3 extra taps.
   */
  depthBelowSurface?: TslNode;
  /** world Y of the sea here — an alternative to depthBelowSurface */
  waterHeight?: TslNode;
  /** ship-local position (vec3). Required to use the wetline drying memory. */
  shipLocalPos?: TslNode;
  /** 0..1 sun visibility; reuse sunLight.shadow.shadowNode, do not build a 2nd */
  shadow?: TslNode;
  /** 'below' compiles out the above-water reflected branch (seabed, beach) */
  mode?: 'both' | 'below';
}

export interface WaterLighting {
  /** vec3 ≤1 — MULTIPLY into the material's colorNode (albedo) */
  tint: TslNode;
  /** vec3 ≥0 — ADD into the material's emissiveNode */
  addLight: TslNode;
  /** float ≤1 — MULTIPLY into the material's roughnessNode */
  roughnessScale: TslNode;
  /** float ≤1 — MULTIPLY into any bump/normal relief strength */
  reliefScale: TslNode;
  /** raw caustic contribution, if a receiver wants it on its own */
  caustics: TslNode;
  /** 0..1 wetness, for a receiver that wants to drive its own response */
  wet: TslNode;
  /** 0..1 below the waterline */
  submerged: TslNode;
  /** signed metres below the sea surface */
  depth: TslNode;
}

export interface WaterLightingContext {
  sim: OceanSimulation;
  caustics: CausticsUniforms;
  lighting: WaterLightingUniforms;
  wetline?: HullWetline;
  /** vec2(sternZ, 1/(bowZ − sternZ)) — maps ship-local z onto the texture */
  wetlineSpan?: TslNode;
}

/**
 * Wet height from the hull's drying memory (hullWetline.ts). Rows are port /
 * starboard; the station axis is ship-local Z. Falls back to the live wave
 * height when no wetline is bound, which still moves the band with the swell
 * but has no drying lag.
 */
function wetDepthNode(ctx: WaterLightingContext, r: WaterReceiver, depth: TslNode): TslNode {
  const rise = ctx.lighting.wetRise;
  // no memory bound → the band still rides the live local wave (so it is not
  // a fixed ring), but it has no drying lag. See the header of hullWetline.
  if (!ctx.wetline || !r.shipLocalPos || !ctx.wetlineSpan) return depth.add(rise);
  const u = r.shipLocalPos.z.sub(ctx.wetlineSpan.x).mul(ctx.wetlineSpan.y).clamp(0, 1);
  // Port/starboard rows sit at v = 0.25 / 0.75, so sliding v across the keel
  // lets the texture's own LinearFilter blend the two. A step() here would
  // draw a hard seam down the centreline — and §V.38 records that the hull
  // material differentiates its height field in screen space, where any
  // discontinuity this contributes to spikes into a one-pixel line.
  const blend = ctx.lighting.wetSideBlend.max(1e-3);
  const side = smoothstep(blend.negate(), blend, r.shipLocalPos.x);
  const wetTop = texture(ctx.wetline.texture, vec2(u, side.mul(0.5).add(0.25))).r;
  return wetTop.sub(r.shipLocalPos.y).add(rise);
}

/** the one call receivers make — see the OUTPUT CONTRACT in the header */
export function waterLightingNode(
  ctx: WaterLightingContext,
  r: WaterReceiver,
): WaterLighting {
  const L = ctx.lighting;
  const worldXZ = vec2(r.worldPos.x, r.worldPos.z);
  const normal = r.normal ?? vec3(0, 1, 0);
  const shadow = r.shadow ?? float(1);

  const depth = r.depthBelowSurface
    ?? (r.waterHeight ?? waterHeightNode(ctx.sim, worldXZ)).sub(r.worldPos.y);

  const caustics = causticsNode(ctx.sim, ctx.caustics, r.worldPos, depth, r.mode ?? 'both');
  const submerged = smoothstep(
    ctx.caustics.waterlineBlend.negate(), ctx.caustics.waterlineBlend, depth,
  );

  // ── wetness ─────────────────────────────────────────────────────────
  const wet = smoothstep(
    L.wetBand.x.negate(), L.wetBand.y.max(1e-3), wetDepthNode(ctx, r, depth),
  );

  // ── submerged absorption: red dies first (§V.24 model, same shape) ───
  // pathScale > 1 because light also travels back to the eye through water,
  // and the receiver only knows its own depth
  const path = depth.max(0).mul(L.pathScale);
  const absorb = ctx.caustics.absorption.mul(path).negate().exp();

  // ── bounce fill: the sea lighting whatever floats on it ──────────────
  // downward-facing surfaces see the most water; the term dies going up the
  // rig so a masthead is not lit as if it sat on the waves
  const facing = float(0.5).sub(normal.y.mul(0.5)).clamp(0, 1);
  const heightAbove = depth.negate().max(0);
  const heightFade = heightAbove.div(L.bounce.y.max(0.01)).negate().exp();
  const sunTerm = L.bounce.z.add(L.bounce.w.mul(ctx.caustics.sunDirection.y.clamp(0, 1)));
  // the bounce off a wavy sea is not steady — the reflected caustic pattern
  // is exactly its flicker, and it is already computed
  const flicker = float(1).add(caustics.g.mul(L.bounceFlicker));
  const bounce = L.bounceColor
    .mul(L.bounce.x)
    .mul(facing)
    .mul(heightFade)
    .mul(sunTerm)
    .mul(flicker);

  return {
    tint: mix(vec3(1, 1, 1), L.wetTint, wet).mul(absorb),
    // caustics are direct sun and must obey the sun shadow; the bounce is
    // ambient sky/sea light and survives in shade
    // the caustic already carries its own per-channel Jerlov attenuation, so
    // this tint is the SURFACE colour of the sunlight only
    addLight: bounce.add(L.causticColor.mul(caustics).mul(shadow)),
    roughnessScale: mix(float(1), L.wetRoughness, wet),
    reliefScale: mix(float(1), L.wetRelief, wet),
    caustics,
    wet,
    submerged,
    depth,
  };
}
