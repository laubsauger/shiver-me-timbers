/**
 * glTF material slot → TSL node material (docs/speedboat/asset-pipeline-research.md §5.4, §6.3).
 *
 * GLTFLoader hands back MeshStandard/PhysicalMaterials: drawable under WebGPURenderer, but blind
 * to the sea — no caustics, bounce, wetness or absorption. So each slot is REBUILT here from the
 * loaded textures and factors, with the shared `waterLighting()` hook folded in exactly the way
 * `ship/fittingMaterials.ts` does it (tint × albedo, addLight → emissive, roughness × wet scale).
 *
 * Budgets this keeps (§V40): a textured slot samples at most three filterable textures of its
 * own (baseColor, normal, ORM — occlusion/roughness/metal are ONE texture, sampled once), which
 * leaves the receiver stage room for waterLighting's ocean, caustic, wetline and shadow reads.
 *
 * Livery: the gelcoat's baseColor ALPHA is a livery mask; the hue is an OBJECT-scoped uniform
 * read from `userData.liveryTint` (the `sailTint` mechanism, ship/sailDriver.ts), so eight boats
 * share one material, one pipeline and one texture set and still wear eight colours.
 *
 * Materials are built at construction (TSL bakes the graph), so `setActiveCaustics` and any
 * `attachHullWetline` must already have happened — `waterLighting()` warns if not.
 */
import * as THREE from 'three/webgpu';
import {
  float,
  mix,
  normalMap,
  normalWorldGeometry,
  objectGroup,
  positionLocal,
  positionWorld,
  texture,
  uniform,
  vec2,
} from 'three/tsl';
import { waterLighting } from '../../caustics';
import type { TslNode } from '../../caustics/causticsNode';
import type { SlotName } from './contract';

export type BoatVariant = 'hero' | 'npc';

export interface SlotMaterialOptions {
  /** hero pays for true transmission on the perspex; npc boats use cheap alpha (doc §5.4) */
  variant: BoatVariant;
  /** fold in waterLighting(); false for a studio lookdev with no sea bound */
  water: boolean;
}

type SourceMaterial = THREE.MeshStandardMaterial & Partial<THREE.MeshPhysicalMaterial>;

/** `userData.liveryTint` on the drawn object (or any ancestor up to the boat root) */
function liveryOf(object: THREE.Object3D | null): number | undefined {
  for (let o = object; o !== null; o = o.parent) {
    const hex = o.userData.liveryTint;
    if (typeof hex === 'number' && Number.isFinite(hex)) return hex;
    if (o.userData.boatRoot === true) break;
  }
  return undefined;
}

export function createSlotMaterial(slot: SlotName, source: THREE.Material, opts: SlotMaterialOptions): THREE.MeshPhysicalNodeMaterial {
  const s = source as SourceMaterial;
  const m = new THREE.MeshPhysicalNodeMaterial();
  m.name = `${slot}:${opts.variant}`;
  m.side = s.side ?? THREE.FrontSide;

  const baseFactor = uniform(s.color ? s.color.clone() : new THREE.Color(1, 1, 1));
  const map = s.map ? texture(s.map) : null;
  let albedo: TslNode = map ? map.rgb.mul(baseFactor) : baseFactor;

  if (slot === 'M_Gelcoat') {
    const livery = uniform(new THREE.Color(1, 1, 1)).setGroup(objectGroup);
    const liveryOn = uniform(0).setGroup(objectGroup);
    livery.onObjectUpdate((frame) => {
      const hex = liveryOf(frame.object);
      liveryOn.value = hex === undefined ? 0 : 1;
      if (hex !== undefined) (livery.value as THREE.Color).set(hex);
    });
    const mask = map ? map.a : float(0);
    albedo = mix(albedo, livery, mask.mul(liveryOn));
  }

  // ORM: one texture, one sampler, three channels
  const ormTex = s.aoMap ?? s.roughnessMap ?? s.metalnessMap ?? null;
  const orm = ormTex ? texture(ormTex) : null;
  const rough = orm ? orm.g.mul(s.roughness ?? 1) : float(s.roughness ?? 0.5);
  const metal = orm ? orm.b.mul(s.metalness ?? 1) : float(s.metalness ?? 0);
  if (orm) m.aoNode = mix(float(1), orm.r, float(s.aoMapIntensity ?? 1));

  const w = opts.water
    ? waterLighting({ worldPos: positionWorld, normal: normalWorldGeometry, shipLocalPos: positionLocal, mode: 'both' })
    : null;

  m.colorNode = w ? albedo.mul(w.tint) : albedo;
  m.roughnessNode = (w ? rough.mul(w.roughnessScale) : rough).clamp(0.02, 1);
  m.metalnessNode = metal;
  if (w) m.emissiveNode = w.addLight;
  if (s.normalMap) {
    const scale = vec2(s.normalScale?.x ?? 1, s.normalScale?.y ?? 1);
    m.normalNode = normalMap(texture(s.normalMap), w ? scale.mul(w.reliefScale) : scale);
  }

  switch (slot) {
    case 'M_Gelcoat':
    case 'M_Carbon':
      m.clearcoat = s.clearcoat && s.clearcoat > 0 ? s.clearcoat : 1;
      m.clearcoatRoughness = s.clearcoatRoughness ?? 0.08;
      break;
    case 'M_Perspex':
      m.ior = s.ior ?? 1.49;
      if (opts.variant === 'hero') {
        // one viewport-texture copy for the hero's screen, never ×8 (doc §5.4)
        m.transmission = s.transmission && s.transmission > 0 ? s.transmission : 1;
        m.thickness = 0.012;
        m.side = THREE.DoubleSide;
      } else {
        m.transparent = true;
        m.opacity = s.opacity < 1 ? s.opacity : 0.35;
        m.depthWrite = false;
        m.side = THREE.DoubleSide;
      }
      break;
    default:
      break;
  }
  return m;
}
