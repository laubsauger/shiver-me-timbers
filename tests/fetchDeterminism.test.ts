/**
 * §B.119 / §V.2 — THE SEA THE HULLS FEEL MUST NOT DEPEND ON FRAME RATE.
 *
 * `fetchField.update()` is called from the RENDER block on every page (pirate
 * `main.ts`, `raftFrame.renderSea`, the speedboat lookdev). Its rebuilds used to
 * be gated on a count of 15 of those calls, so a swell or wind turn reached the
 * shelter grids `CpuOcean` reads on a tick that depended on how many frames
 * had been drawn — buoyancy at 30 fps and at 144 fps floated the same hull on
 * different seas. §V.2 says the same seed and the same inputs give the same
 * SimState whatever the display does.
 *
 * So this drives ONE fixed-tick run — a sim that turns the swell (one step and
 * a smooth drift) and the wind the way `weather.update` / the settings do,
 * INSIDE the tick — under several render cadences, including none at all
 * (the worker core has no render), and demands the mirror's samples, a
 * floated hull and the field's grid version be bit-identical tick for tick.
 * Renders do what the pages do: `update(windDirection)` plus a render-side
 * read of the sea (`waterAt` for spray, the bow, the camera).
 */
import { describe, expect, it } from 'vitest';
import { createFetchField } from '../src/ocean/fetchField';
import type { SeabedField } from '../src/island/seabed';
import { oceanParams, type OceanParams } from '../src/params/ocean';
import { seaPhysicsParams, type SeaPhysicsParams } from '../src/params/seaPhysics';
import { weatherPresets } from '../src/weather/presets';
import { CpuOcean } from '../src/sea-physics/cpuOcean';
import { equilibriumDraft, stepShipBuoyancy } from '../src/sea-physics/buoyancy';
import { SIM_DT } from '../src/core/loop';
import type { ShipState } from '../src/state/simState';

/** a 200 m island at the origin: its lee is where the grids matter */
const seabed = {
  heightAt: (x: number, z: number) => (Math.hypot(x, z) < 200 ? 6 : -45),
  origin: [-2000, -2000] as [number, number],
  size: 4000,
} as unknown as SeabedField;

const TICKS = 240;
/** ODD ticks, so a 30 fps cadence (a render every 2nd tick) cannot land on them by luck */
const SWELL_STEP_TICK = 45;
const WIND_TURN_TICK = 91;
const DRIFT_FROM = 131;
const DRIFT_TO = 211;

/** down-swell and down-wind of the island at the turns, plus open water */
const POINTS: readonly [number, number][] = [
  [700, 0],
  [Math.cos(1.2) * 700, Math.sin(1.2) * 700],
  [283, 283],
  [-1200, 40],
];

function makeShip(sp: SeaPhysicsParams): ShipState {
  return {
    id: 'hull',
    kind: 'player',
    position: [600, equilibriumDraft(sp), 60],
    quaternion: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    rudder: 0,
    sailTrim: 0,
    flood: 0,
    damage: {},
  };
}

interface Run {
  /** per tick: every sample and the hull pose, as the exact doubles */
  ticks: Float64Array[];
  /** per tick: the grid version the tick's reads saw */
  versions: number[];
  sweeps: number;
  marches: number;
}

/**
 * `rendersPerTick` = display fps / 60: 0.5 is 30 fps (two ticks, then a
 * frame), 2.4 is 144 fps (frames with no tick between them). 0 is a sim with
 * no renderer at all.
 */
function run(rendersPerTick: number, turns = true): Run {
  const p: OceanParams = {
    ...oceanParams,
    ...weatherPresets.swell.ocean,
    swellDirection: 0,
    fetchFieldSize: 64,
    fetchFieldMargin: 1000,
  };
  const sp: SeaPhysicsParams = { ...seaPhysicsParams, mirrorResolution: 64 };
  const field = createFetchField(seabed, p);
  const cpu = new CpuOcean(4242, p, sp);
  cpu.setFetch(field);
  const ship = makeShip(sp);
  const out: Run = { ticks: [], versions: [], sweeps: 0, marches: 0 };
  let frames = 0;
  for (let i = 1; i <= TICKS; i++) {
    const t = i * SIM_DT;
    // ── the tick: inputs land in the params first, as weather.update does ──
    if (turns) {
      if (i === SWELL_STEP_TICK) p.swellDirection = 1.2;
      if (i === WIND_TURN_TICK) p.windDirection = oceanParams.windDirection + 0.6;
      if (i >= DRIFT_FROM && i <= DRIFT_TO) p.swellDirection = 1.2 + (0.4 * (i - DRIFT_FROM)) / (DRIFT_TO - DRIFT_FROM);
    }
    cpu.update(t);
    stepShipBuoyancy(ship, cpu, SIM_DT, sp);
    const row: number[] = [];
    for (const [x, z] of POINTS) row.push(cpu.heightAt(x, z, t), cpu.pressureHeadAt(x, z, t));
    row.push(...ship.position, ...ship.quaternion, ...ship.velocity, ...ship.angularVelocity);
    out.ticks.push(Float64Array.from(row));
    out.versions.push(field.version);
    // ── the renders this display draws before the next tick ──
    frames += rendersPerTick;
    while (frames >= 1) {
      frames -= 1;
      field.update(p.windDirection);
      cpu.heightAt(-300, 900, t);
    }
  }
  out.sweeps = field.sweepCount;
  out.marches = field.shadowCount;
  return out;
}

/** first tick at which two runs differ in any bit, or -1 */
function firstDivergence(a: Run, b: Run): number {
  for (let i = 0; i < a.ticks.length; i++) {
    const x = a.ticks[i];
    const y = b.ticks[i];
    for (let k = 0; k < x.length; k++) if (!Object.is(x[k], y[k])) return i + 1;
    if (a.versions[i] !== b.versions[i]) return i + 1;
  }
  return -1;
}

describe('§B.119 §V.2 the shelter grids the hull floats on are a function of the tick, not the frame', () => {
  const cadences = { '30 fps': 0.5, '60 fps': 1, '144 fps': 2.4, 'no renderer': 0 } as const;
  const runs = Object.fromEntries(Object.entries(cadences).map(([k, r]) => [k, run(r)])) as Record<
    keyof typeof cadences,
    Run
  >;

  it('the run is not vacuous: the turns rebuild the grids and move the sea the hull feels', () => {
    const ref = runs['60 fps'];
    const still = run(1, false);
    // a swell step, a wind turn, and a drift that crosses fetchRebuildRadians several times
    expect(ref.marches - still.marches).toBeGreaterThanOrEqual(3);
    expect(ref.sweeps - still.sweeps).toBe(1);
    // and the lee samples actually change because of it — if they did not,
    // "identical across cadences" would prove nothing
    expect(firstDivergence(ref, still)).toBeGreaterThan(0);
    expect(firstDivergence(ref, still)).toBeLessThanOrEqual(SWELL_STEP_TICK);
  });

  for (const name of ['30 fps', '144 fps', 'no renderer'] as const) {
    it(`${name} floats the hull on the bit-identical sea of 60 fps, tick for tick`, () => {
      const d = firstDivergence(runs[name], runs['60 fps']);
      expect(d, `first divergent tick (${name} vs 60 fps)`).toBe(-1);
      expect(runs[name].marches).toBe(runs['60 fps'].marches);
      expect(runs[name].sweeps).toBe(runs['60 fps'].sweeps);
    });
  }

  it('an input that lands on tick n is in the grids tick n reads — not a frame later', () => {
    const v = runs['30 fps'].versions;
    expect(v[SWELL_STEP_TICK - 1]).toBeGreaterThan(v[SWELL_STEP_TICK - 2]);
    expect(v[WIND_TURN_TICK - 1]).toBeGreaterThan(v[WIND_TURN_TICK - 2]);
  });

  it('with no turn, no cadence rebuilds anything (open sea stays the construction-time bake)', () => {
    for (const r of [0, 0.5, 2.4]) {
      const still = run(r, false);
      expect(still.sweeps).toBe(1);
      expect(still.marches).toBe(1);
      expect(new Set(still.versions).size).toBe(1);
    }
  });
});
