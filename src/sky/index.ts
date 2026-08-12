/**
 * Sky system entry (§V16). Integration surface — unchanged for main.ts:
 *
 *   const sky = createSky({ scene });
 *   sky.configureRenderer(renderer);      // ACESFilmic + exposure, once
 *   sky.update(timeOfDay);                // per frame or on param change
 *   sky.sunDirection                      // THREE.Vector3, live, normalized
 *   sky.sunLight                          // THREE.DirectionalLight (the sun)
 *   sky.dispose();
 *
 * update() re-derives sun direction from skyParams.latitude, then drives the
 * background uniforms, light rig, and scene fog in lockstep — one time value
 * moves the entire scene's light.
 *
 * The sky renders through `scene.backgroundNode`, so three pins it to the
 * camera itself: no per-frame camera hand-off is needed here and the sky can
 * never fall behind the camera or outside the far plane (§B9).
 */
import * as THREE from 'three/webgpu';
import { skyParams } from '../params/sky';
import { createLighting } from './lighting';
import { createSkyBackground } from './skyBackground';
import { sunDirection as computeSunDirection, sunElevation } from './sunCycle';

export interface SkyHandle {
  update(timeOfDay: number): void;
  /** live normalized world-space direction toward the sun */
  sunDirection: THREE.Vector3;
  sunLight: THREE.DirectionalLight;
  /**
   * The sky's radiance toward an arbitrary world direction, sun disc/glow/halo
   * EXCLUDED — the single source of truth for anything that REFLECTS the sky
   * (see skyBackground.ts). The ocean calls it with its reflection ray; the
   * disc is deliberately absent because the water's specular and glint road
   * already own the sun (§V.26, §T.39).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node union
  skyDomeColor: (dir: any) => any;
  /** keep the sun-shadow frustum centered on the player ship */
  setShadowFocus(x: number, y: number, z: number): void;
  configureRenderer(renderer: THREE.WebGPURenderer): void;
  dispose(): void;
}

export function createSky(opts: { scene: THREE.Scene }): SkyHandle {
  const { scene } = opts;
  const background = createSkyBackground(skyParams);
  const rig = createLighting(scene, skyParams);
  scene.backgroundNode = background.colorNode;

  const sunDirection = new THREE.Vector3(0, 1, 0);

  const handle: SkyHandle = {
    sunDirection,
    sunLight: rig.sunLight,
    skyDomeColor: background.skyDomeColor,
    setShadowFocus: (x, y, z) => rig.setShadowFocus(x, y, z),
    update(timeOfDay: number): void {
      const dir = computeSunDirection(timeOfDay, skyParams.latitude);
      const elevation = sunElevation(timeOfDay, skyParams.latitude);
      sunDirection.set(dir[0], dir[1], dir[2]);
      background.update(dir, elevation);
      rig.update(dir, elevation);
      rig.syncExposure();
    },
    configureRenderer(renderer: THREE.WebGPURenderer): void {
      rig.configureRenderer(renderer);
    },
    dispose(): void {
      scene.backgroundNode = null;
      rig.dispose();
    },
  };

  handle.update(skyParams.timeOfDay);
  return handle;
}
