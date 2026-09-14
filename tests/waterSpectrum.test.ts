import { describe, expect, it } from 'vitest';
import { CpuOcean } from '../src/sea-physics/cpuOcean';
import { seaPhysicsParams } from '../src/params/seaPhysics';
import { oceanParams } from '../src/params/ocean';
import { SpectrumScheduler } from '../src/ocean/spectrumRebuild';
import { weatherPresets } from '../src/weather/presets';
import { createRng } from '../src/state/rng';

type Band = { height: Float32Array; head: Float32Array; n: number; domain: number;
  sample(grid: Float32Array, x: number, z: number): number };
const band = (sea: CpuOcean): Band => (sea as unknown as { cascades: Band[] }).cascades[1];

describe('wider chop without degrading the buoyancy mirror', () => {
  for (const name of ['calm', 'swell', 'storm'] as const) {
    it(`${name}: preserves height and pitch-forcing accuracy across seeds`, () => {
      const measurements = [];
      for (const seed of [7, 1337]) {
        const p = { ...oceanParams, ...weatherPresets[name].ocean, resolution: 256 };
        const scheduler = new SpectrumScheduler(seed, p);
        const sea = new CpuOcean(seed, p, seaPhysicsParams, scheduler);
        const reference = new CpuOcean(seed, p,
          { ...seaPhysicsParams, mirrorResolution: 256, mirrorChopResolution: 256 }, scheduler);
        const a = band(sea), b = band(reference);
        expect(a.n).toBe(128);
        expect(a.domain / a.n).toBe(98 / 64);
        let error = 0, energy = 0, pitchError = 0, pitchEnergy = 0;
        const rng = createRng(31);
        for (const time of [0.7, 5.8, 14.4]) {
          sea.update(time); reference.update(time);
          for (let i = 0; i < 400; i++) {
            const x = rng() * 1000, z = rng() * 1000;
            const h = b.sample(b.height, x, z);
            error += (a.sample(a.height, x, z) - h) ** 2;
            energy += h * h;
            // Pressure-head difference across 20 m measures the forcing that
            // pitches the hull, not merely surface height at one station.
            const tilt = (c: Band) => c.sample(c.head, x, z + 10) - c.sample(c.head, x, z - 10);
            const t = tilt(b);
            pitchError += (tilt(a) - t) ** 2;
            pitchEnergy += t * t;
          }
        }
        const heightRelative = Math.sqrt(error / energy);
        const pitchRelative = Math.sqrt(pitchError / pitchEnergy);
        measurements.push({ seed, heightRelative, pitchRelative });
        expect(energy).toBeGreaterThan(0.01);
        expect(heightRelative).toBeLessThan(0.04);
        expect(pitchRelative).toBeLessThan(0.04);
      }
      console.log(name, measurements);
    }, 180_000);
  }

  it('removes the exact 98 m copy on both axes', () => {
    for (const seed of [7, 1337]) {
      const p = { ...oceanParams, resolution: 256 };
      const sea = new CpuOcean(seed, p, seaPhysicsParams);
      sea.update(12.6);
      const a = band(sea);
      const correlations = [];
      for (const [dx, dz] of [[98, 0], [0, 98], [196, 0]]) {
        let ab = 0, aa = 0, bb = 0;
        for (let z = 0; z < 196; z += 3.7) for (let x = 0; x < 196; x += 3.7) {
          const h = a.sample(a.height, x, z), shifted = a.sample(a.height, x + dx, z + dz);
          ab += h * shifted; aa += h * h; bb += shifted * shifted;
        }
        correlations.push(ab / Math.sqrt(aa * bb));
      }
      expect(Math.abs(correlations[0])).toBeLessThan(0.6);
      expect(Math.abs(correlations[1])).toBeLessThan(0.6);
      expect(correlations[2]).toBeCloseTo(1, 8);
      console.log('middle-band spatial correlation', seed, correlations);
    }
  });
});
