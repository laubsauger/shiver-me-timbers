/**
 * Fake race for the UI harness (speedboat-ui-harness.html). A sketch of Tower Reach from the design
 * doc plotter, eight boats, and one scripted timeline that walks every HUD state:
 *   prestart → rolling → countdown → racing (place changes, air, Surge earned and spent) → crash
 *   → respawn → ghost → finish → results.
 * Laps are compressed to ~12 s so the whole run fits in a minute. Pure data (no DOM); the harness
 * page reads `sampleAt(t)` into a mutable RaceState + HudTelemetry.
 */
import type { Course, CourseElement, RaceState, RacerStanding, Vec2 } from '../../race/types';
import { createHudTelemetry, type CrashKind, type HudTelemetry, type SeaHeading } from './model';

// ————————————————————————————————————————— course

function smooth(a: number, b: number, t: number): number {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
}

type Seg =[x: number, y: number] | [c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number];

/** the design-doc plotter path (mockup units), as line and cubic segments from (720,400) */
const SKETCH: Seg[] = [
  [720, 360], [720, 280, 760, 230, 830, 200], [900, 170, 900, 110, 840, 100], [760, 90, 680, 95, 600, 100], [300, 100],
  [180, 100, 110, 130, 110, 200], [110, 430], [110, 520, 150, 560, 230, 565], [430, 565], [480, 565, 500, 520, 520, 480],
  [545, 430, 600, 440, 640, 470], [680, 500, 720, 460, 720, 400],
];
const M_PER_UNIT = 2.6;

function sampleSketch(): Vec2[] {
  const pts: Vec2[] = [];
  let px = 720;
  let py = 400;
  const put = (x: number, y: number): void => {
    pts.push([(x - 500) * M_PER_UNIT, (y - 330) * M_PER_UNIT]);
  };
  put(px, py);
  for (const s of SKETCH) {
    if (s.length === 2) {
      const n = Math.max(2, Math.round(Math.hypot(s[0] - px, s[1] - py) / 30));
      for (let i = 1; i <= n; i++) put(px + ((s[0] - px) * i) / n, py + ((s[1] - py) * i) / n);
      [px, py] = s;
    } else {
      const [c1x, c1y, c2x, c2y, x, y] = s;
      for (let i = 1; i <= 14; i++) {
        const t = i / 14;
        const u = 1 - t;
        put(u * u * u * px + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x, u * u * u * py + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y);
      }
      px = x;
      py = y;
    }
  }
  pts.pop(); // closed: last point == first
  return pts;
}

const LINE = sampleSketch();
const CUM: number[] = [0];
for (let i = 1; i <= LINE.length; i++) {
  const a = LINE[i - 1];
  const b = LINE[i % LINE.length];
  CUM.push(CUM[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
}
export const LAP_M = CUM[CUM.length - 1];

/** point + heading (0 = north/−z, clockwise) at distance d along the line */
export function along(d: number): { x: number; z: number; heading: number } {
  const s = ((d % LAP_M) + LAP_M) % LAP_M;
  let i = 1;
  while (CUM[i] < s) i++;
  const a = LINE[i - 1];
  const b = LINE[i % LINE.length];
  const f = (s - CUM[i - 1]) / Math.max(1e-6, CUM[i] - CUM[i - 1]);
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  return { x: a[0] + dx * f, z: a[1] + dz * f, heading: Math.atan2(dx, -dz) };
}

/** fraction along the lap, kind, sea heading of the sector it opens */
const ELEMENTS: [number, 'gate' | 'mark', SeaHeading][] = [
  [0.0, 'gate', 'lee'], [0.07, 'mark', 'lee'], [0.16, 'gate', 'head'], [0.24, 'gate', 'head'], [0.33, 'mark', 'beam'],
  [0.42, 'gate', 'beam'], [0.5, 'mark', 'beam'], [0.6, 'gate', 'following'], [0.7, 'gate', 'lee'], [0.78, 'gate', 'lee'],
  [0.86, 'gate', 'lee'], [0.93, 'gate', 'lee'],
];

function buildCourse(): Course {
  const elements: CourseElement[] = ELEMENTS.map(([f, kind], i) => {
    const p = along(f * LAP_M);
    const nx = Math.cos(p.heading);
    const nz = Math.sin(p.heading);
    if (kind === 'mark') return { kind: 'mark', mark: { id: `m${i}`, at: [p.x + nx * 30, p.z + nz * 30], keepOn: 'port', radius: 25 } };
    const half = i === 0 ? 60 : 38;
    return { kind: 'gate', gate: { id: `g${i}`, left: [p.x - nx * half, p.z - nz * half], right: [p.x + nx * half, p.z + nz * half], sector: 'exposed' } };
  });
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of LINE) {
    minX = Math.min(minX, x);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxZ = Math.max(maxZ, z);
  }
  return {
    id: 'tower-reach-sketch',
    name: 'Tower Reach',
    elements,
    startGateId: 'g0',
    laps: 3,
    referenceLine: LINE,
    paceLine: [],
    bounds: { min: [minX - 40, minZ - 40], max: [maxX + 40, maxZ + 40] },
  };
}

export const HARNESS_COURSE = buildCourse();

// ————————————————————————————————————————— timeline

export const T_PRESTART = 0;
export const T_ROLLING = 4;
export const T_COUNT = 9;
export const T_GREEN = 14;
export const T_CRASH = 33;
export const CRASH_CAM_S = 1.2;
export const RESPAWN_S = 1.8;
export const GHOST_S = 2;
export const T_END = 64;
const LAPS = 3;
const FIELD = 8;
const PLAYER = 0;
/** simulated lap for the leader, harness seconds */
const LAP_S = 12;

/** named moments for the harness buttons and screenshots */
export const MOMENTS: Record<string, number> = {
  prestart: 2,
  rolling: 6.5,
  countdown: 11.6,
  green: 14.3,
  racing: 17.2,
  air: 19.2,
  surge: 24.4,
  overtake: 29.2,
  crash: 33.5,
  respawn: 34.8,
  ghost: 36.2,
  lastlap: 43,
  finish: 51.4,
};

/** a real Tower Reach lap (design doc: ~2:13); gaps below are in these seconds */
const REAL_LAP_S = 133;
/** grid order at green: Crosswind on pole … player sixth */
const GRID_RANK = [5, 0, 1, 2, 3, 4, 6, 7];
/** crash cost, real seconds (design doc §3: 4–6 s) */
const CRASH_COST_S = 4.2;

/** seconds behind the leader (Crosswind), scripted: rivals drift apart, the player climbs */
function gapAt(id: number, rt: number): number {
  const r = Math.max(0, rt);
  if (id === PLAYER) {
    let g = 5.0 - 0.22 * r;
    g -= smooth(10, 13, r) * 0.3; // Surge spent
    g += smooth(T_CRASH - T_GREEN, T_CRASH - T_GREEN + CRASH_CAM_S + RESPAWN_S, r) * CRASH_COST_S;
    return Math.max(0.3, g);
  }
  const base = [0, 0, 1.4, 2.6, 3.5, 4.4, 5.6, 6.5][id];
  const drift = [0, 0, 0.02, 0.05, 0.08, 0.1, 0.2, 0.35][id];
  return base + drift * r + (id === 1 ? 0 : Math.sin(r * 0.6 + id) * 0.08);
}

function progressAt(id: number, rt: number): number {
  if (rt <= 0) return -GRID_RANK[id] * 16 + rt * 6;
  const leader = rt * (LAP_M / LAP_S);
  return leader - (gapAt(id, rt) / REAL_LAP_S) * LAP_M - (rt < 2 ? GRID_RANK[id] * 16 * (1 - rt / 2) : 0);
}

/** race time at which racer `id` completes lap k (k = 1..), found by bisection */
function lapCrossTime(id: number, k: number): number {
  let lo = 0;
  let hi = 120;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (progressAt(id, mid) >= k * LAP_M) hi = mid;
    else lo = mid;
  }
  return hi;
}

const CROSS: number[][] = Array.from({ length: FIELD }, (_, id) => Array.from({ length: LAPS }, (_, k) => lapCrossTime(id, k + 1)));

const RADIO: [t: number, text: string, to?: string][] = [
  [0.2, 'Tower Reach, eight boats, three laps. Crosswind on pole.'],
  [4.1, 'Marshal skiff has the field. Hold twelve knots.'],
  [9.05, 'Lamps on. Hold your lanes. Five.'],
  [10.05, 'Four.'],
  [11.05, 'Three.'],
  [12.05, 'Two.'],
  [13.05, 'One.'],
  [14.0, 'Green, green, green. Skiff is clear.'],
  [19.4, 'Forty-four’s over the Bar clean, one’s on her wake.'],
  [28.6, 'One takes White Horses at Pylon Row.'],
  [33.1, 'One’s stuffed it on Stuff Run. Field, keep wide.'],
  [36.4, 'One is back on the line.'],
  [40.2, 'Last lap for the leaders.'],
  [51.3, 'Crosswind takes the run. One, two point one back.', 'ALL STATIONS'],
];

const TOASTS: [t: number, title: string, detail: string][] = [
  [19.95, 'Air 1.4 s', 'Wake jump  +⅓ Surge'],
  [23.9, 'Surge', 'Governor lets go · 3 s'],
  [28.9, 'P2', 'Past White Horses'],
];

export interface HarnessSample {
  race: RaceState;
  telemetry: HudTelemetry;
  playerId: number;
}

export function createSample(): HarnessSample {
  const standings: RacerStanding[] = Array.from({ length: FIELD }, (_, id) => ({
    racerId: id, position: id + 1, lap: 0, nextElement: 0, progress: 0, gapToLeader: 0, finished: false, state: 'racing', surge: 0,
    lapsCompleted: 0, penaltySeconds: 0, wrongWay: false, surgeBoostRemaining: 0, dnf: false,
  }));
  const race = {
    phase: 'prestart',
    raceTime: -14,
    standings,
    lapTimes: Array.from({ length: FIELD }, () => [] as number[]),
    lights: { lit: 0, of: 5, green: false },
    paceBoat: null,
  } as RaceState & { lapTimes: number[][]; standings: RacerStanding[]; lights: { lit: number; of: number; green: boolean }; paceBoat: RaceState['paceBoat'] };
  const telemetry = createHudTelemetry(FIELD);
  telemetry.seaLabel = 'Working sea';
  telemetry.timeOfDay = '17:30';
  telemetry.windKn = 14;
  telemetry.windFrom = 'WSW';
  return { race, telemetry, playerId: PLAYER };
}

/** write harness time `t` (s) into the sample */
export function sampleAt(sample: HarnessSample, t: number, opts: { wrongWay?: boolean } = {}): void {
  const race = sample.race as RaceState & { phase: RaceState['phase']; raceTime: number; lapTimes: number[][]; standings: RacerStanding[]; lights: { lit: number; of: number; green: boolean }; paceBoat: RaceState['paceBoat'] };
  const tel = sample.telemetry;
  const rt = t - T_GREEN;
  race.raceTime = rt;
  const finishT = CROSS[PLAYER][LAPS - 1] + T_GREEN;
  race.phase = t < T_ROLLING ? 'prestart' : t < T_COUNT ? 'rolling' : t < T_GREEN ? 'countdown' : t < finishT + 0.01 ? 'racing' : 'finished';

  // lamps
  if (race.phase === 'countdown') {
    const lit = Math.min(5, Math.floor(t - T_COUNT) + 1);
    race.lights = { lit, of: 5, green: false };
  } else {
    race.lights = { lit: 0, of: 5, green: rt >= 0 };
  }
  const paceD = 30 + (rt < 0 ? rt * 6 : rt * 30);
  if (rt < 1.5) {
    const p = along(paceD);
    race.paceBoat = { x: p.x, z: p.z, yaw: p.heading, speed: 6 };
  } else race.paceBoat = null;

  // progress, laps, positions
  const prog: number[] = [];
  for (let id = 0; id < FIELD; id++) prog.push(progressAt(id, rt));
  const order = [...prog.keys()].sort((a, b) => {
    const fa = rt >= CROSS[a][LAPS - 1];
    const fb = rt >= CROSS[b][LAPS - 1];
    if (fa && fb) return CROSS[a][LAPS - 1] - CROSS[b][LAPS - 1];
    if (fa !== fb) return fa ? -1 : 1;
    return prog[b] - prog[a];
  });
  const leader = order[0];
  for (let id = 0; id < FIELD; id++) {
    const s = race.standings[id];
    const done = CROSS[id].filter((c) => rt >= c).length;
    s.position = order.indexOf(id) + 1;
    s.lapsCompleted = done;
    s.lap = rt < 0 ? 0 : Math.min(LAPS, done + 1);
    s.finished = done >= LAPS;
    s.progress = prog[id];
    s.gapToLeader = s.position === 1 ? 0 : Math.max(0, gapAt(id, rt) - (leader === 1 ? 0 : gapAt(leader, rt)));
    const frac = (((prog[id] % LAP_M) + LAP_M) % LAP_M) / LAP_M;
    let ne = ELEMENTS.findIndex(([f]) => f > frac + 1e-4);
    if (ne < 0) ne = 0;
    s.nextElement = ne;
    s.state = s.finished ? 'finished' : 'racing';
    const lt = race.lapTimes[id];
    if (lt.length !== done) {
      lt.length = 0;
      for (let k = 0; k < done; k++) lt.push(CROSS[id][k] - (k === 0 ? 0 : CROSS[id][k - 1]));
    }
    s.surge = id === PLAYER ? 0 : 1;
    const p = along(prog[id]);
    const lane = ((id % 3) - 1) * 9;
    tel.racerX[id] = p.x + Math.cos(p.heading) * lane;
    tel.racerZ[id] = p.z + Math.sin(p.heading) * lane;
    tel.racerHeading[id] = p.heading;
  }

  // the player
  const me = race.standings[PLAYER];
  const crashRt = T_CRASH - T_GREEN;
  if (rt >= crashRt && rt < crashRt + CRASH_CAM_S) me.state = 'crashed';
  else if (rt >= crashRt + CRASH_CAM_S && rt < crashRt + CRASH_CAM_S + RESPAWN_S) me.state = 'respawning';
  else if (rt >= crashRt + CRASH_CAM_S + RESPAWN_S && rt < crashRt + CRASH_CAM_S + RESPAWN_S + GHOST_S) me.state = 'ghost';
  me.surge =
    rt < 0 ? 0 : rt < 5.95 ? smooth(4.5, 5.95, rt) * (1 / 3) + 1 : rt < 9.9 ? 1.34 + smooth(6, 9.8, rt) * 1.66 : rt < 12 ? 2 : rt < crashRt ? 2 + smooth(15, 18, rt) * 0.33 : 2.33;
  me.surgeBoostRemaining = rt > 9.9 && rt < 12.9 ? 12.9 - rt : 0;
  me.wrongWay = opts.wrongWay === true;
  me.penaltySeconds = 0;

  const air1 = rt > 4.5 && rt < 5.9;
  const air2 = rt > 13.5 && rt < 14.3;
  tel.airborne = air1 || air2;
  tel.airTimeS = air1 ? rt - 4.5 : air2 ? rt - 13.5 : 0;
  tel.pitchDeg = air1 ? 11 - (rt - 4.5) * 6 : air2 ? 14 - (rt - 13.5) * 3 : 1.5 + Math.sin(rt * 2.3) * 1.2;
  tel.trimDeg = rt < 0 ? 0 : 3.5 + Math.sin(rt * 0.5) * 1.5;
  const surging = (me.surgeBoostRemaining ?? 0) > 0;
  let kn = rt < 0 ? 12 + Math.max(0, rt + 1) * 30 : Math.min(78, 30 + rt * 16) + Math.sin(rt * 1.3) * 3.5 + (surging ? 10 : 0);
  if (me.state === 'crashed') kn = Math.max(0, 78 - (rt - crashRt) * 130);
  if (me.state === 'respawning') kn = 25;
  if (me.state === 'ghost') kn = 25 + (rt - crashRt - CRASH_CAM_S - RESPAWN_S) * 18;
  if (me.finished) kn = Math.max(20, 76 - (rt - CROSS[PLAYER][LAPS - 1]) * 12);
  tel.speedMps = kn / (3600 / 1852);
  const baseRpm = rt < -5 ? 1400 : 1800 + kn * 58;
  for (let e = 0; e < 3; e++) tel.rpm[e] = Math.min(6900, baseRpm + (tel.airborne ? 700 + e * 140 : 0) + (e - 1) * 45);
  tel.governor = 'air';
  const pp = along(prog[PLAYER]);
  tel.x = pp.x;
  tel.z = pp.z;
  tel.headingRad = pp.heading;

  // gate projection stand-in: within ±26° of the bow the gate is "on screen" near the horizon
  const ne = me.nextElement;
  const el = HARNESS_COURSE.elements[ne];
  const gx = el.kind === 'gate' ? (el.gate.left[0] + el.gate.right[0]) / 2 : el.mark.at[0];
  const gz = el.kind === 'gate' ? (el.gate.left[1] + el.gate.right[1]) / 2 : el.mark.at[1];
  let b = Math.atan2(gx - tel.x, -(gz - tel.z)) - tel.headingRad;
  while (b > Math.PI) b -= 2 * Math.PI;
  while (b < -Math.PI) b += 2 * Math.PI;
  tel.gateScreenValid = Math.abs(b) < 0.45;
  tel.gateScreenX = 0.5 + b / 0.9;
  tel.gateScreenY = 0.44 - Math.min(0.03, Math.hypot(gx - tel.x, gz - tel.z) / 20000);
  tel.gateBehind = false;
  tel.seaHeading = ELEMENTS[(ne + ELEMENTS.length - 1) % ELEMENTS.length][2];
  tel.swellM = 2.1;

  // crash detail
  tel.crashKind = 'stuffed' satisfies CrashKind;
  tel.crashSpeedKn = 78;
  tel.crashPeakG = 9.4;
  tel.crashStopS = 0.6;
  tel.slowMo = 0.35;
  tel.respawnTotalS = CRASH_CAM_S + RESPAWN_S;
  tel.respawnRemainingS = Math.max(0, crashRt + CRASH_CAM_S + RESPAWN_S - rt);
  tel.ghostTotalS = GHOST_S;
  tel.ghostRemainingS = Math.max(0, crashRt + CRASH_CAM_S + RESPAWN_S + GHOST_S - rt);
  tel.paceKn = 12;

  // calls
  let radio = -1;
  for (let i = 0; i < RADIO.length; i++) if (t >= RADIO[i][0]) radio = i;
  tel.radioId = radio + 1;
  tel.radioText = radio < 0 ? '' : `“${RADIO[radio][1]}”`;
  tel.radioTo = radio < 0 ? '' : RADIO[radio][2] ?? '';
  let toast = -1;
  for (let i = 0; i < TOASTS.length; i++) if (t >= TOASTS[i][0]) toast = i;
  tel.toastId = toast + 1;
  tel.toastTitle = toast < 0 ? '' : TOASTS[toast][1];
  tel.toastDetail = toast < 0 ? '' : TOASTS[toast][2];
}

/** the moment the results screen takes over */
export const T_RESULTS = CROSS[PLAYER][LAPS - 1] + T_GREEN + 3;
