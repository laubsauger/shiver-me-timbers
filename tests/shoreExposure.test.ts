import { expect, it } from 'vitest';
import { DataUtils } from 'three/webgpu';
import { shoreSamplingMap } from '../src/ocean/shoreSampling';
import { createFetchField } from '../src/ocean/fetchField';
import { oceanParams } from '../src/params/ocean';
import type { SeabedField } from '../src/island/seabed';

it('keeps offshore cells unchanged and maps every beach sample clear of land', () => {
  const size = 33, land = new Uint8Array(size * size);
  for (let z = 10; z <= 22; z++) for (let x = 10; x <= 22; x++) land[z * size + x] = 1;
  const map = shoreSamplingMap(land, size);
  expect(map[0]).toBe(0);
  expect(map[16 * size + 10] % size).toBeLessThan(10);
  expect(map[16 * size + 22] % size).toBeGreaterThan(22);
  for (const i of map) {
    const x = i % size, z = Math.floor(i / size);
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      if (Math.abs(dx) + Math.abs(dz) > 2) continue;
      const xx = x + dx, zz = z + dz;
      if (xx >= 0 && zz >= 0 && xx < size && zz < size) expect(land[zz * size + xx]).toBe(0);
    }
  }
});

it('rejects a shelter domain with no offshore water instead of inventing exposure', () => {
  expect(() => shoreSamplingMap(new Uint8Array(64).fill(1), 8)).toThrow('no offshore water');
});

it('exposed dry sand receives offshore swell; turning swell swaps the sheltered beach', () => {
  const p = { ...oceanParams, fetchFieldSize: 128, fetchFieldMargin: 1000,
    swellDirection: 0, windDirection: 0, fetchBlurTexels: 1 };
  const bed = { origin: [-1000, -1000], size: 2000,
    heightAt: (x: number, z: number) => Math.hypot(x, z) < 250 ? 3 : -30 } as unknown as SeabedField;
  const field = createFetchField(bed, p);
  const sample = (x: number) => {
    const ix = Math.floor((x - field.origin[0]) / field.texelSize);
    const iz = Math.floor(-field.origin[1] / field.texelSize);
    const data = field.texture.image.data as Uint16Array;
    return Array.from(data.slice((iz * 128 + ix) * 4, (iz * 128 + ix) * 4 + 4), DataUtils.fromHalfFloat);
  };
  try {
    const left = sample(-210), right = sample(210);
    expect(left[3]).toBeGreaterThan(0.8);
    expect(right[3]).toBeLessThan(left[3] * 0.8);
    expect(left[2]).toBeGreaterThan(left[0]);
    p.swellDirection = Math.PI;
    field.update(p.windDirection);
    expect(sample(210)[3]).toBeGreaterThan(0.8);
    expect(sample(-210)[3]).toBeLessThan(sample(210)[3] * 0.8);
    // Repacking exposure never changes the physical fetch channel.
    expect(sample(-210)[0]).toBe(left[0]);
    expect(sample(210)[0]).toBe(right[0]);
    const shadowAfterTurn = sample(210)[3];
    p.windDirection = Math.PI;
    field.update(p.windDirection);
    expect(sample(210)[2]).toBeGreaterThan(sample(-210)[2]);
    expect(sample(210)[3]).toBe(shadowAfterTurn);
  } finally { field.dispose(); }
});
