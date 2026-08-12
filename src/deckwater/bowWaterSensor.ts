/**
 * Green-water sensor (§V27): decides WHEN the sea comes aboard, WHERE along
 * the hull it lands, and how much — then hands the deck-water solve a set of
 * `splash()` injections and lets the Mei transport do the rest.
 *
 * §V27 is emphatic that this is event-driven and that passive always-on
 * splashing is forbidden, so the shape of this module is a latch, not an
 * emitter. It consumes the SAME signal as the bow spray — §V8's hullContact —
 * so spray, wake and deck water all agree about the instant the hull buries.
 *
 * WHY PER-SLICE, not one row at the stem (user: "not really modulated by
 * where we're actually impacting… it's happening along the whole length of
 * the ship in the same kind of variation"): hullContact does not just publish
 * a single cutwater. It publishes `sliceDepth`/`sliceRate` for every station
 * bow→stern, and per-station depths port and starboard. Water comes aboard
 * exactly where the hull is driving under RIGHT NOW — forward and on the
 * buried side when she pitches into a sea, along the lee rail when she rolls
 * down — and injecting a uniform row instead throws that whole signal away.
 * Each burying slice gets its own splat, weighted by its own burial rate and
 * placed on its own buried side; the solve then runs it aft and to leeward.
 *
 * WHY A BURIAL-RATE GATE, not immersion alone: hullContact measures the stem
 * wet on 53–60% of ticks at cruising speed. Gating on immersion + speed only
 * would therefore fire on most ticks — a passive emitter wearing an event's
 * clothing. What throws a sheet over the rail is the hull driving UNDER:
 * d(immersion)/dt. Immersion says it is in the water, the rate says it is
 * going through it.
 *
 * WHY σ-RELATIVE (§V36): "deep enough to ship water" is a property of the sea
 * state, not a number of metres. An absolute gate meant "a hard burial" when
 * it was written and would mean "every wave" after a swell retune — the exact
 * silent drift that cost §B.12 and the crest-foam gate before it.
 *
 * Engine-free and pure apart from the latch it owns, so the whole event
 * policy is pinned by vitest without a GPU.
 */
import type { DeckWaterParams } from '../params/deckwater';
import { deckUv, type DeckFrame } from './deckFrame';

/**
 * The slice arrays of `HullContactResult` (src/sea-physics/hullContact),
 * declared structurally rather than imported — the same convention
 * foam/bowSpray uses, keeping this module out of the physics import graph.
 * Field names and units match that module exactly, so main.ts passes the
 * `hullContact` object itself.
 */
export interface HullContactSlices {
  /** any part of the hull in the water at all — false = fully airborne */
  inContact: boolean;
  /** ship-space z per slice, bow-most first */
  readonly sliceZ: ArrayLike<number>;
  /** centreline immersion per slice (m); > 0 under water */
  readonly sliceDepth: ArrayLike<number>;
  /** d(depth)/dt per slice (m/s); > 0 burying */
  readonly sliceRate: ArrayLike<number>;
  /** hull half-breadth per slice (m) — how wide a sheet comes aboard there */
  readonly sliceHalfWidth: ArrayLike<number>;
  /**
   * Per-STATION immersion (m). `buildWaterlineStations` emits a port/starboard
   * pair per slice in order, so slice s is stations 2s (port, x < 0) and
   * 2s+1 (starboard). Their difference is which rail is buried — the thing
   * that decides which side of the deck takes the water.
   */
  readonly depth: ArrayLike<number>;
}

export interface BowWaterSample {
  hull: HullContactSlices;
  /** hull speed over ground (m/s) */
  speed: number;
  /** live sea σ — `ocean.heightRms`, NOT amplitude (§V36) */
  seaSigma: number;
}

/** one injection for DeckWater.splash() — u across the beam, v aft → forward */
export interface DeckSplash {
  u: number;
  v: number;
  /** peak added water depth at the splat centre, metres */
  amount: number;
}

/**
 * Uniform-array capacity in the inflow pass (inflowPass.MAX_SPLASHES).
 * Duplicated as a plain number rather than imported so this module stays free
 * of the TSL import graph and runs in a bare vitest process; the test
 * `never emits more splats than the shader has slots` pins the two together.
 */
const MAX_SPLASH_SLOTS = 8;

/** 0 below `from`, 1 at/above `to`, linear between; floored divisor (§V28) */
function ramp01(x: number, from: number, to: number): number {
  if (!Number.isFinite(x)) return 0;
  const span = Math.max(1e-6, to - from);
  return Math.min(1, Math.max(0, (x - from) / span));
}

type SensorParams = Pick<
  DeckWaterParams,
  | 'immersionSigma'
  | 'immersionFullSigma'
  | 'rearmSigma'
  | 'sigmaFloor'
  | 'speedThreshold'
  | 'speedFull'
  | 'burialRate'
  | 'burialRateFull'
  | 'refractory'
  | 'gateFloor'
  | 'splashVolume'
  | 'splashCount'
  | 'splashSetback'
  | 'splashMargin'
  | 'splashBeamSpread'
>;

export interface BowWaterSensor {
  /**
   * One tick. Returns the splashes to inject — EMPTY on the overwhelming
   * majority of ticks, by construction. `dt` only runs the refractory clock.
   */
  update(s: BowWaterSample, dt: number, p: SensorParams, f: DeckFrame): DeckSplash[];
  /** debug/HUD: is the sensor ready to fire again? */
  readonly armed: boolean;
  /** debug/HUD: strength 0..1 of the strongest slice in the last event */
  readonly lastStrength: number;
}

export function createBowWaterSensor(): BowWaterSensor {
  let armed = true;
  let cooldown = 0;
  let lastStrength = 0;
  /** the hardest sample of the burial currently developing (peak detector) */
  let peakStrength = 0;
  let peakHits: { slice: number; strength: number }[] | null = null;
  let peakFrame: { hull: HullContactSlices; sigma: number } | null = null;

  return {
    get armed() {
      return armed;
    },
    get lastStrength() {
      return lastStrength;
    },

    update(s, dt, p, f): DeckSplash[] {
      cooldown = Math.max(0, cooldown - (Number.isFinite(dt) ? dt : 0));
      const hull = s.hull;

      // A hull touching nothing cannot ship water — and the moment it lifts
      // clear is the cleanest possible rearm: one event per burial.
      if (!hull.inContact) {
        armed = true;
        // drop any half-built burial: the sea it belonged to is behind us, and
        // firing it on the next contact would land the wrong wave's water
        peakStrength = 0;
        peakHits = null;
        peakFrame = null;
        return [];
      }

      // §V36 + §V28: gates live in units of the live sea, with the divisor
      // floored so a flat calm cannot turn every threshold into zero.
      const sigma = Math.max(p.sigmaFloor, Number.isFinite(s.seaSigma) ? s.seaSigma : 0);
      const speedN = ramp01(s.speed, p.speedThreshold, p.speedFull);

      const n = Math.min(
        hull.sliceZ.length,
        hull.sliceDepth.length,
        hull.sliceRate.length,
        hull.sliceHalfWidth.length,
      );
      // Which slices are working water THIS instant, and how hard. Computed
      // before the latch check so the rearm can see a quiet hull.
      const hits: { slice: number; strength: number }[] = [];
      let deepest = 0;
      for (let i = 0; i < n; i++) {
        const depth = hull.sliceDepth[i];
        if (Number.isFinite(depth)) deepest = Math.max(deepest, depth);
        const immN = ramp01(depth, p.immersionSigma * sigma, p.immersionFullSigma * sigma);
        const rateN = ramp01(hull.sliceRate[i], p.burialRate, p.burialRateFull);
        // An AND of GATES — a fast ship in a calm and a wallowing one in a
        // gale both stay dry — but once they are open the AMOUNT is carried
        // by how deep she buried, which is the sea standing above the rail.
        // Multiplying three 0..1 ramps instead collapsed a real burial to 0.4%
        // of a sheet (measured: 0.2 mm of water), so the gates lift off a
        // floor rather than scaling the event to nothing.
        const open = immN > 0 && rateN > 0 && speedN > 0;
        const lift = (n: number) => p.gateFloor + (1 - p.gateFloor) * n;
        const strength = open ? immN * lift(rateN) * lift(speedN) : 0;
        if (strength > 0) hits.push({ slice: i, strength });
      }

      // hysteresis on the whole hull, not per slice: she has to come back up
      // before the next sea can count as a new event
      if (deepest < p.rearmSigma * sigma) armed = true;

      hits.sort((a, b) => b.strength - a.strength);
      const now = hits.length > 0 ? hits[0].strength : 0;

      // PEAK DETECT, not edge trigger. Firing on the first tick the gates open
      // samples the burial at its weakest instant — immersion and rate are
      // both barely over their thresholds there, and a genuine sea was landing
      // 8 mm of water instead of 30. So the burial is tracked while it builds
      // and the event is emitted on the tick it starts easing off, carrying
      // the deepest sample seen. That is also when the sheet physically
      // arrives: just after she stops going down.
      if (armed && cooldown <= 0 && now > 0 && now > peakStrength) {
        peakStrength = now;
        peakHits = hits;
        peakFrame = { hull, sigma };
        return []; // still going down — wait for the top
      }
      // strictly `>` above, so a burial held at CONSTANT strength still fires on
      // the next tick rather than waiting forever for a fall that never comes
      if (peakHits === null || peakFrame === null || !armed || cooldown > 0) {
        if (now <= 0) {
          peakStrength = 0;
          peakHits = null;
          peakFrame = null;
        }
        return [];
      }

      // past the top: fire the peak sample
      const fired = peakHits;
      const frame = peakFrame;
      lastStrength = peakStrength;
      peakStrength = 0;
      peakHits = null;
      peakFrame = null;
      armed = false;
      cooldown = Math.max(0, p.refractory);
      // strongest first, then truncate: with more burying slices than shader
      // slots, the hardest impacts are the ones that must survive
      const kept = fired.slice(0, Math.max(1, Math.min(MAX_SPLASH_SLOTS, Math.round(p.splashCount))));
      return kept.flatMap((hit) => layOut(frame.hull, hit.slice, hit.strength, p, f));
    },
  };
}

/**
 * Where one slice's water lands. Not a point and not the full beam: a band as
 * wide as the hull is THERE, offset toward whichever rail is actually buried,
 * and set back from the waterline crossing because the sea comes over the
 * rail and lands inboard of it.
 */
function layOut(
  hull: HullContactSlices,
  slice: number,
  strength: number,
  p: SensorParams,
  f: DeckFrame,
): DeckSplash[] {
  const amount = p.splashVolume * strength;
  if (!(amount > 0)) return [];
  const margin = Math.min(0.45, Math.max(0, p.splashMargin));

  const z = hull.sliceZ[slice];
  if (!Number.isFinite(z)) return [];
  const [, vSlice] = deckUv(0, z, f);
  // abaft the crossing: water comes over the rail and runs aft, it does not
  // appear ahead of the station that shipped it
  const v = Math.min(1 - margin, Math.max(margin, vSlice - p.splashSetback));

  // which rail is down? port station is 2s, starboard 2s+1 (see the interface)
  const port = hull.depth[slice * 2];
  const stbd = hull.depth[slice * 2 + 1];
  const halfBeam = Math.max(1e-6, (f.maxX - f.minX) / 2);
  const halfWidth = Math.max(0, hull.sliceHalfWidth[slice] ?? 0);
  let lean = 0;
  if (Number.isFinite(port) && Number.isFinite(stbd)) {
    // normalised by the deeper of the two so this is "how one-sided", not
    // "how deep" — a hull buried evenly must not lean either way
    const scale = Math.max(Math.abs(port), Math.abs(stbd), 1e-6);
    lean = Math.min(1, Math.max(-1, (stbd - port) / scale));
  }
  const [uCentre] = deckUv(0, 0, f);
  const spread = Math.min(0.5 - margin, (halfWidth / halfBeam) * p.splashBeamSpread * 0.5);
  const u = Math.min(1 - margin, Math.max(margin, uCentre + lean * spread));
  return [{ u, v, amount }];
}
