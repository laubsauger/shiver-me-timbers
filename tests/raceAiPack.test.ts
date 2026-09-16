/**
 * §T.186/§T.213 — the seven couriers race each other on real physics, on SIX seeds × two seas: they race cleanly
 * (crashes rare and never more than one in a race, gates rarely missed — the bound is measured, see below), they are not
 * one boat, and the pack stays close WITHOUT rubber-banding.
 *
 * WHY: design doc §4 / USER: "no speed rubber-banding — trailing NPCs take riskier lines instead". The only honest
 * catch-up is one a player could copy: a tighter line, later braking, less margin. So the A/B is the same race with
 * the catch-up gain on and off, and the thing that must NOT exist is a thrust path: the pilot's only outputs are a
 * drive angle and the physics' own −0.3..1 throttle, and no AI source touches power.
 *
 * WHY MANY SEEDS (§T.213): with one seed, "the archetype spread is > 1.5 s" and "the hothead out-laps the veteran" are
 * coin tosses — traffic compresses seven laps to ±1 s against a 10 s profile spread, and every policy tried failed them
 * on 2 of 3 other seeds (docs/speedboat/npc-ai.md). Across seeds the same statements are statements about the POLICY:
 * they are asserted on the median over the seeds, while the clean-racing bounds (crashes, misses, finishers) hold per race.
 * The full sweep (12+ seeds, Tower Reach as well) is `node scripts/race-ai-sweep.mjs`.
 *
 * The races run on real worker threads (sab transport), four at a time — the path the page uses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import aiBlockSrc from '../src/race/ai/aiBlock.ts?raw';
import archetypesSrc from '../src/race/ai/archetypes.ts?raw';
import capabilitySrc from '../src/race/ai/capability.ts?raw';
import lineSrc from '../src/race/ai/line.ts?raw';
import pilotSrc from '../src/race/ai/pilot.ts?raw';
import profileSrc from '../src/race/ai/profile.ts?raw';
import stepCoreSrc from '../src/sim-worker/stepCore.ts?raw';
import { ARCHETYPE_ORDER } from '../src/race/ai/archetypes';
import type { WorkerPort } from '../src/sim-worker/transport';
import { runRace, type RaceResult, type SeaState } from './raceAiHarness';
import { buildWorkerBundle, nodeSpawner } from './simWorkerNode';

const SEEDS = [101, 102, 103, 104, 105, 106];
const SEAS: SeaState[] = ['calm', 'working'];
/**
 * The design band, design doc §4: median P1–P8 gap ≤ 25 s over a race (3 laps). It is NOT a per-lap rate, and these races
 * are one lap: spread is (grid stagger) + (the queue's own length) + (skill difference × laps) and only the last term
 * repeats, so the same policy measures 11.5 s at one lap and 14.7 s at three (docs/speedboat/npc-ai.md §T.213 follow-up).
 * So the bound here is the measured width of the 1-lap policy, not 25/3: §T.213 follow-up sweep, 24 seeds × two seas,
 * median 11.5 / 11.6 s, worst 15.4 s.
 */
const SPREAD_BAND = 17;
/** m of grid row spacing: the page's rolling start (race/params start.rowSpacing) */
const GRID_GAP = 30;

const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const lapOf = (r: RaceResult, id: string): number => r.racers.find((x) => x.archetype === id)!.lapTimes[0] ?? NaN;
const spread = (r: RaceResult): number => {
  const fin = r.racers.map((x) => x.finishTime);
  return Math.max(...fin) - Math.min(...fin);
};

async function inBatches<T>(n: number, jobs: (() => Promise<T>)[]): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < jobs.length) {
        const k = next++;
        out[k] = await jobs[k]();
      }
    }),
  );
  return out;
}

describe('§T.213 the pack across seeds, real physics', () => {
  const jobs = SEAS.flatMap((sea) => SEEDS.map((seed) => ({ sea, seed })));
  let runs: RaceResult[];
  let on: RaceResult;
  let off: RaceResult;

  beforeAll(async () => {
    const spawn: () => WorkerPort = await nodeSpawner(await buildWorkerBundle('race-ai-pack'));
    const race = (sea: SeaState, seed: number, catchUp: boolean): Promise<RaceResult> =>
      runRace({ roster: [...ARCHETYPE_ORDER], sea, laps: 1, seed, catchUp, gridGap: GRID_GAP, kind: 'sab', spawn });
    runs = await inBatches(4, jobs.map((j) => () => race(j.sea, j.seed, true)));
    [on, off] = await Promise.all([race('working', SEEDS[0], true), race('working', SEEDS[0], false)]);
  }, 3_600_000);

  afterAll(() => {
    if (!runs) return;
    // eslint-disable-next-line no-console
    console.info(runs.map((r, k) => `[raceAi pack] ${jobs[k].sea} ${jobs[k].seed}: ${r.racers.map((x) => `${x.archetype} ${x.lapTimes[0]?.toFixed(1)}`).join(', ')} spread ${spread(r).toFixed(1)}`).join('\n'));
  });

  it('every courier finishes every race, crashes are rare and never more than one in a race, and gates are rarely missed', () => {
    let crashed = 0;
    let missed = 0;
    runs.forEach((r, k) => {
      const tag = `${jobs[k].sea} seed ${jobs[k].seed}`;
      let inRace = 0;
      for (const x of r.racers) {
        expect(x.lapTimes.length, `${tag} ${x.archetype}`).toBe(1);
        expect(x.stuck, `${tag} ${x.archetype}`).toBe(0);
        inRace += x.crashes;
        missed += x.missed;
      }
      expect(inRace, `${tag}: ${r.racers.flatMap((x) => x.events).join(' | ')}`).toBeLessThanOrEqual(1);
      if (inRace > 0) crashed++;
    });
    // §T.213 acceptance: a crash in no more than 1 race in 10 (the sweep measures 2 in 48 over 24 seeds)
    expect(crashed, `${crashed} of ${runs.length} races had a crash`).toBeLessThanOrEqual(Math.floor(0.1 * runs.length));
    // MISSED GATES ARE NOT ZERO HERE, and the bound says how far from zero (§T.213, docs/speedboat/npc-ai.md). §T.213
    // measured ~1 marginal miss per 5 races on the 36 m chicane; those went with the re-measured turning table of
    // 2026-09-16, and the §T.213 follow-up sweep (24 seeds × two seas) now finds 2 in 48 — neither of them the chicane,
    // both a boat 36–58 m off her line under full catch-up risk, recovering after a knock, crossing the LAST gate wide.
    // Zero would be a bound this pilot does not meet, and pretending otherwise would hide the next regression.
    expect(missed, `${missed} missed gates over ${runs.length} races`).toBeLessThanOrEqual(3);
  });

  it('the pack stays inside the design band and the archetypes are not one boat', () => {
    const spreads = runs.map(spread);
    expect(median(spreads), `finish spreads ${spreads.map((x) => x.toFixed(1)).join(' / ')} s`).toBeLessThan(SPREAD_BAND);
    expect(Math.max(...spreads)).toBeLessThan(1.5 * SPREAD_BAND);
    // base risk is what separates them: over the seeds, the hothead out-laps the rookie and the field is not one class
    const at = (id: string): number => median(runs.map((r) => lapOf(r, id)));
    expect(at('hothead'), `hothead ${at('hothead').toFixed(1)} vs rookie ${at('rookie').toFixed(1)}`).toBeLessThan(at('rookie'));
    const laps = ARCHETYPE_ORDER.map((id) => at(id));
    expect(Math.max(...laps) - Math.min(...laps), 'distinct archetypes').toBeGreaterThan(1.5);
    expect(Math.max(...laps) / Math.min(...laps), 'one class of boat').toBeLessThan(1.25);
  });

  it('trailing-risk catch-up closes the pack — with no thrust multiplier anywhere', () => {
    expect(spread(on), `finish spread ON ${spread(on).toFixed(2)} s vs OFF ${spread(off).toFixed(2)} s`).toBeLessThan(spread(off));
    // NO THRUST PATH: the throttle every pilot applied is the physics' own range …
    for (const r of [...runs, on, off]) {
      for (const x of r.racers) {
        expect(x.maxThrottle).toBeLessThanOrEqual(1);
        expect(x.minThrottle).toBeGreaterThanOrEqual(-0.3);
      }
    }
    // … the pilot's outputs (drive angle, throttle and, since §T.207, the trim request through the player's own seam mapping)
    // reach the physics through setControls and nothing else …
    expect(stepCoreSrc).toMatch(/b\.hw\.setControls\(po\.steer, po\.throttle, unitTrimToRad\(po\.trim \?\? 0\)\);/);
    // … and no AI source names a power, thrust or drive parameter it could scale
    const forbidden = /powerW|STANDIN_THRUST|standInDrivePower|thrust|HullWater|setControls|params\s*\[|\.params\b/i;
    for (const [name, src] of Object.entries({ pilotSrc, profileSrc, capabilitySrc, archetypesSrc, lineSrc, aiBlockSrc })) {
      const hit = src.split('\n').find((l) => forbidden.test(l) && !/^\s*(\*|\/\/|\/\*)/.test(l));
      expect(hit, name).toBeUndefined();
    }
  });
});
