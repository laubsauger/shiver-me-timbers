/**
 * Pure CPU mirrors of the flow-foam GPU math (§V10) — ZERO three imports so
 * tests/flowfoam.test.ts runs in node without a GPU (same mirror contract as
 * deckwater/fluxMath.ts and foam/foamMath.ts). GPU twins:
 *   flowVectorCpu          ↔ flowNoise.flowVectorNode
 *   uvForWorld/worldForUv  ↔ accumulation advect pass texel↔world math
 *   regionShiftUv          ↔ uShift uniform consumed by the advect lookup
 *   advectLookupUv         ↔ backward semi-Lagrangian source uv
 * Change one side → change the other. CPU runs f64, GPU f32: structurally
 * identical, not bit-exact; properties (determinism, divergence, anchoring)
 * carry over.
 *
 * REGION UV CONVENTION (single source of truth):
 *   u = (wx − cx) / size + 0.5
 *   v = (cz − wz) / size + 0.5      ← v axis is FLIPPED vs world +z
 * because the injection ortho camera looks down −Y with up = (0, 0, −1)
 * (camera x = world +x, camera y = world −z), so RT v grows toward −z.
 *
 * REGION-SHIFT MATH: when the region recenters prevC → c, the same world
 * point w moves in uv space:
 *   uPrev − uCur = (cx − prevCx) / size
 *   vPrev − vCur = (prevCz − cz) / size   (v flip)
 * The advect pass reads PREVIOUS-frame foam whose texels are anchored at
 * prevC, so the lookup ADDS this shift to the current uv — foam stays pinned
 * to the world while the texture window slides under it. setCenter snaps to
 * whole texels (snapToTexel) so the shift is an exact texel offset and a
 * standing foam patch is never blurred by fractional resampling.
 */
import { fbm2Cpu } from '../terrain/noiseCpu';

/** fbm octave count of the flow potential — build constant (unrolls in TSL) */
export const FLOW_OCTAVES = 2;

/** subset of FlowFoamParams the flow field needs (pure, structural) */
export interface FlowFieldParams {
  noiseScale: number;
  noiseStrength: number;
  noiseScrollSpeed: number;
  baseFlowSpeed: number;
  curlStep: number;
}

/**
 * Scalar flow potential ψ: low-frequency fbm scrolled along the base flow
 * direction over time, so eddies ride downstream with the current.
 */
export function flowPotentialCpu(
  x: number,
  z: number,
  time: number,
  dirX: number,
  dirZ: number,
  p: FlowFieldParams,
): number {
  const nx = (x - dirX * time * p.noiseScrollSpeed) * p.noiseScale;
  const nz = (z - dirZ * time * p.noiseScrollSpeed) * p.noiseScale;
  return fbm2Cpu(nx, nz, FLOW_OCTAVES);
}

/**
 * Pseudo-curl flow vector: two offset ψ samples give forward-difference
 * gradients; rotating the gradient 90° → v = (∂ψ/∂z, −∂ψ/∂x) is a discrete
 * curl, divergence-free by construction for the matching stencil (tests
 * verify) — advected foam swirls instead of piling into sinks or tearing
 * holes. A uniform base flow (dir · baseFlowSpeed) drifts it downstream.
 */
export function flowVectorCpu(
  x: number,
  z: number,
  time: number,
  dirX: number,
  dirZ: number,
  p: FlowFieldParams,
  /** multiplies only the curl/eddy part (GPU feeds local foam-driven churn) */
  curlScale = 1,
): [number, number] {
  const e = p.curlStep;
  const p0 = flowPotentialCpu(x, z, time, dirX, dirZ, p);
  const px = flowPotentialCpu(x + e, z, time, dirX, dirZ, p);
  const pz = flowPotentialCpu(x, z + e, time, dirX, dirZ, p);
  const dpdx = (px - p0) / e;
  const dpdz = (pz - p0) / e;
  const k = p.noiseStrength * curlScale;
  return [
    dpdz * k + dirX * p.baseFlowSpeed,
    -dpdx * k + dirZ * p.baseFlowSpeed,
  ];
}

/** world XZ → region uv (see header convention; v flips world z) */
export function uvForWorld(
  wx: number,
  wz: number,
  cx: number,
  cz: number,
  size: number,
): [number, number] {
  return [(wx - cx) / size + 0.5, (cz - wz) / size + 0.5];
}

/** region uv → world XZ (inverse of uvForWorld) */
export function worldForUv(
  u: number,
  v: number,
  cx: number,
  cz: number,
  size: number,
): [number, number] {
  return [cx + (u - 0.5) * size, cz - (v - 0.5) * size];
}

/** uv offset ADDED to a current-region uv to find the same world point in the previous region (see header math) */
export function regionShiftUv(
  prevCx: number,
  prevCz: number,
  cx: number,
  cz: number,
  size: number,
): [number, number] {
  return [(cx - prevCx) / size, (prevCz - cz) / size];
}

/** snap a center coordinate to the texel grid (size/res) — exact-texel shifts */
export function snapToTexel(c: number, size: number, res: number): number {
  const texel = size / res;
  return Math.round(c / texel) * texel;
}

/**
 * Backward semi-Lagrangian source uv: where the foam now at (u, v) came
 * from = current world position minus flow·dt, plus the region shift.
 * v moves OPPOSITE to world z (uv convention above).
 */
export function advectLookupUv(
  u: number,
  v: number,
  vx: number,
  vz: number,
  advectDt: number,
  size: number,
  shiftU: number,
  shiftV: number,
): [number, number] {
  return [
    u - (vx * advectDt) / size + shiftU,
    v + (vz * advectDt) / size + shiftV,
  ];
}
