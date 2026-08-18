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
  presents, min-of-N.
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

- **Set `cacheDir` in the snapshot's own `vite.config.ts`.** `npx vite` in a
  snapshot whose `node_modules` is a symlink writes its dep cache into the
  **real repo's** `node_modules/.vite`, and another agent's dep re-optimisation
  then force-reloads your page.
- **Vite's file watcher does not work under `/private/tmp`.** The dev server
  serves a stale transform cache; restart it after every edit.
- **Never `pkill -f vite`.** One agent did and took down three other agents'
  servers.
- **Never navigate or close a tab you did not create.** One agent's first
  `navigate` hijacked another's tab and cost it its in-page state.

---

## 6. State that reverts under you

- `applyWorldSettings` (`src/ui/settingsStore.ts`) reverts `timeOfDay`.
- The §V.46 ambient hold reverts sea state.

Pin both explicitly, and re-check them after any settings write.

---

## 7. Judge at more than one sun angle

Three separate fixes shipped this session after being validated at one
`timeOfDay` and failing at the other. Bloom's own contribution to one artifact
measured **0.30/255 at midday and up to +62/255 at 17.6** — so a fix validated
at one angle can look like a cure and be a no-op at the other.

**Check both `timeOfDay` 15.0 and 17.6** before claiming anything is fixed.
