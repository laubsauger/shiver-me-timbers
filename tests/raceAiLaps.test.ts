/**
 * §T.186/§T.213 — an NPC completes 3 laps on REAL physics, inside the real boat step core, without missing a gate —
 * on SEVERAL seeds, in both of the seas the race is run in.
 *
 * WHY: this is the whole chain at once — measured capability → racing line → speed profile → pure pursuit → the
 * core's pilot hook → HullWater drives → rigid6 — against gate detection written independently in the harness.
 * The rookie is the pilot under test on purpose: most seeded mistakes, least wave skill, shortest lookahead; a line
 * or controller that only works for a careful pilot is not a racing AI.
 *
 * WHY MANY SEEDS (§T.213): the seed moves the sea realisation AND the pilot's mistake dice. The single-seed version of
 * this test passed on its pinned seed and failed its lap-to-lap bound on 1–2 of 6 others (docs/speedboat/npc-ai.md) —
 * a bound that says nothing about the policy, only about which wave the rookie met. Each seed here must produce a clean
 * race (every element passed, no crash, no hook); the lap-to-lap stability that the seeded mistakes and off-line
 * recoveries add 3–6 s of noise to is asserted on the MEDIAN over the seeds, with a loose per-race ceiling.
 */
import { describe, expect, it } from 'vitest';
import { runRace, syntheticCourse, type SeaState } from './raceAiHarness';

const SEEDS = [101, 102, 103];
const SEAS: SeaState[] = ['calm', 'working'];
const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

describe('§T.213 NPC laps across seeds, real physics', () => {
  it('the rookie completes 3 laps of the 9-gate + 2-mark course on every seed and sea: every element passed, none missed, no hook, no crash', async () => {
    const course = syntheticCourse(3);
    const jobs = SEAS.flatMap((sea) => SEEDS.map((seed) => ({ sea, seed })));
    const runs = await Promise.all(jobs.map((j) => runRace({ roster: ['rookie'], sea: j.sea, laps: 3, seed: j.seed, course })));
    const drift: number[] = [];
    runs.forEach((r, k) => {
      const x = r.racers[0];
      const tag = `${jobs[k].sea} seed ${jobs[k].seed}`;
      expect(x.lapTimes.length, `${tag}: ${JSON.stringify(x.lapTimes)}`).toBe(3);
      expect(x.missed, `${tag}: ${x.missLog.join(' ')}`).toBe(0);
      // 11 elements per lap; the flying start crosses the start line once more than the laps
      expect(x.passed, tag).toBe(3 * course.elements.length + 1);
      expect(x.hooks, `${tag}: ${x.events.join(' | ')}`).toBe(0);
      expect(x.crashes, `${tag}: ${x.events.join(' | ')}`).toBe(0);
      expect(x.stuck, tag).toBe(0);
      drift.push(Math.abs(x.lapTimes[2] - x.lapTimes[1]) / x.lapTimes[1]);
    });
    // laps 2 and 3 both start from racing speed: the same lap to within the noise a seeded mistake costs (3–6 s ≈ 10 %),
    // and typically much less — a pilot that drifted off its line lap by lap would blow the median, not one bad realisation
    expect(median(drift), `lap 2→3 drift ${drift.map((d) => (100 * d).toFixed(1)).join(' / ')} %`).toBeLessThan(0.05);
    for (const d of drift) expect(d).toBeLessThan(0.12);
    // eslint-disable-next-line no-console
    console.info('[raceAi laps]', runs.map((r, k) => `${jobs[k].sea} ${jobs[k].seed}: ${r.racers[0].lapTimes.map((t) => t.toFixed(1)).join('/')}`).join(' | '));
  }, 1_800_000);
});
