/**
 * Speedboat race CONTRACT (§T.181–§T.188). Shared shapes between the course
 * author (src/circuit, §T.187), race logic (src/race, §T.184), NPC racers
 * (src/race/ai, §T.186), the HUD (src/speedboat/ui, §T.185) and the page
 * (src/main-speedboat.ts, §T.181). Owners extend by ADDING optional fields;
 * renaming or removing a field is a coordinated change.
 *
 * Frame: world metres, y up, x/z the sea plane (same as ShipState).
 * Pure data — no three.js imports (§V109: src/race never imports main.ts,
 * main-raft.ts, raft/, combat/ or ai/).
 *
 * HANDEDNESS (§T.197: ONE convention, the physical one src/circuit authors in, §B112):
 * yaw θ ⟹ forward (sin θ, cos θ); with y up a boat's PORT (left hand, facing the bow)
 * of a heading d = (dx, dz) is (dz, −dx) and its STARBOARD is (−dz, dx). Facing +z, port
 * is +x. Yaw increasing is a turn to PORT. `circuit/courseLine.ts portOf` is this rule.
 * (src/race/ai still reads marks in the mirrored sense; the page hands its pilots an
 * adapted course — speedboat/page/course.ts `aiHandedCourse`, race/ai owner item.)
 */

export type Vec2 = readonly [x: number, z: number];

/** A pair of marker poles the boat must pass BETWEEN, in course order. */
export interface Gate {
  id: string;
  /** left pole = the PORT pole seen travelling the course direction: mid + (dz, −dx)·w */
  left: Vec2;
  /** right pole = the STARBOARD pole: mid + (−dz, dx)·w */
  right: Vec2;
  /** exposed = open-sea swell sector; sheltered = island lee (design doc §5) */
  sector: 'exposed' | 'sheltered';
}

/** A single buoy the boat must round on the given side. */
export interface TurnMark {
  id: string;
  at: Vec2;
  /** side of the BOAT the mark stays on while rounding ('port' = the boat turns to port around it, yaw increasing) */
  keepOn: 'port' | 'starboard';
  /** radius (m) inside which a boat has not rounded it */
  radius: number;
}

export type CourseElement = { kind: 'gate'; gate: Gate } | { kind: 'mark'; mark: TurnMark };

export interface Course {
  id: string;
  name: string;
  /** elements in race order; the lap closes from the last back to the first */
  elements: readonly CourseElement[];
  /** start/finish line = this gate id (also element 0) */
  startGateId: string;
  laps: number;
  /** a reference racing line through the elements (closed polyline), for AI seeding, minimap and respawn */
  referenceLine: readonly Vec2[];
  /** rolling-start: pace boat path before the start gate (polyline ending at the start gate) */
  paceLine: readonly Vec2[];
  /** minimap bounds */
  bounds: { min: Vec2; max: Vec2 };
}

/** Per-racer state the race logic publishes each tick (HUD, AI, audio read it). */
export interface RacerStanding {
  racerId: number;
  /** 1-based race position */
  position: number;
  lap: number;
  /** next element index in `Course.elements` */
  nextElement: number;
  /** metres along the reference line from the start, including completed laps */
  progress: number;
  /** seconds behind the leader (0 for the leader) */
  gapToLeader: number;
  finished: boolean;
  /** crash/respawn state for HUD overlay and AI */
  state: 'racing' | 'crashed' | 'respawning' | 'ghost' | 'finished';
  /** Surge boost, 0..3 segments (fractional while filling) */
  surge: number;
  /** §T.184 addition: laps completed (`lap` is the lap being run, 1-based; 0 before the start line) */
  lapsCompleted?: number;
  /** §T.184 addition: time penalties so far, seconds (missed elements, jump start) */
  penaltySeconds?: number;
  /** §T.184 addition: travelling against the course */
  wrongWay?: boolean;
  /** §T.184 addition: seconds of Surge boost left (0 = not boosting) */
  surgeBoostRemaining?: number;
  /** §T.184 addition: did not finish (retired or timed out after the winner); `state` is 'finished' */
  dnf?: boolean;
}

/** §T.184 addition: one classified line of the results (in place order). */
export interface RaceResult {
  racerId: number;
  /** 1-based */
  place: number;
  status: 'finished' | 'dnf' | 'running';
  lapsCompleted: number;
  /** race time at the finish line, s (null unless finished) */
  finishTime: number | null;
  penaltySeconds: number;
  /** finishTime + penaltySeconds (null unless finished) — the classified time */
  totalTime: number | null;
  lapTimes: readonly number[];
  bestLap: number | null;
}

export interface RaceState {
  phase: 'prestart' | 'rolling' | 'countdown' | 'racing' | 'finished';
  /** sim time since the race started (s); negative during rolling/countdown */
  raceTime: number;
  standings: readonly RacerStanding[];
  /** per-lap split times per racer, seconds */
  lapTimes: readonly (readonly number[])[];
  /** §T.184 addition: start lamps on the drowned radio tower */
  lights?: { lit: number; of: number; green: boolean };
  /** §T.184 addition: pace boat pose until it pulls off at green (null after) */
  paceBoat?: { x: number; z: number; yaw: number; speed: number } | null;
  /** §T.184 addition: classification, present once the first racer has finished */
  results?: readonly RaceResult[];
}
