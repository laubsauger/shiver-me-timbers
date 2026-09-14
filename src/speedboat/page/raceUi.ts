/**
 * THE PAGE'S RACE UI (§T.191, wiring §T.185 `src/speedboat/ui` to the live race): race HUD, radio + toasts, boat
 * select, pause, results, settings persistence. `main-speedboat.ts` builds it once and calls `update(frame)` every
 * rendered frame, after the render (§V3: it reads the race and the interpolated view, never writes sim state).
 *
 *   createRaceUi(deps) → openSelect() first; onStart(selection) → the page applies sea + livery and starts the race
 *   every frame: ui.update({ state, events, crashEvents, player crash machine, instruments, racer poses, project, sea })
 *   ui.blocking → the page's loop pause predicate (select, pause and results freeze the sim)
 *
 * WHAT THIS FILE OWNS, and why here rather than in the page loop:
 *  - CONVENTIONS. Physics yaw is atan2(fwd.x, fwd.z) (0 = +z); the HUD's heading is 0 = north (−z), clockwise toward
 *    +x (ui/model.ts relativeBearing). `hudHeadingFromYaw` is the one conversion, tested against relativeBearing.
 *  - LAP SPLITS BY RACER ID. `RaceState.lapTimes` is in RACE (grid) order; the HUD and `buildResults` index it by
 *    racerId. `createLapTimesById` re-packs it into stable per-racer arrays only when a lap is added (no per-frame
 *    allocation), and the HUD reads a mutable state view carrying those arrays.
 *  - CRASH TELEMETRY. The crash machine's kinds (speedboat/crash detect.ts) → the HUD's cause titles; the respawn bar
 *    and ghost bar from the machine's phase clock (CRASH_TIMINGS crash window + fade, ghost).
 *  - SETTINGS. Pause edits apply live to `controls.settings`, the camera rig, the HUD scale and audio, and persist
 *    (raceSettings.ts: every storage access guarded, defaults on any failure).
 */
import type { RaceEvent } from '../../race/events';
import type { Course, RaceState, RacerStanding } from '../../race/types';
import { CONTACT_BOAT } from '../../sea-physics/boatCollide';
import type { AssistSettings as ControlAssists } from '../assists/settings';
import type { CrashKind } from '../crash/detect';
import { CRASH_TIMINGS, type CrashEvent, type CrashPhase } from '../crash/machine';
import {
  BoatSelectScreen,
  DEFAULT_SELECTION,
  MPS_TO_KNOTS,
  PauseScreen,
  RaceHud,
  ResultsScreen,
  buildResults,
  buildRoster,
  createHudTelemetry,
  createRaceHudModel,
  formatLapTime,
  injectSpeedboatUiCss,
  loadSpeedboatFonts,
  placeScreenMarker,
  prepareCourse,
  updateRaceHudModel,
  type AudioSettings,
  type BoatSelection,
  type CrashKind as HudCrashKind,
  type HudCamera,
  type HudRacer,
  type ScreenMarker,
  type SeaHeading,
} from '../ui';
import type { Quality, SettingsStore } from '../../ui/settingsStore';
import type { BoatPreview } from './boatPreview';
import type { DashMount } from './dashMount';
import type { PageChrome } from './pageChrome';
import { RaceRadio } from './raceRadio';
import { applyUiAssists, defaultRaceSettings, loadRaceSettings, saveRaceSettings, type KeyValueStore } from './raceSettings';
import { SESSION_MODE_LABEL, sessionModeHref, type SessionMode } from './sessionMode';
import { SEA_OPTIONS, TIME_OPTIONS } from '../ui/boatSelect';

export interface RaceUiDeps {
  parent: HTMLElement;
  course: Course;
  /** racer ids in race (grid) order; racerId 0 = player, 1..7 = ui/roster RIVALS order */
  racerIds: readonly number[];
  controls: { settings: ControlAssists };
  camera: { cam: { setMode(m: 'chase' | 'near' | 'cockpit'): void } };
  /**
   * pause audio levels; the page maps them onto its engine (raceSettings.engineVolumes) and the radio bus
   * (raceSettings.radioLevel). `radioCall` fires once per new radio line with text (the bus's squelch, §T.197).
   */
  audio?: { setVolume?(a: AudioSettings): void; radioCall?(text: string): void };
  onStart(sel: BoatSelection): void;
  onRestart(): void;
  onQuit(): void;
  /** boat select changed (paint/number preview); optional */
  onSelectionChange?(sel: BoatSelection): void;
  /** the course's sea for a first visit (user playtest 2026-09-13: start on Calm); default 'Calm' */
  defaultSea?: string;
  /** settings store override (tests, or null for no persistence); default window.localStorage, guarded */
  store?: KeyValueStore | null;
  /** §T.201 in-engine boat pictures and the live turntable (page/boatPreview.ts) */
  preview?: Pick<BoatPreview, 'thumbnails' | 'mount' | 'setSelection' | 'render'>;
  /** §T.201 full screen + dev overlays (page/pageChrome.ts), mirrored and driven by the pause menu */
  chrome?: PageChrome;
  /** §T.201 the shared graphics settings (quality preset) for the pause menu's Graphics row */
  graphics?: Pick<SettingsStore, 'get' | 'applyQuality'>;
  /** §T.208 the instruments on the hero's 3D dash (page/dashMount.ts); fed the same model as the HUD */
  dash?: Pick<DashMount, 'setCourse' | 'setRoster' | 'update'> | null;
  /**
   * page/sessionMode.ts. 'free': no boat select (`openSelect` starts the ride with the stored selection), no race panels
   * or radio, pause without restart/boat select and with a Sea row (`onSea`). Default 'race'.
   */
  mode?: SessionMode;
  /** free roam's pause Sea row changed the sea (a SEA_OPTIONS label) */
  onSea?(sea: string): void;
  /** §T.209 free roam's pause Time row changed the time (a TIME_OPTIONS label) */
  onTime?(time: string): void;
}

export interface RaceUiFrame {
  /** real seconds */
  dt: number;
  state: Readonly<RaceState> | null;
  /** race events since the last frame (the page drains its queue) */
  events: readonly RaceEvent[];
  /** crash-machine events since the last frame */
  crashEvents: readonly { racerId: number; event: CrashEvent }[];
  player: { racerId: 0; phase: CrashPhase; crashKind: CrashKind | null; phaseTime: number; speedBeforeCrash: number; ghostTotal: number; fadeOut: number };
  speedMps: number;
  /** per outboard, 3 */
  rpm: ArrayLike<number>;
  trimDeg: number;
  pitchDeg: number;
  airborne: boolean;
  governor: 'off' | 'air' | 'full';
  cameraMode: 'chase' | 'near' | 'cockpit';
  /** per racerId, physics yaw = atan2(fwd.x, fwd.z) */
  racerX: ArrayLike<number>;
  racerZ: ArrayLike<number>;
  racerYaw: ArrayLike<number>;
  playerX: number;
  playerZ: number;
  playerYaw: number;
  /** world → NDC through the page's camera (three: z > 1 behind the camera) */
  project(x: number, y: number, z: number, out: { x: number; y: number; z: number }): void;
  /** swellDirRad and windFromRad in the physics yaw convention (travel direction of the swell; bearing the wind comes from) */
  sea: { label: string; windKn: number; windFromRad: number; swellM: number; swellDirRad: number };
  /** §T.202 the drawn pace boat (page/paceBoat `display`: smoothed, on the hull); absent = no pace marker */
  pace?: Readonly<{ visible: boolean; x: number; z: number }> | null;
}

export interface RaceUi {
  update(f: RaceUiFrame): void;
  openSelect(): void;
  openPause(): void;
  closePause(): void;
  readonly blocking: boolean;
  readonly selection: BoatSelection;
  showResults(state: RaceState): void;
  dispose(): void;
}

// ── pure helpers (tested) ──────────────────────────────────────────────────────────────────────

const TAU = Math.PI * 2;
const wrapPi = (a: number): number => {
  let r = a % TAU;
  if (r > Math.PI) r -= TAU;
  if (r < -Math.PI) r += TAU;
  return r;
};

/** physics yaw (0 = +z, atan2(fwd.x, fwd.z)) → HUD heading (0 = north −z, clockwise toward +x), −π..π */
export function hudHeadingFromYaw(yaw: number): number {
  return wrapPi(Math.PI - yaw);
}

/** RaceState.lapTimes (race order) → per-racerId arrays, re-packed only when the lap count moved */
export function createLapTimesById(racerIds: readonly number[], cap = 8): { readonly byId: readonly (readonly number[])[]; update(lapTimes: readonly (readonly number[])[]): readonly (readonly number[])[] } {
  const size = Math.max(cap, ...racerIds.map((id) => id + 1));
  const byId: number[][] = Array.from({ length: size }, () => []);
  let seen = -1;
  return {
    byId,
    update(lapTimes) {
      let total = 0;
      for (let i = 0; i < racerIds.length; i++) total += lapTimes[i]?.length ?? 0;
      if (total !== seen) {
        seen = total;
        for (let i = 0; i < racerIds.length; i++) {
          const dst = byId[racerIds[i]];
          dst.length = 0;
          const src = lapTimes[i];
          if (src) for (let k = 0; k < src.length; k++) dst.push(src[k]);
        }
      }
      return byId;
    },
  };
}

/** crash-machine kind → the HUD's cause; an impact is a hard stop on a structure, or contact when it was a boat */
export function hudCrashKind(kind: CrashKind | null, impactSource: number): HudCrashKind {
  switch (kind) {
    case 'hook':
      return 'hook';
    case 'stuff':
      return 'stuffed';
    case 'blowOver':
      return 'blowover';
    case 'barrelRoll':
      return 'barrelroll';
    case 'impact':
      return impactSource === CONTACT_BOAT ? 'contact' : 'structure';
    default:
      return 'stuffed';
  }
}

/** the swell relative to the hull: following within 45°, head beyond 135°, beam between; flat water reads as the lee */
export function seaHeadingFor(playerYaw: number, swellDirRad: number, swellM: number): SeaHeading {
  if (!(swellM >= 0.2)) return 'lee';
  const rel = Math.abs(wrapPi(swellDirRad - playerYaw));
  return rel < Math.PI / 4 ? 'following' : rel > (3 * Math.PI) / 4 ? 'head' : 'beam';
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
/** a physics-yaw bearing as an 8-point compass name (north = −z) */
export function compassFromYaw(yaw: number): string {
  const h = hudHeadingFromYaw(yaw);
  const i = Math.round(((h + TAU) % TAU) / (TAU / 8)) % 8;
  return COMPASS[i];
}

/** NDC → 0..1 viewport (y down); `behind` when three's projection flips (z > 1) */
export function ndcToViewport(ndc: { x: number; y: number; z: number }, out: { x: number; y: number; valid: boolean; behind: boolean }): void {
  out.valid = Number.isFinite(ndc.x) && Number.isFinite(ndc.y) && Number.isFinite(ndc.z);
  out.behind = ndc.z > 1;
  out.x = (ndc.x + 1) / 2;
  out.y = (1 - ndc.y) / 2;
}

/** seconds the finish stays on screen before the results open */
export const RESULTS_DELAY_S = 2.5;
/** gate marker height above the water, m (poles stand ~6.6 m; the drum float's top reads at ~1.5 m) */
export const GATE_MARKER_Y = 1.5;
/** §T.202 the pace skiff's FOLLOW-ME strobe (circuit.md §T202: 8.5 m over the water) and the start line mark height, m */
export const PACE_MARKER_Y = 8.5;
export const START_MARKER_Y = 6;

/** free roam's HUD input: no race, the player alone on the water (instruments and crash overlay only) */
const FREE_ROAM_STATE: RaceState = {
  phase: 'racing', raceTime: 0, lapTimes: [],
  standings: [{ racerId: 0, position: 1, lap: 1, nextElement: 0, progress: 0, gapToLeader: 0, finished: false, state: 'racing', surge: 0 }],
};

// ── the UI ─────────────────────────────────────────────────────────────────────────────────────

export function createRaceUi(d: RaceUiDeps): RaceUi {
  injectSpeedboatUiCss();
  void loadSpeedboatFonts();
  const mode: SessionMode = d.mode ?? 'race';
  const free = mode === 'free';
  const store = d.store;
  const settings = loadRaceSettings(store);
  let selection: BoatSelection = settings.lastSelection ?? { ...DEFAULT_SELECTION, sea: d.defaultSea ?? 'Calm' };
  const persist = (): void => {
    saveRaceSettings(settings, store);
  };

  const hc = prepareCourse(d.course);
  const hud = new RaceHud(d.parent);
  hud.setFreeRoam(free);
  hud.setCourse(hc);
  d.dash?.setCourse(hc);
  let roster: HudRacer[] = buildRoster(selection.paintId, selection.number);
  hud.setRoster(roster);
  d.dash?.setRoster(roster);
  hud.setScale(settings.hudScale);
  const model = createRaceHudModel(8);
  const tel = createHudTelemetry(8);
  const laps = createLapTimesById(d.racerIds, 8);
  // the state the HUD reads: the race's fields with lapTimes re-indexed by racerId (one object, reassigned per frame)
  const view: { -readonly [K in keyof RaceState]: RaceState[K] } = { phase: 'prestart', raceTime: 0, standings: [], lapTimes: laps.byId };

  // settings the pause screen shows are applied at boot, so what it says is what the boat does
  applyUiAssists(settings.assists, d.controls.settings);
  // §T.192: the rig's own default (far chase) stands unless the player picked a camera before (a stored choice)
  if (settings.camera !== defaultRaceSettings().camera) d.camera.cam.setMode(settings.camera);
  d.audio?.setVolume?.(settings.audio);
  let cameraMode: HudCamera = settings.camera;

  const nameOf = (id: number): string => roster.find((r) => r.racerId === id)?.boat ?? `#${id}`;
  let standingsRef: readonly RacerStanding[] = [];
  const radio = new RaceRadio({
    playerId: 0,
    laps: d.course.laps,
    name: nameOf,
    playerNumber: () => selection.number,
    position: (id) => standingsRef.find((s) => s.racerId === id)?.position ?? 0,
  });

  let raceRunning = false;
  /** the radio line id the bus last sounded (a new id with text = one squelch) */
  let radioHeard = radio.radioId;
  let resultsShown = false;
  let finishAge = 0;
  let impactSource = 0;
  let conditions = '';
  const ndc = { x: 0, y: 0, z: 0 };
  const vp = { x: 0.5, y: 0.45, valid: false, behind: false };
  const paceMarker: ScreenMarker = { x: 0, y: 0, onScreen: false, angle: 0, distanceM: 0 };
  const startMarker: ScreenMarker = { x: 0, y: 0, onScreen: false, angle: 0, distanceM: 0 };
  let startWasDown = false;

  const QUALITIES: readonly Quality[] = ['low', 'medium', 'high'];
  const QUALITY_LABEL: Record<Quality, string> = { low: 'Low', medium: 'Medium', high: 'High' };
  const chromeState = () => ({
    graphics: d.graphics ? QUALITY_LABEL[d.graphics.get().graphics.quality] : undefined,
    fullscreen: d.chrome?.fullscreen.supported() ? d.chrome.fullscreen.isActive() : null,
    devOverlays: d.chrome?.devOverlays(),
  });
  const pauseState = () => ({
    assists: settings.assists, camera: cameraMode, audio: settings.audio, hudScale: settings.hudScale, ...chromeState(),
    mode: SESSION_MODE_LABEL[mode], ...(free ? { sea: selection.sea, time: selection.time } : {}),
  });

  /** the boat select was opened from the pause: its Back returns to the paused race */
  let selectFromPause = false;

  const closePause = (): void => pause.close();
  const pause = new PauseScreen(
    d.parent,
    pauseState(),
    {
      onResume: closePause,
      onBoatSelect: free
        ? undefined
        : () => {
            pause.close();
            selectFromPause = true;
            openSelectScreen();
          },
      onMode: () => location.assign(sessionModeHref(free ? 'race' : 'free', location.href)),
      onSea: free
        ? (dir) => {
            const i = SEA_OPTIONS.indexOf(selection.sea as (typeof SEA_OPTIONS)[number]);
            selection = { ...selection, sea: SEA_OPTIONS[(Math.max(0, i) + dir + SEA_OPTIONS.length) % SEA_OPTIONS.length] };
            settings.lastSelection = { ...selection };
            persist();
            d.onSea?.(selection.sea);
            pause.setState({ sea: selection.sea });
          }
        : undefined,
      onTime: free
        ? (dir) => {
            const i = TIME_OPTIONS.indexOf(selection.time as (typeof TIME_OPTIONS)[number]);
            selection = { ...selection, time: TIME_OPTIONS[(Math.max(0, i) + dir + TIME_OPTIONS.length) % TIME_OPTIONS.length] };
            settings.lastSelection = { ...selection };
            persist();
            d.onTime?.(selection.time);
            pause.setState({ time: selection.time });
          }
        : undefined,
      onGraphics: d.graphics
        ? (dir) => {
            const g = d.graphics as NonNullable<typeof d.graphics>;
            const i = QUALITIES.indexOf(g.get().graphics.quality);
            g.applyQuality(QUALITIES[Math.min(QUALITIES.length - 1, Math.max(0, (i < 0 ? 1 : i) + dir))]);
            pause.setState(chromeState());
          }
        : undefined,
      onFullscreen: d.chrome ? () => d.chrome?.fullscreen.toggle() : undefined,
      onDevOverlays: d.chrome ? () => d.chrome?.toggleDev() : undefined,
      onRestart: free
        ? undefined
        : () => {
            closePause();
            restart();
          },
      // free roam has no menu of its own: quitting goes to the race's boat select
      onQuit: free
        ? () => location.assign(sessionModeHref('race', location.href))
        : () => {
            closePause();
            d.onQuit();
            openSelect();
          },
      onAssists: (a) => {
        settings.assists = a;
        applyUiAssists(a, d.controls.settings);
        persist();
      },
      onCamera: (c) => {
        settings.camera = c;
        cameraMode = c;
        d.camera.cam.setMode(c);
        persist();
      },
      onAudio: (a) => {
        settings.audio = a;
        d.audio?.setVolume?.(a);
        persist();
      },
      onHudScale: (s) => {
        settings.hudScale = s;
        hud.setScale(s);
        persist();
      },
    },
  );
  const results = new ResultsScreen(d.parent, {
    onRaceAgain: () => {
      results.close();
      restart();
    },
    onReplay: () => {},
    onMenu: () => {
      results.close();
      openSelect();
    },
  });
  const unsubscribeChrome = d.chrome?.subscribe(() => pause.setState(chromeState()));
  let thumbTimer: ReturnType<typeof setTimeout> | undefined;
  const requestThumbs = (number: number): void => {
    // stepping the race number re-paints the pictures once the stepping stops (each number is cached)
    clearTimeout(thumbTimer);
    thumbTimer = setTimeout(() => void d.preview?.thumbnails(number, (id, src) => select.setPaintThumb(id, src)), 350);
  };
  const select = new BoatSelectScreen(d.parent, selection, {
    onChange: (sel) => {
      if (sel.number !== selection.number) requestThumbs(sel.number);
      selection = sel;
      roster = buildRoster(sel.paintId, sel.number);
      hud.setRoster(roster);
      d.dash?.setRoster(roster);
      d.preview?.setSelection(sel.paintId, sel.number);
      d.onSelectionChange?.(sel);
    },
    onPreviewMount: d.preview
      ? (host) => {
          const preview = d.preview as NonNullable<typeof d.preview>;
          preview.setSelection(selection.paintId, selection.number);
          const off = preview.mount(host);
          select.setPreviewLive(true);
          return off;
        }
      : undefined,
    onConfirm: (sel) => {
      selectFromPause = false;
      select.close();
      selection = sel;
      settings.lastSelection = { ...sel };
      persist();
      roster = buildRoster(sel.paintId, sel.number);
      hud.setRoster(roster);
      d.dash?.setRoster(roster);
      beginRace();
      d.onStart(sel);
    },
    onBack: () => {
      if (!raceRunning) return;
      select.close();
      if (selectFromPause) {
        selectFromPause = false;
        openPause();
      }
    },
  });
  hud.addPauseButton(() => {
    if (raceRunning && !blocking()) openPause();
  });

  function beginRace(): void {
    raceRunning = true;
    resultsShown = false;
    finishAge = 0;
    impactSource = 0;
    radio.reset();
  }
  function restart(): void {
    beginRace();
    d.onRestart();
  }
  function openSelectScreen(): void {
    select.open(selection);
    void d.preview?.thumbnails(selection.number, (id, src) => select.setPaintThumb(id, src));
  }
  function openSelect(): void {
    pause.close();
    results.close();
    raceRunning = false;
    selectFromPause = false;
    if (free) {
      // no boat select in free roam: the ride starts at once with the stored paint, number and sea
      beginRace();
      d.onStart({ ...selection });
      return;
    }
    openSelectScreen();
  }
  function openPause(): void {
    if (select.isOpen || results.isOpen || pause.isOpen) return;
    const summary = free ? `${SESSION_MODE_LABEL.free} · ${d.course.name}` : `Lap ${model.lap} / ${model.laps} · P${model.position} · ${formatLapTime(model.lapTime)}`;
    pause.open(summary, conditions, pauseState());
  }
  const blocking = (): boolean => select.isOpen || pause.isOpen || results.isOpen;

  function showResults(state: RaceState): void {
    const v = { ...state, lapTimes: laps.update(state.lapTimes) };
    pause.close();
    results.open(buildResults(v), roster, { courseName: d.course.name, laps: d.course.laps, conditions, canReplay: false });
    resultsShown = true;
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || e.repeat || !raceRunning || blocking() || d.chrome?.peelEscape()) return;
    e.preventDefault();
    openPause();
  };
  const onResize = (): void => hud.resize(window.innerWidth, window.innerHeight);
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);

  return {
    get blocking() {
      return blocking();
    },
    get selection() {
      return { ...selection };
    },
    openSelect,
    openPause,
    closePause,
    showResults,
    update(f) {
      const now = performance.now();
      if (select.isOpen) d.preview?.render(f.dt);
      pause.poll(now);
      results.poll(now);
      select.poll(now);
      // gamepad Start opens the pause (the screens' own nav handles it once they are open)
      const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : null;
      let startDown = false;
      if (pads) for (const p of pads) if (p?.buttons[9]?.pressed) startDown = true;
      if (startDown && !startWasDown && raceRunning && !blocking()) openPause();
      startWasDown = startDown;

      const block = blocking();
      // photo mode (P, the shared view rules in page/pageChrome.ts): no HUD for clean shots
      const show = !block && !d.chrome?.isPhoto();
      if (hud.root.hidden === show) hud.setVisible(show);
      for (const { racerId, event } of f.crashEvents) if (racerId === 0 && event.type === 'impact') impactSource = event.source;
      if (!free) {
        radio.ingest(f.events, f.crashEvents);
        radio.step(f.dt);
        if (radio.radioId !== radioHeard) {
          radioHeard = radio.radioId;
          if (radio.radioText) d.audio?.radioCall?.(radio.radioText);
        }
      }
      cameraMode = f.cameraMode;
      conditions = `${f.sea.label} · swell ${f.sea.swellM.toFixed(1)} m · wind ${Math.round(f.sea.windKn)} kn ${compassFromYaw(f.sea.windFromRad)} · ${selection.time}`;
      const st = f.state ?? (free ? FREE_ROAM_STATE : null);
      if (!st) return;
      standingsRef = st.standings;

      // telemetry the HUD cannot derive from the race
      tel.speedMps = f.speedMps;
      for (let i = 0; i < tel.rpm.length; i++) tel.rpm[i] = f.rpm[i] ?? 0;
      tel.trimDeg = f.trimDeg;
      tel.pitchDeg = f.pitchDeg;
      tel.airTimeS = f.airborne ? tel.airTimeS + f.dt : 0;
      tel.airborne = f.airborne;
      tel.governor = f.governor;
      tel.camera = f.cameraMode;
      tel.x = f.playerX;
      tel.z = f.playerZ;
      tel.headingRad = hudHeadingFromYaw(f.playerYaw);
      const cap = tel.racerX.length;
      for (let id = 0; id < cap && id < f.racerX.length; id++) {
        tel.racerX[id] = f.racerX[id];
        tel.racerZ[id] = f.racerZ[id];
        tel.racerHeading[id] = hudHeadingFromYaw(f.racerYaw[id]);
      }
      let next = 0;
      for (const s of st.standings) if (s.racerId === 0) next = s.nextElement;
      if (next < 0 || next >= hc.labels.length) next = 0;
      f.project(hc.ex[next], GATE_MARKER_Y, hc.ez[next], ndc);
      ndcToViewport(ndc, vp);
      tel.gateScreenValid = vp.valid;
      tel.gateBehind = vp.behind;
      tel.gateScreenX = vp.x;
      tel.gateScreenY = vp.y;
      // §T.202 where the steward is and where the line is, until green
      const starting = st.phase === 'prestart' || st.phase === 'rolling' || st.phase === 'countdown';
      const pace = starting && st.paceBoat && f.pace?.visible ? f.pace : null;
      if (pace) {
        f.project(pace.x, PACE_MARKER_Y, pace.z, ndc);
        hud.setPaceMarker(placeScreenMarker(ndc, window.innerWidth, window.innerHeight, Math.hypot(pace.x - f.playerX, pace.z - f.playerZ), paceMarker));
      } else hud.setPaceMarker(null);
      if (starting) {
        f.project(hc.ex[0], START_MARKER_Y, hc.ez[0], ndc);
        hud.setStartMarker(placeScreenMarker(ndc, window.innerWidth, window.innerHeight, Math.hypot(hc.ex[0] - f.playerX, hc.ez[0] - f.playerZ), startMarker));
      } else hud.setStartMarker(null);
      tel.seaHeading = seaHeadingFor(f.playerYaw, f.sea.swellDirRad, f.sea.swellM);
      tel.swellM = f.sea.swellM;
      tel.seaLabel = f.sea.label;
      tel.timeOfDay = selection.time;
      tel.windKn = f.sea.windKn;
      tel.windFrom = compassFromYaw(f.sea.windFromRad);
      // crash detail from the player's machine
      const p = f.player;
      tel.crashKind = hudCrashKind(p.crashKind, impactSource);
      tel.crashSpeedKn = p.speedBeforeCrash * MPS_TO_KNOTS;
      const total = CRASH_TIMINGS.crashWindow + p.fadeOut;
      tel.respawnTotalS = total;
      tel.respawnRemainingS = p.phase === 'crashed' ? Math.max(0, total - p.phaseTime) : p.phase === 'respawning' ? Math.max(0, p.fadeOut - p.phaseTime) : 0;
      if (p.phase === 'crashed') tel.crashStopS = Math.min(p.phaseTime, CRASH_TIMINGS.crashWindow);
      tel.ghostTotalS = p.ghostTotal;
      tel.ghostRemainingS = p.phase === 'ghost' ? Math.max(0, p.ghostTotal - p.phaseTime) : 0;
      tel.slowMo = 1;
      tel.radioId = radio.radioId;
      tel.radioText = radio.radioText;
      tel.radioTo = radio.radioTo;
      tel.toastId = radio.toastId;
      tel.toastTitle = radio.toastTitle;
      tel.toastDetail = radio.toastDetail;
      if (st.paceBoat) tel.paceKn = st.paceBoat.speed * MPS_TO_KNOTS;

      view.phase = st.phase;
      view.raceTime = st.raceTime;
      view.standings = st.standings;
      view.lapTimes = laps.update(st.lapTimes);
      view.lights = st.lights;
      view.paceBoat = st.paceBoat;
      view.results = st.results;
      updateRaceHudModel(model, view, hc, 0, tel, f.dt);
      if (!block) {
        hud.update(model, f.dt);
        d.dash?.update(model, f.dt);
      }

      // results once the finish has been seen
      const me = st.standings.find((s) => s.racerId === 0);
      if (raceRunning && !resultsShown && st.results && (st.phase === 'finished' || me?.finished === true)) {
        finishAge += f.dt;
        if (finishAge >= RESULTS_DELAY_S) showResults(view);
      }
    },
    dispose() {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      clearTimeout(thumbTimer);
      unsubscribeChrome?.();
      pause.close();
      results.close();
      select.close();
      pause.root.remove();
      results.root.remove();
      select.root.remove();
      hud.dispose();
    },
  };
}
