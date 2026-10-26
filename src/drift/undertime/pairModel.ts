/**
 * Undertime pair model — "bubble-chamber cosmos" (art direction chosen 2026-10-26).
 *
 * A pair is born at a vertex; matter and antimatter leave back to back and, being of opposite charge, curl
 * in OPPOSITE senses around a shared magnetic field, spiralling inward as they lose energy — the twin-spiral
 * signature of pair production in a bubble chamber. At the end of its track each particle annihilates
 * (flash + light shell, flashes.ts); a rare matter track survives as a grain.
 *
 * EXACT, STATELESS PATH. With velocity rotating at ω about the field and decaying at rate k, the in-plane
 * position is the closed form
 *
 *     z(τ) = v · (e^{(i q ω − k) τ} − 1) / (i q ω − k)        (complex plane spanned by u, w)
 *
 * an inward spiral that converges on a point, plus a drift along the field that decays the same way. Every
 * value is a pure function of the slot index and the field clock, so tracks scrub and re-render exactly. The
 * CPU twins `spiralCpu` / `trackPositionCpu` are what tests/undertimePairs.test.ts holds the TSL against.
 *
 * A PAIR'S FATE IS DECIDED AT ITS BIRTH. Density and the field's direction change over the act; a slot reads
 * them at its own birth time (clock − τ), so a living track never pops out or swings round when they change.
 *
 * THE WAVE (direction U3). A front — a plane perpendicular to the dome's front — sweeps from in front of the
 * audience, over them, to the back. A pair it reaches ends its track there and then (its annihilation is on
 * the front), and nothing is born behind it. Arrival is a pure function of the vertex, so this is stateless
 * too: the front reaches vertex x at clock waveClock0 + waveRate · waveLength · frac(x).
 */
import * as THREE from 'three/webgpu';
import { PI, asin, atan, cos, exp, float, floor, fract, hash, min, mix, normalize, pow, sin, smoothstep, sqrt, step, vec3 } from 'three/tsl';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

export interface PairUniforms {
  /** the field clock (timeline.ts fieldClock), not act time */
  time: F;
  density: F;
  /** d density / d clock right now — a slot reads the density of its own birth */
  densityRate: F;
  life: F;
  radius: F;
  speed: F;
  /** rad/s */
  curl: F;
  /** 1/s */
  drag: F;
  /** rad, the field's lean from the zenith toward the front: `tilt0` until clock `tiltClock0`, turning to
   * `tilt1` by `tiltClock1` (the cooling). A pair keeps the field it was born in. */
  tilt0: F;
  tilt1: F;
  tiltClock0: F;
  tiltClock1: F;
  /** world position of the eye (the camera drifts; the text pocket and the near clearance follow it) */
  eye: V3;
  /** the dome frame (domeMaster.ts domeBasis) — the text pocket is defined in it */
  domeAxis: V3;
  domeFront: V3;
  domeRight: V3;
  /** TEXT POCKET: elevation band (rad) and azimuth half-width (rad) the crawl is passing through, and how
   * strongly the field thins out there (0 = off). Keeps the text on calm sky instead of the busiest. */
  pocketLo: F;
  pocketHi: F;
  pocketAz: F;
  pocket: F;
  /** the wave front: field clock it starts at, its rate (field-s per act-s) and its act-time length */
  waveClock0: F;
  waveRate: F;
  waveLength: F;
}

/** the part of the uniforms the text pocket reads (grains.ts uses it too) */
export type PocketUniforms = Pick<PairUniforms, 'domeAxis' | 'domeFront' | 'domeRight' | 'pocketLo' | 'pocketHi' | 'pocketAz' | 'pocket'>;

/**
 * 0..1: how calm the field should be in this direction (from the eye) for the text to read.
 *
 * A SOFT ELLIPSE centred on the text, not a band with edges: radii are the text's own half-extent (azimuth
 * half-width, half the elevation band), fully calm inside ~0.4 of that and fading to nothing at ~1.6 — wide
 * enough that the eye never finds an outline. A hard-edged region reads as a cut-out box on a dome.
 */
export function pocketMask(dir: V3, U: PocketUniforms): F {
  const d = normalize(dir);
  const el = asin(d.dot(U.domeAxis).clamp(-1, 1));
  const az = atan(d.dot(U.domeRight), d.dot(U.domeFront));
  const centre = U.pocketLo.add(U.pocketHi).mul(0.5);
  const halfEl = U.pocketHi.sub(U.pocketLo).mul(0.5).max(0.05);
  const dEl = el.sub(centre).div(halfEl);
  const dAz = az.div(U.pocketAz.max(0.05));
  const r = sqrt(dEl.mul(dEl).add(dAz.mul(dAz)));
  return float(1).sub(smoothstep(0.4, 1.6, r)).mul(U.pocket);
}

/** CPU twin of the in-plane spiral: [along u, along w] at time τ (tests) */
export function spiralCpu(tau: number, v: number, omega: number, k: number, q: number): [number, number] {
  const a = -k;
  const b = q * omega;
  const ea = Math.exp(a * tau);
  const nr = ea * Math.cos(b * tau) - 1;
  const ni = ea * Math.sin(b * tau);
  const d = a * a + b * b;
  return [(v * (nr * a + ni * b)) / d, (v * (ni * a - nr * b)) / d];
}

/** random unit vector from two hashes */
export const randomDir = (a: F, b: F): V3 => {
  const z = a.mul(2).sub(1);
  const phi = b.mul(PI.mul(2));
  const rxy = sqrt(float(1).sub(z.mul(z)).max(0));
  return vec3(rxy.mul(cos(phi)), z, rxy.mul(sin(phi)));
};

export interface PairSlot {
  /** seconds since this cycle's birth */
  tau: F;
  /** this cycle's length, s */
  period: F;
  /** 1 while the slot is alive this cycle */
  alive: F;
  /** per-cycle seed */
  seed: F;
  vertex: V3;
  /** matter's launch direction (antimatter leaves along −dir) */
  dir: V3;
  v: F;
  omega: F;
  k: F;
  /** unit, the field this pair curls around (the field at its birth) */
  field: V3;
  /** s of track time the tracks run before they annihilate; the rest of the period is the light */
  tEnd: F;
  /** 1 when the wave front ended this track (its light is part of the front) */
  forced: F;
}

/** the field direction for a lean of `tilt` rad from the zenith toward the front (−Z) */
const fieldOf = (tilt: F): V3 => vec3(0, cos(tilt), sin(tilt).negate());

/** 0..1, how far through its sweep the wave front is when it reaches world point `x` */
export function waveFrac(x: V3, U: PairUniforms): F {
  return U.radius.sub(x.sub(U.eye).dot(U.domeFront)).div(U.radius.mul(2)).clamp(0, 1);
}

/** lifecycle and launch parameters of pair slot `slot` (a float node) */
export function pairSlot(slot: F, U: PairUniforms): PairSlot {
  const period = U.life.mul(hash(slot.mul(1.37).add(0.11)).mul(0.6).add(0.7));
  const phase = U.time.add(hash(slot.mul(2.71).add(0.33)).mul(period)).div(period);
  const cycle = floor(phase);
  const seed = slot.mul(7.13).add(cycle.mul(131.7));
  const tau = fract(phase).mul(period);
  const birth = U.time.sub(tau);
  const radius = U.radius.mul(pow(hash(seed.add(3)), float(1 / 3)).mul(0.85).add(0.15));
  const vertex = randomDir(hash(seed.add(1)), hash(seed.add(2))).mul(radius);
  const tilt = mix(U.tilt0, U.tilt1, smoothstep(U.tiltClock0, U.tiltClock1, birth));
  // the wave: a track the front reaches ends there; a pair is never born behind it
  const natural = period.mul(0.72);
  const cut = U.waveClock0.add(U.waveRate.mul(U.waveLength).mul(waveFrac(vertex, U))).sub(birth);
  const toEye = vertex.sub(U.eye);
  const alive = step(hash(seed.add(0.5)), U.density.sub(U.densityRate.mul(tau)))
    // not where the crawl is passing (the text pocket), so the text sits on darkness
    .mul(float(1).sub(pocketMask(toEye, U)))
    .mul(step(0, cut))
    // nothing is born right on top of the audience: a pair across the eye is a smear over half the dome
    .mul(smoothstep(1.2, 3, toEye.length()));
  return {
    tau,
    period,
    alive,
    seed,
    vertex,
    dir: randomDir(hash(seed.add(4)), hash(seed.add(5))),
    v: U.speed.mul(hash(seed.add(6)).mul(1.4).add(0.6)),
    omega: U.curl.mul(hash(seed.add(7)).mul(1.2).add(0.6)),
    k: U.drag.mul(hash(seed.add(8)).mul(0.8).add(0.6)),
    field: fieldOf(tilt),
    tEnd: min(natural, cut.max(0.02)),
    forced: step(cut, natural),
  };
}

export interface HeroUniforms {
  /** act time (the cold open runs on act time; the field clock equals it there) */
  time: F;
  birth: F;
  vertex: V3;
  dir: V3;
  field: V3;
  v: F;
  omega: F;
  k: F;
  tEnd: F;
}

/** U0's hero pair: one scripted slot, the same tracks and light as every other pair */
export function heroSlot(H: HeroUniforms): PairSlot {
  return {
    tau: H.time.sub(H.birth),
    // the light lingers 3.5 s after the annihilation (flashes.ts `left`)
    period: H.tEnd.add(3.5),
    alive: float(1),
    seed: float(17.31),
    vertex: H.vertex,
    dir: H.dir,
    v: H.v,
    omega: H.omega,
    k: H.k,
    field: H.field,
    tEnd: H.tEnd,
    forced: float(1),
  };
}

/**
 * Position of a particle of charge q (±1) at track time τ (clamped to the track's end by the caller).
 * Antimatter launches along −dir; the field component of the launch drifts and decays like the in-plane part.
 */
export function trackPosition(P: PairSlot, q: F, tau: F): V3 {
  const field = P.field;
  const d = P.dir.mul(q); // back to back
  const par = d.dot(field);
  const perp = d.sub(field.mul(par));
  const u = perp.normalize();
  const w = field.cross(u);
  const a = P.k.negate();
  const b = q.mul(P.omega);
  const ea = exp(a.mul(tau));
  const nr = ea.mul(cos(b.mul(tau))).sub(1);
  const ni = ea.mul(sin(b.mul(tau)));
  const den = a.mul(a).add(b.mul(b));
  const vPerp = P.v.mul(perp.length());
  const x = vPerp.mul(nr.mul(a).add(ni.mul(b))).div(den);
  const y = vPerp.mul(ni.mul(a).sub(nr.mul(b))).div(den);
  const drift = P.v.mul(par).mul(float(1).sub(ea)).div(P.k);
  return P.vertex.add(u.mul(x)).add(w.mul(y)).add(field.mul(drift));
}

type Vec3 = [number, number, number];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** CPU twin of `trackPosition` (the hero's annihilation points, for the sky's light shells; tests) */
export function trackPositionCpu(
  P: { vertex: Vec3; dir: Vec3; field: Vec3; v: number; omega: number; k: number },
  q: number,
  tau: number,
): Vec3 {
  const f = P.field;
  const d: Vec3 = [P.dir[0] * q, P.dir[1] * q, P.dir[2] * q];
  const par = dot(d, f);
  const perp: Vec3 = [d[0] - f[0] * par, d[1] - f[1] * par, d[2] - f[2] * par];
  const pl = Math.hypot(perp[0], perp[1], perp[2]) || 1;
  const u: Vec3 = [perp[0] / pl, perp[1] / pl, perp[2] / pl];
  const w: Vec3 = [f[1] * u[2] - f[2] * u[1], f[2] * u[0] - f[0] * u[2], f[0] * u[1] - f[1] * u[0]];
  const [x, y] = spiralCpu(tau, P.v * pl, P.omega, P.k, q);
  const drift = (P.v * par * (1 - Math.exp(-P.k * tau))) / P.k;
  return [0, 1, 2].map((i) => P.vertex[i] + u[i] * x + w[i] * y + f[i] * drift) as Vec3;
}
