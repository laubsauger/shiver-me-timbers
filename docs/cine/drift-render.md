# Drift dome master: parallel offline render

`scripts/drift-render.mjs` renders The Drift's dome master (drift.html, a pure function of act time) with N headless
Chromium pages at once. Each page renders one contiguous frame range into its own clip, and the clips are joined
without re-encoding.

```sh
npm run drift:render -- --size 2048 --fps 30                  # whole act, 4 lanes, x264 -> out/drift/undertime_2048_0-<end>s.mp4
npm run drift:render -- --size 2048 --to 8                    # first 8 s
npm run drift:render -- --size 2048 --codec prores            # ProRes 422 HQ .mov (VideoToolbox), about 1.7x faster at 2048²
npm run drift:render -- --size 1024 --to 4 --lanes 1 --crf 0  # lossless, for comparing renders frame by frame
```

| flag | default | |
|---|---|---|
| `--size` / `--fps` | 2048 / 30 | square master, frame rate |
| `--from` / `--to` | 0 / act end | seconds. The show's end comes from the page (`__drift.total`) |
| `--lanes` | 2 | parallel pages, at most 2 unless `--allow-lanes` (machine guard, below). Each one gets its own browser, sink and encoder, and x264 gets `cores / lanes` threads per lane |
| `--codec` | x264 | `x264` gives .mp4 (crf 12, preset slow, like the cine sink). `prores` gives .mov |
| `--out` | `out/drift/undertime_<size>_<from>-<to>s.<ext>` |
| `--port` | 5288 | the dev server used for this render (see below) |
| `--crf` `--preset` `--inflight` `--queue` | 18, medium, 3, 8 | passed to the sink / page. `--keep` keeps the lane clips |

## Machine guards

A render shares the machine with whoever is working on it. On 2026-10-26 four lanes of Chromium plus ProRes
output filled a 32 GB machine's RAM and its disk to the last 200 MB, and crashed it. Since then:

- at most 2 lanes unless `--allow-lanes` is passed;
- one render at a time: `out/drift/.render.lock` holds the running render's pid;
- before the first frame the driver estimates the output size (x264 0.15, ProRes 0.8 bytes per pixel per
  frame, doubled for lane clips plus the joined file) and refuses to start unless that plus a 20 GB reserve is
  free;
- a failed render deletes its partial lane clips (unless `--keep`).

Previews are x264 mp4 at 1024² with these defaults. ProRes, 2048²+ and motion blur are for masters, after
the art direction is approved.

## How it works

- **Ranges are exact.** Frame n of the act is t = from + n/fps. Lane k renders n in [⌊kF/N⌋, ⌊(k+1)F/N⌋). Before
  launching, the driver checks that the page's own frame count for each lane's from/to equals the lane's range.
  Afterwards it checks every clip's and the joined file's `nb_frames`, and fails the render on any mismatch. The
  log lists how many of a lane's t values differ from a serial take's. They differ by at most 1 ulp of a double.
  Over the whole 86 s act at 2–8 lanes, none of them differs once rounded to f32, which is what the shaders receive.
  In the lossless checks below, that never changed a pixel.
- **The dev server is dedicated to this render.** It is started in-process on `--port`, with no file watcher, no
  HMR and its own dep cache (`node_modules/.vite-drift-render`). Saving a file mid-render therefore cannot reload a
  lane and restart its range. A server already on that port is reused only if it serves this repo's drift.html.
- **Headless on the real GPU.** It uses Playwright `chromium.launch({ channel: 'chromium', headless: true })`: new
  headless mode on the Metal adapter (the log prints `GPU apple/metal-3`), with no GPU flags.
- **One sink per lane.** Each lane gets `scripts/cine-sink.mjs --port 0 --fps --threads --codec --queue`.
  The lane page skips `/manifest` and `/done`, so `--fps` gives the encoder its rate.
- **Failures are loud.** Any of these fails the render with exit code 1: a page error or crash, `__driftRecord.error`,
  a sink exit, a clip that is missing or short, or no lane progress for 180 s. The stall message includes each
  lane's state. Console errors from the pages are printed and counted in a final WARNING, but they do not fail the
  render: a shader that fails to build still produces frames, only wrong ones.

## Measured (2026-10-26, M3 Max, 14 cores / 36 GB, Chromium 1243, ffmpeg 9.0.2)

The fps figures run from the first frame to the last frame reaching the sinks. Boot (launch to first frame) was
0.6–2.6 s. The machine was shared with other workloads during the runs, so expect about ±20 %.

| lanes | 1024² x264 | 1024² ProRes | 2048² x264 | 2048² ProRes |
|---|---|---|---|---|
| 1 | 9.5 | 10.8 | 2.5 | 2.8 |
| 2 | 13.1 | 21.2 | 4.0 | 5.6 |
| 3 | | | 4.9 | 8.1–8.4 |
| **4** | **16.4–21.2** | **36.9** | **5.1–6.2** | **7.5–10.4** |
| 6 | 15.7 | 33.4–37.5 | 5.8 | 8.2 |
| 8 | 15.1 | 37.8 | | |

- **Default: 4 lanes.** That is at or within noise of the best for every size and codec. Beyond 4 lanes the pages
  and encoders compete for the same CPU and GPU.
- **x264 is the limit for mp4.** Encoding from raw frames alone, x264 slow crf 12 runs at 41 fps at 1024² and 15 fps
  at 2048² with all 14 threads. During a render Chromium takes most of the CPU. ProRes on the VideoToolbox engine
  costs almost no CPU (571 fps at 1024², 273 fps at 2048² standalone). That is why ProRes lanes scale to about
  3.5x while x264 lanes stop at about 2x.
- **Rendering ProRes first and transcoding it once does not help.** At 2048² that would be about 9.5 fps render plus
  a 15 fps x264 pass, about 5.8 fps overall: the same as x264 lanes directly.
- **The sink's `--queue` made no measurable difference here** (1024², 4 lanes, two runs each: 20.7–20.8 fps with `--queue 0`, 20.7–21.2 with 8). ffmpeg's input threads and x264's
  lookahead already buffer frames ahead of the encoder.
- **2048², first 8 s of the act, 4 lanes, x264:** 240 frames at 5.6 fps, 46 s wall time including the dev server and
  the probe. This opening is mostly black and may be cheaper than later beats. At this rate the whole 86 s act
  (2580 frames) would take about 8 min with x264 and about 4.5 min with ProRes.

## Verified

- First 4 s at 1024², 1 lane against 2, 4 and 6 lanes, encoded losslessly (`--crf 0`). Each joined file has
  `nb_frames` = 120, and every decoded frame's md5 equals the 1-lane render's frame at the same index. A copy shifted
  by one frame differs on every frame, so the check can fail. The 2-, 4- and 6-lane checks ran on commit `ab2289e`,
  and the 4-lane check ran again on the live tree (`4bbcb7a`).
- At the default crf 12, two encodes of the same frames give about 44 dB PSNR against each other, even on frames
  rendered identically. x264's decisions depend on its thread count and on where a clip starts. So use `--crf 0`
  when comparing renders.

## Known issue

A lane stalled at 0 frames twice in about 45 multi-lane runs (2048² ProRes with 4 lanes, and 1024² ProRes with 6).
The other lanes finished normally. Nine targeted retries did not reproduce it, and the cause is unknown. The 180 s
watchdog fails the render, so rerun it.
