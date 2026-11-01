/**
 * THE DIVE INTO THE WEB: from where Undertime's pull-back leaves the eye, through the cosmic web, into our galaxy (the
 * 2026-10-30 review of the web and galaxy cluster scene: "still a little bit subpar. It needs more detail and a better
 * sense of speed when zooming in. We should kind of fly into it and realise the vastness of this filament network,
 * then have the galaxies pop in in the distance, then OUR galaxy, and then start this whole zoom in"; the plan:
 * drift-narrative/get-the-drift/cosmic-web-flythrough-plan.md).
 *
 * THE SCALE. Until now the web's box was 19 m when the pull-back ended, and our galaxy 1.6 m across 14 m away: the
 * galaxies were as big as the web's knots, so the web never read as vast, and the eye then drifted 9 m from rest
 * through a dim grain with nothing near it. Here the box is ourDistance·e^diveEfolds / DIVE_L ≈ 900 m in Act 2's
 * world, ~560 of our galaxy's radii: a cell of the volume is ~2 radii, a filament a dozen, a knot a group of
 * galaxies — the proportions of the simulations (drift-narrative/references/cosmic-web). Our galaxy starts as a
 * smudge of a few pixels 280 m off, and the dive is an exponential approach to it (constant optic flow: Powers of
 * Ten in reverse, Undertime's pull-back undone) that becomes, unchanged from the `ours` beat on, the approach into
 * the disk it always was (getTheDrift/timeline.ts DIVE_KEYS: its pace).
 *
 * THE FRAME. The web's box sits turned in the world by one fixed rotation R (pattern → world), chosen so that the
 * pull-back still ends `webReach` box units from the hero knot (Undertime's grain: the densest knot of the box) and
 * the dive from there, straight along Get the Drift's approach (el 48°, az −45°: front left, in the focus zone),
 * ends DIVE_L box units on, INSIDE A FILAMENT, flying down its axis for its last 0.035 box (density 8–10× mean, the
 * hair of the volume all round) — with four groups (knots 4, 52, 19 and 3, 9–14× mean) passing 0.017–0.04 box beside
 * the line at 25–45° off it on the way in, and the hero knot itself ~0.1 box off. Found in the volume (2026-10-30):
 * its filament voxels (log density 0.50–0.70), each one's axis the Hessian's least-curved eigenvector (density
 * smoothed over a cell); for each, the pull-back and dive lengths that the fixed 160° between the pull-back's
 * direction and the approach's (world) allow; scored on the filament's run before the target, a void at the dive's
 * start (the web laid out round the eye there), no knot centre on the line (inside one the eye sits in a grey wash),
 * and groups beside it. Without a turn of the box there was no such line: the approach's own direction from where
 * the pull-back ends crosses only voids and thin walls (log density < 0.5 the whole way). R is built at run time from
 * the two pattern directions below and their world twins, so the web follows if a param moves them — and the
 * eye's place in the box stays continuous at every hand-over by construction (webPlace), filament or not.
 *
 * WHERE THE EYE IS IN THE WEB (webPlace), one curve over three regimes, continuous in place and in speed:
 *   until ~67.6 s      Undertime's pull-back (webFlight): the world scales about the hero grain; the eye still
 *   until the act      THE TURN (below): one curve from the pull-back's direction into the dive's, one way, ≤20°/s,
 *                      in Undertime's world (the eye still, the box 19 m once the pull-back rests), landing on the
 *                      dive's line at the act (the 2026-11-01 notes; until then the pull-back eased to rest at 73–74 s
 *                      and the dive began from rest there)
 *   from the act       Get the Drift's world: the eye flies the approach (arrivalEye), the box is `box` m
 * At the act the box's size jumps (19 m → ~900 m) and the eye's world position with it (to the approach line, ~280 m
 * from our galaxy's Sun point — which stays near the world's origin, so the planet and the landing keep their float
 * precision), but nothing drawn in the web depends on either alone: every point of it is placed from the eye's place
 * in the box and the box's size together, so the jump is invisible — the zoom's own trick.
 *
 * DOME COMFORT. The view never turns: translation only. The flow expands from one fixed point (the approach
 * direction) the whole way, so nothing swings; the speed is the approach's, at most ~0.31 e-folds of distance per
 * second (the cap: 0.35), eased in and out (tests/webDive.test.ts, tests/getTheDriftTimeline.test.ts).
 */
import type { DriftParams } from '../../params/drift';
import type { GetTheDriftParams } from '../../params/getTheDrift';
import { beatStarts as undertimeBeats, plateau, webFlight, webTurnEnd } from '../undertime/timeline';
import { arrivalState, domeDir } from './timeline';
import type { Vec3 } from '../../cine/domeMaster';

/** pattern-space unit direction from the hero knot to where the pull-back leaves the eye (the volume search above) */
export const WEB_PULL: Vec3 = [-0.94216, -0.16363, 0.2925];
/** pattern-space unit direction of the dive: the target filament's axis */
export const WEB_DIVE: Vec3 = [0.80479, 0.04499, -0.59185];
/** box units from the dive's start to our galaxy's Sun point */
export const DIVE_L = 0.314;

/** 3×3, row-major: world = R · pattern */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export interface WebFrame {
  /** pattern → world */
  R: Mat3;
  /** pattern positions: the hero knot, where the dive starts, where it ends (our galaxy's Sun point) */
  hero: Vec3;
  start: Vec3;
  target: Vec3;
  /** unit, pattern: the dive's direction (R^T of the approach) */
  dive: Vec3;
  /** Get the Drift's world units (m) per box */
  box: number;
  /** Get the Drift's world: our galaxy's Sun point (where `target` is) and the unit approach direction */
  sun: Vec3;
  approach: Vec3;
  /** show s: the dive starts (under the pull-back's ease-out), the pull-back comes to rest, Get the Drift starts */
  diveStart: number;
  pullEnd: number;
  actStart: number;
  /** the act's own params (the approach's pace, `webPlace`) */
  p2: GetTheDriftParams;
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const lin = (a: Vec3, b: Vec3, k: number): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];

/** world from pattern */
export function toWorld(R: Mat3, v: Vec3): Vec3 {
  return [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
}

/** pattern from world (R is a rotation: its transpose) */
export function toPattern(R: Mat3, v: Vec3): Vec3 {
  return [R[0] * v[0] + R[3] * v[1] + R[6] * v[2], R[1] * v[0] + R[4] * v[1] + R[7] * v[2], R[2] * v[0] + R[5] * v[1] + R[8] * v[2]];
}

/** the periodic image of pattern offset d nearest zero */
export const wrap = (d: Vec3): Vec3 => d.map((x) => x - Math.round(x)) as Vec3;

/** the rotation taking pattern unit vectors a → u exactly and b → d (exactly when their angles agree) */
function frameRotation(a: Vec3, b: Vec3, u: Vec3, d: Vec3): Mat3 {
  const a1 = norm(a);
  const a2 = norm(lin(b, a1, -dot(b, a1)));
  const a3 = cross(a1, a2);
  const u1 = norm(u);
  const u2 = norm(lin(d, u1, -dot(d, u1)));
  const u3 = cross(u1, u2);
  // R = [u1 u2 u3] · [a1 a2 a3]^T
  const R = new Array(9).fill(0) as Mat3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) R[i * 3 + j] = u1[i] * a1[j] + u2[i] * a2[j] + u3[i] * a3[j];
  return R;
}

/**
 * The web's frame for the show: `heroKnot` is the hero knot's pattern position (web.knots[0]), `sun` our galaxy's Sun
 * point in Get the Drift's world (timeline.ts ourGalaxy).
 */
export function webFrame(p: DriftParams, p2: GetTheDriftParams, heroKnot: Vec3, sun: Vec3): WebFrame {
  const pullEnd = webTurnEnd(p);
  const end = webFlight(pullEnd, p);
  const actStart = undertimeBeats(p).total - p2.overlap;
  const approach = domeDir(p2.approachEl, p2.approachAz, p.domeTilt);
  const R = frameRotation(WEB_PULL, WEB_DIVE, norm(end.offset), approach);
  const start = lin(heroKnot, toPattern(R, end.offset), 1);
  const dive = norm(toPattern(R, approach));
  return {
    R,
    hero: [...heroKnot] as Vec3,
    start,
    target: lin(start, dive, DIVE_L),
    dive,
    box: (p2.ourDistance * Math.exp(p2.diveEfolds)) / DIVE_L,
    sun: [...sun] as Vec3,
    approach,
    diveStart: actStart - p2.diveLead,
    pullEnd,
    actStart,
    p2,
  };
}

export interface WebPlace {
  /** the eye's place in the box (pattern) */
  eyePat: Vec3;
  /** world units per box */
  box: number;
  /** the eye's velocity through the box (pattern units per s; ×box for world units per s) */
  vel: Vec3;
}

/** box units from the eye to the target along the dive, at show time t ≥ diveStart */
function diveLeft(t: number, f: WebFrame): number {
  return (f.p2.ourDistance * arrivalState(t - f.actStart, f.p2).f) / f.box;
}

/** s the velocity is differenced over */
const H = 1 / 120;

/** the pull-back's place in the box (pattern), at rest from pullEnd on (at `start`) */
function pullAt(t: number, f: WebFrame, p: DriftParams): Vec3 {
  return lin(f.hero, toPattern(f.R, webFlight(Math.min(t, f.pullEnd), p).offset), 1);
}

/** the dive's line (pattern) at show time t */
const lineAt = (t: number, f: WebFrame): Vec3 => lin(f.target, f.dive, -diveLeft(t, f));

/**
 * THE TURN (the 2026-11-01 notes: "we zoom all the way out, then stagnate a bit, and then zoom all the way back in";
 * then, of a first fix that added a sideways S to the hand-over, "the motion through the cluster is now too undecided
 * and swerves left and right twice"). The pull-back runs out along the line from the hero knot and the dive runs back
 * in 160° from it: added, or one after the other, the eye's direction of travel flips round in under a second at
 * ~0.01 e-folds/s (~430°/s at its fastest) — the stop. So the eye flies ONE CURVE between them: it leaves the
 * pull-back TURN_EASE s before the turn begins (its speed easing down to the turn's), then turns from the pull-back's
 * direction to the dive's about a single axis, one way only (a slerp of the two), until the act (81 s) — its rate a
 * plateau, eased in and out over TURN_RAMP of the turn, ~20°/s at most over the ~11.4 s it takes — at a steady
 * speed (~0.006 box/s, ≥0.03 e-folds/s of the nearer of the hero knot and the Sun point), its speed easing into the dive's over the last
 * 2·TURN_EASE s; at the act it is ON the dive's line with the line's place, direction and speed: straight down the
 * filament from there, the frame and the act's hand-over as they were. Two numbers are solved so it lands exactly
 * there (Newton, on a table integrated once per frame): when the turn begins (~69.6 s) and its speed. What lies out
 * of the turn's plane (the pull-back's own slow turn of its line) is taken up along the curve, ~0.0002 box. Off the
 * pull-back's line the eye no longer keeps its distance from the hero knot: the hero grain comes in from ~5.8 m to
 * ~3.4 m (Undertime's world) over the turn, and the web's scale goes on changing about the eye, which is invisible.
 */
const TURN_RAMP = 0.3;
const TURN_EASE = 2;

interface Turn {
  t0: number;
  t1: number;
  /** pattern positions every TURN_DT s from t0 */
  pos: Vec3[];
  /** 0..1 the fraction of the curve's length flown at each of them */
  along: number[];
  /** pattern offset taken up over the curve, eased in and out over its length flown (so it tilts the direction of
   * travel by a tenth of a degree at most, at a few hundredths of a degree per second) */
  rest: Vec3;
  /** the solved turn start (s) and speed (box units/s) */
  ts: number;
  speed: number;
}
const TURN_DT = 1 / 120;
const turns = new WeakMap<WebFrame, Turn>();
const smooth01 = (x: number): number => {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
};

function turnFor(f: WebFrame, p: DriftParams): Turn {
  const hit = turns.get(f);
  if (hit) return hit;
  const t1 = f.actStart;
  const h = 1 / 240;
  const vPull = (t: number): Vec3 => lin(pullAt(t + h, f, p), pullAt(t - h, f, p), -1).map((x) => x / (2 * h)) as Vec3;
  const sp = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);
  const vLine = (t: number): number => (t < f.diveStart ? 0 : (diveLeft(t - h, f) - diveLeft(t + h, f)) / (2 * h));
  const d = f.dive;
  const fly = (ts: number, sc: number): { pos: Vec3[]; run: number[]; t0: number; e2: Vec3 } => {
    const t0 = ts - TURN_EASE;
    const a0 = norm(vPull(t0));
    const omega = Math.acos(Math.max(-1, Math.min(1, dot(a0, d))));
    const so = Math.sin(omega) || 1;
    const n = Math.round((t1 - t0) / TURN_DT);
    const dt = (t1 - t0) / n;
    let cur = pullAt(t0, f, p);
    const pos: Vec3[] = [cur];
    const run = [0];
    for (let i = 0; i < n; i++) {
      const t = t0 + (i + 0.5) * dt;
      const into = smooth01((t - t0) / TURN_EASE);
      const out = smooth01((t - (t1 - 2 * TURN_EASE)) / (2 * TURN_EASE));
      const s = (1 - out) * ((1 - into) * sp(vPull(t)) + into * sc) + out * vLine(t);
      const phi = omega * plateau((t - ts) / (t1 - ts), TURN_RAMP);
      const dir = lin(a0.map((c) => (c * Math.sin(omega - phi)) / so) as Vec3, d, Math.sin(phi) / so);
      cur = lin(cur, dir, s * dt);
      pos.push(cur);
      run.push(run[i] + s * dt);
    }
    return { pos, run, t0, e2: norm(lin(a0, d, -dot(a0, d))) };
  };
  const goal = lineAt(t1, f);
  const miss = (r: { pos: Vec3[]; e2: Vec3 }): [number, number] => {
    const e = lin(goal, r.pos[r.pos.length - 1], -1);
    return [dot(e, d), dot(e, r.e2)];
  };
  let ts = t1 - 12;
  let sc = 0.015;
  for (let it = 0; it < 40; it++) {
    const m = miss(fly(ts, sc));
    if (Math.hypot(m[0], m[1]) < 1e-8) break;
    const dT = 1e-3;
    const dS = 1e-5;
    const mT = miss(fly(ts + dT, sc));
    const mS = miss(fly(ts, sc + dS));
    const J = [(mT[0] - m[0]) / dT, (mS[0] - m[0]) / dS, (mT[1] - m[1]) / dT, (mS[1] - m[1]) / dS];
    const det = J[0] * J[3] - J[1] * J[2];
    const stepT = (J[3] * m[0] - J[1] * m[1]) / det;
    const stepS = (J[0] * m[1] - J[2] * m[0]) / det;
    ts -= Math.max(-1, Math.min(1, stepT));
    sc = Math.max(0.002, sc - Math.max(-0.005, Math.min(0.005, stepS)));
  }
  const r = fly(ts, sc);
  const total = r.run[r.run.length - 1] || 1;
  const turn: Turn = { t0: r.t0, t1, pos: r.pos, along: r.run.map((x) => x / total), rest: lin(goal, r.pos[r.pos.length - 1], -1), ts, speed: sc };
  turns.set(f, turn);
  return turn;
}

function placeAt(t: number, f: WebFrame, p: DriftParams, eye: Vec3 | null): { eyePat: Vec3; box: number } {
  const tr = turnFor(f, p);
  if (t < tr.t0) return { eyePat: pullAt(t, f, p), box: webFlight(t, p).box };
  if (t < f.actStart || !eye) {
    if (t >= tr.t1) return { eyePat: lineAt(t, f), box: f.box };
    const x = (t - tr.t0) / ((tr.t1 - tr.t0) / (tr.pos.length - 1));
    const i = Math.min(tr.pos.length - 2, Math.floor(x));
    const at = lin(tr.pos[i], lin(tr.pos[i + 1], tr.pos[i], -1), x - i);
    const along = tr.along[i] + (tr.along[i + 1] - tr.along[i]) * (x - i);
    return { eyePat: lin(at, tr.rest, along * along * along * (along * (along * 6 - 15) + 10)), box: webFlight(t, p).box };
  }
  return { eyePat: lin(f.target, toPattern(f.R, lin(eye, f.sun, -1)), 1 / f.box), box: f.box };
}

/**
 * Where the eye is in the web at show time t, seen from `eye` (its world position: Undertime's still eye before the
 * act, the approach's after it). Pure: a function of t and the eye the show puts there.
 */
export function webPlace(t: number, eye: Vec3, f: WebFrame, p: DriftParams): WebPlace {
  const now = placeAt(t, f, p, eye);
  // (the velocity from the curve itself: the world eye of t ± H is not to hand, and from the act on it is the curve)
  const a = placeAt(t - H, f, p, null).eyePat;
  const b = placeAt(t + H, f, p, null).eyePat;
  return { ...now, vel: [0, 1, 2].map((i) => (b[i] - a[i]) / (2 * H)) as Vec3 };
}

/** world position of pattern point k in Get the Drift's world: its image nearest `near` (pattern) */
export function diveWorld(f: WebFrame, k: Vec3, near: Vec3 = f.target): Vec3 {
  const rel = lin(lin(near, f.target, -1), wrap(lin(k, near, -1)), 1);
  return lin(f.sun, toWorld(f.R, rel), f.box);
}
