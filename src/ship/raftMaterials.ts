/**
 * RAFT MATERIALS (§T90) — procedural TSL, tri-planar piece-local like
 * woodMaterial.ts: no image textures, no UVs, so every family binds NOTHING of
 * its own and the §V40 budget is the ship's shared set (wetline + caustics +
 * shadow = 6 samplers; see tests/shipBindingBudget.test.ts, tests/raftMaterials.test.ts).
 *
 * Families (pieceMaterials.FAMILY_OF routes kinds here):
 *   balsa  — log, crossbeam, stern-block, steering-oar, bipod-mast
 *   bamboo — bamboo-deck (mats by default; the lookout platform as slats)
 *   weave  — cabin-wall
 *   thatch — thatch-roof
 *   plank  — guara, splashboard (the wood material in a dark preset)
 *   crate  — crate (pine / jerrycan / drum / dinghy / cage, per piece id)
 *   rope   — lashing (the rings at every crossbeam × log crossing) and the
 *            slack-rope railing along the deck edges (§B87)
 *   radio  — the jury-rigged shortwave, shaded in depth bands (§B87)
 *
 * ONE material per kind, shared between ships (§T.40). Per-piece variation is
 * seeded from the mesh (raftMaterialNodes.ts), never from a second material.
 *
 * Every periodic term is band-limited against ITS OWN width (§V.48, §V.66):
 * rings by ringMask, strip/board edges by bandLimitedEdge, smooth per-period
 * terms (crowns, tone steps) by periodResolved. §V23: functional mix/smoothstep.
 */
import * as THREE from 'three/webgpu';
import { float, mix, normalLocal, positionLocal, uniform, vec2 } from 'three/tsl';
import { bandLimitedEdge, coordFilter, periodResolved } from './bandLimit';
import { hash2, triplanarFbm } from '../terrain/noise';
import type { PieceKind } from './pieceTypes';
import { raftMaterialParams, type RaftMaterialParams } from '../params/raftMaterials';
import { shipMaterialParams, type ShipMaterialParams } from '../params/ship';
import { createRaftPieceUniforms, faceness, gateAbove, shipWater, type AnyNode } from './raftMaterialNodes';
import { createBalsaMaterial } from './raftMaterialsBalsa';
import { createThatchMaterial, createWeaveMaterial } from './raftMaterialsWeave';
import { createWoodMaterial, type LocalFrame, type ShipMaterialHandle } from './woodMaterial';

export {
  BALSA_AXIS,
  balsaContrastStretch,
  balsaCreviceAt,
  balsaEndness,
  balsaGrooveAt,
  balsaLuminance,
  balsaToneRange,
  balsaWeedBand,
  balsaWetBand,
  createBalsaMaterial,
  crossbeamStation0,
  type BalsaToneRange,
} from './raftMaterialsBalsa';
export { bambooDeckVariantOf, createThatchMaterial, createWeaveMaterial } from './raftMaterialsWeave';

export type RaftFamily = 'balsa' | 'bamboo' | 'weave' | 'thatch' | 'plank' | 'crate' | 'rope' | 'radio';


/**
 * Crate variants, keyed on the piece ids raftPartsCabin.ts authors. §B87 added
 * ONE look (`card`) and gave three more ids a home in looks that already
 * existed, rather than a lane each: the pots and the ladle by the door are the
 * same thin dark iron as the parrot cage, and a battery case is the same dull
 * plastic as a jerrycan.
 */
export const CRATE_VARIANT = { pine: 0, jerrycan: 1, drum: 2, dinghy: 3, cage: 4, card: 5 } as const;

export function crateVariantOf(pieceId: string): number {
  if (pieceId === 'rain-drum') return CRATE_VARIANT.drum;
  if (pieceId === 'dinghy') return CRATE_VARIANT.dinghy;
  if (pieceId === 'cage') return CRATE_VARIANT.cage;
  if (pieceId.startsWith('jerrycan') || pieceId.startsWith('battery-')) return CRATE_VARIANT.jerrycan;
  if (pieceId.startsWith('pot-') || pieceId === 'ladle') return CRATE_VARIANT.cage;
  if (pieceId === 'radio-partition' || pieceId === 'chart') return CRATE_VARIANT.card;
  return CRATE_VARIANT.pine;
}



// ---------------------------------------------------------------------------

/** 2100 dressing — one material, five looks, chosen per piece id */
export function createCrateMaterial(
  frame?: LocalFrame,
  p: RaftMaterialParams = raftMaterialParams,
): ShipMaterialHandle {
  const material = new THREE.MeshStandardNodeMaterial();
  const uPine = uniform(new THREE.Color(p.cratePine));
  const uKhaki = uniform(new THREE.Color(p.crateKhaki));
  const uBoard = uniform(p.crateBoardWidth);
  const uJerrycan = uniform(new THREE.Color(p.jerrycanColor));
  const uDrum = uniform(new THREE.Color(p.drumColor));
  const uDinghy = uniform(new THREE.Color(p.dinghyColor));
  const uPatch = uniform(p.dinghyPatch);
  const uCage = uniform(new THREE.Color(p.cageColor));
  const uCard = uniform(new THREE.Color(p.crateCard));
  const piece = createRaftPieceUniforms({ variantOf: crateVariantOf });

  const w = (k: number): AnyNode => float(1).sub(piece.variant.sub(k).abs()).clamp(0, 1);
  const wPine = w(CRATE_VARIANT.pine);
  const wJerry = w(CRATE_VARIANT.jerrycan);
  const wDrum = w(CRATE_VARIANT.drum);
  const wDinghy = w(CRATE_VARIANT.dinghy);
  const wCage = w(CRATE_VARIANT.cage);
  const wCard = w(CRATE_VARIANT.card);

  const pos = positionLocal;
  const noise = triplanarFbm(pos.mul(6), normalLocal, float(6), 3);

  // pine crate: boards across the face, or a khaki ration box by seed
  const upness = faceness(normalLocal.y);
  const bc = mix(pos.y, pos.x, upness).div(uBoard);
  const bf = mix(coordFilter(pos.y), coordFilter(pos.x), upness).div(uBoard);
  const bfr = bc.fract();
  const seam = bandLimitedEdge(bfr.min(bfr.oneMinus()), bc, float(0.06), bf);
  const boardTone = hash2(vec2(bc.floor(), 5.1)).sub(0.5).mul(0.16).mul(periodResolved(bc, bf));
  const khaki = gateAbove(piece.seed, 0.55);
  const pineBoards = uPine.mul(float(1).add(boardTone)).mul(mix(float(0.6), float(1), seam)).mul(mix(float(0.9), float(1.1), noise));
  const pine = mix(pineBoards, uKhaki.mul(mix(float(0.92), float(1.05), noise)), khaki);
  // dull plastics: smooth, a little scuffed
  const scuff = mix(float(0.94), float(1.04), noise);
  const jerrycan = uJerrycan.mul(scuff);
  const drum = uDrum.mul(scuff);
  // faded yellow rubber with darker patches
  const patch = triplanarFbm(pos.mul(1.8), normalLocal, float(6), 2).sub(0.55).mul(6).clamp(0, 1);
  const dinghy = uDinghy.mul(mix(float(1), float(1).sub(uPatch), patch)).mul(scuff);
  // thin iron, pitted (fittingMaterials' look) — the cage, and the pots and
  // ladle hanging by the cabin door
  const cage = uCage.mul(mix(float(0.7), float(1.2), noise));
  // salvaged cardboard: the radio corner's partition and the chart on the
  // wall. Soft and blotchy, no board seams — it is not a crate.
  const card = uCard.mul(mix(float(0.82), float(1.1), noise));

  const color = pine
    .mul(wPine)
    .add(jerrycan.mul(wJerry))
    .add(drum.mul(wDrum))
    .add(dinghy.mul(wDinghy))
    .add(cage.mul(wCage))
    .add(card.mul(wCard));
  const rough = float(0.85)
    .mul(wPine)
    .add(float(0.5).mul(wJerry))
    .add(float(0.38).mul(wDrum))
    .add(float(0.62).mul(wDinghy))
    .add(mix(float(0.45), float(0.8), noise).mul(wCage))
    .add(float(0.95).mul(wCard));

  const water = shipWater(frame);
  material.colorNode = color.mul(water.tint);
  material.roughnessNode = rough.mul(water.roughnessScale).clamp(0.04, 1);
  material.metalnessNode = wCage.mul(0.65);
  material.emissiveNode = water.addLight;
  material.aoNode = float(1).sub(seam.oneMinus().mul(wPine).mul(khaki.oneMinus()).mul(0.5));

  return {
    material,
    refresh(): void {
      uPine.value.set(p.cratePine);
      uKhaki.value.set(p.crateKhaki);
      uBoard.value = p.crateBoardWidth;
      uJerrycan.value.set(p.jerrycanColor);
      uDrum.value.set(p.drumColor);
      uDinghy.value.set(p.dinghyColor);
      uPatch.value = p.dinghyPatch;
      uCage.value.set(p.cageColor);
      uCard.value.set(p.crateCard);
    },
  };
}

// ---------------------------------------------------------------------------

/**
 * Dark weathered plank = the ship's wood material with the raft's tones and a
 * board width scaled to the piece (§V66: a 0.6 m guara is not laid in 0.55 m
 * hull strakes). The override object inherits every other knob LIVE from
 * shipMaterialParams through its prototype, and reads the width live too.
 */
export function createPlankMaterial(
  frame?: LocalFrame,
  p: RaftMaterialParams = raftMaterialParams,
): ShipMaterialHandle {
  // THE RELIEF SCALES WITH THE BOARD (§B70). plankRelief / plankTilt / the
  // plateau step / the seam depth are metres of height over ONE board; keep
  // them at the galleon's values on a board 0.2 m wide instead of 0.55 and
  // every slope is 2.75× steeper, the shading normal tips past the horizon
  // and the guaras and splashboards rendered as black-and-white bar codes.
  // Same slopes, narrower boards: every height is scaled by the width ratio —
  // and then by `plankReliefScale`, because a guara stands EDGE-ON to the sun:
  // at N·L ≈ 0 the galleon's ±40° board swing tips half the boards into the
  // sun and half out of it, a bar code of white and black (measured: zeroing
  // bumpScale alone removed it, and a 3× reduction did not — at grazing
  // incidence ANY tilt is binary lit/unlit). On a sunlit hull the same swing
  // only modulates; a 25 mm fir plank is honestly flat, so the relief is
  // all but retired and the boards stay legible through their colour jitter.
  const ratio = (): number => (p.plankWidth / Math.max(1e-3, shipMaterialParams.plankWidth)) * p.plankReliefScale;
  const scaled = (key: keyof ShipMaterialParams): PropertyDescriptor => ({
    get: () => (shipMaterialParams[key] as number) * ratio(),
    enumerable: true,
  });
  const overrides: ShipMaterialParams = Object.create(shipMaterialParams, {
    plankWidth: { get: () => p.plankWidth, enumerable: true },
    plankRelief: scaled('plankRelief'),
    plankTilt: scaled('plankTilt'),
    plankStep: scaled('plankStep'),
    plankChamfer: scaled('plankChamfer'),
    seamDepth: scaled('seamDepth'),
    plankWander: scaled('plankWander'),
  });
  return createWoodMaterial(
    { light: p.plankLight, dark: p.plankDark, wale: false, waterline: false },
    frame,
    overrides,
  );
}

/**
 * Lashings: three-strand hemp, tan gone grey-brown [§7 Rope]. The ring
 * geometry carries the turns; here the lay is a noise-darkened strand
 * pattern, so there is no periodic term to band-limit (§V.48) and nothing
 * bound (§V40). The rig's running rope (src/ropes) is compute-driven and
 * cannot be shared with a static piece, which is why this exists.
 */
export function createLashingMaterial(
  frame?: LocalFrame,
  p: RaftMaterialParams = raftMaterialParams,
): ShipMaterialHandle {
  const material = new THREE.MeshStandardNodeMaterial();
  material.metalness = 0;
  const uTan = uniform(new THREE.Color(p.ropeTan));
  const uDark = uniform(new THREE.Color(p.ropeDark));
  const piece = createRaftPieceUniforms();
  const pos = positionLocal;
  // the lay: fine fbm stretched round the ring reads as strands at 1–3 m,
  // and is a plain mid-tone beyond — fbm's own octaves are its band limit
  const lay = triplanarFbm(pos.mul(40).add(piece.seed.mul(13)), normalLocal, float(6), 2);
  const fuzz = triplanarFbm(pos.mul(9), normalLocal, float(6), 2);
  const color = mix(uDark, uTan, lay.mul(0.7).add(fuzz.mul(0.3)));
  const water = shipWater(frame);
  material.colorNode = color.mul(water.tint);
  material.roughnessNode = float(0.92).mul(water.roughnessScale).clamp(0.04, 1);
  material.emissiveNode = water.addLight;
  return {
    material,
    refresh(): void {
      uTan.value.set(p.ropeTan);
      uDark.value.set(p.ropeDark);
    },
  };
}

/**
 * §B87 THE RADIO — the one prop in this game a player looks AT rather than
 * past, so it gets its own tiny family instead of a sixth crate colour.
 *
 * IT IS SHADED BY DEPTH, and that is a CONTRACT with `buildRadioGeometry`
 * (pieceGeometryRaft.ts), which lays the parts out in three bands of the
 * case's own depth: the body behind `radioFacePlane`, the pale salvaged face
 * plate + dial disc + meter glass between the two planes, and the dark
 * furniture that stands proud of them — knob, both needles, the LED — in
 * front of `radioTrimPlane`. Depth, not a second material and not a texture:
 * the piece's own geometry bounds arrive as uniforms (raftMaterialNodes), so
 * one shader draws a two-tone instrument and the §V40 budget is untouched.
 *
 * The LED is picked out of that front band by its CORNER (top starboard, the
 * only thing up there), and it is emissive: in a cabin at noon an unlit red
 * dot is invisible, and "the set is alive" is the whole point of it.
 */
export function createRadioMaterial(
  frame?: LocalFrame,
  p: RaftMaterialParams = raftMaterialParams,
): ShipMaterialHandle {
  const material = new THREE.MeshStandardNodeMaterial();
  const uCase = uniform(new THREE.Color(p.radioCase));
  const uFace = uniform(new THREE.Color(p.radioFace));
  const uTrim = uniform(new THREE.Color(p.radioTrim));
  const uLed = uniform(new THREE.Color(p.radioLed));
  const uLedGain = uniform(p.radioLedGain);
  const uFacePlane = uniform(p.radioFacePlane);
  const uTrimPlane = uniform(p.radioTrimPlane);
  const piece = createRaftPieceUniforms();

  const pos = positionLocal;
  const ext = piece.aabbMax.sub(piece.aabbMin).max(1e-3);
  const f = pos.sub(piece.aabbMin).div(ext); // 0..1 in the piece's own box
  // the two depth planes: clamped ramps, so a fragment a millimetre either
  // side of a plane blends rather than steps (§V23)
  const onPlate = f.z.sub(uFacePlane).div(float(1).sub(uFacePlane).max(1e-3)).clamp(0, 1);
  const onTrim = f.z.sub(uTrimPlane).div(float(1).sub(uTrimPlane).max(1e-3)).mul(2).clamp(0, 1);
  // the LED: the front band, top starboard corner, and nothing else is there
  const led = onTrim.mul(f.x.sub(0.88).mul(25).clamp(0, 1)).mul(f.y.sub(0.84).mul(25).clamp(0, 1));

  const scuff = triplanarFbm(pos.mul(24), normalLocal, float(6), 3);
  let color: AnyNode = mix(uCase, uFace, onPlate);
  color = mix(color, uTrim, onTrim);
  color = color.mul(mix(float(0.88), float(1.08), scuff));
  color = mix(color, uLed, led);

  const water = shipWater(frame);
  material.colorNode = color.mul(water.tint);
  // a plastic face plate is smoother than the scratched metal case
  material.roughnessNode = mix(float(0.62), float(0.34), onPlate).mul(water.roughnessScale).clamp(0.04, 1);
  material.metalnessNode = onPlate.oneMinus().mul(0.35).add(onTrim.mul(0.4));
  material.emissiveNode = water.addLight.add(uLed.mul(led).mul(uLedGain));

  return {
    material,
    refresh(): void {
      uCase.value.set(p.radioCase);
      uFace.value.set(p.radioFace);
      uTrim.value.set(p.radioTrim);
      uLed.value.set(p.radioLed);
      uLedGain.value = p.radioLedGain;
      uFacePlane.value = p.radioFacePlane;
      uTrimPlane.value = p.radioTrimPlane;
    },
  };
}

/** the factory pieceMaterials.ts routes the raft families through */
export function createRaftMaterial(
  family: RaftFamily,
  kind: PieceKind,
  frame?: LocalFrame,
): ShipMaterialHandle {
  switch (family) {
    case 'balsa':
      return createBalsaMaterial(kind, frame);
    case 'bamboo':
      return createWeaveMaterial(true, frame);
    case 'weave':
      return createWeaveMaterial(false, frame);
    case 'thatch':
      return createThatchMaterial(frame);
    case 'plank':
      return createPlankMaterial(frame);
    case 'crate':
      return createCrateMaterial(frame);
    case 'rope':
      return createLashingMaterial(frame);
    case 'radio':
      return createRadioMaterial(frame);
  }
}
