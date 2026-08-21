/**
 * WEAVE, BAMBOO and THATCH (§T90): the cabin's plaited split-bamboo walls,
 * the deck mats (with the lookout platform as canes with node rings), and the
 * roof's layered dry leaves. Per-piece inputs from raftMaterialNodes.ts; every
 * periodic term band-limited against its own width (§V.48/§V.66) and smooth
 * per-period terms gated on the period (§V.70). §V23: functional mix/smoothstep.
 */
import * as THREE from 'three/webgpu';
import { cross, float, mix, normalLocal, positionLocal, sin, uniform, vec2, vec3 } from 'three/tsl';
import { bandLimitedEdge, coordFilter, periodResolved } from './bandLimit';
import { fbm2, hash2, triplanarFbm } from '../terrain/noise';
import { reliefNormal } from './surfaceRelief';
import { raftMaterialParams, type RaftMaterialParams } from '../params/raftMaterials';
import { createRaftPieceUniforms, faceness, ringMask, shipWater, type AnyNode } from './raftMaterialNodes';
import type { LocalFrame, ShipMaterialHandle } from './woodMaterial';

/** 0 = plaited mat (deck slabs, cabin floor), 1 = split-bamboo slats (lookout platform) */
export function bambooDeckVariantOf(pieceId: string): number {
  return pieceId === 'lookout-platform' ? 1 : 0;
}

/**
 * Plaited split-bamboo: walls and mats. `slats` = true builds the bamboo-deck
 * family, whose lookout platform (variant 1) is canes side by side with node
 * rings instead of a weave.
 */
export function createWeaveMaterial(
  slats: boolean,
  frame?: LocalFrame,
  p: RaftMaterialParams = raftMaterialParams,
): ShipMaterialHandle {
  const material = new THREE.MeshStandardNodeMaterial();
  material.metalness = 0;
  const uTan = uniform(new THREE.Color(p.weaveTan));
  const uDark = uniform(new THREE.Color(p.weaveDark));
  const uYellow = uniform(new THREE.Color(p.bambooYellow));
  const uGreen = uniform(new THREE.Color(p.bambooGreen));
  const uStrip = uniform(p.weaveStrip);
  const uBlock = uniform(Math.max(1, p.weaveBlock));
  const uSlat = uniform(p.bambooSlatWidth);
  const uEdge = uniform(p.weaveEdge);
  const uRelief = uniform(p.weaveRelief);
  const uToneVar = uniform(p.weaveToneVar);
  const uNodePitch = uniform(p.bambooNodePitch);
  const uNodeWidth = uniform(p.bambooNodeWidth);
  const uRough = uniform(p.weaveRough);
  const uBump = uniform(p.weaveBump);
  const piece = createRaftPieceUniforms(slats ? { variantOf: bambooDeckVariantOf } : {});
  const variant: AnyNode = slats ? piece.variant.clamp(0, 1) : float(0);

  // the two in-plane coordinates of whichever box face this is (see
  // woodMaterial's upness blend; footprints blended, not differentiated —
  // bandLimit.ts on `filterOverride`)
  const pos = positionLocal;
  const upness = faceness(normalLocal.y);
  const xness = faceness(normalLocal.x);
  const u = mix(pos.x, pos.z, xness);
  const v = mix(pos.y, pos.z, upness);
  const fu = mix(coordFilter(pos.x), coordFilter(pos.z), xness);
  const fv = mix(coordFilter(pos.y), coordFilter(pos.z), upness);

  const width = mix(uStrip, uSlat, variant);
  const cu = u.div(width);
  const cv = v.div(width);
  const fcu = fu.div(width);
  const fcv = fv.div(width);
  const resolved = periodResolved(cu, fcu).min(periodResolved(cv, fcv));

  // BASKET WEAVE IN BLOCKS, not a per-strand checker (§B70). The museum walls
  // [PHOTO-04,08] are plaited in checks of ~5 strands: inside a block every
  // strand runs one way, the next block the other. A per-strand over/under
  // (the previous form) is a 9 cm period that is sub-pixel from 10 m — all
  // the read there was a moiré — while a 22 cm check is exactly the scale
  // the reference shows at 10–30 m. `overU` = the block whose strands run
  // along u; a smooth sin product so the height never steps at a parity
  // flip (§B.20), faded to its mean ½ once a block is sub-pixel (§V.48b).
  const bu = cu.div(uBlock);
  const bv = cv.div(uBlock);
  const fbu = fcu.div(uBlock);
  const fbv = fcv.div(uBlock);
  const blockResolved = periodResolved(bu, fbu).min(periodResolved(bv, fbv));
  // @band-limited-elsewhere: smooth block parity, faded to its mean by blockResolved (periodResolved)
  const parity = sin(bu.mul(Math.PI)).mul(sin(bv.mul(Math.PI))).mul(6).clamp(-1, 1).mul(0.5).add(0.5);
  const overWeave = mix(float(0.5), parity, blockResolved);
  const overU = mix(overWeave, float(1), variant); // slats: every cane runs along u
  const overV = overU.oneMinus();
  // a strand running along u is crowned ACROSS v, and vice versa
  // @band-limited-elsewhere: smooth crowns, gated on the period by `resolved` (periodResolved)
  const crownU = sin(cu.fract().mul(Math.PI));
  const crownV = sin(cv.fract().mul(Math.PI));
  let height: AnyNode = crownV.mul(overU).add(crownU.mul(overV)).mul(uRelief).mul(resolved);

  // strand edges, each measured against the EDGE width (§V.48, §B.20): the
  // visible edges are those of the strands on TOP, plus the block boundary
  // where a strand dives under its neighbour
  // @band-limited-elsewhere: both feed bandLimitedEdge below
  const du = cu.fract();
  const dv = cv.fract();
  // @band-limited-elsewhere: both feed bandLimitedEdge below
  const dbu = bu.fract();
  const dbv = bv.fract();
  const edgeU = bandLimitedEdge(du.min(du.oneMinus()), cu, uEdge, fcu);
  const edgeV = bandLimitedEdge(dv.min(dv.oneMinus()), cv, uEdge, fcv);
  const blockEdge = bandLimitedEdge(dbu.min(dbu.oneMinus()), bu, uEdge.div(uBlock), fbu)
    .min(bandLimitedEdge(dbv.min(dbv.oneMinus()), bv, uEdge.div(uBlock), fbv));
  const strandGap = mix(edgeU, edgeV, overU).oneMinus();
  const gap = strandGap.max(blockEdge.oneMinus().mul(variant.oneMinus()));

  // per-strand tone, a per-period step gated on the period (§V.48): a strand
  // along u is indexed by its v row
  const toneAlongU = hash2(vec2(cv.floor(), 11.3));
  const toneAlongV = hash2(vec2(cu.floor(), 23.7));
  const tone = mix(toneAlongV, toneAlongU, overU.clamp(0, 1)).sub(0.5).mul(2).mul(uToneVar).mul(resolved);

  const weather = triplanarFbm(pos.mul(1.4), normalLocal, float(6), 3);
  const matColor = mix(uDark, uTan, weather.mul(0.4).add(0.55));
  // bamboo: yellow with green-grey streaks along the cane
  const streak = fbm2(vec2(cu.mul(0.7), v.mul(3)), 2);
  const caneColor = mix(uYellow, uGreen, streak.sub(0.3).mul(0.8).clamp(0, 1));
  let color: AnyNode = mix(matColor, caneColor, variant).mul(float(1).add(tone));
  color = color.mul(mix(float(1), float(0.55), gap));

  // node rings along the canes (slats only), phase wandering smoothly per cane
  const ring = ringMask(v, uNodePitch, uNodeWidth, sin(cu.mul(1.7)).mul(0.25).mul(uNodePitch)).oneMinus().mul(variant);
  color = color.mul(mix(float(1), float(0.8), ring));
  height = height.add(ring.mul(0.003));

  const water = shipWater(frame);
  material.colorNode = color.mul(water.tint);
  material.roughnessNode = uRough.add(weather.mul(0.12)).sub(variant.mul(0.2)).mul(water.roughnessScale).clamp(0.04, 1);
  material.emissiveNode = water.addLight;
  material.aoNode = float(1).sub(gap.mul(0.5));
  material.normalNode = reliefNormal(height, uBump.mul(water.reliefScale));

  return {
    material,
    refresh(): void {
      uTan.value.set(p.weaveTan);
      uDark.value.set(p.weaveDark);
      uYellow.value.set(p.bambooYellow);
      uGreen.value.set(p.bambooGreen);
      uStrip.value = p.weaveStrip;
      uBlock.value = Math.max(1, p.weaveBlock);
      uSlat.value = p.bambooSlatWidth;
      uEdge.value = p.weaveEdge;
      uRelief.value = p.weaveRelief;
      uToneVar.value = p.weaveToneVar;
      uNodePitch.value = p.bambooNodePitch;
      uNodeWidth.value = p.bambooNodeWidth;
      uRough.value = p.weaveRough;
      uBump.value = p.weaveBump;
    },
  };
}
// ---------------------------------------------------------------------------

export function createThatchMaterial(
  frame?: LocalFrame,
  p: RaftMaterialParams = raftMaterialParams,
): ShipMaterialHandle {
  const material = new THREE.MeshStandardNodeMaterial();
  material.metalness = 0;
  const uLight = uniform(new THREE.Color(p.thatchLight));
  const uDark = uniform(new THREE.Color(p.thatchDark));
  const uUnder = uniform(p.thatchUnder);
  const uRowPitch = uniform(p.thatchRowPitch);
  const uRowEdge = uniform(p.thatchRowEdge);
  const uRagged = uniform(p.thatchRowRagged);
  const uStrandScale = uniform(p.thatchStrandScale);
  const uStrandStretch = uniform(p.thatchStrandStretch);
  const uRelief = uniform(p.thatchRelief);
  const uBump = uniform(p.thatchBump);
  const piece = createRaftPieceUniforms();

  // strands run DOWN the slope: world down, expressed in piece axes per object
  const pos = positionLocal;
  const down = piece.downLocal;
  const acrossRaw = cross(down, vec3(0, 1, 0));
  const across = acrossRaw.div(acrossRaw.length().max(1e-3));
  const along = pos.dot(down); // metres down the slope
  const side = pos.dot(across); // metres along the ridge

  const strandPos = vec2(side.mul(uStrandScale), along.mul(uStrandScale).div(uStrandStretch));
  const strand = fbm2(strandPos, 3);
  const strandResolved = periodResolved(float(0), coordFilter(strandPos.x).max(coordFilter(strandPos.y)).mul(4));

  // courses of leaves, each edge wandering a little, overlapping down the slope
  const wander = fbm2(vec2(side.mul(2), piece.seed.mul(31)), 2).sub(0.5).mul(uRagged);
  const rowCoord = along.add(wander).div(uRowPitch.max(0.05));
  const rowFilter = coordFilter(along).div(uRowPitch.max(0.05));
  const rowResolved = periodResolved(rowCoord, rowFilter);
  // the shadow line just down-slope of each course's edge, measured in metres
  const pastEdge = rowCoord.fract().mul(uRowPitch);
  const rowShade = bandLimitedEdge(pastEdge, along, uRowEdge).oneMinus();
  const rowTone = hash2(vec2(rowCoord.floor(), piece.seed.mul(53))).sub(0.5).mul(0.16).mul(rowResolved);
  const rowCrown = sin(rowCoord.fract().mul(Math.PI)).mul(rowResolved);

  let color: AnyNode = mix(uDark, uLight, strand.mul(0.8).add(0.1)).mul(float(1).add(rowTone));
  color = color.mul(mix(float(1), float(0.6), rowShade));
  // the overhang's underside, and the ragged eave end
  const under = normalLocal.y.negate().clamp(0, 1);
  color = color.mul(mix(float(1), uUnder, under));
  const ext = piece.aabbMax.sub(piece.aabbMin).mul(0.5);
  const centreAlong = piece.aabbMax.add(piece.aabbMin).mul(0.5).dot(down);
  const eaveDist = ext.dot(down.abs()).sub(along.sub(centreAlong));
  const eave = float(1).sub(eaveDist.mul(5)).clamp(0, 1).mul(strand);
  color = mix(color, uDark, eave.mul(0.6));

  const height = strand
    .sub(0.5)
    .mul(uRelief)
    .mul(strandResolved)
    .add(rowCrown.mul(uRelief).mul(0.8))
    .sub(rowShade.mul(uRelief).mul(0.5));

  const water = shipWater(frame);
  material.colorNode = color.mul(water.tint);
  material.roughnessNode = float(0.9).add(strand.mul(0.08)).mul(water.roughnessScale).clamp(0.04, 1);
  material.emissiveNode = water.addLight;
  material.aoNode = float(1).sub(rowShade.mul(0.4)).sub(under.mul(0.25));
  material.normalNode = reliefNormal(height, uBump.mul(water.reliefScale));

  return {
    material,
    refresh(): void {
      uLight.value.set(p.thatchLight);
      uDark.value.set(p.thatchDark);
      uUnder.value = p.thatchUnder;
      uRowPitch.value = p.thatchRowPitch;
      uRowEdge.value = p.thatchRowEdge;
      uRagged.value = p.thatchRowRagged;
      uStrandScale.value = p.thatchStrandScale;
      uStrandStretch.value = p.thatchStrandStretch;
      uRelief.value = p.thatchRelief;
      uBump.value = p.thatchBump;
    },
  };
}
