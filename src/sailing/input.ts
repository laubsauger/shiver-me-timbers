/**
 * Keyboard input collector for sailing (T9, §I input map).
 * Render-side module (owns DOM listeners) but its OUTPUT is a plain
 * JSON-serializable InputState snapshot per sim tick — §V.3: the input log
 * is plain data so future replay/netcode can feed identical snapshots into
 * the sim with no DOM involved. Sim code imports only the InputState type.
 *
 * Mapping: A/D rudder (analog ramp while held, springs back to 0),
 * W/E trim sail up, Q/S trim sail down, S also brakes, Space fires (§I).
 */
import { sailingParams } from '../params/sailing';

export interface InputState {
  /** -1 (full port, A) .. 1 (full starboard, D) */
  rudder: number;
  /** -1 | 0 | 1 — sail trim intent this tick; sim integrates via trimSpeed */
  sailTrimDelta: number;
  /** S held: kill forward way */
  brake: boolean;
  /** Space held (§I: fire cannon; consumed by combat, not sailing) */
  fire: boolean;
}

export function neutralInput(): InputState {
  return { rudder: 0, sailTrimDelta: 0, brake: false, fire: false };
}

/**
 * Pure key-state core — no DOM. Tests and replay tooling drive keyDown/
 * keyUp directly; sample(dt) advances the rudder ramp deterministically
 * for a fixed dt (§V.2) and returns a fresh plain snapshot.
 */
export class KeyboardInput {
  private held = new Set<string>();
  private rudderValue = 0;

  keyDown(code: string): void {
    this.held.add(code);
  }

  keyUp(code: string): void {
    this.held.delete(code);
  }

  clear(): void {
    this.held.clear();
  }

  sample(dt: number): InputState {
    const p = sailingParams;
    const dir = (this.held.has('KeyD') ? 1 : 0) - (this.held.has('KeyA') ? 1 : 0);
    if (dir !== 0) {
      // ramp toward the held direction
      const next = this.rudderValue + dir * p.rudderRampRate * dt;
      this.rudderValue = Math.max(-1, Math.min(1, next));
    } else if (this.rudderValue !== 0) {
      // spring back to center without crossing zero
      const step = p.rudderSpringRate * dt;
      this.rudderValue =
        Math.abs(this.rudderValue) <= step
          ? 0
          : this.rudderValue - Math.sign(this.rudderValue) * step;
    }
    const up = this.held.has('KeyW') || this.held.has('KeyE') ? 1 : 0;
    const down = this.held.has('KeyS') || this.held.has('KeyQ') ? 1 : 0;
    return {
      rudder: this.rudderValue,
      sailTrimDelta: up - down,
      brake: this.held.has('KeyS'),
      fire: this.held.has('Space'),
    };
  }
}

/** Wire a KeyboardInput to DOM events. Returns a detach function. */
export function attachKeyboard(input: KeyboardInput, target: EventTarget): () => void {
  const onDown = (e: Event): void => {
    const ke = e as KeyboardEvent;
    if (!ke.repeat) input.keyDown(ke.code);
  };
  const onUp = (e: Event): void => input.keyUp((e as KeyboardEvent).code);
  const onBlur = (): void => input.clear(); // avoid stuck keys on focus loss
  target.addEventListener('keydown', onDown);
  target.addEventListener('keyup', onUp);
  target.addEventListener('blur', onBlur);
  return () => {
    target.removeEventListener('keydown', onDown);
    target.removeEventListener('keyup', onUp);
    target.removeEventListener('blur', onBlur);
  };
}

export interface InputCollector {
  /** call once per sim tick with the fixed dt; returns a plain snapshot */
  sample(dt: number): InputState;
  dispose(): void;
}

export function createInputCollector(target: EventTarget = window): InputCollector {
  const input = new KeyboardInput();
  const detach = attachKeyboard(input, target);
  return {
    sample: (dt) => input.sample(dt),
    dispose: detach,
  };
}
