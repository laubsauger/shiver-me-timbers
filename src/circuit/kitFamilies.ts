/**
 * RACE ISLAND KIT (§T.187) — the terrain families of the speedboat circuits,
 * built on the sierra pipeline through `registerSierraFamily` (src/island).
 * Pure CPU, zero three imports: tests, the course builder and the page all
 * read the same functions.
 *
 * A pirate or sierra family describes a LANDMASS and lets the pipeline decide
 * what the water around it does (sunk open water, coast noise, the rim). A race
 * kit cannot: the water IS the track. A sandbar that must never ground a boat,
 * a drowned bench whose roofs must poke through by a metre, a rock platform
 * the lee chicane runs past — those are depths with contracts on them. So each
 * kit family authors ONE height field `H(x, z)` for land and water alike, and
 * splits it across the two sierra hooks:
 *
 *   landAt  = sink⁻¹(H)  above water: the family's land goes through the same
 *                        coast noise, beach apron, T130 profile, erosion,
 *                        granite/DG material, rocks and plants as a Sierra
 *                        island (§V94, §V95) — nothing re-implemented here.
 *   shape   → H          below water: pulled onto the authored depth with a
 *                        weight that is 1 wherever H ≤ −1 m and 0 on land, so
 *                        the bathymetry is exact where a contract lives
 *                        (bar crest, bench, corridor) and the shoreline stays
 *                        where both halves already agree.
 *
 * `sinkOpenWater` is inverted numerically (it is monotone with slope ≥ 1), so
 * the kit never duplicates its constants.
 *
 * Families:
 *   sandCay     a low dune cay along a curved spine, a shelving beach, and an
 *               optional detached sandbar ("The Bar") with a crest depth floor
 *   rockGarden  a granite whaleback knob, a boulder field awash on a shallow
 *               rock platform (the hazard edge that also shelters)
 *   drownedTown a flat valley bench at a set depth (Main Street's roofs stand
 *               on it) and a knoll that breaks the surface
 */
import type { IslandParams } from '../params/island';
import { fbm2Cpu } from '../terrain/noiseCpu';
import type { Feature } from '../island/archetypes';
import {
  isSierraFamilyRegistered,
  registerSierraFamily,
  sinkOpenWater,
  type KitArchetypeName,
  type SierraFamily,
  type SierraShape,
} from '../island/sierraArchetypes';

export type V2 = readonly [number, number];

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * sink⁻¹: the raw landmass whose `sinkOpenWater` is `h`. Bisection on a
 * function with slope ≥ 1, so 30 halvings of [0, h + 11] land far inside a
 * millimetre. Heights at or below the sink's floor map to 0 (the `shape` hook
 * owns everything that deep).
 */
export function unsink(h: number): number {
  const floor = sinkOpenWater(0);
  if (h <= floor) return 0;
  let lo = 0;
  let hi = Math.max(h - floor + 1, 1);
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) * 0.5;
    if (sinkOpenWater(mid) < h) lo = mid;
    else hi = mid;
  }
  return (lo + hi) * 0.5;
}

/** distance from p to a polyline, with the normalised arc parameter of the nearest point */
export function polylineDistance(pts: readonly V2[], x: number, z: number): { d: number; t: number; side: number } {
  let total = 0;
  const lens: number[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    lens.push(l);
    total += l;
  }
  let best = Infinity;
  let bestT = 0;
  let side = 0;
  let acc = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const ax = pts[i][0];
    const az = pts[i][1];
    const dx = pts[i + 1][0] - ax;
    const dz = pts[i + 1][1] - az;
    const l2 = Math.max(dx * dx + dz * dz, 1e-9);
    const s = clamp01(((x - ax) * dx + (z - az) * dz) / l2);
    const px = ax + dx * s;
    const pz = az + dz * s;
    const d = Math.hypot(x - px, z - pz);
    if (d < best) {
      best = d;
      bestT = (acc + s * lens[i]) / Math.max(total, 1e-9);
      side = Math.sign(dx * (z - az) - dz * (x - ax));
    }
    acc += lens[i];
  }
  return { d: best, t: bestT, side };
}

/** smooth max of two heights over `k` metres (same operator family as archetypes.smoothMax) */
function smax(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
}

/** a cheap deterministic value noise in [-1, 1] — authored ripples, not terrain detail */
function hashNoise(x: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fz = z - zi;
  const h = (i: number, j: number): number => {
    let n = (i * 374761393 + j * 668265263 + seed * 2147483647) | 0;
    n = (n ^ (n >>> 13)) * 1274126177;
    n = n ^ (n >>> 16);
    return ((n & 0xffff) / 0xffff) * 2 - 1;
  };
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  return lerp(lerp(h(xi, zi), h(xi + 1, zi), u), lerp(h(xi, zi + 1), h(xi + 1, zi + 1), u), v);
}

// ── specs ────────────────────────────────────────────────────────────────────

/** a detached sandbar: the crest never rises above −crestDepth */
export interface BarSpec {
  /** crest line, island-local metres */
  crest: readonly V2[];
  /** shallowest water over the crest (m, positive). THE contract: boats never ground here */
  crestDepth: number;
  /** extra depth the crest undulates by along its length (m) — so it is not a kerb */
  crestUndulation: number;
  /** half-width of the bar's back (m) at its middle; the swell side is wider, the lee side steeper */
  halfWidth: number;
  /** depth (m) of the sand shoal the bar rises from; it feathers out into the basin */
  shoalDepth: number;
  /**
   * §T.194 profile (defaults = the §T.187 bar): half-width multipliers of the
   * two flanks — `faceWidth` on the crest polyline's right-hand side (side ≤ 0),
   * (+swellDirection in Tower Reach), `backWidth` on the other — the
   * across-bar profile power, and the apron width (× halfWidth).
   */
  faceWidth?: number;
  backWidth?: number;
  profilePower?: number;
  apron?: number;
  /** sand-wave relief on the crest (m, only ever deepens it) */
  waveRelief?: number;
}

export interface SandCaySpec {
  kind: 'sandCay';
  /** dune crest polyline, island-local metres */
  spine: readonly V2[];
  /** land half-width at mid-spine (m); tapers to the tips */
  halfWidth: number;
  /** authored dune crest height (m) before the terrain pipeline */
  crestHeight: number;
  /** metres inland over which the beach rises to the crest */
  crestInland: number;
  /** basin floor (m, positive) — the depth the corridor and the footprint rim sit at */
  floorDepth: number;
  /** e-folding distance (m) of the underwater shelf off the beach */
  shelf: number;
  bar?: BarSpec;
  /**
   * §T.194: more bars off the same cay — a multi-bar system (an outer bar the
   * swell breaks on first, then the inner one), each with its own contract.
   */
  bars?: readonly BarSpec[];
}

/** every bar a sand cay carries, `bar` first */
export function cayBars(spec: SandCaySpec): BarSpec[] {
  return [...(spec.bar ? [spec.bar] : []), ...(spec.bars ?? [])];
}

export interface KnobSpec {
  x: number;
  z: number;
  /** half-axes (m) and axis (rad) of the whaleback's plan ellipse */
  a: number;
  b: number;
  axis: number;
  height: number;
}

export interface RockGardenSpec {
  kind: 'rockGarden';
  /** the granite whalebacks that break the surface (the first is the tallest) */
  knobs: readonly KnobSpec[];
  /** the boulder field + its platform: centre, half-axes (m), axis (rad) */
  garden: { x: number; z: number; a: number; b: number; axis: number };
  /** boulders in the field (seeded per island) */
  boulders: number;
  /** boulder footprint radius range (m) */
  boulderRadius: readonly [number, number];
  /** boulder top range (m relative to still water): negative = awash under */
  boulderTop: readonly [number, number];
  /** rock platform depth under the garden (m, positive) */
  platformDepth: number;
  floorDepth: number;
  shelf: number;
}

export interface DrownedTownSpec {
  kind: 'drownedTown';
  /** the hill that still breaks the surface (m) */
  knoll: { x: number; z: number; r: number; height: number };
  /** the valley bench the town stood on: centre, half-length along axis, half-width, depth (m, positive) */
  bench: { x: number; z: number; halfLength: number; halfWidth: number; axis: number; depth: number; edge: number };
  floorDepth: number;
  shelf: number;
}

export type KitSpec = SandCaySpec | RockGardenSpec | DrownedTownSpec;

/** an evaluated kit island: its authored height field and bookkeeping features */
export interface KitField {
  /** authored height (m, waterline 0) at an island-local point */
  heightAt(x: number, z: number): number;
  features: Feature[];
  /** authored land peak (m) */
  peak: number;
  axis: number;
  /**
   * §T.194: the authored field is the FINISHED land as well as the water — the
   * sierra pipeline's beach apron, T130 profile and coast noise would turn a
   * granite shore into a DG beach, so the `shape` hook pulls land onto it too.
   */
  exact?: boolean;
}

// ── fields ───────────────────────────────────────────────────────────────────

/**
 * The shelving water off a shore at signed distance `s` (m, + seaward):
 * 0 at the waterline, `floor` far out, with a beach grade of floor/shelf at
 * the line (30 m over 130 m ≈ 13° at the very line, easing within tens of metres).
 */
function shelfDepth(s: number, floor: number, shelf: number): number {
  return -floor * (1 - Math.exp(-Math.max(s, 0) / Math.max(shelf, 1e-3)));
}

/**
 * Chaikin corner cutting on an open polyline: a distance field to a polyline
 * with corners creases along each corner's bisector, and on a 5 m dune that
 * crease is a visible ridge line across the whole cay.
 */
export function chaikin(pts: readonly V2[], iterations: number): V2[] {
  let cur = [...pts];
  for (let k = 0; k < iterations; k++) {
    const next: V2[] = [cur[0]];
    for (let i = 0; i + 1 < cur.length; i++) {
      const a = cur[i];
      const b = cur[i + 1];
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    next.push(cur[cur.length - 1]);
    cur = next;
  }
  return cur;
}

/**
 * Domain warp (the shared CPU fbm, src/terrain/noiseCpu): every authored
 * outline in the kit is evaluated at a warped point, so a lens, an ellipse or
 * a bench edge never survives as the primitive it was drawn with.
 */
function warp(x: number, z: number, freq: number, amp: number, seed: number): V2 {
  const o = (seed % 1009) * 0.6180339;
  const wx = (fbm2Cpu(x * freq + o, z * freq + o * 1.7, 3) * 2 - 1) * amp;
  const wz = (fbm2Cpu(x * freq + o * 2.3 + 17.1, z * freq - o + 5.3, 3) * 2 - 1) * amp;
  return [x + wx, z + wz];
}

function sandCayField(spec: SandCaySpec, seed: number): KitField {
  const { halfWidth, crestHeight, crestInland, floorDepth, shelf } = spec;
  const spine = chaikin(spec.spine, 4);
  const land = (x0: number, z0: number): number => {
    const [x, z] = warp(x0, z0, 1 / 160, halfWidth * 0.22, seed);
    const { d, t, side } = polylineDistance(spine, x, z);
    // tips taper: a cay is a lens, not a sausage
    const taper = Math.pow(Math.sin(Math.PI * clamp01(t)), 0.55);
    const hw = halfWidth * (0.25 + 0.75 * taper) * (1 + 0.12 * hashNoise(t * 6, 1.5, seed + 11));
    const s = d - hw; // signed distance to the shoreline, + seaward
    if (s >= 0) return shelfDepth(s, floorDepth, shelf);
    // across the cay, q = 0 at the waterline, 1 on the spine
    const q = clamp01(-s / Math.max(hw, 1e-3));
    // a FOREDUNE on the swell side (`side` +1: upswell of a spine laid down the swell frame's +v),
    // a swale behind it, a lower back dune toward the lee beach — the barrier-island section
    const fore = side > 0 ? Math.exp(-(((q - 0.3) / 0.14) ** 2)) : 0;
    const body = 0.5 * smoothstep(0.05, 0.75, q);
    const hum = 0.75 + 0.35 * fbm2Cpu(x0 * 0.02 + 3.1, z0 * 0.02 + seed * 0.001, 4);
    const rise = smoothstep(0, crestInland / Math.max(hw, 1e-3), q);
    return crestHeight * (0.5 + 0.5 * taper) * hum * rise * Math.min(body + 0.55 * fore, 1);
  };
  const barList = cayBars(spec).map((b) => ({ spec: b, crest: chaikin(b.crest, 3) }));
  const barHeight = (bar: BarSpec, barCrest: V2[], x0: number, z0: number, base: number): number => {
    const [x, z] = warp(x0, z0, 1 / 240, bar.halfWidth * 0.35, seed + 7);
    const b = polylineDistance(barCrest, x, z);
    // a bar is broad in the middle, fades into the shoal at its ends, and is ASYMMETRIC:
    // one flank long and gentle, the other short and steep (`faceWidth` / `backWidth`)
    const mid = Math.sin(Math.PI * clamp01(b.t));
    const w = bar.halfWidth * (0.55 + 0.45 * mid) * (b.side > 0 ? (bar.backWidth ?? 1.35) : (bar.faceWidth ?? 0.7));
    const endFade = smoothstep(0, 0.2, b.t) * smoothstep(1, 0.8, b.t);
    // crest undulation and sand waves only ever DEEPEN the crest: crestDepth is a floor on water
    const waves = 0.5 + 0.5 * Math.sin((x0 * 0.6 + z0 * 0.8) / 5.5 + hashNoise(x0 * 0.01, z0 * 0.01, seed) * 2);
    const crest = bar.crestDepth + bar.crestUndulation * fbm2Cpu(b.t * 5 + 1.3, seed * 0.001 + 2.7, 3) + (bar.waveRelief ?? 0.3) * waves;
    const crestHere = lerp(bar.shoalDepth, crest, endFade);
    const across = Math.pow(clamp01(b.d / Math.max(w, 1e-3)), bar.profilePower ?? 1.25);
    const onBar = -lerp(crestHere, bar.shoalDepth, smoothstep(0, 1, across));
    // the shoal the bar sits on, feathering out into the basin over a wide apron
    const apron = smoothstep(w, w + bar.halfWidth * (bar.apron ?? 2.6), b.d);
    return lerp(onBar, base, apron);
  };
  const heightAt = (x0: number, z0: number): number => {
    const base = land(x0, z0);
    if (barList.length === 0 || base >= 0) return base;
    let h = base;
    for (const { spec: bar, crest } of barList) {
      const lifted = smax(h, barHeight(bar, crest, x0, z0, base), 2);
      // THE CONTRACT: nothing about a bar ever brings the seabed above −crestDepth
      h = h < -bar.crestDepth ? Math.min(lifted, -bar.crestDepth) : Math.max(h, Math.min(lifted, h));
    }
    return h;
  };
  // bookkeeping features: one ridge per spine segment (bay scans, hm.features)
  const features: Feature[] = [];
  for (let i = 0; i + 1 < spec.spine.length; i++) {
    features.push({
      kind: 'ridge', x: spec.spine[i][0], z: spec.spine[i][1], x2: spec.spine[i + 1][0], z2: spec.spine[i + 1][1],
      radius: halfWidth, height: crestHeight, power: 1,
    });
  }
  const a = spine[0];
  const bpt = spine[spine.length - 1];
  // The field already authors the beach grade, foredune and shelf. Applying
  // the generic beach apron again halves Tower Cay's low-beach elevation.
  return { heightAt, features, peak: crestHeight, axis: Math.atan2(bpt[1] - a[1], bpt[0] - a[0]), exact: true };
}

/** one granite block in a rock garden */
export interface Boulder {
  x: number;
  z: number;
  /** long half-axis (m), elongation (≥ 1) and plan axis (rad) */
  r: number;
  elong: number;
  axis: number;
  /** top height (m) at the block centre; a tilted slab rises `tilt` m per metre along `tiltAxis` */
  top: number;
  tilt: number;
  tiltAxis: number;
}

/**
 * A seeded boulder list. Blocks come in CLUSTERS (a garden is the debris of a
 * few outcrops, not a Poisson scatter — the same measurement that sent the
 * palms into groves, §V43), elongated slabs with tilted tops.
 */
export function rockGardenBoulders(spec: RockGardenSpec, rng: () => number): Boulder[] {
  const g = spec.garden;
  const ca = Math.cos(g.axis);
  const sa = Math.sin(g.axis);
  const inEll = (): V2 => {
    const ang = rng() * Math.PI * 2;
    const rad = Math.sqrt(rng()) * 0.85;
    return [Math.cos(ang) * rad * g.a, Math.sin(ang) * rad * g.b];
  };
  const clusters = Array.from({ length: Math.max(4, Math.round(spec.boulders / 9)) }, inEll);
  const out: Boulder[] = [];
  for (let i = 0; i < spec.boulders; i++) {
    const c = clusters[Math.floor(rng() * clusters.length) % clusters.length];
    // Box–Muller around the cluster
    const u1 = Math.max(rng(), 1e-6);
    const u2 = rng();
    const gr = Math.sqrt(-2 * Math.log(u1));
    const lx = c[0] + Math.cos(2 * Math.PI * u2) * gr * g.a * 0.12;
    const lz = c[1] + Math.sin(2 * Math.PI * u2) * gr * g.b * 0.2;
    const r = lerp(spec.boulderRadius[0], spec.boulderRadius[1], Math.pow(rng(), 1.8));
    const top = lerp(spec.boulderTop[0], spec.boulderTop[1], Math.pow(rng(), 1.4));
    out.push({
      x: g.x + lx * ca - lz * sa,
      z: g.z + lx * sa + lz * ca,
      r,
      elong: 1 + rng() * 0.9,
      axis: rng() * Math.PI,
      top,
      tilt: rng() * 0.25,
      tiltAxis: rng() * Math.PI * 2,
    });
  }
  return out;
}

const ellipseU = (x: number, z: number, cx: number, cz: number, a: number, b: number, axis: number): number => {
  const dx = x - cx;
  const dz = z - cz;
  const c = Math.cos(axis);
  const s = Math.sin(axis);
  return Math.hypot((dx * c + dz * s) / a, (-dx * s + dz * c) / b);
};

/** CPU Worley in cell units: [F1, F2, id of the nearest cell ∈ [0,1)] — the fractured waterline's blocks */
function worley(x: number, z: number, seed: number): [number, number, number] {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  let f1 = 9;
  let f2 = 9;
  let id = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i;
      const cz = zi + j;
      const jx = hash01(cx, cz, seed) * 0.9 + 0.05;
      const jz = hash01(cx, cz, seed + 1) * 0.9 + 0.05;
      const d = Math.hypot(cx + jx - x, cz + jz - z);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = hash01(cx, cz, seed + 2);
      } else if (d < f2) f2 = d;
    }
  }
  return [f1, f2, id];
}

/** integer-lattice hash in [0, 1) */
function hash01(i: number, j: number, seed: number): number {
  let n = (i * 374761393 + j * 668265263 + seed * 1442695041) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}

/** smooth exfoliation steps: quantise to `rise`, riser over the top `riser` fraction (sierraArchetypes' terraceSteps law) */
function sheetSteps(h: number, rise: number, riser: number): number {
  const k = h / rise;
  const step = Math.floor(k);
  const f = k - step;
  return (step + smoothstep(1 - riser, 1, f)) * rise;
}

/**
 * §T.194 ROCK GARDEN — granite whalebacks as the sea left them (the Bohuslän /
 * Maine skerry read, Martel 2006 for the sheets):
 *
 *   form     a glaciated whaleback `(1 − u²)^k`, but a ROCHE MOUTONNÉE: the
 *            lee end's outline is pulled in, so the stoss is long and polished
 *            and the lee is a short plucked face
 *   sheets   exfoliation steps 1.1-2.2 m tall, their phase warped so no step
 *            is a contour line, blended in above the splash zone
 *   joints   two clefts sets ~75° apart, patchy, a metre-plus deep — what cuts
 *            a knob into blocks from a boat's eye
 *   waterline a Worley block field in the ±3 m band: blocks stand proud or
 *            drop by up to half a metre with a groove between them, the
 *            fractured shore the surf works on
 *   garden   the warped rock platform and the clustered boulder field (§T.187)
 *
 * Every term below −2.5 m fades out, so the corridor, the platform depth and
 * the boulders' hazard tops (the course contracts) are untouched.
 */
function rockGardenField(spec: RockGardenSpec, rng: () => number, seed: number): KitField {
  const g = spec.garden;
  const boulders = rockGardenBoulders(spec, rng);
  const knobs = spec.knobs.map((k, ki) => {
    const lee = hash01(ki, 11, seed) < 0.5 ? -1 : 1;
    const jointA = k.axis + 0.35 + 0.5 * hash01(ki, 12, seed);
    return {
      ...k,
      lee,
      ca: Math.cos(k.axis),
      sa: Math.sin(k.axis),
      rise: 1.1 + 1.1 * hash01(ki, 13, seed),
      spacingA: 16 + 10 * hash01(ki, 14, seed),
      spacingB: 22 + 12 * hash01(ki, 15, seed),
      jA: [Math.cos(jointA), Math.sin(jointA)] as const,
      jB: [Math.cos(jointA + 1.3), Math.sin(jointA + 1.3)] as const,
    };
  });
  const heightAt = (x0: number, z0: number): number => {
    // the platform edge is a reef line, not an ellipse: a strong warp on its outline
    const [gx, gz] = warp(x0, z0, 1 / 110, Math.min(g.a, g.b) * 0.55, seed + 3);
    const ug = ellipseU(gx, gz, g.x, g.z, g.a, g.b, g.axis);
    const [kx, kz] = warp(x0, z0, 1 / 70, 16, seed + 5);
    let shore = Infinity;
    let crown = -Infinity;
    for (let ki = 0; ki < knobs.length; ki++) {
      const k = knobs[ki];
      const along = ((kx - k.x) * k.ca + (kz - k.z) * k.sa) / k.a;
      const leeW = smoothstep(0.1, 0.9, along * k.lee);
      const u = ellipseU(kx, kz, k.x, k.z, k.a, k.b, k.axis) * (1 + 0.42 * leeW);
      const minAxis = Math.min(k.a, k.b) / (1 + 0.42 * leeW);
      shore = Math.min(shore, (u - 1) * minAxis);
      if (u >= 1.2) continue;
      // the form runs on under the water as a steep flank, not a tangent toe
      let dome = u < 1 ? k.height * Math.pow(1 - u * u, 1.05) : -(u - 1) * minAxis * 0.55;
      // flank steepening toward the waterline: the last metres drop, they do not shelve
      dome -= 1.4 * smoothstep(0.55, 1, u);
      // exfoliation sheets above the splash zone, phase-warped
      const sw = (fbm2Cpu(x0 / 23 + ki * 5.3, z0 / 23 - ki * 2.1, 3) - 0.5) * k.rise * 1.3;
      const stepped = sheetSteps(dome + sw, k.rise, 0.34) - sw;
      dome += (stepped - dome) * 0.8 * smoothstep(0.4, 2.2, dome);
      // joint clefts, patchy, fading out under the water
      const gate = smoothstep(-2.5, 0.5, dome);
      if (gate > 0) {
        const cleft = (dir: readonly [number, number], spacing: number, salt: number): number => {
          const c = (x0 * dir[0] + z0 * dir[1]) / spacing + (fbm2Cpu(x0 / 41 + salt, z0 / 41, 2) - 0.5) * 0.35;
          const dist = Math.abs(c - Math.round(c)) * spacing;
          // a joint opens in stretches, not as a ruled line across the whole knob
          const patch = smoothstep(0.55, 0.7, fbm2Cpu(x0 / 45 - salt, z0 / 45 + salt, 3));
          const depth = 0.6 + 1.1 * fbm2Cpu(x0 / 19 + salt * 2, z0 / 19, 2);
          return depth * (1 - smoothstep(0.5, 2.2, dist)) * patch;
        };
        dome -= gate * Math.max(cleft(k.jA, k.spacingA, 3.7 + ki), cleft(k.jB, k.spacingB, 9.1 + ki));
      }
      crown = Math.max(crown, dome);
    }
    let h = shelfDepth(shore, spec.floorDepth, spec.shelf);
    const platform = -spec.platformDepth + 2.2 * (fbm2Cpu(x0 * 0.03 + 7.7, z0 * 0.03, 4) - 0.5);
    h = smax(h, lerp(-spec.floorDepth, platform, smoothstep(1.3, 0.85, ug)), 2);
    if (crown > -Infinity) h = Math.max(h, crown);
    // the fractured waterline: blocks proud or dropped, a groove between them
    const band = smoothstep(-2.5, -1, h) * smoothstep(3.5, 1.5, h);
    if (band > 0) {
      const [f1, f2, id] = worley(x0 / 5.5, z0 / 5.5, seed + 71);
      const groove = 1 - smoothstep(0.05, 0.22, f2 - f1);
      h += band * ((id - 0.45) * 1.1 - 0.55 * groove) * smoothstep(0, 0.1, f1 + 0.1);
    }
    for (const bd of boulders) {
      const reach = bd.r * bd.elong * 1.35;
      if (Math.abs(x0 - bd.x) > reach || Math.abs(z0 - bd.z) > reach) continue;
      // irregular plan: an elongated ellipse, its radius broken by a per-block noise
      const ang = Math.atan2(z0 - bd.z, x0 - bd.x);
      const rough = 1 + 0.28 * hashNoise(Math.cos(ang) * 2.2 + bd.x, Math.sin(ang) * 2.2 + bd.z, seed + 31);
      const u = ellipseU(x0, z0, bd.x, bd.z, bd.r * bd.elong * rough, bd.r * rough, bd.axis);
      if (u >= 1) continue;
      const core = smoothstep(1, 0.6, u);
      const along = (x0 - bd.x) * Math.cos(bd.tiltAxis) + (z0 - bd.z) * Math.sin(bd.tiltAxis);
      const top = bd.top + along * bd.tilt + 0.35 * hashNoise(x0 * 0.4, z0 * 0.4, seed + 37);
      h = Math.max(h, lerp(h, top, core));
    }
    return h;
  };
  const features: Feature[] = [
    ...spec.knobs.map((k): Feature => ({ kind: 'cone', x: k.x, z: k.z, radius: Math.max(k.a, k.b), height: k.height, power: 0.8 })),
    ...boulders.map((b): Feature => ({ kind: 'sheer', x: b.x, z: b.z, radius: b.r * b.elong, height: b.top, power: 1 })),
  ];
  return { heightAt, features, peak: spec.knobs[0].height, axis: spec.knobs[0].axis, exact: true };
}

function drownedTownField(spec: DrownedTownSpec, seed: number): KitField {
  const { knoll, bench } = spec;
  const c = Math.cos(bench.axis);
  const s = Math.sin(bench.axis);
  const heightAt = (x0: number, z0: number): number => {
    // the bench is a river terrace: its outline warped, its edge a long bank, not a slab
    const [x1, z1] = warp(x0, z0, 1 / 300, bench.halfWidth * 0.8, seed + 13);
    const [x, z] = warp(x1, z1, 1 / 90, bench.halfWidth * 0.2, seed + 41);
    const dx = x - bench.x;
    const dz = z - bench.z;
    const along = dx * c + dz * s;
    const across = -dx * s + dz * c;
    const qx = Math.max(Math.abs(along) - bench.halfLength, 0);
    const qz = Math.max(Math.abs(across) - bench.halfWidth, 0);
    const out = Math.hypot(qx, qz);
    const floor = -spec.floorDepth + 3 * (fbm2Cpu(x0 * 0.008 + 1.9, z0 * 0.008, 3) - 0.5);
    // the old street grade (0.4 %) and a little ground relief; the town stood on level ground
    const benchLevel = -bench.depth + 0.4 * (fbm2Cpu(x0 * 0.04, z0 * 0.04 + 4.4, 3) - 0.5) - 0.004 * along;
    let h = lerp(benchLevel, floor, smoothstep(0, bench.edge, out));
    // the old creek behind the east-side houses: a meandering groove a couple of metres deep
    const dAcross = (-(x0 - bench.x) * s + (z0 - bench.z) * c) - bench.halfWidth * 0.7 - 12 * Math.sin((along + seed % 97) / 55);
    h -= 2.2 * smoothstep(12, 0, Math.abs(dAcross)) * smoothstep(bench.halfLength * 1.1, bench.halfLength * 0.6, Math.abs(along));
    // the knoll: a warped, two-lobed hill with its own shelf down onto the bench
    const [kx, kz] = warp(x0, z0, 1 / 50, knoll.r * 0.18, seed + 19);
    const dk = Math.min(Math.hypot(kx - knoll.x, kz - knoll.z) / knoll.r, Math.hypot(kx - knoll.x - knoll.r * 0.55, kz - knoll.z + knoll.r * 0.4) / (knoll.r * 0.6));
    const shore = (dk - 1) * knoll.r;
    if (shore < 0) h = Math.max(h, knoll.height * Math.pow(1 - dk * dk, 1.2));
    else h = smax(h, shelfDepth(shore, spec.floorDepth, spec.shelf * 0.35), 1.5);
    return h;
  };
  const features: Feature[] = [{ kind: 'cone', x: knoll.x, z: knoll.z, radius: knoll.r, height: knoll.height, power: 0.8 }];
  return { heightAt, features, peak: knoll.height, axis: bench.axis };
}

export function kitField(spec: KitSpec, rng: () => number, seed: number): KitField {
  switch (spec.kind) {
    case 'sandCay':
      return sandCayField(spec, seed);
    case 'rockGarden':
      return rockGardenField(spec, rng, seed);
    case 'drownedTown':
      return drownedTownField(spec, seed);
  }
}

// ── the sierra hook ──────────────────────────────────────────────────────────

/**
 * The water weight: 1 where the authored field is ≥ 1 m under, 0 on land. The
 * band between is where the pipeline's beach apron and the authored shelf
 * meet, both near 0, so neither moves the shoreline much.
 */
export function waterWeight(h: number): number {
  return 1 - smoothstep(-1, 1, h);
}

/**
 * A family for ONE authored island. Kit islands are laid out by hand around a
 * course, so a family is per island (its name carries the circuit and the
 * island id); the seeded parts (boulders, hummocks) still come from the
 * island's own rng stream.
 */
export function kitFamily(spec: KitSpec, seed: number): SierraFamily {
  // the field is rebuilt per build (the rng draws belong to that build)
  return {
    peak: () => unsink(spec.kind === 'sandCay' ? spec.crestHeight : spec.kind === 'rockGarden' ? spec.knobs[0].height : spec.knoll.height),
    build(rng, _extent, peak): SierraShape {
      const field = kitField(spec, rng, seed);
      // the pipeline asks for the same point three times per cell (landAt for the
      // field, shape, the uplift sweep): one evaluation, remembered (§T.194 bake cost)
      let cx = NaN;
      let cz = NaN;
      let ch = 0;
      const heightAt = (x: number, z: number): number => {
        if (x !== cx || z !== cz) {
          cx = x;
          cz = z;
          ch = field.heightAt(x, z);
        }
        return ch;
      };
      return {
        features: field.features,
        meta: { name: 'kit:' as KitArchetypeName, axis: field.axis, terraceAzimuth: field.axis, terraceCount: 0, iceAzimuth: 0 },
        peak,
        landAt: (x, z) => unsink(heightAt(x, z)),
        shape: (h, _land, x, z) => {
          const target = heightAt(x, z);
          const w = field.exact ? 1 : waterWeight(target);
          return w > 0 ? h + (target - h) * w : h;
        },
      };
    },
  };
}

/**
 * Register a kit island and return its archetype name. The name must carry
 * everything the family depends on (circuit, island id, seed): a name that is
 * already registered is taken to BE this island and is not re-registered.
 */
export function registerKitIsland(name: KitArchetypeName, spec: KitSpec, seed: number): KitArchetypeName {
  if (isSierraFamilyRegistered(name)) return name;
  const fam = kitFamily(spec, seed);
  registerSierraFamily(name, {
    peak: fam.peak,
    build(rng, extent, peak, blend, p) {
      const shape = fam.build(rng, extent, peak, blend, p);
      shape.meta.name = name;
      return shape;
    },
  });
  return name;
}

/**
 * Per-family build params (the kit's `sierraOverrides`). Low cays get a quiet
 * coast (granite coast noise is ±4 m and would shatter a 5 m dune into
 * islets); the rim sits at the basin floor so the footprint edge is not a
 * submerged kerb across the corridor.
 */
export function kitOverrides(spec: KitSpec, gridSize: number): Partial<IslandParams> & { erosion?: 'full' | 'shapeOnly' } {
  const common: Partial<IslandParams> = {
    headlandCount: 0,
    seaStackCount: 0,
    terraceRadius: 0,
    structureSettlements: 0,
    structureHutCount: 0,
    lagoonDepth: 0,
    rimStart: 0.9,
    rimDepth: spec.floorDepth,
    skirtDepth: spec.floorDepth + 4,
    beachLandGuard: 60,
    featureExtent: 0.9,
    gridSize,
  };
  switch (spec.kind) {
    case 'sandCay':
      return {
        ...common,
        noiseSlope: 0.03,
        noiseOctaves: 3,
        coastNoiseSlope: 0.025,
        beachBandWidth: 6,
        peakHeight: spec.crestHeight,
        minPeakHeight: spec.crestHeight * 0.7,
        rockCount: 0,
        cliffCount: 0,
      };
    case 'rockGarden':
      return {
        ...common,
        // the authored field carries its own sheets and joints; the erosion
        // stage's beach guard and debris would sand the granite over (§T.194)
        erosion: 'shapeOnly',
        noiseSlope: 0.08,
        noiseOctaves: 3,
        coastNoiseSlope: 0.05,
        beachBandWidth: 4,
        peakHeight: spec.knobs[0].height,
        minPeakHeight: spec.knobs[0].height * 0.8,
        // §T.194: the granite is the kit's own angular blocks (kitDecor.ts), not the
        // round pirate boulders these counts used to (fail to) configure
        rockCount: 0,
        cliffCount: 0,
      };
    case 'drownedTown':
      return {
        ...common,
        noiseSlope: 0.05,
        noiseOctaves: 3,
        coastNoiseSlope: 0.03,
        beachBandWidth: 5,
        peakHeight: spec.knoll.height,
        minPeakHeight: spec.knoll.height * 0.75,
        rockCount: 0,
        cliffCount: 0,
      };
  }
}
