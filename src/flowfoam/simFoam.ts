/**
 * FOAM AND SLICK FROM THE SIM WAKE (§T.171 W5, docs/wake/w5-foam.md,
 * wake-research.md §5.4). With `wakeBackend: 'sim'` the white trail and the
 * glassy lane are injected from the SAME solver field the ocean is displaced
 * by, so the paint can no longer disagree with the shape. The analytic Kelvin
 * doses are not evaluated on that backend at all (the pirate page keeps them
 * until W6, §T.172).
 *
 * Per texel, ONE expression (§V77 — `simFoamRate`, instantiated for numbers
 * by `simFoamRateCpu` and for TSL nodes by `createSimFoamField`):
 *
 *   BREAKING   B = smoothstep(0.30, 0.44, |∇η_vis|)
 *              0.44 is the Stokes limiting steepness (H/λ ≈ 1/7 ⇒ ka ≈ 0.44);
 *              0.30 is the onset the research doc gives. For a deep-water
 *              mode the vertical acceleration is g·k·a, so |∇η| = ka IS the
 *              downward-acceleration criterion a > αg with α = ka — one
 *              criterion, not two. Physics, not look knobs: constants here.
 *   CHURN      the rate the hull displaces water at a FIXED world point,
 *              ∂h_P/∂t = −u·∇h_P for a footprint translating at u (the
 *              splatted pressure head, i.e. the hull's immersion field):
 *                bury   = max(0, −u·∇h_P)   the bow driving into water
 *                emerge = max(0,  u·∇h_P)   the transom leaving it (separation)
 *              scaled by Bernoulli `liftFraction(U, D)` (shared with bow
 *              spray: the share of a D-deep column the stagnation head can
 *              lift to the surface) and normalised by D, so the dose one pass
 *              lays is ∝ lift — scale-free across a raft and a galleon (§V66).
 *   FOAM  (R)  breakRate·B + churnRate·lift·(bury + sternChurn·emerge)/D
 *   SLICK (G)  slickPerFoam·FOAM — the turbulence proxy: the lane is laid
 *              exactly where whitewater was generated, and outlives it by the
 *              slick half-life. A hull at rest makes neither (u = 0 ⇒ churn 0;
 *              static cancellation ⇒ |∇η| ≈ 0 ⇒ B = 0 — §V102 analogue).
 *
 * WHAT IT DOES NOT SEE (stated): vertical relative motion (heave/pitch in a
 * swell, the §T.70 "lapping" churn) — the tick knows `hullContact.rate` but
 * the flowfoam frame is only given the pose through `setShip`; the V10
 * waterline capture still sheds foam at zero speed. A single hero velocity
 * (W4: per-vessel velocity needs a splat channel). Ambient sea slope in the
 * breaking test (wake component only — ambient whitecaps are the foam sim's).
 *
 * §V28: every uniform is finite-guarded on the CPU; the solver clamps its
 * slope (±1) and head is a splat of finite samples; D is floored. §V40: the
 * solver textures are read in COMPUTE by `textureLoad` — no material binding.
 * §V48: the breaking gate is a smoothstep in VALUE space on a spectral slope
 * that is band-limited at the solver's own Nyquist; nothing here is a spatial
 * edge in a fragment stage. Per-texel noise: none (§B4).
 */
import { float, int, ivec2, select, smoothstep, textureLoad, uniform, vec2, vec4 } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { LIFT_DEPTH_FLOOR, liftFraction } from '../foam/sprayMath';
import { WAKE_TEX_CHANNEL } from '../wake/wakeSolverMath';
import type { WakeSim } from '../wake/wakeSim';
import type { FlowFoamParams } from '../params/flowfoam';

/** research §5.4: breaking onset slope */
export const BREAK_ONSET_SLOPE = 0.3;
/** Stokes limiting steepness ka ≈ 0.44 (H/λ ≈ 1/7) — full breaking */
export const STOKES_SLOPE = 0.44;

/** the arithmetic `simFoamRate` is written against — numbers or TSL nodes */
export interface SimFoamArith<T> {
  k(v: number): T;
  add(a: T, b: T): T;
  mul(a: T, b: T): T;
  div(a: T, b: T): T;
  max(a: T, b: T): T;
  neg(a: T): T;
  // @band-limited-elsewhere: a TYPE SIGNATURE, not a shader edge — the one use is justified at simFoamRate
  smoothstep(e0: T, e1: T, x: T): T;
}

export interface SimFoamInputs<T> {
  /** |∇η_vis| of the sim surface (dimensionless) */
  slope: T;
  /** u·∇h_P: hull velocity (m/s) dotted with the pressure-head gradient — −∂h_P/∂t */
  headAdvect: T;
  /** liftFraction(U, D) — computed once per frame by the CPU function */
  lift: T;
  /** D: deepest source depth this tick (m), the column the lift is measured against */
  depth: T;
}

export type SimFoamParams = Pick<FlowFoamParams, 'simBreakRate' | 'simChurnRate' | 'simSternChurn' | 'simSlickPerFoam'>;

/** THE expression (header). Returns [foam rate, slick rate] per second. */
export function simFoamRate<T>(A: SimFoamArith<T>, i: SimFoamInputs<T>, p: { [K in keyof SimFoamParams]: T }): [T, T] {
  // §V23 functional smoothstep(e0, e1, x), e0 < e1.
  // @band-limited-elsewhere: the edge is in STEEPNESS (dimensionless |∇η|), not a spatial coordinate; |∇η| is the solver's spectral slope, band-limited at its own Nyquist (λ ≥ 2 texels), evaluated in COMPUTE and accumulated into the foam texture the material band-limits (foamSampleNode)
  const breaking = A.smoothstep(A.k(BREAK_ONSET_SLOPE), A.k(STOKES_SLOPE), i.slope);
  const bury = A.max(A.k(0), A.neg(i.headAdvect));
  const emerge = A.max(A.k(0), i.headAdvect);
  const churn = A.div(A.mul(i.lift, A.add(bury, A.mul(p.simSternChurn, emerge))), A.max(i.depth, A.k(LIFT_DEPTH_FLOOR)));
  const foam = A.add(A.mul(p.simBreakRate, breaking), A.mul(p.simChurnRate, churn));
  return [foam, A.mul(p.simSlickPerFoam, foam)];
}

const NUM: SimFoamArith<number> = {
  k: (v) => v,
  add: (a, b) => a + b,
  mul: (a, b) => a * b,
  div: (a, b) => a / b,
  max: (a, b) => Math.max(a, b),
  neg: (a) => -a,
  smoothstep: (e0, e1, x) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  },
};

/** CPU instance (gameplay/audio/tests). §V28: a non-finite input injects nothing. */
export function simFoamRateCpu(i: SimFoamInputs<number>, p: SimFoamParams): [number, number] {
  if (![i.slope, i.headAdvect, i.lift, i.depth].every(Number.isFinite)) return [0, 0];
  return simFoamRate(NUM, i, p);
}

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL nodes are structurally untyped */
const NODE: SimFoamArith<any> = {
  k: (v) => float(v),
  add: (a, b) => a.add(b),
  mul: (a, b) => a.mul(b),
  div: (a, b) => a.div(b),
  max: (a, b) => a.max(b),
  neg: (a) => a.negate(),
  // @band-limited-elsewhere: a VALUE-space gate on the solver's spectral slope, evaluated in COMPUTE
  smoothstep: (e0, e1, x) => smoothstep(e0, e1, x),
};

const SLOPE_SWIZZLE = ['x', 'y', 'z', 'w'] as const;

/**
 * The prop-wash hook for the speedboat (research §3.4) — DESIGNED, NOT WIRED
 * (W4/W5b). A vessel will hand one of these per tick; the planned injection is
 * foam ∝ (V_j − U)·lift along a jet ribbon of the disc's width aft of `x,z`,
 * with V_j = √(U² + 2T/(ρ·A_disc)) (actuator disc), plus slick at the same
 * ratio. It needs a per-vessel channel the single-hero uniforms below do not
 * have, which is why it is not built on them.
 */
export interface PropWashInput {
  /** prop position, world (m) */
  x: number;
  z: number;
  /** unit jet direction, world XZ (aft along the shaft) */
  dirX: number;
  dirZ: number;
  /** thrust (N, ≥ 0) */
  thrust: number;
  /** prop disc area (m²) */
  discArea: number;
  /** false when the prop is out of the water (no wash, rooster tail instead) */
  immersed: boolean;
}

/**
 * The GPU half: a node builder both flowfoam tiers call per texel, plus the
 * once-per-frame CPU state it reads. `setHull` records the hero's heading and
 * speed (the `setShip` feed); `update` pushes them after the sim step.
 */
export function createSimFoamField(
  sim: WakeSim,
  p: FlowFoamParams,
  /** the SURFACE resample's centre uniform (`createSimWakeField().uSimCenter`) — one centre, so paint and shape cannot drift apart */
  uCenter: { value: THREE.Vector2 },
) {
  const { solver } = sim;
  const n = solver.n;
  const texel = solver.texel;
  const edge = Math.max(1, solver.sponge.width * n);
  const uHullVel = uniform(new THREE.Vector2(0, 0));
  const uLift = uniform(0);
  const uDepth = uniform(LIFT_DEPTH_FLOOR);
  const uBreakRate = uniform(p.simBreakRate);
  const uChurnRate = uniform(p.simChurnRate);
  const uSternChurn = uniform(p.simSternChurn);
  const uSlickPerFoam = uniform(p.simSlickPerFoam);
  let yaw = 0;
  let speed = 0;

  const loadZero = (tex: THREE.Texture, xi: any, yi: any): any => {
    const inside = xi.greaterThanEqual(int(0)).and(xi.lessThan(int(n))).and(yi.greaterThanEqual(int(0))).and(yi.lessThan(int(n)));
    return select(inside, textureLoad(tex, ivec2(xi.clamp(0, n - 1), yi.clamp(0, n - 1))), vec4(0, 0, 0, 0));
  };

  /** vec2(foam rate, slick rate) at a world-XZ node */
  const rateNode = (worldXZ: any): any => {
    // texel centres at integers, row j = world z (WakeSolverCpu.gridU/gridV)
    const g = worldXZ.sub(uCenter).div(texel).add(n / 2);
    const x0 = int(g.x.floor());
    const y0 = int(g.y.floor());
    // @band-limited-elsewhere: bilinear tap weights in a COMPUTE pass (no pixel footprint)
    const fx = g.x.fract();
    // @band-limited-elsewhere: as above
    const fy = g.y.fract();
    const s00 = loadZero(solver.slopeTexture, x0, y0);
    const s10 = loadZero(solver.slopeTexture, x0.add(1), y0);
    const s01 = loadZero(solver.slopeTexture, x0, y0.add(1));
    const s11 = loadZero(solver.slopeTexture, x0.add(1), y0.add(1));
    const slopeV = s00.mul(fx.oneMinus()).add(s10.mul(fx)).mul(fy.oneMinus()).add(s01.mul(fx.oneMinus()).add(s11.mul(fx)).mul(fy));
    const sdx = slopeV[SLOPE_SWIZZLE[WAKE_TEX_CHANNEL.SLOPE_DX]];
    const sdz = slopeV[SLOPE_SWIZZLE[WAKE_TEX_CHANNEL.SLOPE_DZ]];
    const head = solver.headTarget.texture;
    const h00 = loadZero(head, x0, y0).x;
    const h10 = loadZero(head, x0.add(1), y0).x;
    const h01 = loadZero(head, x0, y0.add(1)).x;
    const h11 = loadZero(head, x0.add(1), y0.add(1)).x;
    // ∇h_P of the bilinear head (↔ simHeadGradientCpu)
    const dhdx = h10.sub(h00).mul(fy.oneMinus()).add(h11.sub(h01).mul(fy)).div(texel);
    const dhdz = h01.sub(h00).mul(fx.oneMinus()).add(h11.sub(h10).mul(fx)).div(texel);
    const [foam, slick] = simFoamRate(
      NODE,
      {
        slope: vec2(sdx, sdz).length(),
        headAdvect: uHullVel.x.mul(dhdx).add(uHullVel.y.mul(dhdz)),
        lift: uLift,
        depth: uDepth,
      },
      { simBreakRate: uBreakRate, simChurnRate: uChurnRate, simSternChurn: uSternChurn, simSlickPerFoam: uSlickPerFoam },
    );
    // the sponge is not wake (simInjection's edge window, same law)
    const ex = g.x.add(0.5).min(float(n - 0.5).sub(g.x)).max(0);
    const ey = g.y.add(0.5).min(float(n - 0.5).sub(g.y)).max(0);
    // @band-limited-elsewhere: a ≥ 19 m window evaluated per texel in COMPUTE, never in a fragment stage
    const win = smoothstep(float(0), float(edge), ex).mul(smoothstep(float(0), float(edge), ey));
    return vec2(foam, slick).mul(win);
  };

  const fin = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);

  return {
    rateNode,
    uniforms: { uHullVel, uLift, uDepth },
    /** the `setShip` feed — heading (rad, atan2(fx, fz)) and speed over water (m/s) */
    setHull(yawIn: number, speedIn: number): void {
      // §V28: a non-finite pose keeps the last good one
      if (Number.isFinite(yawIn) && Number.isFinite(speedIn)) {
        yaw = yawIn;
        speed = Math.max(0, speedIn);
      }
    },
    /** RENDER FRAME, after `wakeSim.step` (the caller writes the shared centre): this tick's hull */
    update(): void {
      uHullVel.value.set(Math.sin(yaw) * speed, Math.cos(yaw) * speed);
      const d = sim.sources.depthBins().d1;
      uDepth.value = Math.max(LIFT_DEPTH_FLOOR, fin(d, 0));
      uLift.value = liftFraction(speed, uDepth.value);
      uBreakRate.value = Math.max(0, fin(p.simBreakRate, 0));
      uChurnRate.value = Math.max(0, fin(p.simChurnRate, 0));
      uSternChurn.value = Math.max(0, fin(p.simSternChurn, 0));
      uSlickPerFoam.value = Math.max(0, fin(p.simSlickPerFoam, 0));
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * CPU twin of the GPU head gradient: ∇h_P of the bilinear interpolant of a
 * solver's `head` grid at a world point (0 outside). Used by tests and any CPU
 * reader so both halves differentiate the same interpolant.
 */
export function simHeadGradientCpu(
  head: ArrayLike<number>,
  n: number,
  texel: number,
  centerX: number,
  centerZ: number,
  x: number,
  z: number,
): [number, number] {
  const gu = (x - centerX) / texel + n / 2;
  const gv = (z - centerZ) / texel + n / 2;
  const i = Math.floor(gu);
  const j = Math.floor(gv);
  const fx = gu - i;
  const fy = gv - j;
  const at = (a: number, b: number): number => (a < 0 || b < 0 || a >= n || b >= n ? 0 : head[b * n + a]);
  const h00 = at(i, j);
  const h10 = at(i + 1, j);
  const h01 = at(i, j + 1);
  const h11 = at(i + 1, j + 1);
  return [((h10 - h00) * (1 - fy) + (h11 - h01) * fy) / texel, ((h01 - h00) * (1 - fx) + (h11 - h10) * fx) / texel];
}
