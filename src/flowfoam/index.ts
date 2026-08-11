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
  // Coarse FAR tier: the same analytic wake, accumulated over a region several
  // hundred metres across so the trail does not simply stop at the near
  // region's border (user: "disappearing too immediately... not fading out over
  // a long enough distance"). No hull capture, no flow noise — see AccumProfile.
  const far = createAccumulation(p, flowU, wake.wakeRateNode, {
    res: p.farResolution,
    size: () => p.farRegionSize,
    decayHalfLife: () => p.farDecayHalfLife,
    useFlow: false,
    useCapture: false,
  });
  const uEdgeFade = uniform(p.edgeFade);
  const uFarStrength = uniform(p.farStrength);
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

    /** coarse long-range wake texture (R = foam mask), stable identity */
    get farFoamTexture(): THREE.StorageTexture {
      return far.foamTexture;
    },

    setCenter(x: number, z: number): void {
      acc.setCenter(x, z);
      far.setCenter(x, z);
    },
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
     * Ship wake state (wakeInjection.ts): call per tick with ship state;
     * bow/stern offsets + beam come from the ship blueprint AABB (main.ts).
     * The module records the cutwater's WORLD-SPACE track internally, so a
     * turn leaves a curved trail behind instead of re-pointing the whole wake
     * (wakeTrack.ts). No extra inputs needed — same signature as before.
     *
     * `speed` should be speed OVER WATER at the hull: it drives the bow mound
     * amplitude (via a lag) and every feature's intensity. If it ever becomes
     * available, true speed-through-water (including current) would be a
     * strictly better feed than |velocity|.
     */
    setShip: wake.setShip,

    /** debug/tests: the live world-space cutwater history (index 0 = newest) */
    get wakeTrack() {
      return wake.trackSamples;
    },

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
      uFarStrength.value = p.farStrength;
      // age + extend the world-space cutwater track BEFORE the computes read it
      wake.advance(dt);
      wake.pushParams();
      acc.step(renderer, dt);
      far.step(renderer, dt);
    },

    /**
     * Convenience for the ocean material: foam sampled at a world-XZ node,
     * faded to 0 over the outer `edgeFade` fraction of the region so the
     * sliding window border never pops. smoothstep edges are INVERTED
     * (e0 > e1, functional form per §V23) — reads "1 inside, 0 at border",
     * same idiom as surfaceMaterial's distance fades.
     */
    foamSampleNode(worldXZ: any): any {
      const sampleRegion = (a: typeof acc, tex: THREE.StorageTexture) => {
        const c = a.uniforms.uCenter;
        const s = a.uniforms.uSize;
        const u = worldXZ.x.sub(c.x).div(s).add(0.5);
        const v = float(0.5).sub(worldXZ.y.sub(c.y).div(s)); // v flip (flowMath.ts)
        const inner = float(0.5).mul(uEdgeFade.oneMinus());
        const edge = smoothstep(float(0.5), inner, u.sub(0.5).abs()).mul(
          smoothstep(float(0.5), inner, v.sub(0.5).abs()),
        );
        return texture(tex, vec2(u, v)).r.mul(edge);
      };
      // MAX, not add: the two tiers hold the same wake at different scales, so
      // summing would double it wherever they overlap. Max lets the near tier's
      // detail win where it exists and the far tier carry on past its border.
      return sampleRegion(acc, acc.foamTexture).max(
        sampleRegion(far, far.foamTexture).mul(uFarStrength),
      );
    },

    dispose(): void {
      acc.dispose();
      far.dispose();
    },
  };
}

export type FlowFoam = ReturnType<typeof createFlowFoam>;
