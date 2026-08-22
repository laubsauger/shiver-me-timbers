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
import { createRaftPieceUniforms, faceness, gateAbove, ringMask, shipWater, type AnyNode } from './raftMaterialNodes';
import type { LocalFrame, ShipMaterialHandle } from './woodMaterial';

/**
 * 0 = plaited mat (deck slabs, cabin floor, the loose mats over it),
 * 1 = split-bamboo canes (lookout platform, and §B87's roof laths — canes
 *     side by side, which is what a lath course is),
 * 2 = §B87 straw-mattress ticking (the two berths) — the same plait at a
 *     coarser strip, in broad stripes [§3 Museum "striped mattress"].
 */
export function bambooDeckVariantOf(pieceId: string): number {
  if (pieceId === 'lookout-platform' || pieceId.startsWith('roof-lath')) return 1;
  if (pieceId.startsWith('berth-')) return 2;
  return 0;
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
  const uTickLight = uniform(new THREE.Color(p.tickLight));
  const uTickDark = uniform(new THREE.Color(p.tickDark));
  const uTickStrip = uniform(p.tickStrip);
  const uTickBlock = uniform(Math.max(1, p.tickBlock));
  const piece = createRaftPieceUniforms(slats ? { variantOf: bambooDeckVariantOf } : {});
  // THREE looks off ONE integer (§T.40: one material per kind, shared). Each
  // weight is a tent at its own variant index, so a piece that carries none of
  // them (a cabin wall, which never gets the variantOf hook) sits on 0 = mat.
  const vId: AnyNode = slats ? piece.variant : float(0);
  const variant: AnyNode = float(1).sub(vId.sub(1).abs()).clamp(0, 1); // canes
  const wTick: AnyNode = float(1).sub(vId.sub(2).abs()).clamp(0, 1); // ticking

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

  // the strip a look is woven from: split bamboo, a cane, or mattress ticking
  const width = mix(mix(uStrip, uSlat, variant), uTickStrip, wTick);
  const cu = u.div(width);
  const cv = v.div(width);
  const fcu = fu.div(width);
  const fcv = fv.div(width);
  const resolved = periodResolved(cu, fcu).min(periodResolved(cv, fcv));

  // BASKET WEAVE IN CHECKS of `weaveBlock` strands: inside a check every
  // strand runs one way, the next check the other. `overU` = the check whose
  // strands run along u; a smooth sin product so the height never steps at a
  // parity flip (§B.20), faded to its mean ½ once a check is sub-pixel (§V.48b).
  //
  // §T129c — THE CHECK IS ONE STRAND WIDE AGAIN, i.e. a plain over-under
  // plait. §B70 widened it to five because a per-strand parity was a 9 cm
  // period going sub-pixel from 10 m and all that survived was a moiré — but
  // the cure for THAT is the band-limit, and `blockResolved` below is now it:
  // the parity fades to a flat ½ the moment a check stops resolving, so it
  // cannot moiré at any range. What the five bought instead was a 22.5 cm
  // repeat, and [§3 Walls] gives the cabin ONE dimension — the 4–5 cm split
  // bamboo strip. The user photographed the difference: "the wall reads as
  // stacked crates, not woven cane" (§V66 — a feature is scaled by its own
  // dimension, and the check's own dimension is the strand it is made of).
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
  // …and a check ONE strand wide has no boundary of its own: `blockEdge` would
  // then be the strand grid a second time, and darkening BOTH axes everywhere
  // turns the plait into a lattice — only the strand on TOP shows its gap.
  const checked = uBlock.sub(1).clamp(0, 1);
  const gap = strandGap.max(blockEdge.oneMinus().mul(variant.oneMinus()).mul(checked));

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
  // §B87 straw-mattress ticking: broad woven stripes, `tickBlock` strips to a
  // stripe, the stripe chosen by a hash of the block index so the bands are
  // uneven the way a hand-loomed tick is. Faded to its mean by `resolved`
  // once a strip is sub-pixel, like every other per-period step here (§V48b).
  const stripe = gateAbove(hash2(vec2(cv.div(uTickBlock).floor(), 7.7)), 0.45).mul(resolved);
  const tickColor = mix(uTickLight, uTickDark, stripe);
  let color: AnyNode = mix(mix(matColor, caneColor, variant), tickColor, wTick).mul(float(1).add(tone));
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
      uTickLight.value.set(p.tickLight);
      uTickDark.value.set(p.tickDark);
      uTickStrip.value = p.tickStrip;
      uTickBlock.value = Math.max(1, p.tickBlock);
    },
  };
}
// ---------------------------------------------------------------------------

/**
 * §T129 — THE DOWN-SLOPE AXIS of a pitched slab, and the ridge axis across it,
 * from SHIP-FRAME DOWN expressed in the slab's own axes (`piece.downRest`).
 * CPU mirror of the three node lines at the head of
 * {@link createThatchMaterial}, in the same spirit as `periodResolvedValue`:
 * the node graph belongs to the GPU, the contract it has to keep is testable
 * here.
 *
 * §T134/§B99 — THE INPUT MUST BE THE SHIP'S DOWN, NOT THE WORLD'S. This
 * function is a near-degenerate projection: it throws away the component
 * through the face, and on an 11.77° roof only 0.204 of the input survives
 * that. Feed it a live world vector and 15° of pitch swings the axis it
 * returns by 52.8°, 15° of heel flips it end for end, and the entire pattern
 * rides the swell. `shipFrameDown` (raftMaterialNodes.ts) is the vector that
 * makes the answer a constant of the PIECE; the attitude-invariance test in
 * tests/raftMaterials.test.ts is the witness that keeps it one.
 *
 * WHY IT IS NOT THAT VECTOR ITSELF — the earlier defect. Every
 * thatch piece is a slab whose local +y is its face normal, so world down
 * splits into a component lying ALONG the face (the axis a course of leaves is
 * laid against, and the only one that means anything to the pattern) and one
 * going THROUGH it. On a slab pitched at θ the first is sin θ of the whole: at
 * the cabin roof's 11.8° that is 0.204, so `positionLocal.dot(downRest)`
 * advanced 0.20 m per metre travelled down the slope and every course line,
 * strand and eave band came out 4.9× too long — a shadow smeared the length of
 * the roof instead of a course every 12 cm. §V66: scale a feature by its OWN
 * dimension, and this feature's dimension is the metre down the SLOPE.
 *
 * A slab with NO pitch has no down-slope axis at all, and both vectors come
 * back zero rather than pointing somewhere arbitrary — the pattern goes flat,
 * which is the honest answer to "which way do the leaves run" on the flat.
 */
export function thatchSlopeAxes(downRest: THREE.Vector3): { along: THREE.Vector3; across: THREE.Vector3 } {
  const along = new THREE.Vector3(downRest.x, 0, downRest.z);
  along.divideScalar(Math.max(1e-4, along.length()));
  const across = new THREE.Vector3().crossVectors(along, new THREE.Vector3(0, 1, 0));
  across.divideScalar(Math.max(1e-3, across.length()));
  return { along, across };
}

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
  const uTileWidth = uniform(p.thatchTileWidth);
  const uStagger = uniform(p.thatchTileStagger);
  const piece = createRaftPieceUniforms();

  // strands run DOWN THE SLOPE — the slab's own axis, ⊥ down the WORLD. These
  // four lines are {@link thatchSlopeAxes}; read its docstring for why the
  // difference is a 4.9× stretch of everything below (§T129a, §V66), and why
  // the vector fed in is the SHIP's down and not the sea's (§T134/§B99).
  const pos = positionLocal;
  const alongRaw = piece.downRest.mul(vec3(1, 0, 1));
  const down = alongRaw.div(alongRaw.length().max(1e-4));
  const acrossRaw = cross(down, vec3(0, 1, 0));
  const across = acrossRaw.div(acrossRaw.length().max(1e-3));
  const along = pos.dot(down); // metres down the slope
  const side = pos.dot(across); // metres along the ridge

  const strandPos = vec2(side.mul(uStrandScale), along.mul(uStrandScale).div(uStrandStretch));
  const strand = fbm2(strandPos, 3);
  const strandResolved = periodResolved(float(0), coordFilter(strandPos.x).max(coordFilter(strandPos.y)).mul(4));

  // §B87 — LEAVES LAID LIKE TILES, not stripes ruled across the slope.
  // The geometry now carries the COURSES (raftParams.roofCoursePitch, ~0.30 m,
  // real steps that self-shadow at a grazing sun); what is left for the
  // material is the individual leaf inside a course, and a leaf is a tile of
  // finite WIDTH. Each tile column gets its own offset of the row line, so the
  // shadow line breaks every `thatchTileWidth` instead of running the whole
  // ridge — which is exactly the difference between "thatch" and "corduroy".
  // A hash per tile column: a per-cell step, so it is faded to its mean by the
  // tile's own `periodResolved` once a tile is sub-pixel (§V.48b).
  const tileC = side.div(uTileWidth.max(0.02));
  const tileF = coordFilter(side).div(uTileWidth.max(0.02));
  const tileResolved = periodResolved(tileC, tileF);
  const stagger = hash2(vec2(tileC.floor(), piece.seed.mul(19))).sub(0.5).mul(uStagger).mul(tileResolved);
  // courses of leaves, each edge wandering a little, overlapping down the slope
  const wander = fbm2(vec2(side.mul(2), piece.seed.mul(31)), 2).sub(0.5).mul(uRagged);
  const rowCoord = along.add(wander).add(stagger).div(uRowPitch.max(0.05));
  const rowFilter = coordFilter(along).div(uRowPitch.max(0.05));
  const rowResolved = periodResolved(rowCoord, rowFilter);
  // the shadow line just down-slope of each course's edge, measured in metres
  const pastEdge = rowCoord.fract().mul(uRowPitch);
  const rowShade = bandLimitedEdge(pastEdge, along, uRowEdge).oneMinus();
  const rowTone = hash2(vec2(rowCoord.floor(), piece.seed.mul(53))).sub(0.5).mul(0.16).mul(rowResolved);
  const rowCrown = sin(rowCoord.fract().mul(Math.PI)).mul(rowResolved);

  // the gap between two tiles, measured against the tile's OWN width (§V.48)
  const tileFr = tileC.fract();
  const tileSeam = bandLimitedEdge(tileFr.min(tileFr.oneMinus()), tileC, float(0.07), tileF).oneMinus();
  let color: AnyNode = mix(uDark, uLight, strand.mul(0.8).add(0.1)).mul(float(1).add(rowTone));
  color = color.mul(mix(float(1), float(0.6), rowShade));
  color = color.mul(mix(float(1), float(0.72), tileSeam));
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
    .sub(rowShade.mul(uRelief).mul(0.5))
    .sub(tileSeam.mul(uRelief).mul(0.6));

  const water = shipWater(frame);
  material.colorNode = color.mul(water.tint);
  material.roughnessNode = float(0.9).add(strand.mul(0.08)).mul(water.roughnessScale).clamp(0.04, 1);
  material.emissiveNode = water.addLight;
  material.aoNode = float(1).sub(rowShade.mul(0.4)).sub(tileSeam.mul(0.2)).sub(under.mul(0.25));
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
      uTileWidth.value = p.thatchTileWidth;
      uStagger.value = p.thatchTileStagger;
    },
  };
}
