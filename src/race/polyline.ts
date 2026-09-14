/**
 * Arc-length polyline on the sea plane (§T.184). Pure math, no three.js (§V109).
 *
 * Frame and heading convention match `core/steering.ts`: yaw θ ⇒ forward
 * [sin θ, cos θ] in (x, z). Handedness is types.ts (§T.197, physical, y up): starboard of a
 * direction d is (−d.z, d.x), port is (d.z, −d.x).
 */
import type { Vec2 } from './types';

/** a.x·b.z − a.z·b.x in (x, z). Positive ⟹ b lies to STARBOARD of a (types.ts handedness: facing +z, +x is port). */
export function cross2(ax: number, az: number, bx: number, bz: number): number {
  return ax * bz - az * bx;
}

export interface LinePoint {
  x: number;
  z: number;
  /** unit tangent */
  tx: number;
  tz: number;
}

export class Polyline {
  readonly closed: boolean;
  readonly length: number;
  /** vertex count (duplicate consecutive vertices removed) */
  readonly count: number;
  /** number of segments: count (closed) or count − 1 (open) */
  readonly segments: number;
  private readonly xs: Float64Array;
  private readonly zs: Float64Array;
  /** arc length at the START of segment i; cum[segments] = length */
  private readonly cum: Float64Array;

  constructor(points: readonly Vec2[], closed: boolean) {
    const pts: Vec2[] = [];
    for (const p of points) {
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-9) pts.push(p);
    }
    if (closed && pts.length > 1) {
      const a = pts[0];
      const b = pts[pts.length - 1];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1e-9) pts.pop();
    }
    if (pts.length < 2) throw new Error('Polyline needs at least two distinct points');
    this.closed = closed;
    this.count = pts.length;
    this.segments = closed ? pts.length : pts.length - 1;
    this.xs = new Float64Array(pts.map((p) => p[0]));
    this.zs = new Float64Array(pts.map((p) => p[1]));
    this.cum = new Float64Array(this.segments + 1);
    for (let i = 0; i < this.segments; i++) {
      const j = (i + 1) % this.count;
      this.cum[i + 1] = this.cum[i] + Math.hypot(this.xs[j] - this.xs[i], this.zs[j] - this.zs[i]);
    }
    this.length = this.cum[this.segments];
  }

  segmentLength(i: number): number {
    return this.cum[i + 1] - this.cum[i];
  }

  segmentStart(i: number): number {
    return this.cum[i];
  }

  /** index of the segment containing arc `a` ∈ [0, length) */
  segmentIndexAt(a: number): number {
    let lo = 0;
    let hi = this.segments - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cum[mid] <= a) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /**
   * Point and tangent at arc length `s`. Closed: `s` wraps. Open: beyond either end the
   * point is extrapolated along the end segment's tangent (grid slots never ask for that:
   * rollingStart keeps them on the line, §T.197).
   */
  pointAt(s: number): LinePoint {
    let a = s;
    if (this.closed) {
      a = s - Math.floor(s / this.length) * this.length;
    }
    const clamped = Math.min(Math.max(a, 0), this.length);
    let i = this.segmentIndexAt(clamped);
    if (!this.closed && i >= this.segments) i = this.segments - 1;
    const j = (i + 1) % this.count;
    const len = this.segmentLength(i);
    const tx = (this.xs[j] - this.xs[i]) / len;
    const tz = (this.zs[j] - this.zs[i]) / len;
    const u = a - this.cum[i];
    return { x: this.xs[i] + tx * u, z: this.zs[i] + tz * u, tx, tz };
  }

  /** closest point on segment i to (x, z): local arc along the segment and squared distance */
  projectOnSegment(i: number, x: number, z: number): { along: number; d2: number } {
    const j = (i + 1) % this.count;
    const ax = this.xs[i];
    const az = this.zs[i];
    const len = this.segmentLength(i);
    const tx = (this.xs[j] - ax) / len;
    const tz = (this.zs[j] - az) / len;
    const along = Math.min(Math.max((x - ax) * tx + (z - az) * tz, 0), len);
    const px = ax + tx * along - x;
    const pz = az + tz * along - z;
    return { along, d2: px * px + pz * pz };
  }

  /** global nearest arc length (first minimum in segment order) */
  nearestArc(x: number, z: number): { arc: number; d2: number } {
    let best = Infinity;
    let arc = 0;
    for (let i = 0; i < this.segments; i++) {
      const p = this.projectOnSegment(i, x, z);
      if (p.d2 < best) {
        best = p.d2;
        arc = this.cum[i] + p.along;
      }
    }
    return { arc, d2: best };
  }
}

/** yaw of a unit tangent, `core/steering.ts` convention */
export function yawOfTangent(tx: number, tz: number): number {
  return Math.atan2(tx, tz);
}
