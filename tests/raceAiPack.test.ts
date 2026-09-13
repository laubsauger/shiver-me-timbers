/**
 * §T.186 — the seven couriers race each other on real physics: plausible, distinct lap times, and a pack that stays
 * close WITHOUT rubber-banding.
 *
 * WHY: design doc §4 / USER: "no speed rubber-banding — trailing NPCs take riskier lines instead". The only honest
 * catch-up is one a player could copy: a tighter line, later braking, less margin. So the A/B is the same race with
 * the catch-up gain on and off, and the thing that must NOT exist is a thrust path: the pilot's only outputs are a
 * drive angle and the physics' own −0.3..1 throttle, and no AI source touches power. Calm water: crashes are
 * tests/raceAiSea's subject; here the risk shows up as time.
 *
 * Both races run at once on real worker threads (sab transport), which is also the path the page uses.
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
import { runRace, type RaceResult } from './raceAiHarness';
import { buildWorkerBundle, nodeSpawner } from './simWorkerNode';

const lapOf = (r: RaceResult): number[] => r.racers.map((x) => x.lapTimes[0]);
const lapEstimate = (r: RaceResult, level: number): number => {
  const lv = r.setup.levels[level];
  let t = 0;
  for (let i = 0; i < lv.line.n; i++) t += lv.line.ds / lv.speed[i];
  return t;
};

describe('§T.186 the pack, calm water, real physics', () => {
  let on: RaceResult;
  let off: RaceResult;

  beforeAll(async () => {
    const spawn: () => WorkerPort = await nodeSpawner(await buildWorkerBundle('race-ai-pack'));
    [on, off] = await Promise.all([
      runRace({ roster: [...ARCHETYPE_ORDER], sea: 'calm', laps: 1, catchUp: true, kind: 'sab', spawn }),
      runRace({ roster: [...ARCHETYPE_ORDER], sea: 'calm', laps: 1, catchUp: false, kind: 'sab', spawn }),
    ]);
  }, 1_500_000);

  afterAll(() => {
    if (!on || !off) return;
    const row = (r: RaceResult): string => r.racers.map((x) => `${x.archetype} ${x.lapTimes[0]?.toFixed(1)} (fin ${x.finishTime.toFixed(1)})`).join(', ');
    // eslint-disable-next-line no-console
    console.info(`[raceAi pack] catch-up ON: ${row(on)}\n[raceAi pack] catch-up OFF: ${row(off)}`);
  });

  it('every courier finishes the lap without a missed gate or a hook', () => {
    for (const r of [on, off]) {
      for (const x of r.racers) {
        expect(x.lapTimes.length, x.archetype).toBe(1);
        expect(x.missed, `${x.archetype}: ${x.missLog.join(' ')}`).toBe(0);
        expect(x.hooks, x.archetype).toBe(0);
        expect(x.crashes, x.archetype).toBe(0);
      }
    }
  });

  it('lap times sit in the band the measured boat allows, and the archetypes are not one boat', () => {
    const laps = lapOf(off);
    // nobody beats the riskiest profile by more than tracking noise; nobody is slower than the safest by much
    // (grid traffic and a 15 s flying start included)
    for (const t of laps) {
      expect(t).toBeGreaterThan(0.95 * lapEstimate(off, 4));
      expect(t).toBeLessThan(1.25 * lapEstimate(off, 0));
    }
    const spread = Math.max(...laps) - Math.min(...laps);
    expect(spread, 'distinct archetypes').toBeGreaterThan(1.5);
    expect(Math.max(...laps) / Math.min(...laps), 'one class of boat').toBeLessThan(1.15);
    // base risk is what separates them in flat water: the hothead out-laps the veteran
    const at = (id: string): number => off.racers.find((x) => x.archetype === id)!.lapTimes[0];
    expect(at('hothead')).toBeLessThan(at('veteran'));
  });

  it('trailing-risk catch-up closes the pack measurably — with no thrust multiplier anywhere', () => {
    const fin = (r: RaceResult): number[] => r.racers.map((x) => x.finishTime);
    const spreadOn = Math.max(...fin(on)) - Math.min(...fin(on));
    const spreadOff = Math.max(...fin(off)) - Math.min(...fin(off));
    expect(spreadOn, `finish spread ON ${spreadOn.toFixed(2)} s vs OFF ${spreadOff.toFixed(2)} s`).toBeLessThan(0.75 * spreadOff);
    // the last boat without catch-up is faster with it
    const lastOff = off.order[off.order.length - 1];
    expect(on.racers[lastOff].finishTime).toBeLessThan(off.racers[lastOff].finishTime - 1);
    // design doc §4 target: P1–P8 within 25 s over a race; one lap of it here
    expect(spreadOn).toBeLessThan(25 / 3);

    // NO THRUST PATH: the throttle every pilot applied is the physics' own range …
    for (const r of [on, off]) {
      for (const x of r.racers) {
        expect(x.maxThrottle).toBeLessThanOrEqual(1);
        expect(x.minThrottle).toBeGreaterThanOrEqual(-0.3);
      }
    }
    // … the pilot's outputs reach the physics through setControls and nothing else …
    expect(stepCoreSrc).toMatch(/b\.hw\.setControls\(po\.steer, po\.throttle\)/);
    // … and no AI source names a power, thrust or drive parameter it could scale
    const forbidden = /powerW|STANDIN_THRUST|standInDrivePower|thrust|HullWater|setControls|params\s*\[|\.params\b/i;
    for (const [name, src] of Object.entries({ pilotSrc, profileSrc, capabilitySrc, archetypesSrc, lineSrc, aiBlockSrc })) {
      const hit = src.split('\n').find((l) => forbidden.test(l) && !/^\s*(\*|\/\/|\/\*)/.test(l));
      expect(hit, name).toBeUndefined();
    }
  });
});
