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
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { DeckFieldSampler } from './deckFieldTexture';
import { waterLighting } from '../caustics';
import { hash2, triplanarFbm } from '../terrain/noise';
import { reliefNormal } from './surfaceRelief';
import { shipMaterialParams, type ShipMaterialParams } from '../params/ship';

/** TSL nodes are structurally different per operation; these locals are
 *  reassigned across mix/add/mul so they need the loose node type */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNode = any;

/**
 * Ship world matrix INVERSE, so a shared piece material can turn a world
 * position into a ship-local one — the coordinate the hull wetline's drying
 * memory is indexed by. Module-level and set from the main loop, mirroring
 * `uShipSunDirection` in sailMaterial.ts (same pattern, same reason: piece
 * materials are built per assembly but this is per frame).
 *
 * UNTIL main.ts calls setShipWorldMatrix() each frame this stays identity,
 * which means the wetline reads ship-local == world and the drying band
 * lands in the wrong place. Caustics and bounce do NOT depend on it.
 */
export const uShipWorldInverse = uniform(new THREE.Matrix4());

export function setShipWorldMatrix(m: THREE.Matrix4): void {
  uShipWorldInverse.value.copy(m).invert();
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

export interface ShipMaterialHandle {
  material: THREE.MeshStandardNodeMaterial;
  /** re-read live params (Tweakpane mutates them in place, §V16) */
  refresh(): void;
}

export function createWoodMaterial(
  tones: WoodTones,
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

  // plank seams: stacked in y on vertical faces, side-by-side in x on decks,
  // and AROUND a spar (see WoodTones.sparAxis) rather than stacked up it.
  const upness = smoothstep(float(0.6), float(0.9), normalLocal.y.abs());
  let plankCoord: AnyNode;
  let alongPlank: AnyNode; // the board's own length axis — where butts land
  if (tones.sparAxis === undefined) {
    const across = mix(positionLocal.y, positionLocal.x, upness);
    plankCoord = across.div(uPlankWidth);
    alongPlank = positionLocal.z; // hull and deck planking runs fore-and-aft
  } else if (tones.sparAxis === 'y') {
    // angle about the spar × an integer stave count (see SPAR_STAVES)
    plankCoord = atan(positionLocal.z, positionLocal.x).mul(SPAR_STAVES / (Math.PI * 2));
    alongPlank = positionLocal.y;
  } else {
    plankCoord = atan(positionLocal.z, positionLocal.y).mul(SPAR_STAVES / (Math.PI * 2));
    alongPlank = positionLocal.x;
  }
  const f = fract(plankCoord);
  const edgeDistance = f.min(f.oneMinus()); // 0 at a seam, 0.5 mid-plank
  const seamMask = smoothstep(float(0), uSeamWidth, edgeDistance); // 0 = seam
  const seamGroove = seamMask.oneMinus(); // 1 IN the caulked groove

  // every plank is its own board: slightly different tone, and laid a hair
  // proud or shy of its neighbours. This is most of what reads as planking
  // rather than a painted stripe pattern.
  const plankId = hash2(vec2(plankCoord.floor(), 17.3));
  // CROWNED, not stepped: the lift rises to the middle of each board and
  // returns to zero at both seams. A per-plank constant would be a step in
  // the height field, and the relief normal differentiates that field in
  // screen space — a step differentiates to a one-pixel spike at every seam.
  const crown = sin(f.mul(Math.PI));
  const plankLift = plankId.sub(0.5).mul(2).mul(crown); // −1..1, continuous

  // BUTT JOINTS. Real planking is short boards butted end to end, and the
  // butts of neighbouring courses are deliberately STAGGERED (two butts in
  // line is a weak spot a shipwright would never build). Continuous courses
  // running the whole 35 m hull are the loudest remaining "ultra regular"
  // tell on the topsides. Each course gets its own phase AND its own board
  // length from `plankId`, so no two courses butt at the same station and the
  // spacing itself is irregular. Spars have no butts — staves run full length.
  const buttPhase = hash2(vec2(plankCoord.floor(), 41.9));
  const boardLength = uPlankLength.mul(mix(float(0.7), float(1.35), plankId)).max(0.25);
  const bt = fract(alongPlank.div(boardLength).add(buttPhase));
  const buttDistance = bt.min(bt.oneMinus()).mul(boardLength); // metres to a butt
  const buttMask = smoothstep(float(0), uButtWidth, buttDistance); // 0 = butt
  const buttGroove = buttMask.oneMinus();

  // --- one height field, shared by colour, roughness and the relief normal
  let height: AnyNode = grain.sub(0.5).mul(uGrainRelief).add(plankLift.mul(uPlankRelief));
  height = height.sub(seamGroove.mul(uSeamDepth)); // caulking sits recessed
  // the butt groove fades out at the plank seams (× crown). Without that the
  // height field STEPS across a seam — one board grooved, its neighbour not —
  // and §V38's differentiation turns that step into a one-pixel spike.
  if (tones.sparAxis === undefined) {
    height = height.sub(buttGroove.mul(uSeamDepth).mul(0.8).mul(crown));
  }

  const base = mix(uDark, uLight, grain).mul(
    mix(float(1).sub(uPlankToneVar), float(1).add(uPlankToneVar), plankId),
  );
  let color: AnyNode = mix(base.mul(uSeamDarken), base, seamMask);
  if (tones.sparAxis === undefined) {
    color = mix(color.mul(uSeamDarken), color, buttMask);
  }
  let rough: AnyNode = uRoughBase.add(grain.mul(0.18)).add(seamGroove.mul(0.12));

  if (tones.wale) {
    // wale strakes: a THICKER belt of planking — darker, and standing proud.
    // Smoothstepped rather than step()ped for the same reason as the crown:
    // a hard edge in the height field spikes its screen-space derivative.
    const waleT = fract(positionLocal.y.mul(uWaleFrequency));
    const band = smoothstep(uWaleRatio.sub(0.03), uWaleRatio.add(0.03), waleT);
    color = mix(color.mul(uWaleDarken), color, band);
    height = height.add(band.oneMinus().mul(uWaleRelief));
  }

  // --- the deck heightfield (§T.34 / talk "Surface Water: Setup") -----------
  // One generated field drives BOTH this relief and the deck-water solver, so
  // the boards you can see standing proud are the boards the water runs off,
  // and the hollows worn by the capstan are where it pools. Only the B channel
  // (per-board offsets) is read here: the structural channel is real geometry
  // already — coamings, castle steps and the bulwark are pieces, and adding
  // them again as shading relief would double-count them.
  if (tones.deckField !== undefined) {
    const fld = tones.deckField;
    // ship-local, not piece-local: the four deck-family kinds sit at four
    // different origins, and one projection has to serve all of them
    const local = uShipWorldInverse.mul(vec4(positionWorld, 1)).xyz;
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
  // water film loses its grain, so the height field is scaled, not the
  // normal. normalWorldGeometry (NOT normalWorld) — normalWorld resolves to
  // this material's own normalNode, and that node is built from `height`
  // below, so feeding it back here would be a cycle.
  const water = waterLighting({
    worldPos: positionWorld,
    normal: normalWorldGeometry,
    shipLocalPos: uShipWorldInverse.mul(vec4(positionWorld, 1)).xyz,
    mode: 'both',
  });
  color = color.mul(water.tint);
  rough = rough.mul(water.roughnessScale);
  height = height.mul(water.reliefScale);

  material.colorNode = color;
  material.roughnessNode = rough.clamp(0.04, 1);
  material.emissiveNode = water.addLight;
  // relief from the SAME height field — no textures, no tangents, no UVs
  material.normalNode = reliefNormal(height, uBumpScale);

  return {
    material,
    refresh(): void {
      uLight.value.set(tones.light);
      uDark.value.set(tones.dark);
      uGrainScale.value = p.grainScale;
      uGrainStretch.value = p.grainStretch;
      uSharpness.value = p.triplanarSharpness;
      uPlankWidth.value = p.plankWidth;
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
