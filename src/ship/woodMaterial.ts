/**
 * Tri-planar plank wood TSL builder (T8 wood PBR, §V16). Sail cloth moved to
 * sailMaterial.ts when it grew wind dynamics (file cap, §C).
 * Sampled in PIECE-LOCAL space (positionLocal/normalLocal) so grain sticks
 * to each piece while the ship moves and rolls; no UVs needed. fbm and
 * tri-planar helpers come from src/terrain/noise.ts — not duplicated.
 * §V23 (§B B1/B2): 3-arg math uses functional mix()/smoothstep() ONLY —
 * chained `a.mix(b,t)` reads the receiver as the FACTOR. No chained forms here.
 */
import * as THREE from 'three/webgpu';
import {
  atan,
  float,
  fract,
  mix,
  normalLocal,
  normalWorldGeometry,
  positionLocal,
  positionWorld,
  sin,
  smoothstep,
  texture as textureNode,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { bandLimitedEdge, bandLimitedStep, coordFilter, periodResolved } from './bandLimit';
import type { DeckFieldSampler } from './deckFieldTexture';
import { waterLighting } from '../caustics';
import { deckWetness } from '../deckwater';
import { hash2, triplanarFbm } from '../terrain/noise';
import { reliefNormal } from './surfaceRelief';
import { shipDetailParams, shipMaterialParams, type ShipMaterialParams } from '../params/ship';

/**
 * The ship-wide "how hand-made is this" dial (§T.34), shared with the sail,
 * ratline and hull-rim generators so one slider governs all of them rather
 * than each system growing its own. Read through a function because Tweakpane
 * mutates the params object in place and `refresh()` re-reads it (§V16).
 */
const irregularity = (): number => Math.max(0, shipDetailParams.irregularity);

/** TSL nodes are structurally different per operation; these locals are
 *  reassigned across mix/add/mul so they need the loose node type */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNode = any;

/**
 * The frame a material resolves world positions into — the coordinate the
 * hull wetline's drying memory, the deck-water solver and the deck heightfield
 * are all indexed by.
 *
 * WHY THIS IS A PARAMETER AND NOT A MODULE-LEVEL UNIFORM. It used to be one
 * (`uShipWorldInverse`), which is fine right up until a SECOND object wants
 * the same material. The islands agent found it by reading: a pier sharing
 * this material would have had its wet band slide around as the ship sailed,
 * because the pier's world→local transform would have been the ship's. That
 * is the third instance of this shape in this project — `setShipWorldMatrix`
 * is still written once per assembly per frame, so the enemy galleon's matrix
 * wins and the PLAYER's wetline is indexed in the wrong frame, and three's own
 * `_defaultRT`/`_sharedDepthbuffer` are resized by whichever consumer touched
 * them last. A module-scope uniform holding a per-object transform fails
 * silently and reads as a shader bug.
 *
 * OMITTING IT IS MEANINGFUL, not a degraded path. `waterLighting` treats
 * `shipLocalPos` as optional and falls back to plain depth-below-surface
 * wetness, which is exactly right for something that does not move: a pier's
 * wet band belongs where the water is, not where a hull's drying memory says.
 * Only the deck families (deck water, deck heightfield) genuinely require a
 * frame, and they are ship-only by construction.
 */
export interface LocalFrame {
  /** world → frame-local matrix, as a live TSL uniform */
  readonly worldInverse: AnyNode;
  /** this fragment's position in the frame (vec3 node), built once and shared */
  readonly localPos: AnyNode;
  setFromMatrix(m: THREE.Matrix4): void;
}

export function createLocalFrame(): LocalFrame {
  const worldInverse = uniform(new THREE.Matrix4());
  return {
    worldInverse,
    // ONE node, not one per consumer: this used to be rebuilt at each of the
    // four call sites, so the shader did four identical matrix multiplies
    localPos: worldInverse.mul(vec4(positionWorld, 1)).xyz,
    setFromMatrix(m: THREE.Matrix4): void {
      worldInverse.value.copy(m).invert();
    },
  };
}

/**
 * The frame the SHIP's piece materials use by default.
 *
 * Still one shared instance, because main.ts caches piece materials by KIND
 * and shares them between the player and the enemy on purpose — three r180's
 * `getMaterialCacheKey` appends `object.uuid` for `InstancedMesh` but not for
 * plain `Mesh` (their own TODO, PR #29066), so pipelines are scarcer here than
 * they look and a second full set of ~30 wood shaders is not free. The
 * two-ships ambiguity therefore still exists — but it is now visible at ONE
 * call site instead of being wired into the material, and anything that is
 * not a ship no longer has to inherit it.
 */
const shipFrame = createLocalFrame();

export function setShipWorldMatrix(m: THREE.Matrix4): void {
  shipFrame.setFromMatrix(m);
}

/** the default frame for ship pieces; structures pass their own, or none */
export function shipLocalFrame(): LocalFrame {
  return shipFrame;
}

export interface WoodTones {
  light: number;
  dark: number;
  /** darker horizontal wale strakes (hull family only) */
  wale: boolean;
  /** darken + smooth below y=0, the waterline (hull family only) */
  waterline: boolean;
  /**
   * Spars are made of STAVES running along the spar, not of courses stacked
   * across it. Set to the piece-local axis the spar runs along ('y' for masts
   * and the bowsprit, 'x' for yards).
   *
   * §B-class bug this fixes: the seam function stacked seams along local y for
   * every non-horizontal face. On a cylinder that wraps them into HOOPS — the
   * "mast rings" in the §T.34 gap list. A mast reading as a stack of barrel
   * bands instead of a spar is the single most obviously-wrong surface on the
   * ship, and it came from a coordinate choice, not from a missing feature.
   */
  sparAxis?: 'x' | 'y';
  /**
   * Set on the LOFTED SHELL pieces only (hull-section, bow, transom): plank
   * the topsides in the loft's own surface parameter instead of in world y.
   *
   * WHY. A hull is not planked in horizontal slices. Strakes run fore-and-aft
   * from stem to stern, parallel to the sheer, and because a plank is
   * continuous the STRAKE COUNT is fixed while the plank's width follows the
   * girth of the section — so the boards narrow toward both ends. Coordinate
   * `positionLocal.y / plankWidth` gives none of that: it draws level
   * waterlines that cut across the sheer at the bow and stern and hold one
   * width the whole length. That reads as wallpaper on a curved surface,
   * which is the "too regular" note this project keeps collecting.
   *
   * The fix costs nothing to compute because the loft ALREADY carries the
   * right coordinate: pieceGeometryHull's `sideStrip` writes uv = (station,
   * h) with h = 0 at the keel and 1 at the rail line, and the transom cap
   * writes the same h normalised over its own counter. Lines of constant h
   * ARE the strakes — they ride the sheer by construction and they converge
   * wherever `sectionHalf` pinches the section in. Reading uv.y is therefore
   * exact agreement with the geometry rather than a second guess at it
   * (§V.37's "mating surfaces share their sampling"), and it needs no hull
   * shape plumbed into a material that is cached per piece KIND and shared
   * between ships.
   *
   * REQUIRES a `uv` attribute whose y is that height fraction — true for the
   * three lofted shell kinds and their holed variants, false for the boxes
   * the rest of the hull family is built from, which is why this is a flag
   * and not the default.
   */
  strake?: boolean;
  /**
   * Deck-family pieces read the procedural deck heightfield so their boards
   * genuinely sit at slightly different heights — the same field the deck-water
   * solver flows over, so a puddle pools in a hollow you can SEE
   * (deckHeightfield.ts). Absent on every other family.
   */
  deckField?: DeckFieldSampler;
}

/**
 * Staves around a spar. Must be an INTEGER: the stave coordinate is the
 * circumferential angle, which jumps by 2π at the ±π branch cut of atan, and
 * only an integer number of staves per turn makes `fract()` of it continuous
 * across that cut. A fractional count would paint one hard vertical seam down
 * the back of every mast, and the relief normal differentiates the height
 * field, so that seam would spike to a one-pixel line (§V38).
 */
const SPAR_STAVES = 8;

/**
 * Feathering width of a wale strake's edge, as a fraction of the wale repeat.
 * Named because it is now also the feature width the wale's band limit is
 * measured against (§V.48) — the two must be the same number or the limit is
 * gating on something the shader does not actually draw.
 */
const WALE_EDGE = 0.06;

export interface ShipMaterialHandle {
  material: THREE.MeshStandardNodeMaterial;
  /** re-read live params (Tweakpane mutates them in place, §V16) */
  refresh(): void;
}

/**
 * @param frame the local frame world positions resolve into (wetline / deck
 *              water / deck field indexing). Omit for anything that is not a
 *              ship: the wet band then comes straight off the sea surface,
 *              which is what a pier or a hut wants. See {@link LocalFrame}.
 */
export function createWoodMaterial(
  tones: WoodTones,
  frame?: LocalFrame,
  p: ShipMaterialParams = shipMaterialParams,
): ShipMaterialHandle {
  const material = new THREE.MeshStandardNodeMaterial();
  material.metalness = 0;

  const uLight = uniform(new THREE.Color(tones.light));
  const uDark = uniform(new THREE.Color(tones.dark));
  const uGrainScale = uniform(p.grainScale);
  const uGrainStretch = uniform(p.grainStretch);
  const uSharpness = uniform(p.triplanarSharpness);
  const uPlankWidth = uniform(p.plankWidth);
  const uHullStrakes = uniform(p.hullStrakes);
  const uSeamWidth = uniform(p.seamWidth);
  const uSeamDarken = uniform(p.seamDarken);
  const uPlankLength = uniform(p.plankLength);
  const uButtWidth = uniform(p.buttWidth);
  const uWaleFrequency = uniform(p.waleFrequency);
  const uWaleRatio = uniform(p.waleRatio);
  const uWaleDarken = uniform(p.waleDarken);

  const uBumpScale = uniform(p.bumpScale);
  const uGrainRelief = uniform(p.grainRelief);
  const uPlankRelief = uniform(p.plankRelief);
  const uPlankStep = uniform(p.plankStep);
  const uPlankChamfer = uniform(p.plankChamfer);
  const uAoStrength = uniform(p.aoStrength);
  const uPlankTilt = uniform(p.plankTilt * irregularity());
  const uPlankWander = uniform(p.plankWander * irregularity());
  const uSeamDepth = uniform(p.seamDepth);
  const uWaleRelief = uniform(p.waleRelief);
  const uPlankToneVar = uniform(p.plankToneVar);
  const uBleach = uniform(new THREE.Color(p.bleachColor));
  const uBleachStrength = uniform(p.bleachStrength);
  const uWetDarken = uniform(p.wetDarken);
  const uWetSmooth = uniform(p.wetSmooth);
  const uWetlineFade = uniform(p.wetlineFade);
  const uRoughBase = uniform(p.roughBase);
  const uDeckRelief = uniform(p.deckFieldRelief);
  const uDeckTone = uniform(p.deckFieldTone);

  // grain: fbm stretched along z (plank axis) so streaks read lengthwise
  const samplePos = positionLocal
    .mul(uGrainScale)
    .mul(vec3(1, 1, uGrainStretch));
  const grain = triplanarFbm(samplePos, normalLocal, uSharpness, p.grainOctaves);
  /**
   * §V.48 for the grain RIDGES. fbm is not periodic but its finest octave is
   * still a fixed spatial frequency, and that octave is the one `reliefNormal`
   * differentiates hardest. `grainRelief` is only 4 mm, but 4 mm of random
   * height across a one-pixel footprint is a ~20° normal error, which is
   * speckle. Fades on the finest octave's own footprint, taking the worst of
   * the three axes since tri-planar picks a different pair per face.
   *
   * The grain's COLOUR is deliberately left alone: tone shimmer is mild where
   * random normals are not, and losing it would flatten the hull to one
   * painted colour at exactly the distance the ship is usually seen from.
   */
  const finestOctave = samplePos.mul(2 ** Math.max(0, p.grainOctaves - 1));
  const gw = finestOctave.dFdx().abs().add(finestOctave.dFdy().abs());
  const grainResolved = float(1).sub(
    smoothstep(float(0.4), float(1.1), gw.x.max(gw.y).max(gw.z)),
  );

  // plank seams: along the strakes on a lofted shell, stacked in y on other
  // vertical faces, side-by-side in x on decks, and AROUND a spar (see
  // WoodTones.sparAxis) rather than stacked up it.
  const upness = smoothstep(float(0.6), float(0.9), normalLocal.y.abs());
  /**
   * …and the third case the material never had: a face looking FORE or AFT.
   * The transom is planked in courses running athwartships, so its boards'
   * length axis is x, not z. Without this the transom's butt joints were
   * evaluated at `positionLocal.z`, which on a stern plate whose origin sits
   * at z = sternZ is very nearly the CONSTANT zero — so every course landed
   * at one fixed phase of the butt pattern and the joints became a random
   * per-strake darkening of the whole plate instead of joints. The bow's
   * beakhead face is the same shape of surface and gets the same treatment.
   */
  const aftness = smoothstep(float(0.6), float(0.9), normalLocal.z.abs());
  let plankCoord: AnyNode;
  let alongPlank: AnyNode; // the board's own length axis — where butts land
  // screen-space footprints of the two coordinates above, carried separately:
  // see bandLimitedEdge()'s `filterOverride` for why a blended coordinate must
  // not be differentiated directly.
  let plankFilter: AnyNode;
  let alongFilter: AnyNode;
  if (tones.sparAxis === undefined) {
    const deckCoord = positionLocal.x.div(uPlankWidth);
    // the strake coordinate is ALREADY in boards (uv.y ∈ [0,1] × strake
    // count), so the blend happens in board units, not in metres
    const sideCoord =
      tones.strake === true
        ? uv().y.mul(uHullStrakes)
        : positionLocal.y.div(uPlankWidth);
    plankCoord = mix(sideCoord, deckCoord, upness);
    plankFilter = mix(coordFilter(sideCoord), coordFilter(deckCoord), upness);
    // hull and deck planking runs fore-and-aft; a transom's runs athwart
    alongPlank = mix(positionLocal.z, positionLocal.x, aftness);
    alongFilter = mix(coordFilter(positionLocal.z), coordFilter(positionLocal.x), aftness);
  } else if (tones.sparAxis === 'y') {
    // angle about the spar × an integer stave count (see SPAR_STAVES)
    plankCoord = atan(positionLocal.z, positionLocal.x).mul(SPAR_STAVES / (Math.PI * 2));
    alongPlank = positionLocal.y;
    plankFilter = coordFilter(plankCoord);
    alongFilter = coordFilter(alongPlank);
  } else {
    plankCoord = atan(positionLocal.z, positionLocal.y).mul(SPAR_STAVES / (Math.PI * 2));
    alongPlank = positionLocal.x;
    plankFilter = coordFilter(plankCoord);
    alongFilter = coordFilter(alongPlank);
  }
  /**
   * BAND LIMIT (§V.48, and the reason masts rendered BLACK at range).
   *
   * `resolved` covers the SMOOTH terms below — the crowned per-board lift and
   * the per-board tone jitter — whose only failure mode is the whole repeat
   * going sub-pixel. A 0.84 m mast at 50 m is about eight pixels wide, so all
   * eight staves fall inside those eight pixels; `fract()` aliases, `crown`
   * oscillates per pixel, `reliefNormal` differentiates that noise in screen
   * space, and the shading normal comes out random (measured: correct brown
   * timber at 5 m, pure black at 50 m).
   *
   * The EDGES — seams, butts, wale boundaries — are band-limited separately
   * against their own much narrower widths by bandLimitedEdge(). Gating them
   * on the period was the bug that left the hull speckling after the mast fix:
   * a 0.044 m seam inside a 0.55 m plank goes sub-pixel twelve times sooner
   * than the plank does, and every distance in between is the speckle band.
   *
   * One unit of `plankCoord` is ONE BOARD however it was built — metres over
   * plankWidth on a deck, one strake of the loft on a shell — so `seamWidth`
   * stays a fraction of a plank and the limit keeps measuring the seam.
   */
  /**
   * SEAM WANDER (user: "everything is basically nailed to a millionth of an
   * inch precision, making stuff look very blocky and unnatural").
   *
   * Every seam up to here is a mathematically straight line, and a hull's
   * worth of exactly parallel straight lines is the same uniformity failure
   * this project has already had reported on the sea, the foam and the
   * sails. A board sawn and dubbed by hand does not have a straight edge: it
   * wanders a centimetre or two over its length, and its neighbour wanders
   * differently, so the caulk line breathes. Displacing the board coordinate
   * is enough — the seam, the caulk groove, the per-board tone, the butt
   * stagger and the wale all ride it, so ONE term makes the whole system
   * stop being a grid.
   *
   * CONTINUOUS BY CONSTRUCTION. It is a `sin` of the two SMOOTH coordinates,
   * never of `plankCoord.floor()`: a per-board displacement would step at
   * every seam, and §V38's differentiation turns a step into a one-pixel
   * spike. The board-coordinate term inside the sine is what decorrelates
   * neighbouring strakes so they do not all wave in unison.
   *
   * BAND LIMIT (§V.48): the seam limit keeps measuring the UNWANDERED
   * footprint. The wander's own gradient is amplitude × 2π/length ≈ 0.03 per
   * metre plus 1.7 × amplitude per board — a few percent of the plank
   * coordinate's own 1/plankWidth — so it moves the seam without meaningfully
   * changing how wide that seam is on screen, and it is well inside the
   * two-pixel margin FILTER_PIXELS already carries. It needs no gate of its
   * own: it only DISPLACES an edge whose energy is already gated, so when the
   * seam fades out the wander goes with it.
   */
  const wander = sin(
    alongPlank.mul((Math.PI * 2) / Math.max(0.5, p.plankWanderLength)).add(plankCoord.mul(1.7)),
  ).mul(uPlankWander);
  const boardCoord = plankCoord.add(wander);

  const resolved = periodResolved(boardCoord, plankFilter);

  const f = fract(boardCoord);
  const edgeDistance = f.min(f.oneMinus()); // 0 at a seam, 0.5 mid-plank
  const seamMask = bandLimitedEdge(edgeDistance, boardCoord, uSeamWidth, plankFilter); // 0 = seam
  const seamGroove = seamMask.oneMinus(); // 1 IN the caulked groove

  // every plank is its own board: slightly different tone, and laid a hair
  // proud or shy of its neighbours. This is most of what reads as planking
  // rather than a painted stripe pattern.
  const plankId = hash2(vec2(boardCoord.floor(), 17.3));
  /**
   * THE PLATEAU STEP (§V.70, §B.48) — the term whose absence made this deck
   * read as painted-on flat wood twice.
   *
   * Everything below this line is CROWNED: `sin(πf)` and `sin(2πf)` are both
   * zero at f=0 and f=1, so every board met every neighbour at exactly the same
   * height and the whole surface was perfectly flush by construction. That was
   * deliberate — a crown carries no step, and a step differentiates to a
   * one-pixel spike (§B.20). But a board reads as a solid object precisely
   * because its face sits at a different height from the next board's, and the
   * only place the eye can compare two boards is the seam the crown zeroes.
   *
   * `bandLimitedStep` keeps the §B.20 safety without the flatness: the two
   * boards blend to their shared MEAN at the seam, so the field is continuous
   * and `reliefNormal` differentiates a ramp. The chamfer is widened to the
   * pixel footprint (§V.48b half a) and the amplitude rides `resolved`, the
   * PERIOD gate — §V.48's own prescription for per-board terms. It is
   * deliberately NOT faded to zero on the chamfer's own width: a step's
   * band-limited mean is the ramp, not "no step" (§V.70).
   *
   * The neighbour is picked by `sign(f − 0.5)`, whose flip at mid-board is
   * harmless BY CONSTRUCTION: at f = 0.5 the distance to either seam is at its
   * maximum, so the neighbour's weight there is already zero.
   */
  const boardIndex = boardCoord.floor();
  const neighbourId = hash2(vec2(boardIndex.add(f.sub(0.5).sign()), 17.3));
  /** a board id as a signed level, −1..1 */
  const level = (id: AnyNode): AnyNode => id.sub(0.5).mul(2);
  const plankPlateau = bandLimitedStep(
    edgeDistance,
    level(plankId),
    level(neighbourId),
    uPlankChamfer,
    plankFilter,
  ).mul(resolved);
  // CROWNED, not stepped: the lift rises to the middle of each board and
  // returns to zero at both seams. A per-plank constant would be a step in
  // the height field, and the relief normal differentiates that field in
  // screen space — a step differentiates to a one-pixel spike at every seam.
  // crowned AND band-limited: the lift is the largest term in the height
  // field, so it is the one that blows the relief normal up when it aliases
  const crown = sin(f.mul(Math.PI)).mul(resolved);
  const plankLift = plankId.sub(0.5).mul(2).mul(crown); // −1..1, continuous
  /**
   * …and each board is laid with one edge a shade prouder than the other,
   * because nothing is bedded perfectly flat. `sin(2πf)` is ANTISYMMETRIC
   * across the board and zero at BOTH seams, so it tilts the plank without
   * putting a step in the height field — the same reason `crown` is a sine
   * and not a per-board constant. This is what turns a row of boards from a
   * flat panel with lines drawn on it into something the light rakes across.
   */
  const tiltId = hash2(vec2(boardCoord.floor(), 29.1));
  const plankTilt = sin(f.mul(Math.PI * 2)).mul(tiltId.sub(0.5).mul(2)).mul(resolved);

  // BUTT JOINTS. Real planking is short boards butted end to end, and the
  // butts of neighbouring courses are deliberately STAGGERED (two butts in
  // line is a weak spot a shipwright would never build). Continuous courses
  // running the whole 35 m hull are the loudest remaining "ultra regular"
  // tell on the topsides. Each course gets its own phase AND its own board
  // length from `plankId`, so no two courses butt at the same station and the
  // spacing itself is irregular. Spars have no butts — staves run full length.
  const buttPhase = hash2(vec2(boardCoord.floor(), 41.9));
  const boardLength = uPlankLength.mul(mix(float(0.7), float(1.35), plankId)).max(0.25);
  const bt = fract(alongPlank.div(boardLength).add(buttPhase));
  const buttDistance = bt.min(bt.oneMinus()).mul(boardLength); // metres to a butt
  /**
   * Band-limited against `alongPlank` — METRES along the board — and not
   * against `bt`. `bt` folds in `buttPhase` and `boardLength`, both per-plank
   * constants that STEP at every seam, so its derivative spikes there and
   * would report a filter width of thousands. `alongPlank` is the smooth
   * coordinate the butt distance actually varies along.
   *
   * This is the term that dots the DECK: butts are 5 cm wide at 4.6 m
   * spacing, the follow camera sees the deck at a grazing angle, so a pixel
   * covers far more than 5 cm of fore-and-aft deck long before the ship is
   * even far away.
   */
  const buttMask = bandLimitedEdge(buttDistance, alongPlank, uButtWidth, alongFilter); // 0 = butt
  const buttGroove = buttMask.oneMinus();

  // --- one height field, shared by colour, roughness and the relief normal
  let height: AnyNode = grain
    .sub(0.5)
    .mul(uGrainRelief)
    .mul(grainResolved)
    .add(plankPlateau.mul(uPlankStep))
    .add(plankLift.mul(uPlankRelief))
    .add(plankTilt.mul(uPlankTilt));
  height = height.sub(seamGroove.mul(uSeamDepth)); // caulking sits recessed
  // the butt groove fades out at the plank seams (× crown). Without that the
  // height field STEPS across a seam — one board grooved, its neighbour not —
  // and §V38's differentiation turns that step into a one-pixel spike.
  if (tones.sparAxis === undefined) {
    height = height.sub(buttGroove.mul(uSeamDepth).mul(0.8).mul(crown));
  }

  /**
   * CAVITY OCCLUSION (§B.48b) — the half of "3-dimensional" that no normal can
   * supply, and the thing the reference is actually doing.
   *
   * There is no environment map in this project; the only ambient is a
   * HemisphereLight, and its irradiance on an up-facing surface is a function
   * of N.y ALONE. A 2° normal tilt moves N.y by 0.0006, so the ambient term is
   * effectively CONSTANT over an entire deck — ~24% of a sunlit deck's light
   * and 100% of a shadowed one's, and a galleon's deck spends most of its area
   * under sail shadow. In that shadow the relief normal changes NOTHING, and
   * what is left is albedo: a dark line between two identically-lit boards,
   * which is the definition of the complaint.
   *
   * Occlusion is the only channel that can put contrast there. `aoNode` costs
   * no texture and no sampler — three multiplies it into indirect diffuse only
   * (`PhysicalLightingModel`), so direct sun still rakes across the boards
   * untouched and nothing here depends on the post pipeline, which has never
   * run.
   *
   * Every input is a mask that is ALREADY band-limited: the seam and butt
   * grooves come from `bandLimitedEdge`, and the plateau difference rides
   * `resolved`. So the occlusion fades out exactly when the geometry it stands
   * for stops being resolvable, with no gate of its own (§V.48).
   */
  let cavity: AnyNode = seamGroove;
  if (tones.sparAxis === undefined) {
    // a butt joint is as open as a seam, and crowned for the same reason its
    // own depth is: no step across a plank edge
    cavity = cavity.max(buttGroove.mul(crown));
  }
  /**
   * …and the LOW side of a plateau step is shaded by the board standing over
   * it. This is what makes the step read in flat ambient light rather than
   * only when the sun happens to rake it — a one-sided darkening that tells
   * you WHICH board is proud, which a symmetric caulk line never could.
   * Weighted by `seamGroove` so it is confined to the edge region.
   */
  const stepShade = level(neighbourId).sub(level(plankId)).max(0).mul(0.5).mul(resolved);
  cavity = cavity.max(stepShade.mul(seamGroove));
  material.aoNode = float(1).sub(cavity.clamp(0, 1).mul(uAoStrength));

  // per-board tone jitter is a STEP at each seam — flat across a board, then a
  // jump. Once a board is sub-pixel that step is per-pixel random albedo, so
  // the amplitude rides `resolved` exactly as the crowned lift does.
  const toneVar = uPlankToneVar.mul(resolved);
  const base = mix(uDark, uLight, grain).mul(
    mix(float(1).sub(toneVar), float(1).add(toneVar), plankId),
  );
  let color: AnyNode = mix(base.mul(uSeamDarken), base, seamMask);
  if (tones.sparAxis === undefined) {
    color = mix(color.mul(uSeamDarken), color, buttMask);
  }
  let rough: AnyNode = uRoughBase.add(grain.mul(0.18)).add(seamGroove.mul(0.12));

  if (tones.wale) {
    /**
     * Wale strakes: a THICKER belt of planking — darker, and standing proud.
     *
     * Written as a SIGNED DISTANCE to the belt rather than as a smoothstep on
     * `fract` directly. `smoothstep(ratio-h, ratio+h, fract(c))` is smooth at
     * the top of the belt and a HARD STEP at the fract wrap at its bottom, so
     * it was smoothing one edge of the wale and leaving the other as a raw
     * discontinuity in the height field — a one-pixel bright line the whole
     * length of the ship, exactly the artifact the old comment claimed to have
     * avoided. Centring the coordinate on the belt makes both edges the same
     * edge, and then one band limit covers both (§V.48).
     *
     * COUNTED IN PLANKS, not in metres of world height. A wale is not a
     * stripe painted over the planking, it IS a strake — a thicker board in
     * the run — so it has to be laid out in the same coordinate the boards
     * are, or it crosses them: level bands over strakes that ride the sheer
     * would have converged and diverged along the ship. `waleFrequency` is
     * therefore wales per board (0.25 = every fourth strake).
     *
     * The +0.5 puts the belt's CENTRE on a board's centre rather than on a
     * seam. With `waleRatio` × the repeat coming to a whole number of planks,
     * that makes the wale exactly one strake wide with its feathered edges
     * landing in the caulk lines either side — a thick board in the run,
     * which is what a wale is. Without the offset the belt is centred on a
     * seam and takes half of each neighbouring board, and the wale's own
     * edge then cuts across the planking it is supposed to punctuate.
     */
    const waleCoord = boardCoord.add(0.5).mul(uWaleFrequency);
    const waleFilter = plankFilter.mul(uWaleFrequency);
    const half = uWaleRatio.mul(0.5);
    const centred = fract(waleCoord.sub(half).add(0.5)).sub(0.5);
    // <0 inside the belt, >0 outside; +half the edge width centres the
    // transition on the true boundary, matching the old ±0.03 feathering
    const waleDistance = centred.abs().sub(half).add(WALE_EDGE * 0.5);
    const band = bandLimitedEdge(waleDistance, waleCoord, float(WALE_EDGE), waleFilter);
    color = mix(color.mul(uWaleDarken), color, band);
    height = height.add(band.oneMinus().mul(uWaleRelief));
  }

  // --- deck water (§V9/§T.31). Built-but-unwired until this call exists: the
  // solver can be running perfectly and reach zero pixels, which is exactly
  // what happened — `deckWetness()` appeared nowhere outside src/deckwater, so
  // toggling the panel did nothing and the speckle everyone was chasing turned
  // out to be the heightfield above, not the water at all. Applied only to the
  // deck family, and multiplicatively, so it composes with our own relief
  // instead of replacing it: wet timber's grain flattens under the film, which
  // is what `reliefScale` expresses.
  if (tones.deckField !== undefined && frame !== undefined) {
    const wet = deckWetness({ shipLocalPos: frame.localPos });
    color = color.mul(wet.tint);
    rough = rough.mul(wet.roughnessScale);
    height = height.mul(wet.reliefScale).add(wet.heightAdd);
  }

  // --- the deck heightfield (§T.34 / talk "Surface Water: Setup") -----------
  // One generated field drives BOTH this relief and the deck-water solver, so
  // the boards you can see standing proud are the boards the water runs off,
  // and the hollows worn by the capstan are where it pools. Only the B channel
  // (per-board offsets) is read here: the structural channel is real geometry
  // already — coamings, castle steps and the bulwark are pieces, and adding
  // them again as shading relief would double-count them.
  if (tones.deckField !== undefined && frame !== undefined) {
    const fld = tones.deckField;
    // ship-local, not piece-local: the four deck-family kinds sit at four
    // different origins, and one projection has to serve all of them
    const local = frame.localPos;
    const fu = local.x.sub(fld.minX).div(Math.max(1e-3, fld.maxX - fld.minX));
    const fv = local.z.sub(fld.minZ).div(Math.max(1e-3, fld.maxZ - fld.minZ));
    const sample = textureNode(fld.texture, vec2(fu, fv));
    // horizontal faces only — a top-down field smeared down a bulkhead reads
    // as vertical streaks
    const onDeck = sample.g.mul(upness);
    height = height.add(sample.b.mul(uDeckRelief).mul(onDeck));
    // and the tone shift that makes the variation readable in daylight, not
    // just in raking light: a proud board is a shade lighter than a sunk one
    color = color.mul(float(1).add(sample.b.mul(uDeckTone).mul(onDeck)));
  }

  // sun-bleached upper surfaces: horizontal faces take the weather, going
  // paler and chalkier than the sheltered vertical planking
  color = mix(color, mix(color, uBleach, uBleachStrength), upness);
  rough = rough.add(upness.mul(0.08));

  if (tones.waterline) {
    // …and the opposite below: constantly wet, so darker and far smoother.
    // Hull pieces keep ship-space Y in their local geometry, so y < 0 is
    // genuinely below the waterline (see hull loft — piece transform y = 0).
    const wet = smoothstep(float(0), uWetlineFade, positionLocal.y.negate());
    color = mix(color, color.mul(float(1).sub(uWetDarken)), wet);
    rough = mix(rough, rough.mul(float(1).sub(uWetSmooth)), wet);
  }

  // --- the ship as an object that is IN the sea (§T.32/§V.34).
  // Submerged planking gets refracted caustics; the topsides get the
  // above-water REFLECTED branch — sunlight bouncing off the wave surface
  // and playing up the hull sides, which is the effect that stops the ship
  // reading as pasted onto the water. Every output modulates our own
  // material rather than replacing it, including the relief: timber under a
  // water film loses its grain, so `reliefScale` damps the relief — applied
  // to the STRENGTH at the reliefNormal call below rather than to the height
  // field, for the product-rule reason set out there (§V.49).
  // normalWorldGeometry (NOT normalWorld) — normalWorld resolves to
  // this material's own normalNode, and that node is built from `height`
  // below, so feeding it back here would be a cycle.
  const water = waterLighting({
    worldPos: positionWorld,
    normal: normalWorldGeometry,
    // no frame ⟹ no shipLocalPos ⟹ waterLighting falls back to plain
    // depth-below-surface wetness, which is the correct answer for a fixed
    // structure and a silently wrong one for a hull (§V.49 note below is
    // unaffected either way: reliefScale is applied AFTER dFdx, not to the
    // height field)
    ...(frame === undefined ? {} : { shipLocalPos: frame.localPos }),
    mode: 'both',
  });
  color = color.mul(water.tint);
  rough = rough.mul(water.roughnessScale);

  material.colorNode = color;
  material.roughnessNode = rough.clamp(0.04, 1);
  material.emissiveNode = water.addLight;
  /**
   * Relief from the SAME height field — no textures, no tangents, no UVs.
   *
   * §V.49: `water.reliefScale` scales the STRENGTH, not the height. It used
   * to multiply `height`, and `reliefNormal` differentiates whatever it is
   * given, so the product rule handed the normal an `H · dS/dx` term — the
   * hull wetline's own sampling noise, amplified by the full magnitude of
   * the wood grain, and invisible on a dry hull because a constant S has no
   * derivative. Now that the topsides carry plank relief the wetline band
   * runs straight through it, so H is at its largest exactly where S varies.
   * `reliefNormal` applies `scale` AFTER taking dH/dx, so folding the factor
   * in here differentiates the height alone and the cross term cannot exist
   * — the same wet-timber-flattens look with no product to alias.
   *
   * The deck-water factor is deliberately NOT moved: deckwater documents
   * `heightAdd` as adding to the field AFTER `reliefScale` (the film's own
   * surface, which must not be flattened by its own wetness), and it already
   * band-limits its factor on a reduced tier at its own end.
   */
  material.normalNode = reliefNormal(height, uBumpScale.mul(water.reliefScale));

  return {
    material,
    refresh(): void {
      uLight.value.set(tones.light);
      uDark.value.set(tones.dark);
      uGrainScale.value = p.grainScale;
      uGrainStretch.value = p.grainStretch;
      uSharpness.value = p.triplanarSharpness;
      uPlankWidth.value = p.plankWidth;
      uHullStrakes.value = p.hullStrakes;
      uSeamWidth.value = p.seamWidth;
      uSeamDarken.value = p.seamDarken;
      uPlankLength.value = p.plankLength;
      uButtWidth.value = p.buttWidth;
      uWaleFrequency.value = p.waleFrequency;
      uWaleRatio.value = p.waleRatio;
      uWaleDarken.value = p.waleDarken;
      uBumpScale.value = p.bumpScale;
      uGrainRelief.value = p.grainRelief;
      uPlankRelief.value = p.plankRelief;
      uPlankStep.value = p.plankStep;
      uPlankChamfer.value = p.plankChamfer;
      uAoStrength.value = p.aoStrength;
      uPlankTilt.value = p.plankTilt * irregularity();
      uPlankWander.value = p.plankWander * irregularity();
      uSeamDepth.value = p.seamDepth;
      uWaleRelief.value = p.waleRelief;
      uPlankToneVar.value = p.plankToneVar;
      uBleach.value.set(p.bleachColor); // sRGB via Color.set (§V31/§B.9)
      uBleachStrength.value = p.bleachStrength;
      uWetDarken.value = p.wetDarken;
      uWetSmooth.value = p.wetSmooth;
      uWetlineFade.value = p.wetlineFade;
      uRoughBase.value = p.roughBase;
      uDeckRelief.value = p.deckFieldRelief;
      uDeckTone.value = p.deckFieldTone;
    },
  };
}
