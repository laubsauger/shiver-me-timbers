/**
 * CHASE-CAMERA JUDDER AT AN UNSTEADY FRAME RATE.
 *
 * USER: "behind the ship … the camera's janking back and forth a little bit",
 * with the frame rate wandering between 50 and 100 fps.
 *
 * WHY THESE TESTS EXIST. The sim ticks at a fixed 60 Hz and the render pose is
 * interpolated on alpha (§V2), so the ship the camera chases follows ONE path
 * in scene time however the frames fall. The chase itself did not: it damped
 * with a per-frame `expDamp`, which treats the target as having sat at its
 * end-of-frame position for the whole frame. Its steady lag behind a moving
 * ship is therefore about v·(halfLife/ln2 − dt/2) — a function of the frame
 * time. Measured on the voyage below: 99 mm off the true path at 50 fps,
 * 61 mm at 60, 35 mm at 100. When the rate moves between those (and it drops
 * exactly when the wake fills the screen, i.e. from astern), the lag breathes
 * and the hull slides fore and aft by pixels: the reported jank.
 *
 * The property asserted is the intent, not the formula: the camera's path is
 * a function of SCENE TIME, not of how the frames partition it.
 */
import { describe, expect, it } from 'vitest';
import { Euler, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { FollowCam } from '../src/camera/followCam';
import { dampMoving, expDamp } from '../src/camera/camMath';
import { advanceAccumulator, SIM_DT } from '../src/core/loop';
import type { ShipState } from '../src/state/simState';

const SPEED = 5; // m/s, a working sailing speed
const OMEGA = 0.15; // rad/s, a gentle turn, so the yaw chase is exercised too
const SECONDS = 30;
/** start measuring well after the 1.2 s yaw half-life has shed the boot swing */
const MEASURE_FROM = 20;

/** the voyage, integrated at the sim tick: a turn with heave, pitch and roll */
const TICKS: { pos: Vector3; vel: Vector3; quat: Quaternion }[] = [];
{
  const p = new Vector3();
  for (let k = 0; k < 60 * (SECONDS + 2); k++) {
    const t = k * SIM_DT;
    const yaw = 0.3 + OMEGA * t;
    const vel = new Vector3(Math.sin(yaw) * SPEED, 0, Math.cos(yaw) * SPEED);
    p.addScaledVector(vel, SIM_DT);
    const pos = p.clone();
    pos.y = 0.8 * Math.sin(t * 1.3);
    const quat = new Quaternion().setFromEuler(
      new Euler(0.04 * Math.sin(t * 1.1), yaw, 0.06 * Math.sin(t * 0.8), 'YXZ'),
    );
    TICKS.push({ pos, vel, quat });
  }
}

interface Sample {
  /** scene time of the rendered pose, s */
  t: number;
  cam: Vector3;
  /** a stern-rail point rigid with the hull, projected to NDC */
  stern: Vector3;
}

/**
 * Drive the real FollowCam exactly as main.ts does: the real accumulator, the
 * pose AND velocity lerped on alpha, frameDt handed to update().
 */
function fly(frameDt: () => number): Sample[] {
  const prevWindow = (globalThis as Record<string, unknown>).window;
  (globalThis as Record<string, unknown>).window = new EventTarget();
  const camera = new PerspectiveCamera(55, 16 / 9, 0.1, 5000);
  const cam = new FollowCam(camera, new EventTarget() as unknown as HTMLElement);
  const ship: ShipState = {
    id: 'p',
    kind: 'player',
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    rudder: 0,
    sailTrim: 0,
    flood: 0,
    damage: {},
  };
  const out: Sample[] = [];
  try {
    let acc = 0;
    let k = 0;
    let time = 0;
    while (time < SECONDS) {
      const dt = frameDt();
      time += dt;
      const r = advanceAccumulator(acc, dt);
      acc = r.accumulator;
      k += r.steps;
      const a = TICKS[Math.max(k - 1, 0)];
      const b = TICKS[k];
      const pos = a.pos.clone().lerp(b.pos, r.alpha);
      const quat = a.quat.clone().slerp(b.quat, r.alpha);
      const vel = a.vel.clone().lerp(b.vel, r.alpha);
      ship.position = [pos.x, pos.y, pos.z];
      ship.quaternion = [quat.x, quat.y, quat.z, quat.w];
      ship.velocity = [vel.x, vel.y, vel.z];
      cam.update(ship, dt);
      camera.updateMatrixWorld(true);
      const stern = new Vector3(0, 3, -20).applyQuaternion(quat).add(pos).project(camera);
      out.push({ t: (k - 1 + r.alpha) * SIM_DT, cam: camera.position.clone(), stern });
    }
  } finally {
    cam.dispose();
    (globalThis as Record<string, unknown>).window = prevWindow;
  }
  return out;
}

/** worst distance from a dense reference run at the same scene time: camera mm, hull px (1080p) */
function worstDeviation(run: Sample[], ref: Sample[]): { mm: number; px: number } {
  let mm = 0;
  let px = 0;
  let j = 0;
  for (const s of run) {
    if (s.t < MEASURE_FROM || s.t > SECONDS - 1) continue;
    while (ref[j + 1].t < s.t) j++;
    const A = ref[j];
    const B = ref[j + 1];
    const f = (s.t - A.t) / (B.t - A.t);
    mm = Math.max(mm, s.cam.distanceTo(A.cam.clone().lerp(B.cam, f)) * 1000);
    const sx = A.stern.x + (B.stern.x - A.stern.x) * f;
    const sy = A.stern.y + (B.stern.y - A.stern.y) * f;
    px = Math.max(px, Math.hypot(s.stern.x - sx, s.stern.y - sy) * 540);
  }
  return { mm, px };
}

/** mean frame-to-frame change of the hull's on-screen velocity, px/s (1080p) */
function screenJerk(run: Sample[]): number {
  let sum = 0;
  let n = 0;
  for (let i = 2; i < run.length; i++) {
    if (run[i].t < MEASURE_FROM) continue;
    const [p0, p1, p2] = [run[i - 2], run[i - 1], run[i]];
    const h1 = p1.t - p0.t;
    const h2 = p2.t - p1.t;
    const dvx = (p2.stern.x - p1.stern.x) / h2 - (p1.stern.x - p0.stern.x) / h1;
    const dvy = (p2.stern.y - p1.stern.y) / h2 - (p1.stern.y - p0.stern.y) / h1;
    sum += Math.hypot(dvx, dvy) * 540;
    n++;
  }
  return sum / n;
}

/** Park-Miller, so the jittery rate is the same every run */
function jitteryRate(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return 1 / (50 + 50 * (s / 2147483647));
  };
}

describe('chase camera is independent of the frame rate', () => {
  const reference = fly(() => 1 / 960);

  it.each([
    ['50 fps', () => 1 / 50],
    ['60 fps', () => 1 / 60],
    ['75 fps', () => 1 / 75],
    ['100 fps', () => 1 / 100],
    ['144 fps', () => 1 / 144],
    ['jittery 50–100 fps', jitteryRate(7)],
  ] as const)('%s lands on the same camera path as 960 fps', (_name, rate) => {
    const dev = worstDeviation(fly(rate), reference);
    // un-fixed: 23–99 mm and 1.6–5.2 px, varying with the rate. Sub-millimetre
    // is "the same path" at a 28 m chase radius.
    expect(dev.mm).toBeLessThan(1);
    expect(dev.px).toBeLessThan(0.05);
  });

  it('a frame time flipping 50↔100 fps every frame does not shake the hull', () => {
    let i = 0;
    const flipping = fly(() => (i++ % 2 ? 1 / 50 : 1 / 100));
    const steady = fly(() => 1 / 60);
    // un-fixed: 13 px/s of per-frame velocity wobble against 0.7 steady —
    // the lag flipping with every frame. Fixed, it is within noise of steady.
    expect(screenJerk(flipping)).toBeLessThan(screenJerk(steady) * 2);
  });
});

describe('dampMoving', () => {
  it('trails a ramp by exactly v·halfLife/ln2 at every step size', () => {
    const v = 5;
    const halfLife = 0.12;
    for (const dt of [1 / 50, 1 / 60, 1 / 100, 1 / 144]) {
      let x = 0;
      let target = 0;
      for (let t = 0; t < 3; t += dt) {
        const next = target + v * dt;
        x = dampMoving(x, target, next, halfLife, dt);
        target = next;
      }
      // the lag is a property of the chase, not of the frame time
      expect(target - x).toBeCloseTo((v * halfLife) / Math.LN2, 6);
    }
  });

  it('is plain expDamp for a still target, snaps at halfLife 0, holds at dt 0', () => {
    expect(dampMoving(2, 9, 9, 0.2, 1 / 60)).toBeCloseTo(expDamp(2, 9, 0.2, 1 / 60), 12);
    expect(dampMoving(2, 5, 9, 0, 1 / 60)).toBe(9);
    expect(dampMoving(2, 5, 9, 0.2, 0)).toBe(2);
  });

  it('never overshoots a target that jumps in one frame', () => {
    let x = dampMoving(0, 0, 10, 0.12, 1 / 60);
    let prev = 0;
    expect(x).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < 300; i++) {
      prev = x;
      x = dampMoving(x, 10, 10, 0.12, 1 / 60);
      expect(x).toBeGreaterThanOrEqual(prev);
      expect(x).toBeLessThanOrEqual(10);
    }
  });
});
