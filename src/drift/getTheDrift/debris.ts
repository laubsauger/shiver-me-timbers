/**
 * Drift-2 (direction-part-b.md, B5): what the flood lifted — wood, wrack, the silt of drowned fields —
 * floating on the new sea and gathered by the currents into slow spirals, like galaxies on the water. The
 * film's one shape again: Drift-1's pair spirals, the galaxies, now the sea.
 *
 * Seen from tens of km up, floating matter is not objects but a TRACER: streaks and filaments drawn out by
 * the flow, as in the satellite images of plankton blooms swirling in the Baltic's eddies. So it is a layer
 * of the sea's surface (earth.ts mixes it into the water's colour), not particles.
 *
 * STATELESS SHEAR. The matter starts as patches (washed off the coasts, fbm). Each eddy turns faster near its
 * centre than far out (Ω ∝ 1/(r + r0)), and a passive tracer in such a flow is just its first pattern
 * unwound: what is at (r, θ) now was at (r, θ − Ω(r)·τ). The differential rotation shears every patch into
 * a trailing spiral filament — the same winding that draws a galaxy's arms — and any frame is a pure
 * function of τ. The filaments thin as the shear grows; their noise fades its octaves finer than the pixel
 * (the shear counted in), so they never shimmer.
 *
 * Coordinates: the tangent plane at the gathering point (Mm), east and north there.
 */
import * as THREE from 'three/webgpu';
import { atan, cos, exp, float, floor, hash, length, max, mx_noise_float, sin, smoothstep, step, vec2, vec3 } from 'three/tsl';
import { rng } from '../undertime/web';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

export interface DriftUniforms {
  /** s since the flood lifted the matter */
  time: F;
  /** 0..1 how much has floated free */
  presence: F;
  /** unit: the gathering point's outward normal, and two tangents spanning its plane */
  up: V3;
  east: V3;
  north: V3;
}

const EDDIES = 6;
/** rad/s an eddy's core turns at (its rim much slower) */
const SPIN = 0.075;

/** the eddies: centre (Mm, in the plane), radius (Mm), turn (signed) — a fixed seeded set */
function eddies(): Array<{ x: number; y: number; r: number; s: number }> {
  const r = rng(2026);
  return Array.from({ length: EDDIES }, (_, i) => {
    const a = r() * Math.PI * 2;
    const d = i === 0 ? 0 : 0.05 + r() * 0.17;
    return { x: Math.cos(a) * d, y: Math.sin(a) * d, r: 0.025 + r() * 0.06, s: (r() < 0.5 ? -1 : 1) * (0.6 + r() * 0.6) };
  });
}

/** fbm in the plane (Mm), octaves finer than `fp` (Mm) faded out */
function fbm2(x: F, y: F, f0: number, octaves: number, fp: F, seed: number): F {
  let sum: F = float(0);
  let f = f0;
  let a = 1;
  for (let i = 0; i < octaves; i++) {
    const w = float(1).sub(smoothstep(0.25, 0.5, fp.mul(f)));
    sum = sum.add(mx_noise_float(vec3(x.mul(f), y.mul(f), seed + i * 1.7)).mul(a).mul(w)) as F;
    f *= 2.07;
    a *= 0.55;
  }
  return sum;
}

/**
 * The floating matter at unit surface normal n: `cover` 0..1 (how much of the water's surface it hides) and
 * `specks` (sunlit floating things too small to see but for their glints). `fp` is the pixel's footprint on
 * the unit sphere, `R` the planet's radius (Mm).
 */
export function driftMatter(n: V3, U: DriftUniforms, fp: F, R: number): { cover: F; specks: F } {
  const flat = n.sub(U.up.mul(n.dot(U.up)));
  const x = flat.dot(U.east).mul(R);
  const y = flat.dot(U.north).mul(R);
  const fpm = fp.mul(R);
  let cover: F = float(0);
  let weight: F = float(1e-4);
  for (const e of eddies()) {
    const dx = x.sub(e.x);
    const dy = y.sub(e.y);
    const r = length(vec2(dx, dy));
    const q = r.div(e.r);
    const omega = float(SPIN * e.s).div(q.add(0.25));
    // unwound: where this water was when the matter lifted
    const th = atan(dy, dx).sub(omega.mul(U.time));
    const ux = cos(th).mul(r);
    const uy = sin(th).mul(r);
    // the shear (rad of winding per unit ln r) thins the filaments: their noise fades sooner
    const shear = float(SPIN * Math.abs(e.s)).mul(q).div(q.add(0.25).mul(q.add(0.25))).mul(U.time);
    const fine = fpm.mul(shear.add(1));
    // patches of debris (~2–10 km) with streaky detail, sparse
    const patches = fbm2(ux, uy, 120, 7, fine, e.x * 31 + e.y * 17);
    const here = smoothstep(0.02, 0.3, patches).mul(smoothstep(1.6, 0.2, q));
    const w = exp(q.mul(q).negate());
    cover = cover.add(here.mul(w)) as F;
    weight = weight.add(w) as F;
  }
  cover = cover.div(max(weight, float(0.35))).mul(U.presence).clamp(0, 1) as F;
  // the specks: ~100 m cells, one floating thing in some where there is matter
  const cell = floor(vec3(x, y, 0).mul(9000));
  const h = hash(cell.x.add(cell.y.mul(311)));
  const resolved = smoothstep(2 / 9000, 0.7 / 9000, fpm);
  const specks = step(h, cover.mul(0.3)).mul(resolved).add(cover.mul(0.3).mul(float(1).sub(resolved)));
  return { cover, specks: specks as F };
}
