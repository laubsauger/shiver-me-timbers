/**
 * §V110 THE PLAYER AND A RIVAL RIDE THE SAME SEA, WAVE FOR WAVE (§T.207; USER: "the NPC rivals … still have a different
 * resolution of the waves, which means they cut over all the waves that make me bounce around … It has to be the
 * same, deterministic for everyone, so they hop around exactly the same … otherwise we are just fucking up the whole
 * balance and timing").
 *
 * WHY: tests/speedboatParity compares top speed in CALM water, where a different sea barely shows. Here the player is
 * stepped exactly as the page steps her — `OceanSimulation.advanceSpectrum` then the page `CpuOcean` on the
 * simulation's OWN scheduler, `createPlayerBoat`, and the render's `OceanSimulation.update` on every frame — and a rival
 * with the SAME start pose and the SAME controls through the page's fleet driver (the sim-worker core on its own mirror).
 * In the WORKING sea with a preset change mid-run, their trajectories must be bit-identical, at 60 and at 120 rendered
 * frames per second: any fidelity, parameter, spectrum-schedule or step difference between the two paths splits them.
 *
 * [M] before the fix (a frame with no tick stepped the page's spectrum schedule again): at 120 fps the two split 1 s
 * after the preset change (first differing tick 1221, 334 m apart by the end, heave std 1.30 vs 1.55 m); at 60 fps identical.
 */
import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../src/core/loop';
import { OceanSimulation } from '../src/ocean/oceanCascades';
import { oceanParams } from '../src/params/ocean';
import { CpuOcean } from '../src/sea-physics/cpuOcean';
import type { Rigid6State } from '../src/sea-physics/rigidBody';
import { buildDeepVHull } from '../src/speedboat/hullMesh';
import { SPAWN_CG_Y } from '../src/speedboat/page/course';
import { createNpcFleetDriver } from '../src/speedboat/page/npcFleet';
import { createPlayerBoat } from '../src/speedboat/page/playerBoat';
import { speedboatSeaParams } from '../src/speedboat/page/seaParams';
import type { ShipState } from '../src/state/simState';
import { weatherPresets } from '../src/weather/presets';

const SECONDS = 50;
const PRESET_AT = 60 * 20;
const stubRenderer = { compute: (): void => {} } as never;
const ctl = (k: number): { throttle: number; steer: number } => ({ throttle: Math.min(1, 0.3 + k / 600), steer: 0.12 * Math.sin(k / 240) });

interface Motion {
  firstDiffTick: number;
  maxApart: number;
  player: number[];
  rival: number[];
}

async function run(framesPerTick: number): Promise<Motion> {
  const hull = buildDeepVHull();
  const seed = 2100;
  const ocean = structuredClone(oceanParams); // shipped default = the Working sea ('swell')
  const seaParams = speedboatSeaParams(hull);
  const sim = new OceanSimulation(seed, ocean);
  const mirror = new CpuOcean(seed, ocean, seaParams, sim.spectrum); // core/seaScene.ts's wiring
  const start: Rigid6State = { position: [0, SPAWN_CG_Y, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] };
  const state = structuredClone(start) as unknown as ShipState;
  const player = createPlayerBoat({ hull, pressureHeadAt: (x, z, t) => mirror.pressureHeadAt(x, z, t) }, state);
  player.place(start);
  const npcs = await createNpcFleetDriver({
    seed, boats: 1, oceanParams: ocean, seaParams, spawn: () => start, controls: (_i, k) => ctl(k),
    caps: { crossOriginIsolated: false, sharedArrayBuffer: false, worker: false }, budgetMs: 1e6,
  });
  const out: Motion = { firstDiffTick: -1, maxApart: 0, player: [], rival: [] };
  let time = 0;
  try {
    for (let tick = 1; tick <= SECONDS * 60; tick++) {
      time += SIM_DT;
      if (tick === PRESET_AT) Object.assign(ocean, structuredClone(weatherPresets.squall.ocean));
      sim.advanceSpectrum(ocean); // seaFrame.tickSpectrum
      mirror.update(time);
      const c = ctl(tick);
      player.tick({ steer: c.steer, throttle: c.throttle, trim: 0, surge: false }, time);
      npcs.recordTick(tick, time);
      npcs.pump(tick);
      npcs.pump(tick);
      for (let f = 0; f < framesPerTick; f++) sim.update(stubRenderer, time, ocean); // the render's ocean update
      const r = npcs.pose(0);
      const apart = Math.hypot(r.position[0] - state.position[0], r.position[1] - state.position[1], r.position[2] - state.position[2]);
      out.maxApart = Math.max(out.maxApart, apart);
      const same = apart === 0 && r.quaternion.every((q, i) => q === state.quaternion[i]) && r.velocity.every((v, i) => v === state.velocity[i]);
      if (!same && out.firstDiffTick < 0) out.firstDiffTick = tick;
      out.player.push(state.position[1], state.quaternion[0], state.quaternion[2], Math.hypot(state.velocity[0], state.velocity[2]));
      out.rival.push(r.position[1], r.quaternion[0], r.quaternion[2], Math.hypot(r.velocity[0], r.velocity[2]));
    }
  } finally {
    npcs.dispose();
  }
  return out;
}

const std = (v: number[], k: number): number => {
  const s = v.filter((_, i) => i % 4 === k);
  const m = s.reduce((a, b) => a + b, 0) / s.length;
  return Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / s.length);
};

describe('§V110 player and rival on the Working sea: one sea, one step', () => {
  for (const framesPerTick of [1, 2]) {
    it(`identical start and controls, preset change mid-run, ${framesPerTick * 60} fps: bit-identical trajectories`, async () => {
      const m = await run(framesPerTick);
      const msg = `first differing tick ${m.firstDiffTick}, max apart ${m.maxApart.toFixed(3)} m; heave std player ${std(m.player, 0).toFixed(4)} rival ${std(m.rival, 0).toFixed(4)}; top speed player ${Math.max(...m.player.filter((_, i) => i % 4 === 3)).toFixed(3)} rival ${Math.max(...m.rival.filter((_, i) => i % 4 === 3)).toFixed(3)}`;
      // she really rides a sea (not a flat-water tautology): heave moves by decimetres
      expect(std(m.player, 0), msg).toBeGreaterThan(0.05);
      expect(m.firstDiffTick, msg).toBe(-1);
      // so heave, pitch/roll (quaternion x/z) variance and top speed are equal — asserted by the line above, restated
      for (let k = 0; k < 4; k++) expect(std(m.rival, k), msg).toBe(std(m.player, k));
    }, 300_000);
  }
});
