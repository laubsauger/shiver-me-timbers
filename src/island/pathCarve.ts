/**
 * PATH-FIRST ISLAND AUTHORING — the carve half (T112b, §V94, §V90). An
 * `ErosionPass` inserted before 'thermalSmooth' (erosion.ts), so the order
 * is macro → erosion → CARVE → thermal smooth → flood. Two steps:
 *
 *   0  tilt the island toward the next slice island (Journey: downhill is
 *      forward — `pathTilt` m across the footprint, a tiny thing), solve the
 *      graph on a 128² downsample (pathGraph.ts), turn every route into a
 *      TARGET PROFILE along its arc length: the occluder bump is added to
 *      the approach, then the slope is clamped forward and back at the
 *      route's cap (main `pathMainSlope`, fork `pathForkSlope`), the fork
 *      gets ONE scramble segment forced to `pathScrambleSlope`, and the last
 *      half of the occluder distance is cut to its chord so the station is
 *      in view once you are past the ridge (BotW: the reveal is earned at
 *      the crest, not before). Then the full grid is stamped with the
 *      distance to the nearest centreline sample and that sample's target.
 *   1  write: the soft gate (a cut ring around the station on every
 *      bearing the route does not use, ≥ 45° riser — slide back, no climb),
 *      the occluder ridge across the route, then the corridor blend: inside
 *      the tread the ground IS the target, and it fades back to the terrain
 *      over `pathCorridorFalloff` m with a smoothstep (Hnaidi-style), so it
 *      reads as a bench that happened, not a road that was built. Every
 *      write is × `ctx.erodible`: the beach is §V90's and stays untouched.
 *
 * `publish(heightAt)` reads the final y off the finished grid for the POIs
 * and the routes — the consumers (T112d worn grus, T112e no trees in the
 * corridor / manzanita on the fork, T104 clue placement) get one contract.
 */
import type { ErosionContext, ErosionField, ErosionPass } from './erosion';
import {
  buildPathGraph,
  downsample,
  sampleField,
  type PathGraph,
  type PathHints,
  type PoiKind,
  type Polyline,
  type Vec3,
} from './pathGraph';

export interface IslandPath {
  /** metres to the nearest route centreline (main or fork), full grid */
  distance: Float32Array;
  /** tread half-width (m) the masks were cut with: max(pathCorridorWidth/2, 1.5 cells) */
  treadHalf: number;
  /** 1 inside the main corridor (tread + half the falloff) */
  routeMask: Uint8Array;
  /** 1 inside a fork corridor */
  forkMask: Uint8Array;
  pois: { kind: PoiKind; x: number; z: number; y: number }[];
  routes: { main: Vec3[]; forks: Vec3[][] };
  /** the carve's own numbers (lengths, scramble/occluder indices, target profiles) */
  carveStats: PathCarveStats;
}

/** the carve's own numbers, for tests and the perf log */
export interface PathCarveStats {
  graph: PathGraph;
  /** route arc lengths (m) */
  mainLength: number;
  forkLength: number;
  /** index of the scramble on the first fork: [from, to] sample indices */
  scramble: [number, number] | null;
  /** main sample index of the occluder crest */
  occluderIndex: number;
  /** the target profiles the corridor was blended to: [main, ...forks] */
  targets: Float64Array[];
}

const smoothstep01 = (t: number): number => {
  const c = Math.min(Math.max(t, 0), 1);
  return c * c * (3 - 2 * c);
};
const tanDeg = (d: number): number => Math.tan((d * Math.PI) / 180);

/** sample index at arc length `s` */
function indexAtS(pl: Polyline, s: number): number {
  let k = 0;
  while (k < pl.s.length - 1 && pl.s[k] < s) k++;
  return k;
}

/**
 * CUT-ONLY slope limit: the Lipschitz lower envelope P[k] = min_j (raw[j] +
 * cap·|s_k − s_j|). Never above the terrain, |ΔP| ≤ cap·Δs. A trail is a
 * bench cut into the hill, and on the sand — which the carve may not raise —
 * the envelope simply IS the sand. O(n) via a forward and a backward sweep.
 */
function lowerEnvelope(raw: Float64Array, s: Float64Array, cap: number): Float64Array {
  const n = raw.length;
  const P = Float64Array.from(raw);
  for (let k = 1; k < n; k++) P[k] = Math.min(P[k], P[k - 1] + cap * (s[k] - s[k - 1]));
  for (let k = n - 2; k >= 0; k--) P[k] = Math.min(P[k], P[k + 1] + cap * (s[k + 1] - s[k]));
  return P;
}

/**
 * Forward+backward slope clamp: |ΔP| ≤ cap·Δs, P tracks `raw` where it can.
 * Both ends are ANCHORED (`start`/`end` default to the raw ends): a route
 * that ends on sand it cannot carve has to arrive AT the sand, and a fork
 * that leaves the main route has to leave from the main's own target.
 */
function clampProfile(
  raw: Float64Array,
  s: Float64Array,
  cap: number,
  start: number = raw[0],
  end: number = raw[raw.length - 1],
): Float64Array {
  const n = raw.length;
  const f = new Float64Array(n);
  f[0] = start;
  for (let k = 1; k < n; k++) {
    const lim = cap * (s[k] - s[k - 1]);
    f[k] = Math.min(Math.max(raw[k], f[k - 1] - lim), f[k - 1] + lim);
  }
  const g = new Float64Array(n);
  g[n - 1] = end;
  for (let k = n - 2; k >= 0; k--) {
    const lim = cap * (s[k + 1] - s[k]);
    g[k] = Math.min(Math.max(f[k], g[k + 1] - lim), g[k + 1] + lim);
  }
  return g;
}

/**
 * The scramble: the `length` m window of the fork that climbs most (and
 * bends least — a bend is what blurs the walked slope on the grid) gets its
 * rise set to exactly `length·tan(slope)`; the remainder of the fork is then
 * RE-LIMITED from the scramble's new end to the fork's end anchor at `cap`,
 * so nothing downstream ever exceeds the fork cap (lifting the remainder
 * and tapering it was a 43° taper on a 100 m fork). Returns [a, b].
 */
function applyScramble(
  P: Float64Array,
  s: Float64Array,
  length: number,
  slope: number,
  cap: number,
  /** samples the window may not touch (inside the main corridor, low ground) */
  exclude: Uint8Array,
  /** heading (rad) per sample */
  heading: Float64Array,
  maxTurn: number,
): [number, number] | null {
  const n = P.length;
  const total = s[n - 1];
  // the remainder needs room to absorb the scramble's offset at `cap`
  const endLimit = total - Math.max(8, Math.min(30, total * 0.2));
  if (endLimit < length + 5) return null;
  let bestA = -1;
  let bestB = -1;
  let bestRise = -Infinity;
  let b = 0;
  for (let a = 0; a < n; a++) {
    if (s[a] < 5) continue;
    while (b < n - 1 && s[b] - s[a] < length) b++;
    if (s[b] > endLimit) break;
    let clear = true;
    for (let k = a; k <= b && clear; k++) if (exclude[k]) clear = false;
    if (!clear) continue;
    let turn = 0;
    for (let k = a + 1; k <= b; k++) {
      let d = heading[k] - heading[k - 1];
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      turn += Math.abs(d);
    }
    if (turn > maxTurn) continue;
    const rise = Math.abs(P[b] - P[a]);
    if (rise > bestRise) {
      bestRise = rise;
      bestA = a;
      bestB = b;
    }
  }
  if (bestA < 0) return null;
  const sign = P[bestB] >= P[bestA] ? 1 : -1;
  const want = (s[bestB] - s[bestA]) * tanDeg(slope) * sign;
  for (let k = bestA; k <= bestB; k++) {
    P[k] = P[bestA] + (want * (s[k] - s[bestA])) / Math.max(s[bestB] - s[bestA], 1e-6);
  }
  // re-limit the remainder from the new scramble end to the fork's end anchor
  const rest = clampProfile(P.subarray(bestB), s.subarray(bestB), cap, P[bestB], P[n - 1]);
  P.set(rest, bestB);
  return [bestA, bestB];
}

export interface PathCarveOptions {
  seed: number;
  hints: PathHints;
}

export interface PathCarve {
  pass: ErosionPass;
  /** null until step 0 has run */
  stats(): PathCarveStats | null;
  /** the `hm.path` contract, y read off the finished grid */
  publish(heightAt: (x: number, z: number) => number): IslandPath;
}

export function pathCarvePass(opts: PathCarveOptions): PathCarve {
  let graph: PathGraph | null = null;
  let stats: PathCarveStats | null = null;
  // full-grid stamps (step 0 → step 1 and publish): the main route and the
  // forks are stamped SEPARATELY — at a junction the main centreline must keep
  // the main target, not whichever fork sample happens to be nearer
  let distMain: Float32Array | null = null;
  let targetMain: Float64Array | null = null;
  let distFork: Float32Array | null = null;
  let targetFork: Float64Array | null = null;
  let dist: Float32Array | null = null;
  let targets: Float64Array[] = [];
  let tiltDir: [number, number] = [1, 0];
  /** tread + half the falloff: what routeMask/forkMask call "in the corridor" */
  let maskRadius = 0;
  /** tread half-width (m): max(param, 1.5 cells) */
  let half = 0;

  const stamp = (
    pl: Polyline,
    T: Float64Array,
    D: Float32Array,
    TT: Float64Array,
    size: number,
    cell: number,
    R: number,
    radius: number,
    /** per-sample stamp radius override (m) — the fork's junction ends */
    radiusAt: ((k: number) => number) | null = null,
  ): void => {
    for (let k = 0; k < pl.x.length; k++) {
      const rc = Math.ceil((radiusAt ? radiusAt(k) : radius) / cell);
      const gx = (pl.x[k] + R) / cell;
      const gz = (pl.z[k] + R) / cell;
      const x0 = Math.max(0, Math.floor(gx) - rc);
      const x1 = Math.min(size - 1, Math.ceil(gx) + rc);
      const z0 = Math.max(0, Math.floor(gz) - rc);
      const z1 = Math.min(size - 1, Math.ceil(gz) + rc);
      for (let iz = z0; iz <= z1; iz++) {
        for (let ix = x0; ix <= x1; ix++) {
          const d = Math.hypot(ix - gx, iz - gz) * cell;
          const i = iz * size + ix;
          if (d < D[i]) {
            D[i] = d;
            TT[i] = T[k];
          }
        }
      }
    }
  };

  /** two-pass chamfer so cells beyond the stamp radius still get a distance */
  const chamfer = (size: number, cell: number): void => {
    const D = dist!;
    const a = cell;
    const b = cell * Math.SQRT2;
    for (let iz = 0; iz < size; iz++) {
      for (let ix = 0; ix < size; ix++) {
        const i = iz * size + ix;
        let v = D[i];
        if (ix > 0) v = Math.min(v, D[i - 1] + a);
        if (iz > 0) {
          v = Math.min(v, D[i - size] + a);
          if (ix > 0) v = Math.min(v, D[i - size - 1] + b);
          if (ix < size - 1) v = Math.min(v, D[i - size + 1] + b);
        }
        D[i] = v;
      }
    }
    for (let iz = size - 1; iz >= 0; iz--) {
      for (let ix = size - 1; ix >= 0; ix--) {
        const i = iz * size + ix;
        let v = D[i];
        if (ix < size - 1) v = Math.min(v, D[i + 1] + a);
        if (iz < size - 1) {
          v = Math.min(v, D[i + size] + a);
          if (ix < size - 1) v = Math.min(v, D[i + size + 1] + b);
          if (ix > 0) v = Math.min(v, D[i + size - 1] + b);
        }
        D[i] = v;
      }
    }
  };

  const solve = (field: ErosionField, ctx: ErosionContext): void => {
    const { size, cell, bedrock, debris } = field;
    const { p } = ctx;
    const R = (cell * (size - 1)) / 2;
    const n = size * size;
    // Journey tilt first, so the profiles are read off the tilted ground
    tiltDir = [Math.cos(opts.hints.next), Math.sin(opts.hints.next)];
    const total = new Float64Array(n);
    for (let iz = 0; iz < size; iz++) {
      const z = -R + iz * cell;
      for (let ix = 0; ix < size; ix++) {
        const i = iz * size + ix;
        const x = -R + ix * cell;
        const along = (x * tiltDir[0] + z * tiltDir[1]) / Math.max(R, 1e-3);
        bedrock[i] -= 0.5 * p.pathTilt * along * ctx.erodible[i];
        total[i] = bedrock[i] + debris[i];
      }
    }
    // the tread covers every cell a centreline sample interpolates from, or
    // a deep cut leaks into the route through the bilinear sample
    half = Math.max(p.pathCorridorWidth * 0.5, cell * 1.5);
    const coarse = downsample(total, size, R, Math.min(size, 128));
    const beachTop = p.erodeBandStart * 0.5;
    graph = buildPathGraph(coarse, {
      seed: opts.seed,
      hints: opts.hints,
      beachTop,
      poiMinHeight: p.erodeBandStart * 0.5,
      forkAt: p.pathForkAt,
      forkReturnAt: p.pathForkReturnAt,
      forkOffset: p.pathForkOffset,
      /** the fork may not leave from inside the designed approach */
      forkClearance: p.pathOccluderDistance + 10,
      scrambleMinHeight: p.pathGuardStart + p.pathGuardWidth + 3,
      exitSeparation: p.pathExitSeparation,
      sampleStep: Math.max(cell * 0.5, 0.25),
      cost: p,
    });
    const g = graph;
    const hAt = (x: number, z: number): number => sampleField(total, size, R, x, z);
    const rawOf = (pl: Polyline): Float64Array => Float64Array.from(pl.x, (x, k) => hAt(x, pl.z[k]));

    // ── main profile: clamp, then DESIGN the last D of the approach ──
    // Over the occluder distance D before the station: climb at ≤ cap to a
    // crest at 0.7 D, drop into a saddle at 0.5 D, climb to the station. A
    // sight line from D to the station then passes under the crest (the
    // crest is within 0.3 D·tan(cap) of the viewer while the station is a
    // further saddle-to-summit climb away), and from the saddle the final
    // climb is a straight chord — nothing between you and the aerial.
    const main = g.main;
    const cap = tanDeg(p.pathMainSlope);
    const raw0 = rawOf(main);
    const first = lowerEnvelope(raw0, main.s, cap);
    const raw = Float64Array.from(first);
    const sS = main.s[g.stationIndex];
    const D = p.pathOccluderDistance;
    const crestS = sS - D * 0.75;
    const saddleS = sS - D * 0.5;
    const ys = first[g.stationIndex];
    // the final climb is kept SHORT of the cap: the viewer at D must look up
    // at the crest, not past it, and the route bends — the straight sight
    // line can put the crest halfway along, where the line is highest
    const climb = Math.min(D * 0.5 * cap * 0.6, Math.max(ys - first[indexAtS(main, saddleS)], D * 0.25 * cap));
    const ySaddle = ys - climb;
    const yCrest = ySaddle + Math.min(p.pathOccluderHeight, D * 0.25 * cap * 0.95);
    // the approach climbs to the crest from a dip `0.25 D·cap` under it
    const yDip = yCrest - D * 0.25 * cap * 0.9;
    let occluderIndex = 0;
    for (let k = 0; k < main.x.length; k++) {
      const sk = main.s[k];
      if (Math.abs(sk - crestS) < Math.abs(main.s[occluderIndex] - crestS)) occluderIndex = k;
      if (sk < sS - D || sk > sS) continue;
      if (sk <= crestS) {
        const t = (sk - (sS - D)) / Math.max(crestS - (sS - D), 1e-6);
        raw[k] = yDip + (yCrest - yDip) * t;
      } else if (sk <= saddleS) {
        const t = (sk - crestS) / Math.max(saddleS - crestS, 1e-6);
        raw[k] = yCrest + (ySaddle - yCrest) * smoothstep01(t);
      } else {
        const t = (sk - saddleS) / Math.max(sS - saddleS, 1e-6);
        raw[k] = ySaddle + (ys - ySaddle) * t;
      }
    }
    raw[occluderIndex] = yCrest;
    // the design is a FILL where it rises over the envelope; the anchored
    // clamp ramps into it at ≤ cap from both sides (the ends stay on the sand)
    let mainT = clampProfile(raw, main.s, cap);
    // a summit is a dead end on a ridge: where the exit leg RETRACES the
    // approach it must carry the approach's target, or the two legs' targets
    // alternate cell by cell through the same corridor
    let retraced = false;
    for (let k = g.stationIndex + 1; k < main.x.length; k++) {
      let bd = Infinity;
      let bj = 0;
      for (let j = 0; j < g.stationIndex; j++) {
        const d = Math.hypot(main.x[j] - main.x[k], main.z[j] - main.z[k]);
        if (d < bd) {
          bd = d;
          bj = j;
        }
      }
      if (bd < half) {
        mainT[k] = mainT[bj];
        retraced = true;
      }
    }
    if (retraced) mainT = clampProfile(mainT, main.s, cap);
    targets = [mainT];

    // ── fork profiles: clamp at the fork cap, one scramble, ends tied to the main ──
    let scramble: [number, number] | null = null;
    let forkLength = 0;
    g.forks.forEach((fk, fi) => {
      const fr = rawOf(fk);
      // where the fork runs inside the main corridor the main owns the ground:
      // its raw follows the main's target there, so the limit below sees one
      // consistent profile (and the scramble keeps clear of it)
      const edge = p.pathCorridorWidth * 0.5 + p.pathCorridorFalloff;
      const nearMain = new Uint8Array(fk.x.length);
      const inTread = new Uint8Array(fk.x.length);
      for (let k = 0; k < fk.x.length; k++) {
        let bd = Infinity;
        let bi = 0;
        for (let i = 0; i < main.x.length; i++) {
          const d = Math.hypot(main.x[i] - fk.x[k], main.z[i] - fk.z[k]);
          if (d < bd) {
            bd = d;
            bi = i;
          }
        }
        if (bd < edge + 2 * cell) nearMain[k] = 1;
        if (bd < half + cell) inTread[k] = 1;
        if (bd < edge) {
          const w = 1 - smoothstep01((bd - half) / Math.max(p.pathCorridorFalloff, 1e-3));
          fr[k] += (mainT[bi] - fr[k]) * w;
        }
      }
      const fcap = tanDeg(p.pathForkSlope);
      // cut-only over the bulk; inside the main's tread the fork IS the main's
      // bench (pinned); the anchored clamp then ramps off the tread edge at
      // ≤ cap with fills allowed — the bench wall is not sand
      const env = lowerEnvelope(fr, fk.s, fcap);
      for (let k = 0; k < fk.x.length; k++) if (inTread[k]) env[k] = fr[k];
      const T = clampProfile(env, fk.s, fcap, fr[0], fr[fk.x.length - 1]);
      // the scramble keeps clear of the main corridor and of the guard zone
      // (a forced 34° step onto sand the carve may not touch is a cliff);
      // a fork that hugs the main for its first metres falls back to the
      // tread-only exclusion
      const lowGround = new Uint8Array(fk.x.length);
      const guardTop = p.pathGuardStart + p.pathGuardWidth + 1;
      for (let k = 0; k < fk.x.length; k++) if (fr[k] < guardTop) lowGround[k] = 1;
      const heading = new Float64Array(fk.x.length);
      for (let k = 1; k < fk.x.length; k++) heading[k] = Math.atan2(fk.z[k] - fk.z[k - 1], fk.x[k] - fk.x[k - 1]);
      heading[0] = heading[1] ?? 0;
      const ex1 = nearMain.map((v, k) => v | lowGround[k]);
      const ex2 = inTread.map((v, k) => v | lowGround[k]);
      const L = p.pathScrambleLength;
      const S = p.pathScrambleSlope;
      const sc =
        applyScramble(T, fk.s, L, S, fcap, ex1, heading, 0.3) ??
        applyScramble(T, fk.s, L, S, fcap, ex1, heading, 0.7) ??
        applyScramble(T, fk.s, L, S, fcap, ex2, heading, 0.7) ??
        applyScramble(T, fk.s, L, S, fcap, ex2, heading, Infinity);
      if (fi === 0) {
        scramble = sc;
        forkLength = fk.s[fk.s.length - 1];
      }
      targets.push(T);
    });
    stats = { graph: g, mainLength: main.s[main.s.length - 1], forkLength, scramble, occluderIndex, targets };

    // ── stamps ──
    distMain = new Float32Array(n).fill(Infinity);
    targetMain = new Float64Array(n);
    distFork = new Float32Array(n).fill(Infinity);
    targetFork = new Float64Array(n);
    const radius = half + p.pathCorridorFalloff + p.pathGateFeather + 2 * cell;
    maskRadius = half + p.pathCorridorFalloff * 0.5;
    const dM = distMain;
    const tM = targetMain;
    const dF = distFork;
    const tF = targetFork;
    stamp(main, mainT, dM, tM, size, cell, R, radius);
    // a fork's junction samples stamp their TREAD only: the end sample's one
    // target over a whole falloff disc would pull the main bench down around
    // the junction (measured: 27° → 40° on the main there)
    const endZone = half + p.pathCorridorFalloff;
    g.forks.forEach((fk, fi) => {
      const L = fk.s[fk.s.length - 1];
      const nearEnd = (k: number): boolean => fk.s[k] < endZone || (g.forkLoops && L - fk.s[k] < endZone);
      stamp(fk, targets[fi + 1], dF, tF, size, cell, R, radius, (k) => (nearEnd(k) ? half + cell * 0.5 : radius));
    });
    dist = new Float32Array(n);
    for (let i = 0; i < n; i++) dist[i] = Math.min(dM[i], dF[i]);
    chamfer(size, cell);
  };

  const write = (field: ErosionField, ctx: ErosionContext): void => {
    const g = graph!;
    const { size, cell, bedrock, debris } = field;
    const { p } = ctx;
    const R = (cell * (size - 1)) / 2;
    const corridorEdge = half + p.pathCorridorFalloff;
    const [stx, stz] = g.station;
    // occluder frame: tangent at the crest, span across it
    const oi = stats!.occluderIndex;
    const i0 = Math.max(0, oi - 2);
    const i1 = Math.min(g.main.x.length - 1, oi + 2);
    let tx = g.main.x[i1] - g.main.x[i0];
    let tz = g.main.z[i1] - g.main.z[i0];
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    const ox = g.main.x[oi];
    const oz = g.main.z[oi];
    const gateR0 = p.pathGateRadius;
    const gateW = Math.max(p.pathGateWidth, 1e-3);
    const sig2 = p.pathOccluderSigma * p.pathOccluderSigma;
    for (let iz = 0; iz < size; iz++) {
      const z = -R + iz * cell;
      for (let ix = 0; ix < size; ix++) {
        const i = iz * size + ix;
        const e = ctx.erodible[i];
        const x = -R + ix * cell;
        const d = dist![i];
        if (e <= 0 && (d >= corridorEdge || ctx.h0[i] <= p.pathGuardStart)) continue;
        // off-route weight: 0 through the corridor, 1 past the gate feather
        const offRoute = smoothstep01((d - corridorEdge) / Math.max(p.pathGateFeather, 1e-3));
        // soft gate: cut everything outside the ring, on bearings the route does not use
        const r = Math.hypot(x - stx, z - stz);
        if (offRoute > 0 && r < gateR0 + 3 * gateW) {
          const r0 = gateR0 * (0.85 + 0.3 * ctx.joint[i]);
          const cut = smoothstep01((r - r0) / gateW + 0.5) * p.pathGateStep * (0.8 + 0.4 * ctx.joint[i]);
          bedrock[i] -= cut * e * offRoute;
        }
        // occluder ridge across the route (the route itself carries the bump in its target)
        const vx = x - ox;
        const vz = z - oz;
        const along = vx * tx + vz * tz;
        const across = Math.abs(vx * tz - vz * tx);
        if (across < p.pathOccluderSpan * 0.5 && Math.abs(along) < 3 * p.pathOccluderSigma) {
          const span = 1 - smoothstep01((across - p.pathOccluderSpan * 0.3) / (p.pathOccluderSpan * 0.2));
          bedrock[i] += p.pathOccluderHeight * Math.exp(-(along * along) / sig2) * span * e;
        }
        // corridor blend toward the target: the main owns its centreline, the
        // fork fills in what the main leaves. The CORRIDOR has its own guard,
        // lower than the erosion stage's (`pathGuardStart`, above the sand
        // band's heights but under the 14 m the passes wait for): a route has
        // to leave the beach somewhere, and the 2 m step at 8 m that the
        // coarse A* could not see is exactly what the carve exists to remove.
        // The gate, the ridge and the tilt above keep `ctx.erodible`.
        if (d < corridorEdge) {
          const eg = Math.max(e, smoothstep01((ctx.h0[i] - p.pathGuardStart) / Math.max(p.pathGuardWidth, 1e-3)));
          const wm = distMain![i] < corridorEdge ? 1 - smoothstep01((distMain![i] - half) / Math.max(p.pathCorridorFalloff, 1e-3)) : 0;
          // the main's TREAD is the main's: the fork is pinned to the main's
          // target there (below) and only cuts or fills from the tread edge out
          const authority = smoothstep01((distMain![i] - half) / cell);
          const wf = distFork![i] < corridorEdge ? (1 - smoothstep01((distFork![i] - half) / Math.max(p.pathCorridorFalloff, 1e-3))) * authority : 0;
          // the CUT-UNION of the two corridors: a fork leaving the main bench
          // ramps down through the bench's own wall, so the lower of the two
          // blends is the ground; the main's designed fill (the occluder
          // approach) is the one place the main outranks a cut
          const total = bedrock[i] + debris[i];
          const hM = total + (targetMain![i] - total) * wm * eg;
          const hF = total + (targetFork![i] - total) * wf * eg;
          // the deeper cut wins where both corridors CUT; otherwise the one
          // with the stronger claim (a partial blend toward the terrain is
          // not a cut — it would drag a fill back down)
          const both = wm > 0 && wf > 0 && hM <= total && hF <= total;
          const h = both ? Math.min(hM, hF) : wm >= wf ? hM : hF;
          bedrock[i] += h - total;
        }
      }
    }
  };

  const pass: ErosionPass = {
    name: 'pathCarve',
    steps: 2,
    advance(field, ctx, i) {
      if (i === 0) solve(field, ctx);
      else write(field, ctx);
    },
  };

  const publish = (heightAt: (x: number, z: number) => number): IslandPath => {
    const g = graph;
    if (!g || !dist || !distMain || !distFork || !stats) throw new Error('pathCarve.publish: the carve has not run');
    const toVec3 = (pl: Polyline): Vec3[] => {
      const out: Vec3[] = [];
      for (let k = 0; k < pl.x.length; k++) out.push([pl.x[k], heightAt(pl.x[k], pl.z[k]), pl.z[k]]);
      return out;
    };
    const poi = (kind: PoiKind, x: number, z: number): IslandPath['pois'][number] => ({ kind, x, z, y: heightAt(x, z) });
    const pois = [poi('landing', g.landing[0], g.landing[1]), poi('station', g.station[0], g.station[1]), poi('exit', g.exit[0], g.exit[1])];
    if (g.fork) pois.push(poi('fork', g.fork[0], g.fork[1]));
    const n = dist.length;
    const routeMask = new Uint8Array(n);
    const forkMask = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (distMain[i] <= maskRadius) routeMask[i] = 1;
      else if (distFork[i] <= maskRadius) forkMask[i] = 1;
    }
    return {
      distance: dist,
      treadHalf: half,
      routeMask,
      forkMask,
      pois,
      routes: { main: toVec3(g.main), forks: g.forks.map(toVec3) },
      carveStats: stats,
    };
  };

  return { pass, stats: () => stats, publish };
}
