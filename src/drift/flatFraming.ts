/**
 * THE 16:9 CUT'S FRAMING: where the flat rectilinear view (`DomeCapture.setFlat`) looks from the show's eye, as a
 * smooth function of show time. The dome needs no framing — the audience turns their heads — but a 16:9 frame is one
 * 60° window, and straight ahead (pitch 0) it missed most of Acts 1–2: the QA sweep of 2026-10-30 (drift-narrative
 * wandering-on/qa-sweep-2026-10-30.md, item 2) found the pitch-0 view "nearly black for 30–60 s" in Act 1 (its action
 * sits 30–50° up) and looking down at a dark planet through 175–270 s, while pitch +30 framed the hero grain, the
 * Earth's limb at dawn and the cities at the limb (out/drift/review/qa_sweep_1030/sheets/up30_*.png against act1_*,
 * act2*_*.png). From the sea on, straight ahead is right: the horizon, the raft and the coast sit there.
 *
 * WHERE IT LOOKS, by beat (show s for the beat lengths of 2026-10-30; the moves are timed from the beats, so they
 * follow a change of length):
 *
 *   0–200     Acts 1–2 up to the dawn on the limb    pitch 22 (30 until the 2026-10-30 "too high" note): Act 1's field and its one warm grain (remain, centred
 *                                                    at +30 in up30_0050), the web, the galaxies, the band, the Earth
 *                                                    coming in low on the right and its limb across the bottom third
 *   200–260   the lights and the flood               one slow tilt down to 0 (the limb up out of the frame, the night
 *                                                    side's cities filling it), done BEFORE the eye's own levelling
 *                                                    from ~267 s (getTheDrift landingTurn; it looked 15° further down
 *                                                    onto the spiral until 2026-10-31): the two never add up
 *   260–629   the spiral, the landing, Part C,       pitch 0: the spiral centred (s_0285–0300), the horizon mid-frame,
 *             the coast, the beach                   the raft and the coast on it
 *   484–548   w1 the coast                           8° right: the raft holds its place right of the front all through
 *                                                    w1, and straight ahead cut its cabin and sail at the frame's right
 *                                                    edge for 50 s (s_0495–0535); right, the cabin comes in and the
 *                                                    island sits mid-frame. Back as w2 begins and the raft swings in
 *   629–688   w4 the sandpipers                      up 7° as the flock rises and wheels over the dome (it is at
 *                                                    the frame's top edge at pitch 0, s_0645–0660), and down again
 *                                                    for the wanderers walking into the frame at ~682 (their feet).
 *                                                    Both moves sit OFF the eye's own turn to the flock (beats.ts
 *                                                    coastLook BIRD_LOOK: 10° left over w4 + 6 → + 16, back over
 *                                                    + 26 → + 36, peaking at 1.5°/s): the tilt is done by w4 + 6 and
 *                                                    the way down starts at w4 + 36 — the coordinator, 2026-10-30: the
 *                                                    first placement peaked with the turn at w4 + 11, 1.63°/s together.
 *                                                    Up before the turn, not after it: after (+ 16) the 7° would have to
 *                                                    fit the 10 s before the turn back, 1.05°/s, and the flock would sit
 *                                                    cut at the top edge through its rise
 *   702–770   w6 the night                           up 10° and 6° right across the dissolve, toward the stations'
 *                                                    beams fanning from the coast tower (its lamp ~26° right, ~12° up:
 *                                                    dome_0720/0765) — the beams and the stars, the beach a strip at
 *                                                    the bottom
 *
 * NO FAST PANS, NO JUMPS: each move is a smoothstep ease between two held views, no faster than MAX_RATE at its
 * middle (1.5 × its angle / its time), and moves never overlap (`flatFramingTrack` refuses a list that breaks
 * either: tests/flatFraming.test.ts samples the whole show at 30 fps). The show's own eye turns too (the landing's
 * look-down, the coast's look to the land and w4's to the flock); the moves are placed off those, and the test holds
 * the eye's turn and the framing's together at the coast under the dome's own comfort, 1.5°/s.
 *
 * PURE: the view is a function of show time t and the beats' start times only, as every frame must be
 * (CLAUDE.md) — chunks drawn on different machines in any order meet at their seams.
 */

/** the flat view's aim (deg; yaw + left, pitch + up, as `DomeCapture.setFlat`) and the square frame's full angle */
export interface FlatView {
  yaw: number;
  pitch: number;
  fov: number;
}

/**
 * One move of the framing: from the view held before it to `to` (the fields it leaves out hold), eased over `dur` s,
 * starting `at` s after the start of `beat` (negative: before it). Beat names are the acts' own: Undertime's
 * (undertime/timeline.ts BEATS), Get the Drift's (getTheDrift/timeline.ts BEATS), the sea's (wandering/beats.ts), and
 * `end` (the show's end).
 */
export interface FlatMove {
  beat: string;
  at: number;
  dur: number;
  to: Partial<FlatView>;
}

/** deg/s, the fastest a move may turn the view (and change its angle) at its middle (the caller's brief, 2026-10-30:
 * "no fast pans (≤ ~1°/s)") */
export const MAX_RATE = 1;

/** the view the show opens on: Act 1 up (header) */
// (pitch 22, not 30: the user, 2026-10-30 ~04:10, "the 16:9 is looking too high in a bunch of spots" — the Earth arriving
// at 175–215 s sat on the frame's bottom edge at +30; Act 1's grain at ~30° up stays well inside the frame)
export const FLAT_START: FlatView = { yaw: 0, pitch: 22, fov: 60 };

/** the moves (header table) */
export const FLAT_MOVES: readonly FlatMove[] = [
  // the lights and the flood: one tilt down across both, from the timewave's dawn (the limb at the bottom third at
  // +30, up30_0190–0205) through the cities filling the frame (+15 at ~230: limb at the top third, s/up30_0225–0245)
  // to straight down onto the flood; over by Drift-2's own look-down (starts 4 s before drift2)
  { beat: 'lights', at: -9, dur: 60, to: { pitch: 0 } },
  // w1: 8° right across the dissolve from c4, and back as w2 begins (header)
  { beat: 'w1', at: -6, dur: 16, to: { yaw: -8 } },
  { beat: 'w2', at: -8, dur: 16, to: { yaw: 0 } },
  // w4: up with the flock, done before the eye turns to it, and down after the eye has turned back (header)
  { beat: 'w4', at: -6, dur: 12, to: { pitch: 4 } }, // (7 → 4: "too high", the same note)
  { beat: 'w4', at: 36, dur: 17, to: { pitch: 0 } },
  // w6: across the dissolve into the night (it runs 698–722), toward the beams
  { beat: 'w6', at: -8, dur: 26, to: { pitch: 6, yaw: -6 } }, // (10 → 6: "too high", the same note)
];

const smooth = (x: number): number => {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
};

/**
 * deg, the turn from one view to another: the angle of the rotation between their whole frames (yaw about the world's
 * up, then pitch, as `setFlat` builds them), not only between their centres' directions — a yaw seen at a pitch also
 * rolls the picture, and the eye feels all of it
 */
export function viewAngle(a: FlatView, b: FlatView): number {
  const D = Math.PI / 360;
  // the quaternion of Ry(yaw)·Rx(pitch): (x, y, z, w) = (cy·sp, sy·cp, −sy·sp, cy·cp) at the half angles
  const q = (v: FlatView): [number, number, number, number] => {
    const [sy, cy, sp, cp] = [Math.sin(v.yaw * D), Math.cos(v.yaw * D), Math.sin(v.pitch * D), Math.cos(v.pitch * D)];
    return [cy * sp, sy * cp, -sy * sp, cy * cp];
  };
  // the rotation from one to the other, conj(p)·r, and its angle (atan2 of its vector part over its scalar: exact
  // near 0, where an acos of the dot product loses half its digits)
  const [px, py, pz, pw] = q(a);
  const [rx, ry, rz, rw] = q(b);
  const w = pw * rw + px * rx + py * ry + pz * rz;
  const x = pw * rx - px * rw - py * rz + pz * ry;
  const y = pw * ry + px * rz - py * rw - pz * rx;
  const z = pw * rz - px * ry + py * rx - pz * rw;
  return (2 * Math.atan2(Math.hypot(x, y, z), Math.abs(w))) / (2 * D);
}

/**
 * The framing as a function of show time, for beats starting at `marks` (show s, by beat name). Throws when a move
 * names a beat `marks` lacks, when moves overlap or run backwards, or when one is faster than MAX_RATE: a framing that
 * would jump or whip is never drawn.
 */
export function flatFramingTrack(marks: Readonly<Record<string, number>>, moves: readonly FlatMove[] = FLAT_MOVES, start: FlatView = FLAT_START): (t: number) => FlatView {
  const placed: Array<{ t0: number; t1: number; from: FlatView; to: FlatView }> = [];
  let held = { ...start };
  let free = -Infinity;
  for (const m of moves) {
    const mark = marks[m.beat];
    if (mark === undefined || !Number.isFinite(mark)) throw new Error(`flat framing: no beat "${m.beat}" in the show's marks`);
    const t0 = mark + m.at;
    const t1 = t0 + m.dur;
    if (!(m.dur > 0) || t0 < free) throw new Error(`flat framing: the move at ${m.beat}${m.at >= 0 ? '+' : ''}${m.at} s overlaps the one before or has no length`);
    const to = { ...held, ...m.to };
    const rate = (1.5 * Math.max(viewAngle(held, to), Math.abs(to.fov - held.fov))) / m.dur;
    if (rate > MAX_RATE + 1e-9) throw new Error(`flat framing: the move at ${m.beat}${m.at >= 0 ? '+' : ''}${m.at} s turns ${rate.toFixed(2)}°/s, above ${MAX_RATE}`);
    placed.push({ t0, t1, from: held, to });
    held = to;
    free = t1;
  }
  return (t: number): FlatView => {
    let view = start;
    for (const p of placed) {
      if (t < p.t0) break;
      if (t >= p.t1) {
        view = p.to;
        continue;
      }
      const k = smooth((t - p.t0) / (p.t1 - p.t0));
      return {
        yaw: p.from.yaw + (p.to.yaw - p.from.yaw) * k,
        pitch: p.from.pitch + (p.to.pitch - p.from.pitch) * k,
        fov: p.from.fov + (p.to.fov - p.from.fov) * k,
      };
    }
    return { ...view };
  };
}
