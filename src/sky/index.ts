/**
 * Sky system entry (§V16). Integration surface:
 *
 *   const sky = createSky({ scene });
 *   sky.configureRenderer(renderer);      // ACESFilmic + exposure, once
 *   sky.update(timeOfDay);                // per frame or on param change
 *   sky.sunDirection                      // THREE.Vector3, live, normalized
 *   sky.sunLight                          // THREE.DirectionalLight (the sun)
 *   sky.dispose();
 *
 * update() re-derives sun direction from skyParams.latitude, then drives the
 * dome uniforms, light rig, and scene fog color in lockstep — one time value
 * moves the entire scene's light.
 */
import * as THREE from 'three/webgpu';
import { skyParams } from '../params/sky';
import { createLighting } from './lighting';
import { createSkyDome } from './skyDome';
import { sunDirection as computeSunDirection, sunElevation } from './sunCycle';

export interface SkyHandle {
  update(timeOfDay: number): void;
  /** live normalized world-space direction toward the sun */
  sunDirection: THREE.Vector3;
  sunLight: THREE.DirectionalLight;
  configureRenderer(renderer: THREE.WebGPURenderer): void;
  dispose(): void;
}

export function createSky(opts: { scene: THREE.Scene }): SkyHandle {
  const { scene } = opts;
  const dome = createSkyDome(skyParams);
  const rig = createLighting(scene, skyParams);
  scene.add(dome.mesh);

  const sunDirection = new THREE.Vector3(0, 1, 0);

  const handle: SkyHandle = {
    sunDirection,
    sunLight: rig.sunLight,
    update(timeOfDay: number): void {
      const dir = computeSunDirection(timeOfDay, skyParams.latitude);
      const elevation = sunElevation(timeOfDay, skyParams.latitude);
      sunDirection.set(dir[0], dir[1], dir[2]);
      dome.update(dir, elevation);
      rig.update(dir, elevation);
    },
    configureRenderer(renderer: THREE.WebGPURenderer): void {
      rig.configureRenderer(renderer);
    },
    dispose(): void {
      scene.remove(dome.mesh);
      dome.dispose();
      rig.dispose();
    },
  };

  handle.update(skyParams.timeOfDay);
  return handle;
}
