/**
 * §T.208 the cockpit instruments on the hero's 3D dash (src/speedboat/page/dashMount.ts).
 *
 * WHY: USER "i'm missing the trim ui now. no indication anymore where we're at in first person view". The GLB has no
 * screen or needle nodes, so the mount points are derived from the nodes it does have (gauge glass, jack socket) and
 * dash.py's layout. A derivation that drifts puts the plotter floating in front of the tablet or sunk behind it and
 * the gauge tiles off their bezels — so the derived points are checked against the REAL geometry of the built GLB:
 * the tablet screen's four corners in the merged parts mesh, and the gauge glass rims. And the instruments repaint at
 * DASH_HZ in the cockpit camera only: canvas painting + texture upload every frame, or in chase where the dash is a few
 * pixels, is CPU the race does not have (§T.205).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { assetFromGltf } from '../src/speedboat/assets/boatModel';
import { DASH_HZ, createDashMount, locateDash } from '../src/speedboat/page/dashMount';
import { createRaceHudModel } from '../src/speedboat/ui/model';

async function heroBoat() {
  const bytes = readFileSync(new URL('../assets/models/speedboat_hero.glb', import.meta.url));
  await MeshoptDecoder.ready;
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const fakeKtx2 = { load(_u: string, onLoad: (t: THREE.CompressedTexture) => void): void { onLoad(new THREE.CompressedTexture([{ data: new Uint8Array(64), width: 4, height: 4 }] as unknown as ImageData[], 4, 4, THREE.RGBA_ASTC_4x4_Format)); } };
  loader.setKTX2Loader(fakeKtx2 as unknown as Parameters<GLTFLoader['setKTX2Loader']>[0]);
  const g = globalThis as unknown as { self?: unknown };
  const hadSelf = 'self' in g;
  if (!hadSelf) g.self = globalThis;
  try {
    const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, '');
    return assetFromGltf(gltf.scene).instantiate({ variant: 'hero', water: false });
  } finally {
    if (!hadSelf) delete g.self;
  }
}

const verticesOf = (root: THREE.Object3D, frame: THREE.Object3D): THREE.Vector3[] => {
  const out: THREE.Vector3[] = [];
  frame.updateMatrixWorld(true);
  const inv = frame.matrixWorld.clone().invert();
  root.traverse((o) => {
    const pos = (o as THREE.Mesh).geometry?.getAttribute('position');
    if (!pos) return;
    const m = inv.clone().multiply(o.matrixWorld);
    for (let i = 0; i < pos.count; i++) out.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m));
  });
  return out;
};

describe('§T.208 dash displays on the hero dash', () => {
  it('sit on the real tablet screen and gauge glasses, and repaint at DASH_HZ only in the cockpit', async () => {
    const boat = await heroBoat();
    const level0 = boat.object.levels[0].object;
    const face = locateDash(level0, boat.object.userData);
    expect(face).not.toBeNull();
    const f = face as NonNullable<typeof face>;

    // the tablet screen box (0.235 × 0.155 m): its four front corners are vertices of the merged parts mesh
    const parts = verticesOf(level0.getObjectByName('Parts_LOD0') as THREE.Object3D, level0);
    for (const [su, sv] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const corner = f.tablet.clone().addScaledVector(f.u, su * 0.1175).addScaledVector(f.v, sv * 0.0775);
      const d = Math.min(...parts.map((p) => p.distanceTo(corner)));
      expect(d, `tablet screen corner (${su}, ${sv}) is ${(d * 1000).toFixed(1)} mm from the nearest parts vertex`).toBeLessThan(0.002);
    }
    // each gauge centre is on its glass front, the glass rim (r 0.058) round it in the face plane
    const glass = verticesOf(level0.getObjectByName('GaugeGlass_LOD0') as THREE.Object3D, level0);
    expect(f.gauges).toHaveLength(3);
    expect(f.gauges[0].x).toBeGreaterThan(f.gauges[2].x); // tile 0 = the pilot's left (+x)
    for (const c of f.gauges) {
      const front = glass.filter((p) => Math.abs(p.clone().sub(c).dot(f.n)) < 0.0005 && p.distanceTo(c) < 0.08);
      expect(front.length).toBeGreaterThan(8);
      for (const p of front) {
        const r = p.distanceTo(c);
        if (r > 0.001) expect(Math.abs(r - 0.058), `glass rim radius ${r.toFixed(4)}`).toBeLessThan(0.001);
      }
    }

    // repaint rate: a no-op 2D context stands in for the DOM
    const ctx = new Proxy({}, { get: (_t, k) => (k === 'measureText' ? () => ({ width: 0 }) : () => undefined), set: () => true });
    const g = globalThis as unknown as { document?: unknown };
    const hadDocument = 'document' in g;
    g.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
    try {
      const mount = createDashMount(boat);
      expect(mount).not.toBeNull();
      const m = mount as NonNullable<typeof mount>;
      expect(m.meshes.every((mesh) => mesh.parent === level0)).toBe(true);
      let paints = 0;
      const update = m.displays.update.bind(m.displays);
      m.displays.update = (model, dt) => ((paints += 1), update(model, dt));
      const model = createRaceHudModel(8);
      model.camera = 'chase';
      for (let i = 0; i < 120; i++) m.update(model, 1 / 120);
      expect(paints, 'chase camera repaints the dash').toBe(0);
      model.camera = 'cockpit';
      for (let i = 0; i < 240; i++) m.update(model, 1 / 120); // 2 s at 120 fps
      expect(paints).toBeGreaterThanOrEqual(2 * DASH_HZ - 1);
      expect(paints).toBeLessThanOrEqual(2 * DASH_HZ + 1);
    } finally {
      if (!hadDocument) delete g.document;
    }
  }, 60_000);
});
