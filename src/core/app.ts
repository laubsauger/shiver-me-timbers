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
    /**
     * §V.39 REQUIRES GPU timestamp queries, and they are IMPOSSIBLE unless this
     * is set BEFORE `init()`: three only requests the `timestamp-query` device
     * feature at device creation, so flipping it later leaves
     * `renderer.info.render.timestamp` permanently 0 — measured, 0 valid
     * samples over 4 resolves. That is a silent failure of the one measurement
     * method the invariant allows, and it left an agent unable to cost its own
     * change at all: wall clock is void in a hidden tab (§B.25) and the
     * timestamp path returned nothing.
     *
     * Cheap when unused — the queries are only resolved by an explicit
     * `resolveTimestampsAsync()` call — so it stays on rather than behind a
     * flag nobody remembers to set before the measurement they need it for.
     */
    // untyped-narrow (T2): the field is real on WebGPURenderer at runtime and
    // read by `Renderer.init()`, but three's .d.ts does not declare it
    (renderer as unknown as { trackTimestamp: boolean }).trackTimestamp = true;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    // NOTE: shadow-map variant compilation of the huge ocean/ship TSL
    // materials stalled the GPU process (black screen, frozen rAF) — under
    // investigation; re-enable via this flag once isolated (§B candidate)
    renderer.shadowMap.enabled = SHADOWS_ENABLED;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    await renderer.init();

    // §T.40 fail-loud: the GPU process died three times in one boot session
    // and left NO trace — three swallows the loss (`_isDeviceLost` just makes
    // every later call a silent no-op) and the page simply stops updating,
    // which reads as a hang rather than a crash. Both hooks are diagnostic
    // only: nothing here changes rendering.
    const device = (renderer.backend as { device?: GPUDevice }).device;
    if (device !== undefined) {
      void device.lost.then((info) => {
        console.error(`[gpu] DEVICE LOST (${info.reason || 'unknown'}): ${info.message}`);
        (window as unknown as Record<string, unknown>).__gpuLost = {
          reason: info.reason,
          message: info.message,
          at: performance.now(),
        };
      });
      // validation/out-of-memory errors that no one awaited. A pipeline that
      // fails to create is otherwise invisible: the material just never draws.
      device.addEventListener('uncapturederror', (event) => {
        console.error('[gpu] uncaptured error:', (event as GPUUncapturedErrorEvent).error.message);
      });
    }

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
