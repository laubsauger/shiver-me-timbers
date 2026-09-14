/**
 * FREE ROAM (`speedboat.html?mode=free`, src/speedboat/page/sessionMode.ts): the race map as a sandbox — no rivals, no
 * race, speed and trim only.
 *
 * WHY each check:
 *  - NO RIVALS, NO WORKER: the point of the mode is a cinematic ride that does not pay for seven boats on a worker. A
 *    page that still built the fleet driver (or its hulls) would look identical and cost the same, silently.
 *  - NO RACE STEPPING, CRASHES STILL WORK: the race session is reused for the player's collide → physics → crash chain,
 *    so a free ride must never construct a `Race` (no rolling start holding the throttle at 0, no gates, no results),
 *    yet a reset must still land her in clear water — a sandbox you can get stuck in is broken.
 *  - HUD: every race panel is hidden by ONE stylesheet rule that keeps exactly speed and trim; a new race panel added
 *    later is hidden by default instead of leaking into cinematic shots.
 */
import { describe, expect, it } from 'vitest';
import mainSrc from '../src/main-speedboat.ts?raw';
import raceUiSrc from '../src/speedboat/page/raceUi.ts?raw';
import raceHudSrc from '../src/speedboat/ui/raceHud.ts?raw';
import gaugesSrc from '../src/speedboat/ui/gauges.ts?raw';
import { SIM_DT } from '../src/core/loop';
import type { Course } from '../src/race/types';
import { CRASH_TIMINGS } from '../src/speedboat/crash';
import { buildDeepVHull } from '../src/speedboat/hullMesh';
import { chromeKeyFor } from '../src/speedboat/page/pageChrome';
import { createPlayerBoat } from '../src/speedboat/page/playerBoat';
import { RACE_DELAY_TICKS, createRaceSession } from '../src/speedboat/page/raceSession';
import { createIdleNpcFleet, freeRoamRules, sessionModeFrom, sessionModeHref } from '../src/speedboat/page/sessionMode';
import { SPEEDBOAT_UI_CSS } from '../src/speedboat/ui/styles';
import type { ShipState } from '../src/state/simState';

const code = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('?mode=free: the race map as a sandbox', () => {
  it('the URL picks the mode (race by default) and the pause toggle round-trips it', () => {
    expect(sessionModeFrom('?mode=free')).toBe('free');
    expect(sessionModeFrom('')).toBe('race');
    expect(sessionModeFrom('?mode=Free&dev')).toBe('race');
    const free = sessionModeHref('free', 'http://x/speedboat.html?dev');
    expect(sessionModeFrom(new URL(free).search)).toBe('free');
    const back = new URL(sessionModeHref('race', free)).searchParams;
    expect(back.has('dev')).toBe(true); // other parameters survive the reload
    expect(back.has('mode')).toBe(false);
  });

  it('no fleet boats: the page builds 0 NPC hulls and the idle fleet instead of the worker driver', () => {
    const main = code(mainSrc);
    expect(main).toMatch(/buildSpeedboatBoats\(app, sea, mode === 'free' \? 0 : NPC_COUNT/);
    expect(main).toMatch(/mode === 'free' \? createIdleNpcFleet\(\) : await createNpcFleetDriver\(/);
    expect(main).toMatch(/query\.has\('autopilot'\) && mode === 'race'/);
    expect(mainSrc.split('\n').length).toBeLessThanOrEqual(301); // main-speedboat.ts ≤ 300 lines
    const idle = createIdleNpcFleet();
    expect(idle.boats).toBe(0);
    expect((idle.fleet as unknown as { spec: { boats: number } }).spec.boats).toBe(0); // vesselFx: no rival FX
  });

  it('no race session stepping: no Race, no race events, the loop never holds; she drives at once and R lands her in clear water', () => {
    const hull = buildDeepVHull();
    const state = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] } as unknown as ShipState;
    const player = createPlayerBoat({ hull, pressureHeadAt: () => 0 }, state);
    // a rock 25 m round the start straight's first point: the spawn and the respawn must find the water beyond it
    const isClear = (x: number, z: number): boolean => Math.hypot(x, z) > 25;
    const course = { paceLine: [[0, 0], [0, 400]] } as unknown as Course;
    const npcs = createIdleNpcFleet();
    let tick = 0;
    let resetAt = -1;
    let teleports = 0;
    const session = createRaceSession({
      course, hull, player, npcs,
      controls: { sample: () => ({ steer: 0, throttle: 1, trim: 0, surge: false }), dispose: () => undefined },
      resetPressed: () => tick === resetAt, surgePressed: () => false, autoReset: () => true,
      colliders: [], bed: () => -20, isClear, waterAt: () => 0,
      onPlayerTeleport: () => teleports++,
      freeRoam: freeRoamRules(course, isClear, () => 0),
    });
    session.start(0);
    expect(teleports).toBe(1);
    expect(isClear(state.position[0], state.position[2])).toBe(true);
    let time = 0;
    const run = (n: number): void => {
      for (let k = 0; k < n; k++) {
        tick++;
        time += SIM_DT;
        expect(session.holdSim(tick - 1)).toBe(false);
        session.tick(tick, time, SIM_DT);
      }
    };
    run(240);
    expect(session.race).toBeNull();
    expect(session.state).toBeNull();
    expect(session.applied.throttle).toBe(1); // no rolling-start cap: full control from the first tick
    expect(Math.hypot(state.velocity[0], state.velocity[2])).toBeGreaterThan(8);
    // drive her into the rock, then hold R: fade, teleport to the nearest clear water, at rest; no race event anywhere
    player.place({ position: [0, state.position[1], 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] });
    session.drain();
    resetAt = tick + 1;
    run(RACE_DELAY_TICKS + Math.ceil(CRASH_TIMINGS.fadeOut / SIM_DT) + 4);
    const { events, crashEvents } = session.drain();
    expect(events).toHaveLength(0);
    expect(crashEvents.map((e) => e.event.type)).toContain('teleport');
    expect(teleports).toBe(2);
    expect(isClear(state.position[0], state.position[2])).toBe(true);
    expect(Math.hypot(state.position[0], state.position[2])).toBeLessThan(45); // the NEAREST clear water, not the start
  });

  it('HUD: race panels hidden, speed and trim visible; no radio; photo mode (P, the shared view rules) hides the whole HUD', () => {
    const rule = SPEEDBOAT_UI_CSS.split('}').find((r) => r.includes('.sbh.is-free [data-panel]'));
    expect(rule, 'the free-roam rule').toBeDefined();
    const selectors = (rule as string).split('{')[0];
    expect((rule as string).split('{')[1]).toMatch(/display:\s*none/);
    // every panel the HUD builds is hidden except the two the not() list keeps
    const panels = [...(raceHudSrc + gaugesSrc).matchAll(/dataset\.panel = '([a-z]+)'/g)].map((m) => m[1]);
    expect(panels).toEqual(expect.arrayContaining(['position', 'standings', 'timer', 'radio', 'sea', 'trim', 'speed', 'surge', 'plotter']));
    const kept = [...selectors.matchAll(/\.sbh\.is-free \[data-panel\]((?::not\(\[data-panel="[a-z]+"\]\))+)/g)][0][1];
    expect([...kept.matchAll(/"([a-z]+)"/g)].map((m) => m[1]).sort()).toEqual(['speed', 'trim']);
    // gate + pace/start markers (one svg), the tower lamps and countdown, toasts
    for (const s of ['.sbh.is-free .sbh-gate', '.sbh.is-free .sbh-start', '.sbh.is-free .sbh-toast']) expect(selectors, s).toContain(s);
    const ui = code(raceUiSrc);
    expect(ui).toMatch(/hud\.setFreeRoam\(free\)/);
    expect(ui).toMatch(/if \(!free\) \{\s*radio\.ingest\(/);
    expect(ui).toMatch(/const show = !block && !d\.chrome\?\.isPhoto\(\)/);
    expect(ui).toMatch(/d\.chrome\?\.peelEscape\(\)\) return;/); // Esc ends photo mode before it pauses
    expect(chromeKeyFor({ key: 'p', code: 'KeyP', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false, target: null })).toBe('photo');
  });
});
