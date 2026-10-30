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
 *   - the power line at sea is a straight row running off toward c2's sunset, its nearest pylon a few hundred metres
 *     off, one pylon fallen with its neighbours' conductors hanging toward where it stood;
 *   - the kit builds with the buried parts dropped, and every material compiles (real TSL codegen, no GPU).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { float, vec3 } from 'three/tsl';
import { createFilmCoast } from '../src/drift/wandering/coast';
import { BOULEVARD, CHURCH, LOTS, POWER_LINE, RAFT_CLEAR, SWASH_EDGE, drownedLayout, seaPowerLine } from '../src/drift/wandering/drowned';
import { beatStarts, coastEye, coastLook, landfall, raftPose } from '../src/drift/wandering/beats';
import { BUILDING_DIMS, BURIED, buildTown, buildingMatrix, loadTownKit, type BuildingSpec } from '../src/drowned/town';
import { LEAF, buildFanPalms, crownOf, leafGeometry, trunkAxis, type FanPalmSpec } from '../src/drowned/fanPalm';
import { buildPowerLine, loadPylonKit } from '../src/drowned/powerLine';
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

  it('marches off in a straight row toward c2\'s sunset, its nearest pylon a few hundred metres off', () => {
    expect(line.pylons).toHaveLength(POWER_LINE.count - 1);
    const views = line.pylons.map((p) => seen(p.x, p.z));
    expect(Math.min(...views.map((v) => v[1]))).toBeGreaterThan(300);
    // (its far end within 10° of the setting Sun's bearing: beats.ts c2, x right of the front, z back)
    const [sx, , sz] = beatSun('c2', starts.c2, c1End);
    const sunBearing = (Math.atan2(sx, -sz) * 180) / Math.PI;
    expect(Math.abs(views[views.length - 1][0] - sunBearing)).toBeLessThan(10);
    // straight: every pylon within a few metres of the line through the first and last
    const a = line.pylons[0];
    const b = line.pylons[line.pylons.length - 1];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    for (const p of line.pylons) expect(Math.abs(((p.x - a.x) * (b.z - a.z) - (p.z - a.z) * (b.x - a.x)) / L)).toBeLessThan(1);
  });

  it('has its fallen pylon\'s neighbours\' conductors hanging toward where it stood, no span across the gap', () => {
    expect(line.snapped).toHaveLength(2);
    const [s0, s1] = line.snapped!;
    expect(s0.toward).toEqual(s1.toward);
    for (const s of line.spans) expect(Math.abs(s.to - s.from)).toBe(1);
    expect(line.spans.some((s) => s.from === s0.at && s.to === s1.at)).toBe(false);
  });
});

describe('a fan palm', () => {
  const spec = (state: FanPalmSpec['state'], lean = 0): FanPalmSpec => ({ x: 0, z: 0, foot: -1.5, height: 18, lean, leanDir: 0, state, seed: 7 });

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
    const { group } = buildPowerLine(kit, spec, { origin: [0, 0] });
    const meshes: THREE.Mesh[] = [];
    group.traverse((o) => void ((o as THREE.Mesh).isMesh && meshes.push(o as THREE.Mesh)));
    expect(meshes.some((m) => m.name === 'drowned-cables')).toBe(true);
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
