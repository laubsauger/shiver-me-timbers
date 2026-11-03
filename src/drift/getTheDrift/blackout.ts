/**
 * LIGHTS OUT's shutdown, grid region by grid region (the 2026-11-03 review of the master: "the lights should turn off
 * in a more interesting way, so it's more visible that this is actually a global shutdown. More like country by
 * country … And fill in a bit of the pure-darkness moment so it's not so long"). Until then the flood's front put the
 * cities out behind it in ~45 km clusters (lifeLayers.ts floodFront): from a few hundred km up it read as a smooth wipe,
 * and every light in view was out by 240.7 s, leaving the planet unlit for ~12 s to the dawn's glow (measured on the
 * 56e951c master: the dome's lower front holds its black level from ~240 s to ~253.5 s).
 *
 * Now each place belongs to a UNIT — a country, or one of a big country's grid regions — from Natural Earth's borders
 * (scripts/drift-earth-grid.py: public/drift/earth/grid-units.png, gridUnits.ts), and a unit goes out whole, as a
 * failing grid does:
 *   the cascade  the units in view go in the order the flood's front reaches their lights' centroids (FRONT_KEYS:
 *                the far limb first, toward the audience), so the order is still the water's — but spread over the
 *                cascade (CASCADE) partly by the front's own times, mostly by their rank: seen from 450–600 km up,
 *                the ground near the limb is so foreshortened that the front crosses Italy, Germany, the Low Countries
 *                and eastern France in under a second (the first schedule, at the front's times: ten big units on
 *                236.02 s at once — a wipe again), and spread by their light alone the thin band at the limb took the
 *                first half of the cascade while the broad ground in front (Spain, the French south-west) stood lit
 *                until 238 s and then all went in two (the first review clip). The big ones (LO_BIG of the box's
 *                light or more) go on the score's onsets in the decay of the 235.1 s hit (LO_STEPS), one to an onset,
 *                and on moments made between the onsets when there are more of them — a big region at a time, never
 *                two together — and the small ones between, each jittered by its own hash. Units out of view go at
 *                the front's own time
 *   the stutter  before it dies a unit dips 0–3 times (slowly: a dip every 0.5–0.85 s, under 2 Hz; it never strobes)
 *   holding on   a few named units hold on a moment longer (LO_HOLD), and a few cells of every unit (params loEmbers)
 *                keep a dim light for a while after it
 *   generators   a few cities (LO_GENERATORS) go dark with their region and come back half a second later, dim and
 *                warm — on generators — and die one by one on the soft pulses of the score's dip (LO_EMBERS), the
 *                last of them on 250.35 s: the planet is fully dark for ~1.6 s before the 252.3 s hit starts the dawn
 * Every gain is a pure function of the front's clock (s since it left the far limb), as the front's was.
 */
import type { GetTheDriftParams } from '../../params/getTheDrift';
import { GRID_UNITS } from './gridUnits';
import { frontArrival } from './lifeLayers';

/** s from the flood's start (241.0 s of the show): the onsets in the decay of the score's hit at 235.05 s — 236.02,
 * 236.85, 238.17, 238.92 and 240.0 s (drift_audio.wav, offset 0: spectral flux 2.6–4.9 σ over its local median; the
 * hit's own 7.4 σ). The big units go on these */
export const LO_STEPS: readonly number[] = [-5.95, -4.98, -4.15, -2.83, -2.08, -1.0];
/** s from the flood's start: the score's soft pulses in its dip — 242.4, 245.25, 247.04, 249.2 s (7–15 dB over the
 * dip's −30 dB in 64 ms) — and the faint one at 250.35 s (+5 dB) before the dawn's hit at 252.3 s: the generators die
 * on them (lamp.ts LO_PULSES is the same pulses, to a tenth) */
export const LO_EMBERS: readonly number[] = [1.4, 4.25, 6.04, 8.2, 9.35];
/** share of the box's light from which a unit is BIG and goes on a step of the score (France's five regions are
 * 0.8–2.9%, Belgium 1.9%, northern Italy 4.7%, southern England 4.3%, Switzerland 0.5%): six in view, for the decay's
 * five free onsets (at 1.5% there were eleven, and the moments made between the onsets for them came 0.1 s apart) */
export const LO_BIG = 0.02;
/** s: a small unit's jitter about its place in the cascade, either way; one out of view, about the front's time */
const JITTER = 0.15;
const JITTER_OUT = 0.3;
/** the ground the dome sees through the cascade (deg: lat, lon, radius; the scratch harness on the approved path:
 * 235–241 s, from the dome's front edge over the Bay of Biscay to the limb over the Po plain, Denmark at the left
 * and Tunisia at the right), and the arc (deg) from the front's origin under which the ground is beyond the far limb
 * when the front leaves it (Italy's north, the first in view, is 14° from it) */
const VIEW: [number, number, number] = [45, 2, 18];
const LIMB_DEG = 13;
/** s from the flood's start: the cascade of the units in view, from the hit to the decay's last onset and a little */
const CASCADE: [number, number] = [-5.9, -0.4];
/** the share of a unit's place in the cascade that is its rank (the rest its front time) */
const RANK_SHARE = 0.7;
/** share of the box's light under which a unit in view takes no place of its own in the cascade (it goes at the
 * front's time: the microstates, the Channel Islands) */
const MIN_LIGHT = 5e-4;
/** s a unit takes to go out: a blink (6 frames), not a fade — "blink off as units" */
export const UNIT_FADE = 0.2;
/** the stutter: s per dip (its range), how deep (its range) */
const DIP_S: [number, number] = [0.5, 0.85];
const DIP_DEPTH: [number, number] = [0.45, 0.85];
/** how many dips a unit makes before it dies, picked by its hash: a third none, the rest 1–3 */
const DIPS = [0, 0, 0, 1, 1, 1, 2, 2, 3];
/**
 * Units that hold on a moment longer: [name in gridUnits.ts, s from the flood's start it dies, dips]. Chosen from what
 * the dome's lower front sees then (tests/getTheDriftLightsOut.test.ts holds them in view): central Spain ("Spain
 * 3/5", Madrid, the brightest light low in front) on the decay's strongest onset, 240.0 s; south-west France ("France
 * 3/5", Bordeaux to Limoges, ahead) just after, at 240.8 s; Catalonia–Aragon–Valencia ("Spain 5/5", Barcelona under the
 * front-right) on the first pulse of the dip, 242.4 s.
 */
export const LO_HOLD: ReadonlyArray<readonly [string, number, number]> = [
  ['Spain 3/5', -1.0, 2],
  ['France 3/5', -0.2, 2],
  ['Spain 5/5', 1.4, 3],
];
/**
 * Cities on generators: [name, lat, lon (deg), radius (km), s from the flood's start it dies, dips]. Each goes dark
 * with its unit and comes back dim (params loGenGain) half a second later, warmer, and dies on a pulse of the dip
 * (LO_EMBERS) — the last of them, Toulouse, on 250.35 s, after a small final cascade (Limoges and Clermont on 249.2 s,
 * Albi between). All in the dome's lower front at their time, 3–20° up within 45° of straight ahead (the test holds it).
 */
export const LO_GENERATORS: ReadonlyArray<readonly [string, number, number, number, number, number]> = [
  ['Lyon', 45.76, 4.84, 22, 1.4, 2],
  ['Marseille', 43.3, 5.4, 20, 1.4, 1],
  ['Paris', 48.86, 2.35, 35, 4.25, 2],
  ['Bordeaux', 44.84, -0.58, 20, 4.25, 2],
  ['Montpellier', 43.61, 3.88, 16, 6.04, 2],
  ['Barcelona', 41.39, 2.17, 22, 6.04, 3],
  ['Limoges', 45.83, 1.26, 12, 8.2, 1],
  ['Clermont-Ferrand', 45.78, 3.08, 14, 8.2, 2],
  ['Albi', 43.93, 2.15, 10, 8.75, 1],
  ['Toulouse', 43.6, 1.44, 20, 9.35, 3],
];
/** s after its unit has gone that a generator city's light is back (a cough, then it catches) */
export const GEN_CATCH: [number, number] = [0.25, 0.75];
/** s a generator city or an ember takes to go out (a little slower than a whole grid: a failing generator) */
export const GEN_FADE = 0.35;
/** s an ember holds on after its unit at least, and the pulse (LO_EMBERS) the last of them die by */
export const EMBER_FROM = 0.4;
export const EMBER_TO = 0;
/** 256 unit slots (grid-units.png is 8-bit; 0 is the open sea, which the front's own clusters put out) */
export const UNIT_SLOTS = 256;

export interface Blackout {
  /** per unit id: out (s of the front's clock), dips, s per dip, dip depth */
  units: Float32Array;
  /** per generator: the city's place (unit, the planet's frame: x lon 0, y lon 90°E, z north), its radius (km: lifeLayers.ts measures the chord, which keeps its precision where 1 − cos does not) */
  genAt: Float32Array;
  /** per generator: out (s of the front's clock), dips, s per dip, dip depth */
  gens: Float32Array;
  /** the front's clock when the last embers are out (s): LO_EMBERS[EMBER_TO] */
  embersOut: number;
}

/** a hash 0..1 of an integer and a salt (CPU only: the schedule's choices) */
const hash = (i: number, salt: number): number => {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
};
const unitVec = (lat: number, lon: number): [number, number, number] => {
  const la = (lat * Math.PI) / 180;
  const lo = (lon * Math.PI) / 180;
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
};

let cache: { key: string; b: Blackout } | null = null;

/** the shutdown's schedule for these params (memoised on the ones it depends on) */
export function blackout(p: GetTheDriftParams): Blackout {
  const key = [p.loFront, p.loFrontLen, p.loOriginLat, p.loOriginLon].join();
  if (cache?.key === key) return cache.b;
  const o = unitVec(p.loOriginLat, p.loOriginLon);
  // flood-start s to the front's clock
  const clock = (s: number): number => s - p.loFront;
  const steps = LO_STEPS.map(clock);
  const units = new Float32Array(UNIT_SLOTS * 4);
  // (slot 0, the sea, and any slot with no unit: never out by this schedule)
  for (let i = 0; i < UNIT_SLOTS; i++) units[i * 4] = 1e4;
  const v = unitVec(VIEW[0], VIEW[1]);
  const arc = (a: number[], b: number[]): number => (Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * 180) / Math.PI;
  const all = GRID_UNITS.map(([id, name, lat, lon, , light]) => {
    const c = unitVec(lat, lon);
    const deg = arc(c, o);
    return { id, name, light, front: frontArrival(deg, p.loFrontLen), seen: deg >= LIMB_DEG && arc(c, v) < VIEW[2] };
  });
  // the units in view with lights enough to see (not the Vatican, Jersey, the Faeroes), in the front's order, spread
  // over the cascade: RANK_SHARE by their rank (each its own moment), the rest by the front's time (the dome's own pace)
  // (the held units take no place: they have their own time, below)
  const seen = all.filter((u) => u.seen && u.light >= MIN_LIGHT && !LO_HOLD.some((h) => h[0] === u.name)).sort((a, b) => a.front - b.front);
  const [c0, c1] = CASCADE.map(clock);
  const [f0, f1] = [seen[0]?.front ?? 0, seen[seen.length - 1]?.front ?? 1];
  const at = new Map<number, number>();
  const placed = seen.map((u, i) => c0 + (c1 - c0) * ((1 - RANK_SHARE) * ((u.front - f0) / Math.max(1e-6, f1 - f0)) + (RANK_SHARE * i) / Math.max(1, seen.length - 1)));
  // THE BIG ONES' MOMENTS: the score's steps no held unit takes, and while there are fewer of them than big units, the
  // widest gap (to the cascade's end) halved, jittered — so each big region has its own moment, on the score where it
  // can be, never two together (the limb's band alone holds nine of them); handed out in the water's order, each the
  // nearest to its place that leaves enough for the ones after it
  const big = seen.map((u, i) => ({ u, t: placed[i] })).filter(({ u }) => u.light >= LO_BIG);
  const slots = steps.filter((x) => !LO_HOLD.some((h) => Math.abs(clock(h[1]) - x) < 1e-6)).map((x) => Math.max(0, x));
  slots.sort((a, b) => a - b);
  while (slots.length < big.length) {
    const ends = [...slots, c1];
    let w = 0;
    for (let j = 1; j < ends.length - 1; j++) if (ends[j + 1] - ends[j] > ends[w + 1] - ends[w]) w = j;
    const mid = (ends[w] + ends[w + 1]) / 2 + (hash(slots.length, 6) - 0.5) * 0.3 * (ends[w + 1] - ends[w]);
    slots.splice(w + 1, 0, mid);
  }
  let from = 0;
  big.forEach(({ u, t }, i) => {
    let best = from;
    for (let j = from; j <= slots.length - (big.length - i); j++) if (Math.abs(slots[j] - t) < Math.abs(slots[best] - t)) best = j;
    at.set(u.id, slots[best]);
    from = best + 1;
  });
  // the small ones at their places, jittered
  seen.forEach((u, i) => {
    if (!at.has(u.id)) at.set(u.id, placed[i] + (hash(u.id, 1) - 0.5) * 2 * JITTER);
  });
  for (const { id, name, front } of all) {
    let out = at.get(id) ?? front + (hash(id, 1) - 0.5) * 2 * JITTER_OUT;
    let dips = DIPS[Math.floor(hash(id, 2) * DIPS.length)];
    const hold = LO_HOLD.find((h) => h[0] === name);
    if (hold) {
      out = clock(hold[1]);
      dips = hold[2];
    }
    // nothing stirs before the front leaves the limb on the hit: the first big units go on it, their dips after
    out = Math.max(0, out);
    const per = DIP_S[0] + hash(id, 3) * (DIP_S[1] - DIP_S[0]);
    dips = Math.min(dips, Math.floor(out / per));
    units.set([out, dips, per, DIP_DEPTH[0] + hash(id, 4) * (DIP_DEPTH[1] - DIP_DEPTH[0])], id * 4);
  }
  const genAt = new Float32Array(LO_GENERATORS.length * 4);
  const gens = new Float32Array(LO_GENERATORS.length * 4);
  LO_GENERATORS.forEach(([, lat, lon, km, out, dips], i) => {
    genAt.set([...unitVec(lat, lon), km], i * 4);
    gens.set([clock(out), dips, 0.7, 0.6], i * 4);
  });
  const b = { units, genAt, gens, embersOut: clock(LO_EMBERS[EMBER_TO]) };
  cache = { key, b };
  return b;
}

/** 0..1 a unit's lights at the front's clock `c` (s): its dips, then out over UNIT_FADE from `out` — the CPU twin of
 * lifeLayers.ts unitGate, for the tests */
export function unitGain(c: number, out: number, dips: number, per: number, depth: number): number {
  const x = (c - (out - dips * per)) / per;
  const dip = x > 0 && x < dips ? depth * (0.5 - 0.5 * Math.cos(2 * Math.PI * x)) : 0;
  const k = Math.min(1, Math.max(0, (c - out) / UNIT_FADE));
  return (1 - dip) * (1 - k * k * (3 - 2 * k));
}
