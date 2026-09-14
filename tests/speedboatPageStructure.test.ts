/**
 * §T.181 S0 — the speedboat page's STRUCTURE: the things that are invisible in a screenshot and
 * expensive to find later.
 *
 * WHY each block:
 *  - BOOT ORDER: TSL bakes graphs at construction (the sea binds the caustics the boats' slot
 *    materials read), the NPC fleet's mirror must be built on the page mirror's tick (its spectrum
 *    schedule is history), and the splash may only lift after a presented frame. A reorder that
 *    still "works" renders wrong or hitches, silently.
 *  - PLAYER PHYSICS IN THE FIXED TICK (§V2, §V3): a rigid6 step in the render callback makes the
 *    boat's trajectory a function of the frame rate — replays diverge and 144 Hz players plane
 *    differently from 60 Hz ones.
 *  - WORKER SELECTION (§V110, §T.178): rivals must run through the capability-selected transport
 *    (SAB → transferable → main), not a hard-coded one, and the pipelined kick/collect must keep a
 *    rival's trajectory a function of its TICK INDEX however late the round trips come home.
 *  - WAKE ON THE SIM POSE (§V105): a wake domain anchored on the camera or the interpolated view
 *    makes the wake pattern depend on the frame rate and the lens.
 *  - CONTROLS SIGN: D must turn right. A wrong sign is the first thing a player feels and the last
 *    thing a code review catches.
 */
import { describe, expect, it } from 'vitest';
import mainSpeedboat from '../src/main-speedboat.ts?raw';
import frameSrc from '../src/speedboat/page/speedboatFrame.ts?raw';
import sceneSrc from '../src/speedboat/page/speedboatScene.ts?raw';
import npcSrc from '../src/speedboat/page/npcFleet.ts?raw';
import sessionSrc from '../src/speedboat/page/raceSession.ts?raw';
import playerSrc from '../src/speedboat/page/playerBoat.ts?raw';
import { SIM_DT } from '../src/core/loop';
import { oceanParams } from '../src/params/ocean';
import { buildDeepVHull } from '../src/speedboat/hullMesh';
import { createPlayerBoat } from '../src/speedboat/page/playerBoat';
import { createNpcFleetDriver, type NpcFleet } from '../src/speedboat/page/npcFleet';
import { gridSlot, openSeaCourse, SPAWN_CG_Y } from '../src/speedboat/page/course';
import { keyboardTargets, KEYBOARD_STEER_LIMIT } from '../src/speedboat/page/controls';
import { speedboatSeaParams } from '../src/speedboat/page/seaParams';
import { hashBoatOutput, HASH_SEED } from '../src/sim-worker/layout';
import type { ShipState } from '../src/state/simState';

/** code only — the headers quote call names in prose */
const code = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const main = code(mainSpeedboat);
const frame = code(frameSrc);

/** the body of the loop's tick and render callbacks, split at the render callback's signature */
function loopBodies(src: string): { tick: string; render: string } {
  const start = src.indexOf('new GameLoop(');
  const renderAt = src.search(/\(alpha, frameDt(, \w+)?\) =>/);
  const end = src.indexOf('() => ui.blocking', renderAt);
  expect(start, 'new GameLoop(').toBeGreaterThan(-1);
  expect(renderAt, 'render callback').toBeGreaterThan(start);
  expect(end, 'pause predicate').toBeGreaterThan(renderAt);
  return { tick: src.slice(start, renderAt), render: src.slice(renderAt, end) };
}

/** a method body of the object `createSpeedboatFrame` returns: from `name(` to the next top-level method */
function method(src: string, name: string): string {
  const at = src.search(new RegExp(`\\n {4}${name}\\(`));
  expect(at, name).toBeGreaterThan(-1);
  const rest = src.slice(at + 1);
  const next = rest.slice(1).search(/\n {4}[a-zA-Z]+\(/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

function inOrder(src: string, needles: string[]): void {
  let at = -1;
  for (const n of needles) {
    const i = src.indexOf(n, at + 1);
    expect(i, `'${n}' after position ${at}`).toBeGreaterThan(at);
    at = i;
  }
}

describe('§T.181 boot order', () => {
  it('gate → App → state → weather → sky → sea → player → boat models → NPC fleet → loop → compile warm → first frame → bootReady', () => {
    inOrder(main, [
      'webgpuAvailable()',
      'App.create(',
      'createInitialState(',
      'createWeatherSystem(',
      'createSky(',
      'buildSpeedboatSea(',
      'course.attach(sea)',
      'createCourseFurniture(',
      'createPlayerBoat(',
      'buildSpeedboatBoats(',
      'createPilots(',
      'createNpcFleetDriver(',
      'createRaceSession(',
      'createRaceUi(',
      'new GameLoop(',
      'withFullCoverage(',
      'flowFoam.warmAsync(',
      'presentAsync()',
      'loop.start()',
      'bootReady()',
      'ui.openSelect()',
    ]);
  });

  it('the course dictates the sea (Tower Reach: Calm, start in the lee), storm cells off, on the SIM wake backend', () => {
    // user playtest 2026-09-13: "start on calm sea or whatever is dictated by map and luv/lee design"
    expect(main).toMatch(/weather\.apply\(query\.get\('weather'\) \?\? course\.seaPreset/);
    expect(main).toMatch(/weatherParams\.cellIntensity = 0/);
    expect(code(sceneSrc)).toMatch(/wakeBackend: 'sim'/);
  });

  it('the post path is gated by the shared warm gate, never flipped on cold (§T.40)', () => {
    expect(main).toMatch(/createPostWarmGate\(/);
    expect(loopBodies(main).render).toMatch(/usePost\(\)/);
  });

  it('the wetline is attached BEFORE any boat instance bakes its slot materials', () => {
    inOrder(code(sceneSrc), ['attachHullWetline(', 'instantiate(']);
  });

  it('the sea and the fleet are built from ONE sea-params object, with the deep-V draft as the Smith depth', () => {
    expect(main).toMatch(/const seaParams = speedboatSeaParams\(hull\)/);
    expect(main).toMatch(/buildSpeedboatSea\([^)]*seaParams\)/);
    expect(main).toMatch(/oceanParams, seaParams,/);
    const p = speedboatSeaParams(buildDeepVHull());
    // keel depth at the measured rest pose, not the galleon's 2.0 m
    expect(p.hullDraft).toBeGreaterThan(0.3);
    expect(p.hullDraft).toBeLessThan(0.8);
  });
});

describe('§V2/§V3 the player boat is stepped in the FIXED tick only', () => {
  const { tick, render } = loopBodies(main);

  it('the tick runs sea → race session → wake → NPC pump; the session runs controls → collide → physics → crash → race → outputs', () => {
    inOrder(tick, ['frame.tickSea()', 'session.tick(state.tick, state.time, dt)', 'frame.tickBoat(', 'npcs.pump(']);
    const s = code(sessionSrc);
    const body = s.slice(s.indexOf('    tick(tick: number, time: number, dt: number): void {'));
    inOrder(body, ['session.controls(dt, tick)', 'session.collide(tick, time)', 'player.tick(c, time, dt)', 'session.crash(tick)', 'session.step(tick)', 'session.applyOutputs(tick)']);
  });

  it('the render callback never steps physics, samples the sea for forces, or feeds the wake', () => {
    for (const bad of ['player.tick(', 'stepRigid6', 'samplePatch', 'tickSea', 'tickBoat', 'controls.sample(', 'recordTick', 'session.tick(', 'session.start(']) {
      expect(render, bad).not.toContain(bad);
    }
    for (const bad of ['stepRigid6', 'samplePatch', 'player.tick(', 'wakeSim']) {
      expect(method(frame, 'renderSea'), `renderSea: ${bad}`).not.toContain(bad);
      expect(method(frame, 'renderBoats'), `renderBoats: ${bad}`).not.toContain(bad);
    }
  });

  it('the player step is the fleet core step: setControls → samplePatch (pressure head) → planingSubsteps → stepRigid6', () => {
    inOrder(code(playerSrc), ['hw.setControls(', 'hw.samplePatch(', 'planingSubsteps(', 'stepRigid6(']);
    expect(code(playerSrc)).toMatch(/new HullWater\(hull\)/); // module defaults: the 0.8 m patch every rival runs (§V110)
    expect(main).toMatch(/pressureHeadAt: \(x, z, t\) => sea\.cpuOcean\.pressureHeadAt\(x, z, t\)/);
  });

  it('a free-running player boat floats at rest, planes under throttle, and D (positive steer) turns her RIGHT', () => {
    const hull = buildDeepVHull();
    const run = (steer: number) => {
      const state = { ...gridSlot(0) } as unknown as ShipState;
      const boat = createPlayerBoat({ hull, pressureHeadAt: () => 0 }, state);
      boat.place(gridSlot(0));
      let t = 0;
      for (let k = 0; k < 120; k++) boat.tick({ steer: 0, throttle: 0, trim: 0, surge: false }, (t += SIM_DT));
      const restY = state.position[1];
      for (let k = 0; k < 600; k++) boat.tick({ steer: k > 300 ? steer : 0, throttle: 1, trim: 0, surge: false }, (t += SIM_DT));
      return { restY, state, samples: boat.wakeSamples([]).length, jets: boat.jets([]).length };
    };
    const straight = run(0);
    // restCgHeight is the static solve; the free boat settles 3.5 cm lower after 2 s (running trim of the aft engine mass)
    expect(Math.abs(straight.restY - SPAWN_CG_Y)).toBeLessThan(0.05); // hydrostatic rest ≈ the spawn height (§T.198 derives it from the hull)
    expect(straight.state.velocity[2]).toBeGreaterThan(15); // under way along +z
    expect(straight.samples).toBeGreaterThan(0); // §V101: the wake reads this step's contact
    expect(straight.jets).toBe(hull.drives.length);
    const right = run(KEYBOARD_STEER_LIMIT);
    // the chase camera looks along +z from astern, so the pilot's right is world −x
    expect(right.state.position[0]).toBeLessThan(-5);
    expect(keyboardTargets(new Set(['KeyD'])).steer).toBeGreaterThan(0);
    expect(keyboardTargets(new Set(['KeyA'])).steer).toBeLessThan(0);
    expect(keyboardTargets(new Set(['KeyW'])).throttle).toBe(1);
    expect(keyboardTargets(new Set(['KeyS'])).throttle).toBeLessThan(0);
  });
});

describe('§V110/§T.178 NPC boats go through the capability-selected transport, pipelined', () => {
  it('the page builds the fleet via select.createNpcFleet (auto transport), never a hard-coded BoatFleet kind', () => {
    const npc = code(npcSrc);
    expect(npc).toMatch(/createNpcFleet\(/);
    expect(npc).toMatch(/detectCaps\(\)/);
    expect(npc).not.toMatch(/new BoatFleet\(/);
    expect(npc).not.toMatch(/kind:\s*['"](sab|transfer|main)['"]/);
    expect(main).not.toMatch(/new BoatFleet\(|BoatSimCore|stepRigid6/);
    // pumped at the end of the tick AND at the end of the frame
    const { tick, render } = loopBodies(main);
    expect(tick).toMatch(/npcs\.pump\(state\.tick\)/);
    expect(render.trim().split('\n').filter((l) => l.trim()).slice(-2).join('\n')).toMatch(/npcs\.pump\(state\.tick\)/);
    expect(main).toMatch(/boats: NPC_COUNT/);
    expect(main).toMatch(/const NPC_COUNT = 7/);
  });

  /**
   * Main-thread transport (node has no browser Worker): one request per pump, poll always true —
   * so "late round trips" are simulated by pumping less often than ticking. The rivals' OUT
   * hash after catching up must equal the every-tick run: NPC tick k was kicked with page tick
   * k's time whatever pump carried it.
   */
  it('a trailing fleet catches up to the same trajectory (tick-indexed times), and reports its lag', async () => {
    const hull = buildDeepVHull();
    const TICKS = 40;
    const mk = () =>
      createNpcFleetDriver({
        seed: 2100, boats: 3, oceanParams: structuredClone(oceanParams), seaParams: speedboatSeaParams(hull),
        spawn: (i) => openSeaCourse().spawn(i + 1),
        caps: { crossOriginIsolated: false, sharedArrayBuffer: false, worker: false },
        budgetMs: 1e6, // the batch size is the budget's business, the trajectory is not (tests/simWorkerBatch.test.ts)
      });
    const hash = (n: NpcFleet): number => {
      let h = HASH_SEED;
      for (let i = 0; i < n.boats; i++) h = hashBoatOutput(n.fleet.layoutOf(i), i, h);
      return h;
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
      const every = await mk();
      const lazy = await mk();
      expect(every.fleet.kind).toBe('main');
      let time = 0;
      let maxLag = 0;
      for (let tick = 1; tick <= TICKS; tick++) {
        time += SIM_DT;
        every.recordTick(tick, time);
        every.pump(tick);
        every.pump(tick); // the frame-end pump collects what the tick pump kicked
        lazy.recordTick(tick, time);
        if (tick % 3 === 0) lazy.pump(tick); // one pump per three ticks: the fleet trails
        maxLag = Math.max(maxLag, lazy.lagTicks);
      }
      expect(maxLag).toBeGreaterThanOrEqual(3);
      for (let k = 0; k < 4 * TICKS && lazy.collectedTick < TICKS; k++) lazy.pump(TICKS);
      expect(every.collectedTick).toBe(TICKS);
      expect(lazy.collectedTick).toBe(TICKS);
      // §T.181: owed ticks travel as ONE multi-tick request, and nothing is dropped (the tick count adds up)
      expect(lazy.catchUp.maxBatch).toBeGreaterThanOrEqual(3);
      expect(lazy.catchUp.batches).toBeLessThan(TICKS);
      expect(hash(lazy).toString(16)).toBe(hash(every).toString(16));
      // and the rivals are actually under way on their placeholder straight line
      expect(every.pose(0).velocity[2]).toBeGreaterThan(0.5);
      every.dispose();
      lazy.dispose();
    } finally {
      console.warn = warn;
    }
  }, 60_000);
});

describe('§V105 the wake is anchored on the player SIM pose', () => {
  it('tickBoat feeds wakeSim with the SimState ship rigid6 wrote, and only the fixed tick calls tickBoat', () => {
    expect(frame).toMatch(/const boat = player\.state;/);
    const tb = method(frame, 'tickBoat');
    // §T.195: every boat's wake goes through vesselFx, anchored on the player's SIM pose (`state: boat`), this step's
    // contact (`hw: player.hw`) and the rivals' collected FX records (the trailer's scripted rivals' on a `?cine` page);
    // the camera is only the spray pools' viewer
    expect(tb).toMatch(/vesselFx\.tick\(app\.renderer, \{ hw: player\.hw, state: boat, bowAhead: hull\.stemZ \+ 120 \}, d\.rivals \? d\.rivals\.fx : d\.npcs\.fleet, dt, app\.camera\.position\)/);
    // the flowfoam region + wake track follow the same sim pose (core/seaFrame.trackWake → setCenter(ship.position))
    expect(tb).toMatch(/seaFrame\.trackWake\(boat, hull\.stemZ, hull\.transomZ, hull\.beam, dt\)/);
    expect(tb.replace('app.camera.position)', ')')).not.toMatch(/camera|view\b|alpha/);
    // the samples and jets are this step's contact (§V101)
    inOrder(tb, ['player.wakeSamples(', 'player.jets(', 'vesselFx.tick(']);
    const { tick, render } = loopBodies(main);
    expect(tick).toContain('frame.tickBoat(dt)');
    expect(render).not.toContain('tickBoat');
  });
});
