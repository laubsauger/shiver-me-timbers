/**
 * WHAT LIES ON THE GROUND where the plants meet the sand (the user, 2026-10-29: shrubs and trees "poke out of the
 * sand straight up … that doesn't look believable"; the litter the beach paints round them reads as a tone, not as
 * things, from a few metres). Scanned CC0 pieces from Poly Haven (fetched by scripts/drift-pbr-fetch.py, decimated by
 * scripts/drift-tree-export.py), seeded, sunk a little into the ground they lie on and turned to its slope:
 *
 *   root_cluster_01       the buttress roots spreading from a big tree's foot (about one tree in three)
 *   single_root           a surface root running out from a foot
 *   dry_branches_medium_01  fallen branches and twigs round every foot, and fronds' ribs under the palms
 *   bark_debris_01        bark and husk fragments round every foot
 *   shrub_02, shrub_03    low ground plants clumped round the shrubs' feet and the forest's edge
 *   dead_tree_trunk_02, dead_tree_trunk   fallen trunks at the forest's edge, and DRIFTWOOD on the beach's upper
 *                         strand line, where the highest tides leave it (the reference photograph's log on the sand)
 *
 * `feet` are the forest edge's trees and shrubs (forest.ts: x, z, the litter's radius — 5 m a tree, 2.6 a shrub)
 * and the palms'; `ground` our island's height; `strand` world x of the strand line at a world z.
 */
import * as THREE from 'three/webgpu';
import { cameraPosition, fwidth, positionWorld } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { rng } from '../undertime/web';
import { footprint, seated } from './seat';

type Kind = 'roots' | 'root' | 'branches' | 'bark' | 'shrub' | 'tuft' | 'log' | 'pole';
const FILES: Record<Kind, string> = {
  roots: 'root_cluster_01',
  root: 'single_root',
  branches: 'dry_branches_medium_01',
  bark: 'bark_debris_01',
  shrub: 'shrub_02',
  tuft: 'shrub_03',
  log: 'dead_tree_trunk_02',
  pole: 'dead_tree_trunk',
};
/** m each kind is sunk into the ground, as a share of its own height (roots half buried, a log settled in the sand) */
const SINK: Record<Kind, number> = { roots: 0.45, root: 0.4, branches: 0.15, bark: 0.2, shrub: 0.05, tuft: 0.05, log: 0.25, pole: 0.3 };
/** the living kinds, seated by their own stems (seat.ts): shrub_02 and shrub_03 are each four plants side by side, and
 * a row (up to 5 m long) turned to the slope at its middle left its end plants over the coppice mounds (the
 * 2026-11-01 note: plants "floating on the sand"). Each plant now stands on its own ground, its foot SINK of the
 * file's height under the lowest point beneath it */
const SEATED: Partial<Record<Kind, true>> = { shrub: true, tuft: true };
/**
 * m: how thin the pieces of the small kinds are (a twig, a flake of bark, a leaf of a tuft) — where one would come
 * out under THIN_PX of a pixel across it is not drawn (the 2026-10-29 beach review at 600–610 s, "insanely nervous":
 * the twigs and tufts along the forest's foot were a band of dark pixels on the bright sand that changed every
 * frame the eye moved, an eighth of the forest wall's flicker at 604 s). Measured per pixel from its ray's angle,
 * so a finer master keeps them further out; the litter painted on the sand (forest.ts litterMask) stays.
 */
const THIN: Partial<Record<Kind, number>> = { branches: 0.04, bark: 0.06, root: 0.08, shrub: 0.05, tuft: 0.04 };
const THIN_PX = 0.7;

/** a small kind's material: the scan's own, its sub-pixel pieces left out */
function thinOf(src: THREE.MeshStandardMaterial, thin: number): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({
    map: src.map,
    normalMap: src.normalMap,
    roughnessMap: src.roughnessMap,
    metalnessMap: src.metalnessMap,
    aoMap: src.aoMap,
    color: src.color,
    roughness: src.roughness,
    metalness: src.metalness,
    alphaTest: src.alphaTest,
    vertexColors: src.vertexColors,
  });
  // (a pixel's width at the piece, from how far its ray turns across the pixel: smooth at any depth. In the shadow
  // pass the camera is the Sun's, orthographic and far: its rays barely turn, every piece casts)
  const ray = positionWorld.sub(cameraPosition);
  m.maskNode = fwidth(ray.normalize()).length().mul(ray.length()).mul(THIN_PX).lessThan(thin);
  return m;
}

export interface GroundDebris {
  readonly group: THREE.Group;
  readonly ready: Promise<void>;
}

export function createGroundDebris(o: {
  feet: Array<[number, number, number]>;
  palms: Array<[number, number]>;
  ground: (x: number, z: number) => number;
  strand: (z: number) => number;
  /** world z span of the beach dressed with driftwood */
  along: [number, number];
  base?: string;
}): GroundDebris {
  const base = o.base ?? `${import.meta.env.BASE_URL}drift/pbr/`;
  const group = new THREE.Group();
  group.name = 'drift-ground-debris';
  const r = rng(7311);
  /** placements per kind: x, z, yaw, scale */
  const at: Record<Kind, Array<[number, number, number, number]>> = { roots: [], root: [], branches: [], bark: [], shrub: [], tuft: [], log: [], pole: [] };
  const put = (k: Kind, x: number, z: number, s: number): void => {
    at[k].push([x, z, r() * Math.PI * 2, s]);
  };
  /** a point `d0`..`d1` m from (x, z), any bearing */
  const near = (x: number, z: number, d0: number, d1: number): [number, number] => {
    const a = r() * Math.PI * 2;
    const d = d0 + (d1 - d0) * Math.sqrt(r());
    return [x + Math.cos(a) * d, z + Math.sin(a) * d];
  };
  for (const [x, z, radius] of o.feet) {
    const tree = radius > 4;
    if (tree) {
      if (r() < 0.38) put('roots', x, z, 0.8 + 0.5 * r());
      for (let i = 0, n = 1 + Math.floor(r() * 3); i < n; i++) put('root', ...near(x, z, 0.6, 1.8), 1 + 0.6 * r());
      for (let i = 0, n = 2 + Math.floor(r() * 3); i < n; i++) put('branches', ...near(x, z, 0.8, 4.5), 0.8 + 0.8 * r());
      for (let i = 0, n = 2 + Math.floor(r() * 3); i < n; i++) put('bark', ...near(x, z, 0.4, 3.5), 1 + r());
      if (r() < 0.12) put('pole', ...near(x, z, 2, 5), 1.2 + 0.8 * r());
    } else {
      for (let i = 0, n = 1 + Math.floor(r() * 2); i < n; i++) put('shrub', ...near(x, z, 0.3, 1.6), 0.45 + 0.4 * r());
      for (let i = 0, n = 2 + Math.floor(r() * 4); i < n; i++) put('tuft', ...near(x, z, 0.3, 2.2), 1.2 + 1.3 * r());
      if (r() < 0.6) put('branches', ...near(x, z, 0.5, 2.2), 0.6 + 0.6 * r());
      if (r() < 0.6) put('bark', ...near(x, z, 0.3, 1.8), 0.8 + 0.8 * r());
    }
  }
  for (const [x, z] of o.palms) {
    // a palm's foot: its own dropped frond ribs and husks
    for (let i = 0, n = 2 + Math.floor(r() * 2); i < n; i++) put('branches', ...near(x, z, 0.5, 2.6), 1 + 0.8 * r());
    for (let i = 0, n = 1 + Math.floor(r() * 3); i < n; i++) put('bark', ...near(x, z, 0.3, 2), 1.1 + 0.9 * r());
    for (let i = 0, n = Math.floor(r() * 3); i < n; i++) put('tuft', ...near(x, z, 0.4, 2), 1 + r());
  }
  // DRIFTWOOD on the strand line, a log every 40–90 m, a pole between
  for (let z = o.along[0] + 20 * r(); z < o.along[1]; z += 40 + 50 * r()) {
    const x = o.strand(z) + (r() - 0.5) * 3;
    put(r() < 0.6 ? 'log' : 'pole', x, z, 0.6 + 0.5 * r());
    if (r() < 0.5) put('branches', x + (r() - 0.5) * 4, z + (r() - 0.5) * 4, 1 + r());
  }

  const loader = new GLTFLoader();
  const up = new THREE.Vector3(0, 1, 0);
  const n = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const tilt = new THREE.Quaternion();
  const ready = Promise.all(
    (Object.keys(FILES) as Kind[])
      .filter((k) => at[k].length)
      .map(async (k) => {
        const g = await loader.loadAsync(`${base}${FILES[k]}/${FILES[k]}_lod.glb`);
        g.scene.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(g.scene);
        const tall = box.max.y - box.min.y;
        const parts: THREE.Mesh[] = [];
        g.scene.traverse((x) => {
          if ((x as THREE.Mesh).isMesh) parts.push(x as THREE.Mesh);
        });
        const mats = at[k].map(([x, z, yaw, s]) => {
          // lying on the ground's own slope
          const e = 0.4;
          n.set(o.ground(x - e, z) - o.ground(x + e, z), 2 * e, o.ground(x, z - e) - o.ground(x, z + e)).normalize();
          tilt.setFromUnitVectors(up, n);
          q.setFromAxisAngle(up, yaw).premultiply(tilt);
          const foot = new THREE.Vector3(-(box.min.x + box.max.x) / 2, -box.min.y - SINK[k] * tall, -(box.min.z + box.max.z) / 2).multiplyScalar(s).applyQuaternion(q);
          return new THREE.Matrix4().compose(new THREE.Vector3(x, o.ground(x, z), z).add(foot), q, new THREE.Vector3(s, s, s));
        });
        for (const part of parts) {
          const geo = part.geometry.clone().applyMatrix4(part.matrixWorld);
          const foot = SEATED[k] ? footprint([geo]) : null;
          const own = foot ? mats.map((x, i) => seated(foot, x, o.ground, SINK[k] * tall * at[k][i][3])) : mats;
          const src = part.material as THREE.MeshStandardMaterial;
          const thin = THIN[k];
          const m = thin ? thinOf(src, thin) : src.clone();
          m.side = THREE.DoubleSide;
          // the alpha-masked scans (the shrubs' leaf cards) cut as coverage in the dome's multisampled faces, as the
          // plants are (plants.ts says how; cine/domeCapture.ts, EDGES ARE MULTISAMPLED)
          if (m.alphaTest > 0) m.alphaToCoverage = true;
          // (the scans' ARM maps carry their ambient occlusion: wired if the file did not)
          if (!m.aoMap && m.roughnessMap) m.aoMap = m.roughnessMap;
          const inst = new THREE.InstancedMesh(geo, m, mats.length);
          own.forEach((x, i) => inst.setMatrixAt(i, x));
          inst.instanceMatrix.needsUpdate = true;
          inst.computeBoundingSphere();
          inst.castShadow = true;
          inst.receiveShadow = true;
          inst.name = `drift-ground-${k}`;
          group.add(inst);
        }
      }),
  ).then(() => undefined);
  return { group, ready };
}
