/**
 * §T.197 RACE OUTPUT LATENCY: the rolling-start cap acts on the tick it belongs to, for the player AND the rivals.
 *
 * WHY: the race runs RACE_DELAY_TICKS (8) behind the page so rivals that come home late cannot change it (§V2). Every
 * race output used to ride that delay, so the green light released the throttles 117 ms late and the grid hold kicked
 * in late. The cap is a pure function of race time, so it needs no rival data and no delay. What must hold:
 *  - the page's cap rule IS the race's (`rollingCapAt` = `Race.step`'s `speedCap` on every tick) — two copies of a
 *    rule drift, and a player released on a different tick than the race's green is a jump start or a stall;
 *  - the player's throttle is released on the first page tick after green, not D ticks later;
 *  - on that SAME tick the rival's recorded AI IN carries GO (symmetry: nobody gets the jump), and on every tick the
 *    rival's GO encodes the same cap the player's throttle was limited by.
 */
import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../src/core/loop';
import { AI_IN } from '../src/race/ai/aiBlock';
import { raceParams } from '../src/race/params';
import { Race } from '../src/race/race';
import type { RacerSensors } from '../src/race/sensors';
import type { Course, Vec2 } from '../src/race/types';
import { CpuOcean } from '../src/sea-physics/cpuOcean';
import type { Rigid6State } from '../src/sea-physics/rigidBody';
import { oceanParams } from '../src/params/ocean';
import { AI_IN_LEN } from '../src/sim-worker/layout';
import { buildDeepVHull } from '../src/speedboat/hullMesh';
import { createNpcFleetDriver, type NpcTickInputs } from '../src/speedboat/page/npcFleet';
import { createPlayerBoat } from '../src/speedboat/page/playerBoat';
import { capThrottle, createRaceSession, RACE_DELAY_TICKS, rollingCapAt } from '../src/speedboat/page/raceSession';
import { speedboatSeaParams } from '../src/speedboat/page/seaParams';
import type { BoatControls } from '../src/speedboat/page/seams';
import type { ShipState } from '../src/state/simState';
import { weatherPresets } from '../src/weather/presets';

const sp = raceParams.start;
/** a pace line exactly as long as a 2-boat grid + the pull-off + 40 m of pacing: green ≈ 5 s */
const PACE_LEN = sp.firstRowGap + sp.pullOffDistance + 40;

function course(): Course {
  const gate = (id: string, z: number) => ({ kind: 'gate' as const, gate: { id, left: [15, z] as Vec2, right: [-15, z] as Vec2, sector: 'exposed' as const } });
  return {
    id: 'lat', name: 'Latency Reach', startGateId: 'G0', laps: 1,
    referenceLine: [[0, 0], [0, 600], [200, 600], [200, -300], [0, -300]],
    paceLine: [[0, -PACE_LEN], [0, 0]],
    bounds: { min: [-100, -400], max: [300, 700] },
    elements: [gate('G0', 0), gate('G1', 400)],
  };
}

describe('§T.197 the rolling-start cap is not delayed', () => {
  it('rollingCapAt is the cap Race.step publishes, on every tick from the grid through green', () => {
    const race = new Race({ course: course(), racerIds: [1, 0], dt: SIM_DT });
    const s = (id: number): RacerSensors => ({ racerId: id, positions: [[0, -PACE_LEN]], speed: 0, airborne: false, slam: 0, pitch: 0, roll: 0, crashed: false, launchedFromWake: false, surgePressed: false, respawnRequested: false });
    let sawRolling = false;
    let sawGreen = false;
    for (let k = 1; k <= Math.ceil((race.schedule.green + 1) / SIM_DT); k++) {
      const out = race.step([s(1), s(0)]).outputs;
      const cap = rollingCapAt(race, k * SIM_DT);
      for (const o of out) expect(o.speedCap, `tick ${k}`).toBe(cap);
      sawRolling ||= cap !== null && cap > 0;
      sawGreen ||= cap === null;
    }
    expect(sawRolling && sawGreen).toBe(true);
  });

  it('the grid hold lifts and green releases on the first tick after each, for the player and the rival alike', async () => {
    const hull = buildDeepVHull();
    const ocean = structuredClone(oceanParams);
    Object.assign(ocean, structuredClone(weatherPresets.glass.ocean));
    const seaParams = speedboatSeaParams(hull);
    const mirror = new CpuOcean(7, ocean, seaParams);
    const rest = (x: number, z: number): Rigid6State => ({ position: [x, 0.2, z], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] });
    const state = { ...rest(0, -PACE_LEN) } as unknown as ShipState;
    const player = createPlayerBoat({ hull, pressureHeadAt: (x, z, t) => mirror.pressureHeadAt(x, z, t) }, state);
    const warn = console.warn;
    console.warn = () => {};
    const npcs = await createNpcFleetDriver({
      seed: 7, boats: 1, oceanParams: ocean, seaParams, spawn: () => rest(20, -PACE_LEN),
      controls: () => ({ throttle: 0, steer: 0 }),
      caps: { crossOriginIsolated: false, sharedArrayBuffer: false, worker: false }, budgetMs: 1e6,
      contacts: { boats: true, colliders: [] }, player: true,
    });
    console.warn = warn;
    // the rival's recorded AI IN GO per page tick, as the worker will read it
    const go = new Map<number, number>();
    const record = npcs.recordTick.bind(npcs);
    npcs.recordTick = (tick: number, time: number, inputs?: Readonly<NpcTickInputs>) => {
      if (inputs?.aiIn) go.set(tick, inputs.aiIn[0 * AI_IN_LEN + AI_IN.GO]);
      record(tick, time, inputs);
    };
    const ctl: BoatControls = { steer: 0, throttle: 1, trim: 0, surge: false };
    const session = createRaceSession({
      course: course(), hull, player, npcs, controls: { sample: () => ctl, dispose() {} },
      resetPressed: () => false, surgePressed: () => false, autoReset: () => true,
      colliders: [], bed: () => -30, waterAt: () => 0,
    });
    try {
      let tick = 0;
      let time = 0;
      session.start(tick);
      const race = session.race as Race;
      const greenTick = Math.ceil(race.schedule.green / SIM_DT); // first race tick whose END is at or past green
      const rollTick = Math.ceil(race.schedule.rollStart / SIM_DT);
      const capAtTick = new Map<number, number | null>();
      while (tick < greenTick + RACE_DELAY_TICKS + 30) {
        tick++;
        time += SIM_DT;
        mirror.update(time);
        const speed = Math.hypot(state.velocity[0], state.velocity[2]);
        session.tick(tick, time, SIM_DT);
        npcs.pump(tick);
        const cap = rollingCapAt(race, (tick - 1) * SIM_DT);
        capAtTick.set(tick, cap);
        // the throttle the player's physics ran is limited by the cap of THIS tick, from the speed it started with
        expect(session.applied.throttle, `tick ${tick}`).toBe(capThrottle(1, speed, cap));
      }
      // the transitions land one tick after the race tick that crosses them — the pre-§T.197 path took D more ticks
      expect(capAtTick.get(rollTick)).toBe(0);
      expect(capAtTick.get(rollTick + 1)).toBeGreaterThan(0);
      expect(capAtTick.get(greenTick)).not.toBeNull();
      expect(capAtTick.get(greenTick + 1)).toBeNull();
      // the rival's GO: the same cap on every tick it was recorded, flipping to "go" on the player's release tick
      const goOf = (c: number | null): number => (c === null ? 1 : -Math.max(0, c));
      let checked = 0;
      for (const [p, g] of go) {
        expect(g, `rival GO at tick ${p}`).toBe(goOf(capAtTick.get(p) ?? null));
        checked++;
      }
      expect(checked).toBeGreaterThan(greenTick);
      expect(go.get(greenTick)).toBeLessThan(1);
      expect(go.get(greenTick + 1)).toBe(1);
    } finally {
      npcs.dispose();
    }
  }, 300_000);
});
