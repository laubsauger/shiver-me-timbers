/**
 * The beach dressing's placement (src/drift/wandering/beachDressing.ts) on a plain beach: a 1:11 face rising inland
 * from the waterline, the eye's walk over it (beats.ts). What it must keep true, whatever the densities are tuned to:
 * the waves' swash stays almost bare, the swash's upper limit and the wrack line are where things gather, the walked
 * line and the wanderers' path stay clear, nothing is placed where the eye could only ever see it as a speck (the
 * 2026-10-29 review: "I'd much rather have stuff disappear than look like that"), the bleached sticks stay rare ("the
 * little bones … too much"), and the same beach comes out every run (every frame a function of t).
 */
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { COVERAGE, WRACK, eyePath, placeBeachDressing, poseOf, restPiece, wrackAt, type DressingPlace, type RestPiece } from '../src/drift/wandering/beachDressing';
import { oursHeight } from '../src/drift/wandering/coast';

const beach = { x: 0, z: 0 };
/** m over the sea: 1:11 up from the waterline (x = 0) inland (+x), under water out to sea */
const ground = (x: number): number => x / 11;
const site = { ground: (x: number) => ground(x), beach, inland: (x: number) => x, palms: [] as Array<[number, number]> };
const placed = placeBeachDressing(site);
const all = Object.values(placed).flat();
/** things a m² between two heights (m over the sea), along the stretch the eye sees closest (along −20..40) */
const density = (list: DressingPlace[], h0: number, h1: number): number => {
  const n = list.filter((p) => ground(p.x) >= h0 && ground(p.x) < h1 && -p.z > -20 && -p.z < 40).length;
  return n / ((h1 - h0) * 11 * 60);
};

describe('beach dressing placement', () => {
  it('is the same beach every run', () => {
    const again = placeBeachDressing(site);
    for (const k of Object.keys(placed) as Array<keyof typeof placed>) {
      expect(again[k].length).toBe(placed[k].length);
      expect(again[k].map((p) => [p.x, p.z, p.s])).toEqual(placed[k].map((p) => [p.x, p.z, p.s]));
    }
  });

  it('dresses the beach at all, near the walk', () => {
    expect(placed.pebble.length).toBeGreaterThan(300);
    expect(placed.shell.length).toBeGreaterThan(150);
  });

  it('leaves the swash almost bare: the waves rework it', () => {
    const swash = all.filter((p) => ground(p.x) < 0.4).length;
    expect(swash / all.length).toBeLessThan(0.02);
    expect(all.every((p) => ground(p.x) > 0)).toBe(true);
  });

  it('gathers pebbles and shells at the swash limit, more than on the open sand', () => {
    const small = [...placed.pebble, ...placed.shell];
    expect(density(small, 0.55, 0.7)).toBeGreaterThan(3 * density(small, 0.72, 0.88));
  });

  it('lays the dried leaves and twigs on the wrack line, the one the ground decal paints', () => {
    const wrack = [...placed.leaf, ...placed.twig];
    const near = wrack.filter((p) => Math.abs(ground(p.x) - WRACK.height) < 2 * WRACK.wander + 2 * WRACK.half).length;
    expect(near / wrack.length).toBeGreaterThan(0.8);
    // (and where they lie, the decal's own band and clumps are there too: the same function)
    const mean = wrack.reduce((s, p) => s + wrackAt(p.x, p.z, ground(p.x), 1.5), 0) / wrack.length;
    expect(mean).toBeGreaterThan(0.3);
  });

  it('places nothing the eye could only see as a speck: every piece spans COVERAGE.gone from somewhere on its path', () => {
    const path = eyePath(beach, (x) => ground(x));
    for (const p of all) {
      const y = ground(p.x);
      const d = Math.min(...path.map(([x, py, z]) => Math.hypot(x - p.x, py - y, z - p.z)));
      expect(p.s / d).toBeGreaterThanOrEqual(COVERAGE.gone);
    }
  });

  it('keeps the bleached sticks rare', () => {
    expect(placed.stick.length).toBeLessThan(0.05 * (placed.pebble.length + placed.shell.length));
  });

  it('keeps the held eye’s spot and the wanderers’ path clear', () => {
    // w4's hold (beats.ts COAST_KEYS: along 12, off −8): nothing within half a metre under the eye
    expect(all.every((p) => Math.hypot(p.x - 8, p.z + 12) >= 0.5)).toBe(true);
    // props.ts walkers (off −5.3 ± 1 from along ~4 on): nothing big enough to trip over
    const onPath = all.filter((p) => -p.z > 3 && p.x > 4 && p.x < 6.6 && p.s > 0.06);
    expect(onPath).toEqual([]);
  });
});

/**
 * LYING AS GRAVITY LEAVES THEM (the user, 2026-11-02, at the sunset walk: "a bunch of weirdly positioned rocks, stones
 * and pebbles on the beach, sticking up in a weird way, not really lying there as one would expect with gravity" — the
 * pebbles were tumbled over every turn and squashed into slabs before it, so most stood on an edge, and were seated by
 * their lowest point at their middle, so a leaning one's low side hung over the slope). On our island's real ground
 * (coast.ts: the swash's face, the berm, the mounds), every piece must lie on its flattest face, its up within ~10° of
 * the ground's normal; its underside must be in the sand (no gap under it to see the sand through); and it must still
 * show (not buried).
 */
describe('beach dressing at rest on the ground', () => {
  /** our island's ground in world space with the beach at the origin (coast.ts oursAt) */
  const real = (x: number, z: number): number => oursHeight(-z, -x);
  const realPlaced = placeBeachDressing({ ground: real, beach, inland: (x: number) => x, palms: [] });
  const normalAt = (x: number, z: number): THREE.Vector3 => new THREE.Vector3(real(x - 0.3, z) - real(x + 0.3, z), 0.6, real(x, z - 0.3) - real(x, z + 0.3)).normalize();
  /** unit directions over the sphere (Fibonacci), to find a piece's thinnest extent whatever its shape */
  const dirs = Array.from({ length: 300 }, (_, i) => {
    const y = 1 - (2 * (i + 0.5)) / 300;
    const r = Math.sqrt(1 - y * y);
    const a = i * Math.PI * (3 - Math.sqrt(5));
    return new THREE.Vector3(r * Math.cos(a), y, r * Math.sin(a));
  });
  const extentAlong = (pts: THREE.Vector3[], d: THREE.Vector3): number => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of pts) {
      const t = p.dot(d);
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
    }
    return hi - lo;
  };

  /** every place laid with `pieces` (chosen as createBeachDressing chooses), held to the rest and the seat */
  function holds(pieces: RestPiece[], places: DressingPlace[]): void {
    expect(places.length).toBeGreaterThan(0);
    places.forEach((pl, i) => {
      const pc = pieces[Math.floor(pl.piece * pieces.length)];
      const { m, height } = poseOf(pl, pc, real);
      const n = normalAt(pl.x, pl.z);
      // its up (turned over or not) within 10° of the ground's normal
      const up = new THREE.Vector3().setFromMatrixColumn(m, 1).normalize();
      expect(Math.abs(up.dot(n))).toBeGreaterThan(Math.cos((10 * Math.PI) / 180));
      const w = pc.verts.map((v) => v.clone().applyMatrix4(m));
      // on its flattest face: as thin along the normal as its thinnest way, but for what a lean of up to 10° adds
      // (its length × sin 10°: a slab on an edge or an end, the frames' fins, stands its width or length up) — every
      // 4th, the search over directions being slow
      if (i % 4 === 0) {
        const ext = dirs.map((d) => extentAlong(w, d));
        expect(extentAlong(w, n)).toBeLessThanOrEqual(Math.min(...ext) + Math.sin((10 * Math.PI) / 180) * Math.max(...ext));
      }
      // its underside in the sand: every point of its lowest tenth (along the normal) at or under the ground there
      const along = w.map((p) => p.dot(n));
      const low = Math.min(...along);
      const thick = Math.max(...along) - low;
      for (let k = 0; k < w.length; k++) if (along[k] <= low + 0.1 * thick) expect(w[k].y - real(w[k].x, w[k].z)).toBeLessThanOrEqual(1e-4);
      // …and it shows: its top stands over the ground by more than ~0.4 of its height (the deepest sink is 0.45)
      const top = w.reduce((a, b) => (b.y - real(b.x, b.z) > a.y - real(a.x, a.z) ? b : a));
      expect(top.y - real(top.x, top.z)).toBeGreaterThan(0.4 * height);
    });
  }

  /** a cloud of points on an ellipsoid's surface, semi-axes `ax`, turned by `q` (a scan in its file's own frame) */
  const ellipsoid = (ax: [number, number, number], q: THREE.Quaternion): THREE.BufferGeometry => {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 240; i++) {
      const d = dirs[i % dirs.length];
      pts.push(new THREE.Vector3(d.x * ax[0], d.y * ax[1], d.z * ax[2]).applyQuaternion(q));
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
  };

  it('lays a slab flat however its file turns it, and seats it on the slope', () => {
    // a slab 1 × 0.25 × 0.6, its thinnest axis along the file's z, turned off every axis
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.7, 1.9, 0.4));
    const slab = restPiece(ellipsoid([0.5, 0.6 * 0.5, 0.125], q));
    holds([slab], [...realPlaced.pebble, ...realPlaced.cobble]);
  });

  it('lays a shell cup-down (its rim on the sand, its cup over it) where its file has it cup-up', () => {
    // a scallop's cup: a spherical cap, its apex at the bottom in the file (cup-up), its axis tilted
    const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0, -0.5));
    const pts: THREE.Vector3[] = [new THREE.Vector3(0, -1, 0)];
    for (let ring = 1; ring <= 6; ring++) for (let k = 0; k < 24; k++) {
      const th = (ring / 6) * (Math.PI / 3);
      const a = (k / 24) * 2 * Math.PI;
      pts.push(new THREE.Vector3(Math.sin(th) * Math.cos(a), -Math.cos(th), Math.sin(th) * Math.sin(a)));
    }
    const cup = restPiece(new THREE.BufferGeometry().setFromPoints(pts.map((p) => p.applyQuaternion(tilt))));
    const pos = cup.geo.getAttribute('position');
    const apex = pos.getY(0);
    let rim = 0;
    for (let k = pos.count - 24; k < pos.count; k++) rim += pos.getY(k) / 24;
    expect(apex).toBeGreaterThan(rim + 0.3);
    holds([cup], realPlaced.shell);
  });

  // the scans themselves (public/drift/pbr, not in git: scripts/drift-pbr-fetch.py), as createBeachDressing lays them
  const PBR = path.resolve(__dirname, '../public/drift/pbr');
  const FILES: Array<[keyof typeof realPlaced, string]> = [
    ['pebble', 'namaqualand_boulder_05/namaqualand_boulder_05_pebble.glb'],
    ['cobble', 'namaqualand_boulder_05/namaqualand_boulder_05_beach.glb'],
    ['shell', 'ShellSet001/shellset_beach.glb'],
    ['conch', 'lambis_shell/lambis_shell_beach.glb'],
    ['stick', 'dead_quiver_branch_01/dead_quiver_branch_01_beach.glb'],
    ['leaf', 'dry_quiver_leaf/dry_quiver_leaf_beach.glb'],
    ['twig', 'dry_branches_medium_01/dry_branches_medium_01_beach.glb'],
  ];
  for (const [kind, file] of FILES) {
    const at = path.join(PBR, file);
    it.skipIf(!fs.existsSync(at))(`lays every ${kind} (${path.basename(file)}) at rest on the ground and in the sand`, () => {
      holds(readGlb(at).map((g) => restPiece(g)), realPlaced[kind]);
    });
  }
});

/** a .glb's meshes, each primitive's positions in the file's space (as tests/driftPlantSeat.test.ts reads them) */
function readGlb(file: string): THREE.BufferGeometry[] {
  const b = fs.readFileSync(file);
  const jl = b.readUInt32LE(12);
  const json = JSON.parse(b.subarray(20, 20 + jl).toString());
  const bin = b.subarray(28 + jl);
  const out: THREE.BufferGeometry[] = [];
  const walk = (i: number, parent: THREE.Matrix4): void => {
    const n = json.nodes[i];
    const local = n.matrix ? new THREE.Matrix4().fromArray(n.matrix) : new THREE.Matrix4().compose(new THREE.Vector3(...(n.translation ?? [0, 0, 0])), new THREE.Quaternion(...(n.rotation ?? [0, 0, 0, 1])), new THREE.Vector3(...(n.scale ?? [1, 1, 1])));
    const world = parent.clone().multiply(local);
    if (n.mesh !== undefined) {
      for (const p of json.meshes[n.mesh].primitives as Array<{ attributes: { POSITION: number } }>) {
        const acc = json.accessors[p.attributes.POSITION];
        const view = json.bufferViews[acc.bufferView];
        const stride = view.byteStride ?? 12;
        const off = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
        const pos = new Float32Array(acc.count * 3);
        for (let v = 0; v < acc.count; v++) for (let c = 0; c < 3; c++) pos[v * 3 + c] = bin.readFloatLE(off + v * stride + c * 4);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        out.push(geo.applyMatrix4(world));
      }
    }
    for (const c of n.children ?? []) walk(c, world);
  };
  for (const r of json.scenes[json.scene ?? 0].nodes) walk(r, new THREE.Matrix4());
  return out;
}
