/**
 * §T.79 — the compile profiler must not count a nested pass twice.
 *
 * Inside `compileAsync`, an object's `updateBefore` can open a whole
 * `renderer.render()` (a planar reflection; on r186 a shadow map no longer
 * does, `ShadowNode.updateBefore` returns while `_isPreCompiling`). Every
 * object of that pass goes back through the node build and pipeline request
 * the profiler wraps, so a sample spanning its opener's whole turn would
 * contain the inner ones, and a sum over samples would report the pass once as
 * itself and once inside its opener. Pinned: every counter is exclusive, the
 * sum over samples is the work done once, and `depth` tells the passes apart.
 *
 * The fake is the r186 shape `src/core/compileProfile.ts` hooks (its header):
 * `compileAsync` queues one item per render object, then per item awaits
 * `_nodes.getForRenderAsync` (which calls `this.getForRender(ro, true)`), runs
 * `_nodes.updateBefore` with `_isPreCompiling` set, then requests the pipeline
 * with `_pipelines.getForRender(ro, promises)` and awaits those promises
 * (Renderer.js `compileAsync`). A nested pass reaches the same two methods
 * through `RenderObject.getNodeBuilderState` and `Pipelines.updateForRender`,
 * synchronously and without a promise list. Every call goes through the
 * instance property, as three's do, so the profiler's wrappers see it.
 */
import { describe, expect, it } from 'vitest';
import { profileCompile } from '../src/core/compileProfile';

function spin(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    /* busy */
  }
}

interface FakeRenderObject {
  object: { name: string };
  material: { type: string };
}

interface FakeRenderer {
  _isPreCompiling: boolean;
  _nodes: {
    getForRender(renderObject: FakeRenderObject, useAsync?: boolean): unknown;
    getForRenderAsync(renderObject: FakeRenderObject): Promise<unknown>;
    updateBefore(renderObject: FakeRenderObject): void;
  };
  _pipelines: {
    caches: Map<string, unknown>;
    programs: { vertex: Map<string, unknown>; fragment: Map<string, unknown> };
    getForRender(renderObject: FakeRenderObject, promises?: Array<Promise<unknown>> | null): void;
  };
  compileAsync(items: FakeRenderObject[]): Promise<void>;
}

const item = (name: string, type: string): FakeRenderObject => ({
  object: { name },
  material: { type },
});

/** the slice of a WebGPURenderer the profiler reaches into, as a fake */
function fakeRenderer(): FakeRenderer {
  const caches = new Map<string, unknown>();
  const programs = { vertex: new Map<string, unknown>(), fragment: new Map<string, unknown>() };
  const renderer: FakeRenderer = {
    _isPreCompiling: false,
    _nodes: {
      getForRender(renderObject, useAsync = false) {
        const state = { built: renderObject.object.name };
        // each caster's node build is the real work of the nested pass
        if (renderObject.object.name.startsWith('caster')) spin(15);
        // the opener's own build is cheap, and async the way compileAsync asks
        return useAsync ? Promise.resolve(state) : state;
      },
      getForRenderAsync(renderObject) {
        const result = this.getForRender(renderObject, true) as { then?: unknown };
        return typeof result.then === 'function'
          ? (result as Promise<unknown>)
          : Promise.resolve(result);
      },
      updateBefore(renderObject) {
        if (renderObject.object.name !== 'lit-opener') return;
        // the nested pass: two objects, each its own sample, both doing work
        for (const caster of [item('caster-a', 'Depth'), item('caster-b', 'Depth')]) {
          renderer._nodes.getForRender(caster);
          renderer._pipelines.getForRender(caster);
        }
      },
    },
    _pipelines: {
      caches,
      programs,
      getForRender(renderObject, promises = null) {
        const name = renderObject.object.name;
        if (name === 'lit-opener') {
          caches.set('lit', {});
          programs.vertex.set('v'.repeat(100), {});
          programs.fragment.set('f'.repeat(50), {});
          // the driver's `createRenderPipelineAsync`
          promises?.push(new Promise((resolve) => setTimeout(resolve, 1)));
          return;
        }
        caches.set(name, {});
        programs.vertex.set(name.padEnd(10, 'x'), {});
      },
    },
    async compileAsync(items) {
      for (const ro of items) {
        await this._nodes.getForRenderAsync(ro);
        this._isPreCompiling = true;
        this._nodes.updateBefore(ro);
        this._isPreCompiling = false;
        const pipelinePromises: Array<Promise<unknown>> = [];
        this._pipelines.getForRender(ro, pipelinePromises);
        if (pipelinePromises.length > 0) await Promise.all(pipelinePromises);
      }
    },
  };
  return renderer;
}

describe('§T.79 compileProfile nesting', () => {
  it('an opener\'s sample excludes the pass it opened, and depth tells them apart', async () => {
    const renderer = fakeRenderer();
    const phase = await profileCompile(renderer as never, 'fake', () =>
      renderer.compileAsync([item('lit-opener', 'MeshStandardNodeMaterial')]),
    );
    const byName = new Map(phase.samples.map((s) => [s.object, s]));
    const opener = byName.get('lit-opener')!;
    const a = byName.get('caster-a')!;
    const b = byName.get('caster-b')!;

    // the casters ran INSIDE the opener's turn, one level down
    expect(opener.depth).toBe(0);
    expect(a.depth).toBe(1);
    expect(b.depth).toBe(1);

    // exclusive counters: the opener added ONE pipeline and TWO programs of its
    // own, not the casters' on top
    expect(opener.pipelines).toBe(1);
    expect(opener.programs).toBe(2);
    expect(opener.wgsl).toBe(150);
    expect(a.pipelines).toBe(1);
    expect(a.programs).toBe(1);
    expect(a.wgsl).toBe(10);

    // exclusive time: the opener itself did ~nothing; each caster spun 15 ms.
    // Generous bounds — this asserts containment, not a machine's speed.
    expect(opener.sync).toBeLessThan(10);
    expect(a.sync).toBeGreaterThanOrEqual(14);
    expect(b.sync).toBeGreaterThanOrEqual(14);

    // the phase total is the work done ONCE: it cannot exceed the wall clock,
    // which a double count of two 15 ms casters inside a 30 ms opener would
    expect(phase.sync).toBeLessThanOrEqual(phase.wall + 1);
    expect(phase.pipelines).toBe(3);
    expect(phase.programs).toBe(4);
  });

  it('the hook is removed afterwards', async () => {
    const renderer = fakeRenderer();
    const nodesBefore = renderer._nodes.getForRender;
    const pipelinesBefore = renderer._pipelines.getForRender;
    await profileCompile(renderer as never, 'fake', async () => {});
    expect(renderer._nodes.getForRender).toBe(nodesBefore);
    expect(renderer._pipelines.getForRender).toBe(pipelinesBefore);
  });
});
