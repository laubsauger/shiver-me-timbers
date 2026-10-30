/**
 * NO TWO FACES OF THE DRESSED RAFT FIGHT FOR THE SAME PIXELS (the user, 2026-10-30, a red circle on the raft's side at
 * the landing: the cut end of a log "between this stump and the sideboard", flickering through it — "make sure it
 * doesn't happen anywhere there's this planking").
 *
 * The raft as both the game and the film draw it — the blueprint's assembly with its worn twins and dressing
 * (raftDress.ts: the planks, the slatted deck, the cabin frame) — in the ship's frame, every triangle of every mesh.
 * Two checks:
 *   1. COPLANAR OVERLAP: no two meshes have faces facing the same way in the same plane (normals within ~1°, planes
 *      within 1 mm) that overlap. That is what z-fights: two surfaces at one depth, each winning on alternate pixels.
 *      Faces turned down (undersides resting on the logs and beams: no eye above the water sees them) and the ropes
 *      re-laid at render time (their geometry is a unit placeholder until drawn) are not counted.
 *   2. BEAM ENDS CLEAR THE BOARDS: the user's flicker was not a coplanar pair but a cross-beam's end disc buried 1 cm
 *      inside a side board that bows and twists across it. Every beam end under a side board stands at least 2 cm
 *      inside the board's inner face.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildRaftBlueprint } from '../src/ship/raftBlueprint';
import { ShipAssembly } from '../src/ship/shipAssembly';
import { dressRaft } from '../src/ship/raftDress';

interface Tri {
  m: number;
  a: THREE.Vector3;
  b: THREE.Vector3;
  c: THREE.Vector3;
  n: THREE.Vector3;
  d: number;
}

function dressedRaft(): THREE.Object3D {
  const stub = (() => new THREE.MeshBasicMaterial()) as never;
  const blueprint = buildRaftBlueprint();
  const asm = new ShipAssembly(blueprint, stub);
  // (the stores load models: not here, and not needed — they are seated on what this checks)
  dressRaft(asm.group as never, blueprint, stub, { tier: 'film' }).ready.catch(() => {});
  asm.group.updateMatrixWorld(true);
  return asm.group;
}

/** the 2D projections of two coplanar triangles overlap (separating axes), by more than a sliver */
function overlaps(t: Tri, u: Tri): boolean {
  const n = t.n;
  const drop = Math.abs(n.x) > Math.abs(n.y) && Math.abs(n.x) > Math.abs(n.z) ? 0 : Math.abs(n.y) > Math.abs(n.z) ? 1 : 2;
  const pr = (v: THREE.Vector3): [number, number] => (drop === 0 ? [v.y, v.z] : drop === 1 ? [v.x, v.z] : [v.x, v.y]);
  const A = [t.a, t.b, t.c].map(pr);
  const B = [u.a, u.b, u.c].map(pr);
  const edges = (P: Array<[number, number]>): Array<[number, number]> =>
    P.map((p, i) => {
      const q = P[(i + 1) % 3];
      return [-(q[1] - p[1]), q[0] - p[0]];
    });
  for (const ax of [...edges(A), ...edges(B)]) {
    const len = Math.hypot(ax[0], ax[1]);
    if (len < 1e-9) continue;
    const pa = A.map((p) => (p[0] * ax[0] + p[1] * ax[1]) / len);
    const pb = B.map((p) => (p[0] * ax[0] + p[1] * ax[1]) / len);
    // (0.5 mm of overlap or less is two faces meeting along an edge, not one over the other)
    if (Math.max(...pa) <= Math.min(...pb) + 5e-4 || Math.max(...pb) <= Math.min(...pa) + 5e-4) return false;
  }
  return true;
}

describe('the dressed raft: no z-fighting faces', () => {
  const raft = dressedRaft();

  it('has no two meshes with overlapping faces in one plane, facing one way', () => {
    const tris: Tri[] = [];
    const names: string[] = [];
    raft.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible) return;
      // (ropes laid at render time: a unit placeholder until then)
      if (/halyard-mesh$/.test(mesh.name)) return;
      const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
      const p = g.attributes.position;
      if (!p) return;
      const mi = names.push(mesh.name || mesh.parent?.name || '?') - 1;
      for (let i = 0; i + 2 < p.count; i += 3) {
        const a = new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld);
        const b = new THREE.Vector3().fromBufferAttribute(p, i + 1).applyMatrix4(mesh.matrixWorld);
        const c = new THREE.Vector3().fromBufferAttribute(p, i + 2).applyMatrix4(mesh.matrixWorld);
        const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
        if (n.length() < 2e-6) continue;
        n.normalize();
        if (n.y < -0.7) continue; // an underside
        tris.push({ m: mi, a, b, c, n, d: n.dot(a) });
      }
    });
    expect(tris.length).toBeGreaterThan(100000);
    // bucketed by normal (1/100 per component) and plane offset (2 mm), each bucket against its upper neighbour
    const key = (t: Tri, dOff: number): string =>
      `${Math.round(t.n.x * 100)},${Math.round(t.n.y * 100)},${Math.round(t.n.z * 100)},${Math.round(t.d / 0.002) + dOff}`;
    const buckets = new Map<string, number[]>();
    tris.forEach((t, i) => {
      const k = key(t, 0);
      const list = buckets.get(k);
      if (list) list.push(i);
      else buckets.set(k, [i]);
    });
    const found = new Map<string, number>();
    for (const [k, list] of buckets) {
      const [nx, ny, nz, d] = k.split(',').map(Number);
      const others = [...list, ...(buckets.get(`${nx},${ny},${nz},${d + 1}`) ?? [])];
      if (new Set(others.map((i) => tris[i].m)).size < 2) continue;
      for (const i of list) {
        for (const j of others) {
          const t = tris[i];
          const u = tris[j];
          if (t.m === u.m || (j < i && list.includes(j))) continue;
          if (t.n.dot(u.n) < 0.9998 || Math.abs(t.n.dot(u.a) - t.d) > 0.001) continue;
          if (!overlaps(t, u)) continue;
          const pair = [names[t.m], names[u.m]].sort().join(' | ');
          // (two slings' legs meeting at their apex on the yard)
          if (/sling-[ps]-mesh \| .*sling-[ps]-mesh/.test(pair)) continue;
          found.set(pair, (found.get(pair) ?? 0) + 1);
        }
      }
    }
    expect([...found.entries()].map(([p, n]) => `${p} (${n})`)).toEqual([]);
  }, 120_000);

  it('keeps every cross-beam end 2 cm inside the side board over it', () => {
    const box = new THREE.Box3();
    const boxOf = (name: string): THREE.Box3 => box.setFromObject(raft.getObjectByName(name)!).clone();
    const beams: THREE.Box3[] = [];
    raft.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && /^crossbeam-\d+-mesh$/.test(o.name)) beams.push(boxOf(o.name));
    });
    expect(beams.length).toBeGreaterThan(5);
    let checked = 0;
    for (const side of ['port', 'starboard'] as const) {
      const board = boxOf(`splashboard-${side}-side-mesh`);
      for (const b of beams) {
        if (b.max.z < board.min.z || b.min.z > board.max.z) continue;
        checked++;
        if (side === 'starboard') expect(board.min.x - b.max.x).toBeGreaterThan(0.02);
        else expect(b.min.x - board.max.x).toBeGreaterThan(0.02);
      }
    }
    expect(checked).toBeGreaterThan(3);
  });
});
