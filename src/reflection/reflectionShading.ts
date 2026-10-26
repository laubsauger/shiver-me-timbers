/**
 * TSL side of the planar reflection (§V26, §V20): turns the mirror pass's
 * render target into the colour the ocean material puts in its reflection
 * slot, and degrades gracefully back to the analytic sky.
 *
 * DESIGN RULE (§V20): this node replaces the CONTENT of the ocean's reflected
 * colour, never its WEIGHT. The ocean keeps owning `fresnel × reflectionStrength`
 * and its transmission cap, so this module changes the reflected content
 * without changing the interface weighting. The Fresnel weighting is in place
 * at the call site; what is added here is the break-up and the distance
 * dissolve that stop a flat RT from reading as a glass sheet.
 *
 * §V23 REMINDER: all 3-arg math below is the FUNCTIONAL form — mix(a,b,t),
 * smoothstep(e0,e1,x). The two smoothsteps with e0 > e1 carry their reading
 * in a comment at the use site (§B.1/§B.2 both cost a session).
 */
import * as THREE from 'three/webgpu';
import {
  cameraPosition, cameraViewMatrix, color, float, fwidth, getViewPosition, log2, mix, normalize, reflect, screenSize,
  screenUV, select, smoothstep, uniform, vec2, vec3, vec4,
} from 'three/tsl';
import { reflectionParams as rp } from '../params/reflection';
import { LOCAL_MIRROR_SEED_M, MIRROR_WATERLINE_BAND_M, MIRROR_WATERLINE_BAND_MAX_M } from './mirrorMath';

/**
 * TSL nodes only line up structurally at runtime; the codebase types local
 * shader helpers loosely rather than threading generics (same convention as
 * ocean/foam/flowfoam).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TslNode = any;

/** Wave-reflected ray offset in the horizontally mirrored reflection UV. */
export function reflectionDistortionNode(
  normalWorld: THREE.Node<'vec3'>,
  viewDirection: THREE.Node<'vec3'>,
  viewMatrix: TslNode,
  viewport: TslNode,
  strength: TslNode,
): TslNode {
  const bent = reflect(viewDirection.negate(), normalWorld);
  // Mirror the reflected ray back into the source camera's frame, then
  // subtract the flat-water ray (-viewDirection). Half the ray deflection
  // preserves the slope-strength calibration at small, near-normal tilts.
  const rayDelta = vec3(bent.x, bent.y.negate(), bent.z).add(viewDirection).mul(0.5);
  const tilt = viewMatrix.mul(vec4(rayDelta, 0));
  // The virtual camera reverses screen right. Texture UV also points down,
  // so both view-plane components are negated. Strength is viewport-height
  // based; aspect correction keeps the displacement equal in screen pixels.
  return vec2(tilt.x.negate().mul(viewport.y.div(viewport.x)), tilt.y.negate()).mul(strength);
}

export interface ReflectionShadeInput {
  /**
   * The ocean's own analytic sky reflection colour. It is the fallback when
   * the mirror pass is off, the far field past `fadeEnd`, and the thing the
   * RT sample dissolves into — so the seam is never visible.
   */
  skyColor: TslNode;
  /** world-space shading normal of the water surface (unit) */
  normalWorld: TslNode;
  /** unit direction from the water surface toward the main camera */
  viewDirection: TslNode;
  /** horizontal displacement magnitude in metres — the choppiness/steepness */
  chop: TslNode;
  /** distance from the eye to the shaded point, metres */
  camDist: TslNode;
  /**
   * World position of the DRAWN (displaced) water surface at this fragment. B125: mirror texels whose geometry lies
   * below its height are under this water and are dropped (mirrorMath.aboveSurfaceKeep).
   */
  surfacePosition: TslNode;
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
/** the mirror target's cleared depth: at or past this the pass drew nothing there */
const EMPTY_DEPTH = 0.999999;
const finite = (v: number, fallback: number): number =>
  Number.isFinite(v) ? v : fallback;

/**
 * What the shading needs from the mirror pass to rebuild the world point behind a texel (B125): the pass's depth and
 * the virtual camera that drew it (matrices refreshed by planarReflection after every mirror render, bound by
 * reference).
 */
export interface MirrorPassGeometry {
  depthNode: TslNode;
  projectionInverse: THREE.Matrix4;
  world: THREE.Matrix4;
  /** projection × world-inverse of the same virtual camera: a world point → its texel in the pass */
  viewProjection: THREE.Matrix4;
  /** world height of the pass's mirror (and oblique clip) plane */
  planeY: number;
}

export function createReflectionShading(
  reflectionNode: TslNode,
  useMipmaps: boolean,
  pass: MirrorPassGeometry,
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
  const uMirrorProjInv = uniform(pass.projectionInverse);
  const uMirrorWorld = uniform(pass.world);
  const uSurfaceClip = uniform(rp.surfaceClip);
  const uMirrorViewProj = uniform(pass.viewProjection);
  const uLocalMirror = uniform(rp.localMirror);
  /** the pass's depth at a texel, and the real world point it drew there */
  const passPoint = (at: TslNode): { depth: TslNode; point: TslNode } => {
    const q = at.clamp(0, 1);
    const depth = pass.depthNode.sample(q).r;
    return { depth, point: uMirrorWorld.mul(vec4(getViewPosition(q, depth, uMirrorProjInv), 1)).xyz };
  };
  /** a world point's texel in the pass (target uv: y down, and the pass's own X flip comes with its matrices) */
  const passUv = (world: TslNode): THREE.Node<'vec2'> => {
    const c = uMirrorViewProj.mul(vec4(world, 1));
    const ndc = c.xy.div(c.w.max(1e-4));
    return vec2(ndc.x.mul(0.5).add(0.5), ndc.y.mul(-0.5).add(0.5));
  };

  const shade = (input: ReflectionShadeInput): TslNode => {
    const { skyColor, normalWorld, viewDirection, chop, camDist, footprint, surfacePosition } = input;

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
    const offset = reflectionDistortionNode(
      normalWorld,
      viewDirection,
      cameraViewMatrix,
      screenSize,
      uDistort.x.add(chop.mul(uDistort.y)),
    ).clamp(uDistort.z.negate(), uDistort.z);
    // flipX is NOT decoration: the virtual camera's basis comes out with its
    // right vector negated (see mirrorMath.mirrorCameraPose), so the render
    // target is horizontally mirrored relative to the screen.
    const planeUv = screenUV.flipX();

    // ── B125 AT SPEED: REFLECT FROM THE WATER THAT IS DRAWN ────────────────
    // The plane texel is the reflection from where the eye ray crosses the REST plane. At a planing hull the drawn sea
    // stands 0.2–0.3 m above it (swell + her mound), so her image began 2η below her contact and the strip between was
    // sky or her submerged slice. The true ray leaves this fragment: surface + r·t. One secant step on the pass's depth
    // finds t (mirrorMath.localMirrorLookup is the tested CPU twin); a lookup that leaves the pass keeps the plane texel.
    // A TROUGH keeps the plane: the pass holds nothing under its clip plane, so a ray from below it would find her dry
    // topside between the trough and the plane missing (a sky strip at rest). Raised water is the defect; lowered water
    // reflects as the plane mirror did.
    const origin = vec3(surfacePosition.x, surfacePosition.y.max(pass.planeY), surfacePosition.z);
    const eyeRay = normalize(origin.sub(cameraPosition));
    const rDir = vec3(eyeRay.x, eyeRay.y.negate(), eyeRay.z);
    const seed = passPoint(planeUv);
    const tSeed = select(
      seed.depth.lessThan(EMPTY_DEPTH), seed.point.sub(origin).dot(rDir).max(0.05), float(LOCAL_MIRROR_SEED_M),
    );
    const hit = passPoint(passUv(origin.add(rDir.mul(tSeed))));
    const tHit = select(hit.depth.lessThan(EMPTY_DEPTH), hit.point.sub(origin).dot(rDir).max(0.05), tSeed);
    const localUv = passUv(origin.add(rDir.mul(tHit)));
    const localInPass = localUv.x.greaterThanEqual(0).and(localUv.x.lessThanEqual(1))
      .and(localUv.y.greaterThanEqual(0)).and(localUv.y.lessThanEqual(1));
    const useLocal = uLocalMirror.mul(localInPass.select(float(1), float(0)));
    const uv = mix(planeUv, localUv, useLocal).add(offset);

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

    // ── B125: NOTHING UNDER THIS WATER IS MIRRORED ─────────────────────────
    // The oblique clip removed what is under the rest PLANE; the drawn sea stands above it at a hull that rides a crest
    // or sits in her own mound, and the slice of hull between plane and surface (her underside) is under water in the
    // frame yet mirrored below her. Rebuild the real world point behind this texel from the pass's own depth and
    // (oblique) projection, and drop it when it lies below this fragment's water: no ray reflected UP from here can see
    // it, so the sky stays. mirrorMath.aboveSurfaceKeep is the tested CPU twin. One depth textureLoad, same texel.
    const behindTexel = passPoint(uv);
    const behindDepth = behindTexel.depth;
    const belowBy = behindTexel.point.y.sub(surfacePosition.y);
    const band = fwidth(belowBy).clamp(MIRROR_WATERLINE_BAND_M, MIRROR_WATERLINE_BAND_MAX_M);
    const keepAbove = smoothstep(band.negate(), band, belowBy);
    // an empty texel (the cleared depth, which the oblique far plane rebuilds to a meaningless point) has nothing to drop
    const aboveSurface = mix(float(1), select(behindDepth.lessThan(EMPTY_DEPTH), keepAbove, float(1)), uSurfaceClip);
    const reflected = sample.rgb.div(coverage.max(EPS)).mul(uTint);

    // Dissolve back into the analytic sky with distance: past `fadeEnd` the
    // half-res RT carries no readable detail anyway, and the ocean's own haze
    // (§V30) takes over from there — so the transition has nothing to hide.
    // smoothstep(e0,e1,x) with e0 > e1 reads "1 below fadeStart, 0 above
    // fadeEnd" (§V23 — functional form, receiver-free).
    const nearFade = smoothstep(uFade.y, uFade.x, camDist);
    const weight = uActive.mul(uStrength).mul(nearFade).mul(coverage).mul(aboveSurface).clamp(0, 1);
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
      uSurfaceClip.value = THREE.MathUtils.clamp(finite(rp.surfaceClip, 1), 0, 1);
      uLocalMirror.value = THREE.MathUtils.clamp(finite(rp.localMirror, 1), 0, 1);
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
