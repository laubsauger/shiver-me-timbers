/**
 * C3's dolphin (drift-narrative/wandering-on/direction.md: "a dolphin surfaces beside the raft, circles, and flips
 * something onto the deck with its snout"). At last light it is seen as a dark outline against the afterglow, so
 * what matters is the outline and the motion (the user, 2026-10-27: "shape and movement … only the outline really
 * visible; motion curves and the speed / timing" over geometry at close range). No model: the v9 stand-in was a
 * spindle that hopped in sine bumps at 1.3 m/s, a blob.
 *
 * THE OUTLINE: a bottlenose's proportions, 2.6 m: a short beak, the melon rising steeply behind it, the body
 * deepest a third of the way back, a falcate dorsal fin (swept, its trailing edge concave), pectoral flippers
 * angled back and down, the tail stock narrowing and laterally compressed, crescent flukes with a notch.
 * Counter-shaded: dark above, pale below.
 *
 * THE MOTION, as a dolphin travels near the surface: it swims at 3–6 m/s about a metre down (out of sight at
 * last light) and comes up in three ways — a ROLL (the back and fin roll out and under, the blow), a LEAP
 * (ballistic: out at the speed and angle that clear the water by `h`, its body along its path, arched to the
 * arc's curvature), and the FLIP (a steep, slow lunge, head high, at the raft). Under water its tail beats; in
 * the air it does not. A pure function of the time into c3; positions in the eye's level frame.
 */
import * as THREE from 'three/webgpu';
import { exp, float, mix, positionLocal, sin, smoothstep, uniform, vec3 } from 'three/tsl';
import { SAILING, beatStarts, raftPose, speedAt } from './beats';

/** m/s² */
const G = 9.81;
/** m: the body's centre while it swims between surfacings, under the water */
const DEPTH = 1.3;
/** m: the body's centre at the top of a roll (the back and the fin out) */
const ROLL_TOP = -0.05;
/** s a roll takes, from going up to going down again (at ~3.5 m/s its nose rises ~24°: a dolphin's roll) */
const ROLL = 2.4;
/** Hz the tail beats at under water, m it swings at the flukes */
const BEAT = 2.2;
const BEAT_AMP = 0.12;

export type SurfacingKind = 'roll' | 'leap' | 'flip' | 'swim';
/** s into c3 (a roll: its top; a leap or the flip: where it leaves the water), m right of the eye and m ahead
 * of it (its level frame), how it comes up, and m a leap's centre clears the water by */
export type Surfacing = [number, number, number, SurfacingKind, number?];

/**
 * C3'S RAFT, as the dolphin's choreography is laid about it (beats.ts POSE_KEYS, c3: settled by 14 s, held through
 * the flip; tests/driftDolphin.test.ts holds the two together): its centre's bearing (deg right of the front) and
 * distance (m) from the eye, and its heading (deg: its bow swung that far to the left, broadside to us).
 */
export const C3_RAFT = { bearing: 10, distance: 10, heading: 70 };

const D = Math.PI / 180;
/** eye-frame (x right, z ahead) of a raft-local spot (across toward the eye, along toward the bow) */
export function c3RaftPoint(across: number, along: number): [number, number] {
  const c: [number, number] = [Math.sin(C3_RAFT.bearing * D) * C3_RAFT.distance, Math.cos(C3_RAFT.bearing * D) * C3_RAFT.distance];
  const a: [number, number] = [-Math.sin(C3_RAFT.heading * D), Math.cos(C3_RAFT.heading * D)];
  // across: the side facing the eye
  const n0: [number, number] = [a[1], -a[0]];
  const n: [number, number] = n0[0] * -c[0] + n0[1] * -c[1] > 0 ? n0 : [-n0[0], -n0[1]];
  return [c[0] + a[0] * along + n[0] * across, c[1] + a[1] * along + n[1] * across];
}
/** eye-frame (x right, z ahead) of a bearing (deg right of the front) and a distance (m) */
const seen = (bearing: number, distance: number): [number, number] => [Math.sin(bearing * D) * distance, Math.cos(bearing * D) * distance];

/**
 * THE STAGE (the 2026-11-01 review: "We need a better view of the dolphin and to make it easier to understand what's
 * happening"). Stills every 2 s through c3 and dome masters at 390–414 s showed the dolphin never in the 16:9 frame
 * (±30°): it came in 45–50° left, leapt at 31–45° left, rolled 7 m off our left where the water is under the tilted
 * dome's rim, circled behind our left shoulder (76–103°), flipped from 40° left at the dome's bottom edge and left
 * behind us on the right — on the dome a speck near the rim, in the 16:9 one splash. And it leapt in dark water left
 * of the light. What the eye has from here: the Sun setting 22° left, its glitter road on the water from ~16° to ~28°
 * left, the raft's bow at 21° left under it, the set sail and the cabin filling 11° left to 30°+ right. So the stage
 * is the open water and the sky LEFT OF THE SAIL, 12–38° left, in the Sun's light: every surfacing that matters is
 * there, backlit (at last light a dark body reads only against the bright sea or sky), and none is closer than ~14 m
 * ahead (the rim: a point shows while its drop below the eye is under its distance ahead × tan 15°).
 *
 * THE CASE IS THERE FROM THE START: a blue hard case afloat in the debris, drifting down on the raft as it sails (it
 * rides the water; the raft and the eye make way past it, beats.ts speedAt and the raft's heading), so the audience
 * has seen it before the dolphin finds it. The dolphin noses it, circles off and comes up under it, and flips it.
 *
 *   3–6 s    first sighting far out on the glitter road: a low leap at 54 m, its spray in the Sun, and a roll
 *   8–11 s   two leaps across the Sun's line, left to right, side-on: the second, 2.4 m, by the Sun itself
 *   13–19 s  it turns back toward us: a leap nearer in the glitter (24 m), a roll off the case's near side, and a
 *            loop out to the left — the circle, part of it past the 16:9 frame's left edge
 *   22.4 s   the nose: it rolls up to the case from the left, its head at it, and nudges it on (the case rocks)
 *   26.8 s   the flip: under the case again, slowly, and up head-high, 25° left and 16 m out, just under the setting
 *            Sun (its elevation ~0.2° by then): the case flicked off its snout, up over the horizon against the
 *            afterglow and down onto the fore-deck, 16° left, 11 m off, in plain view; it hops and skids to a stop
 *   29–41 s  the dolphin away, the way it came: a roll and a last leap in the afterglow, and gone
 *
 * The flip is thrown from beyond the bow, across it toward us: from the raft's far side, ahead of the mast and the
 * cabin, so the throw passes over nothing but the bow (from the near side the dolphin had to be between us and the
 * raft, under the dome's rim — the v10 review — and from along the bow line it was 40° left, off the stage).
 */
/** where the case lands, on the raft: m across from its centreline toward the eye, and m forward of its centre: the
 * fore-deck's foremost logs, ahead of the mast (1.2 m) and the people about its foot, left of the sail as we see it
 * (at 3.0 m, 1.9 m across, it came down in the sail's edge among the people) */
export const CASE_ON_DECK = { across: 0.6, along: 5.0 };
/** the flip: where the dolphin comes up under the case, raft-local (m across toward the eye: negative, its far side;
 * m along toward the bow: 2.75 m past its tip, clear of it) — 25° left, 16 m out, the Sun's line */
const FLIP_AT = { across: -1.6, along: 9.6 };
/** s into c3: the dolphin noses the case, and comes up under it for the flip (leaves the water) */
const NOSE_T = 22.4;
const FLIP_T = 26.8;
/** m the nose pushes the case along the dolphin's heading, and s that takes (an exponential's time constant) */
export const CASE_PUSH = 0.6;
const PUSH_TAU = 0.35;
/** s into c3 the case comes up out of the swell, far out (~60 m: a speck nobody sees arrive) */
export const CASE_FROM = -12;
/** m from the body's centre to the beak's tip */
const NOSE = 1.3;

/** the deck spot (eye frame), where the flip is, and the throw's line from one to the other */
export const CASE_TARGET: [number, number] = c3RaftPoint(CASE_ON_DECK.across, CASE_ON_DECK.along);
const FLIP_XZ: [number, number] = c3RaftPoint(FLIP_AT.across, FLIP_AT.along);
const LINE: [number, number] = (() => {
  const d = [CASE_TARGET[0] - FLIP_XZ[0], CASE_TARGET[1] - FLIP_XZ[1]];
  const l = Math.hypot(d[0], d[1]);
  return [d[0] / l, d[1] / l];
})();
/** k m back along the throw's line from the flip (negative: on past it, toward the raft) */
const onLine = (k: number): [number, number] => [FLIP_XZ[0] - LINE[0] * k, FLIP_XZ[1] - LINE[1] * k];

/**
 * THE WATER PAST THE EYE: the eye and the raft make way through the water along the raft's heading (sea.ts sailedFrom:
 * its speed beats.ts speedAt, its heading the raft's pose), so anything afloat drifts the other way in the eye's frame,
 * at 1.2 m/s through c2, easing to 0.6 m/s by 12 s into c3 as the raft swings broadside. The c3-relative clock: the
 * beats laid from a c1 that ends at 0 (only differences matter, and the raft's pose from c2 + 14 s on is the beats'
 * keys alone, not c1's rest pose). DRIFT[i]: m the water moves past the eye from CASE_FROM + i·DRIFT_STEP to FLIP_T.
 */
const SEA = beatStarts(0);
const DRIFT_STEP = 0.05;
const DRIFT: Array<[number, number]> = (() => {
  const n = Math.ceil((FLIP_T - CASE_FROM) / DRIFT_STEP);
  const out: Array<[number, number]> = new Array(n + 1);
  out[n] = [0, 0];
  for (let i = n - 1; i >= 0; i--) {
    const t = SEA.starts.c3 + CASE_FROM + (i + 0.5) * DRIFT_STEP;
    const v = speedAt(t, SEA.starts);
    const h = raftPose(t, 0, SAILING).heading;
    // (the eye goes along the bow, (−sin h, cos h) in its own frame; what floats is left that far behind)
    out[i] = [out[i + 1][0] - Math.sin(h) * v * DRIFT_STEP, out[i + 1][1] + Math.cos(h) * v * DRIFT_STEP];
  }
  return out;
})();
/** m the water has yet to move past the eye between s (into c3) and the flip, eye frame */
function driftToFlip(s: number): [number, number] {
  const u = Math.min(DRIFT.length - 1, Math.max(0, (s - CASE_FROM) / DRIFT_STEP));
  const i = Math.min(DRIFT.length - 2, Math.floor(u));
  const f = u - i;
  return [DRIFT[i][0] + (DRIFT[i + 1][0] - DRIFT[i][0]) * f, DRIFT[i][1] + (DRIFT[i + 1][1] - DRIFT[i][1]) * f];
}

/**
 * THE PATH IN: the leaps and the circle, then the nose and the flip on the throw's line. The nose's waypoint is put
 * where the case is then (it drifts: driftToFlip), the dolphin's beak at it. Spaced for ~2.5–3.5 m/s, a dolphin's
 * cruise; slow from the nose on, idling with the case (~1 m/s), and up into the flip almost straight (its head high).
 * A `swim` is a waypoint under water (no surfacing).
 */
const MID: [number, number] = onLine(3.4);
const LOOP: [number, number] = [-13.6, 19.0];
/** the nose's heading: from the loop's last waypoint toward the case, and on to the throw's line */
const NOSE_DIR: [number, number] = (() => {
  const c = driftToFlip(NOSE_T);
  const d = [FLIP_XZ[0] + c[0] - LOOP[0], FLIP_XZ[1] + c[1] - LOOP[1]];
  const l = Math.hypot(d[0], d[1]);
  return [d[0] / l, d[1] / l];
})();
/** where the case floats at s (into c3; eye frame, m) until the dolphin picks it up: the flip's spot, plus the water
 * still to drift past by then, less the nose's push before it is given */
export function caseAfloat(s: number): [number, number] {
  const d = driftToFlip(s);
  const pushed = s < NOSE_T ? 0 : 1 - Math.exp(-(s - NOSE_T) / PUSH_TAU);
  return [FLIP_XZ[0] + d[0] - NOSE_DIR[0] * CASE_PUSH * (1 - pushed), FLIP_XZ[1] + d[1] - NOSE_DIR[1] * CASE_PUSH * (1 - pushed)];
}
export const NOSE_AT = NOSE_T;
export const FLIP_AT_T = FLIP_T;
const NOSE_XZ: [number, number] = (() => {
  const c = caseAfloat(NOSE_T - 1e-6);
  return [c[0] - NOSE_DIR[0] * NOSE, c[1] - NOSE_DIR[1] * NOSE];
})();

/** the turn away after the flip: on a 2.5 m circle to the dolphin's left from where it leaves the line (onLine(−2.4)),
 * `deg` round it */
function turnOff(deg: number): [number, number] {
  const r = 2.5;
  const p = onLine(-2.4);
  const left: [number, number] = [-LINE[1], LINE[0]];
  const c = [p[0] + left[0] * r, p[1] + left[1] * r];
  const a = deg * D;
  const r0 = [p[0] - c[0], p[1] - c[1]];
  return [c[0] + r0[0] * Math.cos(a) - r0[1] * Math.sin(a), c[1] + r0[0] * Math.sin(a) + r0[1] * Math.cos(a)];
}

export const SURFACINGS: Surfacing[] = [
  // first sighting, far out on the glitter road: a low leap (its spray catches the Sun: a roll's back and fin 52 m
  // out were lost among the debris, 2026-11-01), and a roll
  [3.0, ...seen(-31, 54), 'leap', 1.1],
  [5.8, ...seen(-28, 46), 'roll'],
  // two leaps across the Sun's line, left to right: the second by the Sun
  [8.4, ...seen(-23.5, 38.5), 'leap', 1.4],
  [10.9, ...seen(-14, 36), 'leap', 2.4],
  // round toward us, under the horizon's glitter, and a leap nearer in it, going left
  [13.4, ...seen(-12, 29), 'swim'],
  [15.2, ...seen(-22, 23), 'leap', 1.6],
  // the circle: off the case's near side, out past the frame's left edge, round behind, and back at it from the left
  [18.0, ...seen(-38, 18.5), 'roll'],
  [19.1, -15.3, 14.9, 'swim'],
  [20.1, -16.6, 18.0, 'swim'],
  [21.0, ...LOOP, 'swim'],
  [NOSE_T, ...NOSE_XZ, 'roll'],
  // under the case and along the throw's line, slowly, and up into the flip; then down, a metre on, short of the bow
  [24.6, ...MID, 'swim'],
  [FLIP_T, ...FLIP_XZ, 'flip', 0.9],
  // (two waypoints on the line past the flip, so its heading through the flip and the release is the line's)
  [28.0, ...onLine(-1.5), 'swim'],
  [28.8, ...onLine(-2.4), 'swim'],
  // away the way it came: round under the bow, at depth (a left turn of ~2.5 m radius off the line), out on the raft's
  // far side, and a roll, a last leap in the afterglow and a roll far out, back along the Sun's line
  [30.0, ...turnOff(90), 'swim'],
  [31.2, ...turnOff(180), 'swim'],
  [33.9, ...seen(-18, 25), 'roll'],
  [36.3, ...seen(-24, 34), 'leap', 1.2],
  [39.0, ...seen(-29, 42), 'roll'],
];
/** s it swims on after the last surfacing (out of sight) */
const AWAY = 3.5;

export interface DolphinPose {
  /** m, eye frame: x right, y up (the sea's 0), z ahead */
  x: number;
  y: number;
  z: number;
  /** rad: its heading (0: along +z, ahead; positive: turning right), and its nose up */
  heading: number;
  pitch: number;
  /** 1/m: the body's arch along its length (positive: nose and tail down), its sideways bend into a turn (positive:
   * turning right, nose and tail toward the turn's centre), the tail beat's swing (m), its phase */
  bend: number;
  turn: number;
  /** rad: its lean into the turn (positive: right side down) */
  bank: number;
  beat: number;
  phase: number;
  /** m/s along the water */
  speed: number;
  /** s since its back last came up out of the water (0 under it): the sheet of water running off (outOfWaterFor) */
  dry: number;
}

/** the path over the water: a Catmull-Rom through the surfacings (and a lead-in and a lead-out along their line) */
function track(t: number): { x: number; z: number; vx: number; vz: number } {
  const k = SURFACINGS.map(([at, x, z]) => [at, x, z] as [number, number, number]);
  const first = k[0];
  const second = k[1];
  const last = k[k.length - 1];
  const prev = k[k.length - 2];
  const lead: [number, number, number] = [first[0] - 3, first[1] * 2 - second[1], first[2] * 2 - second[2]];
  const out: [number, number, number] = [last[0] + AWAY, last[1] * 2 - prev[1], last[2] * 2 - prev[2]];
  const keys = [lead, ...k, out];
  let i = 0;
  while (i < keys.length - 2 && t > keys[i + 1][0]) i++;
  const p0 = keys[Math.max(0, i - 1)];
  const p1 = keys[i];
  const p2 = keys[i + 1];
  const p3 = keys[Math.min(keys.length - 1, i + 2)];
  const h = p2[0] - p1[0];
  const u = Math.min(1, Math.max(0, (t - p1[0]) / h));
  // (non-uniform Catmull-Rom: tangents from the neighbours' slopes in time, so the speed is continuous)
  const tan = (a: [number, number, number], b: [number, number, number], c: [number, number, number], j: 1 | 2) =>
    ((b[j] - a[j]) / Math.max(1e-6, b[0] - a[0]) + (c[j] - b[j]) / Math.max(1e-6, c[0] - b[0])) / 2;
  const m1 = [tan(p0, p1, p2, 1), tan(p0, p1, p2, 2)];
  const m2 = [tan(p1, p2, p3, 1), tan(p1, p2, p3, 2)];
  const h00 = 2 * u ** 3 - 3 * u ** 2 + 1;
  const h10 = u ** 3 - 2 * u ** 2 + u;
  const h01 = -2 * u ** 3 + 3 * u ** 2;
  const h11 = u ** 3 - u ** 2;
  const d00 = (6 * u ** 2 - 6 * u) / h;
  const d10 = 3 * u ** 2 - 4 * u + 1;
  const d01 = (-6 * u ** 2 + 6 * u) / h;
  const d11 = 3 * u ** 2 - 2 * u;
  return {
    x: h00 * p1[1] + h10 * h * m1[0] + h01 * p2[1] + h11 * h * m2[0],
    z: h00 * p1[2] + h10 * h * m1[1] + h01 * p2[2] + h11 * h * m2[1],
    vx: d00 * p1[1] + d10 * m1[0] + d01 * p2[1] + d11 * m2[0],
    vz: d00 * p1[2] + d10 * m1[1] + d01 * p2[2] + d11 * m2[1],
  };
}

/** the body's centre height, and its first and second derivatives, at t */
function rise(t: number): [number, number, number] {
  for (const [at, , , kind, h = 0] of SURFACINGS) {
    if (kind === 'swim') continue;
    if (kind === 'roll') {
      const s = t - (at - ROLL / 2);
      if (s < 0 || s > ROLL) continue;
      // −D + A sin²(πs/R): up and over and down, level at both ends
      const A = DEPTH + ROLL_TOP;
      const w = (2 * Math.PI) / ROLL;
      return [-DEPTH + (A * (1 - Math.cos(w * s))) / 2, (A * w * Math.sin(w * s)) / 2, (A * w * w * Math.cos(w * s)) / 2];
    }
    // a leap: up from the depth at a steady pull, out at vy0, ballistic, back in and levelled off, mirrored
    const vy0 = Math.sqrt(2 * G * h);
    const air = (2 * vy0) / G;
    const pull = (2 * DEPTH) / vy0;
    const s = t - at;
    if (s < -pull || s > air + pull) continue;
    if (s < 0) {
      const a = vy0 / pull;
      const q = s + pull;
      return [-DEPTH + (a * q * q) / 2, a * q, a];
    }
    if (s <= air) return [vy0 * s - (G * s * s) / 2, vy0 - G * s, -G];
    const a = vy0 / pull;
    const q = s - air;
    return [-vy0 * q + (a * q * q) / 2, -vy0 + a * q, a];
  }
  return [-DEPTH, 0, 0];
}

/** the time window it is drawn in (s into c3): from its first approach to well after its last dive */
export const DOLPHIN_SPAN: [number, number] = [SURFACINGS[0][0] - 3, SURFACINGS[SURFACINGS.length - 1][0] + AWAY];

/** the flip: s into c3 the case leaves the snout — on the way up, the head still high and coming forward (at the
 * top of the arc the body is level, and a case let go there drops off its back) */
export const FLIP_RELEASE = (() => {
  const f = SURFACINGS.find((x) => x[3] === 'flip')!;
  return f[0] + (0.6 * Math.sqrt(2 * G * (f[4] ?? 0))) / G;
})();

/** the throw at the flip, in the eye's level frame: where the case leaves the snout (x, y, z), the way it goes
 * along the water (unit: the dolphin's own heading, at the deck spot), and the deck spot it comes down on */
export function flipThrow(): { from: [number, number, number]; dir: [number, number]; to: [number, number] } {
  const d = dolphinPose(FLIP_RELEASE);
  const cp = Math.cos(d.pitch);
  const nose = 1.3;
  const dir: [number, number] = [Math.sin(d.heading), Math.cos(d.heading)];
  return { from: [d.x + dir[0] * nose * cp, d.y + nose * Math.sin(d.pitch), d.z + dir[1] * nose * cp], dir, to: CASE_TARGET };
}

/**
 * The case's deck spot and the throw's line in the RAFT's own frame (x across, z toward the bow: raft.ts), from c3's
 * pose — where it stays aboard whatever the raft's pose against the eye later. (Found from the eye-frame spot every
 * frame, it fell off the deck once the raft's pose changed: afloat beside the raft through c4 and along the coast,
 * the v10 review.)
 */
export function caseOnDeck(): { spot: [number, number]; dir: [number, number] } {
  const h = C3_RAFT.heading * D;
  // the raft's bow and its +x in the eye frame (x right, z ahead; its heading eyeYaw + h + π, raft.ts)
  const bow: [number, number] = [-Math.sin(h), Math.cos(h)];
  const side: [number, number] = [-Math.cos(h), -Math.sin(h)];
  const rel: [number, number] = [CASE_TARGET[0] - Math.sin(C3_RAFT.bearing * D) * C3_RAFT.distance, CASE_TARGET[1] - Math.cos(C3_RAFT.bearing * D) * C3_RAFT.distance];
  const { dir } = flipThrow();
  return {
    spot: [rel[0] * side[0] + rel[1] * side[1], rel[0] * bow[0] + rel[1] * bow[1]],
    dir: [dir[0] * side[0] + dir[1] * side[1], dir[0] * bow[0] + dir[1] * bow[1]],
  };
}

/** what a splash throws (splash.ts): spray flung up and out where the body crosses the surface; the blow's mist (none
 * drawn: see dolphinSplashes); a RING of foam spreading on the water where it broke it; DRIPS falling off the body in
 * the air */
export type SplashKind = 'spray' | 'blow' | 'ring' | 'drip';
/** a splash (splash.ts): s into c3, where (eye frame, m) and how high (m: where its drops start), the body's velocity
 * along the water then (m/s), how hard (0..1: the drops' throw; a drip's: the share of its drops drawn), and its kind */
export interface Splash {
  at: number;
  x: number;
  z: number;
  y: number;
  vx: number;
  vz: number;
  /** m/s: the body's vertical velocity then (a drip's: its drops leave with it) */
  vy: number;
  energy: number;
  kind: SplashKind;
}

/** s between the drip splashes shed along a leap in the air (splash.ts spreads each one's drops over it) */
const DRIP_EVERY = 0.22;

/** where the dolphin throws water: out of the sea and back into it at each leap and at the flip (harder coming down,
 * and the harder the higher it went), a ring of foam spreading where it broke the water, and drips off the body in the
 * air; at a roll only the ring its back raises, a small one (the coordinator's 2026-11-01 note: "the water it breaks: a
 * short wake/ring"). No blows at the rolls: a dolphin's is a faint puff, and drawn as a column it read as a whale's
 * spout (the v9 review). At the nose, the water it pushes up at the case */
export function dolphinSplashes(): Splash[] {
  const out: Splash[] = [];
  const add = (t: number, energy: number, kind: SplashKind, y = 0, vy = 0): void => {
    const p = track(t);
    out.push({ at: t, x: p.x, z: p.z, y, vx: p.vx, vz: p.vz, vy, energy, kind });
  };
  for (const [t, , , kind, h = 0] of SURFACINGS) {
    if (kind === 'swim') continue;
    if (kind === 'roll') {
      add(t - 0.2, t === NOSE_T ? 0.45 : 0.25, 'ring');
      if (t === NOSE_T) add(t, 0.25, 'spray');
      continue;
    }
    const vy0 = Math.sqrt(2 * G * h);
    const air = (2 * vy0) / G;
    const k = Math.min(1, vy0 / 6.5);
    add(t, 0.25 + 0.25 * k, 'spray');
    add(t, 0.4 + 0.3 * k, 'ring');
    add(t + air, 0.45 + 0.35 * k, 'spray');
    add(t + air, 0.7 + 0.3 * k, 'ring');
    // water running off it in the air: shed from the body's middle as it goes, fewer as it dries
    // (each from the body's centre and with its velocity then: splash.ts sends its drops off along the body's path)
    // (a thin trickle off the flukes for the first half second out: 2026-11-01, "only a thin trickle")
    for (let s = 0.08; s < Math.min(air - DRIP_EVERY, 0.55); s += DRIP_EVERY) add(t + s, 0.03 * Math.exp(-s / 0.4), 'drip', rise(t + s)[0], rise(t + s)[1]);
  }
  return out;
}

/**
 * THE WET SKIN (the user, 2026-11-01: "the dolphin should be slightly wet"): s since the body last came up out of the
 * water — 0 under it — so the sheet of water on it can run off and thin over the next second or two. Pure in t: looked
 * back for the moment its back broke the surface, in 0.05 s steps, at most SHEET s.
 */
const SHEET = 2;
export function outOfWaterFor(t: number): number {
  // (its back, ~0.3 m over its centre: out once that is over the water)
  if (rise(t)[0] + 0.3 < 0) return 0;
  let s = 0;
  while (s < SHEET && rise(t - s - 0.05)[0] + 0.3 >= 0) s += 0.05;
  return s;
}

/** the path's heading and pitch at t (no bends: what the bends are measured from) */
function aim(t: number): { heading: number; pitch: number; vh: number; v: number } {
  const p = track(t);
  const [, vy] = rise(t);
  const vh = Math.max(0.3, Math.hypot(p.vx, p.vz));
  return { heading: Math.atan2(p.vx, p.vz), pitch: Math.atan2(vy, vh), vh, v: Math.hypot(vh, vy) };
}
/** s: the window the body's bends are measured over (a body ~2.6 m long at ~3 m/s spans ~0.9 s of its path; the
 * path's own curvature steps at every waypoint, and a bend taken from it snapped the body there) */
const BEND_WINDOW = 0.5;
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * THE BODY FOLLOWS ITS PATH: bent into the path's curvature in both planes — arched over a leap, curved into a
 * turn, its nose and tail on the curve rather than on a straight plank about its middle (the v9 review: "a stiff
 * plank of dolphin … rotates in place") — and leaning into its turns.
 */
/** the path's curvature about t, in its vertical plane and across it (1/m), over BEND_WINDOW */
function curvature(t: number): { bend: number; turn: number } {
  const a = aim(t);
  const a0 = aim(t - BEND_WINDOW);
  const a1 = aim(t + BEND_WINDOW);
  // (over a speed of at least BEND_SPEED: idling at the case, ~1 m/s, a turn of the body in place is not a fold of it —
  // at the path's own speed the arch hit its clamp and let go again within frames, as the nose roll ended and as the
  // flip's lunge began: the 2026-11-01 choreography)
  return {
    bend: Math.max(-0.5, Math.min(0.5, -(a1.pitch - a0.pitch) / (2 * BEND_WINDOW * Math.max(a.v, BEND_SPEED)))),
    turn: Math.max(-0.5, Math.min(0.5, wrap(a1.heading - a0.heading) / (2 * BEND_WINDOW * Math.max(a.vh, BEND_SPEED)))),
  };
}
/** m/s: the least speed the body's bends are taken over (curvature) */
const BEND_SPEED = 2;

export function dolphinPose(t: number): DolphinPose {
  const p = track(t);
  const [y] = rise(t);
  const a = aim(t);
  // (and eased in time, a triangle over ±0.3 s: a body does not take up a new curve in a frame)
  let bend = 0;
  let turn = 0;
  for (const [dt, w] of [[-0.3, 0.25], [0, 0.5], [0.3, 0.25]]) {
    const c = curvature(t + dt);
    bend += c.bend * w;
    turn += c.turn * w;
  }
  const bank = Math.max(-0.6, Math.min(0.6, Math.atan((a.vh * a.vh * turn) / G)));
  // the tail beats under water, stills as the body leaves it
  const wet = 1 - smoothstep01((y + 0.6) / 0.5);
  return { x: p.x, y, z: p.z, heading: a.heading, pitch: a.pitch, bend, turn, bank, beat: BEAT_AMP * wet, phase: 2 * Math.PI * BEAT * t, speed: a.vh, dry: outOfWaterFor(t) };
}

function smoothstep01(x: number): number {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
}

// ------------------------------------------------------------------ the outline

/** m: the body's length; its stations from the beak (0) to the flukes' notch (1): the back's and the belly's
 * height over the body's axis, and the half-width (side and plan views of a bottlenose) */
const LENGTH = 2.6;
const STATIONS: Array<[number, number, number, number]> = [
  [0.0, 0.0, -0.01, 0.005],
  [0.02, 0.03, -0.03, 0.03],
  [0.06, 0.05, -0.05, 0.05],
  [0.1, 0.06, -0.06, 0.06],
  [0.13, 0.12, -0.1, 0.1],
  [0.17, 0.19, -0.15, 0.15],
  [0.22, 0.24, -0.2, 0.2],
  [0.3, 0.29, -0.25, 0.25],
  [0.4, 0.32, -0.28, 0.27],
  [0.5, 0.31, -0.27, 0.25],
  [0.6, 0.27, -0.23, 0.2],
  [0.7, 0.21, -0.17, 0.14],
  [0.8, 0.14, -0.11, 0.08],
  [0.88, 0.09, -0.07, 0.05],
  [0.94, 0.06, -0.05, 0.04],
  [0.97, 0.04, -0.03, 0.03],
  [1.0, 0.02, -0.01, 0.015],
];

/** body-frame z (the beak at −LENGTH/2, along −z) of station s */
const zAt = (s: number): number => -LENGTH / 2 + LENGTH * s;

function profile(s: number): [number, number, number] {
  let i = 0;
  while (i < STATIONS.length - 2 && s > STATIONS[i + 1][0]) i++;
  const a = STATIONS[i];
  const b = STATIONS[i + 1];
  const u = smoothstep01((s - a[0]) / (b[0] - a[0]));
  return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u];
}

function bodyGeometry(): THREE.BufferGeometry {
  const RINGS = 48;
  const AROUND = 24;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= RINGS; i++) {
    const s = i / RINGS;
    const [top, bot, hw] = profile(s);
    const yc = (top + bot) / 2;
    const hh = (top - bot) / 2;
    for (let j = 0; j < AROUND; j++) {
      const a = (j / AROUND) * Math.PI * 2;
      // a superellipse a little fuller than an ellipse (a dolphin's flanks are flat-ish, not round)
      const c = Math.cos(a);
      const sn = Math.sin(a);
      const e = 0.85;
      pos.push(Math.sign(c) * Math.abs(c) ** e * hw, yc + Math.sign(sn) * Math.abs(sn) ** e * hh, zAt(s));
    }
  }
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < AROUND; j++) {
      const a = i * AROUND + j;
      const b = i * AROUND + ((j + 1) % AROUND);
      idx.push(a, a + AROUND, b, b, a + AROUND, b + AROUND);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** a fin from its outline (x, y in its own plane), `thick` m thick, placed by `m` */
function fin(outline: Array<[number, number]>, thick: number, m: THREE.Matrix4): THREE.BufferGeometry {
  const sh = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(sh, { depth: thick, bevelEnabled: true, bevelThickness: thick * 0.4, bevelSize: thick * 0.4, bevelSegments: 2, curveSegments: 6 });
  g.translate(0, 0, -thick / 2);
  g.applyMatrix4(m);
  return g;
}

/** a smooth outline through control points (a closed Catmull-Rom, sampled) */
function smoothOutline(pts: Array<[number, number]>, n = 10): Array<[number, number]> {
  const c = new THREE.SplineCurve(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  return c.getPoints(pts.length * n).map((p) => [p.x, p.y]);
}

export interface Dolphin {
  readonly group: THREE.Group;
  set(p: DolphinPose): void;
}

export function createDolphin(): Dolphin {
  const uBend = uniform(0);
  const uTurn = uniform(0);
  const uBeat = uniform(0);
  const uPhase = uniform(0);
  const uDry = uniform(0);
  // WET (the user, 2026-11-01: "the dolphin should be slightly wet"): a dolphin's skin is smooth and always wet — a
  // glossy coat over a darker skin (wet skin is darker: the water film takes the scatter out of it), its highlights
  // sharp. Just out of the water a SHEET runs off it: streaks along the body, running tail-ward, that sharpen the
  // highlights to glints and thin out over ~1.5 s (uDry: s out of the water). Backlit at last light it is the rim of
  // highlights along its back that tells it is wet.
  const mat = new THREE.MeshPhysicalNodeMaterial({ metalness: 0 });
  // counter-shaded: the back dark slate, the belly pale — both a step darker, wet
  // (the belly 0.3, not 0.5: turned toward us in the leaps' descent, backlit, it read flat pale grey and cut out —
  // 2026-11-01; a dolphin's belly is pale, but not paler than the sky-lit sea round it)
  mat.colorNode = mix(vec3(0.3, 0.31, 0.32), vec3(0.1, 0.115, 0.135), smoothstep(-0.12, 0.1, positionLocal.y));
  const sheet = exp(uDry.mul(-1 / 0.6));
  // (streaks: thin lines along the body, round its girth, beaded and running toward the flukes, +z)
  const streak = smoothstep(0.55, 0.95, sin(positionLocal.x.mul(53).add(positionLocal.y.mul(41)).add(sin(positionLocal.z.mul(3.1)).mul(2))))
    .mul(smoothstep(0.2, 0.9, sin(positionLocal.z.mul(9).sub(uPhase.mul(0.55)))));
  mat.roughnessNode = mix(float(0.3), float(0.14), sheet);
  mat.clearcoatNode = float(1);
  mat.clearcoatRoughnessNode = mix(float(0.09), float(0.02), sheet.mul(streak.mul(0.7).add(0.3)));
  // the arch (nose and tail toward the arc's centre) and, under water, the tail's beat, a wave running to the
  // flukes, growing toward them
  const z = positionLocal.z;
  const tail = smoothstep(-0.2, LENGTH / 2, z);
  const dy = uBend.mul(z.mul(z)).mul(-0.5).add(uBeat.mul(tail.mul(tail)).mul(sin(uPhase.sub(z.mul(2.2)))));
  // …and into a turn: both ends toward the turn's centre (local +x is the dolphin's right)
  const dx = uTurn.mul(z.mul(z)).mul(0.5);
  mat.positionNode = positionLocal.add(vec3(dx, dy, float(0)));

  const parts: THREE.BufferGeometry[] = [bodyGeometry()];
  // the dorsal fin: falcate, on the back from 0.42 to 0.60 of the length, its tip swept back past its base
  const s0 = zAt(0.42);
  const back = profile(0.5)[0];
  const rotFin = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), new THREE.Vector3(-1, 0, 0));
  parts.push(fin(smoothOutline([[0, -0.03], [0.06, 0.12], [0.2, 0.24], [0.4, 0.29], [0.36, 0.2], [0.38, 0.08], [0.48, -0.03]], 8), 0.035, new THREE.Matrix4().makeTranslation(0, back - 0.035, s0).multiply(rotFin)));
  // the pectorals: paddles from the flanks a quarter back, angled back and down
  for (const side of [-1, 1]) {
    const span = new THREE.Vector3(side * 0.75, -0.55, 0.45).normalize();
    const chord = new THREE.Vector3(0, -0.15, 1).normalize();
    const normal = new THREE.Vector3().crossVectors(span, chord).normalize();
    chord.crossVectors(normal, span).normalize();
    const m = new THREE.Matrix4().makeBasis(span, chord, normal).setPosition(side * 0.16, -0.12, zAt(0.26));
    parts.push(fin(smoothOutline([[0, -0.02], [0.18, 0.0], [0.34, 0.04], [0.38, 0.09], [0.3, 0.12], [0.14, 0.14], [0, 0.15]], 6), 0.025, m));
  }
  // the flukes: a crescent, its tips swept back, a notch in the middle of its trailing edge
  const rotFluke = new THREE.Matrix4().makeBasis(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, -1, 0));
  parts.push(fin(smoothOutline([[0, -0.02], [0.16, 0.02], [0.3, 0.13], [0.33, 0.22], [0.22, 0.16], [0.08, 0.15], [0, 0.12], [-0.08, 0.15], [-0.22, 0.16], [-0.33, 0.22], [-0.3, 0.13], [-0.16, 0.02]], 6), 0.03, new THREE.Matrix4().makeTranslation(0, 0.0, zAt(0.95)).multiply(rotFluke)));

  const group = new THREE.Group();
  group.name = 'drift-dolphin';
  for (const g of parts) {
    const mesh = new THREE.Mesh(g, mat);
    // (casts on the sea, which samples the Sun's shadow map, and takes the raft's, the sail's and its own: the user,
    // 2026-11-01, "it's still not getting shadows?" — it had cast but not received)
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // (the vertex shader bends it: its bounds are no longer the geometry's)
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  return {
    group,
    set(p) {
      uBend.value = p.bend;
      uTurn.value = p.turn;
      uBeat.value = p.beat;
      uPhase.value = p.phase;
      uDry.value = p.dry;
    },
  };
}
