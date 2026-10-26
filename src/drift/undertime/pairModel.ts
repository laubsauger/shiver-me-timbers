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
 * value is a pure function of the slot index and act time, so tracks scrub and re-render exactly. The CPU
 * twin `spiralCpu` is what tests/undertimePairs.test.ts holds the TSL against.
 */
import * as THREE from 'three/webgpu';
import { PI, asin, atan, cos, exp, float, floor, fract, hash, normalize, pow, sin, smoothstep, sqrt, step, vec3 } from 'three/tsl';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

export interface PairUniforms {
  time: F;
  density: F;
  life: F;
  radius: F;
  speed: F;
  /** rad/s */
  curl: F;
  /** 1/s */
  drag: F;
  /** unit, the field the spirals curl around */
  field: V3;
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
}

/**
 * 0..1: how calm the field should be in this direction (from the eye) for the text to read.
 *
 * A SOFT ELLIPSE centred on the text, not a band with edges: radii are the text's own half-extent (azimuth
 * half-width, half the elevation band), fully calm inside ~0.4 of that and fading to nothing at ~1.6 — wide
 * enough that the eye never finds an outline. A hard-edged region reads as a cut-out box on a dome.
 */
export function pocketMask(dir: V3, U: PairUniforms): F {
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
  /** fraction of the period spent on the track; the rest is the annihilation */
  trackEnd: F;
}

/** lifecycle and launch parameters of pair slot `slot` (a float node) */
export function pairSlot(slot: F, U: PairUniforms): PairSlot {
  const period = U.life.mul(hash(slot.mul(1.37).add(0.11)).mul(0.6).add(0.7));
  const phase = U.time.add(hash(slot.mul(2.71).add(0.33)).mul(period)).div(period);
  const cycle = floor(phase);
  const seed = slot.mul(7.13).add(cycle.mul(131.7));
  const radius = U.radius.mul(pow(hash(seed.add(3)), float(1 / 3)).mul(0.85).add(0.15));
  const vertex = randomDir(hash(seed.add(1)), hash(seed.add(2))).mul(radius);
  return {
    tau: fract(phase).mul(period),
    period,
    // a pair is not born where the crawl is passing (the text pocket), so the text sits on darkness
    alive: step(hash(seed.add(0.5)), U.density).mul(float(1).sub(pocketMask(vertex, U))),
    seed,
    vertex,
    dir: randomDir(hash(seed.add(4)), hash(seed.add(5))),
    v: U.speed.mul(hash(seed.add(6)).mul(1.4).add(0.6)),
    omega: U.curl.mul(hash(seed.add(7)).mul(1.2).add(0.6)),
    k: U.drag.mul(hash(seed.add(8)).mul(0.8).add(0.6)),
    trackEnd: float(0.72),
  };
}

/**
 * Position of a particle of charge q (±1) at track time τ (clamped to the track's end by the caller).
 * Antimatter launches along −dir; the field component of the launch drifts and decays like the in-plane part.
 */
export function trackPosition(P: PairSlot, q: F, tau: F, field: V3): V3 {
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
