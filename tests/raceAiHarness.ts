/**
 * Headless race harness for the NPC pilot tests (§T.186). Not a test file.
 *
 * REAL PHYSICS, REAL CORE: boats run through `BoatFleet` (the in-process `BoatSimCore`, or real worker threads),
 * the pilot runs inside the core's step, the sea is the core's own CpuOcean mirror. The harness plays the part the
 * race logic (§T.184, another agent's `src/race`) and the crash/respawn machine (§T.188) will play on the page —
 * written independently here, so a pilot geometry error cannot hide behind a shared helper:
 *   - gates: the CG path of each tick crossing the pole segment in the course direction; a crossing within three
 *     gate widths OUTSIDE the poles is a miss; marks: crossing the mark's rounding line on the correct side
 *     beyond its radius; skipping an element is a miss;
 *   - laps from start-line crossings (flying start), progress along the element-centre polygon, positions,
 *     gapToLeader = seconds since the leader envelope passed this boat's progress;
 *   - crash: tilt past 60° for 0.3 s ⇒ counted, 'crashed', respawned 1.5 s later on the line 60 m behind the
 *     crash, heading down the line at max(25 kn, ½ the profile speed) (design doc §3 respawn), 2 s 'ghost';
 *   - hook: heel/pitch past 45° or slip past 45° above 5 m/s (physics-log T179 "departure").
 */
import { SIM_DT } from '../src/core/loop';
import { oceanParams, type OceanParams } from '../src/params/ocean';
import { seaPhysicsParams, type SeaPhysicsParams } from '../src/params/seaPhysics';
import { AI, encodeStanding } from '../src/race/ai/aiBlock';
import type { Archetype, ArchetypeId } from '../src/race/ai/archetypes';
import { nearestSample } from '../src/race/ai/line';
import { buildPilotSetup, type PilotSetup } from '../src/race/ai/pilot';
import type { Course, CourseElement, RacerStanding, Vec2 } from '../src/race/types';
import { BoatFleet } from '../src/sim-worker/fleet';
import { AI_IN_LEN, AI_OUT_LEN, HASH_SEED } from '../src/sim-worker/layout';
import type { TransportKind, WorkerPort } from '../src/sim-worker/transport';
import { CpuOcean } from '../src/sea-physics/cpuOcean';
import { weatherPresets } from '../src/weather/presets';

// ── the synthetic course: 9 gates + 2 turn marks, ≈ 1.5 km, counter-clockwise ─────────────────────────────────
interface Spot {
  at: Vec2;
  kind: 'gate' | 'mark';
  width?: number;
  sheltered?: boolean;
}
const SPOTS: Spot[] = [
  { at: [0, 0], kind: 'gate', width: 50, sheltered: true },
  { at: [0, 200], kind: 'gate', width: 50, sheltered: true },
  { at: [10, 380], kind: 'gate', width: 50 },
  { at: [-110, 440], kind: 'mark' },
  { at: [-230, 380], kind: 'gate', width: 50 },
  { at: [-200, 220], kind: 'gate', width: 36 },
  { at: [-250, 110], kind: 'gate', width: 36 },
  { at: [-220, 0], kind: 'gate', width: 50 },
  { at: [-110, -40], kind: 'mark' },
  { at: [-40, -105], kind: 'gate', width: 50, sheltered: true },
  { at: [-5, -50], kind: 'gate', width: 50, sheltered: true },
];

export function syntheticCourse(laps = 3): Course {
  const m = SPOTS.length;
  const elements: CourseElement[] = SPOTS.map((sp, k) => {
    const p = SPOTS[(k + m - 1) % m].at;
    const q = SPOTS[(k + 1) % m].at;
    const dx = q[0] - p[0];
    const dz = q[1] - p[1];
    const l = Math.hypot(dx, dz);
    const sx = dz / l;
    const sz = -dx / l;
    const id = `${sp.kind === 'gate' ? 'G' : 'M'}${k}`;
    // counter-clockwise (x right, z up) is a loop of STARBOARD turns in race/types.ts handedness (facing +z, port is +x):
    // the marks sit inside it, on the boat's starboard (T196: was 'port' in race/ai's old mirrored sense — same geometry)
    if (sp.kind === 'mark') return { kind: 'mark', mark: { id, at: sp.at, keepOn: 'starboard', radius: 6 } };
    const h = (sp.width as number) / 2;
    return {
      kind: 'gate',
      gate: { id, left: [sp.at[0] - sx * h, sp.at[1] - sz * h], right: [sp.at[0] + sx * h, sp.at[1] + sz * h], sector: sp.sheltered ? 'sheltered' : 'exposed' },
    };
  });
  return {
    id: 'synthetic-11',
    name: 'Synthetic Reach',
    elements,
    startGateId: 'G0',
    laps,
    referenceLine: SPOTS.map((s) => s.at),
    paceLine: [
      [0, -200],
      [0, 0],
    ],
    bounds: { min: [-340, -250], max: [120, 560] },
  };
}

export type SeaState = 'calm' | 'breeze' | 'working';

/** Calm = the weather preset 'calm'. Working sea = the shipped default sea ('swell' preset: Beaufort 6, 11 m/s wind,
 *  0.34 m RMS swell) — no speedboat sea-state presets exist yet (design doc §5 names them, T181+ owns them). */
export function seaParams(sea: SeaState): { ocean: OceanParams; sea: SeaPhysicsParams } {
  const ocean = structuredClone(oceanParams);
  if (sea === 'calm') Object.assign(ocean, structuredClone(weatherPresets.calm.ocean));
  if (sea === 'breeze') Object.assign(ocean, structuredClone(weatherPresets.breeze.ocean));
  return { ocean, sea: { ...structuredClone(seaPhysicsParams), hullDraft: 0.5 } };
}

// ── gate geometry (independent of the pilot's corridors) ───────────────────────────────────────────────────────
interface Crossing {
  /** point on the line, direction along it (unit), travel normal (unit) */
  ox: number;
  oz: number;
  ux: number;
  uz: number;
  dx: number;
  dz: number;
  /** pass interval along u, miss interval along u */
  pass: [number, number];
  miss: [number, number];
}

function crossingsOf(course: Course): Crossing[] {
  const els = course.elements;
  const m = els.length;
  const ctr = (e: CourseElement): Vec2 => (e.kind === 'gate' ? [(e.gate.left[0] + e.gate.right[0]) / 2, (e.gate.left[1] + e.gate.right[1]) / 2] : e.mark.at);
  return els.map((e, k) => {
    if (e.kind === 'gate') {
      const { left, right } = e.gate;
      const w = Math.hypot(right[0] - left[0], right[1] - left[1]);
      const ux = (right[0] - left[0]) / w;
      const uz = (right[1] - left[1]) / w;
      return { ox: left[0], oz: left[1], ux, uz, dx: -uz, dz: ux, pass: [0, w], miss: [-3 * w, 4 * w] };
    }
    const p = ctr(els[(k + m - 1) % m]);
    const q = ctr(els[(k + 1) % m]);
    let dx = q[0] - p[0];
    let dz = q[1] - p[1];
    const l = Math.hypot(dx, dz);
    dx /= l;
    dz /= l;
    // rounding line: perpendicular to the p→q chord through the mark; a port rounding (mark on the boat's port) passes to
    // the chord's starboard (−dz, dx), a starboard rounding to its port (dz, −dx) — race/types.ts handedness (T196)
    const sgn = e.mark.keepOn === 'port' ? -1 : 1;
    const ux = dz * sgn;
    const uz = -dx * sgn;
    return { ox: e.mark.at[0], oz: e.mark.at[1], ux, uz, dx, dz, pass: [e.mark.radius, 200], miss: [-200, e.mark.radius] };
  });
}

/** where along u the segment a→b crosses the line (null: no crossing in the travel direction) */
function cross(c: Crossing, ax: number, az: number, bx: number, bz: number): number | null {
  const da = (ax - c.ox) * c.dx + (az - c.oz) * c.dz;
  const db = (bx - c.ox) * c.dx + (bz - c.oz) * c.dz;
  if (!(da < 0 && db >= 0)) return null;
  const t = da / (da - db);
  const hx = ax + (bx - ax) * t;
  const hz = az + (bz - az) * t;
  return (hx - c.ox) * c.ux + (hz - c.oz) * c.uz;
}

// ── the race ──────────────────────────────────────────────────────────────────────────────────────────────────
export interface RaceOptions {
  roster: (ArchetypeId | Archetype)[];
  sea: SeaState;
  laps: number;
  seed?: number;
  catchUp?: boolean;
  kind?: TransportKind;
  workers?: number;
  spawn?: () => WorkerPort;
  /** hard stop, sim seconds */
  maxSeconds?: number;
  course?: Course;
  setup?: PilotSetup;
  /** grid spacing between rows (m) */
  gridGap?: number;
  /** stop after this many ticks regardless of laps (determinism runs) */
  ticks?: number;
  /** diagnostics: called after every step for every boat */
  trace?: (tick: number, i: number, f: BoatFleet, info: { V: number; upY: number; drift: number; x: number; z: number; state: string }) => void;
}

export interface RacerResult {
  archetype: ArchetypeId;
  lapTimes: number[];
  finishTime: number;
  missed: number;
  passed: number;
  crashes: number;
  hooks: number;
  stuck: number;
  maxThrottle: number;
  minThrottle: number;
  meanSpeed: number;
  /** "element@time:u" per missed element (diagnostics) */
  missLog: string[];
  /** sim time of each crash */
  crashTimes: number[];
}

export interface RaceResult {
  racers: RacerResult[];
  /** finishing order (boat indices) */
  order: number[];
  /** positions every second: [tick, ...position per boat] */
  positions: number[][];
  /** FNV chain of every boat's OUT block (incl. AI OUT) every 60 ticks */
  hash: number;
  ticks: number;
  seconds: number;
  wallMs: number;
  setup: PilotSetup;
}

export async function runRace(o: RaceOptions): Promise<RaceResult> {
  const course = o.course ?? syntheticCourse(o.laps);
  const seed = o.seed ?? 186;
  const setup = o.setup ?? buildPilotSetup(course, o.roster, { seed, catchUp: o.catchUp ?? true });
  const N = o.roster.length;
  const p = seaParams(o.sea);
  const fleet = new BoatFleet({ boats: N, kind: o.kind ?? 'main', workers: o.workers, spawn: o.spawn, seed, oceanParams: p.ocean, seaParams: p.sea, pilot: setup });
  const wall0 = performance.now();
  try {
    await fleet.ready;
    const crossings = crossingsOf(course);
    const m = crossings.length;
    const centres: Vec2[] = course.elements.map((e) => {
      return e.kind === 'gate' ? [(e.gate.left[0] + e.gate.right[0]) / 2, (e.gate.left[1] + e.gate.right[1]) / 2] : e.mark.at;
    });
    const cum = [0];
    for (let k = 1; k <= m; k++) cum.push(cum[k - 1] + Math.hypot(centres[k % m][0] - centres[k - 1][0], centres[k % m][1] - centres[k - 1][1]));
    const lapLen = cum[m];
    const ref = setup.levels[2];
    const line = ref.line;

    // the page's own mirror of the same sea (same seed + params ⇒ the heights the core floats the boats on): a
    // respawn is set down ON the surface, not at a fixed height into a crest or over a trough
    const mirror = new CpuOcean(seed, structuredClone(p.ocean), structuredClone(p.sea));
    let now = 0;
    const placeOnLine = (i: number, station: number, lateral: number, speed: number): void => {
      const n = line.n;
      const idx = ((Math.round(station / line.ds) % n) + n) % n;
      const surface = mirror.heightAt(line.x[idx] + line.tz[idx] * lateral, line.z[idx] - line.tx[idx] * lateral, now);
      if (!Number.isFinite(surface) || !Number.isFinite(station)) throw new Error(`harness: placement of boat ${i} at station ${station}: surface ${surface}`);
      const tx = line.tx[idx];
      const tz = line.tz[idx];
      const yaw = Math.atan2(tx, tz);
      fleet.place(i, {
        position: [line.x[idx] + tz * lateral, 0.35 + surface, line.z[idx] - tx * lateral],
        quaternion: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
        velocity: [tx * speed, 0, tz * speed],
        angularVelocity: [0, 0, 0],
      });
    };
    // FLYING START ON THE COURSE'S PACE LINE (T196; the page rolls its grid down the pace line straight, course.ts
    // gridRoomPaceLine): rows `gap` apart behind the start gate, ±6 m across, heading along the pace line's last leg.
    // Was: stations −40 − gap·row back along the RACING line — on this course that put the third row inside the last
    // corner at 18 m/s, a turn the stand-in thrust's 3–4 m/s² of reverse could brake for and the engine model's
    // 1–1.7 m/s² (capability.ts `reverse`) cannot: the rookie missed the start gate before its lap began.
    const gap = o.gridGap ?? 22;
    const pl = course.paceLine;
    const [p0x, p0z] = pl[pl.length - 2];
    const [p1x, p1z] = pl[pl.length - 1];
    const pll = Math.hypot(p1x - p0x, p1z - p0z);
    const ptx = (p1x - p0x) / pll;
    const ptz = (p1z - p0z) / pll;
    for (let i = 0; i < N; i++) {
      const back = 40 + gap * Math.floor(i / 2);
      const lateral = i % 2 === 0 ? -6 : 6;
      const gx = p1x - ptx * back + ptz * lateral;
      const gz = p1z - ptz * back - ptx * lateral;
      const yaw = Math.atan2(ptx, ptz);
      fleet.place(i, {
        position: [gx, 0.35 + mirror.heightAt(gx, gz, now), gz],
        quaternion: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
        velocity: [ptx * 18, 0, ptz * 18],
        angularVelocity: [0, 0, 0],
      });
    }

    type St = {
      next: number;
      started: boolean;
      lapStart: number;
      laps: number[];
      finished: number;
      missed: number;
      passed: number;
      crashes: number;
      hooks: number;
      stuck: number;
      tiltT: number;
      crashT: number;
      ghostT: number;
      slowT: number;
      hooked: boolean;
      state: RacerStanding['state'];
      px: number;
      pz: number;
      progress: number;
      maxThr: number;
      minThr: number;
      vSum: number;
      vN: number;
      missLog: string[];
      crashTimes: number[];
    };
    const st: St[] = Array.from({ length: N }, () => ({ next: 0, started: false, lapStart: 0, laps: [], finished: -1, missed: 0, passed: 0, crashes: 0, hooks: 0, stuck: 0, tiltT: 0, crashT: 0, ghostT: 0, slowT: 0, hooked: false, state: 'racing', px: 0, pz: 0, progress: 0, maxThr: -Infinity, minThr: Infinity, vSum: 0, vN: 0, missLog: [], crashTimes: [] }));
    const pose = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] } as Parameters<BoatFleet['readPose']>[1];
    const envelope: number[] = [];
    const positions: number[][] = [];
    const inBuf = new Float64Array(AI_IN_LEN);
    const maxTicks = o.ticks ?? Math.round((o.maxSeconds ?? 150 * o.laps) / SIM_DT);
    let hash = HASH_SEED;
    let time = 0;
    let tick = 0;
    for (let i = 0; i < N; i++) {
      fleet.readPose(i, pose);
      st[i].px = pose.position[0];
      st[i].pz = pose.position[2];
    }
    for (; tick < maxTicks; tick++) {
      // ── race logic on the tick-k poses: standings for the pilots ──
      let lead = -Infinity;
      for (const s of st) lead = Math.max(lead, s.progress);
      envelope.push(lead);
      const order = st.map((_, i) => i).sort((a, b) => {
        const fa = st[a].finished >= 0;
        const fb = st[b].finished >= 0;
        if (fa && fb) return st[a].finished - st[b].finished;
        if (fa !== fb) return fa ? -1 : 1;
        return st[b].progress - st[a].progress || a - b;
      });
      const posOf = new Array<number>(N);
      order.forEach((b, k) => (posOf[b] = k + 1));
      for (let i = 0; i < N; i++) {
        const s = st[i];
        // first tick the envelope reached this progress
        let lo = 0;
        let hi = envelope.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (envelope[mid] >= s.progress) hi = mid;
          else lo = mid + 1;
        }
        const gapS = posOf[i] === 1 ? 0 : (envelope.length - 1 - lo) * SIM_DT;
        const standing: RacerStanding = { racerId: i, position: posOf[i], lap: s.laps.length, nextElement: s.next, progress: s.progress, gapToLeader: gapS, finished: s.finished >= 0, state: s.state, surge: 0 };
        encodeStanding(inBuf, -AI_OUT_LEN, standing, N, true);
        fleet.writeAiInput(i, inBuf);
      }
      if (tick % 60 === 0) positions.push([tick, ...posOf]);
      fleet.kick(tick, time, p.ocean, p.sea);
      await fleet.done();
      time += SIM_DT;
      now = time;
      if (tick % 60 === 0) hash = fleet.hash(hash);

      let allDone = true;
      for (let i = 0; i < N; i++) {
        const s = st[i];
        fleet.readPose(i, pose);
        const x = pose.position[0];
        const z = pose.position[2];
        const [qx, qy, qz, qw] = pose.quaternion;
        const upY = 1 - 2 * (qx * qx + qz * qz);
        const V = Math.hypot(pose.velocity[0], pose.velocity[2]);
        const thr = fleet.readAi(i, AI.THROTTLE);
        s.maxThr = Math.max(s.maxThr, thr);
        s.minThr = Math.min(s.minThr, thr);
        if (s.started && s.finished < 0) {
          s.vSum += V;
          s.vN++;
        }
        // gates
        if (s.finished < 0) {
          const k = s.next;
          const c = crossings[k];
          const u = cross(c, s.px, s.pz, x, z);
          const k2 = (k + 1) % m;
          const u2 = cross(crossings[k2], s.px, s.pz, x, z);
          const onPass = (kk: number): void => {
            if (kk === 0) {
              if (s.started) {
                s.laps.push(time - s.lapStart);
                if (s.laps.length >= o.laps) s.finished = time;
              }
              s.started = true;
              s.lapStart = time;
            }
            s.next = (kk + 1) % m;
          };
          if (u !== null && u >= c.pass[0] && u <= c.pass[1]) {
            s.passed++;
            onPass(k);
          } else if (u !== null && u >= c.miss[0] && u <= c.miss[1]) {
            s.missed++;
            s.missLog.push(`${k}@${time.toFixed(1)}:${u.toFixed(1)}`);
            onPass(k);
          } else if (u2 !== null && u2 >= crossings[k2].pass[0] && u2 <= crossings[k2].pass[1] && (s.started || k !== 0)) {
            s.missed++;
            s.missLog.push(`${k}@${time.toFixed(1)}:skipped`);
            onPass(k);
            s.passed++;
            onPass(k2);
          }
          // progress along the centre polygon toward the next element
          const kk = s.next;
          const a = centres[(kk + m - 1) % m];
          const b = centres[kk];
          const sx = b[0] - a[0];
          const sz = b[1] - a[1];
          const sl = Math.hypot(sx, sz);
          const t = Math.max(0, Math.min(1, ((x - a[0]) * sx + (z - a[1]) * sz) / (sl * sl)));
          s.progress = (s.started ? s.laps.length : -1) * lapLen + cum[(kk + m - 1) % m] + t * sl;
        }
        s.px = x;
        s.pz = z;
        // hooks (a departure that is not a wave launch: counted in any sea, asserted in calm)
        const fx = 2 * (qx * qz + qw * qy);
        const fz = 1 - 2 * (qx * qx + qy * qy);
        let drift = Math.atan2(fx, fz) - Math.atan2(pose.velocity[0], pose.velocity[2]);
        drift = Math.abs(Math.atan2(Math.sin(drift), Math.cos(drift)));
        const dep = V > 5 && (upY < Math.SQRT1_2 || drift > Math.PI / 4);
        if (dep && !s.hooked && s.state !== 'crashed') s.hooks++;
        o.trace?.(tick, i, fleet, { V, upY, drift, x, z, state: s.state });
        s.hooked = dep;
        // crash / respawn
        if (s.state === 'crashed') {
          s.crashT += SIM_DT;
          if (s.crashT >= 1.5) {
            const idx = nearestSample(line, x, z, 0, line.n);
            const station = idx * line.ds - 60;
            const prof = ref.speed[((Math.round(station / line.ds) % line.n) + line.n) % line.n];
            placeOnLine(i, station, 0, Math.max(12.9, 0.5 * prof));
            fleet.readPose(i, pose); // the reset pose is applied on the next step; keep the pre-crash point for gates
            s.state = 'ghost';
            s.ghostT = 2;
            s.tiltT = 0;
            s.slowT = 0;
            // the respawn point is behind: re-arm gate tracking from the line position
            const lx = line.x[((Math.round(station / line.ds) % line.n) + line.n) % line.n];
            const lz = line.z[((Math.round(station / line.ds) % line.n) + line.n) % line.n];
            s.px = lx;
            s.pz = lz;
          }
        } else if (s.finished < 0) {
          if (s.state === 'ghost') {
            s.ghostT -= SIM_DT;
            if (s.ghostT <= 0) s.state = 'racing';
          }
          s.tiltT = upY < 0.5 ? s.tiltT + SIM_DT : 0;
          s.slowT = V < 2 && s.started && s.finished < 0 ? s.slowT + SIM_DT : 0;
          if (s.tiltT >= 0.3 || s.slowT >= 6) {
            if (s.tiltT >= 0.3) {
              s.crashes++;
              s.crashTimes.push(time);
            }
            else s.stuck++;
            s.state = 'crashed';
            s.crashT = 0;
          }
        }
        if (s.finished >= 0 && s.state !== 'finished') s.state = 'finished';
        if (s.finished < 0) allDone = false;
      }
      if (allDone && o.ticks === undefined) {
        tick++;
        break;
      }
    }
    const order = st
      .map((_, i) => i)
      .sort((a, b) => (st[a].finished < 0 ? Infinity : st[a].finished) - (st[b].finished < 0 ? Infinity : st[b].finished) || st[b].progress - st[a].progress);
    return {
      racers: st.map((s, i) => ({
        archetype: (setup.boats[i] as Archetype).id,
        lapTimes: s.laps,
        finishTime: s.finished,
        missed: s.missed,
        passed: s.passed,
        crashes: s.crashes,
        hooks: s.hooks,
        stuck: s.stuck,
        maxThrottle: s.maxThr,
        minThrottle: s.minThr,
        meanSpeed: s.vN ? s.vSum / s.vN : 0,
        missLog: s.missLog,
        crashTimes: s.crashTimes,
      })),
      order,
      positions,
      hash,
      ticks: tick,
      seconds: time,
      wallMs: performance.now() - wall0,
      setup,
    };
  } finally {
    fleet.dispose();
  }
}
