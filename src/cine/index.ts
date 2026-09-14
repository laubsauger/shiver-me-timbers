/**
 * Cinematic system entry — a shot list, the director and the recorder wired
 * to one handle that a page calls from three places (see the INTEGRATION
 * block below). MODE-AGNOSTIC: the page hands in its shot list and its
 * DirectorHost; the pirate piece is the default list, the speedboat trailer
 * passes its own (src/speedboat/cine). Inert until `play()` or `record()`; when inert every hook is a
 * single null check, so the normal game frame is unaffected.
 *
 * INTEGRATION (src/main.ts):
 *
 *   // inside the fixed sim tick, AFTER oceanAmbient.publish(...) — the world
 *   // is written there because the ambient hold rewrites oceanParams every
 *   // tick and would clobber anything set from the render path
 *   cine.applyWorld();
 *
 *   // in the render callback, AFTER combat.shake.apply(app.camera) — the last
 *   // writer of the camera wins, and everything camera-derived (clouds,
 *   // surface, underwater, gunnery) already sits below this line
 *   cine.applyCamera(frameDt);
 *
 *   // at the very END of the render callback, after post.render()/app.render()
 *   cine.afterRender();
 *
 * FROM THE CONSOLE:
 *
 *   __game.cine.play()            // preview the whole piece at wall clock
 *   __game.cine.play('D')         // preview one shot, looping
 *   __game.cine.record()          // render every shot to the sink
 *   __game.cine.record({ only: ['H1', 'D', 'M', 'O'] })   // the build-order set
 *   __game.cine.stop()
 *
 * `?cine=record` / `?cine=play` on the URL does the same at boot.
 */
import type { PerspectiveCamera } from 'three';
import type * as THREE from 'three/webgpu';
import type { GameLoop } from '../core/loop';
import { Director, type DirectorHost } from './director';
import { PREROLL_DT, Recorder, clipName, type Progress } from './recorder';
import { ShotAudio, type CineAudioSource } from './audio';
import { startPump, type Pump } from './pump';
import { applyGradeMode, type GradeMode } from '../grade';
import { GLOBAL_WORLD, SHOTS, TIMELINE_END } from './shotlist';
import type { Shot, WorldPatch } from './types';
import { shotDuration, shotHead, shotTail } from './types';

export type { Shot, ShotKey, WorldPatch } from './types';
export { SHOTS, TIMELINE_END, shotById } from './shotlist';
export { Director, type DirectorHost, type ShipPose } from './director';
export { Recorder, clipName, type Progress } from './recorder';
export type { CineAudioSource } from './audio';

export interface CineOpts {
  /**
   * Whether the world was BUILT on the open-ocean stage (src/cine/stage.ts).
   * It is a boot-time choice, so a console `record()` on a normal world cannot
   * fix it — it can only say so, which is what it does. Pages whose shots WANT
   * land (the speedboat trailer) leave it out.
   */
  openOcean?: boolean;
  renderer: THREE.WebGPURenderer;
  canvas: HTMLCanvasElement;
  camera: PerspectiveCamera;
  loop: GameLoop;
  host: DirectorHost;
  /** for the second, real-time pass that records SFX + ambience */
  audio: CineAudioSource;
  /** the timeline, in order. Default: the pirate piece (./shotlist.ts). */
  shots?: readonly Shot[];
  /** the page's per-shot world default. Default: the pirate `GLOBAL_WORLD`. */
  global?: WorldPatch;
  /** clip file name. Default: `04-D-slug`, ordinal in `shots`. */
  clipName?: (shot: Shot) => string;
  /** record/recordAudio defaults, under whatever the call passes */
  defaults?: RecordOpts;
  /**
   * Run each shot's PREROLL in preview too (fast-forwarded, like a render).
   * A page whose hero is choreographed per shot needs it: without the preroll
   * the boat is still at her placement when the camera starts. Default false —
   * the pirate preview cues straight into the shot.
   */
  prerollPreview?: boolean;
  /**
   * An edit plan for the run, POSTed to the sink's `/plan` when a record or an
   * audio pass starts (docs/cine/trailer-edit-plan.md). The sink keeps only the
   * clips that exist on disk.
   */
  editPlan?: (run: { fps: number; width: number; height: number }) => unknown;
}

/**
 * Named output sizes. The renderer will do any width and height you ask for
 * (`width`/`height` below); these exist so the common ones are a word rather
 * than two numbers to get wrong.
 */
export const RESOLUTIONS = {
  '720p': [1280, 720],
  '1080p': [1920, 1080],
  '1440p': [2560, 1440],
  '2k': [2560, 1440],
  '4k': [3840, 2160],
} as const satisfies Record<string, readonly [number, number]>;

export type ResolutionName = keyof typeof RESOLUTIONS;

export interface RecordOpts {
  /** `'1080p'` (default), `'1440p'`/`'2k'`, `'4k'`, `'720p'` */
  res?: ResolutionName;
  /**
   * `'cine-flat'` (default) renders a CLEAN PLATE for grading elsewhere: no
   * grain, no vignette, no colour grade — only the optics that cannot be added
   * back later (DOF, bloom, god rays). `'cine'` bakes the shooting look in.
   */
  grade?: GradeMode;
  /** exact width in px; overrides `res` */
  width?: number;
  /** exact height in px; overrides `res` */
  height?: number;
  fps?: number;
  sink?: string;
  /** shot ids, in the order given. Omit for the whole list. */
  only?: readonly string[];
  /**
   * Drive rAF from a worker so the render survives a backgrounded tab
   * (src/cine/pump.ts). Default true — a 5000-frame render that dies the
   * moment you switch windows is not a render.
   */
  pump?: boolean;
  /** seconds without a captured frame before the run is declared stalled */
  stallSeconds?: number;
}

export interface CineHandle {
  applyWorld(): void;
  applyCamera(frameDt: number): void;
  /** aim this frame at the capture target — call just BEFORE the draw */
  beforeRender(): void;
  /**
   * True when this frame's draw can be skipped entirely: a captured frame is
   * in flight and the world is frozen behind it, so drawing again produces a
   * picture that is thrown away.
   */
  skipRender(): boolean;
  afterRender(): void;
  play(shotId?: string): void;
  record(opts?: RecordOpts): Promise<void>;
  /**
   * Second pass: play each shot at REAL speed and record the SFX + ambience
   * buses to a file beside its clip. Video cannot carry this — see
   * src/cine/audio.ts for why an offline render and an AudioContext cannot
   * share a clock.
   */
  recordAudio(opts?: RecordOpts): Promise<void>;
  stop(): void;
  readonly active: boolean;
  readonly shots: readonly Shot[];
  readonly director: Director;
  /** last progress report, for a HUD or a poll from outside the tab */
  readonly progress: Progress | null;
}

/** resolve `only` to shots, loudly — a typo'd id must not silently render less */
function pick(shots: readonly Shot[], only: readonly string[] | undefined): readonly Shot[] {
  if (only === undefined) return shots;
  return only.map((id) => {
    const s = shots.find((x) => x.id === id);
    if (s === undefined) {
      throw new Error(
        `cine: no shot "${id}". Have: ${shots.map((x) => x.id).join(', ')}`,
      );
    }
    return s;
  });
}

export function createCine(o: CineOpts): CineHandle {
  const SHOTLIST = o.shots ?? SHOTS;
  const END = o.shots === undefined ? TIMELINE_END : Math.max(...SHOTLIST.map((s) => s.out));
  const nameOf = o.clipName ?? ((s: Shot): string => clipName(s, SHOTLIST));
  const director = new Director(o.host, o.global ?? GLOBAL_WORLD);
  let recorder: Recorder | null = null;
  let pump: Pump | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  /** live-preview timeline clock, seconds; null when not previewing */
  let previewT: number | null = null;
  /** the real-time audio pass drives the director itself */
  let audioPass = false;
  let previewLoop: Shot | null = null;
  /** `prerollPreview` timeline: the shot being previewed, by index */
  let previewSeq: number | null = null;
  /** `prerollPreview`: fast-forwarding the current shot's preroll */
  let previewSettling = false;
  let progress: Progress | null = null;

  /** preview cue with the preroll run fast, as a render would */
  const cueSettled = (s: Shot): void => {
    director.cue(s, -(s.preroll ?? 6));
    previewSettling = true;
    o.loop.setFixedDt(PREROLL_DT);
  };

  const cueForTimeline = (t: number): void => {
    const s = SHOTLIST.find((x) => t >= x.in && t < x.out) ?? SHOTLIST[SHOTLIST.length - 1];
    if (s === undefined) return;
    if (director.current?.id !== s.id) director.cue(s, t - s.in);
    else director.advance(0);
  };

  /**
   * Put back everything a shoot changed OUTSIDE the recorder. Idempotent, and
   * reached from two directions: the user calling `stop()`, and the recorder
   * finishing on its own — which is the path that was missing, so a completed
   * run left the session shooting forever.
   */
  const teardown = (): void => {
    if (watchdog !== null) {
      clearInterval(watchdog);
      watchdog = null;
    }
    pump?.stop();
    pump = null;
    o.host.restoreRenderSize();
    o.host.setShooting(false);
    previewT = null;
    previewLoop = null;
    previewSeq = null;
    previewSettling = false;
    director.release();
    // LAST: hand the game back the world it was in before the shoot
    director.restoreWorld();
    o.loop.setFixedDt(null);
  };

  const stop = (): void => {
    const r = recorder;
    recorder = null;
    r?.stop();
    teardown();
  };

  return {
    get active(): boolean {
      return director.active;
    },
    get shots(): readonly Shot[] {
      return SHOTLIST;
    },
    get director(): Director {
      return director;
    },
    get progress(): Progress | null {
      return progress;
    },

    applyWorld(): void {
      director.applyWorld();
    },

    applyCamera(frameDt: number): void {
      if (!director.active) return;
      // the recorder owns the clock while recording; preview runs on the frame
      if (recorder !== null || audioPass) {
        director.advance(frameDt);
      } else if (o.prerollPreview === true && (previewLoop !== null || previewSeq !== null)) {
        director.advance(frameDt);
        if (previewSettling && director.shotTime >= 0) {
          previewSettling = false;
          o.loop.setFixedDt(null);
        }
        const cur = director.current;
        if (cur !== null && director.shotTime >= shotDuration(cur)) {
          if (previewLoop !== null) cueSettled(previewLoop);
          else if (previewSeq !== null) {
            previewSeq = (previewSeq + 1) % SHOTLIST.length;
            cueSettled(SHOTLIST[previewSeq] as Shot);
          }
        }
      } else if (previewLoop !== null) {
        director.advance(frameDt);
        if (director.shotTime >= shotDuration(previewLoop)) director.cue(previewLoop, 0);
      } else if (previewT !== null) {
        previewT += frameDt;
        if (previewT >= END) previewT = 0;
        cueForTimeline(previewT);
        director.advance(frameDt);
      }
      director.applyCamera(o.camera);
    },

    beforeRender(): void {
      recorder?.beforeRender();
    },

    skipRender(): boolean {
      return recorder?.idleFrame ?? false;
    },

    afterRender(): void {
      recorder?.afterRender();
    },

    play(shotId?: string): void {
      stop();
      director.snapshotWorld();
      o.host.setShooting(true);
      if (shotId === undefined) {
        if (o.prerollPreview === true) {
          previewSeq = 0;
          cueSettled(SHOTLIST[0] as Shot);
          return;
        }
        previewT = 0;
        cueForTimeline(0);
        return;
      }
      const s = pick(SHOTLIST, [shotId])[0] as Shot;
      previewLoop = s;
      if (o.prerollPreview === true) cueSettled(s);
      else director.cue(s, 0);
    },

    async record(callOpts: RecordOpts = {}): Promise<void> {
      stop();
      const opts: RecordOpts = { ...o.defaults, ...callOpts };
      const shots = pick(SHOTLIST, opts.only);
      if (o.openOcean === false) {
        console.warn(
          '[cine] this world was built WITH LAND. The islands and their group ' +
            'are hidden for the shoot, but the seabed underneath them still ' +
            'shoals the sea and grounds the hull. Reload with ?cine=record (or ' +
            '?stage=open-ocean) for a world that has no land in it at all.',
        );
      }
      director.snapshotWorld();
      o.host.setShooting(true);
      // AFTER setShooting, which puts the session in 'cine' — a render defaults
      // to the flat plate instead, so the grade stays a decision made later
      applyGradeMode(opts.grade ?? 'cine-flat');
      const [rw, rh] = RESOLUTIONS[opts.res ?? '1080p'];
      o.host.setRenderSize(opts.width ?? rw, opts.height ?? rh);
      const sink = opts.sink ?? 'http://127.0.0.1:7654';
      if (o.editPlan !== undefined) {
        await postPlan(sink, o.editPlan({ fps: opts.fps ?? 24, width: opts.width ?? rw, height: opts.height ?? rh }));
      }
      if (opts.pump !== false) {
        pump = startPump(60);
        // The app's pending rAF callback is held by the REAL rAF, which is
        // already throttled to nothing in a hidden tab — patching rAF cannot
        // reach it. Restarting the loop is what puts a callback into the
        // pump's queue and reconnects the chain.
        o.loop.stop();
        o.loop.start();
      }
      recorder = new Recorder({
        renderer: o.renderer,
        canvas: o.canvas,
        loop: o.loop,
        director,
        fps: opts.fps,
        sink: opts.sink,
        shots,
        clipName: nameOf,
        onFinished: () => {
          recorder = null;
          teardown();
        },
        onProgress: (p) => {
          progress = p;
          // the console line is per shot-phase, not per frame: the HUD is the
          // live readout, and a line a frame is 5760 lines
          if (p.phase !== 'capture' || p.frame === 0) {
            console.info(
              `[cine] ${p.shotIndex + 1}/${p.shotCount} ${p.shotId} ${p.phase} ${p.message ?? ''}`,
            );
          }
        },
      });
      await recorder.start();

      // A stall here is silent by construction: no error is thrown, the loop
      // simply stops being called. Say so rather than leaving a half-written
      // directory that looks like a finished render.
      const stallMs = (opts.stallSeconds ?? 30) * 1000;
      let seen = -1;
      let since = Date.now();
      watchdog = setInterval(() => {
        const p = progress;
        if (p === null) return;
        const n = p.shotIndex * 1e6 + p.frame;
        if (n !== seen) {
          seen = n;
          since = Date.now();
          return;
        }
        if (Date.now() - since > stallMs) {
          console.error(
            `[cine] STALLED: no frame for ${Math.round((Date.now() - since) / 1000)}s ` +
              `at ${p.shotId} frame ${p.frame}/${p.frames}. ` +
              `Tab hidden with the pump off, or the sink is down.`,
          );
          since = Date.now();
        }
      }, 5000);
    },

    async recordAudio(callOpts: RecordOpts = {}): Promise<void> {
      const opts: RecordOpts = { ...o.defaults, ...callOpts };
      if (!ShotAudio.supported) throw new Error('cine: no MediaRecorder audio codec here');
      // A browser will not start an AudioContext without a gesture, and a page
      // opened straight from a URL has not had one. Fail here rather than per
      // shot: "recording started and nothing happened" is what that looks like.
      await o.audio.resume();
      stop();
      const shots = pick(SHOTLIST, opts.only);
      const sink = opts.sink ?? 'http://127.0.0.1:7654';
      if (o.editPlan !== undefined) {
        const [rw, rh] = RESOLUTIONS[opts.res ?? '1080p'];
        await postPlan(sink, o.editPlan({ fps: opts.fps ?? 24, width: opts.width ?? rw, height: opts.height ?? rh }));
      }
      director.snapshotWorld();
      o.host.setShooting(true);
      audioPass = true;
      // REAL TIME, explicitly: the whole point of this pass is that the
      // AudioContext's clock is the one that cannot be stepped
      o.loop.setFixedDt(null);
      try {
        // this pass runs in REAL TIME, so it takes as long as the film plus
        // every preroll — minutes with nothing on screen unless it says so
        const started = Date.now();
        const totalSec = shots.reduce(
          (a, sh) => a + shotHead(sh) + shotDuration(sh) + shotTail(sh) + (sh.preroll ?? 6),
          0,
        );
        let doneSec = 0;
        const say = (shot: Shot, i: number, phase: 'preroll' | 'capture'): void => {
          progress = {
            phase,
            shotId: shot.id,
            shotIndex: i,
            shotCount: shots.length,
            frame: Math.round(doneSec),
            frames: Math.round(totalSec),
            elapsed: (Date.now() - started) / 1000,
            renderFps: 1,
            eta: Math.max(totalSec - doneSec, 0),
            message: 'AUDIO pass — real time',
          };
        };
        for (const [i, shot] of shots.entries()) {
          director.cue(shot, -(shot.preroll ?? 6));
          // the SAME span the video take holds: head handle, shot, tail
          const head = shotHead(shot);
          const dur = head + shotDuration(shot) + shotTail(shot);
          console.info(
            `[cine:audio] ${shot.id} — ${(shot.preroll ?? 6).toFixed(0)}s preroll, ` +
              `${dur.toFixed(1)}s take`,
          );
          // the preroll runs at real speed too: the wake and the bed have to
          // settle in the SAME seconds the sound will be recorded over
          while (director.shotTime < -head) {
            say(shot, i, 'preroll');
            doneSec += 1 / 60;
            await frame();
          }
          const take = new ShotAudio(o.audio);
          await take.start();
          const until = performance.now() + dur * 1000;
          while (performance.now() < until) {
            say(shot, i, 'capture');
            doneSec += 1 / 60;
            await frame();
          }
          const t = await take.stop();
          const ext = t.mime.includes('ogg') ? 'ogg' : t.mime.includes('mp4') ? 'm4a' : 'webm';
          const res = await fetch(
            `${sink}/audio?clip=${encodeURIComponent(nameOf(shot))}&ext=${ext}&dur=${dur.toFixed(4)}`,
            { method: 'POST', headers: { 'content-type': t.mime }, body: t.blob },
          );
          if (!res.ok) throw new Error(`sink: ${res.status} ${res.statusText}`);
          console.info(`[cine:audio] ${shot.id} — ${t.seconds.toFixed(1)}s captured`);
        }
      } finally {
        audioPass = false;
        teardown();
      }
    },

    stop,
  };
}

/** the run's edit plan to the sink — loud, a plan that did not land is a timeline that will not build */
async function postPlan(sink: string, plan: unknown): Promise<void> {
  const res = await fetch(`${sink}/plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(plan),
  });
  if (!res.ok) throw new Error(`cine: sink /plan ${res.status} ${res.statusText}`);
}

/** one rendered frame — the audio pass paces itself on the display, not a timer */
const frame = (): Promise<void> =>
  new Promise((res) => requestAnimationFrame(() => res()));
