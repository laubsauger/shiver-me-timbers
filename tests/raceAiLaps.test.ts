/**
 * §T.186 — an NPC completes a 3-lap race on REAL physics, inside the real boat step core, without missing a gate.
 *
 * WHY: this is the whole chain at once — measured capability → racing line → speed profile → pure pursuit → the
 * core's pilot hook → HullWater drives → rigid6 — against gate detection written independently in the harness.
 * The rookie is the pilot under test on purpose: most seeded mistakes, least wave skill, shortest lookahead; a line
 * or controller that only works for a careful pilot is not a racing AI. Calm water isolates the line and the
 * controller from sea-state crashes (tests/raceAiSea.test.ts has those).
 */
import { describe, expect, it } from 'vitest';
import { runRace, syntheticCourse } from './raceAiHarness';

describe('§T.186 NPC laps, calm water, real physics', () => {
  it('the rookie completes 3 laps of the 9-gate + 2-mark course: every element passed, none missed, no hook, no crash', async () => {
    const course = syntheticCourse(3);
    const r = await runRace({ roster: ['rookie'], sea: 'calm', laps: 3, course });
    const x = r.racers[0];
    expect(x.lapTimes.length, JSON.stringify(x)).toBe(3);
    expect(x.missed, x.missLog.join(' ')).toBe(0);
    // 11 elements per lap; the flying start crosses the start line once more than the laps
    expect(x.passed).toBe(3 * course.elements.length + 1);
    expect(x.hooks).toBe(0);
    expect(x.crashes).toBe(0);
    expect(x.stuck).toBe(0);
    // laps 2 and 3 start from racing speed: they are the same lap to within a few percent (the pilot is stable,
    // not drifting off its line lap by lap)
    expect(Math.abs(x.lapTimes[2] - x.lapTimes[1]) / x.lapTimes[1]).toBeLessThan(0.04);
    // eslint-disable-next-line no-console
    console.info('[raceAi laps] rookie', x.lapTimes.map((t) => t.toFixed(2)).join(' / '), 's, mean', x.meanSpeed.toFixed(1), 'm/s,', (r.wallMs / r.ticks).toFixed(2), 'ms/tick');
  }, 900_000);
});
