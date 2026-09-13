/**
 * RaceHudModel: everything the speedboat HUD and its overlays show, as one flat mutable struct.
 *
 * Sources:
 *  - `RaceState` (src/race/types.ts, race logic §T.184): phase, clock, standings, lap splits, Surge.
 *  - `HudTelemetry` (this file): what only the page knows (§T.181/§T.182/§T.183/§T.188): the
 *    player's speed, rpm, trim and pitch, pose, camera, Governor, crash detail, radio calls, the
 *    next gate's screen projection, and every racer's position for the plotter.
 *
 * `updateRaceHudModel` runs every frame and writes into a model made once by `createRaceHudModel`.
 * It allocates nothing (tests/speedboatUiHotPath.test.ts scans it). The `format*` functions are the
 * readable, allocating twins used by tests, the results screen and anything off the hot path; the
 * HUD itself shows the same strings through the tables in ./text.ts.
 *
 * Frames and conventions:
 *  - world metres, x east, z south (three.js: forward -z is north). The plotter is north-up.
 *  - `headingRad`: 0 = facing north (-z), positive clockwise seen from above (toward +x).
 *  - gaps are seconds; a negative gap means "ahead of you", positive "behind" (design doc §9 rule).
 */
import type { Course, RaceState, RacerStanding } from '../../race/types';

// ————————————————————————————————————————— constants (design doc §3, tuning start points)

export const MPS_TO_KNOTS = 3600 / 1852;
export const SURGE_SEGMENTS = 3;
/** tower lamps, one lit per second of the count (design doc §9 rolling start) */
export const COUNTDOWN_LAMPS = 5;
/** "Clean" landing pitch band, relative to the water surface (design doc §3 landings table) */
export const LANDING_WINDOW_DEG = { min: -2, max: 7 } as const;
/** the trim dial's printed range */
export const TRIM_DIAL_DEG = { min: -6, max: 12 } as const;
export const RPM_MAX = 7000;
export const RPM_REDLINE = 6200;
/** a toast lives this long (design doc §9: central toasts ≤ 1.2 s) */
export const TOAST_S = 1.2;
/** the position block flashes this long after a place changes hands */
export const POSITION_FLASH_S = 1.6;
/** the green call stays up this long after the lamps go dark */
export const GREEN_S = 1.1;
export const ENGINES = 3;

export type HudPhase = RaceState['phase'];
export type HudCamera = 'chase' | 'near' | 'cockpit';
export type GovernorMode = 'off' | 'air' | 'full';
export type SeaHeading = 'head' | 'beam' | 'following' | 'lee';
export type CrashKind = 'stuffed' | 'blowover' | 'barrelroll' | 'hook' | 'structure' | 'contact' | 'offcourse';
export type CrashOverlay = 'none' | 'crash' | 'respawn' | 'ghost';
export type LandingWindow = 'water' | 'in' | 'high' | 'low';

// ————————————————————————————————————————— page-owned inputs

export interface HudTelemetry {
  speedMps: number;
  /** per outboard; length ENGINES */
  rpm: Float32Array;
  /** drive trim, degrees, + = bow up */
  trimDeg: number;
  /** hull pitch relative to the water surface under it, degrees, + = bow up */
  pitchDeg: number;
  airborne: boolean;
  airTimeS: number;
  governor: GovernorMode;
  camera: HudCamera;
  x: number;
  z: number;
  headingRad: number;
  /** every racer's pose by racerId, for the plotter */
  racerX: Float32Array;
  racerZ: Float32Array;
  racerHeading: Float32Array;
  /** next gate projected by the page's camera; false = HUD falls back to bearing */
  gateScreenValid: boolean;
  /** 0..1 viewport coordinates */
  gateScreenX: number;
  gateScreenY: number;
  /** behind the camera (projection flipped): treat as off-screen */
  gateBehind: boolean;
  seaHeading: SeaHeading;
  swellM: number;
  seaLabel: string;
  timeOfDay: string;
  windKn: number;
  windFrom: string;
  /** crash detail (§T.188); meaningful while the player's standing is crashed/respawning */
  crashKind: CrashKind;
  crashSpeedKn: number;
  crashPeakG: number;
  crashStopS: number;
  respawnRemainingS: number;
  respawnTotalS: number;
  slowMo: number;
  ghostRemainingS: number;
  ghostTotalS: number;
  /** race-control call; bump `radioId` for each new line */
  radioId: number;
  radioText: string;
  /** '' = the field, or e.g. 'ALL STATIONS' */
  radioTo: string;
  /** toast; bump `toastId` per event */
  toastId: number;
  toastTitle: string;
  toastDetail: string;
  /** rolling start: throttle clamp shown under the lamps */
  paceKn: number;
}

export function createHudTelemetry(fieldCap = 8): HudTelemetry {
  return {
    speedMps: 0, rpm: new Float32Array(ENGINES), trimDeg: 0, pitchDeg: 0, airborne: false, airTimeS: 0,
    governor: 'air', camera: 'chase', x: 0, z: 0, headingRad: 0,
    racerX: new Float32Array(fieldCap), racerZ: new Float32Array(fieldCap), racerHeading: new Float32Array(fieldCap),
    gateScreenValid: false, gateScreenX: 0.5, gateScreenY: 0.45, gateBehind: false,
    seaHeading: 'head', swellM: 0, seaLabel: 'Working sea', timeOfDay: '17:30', windKn: 0, windFrom: '',
    crashKind: 'stuffed', crashSpeedKn: 0, crashPeakG: 0, crashStopS: 0, respawnRemainingS: 0, respawnTotalS: 1,
    slowMo: 1, ghostRemainingS: 0, ghostTotalS: 2,
    radioId: 0, radioText: '', radioTo: '', toastId: 0, toastTitle: '', toastDetail: '', paceKn: 12,
  };
}

// ————————————————————————————————————————— course, prepared once

export interface HudCourse {
  course: Course;
  /** per element: "G1".."G9" for gates (start gate = "S/F"), "T1".. for turn marks */
  labels: readonly string[];
  /** element centre (gate midpoint or mark) */
  ex: Float32Array;
  ez: Float32Array;
}

export function prepareCourse(course: Course): HudCourse {
  const n = course.elements.length;
  const ex = new Float32Array(n);
  const ez = new Float32Array(n);
  let g = 0;
  let t = 0;
  const labels = course.elements.map((e, i) => {
    if (e.kind === 'gate') {
      ex[i] = (e.gate.left[0] + e.gate.right[0]) / 2;
      ez[i] = (e.gate.left[1] + e.gate.right[1]) / 2;
      if (e.gate.id === course.startGateId) return 'S/F';
      g += 1;
      return `G${g}`;
    }
    ex[i] = e.mark.at[0];
    ez[i] = e.mark.at[1];
    t += 1;
    return `T${t}`;
  });
  return { course, labels, ex, ez };
}

// ————————————————————————————————————————— the model

export interface HudStandingRow {
  visible: boolean;
  racerId: number;
  position: number;
  /** seconds vs the player (player row: vs the leader) */
  gap: number;
  isPlayer: boolean;
}

export interface RaceHudModel {
  phase: HudPhase;
  camera: HudCamera;
  playerId: number;

  position: number;
  fieldSize: number;
  lap: number;
  laps: number;
  finished: boolean;
  /** +1 gained a place, −1 lost one, 0 none (latched while positionFlashS > 0) */
  positionTrend: number;
  positionFlashS: number;

  raceTime: number;
  lapTime: number;
  lastLap: number;
  bestLap: number;
  gapToLeader: number;
  /** three rows: the place ahead, you, the place behind (shifted at P1 and last) */
  rows: HudStandingRow[];

  knots: number;
  rpmAvg: number;
  rpm: Float32Array;
  rpmFrac: number;
  trimDeg: number;
  pitchDeg: number;
  /** what the dial needle shows: pitch in the air, drive trim on the water */
  attitudeDeg: number;
  airborne: boolean;
  landing: LandingWindow;
  surge: number;
  /** Surge being spent right now (over-rev) */
  surgeActive: boolean;
  governor: GovernorMode;
  /** penalties so far, s (missed gates, jump start) */
  penaltyS: number;
  wrongWay: boolean;

  nextElement: number;
  nextLabel: string;
  gateDistanceM: number;
  /** relative to the bow, −π..π, + = to starboard */
  gateBearingRad: number;
  gateOnScreen: boolean;
  gateScreenX: number;
  gateScreenY: number;

  racerX: Float32Array;
  racerZ: Float32Array;
  racerHeading: Float32Array;
  racerActive: Uint8Array;
  /** marshal skiff on the plotter until it peels off */
  paceActive: boolean;
  paceX: number;
  paceZ: number;

  crash: CrashOverlay;
  crashKind: CrashKind;
  crashSpeedKn: number;
  crashPeakG: number;
  crashStopS: number;
  respawnProgress: number;
  respawnRemainingS: number;
  slowMo: number;
  ghostProgress: number;
  /** the place held when the crash began (for "P3 → P5") */
  positionBeforeCrash: number;
  /** increments per crash, so the overlay rebuilds its cause line once */
  crashId: number;

  rolling: boolean;
  countdown: number;
  lampsLit: number;
  lampsOf: number;
  greenS: number;
  paceKn: number;

  seaHeading: SeaHeading;
  swellM: number;
  seaLabel: string;
  timeOfDay: string;
  windKn: number;
  windFrom: string;

  radioId: number;
  radioText: string;
  radioTo: string;
  toastId: number;
  toastTitle: string;
  toastDetail: string;
  toastAgeS: number;
}

export function createRaceHudModel(fieldCap = 8): RaceHudModel {
  const row = (): HudStandingRow => ({ visible: false, racerId: 0, position: 0, gap: 0, isPlayer: false });
  return {
    phase: 'prestart', camera: 'chase', playerId: 0,
    position: 0, fieldSize: 1, lap: 1, laps: 1, finished: false, positionTrend: 0, positionFlashS: 0,
    raceTime: 0, lapTime: 0, lastLap: Number.NaN, bestLap: Number.NaN, gapToLeader: 0, rows: [row(), row(), row()],
    knots: 0, rpmAvg: 0, rpm: new Float32Array(ENGINES), rpmFrac: 0, trimDeg: 0, pitchDeg: 0, attitudeDeg: 0,
    airborne: false, landing: 'water', surge: 0, surgeActive: false, governor: 'air', penaltyS: 0, wrongWay: false,
    nextElement: 0, nextLabel: 'S/F', gateDistanceM: 0, gateBearingRad: 0, gateOnScreen: false, gateScreenX: 0.5, gateScreenY: 0.45,
    racerX: new Float32Array(fieldCap), racerZ: new Float32Array(fieldCap), racerHeading: new Float32Array(fieldCap),
    racerActive: new Uint8Array(fieldCap), paceActive: false, paceX: 0, paceZ: 0,
    crash: 'none', crashKind: 'stuffed', crashSpeedKn: 0, crashPeakG: 0, crashStopS: 0, respawnProgress: 0,
    respawnRemainingS: 0, slowMo: 1, ghostProgress: 0, positionBeforeCrash: 1, crashId: 0,
    rolling: false, countdown: 0, lampsLit: 0, lampsOf: COUNTDOWN_LAMPS, greenS: 0, paceKn: 12,
    seaHeading: 'head', swellM: 0, seaLabel: '', timeOfDay: '', windKn: 0, windFrom: '',
    radioId: 0, radioText: '', radioTo: '', toastId: 0, toastTitle: '', toastDetail: '', toastAgeS: TOAST_S,
  };
}

// ————————————————————————————————————————— pure helpers (hot-path safe: no allocation)

export const mpsToKnots = (mps: number): number => mps * MPS_TO_KNOTS;

/** fill of Surge segment i (0-based), 0..1 */
export function surgeSegmentFill(surge: number, i: number): number {
  const v = surge - i;
  return v <= 0 ? 0 : v >= 1 ? 1 : v;
}

export function crashOverlayFor(state: RacerStanding['state']): CrashOverlay {
  if (state === 'crashed') return 'crash';
  if (state === 'respawning') return 'respawn';
  if (state === 'ghost') return 'ghost';
  return 'none';
}

export function landingWindowFor(airborne: boolean, pitchDeg: number): LandingWindow {
  if (!airborne) return 'water';
  if (pitchDeg < LANDING_WINDOW_DEG.min) return 'low';
  if (pitchDeg > LANDING_WINDOW_DEG.max) return 'high';
  return 'in';
}

/** bearing of (tx,tz) from (x,z) relative to heading, wrapped to −π..π, + = starboard */
export function relativeBearing(x: number, z: number, headingRad: number, tx: number, tz: number): number {
  let b = Math.atan2(tx - x, -(tz - z)) - headingRad;
  while (b > Math.PI) b -= 2 * Math.PI;
  while (b < -Math.PI) b += 2 * Math.PI;
  return b;
}

// ————————————————————————————————————————— per-frame adapter

/**
 * Fill `m` from the race state and the page's telemetry. `dt` in real seconds (timers for toasts
 * and flashes). Allocation-free: scanned by tests/speedboatUiHotPath.test.ts.
 */
export function updateRaceHudModel(
  m: RaceHudModel,
  race: RaceState,
  hc: HudCourse,
  playerId: number,
  t: HudTelemetry,
  dt: number,
): void {
  const course = hc.course;
  const standings = race.standings;
  const n = standings.length;
  m.phase = race.phase;
  m.camera = t.camera;
  m.playerId = playerId;
  m.fieldSize = n;
  m.laps = course.laps;
  m.raceTime = race.raceTime;

  // the player's standing and its neighbours, by position
  let me = -1;
  let ahead = -1;
  let behind = -1;
  let ahead2 = -1;
  let behind2 = -1;
  for (let i = 0; i < n; i++) if (standings[i].racerId === playerId) me = i;
  if (me < 0) return;
  const s = standings[me];
  for (let i = 0; i < n; i++) {
    const p = standings[i].position;
    if (p === s.position - 1) ahead = i;
    else if (p === s.position + 1) behind = i;
    else if (p === s.position - 2) ahead2 = i;
    else if (p === s.position + 2) behind2 = i;
  }

  // m.position 0 = not primed yet: the first frame is not a place change
  if (s.position !== m.position && m.position > 0 && m.phase === 'racing') {
    m.positionTrend = s.position < m.position ? 1 : -1;
    m.positionFlashS = POSITION_FLASH_S;
  } else if (m.positionFlashS > 0) {
    m.positionFlashS = Math.max(0, m.positionFlashS - dt);
    if (m.positionFlashS === 0) m.positionTrend = 0;
  }
  m.position = s.position;
  m.finished = s.finished;
  m.gapToLeader = s.gapToLeader;
  m.surge = s.surge < 0 ? 0 : s.surge > SURGE_SEGMENTS ? SURGE_SEGMENTS : s.surge;
  m.surgeActive = (s.surgeBoostRemaining ?? 0) > 0;
  m.penaltyS = s.penaltySeconds ?? 0;
  m.wrongWay = s.wrongWay === true;

  // `lap` is the lap being run, 1-based, 0 before the start line (§T.184); lapTimes by racerId
  const splits = race.lapTimes[playerId];
  const recorded = splits === undefined ? 0 : splits.length;
  const done = s.lapsCompleted ?? recorded;
  let sum = 0;
  let best = Number.NaN;
  for (let i = 0; i < recorded; i++) {
    const v = (splits as readonly number[])[i];
    sum += v;
    if (!(v >= best)) best = v;
  }
  const lap = s.lap > 0 ? s.lap : done + 1;
  m.lap = lap < 1 ? 1 : lap > course.laps ? course.laps : lap;
  m.lastLap = recorded > 0 ? (splits as readonly number[])[recorded - 1] : Number.NaN;
  m.bestLap = best;
  m.lapTime = race.raceTime <= 0 ? 0 : s.finished ? m.lastLap : race.raceTime - sum;

  // three rows: normally ahead / you / behind; at P1 you / +1 / +2; last: −2 / −1 / you
  const r0 = m.rows[0];
  const r1 = m.rows[1];
  const r2 = m.rows[2];
  let a = ahead;
  let b = me;
  let c = behind;
  if (ahead < 0) {
    a = me;
    b = behind;
    c = behind2;
  } else if (behind < 0) {
    a = ahead2;
    b = ahead;
    c = me;
  }
  fillRow(r0, standings, a, me, playerId);
  fillRow(r1, standings, b, me, playerId);
  fillRow(r2, standings, c, me, playerId);

  // instruments
  m.knots = t.speedMps * MPS_TO_KNOTS;
  let rs = 0;
  for (let i = 0; i < ENGINES; i++) {
    m.rpm[i] = t.rpm[i];
    rs += t.rpm[i];
  }
  m.rpmAvg = rs / ENGINES;
  m.rpmFrac = m.rpmAvg <= 0 ? 0 : m.rpmAvg >= RPM_MAX ? 1 : m.rpmAvg / RPM_MAX;
  m.trimDeg = t.trimDeg;
  m.pitchDeg = t.pitchDeg;
  m.airborne = t.airborne;
  m.attitudeDeg = t.airborne ? t.pitchDeg : t.trimDeg;
  m.landing = landingWindowFor(t.airborne, t.pitchDeg);
  m.governor = t.governor;

  // next element
  const ne = s.nextElement < 0 || s.nextElement >= hc.labels.length ? 0 : s.nextElement;
  m.nextElement = ne;
  m.nextLabel = hc.labels[ne];
  const dx = hc.ex[ne] - t.x;
  const dz = hc.ez[ne] - t.z;
  m.gateDistanceM = Math.sqrt(dx * dx + dz * dz);
  m.gateBearingRad = relativeBearing(t.x, t.z, t.headingRad, hc.ex[ne], hc.ez[ne]);
  m.gateOnScreen = t.gateScreenValid && !t.gateBehind && t.gateScreenX >= 0.04 && t.gateScreenX <= 0.96 && t.gateScreenY >= 0.06 && t.gateScreenY <= 0.94;
  m.gateScreenX = t.gateScreenX;
  m.gateScreenY = t.gateScreenY;

  // plotter
  const cap = m.racerX.length;
  for (let i = 0; i < cap; i++) m.racerActive[i] = 0;
  for (let i = 0; i < n; i++) {
    const id = standings[i].racerId;
    if (id < 0 || id >= cap) continue;
    m.racerX[id] = t.racerX[id];
    m.racerZ[id] = t.racerZ[id];
    m.racerHeading[id] = t.racerHeading[id];
    m.racerActive[id] = 1;
  }
  const pace = race.paceBoat;
  m.paceActive = pace !== undefined && pace !== null;
  if (pace !== undefined && pace !== null) {
    m.paceX = pace.x;
    m.paceZ = pace.z;
  }

  // crash
  const overlay = crashOverlayFor(s.state);
  if (overlay === 'crash' && m.crash !== 'crash') {
    m.crashId += 1;
    if (m.crash === 'none' || m.crash === 'ghost') m.positionBeforeCrash = s.position;
  }
  m.crash = overlay;
  m.crashKind = t.crashKind;
  m.crashSpeedKn = t.crashSpeedKn;
  m.crashPeakG = t.crashPeakG;
  m.crashStopS = t.crashStopS;
  m.respawnRemainingS = t.respawnRemainingS;
  const rt = t.respawnTotalS > 0 ? t.respawnTotalS : 1;
  const rp = 1 - t.respawnRemainingS / rt;
  m.respawnProgress = rp < 0 ? 0 : rp > 1 ? 1 : rp;
  m.slowMo = t.slowMo;
  const gt = t.ghostTotalS > 0 ? t.ghostTotalS : 1;
  const gp = t.ghostRemainingS / gt;
  m.ghostProgress = overlay === 'ghost' ? (gp < 0 ? 0 : gp > 1 ? 1 : gp) : 0;

  // start. Tower lamps: one lamp per whole second remaining, counted up (5 s left → 1 lamp,
  // 1 s left → 5 lamps), dark at green; `countdown` is the number race control calls.
  // Race logic's `lights` wins when present; the raceTime derivation is the fallback.
  const wasCounting = m.countdown > 0;
  m.rolling = race.phase === 'rolling' || race.phase === 'prestart';
  const lights = race.lights;
  if (lights !== undefined) {
    m.lampsOf = lights.of > 0 ? lights.of : COUNTDOWN_LAMPS;
    m.lampsLit = lights.green ? 0 : lights.lit;
    m.countdown = !lights.green && lights.lit > 0 ? m.lampsOf + 1 - lights.lit : 0;
  } else if (race.phase === 'countdown') {
    m.lampsOf = COUNTDOWN_LAMPS;
    const remaining = Math.min(COUNTDOWN_LAMPS, Math.ceil(-race.raceTime));
    m.countdown = remaining < 1 ? 1 : remaining;
    m.lampsLit = COUNTDOWN_LAMPS + 1 - m.countdown;
  } else {
    m.countdown = 0;
    m.lampsLit = 0;
  }
  if (wasCounting && m.countdown === 0 && race.phase === 'racing') m.greenS = GREEN_S;
  else if (m.greenS > 0) m.greenS = Math.max(0, m.greenS - dt);
  m.paceKn = t.paceKn;

  // conditions + calls
  m.seaHeading = t.seaHeading;
  m.swellM = t.swellM;
  m.seaLabel = t.seaLabel;
  m.timeOfDay = t.timeOfDay;
  m.windKn = t.windKn;
  m.windFrom = t.windFrom;
  m.radioId = t.radioId;
  m.radioText = t.radioText;
  m.radioTo = t.radioTo;
  if (t.toastId !== m.toastId) {
    m.toastId = t.toastId;
    m.toastTitle = t.toastTitle;
    m.toastDetail = t.toastDetail;
    m.toastAgeS = 0;
  } else if (m.toastAgeS < TOAST_S) {
    m.toastAgeS += dt;
  }
}

function fillRow(row: HudStandingRow, standings: readonly RacerStanding[], i: number, me: number, playerId: number): void {
  if (i < 0) {
    row.visible = false;
    return;
  }
  const s = standings[i];
  row.visible = true;
  row.racerId = s.racerId;
  row.position = s.position;
  row.isPlayer = s.racerId === playerId;
  row.gap = row.isPlayer ? s.gapToLeader : s.gapToLeader - standings[me].gapToLeader;
}

// ————————————————————————————————————————— readable formatters (allocate; not for the frame loop)

const MINUS = '−';

/** "1:38.318", truncated to the millisecond like race timing; NaN/negative → "–:––.–––" */
export function formatLapTime(s: number): string {
  if (!(s >= 0) || !Number.isFinite(s)) return '–:––.–––';
  const ms = Math.floor(s * 1000 + 1e-6);
  const m = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${m}:${String(sec).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}

/** signed gap: "−0.84" ahead, "+1.20" behind, "+1:02.3" past a minute */
export function formatGap(s: number): string {
  const sign = s < 0 ? MINUS : '+';
  const a = Math.abs(s);
  if (a < 60) return `${sign}${a.toFixed(2)}`;
  const m = Math.floor(a / 60);
  return `${sign}${m}:${(a - m * 60).toFixed(1).padStart(4, '0')}`;
}

export const formatPosition = (position: number, field: number): string => `P${position}/${field}`;
export const formatLap = (lap: number, laps: number): string => `${lap}/${laps}`;
export const formatKnots = (mps: number): string => String(Math.round(mpsToKnots(mps)));
export const formatDeg = (d: number): string => {
  const r = Math.round(d);
  return r > 0 ? `+${r}°` : r < 0 ? `${MINUS}${-r}°` : '0°';
};

export const CRASH_TITLES: Record<CrashKind, string> = {
  stuffed: 'Stuffed',
  blowover: 'Blown over',
  barrelroll: 'Barrel roll',
  hook: 'Hooked',
  structure: 'Hard stop',
  contact: 'Contact',
  offcourse: 'Off course',
};

export const CRASH_CAUSES: Record<CrashKind, string> = {
  stuffed: 'Bow into the back of a wave',
  blowover: 'Trimmed high off the crest',
  barrelroll: 'Chine-first landing in a beam sea',
  hook: 'Hard steering at speed',
  structure: 'Drowned structure',
  contact: 'Boat contact',
  offcourse: 'Three seconds off the course',
};

/** "BOW INTO THE BACK OF A WAVE · 78 → 0 KN IN 0.6 S · 9.4 G" (upper-cased by CSS) */
export function formatCrashCause(kind: CrashKind, speedKn: number, stopS: number, peakG: number): string {
  return `${CRASH_CAUSES[kind]} · ${Math.round(speedKn)} → 0 kn in ${stopS.toFixed(1)} s · ${peakG.toFixed(1)} g`;
}

export const SEA_HEADING_LABEL: Record<SeaHeading, string> = {
  head: 'Head sea',
  beam: 'Beam sea',
  following: 'Following sea',
  lee: 'In the lee',
};

// ————————————————————————————————————————— results (built once at the finish)

export interface ResultRow {
  racerId: number;
  place: number;
  status: 'finished' | 'dnf' | 'running';
  /** classified time incl. penalties, NaN unless finished */
  total: number;
  /** vs the winner, NaN unless both finished */
  gap: number;
  penaltyS: number;
  laps: readonly number[];
  best: number;
}

export interface ResultsData {
  rows: ResultRow[];
  fastestRacerId: number;
  fastestLap: number;
}

/**
 * Classification for the results screen. Uses race logic's `results` (§T.184) when present;
 * otherwise orders the standings and sums `lapTimes` (penalties unknown then).
 */
export function buildResults(race: RaceState): ResultsData {
  const rows: ResultRow[] = race.results
    ? race.results.map((r) => ({
        racerId: r.racerId,
        place: r.place,
        status: r.status,
        total: r.totalTime ?? Number.NaN,
        gap: Number.NaN,
        penaltyS: r.penaltySeconds,
        laps: r.lapTimes,
        best: r.bestLap ?? Number.NaN,
      }))
    : [...race.standings]
        .sort((a, b) => a.position - b.position)
        .map((s) => {
          const laps = race.lapTimes[s.racerId] ?? [];
          const done = s.finished && s.dnf !== true;
          return {
            racerId: s.racerId,
            place: s.position,
            status: s.dnf ? 'dnf' : done ? 'finished' : 'running',
            total: done ? laps.reduce((acc, v) => acc + v, 0) + (s.penaltySeconds ?? 0) : Number.NaN,
            gap: Number.NaN,
            penaltyS: s.penaltySeconds ?? 0,
            laps,
            best: laps.length > 0 ? Math.min(...laps) : Number.NaN,
          } satisfies ResultRow;
        });
  rows.sort((a, b) => a.place - b.place);
  const winner = rows[0]?.total ?? Number.NaN;
  for (const r of rows) r.gap = r.total - winner;
  let fastestRacerId = -1;
  let fastestLap = Number.POSITIVE_INFINITY;
  for (const r of rows) {
    if (r.best < fastestLap) {
      fastestLap = r.best;
      fastestRacerId = r.racerId;
    }
  }
  return { rows, fastestRacerId, fastestLap: fastestRacerId < 0 ? Number.NaN : fastestLap };
}
