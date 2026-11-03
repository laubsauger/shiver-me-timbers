/**
 * THE PIPELINES BUILT BEFORE THE FIRST FRAME (src/cine/precompile.ts compileFrame; record.ts calls it before a take's
 * warm-up frame — the 2026-11-03 warm-up work: on windows-monster the first frame built ~1000 pipelines one by one in
 * Chrome's GPU process, 62 of its 106 s). What must hold, on a stand-in for three's Renderer:
 *   - THE FRAME DRAWS NOTHING: every draw step becomes a pipeline build with the async path's promise list, and the
 *     render object is made ready the way three's own compileAsync does it (nodes, geometry, bindings, pipeline);
 *   - THE DRAW STEP COMES BACK, even when the frame throws: a renderer left drawing nothing would make every later
 *     frame of the take black;
 *   - IT WAITS for every pipeline it asked for before it resolves, so the warm-up frame finds them built;
 *   - FAILS LOUD: a pipeline that did not build would never draw (three skips a draw whose pipeline is not ready), an
 *     object silently missing from the whole take; so it throws, naming the material.
 */
import { describe, expect, it } from 'vitest';
import type * as THREE from 'three/webgpu';
import { compileFrame } from '../src/cine/precompile';

interface Ro {
  material: { name: string };
  ready: boolean;
  asked?: boolean;
  steps: string[];
  drawRange?: unknown;
  group?: unknown;
}

/** a Renderer as compileFrame sees it: `_renderObjectDirect` on the prototype (three's), the managers it calls */
function fakeRenderer(opts: { fail?: string } = {}) {
  const drawn: string[] = [];
  const objects = new Map<string, Ro>();
  const pending: Array<() => void> = [];
  class R {
    _currentRenderContext = {};
    _objects = {
      get: (object: { name: string }, material: { name: string }) => {
        const k = `${object.name}/${material.name}`;
        if (!objects.has(k)) objects.set(k, { material, ready: false, steps: [] });
        return objects.get(k)!;
      },
    };
    _nodes = { updateBefore: (ro: Ro) => ro.steps.push('before'), updateForRender: (ro: Ro) => ro.steps.push('nodes'), updateAfter: (ro: Ro) => ro.steps.push('after') };
    _geometries = { updateForRender: (ro: Ro) => ro.steps.push('geometry') };
    _bindings = { updateForRender: (ro: Ro) => ro.steps.push('bindings') };
    _pipelines = {
      getForRender: (ro: Ro, promises: Promise<void>[] | null) => {
        ro.steps.push(promises ? 'pipeline async' : 'pipeline sync');
        // (as three's Pipelines: a pipeline is asked for once per render object, the cache answers after that)
        if (ro.asked) return;
        ro.asked = true;
        if (promises) promises.push(new Promise<void>((res) => pending.push(() => ((ro.ready = ro.material.name !== opts.fail), res()))));
        else ro.ready = true;
      },
      isReady: (ro: Ro) => ro.ready,
    };
    /** three's draw step: draws */
    _renderObjectDirect(object: { name: string }, material: { name: string }) {
      drawn.push(`${object.name}/${material.name}`);
    }
    /** what Renderer._renderScene does per object: calls the draw step it finds on itself */
    renderOne(name: string, material = 'm') {
      this._renderObjectDirect({ name, geometry: { drawRange: null } } as never, { name: material } as never);
    }
  }
  const r = new R();
  // (the GPU's answers come later, out of order)
  const settle = () => {
    for (const f of pending.splice(0).reverse()) f();
  };
  return { r, drawn, objects, settle };
}

describe('compileFrame (src/cine/precompile.ts)', () => {
  it('builds every pipeline the frame reaches without drawing, waits for them, and puts the draw step back', async () => {
    const { r, drawn, objects, settle } = fakeRenderer();
    let resolved = false;
    const p = compileFrame(r as unknown as THREE.WebGPURenderer, () => {
      r.renderOne('sea', 'ocean');
      r.renderOne('raft', 'logs');
      r.renderOne('raft', 'logs'); // (a second pass over the same object: one render object, as three's)
    }).then((s) => ((resolved = true), s));
    await Promise.resolve();
    expect(resolved).toBe(false); // waiting for the GPU's answers
    settle();
    const stats = await p;
    expect(drawn).toEqual([]);
    expect(stats.pipelines).toBe(2);
    expect(stats.objects).toBe(2);
    expect(objects.get('sea/ocean')!.steps.slice(0, 6)).toEqual(['before', 'geometry', 'nodes', 'bindings', 'pipeline async', 'after']);
    // the draw step is three's own again: the next frame draws, with the pipelines it finds built
    expect(Object.prototype.hasOwnProperty.call(r, '_renderObjectDirect')).toBe(false);
    r.renderOne('sea', 'ocean');
    expect(drawn).toEqual(['sea/ocean']);
  });

  it('puts the draw step back when the frame throws', async () => {
    const { r } = fakeRenderer();
    await expect(
      compileFrame(r as unknown as THREE.WebGPURenderer, () => {
        r.renderOne('sea');
        throw new Error('a frame that failed');
      }),
    ).rejects.toThrow('a frame that failed');
    expect(Object.prototype.hasOwnProperty.call(r, '_renderObjectDirect')).toBe(false);
  });

  it('fails loud, naming the material, when a pipeline did not build', async () => {
    const { r, settle } = fakeRenderer({ fail: 'palm-leaf' });
    const p = compileFrame(r as unknown as THREE.WebGPURenderer, () => {
      r.renderOne('sea', 'ocean');
      r.renderOne('palm', 'palm-leaf');
    });
    settle();
    await expect(p).rejects.toThrow(/1 render pipeline\(s\) did not build \(palm-leaf\)/);
  });
});
