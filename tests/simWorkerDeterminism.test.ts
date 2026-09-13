/**
 * §T.178 / §V2 / §V110 — NPC physics off the main thread must not change a single bit.
 *
 * WHY: the user's rule is "every racer feels the same sea at the same fidelity", and the cost
 * is moved, never cut. Moving it is only safe if the move is invisible: the same seed, params
 * and controls must give the SAME SimState whether the eight boats were stepped in-process,
 * on a SharedArrayBuffer worker, on two, or on a transferable ping-pong worker. If any of them
 * differs, a replay (V2) diverges and a rival's sea depends on the machine's thread count.
 *
 * The worker paths run on REAL `worker_threads` threads against a Vite bundle of the worker
 * host (tests/simWorkerNode.ts) — the transport is exercised for real, not simulated. The run
 * includes a mid-race params change (a wind shift), so the spectrum arm/build/swap schedule has
 * to cross the transport as a tick input too (the swap lands at tick ~241, so a worker that
 * missed the change would float on the old sea and break the hash), and throttle + steering so
 * the boats are under way rather than bobbing. (The adaptive substep rule stays at 2 for this
 * hull below ~100 m/s — measured, every tick of the run; its count is still compared.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SIM_DT } from '../src/core/loop';
import { SpectrumScheduler } from '../src/ocean/spectrumRebuild';
import { oceanParams, type OceanParams } from '../src/params/ocean';
import { seaPhysicsParams, type SeaPhysicsParams } from '../src/params/seaPhysics';
import { CpuOcean } from '../src/sea-physics/cpuOcean';
import { HULL_WATER_DEFAULTS } from '../src/sea-physics/hullWater';
import { BoatFleet } from '../src/sim-worker/fleet';
import { B, F, HASH_SEED } from '../src/sim-worker/layout';
import type { TransportKind, WorkerPort } from '../src/sim-worker/transport';
import { buildWorkerBundle, nodeSpawner } from './simWorkerNode';

const SEED = 178;
const BOATS = 8;
const TICKS = 600;
const WIND_SHIFT_TICK = 200;

function freshParams(): { ocean: OceanParams; sea: SeaPhysicsParams } {
  // speedboat-like Smith depth (V105); a copy, so nothing here reads the live singletons
  return { ocean: structuredClone(oceanParams), sea: { ...structuredClone(seaPhysicsParams), hullDraft: 0.5 } };
}

interface Run {
  hash: number;
  substeps: number[];
  maxSpeed: number;
  wakeOverflow: number;
  fidelity: number[];
  stepMs: number;
}

async function race(kind: TransportKind, workers: number, spawn?: () => WorkerPort, ticks = TICKS, controlScale = 1): Promise<Run> {
  const p = freshParams();
  const fleet = new BoatFleet({ boats: BOATS, kind, workers, spawn, seed: SEED, oceanParams: p.ocean, seaParams: p.sea });
  try {
    await fleet.ready;
    for (let i = 0; i < BOATS; i++) {
      const yaw = i * 0.4;
      fleet.place(i, {
        position: [i * 40 - 140, 0.1, (i % 2) * 30],
        quaternion: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
        velocity: [Math.sin(yaw) * (4 + i), 0, Math.cos(yaw) * (4 + i)],
        angularVelocity: [0, 0, 0],
      });
    }
    let h = HASH_SEED;
    let time = 0;
    let maxSpeed = 0;
    let wakeOverflow = 0;
    let stepMs = 0;
    const substeps: number[] = [];
    for (let tick = 0; tick < ticks; tick++) {
      if (tick === WIND_SHIFT_TICK) p.ocean.windSpeed += 3; // arms a rebuild: 15 ticks + 26 build ticks, then the swap
      for (let i = 0; i < BOATS; i++) {
        fleet.setControls(i, controlScale * Math.min(1, tick / 240) * (0.55 + 0.06 * i), controlScale * Math.sin(tick * 0.013 + i) * 0.6);
      }
      fleet.kick(tick, time, p.ocean, p.sea);
      await fleet.done();
      h = fleet.hash(h);
      stepMs += fleet.stepMs();
      time += SIM_DT;
      for (let i = 0; i < BOATS; i++) {
        substeps.push(fleet.readOut(i, B.SUBSTEPS));
        wakeOverflow += fleet.readOut(i, B.WAKE_OVERFLOW);
        const L = fleet.layoutOf(i);
        const o = L.boatOffset(i) + B.POSE + 7;
        maxSpeed = Math.max(maxSpeed, Math.hypot(L.f64[o], L.f64[o + 1], L.f64[o + 2]));
      }
    }
    const L0 = fleet.transport.layouts[0];
    const fidelity = [F.PATCH_SPACING, F.PATCH_MARGIN, F.PATCH_MAX_AXIS, F.MIRROR_RESOLUTION, F.INVERSE_DISPLACEMENT_ITERATIONS, F.UPDATE_EVERY_TICKS].map(
      (k) => L0.f64[k],
    );
    for (const L of fleet.transport.layouts) {
      expect([F.PATCH_SPACING, F.PATCH_MARGIN, F.PATCH_MAX_AXIS, F.MIRROR_RESOLUTION].map((k) => L.f64[k])).toEqual(fidelity.slice(0, 4));
    }
    return { hash: h, substeps, maxSpeed, wakeOverflow, fidelity, stepMs };
  } finally {
    fleet.dispose();
  }
}

describe('§V2 NPC physics: bit-identical across main thread, SAB workers and transferable workers', () => {
  let spawn: () => WorkerPort;
  const runs: Partial<Record<string, Run>> = {};

  beforeAll(async () => {
    spawn = await nodeSpawner(await buildWorkerBundle('determinism'));
  }, 120_000);

  afterAll(() => {
    // eslint-disable-next-line no-console
    console.info(
      '[simWorker] hashes',
      Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, `${r!.hash.toString(16)} stepMs/tick=${(r!.stepMs / TICKS).toFixed(2)}`])),
    );
  });

  it('main thread (the fallback) runs a race that exercises what is compared: boats plane, controls matter, nothing is dropped', async () => {
    const r = await race('main', 1);
    runs.main = r;
    // a fleet sitting at rest would compare the easy case; the stand-in drive must get them going
    expect(r.maxSpeed).toBeGreaterThan(8);
    // the substep count is the adaptive rule's (2..4), published per boat per tick and compared below
    expect(Math.min(...r.substeps)).toBeGreaterThanOrEqual(2);
    expect(Math.max(...r.substeps)).toBeLessThanOrEqual(4);
    expect(r.wakeOverflow).toBe(0);
    // the controls array is an input the hash can see: throttle/steer off gives another race
    const idle = await race('main', 1, undefined, 60, 0);
    const driven = await race('main', 1, undefined, 60, 1);
    expect(idle.hash).not.toBe(driven.hash);
  }, 120_000);

  it('the main-thread path runs FULL fidelity: the 0.8 m patch and the mirror the page floats on (§V110)', () => {
    const r = runs.main!;
    expect(r.fidelity[0]).toBe(HULL_WATER_DEFAULTS.patchSpacing);
    expect(r.fidelity[0]).toBeLessThanOrEqual(0.8);
    expect(r.fidelity[1]).toBe(HULL_WATER_DEFAULTS.patchMargin);
    expect(r.fidelity[2]).toBe(HULL_WATER_DEFAULTS.patchMaxAxis);
    expect(r.fidelity[3]).toBe(seaPhysicsParams.mirrorResolution);
  });

  for (const [name, kind, workers] of [
    ['sab×1', 'sab', 1],
    ['sab×2', 'sab', 2],
    ['transfer×1', 'transfer', 1],
    ['transfer×2', 'transfer', 2],
  ] as const) {
    it(`${name}: same 600-tick × 8-boat hash, same substep sequence, same fidelity as the main thread`, async () => {
      const r = await race(kind, workers, spawn);
      runs[name] = r;
      const m = runs.main!;
      expect(r.hash.toString(16)).toBe(m.hash.toString(16));
      expect(r.substeps).toEqual(m.substeps);
      expect(r.fidelity).toEqual(m.fidelity);
    }, 120_000);
  }
});

describe('§V110 the NPC mirror is the page mirror', () => {
  it('a core-owned scheduler and a GPU-shared scheduler advanced by the page give the same sea, through a rebuild', () => {
    // WHY: the player floats on `new CpuOcean(seed, p, s, ocean.spectrum)` (the GPU's scheduler,
    // advanced by OceanSimulation before cpuOcean.update); NPCs float on a core that owns its
    // scheduler. "Same sea" is only true if the two schedules agree tick for tick, including
    // the arm/build/swap after a params change — built on the same tick from the same params.
    const a = freshParams();
    const b = freshParams();
    const shared = new SpectrumScheduler(SEED, b.ocean);
    const page = new CpuOcean(SEED, b.ocean, b.sea, shared);
    const npc = new CpuOcean(SEED, a.ocean, a.sea);
    let time = 0;
    let compared = 0;
    for (let tick = 0; tick < 90; tick++) {
      if (tick === 20) {
        a.ocean.windSpeed += 3;
        b.ocean.windSpeed += 3;
      }
      shared.advance(b.ocean); // OceanSimulation.advanceSpectrum, then the mirror (main.ts order)
      page.update(time);
      npc.update(time);
      for (const [x, z] of [[0, 0], [37.5, -12.25], [-210, 330]]) {
        expect(npc.pressureHeadAt(x, z, time)).toBe(page.pressureHeadAt(x, z, time));
        expect(npc.heightAt(x, z, time)).toBe(page.heightAt(x, z, time));
        compared++;
      }
      time += SIM_DT;
    }
    expect(compared).toBe(270);
    // and the rebuild really landed inside the window (20 + 15 arm + 26 build < 90)
    expect(shared.building).toBe(false);
    expect(shared.current.params.windSpeed).toBe(b.ocean.windSpeed);
  }, 60_000);
});
