/**
 * Spray particle tunables (§V16). Consumed by src/foam/spray.ts (crest spray
 * off breaking wave tops — §V58 λ− trigger carried from the foam gate in σ,
 * so storms spray harder for the same reason they foam harder, §V7) and
 * src/foam/bowSpray.ts (cutwater sheets and slams).
 *
 * TUNING CONTRACT (user critique, first live run): spray must read as MIST —
 * small, soft, short-lived, thrown off the few crests that are genuinely
 * breaking and off the hull. A uniform field of round white dots across the
 * whole visible ocean is the failure mode; the gates below (sprayGateSigma,
 * crestHeightSigma, spawnChance, fadeNear/Far) are what keep it local.
 * The second failure mode, reported later, is the opposite one: everything
 * that DOES spawn behaving identically — same speed, same size, same
 * lifetime, same flat arc. gustiness / lifeVariation / sizeVariation exist
 * against that, and none of them uses Math.random (§V2).
 */
import { registerParams, type ParamMeta } from './registry';

export interface SprayParams {
  /** particle pool size (build-time: changing requires recreating the sim) */
  count: number;
  /**
   * how many σ BEYOND the foam gate a crest must be folding to throw spray
   * (§V36, sprayMath.sprayEigenGate). 0 = spray wherever the sea foams, which
   * is the physical default: foam off a breaking crest and spray off a
   * breaking crest are one event. Raise it to keep spray on the hardest
   * breakers only; it is a σ-multiple, so it means the same thing in calm,
   * swell and storm.
   *
   * It REPLACED an absolute det-J offset that read −0.05 at the shipped sea,
   * i.e. a 6.7σ demand that never fired (12.3σ at calm) — see sprayEigenGate.
   */
  sprayGateSigma: number;
  /**
   * minimum crest elevation for a candidate to throw spray, as a MULTIPLE OF
   * σ (the sea's height RMS, published by the ocean as heightRms). §V36: no
   * absolute metre gates — 1.5σ is the same fraction of the sea (~top 7% of
   * crests) in calm, swell and storm alike, where a metre constant silently
   * changes meaning every time the swell is retuned.
   */
  crestHeightSigma: number;
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
  /**
   * heavy tail on the launch burst (sprayMath.gustFactor): 0 = every droplet
   * leaves at the same speed class and the whole field arcs identically, which
   * reads as foam hopping rather than spray detaching. The term only lifts the
   * top few percent of draws, so raising it adds high flyers without making
   * the average burst hotter.
   */
  gustiness: number;
  /** horizontal jitter as a fraction of launchSpeed */
  lateralSpread: number;
  /**
   * fraction of the WIND VELOCITY (m/s, not a unit direction) carried into
   * launch velocity, so detached spray streams downwind and a gale reads as
   * one. It was a fraction of a unit vector until the emitter was handed real
   * wind — capped at ≤ 0.9 m/s of drift in any weather, which is why storms
   * never blew the spray anywhere.
   */
  windCarry: number;
  /** downward acceleration (m/s²) */
  gravity: number;
  /** exponential air-drag rate per second */
  drag: number;
  /** particle lifetime (s) */
  life: number;
  /**
   * ± fraction of `life` drawn per particle (sprayMath.particleLife). One
   * lifetime for the whole pool kills every droplet of a burst on the same
   * frame — the uniformity the user reports across this project's effects.
   */
  lifeVariation: number;
  /**
   * ± fraction of sprite size drawn per particle at spawn. Only ever thins a
   * puff (the multiplier is ≤ 1 and the sprite clamps it), so it cannot
   * inflate a quad.
   */
  sizeVariation: number;
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
   * burial rate (m/s) at which the forefoot counts as SLAMMING, and the rate
   * counted as a full-force slam. Shared with the slam SOUND's calibration
   * (audioParams slamRateOn / slamRateFull): one physical event must not fire
   * at two different speeds in two systems, or the sheet and the boom part
   * company. Unlike every other bow term these are not multiplied by hull
   * speed — a ship dropping off a crest while barely making way still throws
   * water (user: "especially if the boat slams down").
   */
  bowSlamRateOn: number;
  bowSlamRateFull: number;
  /** particles per second at a full-force slam, on top of cruise and impact */
  bowSlamRate: number;
  /**
   * upward launch as a multiple of the SLAM's closing speed (not ship speed).
   * > 1 on purpose: a wedge entering water throws a root jet faster than its
   * own entry speed, and this is the term that makes particles detach and arc
   * instead of hugging the surface.
   */
  bowSlamRise: number;
  /** outboard launch as a multiple of that same closing speed */
  bowSlamSpread: number;
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
  /**
   * bow-sheet lifetime (s) — SHORTER than crest mist on purpose. Real bow
   * spray falls away within a few metres of the stem; a long life lets the
   * ship overtake its own spray, which then streams the length of the hull
   * and over the deck (user: "the whole side of the boat is covered in it").
   */
  bowLife: number;
  /** bow-sheet air drag (1/s) — heavier than mist, drops sheets out fast */
  bowDrag: number;
  /**
   * exponent on the speed ramp for bow emission. Spray volume rises steeply
   * with speed — at 2 a gentle 6 kn produces a fraction of what a hard 16 kn
   * does, instead of the near-linear curtain that made low-speed sailing look
   * like a permanent blizzard.
   */
  bowSpeedExponent: number;
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
    sprayGateSigma: 0, // spray where the sea foams — see sprayEigenGate
    crestHeightSigma: 1.5,
    spawnChance: 0.35,
    spawnLift: 0.18,
    launchSpeed: 2.6,
    gustiness: 1.8,
    lateralSpread: 0.7,
    windCarry: 0.35, // × real wind (m/s), was × a unit vector
    gravity: 9.8,
    drag: 1.6,
    life: 0.7,
    lifeVariation: 0.35,
    sizeVariation: 0.5,
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
    bowBurstRate: 280,
    bowCruiseRate: 60,
    bowCruiseSheet: 0.35,
    bowImpactRef: 0.6,
    bowSlamRateOn: 1.6, // = audioParams.slamRateOn
    bowSlamRateFull: 5, // = audioParams.slamRateFull
    bowSlamRate: 900,
    bowSlamRise: 1.4,
    bowSlamSpread: 0.9,
    bowContactDepth: 0.12,
    bowLaunchSpread: 1.1,
    bowForwardThrow: 1.3,
    bowRise: 0.35,
    bowSideOffset: 1.6,
    bowSideFraction: 1.05,
    bowSpawnLift: 0.35,
    bowStemLength: 3.0,
    bowSizeScale: 2.6,
    bowLife: 0.6, // long enough for a slam arc to peak and come back down
    bowDrag: 2.6,
    bowSpeedExponent: 2,
    bowImmersionThreshold: 0.02,
    bowImmersionFull: 0.45,
    bowSpeedThreshold: 1.0,
    bowSpeedFull: 8.0,
  },
  sprayParamsMeta(),
);

function sprayParamsMeta(): Partial<Record<keyof SprayParams, ParamMeta>> {
  return {
    count: { min: 256, max: 16384, step: 256 },
    sprayGateSigma: { min: 0, max: 4, step: 0.05 },
    crestHeightSigma: { min: 0, max: 4, step: 0.05 },
    spawnChance: { min: 0, max: 1, step: 0.01 },
    spawnLift: { min: 0, max: 1.5, step: 0.01 },
    launchSpeed: { min: 0, max: 15, step: 0.1 },
    gustiness: { min: 0, max: 6, step: 0.1 },
    lateralSpread: { min: 0, max: 2, step: 0.01 },
    windCarry: { min: 0, max: 2, step: 0.01 },
    gravity: { min: 0, max: 30, step: 0.1 },
    drag: { min: 0, max: 5, step: 0.01 },
    life: { min: 0.1, max: 5, step: 0.05 },
    lifeVariation: { min: 0, max: 0.9, step: 0.01 },
    sizeVariation: { min: 0, max: 1, step: 0.01 },
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
    bowSlamRateOn: { min: 0.1, max: 10, step: 0.1 },
    bowSlamRateFull: { min: 0.5, max: 20, step: 0.5 },
    bowSlamRate: { min: 0, max: 5000, step: 10 },
    bowSlamRise: { min: 0, max: 4, step: 0.05 },
    bowSlamSpread: { min: 0, max: 3, step: 0.05 },
    bowContactDepth: { min: 0.01, max: 1, step: 0.01 },
    bowLaunchSpread: { min: 0, max: 2, step: 0.01 },
    bowForwardThrow: { min: 0, max: 3, step: 0.05 },
    bowRise: { min: 0, max: 2, step: 0.05 },
    bowSideOffset: { min: 0, max: 4, step: 0.05 },
    bowSideFraction: { min: 0, max: 2, step: 0.05 },
    bowSpawnLift: { min: 0, max: 2, step: 0.05 },
    bowStemLength: { min: 0, max: 8, step: 0.1 },
    bowSizeScale: { min: 0.2, max: 4, step: 0.1 },
    bowLife: { min: 0.05, max: 3, step: 0.05 },
    bowDrag: { min: 0, max: 8, step: 0.1 },
    bowSpeedExponent: { min: 1, max: 4, step: 0.1 },
    bowImmersionThreshold: { min: 0, max: 2, step: 0.01 },
    bowImmersionFull: { min: 0.05, max: 4, step: 0.05 },
    bowSpeedThreshold: { min: 0, max: 10, step: 0.1 },
    bowSpeedFull: { min: 0.5, max: 20, step: 0.1 },
  };
}
