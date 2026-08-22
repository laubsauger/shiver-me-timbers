/**
 * RAFT 2100 — material tunables for the Kon-Tiki raft (§T90, §V16). Colours
 * follow docs/raft2100/kon-tiki-reference.md §7 (museum state: grey-brown
 * balsa, greying-tan weave, pale straw thatch, ochre canvas, rust-red face).
 * Every feature width here is the width its §V.48 band limit is measured
 * against, so a value is BOTH the look and the filter (§V66).
 *
 * Hex colours are sRGB and go through `THREE.Color.set` (§V31).
 */
import { registerParams, type ParamMeta } from './registry';

export interface RaftMaterialParams {
  // --- balsa (logs, crossbeams, stern block, oar shaft, bipod legs)
  balsaGrey: number; // museum "round grey logs" [§7 Balsa]
  balsaWarm: number; // drier, warmer tone some logs keep
  balsaToneVar: number; // 0..1 — how far a piece's seeded tone swings grey→warm
  balsaGrainScale: number; // noise cells per metre ACROSS the grain
  balsaGrainStretch: number; // ×longer along the axis (long shallow streaks)
  balsaGrainRelief: number; // m — height of the grain ridges
  balsaEndZone: number; // m — end-grain checks reach this far in from either end
  balsaCheckCount: number; // radial checks round a log end
  balsaCheckWidth: number; // m — one check's opening, the band-limit feature width
  balsaCheckDepth: number; // m — relief recess of an open check
  balsaCheckDarken: number; // 0..1 albedo multiplier inside a check
  grooveWidth: number; // m — rope-lashing groove at a crossbeam station
  grooveDepth: number; // m
  grooveDarken: number; // 0..1
  weedColor: number; // green weed along the waterline [§7 Balsa]
  weedHalfBand: number; // m — band is ±this about the log axis (y = 0)
  weedBowFade: number; // m — the band thins out over this length toward the bow
  weedStrength: number; // 0..1
  wetDarken: number; // 0..1 below the waterline
  balsaRough: number;
  balsaBump: number; // relief gain
  // --- bamboo (lookout platform slats, default mats' bamboo edge)
  bambooYellow: number; // golden-yellow [§7 Bamboo]
  bambooGreen: number; // green-grey streaks
  bambooNodePitch: number; // m — node rings along a cane
  bambooNodeWidth: number; // m — a node's swollen ring, the band-limit width
  bambooSlatWidth: number; // m — split-bamboo slat across the platform
  // --- weave (cabin walls, deck mats)
  weaveTan: number; // greying tan [§7 Bamboo: "cabin weave ... → greying tan"]
  weaveDark: number; // shadowed under-strip / gap
  weaveStrip: number; // m — a strip of split bamboo, 4–5 cm
  weaveBlock: number; // strands per plaited check. 1 = the plain over-under plait [§3 Walls]; >1 widens the check, which §T129c found reading as crates at 5
  weaveEdge: number; // fraction of a strip — the strip edge, the band-limit width
  weaveRelief: number; // m — over/under crown height
  weaveToneVar: number; // per-strip tone jitter
  weaveRough: number;
  weaveBump: number;
  // --- thatch (roof)
  thatchLight: number; // pale straw [§7 Thatch: "museum pale straw palm"]
  thatchDark: number; // dry brown
  thatchUnder: number; // 0..1 — underside multiplier (the overhang's ragged shade)
  thatchRowPitch: number; // m — one course of leaves overlapping the next, down the slope
  thatchRowEdge: number; // m — the shadow line under a course, the band-limit width
  thatchRowRagged: number; // m — how far a course edge wanders
  thatchStrandScale: number; // strands per metre ACROSS the slope
  thatchStrandStretch: number; // ×longer down the slope
  thatchTileWidth: number; // m — ONE leaf across the slope; the course line breaks at every tile [§3 Roof "like tiles"]
  thatchTileStagger: number; // m — how far a tile's own course line sits above or below its neighbour's
  thatchRelief: number; // m
  thatchBump: number;
  // --- straw mattress ticking (the berths), drawn by the weave family
  tickLight: number; // bleached stripe [§3 Museum "striped mattress"]
  tickDark: number; // the dyed stripe beside it
  tickStrip: number; // m — one woven strip of ticking (coarser than the wall's 4–5 cm split bamboo)
  tickBlock: number; // strips per stripe
  // --- plank (guaras, splashboards): the wood material in a dark preset
  plankLight: number; // dark weathered plank [§7 Guaras]
  plankDark: number;
  plankWidth: number; // m — §V66: a 0.6 m guara is not planked in 0.55 m boards
  plankReliefScale: number; // 0..1 — the galleon's board relief, scaled: a plank edge-on to the sun flips its normal in and out of the light
  // --- rope (lashings): three-strand hemp, tan → grey-brown [§7 Rope]
  ropeTan: number;
  ropeDark: number; // the shadowed lay between strands
  // --- crates (2100 dressing), one material, variant per piece id
  cratePine: number;
  crateKhaki: number; // ration-box cardboard [§7 Boxes]
  crateBoardWidth: number; // m — pine crate boards
  jerrycanColor: number; // 2100 stand-in, dull plastic
  drumColor: number; // dull blue plastic rain drum
  dinghyColor: number; // faded yellow rubber [§7 Boxes]
  dinghyPatch: number; // 0..1 patch darkening
  cageColor: number; // thin iron — the parrot cage, and the pots and ladle by the door [§6]
  crateCard: number; // salvaged cardboard: the radio corner's partition and the chart on the wall [§3 Radio corner]
  // --- the radio (§B87): a salvaged car-radio face in a jury-rigged case
  radioCase: number; // dark instrument grey-green
  radioFace: number; // the pale face plate, dial disc and meter glass
  radioTrim: number; // the dark furniture standing proud of the plate: knob, needles, rim
  radioLed: number; // the one LED
  radioLedGain: number; // emissive multiplier — it must read as LIT in a cabin at noon
  radioFacePlane: number; // 0..1 of the case's depth: everything in front of this is the pale plate
  radioTrimPlane: number; // 0..1: …and in front of THIS is dark furniture. One contract with buildRadioGeometry.
  // --- canvas + Kon-Tiki face
  sailTint: number; // RGB multiplier to take the stock linen to ochre [§7 Sail]
  faceFill: number; // rust red
  faceOutline: number; // dark outline
  faceCentreV: number; // face centre up the sail, 0 = foot, 1 = head
  faceHalfWidth: number; // m — half the rectangular-oval face
  faceHalfHeight: number; // m — ~1.8 m tall [§4 Decoration]
  faceCorner: number; // m — corner radius of the oval
  faceStroke: number; // m — half-width of an outline stroke
  faceRayInner: number; // m — rays start on this circle about the face centre
  faceRayOuter: number; // m — and end on this one
  faceEdge: number; // m — paint edge softness, the band-limit width
  faceWear: number; // 0..1 — how much of the fill the weather has taken
  faceSailMaxWidth: number; // m — the face goes on `sail-main-lower` only when the sail is this narrow (the galleon's course is 3× wider)
}

const m = (min: number, max: number, step = 0.01): ParamMeta => ({ min, max, step });
const colour: ParamMeta = {};

export const raftMaterialParams: RaftMaterialParams = registerParams(
  'raft-materials',
  {
    balsaGrey: 0x7c7567,
    balsaWarm: 0xb0906c, // the warm end of the per-log spread — at 0xc6a87a the logs rendered cream at noon [PHOTO-08 reads grey-brown]
    balsaToneVar: 0.5,
    balsaGrainScale: 9,
    balsaGrainStretch: 6,
    balsaGrainRelief: 0.004,
    balsaEndZone: 0.4,
    balsaCheckCount: 9,
    balsaCheckWidth: 0.012,
    balsaCheckDepth: 0.02,
    balsaCheckDarken: 0.45,
    grooveWidth: 0.04,
    grooveDepth: 0.012,
    grooveDarken: 0.55,
    weedColor: 0x4f6b3a,
    weedHalfBand: 0.15,
    weedBowFade: 2.5,
    weedStrength: 0.8,
    wetDarken: 0.35,
    balsaRough: 0.86,
    balsaBump: 8,
    bambooYellow: 0xd9b55e,
    bambooGreen: 0x9a9a6a,
    bambooNodePitch: 0.35,
    bambooNodeWidth: 0.02,
    bambooSlatWidth: 0.05,
    weaveTan: 0xb9a57a,
    weaveDark: 0x6e6048,
    weaveStrip: 0.045,
    weaveBlock: 1, // §T129c — [§3 Walls] 4–5 cm strips; at 5 the wall repeated every 22.5 cm and read as stacked crates
    weaveEdge: 0.12,
    weaveRelief: 0.004,
    weaveToneVar: 0.08,
    weaveRough: 0.82,
    weaveBump: 2.5, // a vertical wall at noon lives at N·L ≈ 0: at 6 the crowns of one block caught the sun and the next block's did not, a black-and-tan checkerboard from 15 m (§B70)
    thatchLight: 0xc9b07a,
    thatchDark: 0x8c7a50,
    thatchUnder: 0.55,
    // §B87: the GEOMETRY now carries the courses (raftParams.roofCoursePitch,
    // 0.30 m), so the material's row is the LEAF inside a course — banana
    // leaves laid "like tiles" [§3 Roof], several to a course
    thatchRowPitch: 0.12,
    thatchRowEdge: 0.03,
    thatchRowRagged: 0.04,
    thatchStrandScale: 40,
    thatchStrandStretch: 12,
    thatchTileWidth: 0.16,
    thatchTileStagger: 0.05,
    thatchRelief: 0.006,
    thatchBump: 6,
    tickLight: 0xcfc5ad,
    tickDark: 0x8f7a63,
    tickStrip: 0.09,
    tickBlock: 3,
    // weathered grey-brown, but MID-tone: a guara stands edge-on to the noon
    // sun and lives on hemisphere light alone, and at 0x6e685d it rendered as
    // a black slab (§B70). [PHOTO-04] reads the planks as mid grey-brown.
    plankLight: 0x948b7c,
    plankDark: 0x6f675b,
    plankWidth: 0.25,
    plankReliefScale: 0.08,
    ropeTan: 0xa8916a,
    ropeDark: 0x5f5040,
    cratePine: 0xb8945c,
    crateKhaki: 0x8f8a62,
    crateBoardWidth: 0.12,
    jerrycanColor: 0x6f7a5a,
    drumColor: 0x3a5f8a,
    dinghyColor: 0xd9c15a,
    dinghyPatch: 0.3,
    cageColor: 0x4a4844,
    crateCard: 0xa89877,
    radioCase: 0x4a5148,
    radioFace: 0xc9c0a6,
    radioTrim: 0x24262a,
    radioLed: 0xff3a20,
    radioLedGain: 1.6,
    radioFacePlane: 0.62,
    radioTrimPlane: 0.915,
    sailTint: 0xe3cfa3,
    faceFill: 0xb2472a,
    faceOutline: 0x3a2a22,
    faceCentreV: 0.52,
    faceHalfWidth: 0.6,
    faceHalfHeight: 0.9,
    faceCorner: 0.4,
    faceStroke: 0.028,
    faceRayInner: 1.05,
    faceRayOuter: 1.4,
    faceEdge: 0.02,
    faceWear: 0.3,
    faceSailMaxWidth: 8,
  },
  {
    balsaGrey: colour, balsaWarm: colour, weedColor: colour,
    balsaToneVar: m(0, 1), balsaGrainScale: m(1, 30, 0.5), balsaGrainStretch: m(1, 20, 0.5),
    balsaGrainRelief: m(0, 0.02, 0.001), balsaEndZone: m(0, 1.5), balsaCheckCount: m(3, 16, 1),
    balsaCheckWidth: m(0.002, 0.05, 0.001), balsaCheckDepth: m(0, 0.05, 0.001), balsaCheckDarken: m(0, 1),
    grooveWidth: m(0.01, 0.1, 0.005), grooveDepth: m(0, 0.05, 0.001), grooveDarken: m(0, 1),
    weedHalfBand: m(0, 0.4), weedBowFade: m(0.1, 6, 0.1), weedStrength: m(0, 1), wetDarken: m(0, 1),
    balsaRough: m(0.3, 1), balsaBump: m(0, 30, 0.5),
    bambooYellow: colour, bambooGreen: colour,
    bambooNodePitch: m(0.1, 0.8), bambooNodeWidth: m(0.005, 0.06, 0.001), bambooSlatWidth: m(0.02, 0.15, 0.005),
    weaveTan: colour, weaveDark: colour,
    weaveStrip: m(0.02, 0.1, 0.001), weaveBlock: m(1, 10, 1), weaveEdge: m(0.02, 0.4), weaveRelief: m(0, 0.02, 0.001),
    weaveToneVar: m(0, 0.3), weaveRough: m(0.3, 1), weaveBump: m(0, 30, 0.5),
    thatchLight: colour, thatchDark: colour, thatchUnder: m(0, 1),
    thatchRowPitch: m(0.1, 0.8), thatchRowEdge: m(0.005, 0.1, 0.001), thatchRowRagged: m(0, 0.15),
    thatchStrandScale: m(5, 100, 1), thatchStrandStretch: m(1, 40, 0.5), thatchRelief: m(0, 0.02, 0.001),
    thatchBump: m(0, 30, 0.5),
    thatchTileWidth: m(0.04, 0.6), thatchTileStagger: m(0, 0.2),
    tickLight: colour, tickDark: colour, tickStrip: m(0.02, 0.3, 0.005), tickBlock: m(1, 10, 1),
    plankLight: colour, plankDark: colour, plankWidth: m(0.05, 0.6), plankReliefScale: m(0, 1, 0.05),
    ropeTan: colour, ropeDark: colour,
    cratePine: colour, crateKhaki: colour, crateBoardWidth: m(0.04, 0.3), jerrycanColor: colour,
    drumColor: colour, dinghyColor: colour, dinghyPatch: m(0, 1), cageColor: colour, crateCard: colour,
    radioCase: colour, radioFace: colour, radioTrim: colour, radioLed: colour,
    radioLedGain: m(0, 6, 0.05), radioFacePlane: m(0, 1), radioTrimPlane: m(0, 1),
    sailTint: colour, faceFill: colour, faceOutline: colour,
    faceCentreV: m(0.2, 0.8), faceHalfWidth: m(0.3, 1.2), faceHalfHeight: m(0.4, 1.5),
    faceCorner: m(0, 0.6), faceStroke: m(0.005, 0.08, 0.001), faceRayInner: m(0.6, 2), faceRayOuter: m(0.8, 2.5),
    faceEdge: m(0.002, 0.1, 0.001), faceWear: m(0, 1), faceSailMaxWidth: m(4, 20, 0.5),
  },
);
