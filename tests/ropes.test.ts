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
import {
  farness,
  perceivedWidthPx,
  phoneWire,
  projectedWidthPx,
  type PhoneWireParams,
} from '../src/ropes/phoneWireAA';
import { ropeParams } from '../src/params/ropes';
import { cameraParams } from '../src/params/camera';

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

/**
 * §V41 phone-wire AA. These pin the maths the rope vertex stage runs
 * (src/ropes/ropeMesh.ts mirrors src/ropes/phoneWireAA.ts term for term, and
 * the GPU side cannot be unit-tested — same arrangement as the §V12 solve
 * above). The properties matter more than the numbers: the whole technique
 * exists to make a rope's contribution CONTINUOUS as it shrinks past a pixel,
 * so a test that only checked today's values would miss the one bug that
 * matters.
 */
describe('§V41 phone-wire AA (thin ropes at distance)', () => {
  const P: PhoneWireParams = { minWidthPx: 1, farWidthPx: 1.5, nearWidthPx: 3 };
  /** dense sweep across both thresholds, in projected pixels */
  const sweep = (from: number, to: number, n: number): number[] =>
    Array.from({ length: n + 1 }, (_, i) => from + ((to - from) * i) / n);

  it('conserves energy: drawn width × alpha always equals the true width', () => {
    // WHY: THE invariant. Widening a sub-pixel rope to a pixel makes it
    // visible; paying that back in alpha is what stops it being visibly FATTER
    // than it should be. If these drift apart, distant rigging either bulks up
    // into a dark cage or fades away — the two failure modes the technique
    // sits between. Checked well past the clamp, where widen is ~1000×.
    for (const width of sweep(0.001, 20, 2000)) {
      expect(perceivedWidthPx(width, P), `at ${width}px`).toBeCloseTo(width, 9);
    }
  });

  it('never draws a rope thinner than one pixel — that is the premise', () => {
    // WHY: sub-pixel geometry misses pixel centres and the line goes dashed,
    // with the dashes crawling as the ship moves. Clamping the DRAWN width is
    // the fix; if this regresses the alpha maths above would still balance,
    // but the rope would be back to flickering.
    for (const width of sweep(0.001, 20, 500)) {
      const { drawnWidthPx, widen } = phoneWire(width, P);
      expect(drawnWidthPx, `at ${width}px`).toBeGreaterThanOrEqual(P.minWidthPx - 1e-9);
      expect(widen).toBeGreaterThanOrEqual(1);
    }
  });

  it('is continuous through the pixel clamp AND the regime crossfade', () => {
    // WHY: a step anywhere here IS the pop. Three transitions can each cause
    // one: the alpha clamp at minWidthPx, and both edges of the regime band.
    // Sampling finely, no adjacent pair may jump more than the sweep step —
    // i.e. the response is not merely continuous but has bounded slope.
    const widths = sweep(0.001, 12, 12000);
    const step = widths[1] - widths[0];
    for (let i = 1; i < widths.length; i++) {
      const dPerceived = Math.abs(
        perceivedWidthPx(widths[i], P) - perceivedWidthPx(widths[i - 1], P),
      );
      const dAlpha = Math.abs(phoneWire(widths[i], P).alpha - phoneWire(widths[i - 1], P).alpha);
      const dFar = Math.abs(farness(widths[i], P) - farness(widths[i - 1], P));
      expect(dPerceived, `perceived jumps at ${widths[i]}px`).toBeLessThan(step * 2);
      expect(dAlpha, `alpha jumps at ${widths[i]}px`).toBeLessThan(step * 2);
      expect(dFar, `farness jumps at ${widths[i]}px`).toBeLessThan(step * 2);
    }
  });

  it('both regimes draw at the SAME widened radius — the crossfade has no width step', () => {
    // WHY: near and far are separate meshes. If they disagreed about radius,
    // the handover would show as a visible thickening or thinning even though
    // the alphas summed to 1. The renderer feeds `drawnRadius` to both; this
    // pins that the shared value is the only width in play, and that the two
    // alphas partition the rope rather than double it.
    for (const width of sweep(0.001, 12, 1200)) {
      const { alpha } = phoneWire(width, P);
      const far = farness(width, P);
      const nearAlpha = (1 - far) * alpha;
      const farAlpha = far * alpha;
      expect(nearAlpha + farAlpha).toBeCloseTo(alpha, 12);
      expect(nearAlpha).toBeGreaterThanOrEqual(0);
      expect(farAlpha).toBeGreaterThanOrEqual(0);
    }
  });

  it('hands the rope over: far regime owns thin, near regime owns wide', () => {
    // WHY: the slide's whole point is that distant ropes stop paying for
    // normals and lighting. If farness never reached 1 the cheap path would
    // never actually take over; if it never reached 0 the close-up rigging
    // would lose its shading.
    expect(farness(P.farWidthPx - 0.01, P)).toBeCloseTo(1, 6);
    expect(farness(0.001, P)).toBeCloseTo(1, 6);
    expect(farness(P.nearWidthPx + 0.01, P)).toBeCloseTo(0, 6);
    expect(farness(50, P)).toBeCloseTo(0, 6);
    // monotone across the band: a rope may never get "nearer" as it recedes
    let prev = Infinity;
    for (const width of sweep(0.001, 12, 1200)) {
      const far = farness(width, P);
      expect(far).toBeLessThanOrEqual(prev + 1e-12);
      prev = far;
    }
  });

  it('switches on PIXELS, not metres: doubling resolution doubles the range', () => {
    // WHY: §V36, and §B12 for what a metre threshold costs. The distance at
    // which a rope goes sub-pixel is a function of resolution and FOV — a
    // hand-picked metre gate silently means something else at 4K, at another
    // FOV, and in the HALF-RES reflection pass, where every rope is half as
    // wide and would cross over at half the distance.
    const radius = 0.04; // a shroud
    const fov = (60 * Math.PI) / 180;
    const crossover = (heightPx: number): number => {
      // distance at which projected width falls to the far-regime edge
      let d = 1;
      while (projectedWidthPx(radius, d, heightPx, fov) > P.farWidthPx && d < 1e6) d *= 1.001;
      return d;
    };
    const at1080 = crossover(1080);
    const at2160 = crossover(2160);
    expect(at2160 / at1080).toBeCloseTo(2, 1);
    // and a narrower FOV magnifies, pushing the crossover further out
    const narrow = projectedWidthPx(radius, 100, 1080, fov / 2);
    expect(narrow).toBeGreaterThan(projectedWidthPx(radius, 100, 1080, fov));
  });

  it('the rig really is sub-pixel at demo distances — this feature is needed', () => {
    // WHY: guards the premise itself. If ropes were comfortably multi-pixel at
    // range the whole regime split would be dead weight and someone would be
    // right to delete it. Measured at 1080p/60°: the thickest rope in the rig
    // (a 0.04 m shroud) is 0.75 px at 100 m and 0.016 px at the ocean's 4.6 km
    // horizon; the thinnest (a 0.022 m sheet) is 0.41 px at 100 m.
    const fov = (60 * Math.PI) / 180;
    expect(projectedWidthPx(0.04, 100, 1080, fov)).toBeLessThan(1);
    expect(projectedWidthPx(0.022, 100, 1080, fov)).toBeLessThan(0.5);
    expect(projectedWidthPx(0.05, 4600, 1080, fov)).toBeLessThan(0.05);
    // …and at arm's length it is comfortably wide, so the near regime is
    // genuinely exercised too
    expect(projectedWidthPx(0.04, 5, 1080, fov)).toBeGreaterThan(P.nearWidthPx);
  });

  it('shipped defaults keep the HERO ship shaded at normal camera distance', () => {
    // WHY: the far regime is unlit. The follow camera sits ~40 m from the ship
    // (params/camera radius), where a shroud is only ~1.9 px — so a threshold
    // chosen purely from "when does it alias" would hand the hero ship's own
    // rigging to the flat path in the shot the user actually looks at. An
    // earlier draft did exactly that at 84% far. The far path is for ropes
    // that are genuinely sub-pixel, not merely thin.
    const live: PhoneWireParams = {
      minWidthPx: ropeParams.aaMinWidthPx,
      farWidthPx: ropeParams.farWidthPx,
      nearWidthPx: ropeParams.nearWidthPx,
    };
    const fov = (60 * Math.PI) / 180;
    const atCamera = projectedWidthPx(0.04, cameraParams.radius, 1080, fov);
    expect(farness(atCamera, live), `${atCamera.toFixed(2)}px at the follow cam`)
      .toBeLessThan(0.25);
    // …while genuinely distant rigging is fully on the cheap path
    expect(farness(projectedWidthPx(0.04, 150, 1080, fov), live)).toBeCloseTo(1, 6);
  });

  it('the half-res reflection pass gets the same treatment for free', () => {
    // WHY: §V26 samples the scene at half resolution, which halves every
    // rope's projected width — the reflected rig aliases at HALF the distance
    // the direct one does. Because the threshold is in pixels and the shader
    // reads the live viewport, that is handled with no second code path and
    // no second set of constants. A metre gate would have needed both.
    const fov = (60 * Math.PI) / 180;
    const full = projectedWidthPx(0.04, 100, 1080, fov);
    const half = projectedWidthPx(0.04, 100, 540, fov);
    expect(half).toBeCloseTo(full / 2, 9);
    expect(farness(half, P)).toBeGreaterThanOrEqual(farness(full, P));
  });

  it('is finite for degenerate inputs — no NaN can reach a vertex (§V28)', () => {
    // WHY: §B5. A NaN that reaches a vertex position becomes NaN-sized
    // geometry and wedges the GPU process; it looks like Chrome hanging, not
    // like a shader bug. Zero distance, zero radius and a zero-width rope are
    // all reachable (camera inside the rig, a rope collapsed by a mast break).
    const cases = [0, -0, 1e-12, Number.MIN_VALUE];
    for (const width of cases) {
      const { widen, alpha, drawnWidthPx } = phoneWire(width, P);
      for (const v of [widen, alpha, drawnWidthPx, farness(width, P), perceivedWidthPx(width, P)]) {
        expect(Number.isFinite(v), `width ${width}`).toBe(true);
      }
      expect(alpha).toBeGreaterThanOrEqual(0);
    }
    expect(Number.isFinite(projectedWidthPx(0.04, 0, 1080, 1))).toBe(true);
    expect(Number.isFinite(projectedWidthPx(0, 100, 1080, 0))).toBe(true);
  });
});
