/**
 * §T.191 NOTHING SPAWNS IN A ROCK (user playtest 2026-09-13: the player spawned inside a rock at the grid).
 *
 * WHY: a grid slot, the pace boat's path or a respawn point inside a collider teleports a hull into solid geometry —
 * the collision solve then launches it (the "reset throws us out of the water" class of report) or it sits inside a
 * rock the physics never saw. Checked against exactly what the page collides with: the Tower Reach colliders plus the
 * page's own collider list (page/course.ts `towerReachCourse().attach` over the drawn kit decor: course furniture, roofs and
 * capsules fitted to the rendered island props, §T.198 — tests/speedboatCollisionWorld.ts) and the physics bed (raceBed
 * over the worker seabed grid). Before, this harness seeded pirate rock placements the page never had.
 *  - every grid slot through the whole rolling start (t = 0 … green): ≥ GRID_MARGIN from any solid collider, ≥ 2 m
 *    of water;
 *  - the pace line every 4 m: ≥ LINE_MARGIN clear, ≥ 1.5 m of water; the racing line every 4 m: no solid within 2 m;
 *  - the respawn candidates (reference line every 10 m, the points race/respawn.ts may pick): the page's `isClear`
 *    must accept at least one candidate within the search window behind every point of the lap.
 */
import { describe, expect, it } from 'vitest';
import { Race } from '../src/race/race';
import { raceParams } from '../src/race/params';
import { bakeSimWorldData, raceBed } from '../src/sim-worker/worldData';
import { clearanceAt, respawnClear } from '../src/speedboat/page/course';
import { courseColliders } from '../src/circuit/courseColliders';
import { collisionWorld } from './speedboatCollisionWorld';
import { courseFixture, seaOcean } from './speedboatRaceHarness';

const GRID_MARGIN = 8; // half a hull length + a beam: no part of a 12 m hull within reach of a rock
const LINE_MARGIN = 4;
/** m: the pilot's measured cross-track error near an element (docs/speedboat/npc-ai.md, 4–6 m), less a little */
const TRACKING_ERROR = 5.5;

describe('§T.191 spawn and respawn clearance on Tower Reach', () => {
  it('grid slots, the pace line and respawn candidates are in open water, clear of every rock and structure', () => {
    const fx = courseFixture();
    const sw = bakeSimWorldData(fx.seabed, seaOcean('calm'), fx.world.bars);
    const bedField = raceBed(sw);
    const bed = (x: number, z: number): number => bedField.heightAt(x, z);
    // WHY: the harness must check (and race on) the world the page collides with — the drawn props, not a stand-in list
    expect(fx.colliders, 'the page attach output').toBe(collisionWorld().page.colliders);
    const furniture = courseColliders(fx.world).length;
    console.log(`[clearance] ${fx.colliders.length} solid/flexible colliders (${fx.colliders.length - furniture} drawn island props)`);
    expect(fx.colliders.length - furniture, 'capsules fitted to the drawn kit props').toBeGreaterThan(1000);
    const ids = [1, 2, 3, 4, 5, 6, 7, 0];
    const race = new Race({ course: fx.course, racerIds: ids });
    const bad: string[] = [];
    for (let t = 0; t <= race.schedule.green; t += 0.5) {
      for (const id of ids) {
        const g = race.gridSlot(id, t);
        const c = clearanceAt(fx.colliders, bed, g.x, g.z, GRID_MARGIN, 2);
        if (!c.clear) bad.push(`grid #${id} t ${t}: (${g.x.toFixed(0)}, ${g.z.toFixed(0)}) bed ${c.bed.toFixed(1)} nearest ${c.nearest.toFixed(1)} m (collider ${c.nearestIndex})`);
      }
    }
    const pace = race.paceLine;
    for (let s = 0; s <= pace.length; s += 4) {
      const q = pace.pointAt(s);
      const c = clearanceAt(fx.colliders, bed, q.x, q.z, LINE_MARGIN, 1.5);
      if (!c.clear) bad.push(`pace line s ${s}: (${q.x.toFixed(0)}, ${q.z.toFixed(0)}) bed ${c.bed.toFixed(1)} nearest ${c.nearest.toFixed(1)} m`);
    }
    // the racing line itself: no solid collider within 2 m (a rock the line runs through makes the lap unraceable)
    for (let u = 0; u < race.line.length; u += 4) {
      const q = race.line.at(u);
      const c = clearanceAt(fx.colliders, () => -10, q.x, q.z, 2, 0);
      if (!c.clear) bad.push(`racing line u ${u}: (${q.x.toFixed(0)}, ${q.z.toFixed(0)}) nearest ${c.nearest.toFixed(1)} m (collider ${c.nearestIndex})`);
    }
    expect(bad.slice(0, 20), `${bad.length} violations`).toEqual([]);

    const line = race.line;
    const p = raceParams.respawn;
    const isClear = respawnClear(fx.colliders, bed);
    const stranded: string[] = [];
    for (let u = 0; u < line.length; u += 10) {
      let ok = false;
      for (let back = p.backDistance; back <= p.maxBackDistance && !ok; back += p.searchStep) {
        const q = line.at(u - back);
        ok = isClear(q.x, q.z);
      }
      if (!ok) stranded.push(`u ${u}`);
    }
    expect(stranded, 'crash points with no clear respawn candidate').toEqual([]);
  }, 900_000);

  // §T.197 WHY: the smoke race gave EVERY racer +5 s — a boat sailing the circuit's own reference line was called
  // missed at T1, whose rounding ray (a turn sharper than 90°) is crossed 51 m after the line's nearest point to the
  // mark while the miss is called 50 m past it. The authored line through the authored elements, judged by Race with
  // the page's course (authored handedness, §T.197), must be a clean lap: every element once, in order, no penalty.
  it('the reference line itself sails a clean lap: every gate and mark counted, no penalty', () => {
    const fx = courseFixture();
    const params = { ...raceParams, start: { ...raceParams.start, prestartSeconds: 0, pullOffDistance: 100_000 } };
    const race = new Race({ course: { ...fx.course, laps: 2 }, racerIds: [0], params });
    const L = race.line.length;
    const v = 40;
    const dt = 1 / 60;
    const crossed: string[] = [];
    const penalties: string[] = [];
    for (let u = -30; u < 2 * L + 60; u += v * dt) {
      const positions: [number, number][] = [1, 2].map((j) => {
        const q = race.line.at(u + (v * dt * j) / 2);
        return [q.x, q.z];
      });
      const r = race.step([{ racerId: 0, positions, speed: v, airborne: false, slam: 0, pitch: 0, roll: 0, crashed: false, launchedFromWake: false, surgePressed: false, respawnRequested: false }]);
      for (const e of r.events) {
        if (e.kind === 'gateCrossed') crossed.push(e.id);
        if (e.kind === 'penalty') penalties.push(`${e.reason} element ${e.element}`);
      }
    }
    const ids = fx.course.elements.map((e) => (e.kind === 'gate' ? e.gate.id : e.mark.id));
    expect(penalties).toEqual([]);
    expect(crossed).toEqual([...ids, ...ids, ids[0]]);
  }, 300_000);

  // WHY: every rival took +5 s at T1 in the live smoke race: the pilots' line rounded it 30–35 m out, 2–7 m outside the
  // 28 m rounding radius, and a boat tracking its line to the measured 4–6 m cut inside it. Each level's line, displaced
  // toward every mark by that tracking error, judged by Race with the page's course, must still be a clean lap.
  it("the rivals' lines round every mark clear of its radius even with the pilot's tracking error", () => {
    const fx = courseFixture();
    const marks = fx.course.elements.flatMap((e) => (e.kind === 'mark' ? [e.mark] : []));
    const params = { ...raceParams, start: { ...raceParams.start, prestartSeconds: 0, pullOffDistance: 100_000 } };
    for (const lv of fx.pilot.levels) {
      const L = lv.line;
      const X = Float64Array.from(L.x);
      const Z = Float64Array.from(L.z);
      let closest = Infinity;
      for (let i = 0; i < L.n; i++) {
        for (const m of marks) {
          const d = Math.hypot(L.x[i] - m.at[0], L.z[i] - m.at[1]);
          closest = Math.min(closest, d - m.radius);
          if (d < 150) {
            X[i] -= ((L.x[i] - m.at[0]) / d) * TRACKING_ERROR;
            Z[i] -= ((L.z[i] - m.at[1]) / d) * TRACKING_ERROR;
          }
        }
      }
      expect(closest, `risk ${lv.risk}: nearest approach to a mark, beyond its radius`).toBeGreaterThanOrEqual(lv.margin + TRACKING_ERROR);
      const race = new Race({ course: { ...fx.course, laps: 2 }, racerIds: [0], params });
      const at = (u: number): [number, number] => {
        const q = (((u / L.ds) % L.n) + L.n) % L.n;
        const i = Math.floor(q);
        const j = (i + 1) % L.n;
        return [X[i] + (X[j] - X[i]) * (q - i), Z[i] + (Z[j] - Z[i]) * (q - i)];
      };
      const v = 40;
      const dt = 1 / 60;
      const penalties: string[] = [];
      for (let u = -30; u < 2 * L.length + 60; u += v * dt) {
        const r = race.step([{ racerId: 0, positions: [at(u + (v * dt) / 2), at(u + v * dt)], speed: v, airborne: false, slam: 0, pitch: 0, roll: 0, crashed: false, launchedFromWake: false, surgePressed: false, respawnRequested: false }]);
        for (const e of r.events) if (e.kind === 'penalty') penalties.push(`${e.reason} element ${e.element}`);
      }
      expect(penalties, `risk ${lv.risk}`).toEqual([]);
    }
  }, 300_000);
});
