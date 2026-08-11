/**
 * Green-water sensor (§V27): decides WHEN the sea comes aboard over the bow,
 * and turns that event into deck-water `splash()` injections.
 *
 * §V27 is emphatic that this is event-driven and that passive always-on
 * splashing is forbidden, so the shape of this module is a latch, not an
 * emitter. It consumes the SAME signal as the bow spray — the cutwater slice
 * of §V8's hullContact — so spray, wake and deck water all agree about the
 * instant the stem buries, instead of three sensors disagreeing by a tick.
 *
 * WHY A BURIAL-RATE GATE, not immersion alone: hullContact measures the stem
 * wet on 53–60% of ticks at cruising speed. Gating on immersion + speed only
 * would therefore fire on most ticks — a passive emitter wearing an event's
 * clothing. What actually throws a sheet over the rail is the stem driving
 * UNDER: d(immersion)/dt. Immersion says the bow is in the water, the rate
 * says it is going through it.
 *
 * WHY σ-RELATIVE (§V36): "deep enough to ship water" is a property of the sea
 * state, not a number of metres. A 0.5 m absolute gate meant "a hard burial"
 * when it was written and would mean "every wave" after a swell retune — the
 * exact silent drift that cost §B.12 and the crest-foam gate before it.
 *
 * Engine-free and pure apart from the latch it owns, so the whole event
 * policy is pinned by vitest without a GPU.
 */
import type { DeckWaterParams } from '../params/deckwater';
import { deckUv, type DeckFrame } from './deckFrame';

/**
 * The cutwater slice of `HullContactResult` (src/sea-physics/hullContact),
 * declared structurally rather than imported — same convention foam/bowSpray
 * uses, and it keeps this module free of the physics import graph. Field
 * names and units match that module exactly.
 */
export interface CutwaterSample {
  /** false = the stem is clear of the water; no event is possible */
  inContact: boolean;
  /** immersion of the forward-most WET slice (m, ≥ 0) */
  depth: number;
  /** burial rate there (m/s, > 0 = driving under) */
  rate: number;
  /** ship-local z of the surface crossing — the effective bow offset this tick */
  localZ: number;
  /** hull half-breadth at the crossing (m) — how wide a sheet comes aboard */
  halfWidth: number;
}

export interface BowWaterSample {
  cutwater: CutwaterSample;
  /** hull speed over ground (m/s) */
  speed: number;
  /** live sea σ — `ocean.heightRms`, NOT amplitude (§V36) */
  seaSigma: number;
}

/** one injection for DeckWater.splash() — u across the beam, v aft → forward */
export interface DeckSplash {
  u: number;
  v: number;
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
  /** debug/HUD: strength 0..1 of the last event fired */
  readonly lastStrength: number;
}

export function createBowWaterSensor(): BowWaterSensor {
  let armed = true;
  let cooldown = 0;
  let lastStrength = 0;

  return {
    get armed() {
      return armed;
    },
    get lastStrength() {
      return lastStrength;
    },

    update(s, dt, p, f): DeckSplash[] {
      cooldown = Math.max(0, cooldown - (Number.isFinite(dt) ? dt : 0));
      const c = s.cutwater;

      // A stem that is touching nothing cannot ship water — and the moment it
      // lifts clear is the cleanest possible rearm: one event per burial.
      if (!c.inContact) {
        armed = true;
        return [];
      }

      // §V36 + §V28: gates live in units of the live sea, with the divisor
      // floored so a flat calm cannot turn every threshold into zero.
      const sigma = Math.max(p.sigmaFloor, Number.isFinite(s.seaSigma) ? s.seaSigma : 0);
      if (c.depth < p.rearmSigma * sigma) armed = true;
      if (!armed || cooldown > 0) return [];

      const immN = ramp01(c.depth, p.immersionSigma * sigma, p.immersionFullSigma * sigma);
      const speedN = ramp01(s.speed, p.speedThreshold, p.speedFull);
      const rateN = ramp01(c.rate, p.burialRate, p.burialRateFull);
      // all three, and all strictly positive: this is an AND of gates, so a
      // fast ship in a calm or a wallowing one in a gale both stay dry
      if (immN <= 0 || speedN <= 0 || rateN <= 0) return [];

      const strength = immN * speedN * rateN;
      armed = false;
      cooldown = Math.max(0, p.refractory);
      lastStrength = strength;
      return layOut(c, strength, p, f);
    },
  };
}

/**
 * Where the sheet lands. Green water does not arrive as a point: it comes
 * over the head rails as a band the width of the bow and runs aft, so the
 * event is laid out as a row of splats across the beam just abaft the stem.
 * A single splat read as a dropped bucket in early sizing.
 */
function layOut(
  c: CutwaterSample,
  strength: number,
  p: SensorParams,
  f: DeckFrame,
): DeckSplash[] {
  const count = Math.max(1, Math.min(MAX_SPLASH_SLOTS, Math.round(p.splashCount)));
  const margin = Math.min(0.45, Math.max(0, p.splashMargin));
  // v runs aft → forward. The crossing is at the WATERLINE, forward of and
  // below the deck; the water it throws lands abaft that, inboard of the
  // head rails.
  const [, vCross] = deckUv(0, c.localZ, f);
  const v = Math.min(1 - margin, Math.max(margin, vCross - p.splashSetback));

  // the sheet is as wide as the hull is at the crossing, not as wide as the
  // deck: a fine entry throws a narrow spout, a bluff bow a full-beam wall
  const halfBeam = Math.max(1e-6, (f.maxX - f.minX) / 2);
  const halfSpan = Math.min(0.5 - margin, ((c.halfWidth / halfBeam) * p.splashBeamSpread) / 2);
  const per = (p.splashVolume * strength) / count;
  if (!(per > 0)) return [];

  // the deck's centreline in u, which is only 0.5 when the frame is symmetric
  const [uCentre] = deckUv(0, 0, f);
  const out: DeckSplash[] = [];
  for (let i = 0; i < count; i++) {
    // centred row: a single splat sits on the centreline, otherwise spread
    const t = count === 1 ? 0 : (i / (count - 1)) * 2 - 1;
    out.push({ u: Math.min(1, Math.max(0, uCentre + t * halfSpan)), v, amount: per });
  }
  return out;
}
