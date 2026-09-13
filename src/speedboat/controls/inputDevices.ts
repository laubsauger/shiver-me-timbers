/**
 * DEVICES → BoatInput (§T.182; design doc §3). Keyboard events and the Gamepad API feed a raw snapshot; the FIXED
 * tick calls `sample(dt)`, which folds the snapshot into one BoatInput (§V2). Record that BoatInput per tick and the
 * race replays without devices: nothing downstream reads a key or a pad.
 *
 * TAPS. A key pressed and released between two ticks is not lost: presses are COUNTED on keydown and consumed by the
 * next sample (camera and pause fire once per press; Surge reads held OR tapped). Held state (throttle, steer, trim,
 * look back, reset hold) is read at the tick.
 * The gamepad is polled at the tick (the Gamepad API has no events for axes); its button edges are per tick.
 *
 * Named `BoatInputDevices` so it is not confused with the page seam's `BoatControls` (the SHAPED, post-assist
 * record). The page does not use this class directly: `raceControls.ts` wraps it + the assists as the seam's
 * `ControlSource`.
 */
import { copyBoatInput, neutralBoatInput, type BoatInput } from './boatInput';
import { cloneBindings, DEFAULT_BOAT_BINDINGS, keyLookup, type BoatAction, type BoatBindings } from './bindings';
import { deadzone, shapeAxis } from './curves';

export interface BoatControlOptions {
  /** flip the right stick's trim direction (keys are never inverted) */
  invertTrim: boolean;
  steerDeadzone: number;
  /** power curve on the steer stick; 1 = linear. 1.5 ASSUMED (fine near centre, where ±12° of lock lives at speed) */
  steerExponent: number;
  trimDeadzone: number;
  triggerDeadzone: number;
  throttleExponent: number;
  /** seconds reset must be held (design §3: 1 s) */
  resetHoldSeconds: number;
}

export const DEFAULT_BOAT_CONTROL_OPTIONS: Readonly<BoatControlOptions> = Object.freeze({
  invertTrim: false,
  steerDeadzone: 0.12,
  steerExponent: 1.5,
  trimDeadzone: 0.25,
  triggerDeadzone: 0.05,
  throttleExponent: 1,
  resetHoldSeconds: 1,
});

/** the parts of a Gamepad this reads (the DOM type satisfies it; tests pass plain objects) */
export interface PadLike {
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly pressed: boolean; readonly value: number }[];
  readonly connected?: boolean;
}

/** keyboard state between ticks */
export interface KeySnapshot {
  held: Set<BoatAction>;
  /** presses since the last sample (keydown without repeat) */
  presses: Map<BoatAction, number>;
}

export interface MapState {
  resetHeld: number;
  /** reset pulse already fired for this hold */
  resetFired: boolean;
  /** pad buttons pressed on the previous tick (edge detection) */
  padPrev: Set<number>;
}

export function createMapState(): MapState {
  return { resetHeld: 0, resetFired: false, padPrev: new Set() };
}

const clamp1 = (v: number): number => (v < -1 ? -1 : v > 1 ? 1 : v);

/**
 * PURE fold of one tick: key snapshot + pad reading → BoatInput. Consumes `keys.presses`. Keyboard and pad ADD and
 * are clamped, so a pad resting in its deadzone never masks a key.
 */
export function mapBoatInput(
  keys: KeySnapshot,
  pad: PadLike | null,
  bindings: Readonly<BoatBindings>,
  opt: Readonly<BoatControlOptions>,
  st: MapState,
  dt: number,
  out: BoatInput = neutralBoatInput(),
): BoatInput {
  const h = (a: BoatAction): number => (keys.held.has(a) ? 1 : 0);
  const pressed = (a: BoatAction): boolean => (keys.presses.get(a) ?? 0) > 0;
  const pb = bindings.pad;
  const btn = (i: number): { pressed: boolean; value: number } | undefined => (pad ? pad.buttons[i] : undefined);
  const padDown = (i: number): boolean => !!btn(i)?.pressed;
  const padEdge = (i: number): boolean => padDown(i) && !st.padPrev.has(i);

  let steer = h('steerRight') - h('steerLeft');
  let throttle = h('throttle') - h('astern');
  let trim = h('trimBowUp') - h('trimBowDown');
  if (pad) {
    steer += shapeAxis(pad.axes[pb.steerAxis] ?? 0, opt.steerDeadzone, opt.steerExponent);
    const rt = deadzone(btn(pb.throttleButton)?.value ?? 0, opt.triggerDeadzone);
    const lt = deadzone(btn(pb.asternButton)?.value ?? 0, opt.triggerDeadzone);
    throttle += Math.pow(rt, opt.throttleExponent) - Math.pow(lt, opt.throttleExponent);
    // stick DOWN is +axes[] in the standard mapping = pulled back = bow up (design §3), unless inverted
    const ts = shapeAxis(pad.axes[pb.trimAxis] ?? 0, opt.trimDeadzone, 1);
    trim += opt.invertTrim ? -ts : ts;
  }
  out.steer = clamp1(steer);
  out.throttle = clamp1(throttle);
  out.trim = clamp1(trim);
  out.surge = h('surge') > 0 || pressed('surge') || padDown(pb.surgeButton);
  out.cameraCycle = pressed('camera') || padEdge(pb.cameraButton);
  out.pause = pressed('pause') || padEdge(pb.pauseButton);
  out.lookBack = h('lookBack') > 0 || padDown(pb.lookBackButton);

  const resetDown = h('reset') > 0 || padDown(pb.resetButton);
  out.reset = false;
  if (resetDown) {
    st.resetHeld += dt;
    if (!st.resetFired && st.resetHeld >= opt.resetHoldSeconds - 1e-9) {
      out.reset = true;
      st.resetFired = true;
    }
  } else {
    st.resetHeld = 0;
    st.resetFired = false;
  }
  out.resetHold = resetDown ? Math.min(1, st.resetHeld / Math.max(1e-6, opt.resetHoldSeconds)) : 0;

  keys.presses.clear();
  st.padPrev.clear();
  if (pad) for (let i = 0; i < pad.buttons.length; i++) if (pad.buttons[i]?.pressed) st.padPrev.add(i);
  return out;
}

type GetPads = () => ArrayLike<PadLike | null> | null | undefined;

function defaultPads(): ArrayLike<PadLike | null> | null {
  const nav = (globalThis as { navigator?: { getGamepads?: () => ArrayLike<PadLike | null> } }).navigator;
  return nav && typeof nav.getGamepads === 'function' ? nav.getGamepads() : null;
}

export class BoatInputDevices {
  private bindingsV: BoatBindings;
  private optionsV: BoatControlOptions;
  private lookup: Map<string, BoatAction>;
  private readonly keys: KeySnapshot = { held: new Set(), presses: new Map() };
  private readonly heldCodes = new Map<string, BoatAction>();
  private readonly st = createMapState();
  private readonly getPads: GetPads;
  private target: EventTarget | null = null;
  /** the BoatInput of the last sample (render/HUD read it; do not mutate) */
  readonly last: BoatInput = neutralBoatInput();

  constructor(init: { bindings?: Readonly<BoatBindings>; options?: Partial<BoatControlOptions>; getGamepads?: GetPads } = {}) {
    this.bindingsV = cloneBindings(init.bindings ?? DEFAULT_BOAT_BINDINGS);
    this.optionsV = { ...DEFAULT_BOAT_CONTROL_OPTIONS, ...init.options };
    this.lookup = keyLookup(this.bindingsV);
    this.getPads = init.getGamepads ?? defaultPads;
  }

  get bindings(): Readonly<BoatBindings> {
    return this.bindingsV;
  }

  get options(): Readonly<BoatControlOptions> {
    return this.optionsV;
  }

  setBindings(b: Readonly<BoatBindings>): void {
    this.bindingsV = cloneBindings(b);
    this.lookup = keyLookup(this.bindingsV);
    this.releaseAll();
  }

  setOptions(o: Partial<BoatControlOptions>): void {
    this.optionsV = { ...this.optionsV, ...o };
  }

  attach(target: EventTarget): void {
    this.detach();
    this.target = target;
    target.addEventListener('keydown', this.onKeyDown as EventListener);
    target.addEventListener('keyup', this.onKeyUp as EventListener);
    target.addEventListener('blur', this.onBlur);
  }

  detach(): void {
    if (!this.target) return;
    this.target.removeEventListener('keydown', this.onKeyDown as EventListener);
    this.target.removeEventListener('keyup', this.onKeyUp as EventListener);
    this.target.removeEventListener('blur', this.onBlur);
    this.target = null;
    this.releaseAll();
  }

  /** FIXED TICK: fold everything since the last tick into one BoatInput */
  sample(dt: number): Readonly<BoatInput> {
    mapBoatInput(this.keys, this.firstPad(), this.bindingsV, this.optionsV, this.st, dt, this.last);
    return this.last;
  }

  /** a copy for an input log */
  snapshot(): BoatInput {
    return copyBoatInput(this.last);
  }

  private firstPad(): PadLike | null {
    const pads = this.getPads();
    if (!pads) return null;
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (p && p.connected !== false) return p;
    }
    return null;
  }

  private releaseAll(): void {
    this.keys.held.clear();
    this.heldCodes.clear();
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const a = this.lookup.get(e.code);
    if (!a) return;
    // arrows and Space would scroll the page under the game
    e.preventDefault?.();
    this.heldCodes.set(e.code, a);
    this.keys.held.add(a);
    if (!e.repeat) this.keys.presses.set(a, (this.keys.presses.get(a) ?? 0) + 1);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    const a = this.heldCodes.get(e.code);
    if (!a) return;
    this.heldCodes.delete(e.code);
    // another key bound to the same action may still be down (both Shifts)
    for (const other of this.heldCodes.values()) if (other === a) return;
    this.keys.held.delete(a);
  };

  private readonly onBlur = (): void => {
    this.releaseAll();
  };
}
