import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { readFileSync } from 'node:fs';
import { cockpitLightMount, createCockpitLights } from '../src/speedboat/page/cockpitLights';

function authoredRoot(): THREE.Object3D {
  const buffer = readFileSync(new URL('../assets/models/speedboat_hero.glb', import.meta.url));
  const json = JSON.parse(buffer.subarray(20, 20 + buffer.readUInt32LE(12)).toString());
  const node = json.nodes.find((n: { extras?: { partsAnchors?: string } }) => n.extras?.partsAnchors);
  const root = new THREE.Group(); root.userData = node.extras;
  return root;
}

describe('cockpit courtesy light', () => {
  it('mounts below the authored arch and follows hero translation and rotation', () => {
    const hero = authoredRoot(), rival = authoredRoot(), scene = new THREE.Scene();
    scene.add(hero, rival);
    const mount = cockpitLightMount(hero, hero.userData.deckY);
    const anchors = JSON.parse(hero.userData.partsAnchors);
    expect(mount.y).toBeCloseTo(hero.userData.deckY + 0.855, 6);
    expect(mount.z).toBeCloseTo(anchors.archZ - 0.259, 6);
    const rig = createCockpitLights([hero, rival], hero.userData.deckY);
    const colors = [new THREE.Color(0xff6622), new THREE.Color(0x2266ff)];
    try {
      hero.position.set(100, 2, -30); hero.rotation.y = Math.PI / 2;
      rig.update(1, colors);
      expect(rig.light.position.distanceTo(hero.localToWorld(mount.clone()))).toBeLessThan(1e-8);
      expect(rig.light.target.position.y).toBeLessThan(rig.light.position.y);
      expect(rig.light.parent).toBeNull(); // sea/terrain must not evaluate this light
      expect(rig.light.intensity).toBe(2.5);
      expect(rig.light.color.equals(colors[0])).toBe(true);
      for (const [i, boat] of [hero, rival].entries()) {
        const fixture = boat.getObjectByName('cockpit-led-diffuser') as THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>;
        expect(fixture.material.color.equals(colors[i].clone().multiplyScalar(1.5))).toBe(true);
      }
      expect(hero.getObjectByName('cockpit-led-diffuser')?.visible).toBe(true);
      rig.update(0, colors);
      expect(rig.light.intensity).toBe(0);
      expect(rival.getObjectByName('cockpit-led-diffuser')?.visible).toBe(false);
      hero.visible = false; rig.update(1, colors);
      expect(rig.light.intensity).toBe(0);
    } finally { rig.dispose(); }
    expect(hero.getObjectByName('cockpit-led-diffuser')).toBeUndefined();
    expect(rival.getObjectByName('cockpit-led-diffuser')).toBeUndefined();
  });

  it('rejects missing arch coordinates instead of guessing a mount', () => {
    const root = new THREE.Group(); root.userData.partsAnchors = '{}';
    expect(() => cockpitLightMount(root, 0.5)).toThrow('authored roll-arch anchors');
  });
});
