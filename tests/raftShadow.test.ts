/**
 * THE RAFT'S OWN SHADOW MAP (src/drift/wandering/raftShadow.ts; the 2026-11-03 review of the 56e951c master: "a bit of
 * flickering in the shadows of some of the rigging of the boat when we're about to hit the beach").
 *
 * The film's filter finds a receiver in the raft's map from its coordinates in the Sun's (`sunToRaft`), so the two
 * conventions must agree exactly — three's shadow matrix, its v flip and its bias, each map's own — or every raft
 * shadow lands beside its caster. And the map is only worth having if the rigging is resolved in it where the Sun's
 * coast map could not resolve it, and if its small footprint still holds the raft's long shadows down the light.
 */
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { EXTENT, SIZE, sunToRaft } from '../src/drift/wandering/raftShadow';

/** the coast's raft on its run in (w2, ~548 s): 40 km from the world's origin, the morning Sun 9° up at −125° */
const RAFT = new THREE.Vector3(-40050, 3, 55);
const el = (9 * Math.PI) / 180;
const az = (-125 * Math.PI) / 180;
const SUN = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));

/** a directional light's shadow about `at`, `standoff` m up the light, as three builds its matrix */
function shadowAt(at: THREE.Vector3, standoff: number, extent: number, near: number, far: number): THREE.DirectionalLightShadow {
  const light = new THREE.DirectionalLight();
  const cam = light.shadow.camera;
  Object.assign(cam, { left: -extent, right: extent, top: extent, bottom: -extent, near, far });
  cam.updateProjectionMatrix();
  light.position.copy(at).addScaledVector(SUN, standoff);
  light.target.position.copy(at);
  light.updateMatrixWorld();
  light.target.updateMatrixWorld();
  light.shadow.updateMatrices(light);
  return light.shadow;
}

/** a world point's coordinates in a map as three's ShadowNode hands them to the filter: v flipped, the bias added */
function coord(shadow: THREE.DirectionalLightShadow, bias: number, p: THREE.Vector3): THREE.Vector3 {
  const c = p.clone().applyMatrix4(shadow.matrix);
  return new THREE.Vector3(c.x, 1 - c.y, c.z + bias);
}

describe('the raft shadow map', () => {
  // the Sun's coast map (sea.ts SHADOW_EXTENT.coast 90, sky lighting near 50 .. far 2600, the light 1000 m out) centred
  // on an eye 20 m off the raft, and the raft's own (raftShadow.ts: 40 m up the light, ±EXTENT, to 1500 m down it)
  const sun = shadowAt(new THREE.Vector3(-40040, 0, 70), 1000, 90, 50, 2600);
  const raft = shadowAt(RAFT, 40, EXTENT, 40 - EXTENT, 40 + 1500);
  const sunBias = -0.03 / 2550;
  const raftBias = -0.01 / 1511;
  const m = sunToRaft(sun.matrix, sunBias, raft.matrix, raftBias);

  it('finds every receiver where the raft map has it, from its coordinates in the Sun map', () => {
    // a point on the rig, one on the deck, the sail's foot, and the sand 30 m down the light
    for (const p of [
      RAFT.clone().add(new THREE.Vector3(1.2, 4.5, -0.8)),
      RAFT.clone().add(new THREE.Vector3(-2, -2.6, 3)),
      RAFT.clone().add(new THREE.Vector3(0.4, -1, 2.2)),
      RAFT.clone().addScaledVector(SUN, -30),
    ]) {
      const viaSun = coord(sun, sunBias, p).applyMatrix4(m);
      const direct = coord(raft, raftBias, p);
      // to a hundredth of a raft texel in u, v (the filter's lookups), and a millimetre of depth
      expect(Math.abs(viaSun.x - direct.x) * SIZE).toBeLessThan(0.01);
      expect(Math.abs(viaSun.y - direct.y) * SIZE).toBeLessThan(0.01);
      expect(Math.abs(viaSun.z - direct.z) * 1511).toBeLessThan(0.001);
    }
  });

  it('holds the raft and its long shadow down the light in one footprint', () => {
    // a caster at the truck and the sand its shadow falls on 30 m down the light share (u, v): the raft's map holds
    // its shadow wherever it lands, so the raft's casters can leave the Sun's map entirely
    const truck = RAFT.clone().add(new THREE.Vector3(0.3, 5, 0.2));
    const onSand = truck.clone().addScaledVector(SUN, -30);
    const a = coord(raft, 0, truck);
    const b = coord(raft, 0, onSand);
    expect(Math.abs(a.x - b.x) * SIZE).toBeLessThan(1e-6);
    expect(Math.abs(a.y - b.y) * SIZE).toBeLessThan(1e-6);
    expect(b.z).toBeGreaterThan(a.z);
    // and every corner of the raft (10 m long, 5 m wide, its trucks 8 m up) inside it, at any Sun
    for (const elDeg of [2, 9, 30, 70]) {
      for (const azDeg of [-180, -125, -60, 0, 90]) {
        const e = (elDeg * Math.PI) / 180;
        const z = (azDeg * Math.PI) / 180;
        const dir = new THREE.Vector3(Math.sin(z) * Math.cos(e), Math.sin(e), -Math.cos(z) * Math.cos(e));
        const light = new THREE.DirectionalLight();
        Object.assign(light.shadow.camera, { left: -EXTENT, right: EXTENT, top: EXTENT, bottom: -EXTENT, near: 40 - EXTENT, far: 1540 });
        light.shadow.camera.updateProjectionMatrix();
        light.position.copy(RAFT).addScaledVector(dir, 40);
        light.target.position.copy(RAFT);
        light.updateMatrixWorld();
        light.target.updateMatrixWorld();
        light.shadow.updateMatrices(light);
        for (const [x, y, zz] of [[-2.5, -3, -5], [2.5, -3, 5], [-2.5, 5, 5], [2.5, 5, -5], [0, 5.5, 0]]) {
          const c = coord(light.shadow, 0, RAFT.clone().add(new THREE.Vector3(x, y, zz)));
          expect(c.x).toBeGreaterThan(0.05);
          expect(c.x).toBeLessThan(0.95);
          expect(c.y).toBeGreaterThan(0.05);
          expect(c.y).toBeLessThan(0.95);
          expect(c.z).toBeGreaterThan(0);
        }
      }
    }
  });

  it("resolves the rigging the coast's Sun map could not", () => {
    // the ladder's ropes (pieceGeometryRaft ladder: 3 cm), the main halyard (raftDress: 1.8 cm) in texels: under two
    // in the coast's 8192² over ±90 m — a broken line of texels that re-forms every frame — and three or more here
    const coastTexel = 180 / 8192;
    const raftTexel = (2 * EXTENT) / SIZE;
    expect(0.03 / coastTexel).toBeLessThan(1.5);
    expect(0.018 / coastTexel).toBeLessThan(1);
    expect(0.03 / raftTexel).toBeGreaterThan(5);
    expect(0.018 / raftTexel).toBeGreaterThan(3);
  });
});
