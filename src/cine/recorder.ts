/**
 * Frame recorder. Renders the shot list to a PNG sequence, deterministically.
 *
 * THE PROBLEM IT SOLVES. A rAF-timed capture is timed by the machine: the
 * world advances by however long the last GPU frame took, so the same script
 * renders differently on a loaded box, and a slow canvas readback silently
 * eats scene time. So the recorder owns the clock:
 *
 *   advance exactly 1/fps  ->  render  ->  grab the canvas  ->  FREEZE (dt 0)
 *   while the PNG is in flight  ->  unfreeze  ->  advance exactly 1/fps
 *
 * Freezing with `dt = 0` rather than by stopping the loop is deliberate: rAF
 * has to keep turning across the readback because three's Animation module
 * bumps `nodeFrame.frameId` from its own rAF, and post re-composites a STALE
 * scene texture if that stops (docs/agent-browser-harness.md §3).
 *
 * Pixels come from our own render target as raw RGBA and go straight to the
 * sink; nothing is encoded in the browser (capture.ts says why both of the
 * obvious alternatives fail). Frames are still hashed and three identical ones
 * in a row abort the run: a recorder that cannot tell a dead readback from a
 * still shot is worthless.
 */
import type * as THREE from 'three/webgpu';
import { Vector2, type PerspectiveCamera } from 'three';
import type { GameLoop } from '../core/loop';
import { Capture } from './capture';
import type { Director } from './director';
import type { Shot } from './types';
import { shotDuration, shotHead, shotTail } from './types';

export interface RecorderOpts {
  renderer: THREE.WebGPURenderer;
  canvas: HTMLCanvasElement;
  loop: GameLoop;
  director: Director;
  /** frames per second of the OUTPUT, not of the display */
  fps?: number;
  /** where frames are POSTed; see scripts/cine-sink.mjs */
  sink?: string;
  /** shots to render, in order. Omit for the whole list. */
  shots: readonly Shot[];
  /** the file name a shot's clip (and its sound) is written under — see `clipName` */
  clipName: (shot: Shot) => string;
  /** called on every state change, for the on-screen readout */
  onProgress?: (p: Progress) => void;
  /**
   * Called exactly once when the run ends — completed, failed or stopped.
   *
   * The recorder can only put its OWN state back; everything else a shoot
   * changed (the render size, the pump, the hidden UI, the grade mode, the
   * weather lock) is owned by the caller. Without this the last shot finished
   * and the session just stayed in shooting state forever: canvas frozen, UI
   * gone, still rendering at 1920x1080, HUD still reading "REC".
   */
  onFinished?: (ok: boolean) => void;
  /**
   * SUPERSAMPLING (capture.ts `Accumulator`): draw every output frame this many times with the world frozen and the
   * projection jittered by a sub-pixel Halton offset, and write the mean. Omitted = the original single-sample capture.
   * Needs `camera` (the one the director drives). Jitter only — the subframes share one instant, so there is no motion
   * blur: a shutter would need the sim stepped between subframes.
   */
  samples?: number;
  camera?: PerspectiveCamera;
  /**
   * LOOK VARIANTS of a shot (cine/index.ts `looks`): each output frame is drawn once per look, from the SAME simulated
   * instant — the world is frozen (dt 0) while `apply()` rewrites the sky/grade/lights and the next look is drawn and
   * grabbed, and look 0 is put back before the sim advances. Every look goes to its own clip. The poses, the camera and
   * the jitter are therefore identical across looks by construction, not by a deterministic re-run (which this engine
   * does not give: two takes of one shot drift by centimetres, doc §Variants). Omitted / null = one look, `clipName`.
   */
  looks?: (shot: Shot) => readonly RecordLook[] | null;
  /**
   * MOTION BLUR: the shutter angle (deg) the `samples` subframes are spread over — 180 = half of 1/fps. The world is
   * stepped between subframes (the loop's accumulator: boats and camera interpolate between fixed ticks at each
   * subframe time), and the next frame starts exactly 1/fps after this one. Needs `samples` > 1. 0 / omitted = jitter
   * only. What moves inside the shutter: everything the render interpolates or the director advances (boats, pilots,
   * camera, dampers); what does NOT: state stepped only on the 1/60 s sim tick (sea surface time, wake, foam, spray),
   * which a 1/60 s shutter samples at the one or two tick states that fall inside it.
   */
  shutter?: number;
  /** the settings key a finished clip is recorded under at the sink (resumable records, cine/index.ts `resume`) */
  settingsKey?: (shot: Shot) => string;
  /** a shot was cued at shot time `t` (the run's coverage cameras cue with it) */
  onCue?: (shot: Shot, t: number) => void;
  /** per captured frame (look 0): null = fine, else why this take is broken (the recorder fails the shot) */
  healthy?: (shot: Shot, frame: number) => string | null;
}

export interface RecordLook {
  /** the clip this look's frames are written to */
  clip: string;
  /** which of the run's cameras draws it (cine/index.ts `cameras`): 0 = the shot's own lens */
  camera?: number;
  /** rewrite the world for this look (render path; no tick runs until the frame's last look is grabbed) */
  apply(): void;
}

/** radical inverse, base b: the Halton sequence the jitter walks (index 1.., so subframe 0 is not the pixel centre) */
export function halton(index: number, base: number): number {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

export interface Progress {
  phase: 'idle' | 'preroll' | 'capture' | 'done' | 'failed';
  shotId: string;
  shotIndex: number;
  shotCount: number;
  frame: number;
  frames: number;
  /** seconds since the run started */
  elapsed: number;
  /** frames per second of RENDER — nothing to do with the output frame rate */
  renderFps: number;
  /** seconds left across every shot still to shoot, or null before a rate exists */
  eta: number | null;
  message?: string;
}

/** coarse dt for settling: MAX_SUBSTEPS * SIM_DT, the most one rAF can carry */
export const PREROLL_DT = 5 / 60;

/**
 * `04-D-stern-chase-the-money-shot`.
 *
 * The ordinal is the shot's place in the FULL timeline (`timeline`), not in the
 * run, so re-rendering one shot on its own drops a file that still sorts into
 * the edit where it belongs — the whole point of shooting per-shot rather than
 * as one continuous take. Shared with the audio pass so a clip and its sound
 * land on the same name. A page with its own naming scheme passes its own.
 */
export function clipName(shot: Shot, timeline: readonly Shot[]): string {
  const ord = timeline.findIndex((s) => s.id === shot.id) + 1;
  const slug = shot.slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
  return `${String(ord).padStart(2, '0')}-${shot.id}-${slug}`;
}

/** cheap content hash over a stride of the frame — enough to catch a repeat */
function hashBytes(b: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i += 1013) {
    h ^= b[i] as number;
    h = Math.imul(h, 0x01000193);
  }
  h ^= b.length;
  return h >>> 0;
}

export class Recorder {
  private readonly fps: number;
  private readonly sink: string;
  private readonly shots: readonly Shot[];

  private shotIndex = -1;
  private shot: Shot | null = null;
  private frame = 0;
  private frames = 0;
  private phase: Progress['phase'] = 'idle';
  private busy = false;
  private lastHash = 0;
  private repeats = 0;
  private failure = '';
  /** per-shot faults; the run survives these and lists them at the end */
  private failed: string[] = [];
  private bound = false;
  private readonly capture: Capture;
  /** subframes per output frame (1 without supersampling) and the one being drawn */
  private readonly samples: number;
  private sub = 0;
  /** the shot's looks (one without variants) and the one being drawn */
  private looks: readonly RecordLook[] = [];
  private look = 0;
  /**
   * Wall-clock accounting. An offline render is measured in FRAMES PER MINUTE
   * and takes hours, so "is it working" and "how long" are the two questions
   * anyone actually has, and neither is answerable from a frozen canvas.
   * `recent` is a short window so the rate reacts when a shot gets heavier
   * rather than being flattened by an hour of history.
   */
  private startedAt = 0;
  private capturedTotal = 0;
  private recent: number[] = [];

  constructor(private o: RecorderOpts) {
    this.fps = o.fps ?? 24;
    this.sink = o.sink ?? 'http://127.0.0.1:7654';
    this.shots = o.shots;
    // the DRAWING BUFFER, not the canvas attribute and not the CSS box:
    // `setSize` multiplies by the device pixel ratio, so a 1920x1080 request
    // on a retina display leaves `canvas.width` at 3840 and a capture sized
    // from the element would read back a quarter of the frame
    const size = o.renderer.getDrawingBufferSize(new Vector2());
    const ss = o.samples !== undefined && o.camera !== undefined ? Math.max(1, Math.round(o.samples)) : undefined;
    this.samples = ss ?? 1;
    this.capture = new Capture(o.renderer, Math.round(size.x), Math.round(size.y), ss);
  }

  get running(): boolean {
    return this.phase === 'preroll' || this.phase === 'capture';
  }

  /**
   * True while a captured frame is still being read back and encoded.
   *
   * The world is frozen at `dt = 0` through that window, so every rAF in it
   * would draw a full 1080p frame that is bit-identical to the one already in
   * hand and then throw it away. At several seconds per encode that is most of
   * the render's GPU time spent on frames nobody will ever see — it pegs the
   * machine, and it is why the page looks hung rather than busy. Skipping the
   * draw is safe precisely because nothing moved: `Capture.bind` bumps the
   * node-frame id itself, so post does not depend on a draw happening here.
   */
  get idleFrame(): boolean {
    return this.running && this.busy;
  }

  /**
   * True while a shot's preroll is being fast-forwarded: nothing of it is captured, so it need not be drawn (USER: the
   * unrecorded run-up to steady speed must not cost full-quality frames). The render path still runs — camera dampers,
   * boat interpolation, sea and wake updates — only the draw is skipped.
   */
  get prerolling(): boolean {
    return this.phase === 'preroll';
  }

  async start(): Promise<void> {
    this.startedAt = Date.now();
    this.capturedTotal = 0;
    this.recent = [];
    await this.post('manifest', JSON.stringify(this.manifest()), 'application/json');
    this.shotIndex = -1;
    this.nextShot();
  }

  stop(reason = 'stopped'): void {
    if (this.phase === 'done' || this.phase === 'failed') return; // once only
    this.phase = this.failure === '' ? 'done' : 'failed';
    if (this.bound) {
      // the canvas must get its target back even when we are bailing out, or
      // the game renders into a disposed RT for the rest of the session
      this.capture.unbind();
      this.bound = false;
    }
    if (this.samples > 1) this.o.camera?.clearViewOffset();
    this.sub = 0;
    if (this.look !== 0) this.looks[0]?.apply(); // never leave the world in a variant's sky
    this.look = 0;
    this.capture.dispose();
    this.o.loop.setFixedDt(null);
    this.o.director.release();
    this.report(reason);
    this.o.onFinished?.(this.failure === '');
  }

  /**
   * Called immediately BEFORE the frame is drawn. Aims this frame at our own
   * target so the pixels never depend on the canvas being composited. The
   * canvas therefore does not update while a capture frame is in flight —
   * a recording session looks frozen on screen, and is not.
   */
  beforeRender(): void {
    if (!this.running || this.busy || this.phase !== 'capture') return;
    this.capture.bind(this.look);
    this.bound = true;
    const cam = this.o.camera;
    if (this.samples > 1 && cam !== undefined) {
      // a sub-pixel shift of the whole projection, AFTER the director's camera is final for this frame
      const w = this.capture.width;
      const h = this.capture.height;
      cam.setViewOffset(w, h, halton(this.sub + 1, 2) - 0.5, halton(this.sub + 1, 3) - 0.5, w, h);
    }
  }

  /**
   * Called at the very end of the render callback, after post has composited.
   * Everything the recorder does happens here so that "the frame on the canvas"
   * and "the frame we are about to grab" cannot get out of step.
   */
  afterRender(): void {
    if (!this.running || this.busy) return;
    const shot = this.shot;
    if (shot === null) return;

    if (this.phase === 'preroll') {
      // LAND ON THE FIRST FRAME EXACTLY. Coarse preroll steps overshoot the
      // take's start by up to PREROLL_DT, which puts every clip a few frames
      // late and — with a head handle — moves the cut point the editor was
      // promised. The last step is shortened to hit it.
      const gap = -shotHead(shot) - this.o.director.shotTime;
      if (gap > 1e-9) {
        this.o.loop.setFixedDt(Math.min(PREROLL_DT, gap));
        return; // keep settling
      }
      this.phase = 'capture';
      this.o.loop.setFixedDt(0); // frame 0 is drawn AT the first frame time
      this.report('capture');
      return; // capture starts on the NEXT rendered frame
    }

    if (!this.bound) return;
    this.capture.unbind();
    this.bound = false;
    const K = this.looks.length;
    if (this.o.samples !== undefined && this.o.camera !== undefined) {
      // SUPERSAMPLED: every subframe draws every look at the same instant (dt 0 between looks); subframes are spread
      // over the shutter (motion blur) or share one instant (jitter only)
      if (this.samples > 1) this.o.camera.clearViewOffset();
      this.capture.accumulate(this.sub === 0, this.look);
      if (this.look + 1 < K) {
        this.look++;
        (this.looks[this.look] as RecordLook).apply();
        this.o.loop.setFixedDt(0);
        return;
      }
      if (K > 1) {
        this.look = 0;
        (this.looks[0] as RecordLook).apply();
      }
      this.sub++;
      if (this.sub < this.samples) {
        this.o.loop.setFixedDt(this.shutterStep); // 0 without motion blur: the next subframe is the same instant
        return;
      }
      this.sub = 0;
      for (let k = 0; k < K; k++) this.capture.resolve(this.samples, k);
      this.writeFrame(shot, 0, true);
      return;
    }
    this.writeFrame(shot, this.look, false);
  }

  /** subframe spacing (s) when the shutter is open: the shutter angle's share of a frame, split over the subframes */
  private get shutterStep(): number {
    const deg = Math.max(0, Math.min(360, this.o.shutter ?? 0));
    return this.samples > 1 && deg > 0 ? deg / 360 / this.fps / this.samples : 0;
  }

  /**
   * Grab look `look` of the frame, post it, then: the next look (resolved: straight on; single-sample: draw it first),
   * or the next frame. The world is frozen (dt 0) for the whole chain; the next frame's advance is 1/fps minus the
   * time the shutter already moved it, so frames stay exactly 1/fps apart.
   */
  private writeFrame(shot: Shot, look: number, resolved: boolean): void {
    const index = this.frame;
    const clip = (this.looks[look] as RecordLook).clip;
    this.busy = true;
    this.o.loop.setFixedDt(0); // hold the world still across readback + write
    void this.capture
      .grab(look)
      .then((bytes) => {
        // a take whose world did not apply or whose GPU errored is not the take: fail it loudly (host check)
        const unhealthy = look === 0 ? this.o.healthy?.(shot, index) : null;
        if (unhealthy) throw new Error(unhealthy);
        const h = hashBytes(bytes);
        if (look > 0) {
          // a variant's frame is a different picture of the same instant: the repeat guard watches look 0 only
        } else if (h === this.lastHash && this.frame > 0) {
          this.repeats++;
          // TOLERANCE, not zero tolerance. Three identical frames is NOT proof
          // of a dead readback: the extreme-high shot is a near-black frame
          // with a two-pixel light in it, and at 1/24 s of a 600 m-high camera
          // consecutive frames really are byte-identical once quantised to
          // 8 bits. That guard aborted a legitimate shot — and with it the six
          // shots queued behind it. Two full seconds of a frozen image is the
          // threshold that still means "the readback stopped" and no longer
          // means "the picture is very dark and very still". The frame is
          // WRITTEN either way; a duplicate frame in a video is nothing.
          if (this.repeats > this.fps * 2) {
            throw new Error(
              `${shot.id} frame ${this.frame}: the readback has returned the same ` +
                `bytes for ${this.repeats} frames (${(this.repeats / this.fps).toFixed(1)}s). ` +
                `That is a dead readback, not a still shot ` +
                `(docs/agent-browser-harness.md §2).`,
            );
          }
        } else {
          this.repeats = 0;
        }
        if (look === 0) this.lastHash = h;
        return this.postBytes(
          `frame?shot=${encodeURIComponent(clip)}&group=${encodeURIComponent((this.looks[0] as RecordLook).clip)}` +
            `&n=${String(index).padStart(5, '0')}` +
            `&w=${this.capture.width}&h=${this.capture.height}`,
          bytes,
        );
      })
      .then(() => {
        this.busy = false;
        if (look + 1 < this.looks.length) {
          if (resolved) {
            this.writeFrame(shot, look + 1, true); // already accumulated: grab the next look now
            return;
          }
          // single-sample: draw the same instant again under the next look
          this.look = look + 1;
          (this.looks[this.look] as RecordLook).apply();
          this.o.loop.setFixedDt(0);
          return;
        }
        if (!resolved && this.looks.length > 1) {
          this.look = 0;
          (this.looks[0] as RecordLook).apply(); // look 0 before the sim advances (the tick re-applies it anyway)
        }
        this.frame++;
        this.capturedTotal++;
        this.recent.push(Date.now());
        if (this.recent.length > 48) this.recent.shift();
        if (this.frame >= this.frames) {
          this.nextShot();
        } else {
          this.o.loop.setFixedDt(1 / this.fps - this.shutterStep * (this.samples - 1));
          // every frame: the on-screen readout is the only sign of life a
          // shoot gives, and once a second is a long time to look hung
          this.report('capture');
        }
      })
      .catch((e: unknown) => {
        this.busy = false;
        const msg = String(e instanceof Error ? e.message : e);
        // a sink that is gone takes every remaining shot with it, so that one
        // IS fatal; anything else is this shot's problem alone
        if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
          this.fail(`the sink is unreachable — ${msg}`);
        } else {
          this.failShot(msg);
        }
      });
  }

  private clipName(shot: Shot): string {
    return this.o.clipName(shot);
  }

  /* -------------------------------------------------------------- */

  private nextShot(): void {
    // tell the sink the shot that just finished is complete, so it closes that
    // encoder and the clip becomes a playable file NOW rather than at the end
    // of the run — see closeEncoder in scripts/cine-sink.mjs for what holding
    // them all open cost
    const finished = this.shot;
    if (finished !== null && this.frame > 0) {
      const key = this.o.settingsKey?.(finished);
      for (const l of this.looks) {
        const k = key !== undefined ? `&key=${encodeURIComponent(key)}` : '';
        // the frame count lets the sink refuse a short take (it writes it as _FAILED, never as a valid clip)
        void this.post(`endshot?clip=${encodeURIComponent(l.clip)}${k}&frames=${this.frames}`, '', 'text/plain').catch(() => undefined);
      }
    }
    this.shotIndex++;
    if (this.shotIndex >= this.shots.length) {
      void this.post('done', JSON.stringify(this.manifest()), 'application/json');
      if (this.failed.length > 0) {
        console.error(
          `[cine] finished with ${this.failed.length} failed shot(s):\n  ` +
            this.failed.join('\n  '),
        );
      }
      this.stop(
        this.failed.length > 0 ? `done, ${this.failed.length} shot(s) failed` : 'done',
      );
      return;
    }
    const shot = this.shots[this.shotIndex] as Shot;
    this.shot = shot;
    this.frame = 0;
    this.sub = 0;
    this.look = 0;
    const looks = this.o.looks?.(shot) ?? null;
    this.looks = looks !== null && looks.length > 0 ? looks : [{ clip: this.clipName(shot), apply: () => undefined }];
    this.lastHash = 0;
    this.repeats = 0;
    // A dissolve needs the OUTGOING shot to keep running under the incoming
    // one. There is one camera, so the overlap cannot be rendered in a single
    // pass — the tail is rendered here as handle frames and ffmpeg does the
    // mix (scripts/cine-mux.mjs). An edit handle (`shot.handle`) adds footage
    // on both sides for an editor cutting to music.
    this.frames = this.takeFrames(shot);
    this.phase = 'preroll';
    this.busy = false;
    this.o.director.cue(shot, -(shot.preroll ?? 6));
    this.o.onCue?.(shot, -(shot.preroll ?? 6));
    this.o.loop.setFixedDt(PREROLL_DT);
    this.report('preroll');
  }

  /**
   * One shot failing is not the run failing.
   *
   * A dead readback, a sink hiccup or a bad frame used to abort everything —
   * so a fault on shot 18 of 23 threw away the five that had not been shot
   * yet, after eight minutes of rendering. Each shot is an independent take
   * written to its own file, so the only sane response is to note it, drop
   * that shot, and go on to the next one. The run reports what it lost at the
   * end rather than pretending it finished.
   */
  private failShot(message: string): void {
    const id = this.shot?.id ?? '?';
    this.failed.push(`${id}: ${message}`);
    console.error(`[cine] ${id} FAILED — ${message}. Continuing with the next shot.`);
    // close its clips at the sink AS FAILED, before nextShot() cues the next one
    for (const l of this.looks) {
      void this.post(`endshot?clip=${encodeURIComponent(l.clip)}&failed=${encodeURIComponent(message.slice(0, 200))}`, '', 'text/plain').catch(() => undefined);
    }
    this.frame = 0; // nextShot must not also send a normal endshot for these clips
    this.busy = false;
    this.bound = false;
    this.nextShot();
  }

  /** unrecoverable — the run itself cannot continue */
  private fail(message: string): void {
    this.failure = message;
    console.error(`[cine] ${message}`);
    this.stop(message);
  }

  /** frames/s over the recent window, 0 until two frames exist */
  private rate(): number {
    if (this.recent.length < 2) return 0;
    const span = (this.recent[this.recent.length - 1] as number) - (this.recent[0] as number);
    return span > 0 ? ((this.recent.length - 1) / span) * 1000 : 0;
  }

  /** frames still to shoot across THIS RUN, including shots not started yet */
  private framesLeft(): number {
    let left = Math.max(this.frames - this.frame, 0);
    for (let i = this.shotIndex + 1; i < this.shots.length; i++) {
      left += this.takeFrames(this.shots[i] as Shot);
    }
    return left;
  }

  /** frames in one take: head handle + the shot + tail (handle, dissolve overlap) */
  private takeFrames(s: Shot): number {
    return Math.round((shotHead(s) + shotDuration(s) + shotTail(s)) * this.fps);
  }

  private report(message: string): void {
    const r = this.rate();
    this.o.onProgress?.({
      phase: this.phase,
      shotId: this.shot?.id ?? '-',
      shotIndex: this.shotIndex,
      shotCount: this.shots.length,
      frame: this.frame,
      frames: this.frames,
      elapsed: this.startedAt === 0 ? 0 : (Date.now() - this.startedAt) / 1000,
      renderFps: r,
      eta: r > 0 ? this.framesLeft() / r : null,
      message,
    });
  }

  private manifest(): unknown {
    return {
      fps: this.fps,
      width: this.capture.width,
      height: this.capture.height,
      shots: this.shots.map((s) => ({
        id: s.id,
        clip: this.clipName(s),
        slug: s.slug,
        in: s.in,
        out: s.out,
        duration: shotDuration(s),
        transition: s.transition,
        transitionSeconds: s.transitionSeconds ?? 0,
        handle: s.handle ?? 0,
        frames: this.takeFrames(s),
      })),
    };
  }

  /** raw frame bytes — no base64, no encode, 8 MB of RGBA straight down the wire */
  private async postBytes(path: string, body: Uint8Array): Promise<void> {
    const res = await fetch(`${this.sink}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: body as unknown as BodyInit,
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  }

  private async post(path: string, body: string, type: string): Promise<void> {
    const res = await fetch(`${this.sink}/${path}`, {
      method: 'POST',
      headers: { 'content-type': type },
      body,
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  }
}
