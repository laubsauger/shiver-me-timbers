/**
 * §T.79 — the compile profiler must not count a nested pass twice.
 *
 * Inside `compileAsync`, an object's `updateBefore` can open a whole
 * `renderer.render()` (shadow map, planar reflection) that routes every object
 * back through `_createObjectPipeline` — the very hook the profiler wraps. The
 * outer sample therefore CONTAINED the inner ones, and a sum over samples
 * reported the shadow pass once as itself and once inside its opener. Pinned:
 * every counter is exclusive, the sum over samples is the work done once, and
 * `depth` tells the passes apart.
 */
import { describe, expect, it } from 'vitest';
import { profileCompile } from '../src/core/compileProfile';

function spin(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    /* busy */
  }
}

interface FakeRenderer {
  _pipelines: {
    caches: Map<string, unknown>;
    programs: { vertex: Map<string, unknown>; fragment: Map<string, unknown> };
  };
  _compilationPromises: Array<Promise<unknown>>;
  _createObjectPipeline(this: FakeRenderer, object: { name: string }, material: unknown): void;
}

/** the slice of a WebGPURenderer the profiler reaches into, as a fake */
function fakeRenderer(): FakeRenderer {
  const caches = new Map<string, unknown>();
  const programs = { vertex: new Map<string, unknown>(), fragment: new Map<string, unknown>() };
  const renderer: FakeRenderer = {
    _pipelines: { caches, programs },
    _compilationPromises: [],
    _createObjectPipeline(object, _material) {
      if (object.name === 'lit-opener') {
        // the shadow "pass": two casters, each its own sample, both doing work
        this._createObjectPipeline({ name: 'caster-a' }, { type: 'Depth' });
        this._createObjectPipeline({ name: 'caster-b' }, { type: 'Depth' });
        caches.set('lit', {});
        programs.vertex.set('v'.repeat(100), {});
        programs.fragment.set('f'.repeat(50), {});
        return;
      }
      spin(15);
      caches.set(object.name, {});
      programs.vertex.set(object.name.padEnd(10, 'x'), {});
    },
  };
  return renderer;
}

describe('§T.79 compileProfile nesting', () => {
  it('an opener\'s sample excludes the pass it opened, and depth tells them apart', async () => {
    const renderer = fakeRenderer();
    const phase = await profileCompile(renderer as never, 'fake', async () => {
      renderer._createObjectPipeline({ name: 'lit-opener' }, { type: 'MeshStandardNodeMaterial' });
    });
    const byName = new Map(phase.samples.map((s) => [s.object, s]));
    const opener = byName.get('lit-opener')!;
    const a = byName.get('caster-a')!;
    const b = byName.get('caster-b')!;

    // the casters ran INSIDE the opener's call, one level down
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
    const before = renderer._createObjectPipeline;
    await profileCompile(renderer as never, 'fake', async () => {});
    expect(renderer._createObjectPipeline).toBe(before);
  });
});
