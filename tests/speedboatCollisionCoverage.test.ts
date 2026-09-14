/**
 * §T.198 EVERY OBSTACLE YOU CAN SEE ON TOWER REACH IS SOLID WHERE A HULL CAN TOUCH IT.
 *
 * WHY (§Rule 6): user playtest 2026-09-13 — "collision with rocks, buildings, any kind of obstacle is not a thing right
 * now". The live page had 0 rock colliders: the kit islands' granite is `circuit/kitDecor.ts` instances (rockCount 0),
 * and the placement-based `rockColliders` never saw them. Unit tests of `boatCollide` could not catch that, because the
 * gap was between WHAT IS DRAWN and WHAT THE PHYSICS WAS HANDED. So this test starts from the drawn things:
 *
 *  - island props: the kit decor InstancedMeshes built by the SAME `createKitDecor` call the page's kit hook makes
 *    (same seed, heightmap, render info, surface mask; only the material is a stand-in), placed under an island group at
 *    the site centre as island.ts does, handed to the page's own `towerReachCourse().attach` — so the list tested is
 *    the list the player and the workers get. Per instance, with three's own matrix math (independent of the fit's),
 *    above the seabed: ≥ 99% of its vertices and ≥ 90% of its drawn surface (area-weighted triangle samples) must be
 *    inside the colliders. Its bounding box's coverage is reported too (a log is a cylinder: 79% of its box at best).
 *  - course furniture: each placement's LOD0 GLB vertices, placed with the matrices courseFurniture.ts draws them with,
 *    in the band a hull can touch (−0.6 … +6 m): ≥ 90% inside `courseColliders` (a roof ridge, a pylon leg, the mast).
 * A fit that forgot the instance rotation, a yaw sign flip, a collider list the page stopped passing on, or a new prop
 * class with no collider all fail here.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three/webgpu';
import { courseColliders } from '../src/circuit/courseColliders';
import { PROP_CLEAR_DEPTH, PROP_MIN_PROUD, PROP_REACH_ABOVE, propMeshKind } from '../src/circuit/propColliders';
import type { TowerReachWorld } from '../src/circuit/towerReach';
import type { StaticCollider } from '../src/sea-physics/boatCollide';
import type { CourseWorld } from '../src/speedboat/page/course';
import { createIO } from '../scripts/blender/checkGlb.mjs';
import { collisionWorld } from './speedboatCollisionWorld';

const ROOT = new URL('..', import.meta.url).pathname;

/** distance from p to a capsule's surface (< 0 inside) */
function capsuleDistance(c: StaticCollider, x: number, y: number, z: number): number {
  const ux = c.b[0] - c.a[0];
  const uy = c.b[1] - c.a[1];
  const uz = c.b[2] - c.a[2];
  const l2 = ux * ux + uy * uy + uz * uz;
  const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((x - c.a[0]) * ux + (y - c.a[1]) * uy + (z - c.a[2]) * uz) / l2)) : 0;
  return Math.hypot(x - c.a[0] - ux * t, y - c.a[1] - uy * t, z - c.a[2] - uz * t) - c.radius;
}

/** a uniform grid over collider bounds (the test queries ~10⁶ points against ~4000 capsules) */
function colliderGrid(cols: readonly StaticCollider[], cell = 8) {
  const map = new Map<string, number[]>();
  cols.forEach((c, i) => {
    const r = c.radius;
    const x0 = Math.floor((Math.min(c.a[0], c.b[0]) - r) / cell);
    const x1 = Math.floor((Math.max(c.a[0], c.b[0]) + r) / cell);
    const z0 = Math.floor((Math.min(c.a[2], c.b[2]) - r) / cell);
    const z1 = Math.floor((Math.max(c.a[2], c.b[2]) + r) / cell);
    for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) map.set(`${gx},${gz}`, [...(map.get(`${gx},${gz}`) ?? []), i]);
  });
  return (x: number, y: number, z: number, tol = 0.02): boolean => {
    for (const i of map.get(`${Math.floor(x / cell)},${Math.floor(z / cell)}`) ?? []) if (capsuleDistance(cols[i], x, y, z) <= tol) return true;
    return false;
  };
}

let world: TowerReachWorld;
let page: CourseWorld;
let islandGroups: THREE.Group[];
let bed: (x: number, z: number) => number;

beforeAll(() => {
  ({ world, page, islandGroups } = collisionWorld());
  bed = page.bed;
}, 300_000);

describe('§T.198 collider coverage of what Tower Reach draws', () => {
  it('island props: every solid instance a hull can reach is enclosed by the colliders the page hands out', () => {
    const inside = colliderGrid(page.colliders);
    const M = new THREE.Matrix4();
    const v = new THREE.Vector3();
    let obstacles = 0;
    let worstVertex = 1;
    let worstBox = 1;
    let sumBox = 0;
    let worstSurface = 1;
    let sumSurface = 0;
    const va = new THREE.Vector3();
    const vb = new THREE.Vector3();
    const vc = new THREE.Vector3();
    const perClass: Record<string, { obstacles: number; minBox: number; minSurface: number }> = {};
    const failures: string[] = [];
    for (const g of islandGroups) {
      g.updateMatrixWorld(true);
      g.traverse((o) => {
        const mesh = o as THREE.InstancedMesh;
        if (!mesh.isInstancedMesh) return;
        expect(propMeshKind(mesh.name), `island mesh ${mesh.name} is classified`).not.toBe('unknown');
        if (propMeshKind(mesh.name) !== 'solid') return;
        const pos = mesh.geometry.getAttribute('position');
        mesh.geometry.computeBoundingBox();
        const bb = mesh.geometry.boundingBox!;
        for (let k = 0; k < mesh.count; k++) {
          mesh.getMatrixAt(k, M);
          M.premultiply(mesh.matrixWorld);
          // the obstacle rule, from the drawn vertices: above the seabed, top above a hull's draft, not up on land, proud
          let top = -Infinity;
          let proud = -Infinity;
          let minBed = Infinity;
          let n = 0;
          let inV = 0;
          for (let i = 0; i < pos.count; i++) {
            v.fromBufferAttribute(pos, i).applyMatrix4(M);
            const b = bed(v.x, v.z);
            if (v.y < b - 0.25) continue;
            n++;
            top = Math.max(top, v.y);
            proud = Math.max(proud, v.y - b);
            minBed = Math.min(minBed, b);
            if (inside(v.x, v.y, v.z)) inV++;
          }
          if (n < 4 || top < PROP_CLEAR_DEPTH || minBed > PROP_REACH_ABOVE || proud < PROP_MIN_PROUD) continue;
          obstacles++;
          // visual bounds: the instance's bounding box, sampled 6³, above the seabed
          let nb = 0;
          let inB = 0;
          for (let a = 0; a < 6; a++) {
            for (let b = 0; b < 6; b++) {
              for (let c = 0; c < 6; c++) {
                v.set(bb.min.x + ((a + 0.5) / 6) * (bb.max.x - bb.min.x), bb.min.y + ((b + 0.5) / 6) * (bb.max.y - bb.min.y), bb.min.z + ((c + 0.5) / 6) * (bb.max.z - bb.min.z)).applyMatrix4(M);
                if (v.y < bed(v.x, v.z)) continue;
                nb++;
                if (inside(v.x, v.y, v.z)) inB++;
              }
            }
          }
          // the drawn surface: 4 samples per triangle, area-weighted, above the seabed
          const index = mesh.geometry.getIndex();
          const tris = index ? index.count / 3 : pos.count / 3;
          let area = 0;
          let areaIn = 0;
          for (let tr = 0; tr < tris; tr++) {
            const ia = index ? index.getX(tr * 3) : tr * 3;
            const ib = index ? index.getX(tr * 3 + 1) : tr * 3 + 1;
            const ic = index ? index.getX(tr * 3 + 2) : tr * 3 + 2;
            va.fromBufferAttribute(pos, ia).applyMatrix4(M);
            vb.fromBufferAttribute(pos, ib).applyMatrix4(M);
            vc.fromBufferAttribute(pos, ic).applyMatrix4(M);
            const A = new THREE.Vector3().subVectors(vb, va).cross(new THREE.Vector3().subVectors(vc, va)).length() / 8;
            for (const [wa, wb, wc] of [[1 / 3, 1 / 3, 1 / 3], [2 / 3, 1 / 6, 1 / 6], [1 / 6, 2 / 3, 1 / 6], [1 / 6, 1 / 6, 2 / 3]]) {
              const x = va.x * wa + vb.x * wb + vc.x * wc;
              const y = va.y * wa + vb.y * wb + vc.y * wc;
              const z = va.z * wa + vb.z * wb + vc.z * wc;
              if (y < bed(x, z)) continue;
              area += A;
              if (inside(x, y, z)) areaIn += A;
            }
          }
          const fv = inV / n;
          const fb = nb > 0 ? inB / nb : 1;
          const fs = area > 0 ? areaIn / area : 1;
          worstSurface = Math.min(worstSurface, fs);
          sumSurface += fs;
          worstVertex = Math.min(worstVertex, fv);
          worstBox = Math.min(worstBox, fb);
          sumBox += fb;
          const cls = mesh.name.replace(/\d+$/, '');
          const pc = (perClass[cls] ??= { obstacles: 0, minBox: 1, minSurface: 1 });
          pc.obstacles++;
          pc.minBox = Math.min(pc.minBox, fb);
          pc.minSurface = Math.min(pc.minSurface, fs);
          if (fv < 0.99 || fs < 0.9) failures.push(`${mesh.name}#${k} vertices ${(fv * 100).toFixed(1)}% surface ${(fs * 100).toFixed(1)}% box ${(fb * 100).toFixed(1)}%`);
        }
      });
    }
    console.log(`[coverage] props: ${obstacles} obstacle instances, ${page.colliders.length} page colliders; worst vertex ${(worstVertex * 100).toFixed(1)}%, worst surface ${(worstSurface * 100).toFixed(1)}%, mean surface ${((sumSurface / Math.max(1, obstacles)) * 100).toFixed(1)}%, worst box ${(worstBox * 100).toFixed(1)}%, mean box ${((sumBox / Math.max(1, obstacles)) * 100).toFixed(1)}%`, perClass);
    expect(obstacles, 'Tower Reach draws solid props a hull can reach').toBeGreaterThan(500);
    expect(failures.slice(0, 10), `${failures.length} under-covered instances`).toEqual([]);
  }, 300_000);

  it('course furniture: the LOD0 geometry a hull can touch is inside courseColliders', async () => {
    const io = await createIO();
    const variantsOf = new Map<string, Map<string, number[]>>();
    for (const name of ['course_gate_pole', 'course_turn_buoy', 'course_bar_stake', 'course_pylon', 'course_radio_tower', 'course_roofs']) {
      const path = `${ROOT}assets/models/${name}.glb`;
      expect(existsSync(path), path).toBe(true);
      const doc = await io.read(path);
      const root = doc.getRoot().getDefaultScene()!.listChildren()[0];
      const lod0 = root.listChildren().find((n) => n.getName() === 'LOD0')!;
      const map = new Map<string, number[]>();
      for (const node of lod0.listChildren()) {
        const m = /^(.+)_LOD\d+$/.exec(node.getName());
        const variant = m ? m[1] : node.getName();
        const pts: number[] = [];
        const visit = (n: typeof node): void => {
          const mesh = n.getMesh();
          if (mesh) {
            for (const prim of mesh.listPrimitives()) {
              const acc = prim.getAttribute('POSITION')!;
              const el = [0, 0, 0];
              for (let i = 0; i < acc.getCount(); i++) pts.push(...(acc.getElement(i, el) as number[]));
            }
          }
          for (const c of n.listChildren()) visit(c);
        };
        visit(node);
        map.set(variant, pts);
      }
      variantsOf.set(name, map);
    }
    const cols = courseColliders(world);
    const inside = colliderGrid(cols);
    const f = world.furniture;
    const ROOF_VARIANT: Record<string, string> = { gable: 'Gable', gableChimney: 'GableChimney', hip: 'Hip', shed: 'Shed', steeple: 'Steeple', waterTower: 'WaterTower' };
    const yaw = (a: number) => new THREE.Matrix4().makeRotationY(a);
    const lean = (l: number, d: number) => new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(-Math.sin(d), 0, Math.cos(d)), -l);
    const T = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);
    // courseFurniture.ts's placement matrices
    const placed: { label: string; asset: string; variant: string; m: THREE.Matrix4 }[] = [];
    for (const p of f.poles) placed.push({ label: `pole ${p.gateId}`, asset: 'course_gate_pole', variant: 'Spar', m: T(p.at[0], 0, p.at[1]).multiply(yaw(p.yaw)) });
    for (const b of f.buoys) placed.push({ label: `buoy ${b.markId}`, asset: 'course_turn_buoy', variant: 'Buoy', m: T(b.at[0], 0, b.at[1]).multiply(yaw(b.yaw)) });
    for (const s of f.stakes) placed.push({ label: 'stake', asset: 'course_bar_stake', variant: 'Stake', m: T(s.at[0], 0, s.at[1]).multiply(lean(s.lean, s.leanDir)).multiply(yaw(s.yaw)) });
    for (const p of f.pylons) placed.push({ label: 'pylon', asset: 'course_pylon', variant: 'Pylon', m: T(p.at[0], 0, p.at[1]).multiply(yaw(p.yaw)) });
    for (const r of f.roofs) placed.push({ label: `roof ${r.kind} @${r.at.map((q) => q.toFixed(0))}`, asset: 'course_roofs', variant: ROOF_VARIANT[r.kind], m: T(r.at[0], r.floor, r.at[1]).multiply(yaw(r.yaw)) });
    const t = f.tower;
    const footY = world.seabedAt(t.at[0], t.at[1]);
    const towerBase = T(t.at[0], footY, t.at[1]).multiply(lean(t.lean, t.leanDir)).multiply(T(0, -footY, 0)).multiply(yaw(t.yaw));
    for (const v of ['Mast', 'Hut']) placed.push({ label: `tower ${v}`, asset: 'course_radio_tower', variant: v, m: towerBase });
    for (const a of t.anchors) placed.push({ label: 'guy anchor', asset: 'course_radio_tower', variant: 'GuyAnchor', m: T(a[0], 0, a[1]) });
    const v = new THREE.Vector3();
    const byKind: Record<string, { n: number; worst: number }> = {};
    const failures: string[] = [];
    for (const p of placed) {
      const pts = variantsOf.get(p.asset)!.get(p.variant);
      expect(pts, `${p.asset} carries ${p.variant}`).toBeTruthy();
      let n = 0;
      let inV = 0;
      for (let i = 0; i < pts!.length; i += 3) {
        v.set(pts![i], pts![i + 1], pts![i + 2]).applyMatrix4(p.m);
        if (v.y < PROP_CLEAR_DEPTH || v.y > 6 || v.y < world.seabedAt(v.x, v.z)) continue;
        n++;
        if (inside(v.x, v.y, v.z, 0.05)) inV++;
      }
      if (n === 0) continue;
      const frac = inV / n;
      const kind = p.label.split(' ')[0] + (p.label.startsWith('roof') || p.label.startsWith('tower') ? ` ${p.label.split(' ')[1]}` : '');
      const k = (byKind[kind] ??= { n: 0, worst: 1 });
      k.n++;
      k.worst = Math.min(k.worst, frac);
      if (frac < 0.9) failures.push(`${p.label} ${p.variant}: ${(frac * 100).toFixed(1)}% of ${n} vertices in the hull band`);
    }
    console.log('[coverage] furniture (worst vertex fraction in the −0.6…+6 m band)', Object.fromEntries(Object.entries(byKind).map(([k, q]) => [k, `${q.n} × ${(q.worst * 100).toFixed(1)}%`])));
    expect(failures, `${failures.length} under-covered furniture placements`).toEqual([]);
  }, 300_000);
});
