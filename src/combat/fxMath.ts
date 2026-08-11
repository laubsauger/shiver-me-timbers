/**
 * Pure particle math for the combat fx pool — no three.js, so the burst
 * shapes and the decay are unit-testable headlessly and the render module
 * stays a thin buffer-filling shell.
 *
 * §V.28 is the reason this is its own file: §B.5 was a NaN particle age
 * dividing to a NaN sprite size, which rasterized ×4096 additive quads and
 * read as a browser hang. Every division here has a floored divisor and
 * every spawn is finite-guarded at the boundary, where it can be tested.
 */

export type FxKind = 'flash' | 'smoke' | 'splinter' | 'splash';

export interface FxProfile {
  /** seconds a particle of this kind lives (> 0) */
  life: number;
  /** metres, at birth → at death */
  sizeStart: number;
  sizeEnd: number;
  /** m/s² downward */
  gravity: number;
  /** 1/s exponential velocity bleed */
  drag: number;
  /** linear sRGB-authored tint, additive brightness at birth */
  color: [number, number, number];
  /** initial speed of the burst */
  speed: number;
  /** how much the burst spreads off its axis, 0 = a beam, 1 = a ball */
  spread: number;
}

/** age → 0..1 normalized, with a floored divisor (§V.28) */
export function ageFraction(age: number, life: number): number {
  if (!Number.isFinite(age) || !Number.isFinite(life)) return 1;
  const t = age / Math.max(life, 1e-4);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * Sprite size at a normalized age. Dead particles return EXACTLY 0 — §V.28
 * requires dead particles to be zero-SIZE rather than merely transparent,
 * because an opacity-0 quad is still rasterized and still costs fill rate.
 */
export function sizeAt(profile: FxProfile, t: number): number {
  if (t >= 1) return 0;
  const s = profile.sizeStart + (profile.sizeEnd - profile.sizeStart) * t;
  return Number.isFinite(s) && s > 0 ? s : 0;
}

/** additive brightness over life: quick bloom, then a fade to nothing */
export function brightnessAt(t: number): number {
  if (t >= 1 || t < 0) return 0;
  const rise = Math.min(1, t / 0.08); // floored: 0.08 is a literal, never 0
  return rise * (1 - t) * (1 - t);
}

/**
 * One particle step, semi-implicit Euler with exponential drag. Returns the
 * new velocity; caller integrates position with it (matching ballistics, so
 * a splinter and a cannonball obey the same integrator convention).
 */
export function stepVelocity(
  vx: number, vy: number, vz: number,
  profile: FxProfile,
  dt: number,
): [number, number, number] {
  const keep = Math.exp(-Math.max(0, profile.drag) * dt);
  return [vx * keep, (vy - profile.gravity * dt) * keep, vz * keep];
}

/**
 * Deterministic unit burst direction around `axis`, index-keyed. Uses a
 * golden-angle spiral rather than an rng so the same event always throws the
 * same debris — cheap, and it replays identically for a netcode spectator.
 * `spread` 0 keeps every particle on the axis, 1 gives a full hemisphere.
 */
export function burstDirection(
  axis: readonly [number, number, number],
  index: number,
  spread: number,
): [number, number, number] {
  const ax = finite(axis[0]);
  const ay = finite(axis[1]);
  const az = finite(axis[2]);
  const len = Math.hypot(ax, ay, az);
  // a zero axis would divide to NaN and send a burst to Infinity
  const nx = len > 1e-6 ? ax / len : 0;
  const ny = len > 1e-6 ? ay / len : 1;
  const nz = len > 1e-6 ? az / len : 0;

  const s = clamp01(spread);
  if (s <= 0) return [nx, ny, nz];

  // orthonormal basis around the axis
  const helper: [number, number, number] = Math.abs(ny) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let ux = ny * helper[2] - nz * helper[1];
  let uy = nz * helper[0] - nx * helper[2];
  let uz = nx * helper[1] - ny * helper[0];
  const ul = Math.max(1e-6, Math.hypot(ux, uy, uz)); // floored divisor
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const vx = ny * uz - nz * uy;
  const vy = nz * ux - nx * uz;
  const vz = nx * uy - ny * ux;

  const golden = 2.399963229728653;
  const phi = index * golden;
  // deterministic radial stagger keeps a burst from banding into a ring
  const r = Math.sqrt(((index * 0.6180339887) % 1)) * s;
  const cone = Math.sqrt(Math.max(0, 1 - r * r));
  const cx = Math.cos(phi) * r;
  const cy = Math.sin(phi) * r;

  return [
    nx * cone + ux * cx + vx * cy,
    ny * cone + uy * cx + vy * cy,
    nz * cone + uz * cx + vz * cy,
  ];
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function finite(x: number): number {
  return Number.isFinite(x) ? x : 0;
}
