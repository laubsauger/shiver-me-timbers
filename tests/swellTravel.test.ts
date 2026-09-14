import { expect, it } from 'vitest';
import { CpuOcean } from '../src/sea-physics/cpuOcean';
import { oceanParams } from '../src/params/ocean';
import { seaPhysicsParams } from '../src/params/seaPhysics';

// Measure travel from the evolving spatial field, not the spectrum's label.
it.each([0, Math.PI / 2, 2.3])('swell travels along authored direction %s', (direction) => {
  const sea = new CpuOcean(1337, { ...oceanParams, resolution: 256,
    amplitude: 0, swellAmplitude: 1, swellDirection: direction }, seaPhysicsParams);
  type Band = { height: Float32Array; domain: number; sample(a: Float32Array, x: number, z: number): number };
  const band = (sea as unknown as { cascades: Band[] }).cascades[0];
  sea.update(2);
  const before = band.height.slice();
  sea.update(2.05);
  let transport = 0, energy = 0;
  const dx = Math.cos(direction), dz = Math.sin(direction);
  for (let z = 0; z < band.domain; z += 13) for (let x = 0; x < band.domain; x += 13) {
    const gradient = (band.sample(before, x + dx, z + dz) - band.sample(before, x - dx, z - dz)) / 2;
    const derivative = (band.sample(band.height, x, z) - band.sample(before, x, z)) / 0.05;
    transport -= derivative * gradient;
    energy += gradient * gradient;
  }
  expect(energy).toBeGreaterThan(0.01);
  expect(transport / energy).toBeGreaterThan(1);
});
