/**
 * TSL side of the planar reflection (§V26, §V20): turns the mirror pass's
 * render target into the colour the ocean material puts in its reflection
 * slot, and degrades gracefully back to the analytic sky.
 *
 * DESIGN RULE (§V20): this node replaces the CONTENT of the ocean's reflected
 * colour, never its WEIGHT. The ocean keeps owning `fresnel × reflectionStrength`
 * (capped at 0.13 for the painted-water look), so wiring reflections in cannot
 * turn the sea into a mirror — the worst it can do is change what the 13% is
 * made of. The fresnel weighting §V26 asks for is therefore already in place
 * at the call site; what is added here is the break-up and the distance
 * dissolve that stop a flat RT from reading as a glass sheet.
 *
 * §V23 REMINDER: all 3-arg math below is the FUNCTIONAL form — mix(a,b,t),
 * smoothstep(e0,e1,x). The two smoothsteps with e0 > e1 carry their reading
 * in a comment at the use site (§B.1/§B.2 both cost a session).
 */
import * as THREE from 'three/webgpu';
import { color, mix, screenUV, smoothstep, uniform, vec2 } from 'three/tsl';
import { reflectionParams as rp } from '../params/reflection';

/**
 * TSL nodes only line up structurally at runtime; the codebase types local
 * shader helpers loosely rather than threading generics (same convention as
 * ocean/foam/flowfoam).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TslNode = any;

export interface ReflectionShadeInput {
  /**
   * The ocean's own analytic sky reflection colour. It is the fallback when
   * the mirror pass is off, the far field past `fadeEnd`, and the thing the
   * RT sample dissolves into — so the seam is never visible.
   */
  skyColor: TslNode;
  /** world-space shading normal of the water surface (unit) */
  normalWorld: TslNode;
  /** horizontal displacement magnitude in metres — the choppiness/steepness */
  chop: TslNode;
  /** distance from the eye to the shaded point, metres */
  camDist: TslNode;
}

export interface ReflectionShading {
  /** reflected colour node — drop-in replacement for the analytic sky term */
  shade(input: ReflectionShadeInput): TslNode;
  /** push live params → uniforms (per frame) */
  updateFromParams(): void;
  /**
   * 1 = the mirror pass produced a valid frame, 0 = fall back to analytic sky.
   * Driven by the reflection system (quality toggle, eye below the plane).
   */
  setActive(active: boolean): void;
}

/** §V28: every divisor in the shader is floored, every uniform finite-guarded */
const EPS = 1e-4;
const finite = (v: number, fallback: number): number =>
  Number.isFinite(v) ? v : fallback;

export function createReflectionShading(
  reflectionNode: TslNode,
  useMipmaps: boolean,
): ReflectionShading {
  const uActive = uniform(0);
  const uStrength = uniform(rp.strength);
  const uTint = uniform(color(rp.tint));
  // (per-unit-slope, per-metre-chop, clamp) screen-space distortion
  const uDistort = uniform(
    new THREE.Vector3(rp.distortSlope, rp.distortChop, rp.distortMax),
  );
  const uFade = uniform(new THREE.Vector2(rp.fadeStart, rp.fadeEnd));
  const uBlur = uniform(
    new THREE.Vector3(rp.blurNear, rp.blurFar, rp.blurChop),
  );
  const uBlurMax = uniform(rp.blurMax);

  const shade = (input: ReflectionShadeInput): TslNode => {
    const { skyColor, normalWorld, chop, camDist } = input;

    // Break-up: push the lookup around by the wave's own slope plus its
    // horizontal (choppy) displacement, so the mirrored scene shears on chop
    // instead of sitting there as one rigid sheet (§V26 "blur ok").
    // The tap stays inside `distortMax` of its origin — an unbounded offset
    // is a fill-rate/cache trap and can pull in unrelated screen regions.
    const slope = vec2(normalWorld.x, normalWorld.z);
    const offset = slope
      .mul(uDistort.x)
      .add(slope.mul(chop.mul(uDistort.y)))
      .clamp(uDistort.z.negate(), uDistort.z);
    // flipX is NOT decoration: the virtual camera's basis comes out with its
    // right vector negated (see mirrorMath.mirrorCameraPose), so the render
    // target is horizontally mirrored relative to the screen.
    const uv = screenUV.flipX().add(offset);

    // Distance + steepness blur. Mip level, not a multi-tap kernel: the
    // reflection is already at ≤ half res (§V26) and the ocean covers most of
    // the screen, so extra taps here are the expensive kind (§V17).
    // smoothstep(e0,e1,x) normal order: 0 inside fadeStart, 1 past fadeEnd.
    const distT = smoothstep(uFade.x, uFade.y, camDist);
    let sample = reflectionNode.sample(uv);
    if (useMipmaps) {
      const lod = mix(uBlur.x, uBlur.y, distT)
        .add(chop.mul(uBlur.z))
        .clamp(0, uBlurMax);
      sample = sample.level(lod);
    }
    const reflected = sample.rgb.mul(uTint);

    // Dissolve back into the analytic sky with distance: past `fadeEnd` the
    // half-res RT carries no readable detail anyway, and the ocean's own haze
    // (§V30) takes over from there — so the transition has nothing to hide.
    // smoothstep(e0,e1,x) with e0 > e1 reads "1 below fadeStart, 0 above
    // fadeEnd" (§V23 — functional form, receiver-free).
    const nearFade = smoothstep(uFade.y, uFade.x, camDist);
    const weight = uActive.mul(uStrength).mul(nearFade).clamp(0, 1);
    return mix(skyColor, reflected, weight);
  };

  return {
    shade,
    updateFromParams(): void {
      uStrength.value = THREE.MathUtils.clamp(finite(rp.strength, 1), 0, 1);
      (uTint.value as THREE.Color).set(rp.tint);
      (uDistort.value as THREE.Vector3).set(
        Math.max(0, finite(rp.distortSlope, 0)),
        Math.max(0, finite(rp.distortChop, 0)),
        Math.max(EPS, finite(rp.distortMax, 0.05)),
      );
      // fadeEnd is a smoothstep edge against fadeStart — equal edges are a
      // 0-divisor inside smoothstep (§V28), so keep them a metre apart.
      const fadeStart = Math.max(1, finite(rp.fadeStart, 350));
      (uFade.value as THREE.Vector2).set(
        fadeStart,
        Math.max(fadeStart + 1, finite(rp.fadeEnd, 1400)),
      );
      (uBlur.value as THREE.Vector3).set(
        Math.max(0, finite(rp.blurNear, 0)),
        Math.max(0, finite(rp.blurFar, 0)),
        Math.max(0, finite(rp.blurChop, 0)),
      );
      uBlurMax.value = Math.max(0, finite(rp.blurMax, 4));
    },
    setActive(active: boolean): void {
      uActive.value = active ? 1 : 0;
    },
  };
}
