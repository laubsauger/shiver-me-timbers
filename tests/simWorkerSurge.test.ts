/**
 * §T.207 SURGE REACHES EVERY ENGINE, TICK-EXACT (§V110, §V2).
 *
 * WHY: the race's Surge (`RacerOutputs.thrustMultiplier`) is an ENGINE boost (`HullWater.setBoost`: charge-pressure
 * torque + over-rev allowance, T196 item 6). The player's page step calls it directly; a rival gets it through the sim
 * buffer's controls slot 3, per tick. If the slot were dropped the rivals would never surge (the player alone would), and
 * if a multi-tick request carried one value for all its rows a rival's boost would start and end on a request boundary
 * instead of the race tick — a trajectory that depends on frame timing. So: a boat boosted from tick 40 to 100 by rows
 * (batched) must be bit-identical to the same boost by one-tick kicks, measurably faster than its stock twin, and a
 * slot value ≤ 1 must be the stock engine bit for bit.
 */
import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../src/core/loop';
import { oceanParams } from '../src/params/ocean';
import { seaPhysicsParams } from '../src/params/seaPhysics';
import type { Rigid6State } from '../src/sea-physics/rigidBody';
import { BoatFleet } from '../src/sim-worker/fleet';
import { writeParams } from '../src/sim-worker/paramsVector';

const TICKS = 120;
const boostAt = (i: number, k: number): number => (i === 0 && k >= 40 && k < 100 ? 1.25 : i === 2 ? 0.5 : 0);
/** the three boats share one spawn: no contacts and no wakes in this fleet, so they are independent twins on the same sea */
const spawn = (_i: number): Rigid6State => ({ position: [0, 0.35, 0], quaternion: [-Math.sin(0.02), 0, 0, Math.cos(0.02)], velocity: [0, 0, 20], angularVelocity: [0, 0, 0] });

function make(batchCap?: number) {
  const ocean = structuredClone(oceanParams);
  const sea = { ...structuredClone(seaPhysicsParams), hullDraft: 0.5 };
  const fleet = new BoatFleet({ boats: 3, kind: 'main', seed: 7, oceanParams: ocean, seaParams: sea, ...(batchCap ? { batchCap } : {}) });
  return { fleet, ocean, sea };
}

describe('§T.207 Surge through the controls slot', () => {
  it('rows = one-tick kicks bit for bit; the boosted boat is faster; slot ≤ 1 is stock', async () => {
    const one = make();
    await one.fleet.ready;
    for (let i = 0; i < 3; i++) one.fleet.place(i, spawn(i));
    let time = 0;
    const times = [0];
    for (let k = 1; k <= TICKS; k++) {
      time += SIM_DT;
      times.push(time);
      for (let i = 0; i < 3; i++) one.fleet.setControls(i, 1, 0, 0, boostAt(i, k));
      one.fleet.kick(k, time, one.ocean, one.sea);
      await one.fleet.done();
    }
    const speed = (f: BoatFleet, i: number) => {
      const p = f.readPose(i, spawn(0));
      return Math.hypot(p.velocity[0], p.velocity[2]);
    };
    const v = [0, 1, 2].map((i) => speed(one.fleet, i));
    // boat 0 surged for 1 s at full throttle; boat 1 is its stock twin; boat 2's 0.5 is clamped to stock
    expect(v[0] - v[1], `speeds ${v.map((x) => x.toFixed(3))}`).toBeGreaterThan(0.3);
    const stockPose = one.fleet.readPose(1, spawn(0));
    const clampedPose = one.fleet.readPose(2, spawn(0));
    expect(clampedPose.velocity).toEqual(stockPose.velocity);
    const hashOne = one.fleet.hash();
    one.fleet.dispose();

    const bat = make(60);
    await bat.fleet.ready;
    for (let i = 0; i < 3; i++) bat.fleet.place(i, spawn(i));
    const vec = new Float64Array(bat.fleet.spec.oceanLen + bat.fleet.spec.seaLen);
    writeParams(bat.ocean, vec, 0);
    writeParams(bat.sea, vec, bat.fleet.spec.oceanLen);
    let k = 0;
    for (const n of [25, 50, 45]) {
      for (let j = 0; j < n; j++) {
        const tick = k + 1 + j;
        bat.fleet.setBatchTick(j, tick, times[tick], vec);
        for (let i = 0; i < 3; i++) bat.fleet.setBatchControls(j, i, 1, 0, 0, boostAt(i, tick));
      }
      bat.fleet.kickBatch(n);
      await bat.fleet.done();
      k += n;
    }
    expect(k).toBe(TICKS);
    expect(bat.fleet.hash()).toBe(hashOne);
    bat.fleet.dispose();
  }, 120_000);
});
