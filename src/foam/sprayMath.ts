/**
 * Pure CPU mirrors of the spray GPU math (§V6 crest spray, §V2 determinism —
 * no Math.random anywhere; every "random" is a seeded Hoskins hash shared
 * with the shader via the decorrelation constants below). No three imports so
 * tests/spray.test.ts runs in node. GPU side: spray.ts. Change one side →
 * change the other (same mirror contract as foamMath.ts / fluxMath.ts).
 */
import { hash2Cpu } from '../terrain/noiseCpu';
import type { SprayParams } from '../params/spray';

/**
 * Seed decorrelation multipliers/offsets feeding hash2: distinct streams per
 * random draw so candidate x/z, launch pitch, yaw and magnitude are mutually
 * independent. Imported by spray.ts so GPU and CPU use identical constants.
 */
export const H_CAND_X = 127.1;
export const H_CAND_Z = 311.7;
export const H_UP = 74.7;
export const H_YAW = 269.5;
export const H_MAG = 183.3;
export const T_OFF_Z = 17.17;
export const T_OFF_UP = 5.3;
export const T_OFF_YAW = 9.1;
export const T_OFF_MAG = 2.7;

/**
 * Respawn candidate offset from the spray center, in meters (GPU mirror:
 * the spawn pass). Deterministic in (seed, time): the sim tick drives time
 * (§V2), so a replay produces the identical spray field.
 */
export function respawnCandidate(
  seed: number,
  time: number,
  extent: number,
): [number, number] {
  const rx = hash2Cpu(seed * H_CAND_X, time);
  const rz = hash2Cpu(seed * H_CAND_Z, time + T_OFF_Z);
  return [(rx - 0.5) * extent, (rz - 0.5) * extent];
}

/**
 * Launch velocity at respawn (GPU mirror: spawn pass): always-upward burst
 * (0.5..1 × launchSpeed), horizontal jitter ≤ lateralSpread × launchSpeed,
 * plus windCarry × wind so storms blow spray downwind (§V7).
 */
export function launchVelocity(
  seed: number,
  time: number,
  windX: number,
  windZ: number,
  p: Pick<SprayParams, 'launchSpeed' | 'lateralSpread' | 'windCarry'>,
): [number, number, number] {
  const rUp = hash2Cpu(seed * H_UP, time + T_OFF_UP);
  const rYaw = hash2Cpu(seed * H_YAW, time + T_OFF_YAW);
  const rMag = hash2Cpu(seed * H_MAG, time + T_OFF_MAG);
  const vy = p.launchSpeed * (0.5 + 0.5 * rUp);
  const angle = rYaw * Math.PI * 2;
  const mag = p.launchSpeed * p.lateralSpread * rMag;
  return [
    Math.cos(angle) * mag + windX * p.windCarry,
    vy,
    Math.sin(angle) * mag + windZ * p.windCarry,
  ];
}

/** exponential air drag → per-frame velocity factor, ∈ (0, 1] for drag ≥ 0 */
export function dragFactorPerFrame(dragPerSecond: number, dt: number): number {
  return Math.exp(-dragPerSecond * dt);
}

/** dead particles wait in the pool for the spawn pass (age ≥ life) */
export function isDead(age: number, life: number): boolean {
  return age >= life;
}

/** sprite alpha by age: 1 at birth → 0 at death, never negative */
export function ageOpacity(age: number, life: number): number {
  return Math.max(0, 1 - age / life);
}

export interface ParticleState {
  pos: [number, number, number];
  vel: [number, number, number];
  age: number;
}

/**
 * One integration step (GPU mirror: update pass): gravity, exponential drag,
 * Euler position, age. Dead particles are untouched — respawn is the spawn
 * pass's job.
 */
export function stepParticle(
  s: ParticleState,
  gravity: number,
  dragFactor: number,
  dt: number,
  life: number,
): ParticleState {
  if (isDead(s.age, life)) return s;
  const vel: [number, number, number] = [
    s.vel[0] * dragFactor,
    (s.vel[1] - gravity * dt) * dragFactor,
    s.vel[2] * dragFactor,
  ];
  return {
    pos: [s.pos[0] + vel[0] * dt, s.pos[1] + vel[1] * dt, s.pos[2] + vel[2] * dt],
    vel,
    age: s.age + dt,
  };
}
