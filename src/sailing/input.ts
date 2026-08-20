/**
 * Keyboard input collector for sailing (T9, §I input map).
 * Render-side module (owns DOM listeners) but its OUTPUT is a plain
 * JSON-serializable InputState snapshot per sim tick — §V.3: the input log
 * is plain data so future replay/netcode can feed identical snapshots into
 * the sim with no DOM involved. Sim code imports only the InputState type.
 *
 * Mapping: A/D rudder (slews at helmsman speed while held, winds back to 0
 * when released; a fresh press always puts on at least one spoke, §T.77),
 * W trims the sails in, S eases them out and brakes, Q/E brace the yards
 * round (§T.76), Space fires, X drops or weighs the anchor (§I).
 */
import { sailingParams } from '../params/sailing';
import { CONTROL_CODES } from '../input/controlMap';
import { slewRudder } from './shipKinematics';

export interface InputState {
  /** -1 .. 1 rudder intent; keyboard direction is mapped at collection time */
  rudder: number;
  /** -1 | 0 | 1 — sail trim intent this tick; sim integrates via trimSpeed */
  sailTrimDelta: number;
  /**
   * -1 | 0 | 1 — which way to brace the yards this tick (§T.76). +1 turns the
   * sail's face to STARBOARD (the starboard yardarm goes aft), matching the
   * sign of `ShipState.brace`. The sim integrates it at `braceRate` and hands
   * the yards back to the automatic brace `braceHoldTime` after the last
   * non-zero value, so 0 means "leave them to the crew", not "hold them here".
   */
  braceDelta: number;
  /** S held: kill forward way */
  brake: boolean;
  /** Space held (§I: fire cannon; consumed by combat, not sailing) */
  fire: boolean;
  /**
   * EDGE, not a held key: true on the single tick the anchor key went down.
   * A toggle cannot be a level — holding X for half a second would flip the
   * anchor thirty times — and it cannot be latched in the collector either,
   * because then the snapshot would no longer be the whole truth of that
   * tick and a replay would drift (§V.3: the log IS the format). So the
   * edge is detected at collection and consumed by `sample()`.
   */
  anchorToggle: boolean;
}

export function neutralInput(): InputState {
  return {
    rudder: 0,
    sailTrimDelta: 0,
    braceDelta: 0,
    brake: false,
    fire: false,
    anchorToggle: false,
  };
}

/**
 * Pure key-state core — no DOM. Tests and replay tooling drive keyDown/
 * keyUp directly; sample(dt) advances the rudder ramp deterministically
 * for a fixed dt (§V.2) and returns a fresh plain snapshot.
 */
export class KeyboardInput {
  private held = new Set<string>();
  private rudderValue = 0;
  /** anchor key edges seen since the last sample() — see InputState.anchorToggle */
  private anchorEdges = 0;
  /** a steer key went down since the last sample() — a fresh press, not a hold */
  private steerPressed = false;

  keyDown(code: string): void {
    if (code === CONTROL_CODES.toggleAnchor && !this.held.has(code)) this.anchorEdges++;
    if (
      (code === CONTROL_CODES.steerLeft || code === CONTROL_CODES.steerRight) &&
      !this.held.has(code)
    ) {
      this.steerPressed = true;
    }
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
    // The rendered chase view reads A as left and D as right. The ship model's
    // internal yaw/rudder sign is the opposite, so map the keys here rather
    // than inverting the physics convention used by AI and replay inputs.
    const dir =
      (this.held.has(CONTROL_CODES.steerLeft) ? 1 : 0) -
      (this.held.has(CONTROL_CODES.steerRight) ? 1 : 0);
    if (dir !== 0 && this.steerPressed) {
      // §T.77: a tap is a deliberate nudge, not 1/60 s of a 3 s ramp. A fresh
      // press puts on at least `rudderTapStep` in its own direction — only if
      // the blade is not already past that, and never by jumping across
      // midships when the press opposes the current helm.
      const along = this.rudderValue * dir;
      if (along >= 0 && along < p.rudderTapStep) this.rudderValue = dir * p.rudderTapStep;
    }
    this.steerPressed = false;
    // helmsman speed toward the held direction, or back to midships when
    // released — the same slew the AI helm and the wheel run on (§V.77)
    this.rudderValue = slewRudder(this.rudderValue, dir, dt, p);
    const up = this.held.has(CONTROL_CODES.trimIn) ? 1 : 0;
    const down = this.held.has(CONTROL_CODES.trimOut) ? 1 : 0;
    // §T.76: Q and E used to be a SECOND trim pair duplicating W and S, which
    // is what the user saw as "Q and E bring the sails up and down". They now
    // brace the yards, which is a force the sim actually reads.
    const braceStbd = this.held.has(CONTROL_CODES.braceToStarboard) ? 1 : 0;
    const bracePort = this.held.has(CONTROL_CODES.braceToPort) ? 1 : 0;
    // an odd number of presses since the last tick is one net toggle; an even
    // number is none. Counting rather than flagging means a double-tap inside
    // a single tick cannot silently become one flip.
    const anchorToggle = this.anchorEdges % 2 === 1;
    this.anchorEdges = 0;
    return {
      rudder: this.rudderValue,
      sailTrimDelta: up - down,
      braceDelta: braceStbd - bracePort,
      brake: this.held.has(CONTROL_CODES.trimOut),
      fire: this.held.has(CONTROL_CODES.fire),
      anchorToggle,
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
