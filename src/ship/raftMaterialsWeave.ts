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

  // over/under as a SMOOTH checker, zero on every strip edge, so the height
  // field never steps where the parity flips (§B.20: a step differentiates to
  // a spike). Slats force the u-strips on top everywhere.
  const checker = sin(cu.mul(Math.PI)).mul(sin(cv.mul(Math.PI)));
  const overU = mix(checker.max(0), float(1), variant);
  const overV = checker.negate().max(0).mul(variant.oneMinus());
  // @band-limited-elsewhere: smooth crowns, gated on the period by `resolved` (periodResolved)
  const crownU = sin(cu.fract().mul(Math.PI));
  const crownV = sin(cv.fract().mul(Math.PI));
  let height: AnyNode = crownU.mul(overU).add(crownV.mul(overV)).mul(uRelief).mul(resolved);

  // strip edges, each measured against the EDGE width (§V.48, §B.20)
  // @band-limited-elsewhere: both feed bandLimitedEdge two lines down
  const du = cu.fract();
  const dv = cv.fract();
  const edgeU = bandLimitedEdge(du.min(du.oneMinus()), cu, uEdge, fcu);
  const edgeVraw = bandLimitedEdge(dv.min(dv.oneMinus()), cv, uEdge, fcv);
  const edgeV = mix(edgeVraw, float(1), variant);
  const gap = edgeU.min(edgeV).oneMinus();

  // per-strip tone, a per-period step gated on the period (§V.48)
  const toneU = hash2(vec2(cu.floor(), 11.3));
  const toneV = hash2(vec2(cv.floor(), 23.7));
  const tone = mix(toneV, toneU, overU.clamp(0, 1)).sub(0.5).mul(2).mul(uToneVar).mul(resolved);

  const weather = triplanarFbm(pos.mul(1.4), normalLocal, float(6), 3);
  const matColor = mix(uDark, uTan, weather.mul(0.5).add(0.4));
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
