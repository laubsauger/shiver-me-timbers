/**
 * START + PACE MARKERS (§T.202, user playtest: "we don't really get an indication where the steward is").
 * Plain in-engine meshes, no asset pipeline: a handful of draws, built and driven by `createCourseFurniture`.
 *
 * START PONTOONS (`CourseFurnitureData.startPontoons`): a signal-orange pontoon outboard of each start pole, just
 * short of the line, with two chequer flags and a lamp board facing the boats running up to it. The board repeats
 * the tower's start lamps (red 1–5 as they light, green from green on), so the line itself shows the countdown.
 *
 * PACE RIG (`CourseFurnitureFrame.pace`): the marshal skiff's FOLLOW-ME mast — a 7 m pole with a big chequer board
 * facing aft at the grid and a double-flash amber strobe on top — drawn at the pace boat's displayed pose
 * (page/paceBoat `display`), hidden when the pose is null. Render only: the race owns the pose.
 */
import * as THREE from 'three/webgpu';
import { START_PONTOON, type StartPontoonPlacement } from './towerReach';

/** HDR radiance of a lit lamp (the post pipeline blooms above ~1) */
const LAMP_HDR = 6;
const RED = new THREE.Color(1, 0.08, 0.04);
const GREEN = new THREE.Color(0.1, 1, 0.25);
const AMBER = new THREE.Color(1, 0.55, 0.08);
const OFF = 0.03;

/** pace rig geometry (m), in the boat frame: +z forward, y up from still water */
export const PACE_RIG = {
  /** mast foot: aft of the boat's origin, on deck */
  mastZ: -2.6,
  deckY: 1.1,
  mastHeight: 7,
  board: { w: 2.6, h: 1.7 },
  strobeRadius: 0.34,
  /** double flash per second */
  strobeHz: 1.1,
};

/** an 8 × 4 chequer, mipmapped so it filters to grey instead of shimmering at range (§V48) */
function chequerTexture(): THREE.DataTexture {
  const w = 64;
  const h = 32;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = ((x >> 3) + (y >> 3)) % 2 ? 236 : 18;
      data.set([v, v, v, 255], (y * w + x) * 4);
    }
  }
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/** amber double flash: on for 70 ms, off 90 ms, on 70 ms, then dark for the rest of the period */
export function strobeLevel(time: number, hz = PACE_RIG.strobeHz): number {
  const p = (((time * hz) % 1) + 1) % 1 / hz;
  return p < 0.07 || (p > 0.16 && p < 0.23) ? 1 : OFF;
}

export interface StartMarkersFrame {
  time: number;
  dt: number;
  waterHeightAt?: (x: number, z: number) => number;
  startLamps?: number;
  startGreen?: boolean;
  /** the pace boat's displayed pose (yaw: 0 = +z, race/polyline convention), null/undefined = no pace boat */
  pace?: { x: number; z: number; yaw: number } | null;
}

export interface StartMarkers {
  group: THREE.Group;
  update(f: StartMarkersFrame): void;
  dispose(): void;
}

export function createStartMarkers(pontoons: readonly StartPontoonPlacement[]): StartMarkers {
  const root = new THREE.Group();
  root.name = 'start-markers';
  const disposables: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(x: T): T => (disposables.push(x), x);

  const chequer = own(chequerTexture());
  const paint = own(new THREE.MeshStandardNodeMaterial({ color: 0xe0561c, roughness: 0.6 }));
  const steel = own(new THREE.MeshStandardNodeMaterial({ color: 0x6d7173, roughness: 0.45, metalness: 0.7 }));
  const board = own(new THREE.MeshStandardNodeMaterial({ color: 0x141718, roughness: 0.8 }));
  const flag = own(new THREE.MeshStandardNodeMaterial({ map: chequer, roughness: 0.7, side: THREE.DoubleSide }));
  // lamps: unlit, colour per instance × HDR level
  const lampMat = own(new THREE.MeshBasicNodeMaterial({ color: 0xffffff }));

  const P = START_PONTOON;
  const hullGeo = own(new THREE.BoxGeometry(P.length, P.freeboard + P.draft, P.beam));
  const poleGeo = own(new THREE.CylinderGeometry(0.07, 0.09, 1, 10));
  const flagGeo = own(new THREE.PlaneGeometry(1, 1));
  const lampGeo = own(new THREE.SphereGeometry(1, 14, 10));
  const boxGeo = own(new THREE.BoxGeometry(1, 1, 1));

  // ── start pontoons: one InstancedMesh per part kind for all pontoons, each pontoon's parts under its heaving pose ──
  const LAMPS = 5;
  const lampCount = pontoons.length * (LAMPS + 1);
  const lamps = own(new THREE.InstancedMesh(lampGeo, lampMat, Math.max(1, lampCount)));
  lamps.name = 'start-lamps';
  lamps.count = lampCount;
  const m4 = new THREE.Matrix4();
  /** part transforms in the pontoon frame (+Z toward the approaching boats) */
  const hullParts = [new THREE.Matrix4().makeTranslation(0, (P.freeboard - P.draft) / 2, 0)];
  const steelParts: THREE.Matrix4[] = [];
  const flagParts: THREE.Matrix4[] = [];
  // two flag poles at the pontoon's ends, chequer flags toward the approaching boats (+Z)
  for (const end of [-1, 1]) {
    steelParts.push(new THREE.Matrix4().makeTranslation(end * (P.length / 2 - 0.6), P.freeboard + 3.25, 0).scale(new THREE.Vector3(1, 6.5, 1)));
    // flags fly inboard of each pole, above the lamp board, face +Z
    flagParts.push(new THREE.Matrix4().makeTranslation(end * (P.length / 2 - 0.6) - end * 1.15, P.freeboard + 5.6, 0.05).scale(new THREE.Vector3(2.2, 1.4, 1)));
  }
  // the lamp board between the poles: five reds in a row and a green above them
  const boardParts = [new THREE.Matrix4().makeTranslation(0, P.freeboard + 3.2, 0).scale(new THREE.Vector3(4.6, 1.9, 0.18))];
  for (const post of [-1.8, 1.8]) steelParts.push(new THREE.Matrix4().makeTranslation(post, P.freeboard + 1.15, 0).scale(new THREE.Vector3(1, 2.3, 1)));
  const parts = ([
    ['start-pontoon-hulls', hullGeo, paint, hullParts, true],
    ['start-pontoon-steel', poleGeo, steel, steelParts, false],
    ['start-pontoon-flags', flagGeo, flag, flagParts, false],
    ['start-pontoon-boards', boxGeo, board, boardParts, false],
  ] as const).map(([name, geo, mat, local, shadow]) => {
    const mesh = own(new THREE.InstancedMesh(geo, mat, Math.max(1, pontoons.length * local.length)));
    mesh.name = name;
    mesh.count = pontoons.length * local.length;
    mesh.castShadow = shadow;
    mesh.receiveShadow = shadow;
    root.add(mesh);
    return { mesh, local };
  });
  const pontoonPoses = pontoons.map((sp) => ({ at: sp.at, yaw: sp.yaw, heave: 0, matrix: new THREE.Matrix4() }));
  const up = new THREE.Vector3(0, 1, 0);
  const place = (): void => {
    pontoonPoses.forEach((p, k) => {
      p.matrix.makeRotationAxis(up, p.yaw).setPosition(p.at[0], p.heave, p.at[1]);
      for (const part of parts) part.local.forEach((local, i) => part.mesh.setMatrixAt(k * part.local.length + i, m4.multiplyMatrices(p.matrix, local)));
    });
    for (const part of parts) part.mesh.instanceMatrix.needsUpdate = true;
  };
  place();
  // frustum culling on the instances' union, padded for the heave (the sphere is computed once)
  for (const mesh of [...parts.map((q) => q.mesh), lamps]) {
    mesh.computeBoundingSphere();
    if (mesh.boundingSphere) mesh.boundingSphere.radius += 3;
  }
  root.add(lamps);
  const lampLocal: THREE.Vector3[] = [];
  for (let i = 0; i < LAMPS; i++) lampLocal.push(new THREE.Vector3(-1.72 + i * 0.86, P.freeboard + 2.85, 0.16));
  lampLocal.push(new THREE.Vector3(0, P.freeboard + 3.75, 0.16));
  const col = new THREE.Color();
  const v = new THREE.Vector3();

  // ── pace rig ───────────────────────────────────────────────────────────────────
  const R = PACE_RIG;
  const rig = new THREE.Group();
  rig.name = 'pace-rig';
  rig.visible = false;
  const mast = new THREE.Mesh(poleGeo, steel);
  mast.scale.set(1.2, R.mastHeight, 1.2);
  mast.position.set(0, R.deckY + R.mastHeight / 2, R.mastZ);
  mast.castShadow = true;
  rig.add(mast);
  const followMe = new THREE.Mesh(flagGeo, flag);
  followMe.scale.set(R.board.w, R.board.h, 1);
  // facing aft (−z) at the grid, hung just under the strobe
  followMe.rotation.y = Math.PI;
  followMe.position.set(0, R.deckY + R.mastHeight - R.board.h / 2 - 0.45, R.mastZ - 0.12);
  followMe.castShadow = true;
  rig.add(followMe);
  const strobeMat = own(new THREE.MeshBasicNodeMaterial({ color: AMBER.clone().multiplyScalar(OFF * LAMP_HDR) }));
  const strobe = new THREE.Mesh(lampGeo, strobeMat);
  strobe.scale.setScalar(R.strobeRadius);
  strobe.position.set(0, R.deckY + R.mastHeight + R.strobeRadius, R.mastZ);
  rig.add(strobe);
  root.add(rig);

  return {
    group: root,
    update(f) {
      const lit = f.startLamps ?? 0;
      if (f.waterHeightAt) {
        const kk = 1 - Math.exp(-Math.max(f.dt, 0) / 0.8);
        for (const p of pontoonPoses) p.heave += (f.waterHeightAt(p.at[0], p.at[1]) - p.heave) * kk;
        place();
      }
      pontoonPoses.forEach((p, k) => {
        lampLocal.forEach((local, i) => {
          v.copy(local).applyMatrix4(p.matrix);
          m4.makeScale(0.26, 0.26, 0.26).setPosition(v);
          lamps.setMatrixAt(k * (LAMPS + 1) + i, m4);
          const on = i < LAMPS ? !f.startGreen && lit > i : !!f.startGreen;
          col.copy(i < LAMPS ? RED : GREEN).multiplyScalar((on ? 1 : OFF) * LAMP_HDR);
          lamps.setColorAt(k * (LAMPS + 1) + i, col);
        });
      });
      lamps.instanceMatrix.needsUpdate = true;
      if (lamps.instanceColor) lamps.instanceColor.needsUpdate = true;

      const pose = f.pace;
      rig.visible = !!pose && [pose.x, pose.z, pose.yaw].every(Number.isFinite);
      if (pose && rig.visible) {
        const y = f.waterHeightAt ? f.waterHeightAt(pose.x, pose.z) : 0;
        rig.position.set(pose.x, Number.isFinite(y) ? y : 0, pose.z);
        rig.rotation.y = pose.yaw;
        followMe.rotation.z = Math.sin(f.time * 2.3) * 0.04;
        strobeMat.color.copy(AMBER).multiplyScalar(strobeLevel(f.time) * LAMP_HDR);
      }
    },
    dispose() {
      root.removeFromParent();
      for (const d of disposables) d.dispose();
    },
  };
}
