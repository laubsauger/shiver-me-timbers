/**
 * Part C and Act 3 at sea level on one clock (drift-narrative/wandering-on/direction.md), from the landing on:
 *
 *   c1  a raft        the descent comes to rest beside it, then a very slow follow         morning (Act 2's)
 *   c2  seafaring     open water, other rafts far off, the Sun touching the sea            sunset
 *   c3  the dolphin   close and low: a dolphin circles and flips a blue case onto the deck  last light
 *   c4  the network   night: the radio glows, beams arc between far stations over the dome  night
 *   w1  the coast     the raft drifts along an island's coast, a beach beckoning            early morning
 *   w2  landfall      it runs onto the sand; we step off and glide along the waterline      late morning
 *   w3  the field     on the open beach, Act 1's pairs flicker in balance at the edge of seeing   golden hour
 *   w4  sandpipers    the flock rises from the waterline and wheels over the dome           sunset
 *   w5  wandering on  the flock settles far down the beach; the wanderers walk on after it   dusk
 *   w6  the outro     night over the beach: the Milky Way, the stations' beams still across it, the
 *                     field's flicker among the stars, the eye still rising, and the fade       night
 *
 * TIME PASSES IN DISSOLVES (the user's call, 2026-10-27): where a beat's time of day is hours from the last
 * one's, both are drawn at once and crossfaded over `dissolve` s — the light and the surroundings change, the
 * camera never stops. Not from the landing into seafaring: that is one continuous shot, its Sun scripted down
 * to c2's (sea.ts, "one sea"). Everywhere else the light runs on in real time, slowly. A dissolve may also change the
 * WORLD (the flood's debris galaxy, the open sea, the coast; one sea, kilometres apart), never where the eye
 * is against the raft: that is one continuous curve over every beat (`raftPose`), so the raft holds its place
 * on the dome through every change until we step off it.
 *
 * Sea-scene metres: x east, y up, z north. Pure functions of the sea's clock (s from the hand-over): every
 * frame renders on its own.
 */

export type BeatName = 'c1' | 'c2' | 'c3' | 'c4' | 'w1' | 'w2' | 'w3' | 'w4' | 'w5' | 'w6';
export type WorldName = 'flood' | 'open' | 'coast';

export interface BeatSpec {
  name: BeatName;
  world: WorldName;
  /** s */
  length: number;
  /** s the dissolve into this beat takes, centred on its start (0: the light runs on from the beat before) */
  dissolve: number;
  /** deg: the Sun over the horizon at the beat's start and at its end, and its bearing right of the front */
  sunEl: [number, number];
  sunAz: number;
  /** the clouds: how much of the sky they cover, and the cirrus */
  cover: number;
  cirrus: number;
}

/** s c1 runs on past the landing's end: the slow follow before seafaring */
export const C1_FOLLOW = 20;

/** the beats after c1 (c1's length and light are Act 2's landing) */
export const BEATS: BeatSpec[] = [
  // (c3's Sun is right at the horizon at the flip: a degree lower and the throw was lost in the dusk, the v9 review)
  // (no dissolve into c2: c1's follow and the open sea are ONE sea and one shot, the Sun brought down to c2's in a
  // time-lapse through the follow — sea.ts. Two worlds crossfaded showed two suns and two rafts: the v9 review)
  // (30 s, not 55: once the sunset time-lapse is done, the raft sailing on with nothing happening before the dolphin
  // dragged — the v9 review)
  { name: 'c2', world: 'open', length: 30, dissolve: 0, sunEl: [3, 1.6], sunAz: -22, cover: 0.42, cirrus: 0.2 },
  // (a beat that follows without a dissolve takes the Sun where the last left it: c3's had stood 2° further round,
  // and the Sun jumped as the dolphin came, the v9 review)
  { name: 'c3', world: 'open', length: 45, dissolve: 0, sunEl: [1.6, -0.8], sunAz: -22, cover: 0.42, cirrus: 0.2 },
  { name: 'c4', world: 'open', length: 60, dissolve: 8, sunEl: [-20, -20], sunAz: -24, cover: 0.12, cirrus: 0.08 },
  { name: 'w1', world: 'coast', length: 50, dissolve: 10, sunEl: [5, 9], sunAz: 100, cover: 0.4, cirrus: 0.12 },
  { name: 'w2', world: 'coast', length: 50, dissolve: 0, sunEl: [9, 14], sunAz: 100, cover: 0.4, cirrus: 0.12 },
  { name: 'w3', world: 'coast', length: 45, dissolve: 8, sunEl: [9, 6], sunAz: -68, cover: 0.24, cirrus: 0.12 },
  { name: 'w4', world: 'coast', length: 40, dissolve: 0, sunEl: [6, 1.5], sunAz: -68, cover: 0.24, cirrus: 0.12 },
  { name: 'w5', world: 'coast', length: 35, dissolve: 0, sunEl: [1.5, -3], sunAz: -68, cover: 0.24, cirrus: 0.12 },
  // (a long, slow fall into the night and a held vista under it, the field's flicker back among the stars: the
  // v9 review, "not the best framing for appreciating the night sky")
  { name: 'w6', world: 'coast', length: 60, dissolve: 24, sunEl: [-17, -18], sunAz: -72, cover: 0.1, cirrus: 0.05 },
];

export interface Beats {
  /** s on the sea's clock each beat starts at (c1 at 0) */
  starts: Record<BeatName, number>;
  /** s, the end of the last */
  total: number;
}

/** `c1End`: s on the sea's clock c1 ends at (the landing's end plus the follow) */
export function beatStarts(c1End: number): Beats {
  const starts = { c1: 0 } as Record<BeatName, number>;
  let at = c1End;
  for (const b of BEATS) {
    starts[b.name] = at;
    at += b.length;
  }
  return { starts, total: at };
}

const smooth = (x: number): number => {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
};

/**
 * The beats drawn at sea time t, with their shares: one, or two across a dissolve (the earlier first). A
 * dissolve is centred on the later beat's start; outside them, the beat whose span holds t.
 */
export function beatsAt(t: number, c1End: number): Array<{ name: BeatName; weight: number }> {
  const { starts } = beatStarts(c1End);
  let before: BeatName = 'c1';
  for (const b of BEATS) {
    const s = starts[b.name];
    if (b.dissolve > 0 && Math.abs(t - s) < b.dissolve / 2) {
      const k = smooth((t - s + b.dissolve / 2) / b.dissolve);
      return [
        { name: before, weight: 1 - k },
        { name: b.name, weight: k },
      ];
    }
    if (t < s) return [{ name: before, weight: 1 }];
    before = b.name;
  }
  return [{ name: before, weight: 1 }];
}

export const spec = (name: BeatName): BeatSpec | undefined => BEATS.find((b) => b.name === name);

/**
 * The Sun at sea time t in beat `name` (not c1, whose Sun is Act 2's), in the eye's level frame: unit, x to the
 * right of the front, y up, z back (the front is −z). It moves from the beat's start elevation to its end one —
 * a degree or two a minute: real time, slowly. A beat that is drawn past its own span (through a dissolve)
 * holds its end light.
 */
export function beatSun(name: BeatName, t: number, c1End: number): [number, number, number] {
  const b = spec(name);
  if (!b) throw new Error(`beatSun: ${name} has no light of its own`);
  const { starts } = beatStarts(c1End);
  const u = Math.min(1, Math.max(0, (t - starts[name]) / b.length));
  const el = ((b.sunEl[0] + (b.sunEl[1] - b.sunEl[0]) * u) * Math.PI) / 180;
  const az = (b.sunAz * Math.PI) / 180;
  return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
}

/** the raft against the eye: bearing (rad, right of the front), distance (m), its heading against the eye's
 * (rad, a turn about y: 0 bow along −z, the front), and the eye's height over the sea (m) */
export interface RaftPose {
  bearing: number;
  distance: number;
  heading: number;
  height: number;
}

/** what the pose keys move to, from c1's rest pose: [s into the beat, its key] — eased between keys */
interface PoseKey {
  beat: BeatName;
  at: number;
  pose: Partial<RaftPose>;
}
const D = Math.PI / 180;
/** the raft under sail against the eye: ahead and to the right, its bow along the front — we sail alongside,
 * a little astern of it, and the sea runs past (v8 notes: broadside and drifting it read as "on rails") */
export const SAILING: RaftPose = { bearing: 24 * D, distance: 15, heading: 0, height: 2.6 };
const POSE_KEYS: PoseKey[] = [
  // c1's follow: at rest it lies broadside. It SETS SAIL (sea.ts: the sail hoisted, then way on along its own
  // heading, the eye sailing with it) and only once it moves does its bow come round onto the course, as it
  // falls in ahead of us — one motion through c2's dissolve (it had swung 90° where it lay, then slid sideways:
  // "as if by magic", the v9 review)
  { beat: 'c2', at: -C1_FOLLOW, pose: {} },
  { beat: 'c2', at: -9, pose: {} },
  { beat: 'c2', at: 14, pose: { heading: SAILING.heading, bearing: SAILING.bearing, distance: SAILING.distance, height: SAILING.height } },
  // c3: still, close, low — in to the raft as the dolphin comes (direction: "still, close, low"); the raft swings
  // broadside on the dying air, its port side to us and its bow to the left, toward the afterglow, so the
  // dolphin's throw onto its bow crosses the view (seen end-on from astern, the case landed out of sight behind
  // the cabin and the sail: the v9 review)
  { beat: 'c3', at: 0, pose: {} },
  // (2.3 m up, not 1.6: from just over the water the deck was a sliver at the waterline, and the case thrown onto
  // it read as landing in the sea beyond — the v9 review)
  { beat: 'c3', at: 14, pose: { distance: 10, height: 2.3, bearing: 10 * D, heading: 70 * D } },
  { beat: 'c3', at: 32, pose: {} },
  // c4: back a little and up, for the beams overhead; the raft back on its course through the night
  { beat: 'c4', at: 4, pose: { distance: 12, height: 2.2, bearing: 12 * D } },
  { beat: 'c4', at: 30, pose: { heading: SAILING.heading } },
  // w1: under sail along the coast, as in c2
  { beat: 'w1', at: 6, pose: { bearing: SAILING.bearing, distance: SAILING.distance, height: SAILING.height } },
];

/** s into c3 the sail is struck over */
const SAIL_STRIKE: [number, number] = [0.5, 7];

/** the square sail, 0 furled .. 1 set: furled at rest in the debris and through the night, set at sea and
 * along the coast, struck as the raft comes to anchor off the beach (a dissolve crossfades a hoist) */
export function sailsAt(name: BeatName, t: number, c1End: number): number {
  const { starts } = beatStarts(c1End);
  // c3: struck as the wind dies at last light and the raft swings broadside for the dolphin (a square sail across
  // the wind is pressed back against its mast: the v9 review) — down before the raft is a third of the way round
  if (name === 'c3') return 1 - smooth((t - starts.c3 - SAIL_STRIKE[0]) / (SAIL_STRIKE[1] - SAIL_STRIKE[0]));
  if (name === 'c2' || name === 'w1') return 1;
  if (name === 'w2') return 1 - smooth((t - starts.w2 - 28) / 12);
  return 0;
}

/** m/s the raft makes through the water: sailing on a light air, slower as the wind dies at last light, all but
 * still through the night; along the coast, then easing to anchor in w2 */
export function speedAt(t: number, starts: Record<BeatName, number>): number {
  if (t < starts.w1 - 10) {
    const c3 = smooth((t - starts.c3) / 12);
    const c4 = smooth((t - starts.c4 + 4) / 8);
    return 1.2 + (0.6 - 1.2) * c3 + (0.2 - 0.6) * c4;
  }
  return 1.0 * (1 - smooth((t - starts.w2) / 22));
}

/** m the raft has come since `from` (sea s): the integral of its speed, in 0.05 s steps */
export function travelled(from: number, t: number, c1End: number): number {
  const { starts } = beatStarts(c1End);
  const h = 0.05;
  let d = 0;
  for (let x = from; x < t; x += h) d += speedAt(Math.min(x + h / 2, t), starts) * Math.min(h, t - x);
  return d;
}

/**
 * THE RAFT AGAINST THE EYE, over every beat: c1's rest pose (`rest`), then eased to each key in turn. Through
 * a dissolve both beats draw the raft here, so it never jumps; past w2's step-off the eye leaves it (coast()).
 */
export function raftPose(t: number, c1End: number, rest: RaftPose): RaftPose {
  const { starts } = beatStarts(c1End);
  let from: RaftPose = { ...rest };
  let fromT = -Infinity;
  for (const k of POSE_KEYS) {
    const at = starts[k.beat] + k.at;
    const to = { ...from, ...k.pose };
    if (t <= at) {
      if (!Number.isFinite(fromT)) return from;
      const w = smooth((t - fromT) / (at - fromT));
      return {
        bearing: from.bearing + (to.bearing - from.bearing) * w,
        distance: from.distance + (to.distance - from.distance) * w,
        heading: from.heading + (to.heading - from.heading) * w,
        height: from.height + (to.height - from.height) * w,
      };
    }
    from = to;
    fromT = at;
  }
  return from;
}

/** m: where the open sea's rig starts (kilometres from the flood's debris, so none of it shows). Every raft
 * sails downwind, along −z (the wind's own direction: sea.ts WIND_TO), with the eye's front */
export const OPEN_AT: [number, number] = [0, 40000];
export const OPEN_YAW = 0;

/**
 * THE COAST (w1–w5), about one beach: the lagoon island's long gentle shore on its −x side (the game's
 * showcase island), `beach` its middle at the waterline. Beach coordinates: `along` up the beach toward −z,
 * `off` out to sea (toward −x). The eye faces along the beach (−z), which puts the sea on the left and the
 * island front right (in this frame, facing −z, +x is to the right); the morning Sun behind right, the evening
 * Sun low in the front left, over the sea. Only through the landfall does it look round toward the land
 * (coastLook), slowly, and back along the beach once ashore.
 *
 *   w1  the raft drifts along the coast, 60 m out
 *   w2  it turns in and runs onto the sand; we step off and glide up the beach and along it, at eye height
 *   w3  the glide eases out through w3's dissolve: on the open beach, still but for a slow drift
 *   w4  still: the flock rises from the waterline ahead
 *   w5  held while the wanderers come past, then a slow pull back and up as they walk on
 *   w6  still back and up, into the night
 */
export const COAST_YAW = 0;
/** m: the coast rig's keys, (along, off) of the eye, eased between — ashore, within the beach's gentle ~110 m
 * (past ±55 m of its middle the island's lobes rise steeply to the shore) */
const COAST_KEYS: Array<{ beat: BeatName; at: number; along: number; off: number }> = [
  { beat: 'w2', at: 0, along: -75, off: 60 },
  { beat: 'w2', at: 30, along: -50, off: 26 },
  { beat: 'w3', at: 20, along: 5, off: -8 },
  { beat: 'w4', at: 20, along: 12, off: -8 },
  { beat: 'w4', at: 40, along: 12, off: -8 },
  // w5: held while the wanderers come past (props.ts), then back and up as they walk on
  { beat: 'w5', at: 12, along: 12, off: -8 },
  { beat: 'w5', at: 35, along: -14, off: -3 },
  { beat: 'w6', at: 60, along: -40, off: 6 },
];
/** m/s the raft and the eye sail along the coast in w1 */
const COAST_DRIFT = 1.0;
/** s into w2 the eye steps off the raft (the raft's run in ends) */
export const STEP_OFF = 30;
/** m: the eye over the sand once ashore, and the height it rises to as w5 pulls back */
export const EYE_ASHORE = 1.6;
const EYE_W5 = 11;
const EYE_W6 = 22;

/**
 * The eye on the coast at sea time t: x, z (sea-scene metres) and whether it is ashore (then its height is the
 * sand's plus `height`; afloat, the raft pose's).
 */
export function coastEye(t: number, c1End: number, beach: { x: number; z: number }): { x: number; z: number; ashore: number; height: number } {
  const { starts } = beatStarts(c1End);
  const w2 = starts.w2;
  let along: number;
  let off: number;
  if (t <= w2) {
    along = COAST_KEYS[0].along - COAST_DRIFT * (w2 - t);
    off = COAST_KEYS[0].off;
  } else {
    along = COAST_KEYS[COAST_KEYS.length - 1].along;
    off = COAST_KEYS[COAST_KEYS.length - 1].off;
    for (let i = 1; i < COAST_KEYS.length; i++) {
      const a = COAST_KEYS[i - 1];
      const b = COAST_KEYS[i];
      const ta = starts[a.beat] + a.at;
      const tb = starts[b.beat] + b.at;
      if (t > tb) continue;
      // (the first leg leaves w1's drift at its speed: a cubic Hermite from that velocity, not from rest)
      const u = Math.min(1, Math.max(0, (t - ta) / (tb - ta)));
      if (i === 1) {
        const h = tb - ta;
        const h10 = u * u * u - 2 * u * u + u;
        const h01 = -2 * u * u * u + 3 * u * u;
        along = a.along + (b.along - a.along) * h01 + COAST_DRIFT * h * h10;
        off = a.off + (b.off - a.off) * h01;
      } else {
        const w = smooth(u);
        along = a.along + (b.along - a.along) * w;
        off = a.off + (b.off - a.off) * w;
      }
      break;
    }
  }
  const ashore = smooth((t - (w2 + STEP_OFF - 4)) / 10);
  const lift = smooth((t - starts.w5 - 10) / (spec('w5')!.length - 10));
  const lift6 = smooth((t - starts.w6) / spec('w6')!.length);
  return { x: beach.x - off, z: beach.z - along, ashore, height: EYE_ASHORE + (EYE_W5 - EYE_ASHORE) * lift + (EYE_W6 - EYE_W5) * lift6 };
}

/** m: where the raft grounds, (along, off): in the shallows ahead and to the right of where the eye steps off;
 * s into w2 it gets there */
export const GROUNDED = { along: -30, off: 1 };
const RUN_IN = 46;
/** s it takes to bring the bow round to the run in */
const TURN_IN = 20;

/**
 * W2, THE LANDFALL: the raft runs in under sail, bow first, from where w1 left it (`from`, sea-scene metres)
 * and grounds in the shallows (GROUNDED) — a cubic Hermite that leaves at w1's drift (−z at COAST_DRIFT) and
 * comes to rest, its bow along its course (the v8 notes: pushed sideways up the beach, it read as "on rails").
 * Before w2: `from`. Returns its x, z and heading (sea.ts convention: π is bow to −z).
 */
export function landfall(t: number, c1End: number, from: { x: number; z: number }, beach: { x: number; z: number }): { x: number; z: number; heading: number } {
  const { starts } = beatStarts(c1End);
  const tx = beach.x - GROUNDED.off;
  const tz = beach.z - GROUNDED.along;
  const at = (s: number): [number, number] => {
    const u = Math.min(1, Math.max(0, (s - starts.w2) / RUN_IN));
    const h10 = u * u * u - 2 * u * u + u;
    const h01 = -2 * u * u * u + 3 * u * u;
    return [from.x + (tx - from.x) * h01, from.z + (tz - from.z) * h01 - COAST_DRIFT * RUN_IN * h10];
  };
  const [x, z] = at(t);
  // the bow comes round to its run in slowly, as a raft's does (a few degrees of leeway early in the turn):
  // eased from w1's heading to the course it grounds on
  const [ax, az] = at(starts.w2 + RUN_IN * 0.9);
  const [bx, bz] = at(starts.w2 + RUN_IN * 0.97);
  const course = Math.atan2(-(bx - ax), -(bz - az)) + Math.PI;
  const turn = Math.atan2(Math.sin(course - Math.PI), Math.cos(course - Math.PI));
  return { x, z, heading: Math.PI + turn * smooth((t - starts.w2) / TURN_IN) };
}

/** rad: how far the eye looks round toward the land (−: to the right) over the landfall, on top of COAST_YAW;
 * eased in as the raft turns in, held as we step off, eased back along the beach once ashore */
const LOOK = -24 * D;
export function coastLook(t: number, c1End: number): number {
  const { starts } = beatStarts(c1End);
  return LOOK * (smooth((t - starts.w2 + 12) / 30) - smooth((t - starts.w2 - 34) / 30));
}
