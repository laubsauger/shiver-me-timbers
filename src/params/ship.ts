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
  sailDropLowerFactor: number; // sail drop as fraction of mast height
  sailDropUpperFactor: number;
  bowspritLength: number;
  bowspritRadius: number;
  bowspritPitch: number; // radians above horizontal
  railHeight: number;
  railThickness: number;
  railInset: number; // rail offset inboard from hull side
  railLengthFactor: number; // fraction of hull length
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
    sailDropLowerFactor: 0.22, sailDropUpperFactor: 0.16,
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
    sailDropLowerFactor: 0.2, sailDropUpperFactor: 0.15,
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
  /** gathering bays along a furled yard — the cloth swags between gaskets */
  sailBuntBays: number;
  /** how far a bunt hangs below the yard, as a fraction of its own thickness */
  sailBuntSag: number;
  /** how much fatter a bay's centre is than its gaskets */
  sailBuntSwell: number;
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
    pinCount: 7,
    pennantFly: 4.2, pennantHoist: 0.55,
    flagFly: 2.2, flagHoist: 1.35,
    ensignStaff: 2.4,
    anchorSize: 2.1,
    mouldingSize: 0.14,
    sailBuntBays: 3, sailBuntSag: 1.15, sailBuntSwell: 2.1,
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
    pinCount: { min: 0, max: 14, step: 1 },
    pennantFly: { min: 0.5, max: 10, step: 0.1 },
    pennantHoist: { min: 0.1, max: 2, step: 0.05 },
    flagFly: { min: 0.5, max: 6, step: 0.1 },
    flagHoist: { min: 0.3, max: 4, step: 0.05 },
    ensignStaff: { min: 0.5, max: 6, step: 0.1 },
    anchorSize: { min: 0.5, max: 5, step: 0.1 },
    mouldingSize: { min: 0.03, max: 0.5, step: 0.01 },
    sailBuntBays: { min: 1, max: 6, step: 1 },
    sailBuntSag: { min: 0, max: 3, step: 0.05 },
    sailBuntSwell: { min: 1, max: 4, step: 0.05 },
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
  sailBillow: number; // full belly depth, fraction of sail drop, at windRef
  sailDraftPos: number; // deepest point of the section, fraction aft of the luff
  sailDraftFullness: number; // section exponent: 1 = membrane parabola, >1 narrows it
  sailFurlSwag: number; // foot gather depth as a fraction of drop, at full furl
  sailFurlBays: number; // gathering bays across the foot (buntline stations)
  sailWindRef: number; // m/s of following wind that fills the sail completely
  sailBackBillow: number; // max belly INVERSION when the wind heads the sail
  sailLuffFlap: number; // extra ripple amplitude when the sail is not drawing
  sailGustAmp: number; // gust modulation depth 0..1
  sailGustFreq: number; // gust rate (rad/s)
  sailTurnSkew: number; // belly sideways lag per rad/s of ship yaw rate
  sailResponse: number; // how fast the cloth chases the wind (1/s)
  sailFlutterAmp: number; // wind ripple amplitude (m) at the free foot
  sailFlutterFreq: number; // ripple speed (rad/s)
  sailRippleCount: number; // ripple wavelengths across the cloth
  sailPanelCount: number; // vertical cloth panels (seam stripes)
  sailSeamDarken: number; // 0..1 multiplier on panel seams / hem edges
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
    sailBillow: 0.68, sailDraftPos: 0.4, sailDraftFullness: 1,
    sailFurlSwag: 0.16, sailFurlBays: 3,
    sailWindRef: 16, sailBackBillow: 0.18, sailLuffFlap: 2.6,
    sailGustAmp: 0.3, sailGustFreq: 0.55, sailTurnSkew: 1.6, sailResponse: 2.2,
    sailFlutterAmp: 0.14, sailFlutterFreq: 2.4, sailRippleCount: 2.5,
    sailPanelCount: 7, sailSeamDarken: 0.7, sailAmbientLift: 0.09,
    sailBacklitFocus: 3, sailLeeDarken: 0.7, sailStainStrength: 0.36,
    holeColor: 0x120c07,
    bumpScale: 1, grainRelief: 0.004, plankRelief: 0.006, seamDepth: 0.012,
    waleRelief: 0.02, plankToneVar: 0.05,
    bleachColor: 0xd8c9a8, bleachStrength: 0.22,
    wetDarken: 0, wetSmooth: 0, wetlineFade: 0.5, roughBase: 0.74,
    deckFieldRelief: 1.1, deckFieldTone: 3,
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
    sailBillow: { min: 0, max: 0.8, step: 0.01 },
    // bounds = the band where the draft warp stays monotone (SAIL_DRAFT_MIN/MAX)
    sailDraftPos: { min: 0.28, max: 0.72, step: 0.01 },
    sailDraftFullness: { min: 0.5, max: 2.5, step: 0.05 },
    sailFurlSwag: { min: 0, max: 0.5, step: 0.01 },
    // should track the buntline count (shipDetail.sailBuntBays) — the swags
    // are the cloth those lines gather
    sailFurlBays: { min: 1, max: 6, step: 1 },
    sailWindRef: { min: 1, max: 30, step: 0.5 },
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
    sailPanelCount: { min: 2, max: 16, step: 1 },
    sailSeamDarken: { min: 0.4, max: 1, step: 0.01 },
    sailAmbientLift: { min: 0, max: 0.6, step: 0.01 },
    sailStainStrength: { min: 0, max: 0.8, step: 0.01 },
    bumpScale: { min: 0, max: 6, step: 0.05 },
    grainRelief: { min: 0, max: 0.03, step: 0.0005 },
    plankRelief: { min: 0, max: 0.04, step: 0.0005 },
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
