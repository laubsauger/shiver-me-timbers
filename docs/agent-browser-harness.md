# Measuring this app in a browser

Every technique here was discovered the hard way during one session, lost with
an agent's throwaway snapshot, and then rediscovered by the next agent. It is
written down so that stops happening.

The theme: **almost every instrument in this stack can silently return a stale
answer.** Not an error, not a NaN — the *previous* frame's data, indefinitely.
Several hours were spent on measurements that were byte-identical across
conditions because of one of the traps below. Assume staleness until you have
proven liveness with a control.

---

## 1. A hidden tab does not render (§B.25)

Chrome throttles `requestAnimationFrame` to **zero** in a background tab and
`setTimeout` to **≥1 s**. The app's loop never ticks, `__game` never appears,
and boot never completes.

This is not a corner case. With several agents each holding a WebGPU context,
**nobody can keep a foreground tab**, so this blocks essentially all visual
verification. Two working escapes:

### (a) Drive rAF from a `MessageChannel`

Message tasks are **not** throttled. Post a message; service the rAF callback
queue when it arrives.

> **Trap that livelocks the tab.** A free-running tick — a Web Worker posting
> every 16 ms — queues callbacks faster than a contended tab can run them. The
> queue grows without bound and the page becomes permanently unresponsive; the
> only recovery is closing it. **Post one tick only when a callback is actually
> queued**, so depth stays bounded at one frame however slow the frame is.

> **"Only when a callback is queued" is not enough on its own.** A callback is
> *always* queued: three's `Animation` module re-registers rAF from inside its
> own callback, so a `MessageChannel` that re-posts whenever the queue is
> non-empty free-runs at message-task rate. Measured: **1.8 M callbacks** while
> boot never finished, because rAF was spinning instead of pacing. You need a
> **rate limit as well as a depth limit** — a Worker `setInterval` (workers are
> not throttled in a hidden tab) posting at the frame rate you want, with the
> main thread dispatching at most one batch per tick and skipping ticks while a
> batch is still running.

### (b) Pump the loop directly

Expose the `GameLoop` and call `step()` yourself. For **bit-exact A/B pairs**,
swap `loop.tick` for a no-op to freeze the sim, then write the parameter you
are testing straight to its uniform and capture without a tick in between.
This is the only way to get matched frames — the sea moves otherwise, and its
frame-to-frame drift is larger than most effects being measured.

---

## 2. Reading pixels back

**The compositor will not snapshot a background tab's WebGPU surface.**
Extension screenshots and CDP capture return stale or empty frames. Read the
canvas yourself: `toDataURL` → POST to a small local endpoint → file.

Three ways this lies to you:

- **`readRenderTargetPixelsAsync` on a *reused* RenderTarget returns the first
  frame forever.** Allocate a fresh target per read.
- **It returns the 256-byte-row-padded buffer un-stripped.** Any readback at a
  width that is not a multiple of 64 comes back diagonally striped. Unpad with
  `stride = ceil(w * 4 / 256) * 256`.
- **`canvas.toDataURL()` returned byte-identical images 700 ms apart** under
  load, while extension screenshots minutes apart clearly differed (clouds had
  moved, `draws` had incremented). Anything reading that canvas under
  contention is suspect. Prove liveness with a control that must change.

---

## 3. Post-processing does not re-run outside the app's frame

`post.renderAsync()` will not re-render unless you call
`renderer._nodes.nodeFrame.update()` first: `PassNode` and `BloomNode` are
`NodeUpdateType.FRAME` and skip on an unchanged `frameId`.

Worse, **three's `Animation` module bumps `nodeFrame.frameId` from its own
internal rAF** — which a hidden tab stops. So `updateBefore` is skipped and
`post.render()` re-composites a **stale scene texture while looking like a
fresh frame**. One agent's first three A/B legs came out byte-identical at
camera y = 6, y = 40 and y = 300 for this reason.

---

## 4. Timing

- **`__perf.report()` overstates GPU by ~3.3×.** Measured against ground truth
  on the same frames: `27.33 ms` reported versus `8.2 ms` actual. Treat
  per-pass numbers as **ordinal at best**.
- **Ground truth is `queue.onSubmittedWorkDone()`** bracketing a batch of
  presents, min-of-N. **Budget for it.** In a hidden, contended tab a single
  `await queue.onSubmittedWorkDone()` can take seconds, so a 120-sample
  min-of-N never finished inside a 30-minute window. Take 25 samples, and post
  each stage of a capture as it completes rather than at the end.
- Absolute numbers are meaningless under contention — boots have taken **241 s**
  (209 s of shader compile), and one framing jumped **6 fps → 71 fps** the
  moment other agents closed their tabs. **Deltas from interleaved A/B legs are
  sound; absolutes are an upper bound.**
- Interleave every leg. Both series drift upward over a run (thermal), and that
  drift has been larger than the effect being measured.

---

## 5. Your own snapshot, and nobody else's

Serve an isolated `rsync` copy of the repo, in a **uniquely named** directory,
on **your own port**. The scratchpad root is shared and one agent's `rsync`
clobbered another's snapshot mid-run.

- **Make the page report its own results.** The MCP tab group is re-formed
  without warning and tabs leave it — four sessions were lost mid-boot this way,
  each costing a 4-6 minute reboot. A measurement that runs *in the page* and
  `fetch`es its JSON to a tiny local endpoint keeps running and lands its result
  even when you can no longer reach the tab. Poll the file, not the tab.

- **Set `cacheDir` in the snapshot's own `vite.config.ts`.** `npx vite` in a
  snapshot whose `node_modules` is a symlink writes its dep cache into the
  **real repo's** `node_modules/.vite`, and another agent's dep re-optimisation
  then force-reloads your page.
- **Vite's file watcher does not work under `/private/tmp`.** The dev server
  serves a stale transform cache; restart it after every edit.
- **Never `pkill -f vite`.** One agent did and took down three other agents'
  servers. **It happened again** — a dev server on its own port died mid-run and
  the next `navigate` landed on `chrome-error://chromewebdata/`, which looks
  exactly like a slow boot from the outside. **Check the port is still
  listening (`lsof -tiTCP:<port> -sTCP:LISTEN`) before concluding a page is
  still compiling**, and start the server with `nohup … & disown` so your own
  shell teardown is not another way to lose it.
- **Never navigate or close a tab you did not create.** One agent's first
  `navigate` hijacked another's tab and cost it its in-page state.

---

## 6. State that reverts under you

- `applyWorldSettings` (`src/ui/settingsStore.ts`) reverts `timeOfDay`.
- The §V.46 ambient hold reverts sea state.

Pin both explicitly, and re-check them after any settings write.

---

## 7. The GPU pass list used to go silently incomplete

**Fixed — recorded because the failure shape recurs.** `src/debug/gpuTimer.ts`
held **one** readback buffer per pool, so only one `mapAsync` could be in
flight. Every frame that ticked while it was busy kept allocating query pairs
into the same set, so a "batch" was however many frames the readback had fallen
behind. Measured on this scene: **render 26-27 passes/frame, compute 85**
(peaks 54 and 143), readback latency ~4 frames in a foreground tab. At 85
pairs/frame a 2047-pair pool exhausts after ~24 frames — which is the `ovf 89`
capture. The pool did not overflow because a frame was big; it overflowed
because **the drain fell behind and the pool had no per-frame boundary**.

Note that 27 render passes is not the 18 an earlier count reported. The top of
the list is `output`, one full-res `rt`, SMAA's `edges`/`weights`/`blend`, the
canvas and two half-res `rt`s — post-processing rows a hand count of "render
passes" tends to leave out. **Where the remaining 19 come from was not
established**; `health().passesPerFrame` is the count to trust, not a tally
made by reading the scene graph.

The dangerous part was never the overflow. It was that **the top-8 still
rendered, still looked authoritative, and had no way to say which passes were
missing.**

Two things now hold, and both are worth knowing before you read a capture.
`tests/gpuTimerPool.test.ts` drives the real pool through a fake WebGPU device
and pins them, so they can be re-checked in 200 ms without a browser:

- **A batch is exactly one frame.** `tick()` is the frame boundary, six
  readbacks may be in flight, and a frame that cannot get a slot is
  **discarded** rather than merged. Nothing is divided by a guessed frame
  count any more. `health().batchFrames` is 1 by construction — anything else
  is a bug in that file.

  The guess it replaces was `frames = the most times any key appeared`, and it
  was **structurally wrong, not occasionally wrong**: pass keys are not unique
  within a frame. Measured live — **27 render passes collapse onto 23 keys, and
  141 compute passes onto 89**. So some key is hit two or more times in a single
  frame, and the heuristic reads that as two or more frames and divides by it.
  That is precisely `batchFrames` reading **2 on frames that were all drained**,
  and **9-10 against a reads/misses ratio implying 3.8**. It over-counted
  frames, so every per-pass number it produced was **understated**.
- **An overflow suppresses the ranking.** `formatGpuHud` and `__perf.report()`
  print the reason where the list would be. If you see a pass list at all, no
  pass was dropped.

Read `health()` before quoting a number: `reads` (frames captured), `drop`
(frames discarded for lack of a slot — sampling, not failure), `idle` (pool had
nothing to time, which is not a miss and no longer counted as one), `ovf` and
`unwritten` (both mean STOP).

**Readback latency in a hidden tab is seconds, not frames.** Measured on the
same machine, same build: a foreground tab drained **1 read per 3.9 frames**; a
hidden tab driven by a worker pump drained **12 reads against 936 discarded
frames**, with `staleMs` reaching **8 s**. The instrument now says so — totals
render as `--` once the last read is over a second old, and the health line
prints `last 8.0s ago` — but plan for it: **a hidden tab samples GPU timing
sparsely, and any capture you take there is a handful of frames, not a window.**

**`total()` changed meaning.** It is now the min over *real frames*, so on a
scene with conditional passes (the ocean FFT only dispatches when `state.time`
moved) it is the **cheapest frame**, not an amortised average. Per-pass minima
are now the cost of a pass **on the frames it actually ran**, which is the
number you want.

**The 3.3× overstatement is still unexplained, and the ratio itself did not
reproduce.** One candidate was weakened but not eliminated: the old
`frames = max hit count` divisor was compared against an exact per-tick frame
count and **matched** on the one batch it was sampled (render 5 = 5, compute
5 = 5), so the divisor was not wrong *there*. Two post-fix captures then
disagreed with each other — one had wall frames averaging **35.96 ms** against a
render-pass sum of **50.14 ms** (1.4× and impossible: serial GPU passes cannot
outlast the frame in steady state), the other **146.08 ms** wall against
**146.87 ms** of passes (1.0×, consistent). Both were min-of-window over a
handful of reads in a saturated tab. **Nothing here explains the 3.3×, and
nothing here reproduces it.** Per-pass numbers remain **ordinal at best**.

What the fix *did* make legible: on the bloom build the top of the render list
is **seven separate `UnrealBloomPass` mip passes plus `output`**, 9.2-23.4 ms
each. The earlier report that "the GPU top-8 is entirely bloom and output" was
not a truncation artefact — those are eight real, distinct, dominant passes, and
they now carry names instead of collapsing onto `rt`.

### The overlay's own `frame` row is a window now, not a sample

`fps 261.1` beside `frame 0.00 ms` was two statistics of different things: a
30-frame average next to the single most recent `frameDt`. The row now reads
`frame <avg> avg <min> min <max> max ms` over the **same** ring as fps, so
`avg` is exactly `1000 / fps` and the two can never disagree — and the spread is
on screen, because an earlier capture reading `frame 9.30 ms` was a real sample
from a window averaging **23.3 ms**. The frame was jittery, not cheap, and one
sample read as steady state steered a whole investigation.

**A `dt <= 0` frame is now called out.** Chrome hands every callback fired for
one frame the same rAF timestamp, so `dt === 0` means the render callback ran
**twice** against one timestamp — which inflates fps by the duplication factor
while printing 0. The arithmetic of the original capture fits exactly: a window
alternating 7.66 ms and 0 averages 3.83 ms, i.e. `fps 261.1`, on a machine
really running 130.5 fps. **Not proven** to be what produced it — the source of
a duplicated dispatch was never found — but the HUD will now say so instead of
printing a confident 261.

---

## 8. Judge at more than one sun angle

Three separate fixes shipped this session after being validated at one
`timeOfDay` and failing at the other. Bloom's own contribution to one artifact
measured **0.30/255 at midday and up to +62/255 at 17.6** — so a fix validated
at one angle can look like a cure and be a no-op at the other.

**Check both `timeOfDay` 15.0 and 17.6** before claiming anything is fixed.
