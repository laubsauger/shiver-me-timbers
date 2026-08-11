/**
 * Sun + ambient light rig driven by sun elevation (§V16 tunables in params).
 * One DirectionalLight is THE sun — every system that reads light direction
 * (ocean sparkle, cloud sunlight channel) keys off it — plus a
 * HemisphereLight for sky/sea bounce so shadows stay airy, not black.
 *
 * Fog sync: scene fog color follows the tinted horizon haze (warm-shifted at
 * low sun) so distant geometry melts into the sky dome instead of banding
 * against it — the hazy-horizon look in docs/final-full-result.png.
 *
 * Tone mapping choice (applied via configureRenderer): ACESFilmic, not AgX.
 * AgX's strong desaturation kills the punchy turquoise/cobalt of the SoT
 * reference; ACES keeps saturated brights and rolls off sun glints softly,
 * which reads as painterly-bright. Exposure is a param.
 */
import * as THREE from 'three/webgpu';
import type { SkyParams } from '../params/sky';
import {
  daylight,
  hexToRgb,
  lowSunWarmth,
  skyTint,
  sunColor,
  type Rgb,
  type Vec3,
} from './sunCycle';

function mulRgb(hex: number, tint: Rgb): [number, number, number] {
  const c = hexToRgb(hex);
  return [c[0] * tint[0], c[1] * tint[1], c[2] * tint[2]];
}

export function createLighting(scene: THREE.Scene, p: SkyParams) {
  const sunLight = new THREE.DirectionalLight(0xffffff, p.sunIntensity);
  const hemi = new THREE.HemisphereLight(0xffffff, p.groundBounceColor, p.ambientIntensity);
  scene.add(sunLight);
  scene.add(sunLight.target);
  scene.add(hemi);

  return {
    sunLight,
    hemi,
    /** move + recolor lights and sync fog for a new sun state */
    update(sunDir: Vec3, elevation: number): void {
      sunLight.position.set(
        sunDir[0] * p.sunDistance,
        sunDir[1] * p.sunDistance,
        sunDir[2] * p.sunDistance,
      );
      sunLight.target.position.set(0, 0, 0);
      const sun = sunColor(elevation);
      const day = daylight(elevation);
      sunLight.color.setRGB(sun[0], sun[1], sun[2]);
      sunLight.intensity = p.sunIntensity * day;

      const tint = skyTint(elevation);
      hemi.color.setRGB(...mulRgb(p.zenithColor, tint));
      hemi.groundColor.setRGB(...mulRgb(p.groundBounceColor, tint));
      // moonless-night floor of 15% keeps silhouettes readable after dark
      hemi.intensity = p.ambientIntensity * (0.15 + 0.85 * day);

      // fog → tinted haze, nudged toward the sun color at golden hour
      if (scene.fog) {
        const haze = mulRgb(p.horizonColor, tint);
        const w = 0.35 * lowSunWarmth(elevation);
        scene.fog.color.setRGB(
          haze[0] + (sun[0] - haze[0]) * w,
          haze[1] + (sun[1] - haze[1]) * w,
          haze[2] + (sun[2] - haze[2]) * w,
        );
      }
    },
    /** ACESFilmic + param exposure — see header for the AgX trade-off */
    configureRenderer(renderer: THREE.WebGPURenderer): void {
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = p.exposure;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
    },
    dispose(): void {
      scene.remove(sunLight);
      scene.remove(sunLight.target);
      scene.remove(hemi);
      sunLight.dispose();
      hemi.dispose();
    },
  };
}

export type LightRig = ReturnType<typeof createLighting>;
