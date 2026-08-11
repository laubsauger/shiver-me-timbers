/**
 * In-game HUD frame (§V21, subtle by design — must not fight the 3D view;
 * §V16: opacity/tape-scale tunables live in params/ui.ts). Top: engraved
 * compass tick-tape under a brass lubber diamond, edge-masked so it fades
 * into the sky. Bottom: hexagonal plaque with knots + heading in old-style
 * figures. Damage diamonds appear above the plaque as zones report in.
 */
import { uiParams } from '../params/ui';
import { div, el } from './dom';

export interface Hud {
  /** heading in radians, 0 = north, clockwise */
  setHeading(rad: number): void;
  setSpeed(knots: number): void;
  /** level 0..1; 0 clears the slot back to an empty placeholder */
  setDamage(zoneId: string, level: number): void;
  dispose(): void;
}

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const RAD_TO_DEG = 180 / Math.PI;

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

export function createHud(root: HTMLElement): Hud {
  const tape = div('smt-compass-tape');
  const compass = div('smt-compass', tape, div('smt-lubber'));

  const speedValue = el('div', 'smt-plate-value', '0.0');
  const speedCell = div('smt-plate-cell', speedValue, el('div', 'smt-plate-label', 'knots'));
  const headingValue = el('div', 'smt-plate-value', '000°');
  const headingCell = div('smt-plate-cell', headingValue, el('div', 'smt-plate-label', 'heading'));
  const plate = div('smt-plate', speedCell, div('smt-plate-sep'), headingCell);

  const damageRow = div('smt-damage');
  const damageSlots = new Map<string, HTMLElement>();

  const hud = div('smt-hud', compass, damageRow, plate);
  root.appendChild(hud);

  let tapePx = uiParams.compassPixelsPerDegree;
  let hudOpacity = uiParams.hudOpacity;
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
  }

  return {
    setHeading(rad: number): void {
      applyParams();
      const deg = ((rad * RAD_TO_DEG) % 360 + 360) % 360;
      tape.style.transform = `translateX(${(-deg * tapePx).toFixed(2)}px)`;
      const cardinal = CARDINALS[Math.round(deg / 45) % 8];
      headingValue.textContent = `${String(Math.round(deg) % 360).padStart(3, '0')}° ${cardinal}`;
    },
    setSpeed(knots: number): void {
      speedValue.textContent = Math.max(0, knots).toFixed(1);
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
