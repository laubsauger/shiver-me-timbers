import { describe, expect, it } from 'vitest';
import { CpuOcean } from '../src/sea-physics/cpuOcean';
import { GRAVITY } from '../src/ocean/oceanMath';
import { oceanParams } from '../src/params/ocean';
import { seaPhysicsParams } from '../src/params/seaPhysics';

// Test-only access: expand the reference's phase table to one independently
// calculated frequency per mode, reproducing the original trig evaluation.
type Cascade = {
  n: number; domain: number; omega: Float32Array; phaseIndex: Uint32Array;
  phaseCos: Float64Array; phaseSin: Float64Array;
  height: Float32Array; head: Float32Array; dx: Float32Array; dz: Float32Array;
};
const cascades = (sea: CpuOcean) => (sea as unknown as { cascades: Cascade[] }).cascades;

function expandPhases(c: Cascade): void {
  const size = c.n * c.n;
  c.omega = new Float32Array(size);
  c.phaseIndex = Uint32Array.from({ length: size }, (_, i) => i);
  c.phaseCos = new Float64Array(size);
  c.phaseSin = new Float64Array(size);
  for (let z = 0; z < c.n; z++) for (let x = 0; x < c.n; x++) {
    const kx = (2 * Math.PI * (x - c.n / 2)) / c.domain;
    const kz = (2 * Math.PI * (z - c.n / 2)) / c.domain;
    c.omega[z * c.n + x] = Math.sqrt(GRAVITY * Math.hypot(kx, kz));
  }
}

function expectSameGrids(a: CpuOcean, b: CpuOcean): void {
  cascades(a).forEach((c, band) => {
    for (const field of ['height', 'head', 'dx', 'dz'] as const) {
      const other = cascades(b)[band][field];
      const bits = new Uint32Array(c[field].buffer);
      const otherBits = new Uint32Array(other.buffer);
      expect(bits.length === otherBits.length && bits.every((v, i) => v === otherBits[i]),
        `band ${band}, ${field}`).toBe(true);
    }
  });
}

describe('CPU ocean shared frequency phases', () => {
  it.each([7, 1337])('preserves every output bit through time jumps, seed %i', seed => {
    const ocean = { ...oceanParams, resolution: 128 };
    const sea = { ...seaPhysicsParams };
    const candidate = new CpuOcean(seed, ocean, sea);
    const reference = new CpuOcean(seed, ocean, sea);
    for (const c of cascades(reference)) expandPhases(c);
    for (const time of [0, 1 / 60, 0.5, 1000000, 100, -10]) {
      candidate.update(time);
      reference.update(time);
      expectSameGrids(candidate, reference);
    }
  });

  it('rebuilds frequency groups when mirror resolution changes', () => {
    const ocean = { ...oceanParams, resolution: 128 };
    const sea = { ...seaPhysicsParams };
    const candidate = new CpuOcean(11, ocean, sea);
    candidate.update(0);
    sea.mirrorResolution = 128;
    candidate.update(1);
    const reference = new CpuOcean(11, ocean, sea);
    for (const c of cascades(reference)) expandPhases(c);
    reference.update(1);
    expectSameGrids(candidate, reference);
  });
});
