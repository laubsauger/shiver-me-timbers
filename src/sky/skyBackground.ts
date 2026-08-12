/**
 * TSL sky as a scene BACKGROUND node (§V16 — every knob is a uniform fed
 * from sky params).
 *
 * WHY NOT A DOME MESH (§B9): this used to be a BackSide SphereGeometry of
 * radius `domeRadius` added at the world origin and never moved. The ship
 * sails away from the origin forever, so the camera drifted off-centre and
 * eventually outside the sphere — at which point the near hemisphere culls
 * away and you see the far interior wall as a giant pale ball hanging behind
 * the ship, with the renderer clear colour (near-black) everywhere else.
 * Even before that, the far side crossed camera.far (5000) and got clipped.
 * `scene.backgroundNode` hands the same shading to three's own background
 * mesh, which is unit-sized, pinned to the camera each frame, drawn first
 * with depthTest/depthWrite off and its vertex z forced to w. Result: the
 * sky is at infinity — no radius, no far-plane interaction, and it cannot
 * disagree with however many kilometres of ocean the water system draws.
 *
 * Technique note: three ships SkyMesh (Preetham analytic scattering) which
 * does run on WebGPURenderer, but its physically-derived turbidity/Rayleigh
 * look fights the painterly SoT reference — milky haze band, saturated flat
 * zenith, big soft glow. A hand-authored 3-stop gradient is ~40 lines of TSL
 * and every term is art-directable, so we build our own.
 */
import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  mix,
  positionWorld,
  smoothstep,
  uniform,
  vec3,
} from 'three/tsl';
import type { SkyParams } from '../params/sky';
import {
  hexToRgb,
  skyPalette,
  skyTint,
  sunColor,
  sunDiscCosines,
  type Rgb,
  type Vec3,
} from './sunCycle';

/** sRGB triple × a 0..1 tint ramp → a linear-working-space three.Color */
function tinted(c: Rgb, tint: Rgb): THREE.Color {
  // setRGB with SRGBColorSpace does the transfer function; passing raw sRGB
  // numbers into the default (linear) working space is §B9, the white wash.
  return new THREE.Color().setRGB(
    c[0] * tint[0],
    c[1] * tint[1],
    c[2] * tint[2],
    THREE.SRGBColorSpace,
  );
}

/** floor for any shader divisor (§V28) */
const EPS = 1e-3;

export function createSkyBackground(p: SkyParams) {
  const uSunDir = uniform(new THREE.Vector3(0, 1, 0));
  const uSunColor = uniform(new THREE.Color());
  const uZenith = uniform(new THREE.Color());
  const uMid = uniform(new THREE.Color());
  const uHaze = uniform(new THREE.Color());
  const uWarm = uniform(new THREE.Color());
  const uHazeStrength = uniform(p.hazeStrength);
  const uHazeFalloff = uniform(p.hazeFalloff);
  const uSunHaze = uniform(p.sunHazeStrength);
  const uWarmAmount = uniform(0);
  const uGradCurve = uniform(p.gradientCurve);
  // disc thresholds precomputed CPU-side as cosines (cheap dot compare)
  const uDiscCosOuter = uniform(1);
  const uDiscCosInner = uniform(1);
  const uDiscIntensity = uniform(p.sunDiscIntensity);
  const uGlowPower = uniform(p.sunGlowPower);
  const uGlowStrength = uniform(p.sunGlowStrength);
  const uHaloPower = uniform(p.sunHaloPower);
  const uHaloStrength = uniform(p.sunHaloStrength);

  // three pins the background mesh to the camera (matrixWorld.copyPosition),
  // so world position minus camera position is exactly the view ray.
  const viewDir = positionWorld.sub(cameraPosition).normalize();
  const lift = viewDir.y.max(0); // sin(elevation), 0 at and below the horizon

  // NOTE §B1/§V23: functional mix(a,b,t) ONLY — chained a.mix(b,t) reads the
  // RECEIVER as the factor (mixElement) and silently inverts the blend.

  // 1. sky body: mid blue → zenith blue with height
  const height = lift.pow(uGradCurve.max(EPS));
  const body = mix(vec3(uMid), vec3(uZenith), height);

  // 2. haze band: exponential wedge hugging the horizon, thickened on the
  //    sun's side (forward scattering makes the sun's quarter of the sky
  //    paler — visible in docs/final-full-result.png)
  const d = viewDir.dot(uSunDir);
  const sunSide = d.mul(0.5).add(0.5);
  const band = lift.div(uHazeFalloff.max(EPS)).negate().exp().clamp(0, 1);
  const hazeAmt = band.mul(uHazeStrength.add(sunSide.mul(uSunHaze))).clamp(0, 1);
  const hazed = mix(body, vec3(uHaze), hazeAmt);

  // 3. golden-hour warmth, strongest in the band on the sun's side
  const warmMask = band.mul(sunSide.pow(2)).mul(uWarmAmount).clamp(0, 1);
  const warmed = mix(hazed, vec3(uWarm), warmMask);

  // 4. analytic sun: HDR disc + tight glow + wide halo, all additive.
  //    smoothstep(e0,e1,x) functional form; e0 = cos(outer) < e1 = cos(inner)
  //    because cosine falls as the angle grows.
  const disc = smoothstep(uDiscCosOuter, uDiscCosInner, d).mul(uDiscIntensity);
  const toSun = d.clamp(0, 1); // clamp before pow — negative base = NaN (§V28)
  const glow = toSun.pow(uGlowPower.max(EPS)).mul(uGlowStrength);
  const halo = toSun.pow(uHaloPower.max(EPS)).mul(uHaloStrength);
  const colorNode = warmed.add(vec3(uSunColor).mul(disc.add(glow).add(halo)));

  return {
    colorNode,
    uniforms: { uSunDir, uSunColor, uZenith, uMid, uHaze, uWarm },
    /** re-derive all ramp-driven uniforms for a new sun state */
    update(sunDir: Vec3, elevation: number): void {
      uSunDir.value.set(sunDir[0], sunDir[1], sunDir[2]);
      const tint = skyTint(elevation);
      const sun = sunColor(elevation);
      // one palette for sky + fog + ambient, crossfaded to golden hour (§T39)
      const pal = skyPalette(elevation, p);
      uZenith.value.copy(tinted(pal.zenith, tint));
      uMid.value.copy(tinted(pal.mid, tint));
      uHaze.value.copy(tinted(pal.horizon, tint));
      uWarm.value.copy(tinted(hexToRgb(p.horizonWarmColor), tint));
      uSunColor.value.setRGB(sun[0], sun[1], sun[2], THREE.SRGBColorSpace);
      uWarmAmount.value = p.horizonWarmStrength * pal.warm;
      uHazeStrength.value = p.hazeStrength;
      uHazeFalloff.value = p.hazeFalloff;
      uSunHaze.value = p.sunHazeStrength;
      uGradCurve.value = p.gradientCurve;
      uDiscIntensity.value = p.sunDiscIntensity;
      uGlowPower.value = p.sunGlowPower;
      uGlowStrength.value = p.sunGlowStrength;
      uHaloPower.value = p.sunHaloPower;
      uHaloStrength.value = p.sunHaloStrength;
      const [outer, inner] = sunDiscCosines(p.sunDiscSize, p.sunDiscSoftness);
      uDiscCosOuter.value = outer;
      uDiscCosInner.value = inner;
    },
  };
}

export type SkyBackground = ReturnType<typeof createSkyBackground>;
