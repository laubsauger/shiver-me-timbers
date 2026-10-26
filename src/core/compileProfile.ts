/**
 * Shader-compile profiler (§T.40, §V.39).
 *
 * `renderer.compileAsync()` is one opaque await that hid 52s of boot. This
 * splits it per render object so the answer is a RANKED LIST rather than a
 * subsystem hunch — the mast-stave and deck-field bugs were both single terms
 * doing outsized damage, and compile cost has the same failure shape.
 *
 * How (three r186): `compileAsync` first QUEUES one work item per render
 * object, then builds them one at a time — `NodeManager.getForRender` (TSL
 * graph + WGSL codegen, yielding to the main thread between shader stages) and
 * `Pipelines.getForRender` (program + pipeline creation, awaited per object).
 * Wrapping those two on the renderer's own instances gives, per render object:
 *
 *  - `sync`  ms of node build + WGSL codegen. Since r186 this is WALL time from
 *            build start to the built state: three yields between shader
 *            stages, so frames that run in those gaps are included. During
 *            boot little else runs, so it still ranks the heavy materials.
 *  - `wait`  ms from pipeline request to its `createRenderPipelineAsync`
 *            promise resolving = driver work. r186 awaits each object's
 *            pipelines before the next, so these no longer overlap.
 *  - `wgsl`  bytes of shader source the object added, the honest proxy for how
 *            much work the driver was handed (and the first place to look for
 *            a pathological shader after a GPU-process death).
 *
 * A cache hit costs ~0 on every counter, which is exactly what makes shared
 * materials visible in the output: two ships with their own material set show
 * up twice, two ships sharing one set show up once.
 *
 * NESTED PASSES (§T.79). A reflector answers its object's `updateBefore`
 * with a whole `renderer.render()` of the scene (a `ShadowNode` no longer
 * does during compile: r186 returns early while `_isPreCompiling`), and inside
 * `compileAsync` that runs between the object's node build and its pipeline
 * request. Each nested object gets its own sample (the counters are per call,
 * so nothing is counted twice), and `depth` says which pass it came from: 0 is
 * the compile root's own list, 1 is a pass a node opened under it (three's
 * `_isPreCompiling` is set exactly while those passes run).
 */
import type * as THREE from 'three/webgpu';

export interface CompileSample {
  /** object name (or type) — the thing that pulled the pipeline in */
  object: string;
  /** material name (or type) */
  material: string;
  /** main-thread ms: node build + WGSL codegen + binding setup */
  sync: number;
  /** ms until this object's pipeline promise resolved (driver, concurrent) */
  wait: number;
  /** render pipelines newly created by this object */
  pipelines: number;
  /** shader programs (vertex+fragment stages) newly created */
  programs: number;
  /** bytes of WGSL those new programs contain */
  wgsl: number;
  /** 0 = compile root's own render list; 1+ = a nested pass (shadow, reflection) */
  depth: number;
}

export interface CompilePhase {
  label: string;
  /** wall-clock ms of the whole phase, including the async pipeline wait */
  wall: number;
  /** summed main-thread ms — the part that blocks the tab */
  sync: number;
  pipelines: number;
  programs: number;
  wgsl: number;
  samples: CompileSample[];
}

/** three internals this module reaches into; all private-by-convention. */
type NodeGetForRender = (renderObject: unknown, useAsync?: boolean) => unknown;
type PipelineGetForRender = (renderObject: unknown, promises?: Array<Promise<unknown>> | null) => unknown;
interface RendererInternals {
  _isPreCompiling?: boolean;
  _nodes: { getForRender: NodeGetForRender };
  _pipelines: {
    getForRender: PipelineGetForRender;
    caches: Map<unknown, unknown>;
    programs: { vertex: Map<string, unknown>; fragment: Map<string, unknown> };
  };
}

interface RenderObjectLike {
  object?: { name?: string; type?: string };
  material?: { name?: string; type?: string };
}

function newKeyBytes(map: Map<string, unknown>, from: number): number {
  if (map.size <= from) return 0;
  let bytes = 0;
  let i = 0;
  for (const key of map.keys()) {
    if (i++ >= from) bytes += typeof key === 'string' ? key.length : 0;
  }
  return bytes;
}

/**
 * Run `compile` (any function that ends up inside `renderer.compileAsync`)
 * with per-object instrumentation installed.
 *
 * Safe to nest around anything: the hook is removed in a finally, and it only
 * reads counters — it never changes what gets compiled.
 */
export async function profileCompile(
  renderer: THREE.WebGPURenderer,
  label: string,
  compile: () => Promise<unknown>,
): Promise<CompilePhase> {
  const internals = renderer as unknown as RendererInternals;
  const nodes = internals._nodes;
  const pipes = internals._pipelines;
  const originalBuild = nodes.getForRender;
  const originalPipeline = pipes.getForRender;
  const samples: CompileSample[] = [];
  const byObject = new Map<unknown, CompileSample>();
  const t0 = performance.now();

  const sampleOf = (renderObject: unknown): CompileSample => {
    let sample = byObject.get(renderObject);
    if (sample === undefined) {
      const ro = renderObject as RenderObjectLike;
      sample = {
        object: ro.object?.name || ro.object?.type || '?',
        material: ro.material?.name || ro.material?.type || '?',
        sync: 0,
        wait: 0,
        pipelines: 0,
        programs: 0,
        wgsl: 0,
        depth: internals._isPreCompiling === true ? 1 : 0,
      };
      byObject.set(renderObject, sample);
      samples.push(sample);
    }
    return sample;
  };

  nodes.getForRender = function (this: unknown, renderObject: unknown, useAsync?: boolean): unknown {
    const start = performance.now();
    const result = originalBuild.call(this, renderObject, useAsync);
    const sample = sampleOf(renderObject);
    const thenable = result as { then?: unknown } | null;
    if (thenable !== null && typeof thenable?.then === 'function') {
      return (result as Promise<unknown>).then((v) => {
        sample.sync += performance.now() - start;
        return v;
      });
    }
    sample.sync += performance.now() - start;
    return result;
  };

  pipes.getForRender = function (
    this: unknown,
    renderObject: unknown,
    promises?: Array<Promise<unknown>> | null,
  ): unknown {
    const sample = sampleOf(renderObject);
    const p0 = promises ? promises.length : 0;
    const cache0 = pipes.caches.size;
    const vert0 = pipes.programs.vertex.size;
    const frag0 = pipes.programs.fragment.size;
    const start = performance.now();
    const result = originalPipeline.call(this, renderObject, promises);
    const end = performance.now();
    sample.sync += end - start;
    sample.pipelines += pipes.caches.size - cache0;
    sample.programs += pipes.programs.vertex.size - vert0 + (pipes.programs.fragment.size - frag0);
    sample.wgsl += newKeyBytes(pipes.programs.vertex, vert0) + newKeyBytes(pipes.programs.fragment, frag0);
    // attribute the driver-side wait: replace each promise this call appended
    // with one that timestamps itself. compileAsync awaits the array, so
    // swapping entries in place is enough and changes no behaviour.
    if (promises) {
      for (let i = p0; i < promises.length; i++) {
        promises[i] = promises[i].then((v) => {
          sample.wait = Math.max(sample.wait, performance.now() - end);
          return v;
        });
      }
    }
    return result;
  };

  try {
    await compile();
  } finally {
    nodes.getForRender = originalBuild;
    pipes.getForRender = originalPipeline;
  }

  for (const sample of samples) sample.sync = +sample.sync.toFixed(2);

  const phase: CompilePhase = {
    label,
    wall: +(performance.now() - t0).toFixed(1),
    sync: 0,
    pipelines: 0,
    programs: 0,
    wgsl: 0,
    samples,
  };
  for (const s of samples) {
    phase.sync += s.sync;
    phase.pipelines += s.pipelines;
    phase.programs += s.programs;
    phase.wgsl += s.wgsl;
  }
  phase.sync = +phase.sync.toFixed(1);
  return phase;
}

export interface RankedRow {
  material: string;
  objects: number;
  sync: number;
  /** longest single driver wait in the group, NOT a sum (they overlap) */
  maxWait: number;
  pipelines: number;
  programs: number;
  /** KB of WGSL */
  wgslKb: number;
}

/** collapse samples by material name, heaviest first */
export function rankCompile(phases: CompilePhase[]): RankedRow[] {
  const byMaterial = new Map<string, RankedRow>();
  for (const phase of phases) {
    for (const s of phase.samples) {
      let row = byMaterial.get(s.material);
      if (row === undefined) {
        row = {
          material: s.material,
          objects: 0,
          sync: 0,
          maxWait: 0,
          pipelines: 0,
          programs: 0,
          wgslKb: 0,
        };
        byMaterial.set(s.material, row);
      }
      row.objects++;
      row.sync += s.sync;
      row.maxWait = Math.max(row.maxWait, s.wait);
      row.pipelines += s.pipelines;
      row.programs += s.programs;
      row.wgslKb += s.wgsl / 1024;
    }
  }
  const rows = [...byMaterial.values()];
  for (const r of rows) {
    r.sync = +r.sync.toFixed(1);
    r.maxWait = +r.maxWait.toFixed(1);
    r.wgslKb = +r.wgslKb.toFixed(1);
  }
  // rank by the blocking cost, which is what the splash actually waits on
  rows.sort((a, b) => b.sync - a.sync);
  return rows;
}

/** one-line-per-material console table, ranked. */
export function logCompileProfile(phases: CompilePhase[]): void {
  const rows = rankCompile(phases);
  const total = phases.reduce(
    (acc, p) => {
      acc.wall += p.wall;
      acc.sync += p.sync;
      acc.pipelines += p.pipelines;
      return acc;
    },
    { wall: 0, sync: 0, pipelines: 0 },
  );
  console.info(
    `[compile] ${total.wall.toFixed(0)}ms wall · ${total.sync.toFixed(0)}ms main-thread · ` +
      `${total.pipelines} pipelines · phases: ` +
      phases.map((p) => `${p.label} ${p.wall.toFixed(0)}ms`).join(', '),
  );
  console.table(rows.slice(0, 30));
}
