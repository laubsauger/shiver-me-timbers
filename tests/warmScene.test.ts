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
