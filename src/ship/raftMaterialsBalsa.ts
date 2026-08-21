/**
 * BALSA (§T90): the raft's logs, crossbeams, stern block, oar shaft and bipod
 * legs. Weathered grey-brown with a seeded warm-dry variation per piece,
 * long shallow grain along the member, radial end-grain checks within
 * `balsaEndZone` of either end, rope-lashing grooves at the crossbeam
 * stations (logs), and a green weed band at the waterline that thins toward
 * the bow (logs). One shared material per kind; which piece a fragment is on
 * comes from raftMaterialNodes.ts. §V23: functional mix()/smoothstep().
 */
import * as THREE from 'three/webgpu';
import { atan, float, mix, normalLocal, positionLocal, uniform, vec2, vec3 } from 'three/tsl';
import { bandLimitedEdge } from './bandLimit';
import { fbm2, hash2, triplanarFbm } from '../terrain/noise';
import { reliefNormal } from './surfaceRelief';
import type { PieceKind } from './pieceTypes';
import { raftParams } from '../params/raft';
import { raftMaterialParams, type RaftMaterialParams } from '../params/raftMaterials';
import { buildRaftBlueprint } from './raftBlueprint';
import {
  createRaftPieceUniforms,
  gateAbove,
  noiseResolved,
  ringMask,
  shipWater,
  type AnyNode,
  type RaftPieceUniforms,
} from './raftMaterialNodes';
import type { LocalFrame, ShipMaterialHandle } from './woodMaterial';

type Axis = 'x' | 'y' | 'z';

/** the piece-local axis a balsa member runs along (pieceGeometryRaft.ts) */
export const BALSA_AXIS: Partial<Record<PieceKind, Axis>> = {
  log: 'z',
  crossbeam: 'x',
  'stern-block': 'x',
  'steering-oar': 'z',
  'bipod-mast': 'y',
};

const AXES: readonly Axis[] = ['x', 'y', 'z'];
const others = (a: Axis): [Axis, Axis] => AXES.filter((b) => b !== a) as [Axis, Axis];

/** ship-frame z of the first crossbeam station — read off the blueprint (§V37: one source) */
export function crossbeamStation0(): number {
  const beam = buildRaftBlueprint(raftParams).find((d) => d.id === 'crossbeam-0');
  return beam === undefined ? 0 : beam.transform.position[2];
}

export function createBalsaMaterial(
  kind: PieceKind,
  frame?: LocalFrame,
  p: RaftMaterialParams = raftMaterialParams,
): ShipMaterialHandle {
  const axis = BALSA_AXIS[kind] ?? 'z';
  const [b, c] = others(axis);
  const isLog = kind === 'log';
  const material = new THREE.MeshStandardNodeMaterial();
  material.metalness = 0;

  const uGrey = uniform(new THREE.Color(p.balsaGrey));
  const uWarm = uniform(new THREE.Color(p.balsaWarm));
  const uToneVar = uniform(p.balsaToneVar);
  const uGrainScale = uniform(p.balsaGrainScale);
  const uGrainStretch = uniform(p.balsaGrainStretch);
  const uGrainRelief = uniform(p.balsaGrainRelief);
  const uEndZone = uniform(p.balsaEndZone);
  const uCheckWidth = uniform(p.balsaCheckWidth);
  const uCheckDepth = uniform(p.balsaCheckDepth);
  const uCheckDarken = uniform(p.balsaCheckDarken);
  const uGrooveWidth = uniform(p.grooveWidth);
  const uGrooveDepth = uniform(p.grooveDepth);
  const uGrooveDarken = uniform(p.grooveDarken);
  const uPitch = uniform(raftParams.crossbeamPitch);
  const uBeamCount = uniform(raftParams.crossbeamCount);
  const uBeamHalf = uniform(raftParams.crossbeamLength / 2);
  const uStation0 = uniform(crossbeamStation0());
  const uWeed = uniform(new THREE.Color(p.weedColor));
  const uWeedHalf = uniform(p.weedHalfBand);
  const uWeedFade = uniform(p.weedBowFade);
  const uWeedStrength = uniform(p.weedStrength);
  const uWetDarken = uniform(p.wetDarken);
  const uRough = uniform(p.balsaRough);
  const uBump = uniform(p.balsaBump);
  const piece: RaftPieceUniforms = createRaftPieceUniforms();

  const pos = positionLocal;
  const along: AnyNode = pos[axis];
  const angle = atan(pos[c], pos[b]);

  // seeded per-piece tone: some logs dried warm, most went grey
  const lowTone = triplanarFbm(pos.mul(0.6), normalLocal, float(6), 2);
  const toneMix = piece.seed.mul(uToneVar).add(lowTone.sub(0.5).mul(0.3)).clamp(0, 1);
  let color: AnyNode = mix(uGrey, uWarm, toneMix);

  // long shallow grain: fbm stretched along the member
  const stretch = vec3(
    axis === 'x' ? uGrainStretch.reciprocal() : 1,
    axis === 'y' ? uGrainStretch.reciprocal() : 1,
    axis === 'z' ? uGrainStretch.reciprocal() : 1,
  );
  const samplePos = pos.mul(uGrainScale).mul(stretch);
  const grain = triplanarFbm(samplePos, normalLocal, float(6), 3);
  color = color.mul(mix(float(0.86), float(1.1), grain));
  const grainResolved = noiseResolved(samplePos, 3);

  // END-GRAIN CHECKS: radial cracks that open within `endZone` of either end
  const endDist = along.sub(piece.aabbMin[axis]).min(piece.aabbMax[axis].sub(along)).max(0);
  const endness = bandLimitedEdge(endDist, along, uEndZone).oneMinus();
  const checkCount = Math.max(3, Math.round(p.balsaCheckCount));
  const checkCoord = angle.mul(checkCount / (Math.PI * 2)).add(piece.seed.mul(checkCount));
  // @band-limited-elsewhere: the edge is drawn by bandLimitedEdge below
  const cf = checkCoord.fract();
  const checkDist = cf.min(cf.oneMinus());
  // the crack's width in CHECK units: circumference ÷ count is one check
  const circumference = piece.aabbMax[b].sub(piece.aabbMin[b]).mul(Math.PI).max(0.05);
  const checkWidth = uCheckWidth.mul(checkCount).div(circumference);
  const checkMask = bandLimitedEdge(checkDist, checkCoord, checkWidth);
  const open = gateAbove(hash2(vec2(checkCoord.floor(), piece.seed.mul(97))), 0.55);
  const check = checkMask.oneMinus().mul(open).mul(endness);

  // ROPE GROOVES at the crossbeam stations, logs only, and only on the logs a
  // 5.5 m beam actually reaches
  let groove: AnyNode = float(0);
  if (isLog) {
    const phase = uStation0.sub(piece.origin.z);
    const idx = along.sub(phase).div(uPitch).add(0.5).floor();
    const inRange = idx.add(1).clamp(0, 1).mul(uBeamCount.sub(idx).clamp(0, 1));
    const reached = uBeamHalf.sub(piece.origin.x.abs()).mul(10).clamp(0, 1);
    groove = ringMask(along, uPitch, uGrooveWidth, phase).oneMinus().mul(inRange).mul(reached);
  }

  color = color.mul(mix(float(1), uCheckDarken, check));
  color = color.mul(mix(float(1), uGrooveDarken, groove));
  let rough: AnyNode = uRough.add(grain.mul(0.1)).add(check.mul(0.1));

  if (isLog) {
    // WEED along the waterline (log axis y = 0), patchy, thinning toward the bow
    const band = bandLimitedEdge(pos.y.abs(), pos.y, uWeedHalf).oneMinus();
    const patch = fbm2(vec2(along.mul(1.3), angle.mul(0.8).add(piece.seed.mul(7))), 2)
      .sub(0.35)
      .mul(2.5)
      .clamp(0, 1);
    const bowFade = piece.aabbMax.z.sub(along).div(uWeedFade.max(0.05)).clamp(0, 1);
    const weed = band.mul(patch).mul(bowFade).mul(uWeedStrength);
    color = mix(color, uWeed, weed);
    rough = rough.sub(weed.mul(0.3));
    // constantly wet below the axis: darker, smoother (a clamp on metres, no period)
    const wet = pos.y.negate().mul(1 / 0.15).clamp(0, 1);
    color = color.mul(float(1).sub(uWetDarken.mul(wet)));
    rough = rough.sub(wet.mul(0.25));
  }

  const height = grain
    .sub(0.5)
    .mul(uGrainRelief)
    .mul(grainResolved)
    .sub(check.mul(uCheckDepth))
    .sub(groove.mul(uGrooveDepth));

  const water = shipWater(frame);
  material.colorNode = color.mul(water.tint);
  material.roughnessNode = rough.mul(water.roughnessScale).clamp(0.04, 1);
  material.emissiveNode = water.addLight;
  material.aoNode = float(1).sub(check.max(groove).mul(0.6));
  material.normalNode = reliefNormal(height, uBump.mul(water.reliefScale));

  return {
    material,
    refresh(): void {
      uGrey.value.set(p.balsaGrey);
      uWarm.value.set(p.balsaWarm);
      uToneVar.value = p.balsaToneVar;
      uGrainScale.value = p.balsaGrainScale;
      uGrainStretch.value = p.balsaGrainStretch;
      uGrainRelief.value = p.balsaGrainRelief;
      uEndZone.value = p.balsaEndZone;
      uCheckWidth.value = p.balsaCheckWidth;
      uCheckDepth.value = p.balsaCheckDepth;
      uCheckDarken.value = p.balsaCheckDarken;
      uGrooveWidth.value = p.grooveWidth;
      uGrooveDepth.value = p.grooveDepth;
      uGrooveDarken.value = p.grooveDarken;
      uPitch.value = raftParams.crossbeamPitch;
      uBeamCount.value = raftParams.crossbeamCount;
      uBeamHalf.value = raftParams.crossbeamLength / 2;
      uStation0.value = crossbeamStation0();
      uWeed.value.set(p.weedColor);
      uWeedHalf.value = p.weedHalfBand;
      uWeedFade.value = p.weedBowFade;
      uWeedStrength.value = p.weedStrength;
      uWetDarken.value = p.wetDarken;
      uRough.value = p.balsaRough;
      uBump.value = p.balsaBump;
    },
  };
}
