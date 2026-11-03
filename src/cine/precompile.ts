/**
 * BUILD A FRAME'S PIPELINES IN PARALLEL before it is drawn (three r186, WebGPU).
 *
 * WHAT IS SLOW. three creates each render pipeline on the draw that first needs it, with the synchronous
 * `device.createRenderPipeline`. Chrome queues that to its GPU process, whose main thread compiles every pipeline
 * there, one after another (Dawn: WGSL → MSL / HLSL → the driver's compiler), and the page's next call that must wait
 * for the GPU process — a `queue.writeBuffer`, usually — blocks until the queue has drained. The Drift's first frame
 * of a take builds ~450–1000 of them: the farm's profile of a 1024² dome frame at 720 s (windows-monster,
 * 2026-11-03, out/drift/boot-test/wm-prof2) spent 62 of its 106 s blocked in writeBuffer, and a Chrome trace of the
 * same frame on the Mac had the GPU process's main thread 35 s in `DeviceBase::APICreateRenderPipeline` alone
 * (2111 `MTLDevice newLibraryWithSource`). The persistent shader caches (scripts/drift-chrome.mjs) do not save it:
 * the Dawn cache hit 622 times and the driver still compiled every function.
 *
 * WHAT THIS DOES. `compileFrame(renderer, draw)` runs `draw` — the frame — once with three's draw step replaced by
 * the one its own `compileAsync` uses (`Renderer._createObjectPipeline`: the render object's nodes, bindings and
 * pipeline made ready, nothing drawn), each new pipeline asked for with `createRenderPipelineAsync`, which Dawn
 * compiles on its worker threads, all at once; then waits for them. The frame drawn after it finds every pipeline
 * built. It is the frame's own draw calls, so it compiles exactly the pipelines that frame needs: every render
 * target, cube face, shadow map, mirror, AO and post pass the frame reaches, which `compileAsync(scene, camera)` for
 * one scene and camera would not.
 *
 * WHAT IT LEAVES AS IT WAS. Nothing is drawn, so no render target holds anything from it. Computes run as always
 * (their pipelines are made synchronously, as before): a stateful simulation stepped by the frame — the sea's wake
 * and the swash, both compute only — reaches the same state it would have reached in the frame itself, and the frame
 * after then steps it no further (sea.ts wakeTo, swashSim.ts swashPlan: the same t is the same state). The frame
 * after is the one the take draws anyway (src/drift/record.ts: its warm-up frame, drawn and dropped), so whatever
 * else builds on first use still builds there. Node-frame ids move on as for any other frame; three's own rAF moves
 * them by the wall clock anyway, so nothing may depend on them across frames.
 *
 * FAILS LOUD. A pipeline that does not build would never draw (three skips a draw whose pipeline is not ready) —
 * an object silently missing from every frame, where the synchronous path's invalid pipeline reaches the page's
 * uncaptured-error handler and fails the take. So any pipeline that is not ready when the waiting ends throws, with
 * the materials' names.
 */
import type * as THREE from 'three/webgpu';

/** three's Renderer internals this needs (r186), duck-typed */
interface RendererInternals {
  _renderObjectDirect: (...args: unknown[]) => void;
  _currentRenderContext: unknown;
  _objects: { get: (...args: unknown[]) => RenderObjectLike };
  _nodes: { updateBefore: (ro: RenderObjectLike) => void; updateForRender: (ro: RenderObjectLike) => void; updateAfter: (ro: RenderObjectLike) => void };
  _geometries: { updateForRender: (ro: RenderObjectLike) => void };
  _bindings: { updateForRender: (ro: RenderObjectLike) => void };
  _pipelines: { getForRender: (ro: RenderObjectLike, promises: Promise<void>[] | null) => unknown; isReady: (ro: RenderObjectLike) => boolean };
}
interface RenderObjectLike {
  drawRange: unknown;
  group: unknown;
  material?: { name?: string; type?: string };
}

export interface CompileStats {
  /** pipelines asked for asynchronously (new to this frame) */
  pipelines: number;
  /** render objects the frame reached */
  objects: number;
  /** ms of the page's time: the frame without its draws, then the wait for the pipelines */
  frameMs: number;
  waitMs: number;
}

/**
 * Run `draw` (one whole frame, synchronous) with its draws replaced by pipeline builds, wait for every pipeline it
 * asked for, and return what it built. See the header.
 */
export async function compileFrame(renderer: THREE.WebGPURenderer, draw: () => void): Promise<CompileStats> {
  const r = renderer as unknown as RendererInternals;
  const own = Object.prototype.hasOwnProperty.call(r, '_renderObjectDirect');
  if (typeof r._renderObjectDirect !== 'function' || typeof r._objects?.get !== 'function' || typeof r._pipelines?.getForRender !== 'function') {
    throw new Error('compileFrame: three Renderer internals not found — three changed, re-check this hook');
  }
  const promises: Promise<void>[] = [];
  const reached = new Set<RenderObjectLike>();
  const t0 = performance.now();
  // (an own property shadows the prototype's: Renderer._renderScene assigns `this._renderObjectDirect` as its draw
  // step each time it renders, so every render the frame makes, nested ones too, takes this one)
  // three's _createObjectPipeline, its synchronous path, with our promises: the pipeline built asynchronously
  r._renderObjectDirect = function (this: RendererInternals, object, material, scene, camera, lightsNode, group, clippingContext, passId) {
    const ro = this._objects.get(object, material, scene, camera, lightsNode, this._currentRenderContext, clippingContext, passId);
    ro.drawRange = (object as { geometry: { drawRange: unknown } }).geometry.drawRange;
    ro.group = group;
    this._nodes.updateBefore(ro);
    this._geometries.updateForRender(ro);
    this._nodes.updateForRender(ro);
    this._bindings.updateForRender(ro);
    this._pipelines.getForRender(ro, promises);
    this._nodes.updateAfter(ro);
    reached.add(ro);
  };
  try {
    draw();
  } finally {
    if (!own) delete (r as unknown as Record<string, unknown>)._renderObjectDirect;
  }
  const t1 = performance.now();
  await Promise.all(promises);
  const t2 = performance.now();
  const failed = [...reached].filter((ro) => !r._pipelines.isReady(ro));
  if (failed.length > 0) {
    const names = [...new Set(failed.map((ro) => ro.material?.name || ro.material?.type || '?'))].slice(0, 8);
    throw new Error(`compileFrame: ${failed.length} render pipeline(s) did not build (${names.join(', ')}): the WebGPU errors are logged above`);
  }
  return { pipelines: promises.length, objects: reached.size, frameMs: t1 - t0, waitMs: t2 - t1 };
}
