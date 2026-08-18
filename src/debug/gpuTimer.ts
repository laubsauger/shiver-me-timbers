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
 *  - Never shows a partial ranking. An overflow means an unknown set of passes
 *    was not timed, and a truncated top-8 is plausible, ordered and wrong — so
 *    an overflowed window prints the reason INSTEAD OF the list, and the
 *    frame's total is not recorded at all (see `formatGpuHud`).
 *  - Never averages an unknown number of frames together. `tick()` is the frame
 *    boundary and a batch is exactly one frame; see the block below.
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

/**
 * ONE BATCH IS ONE FRAME, ENFORCED.
 *
 * The pool used to hold a single readback buffer, so only one `mapAsync` could
 * be in flight; every frame that ticked while it was busy kept ALLOCATING into
 * the same query set. Measured on this scene: render 26 pairs/frame (54 peak),
 * compute 85 pairs/frame (143 peak), and a readback latency of ~4 frames — so
 * a "batch" routinely carried 4-6 frames, and under contention 28. At 85
 * pairs/frame a 2047-pair pool exhausts after 24 frames, which is EXACTLY the
 * `ovf 89` capture: the pool did not overflow because a frame was big, it
 * overflowed because the drain could not keep up and the pool has no per-frame
 * boundary.
 *
 * The old code then tried to recover the frame count from the data
 * (`frames = max occurrences of any key`), which is a guess: it needs some pass
 * to run on every frame AND every pass to have a distinct key. Both were false
 * — see `describe()` on unnamed render targets — so every per-frame average was
 * divided by a wrong number.
 *
 * Now: RESULT_SLOTS readbacks may be in flight at once, `tick()` is the frame
 * boundary, and a frame that cannot get a slot is DROPPED (its queries are
 * discarded) rather than merged into the next batch. A batch is therefore one
 * frame by construction, there is no division, and the pool only has to hold a
 * single frame's passes.
 */

/** Readbacks allowed in flight. Measured `mapAsync` latency is ~4 frames. */
const RESULT_SLOTS = 6;
/**
 * Query pairs held per pool. Sized from the measurement above: the worst frame
 * seen was 143 compute pairs, so 1024 pairs is ~7x headroom on a per-frame
 * budget. Overflow now means one FRAME had more passes than this, which is a
 * real anomaly worth shouting about — not a drain that fell behind.
 */
const MAX_PAIRS = 1024;
const MAX_QUERIES = MAX_PAIRS * 2;
/** Last pair is the overflow sink — allocated to, never summed. */
const SCRATCH_BASE = MAX_QUERIES - 2;
/** Frames retained for the min-of-N window (§V.39). */
export const WINDOW = 60;
/**
 * Age past which a reading stops being reported as a number. A min-of-window
 * total is historical by design, but once the last successful read is this old
 * the instrument is not describing the current frame and must not look as
 * though it is.
 */
const STALE_MS = 1000;

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
  /**
   * Frames whose queries were thrown away because every readback slot was
   * still in flight. NOT an error — the instrument is sampling rather than
   * capturing every frame — but a large ratio to `reads` means the window
   * covers fewer frames than it looks like it does.
   */
  misses: number;
  /**
   * Ticks where the pool had nothing allocated, i.e. the pass simply did not
   * run this frame. Explicitly NOT a miss: the old code counted these as
   * failures and produced the notorious `miss 9282` beside 166 reads.
   */
  idle: number;
  /**
   * Passes dropped into the scratch pair because ONE FRAME exceeded the pool.
   * Nonzero means the pass list below is MISSING PASSES and cannot be read as
   * a ranking.
   */
  overflows: number;
  /** batches drained that had overflowed — their totals are never recorded */
  incompleteReads: number;
  /** pass count of the most recent drained frame, per pool */
  passesPerFrame: Record<TimerKind, number>;
  /** pairs the pool can hold in one frame, for sizing arguments */
  capacityPairs: number;
  /**
   * Query pairs that came back with end <= begin, i.e. NEVER WRITTEN. A
   * nonzero, growing count here means the GPU is not honouring
   * `timestampWrites` and NO timestamp number from this machine is usable.
   */
  unwritten: number;
  /** ms since the last successful read; grows without bound if wedged */
  staleMs: number;
  /**
   * Frames covered by the most recent batch. Now 1 BY CONSTRUCTION — `tick()`
   * is the frame boundary and a frame that cannot be drained is discarded, so
   * nothing is ever divided. Kept in the interface as an assertion: anything
   * other than 1 here is a bug in this file, not a property of the scene.
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
  /**
   * A NUMBER OLDER THAN `STALE_MS` IS NOT THIS FRAME'S NUMBER.
   *
   * This is the same fault the module was written to escape: three's pool
   * returns its last successful reading on every failure path, and a constant
   * reads as a perfectly steady frame. Printing a min-of-window total while the
   * last successful read was eight seconds ago reproduces that exactly — the
   * value is real, it is simply not about now. `--` is the honest render.
   */
  const stale = h.staleMs > STALE_MS;
  const ms = (v: number): string => (!stale && Number.isFinite(v) ? v.toFixed(2) : '--');
  const lines = [
    `render ${ms(timer.total('render'))} ms /${h.passesPerFrame.render} p` +
      `   compute ${ms(timer.total('compute'))} ms /${h.passesPerFrame.compute} p`,
  ];
  if (h.reads === 0 || h.unwritten > 0 || h.overflows > 0 || stale) {
    const age = Number.isFinite(h.staleMs) ? `${(h.staleMs / 1000).toFixed(1)}s` : 'never';
    lines.push(
      `!! reads ${h.reads} drop ${h.misses} unwritten ${h.unwritten} ` +
        `ovf ${h.overflows} last ${age} ago`,
    );
  }
  /**
   * OVERFLOW MUST BREAK THE LIST, NOT DECORATE IT.
   *
   * A truncated top-8 is the single most dangerous thing this module can print:
   * it is plausible, it is ordered, and nothing about it says that the pass
   * which actually dominated the frame was never timed. The module's own rule
   * is that a missing number must LOOK missing (§Rule 8), so a window that
   * overflowed prints the reason where the ranking would have been and prints
   * no ranking at all.
   */
  if (h.overflows > 0) {
    lines.push(
      `!! PASS LIST SUPPRESSED — ${h.overflows} passes were never timed`,
      `!! one frame exceeded ${h.capacityPairs} pairs; ${h.incompleteReads} batches incomplete`,
      '!! any ranking would be missing rows — __perf.reset() after fixing',
    );
    return lines;
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
  if (h.overflows > 0) {
    console.warn(
      `[gpuTimer] ${h.overflows} passes overflowed the pool — the per-pass table would be ` +
        `MISSING ROWS and the totals are understated. Refusing to print a ranking (§Rule 8).`,
      h,
    );
    return;
  }
  if (h.staleMs > STALE_MS) {
    console.warn(
      `[gpuTimer] the last successful read was ${(h.staleMs / 1000).toFixed(1)} s ago ` +
        `(${h.reads} reads, ${h.misses} frames discarded). The table below is history, ` +
        'not the current frame — do not quote it as one (§Rule 8).',
    );
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
  idle: number;
  overflows: number;
  incompleteReads: number;
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
  /**
   * One readback buffer was the whole bug. With a single buffer only one
   * `mapAsync` can be outstanding, and the pool kept allocating for every frame
   * that ticked while it was busy — so the "batch" grew until it overflowed.
   * A ring of slots lets a drain start every frame; the query set itself is
   * safely reused because the resolve+copy for frame k is submitted before
   * frame k+1's passes and WebGPU executes command buffers in submission order.
   */
  private readonly slots: Array<{ buf: GPUBuffer; inFlight: boolean }> = [];
  private slotCursor = 0;
  private next = 0;
  /** insertion-ordered: uid -> base query index, for THIS frame only */
  private offsets: Array<[string, number]> = [];
  private seq = 0;
  private disposed = false;
  /** did any allocation this frame land in the scratch pair? */
  private overflowedThisFrame = false;
  /** pass count of the most recent drained frame */
  lastPasses = 0;
  /** smallest nonzero duration ever seen = the browser's timestamp quantum */
  quantum = 0;

  constructor(
    private readonly device: GPUDevice,
    kind: TimerKind,
    private readonly counters: Counters,
    private readonly onFrame: (
      rows: Array<[string, number]>,
      total: number,
      incomplete: boolean,
    ) => void,
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
    for (let i = 0; i < RESULT_SLOTS; i++) {
      this.slots.push({
        buf: device.createBuffer({
          label: `gpuTimer_result_${kind}_${i}`,
          size: MAX_QUERIES * 8,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        }),
        inFlight: false,
      });
    }
  }

  /**
   * `mapState` is a live getter, but TS narrows the property access from an
   * earlier `!== 'unmapped'` comparison and then calls every later one dead.
   * Reading it through a function breaks that narrowing without a cast.
   */
  private static mapState(buf: GPUBuffer): GPUBufferMapState {
    return buf.mapState;
  }

  /**
   * Always returns a valid, in-range base index — never `null`. three writes
   * whatever comes back into the pass descriptor without checking.
   */
  allocateQueriesForContext(uid: string): number {
    if (this.disposed) return SCRATCH_BASE;
    if (this.next + 2 > SCRATCH_BASE) {
      this.counters.overflows++;
      this.overflowedThisFrame = true;
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

  private freeSlot(): { buf: GPUBuffer; inFlight: boolean } | null {
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[(this.slotCursor + i) % this.slots.length];
      if (!s.inFlight && PerPassPool.mapState(s.buf) === 'unmapped') {
        this.slotCursor = (this.slotCursor + i + 1) % this.slots.length;
        return s;
      }
    }
    return null;
  }

  /**
   * Called once per frame from `tick()`, AFTER the frame's last pass. This is
   * the frame boundary — the thing the old implementation did not have.
   */
  async resolveQueriesAsync(): Promise<number> {
    if (this.disposed) return NaN;

    // Nothing allocated: the passes simply did not run this frame. That is NOT
    // an instrument failure and must not be counted as one — counting it was
    // what produced `miss 9282` next to 166 reads and made the health line
    // unreadable.
    if (this.next === 0) {
      this.counters.idle++;
      return NaN;
    }

    const slot = this.freeSlot();
    if (slot === null) {
      // Every readback is still in flight. DISCARD this frame's queries rather
      // than letting them pile onto the next batch: an unbounded pool is what
      // overflowed, and a batch spanning several frames is what forced the
      // per-frame division that was never trustworthy. Sampling fewer frames is
      // honest; averaging an unknown number of them is not.
      this.counters.misses++;
      this.offsets = [];
      this.next = 0;
      this.seq = 0;
      this.overflowedThisFrame = false;
      return NaN;
    }

    const rows = this.offsets;
    const count = this.next;
    const incomplete = this.overflowedThisFrame;
    this.offsets = [];
    this.next = 0;
    this.seq = 0;
    this.overflowedThisFrame = false;
    slot.inFlight = true;

    try {
      const bytes = count * 8;
      const enc = this.device.createCommandEncoder({ label: 'gpuTimer_resolve' });
      enc.resolveQuerySet(this.querySet, 0, count, this.resolveBuffer, 0);
      enc.copyBufferToBuffer(this.resolveBuffer, 0, slot.buf, 0, bytes);
      this.device.queue.submit([enc.finish()]);

      await slot.buf.mapAsync(GPUMapMode.READ, 0, bytes);
      if (this.disposed) {
        if (PerPassPool.mapState(slot.buf) === 'mapped') slot.buf.unmap();
        return NaN;
      }

      const times = new BigUint64Array(slot.buf.getMappedRange(0, bytes));
      const out: Array<[string, number]> = [];
      let total = 0;
      let unwritten = 0;
      let written = 0;
      for (const [uid, base] of rows) {
        const t0 = times[base];
        const t1 = times[base + 1];
        // 0/0 is a pair the GPU never wrote — WebGPU zero-inits, and an
        // unavailable query resolves to zero. That is instrument failure.
        //
        // KNOWN GAP, unchanged from the original and not fixed here: the query
        // SET is reused from index 0 every frame and WebGPU offers no way to
        // clear it, so this only catches a pair that has never been written at
        // that index. A pair that was written on an earlier frame and skipped on
        // this one reads as the EARLIER frame's timestamps, i.e. as a plausible
        // duration rather than as a detected failure. `unwritten` therefore
        // proves a dead instrument when it is nonzero but does not prove a live
        // one when it is zero.
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
      slot.buf.unmap();

      this.counters.unwritten += unwritten;
      if (written === 0) {
        // Every pair unwritten: the queries exist, the passes ran, and nothing
        // was recorded. That is a dead instrument, not a free frame.
        this.counters.misses++;
        return NaN;
      }
      this.counters.reads++;
      this.counters.lastReadAt = performance.now();
      this.lastPasses = rows.length;
      if (incomplete) this.counters.incompleteReads++;
      this.onFrame(out, total, incomplete);
      return total;
    } catch (err) {
      this.counters.lastError = err instanceof Error ? err.message : String(err);
      if (PerPassPool.mapState(slot.buf) === 'mapped') slot.buf.unmap();
      return NaN;
    } finally {
      slot.inFlight = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const s of this.slots) {
      try {
        if (PerPassPool.mapState(s.buf) === 'mapped') s.buf.unmap();
      } catch {
        /* already unmapped */
      }
      s.buf.destroy();
    }
    this.querySet.destroy();
    this.resolveBuffer.destroy();
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

/**
 * Stable synthetic ids for render targets that carry no name.
 *
 * `RenderTarget` has no `.id` in three r180 (checked: `core/RenderTarget.js`
 * assigns none), so the old fallback chain
 * `rt.texture?.name || rt.name || \`rt${rt.id ?? ''}\` || 'rt'` produced
 * `` `rt${''}` `` = the bare string `rt` for EVERY unnamed target. Two unnamed
 * targets of the same size sharing a RenderContext therefore became ONE row —
 * their times summed, and the old `frames = max hit count` heuristic read the
 * doubled hit count as an extra frame, which is the suspected mechanism behind
 * `batchFrames` reading 2 on a frame that was fully drained.
 *
 * NOT VERIFIED that this was the specific collision behind a wrong
 * `batchFrames`: the captures that exercised it had four unnamed targets whose
 * RenderContext ids already differed, so `keyOf()` kept them apart anyway.
 * Key collisions ARE real and measured (27 render passes onto 23 keys) — this
 * is one contributor to them, not proven to be the one that bit. Fixed here
 * because a row labelled `rt` names nothing; moot for the frame count, since
 * nothing derives one from hit counts any more.
 */
const rtIds = new WeakMap<object, number>();
let nextRtId = 0;
function rtId(rt: object): number {
  let id = rtIds.get(rt);
  if (id === undefined) {
    id = nextRtId++;
    rtIds.set(rt, id);
  }
  return id;
}

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
      : rt.texture?.name || rt.name || `rt#${rtId(rt)}`;
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
    idle: 0,
    overflows: 0,
    incompleteReads: 0,
    unwritten: 0,
    lastReadAt: 0,
    lastError: null,
  };
  const rings: Record<TimerKind, Map<string, Ring>> = { render: new Map(), compute: new Map() };
  const totals: Record<TimerKind, Ring> = { render: new Ring(), compute: new Ring() };
  let batchFrames = 1;

  const makeSink =
    (kind: TimerKind) =>
    (rows: Array<[string, number]>, total: number, incomplete: boolean): void => {
      const map = rings[kind];
      /**
       * ONE BATCH IS ONE FRAME — see the header. There is no division here any
       * more, and that is the point.
       *
       * What used to be here: `frames = max occurrences of any key`, then
       * divide everything by it. That heuristic needs two things that were both
       * untrue — that some pass runs on EVERY frame of the batch (fails when
       * every pass is conditional, and then it OVER-states every row), and that
       * no two distinct passes share a key within one frame (and then it
       * OVER-counts frames, so it UNDER-states every row).
       *
       * The second is not an edge case, it is the normal state of this scene.
       * MEASURED LIVE: 27 render passes collapse onto 23 keys, and 141 compute
       * passes onto 89. Some key is therefore hit two or more times in a single
       * frame, and the heuristic reads that as two or more frames — which is
       * exactly `batchFrames` reporting 2 on frames that were all drained, and
       * 9-10 against a reads/misses ratio implying 3.8.
       *
       * A pass that runs on some frames and not others now reads as its REAL
       * cost on the frames it runs, and is simply absent from the rest, which
       * min-of-window handles correctly without anyone amortising anything.
       */
      const sums = new Map<string, number>();
      for (const [uid, ms] of rows) {
        const k = keyOf(uid);
        sums.set(k, (sums.get(k) ?? 0) + ms);
      }
      batchFrames = 1;
      for (const [k, ms] of sums) {
        let ring = map.get(k);
        if (ring === undefined) {
          ring = new Ring();
          map.set(k, ring);
        }
        ring.push(ms);
      }
      // An overflowed frame is missing an unknown number of passes, so its sum
      // is an UNDER-count of the frame. The individual passes that were timed
      // are still real measurements and are kept; the total is not recorded at
      // all, so `total()` stays the min over frames that were complete — or NaN
      // if none were (§Rule 8).
      if (!incomplete) totals[kind].push(total);
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
      // `idle` counts too: 240 ticks with nothing ever allocated means three
      // never asked for a query pair, which is the instrument being dead in a
      // different way from a readback that never lands.
      if (!warnedStuck && counters.misses + counters.idle > 240 && counters.reads === 0) {
        warnedStuck = true;
        console.warn(
          `[gpuTimer] ${counters.misses} frames discarded, ${counters.idle} idle ticks, ` +
            `0 successful reads (unwritten pairs: ${counters.unwritten}, last error: ` +
            `${counters.lastError}). GPU timestamps are NOT working on this machine — ` +
            'do not quote a timing (§Rule 8).',
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
        idle: counters.idle,
        overflows: counters.overflows,
        incompleteReads: counters.incompleteReads,
        passesPerFrame: {
          render: pools.render.lastPasses,
          compute: pools.compute.lastPasses,
        },
        capacityPairs: SCRATCH_BASE / 2,
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
      counters.idle = 0;
      counters.overflows = 0;
      counters.incompleteReads = 0;
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
