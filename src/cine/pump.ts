/**
 * rAF pump for a hidden tab (docs/agent-browser-harness.md §1).
 *
 * Chrome throttles `requestAnimationFrame` to ZERO in a background tab, so a
 * 5000-frame render stops dead the moment the window loses focus — silently,
 * because nothing errors: the loop simply never ticks again. Nobody is going
 * to sit and watch a 40-minute render without touching anything, so the
 * recorder drives the frame clock itself.
 *
 * The two limits below are not optional; the doc records what happens without
 * each of them:
 *
 *  - RATE limit. A worker `setInterval` sets the pace (workers are not
 *    throttled). Re-posting whenever the queue is non-empty free-runs instead,
 *    because three's `Animation` module re-registers rAF from inside its own
 *    callback and the queue is therefore ALWAYS non-empty — measured at 1.8 M
 *    callbacks while boot never finished.
 *  - DEPTH limit. One batch in flight. A free-running tick queues callbacks
 *    faster than a contended tab can run them, the queue grows without bound
 *    and the page becomes permanently unresponsive.
 *
 * The clock handed to callbacks is SYNTHETIC and advances by exactly one frame
 * per batch, which is what the recorder wants anyway: wall-clock time is not
 * the thing being recorded.
 */
const WORKER_SRC =
  'let h=null;onmessage=(e)=>{clearInterval(h);h=null;' +
  'if(e.data&&e.data.stop)return;h=setInterval(()=>postMessage(0),e.data.ms);};';

export interface Pump {
  /** callbacks dispatched so far — a liveness control, not a statistic */
  readonly dispatched: number;
  stop(): void;
}

export function startPump(hz = 60): Pump {
  const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
  const worker = new Worker(url);
  const real = window.requestAnimationFrame.bind(window);
  const queue: FrameRequestCallback[] = [];
  let clock = performance.now();
  let busy = false;
  let dispatched = 0;
  let stopped = false;

  window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    queue.push(cb);
    return queue.length;
  };

  worker.onmessage = (): void => {
    if (busy || queue.length === 0) return;
    busy = true;
    clock += 1000 / hz;
    const batch = queue.splice(0, queue.length);
    for (const cb of batch) {
      try {
        cb(clock);
        dispatched++;
      } catch (e) {
        console.error('[cine] frame callback threw', e);
      }
    }
    busy = false;
  };
  worker.postMessage({ ms: Math.max(Math.round(1000 / hz), 1) });

  return {
    get dispatched(): number {
      return dispatched;
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      worker.postMessage({ stop: true });
      worker.terminate();
      URL.revokeObjectURL(url);
      window.requestAnimationFrame = real;
      // hand the chain back: the callbacks parked in our queue are the app's
      // only link to the next frame, and dropping them stops the game for good
      for (const cb of queue.splice(0, queue.length)) real(cb);
    },
  };
}
