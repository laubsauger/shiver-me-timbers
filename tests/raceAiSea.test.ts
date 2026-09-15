/**
 * §T.186/§T.213 — the NPCs in the speedboat's own seas (params/speedboatSea.ts): they finish their laps in the race
 * default (`working`, Hs ≈ 0.5 m) and in the dramatic one (`open`, Hs ≈ 1.5 m), they READ the water, and the sea costs
 * them time. Three seeds of each: never one realisation (§V50).
 *
 * WHY THIS CHANGED (§T.213). The old version raced the shipped default ocean — the weather ladder's `swell` rung, an
 * 11 m/s wind sea of Hs 2.8 m — in which the V-39 proxy capsized every 10–20 s under any pilot, and pinned the crash
 * counts of that (veteran ≤ 18, rookie ≤ 30 per lap) plus the ordering rookie > veteran. The race no longer runs that
 * sea: the B123 presets are long, low swell, and in them a lap costs 0–2 crashes, so the old bounds measured nothing.
 *
 * WHAT IS ASSERTED NOW, and what is NOT:
 *  - every boat finishes its lap and nobody is stuck: the sea must not end the race. No gate is missed in the working sea;
 *    in the open one a crest can throw a boat off its line across a pole (measured: 1 in 3 seeds × 6 boats);
 *  - crashes stay in single figures per boat (a crash loop or a pilot that stopped reading the water breaks this);
 *  - the wave read is LIVE in the open sea — a veteran (waveSkill 1) lifts for crests, and the same pilots run the open
 *    lap slower than the working one: sea respect is a policy, not a decoration;
 *  - NOT the design's "veteran never crashes / rookie crashes more". Measured over these seeds the two archetypes
 *    capsize about equally often in `open` (veterans 3, rookies 3 over 3 seeds), because what rolls a hull there is the
 *    physics log's open roll-damping gap (docs/speedboat/npc-ai.md, Open 1), not how the pilot reads the water. Pinning
 *    an ordering that the sea decides would be pinning a coin toss; the counts are printed instead.
 */
import { describe, expect, it } from 'vitest';
import { AI } from '../src/race/ai/aiBlock';
import { runRace, type SeaState } from './raceAiHarness';

const ROSTER = ['veteran', 'rookie', 'veteran', 'rookie', 'veteran', 'rookie'] as const;
const SEEDS = [201, 202, 203];
const mean = (v: number[]): number => v.reduce((a, b) => a + b, 0) / v.length;

async function seaRaces(sea: SeaState): Promise<{ lap: number[]; crashes: Record<string, number>; lift: number[]; missed: number; stuck: number }> {
  const runs = await Promise.all(
    SEEDS.map(async (seed) => {
      const maxLift = new Array(ROSTER.length).fill(0);
      const r = await runRace({
        roster: [...ROSTER], sea, laps: 1, seed, maxSeconds: 260, gridGap: 30,
        trace: (_tick, i, f) => {
          maxLift[i] = Math.max(maxLift[i], f.readAi(i, AI.WAVE_LIFT));
        },
      });
      // eslint-disable-next-line no-console
      console.info(`[raceAi sea] ${sea} ${seed}`, r.racers.map((x, i) => `${x.archetype} lap ${x.lapTimes[0]?.toFixed(1) ?? 'DNF'} crashes ${x.crashes} hooks ${x.hooks} scares ${x.scares} missed ${x.missed} lift≤${maxLift[i].toFixed(2)}`).join(' | '));
      return { r, maxLift };
    }),
  );
  const all = runs.flatMap((q) => q.r.racers);
  return {
    lap: all.map((x) => x.lapTimes[0] ?? NaN),
    crashes: { veteran: all.filter((x) => x.archetype === 'veteran').reduce((a, x) => a + x.crashes, 0), rookie: all.filter((x) => x.archetype === 'rookie').reduce((a, x) => a + x.crashes, 0) },
    lift: runs.flatMap((q) => q.maxLift),
    missed: all.reduce((a, x) => a + x.missed, 0),
    stuck: all.reduce((a, x) => a + x.stuck, 0),
  };
}

describe('§T.213 NPCs in the speedboat seas, real physics', () => {
  it('every boat finishes its lap in the working and the open sea, and the open sea costs them time', async () => {
    const [working, open] = await Promise.all([seaRaces('working'), seaRaces('open')]);
    for (const [name, q] of Object.entries({ working, open })) {
      expect(q.lap.every((t) => t > 0), `${name}: laps ${q.lap.map((t) => t?.toFixed(1)).join(' ')}`).toBe(true);
      expect(q.stuck, name).toBe(0);
    }
    // gates: none missed in the race's own sea; in the open one a boat thrown off its line by a crest may cross a pole
    // (measured: 1 miss in 3 seeds × 6 boats)
    expect(working.missed, 'working').toBe(0);
    expect(open.missed, 'open').toBeLessThanOrEqual(2);
    // the sea is what slows them: the same pilots, the same course, one sea state apart
    expect(mean(open.lap), `open ${mean(open.lap).toFixed(1)} s vs working ${mean(working.lap).toFixed(1)} s`).toBeGreaterThan(mean(working.lap));
    // the wave read is live in the open sea (a pilot that never lifts is not reading it); the working sea is gentle
    // enough that nobody needs to (measured: lift stays ≤ 0.01 there)
    expect(Math.max(...open.lift), 'a pilot lifts for a crest in the open sea').toBeGreaterThan(0.3);
    // bounds, not a rate someone typed in: ~1.5× the measured worst (veterans 3, rookies 3 over the three seeds)
    expect(open.crashes.veteran + open.crashes.rookie, `open crashes veteran ${open.crashes.veteran} rookie ${open.crashes.rookie}`).toBeLessThanOrEqual(9);
    expect(working.crashes.veteran + working.crashes.rookie, `working crashes veteran ${working.crashes.veteran} rookie ${working.crashes.rookie}`).toBeLessThanOrEqual(3);
  }, 1_800_000);
});
