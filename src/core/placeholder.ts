/**
 * Temp visual placeholder so the scaffold shows something.
 * Deleted when T3/T4 ocean + T8 ship land.
 */
import * as THREE from 'three/webgpu';

export class Placeholder {
  private sea: THREE.Mesh;
  private buoy: THREE.Mesh;

  constructor(scene: THREE.Scene) {
    this.sea = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, 4000),
      new THREE.MeshStandardMaterial({ color: 0x1a5c6e, roughness: 0.35 }),
    );
    this.sea.rotation.x = -Math.PI / 2;
    scene.add(this.sea);

    this.buoy = new THREE.Mesh(
      new THREE.BoxGeometry(4, 4, 8),
      new THREE.MeshStandardMaterial({ color: 0x8a5a2b, roughness: 0.8 }),
    );
    this.buoy.position.y = 2;
    scene.add(this.buoy);
  }

  update(time: number): void {
    this.buoy.position.y = 2 + Math.sin(time * 1.2) * 0.4;
    this.buoy.rotation.z = Math.sin(time * 0.9) * 0.05;
    this.buoy.rotation.x = Math.sin(time * 0.7) * 0.04;
  }
}
