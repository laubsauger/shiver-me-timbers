/**
 * Drift-2 (direction-part-b.md, B5): what the flood lifted — wood, wrack, the silt of drowned fields —
 * floating on the new sea and gathered by the currents into slow spirals, like galaxies on the water. The
 * film's one shape again: Drift-1's pair spirals, the galaxies, now the sea.
 *
 * Seen from tens of km up, floating matter is not objects but a TRACER: streaks and filaments drawn out by
 * the flow, as in the satellite images of plankton blooms swirling in the Baltic's eddies. So it is a layer
 * of the sea's surface (earth.ts mixes it into the water's colour), not particles.
 *
 * STATELESS SHEAR. The matter starts as patches (washed off the coasts, fbm). The eddy turns faster near its
 * centre than far out (Ω ∝ 1/(r + r0)), and a passive tracer in such a flow is just its first pattern
 * unwound: what is at (r, θ) now was at (r, θ − Ω(r)·τ). The differential rotation shears every patch into
 * a trailing spiral filament — the same winding that draws a galaxy's arms — and any frame is a pure
 * function of τ. The filaments thin as the shear grows; their noise fades its octaves finer than the pixel
 * (the shear counted in), so they never shimmer.
 *
 * Coordinates: the tangent plane at the gathering point (Mm), east and north there.
 */
import * as THREE from 'three/webgpu';
import { atan, cos, float, length, mx_noise_float, sin, smoothstep, vec2, vec3 } from 'three/tsl';

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

/** rad/s the eddy's core turns at (its rim much slower) */
const SPIN = 0.075;
/** the eddy: centred on the gathering point, its radius (Mm) — one spiral, clearly read (several overlapped
 * the land and each other and said less) */
const EDDY = { x: 0, y: 0, r: 0.07, s: 1 };

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
 * The eddy as the satellites see one (unit surface normal n): the flood's sediment swirled into the water
 * (`turbid`, 0..1: a soft change of the water's own colour) and the SLICKS — lines where floating matter
 * gathers and calms the small ripples (`slick`, 0..1: the sea's glint runs tighter and brighter along them,
 * the way eddies show in sunglint photographs). No opaque layer: the sea itself carries the spiral.
 * `fp` is the pixel's footprint on the unit sphere, `R` the planet's radius (Mm).
 */
export function driftMatter(n: V3, U: DriftUniforms, fp: F, R: number): { turbid: F; slick: F } {
  const flat = n.sub(U.up.mul(n.dot(U.up)));
  const x = flat.dot(U.east).mul(R);
  const y = flat.dot(U.north).mul(R);
  const fpm = fp.mul(R);
  const e = EDDY;
  const dx = x.sub(e.x);
  const dy = y.sub(e.y);
  const r = length(vec2(dx, dy));
  const q = r.div(e.r);
  const omega = float(SPIN * e.s).div(q.add(0.25));
  // unwound: where this water was when the flood let go
  const th = atan(dy, dx).sub(omega.mul(U.time));
  const ux = cos(th).mul(r);
  const uy = sin(th).mul(r);
  // the shear (rad of winding per unit ln r) thins everything it winds: the noise fades sooner
  const shear = float(SPIN * Math.abs(e.s)).mul(q).div(q.add(0.25).mul(q.add(0.25))).mul(U.time);
  const fine = fpm.mul(shear.add(1));
  // the sediment: broad, soft plumes wound into arms; the eddy's rim fades into the open sea
  const plume = fbm2(ux, uy, 22, 6, fine, 7.7);
  const turbid = smoothstep(-0.35, 0.45, plume).mul(smoothstep(2.4, 0.3, q)).mul(U.presence) as F;
  // the slicks: thin lines where a finer field crosses zero, wound into spiral filaments
  const field = fbm2(ux, uy, 70, 7, fine, 3.1);
  const ridge = float(1).sub(field.abs().mul(5)).max(0);
  const slick = ridge.mul(ridge).mul(ridge).mul(smoothstep(2.0, 0.3, q)).mul(U.presence) as F;
  return { turbid, slick };
}
