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

/** golden-ratio conjugate — low-discrepancy per-particle seed sequence */
export const PHI = 0.61803398875;

/** age written by the init pass — beyond any life slider value → dead pool */
export const DEAD_AGE = 1e4;

/** deterministic per-particle seed in [0, 1): fract((i+1)·φ), no Math.random */
export function goldenSeed(index: number): number {
  const v = (index + 1) * PHI;
  return v - Math.floor(v);
}

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

/** bow-spray hash streams — distinct from crest streams above */
export const H_BOW_UP = 419.2;
export const H_BOW_SIDE = 91.7;
export const H_BOW_MAG = 233.9;
export const T_BOW_UP = 3.7;
export const T_BOW_SIDE = 11.3;
export const T_BOW_MAG = 7.9;

/**
 * Bow burst gate (CPU-side, Rule: code answers — one scalar per emitter):
 * BOTH conditions must hold. Immersion alone (bobbing at anchor) or speed
 * alone (flat water, bow riding high) must NOT fizz spray constantly —
 * spray marks the hull PUNCHING through a wave.
 */
export function burstGate(
  immersionDepth: number,
  speed: number,
  p: { bowImmersionThreshold: number; bowSpeedThreshold: number },
): boolean {
  return immersionDepth > p.bowImmersionThreshold && speed > p.bowSpeedThreshold;
}

/**
 * Rotating spawn window: at most `budget` pool slots are respawn-eligible
 * per frame, starting at `cursor` (wrapping). Bounds burst emission to
 * bowBurstRate regardless of how many particles happen to be dead.
 */
export function inSpawnWindow(
  index: number,
  cursor: number,
  budget: number,
  count: number,
): boolean {
  return (((index - cursor) % count) + count) % count < budget;
}

/**
 * Accumulate fractional per-frame budget from a per-second rate and advance
 * the cursor — deterministic (§V2), emits exactly rate·t particles over time
 * even when rate·dt is fractional.
 */
export function advanceBurstCursor(
  state: { cursor: number; acc: number },
  ratePerSecond: number,
  dt: number,
  count: number,
): { cursor: number; acc: number; budget: number } {
  const acc = state.acc + ratePerSecond * dt;
  const budget = Math.min(Math.floor(acc), count);
  return {
    cursor: (state.cursor + budget) % count,
    acc: Math.min(acc - budget, count), // carry the fraction, cap the backlog
    budget,
  };
}

/**
 * Bow launch velocity (GPU mirror: bowSpray spawn pass): the ship's speed is
 * reflected up and outboard — up component 0.5..1 × speed, outboard along
 * ±side (hash-chosen flank) ≤ spread × speed, plus forwardKeep × ship
 * velocity so the sheet arcs backward RELATIVE TO THE SHIP while keeping
 * some world-frame forward momentum. Zero ship speed → zero burst.
 */
export function bowLaunchVelocity(
  seed: number,
  time: number,
  shipVelX: number,
  shipVelZ: number,
  p: { bowLaunchSpread: number; bowForwardKeep: number },
): [number, number, number] {
  const speed = Math.hypot(shipVelX, shipVelZ);
  if (speed < 1e-6) return [0, 0, 0];
  const fx = shipVelX / speed;
  const fz = shipVelZ / speed;
  const rUp = hash2Cpu(seed * H_BOW_UP, time + T_BOW_UP);
  const rSide = hash2Cpu(seed * H_BOW_SIDE, time + T_BOW_SIDE);
  const rMag = hash2Cpu(seed * H_BOW_MAG, time + T_BOW_MAG);
  const sideSign = rSide < 0.5 ? -1 : 1;
  const out = speed * p.bowLaunchSpread * rMag * sideSign;
  return [
    -fz * out + fx * speed * p.bowForwardKeep,
    speed * (0.5 + 0.5 * rUp),
    fx * out + fz * speed * p.bowForwardKeep,
  ];
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
