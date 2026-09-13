/**
 * §T.188 / §V2 — collisions inside the NPC physics worker must not change a bit between transports.
 *
 * WHY: two boats that collide may live on different worker shards. Each shard applies only its own boat's share,
 * computed from the frozen WORLD snapshot with the lower index always "A" — so the pair is one contact whatever
 * the thread layout. If that failed, a race replay (V2) would diverge the moment two rivals touched, and only on
 * machines with a different worker count. The run puts each colliding pair ACROSS the shard boundary
 * (shardRanges(4, 2) = [0,2) [2,4); pairs are 0↔2 and 1↔3), runs real threads, and checks the contacts happened.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SIM_DT } from '../src/core/loop';
import { oceanParams } from '../src/params/ocean';
import { seaPhysicsParams } from '../src/params/seaPhysics';
import { BoatFleet } from '../src/sim-worker/fleet';
import { B, HASH_SEED } from '../src/sim-worker/layout';
import type { TransportKind, WorkerPort } from '../src/sim-worker/transport';
import { buildWorkerBundle, nodeSpawner } from './simWorkerNode';

const TICKS = 150;

interface Run {
  hash: number;
  /** boat 0 forward velocity at the end (it drove head-on into boat 2) */
  v0z: number;
  z0: number;
  z2: number;
  /** |x0 − x2| at the end */
  lateral: number;
}

async function race(kind: TransportKind, workers: number, spawn?: () => WorkerPort, opts: { contacts?: boolean; ghost02?: boolean } = {}): Promise<Run> {
  const fleet = new BoatFleet({
    boats: 4,
    kind,
    workers,
    spawn,
    seed: 188,
    oceanParams: structuredClone(oceanParams),
    seaParams: { ...structuredClone(seaPhysicsParams), hullDraft: 0.54 },
    ...(opts.contacts === false ? {} : { contacts: { boats: true, colliders: [{ a: [40, -4, 60], b: [40, 6, 60], radius: 0.4 }] } }),
  });
  try {
    await fleet.ready;
    const yaw = (h: number): [number, number, number, number] => [0, Math.sin(h / 2), 0, Math.cos(h / 2)];
    fleet.place(0, { position: [0, 0.2, 0], quaternion: yaw(0), velocity: [0, 0, 12], angularVelocity: [0, 0, 0] });
    fleet.place(2, { position: [0.6, 0.2, 34], quaternion: yaw(Math.PI), velocity: [0, 0, -12], angularVelocity: [0, 0, 0] });
    fleet.place(1, { position: [40, 0.2, 30], quaternion: yaw(0), velocity: [0, 0, 14], angularVelocity: [0, 0, 0] });
    fleet.place(3, { position: [52, 0.2, 44], quaternion: yaw(-Math.PI / 2), velocity: [-10, 0, 0], angularVelocity: [0, 0, 0] });
    if (opts.ghost02) fleet.setGhost(2, true);
    let h = HASH_SEED;
    let time = 0;
    for (let tick = 0; tick < TICKS; tick++) {
      for (let i = 0; i < 4; i++) fleet.setControls(i, 0.5, 0);
      fleet.kick(tick, time, oceanParams, { ...seaPhysicsParams, hullDraft: 0.54 });
      await fleet.done();
      h = fleet.hash(h);
      time += SIM_DT;
    }
    return {
      hash: h,
      v0z: fleet.readOut(0, B.POSE + 9),
      z0: fleet.readOut(0, B.POSE + 2),
      z2: fleet.readOut(2, B.POSE + 2),
      lateral: Math.abs(fleet.readOut(0, B.POSE) - fleet.readOut(2, B.POSE)),
    };
  } finally {
    fleet.dispose();
  }
}

describe('§T.188 collisions in the sim worker', () => {
  let spawn: () => WorkerPort;
  const runs: Record<string, Run> = {};

  beforeAll(async () => {
    spawn = await nodeSpawner(await buildWorkerBundle('boatCollide'));
  }, 120_000);

  afterAll(() => {
    // eslint-disable-next-line no-console
    console.info('[boatCollideWorker]', Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, r.hash.toString(16)])));
  });

  it('main thread: the pairs really collide (and without the hook, or with a ghost, the same boats pass through)', async () => {
    runs.main = await race('main', 1);
    const off = await race('main', 1, undefined, { contacts: false });
    const ghost = await race('main', 1, undefined, { ghost02: true });
    // without contacts the 0.6 m-offset head-on drives straight through: past each other, still 0.6 m apart
    expect(off.z0, 'no hook: boat 0 drives past boat 2').toBeGreaterThan(off.z2);
    expect(off.lateral, 'no hook: through, not around').toBeLessThan(1);
    expect(ghost.z0, 'ghost: boat 0 drives through boat 2').toBeGreaterThan(ghost.z2);
    expect(ghost.lateral).toBeLessThan(1);
    // with contacts they glance off: either bounced back, or passed with a hull's width between them
    const m = runs.main;
    expect(m.z0 < m.z2 || m.lateral > 2.3, `hook on: bounced or deflected (z0 ${m.z0.toFixed(1)}, z2 ${m.z2.toFixed(1)}, lateral ${m.lateral.toFixed(2)})`).toBe(true);
    expect(runs.main.hash).not.toBe(off.hash);
  }, 120_000);

  for (const [name, kind, workers] of [
    ['sab×2', 'sab', 2],
    ['transfer×2', 'transfer', 2],
  ] as const) {
    it(`${name}: pairs split across shards give the main thread's hash, bit for bit`, async () => {
      runs[name] = await race(kind, workers, spawn);
      expect(runs[name].hash.toString(16)).toBe(runs.main.hash.toString(16));
    }, 120_000);
  }
});
