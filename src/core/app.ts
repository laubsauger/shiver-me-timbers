/**
 * Renderer + scene shell. Owns three.js objects, reads SimState (§V.3).
 */
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/** re-enabled after B5 (spray NaN) proved to be the wedge, not shadows */
const SHADOWS_ENABLED = true;

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
    // Sky owns the background (scene.backgroundNode, pinned to the camera at
    // infinity) AND this fog: createSky() overwrites near/far/color from
    // skyParams before the first frame, so these literals are only the
    // pre-sky defaults. Keep them in step with skyParams.fogNear/fogFar —
    // fog must saturate exactly where the water ends: earlier is the "wall of
    // haze" that kills vision range (§V30, user report), later leaves a hard
    // water/sky seam at the horizon.
    this.scene.fog = new THREE.Fog(0xa1e7ff, 700, 4500);

    // far must exceed the ocean clipmap's horizon radius (§V30) — the sea disc
    // now reaches ~4.6km, and the sky is camera-anchored at infinity (§V32) so
    // far is purely a geometry budget, no longer a sky constraint.
    this.camera = new THREE.PerspectiveCamera(
      55,
      container.clientWidth / container.clientHeight,
      0.1,
      8000,
    );
    this.camera.position.set(30, 12, 40);

    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.target.set(0, 2, 0);
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.update();

    // lighting owned by the sky system (src/sky), attached in main.ts

    window.addEventListener('resize', () => this.onResize(container));
  }

  static async create(container: HTMLElement): Promise<App> {
    // The ocean material samples well past WebGPU's DEFAULT 16 sampled
    // textures per stage (3 cascades × displacement+derivatives, foam and its
    // reduced tiers, wake, seabed, shadow map, reflection, viewport colour +
    // depth…). Exceeding it fails pipeline creation outright — the material
    // never draws and the render pass aborts. Adapters commonly allow far
    // more, but you only get it by ASKING at device-request time.
    // Always clamp to what this adapter actually reports (§V.40).
    const requiredLimits: Record<string, number> = {};
    const adapter = await navigator.gpu?.requestAdapter();
    for (const key of [
      'maxSampledTexturesPerShaderStage',
      'maxSamplersPerShaderStage',
      'maxStorageTexturesPerShaderStage',
      'maxUniformBuffersPerShaderStage',
    ] as const) {
      const supported = adapter?.limits?.[key];
      if (typeof supported === 'number') requiredLimits[key] = supported;
    }
    const renderer = new THREE.WebGPURenderer({ antialias: true, requiredLimits });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    // NOTE: shadow-map variant compilation of the huge ocean/ship TSL
    // materials stalled the GPU process (black screen, frozen rAF) — under
    // investigation; re-enable via this flag once isolated (§B candidate)
    renderer.shadowMap.enabled = SHADOWS_ENABLED;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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
