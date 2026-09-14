/**
 * Gate crossing and turn-mark rounding, SWEPT (§T.184, §V107).
 *
 * A hull reference point moves p0 → p1 over one physics substep. Point-in-box tests skip a
 * thin gate at 60 m/s (1 m per substep), so every test here is on the SEGMENT, never the
 * endpoints alone.
 *
 * Crossing rule, half-open so a point landing exactly on the line counts once: the segment
 * starts strictly BEFORE the gate line (course direction) and ends ON or AFTER it, and the
 * intersection lies between the poles.
 */
import { cross2 } from './polyline';
import type { Course, CourseElement, Gate, TurnMark, Vec2 } from './types';

export type CrossingResult =
  /** crossed in course direction; `t` ∈ (0, 1] = fraction of the segment at the line */
  | { dir: 'forward'; t: number }
  /** crossed between the poles against course direction */
  | { dir: 'reverse'; t: number }
  | null;

/**
 * Swept crossing of the pole segment. Handedness (types.ts, §T.197): `left` is the PORT pole
 * and `right` the STARBOARD pole seen travelling the course direction, so course direction is
 * the one the right pole lies to STARBOARD of: forward ⟺ cross2(left − right, motion) > 0
 * (cross2 > 0 ⟹ the second vector lies to STARBOARD of the first, polyline.ts).
 */
export function segmentCrossesPoles(
  left: Vec2,
  right: Vec2,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): CrossingResult {
  // measured from the starboard pole along starboard → port
  const rx = left[0] - right[0];
  const rz = left[1] - right[1];
  // signed side: > 0 beyond the line in course direction
  const s0 = cross2(rx, rz, x0 - right[0], z0 - right[1]);
  const s1 = cross2(rx, rz, x1 - right[0], z1 - right[1]);
  let dir: 'forward' | 'reverse';
  if (s0 < 0 && s1 >= 0) dir = 'forward';
  else if (s0 > 0 && s1 <= 0) dir = 'reverse';
  else return null;
  const t = s0 / (s0 - s1);
  const ix = x0 + (x1 - x0) * t - right[0];
  const iz = z0 + (z1 - z0) * t - right[1];
  const u = (ix * rx + iz * rz) / (rx * rx + rz * rz);
  if (u < 0 || u > 1) return null; // outside a pole: tunnelled past it, does not count
  return { dir, t };
}

export function gateCrossing(gate: Gate, x0: number, z0: number, x1: number, z1: number): CrossingResult {
  return segmentCrossesPoles(gate.left, gate.right, x0, z0, x1, z1);
}

/** representative point of an element: gate midpoint or mark position */
export function elementCenter(e: CourseElement): Vec2 {
  if (e.kind === 'gate') {
    return [(e.gate.left[0] + e.gate.right[0]) / 2, (e.gate.left[1] + e.gate.right[1]) / 2];
  }
  return e.mark.at;
}

/**
 * The rounding bearing of a turn mark as a virtual gate.
 *
 * Rounding = the boat's bearing around the mark sweeps PAST the rounding bearing in the
 * sense `keepOn` demands, while outside `radius`. The rounding bearing points from the mark
 * to the outside of the turn: o ∝ side(d_in) + side(d_out) + (d_in − d_out), where d_in/d_out
 * are the approach/exit directions (previous element → mark → next element) and side() is the
 * side of the course line the boat passes on, seen from the mark (port of d when the mark is
 * kept to starboard). A straight pass gives the pass side, a hairpin gives straight ahead of the
 * approach, a 90° turn the corner apex. Handedness: types.ts (port of d = (d.z, −d.x)).
 *
 * Sweeping the bearing past o in one substep ⟺ the substep segment crosses the ray
 * mark + [radius, capture]·o in the rotational direction, so the swept gate test does it
 * exactly, with no angle unwrapping. Mark kept to starboard ⟹ the boat circles it turning to
 * starboard ⟹ its bearing (atan2(x, z) relative to the mark) DECREASES ⟹ motion · starboard(o) < 0.
 */
export function markRoundingPoles(
  mark: TurnMark,
  prevCenter: Vec2,
  nextCenter: Vec2,
  captureRange: number,
): { left: Vec2; right: Vec2 } {
  const [mx, mz] = mark.at;
  const dinx0 = mx - prevCenter[0];
  const dinz0 = mz - prevCenter[1];
  const din = Math.hypot(dinx0, dinz0) || 1;
  const doutx0 = nextCenter[0] - mx;
  const doutz0 = nextCenter[1] - mz;
  const dout = Math.hypot(doutx0, doutz0) || 1;
  const ix = dinx0 / din;
  const iz = dinz0 / din;
  const ox = doutx0 / dout;
  const oz = doutz0 / dout;
  // boat passes to PORT of the course direction when the mark is kept to starboard
  const portSign = mark.keepOn === 'starboard' ? 1 : -1;
  // port(d) = (d.z, −d.x)
  let rx = portSign * (iz + oz) + (ix - ox);
  let rz = portSign * (-ix - ox) + (iz - oz);
  let n = Math.hypot(rx, rz);
  if (n < 1e-9) {
    rx = portSign * iz;
    rz = portSign * -ix;
    n = 1;
  }
  rx /= n;
  rz /= n;
  const inner: Vec2 = [mx + rx * mark.radius, mz + rz * mark.radius];
  const outer: Vec2 = [mx + rx * captureRange, mz + rz * captureRange];
  // forward ⟺ cross2(left − right, m) > 0. Starboard keep sweeps the bearing down: cross2(o, m) > 0
  // (m to starboard of o) ⟹ left − right = o ⟹ left = outer, right = inner.
  return mark.keepOn === 'starboard' ? { left: outer, right: inner } : { left: inner, right: outer };
}

/** Pole pairs for every element (gates as authored, marks as their rounding ray). */
export function elementPoles(course: Course, captureRange: number): { left: Vec2; right: Vec2 }[] {
  const n = course.elements.length;
  return course.elements.map((e, i) => {
    if (e.kind === 'gate') return { left: e.gate.left, right: e.gate.right };
    const prev = elementCenter(course.elements[(i - 1 + n) % n]);
    const next = elementCenter(course.elements[(i + 1) % n]);
    return markRoundingPoles(e.mark, prev, next, captureRange);
  });
}
