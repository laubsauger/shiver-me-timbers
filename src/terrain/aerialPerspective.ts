/**
 * Aerial perspective on island terrain (§V43, §V30, T39) — TSL only.
 *
 * THE DEFECT. `scene.fog` is linear `skyParams.fogNear` 1800 → `fogFar` 4900,
 * but the OCEAN stopped using scene fog long ago: `surfaceMaterial` sets
 * `material.fog = false` and runs its own ramp
 * `pow(smoothstep(900, 4600, d), 1.7)` (§V30, so the disc rim lands exactly on
 * the sky). The islands were left on scene fog, so land and sea melted on two
 * different curves.
 *
 * MEASURED, because the first telling of this was overstated and the numbers
 * matter. The two curves happen to agree closely in the near field (at 1170 m
 * both are ~0%, so the nearest island was NOT a saturated cut-out on hazed
 * water) and diverge hard past the mid-field, where a coastline shows the
 * step directly:
 *
 *     distance   water        land was     seam
 *      2000 m     7.2%          6.5%       0.7 pp
 *      3000 m    42.0%         38.7%       3.3 pp
 *      3500 m    66.6%         54.8%      11.8 pp
 *      4000 m    88.3%         71.0%      17.4 pp
 *
 * i.e. exactly the 2-4 km horizon band the wide shots are framed on, and the
 * band where the island is nothing BUT its silhouette. Sharing the curve takes
 * every one of those to 0.0 pp by construction.
 *
 * WHAT THIS DOES NOT DO, so nobody looks for it: it does not add near-field
 * atmosphere. The user's "we're needing some sort of fog… just a little bit,
 * to give it more of a feeling of atmosphere" is a separate change, and the
 * knob for it is `hazeCurve`, NOT `hazeStart` — the ^1.7 exponent is what
 * crushes the near field, and pulling `hazeStart` 900→250 still leaves the
 * nearest island at 3%. Measured: hazeCurve 1.7→1.3 takes the five islands
 * from 0/1/11/23/49% to 0/3/19/32/58%. That knob now moves the SEA as well,
 * which is the point and also the reason it is not touched here — the water
 * washing out at distance is a live complaint of its own.
 *
 * WHY THIS READS THE OCEAN'S PARAMS RATHER THAN COPYING ITS NUMBERS. At the
 * SHORELINE an island fragment and a water fragment are at the same distance,
 * so if the two curves differ at all there is a visible discontinuity along
 * every coast — one cut-out traded for a subtler one. Two hand-matched copies
 * of a curve drift the first time either is tuned, which is the same
 * single-owner lesson as §V33/§V51 and as `waterline` being shared between the
 * swash and the wet band inside this very material. So the curve has ONE
 * owner, `params/oceanSurface.ts`, and moving `hazeStart`/`hazeEnd`/
 * `hazeCurve` moves the sea and the land together — which is exactly the knob
 * the "a little bit of atmosphere" request wants.
 *
 * DISTANCE IS MEASURED ON XZ, NOT IN 3D, for the same reason: the ocean uses
 * `worldXZ − cameraPosition.xz`. A 100 m peak is only 4 m further away in 3D
 * than its own beach, but matching the measure makes island and sea agree at
 * the waterline BY CONSTRUCTION rather than to within a rounding error.
 *
 * WHERE IT IS APPLIED. Not in `colorNode` — that is albedo, and multiplying
 * haze into albedo would let a shadowed cliff darken the atmosphere in front
 * of it. The terrain is a lit `MeshStandardNodeMaterial`, so the haze has to
 * land on the LIT result. three's own fog does this through the shared
 * `output` property node (see three/src/nodes/fog/Fog.js), and
 * `NodeMaterial.outputNode` is evaluated after `output.assign(resultNode)` —
 * so an `outputNode` that reads `output` is a genuine post-lighting hook. The
 * material must then set `fog = false` or scene fog composites on top and the
 * island hazes twice.
 *
 * §V23: functional `mix`/`smoothstep` only. Note three's own `fog()` helper
 * uses `factor.mix(a, b)` — receiver-as-FACTOR, the exact §B.1 shape — which
 * is why this does not reuse it.
 * §V57: pure expression tree, no `assign`/`toVar`, so it is stage-agnostic and
 * safe to build outside an `Fn()` body.
 */
import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  mix,
  output,
  positionWorld,
  pow,
  smoothstep,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import { oceanSurfaceParams } from '../params/oceanSurface';

/**
 * Live uniforms for the haze. The RANGE mirrors the ocean's params (single
 * owner, see the header); the COLOUR is pushed per frame by the caller from
 * `scene.fog.color`, which the sky rig retints every frame and which the ocean
 * already copies for exactly this purpose.
 */
export function createAerialUniforms() {
  const p = oceanSurfaceParams;
  return {
    /** haze target colour — the same source the water melts into */
    color: uniform(new THREE.Color(0x9cc8de)),
    /** x = start radius (m), y = end radius (m) */
    range: uniform(new THREE.Vector2(p.hazeStart, p.hazeEnd)),
    curve: uniform(p.hazeCurve),
    strength: uniform(p.hazeStrength),
  };
}

export type AerialUniforms = ReturnType<typeof createAerialUniforms>;

/** Re-read the ocean's haze curve (call from updateFromParams). */
export function updateAerialUniforms(u: AerialUniforms): void {
  const p = oceanSurfaceParams;
  (u.range.value as THREE.Vector2).set(p.hazeStart, p.hazeEnd);
  u.curve.value = p.hazeCurve;
  u.strength.value = p.hazeStrength;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyNode = any;

/**
 * 0..1 how far this fragment has melted into the atmosphere. Exported
 * separately from the output node so tests and any future receiver (rocks,
 * palms) can read the same ramp rather than writing a second one.
 */
export function aerialHazeFactor(u: AerialUniforms): AnyNode {
  // XZ distance — see the header for why not 3D
  const camDist = positionWorld.xz.sub(cameraPosition.xz).length();
  return pow(smoothstep(u.range.x, u.range.y, camDist), u.curve)
    .clamp(0, 1)
    .mul(u.strength)
    .clamp(0, 1);
}

/**
 * The post-lighting output node. Assign to `material.outputNode` AND set
 * `material.fog = false` — both, or the island hazes twice.
 */
export function aerialOutputNode(u: AerialUniforms): AnyNode {
  const hazeT = aerialHazeFactor(u);
  // §V23 functional form. `output` is the lit result three assigns before it
  // evaluates outputNode; alpha is carried through untouched.
  return vec4(mix(output.rgb, vec3(u.color), hazeT), output.a);
}

/**
 * CPU mirror of {@link aerialHazeFactor} — the transliteration-pair convention
 * used by bandLimit.ts and shoreRunup.ts, because a TSL graph cannot be
 * evaluated headless and "the island hazes like the water" is precisely the
 * property that must not silently drift.
 */
export function aerialHazeFactorCpu(
  distance: number,
  start: number,
  end: number,
  curve: number,
  strength: number,
): number {
  const t = Math.min(Math.max((distance - start) / Math.max(end - start, 1e-6), 0), 1);
  const hermite = t * t * (3 - 2 * t);
  return Math.min(Math.max(Math.pow(hermite, curve), 0), 1) * strength;
}
