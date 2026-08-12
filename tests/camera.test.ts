/**
 * T10 camera — WHY these tests.
 *
 * Feel guarantees (camMath, pure): exp damping must be frame-rate
 * independent (same half-life at any dt, else camera feel changes with
 * fps), must never overshoot (chase cam oscillation reads as bug),
 * pitch/zoom clamps keep the user inside sane orbit limits, and min-height
 * keeps the lens out of the water for any injected ocean height sampler.
 *
 * Parkability (FreeCam + FollowCam, driven through their real key
 * bindings on an EventTarget stand-in for window): the user could not hold
 * a framing — "it always wants to go back to the photo camera" — which
 * blocks the §V22 screenshot-and-compare loop that gates this whole
 * project. So: a held follow angle must survive indefinitely, a parked
 * free camera must not drift by so much as a float, free mode must be
 * able to dive well under the surface and stay there, and no mode switch
 * may pop the lens.
 *
 * NOT covered here (browser-only, §V22): that the capture-phase listener
 * really does keep W/A/S/D away from the sailing input collector, and
 * everything about how any of it LOOKS.
 */
import { describe, expect, it } from 'vitest';
import {
  clamp,
  dampAngle,
  dampFactor,
  enforceMinHeight,
  expDamp,
  sphericalOffset,
  stepFly,
  stepFollowYaw,
  wrapAngle,
  yawPitchFromDirection,
} from '../src/camera/camMath';
import { FreeCam } from '../src/camera/freeCam';
import { FollowCam } from '../src/camera/followCam';
import { PerspectiveCamera, Vector3 } from 'three';
import type { ShipState } from '../src/state/simState';
import { cameraParams } from '../src/params/camera';

describe('exponential damping', () => {
  it('converges monotonically toward the target without overshoot', () => {
    let x = 0;
    let prevDist = 10;
    for (let i = 0; i < 200; i++) {
      x = expDamp(x, 10, 0.2, 1 / 60);
      const dist = Math.abs(10 - x);
      expect(dist).toBeLessThan(prevDist); // strictly approaching
      expect(x).toBeLessThanOrEqual(10); // never past the target
      prevDist = dist;
    }
    expect(prevDist).toBeLessThan(0.01);
  });

  it('halves the remaining distance every halfLife regardless of step size', () => {
    // one step of dt = halfLife → half the gap
    expect(expDamp(0, 1, 0.25, 0.25)).toBeCloseTo(0.5, 10);
    // two half-life steps ≡ one double step → frame-rate independence
    const twoSteps = expDamp(expDamp(0, 1, 0.25, 0.25), 1, 0.25, 0.25);
    expect(twoSteps).toBeCloseTo(expDamp(0, 1, 0.25, 0.5), 10);
    expect(twoSteps).toBeCloseTo(0.75, 10);
  });

  it('halfLife 0 snaps to the target', () => {
    expect(dampFactor(0, 1 / 60)).toBe(1);
    expect(expDamp(3, 7, 0, 1 / 60)).toBe(7);
  });

  it('dampAngle takes the short way across the ±π seam', () => {
    // 3.0 → -3.0 rad is 0.28 rad through π, not 6 rad back through 0
    const next = dampAngle(3.0, -3.0, 0.2, 1 / 60);
    expect(next).toBeGreaterThan(3.0);
    expect(wrapAngle(next)).toBeGreaterThan(0); // still shy of the seam
  });
});

describe('orbit limits', () => {
  it('pitch clamps to the configured window', () => {
    const p = cameraParams;
    expect(clamp(99, p.pitchMin, p.pitchMax)).toBe(p.pitchMax);
    expect(clamp(-99, p.pitchMin, p.pitchMax)).toBe(p.pitchMin);
    const inside = (p.pitchMin + p.pitchMax) / 2;
    expect(clamp(inside, p.pitchMin, p.pitchMax)).toBe(inside);
  });

  it('zoom radius clamps to min/max', () => {
    const p = cameraParams;
    expect(clamp(0.1, p.minRadius, p.maxRadius)).toBe(p.minRadius);
    expect(clamp(1e6, p.minRadius, p.maxRadius)).toBe(p.maxRadius);
  });

  it('sphericalOffset keeps the camera on the orbit sphere', () => {
    const [x, y, z] = sphericalOffset(1.1, 0.6, 25);
    expect(Math.hypot(x, y, z)).toBeCloseTo(25, 10);
    // pitch 0 = horizontal, yaw 0 = behind along +z
    expect(sphericalOffset(0, 0, 10)[1]).toBeCloseTo(0, 10);
    expect(sphericalOffset(0, 0, 10)[2]).toBeCloseTo(10, 10);
    // positive pitch raises the camera
    expect(sphericalOffset(0, 0.5, 10)[1]).toBeGreaterThan(0);
  });
});

describe('min height above water', () => {
  it('lifts the camera above the sampled ocean height', () => {
    const swell = (x: number, z: number): number => 2 + Math.sin(x * 0.1) + Math.cos(z * 0.1);
    const x = 3;
    const z = -7;
    const floor = swell(x, z) + cameraParams.minHeightAboveWater;
    expect(enforceMinHeight(-5, x, z, cameraParams.minHeightAboveWater, swell)).toBe(floor);
    // already high enough → untouched (no sticky snapping to the floor)
    expect(enforceMinHeight(floor + 4, x, z, cameraParams.minHeightAboveWater, swell)).toBe(
      floor + 4,
    );
  });

  it('defaults to the y=0 plane when no height sampler is provided', () => {
    expect(enforceMinHeight(-1, 0, 0, 1.5)).toBe(1.5);
    expect(enforceMinHeight(9, 0, 0, 1.5)).toBe(9);
  });
});

/**
 * WHY: the user's blocker was "the camera always wants to go back to the
 * photo camera" — they could not hold a framing long enough to inspect the
 * ship or screenshot it, which is the §V22 acceptance loop itself. Follow
 * mode must therefore hold a HELD angle indefinitely (as an offset from the
 * ship's heading, so it still trails astern through turns) and free mode
 * must be perfectly still when nobody is flying it.
 */
describe('follow yaw holds the user angle', () => {
  const hl = cameraParams.yawFollowHalfLife;

  it('re-reads the offset from the live yaw while dragging', () => {
    // dragging: yaw is whatever the pointer set; offset records it
    const [yaw, offset] = stepFollowYaw(1.0, 0, 0.25, true, hl, 1 / 60);
    expect(yaw).toBe(1.0); // drag owns the angle, no damping fights it
    expect(offset).toBeCloseTo(0.75, 12);
  });

  it('never drifts back to dead astern once an angle was held', () => {
    // user dragged 90° off the stern and let go; ship keeps its heading
    let yaw = 0.4 + Math.PI / 2;
    let offset = Math.PI / 2;
    for (let i = 0; i < 2000; i++) {
      [yaw, offset] = stepFollowYaw(yaw, offset, 0.4, false, hl, 1 / 60);
    }
    // 33 simulated seconds later it is still 90° off, not re-centered
    expect(wrapAngle(yaw - 0.4)).toBeCloseTo(Math.PI / 2, 6);
  });

  it('still swings with the ship so the offset stays heading-relative', () => {
    let yaw = 0;
    let offset = 0;
    const behind = 1.2; // ship turned; stern heading moved
    for (let i = 0; i < 2000; i++) {
      [yaw, offset] = stepFollowYaw(yaw, offset, behind, false, hl, 1 / 60);
    }
    expect(yaw).toBeCloseTo(behind, 6); // trails astern again
    expect(offset).toBe(0);
  });
});

describe('free-cam fly kinematics', () => {
  it('hard-stops instead of creeping forever toward zero', () => {
    const vel = [12, -3, 7];
    for (let i = 0; i < 400; i++) stepFly(vel, [0, 0, 0], 0.08, 1 / 60, 0.02);
    // exact zero matters: an exp decay alone leaves a sub-mm/s drift that
    // walks a parked camera off its framing over a long screenshot session
    expect(vel).toEqual([0, 0, 0]);
  });

  it('converges to the commanded velocity', () => {
    const vel = [0, 0, 0];
    for (let i = 0; i < 200; i++) stepFly(vel, [30, 0, 0], 0.08, 1 / 60, 0.02);
    expect(vel[0]).toBeCloseTo(30, 4);
  });

  it('yawPitchFromDirection inverts sphericalOffset', () => {
    for (const [y, pch] of [
      [0, 0],
      [1.1, 0.6],
      [-2.4, -1.0],
    ]) {
      const [x, yy, z] = sphericalOffset(y, pch, 7);
      const [yaw2, pitch2] = yawPitchFromDirection(x, yy, z);
      expect(yaw2).toBeCloseTo(y, 10);
      expect(pitch2).toBeCloseTo(pch, 10);
    }
    expect(yawPitchFromDirection(0, 0, 0)).toEqual([0, 0]);
  });
});

/**
 * Headless rig for the three-side FollowCam. FollowCam only needs
 * add/removeEventListener off `window` and the canvas, so EventTarget
 * stand-ins are enough to drive the real key bindings. (The capture-phase
 * swallow of the fly keys can only be proven in a real propagation path —
 * that one is a browser check, §V22.)
 */
interface CamRig {
  camera: PerspectiveCamera;
  cam: FollowCam;
  ship: ShipState;
  key(type: string, code: string): void;
  done(): void;
}

function mountCam(): CamRig {
  const fakeWindow = new EventTarget();
  const prev = (globalThis as Record<string, unknown>).window;
  (globalThis as Record<string, unknown>).window = fakeWindow;
  const camera = new PerspectiveCamera(55, 1, 0.1, 5000);
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
  return {
    camera,
    cam,
    ship,
    key: (type, code) => {
      fakeWindow.dispatchEvent(Object.assign(new Event(type), { code }));
    },
    done: () => {
      cam.dispose();
      (globalThis as Record<string, unknown>).window = prev;
    },
  };
}

describe('free camera', () => {
  const step = (cam: FreeCam, n: number): void => {
    for (let i = 0; i < n; i++) cam.update(1 / 60);
  };

  it('does not drift when idle — the parked pose is exactly held', () => {
    const cam = new FreeCam();
    cam.keyDown('KeyW');
    step(cam, 60);
    cam.keyUp('KeyW');
    step(cam, 120);
    const parked = [...cam.position];
    step(cam, 6000); // 100 simulated seconds of nobody touching anything
    expect(cam.position).toEqual(parked);
  });

  it('flies along the view axes, not world axes', () => {
    const cam = new FreeCam();
    cam.yaw = Math.PI / 2; // looking down +x
    cam.keyDown('KeyW');
    step(cam, 60);
    expect(cam.position[0]).toBeGreaterThan(1);
    expect(Math.abs(cam.position[2])).toBeLessThan(0.01);
  });

  it('R/F rise and descend, and the dive floor is well below the surface', () => {
    const p = cameraParams;
    expect(p.freeMinY).toBeLessThan(-50); // §V25 underwater inspection needs depth
    const cam = new FreeCam();
    cam.keyDown('KeyF');
    step(cam, 60 * 60); // a full minute of descent
    expect(cam.position[1]).toBe(p.freeMinY); // clamped, never NaN or runaway
    cam.keyUp('KeyF');
    cam.keyDown('KeyR');
    step(cam, 120);
    expect(cam.position[1]).toBeGreaterThan(p.freeMinY);
  });

  it('Shift/Ctrl scale speed for horizon runs vs close-up work', () => {
    const p = cameraParams;
    const cam = new FreeCam();
    expect(cam.speed).toBeCloseTo(p.freeSpeed, 10);
    cam.keyDown('ShiftLeft');
    expect(cam.speed).toBeCloseTo(p.freeSpeed * p.freeFastMul, 10);
    cam.keyUp('ShiftLeft');
    cam.keyDown('ControlLeft');
    expect(cam.speed).toBeCloseTo(p.freeSpeed * p.freeSlowMul, 10);
    // fast must actually reach km scale in a few seconds of flight
    cam.keyUp('ControlLeft');
    cam.keyDown('ShiftLeft');
    expect(cam.speed * 5).toBeGreaterThan(1000);
  });

  it('wheel scales travel speed and clears keys on blur', () => {
    const cam = new FreeCam();
    const base = cam.speed;
    cam.adjustSpeed(-500); // wheel up = faster
    expect(cam.speed).toBeGreaterThan(base);
    cam.adjustSpeed(500);
    expect(cam.speed).toBeCloseTo(base, 6);

    cam.keyDown('KeyW');
    cam.clearKeys(); // window blur must not leave the camera flying away
    step(cam, 120);
    expect(cam.position).toEqual([0, 0, 0]);
  });

  it('only claims its own fly keys — Q/E stay free for sail trim', () => {
    expect(FreeCam.consumes('KeyW')).toBe(true);
    expect(FreeCam.consumes('KeyD')).toBe(true);
    expect(FreeCam.consumes('KeyR')).toBe(true);
    expect(FreeCam.consumes('KeyF')).toBe(true);
    expect(FreeCam.consumes('KeyQ')).toBe(false);
    expect(FreeCam.consumes('KeyE')).toBe(false);
    expect(FreeCam.consumes('Space')).toBe(false); // §I fire cannon
    expect(FreeCam.consumes('Tab')).toBe(false); // §I debug panel
    expect(FreeCam.consumes('Escape')).toBe(false); // §V21 pause
  });

  it('mode toggle: C detaches and re-attaches, and only free mode flies', () => {
    const rig = mountCam();
    const { camera, cam, ship, key } = rig;
    try {
      expect(cam.getMode()).toBe('follow');
      for (let i = 0; i < 3000; i++) cam.update(ship, 1 / 60); // settle astern
      const followPos = camera.position.clone();
      key('keydown', 'KeyW'); // follow mode: W is the sim's, camera ignores it
      for (let i = 0; i < 60; i++) cam.update(ship, 1 / 60);
      expect(camera.position.distanceTo(followPos)).toBeLessThan(1e-6);
      key('keyup', 'KeyW');

      key('keydown', 'KeyC');
      expect(cam.isFree()).toBe(true);
      // free mode is entered as a cut: same pose, no motion until flown
      cam.update(ship, 1 / 60);
      expect(camera.position.distanceTo(followPos)).toBeLessThan(1e-6);

      key('keydown', 'KeyW');
      for (let i = 0; i < 60; i++) cam.update(ship, 1 / 60);
      expect(camera.position.distanceTo(followPos)).toBeGreaterThan(5);
      key('keyup', 'KeyW');
      for (let i = 0; i < 120; i++) cam.update(ship, 1 / 60);
      const parked = camera.position.clone();
      for (let i = 0; i < 600; i++) cam.update(ship, 1 / 60);
      // §V22: a parked inspection camera must still be parked 10s later
      expect(camera.position.equals(parked)).toBe(true);

      key('keydown', 'KeyC');
      expect(cam.getMode()).toBe('follow');
      // the return is a blend, not a cut: one frame moves only a little
      cam.update(ship, 1 / 60);
      expect(camera.position.distanceTo(parked)).toBeLessThan(
        parked.distanceTo(followPos) * 0.5,
      );
      for (let i = 0; i < 900; i++) cam.update(ship, 1 / 60);
      // ...and lands back on the SAME orbit framing it had before the
      // excursion — free mode is a detour, not a re-configuration
      const pivot = new Vector3(0, cameraParams.pivotHeight, 0);
      expect(camera.position.distanceTo(pivot)).toBeCloseTo(cameraParams.radius, 2);
      expect(camera.position.distanceTo(followPos)).toBeLessThan(0.01);
    } finally {
      rig.done();
    }
  });

  it('pitch clamps just short of gimbal lock', () => {
    const cam = new FreeCam();
    cam.look(0, -100000);
    expect(cam.pitch).toBe(cameraParams.freePitchLimit);
    cam.look(0, 200000);
    expect(cam.pitch).toBe(-cameraParams.freePitchLimit);
    expect(cameraParams.freePitchLimit).toBeLessThan(Math.PI / 2);
  });
});

/**
 * WHY: the second half of the user's report is "we can't get deep enough
 * with the camera" while inspecting the surface from below. The follow cam
 * runs the ocean height sampler through enforceMinHeight; free mode must
 * bypass it entirely (§V25 owns the underwater LOOK — the camera must at
 * least be allowed to get there).
 */
describe('free-dive below the surface', () => {
  it('free mode ignores the ocean height sampler and dives', () => {
    const rig = mountCam();
    try {
      // a sampler that would shove the lens 2m over a 3m swell if applied
      const swell = (): number => 3;
      rig.key('keydown', 'KeyC');
      rig.key('keydown', 'KeyF'); // descend
      for (let i = 0; i < 60 * 20; i++) rig.cam.update(rig.ship, 1 / 60, swell);
      expect(rig.camera.position.y).toBeLessThan(-50); // properly under
      expect(rig.camera.position.y).toBe(cameraParams.freeMinY);
      // and it STAYS down — no creep back toward the surface when idle
      rig.key('keyup', 'KeyF');
      for (let i = 0; i < 60 * 30; i++) rig.cam.update(rig.ship, 1 / 60, swell);
      expect(rig.camera.position.y).toBe(cameraParams.freeMinY);
    } finally {
      rig.done();
    }
  });

  it('follow mode still honours the water floor when diving is disabled', () => {
    const rig = mountCam();
    const wasAllowed = cameraParams.allowUnderwater;
    cameraParams.allowUnderwater = false;
    try {
      const swell = (): number => 3;
      for (let i = 0; i < 600; i++) rig.cam.update(rig.ship, 1 / 60, swell);
      expect(rig.camera.position.y).toBeGreaterThanOrEqual(
        3 + cameraParams.minHeightAboveWater - 1e-9,
      );
    } finally {
      cameraParams.allowUnderwater = wasAllowed;
      rig.done();
    }
  });
});

/**
 * WHY: reported twice from real verification slots. The caustics agent set
 * a close-up hull vantage and "the free camera overrode both my position
 * and my per-frame transform lock, so my closest look was ~25 m out"; the
 * ship agent had a property stomped until they resorted to
 * Object.defineProperty(..., {writable: false}). A screenshot forces rAF
 * frames, so ANY pose an agent sets must survive update() being called
 * repeatedly — that is the whole §V22 loop, and a browser slot spent
 * fighting the camera is a slot lost.
 */
describe('debug vantage (setDebugPose)', () => {
  const pos: [number, number, number] = [6, 2.5, -14];
  const aim: [number, number, number] = [0, 3, 0];

  it('holds an exact pose through hundreds of frames in follow mode', () => {
    const rig = mountCam();
    try {
      for (let i = 0; i < 600; i++) rig.cam.update(rig.ship, 1 / 60);
      rig.cam.setDebugPose(pos, aim);
      const pinned = rig.camera.position.clone();
      const quat = rig.camera.quaternion.clone();
      expect(pinned.toArray()).toEqual(pos); // exact, not damped toward
      for (let i = 0; i < 600; i++) rig.cam.update(rig.ship, 1 / 60);
      expect(rig.camera.position.toArray()).toEqual(pos);
      expect(rig.camera.quaternion.equals(quat)).toBe(true);
      expect(rig.cam.isDebugPinned()).toBe(true);
    } finally {
      rig.done();
    }
  });

  it('outranks free mode, including with fly keys held down', () => {
    const rig = mountCam();
    try {
      rig.key('keydown', 'KeyC');
      rig.cam.setDebugPose(pos, aim);
      rig.key('keydown', 'KeyW'); // someone leaning on the fly key
      rig.key('keydown', 'ShiftLeft');
      for (let i = 0; i < 600; i++) rig.cam.update(rig.ship, 1 / 60);
      expect(rig.camera.position.toArray()).toEqual(pos);
    } finally {
      rig.done();
    }
  });

  it('holds a vantage right up against the hull — no minRadius floor', () => {
    const rig = mountCam();
    try {
      // the caustics agent needed metres, not the ~25 m follow mode gave
      const close: [number, number, number] = [1.5, 1.2, 3];
      rig.cam.setDebugPose(close, [0, 1, 3]);
      for (let i = 0; i < 300; i++) rig.cam.update(rig.ship, 1 / 60);
      expect(rig.camera.position.toArray()).toEqual(close);
      expect(rig.camera.position.length()).toBeLessThan(cameraParams.minRadius);
    } finally {
      rig.done();
    }
  });

  it('pins below the waterline even with follow-mode diving disabled', () => {
    const rig = mountCam();
    const wasAllowed = cameraParams.allowUnderwater;
    cameraParams.allowUnderwater = false;
    try {
      const deep: [number, number, number] = [0, -18, 20];
      rig.cam.setDebugPose(deep, [0, 0, 0]);
      for (let i = 0; i < 300; i++) rig.cam.update(rig.ship, 1 / 60, () => 3);
      expect(rig.camera.position.toArray()).toEqual(deep);
    } finally {
      cameraParams.allowUnderwater = wasAllowed;
      rig.done();
    }
  });

  it('accepts a Vector3 as well as an array, and keeps the aim if omitted', () => {
    const rig = mountCam();
    try {
      rig.cam.setDebugPose(new Vector3(...pos), aim);
      const quat = rig.camera.quaternion.clone();
      rig.cam.setDebugPose([8, 2.5, -14]); // move, same aim direction
      expect(rig.camera.quaternion.angleTo(quat)).toBeLessThan(1e-6);
      expect(rig.camera.position.x).toBe(8);
    } finally {
      rig.done();
    }
  });

  it('releases without jumping, and C releases it too', () => {
    const rig = mountCam();
    try {
      rig.key('keydown', 'KeyC'); // free mode
      rig.cam.setDebugPose(pos, aim);
      for (let i = 0; i < 120; i++) rig.cam.update(rig.ship, 1 / 60);
      rig.cam.clearDebugPose();
      expect(rig.cam.isDebugPinned()).toBe(false);
      // free mode adopts the parked pose: released ≠ teleported
      for (let i = 0; i < 600; i++) rig.cam.update(rig.ship, 1 / 60);
      expect(rig.camera.position.toArray()).toEqual(pos);

      // and the C key is an explicit "give me the camera back"
      rig.cam.setDebugPose(pos, aim);
      expect(rig.cam.isDebugPinned()).toBe(true);
      rig.key('keydown', 'KeyC');
      expect(rig.cam.isDebugPinned()).toBe(false);
      expect(rig.cam.getMode()).toBe('follow');
    } finally {
      rig.done();
    }
  });
});

/**
 * WHY: the same report, from the other direction. Free mode's contract is
 * that it holds the pose it was left at — so overwriting a pose set from
 * outside is the same bug as drifting, not a missing feature.
 */
describe('free mode yields to an externally set pose', () => {
  it('adopts camera.position written from the console', () => {
    const rig = mountCam();
    try {
      rig.key('keydown', 'KeyC');
      for (let i = 0; i < 60; i++) rig.cam.update(rig.ship, 1 / 60);
      rig.camera.position.set(3, 1.8, 9); // what an agent types in devtools
      for (let i = 0; i < 600; i++) rig.cam.update(rig.ship, 1 / 60);
      expect(rig.camera.position.toArray()).toEqual([3, 1.8, 9]);
    } finally {
      rig.done();
    }
  });

  it('adopts an external lookAt and then flies along the NEW view axis', () => {
    const rig = mountCam();
    try {
      rig.key('keydown', 'KeyC');
      for (let i = 0; i < 60; i++) rig.cam.update(rig.ship, 1 / 60);
      rig.camera.position.set(0, 0, 0);
      rig.camera.lookAt(new Vector3(100, 0, 0)); // now facing +x
      rig.cam.update(rig.ship, 1 / 60);
      rig.key('keydown', 'KeyW');
      for (let i = 0; i < 60; i++) rig.cam.update(rig.ship, 1 / 60);
      expect(rig.camera.position.x).toBeGreaterThan(1);
      expect(Math.abs(rig.camera.position.z)).toBeLessThan(0.05);
    } finally {
      rig.done();
    }
  });

  it('an external teleport carries no leftover momentum', () => {
    const rig = mountCam();
    try {
      rig.key('keydown', 'KeyC');
      rig.key('keydown', 'KeyW'); // build up speed first
      for (let i = 0; i < 120; i++) rig.cam.update(rig.ship, 1 / 60);
      rig.key('keyup', 'KeyW');
      rig.camera.position.set(50, 20, 50);
      rig.cam.update(rig.ship, 1 / 60);
      const landed = rig.camera.position.clone();
      for (let i = 0; i < 600; i++) rig.cam.update(rig.ship, 1 / 60);
      expect(rig.camera.position.equals(landed)).toBe(true);
    } finally {
      rig.done();
    }
  });
});

/**
 * WHY: §V2 render interpolation. main.ts hands update() an INTERPOLATED
 * copy of the ship pose (lerp of prev→curr sim tick) — if the camera
 * ignored it, or chased the raw tick pose, the ship would look smooth and
 * the camera would micro-stutter. And §V3: the camera is render-side, so
 * the view it is handed must come back unmodified.
 */
describe('camera vs the interpolated render view', () => {
  it('tracks the sub-tick pose and never writes to it', () => {
    const rig = mountCam();
    try {
      const view = rig.ship;
      const before = JSON.stringify(view);
      let x = 0;
      // let the initial placement + astern settle finish first
      for (let i = 0; i < 3000; i++) rig.cam.update(view, 1 / 60);
      let last = rig.camera.position.clone();
      let maxStep = 0;
      for (let i = 0; i < 1200; i++) {
        // ship sliding along +x at 8 m/s, sampled at render rate (not tick
        // rate) — i.e. exactly the interpolated values main.ts produces
        x += 8 / 60;
        view.position[0] = x;
        view.velocity[0] = 8;
        rig.cam.update(view, 1 / 60);
        maxStep = Math.max(maxStep, rig.camera.position.distanceTo(last));
        last = rig.camera.position.clone();
      }
      // camera keeps station on the moving ship
      expect(rig.camera.position.x).toBeGreaterThan(x - cameraParams.radius - 5);
      expect(rig.camera.position.x).toBeLessThan(x + cameraParams.radius + 5);
      // and moves in smooth per-frame increments, not jumps: at 8 m/s the
      // steady-state step is ~0.133 m/frame; anything near a metre is a pop
      expect(maxStep).toBeLessThan(0.5);
      // §V3 one-way data flow: the handed-in view is untouched
      view.position[0] = 0;
      view.velocity[0] = 0;
      expect(JSON.stringify(view)).toBe(before);
    } finally {
      rig.done();
    }
  });

  it('mode switches never pop the lens — every frame step stays small', () => {
    const rig = mountCam();
    try {
      const { cam, camera, ship, key } = rig;
      const pivot = new Vector3(0, cameraParams.pivotHeight, 0);
      for (let i = 0; i < 3000; i++) cam.update(ship, 1 / 60);
      let last = camera.position.clone();
      const run = (n: number, onStep?: (step: number, gap: number) => void): void => {
        for (let i = 0; i < n; i++) {
          cam.update(ship, 1 / 60);
          onStep?.(camera.position.distanceTo(last), camera.position.distanceTo(pivot));
          last = camera.position.clone();
        }
      };
      key('keydown', 'KeyC'); // → free
      run(30);
      key('keydown', 'ShiftLeft');
      key('keydown', 'KeyW'); // fly a long way off, fast
      run(300);
      key('keyup', 'KeyW');
      key('keyup', 'ShiftLeft');
      run(120);
      const gap = camera.position.distanceTo(pivot);
      expect(gap).toBeGreaterThan(500); // genuinely a long way out

      key('keydown', 'KeyC'); // → follow, from ~a kilometre away
      const steps: number[] = [];
      run(60 * 12, (step) => steps.push(step));
      // eased, not cut: the first frame covers a couple of percent of the
      // trip, and no frame ever swallows a big fraction of what's left
      expect(steps[0]).toBeLessThan(gap * 0.05);
      // no acceleration kink when the blend hands back to the normal
      // half-life: the per-frame step only ever decays
      for (let i = 1; i < steps.length; i++) {
        expect(steps[i]).toBeLessThanOrEqual(steps[i - 1] + 1e-9);
      }
      expect(camera.position.distanceTo(pivot)).toBeCloseTo(cameraParams.radius, 1);
    } finally {
      rig.done();
    }
  });
});
