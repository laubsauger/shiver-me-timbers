/**
 * Post pipeline (§V.16, §V.22): GTAO + bloom + vibrance grade + vignette.
 * AO grounds the ship geometry (user report: flat/gamey without occlusion),
 * bloom lifts sun glints + foam, vignette + vibrance push the painterly
 * reference look (docs/final-full-result.png).
 *
 * Two levels of control, on purpose (§V.16):
 *  - `*Enabled` are CONSTRUCTION-time gates. They add or omit whole nodes.
 *    A pass that renders wrong cannot be neutralised by scaling its output
 *    (multiplying a broken texture by 0 still costs the pass and can still
 *    poison the frame), so bisecting a black/garbage frame needs the node
 *    gone, not damped. Changing these takes effect on reload.
 *  - the numeric knobs (aoStrength, bloom*, vibrance, vignette*) are LIVE
 *    uniforms: 0 is an exact identity for each, so the panel can fade any
 *    stage out mid-frame without a rebuild.
 */
import * as THREE from 'three/webgpu';
import {
  float,
  mix,
  pass,
  screenUV,
  smoothstep,
  uniform,
  vec3,
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

  // samples: 0 — the scene pass must NOT be multisampled. Its depthTexture is
  // what GTAO reads, and a multisampled colour target leaves that depth
  // attachment unresolved, so the AO shader marches an unwritten buffer
  // (§V.28: no garbage-fed shader paths). The renderer is built with
  // antialias:true for the direct path; through post the scene composites via
  // a fullscreen quad instead, so the pass RT carries no MSAA of its own.
  const scenePass = pass(scene, camera, { samples: 0 });
  const color = scenePass.getTextureNode('output');
  const depth = scenePass.getTextureNode('depth');

  // --- AO -------------------------------------------------------------
  // No MRT normal target here, deliberately. This scene draws its principal
  // surfaces with MeshBasicNodeMaterial — the ocean (§V.20: PBR washed the
  // pigment grey), the sky dome and the cloud composite quad — so `normalView`
  // is the raw grid/dome vertex normal, not the shading normal the surface
  // actually displays. Feeding that to GTAO describes geometry nobody can see.
  // Passing null makes GTAO reconstruct normals from depth, which at least
  // agrees with what is in the depth buffer.
  //
  // Caveat kept honest: the ocean is transparent + depthWrite=false, so the
  // water is absent from that depth buffer. AO therefore grounds the ship
  // against itself (deck under the castles, hull under the rails, rigging),
  // never against the sea. Hull-to-water contact shadow needs T30 planar
  // reflections or a dedicated contact pass, not GTAO.
  const uAoAmount = uniform(0);
  let lit = color.rgb;
  if (pp.aoEnabled) {
    // @types/three declares normalNode non-nullable, but GTAONode documents
    // and implements the null case ("normals can be automatically
    // reconstructed from depth"). Upstream typing gap, not a semantic one.
    const noNormals = null as unknown as Parameters<typeof ao>[1];
    const aoPass = ao(depth, noNormals, camera);
    aoPass.resolutionScale = 0.5; // half-res AO, §V.17 render budget
    // clamp before use: an AO sample that ever reads garbage must not be able
    // to multiply the whole frame to black (§V.28).
    const aoRgb = aoPass.getTextureNode().rgb.clamp(0, 1);
    lit = color.rgb.mul(mix(vec3(1), aoRgb, uAoAmount));
  }

  // --- bloom ----------------------------------------------------------
  // strength 0 = zero additive contribution = identity.
  const bloomPass = pp.bloomEnabled ? bloom(lit) : null;

  // --- grade ----------------------------------------------------------
  const uVibrance = uniform(0);
  const uVigStrength = uniform(0);
  const uVigStart = uniform(pp.vignetteStart);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let graded: any = bloomPass === null ? lit : lit.add(bloomPass.rgb);
  if (pp.vibranceEnabled) graded = vibrance(graded, uVibrance);

  if (pp.vignetteEnabled) {
    // soft corner falloff, starts outside uVigStart radius.
    // functional smoothstep(e0, e1, x) — §V.23, receiver-as-factor trap.
    const dist = screenUV.sub(0.5).length();
    const vig = float(1).sub(
      smoothstep(uVigStart, 1.15, dist).mul(uVigStrength),
    );
    graded = graded.mul(vig.clamp(0, 1));
  }
  post.outputNode = graded;

  const updateFromParams = () => {
    // a disabled-at-runtime stage feeds its neutral value; the node graph is
    // fixed, so the toggle costs one uniform write.
    uAoAmount.value = pp.aoEnabled ? pp.aoStrength : 0;
    if (bloomPass !== null) {
      bloomPass.threshold.value = pp.bloomThreshold;
      bloomPass.strength.value = pp.bloomEnabled ? pp.bloomStrength : 0;
      bloomPass.radius.value = pp.bloomRadius;
    }
    uVibrance.value = pp.vibranceEnabled ? pp.vibrance : 0;
    uVigStrength.value = pp.vignetteEnabled ? pp.vignetteStrength : 0;
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
