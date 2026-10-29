/**
 * THE FILM RAFT, DRESSED for a camera at 5–15 m (the user, 2026-10-29: "everything except the large tree trunks
 * on the bottom … looks laser-cut, made out of styrofoam … everything is too perfect"; and, of the first pass:
 * the cabin's inside "a massive box with laser-sharp edges"). On the game's assembly, after it is built
 * (raft.ts), for the hero raft only — a far raft is a few pixels and keeps the greybox:
 *
 *   WEAR: every slab the frame comes close to (the cabin's walls, its thatch — thinned to a ragged reed fringe
 *     at its free edges — and the laths under it, the deck mats, the boards, the mattresses and floor mats)
 *     swapped for its worn twin: rounded edges, bowed, sagging, a little askew (src/ship/pieceGeometryWear.ts,
 *     the game's opt-in pass; the game itself never asks for it).
 *   THE CABIN'S FRAME, rough poles in the bipod's own wood (the balsa family, its grain up the pole), lashed
 *     with hemp: outside, a post at each corner, a plate along each eave, posts on the wall mats' seams (each
 *     side wall is three mats, raftLook.ts) and either side of the doorway, a king post on each gable; inside —
 *     what is seen through the door — a ridge pole, a tie beam across mid-cabin, rafters under the laths, the
 *     king posts carrying the ridge.
 *   THE INSIDE ([§3 Floor / Radio corner / Museum], docs/raft2100/kon-tiki-reference.md): the mattresses
 *     stuffed and slumped with a rolled blanket at each head, the radio's crate a plank box, its battery cases
 *     softened, a plank shelf on the aft gable, a canvas bundle hung from a rafter; the stores themselves
 *     (pots, bowl, jug, ladle, the hung basket) are raftProps.ts's.
 *   THE PORT STRIP: a bamboo deck mat along the port wall, as the starboard one — the port stores stood on the
 *     crossbeams' tops, and between two crossbeams there was nothing under them.
 *   THE RAILINGS: the rope made fast over each post's head and sagging between (pieceGeometryWear.ropeRailParts),
 *     the posts drawn in wood.
 *   THE STORES: real props for the game's boxes (raftProps.ts), each seated on what is under it.
 */
import * as THREE from 'three/webgpu';
import { float, mix, normalLocal, positionLocal, smoothstep, vec3 } from 'three/tsl';
import type { PieceDef } from './pieceTypes';
import type { MaterialFactory } from './shipAssembly';
import { ropeRailParts, softBox, wornPieceGeometry } from './pieceGeometryWear';
import { raftLayout } from './raftPartsLayout';
import { roofSlope } from './raftPartsCabin';
import { raftParams } from '../params/raft';
import { vhash } from './variation';
import { triplanarFbm } from '../terrain/noise';
import { createRaftProps } from './raftStores';
import type { RaftLookTier } from './raftLook';

/** a rough pole along local y from y0 to y1: tapered, a little crooked, its section not quite round */
function pole(r0: number, r1: number, y0: number, y1: number, seed: number): THREE.BufferGeometry {
  const len = y1 - y0;
  const rings = Math.max(4, Math.round(len / 0.12));
  const g = new THREE.CylinderGeometry(r1, r0, len, 10, rings, false);
  g.translate(0, y0 + len / 2, 0);
  const p = g.attributes.position;
  const bendX = (vhash(seed, 1) * 2 - 1) * 0.02;
  const bendZ = (vhash(seed, 2) * 2 - 1) * 0.02;
  for (let i = 0; i < p.count; i++) {
    const t = (p.getY(i) - y0) / len;
    const a = Math.atan2(p.getZ(i), p.getX(i));
    // a bow over its length, and a knobbly section (two lobes, turning along it)
    const bow = Math.sin(Math.PI * t);
    const lobe = 1 + 0.08 * Math.sin(2 * a + t * 3 + seed) + 0.04 * Math.sin(5 * a + seed * 1.7);
    p.setXYZ(i, p.getX(i) * lobe + bendX * bow, p.getY(i), p.getZ(i) * lobe + bendZ * bow);
  }
  g.computeVertexNormals();
  return g;
}

/** a few turns of hemp round a pole of radius r at height y (local), as tori stacked */
function lashing(r: number, y: number, turns: number, rope: number): THREE.BufferGeometry {
  const pos: number[] = [];
  for (let k = 0; k < turns; k++) {
    const t = new THREE.TorusGeometry(r + rope * 0.6, rope, 5, 14);
    t.rotateX(Math.PI / 2);
    t.rotateZ((k % 2 ? 1 : -1) * 0.12);
    t.translate(0, y + (k - (turns - 1) / 2) * rope * 1.7, 0);
    pos.push(...((t.index ? t.toNonIndexed() : t).attributes.position.array as Float32Array));
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.computeVertexNormals();
  return out;
}

/** cloth: a wool blanket's broad stripes, or plain canvas, with a weave's grain and a sheen (rolled, bundled) */
function clothMaterial(a: number, b: number, stripes: boolean): THREE.MeshPhysicalNodeMaterial {
  const m = new THREE.MeshPhysicalNodeMaterial({ metalness: 0 });
  m.name = stripes ? 'drift-raft-blanket' : 'drift-raft-canvas';
  const p = positionLocal;
  const grain = triplanarFbm(p.mul(60), normalLocal, float(6), 2);
  const blot = triplanarFbm(p.mul(4), normalLocal, float(6), 3);
  const band = stripes ? smoothstep(0.45, 0.55, p.x.mul(9).fract().sub(0.5).abs().mul(2)) : float(0);
  const ca = new THREE.Color(a);
  const cb = new THREE.Color(b);
  m.colorNode = mix(vec3(ca.r, ca.g, ca.b), vec3(cb.r, cb.g, cb.b), band).mul(mix(float(0.82), float(1.08), grain)).mul(mix(float(0.85), float(1.05), blot));
  m.roughnessNode = float(0.85).add(grain.mul(0.1));
  m.sheenNode = vec3(0.25, 0.22, 0.18);
  m.sheenRoughnessNode = float(0.5);
  return m;
}

export interface FilmRaftDress {
  readonly ready: Promise<void>;
}

/**
 * Dress `ship` (the assembly's group: the raft's own frame, its pieces named by their ids, meshes `${id}-mesh`)
 * built from `blueprint`, drawing new parts through `materials` (the raft's own factory: one material a kind).
 */
/** × the worn geometry's resolution per tier (raftLook.RaftLookTier): the same shapes, fewer vertices */
const CELL_SCALE: Record<RaftLookTier, number> = { film: 1, high: 1, medium: 1.4, low: 2 };

export function dressRaft(ship: THREE.Object3D, blueprint: PieceDef[], materials: MaterialFactory, o: { tier?: RaftLookTier } = {}): FilmRaftDress {
  const wear = { cellScale: CELL_SCALE[o.tier ?? 'medium'] };
  const byId = new Map(blueprint.map((d) => [d.id, d]));
  const p = raftParams;
  const L = raftLayout(p);
  const wood = materials('bipod-mast', 'base');
  const hemp = materials('lashing', 'base');
  const planks = materials('splashboard', 'base');

  // WEAR
  for (const def of blueprint) {
    const mesh = ship.getObjectByName(`${def.id}-mesh`) as THREE.Mesh | undefined;
    if (!mesh?.isMesh) continue;
    const parent = def.parent !== undefined ? byId.get(def.parent) : undefined;
    const worn = wornPieceGeometry(def, mesh.geometry, wear, parent?.kind === 'thatch-roof' ? parent : undefined);
    if (worn === null) continue;
    mesh.geometry.dispose();
    mesh.geometry = worn;
  }

  const frame = new THREE.Group();
  frame.name = 'drift-cabin-frame';
  /** a part as the assembly hangs one: a node at its place, the mesh at the node's origin (the materials read
   * the node's position and the mesh's name and bounds, raftMaterialNodes.ts) */
  const part = (id: string, geo: THREE.BufferGeometry, mat: THREE.Material, at: THREE.Vector3, q?: THREE.Quaternion, parent: THREE.Object3D = frame): THREE.Mesh => {
    const node = new THREE.Group();
    node.name = id;
    node.position.copy(at);
    if (q) node.quaternion.copy(q);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `${id}-mesh`;
    // (cords and lashings a centimetre thick cast nothing a shadow map resolves: they stay out of its passes)
    mesh.castShadow = mat !== hemp;
    mesh.receiveShadow = true;
    node.add(mesh);
    parent.add(node);
    return mesh;
  };
  /** a rough pole from a to b (raft-local), its grain along it */
  const poleAB = (id: string, a: THREE.Vector3, b: THREE.Vector3, r: number, seed: number, parent: THREE.Object3D = frame): void => {
    const d = new THREE.Vector3().subVectors(b, a);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
    part(id, pole(r * 1.08, r * 0.92, 0, d.length(), seed), wood, a, q, parent);
  };
  /** a cord from a to b (raft-local), in hemp */
  const cordAB = (id: string, a: THREE.Vector3, b: THREE.Vector3, r: number): void => {
    const d = new THREE.Vector3().subVectors(b, a);
    const g = new THREE.CylinderGeometry(r, r, d.length(), 6, 1).translate(0, d.length() / 2, 0);
    part(id, g, hemp, a, new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  };
  const lashAt = (id: string, at: THREE.Vector3, r: number, turns = 4): void => {
    part(id, lashing(r, 0, turns, 0.009), hemp, at);
  };

  // THE PORT STRIP: the starboard strip's twin (raftPartsHull's deck-starboard), worn as the mats are
  const stbd = byId.get('deck-starboard');
  if (stbd) {
    const portMat: PieceDef = { ...stbd, id: 'deck-port', transform: { ...stbd.transform, position: [-stbd.transform.position[0], stbd.transform.position[1], stbd.transform.position[2]] } };
    const base = softBox(stbd.aabb.min[0], stbd.aabb.max[0], stbd.aabb.min[1], stbd.aabb.max[1], stbd.aabb.min[2], stbd.aabb.max[2], 0.004, 0.3);
    part('deck-port', wornPieceGeometry(portMat, base, wear) ?? base, materials('bamboo-deck', 'base'), new THREE.Vector3(...portMat.transform.position), undefined, ship);
  }

  // THE RAILINGS: rope made fast over each post's head; the posts in wood
  for (const id of ['rail-port', 'rail-starboard']) {
    const def = byId.get(id);
    const mesh = ship.getObjectByName(`${id}-mesh`) as THREE.Mesh | undefined;
    const parts = def ? ropeRailParts(def) : null;
    if (!def || !mesh || !parts) continue;
    mesh.geometry.dispose();
    mesh.geometry = parts.rope;
    parts.posts.forEach((post, k) => poleAB(`${id}-post-${k}`, post.foot, post.head, post.r * 0.95, 300 + k * 7 + (id === 'rail-port' ? 0 : 50), mesh.parent!));
  }

  // THE CABIN'S FRAME — outside
  const hw = p.cabinWidth / 2;
  const t = p.cabinWallThickness;
  const z0 = L.cabinAftZ;
  const z1 = L.cabinFrontZ;
  const eaveY = L.cabinFloorY + p.cabinEave;
  const ridgeY = L.cabinFloorY + p.cabinRidge;
  const base = L.crossbeamTopY;
  const postTop = eaveY - 0.01;
  const plateR = 0.034;
  const corners: Array<[number, number]> = [[-hw, z0], [hw, z0], [-hw, z1], [hw, z1]];
  corners.forEach(([x, z], i) => {
    const seed = 71 + i * 13;
    poleAB(`cabin-post-${i}`, new THREE.Vector3(x, base, z), new THREE.Vector3(x, postTop, z), 0.046, seed);
    lashAt(`cabin-post-${i}-lash-head`, new THREE.Vector3(x, postTop - plateR * 1.2, z), 0.046);
    lashAt(`cabin-post-${i}-lash-foot`, new THREE.Vector3(x, base + 0.06, z), 0.05, 3);
  });
  for (const [i, sign] of [[0, -1], [1, 1]] as const) {
    poleAB(`cabin-plate-${i}`, new THREE.Vector3(sign * (hw + plateR * 0.4), eaveY - plateR * 0.2, z0 - 0.18), new THREE.Vector3(sign * (hw + plateR * 0.4), eaveY - plateR * 0.2, z1 + 0.16), plateR, 91 + i);
  }
  // the mats' seams (a third and two thirds along each side wall: raftLook.ts cuts its panels there) and the
  // doorway's jambs, outside; the doorway itself has no seam post
  const third = p.cabinLength / 3;
  const doorZ0 = z0 + p.cabinOpeningAftOffset;
  const doorZ1 = doorZ0 + p.cabinOpeningLength;
  const sidePosts: Array<[number, number]> = [];
  for (const sign of [-1, 1]) {
    for (const z of [z0 + third, z0 + 2 * third]) {
      if (sign > 0 && z > doorZ0 - 0.05 && z < doorZ1 + 0.05) continue;
      sidePosts.push([sign, z]);
    }
  }
  sidePosts.push([1, doorZ0 - 0.035], [1, doorZ1 + 0.035]);
  sidePosts.forEach(([sign, z], i) => {
    const x = sign * (hw + 0.04);
    poleAB(`cabin-stud-${i}`, new THREE.Vector3(x, base, z), new THREE.Vector3(x, postTop - 0.02, z), 0.038, 131 + i * 5);
    lashAt(`cabin-stud-${i}-lash`, new THREE.Vector3(x, postTop - 0.06, z), 0.038, 3);
  });
  // a king post up each gable's middle to the ridge, outside
  for (const [i, z] of [[0, z0 - 0.04], [1, z1 + 0.04]] as const) {
    poleAB(`cabin-king-out-${i}`, new THREE.Vector3(0, base, z), new THREE.Vector3(0, ridgeY - 0.04, z), 0.04, 151 + i);
  }

  // THE CABIN'S FRAME — inside: what the eye sees through the door
  const slope = roofSlope(p);
  const lath = p.roofLathSection;
  // the roof's underside over raft-local x (the laths' bottoms), lowered by the sag the worn thatch takes at z
  // (pieceGeometryWear.roofSag: ~4 cm mid-span between the gables, a little more toward the eave)
  const halfZ = p.cabinLength / 2 + p.roofOverhang;
  const midZ = (z0 + z1) / 2;
  const under = (x: number, z: number): number => {
    const along = Math.min(1, Math.abs(z - midZ) / halfZ);
    const down = Math.min(1, Math.abs(x) / (hw + p.roofOverhang));
    return ridgeY - Math.abs(x) * Math.tan(slope) - lath - 0.04 * (1 - along * along) * (0.6 + 0.4 * down);
  };
  const ridgeR = 0.05;
  poleAB('cabin-ridge', new THREE.Vector3(0, under(0, z0) - ridgeR - 0.03, z0 + 0.02), new THREE.Vector3(0, under(0, z1) - ridgeR - 0.03, z1 - 0.02), ridgeR, 171);
  const rafterR = 0.036;
  [z0 + 0.55, midZ + 0.35, z1 - 0.55].forEach((z, i) => {
    for (const sign of [-1, 1]) {
      const a = new THREE.Vector3(0, under(0, z) - rafterR, z);
      const b = new THREE.Vector3(sign * (hw - t), under(sign * (hw - t), z) - rafterR, z);
      poleAB(`cabin-rafter-${i}-${sign > 0 ? 's' : 'p'}`, a, b, rafterR, 181 + i * 3 + sign);
    }
  });
  const tieY = eaveY - 0.06;
  poleAB('cabin-tie', new THREE.Vector3(-hw + t * 0.5, tieY, midZ), new THREE.Vector3(hw - t * 0.5, tieY, midZ), 0.042, 191);
  lashAt('cabin-tie-lash-p', new THREE.Vector3(-hw + 0.12, tieY, midZ), 0.042, 3);
  lashAt('cabin-tie-lash-s', new THREE.Vector3(hw - 0.12, tieY, midZ), 0.042, 3);
  for (const [i, z] of [[0, z0 + t + 0.05], [1, z1 - t - 0.05]] as const) {
    poleAB(`cabin-king-in-${i}`, new THREE.Vector3(0.0, L.cabinFloorY, z), new THREE.Vector3(0, under(0, z) - ridgeR * 2 - 0.03, z), 0.042, 201 + i);
  }
  // the frame's hemp in ONE draw (lashings, cords, ties: the rope material keys nothing on the piece, so its parts
  // merge freely — some thirty meshes, each a draw in every pass, were most of what the dressing added to a frame)
  {
    const pos: number[] = [];
    const nor: number[] = [];
    const drop: THREE.Object3D[] = [];
    frame.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(frame.matrixWorld).invert();
    const nm = new THREE.Matrix3();
    const v = new THREE.Vector3();
    frame.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || m.material !== hemp) return;
      const xf = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld);
      nm.getNormalMatrix(xf);
      const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry;
      if (!g.attributes.normal) g.computeVertexNormals();
      const gp = g.attributes.position;
      const gn = g.attributes.normal;
      for (let i = 0; i < gp.count; i++) {
        v.fromBufferAttribute(gp, i).applyMatrix4(xf);
        pos.push(v.x, v.y, v.z);
        v.fromBufferAttribute(gn, i).applyMatrix3(nm).normalize();
        nor.push(v.x, v.y, v.z);
      }
      drop.push(m.parent ?? m);
    });
    if (pos.length) {
      for (const d of drop) d.removeFromParent();
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      const merged = new THREE.Mesh(g, hemp);
      merged.name = 'cabin-frame-hemp-mesh';
      merged.receiveShadow = true;
      frame.add(merged);
    }
  }
  ship.add(frame);

  // THE INSIDE
  // the radio's crate a plank box (the boards' own material), its battery cases rounded
  const soften = (id: string, r: number, mat?: THREE.Material): void => {
    const def = byId.get(id);
    const mesh = ship.getObjectByName(`${id}-mesh`) as THREE.Mesh | undefined;
    if (!def || !mesh) return;
    const { min, max } = def.aabb;
    mesh.geometry.dispose();
    const g = softBox(min[0], max[0], min[1], max[1], min[2], max[2], r, 0.2);
    mesh.geometry = g;
    if (mat) mesh.material = mat;
  };
  soften('radio-crate', 0.012, planks);
  soften('battery-1', 0.014);
  soften('battery-2', 0.014);
  // the shelf on the aft gable, starboard of the king post: a plank on two pegs
  const shelfY = L.cabinFloorY + SHELF_UP;
  const zs = z0 + t;
  // (named off the cabin- prefix: the stores' rays land on it, raftProps.ts)
  part('shelf-aft', softBox(0.12, 1.06, -0.028, 0, 0, 0.25, 0.006, 0.2), planks, new THREE.Vector3(0, shelfY, zs));
  for (const x of [0.26, 0.92]) poleAB(`cabin-shelf-peg-${x}`, new THREE.Vector3(x, shelfY - 0.045, zs - 0.03), new THREE.Vector3(x, shelfY - 0.04, zs + 0.22), 0.016, 211);
  // a rolled blanket at the head of each mattress (the berths are the cabin floor's: found by their meshes)
  const blanket = clothMaterial(0x4a2a22, 0x7a6a52, true);
  const canvas = clothMaterial(0x7d725d, 0x7d725d, false);
  ship.updateMatrixWorld(true);
  for (const [id, end] of [['berth-port', 1], ['berth-starboard', 1]] as const) {
    const m = ship.getObjectByName(`${id}-mesh`) as THREE.Mesh | undefined;
    if (!m) continue;
    m.geometry.computeBoundingBox();
    const bb = m.geometry.boundingBox!;
    const at = new THREE.Vector3((bb.min.x + bb.max.x) / 2, bb.max.y + 0.06, end > 0 ? bb.max.z - 0.17 : bb.min.z + 0.17);
    m.localToWorld(at);
    ship.worldToLocal(at);
    const roll = new THREE.CylinderGeometry(0.075, 0.075, (bb.max.x - bb.min.x) * 0.8, 16, 4);
    roll.rotateZ(Math.PI / 2);
    roll.scale(1, 0.82, 1);
    part(`${id}-blanket`, roll, blanket, at, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, (vhash(7, id.length) - 0.5) * 0.25, 0)));
  }
  // a canvas bundle hung from the aft rafter, port side, on a cord, tied at its neck
  // (over the port berth's foot, by the wall: clear of the radio nook, where a player kneels, and the lane to it)
  const bundleAt = new THREE.Vector3(-0.85, 0, midZ + 0.75);
  const hangY = under(-0.55, bundleAt.z) - rafterR * 2;
  const sack = new THREE.SphereGeometry(0.14, 16, 12);
  {
    const sp = sack.attributes.position;
    for (let i = 0; i < sp.count; i++) {
      const x = sp.getX(i), y = sp.getY(i), z = sp.getZ(i);
      const lump = 1 + 0.12 * Math.sin(x * 31 + y * 17) * Math.sin(z * 23 + 1.3) - (y > 0.08 ? (y - 0.08) * 2.6 : 0);
      sp.setXYZ(i, x * lump, y * 1.15, z * lump);
    }
    sack.computeVertexNormals();
  }
  part('cabin-bundle', sack, canvas, new THREE.Vector3(bundleAt.x, hangY - 0.42, bundleAt.z));
  cordAB('cabin-bundle-cord', new THREE.Vector3(bundleAt.x, hangY - 0.42 + 0.16, bundleAt.z), new THREE.Vector3(bundleAt.x, hangY + 0.01, bundleAt.z), 0.005);
  part('cabin-bundle-tie', lashing(0.035, 0, 2, 0.008), hemp, new THREE.Vector3(bundleAt.x, hangY - 0.42 + 0.15, bundleAt.z));

  // THE MASTHEAD (the user, 2026-10-29: "the little pedestal at the top of the mast … is it like that in the
  // reference?" — it is not: the Kon-Tiki's bipod legs were crossed and lashed at the head, the yard hung from
  // there by its halyard). The game's lookout platform stays — the ladder climbs to it, a player stands on it
  // (player/stations.ts `station-lookout`) — but as what a perch at a lashed masthead is: a few canes across two
  // bearers, every crossing lashed, not a flat slab. Under the crossing's lashing hangs a block on a strop, the
  // halyard runs from it to the yard's slings, and the slings take the yard at two points either side of its
  // middle. The halyard is the one line whose length changes (the yard is lowered and hoisted): it is re-laid
  // from the block to the slings each time it is drawn.
  const perchDef = byId.get('lookout-platform');
  const perch = ship.getObjectByName('lookout-platform-mesh') as THREE.Mesh | undefined;
  if (perchDef && perch) {
    const { min, max } = perchDef.aabb;
    const canes: THREE.BufferGeometry[] = [];
    const n = 6;
    for (let i = 0; i < n; i++) {
      const z = min[2] + 0.04 + ((max[2] - min[2] - 0.08) * i) / (n - 1) + (vhash(241, i) - 0.5) * 0.02;
      const len = (max[0] - min[0]) * (0.92 + 0.16 * vhash(242, i));
      const c = new THREE.CylinderGeometry(0.026, 0.028, len, 8).rotateZ(Math.PI / 2 + (vhash(243, i) - 0.5) * 0.04);
      c.translate((vhash(244, i) - 0.5) * 0.05, max[1] - 0.027, z);
      canes.push(c.toNonIndexed());
    }
    for (const x of [min[0] + 0.07, max[0] - 0.07]) {
      const b2 = new THREE.CylinderGeometry(0.034, 0.036, max[2] - min[2] + 0.1, 8).rotateX(Math.PI / 2);
      b2.translate(x, max[1] - 0.055 - 0.034, 0);
      canes.push(b2.toNonIndexed());
    }
    const pos: number[] = [];
    for (const g of canes) pos.push(...(g.attributes.position.array as Float32Array));
    const perchGeo = new THREE.BufferGeometry();
    perchGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    perchGeo.computeVertexNormals();
    perch.geometry.dispose();
    perch.geometry = perchGeo;
    // the bearers lashed to the canes at their ends, and the whole lashed down to the crossing
    for (const x of [min[0] + 0.07, max[0] - 0.07]) {
      for (const z of [min[2] + 0.06, max[2] - 0.06]) {
        const ring = lashing(0.05, 0, 3, 0.008);
        part(`perch-lash-${x > 0 ? 's' : 'p'}${z > 0 ? 'f' : 'a'}`, ring, hemp, new THREE.Vector3(x, max[1] - 0.06, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 4, 0, 0)), perch.parent!);
      }
    }
  }
  const mastMain = ship.getObjectByName('mast-main');
  const yard = ship.getObjectByName('yard-main-lower');
  if (mastMain && yard) {
    const blockAt = new THREE.Vector3(0, 6.34, 0.0);
    part('masthead-block', softBox(-0.045, 0.045, -0.09, 0.09, -0.035, 0.035, 0.012, 1), wood, blockAt, undefined, mastMain);
    part('masthead-sheave', new THREE.CylinderGeometry(0.05, 0.05, 0.03, 12).rotateX(Math.PI / 2), wood, blockAt.clone().add(new THREE.Vector3(0, -0.02, 0)), undefined, mastMain);
    // the strop the block hangs by, up round the crossing
    cordAB('masthead-strop-a', blockAt.clone().add(new THREE.Vector3(-0.03, 0.08, 0)), new THREE.Vector3(-0.06, 6.5, 0.02), 0.008);
    cordAB('masthead-strop-b', blockAt.clone().add(new THREE.Vector3(0.03, 0.08, 0)), new THREE.Vector3(0.06, 6.5, 0.02), 0.008);
    // (the strop's cords are drawn in the raft's frame by cordAB: move them under the mast)
    for (const id of ['masthead-strop-a', 'masthead-strop-b']) {
      const n = frame.getObjectByName(id);
      if (n) mastMain.add(n);
    }
    // the slings on the yard (the yard's own frame: it runs along x), lashed on with a few turns each
    const apex = new THREE.Vector3(0, 0.32, 0);
    for (const sx of [-0.38, 0.38]) {
      const a = new THREE.Vector3(sx, 0.02, 0);
      const d = new THREE.Vector3().subVectors(apex, a);
      const g = new THREE.CylinderGeometry(0.008, 0.008, d.length(), 5).translate(0, d.length() / 2, 0);
      part(`yard-sling-${sx > 0 ? 's' : 'p'}`, g, hemp, a, new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()), yard);
      const ring = lashing(0.055, 0, 3, 0.008);
      ring.rotateZ(Math.PI / 2);
      part(`yard-sling-lash-${sx > 0 ? 's' : 'p'}`, ring, hemp, new THREE.Vector3(sx, 0, 0), undefined, yard);
    }
    // the halyard, block to slings, re-laid as it is drawn
    const halyard = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 1, 5).translate(0, 0.5, 0), hemp);
    halyard.name = 'masthead-halyard-mesh';
    halyard.frustumCulled = false;
    halyard.castShadow = true;
    const from = blockAt.clone().add(new THREE.Vector3(0, -0.07, 0));
    const to = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    halyard.onBeforeRender = () => {
      yard.updateWorldMatrix(true, false);
      to.copy(apex).applyMatrix4(yard.matrixWorld);
      mastMain.worldToLocal(to);
      const d = to.sub(from);
      halyard.position.copy(from);
      halyard.scale.set(1, Math.max(1e-3, d.length()), 1);
      halyard.quaternion.setFromUnitVectors(up, d.normalize());
      halyard.updateMatrix();
      halyard.updateMatrixWorld(true);
    };
    mastMain.add(halyard);
  }

  // THE LADDER'S ROPES MADE FAST (the user: rigging and ladder lines "end in random spots"): each side rope's head
  // is seized to the starboard leg with a cord and a lashing round the leg, its foot likewise near the leg's foot.
  // (The ladder hangs off the leg, its own frame: its ropes at x ±0.155, from y 0 up its length; the leg's axis
  // is behind it at z −0.179, along its y.)
  const ladderDef = byId.get('mast-ladder');
  const ladder = ship.getObjectByName('mast-ladder');
  if (ladderDef && ladder) {
    const h = ladderDef.aabb.max[1];
    const legZ = -0.179;
    const fixAt = (y: number, legY: number, legR: number, tag: string): void => {
      for (const sx of [-0.155, 0.155]) {
        const a = new THREE.Vector3(sx, y, 0);
        const b = new THREE.Vector3(sx * 0.3, legY, legZ + legR * 0.8);
        const d = new THREE.Vector3().subVectors(b, a);
        const g = new THREE.CylinderGeometry(0.007, 0.007, d.length(), 5).translate(0, d.length() / 2, 0);
        part(`ladder-seizing-${tag}-${sx > 0 ? 'a' : 'b'}`, g, hemp, a, new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()), ladder);
      }
      part(`ladder-lashing-${tag}`, lashing(legR, 0, 4, 0.009), hemp, new THREE.Vector3(0, legY, legZ), undefined, ladder);
    };
    fixAt(h, h + 0.06, 0.066, 'head');
    fixAt(0, -0.12, 0.079, 'foot');
  }

  // THE STORES, seated on all of the above
  const props = createRaftProps(ship, L, materials);
  return { ready: props.ready };
}

/** m: the aft gable's shelf over the cabin floor (raftProps.ts seats its pot and bowl on it) */
const SHELF_UP = 1.0;
