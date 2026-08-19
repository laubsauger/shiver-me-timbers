/**
 * Underwater camera mode entry (§V25, feeds §V24's look underwater).
 *
 * THIS MODULE WAS DEAD CODE UNTIL NOW. It landed complete in one wave commit
 * and `createUnderwater` was never called from anywhere — which is precisely
 * the user report "it looks like empty space below the sea": submersion
 * detection, the grade, the god rays and the meniscus band all existed, fully
 * written and fully unreachable. The reason it was never wired is visible in
 * the signature it used to have: it built its OWN `THREE.PostProcessing` and
 * its OWN `pass(scene, camera)`, which is a SECOND full scene render and is
 * mutually exclusive with `core/postPipeline.ts`. Two agents built two post
 * chains in parallel and neither could be switched on without deleting the
 * other. It is now a STAGE inside the one real pipeline, sharing its scenePass.
 *
 * MAIN.TS WIRING ORDER:
 *
 *   const uw = createUnderwater({ camera: app.camera,
 *                                 sunDirProvider: () => sky.sunDirection });
 *   app.scene.add(uw.waterlineMesh);        // clip-space quad, scene pass
 *   const post = createPostPipeline(renderer, scene, camera, { underwater: uw });
 *   // frame loop, BEFORE post.render():
 *   uw.update(frameDt, (x, z) => cpuOcean.heightAt(x, z, state.time), state.time);
 *
 * update() advances the hysteresis submersion state (submersion.ts), drives
 * the shared uniforms (blend, camera depth, camera matrices + sea plane for
 * the volume, sun screen pos/visibility, day-cycle tint from sun elevation),
 * refreshes the waterline band columns, and pushes live params into every
 * effect uniform (V16).
 */
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import type { Node, PassNode } from 'three/webgpu';
import type { ShaderNodeObject } from 'three/tsl';
import { underwaterParams as p } from '../params/underwater';
import { skyParams } from '../params/sky';
import { sunDirection as solarDirection } from '../sky/sunCycle';
import {
  submersionState,
  type SubmersionMode,
  type SubmersionState,
} from './submersion';
import { buildUnderwaterGrade, type UnderwaterUniforms } from './underwaterGrade';
import { buildGodRays } from './godRays';
import { createWaterlineBand } from './waterlineBand';
import { buildWaterVolume, createVolumeUniforms } from './waterVolume';

export type WaterHeightFn = (x: number, z: number) => number;

/** what postPipeline needs from us — one stage over its own scene pass */
export interface UnderwaterStage {
  /** scene-linear HDR rgb in → rgb out (volume + lens grade) */
  apply(rgb: ShaderNodeObject<Node>): ShaderNodeObject<Node>;
  /** additive god-ray shafts, already masked by submersion + sun visibility */
  additive: ShaderNodeObject<Node>;
  updateFromParams(): void;
}

export interface UnderwaterHandle {
  /** add to the scene — renders inside the scene pass, over everything */
  waterlineMesh: THREE.Mesh;
  /**
   * Build the underwater stage against the pipeline's EXISTING scene pass.
   * Called once by createPostPipeline; there is deliberately no second
   * `pass()` here (see header).
   */
  buildStage(scenePass: ShaderNodeObject<PassNode>): UnderwaterStage;
  /** per-frame; heightFn defaults to a flat sea at y=0 until sea-physics */
  update(dt: number, waterHeightFn?: WaterHeightFn, time?: number): void;
  /** extra {value:number} uniforms to receive blend each update (e.g. to
   *  dim ocean surface sparkle underwater) */
  setBlendTargets(...targets: Array<{ value: number }>): void;
  readonly mode: SubmersionMode;
  readonly blend: number;
  dispose(): void;
}

/** §V.28: no caller-fed value reaches a uniform unguarded. */
function finite(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

const FLAT_SEA: WaterHeightFn = () => 0;

/**
 * Where the volume asks the sea how tall it is (§V.8, §V.71).
 *
 * `waterVolume.ts` solves the exit of each upward ray against the DISPLACED
 * surface, and caps the correction at the local crest envelope so a background
 * pixel or a coarse near-field triangle cannot run away with it. That cap is a
 * property of the live sea, so it is measured off the same height function the
 * hull floats on rather than authored as a param that would be silently wrong
 * the moment the wind changed — which is the whole failure §V.71 names.
 *
 * TWO RADII, EIGHT WAYS. 20 m is the near field the eye is actually inside of;
 * 80 m is about as far as the water is still transmitting anything (K_blue
 * 0.03/m puts a 100 m path at 5%), so a crest beyond it cannot be the one
 * "revealing an untinted view". Sixteen bilinear grid samples per frame, next
 * to the hundreds buoyancy already takes.
 */
const RISE_RADII = [20, 80] as const;
const RISE_RING: ReadonlyArray<readonly [number, number]> = Array.from(
  { length: 8 },
  (_, i) => {
    const a = (i * Math.PI) / 4;
    return [Math.cos(a), Math.sin(a)] as const;
  },
);
/** ring samples land BETWEEN crests, so the cap gets headroom, a floor for a
 *  glassy sea, and a §V.28 ceiling so one bad sample cannot fog the frame */
const RISE_HEADROOM = 2;
const RISE_MIN = 1;
const RISE_MAX = 30;

function crestRiseNear(hf: WaterHeightFn, x: number, z: number, seaY: number): number {
  let peak = 0;
  for (const r of RISE_RADII) {
    for (const [cx, cz] of RISE_RING) {
      const h = hf(x + cx * r, z + cz * r);
      if (Number.isFinite(h) && h - seaY > peak) peak = h - seaY;
    }
  }
  return Math.min(RISE_MAX, Math.max(RISE_MIN, peak * RISE_HEADROOM));
}

export function createUnderwater(opts: {
  camera: THREE.PerspectiveCamera;
  sunDirProvider: () => THREE.Vector3;
}): UnderwaterHandle {
  const { camera, sunDirProvider } = opts;

  const uniforms: UnderwaterUniforms = {
    blend: uniform(0),
    camDepth: uniform(0),
    time: uniform(0),
    // y = 0 is the TOP of the frame in screenUV, so "up" is a SMALL v (0.1).
    sunScreen: uniform(new THREE.Vector2(0.5, 0.1)),
    sunVis: uniform(0),
    dayTint: uniform(new THREE.Color(1, 1, 1)),
  };

  const band = createWaterlineBand();
  const vol = createVolumeUniforms();

  let state: SubmersionState | undefined;
  let blendTargets: Array<{ value: number }> = [];
  let updateStageParams: (() => void) | undefined;

  const sunWorld = new THREE.Vector3();
  const forward = new THREE.Vector3();

  return {
    waterlineMesh: band.mesh,

    buildStage(scenePass): UnderwaterStage {
      const grade = buildUnderwaterGrade(scenePass, uniforms);
      const rays = buildGodRays(scenePass, uniforms);
      const volume = buildWaterVolume(scenePass, vol, uniforms.dayTint, uniforms.blend);
      updateStageParams = (): void => {
        grade.updateFromParams();
        rays.updateFromParams();
        volume.updateFromParams();
      };
      return {
        // ORDER (see underwaterGrade.ts): refract the incoming image, then
        // extinguish it over the submerged path, then grade what arrived.
        apply: (rgb) => grade.finish(volume.apply(grade.lens(rgb))),
        additive: rays.node,
        updateFromParams: updateStageParams,
      };
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

      // --- volume: the SCENE camera's own matrices + the local sea plane.
      // Fed explicitly because PostProcessing draws its output node through an
      // internal fullscreen-quad camera, so TSL's built-in camera accessors do
      // not resolve to this one (see waterVolume.ts header).
      camera.updateMatrixWorld();
      vol.invProj.value.copy(camera.projectionMatrixInverse);
      vol.camWorld.value.copy(camera.matrixWorld);
      vol.camPos.value.copy(camera.position);
      // The split plane is the sea at the CAMERA's XZ, so the meridian rides
      // the swell with the lens instead of sitting at a world-fixed y = 0.
      vol.seaY.value = finite(h, 0);
      // ...and the surface AWAY from the camera is not that plane, so the
      // volume also gets how far above it the swell reaches (see crestRiseNear
      // and the `rise` block in waterVolume.ts). Only while submerged: this is
      // sixteen height samples, and above the surface the volume is the exact
      // identity and never reads it.
      vol.waveRise.value = state.blend > 0
        ? finite(crestRiseNear(waterHeightFn, camera.position.x, camera.position.z, vol.seaY.value), RISE_MIN)
        : RISE_MIN;

      // sun screen position + visibility (in front of camera, smooth edge)
      const sunDir = sunDirProvider();
      camera.getWorldDirection(forward);
      const facing = forward.dot(sunDir);
      uniforms.sunVis.value = Math.min(1, Math.max(0, facing / p.sunVisEdge));
      if (facing > 0) {
        sunWorld.copy(camera.position).addScaledVector(sunDir, 100);
        sunWorld.project(camera);
        // Y INVERTED — `godRays.ts` marches in `screenUV`, whose v is 0 at the
        // TOP of the frame, while NDC y is +1 there. Same expression as three's
        // getScreenPosition() (ndc*0.5+0.5 then y.oneMinus()), folded. Written
        // without the flip the shafts converged on the sun's mirror image about
        // the horizontal midline; core/postGodRays.ts carries the full note and
        // the above-water version of this defect was the reported artifact.
        uniforms.sunScreen.value.set(
          sunWorld.x * 0.5 + 0.5,
          0.5 - sunWorld.y * 0.5,
        );
      }

      // day-cycle tint: sun below horizon → dark, noon → full color (V25:
      // weather/day-cycle drive the underwater tint too).
      //
      // THE SUN, NOT THE KEY. This used to read `sunDir.y`, i.e. the vector
      // `sunDirProvider` returns, which is `sky.sunDirection` — the shared KEY
      // direction that src/sky/moonCycle.ts RE-AIMS AT THE MOON after dusk
      // rather than adding a second light. So `nightFloor` was unreachable:
      // with the moon 30° up, `dayT` saturated to 1 and the water was exactly
      // as bright at midnight as at noon, which is the opposite of what the
      // param documents ("brightness floor when the sun is DOWN"). The
      // question this term asks is how much SUNLIGHT is entering the water, so
      // it reads the pure solar function off the same live skyParams that
      // drive the sky — the same source core/postPipeline.ts uses for its own
      // default, so the two cannot drift.
      //
      // `sunVis` above deliberately still reads the key: shafts through the
      // rigging SHOULD follow the moon at night, and that is a question about
      // the key light, not about the sun. One vector, two different questions.
      //
      // Third variant of this defect family found today. §B.41 was the glint
      // road multiplied by a hardcoded cream literal, so the moon road
      // rendered at noon brightness; f247977 was the caustics never reading
      // the key at all, so they burned at full strength at midnight. This one
      // is the inverse of that second: reading the key where it owed the sun.
      const solarY = solarDirection(skyParams.timeOfDay, skyParams.latitude)[1];
      // §V.28: fall back BRIGHT. A NaN in the sky params must not be able to
      // black out the whole submerged frame.
      const dayT = Math.min(1, Math.max(0, finite(solarY, 1) * 2));
      const level = p.nightFloor + (1 - p.nightFloor) * dayT;
      uniforms.dayTint.value.setScalar(level);

      // crossing fade: band peaks mid-transition, gone when fully in/out
      const crossFade = 4 * state.blend * (1 - state.blend); // 1 at blend=.5
      band.update(camera, waterHeightFn, crossFade, time);

      band.updateFromParams();
      updateStageParams?.();
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
      blendTargets = [];
    },
  };
}
