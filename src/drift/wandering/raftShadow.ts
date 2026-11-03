/**
 * THE RAFT'S OWN SHADOW MAP (the 2026-11-03 review of the 56e951c master: "a bit of flickering in the shadows of some of
 * the rigging of the boat when we're about to hit the beach").
 *
 * WHY. The Sun's one map is 8192² over the world's reach (sea.ts SHADOW_EXTENT): ±45 m at sea, a texel 1.1 cm; ±90 m
 * on the coast, where the palms' and the forest's long shadows need it, a texel 2.2 cm. The raft's rigging is
 * thinner than that or barely thicker — the ladder's 3 cm ropes and 4 cm rungs, the main halyard's 1.8 cm, the crew's
 * fishing line, the slings — and a caster under two texels wide is rasterized into the map as a broken line of
 * texels, a different broken line in every frame as the raft rides, turns and bobs against the grid. The film's
 * filter (filmShadowFilter.ts) then draws each fragment faithfully: the rope's shadow on the sail came apart into
 * blotches that re-formed every frame (measured in one boot at 536–554 s, the run in to the beach: the same shadow
 * with the coast's map at ±45 m was one steady line — but ±45 m cuts the palms' shadows on the beach ahead). At sea
 * the texel is half as big, which is why the reports start on the coast.
 *
 * WHAT. A second map for the raft alone, fitted to it: ±EXTENT about the raft, SIZE² texels (5.4 mm: the ladder's
 * ropes five texels wide, the halyard three), the Sun's own basis (the same orientation, so it is the Sun's map
 * scaled and shifted, a diagonal affine of its coordinates), held on the raft (it rides with it: what casts in it
 * moves against its grid only by turning and bobbing). The raft's casters are taken OUT of the Sun's map and drawn
 * into this one only (`adopt`), so nothing of the raft is rasterized at the coarse texel any more. Because a caster
 * and every receiver of its shadow lie on one ray of the light, they share the map's (u, v): the raft's footprint in
 * this map holds its shadow on its own deck and sails AND on the water or the sand tens of metres down the light —
 * so the one map serves them all, and a receiver outside it cannot be in the raft's shadow at all. The film's filter
 * reads both maps and takes the darker (filmShadowFilter.ts `raft`).
 *
 * Drawn once per beat drawn (update), before the dome's faces: an orthographic Sun's map does not depend on the
 * camera (engine-findings.md finding 3: three's own map is redrawn for each of the twelve cameras a frame). Every
 * frame a pure function of t: the raft's pose and the Sun's direction at t, nothing kept from the frame before.
 */
import * as THREE from 'three/webgpu';
import { uniform, vec4 } from 'three/tsl';

/** texels a side of the raft's map */
export const SIZE = 4096;
/** m: the map's half-reach about the raft's centre, in the light's plane (the raft is 10 m long and its trucks ~8 m
 * up: every caster on it within ~7 m of the centre seen from any Sun; the rest is margin for the filter's reach) */
export const EXTENT = 11;
/** m: the map's camera stands this far up the light from the raft's centre, its near plane EXTENT short of it */
const STANDOFF = 40;
/** m: how far down the light from the raft its shadow is still drawn (receivers past it read as lit); the Sun's own
 * map reaches 2.55 km (sky lighting.ts near 50 .. far 2600) */
const REACH = 1500;

const matrixUniform = () => uniform(new THREE.Matrix4());
const numberUniform = () => uniform(0);
/** three r186 takes the scene as well (RendererUtils.js); its .d.ts still has the older two-argument form */
const rendererUtils = THREE.RendererUtils as unknown as {
  resetRendererAndSceneState(renderer: THREE.WebGPURenderer, scene: THREE.Scene, state: object): object;
  restoreRendererAndSceneState(renderer: THREE.WebGPURenderer, scene: THREE.Scene, state: object): void;
};

export interface RaftShadowMap {
  /** the map's light camera (orthographic, the Sun's basis about the raft): the filter reads its extent and frame */
  readonly camera: THREE.OrthographicCamera;
  /** its depth (32-bit float, point reads: no sampler) */
  readonly depth: THREE.DepthTexture;
  readonly size: number;
  /** the Sun's map coordinates (as three's ShadowNode hands them to the filter: v flipped, the bias added) → this
   * map's, the same convention; rebuilt every update */
  readonly fromSun: ReturnType<typeof matrixUniform>;
  /** 1 while the map holds the raft (0: nothing adopted, or off, and the filter reads the Sun's map alone) */
  readonly on: ReturnType<typeof numberUniform>;
  /**
   * Take `root`'s shadow casters (meshes with castShadow) out of the Sun's map and into this one — again each call,
   * so a caster switched on after the first is found. With `use` false, hand them back to the Sun's map and draw
   * nothing (an A/B: driftParams.seaRaftShadowMap).
   */
  adopt(root: THREE.Object3D, use: boolean): void;
  /** draw the raft's casters for this frame: the raft's centre (world m), the Sun's light as sea.ts has just placed
   * it (its shadow's matrix is brought up to date here), `bias` m along the light, negative toward it as three's
   * (the receiver plane's cover, as sea.ts sets the Sun's) */
  update(renderer: THREE.WebGPURenderer, scene: THREE.Scene, centre: THREE.Vector3, sun: THREE.DirectionalLight, bias: number): void;
}

/** three's ShadowNode.setupShadowCoord after the shadow matrix: v → 1 − v, z → z + bias (not with a reversed depth
 * buffer, which the film does not use) */
const flip = (m: THREE.Matrix4, bias: number): THREE.Matrix4 => m.set(1, 0, 0, 0, 0, -1, 0, 1, 0, 0, 1, bias, 0, 0, 0, 1);
const flipA = new THREE.Matrix4();
const flipB = new THREE.Matrix4();
const sunInv = new THREE.Matrix4();

/**
 * The Sun's map coordinates as the filter receives them (its shadow matrix, then v flipped and its bias added) → the
 * raft map's in the same convention: the raft's flip·matrix after the inverse of the Sun's. Worked in double precision
 * here — the Sun's matrix carries the coast's 40 km, the product only a scale and an offset of a few units — so the
 * GPU's float32 never sees the 40 km in it.
 */
export function sunToRaft(sunMatrix: THREE.Matrix4, sunBias: number, raftMatrix: THREE.Matrix4, raftBias: number, out = new THREE.Matrix4()): THREE.Matrix4 {
  sunInv.copy(sunMatrix).invert();
  return out.copy(flip(flipA, raftBias)).multiply(raftMatrix).multiply(sunInv).multiply(flip(flipB, sunBias).invert());
}

export function createRaftShadow(): RaftShadowMap {
  const target = new THREE.RenderTarget(SIZE, SIZE, { depthBuffer: true });
  target.texture.name = 'RaftShadowColour';
  const depth = new THREE.DepthTexture(SIZE, SIZE, THREE.FloatType);
  depth.name = 'RaftShadowDepth';
  target.depthTexture = depth;
  // (a light of its own, never added to the scene: only its shadow's camera and matrix, built by three's own
  // LightShadow.updateMatrices exactly as the Sun's are, so the two maps' conventions cannot drift apart)
  const light = new THREE.DirectionalLight();
  const camera = light.shadow.camera as THREE.OrthographicCamera;
  camera.left = -EXTENT;
  camera.right = EXTENT;
  camera.top = EXTENT;
  camera.bottom = -EXTENT;
  camera.near = STANDOFF - EXTENT;
  camera.far = STANDOFF + REACH;
  camera.updateProjectionMatrix();
  light.shadow.mapSize.set(SIZE, SIZE);

  // three's shadow pass, as ShadowBaseNode builds it: a black material flagged as the shadow pass, so the renderer
  // keeps each object's own position, mask and side rules for it (the cloth's billow, Renderer._getShadowNodes)
  const pass = new THREE.NodeMaterial();
  pass.colorNode = vec4(0, 0, 0, 1);
  (pass as unknown as { isShadowPassMaterial: boolean }).isShadowPassMaterial = true;
  pass.name = 'RaftShadowPass';
  pass.blending = THREE.NoBlending;
  pass.fog = false;

  const casters = new Set<THREE.Object3D>();
  let using = false;
  type Draw = (object: THREE.Object3D, ...rest: unknown[]) => void;
  let renderer: THREE.WebGPURenderer | null = null;
  const only: Draw = (object, ...rest) => {
    if (!casters.has(object) || !renderer) return;
    (renderer as unknown as { renderObject: Draw }).renderObject(object, ...rest);
  };
  let state: object = {};

  const fromSun = matrixUniform();
  const on = numberUniform();

  return {
    camera,
    depth,
    size: SIZE,
    fromSun,
    on,
    adopt(root, use) {
      root.traverse((o) => {
        if (!(o as THREE.Mesh).isMesh) return;
        if (use && o.castShadow) {
          o.castShadow = false;
          casters.add(o);
        } else if (!use && casters.has(o)) {
          o.castShadow = true;
          casters.delete(o);
        }
      });
      using = use && casters.size > 0;
      on.value = using ? 1 : 0;
    },
    update(r, scene, centre, sun, bias) {
      if (!using) return;
      if ((r as unknown as { reversedDepthBuffer?: boolean }).reversedDepthBuffer) throw new Error('raftShadow: a reversed depth buffer is not handled');
      const dir = sun.position.clone().sub(sun.target.position).normalize();
      light.position.copy(centre).addScaledVector(dir, STANDOFF);
      light.target.position.copy(centre);
      light.updateMatrixWorld();
      light.target.updateMatrixWorld();
      light.shadow.updateMatrices(light);
      // the Sun's matrix for this frame (three rebuilds it the same way when it draws its map)
      sun.updateMatrixWorld();
      sun.target.updateMatrixWorld();
      sun.shadow.updateMatrices(sun);
      sunToRaft(sun.shadow.matrix, sun.shadow.bias, light.shadow.matrix, bias / (camera.far - camera.near), fromSun.value);

      renderer = r;
      state = rendererUtils.resetRendererAndSceneState(r, scene, state);
      scene.overrideMaterial = pass;
      r.setRenderObjectFunction(only as never);
      r.setClearColor(0x000000, 0);
      r.setRenderTarget(target);
      r.render(scene, camera);
      rendererUtils.restoreRendererAndSceneState(r, scene, state);
    },
  };
}
