/**
 * RAFT 2100 — Kon-Tiki dimensions (§V82: TO SCALE, FROM THE REFERENCE, not
 * eyeballed). Every value cites a row of docs/raft2100/kon-tiki-reference.md
 * as `[§n Row]`; values the reference does not pin are marked `// EST` with
 * the photo/range they were read from. `buildRaftBlueprint` (src/ship/
 * raftBlueprint.ts) is a pure function of this object.
 *
 * FRAME (same as the other two classes): +z bow, +x STARBOARD, +y up,
 * y = 0 waterline. The log centrelines sit AT the waterline: "logs ~half
 * submerged" [§1 Draft].
 */
import { registerParams, type ParamMeta } from './registry';

export interface RaftParams {
  /** seed for the chink widths / log diameters (§V2 — hashed, never random) */
  seed: number;
  // --- §1 Hull
  logCount: number; // [§1 Main logs] 9 balsa logs
  logCentreLength: number; // [§1 Centre log] 13.7 m
  logOuterLength: number; // [§1 Side logs] outermost 9.1 m, symmetric linear stagger
  logDiameterMax: number; // [§1 Log diameter] up to 60 cm fresh
  logDiameterMin: number; // [§1 Log diameter] use 50–60 cm
  logBowTaper: number;
  logTaperLength: number; // EST — m, the bow end tapers over THIS much only; the body is full-round (§B81) // EST — bow radius ÷ stern radius; "tapering" [§1 Log diameter]
  logBowChamfer: number; // EST — length of the pointed tip, m [§1 Bow ends "pointed/chamfered"]
  chinkMin: number; // [§1 Gaps] 2 cm
  chinkMax: number; // [§1 Gaps] 8 cm
  guaraChinkMin: number; // [§2 Positions] guaras sit "in larger chinks" — a 2.5 cm plank needs > 2.5 cm
  sternProjection: number; // [§1 Stern] three middle logs project ~0.6 m
  sternProjectingLogs: number; // [§1 Stern] three
  logAxisY: number; // [§1 Draft] logs ~half submerged → centreline at the waterline
  splashboardHeight: number; // [§1 Bow ends] 30–40 cm
  splashboardThickness: number; // EST — "dark plank" [§1 Bow ends]
  splashboardInset: number; // EST — set back from the log tips, m [PHOTO-02,03]
  splashboardRun: number; // EST — m the side boards run aft along the outer logs: a low bulwark down the fore-body [ref-sails-1947]
  crossbeamCount: number; // [§1 Cross-beams] 9
  crossbeamPitch: number; // [§1 Cross-beams] ~0.91 m
  crossbeamDiameter: number; // [§1 Cross-beams] ~30 cm
  crossbeamLength: number; // [§1 Cross-beams] ~5.5 m
  lashingRopeDiameter: number; // [§1 Lashing] 30 mm hemp
  lashingTurns: number; // EST — rope turns per crossing, read as the ring's width [PHOTO-08]
  footRailDiameter: number; // EST — "one slim balsa log" [§1 Foot-rails]
  footRailLength: number; // EST — runs the decked length [§1 Foot-rails]
  matThickness: number; // EST — split bamboo + plaited mats [§1 Deck]
  // --- §3 Cabin
  cabinWidth: number; // [§3 Plan] 2.4 m
  cabinLength: number; // [§3 Plan] 4.3 m
  cabinAftZ: number; // EST — "amidships, nearer stern" [§3 Location]; leaves bare logs aft [§5 Stern]
  cabinEave: number; // EST — wall height over floor; ridge "1.2–1.5" [§3 Height] and clear 1.2 everywhere
  cabinRidge: number; // [§3 Height] ~1.2–1.5 m ridge over floor
  cabinWallThickness: number; // EST — split-bamboo weave [§3 Walls]
  cabinOpeningLength: number; // [§3 Opening] ~1.4 m of the STARBOARD wall
  cabinOpeningAftOffset: number; // EST — opening "mid-to-aft" [§3 Museum]: from the aft wall
  cabinBoxHeight: number; // EST — floor mats over 8 lashed boxes [§3 Floor]
  roofOverhang: number; // [§3 Roof] 20–30 cm
  roofThickness: number; // EST — laths + leaves [§3 Roof]
  // --- §B87 the roof is COURSES, not a slab [§3 Roof: "overlapping banana
  // leaves like tiles"; museum ragged 20–30 cm overhang]
  roofCoursePitch: number; // EST — m up the slope from one course butt to the next
  roofCourseOverlap: number; // EST — m each course reaches back UNDER the one above it
  roofCourseRise: number; // EST — m a course stands proud of the course below: the step that self-shadows at a grazing sun
  roofEaveSegments: number; // EST — the eave course is broken into this many butts, each its own length
  roofEaveRagged: number; // EST — m the eave butts wander about roofOverhang; the sum lands in the reference's 20–30 cm
  roofLathCount: number; // EST — bamboo laths per slope, under the thatch [§3 Roof "bamboo laths"]
  roofLathSection: number; // EST — m, square section of one lath
  // --- §B87 cabin interior: it must read as lived-in from the doorway [§3
  // Floor / Radio corner / Museum]
  floorMatLength: number; // EST — a loose reed mat thrown over the box layer [§3 Floor]
  floorMatWidth: number; // EST
  floorMatThickness: number; // EST
  mattressLength: number; // EST — straw mattress; the crew slept fore-and-aft along the logs [§3 Floor]
  mattressWidth: number; // EST
  mattressHeight: number; // EST
  partitionLength: number; // EST — cardboard partition screening the radio corner [§3 Radio corner]
  partitionHeight: number; // EST — chest-high on a sitting man, well under the eave
  partitionThickness: number; // EST — cardboard
  radioCrateWidth: number; // EST — §B87: the set SITS on a crate; a radio in mid-air was the bug
  radioCrateDepth: number; // EST
  radioCrateHeight: number; // EST — tall enough that a crouched player's eye is near level with the dial
  radioWidth: number; // EST — a salvaged car-radio face in a jury-rigged case [2100 dressing]
  radioHeight: number; // EST
  radioDepth: number; // EST
  radioDialDiameter: number; // EST — the game's main interface (T103): identifiable at arm's length
  radioMeterWidth: number; // EST — signal meter
  radioMeterHeight: number; // EST
  radioCrankReach: number; // EST — m the hand crank stands off the case side
  batteryCaseWidth: number; // EST — battery cases beside the set [§3 Radio corner]
  batteryCaseHeight: number; // EST
  batteryCaseDepth: number; // EST
  potDiameter: number; // EST — pots/ladle on the wall by the door [§3 Museum, §6]
  potHeight: number; // EST
  chartWidth: number; // EST — chart on the starboard wall by the door [§6]
  chartHeight: number; // EST
  aerialSag: number; // EST — m the wire aerial dips between the aft gable and the mast crossing
  // --- ref §10 (replica-moored-beam, inspiration only)
  railHeight: number; // EST — m over the log tops: a low sloppy railing, not a bulwark
  railPostDiameter: number; // EST
  railPosts: number; // EST — stanchions per side
  railRopeDiameter: number; // EST
  railRopeSag: number; // EST — m the rope dips in a span; the point is that it is SLACK
  chestLength: number; // EST — plank chest lashed on the fore-deck [ref §10]
  chestWidth: number; // EST
  chestHeight: number; // EST
  // --- §T34 seeded variation of the dressing (⊥ one box copied three times)
  crateSizeVar: number; // EST — 0..1, how far the three cabin-side crates differ in each dimension
  crateYawVar: number; // EST — rad, how far each is shoved off square
  crateLashRope: number; // EST — m, the rope band round a lashed crate
  // --- §4 Mast & rig
  mastGapToCabin: number; // EST — legs "just forward of cabin front wall" [§4 Leg spacing]
  mastHeight: number; // [§4 Height] 8.8 m to crossing (WP); museum "nearly 10" — EST range 8.5–10
  mastLegSpacing: number; // EST — ≈ 4.5 m at deck [§4 Leg spacing]
  mastLegDiameter: number; // [§4 Pole Ø] 15–20 cm
  mastCrossingOverlap: number; // EST — legs run past the crossing, lashed [§4 Mast]
  topPoleHeight: number; // EST — "short pole above crossing" [§4 Masthead]
  platformSize: number; // EST — "wooden lookout platform at crossing" [§4 Masthead]
  platformThickness: number; // EST
  ladderWidth: number; // EST — rope ladder w/ wooden rungs [§4 Masthead]
  ladderRungPitch: number; // EST
  ladderStandoff: number; // EST — m the ladder hangs off the leg's surface (§B75)
  ladderGrabHeight: number; // EST — m up the leg the climber takes hold; the `station-ladder` socket rides here (§B78-3)
  lookoutHeadroom: number; // EST — m of clear air over the lookout platform: the topsail's foot is hoisted above a standing man (§B78-4)
  // --- §B73 the rig is JANKY [ref-sails-1947]: seeded per-piece cock / rake /
  // slew, scaled by shipDetailParams.irregularity; every value an upper bound
  yardCock: number; // EST — rad, a yard hoisted with one arm higher (photo ≈ 6–10°)
  yardRake: number; // EST — rad, the sail's head pulled forward of its foot (photo ≈ 5°)
  yardSlew: number; // EST — rad, the yard's resting brace off square
  yardOffset: number; // EST — m, hoisted off-centre on the mast
  mastRakeAft: number; // EST — rad, the whole bipod leans AFT [ref-sails-1947 ≈ 5–8°] (§B75)
  legLeanJitter: number; // EST — rad, each bipod leg's own fore-aft lean
  topPoleTilt: number; // EST — rad, the topsail pole lashed askew above the crossing
  crossingWrapWidth: number; // EST — m, the rope bundle at the bipod crossing
  mizzenSpritAngle: number; // EST — rad, the mizzen's spar stands as a SPRIT, the sail hanging loose off it
  yardLength: number; // [§4 Yard] ~5.5 m+ — EST 6.0 (wider than the 5.5 m sail)
  yardDiameter: number; // EST — two bamboo stems bound together [§4 Yard]
  /**
   * EST — m from the MAST/LEG axis to the yard axis, i.e. the slack in the
   * rope parrel that holds the yard to the spar it is hoisted on.
   *
   * §B74/T114 measured this one on the raft: at 0.05 the mainsail's flat cut
   * panel sat 53 mm INSIDE the bipod legs it hangs between, and the topsail
   * and mizzen cleared their own poles by 43 and 60 mm. See the note on the
   * value for what this knob can and cannot fix.
   */
  yardMastClearance: number;
  /**
   * EST — m of AIR between a SINGLE pole and the yard parreled to it (topsail,
   * mizzen), as opposed to the bipod's `yardMastClearance`.
   *
   * §T.138/§V66: `yardMastClearance` is 0.30 m because the MAIN yard hangs
   * between two legs that SPLAY, and its cloth has to miss both. A yard on one
   * pole has no such problem, and 0.30 m of nothing between a 0.10 m mizzen
   * pole and its 0.07 m yard is what the user saw as "the horizontal bar for
   * the back sail is floating mid-air" — the spar read as unattached because
   * the gap was three times the pole's own diameter. A parrel's slack is a
   * rope turn or two of the spar it goes round, and `lashing-parrel-{mast}`
   * draws the seizing across it. [§4 Topsail, Mizzen]
   */
  poleParrelGap: number;
  sailYardOffset: number; // EST — cloth forward of the yard axis
  mainYardHeight: number; // EST — hoisted below the crossing [PHOTO-10]
  mainYardFurlDrop: number; // EST — m the main yard comes DOWN its halyard when furled [ref §10 replica-moored-beam: the roll rides ~2.3 m over the deck] (§B86-3)
  furlBundlePack: number; // EST — furled-roll radius per (cloth area ÷ yard length); light cotton packs tighter than a galleon's flax (§B86-3)
  mainSailWidth: number; // [§4 Mainsail] 5.5 m wide
  mainSailDrop: number; // [§4 Mainsail] 4.6 m drop
  sailWindRef: number; // EST — m/s of apparent wind at which THIS raft's canvas reads full (§B86-2); overrides shipMaterialParams.sailWindRef per sail
  topsailHeightAboveCrossing: number; // EST — on the short pole [§4 Topsail]
  topsailYardLength: number; // EST — [§9.2] topsail size unknown
  topsailWidth: number; // EST
  topsailDrop: number; // EST
  mizzenZ: number; // EST — "short mizzen pole at stern" [§4 Mizzen]
  /**
   * EST — WANTED offset to port, to clear the oar sweep [PHOTO-10].
   * §T.138: `buildMizzenAndFlag` SNAPS this to the crown of the nearest log —
   * a pole stepped in a chink is a pole standing where a guara rides.
   */
  mizzenX: number;
  mizzenHeight: number; // EST — [§9.2] mizzen size unknown
  mizzenDiameter: number; // EST
  mizzenYardLength: number; // EST
  mizzenSailWidth: number; // EST
  mizzenSailDrop: number; // EST
  flagpoleHeight: number; // EST — "tall thin flag/antenna pole" [§4 Mizzen]
  flagpoleDiameter: number; // EST
  flagpoleX: number; // EST — WANTED, snapped to a log crown like `mizzenX`
  flagFly: number; // EST — Norwegian flag [§4 Mizzen]
  flagHoist: number; // EST
  // --- §2 Guaras
  guaraCount: number; // [§2 Count] 5
  guaraHeight: number; // [§2 Size] ~2 m total
  guaraWidth: number; // [§2 Size] 60 cm
  guaraThickness: number; // [§2 Size] 25 mm
  guaraDepth: number; // [§2 Size] 1.5 m below raft — below the log AXIS (y = 0, the waterline), so 0.5 m of a 2 m plank shows fully lowered
  guaraTravel: number; // EST — how far a guara is hand-raised [§2 Fixing "partway"]
  guaraDefaultDepth: number; // EST — 0 = fully raised, 1 = fully lowered; rest pose
  guaraFwdZ: number; // EST — "~2 at bow" [§2 Positions]
  guaraAftZ: number; // EST — "~2 at stern"
  guaraMidZ: number; // EST — "1 midships", forward of the mast
  // --- §5 Steering
  sternBlockLength: number; // [§5 Mount] ~2.5 m
  sternBlockSection: number; // [§5 Mount] 30 cm
  tholePinHeight: number; // [§5 Mount] ~30 cm
  tholePinSpacing: number; // [§5 Mount] ~40 cm
  tholePinDiameter: number; // EST
  oarLength: number; // [§5 Oar] 5.8 m
  oarShaftDiameter: number; // EST — mangrove pole [§5 Oar]
  oarBladeLength: number; // [§5 Oar] ~1.2 m
  oarBladeWidth: number; // [§5 Oar] ~0.4 m
  oarTillerLength: number; // EST — "cross-piece lashed to handle as tiller" [§5 Oar]
  oarInboard: number; // EST — shaft inboard of the pins, m
  oarDip: number; // EST — rad the blade dips below the block
  // --- §6 Deck items (2100 dressing as boxes — all EST against the museum set)
  crateWidth: number; // EST — pine crates [§6]
  crateHeight: number; // EST
  jerrycanHeight: number; // EST — 2100 stand-in for the water cans [§6]
  drumDiameter: number; // EST — rain drum (2100)
  drumHeight: number; // EST
  dinghyLength: number; // EST — ring dinghy on edge against the port wall [§6]
  dinghyHeight: number; // EST
  dinghyThickness: number; // EST
  cageSize: number; // EST — parrot cage under the roof [§6]
  kitchenBoxSize: number; // EST — Primus box starboard outside the door [§6]
}

const m = (min: number, max: number, step = 0.01): ParamMeta => ({ min, max, step });

export const raftParams: RaftParams = registerParams(
  'ship-raft',
  {
    seed: 1947,
    logCount: 9,
    logCentreLength: 13.7,
    logOuterLength: 9.1,
    logDiameterMax: 0.6,
    logDiameterMin: 0.5,
    logBowTaper: 0.82, // EST
    logTaperLength: 1.6, // EST — [PHOTO-02,03] the logs are parallel full-round cylinders until the last metre or two
    logBowChamfer: 0.7, // EST
    chinkMin: 0.02,
    chinkMax: 0.08,
    guaraChinkMin: 0.05,
    sternProjection: 0.6,
    sternProjectingLogs: 3,
    logAxisY: 0,
    splashboardHeight: 0.55, // EST — [ref-sails-1947] the bow boards stand ~0.5–0.6 m over the logs; [§1 Bow ends] 30–40 cm is the museum's cut-down set
    splashboardThickness: 0.06, // EST
    splashboardInset: 0.8, // EST — aft of the chamfered tips, where the logs are still full-round
    splashboardRun: 4.5, // EST
    crossbeamCount: 9,
    crossbeamPitch: 0.91,
    crossbeamDiameter: 0.3,
    crossbeamLength: 5.5,
    lashingRopeDiameter: 0.03,
    lashingTurns: 4, // EST
    footRailDiameter: 0.15, // EST
    footRailLength: 7.0, // EST
    matThickness: 0.04, // EST
    cabinWidth: 2.4,
    cabinLength: 4.3,
    cabinAftZ: -4.3, // EST
    cabinEave: 1.2, // EST
    cabinRidge: 1.45,
    cabinWallThickness: 0.05, // EST
    cabinOpeningLength: 1.4,
    cabinOpeningAftOffset: 0.9, // EST
    cabinBoxHeight: 0.3, // EST
    roofOverhang: 0.25,
    roofThickness: 0.08, // EST
    roofCoursePitch: 0.3, // EST — 5 courses over the 1.48 m slope [PHOTO-07,09]
    roofCourseOverlap: 0.14, // EST — a course laps back about half its pitch
    roofCourseRise: 0.015, // EST — 5 × 0.015 keeps the ridge under the §V82 1.6 m cap
    roofEaveSegments: 6, // EST
    roofEaveRagged: 0.05, // EST — 0.25 ± 0.05 = the reference's 20–30 cm
    roofLathCount: 6, // EST
    roofLathSection: 0.045, // EST — split bamboo
    floorMatLength: 1.9, // EST
    floorMatWidth: 1.5, // EST
    floorMatThickness: 0.02, // EST
    mattressLength: 1.9, // EST — a man's length; laid fore-and-aft [§3 Floor]
    mattressWidth: 0.68, // EST
    mattressHeight: 0.13, // EST
    partitionLength: 0.96, // EST
    partitionHeight: 0.95, // EST
    partitionThickness: 0.04, // EST
    radioCrateWidth: 0.52, // EST
    radioCrateDepth: 0.52, // EST
    radioCrateHeight: 0.68, // EST — dial at floor + 0.83; a crouched eye sits at 1.05
    radioWidth: 0.4, // EST
    radioHeight: 0.26, // EST
    radioDepth: 0.22, // EST
    radioDialDiameter: 0.13, // EST — a third of the face; reads from 0.6 m
    radioMeterWidth: 0.11, // EST
    radioMeterHeight: 0.07, // EST
    radioCrankReach: 0.12, // EST
    batteryCaseWidth: 0.34, // EST
    batteryCaseHeight: 0.26, // EST
    batteryCaseDepth: 0.34, // EST
    potDiameter: 0.24, // EST
    potHeight: 0.2, // EST
    chartWidth: 0.6, // EST
    chartHeight: 0.45, // EST
    aerialSag: 0.35, // EST
    railHeight: 0.78, // EST — 0.4 m over the mats: knee-to-thigh, as the reference
    railPostDiameter: 0.08, // EST
    railPosts: 5, // EST
    railRopeDiameter: 0.022, // EST
    railRopeSag: 0.11, // EST
    chestLength: 0.8, // EST
    chestWidth: 0.5, // EST
    chestHeight: 0.42, // EST
    crateSizeVar: 0.28, // EST
    crateYawVar: 0.24, // EST ≈ 14°
    crateLashRope: 0.022, // EST
    mastGapToCabin: 0.6, // EST
    mastHeight: 8.8, // EST 8.5–10
    mastLegSpacing: 4.5, // EST
    mastLegDiameter: 0.18,
    mastCrossingOverlap: 0.35, // EST
    topPoleHeight: 3.6, // EST — long enough to carry the topsail clear of the lookout (§B78-4)
    platformSize: 0.9, // EST
    platformThickness: 0.05, // EST
    ladderWidth: 0.35, // EST
    ladderRungPitch: 0.35, // EST
    ladderStandoff: 0.1, // EST
    ladderGrabHeight: 1.15, // EST — chest height on the rungs
    lookoutHeadroom: 1.85, // EST — a lookout standing on the perch, head and a hand clear
    yardCock: 0.14, // EST
    yardRake: 0.09, // EST
    yardSlew: 0.12, // EST
    yardOffset: 0.2, // EST
    mastRakeAft: 0.11, // EST ≈ 6.3°
    legLeanJitter: 0.035, // EST
    topPoleTilt: 0.03, // EST
    crossingWrapWidth: 0.45, // EST
    mizzenSpritAngle: 0.45, // EST
    yardLength: 6.0, // EST
    yardDiameter: 0.12, // EST
    // §B74 — 0.15 m of AIR between a 0.18 m leg and a 0.12 m yard: a parrel
    // with slack in it, which is what a raft's jury rig has. This lifts the
    // topsail off its pole (0.043 → 0.18 m), the mizzen off its own (0.060 →
    // 0.23) and the MAINSAIL'S HEAD out of the bipod (−0.031 → +0.024).
    //
    // IT DOES NOT CLEAR THE BODY OF THE MAINSAIL, AND NO VALUE OF IT CAN —
    // measured, `tests/raft.test.ts` states the geometry. The legs SPLAY in x
    // while the sail's plane turns about a vertical axis with the brace, so
    // each leg pierces that plane at some height; standoff slides the pierce
    // point up or down the leg (and what clears the port leg braced one way
    // fouls the starboard leg braced the other) but never removes it. Swept
    // 0.05 → 0.55 with `sailYardOffset` 0.12 → 0.34: the fouled fraction of
    // the panel moves 0.54 % → 0.30 % and the worst point stays at ≈ −0.05 m.
    // The cloth-side push (§T.114 sparPush) is the fix for that band.
    yardMastClearance: 0.3, // EST
    poleParrelGap: 0.12, // EST — §T.138: ≈ one mizzen-pole diameter of slack, seized
    sailYardOffset: 0.12, // EST
    mainYardHeight: 7.2, // EST
    mainYardFurlDrop: 4.5, // EST — 7.2 → 2.7 on the mast, ≈ 2.7 m over the log tops [ref §10]
    furlBundlePack: 0.029, // EST — ≈ 0.24 m thick on the 5.5 × 4.6 m main [ref §10]
    mainSailWidth: 5.5,
    mainSailDrop: 4.6,
    // §B86-2 [ref-sails-1947]: light cotton on a bamboo yard in the trades is
    // drum-full at 8–11 m/s, where the galleon's 6.43 leaves it half-bellied
    sailWindRef: 4.2,
    topsailHeightAboveCrossing: 3.3, // EST — hoisted above the lookout's head (§B78-4)
    topsailYardLength: 2.3, // EST
    topsailWidth: 2.0, // EST
    topsailDrop: 0.9, // EST — a small sail set flying on a short pole [§9.2 size unknown]
    mizzenZ: -5.4, // EST
    // §T.138 — at ±0.9 both stern poles stood in the two aft guara CHINKS
    // (Δx to guara-4 0.035 m, to guara-5 0.005 m: the flagpole's box ran clean
    // THROUGH the starboard guara plank), which is why the user read them as
    // "two poles from the guaras". ±1.2 lands on logs ±2, on a crown, outboard
    // of the helmsman's tiller swing.
    mizzenX: -1.2, // EST
    mizzenHeight: 4.4, // EST — [ref-sails-1947] the mizzen flies clear above the cabin ridge
    mizzenDiameter: 0.1, // EST
    mizzenYardLength: 2.2, // EST
    mizzenSailWidth: 2.0, // EST
    mizzenSailDrop: 1.6, // EST
    flagpoleHeight: 5.0, // EST
    flagpoleDiameter: 0.06, // EST
    flagpoleX: 1.2, // EST — mirror of `mizzenX`, also snapped to a crown
    flagFly: 0.9, // EST
    flagHoist: 0.65, // EST
    guaraCount: 5,
    guaraHeight: 2.0,
    guaraWidth: 0.6,
    guaraThickness: 0.025,
    guaraDepth: 1.5,
    guaraTravel: 1.2, // EST
    guaraDefaultDepth: 0.5, // EST
    guaraFwdZ: 2.2, // EST
    // §T.138 — the aft pair used to sit 0.99 m from `station-tiller`, inside
    // the disc the helmsman needs for himself and the tiller bar he sweeps
    // (capsule 0.30 + half of `oarTillerLength`). Forward to just abaft the
    // cabin's aft wall: still aft of the sail's centre of effort (§T.96), still
    // in the larger chinks [§2 Positions], out of the helmsman's way.
    guaraAftZ: -4.65, // EST
    guaraMidZ: 1.4, // EST
    sternBlockLength: 2.5,
    sternBlockSection: 0.3,
    tholePinHeight: 0.3,
    tholePinSpacing: 0.4,
    tholePinDiameter: 0.06, // EST
    oarLength: 5.8,
    oarShaftDiameter: 0.09, // EST
    oarBladeLength: 1.2,
    oarBladeWidth: 0.4,
    oarTillerLength: 0.9, // EST
    oarInboard: 1.8, // EST
    oarDip: 0.35, // EST
    crateWidth: 0.6, // EST
    crateHeight: 0.5, // EST
    jerrycanHeight: 0.47, // EST
    drumDiameter: 0.58, // EST
    drumHeight: 0.88, // EST
    dinghyLength: 2.2, // EST
    dinghyHeight: 1.0, // EST
    dinghyThickness: 0.35, // EST
    cageSize: 0.4, // EST
    kitchenBoxSize: 0.45, // EST — a Primus box; sized so the strip stays a road (§B78-2)
  },
  {
    seed: m(0, 99999, 1),
    logCentreLength: m(10, 16),
    logOuterLength: m(6, 13.7),
    logDiameterMax: m(0.3, 0.8),
    logDiameterMin: m(0.3, 0.8),
    logBowTaper: m(0.5, 1), logTaperLength: m(0.2, 4, 0.1),
    chinkMin: m(0, 0.1, 0.005),
    chinkMax: m(0, 0.15, 0.005),
    cabinEave: m(0.9, 1.5),
    cabinRidge: m(1.2, 1.6),
    splashboardHeight: m(0.2, 0.8), splashboardRun: m(0, 8, 0.1),
    yardCock: m(0, 0.4), yardRake: m(0, 0.3), yardSlew: m(0, 0.4), yardOffset: m(0, 0.6),
    mastRakeAft: m(0, 0.25, 0.005), legLeanJitter: m(0, 0.1, 0.005), topPoleTilt: m(0, 0.1, 0.005), mizzenSpritAngle: m(0, 1.2),
    mastHeight: m(8.5, 10),
    mastLegSpacing: m(3, 5.5),
    mainYardHeight: m(5, 8.8),
    mainYardFurlDrop: m(0, 6, 0.1),
    furlBundlePack: m(0.005, 0.1, 0.001),
    mainSailWidth: m(4, 6),
    mainSailDrop: m(3.5, 5),
    sailWindRef: m(1, 30, 0.5),
    lookoutHeadroom: m(1.2, 3),
    guaraDefaultDepth: m(0, 1),
    oarDip: m(0, 0.8),
    // §B87 — the dials the look-dev pass actually turns
    roofCoursePitch: m(0.12, 0.6), roofCourseOverlap: m(0, 0.3), roofCourseRise: m(0, 0.05, 0.001),
    roofEaveSegments: m(1, 16, 1), roofEaveRagged: m(0, 0.12, 0.005),
    roofLathCount: m(0, 12, 1), roofLathSection: m(0.02, 0.1, 0.005),
    radioCrateHeight: m(0.2, 1), radioDialDiameter: m(0.04, 0.25, 0.005),
    railHeight: m(0.3, 1.4), railPosts: m(0, 12, 1), railRopeSag: m(0, 0.4),
    crateSizeVar: m(0, 1), crateYawVar: m(0, 0.8),
  },
);
