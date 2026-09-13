/**
 * Rolling start behind the pace boat (§T.184, design doc §2/§7). Pure, keyed to sim time.
 *
 * Timeline (sim seconds from race creation):
 *   0 ─ prestart ─ rollStart ─ rolling ─ lamp 1 … lamp N ─ countdown ─ green ─ racing
 * The pace boat runs `Course.paceLine` at `paceSpeed` from rollStart and pulls off
 * `pullOffDistance` before the line's end (the start gate); that moment is green, so green is
 * known the instant the race is created and `raceTime` can count up to it from below.
 * Lamps hang on the drowned radio tower and light one per `lampInterval` before green.
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
  /** sim time each lamp lights, ascending */
  lampTimes: number[];
  green: number;
}

export function startSchedule(paceLine: Polyline, p: RollingStartParams): StartSchedule {
  const rollStart = p.prestartSeconds;
  const run = Math.max(0, paceLine.length - p.pullOffDistance);
  const green = rollStart + run / p.paceSpeed;
  const lampTimes: number[] = [];
  for (let i = 0; i < p.lampCount; i++) lampTimes.push(green - (p.lampCount - i) * p.lampInterval);
  return { rollStart, lampTimes, green };
}

export interface Pose2 {
  x: number;
  z: number;
  yaw: number;
}

/** metres of pace line covered by the pace boat at sim time t */
export function paceDistance(t: number, schedule: StartSchedule, p: RollingStartParams): number {
  const moving = Math.min(t, schedule.green) - schedule.rollStart;
  return Math.max(0, moving) * p.paceSpeed;
}

export function paceBoatPose(t: number, paceLine: Polyline, schedule: StartSchedule, p: RollingStartParams): Pose2 {
  const q = paceLine.pointAt(paceDistance(t, schedule, p));
  return { x: q.x, z: q.z, yaw: yawOfTangent(q.tx, q.tz) };
}

/**
 * Grid slot `gridIndex` (0 = pole) at sim time t: rows behind the pace boat along the pace
 * line, columns abreast across it (column 0 to port). Heading along the pace line.
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
  const q = paceLine.pointAt(s);
  const lateral = (col - (p.gridColumns - 1) / 2) * p.columnSpacing;
  // starboard of the tangent = (tz, −tx); negative lateral = port
  return { x: q.x + q.tz * lateral, z: q.z - q.tx * lateral, yaw: yawOfTangent(q.tx, q.tz) };
}

/** number of lamps lit at sim time t (0 before the first, lampCount until green, 0 after) */
export function lampsLit(t: number, schedule: StartSchedule): number {
  if (t >= schedule.green) return 0;
  let n = 0;
  for (const lt of schedule.lampTimes) if (t >= lt) n++;
  return n;
}
