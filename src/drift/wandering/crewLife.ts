/**
 * THE CREW ALIVE (c1–w2): where the three are aboard, and what they do when — a pure function of the sea's clock and
 * of where things are (the dolphin, the case, the Sun, the lamp that answers, the land), as props.ts finds them.
 *
 * The 2026-11-02 review: "our crew … look like very cheap characters, they look out of place, and they're sitting and
 * standing sometimes in weird spots. When the dolphin comes there's no reaction from them, and they're sitting in a way
 * where the front sail is cutting through the body of the one guy." The three had been set down where they fell: one
 * hugging his knees at (−0.9, 1.2) — under the main course, whose cloth sweeps z −0.3 … 1.8 down to 0.4 m over the deck
 * whenever it is set, so it ran through his chest from c1's hoist to c4's strike and again from w1's dawn; one leaning
 * back on his hands just forward of it, its foot at his knees; one standing at (0.2, −1.8), which is inside the cabin,
 * so the footing ray (props.ts) walked him aft out from under the roof to the cabin's aft corner, under its lantern.
 *
 * WHERE THREE PEOPLE ON A RAFT AT SEA WOULD BE — and where the audience sees them (raft-local m: +x the side the eye is
 * on from c2 through w2 — at (+6, −14) under sail, (+10, −2) in c3 —, +z the bow). Three rules came out of the review's
 * notes, and tests/driftCrew.test.ts holds every one of them over the whole show:
 *   - nothing passes through anyone: the sails at every trim and belly, the furled roll, the spars, the oar, the
 *     cabin, the stores, the ropes, the lanterns, the case, each other;
 *   - nobody where the main course is: it spans the raft's whole width and sweeps 2 m fore and aft as it sets, bellies
 *     and strikes, and from c2's and w1's eye the whole fore-deck is behind it — a figure sitting there had the canvas in
 *     front of his face (the coordinator's note of the review: "we have the person again sitting inside of the front
 *     sail, or super close in front of it, with the sail in front of their face"). No head is drawn behind the canvas
 *     from the eye, and a seated figure keeps 0.4 m from it;
 *   - no lantern in front of a face (the coordinator's note: "the shot with the lamp right in front of the face of the
 *     dude is a bit weird … at night and during the day"): the four hang under the roof's corners at 1.88 m — a standing
 *     man's head height on the stern logs — and no head is drawn on one from the eye as it is at any instant.
 *
 *   THE HELM   sitting at the steering oar on the bare stern logs, just forward of the stern block, beside the oar's
 *              loom with his right hand on it (LOOM, from the blueprint's own numbers), looking ahead. (Standing at the
 *              tiller's cross-piece, his head came onto the far aft lantern from the eye in c3 and c4, from every spot in
 *              reach of it; seated, his head is 0.85 m under them all);
 *   THE EDGE   sitting on the outer log of the +x quarter, aft of the rail's end, legs over the side, the feet in the
 *              wash — working a line, coiling it in his lap, in spells with rests between (WORK);
 *   THE DOOR   sitting on the hut's step, the +x doorway's sill, his feet on the deck strip outside, facing the eye — the
 *              one who gets up at the dolphin and goes forward along the strip to the rail by its forward end,
 *              points it out from there and watches it throw the case, comes back and sits; and at dawn stands up
 *              on the strip outside his door, looking at the land.
 *
 * WHAT THEY DO (each an easing over a second or two; times s from the beat's start, the sea's clock):
 *   SUNSET (c2): the door watches the Sun go down; the edge stops work, looks, shades his eyes; the helm glances;
 *   THE DOLPHIN (c3, its first leap 3 s in): every head turns to it; the door goes forward and points; they follow it
 *     round; at the throw (dolphin.ts FLIP_RELEASE) every head follows the case down onto the fore-deck (props.ts
 *     CASE_REST: on the mat, flat, the user's note of the review — "It should be somewhere on the deck");
 *   THE ANSWER (c4, roseTraffic.ts ANSWER_AT): every head comes up to the lamp that answers;
 *   THE LAND (w1, the Sun up ~32 s in): the door stands up outside the hut, looking at it; the others look over.
 * And between: breathing, a weight shifting from leg to leg, the head looking about (slow sums of sines, a figure's own
 * periods: nothing twitches), the body leaning against the deck's roll (crew.ts solveCrew).
 *
 * Under radioOperator (params/drift.ts, off) the kneeler is the radio's (props.ts THE OPERATOR) from c1, in the helm's
 * place: kneeling up to the case on the fore-deck, his hand on its dial, straightening at the answer. (Forward of the
 * sail, he is behind it from c2's eye until c4 strikes it — the one figure the sight test leaves out: off by default.)
 */
import { raftParams } from '../../params/raft';
import { raftLayout } from '../../ship/raftPartsLayout';
import { CREW, REST_ACT, type CrewAct } from './crew';
import { DOLPHIN_SPAN, FLIP_RELEASE } from './dolphin';
import { ANSWER_AT } from './roseTraffic';

export type V = [number, number, number];

/** the figures aboard, in props.ts's order: who they are (crew.ts CREW) */
export const ABOARD = { helm: 2, door: 1, edge: 0 } as const;
export type Role = keyof typeof ABOARD | 'kneeler';
export const ROLES: Role[] = ['helm', 'door', 'edge', 'kneeler'];

/** m, raft-local (x, z): where each sits, and the way each faces (a direction in the deck's plane) */
export const CREW_AT: Record<'helm' | 'edge' | 'door', { x: number; z: number; face: [number, number] }> = {
  // (on the logs beside the loom on its +x side, 0.3 m clear of it, his back 0.25 m off the stern block's face; the
  // flagpole 1.0 m off, the aft guaras 1.2 m)
  helm: { x: 0.45, z: -6.05, face: [0, 1] },
  // (on the outermost +x log, 0.5 m aft of the crossbeam the rail ends on, facing out: the eye's side)
  edge: { x: 2.43, z: -4.75, face: [1, 0] },
  // (on the cabin floor's edge in the middle of the doorway, raftPartsCabin.ts's opening z −3.4 … −2.0)
  door: { x: 1.1, z: -2.7, face: [1, 0] },
};
/** m, raft-local (x, z): where the door stands up to, on the strip outside (his hat's brim clear of the roof's eave),
 * and where he goes forward to, out by the rail toward the strip's forward end — 1 m aft of the farthest the sail ever
 * comes aft (aback, its foot at z −0.31), and 1.7 m from the lantern under the roof's front corner: at 1.2 m it hung
 * beside his head from a camera on the strip (the 2026-11-02 stills at 398 and 414 s) */
const DOOR_OUT: [number, number] = [1.9, -2.7];
const DOOR_FORE: [number, number] = [2.3, -1.3];
/** m from the case's resting place to where the kneeler (radioOperator) kneels at it, coming up to it from aft */
export const AT_CASE = 0.7;

/** rad about y that turns a figure (facing its −z) to face raft-local (dx, dz) */
export const faceTo = (dx: number, dz: number): number => Math.atan2(-dx, -dz);

/**
 * THE LOOM (raft-local m): where the helm's right hand holds the steering oar — on its shaft 0.2 m ahead of him, from
 * the blueprint's own numbers (raftPartsHull.ts buildSteering: pivoted on the stern block, raised by `oarDip` toward its
 * inboard end), the wrist a hand's thickness over the shaft's top.
 */
export const LOOM: V = (() => {
  const p = raftParams;
  const L = raftLayout(p);
  const blockZ = L.sternZ - p.sternProjection / 2;
  const pivotY = L.logTopY + p.sternBlockSection + p.oarShaftDiameter / 2 + 0.02;
  const z = CREW_AT.helm.z + 0.2;
  return [0.04, pivotY + (z - blockZ) * Math.tan(p.oarDip) + p.oarShaftDiameter / 2 + 0.035, z];
})();

/** m either side of a spot its feet are (crewSpots) */
const FEET = 0.14;

/**
 * THE SPOTS, from a ray down onto the raft (`top`: the highest thing under raft-local (x, z) a figure could stand on,
 * −∞ over a gap — props.ts and the test pass their own): each the highest top within a foot's reach of the spot (FEET; a
 * figure on round logs stands on their crowns, not in the hollow between them); the sill the cabin floor's own top at
 * the doorway; the kneeler's (radioOperator) AT_CASE aft of the case's rest `rest`, facing it. (Nothing under it: 0.6 m.)
 */
export function crewSpots(top: (x: number, z: number) => number, rest: [number, number]): CrewWorld['spots'] {
  const on = (y: number): number => (Number.isFinite(y) ? y : 0.6);
  const under = (x: number, z: number): V => {
    let y = -Infinity;
    for (const [dx, dz] of [[0, 0], [FEET, 0], [-FEET, 0], [0, FEET], [0, -FEET]]) y = Math.max(y, top(x + dx, z + dz));
    return [x, on(y), z];
  };
  const d = CREW_AT.door;
  return {
    helm: under(CREW_AT.helm.x, CREW_AT.helm.z),
    edge: under(CREW_AT.edge.x, CREW_AT.edge.z),
    sill: [d.x, on(top(d.x, d.z)), d.z],
    out: under(...DOOR_OUT),
    fore: under(...DOOR_FORE),
    kneeler: under(rest[0], rest[1] - AT_CASE),
    kneelerRot: faceTo(0, 1),
  };
}

/** what props.ts finds for them each frame (raft-local m) */
export interface CrewWorld {
  /** sea s, and the beats' starts */
  t: number;
  starts: { c3: number; c4: number; w1: number };
  /** radioOperator (params/drift.ts) */
  operator: boolean;
  /** the dolphin while it is about (DOLPHIN_SPAN), the case from when it is thrown, the lamp that answers and the
   * beach (points); the Sun (unit, toward it); the world's up (unit) */
  dolphin: V | null;
  caseAt: V | null;
  lamp: V | null;
  land: V | null;
  sun: V;
  up: V;
  /** where each sits or stands (x, the top of what is there, z): the helm, the edge, the door on his sill, out on the
   * strip and forward at its end; the kneeler's place and facing (radioOperator) */
  spots: { helm: V; edge: V; sill: V; out: V; fore: V; kneeler: V; kneelerRot: number };
}

/** each figure now: its root (raft-local m), its turn (rad about y), what it does, its line in hand (0 … 1) */
export interface CrewNow {
  role: Role;
  root: V;
  rot: number;
  act: CrewAct;
  held: number;
  visible: boolean;
}

/** s of sea time: the c2 sunset beat's length before c3 (beats.ts BEATS) */
const C2_LENGTH = 30;
/** s into c3 they see the dolphin (its first leap is at 3.0, far out on the glitter road: dolphin.ts SURFACINGS) */
const SIGHT = 3.4;
/** s into c3: the door stands (from, to), goes forward, points (on from, on to, off from, off to: through the leaps at
 * 10.9 and 15.2), comes back, sits */
const DOOR_UP: [number, number] = [4.6, 6.4];
const DOOR_GO: [number, number] = [7.0, 9.8];
const DOOR_POINT: [number, number, number, number] = [10.0, 11.0, 15.6, 17];
const DOOR_BACK: [number, number] = [36.6, 39.2];
const DOOR_SIT: [number, number] = [39.8, 41.6];
/** s into w1: he stands at the strip outside his door (the Sun up ~32 s: beats.ts w1 `rise`), and looks at the land.
 * (Not forward again, as at the dolphin: from w1's eye, under sail, the way forward along the strip runs right across
 * the fore +x lantern — tests/driftCrew.test.ts, the lanterns) */
const DOOR_DAWN: [number, number] = [26, 27.8];
/** s after the answer (ANSWER_AT): the heads come up to the lamp; the one at the radio straightens; both settle back */
const LIFT: [number, number, number, number] = [0.4, 1.9, 12, 15];
const STRAIGHTEN: [number, number, number, number] = [0.3, 1.8, 13, 16];
/** s: the edge's spells of work and rest (a period, the share of it worked) and a turn of the coil */
const WORK = { period: 21, share: 0.7, turn: 2.4 };
/** s a step takes, walking along the strip */
const STEP = 0.9;

const smooth = (x: number): number => {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
};
const ease = (t: number, a: number, b: number): number => smooth((t - a) / (b - a));
const pulse = (t: number, [a, b, c, d]: readonly [number, number, number, number]): number => ease(t, a, b) * (1 - ease(t, c, d));
/** m: the wrist over the case's centre with the hand on its dial (hardCase.ts: 0.22 m tall; the dial on its lid) */
const dial = (c: V): V => [c[0], c[1] + 0.16, c[2]];
const mix = (a: V, b: V, w: number): V => [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w];
const mixAngle = (a: number, b: number, w: number): number => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * w;
/** a figure's way through keys [s, root, turn]: held before the first and after the last, eased from key to key */
function along(t: number, keys: Array<[number, V, number]>): { root: V; rot: number } {
  if (t <= keys[0][0]) return { root: keys[0][1], rot: keys[0][2] };
  for (let i = 0; i + 1 < keys.length; i++) {
    const [t0, r0, a0] = keys[i];
    const [t1, r1, a1] = keys[i + 1];
    if (t > t1) continue;
    const u = smooth((t - t0) / Math.max(1e-6, t1 - t0));
    return { root: mix(r0, r1, u), rot: mixAngle(a0, a1, u) };
  }
  const last = keys[keys.length - 1];
  return { root: last[1], rot: last[2] };
}

/** a figure's own slow life: its breath, its weight's sway, its idle look (rad yaw, pitch) — `seed` sets its periods */
function life(t: number, seed: number, wander: number): Pick<CrewAct, 'breath' | 'sway' | 'idle'> {
  const f = 1 + 0.13 * seed;
  return {
    breath: t / (4.1 * f) + seed * 0.37,
    sway: t / (8.5 * f) + seed * 0.61,
    idle: [
      wander * (0.6 * Math.sin((2 * Math.PI * t) / (23 * f) + seed) + 0.4 * Math.sin((2 * Math.PI * t) / (37 * f) + 2.1 * seed)),
      -0.05 + 0.07 * Math.sin((2 * Math.PI * t) / (29 * f) + 1.3 * seed),
    ],
  };
}

/** the figures' acts at the world's instant (helm, door, edge, kneeler) */
export function crewNow(w: CrewWorld): CrewNow[] {
  const { t, starts, operator } = w;
  const c2 = starts.c3 - C2_LENGTH;
  const c3 = t - starts.c3;
  const w1 = t - starts.w1;
  const ans = starts.c4 + ANSWER_AT;
  // (the head's look targets, raft-local: the dolphin, then from the throw the case it threw)
  const sun: V = [w.sun[0] * 1000, w.sun[1] * 1000, w.sun[2] * 1000];
  const dolphinW = w.dolphin && c3 > DOLPHIN_SPAN[0] && c3 < DOLPHIN_SPAN[1] ? ease(c3, SIGHT, SIGHT + 1.2) : 0;
  const caseW = w.caseAt ? ease(c3, FLIP_RELEASE - 0.2, FLIP_RELEASE + 0.3) : 0;
  const event: V | null = w.caseAt && caseW > 0 ? (w.dolphin && caseW < 1 ? mix(w.dolphin, w.caseAt, caseW) : w.caseAt) : w.dolphin;
  // the dolphin and its case: from the sighting until the case is aboard and seen to
  const eventW = Math.max(dolphinW, caseW) * (1 - ease(c3, 34, 37));
  const lampW = w.lamp ? pulse(t - ans, LIFT) : 0;
  const landOn = w.land ? ease(w1, DOOR_DAWN[0] + 1, DOOR_DAWN[1] + 1) : 0;

  const out: CrewNow[] = [];
  const toLocal = (p: V, root: V, rot: number, h: number): V => {
    const dx = p[0] - root[0];
    const dy = p[1] - root[1];
    const dz = p[2] - root[2];
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const k = 1.75 / h;
    return [(dx * c - dz * s) * k, dy * k, (dx * s + dz * c) * k];
  };
  const upLocal = (rot: number): V => {
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    return [w.up[0] * c - w.up[2] * s, w.up[1], w.up[0] * s + w.up[2] * c];
  };
  /** several looks from `eye` (raft-local), each [target, weight], layered: a later one over the earlier by its weight,
   * the weights joined as chances are. Eased from one to the next as DIRECTIONS from the eye, 10 m out: eased as points,
   * a far lamp to a case at his knees swept the point through his own head and the head snapped down (the first run of
   * tests/driftCrew.test.ts, 0.3 m in a frame) */
  const looks = (eye: V, list: Array<[V | null, number]>): [V | null, number] => {
    let at: V | null = null;
    let wt = 0;
    for (const [p, k] of list) {
      if (!p || k <= 0) continue;
      const d: V = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
      const l = Math.hypot(...d) || 1;
      const u: V = [d[0] / l, d[1] / l, d[2] / l];
      at = at ? mix(at, u, k) : u;
      wt = wt + k - wt * k;
    }
    if (!at) return [null, 0];
    const l = Math.hypot(...at) || 1;
    return [[eye[0] + (at[0] / l) * 10, eye[1] + (at[1] / l) * 10, eye[2] + (at[2] / l) * 10], wt];
  };
  /** about where a figure's eyes are (raft-local m): over its root, by its pose (standing ~1.6 m, sitting ~0.75 m) */
  const eyes = (root: V, standing: number): V => [root[0], root[1] + 0.75 + 0.85 * standing, root[2]];

  // THE HELM: at the oar, his hand on its loom; glances at the sunset, the dolphin, the lamp, the land (`role` and `h`:
  // the helm's look; under radioOperator the helm's man is at the radio)
  const atHelm = (role: Role, h: number, seed: number): CrewNow => {
    const root = w.spots.helm;
    const rot = faceTo(...CREW_AT.helm.face);
    const [look, lookW] = looks(eyes(root, 0), [
      [sun, 0.7 * pulse(t - c2, [12, 13.5, 18, 20])],
      [event, eventW],
      [w.lamp, lampW],
      [w.land, landOn * 0.6 * smooth(0.5 + 0.5 * Math.sin((2 * Math.PI * t) / 19))],
    ]);
    return {
      role,
      root,
      rot,
      held: 0,
      visible: true,
      act: {
        ...REST_ACT,
        ...life(t, seed, 0.3),
        a: 'hug',
        b: 'hug',
        w: 0,
        look: look && toLocal(look, root, rot, h),
        lookW,
        touch: toLocal(LOOM, root, rot, h),
        touchW: 1,
        up: upLocal(rot),
        balance: 0.45,
      },
    };
  };
  out.push({ ...atHelm('helm', CREW[ABOARD.helm].height, 0), visible: !operator });

  // THE DOOR: on the hut's step; watches the sunset; up and forward along the strip at the dolphin, points, watches the
  // throw, back to the step; up again at dawn, looking at the land
  {
    const h = CREW[ABOARD.door].height;
    const { sill, out: stand, fore } = w.spots;
    const toOut = faceTo(1, 0);
    const toBow = faceTo(0, 1);
    const toAft = faceTo(0, -1);
    const atRail = faceTo(1, 1);
    const c = starts.c3;
    const d = starts.w1;
    const { root, rot } = along(t, [
      [c + DOOR_UP[0], sill, toOut],
      [c + DOOR_UP[1], stand, toOut],
      [c + DOOR_GO[0], stand, toBow],
      [c + DOOR_GO[1], fore, toBow],
      [c + DOOR_GO[1] + 0.6, fore, atRail],
      [c + DOOR_BACK[0] - 0.6, fore, atRail],
      [c + DOOR_BACK[0], fore, toAft],
      [c + DOOR_BACK[1], stand, toAft],
      [c + DOOR_SIT[0], stand, toOut],
      [c + DOOR_SIT[1], sill, toOut],
      [d + DOOR_DAWN[0], sill, toOut],
      [d + DOOR_DAWN[1], stand, toOut],
    ]);
    const standing = ease(c3, DOOR_UP[0], DOOR_UP[1]) * (1 - ease(c3, DOOR_SIT[0], DOOR_SIT[1])) + ease(w1, DOOR_DAWN[0], DOOR_DAWN[1]);
    const walking = Math.max(pulse(c3, [DOOR_GO[0], DOOR_GO[0] + 0.4, DOOR_GO[1] - 0.4, DOOR_GO[1]]), pulse(c3, [DOOR_BACK[0], DOOR_BACK[0] + 0.4, DOOR_BACK[1] - 0.4, DOOR_BACK[1]]));
    const [look, lookW] = looks(eyes(root, standing), [
      [sun, 0.85 * pulse(t - c2, [1, 4, C2_LENGTH + 2, C2_LENGTH + 3.4])],
      [event, eventW],
      [w.lamp, lampW],
      [w.land, landOn * 0.9],
    ]);
    out.push({
      role: 'door',
      root,
      rot,
      held: 0,
      visible: true,
      act: {
        ...REST_ACT,
        ...life(t, 1, 0.5),
        a: 'sill',
        b: 'stand',
        w: Math.min(1, standing),
        look: look && toLocal(look, root, rot, h),
        lookW,
        point: w.dolphin && toLocal(w.dolphin, root, rot, h),
        pointW: w.dolphin ? pulse(c3, DOOR_POINT) : 0,
        step: t / STEP,
        stepAmp: walking,
        up: upLocal(rot),
        balance: 0.55,
      },
    });
  }

  // THE EDGE: legs over the side, working his line in spells; stops for the sunset (shading his eyes), the dolphin,
  // the answer; looks at the land a while at dawn
  {
    const h = CREW[ABOARD.edge].height;
    const root = w.spots.edge;
    const rot = faceTo(...CREW_AT.edge.face);
    const sunLook = pulse(t - c2, [6.5, 8, 19, 21]);
    const shade = pulse(t - c2, [8, 9.5, 16, 17.5]);
    const landLook = w.land ? pulse(t - starts.w1, [31, 33, 41, 44]) : 0;
    const busy = Math.max(sunLook, eventW, lampW, landLook);
    const spell = (t % WORK.period) / WORK.period;
    const spellW = smooth(spell / 0.07) * (1 - smooth((spell - WORK.share + 0.07) / 0.07));
    const work = spellW * (1 - busy);
    const [look, lookW] = looks(eyes(root, 0), [
      [sun, sunLook],
      [event, eventW],
      [w.lamp, 0.9 * lampW],
      [w.land, landLook],
    ]);
    const l = life(t, 2, 0.45);
    // (eyes on his hands while they work)
    l.idle = [l.idle[0] * (1 - work), l.idle[1] - 0.55 * work];
    out.push({
      role: 'edge',
      root,
      rot,
      held: work,
      visible: true,
      act: {
        ...REST_ACT,
        ...l,
        a: 'edge',
        b: 'edge',
        w: 0,
        look: look && toLocal(look, root, rot, h),
        lookW,
        shade,
        work,
        workPhase: t / WORK.turn,
        up: upLocal(rot),
        balance: 0.45,
      },
    });
  }

  // THE KNEELER (radioOperator): at the dial from c1, leaning in to it; straightens at the answer
  {
    const h = CREW[ABOARD.helm].height;
    const root = w.spots.kneeler;
    const rot = w.spots.kneelerRot;
    const straight = pulse(t - ans, STRAIGHTEN);
    out.push({
      role: 'kneeler',
      root,
      rot,
      held: 0,
      visible: operator,
      act: {
        ...REST_ACT,
        ...life(t, 3, 0.15),
        a: 'kneelAt',
        b: 'kneelUp',
        w: straight,
        look: w.lamp && toLocal(looks(eyes(root, 0), [[w.lamp, 1]])[0]!, root, rot, h),
        lookW: 0.6 * lampW,
        touch: w.caseAt && toLocal(dial(w.caseAt), root, rot, h),
        touchW: (w.caseAt ? ease(c3, FLIP_RELEASE + 1.6, FLIP_RELEASE + 3) : 0) * (1 - straight),
        up: upLocal(rot),
        balance: 0.4,
      },
    });
  }
  return out;
}
