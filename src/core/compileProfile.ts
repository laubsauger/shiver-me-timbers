/**
 * Shader-compile profiler (§T.40, §V.39).
 *
 * `renderer.compileAsync()` is one opaque await that hid 52s of boot. This
 * splits it per render object so the answer is a RANKED LIST rather than a
 * subsystem hunch — the mast-stave and deck-field bugs were both single terms
 * doing outsized damage, and compile cost has the same failure shape.
 *
 * How: three's `Renderer._createObjectPipeline` is the per-(object, material)
 * entry point compileAsync uses instead of drawing. Wrapping it on the
 * INSTANCE (shadowing the prototype method) gives, per object:
 *
 *  - `sync`  main-thread ms: TSL graph build + WGSL codegen + bindings. This
 *            is the part that blocks; it is invisible in a wall-clock total.
 *  - `wait`  ms from that object's codegen finishing to its
 *            `createRenderPipelineAsync` promise resolving = driver work.
 *            Pipelines are created concurrently, so these OVERLAP and must not
 *            be summed — read the max, and read `sync` as the serial cost.
 *  - `wgsl`  bytes of shader source the object added, the honest proxy for how
 *            much work the driver was handed (and the first place to look for
 *            a pathological shader after a GPU-process death).
 *
 * A cache hit costs ~0 on every counter, which is exactly what makes shared
 * materials visible in the output: two ships with their own material set show
 * up twice, two ships sharing one set show up once.
 *
 * NESTED PASSES (§T.79). `_createObjectPipeline` runs each object's
 * `updateBefore` nodes (Renderer.js:3050), and a `ShadowNode` or reflector
 * answers that with a WHOLE `renderer.render()` of the scene — which, inside
 * `compileAsync`, still routes every object through `_createObjectPipeline`
 * (`_handleObjectFunction` is only reset when compileAsync returns,
 * Renderer.js:959). So the first lit object's sample used to CONTAIN the
 * entire shadow pass and the reflection pass, and summing samples counted
 * that work twice. Every counter is now EXCLUSIVE — the object's own work,
 * children subtracted — and `depth` says which pass a sample came from:
 * 0 is the compile root's own list, 1+ is a pass a node opened under it.
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
interface RendererInternals {
  _createObjectPipeline: (...args: unknown[]) => void;
  _compilationPromises: Array<Promise<unknown>> | null;
  _pipelines: {
    caches: Map<unknown, unknown>;
    programs: { vertex: Map<string, unknown>; fragment: Map<string, unknown> };
  };
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
  const original = internals._createObjectPipeline;
  const samples: CompileSample[] = [];
  const t0 = performance.now();
  /** inclusive totals of the samples opened UNDER each in-flight call */
  const nestedStack: Array<{ sync: number; pipelines: number; programs: number; wgsl: number }> =
    [];

  internals._createObjectPipeline = function (
    this: unknown,
    ...args: unknown[]
  ): void {
    const object = args[0] as { name?: string; type?: string };
    const material = args[1] as { name?: string; type?: string };
    const pipes = internals._pipelines;
    const promises = internals._compilationPromises;
    const p0 = promises === null ? 0 : promises.length;
    const cache0 = pipes.caches.size;
    const vert0 = pipes.programs.vertex.size;
    const frag0 = pipes.programs.fragment.size;

    const nested = { sync: 0, pipelines: 0, programs: 0, wgsl: 0 };
    nestedStack.push(nested);
    const start = performance.now();
    original.apply(this, args);
    const end = performance.now();
    nestedStack.pop();

    // inclusive deltas, then the children's inclusive totals come off
    const inclusive = {
      sync: end - start,
      pipelines: pipes.caches.size - cache0,
      programs: pipes.programs.vertex.size - vert0 + (pipes.programs.fragment.size - frag0),
      wgsl: newKeyBytes(pipes.programs.vertex, vert0) + newKeyBytes(pipes.programs.fragment, frag0),
    };
    const parent = nestedStack[nestedStack.length - 1];
    if (parent !== undefined) {
      parent.sync += inclusive.sync;
      parent.pipelines += inclusive.pipelines;
      parent.programs += inclusive.programs;
      parent.wgsl += inclusive.wgsl;
    }
    const sample: CompileSample = {
      object: object?.name || object?.type || '?',
      material: material?.name || material?.type || '?',
      sync: inclusive.sync - nested.sync,
      wait: 0,
      pipelines: inclusive.pipelines - nested.pipelines,
      programs: inclusive.programs - nested.programs,
      wgsl: inclusive.wgsl - nested.wgsl,
      depth: nestedStack.length,
    };
    samples.push(sample);

    // attribute the driver-side wait: replace each promise this call appended
    // with one that timestamps itself. compileAsync awaits the array, so
    // swapping entries in place is enough and changes no behaviour.
    if (promises !== null) {
      for (let i = p0; i < promises.length; i++) {
        promises[i] = promises[i].then((v) => {
          sample.wait = Math.max(sample.wait, performance.now() - end);
          return v;
        });
      }
    }
  };

  try {
    await compile();
  } finally {
    internals._createObjectPipeline = original;
  }

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
