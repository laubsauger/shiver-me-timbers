/**
 * The islands' rocks for the film (the user, 2026-10-27: "flat coloured stuff, no structure"): the game's
 * smooth-deformed icosahedra replaced by CC0 photogrammetry scans (Poly Haven; scripts/drift-pbr-fetch.py, cut
 * down by scripts/drift-rock-lod.py), one instance at each of the game's own rock placements — so the islands
 * keep their composition (the headland masses, the boulders strewn along the shore) and gain real stone:
 *
 *   namaqualand_boulder_05   a pale rounded boulder (1.4 m, 12k triangles) for the scatter
 *   coast_rocks_05           a limestone ledge with an undercut (4 m, 60k) for the headland masses
 *
 * Each scan is sized to its placement (its radius to the placement's), turned and tilted as the game turns its
 * rock, and stood on the ground where it is, sunk a sixth of its height.
 */
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Archipelago } from '../../island/archipelago';

/** m: each scan's own radius (half its largest plan extent), what a placement's `scale` maps to */
const SCANS = {
  boulder: { file: 'namaqualand_boulder_05/namaqualand_boulder_05_lod.glb', radius: 0.68 },
  ledge: { file: 'coast_rocks_05/coast_rocks_05_lod.glb', radius: 2.0 },
} as const;

export interface ScannedRocks {
  readonly group: THREE.Group;
  readonly ready: Promise<void>;
}

/**
 * `keep(x, z)`: false where no rock may stand (world metres: the walked beach). The game's rock groups are
 * taken off the islands.
 */
export function createScannedRocks(archipelago: Archipelago, keep: (x: number, z: number) => boolean, base = `${import.meta.env.BASE_URL}drift/pbr/`): ScannedRocks {
  const group = new THREE.Group();
  group.name = 'drift-scanned-rocks';
  archipelago.group.updateMatrixWorld(true);
  type Slot = { m: THREE.Matrix4; ledge: boolean };
  const slots: Slot[] = [];
  const q = new THREE.Quaternion();
  const tilt = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (const island of archipelago.islands) {
    const rocks = island.rocks;
    for (const r of rocks.placements) {
      p.set(...r.position).applyMatrix4(rocks.group.matrixWorld);
      if (!keep(p.x, p.z)) continue;
      p.y = island.heightAt(p.x, p.z);
      const ledge = r.cliff;
      const s = r.scale / (ledge ? SCANS.ledge.radius : SCANS.boulder.radius);
      axis.set(Math.cos(r.tiltDir), 0, Math.sin(r.tiltDir)).cross(new THREE.Vector3(0, 1, 0)).normalize();
      tilt.setFromAxisAngle(axis, r.tilt);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r.yaw).premultiply(tilt);
      slots.push({ m: new THREE.Matrix4().compose(p.clone(), q.clone(), new THREE.Vector3(s, s * Math.max(0.6, r.squash * 1.4), s * r.aspect)), ledge });
    }
    rocks.group.removeFromParent();
  }

  const loader = new GLTFLoader();
  const load = (file: string): Promise<THREE.Mesh> =>
    loader.loadAsync(base + file).then((g) => {
      let mesh: THREE.Mesh | undefined;
      g.scene.traverse((o) => {
        if ((o as THREE.Mesh).isMesh && !mesh) mesh = o as THREE.Mesh;
      });
      if (!mesh) throw new Error(`rocks: no mesh in ${file}`);
      mesh.updateWorldMatrix(true, false);
      // the scan's own placement inside its file baked in, its base at the origin
      mesh.geometry.applyMatrix4(mesh.matrixWorld);
      mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox!;
      mesh.geometry.translate(-(box.min.x + box.max.x) / 2, -box.min.y - (box.max.y - box.min.y) / 6, -(box.min.z + box.max.z) / 2);
      return mesh;
    });
  const ready = Promise.all([load(SCANS.boulder.file), load(SCANS.ledge.file)]).then(([boulder, ledge]) => {
    for (const [src, isLedge] of [[boulder, false], [ledge, true]] as const) {
      const mine = slots.filter((x) => x.ledge === isLedge);
      if (!mine.length) continue;
      const inst = new THREE.InstancedMesh(src.geometry, src.material, mine.length);
      mine.forEach((x, i) => inst.setMatrixAt(i, x.m));
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = true;
      inst.receiveShadow = true;
      inst.computeBoundingSphere();
      inst.name = isLedge ? 'drift-rock-ledges' : 'drift-rock-boulders';
      group.add(inst);
    }
  });
  return { group, ready };
}
