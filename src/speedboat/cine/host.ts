/**
 * THE SPEEDBOAT PAGE'S CINE HOST (docs/cine/speedboat-trailer-v1.md): src/cine's DirectorHost, recorder and audio
 * pass wired to the speedboat page, with the trailer shot list. The page calls five things (src/main-speedboat.ts):
 *
 *   cineSettings(search)          boot, the settings store: `?cine` = the maximum tier, in memory only
 *   createCineBoot(query, waterAt) boot, BEFORE createPostPipeline: `?cine` switches the clean-plate grade on while
 *                                 the post graph is still unbuilt (DOF, grain and vignette are construction gates,
 *                                 core/postPipeline.ts); the drive goes in front of the session's controls + spawn
 *   cine.applyWorld()             FIXED TICK, before the race session: world patch, then the shot's placement
 *   cine.applyCamera(frameDt)     RENDER, in `placeCamera` right after the race camera rig
 *   cine.beginFrame()             RENDER, before post/render — true = skip the draw (a capture is encoding)
 *   cine.afterRender()            RENDER, after post/render
 *
 * FROM THE CONSOLE (`speedboat.html?mode=free`):
 *
 *   __speedboat.cine.play('07')                         preview one shot, looping, preroll fast-forwarded
 *   __speedboat.cine.play()                             the whole trailer in order
 *   __speedboat.cine.record()                           every shot, 3840x2160 @ 60, take 1, to the sink
 *   __speedboat.cine.record({ only: ['09'], take: 2 })  one shot again as take 02
 *   __speedboat.cine.recordAudio({ only: ['09'], take: 2 })   its SFX stem (real time; click the page first)
 *   __speedboat.cine.stop()
 *
 * `?cine=play|record|audio|<shotId>` with `&only=07,09&take=2&w=1280&h=720&fps=30&res=1080p&sink=http://…` does the
 * same at boot; a bare `?cine` only builds the page with the shooting grade.
 */
import type * as THREE from 'three/webgpu';
import type { Vector3 } from 'three';
import { createCine, type CineAudioSource, type CineHandle, type ResolutionName, type RecordOpts } from '../../cine';
import type { ShipPose } from '../../cine/director';
import type { Progress } from '../../cine/recorder';
import { SIM_DT, type GameLoop } from '../../core/loop';
import type { AudioEngine } from '../../audio/engine';
import { applyGradeMode } from '../../grade';
import { weatherParams } from '../../params/weather';
import { GRAPHICS_FEATURE_IDS, type GraphicsFeatureId } from '../../ui/graphicsFeatures';
import { createSettingsStore, STORAGE_KEY, type SettingsStore } from '../../ui/settingsStore';
import { createCineChrome } from './cineChrome';
import type { BoatLivery } from '../assets/livery';
import { liveryFor } from '../page/liveries';
import type { SessionMode } from '../page/sessionMode';
import { createCineDrive, type CineDrive } from './drive';
import { trailerClipName, trailerEditPlan } from './editPlan';
import { TRAILER_FPS, TRAILER_MASTER, TRAILER_SHOTS, type TrailerShot } from './shotlist';

/**
 * THE SHOOTING TIER, whatever the player saved: `high` + every graphics feature on, full resolution, 4096 shadow
 * map, full foliage. Most of it is construction-gated (shadow map, resolution scale, AO/DoF sample count), so it has
 * to be the store the page BOOTS from — `initGraphicsSettings(cineSettings(location.search))`.
 *
 * In memory only: the store reads the player's saved settings and never writes them back, so the saved settings are
 * untouched and are what the next normal load (no `?cine`) builds from. Nothing to restore at runtime, and nothing
 * construction-gated could be restored at runtime anyway. Texture anisotropy is already the renderer's maximum by
 * default (circuit/courseFurniture.ts, boatModel.ts). Without `?cine`: undefined, the normal persisted store.
 */
export function cineSettings(search: string): SettingsStore | undefined {
  if (!new URLSearchParams(search).has('cine')) return undefined;
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    /* no storage: defaults, then the tier below */
  }
  const store = createSettingsStore({ getItem: () => saved, setItem: (_k, v) => void (saved = v) });
  store.applyQuality('high');
  const all = Object.fromEntries(GRAPHICS_FEATURE_IDS.map((id) => [id, true])) as Record<GraphicsFeatureId, boolean>;
  store.set({ graphics: { resolutionScale: 1, shadowMapSize: 4096, foliageDensity: 1, features: all } });
  console.info('[cine] shooting tier: high, every feature on, 4096 shadows, full resolution — in memory, saved settings untouched');
  return store;
}

/** boot-time half: grade gates before the post graph exists, and the driver the session is built around */
export function createCineBoot(query: URLSearchParams, waterAt: (x: number, z: number) => number): CineDrive {
  if (query.has('cine')) applyGradeMode('cine-flat');
  return createCineDrive(waterAt);
}

export interface SpeedboatCineDeps {
  app: { renderer: THREE.WebGPURenderer; camera: THREE.PerspectiveCamera };
  loop: GameLoop;
  sky: { sunDirection: Vector3 };
  weather: { apply(name: string, opts?: { lerpSeconds?: number }): void };
  session: { start(atTick: number): void };
  state: { tick: number; time: number };
  /** the interpolated hero pose (speedboatFrame `view`) — the pose the game camera frames, so no 60 Hz staircase */
  view: { position: ArrayLike<number>; quaternion: ArrayLike<number> };
  camera: { cam: { readonly mode: string; setMode(m: 'near' | 'chase' | 'far' | 'cockpit'): void } };
  chrome: { isPhoto(): boolean };
  audio: { engine: AudioEngine };
  hero: { setLivery(l: BoatLivery): void };
  mode: SessionMode;
  drive: CineDrive;
  waterAt(x: number, z: number): number;
}

export type TrailerRecordOpts = RecordOpts & { take?: number };

export function createSpeedboatCine(d: SpeedboatCineDeps) {
  const { app, drive } = d;
  const graded = new URLSearchParams(location.search).has('cine');
  let take = 1;
  let pending: { shot: TrailerShot; t: number } | null = null;
  let savedPixelRatio: number | null = null;
  let weatherLock: Record<string, number> | null = null;
  let photoByUs = false;
  let modeBefore: string | null = null;
  const chrome = createCineChrome(document, app.renderer.domElement);
  const pose: { position: [number, number, number]; quaternion: [number, number, number, number] } = { position: [0, 0, 0], quaternion: [0, 0, 0, 1] };
  /** the page chrome's own photo toggle (pageChrome.ts chromeKeyFor): the view rules stay the chrome's */
  const pressPhoto = (): void => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', code: 'F2' }));

  // the §V95 seam onto the page's ONE audio graph: SFX + ambience buses (the race radio sits beside them, never tapped)
  const audio: CineAudioSource = {
    resume: () => d.audio.engine.resume(),
    attach(make) {
      const ctx = d.audio.engine.getContext();
      const buses = d.audio.engine.getBuses();
      if (!ctx || !buses) return () => undefined;
      const a = make(ctx, buses);
      return () => a.dispose();
    },
  };

  const setShooting = (on: boolean): void => {
    if (on) {
      if (d.mode !== 'free') console.warn('[cine] the trailer is shot in FREE ROAM (speedboat.html?mode=free): rivals and the race HUD are in this session');
      if (!graded) console.warn('[cine] page built without ?cine: DOF, grain and vignette are post construction gates, so the clean-plate grade only half applies. Reload with ?mode=free&cine=play');
      // the weather stands still for a take (docs/cine/README.md "The weather stands still"): no cells, no re-dealt sky
      weatherLock ??= { cellCoverage: weatherParams.cellCoverage, cellIntensity: weatherParams.cellIntensity, cellDrift: weatherParams.cellDrift, transitionSeconds: weatherParams.transitionSeconds };
      Object.assign(weatherParams, { cellCoverage: 0, cellIntensity: 0, cellDrift: 0, transitionSeconds: 0 });
      d.hero.setLivery(liveryFor('signal', 27)); // orange-and-white #27, the hero livery
      chrome.set(true); // nothing but the canvas on screen (cineChrome.ts); BEFORE photo mode, which moves the dev layer
      if (!d.chrome.isPhoto()) {
        pressPhoto(); // photo mode: the HUD and the dev overlays step aside
        photoByUs = d.chrome.isPhoto();
      }
      if (d.camera.cam.mode === 'cockpit') {
        modeBefore = 'cockpit'; // the cockpit view hides the pilot's head, and every shot wants it
        d.camera.cam.setMode('far');
      }
    } else {
      drive.arm(null, 0);
      pending = null;
      if (weatherLock !== null) Object.assign(weatherParams, weatherLock);
      weatherLock = null;
      chrome.set(false);
      if (photoByUs && d.chrome.isPhoto()) pressPhoto();
      photoByUs = false;
      if (modeBefore === 'cockpit') d.camera.cam.setMode('cockpit');
      modeBefore = null;
    }
  };

  const cine: CineHandle = createCine({
    renderer: app.renderer,
    canvas: app.renderer.domElement,
    camera: app.camera,
    loop: d.loop,
    audio,
    shots: TRAILER_SHOTS,
    global: {},
    clipName: (s) => trailerClipName(s, take),
    defaults: { fps: TRAILER_FPS, width: TRAILER_MASTER[0], height: TRAILER_MASTER[1] },
    prerollPreview: true,
    editPlan: (run) => trailerEditPlan(run, take),
    host: {
      heightAt: d.waterAt,
      shipPose: (): ShipPose => {
        for (let c = 0; c < 3; c++) pose.position[c] = d.view.position[c];
        for (let c = 0; c < 4; c++) pose.quaternion[c] = d.view.quaternion[c];
        return pose;
      },
      sunDirection: () => d.sky.sunDirection,
      // instant: a shot is a cut
      setWeather: (name) => d.weather.apply(name, { lerpSeconds: 0 }),
      // render path (a cue): only remember it — the boat is placed in the next fixed tick
      prepareScene: (shot, t) => {
        pending = { shot: shot as TrailerShot, t };
      },
      holdScene: () => {
        if (pending === null) return;
        // THE SAME WATER EVERY TAKE. The sea is a function of sim time and the session's clock keeps running between
        // takes, so without this a re-render meets different waves: shot 09 ran clean in one browser run and stuffed
        // one second after placement in the next. Pinned to the first tick's time, which is also the clock the
        // headless tuning (doc §Choreography) ran on. Safe to move: the spectrum, the mirror and the clouds are
        // functions of time; wake, foam and spray integrate dt.
        d.state.time = SIM_DT;
        drive.arm(pending.shot.drive, pending.t);
        d.session.start(d.state.tick); // free roam's own (re)start: crash machine, collide memory, place, snaps
        pending = null;
      },
      setShooting,
      setRenderSize: (w, h) => {
        // EXACT pixels: setSize multiplies by the device pixel ratio (docs/cine/README.md)
        savedPixelRatio ??= app.renderer.getPixelRatio();
        app.renderer.setPixelRatio(1);
        app.renderer.setSize(w, h, false);
        app.camera.aspect = w / h;
        app.camera.updateProjectionMatrix();
      },
      restoreRenderSize: () => {
        if (savedPixelRatio === null) return;
        app.renderer.setPixelRatio(savedPixelRatio);
        savedPixelRatio = null;
        const el = app.renderer.domElement;
        const w = el.clientWidth || window.innerWidth;
        const h = el.clientHeight || window.innerHeight;
        app.renderer.setSize(w, h, false);
        app.camera.aspect = w / h;
        app.camera.updateProjectionMatrix();
      },
    },
  });

  const withTake = (o: TrailerRecordOpts | undefined): RecordOpts => {
    take = Math.max(1, Math.round(o?.take ?? 1));
    return o ?? {};
  };

  let urlDone = false;
  /** `?cine=…` — run once the loop is turning (a record restarts the loop; doing that mid-boot would draw early) */
  const fromUrl = (): void => {
    const q = new URLSearchParams(location.search);
    const m = q.get('cine');
    if (m === null || m === '') return; // bare `?cine`: the shooting grade at boot, nothing started
    const num = (k: string): number | undefined => {
      const v = Number(q.get(k));
      return Number.isFinite(v) && v > 0 ? v : undefined;
    };
    const opts: TrailerRecordOpts = {
      only: q.get('only')?.split(',').filter((s) => s.length > 0),
      res: (q.get('res') as ResolutionName | null) ?? undefined,
      width: num('w'),
      height: num('h'),
      fps: num('fps'),
      take: num('take'),
      sink: q.get('sink') ?? undefined,
    };
    const fail = (e: unknown): void => console.error('[cine]', e);
    if (m === 'play') cine.play();
    else if (m === 'record') void cine.record(withTake(opts)).catch(fail);
    else if (m === 'audio') void cine.recordAudio(withTake(opts)).catch(fail);
    else cine.play(m);
  };

  return {
    applyWorld: (): void => cine.applyWorld(),
    applyCamera(frameDt: number): void {
      if (!urlDone) {
        urlDone = true;
        setTimeout(fromUrl, 0);
      }
      cine.applyCamera(frameDt);
    },
    /** before the draw: aim it at the capture target; true = skip it (the world is frozen behind an encode) */
    beginFrame(): boolean {
      cine.beforeRender();
      return cine.skipRender();
    },
    afterRender: (): void => cine.afterRender(),
    play: (shotId?: string): void => cine.play(shotId),
    record: (o?: TrailerRecordOpts): Promise<void> => cine.record(withTake(o)),
    recordAudio: (o?: TrailerRecordOpts): Promise<void> => cine.recordAudio(withTake(o)),
    stop: (): void => cine.stop(),
    get take(): number {
      return take;
    },
    /** true while a shot is cued (preview or record): the page skips its HUD update */
    get active(): boolean {
      return cine.active;
    },
    /** progress, for a poll from outside the tab — there is deliberately no on-screen readout (no DOM over a shot) */
    get progress(): Progress | null {
      return cine.progress;
    },
    shots: TRAILER_SHOTS,
    handle: cine,
    drive,
  };
}
export type SpeedboatCine = ReturnType<typeof createSpeedboatCine>;
