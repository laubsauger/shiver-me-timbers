/**
 * RACE CAMERA for the speedboat (§T.182 S2; design doc §6; tech-research §7). A NEW rig, not a FollowCam mode:
 * followCam keeps pirate/raft behaviour bit-for-bit, and its heading read (`atan2(fwd.x, fwd.z)`) breaks when a bow
 * points up — which a speedboat does. Render-side (§V3): reads the interpolated boat pose, never writes sim state.
 *
 * RIGS
 *  - chase  7.5 m back / 2.4 m up, FOV 60→76° with speed, ≤ 30% roll follow, heave low-passed (0.8 s).
 *  - near   4 m / 1.5 m, FOV 68→82°.
 *  - cockpit  rides the pilot's `cam_eye` node when `setEyeSource` provides it (else the hull-JSON seat anchor,
 *           raceCamEye.ts); head a lag on tilt beyond 12° (100% of the hull's pitch/roll up to 12°, the excess
 *           follows with a 0.25 s half-life); landing dip ≤ 6 cm; FOV 72→86°; `onCockpitChange` hides the head.
 *           Look back in the cockpit is the hoop mirror (the page reads `mirrorActive`), not a camera turn.
 *  - crash  world-anchored slow orbit about the crash point looking at the hull; returns with a blend. From the
 *           cockpit it cuts outside.
 *
 * FRAME-RATE INDEPENDENT (§T.167): every smoother is `dampMoving` (exact for a target moving linearly across the
 * frame), a rate limit, or an exact closed form (criticalSpring) — the path depends on scene time only.
 * QUATERNION-SAFE: heading from raceCamMath.blendHeading (never Euler); the chase offset is horizontal, so lookAt's
 * view never runs parallel to its up vector; the cockpit is composed as quaternions.
 */
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { quatFromAxisAngle, quatMul, rotateVec } from '../core/quat';
import type { CameraRig } from '../speedboat/page/seams';
import type { Quat } from '../state/simState';
import { dampMoving, wrapAngle } from './camMath';
import { cockpitEyeFallback } from './raceCamEye';
import {
  ballisticLanding,
  blendHeading,
  criticalSpring,
  hullYaw,
  moveToward,
  shakeOffsets,
  smoothstep,
  speedFov,
  tiltOf,
  velocityYaw,
} from './raceCamMath';

export type RaceCamMode = 'chase' | 'near' | 'cockpit' | 'crash';
export type RaceHeightFn = (x: number, z: number) => number;

/** what the camera reads each frame: the RENDER-interpolated boat (pose and velocity lerped on alpha) */
export interface RaceCamTarget {
  /** CG, world */
  position: readonly [number, number, number];
  quaternion: readonly [number, number, number, number];
  velocity: readonly [number, number, number];
  /** any hull triangle or gearcase in the water (false = airborne) */
  wet: boolean;
}

/** writes the cam_eye node's WORLD pose (three.js camera convention: looks down −Z); false = not available */
export type EyeSource = (outPosition: Vector3, outQuaternion: Quaternion) => boolean;

export interface RaceRig {
  distance: number;
  height: number;
  fovMin: number;
  fovMax: number;
  yawHalfLife: number;
}

export interface RaceCamParams {
  chase: RaceRig;
  near: RaceRig;
  cockpitFovMin: number;
  cockpitFovMax: number;
  /** look point ahead of the pivot along the heading, m, and above the CG */
  lookAhead: number;
  lookHeight: number;
  /** hull ↔ velocity heading blend time, s (tech-research §7: 0.25) */
  headingBlendSeconds: number;
  /** vertical pivot low-pass (design §6: 0.8 s time constant ⇒ half-life 0.8·ln2) */
  heaveHalfLife: number;
  /** fraction of the hull's heel the chase horizon follows (design §6: ≤ 30%) */
  rollFollow: number;
  rollHalfLife: number;
  /** above this tilt (or airborne) the roll follow fades out: a tumble never rolls the horizon */
  rollFollowMaxTiltDeg: number;
  /** airborne look target lifted this far toward the ballistic landing point (tech-research §7: 30%) */
  airLookToLanding: number;
  fovRateDegPerS: number;
  minHeightAboveWater: number;
  /** chase ↔ near blend, s */
  switchBlendSeconds: number;
  cockpitHeadFreeDeg: number;
  cockpitHeadHalfLife: number;
  /** landing dip: m per m/s of vertical speed lost, capped (design §6: 6 cm) */
  dipPerDeltaV: number;
  dipMax: number;
  dipOmega: number;
  /** slam shake: rad per m/s lost, capped, decaying */
  shakePerDeltaV: number;
  shakeMaxRad: number;
  shakeHalfLife: number;
  crashRadius: number;
  crashHeight: number;
  crashOrbitDegPerS: number;
  crashBlendInSeconds: number;
  crashReturnSeconds: number;
  /** design §9: reduced motion = no shake and no head bob / dip */
  reducedMotion: boolean;
}

const DEG = Math.PI / 180;

export const RACE_CAM_DEFAULTS: Readonly<RaceCamParams> = Object.freeze({
  chase: Object.freeze({ distance: 7.5, height: 2.4, fovMin: 60, fovMax: 76, yawHalfLife: 0.2 }),
  near: Object.freeze({ distance: 4, height: 1.5, fovMin: 68, fovMax: 82, yawHalfLife: 0.15 }),
  cockpitFovMin: 72,
  cockpitFovMax: 86,
  lookAhead: 6,
  lookHeight: 1.0,
  headingBlendSeconds: 0.25,
  heaveHalfLife: 0.8 * Math.LN2,
  rollFollow: 0.3,
  rollHalfLife: 0.15,
  rollFollowMaxTiltDeg: 60,
  airLookToLanding: 0.3,
  fovRateDegPerS: 20,
  minHeightAboveWater: 0.6,
  switchBlendSeconds: 0.35,
  cockpitHeadFreeDeg: 12,
  cockpitHeadHalfLife: 0.25,
  dipPerDeltaV: 0.02,
  dipMax: 0.06,
  dipOmega: 14,
  shakePerDeltaV: 0.004,
  shakeMaxRad: 1.5 * DEG,
  shakeHalfLife: 0.25,
  crashRadius: 14,
  crashHeight: 5,
  crashOrbitDegPerS: 12,
  crashBlendInSeconds: 0.5,
  crashReturnSeconds: 0.8,
  reducedMotion: false,
}) as Readonly<RaceCamParams>;

const CYCLE: readonly Exclude<RaceCamMode, 'crash'>[] = ['chase', 'near', 'cockpit'];
const Q_FLIP_Y: Quat = [0, 1, 0, 0]; // 180° about Y: body +z forward → camera −Z view

export class RaceCam {
  readonly params: RaceCamParams;
  /** cockpit only: the page shows the hoop mirror while this is true */
  mirrorActive = false;
  lookBack = false;
  /** head-hide hook: true entering the cockpit view, false leaving it (collapse / restore the `head_geo` bone) */
  onCockpitChange: ((active: boolean) => void) | null = null;

  private modeV: RaceCamMode = 'chase';
  private prevMode: Exclude<RaceCamMode, 'crash'> = 'chase';
  private eyeSource: EyeSource | null = null;
  private readonly eyeBody: [number, number, number];

  private init = false;
  private time = 0;
  private yaw = 0;
  private headingPrev = 0;
  private headingHold = 0;
  private hullWeight = 1;
  private airBlend = 0;
  private pivotY = 0;
  private pivotPrev = 0;
  private roll = 0;
  private rollPrev = 0;
  private rollGate = 1;
  private fov = RACE_CAM_DEFAULTS.chase.fovMin;
  private shakeAmp = 0;
  private dipX = 0;
  private dipV = 0;
  private headExcess = 0;
  private headExcessPrev = 0;
  private tiltAxis: [number, number, number] = [1, 0, 0];

  private blend = 0;
  private blendSpan = 0;
  private readonly blendPos = new Vector3();
  private readonly blendLook = new Vector3();
  private readonly blendUp = new Vector3(0, 1, 0);

  private lookBackPrev = false;
  private crashAnchor: Vector3 | null = null;
  private crashPending = false;
  private crashYaw = 0;

  private readonly pos = new Vector3();
  private readonly look = new Vector3();
  private readonly up = new Vector3(0, 1, 0);
  private readonly eyePos = new Vector3();
  private readonly eyeQuat = new Quaternion();
  private readonly lastLook = new Vector3();

  constructor(
    readonly camera: PerspectiveCamera,
    params: Partial<RaceCamParams> = {},
  ) {
    this.params = { ...RACE_CAM_DEFAULTS, ...params };
    this.eyeBody = cockpitEyeFallback();
    this.fov = this.params.chase.fovMin;
  }

  get mode(): RaceCamMode {
    return this.modeV;
  }

  /** the lens FOV the last update set, deg */
  get currentFov(): number {
    return this.fov;
  }

  setEyeSource(src: EyeSource | null): void {
    this.eyeSource = src;
  }

  /** chase → near → cockpit → chase (design §3: V / Y); ignored during a crash */
  cycleMode(): void {
    if (this.modeV === 'crash') return;
    this.setMode(CYCLE[(CYCLE.indexOf(this.modeV) + 1) % CYCLE.length]);
  }

  setMode(m: Exclude<RaceCamMode, 'crash'>): void {
    if (this.modeV === 'crash') {
      this.prevMode = m;
      return;
    }
    if (m === this.modeV) return;
    const from = this.modeV;
    this.modeV = m;
    if (from === 'cockpit' || m === 'cockpit') {
      // a cut: nothing to glide through between the pilot's eye and a chase boom
      this.blend = 0;
      this.init = false;
      this.onCockpitChange?.(m === 'cockpit');
    } else {
      this.startBlend(this.params.switchBlendSeconds);
    }
  }

  /** a slam or landing: vertical speed lost this frame, m/s (sum the ticks since the last frame) */
  addSlam(deltaV: number): void {
    const p = this.params;
    const dv = Number.isFinite(deltaV) ? Math.abs(deltaV) : 0;
    if (p.reducedMotion || dv === 0) return;
    this.shakeAmp = Math.min(p.shakeMaxRad, this.shakeAmp + p.shakePerDeltaV * dv);
    this.dipV -= Math.min(p.dipMax * p.dipOmega, p.dipPerDeltaV * dv * p.dipOmega);
  }

  /** detach to the crash orbit at `point` (world; default the boat's position on the next update) */
  beginCrash(point?: readonly [number, number, number]): void {
    if (this.modeV === 'crash') return;
    this.prevMode = this.modeV;
    const fromCockpit = this.modeV === 'cockpit';
    this.modeV = 'crash';
    this.crashAnchor = point ? new Vector3(point[0], point[1], point[2]) : null;
    this.crashPending = true;
    if (fromCockpit) {
      this.blend = 0;
      this.onCockpitChange?.(false);
    } else {
      this.startBlend(this.params.crashBlendInSeconds);
    }
  }

  /** leave the crash orbit (respawn / skip): blend back to the previous rig (a cut if that is the cockpit) */
  endCrash(): void {
    if (this.modeV !== 'crash') return;
    this.modeV = this.prevMode;
    if (this.modeV === 'cockpit') {
      this.blend = 0;
      this.onCockpitChange?.(true);
    } else {
      // blend FROM the crash pose (needs the drawn pose), then re-seat the chase smoothers on the live boat
      this.startBlend(this.params.crashReturnSeconds);
    }
    this.init = false;
  }

  /** teleport: forget every smoother (V108 on the render side) */
  reset(): void {
    this.init = false;
    this.blend = 0;
    this.shakeAmp = 0;
    this.dipX = this.dipV = 0;
    this.headExcess = this.headExcessPrev = 0;
  }

  update(target: RaceCamTarget, frameDt: number, heightFn?: RaceHeightFn): void {
    const p = this.params;
    const dt = Number.isFinite(frameDt) && frameDt > 0 ? frameDt : 0;
    this.time += dt;
    const py = target.position[1];
    const q = target.quaternion;
    const v = target.velocity;
    const water = (x: number, z: number): number => (heightFn ? heightFn(x, z) : 0);
    const speed = Math.hypot(v[0], v[1], v[2]);

    // ---- heading (always tracked, so leaving the cockpit or a crash lands on a live heading)
    const hy = hullYaw(q);
    const vy = velocityYaw(v);
    this.hullWeight = moveToward(this.hullWeight, target.wet && hy !== null ? 1 : 0, dt / p.headingBlendSeconds);
    const heading = blendHeading(hy, vy, this.hullWeight, this.headingHold);
    this.headingHold = heading;
    const pivotTarget = py + p.lookHeight;
    const tilt = tiltOf(q, this.tiltAxis);
    this.tiltAxis = tilt.axis;
    // heel: rotation about the hull's forward axis, read off body +x (NB body +x is the pilot's LEFT: y up, z bow)
    const heel = Math.asin(Math.max(-1, Math.min(1, rotateVec(q as Quat, [1, 0, 0])[1])));
    const rollTarget = () => p.rollFollow * Math.max(-30 * DEG, Math.min(30 * DEG, heel)) * this.rollGate;
    const cut = !this.init;
    if (!this.init) {
      this.yaw = heading;
      this.headingPrev = heading;
      this.pivotY = this.pivotPrev = pivotTarget;
      this.rollGate = target.wet && tilt.angle < p.rollFollowMaxTiltDeg * DEG ? 1 : 0;
      this.roll = this.rollPrev = rollTarget();
      this.hullWeight = target.wet && hy !== null ? 1 : 0;
      this.airBlend = target.wet ? 0 : 1;
      this.init = true;
    }
    const rig = this.modeV === 'near' || (this.modeV === 'crash' && this.prevMode === 'near') ? p.near : p.chase;
    {
      const from = this.yaw + wrapAngle(this.headingPrev - this.yaw);
      const to = from + wrapAngle(heading - this.headingPrev);
      this.yaw = dampMoving(this.yaw, from, to, rig.yawHalfLife, dt);
      this.headingPrev = heading;
    }
    this.pivotY = dampMoving(this.pivotY, this.pivotPrev, pivotTarget, p.heaveHalfLife, dt);
    this.pivotPrev = pivotTarget;
    this.rollGate = moveToward(this.rollGate, target.wet && tilt.angle < p.rollFollowMaxTiltDeg * DEG ? 1 : 0, dt / p.headingBlendSeconds);
    const rt = rollTarget();
    this.roll = dampMoving(this.roll, this.rollPrev, rt, p.rollHalfLife, dt);
    this.rollPrev = rt;
    this.airBlend = moveToward(this.airBlend, target.wet ? 0 : 1, dt / p.headingBlendSeconds);
    if (p.reducedMotion) this.shakeAmp = 0;
    else this.shakeAmp *= Math.pow(0.5, dt / p.shakeHalfLife);

    let fovTarget: number;
    const cam = this.camera;
    this.mirrorActive = this.modeV === 'cockpit' && this.lookBack;
    // look back is a CUT both ways (a swing through the side at 80 kn is disorienting): drop any running blend
    if (this.lookBack !== this.lookBackPrev) {
      this.lookBackPrev = this.lookBack;
      if (this.modeV !== 'cockpit' && this.modeV !== 'crash') this.blend = 0;
    }

    if (this.modeV === 'cockpit') {
      fovTarget = speedFov(speed, p.cockpitFovMin, p.cockpitFovMax);
      this.fov = cut ? fovTarget : moveToward(this.fov, fovTarget, p.fovRateDegPerS * dt);
      this.applyCockpit(target, dt);
    } else {
      if (this.modeV === 'crash') {
        fovTarget = rig.fovMin;
        this.poseCrash(target, dt, water);
      } else {
        fovTarget = speedFov(speed, rig.fovMin, rig.fovMax);
        this.poseChase(target, rig, water);
      }
      // a cut (first frame, teleport, cockpit ↔ outside) cuts the lens too; blends and speed changes slew
      this.fov = cut && this.blend === 0 ? fovTarget : moveToward(this.fov, fovTarget, p.fovRateDegPerS * dt);
      if (this.blend > 0) {
        const s = smoothstep(0, 1, 1 - this.blend / Math.max(this.blendSpan, 1e-6));
        this.blend = Math.max(0, this.blend - dt);
        this.pos.lerpVectors(this.blendPos, this.pos, s);
        this.look.lerpVectors(this.blendLook, this.look, s);
        this.up.lerpVectors(this.blendUp, this.up, s).normalize();
      }
      cam.position.copy(this.pos);
      cam.up.copy(this.up);
      cam.lookAt(this.look);
      this.lastLook.copy(this.look);
      if (this.shakeAmp > 0) {
        const [sy, sp] = shakeOffsets(this.time, this.shakeAmp);
        cam.rotateY(sy);
        cam.rotateX(sp);
      }
    }
    if (cam.fov !== this.fov) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
  }

  private startBlend(seconds: number): void {
    // nothing drawn yet: there is no pose to blend from
    if (!this.init) {
      this.blend = 0;
      return;
    }
    this.blendPos.copy(this.camera.position);
    this.blendLook.copy(this.lastLook);
    this.blendUp.copy(this.camera.up);
    this.blend = this.blendSpan = seconds;
  }

  private poseChase(target: RaceCamTarget, rig: RaceRig, water: (x: number, z: number) => number): void {
    const p = this.params;
    const [px, , pz] = target.position;
    const yaw = this.yaw + (this.lookBack ? Math.PI : 0);
    const hx = Math.sin(yaw);
    const hz = Math.cos(yaw);
    const cx = px - hx * rig.distance;
    const cz = pz - hz * rig.distance;
    const cy = Math.max(this.pivotY + rig.height, water(cx, cz) + p.minHeightAboveWater);
    this.pos.set(cx, cy, cz);
    let lx = px + hx * p.lookAhead;
    let ly = this.pivotY;
    let lz = pz + hz * p.lookAhead;
    if (this.airBlend > 0 && !this.lookBack) {
      const land = ballisticLanding(target.position, target.velocity, water(px, pz));
      const k = p.airLookToLanding * this.airBlend;
      lx += (land.x - lx) * k;
      ly += (water(land.x, land.z) - ly) * k;
      lz += (land.z - lz) * k;
    }
    this.look.set(lx, ly, lz);
    // horizon: a fraction of the heel about the horizontal heading axis h: up = Ŷcosθ + (h×Ŷ)sinθ, h×Ŷ = (−h_z, 0, h_x)
    const th = this.lookBack ? -this.roll : this.roll;
    const c = Math.cos(th);
    const s = Math.sin(th);
    const bh = Math.sin(this.yaw);
    const bz = Math.cos(this.yaw);
    this.up.set(-bz * s, c, bh * s);
  }

  private poseCrash(target: RaceCamTarget, dt: number, water: (x: number, z: number) => number): void {
    const p = this.params;
    const [px, py, pz] = target.position;
    if (this.crashPending) {
      if (!this.crashAnchor) this.crashAnchor = new Vector3(px, py, pz);
      const from = this.init ? this.camera.position : new Vector3(px - Math.sin(this.yaw), py, pz - Math.cos(this.yaw));
      this.crashYaw = Math.atan2(from.x - this.crashAnchor.x, from.z - this.crashAnchor.z);
      // coming from the cockpit the lens is AT the boat: orbit from astern instead of from wherever the eye was
      if (Math.hypot(from.x - this.crashAnchor.x, from.z - this.crashAnchor.z) < 1) this.crashYaw = this.yaw + Math.PI;
      this.crashPending = false;
    }
    this.crashYaw += p.crashOrbitDegPerS * DEG * dt;
    const a = this.crashAnchor as Vector3;
    const cx = a.x + Math.sin(this.crashYaw) * p.crashRadius;
    const cz = a.z + Math.cos(this.crashYaw) * p.crashRadius;
    this.pos.set(cx, Math.max(a.y + p.crashHeight, water(cx, cz) + p.minHeightAboveWater), cz);
    this.look.set(px, py, pz);
    this.up.set(0, 1, 0);
  }

  private applyCockpit(target: RaceCamTarget, dt: number): void {
    const p = this.params;
    const q = target.quaternion;
    const cam = this.camera;
    if (!(this.eyeSource && this.eyeSource(this.eyePos, this.eyeQuat))) {
      const [bx, by, bz] = this.eyeBody;
      this.eyePos.set(bx, by, bz).applyQuaternion(this.eyeQuat.set(q[0], q[1], q[2], q[3]));
      this.eyePos.x += target.position[0];
      this.eyePos.y += target.position[1];
      this.eyePos.z += target.position[2];
      const f = quatMul(q as Quat, Q_FLIP_Y);
      this.eyeQuat.set(f[0], f[1], f[2], f[3]);
    }
    // head: 100% of the hull's tilt up to `cockpitHeadFreeDeg`, the excess follows with a lag
    const tilt = tiltOf(q, this.tiltAxis);
    const excess = Math.max(0, tilt.angle - p.cockpitHeadFreeDeg * DEG);
    if (p.reducedMotion) {
      this.headExcess = this.headExcessPrev = excess;
    } else {
      this.headExcess = dampMoving(this.headExcess, this.headExcessPrev, excess, p.cockpitHeadHalfLife, dt);
      this.headExcessPrev = excess;
    }
    const corr = this.headExcess - excess;
    const qc = corr !== 0 ? quatFromAxisAngle(tilt.axis, corr) : null;
    if (qc) {
      const e = quatMul(qc, [this.eyeQuat.x, this.eyeQuat.y, this.eyeQuat.z, this.eyeQuat.w]);
      this.eyeQuat.set(e[0], e[1], e[2], e[3]).normalize();
    }
    // landing dip, exact critically damped spring, bounded
    if (p.reducedMotion) this.dipX = this.dipV = 0;
    else {
      [this.dipX, this.dipV] = criticalSpring(this.dipX, this.dipV, p.dipOmega, dt);
      if (this.dipX < -p.dipMax) {
        this.dipX = -p.dipMax;
        this.dipV = Math.max(0, this.dipV);
      }
    }
    cam.position.copy(this.eyePos);
    cam.position.y += this.dipX;
    cam.quaternion.copy(this.eyeQuat);
    cam.up.set(0, 1, 0).applyQuaternion(this.eyeQuat);
    this.lastLook.set(0, 0, -10).applyQuaternion(this.eyeQuat).add(cam.position);
  }
}

/**
 * THE PAGE'S CAMERA RIG (§T.182 → §T.181 seam `CameraRig`, src/speedboat/page/seams.ts). main-speedboat.ts swaps ONE
 * line:
 *   const camera = createRaceCameraRig(app.camera, { player }); // §T.182
 * The control source (raceControls.ts) feeds it look back, camera-cycle presses and the slam from the fixed tick
 * (`pilotInput`); presses are latched and applied on the next frame, so a tick-long press is never lost.
 * `cam` is exposed for the crash owner (§T.188: `beginCrash` / `endCrash`) and the pilot wiring
 * (`setEyeSource`, `onCockpitChange`). `snap` cuts (teleport); a respawn after a crash calls `endCrash` instead.
 */
export function createRaceCameraRig(
  camera: PerspectiveCamera,
  opts: {
    player?: { readonly hw: { readonly wet: { readonly count: number }; readonly gearcaseImmersion: ArrayLike<number> } };
    params?: Partial<RaceCamParams>;
  } = {},
): CameraRig & { readonly cam: RaceCam; pilotInput(input: { lookBack: boolean; cameraCycle: boolean }, slamDeltaV: number): void } {
  const cam = new RaceCam(camera, opts.params);
  const target: { position: [number, number, number]; quaternion: [number, number, number, number]; velocity: [number, number, number]; wet: boolean } = {
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    wet: true,
  };
  let cycles = 0;
  let slam = 0;
  const wet = (): boolean => {
    const hw = opts.player?.hw;
    if (!hw) return true;
    if (hw.wet.count > 0) return true;
    for (let k = 0; k < hw.gearcaseImmersion.length; k++) if (hw.gearcaseImmersion[k] > 0) return true;
    return false;
  };
  return {
    cam,
    pilotInput(input, slamDeltaV) {
      if (input.cameraCycle) cycles++;
      cam.lookBack = input.lookBack;
      if (Number.isFinite(slamDeltaV)) slam += Math.abs(slamDeltaV);
    },
    update(view, frameDt, waterAt) {
      for (; cycles > 0; cycles--) cam.cycleMode();
      if (slam > 0) {
        cam.addSlam(slam);
        slam = 0;
      }
      for (let c = 0; c < 3; c++) {
        target.position[c] = view.position[c];
        target.velocity[c] = view.velocity[c];
      }
      for (let c = 0; c < 4; c++) target.quaternion[c] = view.quaternion[c];
      target.wet = wet();
      cam.update(target, frameDt, waterAt);
    },
    snap() {
      cam.reset();
    },
    capturesInput() {
      return false;
    },
  };
}
