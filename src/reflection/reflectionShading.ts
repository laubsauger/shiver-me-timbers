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
import { color, log2, mix, screenUV, smoothstep, uniform, vec2 } from 'three/tsl';
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
  /**
   * World metres covered by ONE PIXEL of this surface — the caller's own
   * `fwidth(worldXZ)`. Not derivable from `camDist`: at a grazing view the
   * footprint stretches by 1/sin(grazing) and runs to tens of metres, which is
   * exactly the framing where the mirror reads wrong.
   */
  footprint: TslNode;
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
  /** extra mip level per unit of surface tilt — the microfacet blur */
  const uBlurSlope = uniform(rp.blurSlope);
  /** (footprint ref metres, mips per octave) — the sub-pixel roughness floor */
  const uFootprint = uniform(
    new THREE.Vector2(rp.blurFootprintRef, rp.blurFootprintGain),
  );

  const shade = (input: ReflectionShadeInput): TslNode => {
    const { skyColor, normalWorld, chop, camDist, footprint } = input;

    // Break-up: push the lookup around by the wave's own slope plus its
    // horizontal (choppy) displacement, so the mirrored scene shears on chop
    // instead of sitting there as one rigid sheet (§V26 "blur ok").
    // The tap stays inside `distortMax` of its origin — an unbounded offset
    // is a fill-rate/cache trap and can pull in unrelated screen regions.
    const slope = vec2(normalWorld.x, normalWorld.z);
    // how far this facet is tilted off vertical: sin(tilt) for a unit normal.
    // THE roughness signal — a UV warp is a smooth map, so on its own it can
    // only wobble a reflected shape, never break it up; the blur below is what
    // actually models the microfacet spread (see the lod block).
    const tilt = slope.length();
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
      // ROUGHNESS, not just distance. Real water blurs a reflection in
      // proportion to the spread of its microfacet normals AND to how far the
      // reflected thing is, because the reflected-ray cone widens along its
      // length. A mirror tap with a small UV offset models neither, which is
      // the "reflections are too perfect, too clean" report: a planar mirror
      // on a visibly choppy sea. `tilt` is the per-pixel facet slope, so a
      // steep wave face smears its reflection while a glassy trough keeps it.
      // ── SUB-PIXEL ROUGHNESS FLOOR (§V.26, user: "stuff in the distance
      // shouldn't get perfectly mirror-like reflected… without simulating the
      // foam and crusty stuff to infinite length") ─────────────────────────
      // The three terms above all read RESOLVED surface state, and distance is
      // precisely where that state has been averaged away: the ocean's own
      // §V.48 gates fade each cascade's normal to zero once a pixel spans more
      // than one of its texels, so `tilt` — the term that is supposed to smear
      // a rough sea's reflection — goes to ZERO exactly where the sea is
      // roughest per pixel. The reflection then sharpens with distance, which
      // is backwards, and reads as a mirror.
      //
      // The statistical stand-in is the standard one: sub-pixel geometry is
      // ROUGHNESS, not geometry. A pixel covering W metres of water contains
      // every wave component shorter than ~2W, and each DOUBLING of W buries
      // one more octave of wave slope — which is one more mip of blur, exactly
      // the quantity a mip level already measures. Hence log2, not a linear
      // ramp: the law is dimensionally the mip chain's own.
      //
      // It is a FLOOR (`max`), never an addend: a near-field steep face may
      // legitimately blur MORE than its footprint demands, but nothing may
      // blur less. Below `blurFootprintRef` — a pixel finer than the sharpest
      // wave detail the cascades carry — it is exactly 0 and the near field is
      // untouched.
      const lodFloor = log2(footprint.div(uFootprint.x.max(1e-3)).max(1)).mul(
        uFootprint.y,
      );
      const lod = mix(uBlur.x, uBlur.y, distT)
        .add(chop.mul(uBlur.z))
        .add(tilt.mul(uBlurSlope))
        .max(lodFloor)
        .clamp(0, uBlurMax);
      sample = sample.level(lod);
    }
    // COVERAGE (§V26 + §T.39). The mirror pass renders the SCENE ONLY — the
    // sky background is removed for the duration of the pass (see
    // planarReflection.ts) and the target is cleared to alpha 0. So alpha is
    // "did the mirror actually see geometry here", and everywhere it did not,
    // the reflected colour stays the analytic sky the ocean handed us — which
    // is `skyDomeColor(reflectionRay)`, the sky's own dome function with the
    // sun disc EXCLUDED.
    //
    // WHY: with the sky in the mirror, the water showed a geometrically
    // correct mirror image of the sky's HDR sun disc — a clean circular blob
    // on a choppy sea (user screenshot). A real sun on waves is not a disc at
    // all, it is the broken glitter path that the ocean's own specular and
    // glint road already produce; the mirror was competing with it. Dropping
    // the sky from the pass also makes the pass cheaper, and loses nothing:
    // the analytic dome is the same sky, evaluated per pixel, for free.
    //
    // The RT holds PREMULTIPLIED colour (geometry blended over a transparent
    // clear), so un-premultiply before use or every partially covered texel —
    // and every texel of every blurred mip near a silhouette — reads as a
    // dark fringe. Floored divisor per §V28.
    const coverage = sample.a.clamp(0, 1);
    const reflected = sample.rgb.div(coverage.max(EPS)).mul(uTint);

    // Dissolve back into the analytic sky with distance: past `fadeEnd` the
    // half-res RT carries no readable detail anyway, and the ocean's own haze
    // (§V30) takes over from there — so the transition has nothing to hide.
    // smoothstep(e0,e1,x) with e0 > e1 reads "1 below fadeStart, 0 above
    // fadeEnd" (§V23 — functional form, receiver-free).
    const nearFade = smoothstep(uFade.y, uFade.x, camDist);
    const weight = uActive.mul(uStrength).mul(nearFade).mul(coverage).clamp(0, 1);
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
      uBlurSlope.value = Math.max(0, finite(rp.blurSlope, 0));
      (uFootprint.value as THREE.Vector2).set(
        Math.max(1e-3, finite(rp.blurFootprintRef, 0.12)),
        Math.max(0, finite(rp.blurFootprintGain, 1)),
      );
    },
    setActive(active: boolean): void {
      uActive.value = active ? 1 : 0;
    },
  };
}
