/**
 * The bubble-chamber look rests on one physical picture: a pair's two particles curl in OPPOSITE senses
 * (opposite charge in one field) and spiral INWARD as they lose energy, ending at a point. If either breaks,
 * the tracks stop reading as pair production — they become arbitrary squiggles.
 */
import { describe, expect, it } from 'vitest';
import { spiralCpu } from '../src/drift/undertime/pairModel';

describe('Undertime pair spirals', () => {
  it('starts at the vertex and leaves along the launch direction', () => {
    const [x0, y0] = spiralCpu(0, 4, 2.6, 0.9, 1);
    expect(x0).toBeCloseTo(0, 12);
    expect(y0).toBeCloseTo(0, 12);
    const [x, y] = spiralCpu(1e-4, 4, 2.6, 0.9, 1);
    expect(x).toBeGreaterThan(0);
    expect(Math.abs(y)).toBeLessThan(Math.abs(x) * 1e-2);
  });

  it('opposite charges curl in opposite senses (mirror images across the launch line)', () => {
    for (const t of [0.2, 0.7, 1.5]) {
      const [x1, y1] = spiralCpu(t, 4, 2.6, 0.9, 1);
      const [x2, y2] = spiralCpu(t, 4, 2.6, 0.9, -1);
      expect(x2).toBeCloseTo(x1, 12);
      expect(y2).toBeCloseTo(-y1, 12);
    }
  });

  it('spirals inward to a fixed end point instead of circling forever', () => {
    const end = spiralCpu(60, 4, 2.6, 0.9, 1);
    const late = spiralCpu(8, 4, 2.6, 0.9, 1);
    expect(Math.hypot(late[0] - end[0], late[1] - end[1])).toBeLessThan(1e-2);
    // distance to that end point shrinks monotonically over the turns
    let prev = Infinity;
    for (let t = 0; t < 6; t += 0.25) {
      const p = spiralCpu(t, 4, 2.6, 0.9, 1);
      const d = Math.hypot(p[0] - end[0], p[1] - end[1]);
      expect(d).toBeLessThanOrEqual(prev + 1e-12);
      prev = d;
    }
  });
});
