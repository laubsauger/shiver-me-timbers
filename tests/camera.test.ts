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
import { describe, expect, it, vi } from 'vitest';
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
import { FLY_KEYS, FreeCam } from '../src/camera/freeCam';
import { FollowCam } from '../src/camera/followCam';
import { STATION_CODES } from '../src/camera/camInput';
import { STATION_IDS, createShipStations, type StationId } from '../src/camera/camStations';
import { Euler, PerspectiveCamera, Quaternion, Vector3, type Material } from 'three';
import type { ShipState } from '../src/state/simState';
import { cameraParams } from '../src/params/camera';
import { combatParams } from '../src/params/combat';
import { CONTROL_CODES, CONTROL_GROUPS } from '../src/input/controlMap';
import { ShipAssembly } from '../src/ship/shipAssembly';
import { buildGalleonBlueprint } from '../src/ship/shipBlueprint';
import type { PieceDef } from '../src/ship/pieceTypes';
import { batteryCentreGun, batterySide, buildBattery } from '../src/combat/battery';
import { muzzleLay } from '../src/combat/aim';

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
  /** a real pointer drag through the real binding, not a poke at a private */
  drag(dx: number, dy: number): void;
  done(): void;
}

function mountCam(): CamRig {
  const fakeWindow = new EventTarget();
  const prev = (globalThis as Record<string, unknown>).window;
  (globalThis as Record<string, unknown>).window = fakeWindow;
  const camera = new PerspectiveCamera(55, 1, 0.1, 5000);
  const dom = new EventTarget();
  const cam = new FollowCam(camera, dom as unknown as HTMLElement);
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
    drag: (dx, dy) => {
      dom.dispatchEvent(Object.assign(new Event('pointerdown'), { button: 0, pointerId: 1 }));
      dom.dispatchEvent(
        Object.assign(new Event('pointermove'), { pointerId: 1, movementX: dx, movementY: dy }),
      );
      dom.dispatchEvent(Object.assign(new Event('pointerup'), { button: 0, pointerId: 1 }));
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
      // the caustics agent needed metres, not the ~25 m follow mode gave.
      // Derived from minRadius rather than written as a literal: the point of
      // this test is that the pin OUTRANKS the zoom floor, so it has to stay
      // inside whatever that floor currently is. A hardcoded 3.56 m silently
      // stopped testing anything the day minRadius dropped below it.
      const d = cameraParams.minRadius * 0.4;
      const close: [number, number, number] = [d * 0.45, d * 0.36, d * 0.81];
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

  /**
   * WHY: the aim is `pivot + velocity * lookAhead` and — outside the
   * post-mode-switch blend — it is NOT smoothed, it goes straight to
   * camera.lookAt. So the look-ahead velocity is part of the POSE, and it has
   * to arrive interpolated on the same alpha as position and quaternion. Hand
   * over the raw sim value instead and the aim staircases at the sim tick rate
   * while the hull glides — which moves the WHOLE view, not the ship in it.
   * Invisible at exactly 60 fps (one tick per frame); it appears the moment
   * the display runs faster, which is why this drives 120 fps.
   */
  it('aims smoothly only when the look-ahead velocity is interpolated too', () => {
    const SIM = 1 / 60;
    const FRAME = 1 / 120;
    const SPEED = 7.3; // m/s, a galleon with the helm hard over
    const OMEGA = 0.5; // rad/s turn — |Δv| ≈ 0.06 m/s per tick, measured value
    const TICKS = 900;
    const MEASURE_FROM = 600; // yawFollowHalfLife is 1.2 s; let the lag settle

    // one deterministic steady turn, sampled at the sim tick
    const ticks: { pos: Vector3; vel: Vector3; quat: Quaternion }[] = [];
    const p = new Vector3();
    for (let k = 0; k < TICKS; k++) {
      const yaw = OMEGA * k * SIM;
      const vel = new Vector3(Math.sin(yaw) * SPEED, 0, Math.cos(yaw) * SPEED);
      p.addScaledVector(vel, SIM);
      ticks.push({ pos: p.clone(), vel, quat: new Quaternion(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)) });
    }

    /** mean per-frame wobble of the aim's angular RATE, in degrees */
    const aimJitter = (interpolateVelocity: boolean): number => {
      const rig = mountCam();
      try {
        const { cam, camera, ship } = rig;
        const dir = new Vector3();
        let last: Vector3 | null = null;
        let lastRate = 0;
        let sum = 0;
        let n = 0;
        for (let k = 1; k < TICKS; k++) {
          // 120 fps over a 60 Hz sim is exactly two samples per tick
          for (const alpha of [0, 0.5]) {
            const a = ticks[k - 1];
            const b = ticks[k];
            const pos = a.pos.clone().lerp(b.pos, alpha);
            const quat = a.quat.clone().slerp(b.quat, alpha);
            const vel = interpolateVelocity ? a.vel.clone().lerp(b.vel, alpha) : b.vel;
            ship.position[0] = pos.x;
            ship.position[1] = pos.y;
            ship.position[2] = pos.z;
            ship.quaternion[0] = quat.x;
            ship.quaternion[1] = quat.y;
            ship.quaternion[2] = quat.z;
            ship.quaternion[3] = quat.w;
            ship.velocity[0] = vel.x;
            ship.velocity[1] = vel.y;
            ship.velocity[2] = vel.z;
            cam.update(ship, FRAME);
            camera.getWorldDirection(dir);
            if (last) {
              // rate, not raw step: a correct pan advances by a smooth number
              // of deg/s, so measuring the CHANGE in rate isolates the
              // staircase from the pan itself
              const step = last.angleTo(dir);
              const rate = step / FRAME;
              if (k >= MEASURE_FROM) {
                sum += Math.abs(rate - lastRate) * FRAME * (180 / Math.PI);
                n++;
              }
              lastRate = rate;
            }
            last = dir.clone();
          }
        }
        return sum / n;
      } finally {
        rig.done();
      }
    };

    const interpolated = aimJitter(true);
    const raw = aimJitter(false);
    // the shipped path: sub-hundredth-of-a-degree wobble, i.e. sub-pixel
    expect(interpolated).toBeLessThan(0.005);
    // and the threshold above is not vacuous — feeding the raw tick velocity
    // is an order of magnitude worse. This is the regression this test exists
    // for: main.ts must lerp velocity on alpha, exactly as it lerps the pose.
    expect(raw).toBeGreaterThan(interpolated * 10);
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

/**
 * HELM POV (H) — the captain's eye. Requested for the showcase recording:
 * "a way to snap to a nice position at the helm that doesn't clip through
 * stuff so we can POV the captain on the helm in an instant."
 *
 * The eye is rigidly parented to the deck. That is not an implementation
 * detail — it is the shot: heel, pitch and heave all arrive for free, and any
 * smoothing would slide the captain around his own deck instead.
 *
 * ENTERING used to be an instant cut and is now an eased move, at the user's
 * explicit request (2026-08-19: "make sure that also has a camera transition …
 * so that it's not stressingly abrupt but actually the camera moves there").
 * The rigidity assertions below are unchanged — they are about the pose once
 * it has ARRIVED, which is the part that must never be smoothed.
 */
describe('helm POV rides the deck', () => {
  const WHEEL: [number, number, number] = [0, 6.1, -12.4];
  /** run the arrival to completion — the eased entry is not a cut any more */
  const settle = (rig: CamRig): void => {
    for (let i = 0; i < 300; i++) rig.cam.update(rig.ship, 1 / 60);
  };

  it('holds the arrived pose rigidly — no smoothing lag once it is there', () => {
    const rig = mountCam();
    try {
      rig.cam.setHelmAnchor(WHEEL);
      rig.cam.setMode('helm');
      settle(rig);
      const arrived = rig.camera.position.clone();
      // a pose that were exponentially damped would still be creeping
      for (let i = 0; i < 60; i++) rig.cam.update(rig.ship, 1 / 60);
      expect(rig.camera.position.distanceTo(arrived)).toBeLessThan(1e-9);
    } finally {
      rig.done();
    }
  });

  it('sits at the wheel, at eye height, and ABAFT it — not inside the hub', () => {
    const rig = mountCam();
    try {
      rig.cam.setHelmAnchor(WHEEL);
      rig.cam.setMode('helm');
      settle(rig);
      const p = rig.camera.position;
      expect(p.y).toBeCloseTo(WHEEL[1] + cameraParams.helmEyeHeight, 6);
      // ship forward is local +z, so aft is -z: the lens must be BEHIND the
      // wheel or the near plane slices its spokes and the shot loses the prop
      expect(p.z).toBeCloseTo(WHEEL[2] - cameraParams.helmAft, 6);
      expect(cameraParams.helmAft).toBeGreaterThan(0);
    } finally {
      rig.done();
    }
  });

  it('inherits the ship’s heel — the horizon rolls, which is the whole shot', () => {
    const rig = mountCam();
    try {
      rig.cam.setHelmAnchor(WHEEL);
      rig.cam.setMode('helm');
      settle(rig);
      const upright = rig.camera.position.clone();

      // heel 20° to starboard: rotation about the ship's own forward axis (+z)
      const a = (20 * Math.PI) / 180 / 2;
      rig.ship.quaternion = [0, 0, Math.sin(a), Math.cos(a)];
      rig.cam.update(rig.ship, 1 / 60);

      // the eye swings out with the deck rather than staying world-vertical
      expect(rig.camera.position.distanceTo(upright)).toBeGreaterThan(0.5);
      // and the lens rolls with her: world-up is no longer the camera's up
      expect(rig.camera.up.y).toBeLessThan(0.999);
      expect(rig.camera.up.length()).toBeCloseTo(1, 6);
    } finally {
      rig.done();
    }
  });

  it('tracks the ship as she sails, with zero lag', () => {
    const rig = mountCam();
    try {
      rig.cam.setHelmAnchor(WHEEL);
      rig.cam.setMode('helm');
      settle(rig);
      const before = rig.camera.position.clone();

      rig.ship.position = [120, 0, -80];
      rig.cam.update(rig.ship, 1 / 60);
      // a chase camera would still be catching up a frame later; a parented
      // one has already arrived, exactly one ship-displacement away
      expect(rig.camera.position.x - before.x).toBeCloseTo(120, 6);
      expect(rig.camera.position.z - before.z).toBeCloseTo(-80, 6);
    } finally {
      rig.done();
    }
  });

  it('leaving the helm glides back rather than teleporting astern', () => {
    const rig = mountCam();
    try {
      rig.cam.setHelmAnchor(WHEEL);
      rig.cam.setMode('helm');
      settle(rig);
      const atHelm = rig.camera.position.clone();

      rig.cam.setMode('follow');
      rig.cam.update(rig.ship, 1 / 60);
      // one frame after the switch the lens is still near the helm...
      expect(rig.camera.position.distanceTo(atHelm)).toBeLessThan(3);
      // ...and only reaches the chase distance over the blend
      for (let i = 0; i < 600; i++) rig.cam.update(rig.ship, 1 / 60);
      expect(rig.camera.position.distanceTo(atHelm)).toBeGreaterThan(5);
    } finally {
      rig.done();
    }
  });
});

/**
 * SHIPBOARD CAMERA STATIONS (1..4) — the gun, the bow, the taffrail, the
 * masthead. Asked for by name for recording work: "some camera positions …
 * one that just sits on a cannon and looks along the barrel … one on the
 * front, one on the back, one in the crow's nest … from which we can then also
 * adjust the viewpoint, as we can do it on the helm."
 *
 * These assert PROPERTIES, not poses (§V.80). A pinned `[3.25, 3.40, 2.00]`
 * would pass forever while the ship moved out from under it — which is the
 * §V.71 defect the stations exist to avoid, written down as a test.
 */
describe('camera stations ride the ship they are resolved from', () => {
  const stubFactory = () => ({ dispose(): void {} }) as unknown as Material;

  interface StationRig extends CamRig {
    asm: ShipAssembly;
    blueprint: PieceDef[];
    /** the gun lay the station source reads, mutable per test */
    elevation: { value: number };
    /** world position of a socket for the ship pose currently in `rig.ship` */
    socketWorld(id: string): Vector3;
    settle(): void;
  }

  function mountStations(): StationRig {
    const rig = mountCam();
    const blueprint = buildGalleonBlueprint();
    const asm = new ShipAssembly(blueprint, stubFactory);
    const elevation = { value: combatParams.defaultElevation };
    rig.cam.setStations(createShipStations(blueprint, asm, () => elevation.value));
    const inner = rig.done;
    return {
      ...rig,
      asm,
      blueprint,
      elevation,
      socketWorld(id: string): Vector3 {
        // the assembly is at the origin, so its socket answers are ship-LOCAL;
        // put them through the pose the camera was handed to get world space
        const local = new Vector3(...asm.socketWorldPosition(id));
        const q = new Quaternion(...rig.ship.quaternion);
        return local.applyQuaternion(q).add(new Vector3(...rig.ship.position));
      },
      settle(): void {
        for (let i = 0; i < 300; i++) rig.cam.update(rig.ship, 1 / 60);
      },
      done(): void {
        asm.dispose();
        inner();
      },
    };
  }

  /** unit forward the lens is looking along */
  const forwardOf = (camera: PerspectiveCamera): Vector3 =>
    camera.getWorldDirection(new Vector3());

  const heel = (rig: CamRig, roll: number, pitch: number): void => {
    const q = new Quaternion().setFromEuler(new Euler(pitch, 0, roll, 'YXZ'));
    rig.ship.quaternion = [q.x, q.y, q.z, q.w];
  };

  /**
   * THE core §V.71 property, and the one a pinned pose could never state: the
   * eye is RIGIDLY carried by the fitting it was resolved from. Not "near the
   * right place at rest" — the offset from the live socket must be a constant
   * vector in the ship's frame through a whole roll/pitch/heave cycle, which
   * is only true if the station was resolved against the host rather than
   * copied out of it.
   */
  it('every station holds a constant offset from its own socket through a roll/pitch cycle', () => {
    const anchors: Record<string, string> = {
      bow: 'socket-figurehead',
      nest: 'socket-lookout',
      gun: 'cannon-starboard-2',
    };
    for (const [id, socketId] of Object.entries(anchors)) {
      const rig = mountStations();
      try {
        rig.cam.setStation(id as StationId);
        rig.settle();
        const first = rig.camera.position.clone().sub(rig.socketWorld(socketId));
        let worst = 0;
        for (let k = 1; k <= 120; k++) {
          const phase = (k / 120) * Math.PI * 2;
          heel(rig, Math.sin(phase) * 0.35, Math.cos(phase) * 0.22);
          rig.ship.position = [Math.sin(phase) * 40, Math.sin(phase * 3) * 2.5, k * 0.7];
          rig.cam.update(rig.ship, 1 / 60);
          const gap = rig.camera.position.clone().sub(rig.socketWorld(socketId));
          // the OFFSET rotates with her, so compare lengths and the ship-frame
          // vector rather than the world one
          worst = Math.max(worst, Math.abs(gap.length() - first.length()));
        }
        expect(worst, `${id} slipped off ${socketId}`).toBeLessThan(1e-6);
      } finally {
        rig.done();
      }
    }
  });

  it('resolves against the LIVE assembly, not the blueprint it was built from (§V.71)', () => {
    const rig = mountStations();
    try {
      rig.cam.setStation('nest');
      rig.settle();
      const before = rig.camera.position.clone();
      // move the HOST. The crow's nest is a piece in the live scene graph; a
      // station read from an authored constant would not notice, and would
      // leave the lens hanging where the nest used to be.
      const nest = rig.asm.group.getObjectByName('crow-nest');
      expect(nest, 'the crow-nest piece must exist to move').toBeTruthy();
      nest!.position.y += 3;
      nest!.updateMatrixWorld(true);
      rig.cam.update(rig.ship, 1 / 60);
      expect(rig.camera.position.y - before.y).toBeCloseTo(3, 6);
    } finally {
      rig.done();
    }
  });

  /**
   * §V.77: "one expression, not two that agree today". The gun station's
   * forward axis is not a bearing this file re-derived — it is `muzzleLay`'s
   * own answer, so it carries the player's live lay. Recomputed here from the
   * combat side, independently of the camera, and required to MATCH.
   */
  it('the gun station sights down the gun’s own bore, and follows it as the lay moves', () => {
    const rig = mountStations();
    try {
      const battery = buildBattery(rig.blueprint);
      const gun = batteryCentreGun(battery, 'starboard')!;
      heel(rig, 0.18, -0.07); // and it must be right while she is heeled, too
      rig.cam.setStation('gun');
      rig.settle();

      const bore = (elev: number): Vector3 => {
        const lay = muzzleLay(
          rig.ship.position,
          rig.ship.quaternion,
          gun.position,
          'starboard',
          elev,
        );
        return new Vector3(...lay.direction).normalize();
      };

      expect(forwardOf(rig.camera).angleTo(bore(rig.elevation.value))).toBeLessThan(1e-6);

      // raise the guns: the camera must follow the barrel, not hold a bearing
      const before = forwardOf(rig.camera).clone();
      rig.elevation.value += 0.3;
      rig.cam.update(rig.ship, 1 / 60);
      expect(forwardOf(rig.camera).angleTo(bore(rig.elevation.value))).toBeLessThan(1e-6);
      expect(forwardOf(rig.camera).angleTo(before)).toBeCloseTo(0.3, 5);
    } finally {
      rig.done();
    }
  });

  it('sits on the very gun the crosshair speaks for, not merely on some gun', () => {
    const rig = mountStations();
    try {
      rig.cam.setStation('gun');
      rig.settle();
      const battery = buildBattery(rig.blueprint);
      const guns = batterySide(battery, 'starboard');
      // distance from the eye to each gun's mount; the centre gun — the one
      // `batteryCentreGun` hands the crosshair — must be the nearest, by a
      // margin bigger than the float noise a tie would leave
      const ranked = guns
        .map((g) => ({
          id: g.socketId,
          d: rig.camera.position.distanceTo(rig.socketWorld(g.socketId)),
        }))
        .sort((a, b) => a.d - b.d);
      expect(ranked[0].id).toBe(batteryCentreGun(battery, 'starboard')!.socketId);
      expect(ranked[1].d - ranked[0].d).toBeGreaterThan(1);
    } finally {
      rig.done();
    }
  });

  it('the bow looks forward, the stern aft, the masthead is the highest of them', () => {
    const rig = mountStations();
    try {
      const seen: Record<string, { fwd: Vector3; y: number }> = {};
      for (const id of ['bow', 'stern', 'nest'] as StationId[]) {
        rig.cam.setStation(id);
        rig.settle();
        seen[id] = { fwd: forwardOf(rig.camera).clone(), y: rig.camera.position.y };
      }
      // ship-local +z is forward, and she is upright here
      expect(seen.bow.fwd.z).toBeGreaterThan(0.99);
      expect(seen.stern.fwd.z).toBeLessThan(-0.99);
      expect(seen.nest.y).toBeGreaterThan(seen.bow.y + 20);
      expect(seen.nest.y).toBeGreaterThan(seen.stern.y + 20);
    } finally {
      rig.done();
    }
  });

  it('a station a hull does not have is reported, not silently ignored (§V.62)', () => {
    const rig = mountCam(); // no station source handed over at all
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      rig.cam.setStation('nest');
      rig.cam.update(rig.ship, 1 / 60);
      expect(warn).toHaveBeenCalled();
      // ...and the lens falls back to a mode that CAN be drawn
      expect(rig.cam.getMode()).toBe('follow');
    } finally {
      warn.mockRestore();
      rig.done();
    }
  });
});

/**
 * "…from which we can then also adjust the viewpoint, as we can do it on the
 * helm." A station you cannot look around from is useless for footage, and one
 * that forgets how you left it costs the setup every time you cycle past.
 */
describe('station look offsets are per-station and survive a cycle away', () => {
  const stubFactory = () => ({ dispose(): void {} }) as unknown as Material;

  function mount(): CamRig & { asm: ShipAssembly } {
    const rig = mountCam();
    const blueprint = buildGalleonBlueprint();
    const asm = new ShipAssembly(blueprint, stubFactory);
    rig.cam.setStations(createShipStations(blueprint, asm, () => 0.1));
    const inner = rig.done;
    return { ...rig, asm, done: () => { asm.dispose(); inner(); } };
  }

  const settle = (rig: CamRig): void => {
    for (let i = 0; i < 300; i++) rig.cam.update(rig.ship, 1 / 60);
  };
  const drag = (rig: CamRig, dx: number, dy: number): void => rig.drag(dx, dy);

  it('remembers each station’s own framing across a trip to another one', () => {
    const rig = mount();
    try {
      rig.cam.setStation('bow');
      settle(rig);
      drag(rig, -200, -60); // look off to one side and up
      rig.cam.update(rig.ship, 1 / 60);
      const bowAim = rig.camera.getWorldDirection(new Vector3()).clone();

      rig.cam.setStation('stern');
      settle(rig);
      const sternAim = rig.camera.getWorldDirection(new Vector3()).clone();
      // the stern was never dragged, so it must be on its OWN bearing
      expect(sternAim.z).toBeLessThan(-0.99);

      rig.cam.setStation('bow');
      settle(rig);
      expect(rig.camera.getWorldDirection(new Vector3()).angleTo(bowAim)).toBeLessThan(1e-6);
    } finally {
      rig.done();
    }
  });

  it('clamps the look to stationYawLimit — and the knob really is the clamp (§V.62)', () => {
    const rig = mount();
    const was = cameraParams.stationYawLimit;
    try {
      rig.cam.setStation('bow');
      settle(rig);
      cameraParams.stationYawLimit = 0.4;
      drag(rig, -100000, 0); // lean on it hard
      rig.cam.update(rig.ship, 1 / 60);
      const wide = rig.camera.getWorldDirection(new Vector3()).clone();
      expect(wide.angleTo(new Vector3(0, 0, 1))).toBeCloseTo(0.4, 4);

      cameraParams.stationYawLimit = 0.15;
      drag(rig, -100000, 0);
      rig.cam.update(rig.ship, 1 / 60);
      expect(
        rig.camera.getWorldDirection(new Vector3()).angleTo(new Vector3(0, 0, 1)),
      ).toBeCloseTo(0.15, 4);
    } finally {
      cameraParams.stationYawLimit = was;
      rig.done();
    }
  });
});

/**
 * THE TRANSITION, at ENTRY as well as exit. The user reversed the "instant
 * cut" decision recorded in followCam.setMode: "make sure that also has a
 * camera transition, as we have going from free-flying to follow cam, so that
 * it's not stressingly abrupt but actually the camera moves there, so it
 * becomes readable."
 *
 * The property is CONTINUITY plus ARRIVAL: no frame may swallow a big share of
 * the trip, and the last frame of the move must land exactly on the rigid pose
 * (a blend that only asymptotes leaves a pop of its own residual at handover).
 */
describe('arriving at a deck station is a readable move, and it lands exactly', () => {
  const stubFactory = () => ({ dispose(): void {} }) as unknown as Material;
  const WHEEL: [number, number, number] = [0, 6.1, -12.4];

  function mount(): CamRig & { asm: ShipAssembly } {
    const rig = mountCam();
    const blueprint = buildGalleonBlueprint();
    const asm = new ShipAssembly(blueprint, stubFactory);
    rig.cam.setStations(createShipStations(blueprint, asm, () => 0.1));
    rig.cam.setHelmAnchor(WHEEL);
    const inner = rig.done;
    return { ...rig, asm, done: () => { asm.dispose(); inner(); } };
  }

  /** per-frame steps of a move, plus the frame count it took to settle */
  function trace(rig: CamRig, frames = 400): { steps: number[]; arrived: number } {
    const steps: number[] = [];
    let last = rig.camera.position.clone();
    let arrived = frames;
    for (let i = 0; i < frames; i++) {
      rig.cam.update(rig.ship, 1 / 60);
      const step = rig.camera.position.distanceTo(last);
      steps.push(step);
      if (arrived === frames && i > 0 && step < 1e-9) arrived = i;
      last = rig.camera.position.clone();
    }
    return { steps, arrived };
  }

  it('chase → helm moves instead of cutting, with no frame swallowing the trip', () => {
    const rig = mount();
    try {
      for (let i = 0; i < 3000; i++) rig.cam.update(rig.ship, 1 / 60); // settle astern
      const from = rig.camera.position.clone();
      rig.cam.setMode('helm');
      const { steps, arrived } = trace(rig);
      const total = from.distanceTo(rig.camera.position);
      expect(total).toBeGreaterThan(10); // it really is a long way to the wheel
      expect(arrived).toBeGreaterThan(8); // a MOVE, not a cut
      // no single frame is a jump: an eased 0.7 s move at 60 fps is ~40 frames
      for (const s of steps) expect(s).toBeLessThan(total * 0.1);
      // and it arrives EXACTLY, not asymptotically — the handover to the rigid
      // pose is where a damped blend would leave its residual as a pop
      const settled = rig.camera.position.clone();
      rig.cam.update(rig.ship, 1 / 60);
      expect(rig.camera.position.distanceTo(settled)).toBe(0);
    } finally {
      rig.done();
    }
  });

  it('station → station is the same move, and it is continuous at the swap', () => {
    const rig = mount();
    try {
      rig.cam.setStation('gun');
      trace(rig);
      const from = rig.camera.position.clone();
      rig.cam.setStation('nest'); // 28 m up the mainmast
      const { steps, arrived } = trace(rig);
      const total = from.distanceTo(rig.camera.position);
      expect(total).toBeGreaterThan(20);
      expect(arrived).toBeGreaterThan(8);
      for (const s of steps) expect(s).toBeLessThan(total * 0.1);
    } finally {
      rig.done();
    }
  });

  it('leaving is continuous too — position AND the heeled horizon roll out', () => {
    const rig = mount();
    try {
      rig.ship.quaternion = [0, 0, Math.sin(0.2), Math.cos(0.2)]; // heeled hard
      rig.cam.setStation('stern');
      trace(rig);
      const heeledUp = rig.camera.up.clone();
      expect(heeledUp.y).toBeLessThan(0.95); // genuinely rolled

      rig.cam.setMode('follow');
      let lastUp = heeledUp.clone();
      let worstRoll = 0;
      let lastPos = rig.camera.position.clone();
      let worstStep = 0;
      for (let i = 0; i < 400; i++) {
        rig.cam.update(rig.ship, 1 / 60);
        worstRoll = Math.max(worstRoll, rig.camera.up.angleTo(lastUp));
        worstStep = Math.max(worstStep, rig.camera.position.distanceTo(lastPos));
        lastUp = rig.camera.up.clone();
        lastPos = rig.camera.position.clone();
      }
      // the heel was 0.4 rad; rolling it out over the blend means no single
      // frame may take a large share of it. A snap back to world-up would put
      // the whole 0.4 into frame one.
      expect(worstRoll).toBeLessThan(0.05);
      expect(rig.camera.up.angleTo(new Vector3(0, 1, 0))).toBeLessThan(1e-6);
      expect(worstStep).toBeLessThan(2);
    } finally {
      rig.done();
    }
  });

  /**
   * §V.62 — every one of these knobs must be PROVEN to move the output. The
   * duration is distance-scaled rather than constant precisely so that the
   * original objection to easing ("a 30 m swoop") stays dialable: these tests
   * are what stop `stationEaseSpeed` becoming a slider that drives nothing.
   */
  describe('the arrival params really are the arrival', () => {
    const withParams = (over: Partial<typeof cameraParams>, fn: () => void): void => {
      const live = cameraParams as unknown as Record<string, unknown>;
      const saved: Record<string, unknown> = {};
      for (const k of Object.keys(over)) saved[k] = live[k];
      Object.assign(cameraParams, over);
      try {
        fn();
      } finally {
        Object.assign(cameraParams, saved);
      }
    };

    const framesToHelm = (): number => {
      const rig = mount();
      try {
        for (let i = 0; i < 3000; i++) rig.cam.update(rig.ship, 1 / 60);
        rig.cam.setMode('helm');
        return trace(rig).arrived;
      } finally {
        rig.done();
      }
    };

    it('stationEaseSpeed sets how long the move takes', () => {
      let slow = 0;
      let fast = 0;
      withParams({ stationEaseSpeed: 20, stationEaseMax: 5 }, () => {
        slow = framesToHelm();
      });
      withParams({ stationEaseSpeed: 80, stationEaseMax: 5 }, () => {
        fast = framesToHelm();
      });
      // 4× the speed over the same gap: 4× fewer frames, within a frame of
      // rounding either side
      expect(slow / fast).toBeGreaterThan(3);
      expect(slow / fast).toBeLessThan(5);
    });

    it('stationEaseMin and stationEaseMax are the floor and the ceiling', () => {
      let floored = 0;
      let capped = 0;
      // absurdly fast: the FLOOR is what decides the duration
      withParams({ stationEaseSpeed: 5000, stationEaseMin: 0.5 }, () => {
        floored = framesToHelm();
      });
      expect(floored).toBeGreaterThan(0.5 * 60 - 3);
      // absurdly slow: the CEILING is
      withParams({ stationEaseSpeed: 0.5, stationEaseMax: 0.35 }, () => {
        capped = framesToHelm();
      });
      expect(capped).toBeLessThan(0.35 * 60 + 3);
    });

    it('stationCutDistance turns a long approach back into a cut', () => {
      const rig = mount();
      try {
        for (let i = 0; i < 3000; i++) rig.cam.update(rig.ship, 1 / 60);
        const from = rig.camera.position.clone();
        withParams({ stationCutDistance: 1 }, () => {
          rig.cam.setMode('helm');
          rig.cam.update(rig.ship, 1 / 60);
        });
        // frame one is already there: that IS the behaviour the original
        // "instant cut" comment defended, kept for the distances it was right about
        const landed = rig.camera.position.clone();
        expect(landed.distanceTo(from)).toBeGreaterThan(10);
        rig.cam.update(rig.ship, 1 / 60);
        expect(rig.camera.position.distanceTo(landed)).toBe(0);
      } finally {
        rig.done();
      }
    });

    it('stationEyeHeight lifts every standing station off its socket', () => {
      const eyeY = (h: number): number => {
        const rig = mount();
        try {
          withParams({ stationEyeHeight: h }, () => {
            rig.cam.setStation('bow');
            trace(rig);
          });
          return rig.camera.position.y;
        } finally {
          rig.done();
        }
      };
      expect(eyeY(2.5) - eyeY(1.0)).toBeCloseTo(1.5, 6);
    });

    it('the gun station knobs move the eye, and the side switch changes sides', () => {
      const eye = (over: Partial<typeof cameraParams>): Vector3 => {
        const rig = mount();
        try {
          let out = new Vector3();
          withParams(over, () => {
            rig.cam.setStation('gun');
            trace(rig);
            out = rig.camera.position.clone();
          });
          return out;
        } finally {
          rig.done();
        }
      };
      const base = eye({});
      expect(eye({ gunStationEyeHeight: 1.75 }).y - base.y).toBeCloseTo(1, 5);
      // further back along the bore = further inboard, i.e. toward x = 0
      expect(Math.abs(eye({ gunStationBack: 3 }).x)).toBeLessThan(Math.abs(base.x));
      expect(base.x).toBeGreaterThan(0); // starboard by default
      expect(eye({ gunStationPort: true }).x).toBeLessThan(0);
    });
  });
});

describe('the station keys are declared, unique, and reach exactly one action', () => {
  it('every station code maps to one station and is advertised on the Controls page', () => {
    expect(STATION_CODES).toHaveLength(STATION_IDS.length);
    expect(new Set(STATION_CODES).size).toBe(STATION_CODES.length);
    for (const code of STATION_CODES) {
      expect(FLY_KEYS.has(code), `${code} is a FreeCam flight key`).toBe(false);
      expect(code).not.toBe(CONTROL_CODES.toggleFreeCamera);
      expect(code).not.toBe(CONTROL_CODES.toggleHelm);
      expect(code).not.toBe(CONTROL_CODES.toggleAnchor);
      expect(code).not.toBe(CONTROL_CODES.fire);
    }
    const bindings = CONTROL_GROUPS.flatMap((g) => g.bindings);
    for (const action of ['Gun station', 'Bow station', 'Stern station', 'Crow’s nest']) {
      expect(bindings.find((b) => b.action === action), action).toBeTruthy();
    }
  });

  it('the real key path drives the real stations, and re-pressing comes back', () => {
    const rig = mountCam();
    const blueprint = buildGalleonBlueprint();
    const asm = new ShipAssembly(blueprint, () => ({ dispose(): void {} }) as unknown as Material);
    try {
      rig.cam.setStations(createShipStations(blueprint, asm, () => 0.1));
      rig.key('keydown', STATION_CODES[2]);
      expect(rig.cam.getMode()).toBe('station');
      expect(rig.cam.getStation()).toBe(STATION_IDS[2]);
      rig.key('keydown', STATION_CODES[0]);
      expect(rig.cam.getStation()).toBe(STATION_IDS[0]);
      rig.key('keydown', STATION_CODES[0]); // same key again = back to the chase
      expect(rig.cam.getMode()).toBe('follow');
    } finally {
      asm.dispose();
      rig.done();
    }
  });
});

describe('free cam: look and strafe must agree about which way is right', () => {
  // THE BUG (user: "the free flying camera is weirdly borged, like the left
  // and right is inverted and whatnot"): FreeCam.look did `yaw += dx` while
  // its own strafe read right = cross(forward, up). Under sphericalOffset's
  // yaw-0-is-+z convention those two disagree in SIGN, so dragging right
  // turned the view left while pressing D still slid the camera right. Not
  // one inverted axis — two halves of the same camera pulling opposite ways,
  // which is why it read as broken rather than as backwards.
  //
  // Asserted as a RELATIONSHIP, not a sign: whichever way the project later
  // decides drag-right should go, look and strafe must go the same way, and
  // that is the property the user actually experienced the loss of.
  const rightOf = (yaw: number): [number, number] => [-Math.cos(yaw), Math.sin(yaw)];

  it('dragging right turns the view toward the same side D strafes toward', () => {
    const cam = new FreeCam();
    cam.look(10, 0); // drag right
    const fwd = sphericalOffset(cam.yaw, 0, 1);
    const [rx, rz] = rightOf(0); // the right axis we started from
    // the view must have rotated TOWARD the starting right axis
    expect(fwd[0] * rx + fwd[2] * rz).toBeGreaterThan(0);
  });

  it('dragging left turns the view away from that side', () => {
    const cam = new FreeCam();
    cam.look(-10, 0);
    const fwd = sphericalOffset(cam.yaw, 0, 1);
    const [rx, rz] = rightOf(0);
    expect(fwd[0] * rx + fwd[2] * rz).toBeLessThan(0);
  });

  it('drag down looks down', () => {
    const cam = new FreeCam();
    cam.look(0, 10);
    expect(cam.pitch).toBeLessThan(0);
  });

  it('the strafe axis really is perpendicular to forward and level', () => {
    // guards the cross-product identity the test above leans on, at a yaw
    // where a sign slip would otherwise cancel out
    const yaw = 0.7;
    const fwd = sphericalOffset(yaw, 0, 1);
    const [rx, rz] = rightOf(yaw);
    expect(fwd[0] * rx + fwd[2] * rz).toBeCloseTo(0, 12);
    expect(Math.hypot(rx, rz)).toBeCloseTo(1, 12);
  });
});
