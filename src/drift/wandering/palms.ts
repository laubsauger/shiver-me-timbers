/**
 * The beach's palms for the film (the user's BlenderKit picks, 2026-10-27; exported by
 * scripts/drift-palm-export.py into public/drift/pbr/blenderkit/, gitignored: royalty-free models may be used
 * in renders, not passed on), in place of the game's:
 *
 *   palm_tree_medium_dense            a coconut-like palm (15.9k triangles), the most of them
 *   palm_tree                         a coconut palm with its nuts (39k)
 *   bent_palm_v1                      a palm bent out over the sand (cut to 120k): two, framing the walk
 *   palm_pritchardia_pacifica_small   a fan palm, small (cut to 40k): undergrowth among the others
 *
 * Placed along the top of the beach (beats.ts COAST: `along` up the beach toward −z, `off` out to sea toward
 * −x), seeded, each scaled to a height of its own and leaning a little toward the sea, as palms on a beach do.
 * The walk runs at off −8; nothing stands nearer than off −13.
 */
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { rng } from '../undertime/web';

type Kind = 'dense' | 'coconut' | 'bent' | 'fan';
const FILES: Record<Kind, string> = {
  dense: 'palm_tree_medium_dense/palm_tree_medium_dense.glb',
  coconut: 'palm_tree/palm_tree.glb',
  bent: 'bent_palm_v1/bent_palm_v1.glb',
  fan: 'palm_pritchardia_pacifica_small/palm_pritchardia_pacifica_small.glb',
};
/** m: each kind's height range */
const HEIGHT: Record<Kind, [number, number]> = { dense: [8, 12], coconut: [7, 10], bent: [8, 9], fan: [2.4, 3.6] };

/** where they stand: (along, off) m, the kind, and a lean toward the sea (rad) — the two bent palms by hand,
 * the rest scattered (see createPalms) */
const HERO: Array<{ along: number; off: number; kind: Kind; lean: number; turn: number }> = [
  { along: 24, off: -14, kind: 'coconut', lean: 0.38, turn: -1.9 },
  { along: -22, off: -15, kind: 'coconut', lean: 0.32, turn: -1.3 },
];

export interface Palms {
  readonly group: THREE.Group;
  readonly ready: Promise<void>;
}

export function createPalms(beach: { x: number; z: number }, ground: (x: number, z: number) => number, base = `${import.meta.env.BASE_URL}drift/pbr/blenderkit/`): Palms {
  const group = new THREE.Group();
  group.name = 'drift-palms';
  // the scatter: clusters along the top of the beach, the fan palms under them
  const r = rng(5200);
  type Slot = { along: number; off: number; kind: Kind; lean: number; turn: number; h: number };
  const slots: Slot[] = HERO.map((s) => ({ ...s, h: HEIGHT[s.kind][0] + (HEIGHT[s.kind][1] - HEIGHT[s.kind][0]) * r() }));
  const near = (a: number, o: number, d: number): boolean => slots.some((s) => Math.hypot(s.along - a, s.off - o) < d);
  for (let i = 0; slots.length < 34 && i < 4000; i++) {
    const along = -70 + 140 * r();
    const off = -14 - 40 * Math.pow(r(), 1.4);
    if (near(along, off, 5.5)) continue;
    const kind: Kind = r() < 0.55 ? 'dense' : 'coconut';
    slots.push({ along, off, kind, lean: 0.04 + 0.12 * r(), turn: r() * Math.PI * 2, h: HEIGHT[kind][0] + (HEIGHT[kind][1] - HEIGHT[kind][0]) * r() });
  }
  for (let i = 0, n = 0; n < 16 && i < 4000; i++) {
    const along = -60 + 120 * r();
    const off = -16 - 30 * r();
    if (near(along, off, 3)) continue;
    slots.push({ along, off, kind: 'fan', lean: 0.03, turn: r() * Math.PI * 2, h: HEIGHT.fan[0] + (HEIGHT.fan[1] - HEIGHT.fan[0]) * r() });
    n++;
  }

  const loader = new GLTFLoader();
  const ready = Promise.all(
    (Object.keys(FILES) as Kind[]).map(async (kind) => {
      const mine = slots.filter((s) => s.kind === kind);
      if (!mine.length) return;
      const g = await loader.loadAsync(base + FILES[kind]);
      g.scene.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(g.scene);
      const height = box.max.y - box.min.y;
      const cx = (box.min.x + box.max.x) / 2;
      const cz = (box.min.z + box.max.z) / 2;
      const parts: THREE.Mesh[] = [];
      g.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        // its own place in the file baked in, the trunk's foot at the origin
        const geo = m.geometry.clone().applyMatrix4(m.matrixWorld);
        geo.translate(-cx, -box.min.y, -cz);
        const mats = (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[];
        for (const mat of mats) {
          if (mat.alphaTest > 0 || mat.transparent) {
            mat.alphaTest = Math.max(0.4, mat.alphaTest);
            mat.transparent = false;
            mat.side = THREE.DoubleSide;
          }
        }
        parts.push(new THREE.Mesh(geo, m.material));
      });
      const matrices = mine.map((s) => {
        const x = beach.x - s.off;
        const z = beach.z - s.along;
        const k = s.h / height;
        // lean toward the sea (−x), turned about its own trunk
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), s.lean).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.turn));
        return new THREE.Matrix4().compose(new THREE.Vector3(x, ground(x, z) - 0.15, z), q, new THREE.Vector3(k, k, k));
      });
      for (const p of parts) {
        const inst = new THREE.InstancedMesh(p.geometry, p.material, matrices.length);
        matrices.forEach((m, i) => inst.setMatrixAt(i, m));
        inst.instanceMatrix.needsUpdate = true;
        inst.castShadow = true;
        inst.receiveShadow = true;
        inst.computeBoundingSphere();
        inst.name = `drift-palm-${kind}`;
        group.add(inst);
      }
    }),
  ).then(() => undefined);
  return { group, ready };
}
