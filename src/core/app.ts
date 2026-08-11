/**
 * Renderer + scene shell. Owns three.js objects, reads SimState (§V.3).
 */
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export class App {
  readonly renderer: THREE.WebGPURenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  /** temp dev camera control — replaced by follow cam in T10 */
  readonly controls: OrbitControls;

  private constructor(container: HTMLElement, renderer: THREE.WebGPURenderer) {
    this.renderer = renderer;
    container.appendChild(renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9cc8de);
    this.scene.fog = new THREE.Fog(0x9cc8de, 400, 2500);

    this.camera = new THREE.PerspectiveCamera(
      55,
      container.clientWidth / container.clientHeight,
      0.1,
      5000,
    );
    this.camera.position.set(30, 12, 40);

    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.target.set(0, 2, 0);
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.update();

    const sun = new THREE.DirectionalLight(0xfff4e0, 3.0);
    sun.position.set(200, 300, 100);
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight(0xbcd8e8, 0.6));

    window.addEventListener('resize', () => this.onResize(container));
  }

  static async create(container: HTMLElement): Promise<App> {
    const renderer = new THREE.WebGPURenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    await renderer.init();
    return new App(container, renderer);
  }

  private onResize(container: HTMLElement): void {
    const w = container.clientWidth;
    const h = container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }
}
