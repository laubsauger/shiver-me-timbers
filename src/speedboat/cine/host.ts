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
 * `?cine=play|record|audio|<shotId>` with `&only=07,09&take=2&w=1280&h=720&fps=30&ss=4&res=1080p&sink=http://…` does the
 * same at boot; a bare `?cine` only builds the page with the shooting grade.
 */
import * as THREE from 'three/webgpu';
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
import { createCourierCargo, type CourierCargo } from './cargo';
import { createCineChrome } from './cineChrome';
import type { BoatLivery } from '../assets/livery';
import { liveryFor } from '../page/liveries';
import { cineThrottle } from '../page/pilotRig';
import type { SessionMode } from '../page/sessionMode';
import type { CineRivals } from './rivals';
import { createCineDrive, nearestS, pathAt, type CineDrive, type DriveKey } from './drive';
import { timeForSunElevation } from '../../cine/director';
import { skyParams } from '../../params/sky';
import { subsetLooks, trailerClipName, trailerEditPlan } from './editPlan';
import { TIME_LED, type TrailerTime } from './look';
import { SEA_SETTLE, TRAILER_FPS, TRAILER_MASTER, TRAILER_RUNS, TRAILER_SAMPLES, TRAILER_SHOTS, TRAILER_SHUTTER_DEG, cameraShot, coverageFor, trailerTakes, type CoverageTier, type TrailerShot } from './shotlist';

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
  // the warm filmic sunset grade (grade/index.ts CINE_SUNSET): the grade node is a construction gate, so it is now or never
  if (query.has('cine')) applyGradeMode('cine-sunset');
  return createCineDrive(waterAt);
}

/**
 * The throttle insert's right hand (`TrailerShot.throttleHand`, pilotRig `cineThrottle`): 0..1 off the rim onto the lever,
 * over THROTTLE_REACH_S ending THROTTLE_LEAD_S before the scripted throttle starts to rise (its last closed key), so the
 * hand is on the lever when the push begins. Pure: shot-local time in, reach out.
 */
const THROTTLE_REACH_S = 0.6; // a macro lens sees the reach: 0.3 s read as a snap
const THROTTLE_LEAD_S = 0.1;
export function throttleReachAt(keys: readonly DriveKey[] | undefined, t: number): number {
  let rise = 0;
  if (keys !== undefined) {
    const up = keys.findIndex((k) => k.v > 0);
    if (up > 0) rise = (keys[up - 1] as DriveKey).t;
  }
  const end = rise - THROTTLE_LEAD_S;
  return Math.min(1, Math.max(0, (t - (end - THROTTLE_REACH_S)) / THROTTLE_REACH_S));
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
  /**
   * `stemTaps` is the SEAM the split SFX stems wait for (docs/cine/speedboat-trailer-v1.md §Sound): the boat audio's
   * player-engine and player-water panners both feed ONE compressed bus inside src/audio/boat/boatAudio.ts, so nothing
   * outside it can tell them apart. When the page's audio sink exposes the nodes, the stems are written with no change here.
   */
  audio: { engine: AudioEngine; stemTaps?(): { engine?: readonly AudioNode[]; water?: readonly AudioNode[] } | null };
  /** the hero BoatInstance: livery, and its object for the cine-only courier cargo (cargo.ts) */
  hero: { setLivery(l: BoatLivery): void; readonly object: THREE.Object3D };
  /** §T.209 the boats' LEDs (page/boatLights.ts): a shot pins their level to its time of day (look.ts TIME_LED) */
  lights?: { setOverride(level: number | null): void };
  /**
   * Re-derive every boat's LOD switch distances for this lens (boatModel `setFov`: the thresholds are screen fractions).
   * The page builds them for its 55° camera; a 12° tele 70 m off had both boats on LOD1 right under the LOD2 switch
   * (96 m at 55°), filling the frame with the low mesh and popping as the distance breathed (jitter review).
   */
  lodFov?: (fovDeg: number) => void;
  /** the hero hull's wetted area this tick (m²): the per-take airborne check (< 0.5 = out of the water) */
  wetted?: () => number;
  /** the trailer's scripted rivals (rivals.ts; built for `?cine` in free roam): placed with the hero, per shot */
  rivals?: Pick<CineRivals, 'arm' | 'active' | 'crashes'>;
  mode: SessionMode;
  drive: CineDrive;
  waterAt(x: number, z: number): number;
}

/**
 * `variants`: render every picked shot at each of these times of day (the whole-trailer variant, doc §Variants) instead
 * of only the shots that list their own `variants`.
 */
export type TrailerRecordOpts = RecordOpts & {
  take?: number;
  variants?: readonly TrailerTime[];
  /** coverage cameras rendered with each run: up to this tier (A ⊂ B ⊂ C); default C = all. 'none' = the run's own lens only */
  tier?: CoverageTier | 'none';
  /**
   * CLIP SUBSET: deliver only these clips (names with or without `_takeNN`, e.g. an edit's used clips). The run is
   * simulated whole — every camera's director still integrates every frame, so a clip is the same whether its siblings
   * render or not — only the looks not listed are neither drawn nor written. Pass `only` = the shots that have one.
   */
  clips?: readonly string[];
};

/** the coverage cameras a run renders under these options */
const camerasOf = (shot: TrailerShot, o: TrailerRecordOpts) => (o.tier === 'none' ? [] : coverageFor(shot, o.tier ?? 'C'));

/** FNV-1a over a string's UTF-16 code units, hex */
function fnvString(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** FNV-1a over the bytes of a float list — a per-frame fingerprint of a pose, for the variant determinism check */
function hashFloats(values: ArrayLike<number>, scratch: Float64Array): string {
  for (let i = 0; i < values.length; i++) scratch[i] = values[i] as number;
  const bytes = new Uint8Array(scratch.buffer, 0, values.length * 8);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i] as number;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function createSpeedboatCine(d: SpeedboatCineDeps) {
  const { app, drive } = d;
  const graded = new URLSearchParams(location.search).has('cine');
  let take = 1;
  let pending: { shot: TrailerShot; t: number } | null = null;
  /** the shot whose drive is armed (holdScene), for the render-side throttle hand */
  let armed: TrailerShot | null = null;
  let savedPixelRatio: number | null = null;
  let weatherLock: Record<string, number> | null = null;
  let photoByUs = false;
  let modeBefore: string | null = null;
  let cargo: CourierCargo | null = null;
  let fill: THREE.PointLight | null = null;
  const chrome =createCineChrome(document, app.renderer.domElement);
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
    // no `amb`: nothing on this page plays into the ambience bus, and a stem of digital silence is not a stem.
    // null = the boat-audio graph is not built yet (it loads its worklet after the unlock): the tap waits for it
    stems: () => {
      if (d.audio.stemTaps === undefined) return {};
      const t = d.audio.stemTaps();
      return t === null ? null : { engine: t.engine, water: t.water };
    },
  };

  const setShooting = (on: boolean): void => {
    if (on) {
      gameFov ??= app.camera.fov;
      if (d.mode !== 'free') console.warn('[cine] the trailer is shot in FREE ROAM (speedboat.html?mode=free): rivals and the race HUD are in this session');
      if (!graded) console.warn('[cine] page built without ?cine: DOF, grain and vignette are post construction gates, so the clean-plate grade only half applies. Reload with ?mode=free&cine=play');
      // the weather stands still for a take (docs/cine/README.md "The weather stands still"): no cells, no re-dealt sky
      weatherLock ??= { cellCoverage: weatherParams.cellCoverage, cellIntensity: weatherParams.cellIntensity, cellDrift: weatherParams.cellDrift, transitionSeconds: weatherParams.transitionSeconds };
      Object.assign(weatherParams, { cellCoverage: 0, cellIntensity: 0, cellDrift: 0, transitionSeconds: 0 });
      d.hero.setLivery(liveryFor('signal', 27)); // orange-and-white #27, the hero livery
      // the courier's lashed cargo on the aft deck (shot 04's "secured courier cargo behind the seat"); cine only
      if (cargo === null) {
        cargo = createCourierCargo();
        // THE INSERT'S FILL (06 review: "the hand is a near-black silhouette"): a small warm practical over the throttle
        // quadrant, on only while a `throttleHand` shot is cued — a film light, not part of the boat or the game
        fill ??= new THREE.PointLight(0xffc38a, 0, 1.6, 2);
        fill.position.set(-0.15, 0.95, 1.05);
        d.hero.object.add(fill);
        d.hero.object.add(cargo.object);
      }
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
      armed = null;
      cineThrottle.active = false;
      d.lights?.setOverride(null); // the LEDs follow the sky again
      if (gameFov !== null) d.lodFov?.(gameFov); // the game's LOD distances back
      gameFov = null;
      lodFovNow = Number.NaN;
      d.rivals?.arm(null, 0);
      cargo?.dispose(); // off the boat: the game never carries it
      if (fill !== null) {
        fill.removeFromParent();
        fill.intensity = 0;
      }
      cargo = null;
      if (weatherLock !== null) Object.assign(weatherParams, weatherLock);
      weatherLock = null;
      chrome.set(false);
      if (photoByUs && d.chrome.isPhoto()) pressPhoto();
      photoByUs = false;
      if (modeBefore === 'cockpit') d.camera.cam.setMode('cockpit');
      modeBefore = null;
    }
  };

  /**
   * SILENT RENDERS (USER: the engine played out of the machine's speakers for hours of rendering). A record or an audio pass
   * (the only callers of setRenderSize; `play` previews stay audible) takes the MASTER gain to 0 and puts it back after.
   * Every capture tap sits before the master (the mix on the sfx/ambience buses, the stems on the boat panners, audio.ts),
   * so the stems are unchanged.
   */
  let masterBefore: number | null = null;
  const renderMute = (on: boolean): void => {
    if (on && masterBefore === null) {
      masterBefore = d.audio.engine.getVolumes().master;
      d.audio.engine.setVolumes({ master: 0 });
    } else if (!on && masterBefore !== null) {
      d.audio.engine.setVolumes({ master: masterBefore });
      masterBefore = null;
    }
  };

  const cine: CineHandle = createCine({
    renderer: app.renderer,
    canvas: app.renderer.domElement,
    camera: app.camera,
    loop: d.loop,
    audio,
    shots: [...TRAILER_SHOTS, ...TRAILER_RUNS],
    global: {},
    clipName: (s) => trailerClipName(s, take),
    // 1080p30, 16 jittered subframes over a 180° shutter: the post chain has no AA of its own when DOF is on
    // (capture.ts Accumulator), and the subframes are the motion blur (recorder.ts `shutter`)
    defaults: { fps: TRAILER_FPS, width: TRAILER_MASTER[0], height: TRAILER_MASTER[1], grade: 'cine-sunset', samples: TRAILER_SAMPLES, shutter: TRAILER_SHUTTER_DEG },
    settingsKey: (shot, opts) => {
      // everything a clip's pixels depend on that lives outside the shared code: its data, the run's picture settings and
      // its looks. A code change is not in it — pass a new take (or drop `resume`) after one.
      const o = opts as TrailerRecordOpts;
      const looks = trailerTakes([shot as TrailerShot], o.variants).map((t) => t.timeOfDay);
      const text = JSON.stringify([shot, o.fps, o.width, o.height, o.res, o.samples, o.shutter, o.grade, looks, take]);
      return `${text.length.toString(36)}:${fnvString(text)}`;
    },
    prerollPreview: true,
    editPlan: (run, opts) => {
      const o = opts as TrailerRecordOpts;
      return trailerEditPlan(run, take, TRAILER_SHOTS, o.variants, o.tier === 'none' ? 'A' : (o.tier ?? 'C'), TRAILER_RUNS);
    },
    healthy: (shot, frame) => takeHealth(shot as TrailerShot, frame),
    cameras: (shot, opts) => camerasOf(shot as TrailerShot, opts as TrailerRecordOpts).map((c) => cameraShot(shot as TrailerShot, c)),
    // TIME-OF-DAY VARIANTS as looks of ONE take (recorder.ts `looks`): every frame drawn at each time from the same instant
    // LOOKS = the run's cameras × its times of day, every one from the same instant (recorder.ts `looks`): camera 0 is
    // the shot's own lens, cameras 1.. its coverage (cine/index.ts `cameras`); a camera's lens world goes over the time's
    looks: (shot, opts) => {
      const o = opts as TrailerRecordOpts;
      const takes = trailerTakes([shot as TrailerShot], o.variants);
      const cams = camerasOf(shot as TrailerShot, o);
      if (takes.length <= 1 && cams.length === 0 && o.clips === undefined) return null;
      const looks = [];
      for (let c = 0; c <= cams.length; c++) {
        const cam = c === 0 ? undefined : cams[c - 1];
        for (const [k, t] of takes.entries()) {
          const clip = trailerClipName({ ...t, camera: cam?.cam }, take);
          looks.push({
            clip,
            camera: c,
            apply: () => {
              lookTake = c === 0 && k === 0 ? null : t;
              lookClip = c === 0 && k === 0 ? null : clip;
              cine.director.applyPatch(t.world);
              if (cam?.world !== undefined) cine.director.applyPatch(cam.world);
              d.lights?.setOverride(TIME_LED[t.timeOfDay]);
            },
          });
        }
      }
      if (o.clips === undefined) return looks;
      const sub = subsetLooks(looks, o.clips);
      if (sub === null) console.warn(`[cine] clips: nothing of ${shot.id} is in the subset — only its placeholder look runs`);
      return sub ?? [{ ...(looks[0] as (typeof looks)[number]), discard: true }];
    },
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
        drive.arm(null, 0); // she idles while the new sea settles (SEA_SETTLE); the old shot's line is not driven on
        armed = null;
        d.rivals?.arm(null, 0); // the last shot's rivals leave with it
      },
      holdScene: () => {
        if (pending === null) return;
        // placed only once the SEA_SETTLE seconds in front of the preroll have run (shotlist.ts): the weather was applied
        // at the cue and the sea needs them to arrive; the drive starts at the placement's own shot time
        const placeAt = -((pending.shot.preroll ?? 6) - SEA_SETTLE);
        const now = cine.director.shotTime;
        if (pending.t < placeAt && now < placeAt - 1e-6) return;
        // THE SAME WATER EVERY TAKE. The sea is a function of sim time and the session's clock keeps running between
        // takes, so without this a re-render meets different waves: shot 09 ran clean in one browser run and stuffed
        // one second after placement in the next. Pinned to the first tick's time, which is also the clock the
        // headless tuning (doc §Choreography) ran on. Safe to move: the spectrum, the mirror and the clouds are
        // functions of time; wake, foam and spray integrate dt.
        d.state.time = SIM_DT;
        drive.arm(pending.shot.drive, pending.t < placeAt ? now : pending.t);
        armed = pending.shot;
        const loopState = d.loop as unknown as { alpha?: number; accumulator?: number };
        placements.push({ shot: pending.shot.id, variant: pending.shot.variant, tick: d.state.tick, alpha: loopState.alpha ?? NaN, accumulator: loopState.accumulator ?? NaN });
        d.session.start(d.state.tick); // free roam's own (re)start: crash machine, collide memory, place, snaps
        // the shot's rivals, placed the same tick on their own lines, on the same drive clock as hers
        d.rivals?.arm(pending.shot.rivals, pending.t < placeAt ? now : pending.t);
        pending = null;
      },
      setShooting,
      setRenderSize: (w, h) => {
        renderMute(true);
        // EXACT pixels: setSize multiplies by the device pixel ratio (docs/cine/README.md)
        savedPixelRatio ??= app.renderer.getPixelRatio();
        app.renderer.setPixelRatio(1);
        app.renderer.setSize(w, h, false);
        app.camera.aspect = w / h;
        app.camera.updateProjectionMatrix();
      },
      restoreRenderSize: () => {
        renderMute(false);
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

  /** clip -> per-frame fingerprint of the hero's drawn pose + the camera (variants of one shot must match exactly) */
  const poseHashes: Record<string, string[]> = {};
  /** the look variant being drawn (null = the shot's own time), and the run's whole-trailer variant flag */
  let lookTake: TrailerShot | null = null;
  let lookClip: string | null = null;
  /** the lens fov the boats' LOD distances were last derived for */
  let lodFovNow = Number.NaN;
  let gameFov: number | null = null;
  let lastVariants: readonly TrailerTime[] | undefined;
  /** `traceDraws(true)`: a row per capture draw (diagnostics; off by default) */
  let drawTrace: Record<string, unknown>[] | null = null;
  /** clip -> per frame [her position], [lens position]: the numbers behind a hash mismatch */
  const poseTrace: Record<string, number[][]> = {};
  /** per placement: the tick it happened on and the loop's interpolation phase — run-order state a take could inherit */
  const placements: { shot: string; variant: string | undefined; tick: number; alpha: number; accumulator: number }[] = [];
  /**
   * PER-TAKE CHECK (USER: takes that start before she is up to speed; seas that throw her around). On the main look of
   * every take: her speed over the first and last 10 frames against the drive's target (an at-speed run whose first
   * frames are under 90 % of it is flagged), the airborne fraction (wetted area < 0.5 m²; flagged over 10 % outside the
   * swell triple) and the frames with the stem deck under the local sea. Logged once per take, kept in `takeChecks`.
   */
  const takeChecks: Record<string, { v0: number; v1: number; target: number; airborne: number; bowUnder: number; flags: string[] }> = {};
  let checkRows: { x: number; z: number; air: boolean; bow: boolean }[] = [];
  /**
   * TAKE HEALTH, checked on every captured frame (recorder `healthy`): a broken take fails loudly instead of landing as
   * a clip (user-found: a 48-frame take of the default daytime page, hero parked, no rivals, then black — the page had
   * stopped rendering on GPU errors). Fails on: any uncaptured GPU error since the shot was cued; at frame 0 the drive
   * not armed, the hero more than 40 m off the shot's line, or the sky clock not the shot's time of day.
   */
  let gpuErrors = 0;
  let gpuErrorsAtCue = 0;
  let healthShot: string | null = null;
  const device = (app.renderer as unknown as { backend?: { device?: EventTarget } }).backend?.device;
  device?.addEventListener('uncapturederror', () => void gpuErrors++);
  const takeHealth = (shot: TrailerShot, frame: number): string | null => {
    if (healthShot !== shot.id || frame === 0) {
      if (healthShot !== shot.id) gpuErrorsAtCue = gpuErrors;
      healthShot = shot.id;
    }
    if (gpuErrors > gpuErrorsAtCue) return `${gpuErrors - gpuErrorsAtCue} GPU error(s) during the take`;
    if (frame !== 0) return null;
    if (drive.time === null) return 'the drive was never armed (the shot was not placed)';
    const n = nearestS(shot.drive.path, d.view.position[0] as number, d.view.position[2] as number);
    const on = pathAt(shot.drive.path, n.s);
    const off = Math.hypot(on.x - (d.view.position[0] as number), on.z - (d.view.position[2] as number));
    if (off > 40) return `the hero is ${off.toFixed(0)} m off the shot's line at the first frame (not placed)`;
    const w = (lookTake ?? shot).world;
    const clock = w?.sunElevationDeg !== undefined ? timeForSunElevation(w.sunElevationDeg, w.sunSide ?? 'morning') : w?.timeOfDay;
    if (clock !== undefined && Math.abs(skyParams.timeOfDay - clock) > 0.05) {
      return `the sky clock is ${skyParams.timeOfDay.toFixed(2)} h, the shot's ${shot.timeOfDay} is ${clock.toFixed(2)} h (world not applied)`;
    }
    return null;
  };
  /** the output frame rate of the run being recorded (withTake) */
  let takeFps = TRAILER_FPS;
  const takeCheck = (shot: TrailerShot, frame: number, frames: number, clip: string): void => {
    if (frame === 0) checkRows = [];
    const q = d.view.quaternion;
    const [qx, qy, qz, qw] = [q[0] as number, q[1] as number, q[2] as number, q[3] as number];
    // the stem deck point (0, 0.54, 8.2) in the world: v' = v + 2w(u×v) + 2u×(u×v)
    const vx = 0, vy = 0.54, vz = 8.2;
    const cx = qy * vz - qz * vy, cy = qz * vx - qx * vz, cz = qx * vy - qy * vx;
    const bx = (d.view.position[0] as number) + vx + 2 * (qw * cx + (qy * cz - qz * cy));
    const by = (d.view.position[1] as number) + vy + 2 * (qw * cy + (qz * cx - qx * cz));
    const bz = (d.view.position[2] as number) + vz + 2 * (qw * cz + (qx * cy - qy * cx));
    checkRows.push({ x: d.view.position[0] as number, z: d.view.position[2] as number, air: (d.wetted?.() ?? 1) < 0.5, bow: d.waterAt(bx, bz) > by });
    if (frame !== frames - 1 || checkRows.length < 22) return;
    const n = checkRows.length;
    const fps = takeFps;
    const speed = (a: number, b: number): number => Math.hypot(checkRows[b]!.x - checkRows[a]!.x, checkRows[b]!.z - checkRows[a]!.z) / ((b - a) / fps);
    const v0 = speed(0, 10);
    const v1 = speed(n - 11, n - 1);
    const target = shot.drive.steady?.v ?? 0;
    const airborne = checkRows.filter((r) => r.air).length / n;
    const bowUnder = checkRows.filter((r) => r.bow).length;
    const flags: string[] = [];
    if (target > 0 && v0 < 0.9 * target) flags.push(`SLOW START ${v0.toFixed(1)} < 90% of ${target}`);
    if (!shot.id.startsWith('14') && airborne > 0.1) flags.push(`AIRBORNE ${(airborne * 100).toFixed(0)}%`);
    if (bowUnder > 0) flags.push(`BOW UNDER ${bowUnder} frames`);
    takeChecks[clip] = { v0, v1, target, airborne, bowUnder, flags };
    const line = `[cine] take check ${shot.id}: speed first ${v0.toFixed(1)} last ${v1.toFixed(1)} m/s (target ${target || '—'}), airborne ${(airborne * 100).toFixed(1)}%, bow under ${bowUnder} frames`;
    if (flags.length > 0) console.warn(`${line} — ${flags.join('; ')}`);
    else console.info(line);
  };
  const fp = new Array<number>(23).fill(0);
  const fpScratch = new Float64Array(23);

  const withTake = (o: TrailerRecordOpts | undefined): RecordOpts => {
    take = Math.max(1, Math.round(o?.take ?? 1));
    takeFps = o?.fps ?? TRAILER_FPS;
    lastVariants = o?.variants;
    lookTake = null;
    lookClip = null;
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
      samples: num('ss'),
      shutter: q.has('shutter') ? Number(q.get('shutter')) : undefined,
      resume: q.has('resume') ? true : undefined,
      take: num('take'),
      sink: q.get('sink') ?? undefined,
      variants: (q.get('variants')?.split(',').filter((v) => v.length > 0) as TrailerTime[] | undefined) ?? undefined,
      tier: (q.get('tier') as TrailerRecordOpts['tier'] | null) ?? undefined,
      clips: q.get('clips')?.split(',').filter((c) => c.length > 0) ?? undefined,
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
      if (cine.active && app.camera.fov !== lodFovNow) {
        lodFovNow = app.camera.fov;
        d.lodFov?.(lodFovNow);
      }
      // the LED level is the take's time of day, pinned (a variant must not follow the sun); the game's own when idle
      const cued = cine.director.current as TrailerShot | null;
      const time = lookTake?.timeOfDay ?? cued?.timeOfDay;
      d.lights?.setOverride(cine.active && time !== undefined ? TIME_LED[time] : null);
      // the 06 insert: the pilot's right hand on the lever, the lever riding the driver's throttle (render only)
      const t = drive.time;
      cineThrottle.active = cine.active && armed?.throttleHand === true && t !== null;
      if (fill !== null) fill.intensity = cine.active && (cued as TrailerShot | null)?.throttleHand === true ? 1.2 : 0;
      if (cineThrottle.active && armed !== null && t !== null) {
        cineThrottle.reach = throttleReachAt(armed.drive.throttle, t);
        cineThrottle.lever = cineThrottle.reach >= 1 ? drive.throttle : 0;
      }
    },
    /** before the draw: aim it at the capture target; true = skip it (the world is frozen behind an encode) */
    beginFrame(): boolean {
      cine.beforeRender();
      return cine.skipRender();
    },
    afterRender(): void {
      // BEFORE the recorder's afterRender, which may advance the frame counter: fingerprint the frame being captured
      const p = cine.progress;
      const cued = cine.director.current as TrailerShot | null;
      if (drawTrace !== null && p !== null && p.phase === 'capture' && cued !== null) {
        // DIAGNOSTIC (jitter review): every capture draw — each subframe of each look — with the loop's phase and the poses
        const rival = (window as unknown as { __speedboat?: { boats?: { npcs?: { object: THREE.Object3D }[] } } }).__speedboat?.boats?.npcs?.[0]?.object;
        const loopState = d.loop as unknown as { alpha?: number };
        const w = window as unknown as { __speedboat?: { boats?: { hero?: { currentLevel(): number }; npcs?: { currentLevel(): number }[] } } };
        drawTrace.push({
          lod: [w.__speedboat?.boats?.hero?.currentLevel() ?? -1, w.__speedboat?.boats?.npcs?.[0]?.currentLevel() ?? -1],
          frame: p.frame, clip: lookClip ?? 'main', shotTime: cine.director.shotTime, simTime: d.state.time, tick: d.state.tick, alpha: loopState.alpha ?? NaN,
          hero: [...Array.from(d.view.position as ArrayLike<number>), ...Array.from(d.view.quaternion as ArrayLike<number>)],
          rival: rival ? [rival.position.x, rival.position.y, rival.position.z, rival.quaternion.x, rival.quaternion.y, rival.quaternion.z, rival.quaternion.w] : null,
          cam: [app.camera.position.x, app.camera.position.y, app.camera.position.z, app.camera.quaternion.x, app.camera.quaternion.y, app.camera.quaternion.z, app.camera.quaternion.w],
        });
      }
      if (p !== null && p.phase === 'capture' && cued !== null) {
        const clip = lookClip ?? trailerClipName(trailerTakes([cued], lastVariants)[0] ?? cued, take);
        const log = (poseHashes[clip] ??= []);
        if (log.length === p.frame) {
          const m = app.camera.matrixWorld.elements;
          for (let c = 0; c < 3; c++) fp[c] = d.view.position[c] as number;
          for (let c = 0; c < 4; c++) fp[3 + c] = d.view.quaternion[c] as number;
          for (let c = 0; c < 16; c++) fp[7 + c] = m[c] as number;
          log.push(hashFloats(fp, fpScratch));
          (poseTrace[clip] ??= []).push(fp.slice(0, 3), fp.slice(19, 22)); // her position, the lens position (matrixWorld 12..14)
          if (lookClip === null) takeCheck(cued, p.frame, p.frames, clip);
        }
      }
      cine.afterRender();
    },
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
    /** per-frame pose + camera fingerprints of every clip captured this session (doc §Variants determinism check) */
    poseHashes,
    poseTrace,
    takeChecks,
    /** diagnostics: start (true, clears) or stop (false) the per-draw pose trace; `drawTrace` reads it */
    traceDraws(on: boolean): void {
      drawTrace = on ? [] : null;
    },
    get drawTrace(): readonly Record<string, unknown>[] | null {
      return drawTrace;
    },
    placements,
    shots: TRAILER_SHOTS,
    /** the page's CineAudioSource as the audio pass taps it (a tool can inspect or extend its `stems`) */
    audioSource: audio,
    handle: cine,
    drive,
  };
}
export type SpeedboatCine = ReturnType<typeof createSpeedboatCine>;
