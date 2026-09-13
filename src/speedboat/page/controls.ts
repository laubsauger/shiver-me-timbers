/**
 * KEYBOARD STUB control source (§T.181 S0) — W/S throttle, A/D steer. §T.182 replaces it with the
 * real controls + gamepad + assists behind the same `ControlSource` seam.
 *
 * The keys only set what is HELD; the fixed tick samples them (`sample`) and slews toward the
 * target at a fixed rate per tick, so the controls a tick uses are a function of the held set and
 * the tick count — not of the frame rate or of when a keydown landed (§V2 input-snapshot shape).
 *
 * STEER SIGN (measured on the deep-V, open water, `HullWater.setControls`): a POSITIVE steer yaws
 * the bow toward world −x from a +z heading, which is the pilot's RIGHT (the chase camera sits
 * astern looking +z). So D = +steer, A = −steer.
 *
 * STUB LIMITS, stated: keyboard steer reaches half lock only (±0.5): full lock hooks the hull
 * above C_v ≈ 5 (docs/speedboat/physics-log.md envelope), and a stub is not the place to add the
 * speed-sensitive range §T.182 owns. No trim or Surge keys.
 */
import type { BoatControls, ControlSource } from './seams';

/** held-key target → value slew, per second */
const THROTTLE_RATE = 1.5;
const STEER_RATE = 1.2;
/** keyboard steer authority, fraction of full lock (see header) */
export const KEYBOARD_STEER_LIMIT = 0.5;
export const REVERSE_THROTTLE = -0.3;

const slew = (v: number, target: number, rate: number, dt: number): number => {
  const step = rate * dt;
  return v < target ? Math.min(target, v + step) : Math.max(target, v - step);
};

/** pure: the held set → targets (exported for the structural test) */
export function keyboardTargets(held: ReadonlySet<string>): { throttle: number; steer: number } {
  const fwd = held.has('KeyW') || held.has('ArrowUp');
  const back = held.has('KeyS') || held.has('ArrowDown');
  const left = held.has('KeyA') || held.has('ArrowLeft');
  const right = held.has('KeyD') || held.has('ArrowRight');
  return {
    throttle: fwd && !back ? 1 : back && !fwd ? REVERSE_THROTTLE : 0,
    steer: (right ? KEYBOARD_STEER_LIMIT : 0) - (left ? KEYBOARD_STEER_LIMIT : 0),
  };
}

export function createKeyboardControls(opts: { target?: Window; enabled?: () => boolean } = {}): ControlSource & {
  readonly held: ReadonlySet<string>;
} {
  const target = opts.target ?? window;
  const enabled = opts.enabled ?? (() => true);
  const held = new Set<string>();
  const out: BoatControls = { steer: 0, throttle: 0, trim: 0, surge: false };
  const inField = (e: KeyboardEvent): boolean => {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  };
  const down = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey || inField(e)) return;
    held.add(e.code);
  };
  const up = (e: KeyboardEvent): void => {
    held.delete(e.code);
  };
  const blur = (): void => held.clear();
  target.addEventListener('keydown', down);
  target.addEventListener('keyup', up);
  target.addEventListener('blur', blur);
  return {
    held,
    sample(dt) {
      const t = enabled() ? keyboardTargets(held) : { throttle: 0, steer: 0 };
      out.throttle = slew(out.throttle, t.throttle, THROTTLE_RATE, dt);
      out.steer = slew(out.steer, t.steer, STEER_RATE, dt);
      return out;
    },
    dispose() {
      target.removeEventListener('keydown', down);
      target.removeEventListener('keyup', up);
      target.removeEventListener('blur', blur);
    },
  };
}
