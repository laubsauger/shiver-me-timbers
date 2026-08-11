/**
 * §V.34 caustic math. These tests exist because every one of them guards a
 * way this feature ships silently wrong on the GPU:
 *  - Snell at the wrong eta → caustics that do not track the sun (the whole
 *    point of the feature vs a scrolling texture).
 *  - the depth polynomial not actually being the ray-footprint Jacobian →
 *    a pattern that is merely noise-shaped, so it is checked against a
 *    brute-force trace of the same surface.
 *  - the 1/det fold clamp → §B.5-class NaN/firefly wedge.
 *  - flat water not mapping to "add nothing" → a uniform wash on every
 *    receiver instead of a caustic.
 */
import { describe, expect, it } from 'vitest';
import {
  MIN_VERTICAL,
  absorptionTint,
  airToWaterEta,
  bounceWeight,
  causticGain,
  causticResponse,
  depthAttenuation,
  foldSoftness,
  jacobianAtDepth,
  normalFromSlope,
  rayJacobian,
  reflect,
  reflectedDrift,
  refract,
  refractedDrift,
  surfaceStretch,
  wetness,
  type Vec2,
  type Vec3,
} from '../src/caustics/causticsMath';
import { HullWetline, dryStep } from '../src/caustics/hullWetline';
import { causticsParams } from '../src/params/caustics';

const IOR = 1.333;
const ETA = airToWaterEta(IOR);

describe('Snell refraction at the air/water interface (§V.34)', () => {
  it('sends a vertical sun ray straight down through flat water', () => {
    const d = refractedDrift([0, 1, 0], 0, 0, ETA);
    expect(d.valid).toBe(1);
    expect(d.drift[0]).toBeCloseTo(0, 12);
    expect(d.drift[1]).toBeCloseTo(0, 12);
    expect(d.vertical).toBeCloseTo(1, 12);
  });

  it('bends by exactly asin(sin θi / n) over a range of sun elevations', () => {
    for (const elevationDeg of [10, 25, 40, 60, 80]) {
      const e = (elevationDeg * Math.PI) / 180;
      // sun in the +x/+y plane; incident angle from vertical = 90° − elevation
      const sun: Vec3 = [Math.cos(e), Math.sin(e), 0];
      const thetaI = Math.PI / 2 - e;
      const thetaT = Math.asin(Math.sin(thetaI) / IOR);

      const d = refractedDrift(sun, 0, 0, ETA);
      // drift is lateral travel per metre of depth = tan(refracted angle)
      expect(Math.hypot(...d.drift)).toBeCloseTo(Math.tan(thetaT), 10);
      // and it leans AWAY from the sun's azimuth (light travels +x→−x here)
      expect(d.drift[0]).toBeLessThan(0);
    }
  });

  it('never total-internal-reflects going air → water (k > 0 always)', () => {
    for (let i = 0; i < 200; i++) {
      const a = (i / 200) * Math.PI * 2;
      const sun: Vec3 = [Math.cos(a) * 0.999, 0.045, Math.sin(a) * 0.999];
      const t = refract([-sun[0], -sun[1], -sun[2]], [0, 1, 0], ETA);
      expect(Number.isFinite(t[0] + t[1] + t[2])).toBe(true);
      expect(t[1]).toBeLessThan(0); // still travelling downward
    }
  });

  it('yields no caustic when the sun is behind the local wave face', () => {
    // sun low in +x; slope +4 tilts the normal to −x, i.e. AWAY from the sun
    expect(normalFromSlope(4, 0)[0]).toBeLessThan(0);
    const away = refractedDrift([0.9, 0.2, 0], 4.0, 0, ETA);
    expect(away.valid).toBe(0);
    expect(away.drift).toEqual([0, 0]);
    // the same steep face turned toward the sun still refracts
    expect(refractedDrift([0.9, 0.2, 0], -4.0, 0, ETA).valid).toBe(1);
    // and the reflected (above-water) branch gates on the same face test
    expect(reflectedDrift([0.9, 0.2, 0], 4.0, 0).valid).toBe(0);
  });

  it('floors the vertical component so 1/vertical can never blow up (§V.28)', () => {
    const d = refractedDrift([0.999, 0.03, 0], 0, 0, ETA);
    expect(d.vertical).toBeGreaterThanOrEqual(MIN_VERTICAL);
    const r = reflectedDrift([0.999, 0.03, 0], 0, 0);
    expect(r.vertical).toBeGreaterThanOrEqual(MIN_VERTICAL);
  });

  it('reflects the sun back up at the mirror angle on flat water', () => {
    const sun: Vec3 = [0.6, 0.8, 0];
    const r = reflect([-sun[0], -sun[1], -sun[2]], [0, 1, 0]);
    expect(r[0]).toBeCloseTo(-0.6, 12);
    expect(r[1]).toBeCloseTo(0.8, 12);
    const d = reflectedDrift(sun, 0, 0);
    expect(d.drift[0]).toBeCloseTo(-0.6 / 0.8, 10);
  });
});

describe('surface normal from the world-space slope', () => {
  it('is unit length and up-facing for any slope', () => {
    for (const [gx, gz] of [[0, 0], [0.4, -0.9], [-3, 5], [12, 12]] as Vec2[]) {
      const n = normalFromSlope(gx, gz);
      expect(Math.hypot(...n)).toBeCloseTo(1, 12);
      expect(n[1]).toBeGreaterThan(0);
    }
  });
});

/**
 * The load-bearing test. Build an analytic wave, trace where its refracted
 * rays actually land, and check the closed-form depth polynomial reproduces
 * the traced footprint area. If this passes, the caustic really is derived
 * from surface curvature and not from a plausible-looking noise field.
 */
describe('depth polynomial == real refracted-ray footprint Jacobian', () => {
  const amp = 0.22;
  const k = 2 * Math.PI / 5.5; // 5.5 m wave
  const sun: Vec3 = [0.35, 0.87, 0.35];
  const sunN: Vec3 = (() => {
    const l = Math.hypot(...sun);
    return [sun[0] / l, sun[1] / l, sun[2] / l];
  })();

  // h(x,z) = a·sin(kx)·cos(0.7kz) — curvature in both axes, no choppy stretch
  const height = (x: number, z: number) => amp * Math.sin(k * x) * Math.cos(0.7 * k * z);
  const grad = (x: number, z: number): Vec2 => [
    amp * k * Math.cos(k * x) * Math.cos(0.7 * k * z),
    -amp * 0.7 * k * Math.sin(k * x) * Math.sin(0.7 * k * z),
  ];

  /** where the ray entering at (x,z) lands on a plane at y = −d0 */
  const land = (x: number, z: number, planeY: number): Vec2 => {
    const g = grad(x, z);
    const d = refractedDrift(sunN, g[0], g[1], ETA);
    const span = height(x, z) - planeY;
    return [x + d.drift[0] * span, z + d.drift[1] * span];
  };

  it('matches a numerically differentiated ray trace across the wave', () => {
    const planeY = -3.0;
    const h = 1e-4;
    for (const x of [0.0, 0.8, 1.7, 2.9, 4.1, 5.0]) {
      for (const z of [0.0, 1.3, 3.6]) {
        // numeric det ∂Q/∂u by central differences on the traced landings
        const qx1 = land(x + h, z, planeY);
        const qx0 = land(x - h, z, planeY);
        const qz1 = land(x, z + h, planeY);
        const qz0 = land(x, z - h, planeY);
        const m11 = (qx1[0] - qx0[0]) / (2 * h);
        const m21 = (qx1[1] - qx0[1]) / (2 * h);
        const m12 = (qz1[0] - qz0[0]) / (2 * h);
        const m22 = (qz1[1] - qz0[1]) / (2 * h);
        const numericDet = m11 * m22 - m12 * m21;

        // closed form: same FD step on the drift field, evaluated at depth
        const g = grad(x, z);
        const w = refractedDrift(sunN, g[0], g[1], ETA).drift;
        const wx1 = refractedDrift(sunN, ...grad(x + h, z), ETA).drift;
        const wz1 = refractedDrift(sunN, ...grad(x, z + h), ETA).drift;
        const driftDx: Vec2 = [(wx1[0] - w[0]) / h, (wx1[1] - w[1]) / h];
        const driftDz: Vec2 = [(wz1[0] - w[0]) / h, (wz1[1] - w[1]) / h];
        const { a11, a22 } = surfaceStretch(0, 0, 0); // no choppy displacement
        const j = rayJacobian(a11, a22, w, g, driftDx, driftDz);
        const closed = jacobianAtDepth(j, height(x, z) - planeY);

        expect(closed).toBeCloseTo(numericDet, 3);
      }
    }
  });

  it('predicts the ray density a brute-force trace actually produces', () => {
    // 1D slice: fire a dense fan of rays, histogram where they land, and
    // compare the measured density to |detA| / |det M| at the same point.
    const planeY = -4.5;
    const z = 0;
    const rays = 400000;
    const spanX = 5.5; // exactly one wavelength → periodic, no edge loss
    const bins = 220;
    const lo = -6;
    const hi = 12;
    const hist = new Float64Array(bins);
    for (let i = 0; i < rays; i++) {
      const x = (i / rays) * spanX;
      const q = land(x, z, planeY);
      const b = Math.floor(((q[0] - lo) / (hi - lo)) * bins);
      if (b >= 0 && b < bins) hist[b] += 1;
    }
    // expected density at a landing point, from the closed form at its origin
    const h = 1e-4;
    let compared = 0;
    let agreed = 0;
    for (let i = 0; i < 400; i++) {
      const x = (i / 400) * spanX;
      const g = grad(x, z);
      const w = refractedDrift(sunN, g[0], g[1], ETA).drift;
      const wx1 = refractedDrift(sunN, ...grad(x + h, z), ETA).drift;
      const driftDx: Vec2 = [(wx1[0] - w[0]) / h, (wx1[1] - w[1]) / h];
      const j = rayJacobian(1, 1, w, g, driftDx, [0, 0]);
      // 1D: the z axis is untouched, so det reduces to the x stretch
      const stretch = 1 + w[0] * g[0] + (height(x, z) - planeY) * driftDx[0];
      const predicted = 1 / Math.abs(stretch);

      const q = land(x, z, planeY);
      const b = Math.floor(((q[0] - lo) / (hi - lo)) * bins);
      if (b < 1 || b >= bins - 1) continue;
      // measured density, normalised to rays-per-unit-x of the source fan
      const binWidth = (hi - lo) / bins;
      const measured = (hist[b] / rays) * (spanX / binWidth);
      // skip fold neighbourhoods where a bin legitimately holds >1 sheet
      if (predicted > 4) continue;
      compared++;
      if (Math.abs(measured - predicted) < 0.35 + 0.35 * predicted) agreed++;
      // the polynomial and the 1D reduction must agree exactly regardless
      expect(jacobianAtDepth(j, height(x, z) - planeY)).toBeCloseTo(stretch, 9);
    }
    expect(compared).toBeGreaterThan(200);
    expect(agreed / compared).toBeGreaterThan(0.9);
  });

  it('focuses somewhere: a real fold exists under a real wave', () => {
    // there must be depths where det M crosses zero, or the whole feature is
    // a flat multiply and nothing ever brightens
    let sawFold = false;
    const h = 1e-4;
    for (let i = 0; i < 200; i++) {
      const x = (i / 200) * 5.5;
      const g = grad(x, 0);
      const w = refractedDrift(sunN, g[0], g[1], ETA).drift;
      const wx1 = refractedDrift(sunN, ...grad(x + h, 0), ETA).drift;
      const wz1 = refractedDrift(sunN, ...grad(x, h), ETA).drift;
      const j = rayJacobian(
        1, 1, w, g,
        [(wx1[0] - w[0]) / h, (wx1[1] - w[1]) / h],
        [(wz1[0] - w[0]) / h, (wz1[1] - w[1]) / h],
      );
      let prev = jacobianAtDepth(j, 0);
      for (let d = 0.25; d <= 20; d += 0.25) {
        const cur = jacobianAtDepth(j, d);
        if (prev * cur < 0) sawFold = true;
        prev = cur;
      }
    }
    expect(sawFold).toBe(true);
  });
});

describe('fold clamp (§V.28 — 1/det is +∞ exactly where we want it)', () => {
  it('stays finite and bounded sweeping det M through zero', () => {
    const sigma = 0.16;
    for (let d = -1; d <= 1; d += 0.005) {
      const g = causticGain(1, d, sigma);
      expect(Number.isFinite(g)).toBe(true);
      expect(g).toBeLessThanOrEqual(1 / sigma);
    }
    // the bound is exactly |detA|/σ, attained at the fold itself
    expect(causticGain(1, 0, sigma)).toBeCloseTo(1 / sigma, 12);
  });

  it('peaks AT the fold, not beside it — the bright ridge is the caustic', () => {
    const sigma = 0.2;
    expect(causticGain(1, 0, sigma)).toBeGreaterThan(causticGain(1, 0.3, sigma));
    expect(causticGain(1, 0, sigma)).toBeGreaterThan(causticGain(1, -0.3, sigma));
  });

  it('is symmetric across the fold: both sheets light up', () => {
    expect(causticGain(1, 0.4, 0.2)).toBeCloseTo(causticGain(1, -0.4, 0.2), 12);
  });

  it('softens with depth, so deep caustics are broader and dimmer', () => {
    const p = causticsParams;
    const shallow = foldSoftness(p.foldSoftness, p.foldSoftnessPerMeter, 1);
    const deep = foldSoftness(p.foldSoftness, p.foldSoftnessPerMeter, 15);
    expect(deep).toBeGreaterThan(shallow);
    expect(causticGain(1, 0, deep)).toBeLessThan(causticGain(1, 0, shallow));
  });

  it('never produces NaN from a degenerate surface (§B.5 class)', () => {
    for (const bad of [0, -0, 1e-30, -1e-30]) {
      expect(Number.isFinite(causticGain(bad, bad, 0))).toBe(true);
    }
  });
});

describe('caustic response curve', () => {
  it('adds NOTHING on flat water — gain 1 must map to 0', () => {
    // the invariant that stops caustics being a uniform wash on every receiver
    expect(causticResponse(1, 3, 0.5)).toBe(0);
  });

  it('caps the bright lobe below maxGain however hard it focuses', () => {
    for (const g of [2, 5, 50, 1e6]) {
      expect(causticResponse(g, 3.2, 0.5)).toBeLessThan(3.2);
    }
    expect(causticResponse(1e6, 3.2, 0.5)).toBeGreaterThan(3.0);
  });

  it('keeps a scaled dark lobe where rays diverge', () => {
    expect(causticResponse(0.5, 3, 1)).toBeCloseTo(-0.5, 12);
    expect(causticResponse(0.5, 3, 0)).toBeCloseTo(0, 12);
    expect(causticResponse(0.5, 3, 0.4)).toBeCloseTo(-0.2, 12);
  });

  it('is monotone in gain', () => {
    let prev = -Infinity;
    for (let g = 0; g < 8; g += 0.05) {
      const v = causticResponse(g, 3.2, 0.45);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });
});

describe('depth attenuation and absorption', () => {
  it('is 1 at the surface and decays monotonically with depth', () => {
    expect(depthAttenuation(0, 1, 0.11)).toBeCloseTo(1, 12);
    let prev = 1.0001;
    for (let d = 0; d < 30; d += 0.5) {
      const a = depthAttenuation(d, 1, 0.11);
      expect(a).toBeLessThan(prev);
      prev = a;
    }
  });

  it('attenuates MORE for a slanted ray than a vertical one at equal depth', () => {
    // low sun → longer path through the same depth of water
    expect(depthAttenuation(5, 0.4, 0.2)).toBeLessThan(depthAttenuation(5, 1, 0.2));
  });

  it('loses red first, which is what reads as "underwater"', () => {
    const p = causticsParams;
    const density: Vec3 = [
      p.submergedAbsorptionR,
      p.submergedAbsorptionG,
      p.submergedAbsorptionB,
    ];
    const t = absorptionTint(3, density, p.submergedPathScale);
    expect(t[0]).toBeLessThan(t[1]);
    expect(t[1]).toBeLessThan(t[2]);
    expect(t.every((c) => c > 0 && c <= 1)).toBe(true);
    expect(absorptionTint(0, density, p.submergedPathScale)).toEqual([1, 1, 1]);
  });
});

describe('water bounce fill (the sea lighting the ship)', () => {
  it('favours downward-facing surfaces — that is where the sea is visible', () => {
    expect(bounceWeight(-1, 0, 7)).toBeCloseTo(1, 12);
    expect(bounceWeight(0, 0, 7)).toBeCloseTo(0.5, 12);
    expect(bounceWeight(1, 0, 7)).toBeCloseTo(0, 12);
  });

  it('dies off going up the rig, so a mast top is not lit like a waterline', () => {
    expect(bounceWeight(-1, 25, 7)).toBeLessThan(0.05);
    expect(bounceWeight(-1, 1, 7)).toBeGreaterThan(bounceWeight(-1, 10, 7));
  });
});

describe('waterline wetness band', () => {
  const p = causticsParams;
  const wet = (d: number) => wetness(d, p.wetBandAbove, p.wetBandBelow);

  it('is dry well above the line and fully wet below it', () => {
    expect(wet(-3)).toBe(0);
    expect(wet(-p.wetBandAbove)).toBe(0);
    expect(wet(p.wetBandBelow)).toBe(1);
    expect(wet(10)).toBe(1);
  });

  it('reaches above the waterline — the lapping/spray band the user asked for', () => {
    expect(p.wetBandAbove).toBeGreaterThan(0);
    expect(wet(-p.wetBandAbove * 0.4)).toBeGreaterThan(0);
  });

  it('is monotone, so the hull never shows a dry ring inside a wet one', () => {
    let prev = -1;
    for (let d = -2; d < 2; d += 0.01) {
      const v = wet(d);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('choppy stretch reuses the FFT derivative channels (§V.34)', () => {
  it('is the identity on an unstretched surface', () => {
    const s = surfaceStretch(0.95, 0, 0);
    expect(s.detA).toBeCloseTo(1, 12);
  });

  it('folds negative exactly where the foam Jacobian does (§V.6 shared term)', () => {
    // ∂Dx/∂x = −1/λ is the classic Tessendorf fold; det A crosses zero there
    const s = surfaceStretch(0.95, -1 / 0.95, 0.1);
    expect(s.detA).toBeCloseTo(0, 10);
    expect(surfaceStretch(0.95, -2 / 0.95, 0.1).detA).toBeLessThan(0);
  });
});

describe('hull wetline drying memory ("where the water LAPPED")', () => {
  const RATE = 0.22;

  it('wets instantly on contact — timber darkens the moment the sea touches it', () => {
    expect(dryStep(-Infinity, 1.4, RATE, 1 / 60)).toBe(1.4);
    expect(dryStep(0.2, 1.4, RATE, 1 / 60)).toBe(1.4);
  });

  it('holds the HIGHEST recent contact, not the current one', () => {
    // the whole point: a passing trough must not reset the band
    let w = dryStep(-Infinity, 1.5, RATE, 0.016);
    w = dryStep(w, 0.1, RATE, 0.016); // trough drops away
    expect(w).toBeGreaterThan(1.4);
    expect(w).toBeLessThan(1.5);
  });

  it('dries from the top down at a constant rate, so the band shrinks', () => {
    let w = 1.5;
    const samples: number[] = [];
    for (let i = 0; i < 120; i++) {
      w = dryStep(w, -10, RATE, 1 / 60);
      samples.push(w);
    }
    // 2 s of drying at 0.22 m/s
    expect(samples[samples.length - 1]).toBeCloseTo(1.5 - RATE * 2, 6);
    // strictly monotone — no flicker back up
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeLessThan(samples[i - 1]);
    }
  });

  it('is frame-rate independent over the same elapsed time', () => {
    let a = 1.0;
    for (let i = 0; i < 60; i++) a = dryStep(a, -10, RATE, 1 / 60);
    let b = 1.0;
    for (let i = 0; i < 240; i++) b = dryStep(b, -10, RATE, 1 / 240);
    expect(a).toBeCloseTo(b, 9);
  });

  it('clamps a stalled frame so an alt-tab cannot dry the hull instantly', () => {
    expect(dryStep(1.0, -10, RATE, 30)).toBeGreaterThan(1.0 - RATE * 0.3);
  });

  it('absorbs non-finite input rather than poisoning the texture (§V.28)', () => {
    expect(Number.isFinite(dryStep(NaN, 0.5, RATE, 0.016))).toBe(true);
    expect(dryStep(1.0, NaN, RATE, 0.016)).toBeCloseTo(1.0 - RATE * 0.016, 9);
    expect(dryStep(1.0, -10, NaN, 0.016)).toBe(1.0);
  });

  it('lags the sea: the band never follows a trough down', () => {
    // This is the difference between "wet where the water IS" (a rigid ring
    // that snaps down with every trough) and "wet where the water LAPPED".
    const period = 5;
    const amp = 0.9;
    const sea = (t: number) => amp * Math.sin((2 * Math.PI * t) / period);
    let w = -Infinity;
    let maxLag = 0;
    for (let i = 0; i < 360; i++) {
      const t = i / 60;
      const prev = w;
      w = dryStep(w, sea(t), RATE, 1 / 60);
      if (t > period / 4) {
        // while the sea falls, the band may only creep down at the dry rate
        expect(w).toBeGreaterThanOrEqual(sea(t) - 1e-9);
        expect(prev - w).toBeLessThanOrEqual(RATE / 60 + 1e-9);
        maxLag = Math.max(maxLag, w - sea(t));
      }
    }
    // at the trough the band sits most of a wave height above the water
    expect(maxLag).toBeGreaterThan(amp);
  });
});

describe('wetline resampling of sea-physics hull stations', () => {
  // sea-physics/hullContact samples BOW-BIASED z slices (t^1.6 from the
  // stem). Index-matching those onto a uniform grid would bunch the entire
  // waterline into the forward third of the hull, so this must interpolate.
  const bowZ = 15;
  const sternZ = -15;
  const slices = 9;
  const bias = (i: number) => bowZ - (bowZ - sternZ) * Math.pow(i / (slices - 1), 1.6);
  const stations: { x: number; z: number }[] = [];
  for (let i = 0; i < slices; i++) {
    stations.push({ x: -2, z: bias(i) }, { x: 2, z: bias(i) });
  }

  it('reproduces a linear immersion ramp along the hull', () => {
    const w = new HullWetline({ bowZ, sternZ, stations: 16 });
    // immersion rising linearly from stern to bow — the interpolated grid
    // must recover that ramp, not the t^1.6 spacing of the source
    const depth = stations.map((s) => 0.5 + 0.02 * (s.z - sternZ));
    w.updateFromHullContact(1 / 60, stations, depth);
    for (let i = 0; i < w.stations; i++) {
      const expected = 0.5 + 0.02 * (w.stationZ(i) - sternZ);
      expect(w.wetHeight[i]).toBeCloseTo(expected, 4); // port
      expect(w.wetHeight[w.stations + i]).toBeCloseTo(expected, 4); // starboard
    }
  });

  it('keeps port and starboard independent — a heeled ship wets one side', () => {
    const w = new HullWetline({ bowZ, sternZ, stations: 12 });
    const depth = stations.map((s) => (s.x < 0 ? 1.2 : -0.4));
    w.updateFromHullContact(1 / 60, stations, depth);
    for (let i = 0; i < w.stations; i++) {
      expect(w.wetHeight[i]).toBeCloseTo(1.2, 4);
      expect(w.wetHeight[w.stations + i]).toBeCloseTo(-0.4, 4);
    }
  });

  it('holds the wet band after the sea drops away from the whole hull', () => {
    const w = new HullWetline({ bowZ, sternZ, stations: 8 });
    w.updateFromHullContact(1 / 60, stations, stations.map(() => 1.0));
    w.updateFromHullContact(1 / 60, stations, stations.map(() => -5.0));
    expect(w.wetHeight[0]).toBeGreaterThan(0.9);
    expect(w.wetHeight[0]).toBeLessThan(1.0);
  });

  it('never leaves a non-finite value in the uploaded texture (§V.28)', () => {
    const w = new HullWetline({ bowZ, sternZ, stations: 8 });
    // a NaN immersion from a degenerate tick must not poison the band
    w.updateFromHullContact(1 / 60, stations, stations.map(() => NaN));
    const data = w.texture.image.data as Float32Array;
    expect(data.every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe('params sanity (§V.16)', () => {
  it('registers every tunable and keeps the fade window ordered', () => {
    const p = causticsParams;
    expect(p.fadeEnd).toBeGreaterThan(p.fadeStart);
    expect(p.waterIor).toBeGreaterThan(1);
    expect(p.foldSoftness).toBeGreaterThan(0);
    expect(p.maxDepth).toBeGreaterThan(p.minEffectiveDepth);
    expect(p.curvatureEpsilon).toBeGreaterThan(22.7 / 512);
  });
});
