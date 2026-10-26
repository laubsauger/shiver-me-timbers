/**
 * @types/three 0.186 stopped shipping declarations for these renderer internals. The tests that pin
 * three's own behaviour (warmScene, wakeSpeedboatLook) import them directly, so they are declared here,
 * narrowly, with only what those tests touch.
 */
declare module 'three/src/renderers/common/nodes/NodeManager.js' {
  const NodeManager: unknown;
  export default NodeManager;
}

declare module 'three/src/renderers/common/RenderContexts.js' {
  const RenderContexts: unknown;
  export default RenderContexts;
}

declare module 'three/src/renderers/common/RenderList.js' {
  import type { Object3D } from 'three/webgpu';
  interface RenderItem {
    object: Object3D;
  }
  export default class RenderList {
    constructor(lighting: unknown, scene: unknown, camera: unknown);
    transparent: RenderItem[];
    begin(): this;
    push(...args: unknown[]): void;
    sort(opaqueSort: unknown, transparentSort: unknown): void;
  }
}
