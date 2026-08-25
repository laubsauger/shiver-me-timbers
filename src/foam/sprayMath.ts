/**
 * Pure CPU mirrors of the spray GPU math (§V6 crest spray, §V2 determinism —
 * no Math.random anywhere; every "random" is a seeded Hoskins hash shared
 * with the shader via the decorrelation constants below). No three imports so
 * tests/spray.test.ts runs in node. GPU side: spray.ts. Change one side →
 * change the other (same mirror contract as foamMath.ts / fluxMath.ts).
 */
import { hash2Cpu } from '../terrain/noiseCpu';
import type { SprayParams } from '../params/spray';
import {
  NEVER_INJECT_BIAS,
  eigenRestValue,
  eigenSigma,
  foamGateZ,
  jacobianSigma,
  minEigenvalue,
} from './foamMath';

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
 *  - λ− below the gate: the surface is genuinely FOLDING there, not merely
 *    compressed. Loosening this is what produced the "snow globe" field of
 *    dots over the whole ocean on the first live run.
 *  - the candidate sits on a crest TOP (height above crestHeightMin), so
 *    spray comes off wave tops instead of out of troughs.
 */
export function crestBreaking(
  foldMetric: number,
  height: number,
  foldThreshold: number,
  heightThreshold: number,
): boolean {
  return foldMetric < foldThreshold && height > heightThreshold;
}

/**
 * λ− of the SUMMED sea at one point — the fold metric the spawn pass gates on
 * (GPU mirror: spawn pass; foam's injectPass does the same per band).
 *
 * §V58: det J is AREA compression and therefore direction-free, so it cannot
 * signal a directional event, and breaking is uniaxial. λ− = ½(tr − √(tr²−4det))
 * is the onset signal, and both moments are already on the textures: det J per
 * cascade in `displacement.w`, ∂Dx/∂x + ∂Dz/∂z per cascade in `derivatives.zw`
 * (stored UNSCALED, so λ is re-applied here exactly as the inject pass does).
 *
 * `detSum` is Σdet − (n−1) and `traceSum` is Σ(∂Dx/∂x + ∂Dz/∂z): the same
 * first-order sum the surface material draws, so spray folds where the water
 * the player can see folds (§V8's spirit — one sea for physics and pixels).
 */
export function seaMinEigenvalue(
  detSum: number,
  traceSum: number,
  choppiness: number,
): number {
  return minEigenvalue(2 + choppiness * traceSum, detSum);
}

/**
 * λ− threshold for a spray spawn, carried from the FOAM gate in units of σ
 * (§V36).
 *
 * WHY IT IS DERIVED AND NOT TUNED: spray off a breaking crest and foam off a
 * breaking crest are the same physical event, so they have to read the same
 * onset — if they disagree, they disagree about where the sea is breaking.
 * The old form was `min(jacobianFoamBias + offset, ceiling)`, an ABSOLUTE
 * det-J threshold (−0.05 at the shipped swell sea) applied to a statistic
 * whose σ is 0.157 there: a 6.7σ demand on the summed jacobian, i.e. never,
 * and 12.3σ at calm. Worse, det J ≤ 0 is precisely the self-intersection that
 * `effectiveChoppiness` clamps the sea to prevent, so the trigger asked for
 * the one event the ocean guarantees will not occur. §B.12/§V36 verbatim: a
 * constant calibrated against one statistic, applied to another, changing
 * meaning in silence — and §V59 moved the statistic underneath it as well.
 *
 * The gate now takes foam's own z — (1 − bias)/σ(det J) — plus `extraSigma`,
 * and re-expresses it against λ−'s mean and spread (foamMath's EIGEN_* pair,
 * measured on realised fields). extraSigma = 0 means "spray wherever the sea
 * foams"; > 0 selects the harder-breaking subset of those crests. Measured
 * joint pass rate of this gate WITH the 1.5σ crest-height gate on the
 * realised summed field, swell preset: 0.98% of the sea at z + 0, 0.37% at
 * z + 0.5, 2.1% at z − 0.5.
 *
 * A sea with no spectrum yet (σ 0, non-finite moments) returns a gate no λ−
 * can reach, so the emitter stays shut instead of spraying on float noise.
 */
export function sprayEigenGate(
  foamBias: number,
  traceRms: number,
  choppiness: number,
  extraSigma: number,
): number {
  const z = foamGateZ(foamBias, jacobianSigma(traceRms, choppiness));
  if (!Number.isFinite(z) || !Number.isFinite(extraSigma)) return NEVER_INJECT_BIAS;
  const sigma = eigenSigma(traceRms, choppiness);
  if (!(sigma > 0)) return NEVER_INJECT_BIAS;
  return eigenRestValue(traceRms, choppiness) - (z + Math.max(0, extraSigma)) * sigma;
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
 * Per-draw burst multiplier with a HEAVY TAIL (GPU mirror: spawn pass).
 *
 * A uniform 0.5..1 draw is what made crest spray read as one uniform puff
 * class — every droplet leaving at the same speed reaches the same height and
 * falls back on the same arc, which is foam sitting on the water rather than
 * spray leaving it. Breaking crests do not do that: most of the water barely
 * detaches and a few droplets are flung well clear. r^8 is flat over most of
 * the unit interval and only lifts the top few percent, so `gustiness` buys
 * the rare high flyer without brightening the average (deterministic in the
 * draw, so §V2 replay is unaffected).
 */
export function gustFactor(r: number, gustiness: number): number {
  const clamped = Math.min(1, Math.max(0, r));
  return 0.55 + 0.45 * clamped + Math.max(0, gustiness) * Math.pow(clamped, 8);
}

/**
 * Launch velocity at respawn (GPU mirror: spawn pass): always-upward burst of
 * gustFactor × launchSpeed, horizontal jitter ≤ lateralSpread × that same
 * gust, plus windCarry × wind so a gale blows spray downwind (§V7).
 *
 * `windX/windZ` are the wind VELOCITY in m/s, not a unit direction: a droplet
 * off a crest is carried by the air, and the whole point of the term is that
 * a gale looks like a gale.
 */
export function launchVelocity(
  seed: number,
  time: number,
  windX: number,
  windZ: number,
  p: Pick<SprayParams, 'launchSpeed' | 'lateralSpread' | 'windCarry' | 'gustiness'>,
): [number, number, number] {
  const rUp = hash2Cpu(seed * H_UP, time + T_OFF_UP);
  const rYaw = hash2Cpu(seed * H_YAW, time + T_OFF_YAW);
  const rMag = hash2Cpu(seed * H_MAG, time + T_OFF_MAG);
  const gust = gustFactor(rUp, p.gustiness);
  const vy = p.launchSpeed * gust;
  const angle = rYaw * Math.PI * 2;
  const mag = p.launchSpeed * p.lateralSpread * rMag * gust;
  return [
    Math.cos(angle) * mag + windX * p.windCarry,
    vy,
    Math.sin(angle) * mag + windZ * p.windCarry,
  ];
}

/** per-particle lifetime + size hash streams (constant in time, see below) */
export const H_LIFE = 311.9;
export const T_LIFE = 41.3;
export const H_SIZE = 157.3;
export const T_SIZE = 13.9;

/**
 * Per-particle lifetime (GPU mirror: sprayPool's lifeNode).
 *
 * One lifetime for the whole pool makes every droplet of a burst die on the
 * same frame, which is the uniformity the user keeps reporting across this
 * project's effects. Drawn from the particle's INDEX rather than its spawn
 * time on purpose: the physics pass has no spawn time to read, and a slot's
 * lifetime must be the same number in the spawn gate, the integrator and the
 * sprite's age fade or particles respawn early / never fade out. The golden
 * seed is low-discrepancy, so neighbouring slots are decorrelated anyway.
 */
export function particleLife(index: number, life: number, variation: number): number {
  const v = Math.min(0.9, Math.max(0, variation));
  const r = hash2Cpu(goldenSeed(index) * H_LIFE, T_LIFE);
  return Math.max(1e-3, life * (1 - v + 2 * v * r));
}

/**
 * Per-particle size multiplier at spawn, ∈ [1 − variation, 1] (GPU mirror:
 * spawn passes). Rides in velSize.w, which the sprite clamps to [0, 1], so
 * variation can only ever thin a puff — never inflate a quad (§V28).
 */
export function sizeJitter(seed: number, time: number, variation: number): number {
  const v = Math.min(1, Math.max(0, variation));
  return 1 - v * hash2Cpu(seed * H_SIZE, time + T_SIZE);
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
 * Bow emission for one tick (GPU-free, a few scalars per emitter).
 *
 * THREE regimes, one code path:
 *  - CRUISE: any speed above threshold throws a low, continuous mist off the
 *    cutwater, immersion-independent, so the stem is never clean while making
 *    way (user: "we need a constant little bow wake whenever we're moving").
 *    It rides on top of the wake system's displaced bow wave.
 *  - IMPACT: burying the stem adds a burst on top, scaled by how HARD it
 *    buried — immersion depth × burial rate (d immersion/dt, m/s).
 *  - SLAM: the hull dropping off a crest and burying its forefoot. THIS ONE
 *    IS NOT MULTIPLIED BY HULL SPEED (user: "especially if the boat slams
 *    down"). Both other regimes carry speedN, which is `ramp01(speed, 1, 8)²`
 *    — a ship coming down hard at 3 m/s over ground scored 0.08 there, so the
 *    single most dramatic water event in the game was emitting at 8% of its
 *    already speed-bound rate, and a ship slamming while hove to emitted
 *    NOTHING. A slam is a vertical event: it is driven by the closing speed
 *    between hull and water, which is exactly what `burialRate` measures and
 *    what the audio slam has been keyed on all along.
 *
 * Slam thresholds are shared with that slam sound (audioParams slamRateOn /
 * slamRateFull, 1.6 and 5 m/s): the same physical event must not fire at two
 * different speeds in two systems, or the sheet and the boom come apart. Note
 * `bowImpactRef` (0.6 m/s) SATURATES eight times below the audio's full-force
 * reference, which is why the IMPACT term carried no slam dynamic range of
 * its own — it is a bury/no-bury switch, not an impact scale.
 *
 * `sheet` (∈ [bowCruiseSheet, 1]) is the per-particle size/energy multiplier;
 * `slam` (∈ [0, 1]) is how much of a full slam this tick is, and the emitter
 * hands it to the launcher, which turns it into vertical velocity.
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
    | 'bowSpeedExponent'
    | 'bowBurstRate'
    | 'bowCruiseRate'
    | 'bowCruiseSheet'
    | 'bowSlamRateOn'
    | 'bowSlamRateFull'
    | 'bowSlamRate'
  >,
  /**
   * §T.161 — THIS VESSEL'S SPEED SCALE. The ramp below is authored for the
   * galleon (nothing at 1 m/s, full sheet at 8), and the raft's whole polar is
   * 1.5–3.4 m/s: at 2 m/s she scored `((2−1)/7)² = 0.02` and threw 2% of a
   * sheet, which is USER's "we entirely lost the 3D wake… we tried to dial it
   * down and that caused us to lose it completely." One number, multiplying
   * BOTH ends of the ramp, so a slower ship gets the same CURVE against her
   * own speeds (§V66 — a feature scaled by its own dimension) rather than a
   * second set of thresholds free to disagree with these.
   */
  speedScale = 1,
): { rate: number; sheet: number; slam: number } {
  const scale = Number.isFinite(speedScale) && speedScale > 0 ? speedScale : 1;
  const cruiseSheet = Math.min(1, Math.max(0, p.bowCruiseSheet));
  // AIRBORNE STEM THROWS NOTHING. Water leaving a hull that is touching no
  // water is the detachment the user reported ("it comes out from something
  // that is in the air, where there's nothing touching the water").
  if (!inContact) return { rate: 0, sheet: cruiseSheet, slam: 0 };
  // spray volume climbs steeply with speed, it does not ramp linearly — a
  // galleon ghosting along at 6 kn throws the occasional sheet off the stem,
  // not the continuous curtain a linear ramp produced
  const speedN = Math.pow(
    ramp01(speed, p.bowSpeedThreshold * scale, p.bowSpeedFull * scale),
    Math.max(1, p.bowSpeedExponent),
  );
  const immN = ramp01(immersionDepth, p.bowImmersionThreshold, p.bowImmersionFull);
  const impactN = ramp01(burialRate, 0, p.bowImpactRef);
  // contact ramp saturates almost immediately: ANY real immersion means the
  // stem is working water, so the cruise mist is continuous while in contact —
  // "the stem is always working the water", not "particles always exist".
  const contactN = ramp01(immersionDepth, 0, p.bowContactDepth);
  const burst = speedN * immN * (BURIED_BASE + (1 - BURIED_BASE) * impactN);
  // the slam still needs the stem to be WORKING water (contactN), but nothing
  // else: no speed term, no full-immersion term. A forefoot coming down at
  // 4 m/s throws a sheet whether or not the ship is making way.
  const slam = ramp01(burialRate, p.bowSlamRateOn, p.bowSlamRateFull) * contactN;
  return {
    rate: Math.max(
      0,
      p.bowCruiseRate * speedN * contactN + p.bowBurstRate * burst + p.bowSlamRate * slam,
    ),
    // a slam throws a full sheet on its own — it does not have to also be fast
    sheet: Math.min(1, cruiseSheet + (1 - cruiseSheet) * Math.max(burst, slam)),
    slam,
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
 *
 * PLUS THE SLAM, which is a different velocity source and the reason spray
 * never looked like it detached. `slamSpeed` is the closing speed between
 * hull and water (hullContact's burial rate, m/s); a wedge entering water at
 * that speed throws a root jet FASTER than it, not slower, so bowSlamRise is
 * > 1 by construction and the term is INDEPENDENT of hull speed. At the old
 * numbers a full sheet at 8 m/s over ground left the stem at 0.35 × 8 × 0.75
 * ≈ 2.1 m/s up, which against gravity is a 22 cm hop — particles that hug the
 * surface read as foam, and that is what the user was looking at.
 *
 * `fwdX/fwdZ` = unit heading. Zero speed AND zero slam → nothing thrown.
 */
export function bowLaunchVelocity(
  seed: number,
  time: number,
  speed: number,
  fwdX: number,
  fwdZ: number,
  p: Pick<
    SprayParams,
    'bowLaunchSpread' | 'bowForwardThrow' | 'bowRise' | 'bowSlamRise' | 'bowSlamSpread'
  >,
  sheet = 1,
  slamSpeed = 0,
): [number, number, number] {
  const slam = Number.isFinite(slamSpeed) ? Math.max(0, slamSpeed) : 0;
  if (!(speed > 1e-6) && slam <= 0) return [0, 0, 0];
  const rUp = hash2Cpu(seed * H_BOW_UP, time + T_BOW_UP);
  const rSide = hash2Cpu(seed * H_BOW_SIDE, time + T_BOW_SIDE);
  const rMag = hash2Cpu(seed * H_BOW_MAG, time + T_BOW_MAG);
  const sideSign = rSide < 0.5 ? -1 : 1;
  const out =
    (speed * p.bowLaunchSpread + slam * p.bowSlamSpread) * rMag * sideSign;
  const fwd = speed * p.bowForwardThrow * (0.6 + 0.4 * rMag);
  const rise = Math.max(0, Math.min(1, sheet));
  const up = (speed * p.bowRise * rise + slam * p.bowSlamRise) * (0.5 + 0.5 * rUp);
  return [-fwdZ * out + fwdX * fwd, up, fwdX * out + fwdZ * fwd];
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
