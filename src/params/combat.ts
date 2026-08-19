/**
 * Cannon combat tunables (§V.16): every value registers with the params
 * registry so the debug panel auto-binds it. Sim code reads these live
 * objects; the panel mutates them in place.
 */
import { registerParams } from './registry';

export interface CombatParams {
  muzzleVelocity: number; // m/s at the muzzle
  gravity: number; // m/s², applied downward (positive value)
  drag: number; // quadratic drag coefficient, 1/m
  maxAge: number; // s before an airborne projectile expires
  spreadAngle: number; // radians, default aim jitter half-angle
  reloadTime: number; // s between shots per cannon (consumed by input/AI)
  /**
   * m — cannonball collision radius. Hit targets are the piece AABB grown
   * by this (Minkowski sum of the ball with the box), so a ball that grazes
   * a mast still strikes it. Without it a 0.3 m mast is a needle that a
   * spread-limited broadside effectively never hits, and §V14's mast break
   * becomes unreachable in play while every unit test still passes.
   */
  ballRadius: number;
  /** m — cannon-mount socket → muzzle along the barrel, so the ball leaves
   *  the gun's mouth instead of appearing inside the bulwark */
  muzzleForward: number;
  /** rad — barrel elevation used when the caller supplies no aim pitch */
  defaultElevation: number;
  /** rad — aim pitch clamp (guns cannot depress below/elevate above these) */
  minElevation: number;
  maxElevation: number;
  /**
   * rad of gun elevation per pixel of mouse travel while the aim button is
   * held. The clamp spans 0.72 rad, so the default is a ~290 px sweep from
   * full depression to full elevation — a gun crew's handspike, not a
   * flick-stick.
   */
  aimMouseSpeed: number;
  /** rad/s of gun elevation while an elevate/depress key is held */
  aimKeyRate: number;
  /** s between neighbouring guns of one broadside — the rolling ripple */
  rippleDelay: number;
  /**
   * s — extra per-gun delay drawn deterministically per shot. The ripple
   * alone is metronomic and reads as a machine ("they shoot at the perfect
   * identical same time"); real gun captains each fire on their own judgement
   * of the roll. Keep below rippleDelay or the roll stops reading fore → aft.
   */
  rippleJitter: number;
}

export const combatParams: CombatParams = registerParams(
  'combat',
  {
    muzzleVelocity: 60,
    gravity: 9.81,
    drag: 0.008,
    maxAge: 12,
    spreadAngle: 0.015,
    reloadTime: 3,
    ballRadius: 0.4,
    muzzleForward: 1.4,
    defaultElevation: 0.06,
    minElevation: -0.12,
    maxElevation: 0.6,
    aimMouseSpeed: 0.0025,
    aimKeyRate: 0.25,
    rippleDelay: 0.13,
    rippleJitter: 0.07,
  },
  {
    muzzleVelocity: { min: 10, max: 150, step: 1 },
    gravity: { min: 0, max: 20, step: 0.1 },
    drag: { min: 0, max: 0.05, step: 0.001 },
    maxAge: { min: 1, max: 30, step: 0.5 },
    spreadAngle: { min: 0, max: 0.2, step: 0.001 },
    reloadTime: { min: 0.5, max: 10, step: 0.1 },
    ballRadius: { min: 0, max: 2, step: 0.05 },
    muzzleForward: { min: 0, max: 4, step: 0.1 },
    defaultElevation: { min: -0.2, max: 0.8, step: 0.01 },
    minElevation: { min: -0.5, max: 0, step: 0.01 },
    maxElevation: { min: 0.1, max: 1.2, step: 0.01 },
    aimMouseSpeed: { min: 0.0002, max: 0.02, step: 0.0002 },
    aimKeyRate: { min: 0.02, max: 1.5, step: 0.01 },
    rippleDelay: { min: 0, max: 0.5, step: 0.01 },
    rippleJitter: { min: 0, max: 0.5, step: 0.01 },
  },
);

/**
 * Combat TEST SCENE (`?scene=combat`) — the dev harness placement. Its own
 * group so the arena can be re-framed live while it is on screen, which is
 * the entire point of having a harness (user: "it's hard for me to see").
 */
export interface CombatArenaParams {
  /** m — how far apart the two hulls are placed, beam to beam */
  range: number;
  /** rad — bearing of the enemy from the player, 0 = dead ahead */
  bearing: number;
  /** rad — heading both hulls hold (they lie parallel, broadside on) */
  heading: number;
  /** m — camera height above the sea at the parked vantage */
  cameraHeight: number;
  /** m — camera stand-off perpendicular to the line of fire */
  cameraOffset: number;
  /** m — height the parked camera aims at (deck/gunport level) */
  cameraAimHeight: number;
  /**
   * hull sections the breach key holes at once. One hole is out-pumped by
   * design (§T.18), so a single-section breach demonstrates a hole that
   * never floods — which reads as flooding being broken.
   */
  breachSections: number;
}

export const combatArenaParams: CombatArenaParams = registerParams(
  'combatArena',
  {
    range: 55,
    bearing: Math.PI / 2,
    heading: 0,
    cameraHeight: 16,
    cameraOffset: 52,
    cameraAimHeight: 5,
    breachSections: 3,
  },
  {
    range: { min: 15, max: 300, step: 1 },
    bearing: { min: -Math.PI, max: Math.PI, step: 0.01 },
    heading: { min: -Math.PI, max: Math.PI, step: 0.01 },
    cameraHeight: { min: 1, max: 120, step: 1 },
    cameraOffset: { min: 5, max: 300, step: 1 },
    cameraAimHeight: { min: 0, max: 40, step: 0.5 },
    breachSections: { min: 1, max: 8, step: 1 },
  },
);

/**
 * CAMERA SHAKE (§V.16). Its own group because it is the one effect here most
 * likely to become annoying, and it must be turnable-down in one place
 * without hunting through the fx knobs.
 *
 * `gain` 0 disables the whole system — no shake, no cost, no code change.
 * That is the knob to reach for first if it is too much.
 */
export interface CombatShakeParams {
  /** master multiplier on every source. 0 = off. */
  gain: number;
  /** m at which a source is at half strength (inverse-square about this) */
  refDistance: number;
  /** m past which a source contributes EXACTLY nothing */
  maxDistance: number;
  /** ceiling on the summed 0..1 energy — a broadside must not fling the lens */
  maxLevel: number;
  /** s — exponential decay time constant of the envelope */
  decay: number;
  /** Hz — base wobble rate; the three axes detune off this */
  frequency: number;
  /** rad at full energy, per axis. Roll leads: it reads as a shock. */
  yawAmplitude: number;
  pitchAmplitude: number;
  rollAmplitude: number;
  /** 0..1 event strengths BEFORE distance falloff */
  firingStrength: number;
  /** a ball into our own hull — the one that should be felt hardest */
  ownHitStrength: number;
  /** a ball into anyone else: a tremor at range, not silence */
  otherHitStrength: number;
}

export const combatShakeParams: CombatShakeParams = registerParams(
  'combatShake',
  {
    gain: 1,
    refDistance: 25,
    maxDistance: 400,
    maxLevel: 1,
    decay: 0.32,
    frequency: 11,
    // radians. 0.02 rad ≈ 1.1°, which at the shipped 55° fov is ~2% of the
    // frame — present without being nauseating. Roll is largest because a
    // rolled horizon reads as impact where a yawed one reads as a look-around.
    yawAmplitude: 0.012,
    pitchAmplitude: 0.014,
    rollAmplitude: 0.02,
    firingStrength: 0.7,
    ownHitStrength: 1,
    otherHitStrength: 0.55,
  },
  {
    gain: { min: 0, max: 3, step: 0.05 },
    refDistance: { min: 1, max: 200, step: 1 },
    maxDistance: { min: 10, max: 2000, step: 10 },
    maxLevel: { min: 0, max: 3, step: 0.05 },
    decay: { min: 0.02, max: 3, step: 0.01 },
    frequency: { min: 1, max: 40, step: 0.5 },
    yawAmplitude: { min: 0, max: 0.15, step: 0.001 },
    pitchAmplitude: { min: 0, max: 0.15, step: 0.001 },
    rollAmplitude: { min: 0, max: 0.15, step: 0.001 },
    firingStrength: { min: 0, max: 1, step: 0.01 },
    ownHitStrength: { min: 0, max: 1, step: 0.01 },
    otherHitStrength: { min: 0, max: 1, step: 0.01 },
  },
);

/**
 * Combat fx tunables (§V.16) — the visible half of §T.16/§V.14: muzzle
 * flash and smoke, splinter bursts at a breach, the pillar where a ball
 * pitches into the sea, and the balls themselves.
 *
 * Registered as its own panel group because these are look knobs, tuned
 * against footage, while the group above is ballistics that changes how the
 * game plays.
 */
export interface CombatFxParams {
  /** sprite pool size — sanitized to an int at construction (§V.28) */
  particleCount: number;
  /** cannonballs drawn at once; SimState may hold fewer */
  ballCount: number;
  /** m — rendered radius of a ball (its collision radius is ballRadius) */
  ballDrawRadius: number;
  flashLife: number;
  flashSize: number;
  smokeLife: number;
  smokeSize: number;
  smokeGrowth: number; // × sizeStart at death
  /** m/s the bank leaves the muzzle at — the JET phase */
  smokeSpeed: number;
  /**
   * 1/s velocity bleed. High on purpose: it is what STALLS the jet (tau =
   * 1/drag), and the stall is what separates "bellows out" from "rises".
   */
  smokeDrag: number;
  /**
   * m/s the parcel settles to CLIMBING at — a terminal speed, not an
   * acceleration, so it keeps its meaning when `smokeDrag` moves (§V.66).
   * This is the "and then that kinda moves towards the top" half.
   */
  smokeRiseSpeed: number;
  /**
   * 0..1 how completely the bank is carried by the LIVE wind (`state.wind`,
   * the same air the sails and flags answer to). This is what blows a
   * broadside's smoke across the deck instead of leaving it hanging.
   */
  smokeWind: number;
  /**
   * Exponent on age driving size. 0.5 = the turbulent-puff law: expands fast
   * while the eddies are energetic, then tapers. 1 = linear, which is what
   * reads as a balloon inflating at a constant rate.
   */
  smokeGrowthExp: number;
  /** upward bias on the smoke bank's axis — powder smoke rolls up, not flat */
  smokeRise: number;
  /** burning powder grains thrown out with the muzzle gases */
  sparkLife: number;
  sparkSize: number;
  sparkSpeed: number;
  sparksPerShot: number;
  /**
   * Additive brightness multiplier on the FLASH kinds only. Bloom rendered
   * for the first time on 2945b3b, and a flash is the one thing bloom sells;
   * `bloomThreshold` 1.0 is display-referred and divided by exposure 1.1, so
   * a flash has to clear ~0.91 scene-linear to glare at all. Peak additive
   * output is `brightnessAt ∈ [0,1] × boost × tint ∈ [0,1]`, i.e. bounded by
   * this number AT SOURCE (§V.44) rather than clamped downstream.
   */
  flashBoost: number;
  /** the ball's vapour ribbon — what makes a small dark sphere followable */
  trailLife: number;
  trailSize: number;
  trailGrowth: number;
  /** sim ticks between trail puffs per ball (1 = every tick) */
  trailEvery: number;
  /** extra length per m/s of ball speed, and the cap on it (§V.28) */
  ballStretch: number;
  ballStretchMax: number;
  /**
   * 0..1 — per-particle spread of size, speed and lifetime, drawn
   * deterministically per shot. 0 restores the old identical-puff-per-gun
   * behaviour, which is exactly what the user reported seeing.
   */
  variation: number;
  // ── SPLINTERS (what a ball knocks OUT of a plank) ──────────────────────
  // These four are what separate "wood came off her" from "brown particles".
  // A splinter is not a puff of anything: it is a piece of the ship, with
  // mass, a long axis and a tumble, and it HIDES what is behind it.
  splinterLife: number;
  splinterSize: number;
  splinterSpeed: number;
  /**
   * 0..1 opacity. 0 = additive light, 1 = opaque timber. See FxProfile.alpha.
   *
   * THE REASON THIS EXISTS is the same one that took the water column off
   * additive, and it is worth restating because splinters were left behind
   * when that landed: additive can ONLY brighten what is behind it. An
   * additive brown sprite over a bright sky is a faint warm smudge and over a
   * sunlit hull it is nothing at all — it cannot occlude, and occlusion is the
   * whole reason a solid object reads as solid. Powder smoke genuinely is
   * light and stays at 0; oak is a substance and does not.
   */
  splinterAlpha: number;
  /**
   * Length:width of a shard, ≥ 1 (see fxMath.splinterAspect). 1 restores the
   * round sprite exactly, so the knob is provable.
   */
  splinterAspect: number;
  /** rad/s — peak tumble. 0 freezes the roll, which reads as sliding decals */
  splinterSpin: number;
  /**
   * §T.63 — how far the ejecta plume leans DOWNRANGE, as a multiple of the
   * surface normal. 0 = the old symmetric dome about the hull normal, i.e.
   * a hit that has forgotten which way the ball was going; 1 = the burst
   * leans 45° along the shot's tangential component. Applies to the things
   * with mass (splinters, chunks) and not to the flash or the powder smoke.
   */
  splinterMomentum: number;
  /**
   * How wide the shards leave the impact: 0 is a beam along the hull's
   * outward normal, 1 is a full hemisphere. Wood does not spray back
   * isotropically out of a hole — it follows the ball through.
   */
  splinterSpread: number;

  // ── SOLID DEBRIS (see combat/debris.ts) ────────────────────────────────
  // A sprite cannot LAND — it has no attitude in the world, so it can only
  // fade wherever it happens to be, and something that vanishes in mid-air
  // leaves no evidence a hit occurred. These are a handful of real boxes that
  // arc, tumble on three axes, come down, and disturb the sea where they hit.
  // One instanced draw while any is in the air, and ZERO when none is.
  /** pool size — the oldest chunk is evicted when a burst overflows it */
  chunkCount: number;
  /** chunks thrown by an ordinary hit. Keep it LOW: these are pieces of ship */
  chunkPerHit: number;
  /** chunks thrown when a section actually stoves in — the escalation */
  chunkPerBreach: number;
  /** s airborne before it fades, even if it never finds water */
  chunkLife: number;
  /** s bobbing on the surface after it lands, before it goes under */
  chunkFloatLife: number;
  chunkSpeed: number;
  /** 0 = a beam along the hull normal, 1 = a full hemisphere */
  chunkSpread: number;
  /** m — nominal plank LENGTH; thickness and width are fractions of it */
  chunkSize: number;
  /** rad/s — peak tumble */
  chunkSpin: number;
  // ── WATER ENTRY: the mist ─────────────────────────────────────────────
  // The aerated haze left hanging round the base of the column. It used to be
  // the whole splash — a 3 m additive disc over the entry point, which is what
  // read as "latched on top". See fxProfiles for the shape it is now.
  splashLife: number;
  splashSize: number;
  splashSpeed: number;
  splashGrowth: number;
  /** 0..1 how completely the mist is carried by the wind (droplets blow away) */
  splashWind: number;
  /** 0..1 opacity: 0 = additive light, 1 = opaque water. See FxProfile.alpha */
  splashAlpha: number;

  // ── HULL IMPACT (§V.14's visible half — see combatFx's header) ──────────
  // The flash is short and the smoke is long ON PURPOSE: the contrast
  // between those two timescales is most of what makes an impact read as an
  // impact rather than as a puff. Tune them as a PAIR.
  /** s — the strike itself. Keep under ~0.12 or it reads as a fireball */
  impactFlashLife: number;
  impactFlashSize: number;
  /** the dust and smoke a ball knocks out of oak: slow, and it lingers */
  impactSmokeLife: number;
  impactSmokeSize: number;
  impactSmokeGrowth: number;
  impactSmokeSpeed: number;
  /** m/s the dust knocked out of oak settles to climbing at */
  impactSmokeRise: number;
  /** particles per HIT (every hit, not only the one that breaches) */
  impactSmokePerHit: number;
  debrisPerHit: number;

  // ── BREECH VENT (a muzzle-loader fires from BOTH ends) ─────────────────
  // Position is DERIVED, never authored: the breech is
  // `muzzle - direction x combatParams.muzzleForward`, i.e. the gun's own
  // mount socket. One owner for the barrel's length; move the gun and the
  // vent follows it. Two independent literals for the two ends of one gun is
  // the bug that put a lantern beside a post it did not reach.
  breechLife: number;
  breechSize: number;
  breechGrowth: number;
  breechSpeed: number;
  breechRise: number;
  breechPerShot: number;
  /** 0..1 up-bias of the vent jet: 1 = straight up off the breech */
  breechUp: number;

  // ── WATER COLUMN (a ball pitching into the sea) ─────────────────────────
  /** the pillar: narrow, fast, straight up — droplets detach off its top */
  columnLife: number;
  columnSize: number;
  columnGrowth: number;
  columnSpeed: number;
  columnPerHit: number;
  /** 0..1 opacity: 0 = additive light, 1 = opaque water. See FxProfile.alpha */
  columnAlpha: number;

  // ── THE CROWN (the sheet off the RIM of the cavity) ────────────────────
  // Thrown on a SHEET at `crownTilt` off vertical rather than filling a cone
  // (fxMath.crownDirection): a cone is just the column again, wider, and the
  // open wall with a hole up the middle is the whole silhouette of a real
  // water entry. It opens and collapses while the column is still climbing.
  crownLife: number;
  crownSize: number;
  crownGrowth: number;
  crownSpeed: number;
  crownPerHit: number;
  /** rad off vertical: 0 straight up, π/2 flat outward. ~55° is a real crown */
  crownTilt: number;
  /** 0..1 raggedness of the rim — 0 gives a perfect cone of revolution */
  crownJitter: number;
  /** 0..1 opacity: bulk sea, the most opaque of the three water kinds */
  crownAlpha: number;

  // ── IMPACT SPEED SCALING (§V.66: scale the feature by its own dimension) ─
  /**
   * m/s of impact speed that produces a splash of the AUTHORED size. Every
   * number above is quoted at this speed and scales from it, so a ball
   * dropping out of a lob and one arriving flat and fast no longer throw the
   * identical burst. The muzzle velocity is 60 m/s and drag bleeds it, so a
   * typical entry lands near this figure.
   */
  impactSpeedRef: number;
  /** clamp on the speed ratio, so a freak shot cannot throw a 40 m column */
  impactSpeedMax: number;
  /** the expanding ring left on the surface (its own flat mesh, not sprites) */
  ringLife: number;
  ringRadius: number;
  /**
   * The annulus' thickness as a FRACTION of its own radius (§V.66: scale a
   * feature by its own dimension). So the ring broadens as it spreads, which
   * is what a real ripple does — and an absolute metre value would silently
   * change meaning the moment `ringRadius` moved.
   */
  ringWidth: number;
  /** m above the sampled surface, so the ring does not z-fight the sea */
  ringLift: number;
  ringCount: number;
  ringOpacity: number;

  // ── THE FOAM SCAR (the same disc, the other radial profile) ────────────
  // What outlives the ring. Foam residue is the cheapest strong cue that the
  // water was disturbed rather than decorated, because it persists on the
  // surface for seconds after every sprite has died — and it drifts, because
  // foam floats IN the water and the surface layer moves.
  /** s — several times `ringLife`: it disperses, it does not ripple away */
  foamLife: number;
  /** m at impact scale 1, before spreading */
  foamRadius: number;
  /** multiple of `foamRadius` it spreads to by the end of its life */
  foamGrowth: number;
  foamOpacity: number;
  foamCount: number;
  /** fraction of the wind speed the surface layer drifts at (~3% is real) */
  foamDrift: number;

  // ── FLASH LIGHT (ONE PointLight, created at boot, NEVER added/removed) ──
  /** candela at full flash; 0 disables the light without removing it */
  flashLightIntensity: number;
  /** m — PointLight.distance, the range the falloff reaches zero at */
  flashLightRange: number;
  /** s — time from full to dark. A gun flash is ~a frame and a half */
  flashLightDecay: number;

  /** particles per muzzle / breach / water-entry event */
  smokePerShot: number;
  splintersPerBreach: number;
  splashPerHit: number;
  // ── SILHOUETTE (§V.65: the eye reads the OUTLINE, not the interior) ────
  /**
   * 0..1 per-particle stretch. A uniformly-scaled sprite is a disc by
   * construction, so a burst of them is a cluster of discs — "not just
   * circular puffs". Each particle takes its own aspect and its own roll, and
   * the union of ellipses at differing angles is not a disc at any radius.
   * Costs nothing in the fragment shader: it is all in the vertex scale.
   */
  smokeAspect: number;
  /**
   * Torn contour on the smoke sprites: a noise DISSOLVE threshold, which is
   * the same cure §B.39 landed on for foam (round level sets cannot be fixed
   * by filling them differently). Band-limited per §V.48/§V.70 — see
   * smokeShape.ts for what it fades TOWARD and why that is not zero.
   *
   * FIRST THING TO CUT if the frame is over budget: it is the only
   * per-fragment cost in this whole system, and `smokeAspect` above already
   * carries much of the silhouette win for free.
   */
  smokeDissolve: number;
  /** noise cells across a sprite — the tear's own scale */
  smokeDissolveScale: number;

  /** overall additive brightness */
  intensity: number;
  /** rad/s — tumble of a detached mast on the way down (§V.14) */
  wreckTumble: number;
  /** m/s — settle rate once the spar is in the water (it stops falling) */
  wreckSinkSpeed: number;
  /** m below the LIVE surface at which wreckage is removed from the scene */
  wreckSinkDepth: number;
}

export const combatFxParams: CombatFxParams = registerParams(
  'combatFx',
  {
    // raised with sparks + ball trails: a 4-gun broadside now costs
    // 4×(1 flash + 14 smoke + 12 sparks) = 108, and eight balls in the air
    // lay ~14 ribbon puffs each. One instanced sprite draw either way.
    particleCount: 1536,
    ballCount: 64,
    ballDrawRadius: 0.16,
    flashLife: 0.09,
    flashSize: 2.2,
    smokeLife: 3.2,
    smokeSize: 0.8,
    smokeGrowth: 7,
    smokeSpeed: 14,
    smokeDrag: 4.5,
    smokeRiseSpeed: 2,
    smokeWind: 0.7,
    smokeGrowthExp: 0.5,
    smokeRise: 0.35,
    sparkLife: 0.4,
    sparkSize: 0.14,
    sparkSpeed: 24,
    sparksPerShot: 12,
    flashBoost: 2.6,
    trailLife: 0.5,
    trailSize: 0.22,
    trailGrowth: 3.2,
    trailEvery: 2,
    ballStretch: 0.05,
    ballStretchMax: 9,
    variation: 0.45,
    splinterLife: 1.1,
    // 0.3 rather than 0.28 because the shard is now area-preserved against a
    // 4.5:1 stretch: (0.3·4.5) x (0.3/4.5) = 1.35 m x 0.067 m. That width is
    // ~1.5 px at the §V.15 broadside range of 90 m, which is the floor this
    // size is set against — thinner and the shard vanishes at exactly the
    // moment the stretch makes it longest.
    splinterSize: 0.3,
    splinterSpeed: 9,
    // 0.92 not 1: `brightnessAt` peaks at ~0.85, so a shard is never fully
    // opaque anyway, and the last 8% buys a little motion-blur read on a
    // sprite that is genuinely moving 9 m/s.
    splinterAlpha: 0.92,
    splinterAspect: 4.5,
    splinterSpin: 7,
    splinterMomentum: 0.85,
    // 0.5 not the old 0.85. At 0.85 the burst was very nearly a full
    // hemisphere, i.e. it had no relationship to the impact at all — which is
    // why it read as "generic particles" no matter what colour they were.
    splinterSpread: 0.5,
    chunkCount: 40,
    // 2 per hit and 8 on a breach: the RATIO is the statement, not the
    // numbers. An ordinary ball punching through planking knocks a couple of
    // pieces loose; a section actually stoving in is where the ship comes
    // apart, and if the two look the same then the breach — the one moment
    // that matters — reads as just another hit.
    chunkPerHit: 2,
    chunkPerBreach: 8,
    chunkLife: 6,
    chunkFloatLife: 3,
    chunkSpeed: 7,
    chunkSpread: 0.55,
    chunkSize: 0.8,
    chunkSpin: 6,
    splashLife: 1.5,
    splashSize: 0.55,
    splashSpeed: 3.2,
    splashGrowth: 3.4,
    splashWind: 0.55,
    splashAlpha: 0.45,
    impactFlashLife: 0.07,
    impactFlashSize: 1.5,
    impactSmokeLife: 3.4,
    impactSmokeSize: 0.65,
    impactSmokeGrowth: 6,
    impactSmokeSpeed: 5,
    impactSmokeRise: 1.2,
    impactSmokePerHit: 10,
    debrisPerHit: 12,
    breechLife: 1.4,
    breechSize: 0.3,
    breechGrowth: 5,
    breechSpeed: 6,
    breechRise: 2.6,
    breechPerShot: 6,
    breechUp: 0.8,
    columnLife: 0.95,
    columnSize: 0.5,
    columnGrowth: 2.4,
    columnSpeed: 15,
    columnPerHit: 12,
    columnAlpha: 0.8,
    crownLife: 0.62,
    crownSize: 0.42,
    crownGrowth: 2.1,
    crownSpeed: 7.5,
    crownPerHit: 14,
    // 55° off vertical — the measured rim angle of a low-Froude cavity crown,
    // and near enough to the 54.74° Kelvin cusp that the bow wave uses that
    // the two families of white water in this game agree with each other
    crownTilt: 0.96,
    crownJitter: 0.55,
    crownAlpha: 0.9,
    impactSpeedRef: 45,
    impactSpeedMax: 2.2,
    ringLife: 1.4,
    ringRadius: 5.5,
    ringWidth: 0.32,
    ringLift: 0.12,
    ringCount: 24,
    ringOpacity: 0.5,
    foamLife: 5,
    foamRadius: 2.2,
    foamGrowth: 2.1,
    foamOpacity: 0.42,
    foamCount: 20,
    foamDrift: 0.03,
    // one gun flash lighting a 35 m hull from ~2 m out. PointLight intensity
    // in three r155+ is candela and falls as 1/d²; 900 puts a readable key on
    // the bulwark at 3 m without washing the deck at 15 m.
    flashLightIntensity: 900,
    flashLightRange: 55,
    flashLightDecay: 0.075,
    smokePerShot: 14,
    splintersPerBreach: 18,
    splashPerHit: 10,
    smokeAspect: 0.75,
    smokeDissolve: 0.55,
    smokeDissolveScale: 2.6,
    intensity: 1,
    wreckTumble: 0.7,
    wreckSinkSpeed: 1.2,
    wreckSinkDepth: 12,
  },
  {
    particleCount: { min: 64, max: 4096, step: 64 },
    ballCount: { min: 8, max: 256, step: 8 },
    ballDrawRadius: { min: 0.05, max: 0.6, step: 0.01 },
    flashLife: { min: 0.02, max: 0.4, step: 0.01 },
    flashSize: { min: 0.2, max: 6, step: 0.1 },
    smokeLife: { min: 0.2, max: 8, step: 0.1 },
    smokeSize: { min: 0.1, max: 4, step: 0.05 },
    smokeGrowth: { min: 1, max: 12, step: 0.1 },
    smokeSpeed: { min: 0, max: 40, step: 0.5 },
    smokeDrag: { min: 0.1, max: 15, step: 0.1 },
    smokeRiseSpeed: { min: 0, max: 8, step: 0.05 },
    smokeWind: { min: 0, max: 1, step: 0.01 },
    smokeGrowthExp: { min: 0.2, max: 2, step: 0.05 },
    smokeRise: { min: 0, max: 2, step: 0.05 },
    sparkLife: { min: 0.05, max: 2, step: 0.01 },
    sparkSize: { min: 0.02, max: 1, step: 0.01 },
    sparkSpeed: { min: 0, max: 60, step: 0.5 },
    sparksPerShot: { min: 0, max: 64, step: 1 },
    // capped at 8: this is the §V.44 bound on the additive flash term, and a
    // slider that can reach the bloom clamp (12) is a slider that can blow
    // the frame out to white
    flashBoost: { min: 0, max: 8, step: 0.1 },
    trailLife: { min: 0, max: 3, step: 0.05 },
    trailSize: { min: 0.02, max: 2, step: 0.01 },
    trailGrowth: { min: 1, max: 10, step: 0.1 },
    trailEvery: { min: 1, max: 12, step: 1 },
    ballStretch: { min: 0, max: 0.4, step: 0.005 },
    ballStretchMax: { min: 1, max: 30, step: 0.5 },
    variation: { min: 0, max: 1, step: 0.01 },
    splinterLife: { min: 0.1, max: 4, step: 0.05 },
    splinterSize: { min: 0.05, max: 1, step: 0.01 },
    splinterSpeed: { min: 0, max: 30, step: 0.5 },
    splinterAlpha: { min: 0, max: 1, step: 0.01 },
    // max matches fxMath.SPLINTER_ASPECT_MAX — the slider cannot ask for a
    // ratio the spawn boundary will silently clamp away (§V.62: a knob whose
    // top half does nothing is a knob that lies)
    splinterAspect: { min: 1, max: 6, step: 0.1 },
    splinterSpin: { min: 0, max: 20, step: 0.5 },
    splinterMomentum: { min: 0, max: 3, step: 0.05 },
    splinterSpread: { min: 0, max: 1, step: 0.01 },
    // `chunkCount` has no range entry on purpose: the pool is sized at
    // construction (§V.28) and a live slider on it would be a dead knob, which
    // is the §V.62 defect this project keeps re-finding.
    chunkPerHit: { min: 0, max: 16, step: 1 },
    chunkPerBreach: { min: 0, max: 32, step: 1 },
    chunkLife: { min: 0.5, max: 20, step: 0.5 },
    chunkFloatLife: { min: 0, max: 20, step: 0.5 },
    chunkSpeed: { min: 0, max: 25, step: 0.5 },
    chunkSpread: { min: 0, max: 1, step: 0.01 },
    chunkSize: { min: 0.1, max: 3, step: 0.05 },
    chunkSpin: { min: 0, max: 20, step: 0.5 },
    splashLife: { min: 0.1, max: 4, step: 0.05 },
    splashSize: { min: 0.1, max: 5, step: 0.1 },
    splashSpeed: { min: 0, max: 30, step: 0.5 },
    impactFlashLife: { min: 0.02, max: 0.4, step: 0.01 },
    impactFlashSize: { min: 0.2, max: 6, step: 0.1 },
    impactSmokeLife: { min: 0.2, max: 8, step: 0.1 },
    impactSmokeSize: { min: 0.05, max: 4, step: 0.05 },
    impactSmokeGrowth: { min: 1, max: 12, step: 0.1 },
    impactSmokeSpeed: { min: 0, max: 30, step: 0.5 },
    impactSmokeRise: { min: 0, max: 8, step: 0.05 },
    breechLife: { min: 0.1, max: 5, step: 0.05 },
    breechSize: { min: 0.05, max: 2, step: 0.01 },
    breechGrowth: { min: 1, max: 12, step: 0.1 },
    breechSpeed: { min: 0, max: 30, step: 0.5 },
    breechRise: { min: 0, max: 8, step: 0.05 },
    breechPerShot: { min: 0, max: 64, step: 1 },
    breechUp: { min: 0, max: 1, step: 0.01 },
    impactSmokePerHit: { min: 0, max: 64, step: 1 },
    debrisPerHit: { min: 0, max: 64, step: 1 },
    columnLife: { min: 0.1, max: 4, step: 0.05 },
    columnSize: { min: 0.05, max: 3, step: 0.05 },
    columnGrowth: { min: 1, max: 10, step: 0.1 },
    columnSpeed: { min: 0, max: 40, step: 0.5 },
    columnPerHit: { min: 0, max: 64, step: 1 },
    ringLife: { min: 0.1, max: 6, step: 0.05 },
    ringRadius: { min: 0.5, max: 30, step: 0.1 },
    ringWidth: { min: 0.02, max: 0.95, step: 0.01 },
    ringLift: { min: 0, max: 1, step: 0.01 },
    ringCount: { min: 0, max: 64, step: 1 },
    ringOpacity: { min: 0, max: 2, step: 0.01 },
    flashLightIntensity: { min: 0, max: 4000, step: 10 },
    flashLightRange: { min: 1, max: 300, step: 1 },
    flashLightDecay: { min: 0.01, max: 1, step: 0.005 },
    smokePerShot: { min: 0, max: 64, step: 1 },
    splintersPerBreach: { min: 0, max: 64, step: 1 },
    splashPerHit: { min: 0, max: 64, step: 1 },
    smokeAspect: { min: 0, max: 1, step: 0.01 },
    smokeDissolve: { min: 0, max: 1, step: 0.01 },
    smokeDissolveScale: { min: 0.5, max: 12, step: 0.1 },
    intensity: { min: 0, max: 3, step: 0.05 },
    wreckTumble: { min: 0, max: 4, step: 0.05 },
    wreckSinkSpeed: { min: 0.1, max: 10, step: 0.1 },
    wreckSinkDepth: { min: 2, max: 40, step: 1 },
  },
);
