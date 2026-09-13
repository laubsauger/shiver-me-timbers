/**
 * Speedboat asset contract, runtime side (docs/speedboat/asset-pipeline.md).
 *
 * The numbers live in `assetContract.json`, which the Blender build and the GLB checker
 * (scripts/blender/checkGlb.mjs) read too — one contract, three readers. This module adds only
 * the typed view and the pure mappings the loader needs: glTF extras → typed boat extras,
 * extras → foam/wetline tags, screen-fraction LOD thresholds → camera distances, and GPU texture
 * byte counts. NO three.js import: it runs under vitest's node environment as-is.
 */
import contractJson from './assetContract.json?raw';

export interface SlotContract {
  alphaMode: 'OPAQUE' | 'BLEND' | 'MASK';
  surface: string;
}

export interface AssetContract {
  version: number;
  maxMaterials: number;
  maxTexturesPerMaterial: number;
  slots: Record<string, SlotContract>;
  assetKinds: Record<string, { triBudget: number[]; drawBudget: number[] }>;
  lod: { levels: number; switchScreenFraction: number[]; hysteresis: number };
  extras: { root: string[]; lodGroup: string[]; mesh: string[]; hull: string[] };
  names: { lodGroup: string; hull: string; meshSuffix: string };
  tolerance: { extrasVsGeometry: number; weld: number };
}

export const ASSET_CONTRACT: Readonly<AssetContract> = JSON.parse(contractJson) as AssetContract;

export const SLOT_NAMES = [
  'M_Gelcoat', 'M_Antifoul', 'M_NonSlip', 'M_Carbon', 'M_Metal', 'M_Perspex', 'M_Rubber', 'M_Cockpit', 'M_Pilot',
] as const;
export type SlotName = (typeof SLOT_NAMES)[number];

export function isSlotName(name: string): name is SlotName {
  return (SLOT_NAMES as readonly string[]).includes(name);
}

/** the root node's extras, validated */
export interface BoatExtras {
  assetKind: 'player' | 'npc';
  contractVersion: number;
  /** body-frame z of the stem / transom, m — the wetline span (hullWetline.ts) */
  bowZ: number;
  sternZ: number;
  /** overall beam of the render hull, m */
  beam: number;
  keelY: number;
  deckY: number;
  pipelineTest: boolean;
}

/**
 * glTF root extras (GLTFLoader copies them into `userData`) → typed extras. THROWS on anything
 * missing or non-finite: a boat with a NaN stem maps every wetline fragment to one end of the
 * texture, which renders — wrongly and silently (§Rule 8).
 */
export function readBoatExtras(userData: Record<string, unknown>, contract: Readonly<AssetContract> = ASSET_CONTRACT): BoatExtras {
  const missing = contract.extras.root.filter((k) => userData[k] === undefined);
  if (missing.length > 0) throw new Error(`speedboat asset: root extras missing ${missing.join(', ')}`);
  const num = (k: string): number => {
    const v = userData[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`speedboat asset: extras.${k} must be a finite number, got ${String(v)}`);
    return v;
  };
  const kind = userData.assetKind;
  if (kind !== 'player' && kind !== 'npc') throw new Error(`speedboat asset: assetKind '${String(kind)}' is not player|npc`);
  const version = num('contractVersion');
  if (version !== contract.version) throw new Error(`speedboat asset: contractVersion ${version} ≠ runtime contract ${contract.version} — rebuild the GLB`);
  const extras: BoatExtras = {
    assetKind: kind,
    contractVersion: version,
    bowZ: num('bowZ'),
    sternZ: num('sternZ'),
    beam: num('beam'),
    keelY: num('keelY'),
    deckY: num('deckY'),
    pipelineTest: userData.pipelineTest === true,
  };
  if (!(extras.bowZ > extras.sternZ)) throw new Error(`speedboat asset: bowZ ${extras.bowZ} must exceed sternZ ${extras.sternZ}`);
  return extras;
}

/** `caustics.attachHullWetline(...)` options — the stem/transom of the drawn hull */
export function wetlineOptions(extras: BoatExtras): { bowZ: number; sternZ: number } {
  return { bowZ: extras.bowZ, sternZ: extras.sternZ };
}

/** structural Object3D subset, so the tag walk is testable without a renderer */
export interface TaggableObject {
  userData: Record<string, unknown>;
  children: TaggableObject[];
  isMesh?: boolean;
  layers?: { enable(layer: number): void };
}

/**
 * Carry the hull node's `foamTarget` extra down onto its MESHES. GLTFLoader puts node extras on
 * the node's object, and a multi-material hull is a Group of per-primitive Meshes — while
 * flowfoam's injection walk (`flowfoam/accumulation.ts`) tests `userData.foamTarget` on meshes
 * only. Without this the hull tags itself and the foam never sees it. Returns the tagged meshes.
 */
export function tagFoamTargets(root: TaggableObject, foamLayer: number): TaggableObject[] {
  const tagged: TaggableObject[] = [];
  const walk = (o: TaggableObject, inherited: boolean): void => {
    const on = inherited || o.userData.foamTarget === true;
    if (on && o.isMesh) {
      o.userData.foamTarget = true;
      o.layers?.enable(foamLayer);
      tagged.push(o);
    }
    for (const c of o.children) walk(c, on);
  };
  walk(root, false);
  return tagged;
}

/**
 * Camera distance at which an object of size `size` (m) fills `fraction` of the screen height
 * under a vertical FOV of `fovDeg`: size / (2·d·tan(fov/2)) = fraction. THREE.LOD switches on
 * distance, the contract speaks in screen fraction (doc §5.3), so this is the translation.
 */
export function lodDistances(size: number, fovDeg: number, fractions: readonly number[]): number[] {
  const t = Math.tan((Math.max(1e-3, Math.min(179, fovDeg)) * Math.PI) / 360);
  return fractions.map((f) => size / (2 * Math.max(f, 1e-4) * t));
}

/** GPU bytes of one texture: the uploaded mip chain for compressed textures, RGBA8 + mips otherwise */
export function textureBytes(tex: {
  isCompressedTexture?: boolean;
  mipmaps?: ArrayLike<{ data?: ArrayBufferView }> | null;
  image?: { width?: number; height?: number } | null;
}): number {
  if (tex.isCompressedTexture && tex.mipmaps && tex.mipmaps.length > 0) {
    let n = 0;
    for (let i = 0; i < tex.mipmaps.length; i++) n += tex.mipmaps[i].data?.byteLength ?? 0;
    return n;
  }
  const w = tex.image?.width ?? 0;
  const h = tex.image?.height ?? 0;
  return Math.round(w * h * 4 * (4 / 3));
}
