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
import { postParams } from '../params/post';
import type * as THREE from 'three/webgpu';
import type { GameLoop } from '../core/loop';
import { Director, type DirectorHost } from './director';
import { PREROLL_DT, Recorder, clipName, type Progress, type RecordLook } from './recorder';
import { ShotAudio, type CineAudioSource } from './audio';
import { startPump, type Pump } from './pump';
import { applyGradeMode, type GradeMode } from '../grade';
import { GLOBAL_WORLD, SHOTS, TIMELINE_END } from './shotlist';
import type { Shot, WorldPatch } from './types';
import { shotDuration, shotHead, shotTail } from './types';

export type { Shot, ShotKey, WorldPatch } from './types';
export { SHOTS, TIMELINE_END, shotById } from './shotlist';
export { Director, type DirectorHost, type ShipPose } from './director';
export { Recorder, clipName, type Progress, type RecordLook } from './recorder';
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
  editPlan?: (run: { fps: number; width: number; height: number }, opts: RecordOpts) => unknown;
  /**
   * LOOK VARIANTS a record run renders per shot (recorder.ts `looks`): every output frame drawn once per look from the
   * same simulated instant, each look to its own clip. Null / omitted = one clip per shot (`clipName`). The speedboat
   * trailer's time-of-day variants (docs/cine/speedboat-trailer-v1.md §Variants). The audio pass has no looks.
   */
  looks?: (shot: Shot, opts: RecordOpts) => readonly RecordLook[] | null;
  /**
   * RESUMABLE RECORDS: a key for everything a clip's pixels depend on (the shot's data, size, fps, samples, shutter,
   * grade, looks). The sink stores it beside each finished master; `record({ resume: true })` skips a shot whose clips
   * are all on disk under the same key, so a crash or a change to one shot does not re-render the rest.
   */
  settingsKey?: (shot: Shot, opts: RecordOpts) => string;
  /**
   * COVERAGE: the extra lenses a record run draws the SAME run through (camera 1..n; camera 0 is the shot itself). Each
   * is a Shot whose camera fields are read (frame, keys, follow, platform, rideSwell, aimShip, focusShip, wobble, …);
   * its world is not applied by the director — a look (`looks`) applies what it needs. Each camera gets its own
   * director, cued with the run and advanced on the same clock, so its dampers integrate every frame whether or not it
   * is the one being drawn; `RecordLook.camera` picks which one a look draws.
   */
  cameras?: (shot: Shot, opts: RecordOpts) => readonly Shot[] | null;
  /** per captured frame: null = healthy, else the reason the take is broken (recorder.ts `healthy`) */
  healthy?: (shot: Shot, frame: number) => string | null;
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
  /**
   * Supersampled anti-aliasing: subframes per output frame, each with a sub-pixel jitter, averaged in linear light
   * (recorder.ts / capture.ts). Omitted = the original single-sample capture.
   */
  samples?: number;
  /** motion blur: shutter angle in degrees over the `samples` subframes (180 = half a frame); 0 = jitter only */
  shutter?: number;
  /** skip shots whose clips the sink already has under the same settings key (needs `settingsKey`) */
  resume?: boolean;
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
  /** coverage cameras of the current record shot: their directors, scratch lenses and follow-focus distances */
  let cams: { director: Director; lens: PerspectiveCamera; focus: number }[] = [];
  /** the camera the next draw uses (0 = the shot's own) */
  let activeCam = 0;
  let mainFocus = 0;
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
    cams = [];
    activeCam = 0;
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
      const focusBefore = postParams.dofFocus;
      director.applyCamera(o.camera);
      if (cams.length > 0) {
        mainFocus = postParams.dofFocus;
        for (const c of cams) {
          c.director.advance(recorder !== null ? frameDt : 0);
          c.lens.aspect = o.camera.aspect;
          c.director.applyCamera(c.lens);
          // a camera without follow focus keeps the DOF its look applied (NaN = not this camera's to set)
          c.focus = c.director.current?.focusShip === true ? postParams.dofFocus : Number.NaN;
          postParams.dofFocus = mainFocus;
        }
        const pick = activeCam > 0 ? cams[activeCam - 1] : undefined;
        if (pick !== undefined) {
          o.camera.position.copy(pick.lens.position);
          o.camera.quaternion.copy(pick.lens.quaternion);
          if (o.camera.fov !== pick.lens.fov) {
            o.camera.fov = pick.lens.fov;
            o.camera.updateProjectionMatrix();
          }
          o.camera.updateMatrixWorld(true);
          postParams.dofFocus = Number.isFinite(pick.focus) ? pick.focus : focusBefore;
        }
      }
    },

    beforeRender(): void {
      recorder?.beforeRender();
    },

    skipRender(): boolean {
      // the audio pass does not use its picture (recordAudio): no draw keeps the sim on real time
      return (recorder?.idleFrame ?? false) || (recorder?.prerolling ?? false) || (recorder?.discardDraw ?? false) || audioPass;
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
      let shots = pick(SHOTLIST, opts.only);
      if (opts.resume === true && o.settingsKey !== undefined) {
        const sinkUrl = opts.sink ?? 'http://127.0.0.1:7654';
        const keep: Shot[] = [];
        for (const sh of shots) {
          const key = o.settingsKey(sh, opts);
          const clips = (o.looks?.(sh, opts) ?? null)?.filter((l) => l.discard !== true).map((l) => l.clip) ?? [nameOf(sh)];
          let all = true;
          for (const c of clips) {
            const r = await fetch(`${sinkUrl}/have?clip=${encodeURIComponent(c)}&key=${encodeURIComponent(key)}`).then((x) => x.json()).catch(() => ({ have: false }));
            if ((r as { have?: boolean }).have !== true) all = false;
          }
          if (all) console.info(`[cine] resume: ${sh.id} already rendered with these settings — skipped`);
          else keep.push(sh);
        }
        shots = keep;
      }
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
        await postPlan(sink, o.editPlan({ fps: opts.fps ?? 24, width: opts.width ?? rw, height: opts.height ?? rh }, opts));
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
        samples: opts.samples,
        shutter: opts.shutter,
        settingsKey: o.settingsKey ? (sh) => (o.settingsKey as NonNullable<CineOpts['settingsKey']>)(sh, opts) : undefined,
        healthy: o.healthy,
        camera: o.camera,
        looks: o.looks
          ? (shot) => {
              const ls = (o.looks as NonNullable<CineOpts['looks']>)(shot, opts);
              // a look that names a camera selects it before its own apply (world patches may follow)
              return ls?.map((l) => ({ ...l, apply: () => { activeCam = l.camera ?? 0; l.apply(); } })) ?? null;
            }
          : undefined,
        onCue: (shot, t) => {
          activeCam = 0;
          const extra = o.cameras?.(shot, opts) ?? [];
          cams = extra.map((cs) => {
            const d = new Director(o.host, {});
            d.cueCamera(cs, t);
            return { director: d, lens: o.camera.clone(), focus: postParams.dofFocus };
          });
        },
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
      if (!ShotAudio.supported) throw new Error('cine: no AudioWorklet here (the lossless SFX tap needs one)');
      // A browser will not start an AudioContext without a gesture, and a page
      // opened straight from a URL has not had one. Fail here rather than per
      // shot: "recording started and nothing happened" is what that looks like.
      await o.audio.resume();
      stop();
      const shots = pick(SHOTLIST, opts.only);
      const sink = opts.sink ?? 'http://127.0.0.1:7654';
      if (o.editPlan !== undefined) {
        const [rw, rh] = RESOLUTIONS[opts.res ?? '1080p'];
        await postPlan(sink, o.editPlan({ fps: opts.fps ?? 24, width: opts.width ?? rw, height: opts.height ?? rh }, opts));
      }
      director.snapshotWorld();
      o.host.setShooting(true);
      audioPass = true;
      // SYNC UNDER LOAD: the sim has to keep real time, and the picture is thrown away — so it is not drawn
      // (`skipRender` holds for the whole pass) and the canvas is a stamp. A pass that still falls behind is caught by
      // the take's clock fit (audio.ts `speed`).
      o.host.setRenderSize(320, 180);
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
          // the tap goes live DURING the preroll (the worklet load and the first quantum take a moment), and the take is
          // cut afterwards at the head's own sample (audio.ts) — nothing depends on when start() happened to resolve
          const take = new ShotAudio(o.audio);
          await take.start();
          // the preroll runs at real speed too: the wake and the bed have to
          // settle in the SAME seconds the sound will be recorded over
          const markFrom = -head - 1;
          while (director.shotTime < -head) {
            say(shot, i, 'preroll');
            if (director.shotTime >= markFrom) take.mark(director.shotTime);
            doneSec += 1 / 60;
            await frame();
          }
          const end = shotDuration(shot) + shotTail(shot);
          while (director.shotTime < end + 0.25) {
            say(shot, i, 'capture');
            take.mark(director.shotTime);
            doneSec += 1 / 60;
            await frame();
          }
          const t = await take.stop(-head, dur);
          if (Math.abs(t.speed - 1) > 0.005) {
            console.warn(`[cine:audio] ${shot.id} — the sim ran at ${(t.speed * 100).toFixed(1)}% of real time: this stem is stretched`);
          }
          for (const st of t.streams) {
            if (st.name !== 'mix' && (t.peaks[st.name] ?? 0) === 0) console.warn(`[cine:audio] ${shot.id} — stem '${st.name}' is digital silence`);
            const res = await fetch(
              `${sink}/audio?clip=${encodeURIComponent(nameOf(shot))}&stem=${st.name}&fmt=f32&rate=${t.sampleRate}&dur=${dur.toFixed(6)}`,
              { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: st.pcm as unknown as BodyInit },
            );
            if (!res.ok) throw new Error(`sink: ${res.status} ${res.statusText}`);
          }
          console.info(
            `[cine:audio] ${shot.id} — ${dur.toFixed(2)}s × ${t.streams.map((x) => `${x.name} peak ${x.name in t.peaks ? (20 * Math.log10(Math.max(t.peaks[x.name] as number, 1e-9))).toFixed(1) : '?'} dBFS`).join(', ')}; ` +
              `clock fit: speed ${(t.speed * 100).toFixed(2)}%, jitter ${t.jitterMs.toFixed(1)} ms`,
          );
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
