/**
 * The pool's contract, driven through the REAL `installGpuTimer` against a fake
 * WebGPU device.
 *
 * These are not formatting tests. Each one pins a property that, when it broke,
 * produced a plausible wrong number that nobody could see was wrong:
 *
 *  - a "batch" silently spanning several frames, then divided by a GUESSED
 *    frame count (the `ovf 89` / `miss 9282` capture);
 *  - an overflowed frame still contributing a total, so the frame read cheaper
 *    than it was;
 *  - "the pool had nothing to do this frame" counted as an instrument failure.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { installGpuTimer, formatGpuHud, type GpuTimer } from '../src/debug/gpuTimer';

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.GPUBufferUsage = { QUERY_RESOLVE: 1, COPY_SRC: 2, COPY_DST: 4, MAP_READ: 8 };
  g.GPUMapMode = { READ: 1 };
});

/** ns per ms, as the GPU reports timestamps */
const NS = 1_000_000n;

interface FakeBuffer {
  size: number;
  mapState: 'unmapped' | 'pending' | 'mapped';
  bytes: BigUint64Array;
  pending: Array<() => void>;
  mapAsync(mode: number, offset: number, size: number): Promise<void>;
  getMappedRange(offset: number, size: number): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}

/**
 * Fake device. `flush()` is the lever the tests need: it settles every
 * outstanding `mapAsync`, which is what "the readback landed" means. Leaving
 * them outstanding is what "the readback is still in flight" means, and that is
 * the state the old pool grew unboundedly in.
 */
function fakeDevice(): {
  device: unknown;
  buffers: FakeBuffer[];
  /** ns written into each query index by the "GPU" */
  queries: BigUint64Array;
  flush(): Promise<void>;
} {
  const buffers: FakeBuffer[] = [];
  const queries = new BigUint64Array(8192);
  let inFlight: Array<() => void> = [];

  const makeBuffer = (size: number): FakeBuffer => {
    const buf: FakeBuffer = {
      size,
      mapState: 'unmapped',
      bytes: new BigUint64Array(size / 8),
      pending: [],
      mapAsync(_mode, _offset, _size) {
        buf.mapState = 'pending';
        return new Promise<void>((resolve) => {
          inFlight.push(() => {
            buf.mapState = 'mapped';
            resolve();
          });
        });
      },
      getMappedRange(offset, sz) {
        return (buf.bytes.buffer as ArrayBuffer).slice(offset, offset + sz);
      },
      unmap() {
        buf.mapState = 'unmapped';
      },
      destroy() {
        /* no-op */
      },
    };
    buffers.push(buf);
    return buf;
  };

  const device = {
    createQuerySet: () => ({ destroy: () => undefined }),
    createBuffer: ({ size }: { size: number }) => makeBuffer(size),
    createCommandEncoder: () => {
      let resolved: { count: number } | null = null;
      return {
        resolveQuerySet: (_qs: unknown, _first: number, count: number) => {
          resolved = { count };
        },
        copyBufferToBuffer: (_src: unknown, _so: number, dst: FakeBuffer) => {
          // the resolve copies the live query values into the readback buffer
          for (let i = 0; i < (resolved?.count ?? 0); i++) dst.bytes[i] = queries[i];
        },
        finish: () => ({}),
      };
    },
    queue: { submit: () => undefined },
  };

  return {
    device,
    buffers,
    queries,
    async flush() {
      const batch = inFlight;
      inFlight = [];
      for (const settle of batch) settle();
      // let every awaiting resolveQueriesAsync run to completion
      for (let i = 0; i < 8; i++) await Promise.resolve();
    },
  };
}

function install(): { timer: GpuTimer; pool: any; dev: ReturnType<typeof fakeDevice> } {
  const dev = fakeDevice();
  const backend: any = {
    device: dev.device,
    trackTimestamp: true,
    timestampQueryPool: { render: null, compute: null },
    getTimestampUID: (ctx: any) => `r:0:${ctx.id}`,
  };
  const timer = installGpuTimer({ backend });
  if (timer === null) throw new Error('installGpuTimer refused the fake backend');
  return { timer, pool: backend.timestampQueryPool.render, dev };
}

/** Run `n` passes of `ms` each through the render pool, as three would. */
function renderFrame(pool: any, dev: ReturnType<typeof fakeDevice>, n: number, ms: number): void {
  for (let i = 0; i < n; i++) {
    const base = pool.allocateQueriesForContext(`r:0:${i}|pass${i}`);
    dev.queries[base] = 1000n;
    dev.queries[base + 1] = 1000n + BigInt(ms) * NS;
  }
}

describe('gpuTimer pool', () => {
  it('carries exactly ONE frame per read, even when the frames differ', async () => {
    // The defect: with a single readback buffer, frames that ticked while it was
    // busy kept allocating into the same query set. One "batch" then held N
    // frames of passes, was summed as though it were one frame, and divided by a
    // frame count GUESSED from the data — `frames = max occurrences of any key`.
    //
    // That guess is only right when every frame runs the same passes. Here frame
    // 0 runs four and frames 1-2 run two, which is the shape of the real scene:
    // the ocean FFT is guarded by `lastOceanTime` and skips on frames where no
    // sim tick fired. The batch holds 8 + 4 + 4 = 16 ms across three frames, and
    // the guess (max hits = 3) would report 16/3 = 5.33 ms — a number that is
    // neither frame and never happened. Three separate reads give 8, 4, 4, and
    // min-of-window is 4.
    const { timer, pool, dev } = install();
    renderFrame(pool, dev, 4, 2); // 8 ms
    timer.tick();
    renderFrame(pool, dev, 2, 2); // 4 ms
    timer.tick();
    renderFrame(pool, dev, 2, 2); // 4 ms
    timer.tick();
    await dev.flush();
    expect(timer.health().reads).toBe(3);
    expect(timer.health().batchFrames).toBe(1);
    expect(timer.total('render')).toBeCloseTo(4, 5); // not 5.33, and not 16
    expect(timer.health().passesPerFrame.render).toBe(2);
  });

  it('discards a frame it cannot drain instead of merging it into the next', async () => {
    // Bounding the pool at one frame is the whole reason overflow stopped
    // happening. Six slots means six frames may be outstanding; the seventh has
    // nowhere to go and must be thrown away, not accumulated.
    const { timer, pool, dev } = install();
    for (let f = 0; f < 10; f++) {
      renderFrame(pool, dev, 4, 2);
      timer.tick();
    }
    const h = timer.health();
    expect(h.misses).toBe(4); // 10 frames, 6 slots
    await dev.flush();
    // every landed read is still a single frame
    expect(timer.total('render')).toBeCloseTo(8, 5);
    expect(timer.health().reads).toBe(6);
  });

  it('counts a pool with nothing to time as idle, NOT as a miss', async () => {
    // `miss 9282` beside `reads 166` made the health line unreadable, and most
    // of those misses were the compute pool simply having no dispatch that
    // frame. A miss has to mean something went wrong.
    const { timer } = install();
    for (let f = 0; f < 5; f++) timer.tick();
    const h = timer.health();
    expect(h.misses).toBe(0);
    expect(h.idle).toBe(10); // 5 ticks x 2 pools, nothing allocated
  });

  it('records NO total for a frame that overflowed, and suppresses the ranking', async () => {
    // An overflowed frame is missing an unknown number of passes, so its sum is
    // an UNDER-count. Letting it into the min-of-window would make the frame
    // read cheaper than it is — and the surviving passes would still print as a
    // confident top-8.
    const { timer, pool, dev } = install();
    renderFrame(pool, dev, 2000, 1); // capacity is 1023 pairs
    timer.tick();
    await dev.flush();

    const h = timer.health();
    expect(h.overflows).toBeGreaterThan(0);
    expect(h.incompleteReads).toBe(1);
    expect(Number.isNaN(timer.total('render'))).toBe(true);

    const text = formatGpuHud(timer).join('\n');
    expect(text).toContain('SUPPRESSED');
    expect(text).toContain('-- ms'); // no total either
  });

  it('does not overflow at the measured per-frame pass count', async () => {
    // Sized from measurement: the worst frame observed was 143 compute passes.
    // This is the headroom claim, asserted rather than asserted-in-a-comment.
    const { timer, pool, dev } = install();
    for (let f = 0; f < 6; f++) {
      renderFrame(pool, dev, 143, 1);
      timer.tick();
    }
    await dev.flush();
    expect(timer.health().overflows).toBe(0);
    expect(timer.health().passesPerFrame.render).toBe(143);
  });
});
