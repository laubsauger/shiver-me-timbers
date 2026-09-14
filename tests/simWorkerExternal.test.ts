/**
 * §T.191 / §V2 / §V110 — THE PLAYER IN THE RIVALS' WORLD, AND THE TRACE THE PAGE RACES ON, SURVIVE BATCHING.
 *
 * WHY: the page puts the player into the fleet as an EXTERNAL boat (main writes its pose, no core steps it) so rivals
 * avoid, block and collide with the player; it reads a per-row TRACE (pose, substep positions, contact, bow
 * immersion) because the race logic and crash machines run on the main thread for ticks the main thread never saw
 * inside a multi-tick request; and it sets a per-row contact-off mask because a respawn ghost starts and ends on a
 * TICK, not on a request boundary. If any of those were carried per request instead of per row, a rival's trajectory
 * would depend on how the frame timing happened to batch the ticks — a replay (V2) or a slow frame would change the
 * race. So every run here is compared, hash and every trace record, against the reference: one tick per kick on the
 * main-thread transport.
 *
 * The scenario makes the compared things matter: the external boat sits in boat 0's path and drifts, so boat 0 hits
 * it (asserted: a boat contact against the external index), and boat 1 is ghosted for a window of ticks that starts
 * and ends inside requests. Mutation twin: a run that writes the request's FIRST external pose on every row must not
 * match.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { SIM_DT } from '../src/core/loop';
import { oceanParams, type OceanParams } from '../src/params/ocean';
import { seaPhysicsParams, type SeaPhysicsParams } from '../src/params/seaPhysics';
import { CONTACT_BOAT } from '../src/sea-physics/boatCollide';
import type { Rigid6State } from '../src/sea-physics/rigidBody';
import { BoatFleet } from '../src/sim-worker/fleet';
import { TR, TRACE_LEN } from '../src/sim-worker/layout';
import { writeParams } from '../src/sim-worker/paramsVector';
import type { TransportKind, WorkerPort } from '../src/sim-worker/transport';
import { buildWorkerBundle, nodeSpawner } from './simWorkerNode';

const SEED = 191;
const STEPPED = 3;
const BOATS = STEPPED + 1;
const EXT = BOATS - 1;
const TICKS = 240;
const GHOST = [70, 130] as const;
const PLAN = [1, 5, 17, 60, 3, 3, 60, 31, 60];

function freshParams(): { ocean: OceanParams; sea: SeaPhysicsParams } {
  return { ocean: structuredClone(oceanParams), sea: { ...structuredClone(seaPhysicsParams), hullDraft: 0.5 } };
}

const spawn = (i: number): Rigid6State => ({
  position: [i * 30 - 30, 0.2, 0],
  quaternion: [0, 0, 0, 1],
  velocity: [0, 0, 6],
  angularVelocity: [0, 0, 0],
});

/** the external boat at the START of tick k: parked across boat 0's path, drifting and yawing slowly */
const external = (k: number): Rigid6State => {
  const yaw = Math.PI / 2 + k * 0.002;
  return {
    position: [-30 + k * 0.004, 0.2, 16 + k * 0.01],
    quaternion: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
    velocity: [0.24, 0, 0.6],
    angularVelocity: [0, 0.12, 0],
  };
};

const ghostMask = (k: number): number => (k >= GHOST[0] && k < GHOST[1] ? 1 << 1 : 0);
const ctl = (i: number, k: number): { throttle: number; steer: number } => ({ throttle: Math.min(0.7, k / 60), steer: i === 0 ? 0 : Math.sin(k * 0.02 + i) * 0.3 });

interface Ref {
  hash: number[];
  trace: Float64Array[][];
}

function traceOf(fleet: BoatFleet, j: number): Float64Array[] {
  return Array.from({ length: STEPPED }, (_, i) => {
    const r = fleet.traceRecord(j, i);
    return r.f64.slice(r.offset, r.offset + TRACE_LEN);
  });
}

function make(kind: TransportKind, spawnWorker?: () => WorkerPort, batchCap?: number): { fleet: BoatFleet; p: ReturnType<typeof freshParams> } {
  const p = freshParams();
  const fleet = new BoatFleet({
    boats: BOATS, kind, spawn: spawnWorker, seed: SEED, oceanParams: p.ocean, seaParams: p.sea,
    externalBoats: 1, trace: true, contacts: { boats: true }, ...(batchCap ? { batchCap } : {}),
  });
  return { fleet, p };
}

let REF: Ref;
let contactsWithExternal = 0;

beforeAll(async () => {
  const { fleet, p } = make('main');
  await fleet.ready;
  for (let i = 0; i < STEPPED; i++) fleet.place(i, spawn(i));
  expect(() => fleet.place(EXT, spawn(EXT))).toThrow(/external/);
  REF = { hash: [NaN], trace: [[]] };
  let time = 0;
  for (let k = 1; k <= TICKS; k++) {
    time += SIM_DT;
    fleet.setExternalPose(EXT, external(k));
    fleet.setGhost(1, ghostMask(k) !== 0);
    for (let i = 0; i < STEPPED; i++) {
      const c = ctl(i, k);
      fleet.setControls(i, c.throttle, c.steer);
    }
    fleet.kick(k, time, p.ocean, p.sea);
    await fleet.done();
    REF.hash.push(fleet.hash());
    const tr = traceOf(fleet, 0);
    REF.trace.push(tr);
    if (tr[0][TR.CONTACT_SRC] === CONTACT_BOAT && tr[0][TR.CONTACT_OTHER] === EXT) contactsWithExternal++;
  }
  fleet.dispose();
}, 300_000);

async function runBatched(fleet: BoatFleet, p: ReturnType<typeof freshParams>, staleExternal = false): Promise<{ matched: number; firstMismatch: number }> {
  await fleet.ready;
  for (let i = 0; i < STEPPED; i++) fleet.place(i, spawn(i));
  const vec = new Float64Array(fleet.spec.oceanLen + fleet.spec.seaLen);
  writeParams(p.ocean, vec, 0);
  writeParams(p.sea, vec, fleet.spec.oceanLen);
  let k = 0;
  let matched = 0;
  let firstMismatch = -1;
  let time = 0;
  const times: number[] = [0];
  for (let t = 1; t <= TICKS; t++) times.push((time += SIM_DT));
  for (const planned of PLAN) {
    const n = Math.min(planned, TICKS - k);
    if (n <= 0) break;
    for (let j = 0; j < n; j++) {
      const tick = k + 1 + j;
      fleet.setBatchTick(j, tick, times[tick], vec);
      fleet.setBatchExternalPose(j, EXT, external(staleExternal ? k + 1 : tick));
      fleet.setBatchContactOff(j, ghostMask(tick));
      for (let i = 0; i < STEPPED; i++) {
        const c = ctl(i, tick);
        fleet.setBatchControls(j, i, c.throttle, c.steer);
      }
    }
    fleet.kickBatch(n);
    await fleet.done();
    for (let j = 0; j < n; j++) {
      const tick = k + 1 + j;
      const got = traceOf(fleet, j);
      const same = got.every((rec, i) => rec.every((v, s) => Object.is(v, REF.trace[tick][i][s])));
      if (same) matched++;
      else if (firstMismatch < 0) firstMismatch = tick;
    }
    k += n;
    if (fleet.hash() !== REF.hash[k] && firstMismatch < 0) firstMismatch = k;
  }
  expect(k).toBe(TICKS);
  fleet.dispose();
  return { matched, firstMismatch };
}

describe('§T.191 external boats + trace + per-row contact-off, batched', () => {
  it('the reference exercises what is compared: boat 0 hits the external boat, the trace carries substeps and positions', () => {
    expect(contactsWithExternal).toBeGreaterThan(0);
    const last = REF.trace[TICKS][0];
    expect(last[TR.SUBSTEPS]).toBeGreaterThanOrEqual(2);
    // substep END positions advance along the track and end at the pose
    const n = Math.min(4, last[TR.SUBSTEPS]);
    expect(last[TR.POS + 2 * (n - 1)]).toBe(last[TR.POSE]);
    expect(last[TR.POS + 2 * (n - 1) + 1]).toBe(last[TR.POSE + 2]);
    expect(last[TR.POS + 1]).not.toBe(last[TR.POSE + 2]);
    expect(Number.isNaN(last[TR.FETCH_VERSION])).toBe(true); // no world data: open sea
  });

  it('main transport: every trace row and every request-end hash equal one tick per kick', async () => {
    const { fleet, p } = make('main', undefined, 60);
    const r = await runBatched(fleet, p);
    expect(r.firstMismatch).toBe(-1);
    expect(r.matched).toBe(TICKS);
  }, 300_000);

  it('mutation: the request\'s first external pose on every row does not match', async () => {
    const { fleet, p } = make('main', undefined, 60);
    const r = await runBatched(fleet, p, true);
    expect(r.firstMismatch).toBeGreaterThan(0);
  }, 300_000);

  describe('real worker_threads', () => {
    let spawnWorker: () => WorkerPort;
    beforeAll(async () => {
      spawnWorker = await nodeSpawner(await buildWorkerBundle('external'));
    }, 120_000);
    for (const kind of ['sab', 'transfer'] as const) {
      it(`${kind}×1: identical to the reference`, async () => {
        const { fleet, p } = make(kind, spawnWorker, 60);
        const r = await runBatched(fleet, p);
        expect(r.firstMismatch).toBe(-1);
        expect(r.matched).toBe(TICKS);
      }, 300_000);
    }
  });
});
