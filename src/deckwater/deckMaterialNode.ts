/**
 * Deck wetness TSL hook (§V9 "deck material roughness↓ where wet").
 *
 * OUTPUT CONTRACT — deliberately the same shape as caustics' `waterLighting()`
 * (§V34), so a deck material composes both instead of fighting them: every
 * field MODULATES the receiver's own material and none of them replaces it.
 * `tint` and `roughnessScale`/`reliefScale` multiply; `heightAdd` adds into
 * whatever procedural height field the material already differentiates.
 *
 * The state texture is the solver's front buffer, so this costs one sample
 * (plus the material's own work) and no extra pass. Channels, per §V9:
 * R = static deck heightfield, G = wetness (ratchets up, dries slowly),
 * B = standing water volume, A = spare.
 *
 * WHY heightAdd RATHER THAN A NORMAL: src/ship's wood material builds ONE
 * scalar height field and hands it to `reliefNormal()` (screen-space
 * derivatives, Mikkelsen). Returning a normal here would mean a second normal
 * to blend and would throw away the plank grain; returning a height means the
 * water layer joins the same field and the puddle rim gets its shading for
 * free. Only B enters it — never R, because R is the SOLVER's synthetic deck
 * (camber, rails, scuppers) and embossing that onto the ship's real geometry
 * would paint fake planking and fake rails across the deck.
 *
 * §V23: functional mix()/smoothstep() only. §V31: colours enter via color(hex).
 * §V28: every divisor here is baked from construction-time frame extents,
 * floored in deckFrame, so no uv divide can produce NaN.
 */
import { color, float, mix, smoothstep, texture, uniform, vec2, vec3 } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { deckWaterParams as dp } from '../params/deckwater';
import type { DeckFrame } from './deckFrame';

/** TSL nodes are structurally different per operation (house convention) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TslNode = any;

export interface DeckWetnessUniforms {
  wetTint: TslNode;
  poolTint: TslNode;
  wetRoughness: TslNode;
  wetRelief: TslNode;
  poolRoughness: TslNode;
  poolDepth: TslNode;
  heightScale: TslNode;
  /** (inner, outer) ship-local distance from the deck plane */
  band: TslNode;
}

export function createDeckWetnessUniforms(): DeckWetnessUniforms {
  return {
    wetTint: uniform(color(dp.wetTintColor)),
    poolTint: uniform(color(dp.poolTintColor)),
    wetRoughness: uniform(dp.wetRoughness),
    wetRelief: uniform(dp.wetRelief),
    poolRoughness: uniform(dp.poolRoughness),
    poolDepth: uniform(dp.poolDepthRef),
    heightScale: uniform(dp.waterHeightScale),
    // (inner, outer); inner < outer is required by the functional smoothstep
    // that consumes it — reversed edges are undefined, not merely inverted
    band: uniform(new THREE.Vector2(dp.deckBandInner, dp.deckBandOuter)),
  };
}

/** re-read live params (Tweakpane mutates in place, §V16) */
export function refreshDeckWetnessUniforms(u: DeckWetnessUniforms): void {
  (u.wetTint.value as THREE.Color).set(dp.wetTintColor); // sRGB via Color.set (§V31)
  (u.poolTint.value as THREE.Color).set(dp.poolTintColor);
  u.wetRoughness.value = dp.wetRoughness;
  u.wetRelief.value = dp.wetRelief;
  u.poolRoughness.value = dp.poolRoughness;
  u.poolDepth.value = dp.poolDepthRef;
  u.heightScale.value = dp.waterHeightScale;
  (u.band.value as THREE.Vector2).set(
    dp.deckBandInner,
    Math.max(dp.deckBandInner + 1e-3, dp.deckBandOuter),
  );
}

export interface DeckReceiver {
  /**
   * Ship-local position of the shaded point (vec3 node). The deck material
   * already computes this for the hull wetline —
   * `uShipWorldInverse.mul(vec4(positionWorld, 1)).xyz` — so reuse it rather
   * than inverting the ship matrix a second time.
   */
  shipLocalPos: TslNode;
}

export interface DeckWetness {
  /** vec3 ≤1 — MULTIPLY into colorNode: darker and more saturated where wet */
  tint: TslNode;
  /** float ≤1 — MULTIPLY into roughnessNode (§V9) */
  roughnessScale: TslNode;
  /** float ≤1 — MULTIPLY into the material's bump/relief height */
  reliefScale: TslNode;
  /** float ≥0 — ADD into that same height field, AFTER reliefScale */
  heightAdd: TslNode;
  /** 0..1 plank wetness, gated to the deck plane — drive your own response */
  wet: TslNode;
  /** 0..1 standing water ("there is a puddle here"), gated the same way */
  pool: TslNode;
}

/** identity in every slot — folds away at compile time */
export function neutralDeckWetness(): DeckWetness {
  return {
    tint: vec3(1, 1, 1),
    roughnessScale: float(1),
    reliefScale: float(1),
    heightAdd: float(0),
    wet: float(0),
    pool: float(0),
  };
}

export interface DeckWetnessContext {
  /** the solver's FRONT state texture (stable across substeps by design) */
  state: THREE.Texture;
  frame: DeckFrame;
  u: DeckWetnessUniforms;
}

export function deckWetnessNode(ctx: DeckWetnessContext, r: DeckReceiver): DeckWetness {
  const { frame, u } = ctx;
  // baked, not uniforms: the grid's ship-local extents do not move (the same
  // call caustics makes for its wetline span). CPU mirror: deckFrame.deckUv —
  // these two must agree or the water shades where it is not.
  const invBeam = 1 / Math.max(1e-6, frame.maxX - frame.minX);
  const invLength = 1 / Math.max(1e-6, frame.maxZ - frame.minZ);
  const local = r.shipLocalPos;
  const uu = local.x.sub(float(frame.minX)).mul(float(invBeam)); // across beam
  const vv = local.z.sub(float(frame.minZ)).mul(float(invLength)); // aft → fwd
  const uv = vec2(uu.clamp(0, 1), vv.clamp(0, 1));

  // Only the WAIST — the walking surface of the main deck. Forecastle and
  // quarterdeck are a metre or two higher with their own soles; a single
  // heightfield cannot be on two levels at once, so the raised decks stay dry
  // rather than wearing the waist's puddles at the wrong altitude.
  const dy = local.y.sub(float(frame.planeY)).abs();
  const plane = smoothstep(u.band.x, u.band.y, dy).oneMinus();
  // and inside the grid: uv was CLAMPED for the sampler, so without this the
  // border cells would smear their state along the whole overhang. Faded, not
  // stepped — `heightAdd` feeds a field that reliefNormal differentiates in
  // screen space, where a hard edge spikes to a one-pixel line (the reason
  // woodMaterial crowns its planks instead of stepping them).
  const EDGE_FADE = 0.01; // uv
  const inRange = (x: TslNode): TslNode =>
    smoothstep(float(0), float(EDGE_FADE), x).mul(
      smoothstep(float(0), float(EDGE_FADE), x.oneMinus()),
    );
  const mask = plane.mul(inRange(uu)).mul(inRange(vv));

  const state = texture(ctx.state, uv);
  const wet = state.g.mul(mask);
  // "is there standing water here", separate from "are the planks wet" —
  // wetness outlives the puddle by design (§V9), and a wet plank and a puddle
  // do not look alike
  const pool = smoothstep(float(0), u.poolDepth.max(1e-4), state.b).mul(mask);

  return {
    tint: mix(vec3(1, 1, 1), u.wetTint, wet).mul(mix(vec3(1, 1, 1), u.poolTint, pool)),
    roughnessScale: mix(float(1), u.wetRoughness, wet).mul(
      mix(float(1), u.poolRoughness, pool),
    ),
    reliefScale: mix(float(1), u.wetRelief, wet),
    heightAdd: state.b.mul(mask).mul(u.heightScale),
    wet,
    pool,
  };
}
