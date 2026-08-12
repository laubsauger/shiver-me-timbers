/**
 * Sun + ambient light rig driven by sun elevation (§V16 tunables in params).
 * One DirectionalLight is THE sun — every system that reads light direction
 * (ocean sparkle, cloud sunlight channel) keys off it — plus a
 * HemisphereLight for sky/sea bounce so shadows stay airy, not black.
 *
 * Colour space (§B9): params are authored in sRGB against the reference
 * screenshots, so every write into a three.Color goes through
 * setRGB(..., SRGBColorSpace). Writing raw sRGB numbers into the default
 * linear working space brightens everything ~2× and desaturates it — that
 * is what turned the sky and the far ocean into a white wash.
 *
 * Fog sync: scene fog is atmospheric distance haze, not a view-distance cap
 * (§V30). Colour follows the tinted horizon haze (warm-shifted at low sun)
 * so distant geometry melts into the sky; range comes from params so it can
 * be pushed out to match however far the ocean actually draws. The scene's
 * Fog object itself is constructed in core/app.ts — we only drive it.
 *
 * Tone mapping choice (applied via configureRenderer): ACESFilmic, not AgX.
 * AgX's strong desaturation kills the punchy turquoise/cobalt of the SoT
 * reference; ACES keeps saturated brights and rolls off sun glints softly,
 * which reads as painterly-bright. Exposure is a param.
 */
import * as THREE from 'three/webgpu';
import type { SkyParams } from '../params/sky';
import { shadowTexelSize, snapShadowCenter } from './shadowMath';
import {
  daylight,
  fogRange,
  hemisphereColors,
  lowSunWarmth,
  skyPalette,
  skyTint,
  sunColor,
  type Rgb,
  type Vec3,
} from './sunCycle';

function mulRgb(c: Rgb, tint: Rgb): Rgb {
  return [c[0] * tint[0], c[1] * tint[1], c[2] * tint[2]];
}

/** write an sRGB triple into a three.Color (converts to working space) */
function setSrgb(target: THREE.Color, rgb: Rgb): void {
  target.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
}

/**
 * Write an ALREADY-LINEAR triple. The bare setRGB overload writes the
 * working (linear) space with no transfer function — the very thing that
 * caused §B9 when it was fed sRGB numbers. Only use this for values that
 * were computed in light space on purpose, i.e. hemisphereColors().
 */
function setLinear(target: THREE.Color, rgb: Rgb): void {
  target.setRGB(rgb[0], rgb[1], rgb[2]);
}

export function createLighting(scene: THREE.Scene, p: SkyParams) {
  const sunLight = new THREE.DirectionalLight(0xffffff, p.sunIntensity);
  const hemi = new THREE.HemisphereLight(0xffffff, p.groundBounceColor, p.ambientIntensity);
  scene.add(sunLight);
  scene.add(sunLight.target);
  scene.add(hemi);

  // Dynamic shadows: sun casts, ortho frustum tracks a follow target so the
  // ship (sails → deck → water) always sits inside the shadow map.
  //
  // BIAS CONTRACT (§V16 — all four knobs are params, do not re-hardcode):
  // normalBias offsets the shadow lookup along the RECEIVER normal in world
  // metres, so it silently deletes the contact shadow of anything thinner
  // than itself. At the old 0.5 m every deck fixture vanished — rail posts
  // are 0.09 m, cannons 0.9 m — which is exactly the "installations cast no
  // shadow" report. The principled value is ~1-2 shadow texels: at
  // extent 80 / map 2048 a texel is 2*80/2048 = 7.8 cm, so 0.04 sits just
  // under one texel and still clears acne on the near-flat deck. If acne
  // returns, raise this toward 0.08 or push `shadowBias` more negative —
  // do NOT go back to half a metre.
  sunLight.castShadow = true;
  // mapSize is read ONCE here: three allocates the depth texture from it,
  // so changing it at runtime needs a map dispose + reload to take effect.
  sunLight.shadow.mapSize.set(p.shadowMapSize, p.shadowMapSize);
  const sc = sunLight.shadow.camera;
  sc.near = 50;
  sc.far = 2600;
  let appliedExtent = 0;

  const followTarget = new THREE.Vector3();
  const hazeColor = new THREE.Color();
  let renderer: THREE.WebGPURenderer | null = null;

  return {
    sunLight,
    hemi,
    /** shadow frustum follows this point (the player ship) */
    setShadowFocus(x: number, y: number, z: number): void {
      followTarget.set(x, y, z);
    },
    /** move + recolor lights and sync fog for a new sun state */
    update(sunDir: Vec3, elevation: number): void {
      // live shadow tuning: bias/normalBias are plain numbers, but a changed
      // ortho extent needs the projection rebuilt — only when it moves
      sunLight.shadow.bias = p.shadowBias;
      sunLight.shadow.normalBias = p.shadowNormalBias;
      if (p.shadowExtent !== appliedExtent) {
        appliedExtent = Math.max(1, p.shadowExtent);
        sc.left = -appliedExtent;
        sc.right = appliedExtent;
        sc.top = appliedExtent;
        sc.bottom = -appliedExtent;
        sc.updateProjectionMatrix();
      }
      // Texel-snap the frustum centre before placing the light. Following
      // the ship at continuous coordinates slides the shadow map's texel
      // grid under the scene every frame, which makes every shadow edge
      // crawl; quantising to whole texels makes the map move in discrete
      // steps so a static edge keeps landing on the same texels. Snap
      // against the ALLOCATED map size, not the param — mapSize only takes
      // effect on reload, and snapping to a grid the renderer isn't using
      // would leave the flicker exactly as it was.
      const texel = shadowTexelSize(appliedExtent, sunLight.shadow.mapSize.x);
      const [cx, cy, cz] = snapShadowCenter(
        [followTarget.x, followTarget.y, followTarget.z],
        sunDir,
        texel,
      );
      sunLight.position.set(
        cx + sunDir[0] * p.sunDistance,
        cy + sunDir[1] * p.sunDistance,
        cz + sunDir[2] * p.sunDistance,
      );
      sunLight.target.position.set(cx, cy, cz);
      const sun = sunColor(elevation);
      const day = daylight(elevation);
      setSrgb(sunLight.color, sun);
      sunLight.intensity = p.sunIntensity * day;

      const tint = skyTint(elevation);
      const pal = skyPalette(elevation, p);
      // Hemisphere ambient is IRRADIANCE, not the painted sky (see
      // desaturate()'s header — this is the teal-hull bug). Two corrections:
      //   1. the sky half uses midColor, not zenithColor. A surface facing
      //      up integrates the whole dome weighted by sinθcosθ, which peaks
      //      around 45° elevation — the sky's bulk colour, not its darkest
      //      point straight overhead.
      //   2. both halves are desaturated, because a diffuse bounce (and a
      //      whole-sky integral) is always less saturated than the surface
      //      it came from. This light is never shadowed, so whatever hue
      //      bias survives here is applied to every shaded pixel in the
      //      scene with nothing to counteract it.
      const ambient = hemisphereColors(pal.mid, pal.ground, tint, p.ambientDesaturation);
      setLinear(hemi.color, ambient.sky);
      setLinear(hemi.groundColor, ambient.ground);
      // moonless-night floor of 15% keeps silhouettes readable after dark
      hemi.intensity = p.ambientIntensity * (0.15 + 0.85 * day);

      // Fog colour must equal what the SKY paints at eye level, or the far
      // water meets the horizon on a visible seam. The background node
      // renders mix(midColor, horizonColor, hazeStrength) at viewDir.y = 0,
      // so reproduce that exact blend here, then warm it at golden hour.
      const mid = mulRgb(pal.mid, tint);
      const band = mulRgb(pal.horizon, tint);
      const h = Math.min(1, Math.max(0, p.hazeStrength));
      const w = 0.35 * lowSunWarmth(elevation);
      const haze: Rgb = [
        mid[0] + (band[0] - mid[0]) * h,
        mid[1] + (band[1] - mid[1]) * h,
        mid[2] + (band[2] - mid[2]) * h,
      ];
      setSrgb(hazeColor, [
        haze[0] + (sun[0] - haze[0]) * w,
        haze[1] + (sun[1] - haze[1]) * w,
        haze[2] + (sun[2] - haze[2]) * w,
      ]);
      const fog = scene.fog;
      if (fog) {
        fog.color.copy(hazeColor);
        // linear Fog only: keep the range live so it can be pushed out to
        // wherever the ocean's horizon ring actually ends (§V30)
        if ((fog as THREE.Fog).isFog) {
          const [near, far] = fogRange(p.fogNear, p.fogFar);
          (fog as THREE.Fog).near = near;
          (fog as THREE.Fog).far = far;
        }
      }
      // clear colour = haze, so if the sky background ever fails to draw the
      // screen reads as sky instead of a black void (§B9 presented as one)
      renderer?.setClearColor(hazeColor, 1);
    },
    /** ACESFilmic + param exposure — see header for the AgX trade-off */
    configureRenderer(r: THREE.WebGPURenderer): void {
      renderer = r;
      r.toneMapping = THREE.ACESFilmicToneMapping;
      r.toneMappingExposure = p.exposure;
      r.outputColorSpace = THREE.SRGBColorSpace;
      r.setClearColor(hazeColor, 1);
    },
    /** exposure is a live param — keep the renderer in sync each frame */
    syncExposure(): void {
      if (renderer) renderer.toneMappingExposure = p.exposure;
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
