import { describe, expect, it, vi } from 'vitest';
import { MAX_SUBSTEPS, SIM_DT } from '../src/core/loop';
import { oceanParams } from '../src/params/ocean';
import type { Course } from '../src/race/types';
import { buildDeepVHull } from '../src/speedboat/hullMesh';
import { createNpcFleetDriver } from '../src/speedboat/page/npcFleet';
import { createPlayerBoat } from '../src/speedboat/page/playerBoat';
import { createRaceSession, RACE_DELAY_TICKS } from '../src/speedboat/page/raceSession';
import { speedboatSeaParams } from '../src/speedboat/page/seaParams';
import type { ShipState } from '../src/state/simState';

// Real driver/trace collection with completion hidden until the next frame,
// like a worker finishing after the previous frame's final pump.
describe('race worker completion before the pause decision', () => {
  it('collects ready results before holding, but still holds for an unfinished worker', async () => {
    const hull = buildDeepVHull();
    const state = { position: [0, 0.2, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] } as unknown as ShipState;
    const player = createPlayerBoat({ hull, pressureHeadAt: () => 0 }, state);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const npcs = await createNpcFleetDriver({
      seed: 7, boats: 1, oceanParams: structuredClone(oceanParams), seaParams: speedboatSeaParams(hull),
      spawn: () => ({ position: [20, 0.2, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] }),
      player: true, wakes: false, budgetMs: 1e6,
      caps: { crossOriginIsolated: false, sharedArrayBuffer: false, worker: false },
    });
    warn.mockRestore();
    const session = createRaceSession({
      course: { paceLine: [[0, 0], [0, 400]] } as unknown as Course,
      hull, player, npcs,
      controls: { sample: () => ({ steer: 0, throttle: 0, trim: 0, surge: false }), dispose() {} },
      resetPressed: () => false, surgePressed: () => false, autoReset: () => true,
      colliders: [], bed: () => -20, waterAt: () => 0,
    });
    let ready = false;
    const poll = npcs.fleet.poll.bind(npcs.fleet);
    npcs.fleet.poll = () => ready && poll();
    try {
      const pageTick = RACE_DELAY_TICKS - MAX_SUBSTEPS + 2; // guard requires tick 3
      for (let k = 1; k <= pageTick; k++) {
        npcs.recordTick(k, k * SIM_DT, { playerPose: state, contactOff: 0, aiIn: null });
        if (k === 3) npcs.pump(k);
      }
      expect(npcs.collectedTick).toBe(0);
      expect(session.holdSim(pageTick)).toBe(true);
      expect(npcs.collectedTick).toBe(0); // incomplete work cannot release the guard
      ready = true;
      expect(session.holdSim(pageTick)).toBe(false); // no extra rendered-frame delay
      expect(npcs.collectedTick).toBeGreaterThanOrEqual(3);
      expect(session.starvedTicks).toBe(0);
      const pump = vi.spyOn(npcs, 'pump');
      expect(session.holdSim(pageTick)).toBe(false);
      expect(pump).not.toHaveBeenCalled(); // sufficient trace needs no extra work
      pump.mockRestore();
    } finally {
      npcs.dispose();
    }
  });
});
