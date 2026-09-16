/**
 * THE NPC PILOT (§T.186). Runs INSIDE the boat step core (`BoatSimCore.step`, every transport), once per boat per
 * tick, before the drives are set: reads the tick-k pose, the tick-k WORLD snapshot of every boat, the sea the
 * worker's own CpuOcean mirror floats the boats on, its race standing (AI IN) and its memory (AI OUT); writes its
 * memory back and returns drive angle + throttle. Deterministic by construction: sim time and buffer contents are
 * its only inputs; no wall clock, camera or frame rate (§V2). Memory lives in the buffer (aiBlock.ts header).
 *
 *  line     one racing line + speed profile per risk LEVEL (margin, curvature use and braking move with risk);
 *           the boat rides the level its current risk picks (hysteresis), tracked by station fraction.
 *  steer    pure pursuit (Coulter 1992): lookahead L = clamp(lookaheadS·V, 25, 70) m (≈ 2 s: the helm + yaw lag needs L ≫ √2·V·τ), κ = 2 sin α / L, mapped to a
 *           drive angle through the MEASURED steady-turn table, a small yaw-rate damper, clamped to the measured
 *           no-hook lock schedule (capability.ts), eased past 22° of heel, 40 % for 1.5 s after a placement,
 *           slewed at 15°/s.
 *  throttle PI on the profile speed V·0.6 s ahead, with the measured hold throttle as feed-forward; reverse gear
 *           as the only brake.
 *  waves    every 3 ticks: the true surface at this tick along the path the boat will cover in
 *           t = 0, 0.3, 0.6, 0.9, 1.2 s (never a future-time read: that steps the shared mirror); predicted airtime 2·V·slope/g and trough→face slope change (stuff) above
 *           the archetype's tolerance ⇒ throttle lift (× wave skill) and bow-down trim request; an exposed ramp
 *           under the tolerance ⇒ a jump-loving archetype holds throttle.
 *  risk     base + sector bias + catch-up (trailing ⇒ riskier LEVEL and tolerance — never more thrust: the throttle
 *           is the physics' own −0.3..1 and nothing here touches power) + recovery mood.
 *  mistakes seeded mulberry32 in the buffer: throttle fumble, missed wave read, over-speed into a corner.
 *  traffic  (§T.213) pass or follow: the boat in this lane ahead is passed on the widest berth the corridor room has
 *           (never below AVOID_LAT) off ITS offset, closing no nearer than the gap while she is still behind it; no side
 *           has a hull's berth ⇒ follow at the gap. Overlapping boats keep AVOID_LAT apart, race-long. Avoidance from WORLD poses (closest approach over
 *           2 s < 8 m ⇒ lateral offset away, held 1.5 s); blocking: someone faster 4–35 m behind ⇒ offset to the inside of
 *           the next turn (× aggression). Offsets stay inside the corridor room the line was built with (clamped outright
 *           where a corridor binds) and never lead the boat's own cross-track by more than OFFSET_LEAD; blocking never
 *           moves toward an overlapping boat. A finished boat pulls aside before it slows.
 *  keep-outs static solids (keepOut.ts, the page's colliders): the line keeps LINE_CLEAR off them, the room for offsets
 *           ends ROOM_CLEAR short of them, and the pursuit chord (boat → target) is pushed PURSUIT_CLEAR clear.
 *  grid     rolling start (GO < 0 or 0): the pilot holds its grid slot behind the pace boat — the slot race/rollingStart
 *           computes, from the pace line and start params in the setup and the pilot's own clock of rolling ticks
 *           (AI.ROLL) — pursuing the pace line at its column, speed set by the along-line error to the slot. At green
 *           it re-projects onto its racing line.
 *  wakes    (§T.207 wake field layouts, §T.213) the other boats' wake field is added to the wave read's surface (a wake
 *           crest lifts like a wave ramp). What a wake mostly does is ROLL her, so its slope across the path takes helm
 *           lock away instead of throttle (AI.WAKE_BRACE), and how wide she goes by a boat grows as that boat slows (its
 *           pattern scales as F/ρU²): a beam's width past a quick one, its whole Kelvin wedge past one at hump speed.
 *           The GAP she holds behind it runs from FOLLOW_GAP on a straight to that wedge-scaled room as the line bends
 *           (GAP_CORNER_S ahead) — a wake astern is a corner problem, and a gap held flat is the pack's spread; the
 *           SPEED cap that matches her to a boat ahead is the hull's own lane (LANE_HALF), never its wake.
 *  trim     neutral at launch, bow down in corners and lifts, bow up on a fast straight, slewed; returned in
 *           `PilotOutput.trim`, the seam's unit trim (−1..1) for `unitTrimToRad`.
 */
import { SIM_DT } from '../../core/loop';
import { B, AI_OUT_LEN, type BoatSimLayout } from '../../sim-worker/layout';
import type { Rigid6State } from '../../sea-physics/rigidBody';
import { raceParams } from '../params';
import { gridDepth, type RollingStartParams } from '../rollingStart';
import type { Course } from '../types';
import { AI, AI_IN } from './aiBlock';
import { ARCHETYPES, type Archetype, type ArchetypeId } from './archetypes';
import { HELM_RATE, holdThrottle, lockLimit, steerForCurvature } from './capability';
import { buildKeepOuts, keepOutPush, type CapsuleLike, type KeepOuts, type Push } from './keepOut';
import { buildRacingLine, nearestSample, ROOM_CAP, type RacingLine } from './line';
import { cornerSpeed, speedProfile } from './profile';
import { WakeField } from '../../wake/wakeField';

export const LINE_LEVELS = 5;
const G = 9.81;
const AVOID_R = 8;
/**
 * Seconds of clock AI.ROLL counts back from at green (it goes negative there and climbs to 0). §T.202 gated the opening
 * caution's separation rules on it — a bunched grid touched and hooked boats without them — and §T.213 made both rules
 * race-long (pass/follow), so nothing gates on it any more: it is the "since green" clock the buffer publishes.
 */
const CAUTION_S = 40;
/** lateral separation (m, CG to CG) a pilot keeps from a boat overlapping it along the line: two 2.5 m beams + yaw slack */
const AVOID_LAT = 9;
/** |along| (m) inside which another boat overlaps this one: a 12 m hull, bow to stern */
const ALONGSIDE = 13;
/**
 * CG-to-CG metres a pilot keeps behind a boat in its lane (|lat| < FOLLOW_LANE): a 12 m hull + 2 m. Two boats nose to tail at
 * 12.5 m through G1 touched when the leader yawed into the gate, and the follower hooked (Tower Reach, calm)
 */
const FOLLOW_GAP = 14;
const WAVE_T = [0, 0.3, 0.6, 0.9, 1.2] as const;
const BOW_AHEAD = 7;
const HEEL_EASE = (22 * Math.PI) / 180;
const HEEL_ZERO = (38 * Math.PI) / 180;
const ROLL_DEADBAND = Math.sin((20 * Math.PI) / 180);
const ROLL_KP = 0.8;
const ROLL_KD = 0.15;
/** always-on roll damper gain (helm per rad/s of roll rate) and the wave skill every pilot keeps her boat under her with */
const ROLL_DAMP = 0.2;
const ROLL_SKILL_MIN = 0.6;
/** the helm's own heel limits (§T.213, directional): eased from HELM_HEEL_EASE to nothing at HELM_HEEL_ZERO, on the heel HELM_HEEL_TAU ahead */
const HELM_HEEL_EASE = (18 * Math.PI) / 180;
const HELM_HEEL_ZERO = (30 * Math.PI) / 180;
const HELM_HEEL_TAU = 0.5;
/** seconds after a placement (grid, respawn) the helm is held to a fraction of the lock while the hull settles */
const SETTLE_S = 1.5;
/** metres the pursuit chord keeps off a static solid's surface (a half beam + slack) */
const PURSUIT_CLEAR = 4;
/** the largest sideways move of the pursuit target a keep-out may ask for (m) */
const PURSUIT_SHIFT_MAX = 25;
/** rolling start: m/s of speed per metre of along-line error to the slot */
const SLOT_GAIN = 0.35;
/** lookahead (m) per metre of distance off the (offset) line: far off it, the pursuit aims further along so the arc back is one the boat can turn */
const RECOVER_LOOK = 2.5;
/**
 * WAKES (§T.207 wake field: every hull floats on every other boat's wake; §T.213 seed sweeps). A hull's Kelvin pattern
 * scales as F/(ρU²), so how much water a rival throws depends on how fast she is going. MEASURED on the very field the
 * pilot reads (tests/raceAiSweep seed sweeps, docs/speedboat/npc-ai.md): a 24 m/s source leaves ≤ 0.1 m and ≤ 3 % of roll
 * slope outside |Y| 6 m; an 8–11 m/s one (a corner, a queue) leaves 0.2–0.3 m and 6–7 % right along its cusp line
 * (tan 19.47°·X out) to 60 m astern — and a 12 m hull that meets that at 12–20 m/s with the helm on goes over.
 * So the lane a boat owns is its own beam when it is quick and its whole wedge when it is slow, and the spacing behind it
 * grows the same way.
 */
const WAKE_TAN = Math.tan((19.47 * Math.PI) / 180);
const WAKE_BEAM = 4;
/** m/s: at and above this a source's wake is its own beam wide; at WAKE_SLOW_LOW and below it is the whole wedge */
const WAKE_SLOW_TOP = 22;
const WAKE_SLOW_LOW = 10;
/** half-width (m) of the lane a quick boat ahead owns: a 12 m hull's beam + tracking slack */
const LANE_HALF = 6;
/** CG-to-CG metres kept behind a boat in this lane: WAKE_GAP_MIN quick, + WAKE_GAP_SLOW at hump speed */
const WAKE_GAP_MIN = 25;
const WAKE_GAP_SLOW = 20;
/** the closing speed allowed per metre inside the gap, and the floors that keep a queue from compounding to a standstill */
const FOLLOW_CLOSE = 0.5;
const FOLLOW_SLACK = 3;
const FOLLOW_FLOOR = 6;
/** how far ahead (s of travel, at least PASS_LOOK_MIN m) a boat in this lane is taken as traffic */
const PASS_LOOK_S = 1.6;
const PASS_LOOK_MIN = 55;
/** m the lateral offset may lead the boat's own cross-track by (§T.213: a bigger step is a pursuit overshoot) */
const OFFSET_LEAD = 4;
/** wake roll slope (m/m across the path, within 0.9 s) where the brace starts, its span to full, and its decay (s) */
const BRACE_ROLL = 0.04;
const BRACE_ROLL_SPAN = 0.06;
const BRACE_HOLD = 0.5;
/** share of the helm lock the full brace takes away, and the cross-track error (m) at which it is released */
const BRACE_LOCK = 0.5;
const BRACE_RELEASE = 8;
/** line curvature (1/m) over the next CORNER_S of travel above which the pilot counts it as cornering */
const CORNER_K = 1 / 400;
const CORNER_S = 2;
/** s of travel the FOLLOWING GAP looks ahead over: the room behind a boat has to be open before the helm goes on */
const GAP_CORNER_S = 3;
const HEEL_CORNER = (10 * Math.PI) / 180;
/** unit trim: bow down in a corner / rough water (measured flat water at −0.25: R −3 % at 18–30 m/s), bow up on a fast straight
 * (top speed 33.9 → 35.1 m/s at +0.3; +1.0 blows out to 29.7), slewed at TRIM_RATE /s */
const TRIM_CORNER = -0.2;
const TRIM_STRAIGHT = 0.3;
const TRIM_RATE = 1.5;
/** the running mean of predicted airtime (AI.SEA, s) up to which the water counts as smooth: calm (synthetic course) stays ≤ 0.18 */
const SEA_SMOOTH = 0.25;

/** the rolling start as a pilot sees it: the pace line (flat, structured-clone safe) and the grid geometry */
export interface PilotStart {
  /** pace line vertices x, z and arc length at each vertex */
  x: Float64Array;
  z: Float64Array;
  cum: Float64Array;
  paceSpeed: number;
  /** metres along the pace line the pace boat starts at (race/rollingStart gridDepth) */
  paceStart: number;
  firstRowGap: number;
  rowSpacing: number;
  columnSpacing: number;
  gridColumns: number;
  /** grid index per fleet boat index (race/raceSession grid order: fleet index = grid index) */
  grid: Int32Array;
}

export interface LineLevel {
  risk: number;
  margin: number;
  latUse: number;
  brakeUse: number;
  line: RacingLine;
  speed: Float64Array;
}

/** structured-clone-safe: crosses to a worker in the init message */
export interface PilotSetup {
  version: 1;
  seed: number;
  /** false ⇒ trailing never raises risk (the A/B control for the catch-up test) */
  catchUp: boolean;
  levels: LineLevel[];
  /** per fleet boat index; null = not piloted (the player, a pace boat) */
  boats: (Archetype | null)[];
  /** rolling-start slot hold, or null (no pace line) */
  start: PilotStart | null;
  /** static solids to keep clear of, or null (open water) */
  keepOuts: KeepOuts | null;
}

/** what risk does to the line: margin off the poles, share of the measured turning, braking point */
export function levelShape(risk: number): { margin: number; latUse: number; brakeUse: number } {
  return { margin: 7 - 3.5 * risk, latUse: 0.72 + 0.2 * risk, brakeUse: 0.3 + 0.6 * risk };
}

export interface PilotSetupOptions {
  seed: number;
  catchUp?: boolean;
  /** the page's static colliders (page/course.ts CourseWorld.colliders): the lines, room and pursuit keep clear of them */
  colliders?: readonly CapsuleLike[];
  /** rolling-start params (default raceParams.start) */
  start?: RollingStartParams;
  /** grid index per fleet boat (default: fleet index, the race session's grid order) */
  grid?: readonly number[];
}

function pilotStart(course: Course, racers: number, p: RollingStartParams, grid: readonly number[] | undefined): PilotStart | null {
  const pts: [number, number][] = [];
  for (const q of course.paceLine) {
    const l = pts[pts.length - 1];
    if (!l || Math.hypot(q[0] - l[0], q[1] - l[1]) > 1e-9) pts.push([q[0], q[1]]);
  }
  if (pts.length < 2) return null;
  const cum = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const paceStart = gridDepth(p, racers);
  if (cum[pts.length - 1] < paceStart) return null;
  return {
    x: Float64Array.from(pts, (q) => q[0]),
    z: Float64Array.from(pts, (q) => q[1]),
    cum,
    paceSpeed: p.paceSpeed,
    paceStart,
    firstRowGap: p.firstRowGap,
    rowSpacing: p.rowSpacing,
    columnSpacing: p.columnSpacing,
    gridColumns: p.gridColumns,
    grid: Int32Array.from({ length: racers }, (_, i) => grid?.[i] ?? i),
  };
}

export function buildPilotSetup(course: Course, roster: readonly (ArchetypeId | Archetype | null)[], opts: PilotSetupOptions): PilotSetup {
  const keepOuts = opts.colliders ? buildKeepOuts(opts.colliders) : null;
  const levels: LineLevel[] = [];
  for (let k = 0; k < LINE_LEVELS; k++) {
    const risk = k / (LINE_LEVELS - 1);
    const shape = levelShape(risk);
    const line = buildRacingLine(course, { margin: shape.margin, keepOuts });
    levels.push({ risk, ...shape, line, speed: speedProfile(line, shape) });
  }
  return {
    version: 1,
    seed: opts.seed >>> 0,
    catchUp: opts.catchUp ?? true,
    levels,
    boats: roster.map((r) => (r === null ? null : typeof r === 'string' ? { ...ARCHETYPES[r] } : { ...r })),
    start: pilotStart(course, roster.length, opts.start ?? raceParams.start, opts.grid),
    keepOuts,
  };
}

export interface SeaHeight {
  heightAt(x: number, z: number, time: number): number;
}

export interface PilotOutput {
  /** drive angle, rad (+ = bow to port) — straight into HullWater.setControls */
  steer: number;
  throttle: number;
  /** unit drive trim −1 bow down .. +1 bow up (AI.TRIM) — for `HullWater.setControls(steer, throttle, unitTrimToRad(trim))`; written every tick */
  trim?: number;
}

const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);

function rng(f: Float64Array, o: number): number {
  let t = (f[o] + 0x6d2b79f5) >>> 0;
  f[o] = t;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export class RacePilot {
  readonly setup: PilotSetup;
  // scratch for line lookups (no allocation per tick)
  private px = 0;
  private pz = 0;
  private pnx = 0;
  private pnz = 0;
  private readonly push: Push = { x: 0, z: 0, depth: 0 };
  /** scratch: the other boats' wakes along this boat's path (its node-table cache is a pure function of the records) */
  private readonly wake = new WakeField();

  constructor(setup: PilotSetup) {
    if (setup.version !== 1) throw new Error(`race pilot: setup version ${setup.version}`);
    this.setup = setup;
  }

  drives(i: number): boolean {
    return i < this.setup.boats.length && this.setup.boats[i] !== null;
  }

  /** line point + starboard normal at arc length s (wrapped), linear between samples */
  private at(line: RacingLine, s: number): number {
    const n = line.n;
    let u = s / line.ds;
    u = ((u % n) + n) % n;
    const i = Math.floor(u);
    const j = (i + 1) % n;
    const t = u - i;
    this.px = line.x[i] + (line.x[j] - line.x[i]) * t;
    this.pz = line.z[i] + (line.z[j] - line.z[i]) * t;
    this.pnx = line.tz[i];
    this.pnz = -line.tx[i];
    return i;
  }

  /** pace line point (px, pz) + PORT normal (pnx, pnz) = (tz, −tx) at arc length s (extrapolated past either end) */
  private paceAt(st: PilotStart, s: number): void {
    const n = st.x.length;
    let i = 0;
    while (i < n - 2 && st.cum[i + 1] < s) i++;
    const l = st.cum[i + 1] - st.cum[i];
    const tx = (st.x[i + 1] - st.x[i]) / l;
    const tz = (st.z[i + 1] - st.z[i]) / l;
    const u = s - st.cum[i];
    this.px = st.x[i] + tx * u;
    this.pz = st.z[i] + tz * u;
    this.pnx = tz;
    this.pnz = -tx;
  }

  /** arc length of the pace line point nearest (x, z) (segments extended past both ends) */
  private paceProject(st: PilotStart, x: number, z: number): number {
    const n = st.x.length;
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < n - 1; i++) {
      const ux = st.x[i + 1] - st.x[i];
      const uz = st.z[i + 1] - st.z[i];
      const l = Math.hypot(ux, uz);
      let t = ((x - st.x[i]) * ux + (z - st.z[i]) * uz) / (l * l);
      if (i > 0) t = Math.max(0, t);
      if (i < n - 2) t = Math.min(1, t);
      const d = Math.hypot(st.x[i] + ux * t - x, st.z[i] + uz * t - z);
      if (d < bd) {
        bd = d;
        best = st.cum[i] + t * l;
      }
    }
    return best;
  }

  private levelFor(risk: number): number {
    return Math.round(clamp(risk, 0, 1) * (LINE_LEVELS - 1));
  }

  /** global projection, rejecting samples whose tangent points against the boat's heading */
  private project(line: RacingLine, x: number, z: number, fx: number, fz: number): number {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < line.n; i++) {
      const dx = line.x[i] - x;
      const dz = line.z[i] - z;
      const d = dx * dx + dz * dz + (line.tx[i] * fx + line.tz[i] * fz < 0 ? 1e6 : 0);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  control(i: number, L: BoatSimLayout, state: Readonly<Rigid6State>, sea: SeaHeight, time: number, justReset: boolean, out: PilotOutput): void {
    const arch = this.setup.boats[i] as Archetype;
    const f = L.f64;
    const a = L.aiOffset(i);
    const ai = a + AI_OUT_LEN;
    const DT = SIM_DT;
    const x = state.position[0];
    const z = state.position[2];
    const vx = state.velocity[0];
    const vz = state.velocity[2];
    const V = Math.hypot(vx, vz);
    const [qx, qy, qz, qw] = state.quaternion;
    const upY = 1 - 2 * (qx * qx + qz * qz);
    const fx = 2 * (qx * qz + qw * qy);
    const fz = 1 - 2 * (qx * qx + qy * qy);
    const valid = f[ai + AI_IN.VALID] === 1;
    const gap = valid ? f[ai + AI_IN.GAP_TO_LEADER] : 0;
    const stCode = valid ? f[ai + AI_IN.STATE] : 0;
    const go = valid ? f[ai + AI_IN.GO] : 1;

    // ── projection onto the line ───────────────────────────────────────────────────────────────────────────
    let level = f[a + AI.LEVEL];
    const first = f[a + AI.INIT] !== 1;
    if (first || justReset) {
      if (first) {
        level = this.levelFor(arch.risk);
        let seed = (Math.imul(this.setup.seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(i + 1, 0xc2b2ae35)) >>> 0;
        if (seed === 0) seed = 0x1234567;
        f[a + AI.RNG] = seed;
        f[a + AI.MISTAKE_T] = 0;
        f[a + AI.MISTAKE_KIND] = 0;
        f[a + AI.RECOVERY_T] = 0;
        f[a + AI.STATION] = 0;
      } else {
        f[a + AI.RECOVERY_T] = arch.recoveryS;
      }
      const line = this.setup.levels[level].line;
      const idx = this.project(line, x, z, fx, fz);
      const frac = idx / line.n;
      const old = f[a + AI.STATION];
      let d = frac - (old - Math.floor(old));
      d -= Math.round(d);
      f[a + AI.STATION] = first ? frac : old + d;
      f[a + AI.INTEGRAL] = 0;
      f[a + AI.STEER] = 0;
      f[a + AI.OFFSET] = 0;
      f[a + AI.AVOID_T] = 0;
      f[a + AI.WAVE_LIFT] = 0;
      f[a + AI.JUMP] = 0;
      f[a + AI.WAKE_BRACE] = 0;
      if (first) {
        f[a + AI.SEA] = 0;
        f[a + AI.ROLL] = 0;
      }
      f[a + AI.INIT] = 1;
    }
    // rolling start: the pilot's own clock of capped ticks; at green, a global re-projection onto the racing line (the
    // formation ran on the pace line, which the tracking window may have lost)
    const st = this.setup.start;
    let greenMerge = false;
    const rolling = st !== null && valid && go <= 0 && stCode !== 1 && stCode !== 2;
    if (rolling) {
      if (go < 0) f[a + AI.ROLL] += DT;
    } else if (f[a + AI.ROLL] < 0) {
      f[a + AI.ROLL] = Math.min(0, f[a + AI.ROLL] + DT);
    } else if (f[a + AI.ROLL] > 0) {
      f[a + AI.ROLL] = -CAUTION_S;
      greenMerge = true;
      const ln = this.setup.levels[level].line;
      const idx = this.project(ln, x, z, fx, fz);
      const old = f[a + AI.STATION];
      let d = idx / ln.n - (old - Math.floor(old));
      d -= Math.round(d);
      f[a + AI.STATION] = old + d;
    }
    let lv = this.setup.levels[level];
    let line = lv.line;
    const track = (): { idx: number; s: number } => {
      // the sample hint is the station's fraction of this level (STATION is kept to ± one sample of the last match)
      const hf = f[a + AI.STATION] - Math.floor(f[a + AI.STATION]);
      const hint = Math.round(hf * line.n) % line.n;
      const win = Math.ceil((V * DT * 4 + 24) / line.ds);
      const idx = nearestSample(line, x, z, hint, win);
      const along = (x - line.x[idx]) * line.tx[idx] + (z - line.z[idx]) * line.tz[idx];
      let s = idx * line.ds + clamp(along, -line.ds, line.ds);
      s = ((s % line.length) + line.length) % line.length;
      const old = f[a + AI.STATION];
      let d = s / line.length - (old - Math.floor(old));
      d -= Math.round(d);
      f[a + AI.STATION] = old + d;
      return { idx, s };
    };
    let { idx, s } = track();

    // ── risk ───────────────────────────────────────────────────────────────────────────────────────────────
    const sheltered = line.sheltered[idx] === 1;
    const trail = this.setup.catchUp && valid ? clamp((gap - 1) / 6, 0, 1) : 0;
    const recovering = f[a + AI.RECOVERY_T] > 0;
    const risk = clamp(arch.risk + (sheltered ? arch.shelteredBias : arch.exposedBias) + trail * arch.catchUp + (recovering ? arch.recoveryRisk : 0), 0, 1);
    f[a + AI.RECOVERY_T] = Math.max(0, f[a + AI.RECOVERY_T] - DT);
    f[a + AI.RISK] = risk;
    const want = risk * (LINE_LEVELS - 1);
    if (Math.abs(want - level) > 0.7) {
      level = this.levelFor(risk);
      lv = this.setup.levels[level];
      line = lv.line;
      ({ idx, s } = track());
    }
    f[a + AI.LEVEL] = level;
    const nx = line.tz[idx];
    const nz = -line.tx[idx];
    const xte = (x - line.x[idx]) * nx + (z - line.z[idx]) * nz;
    f[a + AI.CROSS_TRACK] = xte;
    // green: the columns do not snap onto one line — each boat starts from the offset it is at and merges at the offset
    // slew, the alongside rule keeping the pair apart (a snap merged the columns at 12 m/s lateral and hooked two boats)
    if (greenMerge) f[a + AI.OFFSET] = xte;

    // ── mistakes (seeded) ──────────────────────────────────────────────────────────────────────────────────
    if (f[a + AI.MISTAKE_T] > 0) {
      f[a + AI.MISTAKE_T] -= DT;
      if (f[a + AI.MISTAKE_T] <= 0) f[a + AI.MISTAKE_KIND] = 0;
    } else if (rng(f, a + AI.RNG) < (arch.mistakesPerMin / 60) * (1 + risk) * DT) {
      f[a + AI.MISTAKE_KIND] = 1 + Math.floor(rng(f, a + AI.RNG) * 3);
      f[a + AI.MISTAKE_T] = 0.6 + rng(f, a + AI.RNG) * 1.2;
    }
    const mistake = f[a + AI.MISTAKE_KIND];
    const ticks = f[a + AI.TICKS] + 1;
    f[a + AI.TICKS] = ticks;

    // ── upset / crashed: cut throttle, centre the helm, wait for the race logic's respawn ────────────────────
    const upset = upY < 0.5 || stCode === 1 || stCode === 2;
    f[a + AI.UPSET] = upset ? 1 : 0;
    if (upset) {
      const prev = f[a + AI.STEER];
      const steer = prev - clamp(prev, -HELM_RATE * DT, HELM_RATE * DT);
      f[a + AI.STEER] = steer;
      f[a + AI.THROTTLE] = 0;
      f[a + AI.INTEGRAL] = 0;
      f[a + AI.WAVE_LIFT] = 0;
      f[a + AI.TRIM] = 0;
      out.steer = steer;
      out.throttle = 0;
      out.trim = 0;
      return;
    }

    // ── traffic: avoidance and blocking from the WORLD snapshot ─────────────────────────────────────────────
    const ltx = line.tx[idx];
    const ltz = line.tz[idx];
    let avoid = 0;
    let beside = 0;
    let besideNeed = 0;
    let followCap = Infinity;
    let overlapPlus = false;
    let overlapMinus = false;
    let blocking = false;
    // cornering: the line bends within CORNER_S of travel, or she is already laid over
    const tilt = Math.acos(clamp(upY, -1, 1));
    let cornerK = 0;
    // and the same read over GAP_CORNER_S, for how much room she wants behind a boat by the time the line bends
    let gapK = 0;
    for (let q = 0, c = Math.ceil((V * GAP_CORNER_S) / line.ds), cc = Math.ceil((V * CORNER_S) / line.ds); q <= c; q++) {
      const k = Math.abs(line.kappa[(idx + q) % line.n]);
      if (q <= cc && k > cornerK) cornerK = k;
      if (k > gapK) gapK = k;
    }
    const cornering = cornerK > CORNER_K || tilt > HEEL_CORNER;
    const cornerNear = clamp(Math.max(gapK / CORNER_K, tilt / HEEL_CORNER), 0, 1);
    const wakes = L.spec.wakeField === true;
    /** the boat in this lane ahead: how far along, across, its speed along this line and over ground, its lane and how slow it is */
    let aheadAlong = Infinity;
    let aheadLat = 0;
    let aheadU = 0;
    let aheadLane = 0;
    let aheadSpeed = 0;
    let aheadSlow = 0;
    for (let j = 0; j < L.spec.boats && !rolling; j++) {
      if (j === i) continue;
      const w = L.worldPoseOffset(j);
      if (f[w + 3] === 0 && f[w + 4] === 0 && f[w + 5] === 0 && f[w + 6] === 0) continue; // never placed
      const dx = f[w] - x;
      const dz = f[w + 2] - z;
      if (dx * dx + dz * dz > 3600) continue;
      const along = dx * ltx + dz * ltz;
      const lat = dx * nx + dz * nz;
      const rvx = f[w + 7] - vx;
      const rvz = f[w + 9] - vz;
      const rv2 = rvx * rvx + rvz * rvz;
      const tStar = rv2 > 1e-6 ? clamp(-(dx * rvx + dz * rvz) / rv2, 0, 2) : 0;
      const cx = dx + rvx * tStar;
      const cz = dz + rvz * tStar;
      const dmin = Math.hypot(cx, cz);
      if (Math.abs(along) < ALONGSIDE && Math.abs(lat) < AVOID_LAT) {
        // a boat overlapping this one on that side: blocking never moves toward it (a blocker covering the inside of T2
        // leaned on a rival overlapping it there for 8 s and hooked)
        if (lat >= 0) overlapPlus = true;
        else overlapMinus = true;
      }
      if (Math.abs(along) < ALONGSIDE && Math.abs(lat) < AVOID_LAT) {
        // alongside: keep AVOID_LAT of lateral separation (both boats do; a dead-level pair splits by fleet index)
        const need = AVOID_LAT - Math.abs(lat);
        if (need > besideNeed) {
          besideNeed = need;
          beside = lat > 0 || (lat === 0 && j > i) ? -1 : 1;
        }
      }
      const uj = f[w + 7] * ltx + f[w + 9] * ltz;
      // HOW BIG ITS WAKE IS: a hull's Kelvin pattern grows as F/(ρU²) — measured on the field this pilot reads, a 24 m/s source
      // puts ≤ 0.1 m and ≤ 3 % of roll slope outside |Y| 6 m, a 8–11 m/s one 0.2–0.3 m and 6–7 % right along its cusp
      // (0.35·X out) to 60 m astern. So the lane a slow boat owns is its wedge, a fast one's is its own beam.
      const slowJ = wakes && uj >= 2 ? clamp((WAKE_SLOW_TOP - uj) / (WAKE_SLOW_TOP - WAKE_SLOW_LOW), 0, 1) : 0;
      const laneJ = LANE_HALF + slowJ * Math.max(0, WAKE_TAN * along + WAKE_BEAM - LANE_HALF);
      if (along > 0 && along < Math.max(PASS_LOOK_S * V, PASS_LOOK_MIN) && Math.abs(lat) < Math.max(AVOID_LAT, laneJ + 2) && along < aheadAlong) {
        aheadAlong = along;
        aheadLat = lat;
        aheadU = uj;
        aheadSpeed = Math.hypot(f[w + 7], f[w + 9]);
        aheadLane = laneJ;
        aheadSlow = slowJ;
      }
      if (dmin < AVOID_R && along > -6) {
        const latAt = cx * nx + cz * nz;
        const cand = (latAt >= 0 ? -1 : 1) * 8 * ((AVOID_R - dmin) / AVOID_R);
        if (Math.abs(cand) > Math.abs(avoid)) avoid = cand;
      } else if (along < -4 && along > -35 && Math.abs(lat) < 12 && rvx * ltx + rvz * ltz > 0.5) {
        blocking = true;
      }
    }
    // far off the line (an overshoot, traffic, a respawn) the 25 m floor asked for an arc tighter than the boat turns at any
    // speed: the off-line corner cap then reversed a rookie to 4 m/s, 30 m off her line, for 15 s (Tower Reach, G5→G6; the
    // synthetic lap: 8 s lost after a mark). 1.5× still crawled; 2.5× and 3× both gave laps within 2 %.
    const Ld = clamp(Math.max(arch.lookaheadS * V, RECOVER_LOOK * Math.abs(xte - f[a + AI.OFFSET])), 25, 70);
    this.at(line, s + Ld);
    // rolling start: this boat's slot on the pace line (race/rollingStart gridSlotPose: rows behind the pace boat along
    // the line, columns abreast, column 0 to starboard) and the pursuit point at the slot's column, Ld ahead of the boat
    let slotErr = 0;
    let slotLat = 0;
    if (rolling && st !== null) {
      const g = st.grid[i] ?? i;
      const row = Math.floor(g / st.gridColumns);
      const col = g % st.gridColumns;
      const sSlot = st.paceStart + f[a + AI.ROLL] * st.paceSpeed - st.firstRowGap - row * st.rowSpacing;
      const sBoat = this.paceProject(st, x, z);
      slotErr = sSlot - sBoat;
      slotLat = (col - (st.gridColumns - 1) / 2) * st.columnSpacing;
      // (pnx, pnz) = (tz, −tx), the pace line's PORT normal: gridSlotPose's lateral, + to port
      this.paceAt(st, sBoat + Ld);
    }
    let roomP = Infinity;
    let roomS = Infinity;
    for (let q = idx, c = 0; c <= Math.ceil((Ld + BOW_AHEAD) / line.ds); c++, q = (q + 1) % line.n) {
      if (line.roomPort[q] < roomP) roomP = line.roomPort[q];
      if (line.roomStbd[q] < roomS) roomS = line.roomStbd[q];
    }
    let target: number;
    let offset = f[a + AI.OFFSET];
    // PASS / FOLLOW (§T.213): a boat in this lane ahead (|lat| < PASS_LAT, within passLook). Faster than it ⇒ take the
    // nearer side that fits the room, PASS_LAT off its offset, closing no nearer than the gap until laterally clear; no
    // side fits ⇒ follow at the gap (longer in a corner: the stern hollow)
    let passTarget = NaN;
    if (aheadAlong < Infinity) {
      // HOW WIDE SHE WANTS TO GO BY, AND HOW WIDE THE CORRIDOR CAN GIVE (§T.213 follow-up). The berth she wants is that
      // boat's lane plus slack — its beam when it is quick, its whole Kelvin wedge at hump speed. That wedge is 15–20 m
      // by 40 m astern and the corridor is ROOM_CAP (12 m) wide, so "no side fits ⇒ follow" refused the pass exactly
      // where passing matters: behind a boat at hump speed, in a corner queue. She now takes the widest berth the
      // corridor HAS, never less than AVOID_LAT — the separation the alongside rule already keeps between two hulls.
      // Crossing the wedge at that width is what the brace, the roll damper and the directional heel limit are for.
      const wantLat = Math.max(AVOID_LAT, aheadLane + 2);
      // THE WAKE GAP IS FOR THE CORNER, NOT THE STRAIGHT (§T.213 follow-up). What it was measured against is a hull in
      // another's stern hollow WITH HELM ON — §T.207's lee 16 m behind a blocker through a sweeper went 18° → 38° of heel
      // in 0.4 s — while a straight-line wake crossing peaks at 8° of tilt at any speed (§T.213 #3, both measured). Held
      // flat, that gap IS the pack spread: six of them down a queue is 150–270 m, and 270 m at 27 m/s is 10 s of a 13 s
      // finish spread ([M] with the cap removed entirely the spread falls to 7.3 s — and the boats touch 1034 times in
      // 24 races instead of 231, so the cap has to stay; what can go is holding a corner's room down a straight).
      // It opens over GAP_CORNER_S of travel, so the room is there before the helm is.
      const gapM = wakes ? FOLLOW_GAP + (WAKE_GAP_MIN - FOLLOW_GAP + WAKE_GAP_SLOW * aheadSlow) * cornerNear : FOLLOW_GAP;
      const uP = (s + V) / line.ds;
      const vProf = lv.speed[((Math.floor(uP) % line.n) + line.n) % line.n];
      const jOff = xte + aheadLat;
      if (Math.max(vProf, V) > aheadU + 0.5) {
        let best = NaN;
        let k = 0;
        for (let q = 0, span = Math.round(150 / line.ds); q < span; q++) k += line.kappa[(idx + q) % line.n];
        for (const side of [1, -1]) {
          const avail = side > 0 ? Math.max(0, roomS - 1) - jOff : jOff + Math.max(0, roomP - 1);
          if (avail < AVOID_LAT) continue; // not even a hull's berth on this side
          const tgt = jOff + side * Math.min(wantLat, avail);
          if (Number.isNaN(best) || Math.abs(tgt - offset) < Math.abs(best - offset) - 0.5 || (Math.abs(Math.abs(tgt - offset) - Math.abs(best - offset)) <= 0.5 && Math.sign(k) === side)) best = tgt;
        }
        passTarget = best;
      }
      // still behind it ⇒ close no nearer than the gap; the cap is never below the leader's own pace (a cap under it
      // compounds down a queue into a standstill, and a queue crawling at 6 m/s is a queue of hump-speed wakes).
      // THE SPEED CAP USES THE HULL'S OWN LANE, NOT ITS WAKE (§T.213 follow-up): being inside a boat's wedge but clear of
      // the boat is not a reason to match its speed — it is a reason to be out of the wedge, which the berth above and
      // the brace below are for. [M] with the wedge gating the cap, every grid row behind the leader lost ~2 s of lap
      // per row, cumulatively (+2.4 s row 1 … +6.4 s row 3 over 6 seeds, wake field on vs off), the finishing order was
      // the grid order in all 24 Tower Reach races, and the profile speed the traffic cap took off a follower doubled
      // (0.9–1.8 → 2.3–2.9 m/s). Nothing passed, and the spread WAS that loss.
      if (Math.abs(aheadLat) < LANE_HALF) followCap = aheadU + FOLLOW_CLOSE * (aheadAlong - gapM);
      if (followCap < Infinity) followCap = Math.max(followCap, aheadSpeed - FOLLOW_SLACK, Math.min(aheadU, FOLLOW_FLOOR));
    }
    // held up in a lane by a slower boat: pull out to pass (the side away from it), the follow cap lifts once clear of its lane
    if (besideNeed > 0) {
      f[a + AI.AVOID_T] = 1.5;
      target = offset + beside * besideNeed;
    } else if (!Number.isNaN(passTarget) && avoid === 0) {
      f[a + AI.AVOID_T] = 1.5;
      target = passTarget;
    } else if (avoid !== 0) {
      f[a + AI.AVOID_T] = 1.5;
      target = avoid;
    } else if (f[a + AI.AVOID_T] > 0) {
      f[a + AI.AVOID_T] -= DT;
      target = offset;
    } else if (stCode === 4) {
      // finished: out of the way of the boats still racing, to the outside of what comes next
      let k = 0;
      for (let q = 0, span = Math.round(150 / line.ds); q < span; q++) k += line.kappa[(idx + q) % line.n];
      target = k >= 0 ? -ROOM_CAP : ROOM_CAP;
    } else if (blocking && arch.aggression > 0) {
      let k = 0;
      const span = Math.round(150 / line.ds);
      for (let q = 0; q < span; q++) k += line.kappa[(idx + q) % line.n];
      target = Math.sign(k) * arch.aggression * 6;
      if ((target > offset && overlapPlus) || (target < offset && overlapMinus)) target = offset;
    } else {
      target = 0;
    }
    if (rolling) {
      target = 0;
      offset = 0;
      f[a + AI.AVOID_T] = 0;
    }
    f[a + AI.BLOCKING] = blocking && avoid === 0 && besideNeed === 0 && arch.aggression > 0 ? 1 : 0;
    // the offset must fit the corridor over the whole lookahead, not just at its ends (a gate between them binds),
    // less a metre for tracking error
    target = clamp(target, -Math.max(0, roomP - 1), Math.max(0, roomS - 1));
    // the offset never runs more than OFFSET_LEAD ahead of where the boat actually is: a target the hull is 11 m from is a
    // 20° heading step at the pursuit lookahead, and the overshoot that follows took a boat 30 m off her line (§T.213)
    if (!((target - offset) * (offset - xte) > 0 && Math.abs(offset - xte) >= OFFSET_LEAD)) offset += clamp(target - offset, -3 * DT, 3 * DT);
    // a corridor that binds inside the lookahead (room under the cap) clamps the offset itself, not just its target: an
    // alongside/avoid offset slewing back at 3 m/s from outside the room ran a hothead 1.6 m outside a 36 m chicane gate
    if (roomP < ROOM_CAP || roomS < ROOM_CAP) offset = clamp(offset, -Math.max(0, roomP - 1), Math.max(0, roomS - 1));
    f[a + AI.OFFSET] = offset;

    // ── steer: pure pursuit on the (offset) line ────────────────────────────────────────────────────────────
    const lat = rolling ? slotLat : offset;
    let tgx = this.px + this.pnx * lat;
    let tgz = this.pz + this.pnz * lat;
    // KEEP-OUTS: the chord to the target, every 3 m from 4 m ahead, must stay PURSUIT_CLEAR off every static solid; the
    // deepest intrusion moves the target sideways, away from the solid, scaled out to the target's distance
    const ko = this.setup.keepOuts;
    if (ko !== null) {
      const cx = tgx - x;
      const cz = tgz - z;
      const cl = Math.hypot(cx, cz);
      if (cl > 5) {
        const ux = cx / cl;
        const uz = cz / cl;
        let shift = 0;
        for (let d = 4; d <= cl; d += 3) {
          const qx = x + ux * d;
          const qz = z + uz * d;
          const p = keepOutPush(ko, qx, qz, PURSUIT_CLEAR, this.push);
          if (p.depth > 0) {
            // sideways (starboard of the chord = (uz, −ux)) part of the push, carried out to the target
            const side = ((p.x - qx) * uz - (p.z - qz) * ux) * (cl / d);
            if (Math.abs(side) > Math.abs(shift)) shift = side;
          }
        }
        shift = clamp(shift, -PURSUIT_SHIFT_MAX, PURSUIT_SHIFT_MAX);
        tgx += uz * shift;
        tgz -= ux * shift;
      }
    }
    const courseYaw = V > 3 ? Math.atan2(vx, vz) : Math.atan2(fx, fz);
    let alpha = Math.atan2(tgx - x, tgz - z) - courseYaw;
    alpha = Math.atan2(Math.sin(alpha), Math.cos(alpha));
    const kappa = (2 * Math.sin(alpha)) / Ld;
    const Vs = Math.max(V, 6);
    const hardLock = lockLimit(V);
    const settling = f[a + AI.TICKS] * DT < SETTLE_S || (recovering && f[a + AI.RECOVERY_T] > arch.recoveryS - SETTLE_S);
    let stbd = Math.sign(kappa) * steerForCurvature(Vs, kappa) + 0.4 * (kappa * Vs - state.angularVelocity[1]);
    // roll helm (a skill, × waveSkill): the drives roll her INTO a turn (physics-log T179 r2), so steering away from a
    // heel rights her; only past 20° of heel (a steady turn sits below it), proportional + against roll rate. sinHeel > 0 = starboard side up = heeled to port.
    const sinHeel = 2 * (qx * qy + qw * qz);
    const w = state.angularVelocity;
    const rollRate = w[0] * fx + w[1] * (2 * (qy * qz - qw * qx)) + w[2] * fz;
    // ROLL SKILL FLOOR (§T.213): keeping the boat under her is not an archetype trait — a wake crest can put 60°/s of roll
    // rate on any hull, and a rookie with waveSkill 0.2 had no answer. The roll damper runs at every heel, the righting
    // helm past the deadband; both at max(waveSkill, ROLL_SKILL_MIN).
    const rollSkill = Math.max(arch.waveSkill, ROLL_SKILL_MIN);
    stbd += rollSkill * ROLL_DAMP * rollRate;
    if (Math.abs(sinHeel) > ROLL_DEADBAND) {
      stbd += rollSkill * (ROLL_KP * (sinHeel - Math.sign(sinHeel) * ROLL_DEADBAND) + ROLL_KD * rollRate);
    }
    // heel limits on the helm to starboard (stbd > 0) and to port: symmetric (tilt) unless directional
    // DIRECTIONAL HEEL LIMIT (§T.213): the drives roll her into the turn, so the helm TOWARD the side she is heeled (or
    // rolling) to is eased — on the heel HELM_HEEL_TAU ahead, not the heel now; the righting helm keeps the full lock.
    // The old symmetric tilt limiter took the righting helm away too, and a hull past HEEL_ZERO could only wait.
    const heelPort = Math.asin(clamp(sinHeel, -1, 1)) + rollRate * HELM_HEEL_TAU;
    const settleF = settling ? 0.4 : 1;
    let lockPos = hardLock * clamp((HELM_HEEL_ZERO + heelPort) / (HELM_HEEL_ZERO - HELM_HEEL_EASE), 0, 1) * settleF;
    let lockNeg = hardLock * clamp((HELM_HEEL_ZERO - heelPort) / (HELM_HEEL_ZERO - HELM_HEEL_EASE), 0, 1) * settleF;
    // WAKE BRACE: a wake crest across her path ⇒ cross it with less helm on (upright). Released as she runs off her line,
    // where the helm is what puts her back through the gate (braced to the last metre, boats ran wide and missed).
    const brace = 1 - BRACE_LOCK * f[a + AI.WAKE_BRACE] * clamp(1 - Math.abs(xte - offset) / BRACE_RELEASE, 0, 1);
    lockPos *= brace;
    lockNeg *= brace;
    stbd = clamp(stbd, -lockNeg, lockPos);
    const prevSteer = f[a + AI.STEER];
    let steer = prevSteer + clamp(-stbd - prevSteer, -HELM_RATE * DT, HELM_RATE * DT);
    // easing off past the heel/settle limit gets a second helm-rate's worth: a pilot unwinds faster than she winds on
    // (steer < 0 is a starboard helm)
    if (steer < -lockPos) steer += Math.min(-lockPos - steer, HELM_RATE * DT);
    if (steer > lockNeg) steer -= Math.min(steer - lockNeg, HELM_RATE * DT);
    steer = clamp(steer, -hardLock, hardLock);
    f[a + AI.STEER] = steer;

    // ── throttle: PI on the profile ─────────────────────────────────────────────────────────────────────────
    const u = (s + V * 0.6) / line.ds;
    const n = line.n;
    const i0 = ((Math.floor(u) % n) + n) % n;
    const i1 = (i0 + 1) % n;
    const tt = u - Math.floor(u);
    let vT = lv.speed[i0] + (lv.speed[i1] - lv.speed[i0]) * tt;
    // sea respect (× waveSkill × (1 − risk)): rough water ahead ⇒ a careful pilot runs slower than the flat-water profile
    vT *= 1 - arch.waveSkill * (1 - risk) * clamp((f[a + AI.SEA] - 0.15) / 0.5, 0, 0.4);
    if (mistake === 3) vT *= 1.06;
    if (rolling) vT = clamp(st.paceSpeed + SLOT_GAIN * slotErr, 0, 1e9);
    if (go <= 0) vT = Math.min(vT, -go);
    // finished: the cool-down cap once she is aside (finAside), not on the line the pack is still racing down
    if (stCode === 4 && Math.abs(xte) > 8) vT = Math.min(vT, 15);
    if (!rolling) vT = Math.min(vT, Math.max(0, followCap));
    // OFF THE LINE, SLOW TO THE TURN YOU ARE ACTUALLY ASKING FOR (T196): the profile's corner speed is for the LINE's
    // curvature; a boat knocked off it (a mistake, traffic, a slide) pursues a tighter arc back. Measured on the T196 hull
    // (drives part-surfaced, lock 19°): the rookie held full throttle at lock through a sweep with 12–18° of drift at 20 m/s
    // and ran 46 m wide, missing gates 7 and 10 on laps 2–3. The same measured capability the profile uses, at the
    // pursuit curvature: on the line it is never below the profile, so it only acts when the arc is tighter than the line.
    // Only past 15 m of tracking error (well past the measured 4–6 m near-gate error on the line): closer in the pursuit arc is noisy and
    // capping by it slowed every lap by 3–6 s and reordered the pack.
    if (!rolling && Math.abs(xte - offset) > 15) vT = Math.min(vT, cornerSpeed(kappa, lv.latUse));
    f[a + AI.TARGET_SPEED] = vT;
    const e = vT - V;
    const integ = clamp(f[a + AI.INTEGRAL] + e * DT, -4, 4);
    f[a + AI.INTEGRAL] = integ;
    let thr = holdThrottle(vT, steer) + 0.35 * e + 0.08 * integ;
    // reverse is the brake only while she is (nearly) upright: backing the drives laid over in a turn spun a hothead closing on
    // a rookie (drift 32°, heel 49°) and snapped a rookie braking in a blocker's wake from 30° of heel to 50° the other way
    // (Tower Reach, calm, wakes on)
    thr = clamp(thr, e < -1.5 && tilt <= HEEL_CORNER ? -0.3 : 0, 1);
    if (mistake === 1) thr = Math.min(thr, 0.35);

    // ── wave reading ────────────────────────────────────────────────────────────────────────────────────────
    const exposed = !sheltered;
    if (ticks % 3 === 0) {
      let lift = 0;
      let jump = 0;
      let wakeRollAll = 0;
      if (V > 8) {
        let hPrev = 0;
        let slopePrev = 0;
        let maxAir = 0;
        let stuff = 0;
        let wakeRoll = 0;
        // the other boats' wakes over the path (prepared around its middle; the field culls 16 m around that point)
        const wn = wakes && !rolling ? this.wake.prepare(f, L.wakeWorldOffset(0), L.spec.boats, i, x + vx * 0.6, z + vz * 0.6) : 0;
        for (let k = 0; k < WAVE_T.length; k++) {
          this.at(line, s + BOW_AHEAD + V * WAVE_T[k]);
          const hx = this.px + this.pnx * xte;
          const hz = this.pz + this.pnz * xte;
          // the surface AT THIS TICK: CpuOcean.heightAt(…, t ≠ its time) runs update(t), which rebuilds the mirror
          // and steps the spectrum scheduler — a future-time read would move the sea every boat floats on
          let h = sea.heightAt(hx, hz, time);
          if (wn > 0) {
            // a wake crest is a ramp like any other (the airtime/stuff read below lifts for it); across the path, its roll slope
            h += this.wake.heightAt(hx, hz);
            if (WAVE_T[k] <= 0.9) wakeRoll = Math.max(wakeRoll, Math.abs(this.wake.heightAt(hx + 2 * this.pnx, hz + 2 * this.pnz) - this.wake.heightAt(hx - 2 * this.pnx, hz - 2 * this.pnz)) / 4);
          }
          if (k > 0) {
            const slope = (h - hPrev) / (V * (WAVE_T[k] - WAVE_T[k - 1]));
            if (slope > 0) maxAir = Math.max(maxAir, (2 * V * slope) / G);
            if (k > 1 && slopePrev < 0 && slope > 0) stuff = Math.max(stuff, slope - slopePrev);
            slopePrev = slope;
          }
          hPrev = h;
        }
        wakeRollAll = wakeRoll;
        const tol = arch.airTolerance + 0.35 * risk + (exposed ? 0.3 * arch.jumpAppetite : 0);
        const need = Math.min(1, clamp((maxAir - tol) / 0.4, 0, 1) + clamp((stuff - (0.1 + 0.1 * risk)) / 0.15, 0, 1));
        lift = mistake === 2 ? 0 : need * arch.waveSkill;
        jump = exposed && arch.jumpAppetite > 0.5 && maxAir > 0.35 && maxAir <= tol ? 1 : 0;
        f[a + AI.SEA] += (maxAir - f[a + AI.SEA]) * ((3 * DT) / 4);
      }
      f[a + AI.WAVE_LIFT] = Math.max(lift, f[a + AI.WAVE_LIFT] - (3 * DT) / 0.6);
      f[a + AI.WAKE_BRACE] = Math.max(clamp((wakeRollAll - BRACE_ROLL) / BRACE_ROLL_SPAN, 0, 1), f[a + AI.WAKE_BRACE] - (3 * DT) / BRACE_HOLD);
      f[a + AI.JUMP] = jump;
    }
    const waveLift = f[a + AI.WAVE_LIFT];
    if (thr > 0) thr *= 1 - waveLift;
    if (f[a + AI.JUMP] === 1 && e > -1) thr = Math.max(thr, 0.95);
    // HEEL IN SMOOTH WATER: the drives roll her into the turn (physics-log T179 r2), so past HEEL_EASE she eases the throttle with
    // the helm (to 30 % at HEEL_ZERO): heeled 18° → 38° at full throttle is how the wake upsets ended (rival hooks, Tower Reach).
    // Not in a sea (SEA_SMOOTH): there the heel is the waves', and cutting drive made the veterans crash more than the rookies
    // (raceAiSea 28 vs 19 ungated; 14 vs 20 gated)
    if (thr > 0 && f[a + AI.SEA] <= SEA_SMOOTH) thr *= clamp((HEEL_ZERO - tilt) / (HEEL_ZERO - HEEL_EASE), 0.3, 1);
    // props out of the water (last tick's contact): feather unless the pilot likes to land pinned
    if (f[L.boatOffset(i) + B.PROP_IMMERSION] < 0.05 && arch.jumpAppetite < 0.7) thr = Math.min(thr, 0.4);
    f[a + AI.THROTTLE] = thr;
    // TRIM (pilot tuning, measured flat water, trim 0 = the capability table): neutral at launch (below 15 m/s), bow down
    // in a corner or a lift (props deeper, R −3 %), bow up on a straight at speed (+1.2 m/s top speed at +0.3); slewed.
    // The old request (+0.3 above 20 m/s everywhere, −waveLift up to −6°) had never run on the physics; once §T.207 applied it,
    // raceAiLaps' lap-to-lap bound failed (11 %) and raceAiPack hooked a courier (physics-log T207).
    const trimWant = rolling || V < 15 ? 0 : waveLift > 0.2 ? -0.5 * waveLift : cornering ? TRIM_CORNER : V > 24 ? TRIM_STRAIGHT : 0;
    const trim = f[a + AI.TRIM] + clamp(trimWant - f[a + AI.TRIM], -TRIM_RATE * DT, TRIM_RATE * DT);
    f[a + AI.TRIM] = trim;
    out.steer = steer;
    out.throttle = thr;
    out.trim = trim;
  }
}
