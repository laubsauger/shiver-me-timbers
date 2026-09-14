/**
 * Courtesy lighting mounted beneath the authored roll-arch crossbar, in each boat's LED signature colour (§T.209,
 * user review: "the roll-arch light is RED on every boat"): the same `ledColor` the strips and pools use, handed in by
 * page/boatLights.ts. One diffuser material per boat (identical graphs, one pipeline); the spot light is the hero's.
 */
import * as THREE from 'three/webgpu';
import hullJson from '../deepV12.hull.json?raw';

const archHeight: number = JSON.parse(hullJson).renderOnly.cockpit.rollArch.heightAboveDeck;

export function cockpitLightMount(root: THREE.Object3D, deckY: number): THREE.Vector3 {
  const anchors = JSON.parse(root.userData.partsAnchors);
  if (!Number.isFinite(anchors.archZ) || !Number.isFinite(deckY) || !Number.isFinite(archHeight)) {
    throw new Error('Cockpit courtesy light requires finite authored roll-arch anchors');
  }
  // Match roll_arch.py: aft hoop dz=-0.22, top rake=-0.16, tube radius=0.03.
  return new THREE.Vector3(0, deckY + archHeight - 0.045, anchors.archZ - 0.22 * 0.45 - 0.16);
}

export function createCockpitLights(boats: readonly THREE.Object3D[], deckY: number) {
  const mounts = boats.map(boat => cockpitLightMount(boat, deckY));
  const geometry = new THREE.BoxGeometry(0.42, 0.018, 0.025);
  const materials = boats.map(() => {
    const m = new THREE.MeshBasicMaterial({ color: 0x000000 });
    m.name = 'cockpit-led-diffuser';
    return m;
  });
  const fixtures = boats.map((boat, i) => {
    const mesh = new THREE.Mesh(geometry, materials[i]);
    mesh.name = 'cockpit-led-diffuser';
    mesh.position.copy(mounts[i]);
    mesh.visible = false;
    boat.add(mesh);
    return mesh;
  });
  // Kept outside the scene light set; the boat-material light node owns it.
  const light = new THREE.SpotLight(0xffffff, 0, 2.8, Math.PI / 3, 0.8, 2);
  light.name = 'hero-cockpit-courtesy';
  light.castShadow = false;
  const targetLocal = mounts[0].clone().add(new THREE.Vector3(0, -1.2, 0.35));
  return {
    light,
    /** `colors[i]` = boat i's LED colour, linear (page/boatLights.ts `linear`) */
    update(level: number, colors: readonly THREE.Color[]): void {
      for (let i = 0; i < fixtures.length; i++) {
        const c = colors[i];
        if (c) materials[i].color.copy(c).multiplyScalar(1.5 * level);
        fixtures[i].visible = level > 0;
      }
      if (colors[0]) light.color.copy(colors[0]);
      const hero = boats[0];
      hero.updateWorldMatrix(true, false);
      light.position.copy(mounts[0]).applyMatrix4(hero.matrixWorld);
      light.target.position.copy(targetLocal).applyMatrix4(hero.matrixWorld);
      light.updateMatrixWorld(true);
      light.target.updateMatrixWorld(true);
      light.intensity = hero.visible && hero.parent ? 2.5 * level : 0;
    },
    dispose(): void {
      fixtures.forEach(fixture => fixture.removeFromParent());
      geometry.dispose();
      materials.forEach((m) => m.dispose());
      light.dispose();
    },
  };
}
