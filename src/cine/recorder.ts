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
import { Vector2 } from 'three';
import type { GameLoop } from '../core/loop';
import { Capture } from './capture';
import type { Director } from './director';
import type { Shot } from './types';
import { shotDuration } from './types';
import { SHOTS } from './shotlist';

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
const PREROLL_DT = 5 / 60;

/**
 * `04-D-stern-chase-the-money-shot`.
 *
 * The ordinal is the shot's place in the FULL timeline, not in the run, so
 * re-rendering one shot on its own drops a file that still sorts into the edit
 * where it belongs — the whole point of shooting per-shot rather than as one
 * continuous take. Shared with the audio pass so a clip and its sound land on
 * the same name.
 */
export function clipName(shot: Shot): string {
  const ord = SHOTS.findIndex((s) => s.id === shot.id) + 1;
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
    this.capture = new Capture(o.renderer, Math.round(size.x), Math.round(size.y));
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
    this.capture.bind();
    this.bound = true;
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
      if (this.o.director.shotTime < 0) return; // keep settling
      this.phase = 'capture';
      this.o.loop.setFixedDt(1 / this.fps);
      this.report('capture');
      return; // capture starts on the NEXT rendered frame, at shot time 0
    }

    if (!this.bound) return;
    this.capture.unbind();
    this.bound = false;

    const index = this.frame;
    this.busy = true;
    this.o.loop.setFixedDt(0); // hold the world still across readback + write
    void this.capture
      .grab()
      .then((bytes) => {
        const h = hashBytes(bytes);
        if (h === this.lastHash && this.frame > 0) {
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
        this.lastHash = h;
        return this.postBytes(
          `frame?shot=${encodeURIComponent(this.clipName(shot))}` +
            `&n=${String(index).padStart(5, '0')}` +
            `&w=${this.capture.width}&h=${this.capture.height}`,
          bytes,
        );
      })
      .then(() => {
        this.busy = false;
        this.frame++;
        this.capturedTotal++;
        this.recent.push(Date.now());
        if (this.recent.length > 48) this.recent.shift();
        if (this.frame >= this.frames) {
          this.nextShot();
        } else {
          this.o.loop.setFixedDt(1 / this.fps);
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

  /**
   * `04-D-stern-chase.mp4`.
   *
   * The ordinal is the shot's place in the FULL timeline, not in this run, so
   * re-rendering one shot on its own drops a file that still sorts into the
   * edit where it belongs — which is the whole point of shooting per-shot
   * rather than as one continuous take.
   */
  private clipName(shot: Shot): string {
    const ord = SHOTS.findIndex((s) => s.id === shot.id) + 1;
    const slug = shot.slug
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32);
    return `${String(ord).padStart(2, '0')}-${shot.id}-${slug}`;
  }

  /* -------------------------------------------------------------- */

  private nextShot(): void {
    // tell the sink the shot that just finished is complete, so it closes that
    // encoder and the clip becomes a playable file NOW rather than at the end
    // of the run — see closeEncoder in scripts/cine-sink.mjs for what holding
    // them all open cost
    const finished = this.shot;
    if (finished !== null && this.frame > 0) {
      void this.post(
        `endshot?clip=${encodeURIComponent(this.clipName(finished))}`,
        '',
        'text/plain',
      ).catch(() => undefined);
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
    this.lastHash = 0;
    this.repeats = 0;
    // A dissolve needs the OUTGOING shot to keep running under the incoming
    // one. There is one camera, so the overlap cannot be rendered in a single
    // pass — the tail is rendered here as handle frames and ffmpeg does the
    // mix (scripts/cine-mux.mjs).
    const handle = shot.transition === 'dissolve' ? (shot.transitionSeconds ?? 1) : 0;
    this.frames = Math.round((shotDuration(shot) + handle) * this.fps);
    this.phase = 'preroll';
    this.busy = false;
    this.o.director.cue(shot, -(shot.preroll ?? 6));
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
      const s = this.shots[i] as Shot;
      const handle = s.transition === 'dissolve' ? (s.transitionSeconds ?? 1) : 0;
      left += Math.round((shotDuration(s) + handle) * this.fps);
    }
    return left;
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
        frames: Math.round(
          (shotDuration(s) +
            (s.transition === 'dissolve' ? (s.transitionSeconds ?? 1) : 0)) *
            this.fps,
        ),
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
