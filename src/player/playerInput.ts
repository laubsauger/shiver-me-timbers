/**
 * Keyboard collector for the first-person walker (§T.94), the sailing
 * `KeyboardInput` pattern: a pure key-state core tests drive directly, and a
 * DOM attach that owns the listeners. The output per tick is a plain
 * `PlayerInput` snapshot (§V3: the log is the format).
 *
 * KEYS (registered in `input/controlMap.ts`): W/A/S/D move, Space hops,
 * Ctrl crouches, E grabs/releases a station (§T.95), T toggles the
 * first-person view. W/A/S/D/Space are SHARED
 * with sailing and gunnery, so while the walker is active they are swallowed
 * in the CAPTURE phase exactly as freeCam swallows its fly keys — otherwise
 * walking forward would also set more canvas. keyup is never swallowed.
 */
import { CONTROL_CODES } from '../input/controlMap';
import { neutralPlayerInput, type PlayerInput } from './playerStep';
import type { LookDelta } from './pointerLock';

const MOVE_CODES: readonly string[] = [
  CONTROL_CODES.walkForward,
  CONTROL_CODES.walkBack,
  CONTROL_CODES.walkLeft,
  CONTROL_CODES.walkRight,
  CONTROL_CODES.walkJump,
  CONTROL_CODES.walkCrouch,
  CONTROL_CODES.walkCrouchRight,
  CONTROL_CODES.interact,
];

export class PlayerKeys {
  private held = new Set<string>();
  private jumpEdges = 0;
  private toggleEdges = 0;
  private interactEdges = 0;

  /** true for the keys the walker swallows while active */
  static consumes(code: string): boolean {
    return MOVE_CODES.includes(code);
  }

  keyDown(code: string): void {
    if (!this.held.has(code)) {
      if (code === CONTROL_CODES.walkJump) this.jumpEdges++;
      if (code === CONTROL_CODES.toggleFirstPerson) this.toggleEdges++;
      if (code === CONTROL_CODES.interact) this.interactEdges++;
    }
    this.held.add(code);
  }

  keyUp(code: string): void {
    this.held.delete(code);
  }

  clear(): void {
    this.held.clear();
  }

  /** one net toggle per odd number of presses since the last sample */
  takeToggle(): boolean {
    const t = this.toggleEdges % 2 === 1;
    this.toggleEdges = 0;
    return t;
  }

  /** §T.95: number of E presses since the last sample, each a grab or a release */
  takeInteract(): number {
    const n = this.interactEdges;
    this.interactEdges = 0;
    return n;
  }

  sample(look: LookDelta = { yawDelta: 0, pitchDelta: 0 }): PlayerInput {
    const has = (c: string): number => (this.held.has(c) ? 1 : 0);
    const out = neutralPlayerInput();
    out.forward = has(CONTROL_CODES.walkForward) - has(CONTROL_CODES.walkBack);
    out.strafe = has(CONTROL_CODES.walkRight) - has(CONTROL_CODES.walkLeft);
    out.jump = this.jumpEdges > 0;
    this.jumpEdges = 0;
    out.crouch = this.held.has(CONTROL_CODES.walkCrouch) || this.held.has(CONTROL_CODES.walkCrouchRight);
    out.yawDelta = look.yawDelta;
    out.pitchDelta = look.pitchDelta;
    return out;
  }
}

/** true if the key event came from a field the user is typing in */
function inTextField(e: KeyboardEvent): boolean {
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null;
  return Boolean(t?.isContentEditable) || /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName ?? '');
}

/**
 * Wire to DOM events. `isActive` gates both the swallowing and the state:
 * keys pressed while the walker is not on the lens are ignored, so nothing
 * sticks held across a mode switch. The toggle key is always heard.
 */
export function attachPlayerKeys(
  keys: PlayerKeys,
  target: EventTarget,
  isActive: () => boolean,
): () => void {
  const onDown = (e: Event): void => {
    const ke = e as KeyboardEvent;
    if (ke.metaKey || ke.altKey || inTextField(ke)) return;
    if (ke.code === CONTROL_CODES.toggleFirstPerson) {
      if (!ke.repeat) keys.keyDown(ke.code);
      return;
    }
    if (!isActive()) return;
    if (!ke.repeat) keys.keyDown(ke.code);
    if (PlayerKeys.consumes(ke.code)) {
      ke.stopPropagation();
      if (ke.code === CONTROL_CODES.walkJump) ke.preventDefault?.();
    }
  };
  const onUp = (e: Event): void => keys.keyUp((e as KeyboardEvent).code);
  const onBlur = (): void => keys.clear();
  target.addEventListener('keydown', onDown, { capture: true });
  target.addEventListener('keyup', onUp, { capture: true });
  target.addEventListener('blur', onBlur);
  return () => {
    target.removeEventListener('keydown', onDown, { capture: true });
    target.removeEventListener('keyup', onUp, { capture: true });
    target.removeEventListener('blur', onBlur);
  };
}
