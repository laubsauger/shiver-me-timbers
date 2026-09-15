/**
 * §T.213 RIVAL AI ACROSS SEEDS — one race of a seed sweep, as a plain report. Not a test file.
 *
 * WHY: every rival-AI check used to be one race on one pinned seed, and each policy that passed it failed laps on 1–2 of 6
 * other seeds and the pack on 2 of 3 (docs/speedboat/npc-ai.md). A pilot tuned to one realisation of the sea and one
 * sequence of seeded mistakes is not a racing AI. So a race here is (course, seed, sea), and the seed moves BOTH the sea
 * realisation (the fleet's CpuOcean) and the pilots' mistake dice (PilotSetup.seed).
 *
 * Two courses:
 *  - 'pack'   the synthetic 9-gate + 2-mark course (tests/raceAiHarness), all seven couriers, 1 lap, flying start, catch-up on,
 *             wakes + boat contacts on — ~15 s wall; what the CI-default multi-seed tests run;
 *  - 'tower'  Tower Reach as the page builds it (tests/speedboatRaceHarness: the page's colliders, seabed lee, rolling start,
 *             crash machines, race logic, the autopiloted player), 1 lap — ~140 s wall; the opt-in sweep
 *             (scripts/race-ai-sweep.mjs).
 *
 * The seas are the speedboat's own (params/speedboatSea.ts): calm, working (the race default), open.
 *
 * CLI (used by the sweep script through vite-node): SWEEP_JOB='{"course":"pack","seed":1,"sea":"working"}' prints one
 * `SWEEP_RESULT <json>` line.
 */
import { SIM_DT } from '../src/core/loop';
import { AI } from '../src/race/ai/aiBlock';
import { ARCHETYPE_ORDER } from '../src/race/ai/archetypes';
import type { SpeedboatSeaName } from '../src/params/speedboatSea';
import { CONTACT_BOAT, CONTACT_SOLID } from '../src/sea-physics/boatCollide';
import { TR } from '../src/sim-worker/layout';
import { RACE_DELAY_TICKS, RIVAL_ARCHETYPES } from '../src/speedboat/page/raceSession';
import type { TransportKind, WorkerPort } from '../src/sim-worker/transport';
import { runRace, seaOceanParams } from './raceAiHarness';
import { NPCS, runSlice } from './speedboatRaceHarness';

export type SweepCourse = 'pack' | 'tower';

export interface SweepJob {
  course: SweepCourse;
  seed: number;
  sea: SpeedboatSeaName;
  laps?: number;
  /** pack only: transport (sab needs `spawn`) */
  kind?: TransportKind;
  spawn?: () => WorkerPort;
}

export interface SweepRacer {
  id: string;
  finished: boolean;
  /** race time of the finish (classified time without penalties on Tower Reach), s; NaN if not finished */
  time: number;
  lapTimes: number[];
  crashes: number;
  hooks: number;
  respawns: number;
  missed: number;
  /** static-solid contact episodes (Tower Reach) */
  solid: number;
  /** boat↔boat contact episodes with another rival (the player excluded on Tower Reach) */
  boat: number;
  /** near misses: heel past 35° episodes (pack only; −1 on Tower Reach) */
  scares: number;
  events: string[];
}

export interface SweepReport {
  course: SweepCourse;
  seed: number;
  sea: SpeedboatSeaName;
  laps: number;
  racers: SweepRacer[];
  /** Σ over the rivals */
  crashes: number;
  finished: number;
  missed: number;
  solid: number;
  boat: number;
  /** fastest and slowest rival lap (all laps), s */
  lapMin: number;
  lapMax: number;
  /** rival finish spread, first to last, s (Infinity if a rival did not finish) */
  packSpread: number;
  wallS: number;
}

const DEG = 180 / Math.PI;
/** m between grid rows on the synthetic flying start: the page's rolling-start row spacing (race/params start.rowSpacing) */
const GRID_GAP = 30;

function summarise(job: SweepJob, laps: number, racers: SweepRacer[], wallS: number): SweepReport {
  const sum = (k: 'crashes' | 'missed' | 'solid' | 'boat'): number => racers.reduce((a, r) => a + r[k], 0);
  const allLaps = racers.flatMap((r) => r.lapTimes);
  const times = racers.map((r) => (r.finished ? r.time : Infinity));
  const fin = racers.filter((r) => r.finished).length;
  return {
    course: job.course, seed: job.seed, sea: job.sea, laps, racers,
    crashes: sum('crashes'), finished: fin, missed: sum('missed'), solid: sum('solid'), boat: sum('boat'),
    lapMin: allLaps.length ? Math.min(...allLaps) : NaN,
    lapMax: allLaps.length ? Math.max(...allLaps) : NaN,
    packSpread: fin === racers.length ? Math.max(...times) - Math.min(...times) : Infinity,
    wallS,
  };
}

async function packRace(job: SweepJob): Promise<SweepReport> {
  const laps = job.laps ?? 1;
  const t0 = performance.now();
  const r = await runRace({ roster: [...ARCHETYPE_ORDER], sea: job.sea, laps, seed: job.seed, catchUp: true, kind: job.kind ?? 'main', spawn: job.spawn, gridGap: GRID_GAP });
  const racers: SweepRacer[] = r.racers.map((x) => ({
    id: x.archetype,
    finished: x.lapTimes.length >= laps,
    time: x.finishTime >= 0 ? x.finishTime : NaN,
    lapTimes: x.lapTimes,
    crashes: x.crashes,
    hooks: x.hooks,
    respawns: x.crashes + x.stuck,
    missed: x.missed,
    solid: 0,
    boat: x.boatContacts,
    scares: x.scares,
    events: x.events,
  }));
  return summarise(job, laps, racers, (performance.now() - t0) / 1000);
}

async function towerRace(job: SweepJob): Promise<SweepReport> {
  const laps = job.laps ?? 1;
  const t0 = performance.now();
  const racers: SweepRacer[] = RIVAL_ARCHETYPES.map((a) => ({ id: a as string, finished: false, time: NaN, lapTimes: [], crashes: 0, hooks: 0, respawns: 0, missed: 0, solid: 0, boat: 0, scares: -1, events: [] }));
  const touching = new Array<number>(NPCS).fill(0);
  const res = await runSlice({
    sea: 'calm', ocean: seaOceanParams(job.sea), seed: job.seed, laps, maxTicks: Math.round((90 + 200 * laps) / SIM_DT), untilAllClassified: true,
    onTick: (tick, s) => {
      const rt = tick - RACE_DELAY_TICKS + 1;
      const race = s.session.race;
      // the rival's situation at race tick rt (its step trace) + the pilot's live AI memory (last collected tick)
      const situation = (i: number, kind: string): string => {
        if (rt < 1) return `${kind} (before the first race tick)`;
        const tr = (k: number): number => s.npcs.trace(rt, i, k);
        const [x, z] = [tr(TR.POSE), tr(TR.POSE + 2)];
        const [qx, qy, qz, qw] = [tr(TR.POSE + 3), tr(TR.POSE + 4), tr(TR.POSE + 5), tr(TR.POSE + 6)];
        const [vx, vz] = [tr(TR.POSE + 7), tr(TR.POSE + 9)];
        const V = Math.hypot(vx, vz);
        const tilt = Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (qx * qx + qz * qz)))) * DEG;
        let drift = Math.atan2(2 * (qx * qz + qw * qy), 1 - 2 * (qx * qx + qy * qy)) - Math.atan2(vx, vz);
        drift = Math.abs(Math.atan2(Math.sin(drift), Math.cos(drift))) * DEG;
        const ai = (k: number): number => s.npcs.fleet.readAi(i, k);
        const st = s.session.state?.standings.find((q) => q.racerId === i + 1);
        let near = '';
        let nd = 60;
        for (let j = 0; j < NPCS; j++) {
          if (j === i) continue;
          const bx = s.npcs.trace(rt, j, TR.POSE);
          const bz = s.npcs.trace(rt, j, TR.POSE + 2);
          const bvx = s.npcs.trace(rt, j, TR.POSE + 7);
          const bvz = s.npcs.trace(rt, j, TR.POSE + 9);
          const d = Math.hypot(bx - x, bz - z);
          if (d >= nd) continue;
          nd = d;
          const bu = Math.hypot(bvx, bvz);
          const tx = bu > 1 ? bvx / bu : 0;
          const tz = bu > 1 ? bvz / bu : 0;
          const X = -((x - bx) * tx + (z - bz) * tz);
          const Y = (z - bz) * tx - (x - bx) * tz;
          near = ` near #${j + 1}(${racers[j].id}) d${d.toFixed(0)} X${X.toFixed(0)} Y${Y.toFixed(0)} U${bu.toFixed(0)}${X > 0 && Math.abs(Y) < Math.tan(19.47 / DEG) * X + 4 ? ' IN-WAKE' : ''}`;
        }
        return `${kind} rt${rt} t${(rt * SIM_DT).toFixed(1)} next${st?.nextElement ?? '?'} (${x.toFixed(0)},${z.toFixed(0)}) V${V.toFixed(1)} tilt${tilt.toFixed(0)} drift${drift.toFixed(0)} thr${ai(AI.THROTTLE).toFixed(2)} steer${(ai(AI.STEER) * DEG).toFixed(1)} trim${ai(AI.TRIM).toFixed(2)} lift${ai(AI.WAVE_LIFT).toFixed(2)} risk${ai(AI.RISK).toFixed(2)} lvl${ai(AI.LEVEL)} xte${ai(AI.CROSS_TRACK).toFixed(1)} off${ai(AI.OFFSET).toFixed(1)} vT${ai(AI.TARGET_SPEED).toFixed(1)} sea${ai(AI.SEA).toFixed(2)}${near}`;
      };
      const drained = s.session.drain();
      for (const e of drained.crashEvents) {
        if (e.racerId === 0) continue;
        const r = racers[e.racerId - 1];
        if (e.event.type === 'crash') {
          r.crashes++;
          if (e.event.kind === 'hook') r.hooks++;
          r.events.push(situation(e.racerId - 1, `CRASH ${e.event.kind} impact${e.event.impact.toFixed(1)}`));
        } else if (e.event.type === 'respawnStart') r.respawns++;
      }
      for (const e of drained.events) {
        if (e.kind === 'penalty' && e.racerId !== 0 && e.reason === 'missedElement') {
          racers[e.racerId - 1].missed++;
          racers[e.racerId - 1].events.push(situation(e.racerId - 1, `MISS element ${e.element}`));
        }
      }
      if (!race || rt < 2) return;
      for (let i = 0; i < NPCS; i++) {
        const src = s.npcs.trace(rt, i, TR.CONTACT_SRC);
        const other = s.npcs.trace(rt, i, TR.CONTACT_OTHER);
        const now = src === CONTACT_SOLID ? 1 : src === CONTACT_BOAT && other !== s.npcs.playerIndex ? 2 : 0;
        if (now !== 0 && now !== touching[i]) {
          if (now === 1) racers[i].solid++;
          else racers[i].boat++;
          racers[i].events.push(`${situation(i, now === 1 ? 'SOLID' : 'BOAT')} other ${other} dv${s.npcs.trace(rt, i, TR.CONTACT_DV).toFixed(2)}`);
        }
        touching[i] = now;
      }
    },
  });
  for (const q of res.state?.results ?? []) {
    if (q.racerId === 0) continue;
    const r = racers[q.racerId - 1];
    r.finished = q.status === 'finished';
    r.time = q.finishTime ?? NaN;
    r.lapTimes = [...q.lapTimes];
  }
  if (res.nonFinite) racers.forEach((r) => r.events.push(`NON-FINITE ${res.nonFinite}`));
  return summarise(job, laps, racers, (performance.now() - t0) / 1000);
}

export function runSweepJob(job: SweepJob): Promise<SweepReport> {
  return job.course === 'pack' ? packRace(job) : towerRace(job);
}

/** one row per race: the numbers the §T.213 acceptance reads */
export function reportRow(r: SweepReport): string {
  const hooks = r.racers.reduce((a, x) => a + x.hooks, 0);
  const resp = r.racers.reduce((a, x) => a + x.respawns, 0);
  return `${r.course} ${r.sea.padEnd(7)} seed ${String(r.seed).padStart(5)}: fin ${r.finished}/${r.racers.length} crashes ${r.crashes} hooks ${hooks} respawns ${resp} missed ${r.missed} solid ${r.solid} boat ${r.boat} laps ${r.lapMin.toFixed(1)}–${r.lapMax.toFixed(1)} s pack ${r.packSpread.toFixed(1)} s (${r.wallS.toFixed(0)} s wall)`;
}

// CLI: one job from the environment (scripts/race-ai-sweep.mjs runs this file through vite-node, one process per race)
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
if (env?.SWEEP_JOB) {
  const job = JSON.parse(env.SWEEP_JOB) as SweepJob;
  const r = await runSweepJob(job);
  // eslint-disable-next-line no-console
  console.log(`SWEEP_RESULT ${JSON.stringify(r, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v))}`);
}
