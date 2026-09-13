/**
 * REBINDABLE SPEEDBOAT MAP (design doc §3). Keyboard by `KeyboardEvent.code` (layout-independent, like
 * src/input/controlMap.ts), gamepad by the W3C "standard" mapping indices (Xbox names in comments).
 *
 * Rebinding a key REMOVES it from every other action (one key, one meaning); the caller shows what it displaced via
 * the returned `displaced` list rather than finding out in a race.
 */
import type { ControlGroup } from '../../input/controlMap';

export type BoatAction =
  | 'throttle'
  | 'astern'
  | 'steerLeft'
  | 'steerRight'
  | 'trimBowDown'
  | 'trimBowUp'
  | 'surge'
  | 'lookBack'
  | 'camera'
  | 'reset'
  | 'pause';

export const BOAT_ACTIONS: readonly BoatAction[] = [
  'throttle',
  'astern',
  'steerLeft',
  'steerRight',
  'trimBowDown',
  'trimBowUp',
  'surge',
  'lookBack',
  'camera',
  'reset',
  'pause',
];

/** standard-mapping axes / buttons */
export interface PadBindings {
  steerAxis: number;
  trimAxis: number;
  /** analog trigger buttons (value 0…1) */
  throttleButton: number;
  asternButton: number;
  surgeButton: number;
  lookBackButton: number;
  cameraButton: number;
  resetButton: number;
  pauseButton: number;
}

export interface BoatBindings {
  keys: Record<BoatAction, readonly string[]>;
  pad: PadBindings;
}

export const DEFAULT_BOAT_BINDINGS: Readonly<BoatBindings> = Object.freeze({
  keys: Object.freeze({
    throttle: ['KeyW'],
    astern: ['KeyS'],
    steerLeft: ['KeyA'],
    steerRight: ['KeyD'],
    // design §3: ↑ bow down, ↓ bow up (flight-stick sense)
    trimBowDown: ['ArrowUp'],
    trimBowUp: ['ArrowDown'],
    surge: ['ShiftLeft', 'ShiftRight'],
    lookBack: ['KeyC'],
    camera: ['KeyV'],
    reset: ['KeyR'],
    pause: ['Escape'],
  }),
  pad: Object.freeze({
    steerAxis: 0, // left stick ↔
    trimAxis: 3, // right stick ↕
    throttleButton: 7, // RT
    asternButton: 6, // LT
    surgeButton: 0, // A
    lookBackButton: 11, // right stick click
    cameraButton: 3, // Y
    resetButton: 8, // View
    pauseButton: 9, // Menu
  }),
}) as Readonly<BoatBindings>;

export function cloneBindings(b: Readonly<BoatBindings>): BoatBindings {
  const keys = {} as Record<BoatAction, readonly string[]>;
  for (const a of BOAT_ACTIONS) keys[a] = [...b.keys[a]];
  return { keys, pad: { ...b.pad } };
}

/**
 * Bind `code` to `action` (added to its keys; `replace` drops the action's other keys first). Returns the new map and
 * the actions that lost the key.
 */
export function rebindKey(
  b: Readonly<BoatBindings>,
  action: BoatAction,
  code: string,
  replace = false,
): { bindings: BoatBindings; displaced: BoatAction[] } {
  const next = cloneBindings(b);
  const displaced: BoatAction[] = [];
  for (const a of BOAT_ACTIONS) {
    if (a === action) continue;
    if (next.keys[a].includes(code)) {
      next.keys[a] = next.keys[a].filter((k) => k !== code);
      displaced.push(a);
    }
  }
  const own = replace ? [] : next.keys[action].filter((k) => k !== code);
  next.keys[action] = [...own, code];
  return { bindings: next, displaced };
}

/** the key → action lookup the device layer uses (built once per bindings change) */
export function keyLookup(b: Readonly<BoatBindings>): Map<string, BoatAction> {
  const m = new Map<string, BoatAction>();
  for (const a of BOAT_ACTIONS) for (const k of b.keys[a]) m.set(k, a);
  return m;
}

/** settings-page reference for the defaults (same shape as src/input/controlMap.ts CONTROL_GROUPS) */
export const SPEEDBOAT_CONTROL_GROUPS: readonly ControlGroup[] = [
  {
    title: 'Speedboat',
    bindings: [
      { keys: ['W', 'RT'], action: 'Throttle' },
      { keys: ['S', 'LT'], action: 'Throttle off / reverse', hint: 'Reverse only below 3 m/s, after holding 0.3 s' },
      { keys: ['A', 'D', 'Left stick'], action: 'Steer', hint: 'The drives lock less the faster you go (assist)' },
      { keys: ['↑', '↓', 'Right stick'], action: 'Trim', hint: '↑ bow down, ↓ bow up; stays where you leave it; invertible' },
      { keys: ['Shift', 'A'], action: 'Surge' },
      { keys: ['C', 'Right stick click'], action: 'Look back', hint: 'Cockpit: the hoop mirror' },
      { keys: ['V', 'Y'], action: 'Camera', hint: 'Chase → near chase → cockpit' },
      { keys: ['R', 'View'], action: 'Reset', hint: 'Hold 1 s' },
      { keys: ['Esc', 'Menu'], action: 'Pause' },
    ],
  },
];
