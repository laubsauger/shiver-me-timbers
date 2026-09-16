import { expect, it } from 'vitest';
import { HullWater } from '../src/sea-physics/hullWater';
import type { Rigid6State } from '../src/sea-physics/rigidBody';
import { buildDeepVHull } from '../src/speedboat/hullMesh';

const dt = 1 / 60;
const hull = buildDeepVHull();
const state: Rigid6State = {
  position: [0, 0.2, 0], quaternion: [0, 0, 0, 1],
  velocity: [0, 0, 0], angularVelocity: [0, 0, 0],
};

it('a respawn starts new water-velocity history without discarding the current height sample', () => {
  const hw = new HullWater(hull);
  hw.samplePatch(() => 0, state, dt);
  expect(hw.patch.verticalVelocityAt(0, 0)).toBe(0);
  hw.samplePatch(() => 0.01, state, dt);
  expect(hw.patch.verticalVelocityAt(0, 0)).toBeCloseTo(0.6, 10);

  hw.resetMemory();
  expect(hw.patch.verticalVelocityAt(0, 0)).toBe(0);
  expect(hw.patch.heightAt(0, 0)).toBeCloseTo(0.01, 10);
  // An overlapping respawn patch must not compare its new water level with the old location/time.
  hw.samplePatch(() => 0.5, state, dt);
  expect(hw.patch.heightAt(0, 0)).toBeCloseTo(0.5, 10);
  expect(hw.patch.verticalVelocityAt(0, 0)).toBe(0);

  hw.samplePatch(() => 0.52, state, dt);
  expect(hw.patch.verticalVelocityAt(0, 0)).toBeCloseTo(1.2, 10);
});

it('repeated resets before the first sample still resume velocity on the second new sample', () => {
  const hw = new HullWater(hull);
  hw.resetMemory();
  hw.resetMemory();
  hw.samplePatch(() => 0.5, state, dt);
  expect(hw.patch.verticalVelocityAt(0, 0)).toBe(0);
  hw.samplePatch(() => 0.48, state, dt);
  expect(hw.patch.verticalVelocityAt(0, 0)).toBeCloseTo(-1.2, 10);
});
