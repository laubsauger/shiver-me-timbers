/**
 * The water's mirror for the dome: what floats on the sea (the raft, the debris, the rocks and the island)
 * reflected in it (v8 notes: "reflections seem missing… things look detached").
 *
 * The game's planar mirror pass (src/reflection) is screen-space, built for one camera: a second render per
 * camera, looked up at the fragment's screen position. The dome draws six cube faces a frame, and through them
 * its pass never reached the water (docs/drift/engine-findings.md). This is the dome's own form of the same
 * mirror: ONE cube capture from the eye mirrored under the water (x, −y, z), of everything but the sea and the
 * sky, cleared transparent, clipped at the waterline (nothing under the water is mirrored). For flat water the
 * scene a ray reflected up from the surface meets is exactly what that capture sees along the reflected
 * direction; waves bend the lookup with the facet's own normal, and blur it with its tilt and the distance.
 * Where the capture saw nothing (alpha), the ocean's analytic sky stays — as the game's mirror composites.
 *
 * It plugs into the ocean through the same hook (ReflectionShadeInput → colour).
 */
import * as THREE from 'three/webgpu';
import { cubeTexture, float, mix, reflect, smoothstep, uniform } from 'three/tsl';
import type { PlanarReflection } from '../../reflection';
import type { ReflectionShadeInput } from '../../reflection/reflectionShading';

/** m: the mirror holds full strength within this distance of the eye, and is gone past the second */
const FADE: [number, number] = [400, 2500];
/** mip levels of blur per unit of facet tilt (sin), and at the far fade */
const BLUR_TILT = 3;
const BLUR_FAR = 3;

export interface CubeMirror {
  /** for OceanSurface's `reflection` (only its shading hook is read) */
  readonly reflection: PlanarReflection;
  /** capture the scene from the eye mirrored under the water, with `hide` (the sea, the sky) left out */
  update(renderer: THREE.WebGPURenderer, scene: THREE.Scene, eye: THREE.Vector3, hide: THREE.Object3D[]): void;
  /** put what stands in the water under this (it is cut at the waterline while the mirror is taken) */
  readonly floating: THREE.ClippingGroup;
}

export function createCubeMirror(size: number, far: number): CubeMirror {
  const target = new THREE.CubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  const camera = new THREE.CubeCamera(0.05, far, target);
  const active = uniform(0);
  const floating = new THREE.ClippingGroup();
  floating.name = 'drift-floating';
  floating.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)];
  floating.enabled = false;
  const clear = new THREE.Color();

  const shade = (input: ReflectionShadeInput): THREE.Node<'vec3'> => {
    const r = reflect(input.viewDirection.negate(), input.normalWorld);
    const tilt = float(1).sub(input.normalWorld.y.clamp(0, 1).mul(input.normalWorld.y.clamp(0, 1))).max(0).sqrt();
    const far = smoothstep(FADE[0], FADE[1], input.camDist);
    const s = cubeTexture(target.texture, r).level(tilt.mul(BLUR_TILT).add(far.mul(BLUR_FAR)).clamp(0, 6));
    const coverage = s.a.clamp(0, 1);
    // premultiplied: the transparent clear blended in under the geometry
    const seen = s.rgb.div(coverage.max(1e-3));
    return mix(input.skyColor, seen, coverage.mul(active).mul(far.oneMinus())) as THREE.Node<'vec3'>;
  };

  return {
    reflection: { shade } as unknown as PlanarReflection,
    floating,
    update(renderer, scene, eye, hide) {
      camera.position.set(eye.x, -eye.y, eye.z);
      camera.updateMatrixWorld();
      const was = hide.map((o) => o.visible);
      hide.forEach((o) => (o.visible = false));
      const bg = scene.background;
      const bgNode = scene.backgroundNode;
      const autoClear = renderer.autoClear;
      renderer.getClearColor(clear);
      const alpha = renderer.getClearAlpha();
      scene.background = null;
      scene.backgroundNode = null;
      renderer.setClearColor(0x000000, 0);
      renderer.autoClear = true;
      floating.enabled = true;
      try {
        camera.update(renderer, scene);
      } finally {
        hide.forEach((o, i) => (o.visible = was[i]));
        scene.background = bg;
        scene.backgroundNode = bgNode;
        renderer.autoClear = autoClear;
        floating.enabled = false;
        renderer.setClearColor(clear, alpha);
      }
      active.value = eye.y > 0.05 ? 1 : 0;
    },
  };
}
