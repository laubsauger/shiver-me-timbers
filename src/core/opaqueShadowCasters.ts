/**
 * Keep opaque casters' colour graphs out of the shadow pass (three r186).
 *
 * WHAT CHANGED. three r180 drew a caster into the shadow map with the shadow
 * pass material plus, at most, the caster's `castShadowNode`. r186's
 * `Renderer._getShadowNodes` also folds `material.colorNode.a` into the shadow
 * pass colour for EVERY caster that has a colorNode, so the whole colour graph
 * is built and run while the shadow map is the render target.
 *
 * WHY THAT BREAKS HERE. Every ship piece material has a colorNode, and those
 * graphs read the sun shadow map (shadow receivers) and copy the viewport
 * depth (caustics / wetline). Inside the shadow pass that means binding the
 * ShadowDepthTexture while rendering into it, and a viewport depth copy at
 * shadow-map size — both WebGPU validation errors that drop the pass. It also
 * compiles a second full-weight shader per caster for nothing: these pieces
 * are opaque, their alpha is 1.
 *
 * WHAT THIS DOES. Wraps `_getShadowNodes` so a material that is opaque (not
 * transparent, no alphaTest) and has no `castShadowNode` is seen WITHOUT its
 * colorNode — r180 semantics. Cut-out and transparent materials keep r186's
 * behaviour, because their shadow needs the alpha. The result is cached by
 * three per material version, so the wrapper runs once per material.
 */
import type * as THREE from 'three/webgpu';

interface ShadowNodesHost {
  _getShadowNodes?: (material: THREE.Material) => unknown;
}

interface ShadowRelevantMaterial {
  colorNode?: unknown;
  castShadowNode?: unknown;
  alphaTest: number;
  transparent: boolean;
}

export function installOpaqueShadowCasters(renderer: THREE.WebGPURenderer): void {
  const host = renderer as unknown as ShadowNodesHost;
  const original = host._getShadowNodes;
  if (typeof original !== 'function') {
    throw new Error('opaqueShadowCasters: Renderer._getShadowNodes not found — three internals changed, re-check this hook');
  }
  host._getShadowNodes = function (this: unknown, material: THREE.Material): unknown {
    const m = material as unknown as ShadowRelevantMaterial;
    const opaque = !m.transparent && !(m.alphaTest > 0);
    if (!opaque || !m.colorNode || m.castShadowNode) return original.call(this, material);
    const colorNode = m.colorNode;
    m.colorNode = null;
    try {
      return original.call(this, material);
    } finally {
      m.colorNode = colorNode;
    }
  };
}
