/**
 * The islands' low plants for the film (the user, 2026-10-27: the plants "looked ridiculous"): the game's
 * painted grass and shrub cards and its palms are taken off the islands, and CC0 scanned plants (Poly Haven;
 * scripts/drift-pbr-fetch.py) grow on the ground above the beach we land on instead — seeded, so every frame and
 * lane places the same plants:
 *
 *   grass_bermuda_01      low grass tufts, the most of them
 *   fern_02               fern clumps (four variants in the file)
 *   anthurium_botany_01   broad-leaved clumps, the fewest
 *
 * Poly Haven ships a plant's alpha as its own map, not in the glTF: wired in here (alpha-tested, two-sided), or
 * the leaf cards draw as opaque quads. The palms come later (real models, the user is fetching them).
 */
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Archipelago } from '../../island/archipelago';
import { rng } from '../undertime/web';

const PLANTS = [
  { id: 'grass_bermuda_01', count: 2600, scale: [0.8, 1.5] },
  { id: 'fern_02', count: 420, scale: [0.7, 1.3] },
  { id: 'anthurium_botany_01', count: 140, scale: [0.8, 1.2] },
] as const;

export interface Plants {
  readonly group: THREE.Group;
  readonly ready: Promise<void>;
}

/**
 * Plants in `area` (world xz, a rectangle about the beach: x0..x1, z0..z1), on ground between `minH` and `maxH`
 * m over the sea and no steeper than `maxSlope` (rise per metre); `ground` the island's height.
 */
export function createPlants(
  archipelago: Archipelago,
  ground: (x: number, z: number) => number,
  area: { x0: number; x1: number; z0: number; z1: number },
  o: { minH: number; maxH: number; maxSlope: number },
  base = `${import.meta.env.BASE_URL}drift/pbr/`,
): Plants {
  for (const island of archipelago.islands) {
    island.cover.group.removeFromParent();
    island.palms.mesh.removeFromParent();
  }
  const group = new THREE.Group();
  group.name = 'drift-plants';
  const loader = new GLTFLoader();
  const tex = new THREE.TextureLoader();
  const ready = Promise.all(
    PLANTS.map(async (plant, k) => {
      const [g, alpha] = await Promise.all([
        loader.loadAsync(`${base}${plant.id}/${plant.id}_4k.gltf`),
        tex.loadAsync(`${base}${plant.id}/textures/${plant.id}_alpha_4k.png`),
      ]);
      alpha.colorSpace = THREE.NoColorSpace;
      const variants: THREE.Mesh[] = [];
      g.scene.updateMatrixWorld(true);
      g.scene.traverse((x) => {
        const m = x as THREE.Mesh;
        if (!m.isMesh) return;
        const geo = m.geometry.clone().applyMatrix4(m.matrixWorld);
        // each variant about its own foot
        geo.computeBoundingBox();
        const b = geo.boundingBox!;
        geo.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
        const mat = (m.material as THREE.MeshStandardMaterial).clone();
        mat.alphaMap = alpha;
        mat.alphaTest = 0.5;
        mat.transparent = false;
        mat.side = THREE.DoubleSide;
        variants.push(new THREE.Mesh(geo, mat));
      });
      // seeded scatter: tries until enough land on the ground the plant may grow on
      const r = rng(4400 + k);
      const per: THREE.Matrix4[][] = variants.map(() => []);
      const q = new THREE.Quaternion();
      const up = new THREE.Vector3(0, 1, 0);
      let placed = 0;
      for (let tries = 0; tries < plant.count * 40 && placed < plant.count; tries++) {
        const x = area.x0 + (area.x1 - area.x0) * r();
        const z = area.z0 + (area.z1 - area.z0) * r();
        const h = ground(x, z);
        if (h < o.minH || h > o.maxH) continue;
        const slope = Math.hypot(ground(x + 0.5, z) - ground(x - 0.5, z), ground(x, z + 0.5) - ground(x, z - 0.5));
        if (slope > o.maxSlope) continue;
        const s = plant.scale[0] + (plant.scale[1] - plant.scale[0]) * r();
        q.setFromAxisAngle(up, r() * Math.PI * 2);
        per[Math.floor(r() * variants.length)].push(new THREE.Matrix4().compose(new THREE.Vector3(x, h - 0.03, z), q, new THREE.Vector3(s, s, s)));
        placed++;
      }
      variants.forEach((v, i) => {
        if (!per[i].length) return;
        const inst = new THREE.InstancedMesh(v.geometry, v.material, per[i].length);
        per[i].forEach((m, j) => inst.setMatrixAt(j, m));
        inst.instanceMatrix.needsUpdate = true;
        inst.castShadow = true;
        inst.receiveShadow = true;
        inst.computeBoundingSphere();
        inst.name = `drift-${plant.id}-${i}`;
        group.add(inst);
      });
    }),
  ).then(() => undefined);
  return { group, ready };
}
