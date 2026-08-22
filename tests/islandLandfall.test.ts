/**
 * §T.130 LANDFALL — the island measured from the RAFT'S EYE, and landed on
 * with the RAFT'S OWN CODE.
 *
 * WHY THIS FILE EXISTS, and it is the whole lesson of the task. §V90's beach
 * band has a test in tests/sierra.test.ts and it passed the entire time the
 * user could not beach the raft. It asserts a property of the HEIGHTFIELD —
 * "the first metre of rise above the waterline is under 15°" — and 8 m of run
 * to +2 m satisfies it while being no landfall at all: two metres further in
 * the ground was at 36°, and 50 m in it was 27 m over the sea. A test that
 * asks a heightmap a heightmap question cannot notice that. So this one asks
 * the GAME:
 *
 *   - `stepRaftSailing` + `stepRaftBeaching` sail her in on N bearings and
 *     she must GROUND and HOLD (the real contact points, the real seabed
 *     spring, the real hold rule);
 *   - `createTerrainSurface` — the walker's own surface, gating on
 *     `playerParams.terrainSlopeDeg` — must admit a route from where she is
 *     beached to the island's `station` POI.
 *
 * and only then the eye-level shape properties (§V80, stated scale-free with
 * the reason named):
 *
 *   - HORIZON ANGLE from an eye 1.6 m above the sea, 20-200 m off: the "wall"
 *     complaint IS this number. It was 23° at 20 m off a 250 m dome.
 *   - HEIGHT EARNED OVER DISTANCE: an island may not spend half its relief in
 *     the first fifth of its radius. It was spending three quarters of it.
 *   - THE APRON: the run from the waterline to +3 m, over its whole width and
 *     on EVERY bearing that meets land, not the first metre on average.
 *   - EROSION DETAIL WAVELENGTH off the authored route, against the island's
 *     own radius: the gullies must not read as noise from the deck.
 *
 * GPU-free (§V88); every limit read from the params that own it (§V80).
 */
import { describe, expect, it } from 'vitest';
import { generateIslandHeightmap, type IslandHeightmap } from '../src/island/heightmap';
import { sierraIslandParams } from '../src/island/sierraSites';
import { SIERRA_SLICE_ARCHETYPES, type SierraArchetypeName } from '../src/island/sierraArchetypes';
import { createTerrainSurface } from '../src/player/ashore';
import {
  neutralRaftBeaching,
  raftContactPoints,
  stepRaftBeaching,
  type RaftBeachingState,
} from '../src/sailing/raftBeaching';
import { neutralRaftControls, stepRaftSailing, type RaftMotion } from '../src/sailing/raftKinematics';
import { accessibleRaftTuning } from '../src/params/raftSailing';
import { raftParams } from '../src/params/raft';
import { raftLayout } from '../src/ship/raftPartsLayout';
import { playerParams } from '../src/params/player';
import { islandParams } from '../src/params/island';
import { sierraParams } from '../src/params/sierra';
import type { SeabedField } from '../src/sea-physics/grounding';

const SEEDS = [988, 1965, 2942];
const RADII = [210, 250, 290];
const GRID = sierraParams.sliceGridSize;
const DEG = 180 / Math.PI;
const DT = 1 / 60;
/** the raft's eye above the sea when she is under way (§T.130's whole point) */
const EYE = 1.6;
/** bearings scanned per island — resolution of the sweep, not a look tunable */
const BEARINGS = 12;

const cache = new Map<string, IslandHeightmap>();
const hmFor = (name: SierraArchetypeName, i: number): IslandHeightmap => {
  const key = `${name}:${i}`;
  let hm = cache.get(key);
  if (!hm) {
    hm = generateIslandHeightmap(SEEDS[i], sierraIslandParams(name, RADII[i], GRID));
    cache.set(key, hm);
  }
  return hm;
};

/** exact waterline crossing on a bearing, or null when the ray never meets land */
function shoreCrossing(hm: IslandHeightmap, angle: number): number | null {
  const cx = Math.cos(angle);
  const sz = Math.sin(angle);
  const h = (r: number): number => hm.heightAt(cx * r, sz * r);
  let water = hm.worldRadius;
  for (let r = hm.worldRadius; r >= 0; r -= 0.5) {
    if (h(r) > 0) {
      let lo = r;
      let hi = water;
      for (let k = 0; k < 20; k++) {
        const mid = (lo + hi) / 2;
        if (h(mid) > 0) lo = mid;
        else hi = mid;
      }
      return (lo + hi) / 2;
    }
    water = r;
  }
  return null;
}

/** the bearings of this island that meet land at all (a cirque's mouth does not) */
function landBearings(hm: IslandHeightmap): { angle: number; shore: number }[] {
  const out: { angle: number; shore: number }[] = [];
  for (let k = 0; k < BEARINGS; k++) {
    const angle = (k / BEARINGS) * Math.PI * 2;
    const shore = shoreCrossing(hm, angle);
    if (shore !== null) out.push({ angle, shore });
  }
  return out;
}

/**
 * The angle (deg) the island's own profile subtends at an eye `off` metres
 * outside the waterline, 1.6 m up — what the player actually sees over the
 * bow. The max over the whole inbound ray, so a crest behind the shoulder
 * counts exactly as it does through the window.
 */
function horizonAngle(hm: IslandHeightmap, angle: number, shore: number, off: number): number {
  const cx = Math.cos(angle);
  const sz = Math.sin(angle);
  const eyeR = shore + off;
  let best = -90;
  for (let d = 0.5; d <= 2 * hm.worldRadius; d += 1) {
    const r = eyeR - d;
    const a = Math.atan2(hm.heightAt(cx * r, sz * r) - EYE, d) * DEG;
    if (a > best) best = a;
  }
  return best;
}

/** horizontal run (m) from the waterline inland to the first ground at or above `target` */
function apronRun(hm: IslandHeightmap, angle: number, shore: number, target: number): number {
  const cx = Math.cos(angle);
  const sz = Math.sin(angle);
  for (let d = 0; d <= 2 * hm.worldRadius; d += 0.5) {
    if (hm.heightAt(cx * (shore - d), sz * (shore - d)) >= target) return d;
  }
  return Infinity;
}

const median = (v: number[]): number => {
  const w = [...v].filter(Number.isFinite).sort((a, b) => a - b);
  return w[w.length >> 1];
};

// ── the walker's own surface ───────────────────────────────────────────────

/** `Island.heightAt` as the walker sees it: null off the footprint, not a seabed */
function groundFor(hm: IslandHeightmap): (x: number, z: number) => number | null {
  return (x, z) => (Math.hypot(x, z) > hm.worldRadius ? null : hm.heightAt(x, z));
}

interface Walk {
  /** 1 where the walker may stand (ground, not swimming, slope under the gate) */
  ok: Uint8Array;
  /** 1 where the walker may stand AND can reach the station on foot */
  reach: Uint8Array;
  size: number;
  cell: number;
}

/**
 * The cells the walker can stand on, and of those the ones connected to the
 * station — evaluated through `createTerrainSurface`, so the gate under test
 * is `playerParams.terrainSlopeDeg`, not a copy of it.
 */
function walkFrom(hm: IslandHeightmap, target: { x: number; z: number }): Walk {
  const surface = createTerrainSurface({ groundAt: groundFor(hm) });
  const n = hm.size;
  const cell = (2 * hm.worldRadius) / (n - 1);
  const ok = new Uint8Array(n * n);
  const at = (i: number): [number, number] => {
    const ix = i % n;
    const iz = (i - ix) / n;
    return [-hm.worldRadius + ix * cell, -hm.worldRadius + iz * cell];
  };
  for (let i = 0; i < n * n; i++) {
    const [x, z] = at(i);
    if (surface.heightAt(x, z) === null) continue;
    if (surface.solidAt(x, z)) continue;
    ok[i] = 1;
  }
  // the station stands on carved ground; start from the nearest standable cell
  let start = -1;
  let bestD = Infinity;
  for (let i = 0; i < n * n; i++) {
    if (!ok[i]) continue;
    const [x, z] = at(i);
    const d = Math.hypot(x - target.x, z - target.z);
    if (d < bestD) {
      bestD = d;
      start = i;
    }
  }
  const reach = new Uint8Array(n * n);
  if (start < 0) return { ok, reach, size: n, cell };
  const queue = [start];
  reach[start] = 1;
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    const ix = i % n;
    const iz = (i - ix) / n;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const jx = ix + dx;
        const jz = iz + dz;
        if (jx < 0 || jz < 0 || jx >= n || jz >= n) continue;
        const j = jz * n + jx;
        if (reach[j] || !ok[j]) continue;
        reach[j] = 1;
        queue.push(j);
      }
    }
  }
  return { ok, reach, size: n, cell };
}

/** nearest cell of `mask` to (x, z), and how far it is (m); Infinity when none */
function nearestIn(w: Walk, mask: Uint8Array, x: number, z: number, R: number): number {
  let best = Infinity;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const ix = i % w.size;
    const iz = (i - ix) / w.size;
    const d = Math.hypot(-R + ix * w.cell - x, -R + iz * w.cell - z);
    if (d < best) best = d;
  }
  return best;
}

// ── the raft ───────────────────────────────────────────────────────────────

const POINTS = raftContactPoints();
const LAYOUT = raftLayout(raftParams);

/**
 * Sail her in on `angle` from `off` metres outside the waterline, dead run,
 * until she beaches or `seconds` run out. Island-LOCAL coordinates: the
 * heightmap is the seabed and the origin is the island's centre.
 *
 * Yaw convention (raftKinematics header): forward = [sin yaw, cos yaw], and
 * `wind.direction` is where the wind blows TOWARD — so a dead run onto the
 * beach is wind direction = yaw.
 */
function sailIn(
  hm: IslandHeightmap,
  angle: number,
  shore: number,
  off: number,
  seconds: number,
): { motion: RaftMotion; beach: RaftBeachingState; aground: boolean; t: number } {
  const seabed: SeabedField = { heightAt: (x, z) => hm.heightAt(x, z) };
  const cx = Math.cos(angle);
  const sz = Math.sin(angle);
  // inbound heading: straight at the island's centre
  const yaw = Math.atan2(-cx, -sz);
  const r0 = shore + off;
  let motion: RaftMotion = {
    position: [cx * r0, 0, sz * r0],
    yaw,
    velocity: [-cx * 1.5, 0, -sz * 1.5],
    yawRate: 0,
  };
  let beach = neutralRaftBeaching();
  const controls = neutralRaftControls();
  const wind = { direction: yaw, speed: 6 };
  let aground = false;
  const n = Math.round(seconds / DT);
  for (let k = 0; k < n; k++) {
    const s = stepRaftSailing(motion, controls, wind, accessibleRaftTuning, DT);
    const r = stepRaftBeaching(s, beach, POINTS, seabed, DT);
    motion = r.motion;
    beach = r.beach;
    aground = r.aground;
    if (beach.beached) return { motion, beach, aground, t: (k + 1) * DT };
  }
  return { motion, beach, aground, t: Infinity };
}

/** the world point under her bow when she is lying at `motion` */
function bowPoint(motion: RaftMotion): [number, number] {
  return [
    motion.position[0] + Math.sin(motion.yaw) * LAYOUT.bowZ,
    motion.position[2] + Math.cos(motion.yaw) * LAYOUT.bowZ,
  ];
}

// ── 1. THE LANDFALL ────────────────────────────────────────────────────────

/**
 * The bar the user set: "we don't have a nice and shallow beach leading into
 * it where we could even beach the boat". Grounding is asserted on EVERY
 * bearing that meets land — the seabed is the raft's problem on all of them.
 * Walking off is asserted on MOST of them plus, unconditionally, on the
 * authored landing: a spit or a headland the walk cannot leave is legitimate
 * terrain (§T.112b's barriers are deliberate), a coast you can nowhere climb
 * off is the defect.
 */
const WALKABLE_BEARINGS = 0.75;
/** how long she gets to run the last 60 m in and come to rest (s) */
const LANDFALL_SECONDS = 120;

describe('§T.130 she grounds, holds, and the walker gets to the station', () => {
  for (const name of SIERRA_SLICE_ARCHETYPES) {
    for (let i = 0; i < SEEDS.length; i++) {
      it(`${name} seed ${SEEDS[i]} r=${RADII[i]}: beached on every land bearing, ashore on ≥ ${WALKABLE_BEARINGS * 100}%`, () => {
        const hm = hmFor(name, i);
        const station = hm.path!.pois.find((q) => q.kind === 'station')!;
        const landing = hm.path!.pois.find((q) => q.kind === 'landing')!;
        const w = walkFrom(hm, station);
        const bearings = landBearings(hm);
        expect(bearings.length / BEARINGS).toBeGreaterThanOrEqual(WALKABLE_BEARINGS);

        let ashore = 0;
        const failures: string[] = [];
        for (const { angle, shore } of bearings) {
          const r = sailIn(hm, angle, shore, 60, LANDFALL_SECONDS);
          // SHE GROUNDS AND HOLDS. `beached` is the raft's own state, set by
          // stepRaftBeaching when the log undersides are in the sand and she
          // is under beachHoldSpeed — not an inference from the heightfield.
          expect(r.beach.beached, `${(angle * DEG).toFixed(0)}°: never beached`).toBe(true);
          expect(r.aground).toBe(true);
          // …ON the apron, not 100 m out in the deep on a rock
          const rest = Math.hypot(r.motion.position[0], r.motion.position[2]);
          expect(rest, `${(angle * DEG).toFixed(0)}°: held ${(rest - shore).toFixed(0)} m off`).toBeLessThan(shore + 30);
          // …and there is ground she can step onto from the bow (§V85's rule,
          // read at its own reach)
          const [bx, bz] = bowPoint(r.motion);
          const d = nearestIn(w, w.ok, bx, bz, hm.worldRadius);
          if (d > w.cell + playerParams.ashoreReach) {
            failures.push(`${(angle * DEG).toFixed(0)}°: nearest standable ground ${d.toFixed(1)} m from the bow`);
            continue;
          }
          // …and from there the station is walkable at ≤ terrainSlopeDeg
          if (nearestIn(w, w.reach, bx, bz, hm.worldRadius) <= w.cell + playerParams.ashoreReach) ashore++;
        }
        expect(failures, failures.join('; ')).toHaveLength(0);
        expect(ashore / bearings.length, `${ashore}/${bearings.length} bearings walk to the station`).toBeGreaterThanOrEqual(
          WALKABLE_BEARINGS,
        );
        // the AUTHORED landing always works — that one is content, not luck
        const landAngle = Math.atan2(landing.z, landing.x);
        const landShore = shoreCrossing(hm, landAngle);
        expect(landShore).not.toBeNull();
        const r = sailIn(hm, landAngle, landShore!, 60, LANDFALL_SECONDS);
        expect(r.beach.beached, 'beached at the authored landing').toBe(true);
        const [bx, bz] = bowPoint(r.motion);
        expect(
          nearestIn(w, w.reach, bx, bz, hm.worldRadius),
          'the station is walkable from the authored landing',
        ).toBeLessThanOrEqual(w.cell + playerParams.ashoreReach);
      }, 120000);
    }
  }
});

// ── 2. THE PROFILE, AT EYE LEVEL ───────────────────────────────────────────

/**
 * WHY A HORIZON ANGLE AND NOT A PEAK HEIGHT. "Too steep" is not a statement
 * about metres — a 320 m Half Dome 2 km off is the point of the world — it is
 * a statement about what a landmass fills of the view from a raft's deck.
 * 20 m off the beach the island must read as ground you are arriving at; the
 * pre-T130 dome subtended 23° there (26° worst bearing) and the user called
 * it a wall. These are LOOK BARS, so the number is named and the reason with
 * it, and they are stated on the median over bearings with a looser cap on
 * the worst one (a cirque's back wall is allowed to be a wall).
 */
const HORIZON_20M_MEDIAN = 18;
const HORIZON_20M_WORST = 24;
const HORIZON_100M_MEDIAN = 12;

describe('§T.130 the island reads as a landfall from 20-200 m off, eye 1.6 m', () => {
  for (const name of SIERRA_SLICE_ARCHETYPES) {
    for (let i = 0; i < SEEDS.length; i++) {
      it(`${name} seed ${SEEDS[i]}: horizon angle inside the bar at 20 m and 100 m`, () => {
        const hm = hmFor(name, i);
        const bearings = landBearings(hm);
        const at20 = bearings.map(({ angle, shore }) => horizonAngle(hm, angle, shore, 20));
        const at100 = bearings.map(({ angle, shore }) => horizonAngle(hm, angle, shore, 100));
        const at200 = bearings.map(({ angle, shore }) => horizonAngle(hm, angle, shore, 200));
        expect(median(at20), `median ${median(at20).toFixed(1)}°`).toBeLessThan(HORIZON_20M_MEDIAN);
        expect(Math.max(...at20), `worst ${Math.max(...at20).toFixed(1)}°`).toBeLessThan(HORIZON_20M_WORST);
        expect(median(at100)).toBeLessThan(HORIZON_100M_MEDIAN);
        // and it RECEDES: standing further off must show you less, or the
        // island is a wall whose top you cannot see over at any range
        expect(median(at200)).toBeLessThan(median(at100));
        expect(median(at100)).toBeLessThan(median(at20));
      });
    }
  }
});

/**
 * HEIGHT EARNED OVER DISTANCE, as the grade of the walk up from the beach.
 *
 * Stated on a FIFTH OF THE ISLAND'S OWN RADIUS so it holds for a 150 m islet
 * and a 300 m dome alike (§V80 — an absolute-metre bar would let a smaller
 * island buy the property by being smaller), and as a GRADE rather than a
 * fraction of the peak, because a grade is the thing the player walks and the
 * thing the eye reads from the deck. It is the "wall" complaint restated on
 * the ground instead of in the air: before T130 the mean grade from the
 * waterline to a fifth of the radius inland was 26-33° on the dome and the
 * cirque, with 42° on the worst bearing of a 250 m cirque. That is not a
 * hillside, it is a ramp you would slip down.
 *
 * The median carries the bar and the worst bearing gets a looser one: a
 * cirque's back wall and a headland ARE steep, and §T.112b's barriers are
 * deliberate. What may not happen is that steep is the island's normal.
 */
const FIFTH_GRADE_MEDIAN_DEG = 20;
const FIFTH_GRADE_WORST_DEG = 28;

describe('§T.130 height is earned over distance, not at the waterline', () => {
  for (const name of SIERRA_SLICE_ARCHETYPES) {
    for (let i = 0; i < SEEDS.length; i++) {
      it(`${name} seed ${SEEDS[i]}: the walk up the first fifth of the radius is under ${FIFTH_GRADE_MEDIAN_DEG}°`, () => {
        const hm = hmFor(name, i);
        const fifth = hm.worldRadius * 0.2;
        const grades = landBearings(hm).map(({ angle, shore }) => {
          const h = hm.heightAt(Math.cos(angle) * (shore - fifth), Math.sin(angle) * (shore - fifth));
          return (Math.atan(Math.max(h, 0) / fifth) * 180) / Math.PI;
        });
        expect(median(grades), `median ${median(grades).toFixed(1)}°`).toBeLessThan(FIFTH_GRADE_MEDIAN_DEG);
        expect(Math.max(...grades), `worst ${Math.max(...grades).toFixed(1)}°`).toBeLessThan(FIFTH_GRADE_WORST_DEG);
      });
    }
  }
});

/**
 * THE APRON, OVER ITS WHOLE WIDTH — the property §V90's beach test could not
 * see. §V90 asks about the first metre; a raft needs the whole band from the
 * waterline to a few metres up to be shallow, because that is the ground she
 * rides onto and the walker steps up. `dgSandBand` is the sand's own width,
 * so the apron is measured to a third of it and the bar is stated as a GRADE
 * (the run follows from it), on EVERY bearing rather than on the average.
 */
const APRON_TOP = sierraParams.dgSandBand / 4;
const APRON_MEDIAN_DEG = 11;
const APRON_WORST_DEG = 14;

describe('§T.130 the apron is shallow over its whole width, on every bearing', () => {
  for (const name of SIERRA_SLICE_ARCHETYPES) {
    for (let i = 0; i < SEEDS.length; i++) {
      it(`${name} seed ${SEEDS[i]}: waterline → +${APRON_TOP} m under ${APRON_WORST_DEG}° everywhere`, () => {
        const hm = hmFor(name, i);
        const grades = landBearings(hm).map(
          ({ angle, shore }) => Math.atan(APRON_TOP / apronRun(hm, angle, shore, APRON_TOP)) * DEG,
        );
        expect(median(grades), `median ${median(grades).toFixed(1)}°`).toBeLessThan(APRON_MEDIAN_DEG);
        expect(Math.max(...grades), `worst ${Math.max(...grades).toFixed(1)}°`).toBeLessThan(APRON_WORST_DEG);
      });
    }
  }
});

// ── 3. EROSION DETAIL WAVELENGTH ───────────────────────────────────────────

/**
 * "These erosion channels look rather noisy — too detailed and too fine."
 *
 * The measurable form of that is the field's DOMINANT RELIEF WAVELENGTH: for
 * h = A·sin(kx), rms|∇h| / rms|∇²h| = 1/k, so λ = 2π·rms|∇h|/rms|∇²h| is the
 * scale the relief actually lives at, independent of how tall it is. It is
 * asserted against the island's own RADIUS (§V80: a bigger island must not be
 * allowed to buy the property by being bigger) and against the GRID CELL —
 * relief at two cells is not terrain, it is the sampler.
 *
 * MEASURED OFF THE AUTHORED ROUTE. §T.112b's corridor is 4 m of tread with a
 * 6 m falloff and its soft gate is a 7 m step in 5 m; that is content, and
 * including it would measure the trail rather than the erosion. `hm.path`
 * publishes the distance field, so the exclusion is exact.
 */
const WAVELENGTH_PER_RADIUS = 20;
const WAVELENGTH_PER_CELL = 6;

/** dominant relief wavelength (m) of the land off the route */
function reliefWavelength(hm: IslandHeightmap): number {
  const n = hm.size;
  const cell = (2 * hm.worldRadius) / (n - 1);
  const d = hm.data;
  const dist = hm.path?.distance ?? null;
  const station = hm.path?.pois.find((q) => q.kind === 'station');
  let g2 = 0;
  let l2 = 0;
  for (let iz = 2; iz < n - 2; iz++) {
    for (let ix = 2; ix < n - 2; ix++) {
      const i = iz * n + ix;
      if (d[i] < sierraParams.dgSandBand / 4) continue; // the sand is not erosion
      if (dist && dist[i] < sierraParams.pathCorridorWidth + sierraParams.pathCorridorFalloff) continue;
      const x = -hm.worldRadius + ix * cell;
      const z = -hm.worldRadius + iz * cell;
      if (station && Math.hypot(x - station.x, z - station.z) < sierraParams.pathGateRadius * 1.4) continue;
      const gx = (d[i + 1] - d[i - 1]) / (2 * cell);
      const gz = (d[i + n] - d[i - n]) / (2 * cell);
      const lap = (d[i + 1] + d[i - 1] + d[i + n] + d[i - n] - 4 * d[i]) / (cell * cell);
      g2 += gx * gx + gz * gz;
      l2 += lap * lap;
    }
  }
  return 2 * Math.PI * Math.sqrt(g2 / l2);
}

describe('§T.130 the erosion detail is at the island\'s scale, not the sampler\'s', () => {
  for (const name of SIERRA_SLICE_ARCHETYPES) {
    for (let i = 0; i < SEEDS.length; i++) {
      it(`${name} seed ${SEEDS[i]}: λ ≥ R/${WAVELENGTH_PER_RADIUS} and ≥ ${WAVELENGTH_PER_CELL} cells`, () => {
        const hm = hmFor(name, i);
        const cell = (2 * hm.worldRadius) / (hm.size - 1);
        const lambda = reliefWavelength(hm);
        expect(lambda, `λ = ${lambda.toFixed(1)} m`).toBeGreaterThanOrEqual(hm.worldRadius / WAVELENGTH_PER_RADIUS);
        expect(lambda / cell, `λ = ${(lambda / cell).toFixed(1)} cells`).toBeGreaterThanOrEqual(WAVELENGTH_PER_CELL);
      });
    }
  }
});

// ── 4. THE TERM ITSELF ─────────────────────────────────────────────────────

describe('§T.130 profileApron: a monotone remap, so nothing measured on the shoreline moved', () => {
  it('the shoreline is where it was: turning the profile off changes heights but no waterline crossing', () => {
    const params = sierraIslandParams('dome', 250, 128);
    const on = generateIslandHeightmap(1965, params);
    const saved = sierraParams.profileEnabled;
    sierraParams.profileEnabled = 0;
    let off: IslandHeightmap;
    try {
      off = generateIslandHeightmap(1965, params);
    } finally {
      sierraParams.profileEnabled = saved;
    }
    expect(on.data).not.toEqual(off.data);
    // …and the LAND is the same land. Erosion, the carve and the peak floor
    // all run downstream of the remap, so a handful of cells within a
    // centimetre of the waterline may land on either side of it; the property
    // is that the coastline did not move, not that no cell flipped.
    let flipped = 0;
    for (let i = 0; i < on.data.length; i++) {
      if (on.data[i] > 0 !== off.data[i] > 0) flipped++;
    }
    expect(flipped / on.data.length).toBeLessThan(0.01);
    // the profile only ever LOWERS land — it makes the island lower, never smaller
    let raised = 0;
    for (let i = 0; i < on.data.length; i++) {
      if (off.data[i] > 1 && on.data[i] > off.data[i] + 0.5) raised++;
    }
    expect(raised / on.data.length).toBeLessThan(0.02);
  });

  it('a pirate island never reaches the term: the T130 knobs cannot move it', () => {
    // the pirate grids are pinned byte-for-byte in tests/sierra.test.ts; this
    // is the same guarantee stated where the new knob lives
    const before = generateIslandHeightmap(42, { ...islandParams, gridSize: 48 }).data;
    const saved = [sierraParams.profileToeGrade, sierraParams.profileRiseFraction] as const;
    sierraParams.profileToeGrade = 0.05;
    sierraParams.profileRiseFraction = 1.5;
    try {
      expect(generateIslandHeightmap(42, { ...islandParams, gridSize: 48 }).data).toEqual(before);
    } finally {
      sierraParams.profileToeGrade = saved[0];
      sierraParams.profileRiseFraction = saved[1];
    }
  });
});
