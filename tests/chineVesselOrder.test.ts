import { expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { createVesselFx } from '../src/wake/vesselFx';
import type { ChineSheetEmitter } from '../src/wake/chineContact';
import { createBoatEffects } from '../src/sim-worker/fleet';
import { buildDeepVHull } from '../src/speedboat/hullMesh';
import { HullWater } from '../src/sea-physics/hullWater';

it('camera ordering and missing rival slots cannot transfer contact age between boats', () => {
  let sheets: readonly ChineSheetEmitter[] = [];
  const fx = createVesselFx({ scene: new THREE.Scene(), flowFoam: {
    wakeSim: null, setPropWash() {}, setChineSheets(e) { sheets = e.slice(); },
  } });
  fx.setVisible(false);
  const hero = { hw: new HullWater(buildDeepVHull()), state: createBoatEffects().pose, bowAhead: 6 };
  const boats = [createBoatEffects(), createBoatEffects()];
  for (const b of boats) {
    b.tick = 0;
    b.pose.velocity[2] = 10;
    Object.assign(b.fx.bow, { inContact: true, flux: 0.1, launch: 2, halfWidth: 1 });
  }
  boats[0].pose.position[0] = 10;
  boats[1].pose.position[0] = 20;
  boats[1].fx.bow.inContact = false;
  const rivals = { spec: { boats: 2 }, effects: (i: number) => boats[i] };
  // No solver and hidden particle pools: no GPU calls are needed for this tick boundary.
  const renderer = {} as THREE.WebGPURenderer;
  try {
    fx.tick(renderer, hero, rivals, 1 / 60, { x: 0, y: 0, z: 0 });
    boats[0].tick = boats[1].tick = 60;
    boats[0].pose.position[0] = 30;
    boats[1].fx.bow.inContact = true;
    fx.tick(renderer, hero, rivals, 1 / 60, { x: 0, y: 0, z: 0 });
    expect(sheets[1].bow).toBe(boats[1].fx.bow);
    expect(sheets[1].front).toBe(0);
    expect(sheets[2].front).toBe(10);
    boats[0].tick = -1;
    boats[1].tick = 61;
    fx.tick(renderer, hero, rivals, 1 / 60, { x: 0, y: 0, z: 0 });
    expect(sheets).toHaveLength(2);
    expect(sheets[1].front).toBeCloseTo(1 / 6);
    boats[0].tick = 62;
    fx.tick(renderer, hero, rivals, 1 / 60, { x: 0, y: 0, z: 0 });
    expect(sheets[2].front).toBe(0);
  } finally { fx.dispose(); }
});
