/**
 * DOM input wiring for the camera (§I input map). Split out of followCam.ts
 * so the camera class stays about camera math; this file owns the bindings
 * and nothing else.
 *
 * Claimed keys: C toggles the free/detached camera. While free, W/A/S/D
 * fly, R/F rise/descend, Shift/Ctrl scale speed, wheel sets travel speed.
 * 1..4 jump to the numbered shipboard stations (camStations.ts).
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
/**
 * The number row, in station order (Digit1 → the gun, and so on).
 *
 * 1/2/3 ARE SHARED WITH THE CASCADE SPECTRUM VIEW (`src/ui/cascadeViewChannel`),
 * which reads them through `ui/viewModes` and acts on them only while that
 * instrument is OPEN — a full-screen debug view of one wave band's raw data,
 * with no game camera on screen at all. The camera therefore never
 * `stopPropagation`s a digit: swallowing them would take the band selector
 * away from the view, and swallowing is what the view's own §V.62 note
 * forbids in the other direction. The two owners can both act on one press,
 * and the only visible consequence is that closing the view leaves the lens at
 * a station. Documented in `input/controlMap.ts` on both sides.
 */
export const STATION_CODES: readonly string[] = [
  CONTROL_CODES.cameraStationGun,
  CONTROL_CODES.cameraStationBow,
  CONTROL_CODES.cameraStationStern,
  CONTROL_CODES.cameraStationNest,
];
/** the DOM's number for the right mouse button — gunnery's, not the camera's */
const AIM_BUTTON = 2;

export interface CamInputHost {
  /** true while the detached fly camera owns the lens */
  isFree(): boolean;
  toggleFree(): void;
  /** helm POV ↔ chase — one key, both directions */
  toggleHelm(): void;
  /** jump to station `index` of STATION_CODES; pressing it again comes back */
  station(index: number): void;
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
  // The RIGHT button lays the guns (src/combat/gunnery.ts) and must never also
  // orbit the lens: one gesture, one owner. Without this, aiming swings the
  // camera as the guns move — the two halves of one system disagreeing, which
  // is the shape of bug this project keeps shipping.
  let aimPointer: number | null = null;
  const onPointerDown = (e: PointerEvent): void => {
    if (e.button === AIM_BUTTON) {
      aimPointer = e.pointerId;
      return;
    }
    host.setDragging(true);
    domElement.setPointerCapture?.(e.pointerId);
  };
  const onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId === aimPointer) {
      aimPointer = null;
      return;
    }
    host.setDragging(false);
  };
  const onPointerMove = (e: PointerEvent): void => {
    if (e.pointerId === aimPointer) return;
    host.drag(e.movementX, e.movementY);
  };
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
    if (!e.repeat) {
      const station = STATION_CODES.indexOf(e.code);
      if (station >= 0) {
        host.station(station);
        return; // acted, but NOT swallowed — see STATION_CODES
      }
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
