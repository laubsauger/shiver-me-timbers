/**
 * Pure CPU mirrors of the ship-wake GPU math (§V10 follow-up) — ZERO three
 * imports, same mirror contract as flowMath.ts. GPU twin:
 * wakeInjection.wakeRateNode; change one side → change the other.
 */
import { fbm2Cpu } from '../terrain/noiseCpu';
import { FLOW_OCTAVES } from './flowMath';
/** clamped hermite smoothstep — mirror of the TSL smoothstep used on GPU */
export function smoothstepCpu(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** wake tunables subset of FlowFoamParams (pure, structural) */
export interface WakeParams {
  kelvinAngle: number;
  bowIntensity: number;
  sternIntensity: number;
  speedThreshold: number;
  fullWakeSpeed: number;
  slowWakeWidth: number;
  armWidth: number;
  armWidthGrowth: number;
  sternWidth: number;
  wakeRange: number;
  wakeNoiseScale: number;
  wakeNoiseContrast: number;
  wakeBreakup: number;
}

/** ship state + geometry offsets (ship-local z, from blueprint AABBs) */
export interface WakeShip {
  x: number;
  z: number;
  /** heading, three.js rotation.y convention: forward = (sin yaw, cos yaw) in XZ */
  yaw: number;
  /** m/s over water */
  speed: number;
  /** bow point distance ahead of ship origin (m, along forward) */
  bowOffset: number;
  /** stern point offset along forward (m, typically negative) */
  sternOffset: number;
  /** hull width (m) */
  beam: number;
}

/** world XZ → ship-local [along (toward bow), across (starboard +)] */
export function shipLocalCpu(
  wx: number,
  wz: number,
  x: number,
  z: number,
  yaw: number,
): [number, number] {
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  const dx = wx - x;
  const dz = wz - z;
  // right = (fz, −fx): forward rotated −90° about +y
  return [dx * fx + dz * fz, dx * fz - dz * fx];
}

/**
 * Lateral distance from a point to the nearest bow-V arm centerline:
 * sAft meters behind the bow the arms sit at ±sAft·tan(kelvin). |across|
 * folds port onto starboard — the V is symmetric by construction.
 */
export function bowArmDistCpu(sAft: number, across: number, kelvinDeg: number): number {
  return Math.abs(Math.abs(across) - sAft * Math.tan((kelvinDeg * Math.PI) / 180));
}

/**
 * Wake development factor: 0 at/below speedThreshold, 1 at fullWakeSpeed.
 * Scales V-arm intensity AND all wake widths/ranges — slow drift must show
 * only a faint narrow stern churn (no V), full sail the whole pattern.
 */
export function wakeSpeedFactorCpu(speed: number, p: WakeParams): number {
  return smoothstepCpu(p.speedThreshold, p.fullWakeSpeed, speed);
}

/**
 * Deterministic wake ENVELOPE (foam/second, noise-free — port/starboard
 * symmetric by construction, tested): bow V arms (∝ speed·speedFactor, a
 * narrow cut at the stem widening slowly aft) + stern turbulence band
 * (∝ speed², width ≈ beam·widthScale, centerline-peaked). Widths and ranges
 * scale by mix(slowWakeWidth, 1, speedFactor) — never zero, so the
 * smoothstep edges stay well-formed. Injection is local (fades over the
 * scaled wakeRange); advection + decay do the long trailing.
 * GPU twin: wakeInjection.ts, keep formulas identical.
 */
export function wakeEnvelopeCpu(wx: number, wz: number, ship: WakeShip, p: WakeParams): number {
  const gate = smoothstepCpu(p.speedThreshold, p.speedThreshold * 2, ship.speed);
  if (gate === 0) return 0;
  const sf = wakeSpeedFactorCpu(ship.speed, p);
  const widthScale = p.slowWakeWidth + (1 - p.slowWakeWidth) * sf;
  const range = p.wakeRange * widthScale;
  const [along, across] = shipLocalCpu(wx, wz, ship.x, ship.z, ship.yaw);

  const sBow = ship.bowOffset - along; // distance aft of the bow point
  const behindBow = sBow >= 0 ? 1 : 0;
  const armW = (p.armWidth + sBow * p.armWidthGrowth) * widthScale;
  const armMask = 1 - smoothstepCpu(0, armW, bowArmDistCpu(sBow, across, p.kelvinAngle));
  const bowFade = 1 - smoothstepCpu(0, range, sBow);
  // ×sf: the V only develops with speed — a drifting ship cuts no V
  const bow = p.bowIntensity * ship.speed * sf * armMask * bowFade * behindBow;

  const sStern = ship.sternOffset - along; // distance aft of the stern
  const behindStern = sStern >= 0 ? 1 : 0;
  const halfW = ship.beam * p.sternWidth * 0.5 * widthScale;
  const sternMask = 1 - smoothstepCpu(0, halfW, Math.abs(across));
  const sternFade = 1 - smoothstepCpu(0, range, sStern);
  // NOT ×sf: slow drift keeps its faint churn directly aft (speed² is small)
  const stern = p.sternIntensity * ship.speed * ship.speed * sternMask * sternFade * behindStern;

  return (bow + stern) * gate;
}

/** cos(45°) = sin(45°) — math constant for the rotated noise lattice */
export const INV_SQRT2 = Math.SQRT1_2;

/**
 * World-anchored breakup factor ∈ [1 − wakeBreakup, 1]: fbm thresholded
 * around 0.5 (±wakeNoiseContrast) into patches. Multiplying the envelope
 * makes arms gappy/feathered instead of painted-on stripes; world-anchored
 * so the pattern stays in the water while the ship sweeps through it.
 * TWO lattice orientations (axis-aligned + 45°-rotated, averaged) hide the
 * square value-noise grid that read as a "pattern of boxes" in review.
 */
export function wakeBreakupCpu(wx: number, wz: number, p: WakeParams): number {
  const nx = wx * p.wakeNoiseScale;
  const nz = wz * p.wakeNoiseScale;
  const rx = (nx - nz) * INV_SQRT2;
  const rz = (nx + nz) * INV_SQRT2;
  const n = 0.5 * (fbm2Cpu(nx, nz, FLOW_OCTAVES) + fbm2Cpu(rx, rz, FLOW_OCTAVES));
  const patch = smoothstepCpu(0.5 - p.wakeNoiseContrast, 0.5 + p.wakeNoiseContrast, n);
  return 1 - p.wakeBreakup + p.wakeBreakup * patch;
}

/** full wake injection rate = symmetric envelope × world-noise breakup */
export function wakeRateCpu(wx: number, wz: number, ship: WakeShip, p: WakeParams): number {
  const envelope = wakeEnvelopeCpu(wx, wz, ship, p);
  if (envelope === 0) return 0;
  return envelope * wakeBreakupCpu(wx, wz, p);
}
