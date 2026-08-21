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

// ─────────────────────────────────────────────────────────────────────────────
// T112c: GRADIENT NOISE WITH ANALYTIC DERIVATIVES + STRUCTURED TURBULENCE
//
// Value fbm is isotropic cloud; it cannot make a ridgeline or a gully (see
// docs/raft2100/terrain-research.md §2.1). The erosion bake needs noise whose
// finer octaves know the slope they sit on: de Carpentier's Swiss / Jordan
// turbulence damps and warps octaves by the accumulated derivative, which is
// what reads as glaciated ridges and gullies from noise alone. Everything here
// is deterministic (the same sin-free hash as above, no Math.random) and has a
// TSL twin in noise.ts (gradNoise2, fbmDeriv2, swissTurbulence2) — keep them in
// step. Ridged / Jordan / domain-warp are CPU-only for now (the height bake is
// CPU; T112d's shader wants gradNoise2 + swiss only) — documented gap.
//
// Ranges: gradNoise2Cpu.v ∈ [-1, 1] (√2-normalised Perlin), derivatives are
// d/dx and d/dy of v in the noise's own units.
// ─────────────────────────────────────────────────────────────────────────────

/** value + analytic gradient of a 2D scalar field */
export interface NoiseDeriv {
  v: number;
  dx: number;
  dy: number;
}

/** derivative of the quintic fade: 30t²(t−1)² */
export function fadeDerivCpu(t: number): number {
  const u = t - 1;
  return 30 * t * t * u * u;
}

/** lattice gradient: a unit vector at a hashed angle — same hash as the value noise */
function gradAt(ix: number, iy: number): [number, number] {
  const a = hash2Cpu(ix, iy) * Math.PI * 2;
  return [Math.cos(a), Math.sin(a)];
}

const SQRT2 = Math.SQRT2;

/**
 * 2D Perlin gradient noise with analytic derivatives. Bilinear in the fade
 * weights, so d/dx carries the fade derivative on the x-blend and the
 * gradient's own x on the corners (and symmetrically for y).
 */
export function gradNoise2Cpu(x: number, y: number): NoiseDeriv {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const [gax, gay] = gradAt(ix, iy);
  const [gbx, gby] = gradAt(ix + 1, iy);
  const [gcx, gcy] = gradAt(ix, iy + 1);
  const [gdx, gdy] = gradAt(ix + 1, iy + 1);
  const a = gax * fx + gay * fy;
  const b = gbx * (fx - 1) + gby * fy;
  const c = gcx * fx + gcy * (fy - 1);
  const d = gdx * (fx - 1) + gdy * (fy - 1);
  const u = fadeCpu(fx);
  const v = fadeCpu(fy);
  const du = fadeDerivCpu(fx);
  const dv = fadeDerivCpu(fy);
  const k1 = b - a;
  const k2 = c - a;
  const k3 = a - b - c + d;
  const val = a + u * k1 + v * k2 + u * v * k3;
  const dxv =
    gax + u * (gbx - gax) + v * (gcx - gax) + u * v * (gax - gbx - gcx + gdx) + du * (k1 + v * k3);
  const dyv =
    gay + u * (gby - gay) + v * (gcy - gay) + u * v * (gay - gby - gcy + gdy) + dv * (k2 + u * k3);
  return { v: val * SQRT2, dx: dxv * SQRT2, dy: dyv * SQRT2 };
}

/**
 * fbm of gradient noise with the summed derivative carried along (chain rule
 * through the per-octave frequency). Output v ∈ [-1, 1] (normalised).
 */
export function fbmDeriv2Cpu(
  x: number,
  y: number,
  octaves: number,
  lacunarity = 2,
  gain = 0.5,
): NoiseDeriv {
  let sum = 0;
  let dx = 0;
  let dy = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = gradNoise2Cpu(x * freq, y * freq);
    sum += n.v * amp;
    dx += n.dx * amp * freq;
    dy += n.dy * amp * freq;
    norm += amp;
    freq *= lacunarity;
    amp *= gain;
  }
  return { v: sum / norm, dx: dx / norm, dy: dy / norm };
}

/** Musgrave ridged multifractal: 1 − |n| per octave, sharp crests. Output [0, 1]. */
export function ridged2Cpu(
  x: number,
  y: number,
  octaves: number,
  lacunarity = 2,
  gain = 0.5,
): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = gradNoise2Cpu(x * freq, y * freq);
    const r = 1 - Math.abs(n.v);
    sum += r * r * amp;
    norm += amp;
    freq *= lacunarity;
    amp *= gain;
  }
  return sum / norm;
}

/**
 * de Carpentier's SWISS turbulence: ridged octaves, each warped by the
 * accumulated derivative of the previous ones (`warp`) and gain-damped where
 * the sum is already high — ridgelines stay sharp, flanks get smeared
 * downhill. Output [0, 1].
 */
export function swissTurbulence2Cpu(
  x: number,
  y: number,
  octaves: number,
  lacunarity = 2,
  gain = 0.5,
  warp = 0.15,
): number {
  let sum = 0;
  let dsx = 0;
  let dsy = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = gradNoise2Cpu((x + warp * dsx) * freq, (y + warp * dsy) * freq);
    sum += amp * (1 - Math.abs(n.v));
    dsx += amp * n.dx * -n.v;
    dsy += amp * n.dy * -n.v;
    norm += amp;
    freq *= lacunarity;
    amp *= gain * Math.min(Math.max(sum / norm, 0), 1);
  }
  return norm > 0 ? sum / norm : 0;
}

/**
 * de Carpentier's JORDAN turbulence: ridged squares with the octave gain
 * damped by the accumulated gradient (`damp`) so steep ground stays smooth —
 * gullies on the flanks, rounded crests. Output [0, 1].
 */
export function jordanTurbulence2Cpu(
  x: number,
  y: number,
  octaves: number,
  lacunarity = 2,
  gain = 0.5,
  warp = 0.3,
  damp = 1.0,
): number {
  let n = gradNoise2Cpu(x, y);
  let n2v = n.v * n.v;
  let sum = n2v;
  let dsumWx = n.dx * 2 * n.v;
  let dsumWy = n.dy * 2 * n.v;
  let dsumDx = dsumWx;
  let dsumDy = dsumWy;
  let amp = gain;
  let freq = lacunarity;
  let dampedAmp = amp;
  let norm = 1;
  for (let i = 1; i < octaves; i++) {
    n = gradNoise2Cpu(x * freq + warp * dsumWx, y * freq + warp * dsumWy);
    n2v = n.v * n.v;
    sum += dampedAmp * n2v;
    norm += amp;
    dsumWx += amp * n.dx * 2 * n.v * freq;
    dsumWy += amp * n.dy * 2 * n.v * freq;
    dsumDx += amp * n.dx * 2 * n.v;
    dsumDy += amp * n.dy * 2 * n.v;
    freq *= lacunarity;
    amp *= gain;
    dampedAmp = amp * (1 - damp / (1 + dsumDx * dsumDx + dsumDy * dsumDy));
  }
  return Math.min(Math.max(sum / norm, 0), 1);
}

/**
 * Quilez domain warp: p' = p + scale·(fbm(p+o1), fbm(p+o2)), then the field
 * at p'. Two fixed offsets keep the two warp channels decorrelated. Output
 * [-1, 1] (fbmDeriv2 value at the warped point).
 */
export function domainWarp2Cpu(
  x: number,
  y: number,
  octaves: number,
  scale = 1.5,
  lacunarity = 2,
  gain = 0.5,
): number {
  const qx = fbmDeriv2Cpu(x, y, octaves, lacunarity, gain).v;
  const qy = fbmDeriv2Cpu(x + 5.2, y + 1.3, octaves, lacunarity, gain).v;
  return fbmDeriv2Cpu(x + scale * qx, y + scale * qy, octaves, lacunarity, gain).v;
}
