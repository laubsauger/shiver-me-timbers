/**
 * THE PILOT IN THE SEAT (§T.191, docs/speedboat/pilot-log.md). `assets/models/speedboat_pilot.glb` is a separate
 * skinned asset whose frame IS the seat socket (metres, +Y up, +Z bow; origin on the seat pan top). This file
 * seats one instance in every boat (hero + NPCs), plays the seated clips from the boat's controls, and hides the
 * head for the cockpit camera. RENDER ONLY: nothing here reads or writes sim state (§V3).
 *
 * SEAT. The hero boat GLB has no seat socket node (pilot-log "Helm, sockets": "No seat socket node in the parts
 * GLB"), so the socket is DERIVED from the two assets' own anchors, no page constant: the boat's
 * `partsAnchors.eye` (body frame) minus the pilot's `seated.partsEyeAnchor` (pilot frame) — both name the same
 * parts eye point. For the current build that is (0, 0.410, 0.234): z = partsAnchors.seatZ, as it must be.
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
 * HANDS (§T.203). The helm node turns with the drive steer (`wheelAngleFor`, linear, 120° at full lock) and both hands are
 * re-solved onto the turned rim after the mixer (`createHandGrip`); the throttle clip is not played (see `seatPilots`).
 * CINE ONLY (`cineThrottle`, the trailer's throttle insert): the hero's `Throttle_LOD0` lever turns and the right hand is
 * eased off the rim onto the handle bank by the same IK (over the handles, fingers opening, then closing round them) and
 * carried round the lever pivot, the spine leaning into the push where the arm runs out. Inactive, the rig is the race rig.
 * FINGERS (trailer close-ups): the rim wrap and the lever grip are finger-bone rotations solved at seat time against the
 * real rim torus and handle geometry (§FINGER GRIPS below); the bake's own wraps floated ~8 mm off the rim and ran
 * through the handles.
 *
 * NOT DONE HERE (reported): the pilot's runtime materials (skin SSS, hair Kajiya-Kay, accent-hue tint, hair tint)
 * — GLTFLoader's standard materials draw; the throttle lever and a throttle hand in play (cine has them); LOD by the
 * asset's `lodScreenFraction`, which IS done, with `lodDistances` from the boat contract.
 *
 * LOADER. `speedboat/assets` exposes only a contract-checked `load` (a pilot is not a boat contract), so the
 * GLTF + KTX2 + meshopt setup is repeated here as `courseFurniture.ts` also does — the §V95 fold for T192/assets:
 * export `createGltfLoader(renderer)` from `boatModel.ts` and use it in all three.
 */
import * as THREE from 'three/webgpu';
import { dFdx, dFdy, materialRoughness, normalView } from 'three/tsl';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import basisTranscoderJsUrl from 'three/addons/libs/basis/basis_transcoder.js?url';
import basisTranscoderWasmUrl from 'three/addons/libs/basis/basis_transcoder.wasm?url';
import type { App } from '../../core/app';
import { lodDistances, type BoatInstance, applyTextureAnisotropy } from '../assets';

export const PILOT_URL = new URL('../../../assets/models/speedboat_pilot.glb', import.meta.url).href;

const clamp01 = (v: number): number => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0);

export type PilotVariant = 'hero' | 'npc_b' | 'npc_c';
/** NPC i's pilot: the two NPC variants alternate so neighbours on the grid differ */
export const pilotVariantFor = (npcIndex: number): PilotVariant => (npcIndex % 2 === 0 ? 'npc_b' : 'npc_c');

export interface PilotControls {
  /**
   * the drive steer the physics ran this tick as a fraction of the drive's RAW lock, −1 left .. +1 right (the seam's
   * sign): hero `session.applied.steer` = the helm's rate-limited, speed-limited drive angle / lock; a rival
   * `npcs.steer(i)` = its pilot's drive angle / lock. The outboards are drawn from the same number.
   */
  steer: number;
  /** −0.3 .. 1 */
  throttle: number;
}

/**
 * The wheel's turn at the drive's full lock: 120° for the SB-12's 30° drives, a 4:1 helm ratio. Bounded by the hand IK:
 * the hand pulling the rim down (right hand in a right turn) rides its grip without slipping up to 120° and slips 3.7 cm
 * at 135°; the hand reaching across slides along the rim from ~30° at any lock, fingertips still on it (§T.203 tests).
 */
export const WHEEL_LOCK_RAD = (120 * Math.PI) / 180;
/** the steer clips' baked wheel turn at their last frame (scripts/blender/pilot/anim.py `steer`: 90° × ease(k)) */
const CLIP_WHEEL_RAD = Math.PI / 2;
const ease = (t: number): number => t * t * (3 - 2 * t);
/** ease⁻¹ on 0..1 (the smoothstep's inverse) */
const unease = (y: number): number => (y <= 0 ? 0 : y >= 1 ? 1 : 0.5 - Math.sin(Math.asin(1 - 2 * y) / 3));
/**
 * The helm's turn for a drive steer (`PilotControls.steer`), rad about the wheel axis (toward the pilot, so + = counter-
 * clockwise as the pilot sees it = a left turn). LINEAR in the drive angle — the one mapping the wheel, the hand glue and
 * the steer clips (`pilotClipTimes`) share — so the wheel moves at the drive's own rate, 4× the outboards' angle.
 */
export const wheelAngleFor = (steer: number): number => {
  const s = Number.isFinite(steer) ? (steer < -1 ? -1 : steer > 1 ? 1 : steer) : 0;
  return -s * WHEEL_LOCK_RAD;
};

/**
 * CINE ONLY (trailer shot 06, docs/cine/speedboat-trailer-v1.md): the HERO's right hand on the throttle lever. Set by
 * the cine host while a shot asks for it; `active: false` (the default, and what the race always sees) leaves the rig
 * exactly as §T.203 has it — no throttle clip, the lever at idle, both hands glued to the rim.
 *   reach  0..1  the right hand from its rim grip to the lever handle
 *   lever  0..1  the lever from idleDeg to fullDeg (Throttle_LOD0 extras)
 */
export const cineThrottle = { active: false, reach: 0, lever: 0 };

/** CINE: the fingers take their lever grip over this long once the hand arrives (reach past LEVER_FINGERS_AT) */
const LEVER_FINGERS_S = 0.2;
const LEVER_FINGERS_AT = 0.97;

/** clip times as a fraction of each scrubbed clip's length (pure; tests pin the mapping) */
export interface PilotClipTimes {
  steerLeft: number;
  steerRight: number;
  throttle: number;
}

/**
 * steer right deflects only the right clip, left only the left, scrubbed to the frame whose baked wheel turn
 * (90° × ease) is the drawn wheel's `wheelAngleFor` (held at the last frame past 90°); reverse throttle leaves the lever
 * at idle
 */
export function pilotClipTimes(c: Readonly<PilotControls>, out: PilotClipTimes = { steerLeft: 0, steerRight: 0, throttle: 0 }): PilotClipTimes {
  const t = unease(Math.abs(wheelAngleFor(c.steer)) / CLIP_WHEEL_RAD);
  out.steerRight = c.steer > 0 ? t : 0;
  out.steerLeft = c.steer < 0 ? t : 0;
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

/** a hand's bind grip on the rim, pilot frame: the hand bone's head and world orientation in the seated bind */
export interface BindGrip {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

const _S = new THREE.Vector3();
const _E = new THREE.Vector3();
const _W = new THREE.Vector3();
const _T = new THREE.Vector3();
const _u = new THREE.Vector3();
const _v = new THREE.Vector3();
const _d1 = new THREE.Vector3();
const _d2 = new THREE.Vector3();
const _sc = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _qw = new THREE.Quaternion();
const _qr = new THREE.Quaternion();
const _qLod = new THREE.Quaternion();
const _L = new THREE.Vector3();
const _qL = new THREE.Quaternion();

/** CINE: the right hand's grip on the throttle handle with the lever at idle (pilot frame), the bake's finger wrap on it (local), and the lever's pivot/axis (pilot frame) */
export interface LeverGrip {
  grip: BindGrip;
  /** the closed grip's finger rotations (bone-local), and the same fingers opened for the approach */
  fingers: ReadonlyMap<string, THREE.Quaternion>;
  open: ReadonlyMap<string, THREE.Quaternion>;
  /** the handle's up (along the lever) at idle, pilot frame: the hand comes down onto the handles along it */
  up: THREE.Vector3;
  pivot: THREE.Vector3;
  axis: THREE.Vector3;
}
/** CINE: the hand's approach runs this far above the handles (along the lever, m), gone as the reach completes */
const LEVER_APPROACH_M = 0.07;
/** the arm may stretch to this fraction of upper + lower length before the hand slides along the rim instead */
const REACH_MAX = 0.985;
/** CINE throttle: the most the pilot leans (rad, summed over the spine) to keep the right hand on a pushed lever */
const LEAN_MAX = (18 * Math.PI) / 180;

const worldQuat = (o: THREE.Object3D, out: THREE.Quaternion): THREE.Quaternion => {
  o.matrixWorld.decompose(_sc, out, _sc);
  return out;
};

/** turn `bone` in WORLD space by the shortest arc taking direction `from` to `to` (unit vectors) */
function turnBone(bone: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3): void {
  _q1.setFromUnitVectors(from, to);
  worldQuat(bone, _qw);
  const parent = bone.parent as THREE.Object3D;
  worldQuat(parent, _q2).invert();
  bone.quaternion.copy(_q2.multiply(_q1).multiply(_qw)).normalize();
  bone.updateMatrixWorld(true);
}

/**
 * §T.203 HANDS ON THE RIM. The steer clips were baked with the wheel turning under two-bone IK, but the page never
 * turned the wheel, and at a right lock the left arm cannot reach 90° (the bake clamps it: 8.9 cm off the rim, fingertips
 * 4 cm, thumb 7.5 cm), and the additive stack on the idle layer drifts the grips further. So after the mixer each hand is
 * re-solved every frame: its bind grip carried round the hub by the wheel angle (the rim is a torus about that axis, so
 * the carried glove stays exactly where the build wrapped it), a two-bone IK on upperarm/lowerarm keeping the elbow on its
 * clip side, and the hand's world orientation set to the carried bind orientation. A hand that cannot reach the carried
 * grip slides back along the rim to the largest turn it reaches (a real driver's hand slips too). Render only (§V3).
 */
export function createHandGrip(
  lod: THREE.Object3D,
  grips: Readonly<Record<'l' | 'r', BindGrip>>,
  hub: THREE.Vector3,
  axis: THREE.Vector3,
  lever?: LeverGrip,
): ((wheelRad: number, onLever?: { reach: number; leverRad: number; fingers: number }) => void) | null {
  const arms = (['l', 'r'] as const).map((s) => ({
    side: s,
    upper: lod.getObjectByName(`upperarm_${s}`),
    lower: lod.getObjectByName(`lowerarm_${s}`),
    hand: lod.getObjectByName(`hand_${s}`),
    grip: grips[s],
  }));
  if (arms.some((a) => !a.upper || !a.lower || !a.hand || a.hand.parent !== a.lower || a.lower.parent !== a.upper)) return null;
  const ax = axis.clone().normalize();
  const leverAx = lever ? lever.axis.clone().normalize() : null;
  /** carried grip for a turn, pilot frame → world */
  const target = (g: BindGrip, rad: number, out: THREE.Vector3): THREE.Vector3 =>
    out.copy(g.position).sub(hub).applyAxisAngle(ax, rad).add(hub).applyMatrix4(lod.matrixWorld);
  const spine = ['spine_01', 'spine_02', 'spine_03'].map((n) => lod.getObjectByName(n)).filter((o): o is THREE.Object3D => o !== undefined);
  const armR = arms[1];
  /** the right hand's finger bones, their lever grip and its opened approach pose */
  const fingersR: { bone: THREE.Object3D; wrap: THREE.Quaternion; open: THREE.Quaternion }[] = [];
  if (lever) {
    for (const [name, wrap] of lever.fingers) {
      const bone = (armR.hand as THREE.Object3D).getObjectByName(name);
      if (bone) fingersR.push({ bone, wrap, open: lever.open.get(name) ?? wrap });
    }
  }
  const leverUp = new THREE.Vector3();
  const leverBack = new THREE.Vector3();
  /**
   * The cine writes bones no clip may key (spine_01, the fingers: `idle_seated` keys only spine_02/03), and the mixer only
   * writes a binding whose value changed — so a write would outlive its frame and the take. Each call first undoes last
   * frame's writes the mixer did not replace, then takes the base the lean and the wrap start from.
   */
  const touched = lever ? [...spine, ...fingersR.map((f) => f.bone)].map((bone) => ({ bone, base: new THREE.Quaternion(), wrote: new THREE.Quaternion(), on: false })) : [];
  /** the lever grip for a lever turn, world */
  const leverTarget = (rad: number, out: THREE.Vector3): THREE.Vector3 =>
    out.copy((lever as LeverGrip).grip.position).sub((lever as LeverGrip).pivot).applyAxisAngle(leverAx as THREE.Vector3, rad).add((lever as LeverGrip).pivot).applyMatrix4(lod.matrixWorld);
  return (wheelRad, onLever) => {
    for (const w of touched) {
      if (w.on && w.bone.quaternion.equals(w.wrote)) w.bone.quaternion.copy(w.base);
      w.on = false;
    }
    if (onLever) for (const w of touched) w.base.copy(w.bone.quaternion);
    lod.updateMatrixWorld(true);
    worldQuat(lod, _qLod);
    // CINE: past idle the handle runs out of the arm's reach (full lever: 63 cm from the shoulder, arm 52 cm). The pilot
    // leans into the push first — up to LEAN_MAX shared over the three spine bones, BEFORE either arm is solved so the
    // left hand stays glued — and the lever (node and hand together, `onLever.leverRad` is written back) stops where
    // even the lean runs out.
    if (lever && leverAx && onLever && onLever.reach > 0 && spine.length === 3) {
      const k = ease(clamp01(onLever.reach));
      const armLen = (): number => {
        _S.setFromMatrixPosition((armR.upper as THREE.Object3D).matrixWorld);
        _E.setFromMatrixPosition((armR.lower as THREE.Object3D).matrixWorld);
        _W.setFromMatrixPosition((armR.hand as THREE.Object3D).matrixWorld);
        return REACH_MAX * (_E.distanceTo(_S) + _W.distanceTo(_E));
      };
      const reach = armLen();
      let lean = 0;
      for (let it = 0; it < 4; it++) {
        const excess = leverTarget(onLever.leverRad, _L).distanceTo(_S) - reach;
        if (excess <= 1e-4 || lean >= LEAN_MAX * k) break;
        for (const bone of spine) {
          _W.setFromMatrixPosition(bone.matrixWorld);
          _d1.subVectors(_S, _W);
          const arm = _d1.length();
          _d1.normalize();
          _d2.subVectors(_L, _W).normalize();
          const full = Math.acos(Math.min(1, Math.max(-1, _d1.dot(_d2))));
          const step = Math.min(full, excess / arm / spine.length, (LEAN_MAX * k - lean) / spine.length);
          if (step <= 0) continue;
          _u.crossVectors(_d1, _d2).normalize();
          _d2.copy(_d1).applyAxisAngle(_u, step);
          turnBone(bone, _d1, _d2);
          lean += step;
          armLen(); // the shoulder moved
        }
      }
      if (leverTarget(onLever.leverRad, _L).distanceTo(_S) > reach) {
        let lo = 0;
        let hi = onLever.leverRad;
        for (let i = 0; i < 8; i++) {
          const mid = (lo + hi) / 2;
          if (leverTarget(mid, _L).distanceTo(_S) > reach) hi = mid;
          else lo = mid;
        }
        onLever.leverRad = lo;
      }
    }
    for (const arm of arms) {
      const upper = arm.upper as THREE.Object3D;
      const lower = arm.lower as THREE.Object3D;
      const hand = arm.hand as THREE.Object3D;
      _S.setFromMatrixPosition(upper.matrixWorld);
      _E.setFromMatrixPosition(lower.matrixWorld);
      _W.setFromMatrixPosition(hand.matrixWorld);
      const a = _E.distanceTo(_S);
      const b = _W.distanceTo(_E);
      const reach = REACH_MAX * (a + b);
      let rad = Number.isFinite(wheelRad) ? wheelRad : 0;
      if (target(arm.grip, rad, _T).distanceTo(_S) > reach) {
        let lo = 0;
        let hi = rad;
        for (let i = 0; i < 8; i++) {
          const mid = (lo + hi) / 2;
          if (target(arm.grip, mid, _T).distanceTo(_S) > reach) hi = mid;
          else lo = mid;
        }
        rad = lo;
        target(arm.grip, rad, _T);
      }
      // CINE (cineThrottle): the right hand eased from its rim grip to the lever grip carried round the lever pivot
      const k = arm.side === 'r' && lever && leverAx && onLever ? ease(clamp01(onLever.reach)) : 0;
      if (k > 0 && lever && leverAx && onLever) {
        _T.lerp(leverTarget(onLever.leverRad, _L), k);
        // come down onto the handles from above instead of through them
        leverUp.copy(lever.up).applyAxisAngle(leverAx, onLever.leverRad).transformDirection(lod.matrixWorld);
        _T.addScaledVector(leverUp, LEVER_APPROACH_M * Math.sin(Math.PI * clamp01(onLever.reach)));
        _T.addScaledVector(leverBack.copy(lever.up).cross(leverAx).applyAxisAngle(leverAx, onLever.leverRad).transformDirection(lod.matrixWorld), 0.5 * LEVER_APPROACH_M * Math.sin(Math.PI * clamp01(onLever.reach)));
      }
      _u.subVectors(_T, _S);
      const d = Math.min(Math.max(_u.length(), Math.abs(a - b) + 1e-4), reach);
      _u.normalize();
      _v.subVectors(_E, _S);
      _v.addScaledVector(_u, -_v.dot(_u));
      if (_v.lengthSq() < 1e-12) continue; // arm dead straight at the target: nothing to bend
      _v.normalize();
      const cosA = Math.min(1, Math.max(-1, (a * a + d * d - b * b) / (2 * a * d)));
      // upper arm: shoulder → new elbow
      _d1.subVectors(_E, _S).normalize();
      _d2.copy(_u).multiplyScalar(cosA).addScaledVector(_v, Math.sqrt(1 - cosA * cosA)).normalize();
      turnBone(upper, _d1, _d2);
      // forearm: new elbow → the grip
      _E.setFromMatrixPosition(lower.matrixWorld);
      _W.setFromMatrixPosition(hand.matrixWorld);
      _d1.subVectors(_W, _E).normalize();
      _d2.copy(_S).addScaledVector(_u, d).sub(_E).normalize();
      turnBone(lower, _d1, _d2);
      // hand: the bind orientation carried round the hub
      _qr.setFromAxisAngle(ax, rad);
      _qw.copy(_qLod).multiply(_qr).multiply(arm.grip.quaternion);
      if (k > 0 && lever && leverAx && onLever) {
        _qL.setFromAxisAngle(leverAx, onLever.leverRad);
        _qL.premultiply(_qLod).multiply(lever.grip.quaternion);
        _qw.slerp(_qL, k);
      }
      worldQuat(lower, _q2).invert();
      hand.quaternion.copy(_q2.multiply(_qw)).normalize();
      if (k > 0 && lever && onLever) {
        // open on the way over (half the reach), close round the handles once the hand is down (onLever.fingers, timed)
        const open = ease(clamp01(onLever.reach / 0.5));
        const shut = ease(clamp01(onLever.fingers));
        for (const f of fingersR) f.bone.quaternion.slerp(f.open, open).slerp(f.wrap, shut);
      }
      hand.updateMatrixWorld(true);
    }
    if (onLever) {
      for (const w of touched) {
        w.wrote.copy(w.bone.quaternion);
        w.on = true;
      }
    }
  };
}

/** the helm node's turn about its own pivot/axis (body frame extras), on top of its rest matrix; null without the node */
export function createHelmTurn(boat: THREE.Object3D): ((wheelRad: number) => void) | null {
  const helm = boat.getObjectByName('Helm_LOD0');
  const ex = (helm?.userData ?? {}) as { pivot?: number[]; axis?: number[] };
  const ok = (v: number[] | undefined): v is number[] => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
  if (!helm || !ok(ex.pivot) || !ok(ex.axis)) return null;
  const pivot = new THREE.Vector3(...ex.pivot);
  const axis = new THREE.Vector3(...ex.axis).normalize();
  helm.updateMatrix();
  const rest = helm.matrix.clone();
  helm.matrixAutoUpdate = false;
  const m = new THREE.Matrix4();
  const t = new THREE.Matrix4();
  let last = Number.NaN;
  return (rad) => {
    if (rad === last) return;
    last = rad;
    // T(p) · R · T(−p) · rest
    m.makeTranslation(pivot.x, pivot.y, pivot.z).multiply(t.makeRotationAxis(axis, rad)).multiply(t.makeTranslation(-pivot.x, -pivot.y, -pivot.z));
    helm.matrix.multiplyMatrices(m, rest);
    helm.matrixWorldNeedsUpdate = true;
  };
}

/**
 * CINE: the throttle lever node's turn about its own pivot/axis (body frame extras) on top of its rest matrix (rest =
 * idle), plus the extras. Null without the node or its extras. Same construction as `createHelmTurn`.
 */
export function createLeverTurn(boat: THREE.Object3D): { turn(rad: number): void; pivot: THREE.Vector3; axis: THREE.Vector3; sweepRad: number } | null {
  const node = boat.getObjectByName('Throttle_LOD0');
  const ex = (node?.userData ?? {}) as { pivot?: number[]; axis?: number[]; idleDeg?: number; fullDeg?: number };
  const ok = (v: number[] | undefined): v is number[] => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
  if (!node || !ok(ex.pivot) || !ok(ex.axis) || !Number.isFinite(ex.idleDeg) || !Number.isFinite(ex.fullDeg)) return null;
  const pivot = new THREE.Vector3(...ex.pivot);
  const axis = new THREE.Vector3(...ex.axis).normalize();
  node.updateMatrix();
  const rest = node.matrix.clone();
  const m = new THREE.Matrix4();
  const t = new THREE.Matrix4();
  let last = 0;
  return {
    pivot,
    axis,
    sweepRad: (((ex.fullDeg as number) - (ex.idleDeg as number)) * Math.PI) / 180,
    turn(rad) {
      if (rad === last) return;
      last = rad;
      node.matrixAutoUpdate = false;
      m.makeTranslation(pivot.x, pivot.y, pivot.z).multiply(t.makeRotationAxis(axis, rad)).multiply(t.makeTranslation(-pivot.x, -pivot.y, -pivot.z));
      node.matrix.multiplyMatrices(m, rest);
      node.matrixWorldNeedsUpdate = true;
    },
  };
}

// ── FINGER GRIPS (trailer close-ups) ──────────────────────────────────────────────────────────────────────────────
//
// Both grips are finger-bone rotations solved once at seat time against the real geometry, on the hero bind and the
// LOD0 glove: each phalanx carries the glove vertices it dominates rigidly, the target is a signed distance function,
// and a grid over (spread, MCP, PIP, DIP) per finger takes the pose that touches without sinking in, inside a natural
// curl range. RIM: the hand stays where the bake glued it; the fingers wrap the rim torus (the bake left them ~8 mm off).
// LEVER (cine): the palm rests on top of/behind the three handle heads, index / middle / ring each curl over the front
// of their own handle (index on the inboard one), the pinky relaxed beside, the thumb along the inboard handle's side.

const GRIP_FINGERS = ['index', 'middle', 'ring', 'pinky'] as const;
/** a phalanx rests this far off what it grips, and never nearer than GRIP_CLEAR_M (m) */
const GRIP_GAP_M = 0.004;
const GRIP_CLEAR_M = 0.003;
const DEG = Math.PI / 180;
/** the lever grip's natural curl ranges (deg): MCP, PIP, DIP of index / middle / ring */
const LEVER_CURL: [number, number][] = [[30, 65], [50, 95], [15, 50]];

/** a hand in the seated bind, pilot frame: its frame, joints and the glove vertices each bone carries (bone-local) */
interface HandModel {
  wrist: THREE.Vector3;
  handQ: THREE.Quaternion;
  /** wrist -> middle knuckle */
  h: THREE.Vector3;
  /** pinky -> index knuckle */
  k: THREE.Vector3;
  /** palm side (where the bind fingers curl) */
  p: THREE.Vector3;
  /** + rotation about it curls h toward p */
  flex: THREE.Vector3;
  chains: Record<string, { names: string[]; heads: THREE.Vector3[]; lengths: number[]; bindQ: THREE.Quaternion[]; local: THREE.Vector3[][] }>;
  palm: THREE.Vector3[];
}

function handModel(root: THREE.Object3D, s: 'l' | 'r'): HandModel | null {
  let mesh: THREE.SkinnedMesh | undefined;
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && /^Pilot_M_Pilot_LOD0$/.test(o.name)) mesh = o as THREE.SkinnedMesh;
  });
  const hand = root.getObjectByName(`hand_${s}`);
  if (!mesh || !hand) return null;
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();
  const pose = (name: string): { p: THREE.Vector3; q: THREE.Quaternion } | null => {
    const o = root.getObjectByName(name);
    if (!o) return null;
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    toRoot.clone().multiply(o.matrixWorld).decompose(p, q, new THREE.Vector3());
    return { p, q };
  };
  const hp = pose(`hand_${s}`) as { p: THREE.Vector3; q: THREE.Quaternion };
  const chains: HandModel['chains'] = {};
  for (const f of [...GRIP_FINGERS, 'thumb']) {
    const names = [1, 2, 3].map((i) => `${f}_0${i}_${s}`);
    const poses = names.map(pose);
    if (poses.some((x) => !x)) return null;
    const ps = poses as { p: THREE.Vector3; q: THREE.Quaternion }[];
    chains[f] = { names, heads: ps.map((x) => x.p), lengths: [ps[1].p.distanceTo(ps[0].p), ps[2].p.distanceTo(ps[1].p), 0], bindQ: ps.map((x) => x.q), local: [[], [], []] };
  }
  const m = mesh as THREE.SkinnedMesh;
  const pos = m.geometry.getAttribute('position');
  const si = m.geometry.getAttribute('skinIndex');
  const sw = m.geometry.getAttribute('skinWeight');
  const toMesh = toRoot.clone().multiply(m.matrixWorld); // identity for the bind the build exports
  const morphs = m.geometry.morphAttributes.position ?? []; // relative (glTF): a variant's shape
  const palm: THREE.Vector3[] = [];
  const inv = new THREE.Quaternion();
  const owner: (string | null)[] = [];
  const at: THREE.Vector3[] = [];
  for (let i = 0; i < pos.count; i++) {
    let b = 0;
    for (let j = 1; j < 4; j++) if (sw.getComponent(i, j) > sw.getComponent(i, b)) b = j;
    const name = m.skeleton.bones[si.getComponent(i, b)].name;
    owner.push(name.endsWith(`_${s}`) && /^(hand|index|middle|ring|pinky|thumb)(_0[123])?_[lr]$/.test(name) ? name : null);
    const v = new THREE.Vector3().fromBufferAttribute(pos, i);
    morphs.forEach((mp, j) => v.addScaledVector(_fa.fromBufferAttribute(mp, i), m.morphTargetInfluences?.[j] ?? 0));
    at.push(v.applyMatrix4(toMesh));
  }
  const add = (name: string, v: THREE.Vector3): void => {
    if (name === `hand_${s}`) {
      palm.push(v);
      return;
    }
    const mm = /^(index|middle|ring|pinky|thumb)_0([123])_[lr]$/.exec(name) as RegExpExecArray;
    const c = chains[mm[1]];
    const i3 = Number(mm[2]) - 1;
    c.local[i3].push(v.clone().sub(c.heads[i3]).applyQuaternion(inv.copy(c.bindQ[i3]).invert()));
  };
  owner.forEach((name, i) => name && add(name, at[i]));
  // edge midpoints too: an 8 mm glove edge can cut a handle's rounded corner with both its vertices outside
  const index = m.geometry.getIndex();
  const seen = new Set<number>();
  for (let t = 0; index && t < index.count; t += 3) {
    for (let e = 0; e < 3; e++) {
      const i = index.getX(t + e);
      const j = index.getX(t + ((e + 1) % 3));
      const key = Math.min(i, j) * pos.count + Math.max(i, j);
      const [ni, nj] = [owner[i], owner[j]];
      if (!ni || !nj || seen.has(key)) continue;
      // across a knuckle the midpoint rides the distal bone (it is placed half-blended there, see phalanxGap)
      const fi = ni.split('_')[0];
      if (ni !== nj && (fi !== nj.split('_')[0] || ni.startsWith('hand') || nj.startsWith('hand'))) continue;
      seen.add(key);
      add(ni > nj ? ni : nj, at[i].clone().add(at[j]).multiplyScalar(0.5));
    }
  }
  for (const c of Object.values(chains)) {
    // the distal phalanx's length: its glove vertices' reach along the bone
    c.lengths[2] = Math.max(0.015, ...c.local[2].map((v) => v.y));
  }
  const W = hp.p;
  const h = chains.middle.heads[0].clone().sub(W).normalize();
  const k = chains.index.heads[0].clone().sub(chains.pinky.heads[0]);
  k.addScaledVector(h, -k.dot(h)).normalize();
  const p = new THREE.Vector3().crossVectors(h, k);
  if (chains.middle.heads[2].clone().sub(chains.middle.heads[0]).dot(p) < 0) p.negate(); // the bind fingers curl to the palm
  return { wrist: W, handQ: hp.q, h, k, p, flex: new THREE.Vector3().crossVectors(h, p).normalize(), chains, palm };
}

/** a rigid move of the whole bind hand: v -> q (v - wrist) + to */
interface HandMove {
  q: THREE.Quaternion;
  to: THREE.Vector3;
}

const _fa = new THREE.Vector3();
const _fb = new THREE.Vector3();
const _fq = new THREE.Quaternion();
const _Y = new THREE.Vector3(0, 1, 0);

/** world quaternion of a phalanx pointing along `u` (bind twist kept: the shortest arc from its bind direction) */
function phalanxQ(bindQ: THREE.Quaternion, u: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  _fa.copy(_Y).applyQuaternion(bindQ);
  return out.setFromUnitVectors(_fa, u).multiply(bindQ);
}

/**
 * min SDF over a phalanx's glove vertices placed at joint J with world quaternion q, then moved with the hand. Skinning
 * blends the vertices near the joint (bone-local y < 8 mm) half with the parent: `qParent` places those a second time
 * halfway, the way the palm side of a bent knuckle sinks under LBS.
 */
const _fq3 = new THREE.Quaternion();
function phalanxGap(verts: THREE.Vector3[], J: THREE.Vector3, q: THREE.Quaternion, move: HandMove, wrist: THREE.Vector3, sdf: (p: THREE.Vector3) => number, qParent?: THREE.Quaternion): number {
  let g = Infinity;
  if (qParent) _fq3.copy(qParent).slerp(q, 0.5);
  for (const v of verts) {
    _fb.copy(v).applyQuaternion(q).add(J).sub(wrist).applyQuaternion(move.q).add(move.to);
    g = Math.min(g, sdf(_fb));
    if (qParent && v.y < 0.01) {
      _fb.copy(v).applyQuaternion(_fq3).add(J).sub(wrist).applyQuaternion(move.q).add(move.to);
      g = Math.min(g, sdf(_fb));
    }
  }
  return g;
}

interface FingerPose {
  spread: number;
  flex: [number, number, number];
  cost: number;
}

/**
 * One finger's grid search. `contact` = the phalanges that should rest on the target (gap GRIP_GAP_M); every phalanx
 * stays out of it; `natural` the preferred MCP/PIP/DIP (deg); `spreadTo` the along-axis point the fingertip should sit
 * over (null = no preference).
 */
function solveFinger(
  H: HandModel,
  f: string,
  move: HandMove,
  sdf: (p: THREE.Vector3) => number,
  ranges: [number, number][],
  natural: [number, number, number],
  contact: [number, number, number],
  spreadTo: { axis: THREE.Vector3; at: number } | null,
  step = 5,
  /** extra cost of a fingertip position (pilot frame), e.g. 'curl over the front of the handle' */
  tipCost: ((tip: THREE.Vector3) => number) | null = null,
): FingerPose {
  const c = H.chains[f];
  let spread = 0;
  if (spreadTo) {
    let best = Infinity;
    for (let a = -16; a <= 16; a += 2) {
      _fa.copy(H.h).applyAxisAngle(H.p, a * DEG).multiplyScalar(0.06).add(c.heads[0]).sub(H.wrist).applyQuaternion(move.q).add(move.to);
      const e = Math.abs(_fa.dot(spreadTo.axis) - spreadTo.at);
      if (e < best) {
        best = e;
        spread = a;
      }
    }
  }
  const d = H.h.clone().applyAxisAngle(H.p, spread * DEG);
  const ax = H.flex.clone().applyAxisAngle(H.p, spread * DEG);
  const u = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const J = [c.heads[0].clone(), new THREE.Vector3(), new THREE.Vector3()];
  const q = [new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion()];
  // the phalanges are rigid here while LBS blends them at the joints (the palm side sinks ~1 mm there): 1.5 mm is kept
  const want = GRIP_GAP_M;
  const pen = (g: number): number => (g < GRIP_CLEAR_M ? 20 + (GRIP_CLEAR_M - g) * 4000 : 0);
  const touch = (g: number, w: number): number => (w ? w * 300 * Math.abs(g - want) : 0);
  let best: FingerPose = { spread, flex: natural, cost: Infinity };
  for (let a1 = ranges[0][0]; a1 <= ranges[0][1]; a1 += step) {
    u[0].copy(d).applyAxisAngle(ax, a1 * DEG);
    phalanxQ(c.bindQ[0], u[0], q[0]);
    const g1 = phalanxGap(c.local[0], J[0], q[0], move, H.wrist, sdf);
    const c1 = pen(g1) + touch(g1, contact[0]);
    J[1].copy(J[0]).addScaledVector(u[0], c.lengths[0]);
    for (let a2 = ranges[1][0]; a2 <= ranges[1][1]; a2 += step) {
      u[1].copy(d).applyAxisAngle(ax, (a1 + a2) * DEG);
      phalanxQ(c.bindQ[1], u[1], q[1]);
      const g2 = phalanxGap(c.local[1], J[1], q[1], move, H.wrist, sdf, q[0]);
      const c2 = c1 + pen(g2) + touch(g2, contact[1]);
      if (c2 > best.cost) continue;
      J[2].copy(J[1]).addScaledVector(u[1], c.lengths[1]);
      for (let a3 = ranges[2][0]; a3 <= ranges[2][1]; a3 += step) {
        u[2].copy(d).applyAxisAngle(ax, (a1 + a2 + a3) * DEG);
        phalanxQ(c.bindQ[2], u[2], q[2]);
        const g3 = phalanxGap(c.local[2], J[2], q[2], move, H.wrist, sdf, q[1]);
        let cost = c2 + pen(g3) + touch(g3, contact[2]) + 0.02 * (Math.abs(a1 - natural[0]) + Math.abs(a2 - natural[1]) + Math.abs(a3 - natural[2]));
        if (tipCost) cost += tipCost(_fb.copy(J[2]).addScaledVector(u[2], c.lengths[2]).sub(H.wrist).applyQuaternion(move.q).add(move.to));
        if (cost < best.cost) best = { spread, flex: [a1, a2, a3], cost };
      }
    }
  }
  return best;
}

/** bone-local quaternions (parent-relative) of a solved finger; independent of the hand's own move */
function fingerLocals(H: HandModel, f: string, pose: FingerPose, out: Map<string, THREE.Quaternion>): void {
  const c = H.chains[f];
  const d = H.h.clone().applyAxisAngle(H.p, pose.spread * DEG);
  const ax = H.flex.clone().applyAxisAngle(H.p, pose.spread * DEG);
  let parent = H.handQ.clone();
  let sum = 0;
  for (let i = 0; i < 3; i++) {
    sum += pose.flex[i];
    const w = phalanxQ(c.bindQ[i], d.clone().applyAxisAngle(ax, sum * DEG), new THREE.Quaternion()).clone();
    out.set(c.names[i], parent.clone().invert().multiply(w));
    parent = w;
  }
}

/** signed distance to a rounded box (half extents along ax/up/fore, corner radius r) */
function roundedBox(p: THREE.Vector3, c: THREE.Vector3, ax: THREE.Vector3, up: THREE.Vector3, fore: THREE.Vector3, half: [number, number, number], r: number): number {
  _fa.subVectors(p, c);
  const qx = Math.abs(_fa.dot(ax)) - (half[0] - r);
  const qy = Math.abs(_fa.dot(up)) - (half[1] - r);
  const qz = Math.abs(_fa.dot(fore)) - (half[2] - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - r;
}

/** the three ganged throttle handles (throttle.py: 26 x 60 x 40 mm, 8 mm bevel, 30 mm pitch), pilot frame, lever at idle */
export interface LeverHandles {
  centre: THREE.Vector3;
  axis: THREE.Vector3;
  up: THREE.Vector3;
  fore: THREE.Vector3;
}
export const HANDLE_HALF: [number, number, number] = [0.013, 0.0303, 0.0206];
export const HANDLE_PITCH_M = 0.03;
const HANDLE_BEVEL_M = 0.008;

export function leverHandleSdf(L: LeverHandles): (p: THREE.Vector3) => number {
  const c = [-1, 0, 1].map((i) => L.centre.clone().addScaledVector(L.axis, i * HANDLE_PITCH_M));
  return (p) => Math.min(roundedBox(p, c[0], L.axis, L.up, L.fore, HANDLE_HALF, HANDLE_BEVEL_M), roundedBox(p, c[1], L.axis, L.up, L.fore, HANDLE_HALF, HANDLE_BEVEL_M), roundedBox(p, c[2], L.axis, L.up, L.fore, HANDLE_HALF, HANDLE_BEVEL_M));
}

/** RIM: the fingers (not the thumb) re-wrapped onto the rim torus with the hand where the bake put it */
function solveRimFingers(H: HandModel, hub: THREE.Vector3, axis: THREE.Vector3, R: number, tube: number): Map<string, THREE.Quaternion> {
  const n = axis.clone().normalize();
  const rel = new THREE.Vector3();
  const sdf = (p: THREE.Vector3): number => {
    rel.subVectors(p, hub);
    const along = rel.dot(n);
    return Math.hypot(Math.sqrt(Math.max(0, rel.lengthSq() - along * along)) - R, along) - tube;
  };
  const still: HandMove = { q: new THREE.Quaternion(), to: H.wrist.clone() };
  const out = new Map<string, THREE.Quaternion>();
  for (const f of GRIP_FINGERS) {
    const pose = solveFinger(H, f, still, sdf, [[30, 80], [40, 100], [10, 50]], [55, 80, 40], f === 'pinky' ? [0.3, 1, 1] : [0.5, 1, 1], null);
    fingerLocals(H, f, pose, out);
  }
  return out;
}

/**
 * LEVER: the hand placed on the handle bank (palm tilt and knuckle position searched), index / middle / ring on their
 * own handles, pinky relaxed, thumb laid along the inboard handle's outer side. Returns the hand bone's pose (pilot
 * frame, lever at idle) and every finger bone's local rotation.
 */
function solveLeverHand(H: HandModel, L: LeverHandles): (BindGrip & { fingers: Map<string, THREE.Quaternion>; open: Map<string, THREE.Quaternion>; up: THREE.Vector3 }) | null {
  const sdf = leverHandleSdf(L);
  const bindM = new THREE.Matrix4().makeBasis(H.h, H.k, H.p);
  const handed = Math.sign(bindM.determinant());
  const own = { index: 1, middle: 0, ring: -1 } as const;
  type Placement = { cost: number; move: HandMove; poses: Record<string, FingerPose> };
  let best: Placement | null = null as Placement | null;
  const mcpMid = H.chains.middle.heads[0];
  // index / middle / ring curl OVER the front: the fingertip ends in front of the handle's front face and below its top
  const rel = new THREE.Vector3();
  const overFront = (tip: THREE.Vector3): number => {
    rel.subVectors(tip, L.centre);
    const f = HANDLE_HALF[2] + 0.004 - rel.dot(L.fore);
    const u = rel.dot(L.up) - (HANDLE_HALF[1] - 0.012);
    return (f > 0 ? 2 + f * 400 : 0) + (u > 0 ? 2 + u * 400 : 0);
  };
  for (const tilt of [45, 60]) {
    const pt = L.up.clone().multiplyScalar(-Math.cos(tilt * DEG)).addScaledVector(L.fore, Math.sin(tilt * DEG));
    const kt = L.axis.clone();
    const ht = new THREE.Vector3().crossVectors(kt, pt).multiplyScalar(handed);
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(ht, kt, pt).multiply(bindM.clone().transpose()));
    for (let eu = 0.01; eu <= 0.0301; eu += 0.004) {
      for (let ef = -0.05; ef <= -0.0099; ef += 0.005) {
        // the middle knuckle over the middle handle, eu above its top, ef along fore from its centre
        const knuckle = L.centre.clone().addScaledVector(L.up, HANDLE_HALF[1] + eu).addScaledVector(L.fore, ef);
        const to = knuckle.sub(mcpMid.clone().sub(H.wrist).applyQuaternion(q));
        const move: HandMove = { q, to };
        let palmGap = Infinity;
        for (const v of H.palm) {
          _fb.copy(v).sub(H.wrist).applyQuaternion(q).add(to);
          palmGap = Math.min(palmGap, sdf(_fb));
        }
        if (palmGap < 0.0008) continue;
        let cost = 1500 * Math.abs(palmGap - 0.002); // the palm RESTS on the handle heads
        if (best && cost > best.cost) continue;
        const poses: Record<string, FingerPose> = {};
        for (const f of GRIP_FINGERS) {
          const target = f === 'pinky' ? null : { axis: L.axis, at: L.centre.dot(L.axis) + own[f] * HANDLE_PITCH_M };
          poses[f] = solveFinger(H, f, move, sdf, f === 'pinky' ? [[20, 80], [30, 100], [15, 50]] : LEVER_CURL, f === 'pinky' ? [50, 60, 30] : [52, 80, 38], f === 'pinky' ? [0, 0, 0] : [0.4, 1, 1], target, 10, f === 'pinky' ? null : overFront);
          cost += poses[f].cost;
          if (best && cost > best.cost) break;
        }
        if (!best || cost < best.cost) best = { cost, move, poses };
      }
    }
  }
  if (!best || best.cost > 1e3) return null;
  const fingers = new Map<string, THREE.Quaternion>();
  const open = new Map<string, THREE.Quaternion>();
  for (const f of GRIP_FINGERS) {
    const fine = solveFinger(H, f, best.move, sdf, f === 'pinky' ? [[20, 80], [30, 100], [15, 50]] : LEVER_CURL, f === 'pinky' ? [50, 60, 30] : [52, 80, 38], f === 'pinky' ? [0, 0, 0] : [0.4, 1, 1], f === 'pinky' ? null : { axis: L.axis, at: L.centre.dot(L.axis) + own[f] * HANDLE_PITCH_M }, 2.5, f === 'pinky' ? null : overFront);
    fingerLocals(H, f, fine.cost < Infinity ? fine : best.poses[f], fingers);
    const chosen = fine.cost < Infinity ? fine : best.poses[f];
    fingerLocals(H, f, { ...chosen, flex: [chosen.flex[0] * 0.25, chosen.flex[1] * 0.3, chosen.flex[2] * 0.3] }, open);
  }
  thumbAlongSide(H, best.move, L, sdf, fingers);
  for (const n of H.chains.thumb.names) {
    const q = fingers.get(n);
    if (q) open.set(n, q); // the thumb goes straight to the side of the bank
  }
  return { position: best.move.to.clone(), quaternion: best.move.q.clone().multiply(H.handQ), fingers, open, up: L.up.clone() };
}

/** the thumb laid down the inboard handle's outer side: CCD of the thumb tip onto a line there, pushed out until clear */
function thumbAlongSide(H: HandModel, move: HandMove, L: LeverHandles, sdf: (p: THREE.Vector3) => number, out: Map<string, THREE.Quaternion>): void {
  const c = H.chains.thumb;
  const inv = move.q.clone().invert();
  const toBind = (p: THREE.Vector3): THREE.Vector3 => p.clone().sub(move.to).applyQuaternion(inv).add(H.wrist);
  const u = c.bindQ.map((q) => _Y.clone().applyQuaternion(q));
  const J = c.heads.map((x) => x.clone());
  const fk = (): THREE.Vector3 => {
    for (let i = 1; i < 3; i++) J[i].copy(J[i - 1]).addScaledVector(u[i - 1], c.lengths[i - 1]);
    return J[2].clone().addScaledVector(u[2], c.lengths[2]);
  };
  const qs = (): THREE.Quaternion[] => u.map((d, i) => phalanxQ(c.bindQ[i], d, new THREE.Quaternion()));
  const rest = u.map((x) => x.clone());
  for (let push = 0; push < 12; push++) {
    for (let i = 0; i < 3; i++) u[i].copy(rest[i]);
    const side = HANDLE_HALF[0] + HANDLE_PITCH_M + 0.009 + push * 0.002;
    const target = toBind(L.centre.clone().addScaledVector(L.axis, side).addScaledVector(L.up, -0.012).addScaledVector(L.fore, -0.008));
    for (let it = 0; it < 24; it++) {
      for (let i = 2; i >= 0; i--) {
        const tip = fk();
        _fa.subVectors(tip, J[i]).normalize();
        _fb.subVectors(target, J[i]).normalize();
        const ang = Math.acos(Math.min(1, Math.max(-1, _fa.dot(_fb))));
        const w = [0.35, 0.8, 1][i];
        const axis = new THREE.Vector3().crossVectors(_fa, _fb);
        if (axis.lengthSq() < 1e-12) continue;
        _fq.setFromAxisAngle(axis.normalize(), Math.min(ang * w, 20 * DEG));
        for (let j = i; j < 3; j++) u[j].applyQuaternion(_fq);
      }
      if (fk().distanceTo(target) < 0.002) break;
    }
    fk();
    const q = qs();
    let gap = Infinity;
    for (let i = 0; i < 3; i++) gap = Math.min(gap, phalanxGap(c.local[i], J[i], q[i], move, H.wrist, sdf));
    if (gap >= 0.0008 || push === 11) {
      let parent = H.handQ.clone();
      for (let i = 0; i < 3; i++) {
        out.set(c.names[i], parent.clone().invert().multiply(q[i]));
        parent = q[i];
      }
      return;
    }
  }
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

/** the hair cards' roughness floor and anisotropy cap (see `pilotNodeMaterial`) */
export const PILOT_HAIR_MIN_ROUGHNESS = 0.75;
export const PILOT_HAIR_MAX_ANISOTROPY = 0.4;

/**
 * A glTF physical/standard pilot material as the node material WebGPURenderer would draw it (the same property copy), so
 * the page can add node terms to it (page/boatLights.ts `lightPilots`: §T.209 night fill). Two look fixes ride along
 * (USER, sunset look-back: "flashy specular streaks/sparkles on the hair and/or the goggle headband that crawl"):
 *  - HAIR: roughness 0.55 → 0.75 and anisotropy 0.8 → 0.4. A strength-0.8 anisotropic lobe at 0.55 is a razor streak
 *    across every alpha-tested card.
 *  - EVERY SLOT: specular anti-aliasing off the SHADING normal's screen derivatives (normal map included; three's own
 *    geometry-roughness term sees only the mesh normal). Kaplanyan/Tokuyoshi: α² += min(½(|∂n/∂x|² + |∂n/∂y|²), 0.18),
 *    α = roughness². Sub-pixel normal-map relief (the strap's weave) widens the lobe instead of sparkling; where the
 *    relief is resolved the derivatives are ~0 and the authored roughness stands.
 */
export function pilotNodeMaterial(src: THREE.Material): THREE.Material {
  const s = src as THREE.MeshPhysicalMaterial;
  if ((src as THREE.NodeMaterial).isNodeMaterial || !s.isMeshStandardMaterial) return src;
  const m = s.isMeshPhysicalMaterial ? new THREE.MeshPhysicalNodeMaterial() : new THREE.MeshStandardNodeMaterial();
  (s.isMeshPhysicalMaterial ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial).prototype.copy.call(m as unknown as THREE.MeshPhysicalMaterial, s);
  if (s.name === 'M_PilotHair') {
    m.roughness = Math.max(m.roughness, PILOT_HAIR_MIN_ROUGHNESS);
    const pm = m as THREE.MeshPhysicalNodeMaterial;
    pm.anisotropy = Math.min(pm.anisotropy, PILOT_HAIR_MAX_ANISOTROPY);
  }
  const dx = dFdx(normalView);
  const dy = dFdy(normalView);
  const kernel = dx.dot(dx).add(dy.dot(dy)).mul(0.5).min(0.18);
  m.roughnessNode = materialRoughness.pow(4).add(kernel).clamp(0, 1).pow(0.25);
  return m;
}

/**
 * Seat a pilot in the hero and every NPC boat. Never throws: a missing or broken GLB logs ONE warning and returns
 * pilots that do nothing, so the race still runs (fail loud, keep racing).
 */
export async function createPilots(app: App, boats: { hero: BoatInstance; npcs: readonly BoatInstance[] }, opts: CreatePilotsOptions = {}): Promise<Pilots> {
  let gltf: GLTF;
  let materials: THREE.Material[];
  try {
    ({ gltf, materials } = await loadPilotGltf(app.renderer, opts.url ?? PILOT_URL));
  } catch (e) {
    return inertPilots(boats, e);
  }
  // §T.192: the same anisotropic filtering every boat texture gets (textures read mushy at grazing angles otherwise) —
  // over EVERY material, the NPC skin variants included (no mesh in the scene carries those until a pilot swaps them in)
  const allMaterials = new THREE.Group();
  for (const m of materials) allMaterials.add(new THREE.Mesh(undefined, m));
  applyTextureAnisotropy(allMaterials, app.renderer.getMaxAnisotropy());
  return seatPilots(gltf, materials, boats, opts.fovDeg ?? app.camera.fov);
}

/** pilots that do nothing, after ONE warning (fail loud, keep racing) */
function inertPilots(boats: { npcs: readonly unknown[] }, why: unknown): Pilots {
  const inert = (variant: PilotVariant): PilotInstance => ({
    variant,
    object: new THREE.Group(),
    setHeadVisible() {},
    eyeSource: () => false,
    update() {},
  });
  console.warn('[speedboat] pilot not seated:', why);
  return { hero: inert('hero'), npcs: boats.npcs.map((_, i) => inert(pilotVariantFor(i))), update() {}, dispose() {} };
}

/**
 * The loaded pilot GLB seated in every boat: what `createPilots` does after the load, with no renderer (tests build the
 * page's rig through this on the real GLBs). `materials` = every material the GLB declares (the NPC skin variants).
 */
export function seatPilots(gltf: GLTF, materials: readonly THREE.Material[], boats: { hero: BoatInstance; npcs: readonly BoatInstance[] }, fov: number): Pilots {
  const fallback = (why: unknown): Pilots => inertPilots(boats, why);
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
  const nodeCopies = new Map<THREE.Material, THREE.Material>();
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
  // §T.203: `throttle_push` is NOT scrubbed. It takes the right hand off the wheel from the first % of throttle (its first
  // 0.3 s is the reach, so any race throttle left the hand 9–18 cm off the rim in mid-air) to a lever that never moves.
  const missing = [['seated_base', base], ['idle_seated', idle], ['steer_left', steerL], ['steer_right', steerR]]
    .filter(([, c]) => !c)
    .map(([n]) => n);
  if (missing.length) console.warn(`[speedboat] pilot clips missing: ${missing.join(', ')} (the pilot sits in the bind pose)`);
  const tmp1 = new THREE.Vector3();
  // §T.203 the hero bind's grips (pilot frame) and the rim they were wrapped on (pilot extras `helm`, from the parts build)
  const helm = parse<{ hub?: number[]; axis?: number[] }>(extras.helm);
  root.updateMatrixWorld(true);
  const bindGrip = (s: 'l' | 'r'): BindGrip | null => {
    const hand = root.getObjectByName(`hand_${s}`);
    if (!hand) return null;
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    root.matrixWorld.clone().invert().multiply(hand.matrixWorld).decompose(position, quaternion, tmp1);
    return { position, quaternion };
  };
  const gl = bindGrip('l');
  const gr = bindGrip('r');
  const grips = gl && gr && helm?.hub?.length === 3 && helm.axis?.length === 3
    ? { l: gl, r: gr, hub: new THREE.Vector3(...helm.hub), axis: new THREE.Vector3(...helm.axis) }
    : null;
  if (!grips) console.warn('[speedboat] pilot helm grips missing (extras helm / hand bones): hands follow the clips unglued');
  // FINGER GRIPS (see the section above): solved once on the hero bind. RIM: both hands' fingers, applied to every
  // pilot. CINE (cineThrottle, hero only): the right hand's pose on the handle bank at idle and its finger rotations,
  // from the boat's `partsSockets.throttleHandle` (pilot frame = boat frame − the seat socket).
  const rimSpec = parse<{ hub?: number[]; axis?: number[]; rimRadius?: number; rimTube?: number }>(extras.helm);
  const rimOk = rimSpec?.hub?.length === 3 && rimSpec.axis?.length === 3 && typeof rimSpec.rimRadius === 'number' && typeof rimSpec.rimTube === 'number';
  /** both hands' fingers wrapped on the rim, solved on a pilot's own (re-bound, morphed) hands; empty when anything is missing */
  const rimFingersOf = (pilot: THREE.Object3D): Map<string, THREE.Quaternion> => {
    const out = new Map<string, THREE.Quaternion>();
    const hl = handModel(pilot, 'l');
    const hr = handModel(pilot, 'r');
    if (!rimOk || !hl || !hr || !rimSpec) return out;
    for (const H of [hl, hr]) for (const [n, q] of solveRimFingers(H, new THREE.Vector3(...(rimSpec.hub as number[])), new THREE.Vector3(...(rimSpec.axis as number[])), rimSpec.rimRadius as number, rimSpec.rimTube as number)) out.set(n, q);
    return out;
  };
  if (!rimOk) console.warn('[speedboat] pilot rim finger wrap skipped (extras helm incomplete): the bake\'s fingers stay');
  const heroRight = handModel(root, 'r');
  const leverGripAtIdle = ((): (BindGrip & { fingers: Map<string, THREE.Quaternion>; open: Map<string, THREE.Quaternion>; up: THREE.Vector3 }) | null => {
    const th = parse<{ throttleHandle?: { position?: number[]; pivot?: number[]; axis?: number[] } }>(boats.hero.object.userData.partsSockets)?.throttleHandle;
    if (!heroRight || th?.position?.length !== 3 || th.pivot?.length !== 3 || th.axis?.length !== 3) return null;
    const axis = new THREE.Vector3(...th.axis).normalize();
    const up = new THREE.Vector3(...th.position).sub(new THREE.Vector3(...th.pivot));
    up.addScaledVector(axis, -up.dot(axis)).normalize();
    const centre = new THREE.Vector3(...th.position).sub(new THREE.Vector3(...socket));
    const solved = solveLeverHand(heroRight, { centre, axis, up, fore: new THREE.Vector3().crossVectors(axis, up) });
    if (!solved) console.warn('[speedboat] pilot lever grip: no pose clears the throttle handles (the cine hand stays on the rim)');
    return solved;
  })();

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
      // one node copy per GLB material, shared by every pilot that wears it (as the GLB materials were)
      const src = mesh.material as THREE.Material;
      if (!nodeCopies.has(src)) nodeCopies.set(src, pilotNodeMaterial(src));
      mesh.material = nodeCopies.get(src) as THREE.Material;
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
        // §T.203 ROOT CAUSE of "hands an inch off the wheel": `SkeletonUtils.clone` gives every clone a Skeleton that
        // SHARES the source's `boneInverses` array, and `calculateInverses` refills that array in place — so each NPC
        // re-bind rewrote the hero's (and every other pilot's) inverse binds, and the hero's glove was skinned with the
        // last NPC's proportions: 3.5–6 cm off the rim. A fresh array per clone keeps the re-bind to this pilot.
        mesh.skeleton.boneInverses = [];
        mesh.skeleton.calculateInverses();
      }
    }

    // the rim finger wrap AFTER the re-bind: inverse binds taken with the fingers turned would bind the glove to them
    lod.updateMatrixWorld(true);
    for (const [name, q] of rimFingersOf(lod)) lod.getObjectByName(name)?.quaternion.copy(q);
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
    const times: PilotClipTimes = { steerLeft: 0, steerRight: 0, throttle: 0 };
    boat.object.add(lod);
    const turnHelm = createHelmTurn(boat.object);
    // CINE throttle hand: hero only, and only when the lever node, its extras and the bake's lever grip all exist
    const leverTurn = variant === 'hero' && leverGripAtIdle ? createLeverTurn(boat.object) : null;
    const lever: LeverGrip | undefined = leverTurn && leverGripAtIdle
      ? { grip: leverGripAtIdle, fingers: leverGripAtIdle.fingers, open: leverGripAtIdle.open, up: leverGripAtIdle.up, pivot: leverTurn.pivot.clone().sub(lod.position), axis: leverTurn.axis }
      : undefined;
    const onLever = { reach: 0, leverRad: 0, fingers: 0 };
    const glue = grips ? createHandGrip(lod, grips, grips.hub, grips.axis, lever) : null;

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
        const cine = lever !== undefined && leverTurn !== null && cineThrottle.active;
        onLever.reach = cine ? clamp01(cineThrottle.reach) : 0;
        const step = (Number.isFinite(dt) && dt > 0 ? dt : 0) / LEVER_FINGERS_S;
        onLever.fingers = clamp01(onLever.reach >= LEVER_FINGERS_AT ? onLever.fingers + step : onLever.fingers - step);
        onLever.leverRad = cine && leverTurn ? leverTurn.sweepRad * clamp01(cineThrottle.lever) : 0;
        mixer.update(Number.isFinite(dt) && dt > 0 ? dt : 0);
        const wheel = wheelAngleFor(Number.isFinite(c.steer) ? c.steer : 0);
        turnHelm?.(wheel);
        glue?.(wheel, cine ? onLever : undefined);
        leverTurn?.turn(onLever.leverRad); // after the glue: it stops the lever where the hand can hold it
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
