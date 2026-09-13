/**
 * Runtime validation of a `Course` against the race contract (src/race/types.ts).
 * TypeScript checks the SHAPE at compile time; this checks what the types
 * cannot say — ids, the start gate, finite coordinates, a closed line, a pace
 * line that ends on the start, bounds that contain the course. Returns every
 * violation (empty = valid) so a caller can fail loud with all of them (§Rule 8).
 */
import type { Course, Vec2 } from '../race/types';

const finite = (p: unknown): p is Vec2 =>
  Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);

export function validateCourse(course: Course): string[] {
  const errors: string[] = [];
  if (!course.id) errors.push('course: empty id');
  if (!course.name) errors.push('course: empty name');
  if (!Number.isInteger(course.laps) || course.laps < 1) errors.push(`course: laps ${course.laps} is not a positive integer`);
  if (course.elements.length < 2) errors.push('course: fewer than 2 elements');
  const ids = new Set<string>();
  course.elements.forEach((e, i) => {
    const id = e.kind === 'gate' ? e.gate.id : e.kind === 'mark' ? e.mark.id : undefined;
    if (!id) errors.push(`element ${i}: no id (kind ${(e as { kind: string }).kind})`);
    else if (ids.has(id)) errors.push(`element ${i}: duplicate id '${id}'`);
    else ids.add(id);
    if (e.kind === 'gate') {
      if (!finite(e.gate.left) || !finite(e.gate.right)) errors.push(`gate ${id}: non-finite pole`);
      if (e.gate.sector !== 'exposed' && e.gate.sector !== 'sheltered') errors.push(`gate ${id}: sector '${e.gate.sector}'`);
      const w = Math.hypot(e.gate.right[0] - e.gate.left[0], e.gate.right[1] - e.gate.left[1]);
      if (!(w > 0)) errors.push(`gate ${id}: zero width`);
    } else if (e.kind === 'mark') {
      if (!finite(e.mark.at)) errors.push(`mark ${id}: non-finite position`);
      if (e.mark.keepOn !== 'port' && e.mark.keepOn !== 'starboard') errors.push(`mark ${id}: keepOn '${e.mark.keepOn}'`);
      if (!(e.mark.radius > 0)) errors.push(`mark ${id}: radius ${e.mark.radius}`);
    } else {
      errors.push(`element ${i}: unknown kind`);
    }
  });
  const first = course.elements[0];
  if (!first || first.kind !== 'gate' || first.gate.id !== course.startGateId) {
    errors.push(`course: startGateId '${course.startGateId}' is not element 0's gate`);
  }
  if (course.referenceLine.length < 16) errors.push(`referenceLine: ${course.referenceLine.length} points`);
  if (!course.referenceLine.every(finite)) errors.push('referenceLine: non-finite point');
  const a = course.referenceLine[0];
  const z = course.referenceLine[course.referenceLine.length - 1];
  if (a && z && a[0] === z[0] && a[1] === z[1]) errors.push('referenceLine: first point repeated at the end (the line is implicitly closed)');
  if (course.paceLine.length < 2 || !course.paceLine.every(finite)) errors.push('paceLine: fewer than 2 finite points');
  if (first?.kind === 'gate' && course.paceLine.length) {
    const end = course.paceLine[course.paceLine.length - 1];
    const mid: Vec2 = [(first.gate.left[0] + first.gate.right[0]) / 2, (first.gate.left[1] + first.gate.right[1]) / 2];
    if (Math.hypot(end[0] - mid[0], end[1] - mid[1]) > 1) errors.push('paceLine: does not end at the start gate');
  }
  const { min, max } = course.bounds;
  if (!finite(min) || !finite(max) || !(max[0] > min[0] && max[1] > min[1])) errors.push('bounds: degenerate');
  const inside = (p: Vec2): boolean => p[0] >= min[0] && p[0] <= max[0] && p[1] >= min[1] && p[1] <= max[1];
  if (!course.referenceLine.every(inside)) errors.push('bounds: referenceLine leaves the bounds');
  if (!course.paceLine.every(inside)) errors.push('bounds: paceLine leaves the bounds');
  return errors;
}
