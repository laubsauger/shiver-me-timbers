import { expect, it } from 'vitest';
import { WakeSolverCpu, WakeSourceBuffer, type HydroSample } from '../src/wake/wakeSolverMath';
import { createHollowRecord, hollowSamples, humpSamples } from '../src/wake/transomHollow';
import * as THREE from 'three/webgpu';
import { createVesselFx } from '../src/wake/vesselFx';
import { WakeSim } from '../src/wake/wakeSim';
import { SpeedboatTow } from '../src/wake/speedboatTow';
import { WAKE_SPEEDBOAT_TIER } from '../src/wake/wakeCalibration';
import type { HullWater } from '../src/sea-physics/hullWater';
import { createBoatEffects } from '../src/sim-worker/fleet';
import { FX_LEN, readBoatFx, writeBoatFx } from '../src/sim-worker/fx';

it.each([12, 18])('a %i m moving hollow retains a narrow raised closure after splatting', (length) => {
  const hollow = createHollowRecord();
  Object.assign(hollow, { length, width: 1.84, fwdX: 0, fwdZ: 1 });
  hollow.depths.set([0.3, 0.3, 0.28, 0.25, 0.2, 0.14, 0.08, 0.02]);
  const solver = new WakeSolverCpu({ n: 128, texel: 0.5 });
  const sources = new WakeSourceBuffer();
  // Exercise the evolved DRAWN surface, not just the sign of the input load.
  // At planing speed ζ = η + h_P follows the moving head locally; applying
  // physical-pressure signs to this explicit shape inverted both features.
  for (let tick = 0; tick < 180; tick++) {
    hollow.z = tick * 25 / 60;
    solver.setCenter(0, hollow.z - length / 2);
    sources.clear();
    const samples: HydroSample[] = [];
    hollowSamples(hollow, samples);
    humpSamples(hollow, 25, samples);
    for (const q of samples) sources.pushJet(q.x, q.z, q.fy, q.footprint, q.depth);
    solver.splat(sources);
    solver.step(1 / 60);
  }
  const height = (aft: number, lateral = 0) => {
    const i = Math.round(solver.gridU(lateral));
    const j = Math.round(solver.gridV(hollow.z - aft));
    return solver.surface[j * solver.n + i];
  };
  expect(height(3)).toBeLessThan(-0.05);
  // A 0.3 m hollow should retain at least 0.12 m of its nominal 0.18 m
  // closure height. A full-cell sigma diluted it to about 0.08–0.10 m.
  expect(height(length)).toBeGreaterThan(0.12);
  expect(Math.abs(height(length, 2 * hollow.width))).toBeLessThan(height(length) / 3);
  // Bounded feature, not a metre-scale wall introduced to win the sign test.
  expect(Math.abs(height(3))).toBeLessThan(0.3);
  expect(height(length)).toBeLessThan(0.3);
}, 15_000);

it('hero and rival hollows reach the signed solver channel without clamping or adding hull churn', () => {
  const tow = new SpeedboatTow(25);
  tow.advanceTo(150);
  const hw = (tow as unknown as { hw: HullWater }).hw;
  const sim = new WakeSim(WAKE_SPEEDBOAT_TIER);
  const fx = createVesselFx({ scene: new THREE.Scene(), flowFoam: { wakeSim: sim, setPropWash() {} } });
  fx.setVisible(false);
  const rival = createBoatEffects();
  rival.tick = 0;
  rival.pose.position = [...tow.pose.position];
  rival.pose.quaternion = [...tow.pose.quaternion];
  rival.pose.velocity = [...tow.pose.velocity];
  const record = new Float64Array(FX_LEN);
  writeBoatFx(hw, tow.pose, record, 0);
  readBoatFx(record, 0, rival.fx);
  // Give the rival's explicit hollow a separate lane, within the solver domain.
  rival.pose.position[2] += 8;
  rival.fx.hollow.z += 8;
  try {
    fx.tick({} as THREE.WebGPURenderer, { hw, state: tow.pose, bowAhead: 6 },
      { spec: { boats: 1 }, effects: () => rival }, 1 / 60,
      { x: tow.pose.position[0], y: 2, z: tow.pose.position[2] });
    expect(sim.vesselCount).toBe(2);
    for (const [index, hollow] of [fx.heroFx.hollow, rival.fx.hollow].entries()) {
      const expected: HydroSample[] = [];
      hollowSamples(hollow, expected);
      expect(expected.length).toBeGreaterThan(0);
      for (const q of expected) {
        let found = false;
        for (let k = 0; k < sim.sources.jetCount; k++) {
          const offset = k * 5;
          if (Math.abs(sim.sources.jetData[offset] - q.x) < 1e-6 && Math.abs(sim.sources.jetData[offset + 1] - q.z) < 1e-6) {
            expect(sim.sources.jetData[offset + 2]).toBeCloseTo(q.fy * sim.vessels[index].weight, 6);
            expect(sim.sources.jetData[offset + 2]).toBeLessThan(0);
            found = true;
          }
        }
        expect(found).toBe(true);
      }
    }
  } finally {
    fx.dispose();
    sim.dispose();
  }
});

it('a rival is culled whole when its signed transom shape crosses the solver boundary', () => {
  const sim = new WakeSim(WAKE_SPEEDBOAT_TIER);
  const pose = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 25] };
  const load = { x: 0, z: 0, fy: 1000, footprint: 1, depth: 0 };
  try {
    sim.tick(pose, [load], 6, 1 / 60);
    const shape = { ...load, x: sim.solver.centerX + sim.solver.domain, fy: -1000 };
    sim.tick(pose, [load], 6, 1 / 60, [], [{
      samples: [load], jets: [], lifts: [shape], x: 0, z: 0, vx: 0, vz: 25,
    }]);
    expect(sim.vesselCount).toBe(1);
    expect(sim.vesselsCulled).toBe(1);
    expect(sim.sources.jetCount).toBe(0);
  } finally { sim.dispose(); }
});
