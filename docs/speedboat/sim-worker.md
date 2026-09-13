# Speedboat NPC physics off the main thread (§T.178)

Status: core, transports, COI wiring and tests built. Not wired into a page yet (no speedboat race page exists).
Browser measurements are PENDING (see the end).

## Decisions (user, 2026-09-13)

- **Full fidelity for every boat** (§V110). Player and 7 NPCs run the same `rigid6` + `hullWater` step, the 0.8 m patch and
  the same adaptive substeps. There are no LOD tiers. The cost moves off the main thread; it is never cut.
- **Transport order**:
  1. `sab`: SharedArrayBuffer + Atomics, used when the page is `crossOriginIsolated`. This is the default.
  2. `transfer`: a Worker with transferable ArrayBuffer ping-pong. The same bytes move every tick, and nothing is
     structured-cloned except a two-field envelope.
  3. `main`: in-process on the main thread, only when there is no `Worker`.

  The coordinator relayed the revision that allows (2): "we can do message passing if it's not horribly slow… better than
  hogging the main thread still".

## Files

| File | Role |
|---|---|
| `src/sim-worker/layout.ts` | The buffer layout, its offsets, and the V2 output hash |
| `src/sim-worker/paramsVector.ts` | `OceanParams` / `SeaPhysicsParams` flattened to f64 tick inputs |
| `src/sim-worker/stepCore.ts` | `BoatSimCore`: the one step implementation, plus the stand-in drive |
| `src/sim-worker/transport.ts` | `MainThreadTransport`, `SabWorkerTransport`, `TransferWorkerTransport` behind `BoatStepTransport` |
| `src/sim-worker/fleet.ts` | `BoatFleet`: the main-thread face (place, setControls, kick, done/poll, readPose, hash) |
| `src/sim-worker/workerHost.ts`, `worker.ts` | The stepper side (environment-free host, browser entry) |
| `src/sim-worker/select.ts` | Capability detection, transport order, console warning, `transferIsWorthIt` rule |
| `vite.config.ts` | COOP/COEP for dev + preview; worker output under `speedboat-workers/` |
| `public/coi-sw.js`, `public/coi-register.js` | GitHub Pages COI shim, written for this repo |
| `speedboat-lookdev.html` | One `<script src="./coi-register.js">` line |
| `tests/simWorker{Layout,Determinism,Isolation}.test.ts`, `tests/simWorkerNode.ts` | Tests and the node worker harness |

## Buffer layout

There is one flat buffer per stepper shard. The layout is the same for SAB, transferable and in-process, and `f64` indexes
the whole buffer in 8-byte units.

```
[0,64)            Int32 header: MAGIC VERSION BOATS WAKE_CAP OCEAN_LEN SEA_LEN KICK DONE TICK PARAMS_VERSION SHARD_START SHARD_END STATUS
f64[8..16)        TIME, STEP_MS (telemetry), published fidelity: PATCH_SPACING PATCH_MARGIN PATCH_MAX_AXIS MIRROR_RESOLUTION INV_DISP_ITERS UPDATE_EVERY_TICKS
OCEAN  (≈70 f64)  flattened OceanParams for tick k                    main writes
SEA    (n f64)    flattened SeaPhysicsParams for tick k               main writes
WORLD  boats×13   every boat's pose at tick k (read-only snapshot)    main writes, steppers READ ONLY
BOAT i (44 + wakeCap×5 f64):
  IN   controls[4] (throttle, steer, trim, reserved), resetSeq, resetPose[13]            main writes
  OUT  pose[13] (p3 q4 v3 ω3), substeps, wettedArea, displacedVolume, slamImpulse,       stepper writes
       capScale, propDepth, propImmersion, patchOutside, patchSamples,
       wakeCount, wakeDeficit, wakeRescale, wakeOverflow, wake samples (x z fy σ depth)×wakeCap
```

- **Ownership is by region.** Between `kick` and `done`, the main thread does not touch the buffer. A shard's stepper writes
  only the OUT blocks of its own boats `[SHARD_START, SHARD_END)`, so no two workers ever write the same byte.
- **Teleport (V108).** `place(i, pose)` writes `resetPose` and increments `resetSeq`. The core applies it exactly once and
  resets `Rigid6Memory` and `HullWater` memory.
- **Wake samples.** `wakeCap` defaults to 256. `wakeOverflow` counts what did not fit and is never silently truncated; it
  stayed 0 over the 600-tick race.

### Cross-boat data (T170/S6), designed but not used yet

- **Poses.** Before each kick, the main thread copies every boat's tick-k pose into WORLD, in every shard's buffer. A stepper
  that needs another boat (capsule collision, wake riding) reads WORLD, **never another shard's OUT block**. OUT blocks are
  written concurrently by other workers, while WORLD is frozen for the tick. That makes the result a function of tick-k inputs
  alone, whichever worker a boat lives on (§V2). The worker-count test then still holds.
- **Wake field.** A shared wake field (MBs) should not live in the per-shard buffer.
  - On `sab`, it goes in a separate read-only SharedArrayBuffer, written by the main thread between ticks (after collect,
    before kick) and handed to workers once at init. All workers read one copy.
  - On `transfer`, it is a second buffer per shard. Copying it per tick is what would make this path "horribly slow" at wake
    resolution, so for T170 measure it or send only the field rows near each shard's boats.
- **Pairwise impulses.** Collisions change two boats at once. Resolve them on the main thread from the published OUT poses
  after collect (28 pairs), and feed the results back as the next tick's reset or impulse input. Alternatively, keep both
  boats of a contact pair in one shard. Either way the resolution order is fixed by boat index, never by thread timing.

## Tick handshake and page integration

```
per shard:  main  write inputs k → Atomics.store(KICK, seq) → Atomics.notify(KICK)
            worker Atomics.wait(KICK) → core.step → Atomics.store(DONE, seq) → Atomics.notify(DONE)
            main  poll(): DONE === seq      (no event-loop hop; also works mid-frame)
                  done(): Atomics.waitAsync(DONE), or a timer poll where waitAsync is missing
transfer:   main  postMessage({type:'tick', buffer}, [buffer]) → worker steps → posts it back → main rebinds views
```

- **Browser main thread.** `Atomics.wait` is forbidden on the browser main thread, so the page must never block.
  - **Kick at the end of a frame's sim ticks.**
  - **Collect at the next frame's first tick.** The worker gets the render/encode window (about 16 ms) to step.
  - On a catch-up frame with several ticks, the second and later ticks `await fleet.done()`. The loop owner decides whether
    that stall is taken in-frame or the tick moves to the next frame. Both are deterministic, because the sim is tick-indexed.
- **Tick order** (fleet.ts header), deterministic:
  1. Collect k.
  2. Read poses for render and logic.
  3. Write controls and resets for k.
  4. `kick(tick, time, oceanParams, seaParams)`, called **after** the weather/panel moved the params for this tick.
- **Transfer path.** While a tick is away, the buffers are not on this thread, and `BoatFleet` throws on any read or write
  in that window instead of letting it vanish. Its results also arrive only when the main thread yields to its event loop.
  That does not matter for the pipelined pattern, but it cannot be polled mid-frame the way SAB can.
- **Render interpolation** is unchanged: the render lerps between the last two collected OUT poses, as it does today.
- `workers` is configurable; the default is 1. Boats are split into contiguous ranges (`shardRanges`).
  - Each worker owns a `CpuOcean` mirror, so 2 workers cost about 1.4 ms more CPU per tick in total (see perf).
  - Splitting only pays when the boat work dominates the mirror.

## What makes the NPC sea equal the player's sea (CpuOcean inputs)

Each stepper builds its own `CpuOcean(seed, oceanParams, seaParams)`, which owns its `SpectrumScheduler`. Its answers are
pure functions of:

| Input | Enters as | Crosses the transport as |
|---|---|---|
| seed | h0 gaussians (`seed + i·7919`) | init message (once) |
| OceanParams, **per tick** | spectrum signature → arm (15 ticks) / amortised build (26) / swap; choppiness + fold cap; fetch/shoaling/swell-share coefficients | OCEAN vector, `PARAMS_VERSION` bump on any leaf change |
| SeaPhysicsParams, per tick | mirrorResolution, updateEveryTicks, inverseDisplacementIterations, Smith depth `hullDraft·smithDepthScale` (V105) | SEA vector |
| time | wave phase | `TIME` as the exact float64 `SimState.time`, never re-derived as tick·dt |
| construction tick | the scheduler's countdown/build is history | build the fleet on the same tick as the page mirror, before tick 0 |
| seabed | shoal factor, breaker clip, grid-coord depth | **not wired** (see blockers) |
| fetch + swell shadow | band gains | **not wired**; designed as SAB grids read with fetchField's exported `sampleGrid` |
| wake | `wakeHeightCpu` | **not wired**; §V8 amendment: hulls do not feel the sim wake until §T.170 |

**Tested:** a core-owned scheduler and a page-style shared scheduler (advanced externally, then `update`, which is main.ts's
order) give `toBe`-identical `heightAt` and `pressureHeadAt` for 90 ticks, through a wind-change rebuild.

**Frame-rate-dependent shelter field: FIXED (§B119).** `fetchAt`/`shadowAt` now rebuild from the live sim params on read, so every tick reads the grid for that tick's params, with or without a renderer (`tests/fetchDeterminism.test.ts`). For workers: the grids still have to come from the same deterministic params. Either rebuild them in the worker from the SAB-shared params, or copy them into shared memory keyed by `FetchField.version`.

## Determinism evidence (V2)

`tests/simWorkerDeterminism.test.ts` covers 600 ticks, 8 boats, seed 178 and a speedboat Smith depth of 0.5 m. Setup:
- Throttle ramps up and steering follows a sine.
- A wind shift at tick 200 rebuilds the spectrum mid-race; the swap lands around tick 241.
- The worker paths run on **real `worker_threads`** against a Vite bundle of `workerHost.ts`.

| Path | Hash (FNV-1a over every boat's OUT block, chained over ticks) |
|---|---|
| main (in-process) | `3cf262c7` |
| sab × 1 worker | `3cf262c7` |
| sab × 2 workers | `3cf262c7` |
| transfer × 1 worker | `3cf262c7` |
| transfer × 2 workers | `3cf262c7` |

The test also checks three more things:
- The substep sequences (8×600) are equal on every path.
- The published fidelity (patch 0.8 m, margin, max axis, mirror 64²) is equal on every path.
- Controls change the hash, so the controls array is really carried.

Measured: `planingSubsteps` returns 2 on every tick of this race. For this hull the rule only exceeds 2 above about 100 m/s.
The count is still compared.

## Performance (node 24, dev machine, real worker_threads, 8 boats, paced at 60 Hz, 600 ticks after 90 warm-up)

Source: `tests/zzScratchSimWorkerPerf.test.ts`, which is gitignored like every scratch harness.

- **Main-thread ms/tick** is inputs + kick + reads.
- **RT** is the round trip from kick to results home.
- **Overhead** is RT minus the per-shard step time.

| Path | Main-thread ms/tick p50 / p95 | RT p50 / p95 / p99 / max | Worker step (Σ shards) p50 | Overhead p50 / p95 / p99 | Late ticks |
|---|---|---|---|---|---|
| **main** | **4.80 / 5.12** | n/a | 4.78 | n/a | 0 |
| **sab × 1** | 0.024 / 0.033 | 2.63 / 2.90 / 4.16 / 5.80 | 2.58 | 0.053 / 0.076 / 0.112 | 0 |
| sab × 1, `Atomics.wait` collect | 0.023 / 0.031 | 2.65 / 2.96 / 4.55 / 6.42 | 2.59 | 0.054 / 0.081 / 0.124 | 0 |
| sab × 2 | 0.032 / 0.046 | 2.20 / 2.56 / 3.76 / 4.81 | 4.17 | 0.11 / 0.26 / 0.71 | 0 |
| **transfer × 1** | 0.031 / 0.047 | 2.74 / 2.97 / 4.15 / 6.15 | 2.63 | 0.100 / 0.148 / 0.195 | 0 |
| transfer × 2 | 0.041 / 0.057 | 2.22 / 2.55 / 3.71 / 6.61 | 4.15 | 0.14 / 0.33 / 1.48 (max 4.2) | 0 |

**With the main thread busy for 10 ms per frame** (a busy-loop standing in for render encode):
- Main-thread cost is unchanged.
- There are still **0 late ticks** on every path.
- The measured RT becomes about 10.05 ms on every path. That number is an artifact: completion can only be *observed* when
  the main thread yields. SAB's `poll()` would see it at about 2.6 ms; transfer's buffers only come home after the yield.

Reading:
- **Moving 8 boats off the main thread saves about 4.8 ms of main-thread time per tick.** The remaining main-thread cost is
  about 25–40 µs.
- **Transfer is not "horribly slow" in node.** Overhead is about 0.1 ms p50 and 0.15 ms p95 against SAB's 0.05 / 0.08.
  Jitter is comparable; the two-worker transfer p99 of 1.5 ms is the worst tail.
- **"Horribly slow" would mean either of these:**
  - The round trip no longer fits a tick with slack. The collect would then stall the frame.
  - The overhead is comparable to the work moved. That is the T170 wake field copied every tick, not this payload.
- **2 workers:** RT drops 2.6 → 2.2 ms, but CPU rises 2.6 → 4.2 ms because each worker runs its own mirror update. Keep
  **1 worker** for 8 boats.
- The in-process main step measured 4.8 ms against 2.6 ms on a worker thread for the same work. This is probably test-runner
  contention on the vitest main thread; re-check in the browser.

**Rule for keeping transfer (2) over main thread (3)**, in `select.ts` as `transferIsWorthIt`. Keep the worker while **both**
hold:
- `p95 RT ≤ tick − 4 ms` (12.7 ms at 60 Hz), so pipelined collect almost never waits.
- `p95 overhead ≤ 2 ms`.

Node numbers pass both by a wide margin: 3.0 ms and 0.15 ms. Evaluate the rule on the first ~120 ticks in the browser. The
downgrade itself is not wired; it belongs to the page that owns the loop.

## Cross-origin isolation

- **Dev and preview** (`vite.config.ts`) send `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` on every response.
  - **Why `require-corp` over `credentialless`:** Safari supports require-corp but not credentialless, and every resource the
    three pages load is same-origin (audit below). The strict policy therefore costs nothing and fails loudly if a CDN is
    ever added.
  - The headers apply to the pirate and raft pages in dev too. Their resources pass the audit.
- **GitHub Pages** cannot set headers, so `public/coi-sw.js` and `public/coi-register.js` do it. The approach follows
  coi-serviceworker, but this repo's copy is original: nothing vendored, no licence carried, no CDN.
  1. `coi-register.js` is a classic script placed before the module. Only speedboat pages include it. It does nothing when
     already isolated; otherwise it registers `coi-sw.js` with **scope `<base>/speedboat`**.
  2. That URL prefix matches `speedboat-lookdev.html`, a future `speedboat.html` and the bundled `speedboat-workers/*`. It
     does **not** match `index.html` or `raft.html`, so the pirate and raft pages are never controlled.
  3. After `clients.claim()`, the page reloads **once**, guarded by `sessionStorage`. If it is still not isolated (hard reload,
     private mode, no SW), the shim logs a warning and gives up. `select.ts` then picks `transfer` and warns in the console.
  4. The SW rewrites only `document`, `iframe`, `worker` and `sharedworker` responses; COEP only matters on those. Opaque and
     redirected responses pass through untouched.
- **Worker scripts must carry COEP too.** A require-corp page refuses a dedicated worker whose response lacks COEP. That is
  why `worker.rollupOptions.output` puts worker bundles under `speedboat-workers/`, inside the SW scope.

### Cross-origin resource audit (all three pages)

| Resource | Page(s) | Origin | Under COEP require-corp |
|---|---|---|---|
| `/assets/branding/*` (favicon, splash PNG/JPG, CSS `url()`) | index, raft | same | OK |
| Module scripts, chunks, Vite client/HMR (dev) | all | same | OK |
| SFX, music, radio audio (`new URL(…, import.meta.url)`, `fetch` + `<audio>`) | index, raft | same (hashed assets) | OK |
| Grade LUT PNGs (`core/gradeLut.ts`) | index, raft | same | OK |
| Boat GLB (`speedboat/assets`) | lookdev | same | OK |
| KTX2 Basis transcoder JS + wasm (`?url`, redirected via LoadingManager) | lookdev | same (hashed) | OK; its transcoder worker is a blob: worker and inherits the policy |
| Meshopt decoder | lookdev | embedded wasm, no fetch | OK |
| Draco decoder | none | not used | n/a |
| Web fonts / Google Fonts / any CDN | none | not used (system font stacks) | n/a |
| cine sink `http://127.0.0.1:7654` POST (user WIP) | index | cross, **CORS mode** (sink sends ACAO) | OK: COEP gates no-cors loads only; pirate page, dev tool |
| cine pump blob worker, wake preview blob worker | index / wake preview | blob: | OK: inherits the owner's policy |
| wake preview sink `http://127.0.0.1:5299` POST | wake preview harness | cross, CORS | OK |

`tests/simWorkerIsolation.test.ts` keeps this honest. It scans all three HTML files for remote `src`/`href`/`url()`/CDN
hosts, and every `src/**/*.ts` for `http(s)://` literals other than the localhost sinks and the SVG namespace.

## Fallback behaviour

- **Not isolated but has `Worker`:** the `transfer` path runs the same core at the same fidelity. The console shows
  `[sim-worker] NPC physics on a worker via transferable buffers, not SharedArrayBuffer: page is not crossOriginIsolated …`.
- **No `Worker`:** the `main` path runs the same core in-process on the calling thread. The console warns about the MAIN THREAD.
- **A stepper error** (for example rigid6's non-finite throw) sets `STATUS=ERROR`, posts the message and still stores DONE,
  so `done()` rejects with the worker's stack and nothing hangs.

## Stand-in drive (deviation, flagged)

No drive model exists yet (T166). Without one, a controls array carries nothing observable, so `stepCore.ts` has a clearly
marked `STANDIN_DRIVE`. It applies throttle × 40 kN × prop immersion along body +z, yawed by steer × 0.45 rad, at the prop
point. Replace it with `drive.ts` inside the core, and every transport picks up the change.

## Blockers and exports needed from other owners

1. **Seabed in workers** (`src/island`). `SeabedField.heightAt` closes over `IslandHeightmap.heightAt`, whose sampler is an
   inline closure (`island/heightmap.ts:814`).
   - Needed: an exported pure `heightmapHeightAt(data, size, worldRadius, …, x, z)`, so a worker can rebuild
     `sampleSeabedHeight(islands, x, z, p)` from shared `Float32Array` data (V77: one expression).
   - Until then, rivals over shallows would float on open-ocean depth, so **do not race near islands on the worker path**.
2. **Fetch/swell shadow in workers** (`src/ocean/fetchField.ts`). Needed: read access to the field's private `data` and
   `shadow` grids (or a `copyInto(fetch, shadow)`) plus `res`/`origin`/`cell`. The worker then samples them with the already
   exported `sampleGrid`. The render-frame gating finding above also applies.
3. **Wake** (`src/flowfoam`, `src/wake`, T170). Needed: a CPU wake field as data (grid + origin) instead of a method on
   `FlowFoam`, to share read-only as described above.
4. **Page wiring** (`src/core/loop.ts` owner / S0 speedboat entry): the kick-at-frame-end / collect-next-frame integration.
   `loop.ts` has user WIP and was not touched.

## PENDING browser verification (the GPU is saturated, so no dev servers or tabs were started)

1. `npm run dev`, open `/speedboat-lookdev.html`. Expect `crossOriginIsolated === true` in the console (from the headers) and
   no COEP errors. Check `?scene=sea` as well, which loads the GLB and KTX2.
2. Open the pirate `/` and raft `/raft.html` in dev with the new headers: console clean, audio plays, LUTs load.
3. Once a page constructs `createNpcFleet`, confirm `fleet.kind === 'sab'`. Log `fleet.stepMs()` and RT over 600 ticks, then
   evaluate `transferIsWorthIt` with real browser numbers (Chrome, Safari, Firefox).
4. Deploy to Pages and open `…/speedboat-lookdev.html`.
   - The first load reloads once; after that, `crossOriginIsolated === true`, and DevTools → Application shows the SW with
     scope `…/speedboat`.
   - Open `…/` and `…/raft.html` and confirm they are **not** controlled.
5. Hard reload (Shift+Reload) on Pages: expect the shim warning, no reload loop, and the `transfer` fallback warning if a fleet
   is running.
6. Firefox private window: the SW is unavailable. Expect the warning and the `transfer` path.
