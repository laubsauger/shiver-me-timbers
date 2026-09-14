/**
 * §T.197 DRIVE RIG REST POSE (src/speedboat/assets/driveRig.ts).
 *
 * WHY: the rig takes the outboard and prop nodes off three's auto-update and writes their matrices itself. Before
 * §T.197 it switched auto-update off without composing the node's TRS first and then OVERWROTE the matrix with the
 * steer/trim rotation alone, so any node whose glTF transform is not identity (a rebuilt GLB that parents a drive, a
 * bracket offset baked as a translation) rendered at the origin — outboards out of the water, props off their shafts.
 * Today's hero GLB happens to keep every animated node at identity, so a test on it could never catch that; these
 * nodes carry a deliberate non-identity rest transform.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { createDriveRig } from '../src/speedboat/assets/driveRig';

const DEG = Math.PI / 180;
const STEER_PIVOT: [number, number, number] = [0.66, 0.12, -4.5];
const TRIM_PIVOT: [number, number, number] = [0.66, 0.14, -4.45];
const PROP_PIVOT: [number, number, number] = [0.66, -0.86, -4.92];

function level(): { group: THREE.Group; outboard: THREE.Mesh; prop: THREE.Mesh } {
  const group = new THREE.Group();
  group.name = 'LOD0';
  const outboard = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.2, 0.5));
  outboard.name = 'Outboard_P_LOD0';
  // a rest transform that is NOT identity: a bracket offset, a small toe-in and a scale
  outboard.position.set(0.05, -0.1, 0.2);
  outboard.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 3 * DEG);
  outboard.scale.setScalar(1.02);
  outboard.userData = { steerPivot: STEER_PIVOT, steerAxis: [0, 1, 0], trimPivot: TRIM_PIVOT, trimAxis: [1, 0, 0] };
  const prop = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.05, 8).rotateX(Math.PI / 2).translate(...PROP_PIVOT));
  prop.name = 'Prop_P_LOD0';
  prop.position.set(0, 0, -0.03);
  prop.userData = { pivot: PROP_PIVOT, axis: [0, 0, 1], handed: 1, follows: 'Outboard_P' };
  group.add(outboard, prop);
  return { group, outboard, prop };
}

const trs = (o: THREE.Object3D): THREE.Matrix4 => new THREE.Matrix4().compose(o.position, o.quaternion, o.scale);
const close = (a: THREE.Matrix4, b: THREE.Matrix4, eps = 1e-9): boolean => a.elements.every((v, i) => Math.abs(v - b.elements[i]) <= eps);

describe('§T.197 drive rig keeps each node on its own rest transform', () => {
  it('before any set(): the matrix is the node TRS, not identity (auto-update is off from construction)', () => {
    const { group, outboard, prop } = level();
    createDriveRig([group], new THREE.MeshBasicNodeMaterial());
    expect(outboard.matrixAutoUpdate).toBe(false);
    expect(close(outboard.matrix, trs(outboard))).toBe(true);
    expect(close(prop.matrix, trs(prop))).toBe(true);
  });

  it('steer 0 / trim 0 / prop at rest: every node sits exactly on its rest matrix, however often set() runs', () => {
    const { group, outboard, prop } = level();
    const rig = createDriveRig([group], new THREE.MeshBasicNodeMaterial());
    for (let k = 0; k < 3; k++) rig.set({ steerRad: 0, trimRad: 0, propRpm: [0] }, 1 / 60);
    expect(close(outboard.matrix, trs(outboard))).toBe(true);
    expect(close(prop.matrix, trs(prop))).toBe(true);
  });

  it('steering turns the RESTED node about the body-frame swivel: the pivot stays put, the rest offset is kept', () => {
    const { group, outboard, prop } = level();
    const rig = createDriveRig([group]);
    const rest = trs(outboard);
    rig.set({ steerRad: 20 * DEG, trimRad: 0, propRpm: [0] }, 1 / 60);
    const pivot = new THREE.Vector3(...STEER_PIVOT);
    // the local point the rest transform puts on the swivel is still on the swivel after steering
    const local = pivot.clone().applyMatrix4(rest.clone().invert());
    expect(local.clone().applyMatrix4(outboard.matrix).distanceTo(pivot)).toBeLessThan(1e-9);
    // and the whole motion is a pure rotation about that pivot applied AFTER the rest transform
    const expected = new THREE.Matrix4()
      .makeTranslation(pivot.x, pivot.y, pivot.z)
      .multiply(new THREE.Matrix4().makeRotationY(20 * DEG))
      .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z))
      .multiply(rest);
    expect(close(outboard.matrix, expected, 1e-9)).toBe(true);
    // the prop follows the outboard's motion and keeps its own rest offset
    const propRest = trs(prop);
    const propExpected = new THREE.Matrix4()
      .makeTranslation(pivot.x, pivot.y, pivot.z)
      .multiply(new THREE.Matrix4().makeRotationY(20 * DEG))
      .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z))
      .multiply(propRest);
    expect(close(prop.matrix, propExpected, 1e-9)).toBe(true);
    // back to centre: back on rest
    rig.set({ steerRad: 0, trimRad: 0, propRpm: [0] }, 1 / 60);
    expect(close(outboard.matrix, rest)).toBe(true);
  });
});
