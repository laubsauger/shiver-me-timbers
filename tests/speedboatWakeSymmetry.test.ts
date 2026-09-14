/**
 * §T.207 WAKES MOVE EVERY BOAT, SYMMETRICALLY (§V110, §V108). USER: "wakes should obviously in a way impact the travel
 * but it should be for everyone."
 *
 * WHY: the player is stepped on the page (playerBoat, page mirror) and a rival in the sim-worker core (its own mirror),
 * and each reads the OTHER's wake record through a different path — the player from the fleet's per-tick records
 * (`npcFleet.wakeSource` → `PlayerBoat.setWakeSources`), the rival from the recorded `playerWake` in its WAKE WORLD.
 * If either path dropped, delayed, or scaled the wake, one racer would ride a different sea than the other, the
 * unfairness §V110 forbids (T206 was exactly that: a wake the player felt and the rivals did not).
 *
 * One crossing, run twice with the roles swapped at the SAME world positions: a leader on the plane at 30 m/s along +z,
 * a crosser at 45° cutting its track 80 m astern of it. The crosser's ride through the wake — heave velocity, pitch,
 * speed — must be the same whether the crosser is the player (in a rival's wake) or the rival (in the player's), and it
 * must differ from the same crossing with wakes off (the coupling is live, so the equality is not two zeros).
 */
import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../src/core/loop';
import { CpuOcean } from '../src/sea-physics/cpuOcean';
import type { Rigid6State } from '../src/sea-physics/rigidBody';
import { buildDeepVHull } from '../src/speedboat/hullMesh';
import { createNpcFleetDriver } from '../src/speedboat/page/npcFleet';
import { createPlayerBoat } from '../src/speedboat/page/playerBoat';
import { speedboatSeaParams } from '../src/speedboat/page/seaParams';
import type { ShipState } from '../src/state/simState';
import { WAKE_SRC_LEN } from '../src/wake/wakeField';
import { seaOcean } from './speedboatRaceHarness';

const U = 30;
const CROSS_DEG = 45;
/** seconds until the crosser reaches the leader's track, and the gap astern of the leader there */
const T_CROSS = 6;
const GAP = 80;
const SECONDS = T_CROSS + 2.5;

const planing = (x: number, z: number, yaw: number): Rigid6State => ({
  position: [x, 0.35, z],
  quaternion: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
  velocity: [U * Math.sin(yaw), 0, U * Math.cos(yaw)],
  angularVelocity: [0, 0, 0],
});

interface Ride {
  /** max |vertical velocity| and max |pitch| (deg) through the crossing window, speed at its end */
  maxVy: number;
  maxPitchDeg: number;
  speedEnd: number;
}

/** player at `playerAt`, one rival at `rivalAt`, both full throttle helm centred; the rides of both through the window */
async function run(playerAt: Rigid6State, rivalAt: Rigid6State, wakes: boolean): Promise<{ player: Ride; rival: Ride }> {
  const hull = buildDeepVHull();
  const seed = 2100;
  const ocean = seaOcean('calm');
  const seaParams = speedboatSeaParams(hull);
  const mirror = new CpuOcean(seed, ocean, seaParams);
  const state = structuredClone(playerAt) as unknown as ShipState;
  const player = createPlayerBoat({ hull, pressureHeadAt: (x, z, t) => mirror.pressureHeadAt(x, z, t) }, state);
  player.place(playerAt);
  const warn = console.warn;
  console.warn = () => {};
  const npcs = await createNpcFleetDriver({
    seed, boats: 1, oceanParams: ocean, seaParams, spawn: () => rivalAt, controls: () => ({ throttle: 1, steer: 0 }), player: true, wakes,
    caps: { crossOriginIsolated: false, sharedArrayBuffer: false, worker: false }, budgetMs: 1e6,
  });
  console.warn = warn;
  const rivalWake = new Float64Array(WAKE_SRC_LEN);
  if (wakes) player.setWakeSources(rivalWake, 1);
  const startPose = structuredClone(playerAt);
  const ride = (): Ride => ({ maxVy: 0, maxPitchDeg: 0, speedEnd: 0 });
  const out = { player: ride(), rival: ride() };
  const measure = (s: Readonly<Rigid6State>, r: Ride): void => {
    const q = s.quaternion;
    r.maxVy = Math.max(r.maxVy, Math.abs(s.velocity[1]));
    r.maxPitchDeg = Math.max(r.maxPitchDeg, Math.abs(Math.asin(2 * (q[1] * q[2] - q[3] * q[0]))) * (180 / Math.PI));
    r.speedEnd = Math.hypot(s.velocity[0], s.velocity[2]);
  };
  let time = 0;
  try {
    for (let tick = 1; tick <= SECONDS * 60; tick++) {
      time += SIM_DT;
      mirror.update(time);
      for (let k = 0; k < 3; k++) startPose.position[k] = state.position[k];
      for (let k = 0; k < 4; k++) startPose.quaternion[k] = state.quaternion[k];
      for (let k = 0; k < 3; k++) startPose.velocity[k] = state.velocity[k];
      for (let k = 0; k < 3; k++) startPose.angularVelocity[k] = state.angularVelocity[k];
      // each side reads the other's record from the end of tick − 1 (the rival's is collected: two pumps per tick)
      if (wakes && tick > 1) npcs.wakeSource(tick - 1, 0, rivalWake, 0);
      npcs.recordTick(tick, time, { playerPose: startPose, contactOff: 0, aiIn: null, ...(wakes ? { playerWake: player.wakeRecord.slice() } : {}) });
      player.tick({ steer: 0, throttle: 1, trim: 0, surge: false }, time);
      npcs.pump(tick);
      npcs.pump(tick);
      if (time >= T_CROSS - 1.5) {
        measure(state, out.player);
        measure(npcs.pose(0), out.rival);
      }
    }
  } finally {
    npcs.dispose();
  }
  return out;
}

describe('§T.207 a wake moves the player and a rival the same', () => {
  it('crossing a leader\'s wake at 45°, 80 m astern: the player (rival\'s wake) and the rival (player\'s wake) ride it alike', async () => {
    const a = (CROSS_DEG * Math.PI) / 180;
    const zCross = U * T_CROSS - GAP;
    const lead = planing(0, 0, 0);
    const cross = planing(-U * T_CROSS * Math.sin(a), zCross - U * T_CROSS * Math.cos(a), a);
    const rivalCrosses = (await run(lead, cross, true)).rival; // the rival in the player's wake
    const playerCrosses = (await run(cross, lead, true)).player; // the player in the rival's wake
    const noWake = (await run(lead, cross, false)).rival;
    const msg = `player crossing ${JSON.stringify(playerCrosses)} | rival crossing ${JSON.stringify(rivalCrosses)} | no wake ${JSON.stringify(noWake)}`;
    // live: the wake is felt ([M] max |vy| 0.98 m/s without it, 1.56 with it)
    expect(rivalCrosses.maxVy - noWake.maxVy, msg).toBeGreaterThan(0.25);
    // symmetric: the same ride on both sides
    expect(Math.abs(playerCrosses.maxVy - rivalCrosses.maxVy), msg).toBeLessThan(0.05);
    expect(Math.abs(playerCrosses.maxPitchDeg - rivalCrosses.maxPitchDeg), msg).toBeLessThan(0.1);
    expect(Math.abs(playerCrosses.speedEnd - rivalCrosses.speedEnd), msg).toBeLessThan(0.02);
  }, 180_000);
});
