/**
 * DOM input wiring for the camera (§I input map). Split out of followCam.ts
 * so the camera class stays about camera math; this file owns the bindings
 * and nothing else.
 *
 * Claimed keys: C toggles the free/detached camera. While free, W/A/S/D
 * fly, R/F rise/descend, Shift/Ctrl scale speed, wheel sets travel speed.
 *
 * The fly keys are bound in the CAPTURE phase on window so they are
 * swallowed before the sailing input collector's bubble-phase listener
 * sees them — otherwise flying the camera would also work the rudder and
 * sail trim. keyup is deliberately never swallowed: a key held across a
 * mode switch must still release on the sim side, or it sticks held.
 */
import { FreeCam } from './freeCam';
import { CONTROL_CODES } from '../input/controlMap';

/** C = toggle free camera (§I; W/A/S/D/R/F fly while free) */
export const TOGGLE_FREE_CODE = CONTROL_CODES.toggleFreeCamera;
/** H = snap to the captain's eye at the helm, and back out again */
export const TOGGLE_HELM_CODE = CONTROL_CODES.toggleHelm;

export interface CamInputHost {
  /** true while the detached fly camera owns the lens */
  isFree(): boolean;
  toggleFree(): void;
  /** helm POV ↔ chase — one key, both directions */
  toggleHelm(): void;
  setDragging(dragging: boolean): void;
  /** pointer drag delta — free-look when free, orbit otherwise */
  drag(dx: number, dy: number): void;
  /** wheel delta — travel speed when free, orbit radius otherwise */
  wheel(deltaY: number): void;
  flyKey(code: string, down: boolean): void;
  /** window blur — drop held keys so nothing sticks */
  blur(): void;
}

/** true if the key event came from a field the user is typing in */
function inTextField(e: KeyboardEvent): boolean {
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null;
  return Boolean(t?.isContentEditable) || /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName ?? '');
}

/** Attach every camera binding. Returns a detach function. */
export function attachCamInput(domElement: HTMLElement, host: CamInputHost): () => void {
  const onPointerDown = (e: PointerEvent): void => {
    host.setDragging(true);
    domElement.setPointerCapture?.(e.pointerId);
  };
  const onPointerUp = (): void => host.setDragging(false);
  const onPointerMove = (e: PointerEvent): void => host.drag(e.movementX, e.movementY);
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    host.wheel(e.deltaY);
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    // never steal keys from a browser shortcut or a focused field — the
    // Tweakpane panel (Tab) is full of numeric inputs and C is a
    // perfectly good character to type into one
    if (e.metaKey || e.altKey || inTextField(e)) return;
    if (e.code === TOGGLE_FREE_CODE && !e.repeat) {
      host.toggleFree();
      return;
    }
    if (e.code === TOGGLE_HELM_CODE && !e.repeat) {
      host.toggleHelm();
      return;
    }
    if (!host.isFree()) return;
    host.flyKey(e.code, true);
    if (FreeCam.consumes(e.code)) e.stopPropagation();
  };
  const onKeyUp = (e: KeyboardEvent): void => host.flyKey(e.code, false);
  const onBlur = (): void => host.blur();

  const bindings: [EventTarget, string, EventListener, AddEventListenerOptions?][] = [
    [domElement, 'pointerdown', onPointerDown as EventListener],
    [domElement, 'pointerup', onPointerUp as EventListener],
    [domElement, 'pointermove', onPointerMove as EventListener],
    [domElement, 'wheel', onWheel as EventListener, { passive: false }],
    [window, 'keydown', onKeyDown as EventListener, { capture: true }],
    [window, 'keyup', onKeyUp as EventListener, { capture: true }],
    [window, 'blur', onBlur as EventListener],
  ];
  for (const [t, type, fn, opts] of bindings) t.addEventListener(type, fn, opts);
  return () => {
    for (const [t, type, fn, opts] of bindings) t.removeEventListener(type, fn, opts);
  };
}
