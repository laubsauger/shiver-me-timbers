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
  /** 0..1 progress of the wave front (0 before it, 1 once it has crossed the whole field) */
  wave: number;
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
  // the hero grain is there as the dark lifts; the others reveal themselves later and slower
  const heroGrain = smooth((rem - 0.08) / 0.22);
  const grains = smooth((rem - 0.35) / 0.55);
  // pull-back: eased in and out over ~3 s, constant through the middle (comfort: tests hold the peak rate)
  const scale = Math.pow(10, -p.zoomDecades * plateau(zoom, 3 / Math.max(6, p.zoom)));
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
    wave,
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
