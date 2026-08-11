/**
 * §V12 rope catenary reference tests. The TSL compute kernel in
 * src/ropes/ropeCompute.ts mirrors src/ropes/catenaryMath.ts term-for-term
 * and cannot itself be unit-tested — so THESE tests gate the GPU: if the CPU
 * reference is wrong, every rope on screen is wrong. Each test encodes a
 * property the renderer depends on, not just today's output values.
 */
import { describe, expect, it } from 'vitest';
import {
  TAUT_EPS,
  solveCatenary,
  solveSagParameter,
  type Vec3Like,
} from '../src/ropes/catenaryMath';

const v3 = (x: number, y: number, z: number): Vec3Like => ({ x, y, z });
const dist = (a: Vec3Like, b: Vec3Like): number =>
  Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
const polylineLength = (pts: Vec3Like[]): number => {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
  return s;
};
const lerp = (a: Vec3Like, b: Vec3Like, t: number): Vec3Like =>
  v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
const assertFinite = (pts: Vec3Like[]): void => {
  for (const p of pts) {
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
    expect(Number.isFinite(p.z)).toBe(true);
  }
};

describe('solveSagParameter (§V12 fixed-iteration Newton)', () => {
  it('converges within the fixed GPU loop bound across the slack range', () => {
    // WHY: the GPU loop cannot iterate adaptively — 20 bounded steps must
    // actually land on the root sinh(z)/z = r or ropes hang at wrong depths.
    for (const r of [1.0001, 1.01, 1.2, 2, 5, 50]) {
      const z = solveSagParameter(r);
      const residual = Math.abs(Math.sinh(z) / z - r) / r;
      expect(residual).toBeLessThan(1e-6);
    }
  });

  it('stays finite for absurd slack ratios (Z_MAX overflow guard)', () => {
    // WHY: the f32 kernel clamps the Newton start so sinh never overflows;
    // the reference must survive the same inputs without NaN/Inf.
    for (const r of [1, 0.5, 1e3, 1e9]) {
      expect(Number.isFinite(solveSagParameter(r))).toBe(true);
    }
  });
});

describe('solveCatenary endpoints (§V13 ropes anchor at ship sockets)', () => {
  it('first/last points hit A and B within 1e-3', () => {
    // WHY: anchors must visually attach to sockets; a drifting endpoint
    // reads as a broken rig even when the curve shape is right.
    const cases: Array<[Vec3Like, Vec3Like, number]> = [
      [v3(0, 10, 0), v3(8, 10, 0), 10],
      [v3(-3, 12, 2), v3(4, 6, -5), 1.4 * dist(v3(-3, 12, 2), v3(4, 6, -5))],
      [v3(0, 0, 0), v3(0.5, 20, 0.5), 25],
    ];
    for (const [A, B, L] of cases) {
      const pts = solveCatenary(A, B, L, 16);
      expect(pts).toHaveLength(17);
      expect(dist(pts[0], A)).toBeLessThan(1e-3);
      expect(dist(pts[16], B)).toBeLessThan(1e-3);
    }
  });
});

describe('solveCatenary arc length (§V12 L is the physical input)', () => {
  it('polyline length matches L within 1% for slack ropes', () => {
    // WHY: length is what the rigging/destruction systems feed in (mast
    // moves re-solve with the SAME L); if sampled length drifts, sag lies.
    const A = v3(0, 10, 0);
    const B = v3(10, 8, 4);
    for (const slack of [1.1, 1.5, 2.5]) {
      const L = slack * dist(A, B);
      const len = polylineLength(solveCatenary(A, B, L, 64));
      expect(Math.abs(len - L) / L).toBeLessThan(0.01);
      expect(len).toBeLessThanOrEqual(L); // chords always undershoot the arc
    }
  });
});

describe('solveCatenary shape', () => {
  it('taut rope (L ≈ chord) is a straight line', () => {
    // WHY: hoisted rigging must not show phantom sag; within TAUT_EPS the
    // solver must short-circuit to the chord instead of a degenerate solve.
    const A = v3(0, 5, 0);
    const B = v3(6, 9, 2);
    const L = dist(A, B) * (1 + TAUT_EPS / 2);
    const pts = solveCatenary(A, B, L, 16);
    pts.forEach((p, i) => {
      expect(dist(p, lerp(A, B, i / 16))).toBeLessThan(1e-9);
    });
  });

  it('slack rope sags strictly below the chord', () => {
    // WHY: the hanging-below-chord silhouette IS the feature (SoT rigging
    // look, docs/ropes-math.png); a curve above or on the chord is a bug.
    const A = v3(0, 10, 0);
    const B = v3(10, 12, 0);
    const pts = solveCatenary(A, B, 1.3 * dist(A, B), 16);
    for (let i = 1; i < 16; i++) {
      expect(pts[i].y).toBeLessThan(lerp(A, B, i / 16).y);
    }
  });

  it('more slack → deeper sag (monotone in L)', () => {
    // WHY: destruction re-solves ropes with new lengths (§V14); sag must
    // respond monotonically or slack edits look glitchy.
    const A = v3(0, 10, 0);
    const B = v3(10, 10, 0);
    const chord = dist(A, B);
    let prevMidY = A.y;
    for (const slack of [1.05, 1.2, 1.5, 2]) {
      const midY = solveCatenary(A, B, slack * chord, 16)[8].y;
      expect(midY).toBeLessThan(prevMidY);
      prevMidY = midY;
    }
  });

  it('curve stays in the vertical plane through A and B', () => {
    // WHY: the compute kernel's sway basis and the tube frame assume the
    // unswayed curve is planar; out-of-plane drift would corkscrew tubes.
    const A = v3(1, 8, -2);
    const B = v3(7, 5, 6);
    const pts = solveCatenary(A, B, 1.5 * dist(A, B), 32);
    const hx = B.x - A.x;
    const hz = B.z - A.z;
    const invH = 1 / Math.hypot(hx, hz);
    // horizontal unit normal of the vertical plane containing A→B
    const nx = -hz * invH;
    const nz = hx * invH;
    for (const p of pts) {
      expect(Math.abs((p.x - A.x) * nx + (p.z - A.z) * nz)).toBeLessThan(1e-9);
    }
  });
});

describe('solveCatenary degenerate inputs (§V12 NaN guards)', () => {
  it('L < chord clamps to a straight rope without NaN', () => {
    // WHY: rigging edits can momentarily ask for impossible lengths (mast
    // swinging away); the kernel must degrade to taut, never to NaN verts.
    const A = v3(0, 0, 0);
    const B = v3(10, 3, 4);
    for (const L of [0, 1, dist(A, B) * 0.5]) {
      const pts = solveCatenary(A, B, L, 16);
      assertFinite(pts);
      pts.forEach((p, i) => {
        expect(dist(p, lerp(A, B, i / 16))).toBeLessThan(1e-9);
      });
    }
  });

  it('vertical rope (A directly above B) yields a finite straight drop', () => {
    // WHY: halyards ARE vertical; horizontal span h→0 divides the sag-plane
    // math by zero unless guarded — this pins the guard forever.
    const A = v3(2, 15, 3);
    const B = v3(2, 1, 3);
    const pts = solveCatenary(A, B, 20, 16); // slack: L > |A−B| = 14
    assertFinite(pts);
    expect(dist(pts[0], A)).toBeLessThan(1e-3);
    expect(dist(pts[16], B)).toBeLessThan(1e-3);
    pts.forEach((p, i) => {
      expect(dist(p, lerp(A, B, i / 16))).toBeLessThan(1e-9);
    });
  });
});

describe('determinism (§V2 spirit: same inputs → identical curve)', () => {
  it('two identical calls produce bit-identical points', () => {
    // WHY: the GPU mirrors this exact float math; a nondeterministic
    // reference could never validate the kernel, and sim replay (§V2)
    // assumes rope solves are pure functions of their descriptors.
    const A = v3(-4, 9, 1);
    const B = v3(5, 7, -3);
    const L = 1.7 * dist(A, B);
    expect(solveCatenary(A, B, L, 24)).toEqual(solveCatenary(A, B, L, 24));
  });
});
