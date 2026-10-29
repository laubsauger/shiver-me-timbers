/**
 * THE RAFT'S STORES, as real things (the user, 2026-10-29, of the close chase frame: "the whitish/yellow box on
 * the right doesn't look good, the barrel doesn't look good, everything is too perfect"). The game dresses its
 * raft with boxes (raftPartsCabin.ts buildDressing / buildCabinInterior: crates, cans, the ring dinghy, the rain
 * drum, the kitchen box, the plank chest, the pots and ladle — each a box or a cylinder in a flat colour, §T89
 * "boxes first"); the film takes those pieces off its raft and stows CC0 scanned and modelled props (Poly Haven;
 * scripts/drift-pbr-fetch.py, cut to 1k maps by scripts/drift-prop-export.py into public/models/raft/) where the game's stores are, in the
 * raft's own frame:
 *
 *   port side, on the bamboo strip along the cabin wall (raftDress.ts lays it), from forward aft: a long plank
 *     crate with two water cans on it, two smaller crates stacked a little askew, a lidded basket, the lifebuoy
 *     HUNG on the wall from a peg through its eye and lashed (the dinghy's place; [§6] "lifebelt"), and the rain
 *     drum on the bare logs at the corner (a blue plastic drum, so the raft keeps its one blue store)
 *   starboard, aft of the door: the kitchen box, a small crate against the wall
 *   the fore-deck: the plank chest, a stencilled crate
 *   in the cabin ([§3 Museum]: "pots/pans/ladle on wall by door … tins inside"): an enamel pot and a wooden bowl
 *     on a plank shelf on the aft gable, a second pot hung from a peg by its handle, the ladle on a peg, a water
 *     jug on the floor by the radio corner, a basket of sweet potatoes hung from the tie beam
 *
 * EVERY PROP IS SEATED ON WHAT IS UNDER IT (the user: "the box right of the lifebuoy floats in mid-air, the
 * bucket left of it too"): rays straight down at its centre and the corners of its footprint, onto the raft as
 * built — mats, crossbeams, logs, and the props already stowed (the cans stand on their crate) — and it rests on
 * the highest, sunk 4 mm into it. Authored heights were the game's crossbeam tops; between two crossbeams there
 * is nothing at that height.
 *
 * Nothing on the raft depends on the boxes being there but the eye: the deck field is the blueprint's, and the
 * people and the case (props.ts) find their footing by a ray onto whatever IS there — so the game's boxes are
 * taken out of the drawing AND out of every ray (their layers cleared: a hidden mesh is still hit by a ray).
 */
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { RaftLayout } from './raftPartsLayout';
import type { MaterialFactory } from './shipAssembly';
import { raftParams } from '../params/raft';

/** the game's dressing pieces the props replace (raftPartsCabin.ts ids) */
const REPLACED = ['crate-1', 'crate-2', 'crate-3', 'jerrycan-1', 'jerrycan-2', 'dinghy', 'rain-drum', 'kitchen-box', 'plank-chest', 'pot-1', 'pot-2', 'ladle'];

const FILES = {
  drum: 'Barrel_02.glb',
  crateLong: 'wooden_crate_02.glb',
  crate: 'wooden_crate_01.glb',
  can: 'metal_jerrycan_green.glb',
  buoy: 'lifebuoy.glb',
  basket: 'wicker_basket_02.glb',
  pot: 'pot_enamel_01.glb',
  bowl: 'wooden_bowl_02.glb',
  jug: 'metal_jug.glb',
  spoon: 'wooden_spoon.glb',
} as const;
type PropName = keyof typeof FILES;

/**
 * Where each stands, raft-local (x starboard, y up, z bow), turned how much (rad, YXZ: `yaw` about y, `tilt` about
 * the model's own x), at what scale:
 *   seat  rests on what is under it (rays from `from` m down), sunk a little
 *   at    exactly at `y` (a hung thing: its hanger is drawn with it, raftDress.ts / below)
 * A model's base is its y = 0 (the buoy's rope hangs below its ring: `lift` puts its centre where it is hung).
 */
interface Stow {
  prop: PropName;
  x: number;
  z: number;
  yaw: number;
  scale: number;
  mode: 'seat' | 'at';
  y?: number;
  from?: number;
  tilt?: number;
  lift?: number;
}

/** m: the buoy's eye (its ring's inner radius) and the peg it hangs on */
const BUOY_EYE = 0.215;
const PEG_R = 0.016;

function stowage(L: RaftLayout): Stow[] {
  const wall = -raftParams.cabinWidth / 2;
  const deck = L.crossbeamTopY;
  const floor = L.cabinFloorY;
  const inner = raftParams.cabinWidth / 2 - raftParams.cabinWallThickness;
  const z0 = L.cabinAftZ + raftParams.cabinWallThickness;
  return [
    // port, outside: the posts' seam battens stand at a third and two thirds of the cabin (raftDress.ts) — the
    // stores keep between them
    { prop: 'crateLong', x: wall - 0.04 - 0.24, z: -0.78, yaw: 0.035, scale: 0.9, mode: 'seat', from: deck + 0.6 },
    { prop: 'can', x: wall - 0.16, z: -0.52, yaw: Math.PI / 2 + 0.06, scale: 1, mode: 'seat', from: deck + 1.2 },
    { prop: 'can', x: wall - 0.2, z: -0.98, yaw: Math.PI / 2 - 0.13, scale: 1, mode: 'seat', from: deck + 1.2 },
    { prop: 'crate', x: wall - 0.05 - 0.2, z: -2.13, yaw: Math.PI / 2 - 0.05, scale: 0.95, mode: 'seat', from: deck + 0.6 },
    { prop: 'crate', x: wall - 0.07 - 0.2, z: -2.18, yaw: Math.PI / 2 + 0.11, scale: 0.88, mode: 'seat', from: deck + 1.2 },
    { prop: 'basket', x: wall - 0.36, z: -3.18, yaw: 0.6, scale: 1.25, mode: 'seat', from: deck + 0.6 },
    { prop: 'drum', x: -1.54, z: -4.64, yaw: 0.8, scale: 1.05, mode: 'seat', from: deck + 0.6 },
    // starboard, against the wall aft of the door (clear of its jamb); the fore-deck chest where the game's stands
    { prop: 'crate', x: -wall + 0.03 + 0.155, z: -3.8, yaw: Math.PI / 2 + 0.04, scale: 0.75, mode: 'seat', from: L.deckY + 0.6 },
    { prop: 'crateLong', x: 0.3, z: 0.62, yaw: Math.PI / 2 - 0.05, scale: 0.72, mode: 'seat', from: L.deckY + 0.6 },
    // the cabin: on the aft gable's shelf (raftDress.ts: its plank's top at floor + SHELF_UP), a pot and a bowl;
    // the jug on the floor under it, in the corner (out of the lane from the door to the radio nook); a pot hung by its handle and the ladle on pegs on the starboard
    // wall aft of the door
    { prop: 'pot', x: 0.42, z: z0 + 0.12, yaw: 0.3, scale: 0.9, mode: 'seat', from: floor + 1.4 },
    { prop: 'bowl', x: 0.78, z: z0 + 0.11, yaw: 1.1, scale: 1.1, mode: 'seat', from: floor + 1.4 },
    { prop: 'jug', x: 0.92, z: z0 + 0.32, yaw: 2.2, scale: 0.95, mode: 'seat', from: floor + 0.6 },
    { prop: 'pot', x: inner - 0.12, z: -3.62, yaw: -Math.PI / 2, scale: 0.85, mode: 'at', y: floor + 0.84, tilt: 0.42 },
    { prop: 'spoon', x: inner - 0.03, z: -3.95, yaw: Math.PI / 2, scale: 1.1, mode: 'at', y: floor + 0.88, tilt: -Math.PI / 2 },
  ];
}

export interface RaftProps {
  readonly group: THREE.Group;
  readonly ready: Promise<void>;
}

/** a thin rope or a peg between two raft-local points, as a cylinder (drawn in `mat`) */
function rod(a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material, name: string): THREE.Mesh {
  const d = new THREE.Vector3().subVectors(b, a);
  const g = new THREE.CylinderGeometry(r, r, d.length(), 6, 1);
  const m = new THREE.Mesh(g, mat);
  m.name = name;
  m.position.copy(a).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/**
 * Stow the props on `ship` (the assembly's group: the raft's own frame), taking the game's boxes off it. Pegs and
 * hangers are drawn in the raft's own wood and hemp (`materials`). Call once the raft is built and dressed (the
 * strip the port stores stand on, the shelf), so the rays find it.
 */
export function createRaftProps(ship: THREE.Object3D, L: RaftLayout, materials: MaterialFactory, base = `${(import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/'}models/raft/`): RaftProps {
  for (const id of REPLACED) {
    const node = ship.getObjectByName(id);
    node?.traverse((o) => {
      o.visible = false;
      o.layers.disableAll();
    });
  }
  const group = new THREE.Group();
  group.name = 'drift-raft-props';
  ship.add(group);
  const wood = materials('bipod-mast', 'base');
  const hemp = materials('lashing', 'base');
  const loader = new GLTFLoader();
  const load = (name: PropName): Promise<[PropName, THREE.Object3D]> =>
    loader.loadAsync(base + FILES[name]).then((g) => {
      g.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const mat = mesh.material as THREE.MeshStandardMaterial;
        // (the scans' maps at their best at a grazing look along the deck)
        for (const t of [mat.map, mat.normalMap, mat.roughnessMap, mat.aoMap]) if (t) t.anisotropy = 8;
        // the drum's new-plastic blue a season in the sun: duller, a little greyed
        if (name === 'drum') mat.color.setRGB(0.78, 0.82, 0.86);
      });
      // ONE MESH A MATERIAL: a model's parts (a crate's lid, body and latch; a can's cap, pin and latch) merged in
      // the model's frame — each was a draw in every pass, and the stores are many models
      const groups = new Map<THREE.Material, THREE.BufferGeometry[]>();
      g.scene.updateMatrixWorld(true);
      g.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const geo = m.geometry.clone().applyMatrix4(m.matrixWorld);
        for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(k)) geo.deleteAttribute(k);
        const list = groups.get(m.material as THREE.Material) ?? [];
        list.push(geo.index ? geo.toNonIndexed() : geo);
        groups.set(m.material as THREE.Material, list);
      });
      const root = new THREE.Group();
      for (const [mat, list] of groups) {
        const merged = mergeGeometries(list, false);
        if (!merged) continue;
        const mesh = new THREE.Mesh(merged, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        root.add(mesh);
      }
      return [name, root];
    });

  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3();
  const from = new THREE.Vector3();
  /** what a ray may land on: not the cabin's walls, roof or frame, nor the rails (a store stands on the deck) */
  const NOT = /^(cabin-(wall|post|plate|stud|king|ridge|rafter|tie|bundle)|thatch-|roof-lath|rail-)/;
  const support = (o: THREE.Object3D): boolean => !NOT.test(o.name) && !NOT.test(o.parent?.name ?? '');
  /** the highest support under raft-local (x, z), below `y0`, or null */
  const supportAt = (x: number, z: number, y0: number): number | null => {
    ship.updateMatrixWorld(true);
    from.set(x, y0, z).applyMatrix4(ship.matrixWorld);
    down.set(0, -1, 0).transformDirection(ship.matrixWorld);
    ray.set(from, down);
    ray.far = 3;
    for (const h of ray.intersectObject(ship, true)) {
      if (!support(h.object)) continue;
      return ship.worldToLocal(h.point.clone()).y;
    }
    return null;
  };

  const ready = Promise.all((Object.keys(FILES) as PropName[]).map(load)).then((loaded) => {
    const models = new Map(loaded);
    // in order, so what stands on a store finds it
    for (const s of stowage(L)) {
      const o = models.get(s.prop)!.clone();
      o.scale.setScalar(s.scale);
      const holder = new THREE.Group();
      holder.name = `prop-${s.prop}`;
      holder.rotation.set(s.tilt ?? 0, s.yaw, 0, 'YXZ');
      o.position.y = (s.lift ?? 0) * s.scale;
      holder.add(o);
      let y = s.y ?? 0;
      if (s.mode === 'seat') {
        // the footprint's centre and corners (its box, turned as it stands), each ray onto what is there
        holder.position.set(s.x, 0, s.z);
        holder.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(o, true);
        const local = box.clone();
        const pts: Array<[number, number]> = [[s.x, s.z]];
        const c = new THREE.Vector3();
        for (const [fx, fz] of [[0.18, 0.18], [0.82, 0.18], [0.18, 0.82], [0.82, 0.82]]) {
          c.set(local.min.x + (local.max.x - local.min.x) * fx, 0, local.min.z + (local.max.z - local.min.z) * fz);
          pts.push([c.x, c.z]);
        }
        const hits = pts.map(([x, z]) => supportAt(x, z, s.from ?? 2)).filter((h): h is number => h !== null);
        y = (hits.length ? Math.max(...hits) : L.deckY) - 0.004;
      }
      holder.position.set(s.x, y, s.z);
      group.add(holder);
      holder.updateMatrixWorld(true);
    }

    // THE LIFEBUOY, hung on the port wall: a peg out of the wall through its eye, the ring flush against the
    // weave behind it (found by a ray in toward the wall at its height), a turn of line lashing it to the peg
    const buoyZ = -3.66;
    // (its top under the eave plate, its foot clear of the stores)
    const pegY = L.crossbeamTopY + 1.16;
    ship.updateMatrixWorld(true);
    from.set(-2.2, pegY - BUOY_EYE, buoyZ).applyMatrix4(ship.matrixWorld);
    ray.set(from, new THREE.Vector3(1, 0, 0).transformDirection(ship.matrixWorld));
    ray.far = 1.5;
    const wallHit = ray.intersectObject(ship, true).find((h) => /^cabin-wall/.test(h.object.name));
    const wallX = wallHit ? ship.worldToLocal(wallHit.point.clone()).x : -raftParams.cabinWidth / 2;
    const buoy = models.get('buoy')!.clone();
    const hb = new THREE.Group();
    hb.name = 'prop-buoy';
    // the ring's plane along the wall (its axis athwartships), 8 mm off the weave, its eye's top on the peg
    hb.rotation.set(0, Math.PI / 2, 0);
    hb.position.set(wallX - 0.078 - 0.008, pegY - BUOY_EYE - PEG_R, buoyZ);
    hb.add(buoy);
    group.add(hb);
    group.add(rod(new THREE.Vector3(wallX + 0.02, pegY, buoyZ), new THREE.Vector3(wallX - 0.21, pegY + 0.03, buoyZ), PEG_R, wood, 'prop-buoy-peg'));
    // (round the peg and the ring's upper tube above it, in the ring's plane)
    const lash = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.007, 5, 14), hemp);
    lash.name = 'prop-buoy-lashing';
    lash.position.set(wallX - 0.086, pegY + 0.04, buoyZ);
    lash.rotation.set(0.25, Math.PI / 2, 0);
    group.add(lash);

    // the pot's and the ladle's pegs, and the pot's cord through its handle
    const inner = raftParams.cabinWidth / 2 - raftParams.cabinWallThickness;
    const fl = L.cabinFloorY;
    const peg = (z: number, y: number, name: string): void => {
      group.add(rod(new THREE.Vector3(inner + 0.02, y, z), new THREE.Vector3(inner - 0.13, y + 0.02, z), 0.013, wood, name));
    };
    peg(-3.62, fl + 1.05, 'prop-pot-peg');
    group.add(rod(new THREE.Vector3(inner - 0.09, fl + 1.06, -3.62), new THREE.Vector3(inner - 0.1, fl + 0.93, -3.62 - 0.1), 0.004, hemp, 'prop-pot-cord'));
    peg(-3.95, fl + 1.08, 'prop-ladle-peg');

    // the basket of sweet potatoes hung from the tie beam (raftDress.ts: across mid-cabin at TIE_Y), on a cord
    const tieY = fl + raftParams.cabinEave - 0.06;
    const basket = models.get('basket')!.clone();
    basket.scale.setScalar(1.3);
    const hk = new THREE.Group();
    hk.name = 'prop-basket-hung';
    // (over the starboard berth, by the wall: out of a walking head's way)
    hk.position.set(0.88, tieY - 0.42, L.cabinAftZ + raftParams.cabinLength / 2 + 0.02);
    hk.rotation.y = 0.4;
    hk.add(basket);
    group.add(hk);
    group.add(rod(new THREE.Vector3(0.88, tieY - 0.03, hk.position.z), new THREE.Vector3(0.88, tieY - 0.42 + 0.25, hk.position.z), 0.005, hemp, 'prop-basket-cord'));
  });
  return { group, ready };
}
