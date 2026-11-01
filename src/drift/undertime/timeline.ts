/**
 * Undertime beat timeline — a PURE function of act time (§cine: shots must re-render frame-exact).
 *
 * Every value the field, the sky and the camera read comes from here, so a frame is fully decided by `t`.
 * Values are continuous across beat boundaries (tests/undertimeTimeline.test.ts): a cut in density or light
 * at a boundary would read as a pop on a dome, where the whole field of view changes at once.
 *
 * Direction (drift-narrative/undertime/direction.md): silence → overwhelming → silence → one thing →
 * everything.
 *
 *   first   U0  black; one hero pair overhead, its light shell sweeps the dome — the first light
 *   arise   U1  pairs ignite, a few then everywhere, until the dome boils
 *   cool    U2  time itself slows: fewer, slower, longer pairs; the field turns; text windows
 *   wave    U3  an annihilation front sweeps front → zenith → back; nothing is born behind it
 *   remain  U4  darkness; one warm grain in front, then a few more; text
 *   zoom    U5  pull back through orders of magnitude; the grains are seen to lie on a web
 *   gather  U6  the web's knots ignite as the first stars; the signature
 *
 * TWO CLOCKS. `t` is act time (the audience's). `clock` is the field's own physics time, which runs slower
 * than act time from the cooling on — "time slows" — so pairs move, curl and die slower without any state.
 * It is the closed-form integral of its rate, so it stays a pure function of t.
 */
import type { DriftParams } from '../../params/drift';
import { domeBasis, type Vec3 } from '../../cine/domeMaster';
import { frontFracCpu } from './front';

export const BEATS = ['first', 'arise', 'cool', 'wave', 'remain', 'zoom', 'gather'] as const;
export type Beat = (typeof BEATS)[number] | 'end';

export interface UndertimeState {
  beat: Beat;
  /** 0..1 progress inside the current beat (1 at 'end') */
  u: number;
  /** s, the field's physics time (slows from the cooling on) */
  clock: number;
  /** field-s per act-s right now */
  clockRate: number;
  /** 0..1 fraction of pair slots alive */
  pairDensity: number;
  /** multiplier on each flash's brightness */
  flashGain: number;
  /** 0..1 gain on the haze annihilations leave (the light that fills the dome) */
  glow: number;
  /** wave front: field time it starts, its rate (field-s per act-s) and its act-time length */
  waveClock0: number;
  waveRate: number;
  waveLength: number;
  /** 0..1 how far the wave front has swept, as its angle from the dome front over π (waveSweep: it rolls
   * in slowly from the front horizon, crosses over the audience fast, settles behind) */
  wave: number;
  /** 0..1 TENSION before the front (waveEnvelope): rises, accelerating, over the last `waveBuild` s of the
   * cooling, holds as the front rises, gone by the wave's end */
  build: number;
  /** rad, the most the front pulls the field toward itself right now (the lensing; 0 outside the build and wave) */
  lens: number;
  /** 0..1 the front's CREST: its light at its broadest, as it crosses over the audience (rises, holds, falls) */
  crest: number;
  /** 0..1 how bright the front itself burns: moderate as it rises from the horizon, full by the time it reaches
   * the focus zone and over the audience */
  frontGain: number;
  /** 0..1 the hero grain in front */
  heroGrain: number;
  /** 0..1 how far the other grains have appeared */
  grains: number;
  /** linear scale of the world about the hero grain: 1 = native, 10^-zoomDecades at the end of the zoom */
  scale: number;
  /** 0..1 how far the first stars have ignited */
  stars: number;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const smooth = (x: number): number => {
  const k = clamp01(x);
  return k * k * (3 - 2 * k);
};
/** ∫0^x smooth(s) ds, for x in [0, 1] */
const smoothIntegral = (x: number): number => {
  const k = clamp01(x);
  return k * k * k - (k * k * k * k) / 2;
};
const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;

/**
 * 0..1 position under a TRAPEZOID velocity: smooth ramps of `ramp` (fraction of the beat) at each end and a
 * constant rate between. For the zoom this is the log of scale, so the pull-back's optic flow is constant
 * through the middle and its peak rate is as low as the beat allows (smoothstep would peak at 1.5×).
 */
export function plateau(x: number, ramp: number): number {
  const k = clamp01(x);
  const r = Math.min(0.5, Math.max(1e-6, ramp));
  const area = 1 - r;
  if (k < r) return (r * smoothIntegral(k / r)) / area;
  if (k > 1 - r) return 1 - (r * smoothIntegral((1 - k) / r)) / area;
  return (r / 2 + (k - r)) / area;
}

/**
 * THE WAVE'S PACE: the front's angle from the dome front (over π) at wave progress k. It rolls in from the front
 * horizon, ACCELERATES up the front sky into the zenith — fastest right over the audience — then releases and settles
 * behind them. Built as the integral of a speed profile, sin(πk)^1.3 (eased at both ends, its peak at k = ½, the
 * zenith), times an optional dip of depth `stall` and width 0.12 at k = ½, tabulated once per stall.
 * (Until then it was smoothstep(k): fastest exactly over the audience. The 2026-10-30 story note then asked for the
 * front HELD over the audience, a stall of 0.72: its peak speed came at ~52° up and it had slowed to 38 % of it by
 * the zenith. The 2026-11-01 note: "it kind of loses its swoosh a bit in the end before reaching the top" — so no
 * stall by default: the speed rises all the way up, 70 % of its peak in the focus zone, all of it at the zenith, the
 * same 41.5 s there and the same peak of ~44°/s. `waveStall` can still bring a hold back.)
 */
export const WAVE_STALL = 0;
const SWEEP_N = 1024;
let sweepFor = NaN;
let sweepTab = new Float64Array(SWEEP_N + 1);
function sweepTable(stall: number): Float64Array {
  if (stall === sweepFor) return sweepTab;
  const t = new Float64Array(SWEEP_N + 1);
  const v = (k: number): number => Math.sin(Math.PI * k) ** 1.3 * (1 - stall * Math.exp(-(((k - 0.5) / 0.12) ** 2)));
  for (let i = 1; i <= SWEEP_N; i++) t[i] = t[i - 1] + (v((i - 1) / SWEEP_N) + v(i / SWEEP_N)) / (2 * SWEEP_N);
  for (let i = 0; i <= SWEEP_N; i++) t[i] /= t[SWEEP_N];
  sweepFor = stall;
  sweepTab = t;
  return t;
}
export function waveSweep(k: number, stall = WAVE_STALL): number {
  const t = sweepTable(stall);
  const x = clamp01(k) * SWEEP_N;
  const i = Math.min(SWEEP_N - 1, Math.floor(x));
  return t[i] + (t[i + 1] - t[i]) * (x - i);
}

/** the inverse: wave progress at which the front reaches angle fraction `frac` (pairs die then). The GPU reads the
 * same inverse from a table (waveFx.ts frontTime; sweepInverseTable) to know when the front passed each vertex */
export function waveTimeAt(frac: number, stall = WAVE_STALL): number {
  const t = sweepTable(stall);
  const y = clamp01(frac);
  let lo = 0;
  let hi = SWEEP_N;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (t[m] < y) lo = m;
    else hi = m;
  }
  const d = t[hi] - t[lo];
  return (lo + (d > 0 ? (y - t[lo]) / d : 0)) / SWEEP_N;
}

/** `n` samples of waveTimeAt over frac ∈ [0, 1] (the GPU's lookup, linearly interpolated) */
export function sweepInverseTable(n: number, stall: number): Float32Array {
  return Float32Array.from({ length: n }, (_, i) => waveTimeAt(i / (n - 1), stall));
}

/** s from the front reaching the hero grain's spot to the hero survivor coming to rest on it (survivors.ts) */
export const HERO_RUN = 2.1;

/** act s the front passes the hero grain's spot */
export function heroPassTime(p: DriftParams): number {
  const { starts } = beatStarts(p);
  const e = eyePath(starts.wave, p);
  const g = heroGrainPosition(p);
  return starts.wave + waveTimeAt(frontFracCpu([g[0] - e[0], g[1] - e[1], g[2] - e[2]], domeBasis(p.domeTilt).front), p.waveStall) * p.wave;
}

/**
 * THE LIGHT WAVE'S ENVELOPE (the 2026-10-30 review: "once the light wave happens … a better ramp into intensity …
 * have this really feel like WOW — a total collapse of space and time … it feels too tame"). Three movements, all
 * pure functions of act time, inside the existing beat lengths:
 *
 *   BUILD     the last `waveBuild` s of the cooling (from 32.5 s, after its last phrase has gone): tension as
 *             x^1.6 — a little at first, then quickening — so the births low in front, the glow under
 *             the front horizon and the first pull of the field toward it all accelerate into the front's rise.
 *             It holds while the front climbs and is gone as the front leaves behind the audience.
 *   LENS      the front pulls the field toward its own line as it passes (waveFx.ts waveWarp): a little during the
 *             build (the field leans toward where the front will come from), most as it crosses over the
 *             audience, nothing once it has gone. Rad of the largest displacement.
 *   CREST     as the front rushes up over the audience (waveSweep) its light broadens into a band and HOLDS —
 *             a held light, not a flash (a flash reads as a cut, a hold as an event the audience is inside), and
 *             it belongs to the front: nothing lights up anywhere else (the 2026-10-30 story note: a separate
 *             dome-wide light flashed up mid-climb and relit the spent dome behind the front). Its shape is the
 *             sky's (sky.ts); this is only how much of it.
 */
export function waveEnvelope(t: number, p: DriftParams): { build: number; lens: number; crest: number; frontGain: number } {
  const { starts } = beatStarts(p);
  const L = Math.max(1e-6, p.wave);
  const k = clamp01((t - starts.wave) / L);
  const B = Math.max(1e-6, p.waveBuild);
  // (x^1.6: at x^2.4 the first half of the build was all but empty, and the intensifying the 2026-10-30 story note
  // asks for — "collisions intensifying" — only began 2.5 s before the front)
  const rise = clamp01((t - (starts.wave - B)) / B) ** 1.6;
  // in the wave: holds while the front climbs, gone as it settles behind the audience
  const build = rise * (1 - smooth((k - 0.55) / 0.4));
  // THE CREST, on the front's own position: up as it climbs out of the focus zone (from 36°, frac 0.2, full by 72°),
  // held at full over the top, down as it goes on past ~108°. (From 54° to 76° while the front stalled: without the
  // stall it crosses the top in ~1 s, so the crest comes up earlier to carry its light all the way into the zenith;
  // the 2026-11-01 note, the swoosh lost "before reaching the top")
  const f = t > starts.wave ? waveSweep(k, p.waveStall) : 0;
  const crest = smooth((f - 0.2) / 0.2) * (1 - smooth((f - 0.6) / 0.15));
  const pass = t > starts.wave && t < starts.wave + L ? Math.sin(Math.PI * k) ** 0.6 : 0;
  const lens = ((p.waveLens * Math.PI) / 180) * Math.max(0.35 * build, pass * (0.45 + 0.55 * crest));
  // (eased in over the wave's first 0.3 s and out over its last 0.7 s: nothing on the dome steps)
  const frontGain = smooth(k / 0.04) * (0.4 + 0.6 * smooth(k / 0.3)) * (1 - smooth((k - 0.9) / 0.1));
  return { build, lens, crest, frontGain };
}

/** start time (s) of each beat, plus the total length */
export function beatStarts(p: DriftParams): { starts: Record<(typeof BEATS)[number], number>; total: number } {
  let acc = 0;
  const starts = {} as Record<(typeof BEATS)[number], number>;
  for (const b of BEATS) {
    starts[b] = acc;
    acc += Math.max(0, p[b]);
  }
  return { starts, total: acc };
}

/**
 * The field's physics time at act time t: rate 1 until the cooling, easing down to `slowRate` across it,
 * then constant. Exact integral of that rate (so pairs never jump).
 */
export function fieldClock(t: number, p: DriftParams): number {
  const { starts } = beatStarts(p);
  const c0 = starts.cool;
  const L = Math.max(1e-6, p.cool);
  if (t <= c0) return t;
  const x = (t - c0) / L;
  if (x <= 1) return c0 + L * (x - (1 - p.slowRate) * smoothIntegral(x));
  return c0 + L * (1 - (1 - p.slowRate) * 0.5) + p.slowRate * (t - c0 - L);
}

export function undertimeState(t: number, p: DriftParams): UndertimeState {
  const { starts } = beatStarts(p);
  let beat: Beat = 'end';
  let u = 1;
  for (const b of BEATS) {
    const len = Math.max(0, p[b]);
    if (t < starts[b] + len) {
      beat = b;
      u = len > 0 ? clamp01((t - starts[b]) / len) : 1;
      break;
    }
  }
  const at = (b: (typeof BEATS)[number]): number => clamp01((t - starts[b]) / Math.max(1e-6, p[b]));
  const arise = at('arise');
  const cool = at('cool');
  const wave = at('wave');
  const rem = at('remain');
  const zoom = at('zoom');
  const gather = at('gather');

  // pairs: none in the cold open; ignite slowly then everywhere (an accelerating curve: a few, then the
  // boil); thin out as it cools; the wave ends the rest (the front kills them, not the density)
  // the cooling calms FAST at first (ease-out), so its text windows sit on a quieter sky
  const calm = 1 - (1 - cool) ** 4;
  const pairDensity = lerp(arise ** 2.2, p.coolDensity, calm) * (1 - smooth(rem / 0.05));
  // a flash reads brighter once pairs are readable, brightest in the wave
  const flashGain = lerp(0.55, 1, calm) * lerp(1, 1.8, Math.sin(Math.PI * wave));
  // haze: grows with the boil, falls as it cools, surges with the wave front, gone in the darkness after it
  const surge = Math.sin(Math.PI * clamp01(wave * 1.15));
  const base = lerp(lerp(0, 1, smooth(arise * 1.4)), 0.3, calm);
  const glow = lerp(base + (1 - base) * 0.7 * surge, 0, smooth(wave * 1.6 - 0.6));
  const clockRate = t <= starts.cool ? 1 : lerp(1, p.slowRate, smooth(cool));
  // the hero grain is LEFT BY THE FRONT (the 2026-10-30 story note: "the big explosion of things that ultimately
  // leaves only … the one billionth — is not fully clear"): the front passes its spot, the hero survivor's bead runs
  // on, curls down and comes to rest there (survivors.ts), and from then on it is there; the others reveal
  // themselves later and slower
  const heroGrain = smooth((t - (heroPassTime(p) + HERO_RUN * 0.85)) / 0.8);
  const grains = smooth((rem - 0.35) / 0.55);
  // pull-back: eased in and out over ~3 s, constant through the middle (comfort: tests hold the peak rate)
  const scale = Math.pow(10, -p.zoomDecades * plateau(zoom, 3 / Math.max(6, p.zoom)));
  const env = waveEnvelope(t, p);
  return {
    beat,
    u,
    clock: fieldClock(t, p),
    clockRate,
    pairDensity,
    flashGain,
    glow,
    waveClock0: fieldClock(starts.wave, p),
    waveRate: p.slowRate,
    waveLength: Math.max(1e-6, p.wave),
    wave: waveSweep(wave, p.waveStall),
    ...env,
    heroGrain,
    grains,
    scale,
    stars: smooth(gather / 0.8),
  };
}

/** world direction of dome elevation `el` (deg) straight ahead (azimuth 0) for a dome tilted `tiltDeg` */
export function domeAhead(elDeg: number, tiltDeg: number): Vec3 {
  const b = domeBasis(tiltDeg);
  const e = (elDeg * Math.PI) / 180;
  return [0, 1, 2].map((i) => Math.cos(e) * b.front[i] + Math.sin(e) * b.axis[i]) as Vec3;
}

/** where the eye is at the start of the remain beat (the end of the forward drift) */
function driftEnd(p: DriftParams): Vec3 {
  return [0, 0, -p.driftSpeed * (Math.max(0, p.arise) + Math.max(0, p.cool)) * 0.5];
}

/** the hero grain, in front and up of where the drift ends; the zoom's pivot */
export function heroGrainPosition(p: DriftParams): Vec3 {
  const e = driftEnd(p);
  const d = domeAhead(p.heroGrainEl, p.domeTilt);
  return [e[0] + d[0] * p.heroGrainDist, e[1] + d[1] * p.heroGrainDist, e[2] + d[2] * p.heroGrainDist];
}

/**
 * CAMERA PATH — the eye's world position at act time t. Pure, and translation only: a dome audience feels
 * rotation in the stomach, so the act never turns. Still for the cold open; a forward drift through the
 * field that eases in across the arising and out across the cooling (velocity is smoothstep-shaped, so the
 * acceleration never jumps); still for the wave, so the front does the moving; the slowest approach toward
 * the hero grain in the remain beat; still after it (the zoom is a scale change about the grain).
 */
export function eyePath(t: number, p: DriftParams): Vec3 {
  const { starts } = beatStarts(p);
  const v = p.driftSpeed;
  const La = Math.max(1e-6, p.arise);
  const Lc = Math.max(1e-6, p.cool);
  let z = 0;
  if (t > starts.arise) {
    const xa = (t - starts.arise) / La;
    z = -v * La * smoothIntegral(xa);
    if (xa > 1) {
      const xc = clamp01((t - starts.cool) / Lc);
      z = -v * (La * 0.5 + Lc * (xc - smoothIntegral(xc)));
    }
  }
  if (t <= starts.remain) return [0, 0, z];
  const e = driftEnd(p);
  const g = heroGrainPosition(p);
  const d = [g[0] - e[0], g[1] - e[1], g[2] - e[2]];
  const n = Math.hypot(d[0], d[1], d[2]) || 1;
  const k = smooth((t - starts.remain) / Math.max(1e-6, p.remain)) * p.approach;
  return [e[0] + (d[0] / n) * k, e[1] + (d[1] / n) * k, e[2] + (d[2] / n) * k];
}

/** s after the gather beat starts that the pull-back's turn comes to rest (the zoom itself eased out at its start) */
const WEB_TURN_END = 1;

/** show s the pull-back (zoom and turn) comes to rest, where Get the Drift's dive into the web begins (its
 * `diveLead` is set to meet it: tests/webDive.test.ts) */
export function webTurnEnd(p: DriftParams): number {
  return beatStarts(p).starts.gather + WEB_TURN_END;
}

export interface WebFlight {
  /** the eye relative to the hero knot in the web's box (box units, along the WORLD's axes: the box itself sits
   * turned in the world, by the frame getTheDrift/webDive.ts sets so the dive that follows runs down a filament) */
  offset: Vec3;
  /** world units per box */
  box: number;
  /** where the hero grain is now (the flight line's turn carries it slowly across the dome) */
  pivot: Vec3;
  /** 0..1 how much of the web's gas shows (none while the eye is still inside the grain's knot) */
  presence: number;
}

/**
 * THE WEB FLIGHT (webVolume.ts): the zoom's scale change about the hero grain, seen from inside the web's
 * box, is the eye flying back out of the grain's knot — `webReach` box units by the zoom's end — and the
 * line it flies along turns slowly (`webTurn` degrees about the dome's axis, until webTurnEnd) so the
 * filaments pass with parallax rather than only flowing into a point. The turn carries the hero grain across the
 * dome by the same angle, under 1°/s. Where it comes to rest, Get the Drift's dive into the web begins
 * (getTheDrift/webDive.ts): from there on the eye's place in the web is the dive's, and this flight is only the
 * pull-back that led to it.
 */
export function webFlight(t: number, p: DriftParams): WebFlight {
  const { starts } = beatStarts(p);
  const scale = undertimeState(t, p).scale;
  const D = Math.max(1e-6, p.zoomDecades);
  const eye = eyePath(starts.zoom, p);
  const hero = heroGrainPosition(p);
  const rel: Vec3 = [eye[0] - hero[0], eye[1] - hero[1], eye[2] - hero[2]];
  const d0 = Math.hypot(rel[0], rel[1], rel[2]) || 1;
  // the flight line turns about the dome's axis (Rodrigues)
  const a = domeBasis(p.domeTilt).axis;
  // the turn runs on just past the zoom, eased in and out, and comes to rest where the dive into the web begins
  // (webTurnEnd): the two never move the eye at once. (It ran on to the next act, 81 s, while the eye then sat
  // still in the web for the gather beat; the 2026-10-30 review found the scene static and slow — the dive is now
  // what moves it, and the turn, 6 s shorter, was cut from 20° to 14° to stay under 1°/s.)
  const turnLen = Math.max(1e-6, webTurnEnd(p) - starts.zoom);
  const th = ((p.webTurn * Math.PI) / 180) * plateau(clamp01((t - starts.zoom) / turnLen), 4 / turnLen);
  const c = Math.cos(th);
  const s = Math.sin(th);
  const ad = a[0] * rel[0] + a[1] * rel[1] + a[2] * rel[2];
  const cr: Vec3 = [a[1] * rel[2] - a[2] * rel[1], a[2] * rel[0] - a[0] * rel[2], a[0] * rel[1] - a[1] * rel[0]];
  const u: Vec3 = [0, 1, 2].map((i) => (rel[i] * c + cr[i] * s + a[i] * ad * (1 - c)) / d0) as Vec3;
  const reach = p.webReach * Math.pow(10, -D) / scale;
  return {
    offset: u.map((x) => x * reach) as Vec3,
    box: d0 / reach,
    pivot: [0, 1, 2].map((i) => hero[i] + (rel[i] - u[i] * d0)) as Vec3,
    // the volume's cells are ~0.004 box units and the hero knot's halo ~0.02: closer in, the eye sits inside
    // one blur of gas (a grey wash), so the gas comes up as the eye clears the halo
    presence: smooth((reach - 0.012) / 0.04),
  };
}
