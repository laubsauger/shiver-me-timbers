import { expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { createVesselFx, wakeLoadRamp } from '../src/wake/vesselFx';
import { createBoatEffects } from '../src/sim-worker/fleet';
import { buildDeepVHull } from '../src/speedboat/hullMesh';
import { HullWater } from '../src/sea-physics/hullWater';

it('rival impact loads ramp by identity, release immediately, and restart when a slot returns', () => {
  const fx = createVesselFx({ scene: new THREE.Scene(), flowFoam: { wakeSim: null, setPropWash() {} } });
  fx.setVisible(false);
  const hero = { hw: new HullWater(buildDeepVHull()), state: createBoatEffects().pose, bowAhead: 6 };
  const boats = [createBoatEffects(), createBoatEffects()];
  const raw = Object.freeze({ x: 10, z: 0, fy: 60000, footprint: 1, depth: 0 });
  boats[0].wake.push(raw);
  boats[0].pose.position[0] = 10;
  boats[1].pose.position[0] = 20;
  boats[0].tick = boats[1].tick = 0;
  const rivals = { spec: { boats: 2 }, effects: (i: number) => boats[i] };
  const dt = 1 / 60;
  const first = wakeLoadRamp({ load: 0 }, raw.fy, dt) * raw.fy;
  const step = () => fx.tick({} as THREE.WebGPURenderer, hero, rivals, dt, { x: 0, y: 0, z: 0 });
  const loadAt = (x: number) => fx.others.find(b => b.x === x)!.samples.reduce((sum, q) => sum + q.fy, 0);
  try {
    step();
    expect(loadAt(10)).toBeCloseTo(first, 6);
    for (let k = 0; k < 30; k++) { boats[0].tick++; boats[1].tick++; step(); }
    expect(loadAt(10)).toBeGreaterThan(raw.fy * .99);
    // Swap nearest order and land the previously dry boat.
    boats[0].pose.position[0] = 30;
    boats[1].wake.push({ ...raw, x: 20 });
    step();
    expect(loadAt(20)).toBeCloseTo(first, 6);
    expect(loadAt(30)).toBeGreaterThan(raw.fy * .99);
    expect(raw.fy).toBe(60000); // Worker-owned records must not accumulate the ramp.
    boats[0].wake.length = 0;
    step();
    expect(loadAt(30)).toBe(0);
    boats[0].wake.push(raw);
    step();
    expect(loadAt(30)).toBeCloseTo(first, 6);
    boats[1].tick = -1;
    step();
    boats[1].tick = 50;
    step();
    expect(loadAt(20)).toBeCloseTo(first, 6);
    // A worker restart can reuse an active slot without an intervening -1.
    for (let k = 0; k < 8; k++) { boats[1].tick++; step(); }
    boats[1].tick = 0;
    step();
    expect(loadAt(20)).toBeCloseTo(first, 6);
  } finally { fx.dispose(); }
});

it('player contact reset starts a fresh impact ramp instead of retaining the pre-teleport load', async () => {
  const { WakeSim } = await import('../src/wake/wakeSim');
  const { WAKE_SPEEDBOAT_TIER } = await import('../src/wake/wakeCalibration');
  const sim = new WakeSim(WAKE_SPEEDBOAT_TIER);
  const fx = createVesselFx({ scene: new THREE.Scene(), flowFoam: { wakeSim: sim, setPropWash() {} } });
  fx.setVisible(false);
  const hero = { hw: new HullWater(buildDeepVHull()), state: createBoatEffects().pose, bowAhead: 6 };
  hero.state.velocity[2] = 25;
  const w = hero.hw.wake;
  w.count = 1;
  w.x[0] = w.z[0] = w.depth[0] = 0;
  w.sigma[0] = 1;
  w.fy[0] = 60000;
  const step = () => fx.tick({} as THREE.WebGPURenderer, hero, null, 1 / 60, { x: 0, y: 0, z: 0 });
  try {
    step();
    const first = sim.sources.data[2];
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(60000 / 4);
    for (let k = 0; k < 30; k++) step();
    expect(sim.sources.data[2]).toBeGreaterThan(59000);
    fx.resetContact();
    step();
    expect(sim.sources.data[2]).toBeCloseTo(first, 6);
    expect(w.fy[0]).toBe(60000);
  } finally { fx.dispose(); sim.dispose(); }
});
