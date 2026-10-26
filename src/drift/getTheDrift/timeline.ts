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
 * CAMERA. One straight approach E0 → T, exponential in distance (constant optic flow, as the pull-back of
 * Undertime): f = |E − T| / |E0 − T| falls under a trapezoid rate profile — a long ease-in through the
 * galaxies beat (we drift among them), a constant rate diving into the disk, an ease-out to rest inside it.
 * The peak rate is held under the comfort cap by tests/getTheDriftTimeline.test.ts.
 */
import type { GetTheDriftParams } from '../../params/getTheDrift';
import { domeBasis, type Vec3 } from '../../cine/domeMaster';

export const BEATS = ['galaxies', 'ours', 'band', 'sun', 'earth', 'timewave', 'lights', 'overshoot', 'flood', 'drift2'] as const;
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
  /** distance to the Sun point as a fraction of the start: 1 → insideKeep → less in the sun beat */
  f: number;
  /** 0..1 the Sun standing out as one star */
  sunStar: number;
  /** 0..1 the Earth scene (its Sun takes over from the Milky Way's Sun star) */
  earth: number;
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
  const approachLen = p.galaxies + p.ours;
  const x = clamp01(t / Math.max(1e-6, approachLen));
  // most of the galaxies beat is the slow start of the approach; ease out inside the disk
  const rampIn = clamp01(p.galaxies / approachLen) * 1.25;
  const lnKeep = Math.log(p.insideKeep);
  let lnF = lnKeep * ramped(x, Math.min(0.6, rampIn), 0.12);
  // the band and sun beats: on through the Sun's neighbourhood toward the Sun point, eased at both ends —
  // the near stars stream past (a still sky here reads as a frozen frame)
  const cruiseK = clamp01((t - starts.band) / Math.max(1e-6, p.band + p.sun));
  lnF += Math.log(0.047) * ramped(cruiseK, 0.25, 0.25);
  const f = Math.exp(lnF);
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

/** where the planet is (centre direction, distance) at act time t: the approach, the dawn's sink, the flood's
 * and Drift-2's descent — everything but the Sun */
function earthPlace(t: number, p: GetTheDriftParams, tiltDeg: number): { centreDir: Vec3; distance: number } {
  const { starts } = beatStarts(p);
  const final = EARTH_RADIUS + p.orbitAltitude;
  const k = clamp01((t - starts.earth) / Math.max(1e-6, p.earthApproach));
  const distance = final * Math.exp(Math.log(p.earthFar) * (1 - ramped(k, 0.15, 0.3)));
  const finalRadius = (Math.asin(EARTH_RADIUS / final) * 180) / Math.PI;
  const dawn = smooth((t - starts.earth - p.earthApproach) / Math.max(1e-6, p.earth - p.earthApproach));
  // it first shows front right, a third of it sunlit (a point beside the Sun would show its night side:
  // a dark dot, not a blue one), and it slides down to the front only once it is big enough to stay on the
  // dome while its centre goes below the dome's edge
  const beside = domeDir(p.approachEl - 23, p.approachAz + 85, tiltDeg);
  const below = domeDir(p.limbEl - finalRadius - p.dawnSink * dawn, 0, tiltDeg);
  // the flood and Drift-2: ONE eased glide from the orbit down to the water — forward and down at once (the
  // planet's centre keeps sinking below the front as it comes closer), no stop and dive: through the flood
  // we pass the "tectonic" heights (~100 km) watching the sea rise, and settle low over the spiral
  const descent = Math.max(1e-6, p.flood + p.drift2);
  const dk = ramped(clamp01((t - starts.flood) / descent), 0.25, 0.3);
  const altitude = p.orbitAltitude * Math.exp(Math.log(p.driftAltitude / p.orbitAltitude) * dk);
  const dip = (Math.acos(EARTH_RADIUS / (EARTH_RADIUS + altitude)) * 180) / Math.PI;
  const lowCentre = domeDir(p.floodLimbEl - (90 - dip), 0, tiltDeg);
  if (t <= starts.flood) return { centreDir: slerp(beside, below, smooth((k - 0.3) / 0.7)), distance };
  return { centreDir: slerp(below, lowCentre, smooth(dk / 0.6)), distance: EARTH_RADIUS + altitude };
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
  return {
    pole: sign > 0 ? pole : (pole.map((x) => -x) as Vec3),
    start,
    times: [starts.earth + p.earthApproach, starts.timewave, tSet, tRise, starts.drift2 + p.drift2],
    angles: [0, Math.min(top + 25 * D, (top + set) / 2), set + 4 * D, rise + 4 * D, 2 * Math.PI],
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
