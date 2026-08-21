/**
 * Sierra terrain material (§T.99): glacial-polished granite + DG sand, as a
 * RETINT of `terrainBlendMaterial` rather than a second shader.
 *
 * WHY A RETINT. The blend material already owns everything that is hard —
 * the sand/cover/rock slope+elevation stack, the swash, the wet band, water
 * lighting, aerial perspective (§B67 fix lives on the same node) — and all of
 * it is keyed to `terrainParams` through live uniforms. The granite look is
 * three things on top of that:
 *   1. the rock layer's own tint uniforms set to granite greys (light grey
 *      #A9A39A with a paler sun-bleached top and a darker crevice), and the
 *      sand layer's to a warm DG tone — re-applied after every
 *      `updateFromParams`, which would otherwise write the pirate colours back
 *   2. a post-lit multiply on `colorNode`: JOINTING BANDS (two sets of
 *      near-vertical joints, the lines exfoliation sheets and cooling joints
 *      leave in a dome) and LICHEN patches (a low-frequency field), both gated
 *      to the rock layer's own slope weight so the sand stays sand
 *   3. a roughness pull on POLISHED FLATS: the glacier left the slabs glossier
 *      than the broken ground, keyed on up-facing rock
 *
 * §V48 on every periodic term: the joint is an edge of width `jointWidth`
 * inside a `jointSpacing` repeat — the feature, not the repeat, is what gets
 * band-limited (`bandLimitedEdge` widens it to ≥ 2 px of its own coordinate
 * and fades it to its mean). The lichen field is smooth fbm; its only
 * failure mode is the repeat going sub-pixel, which `periodResolved` gates.
 * §V23 functional forms only; §V57 pure expression tree.
 *
 * Branching is BY ARCHETYPE FAMILY at the island (island.ts picks this handle
 * for sierra archetypes and the plain one otherwise) — no global switch, so
 * a pirate island in the same world renders exactly as before.
 */
import * as THREE from 'three/webgpu';
import {
  float,
  fract,
  mix,
  normalWorldGeometry,
  positionWorld,
  uniform,
  vec2,
} from 'three/tsl';
import { terrainBlendMaterial, fbm2, type TerrainBlendMaterialHandle } from '../terrain';
import { bandLimitedEdge, periodResolved } from '../ship/bandLimit';
import { sierraParams, type SierraParams } from '../params/sierra';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyNode = any;

/** the two joint sets: seeded-looking fixed azimuths, ~70° apart */
const JOINT_AZIMUTH_A = 0.35;
const JOINT_AZIMUTH_B = 1.58;
/** lichen fbm octaves — build-time loop unroll, not a look knob */
const LICHEN_OCTAVES = 3;

export function createSierraUniforms(p: SierraParams = sierraParams) {
  return {
    jointSpacing: uniform(p.jointSpacing),
    jointWidth: uniform(p.jointWidth),
    jointStrength: uniform(p.jointStrength),
    lichenColor: uniform(new THREE.Color(p.lichenColor)),
    lichenScale: uniform(p.lichenScale),
    lichenCoverage: uniform(p.lichenCoverage),
    lichenStrength: uniform(p.lichenStrength),
    polishGloss: uniform(p.polishGloss),
  };
}
export type SierraUniforms = ReturnType<typeof createSierraUniforms>;

export function updateSierraUniforms(u: SierraUniforms, p: SierraParams = sierraParams): void {
  u.jointSpacing.value = p.jointSpacing;
  u.jointWidth.value = p.jointWidth;
  u.jointStrength.value = p.jointStrength;
  u.lichenColor.value.setHex(p.lichenColor);
  u.lichenScale.value = p.lichenScale;
  u.lichenCoverage.value = p.lichenCoverage;
  u.lichenStrength.value = p.lichenStrength;
  u.polishGloss.value = p.polishGloss;
}

/** one joint set: 1 away from a joint, dips toward 0 on it, band-limited */
function jointSet(azimuth: number, u: SierraUniforms): AnyNode {
  const dir = vec2(Math.cos(azimuth), Math.sin(azimuth));
  // the SMOOTH coordinate — one unit per joint — is what the filter measures
  const coord = positionWorld.xz.dot(dir).div(u.jointSpacing.max(1e-3));
  // distance to the nearest joint as a triangle wave: continuous everywhere,
  // so the wrap lands mid-block instead of on the edge (§V48, §B20)
  // @band-limited-elsewhere: this fract is the INPUT to bandLimitedEdge below, which filters on the joint width
  const distance = fract(coord.add(0.5)).sub(0.5).abs();
  const feature = u.jointWidth.div(u.jointSpacing.max(1e-3));
  return bandLimitedEdge(distance, coord, feature);
}

/**
 * Granite on the rock layer, DG sand on the beach — built on the shared blend
 * material. Returns the SAME handle shape so island.ts can hand it to
 * `createIslandMesh` in place of the plain one.
 */
export function createSierraTerrainMaterial(p: SierraParams = sierraParams): TerrainBlendMaterialHandle {
  const base = terrainBlendMaterial();
  const u = createSierraUniforms(p);
  const material = base.material;
  const { rock, sand, blend } = base.uniforms;

  // the rock layer's slope weight, on the same geometric normal and the same
  // blend uniforms the base uses, so the granite tint lands exactly where the
  // base paints rock (§V71 — same surface, not a second derivation)
  const up = normalWorldGeometry.y;
  const w = blend.slopeBlendWidth.max(1e-3);
  // @band-limited-elsewhere: slope mask on the geometric normal (not a periodic spatial term); width = slopeBlendWidth param
  const rockW = up.smoothstep(blend.slopeThreshold.sub(w), blend.slopeThreshold.add(w)).oneMinus();

  // jointing: two sets multiply — where both dip the block corner is darkest
  const joints = jointSet(JOINT_AZIMUTH_A, u).mul(jointSet(JOINT_AZIMUTH_B, u));
  const jointDarken = float(1).sub(joints.oneMinus().mul(u.jointStrength));

  // lichen: a low-frequency field thresholded around the coverage, faded to
  // its own mean once the repeat is sub-pixel
  const lichenCoord = positionWorld.xz.mul(u.lichenScale);
  const lichenField = fbm2(lichenCoord, LICHEN_OCTAVES);
  const edge = u.lichenCoverage.oneMinus();
  const lichenRaw = lichenField.smoothstep(edge.sub(0.08), edge.add(0.08));
  const lichenMask = mix(u.lichenCoverage, lichenRaw, periodResolved(lichenCoord))
    .mul(u.lichenStrength)
    .mul(rockW);

  // post-lit modulation — albedo is linear in the lit result, so a multiply
  // here is a tint and not a lighting change; mix toward the lichen colour
  // RELATIVE to the granite so shadowed lichen stays shadowed
  const lit = material.colorNode as AnyNode;
  if (!lit) throw new Error('createSierraTerrainMaterial: blend material has no colorNode'); // §Rule 8
  const graniteGrey = rock.baseColor as AnyNode;
  const lichenRatio = u.lichenColor.div(graniteGrey.max(1e-3));
  const tinted = lit.mul(mix(float(1), jointDarken, rockW));
  material.colorNode = mix(tinted, tinted.mul(lichenRatio), lichenMask);

  // polished flats: up-facing rock is glossier
  // @band-limited-elsewhere: slope mask on the geometric normal, 0.15 wide in normal.y — not a spatial edge
  const flatW = up.smoothstep(0.82, 0.97).mul(rockW);
  const rough = material.roughnessNode as AnyNode;
  if (rough) material.roughnessNode = rough.mul(float(1).sub(flatW.mul(u.polishGloss)));

  const applyTones = (): void => {
    rock.baseColor.value.setHex(p.graniteBaseColor);
    rock.topColor.value.setHex(p.graniteTopColor);
    rock.creviceColor.value.setHex(p.graniteJointColor);
    sand.baseColor.value.setHex(p.dgSandColor);
    sand.shadeColor.value.setHex(p.dgSandShadeColor);
    updateSierraUniforms(u, p);
  };
  applyTones();

  return {
    ...base,
    updateFromParams(): void {
      // the base re-reads terrainParams (the pirate palette) every frame;
      // granite goes back on top every frame for the same reason
      base.updateFromParams();
      applyTones();
    },
  };
}
