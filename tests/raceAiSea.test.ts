/**
 * §T.186 — a Working sea: NPCs finish their laps, and HOW OFTEN they crash is an archetype property, rookie > veteran.
 *
 * WHY: design doc §4 — the veteran "never crashes", the rookie is the one who does; crashes must come from how a
 * pilot reads the water (wave lift, sea respect, the roll helm, mistakes), not from a scripted dice roll. So the
 * crash count is whatever the REAL hull does in the REAL sea under each pilot, and the test pins the ordering and
 * a bound, not a rate someone typed in.
 *
 * "Working sea" = the shipped default sea (the 'swell' weather preset: Beaufort 6, 11 m/s wind, 0.34 m RMS swell).
 * No speedboat sea-state presets exist yet (design doc §5 names Calm/Breeze/Working/Squall; T181+ owns them).
 *
 * MEASURED, and a finding for the physics owner (docs/speedboat/npc-ai.md): in this sea the V-39 proxy rolls past
 * 60° every ~20–60 s even under the most careful pilot (launched with a roll rate, lands heeled, capsizes; the
 * physics log's open ~15 kN·m·s/rad roll-damping gap). The bounds below are that reality, not the design target.
 * Three boats per archetype in one race: each meets a different stretch of the sea (§V50: never one realisation).
 */
import { describe, expect, it } from 'vitest';
import { AI } from '../src/race/ai/aiBlock';
import { runRace } from './raceAiHarness';

describe('§T.186 NPCs in a Working sea, real physics', () => {
  it('veterans and rookies all finish a lap; rookies crash more than veterans, within bounds', async () => {
    const roster = ['veteran', 'rookie', 'veteran', 'rookie', 'veteran', 'rookie'] as const;
    const maxLift = new Array(roster.length).fill(0);
    const r = await runRace({
      roster: [...roster],
      sea: 'working',
      laps: 1,
      maxSeconds: 260,
      gridGap: 30,
      trace: (_tick, i, f) => {
        maxLift[i] = Math.max(maxLift[i], f.readAi(i, AI.WAVE_LIFT));
      },
    });
    const sum = (id: string): number => r.racers.filter((x) => x.archetype === id).reduce((a, x) => a + x.crashes, 0);
    // eslint-disable-next-line no-console
    console.info('[raceAi sea]', r.racers.map((x, i) => `${x.archetype} lap ${x.lapTimes[0]?.toFixed(1)} crashes ${x.crashes} hooks ${x.hooks} missed ${x.missed} lift≤${maxLift[i].toFixed(2)}`).join(' | '));
    for (const x of r.racers) {
      expect(x.lapTimes.length, `${x.archetype} finished`).toBe(1);
      expect(x.stuck, x.archetype).toBe(0);
    }
    expect(sum('rookie'), `rookie ${sum('rookie')} vs veteran ${sum('veteran')}`).toBeGreaterThan(sum('veteran'));
    // bounds ≈ 1.4× the measured worst boat (veterans 9/13/13, rookies 10/22/17 per lap): a crash loop or a pilot that
    // stopped reading the water breaks them; the design's "veteran never crashes" needs the physics fix first
    for (const x of r.racers) expect(x.crashes, x.archetype).toBeLessThanOrEqual(x.archetype === 'veteran' ? 18 : 30);
    // the wave read is live in this sea (a pilot that never lifts is not reading it)
    r.racers.forEach((x, i) => {
      if (x.archetype === 'veteran') expect(maxLift[i], 'veteran lifts for crests').toBeGreaterThan(0.3);
    });
  }, 1_500_000);
});
