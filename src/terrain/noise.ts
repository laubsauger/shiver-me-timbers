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
