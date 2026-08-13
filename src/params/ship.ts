/**
 * Ship dimension tunables (§V.16) — one params object per ship class.
 * Blueprint generators (§V.13) are pure functions of these values; two
 * calls with identical params yield identical piece graphs (§V.2 spirit).
 */
import { registerParams, type ParamMeta } from './registry';

export interface ShipClassParams {
  hullLength: number; // m, stem-to-stern of main hull box
  beam: number;
  freeboard: number; // waterline → main deck top
  draft: number; // waterline → keel top
  hullThickness: number;
  deckThickness: number;
  keelWidth: number;
  keelHeight: number;
  bowLength: number; // stem wedge beyond hull sections
  forecastleLength: number; // 0 = no raised bow deck
  forecastleRise: number;
  sterncastleLength: number; // 0 = no raised stern works
  sterncastleRise: number; // main deck → quarterdeck
  cabinHeight: number; // quarterdeck → cabin roof (poop level)
  galleryHeight: number; // stern gallery window band
  lanternPostHeight: number;
  foreMastZ: number;
  foreMastHeight: number;
  mainMastZ: number;
  mainMastHeight: number;
  rearMastZ: number;
  rearMastHeight: number; // 0 = no rearmast (brigantine)
  mastRadius: number;
  crowNestRadius: number; // 0 = no crow's nest
  crowNestHeight: number;
  crowNestFrac: number; // fraction of mainmast height
  yardLowerFrac: number; // yard height as fraction of mast height
  yardUpperFrac: number;
  yardLowerLenFactor: number; // yard length as fraction of mast height
  yardUpperLenFactor: number;
  yardRadius: number;
  /** gap between mast surface and yard surface (m) — yards ride forward of
   *  the mast so the sail never cuts into it */
  yardMastClearance: number;
  /** sail cloth offset forward of its yard axis (m) */
  sailYardOffset: number;
  /**
   * SAIL DROP as a fraction of mast height (user, twice: "the bottom stages
   * are just not long enough… they might be a little bit on the mast-heavy
   * side").
   *
   * MEASURED on our own rig, which is what makes this defensible: at the old
   * 0.20/0.15 the galleon carried canvas over 0.350 of her mast and left
   * 0.300 of BARE POLE — 9.4 m — below the lowest yard, with 0.240 above the
   * top sail. 65% bare mast. The reference (docs/inspo/ship/
   * ref-rig-proportions.png) is canvas over most of the spar.
   *
   * Fixed by lengthening the SAILS rather than lowering the yards: the
   * complaint is that the cloth is short, not that the spars are high, and
   * yard placement is spar geometry. 0.30/0.19 puts the course's foot at
   * 0.20 of the mast (bare pole 9.4 → 6.3 m), total canvas 0.350 → 0.490,
   * and the course's aspect at 1.29 wide-to-tall, which is the band the
   * reference courses read in.
   *
   * INFERRED, NOT MEASURED, and the distinction matters: the per-tier SPLIT
   * is a proportional scaling of what we had. The references cannot certify
   * per-tier fractions — the fore and main masts overlap in x at every usable
   * threshold, so no clean single-mast profile exists in any shot we have.
   * What IS measured is the total canvas fraction, the bare run below the
   * lowest yard, and the tier count.
   *
   * STILL WRONG, and it needs blueprintRig.ts (deck agent): the reference
   * carries THREE near-contiguous tiers and we carry two. No two-tier rig
   * reaches the reference's canvas fraction without sails of an aspect no
   * square rig has ever had.
   */
  sailDropLowerFactor: number;
  sailDropUpperFactor: number;
  bowspritLength: number;
  bowspritRadius: number;
  bowspritPitch: number; // radians above horizontal
  railHeight: number;
  railThickness: number;
  railInset: number; // rail offset inboard from hull side
  /**
   * How far a waist rail may run toward the ends, as a fraction of hull
   * length — an END CAP, not the run itself. On a ship WITH castles the castle
   * breaks stop the waist run first and this never applies; on a castle-less
   * brigantine it is the only thing keeping the run out of the stem and the
   * transom (§T.45).
   */
  railLengthFactor: number;
  rudderHeight: number;
  rudderChord: number;
  rudderThickness: number;
  /** how far the middle of the transom bulges aft (m) — rounded stern */
  transomCrown: number;
  /** chainplates per mast per side — the shroud fan width (§V12) */
  channelPlates: number;
  /** fore-aft spacing between chainplates (m); the fan rakes aft */
  channelPlateSpacing: number;
  sheerBow: number; // rail rise toward the stem (m)
  sheerStern: number; // rail rise toward the transom (m)
  tumblehome: number; // inward lean of topsides, fraction of half-beam
  keelPinch: number; // hull half-width at the keel, fraction of half-beam
  cannonMountHeight: number; // hull-mounted guns: height above waterline
  cannonInset: number; // deck-mounted guns: offset inboard from side
  cannonSpacing: number; // z distance between neighbouring guns
  cannonsPerSide: number;
}

export const brigantineParams: ShipClassParams = registerParams(
  'ship-brigantine',
  {
    hullLength: 30, beam: 7.2, freeboard: 1.8, draft: 1.7,
    hullThickness: 0.5, deckThickness: 0.12, keelWidth: 0.5, keelHeight: 0.6,
    bowLength: 2.8,
    forecastleLength: 0, forecastleRise: 0,
    sterncastleLength: 0, sterncastleRise: 0, cabinHeight: 0,
    galleryHeight: 0, lanternPostHeight: 0,
    foreMastZ: 7.5, foreMastHeight: 19,
    mainMastZ: -3, mainMastHeight: 23,
    rearMastZ: 0, rearMastHeight: 0,
    mastRadius: 0.32,
    crowNestRadius: 0, crowNestHeight: 0, crowNestFrac: 0,
    yardLowerFrac: 0.52, yardUpperFrac: 0.78,
    yardLowerLenFactor: 0.5, yardUpperLenFactor: 0.36, yardRadius: 0.12,
    yardMastClearance: 0.1, sailYardOffset: 0.16,
    sailDropLowerFactor: 0.26, sailDropUpperFactor: 0.17,
    bowspritLength: 7, bowspritRadius: 0.18, bowspritPitch: 0.28,
    railHeight: 0.9, railThickness: 0.12, railInset: 0.2, railLengthFactor: 0.85,
    rudderHeight: 2.2, rudderChord: 1.2, rudderThickness: 0.15,
    transomCrown: 0.35, channelPlates: 3, channelPlateSpacing: 0.7,
    sheerBow: 0.8, sheerStern: 0.5, tumblehome: 0.1, keelPinch: 0.12,
    cannonMountHeight: 1.3, cannonInset: 0, cannonSpacing: 4, cannonsPerSide: 4,
  },
  shipParamsMeta(),
);

export const galleonParams: ShipClassParams = registerParams(
  'ship-galleon',
  {
    hullLength: 35, beam: 8.5, freeboard: 2.6, draft: 2.0,
    hullThickness: 0.55, deckThickness: 0.15, keelWidth: 0.6, keelHeight: 0.7,
    bowLength: 3.5,
    forecastleLength: 5.5, forecastleRise: 1.6,
    sterncastleLength: 9, sterncastleRise: 2.2, cabinHeight: 2.2,
    galleryHeight: 1.5, lanternPostHeight: 2.0,
    foreMastZ: 10, foreMastHeight: 26,
    mainMastZ: 0.5, mainMastHeight: 31.5, // ≈0.9 × hull length (ref schema)
    rearMastZ: -10.5, rearMastHeight: 21,
    mastRadius: 0.42,
    crowNestRadius: 0.85, crowNestHeight: 0.9, crowNestFrac: 0.86,
    yardLowerFrac: 0.5, yardUpperFrac: 0.76,
    yardLowerLenFactor: 0.42, yardUpperLenFactor: 0.3, yardRadius: 0.15,
    yardMastClearance: 0.12, sailYardOffset: 0.2,
    sailDropLowerFactor: 0.26, sailDropUpperFactor: 0.16,
    bowspritLength: 9, bowspritRadius: 0.22, bowspritPitch: 0.35, // ~20°
    railHeight: 1.0, railThickness: 0.13, railInset: 0.22, railLengthFactor: 0.8,
    rudderHeight: 2.6, rudderChord: 1.4, rudderThickness: 0.18,
    transomCrown: 0.45, channelPlates: 3, channelPlateSpacing: 0.8,
    sheerBow: 1.1, sheerStern: 0.7, tumblehome: 0.12, keelPinch: 0.1,
    cannonMountHeight: 0, cannonInset: 1.0, cannonSpacing: 4, cannonsPerSide: 4,
  },
  shipParamsMeta(),
);

/**
 * §T.34 detail-pass dimensions (§V16). Kept in ONE group rather than smeared
 * across ShipClassParams because they are fittings, not naval architecture:
 * both ship classes want the same deadeye size and the same ratline spacing,
 * and only the pieces that exist on a class get built.
 *
 * Geometry reads these at BUILD time, so dragging them in the panel needs a
 * ship rebuild — same as every other dimension in this module.
 */
export interface ShipDetailParams {
  /** vertical gap between ratline rungs (m) */
  ratlineSpacing: number;
  /** fraction of the shroud run that carries rungs (they stop below the top) */
  ratlineTopFrac: number;
  ratlineRadius: number;
  /** deadeye disc diameter (m) at each chainplate */
  deadeyeRadius: number;
  /** gunport opening, square-ish (m) */
  gunportSize: number;
  /** height of the port sills above the waterline (m) */
  gunportY: number;
  /** ports per hull section per side */
  gunportsPerSection: number;
  /** railing height on the raised decks (m) */
  castleRailHeight: number;
  /**
   * Metres between balusters — a DIMENSION, not a count (§V.66).
   *
   * Both rail builders used a fixed 13 stations whatever the run length, which
   * on the 28 m main run is a post every 2.154 m against the reference's
   * 0.2-0.3 m: seven to ten times too coarse, and square. A count cannot be
   * right for a 5 m castle run and a 20 m waist at the same time; a spacing is
   * right for both by construction.
   */
  balusterSpacing: number;
  /** a baluster's widest radius — the belly of the turning (m) */
  balusterRadius: number;
  /**
   * Height of the SOLID bulwark boarding carried by the waist rail (m).
   *
   * The waist previously had a 0.28 m sheer-strake kerb and then a cap rail
   * 1.0 m up and 0.22 m inboard of it — a 0.72 m band of open air crossed by
   * one thin mid rail, which is why it read as a fence standing next to the
   * hull rather than as bulwark you shelter behind. Note `deckHeightfield.ts`
   * has always modelled BULWARK_HEIGHT 0.95 as the wall its water cannot
   * cross, so the shading geometry and the water solver disagreed by 3x
   * (§V.37: mating systems share their dimensions).
   */
  waistPanelHeight: number;
  /**
   * Companionway width (m), and how far off the centreline the pair sits.
   *
   * ONE SOURCE FOR TWO CONSUMERS (§V.37). The stairs are built in
   * blueprintCastles and the GAPS they land in are cut by blueprintDetail; if
   * those two ever disagree the ship gets a staircase that opens into a
   * railing, which is the class of defect that produced §T.45 in the first
   * place (nothing cut a gap at all, so both stairs simply intersected the
   * rails and the bulkheads behind them).
   */
  stairWidth: number;
  stairOffset: number;
  /** belaying pins per rack */
  pinCount: number;
  /** masthead pennant: fly length and hoist depth (m) */
  pennantFly: number;
  pennantHoist: number;
  /** the pirate flag at the mainmast truck is bigger and squarer */
  flagFly: number;
  flagHoist: number;
  /** stern ensign staff height (m) */
  ensignStaff: number;
  /** anchor stock length (m) */
  anchorSize: number;
  /** decorative sheer moulding section (m) */
  mouldingSize: number;
  /**
   * Metres between the iron hoops that bind a made mast (§T.34 "mast
   * taper/hoops rework", untouched until now — every spar on the ship was a
   * bare cylinder with no fitting anywhere along it).
   *
   * A SPACING, not a count, for the same reason the balusters are: a 21 m
   * mizzen and a 31.5 m mainmast want the same look, and hoops at constant
   * spacing on a tapering spar are also what lets the eye read the taper.
   */
  mastHoopSpacing: number;
  mastHoopThickness: number;
  /** turns in the woolding group — rope, so several close together */
  mastWooldingTurns: number;
  /** gathering bays along a furled yard — the cloth swags between gaskets */
  sailBuntBays: number;
  /** how far a bunt hangs below the yard, as a fraction of its own thickness */
  sailBuntSag: number;
  /** how much fatter a bay's centre is than its gaskets */
  sailBuntSwell: number;
  /**
   * How far the topsides stand PROUD of the deck they enclose (m).
   *
   * The shell used to stop exactly on the deck plane — `hullTopY(z)` at
   * midships IS `freeboard`, and the deck plate is extruded to the same y —
   * so amidships the planking met the deck in a flush, perfectly square
   * arris. That is a CAD join, not a shipwright's: on a real hull the deck
   * lands against the waterway and the frames, and the sheer strake carries
   * on above it. It is also the one place the follow camera looks at all day.
   * ≈ half a strake (girth/hullStrakes ≈ 0.55 m), per the user's "at least
   * like half a plank poking over the deck".
   */
  bulwarkLip: number;
  /**
   * Bevel taken off the top rim's outboard arris (m). §T.34 lists "chamfered
   * edges (90° arrises ⊥)" and this is the first of them. A true 90° arris
   * is infinitely sharp and reads as one aliased line whatever the light
   * does; a centimetre of bevel gives it a facet that catches a highlight
   * and is what separates "cut timber" from "extruded polygon".
   */
  railChamfer: number;
  /** how much every detail generator jitters its stations, 0..1 (§V2 seeded) */
  irregularity: number;
}

export const shipDetailParams: ShipDetailParams = registerParams(
  'ship-detail',
  {
    ratlineSpacing: 0.42, ratlineTopFrac: 0.5, ratlineRadius: 0.022,
    deadeyeRadius: 0.15,
    gunportSize: 0.78, gunportY: 1.55, gunportsPerSection: 3,
    castleRailHeight: 0.95,
    balusterSpacing: 0.28, balusterRadius: 0.045, waistPanelHeight: 0.52,
    // 2.2 m off the centreline puts the pair either side of the wheel (which
    // sits on the centreline 0.7 m aft of the break) with room to walk between
    stairWidth: 1.1, stairOffset: 2.2,
    pinCount: 7,
    pennantFly: 4.2, pennantHoist: 0.55,
    flagFly: 2.2, flagHoist: 1.35,
    ensignStaff: 2.4,
    anchorSize: 2.1,
    mouldingSize: 0.14,
    mastHoopSpacing: 2.2, mastHoopThickness: 0.07, mastWooldingTurns: 4,
    sailBuntBays: 3, sailBuntSag: 1.15, sailBuntSwell: 2.1,
    bulwarkLip: 0.28, railChamfer: 0.035,
    irregularity: 1,
  },
  {
    ratlineSpacing: { min: 0.2, max: 1, step: 0.01 },
    ratlineTopFrac: { min: 0.2, max: 0.95, step: 0.01 },
    ratlineRadius: { min: 0.008, max: 0.06, step: 0.002 },
    deadeyeRadius: { min: 0.05, max: 0.4, step: 0.01 },
    gunportSize: { min: 0.3, max: 1.6, step: 0.02 },
    gunportY: { min: 0.4, max: 3, step: 0.05 },
    gunportsPerSection: { min: 0, max: 5, step: 1 },
    castleRailHeight: { min: 0.4, max: 1.8, step: 0.05 },
    // floor at 0.12: below that a 20 m run is 170 balusters and the merged
    // geometry stops being worth what it costs
    balusterSpacing: { min: 0.12, max: 1.5, step: 0.01 },
    balusterRadius: { min: 0.015, max: 0.12, step: 0.005 },
    waistPanelHeight: { min: 0, max: 1.2, step: 0.02 },
    stairWidth: { min: 0.6, max: 2, step: 0.05 },
    stairOffset: { min: 0.8, max: 4, step: 0.05 },
    pinCount: { min: 0, max: 14, step: 1 },
    pennantFly: { min: 0.5, max: 10, step: 0.1 },
    pennantHoist: { min: 0.1, max: 2, step: 0.05 },
    flagFly: { min: 0.5, max: 6, step: 0.1 },
    flagHoist: { min: 0.3, max: 4, step: 0.05 },
    ensignStaff: { min: 0.5, max: 6, step: 0.1 },
    anchorSize: { min: 0.5, max: 5, step: 0.1 },
    mouldingSize: { min: 0.03, max: 0.5, step: 0.01 },
    mastHoopSpacing: { min: 0.5, max: 8, step: 0.1 },
    mastHoopThickness: { min: 0.02, max: 0.2, step: 0.005 },
    mastWooldingTurns: { min: 0, max: 8, step: 1 },
    sailBuntBays: { min: 1, max: 6, step: 1 },
    sailBuntSag: { min: 0, max: 3, step: 0.05 },
    sailBuntSwell: { min: 1, max: 4, step: 0.05 },
    bulwarkLip: { min: 0, max: 1.2, step: 0.01 },
    railChamfer: { min: 0, max: 0.15, step: 0.005 },
    irregularity: { min: 0, max: 2, step: 0.05 },
  },
);

/**
 * Flag / pennant cloth (§V16). Separate group from ShipMaterialParams because
 * a flag is not a sail: it is a WIND INSTRUMENT. A masthead pennant streaming
 * off the truck is a continuous readable signal of where the wind is relative
 * to the heading, which is information a sailing game needs and this one
 * exposed nowhere. It is driven by APPARENT wind (true wind combined with the
 * ship's own motion) so it answers the helm — it must visibly swing when she
 * comes about, and fall slack when she runs downwind at speed.
 */
export interface ShipFlagParams {
  /**
   * Apparent wind speed (m/s) at which the flag streams dead straight. MUST
   * sit above the usual sailing breeze or the telltale saturates and stops
   * carrying information — it was 7 against a default wind of 11.
   */
  flagStreamRef: number;
  /** angle (rad) the fly hangs below horizontal when the air is dead still */
  flagHang: number;
  /** travelling-ripple amplitude, fraction of the hoist */
  flagWaveAmp: number;
  flagWaveFreq: number; // rad/s
  flagWaveCount: number; // wavelengths along the fly
  /** extra crack/snap depth at the leech when the wind is up */
  flagSnap: number;
  /** how fast the cloth chases a change in apparent wind (1/s) */
  flagResponse: number;
  fieldColor: number; // jolly roger ground
  badgeColor: number; // bone white
  pennantColor: number; // masthead streamer
  pennantStripe: number;
  flagLeeDarken: number;
  flagAmbientLift: number;
}

export const shipFlagParams: ShipFlagParams = registerParams(
  'ship-flag',
  {
    flagStreamRef: 16,
    flagHang: 1.38,
    flagWaveAmp: 0.55, flagWaveFreq: 5.5, flagWaveCount: 1.6,
    flagSnap: 0.5,
    flagResponse: 2.6,
    fieldColor: 0x14100f, badgeColor: 0xe8e2d2,
    pennantColor: 0xa8202a, pennantStripe: 0xe6ded0,
    flagLeeDarken: 0.72, flagAmbientLift: 0.08,
  },
  {
    flagStreamRef: { min: 1, max: 40, step: 0.5 },
    flagHang: { min: 0, max: 1.57, step: 0.01 },
    flagWaveAmp: { min: 0, max: 2, step: 0.01 },
    flagWaveFreq: { min: 0, max: 16, step: 0.1 },
    flagWaveCount: { min: 0.2, max: 6, step: 0.1 },
    flagSnap: { min: 0, max: 2, step: 0.01 },
    flagResponse: { min: 0.2, max: 12, step: 0.1 },
    flagLeeDarken: { min: 0.1, max: 1, step: 0.01 },
    flagAmbientLift: { min: 0, max: 0.5, step: 0.01 },
  },
);

/**
 * Rig BEHAVIOUR tunables (§V16) — how the yards brace and how sail trim maps
 * to the §V13 sail states. Read render-side each frame; no geometry depends
 * on them, so they are safe to drag live in the panel.
 */
export interface ShipRigParams {
  /** max yard swing from athwartships (rad) — beyond this yards foul shrouds */
  braceMax: number;
  /** how fast yards swing toward their brace target (rad/s) */
  braceRate: number;
  /** how much of the "bisect the apparent wind" angle the crew actually uses */
  braceBisect: number;
  /** blend width of the tack flip, in units of the lateral wind component */
  braceTackWidth: number;
  /** sailTrim below this → furled */
  reefFurledBelow: number;
  /** sailTrim below this → reefed */
  reefReefedBelow: number;
  /** extra trim needed to shake out a reef — kills flicker at the threshold */
  reefHysteresis: number;
  /**
   * Cloth drop scale at trim 0 — the bottom of the ONE continuous ramp that
   * animates a reef. Tuned to the gathered bundle's own height (~0.26 of drop)
   * so the single geometry swap at `furlGeometryBelow` changes nothing visible.
   */
  trimDropMin: number;
  /** trim below which the cloth panel is swapped for the gathered bundle */
  furlGeometryBelow: number;
}

export const shipRigParams: ShipRigParams = registerParams(
  'ship-rig',
  {
    braceMax: 0.61, // ~35°
    braceRate: 0.35,
    braceBisect: 0.9,
    braceTackWidth: 0.18,
    reefFurledBelow: 0.15,
    reefReefedBelow: 0.55,
    reefHysteresis: 0.06,
    trimDropMin: 0.24, // measured: minimises the swap step over all 10 sails
    furlGeometryBelow: 0.02,
  },
  {
    braceMax: { min: 0, max: 1.2, step: 0.01 },
    braceRate: { min: 0.02, max: 3, step: 0.01 },
    braceBisect: { min: 0, max: 1.5, step: 0.01 },
    braceTackWidth: { min: 0.02, max: 1, step: 0.01 },
    reefFurledBelow: { min: 0, max: 0.5, step: 0.01 },
    reefReefedBelow: { min: 0.1, max: 0.95, step: 0.01 },
    reefHysteresis: { min: 0, max: 0.3, step: 0.01 },
    trimDropMin: { min: 0.05, max: 1, step: 0.01 },
    furlGeometryBelow: { min: 0, max: 0.2, step: 0.005 },
  },
);

/** Wood/sail material tunables (§V16) — live TSL uniforms unless noted. */
export interface ShipMaterialParams {
  grainScale: number; // fbm sample frequency (1/m)
  grainStretch: number; // <1 elongates grain along the plank axis (z)
  grainOctaves: number; // build-time: changing rebuilds node graph
  triplanarSharpness: number;
  plankWidth: number; // m between plank seams
  /**
   * Strakes from keel to rail on the LOFTED SHELL pieces (hull-section, bow,
   * transom), which plank in the loft's own surface parameter rather than in
   * metres of world height — see WoodTones.strake. A plank runs the length of
   * the hull, so the COUNT is what is fixed and the width follows the girth,
   * narrowing toward both ends the way real planking does. ≈ midship girth /
   * plankWidth, so the boards read the same size amidships either way.
   */
  hullStrakes: number;
  seamWidth: number; // seam falloff as fraction of a plank
  seamDarken: number; // 0..1 multiplier at the seam line
  plankLength: number; // m between BUTT joints along a board
  buttWidth: number; // butt seam falloff (m)
  /**
   * Wale strakes per PLANK, not per metre — a wale is a thickened board in
   * the run, so it is laid out in the same coordinate the planking is or it
   * crosses it. 0.25 = every fourth strake, which also puts both of the
   * wale's edges exactly on plank seams (integer repeat).
   */
  waleFrequency: number;
  waleRatio: number; // 0..1 band coverage, as a fraction of the wale repeat
  waleDarken: number; // 0..1 multiplier inside a wale band
  hullLight: number; // warm mid-tone hull (docs/ship-full-view.png)
  hullDark: number;
  deckLight: number; // pale scrubbed deck planks
  deckDark: number;
  sparLight: number;
  sparDark: number;
  trimLight: number; // rails/rudder/keel — darkest wood
  trimDark: number;
  ironLight: number; // anchors, chainplate straps, deadeye bands
  ironDark: number;
  glassColor: number; // stern cabin lights
  glassLit: number; // warm glow behind them (emissive floor)
  sailLight: number;
  sailDark: number;
  sailWeaveScale: number; // warp/weft noise frequency
  sailBacklitColor: number;
  sailBacklitStrength: number;
  /**
   * PEAK CAMBER PER UNIT DRIVE, AS A FRACTION OF THE CHORD.
   *
   * Was `sailBillow`, "fraction of sail DROP" — and that was the whole of the
   * user's standing "still looks very very bulgy". The belly is a section
   * bowing across the sail's WIDTH, so its depth is camber and camber is
   * measured against the chord it bows over. Scaling it by the drop measured
   * it against the wrong dimension, and the number could not be read as
   * camber at all: at the shipped 0.68 the main course carried 24.8% of chord
   * at the default sea and 40.7% in a storm, against a real square sail's
   * 10-15%. RENAMED rather than retuned on purpose — a silent meaning change
   * is §B.12's trap, and a stale 0.68 in a saved preset must fail loudly.
   */
  sailCamber: number;
  /** hard ceiling on peak camber (fraction of chord). The sheets are hauled
   *  taut: past full load more pressure buys tension, not depth. Bites only
   *  above ~18 m/s, which is what a ceiling is for */
  sailCamberMax: number;
  /**
   * How far the free LEECH stands off the bellied surface, as a fraction of
   * the peak camber depth. A square sail's leech is bent to the ship at
   * exactly two points — the yardarm and the clew — and flies between them.
   * 0 pins it at every height, which is what made the silhouette a perfect
   * rectangle in every wind (user: "the top and bottom corners they don't
   * have to be perfectly straight aligned").
   */
  sailLeechOpen: number;
  /** ROACH: the foot is CUT with an arch, shortest at mid-width. Static, so
   *  the bottom edge is never a straight line even becalmed. Fraction of drop */
  sailFootRoach: number;
  /** TWIST: how far the draft moves aft between the foot and the head, per
   *  unit drive. The upper sail presents at a different angle from the lower
   *  one — after the belly itself, the most recognisable cue that a sail is
   *  answering the wind rather than being posed in it */
  sailTwist: number;
  /**
   * SHEET PULL — how far each clew is hauled OUT OF THE SAIL'S PLANE toward
   * where its sheet leads, as a fraction of the chord at full camber.
   *
   * User: "the actual pin points stop being flat in space and can actually be
   * ANGLED… an extension to the piece of rope or block that it's attached to,
   * instead of just being always perfectly flat against the mast." The head is
   * laced to its yard and genuinely is a straight line; the CLEWS are hauled
   * by sheets to points that are nowhere near the sail's plane, so the foot
   * comes out of that plane and the lower half of the sail twists with it.
   * 0 puts the corners back in the yard's plane, which is the rectangle.
   */
  sailSheetPull: number;
  /** how far the two sheets spread outboard as they lead aft. It is the
   *  DIFFERENCE between the two leads that rotates the foot's chord line
   *  against the head's — i.e. this is where geometric twist comes from */
  sailSheetSpread: number;
  /** extra flutter RATE at full luff, as a multiple of the base. Legal only
   *  because the phase is now integrated by a single owner (§V.55) */
  sailFlutterLuffRate: number;
  sailDraftPos: number; // deepest point of the section, fraction aft of the luff
  sailDraftFullness: number; // section exponent: 1 = membrane parabola, >1 narrows it
  sailFurlSwag: number; // foot gather depth as a fraction of drop, at full furl
  sailFurlBays: number; // gathering bays across the foot (buntline stations)
  /** APPARENT wind (m/s) at which the cloth is ~63% loaded. Was 16 and authored
   *  against the TRUE wind; the apparent-wind work then fed it a quantity that
   *  runs 1-21 m/s in ordinary sailing, so the useful part of the curve sat
   *  outside the game. Halved, and the curve saturates rather than clamping */
  sailWindRef: number;
  /**
   * Shape of the load curve, as an exponent on the saturating pressure. Below
   * 1 = EARLY ONSET: most of the camber arrives in the first few knots and the
   * rest of the range is plateau, which is what makes a sail read as drawing
   * long before it is perfectly trimmed. It still passes through zero, so a
   * becalmed sail hangs slack — an additive floor would not.
   *
   * It is also what keeps a ship running dead downwind at near wind speed
   * showing a rounded sail: her apparent wind really is ~1 m/s there, and a
   * linear map rendered that as a flat sheet.
   */
  sailLoadCurve: number;
  sailBackBillow: number; // max belly INVERSION when the wind heads the sail
  sailLuffFlap: number; // extra ripple amplitude when the sail is not drawing
  sailGustAmp: number; // gust modulation depth 0..1
  sailGustFreq: number; // gust rate (rad/s)
  sailTurnSkew: number; // belly sideways lag per rad/s of ship yaw rate
  sailResponse: number; // how fast the cloth chases the wind (1/s)
  sailFlutterAmp: number; // wind ripple amplitude (m) at the free foot
  sailFlutterFreq: number; // ripple speed (rad/s)
  sailRippleCount: number; // ripple wavelengths across the cloth
  /**
   * LACING POINTS: how many places the sail's head is lashed to its yard.
   *
   * ONE NUMBER, TWO THINGS. These are the robands you can see on the cross
   * beam AND the vertical seams down the cloth, because they are the same
   * physical thing seen twice — the canvas is bent to the spar AT its seams,
   * since a seam is the doubled, strong part of the cloth and that is where
   * you put a fastening.
   *
   * They used to be two independent numbers: a hard `count = 7` in
   * `sailTies()` and a seam grid derived from a bolt width in metres. The bolt
   * derivation was physically the better model — cloth is a woven good of
   * fixed width, so the count should fall out of the chord — but it put 20
   * cloths on the course against 7 robands, and the user counted the mismatch:
   * "It didn't align with the number of mounting points we do have on the
   * cross beams." Physical correctness loses to the reference here; SoT is
   * stylised and does not render 20 cloths.
   *
   * Same failure as the lantern socket and the lantern post (999071d), where
   * two literals for one joint left the lamp hanging in mid-air. §V33/§V51.
   *
   * 7 is what the yards carry today, so nothing on the beam has to move.
   * Measuring the reference gives ~9.3 seam lines on a course
   * (docs/inspo/ship/ref-rig-proportions.png, 30 px period on a 278 px
   * chord), so 9 is one Tweakpane step away if the user wants it denser.
   */
  sailLacingPoints: number;
  sailSeamDarken: number; // 0..1 multiplier on panel seams / hem edges
  /** how far a seam's sewn RIDGE tilts the shading normal. The seams in
   *  docs/inspo/ship/ref-broadside-sails-spray-foam.png read because they
   *  catch light, not because they are darker — a pure albedo line is flat */
  sailSeamRidge: number;
  /**
   * QUILTING — how deeply each cloth panel bellies BETWEEN its two seams, as a
   * fraction of the sail's own camber depth.
   *
   * User: "we don't get the blowing up in between these so that we actually
   * see the sail bulge and these little seams just limiting it a little bit."
   * A seam is doubled, stitched, stiffer canvas, so it holds while the cloth
   * either side of it blows out — the sail reads as quilted, not smooth.
   *
   * THIS LIVES IN THE SHAPE, NOT THE SHADING, and that is the whole point. A
   * line painted on a smooth interior does not change how the surface reads;
   * the geometry has to move. Zero-mean about the smooth belly, so it
   * redistributes camber rather than adding any: the seams pull IN by as much
   * as the panels push OUT.
   */
  sailSeamQuilt: number;
  sailAmbientLift: number; // emissive floor so cloth never reads dead black
  sailBacklitFocus: number; // transmission lobe tightness (looking sunward)
  sailLeeDarken: number; // 0..1 tint multiplier on the shaded (lee) face
  sailStainStrength: number; // weathering mottle darkening 0..1
  holeColor: number;
  // --- surface relief (§V22 "they look like solid covered materials all
  // over"). One procedural height field drives the shading normal, so all of
  // these are in METRES of apparent relief; bumpScale is the master dial.
  bumpScale: number;
  grainRelief: number; // grain ridges
  plankRelief: number; // per-board proud/shy offset — reads as planking
  /**
   * PER-BOARD PLATEAU STEP (m): how far a board's whole face sits proud of or
   * shy of its neighbour's, measured AT THE SEAM THEY SHARE. ± this value.
   *
   * The one number §B.48 was missing. `plankRelief` above is a CROWN —
   * `sin(πf)`, which is zero at both seams — so it lifts the middle of a board
   * and leaves its edges at exactly its neighbour's height. Every per-board
   * term in the material was built that way, deliberately, because a crown
   * carries no step and is therefore trivially band-limit-safe (§B.20). The
   * cost was that the deck was PERFECTLY FLUSH by construction and read as
   * "flat surfaces with painted-on wood lines", twice.
   *
   * A board reads as a solid object because its top face is at a different
   * height from the next board's and there is an edge between them. That is a
   * step, and §V.70 is how a step is band-limited without becoming a spike.
   */
  plankStep: number;
  /**
   * Chamfer the plateau step transitions over, as a fraction of a board's
   * width. Knocking the arris off a board is also §T.34's "chamfered edges
   * (90° arrises ⊥)" — a true 90° edge is infinitely sharp and reads as one
   * aliased line, and it is the authored width the step's band limit is
   * measured against (§V.70), so it must be a real dimension, not a fudge.
   */
  plankChamfer: number;
  /**
   * Per-board TILT (m): one edge of a board sits prouder than the other,
   * because nothing was ever bedded perfectly flat. Antisymmetric across the
   * board and zero at both seams, so it is a tilt and not a step.
   */
  plankTilt: number;
  /**
   * How far a seam line WANDERS along its board, as a fraction of a board's
   * width. A sawn-and-dubbed edge is not straight, and a hull's worth of
   * exactly parallel straight lines is the uniformity tell the user has now
   * reported on four systems. Displaces the board coordinate, so the caulk
   * line, the per-board tone, the butt stagger and the wale all follow it.
   */
  plankWander: number;
  /** metres of board along which one wander cycle plays out */
  plankWanderLength: number;
  seamDepth: number; // caulked groove between boards
  waleRelief: number; // wale strakes stand proud of the planking
  plankToneVar: number; // per-board colour variation, ± fraction
  bleachColor: number; // sun-bleached horizontal surfaces
  bleachStrength: number;
  wetDarken: number; // below the waterline: darker…
  wetSmooth: number; // …and smoother (roughness multiplier reduction)
  wetlineFade: number; // metres over which the boot-top fades in
  roughBase: number; // dry timber base roughness
  /**
   * How strongly the deck heightfield's per-board offsets show as relief and
   * as a tone shift. Both were far too strong (2.4 / 9) and were reading an
   * UNMIPPED texture, which is what produced the deck speckle — see §V.48 in
   * deckFieldTexture.ts. The procedural plank terms in woodMaterial already
   * carry most of the board-to-board variation; the field's job is the
   * low-frequency structure those cannot know (wear hollows, the hog of the
   * hull), so it only needs to whisper.
   */
  deckFieldRelief: number;
  deckFieldTone: number;
  /**
   * How much INDIRECT light a fully-occluded seam loses, 0..1 (§B.48b).
   *
   * The other half of "it doesn't look 3-dimensional", and the half no normal
   * can supply. There is no environment map in this project and the only
   * ambient is a HemisphereLight, whose irradiance on an up-facing surface is
   * a function of N.y ALONE — a 2° normal tilt moves N.y by 0.0006. So the
   * ambient term is CONSTANT across the whole deck: ~24% of a sunlit deck's
   * light and 100% of a SHADOWED one's, and a galleon's deck is mostly under
   * sail shadow. Relief buys nothing there; occlusion is the only thing that
   * can, and in the reference the darkness BETWEEN the boards is doing most of
   * the 3D work.
   *
   * Feeds `material.aoNode`, which three multiplies into indirect diffuse
   * only, so direct sun still rakes across the boards untouched. NOT the post
   * AO pass — that pipeline has never run.
   */
  aoStrength: number;
}

export const shipMaterialParams: ShipMaterialParams = registerParams(
  'ship-material',
  {
    grainScale: 1.6, grainStretch: 0.22, grainOctaves: 3, triplanarSharpness: 8,
    plankWidth: 0.55, hullStrakes: 12, seamWidth: 0.08, seamDarken: 0.55,
    plankLength: 4.6, buttWidth: 0.05,
    // 12 strakes ≈ the galleon's 6.6 m midship girth at 0.55 m a board, so
    // amidships the shell planking matches the deck's; ~7 of them are above
    // the waterline, which is what the SoT topsides read as.
    // A wale every FOURTH strake (was 0.9 per METRE of hull height = a proud
    // dark belt every other board, which buried the planking it is supposed
    // to punctuate — the "no plank detail on the sides" report was largely
    // this). 12/4 puts wales on the garboard, the bilge, the main wale just
    // above the waterline and the sheer strake.
    // waleRatio × the 4-plank repeat = exactly ONE board wide.
    waleFrequency: 0.25, waleRatio: 0.25, waleDarken: 0.62,
    hullLight: 0x9a6b3f, hullDark: 0x63401f,
    deckLight: 0xc9a96e, deckDark: 0x9a7a4a,
    sparLight: 0x8a6a42, sparDark: 0x5f452a,
    trimLight: 0x54381f, trimDark: 0x362412,
    ironLight: 0x4a4640, ironDark: 0x24211d,
    glassColor: 0x3c4a44, glassLit: 0x2a1c0c,
    sailLight: 0xe6dcc2, sailDark: 0xa8977a,
    sailWeaveScale: 18, sailBacklitColor: 0xfff0d2, sailBacklitStrength: 0.5,
    // 0.115 per unit drive against a 0.15 ceiling puts the main course at
    // 3.1% of chord in a calm, 8.5% at the default sea, 13.9% in a storm and
    // 15.0% (capped) in a gale — a readable 5x range topping out inside a
    // real sail's 10-15%. Was 0.68 OF THE DROP, i.e. 24.8% / 40.7% of chord.
    sailCamber: 0.15, sailCamberMax: 0.15, sailLoadCurve: 0.45,
    sailLeechOpen: 0.3, sailFootRoach: 0.035, sailTwist: 0.12,
    sailSheetPull: 0.16, sailSheetSpread: 0.45,
    sailFlutterLuffRate: 1.8,
    sailDraftPos: 0.4, sailDraftFullness: 1,
    sailFurlSwag: 0.16, sailFurlBays: 3,
    sailWindRef: 8, sailBackBillow: 0.18, sailLuffFlap: 2.6,
    sailGustAmp: 0.3, sailGustFreq: 0.55, sailTurnSkew: 1.6, sailResponse: 2.2,
    sailFlutterAmp: 0.14, sailFlutterFreq: 2.4, sailRippleCount: 2.5,
    sailLacingPoints: 7, sailSeamDarken: 0.7, sailAmbientLift: 0.09,
    sailSeamRidge: 0.35, sailSeamQuilt: 0.3,
    sailBacklitFocus: 3, sailLeeDarken: 0.7, sailStainStrength: 0.36,
    holeColor: 0x120c07,
    bumpScale: 1, grainRelief: 0.004, plankRelief: 0.006, seamDepth: 0.012,
    // ±6 mm of plateau across a 25 mm chamfer (0.045 of a 0.55 m board) is a
    // 26° bevel at every seam. For scale: the crowned terms it sits on top of
    // max out at 2.0° (plankRelief) and 2.6° (plankTilt), and the only feature
    // on the old deck steeper than 3° was the caulk groove — a SYMMETRIC V,
    // i.e. a line, which is what "painted-on wood lines" was describing.
    plankStep: 0.006, plankChamfer: 0.045,
    // both scaled by shipDetailParams.irregularity at the uniform, so the one
    // ship-wide "hand-made" dial governs these as it does the sails/ratlines
    plankTilt: 0.004, plankWander: 0.035, plankWanderLength: 7,
    waleRelief: 0.02, plankToneVar: 0.05,
    bleachColor: 0xd8c9a8, bleachStrength: 0.22,
    wetDarken: 0, wetSmooth: 0, wetlineFade: 0.5, roughBase: 0.74,
    deckFieldRelief: 1.1, deckFieldTone: 3,
    aoStrength: 0.55,
  },
  {
    grainScale: { min: 0.1, max: 8, step: 0.05 },
    grainStretch: { min: 0.05, max: 1, step: 0.01 },
    triplanarSharpness: { min: 1, max: 24, step: 0.5 },
    plankWidth: { min: 0.2, max: 2, step: 0.01 },
    hullStrakes: { min: 4, max: 40, step: 1 },
    seamWidth: { min: 0.01, max: 0.3, step: 0.005 },
    seamDarken: { min: 0, max: 1, step: 0.01 },
    plankLength: { min: 0.5, max: 20, step: 0.1 },
    buttWidth: { min: 0.005, max: 0.2, step: 0.005 },
    waleFrequency: { min: 0.02, max: 1, step: 0.01 }, // wales per PLANK
    waleRatio: { min: 0, max: 1, step: 0.01 },
    waleDarken: { min: 0, max: 1, step: 0.01 },
    sailWeaveScale: { min: 2, max: 60, step: 0.5 },
    sailBacklitStrength: { min: 0, max: 2, step: 0.01 },
    // both in fractions of CHORD, so the slider reads as camber directly
    sailCamber: { min: 0, max: 0.4, step: 0.005 },
    sailCamberMax: { min: 0.02, max: 0.5, step: 0.005 },
    sailLeechOpen: { min: 0, max: 1, step: 0.01 },
    sailFootRoach: { min: 0, max: 0.25, step: 0.005 },
    sailTwist: { min: 0, max: 0.4, step: 0.005 },
    sailSheetPull: { min: 0, max: 0.6, step: 0.005 },
    sailSheetSpread: { min: 0, max: 1.5, step: 0.01 },
    sailFlutterLuffRate: { min: 0, max: 6, step: 0.1 },
    // bounds = the band where the draft warp stays monotone (SAIL_DRAFT_MIN/MAX)
    sailDraftPos: { min: 0.28, max: 0.72, step: 0.01 },
    sailDraftFullness: { min: 0.5, max: 2.5, step: 0.05 },
    sailFurlSwag: { min: 0, max: 0.5, step: 0.01 },
    // should track the buntline count (shipDetail.sailBuntBays) — the swags
    // are the cloth those lines gather
    sailFurlBays: { min: 1, max: 6, step: 1 },
    sailWindRef: { min: 1, max: 30, step: 0.5 },
    sailLoadCurve: { min: 0.1, max: 2, step: 0.05 },
    sailBackBillow: { min: 0, max: 0.8, step: 0.01 },
    sailLuffFlap: { min: 0, max: 6, step: 0.05 },
    sailGustAmp: { min: 0, max: 1, step: 0.01 },
    sailGustFreq: { min: 0.05, max: 3, step: 0.05 },
    sailTurnSkew: { min: 0, max: 6, step: 0.05 },
    sailResponse: { min: 0.2, max: 12, step: 0.1 },
    sailBacklitFocus: { min: 1, max: 12, step: 0.1 },
    sailLeeDarken: { min: 0.1, max: 1, step: 0.01 },
    sailFlutterAmp: { min: 0, max: 0.6, step: 0.01 },
    sailFlutterFreq: { min: 0, max: 10, step: 0.1 },
    sailRippleCount: { min: 0.5, max: 8, step: 0.1 },
    sailLacingPoints: { min: 3, max: 16, step: 1 },
    sailSeamQuilt: { min: 0, max: 1, step: 0.01 },
    sailSeamRidge: { min: 0, max: 1.5, step: 0.01 },
    sailSeamDarken: { min: 0.4, max: 1, step: 0.01 },
    sailAmbientLift: { min: 0, max: 0.6, step: 0.01 },
    sailStainStrength: { min: 0, max: 0.8, step: 0.01 },
    bumpScale: { min: 0, max: 6, step: 0.05 },
    grainRelief: { min: 0, max: 0.03, step: 0.0005 },
    plankRelief: { min: 0, max: 0.04, step: 0.0005 },
    plankStep: { min: 0, max: 0.02, step: 0.0005 },
    // floor well above 0: a chamfer narrower than a few mm is a 90° arris
    // again, and it is also the width its own band limit is measured against
    plankChamfer: { min: 0.005, max: 0.25, step: 0.005 },
    plankTilt: { min: 0, max: 0.02, step: 0.0005 },
    plankWander: { min: 0, max: 0.15, step: 0.005 },
    plankWanderLength: { min: 1, max: 30, step: 0.5 },
    seamDepth: { min: 0, max: 0.06, step: 0.001 },
    waleRelief: { min: 0, max: 0.08, step: 0.002 },
    plankToneVar: { min: 0, max: 0.3, step: 0.005 },
    bleachStrength: { min: 0, max: 1, step: 0.01 },
    wetDarken: { min: 0, max: 0.8, step: 0.01 },
    wetSmooth: { min: 0, max: 0.9, step: 0.01 },
    wetlineFade: { min: 0.05, max: 3, step: 0.05 },
    roughBase: { min: 0.1, max: 1, step: 0.01 },
    deckFieldRelief: { min: 0, max: 8, step: 0.1 },
    deckFieldTone: { min: 0, max: 30, step: 0.5 },
    aoStrength: { min: 0, max: 1, step: 0.01 },
  },
);

function shipParamsMeta(): Partial<Record<keyof ShipClassParams, ParamMeta>> {
  return {
    hullLength: { min: 10, max: 60, step: 0.5 },
    beam: { min: 3, max: 16, step: 0.1 },
    freeboard: { min: 0.5, max: 6, step: 0.1 },
    draft: { min: 0.5, max: 5, step: 0.1 },
    mainMastHeight: { min: 5, max: 45, step: 0.5 },
    foreMastHeight: { min: 0, max: 40, step: 0.5 },
    rearMastHeight: { min: 0, max: 40, step: 0.5 },
    bowspritLength: { min: 0, max: 15, step: 0.25 },
    bowspritPitch: { min: 0, max: 0.8, step: 0.01 },
    railHeight: { min: 0.2, max: 2, step: 0.05 },
    yardMastClearance: { min: 0, max: 1, step: 0.01 },
    sailYardOffset: { min: 0, max: 1.5, step: 0.01 },
    transomCrown: { min: 0, max: 1.5, step: 0.01 },
    channelPlates: { min: 1, max: 5, step: 1 },
    channelPlateSpacing: { min: 0.3, max: 2, step: 0.05 },
    cannonsPerSide: { min: 0, max: 8, step: 1 },
  };
}
