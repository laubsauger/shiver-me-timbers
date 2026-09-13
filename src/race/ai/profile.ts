/**
 * SPEED PROFILE (§T.186, tech-research §5.3) from the MEASURED capability (capability.ts), never from a guess:
 *   v_lat(s)   the highest v whose measured steady curvature at the NPC lock limit, × `latUse`, still reaches |κ(s)|
 *              (curvature capability falls with speed, so this is a bisection, not √(a/κ) with a constant a)
 *              and no faster than the measured full-throttle speed in a turn needing that drive angle;
 *   v_helm(s)  the highest v at which the helm can follow the line's change of drive angle: V·|dδ/ds| ≤ ½·HELM_RATE
 *              (a chicane taken faster than the helm reverses is a chicane missed — the steady table cannot see it);
 *   forward    v²(s+ds) ≤ v²(s) + 2·a_acc(v, δ(s))·ds   (measured full-throttle run, shifted by the turn's drag);
 *   backward   v²(s) ≤ v²(s+ds) + 2·a_dec(v)·ds         (measured coast ↔ full reverse, `brakeUse`; no brakes).
 * Two laps of each pass so the closed loop wraps consistently.
 */
import { accelAt, curvatureAt, decelAt, HELM_RATE, lockLimit, steerForCurvature, TOP_SPEED, turnTopSpeed } from './capability';
import type { RacingLine } from './line';

export interface ProfileOptions {
  /** fraction of the measured curvature capability the line may ask for (0..1) */
  latUse: number;
  /** 0 = lift and coast into corners, 1 = full reverse (later braking point) */
  brakeUse: number;
}

/** max speed at which the lock-limited boat, using `latUse` of its capability, holds |kappa| */
export function cornerSpeed(kappa: number, latUse: number): number {
  const k = Math.abs(kappa);
  const ok = (v: number): boolean => curvatureAt(v, lockLimit(v)) * latUse >= k;
  if (ok(TOP_SPEED)) return TOP_SPEED;
  if (!ok(4)) return 4;
  let lo = 4;
  let hi = TOP_SPEED;
  for (let it = 0; it < 30; it++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  // the turn's drag caps it too: full throttle cannot hold more than this with the drives at that angle
  return Math.min(lo, turnTopSpeed(steerForCurvature(lo, k)));
}

export function speedProfile(line: RacingLine, opts: ProfileOptions): Float64Array {
  const n = line.n;
  const ds = line.ds;
  const v = new Float64Array(n);
  const steer = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    v[i] = cornerSpeed(line.kappa[i], opts.latUse);
    steer[i] = steerForCurvature(v[i], line.kappa[i]);
  }
  // helm-rate limit: signed drive angle along the line at a trial speed, differentiated over ±4 samples
  const w = 4;
  for (let i = 0; i < n; i++) {
    const ka = line.kappa[(i + n - w) % n];
    const kb = line.kappa[(i + w) % n];
    const ok = (V: number): boolean => {
      const da = Math.sign(ka) * steerForCurvature(V, ka);
      const db = Math.sign(kb) * steerForCurvature(V, kb);
      return (V * Math.abs(db - da)) / (2 * w * ds) <= 0.5 * HELM_RATE;
    };
    if (ok(v[i])) continue;
    let lo = 4;
    let hi = v[i];
    if (!ok(lo)) {
      v[i] = lo;
      continue;
    }
    for (let it = 0; it < 24; it++) {
      const mid = (lo + hi) / 2;
      if (ok(mid)) lo = mid;
      else hi = mid;
    }
    v[i] = lo;
  }
  const cap = Float64Array.from(v);
  for (let lap = 0; lap < 2; lap++) {
    for (let k = 0; k < n; k++) {
      const i = k;
      const j = (k + 1) % n;
      const reach = Math.sqrt(v[i] * v[i] + 2 * accelAt(v[i], steer[i]) * ds);
      if (reach < v[j]) v[j] = Math.min(cap[j], reach);
    }
  }
  for (let lap = 0; lap < 2; lap++) {
    for (let k = n - 1; k >= 0; k--) {
      const i = k;
      const j = (k + 1) % n;
      const reach = Math.sqrt(v[j] * v[j] + 2 * decelAt(v[j], opts.brakeUse) * ds);
      if (reach < v[i]) v[i] = reach;
    }
  }
  return v;
}
