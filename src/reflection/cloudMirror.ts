/**
 * Clouds inside the planar reflection (§V26: "ship, islands, clouds visible
 * in water").
 *
 * WHY THIS EXISTS AT ALL. The clouds (§V11) are not geometry — they are a
 * blurred 4-channel RT composited by a quad pinned to the MAIN camera that
 * samples the RT through `screenUV`. Rendered from the mirror camera that
 * quad is nonsense: it hangs at the main camera's position at some oblique
 * angle and smears its screen-space lookup across the reflection. So it is
 * excluded from the mirror pass (REFLECTION_HIDDEN_LAYER) and this stand-in
 * takes its place on REFLECTION_ONLY_LAYER.
 *
 * WHERE THE CLOUD LOOKUP COMES FROM. The stand-in is fitted to the mirror
 * camera, so its fragments cover the reflection exactly. For each fragment:
 *   R  = the mirror camera's ray through it (an UPWARD direction — this is
 *        the reflected ray the water shows)
 *   d  = M(R), R mirrored back across the water plane, i.e. the direction the
 *        MAIN camera would look along to see that same piece of sky
 * and the cloud RT stores clouds at the main camera's projection of d. So the
 * lookup is `project(mainViewProjection, d)`, one mat4 multiply per fragment.
 *
 * The tempting shortcut — fit the quad to the mirror camera and keep sampling
 * with `screenUV` (optionally flipped) — is WRONG and looks it: mirror-screen
 * (s,t) corresponds to main-screen (1-s,t), which for a water pixel is a
 * DOWNWARD direction, i.e. the part of the cloud RT that holds no clouds.
 * Reflections would come back empty near the horizon and smeared elsewhere.
 *
 * Still an approximation, and honestly so: the cloud RT was rasterized from
 * the main camera, so anything the main camera cannot see has no cloud data.
 * That region is faded out rather than clamped (a clamped edge tap smears one
 * texel column across half the reflection), and it lands where reflections
 * matter least — steep view angles, where fresnel is near zero.
 */
import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  float,
  positionWorld,
  smoothstep,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { createCloudEdge, createNoiseTexture } from '../clouds/cloudComposite';
import type { CloudParams } from '../params/clouds';
import { REFLECTION_ONLY_LAYER } from './mirrorMath';

/** §V28: floored divisor for the perspective divide */
const EPS = 1e-4;

export interface CloudMirrorSource {
  /**
   * The blurred cloud texture — the SAME one the main composite samples
   * (`CloudsHandle.blurredTexture`).
   */
  blurred: THREE.Texture;
  /** cloud seed — the erosion noise must match the main composite's */
  seed: number;
  /**
   * This frame's resolved sun/sky pair (`CloudsHandle.sunColorLive` /
   * `skyColorLive`). These are the composite's own uniform values: Color
   * objects the clouds system MUTATES IN PLACE every frame from the live sky
   * palette (§T.39, driven off `scene.fog.color`). Held by reference and
   * copied each frame.
   *
   * Reading `params.sunColor` / `params.skyColor` instead is the bug this
   * replaced: those hexes are the midday authoring values, so at the golden
   * hour the real clouds warm to #fdb669 while their reflection stays cold —
   * warm sky over a cold sea, the exact failure the ocean and clouds have
   * both just fixed on their side.
   *
   * §V31 note: these are already in the LINEAR working space (the clouds
   * system converted them at its own uniform boundary). Copy them; never
   * re-enter them through set()/setHex(), which would apply the sRGB
   * transfer a second time.
   */
  sunColorLive: THREE.Color;
  skyColorLive: THREE.Color;
  /** `CloudsHandle.sunDirLive`, by reference — drives the edge transmission
   *  term so a reflected cloud's thin margin lights like the real one's */
  sunDirLive: THREE.Vector3;
  /** live cloud params (shared object, read every frame) */
  params: CloudParams;
}

export interface CloudMirror {
  readonly quad: THREE.Mesh;
  /**
   * Per frame, BEFORE the mirror pass runs: place the quad on the mirror
   * camera's frustum and publish the main camera's viewProjection.
   */
  update(
    mainCamera: THREE.PerspectiveCamera,
    mirrorPosition: THREE.Vector3,
    mirrorQuaternion: THREE.Quaternion,
    time: number,
  ): void;
  dispose(): void;
}

export function createCloudMirror(src: CloudMirrorSource): CloudMirror {
  const p = src.params;
  const noiseTex = createNoiseTexture(src.seed);

  // seeded from the LIVE pair, not the params hexes — see CloudMirrorSource
  const uSunColor = uniform(new THREE.Color().copy(src.sunColorLive));
  const uSkyColor = uniform(new THREE.Color().copy(src.skyColorLive));
  /** projection × view of the MAIN camera — the cloud RT's own frame */
  const uMainViewProj = uniform(new THREE.Matrix4());

  const material = new THREE.MeshBasicNodeMaterial();

  // reflected ray → the main camera's view direction for the same sky
  const rayMirror = positionWorld.sub(cameraPosition).normalize();
  const viewDir = vec3(rayMirror.x, rayMirror.y.negate(), rayMirror.z);

  // project that direction with the main camera (w-component of a direction
  // is 0, so the translation column drops out and this is a pure rotation +
  // projection — no need to strip the eye position by hand)
  const clip = uMainViewProj.mul(vec4(viewDir, 0));
  // w ≤ 0 = the direction is behind the main camera: there is no cloud data
  // for it. Floor the divisor (§V28) and mask the result out below.
  const inFront = clip.w.greaterThan(EPS);
  const ndc = clip.xy.div(clip.w.max(EPS));
  // WebGPU: NDC y is +1 at the TOP, and screen/RT UV v is 0 at the top
  // (WGSLNodeBuilder.isFlipY() === false), so v flips while u does not.
  const cloudUV = vec2(ndc.x.mul(0.5).add(0.5), ndc.y.mul(-0.5).add(0.5));

  // the SAME edge graph as the main composite (createCloudEdge), driven by the
  // same view direction, so a cloud and its reflection fray identically — this
  // was a hand-copy of the alpha construction and drifted the moment either
  // side was tuned
  const edge = createCloudEdge(noiseTex, viewDir, p, src.sunDirLive);

  const packed = texture(src.blurred, cloudUV.add(edge.uvOffset).clamp(0, 1));
  const coverage = packed.b;
  const denom = coverage.max(1e-4);
  material.colorNode = uSunColor
    .mul(packed.r.div(denom).add(edge.transmission(packed)))
    .add(uSkyColor.mul(packed.g.div(denom)));

  // alpha: identical body/rim construction to cloudComposite, times a soft
  // border mask so the no-data region outside the main frustum fades instead
  // of smearing a clamped edge texel across the reflection.
  // smoothstep(e0,e1,x) with e0 > e1 reads "1 below e1, 0 above e0" (§V23).
  const border = float(0.04);
  const edgeMask = smoothstep(float(0), border, cloudUV.x)
    .mul(smoothstep(float(1), float(1).sub(border), cloudUV.x))
    .mul(smoothstep(float(0), border, cloudUV.y))
    .mul(smoothstep(float(1), float(1).sub(border), cloudUV.y));

  material.opacityNode = edge
    .alpha(packed)
    .mul(edgeMask)
    .mul(inFront.select(float(1), float(0)))
    .clamp(0, 1);
  material.transparent = true;
  material.depthWrite = false;
  material.fog = false;

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  quad.name = 'reflection/cloud-mirror';
  quad.frustumCulled = false;
  quad.renderOrder = 1000;
  // mirror pass only — the main camera must never see this stand-in
  quad.layers.set(REFLECTION_ONLY_LAYER);

  return {
    quad,
    update(mainCamera, mirrorPosition, mirrorQuaternion, time): void {
      edge.uTime.value = time * p.distortSpeed;
      // track the day cycle: the clouds system rewrote these in place this
      // frame, before this call (main.ts runs clouds.update() first)
      uSunColor.value.copy(src.sunColorLive);
      uSkyColor.value.copy(src.skyColorLive);
      edge.push(p);

      mainCamera.updateMatrixWorld();
      uMainViewProj.value.multiplyMatrices(
        mainCamera.projectionMatrix,
        mainCamera.matrixWorldInverse,
      );

      // the mirror camera copies the main camera's projection matrix, so the
      // frustum it must cover has the same fov and aspect
      const d = Math.max(1, p.quadDistance);
      const height = 2 * d * Math.tan(THREE.MathUtils.degToRad(mainCamera.fov) * 0.5);
      const margin = 1.15; // oversize: distortion must never reveal the border
      quad.scale.set(height * mainCamera.aspect * margin, height * margin, 1);
      quad.position.copy(mirrorPosition);
      quad.quaternion.copy(mirrorQuaternion);
      quad.translateZ(-d);
      quad.updateMatrixWorld();
    },
    dispose(): void {
      quad.geometry.dispose();
      material.dispose();
      noiseTex.dispose();
    },
  };
}
