/**
 * §T.78 FINISH — "the bow wake displacement is a bit chunky and sharp edged"
 * (user, in-game, after §T.82 made the wake visible as displacement).
 *
 * Rasterised, the CPU field (= the GPU field, §V.8) had four hard edges, none
 * of them in the cos carrier:
 *
 *   1. the transverse train's lateral envelope was `1 − smoothstep(0.75·kelvin,
 *      kelvin, |y|)` with kelvin = d·tan19.47°: ZERO wide at the cutwater, so
 *      the full a/k (0.5 m at 10 m/s) sat on a 0.13 m sliver (a needle,
 *      |∇η| = 1.48), and 0.088·d wide along the wedge (a 0.5 m cliff over
 *      0.9 m at d = 10 — an envelope 3–10× steeper than the wave inside it);
 *   2. the stationary phase was written (d + |y|t)√(1+t²): NOT stationary in
 *      t, so ∇φ carried (∂φ/∂t)·∇t with ∇t's √ singularity at the cusp —
 *      |∇φ|/k measured 28 at r = 0.353 — a crease along the whole wedge edge,
 *      and crests bowing the wrong way;
 *   3. the shed eddies switched on over the foam's 3 m `sternOnset`: a 0.4 m
 *      dimple in 3 m, twice its own face slope, a step behind the transom;
 *   4. the bow mound's chevron crest line used |side|: a C⁰ fold down the
 *      centreline ahead of the stem, 0.27 of slope jump.
 *
 * These pin the PROPERTIES (§V.80): the envelope's gradient is bounded by the
 * wave's own, the phase is stationary (|∇φ| = k) over the wedge, nothing steps
 * at the transom or the wedge edge, and the stem carries no needle.
 */
import { describe, expect, it } from 'vitest';
import {
  GRAVITY,
  KELVIN_R_MAX,
  RIDGE_PEAK,
  bowSlopeCpu,
  kelvinBranchesCpu,
  kelvinPhaseCpu,
  slickFieldCpu,
  transverseWavelengthCpu,
} from '../src/flowfoam/slickMath';
import type { TrackSample } from '../src/flowfoam/wakeTrack';
import { flowFoamParams } from '../src/params/flowfoam';

const HULL = { length: 38.5, beam: 8.5 };
const TEXEL = flowFoamParams.regionSize / flowFoamParams.resolution;
const P = flowFoamParams;
/** the train alone — the bound under test is ITS envelope's */
const TRAIN = { ...P, moundSlope: 0, eddySlope: 0, divSlope: 0 };

/** a straight track laid at `speed`, head at the origin pointing +z */
function straightTrack(speed: number, length = 160): TrackSample[] {
  const pts: TrackSample[] = [];
  for (let d = 0; d <= length; d += P.trackSpacing)
    pts.push({ x: 0, z: -d, fx: 0, fz: 1, speed, age: d / speed, dist: d });
  return pts;
}

/** the whole drawn field (train + street + mound) at a world point, true surface */
function eta(pts: TrackSample[], speed: number, x: number, z: number, p = P): number {
  const odo = 160 % p.vortexSpacing;
  return (
    slickFieldCpu(pts, x, z, HULL, p, speed, TEXEL, odo, 0).elev +
    bowSlopeCpu(pts[0], x, z, speed, p, TEXEL, 0).elev
  );
}

/** |∇η| by central difference over one texel */
function grad(pts: TrackSample[], speed: number, x: number, z: number, p = P): number {
  const h = TEXEL / 2;
  const gx = (eta(pts, speed, x + h, z, p) - eta(pts, speed, x - h, z, p)) / (2 * h);
  const gz = (eta(pts, speed, x, z + h, p) - eta(pts, speed, x, z - h, p)) / (2 * h);
  return Math.hypot(gx, gz);
}

/**
 * The envelope's own slope bound: a smoothstep feather `transFeather·λ` wide
 * on an amplitude a/k has peak gradient (a/k)·1.5/(transFeather·λ) =
 * a·1.5/(2π·transFeather). Plus the carrier's own a. This is the number the
 * params comment promises — 1.5× the crest slope at the shipped 0.16.
 */
const ENVELOPE_BOUND = P.transSlope * (1 + 1.5 / (2 * Math.PI * P.transFeather));

describe('§T.78 the phase is STATIONARY, so the wedge edge is not a crease', () => {
  it('|∇φ| = (g/v²)(1+t²) = k over the whole wedge, to 1e-6, on both branches', () => {
    // The elevation derivation (η = −(a/k)cos φ ⟹ ∇η = a·sin φ·dir̂) assumes
    // exactly this. With the + sign it held on the centreline only and ran
    // to 28× k at the cusp — the crease the user saw along the bow wave.
    const v = 7;
    const k0 = GRAVITY / (v * v);
    for (const r of [0.02, 0.1, 0.2, 0.3, 0.34, 0.35, 0.3535]) {
      const d = 40;
      const y = r * d;
      const h = 1e-4;
      for (const branch of ['tT', 'tD'] as const) {
        const phi = (dd: number, yy: number) => kelvinPhaseCpu(dd, yy, kelvinBranchesCpu(yy / dd)[branch], v);
        const gx = (phi(d + h, y) - phi(d - h, y)) / (2 * h);
        const gy = (phi(d, y + h) - phi(d, y - h)) / (2 * h);
        const t = kelvinBranchesCpu(r)[branch];
        const k = k0 * (1 + t * t);
        expect(Math.hypot(gx, gy) / k).toBeCloseTo(1, 5);
        // and the propagation is aft and INWARD — the sign the solve belongs to
        expect(gx).toBeGreaterThan(0);
        expect(gy).toBeLessThan(0);
      }
    }
  });

  it('the transverse branch is held at the cusp outside the wedge, continuously', () => {
    const inside = kelvinBranchesCpu(KELVIN_R_MAX * (1 - 1e-9)).tT;
    const outside = kelvinBranchesCpu(KELVIN_R_MAX * 1.5).tT;
    expect(inside).toBeCloseTo(Math.SQRT1_2, 4);
    expect(outside).toBe(Math.SQRT1_2);
    // the divergent root is untouched by it
    expect(kelvinBranchesCpu(0.1).tD).toBeGreaterThan(1);
  });
});

describe('§T.78 the transverse envelope is no steeper than the wave it carries', () => {
  it.each([7, 10])('at %d m/s: max |∇η| over the 120×80 m window ≤ the envelope bound', (speed) => {
    const pts = straightTrack(speed);
    let worst = 0;
    let wx = 0;
    let wz = 0;
    for (let z = 6; z >= -100; z -= 0.5) {
      for (let x = -40; x <= 40; x += 0.5) {
        // the one place excluded, and why: under the hull's own footprint.
        // Inside the first 12 m the wedge is narrower than the beam, and
        // across it the LOCAL wavenumber goes k0 → 1.5·k0 (the cusp wave is
        // shorter), so a/k itself changes by a third within the wedge's
        // width — the dispersion relation, not an envelope, and the ocean
        // there is under the keel. Everywhere the surface is drawn, the bound.
        if (-z >= 0 && -z <= HULL.length && Math.abs(x) < HULL.beam / 2) continue;
        const g = grad(pts, speed, x, z, TRAIN);
        if (g > worst) {
          worst = g;
          wx = x;
          wz = z;
        }
      }
    }
    expect(worst, `at x=${wx} z=${wz}`).toBeLessThan(ENVELOPE_BOUND * 1.05);
    // and the field is not trivially flat (§V.62)
    expect(Math.abs(eta(pts, speed, 0, -transverseWavelengthCpu(speed) / 2, TRAIN))).toBeGreaterThan(0.1);
  });

  it('the whole drawn field (train + street + mound) is bounded by the sum of its parts', () => {
    const speed = 10;
    const pts = straightTrack(speed);
    let worst = 0;
    for (let z = 6; z >= -100; z -= 0.5)
      for (let x = -40; x <= 40; x += 0.5) {
        if (-z >= 0 && -z <= HULL.length && Math.abs(x) < HULL.beam / 2) continue;
        worst = Math.max(worst, grad(pts, speed, x, z));
      }
    // mound face + train (carrier + envelope) + two overlapping eddy cores;
    // the old field measured 1.48 here against this 0.49
    expect(worst).toBeLessThan(P.moundSlope + ENVELOPE_BOUND + 2 * P.eddySlope);
  });

  it('no needle at the cutwater: the stem row is as smooth as a texel apart allows', () => {
    // Before: η(0, −0.5) − η(0.25, −0.5) = 0.58 m — the full a/k on a half-texel
    // sliver. The hull's train starts the BEAM wide, so the lateral profile at
    // the stem varies by less than the envelope bound per metre.
    for (const speed of [7, 10]) {
      const pts = straightTrack(speed);
      const a = eta(pts, speed, 0.5, -0.5, TRAIN);
      const b = eta(pts, speed, 2.0, -0.5, TRAIN);
      expect(Math.abs(a - b)).toBeLessThan(ENVELOPE_BOUND * 1.5);
      // and it is the mound + train CREST that sits there, not a hole (§T.82)
      expect(eta(pts, speed, 0, -0.01, TRAIN)).toBeGreaterThan(0);
    }
  });

  it('the wedge edge is a feather, not a cut: η is continuous across r = 1/(2√2)', () => {
    const speed = 7;
    const pts = straightTrack(speed);
    for (const d of [10, 30, 60]) {
      const yc = d * KELVIN_R_MAX;
      const step = 0.05;
      const jump = Math.abs(eta(pts, speed, yc + step, -d, TRAIN) - eta(pts, speed, yc - step, -d, TRAIN));
      expect(jump).toBeLessThan(ENVELOPE_BOUND * 2 * step * 1.05);
    }
  });
});

describe('§T.78 nothing steps at the hull boundaries', () => {
  it('the shed eddies rise out of the transom no steeper than their own face', () => {
    // onset over three core radii (≈ one shedding period), not the foam's 3 m
    const speed = 7;
    const pts = straightTrack(speed);
    // decay OFF so the first core is compared against cores of its own size,
    // not against older, weaker ones — the ramp is what is under test
    const STREET = { ...P, moundSlope: 0, transSlope: 0, divSlope: 0, vortexDecay: 1e9 };
    const coreR = (HULL.beam / 2) * P.eddyRadius;
    let onsetMax = 0;
    let interiorMax = 0;
    for (let x = -8; x <= 8; x += 0.25) {
      for (let d = HULL.length - 1; d <= HULL.length + 3 * coreR + 1; d += 0.25)
        onsetMax = Math.max(onsetMax, grad(pts, speed, x, -d, STREET));
      for (let d = HULL.length + 3 * coreR + 1; d <= 100; d += 0.25)
        interiorMax = Math.max(interiorMax, grad(pts, speed, x, -d, STREET));
    }
    expect(interiorMax).toBeGreaterThan(0.01); // the street is there
    // a multiplicative ramp adds at most (core depth)·1.5/(3·coreR) to the
    // street's own gradient: 0.40 m · 1.5 / 11.5 m = 0.05. Before, over the
    // foam's 3 m, it added 0.2 — twice the street itself.
    const coreDepth = (P.eddySlope * coreR) / RIDGE_PEAK;
    expect(onsetMax).toBeLessThanOrEqual(interiorMax + (coreDepth * 1.5) / (3 * coreR));
    // and in practice the first core reads within 20% of the ones behind it
    // (measured 1.13×; over the old 3 m it was 2×)
    expect(onsetMax).toBeLessThanOrEqual(interiorMax * 1.2);
    // and the dimples start at the transom, not before it
    expect(eta(pts, speed, 0, -(HULL.length - 0.5), STREET)).toBe(0);
  });

  it('the bow mound has no fold down the centreline: ∇η is continuous through side = 0', () => {
    const speed = 7;
    const head = straightTrack(speed)[0];
    const MOUND = { ...P, transSlope: 0, eddySlope: 0, divSlope: 0 };
    for (const ahead of [0.5, 1.6, 3]) {
      const l = bowSlopeCpu(head, -0.02, ahead, speed, MOUND, TEXEL).slopeX;
      const r = bowSlopeCpu(head, 0.02, ahead, speed, MOUND, TEXEL).slopeX;
      const c = bowSlopeCpu(head, 0, ahead, speed, MOUND, TEXEL).slopeX;
      // a |side| chevron jumps by 2·moundSlope·moundSweep·(peak)/RIDGE_PEAK ≈ 0.27 here
      expect(Math.abs(l - r)).toBeLessThan(0.01);
      expect(Math.abs(c)).toBeLessThan(1e-9);
      // and the returned slope IS ∇η, still — the soft sign kept the identity
      const h = 1e-3;
      const fx = (bowSlopeCpu(head, h, ahead, speed, MOUND, TEXEL).elev - bowSlopeCpu(head, -h, ahead, speed, MOUND, TEXEL).elev) / (2 * h);
      const fz = (bowSlopeCpu(head, 0.7, ahead + h, speed, MOUND, TEXEL).elev - bowSlopeCpu(head, 0.7, ahead - h, speed, MOUND, TEXEL).elev) / (2 * h);
      const s = bowSlopeCpu(head, 0.7, ahead, speed, MOUND, TEXEL);
      expect(fx).toBeCloseTo(c, 6);
      expect(fz).toBeCloseTo(s.slopeZ, 5);
    }
  });
});
