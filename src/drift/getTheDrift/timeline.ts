/**
 * Get the Drift, part A — beat timeline and camera path, a PURE function of the act's own time `t` (s from
 * the act's start, which overlaps the end of Undertime by `overlap`). Direction:
 * drift-narrative/get-the-drift/direction.md.
 *
 * GEOMETRY. Everything is placed relative to where Undertime leaves the eye (E0): the Sun point T lies
 * ahead along the approach direction; our galaxy is laid so that, seen from T, its centre sits low in front
 * and its plane runs from the front over the zenith to the back (the band arcs over the audience), leaned a
 * little so it is not a ruler-straight meridian.
 *
 * CAMERA. ONE JOURNEY, never at rest from the galaxy cluster down to the water (user, 2026-10-26: the moves
 * that each eased to rest and then started again read as clips stitched together). Two zooms, each a smooth
 * monotone curve of log distance through a few anchors, overlapping where one hands over to the other:
 *   - into the galaxy: f = |E − T| / |E0 − T| along the straight approach line through E0 and T (exponential in
 *     distance: constant optic flow). It begins as THE DIVE INTO THE WEB (webDive.ts), `diveLead` s before the
 *     act, at rest and e^diveEfolds times further out than E0 — among the filaments, which Undertime draws in the
 *     same frame — and is the approach it always was from the `ours` beat on; it slows to a drift as the Earth
 *     comes in;
 *   - toward the Earth and down to it: the altitude, from the planet as a point beside the Sun to orbit, a
 *     slow descent through the time waves and the night, faster through the flood and over the spiral.
 * The planet's place in the view follows from the altitude and where its limb sits on the dome, so it turns
 * while the zoom goes on, never in a stop of its own. tests/getTheDriftTimeline.test.ts holds the rates under
 * the comfort caps and the motion above a floor.
 */
import type { GetTheDriftParams } from '../../params/getTheDrift';
import { domeBasis, type Vec3 } from '../../cine/domeMaster';

export const BEATS = ['galaxies', 'ours', 'band', 'sun', 'earth', 'timewave', 'lights', 'overshoot', 'flood', 'drift2', 'landing'] as const;
export type Beat = (typeof BEATS)[number] | 'end';

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const smooth = (x: number): number => {
  const k = clamp01(x);
  return k * k * (3 - 2 * k);
};
const smoothIntegral = (x: number): number => {
  const k = clamp01(x);
  return k * k * k - (k * k * k * k) / 2;
};

/**
 * 0..1 position under a trapezoid velocity with smooth ramps: `rampIn` and `rampOut` are fractions of the
 * span. Its peak rate is 1 / (1 − (rampIn + rampOut) / 2) per span.
 */
export function ramped(x: number, rampIn: number, rampOut: number): number {
  const k = clamp01(x);
  const a = Math.max(1e-6, rampIn);
  const b = Math.max(1e-6, rampOut);
  const area = 1 - (a + b) / 2;
  let s: number;
  if (k < a) s = a * smoothIntegral(k / a);
  else if (k <= 1 - b) s = a / 2 + (k - a);
  else s = a / 2 + (1 - a - b) + b * (0.5 - smoothIntegral((1 - k) / b));
  return s / area;
}

export function beatStarts(p: GetTheDriftParams): { starts: Record<(typeof BEATS)[number], number>; total: number } {
  let acc = 0;
  const starts = {} as Record<(typeof BEATS)[number], number>;
  for (const b of BEATS) {
    starts[b] = acc;
    acc += Math.max(0, p[b]);
  }
  return { starts, total: acc };
}

const add = (a: Vec3, b: Vec3, k = 1): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** world direction of dome elevation / azimuth (deg; azimuth + to the viewer's right) for a tilted dome */
export function domeDir(elDeg: number, azDeg: number, tiltDeg: number): Vec3 {
  const b = domeBasis(tiltDeg);
  const e = (elDeg * Math.PI) / 180;
  const a = (azDeg * Math.PI) / 180;
  return [0, 1, 2].map((i) => Math.cos(e) * (Math.cos(a) * b.front[i] + Math.sin(a) * b.right[i]) + Math.sin(e) * b.axis[i]) as Vec3;
}

export interface OurGalaxy {
  /** where Undertime leaves the eye */
  e0: Vec3;
  /** the Sun point: where the approach ends */
  sun: Vec3;
  centre: Vec3;
  /** unit, the disk's normal */
  normal: Vec3;
  /** unit, in the plane: from the centre toward the Sun (the frame's x axis) */
  xAxis: Vec3;
  yAxis: Vec3;
  radius: number;
}

export function ourGalaxy(p: GetTheDriftParams, e0: Vec3, tiltDeg: number): OurGalaxy {
  const sun = add(e0, domeDir(p.approachEl, p.approachAz, tiltDeg), p.ourDistance);
  const toCentre0 = domeDir(p.centreEl, 0, tiltDeg);
  const zenith = domeBasis(tiltDeg).axis;
  // the plane holding the centre direction and the zenith, leaned about the centre direction
  const n0 = norm(cross(toCentre0, zenith));
  const lean = (p.bandLean * Math.PI) / 180;
  const up = norm(cross(n0, toCentre0));
  const normal = norm(add([n0[0] * Math.cos(lean), n0[1] * Math.cos(lean), n0[2] * Math.cos(lean)], up, Math.sin(lean)));
  const toCentre = norm(add(toCentre0, normal, -dot(toCentre0, normal)));
  const centre = add(sun, toCentre, p.sunRadius * p.ourRadius);
  const xAxis: Vec3 = [-toCentre[0], -toCentre[1], -toCentre[2]];
  return { e0, sun, centre, normal, xAxis, yAxis: cross(normal, xAxis), radius: p.ourRadius };
}

export interface ArrivalState {
  beat: Beat;
  u: number;
  /** 0..1 our galaxy as a volume around us (1 − this is its far impostor) */
  volume: number;
  /** 0..1 the stars near the Sun point (parallax field inside the disk) */
  local: number;
  /** distance to the Sun point as a fraction of |E0 − T| (ourDistance): e^diveEfolds where the dive into the web
   * starts (diveLead s before the act) → insideKeep → less in the sun beat */
  f: number;
  /** 0..1 the Sun standing out as one star */
  sunStar: number;
  /** 0..1 the Earth scene (its Sun takes over from the Milky Way's Sun star) */
  earth: number;
}

/**
 * A journey's progress from its SPEED: `rate` is drawn as a smooth curve through (time, speed) keys (a
 * monotone cubic, so its peaks are round and it never overshoots below zero) and integrated into a table.
 * Speed, not position, is what the audience feels: drawn this way it has no kinks (no jolts) and no dips at
 * the keys, which a spline through positions gave. Returned: the distance covered by time t.
 */
function journey(ts: number[], speeds: number[], weight: (t: number) => number = () => 1): (t: number) => number {
  const t0 = ts[0];
  const t1 = ts[ts.length - 1];
  const dt = 0.02;
  const n = Math.ceil((t1 - t0) / dt) + 1;
  const acc = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) {
    const a = t0 + (i - 1) * dt + dt / 2;
    // midpoint rule (the curve is smooth)
    acc[i] = acc[i - 1] + monotone(ts, speeds, a) * weight(a) * dt;
  }
  return (t: number): number => {
    const x = (Math.min(Math.max(t, t0), t1) - t0) / dt;
    const i = Math.min(n - 1, Math.floor(x));
    return acc[i] + (acc[i + 1] - acc[i]) * (x - i);
  };
}

/**
 * THE DIVE'S PACE (webDive.ts), as (fraction of its span, e-folds per second) keys: the speed it ADDS to the approach
 * over its span, from `diveLead` s before the act to the galaxies beat's end, scaled to add `diveEfolds` in all (at
 * 3 e-folds the keys are near their own scale: a peak of ~0.27). Slow under Undertime's first stars and its
 * signature, so the hero grain still lights above the text (~82.5 s); fastest a little past halfway (~88 s), where
 * the approach's own pace is still ~0.04 — together ~0.31 e-folds/s, under the 0.35 cap; and back to nothing at
 * `ours`, where the approach's own 0.12 carries on: from there the journey is the very curve it was without the dive
 * (the 2026-10-30 review: "a better sense of speed when zooming in … more dynamic"). Accelerate, then decelerate as
 * our galaxy is recognised — the breath before "this whole zoom in".
 */
const DIVE_KEYS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0.12, 0.012],
  [0.24, 0.04],
  [0.36, 0.12],
  [0.48, 0.24],
  [0.58, 0.27],
  [0.68, 0.24],
  [0.8, 0.14],
  [0.92, 0.04],
  [1, 0],
];

const journeys = new Map<string, { galaxy: (t: number) => number; earth: (t: number) => number; dive: (t: number) => number }>();
function journeysFor(p: GetTheDriftParams): { galaxy: (t: number) => number; earth: (t: number) => number; dive: (t: number) => number } {
  const key = JSON.stringify(p);
  const hit = journeys.get(key);
  if (hit) return hit;
  const { starts } = beatStarts(p);
  // INTO THE GALAXY (e-folds of distance per second, scaled below to reach the Sun point on time): a slow
  // start among the galaxies, the dive into the disk, on through the Sun's neighbourhood, slowing as the Earth
  // comes in and takes the motion over — never below a drift until the planet is growing in view
  const past = p.galaxies + p.ours + p.band + p.sun;
  const gts = [0, 8, p.galaxies + 2, p.galaxies + p.ours, past - 4, past + 8, past + 18, past + 30];
  const gv = [0, 0.05, 0.14, 0.19, 0.17, 0.13, 0.06, 0];
  const g0 = journey(gts, gv);
  const lnSun = Math.log(p.insideKeep) + Math.log(0.047);
  const gScale = -lnSun / g0(past);
  // TOWARD THE EARTH AND DOWN TO IT (e-folds of altitude per second, scaled to land over the spiral on time):
  // the approach under the comfort cap, a slow sink from a high orbit through the time waves and the night,
  // faster through the flood
  // ... and on through the landing (C1) down to the raft, at rest only there
  const e = starts.earth;
  const end = starts.drift2 + p.drift2;
  const land = end + p.landing;
  const L = p.landing;
  const ets = [e - 3, e + 2, e + 9, e + 17, e + 25, e + 31, e + 38, e + 48, starts.flood - 6, starts.flood + 12, end - 6, end + 0.25 * L, end + 0.55 * L, end + 0.8 * L, land];
  const ev = [0, 0.1, 0.24, 0.28, 0.34, 0.3, 0.12, 0.022, 0.014, 0.07, 0.09, 0.1, 0.24, 0.16, 0];
  // two anchors (Drift-2 ends over the galaxy at `driftAltitude`, the landing at the raft): one scale before,
  // one after, blended smoothly across Drift-2's end so the speed stays smooth — solved for both
  const w = (t: number): number => smooth((t - end + 8) / 16);
  const before = journey(ets, ev, (t) => 1 - w(t));
  const after = journey(ets, ev, w);
  const far = (EARTH_RADIUS + p.orbitAltitude) * p.earthFar - EARTH_RADIUS;
  const A1 = Math.log(far / p.driftAltitude);
  const A2 = Math.log(far / LANDED);
  // s1·b(end) + s2·a(end) = A1;  s1·b(land) + s2·a(land) = A2
  const [b1, a1, b2, a2] = [before(end), after(end), before(land), after(land)];
  const det = b1 * a2 - a1 * b2;
  const s1 = (A1 * a2 - a1 * A2) / det;
  const s2 = (b1 * A2 - A1 * b2) / det;
  // THE DIVE (DIVE_KEYS): the e-folds of distance it has still to add at time t — diveEfolds before it starts, 0
  // from `ours` on
  const dSpan = p.diveLead + p.galaxies;
  let dive = (_t: number): number => 0;
  if (dSpan > 1e-6 && p.diveEfolds > 0) {
    const dts = DIVE_KEYS.map(([x]) => -p.diveLead + x * dSpan);
    const d0 = journey(dts, DIVE_KEYS.map(([, v]) => v));
    const dScale = p.diveEfolds / d0(p.galaxies);
    dive = (t: number): number => p.diveEfolds - d0(t) * dScale;
  }
  const made = {
    galaxy: (t: number): number => -g0(t) * gScale,
    earth: (t: number): number => far * Math.exp(-(before(t) * s1 + after(t) * s2)),
    dive,
  };
  journeys.clear();
  journeys.set(key, made);
  return made;
}

/** ln f, the approach into our galaxy with the dive into the web ahead of it (journeysFor); defined from the dive's
 * start, `diveLead` s before the act (t < 0), where Undertime's frame still draws the web (webDive.ts) */
function galaxyZoom(t: number, p: GetTheDriftParams): number {
  const j = journeysFor(p);
  return j.galaxy(t) + j.dive(t);
}

export function arrivalState(t: number, p: GetTheDriftParams): ArrivalState {
  const { starts, total } = beatStarts(p);
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
  void total;
  const f = Math.exp(galaxyZoom(t, p));
  return {
    beat,
    u,
    // the volume takes over from the impostor while still ~3 radii out: closer than ~1.5 radii the flat
    // impostor would wrap under the eye and show its plane's horizon as an edge
    volume: smooth((Math.log(1 / f) - 0.4) / 1.0),
    local: smooth((Math.log(1 / f) - 3) / 2),
    f,
    sunStar: smooth((t - starts.sun) / Math.max(1e-6, p.sun * 0.7)),
    earth: smooth((t - starts.earth + 1) / 2),
  };
}

export const EARTH_RADIUS = 6.371;

/** the Earth's pose relative to the eye at act time t: where its centre is (unit) and how far (Mm) */
export interface EarthPose {
  centreDir: Vec3;
  distance: number;
  /** unit, toward the Sun (fixed: where the arrival left it) */
  sun: Vec3;
  /** deg, the planet's angular radius */
  radiusDeg: number;
}

const slerp = (a: Vec3, b: Vec3, k: number): Vec3 => {
  const c = Math.min(1, Math.max(-1, dot(a, b)));
  const w = Math.acos(c);
  if (w < 1e-6) return a;
  const s = Math.sin(w);
  const ka = Math.sin((1 - k) * w) / s;
  const kb = Math.sin(k * w) / s;
  return norm([a[0] * ka + b[0] * kb, a[1] * ka + b[1] * kb, a[2] * ka + b[2] * kb]);
};

/** Mm above the sea at act time t (journeysFor): from the point beside the Sun, through orbit, the flood's
 * "tectonic" heights (~100 km, watching the sea rise), to `driftAltitude` over the spiral */
function earthAltitude(t: number, p: GetTheDriftParams): number {
  return journeysFor(p).earth(t);
}

/** in `earthApproach`s from the Earth beat's start: the planet has slid to the front, its limb across it, and
 * the Sun's day begins (the dawn) */
export const ARRIVED = 1.6;
/** s the planet sinks by `dawnSink` over, from its arrival, as the day breaks on it */
const DAWN_SINK_S = 20;

/** Mm: the eye's height over the water at the raft (a few metres, just above a deck) */
export const LANDED = 3e-6;
/** rad/s Drift-2's debris galaxy turns at, as one (debrisField.ts): at the raft, ~2.4 km out, a current of
 * ~0.5 m/s the raft drifts on and the eye follows */
export const DEBRIS_SPIN = 0.0002;
/** how fast the landing's ground track closes on the raft against the height it comes down (see landingTrack) */
const TRACK_Q = 2;
/** m east, north of the field's centre: where the eye comes down, in an arm of the debris galaxy (the raft
 * floats beside it: wandering/sea.ts) */
export const EYE_AT: [number, number] = [-2200, 900];

/**
 * THE GATHERING POINT, where Drift-2's debris galaxy floats (its centre), and the tangent frame there: the
 * point a ray at gatherEl straight ahead meets the planet at Drift-2's end (the planet only translates
 * until then, so it stays put on it). `up` is the planet's normal there, `front` the dome's front laid into
 * the tangent plane (the heading the landing levels out on), `east`, `north` complete the frame.
 */
export interface GatherFrame {
  up: Vec3;
  east: Vec3;
  north: Vec3;
  front: Vec3;
}
const gatherCache = new Map<string, GatherFrame>();
export function gatherFrame(p: GetTheDriftParams, tiltDeg: number): GatherFrame {
  const key = JSON.stringify(p) + tiltDeg;
  const hit = gatherCache.get(key);
  if (hit) return hit;
  const { starts } = beatStarts(p);
  const endT = starts.drift2 + p.drift2;
  const endPlace = earthPlace0(endT, p, tiltDeg);
  const c = endPlace.centreDir.map((x) => x * endPlace.distance) as Vec3;
  const ray = domeDir(p.gatherEl, 0, tiltDeg);
  const b = dot(ray, c);
  const t = b - Math.sqrt(Math.max(0, b * b - dot(c, c) + EARTH_RADIUS * EARTH_RADIUS));
  const up = norm([ray[0] * t - c[0], ray[1] * t - c[1], ray[2] * t - c[2]]);
  const east = norm(cross(up, [0, 1, 0]));
  const north = cross(east, up);
  const f0 = domeDir(0, 0, tiltDeg);
  const front = norm(add(f0, up, -dot(f0, up)));
  const made = { up, east, north, front };
  gatherCache.clear();
  gatherCache.set(key, made);
  return made;
}

/**
 * The landing (C1): from Drift-2's end the eye glides down over the debris galaxy to the raft (`landingTrack`:
 * the eye's ground position, m east and north of the field's centre, and its height, m). Its ground
 * track runs from where Drift-2 left it to the raft, steered by the height: with u the e-folds come down,
 * the share of the way still to go is (1 + qu)·e^(−qu) — it sets off gently, and the ground's apparent
 * motion (speed over height, ∝ u·e^(−(q−1)u)·u̇) rises and dies away with the descent, never stopping before
 * it does. What it comes down onto is a point of the debris galaxy (EYE_AT when the landing ends), turning with
 * it: once down, the eye drifts on with the raft and the matter round it (direction.md C1: "then a very slow
 * follow"). The planet places itself under it; a short blend across Drift-2's end joins the two without a kink.
 */
export function landingTrack(t: number, p: GetTheDriftParams, tiltDeg: number): { east: number; north: number; alt: number } {
  const { starts } = beatStarts(p);
  const endT = starts.drift2 + p.drift2;
  const g = gatherFrame(p, tiltDeg);
  const alt = earthAltitude(t, p);
  // where Drift-2 left the eye's ground track (tangent coordinates at the gathering point)
  const before = earthPlace0(endT, p, tiltDeg);
  const eyeAt = before.centreDir.map((x) => -x * before.distance) as Vec3;
  const g0 = [dot(eyeAt, g.east) * 1e6, dot(eyeAt, g.north) * 1e6];
  const u = Math.max(0, Math.log(earthAltitude(endT, p)) - Math.log(alt));
  const k = 1 - (1 + TRACK_Q * u) * Math.exp(-TRACK_Q * u);
  // (the field turns as three's rotation.y does: x east, z north)
  const a = DEBRIS_SPIN * (t - (endT + p.landing));
  const target = [EYE_AT[0] * Math.cos(a) + EYE_AT[1] * Math.sin(a), -EYE_AT[0] * Math.sin(a) + EYE_AT[1] * Math.cos(a)];
  return { east: g0[0] + (target[0] - g0[0]) * k, north: g0[1] + (target[1] - g0[1]) * k, alt: alt * 1e6 };
}

function landingPlace(t: number, p: GetTheDriftParams, tiltDeg: number): { centreDir: Vec3; distance: number } {
  const g = gatherFrame(p, tiltDeg);
  const tr = landingTrack(t, p, tiltDeg);
  const onPlanet = norm(add(add(g.up.map((x) => x * EARTH_RADIUS) as Vec3, g.east, tr.east * 1e-6), g.north, tr.north * 1e-6));
  const eye = onPlanet.map((x) => x * (EARTH_RADIUS + tr.alt * 1e-6)) as Vec3;
  const d = Math.hypot(eye[0], eye[1], eye[2]);
  return { centreDir: eye.map((x) => -x / d) as Vec3, distance: d };
}

/**
 * The eye's turn over Drift-2 and the landing: from Act 2's framing it looks `driftLook` further down through
 * Drift-2 (`look`, rad, a pitch about the dome's left–right axis: onto the spiral from high up — the eye
 * turns, not the planet, which would turn the planet under its Sun), then levels out (`k`, toward level at the
 * raft, looking ahead).
 */
export function landingTurn(t: number, p: GetTheDriftParams, tiltDeg: number): { k: number; look: number; up: Vec3; front: Vec3 } {
  const { starts } = beatStarts(p);
  const endT = starts.drift2 + p.drift2;
  const g = gatherFrame(p, tiltDeg);
  const look = ((p.driftLook * Math.PI) / 180) * smooth((t - starts.drift2 + 4) / (p.drift2 + 4));
  return { k: smooth((t - endT + 4) / (p.landing * 0.85)), look, up: g.up, front: g.front };
}

/** where the planet is (centre direction, distance) at act time t — everything but the Sun */
function earthPlace(t: number, p: GetTheDriftParams, tiltDeg: number): { centreDir: Vec3; distance: number } {
  const { starts } = beatStarts(p);
  const endT = starts.drift2 + p.drift2;
  if (t <= endT - BLEND) return earthPlace0(t, p, tiltDeg);
  const land = landingPlace(t, p, tiltDeg);
  if (t >= endT + BLEND) return land;
  const w = smooth((t - endT + BLEND) / (2 * BLEND));
  const was = earthPlace0(t, p, tiltDeg);
  const pa = was.centreDir.map((x) => x * was.distance);
  const pb = land.centreDir.map((x) => x * land.distance);
  const c = [0, 1, 2].map((i) => pa[i] + (pb[i] - pa[i]) * w) as Vec3;
  const d = Math.hypot(c[0], c[1], c[2]);
  return { centreDir: c.map((x) => x / d) as Vec3, distance: d };
}

/** s each side of Drift-2's end the two placements are blended over */
const BLEND = 5;

/** where the planet is up to Drift-2's end: the approach, the slide, the limb across the front */
function earthPlace0(t: number, p: GetTheDriftParams, tiltDeg: number): { centreDir: Vec3; distance: number } {
  const { starts } = beatStarts(p);
  const distance = EARTH_RADIUS + earthAltitude(t, p);
  const radius = (Math.asin(Math.min(1, EARTH_RADIUS / distance)) * 180) / Math.PI;
  const dawn = smooth((t - starts.earth - ARRIVED * p.earthApproach) / DAWN_SINK_S);
  // where its limb sits: across the front, sinking a little through the dawn, a little lower over the flood
  const flood = smooth((t - starts.flood) / Math.max(1e-6, 0.6 * (p.flood + p.drift2)));
  const limb = (p.limbEl - p.dawnSink * dawn) * (1 - flood) + p.floodLimbEl * flood;
  const below = domeDir(limb - radius, 0, tiltDeg);
  // it first shows front right, a third of it sunlit (a point beside the Sun would show its night side: a
  // dark dot, not a blue one), and slides down to the front while it grows — big enough by then to stay on
  // the dome while its centre goes below the dome's edge
  const beside = domeDir(p.approachEl - 23, p.approachAz + 85, tiltDeg);
  const slide = smooth((t - starts.earth) / (ARRIVED * p.earthApproach));
  return { centreDir: slerp(beside, below, slide), distance };
}

const rotateAbout = (v: Vec3, a: Vec3, th: number): Vec3 => {
  const c = Math.cos(th);
  const s = Math.sin(th);
  const ad = dot(a, v);
  const cr = cross(a, v);
  return [0, 1, 2].map((i) => v[i] * c + cr[i] * s + a[i] * ad * (1 - c)) as Vec3;
};

/** monotone cubic (Fritsch–Carlson) through (x, y) keys, flat before the first and after the last */
function monotone(xs: number[], ys: number[], x: number): number {
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  const d = xs.slice(1).map((_, i) => (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const m = xs.map((_, i) => (i === 0 || i === n - 1 ? 0 : d[i - 1] * d[i] <= 0 ? 0 : (2 * d[i - 1] * d[i]) / (d[i - 1] + d[i])));
  let i = 0;
  while (x > xs[i + 1]) i++;
  const h = xs[i + 1] - xs[i];
  const u = (x - xs[i]) / h;
  const h00 = 2 * u ** 3 - 3 * u ** 2 + 1;
  const h10 = u ** 3 - 2 * u ** 2 + u;
  const h01 = -2 * u ** 3 + 3 * u ** 2;
  const h11 = u ** 3 - u ** 2;
  return h00 * ys[i] + h10 * h * m[i] + h01 * ys[i + 1] + h11 * h * m[i + 1];
}

/** deg: the Sun over the horizon at the raft when the landing ends */
const MORNING_SUN = 11;

export interface SunDay {
  /** unit pole the Sun's day turns about, and its start (where the arrival left it) */
  pole: Vec3;
  start: Vec3;
  /** rad along the day: the keys' times and angles */
  times: number[];
  angles: number[];
}

/**
 * THE SUN'S DAY, as a time-lapse on one continuous path — a small circle about a pole in the front sky, as a
 * real Sun's day is a small circle about the celestial pole. From where the arrival left it (front left) it
 * climbs through the dawn and the time waves, comes down the front right and SETS behind the right limb in
 * the lights beat, passes behind the planet through the night, RISES over the left limb in the flood and
 * climbs back to where the day began by the end of Drift-2. The circle passes through the start and the
 * front low sky (behind the planet), so it always sets and rises in view.
 */
export function sunDay(p: GetTheDriftParams, tiltDeg: number): SunDay {
  const { starts } = beatStarts(p);
  const start = domeDir(p.approachEl, p.approachAz, tiltDeg);
  const e = (p.approachEl * Math.PI) / 180;
  const a = (p.approachAz * Math.PI) / 180;
  // the pole on the front meridian, as far from the start as from the front horizon
  const poleEl = (Math.atan((1 - Math.cos(e) * Math.cos(a)) / Math.sin(e)) * 180) / Math.PI;
  const pole = domeDir(poleEl, 0, tiltDeg);
  // turn the way that climbs first
  const up = domeDir(90, 0, tiltDeg);
  const sign = dot(rotateAbout(start, pole, 0.01), up) > dot(start, up) ? 1 : -1;
  const at = (th: number): Vec3 => rotateAbout(start, pole, sign * th);
  const hidden = (s: Vec3, t: number): boolean => {
    const g = earthPlace(t, p, tiltDeg);
    return Math.acos(Math.min(1, dot(s, g.centreDir))) < Math.asin(Math.min(1, EARTH_RADIUS / g.distance));
  };
  // where along the circle it sets (in the lights beat's sky) and rises (in the flood's)
  const tSet = starts.lights + 0.4 * p.lights;
  const tRise = starts.flood + 0.45 * p.flood;
  const step = Math.PI / 720;
  let set = Math.PI;
  for (let th = 0.3; th < 2 * Math.PI; th += step) {
    if (hidden(at(th), tSet)) {
      set = th;
      break;
    }
  }
  let rise = set + 1;
  for (let th = set; th < 2 * Math.PI; th += step) {
    if (!hidden(at(th), tRise)) {
      rise = th;
      break;
    }
  }
  // its highest point
  let top = 0;
  for (let th = 0; th < set; th += step) if (dot(at(th), up) > dot(at(top), up)) top = th;
  const D = Math.PI / 180;
  // and where the day ends, at the raft: a low morning Sun, MORNING_SUN over the horizon there (no second
  // sunset after the night of the lights)
  const local = gatherFrame(p, tiltDeg).up;
  let morning = rise + 8 * D;
  for (let th = rise + 8 * D; th < 2 * Math.PI; th += step) {
    morning = th;
    if (dot(at(th), local) >= Math.sin(MORNING_SUN * D)) break;
  }
  return {
    pole: sign > 0 ? pole : (pole.map((x) => -x) as Vec3),
    start,
    times: [starts.earth + ARRIVED * p.earthApproach, starts.timewave + 6, tSet, tRise, starts.landing + p.landing],
    angles: [0, Math.min(top + 25 * D, (top + set) / 2), set + 4 * D, rise + 4 * D, morning],
  };
}

export function sunAt(t: number, day: SunDay): Vec3 {
  return rotateAbout(day.start, day.pole, monotone(day.times, day.angles, t));
}

/**
 * EARTH, by translation only: the eye stays where the arrival left it and the planet comes to it — a lit
 * point beside the Sun, growing (exponentially, under the comfort cap) while its centre slides down below
 * the front, until its limb lies across the front of the dome. The Sun's day (sunDay) then runs as a
 * time-lapse: dawn, day, a sunset behind the right limb, the night of the lights, a sunrise over the left
 * limb for the flood. The stars are at infinity, so none of this moves the sky (the sky's own slow wheel is
 * act.ts's).
 */
const dayCache = new Map<string, SunDay>();
export function earthPose(t: number, p: GetTheDriftParams, tiltDeg: number): EarthPose {
  const key = JSON.stringify(p) + tiltDeg;
  let day = dayCache.get(key);
  if (!day) {
    day = sunDay(p, tiltDeg);
    dayCache.clear();
    dayCache.set(key, day);
  }
  const g = earthPlace(t, p, tiltDeg);
  return { centreDir: g.centreDir, distance: g.distance, sun: sunAt(t, day), radiusDeg: (Math.asin(Math.min(1, EARTH_RADIUS / g.distance)) * 180) / Math.PI };
}

/** the eye at act time t: on the line E0 → Sun point, at fraction f of the starting distance */
export function arrivalEye(t: number, p: GetTheDriftParams, g: OurGalaxy): Vec3 {
  const { f } = arrivalState(t, p);
  return [0, 1, 2].map((i) => g.sun[i] + (g.e0[i] - g.sun[i]) * f) as Vec3;
}
