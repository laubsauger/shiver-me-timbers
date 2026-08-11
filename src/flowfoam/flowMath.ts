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
): [number, number] {
  const e = p.curlStep;
  const p0 = flowPotentialCpu(x, z, time, dirX, dirZ, p);
  const px = flowPotentialCpu(x + e, z, time, dirX, dirZ, p);
  const pz = flowPotentialCpu(x, z + e, time, dirX, dirZ, p);
  const dpdx = (px - p0) / e;
  const dpdz = (pz - p0) / e;
  return [
    dpdz * p.noiseStrength + dirX * p.baseFlowSpeed,
    -dpdx * p.noiseStrength + dirZ * p.baseFlowSpeed,
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

// ---------------------------------------------------------------------------
// Ship wake injection mirrors (GPU twin: wakeInjection.wakeRateNode)
// ---------------------------------------------------------------------------

/** clamped hermite smoothstep — mirror of the TSL smoothstep used on GPU */
export function smoothstepCpu(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** wake tunables subset of FlowFoamParams (pure, structural) */
export interface WakeParams {
  kelvinAngle: number;
  bowIntensity: number;
  sternIntensity: number;
  speedThreshold: number;
  armWidth: number;
  armWidthGrowth: number;
  sternWidth: number;
  wakeRange: number;
}

/** ship state + geometry offsets (ship-local z, from blueprint AABBs) */
export interface WakeShip {
  x: number;
  z: number;
  /** heading, three.js rotation.y convention: forward = (sin yaw, cos yaw) in XZ */
  yaw: number;
  /** m/s over water */
  speed: number;
  /** bow point distance ahead of ship origin (m, along forward) */
  bowOffset: number;
  /** stern point offset along forward (m, typically negative) */
  sternOffset: number;
  /** hull width (m) */
  beam: number;
}

/** world XZ → ship-local [along (toward bow), across (starboard +)] */
export function shipLocalCpu(
  wx: number,
  wz: number,
  x: number,
  z: number,
  yaw: number,
): [number, number] {
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  const dx = wx - x;
  const dz = wz - z;
  // right = (fz, −fx): forward rotated −90° about +y
  return [dx * fx + dz * fz, dx * fz - dz * fx];
}

/**
 * Lateral distance from a point to the nearest bow-V arm centerline:
 * sAft meters behind the bow the arms sit at ±sAft·tan(kelvin). |across|
 * folds port onto starboard — the V is symmetric by construction.
 */
export function bowArmDistCpu(sAft: number, across: number, kelvinDeg: number): number {
  return Math.abs(Math.abs(across) - sAft * Math.tan((kelvinDeg * Math.PI) / 180));
}

/**
 * Analytic wake injection rate (foam/second) at a world point — bow V arms
 * (∝ speed, width growing aft) + stern turbulence band (∝ speed², width ≈
 * beam, peaked at the centerline = the modest rooster hump). Injection is
 * local (fades over wakeRange); the advected field does the long trailing.
 * Gate feathers in over [speedThreshold, 2·speedThreshold] — exactly 0 at
 * anchor. GPU twin: wakeInjection.ts, keep formulas identical.
 */
export function wakeRateCpu(wx: number, wz: number, ship: WakeShip, p: WakeParams): number {
  const gate = smoothstepCpu(p.speedThreshold, p.speedThreshold * 2, ship.speed);
  if (gate === 0) return 0;
  const [along, across] = shipLocalCpu(wx, wz, ship.x, ship.z, ship.yaw);

  const sBow = ship.bowOffset - along; // distance aft of the bow point
  const behindBow = sBow >= 0 ? 1 : 0;
  const armW = p.armWidth + sBow * p.armWidthGrowth;
  const armMask = 1 - smoothstepCpu(0, armW, bowArmDistCpu(sBow, across, p.kelvinAngle));
  const bowFade = 1 - smoothstepCpu(0, p.wakeRange, sBow);
  const bow = p.bowIntensity * ship.speed * armMask * bowFade * behindBow;

  const sStern = ship.sternOffset - along; // distance aft of the stern
  const behindStern = sStern >= 0 ? 1 : 0;
  const halfW = ship.beam * p.sternWidth * 0.5;
  const sternMask = 1 - smoothstepCpu(0, halfW, Math.abs(across));
  const sternFade = 1 - smoothstepCpu(0, p.wakeRange, sStern);
  const stern = p.sternIntensity * ship.speed * ship.speed * sternMask * sternFade * behindStern;

  return (bow + stern) * gate;
}
