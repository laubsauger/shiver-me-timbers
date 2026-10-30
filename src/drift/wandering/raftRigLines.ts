/**
 * THE HERO RAFT'S RIGGING FOR THE FILM — the game's own rigging plan (ship/raftRigging.ts `buildRaftRiggingPlan`: the
 * sheets from every clew down to its belaying pin, the main's braces and lifts, the halyards from the trucks to the
 * deck, the stays), hung between the same live sockets the game's ropes are (ShipAssembly.socketWorldPosition: a
 * clew is where the cloth shader draws it), so the film's rig and the game's are one rig.
 *
 * WHY NOT THE GAME'S ROPES. They are a Verlet solve carried from frame to frame (src/ropes), and a film frame is a
 * pure function of its time (raft.ts header: "Not yet: the ropes"). So the film had none — the user, 2026-10-30, of
 * the topsail and the mizzen at sunset: "they both don't really have a connection to the top with any kind of ropes";
 * every clew hung free, nothing led down to the deck. Here each rope is laid afresh every frame as the curve a rope of
 * its length hangs in between its two ends: the plan's own slack (more as the sail is furled, `slackForFurl`, as the
 * game eases them), the sag a parabola across the chord with the drop of a catenary of that length
 * (s = √(3·c·(L − c)/8)), pulled toward the ground only by the part of gravity across the chord — a halyard straight
 * up a mast does not belly sideways.
 *
 * One mesh, every rope a tube of SEGMENTS × SIDES, its positions and normals rewritten each update; in the raft's frame
 * (a child of its root), so it rides the raft. Thin hemp casts no shadow a map resolves (raftDress.ts's rule for its
 * cords), so it casts none.
 */
import * as THREE from 'three/webgpu';
import type { PieceDef } from '../../ship/pieceTypes';
import type { ShipAssembly } from '../../ship/shipAssembly';
import { buildRaftRiggingPlan } from '../../ship/raftRigging';
import { slackForFurl } from '../../ropes/shipRigging';

/** segments along a rope, and sides round it */
const SEGMENTS = 14;
const SIDES = 5;

export interface RaftRigLines {
  readonly mesh: THREE.Mesh;
  /** lay every rope for the raft as posed now (`furl`: 0 set … 1 furled), in `root`'s frame */
  update(furl: number): void;
}

export function createRaftRigLines(assembly: ShipAssembly, blueprint: PieceDef[], material: THREE.Material, root: THREE.Object3D): RaftRigLines {
  const plan = buildRaftRiggingPlan(blueprint);
  const ring = SIDES;
  const perRope = (SEGMENTS + 1) * ring;
  const n = plan.length * perRope;
  const position = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
  const normal = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
  const index: number[] = [];
  plan.forEach((_, r) => {
    const base = r * perRope;
    for (let s = 0; s < SEGMENTS; s++) {
      for (let k = 0; k < ring; k++) {
        const a = base + s * ring + k;
        const b = base + s * ring + ((k + 1) % ring);
        const c = a + ring;
        const d = b + ring;
        index.push(a, c, b, b, c, d);
      }
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', position);
  geo.setAttribute('normal', normal);
  geo.setIndex(index);
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'drift-raft-rig-lines';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  root.add(mesh);

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const chord = new THREE.Vector3();
  const down = new THREE.Vector3();
  const across = new THREE.Vector3();
  const p = new THREE.Vector3();
  const t0 = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const bin = new THREE.Vector3();
  const pts = Array.from({ length: SEGMENTS + 1 }, () => new THREE.Vector3());
  const UP = new THREE.Vector3(0, 1, 0);
  const X = new THREE.Vector3(1, 0, 0);
  const inv = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const world = new Map<string, [number, number, number]>();
  const at = (id: string): [number, number, number] => {
    let w = world.get(id);
    if (w === undefined) {
      w = assembly.socketWorldPosition(id);
      world.set(id, w);
    }
    return w;
  };

  return {
    mesh,
    update(furl) {
      root.updateWorldMatrix(true, false);
      assembly.group.updateMatrixWorld(true);
      inv.copy(root.matrixWorld).invert();
      // world down, in the root's frame
      root.getWorldQuaternion(q);
      down.set(0, -1, 0).applyQuaternion(q.invert());
      world.clear();
      const pos = position.array as Float32Array;
      const nor = normal.array as Float32Array;
      plan.forEach((rope, r) => {
        a.fromArray(at(rope.socketA)).applyMatrix4(inv);
        b.fromArray(at(rope.socketB)).applyMatrix4(inv);
        chord.subVectors(b, a);
        const c = Math.max(1e-4, chord.length());
        const len = c * slackForFurl(rope.role, rope.slack, furl);
        const sag = Math.sqrt((3 * c * Math.max(0, len - c)) / 8);
        // gravity's part across the chord: all of it on a level rope, none on a plumb one
        across.copy(down).addScaledVector(chord, -down.dot(chord) / (c * c));
        for (let s = 0; s <= SEGMENTS; s++) {
          const t = s / SEGMENTS;
          pts[s].copy(a).addScaledVector(chord, t).addScaledVector(across, sag * 4 * t * (1 - t));
        }
        const base = r * perRope;
        for (let s = 0; s <= SEGMENTS; s++) {
          // the tube's frame: along the curve, and a side square to it (off the up, or the athwartships for a plumb line)
          t0.subVectors(pts[Math.min(SEGMENTS, s + 1)], pts[Math.max(0, s - 1)]).normalize();
          nrm.crossVectors(t0, Math.abs(t0.y) < 0.9 ? UP : X).normalize();
          bin.crossVectors(t0, nrm).normalize();
          for (let k = 0; k < ring; k++) {
            const ang = (k / ring) * Math.PI * 2;
            p.copy(nrm).multiplyScalar(Math.cos(ang)).addScaledVector(bin, Math.sin(ang));
            const i = (base + s * ring + k) * 3;
            nor[i] = p.x;
            nor[i + 1] = p.y;
            nor[i + 2] = p.z;
            pos[i] = pts[s].x + p.x * rope.thickness;
            pos[i + 1] = pts[s].y + p.y * rope.thickness;
            pos[i + 2] = pts[s].z + p.z * rope.thickness;
          }
        }
      });
      position.needsUpdate = true;
      normal.needsUpdate = true;
      geo.computeBoundingSphere();
    },
  };
}
