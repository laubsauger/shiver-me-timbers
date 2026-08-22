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
  balsaShadow: number; // §T147 — the dark weathered end of the grain and the stain patches
  balsaToneVar: number; // 0..1 — how far a piece's seeded tone swings grey→warm
  balsaGrainScale: number; // noise cells per metre ACROSS the grain
  balsaGrainStretch: number; // ×longer along the axis (long shallow streaks)
  balsaGrainContrast: number; // 0..1 — §T147: how far the grain's dark end reaches toward `balsaShadow`
  balsaBlotchScale: number; // cells per metre ACROSS a weathering patch (metre-scale, survives minification)
  balsaBlotchStrength: number; // 0..1 — how dark a stain patch goes
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
  wetDarken: number; // 0..1 at and below the waterline
  wetRise: number; // m ABOVE the waterline the constantly-splashed dark band reaches
  balsaCrevice: number; // 0..1 — §T147: ambient occlusion on a log flank that faces its neighbour across a chink
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
    balsaGrey: 0x6f6a5c, // §T147 — a stop darker: [ref kon-tiki-1947-sailing] the logs at sea are a mid grey-brown, and R3 rendered them cream
    balsaWarm: 0xa88a63, // the warm end of the per-log spread — at 0xc6a87a the logs rendered cream at noon [PHOTO-08 reads grey-brown]
    // §T147 — the DARK end the grain and the stains reach toward. woodMaterial
    // has had this the whole time (`mix(hullDark, hullLight, grain)`, a 2:1
    // ratio WITH a hue swing); the balsa multiplied brightness by 0.86..1.1,
    // which on a 3-octave fbm that lives in 0.3..0.7 is a ±5% achromatic
    // ripple. That is the "way too even … looks like plastic" the user filmed.
    balsaShadow: 0x3f382e,
    balsaToneVar: 0.62,
    balsaGrainScale: 9,
    balsaGrainStretch: 6,
    balsaGrainContrast: 0.5,
    // §T147 — stain patches at the scale the VIEWER stands at. It rides the
    // same `balsaGrainStretch`, so 1.7 cells per metre across the girth is
    // 0.59 m round the log × 3.5 m along it: three or four patches round a
    // 0.55 m log and four along a 13.7 m one. THE POINT IS THE SCALE — the
    // grain's finest octave is 2.8 cm and averages to one flat tone the moment
    // the raft is a few metres off (which is where the user was standing),
    // while a 3.5 m patch is still several pixels at 100 m. Seeded per piece,
    // so two logs never wear the same way [§7 "no two logs alike"].
    balsaBlotchScale: 1.7,
    balsaBlotchStrength: 0.42,
    balsaGrainRelief: 0.004,
    balsaEndZone: 0.4,
    balsaCheckCount: 9,
    balsaCheckWidth: 0.012,
    // §T147 — the crack is 12 mm wide, so 20 mm of depth at `balsaBump` 8 was
    // an 87° wall (see the §T134 face-slope test): the log ends rendered as
    // black caps with white radial lines. 12 mm deep in a 12 mm crack is a
    // 66° wall at the honest gain, which is what a dried check actually is.
    balsaCheckDepth: 0.012,
    balsaCheckDarken: 0.45,
    grooveWidth: 0.04,
    grooveDepth: 0.012,
    grooveDarken: 0.55,
    weedColor: 0x4f6b3a,
    weedHalfBand: 0.15,
    weedBowFade: 2.5,
    weedStrength: 0.8,
    // §T147 — the logs are HALF SUBMERGED (`logAxisY` = 0 is the waterline), so
    // a band that only existed below y = 0 was painting the half nobody can
    // see. [ref kon-tiki-1947-sailing] the dark wet band straddles the water:
    // near-black at the surface, fading out about a fifth of a radius up.
    wetDarken: 0.5,
    wetRise: 0.12,
    // §T147 — two 0.55 m logs 5 cm apart form a slot that sees almost no sky,
    // which is why the reference's chinks read as dark LINES and ours read as
    // open water. `aoNode` is indirect-diffuse only, so the sun still rakes the
    // crowns untouched.
    balsaCrevice: 0.75,
    balsaRough: 0.86,
    // §T147, and it is §T134's arithmetic again — `reliefNormal` is exact and
    // every relief here is in METRES, so this gain is pure exaggeration. At 8
    // the rope groove presented a 78° wall, the grain 49°, and an end check
    // 87°: moulded plastic, which is the word the user used. 1.5 keeps a little
    // exaggeration (groove 34°, grain 12°, check 66°) and lets the ALBEDO carry
    // the wood, which is how woodMaterial has always done it.
    balsaBump: 1.5,
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
    // §B70 brought this down from 6 (a vertical wall at noon lives at N·L ≈ 0:
    // the crowns of one block caught the sun and the next block's did not, a
    // black-and-tan checkerboard from 15 m). §T134 goes the rest of the way for
    // the same reason as `thatchBump`: the crown is 0.004 m over a 0.045 m
    // strip, so it presents πAr/P = 15.6° of its own, and 2.5 turned that into
    // 35° — a moulded plastic basket at the arm's length the doorway puts the
    // player at. 1.4 keeps a little exaggeration for a plait's genuinely proud
    // strand (22.7°) and halves the gradient the frames show.
    weaveBump: 1.5,
    thatchLight: 0xc9b07a,
    thatchDark: 0x8c7a50,
    thatchUnder: 0.55,
    // §B87: the GEOMETRY now carries the courses (raftParams.roofCoursePitch,
    // 0.30 m), so the material's row is the LEAF inside a course — banana
    // leaves laid "like tiles" [§3 Roof], several to a course.
    // §T134 — AND "SEVERAL" HAS TO MEAN SEVERAL. At 0.12 m the material's row
    // was 0.4 of the geometry's own 0.30 m course: two course systems of
    // almost the same size, out of phase, on one roof, and at the 2 m a man at
    // the tiller stands from the eave each one subtends 3.4° — a row of crates,
    // which is what the user photographed. 0.075 m puts FOUR leaf laps inside
    // one structural course, which is the thing the material was given to draw.
    thatchRowPitch: 0.075,
    // both of these are fractions of the lap they sit on, so they move with it
    // (§V66) — 0.25 and 0.33 of the pitch, as before
    thatchRowEdge: 0.018,
    thatchRowRagged: 0.025,
    thatchStrandScale: 40,
    thatchStrandStretch: 12,
    thatchTileWidth: 0.16,
    thatchTileStagger: 0.03,
    thatchRelief: 0.006,
    // §T134 — `reliefNormal` is EXACT (Mikkelsen on the true screen gradient)
    // and `thatchRelief` is in METRES, so `thatchBump` is pure exaggeration and
    // 1 is the honest value. 6 was tuned against the pre-§T129 field, where the
    // coordinate advanced at sin θ = 0.204 and the row's effective period on
    // the roof was 0.588 m — max face slope πAr/P = 8.7°. §T129 removed the
    // stretch and left the 6 behind: the same crown over 0.12 m presents 37°
    // faces, and every row reads as a lit slab beside a black one. At 1.0 over
    // the 0.075 m lap it is 11.4°, i.e. a leaf lying on a leaf.
    thatchBump: 1,
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
    balsaGrey: colour, balsaWarm: colour, balsaShadow: colour, weedColor: colour,
    balsaToneVar: m(0, 1), balsaGrainScale: m(1, 30, 0.5), balsaGrainStretch: m(1, 20, 0.5),
    balsaGrainContrast: m(0, 1), balsaBlotchScale: m(0.2, 8, 0.05), balsaBlotchStrength: m(0, 1),
    balsaGrainRelief: m(0, 0.02, 0.001), balsaEndZone: m(0, 1.5), balsaCheckCount: m(3, 16, 1),
    balsaCheckWidth: m(0.002, 0.05, 0.001), balsaCheckDepth: m(0, 0.05, 0.001), balsaCheckDarken: m(0, 1),
    grooveWidth: m(0.01, 0.1, 0.005), grooveDepth: m(0, 0.05, 0.001), grooveDarken: m(0, 1),
    weedHalfBand: m(0, 0.4), weedBowFade: m(0.1, 6, 0.1), weedStrength: m(0, 1), wetDarken: m(0, 1),
    wetRise: m(0, 0.4), balsaCrevice: m(0, 1),
    balsaRough: m(0.3, 1), balsaBump: m(0, 30, 0.5),
    bambooYellow: colour, bambooGreen: colour,
    bambooNodePitch: m(0.1, 0.8), bambooNodeWidth: m(0.005, 0.06, 0.001), bambooSlatWidth: m(0.02, 0.15, 0.005),
    weaveTan: colour, weaveDark: colour,
    weaveStrip: m(0.02, 0.1, 0.001), weaveBlock: m(1, 10, 1), weaveEdge: m(0.02, 0.4), weaveRelief: m(0, 0.02, 0.001),
    weaveToneVar: m(0, 0.3), weaveRough: m(0.3, 1), weaveBump: m(0, 30, 0.5),
    thatchLight: colour, thatchDark: colour, thatchUnder: m(0, 1),
    // §T134 — the floor was 0.1 while the leaf lap has to live INSIDE the
    // geometry's 0.30 m course; 0.04 lets the slider reach a lap, not a course
    thatchRowPitch: m(0.04, 0.8, 0.005), thatchRowEdge: m(0.005, 0.1, 0.001), thatchRowRagged: m(0, 0.15),
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
