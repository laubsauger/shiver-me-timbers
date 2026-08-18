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
import { keyLight } from './moonCycle';
import { createSkyBackground } from './skyBackground';
import type { WindFrame } from './windLines';

/** the wind the sky is asked to draw — see src/sky/windLines.ts */
export type { WindFrame };

/**
 * Wind the sky falls back to when a caller does not hand it one: none at all.
 *
 * DEAD CALM, NOT THE PARAMS DEFAULT, and that is deliberate. A caller that has
 * no wind to give (the preview page, a test) should get a sky with no wind
 * lines in it rather than a sky quietly drawing the ambient bearing — a
 * fabricated cue is worse than a missing one for a feature whose entire job is
 * to be trusted as an instrument. `speed` 0 is below every onset, so the field
 * is bare; `dt` 0 leaves the drift phases exactly where they were.
 */
const NO_WIND = { direction: 0, speed: 0, dt: 0 } as const;

export interface SkyHandle {
  /**
   * @param wind the LIVE wind (`state.wind`) plus this frame's dt. Optional —
   *             omitting it draws no wind lines at all (see NO_WIND).
   */
  update(timeOfDay: number, wind?: WindFrame): void;
  /**
   * Live normalized world-space direction toward THE KEY — the sun by day,
   * the MOON at night. The name is kept because every consumer in the project
   * reads it (ocean glints, caustics, clouds, god rays, terrain), and that is
   * precisely the point: a moon is a directional source, so re-aiming this
   * one vector hands all of them a moon glint road and moonlit caustics with
   * no changes on their side. See src/sky/moonCycle.ts.
   */
  sunDirection: THREE.Vector3;
  /** THE KEY light. Sun-coloured by day, moon-coloured at night. */
  sunLight: THREE.DirectionalLight;
  /**
   * 0..1 "how dark is it" — THE single clock for every practical light in the
   * world: the ship's lanterns, the lighthouse lamp, hut windows, any
   * emissive that must be off in daylight. Live; refreshed by update().
   *
   * Read this rather than deriving a second dusk from `timeOfDay`. It is a
   * pure function of sun elevation, which `sunCycle` already owns, so there
   * is exactly one clock in the project — two that agree today will drift the
   * moment either is tuned.
   *
   * NOT the same as moonlight: a new-moon night has nightFactor 1 and no moon
   * at all, and that is precisely the night that most needs lamps lit.
   */
  nightFactor: number;
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
    nightFactor: 0,
    sunLight: rig.sunLight,
    skyDomeColor: background.skyDomeColor,
    setShadowFocus: (x, y, z) => rig.setShadowFocus(x, y, z),
    update(timeOfDay: number, wind: WindFrame = NO_WIND): void {
      // ONE call resolves who owns the key — sun, moon, or mid-handover — and
      // both the background and the light rig are driven from that single
      // answer. Deriving it twice is how the sky and the light that lights
      // the scene drift apart (§T39's whole argument for skyPalette).
      const key = keyLight(timeOfDay, skyParams);
      sunDirection.set(key.direction[0], key.direction[1], key.direction[2]);
      handle.nightFactor = key.nightFactor;
      background.update(key, wind);
      rig.update(key);
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
