/**
 * §T.191 / §V110 / §V8 — THE RIVALS FLOAT ON THE PLAYER'S SEA, OVER THE PLAYER'S SEABED, IN THE PLAYER'S LEE.
 *
 * WHY: Tower Reach is built out of shelter. Its sheltered gates sit in a swell shadow (K 0.04–0.37) and its bar
 * shoals the swell. Before §T.191 the worker cores floated rivals on OPEN-OCEAN depth with no fetch or shadow: in the
 * lee a rival met the full swell the player never sees, and over the bar it met no shoaling — the unfairness §V110
 * forbids, in a direction no one would spot on a screenshot (a rival that "handles the chop worse" in the chicane).
 * "Close" is not the bar: a fetch grid that disagreed in one texel, or a seabed sampled at a different interpolant,
 * is the same class of defect as §B.34, so every comparison here is `toBe` (bit identity).
 *
 * The page mirror is built the page's way: its own seabed = `gridSeabed(world)` (the baked texel-centre grid) and
 * its fetch = `createFetchField` over the CLOSURE seabed (the field the ocean material also reads). The core gets
 * only the plain `SimWorldData` (structured-cloned, as the worker init message carries it).
 *
 * Checked, at ≥ 50 points (bar crest, gate mids, coasts, open water) and several ticks across a wind turn (fetch
 * re-sweep) and a swell turn (shadow re-march): heightAt and pressureHeadAt; the fetch field versions per tick; the
 * masked fetch field's fetchAt/shadowAt against the closure field; the race bed. Mutation: floating the page mirror
 * on the closure seabed instead of the grid must be caught.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { SIM_DT } from '../src/core/loop';
import { buildTowerReach, createRaceSeabed, type TowerReachWorld } from '../src/circuit';
import { createSeabedField, type SeabedField } from '../src/island/seabed';
import { createFetchField } from '../src/ocean/fetchField';
import { oceanParams, type OceanParams } from '../src/params/ocean';
import { seaPhysicsParams, type SeaPhysicsParams } from '../src/params/seaPhysics';
import { CpuOcean } from '../src/sea-physics/cpuOcean';
import { BoatFleet } from '../src/sim-worker/fleet';
import type { MainThreadTransport } from '../src/sim-worker/transport';
import { TR } from '../src/sim-worker/layout';
import { bakeSimWorldData, gridSeabed, maskedFetchField, raceBed, type SimWorldData } from '../src/sim-worker/worldData';

const SEED = 1965;
const TICKS = 90;
const WIND_TICK = 20;
const SWELL_TICK = 45;
const CHECK = new Set([1, 2, WIND_TICK, WIND_TICK + 1, SWELL_TICK, SWELL_TICK + 1, 60, TICKS]);

let world: TowerReachWorld;
let seabed: SeabedField;
let data: SimWorldData;
let points: [number, number][];

function params(): { ocean: OceanParams; sea: SeaPhysicsParams } {
  return { ocean: structuredClone(oceanParams), sea: { ...structuredClone(seaPhysicsParams), hullDraft: 0.5 } };
}

/** the page's weather moves, applied before tick k's physics on BOTH sides (the core gets them through kick) */
function move(p: { ocean: OceanParams }, k: number): void {
  if (k === WIND_TICK) p.ocean.windDirection += 0.6; // > fetchRebuildRadians: the fetch grid re-sweeps
  if (k === SWELL_TICK) p.ocean.swellDirection += 0.5; // the swell shadow re-marches
}

beforeAll(() => {
  world = buildTowerReach(SEED);
  seabed = createSeabedField(world.heightmaps.map((hm, i) => ({ heightmap: hm, center: world.sites[i].position })));
  data = bakeSimWorldData(seabed, params().ocean, world.bars, 512);
  const pts: [number, number][] = [];
  for (const b of world.bars) for (const c of b.crest) pts.push([c[0], c[1]]);
  for (const g of world.gates) pts.push([g.mid[0], g.mid[1]]);
  // coasts: grid cells whose bed is within 3 m of the waterline; open water: the rest of a coarse grid
  const [ox, oz] = seabed.origin;
  let coast = 0;
  for (let j = 1; j < 40; j++) {
    for (let i = 1; i < 40; i++) {
      const x = ox + (seabed.size * i) / 40;
      const z = oz + (seabed.size * j) / 40;
      const h = seabed.heightAt(x, z);
      if (h > -3 && h < 0 && coast < 20) {
        pts.push([x + 0.37, z - 0.21]);
        coast++;
      } else if ((i * 7 + j * 3) % 29 === 0) pts.push([x, z]);
    }
  }
  pts.push([ox - 200, oz - 200]); // outside the grid: clamp-to-edge on both sides
  points = pts;
}, 600_000);

describe('§T.191 world data: the core mirror equals the page mirror bit for bit', () => {
  it('heightAt / pressureHeadAt, fetch versions and the trace fetch version match per tick, through a wind and a swell turn', async () => {
    expect(points.length).toBeGreaterThanOrEqual(50);
    const pp = params();
    const fetch = createFetchField(seabed, pp.ocean);
    const bedGrid = gridSeabed(data);
    const page = new CpuOcean(SEED, pp.ocean, pp.sea);
    page.setSeabed(bedGrid, -bedGrid.openHeight);
    page.setFetch(fetch);
    // mutation twin: the closure seabed (what the page had before §T.191)
    const zp = params();
    const closure = new CpuOcean(SEED, zp.ocean, zp.sea);
    closure.setSeabed(seabed, -seabed.openHeight);
    closure.setFetch(createFetchField(seabed, zp.ocean));

    const cp = params();
    const fleet = new BoatFleet({ boats: 1, kind: 'main', seed: SEED, oceanParams: cp.ocean, seaParams: cp.sea, world: structuredClone(data), trace: true });
    await fleet.ready;
    const core = (fleet.transport as MainThreadTransport).core;
    // mutation twin: a core without world data (the pre-T191 open-sea rival)
    const op = params();
    const open = new BoatFleet({ boats: 1, kind: 'main', seed: SEED, oceanParams: op.ocean, seaParams: op.sea });
    await open.ready;
    const openCore = (open.transport as MainThreadTransport).core;
    let openCaught = false;
    expect(core.fetchField).not.toBeNull();
    const g = world.gates[1].mid;
    fleet.place(0, { position: [g[0], 0.3, g[1]], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] });
    open.place(0, { position: [g[0], 0.3, g[1]], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] });

    let time = 0;
    let compared = 0;
    let mutationCaught = false;
    let shadowed = 0;
    let shoal = 0;
    const versions: number[] = [];
    for (let k = 1; k <= TICKS; k++) {
      time += SIM_DT;
      move(pp, k);
      move(cp, k);
      move(zp, k);
      move(op, k);
      open.kick(k, time, op.ocean, op.sea);
      await open.done();
      page.update(time);
      closure.update(time);
      fleet.setControls(0, 0.3, 0.1);
      fleet.kick(k, time, cp.ocean, cp.sea);
      await fleet.done();
      if (!CHECK.has(k)) continue;
      for (const [x, z] of points) {
        const a = page.heightAt(x, z, time);
        expect(core.ocean.heightAt(x, z, time), `heightAt(${x}, ${z}) tick ${k}`).toBe(a);
        expect(core.ocean.pressureHeadAt(x, z, time), `pressureHeadAt(${x}, ${z}) tick ${k}`).toBe(page.pressureHeadAt(x, z, time));
        if (closure.heightAt(x, z, time) !== a) mutationCaught = true;
        if (openCore.ocean.heightAt(x, z, time) !== a) openCaught = true;
        if (fetch.shadowAt(x, z) < 0.5) shadowed++;
        if (bedGrid.heightAt(x, z) > -8) shoal++;
        compared++;
      }
      expect(core.fetchField?.version, `fetch version tick ${k}`).toBe(fetch.version);
      expect(fleet.readTrace(0, 0, TR.FETCH_VERSION)).toBe(core.fetchField?.version);
      versions.push(fetch.version);
    }
    expect(compared).toBeGreaterThanOrEqual(50 * CHECK.size);
    // the fields did rebuild inside the run (otherwise the turns proved nothing)
    expect(versions[versions.length - 1]).toBeGreaterThan(versions[0]);
    // and the points actually sample shelter and shallow water
    expect(shadowed).toBeGreaterThan(0);
    expect(shoal).toBeGreaterThan(0);
    expect(mutationCaught, 'a closure-seabed mirror must differ somewhere').toBe(true);
    expect(openCaught, 'an open-sea core must differ somewhere').toBe(true);
    fleet.dispose();
    open.dispose();
  }, 600_000);

  it('maskedFetchField answers exactly what the closure-built field answers, before and after the params move', () => {
    const p = params();
    const a = createFetchField(seabed, p.ocean);
    const b = maskedFetchField(structuredClone(data), p.ocean);
    const check = (): void => {
      for (const [x, z] of points) {
        expect(b.fetchAt(x, z), `fetchAt(${x}, ${z})`).toBe(a.fetchAt(x, z));
        expect(b.shadowAt?.(x, z), `shadowAt(${x}, ${z})`).toBe(a.shadowAt?.(x, z));
      }
      expect(b.version).toBe(a.version);
    };
    check();
    move(p, WIND_TICK);
    check();
    move(p, SWELL_TICK);
    check();
    // the land mask is not trivial
    expect(data.fetch.land.some((v) => v === 1)).toBe(true);
    expect(data.fetch.land.some((v) => v === 0)).toBe(true);
    // a params change the mask was not baked for fails loud
    expect(() => maskedFetchField(data, { ...p.ocean, fetchFieldSize: p.ocean.fetchFieldSize * 2 })).toThrow(/fetch mask/);
  });

  it('the race bed is the same function of the same data on both sides, and it still passes boats over the bar', () => {
    const page = raceBed(data);
    const worker = raceBed(structuredClone(data));
    const reference = createRaceSeabed(gridSeabed(data).heightAt, world.bars);
    for (const [x, z] of points) {
      expect(worker.heightAt(x, z)).toBe(page.heightAt(x, z));
      expect(reference.heightAt(x, z)).toBe(page.heightAt(x, z));
    }
    const crest = world.bars[0].crest[Math.floor(world.bars[0].crest.length / 2)];
    expect(page.heightAt(crest[0], crest[1])).toBeLessThanOrEqual(-5.9);
    expect(gridSeabed(data).heightAt(crest[0], crest[1])).toBeGreaterThan(-5);
  });

  it('a grid is the seabed at its texel centres (the GPU texture convention), within float32', () => {
    const d = data.seabed;
    const cell = d.size / d.res;
    const bed = gridSeabed(data);
    for (const [i, j] of [[3, 5], [200, 311], [256, 256], [100, 400]] as const) {
      const x = d.origin[0] + (i + 0.5) * cell;
      const z = d.origin[1] + (j + 0.5) * cell;
      expect(Math.abs(bed.heightAt(x, z) - seabed.heightAt(x, z))).toBeLessThan(1e-3);
    }
  });
});

