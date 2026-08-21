/**
 * TSL procedural noise for terrain materials (§V16, T27): sin-free hash →
 * value noise → normalized fbm, plus a tri-planar fbm helper so meshes need
 * no UVs. Usable from any node material (rock, sand, later waterfall foam).
 *
 * MIRROR CONTRACT: src/terrain/noiseCpu.ts implements the exact same formulas
 * in pure TypeScript (no three imports) and is what tests/terrain.test.ts
 * verifies. Shader (f32) and CPU (f64) are structurally identical, not
 * bit-exact; determinism, [0,1] range and NaN-freedom carry over. Change one
 * side → change the other.
 *
 * All outputs in [0, 1]. Octave count / lacunarity / gain are JS-side build
 * constants sourced from params/terrain.ts (changing octaves rebuilds the
 * material node graph; the rest are baked per-octave frequencies).
 */
import { Fn, float, mix, vec2, vec3 } from 'three/tsl';

/** sin-free 2D→1D hash (Hoskins hash12), output [0, 1) */
export const hash2 = /*@__PURE__*/ Fn(([p]: any[]) => {
  const p3 = vec3(p.x, p.y, p.x).mul(0.1031).fract().toVar();
  p3.addAssign(p3.dot(p3.yzx.add(33.33)));
  return p3.x.add(p3.y).mul(p3.z).fract();
});

/** sin-free 3D→1D hash (Hoskins hash13), output [0, 1) */
export const hash3 = /*@__PURE__*/ Fn(([p]: any[]) => {
  const p3 = p.mul(0.1031).fract().toVar();
  p3.addAssign(p3.dot(p3.zyx.add(31.32)));
  return p3.x.add(p3.y).mul(p3.z).fract();
});

/** quintic fade 6t⁵−15t⁴+10t³ (componentwise) */
export const fade = /*@__PURE__*/ Fn(([t]: any[]) =>
  t.mul(t).mul(t).mul(t.mul(t.mul(6).sub(15)).add(10)),
);

/** 2D value noise: hashed lattice corners + quintic interpolation, [0, 1] */
export const valueNoise2 = /*@__PURE__*/ Fn(([p]: any[]) => {
  const i = p.floor();
  const f = p.fract();
  const u = fade(f);
  const a = hash2(i);
  const b = hash2(i.add(vec2(1, 0)));
  const c = hash2(i.add(vec2(0, 1)));
  const d = hash2(i.add(vec2(1, 1)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

/**
 * 2D fbm, `octaves` layers (2–4 typical), normalized to [0, 1].
 * Octaves/lacunarity/gain are JS numbers → the loop unrolls at build time,
 * per-octave frequencies are computed in JS exactly like fbm2Cpu.
 */
export function fbm2(p: any, octaves: number, lacunarity = 2, gain = 0.5): any {
  let sum: any = float(0);
  let freq = 1;
  let amp = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum = sum.add(valueNoise2(p.mul(freq)).mul(amp));
    norm += amp;
    freq *= lacunarity;
    amp *= gain;
  }
  return sum.div(norm);
}

/**
 * Tri-planar blend weights from a world normal: pow(|n|, sharpness),
 * normalized to sum 1. Higher sharpness → tighter plane transitions.
 */
export function triplanarWeights(normal: any, sharpness: any): any {
  const w = normal.abs().pow(vec3(sharpness));
  return w.div(w.x.add(w.y).add(w.z));
}

/**
 * Tri-planar fbm: same fbm sampled on the three world planes (ZY, XZ, XY)
 * and blended by triplanarWeights — works on ANY mesh, no UVs required.
 * `pos` is pre-scaled world position, output [0, 1].
 */
export function triplanarFbm(
  pos: any,
  normal: any,
  sharpness: any,
  octaves: number,
  lacunarity = 2,
  gain = 0.5,
): any {
  const w = triplanarWeights(normal, sharpness);
  const nx = fbm2(pos.zy, octaves, lacunarity, gain);
  const ny = fbm2(pos.xz, octaves, lacunarity, gain);
  const nz = fbm2(pos.xy, octaves, lacunarity, gain);
  return nx.mul(w.x).add(ny.mul(w.y)).add(nz.mul(w.z));
}

// ─────────────────────────────────────────────────────────────────────────────
// T112c twins of noiseCpu.ts's gradient noise (for T112d's terrain shading).
// gradNoise2 → vec3(v, dv/dx, dv/dy); fbmDeriv2 → vec3; swissTurbulence2 →
// float [0,1]. Same hash, same fade, same √2 normalisation as the CPU side.
// CPU-only (no twin yet, the bake does not need them in a shader): ridged2Cpu,
// jordanTurbulence2Cpu, domainWarp2Cpu.
// ─────────────────────────────────────────────────────────────────────────────

/** 30t²(t−1)² — derivative of `fade` */
export const fadeDeriv = /*@__PURE__*/ Fn(([t]: any[]) => {
  const u = t.sub(1);
  return t.mul(t).mul(u).mul(u).mul(30);
});

const gradAtNode = (i: any): any => {
  const a = hash2(i).mul(Math.PI * 2);
  return vec2(a.cos(), a.sin());
};

/** 2D Perlin gradient noise with analytic derivatives: vec3(v, dv/dx, dv/dy), v ∈ [-1, 1] */
export const gradNoise2 = /*@__PURE__*/ Fn(([p]: any[]) => {
  const i = p.floor();
  // @band-limited-elsewhere: lattice-cell fraction for gradient noise; callers (fbmDeriv2) are octave-limited by the bake, not a screen-space edge
  const f = p.fract();
  const ga = gradAtNode(i);
  const gb = gradAtNode(i.add(vec2(1, 0)));
  const gc = gradAtNode(i.add(vec2(0, 1)));
  const gd = gradAtNode(i.add(vec2(1, 1)));
  const a = ga.dot(f);
  const b = gb.dot(f.sub(vec2(1, 0)));
  const c = gc.dot(f.sub(vec2(0, 1)));
  const d = gd.dot(f.sub(vec2(1, 1)));
  const u = fade(f.x);
  const v = fade(f.y);
  const du = fadeDeriv(f.x);
  const dv = fadeDeriv(f.y);
  const k1 = b.sub(a);
  const k2 = c.sub(a);
  const k3 = a.sub(b).sub(c).add(d);
  const val = a.add(u.mul(k1)).add(v.mul(k2)).add(u.mul(v).mul(k3));
  const gx = ga.x
    .add(u.mul(gb.x.sub(ga.x)))
    .add(v.mul(gc.x.sub(ga.x)))
    .add(u.mul(v).mul(ga.x.sub(gb.x).sub(gc.x).add(gd.x)))
    .add(du.mul(k1.add(v.mul(k3))));
  const gy = ga.y
    .add(u.mul(gb.y.sub(ga.y)))
    .add(v.mul(gc.y.sub(ga.y)))
    .add(u.mul(v).mul(ga.y.sub(gb.y).sub(gc.y).add(gd.y)))
    .add(dv.mul(k2.add(u.mul(k3))));
  return vec3(val, gx, gy).mul(Math.SQRT2);
});

/** fbm of gradNoise2 with the derivative carried (chain rule through freq); vec3, v ∈ [-1, 1] */
export function fbmDeriv2(p: any, octaves: number, lacunarity = 2, gain = 0.5): any {
  let sum: any = vec3(0);
  let freq = 1;
  let amp = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = gradNoise2(p.mul(freq));
    sum = sum.add(vec3(n.x, n.y.mul(freq), n.z.mul(freq)).mul(amp));
    norm += amp;
    freq *= lacunarity;
    amp *= gain;
  }
  return sum.div(norm);
}

/**
 * Swiss turbulence twin of swissTurbulence2Cpu (octave count unrolled at
 * build time). The sum-driven gain damping is the one data-dependent term,
 * hence the running `sum`/`norm` nodes. Output [0, 1].
 */
export function swissTurbulence2(
  p: any,
  octaves: number,
  lacunarity = 2,
  gain = 0.5,
  warp = 0.15,
): any {
  let sum: any = float(0);
  let norm: any = float(0);
  let ds: any = vec2(0);
  let amp: any = float(1);
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    const n = gradNoise2(p.add(ds.mul(warp)).mul(freq));
    sum = sum.add(amp.mul(float(1).sub(n.x.abs())));
    ds = ds.add(vec2(n.y, n.z).mul(n.x.negate()).mul(amp));
    norm = norm.add(amp);
    freq *= lacunarity;
    // the data-dependent gain damping: amp *= gain · clamp(sum/norm, 0, 1)
    amp = amp.mul(gain).mul(sum.div(norm).clamp(0, 1));
  }
  return sum.div(norm.max(1e-6));
}
