/**
 * THE PILOT IN THE SEAT (§T.191, docs/speedboat/pilot-log.md). `assets/models/speedboat_pilot.glb` is a separate
 * skinned asset whose frame IS the seat socket (metres, +Y up, +Z bow; origin on the seat pan top). This file
 * seats one instance in every boat (hero + NPCs), plays the seated clips from the boat's controls, and hides the
 * head for the cockpit camera. RENDER ONLY: nothing here reads or writes sim state (§V3).
 *
 * SEAT. The hero boat GLB has no seat socket node (pilot-log "Helm, sockets": "No seat socket node in the parts
 * GLB"), so the socket is DERIVED from the two assets' own anchors, no page constant: the boat's
 * `partsAnchors.eye` (body frame) minus the pilot's `seated.partsEyeAnchor` (pilot frame) — both name the same
 * parts eye point. For the current build that is (0, 0.431, 0.234): z = partsAnchors.seatZ, as it must be.
 *
 * VARIANTS. hero = the file's bind; NPCs alternate npc_b / npc_c: morph weights `variant_b`/`variant_c`, the hair
 * card set per `variants.<v>.hairStyle`, the skin material clone `M_PilotSkin@<v>` (the `KHR_materials_variants`
 * mapping, which GLTFLoader does not apply), and the joint re-bind to `variants.<v>.jointHeads` (seat frame)
 * followed by `skeleton.calculateInverses()` — the clips are rotation-only, so they play on the re-bound rig.
 *
 * CLIPS (root extras `clips`). `idle_seated` loops as the base layer; `steer_left`/`steer_right`/`throttle_push`
 * are ADDITIVE against `seated_base` and are SCRUBBED, not played: each runs from the seated pose to its full
 * deflection over its length, so the clip time is the control's magnitude (full lock = the last frame). Pure
 * mapping `pilotClipTimes` (tested).
 *
 * HEAD. `firstPerson.collapseBone` (`head_geo`) scales to ~0 in the cockpit camera; `head` and `cam_eye` keep their
 * transforms, so `eyeSource` stays valid for raceCam `setEyeSource`.
 *
 * NOT DONE HERE (reported): the pilot's runtime materials (skin SSS, hair Kajiya-Kay, accent-hue tint, hair tint)
 * — GLTFLoader's standard materials draw; IK to the helm sockets (the bind is already on the helm); LOD by the
 * asset's `lodScreenFraction`, which IS done, with `lodDistances` from the boat contract.
 *
 * LOADER. `speedboat/assets` exposes only a contract-checked `load` (a pilot is not a boat contract), so the
 * GLTF + KTX2 + meshopt setup is repeated here as `courseFurniture.ts` also does — the §V95 fold for T192/assets:
 * export `createGltfLoader(renderer)` from `boatModel.ts` and use it in all three.
 */
import * as THREE from 'three/webgpu';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import basisTranscoderJsUrl from 'three/addons/libs/basis/basis_transcoder.js?url';
import basisTranscoderWasmUrl from 'three/addons/libs/basis/basis_transcoder.wasm?url';
import type { App } from '../../core/app';
import { lodDistances, type BoatInstance, applyTextureAnisotropy } from '../assets';

export const PILOT_URL = new URL('../../../assets/models/speedboat_pilot.glb', import.meta.url).href;

export type PilotVariant = 'hero' | 'npc_b' | 'npc_c';
/** NPC i's pilot: the two NPC variants alternate so neighbours on the grid differ */
export const pilotVariantFor = (npcIndex: number): PilotVariant => (npcIndex % 2 === 0 ? 'npc_b' : 'npc_c');

export interface PilotControls {
  /** −1 full lock left .. +1 full lock right (the seam's sign) */
  steer: number;
  /** −0.3 .. 1 */
  throttle: number;
}

/** clip times as a fraction of each scrubbed clip's length (pure; tests pin the mapping) */
export interface PilotClipTimes {
  steerLeft: number;
  steerRight: number;
  throttle: number;
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0);

/** steer right deflects only the right clip, left only the left; reverse throttle leaves the lever at idle */
export function pilotClipTimes(c: Readonly<PilotControls>, out: PilotClipTimes = { steerLeft: 0, steerRight: 0, throttle: 0 }): PilotClipTimes {
  out.steerRight = clamp01(c.steer);
  out.steerLeft = clamp01(-c.steer);
  out.throttle = clamp01(c.throttle);
  return out;
}

/**
 * An additive clip relative to the SEATED REST POSE for every bone it animates (§T.197). The GLB's `seated_base`
 * reference clip keys only `pelvis`, because every other bone's seated pose IS its bind rotation (each scrubbed clip's
 * frame 0 equals the rest rotation). three's `makeClipAdditive` subtracts only tracks the reference clip has and leaves
 * the rest ABSOLUTE; played with additive blending those bones got their rest rotation applied twice and the pilot
 * folded up under the seat back (root cause of "pilot not visible", with the hung loader). The reference built here keys
 * every target track: `base`'s value where it has one, else the bone's rest quaternion.
 */
export function makeClipAdditiveToRest(
  clip: THREE.AnimationClip,
  base: THREE.AnimationClip | null,
  restQuaternion: (nodeName: string) => THREE.Quaternion | null,
): THREE.AnimationClip {
  const out = clip.clone();
  const ref = new THREE.Quaternion();
  const refInv: number[] = [0, 0, 0, 1];
  for (const track of out.tracks) {
    if (track.ValueTypeName !== 'quaternion') continue;
    const fromBase = base?.tracks.find((t) => t.name === track.name && t.ValueTypeName === 'quaternion');
    if (fromBase) {
      ref.fromArray((fromBase as unknown as { createInterpolant(): THREE.Interpolant }).createInterpolant().evaluate(0) as unknown as number[]);
    } else {
      const rest = restQuaternion(track.name.slice(0, track.name.lastIndexOf('.')));
      if (!rest) continue; // a track on no bone of the rig: the mixer ignores it too
      ref.copy(rest);
    }
    ref.normalize().invert().toArray(refInv);
    // delta = ref⁻¹ · q, which the mixer composes as pose · delta (PropertyMixer._slerpAdditive). Every quaternion of
    // the key is transformed: the value AND, for glTF CUBICSPLINE keys [in tangent, value, out tangent], both tangents
    // (d/dt(ref⁻¹·q) = ref⁻¹·q′), which three's makeClipAdditive leaves in the absolute frame.
    for (let o = 0; o < track.values.length; o += 4) THREE.Quaternion.multiplyQuaternionsFlat(track.values as unknown as number[], o, refInv, 0, track.values as unknown as number[], o);
  }
  out.blendMode = THREE.AdditiveAnimationBlendMode;
  return out;
}

const parse = <T>(v: unknown): T | null => {
  if (typeof v !== 'string') return (v as T) ?? null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
};

/**
 * Seat socket in the boat's body frame: boat `partsAnchors.eye` − pilot `seated.partsEyeAnchor` (see header).
 * Null when either anchor is missing (the rig then warns and seats nobody rather than guessing).
 */
export function seatSocketFromAnchors(boatUserData: Record<string, unknown>, pilotExtras: Record<string, unknown>): [number, number, number] | null {
  const anchors = parse<{ eye?: number[] }>(boatUserData.partsAnchors);
  const seated = parse<{ partsEyeAnchor?: number[] }>(pilotExtras.seated);
  const e = anchors?.eye;
  const p = seated?.partsEyeAnchor;
  if (!e || !p || e.length !== 3 || p.length !== 3 || ![...e, ...p].every(Number.isFinite)) return null;
  return [e[0] - p[0], e[1] - p[1], e[2] - p[2]];
}

export interface PilotInstance {
  readonly variant: PilotVariant;
  /** child of the boat instance at the seat socket */
  readonly object: THREE.Object3D;
  setHeadVisible(visible: boolean): void;
  /** raceCam `EyeSource`: the `cam_eye` node's world pose (−Z view); false before the first frame or without the node */
  eyeSource(outPosition: THREE.Vector3, outQuaternion: THREE.Quaternion): boolean;
  update(dt: number, controls: Readonly<PilotControls>): void;
}

export interface Pilots {
  readonly hero: PilotInstance;
  readonly npcs: readonly PilotInstance[];
  update(dt: number, hero: Readonly<PilotControls>, npc: (i: number) => Readonly<PilotControls>): void;
  dispose(): void;
}

export interface CreatePilotsOptions {
  url?: string;
  /** vertical FOV for the LOD thresholds (default the app camera's) */
  fovDeg?: number;
}

interface VariantSpec {
  morph: string | null;
  skinMaterialVariant: string;
  hairStyle: string;
  jointHeads: Record<string, [number, number, number]>;
}

/**
 * The GLB and EVERY material it declares. The NPC skin variants (`M_PilotSkin@npc_b/c`) are referenced by no mesh
 * (GLTFLoader does not apply KHR_materials_variants), so the scene load never builds them or their KTX2 textures; they
 * must be built HERE, while the KTX2 loader is alive. §T.197 root cause of "no pilot in any boat": they were fetched after
 * `ktx2.dispose()` had terminated its transcoder workers, the texture promise never settled and `createPilots` hung
 * forever without a warning.
 */
async function loadPilotGltf(renderer: THREE.WebGPURenderer, url: string): Promise<{ gltf: GLTF; materials: THREE.Material[] }> {
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((u) => {
    if (u.endsWith('basis_transcoder.js')) return basisTranscoderJsUrl;
    if (u.endsWith('basis_transcoder.wasm')) return basisTranscoderWasmUrl;
    return u;
  });
  const ktx2 = new KTX2Loader(manager).setTranscoderPath('/basis/');
  await ktx2.detectSupportAsync(renderer);
  await MeshoptDecoder.ready;
  const loader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
  try {
    const gltf = await loader.loadAsync(url);
    const materials = (await gltf.parser.getDependencies('material')) as THREE.Material[];
    return { gltf, materials };
  } finally {
    ktx2.dispose();
  }
}

/**
 * Seat a pilot in the hero and every NPC boat. Never throws: a missing or broken GLB logs ONE warning and returns
 * pilots that do nothing, so the race still runs (fail loud, keep racing).
 */
export async function createPilots(app: App, boats: { hero: BoatInstance; npcs: readonly BoatInstance[] }, opts: CreatePilotsOptions = {}): Promise<Pilots> {
  const inert = (variant: PilotVariant): PilotInstance => ({
    variant,
    object: new THREE.Group(),
    setHeadVisible() {},
    eyeSource: () => false,
    update() {},
  });
  const fallback = (why: unknown): Pilots => {
    console.warn('[speedboat] pilot not seated:', why);
    return { hero: inert('hero'), npcs: boats.npcs.map((_, i) => inert(pilotVariantFor(i))), update() {}, dispose() {} };
  };

  let gltf: GLTF;
  let materials: THREE.Material[];
  try {
    ({ gltf, materials } = await loadPilotGltf(app.renderer, opts.url ?? PILOT_URL));
  } catch (e) {
    return fallback(e);
  }
  // §T.192: the same anisotropic filtering every boat texture gets (textures read mushy at grazing angles otherwise) —
  // over EVERY material, the NPC skin variants included (no mesh in the scene carries those until a pilot swaps them in)
  const allMaterials = new THREE.Group();
  for (const m of materials) allMaterials.add(new THREE.Mesh(undefined, m));
  applyTextureAnisotropy(allMaterials, app.renderer.getMaxAnisotropy());
  const root = gltf.scene.getObjectByName('SB_Pilot') ?? gltf.scene.children[0];
  if (!root) return fallback('no SB_Pilot root');
  const extras = root.userData as Record<string, unknown>;
  const socket = seatSocketFromAnchors(boats.hero.object.userData as Record<string, unknown>, extras);
  if (!socket) return fallback('no seat socket (boat partsAnchors.eye / pilot seated.partsEyeAnchor missing)');
  const variants = parse<Record<string, VariantSpec>>(extras.variants) ?? {};
  const firstPerson = parse<{ collapseBone?: string; cameraNode?: string }>(extras.firstPerson) ?? {};
  const fractions = parse<number[]>(extras.lodScreenFraction) ?? [0.25, 0.08];
  const heightM = typeof extras.heightM === 'number' ? extras.heightM : 1.78;

  const materialNamed = (name: string): THREE.Material | undefined => materials.find((m) => m.name === name);
  const clip = (name: string): THREE.AnimationClip | null => gltf.animations.find((a) => a.name === name) ?? null;
  const base = clip('seated_base');
  const idle = clip('idle_seated');
  const restOf = (nodeName: string): THREE.Quaternion | null => root.getObjectByName(nodeName)?.quaternion ?? null;
  const additive = (name: string): THREE.AnimationClip | null => {
    const c = clip(name);
    if (!c || !base) return null;
    return makeClipAdditiveToRest(c, base, restOf);
  };
  const steerL = additive('steer_left');
  const steerR = additive('steer_right');
  const throttle = additive('throttle_push');
  const missing = [['seated_base', base], ['idle_seated', idle], ['steer_left', steerL], ['steer_right', steerR], ['throttle_push', throttle]]
    .filter(([, c]) => !c)
    .map(([n]) => n);
  if (missing.length) console.warn(`[speedboat] pilot clips missing: ${missing.join(', ')} (the pilot sits in the bind pose)`);
  const fov = opts.fovDeg ?? app.camera.fov;
  const tmp1 = new THREE.Vector3();

  const build = (boat: BoatInstance, variant: PilotVariant): PilotInstance => {
    const copy = cloneSkinned(root);
    const spec = variants[variant];
    const lod = new THREE.LOD();
    lod.name = `pilot:${variant}`;
    const dist = lodDistances(heightM, fov, fractions);
    const levels: THREE.Object3D[] = [];
    for (const child of [...copy.children]) {
      const m = /^LOD(\d+)$/.exec(child.name);
      if (m) levels[Number(m[1])] = child;
    }
    for (const child of [...copy.children]) {
      if (/^LOD\d+$/.test(child.name)) continue;
      lod.add(child); // the rig and the socket node ride along, always visible
    }
    levels.forEach((lvl, i) => lod.addLevel(lvl, i === 0 ? 0 : dist[Math.min(i - 1, dist.length - 1)], 0.1));

    // variant: hair set, morphs, skin material
    const skinned: THREE.SkinnedMesh[] = [];
    lod.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh) return;
      skinned.push(mesh);
      const style = (mesh.userData.hairStyle as string | undefined) ?? null;
      if (style && spec) mesh.visible = style === spec.hairStyle;
      if (spec && mesh.morphTargetDictionary && mesh.morphTargetInfluences) {
        for (const [name, idx] of Object.entries(mesh.morphTargetDictionary)) mesh.morphTargetInfluences[idx] = name === spec.morph ? 1 : 0;
      }
      if (spec && variant !== 'hero') {
        const mat = mesh.material as THREE.Material;
        const swap = mat && mat.name === 'M_PilotSkin' ? materialNamed(`M_PilotSkin@${spec.skinMaterialVariant}`) : undefined;
        if (swap) mesh.material = swap;
      }
      mesh.frustumCulled = false; // a skinned pose leaves the bind bounds (seated lean, steer)
    });

    // variant joint re-bind (seat frame), then fresh inverse binds
    if (spec && variant !== 'hero' && spec.jointHeads) {
      lod.updateMatrixWorld(true);
      const bones: THREE.Bone[] = [];
      lod.traverse((o) => {
        if ((o as THREE.Bone).isBone) bones.push(o as THREE.Bone);
      });
      const tmp = new THREE.Vector3();
      // traverse order is parent before child, so each parent is already re-posed when its child is placed
      for (const bone of bones) {
        const head = spec.jointHeads[bone.name];
        if (!head || !bone.parent) continue;
        // jointHeads are pilot-frame (= lod-local) positions
        tmp.set(head[0], head[1], head[2]).applyMatrix4(lod.matrixWorld);
        bone.parent.updateWorldMatrix(true, false);
        bone.parent.worldToLocal(tmp);
        bone.position.copy(tmp);
        bone.updateMatrixWorld(true);
      }
      for (const mesh of skinned) {
        mesh.updateMatrixWorld(true);
        mesh.skeleton.calculateInverses();
      }
    }

    // placed AFTER the re-bind: inverse binds are taken in world space, and the file's bind matrices are identity
    lod.position.set(socket[0], socket[1], socket[2]);
    const collapse = firstPerson.collapseBone ? lod.getObjectByName(firstPerson.collapseBone) : undefined;
    const eye = firstPerson.cameraNode ? lod.getObjectByName(firstPerson.cameraNode) : undefined;
    const mixer = new THREE.AnimationMixer(lod);
    const scrub = (c: THREE.AnimationClip | null): THREE.AnimationAction | null => {
      if (!c) return null;
      const a = mixer.clipAction(c);
      a.blendMode = THREE.AdditiveAnimationBlendMode;
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
      a.play();
      a.paused = true;
      return a;
    };
    if (idle) mixer.clipAction(idle).play();
    const aL = scrub(steerL);
    const aR = scrub(steerR);
    const aT = scrub(throttle);
    const times: PilotClipTimes = { steerLeft: 0, steerRight: 0, throttle: 0 };
    boat.object.add(lod);

    return {
      variant,
      object: lod,
      setHeadVisible(visible) {
        if (collapse) collapse.scale.setScalar(visible ? 1 : 1e-4);
      },
      eyeSource(p, q) {
        if (!eye) return false;
        eye.updateWorldMatrix(true, false);
        eye.matrixWorld.decompose(p, q, tmp1);
        return true;
      },
      update(dt, c) {
        pilotClipTimes(c, times);
        if (aL) aL.time = times.steerLeft * aL.getClip().duration;
        if (aR) aR.time = times.steerRight * aR.getClip().duration;
        if (aT) aT.time = times.throttle * aT.getClip().duration;
        mixer.update(Number.isFinite(dt) && dt > 0 ? dt : 0);
      },
    };
  };

  try {
    const hero = build(boats.hero, 'hero');
    const npcs = boats.npcs.map((b, i) => build(b, pilotVariantFor(i)));
    return {
      hero,
      npcs,
      update(dt, h, npc) {
        hero.update(dt, h);
        for (let i = 0; i < npcs.length; i++) npcs[i].update(dt, npc(i));
      },
      dispose() {
        for (const p of [hero, ...npcs]) p.object.removeFromParent();
      },
    };
  } catch (e) {
    return fallback(e);
  }
}
