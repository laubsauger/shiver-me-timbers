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
export const H_CHANCE = 57.9;
export const T_OFF_Z = 17.17;
export const T_OFF_UP = 5.3;
export const T_OFF_YAW = 9.1;
export const T_OFF_MAG = 2.7;
export const T_OFF_CHANCE = 23.4;

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
 * Pool-size sanitizer: counts feed instancedArray sizes and compute dispatch
 * counts at CONSTRUCTION — a fractional/zero/NaN value there would corrupt
 * buffer allocation or dispatch nothing forever. Non-finite → fallback;
 * otherwise floored and clamped ≥ 1.
 */
export function sanitizePoolCount(raw: number, fallback: number): number {
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(1, Math.floor(raw));
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
 * Crest-spray spawn gate (GPU mirror: spawn pass). BOTH conditions:
 *  - jacobian below bias+offset: the surface is genuinely FOLDING there, not
 *    merely compressed. Loosening this is what produced the "snow globe"
 *    field of dots over the whole ocean on the first live run.
 *  - the candidate sits on a crest TOP (height above crestHeightMin), so
 *    spray comes off wave tops instead of out of troughs.
 */
export function crestBreaking(
  jacobian: number,
  height: number,
  jacobianThreshold: number,
  heightThreshold: number,
): boolean {
  return jacobian < jacobianThreshold && height > heightThreshold;
}

/**
 * Absolute jacobian threshold for a spray spawn.
 *
 * Tracks the foam bias so storms spray harder (§V7) — but CEILED. The storm
 * preset sets jacobianFoamBias to 0.9, i.e. "foam wherever the surface is
 * compressed by 10%", which is very nearly the whole sea; carried into spray
 * unchecked that is a blizzard of particles. The ceiling keeps the trigger
 * within physical meaning (J < 0 is genuine folding) no matter what weather
 * does to the foam bias, WITHOUT desensitising the foam injection itself —
 * foam's coverage is the ocean/§V6 trigger's business, not spray's.
 */
export function sprayJacobianThreshold(
  foamBias: number,
  offset: number,
  ceiling: number,
): number {
  return Math.min(foamBias + offset, ceiling);
}

/**
 * Crest-height gate as a multiple of the sea's height RMS σ (§V36: absolute
 * metre gates are forbidden for crest/foam thresholds).
 *
 * WHY σ and not `amplitude`: amplitude is a spectrum SCALE, not a height. The
 * two move independently — a retune took amplitude 0.75 → 0.32 while the
 * significant wave height ROSE 2.3 → 2.8 m, so anything normalised by
 * amplitude would have gated the wrong way. σ is the actual height statistic,
 * so a multiple of it means the same fraction of the sea in any weather:
 * Gaussian crest elevations put 1.5σ at roughly the top 7% of crests, which
 * is the band that genuinely breaks (the ocean material's own crest band is
 * 1.6σ–2.6σ for the same reason).
 *
 * Non-finite/zero σ (before the first spectrum build) → gate disabled rather
 * than a NaN comparison that would silently pass or fail every candidate.
 */
export function crestHeightThreshold(sigmaMultiple: number, seaRms: number): number {
  if (!Number.isFinite(seaRms) || seaRms <= 0) return Infinity; // gate shut
  if (!Number.isFinite(sigmaMultiple)) return Infinity;
  return sigmaMultiple * seaRms;
}

/**
 * Per-candidate spawn lottery (GPU mirror: spawn pass): even inside a
 * breaking band only `chance` of the candidates fire, so spray reads as a
 * spatter of independent droplets rather than a solid slab of sprites, and
 * a given breaking crest keeps emitting over several ticks instead of
 * draining the pool in one.
 */
export function spawnAccepted(seed: number, time: number, chance: number): boolean {
  return hash2Cpu(seed * H_CHANCE, time + T_OFF_CHANCE) < chance;
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

/**
 * Camera-distance fade for a sprite (GPU mirror: sprayPool render node).
 * 1 inside `near`, 0 at/beyond `far`, smoothstep between. WHY: particles are
 * a NEAR-FIELD effect — sprites drawn to the horizon read as falling snow
 * (user critique), and distant crests already carry painted foam. Beyond
 * `far` the sprite is collapsed to zero size, never drawn at alpha 0 (§V28).
 * far ≤ near is floored, not divided by, so a bad slider can't make NaN.
 */
export function distanceFade(dist: number, near: number, far: number): number {
  const end = Math.max(far, near + 1e-3); // floored divisor (§V28)
  const t = Math.min(1, Math.max(0, (dist - near) / (end - near)));
  return 1 - t * t * (3 - 2 * t);
}

/**
 * Sprite world size (GPU mirror: sprayPool scaleNode): puffs grow as they
 * disperse, and anything invisible — dead OR faded out by distance —
 * collapses to EXACTLY zero so it rasterizes no fragments (§V28/§B.5: a pool
 * of alpha-0 additive quads is still a fill-rate wedge).
 */
export function spriteScale(
  ageN: number,
  distFade: number,
  sizeMin: number,
  sizeMax: number,
  sizeScale = 1,
): number {
  if (!(ageN < 1) || distFade < 0.01) return 0;
  return (sizeMin + (sizeMax - sizeMin) * ageN) * sizeScale;
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

/** linear ramp 0 at/below lo → 1 at/above hi; divisor floored (§V28) */
export function ramp01(v: number, lo: number, hi: number): number {
  if (!(v > lo)) return 0; // also catches NaN
  return Math.min(1, (v - lo) / Math.max(hi - lo, 1e-4));
}

/**
 * Share of the sheet a merely-buried bow throws without slamming: a stem that
 * is deep but descending slowly still shoulders water aside, it just doesn't
 * explode. Curve shape, not a look knob — the look knobs are the params.
 */
const BURIED_BASE = 0.35;

/**
 * Bow emission for one tick (GPU-free, two scalars per emitter).
 *
 * TWO regimes, one code path (user: "the cutting of the front into the waves
 * looks disconnected… we need a constant little bow wake whenever we're
 * moving"):
 *  - CRUISE: any speed above threshold throws a low, continuous mist off the
 *    cutwater, immersion-independent, so the stem is never clean while making
 *    way. It rides on top of the wake system's displaced bow wave.
 *  - IMPACT: burying the stem adds a burst on top, scaled by how HARD it
 *    buried — immersion depth × burial rate (d immersion/dt, m/s).
 *
 * `sheet` (∈ [bowCruiseSheet, 1]) is the per-particle size/energy multiplier:
 * a 40 m galleon slamming a swell throws a substantial sheet, not the same
 * mist it makes at cruise (user: "too small … a ship of that mass throws a
 * substantial sheet").
 */
export function bowEmission(
  immersionDepth: number,
  speed: number,
  burialRate: number,
  inContact: boolean,
  p: Pick<
    SprayParams,
    | 'bowImmersionThreshold'
    | 'bowImmersionFull'
    | 'bowSpeedThreshold'
    | 'bowSpeedFull'
    | 'bowImpactRef'
    | 'bowContactDepth'
    | 'bowBurstRate'
    | 'bowCruiseRate'
    | 'bowCruiseSheet'
  >,
): { rate: number; sheet: number } {
  const cruiseSheet = Math.min(1, Math.max(0, p.bowCruiseSheet));
  // AIRBORNE STEM THROWS NOTHING. Water leaving a hull that is touching no
  // water is the detachment the user reported ("it comes out from something
  // that is in the air, where there's nothing touching the water").
  if (!inContact) return { rate: 0, sheet: cruiseSheet };
  const speedN = ramp01(speed, p.bowSpeedThreshold, p.bowSpeedFull);
  const immN = ramp01(immersionDepth, p.bowImmersionThreshold, p.bowImmersionFull);
  const impactN = ramp01(burialRate, 0, p.bowImpactRef);
  // contact ramp saturates almost immediately: ANY real immersion means the
  // stem is working water, so the cruise mist is continuous while in contact —
  // "the stem is always working the water", not "particles always exist".
  const contactN = ramp01(immersionDepth, 0, p.bowContactDepth);
  const burst = speedN * immN * (BURIED_BASE + (1 - BURIED_BASE) * impactN);
  return {
    rate: Math.max(0, p.bowCruiseRate * speedN * contactN + p.bowBurstRate * burst),
    sheet: Math.min(1, cruiseSheet + (1 - cruiseSheet) * burst),
  };
}

/**
 * Bow spawn offset from the bow point, in world XZ meters (GPU mirror: bow
 * spawn pass). Particles are seeded along the CUTWATER — a short line ahead
 * of the bow point and a hash-chosen flank offset outboard — not from a
 * single point, which read as a fountain of balls at the stem.
 */
export function bowSpawnOffset(
  seed: number,
  time: number,
  fwdX: number,
  fwdZ: number,
  p: Pick<SprayParams, 'bowSideOffset' | 'bowStemLength'>,
): [number, number] {
  const rSide = hash2Cpu(seed * H_BOW_SIDE, time + T_BOW_SIDE);
  const rStem = hash2Cpu(seed * H_BOW_MAG, time + T_BOW_MAG);
  const sideSign = rSide < 0.5 ? -1 : 1;
  // |side offset| grows with the flank draw so the sheet thickens outboard
  const lateral = p.bowSideOffset * (0.35 + 0.65 * Math.abs(rSide * 2 - 1)) * sideSign;
  // AFT of the contact point, never ahead of it: the emitter sits at the
  // forward-most part of the hull TOUCHING water, and the hull shoulders
  // water aside from there BACKWARD along its immersed length. Seeding ahead
  // of contact puts droplets in mid-air in front of the stem — the same
  // detachment as emitting from an airborne bow. Water is pushed forward by
  // the launch VELOCITY, not by spawning it out in front of the ship.
  const stem = -p.bowStemLength * rStem;
  return [-fwdZ * lateral + fwdX * stem, fwdX * lateral + fwdZ * stem];
}

/**
 * Bow launch velocity (GPU mirror: bowSpray spawn pass). The hull SHOVES the
 * water aside, so the basis is the ship's HEADING and the flank the droplet
 * was seeded on — never a world axis and never the raw velocity direction (a
 * crabbing hull would then spray off at an angle to its own stem, which is
 * the "weird angle" the user saw):
 *  - FORWARD  bowForwardThrow × speed, > 1 so the sheet outruns the bow;
 *  - OUTBOARD ± bowLaunchSpread × speed on the SAME flank the particle was
 *    spawned on (sideSign), fanning away from the centreline;
 *  - UP       bowRise × speed × `sheet`, so a hard burial launches water high
 *    while a cruising stem throws it flat and forward. Gravity decays it.
 * `fwdX/fwdZ` = unit heading. Zero speed → zero burst.
 */
export function bowLaunchVelocity(
  seed: number,
  time: number,
  speed: number,
  fwdX: number,
  fwdZ: number,
  p: Pick<SprayParams, 'bowLaunchSpread' | 'bowForwardThrow' | 'bowRise'>,
  sheet = 1,
): [number, number, number] {
  if (!(speed > 1e-6)) return [0, 0, 0];
  const rUp = hash2Cpu(seed * H_BOW_UP, time + T_BOW_UP);
  const rSide = hash2Cpu(seed * H_BOW_SIDE, time + T_BOW_SIDE);
  const rMag = hash2Cpu(seed * H_BOW_MAG, time + T_BOW_MAG);
  const sideSign = rSide < 0.5 ? -1 : 1;
  const out = speed * p.bowLaunchSpread * rMag * sideSign;
  const fwd = speed * p.bowForwardThrow * (0.6 + 0.4 * rMag);
  const rise = Math.max(0, Math.min(1, sheet));
  return [
    -fwdZ * out + fwdX * fwd,
    speed * p.bowRise * (0.5 + 0.5 * rUp) * rise,
    fwdX * out + fwdZ * fwd,
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
