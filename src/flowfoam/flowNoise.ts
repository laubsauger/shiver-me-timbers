/**
 * Scrolling low-frequency flow vector field (§V10 advection, TSL side).
 * MIRROR CONTRACT: flowMath.flowVectorCpu implements the exact same formulas
 * in pure TS for tests — change one side → change the other.
 *
 * Two offset fbm samples relative to a base sample give forward-difference
 * gradients of a scalar potential ψ (src/terrain/noise.ts fbm); rotating the
 * gradient 90° — v = (∂ψ/∂z, −∂ψ/∂x) — yields a pseudo-curl vector that is
 * divergence-free by construction, so advected foam swirls around instead of
 * piling into sinks. A base directional flow uniform (away from ship
 * velocity / current, set via index.setFlowDir) is added on top, and the
 * potential scrolls along that direction so eddies ride the stream.
 * §V23: only functional 3-arg TSL math (none needed here).
 */
import * as THREE from 'three/webgpu';
import { uniform, vec2 } from 'three/tsl';
import { fbm2 } from '../terrain/noise';
import { FLOW_OCTAVES } from './flowMath';
import type { FlowFoamParams } from '../params/flowfoam';

/** flow-field uniforms — live params are pushed each update (§V16) */
export function createFlowNoiseUniforms(p: FlowFoamParams) {
  return {
    /** normalized base flow direction (world XZ), zero = no base drift */
    uFlowDir: uniform(new THREE.Vector2(0, 1)),
    uTime: uniform(0),
    uNoiseScale: uniform(p.noiseScale),
    uNoiseStrength: uniform(p.noiseStrength),
    uScrollSpeed: uniform(p.noiseScrollSpeed),
    uBaseSpeed: uniform(p.baseFlowSpeed),
    uCurlStep: uniform(p.curlStep),
  };
}

export type FlowNoiseUniforms = ReturnType<typeof createFlowNoiseUniforms>;

/**
 * TSL flow vector (m/s in world XZ) at a world position node.
 * CPU mirror: flowMath.flowVectorCpu.
 */
export function flowVectorNode(worldXZ: any, u: FlowNoiseUniforms): any {
  const scroll = u.uFlowDir.mul(u.uTime.mul(u.uScrollSpeed));
  const pot = (w: any) => fbm2(w.sub(scroll).mul(u.uNoiseScale), FLOW_OCTAVES);
  const p0 = pot(worldXZ);
  const dpdx = pot(worldXZ.add(vec2(u.uCurlStep, 0))).sub(p0).div(u.uCurlStep);
  const dpdz = pot(worldXZ.add(vec2(0, u.uCurlStep))).sub(p0).div(u.uCurlStep);
  return vec2(
    dpdz.mul(u.uNoiseStrength).add(u.uFlowDir.x.mul(u.uBaseSpeed)),
    dpdx.negate().mul(u.uNoiseStrength).add(u.uFlowDir.y.mul(u.uBaseSpeed)),
  );
}
