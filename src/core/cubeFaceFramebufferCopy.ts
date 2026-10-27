/**
 * Copy the framebuffer from the face being drawn, not from face 0 (three r186).
 *
 * WHAT IS WRONG. `WebGPUBackend.copyFramebufferToTexture` — what `viewportTexture` / `viewportSharedTexture`
 * run mid-pass to give a material the picture behind it (the ocean's refraction) — copies from the render
 * target's texture at `origin.z = 0` always. Drawing into face k of a cube target (`setRenderTarget(t, k)`,
 * every CubeCamera), it copies face 0 instead: on five of six faces the water refracts another face's picture,
 * and the seabed, the raft's submerged half and the sun road jump at every face edge (The Drift's dome capture:
 * docs/drift/engine-findings.md, "glitter" on the water at the face edges). The layered path for array cameras
 * already passes its layer; the single-layer path forgets it.
 *
 * WHAT THIS DOES. Wraps `copyFramebufferToTexture` to note the render context's `activeCubeFace` (the layer
 * three draws into, for cube and array targets alike) and `_copyFramebufferToTexture` to copy from that layer
 * when the caller gave none and the source has it (a target's depth texture is a single layer: it stays 0).
 */
import type * as THREE from 'three/webgpu';

type Copy = (this: unknown, texture: unknown, renderContext: { activeCubeFace?: number }, rectangle: unknown) => unknown;
type InnerCopy = (
  this: unknown,
  encoder: unknown,
  texture: unknown,
  sourceGPU: { depthOrArrayLayers: number },
  destinationGPU: unknown,
  rectangle: unknown,
  sourceLayer?: number,
  generateMipmaps?: boolean,
) => unknown;

interface CopyHost {
  copyFramebufferToTexture?: Copy;
  _copyFramebufferToTexture?: InnerCopy;
}

export function installCubeFaceFramebufferCopy(renderer: THREE.WebGPURenderer): void {
  const host = (renderer as unknown as { backend: CopyHost }).backend;
  const copy = host.copyFramebufferToTexture;
  const inner = host._copyFramebufferToTexture;
  if (typeof copy !== 'function' || typeof inner !== 'function') {
    throw new Error('cubeFaceFramebufferCopy: WebGPUBackend framebuffer copy not found — three internals changed, re-check this hook');
  }
  let face = 0;
  host.copyFramebufferToTexture = function (texture, renderContext, rectangle) {
    face = renderContext.activeCubeFace ?? 0;
    try {
      return copy.call(this, texture, renderContext, rectangle);
    } finally {
      face = 0;
    }
  };
  host._copyFramebufferToTexture = function (encoder, texture, sourceGPU, destinationGPU, rectangle, sourceLayer, generateMipmaps) {
    const layer = sourceLayer ?? (sourceGPU.depthOrArrayLayers > face ? face : 0);
    return inner.call(this, encoder, texture, sourceGPU, destinationGPU, rectangle, layer, generateMipmaps);
  };
}
