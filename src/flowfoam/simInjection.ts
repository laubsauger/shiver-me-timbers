/**
 * THE SIM WAKE INTO FLOWFOAM'S CHANNELS (§T W2b, docs/wake/w2b-integration.md,
 * wake-research.md §5.2–§5.3). With `wakeBackend: 'sim'` the near tier's advect
 * pass takes the wake's SURFACE from the eWave solver instead of the analytic
 * Kelvin field:
 *
 *   elevTexture.r   ← η_vis   (sim `heightTexture.r`)   → ocean VERTEX displacement
 *   foamTexture.ba  ← ∇η_vis  (sim `slopeTexture.ba`)   → ocean FRAGMENT slope
 *   foamTexture.r/g ← UNCHANGED analytic foam + slick doses (W5, §T.171, replaces them)
 *
 * The ocean material does not change at all: it goes on reading the same two
 * flowfoam textures through `wakeHeightNode`/`wakeSlopeNode`, so §V40's ledger
 * (fragment 15 samplers / 17 textures, vertex 6) is untouched by construction.
 * The sim textures are read HERE, in a compute pass, with `textureLoad` — not
 * a material binding. That is also why this file is not in
 * tests/oceanBindingBudget.test.ts's ledger: nothing on the ocean material
 * path calls it.
 *
 * WHAT IS REMOVED, AND ONLY THAT. The analytic injector is still called for
 * the doses, but with `detail = false` — the path the far tier already runs —
 * which drops exactly the terms the sim replaces (transverse + divergent
 * crests, bow-mound slope, their elevation) and leaves the foam and slick
 * rates bit-for-bit what `detail = true` computes (wakeInjection.ts: `detail`
 * reaches only `slickFieldNode`'s crest branch and `bowSlopeNode`). The
 * analytic code itself stays until W6 (§T.172).
 *
 * RESAMPLE. Manual bilinear over the sim grid (texel centres at integer
 * indices, row j = world z, column i = world x — `WakeSolverCpu.gridU/gridV`),
 * taps outside the grid read 0. The sim is 0.5–0.625 m per texel against the
 * near tier's 0.234 m, so this is an upsample and adds no aliasing of its own.
 *
 * ONE EXPRESSION, TWO EVALUATORS (§V77). The resample and the channel
 * packing are written ONCE, generically over a small operator table
 * (`SimResampleOps`): `createSimWakeField` instantiates it with TSL nodes for
 * the advect pass, `simSurfaceCpu`/`packSimRate` with plain numbers for the
 * tests, which feed it a CPU solver's fields packed by `WAKE_TEX_CHANNEL`. A
 * swapped axis or sign in the expression is therefore a CPU-visible defect.
 *
 * EDGE WINDOW. The outer `sponge.width` of the domain is the ABSORBING LAYER:
 * its content is being deliberately destroyed and is not wake. A per-axis
 * smoothstep from 0 at the grid border to 1 at the sponge's inner edge fades
 * it out so the domain border can never draw a seam, whatever residual the
 * sponge leaves (§V23 functional smoothstep; e0 < e1, width ≥ 1 texel).
 */
import { float, int, ivec2, select, smoothstep, textureLoad, uniform, vec2, vec4 } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { WAKE_TEX_CHANNEL } from '../wake/wakeSolverMath';
import type { WakeSim } from '../wake/wakeSim';

/** the analytic injector's signature (`createWakeInjector().wakeFieldNode`) */
export type WakeFieldFn = (worldXZ: any, detail: boolean, texel: any) => { rate: any; elev: any };

/** which solver output a load reads */
export type SimTex = 'height' | 'slope';

/**
 * The operators the shared expression is written against. `S` is a scalar
 * (number | TSL float/int node), `T` a texel (4 channels).
 */
export interface SimResampleOps<S, T> {
  lit(v: number): S;
  add(a: S, b: S): S;
  sub(a: S, b: S): S;
  mul(a: S, b: S): S;
  min(a: S, b: S): S;
  max(a: S, b: S): S;
  /** floor to an integer texel index */
  floorIndex(a: S): S;
  /** integer index + 1 */
  next(i: S): S;
  fract(a: S): S; // @band-limited-elsewhere: an operator DECLARATION, not a use
  /** §V23 functional form, e0 < e1 */
  smoothstep(e0: S, e1: S, x: S): S; // @band-limited-elsewhere: an operator DECLARATION, not a use
  /** texel (i, j) of a solver output; 0 outside [0, n) */
  load(tex: SimTex, i: S, j: S): T;
  channel(t: T, c: number): S;
}

export interface SimGrid {
  n: number;
  texel: number;
  /** edge-window width (texels) — the sponge ramp */
  edge: number;
}

export interface SimSurface<S> {
  /** η_vis (m) */
  elev: S;
  /** ∂η_vis/∂x (world) */
  slopeX: S;
  /** ∂η_vis/∂z (world) */
  slopeZ: S;
}

export function simGrid(sim: WakeSim): SimGrid {
  return { n: sim.solver.n, texel: sim.solver.texel, edge: Math.max(1, sim.solver.sponge.width * sim.solver.n) };
}

/**
 * THE RESAMPLE: the sim surface at world (wx, wz) for a domain centred at
 * (cx, cz). Texel centres at integer indices, column i = world x, row j =
 * world z (`WakeSolverCpu.gridU/gridV`); bilinear; edge-windowed.
 */
export function simSurface<S, T>(o: SimResampleOps<S, T>, g: SimGrid, wx: S, wz: S, cx: S, cz: S): SimSurface<S> {
  const inv = o.lit(1 / g.texel); // construction constant > 0 (§V28: no runtime divide)
  const half = o.lit(g.n / 2);
  const gx = o.add(o.mul(o.sub(wx, cx), inv), half);
  const gy = o.add(o.mul(o.sub(wz, cz), inv), half);
  const x0 = o.floorIndex(gx);
  const y0 = o.floorIndex(gy);
  const x1 = o.next(x0);
  const y1 = o.next(y0);
  // @band-limited-elsewhere: bilinear tap weights, evaluated in COMPUTE (no pixel footprint)
  const fx = o.fract(gx);
  const fy = o.fract(gy);
  const one = o.lit(1);
  const fxm = o.sub(one, fx);
  const fym = o.sub(one, fy);
  const corners = (tex: SimTex): T[] => [o.load(tex, x0, y0), o.load(tex, x1, y0), o.load(tex, x0, y1), o.load(tex, x1, y1)];
  const bilerp = (q: T[], c: number): S =>
    o.add(
      o.mul(o.add(o.mul(o.channel(q[0], c), fxm), o.mul(o.channel(q[1], c), fx)), fym),
      o.mul(o.add(o.mul(o.channel(q[2], c), fxm), o.mul(o.channel(q[3], c), fx)), fy),
    );
  const h = corners('height');
  const s = corners('slope');
  // distance (texels) from the nearer border per axis; texel centres span [0, n−1]
  const zero = o.lit(0);
  const ex = o.max(o.min(o.add(gx, o.lit(0.5)), o.sub(o.lit(g.n - 0.5), gx)), zero);
  const ey = o.max(o.min(o.add(gy, o.lit(0.5)), o.sub(o.lit(g.n - 0.5), gy)), zero);
  const edge = o.lit(g.edge);
  // @band-limited-elsewhere: a ≥ 19 m window per sim texel, in COMPUTE, never a fragment stage
  const win = o.mul(o.smoothstep(zero, edge, ex), o.smoothstep(zero, edge, ey));
  return {
    elev: o.mul(bilerp(h, WAKE_TEX_CHANNEL.HEIGHT), win),
    slopeX: o.mul(bilerp(s, WAKE_TEX_CHANNEL.SLOPE_DX), win),
    slopeZ: o.mul(bilerp(s, WAKE_TEX_CHANNEL.SLOPE_DZ), win),
  };
}

/**
 * THE PACKING into the accumulation's `rate` (flowfoam channel contract:
 * r foam dose, g slick dose, b ∂η/∂x, a ∂η/∂z — `wakeSlopeNode` adds .b to
 * slopeX and .a to slopeZ).
 */
export function packSimRate<S>(foamDose: S, slickDose: S, surf: SimSurface<S>): [S, S, S, S] {
  return [foamDose, slickDose, surf.slopeX, surf.slopeZ];
}

/** CPU evaluator of the same expression over RGBA Float32 textures in the solver's layout (tests) */
export function simSurfaceCpu(
  g: SimGrid,
  tex: { height: ArrayLike<number>; slope: ArrayLike<number> },
  wx: number,
  wz: number,
  cx: number,
  cz: number,
): SimSurface<number> {
  const ops: SimResampleOps<number, { t: SimTex; i: number; j: number }> = {
    lit: (v) => v,
    add: (a, b) => a + b,
    sub: (a, b) => a - b,
    mul: (a, b) => a * b,
    min: Math.min,
    max: Math.max,
    floorIndex: Math.floor,
    next: (i) => i + 1,
    fract: (a) => a - Math.floor(a),
    smoothstep: (e0, e1, x) => {
      const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
      return t * t * (3 - 2 * t);
    },
    load: (t, i, j) => ({ t, i, j }),
    channel: (q, c) =>
      q.i < 0 || q.j < 0 || q.i >= g.n || q.j >= g.n ? 0 : tex[q.t][(q.j * g.n + q.i) * 4 + c],
  };
  return simSurface(ops, g, wx, wz, cx, cz);
}

/**
 * Wrap the analytic field so the near tier's SURFACE comes from `sim`. The far
 * tier (`detail = false`) is passed straight through: the sim's domain is
 * ~128 m and the far tier carries doses only.
 *
 * Returns the field function plus `uSimCenter`, which the caller must write
 * from `sim.solver.centerX/centerZ` AFTER the sim step and BEFORE the advect
 * dispatch each frame (flowfoam `update`).
 */
export function createSimWakeField(analytic: WakeFieldFn, sim: WakeSim) {
  const { solver } = sim;
  const g = simGrid(sim);
  const n = g.n;
  const uSimCenter = uniform(new THREE.Vector2(solver.centerX, solver.centerZ));
  const textures: Record<SimTex, THREE.Texture> = { height: solver.heightTexture, slope: solver.slopeTexture };
  const swizzle = ['x', 'y', 'z', 'w'] as const;

  const ops: SimResampleOps<any, any> = {
    lit: (v) => float(v),
    add: (a, b) => a.add(b),
    sub: (a, b) => a.sub(b),
    mul: (a, b) => a.mul(b),
    min: (a, b) => a.min(b),
    max: (a, b) => a.max(b),
    floorIndex: (a) => int(a.floor()),
    next: (i) => i.add(1),
    // @band-limited-elsewhere: bilinear tap weights in a COMPUTE pass (no pixel footprint); the drawn slope is gated by wakeSlopeNode's bandKeepNode
    fract: (a) => a.fract(),
    // @band-limited-elsewhere: a ≥ 19 m window evaluated per sim texel in COMPUTE, never in a fragment stage
    smoothstep: (e0, e1, x) => smoothstep(e0, e1, x),
    /** 0 outside [0, n) — the accumulation's `loadZero` rule */
    load: (tex, xi, yi) => {
      const inside = xi.greaterThanEqual(int(0)).and(xi.lessThan(int(n))).and(yi.greaterThanEqual(int(0))).and(yi.lessThan(int(n)));
      return select(inside, textureLoad(textures[tex as SimTex], ivec2(xi.clamp(0, n - 1), yi.clamp(0, n - 1))), vec4(0, 0, 0, 0));
    },
    channel: (t, c) => t[swizzle[c]],
  };

  const field: WakeFieldFn = (worldXZ, detail, tierTexel) => {
    if (!detail) return analytic(worldXZ, false, tierTexel);
    const doses = analytic(worldXZ, false, tierTexel);
    const xz = vec2(worldXZ.x, worldXZ.y);
    const surf = simSurface(ops, g, xz.x, xz.y, uSimCenter.x, uSimCenter.y);
    return { rate: vec4(...packSimRate(doses.rate.x, doses.rate.y, surf)), elev: surf.elev };
  };

  return { field, uSimCenter };
}
