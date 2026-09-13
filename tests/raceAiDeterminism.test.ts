/**
 * §V2 / §T.186 — NPC pilots inside the step core give the SAME race on every transport.
 *
 * WHY: the pilot runs where the physics runs — in-process on the main thread, or on worker threads behind a
 * SharedArrayBuffer or transferable ping-pong — and a replay, a results screen or a rival's crash must not depend
 * on which one the browser granted or how boats were sharded. The pilot reads other boats only from the tick-k
 * WORLD snapshot (never another shard's OUT block, which is being written concurrently) and keeps its memory in
 * the buffer, so this must hold bit for bit: same hash chain over every boat's OUT block incl. the AI memory, same
 * positions every second, same lap times. Real `worker_threads` against a Vite bundle (tests/simWorkerNode.ts),
 * two shards on the SAB path so rivals read each other across a shard boundary.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { WorkerPort } from '../src/sim-worker/transport';
import { runRace, type RaceOptions, type RaceResult } from './raceAiHarness';
import { buildWorkerBundle, nodeSpawner } from './simWorkerNode';

const OPTS: RaceOptions = { roster: ['hothead', 'rookie', 'blocker'], sea: 'calm', laps: 1, seed: 1860, gridGap: 12 };

const summary = (r: RaceResult): unknown => ({
  hash: r.hash.toString(16),
  ticks: r.ticks,
  order: r.order,
  positions: r.positions,
  laps: r.racers.map((x) => x.lapTimes),
  finish: r.racers.map((x) => x.finishTime),
  missed: r.racers.map((x) => x.missed),
});

describe('§V2 NPC pilots: identical race on main thread, SAB workers and transferable workers', () => {
  let spawn: () => WorkerPort;
  let main: RaceResult;

  beforeAll(async () => {
    const [s, m] = await Promise.all([buildWorkerBundle('race-ai-determinism').then(nodeSpawner), runRace({ ...OPTS, kind: 'main' })]);
    spawn = s;
    main = m;
  }, 1_500_000);

  it('the main-thread race is a real race: laps completed, positions changed, controls came from the pilots', () => {
    for (const x of main.racers) expect(x.lapTimes.length, x.archetype).toBe(1);
    const standings = new Set(main.positions.map((p) => p.slice(1).join(',')));
    expect(standings.size, 'positions changed during the race').toBeGreaterThan(1);
    expect(Math.max(...main.racers.map((x) => x.maxThrottle))).toBeGreaterThan(0.5);
  });

  it('sab × 2 workers and transfer × 1 worker: same hash chain, positions and lap times as the main thread', async () => {
    const [sab, transfer] = await Promise.all([runRace({ ...OPTS, kind: 'sab', workers: 2, spawn }), runRace({ ...OPTS, kind: 'transfer', workers: 1, spawn })]);
    expect(summary(sab)).toEqual(summary(main));
    expect(summary(transfer)).toEqual(summary(main));
  }, 1_500_000);
});
