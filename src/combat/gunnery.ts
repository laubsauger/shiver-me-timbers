/**
 * PLAYER GUNNERY — the aim control and the thing on screen that answers it.
 *
 * §T.16's "aim" half. Firing existed (Space, and the battery the camera bears
 * on); LAYING the guns did not, so the player had no lever on the one variable
 * naval gunnery is actually about. The hull fixes the bearing — you point the
 * SHIP at the target — and elevation alone decides where the shot falls.
 *
 * WHAT THE PLAYER GETS
 *   hold right mouse   raise/lower the guns with the mouse (a handspike, not a
 *                      flick-stick: the whole clamp is a ~290 px sweep)
 *   Up / Down arrow    fine lay, same limits, no mouse needed
 *   Space              unchanged — fires the battery the camera bears on
 * The crosshair sits ON THE SEA at the point the shot falls, so the lesson the
 * player learns is the true one: the same lay reaches a different distance as
 * she heels, and the splash is the proof. Sea of Thieves' crosshair answers the
 * same question ("where does this land"), and like SoT this draws no trajectory
 * arc — the arc is the thing the player is supposed to internalise.
 *
 * WHY THE RETICLE CANNOT LIE. The fall point comes from `aim.predictImpact`,
 * which runs `ballistics.shotRange` — the sim's OWN integrator, drag included,
 * at the sim step. Reticle and ball are one expression, so a tuning pass on
 * muzzleVelocity or drag moves both or neither.
 *
 * LIVE, NOT CAPTURED (§V.62). The lay is re-projected every frame against the
 * hull's CURRENT quaternion and the LIVE sea height under the fall point. Her
 * heel is part of the answer — that is why the crosshair breathes with the
 * roll instead of sitting still while the guns swing under it.
 *
 * PLACEMENT NOTE: this DOM overlay would ordinarily live in `src/ui/`. It is
 * here because `src/ui/` was under another agent's edit when it was written and
 * the coordinator sequenced me out of that directory; it is self-contained
 * (its own injected stylesheet, its own root element) so moving it later is a
 * file move and an import.
 */
import { Vector3, type Camera } from 'three/webgpu';
import type { ShipState } from '../state/simState';
import type { PieceDef } from '../ship/pieceTypes';
import { combatParams, type CombatParams } from '../params/combat';
import { CONTROL_CODES } from '../input/controlMap';
import { createAim, muzzleLay, predictImpact, type Aim } from './aim';
import { buildBattery, batterySide, sideForBearing } from './battery';
import { yawOfShip } from './combatSystem';

/** the right mouse button, per the DOM's own numbering */
const AIM_BUTTON = 2;

export interface GunneryView {
  /** the lens THIS frame — call after the camera is final, or it lags a frame */
  camera: Camera;
  /** the player's hull, read live (heel and pitch are part of the answer) */
  ship: ShipState;
  /** world bearing the lens looks along — the SAME one the fire order carries */
  aimBearing: number;
  /** the live sea (§V.8 CPU mirror), not a flat plane */
  seaHeight: (x: number, z: number) => number;
  /** false in photo mode / while paused: the overlay goes away, the lay stays */
  visible: boolean;
}

export interface Gunnery {
  /** rad above horizontal — put this straight on the player's FireOrder */
  elevation(): number;
  /** the aim itself, for tests and the dev console */
  aim: Aim;
  /** true while the aim button is held */
  isAiming(): boolean;
  update(view: GunneryView, dt: number): void;
  dispose(): void;
}

export interface GunneryConfig {
  /** the player's blueprint — gun stations come off it (§V.13), not from code */
  blueprint: readonly PieceDef[];
  /** the canvas: pointer bindings land here, keys on window */
  domElement: HTMLElement;
  /** where the overlay is appended; defaults to document.body */
  root?: HTMLElement;
  params?: CombatParams;
}

const STYLE_ID = 'smt-gunnery-styles';

/** injected once; scoped to smt-gun-* so it cannot reach the rest of the UI */
function ensureStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.smt-gun {
  position: fixed; left: 0; top: 0; width: 0; height: 0;
  pointer-events: none; z-index: 5; opacity: 0; transition: opacity 120ms ease-out;
  color: #f2e2c0; text-shadow: 0 1px 3px rgba(0,0,0,0.85);
}
.smt-gun.is-on { opacity: 0.88; }
.smt-gun.is-aiming { opacity: 1; }
.smt-gun-mark { position: absolute; width: 54px; height: 54px; margin: -27px 0 0 -27px; }
.smt-gun-mark svg { width: 100%; height: 100%; display: block; }
.smt-gun-read {
  position: absolute; top: 32px; left: 50%; transform: translateX(-50%);
  font: 600 12px/1.35 ui-serif, Georgia, serif; letter-spacing: 0.16em;
  text-transform: uppercase; white-space: nowrap; text-align: center;
}
.smt-gun-read b { display: block; font-weight: 700; letter-spacing: 0.2em; }
.smt-gun-read span { display: block; opacity: 0.72; font-size: 10px; }
`;
  doc.head.appendChild(style);
}

/**
 * Drawn TWICE: a dark backing stroke, then the brass one over it. A single
 * light stroke is invisible against sunlit water — measured on the real frame,
 * where the first version could not be found by eye at all and had to be
 * located by its bounding box. A crosshair the player cannot see is the same
 * defect as no crosshair (§V.43: it has to read like an authored HUD).
 */
const MARK_SVG = `
<svg viewBox="0 0 54 54" fill="none">
  <g stroke="rgba(12,10,8,0.75)" stroke-width="4.4" stroke-linecap="round">
    <circle cx="27" cy="27" r="14"/>
    <path d="M27 4.5v8.5M27 41v8.5M4.5 27h8.5M41 27h8.5"/>
  </g>
  <g stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
    <circle cx="27" cy="27" r="14" opacity="0.75"/>
    <path d="M27 4.5v8.5M27 41v8.5M4.5 27h8.5M41 27h8.5"/>
  </g>
  <circle cx="27" cy="27" r="2.6" fill="rgba(12,10,8,0.75)"/>
  <circle cx="27" cy="27" r="1.5" fill="currentColor"/>
</svg>`;

/**
 * The gun the crosshair speaks for: the MIDDLE gun of the battery that bears.
 * Not the first — a broadside's ends differ by a couple of metres of station
 * and the middle is the honest average of the volley the key actually fires.
 */
function middleMount(offsets: readonly number[][]): number[] | undefined {
  return offsets.length === 0 ? undefined : offsets[Math.floor((offsets.length - 1) / 2)];
}

export function createGunnery(config: GunneryConfig): Gunnery {
  const params = config.params ?? combatParams;
  const aim = createAim(params);
  // §V.13: gun stations are read off the blueprint, so a hull with different
  // sockets aims correctly with no change here. Static geometry — guns do not
  // move on the deck, which is why reading it once is safe (unlike the POSE,
  // which is read every frame below).
  const battery = buildBattery(config.blueprint as PieceDef[]);
  const mounts = {
    port: middleMount(batterySide(battery, 'port').map((g) => g.position)),
    starboard: middleMount(batterySide(battery, 'starboard').map((g) => g.position)),
  };

  const doc = config.domElement.ownerDocument ?? document;
  ensureStyles(doc);
  const root = doc.createElement('div');
  root.className = 'smt-gun';
  const mark = doc.createElement('div');
  mark.className = 'smt-gun-mark';
  mark.innerHTML = MARK_SVG;
  const read = doc.createElement('div');
  read.className = 'smt-gun-read';
  const rangeText = doc.createElement('b');
  const elevText = doc.createElement('span');
  read.append(rangeText, elevText);
  mark.appendChild(read);
  root.appendChild(mark);
  (config.root ?? doc.body).appendChild(root);

  let aiming = false;
  let pointerId: number | null = null;
  const held = new Set<string>();
  const projected = new Vector3();

  /**
   * ORDER MATTERS, and it is not defensive dressing: `releasePointerCapture`
   * throws NotFoundError on a pointer the element never captured (a pointer
   * lost to a mode switch, a devtools-synthesised event, a capture the browser
   * dropped). Clearing the flag AFTER the call meant one throw left the player
   * holding the guns for the rest of the session — the aim button dead, and
   * nothing in the console to say why. Caught in the browser check.
   */
  const stopAiming = (): void => {
    const captured = pointerId;
    aiming = false;
    pointerId = null;
    if (captured === null) return;
    try {
      config.domElement.releasePointerCapture?.(captured);
    } catch {
      /* never captured, or already released — the flag above is the truth */
    }
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== AIM_BUTTON) return;
    // the camera's own drag listener runs on the same element and would orbit
    // the lens while the guns move; camInput ignores the secondary button for
    // exactly this reason, and this stops the context menu that would
    // otherwise eat the very first aim
    e.preventDefault();
    aiming = true;
    pointerId = e.pointerId;
    try {
      config.domElement.setPointerCapture?.(e.pointerId);
    } catch {
      /* capture is a nicety — the aim works without it, so never let a throw
         here abort the handler and leave the state half-set */
    }
  };
  const onPointerMove = (e: PointerEvent): void => {
    if (!aiming) return;
    // screen-down is +movementY and depressing the guns is what that should
    // mean, hence the negation. Read from `params` on every event, never
    // captured at construction (§V.62) — the debug slider is live.
    aim.adjust(-e.movementY * params.aimMouseSpeed);
  };
  const onPointerUp = (e: PointerEvent): void => {
    if (e.button === AIM_BUTTON || pointerId === e.pointerId) stopAiming();
  };
  const onContextMenu = (e: Event): void => e.preventDefault();
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.metaKey || e.altKey || e.ctrlKey) return;
    const t = e.target as { tagName?: string; isContentEditable?: boolean } | null;
    if (t?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName ?? '')) return;
    if (e.code !== CONTROL_CODES.elevateGuns && e.code !== CONTROL_CODES.depressGuns) return;
    held.add(e.code);
    // arrows scroll the page otherwise, which under a full-bleed canvas reads
    // as the whole game jumping
    e.preventDefault();
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    held.delete(e.code);
  };
  const onBlur = (): void => {
    held.clear();
    stopAiming();
  };

  config.domElement.addEventListener('pointerdown', onPointerDown as EventListener);
  config.domElement.addEventListener('pointermove', onPointerMove as EventListener);
  config.domElement.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('pointerup', onPointerUp as EventListener);
  window.addEventListener('pointercancel', onPointerUp as EventListener);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  const hide = (): void => {
    root.classList.remove('is-on', 'is-aiming');
  };

  return {
    aim,
    elevation: () => aim.elevation(),
    isAiming: () => aiming,

    update(view, dt): void {
      // held-key lay is integrated on the frame clock rather than driven by
      // the OS key-repeat, so it starts instantly and moves at one rate
      const step = Number.isFinite(dt) ? Math.max(0, Math.min(dt, 0.25)) : 0;
      const dir =
        (held.has(CONTROL_CODES.elevateGuns) ? 1 : 0) -
        (held.has(CONTROL_CODES.depressGuns) ? 1 : 0);
      if (dir !== 0) aim.adjust(dir * params.aimKeyRate * step);

      if (!view.visible) {
        hide();
        return;
      }
      const side = sideForBearing(yawOfShip(view.ship), view.aimBearing);
      const mount = mounts[side];
      if (mount === undefined) {
        hide();
        return;
      }
      const lay = muzzleLay(
        view.ship.position,
        view.ship.quaternion,
        [mount[0], mount[1], mount[2]],
        side,
        aim.elevation(),
        params,
      );
      // sea under the MUZZLE first, because that is the height the shot falls
      // from; the fall point's own sea height then re-seats the crosshair on
      // the wave it actually lands on
      const shot = predictImpact(lay, view.seaHeight(lay.position[0], lay.position[2]), params);
      if (shot === null) {
        hide();
        return;
      }
      projected.set(
        shot.point[0],
        view.seaHeight(shot.point[0], shot.point[2]),
        shot.point[2],
      );
      projected.project(view.camera);
      // z ≥ 1 is behind the lens: projecting that draws a mirrored crosshair
      // on the opposite side of the screen, which is worse than nothing
      if (!Number.isFinite(projected.x) || projected.z >= 1) {
        hide();
        return;
      }
      const w = window.innerWidth;
      const h = window.innerHeight;
      mark.style.transform = `translate(${((projected.x + 1) / 2) * w}px, ${((1 - projected.y) / 2) * h}px)`;
      rangeText.textContent = `${Math.round(shot.range)} m`;
      elevText.textContent = `${(aim.elevation() * 180 / Math.PI).toFixed(1)}°`;
      root.classList.add('is-on');
      root.classList.toggle('is-aiming', aiming);
    },

    dispose(): void {
      config.domElement.removeEventListener('pointerdown', onPointerDown as EventListener);
      config.domElement.removeEventListener('pointermove', onPointerMove as EventListener);
      config.domElement.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('pointerup', onPointerUp as EventListener);
      window.removeEventListener('pointercancel', onPointerUp as EventListener);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      root.remove();
    },
  };
}
