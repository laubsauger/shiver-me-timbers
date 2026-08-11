/**
 * Intersection foam + flow advection (§V10, task T13) — integration surface:
 *
 *   const ff = createFlowFoam();
 *   // per frame, BEFORE the main renderer.render():
 *   ff.setCenter(ship.position.x, ship.position.z);   // region follows ship
 *   ff.setFlowDir([-shipVel.x, -shipVel.z]);          // wake trails behind
 *   ff.setShip([ship.x, ship.z], yaw, speed, bowOff, sternOff, beam); // wake V
 *   ff.renderInjection(renderer, scene);  // ortho capture of foam targets
 *   ff.update(renderer, dt);              // advect + blur compute passes
 *
 * Tag any mesh that should shed waterline foam (ship hull, rocks):
 *   mesh.userData.foamTarget = true;
 *
 * OCEAN MATERIAL SAMPLING (world-space via regionUniforms) — either call
 * `ff.foamSampleNode(worldXZ)` (uv + border fade prebuilt), or by hand in
 * src/ocean/surfaceMaterial.ts colorNode (worldXZ = positionLocal.xz + origin):
 *
 *   const c = ff.regionUniforms.uCenter, s = ff.regionUniforms.uSize;
 *   const uv = vec2(
 *     worldXZ.x.sub(c.x).div(s).add(0.5),
 *     float(0.5).sub(worldXZ.y.sub(c.y).div(s)),   // v flips world z (flowMath.ts)
 *   );
 *   const hullFoam = texture(ff.foamTexture, uv).r;
 *   col.assign(mix(col, uFoam, hullFoam.mul(0.9)));  // §V23 functional mix
 *
 * The screen-space depth-compare mask for the water material itself is
 * `maskNodeFactory` (= intersectionMaskNode) — exact wiring snippet in
 * src/flowfoam/intersectionMask.ts header.
 *
 * §V22: agent/code done ≠ task done — visual verification of the foam trail
 * against docs/flows.png is pending main-thread integration + screenshot.
 */
import type * as THREE from 'three/webgpu';
import { float, smoothstep, texture, uniform, vec2 } from 'three/tsl';
import { flowFoamParams, type FlowFoamParams } from '../params/flowfoam';
import { createFlowNoiseUniforms } from './flowNoise';
import { createAccumulation, FOAM_INJECTION_LAYER } from './accumulation';
import { intersectionMaskNode } from './intersectionMask';
import { createWakeInjector } from './wakeInjection';

export { FOAM_INJECTION_LAYER };
export { intersectionMaskNode, worldIntersectionMaskNode } from './intersectionMask';

export interface FlowFoamOptions {
  params?: FlowFoamParams;
  /** water surface height (world y) for the injection waterline band */
  waterHeight?: number;
}

export function createFlowFoam(opts: FlowFoamOptions = {}) {
  const p = opts.params ?? flowFoamParams;
  const flowU = createFlowNoiseUniforms(p);
  const wake = createWakeInjector(p);
  const acc = createAccumulation(p, flowU, wake.wakeRateNode);
  acc.uniforms.uWaterHeight.value = opts.waterHeight ?? 0;
  const uEdgeFade = uniform(p.edgeFade);
  let time = 0;

  return {
    /** foam region RT (R = foam mask 0..1), stable texture identity */
    get foamTexture(): THREE.StorageTexture {
      return acc.foamTexture;
    },
    /** debug: raw injection capture */
    injectionTexture: acc.injectionTexture,
    /** world→uv anchors for material sampling (snippet in header) */
    regionUniforms: acc.uniforms,
    /** screen-space depth-compare mask factory for the water material (§V10) */
    maskNodeFactory: intersectionMaskNode,

    setCenter: acc.setCenter,
    renderInjection: acc.renderInjection,

    /** base flow direction (world XZ) — normalized; [0,0] disables base drift */
    setFlowDir(d: [number, number]): void {
      const len = Math.hypot(d[0], d[1]);
      if (len > 1e-6) flowU.uFlowDir.value.set(d[0] / len, d[1] / len);
      else flowU.uFlowDir.value.set(0, 0);
    },

    setWaterHeight(h: number): void {
      acc.uniforms.uWaterHeight.value = h;
    },

    /**
     * Analytic ship wake (bow Kelvin V + stern band, wakeInjection.ts):
     * call per tick with ship state; bow/stern offsets + beam come from the
     * ship blueprint AABB (main.ts). Wake foam is injected near the hull and
     * trails naturally via advection + decay.
     */
    setShip: wake.setShip,

    /** advance the sim one fixed tick (§V2): pushes live params, runs computes */
    update(renderer: THREE.WebGPURenderer, dt: number): void {
      time += dt;
      flowU.uTime.value = time;
      flowU.uNoiseScale.value = p.noiseScale;
      flowU.uNoiseStrength.value = p.noiseStrength;
      flowU.uScrollSpeed.value = p.noiseScrollSpeed;
      flowU.uBaseSpeed.value = p.baseFlowSpeed;
      flowU.uCurlStep.value = p.curlStep;
      uEdgeFade.value = p.edgeFade;
      wake.pushParams();
      acc.step(renderer, dt);
    },

    /**
     * Convenience for the ocean material: foam sampled at a world-XZ node,
     * faded to 0 over the outer `edgeFade` fraction of the region so the
     * sliding window border never pops. smoothstep edges are INVERTED
     * (e0 > e1, functional form per §V23) — reads "1 inside, 0 at border",
     * same idiom as surfaceMaterial's distance fades.
     */
    foamSampleNode(worldXZ: any): any {
      const c = acc.uniforms.uCenter;
      const s = acc.uniforms.uSize;
      const u = worldXZ.x.sub(c.x).div(s).add(0.5);
      const v = float(0.5).sub(worldXZ.y.sub(c.y).div(s)); // v flip (flowMath.ts)
      const inner = float(0.5).mul(uEdgeFade.oneMinus());
      const edge = smoothstep(float(0.5), inner, u.sub(0.5).abs()).mul(
        smoothstep(float(0.5), inner, v.sub(0.5).abs()),
      );
      return texture(acc.foamTexture, vec2(u, v)).r.mul(edge);
    },

    dispose(): void {
      acc.dispose();
    },
  };
}

export type FlowFoam = ReturnType<typeof createFlowFoam>;
