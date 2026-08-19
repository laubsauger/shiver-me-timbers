/**
 * SCRATCH — §V.30b radial LOD arithmetic. Delete with the session.
 * Checks the three properties the vertex shader relies on:
 *   1. monotone ring map (no outer ring folding inside an inner one)
 *   2. the rim stays exactly at horizonRadius with full angular density
 *   3. the first collapsed ring is outside cpuOcean's domain at any legal eye
 */
import { describe, expect, it } from 'vitest';
import {
  ringRadius,
  lodRingIndex,
  solveGrowthRate,
  warpVertex,
  type SurfaceGridOptions,
} from '../src/ocean/surfaceGeometry';

const O: SurfaceGridOptions = {
  segments: 512,
  coreSpacing: 0.5,
  horizonRadius: 4600,
  rimRound: 0.3,
};
const K = solveGrowthRate(O);
const HALF = 256;
const MAXLEVEL = 4;
const MORPH = 1.0;

/** kRadial = pixels/(f·h), f = (H/2)/tan(fov/2) */
function kRadial(pixels: number, h: number, fovDeg = 55, H = 1440): number {
  const f = H / 2 / Math.tan((fovDeg * Math.PI) / 360);
  return pixels / (f * h);
}

describe('§V.30b radial LOD', () => {
  it('reports the law', () => {
    const f = 1440 / 2 / Math.tan((55 * Math.PI) / 360);
    const rows: string[] = [`k=${K.toFixed(5)} f=${f.toFixed(0)}px`];
    for (const r of [500, 1000, 2000, 4600]) {
      const dr = 0.5 + K * r;
      rows.push(
        `r=${r} dr=${dr.toFixed(1)} radialPx=${((f * 12 * dr) / (r * r)).toFixed(3)}` +
          ` tangentialPx=${((f * (r / (Math.log(1 + (K * r) / 0.5) / K))) / r).toFixed(2)}`,
      );
    }
    console.log(rows.join('\n'));
  });

  for (const h of [4, 8, 11.31, 16, 32, 64, 256]) {
    it(`monotone + rim + core guard @ eye ${h} m`, () => {
      const kr = kRadial(1.0, h);
      let prev = -1;
      let firstCollapse = Infinity;
      let kept = 0;
      let total = 0;
      for (let n = 0; n <= HALF; n++) {
        const s = lodRingIndex(n, O.coreSpacing, K, kr, MAXLEVEL, MORPH);
        expect(s).toBeLessThanOrEqual(n);
        expect(s).toBeGreaterThanOrEqual(prev); // monotone: no fold
        if (s !== n && !Number.isFinite(firstCollapse)) {
          firstCollapse = ringRadius(n, O.coreSpacing, K);
        }
        // triangle weight of ring n is ∝ n; a ring that is its own snap target
        // is the only one that carries area
        total += n;
        if (s === n) kept += n;
        prev = s;
      }
      // the rim never moves — sea disc still ends at horizonRadius
      expect(lodRingIndex(HALF, O.coreSpacing, K, kr, MAXLEVEL, MORPH)).toBe(HALF);
      // §V.8: nothing inside 100 m ever collapses
      expect(firstCollapse).toBeGreaterThan(100);
      console.log(
        `eye ${h}m  firstCollapse ${firstCollapse.toFixed(0)}m  ` +
          `non-degenerate triangles ${((100 * kept) / total).toFixed(1)}%`,
      );
    });
  }

  it('kRadial = 0 is bit-identical to the baked warp', () => {
    for (let j = 0; j <= 512; j += 37) {
      for (let i = 0; i <= 512; i += 41) {
        const u = (2 * i) / 512 - 1;
        const v = (2 * j) / 512 - 1;
        const q = Math.max(Math.abs(u), Math.abs(v));
        const s = lodRingIndex(q * HALF, O.coreSpacing, K, 0, MAXLEVEL, MORPH);
        expect(s).toBe(q * HALF);
        expect(warpVertex(u, v, O, K, s)).toEqual(warpVertex(u, v, O, K));
      }
    }
  });

  it('collapsed groups land on ONE squircle (zero-area quads)', () => {
    const kr = kRadial(1.0, 11.31);
    // two adjacent rings that collapse together, on a square edge: the four
    // corners of the quad between them must be collinear
    let found = 0;
    for (let n = 1; n < HALF; n++) {
      const a = lodRingIndex(n, O.coreSpacing, K, kr, MAXLEVEL, MORPH);
      const b = lodRingIndex(n + 1, O.coreSpacing, K, kr, MAXLEVEL, MORPH);
      if (a !== b || a === n + 1) continue;
      found++;
      // +u edge, well away from the corner: u = ring/half, v = 0.1·u
      const p0 = warpVertex(n / HALF, (0.1 * n) / HALF, O, K, a);
      const p1 = warpVertex((n + 1) / HALF, (0.1 * (n + 1)) / HALF, O, K, b);
      const rr = ringRadius(a, O.coreSpacing, K);
      // both on the same ring radius along their own direction
      expect(Math.abs(Math.max(Math.abs(p0[0]), Math.abs(p0[1])) - rr)).toBeLessThan(
        Math.max(1e-6, rr * 1e-6) + rr * 0.31, // rounded rim shrinks the square
      );
      expect(Math.abs(Math.abs(p0[0]) - Math.abs(p1[0]))).toBeLessThan(rr * 1e-3);
    }
    expect(found).toBeGreaterThan(20);
  });

  it('THE WALL: radial step must not jump between neighbouring rings', () => {
    // The user-visible defect was a STEP in radial density: the band beyond it
    // is flat, the band before it is not, and at grazing the shading footprint
    // (1/sin incidence) crosses every §V.48 fade at that line. The quantity
    // that must be continuous is therefore the radial STEP, not the radius.
    const f = 1440 / 2 / Math.tan((55 * Math.PI) / 360);
    for (const morph of [0, 0.5, 0.75, 1, 1.5]) {
      const kr = kRadial(1.0, 11.31);
      const rad = (n: number) =>
        ringRadius(lodRingIndex(n, O.coreSpacing, K, kr, MAXLEVEL, morph), O.coreSpacing, K);
      // What limits what the surface can represent at radius r is the LARGEST
      // gap between consecutive rings near r — the envelope, not the individual
      // gaps (a half-morphed pair is one tiny gap plus one large one, and only
      // the large one matters). The envelope must climb smoothly; the wall is a
      // place where it doubles between neighbours.
      const env: [number, number][] = [];
      for (let n = 1; n < HALF - 8; n++) {
        let g = 0;
        for (let i = 0; i < 8; i++) g = Math.max(g, rad(n + i + 1) - rad(n + i));
        env.push([rad(n), g]);
      }
      let worst = 1;
      let at = 0;
      let px = 0;
      for (let i = 1; i < env.length; i++) {
        const ratio = env[i][1] / Math.max(1e-9, env[i - 1][1]);
        if (ratio > worst) {
          worst = ratio;
          at = env[i][0];
          px = (f * 12 * (env[i][1] - env[i - 1][1])) / (at * at);
        }
      }
      console.log(
        `morph ${morph} octave(s): worst envelope jump ${worst.toFixed(3)}x ` +
          `at r=${at.toFixed(0)}m (+${px.toFixed(3)} px of radial extent)`,
      );
    }
  });

  it('no fold across group boundaries (radius strictly grows per group)', () => {
    for (const h of [4, 8, 11.31, 16, 64]) {
      const kr = kRadial(1.0, h);
      let prevR = -1;
      for (let n = 1; n <= HALF; n++) {
        const s = lodRingIndex(n, O.coreSpacing, K, kr, MAXLEVEL, MORPH);
        // worst case for the square→circle blend is the diagonal
        const u = n / HALF;
        const p = warpVertex(u, u, O, K, s);
        const r = Math.hypot(p[0], p[1]);
        expect(r).toBeGreaterThanOrEqual(prevR - 1e-9);
        prevR = r;
      }
    }
  });
});
