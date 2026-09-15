/**
 * HEADLESS RACE SLICE (§T.191) — the page's fixed tick without a GPU. Not a test file.
 *
 * Built from the page's own modules, not re-implementations: `createPlayerBoat`, `createNpcFleetDriver` (the
 * pipelined worker driver, on the 'main' transport here), `createRaceSession` (controls → collide → physics → crash →
 * race → outputs), `createAutopilotControls` (the rivals' pilot flying the player), the Tower Reach world, the worker
 * world data (`bakeSimWorldData`) and a page-style mirror (seabed grid + fetch field). What the harness adds is only
 * what a browser frame does around them: advance the mirror to the tick time (the page's `frame.tickSea`), pump the
 * fleet at the end of ticks and frames, and honour `session.holdSim` before a frame of ticks.
 *
 * `ticksPerFrame` and `pumpInTicks` reproduce different frame pacing: a race that is deterministic must produce the
 * same hash whether the fleet is pumped every tick at 60 fps or three ticks late at 20 fps.
 */
import { SIM_DT } from '../src/core/loop';
import type { TowerReachWorld } from '../src/circuit';
import { createSeabedField, type SeabedField } from '../src/island/seabed';
import { createFetchField, type FetchField } from '../src/ocean/fetchField';
import { oceanParams, type OceanParams } from '../src/params/ocean';
import { buildPilotSetup, type PilotSetup } from '../src/race/ai/pilot';
import type { Course, RaceState } from '../src/race/types';
import type { Rigid6State } from '../src/sea-physics/rigidBody';
import { CpuOcean } from '../src/sea-physics/cpuOcean';
import { HASH_SEED, TRACE_LEN } from '../src/sim-worker/layout';
import { bakeSimWorldData, gridSeabed, raceBed, type SimWorldData } from '../src/sim-worker/worldData';
import { buildDeepVHull } from '../src/speedboat/hullMesh';
import { createAutopilotControls } from '../src/speedboat/page/autopilot';
import { aiHandedCourse, respawnClear } from '../src/speedboat/page/course';
import type { StaticCollider } from '../src/sea-physics/boatCollide';
import { createNpcFleetDriver, type NpcFleet } from '../src/speedboat/page/npcFleet';
import { createPlayerBoat } from '../src/speedboat/page/playerBoat';
import { createRaceSession, RACE_DELAY_TICKS, RIVAL_ARCHETYPES, type RaceSession } from '../src/speedboat/page/raceSession';
import { speedboatSeaParams } from '../src/speedboat/page/seaParams';
import type { ShipState } from '../src/state/simState';
import { weatherPresets } from '../src/weather/presets';
import { collisionWorld } from './speedboatCollisionWorld';

export const NPCS = 7;

export interface CourseFixture {
  world: TowerReachWorld;
  seabed: SeabedField;
  pilot: PilotSetup;
  /** the authored course + the clear pace line, as the page hands Race (page/course.ts CourseWorld.course) */
  course: Course;
  /** the pilots' mirrored course (page/course.ts `aiHandedCourse`), as the page hands buildPilotSetup */
  aiCourse: Course;
  /**
   * the page's collider list (page/course.ts `towerReachCourse().attach`): course furniture + roofs + capsules fitted to
   * the DRAWN kit island props (circuit/propColliders, §T.198), via tests/speedboatCollisionWorld.ts
   */
  colliders: StaticCollider[];
}

let fixture: CourseFixture | null = null;
/**
 * Tower Reach as the PAGE builds it + its seabed + the rivals' lines, built once per test file (the terrain bake is the
 * slow part). §T.198: the colliders, the clear pace line and the course are the page's own `attach` output over the
 * drawn kit decor — not pirate rock placements the page never had.
 */
export function courseFixture(seed = 2100): CourseFixture {
  if (fixture) return fixture;
  const cw = collisionWorld();
  const world = cw.world;
  const seabed = createSeabedField(world.heightmaps.map((hm, i) => ({ heightmap: hm, center: world.sites[i].position })));
  const colliders = cw.page.colliders;
  const course: Course = cw.page.course;
  const aiCourse = aiHandedCourse(course);
  // as the page must: the rivals' lines, room and pursuit keep clear of the same colliders the physics collides with
  const pilot = buildPilotSetup(course, [...RIVAL_ARCHETYPES, null], { seed, colliders });
  fixture = { world, seabed, pilot, course, aiCourse, colliders };
  return fixture;
}

export type SeaName = 'calm' | 'swell';

export function seaOcean(sea: SeaName): OceanParams {
  const o = structuredClone(oceanParams);
  if (sea !== 'swell') Object.assign(o, structuredClone(weatherPresets[sea].ocean));
  return o;
}

export interface SliceOptions {
  sea: SeaName;
  /** the ocean params to race on instead of `seaOcean(sea)` (§T.213: the speedboat's own seas, tests/raceAiHarness seaOceanParams) */
  ocean?: OceanParams;
  seed?: number;
  /** laps of the race (Tower Reach is authored at 3) */
  laps?: number;
  /** stop after this many page ticks */
  maxTicks: number;
  /** stop once every racer has a result that is not 'running' (or the player finished and `untilPlayerFinish`) */
  untilPlayerFinish?: boolean;
  /** stop once every racer's result is classified (finished or DNF) */
  untilAllClassified?: boolean;
  ticksPerFrame?: number;
  /** pump at the end of every tick as well as every frame (the page does both) */
  pumpInTicks?: boolean;
  /** record `hashAt(tick)` at these ticks */
  hashTicks?: readonly number[];
  onTick?(tick: number, s: Slice): void;
  /** the player's reset button is held on this tick (crash machine → race respawn point → teleport) */
  resetAt?: number;
  onPlayerTeleport?(tick: number, pose: Readonly<Rigid6State>, s: Slice): void;
}

export interface Slice {
  session: RaceSession;
  npcs: NpcFleet;
  player: ReturnType<typeof createPlayerBoat>;
  mirror: CpuOcean;
  fetch: FetchField;
  simWorld: SimWorldData;
  tick: number;
  time: number;
}

export interface SliceResult {
  ticks: number;
  state: RaceState | null;
  hashes: Map<number, string>;
  heldFrames: number;
  nonFinite: string | null;
  slice: Slice;
}

/**
 * FNV-1a over what the race has settled at page tick `s.tick`: every rival's step trace at the race tick (the fleet's
 * live OUT block would depend on how far the worker has got — that is the point of the delay), the player's state and
 * the race standings.
 */
export function sliceHash(s: Slice): string {
  let h = HASH_SEED;
  const mix = (f: Float64Array): void => {
    const bytes = new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
    for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  };
  const rt = s.tick - RACE_DELAY_TICKS + 1;
  if (rt >= 1) {
    const row = new Float64Array(TRACE_LEN);
    for (let i = 0; i < NPCS; i++) {
      for (let k = 0; k < TRACE_LEN; k++) row[k] = s.npcs.trace(rt, i, k);
      mix(row);
    }
  }
  mix(new Float64Array([...s.player.state.position, ...s.player.state.quaternion, ...s.player.state.velocity, ...s.player.state.angularVelocity]));
  const st = s.session.state;
  const text = st ? JSON.stringify(st.standings.map((q) => [q.racerId, q.position, q.lap, q.nextElement, q.progress, q.state, q.penaltySeconds])) : '';
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

export async function runSlice(o: SliceOptions): Promise<SliceResult> {
  const seed = o.seed ?? 2100;
  const fx0 = courseFixture(seed);
  // the fixture's lines are built once per file; the pilots' seeded mistakes follow this race's seed (§T.213 seed sweeps)
  const fx = fx0.pilot.seed === seed >>> 0 ? fx0 : { ...fx0, pilot: { ...fx0.pilot, seed: seed >>> 0 } };
  const hull = buildDeepVHull();
  const ocean = o.ocean ?? seaOcean(o.sea);
  const seaParams = speedboatSeaParams(hull);
  const fetch = createFetchField(fx.seabed, ocean);
  const simWorld = bakeSimWorldData(fx.seabed, ocean, fx.world.bars);
  const mirror = new CpuOcean(seed, ocean, seaParams);
  mirror.setSeabed(gridSeabed(simWorld), -simWorld.seabed.openHeight);
  mirror.setFetch(fetch);
  const bed = raceBed(simWorld);
  const colliders = fx.colliders;

  const state = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] } as unknown as ShipState;
  const player = createPlayerBoat({ hull, pressureHeadAt: (x, z, t) => mirror.pressureHeadAt(x, z, t) }, state);
  const warn = console.warn;
  console.warn = () => {};
  const npcs = await createNpcFleetDriver({
    seed, boats: NPCS, oceanParams: ocean, seaParams,
    spawn: (i) => ({ position: [i * 20, 0.2, -3000], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] }),
    caps: { crossOriginIsolated: false, sharedArrayBuffer: false, worker: false }, budgetMs: 1e6,
    pilot: fx.pilot, contacts: { boats: true, colliders }, world: simWorld, player: true,
  });
  console.warn = warn;
  let tick = 0;
  let time = 0;
  let slice: Slice | undefined;
  // eslint-disable-next-line prefer-const
  let session: RaceSession;
  const autopilot = createAutopilotControls({
    setup: fx.pilot, index: npcs.playerIndex, boats: NPCS + 1, lockRad: hull.drives[0].maxSteerRad, sea: mirror,
    time: () => time, world: () => session.snapshot, standing: () => session.playerAiIn, propImmersion: () => player.hw.propImmersion,
  });
  session = createRaceSession({
    course: { ...fx.course, laps: o.laps ?? fx.course.laps }, hull, player, npcs, controls: autopilot,
    resetPressed: () => tick === o.resetAt, surgePressed: () => false, autoReset: () => true,
    colliders, bed: (x, z) => bed.heightAt(x, z), isClear: respawnClear(colliders, (x, z) => bed.heightAt(x, z)), waterAt: (x, z) => mirror.pressureHeadAt(x, z, time), fetchVersion: () => fetch.version,
    onPlayerTeleport: (pose) => {
      autopilot.reset();
      if (slice) o.onPlayerTeleport?.(tick, pose, slice);
    },
  });
  slice = { session, npcs, player, mirror, fetch, simWorld, tick, time };
  session.start(0);
  const sl = slice as Slice;
  const tpf = o.ticksPerFrame ?? 1;
  const hashes = new Map<number, string>();
  let held = 0;
  let nonFinite: string | null = null;
  try {
    while (tick < o.maxTicks) {
      if (session.holdSim(tick)) {
        held++;
        npcs.pump(tick);
        if (held > 100000) throw new Error('harness: the sim held forever');
        continue;
      }
      for (let k = 0; k < tpf && tick < o.maxTicks; k++) {
        tick++;
        time += SIM_DT;
        sl.tick = tick;
        sl.time = time;
        mirror.update(time);
        session.tick(tick, time, SIM_DT);
        if (o.pumpInTicks ?? true) npcs.pump(tick);
        if (o.hashTicks?.includes(tick)) hashes.set(tick, sliceHash(sl));
        if (tick % 60 === 0 && !nonFinite) {
          const all = [...player.state.position, ...player.state.velocity];
          for (let i = 0; i < NPCS; i++) all.push(...npcs.pose(i).position, ...npcs.pose(i).velocity);
          if (!all.every(Number.isFinite)) nonFinite = `tick ${tick}`;
        }
        o.onTick?.(tick, sl);
      }
      npcs.pump(tick);
      const st = session.state;
      if (o.untilPlayerFinish && st?.results && st.standings.find((q) => q.racerId === 0)?.finished) break;
      if (o.untilAllClassified && st?.results && st.results.length === NPCS + 1 && st.results.every((r) => r.status !== 'running')) break;
    }
  } finally {
    npcs.dispose();
  }
  return { ticks: tick, state: session.state, hashes, heldFrames: held, nonFinite, slice: sl };
}
