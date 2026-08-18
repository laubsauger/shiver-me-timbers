/**
 * Camera shake from gunfire and impacts.
 *
 * ── WHY IT LIVES IN src/combat AND NOT src/camera ──────────────────────
 * Every impulse comes from a combat event and every tunable is a combat
 * tunable. `src/camera/` owns how the lens FOLLOWS; this owns how the lens is
 * DISTURBED, and keeping them apart means `followCam.update()` needs no
 * knowledge of combat and combat needs no knowledge of camera modes.
 *
 * ── THE TRAP THAT DICTATES THE WHOLE DESIGN ────────────────────────────
 * `FollowCam.update()` calls `this.free.adoptExternal(this.camera, ...)` in
 * free mode — deliberately, so that moving the lens from the console or from
 * another system is ADOPTED rather than stomped. That is correct for its
 * intended callers and lethal here: a shake left on the camera when
 * `update()` next runs would be read as "the user moved the lens", folded
 * into the free camera's own yaw/pitch, and never removed. Every frame would
 * add a little more. It fails SILENTLY and CUMULATIVELY — no error, no NaN,
 * just a camera that slowly rotates away from where it was pointed, which
 * would read as a free-cam drift bug in a completely different file.
 *
 * So the shake is never left on the camera across a `followCam.update()`.
 * The call order is fixed and is the reason `restore` exists at all:
 *
 *     shake.restore(camera);        // put the TRUE pose back
 *     followCam.update(...);        // never sees a shaken camera
 *     shake.update(dt, camera);     // decay envelopes, distance-scale impulses
 *     shake.apply(camera);          // offset, remembering the true pose
 *
 * `restore` is a no-op when nothing was applied, so a caller that drops it
 * for one frame loses the shake rather than corrupting the camera.
 *
 * ── ROTATION, NOT TRANSLATION ──────────────────────────────────────────
 * A positional shake at this scale pushes the lens through the hull, the
 * rigging and the sea surface, and it fights `enforceMinHeight`. A rotational
 * one cannot clip anything, reads stronger per unit of amplitude at typical
 * fields of view, and composes trivially with a camera that is already being
 * chased and damped.
 *
 * §V.55: every oscillator ACCUMULATES PHASE. `time x rate` is not a phase
 * once the rate can move, and these rates are params — §B.30 measured a
 * 0.93 Hz flag carrier reaching 59.5 Hz at ten minutes that way. Each axis
 * and each harmonic carries its OWN accumulator, because multiplying a
 * wrapped phase by a non-integer ratio breaks continuity at every wrap.
 * §V.44: contributions are summed and then CLAMPED, so a full broadside
 * cannot throw the lens off the ship.
 */
import { Euler, Quaternion, Vector3, type Object3D } from 'three';
import { combatShakeParams, type CombatShakeParams } from '../params/combat';

const TAU = Math.PI * 2;

/** an impulse waiting to be distance-scaled against this frame's camera */
interface Pending {
  x: number;
  y: number;
  z: number;
  strength: number;
}

export interface CameraShake {
  /**
   * Record a shake source at a world point. `strength` 0..1 is the event's
   * own violence BEFORE distance: a broadside gun is 1, a hit on us is 1, a
   * hit on someone else is lower. Distance falloff is applied in `update`,
   * against the camera position of the frame that consumes it.
   */
  impulse(x: number, y: number, z: number, strength: number): void;
  /** restore the true pose. Call BEFORE followCam.update — see header. */
  restore(camera: Object3D): void;
  /** consume pending impulses and decay. Call AFTER followCam.update. */
  update(frameDt: number, camera: Object3D): void;
  /** offset the lens, remembering the pose it came from */
  apply(camera: Object3D): void;
  /** current 0..1 shake level, for tests and the debug readout */
  level(): number;
  dispose(): void;
}

export function createCameraShake(p: CombatShakeParams = combatShakeParams): CameraShake {
  const pending: Pending[] = [];
  /** 0..1 envelope, summed from every source and clamped */
  let energy = 0;
  /** per-axis accumulated phases (§V.55), each wrapped to [0, 2π) */
  const phase = [0, 0, 0];
  /** the detuned harmonic's OWN accumulators — see header */
  const phase2 = [0, 0, 0];

  const trueQuat = new Quaternion();
  let applied = false;

  const offsetEuler = new Euler();
  const offsetQuat = new Quaternion();
  const camPos = new Vector3();

  return {
    impulse(x, y, z, strength): void {
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
      const s = Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 0;
      if (s <= 0) return;
      // bounded queue: a pathological frame must not grow this without limit
      if (pending.length >= 64) return;
      pending.push({ x, y, z, strength: s });
    },

    restore(camera): void {
      if (!applied) return;
      camera.quaternion.copy(trueQuat);
      applied = false;
    },

    update(frameDt, camera): void {
      const dt = Number.isFinite(frameDt) ? Math.max(0, Math.min(frameDt, 0.25)) : 0;

      // --- consume impulses, scaled by distance to THIS frame's camera ----
      camera.getWorldPosition(camPos);
      const ref = Math.max(1e-3, nn(p.refDistance, 25));
      const max = Math.max(ref, nn(p.maxDistance, 400));
      for (const e of pending) {
        const d = Math.hypot(e.x - camPos.x, e.y - camPos.y, e.z - camPos.z);
        // HARD zero past maxDistance, not an asymptote: a distant hit must
        // contribute NOTHING rather than a permanent low hum, which is what
        // an inverse-square tail alone would leave under sustained fire
        if (!(d < max)) continue;
        const r = d / ref;
        const falloff = 1 / (1 + r * r);
        // taper the last 25% of the range to zero so a ship sailing past the
        // cutoff does not step the shake off
        const edge = Math.min(1, ((max - d) / (max * 0.25)));
        energy += e.strength * falloff * edge * Math.max(0, nn(p.gain, 1));
      }
      pending.length = 0;

      // §V.44: summed, THEN clamped — one broadside is many impulses
      energy = Math.min(Math.max(0, nn(p.maxLevel, 1)), energy);

      // exponential decay on an accumulated clock
      const tau = Math.max(1e-3, nn(p.decay, 0.32));
      energy *= Math.exp(-dt / tau);
      if (energy < 1e-4) energy = 0;

      // --- advance the phases (§V.55: integrate, never time x rate) -------
      const base = Math.max(0, nn(p.frequency, 11));
      // three mutually irrational-ish ratios so the axes never re-align into
      // a circle, which reads as a pendulum rather than a shock
      const ratios = [1, 1.37, 0.83];
      for (let i = 0; i < 3; i++) {
        phase[i] = wrap(phase[i] + TAU * base * ratios[i] * dt);
        // the harmonic gets its OWN accumulator: multiplying a wrapped phase
        // by 2.3 breaks continuity at every wrap (§V.55)
        phase2[i] = wrap(phase2[i] + TAU * base * ratios[i] * 2.3 * dt);
      }
    },

    apply(camera): void {
      if (energy <= 0) {
        applied = false;
        return;
      }
      trueQuat.copy(camera.quaternion);

      // amplitude is quadratic in energy: a near miss should be felt and a
      // direct broadside should be violent, and a linear ramp makes the
      // whole range feel the same
      const a = energy * energy;
      const yawAmp = Math.max(0, nn(p.yawAmplitude, 0.012));
      const pitchAmp = Math.max(0, nn(p.pitchAmplitude, 0.014));
      const rollAmp = Math.max(0, nn(p.rollAmplitude, 0.02));

      offsetEuler.set(
        a * pitchAmp * osc(phase[0], phase2[0]),
        a * yawAmp * osc(phase[1], phase2[1]),
        a * rollAmp * osc(phase[2], phase2[2]),
        'XYZ',
      );
      offsetQuat.setFromEuler(offsetEuler);
      // POST-multiply: the offset is in the lens's own frame, so it is a
      // wobble of the camera rather than a rotation about the world axes
      camera.quaternion.multiply(offsetQuat);
      applied = true;
    },

    level(): number {
      return energy;
    },

    dispose(): void {
      pending.length = 0;
      energy = 0;
    },
  };
}

/**
 * Two detuned sinusoids, normalized so the sum stays within ±1 — the
 * amplitude bound is meant to MEAN something (§V.44), and a bare sum of two
 * unit sines reaches 2.
 */
function osc(a: number, b: number): number {
  return (Math.sin(a) * 0.68 + Math.sin(b) * 0.32);
}

/** keep the accumulator in [0, 2π): float precision over a long session */
function wrap(x: number): number {
  if (!Number.isFinite(x)) return 0;
  const m = x % TAU;
  return m < 0 ? m + TAU : m;
}

function nn(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}
