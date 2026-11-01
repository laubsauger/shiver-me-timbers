/**
 * Seating the coast's plants on the ground (src/drift/wandering/seat.ts; the user, 2026-11-01: "some plants like the
 * smaller stumpy shrub or tree feel like floating on the sand, as if they are not connected"). WHY these tests:
 *
 *   - the Pachira scrub and the ground shrubs are SPECIMEN SHEETS, four plants side by side in one file. Stood on the
 *     ground at the file's middle and leaned as one, the row's end plants hung up to ~0.8 m over the coppice mounds:
 *     the first test pins that the old placement does float them on our island's real ground (or the fix is moot)
 *     and that seated, every stem point of every plant is under the ground beneath it, yet not buried;
 *   - with the scans on disk (public/drift/pbr, not in git: scripts/drift-pbr-fetch.py), the same for every edge
 *     tree, scrub plant, ground shrub and palm, seated from its own file's stems as forest.ts, groundDebris.ts and
 *     palms.ts do, at the stands' sizes, turns, leans and stretches.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { oursHeight } from '../src/drift/wandering/coast';
import { footprint, seated, specimens } from '../src/drift/wandering/seat';
import { contactMask } from '../src/drift/wandering/forest';
import { LITTER_RES } from '../src/drift/wandering/beachMaterial';

/** our island's ground in world space with the beach at the origin (coast.ts oursAt) */
const ground = (x: number, z: number): number => oursHeight(-z, -x);
/** seeded uniform 0..1 */
const rand = (seed: number): (() => number) => {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
};

/** a stem: a ring of points `r` m round (x, z) at the file's foot */
const ring = (x: number, z: number, r: number): THREE.Vector3[] => Array.from({ length: 12 }, (_, i) => new THREE.Vector3(x + r * Math.cos(i * 0.52), 0, z + r * Math.sin(i * 0.52)));
const geo = (pts: THREE.Vector3[], top: number): THREE.BufferGeometry => new THREE.BufferGeometry().setFromPoints([...pts, new THREE.Vector3(pts[0].x, top, pts[0].z)]);

/** an instance as forest.ts edgeTrees places one: the box's foot at (x, ground, z), turned, leaned, stretched */
function placed(box: THREE.Box3, x: number, z: number, scale: number, wide: number, turn: number, lean: number): THREE.Matrix4 {
  const sx = scale * wide;
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), turn);
  q.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(Math.cos(turn * 3), 0, Math.sin(turn * 3)), lean));
  const foot = new THREE.Vector3(-(box.min.x + box.max.x) / 2 * sx, -box.min.y * scale, -(box.min.z + box.max.z) / 2 * sx).applyQuaternion(q);
  return new THREE.Matrix4().compose(new THREE.Vector3(x, ground(x, z), z).add(foot), q, new THREE.Vector3(sx, scale, sx));
}

/** m: the most any foot point stands over (+) the ground beneath it, and the deepest any is under it */
function gap(foot: THREE.Vector3[], m: THREE.Matrix4): { over: number; deepest: number } {
  let over = -Infinity;
  let deepest = -Infinity;
  for (const p of foot) {
    const w = p.clone().applyMatrix4(m);
    over = Math.max(over, w.y - ground(w.x, w.z));
    deepest = Math.max(deepest, ground(w.x, w.z) - w.y);
  }
  return { over, deepest };
}

/** the scrub's and the trees' ground behind the berm (forest.ts: 17–41 m in from the shore) along the walk */
const spots = (n: number, seed: number): Array<[number, number]> => {
  const r = rand(seed);
  return Array.from({ length: n }, () => [12 + 34 * r(), -220 + 480 * r()]);
};

describe('seating a plant on the ground', () => {
  it('stands a specimen sheet\'s every plant on its own ground, where the row as one floated', () => {
    // the Pachira file's layout: four stems 2 m apart along x, 1.9 m tall
    const stems = [-2, 0, 2, 4].map((x) => ring(x, 0, 0.1));
    const box = new THREE.Box3(new THREE.Vector3(-2.3, 0, -0.6), new THREE.Vector3(4.6, 1.9, 0.4));
    const r = rand(5521);
    let floated = 0;
    for (const [x, z] of spots(400, 7)) {
      const m = placed(box, x, z, (1.8 + 1.6 * r()) / 1.9, 0.9 + 0.6 * r(), r() * 6.28, 0.1 * (2 * r() - 1));
      // the old way: the whole row 0.25 m under the ground at its middle
      const old = m.clone();
      old.elements[13] -= 0.25;
      for (const s of stems) {
        floated = Math.max(floated, gap(s, old).over);
        const seat = seated(footprint([geo(s, 1.5)]), m, ground, 0.05);
        const g = gap(s, seat);
        // every point of the stem's foot under the ground, by the sink at least…
        expect(g.over).toBeLessThanOrEqual(-0.05 + 1e-6);
        // …and none deeper than the sink and the fall of the ground across its own foot ask (the stem ~0.5 m across
        // at the scrub's size, on the mounds' slopes of up to ~1:2: a stem half a metre down would be a stump)
        expect(g.deepest).toBeLessThan(0.05 + 0.25);
      }
    }
    // (the note's floating: the old placement left some end plant well over the sand)
    expect(floated).toBeGreaterThan(0.3);
  });

  // THE CONTACT SHADE (forest.ts contactMask; the user, 2026-11-01: "a slightly darker patch at the footing of these
  // trees would only be natural"): it must read as a soft darkening, never a ring or a stamp, and follow the plant
  it('shades each foot softly, wider and stronger under a taller plant, stretched along the slope', () => {
    // (the coast's own mask: 520 m over LITTER_RES texels, half a metre each — sea.ts)
    const size = 520;
    const cell = size / LITTER_RES;
    const at = (m: Uint8Array, x: number, z: number): number => m[Math.floor(z / cell) * LITTER_RES + Math.floor(x / cell)] / 255;
    const flat = (): number => 0;
    const shrub = contactMask(flat, [[20, 20, 0.2, 2.6]], [0, 0], size);
    const tree = contactMask(flat, [[40, 40, 2, 12]], [0, 0], size);
    // subtle: little over half the sky hidden at the middle at most, and some at all
    expect(at(shrub, 20, 20)).toBeGreaterThan(0.15);
    expect(at(tree, 40, 40)).toBeLessThanOrEqual(0.56);
    expect(at(tree, 40, 40)).toBeGreaterThan(at(shrub, 20, 20));
    // soft: falling off monotonically from the foot, never rising again (no ring), gone by a few radii
    for (const [m, c, far] of [[shrub, 20, 2], [tree, 40, 8]] as const) {
      let was = Infinity;
      for (let d = 0; d < far; d += cell) {
        const v = at(m, c + d, c);
        expect(v).toBeLessThanOrEqual(was + 1 / 255);
        was = v;
      }
      expect(at(m, c + far, c)).toBeLessThan(0.02);
    }
    // the tree's patch is wider than the shrub's
    expect(at(tree, 41.5, 40)).toBeGreaterThan(at(shrub, 21.5, 20));
    // on a slope rising along x, longer along x than across it
    const slope = contactMask((x) => 0.3 * x, [[20, 20, 0.5, 8]], [0, 0], size);
    expect(at(slope, 21.5, 20)).toBeGreaterThan(at(slope, 20, 21.5) + 0.02);
    // a tuft narrower than the texels: drawn wider and fainter, not lost or a full-strength stamp
    const tuft = contactMask(flat, [[30.1, 30.3, 0.05, 0.2]], [0, 0], size);
    expect(at(tuft, 30.1, 30.3)).toBeGreaterThan(0.01);
    expect(at(tuft, 30.1, 30.3)).toBeLessThan(0.2);
    // a shrub's patch at least its litter and root zone (~1.3 m across): its core not lost between the texels
    expect(at(shrub, 20.6, 20)).toBeGreaterThan(0.15);
  });

  it('groups a sheet\'s meshes by their trailing letter, and a single scan as one plant', () => {
    expect(specimens(['pachira_aquatica_01_bark_a', 'pachira_aquatica_01_leaves_a', 'pachira_aquatica_01_bark_d'])).toEqual(['a', 'a', 'd']);
    expect(specimens(['island_trees_01_blockout_cleaned_0', 'mesh001_2', 'shrub_02_b'])).toEqual(['', '', 'b']);
  });

  // THE SCANS THEMSELVES, where they are on disk
  const PBR = path.resolve(__dirname, '../public/drift/pbr');
  const files: Array<{ file: string; scale: [number, number]; wide: [number, number]; lean: number; sink: number; byLeaves: boolean }> = [
    // forest.ts EDGE_TREES and EDGE_SHRUB (heights over the file's), TREE_WIDE, LEAN, SEAT_SINK
    ...['island_tree_01', 'island_tree_02', 'island_tree_03', 'tree_small_02'].map((id) => ({ file: `${id}/${id}_lod.glb`, scale: [1.6, 4] as [number, number], wide: [0.9, 1.5] as [number, number], lean: 0.1, sink: 0.12, byLeaves: true })),
    { file: 'pachira_aquatica_01/pachira_aquatica_01_lod.glb', scale: [0.95, 1.8], wide: [0.9, 1.5], lean: 0.1, sink: 0.05, byLeaves: true },
    // groundDebris.ts 'shrub' and 'tuft' (their scale ranges; turned to the slope there, upright here: the stricter)
    { file: 'shrub_02/shrub_02_lod.glb', scale: [0.45, 0.85], wide: [1, 1], lean: 0, sink: 0.05 * 1.7 * 0.45, byLeaves: false },
    { file: 'shrub_03/shrub_03_lod.glb', scale: [1.2, 2.5], wide: [1, 1], lean: 0, sink: 0.05 * 0.4 * 1.2, byLeaves: false },
  ];
  for (const f of files) {
    const at = path.join(PBR, f.file);
    it.skipIf(!fs.existsSync(at))(`seats every plant of ${path.basename(f.file)} under the ground beneath its stems`, () => {
      const parts = readGlb(at);
      const box = new THREE.Box3();
      for (const p of parts) box.expandByObject(new THREE.Mesh(p.geo));
      const groupOf = specimens(parts.map((p) => p.name));
      const r = rand(91);
      for (const sp of new Set(groupOf)) {
        const mine = parts.filter((_, i) => groupOf[i] === sp);
        const stems = f.byLeaves ? mine.filter((p) => !/leaves/.test(p.material)) : mine;
        const foot = footprint(stems.map((p) => p.geo));
        expect(foot.length).toBeGreaterThan(3);
        for (const [x, z] of spots(150, 3)) {
          const m = placed(box, x, z, f.scale[0] + (f.scale[1] - f.scale[0]) * r(), f.wide[0] + (f.wide[1] - f.wide[0]) * r(), r() * 6.28, f.lean * (2 * r() - 1));
          expect(gap(foot, seated(foot, m, ground, f.sink)).over).toBeLessThanOrEqual(-f.sink + 1e-6);
        }
      }
    });
  }
});

/** a .glb's meshes (each primitive's positions in the file's space), its node and material names: enough to seat */
function readGlb(file: string): Array<{ name: string; material: string; geo: THREE.BufferGeometry }> {
  const b = fs.readFileSync(file);
  const jl = b.readUInt32LE(12);
  const json = JSON.parse(b.subarray(20, 20 + jl).toString());
  const bin = b.subarray(28 + jl);
  const out: Array<{ name: string; material: string; geo: THREE.BufferGeometry }> = [];
  const walk = (i: number, parent: THREE.Matrix4): void => {
    const n = json.nodes[i];
    const local = n.matrix ? new THREE.Matrix4().fromArray(n.matrix) : new THREE.Matrix4().compose(new THREE.Vector3(...(n.translation ?? [0, 0, 0])), new THREE.Quaternion(...(n.rotation ?? [0, 0, 0, 1])), new THREE.Vector3(...(n.scale ?? [1, 1, 1])));
    const world = parent.clone().multiply(local);
    if (n.mesh !== undefined) {
      json.meshes[n.mesh].primitives.forEach((p: { attributes: { POSITION: number }; material?: number }, k: number) => {
        const acc = json.accessors[p.attributes.POSITION];
        const view = json.bufferViews[acc.bufferView];
        const stride = view.byteStride ?? 12;
        const off = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
        const pos = new Float32Array(acc.count * 3);
        for (let v = 0; v < acc.count; v++) for (let c = 0; c < 3; c++) pos[v * 3 + c] = bin.readFloatLE(off + v * stride + c * 4);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.applyMatrix4(world);
        const multi = json.meshes[n.mesh].primitives.length > 1;
        out.push({ name: multi ? `${n.name}_${k}` : n.name, material: json.materials?.[p.material ?? -1]?.name ?? '', geo });
      });
    }
    for (const c of n.children ?? []) walk(c, world);
  };
  for (const r of json.scenes[json.scene ?? 0].nodes) walk(r, new THREE.Matrix4());
  return out;
}
