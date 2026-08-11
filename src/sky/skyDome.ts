/**
 * TSL gradient sky dome (§V16 — every knob is a uniform fed from sky params).
 *
 * Technique note: three ships SkyMesh (Preetham analytic scattering) which
 * does run on WebGPURenderer, but its physically-derived turbidity/Rayleigh
 * look fights the painterly SoT reference — milky haze band, saturated flat
 * zenith, big soft glow. A custom dome is ~60 lines of TSL and every term is
 * art-directable, so we build our own: horizon haze → zenith gradient, an
 * analytic sun disc + glow from the sun direction uniform, and a warm tint
 * hugging the horizon on the sun's side.
 *
 * Large BackSide sphere, fog-immune (material.fog = false), drawn behind
 * everything (depthWrite off). View direction is taken camera-relative so
 * the gradient never shifts as the camera translates.
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
import { hexToRgb, lowSunWarmth, skyTint, sunColor, type Rgb, type Vec3 } from './sunCycle';

function tinted(hex: number, tint: Rgb): THREE.Color {
  const c = hexToRgb(hex);
  return new THREE.Color(c[0] * tint[0], c[1] * tint[1], c[2] * tint[2]);
}

export function createSkyDome(p: SkyParams) {
  const uSunDir = uniform(new THREE.Vector3(0, 1, 0));
  const uSunColor = uniform(new THREE.Color());
  const uZenith = uniform(new THREE.Color());
  const uHaze = uniform(new THREE.Color());
  const uWarm = uniform(new THREE.Color(p.horizonWarmColor));
  const uHazeStrength = uniform(p.hazeStrength);
  const uHazeFalloff = uniform(p.hazeFalloff);
  const uWarmAmount = uniform(0);
  const uGradCurve = uniform(p.gradientCurve);
  // disc thresholds precomputed CPU-side as cosines (cheap dot compare)
  const uDiscCosOuter = uniform(1);
  const uDiscCosInner = uniform(1);
  const uGlowPower = uniform(p.sunGlowPower);
  const uGlowStrength = uniform(p.sunGlowStrength);

  const material = new THREE.MeshBasicNodeMaterial();
  material.side = THREE.BackSide;
  material.depthWrite = false;
  material.fog = false; // the dome IS the haze; scene fog must not eat it

  const viewDir = positionWorld.sub(cameraPosition).normalize();
  const up = viewDir.y.max(0);

  // horizon→zenith gradient with an exponential haze band hugging y≈0
  // NOTE §B.1: functional mix(a,b,t) ONLY — chained a.mix(b,t) reads the
  // receiver as the factor (mixElement) and silently inverts the blend.
  const zenithMix = up.pow(uGradCurve);
  const grad = mix(vec3(uHaze), vec3(uZenith), zenithMix);
  const hazeAmt = up.div(uHazeFalloff).negate().exp().mul(uHazeStrength);
  const hazed = mix(grad, vec3(uHaze), hazeAmt.clamp(0, 1));

  // warm tint: strongest in the haze band on the sun's side of the sky
  const d = viewDir.dot(uSunDir);
  const sunSide = d.mul(0.5).add(0.5);
  const warmMask = hazeAmt.clamp(0, 1).mul(sunSide).mul(uWarmAmount);
  const warmed = mix(hazed, vec3(uWarm), warmMask);

  // analytic sun: hard-ish disc + wide soft glow, both additive
  const disc = smoothstep(uDiscCosOuter, uDiscCosInner, d);
  const glow = d.clamp(0, 1).pow(uGlowPower).mul(uGlowStrength);
  material.colorNode = warmed.add(vec3(uSunColor).mul(disc.add(glow)));

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(p.domeRadius, 48, 24), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000; // paint first so transparent passes layer on top

  return {
    mesh,
    material,
    uniforms: { uSunDir, uSunColor, uZenith, uHaze, uWarm, uHazeStrength, uWarmAmount },
    /** re-derive all ramp-driven uniforms for a new sun state */
    update(sunDir: Vec3, elevation: number): void {
      uSunDir.value.set(sunDir[0], sunDir[1], sunDir[2]);
      const tint = skyTint(elevation);
      const sun = sunColor(elevation);
      uZenith.value.copy(tinted(p.zenithColor, tint));
      uHaze.value.copy(tinted(p.horizonColor, tint));
      uWarm.value.setRGB(...hexToRgb(p.horizonWarmColor));
      uSunColor.value.setRGB(sun[0], sun[1], sun[2]);
      uWarmAmount.value = p.horizonWarmStrength * lowSunWarmth(elevation);
      uHazeStrength.value = p.hazeStrength;
      uHazeFalloff.value = p.hazeFalloff;
      uGradCurve.value = p.gradientCurve;
      uGlowPower.value = p.sunGlowPower;
      uGlowStrength.value = p.sunGlowStrength;
      const outer = THREE.MathUtils.degToRad(p.sunDiscSize + p.sunDiscSoftness);
      const inner = THREE.MathUtils.degToRad(p.sunDiscSize);
      uDiscCosOuter.value = Math.cos(outer);
      uDiscCosInner.value = Math.cos(inner);
    },
    dispose(): void {
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}

export type SkyDome = ReturnType<typeof createSkyDome>;
