/**
 * FOLIAGE LIGHTING (§T.112e, §V94, research §2 "vegetation that reads alive").
 *
 * THE DEFECT THIS CLOSES. A conifer built from cone tiers and lit by
 * `MeshStandardNodeMaterial`'s default Lambert+GGX is a CONE: one bright side,
 * one dark side, a hard terminator down the middle and nothing at all where
 * the sun is behind it. Real needles are a semi-transparent cloud — light
 * wraps around them, and a backlit canopy is the BRIGHTEST thing in a Sierra
 * evening. Three cheap terms, each closing one of those three tells:
 *
 *  1. CLUSTER NORMALS — a bake, not a shader term (`applyClusterNormals`).
 *     Every foliage vertex is blended from its facet normal toward the normal
 *     of the canopy sphere it belongs to, so a tier lights as part of one soft
 *     mass instead of as a folded card. This is the standard production trick
 *     (Crytek/Guerrilla foliage), and because it depends on nothing but the
 *     mesh it costs zero at runtime and is a pure function tests can read.
 *  2. WRAP DIFFUSE — `saturate((N·L + w)/(1 + w))` instead of `saturate(N·L)`,
 *     pushing the terminator around the far side. Added as the DIFFERENCE
 *     against plain Lambert so the standard lighting model is untouched and
 *     the term is exactly zero everywhere the sun already reaches — nothing
 *     to double-count on the lit side.
 *  3. BACK TRANSMISSION — light through the leaf: only where the sun is
 *     BEHIND the surface (N·L < 0) and only toward the viewer looking into
 *     the sun (V·−L), tightened by a power. This is the rim that makes a
 *     backlit pine read as foliage rather than as a silhouette.
 *
 * WHY 2 AND 3 RIDE ON `emissiveNode`. Replacing the lighting model would mean
 * a custom `LightingModel` subclass on the one material every conifer in the
 * world shares (§V17), for two terms that are additive by construction.
 * Emissive IS the additive channel, in linear space (§V31b), which is what
 * both of these are. The sun's radiance is folded into the strength knobs —
 * they are look tunables in `params/sierra.ts` (§V16), not physical constants.
 *
 * §V.48: nothing here is a spatial field. Every term is a dot product of
 * interpolated vectors — band-limited by the rasteriser by construction, with
 * no `step`/`fract`/period anywhere. See the audit note on `foliageEmissive`.
 *
 * PURE CPU TWINS. `wrapDiffuseGain` and `backTransmission` are the exact
 * arithmetic of the two TSL terms, so tests/sierraVegetation.test.ts can pin
 * the properties (zero on the lit side, monotone, peaks looking into the sun)
 * without a renderer (§V88).
 */
import * as THREE from 'three/webgpu';
import { cameraPosition, normalWorld, positionWorld, uniform } from 'three/tsl';
import { sierraParams, type SierraParams } from '../params/sierra';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyNode = any;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// ── 1. the cluster-normal bake ────────────────────────────────────────────

/**
 * Blend each vertex normal toward the canopy-sphere normal
 * `normalize(position − centre)`, by `blend × clusterWeight`.
 *
 * Written back into the geometry's own `normal` attribute — the geometry
 * leaves the builder already lit as foliage. `centers` is 3 floats per vertex
 * and `clusterWeight` 1 (0 on wood, 1 on leaf). A vertex sitting exactly on
 * its own centre has no direction to blend toward and keeps its facet normal
 * (the divisor is floored, §V28 — a normalize of a zero vector is a NaN that
 * would black out the whole instance).
 */
export function applyClusterNormals(
  geometry: THREE.BufferGeometry,
  centers: Float32Array,
  clusterWeight: Float32Array,
  blend: number,
): void {
  const k = clamp01(blend);
  if (k <= 0) return;
  const attr = geometry.getAttribute('normal');
  const pos = geometry.getAttribute('position');
  if (!attr || !pos) return;
  const n = attr.array as Float32Array;
  const p = pos.array as Float32Array;
  for (let i = 0; i < clusterWeight.length; i++) {
    const w = k * clamp01(clusterWeight[i]);
    if (w <= 0) continue;
    const dx = p[i * 3] - centers[i * 3];
    const dy = p[i * 3 + 1] - centers[i * 3 + 1];
    const dz = p[i * 3 + 2] - centers[i * 3 + 2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) continue;
    const bx = n[i * 3] + (dx / len - n[i * 3]) * w;
    const by = n[i * 3 + 1] + (dy / len - n[i * 3 + 1]) * w;
    const bz = n[i * 3 + 2] + (dz / len - n[i * 3 + 2]) * w;
    const bl = Math.max(Math.hypot(bx, by, bz), 1e-6); // §V28
    n[i * 3] = bx / bl;
    n[i * 3 + 1] = by / bl;
    n[i * 3 + 2] = bz / bl;
  }
  attr.needsUpdate = true;
}

// ── 2 + 3. CPU twins of the two shader terms ──────────────────────────────

/**
 * Extra diffuse the wrap adds over plain Lambert, 0..1 before `strength`.
 * Exactly `saturate((N·L + w)/(1 + w)) − saturate(N·L)`: zero on the fully lit
 * side (both saturate to the same value), positive across the terminator and
 * on the shaded side, and it goes to 0 again at N·L = −1 with wrap < 1.
 */
export function wrapDiffuseGain(nDotL: number, wrap: number, strength: number): number {
  const w = Math.max(wrap, 0);
  const wrapped = clamp01((nDotL + w) / (1 + w));
  return (wrapped - clamp01(nDotL)) * strength;
}

/**
 * Back transmission, 0..1 before `strength`: only where the sun is behind the
 * surface, and only into the cone of view directions pointing at the sun.
 * @param nDotL  surface normal · direction TO the sun
 * @param vDotL  direction from surface TO CAMERA · direction to the sun
 *               (looking into the sun is vDotL ≈ −1, so the term uses −vDotL)
 */
export function backTransmission(nDotL: number, vDotL: number, power: number): number {
  return clamp01(-nDotL) * Math.pow(clamp01(-vDotL), Math.max(power, 1e-3));
}

// ── the TSL side ──────────────────────────────────────────────────────────

export function createFoliageLightUniforms(p: SierraParams = sierraParams) {
  return {
    sunDirection: uniform(new THREE.Vector3(0.4, 0.75, 0.3).normalize()),
    wrap: uniform(p.foliageWrap),
    wrapStrength: uniform(p.foliageWrapStrength),
    transmission: uniform(p.foliageTransmission),
    transmissionPower: uniform(p.foliageTransmissionPower),
    transmissionColor: uniform(new THREE.Color(p.foliageTransmissionColor)),
  };
}

export type FoliageLightUniforms = ReturnType<typeof createFoliageLightUniforms>;

export function updateFoliageLightUniforms(u: FoliageLightUniforms, p: SierraParams = sierraParams): void {
  u.wrap.value = p.foliageWrap;
  u.wrapStrength.value = p.foliageWrapStrength;
  u.transmission.value = p.foliageTransmission;
  u.transmissionPower.value = p.foliageTransmissionPower;
  u.transmissionColor.value.set(p.foliageTransmissionColor);
}

/**
 * The additive foliage term for `material.emissiveNode`, masked to the leaf
 * roles by the caller. `leafAlbedo` carries the wrap (wrapped light is the
 * leaf's own colour); the transmission carries its own warm tint, because
 * light that came THROUGH a needle is not the colour that bounced off it.
 *
 * @band-limited-elsewhere §V.48: no spatial field — every term here is a dot
 * product of rasteriser-interpolated vectors, and there is no step/fract/
 * period to alias. `.clamp()` and `.pow()` are pointwise, not edges.
 */
export function foliageEmissive(u: FoliageLightUniforms, leafAlbedo: AnyNode, leafMask: AnyNode): AnyNode {
  const nDotL = normalWorld.dot(u.sunDirection);
  // wrap gain = saturate((N·L + w)/(1+w)) − saturate(N·L), the DIFFERENCE, so
  // the standard diffuse underneath keeps the lit side to itself
  const wrapped = nDotL.add(u.wrap).div(u.wrap.add(1)).clamp(0, 1);
  const gain = wrapped.sub(nDotL.clamp(0, 1)).mul(u.wrapStrength);
  // view direction: surface → camera, world space (the sun uniform is world)
  const toCamera = cameraPosition.sub(positionWorld).normalize();
  const trans = nDotL
    .negate()
    .clamp(0, 1)
    .mul(toCamera.dot(u.sunDirection).negate().clamp(0, 1).pow(u.transmissionPower))
    .mul(u.transmission);
  return leafAlbedo.mul(gain).add(u.transmissionColor.mul(trans)).mul(leafMask);
}
