/**
 * Audio tunables (§V16: every tunable lives in a params module and appears in
 * Tweakpane; §V7 spirit: weather changes only scale params, never switch code
 * paths). Consumed by src/audio/*.
 *
 * Two generations live here on purpose:
 *  - the SAMPLE bed / emitter / trigger block drives the real recordings in
 *    assets/audio/sfx (primary path),
 *  - the synth block below it drives the procedural fallback that runs when a
 *    sample fails to load, plus cannon/hull-hit which have no sample yet.
 */
import { registerParams } from './registry';

export interface AudioParams {
  // ── sample ambience bed (ocean / wind / sailing loops, non-positional) ──
  /** crossfade time constant (s) for every bed layer gain — long = no pop */
  bedFadeTau: number;
  /** slow per-layer gain drift so the bed never reads as a short tape loop */
  bedDriftRateHz: number;
  /** 0..1 depth of that drift (0 = static layer gains) */
  bedDriftDepth: number;
  /** ocean-waves layer gain at the swell preset */
  oceanBedGain: number;
  /** wind layer gain at 0 wind and at windSpeedRef */
  windBedFloor: number;
  windBedGain: number;
  /** the cockpit recording was captured at 12 kn true wind — its neutral rate */
  windRefKnots: number;
  /** ± playbackRate applied across the wind range (pitch = perceived force) */
  windRateSpread: number;
  /** lowpass on the wind layer at 0 wind and at windSpeedRef (Hz) */
  windBedCutoffMinHz: number;
  windBedCutoffMaxHz: number;
  /** general sailing bed (rig + water + wind mix) gain and its speed ref */
  sailBedGain: number;
  sailBedSpeedRef: number;

  // ── positional emitters (PannerNode distance model) ──
  emitterRefDistance: number;
  emitterMaxDistance: number;
  emitterRolloff: number;
  /** ship-local emitter offsets (m): bow/stern along +z/-z, waterline y */
  bowEmitterZ: number;
  sternEmitterZ: number;
  waterlineY: number;
  /** ship-local z of the three mast emitters (galleon defaults) */
  foreMastEmitterZ: number;
  mainMastEmitterZ: number;
  rearMastEmitterZ: number;
  /** height (m) of the sail emitters above the waterline */
  sailEmitterY: number;

  // ── emitter loops keyed to ship state ──
  /** stern wake rush gain at wakeSpeedRef and above */
  wakeGain: number;
  wakeSpeedRef: number;
  /** bow water rush gain (same recording, own loop point) */
  bowRushGain: number;
  /** hull gurgle at the waterline: gain, speed ref, and its idle floor */
  gurgleGain: number;
  gurgleSpeedRef: number;
  gurgleFloor: number;
  /** rigging/hull creak loop gain and the roll+pitch rate (rad/s) that maxes it */
  creakLoopGain: number;
  creakMotionRef: number;
  /** creak loop floor so a becalmed ship still breathes */
  creakFloor: number;
  /** non-positional wooden creak layer — the ship is AROUND the listener */
  creakBedGain: number;
  /** mean |slice burial rate| (m/s) that counts as the hull fully working */
  creakSeaRateRef: number;
  /** discrete creak groans cut out of the 3-min wooden-ship loop */
  creakGroanGain: number;
  creakGroanSliceSec: number;
  /** working level (0..1) that starts/stops groaning, and their spacing (s) */
  creakGroanOn: number;
  creakGroanOff: number;
  creakGroanCooldown: number;
  creakGroanJitter: number;

  // ── slam: the bow coming down on the sea (hullContact burial rate) ──
  /** burial rate (m/s) that fires a slam and re-arms it */
  slamRateOn: number;
  slamRateOff: number;
  /** burial rate (m/s) counted as a full-force impact */
  slamRateFull: number;
  /** fraction of the bow-most slices considered "forward" for the slam */
  slamStationFrac: number;
  slamCooldown: number;
  slamGain: number;
  slamSliceSec: number;
  /** the body layer: same slice, slowed and lowpassed = weight under the spray */
  slamBodyRate: number;
  slamBodyGain: number;
  slamLowpassHz: number;
  /** a hard slam makes the hull groan afterwards */
  slamCreakGain: number;

  // ── combat events (audio.event) ──
  ballSplashGain: number;
  splinterGain: number;
  splinterRateUp: number;
  mastBreakGain: number;
  sinkGroanGain: number;

  // ── event one-shots from samples ──
  /** bow splash slice: gain, slice length (s) and the window it is cut from */
  bowSplashGain: number;
  bowSplashSliceSec: number;
  bowSplashWindowSec: number;
  /** §V27 gates: immersion (m) on/off hysteresis + minimum speed (m/s) */
  bowSplashImmersionOn: number;
  bowSplashImmersionOff: number;
  bowSplashSpeedGate: number;
  /** seconds between bow splashes at most (anti machine-gun) */
  bowSplashCooldown: number;
  /** canvas snap: gain, luff on/off hysteresis, cooldown (s), rate jitter */
  sailSnapGain: number;
  sailSnapLuffOn: number;
  sailSnapLuffOff: number;
  sailSnapCooldown: number;
  sailSnapRateJitter: number;
  /** |Δ sailTrim| within one frame that counts as a sharp trim change */
  trimSnapDelta: number;
  /** sail deploy one-shot gain + the |Δ trim| that counts as a state change */
  sailDeployGain: number;
  sailDeployDelta: number;
  sailDeployCooldown: number;

  // ── reefing / setting sail as a haul (keyed to the cloth drop scalar) ──
  /** cloth-drop units per second that counts as hands hauling */
  haulRateOn: number;
  /** haul speed treated as full effort (louder rustles) */
  haulRateFull: number;
  /** a haul always runs at least this long — covers a one-frame jump in drop */
  haulMinSec: number;
  /** spacing of the rustle slices and its ± randomization */
  haulTickSec: number;
  haulTickJitter: number;
  /** length and gain of one rustle slice cut from the saildeploy recording */
  haulRustleSec: number;
  haulRustleGain: number;
  /** the snap when the canvas is home */
  haulTerminalGain: number;

  // ── luff estimate (audio-side, mirrors ship/sailDynamics conventions) ──
  /** wind speed (m/s) at which cloth shakes at full force */
  luffWindRef: number;
  /** yaw rate (rad/s) contribution to shaking */
  luffTurnGain: number;

  // ── music (streamed playlist, own bus, ducked under combat) ──
  /** master switch for the playlist; volume itself is a settings bus */
  musicEnabled: boolean;
  /** shuffle with a no-repeat window vs strict file order */
  musicShuffle: boolean;
  musicNoRepeat: number;
  /**
   * 0 = pure shuffle (ships this way), 1 = full situational bias toward
   * tracks whose filename tags suit the moment. A bias, never a filter.
   */
  musicTagBias: number;
  /** how much a fully matching track outweighs a non-matching one at bias 1 */
  musicTagBoost: number;
  /** crossfade / fade length (s) at track boundaries */
  musicCrossfadeSec: number;
  /** how early the ONE prefetched next track is armed, before the crossfade */
  musicPrefetchLeadSec: number;
  /** silence before the first track — music must never slam in at boot */
  musicStartDelaySec: number;
  /** silence between tracks per situation: long calms, tight combat */
  musicGapCalmSec: number;
  musicGapIslandSec: number;
  musicGapStormSec: number;
  musicGapCombatSec: number;
  /** distance to land (m) that counts as approaching an island (tag seam) */
  musicLandRadius: number;
  /** combat ducking: level, fall/recover time constants, hold after an event */
  musicDuckLevel: number;
  musicDuckAttack: number;
  musicDuckRelease: number;
  musicDuckHoldSec: number;
  /** slow level match between tracks (streaming rules out scanning a buffer) */
  musicTargetRms: number;
  musicGainMin: number;
  musicGainMax: number;
  musicAgcTau: number;
  musicAgcIntervalSec: number;

  // ── procedural fallback / no-sample one-shots ──
  // ── ocean ambience bed (brown-ish noise → lowpass → LFO swell) ──
  /** bed output gain 0..1 before the ambience bus */
  oceanGain: number;
  /** lowpass cutoff shaping the noise into a distant-surf rumble (Hz) */
  oceanLowpassHz: number;
  /** leaky-integrator coefficient for the brown-ish noise color (0=white) */
  oceanNoiseLeak: number;
  /** wave-rhythm amplitude swell rate (Hz, ~0.1 = one swell per 10s) */
  swellRateHz: number;
  /** 0..1 how deep the swell modulates the bed (0 = constant) */
  swellDepth: number;

  // ── wind layer (white noise → bandpass, follows windSpeed) ──
  /** wind layer gain at full windSpeedRef */
  windGainMax: number;
  /** bandpass center at 0 m/s and at windSpeedRef m/s */
  windCutoffMinHz: number;
  windCutoffMaxHz: number;
  /** bandpass resonance — higher = whistlier */
  windQ: number;
  /** wind speed (m/s) mapped to full-scale wind layer */
  windSpeedRef: number;
  /** smoothing time constant (s) for wind/weather follow */
  ambienceTau: number;

  // ── weather multipliers (calm|swell|storm pick one of each, §V7) ──
  calmGainMult: number;
  swellGainMult: number;
  stormGainMult: number;
  calmSwellRateMult: number;
  swellSwellRateMult: number;
  stormSwellRateMult: number;

  // ── one-shot: cannon boom ──
  cannonDuration: number;
  cannonLowpassStartHz: number;
  cannonLowpassEndHz: number;
  cannonNoiseGain: number;
  cannonSubHz: number;
  cannonSubGain: number;

  // ── one-shot: splash ──
  splashAttack: number;
  splashRelease: number;
  splashBandHz: number;
  splashQ: number;
  splashGain: number;

  // ── one-shot: creak (resonant saw pitch-bend, seeded random) ──
  creakBaseHz: number;
  /** end pitch = start pitch × this ratio (bend downward < 1) */
  creakBendRatio: number;
  /** ± random pitch spread in cents around creakBaseHz */
  creakSpreadCents: number;
  creakDuration: number;
  creakQ: number;
  creakGain: number;

  // ── one-shot: hull hit (thud) ──
  hullHitHz: number;
  hullHitDuration: number;
  hullHitGain: number;
}

export const audioParams: AudioParams = registerParams(
  'audio',
  {
    bedFadeTau: 1.6,
    bedDriftRateHz: 0.017,
    bedDriftDepth: 0.22,
    oceanBedGain: 0.75,
    windBedFloor: 0.1,
    windBedGain: 0.7,
    windRefKnots: 12,
    windRateSpread: 0.22,
    windBedCutoffMinHz: 700,
    windBedCutoffMaxHz: 9000,
    sailBedGain: 0.4,
    sailBedSpeedRef: 6,
    emitterRefDistance: 10,
    emitterMaxDistance: 350,
    emitterRolloff: 1.1,
    bowEmitterZ: 17,
    sternEmitterZ: -17,
    waterlineY: 0,
    foreMastEmitterZ: 10,
    mainMastEmitterZ: 0.5,
    rearMastEmitterZ: -10.5,
    sailEmitterY: 12,
    wakeGain: 0.8,
    wakeSpeedRef: 7,
    bowRushGain: 0.55,
    gurgleGain: 0.6,
    gurgleSpeedRef: 5,
    gurgleFloor: 0.25,
    // re-tuned after the hull got calmer (pitch p95 6.1°→4.7°, heave damping
    // raised): the old 0.35 rad/s reference left the creak at ~8% gain
    creakLoopGain: 0.85,
    creakMotionRef: 0.12,
    creakFloor: 0.4,
    creakBedGain: 0.5,
    creakSeaRateRef: 0.9,
    creakGroanGain: 0.75,
    creakGroanSliceSec: 2.6,
    creakGroanOn: 0.1,
    creakGroanOff: 0.04,
    creakGroanCooldown: 4.5,
    creakGroanJitter: 0.5,
    slamRateOn: 1.6,
    slamRateOff: 0.7,
    slamRateFull: 5,
    slamStationFrac: 0.4,
    slamCooldown: 0.5,
    slamGain: 1,
    slamSliceSec: 1.4,
    slamBodyRate: 0.7,
    slamBodyGain: 0.9,
    slamLowpassHz: 520,
    slamCreakGain: 0.6,
    ballSplashGain: 0.9,
    splinterGain: 0.55,
    splinterRateUp: 1.7,
    mastBreakGain: 0.95,
    sinkGroanGain: 0.85,
    bowSplashGain: 0.85,
    bowSplashSliceSec: 1.1,
    bowSplashWindowSec: 40,
    bowSplashImmersionOn: 0.35,
    bowSplashImmersionOff: 0.12,
    bowSplashSpeedGate: 1.5,
    bowSplashCooldown: 0.7,
    sailSnapGain: 0.7,
    sailSnapLuffOn: 0.45,
    sailSnapLuffOff: 0.25,
    sailSnapCooldown: 1.1,
    sailSnapRateJitter: 0.18,
    trimSnapDelta: 0.06,
    sailDeployGain: 0.8,
    sailDeployDelta: 0.25,
    sailDeployCooldown: 2.5,
    haulRateOn: 0.12,
    haulRateFull: 1.2,
    haulMinSec: 0.5,
    haulTickSec: 0.3,
    haulTickJitter: 0.4,
    haulRustleSec: 0.38,
    haulRustleGain: 0.55,
    haulTerminalGain: 0.8,
    luffWindRef: 9,
    luffTurnGain: 1.6,
    musicEnabled: true,
    musicShuffle: true,
    musicNoRepeat: 3,
    musicTagBias: 0,
    musicTagBoost: 3,
    musicCrossfadeSec: 4,
    musicPrefetchLeadSec: 12,
    musicStartDelaySec: 12,
    musicGapCalmSec: 45,
    musicGapIslandSec: 12,
    musicGapStormSec: 20,
    musicGapCombatSec: 4,
    musicLandRadius: 400,
    // RETUNED (user: "we're manipulating the music volume too intensely, too
    // fast, back and forth, up and down"). The old set pumped: a broadside
    // ducked to 30% in a quarter second, began recovering over 2.5s, and the
    // next volley slammed it down again — the RECOVERY is what you hear, not
    // the duck. Four changes, all in the same direction: duck about half as
    // deep, take longer to get there so it reads as the mix breathing rather
    // than a gate, and above all HOLD through the gaps between volleys so it
    // does not climb back up between shots. Depth and speed are what make a
    // duck audible AS a duck; a slow shallow one is felt and not noticed.
    musicDuckLevel: 0.55,
    musicDuckAttack: 0.6,
    musicDuckRelease: 5,
    musicDuckHoldSec: 9,
    musicTargetRms: 0.12,
    musicGainMin: 0.35,
    musicGainMax: 2.2,
    musicAgcTau: 6,
    musicAgcIntervalSec: 0.25,
    oceanGain: 0.5,
    oceanLowpassHz: 420,
    oceanNoiseLeak: 0.02,
    swellRateHz: 0.11,
    swellDepth: 0.55,
    windGainMax: 0.6,
    windCutoffMinHz: 260,
    windCutoffMaxHz: 1400,
    windQ: 0.9,
    windSpeedRef: 24,
    ambienceTau: 0.6,
    calmGainMult: 0.55,
    swellGainMult: 1.0,
    stormGainMult: 1.7,
    calmSwellRateMult: 0.7,
    swellSwellRateMult: 1.0,
    stormSwellRateMult: 1.8,
    cannonDuration: 1.2,
    cannonLowpassStartHz: 6000,
    cannonLowpassEndHz: 120,
    cannonNoiseGain: 0.9,
    cannonSubHz: 48,
    cannonSubGain: 0.9,
    splashAttack: 0.008,
    splashRelease: 0.35,
    splashBandHz: 900,
    splashQ: 1.2,
    splashGain: 0.6,
    creakBaseHz: 180,
    creakBendRatio: 0.7,
    creakSpreadCents: 300,
    creakDuration: 0.45,
    creakQ: 8,
    creakGain: 0.45,
    hullHitHz: 80,
    hullHitDuration: 0.28,
    hullHitGain: 0.8,
  },
  {
    bedFadeTau: { min: 0.1, max: 8, step: 0.1 },
    bedDriftRateHz: { min: 0.002, max: 0.2, step: 0.001 },
    bedDriftDepth: { min: 0, max: 1, step: 0.01 },
    oceanBedGain: { min: 0, max: 2, step: 0.01 },
    windBedFloor: { min: 0, max: 1, step: 0.01 },
    windBedGain: { min: 0, max: 2, step: 0.01 },
    windRefKnots: { min: 1, max: 40, step: 0.5 },
    windRateSpread: { min: 0, max: 0.5, step: 0.01 },
    windBedCutoffMinHz: { min: 100, max: 4000, step: 50 },
    windBedCutoffMaxHz: { min: 1000, max: 20000, step: 100 },
    sailBedGain: { min: 0, max: 2, step: 0.01 },
    sailBedSpeedRef: { min: 0.5, max: 20, step: 0.5 },
    emitterRefDistance: { min: 1, max: 60, step: 1 },
    emitterMaxDistance: { min: 50, max: 2000, step: 10 },
    emitterRolloff: { min: 0.1, max: 4, step: 0.05 },
    bowEmitterZ: { min: 0, max: 40, step: 0.5 },
    sternEmitterZ: { min: -40, max: 0, step: 0.5 },
    waterlineY: { min: -5, max: 5, step: 0.1 },
    foreMastEmitterZ: { min: -30, max: 30, step: 0.5 },
    mainMastEmitterZ: { min: -30, max: 30, step: 0.5 },
    rearMastEmitterZ: { min: -30, max: 30, step: 0.5 },
    sailEmitterY: { min: 0, max: 40, step: 0.5 },
    wakeGain: { min: 0, max: 2, step: 0.01 },
    wakeSpeedRef: { min: 0.5, max: 20, step: 0.5 },
    bowRushGain: { min: 0, max: 2, step: 0.01 },
    gurgleGain: { min: 0, max: 2, step: 0.01 },
    gurgleSpeedRef: { min: 0.5, max: 20, step: 0.5 },
    gurgleFloor: { min: 0, max: 1, step: 0.01 },
    creakLoopGain: { min: 0, max: 2, step: 0.01 },
    creakMotionRef: { min: 0.02, max: 2, step: 0.01 },
    creakFloor: { min: 0, max: 1, step: 0.01 },
    creakBedGain: { min: 0, max: 2, step: 0.01 },
    creakSeaRateRef: { min: 0.05, max: 5, step: 0.05 },
    creakGroanGain: { min: 0, max: 2, step: 0.01 },
    creakGroanSliceSec: { min: 0.5, max: 8, step: 0.1 },
    creakGroanOn: { min: 0, max: 1, step: 0.01 },
    creakGroanOff: { min: 0, max: 1, step: 0.01 },
    creakGroanCooldown: { min: 0.5, max: 20, step: 0.1 },
    creakGroanJitter: { min: 0, max: 0.9, step: 0.05 },
    slamRateOn: { min: 0.1, max: 10, step: 0.1 },
    slamRateOff: { min: 0, max: 10, step: 0.1 },
    slamRateFull: { min: 0.5, max: 20, step: 0.5 },
    slamStationFrac: { min: 0.1, max: 1, step: 0.05 },
    slamCooldown: { min: 0.05, max: 5, step: 0.05 },
    slamGain: { min: 0, max: 2, step: 0.01 },
    slamSliceSec: { min: 0.2, max: 4, step: 0.05 },
    slamBodyRate: { min: 0.3, max: 1.5, step: 0.05 },
    slamBodyGain: { min: 0, max: 2, step: 0.01 },
    slamLowpassHz: { min: 100, max: 4000, step: 20 },
    slamCreakGain: { min: 0, max: 2, step: 0.01 },
    ballSplashGain: { min: 0, max: 2, step: 0.01 },
    splinterGain: { min: 0, max: 2, step: 0.01 },
    splinterRateUp: { min: 1, max: 4, step: 0.05 },
    mastBreakGain: { min: 0, max: 2, step: 0.01 },
    sinkGroanGain: { min: 0, max: 2, step: 0.01 },
    bowSplashGain: { min: 0, max: 2, step: 0.01 },
    bowSplashSliceSec: { min: 0.2, max: 4, step: 0.05 },
    bowSplashWindowSec: { min: 1, max: 60, step: 1 },
    bowSplashImmersionOn: { min: 0.02, max: 3, step: 0.01 },
    bowSplashImmersionOff: { min: 0, max: 3, step: 0.01 },
    bowSplashSpeedGate: { min: 0, max: 10, step: 0.1 },
    bowSplashCooldown: { min: 0.05, max: 5, step: 0.05 },
    sailSnapGain: { min: 0, max: 2, step: 0.01 },
    sailSnapLuffOn: { min: 0.05, max: 1.4, step: 0.01 },
    sailSnapLuffOff: { min: 0, max: 1.4, step: 0.01 },
    sailSnapCooldown: { min: 0.1, max: 8, step: 0.1 },
    sailSnapRateJitter: { min: 0, max: 0.6, step: 0.01 },
    trimSnapDelta: { min: 0.005, max: 0.5, step: 0.005 },
    sailDeployGain: { min: 0, max: 2, step: 0.01 },
    sailDeployDelta: { min: 0.05, max: 1, step: 0.01 },
    sailDeployCooldown: { min: 0.2, max: 10, step: 0.1 },
    haulRateOn: { min: 0.01, max: 2, step: 0.01 },
    haulRateFull: { min: 0.1, max: 5, step: 0.1 },
    haulMinSec: { min: 0.1, max: 5, step: 0.05 },
    haulTickSec: { min: 0.05, max: 2, step: 0.01 },
    haulTickJitter: { min: 0, max: 0.9, step: 0.05 },
    haulRustleSec: { min: 0.1, max: 2, step: 0.01 },
    haulRustleGain: { min: 0, max: 2, step: 0.01 },
    haulTerminalGain: { min: 0, max: 2, step: 0.01 },
    luffWindRef: { min: 1, max: 40, step: 0.5 },
    luffTurnGain: { min: 0, max: 6, step: 0.1 },
    musicNoRepeat: { min: 0, max: 10, step: 1 },
    musicTagBias: { min: 0, max: 1, step: 0.05 },
    musicTagBoost: { min: 0, max: 10, step: 0.5 },
    musicCrossfadeSec: { min: 0.1, max: 20, step: 0.1 },
    musicPrefetchLeadSec: { min: 0, max: 60, step: 1 },
    musicStartDelaySec: { min: 0, max: 120, step: 1 },
    musicGapCalmSec: { min: 0, max: 300, step: 5 },
    musicGapIslandSec: { min: 0, max: 300, step: 5 },
    musicGapStormSec: { min: 0, max: 300, step: 5 },
    musicGapCombatSec: { min: 0, max: 300, step: 1 },
    musicLandRadius: { min: 50, max: 3000, step: 10 },
    musicDuckLevel: { min: 0, max: 1, step: 0.01 },
    musicDuckAttack: { min: 0.02, max: 3, step: 0.01 },
    musicDuckRelease: { min: 0.1, max: 10, step: 0.1 },
    musicDuckHoldSec: { min: 0.5, max: 30, step: 0.5 },
    musicTargetRms: { min: 0.01, max: 0.5, step: 0.005 },
    musicGainMin: { min: 0.05, max: 1, step: 0.05 },
    musicGainMax: { min: 1, max: 4, step: 0.1 },
    musicAgcTau: { min: 0.5, max: 30, step: 0.5 },
    musicAgcIntervalSec: { min: 0.05, max: 2, step: 0.05 },
    oceanGain: { min: 0, max: 1, step: 0.01 },
    oceanLowpassHz: { min: 80, max: 2000, step: 10 },
    oceanNoiseLeak: { min: 0.001, max: 0.2, step: 0.001 },
    swellRateHz: { min: 0.02, max: 1, step: 0.01 },
    swellDepth: { min: 0, max: 1, step: 0.01 },
    windGainMax: { min: 0, max: 1, step: 0.01 },
    windCutoffMinHz: { min: 50, max: 2000, step: 10 },
    windCutoffMaxHz: { min: 200, max: 6000, step: 10 },
    windQ: { min: 0.1, max: 10, step: 0.1 },
    windSpeedRef: { min: 1, max: 60, step: 1 },
    ambienceTau: { min: 0.05, max: 3, step: 0.05 },
    calmGainMult: { min: 0, max: 3, step: 0.05 },
    swellGainMult: { min: 0, max: 3, step: 0.05 },
    stormGainMult: { min: 0, max: 3, step: 0.05 },
    calmSwellRateMult: { min: 0.1, max: 4, step: 0.1 },
    swellSwellRateMult: { min: 0.1, max: 4, step: 0.1 },
    stormSwellRateMult: { min: 0.1, max: 4, step: 0.1 },
    cannonDuration: { min: 0.2, max: 3, step: 0.05 },
    cannonLowpassStartHz: { min: 500, max: 12000, step: 100 },
    cannonLowpassEndHz: { min: 40, max: 1000, step: 10 },
    cannonNoiseGain: { min: 0, max: 1, step: 0.01 },
    cannonSubHz: { min: 20, max: 120, step: 1 },
    cannonSubGain: { min: 0, max: 1, step: 0.01 },
    splashAttack: { min: 0.001, max: 0.1, step: 0.001 },
    splashRelease: { min: 0.05, max: 2, step: 0.01 },
    splashBandHz: { min: 200, max: 4000, step: 10 },
    splashQ: { min: 0.1, max: 10, step: 0.1 },
    splashGain: { min: 0, max: 1, step: 0.01 },
    creakBaseHz: { min: 40, max: 800, step: 5 },
    creakBendRatio: { min: 0.3, max: 2, step: 0.05 },
    creakSpreadCents: { min: 0, max: 1200, step: 10 },
    creakDuration: { min: 0.1, max: 2, step: 0.05 },
    creakQ: { min: 1, max: 30, step: 0.5 },
    creakGain: { min: 0, max: 1, step: 0.01 },
    hullHitHz: { min: 30, max: 300, step: 5 },
    hullHitDuration: { min: 0.05, max: 1, step: 0.01 },
    hullHitGain: { min: 0, max: 1, step: 0.01 },
  },
);
