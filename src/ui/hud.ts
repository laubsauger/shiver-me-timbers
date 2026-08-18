/**
 * In-game HUD frame (§V21, subtle by design — must not fight the 3D view;
 * §V16: opacity/tape-scale/wind tunables live in params/ui.ts). Top: engraved
 * compass tick-tape under a brass lubber diamond, edge-masked so it fades into
 * the sky. Bottom: a triptych of brass plaques — apparent wind to port, knots
 * and heading amidships, canvas to starboard. Damage diamonds sit above them.
 *
 * The wind and canvas plaques answer §I ui/hud: see the wind, then answer it.
 * Both derive from the SAME functions the ship itself uses (apparentWind for
 * the flag telltales, sailStateForTrim for the actual cloth), so the readout
 * cannot drift from what the player is looking at.
 */
import { uiParams } from '../params/ui';
import { shipRigParams } from '../params/ship';
import { apparentWind, wrapAngle } from '../ship/flagDynamics';
import { sailStateForTrim, trimDropScale } from '../ship/sailDynamics';
import type { SailStateId } from '../ship/pieceTypes';
import { CARDINALS, cardinal, createWindDial, pointOfSail } from './windDial';
import { div, el } from './dom';

export interface WindReadout {
  /** direction the TRUE wind blows toward (rad) and its speed (m/s) */
  windDirection: number;
  windSpeed: number;
  /** ship world velocity (m/s) */
  shipVelX: number;
  shipVelZ: number;
  /** ship heading (rad), same convention as setHeading */
  headingRad: number;
}

export interface Hud {
  /** heading in radians, 0 = north, clockwise */
  setHeading(rad: number): void;
  setSpeed(knots: number): void;
  /** apparent wind — bearing off the bow plus strength */
  setWind(w: WindReadout): void;
  /** sail trim 0..1, the sim's own scalar */
  setTrim(trim: number): void;
  /** level 0..1; 0 clears the slot back to an empty placeholder */
  setDamage(zoneId: string, level: number): void;
  dispose(): void;
}

const RAD_TO_DEG = 180 / Math.PI;
const MS_TO_KNOTS = 1.944;
const SAIL_LABEL: Record<SailStateId, string> = {
  full: 'full sail',
  reefed: 'reefed',
  furled: 'furled',
};

/** ticks span two full turns so the wrapped tape never runs off an edge */
function buildTape(tape: HTMLElement, pxPerDeg: number): void {
  tape.textContent = '';
  for (let deg = -180; deg <= 540; deg += 5) {
    const norm = ((deg % 360) + 360) % 360;
    const major = norm % 45 === 0;
    const mid = !major && norm % 15 === 0;
    const tick = div(`smt-tick ${major ? 'is-major' : mid ? 'is-mid' : 'is-minor'}`);
    tick.style.left = `${deg * pxPerDeg}px`;
    tape.appendChild(tick);
    if (major) {
      const idx = norm / 45;
      const label = el('span', 'smt-tick-label', CARDINALS[idx]);
      if (norm % 90 === 0) label.classList.add('is-cardinal');
      label.style.left = `${deg * pxPerDeg}px`;
      tape.appendChild(label);
    }
  }
}

function plaqueCell(value: string, label: string): { root: HTMLElement; value: HTMLElement; label: HTMLElement } {
  const v = el('div', 'smt-plate-value', value);
  const l = el('div', 'smt-plate-label', label);
  return { root: div('smt-plate-cell', v, l), value: v, label: l };
}

export function createHud(root: HTMLElement): Hud {
  const tape = div('smt-compass-tape');
  const compass = div('smt-compass', tape, div('smt-lubber'));

  const speedValue = el('div', 'smt-plate-value', '0.0');
  const speedCell = div('smt-plate-cell', speedValue, el('div', 'smt-plate-label', 'knots'));
  const headingValue = el('div', 'smt-plate-value', '000°');
  const headingCell = div('smt-plate-cell', headingValue, el('div', 'smt-plate-label', 'heading'));
  const plate = div('smt-plate', speedCell, div('smt-plate-sep'), headingCell);

  const dial = createWindDial(uiParams.windNoGoDegrees);
  const windCell = plaqueCell('0.0', 'no wind');
  const windCard = div('smt-plate smt-plate-side', dial.root, windCell.root);

  const canvasCell = plaqueCell('—', 'canvas');
  const dropFill = div('smt-canvas-fill');
  const canvasCard = div(
    'smt-plate smt-plate-side is-canvas',
    canvasCell.root,
    div('smt-canvas-bar', dropFill),
  );

  const damageRow = div('smt-damage');
  const damageSlots = new Map<string, HTMLElement>();

  const bottom = div('smt-bottom', windCard, plate, canvasCard);
  const hud = div('smt-hud', compass, damageRow, bottom);
  root.appendChild(hud);

  let tapePx = uiParams.compassPixelsPerDegree;
  let hudOpacity = uiParams.hudOpacity;
  let noGo = uiParams.windNoGoDegrees;
  buildTape(tape, tapePx);
  hud.style.setProperty('--smt-hud-opacity', String(hudOpacity));

  /** re-read live tunables; rebuild/apply only when they actually changed */
  function applyParams(): void {
    if (uiParams.compassPixelsPerDegree !== tapePx) {
      tapePx = uiParams.compassPixelsPerDegree;
      buildTape(tape, tapePx);
    }
    if (uiParams.hudOpacity !== hudOpacity) {
      hudOpacity = uiParams.hudOpacity;
      hud.style.setProperty('--smt-hud-opacity', String(hudOpacity));
    }
    if (uiParams.windNoGoDegrees !== noGo) {
      noGo = uiParams.windNoGoDegrees;
      dial.setNoGo(noGo);
    }
  }

  // the vane is damped, not snapped: a raw apparent-wind bearing jitters with
  // every wave the hull yaws over, and a twitching needle is unreadable
  let vaneBearing = 0;
  let sailState: SailStateId = 'full';

  return {
    setHeading(rad: number): void {
      applyParams();
      const deg = ((rad * RAD_TO_DEG) % 360 + 360) % 360;
      tape.style.transform = `translateX(${(-deg * tapePx).toFixed(2)}px)`;
      headingValue.textContent =
        `${String(Math.round(deg) % 360).padStart(3, '0')}° ${cardinal(deg)}`;
    },
    setSpeed(knots: number): void {
      speedValue.textContent = Math.max(0, knots).toFixed(1);
    },
    setWind(w: WindReadout): void {
      const aw = apparentWind({
        windDirection: w.windDirection,
        windSpeed: w.windSpeed,
        shipVelX: w.shipVelX,
        shipVelZ: w.shipVelZ,
      });
      // aw points where the wind BLOWS TO; a sailor reads where it comes FROM
      const fromWorld = Math.atan2(-aw.x, -aw.z);
      const target = wrapAngle(fromWorld - w.headingRad);
      const k = Math.min(1, Math.max(0, uiParams.windVaneSmoothing));
      vaneBearing = wrapAngle(vaneBearing + wrapAngle(target - vaneBearing) * k);
      dial.setBearing(vaneBearing);
      const knots = aw.speed * MS_TO_KNOTS;
      dial.setStrength(Math.min(1, knots / 20));
      windCell.value.textContent = knots.toFixed(1);
      windCell.label.textContent = aw.speed < 0.2 ? 'no wind' : pointOfSail(vaneBearing, noGo);
    },
    setTrim(trim: number): void {
      // same hysteresis path the rig itself runs, so the plaque flips on the
      // exact frame the canvas does
      sailState = sailStateForTrim(trim, sailState, shipRigParams);
      const t = Math.min(1, Math.max(0, trim));
      canvasCell.value.textContent = `${Math.round(t * 100)}%`;
      canvasCell.label.textContent = SAIL_LABEL[sailState];
      const drop = trimDropScale(trim, shipRigParams);
      const min = shipRigParams.trimDropMin;
      dropFill.style.width = `${(((drop - min) / Math.max(1e-3, 1 - min)) * 100).toFixed(1)}%`;
    },
    setDamage(zoneId: string, level: number): void {
      let slot = damageSlots.get(zoneId);
      if (!slot) {
        slot = div('smt-damage-slot');
        slot.title = zoneId;
        damageSlots.set(zoneId, slot);
        damageRow.appendChild(slot);
      }
      const lvl = level <= 0 ? 0 : level < 0.34 ? 1 : level < 0.67 ? 2 : 3;
      slot.className = `smt-damage-slot${lvl > 0 ? ` is-lvl${lvl}` : ''}`;
    },
    dispose(): void {
      hud.remove();
    },
  };
}
