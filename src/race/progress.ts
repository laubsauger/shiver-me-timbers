/**
 * Progress along `Course.referenceLine` (§T.184).
 *
 * Progress is UNWRAPPED metres from the start gate's projection: negative behind the line on
 * the rolling start, `lap·L + a` after `lap` wraps. Two defects a naive global
 * nearest-point projection has, and what stops each:
 *  - where two legs run close (a V, a hairpin) the nearest point flips between legs, a jump
 *    of tens of metres either way ⟹ the search is WINDOWED around the previous raw value in
 *    unwrapped arc, and between segments a jump costs (continuity·Δu)² on top of d² — cheap
 *    forwards (a boat that cuts a corner IS further on), stiff backwards (flipping back onto
 *    a leg already left is the defect);
 *  - at a sharp corner a boat swerving wide or cutting inside projects a little backwards
 *    ⟹ HYSTERESIS: published progress follows raw forward at once and backward only once
 *    raw is more than `hysteresis` metres behind it (then it trails raw by that much).
 * The lap seam needs nothing: the window walks segment indices modulo the vertex count while
 * its arc keeps counting.
 */
import { Polyline } from './polyline';

export interface ProgressParams {
  /** metres the projection window reaches behind the previous raw progress */
  windowBack: number;
  /** metres the projection window reaches ahead of it */
  windowAhead: number;
  /** backward motion tolerated before published progress follows it (m) */
  hysteresis: number;
  /** metres of distance one metre of FORWARD progress jump costs when choosing between segments */
  continuity: number;
  /** the same for a BACKWARD jump (stiffer: going back onto a leg already left is the flip) */
  backContinuity: number;
  /** if the windowed nearest point is farther than this (m), try a global re-acquire */
  reacquireDistance: number;
  /** raw progress this far behind the best reached ⟹ wrong way (m) */
  wrongWayDistance: number;
}

export class CourseLine {
  readonly line: Polyline;
  /** arc length of the start gate's projection on the line */
  readonly origin: number;

  constructor(points: readonly (readonly [number, number])[], startX: number, startZ: number) {
    this.line = new Polyline(points, true);
    this.origin = this.line.nearestArc(startX, startZ).arc;
  }

  get length(): number {
    return this.line.length;
  }

  /** point + tangent at unwrapped progress `u` */
  at(u: number) {
    return this.line.pointAt(this.origin + u);
  }

  /** unwrapped progress of the global nearest point, the lap chosen nearest to `hint` */
  nearest(x: number, z: number, hint: number): { u: number; d2: number } {
    const { arc, d2 } = this.line.nearestArc(x, z);
    const L = this.line.length;
    const a = arc - this.origin;
    const k = Math.round((hint - a) / L);
    return { u: a + k * L, d2 };
  }

  /**
   * Windowed nearest in unwrapped progress over [u − back, u + ahead]. Between segments the
   * choice minimises d² + (continuity·Δu)²: where two legs are nearly equidistant (inside a V)
   * the one that does not jump wins; a single segment's own projection is never biased.
   */
  windowed(
    x: number,
    z: number,
    u: number,
    back: number,
    ahead: number,
    continuity = 0,
    backContinuity = continuity,
  ): { u: number; d2: number } {
    const L = this.line.length;
    const aStart = this.origin + u - back;
    const aEnd = this.origin + u + ahead;
    const lap = Math.floor(aStart / L);
    let i = this.line.segmentIndexAt(aStart - lap * L);
    let segStart = lap * L + this.line.segmentStart(i);
    let bestCost = Infinity;
    let bestD2 = Infinity;
    let bestU = u;
    // bounded: a window never needs more than every segment twice
    for (let guard = 0; guard < 2 * this.line.segments + 2 && segStart <= aEnd; guard++) {
      const p = this.line.projectOnSegment(i, x, z);
      const cand = segStart + p.along - this.origin;
      const jump = cand >= u ? continuity * (cand - u) : backContinuity * (u - cand);
      const cost = p.d2 + jump * jump;
      if (cost < bestCost - 1e-9 || (Math.abs(cost - bestCost) <= 1e-9 && Math.abs(cand - u) < Math.abs(bestU - u))) {
        bestCost = cost;
        bestD2 = p.d2;
        bestU = cand;
      }
      segStart += this.line.segmentLength(i);
      i = (i + 1) % this.line.segments;
    }
    return { u: bestU, d2: bestD2 };
  }
}

export class ProgressTracker {
  /** unwrapped raw projection */
  raw = 0;
  /** published, hysteresis-filtered progress */
  progress = 0;
  /** best raw progress reached since the last reset (wrong-way reference) */
  best = 0;

  constructor(
    private readonly course: CourseLine,
    private readonly params: ProgressParams,
  ) {}

  /** place from scratch (race start, respawn): lap chosen nearest to `hint` */
  reset(x: number, z: number, hint: number): void {
    this.resetTo(this.course.nearest(x, z, hint).u);
  }

  /** teleport to a known progress (respawn on the line) */
  resetTo(u: number): void {
    this.raw = u;
    this.progress = u;
    this.best = u;
    this.wrongWay = false;
  }

  update(x: number, z: number): number {
    const p = this.params;
    let hit = this.course.windowed(x, z, this.raw, p.windowBack, p.windowAhead, p.continuity, p.backContinuity);
    if (hit.d2 > p.reacquireDistance * p.reacquireDistance) {
      const g = this.course.nearest(x, z, this.raw);
      if (g.d2 < hit.d2 * 0.25) hit = g;
    }
    this.raw = hit.u;
    if (this.raw >= this.progress) this.progress = this.raw;
    else this.progress = Math.min(this.progress, this.raw + p.hysteresis);
    if (this.raw > this.best) this.best = this.raw;
    // set past the distance, clear at half of it, so it does not flicker on the threshold
    const behind = this.best - this.raw;
    this.wrongWay = this.wrongWay ? behind > p.wrongWayDistance / 2 : behind > p.wrongWayDistance;
    return this.progress;
  }

  /** travelling against the course: raw progress well behind the best reached */
  wrongWay = false;
}
