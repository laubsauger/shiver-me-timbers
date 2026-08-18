/**
 * GPU TIMING INSTRUMENT — per-pass, honest about its own failures (§V.39,
 * §V.63, §B.25).
 *
 * WHY THIS EXISTS INSTEAD OF `renderer.info.render.timestamp`.
 *
 * three's own `WebGPUTimestampQueryPool` has five early-exit paths
 * (`trackTimestamp` off, `currentQueryIndex === 0`, disposed, result buffer
 * not `unmapped`, and the catch-all `catch`) and EVERY ONE of them returns
 * `this.lastValue` — the previous successful reading. `Backend
 * .resolveTimestampsAsync` then writes that straight to
 * `renderer.info[type].timestamp` as though it were this frame's number.
 * `Info.reset()` does NOT clear `timestamp` (only `dispose()` does), so the
 * stale value also survives the next frame. A DEAD INSTRUMENT IS THEREFORE
 * INDISTINGUISHABLE FROM A PERFECTLY STEADY FRAME: it reads as a plausible
 * constant, with no warning, which is exactly the 29.688 ms × 90 frames of
 * §V.63.
 *
 * Two further faults in the same file:
 *  - `allocateQueriesForContext()` returns `null` when the pool is full, and
 *    `WebGPUBackend.initTimestampQuery()` writes it into
 *    `beginningOfPassWriteIndex` unchecked. WebIDL coerces `null` to 0, so an
 *    exhausted pool silently ALIASES every subsequent pass onto query pair 0
 *    rather than erroring.
 *  - the whole frame is collapsed into one scalar, so "which pass" is
 *    unanswerable — which is the only question worth asking.
 *
 * WHAT THIS DOES DIFFERENTLY.
 *  - Never latches. A frame that could not be read reports NaN and increments
 *    a miss counter. `NaN` on the HUD is the point: it cannot be mistaken for
 *    a measurement (§Rule 8).
 *  - Never aliases. Overflow goes to a dedicated scratch pair that is excluded
 *    from every sum, and is counted.
 *  - Keeps the per-pass split, keyed by render-context id (stable across
 *    frames — `RenderContexts` chain-maps them by scene/camera/attachment) and
 *    labelled with the render target's name and size.
 *  - Distinguishes "pass ran and took 0" from "query pair was allocated but
 *    never written", which is what a driver that ignores `timestampWrites`
 *    looks like. The second is a broken instrument; the first is a fast pass.
 *  - Reports min-of-window per pass (§V.39), not mean: the minimum is the one
 *    statistic a contended machine cannot inflate.
 *
 * COMPUTE IS RESOLVED TOO. three allocates a query pair per compute pass into
 * a SEPARATE `compute` pool. Nothing in this project ever resolved it, so it
 * filled to 2048 and then hit the null-aliasing path above forever. Compute is
 * also where the ocean FFT lives, i.e. the number most worth having.
 */

/** Query pairs held per pool. 2048 pairs is ~1024 passes/frame of headroom. */
const MAX_QUERIES = 4096;
/** Last pair is the overflow sink — allocated to, never summed. */
const SCRATCH_BASE = MAX_QUERIES - 2;
/** Frames retained for the min-of-N window (§V.39). */
export const WINDOW = 60;

export type TimerKind = 'render' | 'compute';

export interface GpuPassSample {
  /** stable label: render-target name + size, or compute node name */
  label: string;
  /** minimum over the retained window, ms — the defensible number */
  min: number;
  /** most recent reading, ms */
  last: number;
  /** frames in the window that carried this pass */
  n: number;
}

export interface GpuTimerHealth {
  /** frames read back successfully */
  reads: number;
  /** resolve calls that returned nothing (busy buffer, nothing allocated) */
  misses: number;
  /** passes dropped into the scratch pair because the set was full */
  overflows: number;
  /**
   * Query pairs that came back with end <= begin, i.e. NEVER WRITTEN. A
   * nonzero, growing count here means the GPU is not honouring
   * `timestampWrites` and NO timestamp number from this machine is usable.
   */
  unwritten: number;
  /** ms since the last successful read; grows without bound if wedged */
  staleMs: number;
  /**
   * Frames covered by the most recent batch. >1 means the readback outran the
   * frame; per-pass numbers are divided by this, so a large or jittery value
   * widens the error bar on every reading.
   */
  batchFrames: number;
  /**
   * Smallest nonzero duration the browser has ever returned, i.e. its
   * timestamp QUANTUM. Chrome quantises timestamp queries; anything faster
   * than one quantum reads as 0 and cannot be resolved individually.
   */
  quantumMs: number;
  lastError: string | null;
}

export interface GpuTimer {
  /**
   * Drain both pools. Call once per frame AFTER the last render/compute.
   * Deliberately unawaited: this reads back the queries submitted moments ago,
   * so awaiting it would stall the render thread on the GPU in order to
   * measure the GPU.
   */
  tick(): void;
  /** per-pass minima over the window, descending by min */
  passes(kind: TimerKind): GpuPassSample[];
  /** min-of-window frame total for a pool, ms; NaN until a read succeeds */
  total(kind: TimerKind): number;
  health(): GpuTimerHealth;
  /** drop the window and the counters — call at the start of an A/B leg */
  reset(): void;
  dispose(): void;
}

/**
 * HUD block: the two pool totals, the health line, and the heaviest passes.
 *
 * `--` rather than `0.00` for an unread pool, and the health line is NOT
 * optional: an instrument that is failing must say so on the same screen as
 * the numbers it is failing to produce (§Rule 8).
 */
export function formatGpuHud(timer: GpuTimer, topN = 8): string[] {
  const h = timer.health();
  const ms = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : '--');
  const lines = [
    `render ${ms(timer.total('render'))} ms   compute ${ms(timer.total('compute'))} ms`,
  ];
  if (h.reads === 0 || h.unwritten > 0 || h.overflows > 0 || h.staleMs > 1000) {
    lines.push(
      `!! reads ${h.reads} miss ${h.misses} unwritten ${h.unwritten} ovf ${h.overflows}`,
    );
  }
  for (const kind of ['render', 'compute'] as const) {
    for (const p of timer.passes(kind).slice(0, topN)) {
      lines.push(`${p.label.slice(0, 26).padEnd(26)} ${p.min.toFixed(2)}`);
    }
  }
  return lines;
}

/** Console table for a measurement session: `__perf.report()`. */
export function reportGpu(timer: GpuTimer): void {
  const h = timer.health();
  if (h.reads === 0) {
    console.warn(
      '[gpuTimer] no successful reads — there is NO number to report (§Rule 8).',
      h,
    );
    return;
  }
  for (const kind of ['render', 'compute'] as const) {
    const rows = timer.passes(kind);
    if (rows.length === 0) continue;
    console.log(
      `[gpuTimer] ${kind}: min-of-${WINDOW} total ${timer.total(kind).toFixed(3)} ms ` +
        `over ${h.reads} reads`,
    );
    console.table(
      rows.map((p) => ({ pass: p.label, minMs: +p.min.toFixed(3), lastMs: +p.last.toFixed(3), n: p.n })),
    );
  }
  console.log('[gpuTimer] health', h);
}

/** Ring of the last WINDOW readings for one label. */
class Ring {
  private readonly v = new Float64Array(WINDOW);
  private cursor = 0;
  n = 0;
  last = NaN;
  push(ms: number): void {
    this.v[this.cursor] = ms;
    this.cursor = (this.cursor + 1) % WINDOW;
    if (this.n < WINDOW) this.n++;
    this.last = ms;
  }
  min(): number {
    if (this.n === 0) return NaN;
    let m = Infinity;
    for (let i = 0; i < this.n; i++) if (this.v[i] < m) m = this.v[i];
    return m;
  }
}

interface Counters {
  reads: number;
  misses: number;
  overflows: number;
  unwritten: number;
  lastReadAt: number;
  lastError: string | null;
}

/**
 * Duck-typed stand-in for three's `WebGPUTimestampQueryPool`. The backend only
 * ever touches `.querySet`, `.allocateQueriesForContext()`,
 * `.resolveQueriesAsync()` and `.dispose()`, so the rest of three's internal
 * surface is deliberately absent — if a future three reaches for a field that
 * is not here it should throw, not silently half-work.
 */
class PerPassPool {
  readonly querySet: GPUQuerySet;
  private readonly resolveBuffer: GPUBuffer;
  private readonly resultBuffer: GPUBuffer;
  private next = 0;
  /** insertion-ordered: uid -> base query index, for THIS frame only */
  private offsets: Array<[string, number]> = [];
  private seq = 0;
  private busy = false;
  private disposed = false;
  /** smallest nonzero duration ever seen = the browser's timestamp quantum */
  quantum = 0;

  constructor(
    private readonly device: GPUDevice,
    kind: TimerKind,
    private readonly counters: Counters,
    private readonly onFrame: (rows: Array<[string, number]>, total: number) => void,
  ) {
    this.querySet = device.createQuerySet({
      type: 'timestamp',
      count: MAX_QUERIES,
      label: `gpuTimer_${kind}`,
    });
    this.resolveBuffer = device.createBuffer({
      label: `gpuTimer_resolve_${kind}`,
      size: MAX_QUERIES * 8,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    this.resultBuffer = device.createBuffer({
      label: `gpuTimer_result_${kind}`,
      size: MAX_QUERIES * 8,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  /**
   * `mapState` is a live getter, but TS narrows the property access from the
   * earlier `!== 'unmapped'` guard and then calls every later comparison dead.
   * Reading it through a method breaks that narrowing without a cast.
   */
  private mapState(): GPUBufferMapState {
    return this.resultBuffer.mapState;
  }

  /**
   * Always returns a valid, in-range base index — never `null`. three writes
   * whatever comes back into the pass descriptor without checking.
   */
  allocateQueriesForContext(uid: string): number {
    if (this.disposed) return SCRATCH_BASE;
    if (this.next + 2 > SCRATCH_BASE) {
      this.counters.overflows++;
      return SCRATCH_BASE;
    }
    const base = this.next;
    this.next += 2;
    // uid is `r:<frameCalls>:<ctxId>|<label>` and frameCalls repeats once
    // info.reset() runs per frame, so the raw uid is NOT unique. A Map keyed on
    // it drops the earlier pass silently (three's bug). Sequence it instead.
    this.offsets.push([`${uid}#${this.seq++}`, base]);
    return base;
  }

  async resolveQueriesAsync(): Promise<number> {
    if (this.disposed) return NaN;
    // A readback still in flight, nothing allocated since the last drain, or a
    // buffer mid-map: all three are "no reading this frame", NOT "same as last
    // frame". Do not reset `next` — the queries stay allocated and are read on
    // the next successful drain.
    if (this.busy || this.next === 0 || this.resultBuffer.mapState !== 'unmapped') {
      this.counters.misses++;
      return NaN;
    }

    const rows = this.offsets;
    const count = this.next;
    this.offsets = [];
    this.next = 0;
    this.seq = 0;
    this.busy = true;

    try {
      const bytes = count * 8;
      const enc = this.device.createCommandEncoder({ label: 'gpuTimer_resolve' });
      enc.resolveQuerySet(this.querySet, 0, count, this.resolveBuffer, 0);
      enc.copyBufferToBuffer(this.resolveBuffer, 0, this.resultBuffer, 0, bytes);
      this.device.queue.submit([enc.finish()]);

      await this.resultBuffer.mapAsync(GPUMapMode.READ, 0, bytes);
      if (this.disposed) {
        if (this.mapState() === 'mapped') this.resultBuffer.unmap();
        return NaN;
      }

      const times = new BigUint64Array(this.resultBuffer.getMappedRange(0, bytes));
      const out: Array<[string, number]> = [];
      let total = 0;
      let unwritten = 0;
      let written = 0;
      for (const [uid, base] of rows) {
        const t0 = times[base];
        const t1 = times[base + 1];
        // 0/0 is a pair the GPU never wrote — WebGPU zero-inits, and an
        // unavailable query resolves to zero. That is instrument failure.
        if (t0 === 0n && t1 === 0n) {
          unwritten++;
          continue;
        }
        written++;
        // Equal-but-nonzero is NOT failure: the browser QUANTISES timestamps
        // (measured 65 536 ns on this machine — every reading is a multiple of
        // 0.0655 ms), so any pass shorter than one quantum has begin === end.
        // Recording it as 0 is honest; dropping it would hide the pass, and
        // calling it broken would cry wolf on every cheap pass.
        const ms = t1 > t0 ? Number(t1 - t0) / 1e6 : 0;
        if (ms > 0 && (ms < this.quantum || this.quantum === 0)) this.quantum = ms;
        out.push([uid, ms]);
        total += ms;
      }
      this.resultBuffer.unmap();

      this.counters.unwritten += unwritten;
      if (written === 0) {
        // Every pair unwritten: the queries exist, the passes ran, and nothing
        // was recorded. That is a dead instrument, not a free frame.
        this.counters.misses++;
        return NaN;
      }
      this.counters.reads++;
      this.counters.lastReadAt = performance.now();
      this.onFrame(out, total);
      return total;
    } catch (err) {
      this.counters.lastError = err instanceof Error ? err.message : String(err);
      if (this.mapState() === 'mapped') this.resultBuffer.unmap();
      return NaN;
    } finally {
      this.busy = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      if (this.mapState() === 'mapped') this.resultBuffer.unmap();
    } catch {
      /* already unmapped */
    }
    this.querySet.destroy();
    this.resolveBuffer.destroy();
    this.resultBuffer.destroy();
  }
}

/** `r:12:47|scene 2560x1440#3` -> `scene 2560x1440 (#47)` */
function keyOf(uid: string): string {
  const bar = uid.indexOf('|');
  const hash = uid.lastIndexOf('#');
  const head = bar < 0 ? uid : uid.slice(0, bar);
  const label = bar < 0 ? uid : uid.slice(bar + 1, hash < 0 ? undefined : hash);
  const id = head.split(':')[2] ?? '?';
  return `${label} (#${id})`;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Human label for a render context or a compute node/group. */
function describe(ctx: any): string {
  if (Array.isArray(ctx)) {
    const names = ctx.map((n) => n?.name || `node${n?.id ?? '?'}`);
    return `compute[${names.join('+')}]`;
  }
  if (ctx?.isComputeNode === true) return `compute:${ctx.name || `node${ctx.id}`}`;
  const rt = ctx?.renderTarget;
  const name: string =
    rt === null || rt === undefined
      ? 'canvas'
      : rt.texture?.name || rt.name || `rt${rt.id ?? ''}` || 'rt';
  const w = ctx?.width ?? 0;
  const h = ctx?.height ?? 0;
  const ms = rt?.samples ? `x${rt.samples}` : '';
  return `${name} ${w}x${h}${ms}`;
}

/**
 * Install the instrument on an ALREADY-INITIALISED renderer, BEFORE the first
 * frame. `WebGPUBackend.initTimestampQuery()` lazily creates its own pool on
 * first use and never replaces it, so this must land first; installing later
 * leaves three's latching pool in place for whichever pools already exist.
 *
 * Returns `null` — loudly — when the backend cannot support it. A null return
 * means "no GPU timing on this machine", which callers must surface rather
 * than fall back to wall clock (§B.25).
 */
export function installGpuTimer(renderer: any): GpuTimer | null {
  const backend = renderer?.backend;
  const device: GPUDevice | undefined = backend?.device;
  if (backend === undefined || device === undefined) {
    console.warn('[gpuTimer] no WebGPU backend/device — GPU timing unavailable (§V.39).');
    return null;
  }
  if (backend.trackTimestamp !== true) {
    // `trackTimestamp` is a CONSTRUCTOR parameter; the Backend copies it once
    // and never re-reads it. Assigning it here would be a silent no-op, so say
    // so instead of pretending.
    console.warn(
      '[gpuTimer] backend.trackTimestamp is false — pass `trackTimestamp: true` to the ' +
        'WebGPURenderer CONSTRUCTOR (assigning it later does nothing), and check the ' +
        'adapter reports the `timestamp-query` feature. GPU timing unavailable (§V.39).',
    );
    return null;
  }
  if (backend.timestampQueryPool?.render != null || backend.timestampQueryPool?.compute != null) {
    console.warn(
      '[gpuTimer] three already built its own timestamp pool — installGpuTimer() ran too ' +
        'late (it must precede the first render). Timings would latch (§V.63); refusing.',
    );
    return null;
  }

  const counters: Counters = {
    reads: 0,
    misses: 0,
    overflows: 0,
    unwritten: 0,
    lastReadAt: 0,
    lastError: null,
  };
  const rings: Record<TimerKind, Map<string, Ring>> = { render: new Map(), compute: new Map() };
  const totals: Record<TimerKind, Ring> = { render: new Ring(), compute: new Ring() };
  let batchFrames = 1;

  const makeSink =
    (kind: TimerKind) =>
    (rows: Array<[string, number]>, total: number): void => {
      const map = rings[kind];
      /**
       * A BATCH IS NOT A FRAME. `mapAsync` routinely takes longer than one
       * frame (measured: ~2 misses per successful read), and the pool keeps
       * allocating while a readback is in flight, so one batch carries every
       * pass from every frame since the last read. Summing it and calling the
       * result "the frame" is how you get an 84 ms frame on a 68 fps app.
       *
       * The batch's frame count is recoverable from the data itself: a pass
       * that runs once per frame appears once per frame, so the MAXIMUM
       * occurrence count across keys IS the number of frames spanned. Dividing
       * by it gives per-frame AMORTISED cost, which is the right number for a
       * budget — a pass that runs on half the frames should read as half.
       */
      const sums = new Map<string, number>();
      const hits = new Map<string, number>();
      for (const [uid, ms] of rows) {
        const k = keyOf(uid);
        sums.set(k, (sums.get(k) ?? 0) + ms);
        hits.set(k, (hits.get(k) ?? 0) + 1);
      }
      let frames = 1;
      for (const c of hits.values()) if (c > frames) frames = c;
      batchFrames = frames;
      for (const [k, ms] of sums) {
        let ring = map.get(k);
        if (ring === undefined) {
          ring = new Ring();
          map.set(k, ring);
        }
        ring.push(ms / frames);
      }
      totals[kind].push(total / frames);
    };

  const pools: Record<TimerKind, PerPassPool> = {
    render: new PerPassPool(device, 'render', counters, makeSink('render')),
    compute: new PerPassPool(device, 'compute', counters, makeSink('compute')),
  };
  backend.timestampQueryPool.render = pools.render;
  backend.timestampQueryPool.compute = pools.compute;

  // Append a human label to three's uid. The uid is used only as a map key, so
  // widening it is safe, and it is the single point where both the render
  // context and the compute group are in hand.
  const originalUID = backend.getTimestampUID.bind(backend);
  backend.getTimestampUID = (ctx: unknown): string => {
    let label: string;
    try {
      label = describe(ctx);
    } catch {
      label = 'unknown';
    }
    return `${originalUID(ctx)}|${label}`;
  };

  let warnedStuck = false;

  return {
    tick(): void {
      // Both pools, both unawaited, errors swallowed: a diagnostic must never
      // be able to take the frame down.
      void pools.render.resolveQueriesAsync().catch(() => NaN);
      void pools.compute.resolveQueriesAsync().catch(() => NaN);
      if (!warnedStuck && counters.misses > 240 && counters.reads === 0) {
        warnedStuck = true;
        console.warn(
          `[gpuTimer] ${counters.misses} resolve attempts, 0 successful reads ` +
            `(unwritten pairs: ${counters.unwritten}, last error: ${counters.lastError}). ` +
            'GPU timestamps are NOT working on this machine — do not quote a timing (§Rule 8).',
        );
      }
    },
    passes(kind: TimerKind): GpuPassSample[] {
      const out: GpuPassSample[] = [];
      for (const [label, ring] of rings[kind]) {
        out.push({ label, min: ring.min(), last: ring.last, n: ring.n });
      }
      out.sort((a, b) => b.min - a.min);
      return out;
    },
    total(kind: TimerKind): number {
      return totals[kind].min();
    },
    health(): GpuTimerHealth {
      return {
        reads: counters.reads,
        misses: counters.misses,
        overflows: counters.overflows,
        unwritten: counters.unwritten,
        staleMs: counters.lastReadAt === 0 ? Infinity : performance.now() - counters.lastReadAt,
        batchFrames,
        quantumMs: Math.min(
          pools.render.quantum || Infinity,
          pools.compute.quantum || Infinity,
        ),
        lastError: counters.lastError,
      };
    },
    reset(): void {
      rings.render.clear();
      rings.compute.clear();
      totals.render = new Ring();
      totals.compute = new Ring();
      counters.reads = 0;
      counters.misses = 0;
      counters.overflows = 0;
      counters.unwritten = 0;
      counters.lastError = null;
    },
    dispose(): void {
      backend.getTimestampUID = originalUID;
      pools.render.dispose();
      pools.compute.dispose();
      backend.timestampQueryPool.render = null;
      backend.timestampQueryPool.compute = null;
    },
  };
}
