/**
 * §T.79 — why the deferred warm-up compiles into a MIRROR scene and not into
 * the bare object.
 *
 * `Renderer.compileAsync(root, camera, targetScene)` builds every render
 * object against `root` when it is a Scene, and against three's private empty
 * `_scene` when it is not (Renderer.js:860). The node-builder cache is keyed
 * by `RenderObject.initialCacheKey`, whose dynamic half is
 * `Nodes.getCacheKey(scene, lightsNode)` — a hash over the lights, the scene's
 * ENVIRONMENT node and its FOG node (Nodes.js:395-411). Our scene has fog, the
 * empty one does not, so a warm-up rooted at the object builds a shader under
 * a key the real frame never asks for: the whole TSL build is redone
 * SYNCHRONOUSLY on the object's first draw, which is precisely the hitch the
 * warm-up exists to prevent.
 *
 * Pinned here against three's own `Nodes`, headless: a scene-less root and the
 * fogged scene hash DIFFERENTLY; a throwaway scene carrying the SAME Fog
 * object hashes IDENTICALLY. main.ts `warmObject` relies on the second fact.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { lights } from 'three/tsl';
import Nodes from 'three/src/renderers/common/nodes/Nodes.js';

function makeNodes(): { getCacheKey(scene: THREE.Scene, lightsNode: unknown): number } {
  // `getCacheKey` memoises per `renderer.info.calls`; a fresh id per call keeps
  // every lookup honest instead of replaying the first answer.
  let calls = 0;
  const renderer = { info: { get calls() { return ++calls; } }, getOutputRenderTarget: () => null, shadowMap: { enabled: true } };
  return new (Nodes as unknown as new (r: unknown, b: unknown) => ReturnType<typeof makeNodes>)(renderer, {});
}

describe('§T.79 warm-up scene key', () => {
  const sun = new THREE.DirectionalLight();
  const lightsNode = lights([sun]);

  it('a scene-less compile root hashes differently from the fogged scene', () => {
    const nodes = makeNodes();
    const real = new THREE.Scene();
    real.fog = new THREE.Fog(0xa1e7ff, 700, 4500);
    const bare = new THREE.Scene(); // what compileAsync substitutes for a non-Scene root
    expect(nodes.getCacheKey(bare, lightsNode)).not.toBe(nodes.getCacheKey(real, lightsNode));
  });

  it('a mirror scene sharing the same Fog object hashes identically', () => {
    const nodes = makeNodes();
    const real = new THREE.Scene();
    real.fog = new THREE.Fog(0xa1e7ff, 700, 4500);
    const mirror = new THREE.Scene();
    mirror.fog = real.fog;
    mirror.environment = real.environment;
    expect(nodes.getCacheKey(mirror, lightsNode)).toBe(nodes.getCacheKey(real, lightsNode));
  });

  it('a DIFFERENT Fog instance with equal parameters does not match (the object, not its values, is the key)', () => {
    const nodes = makeNodes();
    const real = new THREE.Scene();
    real.fog = new THREE.Fog(0xa1e7ff, 700, 4500);
    const copy = new THREE.Scene();
    copy.fog = new THREE.Fog(0xa1e7ff, 700, 4500);
    expect(nodes.getCacheKey(copy, lightsNode)).not.toBe(nodes.getCacheKey(real, lightsNode));
  });
});

/**
 * §T.124 — the OTHER two ways the warm-up's render context differs from a real
 * frame's, both of which showed up as WebGPU validation errors on a clean raft
 * boot at shipped defaults. Neither is reachable without a device, so what is
 * pinned here is the three-side fact each fix compensates for: if either of
 * these ever stops being true, `postPipeline.syncPassTarget` /
 * `bindCompileTarget` are dead code and should go, not quietly keep running.
 */
import RenderContexts from 'three/src/renderers/common/RenderContexts.js';
import { pass } from 'three/tsl';

describe('§T.124 the warm-up binds a real frame\'s target, not a placeholder', () => {
  it('a PassNode target is 1×1 until something sizes it', () => {
    // `PassNode.setSize` runs in its own `updateBefore`, i.e. on the first real
    // frame — AFTER every warm-up. A warm-up that binds the target without
    // sizing it hands a 1×1 render target to every node whose `updateBefore`
    // copies the framebuffer (the ocean's viewportTexture/viewportDepthTexture),
    // and a 1×1 copy out of the full-size depth attachment is rejected outright:
    //   Copy origin … (1×1) does not cover the entire subresource … Depth24Plus
    //   … sample count 4  →  Invalid CommandBuffer
    const scenePass = pass(new THREE.Scene(), new THREE.PerspectiveCamera());
    expect(scenePass.renderTarget.width).toBe(1);
    expect(scenePass.renderTarget.height).toBe(1);

    // and this is the sizing a real frame performs, which syncPassTarget mirrors
    scenePass.setPixelRatio(2);
    scenePass.setSize(1800, 985);
    expect(scenePass.renderTarget.width).toBe(3600);
    expect(scenePass.renderTarget.height).toBe(1970);
  });

  it('nothing gives a fresh render context a renderTarget — compileAsync never assigns one', () => {
    // `WebGPUBackend.copyFramebufferToTexture` branches on
    // `renderContext.renderTarget`: falsy means "read the CANVAS". `_renderScene`
    // sets it; `compileAsync` (r180) does not, so a warm-up bound to the HDR
    // pass target still copied out of the bgra8unorm swapchain —
    //   copyFramebufferToTexture: Source and destination formats do not match.
    //   bgra8unorm rgba16float
    // — and a copy that fails is a copy that did not happen.
    const contexts = new (RenderContexts as unknown as new () => {
      get(s: THREE.Scene, c: THREE.Camera, t: THREE.RenderTarget): { renderTarget?: unknown | null };
    })();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const target = new THREE.RenderTarget(64, 64);
    const context = contexts.get(scene, camera, target);
    expect(context.renderTarget ?? null).toBeNull();

    // …and the context is keyed on (scene, camera, target), so assigning the
    // field before compileAsync fetches it reaches the very same object.
    expect(contexts.get(scene, camera, target)).toBe(context);
  });
});
