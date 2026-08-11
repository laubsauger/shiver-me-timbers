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
    sailDropLowerFactor: 0.22, sailDropUpperFactor: 0.16,
    bowspritLength: 7, bowspritRadius: 0.18, bowspritPitch: 0.28,
    railHeight: 0.9, railThickness: 0.12, railInset: 0.2, railLengthFactor: 0.85,
    rudderHeight: 2.2, rudderChord: 1.2, rudderThickness: 0.15,
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
    sailDropLowerFactor: 0.2, sailDropUpperFactor: 0.15,
    bowspritLength: 9, bowspritRadius: 0.22, bowspritPitch: 0.35, // ~20°
    railHeight: 1.0, railThickness: 0.13, railInset: 0.22, railLengthFactor: 0.8,
    rudderHeight: 2.6, rudderChord: 1.4, rudderThickness: 0.18,
    sheerBow: 1.1, sheerStern: 0.7, tumblehome: 0.12, keelPinch: 0.1,
    cannonMountHeight: 0, cannonInset: 1.0, cannonSpacing: 4, cannonsPerSide: 4,
  },
  shipParamsMeta(),
);

/** Wood/sail material tunables (§V16) — live TSL uniforms unless noted. */
export interface ShipMaterialParams {
  grainScale: number; // fbm sample frequency (1/m)
  grainStretch: number; // <1 elongates grain along the plank axis (z)
  grainOctaves: number; // build-time: changing rebuilds node graph
  triplanarSharpness: number;
  plankWidth: number; // m between plank seams
  seamWidth: number; // seam falloff as fraction of a plank
  seamDarken: number; // 0..1 multiplier at the seam line
  waleFrequency: number; // horizontal wale strakes per metre of hull height
  waleRatio: number; // 0..1 band coverage
  waleDarken: number; // 0..1 multiplier inside a wale band
  hullLight: number; // warm mid-tone hull (docs/ship-full-view.png)
  hullDark: number;
  deckLight: number; // pale scrubbed deck planks
  deckDark: number;
  sparLight: number;
  sparDark: number;
  trimLight: number; // rails/rudder/keel — darkest wood
  trimDark: number;
  sailLight: number;
  sailDark: number;
  sailWeaveScale: number; // warp/weft noise frequency
  sailBacklitColor: number;
  sailBacklitStrength: number;
  sailBillow: number; // full-trim belly depth, fraction of sail drop
  sailFlutterAmp: number; // wind ripple amplitude (m) at the free foot
  sailFlutterFreq: number; // ripple speed (rad/s)
  sailRippleCount: number; // ripple wavelengths across the cloth
  holeColor: number;
}

export const shipMaterialParams: ShipMaterialParams = registerParams(
  'ship-material',
  {
    grainScale: 1.6, grainStretch: 0.22, grainOctaves: 3, triplanarSharpness: 8,
    plankWidth: 0.55, seamWidth: 0.08, seamDarken: 0.55,
    waleFrequency: 0.9, waleRatio: 0.28, waleDarken: 0.62,
    hullLight: 0x9a6b3f, hullDark: 0x63401f,
    deckLight: 0xc9a96e, deckDark: 0x9a7a4a,
    sparLight: 0x8a6a42, sparDark: 0x5f452a,
    trimLight: 0x54381f, trimDark: 0x362412,
    sailLight: 0xe9e1cd, sailDark: 0xd2c5aa,
    sailWeaveScale: 18, sailBacklitColor: 0xfff0d2, sailBacklitStrength: 0.35,
    sailBillow: 0.34, sailFlutterAmp: 0.16, sailFlutterFreq: 2.4, sailRippleCount: 2.5,
    holeColor: 0x120c07,
  },
  {
    grainScale: { min: 0.1, max: 8, step: 0.05 },
    grainStretch: { min: 0.05, max: 1, step: 0.01 },
    triplanarSharpness: { min: 1, max: 24, step: 0.5 },
    plankWidth: { min: 0.2, max: 2, step: 0.01 },
    seamWidth: { min: 0.01, max: 0.3, step: 0.005 },
    seamDarken: { min: 0, max: 1, step: 0.01 },
    waleFrequency: { min: 0.1, max: 3, step: 0.05 },
    waleRatio: { min: 0, max: 1, step: 0.01 },
    waleDarken: { min: 0, max: 1, step: 0.01 },
    sailWeaveScale: { min: 2, max: 60, step: 0.5 },
    sailBacklitStrength: { min: 0, max: 2, step: 0.01 },
    sailBillow: { min: 0, max: 0.8, step: 0.01 },
    sailFlutterAmp: { min: 0, max: 0.6, step: 0.01 },
    sailFlutterFreq: { min: 0, max: 10, step: 0.1 },
    sailRippleCount: { min: 0.5, max: 8, step: 0.1 },
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
    cannonsPerSide: { min: 0, max: 8, step: 1 },
  };
}
