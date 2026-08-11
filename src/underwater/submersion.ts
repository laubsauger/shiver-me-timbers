/**
 * Submersion detection — pure logic, zero three.js imports (§V25).
 *
 * WHY hysteresis: wave chop makes the true waterline oscillate around the
 * camera several times per second. A single threshold would strobe the
 * underwater grade on/off. Instead a dead band of `hysteresisBand` meters
 * around the surface maps to a stable 'crossing' mode; 'above'/'below' are
 * only reached once the camera clears the band, so chop inside the band can
 * never flip between the two extreme modes.
 *
 * WHY rate-limited blend: V25 forbids pops. `blend` (0 = fully above,
 * 1 = fully below) tracks a smoothstep of signed depth across the band but
 * may move at most `maxBlendStep` per tick — even a teleport under water
 * fades the grade in over several ticks.
 *
 * Water height is injected by the caller as a number sampled at the camera
 * (sea-physics provides the sampler later; index.ts defaults it to 0).
 */
import { underwaterParams } from '../params/underwater';

export type SubmersionMode = 'above' | 'crossing' | 'below';

export interface SubmersionState {
  mode: SubmersionMode;
  /** 0..1 underwater effect strength — continuous, never jumps (V25) */
  blend: number;
}

export interface SubmersionConfig {
  /** full height of the dead band around the waterline (m), > 0 */
  hysteresisBand: number;
  /** max |Δblend| per tick, > 0 */
  maxBlendStep: number;
}

/** Hermite smoothstep on plain numbers (pure mirror of the TSL one). */
export function smooth01(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Exponential fog amount for a view distance — pure mirror of the grade
 * shader's `1 - exp(-dist * density)`. Monotonic in both args, ∈ [0, 1).
 */
export function expFogFactor(distance: number, density: number): number {
  return 1 - Math.exp(-Math.max(0, distance) * Math.max(0, density));
}

function defaults(): SubmersionConfig {
  return {
    hysteresisBand: underwaterParams.hysteresisBand,
    maxBlendStep: underwaterParams.maxBlendStep,
  };
}

/**
 * Advance the submersion state for one tick.
 * @param cameraY world-space camera height
 * @param waterHeightAtCamera ocean surface height at the camera's XZ
 * @param prev previous state (undefined on first tick → blend snaps once)
 * @param cfg band/step override; defaults come from underwaterParams
 */
export function submersionState(
  cameraY: number,
  waterHeightAtCamera: number,
  prev?: SubmersionState,
  cfg?: Partial<SubmersionConfig>,
): SubmersionState {
  const { hysteresisBand, maxBlendStep } = { ...defaults(), ...cfg };
  const half = Math.max(1e-6, hysteresisBand * 0.5);
  const step = Math.max(1e-6, maxBlendStep);

  // signed depth: positive when the camera is under the surface
  const depth = waterHeightAtCamera - cameraY;

  const mode: SubmersionMode =
    depth > half ? 'below' : depth < -half ? 'above' : 'crossing';

  // continuous target across the band, then rate-limit toward it
  const target = smooth01(-half, half, depth);
  const blend =
    prev === undefined
      ? target
      : Math.min(prev.blend + step, Math.max(prev.blend - step, target));

  return { mode, blend };
}
