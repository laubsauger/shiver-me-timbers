/**
 * THE CREW ABOARD (src/drift/wandering/crew.ts, crewLife.ts; the 2026-11-02 review: "they're sitting in a way where the
 * front sail is cutting through the body of the one guy" … "When the dolphin comes there's no reaction from them").
 *
 * WHY THIS TEST. The three had been placed by hand once, and nothing checked them against what moves on a raft: one sat
 * inside the main course's sweep (its cloth bellies 0.3 m aft and 1.8 m forward of its yard and comes down to 0.4 m over
 * the deck when it is set), one stood inside the cabin. Every bar here is a PROPERTY over the whole show — no point of
 * any of them inside the sails (every trim the show uses, every belly the wind could give them, drawing or aback), the
 * furled roll, the yards, the masts and legs, the oar, the guaras, the cabin, the stores, the rigging's ropes, or each
 * other — so it fails whether a figure is moved, a pose changed, or the rig re-cut.
 *
 * GPU-FREE (the sailMastClearance test's way): the game's blueprint and assembly with a stub material, the CPU cloth
 * evaluator, the film's rope plan (raftRigLines.ts). What it cannot see: the film's dressing (raftDress.ts, raftStores.ts:
 * the cabin's frame poles, the scanned stores in the boxes' places) — the boxes stand in for the stores here.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildRaftBlueprint } from '../src/ship/raftBlueprint';
import { ShipAssembly } from '../src/ship/shipAssembly';
import { shipMaterialParams } from '../src/params/ship';
import { sailClothPoint } from '../src/ship/sailShape';
import { readSailSparSources, resolveSailSpars, sheetLeadDirections } from '../src/ship/sailFrame';
import { createRaftRigLines } from '../src/drift/wandering/raftRigLines';
import { createRaftLanterns } from '../src/ship/raftLanterns';
import { raftParams } from '../src/params/raft';
import { C1_FOLLOW, beatStarts, beatsAt, sailsAt } from '../src/drift/wandering/beats';
import { C3_RAFT, FLIP_RELEASE, caseOnDeck, dolphinPose, flipThrow } from '../src/drift/wandering/dolphin';
import { ANSWER_AT, WAKE_FROM } from '../src/drift/wandering/roseTraffic';
import { CASE_REST, STATIONS } from '../src/drift/wandering/props';
import { CREW, crewCapsules, solveCrew, type CrewCapsule } from '../src/drift/wandering/crew';
import { ABOARD, LOOM, crewNow, crewSpots, type CrewNow, type CrewWorld, type V } from '../src/drift/wandering/crewLife';

type P = THREE.Vector3;
const D = Math.PI / 180;
/** m: the sampling of every surface (a forearm is 3.7 cm about its axis: a sheet through it leaves samples inside it) */
const H = 0.025;
/** m a capsule may graze a surface before it counts (the figures' radii are their thickest; a few mm of contact is a
 * hand on a tiller or a calf on a log, not a body through a sail) */
const TOL = 0.012;
/** the raft's parts a figure stands, sits or kneels on (the feet and the seat touch them by design) */
const UNDERFOOT = new Set(['log', 'bamboo-deck', 'crossbeam', 'lashing', 'splashboard']);

// the show's clock: c1 ends at an arbitrary 100 s of sea time (only differences matter)
const C1_END = 100;
const { starts } = beatStarts(C1_END);
const FOLLOW = C1_END - C1_FOLLOW;
const smooth = (x: number): number => {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
};
/** the main course's trim at sea t (sea.ts: hoisted in c1's follow, HOIST [2, 9] s; beats.ts sailsAt after) */
const sailsOf = (t: number): number => {
  const b = beatsAt(t, C1_END);
  const beat = b[b.length - 1].name;
  if (beat === 'c1') return smooth((t - FOLLOW - 2) / 7);
  // (through a dissolve both are drawn: the one more set)
  return Math.max(...b.map((x) => sailsAt(x.name, t, C1_END)));
};

// ── the raft (GPU-free) ──────────────────────────────────────────────────────────────────────────────────────────────
const material = (): THREE.Material => new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
const blueprint = buildRaftBlueprint();
for (const def of blueprint) if (def.sailStates && def.shape) def.shape.furlLash = 0.6;
const kindOf = new Map(blueprint.map((d) => [d.id, d.kind]));
const asm = new ShipAssembly(blueprint, material);
asm.setGuaraDepths([0.8, 0.8, 0.8]);
// the lanterns under the roof's corners, as the film hangs them (raft.ts; raftLanterns.ts) — the coordinator's note of
// the 2026-11-02 review: "the shot with the lamp right in front of the face of the dude is a bit weird … at night and
// during the day" (the old standing figure, walked out from under the roof by the footing ray, stood at its aft corner)
const lanterns = createRaftLanterns(raftParams, { lights: false });
asm.group.add(lanterns.group);
const lanternAt = lanterns.group.children.filter((o) => o.name.startsWith('raft-lantern-')).map((o) => o.position.clone());
const root = new THREE.Group();
root.add(asm.group);
const rig = createRaftRigLines(asm, blueprint, material() as never, root);
const sailIds = asm.sailPieceIds();
const kindAt = (o: THREE.Object3D | null): string => {
  for (; o; o = o.parent) {
    if (o.name.startsWith('raft-lantern')) return 'lantern';
    const k = kindOf.get(o.name);
    if (k) return k;
  }
  return '';
};

/** the trim at `set`: every sail's drop and its yard's hoist */
function trim(set: number): void {
  for (const id of sailIds) {
    asm.setSailDropScale(id, Math.max(0.01, set));
    asm.setYardHoist(id, set);
  }
  root.updateMatrixWorld(true);
}

// ── the figures' spots: a ray down onto the raft, through the rigging and the sails (props.ts seatOn) ─────────────
trim(0.01);
const ray = new THREE.Raycaster();
/** the top of what a figure could stand on at (x, z) (props.ts `top`): through the sails, the yards and the ropes */
const top = (x: number, z: number): number => {
  ray.set(new THREE.Vector3(x, 6, z), new THREE.Vector3(0, -1, 0));
  const ys = ray
    .intersectObject(asm.group, true)
    .filter((h) => !['sail', 'yard', 'pennant'].includes(kindAt(h.object)))
    .map((h) => h.point.y)
    .filter((y) => y < 1.3);
  return ys.length ? Math.max(...ys) : -Infinity;
};
const rest = CASE_REST;
/** the case at rest (props.ts: on the top of what is at its landing spot, its centre 0.11 m up; skidded on to its rest
 * along the deck) */
const caseY = top(rest[0] - caseOnDeck().dir[0] * 0.3, rest[1] - caseOnDeck().dir[1] * 0.3) + 0.11;
const spots = crewSpots(top, rest);
const near = (p: P): boolean =>
  [spots.helm, spots.edge, spots.sill, spots.out, spots.fore, spots.kneeler].some((s) => Math.hypot(p.x - s[0], p.z - s[2]) < 2.2 && p.y < s[1] + 2.6);

// ── the world, in the raft's frame (c3's pose: dolphin.ts C3_RAFT) ───────────────────────────────────────────────────
const bowDir: [number, number] = [-Math.sin(C3_RAFT.heading * D), Math.cos(C3_RAFT.heading * D)];
const sideDir: [number, number] = [-Math.cos(C3_RAFT.heading * D), -Math.sin(C3_RAFT.heading * D)];
const centre: [number, number] = [Math.sin(C3_RAFT.bearing * D) * C3_RAFT.distance, Math.cos(C3_RAFT.bearing * D) * C3_RAFT.distance];
/** raft-local of an eye-frame point (x right, z ahead) at height y */
const fromEye = (x: number, y: number, z: number): V => {
  const r = [x - centre[0], z - centre[1]];
  return [r[0] * sideDir[0] + r[1] * sideDir[1], y, r[0] * bowDir[0] + r[1] * bowDir[1]];
};
const eyeDir = (bearingDeg: number, elDeg: number): V => {
  const p = fromEye(centre[0] + Math.sin(bearingDeg * D) * 1000, 0, centre[1] + Math.cos(bearingDeg * D) * 1000);
  const l = Math.hypot(p[0], p[2]);
  return [(p[0] / l) * Math.cos(elDeg * D), Math.sin(elDeg * D), (p[2] / l) * Math.cos(elDeg * D)];
};
function worldAt(t: number, operator: boolean): CrewWorld {
  const c3 = t - starts.c3;
  const d = c3 > 0 && c3 < 42.5 ? dolphinPose(c3) : null;
  const lampDir = eyeDir(STATIONS[WAKE_FROM], 0);
  // (the case: from the snout at the throw to its rest, ~1 s; then there)
  const caseAt: V | null = c3 > FLIP_RELEASE ? (() => {
    const u = Math.min(1, (c3 - FLIP_RELEASE) / 1.1);
    const from = fromEye(...([dolphinPose(FLIP_RELEASE).x, 1, dolphinPose(FLIP_RELEASE).z] as [number, number, number]));
    return [from[0] + (rest[0] - from[0]) * u, caseY + 1.5 * Math.sin(Math.PI * u), from[2] + (rest[1] - from[2]) * u];
  })() : null;
  // (the deck rolling under them: ±5° on a few seconds' swell)
  const roll = 0.087 * Math.sin(t * 0.9);
  const pitch = 0.05 * Math.sin(t * 0.63 + 1);
  return {
    t,
    starts,
    operator,
    dolphin: d ? fromEye(d.x, d.y, d.z) : null,
    caseAt,
    lamp: [lampDir[0] * 7000, 40, lampDir[2] * 7000],
    land: t > starts.w1 ? [60, 1.5, 10] : null,
    sun: eyeDir(-22, 2),
    up: [Math.sin(roll), Math.cos(roll) * Math.cos(pitch), Math.sin(pitch)],
    spots,
  };
}

/** a figure's capsules in the raft's frame */
function capsules(c: CrewNow): CrewCapsule[] {
  const who = CREW[c.role === 'kneeler' ? ABOARD.helm : ABOARD[c.role]];
  const k = who.height / 1.75;
  const m = new THREE.Matrix4().compose(new THREE.Vector3(...c.root), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), c.rot), new THREE.Vector3(k, k, k));
  const to = (p: V): V => new THREE.Vector3(...p).applyMatrix4(m).toArray() as V;
  return crewCapsules(solveCrew(c.act), who.look).map((s) => ({ ...s, a: to(s.a), b: to(s.b), r: s.r * k }));
}

// ── the obstacles, as points on their surfaces, binned ───────────────────────────────────────────────────────────
interface Pt {
  p: P;
  r: number;
  kind: string;
}
class Bins {
  private m = new Map<string, Pt[]>();
  /** the points' bounds, grown by the largest point radius: a capsule clear of it is clear of all of them */
  private box = new THREE.Box3();
  private key = (x: number, y: number, z: number): string => `${Math.floor(x / 0.1)},${Math.floor(y / 0.1)},${Math.floor(z / 0.1)}`;
  add(pt: Pt): void {
    this.box.expandByPoint(pt.p.clone().addScalar(pt.r)).expandByPoint(pt.p.clone().subScalar(pt.r));
    const k = this.key(pt.p.x, pt.p.y, pt.p.z);
    const l = this.m.get(k);
    if (l) l.push(pt);
    else this.m.set(k, [pt]);
  }
  /** the deepest any point lies inside capsule `c` (m; > 0 inside), skipping kinds `skip`, and what it is */
  deepest(c: CrewCapsule, skip: (kind: string) => boolean): { d: number; kind: string } {
    const a = new THREE.Vector3(...c.a);
    const ab = new THREE.Vector3(...c.b).sub(a);
    const l2 = ab.lengthSq();
    const reach = c.r + 0.05;
    const lo = new THREE.Vector3(Math.min(c.a[0], c.b[0]), Math.min(c.a[1], c.b[1]), Math.min(c.a[2], c.b[2])).subScalar(reach);
    const hi = new THREE.Vector3(Math.max(c.a[0], c.b[0]), Math.max(c.a[1], c.b[1]), Math.max(c.a[2], c.b[2])).addScalar(reach);
    let best = { d: -Infinity, kind: '' };
    if (!this.box.intersectsBox(new THREE.Box3(lo, hi))) return best;
    const q = new THREE.Vector3();
    for (let x = Math.floor(lo.x / 0.1); x <= Math.floor(hi.x / 0.1); x++)
      for (let y = Math.floor(lo.y / 0.1); y <= Math.floor(hi.y / 0.1); y++)
        for (let z = Math.floor(lo.z / 0.1); z <= Math.floor(hi.z / 0.1); z++) {
          for (const pt of this.m.get(`${x},${y},${z}`) ?? []) {
            if (skip(pt.kind)) continue;
            const u = l2 > 0 ? Math.min(1, Math.max(0, q.copy(pt.p).sub(a).dot(ab) / l2)) : 0;
            const d = c.r + pt.r - q.copy(a).addScaledVector(ab, u).distanceTo(pt.p);
            if (d > best.d) best = { d, kind: pt.kind };
          }
        }
    return best;
  }
}

/** points over a triangle soup, spaced ≤ H along both edges from its first corner */
function sampleMesh(mesh: THREE.Mesh, kind: string, into: Bins): void {
  const g = mesh.geometry as THREE.BufferGeometry;
  const pos = g.getAttribute('position');
  const idx = g.getIndex();
  const n = idx ? idx.count : pos.count;
  const A = new THREE.Vector3();
  const B = new THREE.Vector3();
  const C = new THREE.Vector3();
  for (let i = 0; i < n; i += 3) {
    const at = (j: number, v: P): P => v.fromBufferAttribute(pos, idx ? idx.getX(i + j) : i + j).applyMatrix4(mesh.matrixWorld);
    at(0, A);
    at(1, B);
    at(2, C);
    if (!near(A) && !near(B) && !near(C) && A.distanceTo(B) < 4.4 && A.distanceTo(C) < 4.4) continue;
    const n1 = Math.max(1, Math.ceil(A.distanceTo(B) / H));
    const n2 = Math.max(1, Math.ceil(A.distanceTo(C) / H));
    for (let s = 0; s <= n1; s++)
      for (let u = 0; u <= n2; u++) {
        if (s / n1 + u / n2 > 1 + 1e-9) continue;
        const p = A.clone().addScaledVector(B.clone().sub(A), s / n1).addScaledVector(C.clone().sub(A), u / n2);
        if (near(p)) into.add({ p, r: 0, kind });
      }
  }
}

/** each trim's cloth as surfaces (every belly, drawing or aback, at once): what a sight line through it hits */
const clothAt = new Map<number, THREE.Mesh[]>();
/** …and as points on its own (the 0.4 m margin's query: binned apart from the raft's thousands of other points) */
const canvasAt = new Map<number, Bins>();
/** the trims the show sails at, and the whole of what is solid at each */
const LEVELS = [0.01, 0.25, 0.5, 0.75, 1];
const DRIVES = [-1, -0.5, 0, 0.5, 1];
const world: Bins[] = LEVELS.map((set) => {
  trim(set);
  const bins = new Bins();
  // the hull, the cabin, the rig's spars at this hoist (not the sails' raw panels: their cloth is the evaluator's)
  asm.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const kind = kindAt(m);
    if (kind === 'sail' || kind === 'pennant') return;
    sampleMesh(m, kind, bins);
  });
  // the cloth, at every belly the wind could give it at this trim, drawing or aback
  for (const id of sailIds) {
    const def = blueprint.find((d) => d.id === id)!;
    const node = asm.group.getObjectByName(id)!;
    const width = def.aabb.max[0] - def.aabb.min[0];
    const drop = -def.aabb.min[1];
    const spars = resolveSailSpars(node, readSailSparSources(asm.sailMesh(id)));
    const leads = sheetLeadDirections(node.matrixWorld.elements, 0, 1, shipMaterialParams.sailSheetSpread, 1);
    const nu = Math.ceil(width / 0.035);
    const nv = Math.ceil(drop / 0.035);
    for (const drive of DRIVES) {
      const st = { drive, luff: 0, skew: 0, dropScale: Math.max(0.01, set), flutterPhase: 0, sheetLeadPort: leads.port, sheetLeadStarboard: leads.starboard, spars };
      const g = new THREE.PlaneGeometry(1, 1, 24, 24);
      const at = g.getAttribute('position');
      for (let i = 0; i < at.count; i++) {
        const u = at.getX(i) + 0.5;
        const v = at.getY(i) + 0.5;
        at.setXYZ(i, ...new THREE.Vector3(...sailClothPoint(u, v, width, drop, st, shipMaterialParams)).applyMatrix4(node.matrixWorld).toArray());
      }
      const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
      mesh.updateMatrixWorld(true);
      clothAt.set(set, [...(clothAt.get(set) ?? []), mesh]);
    }
    for (const drive of DRIVES)
      for (let i = 0; i <= nu; i++)
        for (let j = 0; j <= nv; j++) {
          const p = new THREE.Vector3(...sailClothPoint(i / nu, j / nv, width, drop, { drive, luff: 0, skew: 0, dropScale: Math.max(0.01, set), flutterPhase: 0, sheetLeadPort: leads.port, sheetLeadStarboard: leads.starboard, spars }, shipMaterialParams)).applyMatrix4(node.matrixWorld);
          if (near(p)) {
            bins.add({ p, r: 0, kind: 'sail' });
            if (!canvasAt.has(set)) canvasAt.set(set, new Bins());
            canvasAt.get(set)!.add({ p, r: 0, kind: 'sail' });
          }
        }
    // the roll lashed to the yard when it is furled (raft.ts FILM_FURL_PACK: ~0.2 m thick on the main)
    if (set < 0.2) {
      // (the yard's own spar: its node also carries the sail's raw panel, hanging the cloth's full drop below it)
      const yard = asm.group.getObjectByName(`${def.parent!}-mesh`)!;
      const box = new THREE.Box3().setFromObject(yard);
      const mid = box.getCenter(new THREE.Vector3());
      for (let x = box.min.x; x <= box.max.x; x += H) {
        const pt = { p: new THREE.Vector3(x, mid.y, mid.z), r: 0.22, kind: 'furl' };
        bins.add(pt);
        if (!canvasAt.has(set)) canvasAt.set(set, new Bins());
        canvasAt.get(set)!.add(pt);
      }
    }
  }
  // the ropes, laid for this trim (raftRigLines.ts)
  rig.update(1 - set);
  const ropes = rig.mesh.geometry.getAttribute('position');
  const ring = 5;
  for (let i = 0; i + ring < ropes.count; i += ring) {
    if ((i / ring + 1) % 15 === 0) continue; // (the last ring of a rope: the next is another rope)
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (let k = 0; k < ring; k++) {
      a.add(new THREE.Vector3().fromBufferAttribute(ropes, i + k).divideScalar(ring));
      b.add(new THREE.Vector3().fromBufferAttribute(ropes, i + ring + k).divideScalar(ring));
    }
    const steps = Math.max(1, Math.ceil(a.distanceTo(b) / H));
    for (let s = 0; s <= steps; s++) {
      const p = a.clone().lerp(b, s / steps);
      if (near(p)) bins.add({ p, r: 0.012, kind: 'rope' });
    }
  }
  return bins;
});

/** THE CASE aboard (hardCase.ts: 0.55 × 0.22 × 0.40 m about its centre; props.ts: at its rest from the landing on, turned
 * onto the throw's heading), as points on its faces — the one at the radio has his hand on its dial, nobody's knee or hat
 * is in it */
const caseBins = (() => {
  const bins = new Bins();
  const th = flipThrow();
  // (its yaw in the raft's frame: the throw's heading, props.ts, less the raft's in c3's pose)
  const yaw = -Math.atan2(th.dir[0], th.dir[1]) - C3_RAFT.heading * D - Math.PI;
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const c = new THREE.Vector3(rest[0], caseY, rest[1]);
  const half = [0.275, 0.11, 0.2];
  for (let x = -half[0]; x <= half[0] + 1e-9; x += H)
    for (let y = -half[1]; y <= half[1] + 1e-9; y += H)
      for (let z = -half[2]; z <= half[2] + 1e-9; z += H) {
        const onFace = [Math.abs(x) > half[0] - H, Math.abs(y) > half[1] - H, Math.abs(z) > half[2] - H].some(Boolean);
        if (onFace) bins.add({ p: new THREE.Vector3(x, y, z).applyQuaternion(q).add(c), r: 0, kind: 'case' });
      }
  return bins;
})();

/** THE SHOW'S EYE against the raft (raft-local), as it is at sea time t: */
type Pose = { bearing: number; distance: number; heading: number; height: number };
const P: Pose[] = [
  { bearing: 24, distance: 15, heading: 0, height: 2.6 },
  { bearing: 10, distance: 10, heading: 70, height: 2.3 },
  { bearing: 12, distance: 12, heading: 70, height: 2.2 },
  { bearing: 12, distance: 12, heading: 30, height: 2.2 },
];
// (the eye's pose against the raft through the show, as beats.ts keys it: c2's under sail, eased to c3's by 14 s in,
// c4's by 4 s, held to the answer, the bow swung 40° toward the lamp by 46 s, back under sail in w1 by 24 s)
const EYE_KEYS: Array<[number, Pose]> = [
  [starts.c3, P[0]],
  [starts.c3 + 14, P[1]],
  [starts.c4, P[1]],
  [starts.c4 + 4, P[2]],
  [starts.c4 + ANSWER_AT, P[2]],
  [starts.c4 + 46, P[3]],
  [starts.w1 + 6, P[3]],
  [starts.w1 + 24, P[0]],
];
const poseAt = (t: number): Pose => {
  if (t <= EYE_KEYS[0][0]) return EYE_KEYS[0][1];
  for (let i = 0; i + 1 < EYE_KEYS.length; i++) {
    const [t0, a] = EYE_KEYS[i];
    const [t1, b] = EYE_KEYS[i + 1];
    if (t > t1) continue;
    const u = smooth((t - t0) / Math.max(1e-6, t1 - t0));
    return { bearing: a.bearing + (b.bearing - a.bearing) * u, distance: a.distance + (b.distance - a.distance) * u, heading: a.heading + (b.heading - a.heading) * u, height: a.height + (b.height - a.height) * u };
  }
  return EYE_KEYS[EYE_KEYS.length - 1][1];
};
const eyeOf = (p: Pose): THREE.Vector3 => {
  // (dolphin.ts caseOnDeck's frame: the eye from the raft, raft-local)
  const rel = [-Math.sin(p.bearing * D) * p.distance, -Math.cos(p.bearing * D) * p.distance];
  const side = [-Math.cos(p.heading * D), -Math.sin(p.heading * D)];
  const bow = [-Math.sin(p.heading * D), Math.cos(p.heading * D)];
  return new THREE.Vector3(rel[0] * side[0] + rel[1] * side[1], p.height, rel[0] * bow[0] + rel[1] * bow[1]);
};

/** the show from Act 2's landing to the crew's last frame aboard (props.ts: until w3 + 25 s), every 0.25 s */
const TIMES: number[] = [];
for (let t = FOLLOW - 20; t < starts.w3 + 25; t += 0.25) TIMES.push(t);

describe('nobody aboard passes through the raft, its sails or each other', () => {
  for (const operator of [false, true]) {
    it(`over the whole show${operator ? ' (radioOperator)' : ''}`, () => {
      // (each clash once: who, which part, into what — its deepest, and the span of show it lasts, s from c3)
      const hits = new Map<string, { d: number; from: number; to: number }>();
      const hit = (key: string, d: number, t: number): void => {
        const h = hits.get(key);
        const at = t - starts.c3;
        if (!h) hits.set(key, { d, from: at, to: at });
        else {
          h.d = Math.max(h.d, d);
          h.to = at;
        }
      };
      for (const t of TIMES) {
        const set = sailsOf(t);
        // (the two trims either side of this one: the cloth moves continuously between them)
        const lo = LEVELS.filter((l) => l <= set + 1e-9).pop() ?? LEVELS[0];
        const hi = LEVELS.find((l) => l >= set - 1e-9) ?? 1;
        const levels = [...new Set([lo, hi])];
        const solid = levels.map((l) => world[LEVELS.indexOf(l)]);
        const figs = crewNow(worldAt(t, operator)).filter((c) => c.visible);
        const caps = figs.map(capsules);
        figs.forEach((f, i) => {
          for (const c of caps[i]) {
            const resting = /^(foot|seat)/.test(c.part) || (c.part.startsWith('shin') && /kneel/.test(f.act.a + f.act.b));
            const holding = /^hand/.test(c.part) && f.role === 'helm';
            const skip = (kind: string): boolean => (resting && UNDERFOOT.has(kind)) || (holding && kind === 'steering-oar');
            for (const s of solid) {
              const d = s.deepest(c, skip);
              if (d.d > TOL) hit(`${f.role} ${c.part} into ${d.kind}`, d.d, t);
            }
            // SEATED, A CLEAR 0.4 m FROM THE CANVAS (the coordinator's note of the review: the sail "in front of their
            // face"), at every trim and belly of the moment
            const seated = (['hug', 'edge', 'sill', 'kneel', 'kneelAt', 'kneelUp'].includes(f.act.a) && f.act.w < 0.5) || ['kneel', 'kneelAt', 'kneelUp'].includes(f.act.b);
            if (seated)
              for (const l of levels) {
                const d = canvasAt.get(l)?.deepest({ ...c, r: c.r + 0.4 }, () => false) ?? { d: -Infinity, kind: '' };
                if (d.d > 0) hit(`${f.role} ${c.part} within 0.4 m of the ${d.kind}`, d.d, t);
              }
            // the case, once it is down (the right hand and forearm on its dial are where they should be)
            if (t - starts.c3 > FLIP_RELEASE + 1.2 && !/-r$/.test(c.part.replace(/^(upper|thigh|shin|foot)-r$/, 'x'))) {
              const d = caseBins.deepest(c, () => false);
              if (d.d > TOL) hit(`${f.role} ${c.part} into the case`, d.d, t);
            }
            // each other
            caps.forEach((other, j) => {
              if (j === i) return;
              for (const o of other) {
                const d = c.r + o.r - segDist(c, o);
                if (d > TOL) hit(`${f.role} ${c.part} into ${figs[j].role} ${o.part}`, d, t);
              }
            });
          }
        });
      }
      const list = [...hits].map(([k, h]) => `${k}: ${(h.d * 100).toFixed(1)} cm, c3 ${h.from.toFixed(1)} … ${h.to.toFixed(1)} s`);
      expect(list).toEqual([]);
    }, 120_000);
  }
});

/** the least distance between two capsules' axes */
function segDist(a: CrewCapsule, b: CrewCapsule): number {
  const p1 = new THREE.Vector3(...a.a);
  const q1 = new THREE.Vector3(...a.b);
  const p2 = new THREE.Vector3(...b.a);
  const q2 = new THREE.Vector3(...b.b);
  const d1 = q1.clone().sub(p1);
  const d2 = q2.clone().sub(p2);
  const r = p1.clone().sub(p2);
  const A = d1.dot(d1);
  const E = d2.dot(d2);
  const F = d2.dot(r);
  let s = 0;
  let u = 0;
  if (A < 1e-12 && E < 1e-12) return p1.distanceTo(p2);
  if (A < 1e-12) u = Math.min(1, Math.max(0, F / E));
  else {
    const C = d1.dot(r);
    if (E < 1e-12) s = Math.min(1, Math.max(0, -C / A));
    else {
      const B = d1.dot(d2);
      const den = A * E - B * B;
      s = den > 1e-12 ? Math.min(1, Math.max(0, (B * F - C * E) / den)) : 0;
      u = (B * s + F) / E;
      if (u < 0) {
        u = 0;
        s = Math.min(1, Math.max(0, -C / A));
      } else if (u > 1) {
        u = 1;
        s = Math.min(1, Math.max(0, (B - C) / A));
      }
    }
  }
  return p1.addScaledVector(d1, s).distanceTo(p2.addScaledVector(d2, u));
}

describe('they sit and stand on something, and hold what they hold', () => {
  it('a seat rests on the deck under it: neither sunk into it nor floating over it', () => {
    for (const t of TIMES.filter((_, i) => i % 8 === 0)) {
      for (const f of crewNow(worldAt(t, false))) {
        const seated = ['hug', 'edge', 'sill'].includes(f.act.a) && f.act.w < 0.05;
        if (!seated) continue;
        const who = CREW[ABOARD[f.role as 'helm' | 'door' | 'edge']];
        const k = solveCrew(f.act).k;
        // the seat's underside (crew.ts: the shorts' 0.16 m ball, squashed to 0.62 of it) over the root, m
        const under = (k.pelvis[1] - 0.16 * 0.62) * (who.height / 1.75);
        expect(Math.abs(under), `${f.role} at ${t}: the seat's underside ${under.toFixed(3)} m off the deck`).toBeLessThan(0.04);
      }
    }
  });

  it('the helm has his hand on the oar\'s loom, not in the air beside it', () => {
    for (const t of TIMES.filter((_, i) => i % 8 === 0)) {
      const f = crewNow(worldAt(t, false))[0];
      const who = CREW[ABOARD.helm];
      const k = solveCrew(f.act).k;
      const m = new THREE.Matrix4().compose(new THREE.Vector3(...f.root), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), f.rot), new THREE.Vector3().setScalar(who.height / 1.75));
      const w = new THREE.Vector3(...k.wrist[0]).applyMatrix4(m);
      expect(w.distanceTo(new THREE.Vector3(...LOOM)), `at ${t}`).toBeLessThan(0.03);
    }
  });
});

/** where a figure's face points (raft frame, unit) */
function facing(f: CrewNow): THREE.Vector3 {
  const who = CREW[f.role === 'kneeler' ? ABOARD.helm : ABOARD[f.role]];
  const s = solveCrew(f.act);
  const { k } = s;
  const head = new THREE.Vector3(...k.head).sub(new THREE.Vector3(...k.neck));
  // (the face's way: the head's −z, from the head's frame)
  const up = new THREE.Vector3(...k.neck).sub(new THREE.Vector3(...k.pelvis)).normalize();
  const right = new THREE.Vector3(...k.shoulder[0]).sub(new THREE.Vector3(...k.shoulder[1]));
  right.addScaledVector(up, -right.dot(up)).normalize();
  const back = new THREE.Vector3().crossVectors(right, up);
  const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, back));
  q.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(s.pitch, s.yaw, 0, 'YXZ')));
  void head;
  void who;
  return new THREE.Vector3(0, 0, -1).applyQuaternion(q).applyAxisAngle(new THREE.Vector3(0, 1, 0), f.rot);
}
const bearingTo = (f: CrewNow, p: V): number => {
  const d = new THREE.Vector3(p[0] - f.root[0], 0, p[2] - f.root[2]).normalize();
  const fa = facing(f).setY(0).normalize();
  return Math.acos(Math.min(1, fa.dot(d))) / D;
};

describe('they react to what happens (each a pure function of t)', () => {
  it('the dolphin: soon after its first leap every head is turned to it, and the door has gone forward and points', () => {
    const t = starts.c3 + 12;
    const w = worldAt(t, false);
    for (const f of crewNow(w).filter((c) => c.visible)) expect(bearingTo(f, w.dolphin!), f.role).toBeLessThan(35);
    const door = crewNow(w)[1];
    expect(door.act.w, 'the door is on his feet').toBeGreaterThan(0.99);
    expect(door.root[2], 'forward along the strip').toBeGreaterThan(spots.fore[2] - 0.05);
    expect(door.act.pointW, 'and points').toBeGreaterThan(0.9);
    // (and back on his step by the night)
    expect(crewNow(worldAt(starts.c4, false))[1].act.w).toBe(0);
  });

  it('the answer: every head comes round to the lamp, and the one at the radio (radioOperator) straightens up off it', () => {
    const t = starts.c4 + ANSWER_AT + 4;
    const w = worldAt(t, false);
    for (const f of crewNow(w).filter((c) => c.visible)) expect(bearingTo(f, w.lamp!), f.role).toBeLessThan(40);
    const kneeler = (at: number): CrewNow => crewNow(worldAt(at, true))[3];
    expect(kneeler(t).act.w).toBeGreaterThan(0.99);
    expect(kneeler(starts.c4 + ANSWER_AT - 2).act.w).toBe(0);
  });

  it('the land: at dawn the door stands up outside the hut, looking at it', () => {
    const w = worldAt(starts.w1 + 35, false);
    const door = crewNow(w)[1];
    expect(door.act.w).toBeGreaterThan(0.99);
    expect(bearingTo(door, w.land!)).toBeLessThan(35);
  });

  it('nothing jumps: no joint moves more than 0.25 m between two frames 1/30 s apart, all show long', () => {
    let worst = { d: 0, at: '' };
    for (let t = FOLLOW - 20; t < starts.w3 + 25; t += 1 / 30) {
      const a = crewNow(worldAt(t, false)).map(capsules);
      const b = crewNow(worldAt(t + 1 / 30, false)).map(capsules);
      a.forEach((fa, i) =>
        fa.forEach((c, j) => {
          const d = Math.hypot(c.a[0] - b[i][j].a[0], c.a[1] - b[i][j].a[1], c.a[2] - b[i][j].a[2]);
          if (d > worst.d) worst = { d, at: `${i} ${c.part} at c3 + ${(t - starts.c3).toFixed(2)}` };
        }),
      );
    }
    // (a fast pointing arm moves ~2 m/s at the hand: 7 cm a frame)
    expect(worst.d, worst.at).toBeLessThan(0.25);
  });
});

/**
 * NO LANTERN OVER A FACE, from where the audience sits (the coordinator's note above): from the show's eye as it is at
 * each instant — under sail (beats.ts SAILING: c2, w1), still and close as the dolphin comes (dolphin.ts C3_RAFT), back
 * a little for c4's night (12 m, 12°), its bow swinging 40° toward the answer, and eased between — no head is drawn
 * behind or in front of a lantern: the two kept apart by their own sizes and 0.15 m more, as seen, in either mode.
 */
describe('no lantern hangs in front of a face', () => {
  it('from the show eye in c2, c3, c4 and w1', () => {
    const bad: string[] = [];
    const sight = new THREE.Raycaster();
    const hidden = new Map<string, boolean>();
    trim(0.01);
    for (const t of TIMES) {
      for (const f of [false, true].flatMap((op) => crewNow(worldAt(t, op)).filter((c) => c.visible))) {
        const head = capsules(f).find((c) => c.part === 'head')!;
        const h = new THREE.Vector3(...head.a);
        for (const p of [poseAt(t)]) {
          const eye = eyeOf(p);
          for (const l of lanternAt) {
            // (a lantern the cabin hides from the eye is not drawn over a face: asked once per eye and lantern)
            const key = `${eye.toArray().map((v) => v.toFixed(2)).join()}|${l.x},${l.z}`;
            let seen = hidden.get(key);
            if (seen === undefined) {
              const dl0 = l.clone().sub(eye);
              sight.set(eye, dl0.clone().normalize());
              sight.far = dl0.length() - 0.2;
              seen = !sight.intersectObject(asm.group, true).some((x) => kindAt(x.object) !== 'lantern');
              hidden.set(key, seen);
            }
            if (!seen) continue;
            const dh = h.clone().sub(eye);
            const dl = l.clone().sub(eye);
            const apart = dh.angleTo(dl);
            const need = Math.atan((0.12 + 0.15) / dh.length()) + Math.atan(0.12 / dl.length());
            if (apart < need) bad.push(`${f.role} at c3 ${(t - starts.c3).toFixed(1)} s, eye ${p.bearing.toFixed(0)}° ${p.distance.toFixed(0)} m: ${(apart / D).toFixed(1)}° from the lantern at (${l.x.toFixed(2)}, ${l.z.toFixed(2)}), the head at (${h.toArray().map((v) => v.toFixed(2)).join(', ')})`);
          }
        }
      }
    }
    const by = new Map<string, number>();
    for (const b of bad) by.set(b.split(' ')[0], (by.get(b.split(' ')[0]) ?? 0) + 1);
    expect(bad.slice(0, 8), `${bad.length} views: ${JSON.stringify([...by])}`).toEqual([]);
  });
});

/**
 * NO CANVAS IN FRONT OF A FACE (the coordinator's note of the review: "we have the person again sitting inside of the
 * front sail, or super close in front of it, with the sail in front of their face"): from the show's eye as it is at each
 * instant (EYE_KEYS), the line to every head misses the sails' cloth — at the trim of the moment, at every belly the
 * wind could give it. (Not the radioOperator kneeler: it kneels at the case on the fore-deck from c1, behind the sail
 * from c2's eye until c4 strikes it — crewLife.ts.)
 */
describe('no sail in front of a face', () => {
  it('from the show eye, every head is in sight of it past the canvas', () => {
    const bad: string[] = [];
    const ray = new THREE.Raycaster();
    for (const t of TIMES.filter((_, i) => i % 2 === 0)) {
      const set = sailsOf(t);
      const lo = LEVELS.filter((l) => l <= set + 1e-9).pop() ?? LEVELS[0];
      const hi = LEVELS.find((l) => l >= set - 1e-9) ?? 1;
      const cloth = [...new Set([lo, hi])].flatMap((l) => clothAt.get(l)!);
      const eye = eyeOf(poseAt(t));
      for (const f of crewNow(worldAt(t, false)).filter((c) => c.visible && c.role !== 'kneeler')) {
        const head = new THREE.Vector3(...capsules(f).find((c) => c.part === 'head')!.a);
        const d = head.clone().sub(eye);
        ray.set(eye, d.clone().normalize());
        ray.far = d.length() - 0.15;
        const hits = ray.intersectObjects(cloth, false);
        if (hits.length) bad.push(`${f.role} at c3 ${(t - starts.c3).toFixed(1)} s: behind the sail ${(d.length() - hits[0].distance).toFixed(2)} m`);
      }
    }
    expect(bad.slice(0, 8), `${bad.length} views`).toEqual([]);
  });
});
