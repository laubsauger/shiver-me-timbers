/**
 * SPEEDBOAT RACE CAMERA (§T.182; design doc §6; tech-research §7).
 *
 * WHY these properties:
 *  - §T.167 (USER: "the camera's janking back and forth"): the render rate wanders 50–100 fps; the sim pose is
 *    interpolated on alpha, so the camera must follow ONE path in scene time. Same method as tests/camJudder.test.ts:
 *    the real accumulator, pose + velocity lerped on alpha, compared against a 960 fps reference.
 *  - A speedboat flips. followCam's heading `atan2(fwd.x, fwd.z)` swings 180° when the bow passes vertical
 *    (tech-research §7); a race camera that does that on every blow-over is unusable. Barrel roll and bow-up poses
 *    must leave the chase heading and horizon steady, with no NaN from lookAt.
 *  - FOV is a speed cue, bounded per rig (design §6), monotone in speed, and slewed.
 *  - Cockpit = the pilot's eye (cam_eye) with the head hidden; the fallback anchor matches the hull JSON seat.
 *  - Crash cam is world-anchored and returns without a pop; slam shake and dip are bounded.
 */
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { advanceAccumulator, SIM_DT } from '../src/core/loop';
import { quatFromAxisAngle, quatMul, rotateVec } from '../src/core/quat';
import { createRaceCameraRig, RACE_CAM_DEFAULTS, RaceCam, type RaceCamTarget } from '../src/camera/raceCam';
import { cockpitEyeFallback } from '../src/camera/raceCamEye';
import { hullYaw } from '../src/camera/raceCamMath';
import { HULL_DATA } from '../src/speedboat/hullMesh';
import type { Quat, Vec3 } from '../src/state/simState';

const DEG = Math.PI / 180;

interface Tick {
  pos: Vector3;
  vel: Vector3;
  quat: Quaternion;
  wet: boolean;
}

/** a hard turn at 38 m/s with heave, pitch and heel — the sim path at 60 Hz */
function voyage(seconds: number): Tick[] {
  const out: Tick[] = [];
  const p = new Vector3();
  for (let k = 0; k < 60 * (seconds + 2); k++) {
    const t = k * SIM_DT;
    const yaw = 0.2 + 0.35 * t;
    const vel = new Vector3(Math.sin(yaw) * 38, 1.2 * Math.cos(t * 1.7), Math.cos(yaw) * 38);
    p.addScaledVector(vel, SIM_DT);
    const pos = p.clone();
    pos.y = 0.35 + 0.7 * Math.sin(t * 1.7);
    const q = quatMul(quatMul(quatFromAxisAngle([0, 1, 0], yaw), quatFromAxisAngle([1, 0, 0], -0.05 * Math.sin(t * 2.1))), quatFromAxisAngle([0, 0, 1], -0.3 + 0.05 * Math.sin(t * 1.3)));
    out.push({ pos, vel, quat: new Quaternion(q[0], q[1], q[2], q[3]), wet: true });
  }
  return out;
}

interface Sample {
  t: number;
  cam: Vector3;
  /** a transom point rigid with the hull, NDC */
  stern: Vector3;
  fov: number;
}

function fly(ticks: Tick[], seconds: number, frameDt: () => number, setup?: (c: RaceCam) => void): Sample[] {
  const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  const cam = new RaceCam(camera);
  setup?.(cam);
  const out: Sample[] = [];
  let acc = 0;
  let k = 0;
  let time = 0;
  while (time < seconds) {
    const dt = frameDt();
    time += dt;
    const r = advanceAccumulator(acc, dt);
    acc = r.accumulator;
    k += r.steps;
    const a = ticks[Math.max(k - 1, 0)];
    const b = ticks[k];
    const pos = a.pos.clone().lerp(b.pos, r.alpha);
    const quat = a.quat.clone().slerp(b.quat, r.alpha);
    const vel = a.vel.clone().lerp(b.vel, r.alpha);
    const target: RaceCamTarget = { position: [pos.x, pos.y, pos.z], quaternion: [quat.x, quat.y, quat.z, quat.w], velocity: [vel.x, vel.y, vel.z], wet: b.wet };
    cam.update(target, dt);
    camera.updateMatrixWorld(true);
    const stern = new Vector3(0, 0.8, -3.6).applyQuaternion(quat).add(pos).project(camera);
    out.push({ t: (k - 1 + r.alpha) * SIM_DT, cam: camera.position.clone(), stern, fov: camera.fov });
  }
  return out;
}

function worst(run: Sample[], ref: Sample[], from: number, to: number): { mm: number; px: number } {
  let mm = 0;
  let px = 0;
  let j = 0;
  for (const s of run) {
    if (s.t < from || s.t > to) continue;
    while (ref[j + 1].t < s.t) j++;
    const A = ref[j];
    const B = ref[j + 1];
    const f = (s.t - A.t) / (B.t - A.t);
    mm = Math.max(mm, s.cam.distanceTo(A.cam.clone().lerp(B.cam, f)) * 1000);
    px = Math.max(px, Math.hypot(s.stern.x - (A.stern.x + (B.stern.x - A.stern.x) * f), s.stern.y - (A.stern.y + (B.stern.y - A.stern.y) * f)) * 540);
  }
  return { mm, px };
}

function jerk(run: Sample[], from: number): number {
  let sum = 0;
  let n = 0;
  for (let i = 2; i < run.length; i++) {
    if (run[i].t < from) continue;
    const [p0, p1, p2] = [run[i - 2], run[i - 1], run[i]];
    const dvx = (p2.stern.x - p1.stern.x) / (p2.t - p1.t) - (p1.stern.x - p0.stern.x) / (p1.t - p0.t);
    const dvy = (p2.stern.y - p1.stern.y) / (p2.t - p1.t) - (p1.stern.y - p0.stern.y) / (p1.t - p0.t);
    sum += Math.hypot(dvx, dvy) * 540;
    n++;
  }
  return sum / n;
}

function jittery(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return 1 / (50 + 50 * (s / 2147483647));
  };
}

describe('frame-rate independence (§T.167)', () => {
  const SECONDS = 12;
  const ticks = voyage(SECONDS);
  const reference = fly(ticks, SECONDS, () => 1 / 960);

  it('the scenario exercises the smoothers: the chase heading visibly lags the hull in the turn', () => {
    // otherwise "same path at every rate" would hold for a camera with no damping at all
    const camera = new PerspectiveCamera();
    const cam = new RaceCam(camera);
    let lag = 0;
    for (let k = 0; k < 600; k++) {
      const tk = ticks[k];
      cam.update({ position: [tk.pos.x, tk.pos.y, tk.pos.z], quaternion: [tk.quat.x, tk.quat.y, tk.quat.z, tk.quat.w], velocity: [tk.vel.x, tk.vel.y, tk.vel.z], wet: true }, SIM_DT);
      camera.updateMatrixWorld(true);
      const look = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      const hy = hullYaw([tk.quat.x, tk.quat.y, tk.quat.z, tk.quat.w]) as number;
      let d = Math.atan2(look.x, look.z) - hy;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      if (k > 300) lag = Math.max(lag, Math.abs(d));
    }
    expect(lag).toBeGreaterThan(1 * DEG);
  });

  it.each([
    ['50 fps', () => 1 / 50],
    ['60 fps', () => 1 / 60],
    ['100 fps', () => 1 / 100],
    ['144 fps', () => 1 / 144],
    ['jittery 50–100 fps', jittery(11)],
  ] as const)('%s lands on the 960 fps camera path', (_n, rate) => {
    const d = worst(fly(ticks, SECONDS, rate), reference, 3, SECONDS - 1);
    expect(d.mm).toBeLessThan(1);
    expect(d.px).toBeLessThan(0.1);
  });

  it('a frame time flipping 50↔100 fps every frame does not shake the hull on screen', () => {
    let i = 0;
    const flipping = fly(ticks, SECONDS, () => (i++ % 2 ? 1 / 50 : 1 / 100));
    const steady = fly(ticks, SECONDS, () => 1 / 60);
    expect(jerk(flipping, 3)).toBeLessThan(jerk(steady, 3) * 2);
  });
});

/** drive a RaceCam at 60 fps through a scripted pose list; returns per-frame camera forward/up/position */
function script(poses: { pos: Vec3; quat: Quat; vel: Vec3; wet: boolean }[], mode?: 'near' | 'cockpit'): { fwd: Vector3; up: Vector3; pos: Vector3 }[] {
  const camera = new PerspectiveCamera();
  const cam = new RaceCam(camera);
  if (mode) cam.setMode(mode);
  return poses.map((p) => {
    cam.update({ position: p.pos, quaternion: p.quat, velocity: p.vel, wet: p.wet }, 1 / 60);
    camera.updateMatrixWorld(true);
    return {
      fwd: new Vector3(0, 0, -1).applyQuaternion(camera.quaternion),
      up: new Vector3(0, 1, 0).applyQuaternion(camera.quaternion),
      pos: camera.position.clone(),
    };
  });
}

const finite = (v: Vector3): boolean => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
const yawOfDir = (v: Vector3): number => Math.atan2(v.x, v.z);
const angDiff = (a: number, b: number): number => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

describe('quaternion-safe through flips', () => {
  it('a full barrel roll in the air: chase heading and horizon hold, nothing NaN, no camera jump', () => {
    const poses: { pos: Vec3; quat: Quat; vel: Vec3; wet: boolean }[] = [];
    for (let k = 0; k < 180; k++) {
      const t = k / 60;
      const roll = k < 30 ? 0 : Math.min(1, (t - 0.5) / 1.5) * 2 * Math.PI;
      poses.push({ pos: [0, 2 + 3 * Math.sin(Math.min(t, 2.5) * 1.2), 30 * t], quat: quatFromAxisAngle([0, 0, 1], roll), vel: [0, 3, 30], wet: k < 30 });
    }
    const frames = script(poses);
    const yaw0 = yawOfDir(frames[29].fwd);
    for (let k = 1; k < frames.length; k++) {
      const f = frames[k];
      expect(finite(f.fwd) && finite(f.up) && finite(f.pos), `frame ${k}`).toBe(true);
      expect(angDiff(yawOfDir(f.fwd), yaw0), `frame ${k} heading`).toBeLessThan(2 * DEG);
      expect(f.up.y, `frame ${k} horizon`).toBeGreaterThan(Math.cos(12 * DEG));
      expect(f.pos.distanceTo(frames[k - 1].pos), `frame ${k} jump`).toBeLessThan(30 / 60 + 0.3);
    }
  });

  it('bow straight up and over (a blow-over): heading continuous where followCam\'s atan2 flips 180°', () => {
    const poses: { pos: Vec3; quat: Quat; vel: Vec3; wet: boolean }[] = [];
    const pitchAt = (k: number): number => (k < 30 ? 0 : Math.min(1, (k - 30) / 60) * 120 * DEG);
    for (let k = 0; k < 150; k++) {
      // bow-UP is a negative rotation about body +x (physics-log frames)
      poses.push({ pos: [0, 1 + k * 0.02, 20 * (k / 60)], quat: quatFromAxisAngle([1, 0, 0], -pitchAt(k)), vel: [0, 2, 20], wet: true });
    }
    // WHY: the naive heading of the forward axis flips across vertical
    const naive = (deg: number): number => {
      const f = rotateVec(quatFromAxisAngle([1, 0, 0], -deg * DEG), [0, 0, 1]);
      return Math.atan2(f[0], f[2]);
    };
    expect(angDiff(naive(89), naive(91))).toBeGreaterThan(170 * DEG);
    const frames = script(poses);
    for (let k = 1; k < frames.length; k++) {
      expect(finite(frames[k].fwd) && finite(frames[k].pos), `frame ${k}`).toBe(true);
      expect(angDiff(yawOfDir(frames[k].fwd), yawOfDir(frames[k - 1].fwd)), `frame ${k}`).toBeLessThan(1 * DEG);
    }
    expect(angDiff(yawOfDir(frames[149].fwd), yawOfDir(frames[29].fwd))).toBeLessThan(5 * DEG);
  });

  it('cockpit through the same flip and a roll: finite, and the eye stays on the hull', () => {
    const poses: { pos: Vec3; quat: Quat; vel: Vec3; wet: boolean }[] = [];
    for (let k = 0; k < 200; k++) {
      const a = (k / 200) * 2 * Math.PI;
      poses.push({ pos: [0, 2, k * 0.3], quat: quatMul(quatFromAxisAngle([1, 0, 0], -a), quatFromAxisAngle([0, 0, 1], a)), vel: [0, 0, 18], wet: false });
    }
    const frames = script(poses, 'cockpit');
    const eye = cockpitEyeFallback();
    const reach = Math.hypot(...eye) + 0.07;
    for (let k = 0; k < frames.length; k++) {
      expect(finite(frames[k].fwd) && finite(frames[k].up), `frame ${k}`).toBe(true);
      expect(frames[k].pos.distanceTo(new Vector3(...poses[k].pos)), `frame ${k}`).toBeLessThanOrEqual(reach);
    }
  });
});

describe('FOV', () => {
  it('bounded per rig, monotone in speed, slewed at ≤ 20°/s', () => {
    for (const mode of ['chase', 'near', 'cockpit'] as const) {
      const camera = new PerspectiveCamera();
      const cam = new RaceCam(camera);
      if (mode !== 'chase') cam.setMode(mode);
      const [lo, hi] =
        mode === 'chase' ? [60, 76] : mode === 'near' ? [68, 82] : [RACE_CAM_DEFAULTS.cockpitFovMin, RACE_CAM_DEFAULTS.cockpitFovMax];
      let settledPrev = -Infinity;
      cam.update({ position: [0, 0.35, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], wet: true }, 1 / 60);
      expect(camera.fov, 'a cut lands on the rig FOV at once').toBeCloseTo(lo, 9);
      for (let v = 0; v <= 100; v += 5) {
        let prev = camera.fov;
        for (let k = 0; k < 120; k++) {
          cam.update({ position: [0, 0.35, v * (k / 60)], quaternion: [0, 0, 0, 1], velocity: [0, 0, v], wet: true }, 1 / 60);
          expect(Math.abs(camera.fov - prev)).toBeLessThanOrEqual(20 / 60 + 1e-9);
          prev = camera.fov;
        }
        expect(camera.fov).toBeGreaterThanOrEqual(lo - 1e-9);
        expect(camera.fov).toBeLessThanOrEqual(hi + 1e-9);
        expect(camera.fov).toBeGreaterThanOrEqual(settledPrev - 1e-9);
        settledPrev = camera.fov;
      }
      expect(camera.fov).toBeCloseTo(hi, 6);
      // garbage speed never escapes the band
      cam.update({ position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [Number.NaN, 0, 1e9], wet: true }, 1 / 60);
      expect(camera.fov).toBeLessThanOrEqual(hi + 1e-9);
    }
  });
});

describe('cockpit', () => {
  it('fallback eye = hull JSON seat station + measured pilot eye offsets, body frame', () => {
    const spec = HULL_DATA.spec;
    const e = cockpitEyeFallback();
    expect(e[0]).toBe(0);
    expect(e[1]).toBeCloseTo(1.3 + 0.63 - spec.vcgAboveKeel, 3);
    expect(e[2]).toBeCloseTo(3.84 + 0.29 - spec.lcgFromTransom, 3);
  });

  it('head-hide hook fires entering and leaving; the cam_eye source is used when present and looks where it looks', () => {
    const camera = new PerspectiveCamera();
    const cam = new RaceCam(camera);
    const calls: boolean[] = [];
    cam.onCockpitChange = (a) => calls.push(a);
    const eyeQ = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.3);
    cam.setEyeSource((p, q) => {
      p.set(1, 2, 3);
      q.copy(eyeQ);
      return true;
    });
    cam.cycleMode(); // near
    cam.cycleMode(); // cockpit
    cam.update({ position: [0, 0.35, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 20], wet: true }, 1 / 60);
    expect(camera.position.toArray()).toEqual([1, 2, 3]);
    expect(camera.quaternion.angleTo(eyeQ)).toBeLessThan(1e-6);
    cam.beginCrash();
    cam.update({ position: [0, 0.35, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 20], wet: true }, 1 / 60);
    cam.endCrash();
    cam.cycleMode(); // → chase
    expect(calls).toEqual([true, false, true, false]);
  });

  it('head: rigid with the hull up to 12° of tilt, the excess lags and then catches up', () => {
    const camera = new PerspectiveCamera();
    const cam = new RaceCam(camera);
    cam.setMode('cockpit');
    const tiltOfCam = (): number => Math.acos(Math.min(1, new Vector3(0, 1, 0).applyQuaternion(camera.quaternion).y)) / DEG;
    const at = (heelDeg: number): void =>
      cam.update({ position: [0, 0.35, 0], quaternion: quatFromAxisAngle([0, 0, 1], heelDeg * DEG), velocity: [0, 0, 20], wet: true }, 1 / 60);
    at(0);
    at(10);
    expect(tiltOfCam()).toBeCloseTo(10, 6);
    at(40);
    const first = tiltOfCam();
    expect(first).toBeGreaterThanOrEqual(12 - 1e-6);
    expect(first).toBeLessThan(30);
    for (let k = 0; k < 180; k++) at(40);
    expect(tiltOfCam()).toBeCloseTo(40, 1);
  });

  it('landing dip is bounded at 6 cm whatever the slam', () => {
    const camera = new PerspectiveCamera();
    const cam = new RaceCam(camera);
    cam.setMode('cockpit');
    const tgt: RaceCamTarget = { position: [0, 0.35, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], wet: true };
    cam.update(tgt, 1 / 60);
    const y0 = camera.position.y;
    let low = 0;
    for (let k = 0; k < 120; k++) {
      if (k % 10 === 0) cam.addSlam(50);
      cam.update(tgt, 1 / 60);
      low = Math.min(low, camera.position.y - y0);
      expect(camera.position.y - y0).toBeLessThanOrEqual(0.06 + 1e-9);
    }
    expect(low).toBeGreaterThanOrEqual(-0.06 - 1e-9);
    expect(low).toBeLessThan(-0.02);
  });
});

describe('shake and crash cam', () => {
  it('slam shake is bounded (≤ 1.5° per axis) and decays to nothing; reduced motion has none', () => {
    const run = (params: Partial<typeof RACE_CAM_DEFAULTS>): number[] => {
      const camera = new PerspectiveCamera();
      const cam = new RaceCam(camera, params);
      const calm = new RaceCam(new PerspectiveCamera(), params);
      const devs: number[] = [];
      for (let k = 0; k < 240; k++) {
        const tgt: RaceCamTarget = { position: [0, 0.35, 20 * (k / 60)], quaternion: [0, 0, 0, 1], velocity: [0, 0, 20], wet: true };
        if (k < 60 && k % 5 === 0) cam.addSlam(1e3);
        cam.update(tgt, 1 / 60);
        calm.update(tgt, 1 / 60);
        devs.push(camera.quaternion.angleTo(calm.camera.quaternion) / DEG);
      }
      return devs;
    };
    const d = run({});
    expect(Math.max(...d)).toBeGreaterThan(0.3);
    expect(Math.max(...d)).toBeLessThanOrEqual(1.5 * Math.SQRT2 + 1e-6);
    expect(d[239]).toBeLessThan(0.01);
    expect(Math.max(...run({ reducedMotion: true }))).toBe(0);
  });

  it('crash orbit is anchored to the crash point while the hull drifts, and the return has no pop', () => {
    const camera = new PerspectiveCamera();
    const cam = new RaceCam(camera);
    const tgt = (z: number): RaceCamTarget => ({ position: [0, 0.35, z], quaternion: quatFromAxisAngle([0, 0, 1], 2), velocity: [0, 0, 6], wet: true });
    for (let k = 0; k < 60; k++) cam.update(tgt(k * 0.1), 1 / 60);
    cam.beginCrash([0, 0.35, 6]);
    const R = Math.hypot(RACE_CAM_DEFAULTS.crashRadius, RACE_CAM_DEFAULTS.crashHeight);
    let prev = camera.position.clone();
    for (let k = 0; k < 240; k++) {
      cam.update(tgt(6 + k * 0.1), 1 / 60);
      if (k > 40) expect(camera.position.distanceTo(new Vector3(0, 0.35, 6))).toBeCloseTo(R, 6);
      expect(camera.position.distanceTo(prev)).toBeLessThan(0.6);
      prev = camera.position.clone();
    }
    cam.endCrash();
    for (let k = 0; k < 90; k++) {
      cam.update({ position: [0, 0.35, 30 + k * 0.1], quaternion: [0, 0, 0, 1], velocity: [0, 0, 6], wet: true }, 1 / 60);
      expect(camera.position.distanceTo(prev), `return frame ${k}`).toBeLessThan(1.0);
      prev = camera.position.clone();
    }
    expect(cam.mode).toBe('chase');
  });
});

describe('page seam rig (createRaceCameraRig → CameraRig)', () => {
  it('a camera press from the tick is applied on the next frame, look back turns the chase round, snap cuts', () => {
    const camera = new PerspectiveCamera();
    const rig = createRaceCameraRig(camera, { player: { hw: { wet: { count: 5 }, gearcaseImmersion: [1, 1, 1] } } });
    const view = { position: [0, 0.35, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 20] } as unknown as Parameters<typeof rig.update>[0];
    rig.update(view, 1 / 60, () => 0);
    camera.updateMatrixWorld(true);
    expect(new Vector3(0, 0, -1).applyQuaternion(camera.quaternion).z).toBeGreaterThan(0.8);
    rig.pilotInput({ lookBack: false, cameraCycle: true }, 0);
    rig.update(view, 1 / 60, () => 0);
    expect(rig.cam.mode).toBe('near');
    rig.pilotInput({ lookBack: true, cameraCycle: false }, 0);
    rig.update(view, 1 / 60, () => 0);
    camera.updateMatrixWorld(true);
    expect(new Vector3(0, 0, -1).applyQuaternion(camera.quaternion).z).toBeLessThan(-0.8);
    expect(rig.capturesInput()).toBe(false);
    rig.snap();
    rig.update({ ...view, position: [500, 0.35, 0] } as typeof view, 1 / 60, () => 0);
    expect(Math.abs(camera.position.x - 500)).toBeLessThan(10);
  });
});
