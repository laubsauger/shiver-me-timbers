/**
 * Waterline meniscus band (§V25 "waterline crossing → split view w/
 * meniscus band, no pop").
 *
 * A camera-locked fullscreen quad (clip-space vertexNode, so its transform
 * is irrelevant — add the mesh to the scene) that draws a thin bright
 * refracting strip where the ocean surface crosses the camera near plane,
 * plus procedural droplet streaks just above the line while crossing.
 *
 * WATERLINE SAMPLING (documented per task): a per-frame CPU-filled
 * `uniformArray` of N screen-space heights across screen x. Each frame we
 * unproject N points on the camera near plane, query the injected
 * `heightFn(x, z)` (sea-physics later; defaults to 0) at their world XZ,
 * and re-project the water height back to screen Y. The fragment shader
 * interpolates between columns — N is a buffer size, so `waterlineSamples`
 * is read once at build (reload to change); everything else is live (V16).
 *
 * V23: 3-arg math uses functional `mix`/`smoothstep` forms.
 */
import * as THREE from 'three/webgpu';
import {
  abs,
  float,
  floor,
  hash,
  int,
  mix,
  positionGeometry,
  screenUV,
  smoothstep,
  uniform,
  uniformArray,
  vec3,
  vec4,
} from 'three/tsl';
import { underwaterParams as p } from '../params/underwater';

export interface WaterlineBand {
  mesh: THREE.Mesh;
  /** per-frame: refresh waterline columns + fade. crossFade 0 hides it. */
  update(
    camera: THREE.PerspectiveCamera,
    heightFn: (x: number, z: number) => number,
    crossFade: number,
    time: number,
  ): void;
  updateFromParams(): void;
  dispose(): void;
}

export function createWaterlineBand(): WaterlineBand {
  // column count is a uniform-buffer size — snapshot at build (doc above)
  const samples = Math.max(2, Math.round(p.waterlineSamples));
  const heights = uniformArray(new Array<number>(samples).fill(0.5), 'float');

  const uCrossFade = uniform(0);
  const uTime = uniform(0);
  const uThickness = uniform(p.meniscusThickness);
  const uBrightness = uniform(p.meniscusBrightness);
  const uStreakStrength = uniform(p.streakStrength);
  const uStreakDensity = uniform(p.streakDensity);
  const uStreakLength = uniform(p.streakLength);
  const uShallow = uniform(new THREE.Color(p.fogColorShallow));

  // piecewise-linear waterline screen-y at this fragment's x
  const xIdx = screenUV.x.mul(samples - 1);
  const i0 = int(floor(xIdx));
  const i1 = i0.add(int(1)).min(int(samples - 1));
  const waterY = mix(heights.element(i0), heights.element(i1), xIdx.fract());

  // signed screen distance above (+) / below (−) the waterline
  const d = screenUV.y.sub(waterY);

  // meniscus strip: bright core fading over ±thickness
  const strip = float(1).sub(smoothstep(float(0), uThickness, abs(d)));

  // droplet streaks: per-column hash, only above the line, fading over
  // streakLength; floor(time) reseeds columns ~1/s for a dripping churn
  const colId = floor(screenUV.x.mul(uStreakDensity));
  const seed = hash(colId.add(floor(uTime).mul(7.13))); // 7.13 = hash spread
  const streakGate = smoothstep(float(0.55), float(0.95), seed);
  const aboveFade = float(1).sub(smoothstep(float(0), uStreakLength, d));
  const isAbove = smoothstep(float(0), uThickness.mul(0.5), d);
  const streaks = streakGate.mul(aboveFade).mul(isAbove).mul(uStreakStrength);

  const material = new THREE.MeshBasicNodeMaterial();
  // clip-space fullscreen quad — bypasses camera transforms entirely
  material.vertexNode = vec4(positionGeometry.x, positionGeometry.y, 0, 1);
  // whiten the shallow fog color toward the meniscus highlight; 0.6 is the
  // structural whitening ratio (brightness itself is the tunable)
  material.colorNode = vec4(
    mix(uShallow, vec3(1), float(0.6)).mul(uBrightness),
    strip.add(streaks).saturate().mul(uCrossFade),
  );
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.fog = false;

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1000; // over everything in the scene pass
  mesh.visible = false;

  const nearPoint = new THREE.Vector3();
  const waterPoint = new THREE.Vector3();
  const forward = new THREE.Vector3();

  return {
    mesh,
    update(camera, heightFn, crossFade, time): void {
      uCrossFade.value = crossFade;
      uTime.value = time;
      mesh.visible = crossFade > 0.001;
      if (!mesh.visible) return;

      camera.getWorldDirection(forward);
      for (let i = 0; i < samples; i++) {
        const ndcX = (i / (samples - 1)) * 2 - 1;
        // point on the near plane at this screen column
        nearPoint.set(ndcX, 0, -1 + 1e-4).unproject(camera);
        const h = heightFn(nearPoint.x, nearPoint.z);
        waterPoint.set(nearPoint.x, h, nearPoint.z);
        // guard: projecting a behind-camera point mirrors — clamp instead
        const behind =
          waterPoint.clone().sub(camera.position).dot(forward) <= 0;
        if (behind) {
          heights.array[i] = camera.position.y < h ? 2 : -1; // off-screen
          continue;
        }
        waterPoint.project(camera);
        // clamp softly outside [0,1] so interpolation stays sane
        heights.array[i] = Math.min(2, Math.max(-1, waterPoint.y * 0.5 + 0.5));
      }
    },
    updateFromParams(): void {
      uThickness.value = p.meniscusThickness;
      uBrightness.value = p.meniscusBrightness;
      uStreakStrength.value = p.streakStrength;
      uStreakDensity.value = p.streakDensity;
      uStreakLength.value = p.streakLength;
      uShallow.value.set(p.fogColorShallow);
    },
    dispose(): void {
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}
