/**
 * The sunken world's builders (src/drowned: town.ts, fanPalm.ts, drownedLook.ts — the ones the game will share) and
 * the film's placing of them on its coast (src/drift/wandering/drowned.ts: sunken-world-cues.md cues 5 and 6). What
 * must hold, whatever they are tuned to:
 *
 *   - the town is a few pieces, under the water at a depth that reads as a shape through it and not in the band
 *     where a ridge read as a floating plank (the 2026-10-30 rounds), one chimney top just awash; each over the sand
 *     that fills the streets — a roof wholly buried says nothing about a drowned town;
 *   - the eye can see them: some house stands in the dome's view ahead (18–45 m, within 35° of the front — the 15°
 *     tilt hides anything steeper) through w1's sail along the coast and through w2's run-in to the beach, the
 *     beats the cue is for;
 *   - the raft never sails into one (its logs reach ~7 m from its centre and it heaves on the swell), and nothing
 *     stands in the swash sim's water, which knows nothing of them;
 *   - the boulevard is one broken line of a few trees — living, dead, snapped, one fallen across it — never a grid
 *     (the user, from the air, 2026-10-30: "the super regular grid"), clear of the raft, the eye and the houses;
 *   - the power line at sea is SHORT (the 2026-11-02 next-level review, move 3: "four or five half-drowned pylons march
 *     out of the swell toward the sun … the last tower leans", "not a road to the horizon"): five, one span crossing
 *     the eye's way ahead (the wires sweep overhead), then a straight row seen ACROSS the front, spread out and not
 *     stacked end-on, each further and nearer the Sun's bearing, the last beside it, leaning, its far conductors
 *     hanging into the sea; and its wires clear the raft's masthead where it sails under them;
 *   - the kit builds with the buried parts dropped, and every material compiles (real TSL codegen, no GPU).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { float, vec3 } from 'three/tsl';
import { createFilmCoast } from '../src/drift/wandering/coast';
import { BOULEVARD, CABLE_MIN_ANGLE, CHURCH, LOTS, RAFT_CLEAR, SUNKEN_SET, SWASH_EDGE, cableGoldSheen, drownedLayout, POWER_STUB, seaPowerLine, stubPowerLine } from '../src/drift/wandering/drowned';
import { beatStarts, beatsAt, coastEye, coastLook, landfall, raftPose } from '../src/drift/wandering/beats';
import { BUILDING_DIMS, BURIED, buildTown, buildingMatrix, loadTownKit, type BuildingSpec } from '../src/drowned/town';
import { LEAF, buildFanPalms, crownOf, leafGeometry, trunkAxis, type FanPalmSpec } from '../src/drowned/fanPalm';
import { attachAt, buildPowerLine, loadPylonKit, plainPylonKit, pylonMatrix } from '../src/drowned/powerLine';
import { beatSun } from '../src/drift/wandering/beats';

const coast = createFilmCoast([-40000, 0], { ground: () => ({ albedo: vec3(0.5), roughness: float(1) }) } as never);
// (its radio towers' GLB fetch fails in node; the ground is all this reads)
coast.ready.catch(() => {});
const beach = coast.beach;
const layout = drownedLayout(beach, coast.ground);
const houses = layout.buildings.filter((b) => b.kind !== 'Steeple');

/** the kit's plan half-extents (m, its x and z: the LOD0 bounds, eaves included) */
const HALF: Record<string, [number, number]> = { Gable: [4.32, 5.47], GableChimney: [4.32, 5.47], Hip: [4.67, 4.67], Shed: [4.9, 7.74], Steeple: [4.93, 10.4], WaterTower: [3.95, 3.95] };
/** m from a world point to a building's plan footprint (0 inside) */
function toFootprint(b: BuildingSpec, x: number, z: number): number {
  const p = new THREE.Vector3(x, b.floor, z).applyMatrix4(buildingMatrix(b).invert());
  const [hx, hz] = HALF[b.kind];
  return Math.hypot(Math.max(0, Math.abs(p.x) - hx), Math.max(0, Math.abs(p.z) - hz));
}
const along = (z: number): number => beach.z - z;
const off = (x: number): number => beach.x - x;

// the coast's beats, as sea.ts lays them (c1End only shifts the clock; every pose field is a key's by w1)
const c1End = 41.1;
const { starts } = beatStarts(c1End);
const rest = { bearing: 0.5, distance: 18, heading: 0, height: 3 };
const raftAt = (t: number): { x: number; z: number } => {
  const at = (s: number): { x: number; z: number } => {
    const e = coastEye(s, c1End, beach);
    const p = raftPose(s, c1End, rest);
    return { x: e.x + Math.sin(p.bearing) * p.distance, z: e.z - Math.cos(p.bearing) * p.distance };
  };
  return t <= starts.w2 ? at(t) : landfall(t, c1End, at(starts.w2), beach);
};
const times = (a: number, b: number, dt = 0.5): number[] => Array.from({ length: Math.round((b - a) / dt) + 1 }, (_, i) => a + i * dt);
const w1 = times(starts.w1 + 5, starts.w2);
const runIn = times(starts.w2, starts.w2 + 30);
const ashore = times(starts.w2 + 30, starts.w3 + 20);

describe('the drowned town on our coast', () => {
  it('is a few pieces under the water, never at the surface\'s plank band — one chimney top just awash', () => {
    // (the user, 2026-10-30, on two rows of whole roofs out of the water: "no, that's not gonna fly")
    expect(houses.length).toBeLessThanOrEqual(6);
    for (const b of houses) {
      const d = BUILDING_DIMS[b.kind];
      const top = b.floor + d.top;
      const ridge = b.floor + d.ridge;
      if (b.kind === 'GableChimney') {
        // a chimney standing from the sand, its roof buried under it
        expect(ridge).toBeLessThan(coast.ground(b.x, b.z));
      } else {
        // a roof's crest 0.4–0.65 m down: under the barnacle crust's pale band and a white cap's reach (they read as
        // floating planks within 0.4 m), near enough to read as a shape through the water
        expect(ridge, `${b.kind} at along ${along(b.z).toFixed(0)}`).toBeLessThan(-0.4);
        expect(ridge).toBeGreaterThan(-0.65);
      }
      expect(layout.above.includes(b)).toBe(top > 0);
    }
    const awash = houses.filter((b) => b.floor + BUILDING_DIMS[b.kind].top > 0);
    expect(awash).toHaveLength(1);
    expect(awash[0].floor + BUILDING_DIMS[awash[0].kind].top).toBeLessThan(0.3);
    const church = layout.buildings.find((b) => b.kind === 'Steeple')!;
    expect(church.floor + BUILDING_DIMS.Steeple.ridge).toBeCloseTo(CHURCH.ridge, 6);
    expect(church.floor + BUILDING_DIMS.Steeple.top).toBeGreaterThan(10);
    expect(LOTS.length + 1).toBe(layout.buildings.length);
  });

  it('shows over the sand that fills its streets: every house has a roof or a chimney above it', () => {
    for (const b of houses) {
      const sand = coast.ground(b.x, b.z);
      const d = BUILDING_DIMS[b.kind];
      expect(b.floor + d.top - sand, `${b.kind} at along ${along(b.z).toFixed(0)}`).toBeGreaterThan(0.4);
      // (and its walls are buried: no house stands clear of the sand as a box on the floor)
      expect(b.floor + d.eave).toBeLessThan(sand);
    }
  });

  it('stands in the eye\'s view ahead through w1 and through the run-in', () => {
    // the window: 18–45 m ahead, within 35° of the eye's front (beats.ts: the coast's front is −z, turned right through
    // the run-in by coastLook)
    const inWindow = (t: number): boolean => {
      const e = coastEye(t, c1End, beach);
      const heading = -coastLook(t, c1End);
      return houses.some((b) => {
        const dx = b.x - e.x;
        const dz = b.z - e.z;
        const d = Math.hypot(dx, dz);
        const bearing = Math.atan2(dx, -dz) - heading;
        return d > 18 && d < 45 && Math.abs(Math.atan2(Math.sin(bearing), Math.cos(bearing))) < (35 * Math.PI) / 180;
      });
    };
    expect(w1.filter(inWindow).length / w1.length).toBeGreaterThan(0.9);
    expect(runIn.filter(inWindow).length / runIn.length).toBeGreaterThan(0.6);
  });

  it('is clear of the raft\'s way and of the swash sim\'s water', () => {
    for (const b of layout.buildings) {
      for (const t of [...w1, ...runIn, ...ashore]) {
        const r = raftAt(t);
        expect(toFootprint(b, r.x, r.z), `${b.kind} at along ${along(b.z).toFixed(0)}, t ${t}`).toBeGreaterThan(RAFT_CLEAR);
      }
      // the footprint's landward edge outside the sim's domain
      expect(off(b.x) - Math.max(...HALF[b.kind])).toBeGreaterThan(SWASH_EDGE);
    }
  });

  it('has its boulevard as one broken line of a few trees — no grid — clear of the raft, the eye and the houses', () => {
    // (the user, 2026-10-30, from the air, on two rows of 70: "the super regular grid")
    const standing = layout.palms.filter((p) => p.state !== 'fallen');
    expect(standing.length).toBeGreaterThanOrEqual(5);
    expect(standing.length).toBeLessThanOrEqual(9);
    // one curb: every foot within a metre of it
    for (const p of layout.palms) expect(Math.abs(off(p.x) - BOULEVARD.off)).toBeLessThan(1);
    // broken: the gaps between neighbours anything but even
    const at = [...new Set(standing.map((p) => Math.round(along(p.z))))].sort((a, b) => a - b);
    const gaps = at.slice(1).map((a, i) => a - at[i]);
    expect(Math.max(...gaps) / Math.min(...gaps)).toBeGreaterThan(2);
    for (const s of ['live', 'snag', 'fallen'] as const) expect(layout.palms.some((p) => p.state === s)).toBe(true);
    expect(layout.palms.some((p) => p.state === 'dead' || p.state === 'dying')).toBe(true);
    for (const p of layout.palms) {
      // along its whole trunk (a fallen one lies across the line)
      const axis = [0, 0.25, 0.5, 0.75, 1].map((s) => trunkAxis(p, s).add(new THREE.Vector3(p.x, p.foot, p.z)));
      for (const t of [...w1, ...runIn]) {
        const r = raftAt(t);
        const e = coastEye(t, c1End, beach);
        for (const q of axis) {
          expect(Math.hypot(q.x - r.x, q.z - r.z)).toBeGreaterThan(RAFT_CLEAR + 3);
          expect(Math.hypot(q.x - e.x, q.z - e.z)).toBeGreaterThan(RAFT_CLEAR + 3);
        }
      }
      for (const b of layout.buildings) for (const q of axis) expect(toFootprint(b, q.x, q.z)).toBeGreaterThan(0.8);
      if (p.state === 'fallen') {
        // from its stump's top, out of the water, down into it
        expect(p.foot).toBeGreaterThan(0);
        expect(axis[4].y).toBeLessThan(0);
      } else {
        expect(p.foot).toBeLessThan(0);
        if (p.state !== 'snag') expect(axis[4].y).toBeGreaterThan(6);
      }
    }
  });
});

describe('the power line at sea', () => {
  const eye = { x: 1200, z: -800 };
  const yaw = 0.7;
  const line = seaPowerLine(eye, yaw);
  /** deg right of the eye's front, and m away */
  const seen = (x: number, z: number): [number, number] => {
    const dx = x - eye.x;
    const dz = z - eye.z;
    const f = [-Math.sin(yaw), -Math.cos(yaw)];
    const r = [Math.cos(yaw), -Math.sin(yaw)];
    return [(Math.atan2(dx * r[0] + dz * r[1], dx * f[0] + dz * f[1]) * 180) / Math.PI, Math.hypot(dx, dz)];
  };

  it('is short: five pylons, one behind, four ahead marching across the front toward c2\'s sunset, spread out', () => {
    expect(line.pylons).toHaveLength(5);
    const views = line.pylons.map((p) => seen(p.x, p.z));
    // (one behind us, on the dome's back; the rest ahead)
    expect(Math.abs(views[0][0])).toBeGreaterThan(90);
    const ahead = views.slice(1);
    for (const [bearing] of ahead) expect(Math.abs(bearing)).toBeLessThan(60);
    expect(ahead[0][1]).toBeGreaterThan(40);
    expect(ahead[0][1]).toBeLessThan(120);
    // not a road to the horizon: the last within ~700 m
    expect(Math.max(...ahead.map((v) => v[1]))).toBeLessThan(700);
    // marching toward the Sun: each further and further left, the last within 3° of the Sun's bearing (beats.ts c2,
    // x right of the front, z back)
    const [sx, , sz] = beatSun('c2', starts.c2, c1End);
    const sunBearing = (Math.atan2(sx, -sz) * 180) / Math.PI;
    for (let i = 1; i < ahead.length; i++) {
      expect(ahead[i][1]).toBeGreaterThan(ahead[i - 1][1]);
      expect(ahead[i][0]).toBeLessThan(ahead[i - 1][0]);
    }
    expect(Math.abs(ahead[ahead.length - 1][0] - sunBearing)).toBeLessThan(3);
    // a row seen across, not stacked end-on in the Sun's glare (the r1 stills): the near three ahead ≥ 2.5° apart
    for (let i = 1; i < ahead.length - 1; i++) expect(ahead[i - 1][0] - ahead[i][0]).toBeGreaterThan(2.5);
    // the row is straight: pylons 1.. within a metre of the line through the angle tower and the last
    const a = line.pylons[1];
    const b = line.pylons[line.pylons.length - 1];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    for (const p of line.pylons.slice(1)) expect(Math.abs(((p.x - a.x) * (b.z - a.z) - (p.z - a.z) * (b.x - a.x)) / L)).toBeLessThan(1);
  });

  it('crosses the eye\'s way ahead with its first span, so the eye passes under it as it sails on', () => {
    // the eye sails along its front (beats.ts: the raft's heading 0 through c2): the first span's track must cut the
    // front axis ahead of it
    const p0 = line.pylons[0];
    const p1 = line.pylons[1];
    const f = [-Math.sin(yaw), -Math.cos(yaw)];
    const r = [Math.cos(yaw), -Math.sin(yaw)];
    const side = (p: { x: number; z: number }): number => (p.x - eye.x) * r[0] + (p.z - eye.z) * r[1];
    const fwd = (p: { x: number; z: number }): number => (p.x - eye.x) * f[0] + (p.z - eye.z) * f[1];
    expect(Math.sign(side(p0))).toBe(-Math.sign(side(p1)));
    const k = side(p0) / (side(p0) - side(p1));
    const crossing = fwd(p0) + (fwd(p1) - fwd(p0)) * k;
    // within c2's ~45 m of way (beats.ts speedAt: 1.2–1.5 m/s for 30 s), not at its very start
    expect(crossing).toBeGreaterThan(10);
    expect(crossing).toBeLessThan(40);
    // and the row beyond the angle tower lies wholly to the other side (its first span, tower 1 to 2, meets the front
    // axis ~150 m ahead: past where the eye gets before the coast, ~100 m by c4's end)
    for (const p of line.pylons.slice(2)) expect(Math.sign(side(p))).toBe(Math.sign(side(line.pylons[2])));
  });

  it('leans its last tower and hangs its far conductors into the sea beyond it, every span between neighbours', () => {
    const last = line.pylons[line.pylons.length - 1];
    expect(Math.abs(last.lean![1])).toBeGreaterThan((5 * Math.PI) / 180);
    for (const p of line.pylons.slice(0, -1)) expect(Math.abs(p.lean![1])).toBeLessThan(0.02);
    expect(line.snapped).toHaveLength(1);
    expect(line.snapped![0].at).toBe(line.pylons.length - 1);
    const [first] = line.pylons;
    // (toward the Sun, past the last: further from the first than the last is)
    const d = (p: [number, number]): number => Math.hypot(p[0] - first.x, p[1] - first.z);
    expect(d(line.snapped![0].toward)).toBeGreaterThan(d([last.x, last.z]));
    for (const s of line.spans) expect(s.to - s.from).toBe(1);
    expect(line.spans).toHaveLength(line.pylons.length - 1);
  });

  it('hangs its lowest wires clear of the raft\'s masthead (~7 m) over the span we sail under', async () => {
    const pb = readFileSync(new URL('../assets/models/course_pylon.glb', import.meta.url));
    const kit = await loadPylonKit(pb.buffer.slice(pb.byteOffset, pb.byteOffset + pb.byteLength) as ArrayBuffer);
    const [A, B] = line.pylons;
    const span = Math.hypot(A.x - B.x, A.z - B.z);
    // the lowest phase at mid-span, as powerLine.ts hangs it (its sag × DEFAULT_SLACK 1.3)
    const low = Math.min(...[0, 1].map((k) => (attachAt(kit, A, k).y + attachAt(kit, B, k).y) / 2)) - kit.cable.sagPerSpan * span * 1.3;
    expect(low).toBeGreaterThan(9.5);
  });
});

describe('the drowned valley\'s power line: tower tops marching across the lagoon onto the high island', () => {
  // (the 2026-11-02 review: the line at sea parked — "Somewhere nearer to land, that would work for me. But we have to
  // see where we position it so that we don't … screw up existing shots that work"; then, on the r1 stills: "that
  // drowned could work. Maybe it spans from the water onto the island, kinda oriented towards the far back,
  // suggesting that this is a flooded valley now"; the coordinator's call on the r4 stills: the tops of towers
  // marching across the lagoon toward the island, sunk deeper toward the valley's middle, rising again to the shore)
  const stub = stubPowerLine(beach);
  const D = 180 / Math.PI;
  /** the kit's silhouette points (its earth-wire tips and peak, each cross-arm's tips; drowned.ts KIT_FOOT under) */
  const KIT_PTS = [[2.2, 25.9], [-2.2, 25.9], [6.8, 19.35], [-6.8, 19.35], [9, 15.35], [-9, 15.35], [7.2, 11.35], [-7.2, 11.35]];
  /** the conductors' attach points (the kit's `extras.attach`: six phases, the two earth wires last) */
  const ATTACH = [[7.2, 11.35], [-7.2, 11.35], [9, 15.35], [-9, 15.35], [6.8, 19.35], [-6.8, 19.35], [2.2, 25.9], [-2.2, 25.9]];
  const ARMS = [11.35, 15.35, 19.35];
  /** each tower's silhouette as the eye sees it, world: the points out of the water, and its axis where it leaves it */
  const outlines = stub.pylons.map((p) => {
    const m = pylonMatrix(p);
    const pts = KIT_PTS.map(([x, y]) => new THREE.Vector3(x, y, 0).applyMatrix4(m)).filter((v) => v.y > 0);
    const a = new THREE.Vector3(0, -14, 0).applyMatrix4(m);
    const b = new THREE.Vector3(0, 26, 0).applyMatrix4(m);
    pts.push(a.clone().lerp(b, Math.max(0, -a.y) / (b.y - a.y)));
    return pts;
  });
  const lamp = (id: string): THREE.Vector3 => new THREE.Vector3(...coast.towers.find((t) => t.id === id)!.lamp);
  const eyeAt = (t: number): { x: number; y: number; z: number; look: number } => {
    const e = coastEye(t, c1End, beach);
    return { x: e.x, z: e.z, y: e.ashore * (coast.ground(e.x, e.z) + e.height) + (1 - e.ashore) * 2.6, look: coastLook(t, c1End) * D };
  };
  /** deg right of the coast's front (world), deg over the eye's level, m away */
  const seen = (e: { x: number; y: number; z: number }, p: THREE.Vector3): { b: number; el: number; d: number } => {
    const d = Math.hypot(p.x - e.x, p.z - e.z);
    return { b: Math.atan2(p.x - e.x, -(p.z - e.z)) * D, el: Math.atan2(p.y - e.y, d) * D, d };
  };
  /** a tower as one box on the sky from an eye: its bearings and its top's elevation */
  const box = (e: { x: number; y: number; z: number }, i: number): { b0: number; b1: number; top: number } => {
    const v = outlines[i].map((p) => seen(e, p));
    return { b0: Math.min(...v.map((q) => q.b)), b1: Math.max(...v.map((q) => q.b)), top: Math.max(...v.map((q) => q.el)) };
  };
  const all = times(starts.w1 + 15, starts.w6 + 60);
  /** deg: the seat's view (Horizon 18 row 8, 136° wide, lens 0.5: drift-seat-view.py, measured off its remap tables)
   * reaches 91° either side of the front at the horizon, ~101° at the masts' lamps (~3° up), 105° at 5° */
  const SEAT = 101;
  const grounds = POWER_STUB.towers.map((t) => t.ground);
  const water = grounds.filter((g) => g < 0).length;
  /** the share of each tower out of the water (its peak over the water / the kit's 39.9 m, × its scale) */
  const shown = stub.pylons.map((p, i) => Math.max(...outlines[i].map((q) => q.y)) / (39.9 * (p.scale ?? 1)));

  it('is out of the cut unless asked for (`?drownedstub`)', () => {
    expect(SUNKEN_SET.stub).toBe(false);
  });

  it('stands on the ground the coast has there: the water towers on the floor, the land towers on the island', () => {
    POWER_STUB.towers.forEach((t, i) => {
      const p = stub.pylons[i];
      expect(Math.abs(coast.heightAt(p.x, p.z) - t.ground), `tower ${i}`).toBeLessThan(0.3);
      // the kit's foot (14 m × its scale under its origin) in the ground, never over it
      const foot = new THREE.Vector3(0, -14, 0).applyMatrix4(pylonMatrix(p));
      expect(foot.y).toBeLessThan(t.ground);
    });
  });

  it('runs out of our shallows, across the lagoon\'s floor and up onto the high island: the drowned ones lean, the ones on land stand', () => {
    // the half-drowned one near us and the tops of a few more in the lagoon; then the shore and one or two up the slope
    expect(water).toBeGreaterThanOrEqual(3);
    expect(grounds.length - water).toBeGreaterThanOrEqual(2);
    expect(grounds.length - water).toBeLessThanOrEqual(3);
    // in order: the water ones first, then each tower on land higher than the last (climbing)
    for (let i = 0; i < water; i++) expect(grounds[i]).toBeLessThan(0);
    for (let i = water + 1; i < grounds.length; i++) expect(grounds[i]).toBeGreaterThan(grounds[i - 1]);
    stub.pylons.forEach((p, i) => {
      if (i < water) {
        // every drowned one leans its own way, settled on the silt
        expect(Math.hypot(...p.lean!) * D, `water tower ${i}`).toBeGreaterThan(3);
        // the lean pivots where it leaves the floor
        const pivot = new THREE.Vector3(0, -(p.footing ?? 0) + (p.sink ?? 0), 0).applyMatrix4(new THREE.Matrix4().makeScale(1 / (p.scale ?? 1), 1 / (p.scale ?? 1), 1 / (p.scale ?? 1))).applyMatrix4(pylonMatrix(p));
        expect(pivot.y).toBeCloseTo(grounds[i], 4);
      } else expect(p.lean, `land tower ${i}`).toEqual([0, 0]);
    });
    // (each its own way: not all to one side)
    expect(new Set(stub.pylons.slice(0, water).map((p) => Math.sign(p.lean![1]))).size).toBeGreaterThan(1);
    // the first drowned to its lowest arm: that arm a few metres over the water
    const arm = (i: number, y: number): number => new THREE.Vector3(0, y, 0).applyMatrix4(pylonMatrix(stub.pylons[i])).y;
    expect(arm(0, ARMS[0])).toBeGreaterThan(1);
    expect(arm(0, ARMS[0])).toBeLessThan(5);
    // the tops in the lagoon: only their upper cross-arms out of the water (the top one always, never the whole
    // tower: under half of it out), the tower sunk deepest toward the valley's middle and rising again to the shore —
    // its least-shown top neither the first nor the last of them
    for (let i = 1; i < water; i++) {
      expect(arm(i, ARMS[2]), `tower ${i}'s top arm`).toBeGreaterThan(2);
      expect(shown[i]).toBeLessThan(0.5);
    }
    const lagoon = shown.slice(1, water);
    const deepest = 1 + lagoon.indexOf(Math.min(...lagoon));
    expect(deepest).toBeGreaterThan(1);
    expect(deepest).toBeLessThan(water - 1);
    expect(shown[water - 1]).toBeGreaterThan(shown[deepest]);
    // receding from the w1 eye: each further than the last
    const e = eyeAt(starts.w1 + 30);
    const d = stub.pylons.map((p) => Math.hypot(p.x - e.x, p.z - e.z));
    for (let i = 1; i < d.length; i++) expect(d[i]).toBeGreaterThan(d[i - 1]);
    // the land ones on the high island (a few km, inside its ground's reach), not on our island or a motu
    for (let i = water; i < d.length; i++) expect(d[i]).toBeGreaterThan(5000);
  });

  it('hangs its wires as a drowned line\'s: strung on land only, every one into the water snapped from an arm still out of it', () => {
    for (const s of stub.spans) expect(Math.min(grounds[s.from], grounds[s.to])).toBeGreaterThanOrEqual(0);
    expect(stub.spans.length).toBe(grounds.length - water - 1);
    // at the shore tower toward the lagoon, and at every tower in the water
    for (let i = 0; i <= water; i++) expect(stub.snapped!.some((s) => s.at === i), `tower ${i}`).toBe(true);
    for (const s of POWER_STUB.snapped) {
      for (const k of s.attach) {
        const y = new THREE.Vector3(ATTACH[k][0], ATTACH[k][1], 0).applyMatrix4(pylonMatrix(stub.pylons[s.at])).y;
        expect(y, `tower ${s.at}, conductor ${k}`).toBeGreaterThan(0.5);
      }
    }
  });

  it('reads from the raft as a row of tops receding to the island\'s foot: none stacked, each further right, once the first has slid past', () => {
    // the near one covers the far tops as w1 begins and slides off them to the left (the line's parallax), clear of
    // them by w1's 45th second (535 s)
    const early = eyeAt(starts.w1 + 25);
    expect(box(early, 0).b1).toBeGreaterThan(box(early, 1).b0);
    for (const t of times(starts.w1 + 45, starts.w2 + 35)) {
      const e = eyeAt(t);
      const boxes = stub.pylons.map((_, i) => box(e, i));
      expect(boxes[0].b1, `the first at ${t}`).toBeLessThan(boxes[1].b0);
      for (let i = 2; i < boxes.length; i++) {
        // each further right than the last, its box apart from the last's by a few tenths of a degree at least
        expect(boxes[i].b0 - boxes[i - 1].b1, `${i - 1}–${i} at ${t}`).toBeGreaterThan(0.3);
      }
      // the tops over the sea's horizon, enough to read from the back rows
      for (let i = 1; i < boxes.length; i++) expect(boxes[i].top).toBeGreaterThan(0.3);
    }
    // and from the beach the same row, in the same order, between the Sun's road and the island
    for (const t of times(starts.w3, starts.w6)) {
      const e = eyeAt(t);
      const boxes = stub.pylons.map((_, i) => box(e, i));
      for (let i = 2; i < boxes.length; i++) expect(boxes[i].b0).toBeGreaterThan(boxes[i - 1].b1);
    }
  });

  it('stands ~100 m off the raft in w1, in the open water between the high island and motu 1, then recedes toward the island', () => {
    const [first] = stub.pylons;
    // clear of the raft's way, past the swash sim
    expect(off(first.x)).toBeGreaterThan(SWASH_EDGE);
    for (const t of [...w1, ...runIn]) {
      const r = raftAt(t);
      expect(Math.hypot(first.x - r.x, first.z - r.z)).toBeGreaterThan(RAFT_CLEAR + 20);
    }
    for (const t of times(starts.w1 + 20, starts.w2)) {
      const r = raftAt(t);
      const dr = Math.hypot(first.x - r.x, first.z - r.z);
      expect(dr).toBeGreaterThan(90);
      expect(dr).toBeLessThan(160);
      const e = eyeAt(t);
      // the first wholly between motu 1's tower and the high island's mast
      const { b0, b1 } = box(e, 0);
      expect(b1).toBeLessThan(seen(e, lamp('treetops')).b - 6);
      expect(b0).toBeGreaterThan(seen(e, lamp('relay-a')).b + 3);
      // on the dome: nothing under the tilted rim (the 0.27 × distance rule)
      for (const o of outlines) for (const p of o) expect(e.y - Math.min(p.y, 0)).toBeLessThan(0.27 * seen(e, p).d);
    }
  });

  it('never stands in front of the high island\'s masts, from any eye of w1–w6', () => {
    // (the station that answers in the radio story): wherever a tower's bearings come within 3° of a mast's, its top is
    // under the mast's foot on the summit
    for (const t of all) {
      const e = eyeAt(t);
      for (let i = 0; i < outlines.length; i++) {
        const { b0, b1, top } = box(e, i);
        for (const id of ['treetops', 'treetops-second']) {
          const l = lamp(id);
          const v = seen(e, l);
          const foot = seen(e, new THREE.Vector3(l.x, coast.heightAt(l.x, l.z), l.z));
          if (v.b > b0 - 3 && v.b < b1 + 3) expect(top, `tower ${i}, ${id} at ${(t - starts.w1).toFixed(1)} s into w1`).toBeLessThan(foot.el);
        }
      }
    }
  });

  it('keeps off the sunset road and the beacons in the seat\'s view', () => {
    const over: Record<string, number> = {};
    for (const t of all) {
      const e = eyeAt(t);
      const beat = beatsAt(t, c1End).at(-1)!.name;
      for (let i = 0; i < outlines.length; i++) {
        const { b0, b1, top } = box(e, i);
        const inView = Math.min(Math.abs(b0 + e.look), Math.abs(b1 + e.look)) < SEAT + 6;
        if (!inView) continue;
        // the low Sun of w3–w5 over the sea and its road on the water: never within 8° of it
        if (beat === 'w3' || beat === 'w4' || beat === 'w5') {
          const [sx, , sz] = beatSun(beat, t, c1End);
          const sun = Math.atan2(sx, -sz) * D;
          expect(sun < b0 - 8 || sun > b1 + 8, `tower ${i} at ${t.toFixed(1)}`).toBe(true);
        }
        // every station's lamp clear of it in the seat's view — but for motu 1's, which the first passes at the very
        // edge of the frame (96–100° round) as the eye turns toward the land in w2 (551–577 s)
        for (const s of coast.towers) {
          const v = seen(e, new THREE.Vector3(...s.lamp));
          const view = v.b + e.look;
          if (v.b > b0 - 1 && v.b < b1 + 1 && v.el < top + 0.5 && Math.abs(view) < SEAT) {
            expect(Math.abs(view), `${s.id} behind tower ${i} at ${t.toFixed(1)}`).toBeGreaterThan(95);
            over[`${i} ${s.id}`] = (over[`${i} ${s.id}`] ?? 0) + 0.5;
          }
        }
      }
    }
    expect(Object.keys(over).every((k) => k === '0 relay-a')).toBe(true);
    for (const s of Object.values(over)) expect(s).toBeLessThanOrEqual(27);
  });
});

describe('a fan palm', () => {
  const spec =(state: FanPalmSpec['state'], lean = 0): FanPalmSpec => ({ x: 0, z: 0, foot: -1.5, height: 18, lean, leanDir: 0, state, seed: 7 });

  it('wears the crown of its state: a living one green over its skirt, a dead one hanging, a snag none', () => {
    const live = crownOf('live', 3);
    const dead = crownOf('dead', 3);
    expect(live.filter((l) => l.live === 1).length).toBeGreaterThan(8);
    expect(live.some((l) => l.kind === 'hanging' && l.rise < -1.2)).toBe(true);
    expect(dead.every((l) => l.live === 0)).toBe(true);
    expect(dead.filter((l) => l.rise < -1.2).length).toBeGreaterThan(dead.length / 2);
    expect(crownOf('snag', 3)).toHaveLength(0);
  });

  it('leans where it is told, a living one curving back toward the light', () => {
    const a = trunkAxis(spec('live', 0.15), 1);
    const d = trunkAxis(spec('dead', 0.15), 1);
    expect(a.x).toBeGreaterThan(0);
    expect(d.x).toBeGreaterThan(a.x);
    expect(Math.abs(trunkAxis(spec('dead', 0), 1).x)).toBeLessThan(0.3);
    // a fallen one lies its whole length, down past level
    const f = trunkAxis(spec('fallen', (98 * Math.PI) / 180), 1);
    expect(f.length()).toBeCloseTo(18, 0);
    expect(f.y).toBeLessThan(0);
  });

  it('builds leaves within their reach, a dead one\'s fan closed', () => {
    for (const kind of Object.keys(LEAF) as Array<keyof typeof LEAF>) {
      const g = leafGeometry(kind);
      g.computeBoundingBox();
      const reach = LEAF[kind].petiole + LEAF[kind].blade * 1.2;
      expect(g.boundingBox!.max.x).toBeLessThan(reach);
      expect(g.getIndex()!.count / 3).toBeLessThan(500);
    }
    const width = (k: keyof typeof LEAF): number => {
      const g = leafGeometry(k);
      g.computeBoundingBox();
      return g.boundingBox!.max.z - g.boundingBox!.min.z;
    };
    expect(width('hanging')).toBeLessThan(width('mature') * 0.6);
  });
});

/** real TSL codegen without a GPU device (the harness of sprayLightingShader.test.ts) */
function shaders(mesh: THREE.Object3D): { vertex: string; fragment: string } {
  const canvas = { width: 4, height: 4, style: {}, getContext: () => null, addEventListener: () => {}, removeEventListener: () => {}, getRootNode: () => ({}), setAttribute: () => {} };
  const renderer = new THREE.WebGPURenderer({ canvas: canvas as unknown as HTMLCanvasElement });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- three's internal codegen harness
  const backend = (renderer as any).backend;
  backend.renderer = renderer;
  // (an instanced mesh sizes its matrix buffer from the device's limits: WebGPU's guaranteed minimum)
  backend.device = { limits: { maxUniformBufferBindingSize: 65536 } };
  const builder = backend.createNodeBuilder(mesh, renderer);
  builder.scene = new THREE.Scene();
  builder.material = (mesh as THREE.Mesh).material;
  builder.camera = new THREE.PerspectiveCamera();
  builder.context.material = builder.material;
  builder.build();
  return { vertex: builder.vertexShader, fragment: builder.fragmentShader };
}

describe('the builders, built', async () => {
  const bytes = readFileSync(new URL('../assets/models/course_roofs.glb', import.meta.url));
  const kit = await loadTownKit(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const site = { sand: coast.ground, origin: [beach.x, beach.z] as [number, number] };
  const town = buildTown(kit, layout.buildings, site);

  it('drops what the sand has buried and keeps its geometry local to the beach', () => {
    const all = layout.buildings.reduce((n, b) => n + kit.variants[b.kind].reduce((m, p) => m + (p.geometry.index?.count ?? p.geometry.getAttribute('position').count) / 3, 0), 0);
    expect(town.triangles).toBeLessThan(all * 0.8);
    town.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const pos = m.geometry.getAttribute('position');
      const sand = m.geometry.getAttribute('drownSand');
      expect(sand).toBeDefined();
      m.geometry.computeBoundingSphere();
      expect(m.geometry.boundingSphere!.center.length()).toBeLessThan(400);
      // (no triangle wholly deeper in the sand than BURIED)
      for (let t = 0; t < pos.count; t += 3) {
        const deep = [0, 1, 2].every((k) => pos.getY(t + k) < sand.getX(t + k) - BURIED - 1e-4);
        expect(deep).toBe(false);
      }
    });
  });

  it('compiles every slot\'s material', () => {
    const meshes: THREE.Mesh[] = [];
    town.group.traverse((o) => void ((o as THREE.Mesh).isMesh && meshes.push(o as THREE.Mesh)));
    expect(meshes.length).toBeGreaterThanOrEqual(3);
    for (const m of meshes) {
      const { vertex, fragment } = shaders(m);
      expect(vertex.length).toBeGreaterThan(100);
      expect(fragment.length).toBeGreaterThan(100);
    }
  });

  it('builds the power line and compiles its pylons and cables', async () => {
    const pb = readFileSync(new URL('../assets/models/course_pylon.glb', import.meta.url));
    const kit = await loadPylonKit(pb.buffer.slice(pb.byteOffset, pb.byteOffset + pb.byteLength) as ArrayBuffer);
    expect(kit.attach).toHaveLength(8);
    const spec = seaPowerLine({ x: 0, z: 0 }, 0);
    // (with the film's cables: the angular floor and the gold sheen, drowned.ts)
    const { group } = buildPowerLine(kit, spec, { origin: [0, 0], cableMinAngle: CABLE_MIN_ANGLE, cableLook: cableGoldSheen });
    const meshes: THREE.Mesh[] = [];
    group.traverse((o) => void ((o as THREE.Mesh).isMesh && meshes.push(o as THREE.Mesh)));
    expect(meshes.some((m) => m.name === 'drowned-cables')).toBe(true);
    for (const m of meshes) {
      const { vertex, fragment } = shaders(m);
      expect(vertex.length).toBeGreaterThan(100);
      expect(fragment.length).toBeGreaterThan(100);
    }
  });

  it('takes the race paint off the kit for a valley\'s line: the hazard band\'s legs drawn as steel, the plate and the chequer boards gone', async () => {
    // (the coordinator, 2026-11-02: "remove the speedboat-course hazard paint band … a valley line wouldn't have it")
    const pb = readFileSync(new URL('../assets/models/course_pylon.glb', import.meta.url));
    const kit = await loadPylonKit(pb.buffer.slice(pb.byteOffset, pb.byteOffset + pb.byteLength) as ArrayBuffer);
    const plain = plainPylonKit(kit);
    expect(plain.parts.some((p) => p.slot === 'C_Paint')).toBe(false);
    expect(plain.parts).toHaveLength(kit.parts.length);
    const paint = kit.parts.find((p) => p.slot === 'C_Paint')!;
    const steel = kit.parts.find((p) => p.slot === 'C_Steel')!;
    const band = plain.parts[kit.parts.indexOf(paint)];
    expect(band.source).toBe(steel.source);
    // what is left is the legs' band, −0.8..2.2 m (pylon.py): no triangle reaching the plate (3 m) or the boards (3.9 m),
    // and the legs still whole through it — every one of the band's triangles kept
    const pos = band.geometry.getAttribute('position');
    const idx = band.geometry.getIndex()!;
    let ys = [Infinity, -Infinity];
    for (let i = 0; i < idx.count; i++) ys = [Math.min(ys[0], pos.getY(idx.getX(i))), Math.max(ys[1], pos.getY(idx.getX(i)))];
    expect(ys[0]).toBeLessThan(-0.7);
    expect(ys[1]).toBeGreaterThan(2.1);
    expect(ys[1]).toBeLessThan(2.5);
    const pIdx = paint.geometry.getIndex()!;
    let legTris = 0;
    for (let t = 0; t < pIdx.count / 3; t++) if ([0, 1, 2].every((c) => paint.geometry.getAttribute('position').getY(pIdx.getX(t * 3 + c)) < 2.4)) legTris++;
    expect(idx.count / 3).toBe(legTris);
    expect(legTris).toBeLessThan(pIdx.count / 3);
    // and wearing the steel's atlas: its coordinates within the range of the steel's own
    const suv = steel.geometry.getAttribute('uv');
    const buv = band.geometry.getAttribute('uv');
    const range = (a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, k: 'getX' | 'getY'): [number, number] => {
      let r: [number, number] = [Infinity, -Infinity];
      for (let i = 0; i < a.count; i++) r = [Math.min(r[0], a[k](i)), Math.max(r[1], a[k](i))];
      return r;
    };
    for (const k of ['getX', 'getY'] as const) {
      const [s0, s1] = range(suv, k);
      const [b0, b1] = range(buv, k);
      expect(b0).toBeGreaterThanOrEqual(s0);
      expect(b1).toBeLessThanOrEqual(s1);
    }
  });

  it('builds the valley\'s line and compiles its towers and its snapped wires, in steel only', async () => {
    const pb = readFileSync(new URL('../assets/models/course_pylon.glb', import.meta.url));
    const kit = await loadPylonKit(pb.buffer.slice(pb.byteOffset, pb.byteOffset + pb.byteLength) as ArrayBuffer);
    const { group } = buildPowerLine(plainPylonKit(kit), stubPowerLine(beach), { origin: [beach.x, beach.z], cableMinAngle: CABLE_MIN_ANGLE, cableLook: cableGoldSheen });
    const meshes: THREE.Mesh[] = [];
    group.traverse((o) => void ((o as THREE.Mesh).isMesh && meshes.push(o as THREE.Mesh)));
    expect(meshes.some((m) => m.name === 'drowned-cables')).toBe(true);
    expect(meshes.some((m) => m.name.includes('C_Paint'))).toBe(false);
    for (const m of meshes) {
      const { vertex, fragment } = shaders(m);
      expect(vertex.length).toBeGreaterThan(100);
      expect(fragment.length).toBeGreaterThan(100);
    }
  });

  it('compiles the palms\' trunks and leaves', () => {
    const light = { sun: new THREE.Vector3(0, 1, 0), sunLight: new THREE.Vector3(1, 1, 1), skyLight: new THREE.Vector3(0.2, 0.3, 0.4) };
    const palms = buildFanPalms(layout.palms, { origin: [beach.x, beach.z], light, castShadow: false });
    const meshes: THREE.Mesh[] = [];
    palms.group.traverse((o) => void ((o as THREE.Mesh).isMesh && meshes.push(o as THREE.Mesh)));
    expect(meshes.some((m) => m.name === 'drowned-palm-trunks')).toBe(true);
    expect(meshes.filter((m) => (m as THREE.InstancedMesh).isInstancedMesh).length).toBeGreaterThan(1);
    // (the film's: none of them in the Sun's map — the "roads" and the blocks round the raft's figure, drowned.ts)
    for (const m of meshes) expect(m.castShadow).toBe(false);
    for (const m of meshes) {
      const { vertex, fragment } = shaders(m);
      expect(vertex.length).toBeGreaterThan(100);
      expect(fragment.length).toBeGreaterThan(100);
    }
  });
});
