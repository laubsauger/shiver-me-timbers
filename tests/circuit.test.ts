/**
 * §T.187 TOWER REACH + RACE ISLAND KIT — what the course promises the race.
 *
 * WHY THESE MATTER (§Rule 6):
 *  · the Course is the contract four other owners build on (race logic, AI,
 *    HUD, page) — a malformed one fails far from here, so it is validated here;
 *  · the lap length and 9 gates + 3 turn marks are the design doc's slice;
 *  · a gate a boat cannot pass two-abreast, a pole standing on a bank, or a
 *    corridor that grounds a hull turns a race into a reset loop;
 *  · sectors gate Surge earning (design doc §3) — a hand-tagged "lee" that the
 *    sea does not calm is a lie the player feels, so every tag is re-measured
 *    here from an INDEPENDENT shelter field and must be decisive, not marginal;
 *  · the exposed straights must face the swell three ways (head, beam,
 *    following) or the lap loses its three hazards;
 *  · sandbars NEVER ground a boat (design doc §3, Q10);
 *  · the world is a function of the seed (§V2) — multiplayer rebuilds it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import hullRaw from '../src/speedboat/deepV12.hull.json?raw';
import type { Course, Vec2 } from '../src/race/types';
import {
  BAR_MIN_CREST_DEPTH,
  BOAT_BEAM,
  BOAT_DRAFT,
  CORRIDOR_HALF_WIDTH,
  CORRIDOR_MIN_DEPTH,
  MIN_GATE_WIDTH,
  buildTowerReach,
  towerReachSites,
  type TowerReachWorld,
} from '../src/circuit/towerReach';
import {
  EXPOSED_MIN_K,
  REFERENCE_SEA,
  SHELTERED_MAX_K,
  createShelterField,
  sectorOf,
} from '../src/circuit/shelter';
import { validateCourse } from '../src/circuit/validateCourse';
import { createRaceSeabed, BAR_PASS_THROUGH_DEPTH } from '../src/circuit/raceSeabed';
import { closedLength, distanceToClosed, portOf } from '../src/circuit/courseLine';
import { registerKitIsland } from '../src/circuit/kitFamilies';
import { TOWER_REACH_SWELL_DIRECTION } from '../src/circuit/towerReachLayout';
import { weatherPresets } from '../src/weather/presets';
import { generateIslandSites, siteParams } from '../src/island/archipelago';
import { generateSierraSites } from '../src/island/sierraSites';
import { generateIslandHeightmap } from '../src/island/heightmap';
import { registerSierraFamily, type KitArchetypeName } from '../src/island/sierraArchetypes';
import { polylineDistance } from '../src/circuit/kitFamilies';
import contractRaw from '../src/circuit/assets/courseAssetContract.json?raw';
import { ROOF_CLEAR_DEPTH, courseColliders, roofColliders } from '../src/circuit/courseColliders';
import type { RoofPlacement } from '../src/circuit/towerReach';
import type { StaticCollider } from '../src/sea-physics/boatCollide';

function segmentDistance(a: readonly number[], b: readonly number[], p: readonly number[]): number {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const L2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
  const t = L2 > 0 ? Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / L2)) : 0;
  return Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t);
}

const hullJson = JSON.parse(hullRaw) as { spec: { mass: number; deadriseDeg: number; length: number }; derived: { beamOverall: number } };
const SEED = 1965;
const LAP_TARGET = 4074; // 2.2 nm
let world: TowerReachWorld;

beforeAll(() => {
  world = buildTowerReach(SEED);
}, 120_000);

const gatesOf = (c: Course) => c.elements.flatMap((e) => (e.kind === 'gate' ? [e.gate] : []));
const marksOf = (c: Course) => c.elements.flatMap((e) => (e.kind === 'mark' ? [e.mark] : []));

describe('Course contract (src/race/types.ts)', () => {
  it('validates, with 9 gates, 3 turn marks and the start gate first', () => {
    expect(validateCourse(world.course)).toEqual([]);
    expect(gatesOf(world.course)).toHaveLength(9);
    expect(marksOf(world.course)).toHaveLength(3);
    expect(world.course.elements[0]).toMatchObject({ kind: 'gate', gate: { id: world.course.startGateId } });
  });

  it('the validator catches what the types cannot (so a green result means something)', () => {
    const c = world.course;
    const bad = (patch: Partial<Course>) => validateCourse({ ...c, ...patch });
    expect(bad({ startGateId: 'G3' })).not.toEqual([]);
    expect(bad({ paceLine: c.paceLine.slice(0, -1) })).not.toEqual([]);
    expect(bad({ bounds: { min: [0, 0], max: [1, 1] } })).not.toEqual([]);
    expect(bad({ referenceLine: [...c.referenceLine, c.referenceLine[0]] })).not.toEqual([]);
    const dupe = [...c.elements, c.elements[1]];
    expect(bad({ elements: dupe })).not.toEqual([]);
  });

  it('lap is 2.2 nm (4074 m ± 5%)', () => {
    const lap = closedLength(world.course.referenceLine);
    expect(Math.abs(lap - LAP_TARGET) / LAP_TARGET).toBeLessThan(0.05);
    expect(Math.abs(world.lapLength - lap)).toBeLessThan(5);
  });

  it('the pace line is the lap run-up and ends on the start gate', () => {
    const pace = world.course.paceLine;
    let l = 0;
    for (let i = 1; i < pace.length; i++) l += Math.hypot(pace[i][0] - pace[i - 1][0], pace[i][1] - pace[i - 1][1]);
    expect(l).toBeGreaterThan(500);
    for (const p of pace) expect(distanceToClosed(world.course.referenceLine, p)).toBeLessThan(1);
  });

  it('turn marks are rounded to port, outside their rounding radius', () => {
    const line = world.course.referenceLine;
    for (const m of marksOf(world.course)) {
      expect(m.keepOn).toBe('port');
      // the nearest pass is outside the radius…
      expect(distanceToClosed(line, m.at)).toBeGreaterThan(m.radius);
      // …with the mark on the boat's PORT side there
      let best = 0;
      let bd = Infinity;
      line.forEach((p, i) => {
        const d = Math.hypot(p[0] - m.at[0], p[1] - m.at[1]);
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      const a = line[(best - 1 + line.length) % line.length];
      const b = line[(best + 1) % line.length];
      const port = portOf(b[0] - a[0], b[1] - a[1]);
      const toMark = [m.at[0] - line[best][0], m.at[1] - line[best][1]];
      expect(port[0] * toMark[0] + port[1] * toMark[1]).toBeGreaterThan(0);
    }
  });
});

describe('gates and corridor fit the boat', () => {
  it('BOAT_* numbers are the deepV12 hull: overall beam, and a draft no shallower than its prismatic vee', () => {
    const spec = hullJson.spec;
    expect(BOAT_BEAM).toBeGreaterThanOrEqual(hullJson.derived.beamOverall);
    // displaced volume on a 24° vee over ~85 % of the length: A(T) = T²/tan β
    const volume = spec.mass / 1025;
    const beta = (spec.deadriseDeg * Math.PI) / 180;
    const draft = Math.sqrt((volume * Math.tan(beta)) / (0.85 * spec.length));
    expect(BOAT_DRAFT).toBeGreaterThanOrEqual(draft);
  });

  it(`every gate is ≥ ${MIN_GATE_WIDTH} m — two boats abreast plus AI line tolerance`, () => {
    // 2 beams + 3 beams between + ±9 m National line tolerance each side + 3 m per pole
    const need = 2 * BOAT_BEAM + 3 * BOAT_BEAM + 2 * 9 + 2 * 3;
    expect(MIN_GATE_WIDTH).toBeGreaterThanOrEqual(need);
    for (const g of gatesOf(world.course)) {
      expect(Math.hypot(g.right[0] - g.left[0], g.right[1] - g.left[1]), g.id).toBeGreaterThanOrEqual(MIN_GATE_WIDTH);
    }
  });

  it('no pole stands on land or a bank: spar markers need water for their ballast', () => {
    for (const p of world.furniture.poles) {
      expect(-world.seabedAt(p.at[0], p.at[1]), `${p.gateId} ${p.side}`).toBeGreaterThanOrEqual(CORRIDOR_MIN_DEPTH);
    }
    for (const b of world.furniture.buoys) expect(b.depth, b.markId).toBeGreaterThanOrEqual(CORRIDOR_MIN_DEPTH);
  });

  it(`the corridor (±${CORRIDOR_HALF_WIDTH} m) keeps ≥ ${CORRIDOR_MIN_DEPTH} m of water outside bar zones`, () => {
    expect(CORRIDOR_MIN_DEPTH).toBeGreaterThan(BOAT_DRAFT + 2);
    expect(world.corridor.minDepth).toBeGreaterThanOrEqual(CORRIDOR_MIN_DEPTH);
  });

  it('structures stay out of the corridor: pylons, roofs, the tower, stakes, guy anchors', () => {
    const line = world.course.referenceLine;
    const f = world.furniture;
    for (const p of f.pylons) expect(distanceToClosed(line, p.at)).toBeGreaterThan(45);
    for (const r of f.roofs) expect(distanceToClosed(line, r.at)).toBeGreaterThan(24);
    for (const s of f.stakes) expect(distanceToClosed(line, s.at)).toBeGreaterThan(50);
    expect(distanceToClosed(line, f.tower.at)).toBeGreaterThan(45);
    for (const a of f.tower.anchors) expect(distanceToClosed(line, a)).toBeGreaterThan(20);
  });

  it('Main Street crashes a boat that hits a roof, never one on the racing line or over a fully drowned house', () => {
    // design doc §5 "drowned structure > 20 kn → reset": what pokes through must be solid to the crash code (§T.188),
    // and a collider that bulges into the corridor would reset boats on the clean line
    const contract = JSON.parse(contractRaw) as { roofs: Record<string, { eave: number; ridge: number; top: number }> };
    const key = { gable: 'Gable', gableChimney: 'GableChimney', hip: 'Hip', shed: 'Shed', steeple: 'Steeple', waterTower: 'WaterTower' } as const;
    const inside = (cs: StaticCollider[], p: [number, number, number]) => cs.some((c) => segmentDistance(c.a, c.b, p) <= c.radius + 1e-6);
    const toWorld = (r: RoofPlacement, x: number, y: number, z: number): [number, number, number] => [
      r.at[0] + x * Math.cos(r.yaw) + z * Math.sin(r.yaw), y + r.floor, r.at[1] - x * Math.sin(r.yaw) + z * Math.cos(r.yaw)];
    const all = courseColliders(world);
    let breaking = 0;
    for (const r of world.furniture.roofs) {
      const h = contract.roofs[key[r.kind]];
      const mine = roofColliders(r);
      if (h.top + r.floor <= ROOF_CLEAR_DEPTH) expect(mine, `${r.kind} under every hull`).toEqual([]);
      if (h.ridge + r.floor > 0) {
        breaking++;
        // a hull at the waterline over the middle of the building (and over the ridge) is in contact
        const zc = r.kind === 'steeple' ? -1 : 0;
        expect(inside(mine, toWorld(r, 0, -r.floor, zc)), `${r.kind} at the waterline`).toBe(true);
        // the store's tin roof falls from `ridge` at the front to `eave` at the back: its middle is halfway
        const roofY = r.kind === 'shed' ? (h.ridge + h.eave) / 2 : h.ridge;
        if (r.kind !== 'waterTower') expect(inside(mine, toWorld(r, 0, roofY - 0.05, zc)), `${r.kind} ridge`).toBe(true);
      }
      if (r.kind === 'gableChimney' && h.top + r.floor > 0) expect(inside(mine, toWorld(r, 7.6 * 0.26, h.top - 0.1, -2))).toBe(true);
      for (const c of mine) {
        expect(all).toContainEqual(c);
        for (let t = 0; t <= 1; t += 0.25) {
          const p: Vec2 = [c.a[0] + (c.b[0] - c.a[0]) * t, c.a[2] + (c.b[2] - c.a[2]) * t];
          expect(distanceToClosed(world.course.referenceLine, p) - c.radius, r.kind).toBeGreaterThan(CORRIDOR_HALF_WIDTH);
        }
      }
    }
    expect(breaking).toBeGreaterThan(20); // "34 of 35 houses break the surface" (docs/speedboat/circuit.md)
    // the same house sunk below a hull's draft stops colliding; raised, it collides again
    const house = world.furniture.roofs.find((r) => r.kind === 'gable')!;
    expect(roofColliders({ ...house, floor: -(contract.roofs.Gable.top + BOAT_DRAFT + 0.1) })).toEqual([]);
    expect(roofColliders({ ...house, floor: -contract.roofs.Gable.eave })).not.toEqual([]);
  });

  it('no rock-garden boulder that could hit a hull lies in the corridor', () => {
    const line = world.course.referenceLine;
    for (const hm of world.heightmaps) {
      const i = world.heightmaps.indexOf(hm);
      const c = world.sites[i].position;
      for (const f of hm.features) {
        if (f.kind !== 'sheer' || f.height < -(BOAT_DRAFT + 1.5)) continue;
        expect(distanceToClosed(line, [f.x + c[0], f.z + c[1]]) - f.radius).toBeGreaterThan(CORRIDOR_HALF_WIDTH);
      }
    }
  });
});

describe('sectors are measured swell shelter, not hand tags (§T.174)', () => {
  it('the reference sea is the shipped default preset the layout was authored against', () => {
    expect(REFERENCE_SEA.swellDirection).toBe(weatherPresets.swell.ocean.swellDirection);
    expect(REFERENCE_SEA.swellPeriod).toBe(weatherPresets.swell.ocean.swellPeriod);
    expect(TOWER_REACH_SWELL_DIRECTION).toBeCloseTo(REFERENCE_SEA.swellDirection!, 9);
  });

  it('every gate tag equals the K of an independently built shelter field, and is decisive', () => {
    const shelter = createShelterField(world.heightmaps.map((hm, i) => ({ heightmap: hm, center: world.sites[i].position })));
    // the field is real: far upswell of every island the swell is untouched
    const s = world.gates[0].mid;
    expect(shelter.kAt(s[0] - Math.cos(REFERENCE_SEA.swellDirection) * 3000, s[1] - Math.sin(REFERENCE_SEA.swellDirection) * 3000)).toBe(1);
    let sheltered = 0;
    for (const g of gatesOf(world.course)) {
      const mid: Vec2 = [(g.left[0] + g.right[0]) / 2, (g.left[1] + g.right[1]) / 2];
      const k = (shelter.kAt(mid[0], mid[1]) + shelter.kAt(g.left[0], g.left[1]) + shelter.kAt(g.right[0], g.right[1])) / 3;
      expect(g.sector, `${g.id} K=${k.toFixed(3)}`).toBe(sectorOf(k));
      expect(k <= SHELTERED_MAX_K || k >= EXPOSED_MIN_K, `${g.id} K=${k.toFixed(3)} is marginal`).toBe(true);
      if (g.sector === 'sheltered') sheltered++;
    }
    shelter.dispose();
    // the lap alternates: shelter AND open water, with a real share of each
    expect(sheltered).toBeGreaterThanOrEqual(3);
    expect(9 - sheltered).toBeGreaterThanOrEqual(3);
  });

  it('the exposed straights face the swell three ways: head sea, beam sea, following sea', () => {
    const sw: Vec2 = [Math.cos(REFERENCE_SEA.swellDirection), Math.sin(REFERENCE_SEA.swellDirection)];
    const angle = (id: string): number => {
      const g = world.gates.find((x) => x.id === id)!;
      return (Math.acos(Math.max(-1, Math.min(1, g.heading[0] * sw[0] + g.heading[1] * sw[1]))) * 180) / Math.PI;
    };
    const sector = (id: string) => gatesOf(world.course).find((g) => g.id === id)!.sector;
    for (const id of ['G2', 'G3']) {
      expect(sector(id)).toBe('exposed');
      expect(angle(id), `${id} head sea`).toBeGreaterThan(135);
    }
    expect(sector('G4')).toBe('exposed');
    expect(Math.abs(angle('G4') - 90), 'G4 beam sea').toBeLessThan(35);
    expect(sector('G5')).toBe('exposed');
    expect(angle('G5'), 'G5 following sea').toBeLessThan(45);
  });
});

describe('sandbars never ground a boat', () => {
  it('The Bar is crossed, is really shallow there, and keeps ≥ BAR_MIN_CREST_DEPTH in the corridor', () => {
    expect(world.bars.length).toBeGreaterThanOrEqual(1);
    expect(BAR_MIN_CREST_DEPTH).toBeGreaterThanOrEqual(BOAT_DRAFT + 1.4);
    const bar = world.bars[0];
    expect(bar.crossing).not.toBeNull();
    expect(bar.corridorCrestDepth).toBeGreaterThanOrEqual(BAR_MIN_CREST_DEPTH);
    // it is a bar, not a mark on a chart: the crossing is far shallower than the corridor elsewhere
    expect(-world.seabedAt(bar.crossing![0], bar.crossing![1])).toBeLessThan(4);
  });

  it('the crest never rises above −crestDepth anywhere along its length (not only at the crossing)', () => {
    for (const bar of world.bars) {
      for (let j = 0; j + 1 < bar.crest.length; j++) {
        for (let t = 0; t <= 1; t += 0.05) {
          const x = bar.crest[j][0] + (bar.crest[j + 1][0] - bar.crest[j][0]) * t;
          const z = bar.crest[j][1] + (bar.crest[j + 1][1] - bar.crest[j][1]) * t;
          // the bar head islet is dry land by design; the bar itself is not
          const nearHead = world.furniture.stakes.length >= 0 && world.minimap.land.some((r) => r.some((p) => Math.hypot(p[0] - x, p[1] - z) < 60));
          if (nearHead) continue;
          expect(-world.seabedAt(x, z)).toBeGreaterThanOrEqual(BAR_MIN_CREST_DEPTH - 0.05);
        }
      }
    }
  });

  it('race physics sees a pass-through bed over the bar and the real bed elsewhere', () => {
    const phys = createRaceSeabed(world.seabedAt, world.bars);
    const x = world.bars[0].crossing!;
    expect(phys.heightAt(x[0], x[1])).toBeLessThanOrEqual(-BAR_PASS_THROUGH_DEPTH);
    const far = world.gates.find((g) => g.id === 'G7')!.mid;
    expect(phys.heightAt(far[0], far[1])).toBe(world.seabedAt(far[0], far[1]));
    // never shallower than the real bed anywhere (it can only remove contact)
    for (let i = 0; i < world.course.referenceLine.length; i += 7) {
      const p = world.course.referenceLine[i];
      expect(phys.heightAt(p[0], p[1])).toBeLessThanOrEqual(world.seabedAt(p[0], p[1]));
    }
    // and it blends (no step at the zone edge)
    const b = world.bars[0];
    let prev = phys.heightAt(x[0], x[1]);
    const dir = world.gates.find((g) => g.id === 'G2')!.heading;
    for (let s = 1; s < 200; s++) {
      const h = phys.heightAt(x[0] - dir[0] * s, x[1] - dir[1] * s);
      expect(Math.abs(h - prev)).toBeLessThan(1.2);
      prev = h;
    }
    expect(polylineDistance(b.crest, x[0], x[1]).d).toBeLessThan(5);
  });
});

describe('minimap', () => {
  it('carries the course, every island coastline and the gates inside the bounds', () => {
    const mm = world.minimap;
    expect(mm.land.length).toBeGreaterThanOrEqual(world.sites.length);
    expect(Math.abs(closedLength(mm.course) - world.lapLength) / world.lapLength).toBeLessThan(0.01);
    const inside = (p: Vec2) => p[0] >= mm.bounds.min[0] && p[0] <= mm.bounds.max[0] && p[1] >= mm.bounds.min[1] && p[1] <= mm.bounds.max[1];
    for (const r of mm.land) for (const p of r) expect(inside(p)).toBe(true);
    for (const g of mm.gates) expect(inside(g.left) && inside(g.right)).toBe(true);
    expect(mm.gates).toHaveLength(9);
    expect(world.course.bounds).toEqual(mm.bounds);
  });
});

describe('determinism (§V2)', () => {
  it('same seed ⟹ same hash; a different seed moves the seeded terrain but not the authored course', () => {
    const again = buildTowerReach(SEED);
    expect(again.hash).toBe(world.hash);
    expect(again.course).toEqual(world.course);
    const other = buildTowerReach(SEED + 1);
    expect(other.hash).not.toBe(world.hash);
    expect(gatesOf(other.course).map((g) => g.id)).toEqual(gatesOf(world.course).map((g) => g.id));
    again.dispose();
    other.dispose();
  }, 120_000);
});

describe('kit hook in src/island is additive', () => {
  const hashIslands = (): string => {
    let h = 0x811c9dc5;
    const eat = (a: Float32Array) => {
      const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
      for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 0x01000193);
    };
    for (const s of generateIslandSites(1).slice(0, 3)) eat(generateIslandHeightmap(s.seed, siteParams(s)).data);
    for (const s of generateSierraSites(1965).sites.slice(0, 3)) eat(generateIslandHeightmap(s.seed, siteParams(s)).data);
    return (h >>> 0).toString(16);
  };

  it('registering kit families changes no pirate or sierra island (byte-identical grids)', () => {
    const before = hashIslands();
    towerReachSites(424242);
    expect(hashIslands()).toBe(before);
  }, 60_000);

  it('an unregistered kit name fails loud, and a name cannot be rebound to another family', () => {
    const site = { seed: 1, position: [0, 0] as [number, number], radius: 200, archetype: 'kit:nobody/1' as KitArchetypeName };
    expect(() => generateIslandHeightmap(1, siteParams(site))).toThrow(/not registered/);
    const name = 'kit:test/rebind' as KitArchetypeName;
    registerKitIsland(name, { kind: 'drownedTown', knoll: { x: 0, z: 0, r: 40, height: 6 }, bench: { x: 0, z: 0, halfLength: 60, halfWidth: 30, axis: 0, depth: 6, edge: 30 }, floorDepth: 20, shelf: 60 }, 1);
    expect(() => registerSierraFamily(name, { peak: () => 1, build: () => { throw new Error('x'); } })).toThrow(/already registered/);
  });
});
