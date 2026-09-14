/**
 * §V110 SAME CONTROLS, SAME BOAT (T206; user playtest: "being in the wake of other boats affects me but not the other
 * boats… a massive drag while everyone flies by me").
 *
 * WHY: the player and the rivals must obey one physics. The player is stepped on the main thread through the page's
 * control source (devices → default assists → seam) against the page mirror; a rival through the sim-worker core
 * against its own mirror. Any player-only cost (an assist that bites at the planing running point, a wake the page's
 * mirror floats the player on but the worker's does not, a contact only one side makes) shows up here as a speed gap.
 * Measured before the fix: the AIR Governor capped the player at prop immersion < 0.45, 3.5% slower than the rival.
 *
 * One run, calm sea, full throttle, helm centred: the player (default assists) with a rival 30 m AHEAD in her lane
 * (the player in its wake), a rival 30 m BEHIND (in hers), and a rival in clean water 50 m abeam. The sim wake is
 * visual-only for hull forces (§V8 amendment) on every boat, so the trailing boats must run as fast as the clean one.
 */
import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../src/core/loop';
import { BOAT_COLLIDE_DEFAULTS, beginContactTick, buildCollisionHull, collideBoatWithFleet, createBoatCollideMemory, writePose } from '../src/sea-physics/boatCollide';
import { CpuOcean } from '../src/sea-physics/cpuOcean';
import type { Rigid6State } from '../src/sea-physics/rigidBody';
import { POSE_LEN } from '../src/sim-worker/layout';
import { neutralBoatInput } from '../src/speedboat/controls/boatInput';
import { createRaceControls } from '../src/speedboat/controls/raceControls';
import { buildDeepVHull } from '../src/speedboat/hullMesh';
import { SPAWN_CG_Y } from '../src/speedboat/page/course';
import { createNpcFleetDriver } from '../src/speedboat/page/npcFleet';
import { createPlayerBoat } from '../src/speedboat/page/playerBoat';
import { speedboatSeaParams } from '../src/speedboat/page/seaParams';
import type { ShipState } from '../src/state/simState';
import { seaOcean } from './speedboatRaceHarness';

const at = (x: number, z: number): Rigid6State => ({ position: [x, SPAWN_CG_Y, z], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] });
const SPAWNS = [at(0, 30), at(0, -30), at(50, 0)]; // ahead (player in its wake), behind (in the player's), clean

describe('§V110 player and rival: same controls, same speed, wake or not', () => {
  it('full throttle on a calm straight: player (default assists) within 1% of a clean-water rival, trailing costs nobody', async () => {
    const hull = buildDeepVHull();
    const seed = 2100;
    const ocean = seaOcean('calm');
    const seaParams = speedboatSeaParams(hull);
    const mirror = new CpuOcean(seed, ocean, seaParams);
    const state = structuredClone(at(0, 0)) as unknown as ShipState;
    const player = createPlayerBoat({ hull, pressureHeadAt: (x, z, t) => mirror.pressureHeadAt(x, z, t) }, state);
    player.place(at(0, 0));
    const input = { ...neutralBoatInput(), throttle: 1 };
    const controls = createRaceControls({ player, devices: { sample: () => input, detach() {} } as never });
    const warn = console.warn;
    console.warn = () => {};
    const npcs = await createNpcFleetDriver({
      seed, boats: SPAWNS.length, oceanParams: ocean, seaParams, spawn: (i) => SPAWNS[i],
      controls: () => ({ throttle: 1, steer: 0 }), contacts: { boats: true }, player: true,
      caps: { crossOriginIsolated: false, sharedArrayBuffer: false, worker: false }, budgetMs: 1e6,
    });
    console.warn = warn;
    // the player's side of the boat↔boat contact, as raceSession.collide makes it
    const cHull = buildCollisionHull(hull);
    const mem = createBoatCollideMemory(cHull);
    const snapshot = new Float64Array((SPAWNS.length + 1) * POSE_LEN);
    const startPose = at(0, 0);
    const mean = { player: 0, rival: [0, 0, 0] };
    let n = 0;
    let time = 0;
    try {
      for (let tick = 1; tick <= 60 * 25; tick++) {
        time += SIM_DT;
        mirror.update(time);
        const c = controls.sample(SIM_DT, state);
        for (let k = 0; k < 3; k++) startPose.position[k] = state.position[k];
        for (let k = 0; k < 4; k++) startPose.quaternion[k] = state.quaternion[k];
        for (let k = 0; k < 3; k++) startPose.velocity[k] = state.velocity[k];
        for (let i = 0; i < SPAWNS.length; i++) writePose(snapshot, 0, i, npcs.pose(i));
        writePose(snapshot, 0, SPAWNS.length, state);
        beginContactTick(mem);
        collideBoatWithFleet(SPAWNS.length, state, cHull, snapshot, 0, SPAWNS.length + 1, 0, SIM_DT, mem, BOAT_COLLIDE_DEFAULTS, 0);
        player.tick(c, time);
        npcs.recordTick(tick, time, { playerPose: startPose, contactOff: 0, aiIn: null });
        npcs.pump(tick);
        npcs.pump(tick);
        if (tick <= 60 * 15) continue; // on the plane at top speed from ~15 s
        mean.player += Math.hypot(state.velocity[0], state.velocity[2]);
        for (let i = 0; i < SPAWNS.length; i++) mean.rival[i] += Math.hypot(npcs.pose(i).velocity[0], npcs.pose(i).velocity[2]);
        n++;
      }
    } finally {
      npcs.dispose();
    }
    const vP = mean.player / n;
    const [vAhead, vBehind, vClean] = mean.rival.map((v) => v / n);
    const msg = `player ${vP.toFixed(2)} | rival ahead ${vAhead.toFixed(2)}, behind ${vBehind.toFixed(2)}, clean ${vClean.toFixed(2)} m/s`;
    expect(vClean, msg).toBeGreaterThan(30); // planing at top speed, not a stalled run
    // same controls ⟹ same top speed (the player's assists must not cost speed at the planing running point)
    expect(Math.abs(vP - vClean) / vClean, msg).toBeLessThan(0.01);
    // the player in a rival's wake and a rival in the player's wake: neither pays for it
    expect(Math.abs(vP - vAhead) / vAhead, msg).toBeLessThan(0.01);
    expect(Math.abs(vBehind - vClean) / vClean, msg).toBeLessThan(0.01);
  }, 120000);
});
