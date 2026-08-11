/**
 * Underwater camera mode entry (§V25, feeds §V24's look underwater).
 *
 * MAIN.TS WIRING ORDER (post pass wraps the main render):
 *
 *   const uw = createUnderwater({
 *     camera: app.camera,
 *     sunDirProvider: () => sky.sunDirection,
 *   });
 *   app.scene.add(uw.waterlineMesh);            // clip-space quad, scene pass
 *   const post = uw.buildPost(app.renderer, app.scene, app.camera);
 *   // frame loop — INSTEAD of app.render():
 *   uw.update(frameDt, waterHeightFn, state.time);  // heightFn: sea-physics
 *   post.render();                                   // (defaults to y=0)
 *
 * update() advances the hysteresis submersion state (submersion.ts), drives
 * the shared uniforms (blend, camera depth, sun screen pos/visibility,
 * day-cycle tint from sun elevation), refreshes the waterline band columns,
 * and pushes live params into every effect uniform (V16).
 */
import * as THREE from 'three/webgpu';
import { float, pass, uniform, vec4 } from 'three/tsl';
import { underwaterParams as p } from '../params/underwater';
import {
  submersionState,
  type SubmersionMode,
  type SubmersionState,
} from './submersion';
import { buildUnderwaterGrade, type UnderwaterUniforms } from './underwaterGrade';
import { buildGodRays } from './godRays';
import { createWaterlineBand } from './waterlineBand';

export type WaterHeightFn = (x: number, z: number) => number;

export interface UnderwaterHandle {
  /** add to the scene — renders inside the scene pass, over everything */
  waterlineMesh: THREE.Mesh;
  /** build the post pipeline; call once, render via the returned object */
  buildPost(
    renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
  ): THREE.PostProcessing;
  /** per-frame; heightFn defaults to a flat sea at y=0 until sea-physics */
  update(dt: number, waterHeightFn?: WaterHeightFn, time?: number): void;
  /** extra {value:number} uniforms to receive blend each update (e.g. to
   *  dim ocean surface sparkle underwater) */
  setBlendTargets(...targets: Array<{ value: number }>): void;
  readonly mode: SubmersionMode;
  readonly blend: number;
  dispose(): void;
}

const FLAT_SEA: WaterHeightFn = () => 0;

export function createUnderwater(opts: {
  camera: THREE.PerspectiveCamera;
  sunDirProvider: () => THREE.Vector3;
}): UnderwaterHandle {
  const { camera, sunDirProvider } = opts;

  const uniforms: UnderwaterUniforms = {
    blend: uniform(0),
    camDepth: uniform(0),
    time: uniform(0),
    sunScreen: uniform(new THREE.Vector2(0.5, 0.9)),
    sunVis: uniform(0),
    dayTint: uniform(new THREE.Color(1, 1, 1)),
  };

  const band = createWaterlineBand();

  let state: SubmersionState | undefined;
  let blendTargets: Array<{ value: number }> = [];
  let updateGradeParams: (() => void) | undefined;
  let updateRayParams: (() => void) | undefined;
  let post: THREE.PostProcessing | undefined;

  const sunWorld = new THREE.Vector3();
  const forward = new THREE.Vector3();

  return {
    waterlineMesh: band.mesh,

    buildPost(renderer, scene, cam): THREE.PostProcessing {
      const scenePass = pass(scene, cam);
      const grade = buildUnderwaterGrade(scenePass, uniforms);
      const rays = buildGodRays(scenePass, uniforms);
      updateGradeParams = grade.updateFromParams;
      updateRayParams = rays.updateFromParams;
      post = new THREE.PostProcessing(renderer);
      post.outputNode = grade.node.add(vec4(rays.node, float(0)));
      return post;
    },

    update(dt, waterHeightFn = FLAT_SEA, time = 0): void {
      const h = waterHeightFn(camera.position.x, camera.position.z);
      // maxBlendStep is per 60Hz tick — scale to this frame's dt (V25)
      state = submersionState(camera.position.y, h, state, {
        maxBlendStep: p.maxBlendStep * dt * 60,
      });

      uniforms.blend.value = state.blend;
      uniforms.camDepth.value = Math.max(0, h - camera.position.y);
      uniforms.time.value = time;
      for (const t of blendTargets) t.value = state.blend;

      // sun screen position + visibility (in front of camera, smooth edge)
      const sunDir = sunDirProvider();
      camera.getWorldDirection(forward);
      const facing = forward.dot(sunDir);
      uniforms.sunVis.value = Math.min(1, Math.max(0, facing / p.sunVisEdge));
      if (facing > 0) {
        sunWorld.copy(camera.position).addScaledVector(sunDir, 100);
        sunWorld.project(camera);
        uniforms.sunScreen.value.set(
          sunWorld.x * 0.5 + 0.5,
          sunWorld.y * 0.5 + 0.5,
        );
      }

      // day-cycle tint: sun below horizon → dark, noon → full color (V25:
      // weather/day-cycle drive the underwater tint too)
      const dayT = Math.min(1, Math.max(0, sunDir.y * 2));
      const level = p.nightFloor + (1 - p.nightFloor) * dayT;
      uniforms.dayTint.value.setScalar(level);

      // crossing fade: band peaks mid-transition, gone when fully in/out
      const crossFade = 4 * state.blend * (1 - state.blend); // 1 at blend=.5
      band.update(camera, waterHeightFn, crossFade, time);

      band.updateFromParams();
      updateGradeParams?.();
      updateRayParams?.();
    },

    setBlendTargets(...targets): void {
      blendTargets = targets;
    },

    get mode(): SubmersionMode {
      return state?.mode ?? 'above';
    },
    get blend(): number {
      return state?.blend ?? 0;
    },

    dispose(): void {
      band.dispose();
      post?.dispose();
      blendTargets = [];
    },
  };
}
