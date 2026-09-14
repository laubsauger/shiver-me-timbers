/**
 * Rolling start behind the pace boat (§T.184, design doc §2/§7). Pure, keyed to sim time.
 *
 * Timeline (sim seconds from race creation):
 *   0 ─ prestart ─ rollStart ─ rolling ─ lamp 1 … lamp N ─ countdown ─ green ─ racing
 * The pace boat runs `Course.paceLine` at `paceSpeed` from rollStart and pulls off
 * `pullOffDistance` before the line's end (the start gate); that moment is green, so green is
 * known the instant the race is created and `raceTime` can count up to it from below.
 * Lamps hang on the drowned radio tower and light one per `lampInterval` before green.
 *
 * THE GRID IS ON THE PACE LINE (§T.197). The pace boat does not start at the line's first point:
 * it starts `gridDepth` metres along it (first row gap + the rows behind), so at t = 0 the LAST
 * row sits exactly on the line's start and every slot, at every time, is a point ON the pace
 * polyline — never extrapolated past its start (a straight tangent off the first leg can run
 * into rocks the course author never cleared). A pace line shorter than the grid throws.
 */
import { Polyline, yawOfTangent } from './polyline';

export interface RollingStartParams {
  /** seconds sitting on the grid before the pace boat moves */
  prestartSeconds: number;
  /** pace boat speed, m/s */
  paceSpeed: number;
  /** racers may exceed the pace speed by this factor to close up on their slot */
  speedCapFactor: number;
  /** pace boat pulls off (= green) this far before the end of the pace line, m */
  pullOffDistance: number;
  lampCount: number;
  lampInterval: number;
  /** racers abreast per row */
  gridColumns: number;
  columnSpacing: number;
  rowSpacing: number;
  /** first row this far behind the pace boat, m */
  firstRowGap: number;
}

export interface StartSchedule {
  rollStart: number;
  /** metres along the pace line the pace boat starts at (= `gridDepth`: the last row on the line's start) */
  paceStart: number;
  /** sim time each lamp lights, ascending */
  lampTimes: number[];
  green: number;
}

/** metres from the pace boat back to the last grid row: firstRowGap + (rows − 1) · rowSpacing */
export function gridDepth(p: RollingStartParams, racers: number): number {
  const rows = Math.max(1, Math.ceil(racers / p.gridColumns));
  return p.firstRowGap + (rows - 1) * p.rowSpacing;
}

export function startSchedule(paceLine: Polyline, p: RollingStartParams, racers: number): StartSchedule {
  const paceStart = gridDepth(p, racers);
  if (!(paceLine.length >= paceStart)) {
    throw new Error(`rollingStart: pace line ${paceLine.length.toFixed(1)} m is shorter than the grid of ${racers} (${paceStart} m)`);
  }
  const rollStart = p.prestartSeconds;
  const run = Math.max(0, paceLine.length - p.pullOffDistance - paceStart);
  const green = rollStart + run / p.paceSpeed;
  const lampTimes: number[] = [];
  for (let i = 0; i < p.lampCount; i++) lampTimes.push(green - (p.lampCount - i) * p.lampInterval);
  return { rollStart, paceStart, lampTimes, green };
}

export interface Pose2 {
  x: number;
  z: number;
  yaw: number;
}

/** metres of pace line covered by the pace boat at sim time t */
export function paceDistance(t: number, schedule: StartSchedule, p: RollingStartParams): number {
  const moving = Math.min(t, schedule.green) - schedule.rollStart;
  return schedule.paceStart + Math.max(0, moving) * p.paceSpeed;
}

export function paceBoatPose(t: number, paceLine: Polyline, schedule: StartSchedule, p: RollingStartParams): Pose2 {
  const q = paceLine.pointAt(paceDistance(t, schedule, p));
  return { x: q.x, z: q.z, yaw: yawOfTangent(q.tx, q.tz) };
}

/**
 * Grid slot `gridIndex` (0 = pole) at sim time t: rows behind the pace boat ALONG the pace
 * line (arc length, so a slot is always on it), columns abreast across it (column 0 to
 * STARBOARD, types.ts handedness). Heading along the pace line. An index beyond the grid the
 * schedule was built for would lie before the line's start and throws.
 */
export function gridSlotPose(
  gridIndex: number,
  t: number,
  paceLine: Polyline,
  schedule: StartSchedule,
  p: RollingStartParams,
): Pose2 {
  const row = Math.floor(gridIndex / p.gridColumns);
  const col = gridIndex % p.gridColumns;
  const s = paceDistance(t, schedule, p) - p.firstRowGap - row * p.rowSpacing;
  if (s < -1e-9) throw new Error(`rollingStart: grid index ${gridIndex} is behind the pace line's start (schedule built for a smaller grid)`);
  const q = paceLine.pointAt(Math.max(0, s));
  const lateral = (col - (p.gridColumns - 1) / 2) * p.columnSpacing;
  // port of the tangent = (tz, −tx): positive lateral = port, negative (column 0) = starboard
  return { x: q.x + q.tz * lateral, z: q.z - q.tx * lateral, yaw: yawOfTangent(q.tx, q.tz) };
}

/** number of lamps lit at sim time t (0 before the first, lampCount until green, 0 after) */
export function lampsLit(t: number, schedule: StartSchedule): number {
  if (t >= schedule.green) return 0;
  let n = 0;
  for (const lt of schedule.lampTimes) if (t >= lt) n++;
  return n;
}
