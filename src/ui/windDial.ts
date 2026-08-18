/**
 * Apparent-wind rose (§I ui/hud: "see the wind, then answer it"). Pairs with
 * the masthead flags — both read the SAME apparentWind() the telltales use, so
 * the dial and the cloth can never disagree about where the wind is.
 *
 * What it draws is a points-of-sail rose, not a generic gauge: the hull sits
 * bow-up in the middle, the engraved wedge forward is the no-go zone, and the
 * brass vane sits on the rim at the bearing the wind is coming FROM. A glance
 * says "she is on a beam reach, wind on the starboard side" — which is the one
 * number a sailing game is built on.
 */
import { svg, svgChild } from './dom';

const R = 27;
const C = 32;

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

export interface WindDial {
  root: SVGSVGElement;
  /** bearing the wind blows FROM, relative to the bow (rad, +ve = starboard) */
  setBearing(rad: number): void;
  /** 0..1 — the vane goes slack and pale as the apparent wind dies */
  setStrength(strength: number): void;
  /** redraw the no-go wedge when its params tunable changes */
  setNoGo(degrees: number): void;
}

export function createWindDial(noGoDegrees: number): WindDial {
  const root = svg('0 0 64 64', 'smt-wind-dial');

  const noGo = svgChild(root, 'path', { class: 'smt-wind-nogo', d: '' });
  svgChild(root, 'circle', { class: 'smt-wind-ring', cx: '32', cy: '32', r: String(R) });

  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const [x1, y1] = rim(a, R);
    const [x2, y2] = rim(a, i % 2 === 0 ? R - 5 : R - 3);
    svgChild(root, 'line', {
      class: `smt-wind-tick${i % 4 === 0 ? ' is-major' : ''}`,
      x1: x1.toFixed(2), y1: y1.toFixed(2), x2: x2.toFixed(2), y2: y2.toFixed(2),
    });
  }

  // hull plan, bow up: a stem, two swelling sides and a transom
  svgChild(root, 'path', {
    class: 'smt-wind-hull',
    d: 'M32 20 C36.2 25.5 37.4 33.5 34.6 41.5 L29.4 41.5 C26.6 33.5 27.8 25.5 32 20 Z',
  });

  // the vane: a pennant streaming off the rim, tip toward the hull
  const vane = svgChild(root, 'g', { class: 'smt-wind-vane' });
  svgChild(vane, 'path', { class: 'smt-wind-flag', d: 'M32 12 L36.6 3.4 L32 5.6 L27.4 3.4 Z' });
  svgChild(vane, 'line', {
    class: 'smt-wind-staff', x1: '32', y1: '3.4', x2: '32', y2: '12',
  });

  function setNoGo(degrees: number): void {
    const a = (Math.max(1, Math.min(89, degrees)) * Math.PI) / 180;
    const [x1, y1] = rim(-a);
    const [x2, y2] = rim(a);
    noGo.setAttribute(
      'd',
      `M32 32 L${x1.toFixed(2)} ${y1.toFixed(2)} A ${R} ${R} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`,
    );
  }
  setNoGo(noGoDegrees);

  return {
    root,
    setBearing(rad: number): void {
      const deg = ((rad * 180) / Math.PI).toFixed(1);
      vane.setAttribute('transform', `rotate(${deg} 32 32)`);
    },
    setStrength(strength: number): void {
      const s = Math.min(1, Math.max(0, strength));
      root.style.setProperty('--smt-vane', s.toFixed(2));
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
