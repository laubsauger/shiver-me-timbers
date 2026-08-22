/**
 * §T.150 / §B105 — THE RADIO CORNER AS A COMPOSITION, MEASURED.
 *
 * USER: "there's still this black huge box in the middle of the cabin that I
 * think tries to represent the radio." It was not the radio. It was
 * `radio-partition`, and the numbers this file measures are why the complaint
 * was right and why nothing in `raft.test.ts` had caught it: every existing
 * assertion about that corner is about where a piece IS (inside the room, on
 * its crate, clear of the crouch station), and not one of them is about what
 * a player standing in the doorway can SEE. A piece can satisfy all of them
 * and still stand square across the only sightline in the mode.
 *
 * MEASURED BEFORE THE FIX (starboard doorway, crouched eye):
 *   radio-set        front-facing 0.216 m²  → VISIBLE 0.0026 m²  (98.8% screened)
 *   radio-partition  front-facing 0.628 m²  → visible 0.628 m²
 *   solid angle: the blank card 261e-3 sr against the radio's 0.6e-3 sr — 471×
 *   the dial sightline: blocked by `radio-partition` at 1.27 m of a 2.14 m ray
 * AND AFTER:
 *   radio-set        front-facing 0.229 m²  → visible 0.229 m²  (99.8%)
 *   radio-partition  front-facing 0.252 m²  (the screen is waist-high now)
 *   the dial sightline: clear, first hit is the set itself
 *
 * The tests below are the PROPERTIES those numbers stand for (§V80), not the
 * numbers: the set is unscreened from the two places anyone looks at it from,
 * the screen physically cannot rise into the set's face, and the set's own
 * outline is not a block.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Material } from 'three';
import { buildRaftBlueprint, raftLayout } from '../src/ship/raftBlueprint';
import { ShipAssembly } from '../src/ship/shipAssembly';
import { raftParams } from '../src/params/raft';
import { playerParams } from '../src/params/player';
import { cabinRoom, radioCorner } from '../src/ship/raftPartsCabin';
import { buildPieceGeometry } from '../src/ship/pieceGeometry';
import { raftMaterialParams } from '../src/params/raftMaterials';

const stubFactory = () => ({ dispose(): void {} }) as unknown as Material;

interface Sample { p: THREE.Vector3; n: THREE.Vector3; a: number }

/** area-weighted samples over every triangle of a piece's mesh, in world space */
function surfaceSamples(asm: ShipAssembly, id: string): Sample[] {
  const mesh = asm.group.getObjectByName(`${id}-mesh`) as THREE.Mesh;
  asm.group.updateWorldMatrix(true, true);
  const g = mesh.geometry;
  const pos = g.attributes.position;
  const idx = g.index;
  const n = idx !== null ? idx.count / 3 : pos.count / 3;
  const out: Sample[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < n; t++) {
    const i0 = idx !== null ? idx.getX(t * 3) : t * 3;
    const i1 = idx !== null ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idx !== null ? idx.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(pos, i0).applyMatrix4(mesh.matrixWorld);
    b.fromBufferAttribute(pos, i1).applyMatrix4(mesh.matrixWorld);
    c.fromBufferAttribute(pos, i2).applyMatrix4(mesh.matrixWorld);
    const ab = b.clone().sub(a), ac = c.clone().sub(a);
    const cross = ab.clone().cross(ac);
    const area = cross.length() / 2;
    if (area < 1e-9) continue;
    const nrm = cross.normalize();
    // 6 barycentric samples per triangle
    const bary = [[0.5, 0.25], [0.25, 0.5], [0.25, 0.25], [0.1, 0.1], [0.7, 0.15], [0.15, 0.7]];
    for (const [u, v] of bary) {
      out.push({
        p: a.clone().addScaledVector(ab, u).addScaledVector(ac, v),
        n: nrm.clone(),
        a: area / bary.length,
      });
    }
  }
  return out;
}

/** projected area (m²) of `id` seen from `eye`, occluded by everything else */
function visibleProjectedArea(asm: ShipAssembly, id: string, eye: THREE.Vector3): {
  raw: number; front: number; visible: number; solid: number;
} {
  const samples = surfaceSamples(asm, id);
  const targets: THREE.Mesh[] = [];
  asm.group.traverse((o) => { if ((o as THREE.Mesh).isMesh === true) targets.push(o as THREE.Mesh); });
  const rc = new THREE.Raycaster();
  rc.far = 100;
  let raw = 0, front = 0, visible = 0, solid = 0;
  const dir = new THREE.Vector3();
  for (const s of samples) {
    raw += s.a;
    dir.copy(s.p).sub(eye);
    const dist = dir.length();
    dir.normalize();
    const cos = -dir.dot(s.n);
    if (cos <= 0) continue; // back-facing
    const proj = s.a * cos;
    front += proj;
    rc.set(eye, dir);
    rc.far = dist - 1e-3;
    const hits = rc.intersectObjects(targets, true);
    let blocked = false;
    for (const h of hits) {
      if (h.distance >= dist - 2e-3) break;
      if (h.object.name === `${id}-mesh`) continue;
      blocked = true;
      break;
    }
    if (blocked) continue;
    visible += proj;
    solid += proj / (dist * dist);
  }
  return { raw, front, visible, solid };
}

/**
 * SILHOUETTE FILL: rasterize the piece's outline as seen from `eye`, and
 * divide by the area of the CONVEX HULL of that same outline. A box is convex
 * from every angle, so a box scores 1.0 — anything that reads as an object
 * rather than a block (a hood, knobs standing off the face, feet, a handle)
 * cuts notches into its own outline and scores below it.
 */
export function silhouetteFill(asm: ShipAssembly, id: string, eye: THREE.Vector3, N = 220): {
  fill: number; area: number; hull: number;
} {
  const mesh = asm.group.getObjectByName(`${id}-mesh`) as THREE.Mesh;
  asm.group.updateWorldMatrix(true, true);
  const g = mesh.geometry;
  const pos = g.attributes.position;
  const idx = g.index;
  g.computeBoundingBox();
  const centre = g.boundingBox!.getCenter(new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
  const fwd = centre.clone().sub(eye).normalize();
  const up0 = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(fwd, up0).normalize();
  const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
  const project = (p: THREE.Vector3): [number, number] => {
    const v = p.clone().sub(eye);
    const z = v.dot(fwd);
    return [v.dot(right) / z, v.dot(up) / z];
  };
  const tris: Array<[number, number][]> = [];
  const n = idx !== null ? idx.count / 3 : pos.count / 3;
  const v = new THREE.Vector3();
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let t = 0; t < n; t++) {
    const tri: [number, number][] = [];
    for (let k = 0; k < 3; k++) {
      const i = idx !== null ? idx.getX(t * 3 + k) : t * 3 + k;
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      const q = project(v);
      tri.push(q);
      x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]);
      y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]);
    }
    tris.push(tri);
  }
  const pad = 0.02 * Math.max(x1 - x0, y1 - y0);
  x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
  const grid = new Uint8Array(N * N);
  const inside = (p: [number, number], a: [number, number], b: [number, number], c: [number, number]): boolean => {
    const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(d) < 1e-18) return false;
    const l1 = ((b[1] - c[1]) * (p[0] - c[0]) + (c[0] - b[0]) * (p[1] - c[1])) / d;
    const l2 = ((c[1] - a[1]) * (p[0] - c[0]) + (a[0] - c[0]) * (p[1] - c[1])) / d;
    return l1 >= 0 && l2 >= 0 && l1 + l2 <= 1;
  };
  for (const tri of tris) {
    const tx0 = Math.max(0, Math.floor((Math.min(tri[0][0], tri[1][0], tri[2][0]) - x0) / (x1 - x0) * N));
    const tx1 = Math.min(N - 1, Math.ceil((Math.max(tri[0][0], tri[1][0], tri[2][0]) - x0) / (x1 - x0) * N));
    const ty0 = Math.max(0, Math.floor((Math.min(tri[0][1], tri[1][1], tri[2][1]) - y0) / (y1 - y0) * N));
    const ty1 = Math.min(N - 1, Math.ceil((Math.max(tri[0][1], tri[1][1], tri[2][1]) - y0) / (y1 - y0) * N));
    for (let iy = ty0; iy <= ty1; iy++) {
      for (let ix = tx0; ix <= tx1; ix++) {
        if (grid[iy * N + ix] === 1) continue;
        const p: [number, number] = [x0 + (ix + 0.5) / N * (x1 - x0), y0 + (iy + 0.5) / N * (y1 - y0)];
        if (inside(p, tri[0], tri[1], tri[2])) grid[iy * N + ix] = 1;
      }
    }
  }
  let filled = 0;
  const pts: [number, number][] = [];
  for (let iy = 0; iy < N; iy++) {
    for (let ix = 0; ix < N; ix++) {
      if (grid[iy * N + ix] === 1) { filled++; pts.push([ix, iy]); }
    }
  }
  // convex hull (monotone chain) of the filled cells, area by the shoelace
  pts.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const cross = (o: [number, number], a: [number, number], b: [number, number]): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const q of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const q = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  const hullPts = lower.slice(0, -1).concat(upper.slice(0, -1));
  let hull = 0;
  for (let i = 0; i < hullPts.length; i++) {
    const a = hullPts[i], b = hullPts[(i + 1) % hullPts.length];
    hull += a[0] * b[1] - b[0] * a[1];
  }
  hull = Math.abs(hull) / 2;
  // the hull is measured between cell CENTRES; pad it by its own perimeter's
  // half-cell so a convex block scores 1 rather than 0.97
  return { fill: filled / Math.max(1e-9, hull + Math.sqrt(hull) * 2 + 1), area: filled, hull };
}


describe('§T.150 the radio is the thing you see in the radio corner', () => {
  const p = raftParams;
  const L = raftLayout();
  const raft = buildRaftBlueprint();
  const asm = new ShipAssembly(raft, stubFactory);
  asm.group.updateMatrixWorld(true);
  const room = cabinRoom(p, L);
  const corner = radioCorner(p, L);
  const byId = new Map(raft.map((d) => [d.id, d]));

  /** the two eyes that matter: kneeling at the dial, and stepping in the door */
  const kneel = ((): THREE.Vector3 => {
    const s = asm.socketWorldPosition('station-radio');
    return new THREE.Vector3(s[0], s[1] + playerParams.crouchHeight - playerParams.eyeDrop, s[2]);
  })();
  // the cabin ridge is under 1.6 m [§V82], so anyone in the doorway is crouched
  const doorway = new THREE.Vector3(
    room.x1 - playerParams.capsuleRadius,
    room.floor + playerParams.crouchHeight - playerParams.eyeDrop,
    (room.doorZ0 + room.doorZ1) / 2,
  );
  const EYES = [['station-radio', kneel], ['the starboard doorway', doorway]] as const;

  it('is UNSCREENED from the dial and from the doorway — what faces the eye is what reaches it', () => {
    for (const [where, eye] of EYES) {
      const m = visibleProjectedArea(asm, 'radio-set', eye);
      // the bar is a fraction, not an area: an area bar would break the day
      // someone legitimately re-sizes the set (§V80)
      expect(m.front, `${where}: the set turns no face to the eye at all`).toBeGreaterThan(0.05);
      expect(m.visible / m.front,
        `${where}: ${(100 * (1 - m.visible / m.front)).toFixed(1)}% of the radio's face is screened by something`,
      ).toBeGreaterThan(0.9);
    }
  });

  it('and the DIAL SIGHTLINE from the doorway is clear: the first thing the ray meets is the set', () => {
    // §B105's composition defect in one assertion. §T.103 makes this dial the
    // game's main interface; a player who cannot see it from the only way into
    // the cabin cannot be expected to find it.
    const targets: THREE.Mesh[] = [];
    asm.group.traverse((o) => { if ((o as THREE.Mesh).isMesh === true) targets.push(o as THREE.Mesh); });
    for (const [where, eye] of EYES) {
      const dial = new THREE.Vector3(...corner.dial);
      const dir = dial.clone().sub(eye);
      const dist = dir.length();
      const hits = new THREE.Raycaster(eye, dir.normalize(), 0, dist - 2e-3)
        .intersectObjects(targets, true)
        .filter((h) => h.distance < dist - 2e-3)
        .map((h) => h.object.name)
        .filter((n) => n !== 'radio-set-mesh' && n !== 'radio-needle-mesh');
      expect(hits, `${where}: ${hits[0] ?? ''} stands between the player and the dial`).toEqual([]);
    }
  });

  it('the card screen CANNOT rise into the set\'s face — it is waist high by construction', () => {
    // the geometric form of the same property, so a re-tune of
    // `partitionHeight` that undoes §B105 fails here rather than in a frame
    // three weeks later. [§3 Radio corner] wants a screen round the corner;
    // what it does not want is a wall in front of the one thing in it.
    const set = byId.get('radio-set')!;
    const setFoot = set.transform.position[1] + set.aabb.min[1];
    expect(corner.partition.top, 'the partition reaches into the radio\'s face')
      .toBeLessThan(setFoot);
    // …and it closes the NOOK, not the room: no longer than the crate it screens plus a hand
    expect(p.partitionLength, 'the screen runs further than the nook it closes')
      .toBeLessThan(p.radioCrateDepth + 0.25);
  });

  it('the set READS AS A RADIO, not a block: its outline is notched from every angle anyone sees it', () => {
    // USER: "it should look like a radio, should have a better shape, like more
    // complex than just a box". A box is CONVEX from every direction, so its
    // outline is its own convex hull and it scores 1.0. §T.117's set scored
    // 0.878 from the doorway and 0.864 at the dial — a block with a stub on the
    // side. The bail, the brow, the feet and the two proud knobs take it to
    // 0.831 / 0.813. The bar is what separates "an object" from "a crate".
    for (const [where, eye] of EYES) {
      const fill = silhouetteFill(asm, 'radio-set', eye).fill;
      expect(fill, `${where}: the radio's outline is ${(100 * fill).toFixed(1)}% of its own convex hull — that is a box`)
        .toBeLessThan(0.86);
    }
  });

  it('§B111 the LED lens is the ONLY thing in the front depth band the shader lights', () => {
    // The material picks the lens by `radioLedPlane` and nothing else, because
    // the corner test it used before could be — and was — moved out from under
    // it by the crank and the aerial (raftMaterials.ts). That contract is only
    // true while no other part reaches the front of the case, so it is asserted
    // here rather than trusted.
    const set = byId.get('radio-set')!;
    const g = buildPieceGeometry(set.kind, set.aabb, set.shape);
    g.computeBoundingBox();
    const zMin = g.boundingBox!.min.z;
    const zMax = g.boundingBox!.max.z;
    const plane = raftMaterialParams.radioLedPlane;
    const pos = g.attributes.position;
    const ledR = Math.max(0.006, (set.aabb.max[0] - set.aabb.min[0]) * 0.03);
    let inBand = 0;
    for (let i = 0; i < pos.count; i++) {
      if ((pos.getZ(i) - zMin) / (zMax - zMin) <= plane + 1e-9) continue;
      inBand++;
      // everything up there is the lens, i.e. within its own radius of its axis
      const dx = pos.getX(i) - (set.aabb.max[0] - set.aabb.min[0]) * 0.42;
      const dy = pos.getY(i) - (set.aabb.max[1] - set.aabb.min[1]) * 0.06;
      expect(Math.hypot(dx, dy), 'something other than the LED reaches the front band')
        .toBeLessThan(ledR * 1.5);
    }
    expect(inBand, 'nothing reaches the LED band at all — the lamp is dark again').toBeGreaterThan(0);
    g.dispose();
  });
});
