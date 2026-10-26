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

export const BEATS = ['galaxies', 'ours', 'band', 'sun', 'earth'] as const;
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
  /** 0..1 the web's knots opening into galaxies */
  open: number;
  /** 0..1 our galaxy as a volume around us (1 − this is its far impostor) */
  volume: number;
  /** 0..1 the stars near the Sun point (parallax field inside the disk) */
  local: number;
  /** distance to the Sun point as a fraction of the start: 1 → insideKeep → less in the sun beat */
  f: number;
  /** 0..1 the Sun standing out as one star */
  sunStar: number;
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
  // the sun beat: on toward the Sun point, eased at both ends
  const sunK = clamp01((t - starts.sun) / Math.max(1e-6, p.sun));
  lnF += Math.log(0.05) * ramped(sunK, 0.25, 0.25);
  const f = Math.exp(lnF);
  return {
    beat,
    u,
    open: smooth(t / (p.overlap + 3)),
    // the volume takes over from the impostor while still ~3 radii out: closer than ~1.5 radii the flat
    // impostor would wrap under the eye and show its plane's horizon as an edge
    volume: smooth((Math.log(1 / f) - 0.4) / 1.0),
    local: smooth((Math.log(1 / f) - 4.5) / 2.5),
    f,
    sunStar: smooth((t - starts.sun) / Math.max(1e-6, p.sun * 0.7)),
  };
}

/** the eye at act time t: on the line E0 → Sun point, at fraction f of the starting distance */
export function arrivalEye(t: number, p: GetTheDriftParams, g: OurGalaxy): Vec3 {
  const { f } = arrivalState(t, p);
  return [0, 1, 2].map((i) => g.sun[i] + (g.e0[i] - g.sun[i]) * f) as Vec3;
}
