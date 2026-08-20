/**
 * THE SAILING GIZMO (§I ui/hud: "see the wind, then answer it"; §T.84).
 *
 * Since §T.76 the yards brace independently of the hull, so there are THREE
 * angles a player has to hold in their head — where she points, where the
 * yards point, where the wind comes from — and a rose that only drew hull-vs-
 * wind answered one of them. This draws all three on one face, bow always up:
 *
 *                 ▼  vane  (apparent wind, FROM; longer = stronger)
 *            ╭─────────────╮
 *           ╱   ░░ no-go ░░  ╲      wedge = deadZone (+ramp), from params
 *          │   ┄┄┄┄┄┄┄┄┄┄┄    │     ┄┄ ghost yard = the brace a good crew
 *          │   ━━━━━━━━━━━━   │     ━━ the yards, at the sim's own brace,
 *          │     ▒▒sail▒▒     │        coloured/glowed by how much drive
 *          │      ╲hull╱      │        they collect; sail fill = canvas set
 *           ╲                ╱
 *            ╰─────────────╯
 *
 * Steering rule for the player: turn Q/E until the solid yard lies on the
 * dashed one. Colour says how close (brass glow → amber → wax red), but the
 * SHAPE says it too — the two bars converge — so a colour-blind player and a
 * player reading a 96px gizmo from a couch both get it (§V21 readability).
 *
 * EVERY number here is the sim's, ⊥ a re-derivation (§V.77): the bearing is
 * the same apparentWind() the masthead flags stream on, the yard is
 * `ShipState.brace` as the rig draws it, the ghost yard is `autoBrace`, the
 * colour is `braceDrive(brace)/braceDrive(autoBrace)` — the exact `braceRatio`
 * stepShipSailing scales the thrust by — and "aback" is `braceBack > 0`,
 * the plate with the wind on its face. The no-go wedge is
 * `deadZone + deadZoneRamp` from params/sailing.ts. The gizmo cannot disagree
 * with the cloth or the force model because it does not have its own opinion.
 */
import { svg, svgChild } from './dom';
import { wrapAngle } from '../ship/flagDynamics';
import { autoBrace, braceBack, braceDrive } from '../sailing/shipKinematics';
import { shipRigParams, type ShipRigParams } from '../params/ship';
import { sailingParams, type SailingParams } from '../params/sailing';

const R = 42;
const C = 50;
/** half-span of the drawn yard and of the ghost yard, in viewBox units */
const YARD = 27;
const GHOST = 33;
const RAD_TO_DEG = 180 / Math.PI;

/**
 * The eight compass points in bearing order from north. Shared with the HUD's
 * heading tape and the settings screen's wind control so that one bearing
 * cannot pick up two different names in two places on the same screen.
 */
export const CARDINALS: readonly string[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** compass point nearest a bearing in DEGREES clockwise from north */
export function cardinal(deg: number): string {
  const d = Number.isFinite(deg) ? (((deg % 360) + 360) % 360) : 0;
  return CARDINALS[Math.round(d / 45) % 8];
}

/** point on the rim at a bearing clockwise from dead ahead (radians) */
function rim(bearing: number, radius = R): [number, number] {
  return [C + radius * Math.sin(bearing), C - radius * Math.cos(bearing)];
}

/**
 * The real no-go half-angle in DEGREES: where `trimEfficiency` reaches zero
 * (`deadZone`) and where its ramp has fully opened (`deadZone + deadZoneRamp`).
 * Read from the params the force model runs on, so the wedge cannot claim a
 * different dead zone from the one that is actually stalling her.
 */
export function noGoBand(p: SailingParams = sailingParams): { hard: number; full: number } {
  const hard = Math.max(0, p.deadZone) * RAD_TO_DEG;
  return { hard, full: hard + Math.max(0, p.deadZoneRamp) * RAD_TO_DEG };
}

/** how well the yards are set, as the class the stylesheet colours by */
export type DriveClass = 'good' | 'fair' | 'poor';

/**
 * Efficiency → class, monotone by construction: a higher ratio can never land
 * in a redder band. Thresholds are presentation, the ratio is the sim's.
 */
export function driveClass(efficiency: number): DriveClass {
  if (efficiency >= 0.85) return 'good';
  if (efficiency >= 0.5) return 'fair';
  return 'poor';
}

export interface GizmoModel {
  /** the sim's wind bearing (`windBearing` convention, 0 = dead astern) */
  gamma: number;
  /** the brace a good crew would set — `autoBrace`, the ghost yard */
  optimum: number;
  /** `braceDrive(brace) / braceDrive(optimum)`, the sim's own braceRatio */
  efficiency: number;
  driveClass: DriveClass;
  /** wind on the FRONT of the canvas — `braceBack(brace) > 0` */
  aback: boolean;
}

/**
 * Pure: everything the gizmo colours and positions, from the apparent-wind
 * bearing (FROM, relative to the bow, +ve starboard — what setBearing takes)
 * and the sim's brace. Exported so the tests can pin the properties without
 * a DOM (§V.80): the ghost yard IS the argmax of the drive law, the colour is
 * monotone in drive, aback flags exactly when the plate is backed.
 */
export function sailingGizmoModel(
  bearing: number,
  brace: number,
  rig: ShipRigParams = shipRigParams,
): GizmoModel {
  // the vane reads where the wind comes FROM off the bow; windBearing's gamma
  // is where it blows TO — the same angle, half a turn round
  const gamma = wrapAngle((Number.isFinite(bearing) ? bearing : 0) + Math.PI);
  const beta = Number.isFinite(brace) ? brace : 0;
  const optimum = autoBrace(gamma, rig);
  const driveStar = braceDrive(optimum, gamma);
  const efficiency = driveStar > 0
    ? Math.min(1, Math.max(0, braceDrive(beta, gamma) / driveStar))
    : 1;
  return {
    gamma,
    optimum,
    efficiency,
    driveClass: driveClass(efficiency),
    aback: braceBack(beta, gamma) > 0,
  };
}

export interface WindDial {
  root: SVGSVGElement;
  /** bearing the wind blows FROM, relative to the bow (rad, +ve = starboard) */
  setBearing(rad: number): void;
  /** 0..1 — the vane shortens and pales as the apparent wind dies */
  setStrength(strength: number): void;
  /** the yards: the sim's brace (rad, +ve starboard yardarm aft) */
  setBrace(rad: number): void;
  /** canvas set 0..1 — fills the sail hanging off the yard */
  setTrim(trim: number): void;
  /** redraw the no-go wedge when the sailing tunables change (degrees) */
  setNoGo(hardDegrees: number, fullDegrees: number): void;
  /** the last model the face was drawn from */
  readonly model: GizmoModel;
}

function wedgePath(degrees: number): string {
  const a = (Math.max(1, Math.min(89, degrees)) * Math.PI) / 180;
  const [x1, y1] = rim(-a);
  const [x2, y2] = rim(a);
  return `M${C} ${C} L${x1.toFixed(2)} ${y1.toFixed(2)} A ${R} ${R} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
}

export function createWindDial(
  noGo: { hard: number; full: number } = noGoBand(),
): WindDial {
  const root = svg('0 0 100 100', 'smt-wind-dial');

  // the no-go wedge in two tones: dead (no thrust at all) and the ramp where
  // the sails are only beginning to draw
  const noGoFull = svgChild(root, 'path', { class: 'smt-wind-nogo is-ramp', d: '' });
  const noGoHard = svgChild(root, 'path', { class: 'smt-wind-nogo', d: '' });
  svgChild(root, 'circle', { class: 'smt-wind-ring', cx: String(C), cy: String(C), r: String(R) });

  for (let i = 0; i < 16; i++) {
    const a = (i * Math.PI) / 8;
    const major = i % 4 === 0;
    const [x1, y1] = rim(a, R);
    const [x2, y2] = rim(a, major ? R - 6 : i % 2 === 0 ? R - 4 : R - 2.5);
    svgChild(root, 'line', {
      class: `smt-wind-tick${major ? ' is-major' : ''}`,
      x1: x1.toFixed(2), y1: y1.toFixed(2), x2: x2.toFixed(2), y2: y2.toFixed(2),
    });
  }

  // GHOST YARD: where a good crew would brace. Dashed, with end chevrons, so
  // it reads as a target even in monochrome. Under the hull so the live yard
  // always draws over it.
  const ghost = svgChild(root, 'g', { class: 'smt-wind-ghost' });
  svgChild(ghost, 'line', {
    class: 'smt-wind-ghost-bar',
    x1: String(C - GHOST), y1: String(C), x2: String(C + GHOST), y2: String(C),
  });
  svgChild(ghost, 'path', {
    class: 'smt-wind-ghost-cap',
    d: `M${C - GHOST - 3} ${C - 4} L${C - GHOST} ${C} L${C - GHOST - 3} ${C + 4}`
      + ` M${C + GHOST + 3} ${C - 4} L${C + GHOST} ${C} L${C + GHOST + 3} ${C + 4}`,
  });

  // hull plan, bow up: a stem, two swelling sides and a transom
  svgChild(root, 'path', {
    class: 'smt-wind-hull',
    d: `M${C} 28 C${C + 6.5} 36 ${C + 8.5} 49 ${C + 4.2} 64 L${C - 4.2} 64 C${C - 8.5} 49 ${C - 6.5} 36 ${C} 28 Z`,
  });

  // THE YARDS: a bar through the mast, rotating with the sim's brace, with
  // the sail hanging aft of it. The sail's depth is the canvas set; when the
  // plate is backed it is flipped FORWARD of the yard, which is what the real
  // cloth does when the wind is on its face.
  const yard = svgChild(root, 'g', { class: 'smt-wind-yard' });
  const sail = svgChild(yard, 'g', { class: 'smt-wind-sail', transform: `translate(${C} ${C}) scale(1 1)` });
  svgChild(sail, 'path', {
    class: 'smt-wind-sail-cloth',
    d: `M${-YARD + 3} 0 L${YARD - 3} 0 C${YARD - 5} 9 ${YARD - 7} 13 ${YARD - 9} 15 L${-YARD + 9} 15 C${-YARD + 7} 13 ${-YARD + 5} 9 ${-YARD + 3} 0 Z`,
  });
  svgChild(yard, 'line', {
    class: 'smt-wind-yard-bar',
    x1: String(C - YARD), y1: String(C), x2: String(C + YARD), y2: String(C),
  });
  svgChild(yard, 'circle', { class: 'smt-wind-mast', cx: String(C), cy: String(C), r: '2.2' });

  // THE VANE: an arrow on the rim pointing at the hull from where the wind
  // comes, whose shaft grows with strength. Drawn at bearing 0 (dead ahead)
  // and rotated.
  const vane = svgChild(root, 'g', { class: 'smt-wind-vane' });
  const staff = svgChild(vane, 'line', {
    class: 'smt-wind-staff', x1: String(C), y1: '3', x2: String(C), y2: '14',
  });
  svgChild(vane, 'path', {
    class: 'smt-wind-flag',
    d: `M${C} 1 L${C + 5.5} 9 L${C} 6.8 L${C - 5.5} 9 Z`,
  });
  const head = svgChild(vane, 'path', {
    class: 'smt-wind-head',
    d: `M${C - 3.2} 11 L${C} 16 L${C + 3.2} 11 Z`,
  });

  let bearing = 0;
  let brace = 0;
  let trim = 1;
  let strength = 0;
  let model = sailingGizmoModel(0, 0);

  function setNoGo(hardDegrees: number, fullDegrees: number): void {
    const hard = Number.isFinite(hardDegrees) ? hardDegrees : 0;
    const full = Number.isFinite(fullDegrees) ? Math.max(hard, fullDegrees) : hard;
    noGoHard.setAttribute('d', wedgePath(hard));
    noGoFull.setAttribute('d', wedgePath(full));
  }
  setNoGo(noGo.hard, noGo.full);

  /** re-colour and re-aim the yards from the retained bearing + brace */
  function redraw(): void {
    model = sailingGizmoModel(bearing, brace);
    yard.setAttribute('transform', `rotate(${(brace * RAD_TO_DEG).toFixed(1)} ${C} ${C})`);
    ghost.setAttribute('transform', `rotate(${(model.optimum * RAD_TO_DEG).toFixed(1)} ${C} ${C})`);
    root.classList.toggle('is-good', model.driveClass === 'good');
    root.classList.toggle('is-fair', model.driveClass === 'fair');
    root.classList.toggle('is-poor', model.driveClass === 'poor');
    root.classList.toggle('is-aback', model.aback);
    // no wind or no canvas: there is nothing to be well or badly set AGAINST,
    // so the bar gives no verdict rather than a red one
    root.classList.toggle('is-slack', strength < 0.05 || trim <= 0);
    root.style.setProperty('--smt-drive', model.efficiency.toFixed(2));
    // canvas depth = trim; backed canvas hangs FORWARD of the yard
    const depth = Math.max(0.02, trim) * (model.aback ? -1 : 1);
    sail.setAttribute('transform', `translate(${C} ${C}) scale(1 ${depth.toFixed(2)})`);
  }
  redraw();

  return {
    root,
    get model(): GizmoModel {
      return model;
    },
    setBearing(rad: number): void {
      // §V.28: a NaN bearing would write `rotate(NaN)` and blank the vane for
      // good — a dead instrument is worse than a stale one
      if (!Number.isFinite(rad)) return;
      bearing = rad;
      vane.setAttribute('transform', `rotate(${(rad * RAD_TO_DEG).toFixed(1)} ${C} ${C})`);
      redraw();
    },
    setStrength(value: number): void {
      if (!Number.isFinite(value)) return;
      const s = Math.min(1, Math.max(0, value));
      strength = s;
      root.style.setProperty('--smt-vane', s.toFixed(2));
      // the shaft lengthens from a stub to a spear as the wind rises: length
      // is a channel a colour-blind eye still reads
      const tip = 8 + 12 * s;
      staff.setAttribute('y2', tip.toFixed(1));
      head.setAttribute('transform', `translate(0 ${(tip - 14).toFixed(1)})`);
      redraw();
    },
    setBrace(rad: number): void {
      if (!Number.isFinite(rad)) return;
      brace = rad;
      redraw();
    },
    setTrim(t: number): void {
      if (!Number.isFinite(t)) return;
      trim = Math.min(1, Math.max(0, t));
      root.style.setProperty('--smt-canvas', trim.toFixed(2));
      redraw();
    },
    setNoGo,
  };
}

/**
 * Point of sail from the apparent-wind bearing off the bow. Named the way a
 * crew names it — the label is the instruction: "in irons" means she is stalled
 * head to wind and must bear away.
 */
export function pointOfSail(relBearing: number, noGoDegrees: number): string {
  const a = Math.abs((relBearing * 180) / Math.PI);
  if (a <= noGoDegrees) return 'in irons';
  if (a < 70) return 'close hauled';
  if (a < 110) return 'beam reach';
  if (a < 160) return 'broad reach';
  return 'running';
}

/**
 * The Beaufort scale, by the m/s bands the WMO defines it on — a real scale,
 * not a made-up one. It lives HERE, beside the other wind vocabulary, because
 * two readouts now name the same wind: the settings slider ("4.4 m/s · F3
 * gentle breeze") and the HUD's gizmo caption ("true 8.6 kt F3"). Two tables
 * would drift, and a player reading two different forces off one wind on two
 * screens has no way to tell which one is lying.
 *
 * Force 3 at 3.4 m/s is where WHITECAPS start — the first rung on which the
 * sea itself visibly answers the wind, and the same threshold the sky's wind
 * lines switch on at.
 */
const BEAUFORT: readonly { from: number; force: number; name: string }[] = [
  { from: 32.7, force: 12, name: 'hurricane' },
  { from: 28.5, force: 11, name: 'violent storm' },
  { from: 24.5, force: 10, name: 'storm' },
  { from: 20.8, force: 9, name: 'strong gale' },
  { from: 17.2, force: 8, name: 'gale' },
  { from: 13.9, force: 7, name: 'near gale' },
  { from: 10.8, force: 6, name: 'strong breeze' },
  { from: 8.0, force: 5, name: 'fresh breeze' },
  { from: 5.5, force: 4, name: 'moderate breeze' },
  { from: 3.4, force: 3, name: 'gentle breeze' },
  { from: 1.6, force: 2, name: 'light breeze' },
  { from: 0.5, force: 1, name: 'light air' },
  { from: 0, force: 0, name: 'calm' },
];

/** Beaufort force and its name for a wind speed in m/s */
export function beaufort(mps: number): { force: number; name: string } {
  const v = Number.isFinite(mps) ? mps : 0;
  const b = BEAUFORT.find((band) => v >= band.from) ?? BEAUFORT[BEAUFORT.length - 1];
  return { force: b.force, name: b.name };
}
