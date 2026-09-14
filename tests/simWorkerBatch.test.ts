/**
 * §T.181 S0 / §V2 / §V110 — THE MULTI-TICK KICK: a fleet that trails the page catches up without changing a bit.
 *
 * WHY: the page kicks the rivals' physics at the end of a tick and collects in the next frame. With one tick per
 * round trip a 20 fps page (3 ticks a frame) or a hidden tab's catch-up frames leave the rivals further behind every
 * frame, and the old driver finally DROPPED ticks it could no longer time — a rival that skips sim time is a rival on
 * a different trajectory (V2) and, while it trails, on a different sea (V110). The fix sends every owed tick in one
 * request, each row carrying the inputs of ITS tick. That is only a fix if the rows are unrolled exactly as one-tick
 * kicks would have been, so every test here compares against the reference the V2 suite trusts: the main-thread
 * transport stepped ONE tick per kick, hashed (FNV-1a over every boat's OUT block) after every tick.
 *
 *  - 20 fps: three ticks per frame, results visible only after a frame boundary (a worker finishing in the render
 *    gap), pumped at tick end and frame end like main-speedboat.ts; a params change (choppiness) lands while the
 *    fleet trails.
 *  - hidden-tab burst: 360 page ticks recorded with no pump at all, a wind shift in the middle of it (the spectrum
 *    rebuild arms, builds and swaps inside the backlog), then catch-up.
 *  - a small budget: the same trajectory in more, smaller requests, each within its budget.
 *  - real worker_threads (sab ×1, sab ×2, transfer ×1): the stepper-side unroll in workerHost, and the PREV POSE the
 *    render interpolates from, which must be the stepper's own pose one tick before the request's last.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SIM_DT } from '../src/core/loop';
import { oceanParams, type OceanParams } from '../src/params/ocean';
import { seaPhysicsParams, type SeaPhysicsParams } from '../src/params/seaPhysics';
import type { Rigid6State } from '../src/sea-physics/rigidBody';
import { BoatFleet } from '../src/sim-worker/fleet';
import { BoatSimLayout, B, POSE_LEN, layoutByteLength, type LayoutSpec } from '../src/sim-worker/layout';
import { paramsLength, writeParams } from '../src/sim-worker/paramsVector';
import type { TransportKind, WorkerPort } from '../src/sim-worker/transport';
import { createNpcFleetDriver, type NpcFleet } from '../src/speedboat/page/npcFleet';
import { buildWorkerBundle, nodeSpawner } from './simWorkerNode';

const SEED = 181;
const BOATS = 3;
const FPS20_TICKS = 120;
const BURST_END = 480;
const CHOP_TICK = 50;
const WIND_TICK = 300;

const ctl = (i: number, k: number): { throttle: number; steer: number } => ({
  throttle: Math.min(1, k / 120) * (0.55 + 0.06 * i),
  steer: Math.sin(k * 0.013 + i) * 0.6,
});

function freshParams(): { ocean: OceanParams; sea: SeaPhysicsParams } {
  return { ocean: structuredClone(oceanParams), sea: { ...structuredClone(seaPhysicsParams), hullDraft: 0.5 } };
}

/** the page's param moves, applied BEFORE tick k is recorded/stepped (weather.update runs before the physics) */
function moveParams(p: { ocean: OceanParams }, k: number): void {
  if (k === CHOP_TICK) p.ocean.choppiness *= 0.9;
  if (k === WIND_TICK) p.ocean.windSpeed += 3;
}

const spawnPose = (i: number): Rigid6State => ({
  position: [i * 40 - 40, 0.1, (i % 2) * 30],
  quaternion: [0, Math.sin(i * 0.2), 0, Math.cos(i * 0.2)],
  velocity: [Math.sin(i * 0.4) * (4 + i), 0, Math.cos(i * 0.4) * (4 + i)],
  angularVelocity: [0, 0, 0],
});

const blankPose = (): Rigid6State => ({ position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] });

interface Reference {
  /** hash after page tick k (index k; [0] = before any step) */
  hash: number[];
  /** boat poses after tick k */
  poses: Rigid6State[][];
  times: number[];
}

async function reference(ticks: number): Promise<Reference> {
  const p = freshParams();
  const fleet = new BoatFleet({ boats: BOATS, kind: 'main', seed: SEED, oceanParams: p.ocean, seaParams: p.sea });
  await fleet.ready;
  for (let i = 0; i < BOATS; i++) fleet.place(i, spawnPose(i));
  const ref: Reference = { hash: [NaN], poses: [[]], times: [0] };
  let time = 0;
  for (let k = 1; k <= ticks; k++) {
    time += SIM_DT;
    moveParams(p, k);
    for (let i = 0; i < BOATS; i++) {
      const c = ctl(i, k);
      fleet.setControls(i, c.throttle, c.steer);
    }
    fleet.kick(k, time, p.ocean, p.sea);
    await fleet.done();
    ref.hash.push(fleet.hash());
    ref.times.push(time);
    ref.poses.push(Array.from({ length: BOATS }, (_, i) => fleet.readPose(i, blankPose())));
  }
  fleet.dispose();
  return ref;
}

let REF: Reference;
beforeAll(async () => {
  REF = await reference(BURST_END);
}, 180_000);

/**
 * The page pattern on the in-process transport, with round trips made late on purpose: a request kicked in frame f
 * is visible from frame f + 1 on (poll gated), as a worker finishing in the render gap would be.
 */
async function drivePage(budgetMs: number): Promise<{ npc: NpcFleet; checkpoints: number; maxLag: number; overBudget: number; framesToCatchUp: number }> {
  const p = freshParams();
  const npc = await createNpcFleetDriver({
    seed: SEED, boats: BOATS, oceanParams: p.ocean, seaParams: p.sea, spawn: spawnPose, controls: ctl,
    caps: { crossOriginIsolated: false, sharedArrayBuffer: false, worker: false },
    budgetMs,
  });
  const fleet = npc.fleet;
  expect(fleet.kind).toBe('main');
  let frame = 0;
  let kickFrame = -1;
  const t = fleet.transport;
  const realPoll = t.poll.bind(t);
  const realKick = t.kick.bind(t);
  t.poll = () => realPoll() && frame > kickFrame;
  t.kick = () => {
    kickFrame = frame;
    realKick();
  };
  let checkpoints = 0;
  let overBudget = 0;
  const realKickBatch = fleet.kickBatch.bind(fleet);
  fleet.kickBatch = (n: number) => {
    // collect has just run: the buffer holds tick `collectedTick` — the V2 checkpoint
    const k = npc.collectedTick;
    if (k > 0) {
      expect(fleet.hash().toString(16), `hash at collected tick ${k}`).toBe(REF.hash[k].toString(16));
      checkpoints++;
    }
    realKickBatch(n);
    if (npc.catchUp.lastBatch > npc.catchUp.budgetTicks) overBudget++;
  };
  let tick = 0;
  let maxLag = 0;
  const runTick = (pump: boolean): void => {
    tick++;
    moveParams(p, tick);
    npc.recordTick(tick, REF.times[tick]);
    if (pump) npc.pump(tick);
    maxLag = Math.max(maxLag, npc.lagTicks);
  };
  // 20 fps: 3 ticks a frame, pump at each tick end and at the frame end
  while (tick < FPS20_TICKS) {
    for (let s = 0; s < 3; s++) runTick(true);
    npc.pump(tick);
    frame++;
  }
  // hidden tab: the backlog piles up with nothing pumped
  while (tick < BURST_END) runTick(false);
  // visible again, no new ticks (the tab resumes; the page's own new ticks are the 20 fps case above)
  let framesToCatchUp = 0;
  while (npc.collectedTick < BURST_END && framesToCatchUp < 2000) {
    npc.pump(tick);
    frame++;
    framesToCatchUp++;
  }
  npc.pump(tick); // the last collect
  expect(npc.collectedTick).toBe(BURST_END);
  expect(npc.lagTicks).toBe(0);
  expect(fleet.hash().toString(16)).toBe(REF.hash[BURST_END].toString(16));
  return { npc, checkpoints, maxLag, overBudget, framesToCatchUp };
}

describe('§T.181 multi-tick kick: a trailing fleet is tick-exact against one tick per kick (§V2, §V110)', () => {
  it('20 fps pattern + a 360-tick hidden-tab burst, params moved while trailing: every collected tick hashes like the reference, none dropped', async () => {
    const r = await drivePage(1e6);
    // it really trailed, and it really batched: 3 ticks per request at 20 fps, cap-sized requests in the burst
    expect(r.maxLag).toBeGreaterThanOrEqual(360);
    expect(r.npc.catchUp.maxBatch).toBe(60);
    expect(r.checkpoints).toBeGreaterThan(40);
    // the burst is repaid in ⌈360 / 60⌉ requests, one per frame — not 360 round trips
    expect(r.framesToCatchUp).toBeLessThanOrEqual(8);
    expect(r.overBudget).toBe(0);
    r.npc.dispose();
  }, 180_000);

  it('a small budget changes the number of requests, never the trajectory; every request fits its budget', async () => {
    const r = await drivePage(6);
    expect(r.overBudget).toBe(0);
    expect(r.checkpoints).toBeGreaterThan(40);
    r.npc.dispose();
  }, 180_000);

  it('a layout without batchCap is byte-identical to the pre-§T.181 layout; with it, the BATCH region lies past every boat block', () => {
    const spec: LayoutSpec = { boats: 4, wakeCap: 8, oceanLen: paramsLength(oceanParams), seaLen: paramsLength(seaPhysicsParams) };
    const plain = new BoatSimLayout(new ArrayBuffer(layoutByteLength(spec)), spec);
    expect(plain.spec).toEqual(spec);
    // 20 = the Float64 header of layout v2 (§T.191 added EXTERNAL_BOATS / TRACE_LEN + 2 reserved; v1 was 16)
    expect(layoutByteLength(spec)).toBe((20 + spec.oceanLen + spec.seaLen + 4 * POSE_LEN + 4 * (B.WAKE + 8 * 5)) * 8);
    const batched = new BoatSimLayout(new ArrayBuffer(layoutByteLength({ ...spec, batchCap: 5 })), { ...spec, batchCap: 5 });
    expect(batched.boatOffset(3)).toBe(plain.boatOffset(3));
    expect(batched.batchOffset()).toBe(plain.boatOffset(3) + plain.blockLength);
    expect(batched.batchRowOffset(4) + (batched.batchRowOffset(1) - batched.batchRowOffset(0))).toBe(layoutByteLength({ ...spec, batchCap: 5 }) / 8);
    // the stepper side adopts the cap from the header
    expect(new BoatSimLayout(batched.buffer).spec.batchCap).toBe(5);
  });
});

describe('§T.181 multi-tick kick on real worker_threads', () => {
  let spawn: () => WorkerPort;
  const seen: Record<string, number> = {};

  beforeAll(async () => {
    spawn = await nodeSpawner(await buildWorkerBundle('batch'));
  }, 120_000);

  afterAll(() => {
    // eslint-disable-next-line no-console
    console.info('[simWorkerBatch] checkpoints', seen);
  });

  /** requests of 1, then 3s (20 fps), then a cap-sized backlog across the wind shift, then the rest */
  const plan = (): number[] => {
    const sizes = [1];
    let k = 1;
    while (k + 3 <= FPS20_TICKS) {
      sizes.push(3);
      k += 3;
    }
    while (k < 360) {
      const n = Math.min(48, 360 - k);
      sizes.push(n);
      k += n;
    }
    return sizes;
  };

  for (const [name, kind, workers] of [
    ['sab×1', 'sab', 1],
    ['sab×2', 'sab', 2],
    ['transfer×1', 'transfer', 1],
  ] as const) {
    it(`${name}: batched requests hash like one tick per kick at every request end, and PREV POSE is the stepper's tick k−1 pose`, async () => {
      const p = freshParams();
      const fleet = new BoatFleet({ boats: BOATS, kind: kind as TransportKind, workers, spawn, seed: SEED, oceanParams: p.ocean, seaParams: p.sea, batchCap: 48 });
      try {
        await fleet.ready;
        expect(fleet.maxBatch).toBe(48); // no WORLD reader: shards may batch too
        for (let i = 0; i < BOATS; i++) fleet.place(i, spawnPose(i));
        const vec = new Float64Array(fleet.spec.oceanLen + fleet.spec.seaLen);
        let k = 0;
        let compared = 0;
        const out: Rigid6State = blankPose();
        for (const n of plan()) {
          for (let j = 0; j < n; j++) {
            const tick = k + 1 + j;
            moveParams(p, tick);
            writeParams(p.ocean, vec, 0);
            writeParams(p.sea, vec, fleet.spec.oceanLen);
            fleet.setBatchTick(j, tick, REF.times[tick], vec);
            for (let i = 0; i < BOATS; i++) {
              const c = ctl(i, tick);
              fleet.setBatchControls(j, i, c.throttle, c.steer);
            }
          }
          fleet.kickBatch(n);
          await fleet.done();
          k += n;
          expect(fleet.lastKickTicks()).toBe(n);
          expect(fleet.hash().toString(16), `${name} hash at tick ${k}`).toBe(REF.hash[k].toString(16));
          if (n > 1) {
            for (let i = 0; i < BOATS; i++) expect(fleet.readBatchPrevPose(i, out)).toEqual(REF.poses[k - 1][i]);
          }
          compared++;
        }
        expect(k).toBe(360);
        seen[name] = compared;
      } finally {
        fleet.dispose();
      }
    }, 180_000);
  }
});
