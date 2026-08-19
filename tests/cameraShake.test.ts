/**
 * CAMERA SHAKE from gunfire and impacts.
 *
 * THE TEST THAT MATTERS MOST is the round-trip one. `FollowCam.update()`
 * calls `this.free.adoptExternal(this.camera, ...)` in free mode — by design,
 * so that moving the lens from the console is adopted rather than stomped.
 * A shake left on the camera when that runs would be read as "the user moved
 * the lens", folded into the free camera's own yaw/pitch, and NEVER REMOVED:
 * every frame would add a little more. It fails silently and cumulatively,
 * with no error and no NaN, and it would surface as a free-camera drift bug
 * in a completely different file from the one that caused it.
 *
 * So `restore` must return the camera BIT-FOR-BIT to the pose followCam left,
 * and that is asserted here over many frames rather than one, because "leaks
 * a little each frame" is precisely the failure mode.
 */
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { createCameraShake } from '../src/combat/cameraShake';
import { combatShakeParams } from '../src/params/combat';

const DT = 1 / 60;

function camAt(x = 0, y = 0, z = 0): PerspectiveCamera {
  const c = new PerspectiveCamera();
  c.position.set(x, y, z);
  c.updateMatrixWorld(true);
  return c;
}

/** the exact order main.ts uses, run n times */
function pump(
  shake: ReturnType<typeof createCameraShake>,
  camera: PerspectiveCamera,
  frames: number,
  onFrame?: (i: number) => void,
): void {
  for (let i = 0; i < frames; i++) {
    shake.restore(camera);
    onFrame?.(i);
    shake.update(DT, camera);
    shake.apply(camera);
  }
}

describe('the shake never leaks into the camera it borrows', () => {
  it('restore returns the EXACT pose, every frame, for a long run', () => {
    // the §B.8/§B.31 shape: silent, cumulative, no error anywhere. If restore
    // drifts by a millionth per frame this goes red within a few seconds of
    // simulated time, which is the point.
    const shake = createCameraShake();
    const camera = camAt(0, 5, 0);
    const truth = new Quaternion().copy(camera.quaternion);

    pump(shake, camera, 600, (i) => {
      // followCam's job, stubbed: it re-asserts the true pose every frame
      camera.quaternion.copy(truth);
      if (i % 40 === 0) shake.impulse(0, 5, 3, 1);
    });

    shake.restore(camera);
    expect(camera.quaternion.x).toBe(truth.x);
    expect(camera.quaternion.y).toBe(truth.y);
    expect(camera.quaternion.z).toBe(truth.z);
    expect(camera.quaternion.w).toBe(truth.w);
  });

  it('actually rotates the lens while it is live — restore is not a no-op', () => {
    // the guard above would pass trivially if apply() did nothing
    const shake = createCameraShake();
    const camera = camAt(0, 5, 0);
    const truth = new Quaternion().copy(camera.quaternion);
    shake.impulse(0, 5, 1, 1);
    shake.update(DT, camera);
    shake.apply(camera);
    expect(camera.quaternion.angleTo(truth)).toBeGreaterThan(1e-5);
  });

  it('a caller that skips restore loses the shake rather than corrupting the pose', () => {
    const shake = createCameraShake();
    const camera = camAt();
    shake.impulse(0, 0, 1, 1);
    shake.update(DT, camera);
    shake.apply(camera);
    // restore twice: the second must not "un-restore" back into a shaken pose
    const after = new Quaternion();
    shake.restore(camera);
    after.copy(camera.quaternion);
    shake.restore(camera);
    expect(camera.quaternion.angleTo(after)).toBe(0);
  });
});

describe('distance scaling — a far hit is a tremor, then nothing', () => {
  const peakFor = (distance: number, strength = 1): number => {
    const shake = createCameraShake();
    const camera = camAt(0, 0, 0);
    shake.impulse(distance, 0, 0, strength);
    shake.update(DT, camera);
    return shake.level();
  };

  it('nearer shakes harder', () => {
    expect(peakFor(5)).toBeGreaterThan(peakFor(40));
    expect(peakFor(40)).toBeGreaterThan(peakFor(200));
    expect(peakFor(200)).toBeGreaterThan(0);
  });

  it('past maxDistance it is EXACTLY zero, not an asymptote', () => {
    // an inverse-square tail alone leaves a permanent low hum under sustained
    // fire, which reads as the camera never settling
    expect(peakFor(combatShakeParams.maxDistance + 1)).toBe(0);
    expect(peakFor(combatShakeParams.maxDistance * 4)).toBe(0);
  });

  it('a hit on someone else still carries — silence at range is wrong too', () => {
    const own = peakFor(60, combatShakeParams.ownHitStrength);
    const other = peakFor(60, combatShakeParams.otherHitStrength);
    expect(other).toBeGreaterThan(0);
    expect(other).toBeLessThan(own);
  });
});

describe('a full broadside cannot throw the lens off the ship (§V.44)', () => {
  it('sums many impulses and then CLAMPS', () => {
    const shake = createCameraShake();
    const camera = camAt();
    for (let i = 0; i < 40; i++) shake.impulse(1, 0, 0, 1);
    shake.update(DT, camera);
    expect(shake.level()).toBeLessThanOrEqual(combatShakeParams.maxLevel + 1e-9);
  });

  it('the resulting rotation stays within the authored amplitudes', () => {
    const shake = createCameraShake();
    const camera = camAt();
    const truth = new Quaternion().copy(camera.quaternion);
    let worst = 0;
    for (let i = 0; i < 300; i++) {
      shake.restore(camera);
      camera.quaternion.copy(truth);
      for (let k = 0; k < 8; k++) shake.impulse(2, 0, 0, 1);
      shake.update(DT, camera);
      shake.apply(camera);
      worst = Math.max(worst, camera.quaternion.angleTo(truth));
    }
    // the three axes can align at worst; the bound is their sum, and nothing
    // may exceed it however many guns fire
    const bound = combatShakeParams.yawAmplitude
      + combatShakeParams.pitchAmplitude
      + combatShakeParams.rollAmplitude;
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThanOrEqual(bound * 1.05);
  });

  it('gain 0 disables the whole system — the knob to reach for first', () => {
    const off = { ...combatShakeParams, gain: 0 };
    const shake = createCameraShake(off);
    const camera = camAt();
    const truth = new Quaternion().copy(camera.quaternion);
    for (let i = 0; i < 20; i++) shake.impulse(1, 0, 0, 1);
    shake.update(DT, camera);
    shake.apply(camera);
    expect(shake.level()).toBe(0);
    expect(camera.quaternion.angleTo(truth)).toBe(0);
  });
});

describe('the envelope settles, and the phase does not run away (§V.55)', () => {
  it('decays to exactly zero and stays there', () => {
    const shake = createCameraShake();
    const camera = camAt();
    shake.impulse(1, 0, 0, 1);
    pump(shake, camera, 600);
    expect(shake.level()).toBe(0);
  });

  it('ten minutes of continuous fire does not change the wobble RATE', () => {
    // §B.30: `time x rate` reached 59.5 Hz at ten minutes because elapsed time
    // multiplies every wobble in the rate. An accumulated phase cannot: the
    // motion has to look the same at t=0 and t=600 s. Measured as zero
    // crossings per second of the applied roll, early vs late.
    const shake = createCameraShake();
    const camera = camAt();
    const truth = new Quaternion().copy(camera.quaternion);
    const euler = new Vector3();

    const crossings = (frames: number): number => {
      let last = 0;
      let n = 0;
      for (let i = 0; i < frames; i++) {
        shake.restore(camera);
        camera.quaternion.copy(truth);
        shake.impulse(1, 0, 0, 1);
        shake.update(DT, camera);
        shake.apply(camera);
        euler.set(camera.quaternion.x, camera.quaternion.y, camera.quaternion.z);
        const v = euler.z;
        if (last !== 0 && Math.sign(v) !== Math.sign(last)) n++;
        last = v;
      }
      return n;
    };

    const early = crossings(600);
    // burn ten minutes of simulated time under sustained fire
    for (let i = 0; i < 36000; i++) {
      shake.restore(camera);
      camera.quaternion.copy(truth);
      shake.impulse(1, 0, 0, 1);
      shake.update(DT, camera);
      shake.apply(camera);
    }
    const late = crossings(600);

    expect(early).toBeGreaterThan(0);
    expect(late / early).toBeGreaterThan(0.85);
    expect(late / early).toBeLessThan(1.15);
  });

  it('survives a hostile dt and a hostile impulse without a NaN pose', () => {
    const shake = createCameraShake();
    const camera = camAt();
    shake.impulse(Number.NaN, 0, 0, 1);
    shake.impulse(0, 0, 1, Number.NaN);
    shake.impulse(0, 0, 1, 1);
    shake.update(Number.NaN, camera);
    shake.apply(camera);
    for (const v of camera.quaternion.toArray()) expect(Number.isFinite(v)).toBe(true);
    expect(Number.isFinite(shake.level())).toBe(true);
  });
});
