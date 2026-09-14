/**
 * Depth of field that keeps the authored sky sharp — and does not cut spray in two along the horizon.
 *
 * THE SKY. Standard scene depth clears to 1 and the background writes no geometry depth, so `depth ≥ 1` is the sky; it
 * is focused (CoC 0) and its colour restored after the blur, otherwise near-field blur spreads onto it and fine stars
 * become bokeh.
 *
 * THE SPRAY (user report: "the rooster tail spray is SHARP where it overlaps the sky and BLURRED where it overlaps the
 * water"). Transparent particles write no depth, so a droplet took the CoC of whatever was BEHIND it: the sky's (0, plus
 * the sharp restore) above the horizon, the far water's below — one plume, cut in two.
 *
 * THE FIX: a particle COVERAGE pass. Particle meshes also sit on `POST_PARTICLE_LAYER` (`layers.enable`, they stay on
 * their own layers too); one extra pass renders only that layer into a small-format target with a transparent clear
 * and no background, and its alpha is the particles' screen coverage. Where spray covers a pixel it is drawn in focus
 * (the lens is on the boat that throws it, `focusShip`), in
 * proportion to coverage (the sharp beauty is kept there, like the sky). Occlusion, blending, lighting stay the scene pass's. So
 * a plume is treated alike above and below the horizon. Cost: one particle-only draw (no full-screen pass) and two
 * texture reads in the post quad. Limit, stated: spray is drawn in focus wherever it is (a far rival's plume included),
 * and a hull pixel with spray BEHIND it also takes the focus distance (the hull is in focus in these shots anyway).
 *
 * The first version rendered the particles in their own pass depth-tested against a SHARED scene depth texture; a
 * resize (every cine record sets the render size) disposed the particle target and destroyed the scene's depth with it
 * ("Destroyed texture [depth] used in a submit") and the page stopped rendering. Nothing is shared now.
 *
 * A particle mesh that is not on the layer is covered by nothing and renders exactly as before.
 */
import * as THREE from 'three/webgpu';
import { float, max, mix, select, smoothstep, uniform, vec4 } from 'three/tsl';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
// TSL texture and arithmetic nodes have incompatible fluent generic types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TslNode = any;

/** the particle coverage layer (clear of the reflection 11/12 and foam injection 27 bits): `mesh.layers.enable(it)` */
export const POST_PARTICLE_LAYER = 21;

/** diagnostics: the coverage pass the pipeline built (its render target holds the last frame's particle coverage) */
export let lastCoveragePass: THREE.PassNode | null = null;
/** diagnostics: 1 = show the particle coverage in red */
export const skyDofDebug = uniform(0);

/** a pass that draws only the particle layer onto a transparent target, without the scene background */
class ParticleCoveragePass extends THREE.PassNode {
  constructor(scene: THREE.Scene, camera: THREE.Camera) {
    super(THREE.PassNode.COLOR, scene, camera, { samples: 0 });
    const layers = new THREE.Layers();
    layers.set(POST_PARTICLE_LAYER);
    this.setLayers(layers);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateBefore(frame: any): void {
    const renderer = frame.renderer as THREE.WebGPURenderer;
    const scene = this.scene as THREE.Scene & { backgroundNode?: unknown };
    const background = scene.background;
    const backgroundNode = scene.backgroundNode;
    const clear = new THREE.Color();
    renderer.getClearColor(clear as unknown as Parameters<THREE.WebGPURenderer['getClearColor']>[0]);
    const clearAlpha = renderer.getClearAlpha();
    scene.background = null;
    scene.backgroundNode = null;
    renderer.setClearColor(0x000000, 0);
    try {
      super.updateBefore(frame);
    } finally {
      scene.background = background;
      scene.backgroundNode = backgroundNode;
      renderer.setClearColor(clear, clearAlpha);
    }
  }
}

export function skyDof(color: TslNode, scenePass: THREE.PassNode, scene: THREE.Scene, camera: THREE.Camera,
  focus: TslNode, range: TslNode, bokeh: TslNode): TslNode {
  // cameras see the layer (particles are on it AND their own); only the coverage pass renders it alone
  camera.layers.enable(POST_PARTICLE_LAYER);
  const particles = new ParticleCoveragePass(scene, camera);
  lastCoveragePass = particles;
  // accumulated alpha of additive and normal pools alike: a soft 0..1 coverage (a thin mist barely counts)
  const coverage = smoothstep(float(0.1), float(0.5), particles.getTextureNode('output').a);

  const depth = scenePass.getTextureNode('depth');
  const viewZ = scenePass.getViewZNode();
  const sky = depth.greaterThanEqual(1);
  const opticalZ = select(sky, focus.negate(), viewZ);
  const blurred = dof(color, opticalZ, focus, range, bokeh);
  // the sharp beauty wherever the sky is AND wherever spray covers the pixel — above and below the horizon alike. (Fed
  // through the DOF's own CoC instead, the coverage never reached it: that pass runs inside the DOF node's private
  // material and read nothing — measured, before/after identical to 0.05 % of pixels.)
  const out = mix(blurred, color, max(float(sky), coverage));
  // diagnostics: `skyDofDebug.value = 1` paints the coverage red over the picture
  return mix(out, vec4(coverage, 0, 0, 1), skyDofDebug.mul(0.7));
}
