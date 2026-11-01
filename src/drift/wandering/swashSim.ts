/**
 * THE SWASH, SIMULATED (the user, 2026-10-29, of the analytic swash events: "it doesn't look like it's conserving the
 * mass as it should be. It just kinda dissipates and it looks cheap"). The event model's lens thinned as 1/τ² and
 * sank into the sand: its water vanished instead of flowing back. Here the water is a conserved quantity, and the
 * bores, the run-up, the backwash that thickens as it runs back down and the collision line with the next bore are
 * what the equations do, not what a formula draws.
 *
 * THE EQUATIONS: the 2D nonlinear shallow-water equations over our beach's own ground (coast.ts), solved on the GPU
 * (WebGPU compute, TSL) by a shock-capturing finite-volume scheme:
 *   - HLL fluxes (Harten, Lax & van Leer) on each cell face, first order in space, forward Euler in time;
 *   - hydrostatic reconstruction (Audusse, Bouchut, Bristeau, Klein & Perthame 2004): each face sees both cells'
 *     water at the higher of their two beds, and the momentum takes back the difference — exactly still at rest
 *     over any bed (well-balanced: "lake at rest"), never a negative depth under CFL ½, and wet/dry fronts with no
 *     special case;
 *   - velocity desingularised in thin water (Kurganov & Petrova 2007), so a film of a millimetre does not race;
 *   - Manning friction (n = MANNING), semi-implicit (it stops thin films instead of reversing them), and a small
 *     infiltration into the sand above the still water (INFILTRATION, the one term that takes mass away — off in
 *     the mass test).
 * Mass is conserved to round-off: the faces' fluxes cancel in pairs (tests/swashSim.test.ts sums h·dA).
 *
 * THE DOMAIN: 200 m of our beach along the eye's walk in w2–w5 (along −110 … 90 m from its middle) and 34 m across,
 * from ~0.8 m of still water (the flat's edge; the 1:11 face starts ~8 m out) to past the highest run-up, at 10 cm
 * cells (SWASH): 340 × 2000. Beyond it the analytic events (shoreline.ts swashAt) stay as the far fallback,
 * crossfaded over a band.
 *
 * AND ON ALONG THE BEACH (the user, 2026-11-01: "the shore area that is very detailed and active seems a bit too small;
 * we see the boundary between it and the static bits very clearly as a rectangle on the shore, especially in the later
 * wide shots with the people walking" — and from the air, a dark straight "road" on the lagoon beach): the wide shots
 * of w5–w6 see the shore to the point ~300 m ahead, the 200 m strip ended 90 m ahead of the beach's middle, square
 * across. So the grid runs on SWASH_ROWS: 180 m further ahead and 65 m further behind, in rows that coarsen ALONG the
 * shore only (10 cm → 40 cm, ×1.03 a row) — across it, where the bores travel and the run-up climbs, the cells stay
 * 10 cm, and along it the water's features are metres long (crests 2–16° off the normal, sets ~100 m). Where the shore
 * curves (seaward ahead, to the point; landward behind), each row is shifted across by whole cells to follow its
 * waterline (swashShifts), so every row starts in the same ~0.8 m of water: a staircase band along the curve, its
 * cells still axis-aligned squares and rows' neighbours found at the same world x. ~2650 rows, a third more work than
 * the 200 m strip. Its every edge feathered (swashIn, swashSeaGone): a 30 m crossfade at each end along a line that
 * wanders across the shore, and the seaward hand-over to the sea wandering along it, so no edge is straight.
 *
 * THE WAVES come in through the seaward edge (a generating-absorbing boundary on the Riemann invariants: the
 * incoming one set by the forcing, the outgoing one from inside, so what the beach reflects leaves again), a train
 * deterministic in t (swashForcing): a long, low swell (8–11 s) of six components from 2–16° off the beach's
 * normal — they meet in and out of step along the beach over a hundred metres or so, so a crest stands twice as
 * high in one stretch as further on, breaks in long sections, and the groups of them that make the sets travel
 * along it. They shoal over the flat and break into bores near the face by themselves. Sized
 * for a low-energy but living beach (the 2026-10-29 note on the v2 clips: "reads like a calm lake … no visible bore,
 * no white water, no run-up you'd notice"): on our profile (the CPU reference, sea 316–342 s, eight places along)
 * the fronts turn into bores 4–11 m out, and the run-up climbs 1.4–4.0 m past the still waterline as the sets come
 * in, a different reach in each place.
 * The backwash's last film sinks in fast (INFILTRATION: a few mm in a couple of seconds) and leaves the sand glazed.
 *
 * FIELDS carried with the water: foam, made where a bore loses its energy (a steep face, water rising fast) and in
 * the run-up's thin, fast froth, carried by the flow, decaying; settling onto the sand as STRANDED foam where the
 * water thins under a bubble's size (popping over STRAND s); the sand's WETNESS, 1 under water and drying over DRY s,
 * and its GLAZE, the film it keeps for FRESH s.
 *
 * TIME: fixed substeps of DT (CFL ≤ 0.3 at 7 m/s), SUB of them a chunk (1/30 s, a frame at the show's 30 fps), on a
 * grid anchored at sea time 0: the state for frame t is the chunks up to floor(30·t). Sequential frames continue
 * the state; a start or a jump warms it from rest WARM s earlier (the wake's rule): the swash forgets its start
 * within a few periods (the seam: tests/swashSim.test.ts). Every frame a pure function of t up to that seam.
 */
import * as THREE from 'three/webgpu';
import { Fn, float, instanceIndex, int, ivec2, max, min, mix, select, sin, smoothstep, sqrt, textureLoad, textureStore, uniform, vec2, vec3, vec4 } from 'three/tsl';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

/** the grid: m a cell, cells across (world x, i = 0 at the seaward edge) and along (world z); m from the beach's
 * middle (beach.x, beach.z) to the domain's seaward and its −z edge */
export const SWASH = { cell: 0.1, nx: 340, nz: 2000, x0: -19.5, z0: -90 } as const;
/** the domain on along the beach beyond that core (AND ON ALONG THE BEACH in the header): m further ahead (−z) and
 * behind (+z), the rows' growth a row, and the coarsest row (m) */
export const SWASH_ROWS = { ahead: 180, behind: 65, grow: 1.03, coarse: 0.4 } as const;

/** the rows of the grid, −z first: each one's width along (m), its centre (m from the beach's middle, world z), the
 * first row's −z edge and the last's +z edge (m, the same frame), and the core's rows [first, end) */
export interface SwashRows {
  nz: number;
  dz: Float64Array;
  zc: Float64Array;
  zLo: number;
  zHi: number;
  core: [number, number];
}
function rowLayout(): SwashRows {
  // (outward from the core: each row SWASH_ROWS.grow times the last, to the coarsest, until the length is covered)
  const out = (len: number): number[] => {
    const d: number[] = [];
    let sum = 0;
    for (let k = 0; sum < len - 1e-9; k++) {
      const w = Math.min(SWASH_ROWS.coarse, SWASH.cell * SWASH_ROWS.grow ** (k + 1));
      d.push(w);
      sum += w;
    }
    return d;
  };
  const ahead = out(SWASH_ROWS.ahead).reverse();
  const behind = out(SWASH_ROWS.behind);
  const dz = Float64Array.from([...ahead, ...new Array<number>(SWASH.nz).fill(SWASH.cell), ...behind]);
  const zc = new Float64Array(dz.length);
  const zLo = SWASH.z0 - ahead.reduce((a, b) => a + b, 0);
  let z = zLo;
  for (let j = 0; j < dz.length; j++) {
    zc[j] = z + dz[j] / 2;
    z += dz[j];
  }
  return { nz: dz.length, dz, zc, zLo, zHi: z, core: [ahead.length, ahead.length + SWASH.nz] };
}
export const SWASH_LAYOUT: SwashRows = rowLayout();

/** m: the waterline's `off` (beach coordinates: out to sea, toward −x) at `zRel` m from the beach's middle (world z),
 * averaged over 12 m along (the shore's small bays and ripples are not the curve the rows follow) */
function waterlineOff(ground: (x: number, z: number) => number, beach: { x: number; z: number }, zRel: number): number {
  let sum = 0;
  for (let k = -2; k <= 2; k++) {
    let land = -40;
    let sea = 80;
    for (let n = 0; n < 24; n++) {
      const mid = (land + sea) / 2;
      if (ground(beach.x - mid, beach.z + zRel + k * 3) > 0) land = mid;
      else sea = mid;
    }
    sum += (land + sea) / 2;
  }
  return sum / 5;
}

/** cells each row is shifted out to sea (− : landward) to follow the waterline beyond the core (0 in it), so the row
 * starts in the same depth of water as the core's (AND ON ALONG THE BEACH) */
export function swashShifts(ground: (x: number, z: number) => number, beach: { x: number; z: number }, L: SwashRows = SWASH_LAYOUT): Int32Array {
  const s = new Int32Array(L.nz);
  const [c0, c1] = L.core;
  const ahead = waterlineOff(ground, beach, L.zc[c0]);
  const behind = waterlineOff(ground, beach, L.zc[c1 - 1]);
  for (let j = 0; j < c0; j++) s[j] = Math.round((waterlineOff(ground, beach, L.zc[j]) - ahead) / SWASH.cell);
  for (let j = c1; j < L.nz; j++) s[j] = Math.round((waterlineOff(ground, beach, L.zc[j]) - behind) / SWASH.cell);
  return s;
}
/** s a substep, substeps a chunk (one frame at 30 fps), s of warm-up from rest, s ahead a continuation may step
 * (past it, or backward, the state is warmed again) */
export const SWASH_DT = 1 / 240;
export const SWASH_SUB = 8;
export const SWASH_WARM = 20;
export const SWASH_MAX_ADVANCE = 2;
/** m/s² */
const G = 9.81;
/** Manning's n (s/m^⅓): fine sand under a swash */
const MANNING = 0.016;
/** m/s the water sinks into the sand above the still water (fine coral sand, its upper range: the backwash's last
 * film goes within a couple of seconds instead of lying on the face as standing water) */
const INFILTRATION = 1.5e-3;
/** m: water thinner than this has no velocity; the desingularisation's ε (thin films slowed, not stopped) */
const H_DRY = 1e-5;
const EPS = 2e-3;
/** m: water this deep wets the sand, its glaze and its foam's stranding */
const H_WET = 5e-4;
const H_FILM = 3e-3;
/** m: water thinner than this leaves its foam lying on the sand (a bubble's size: the film can no longer float it) */
const STRAND_DEPTH = 0.01;
/** /s: how fast floating foam settles onto the sand in such a film (what leaves the water lands on the sand) */
const SETTLE = 6;
/** s: the sand dries; its glaze sinks in; foam in the water decays; stranded foam pops */
const DRY = 10;
const FRESH = 3;
const FOAM_LIFE = 3;
const STRAND = 4;
/** m²/s: the wet sand's wetness spreading through the sand as it dries (drains and wicks), so the line a run-up
 * stopped at goes soft as it dries, its edge first — ~0.3 m over DRY s (√(2·WICK·DRY)). A run-up's reach drew a
 * crisp dark lobe on the sand, its edge as sharp as the water's was (the sim7 close clip, 649 s; the 2026-10-30 note:
 * "real drying is uneven") */
const WICK = 0.0045;
/** /s foam made where a front is steep (|∇η|, rise per m) between these slopes; and in the run-up's thin, fast water
 * (a swash front is a froth of air: m deep at most, m/s fast from) — what the backwash strands */
const FOAM_RATE = 6;
const STEEP: [number, number] = [0.12, 0.35];
const RUSH_RATE = 3;
const RUSH_DEPTH: [number, number] = [0.002, 0.03];
const RUSH_SPEED: [number, number] = [0.4, 1.2];
/** /s foam made where the water rises fast (m/s, the face of a breaking bore: the energy a bore loses goes into
 * entrained air — a swell's own rise is ~0.1 m/s, a bore's face ~1 m/s) */
const DISS_RATE = 14;
const DISS: [number, number] = [0.15, 0.6];
/** m in from the seaward edge over which the sim may make foam at all: none in its outer metres, where the sea takes
 * over (surfaceMaterial shoreSim: faded out 4–6 m in) and has none to match. A safeguard: with WAVES as they are the
 * first fronts steepen into bores 7–15 m in (the CPU reference), the biggest sets' just inside it */
export const SWASH_CALM: [number, number] = [6, 9];

/**
 * THE INCOMING WAVES at the seaward edge: η (m over the still water) at sea time t s, z m along (world z from the
 * beach's middle): the sum of WAVES, with a standing wander of their phase along the beach. The CPU twin of
 * `forcingNode`.
 *
 * LONG AND LOW: a shorter, higher swell (6.5 s, 0.13 m) steepened into bores 8–11 m out over 0.6 m of water — these
 * equations have no dispersion to hold a swell round, a front steepens over ~2h/(3ak) — one straight bore along the
 * whole beach a long way out, pale where it made foam and dark where its face mirrored the high sky (the tower
 * agent's beach_650 still, 2026-10-29: "a long pale band lies flat across the water"). This one turns into bores where
 * a real one breaks, a few metres out, and runs up as far (Hunt: run-up ∝ √H·T).
 *
 * CRESTED OVER TENS OF METRES: three components, all but one of them nearly square to the beach under one fixed
 * envelope along it, gave the same wave all the way across ("the height of the waves is a little bit too static all
 * the way across", the 2026-10-30 note). Spread over ±18°, eight of them crossed every few tens of metres and the
 * run-up came in as narrow tongues with notches between ("too steep of a spike … it needs to be longer, wider
 * waves", the night view of the same day). Over 2–16°, six of them, with the standing wander's shortest term gone:
 * the heights still vary ×2–3 along the beach, over ~100 m (the run-up in the set window, eight places: 1.4–4.0 m),
 * and the front's line is smooth — 0.03 m rms off its own 10 m mean, its steepest turn 0.10 m per m along (the 2D
 * CPU reference over 60 m, sea 420–432 s; the spread swell's: 0.06 and 0.25).
 */
/** the swell's components (period s, amplitude m, alongshore wavenumber rad/m, phase rad): SWELL_N of them, their
 * periods spread over SWELL_T, their directions over SWELL_DIR (deg off the beach's normal: their crests that much
 * oblique to it), their heights a peaked spectrum scaled to SWELL_VAR — drawn once by a fixed generator, so every
 * frame is the same function of t */
const SWELL_N = 6;
const SWELL_T: [number, number] = [8, 11];
const SWELL_DIR: [number, number] = [2, 16];
/** m²: Σa², the swell's height (its variance at the edge is half of it) */
const SWELL_VAR = 0.0065;
const WAVES: Array<[number, number, number, number]> = (() => {
  let seed = 20261030;
  const rnd = (): number => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  // (the wavenumber over the domain's seaward edge, ~0.85 m of still water: shallow-water waves, c = √(g h))
  const c0 = Math.sqrt(G * 0.85);
  const out: Array<[number, number, number, number]> = [];
  for (let k = 0; k < SWELL_N; k++) {
    const T = SWELL_T[0] + (SWELL_T[1] - SWELL_T[0]) * ((k + rnd()) / SWELL_N);
    const dir = ((SWELL_DIR[0] + (SWELL_DIR[1] - SWELL_DIR[0]) * rnd()) * Math.PI) / 180;
    const peak = Math.exp(-(((T - 9.5) / 1.3) ** 2));
    out.push([T, peak, ((2 * Math.PI) / T / c0) * Math.sin(dir), 2 * Math.PI * rnd()]);
  }
  const sum = out.reduce((s, w) => s + w[1] * w[1], 0);
  for (const w of out) w[1] *= Math.sqrt(SWELL_VAR / sum);
  return out;
})();
/** s the sets are shifted by: their big waves reach the face through the show's 640–655 s (sea 326–341 s), the
 * walk's look along the beach in w4; a lull there read as "a calm lake" (the v2 clips). (Scanned: the largest
 * crests at the edge in sea 318–333 s, along the walk's stretch, of any shift within ±150 s.) */
const SET_PHASE = 117;
/** rad: the crests' standing wander along the beach (two incommensurate sines, bends ~100–200 m long; a third, ~33 m,
 * cut into the fronts' cusps), on top of what the directions make of them */
function wanderCpu(z: number): number {
  return 0.4 * Math.sin(z / 31 + 1.3) + 0.2 * Math.sin(z / 17 + 4.1);
}
export function swashForcing(t0: number, z: number): number {
  const t = t0 + SET_PHASE;
  const phi = wanderCpu(z);
  let s = 0;
  for (const [T, a, kz, ph] of WAVES) s += a * Math.sin((2 * Math.PI * t) / T - kz * z + ph + phi);
  return s;
}
function forcingNode(t0: F, z: F): F {
  const t = t0.add(SET_PHASE) as F;
  const phi = sin(z.div(31).add(1.3)).mul(0.4).add(sin(z.div(17).add(4.1)).mul(0.2));
  let s: F = float(0) as F;
  for (const [T, a, kz, ph] of WAVES) s = s.add(sin(t.mul((2 * Math.PI) / T).sub(z.mul(kz)).add(phi).add(ph)).mul(a)) as F;
  return s;
}

// ---------------------------------------------------------------------------------------------------------------
// THE SCHEME, on the CPU: the reference the GPU kernel transliterates (tests/swashSim.test.ts runs it). Change one,
// change the other.
// ---------------------------------------------------------------------------------------------------------------

export interface SwashGrid {
  nx: number;
  nz: number;
  dx: number;
  /** m: the bed at each cell's centre (i + j·nx) */
  bed: Float64Array;
  h: Float64Array;
  hu: Float64Array;
  hv: Float64Array;
  foam: Float64Array;
  wet: Float64Array;
  glaze: Float64Array;
  strand: Float64Array;
  /** rows of their own widths (m along, per row; default `dx`), shifted across by whole cells (per row; default 0),
   * their centres m along for the forcing (default `z0` + j·dx): SWASH_LAYOUT's, swashShifts' */
  dz?: Float64Array;
  shift?: Int32Array;
  zc?: Float64Array;
}

export interface SwashStepOptions {
  /** the seaward edge: the generating-absorbing boundary (with `z0`, m along of row 0's centre) or a wall */
  seaward: 'generate' | 'wall';
  /** the alongshore ends: zero-gradient (open) or walls */
  ends: 'open' | 'wall';
  z0?: number;
  friction?: boolean;
  infiltration?: boolean;
}

/** a still lake over `bed` (a cell under the still water at 0 filled to it), dry above */
export function swashAtRest(nx: number, nz: number, dx: number, bed: Float64Array): SwashGrid {
  const n = nx * nz;
  const g: SwashGrid = { nx, nz, dx, bed, h: new Float64Array(n), hu: new Float64Array(n), hv: new Float64Array(n), foam: new Float64Array(n), wet: new Float64Array(n), glaze: new Float64Array(n), strand: new Float64Array(n) };
  for (let k = 0; k < n; k++) {
    g.h[k] = Math.max(0, -bed[k]);
    g.wet[k] = g.glaze[k] = g.h[k] > H_WET ? 1 : 0;
  }
  return g;
}

const vel = (h: number, q: number): number => (h < H_DRY ? 0 : (h * q * Math.SQRT2) / Math.sqrt(h ** 4 + Math.max(h ** 4, EPS ** 4)));

/** HLL flux across a face (normal velocity un, tangential ut) with Audusse's reconstruction: [mass, normal momentum,
 * tangential momentum] and the normal momentum each side takes back (½g(h² − h*²)) */
function face(hL: number, unL: number, utL: number, bL: number, hR: number, unR: number, utR: number, bR: number): [number, number, number, number, number] {
  const bF = Math.max(bL, bR);
  const hLs = Math.max(0, hL + bL - bF);
  const hRs = Math.max(0, hR + bR - bF);
  const cL = Math.sqrt(G * hLs);
  const cR = Math.sqrt(G * hRs);
  let sL = Math.min(unL - cL, unR - cR);
  let sR = Math.max(unL + cL, unR + cR);
  if (hLs <= 0) sL = unR - 2 * cR;
  if (hRs <= 0) sR = unL + 2 * cL;
  const FL = [hLs * unL, hLs * unL * unL + 0.5 * G * hLs * hLs, hLs * unL * utL];
  const FR = [hRs * unR, hRs * unR * unR + 0.5 * G * hRs * hRs, hRs * unR * utR];
  const UL = [hLs, hLs * unL, hLs * utL];
  const UR = [hRs, hRs * unR, hRs * utR];
  const den = Math.max(sR - sL, 1e-9);
  const F = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    F[c] = sL >= 0 ? FL[c] : sR <= 0 ? FR[c] : (sR * FL[c] - sL * FR[c] + sL * sR * (UR[c] - UL[c])) / den;
  }
  return [F[0], F[1], F[2], 0.5 * G * (hL * hL - hLs * hLs), 0.5 * G * (hR * hR - hRs * hRs)];
}

/** the state the seaward edge's ghost cell takes: the incoming Riemann invariant from the forcing (a simple wave
 * over still water h0), the outgoing one from the cell inside */
function generating(eta: number, h0: number, h: number, u: number): [number, number] {
  const rp = 4 * Math.sqrt(G * Math.max(0, h0 + eta)) - 2 * Math.sqrt(G * h0);
  const rm = u - 2 * Math.sqrt(G * h);
  const c = Math.max(0, (rp - rm) / 4);
  return [(c * c) / G, (rp + rm) / 2];
}

/** one substep of `dt` s at sea time `t` s: `g` is read, `out` written (two grids, ping-pong) */
export function stepSwashCpu(g: SwashGrid, out: SwashGrid, t: number, dt: number, o: SwashStepOptions): void {
  const { nx, nz, dx } = g;
  const at = (i: number, j: number): number => i + j * nx;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = at(i, j);
      const h = g.h[k];
      const b = g.bed[k];
      // (this row's width along, and the cells of the rows either side at this cell's world x: its shift's
      // difference from theirs — out of their range, an open edge)
      const dzj = g.dz ? g.dz[j] : dx;
      const across = (jj: number): number => i + (g.shift ? g.shift[jj] - g.shift[j] : 0);
      const iS = j > 0 ? across(j - 1) : -1;
      const iN = j < nz - 1 ? across(j + 1) : -1;
      const u = vel(h, g.hu[k]);
      const v = vel(h, g.hv[k]);
      // the four neighbours, ghosts at the edges
      const nb = (ii: number, jj: number): [number, number, number, number, number] => {
        const kk = at(ii, jj);
        const hh = g.h[kk];
        return [hh, vel(hh, g.hu[kk]), vel(hh, g.hv[kk]), g.bed[kk], g.foam[kk]];
      };
      let W: [number, number, number, number, number];
      if (i > 0) W = nb(i - 1, j);
      else if (o.seaward === 'generate') {
        const z = g.zc ? g.zc[j] : (o.z0 ?? 0) + j * dx;
        const [hg, ug] = generating(swashForcing(t, z), Math.max(0.05, -b), h, u);
        W = [hg, ug, v, b, 0];
      } else W = [h, -u, v, b, g.foam[k]];
      const E: [number, number, number, number, number] = i < nx - 1 ? nb(i + 1, j) : [h, -u, v, b, g.foam[k]];
      const own: [number, number, number, number, number] = [h, u, v, b, g.foam[k]];
      const S: [number, number, number, number, number] = j > 0 ? (iS >= 0 && iS < nx ? nb(iS, j - 1) : own) : o.ends === 'open' ? own : [h, u, -v, b, g.foam[k]];
      const N: [number, number, number, number, number] = j < nz - 1 ? (iN >= 0 && iN < nx ? nb(iN, j + 1) : own) : o.ends === 'open' ? own : [h, u, -v, b, g.foam[k]];
      // x faces (normal u, tangential v), z faces (normal v, tangential u)
      const fe = face(h, u, v, b, E[0], E[1], E[2], E[3]);
      const fw = face(W[0], W[1], W[2], W[3], h, u, v, b);
      const fn = face(h, v, u, b, N[0], N[2], N[1], N[3]);
      const fs = face(S[0], S[2], S[1], S[3], h, v, u, b);
      let h1 = h - (dt / dx) * (fe[0] - fw[0]) - (dt / dzj) * (fn[0] - fs[0]);
      let hu1 = g.hu[k] - (dt / dx) * (fe[1] + fe[3] - (fw[1] + fw[4])) - (dt / dzj) * (fn[2] - fs[2]);
      let hv1 = g.hv[k] - (dt / dx) * (fe[2] - fw[2]) - (dt / dzj) * (fn[1] + fn[3] - (fs[1] + fs[4]));
      h1 = Math.max(0, h1);
      // infiltration into the sand above the still water (the momentum with the water it carries)
      if (o.infiltration && b > 0 && h1 > 0) {
        const keep = Math.max(0, h1 - dt * INFILTRATION) / h1;
        h1 *= keep;
        hu1 *= keep;
        hv1 *= keep;
      }
      // friction: Manning, semi-implicit
      if (h1 < H_DRY) {
        hu1 = 0;
        hv1 = 0;
      } else if (o.friction) {
        const u1 = vel(h1, hu1);
        const v1 = vel(h1, hv1);
        const s = (G * MANNING * MANNING * Math.hypot(u1, v1)) / Math.pow(Math.max(h1, H_FILM), 4 / 3);
        hu1 /= 1 + dt * s;
        hv1 /= 1 + dt * s;
      }
      // FOAM: carried upwind, made where the front is steep, decaying in the water, stranded where it drains
      const eta = (hh: number, bb: number): number => (hh > H_WET ? hh + bb : h > H_WET ? h + b : bb);
      const gx = (eta(E[0], E[3]) - eta(W[0], W[3])) / (2 * dx);
      const gz = (eta(N[0], N[3]) - eta(S[0], S[3])) / (2 * dzj);
      const steep = Math.hypot(gx, gz);
      const f = g.foam[k];
      let f1 = f - (dt / dx) * (Math.max(u, 0) * (f - W[4]) + Math.min(u, 0) * (E[4] - f)) - (dt / dzj) * (Math.max(v, 0) * (f - S[4]) + Math.min(v, 0) * (N[4] - f));
      const rise = (h1 - h) / dt;
      // (never in the outer SWASH_CALM metres, where the sea takes over)
      const breaking = o.seaward === 'generate' ? smoothstepCpu(SWASH_CALM[0], SWASH_CALM[1], (i + 0.5) * dx) : 1;
      const made =
        smoothstepCpu(STEEP[0], STEEP[1], steep) * (h > 0.01 ? 1 : 0) * breaking * FOAM_RATE +
        smoothstepCpu(DISS[0], DISS[1], rise) * (h > 0.01 ? 1 : 0) * breaking * DISS_RATE +
        smoothstepCpu(RUSH_SPEED[0], RUSH_SPEED[1], Math.hypot(u, v)) * (h > RUSH_DEPTH[0] && h < RUSH_DEPTH[1] ? 1 : 0) * RUSH_RATE;
      f1 = Math.min(1, Math.max(0, f1 + dt * made * (1 - f1))) * Math.exp(-dt / FOAM_LIFE);
      const drying = 1 - smoothstepCpu(H_WET, STRAND_DEPTH, h1);
      const settled = f1 * drying * Math.min(1, SETTLE * dt);
      out.strand[k] = Math.min(1, g.strand[k] * Math.exp(-dt / STRAND) + settled);
      out.foam[k] = f1 - settled;
      // (the dry sand's wetness spreading through it, WICK: the four neighbours' Laplacian, the grid's edges mirrored)
      const wk = (ii: number, jj: number): number => g.wet[at(Math.min(nx - 1, Math.max(0, ii)), Math.min(nz - 1, Math.max(0, jj)))];
      const lapX = wk(i - 1, j) + wk(i + 1, j) - 2 * g.wet[k];
      const lapZ = wk(j > 0 ? iS : i, j - 1) + wk(j < nz - 1 ? iN : i, j + 1) - 2 * g.wet[k];
      out.wet[k] = h1 > H_WET ? 1 : Math.min(1, Math.max(0, g.wet[k] + dt * WICK * (lapX / (dx * dx) + lapZ / (dzj * dzj)))) * Math.exp(-dt / DRY);
      out.glaze[k] = h1 > H_WET ? 1 : g.glaze[k] * Math.exp(-dt / FRESH);
      out.h[k] = h1;
      out.hu[k] = hu1;
      out.hv[k] = hv1;
    }
  }
}

function smoothstepCpu(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Which chunks a frame at sea time t steps: from the chunk the state is at (`at`, null if none) to floor(30·t).
 * A continuation within SWASH_MAX_ADVANCE steps on; anything else (a start, a jump ahead, any step back) warms from
 * rest SWASH_WARM s earlier.
 */
export function swashPlan(at: number | null, t: number): { reset: boolean; from: number; to: number } {
  const per = SWASH_SUB * SWASH_DT;
  const to = Math.floor(t / per + 1e-6);
  if (at !== null && to >= at && to - at <= Math.round(SWASH_MAX_ADVANCE / per)) return { reset: false, from: at, to };
  return { reset: true, from: to - Math.round(SWASH_WARM / per), to };
}

// ---------------------------------------------------------------------------------------------------------------
// THE SCHEME ON THE GPU (a transliteration of stepSwashCpu, the production edges: generating seaward, open ends,
// a wall landward, friction and infiltration on)
// ---------------------------------------------------------------------------------------------------------------

const makeStateTexture = (filter: boolean): THREE.StorageTexture => {
  const t = new THREE.StorageTexture(SWASH.nx, SWASH_LAYOUT.nz);
  t.type = THREE.FloatType;
  t.format = THREE.RGBAFormat;
  t.minFilter = t.magFilter = filter ? THREE.LinearFilter : THREE.NearestFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  return t;
};

/** m between the row lookup's texels (swashField.rows): the core's rows are linear in z, so its linear filter is
 * exact there; the coarse rows' shifts are interpolated over it */
const ROW_LUT_STEP = 0.25;
const ROW_LUT_N = Math.ceil((SWASH_LAYOUT.zHi - SWASH_LAYOUT.zLo) / ROW_LUT_STEP);

/**
 * WHAT THE SIM PUBLISHES, sampled by the shoreline, the sand and the sea (module-level, so the beach's material, built
 * before the coast, can bind them): `water` = (η m over the sea, h m, u, v m/s), `marks` = (foam, stranded foam, wet,
 * glaze), both at each cell's centre; `rect` the domain's world box (x0, z0, x1, z1); `rows` the lookup from world z
 * to the grid (its row coordinate over nz, its shift in cells, its row's width m), over `geo` = (the core's seaward
 * world x, the domain's −z edge world z, the lookup's span m, the grid's width across m); `active` 0 until a sim runs.
 */
export const swashField = {
  water: makeStateTexture(true),
  marks: makeStateTexture(true),
  rect: uniform(new THREE.Vector4(0, 0, 1, 1)),
  rows: (() => {
    const t = new THREE.DataTexture(new Float32Array(ROW_LUT_N * 4), ROW_LUT_N, 1, THREE.RGBAFormat, THREE.FloatType);
    // (read with textureLoad and interpolated by hand, rowAt: no sampler. The sea's fragment stage reads it through
    // shoreSimMask, and that stage keeps ONE spare sampler of 16 — tests/oceanBindingBudget.test.ts)
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = false;
    return t;
  })(),
  geo: uniform(new THREE.Vector4(0, 0, 1, SWASH.nx * SWASH.cell)),
  active: uniform(0),
  /** the running sim (the review page times it: scripts' --post) */
  sim: null as SwashSim | null,
};

/** the row lookup at `p` (world x, z): (row coordinate / nz, shift in cells, the row's width m) */
function rowAt(p: THREE.Node<'vec2'>): V3 {
  const G = swashField.geo as unknown as V4;
  // (its two texels either side, blended: a linear filter's result, with a textureLoad's cost — no sampler)
  const c = p.y.sub(G.y).div(G.z).mul(ROW_LUT_N).sub(0.5).clamp(0, ROW_LUT_N - 1) as F;
  const k0 = c.floor() as F;
  const at = (k: F): V3 => (textureLoad(swashField.rows, ivec2(int(k), int(0))) as unknown as V4).xyz as V3;
  return mix(at(k0), at(k0.add(1).min(ROW_LUT_N - 1) as F), c.sub(k0)) as V3;
}
/** where `p` (world x, z) is on the published fields (uv over the grid) */
export function swashUV(p: THREE.Node<'vec2'>): THREE.Node<'vec2'> {
  const G = swashField.geo as unknown as V4;
  const r = rowAt(p);
  return vec2(p.x.sub(G.x).div(SWASH.cell).add(r.y).div(SWASH.nx), r.x) as THREE.Node<'vec2'>;
}
/** m the width along of the grid's row at `p` (the along neighbour of a lookup is a row away) */
export function swashRowWidth(p: THREE.Node<'vec2'>): F {
  return rowAt(p).z as F;
}
/** m in from the seaward edge of the grid's row at `p` (its shift followed) */
export function swashFromSea(p: THREE.Node<'vec2'>): F {
  const G = swashField.geo as unknown as V4;
  return p.x.sub(G.x).add(rowAt(p).y.mul(SWASH.cell)) as F;
}
/** THE EDGES' WANDER (AND ON ALONG THE BEACH: no edge straight): m the hand-over lines move — the ends' line across
 * the shore ±9 m, over 12–30 m across it; the seaward line ±1.3 m, over 27–70 m along (local coordinates: 40 km out a
 * world position's sine loses its digits) */
function endWander(p: THREE.Node<'vec2'>): F {
  const x = p.x.sub((swashField.geo as unknown as V4).x);
  return sin(x.mul(0.21).add(1.3)).mul(6).add(sin(x.mul(0.53).add(0.4)).mul(3)) as F;
}
function seaWander(p: THREE.Node<'vec2'>): F {
  const z = p.y.sub((swashField.geo as unknown as V4).y);
  return sin(z.mul(0.09).add(0.7)).mul(0.8).add(sin(z.mul(0.23).add(2.1)).mul(0.5)) as F;
}
/** 0 … 1 in from the domain's ends along the beach: over `band` m (m along, from `from` m in), on a line that wanders
 * across the shore (endWander; `from` ≥ its 9 m, so none of it falls outside the grid) */
function endsIn(p: THREE.Node<'vec2'>, from: number, band: number): F {
  const R = swashField.rect as unknown as V4;
  const z = p.y.sub(R.y).add(endWander(p)) as F;
  const span = R.w.sub(R.y) as F;
  return smoothstep(from, from + band, z).mul(smoothstep(span.sub(from), span.sub(from + band), z)) as F;
}
/** 1 well inside the domain, 0 outside it (and before a sim runs): 1.5–5 m in from its seaward edge (where the waves
 * are forced), wandering along it, and over 30 m in from its ends (from 12 m in, past the wander and the open ends'
 * own edge effects) — the band the fields hand over to the analytic swash across. (8 m from square ends, the hand-over
 * read as "a rectangle on the shore", the 2026-11-01 note) */
export function swashIn(p: THREE.Node<'vec2'>): F {
  return smoothstep(1.5, 5, swashFromSea(p).add(seaWander(p)))
    .mul(endsIn(p, 12, 30))
    .mul(swashField.active) as F;
}
/** 1 where the sea lets the sim's water be the surface (surfaceMaterial shoreSim, the shoreline's composite): only
 * where the sim is already whole — 5–13 m in from its seaward edge on the same wandering line, past its ends' fade,
 * short of its landward edge. (Over 5.5–8 m the two waters met along a line: the sim's, over shallower sand, darker
 * and finer-rippled than the sea's beside it, read from the walkers' raised view at ~700 s as a dark patch "bounded by
 * a sharp edge", the user, 2026-11-01. Over 8 m the one grades into the other) */
export function swashSeaGone(p: THREE.Node<'vec2'>): F {
  const d = swashFromSea(p);
  return smoothstep(5, 13, d.add(seaWander(p)))
    .mul(smoothstep(SWASH.nx * SWASH.cell, SWASH.nx * SWASH.cell - 0.5, d))
    .mul(endsIn(p, 42, 8))
    .mul(swashField.active) as F;
}

export interface SwashSim {
  /** world x0, z0, x1, z1 of the domain */
  readonly rect: [number, number, number, number];
  /** step to sea time t s (warming first when it must) and publish the fields */
  update(renderer: THREE.WebGPURenderer, t: number): void;
  /** ms the last update's dispatches took on the CPU side, and how many chunks it stepped */
  readonly stats: { chunks: number; ms: number };
}

/** the sim over our beach: `ground` its height (m over the sea) at world x, z; `beach` its middle */
export function createSwashSim(o: { ground: (x: number, z: number) => number; beach: { x: number; z: number } }): SwashSim {
  const { nx, cell } = SWASH;
  const L = SWASH_LAYOUT;
  const nz = L.nz;
  const shift = swashShifts(o.ground, o.beach, L);
  /** world x of the core's seaward edge (a row's cells start `shift` cells seaward of it) */
  const x0 = o.beach.x + SWASH.x0;
  let sMin = 0;
  let sMax = 0;
  for (const v of shift) {
    sMin = Math.min(sMin, v);
    sMax = Math.max(sMax, v);
  }
  const rect: [number, number, number, number] = [x0 - sMax * cell, o.beach.z + L.zLo, x0 + (nx - sMin) * cell, o.beach.z + L.zHi];
  // the bed at each cell's centre
  const bedData = new Float32Array(nx * nz * 4);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      bedData[(i + j * nx) * 4] = o.ground(x0 + (i + 0.5 - shift[j]) * cell, o.beach.z + L.zc[j]);
    }
  }
  // each row: its width along (m), its shift (cells), its centre (m from the beach's middle, the forcing's z)
  const rowData = new Float32Array(nz * 4);
  for (let j = 0; j < nz; j++) rowData.set([L.dz[j], shift[j], L.zc[j], 0], j * 4);
  const rows = new THREE.DataTexture(rowData, nz, 1, THREE.RGBAFormat, THREE.FloatType);
  rows.minFilter = rows.magFilter = THREE.NearestFilter;
  rows.generateMipmaps = false;
  rows.needsUpdate = true;
  // the lookup from world z (swashField.rows): the row coordinate over nz, the shift between rows' centres, the width
  {
    const lut = swashField.rows.image.data as Float32Array;
    let j = 0;
    let lo = L.zLo;
    for (let k = 0; k < ROW_LUT_N; k++) {
      const z = L.zLo + (k + 0.5) * ROW_LUT_STEP;
      while (j < nz - 1 && z >= lo + L.dz[j]) lo += L.dz[j++];
      const c = Math.min(nz, j + (z - lo) / L.dz[j]);
      const cc = Math.min(nz - 1, Math.max(0, c - 0.5));
      const j0 = Math.min(nz - 2, Math.floor(cc));
      const f = Math.min(1, cc - j0);
      lut.set([c / nz, shift[j0] * (1 - f) + shift[j0 + 1] * f, L.dz[j], 0], k * 4);
    }
    swashField.rows.needsUpdate = true;
    swashField.geo.value.set(x0, o.beach.z + L.zLo, ROW_LUT_N * ROW_LUT_STEP, nx * cell);
  }
  const bed = new THREE.DataTexture(bedData, nx, nz, THREE.RGBAFormat, THREE.FloatType);
  bed.minFilter = bed.magFilter = THREE.NearestFilter;
  bed.generateMipmaps = false;
  bed.needsUpdate = true;
  const sets = [
    { state: makeStateTexture(false), aux: makeStateTexture(false) },
    { state: makeStateTexture(false), aux: makeStateTexture(false) },
  ];
  /** s: sea time of the chunk being stepped */
  const uTime = uniform(0);

  const velN = (h: F, q: F): F => select(h.lessThan(H_DRY), float(0), h.mul(q).mul(Math.SQRT2).div(sqrt(h.mul(h).mul(h).mul(h).add(max(h.mul(h).mul(h).mul(h), EPS ** 4))))) as F;
  /** the HLL face of `face` above: vec3 flux and the two sides' momentum corrections */
  const faceN = (hL: F, unL: F, utL: F, bL: F, hR: F, unR: F, utR: F, bR: F) => {
    const bF = max(bL, bR);
    const hLs = max(hL.add(bL).sub(bF), 0) as F;
    const hRs = max(hR.add(bR).sub(bF), 0) as F;
    const cL = sqrt(hLs.mul(G)) as F;
    const cR = sqrt(hRs.mul(G)) as F;
    const sL = select(hLs.lessThanEqual(0), unR.sub(cR.mul(2)), min(unL.sub(cL), unR.sub(cR))) as F;
    const sR = select(hRs.lessThanEqual(0), unL.add(cL.mul(2)), max(unL.add(cL), unR.add(cR))) as F;
    const FL = vec3(hLs.mul(unL), hLs.mul(unL).mul(unL).add(hLs.mul(hLs).mul(0.5 * G)), hLs.mul(unL).mul(utL)) as V3;
    const FR = vec3(hRs.mul(unR), hRs.mul(unR).mul(unR).add(hRs.mul(hRs).mul(0.5 * G)), hRs.mul(unR).mul(utR)) as V3;
    const UL = vec3(hLs, hLs.mul(unL), hLs.mul(utL)) as V3;
    const UR = vec3(hRs, hRs.mul(unR), hRs.mul(utR)) as V3;
    const hll = FL.mul(sR).sub(FR.mul(sL)).add(UR.sub(UL).mul(sL.mul(sR))).div(max(sR.sub(sL), 1e-9)) as V3;
    const F = select(sL.greaterThanEqual(0), FL, select(sR.lessThanEqual(0), FR, hll)) as V3;
    return { F, corrL: hL.mul(hL).sub(hLs.mul(hLs)).mul(0.5 * G) as F, corrR: hR.mul(hR).sub(hRs.mul(hRs)).mul(0.5 * G) as F };
  };

  const stepKernel = (src: (typeof sets)[0], dst: (typeof sets)[0], sub: number) =>
    (Fn(() => {
      const i = int(instanceIndex.mod(nx)).toVar();
      const j = int(instanceIndex.div(nx)).toVar();
      const dt = SWASH_DT;
      const t = uTime.add(sub * SWASH_DT) as unknown as F;
      const c = textureLoad(src.state, ivec2(i, j)) as V4;
      const a = textureLoad(src.aux, ivec2(i, j)) as V4;
      const b = (textureLoad(bed, ivec2(i, j)) as V4).x as F;
      const h = c.x as F;
      const u = velN(h, c.y as F);
      const v = velN(h, c.z as F);
      // this row (width along, shift, centre) and its neighbours' cells at this cell's world x (stepSwashCpu `across`)
      const row = textureLoad(rows, ivec2(j, 0)) as V4;
      const dzj = row.x as F;
      const iS = i.add(int((textureLoad(rows, ivec2(j.sub(1).max(int(0)), 0)) as V4).y.sub(row.y))).toVar();
      const iN = i.add(int((textureLoad(rows, ivec2(j.add(1).min(int(nz - 1)), 0)) as V4).y.sub(row.y))).toVar();
      const nb = (ii: unknown, jj: unknown) => {
        const s = textureLoad(src.state, ivec2(ii as never, jj as never)) as V4;
        const hh = s.x as F;
        return { h: hh, u: velN(hh, s.y as F), v: velN(hh, s.z as F), b: (textureLoad(bed, ivec2(ii as never, jj as never)) as V4).x as F, f: s.w as F };
      };
      // the neighbours, clamped into the grid, then the edges' ghosts in their place
      const Wc = nb(i.sub(1).max(int(0)), j);
      const Ec = nb(i.add(1).min(int(nx - 1)), j);
      const Sc = nb(iS.clamp(int(0), int(nx - 1)), j.sub(1).max(int(0)));
      const Nc = nb(iN.clamp(int(0), int(nx - 1)), j.add(1).min(int(nz - 1)));
      // seaward: the generating-absorbing ghost (forcing at this row's z, m along from the beach's middle)
      const z = row.z as F;
      const h0 = max(b.negate(), 0.05);
      const rp = sqrt(h0.add(forcingNode(t, z)).max(0).mul(G)).mul(4).sub(sqrt(h0.mul(G)).mul(2));
      const rm = u.sub(sqrt(h.mul(G)).mul(2));
      const cg = max(rp.sub(rm).div(4), 0);
      const atSea = i.equal(0);
      const W = {
        h: select(atSea, cg.mul(cg).div(G), Wc.h) as F,
        u: select(atSea, rp.add(rm).div(2), Wc.u) as F,
        v: select(atSea, v, Wc.v) as F,
        b: select(atSea, b, Wc.b) as F,
        f: select(atSea, float(0), Wc.f) as F,
      };
      // landward: a wall; the ends: open
      const atLand = i.equal(nx - 1);
      const E = { h: select(atLand, h, Ec.h) as F, u: select(atLand, u.negate(), Ec.u) as F, v: select(atLand, v, Ec.v) as F, b: select(atLand, b, Ec.b) as F, f: select(atLand, c.w, Ec.f) as F };
      // (the ends, and a row's cells past its neighbour's range: open)
      const atS = j.equal(0).or(iS.lessThan(0)).or(iS.greaterThan(nx - 1));
      const atN = j.equal(nz - 1).or(iN.lessThan(0)).or(iN.greaterThan(nx - 1));
      const S = { h: select(atS, h, Sc.h) as F, u: select(atS, u, Sc.u) as F, v: select(atS, v, Sc.v) as F, b: select(atS, b, Sc.b) as F, f: select(atS, c.w, Sc.f) as F };
      const N = { h: select(atN, h, Nc.h) as F, u: select(atN, u, Nc.u) as F, v: select(atN, v, Nc.v) as F, b: select(atN, b, Nc.b) as F, f: select(atN, c.w, Nc.f) as F };
      const fe = faceN(h, u, v, b, E.h, E.u, E.v, E.b);
      const fw = faceN(W.h, W.u, W.v, W.b, h, u, v, b);
      const fn = faceN(h, v, u, b, N.h, N.v, N.u, N.b);
      const fs = faceN(S.h, S.v, S.u, S.b, h, v, u, b);
      const k = dt / cell;
      const kz = float(dt).div(dzj) as F;
      const h1a = max(h.sub(fe.F.x.sub(fw.F.x).mul(k)).sub(fn.F.x.sub(fs.F.x).mul(kz)), 0) as F;
      const hu1a = (c.y as F).sub(fe.F.y.add(fe.corrL).sub(fw.F.y.add(fw.corrR)).mul(k)).sub(fn.F.z.sub(fs.F.z).mul(kz)) as F;
      const hv1a = (c.z as F).sub(fe.F.z.sub(fw.F.z).mul(k)).sub(fn.F.y.add(fn.corrL).sub(fs.F.y.add(fs.corrR)).mul(kz)) as F;
      // infiltration above the still water
      const keep = select(b.greaterThan(0).and(h1a.greaterThan(0)), max(h1a.sub(dt * INFILTRATION), 0).div(max(h1a, 1e-12)), float(1)) as F;
      const h1 = h1a.mul(keep) as F;
      const u1 = velN(h1, hu1a.mul(keep) as F);
      const v1 = velN(h1, hv1a.mul(keep) as F);
      const fr = vec2(u1, v1).length().mul(G * MANNING * MANNING).div(max(h1, H_FILM).pow(4 / 3)).mul(dt).add(1) as F;
      const dry = h1.lessThan(H_DRY);
      const hu1 = select(dry, float(0), hu1a.mul(keep).div(fr)) as F;
      const hv1 = select(dry, float(0), hv1a.mul(keep).div(fr)) as F;
      // FOAM (as stepSwashCpu)
      const etaOf = (hh: F, bb: F): F => select(hh.greaterThan(H_WET), hh.add(bb), select(h.greaterThan(H_WET), h.add(b), bb)) as F;
      const gx = etaOf(E.h, E.b).sub(etaOf(W.h, W.b)).div(2 * cell);
      const gz = etaOf(N.h, N.b).sub(etaOf(S.h, S.b)).div(dzj.mul(2));
      const steep = vec2(gx, gz).length();
      const f = c.w as F;
      const adv = max(u, 0).mul(f.sub(W.f)).add(min(u, 0).mul(E.f.sub(f))).mul(k).add(max(v, 0).mul(f.sub(S.f)).add(min(v, 0).mul(N.f.sub(f))).mul(kz));
      const breaking = smoothstep(SWASH_CALM[0], SWASH_CALM[1], float(i).add(0.5).mul(cell)) as F;
      const made = smoothstep(STEEP[0], STEEP[1], steep)
        .mul(select(h.greaterThan(0.01), float(1), float(0)))
        .mul(breaking)
        .mul(FOAM_RATE)
        .add(smoothstep(DISS[0], DISS[1], h1.sub(h).div(dt)).mul(select(h.greaterThan(0.01), float(1), float(0))).mul(breaking).mul(DISS_RATE))
        .add(smoothstep(RUSH_SPEED[0], RUSH_SPEED[1], vec2(u, v).length()).mul(select(h.greaterThan(RUSH_DEPTH[0]).and(h.lessThan(RUSH_DEPTH[1])), float(1), float(0))).mul(RUSH_RATE));
      const fa = f.sub(adv) as F;
      const f1 = fa.add(made.mul(dt).mul(float(1).sub(fa))).clamp(0, 1).mul(Math.exp(-dt / FOAM_LIFE)) as F;
      const drying = float(1).sub(smoothstep(H_WET, STRAND_DEPTH, h1)) as F;
      const wetNow = h1.greaterThan(H_WET);
      const settled = f1.mul(drying).mul(Math.min(1, SETTLE * dt)) as F;
      const strand = (a.z as F).mul(Math.exp(-dt / STRAND)).add(settled).min(1);
      textureStore(dst.state, ivec2(i, j), vec4(h1, hu1, hv1, f1.sub(settled))).toWriteOnly();
      // (the dry sand's wetness spreading, WICK, as stepSwashCpu)
      const wetAt = (ii: unknown, jj: unknown): F => (textureLoad(src.aux, ivec2(ii as never, jj as never)) as V4).x as F;
      const lapX = wetAt(i.sub(1).max(int(0)), j).add(wetAt(i.add(1).min(int(nx - 1)), j)).sub((a.x as F).mul(2));
      const lapZ = wetAt(iS.clamp(int(0), int(nx - 1)), j.sub(1).max(int(0))).add(wetAt(iN.clamp(int(0), int(nx - 1)), j.add(1).min(int(nz - 1)))).sub((a.x as F).mul(2));
      const wetDry = (a.x as F).add(lapX.mul((dt * WICK) / (cell * cell)).add(lapZ.mul(dt * WICK).div(dzj.mul(dzj)))).clamp(0, 1).mul(Math.exp(-dt / DRY)) as F;
      textureStore(dst.aux, ivec2(i, j), vec4(select(wetNow, float(1), wetDry), select(wetNow, float(1), (a.y as F).mul(Math.exp(-dt / FRESH))), strand, 0)).toWriteOnly();
    })() as unknown as { compute(n: number): unknown }).compute(nx * nz);

  // a chunk: SUB substeps, ping-pong A → B → A … (even, so the state ends in set 0)
  const chunk = Array.from({ length: SWASH_SUB }, (_, s) => stepKernel(sets[s % 2], sets[(s + 1) % 2], s));
  // rest: a still lake, dry above
  const restKernel = (Fn(() => {
    const i = int(instanceIndex.mod(nx));
    const j = int(instanceIndex.div(nx));
    const b = (textureLoad(bed, ivec2(i, j)) as V4).x as F;
    const h = max(b.negate(), 0) as F;
    const wet = select(h.greaterThan(H_WET), float(1), float(0));
    textureStore(sets[0].state, ivec2(i, j), vec4(h, 0, 0, 0)).toWriteOnly();
    textureStore(sets[0].aux, ivec2(i, j), vec4(wet, wet, 0, 0)).toWriteOnly();
  })() as unknown as { compute(n: number): unknown }).compute(nx * nz);
  // publish: (η, h, u, v) and (foam, stranded, wet, glaze)
  const publishKernel = (Fn(() => {
    const i = int(instanceIndex.mod(nx));
    const j = int(instanceIndex.div(nx));
    const c = textureLoad(sets[0].state, ivec2(i, j)) as V4;
    const a = textureLoad(sets[0].aux, ivec2(i, j)) as V4;
    const b = (textureLoad(bed, ivec2(i, j)) as V4).x as F;
    const h = c.x as F;
    textureStore(swashField.water, ivec2(i, j), vec4(h.add(b), h, velN(h, c.y as F), velN(h, c.z as F))).toWriteOnly();
    textureStore(swashField.marks, ivec2(i, j), vec4(c.w, a.z, a.x, a.y)).toWriteOnly();
  })() as unknown as { compute(n: number): unknown }).compute(nx * nz);

  let at: number | null = null;
  const stats = { chunks: 0, ms: 0 };
  swashField.rect.value.set(...rect);
  const sim: SwashSim = {
    rect,
    stats,
    update(renderer, t) {
      const t0 = performance.now();
      const plan = swashPlan(at, t);
      const per = SWASH_SUB * SWASH_DT;
      if (plan.reset) renderer.compute(restKernel as never);
      for (let n = plan.from; n < plan.to; n++) {
        uTime.value = n * per;
        renderer.compute(chunk as never);
      }
      if (plan.reset || plan.to !== at) renderer.compute(publishKernel as never);
      stats.chunks = plan.to - plan.from;
      stats.ms = performance.now() - t0;
      at = plan.to;
      swashField.active.value = 1;
    },
  };
  swashField.sim = sim;
  return sim;
}
