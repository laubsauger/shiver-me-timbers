/**
 * The web is what the pull-back reveals (direction U5), so it must read as large-scale structure, not as a
 * diagram: the same web in every frame and every render lane (seeded), knots joined to their NEIGHBOURS (a
 * filament across the whole ball reads as a scaffold), every knot on the web, filaments bowed rather than
 * straight, and the grains actually lying on it.
 */
import { describe, expect, it } from 'vitest';
import { buildWeb, filamentPoint, placeGrains } from '../src/drift/undertime/web';

const dist = (a: number[], b: number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('Undertime cosmic web', () => {
  const w = buildWeb(1009, 46);

  it('is the same web for the same seed (every frame and render lane agree)', () => {
    expect(buildWeb(1009, 46)).toEqual(w);
    expect(buildWeb(1010, 46)).not.toEqual(w);
  });

  it('keeps knots apart and joins each one to the web through its near neighbours', () => {
    expect(w.knots.length).toBe(46);
    for (let i = 0; i < w.knots.length; i++)
      for (let j = i + 1; j < w.knots.length; j++) expect(dist(w.knots[i], w.knots[j])).toBeGreaterThanOrEqual(0.16);
    const degree = new Array(w.knots.length).fill(0);
    for (const f of w.filaments) {
      degree[f.a]++;
      degree[f.b]++;
      // no filament spans the ball: neighbours only
      expect(dist(w.knots[f.a], w.knots[f.b])).toBeLessThan(1);
    }
    expect(Math.min(...degree)).toBeGreaterThanOrEqual(1);
  });

  it('bows every filament off the straight line between its knots', () => {
    for (const f of w.filaments) {
      const mid = filamentPoint(w, f, 0.5);
      const A = w.knots[f.a];
      const B = w.knots[f.b];
      const chord = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2];
      expect(dist(mid, chord) / dist(A, B)).toBeGreaterThan(0.03);
    }
  });

  it('puts the web share of grains on the web, the rest in the voids', () => {
    const { pos, kind } = placeGrains(w, 4000, 0.9, 7);
    const onWeb = kind.filter((k) => k > 0).length / kind.length;
    expect(onWeb).toBeGreaterThan(0.85);
    expect(onWeb).toBeLessThan(0.95);
    // a filament grain lies within a few thicknesses of some filament
    const samples = w.filaments.flatMap((f) => Array.from({ length: 41 }, (_, i) => filamentPoint(w, f, i / 40)));
    for (let i = 0; i < 400; i++) {
      if (kind[i] !== 0.5) continue;
      const p = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
      expect(Math.min(...samples.map((s) => dist(s, p)))).toBeLessThan(0.08);
    }
  });
});
