/**
 * In-game HUD frame (§V21, subtle by design — must not fight the 3D view;
 * §V16: opacity/tape-scale/wind tunables live in params/ui.ts).
 *
 * TWO BANDS, ONE QUESTION EACH. The top band answers "where am I pointed" and
 * holds NOTHING but the compass tick-tape under its brass lubber diamond. The
 * bottom band — the binnacle — answers "what is she doing, and what is the
 * wind doing", and every part of it lives in ONE flow column:
 *
 *     [ at anchor ]            the seal, when she is not making way
 *      ◆ ◆ ◆ ◆                 damage diamonds
 *  [⚓][gizmo|apparent kt, point of sail, true F6][knots|heading][canvas]
 *
 * §T.84 folded the old third line — "true wind 21.4 kt f6" — into the gizmo's
 * caption: the vane's LENGTH is the apparent strength, the caption's small
 * line is the true wind's knots and force. One row fewer over the sea, and the
 * gizmo now carries the yards too (see windDial.ts), which is what made the
 * old rose insufficient once Q/E braced them independently of the helm.
 *
 * That column is the fix for §B.50. The true-wind line used to be pinned 46px
 * from the top of the frame, inside the compass's own 12–58px band, so the
 * words ran through the tick marks; the seal and the damage diamonds were
 * likewise pinned at hand-measured `bottom:` offsets that the plaque row grew
 * past. Absolute offsets tuned against one frame cannot stay clear of a row
 * whose height depends on its own text — so nothing here is absolutely
 * positioned any more except the column itself. Overlap is now structurally
 * impossible rather than merely tuned away.
 *
 * Both wind readouts also sit together, which is the other half of the
 * complaint: two different knot numbers at opposite ends of the frame read as
 * a contradiction. Adjacent and labelled, they read as what they are — the
 * wind over the sea, and the wind the ship feels.
 *
 * The wind and canvas plaques answer §I ui/hud: see the wind, then answer it.
 * Both derive from the SAME functions the ship itself uses (apparentWind for
 * the flag telltales, sailStateForTrim for the actual cloth), so the readout
 * cannot drift from what the player is looking at.
 */
import { uiParams } from '../params/ui';
import { shipRigParams } from '../params/ship';
import { sailingParams } from '../params/sailing';
import { apparentWind, wrapAngle } from '../ship/flagDynamics';
import { sailStateForTrim, trimDropScale } from '../ship/sailDynamics';
import type { SailStateId } from '../ship/pieceTypes';
import { CARDINALS, beaufort, cardinal, createWindDial, noGoBand, pointOfSail } from './windDial';
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
  /** the yards' brace (ShipState.brace, rad) — drawn as the gizmo's yard bar */
  brace?: number;
  /** riding to her anchor (ShipState.anchored) */
  anchored?: boolean;
  /** the seabed is holding her (grounding published a non-zero grip) */
  aground?: boolean;
}

export interface HudOptions {
  /**
   * The anchor button was pressed. The HUD does NOT own the anchor — it asks,
   * and re-reads the answer through `setWind`. §V.62: a button that flipped a
   * local boolean and lit its own lamp would look like it worked and drive
   * nothing, which is the shape this project has shipped thirteen times.
   */
  onAnchorToggle?(): void;
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

/**
 * WHY SHE IS NOT MAKING WAY — the readout this whole HUD was missing.
 *
 * "At anchor", "becalmed", "in irons", "sails furled" and "aground" all
 * present identically from the deck: a ship sitting still. The user could not
 * tell them apart and neither could anyone reading the bug report, which is
 * what turned §B.49 into a multi-message investigation. Named states, in
 * precedence order, because more than one can be true at once and the player
 * needs the one they must fix FIRST.
 *
 * Pure, and exported, so the test can assert every branch without a DOM.
 */
export function stalledReason(w: {
  anchored?: boolean;
  aground?: boolean;
  sailTrim: number;
  windSpeed: number;
  /** angle off the eye of the TRUE wind, rad (0 = head to wind) */
  theta: number;
  noGoDegrees: number;
}): string | null {
  if (w.anchored) return 'at anchor';
  if (w.aground) return 'aground';
  // below Beaufort 1 there is nothing to sail on, and that is not the ship's
  // fault — say so before blaming the canvas
  if (w.windSpeed < BECALMED_MS) return 'becalmed';
  if (w.sailTrim <= 0) return 'sails furled';
  if ((w.theta * RAD_TO_DEG) <= w.noGoDegrees) return 'in irons';
  return null;
}

/** m/s below which there is no sailing to be had — the foot of Beaufort 1 */
const BECALMED_MS = 0.5;

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

/**
 * A plaque cell. `key` names WHICH quantity this is and is only worth its
 * height where the same unit appears twice on screen — the wind card carries
 * "apparent" because the true-wind line right above it reads knots too, and a
 * player who cannot tell the two apart has two numbers that look like a
 * contradiction (the whole of §B.50's second half).
 */
function plaqueCell(
  value: string,
  label: string,
  key?: string,
): { root: HTMLElement; value: HTMLElement; label: HTMLElement } {
  const v = el('div', 'smt-plate-value', value);
  const l = el('div', 'smt-plate-label', label);
  const root = key === undefined
    ? div('smt-plate-cell', v, l)
    : div('smt-plate-cell', el('div', 'smt-plate-key', key), v, l);
  return { root, value: v, label: l };
}

export function createHud(root: HTMLElement, opts: HudOptions = {}): Hud {
  const tape = div('smt-compass-tape');
  const compass = div('smt-compass', tape, div('smt-lubber'));

  const speedValue = el('div', 'smt-plate-value', '0.0');
  const speedCell = div('smt-plate-cell', speedValue, el('div', 'smt-plate-label', 'knots'));
  const headingValue = el('div', 'smt-plate-value', '000°');
  const headingCell = div('smt-plate-cell', headingValue, el('div', 'smt-plate-label', 'heading'));
  const plate = div('smt-plate', speedCell, div('smt-plate-sep'), headingCell);

  // THE GIZMO and its caption. The caption carries what a 96px face cannot
  // letter: the apparent knots (the wind the ship feels), the point of sail or
  // the "aback" warning, and — as a small line under it — the TRUE wind's
  // knots and force, which is the one the settings screen sets and the one
  // that decides whether she can sail at all. The sky already draws the true
  // BEARING (§T.47's wind lines vanish toward it), so only strength is lettered.
  const dial = createWindDial(noGoBand(sailingParams));
  const windCell = plaqueCell('0.0', 'no wind', 'apparent');
  const trueWindLine = el('div', 'smt-truewind', 'true 0.0 kt · F0');
  windCell.root.appendChild(trueWindLine);
  const windCard = div('smt-plate smt-plate-side is-wind', dial.root, windCell.root);

  const canvasCell = plaqueCell('—', 'canvas');
  const dropFill = div('smt-canvas-fill');
  const canvasCard = div(
    'smt-plate smt-plate-side is-canvas',
    canvasCell.root,
    div('smt-canvas-bar', dropFill),
  );

  // A REAL BUTTON, and the only one on the HUD. The user's complaint was that
  // "anchored" could not be told from "stuck", so the control that resolves it
  // has to be visible from the deck rather than only on a key nobody has been
  // told about. It still routes through the same input path the key does —
  // see HudOptions.onAnchorToggle.
  const anchorLabel = el('div', 'smt-plate-label', 'under way');
  const anchorBtn = el('button', 'smt-plate smt-plate-side smt-anchor') as HTMLButtonElement;
  anchorBtn.type = 'button';
  anchorBtn.append(el('div', 'smt-anchor-glyph', '⚓'), anchorLabel);
  anchorBtn.title = 'Drop or weigh the anchor (X)';
  anchorBtn.setAttribute('aria-pressed', 'false');
  anchorBtn.addEventListener('click', () => opts.onAnchorToggle?.());
  // the HUD sits over a canvas that wants the keyboard: a focused button would
  // eat the next Space as a re-click instead of firing a broadside
  anchorBtn.addEventListener('pointerup', () => anchorBtn.blur());

  // why she is not making way — see stalledReason
  const stalled = div('smt-stalled');

  const damageRow = div('smt-damage');
  const damageSlots = new Map<string, HTMLElement>();

  const bottom = div('smt-bottom', anchorBtn, windCard, plate, canvasCard);
  // ONE flow column. The seal keeps its box when it is off (visibility, not
  // display) so that a ship running aground does not shove the whole binnacle
  // up the screen — and so that nothing below it has to guess its height.
  const binnacle = div('smt-binnacle', stalled, damageRow, bottom);
  const hud = div('smt-hud', compass, binnacle);
  root.appendChild(hud);

  let tapePx = uiParams.compassPixelsPerDegree;
  let hudOpacity = uiParams.hudOpacity;
  let noGo = uiParams.windNoGoDegrees;
  let deadZone = sailingParams.deadZone;
  let deadZoneRamp = sailingParams.deadZoneRamp;
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
    if (uiParams.windNoGoDegrees !== noGo) noGo = uiParams.windNoGoDegrees;
    // the wedge is the FORCE MODEL's dead zone (§V.77), so it follows the
    // sailing tunables, not the HUD's own label threshold
    if (sailingParams.deadZone !== deadZone || sailingParams.deadZoneRamp !== deadZoneRamp) {
      deadZone = sailingParams.deadZone;
      deadZoneRamp = sailingParams.deadZoneRamp;
      const band = noGoBand(sailingParams);
      dial.setNoGo(band.hard, band.full);
    }
  }

  // the vane is damped, not snapped: a raw apparent-wind bearing jitters with
  // every wave the hull yaws over, and a twitching needle is unreadable
  let vaneBearing = 0;
  let sailState: SailStateId = 'full';
  /** last trim seen, so the stall readout can name "sails furled" */
  let lastTrim = 0;

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
      // the yards as the SIM has them — the rig draws this same number
      if (w.brace !== undefined) dial.setBrace(w.brace);
      const knots = aw.speed * MS_TO_KNOTS;
      dial.setStrength(Math.min(1, knots / 20));
      windCell.value.textContent = knots.toFixed(1);
      // "aback" outranks the point of sail: it is the thing to FIX, and the
      // gizmo's flipped, wax-red sail says the same thing in shape
      const aback = dial.model.aback && lastTrim > 0 && aw.speed >= 0.2;
      windCell.label.textContent = aw.speed < 0.2
        ? 'no wind'
        : aback ? 'aback' : pointOfSail(vaneBearing, noGo);
      windCell.label.classList.toggle('is-aback', aback);

      // TRUE wind — the one the settings screen sets and the one that decides
      // whether she can sail at all; the apparent figure above it reads a
      // different number for the same air and always has.
      const trueKnots = Math.max(0, w.windSpeed) * MS_TO_KNOTS;
      const force = beaufort(w.windSpeed);
      trueWindLine.textContent = `true ${trueKnots.toFixed(1)} kt · F${force.force}`;

      // angle off the eye of the TRUE wind, with the SAME (sin, cos) heading
      // basis stepShipSailing builds its own theta from — the readout has to
      // agree with the force model or it is worse than nothing
      const fx = Math.sin(w.headingRad);
      const fz = Math.cos(w.headingRad);
      const wx = Math.sin(w.windDirection);
      const wz = Math.cos(w.windDirection);
      const dot = fx * wx + fz * wz;
      const theta = Math.acos(dot < -1 ? 1 : dot > 1 ? -1 : -dot);
      const reason = stalledReason({
        anchored: w.anchored,
        aground: w.aground,
        sailTrim: lastTrim,
        windSpeed: w.windSpeed,
        theta,
        noGoDegrees: noGo,
      });
      stalled.textContent = reason ?? '';
      stalled.classList.toggle('is-on', reason !== null);

      const anchored = w.anchored === true;
      anchorBtn.classList.toggle('is-down', anchored);
      anchorBtn.setAttribute('aria-pressed', String(anchored));
      anchorLabel.textContent = anchored ? 'at anchor' : 'under way';
    },
    setTrim(trim: number): void {
      // same hysteresis path the rig itself runs, so the plaque flips on the
      // exact frame the canvas does
      sailState = sailStateForTrim(trim, sailState, shipRigParams);
      lastTrim = trim;
      const t = Math.min(1, Math.max(0, trim));
      dial.setTrim(t);
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
