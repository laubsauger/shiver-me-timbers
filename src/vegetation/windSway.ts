/**
 * TSL wind-sway node factory (T26). Reusable for any vegetation whose
 * geometry bakes the windWeight/phaseOffset attributes (palmGeometry.ts
 * documents the contract). Injects a positionNode offset:
 *   trunk sway    — low-frequency whole-plant bend along the wind direction,
 *                   ∝ windWeight² so bases stay planted and tips ride wide
 *   frond flutter — higher-frequency along-normal wiggle using phaseOffset
 *                   so fronds never move in unison
 * Driven by uniforms {time, windDirection: vec2(xz), windStrength}. All
 * motion tunables come from params/vegetation via syncParams() (§V16 — no
 * shader literal constants).
 */
import * as THREE from 'three/webgpu';
import {
  attribute,
  normalLocal,
  positionLocal,
  sin,
  uniform,
  vec3,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { vegetationParams, type VegetationParams } from '../params/vegetation';

export interface WindSwayOptions {
  /** extra phase node (e.g. per-instance attribute) added to phaseOffset */
  instancePhase?: Node;
  /** amplitude multiplier node (e.g. per-instance sway variation) */
  amplitudeScale?: Node;
  /** params source (defaults to the registered vegetation params) */
  params?: VegetationParams;
}

/**
 * Wire wind sway into `material.positionNode`. Returns the driving uniforms
 * plus helpers; call setWind() + syncParams() once per frame.
 */
export function applyWindSway(material: THREE.NodeMaterial, opts: WindSwayOptions = {}) {
  const p = opts.params ?? vegetationParams;

  const uTime = uniform(0);
  const uWindDir = uniform(new THREE.Vector2(1, 0));
  const uWindStrength = uniform(1);
  const uSwayAmplitude = uniform(p.swayAmplitude);
  const uSwaySpeed = uniform(p.swaySpeed);
  const uSwayHarmonic = uniform(p.swayHarmonic);
  const uSwayHarmonicFreq = uniform(p.swayHarmonicFreq);
  const uPhaseCoupling = uniform(p.phaseCoupling);
  const uFlutterAmplitude = uniform(p.flutterAmplitude);
  const uFlutterFrequency = uniform(p.flutterFrequency);

  const windWeight = attribute('windWeight', 'float');
  const basePhase = attribute('phaseOffset', 'float');
  const phase = opts.instancePhase ? basePhase.add(opts.instancePhase) : basePhase;
  const amplitude = opts.amplitudeScale
    ? uWindStrength.mul(opts.amplitudeScale)
    : uWindStrength;

  // trunk sway: two coupled sines for organic non-looping motion, bending the
  // whole plant along the wind direction, weight² keeps the base planted
  const swayT = uTime.mul(uSwaySpeed).add(phase.mul(uPhaseCoupling));
  const bend = sin(swayT).add(sin(swayT.mul(uSwayHarmonicFreq)).mul(uSwayHarmonic));
  const windDir3 = vec3(uWindDir.x, 0, uWindDir.y);
  const trunkOffset = windDir3.mul(
    bend.mul(uSwayAmplitude).mul(amplitude).mul(windWeight.mul(windWeight)),
  );

  // frond flutter: faster, per-frond phase, pushed along the surface normal
  const flutterT = uTime.mul(uFlutterFrequency).add(phase);
  const flutterOffset = normalLocal.mul(
    sin(flutterT).mul(uFlutterAmplitude).mul(amplitude).mul(windWeight),
  );

  material.positionNode = positionLocal.add(trunkOffset).add(flutterOffset);

  return {
    uTime,
    uWindDir,
    uWindStrength,
    /** push sim wind state into the shader */
    setWind(time: number, windDirection: [number, number], windStrength: number): void {
      uTime.value = time;
      const [x, z] = windDirection;
      const len = Math.hypot(x, z);
      if (len > 1e-6) uWindDir.value.set(x / len, z / len);
      uWindStrength.value = windStrength;
    },
    /** re-read live-tweakable params (Tweakpane mutates them in place) */
    syncParams(): void {
      uSwayAmplitude.value = p.swayAmplitude;
      uSwaySpeed.value = p.swaySpeed;
      uSwayHarmonic.value = p.swayHarmonic;
      uSwayHarmonicFreq.value = p.swayHarmonicFreq;
      uPhaseCoupling.value = p.phaseCoupling;
      uFlutterAmplitude.value = p.flutterAmplitude;
      uFlutterFrequency.value = p.flutterFrequency;
    },
  };
}

export type WindSway = ReturnType<typeof applyWindSway>;
