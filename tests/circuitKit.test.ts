/**
 * §T.194 RACE ISLAND KIT TERRAIN — what the kit's islands are made of, and that
 * none of it leaks into a pirate or raft island.
 *
 * WHY THESE AND NOT PIXELS: the look is checked headless in the browser
 * (docs/speedboat/circuit.md §T194); what can fail silently without a renderer
 * is (a) the hook reaching an island it must not, (b) a prop hovering over the
 * water or sitting in the racing corridor — a hazard the course author never
 * placed (the §T.194 integration report: ~190 scatter rocks floating off Bar
 * Head and Main Street, 37 in the corridor headless), (c) the kit's own
 * semantics drifting: a rock garden sanded over, a cay turned to granite.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { generateIslandSites, siteParams } from '../src/island/archipelago';
import { generateIslandHeightmap, type IslandHeightmap } from '../src/island/heightmap';
import { generateSierraSites } from '../src/island/sierraSites';
import { generateRockPlacements } from '../src/island/rocks';
import { generateStructurePlan } from '../src/island/structures';
import { kitHooksFor } from '../src/island/kitIsland';
import { sierraParams } from '../src/params/sierra';
import { islandParams } from '../src/params/island';
import { CORRIDOR_HALF_WIDTH, towerReachSites } from '../src/circuit/towerReach';
import { kitRenderInfo, kitSurfaceFor } from '../src/circuit/kitRender';
import { planKitDecor, propReach, type Placed } from '../src/circuit/kitDecor';
import { sampleKitSurface } from '../src/circuit/kitSurface';
import { distanceToClosed } from '../src/circuit/courseLine';
import { clipPolyhedron } from '../src/circuit/kitDecor';
import { kitField } from '../src/circuit/kitFamilies';
import { createRng } from '../src/state/rng';

const SEED = 1965;

/** heightmaps + rock placements + structure plans of the pirate (1, 1965) and raft (1965) worlds */
function pirateRaftHash(): string {
  const h = createHash('sha256');
  const sites = [...generateIslandSites(1).slice(0, 3), ...generateIslandSites(SEED).slice(0, 2), ...generateSierraSites(SEED).sites.slice(0, 3)];
  for (const s of sites) {
    const hm = generateIslandHeightmap(s.seed, siteParams(s));
    h.update(new Uint8Array(hm.data.buffer, hm.data.byteOffset, hm.data.byteLength));
    h.update(JSON.stringify(generateRockPlacements(s.seed + 1013, hm)));
    h.update(JSON.stringify(generateStructurePlan(s.seed + 4057, hm)));
  }
  return h.digest('hex');
}

let beforeKit: string;
let layout: ReturnType<typeof towerReachSites>;
let kit: { id: string; hm: IslandHeightmap }[];

beforeAll(() => {
  // the hash is taken BEFORE this process registers the race kit's hooks
  beforeKit = pirateRaftHash();
  layout = towerReachSites(SEED);
  kit = layout.sites.map((s, i) => ({ id: layout.ids[i], hm: generateIslandHeightmap(s.seed, siteParams(s)) }));
}, 240_000);

describe('§T.194 the kit hooks reach kit islands only', () => {
  it('authored cay beaches stay above still water through the terrain pipeline', () => {
    for (const { id, hm } of kit) {
      const info = kitRenderInfo(hm);
      if (info.kind !== 'sandCay') continue;
      const field = kitField(info.spec, createRng(info.seed), info.seed);
      let beach = 0, drowned = 0, authoredSum = 0, actualSum = 0;
      const r = hm.worldRadius;
      for (let z = -r * 0.7; z < r * 0.7; z += 3) for (let x = -r * 0.7; x < r * 0.7; x += 3) {
        const authored = field.heightAt(x, z);
        if (authored < 0.3 || authored > 1.5) continue;
        beach++;
        authoredSum += authored;
        actualSum += hm.heightAt(x, z);
        if (hm.heightAt(x, z) < 0) drowned++;
      }
      expect(beach, id).toBeGreaterThan(20);
      console.log('cay beach', id, { beach, drowned, authoredMean: authoredSum / beach, actualMean: actualSum / beach });
      expect(drowned / beach, id).toBeLessThan(0.02);
      expect(actualSum / authoredSum, `${id} beach elevation retained`).toBeGreaterThan(0.85);
    }
  });
  it('pirate and raft islands are byte-identical after the race kit registers its render hooks', () => {
    expect(pirateRaftHash()).toBe(beforeKit);
  }, 240_000);

  it('hooks answer for `kit:` heightmaps and for nothing else', () => {
    for (const { hm } of kit) expect(kitHooksFor(hm)).not.toBeNull();
    const pirate = generateIslandHeightmap(generateIslandSites(1)[0].seed, siteParams(generateIslandSites(1)[0]));
    expect(kitHooksFor(pirate)).toBeNull();
    expect(kitHooksFor({ archetype: 'dome' })).toBeNull();
  });
});

describe('§T.194 no scatter rock floats or blocks the course', () => {
  it('kit islands build NO shore/cliff/inland scatter: their granite is the kit blocks', () => {
    for (const [i, { hm }] of kit.entries()) {
      const p = { ...islandParams, ...siteParams(layout.sites[i]) };
      const sp = kitHooksFor(hm)!.sierraParams(hm, sierraParams);
      // the pirate shore scatter is what floated (rockSeaSeat seats a rock at the waterline over any depth)
      const scatter = generateRockPlacements(layout.sites[i].seed + 1013, hm, p, sp);
      expect(scatter, layout.ids[i]).toEqual([]);
      expect(generateStructurePlan(layout.sites[i].seed + 4057, hm, p).huts.length, `${layout.ids[i]} huts`).toBe(0);
    }
  });

  it('every kit prop sits on its own ground and keeps clear of the racing corridor', () => {
    for (const [i, { id, hm }] of kit.entries()) {
      const info = kitRenderInfo(hm);
      const plan = planKitDecor(hm, info, kitSurfaceFor(hm), layout.sites[i].seed);
      const all: [string, Placed][] = [
        ...plan.blocks.flat().map((p) => ['block', p] as [string, Placed]),
        ...plan.slabs.map((p) => ['slab', p] as [string, Placed]),
        ...plan.logs.flat().map((p) => ['log', p] as [string, Placed]),
        ...plan.rubble.flat().map((p) => ['rubble', p] as [string, Placed]),
      ];
      for (const [kind, p] of all) {
        const ground = hm.heightAt(p.pos[0], p.pos[2]);
        // its underside is at or below the ground under its centre (never hovering) …
        expect(p.pos[1] - Math.abs(p.scale[1]) * 0.5, `${id} ${kind} at ${p.pos.map((v) => v.toFixed(1))} floats`).toBeLessThanOrEqual(ground + 0.3);
        // … and a BIG block (the ones that read as floating when they bridge a hollow) sits down into the
        // lowest ground under the inner half of its footprint, not on the high side of it
        const reach = Math.max(p.scale[0], p.scale[2]) * 0.5;
        if (reach > 1.5 && Math.abs(p.scale[1]) > 0.5) {
          const r = reach * 0.5;
          const low = Math.min(ground, hm.heightAt(p.pos[0] + r, p.pos[2]), hm.heightAt(p.pos[0] - r, p.pos[2]), hm.heightAt(p.pos[0], p.pos[2] + r), hm.heightAt(p.pos[0], p.pos[2] - r));
          expect(p.pos[1] - Math.abs(p.scale[1]) * 0.5 - low, `${id} ${kind} (${reach.toFixed(1)} m) bridges a hollow`).toBeLessThan(Math.abs(p.scale[1]) * 0.5);
        }
        // … and it is not buried out of sight either
        expect(p.pos[1] + Math.abs(p.scale[1]) * 0.5, `${id} ${kind} buried`).toBeGreaterThan(ground - 0.2);
        // corridor: the reference line ± half-width, plus a margin and the prop's own reach
        const d = distanceToClosed(info.corridor as [number, number][], [p.pos[0], p.pos[2]]);
        expect(d - propReach(p), `${id} ${kind} in the corridor`).toBeGreaterThan(CORRIDOR_HALF_WIDTH);
      }
    }
  });
});

describe('§T.194 what each kit island is made of', () => {
  const landShare = (hm: IslandHeightmap, channel: 0 | 1 | 3, band: [number, number]): number => {
    const mask = kitSurfaceFor(hm);
    let n = 0;
    let sum = 0;
    const R = hm.worldRadius;
    for (let z = -R; z <= R; z += 4) {
      for (let x = -R; x <= R; x += 4) {
        const h = hm.heightAt(x, z);
        if (h < band[0] || h > band[1]) continue;
        n++;
        sum += sampleKitSurface(mask, channel, x, z);
      }
    }
    return n ? sum / n : 0;
  };
  const byId = (id: string) => kit.find((k) => k.id === id)!.hm;

  it('the rock garden is granite from the surf up, and keeps its authored whalebacks (no DG beach apron)', () => {
    const hm = byId('knuckle');
    expect(landShare(hm, 0, [-1, 30])).toBeGreaterThan(0.85);
    const spec = layout.specs[layout.ids.indexOf('knuckle')];
    if (spec.kind !== 'rockGarden') throw new Error('knuckle is not a rock garden');
    let peak = -Infinity;
    for (let i = 0; i < hm.data.length; i++) peak = Math.max(peak, hm.data[i]);
    // T130's profile apron flattened the 17 m knob to 12.7 m; the exact field keeps it
    expect(peak).toBeGreaterThan(spec.knobs[0].height - 1.5);
  });

  it('the sand cays are sand (a little beachrock), with a strandline; the drowned town is rubble', () => {
    for (const id of ['tower-cay', 'bar-head']) {
      const hm = byId(id);
      expect(landShare(hm, 0, [0.5, 30]), `${id} bedrock above the intertidal`).toBeLessThan(0.05);
      expect(landShare(hm, 3, [0.2, 3]), `${id} strand`).toBeGreaterThan(0.8);
    }
    expect(landShare(byId('main-street'), 1, [-1.5, 3])).toBeGreaterThan(0.45);
  });

  it('the side a rock faces the swell from is the exposed side (splash zone, salt)', () => {
    const hm = byId('knuckle');
    const mask = kitSurfaceFor(hm);
    const info = kitRenderInfo(hm);
    // swell travels along `swellTravel`, so it ARRIVES from −swellTravel
    const [tx, tz] = info.swellTravel;
    let facing = 0;
    let lee = 0;
    let nf = 0;
    let nl = 0;
    const R = hm.worldRadius;
    const e = (2 * R) / (hm.size - 1);
    for (let z = -R; z <= R; z += 3) {
      for (let x = -R; x <= R; x += 3) {
        const h = hm.heightAt(x, z);
        if (h < 0 || h > 3) continue;
        const gx = (hm.heightAt(x + e, z) - hm.heightAt(x - e, z)) / (2 * e);
        const gz = (hm.heightAt(x, z + e) - hm.heightAt(x, z - e)) / (2 * e);
        const s = Math.hypot(gx, gz);
        if (s < 0.1) continue;
        // downhill · (−travel) > 0: the face looks at the incoming swell
        const look = (gx * tx + gz * tz) / s;
        const ex = sampleKitSurface(mask, 2, x, z);
        if (look > 0.6) {
          facing += ex;
          nf++;
        } else if (look < -0.6) {
          lee += ex;
          nl++;
        }
      }
    }
    expect(nf).toBeGreaterThan(20);
    expect(nl).toBeGreaterThan(20);
    expect(facing / nf).toBeGreaterThan(lee / nl + 0.2);
  });

  it('a fractured block is a closed convex solid: every clip keeps it watertight', () => {
    let faces: [number, number, number][][] = [
      [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]],
      [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]],
      [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]],
      [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]],
      [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]],
      [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]],
    ];
    const n = Math.SQRT1_2;
    faces = clipPolyhedron(faces, [n, n, 0], 1.2);
    expect(faces.length).toBe(7);
    // divergence theorem: Σ area·n·centroid / 3 = volume; a cube 8 minus the cut prism (0.2929² · 2 / 2 · 2)
    let vol = 0;
    for (const f of faces) {
      for (let i = 1; i + 1 < f.length; i++) {
        const [a, b, c] = [f[0], f[i], f[i + 1]];
        vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
      }
    }
    const cut = (2 - 1.2 / n) ** 2 / 2 * 2;
    expect(vol).toBeCloseTo(8 - cut, 5);
  });
});
