/**
 * Race positions and gap-to-leader (§T.184). Pure.
 *
 * ORDER KEY, most significant first:
 *  1. out of the race (DNF) sorts last;
 *  2. elements done (every gate/mark passed or missed after the start, laps included) —
 *     a boat must PASS a gate to be ahead of one that has, however far along the line it is;
 *  3. both finished with equal elements ⟹ classified time (finish + penalties);
 *  4. otherwise unwrapped progress along the reference line (laps included, so a lapped boat
 *     with more in-lap distance is still behind);
 *  5. an exact tie keeps the previous order (no flicker between abreast boats), then racer
 *     index, so the result is deterministic.
 */

export interface RankEntry {
  /** index into the race's racer list */
  index: number;
  dnf: boolean;
  finished: boolean;
  elementsDone: number;
  progress: number;
  /** finish + penalties, only read when finished */
  classifiedTime: number;
  /** previous 1-based position (0 = none yet) */
  prevPosition: number;
}

/** returns racer indices in position order (element 0 = P1) */
export function rankRacers(entries: readonly RankEntry[]): number[] {
  const sorted = [...entries].sort((a, b) => {
    if (a.dnf !== b.dnf) return a.dnf ? 1 : -1;
    if (a.elementsDone !== b.elementsDone) return b.elementsDone - a.elementsDone;
    if (a.finished && b.finished && a.classifiedTime !== b.classifiedTime) {
      return a.classifiedTime - b.classifiedTime;
    }
    if (a.progress !== b.progress) return b.progress - a.progress;
    const pa = a.prevPosition || Infinity;
    const pb = b.prevPosition || Infinity;
    if (pa !== pb) return pa - pb;
    return a.index - b.index;
  });
  return sorted.map((e) => e.index);
}

/**
 * Per-racer timestamps at shared progress checkpoints every `spacing` metres. The time at a
 * checkpoint is interpolated inside the step that crossed it, so a gap is not quantised to the
 * tick. Gap = time the racer reached its latest checkpoint − time the leader reached the SAME
 * checkpoint (for a lapped boat that is a lap earlier, as it should be).
 */
export class CheckpointTimes {
  /** times[k] = sim time progress first reached k·spacing (k ≥ 0) */
  readonly times: number[] = [];

  constructor(private readonly spacing: number) {}

  /** progress p0 → p1 over sim time t0 → t1 */
  record(p0: number, p1: number, t0: number, t1: number): void {
    for (let c = this.times.length * this.spacing; c <= p1; c = this.times.length * this.spacing) {
      const f = p1 > p0 ? Math.min(Math.max((c - p0) / (p1 - p0), 0), 1) : 1;
      this.times.push(t0 + (t1 - t0) * f);
    }
  }
}

/** seconds `racer` is behind `leader` at their latest common checkpoint, ≥ 0 */
export function gapSeconds(racer: CheckpointTimes, leader: CheckpointTimes): number {
  const k = Math.min(racer.times.length, leader.times.length) - 1;
  if (k < 0) return 0;
  return Math.max(0, racer.times[k] - leader.times[k]);
}
