/**
 * Post pipeline (§V.16, §V.22): GTAO + bloom + vibrance grade + vignette.
 * AO grounds the ship geometry (user report: flat/gamey without occlusion),
 * bloom lifts sun glints + foam, vignette + vibrance push the painterly
 * reference look (docs/final-full-result.png).
 */
import * as THREE from 'three/webgpu';
import {
  float,
  mrt,
  normalView,
  output,
  pass,
  screenUV,
  smoothstep,
  uniform,
  vibrance,
} from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { postParams as pp } from '../params/post';

export interface PostPipeline {
  /** call instead of renderer.render() */
  render(): void;
  /** push live params (call per frame) */
  updateFromParams(): void;
}

export function createPostPipeline(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
): PostPipeline {
  const post = new THREE.PostProcessing(renderer);

  const scenePass = pass(scene, camera);
  scenePass.setMRT(mrt({ output, normal: normalView }));
  const color = scenePass.getTextureNode('output');
  const depth = scenePass.getTextureNode('depth');
  const normal = scenePass.getTextureNode('normal');

  const aoPass = ao(depth, normal, camera);
  const uVibrance = uniform(pp.vibrance);
  const uVigStrength = uniform(pp.vignetteStrength);
  const uVigStart = uniform(pp.vignetteStart);

  const bloomPass = bloom(color.mul(aoPass));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let graded: any = color.mul(aoPass).add(bloomPass);
  graded = vibrance(graded, uVibrance);
  // soft corner falloff, starts outside uVigStart radius
  const dist = screenUV.sub(0.5).length();
  const vig = float(1).sub(
    smoothstep(uVigStart, 1.15, dist).mul(uVigStrength),
  );
  post.outputNode = graded.mul(vig.clamp(0, 1));

  const updateFromParams = () => {
    bloomPass.threshold.value = pp.bloomThreshold;
    bloomPass.strength.value = pp.bloomStrength;
    bloomPass.radius.value = pp.bloomRadius;
    uVibrance.value = pp.vibrance;
    uVigStrength.value = pp.vignetteStrength;
    uVigStart.value = pp.vignetteStart;
  };
  updateFromParams();

  return {
    render(): void {
      post.render();
    },
    updateFromParams,
  };
}
