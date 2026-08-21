/**
 * Pointer lock for the first-person view (§T.94). `camInput.ts` has none —
 * it orbits on drag. This file owns the lock: click the canvas to take it,
 * Esc (the browser's own exit) gives it back.
 *
 * The MATH is separate from the DOM so it is testable: `applyLook` turns a
 * pixel delta into yaw/pitch deltas with the sensitivity read live from
 * `playerParams` (§V62), and the pitch clamp lives in `stepPlayer`, where the
 * state is. Mouse RIGHT is yaw NEGATIVE (yaw + turns left, see playerStep
 * header); mouse DOWN is pitch negative.
 */
import { playerParams } from '../params/player';

export interface LookDelta {
  yawDelta: number;
  pitchDelta: number;
}

/** pixel movement → radians, NaN-safe (a lost pointer event reports NaN) */
export function lookFromMouse(
  movementX: number,
  movementY: number,
  sensitivity: number = playerParams.lookSensitivity,
): LookDelta {
  const dx = Number.isFinite(movementX) ? movementX : 0;
  const dy = Number.isFinite(movementY) ? movementY : 0;
  const s = Number.isFinite(sensitivity) ? sensitivity : 0;
  // `+ 0` folds -0 to +0 so an idle tick hashes the same whichever way it came
  return { yawDelta: -dx * s + 0, pitchDelta: -dy * s + 0 };
}

/**
 * Accumulates mouse movement between sim ticks and hands it over as one
 * delta per tick, so the input snapshot is the whole truth of that tick
 * (§V3) and look speed does not depend on event rate.
 */
export class LookAccumulator {
  private yaw = 0;
  private pitch = 0;

  move(movementX: number, movementY: number): void {
    const d = lookFromMouse(movementX, movementY);
    this.yaw += d.yawDelta;
    this.pitch += d.pitchDelta;
  }

  /** drain: returns this tick's delta and resets */
  take(): LookDelta {
    const d = { yawDelta: this.yaw, pitchDelta: this.pitch };
    this.yaw = 0;
    this.pitch = 0;
    return d;
  }
}

/** the subset of the DOM this file touches — typed so a test can fake it */
export interface LockElement extends EventTarget {
  requestPointerLock?: () => unknown;
  ownerDocument?: {
    pointerLockElement?: Element | null;
    exitPointerLock?: () => void;
    addEventListener(type: string, fn: EventListener): void;
    removeEventListener(type: string, fn: EventListener): void;
  };
}

export interface PointerLockHost {
  /** only take the lock while the first-person view owns the lens */
  isActive(): boolean;
  look: LookAccumulator;
}

/** Wire pointer lock to `el`. Returns a detach function that also releases the lock. */
export function attachPointerLock(el: LockElement, host: PointerLockHost): () => void {
  const doc = el.ownerDocument;
  const locked = (): boolean => doc?.pointerLockElement === (el as unknown as Element);
  const onClick = (): void => {
    if (host.isActive() && !locked()) el.requestPointerLock?.();
  };
  const onMove = (e: Event): void => {
    if (!locked() || !host.isActive()) return;
    const m = e as MouseEvent;
    host.look.move(m.movementX, m.movementY);
  };
  el.addEventListener('click', onClick);
  doc?.addEventListener('mousemove', onMove);
  return () => {
    el.removeEventListener('click', onClick);
    doc?.removeEventListener('mousemove', onMove);
    if (locked()) doc?.exitPointerLock?.();
  };
}
