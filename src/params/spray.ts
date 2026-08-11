/**
 * Spray particle tunables (§V16). Consumed by src/foam/spray.ts (crest spray
 * off breaking wave tops, §V6 jacobian trigger, §V7 storms spray harder
 * because the threshold tracks oceanParams.jacobianFoamBias) and
 * src/foam/bowSpray.ts (cutwater sheets).
 *
 * TUNING CONTRACT (user critique, first live run): spray must read as MIST —
 * small, soft, short-lived, thrown off the few crests that are genuinely
 * breaking and off the hull. A uniform field of round white dots across the
 * whole visible ocean is the failure mode; the gates below (sprayBiasOffset,
 * crestHeightSigma, spawnChance, fadeNear/Far) are what keep it local.
 */
import { registerParams, type ParamMeta } from './registry';

export interface SprayParams {
  /** particle pool size (build-time: changing requires recreating the sim) */
  count: number;
  /**
   * added to oceanParams.jacobianFoamBias — the crest must be folding HARD,
   * not merely compressed. Jacobian ≈ 1 at rest, < 0 where the surface folds
   * over itself; a threshold near the foam bias sprays the whole sea.
   *
   * Stays RELATIVE so storms that bias foam down also spray harder (§V7), but
   * what this is tuned for is the ABSOLUTE threshold ≈ −0.10. The foam bias is
   * also moved for wave-shape reasons (it went 0.50 → 0.55 with the 37 m → 69 m
   * wavelength change), which drags this with it — re-derive the offset if the
   * absolute value drifts off −0.10.
   */
  sprayBiasOffset: number;
  /**
   * minimum crest elevation for a candidate to throw spray, as a MULTIPLE OF
   * σ (the sea's height RMS, published by the ocean as heightRms). §V36: no
   * absolute metre gates — 1.5σ is the same fraction of the sea (~top 7% of
   * crests) in calm, swell and storm alike, where a metre constant silently
   * changes meaning every time the swell is retuned.
   */
  crestHeightSigma: number;
  /**
   * hard ceiling on the absolute jacobian spawn threshold. J ≈ 1 at rest and
   * < 0 where the surface folds; the storm preset's foam bias of 0.9 would
   * otherwise drag the spray trigger up to "compressed by 10%" = everywhere.
   */
  sprayThresholdMax: number;
  /** fraction of qualifying candidates that actually spawn — thins the field */
  spawnChance: number;
  /**
   * metres above the displaced crest that spray is born at. NOT cosmetic:
   * the ocean surface writes depth, so a sprite spawned coplanar with the
   * water z-fights it and is depth-rejected at grazing angles. Must clear
   * roughly half a sprite (sizeMin) or crest spray largely vanishes.
   */
  spawnLift: number;
  /** upward launch speed scale (m/s) at respawn */
  launchSpeed: number;
  /** horizontal jitter as a fraction of launchSpeed */
  lateralSpread: number;
  /** fraction of the wind vector carried into launch velocity */
  windCarry: number;
  /** downward acceleration (m/s²) */
  gravity: number;
  /** exponential air-drag rate per second */
  drag: number;
  /** particle lifetime (s) */
  life: number;
  /** sprite size at birth (m) */
  sizeMin: number;
  /** sprite size at end of life (m) — puffs expand as they disperse */
  sizeMax: number;
  /** peak sprite opacity */
  opacity: number;
  /** radial falloff exponent — higher = softer, mistier edge (1 = hard ball) */
  softness: number;
  /** cross-motion squash at streakRefSpeed: 1 = round, >1 = motion-streaked */
  streak: number;
  /** particle speed (m/s) at which `streak` is fully applied */
  streakRefSpeed: number;
  /** distance (m) from camera where sprites start fading out */
  fadeNear: number;
  /** distance (m) beyond which sprites are culled to zero size (§V28) */
  fadeFar: number;
  /** side length (m) of the respawn-candidate square around the spray center */
  spawnExtent: number;
  /** bow-spray pool size (build-time: changing requires recreating the sim) */
  bowCount: number;
  /** IMPACT particles per second when the stem buries hard */
  bowBurstRate: number;
  /**
   * CRUISE particles per second at full speed, immersion-independent: the
   * constant cutwater mist that keeps the stem from ever reading "perfectly
   * clean" while making way. Keep it subtle — the wake system (src/flowfoam)
   * carries the mass of the bow wave, this only rides on top of it.
   */
  bowCruiseRate: number;
  /** per-particle size/energy multiplier for that cruise mist (impact = 1) */
  bowCruiseSheet: number;
  /** burial rate (m/s of immersion gain) that counts as a full-force impact */
  bowImpactRef: number;
  /**
   * immersion (m) at which the cutwater counts as fully in contact. Small on
   * purpose: any real touch means the stem is working water, so the cruise
   * mist is continuous WHILE IN CONTACT — but it stops dead when the bow
   * lifts clear, instead of spraying out of thin air.
   */
  bowContactDepth: number;
  /** outboard launch spread as a fraction of ship speed */
  bowLaunchSpread: number;
  /**
   * FORWARD throw as a fraction of ship speed. > 1 means the sheet outruns
   * the bow — the "water pushed forward" read the user asked for. < 1 leaves
   * the spray behind the ship and the bow looks clean.
   */
  bowForwardThrow: number;
  /** upward launch as a fraction of ship speed */
  bowRise: number;
  /**
   * half-width (m) of the cutwater emission line — FALLBACK only, used until
   * the hull-contact sampler supplies the real half-breadth at the crossing.
   */
  bowSideOffset: number;
  /**
   * fraction of the hull's half-breadth AT THE CUTWATER that the sheet spans.
   * Hull-relative on purpose: a fine entry throws a narrow sheet and the full
   * beam a wide one, with no metre constant to retune per ship (§V18).
   */
  bowSideFraction: number;
  /** metres above the bow waterline that sheets are born at (see spawnLift) */
  bowSpawnLift: number;
  /** length (m) of the emission line along the stem, ahead of the bow point */
  bowStemLength: number;
  /** sprite size multiplier for a FULL bow sheet (cruise mist scales down) */
  bowSizeScale: number;
  /** bow submersion (m) below which no burst fires */
  bowImmersionThreshold: number;
  /** bow submersion (m) at which the burst runs at full bowBurstRate */
  bowImmersionFull: number;
  /** ship speed (m/s) below which no burst fires */
  bowSpeedThreshold: number;
  /** ship speed (m/s) at which the burst runs at full bowBurstRate */
  bowSpeedFull: number;
}

export const sprayParams: SprayParams = registerParams(
  'spray',
  {
    // DEFAULTS ARE DELIBERATELY CONSERVATIVE: the scene must stay reviewable
    // with spray on. Err sparse/small/faint — it is far easier to dial spray
    // UP from a clean sea than to judge anything through a snow globe.
    count: 2048,
    sprayBiasOffset: -0.65, // = -0.10 absolute against foam bias 0.55
    crestHeightSigma: 1.5,
    sprayThresholdMax: 0.05,
    spawnChance: 0.15,
    spawnLift: 0.18,
    launchSpeed: 2.6,
    lateralSpread: 0.7,
    windCarry: 0.9,
    gravity: 9.8,
    drag: 1.6,
    life: 0.7,
    sizeMin: 0.08,
    sizeMax: 0.32,
    opacity: 0.16,
    softness: 3.2,
    streak: 2.4,
    streakRefSpeed: 6,
    fadeNear: 25,
    fadeFar: 55,
    spawnExtent: 90,
    bowCount: 1024,
    bowBurstRate: 600,
    bowCruiseRate: 200,
    bowCruiseSheet: 0.35,
    bowImpactRef: 0.6,
    bowContactDepth: 0.12,
    bowLaunchSpread: 0.85,
    bowForwardThrow: 1.3,
    bowRise: 0.55,
    bowSideOffset: 1.6,
    bowSideFraction: 0.9,
    bowSpawnLift: 0.35,
    bowStemLength: 3.0,
    bowSizeScale: 2.6,
    bowImmersionThreshold: 0.02,
    bowImmersionFull: 0.45,
    bowSpeedThreshold: 1.0,
    bowSpeedFull: 5.0,
  },
  sprayParamsMeta(),
);

function sprayParamsMeta(): Partial<Record<keyof SprayParams, ParamMeta>> {
  return {
    count: { min: 256, max: 16384, step: 256 },
    sprayBiasOffset: { min: -2, max: 0.5, step: 0.01 },
    crestHeightSigma: { min: 0, max: 4, step: 0.05 },
    sprayThresholdMax: { min: -1, max: 1, step: 0.01 },
    spawnChance: { min: 0, max: 1, step: 0.01 },
    spawnLift: { min: 0, max: 1.5, step: 0.01 },
    launchSpeed: { min: 0, max: 15, step: 0.1 },
    lateralSpread: { min: 0, max: 2, step: 0.01 },
    windCarry: { min: 0, max: 2, step: 0.01 },
    gravity: { min: 0, max: 30, step: 0.1 },
    drag: { min: 0, max: 5, step: 0.01 },
    life: { min: 0.1, max: 5, step: 0.05 },
    sizeMin: { min: 0.02, max: 2, step: 0.01 },
    sizeMax: { min: 0.02, max: 3, step: 0.01 },
    opacity: { min: 0, max: 1, step: 0.01 },
    softness: { min: 1, max: 8, step: 0.1 },
    streak: { min: 1, max: 6, step: 0.1 },
    streakRefSpeed: { min: 0.5, max: 20, step: 0.5 },
    fadeNear: { min: 5, max: 200, step: 5 },
    fadeFar: { min: 10, max: 400, step: 5 },
    spawnExtent: { min: 20, max: 500, step: 5 },
    bowCount: { min: 128, max: 4096, step: 128 },
    bowBurstRate: { min: 0, max: 5000, step: 10 },
    bowCruiseRate: { min: 0, max: 2000, step: 10 },
    bowCruiseSheet: { min: 0, max: 1, step: 0.01 },
    bowImpactRef: { min: 0.05, max: 6, step: 0.05 },
    bowContactDepth: { min: 0.01, max: 1, step: 0.01 },
    bowLaunchSpread: { min: 0, max: 2, step: 0.01 },
    bowForwardThrow: { min: 0, max: 3, step: 0.05 },
    bowRise: { min: 0, max: 2, step: 0.05 },
    bowSideOffset: { min: 0, max: 4, step: 0.05 },
    bowSideFraction: { min: 0, max: 2, step: 0.05 },
    bowSpawnLift: { min: 0, max: 2, step: 0.05 },
    bowStemLength: { min: 0, max: 8, step: 0.1 },
    bowSizeScale: { min: 0.2, max: 4, step: 0.1 },
    bowImmersionThreshold: { min: 0, max: 2, step: 0.01 },
    bowImmersionFull: { min: 0.05, max: 4, step: 0.05 },
    bowSpeedThreshold: { min: 0, max: 10, step: 0.1 },
    bowSpeedFull: { min: 0.5, max: 20, step: 0.1 },
  };
}
