/**
 * §T.195 every boat marks the water: a rival's wake samples, prop jets and waterline spray cross the sim-worker
 * transport next to her pose (sim-worker/fx.ts, `BoatFleet.effects`), and the ONE wake source buffer built from them
 * (`WakeSim.tick`) is a function of the boats' steps alone.
 *
 * WHY: §V2 — a replay, a hidden tab's catch-up or a different thread count must draw the same wakes; §V101 — the
 * effects a rival shows must be the step that placed her, not a neighbouring one, or her wake and spray detach from
 * her hull by a tick (0.67 m at 40 m/s) and her foam from her props.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SIM_DT } from '../src/core/loop';
import { oceanParams } from '../src/params/ocean';
import { seaPhysicsParams } from '../src/params/seaPhysics';
import { BoatFleet } from '../src/sim-worker/fleet';
import { FX, FX_DRIVE, FX_DRIVE_LEN, FX_LEN, createBoatFx, readBoatFx, writeBoatFx } from '../src/sim-worker/fx';
import { B, BOAT_FIXED, HASH_SEED } from '../src/sim-worker/layout';
import type { TransportKind, WorkerPort } from '../src/sim-worker/transport';
import { WAKE_SPEEDBOAT_TIER } from '../src/wake/wakeCalibration';
import { WakeSim, type VesselWakeInput } from '../src/wake/wakeSim';
import { SpeedboatTow } from '../src/wake/speedboatTow';
import { hullWaterSamples } from '../src/wake/stationSources';
import { propWashFromHullWater } from '../src/wake/propWashHullWater';
import type { PropWashInput } from '../src/wake/propWash';
import { buildWorkerBundle, nodeSpawner } from './simWorkerNode';

const SEED = 195;
const BOATS = 8;
const TICKS = 150;

const params = () => ({ ocean: structuredClone(oceanParams), sea: { ...structuredClone(seaPhysicsParams), hullDraft: 0.5 } });

/** FNV-1a over float64 bits */
function hashF64(h: number, xs: ArrayLike<number>): number {
  const b = new Uint8Array(Float64Array.from(xs).buffer);
  for (let k = 0; k < b.length; k++) {
    h ^= b[k];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

interface EffectsRun {
  /** per collected tick: hash of the WakeSim source buffer built from every boat's effects */
  perTick: Map<number, number>;
  final: number;
  jets: number;
  thrust: number;
  wakeSamples: number;
  bowFlux: number;
}

/**
 * Boats 1..7 are rivals of a hero at boat 0's pose (the source buffer is anchored on boat 0). `batch` ticks per kick.
 */
async function run(kind: TransportKind, workers: number, spawn: (() => WorkerPort) | undefined, batch: number): Promise<EffectsRun> {
  const p = params();
  const fleet = new BoatFleet({ boats: BOATS, kind, workers, spawn, seed: SEED, oceanParams: p.ocean, seaParams: p.sea, batchCap: batch > 1 ? batch : 0 });
  const perTick = new Map<number, number>();
  let jets = 0;
  let thrust = 0;
  let wakeSamples = 0;
  let bowFlux = 0;
  try {
    await fleet.ready;
    for (let i = 0; i < BOATS; i++) {
      fleet.place(i, {
        position: [i * 25 - 90, 0.1, (i % 2) * 30 - 15],
        quaternion: [0, 0, 0, 1],
        velocity: [0, 0, 8 + i],
        angularVelocity: [0, 0, 0],
      });
    }
    const sim = new WakeSim(WAKE_SPEEDBOAT_TIER);
    let time = 0;
    const times: number[] = [];
    for (let t = 0; t < TICKS; t++) {
      times.push(time);
      time += SIM_DT;
    }
    const controls = (i: number, t: number): [number, number] => [Math.min(1, 0.3 + t / 60) * (0.7 + 0.04 * i), 0.3 * Math.sin(t * 0.05 + i)];
    const pv: number[] = [];
    for (const [name, v] of [['ocean', p.ocean], ['sea', p.sea]] as const) {
      void name;
      const { writeParams, paramsLength } = await import('../src/sim-worker/paramsVector');
      const buf = new Float64Array(paramsLength(v));
      writeParams(v, buf, 0);
      pv.push(...buf);
    }
    for (let t = 0; t < TICKS; ) {
      const n = Math.min(batch, TICKS - t);
      if (batch > 1) {
        for (let j = 0; j < n; j++) {
          fleet.setBatchTick(j, t + j, times[t + j], pv);
          for (let i = 0; i < BOATS; i++) fleet.setBatchControls(j, i, ...controls(i, t + j));
        }
        fleet.kickBatch(n);
      } else {
        for (let i = 0; i < BOATS; i++) fleet.setControls(i, ...controls(i, t));
        fleet.kick(t, times[t], p.ocean, p.sea);
      }
      await fleet.done();
      t += n;
      // the effects are the request's LAST step: its pose is the pose readPose sees, its tick the last row's
      const e0 = fleet.effects(0);
      expect(e0.tick).toBe(t - 1);
      const pose = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] } as never;
      fleet.readPose(0, pose);
      expect(e0.pose).toEqual(pose);
      const rivals: VesselWakeInput[] = [];
      for (let i = 1; i < BOATS; i++) {
        const e = fleet.effects(i);
        rivals.push({ samples: e.wake, jets: e.fx.jets, x: e.pose.position[0], z: e.pose.position[2], vx: e.pose.velocity[0], vz: e.pose.velocity[2] });
      }
      sim.tick(e0.pose, e0.wake, 6, SIM_DT, e0.fx.jets, rivals);
      let h = HASH_SEED;
      h = hashF64(h, sim.sources.data.subarray(0, sim.sources.count * 5));
      h = hashF64(h, sim.sources.jetData.subarray(0, sim.sources.jetCount * 5));
      h = hashF64(h, [sim.sources.count, sim.sources.jetCount, sim.vesselCount, sim.solver.centerX, sim.solver.centerZ]);
      for (let i = 0; i < BOATS; i++) {
        const b = fleet.effects(i).fx.bow;
        h = hashF64(h, [b.flux, b.lift, b.launch, b.x, b.y, b.z, b.halfWidth, b.burialRate, b.cutwaterDepth]);
      }
      perTick.set(t - 1, h);
    }
    for (let i = 0; i < BOATS; i++) {
      const e = fleet.effects(i);
      jets += e.fx.jets.length;
      thrust += e.fx.jets.reduce((a, j) => a + j.thrust, 0);
      wakeSamples += e.wake.length;
      bowFlux += e.fx.bow.flux;
    }
    return { perTick, final: fleet.hash(), jets, thrust, wakeSamples, bowFlux };
  } finally {
    fleet.dispose();
  }
}

describe('§T.195 the effects record: one writer, placed in the boat block, round-trips exactly', () => {
  it('FX sits between the contact summary and the wake samples, inside the hashed OUT range', () => {
    expect(B.FX).toBeGreaterThan(B.WAKE_OVERFLOW);
    expect(B.WAKE).toBe(B.FX + FX_LEN);
    expect(BOAT_FIXED).toBe(B.WAKE);
    expect(FX.BOW).toBe(FX.DRIVE + 4 * FX_DRIVE_LEN);
  });

  it('writeBoatFx → readBoatFx gives the adapter\'s own jets and the waterline spray, bit for bit (V77: one expression)', () => {
    const tow = new SpeedboatTow(25, 1);
    tow.advanceTo(25 * 4);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hw = (tow as any).hw;
    const f = new Float64Array(FX_LEN + 8);
    writeBoatFx(hw, tow.pose, f, 8);
    const fx = readBoatFx(f, 8, createBoatFx());
    const direct: PropWashInput[] = [];
    propWashFromHullWater(hw, tow.pose, direct);
    expect(fx.jets).toEqual(direct);
    expect(fx.jets.length).toBe(3);
    expect(fx.jets[0].thrust).toBeGreaterThan(1000);
    expect(fx.jets[0].lossPower).toBeGreaterThan(0);
    expect(f[8 + FX.DRIVE + FX_DRIVE.THRUST]).toBe(direct[0].thrust);
    expect(fx.bow.flux).toBeGreaterThan(0);
    expect(hullWaterSamples(hw.wake).length).toBeGreaterThan(0);
  });
});

describe('§T.195 effects are captured when a request is first seen home — by the NPC driver\'s poll or by the accessor', () => {
  const place = (fleet: BoatFleet): void => {
    for (let i = 0; i < 2; i++) fleet.place(i, { position: [i * 30, 0.1, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 10], angularVelocity: [0, 0, 0] });
  };
  it('poll() alone (the driver\'s collect) refreshes the snapshot a caller already holds', async () => {
    const p = params();
    const fleet = new BoatFleet({ boats: 2, kind: 'main', seed: SEED, oceanParams: p.ocean, seaParams: p.sea });
    await fleet.ready;
    place(fleet);
    const held = fleet.effects(1);
    expect(held.tick).toBe(-1);
    for (let t = 0; t < 3; t++) {
      fleet.setControls(1, 1, 0);
      fleet.kick(t, t * SIM_DT, p.ocean, p.sea);
      expect(fleet.poll()).toBe(true);
      expect(held.tick).toBe(t);
    }
    expect(held.wake.length).toBeGreaterThan(0);
    fleet.dispose();
  });
  it('the accessor alone refreshes after a request came home (no poll, no done)', async () => {
    const p = params();
    const fleet = new BoatFleet({ boats: 2, kind: 'main', seed: SEED, oceanParams: p.ocean, seaParams: p.sea });
    await fleet.ready;
    place(fleet);
    for (let t = 0; t < 3; t++) {
      fleet.kick(t, t * SIM_DT, p.ocean, p.sea);
      expect(fleet.effects(0).tick).toBe(t);
    }
    fleet.dispose();
  });
});

describe('§T.195 / §V2 the per-tick wake source buffer is identical on every transport, batched or not', () => {
  let spawn: () => WorkerPort;
  const runs: Record<string, EffectsRun> = {};

  beforeAll(async () => {
    spawn = await nodeSpawner(await buildWorkerBundle('effects'));
  }, 120_000);

  afterAll(() => {
    // eslint-disable-next-line no-console
    console.info('[simWorkerEffects]', Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, `final ${r.final.toString(16)} jets ${r.jets} thrust ${r.thrust.toFixed(0)} samples ${r.wakeSamples} bowFlux ${r.bowFlux.toFixed(2)}`])));
  });

  it('main thread: the rivals publish what the page needs — 3 jets under thrust, wake samples, lifted spray', async () => {
    const r = await run('main', 1, undefined, 1);
    runs.main = r;
    expect(r.perTick.size).toBe(TICKS);
    expect(r.jets).toBe(BOATS * 3);
    expect(r.thrust).toBeGreaterThan(BOATS * 3 * 500);
    expect(r.wakeSamples).toBeGreaterThan(BOATS * 10);
    expect(r.bowFlux).toBeGreaterThan(0);
  }, 120_000);

  for (const [name, kind, workers] of [
    ['sab×1', 'sab', 1],
    ['sab×2', 'sab', 2],
    ['transfer×1', 'transfer', 1],
  ] as const) {
    it(`${name}: every tick's source buffer hash equals the main thread's`, async () => {
      const r = await run(kind, workers, spawn, 1);
      runs[name] = r;
      expect(r.final).toBe(runs.main.final);
      expect([...r.perTick.entries()]).toEqual([...runs.main.perTick.entries()]);
    }, 120_000);
  }

  it('batched (4 ticks per request, main and sab×1): the effects are the request\'s last step — the same hash that tick had unbatched', async () => {
    for (const [name, kind, sp] of [['main/4', 'main', undefined], ['sab×1/4', 'sab', spawn]] as const) {
      const r = await run(kind, 1, sp, 4);
      runs[name] = r;
      expect(r.final).toBe(runs.main.final);
      expect(r.perTick.size).toBeGreaterThan(30);
      for (const [tick, h] of r.perTick) expect(h, `tick ${tick}`).toBe(runs.main.perTick.get(tick));
    }
  }, 240_000);
});
