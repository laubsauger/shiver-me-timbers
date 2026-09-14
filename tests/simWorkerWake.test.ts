/**
 * §T.207 / §V2 / §V110 / §V108 — THE WAKE EVERY HULL FEELS IS THE SAME ON EVERY TRANSPORT.
 *
 * WHY: a rival's hull now reads the other boats' wake records (layout WAKE WORLD) on top of the sea. Those records are
 * cross-boat data: if a shard read another shard's live OUT, or a batch carried a request-start record on every row, a
 * rival's ride through a wake would depend on the worker count or the frame timing, and a replay (V2) or the player
 * (who reads the same records on the page) would see a different sea than the rival did. So a column of planing boats,
 * each in the wake of the one ahead and the first in the wake of an EXTERNAL boat (the page's player, main-written
 * records), is run one tick per kick on the main thread as the reference, and every other transport and batching must
 * reproduce every row's pose hash and wake record bit for bit.
 *
 * Teeth: the same run with `wakeField` off must NOT match (the coupling is live), and a lone boat must be bit-identical
 * with and without it (§V108: a hull never reads its own wake).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { SIM_DT } from '../src/core/loop';
import { oceanParams, type OceanParams } from '../src/params/ocean';
import { seaPhysicsParams, type SeaPhysicsParams } from '../src/params/seaPhysics';
import type { Rigid6State } from '../src/sea-physics/rigidBody';
import { BoatFleet } from '../src/sim-worker/fleet';
import { writeParams } from '../src/sim-worker/paramsVector';
import type { TransportKind, WorkerPort } from '../src/sim-worker/transport';
import { SPEEDBOAT_WAKE_REACH_ASTERN, WAKE_SPEEDBOAT_NEAR_TIER } from '../src/wake/wakeCalibration';
import { WAKE_FIELD_BAND, WAKE_FIELD_REACH, WAKE_SRC_LEN, WakeField, WS } from '../src/wake/wakeField';
import { buildWorkerBundle, nodeSpawner } from './simWorkerNode';

const SEED = 207;
const STEPPED = 3;
const BOATS = STEPPED + 1;
const EXT = BOATS - 1;
const TICKS = 150;
const PLAN = [1, 7, 30, 2, 60, 50];
const U = 25;

function freshParams(): { ocean: OceanParams; sea: SeaPhysicsParams } {
  return { ocean: structuredClone(oceanParams), sea: { ...structuredClone(seaPhysicsParams), hullDraft: 0.5 } };
}

/** a column heading +z on the plane, each boat ~35 m astern of the one ahead and a little off its track */
const spawn = (i: number): Rigid6State => ({
  position: [[1.5, -2, 2.5][i], 0.35, -35 * i],
  quaternion: [-Math.sin(0.02), 0, 0, Math.cos(0.02)],
  velocity: [0, 0, U],
  angularVelocity: [0, 0, 0],
});

/** the external boat 40 m ahead of boat 0, its pose and a planing hull's wake record at the START of tick k */
const extPose = (k: number): Rigid6State => ({ position: [0, 0.35, 40 + U * k * SIM_DT], quaternion: [0, 0, 0, 1], velocity: [0, 0, U], angularVelocity: [0, 0, 0] });
function extWake(k: number): Float64Array {
  const r = new Float64Array(WAKE_SRC_LEN);
  const F = 52000 * Math.min(1, k / 30); // the record's own low-pass, roughly
  r[WS.X] = 0;
  r[WS.Z] = 40 + U * k * SIM_DT;
  r[WS.VZ] = U;
  r[WS.RUN] = 300 + U * k * SIM_DT; // long on the plane: its pattern is established past boat 2
  r[WS.F] = F;
  r[WS.FA] = F * -0.35;
  r[WS.FAA] = F * (2.0 ** 2 + 0.35 ** 2);
  r[WS.FCC] = F * 0.75 ** 2;
  r[WS.FD] = F * 0.1;
  return r;
}

function make(kind: TransportKind, opts: { spawnWorker?: () => WorkerPort; batchCap?: number; workers?: number; wakes?: boolean } = {}): { fleet: BoatFleet; p: ReturnType<typeof freshParams> } {
  const p = freshParams();
  const fleet = new BoatFleet({
    boats: BOATS, kind, spawn: opts.spawnWorker, workers: opts.workers, seed: SEED, oceanParams: p.ocean, seaParams: p.sea,
    externalBoats: 1, ...(opts.wakes === false ? {} : { wakeField: true }), ...(opts.batchCap ? { batchCap: opts.batchCap } : {}),
  });
  return { fleet, p };
}

const ctl = (i: number, k: number): number => Math.min(1, 0.8 + k / 600 + 0.05 * i);

function records(fleet: BoatFleet, j: number): Float64Array {
  const out = new Float64Array(STEPPED * WAKE_SRC_LEN);
  for (let i = 0; i < STEPPED; i++) fleet.readWakeSource(j, i, out, i * WAKE_SRC_LEN);
  return out;
}

interface Ref {
  hash: number[];
  rec: Float64Array[];
}

async function runOneTick(fleet: BoatFleet, p: ReturnType<typeof freshParams>, wakes: boolean): Promise<Ref> {
  await fleet.ready;
  for (let i = 0; i < STEPPED; i++) fleet.place(i, spawn(i));
  const ref: Ref = { hash: [NaN], rec: [new Float64Array(0)] };
  let time = 0;
  for (let k = 1; k <= TICKS; k++) {
    time += SIM_DT;
    fleet.setExternalPose(EXT, extPose(k));
    if (wakes) fleet.setExternalWakeSource(EXT, extWake(k));
    for (let i = 0; i < STEPPED; i++) fleet.setControls(i, ctl(i, k), 0);
    fleet.kick(k, time, p.ocean, p.sea);
    await fleet.done();
    ref.hash.push(fleet.hash());
    ref.rec.push(wakes ? records(fleet, 0) : new Float64Array(0));
  }
  fleet.dispose();
  return ref;
}

let REF: Ref;

beforeAll(async () => {
  const { fleet, p } = make('main');
  REF = await runOneTick(fleet, p, true);
}, 300_000);

async function runBatched(fleet: BoatFleet, p: ReturnType<typeof freshParams>): Promise<number> {
  await fleet.ready;
  for (let i = 0; i < STEPPED; i++) fleet.place(i, spawn(i));
  const vec = new Float64Array(fleet.spec.oceanLen + fleet.spec.seaLen);
  writeParams(p.ocean, vec, 0);
  writeParams(p.sea, vec, fleet.spec.oceanLen);
  let k = 0;
  let firstMismatch = -1;
  const times: number[] = [0];
  for (let t = 1, time = 0; t <= TICKS; t++) times.push((time += SIM_DT));
  for (let q = 0; k < TICKS; q++) {
    // the plan's request sizes, as many as the fleet allows (a multi-shard wake fleet is one tick per request)
    const n = Math.min(PLAN[q % PLAN.length], TICKS - k, fleet.maxBatch);
    for (let j = 0; j < n; j++) {
      const tick = k + 1 + j;
      fleet.setBatchTick(j, tick, times[tick], vec);
      fleet.setBatchExternalPose(j, EXT, extPose(tick));
      fleet.setBatchExternalWakeSource(j, EXT, extWake(tick));
      for (let i = 0; i < STEPPED; i++) fleet.setBatchControls(j, i, ctl(i, tick), 0);
    }
    fleet.kickBatch(n);
    await fleet.done();
    for (let j = 0; j < n; j++) {
      const tick = k + 1 + j;
      const got = records(fleet, j);
      if (firstMismatch < 0 && !got.every((v, s) => Object.is(v, REF.rec[tick][s]))) firstMismatch = tick;
    }
    k += n;
    if (firstMismatch < 0 && fleet.hash() !== REF.hash[k]) firstMismatch = k;
  }
  fleet.dispose();
  return firstMismatch;
}

describe('§T.207 wake records across transports', () => {
  it('the field is forced at the band and reach the drawn speedboat wake uses (the wake a hull floats on is the one drawn)', () => {
    expect({ ...WAKE_FIELD_BAND }).toEqual({ n: WAKE_SPEEDBOAT_NEAR_TIER.n, texel: WAKE_SPEEDBOAT_NEAR_TIER.texel });
    expect(WAKE_FIELD_REACH).toBe(SPEEDBOAT_WAKE_REACH_ASTERN);
  });

  it('the coupling is live: boat 0 reads a real wake, and the run without wakes diverges', async () => {
    // the external boat's field at boat 0's CG at the end: a planing wake is centimetres, not zero
    const field = new WakeField();
    const all = new Float64Array(BOATS * WAKE_SRC_LEN);
    all.set(REF.rec[TICKS]);
    all.set(extWake(TICKS), EXT * WAKE_SRC_LEN);
    const r0 = REF.rec[TICKS];
    let maxEta = 0;
    for (let i = 0; i < STEPPED; i++) {
      const o = i * WAKE_SRC_LEN;
      expect(r0[o + WS.F], `boat ${i} publishes its load`).toBeGreaterThan(20000);
      field.prepare(all, 0, BOATS, i, r0[o + WS.X], r0[o + WS.Z]);
      for (let dz = -6; dz <= 6; dz += 1) maxEta = Math.max(maxEta, Math.abs(field.heightAt(r0[o + WS.X], r0[o + WS.Z] + dz)));
    }
    expect(maxEta).toBeGreaterThan(0.01);
    const { fleet, p } = make('main', { wakes: false });
    const off = await runOneTick(fleet, p, false);
    expect(off.hash[TICKS]).not.toBe(REF.hash[TICKS]);
  }, 300_000);

  it('§V108: a lone boat never reads its own wake — bit-identical with the wake regions on and off', async () => {
    const run = async (wakeField: boolean): Promise<number> => {
      const p = freshParams();
      const fleet = new BoatFleet({ boats: 1, kind: 'main', seed: SEED, oceanParams: p.ocean, seaParams: p.sea, ...(wakeField ? { wakeField } : {}) });
      await fleet.ready;
      fleet.place(0, spawn(0));
      let time = 0;
      for (let k = 1; k <= 90; k++) {
        time += SIM_DT;
        fleet.setControls(0, 1, 0.2);
        fleet.kick(k, time, p.ocean, p.sea);
        await fleet.done();
      }
      const h = fleet.hash();
      fleet.dispose();
      return h;
    };
    expect(await run(true)).toBe(await run(false));
  }, 120_000);

  it('main transport, batched: every row\'s wake records and every request-end hash equal one tick per kick', async () => {
    const { fleet, p } = make('main', { batchCap: 60 });
    expect(await runBatched(fleet, p)).toBe(-1);
  }, 300_000);

  describe('real worker_threads', () => {
    let spawnWorker: () => WorkerPort;
    beforeAll(async () => {
      spawnWorker = await nodeSpawner(await buildWorkerBundle('wake'));
    }, 120_000);
    for (const [kind, workers] of [['sab', 1], ['sab', 2], ['transfer', 1]] as const) {
      it(`${kind}×${workers}: identical to the reference`, async () => {
        const { fleet, p } = make(kind, { spawnWorker, batchCap: 60, workers });
        expect(await runBatched(fleet, p)).toBe(-1);
      }, 300_000);
    }
  });
});
