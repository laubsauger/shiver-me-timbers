/**
 * CPU mirror of the TSL procedural noise in src/terrain/noise.ts (§V16, T27).
 *
 * ZERO three.js imports on purpose: tests (tests/terrain.test.ts) import this
 * module to prove the math is deterministic, bounded and NaN-free. The shader
 * side uses the exact same formulas (Hoskins-style sin-free hash → value noise
 * → normalized fbm); any change here MUST be made in noise.ts too and vice
 * versa. CPU runs in f64, GPU in f32, so values are structurally identical but
 * not bit-exact — properties (range, determinism, continuity) are shared.
 *
 * Ranges: hash/valueNoise/fbm all return [0, 1]. NaN in noise = black holes
 * in terrain, hence the sweep tests over negative and large coordinates.
 */

/** GLSL/WGSL fract: x - floor(x), result in [0, 1) for finite x */
export function fractCpu(x: number): number {
  return x - Math.floor(x);
}

/** sin-free 2D→1D hash (Dave Hoskins hash12 constants), output [0, 1) */
export function hash2Cpu(x: number, y: number): number {
  let px = fractCpu(x * 0.1031);
  let py = fractCpu(y * 0.1031);
  let pz = fractCpu(x * 0.1031);
  const d = px * (py + 33.33) + py * (pz + 33.33) + pz * (px + 33.33);
  px += d;
  py += d;
  pz += d;
  return fractCpu((px + py) * pz);
}

/** sin-free 3D→1D hash (Dave Hoskins hash13 constants), output [0, 1) */
export function hash3Cpu(x: number, y: number, z: number): number {
  let px = fractCpu(x * 0.1031);
  let py = fractCpu(y * 0.1031);
  let pz = fractCpu(z * 0.1031);
  const d = px * (pz + 31.32) + py * (py + 31.32) + pz * (px + 31.32);
  px += d;
  py += d;
  pz += d;
  return fractCpu((px + py) * pz);
}

/** quintic fade curve (Perlin): 6t⁵ − 15t⁴ + 10t³, C2-continuous at 0 and 1 */
export function fadeCpu(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** 2D value noise: hashed lattice + quintic interpolation, output [0, 1] */
export function valueNoise2Cpu(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fadeCpu(fx);
  const uy = fadeCpu(fy);
  const a = hash2Cpu(ix, iy);
  const b = hash2Cpu(ix + 1, iy);
  const c = hash2Cpu(ix, iy + 1);
  const d = hash2Cpu(ix + 1, iy + 1);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uy);
}

/**
 * 2D fbm: `octaves` layers of value noise, frequency ×lacunarity and
 * amplitude ×gain per octave, normalized by total amplitude → output [0, 1].
 */
export function fbm2Cpu(
  x: number,
  y: number,
  octaves: number,
  lacunarity = 2,
  gain = 0.5,
): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise2Cpu(fx, fy) * amp;
    norm += amp;
    fx *= lacunarity;
    fy *= lacunarity;
    amp *= gain;
  }
  return sum / norm;
}
