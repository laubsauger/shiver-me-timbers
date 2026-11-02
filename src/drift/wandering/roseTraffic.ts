/**
 * THE ROSE'S TRAFFIC — what the network says, and when: messages as pulses of light running tower to tower along the
 * Rose's arcs (props.ts draws them), and the flare each lamp answers with. Pure data, no three.js: every pulse and every
 * flare is a function of the sea's clock alone, so a render lane starting anywhere draws the same frame
 * (tests/roseTraffic.test.ts).
 *
 * WHY PULSES (the user and the client, 2026-11-01, on the Rose: the lines in the sky "look pasted on, slapped on,
 * cheap, not blending", and "it still doesn't read that these are OUR beacons, survivors' radio stations across the
 * post-apocalypse"). A drawn line is a graphic; a message travelling from one lamp to another, the lamp it reaches
 * flaring in answer, is a station talking. So the arcs carry pulses with short fading trails, and between messages the
 * path is at most a faint glow in the haze (props.ts), lit only once a message has run along it.
 *
 * TWO WINDOWS:
 *
 *   c4, THE NETWORK WAKES   our raft's radio crackles (the dial flares, WAKE.dial), the nearest station in view
 *                           answers (its lamp flares, WAKE.first: WAKE_FROM), and from it the network lights tower by
 *                           tower round the ring, outward both ways from us: each new link a call from a station already lit, the station it
 *                           reaches flaring and answering back, and calling on in turn. Once the ring is closed the
 *                           chords cross the sky between stations, each a call and an answer: the Rose's figure drawn by
 *                           its traffic, not all at once.
 *   w6, THE STEADY STATE     the memory of c4's: the quieter chatter of a network long awake — every link a message
 *                           every CHATTER.period s or so (in w6's minute, about one call and its answer each), each
 *                           answered, the first of each link in the window lighting its path.
 *
 * THE RADIO STORY (the 2026-11-02 next-level review, drift-narrative/next-level-2026-11-02.md: "what remained, calls,
 * and is answered" — the user that day: "it's apocalyptic, right? Everyone is wiped out. Only the few rafters
 * remain"). Two of its moves are timed here, each behind a film param (params/drift.ts), off by default:
 *
 *   c4, CALL, WAIT, ANSWER   (radioCall) the review's diagnosis: "in c4 the radio is answered 1.5 s after it is
 *                           called" — the wake above had no doubt in it. Now the dial wakes, our masthead lamp sends a
 *                           call (CALL_RHYTHM) that runs out along the sky to the station ahead and ends in nothing;
 *                           stars and surf; a second, shorter call; and the lamp ahead blinks the same rhythm back on
 *                           the music's step (ANSWER_AT). Only then does the Rose wake from it (CASCADE): one pulse a
 *                           side at a time round the ring, its arches raised high over the dome, closing behind us.
 *   w6, THE STRANGER         (radioEnding) our own lamp lights and joins, the traffic turns seaward and falls quiet,
 *                           and on the music's decay something that is not a station answers (ENDING).
 */

/** the Rose's links: every station to every other, as [a, b] (a's end is u = 0 along the arc). The ring of neighbours
 * first, then the heptagram's chords, then the widest — in the order the old drawn Rose grew them (from the front) */
export function roseLinks(n: number): Array<[number, number]> {
  return [1, 2, 3].flatMap((skip) => [2, 3, 1, 4, 0, 5, 6].filter((a) => a < n).map((a): [number, number] => [a, (a + skip) % n]));
}

export interface RoseMessage {
  /** which link (roseLinks index) */
  link: number;
  /** the end it leaves from: 0 the link's a (it runs u 0 → 1), 1 its b */
  from: 0 | 1;
  /** sea s it leaves its lamp */
  t0: number;
  /** s it takes to reach the other */
  dur: number;
}

/** s a pulse takes: a constant, plus the arc's length at SPEED (deg/s) — gentle on the dome: a neighbour's ~50° arch
 * in ~4.6 s, the widest chord over the zenith (~160°) in ~11 s */
export const TRAVEL = { base: 1.5, speed: 16 };
export const travel = (arcDeg: number): number => TRAVEL.base + arcDeg / TRAVEL.speed;

/** THE WAKE (s into c4): the dial's crackle, the first answer, how long a lit station waits before it calls on, how
 * long one that is reached waits before it answers, and the chords' start and spacing (the widest ones' answers land
 * as c4's Rose goes quiet, props.ts BEAM_QUIET). (The old drawn Rose's first beam grew at 9 s into c4: the first
 * answer is there.) */
export const WAKE = { dial: 7.5, first: 9, call: 1.0, answer: 0.6, chords: 20, chordGap: 0.8 };
/** the station the network wakes from: the nearest the front that the eye sees — treetops, the high island's broadcast
 * mast, 40° left (props.ts STATIONS). (The one 10° right of the front stands behind our raft's cabin and sail from c4's
 * eye: the first answer came from behind the raft, unseen — the first look, 2026-11-01. And treetops is the tower the
 * coast's eye sees on the high island in w6: the station that first answered us.) */
export const WAKE_FROM = 2;
/** s: the steady state's period per link (seeded within it), and the window over which every link's first message
 * leaves (so the w6 Rose lights link by link, never whole) */
export const CHATTER = { period: [70, 110] as [number, number], firstOver: 45 };

/** a seeded 0..1 (no state: the same for the same inputs) */
const hash = (a: number, b: number): number => {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** how a wake is timed, where it is not WAKE's own (CASCADE): its times (s into c4), a pulse's travel (s for an arc
 * of `deg`), the first station's extra wait before it calls on (s), and whether the chords follow the ring */
export interface WakeOptions {
  wake?: Partial<typeof WAKE>;
  travel?: (deg: number) => number;
  lead?: number;
  chords?: boolean;
  /** false: a station reached does not send an answer back along the link (it flares, and calls on) */
  answerBack?: boolean;
}

/**
 * c4's wake: the messages, from `c4` (sea s, c4's start), over `links` whose arcs are `arcDeg` long, for `n` stations.
 * Returns the messages and the sea s each station is first reached (the WAKE_FROM station: the first answer's).
 */
export function wakeTraffic(c4: number, links: Array<[number, number]>, arcDeg: number[], n: number, o: WakeOptions = {}): { messages: RoseMessage[]; litAt: number[] } {
  const linkOf = (a: number, b: number): number => links.findIndex(([x, y]) => (x === a && y === b) || (x === b && y === a));
  const messages: RoseMessage[] = [];
  const litAt = new Array<number>(n).fill(Infinity);
  const W = { ...WAKE, ...o.wake };
  const go = o.travel ?? travel;
  litAt[WAKE_FROM] = c4 + W.first;
  const carried = new Set<number>();
  // THE RING, outward both ways from the first to answer: a lit station calls each neighbour whose link has not yet
  // carried anything; the neighbour is lit when the call reaches it (or already was, from the other side: the last
  // link closes the ring behind the eye), answers, and calls on
  let frontier = [WAKE_FROM];
  while (frontier.length) {
    const next: number[] = [];
    for (const s of frontier) {
      for (const m of [(s + 1) % n, (s + n - 1) % n]) {
        const k = linkOf(s, m);
        if (k < 0 || carried.has(k)) continue;
        carried.add(k);
        const dur = go(arcDeg[k]);
        // (the first to answer holds a breath longer before it calls on: o.lead)
        const t0 = litAt[s] + W.call + (s === WAKE_FROM ? (o.lead ?? 0) : 0);
        const arrive = t0 + dur;
        messages.push({ link: k, from: links[k][0] === s ? 0 : 1, t0, dur });
        if (o.answerBack !== false) messages.push({ link: k, from: links[k][0] === m ? 0 : 1, t0: arrive + W.answer, dur });
        if (arrive < litAt[m]) {
          litAt[m] = arrive;
          if (!next.includes(m)) next.push(m);
        }
      }
    }
    frontier = next;
  }
  // THE CHORDS, once the ring is closed: across the sky, each from its a and answered from its b (none when the
  // ring alone closes the wake: CASCADE)
  let i = 0;
  links.forEach(([a, b], k) => {
    if (carried.has(k) || o.chords === false) return;
    const dur = go(arcDeg[k]);
    const t0 = Math.max(c4 + W.chords + i++ * W.chordGap, litAt[a] + W.call, litAt[b] + W.call);
    messages.push({ link: k, from: 0, t0, dur });
    messages.push({ link: k, from: 1, t0: t0 + dur + W.answer, dur });
  });
  return { messages: messages.sort((x, y) => x.t0 - y.t0), litAt };
}

/**
 * The steady state from sea s `from` to `to` (w6): each link's first message within CHATTER.firstOver of `from`, then
 * one about every CHATTER.period (seeded per link and per message), each from a seeded end and answered on arrival.
 */
export function chatterTraffic(from: number, to: number, links: Array<[number, number]>, arcDeg: number[], seed = 6): RoseMessage[] {
  const out: RoseMessage[] = [];
  links.forEach((_, k) => {
    const dur = travel(arcDeg[k]);
    const [p0, p1] = CHATTER.period;
    let t0 = from + 1 + CHATTER.firstOver * hash(k + seed, 1.7);
    for (let j = 0; t0 < to; j++) {
      const f: 0 | 1 = hash(k + seed, j + 3.1) < 0.5 ? 0 : 1;
      out.push({ link: k, from: f, t0, dur });
      out.push({ link: k, from: f === 0 ? 1 : 0, t0: t0 + dur + WAKE.answer, dur });
      t0 += p0 + (p1 - p0) * hash(k + seed, j + 9.4);
    }
  });
  return out.sort((x, y) => x.t0 - y.t0);
}

/** the station a message reaches */
export const receiver = (m: RoseMessage, links: Array<[number, number]>): number => links[m.link][m.from === 0 ? 1 : 0];
export const sender = (m: RoseMessage, links: Array<[number, number]>): number => links[m.link][m.from];

/** A LAMP'S ANSWER, s after a message reaches it: up over FLARE.rise, then dying away over ~FLARE.decay — slow, never a
 * flash (comfort on the dome: nothing faster than the lamps' own L-864 blink) */
export const FLARE = { rise: 0.6, decay: 1.8, send: 0.35 };
export function flare(dt: number): number {
  if (dt <= 0) return 0;
  if (dt < FLARE.rise) {
    const k = dt / FLARE.rise;
    return k * k * (3 - 2 * k);
  }
  return Math.exp(-(dt - FLARE.rise) / FLARE.decay);
}

/** station `i`'s flare at sea s `t`: every message reaching it, and a little as one leaves it (FLARE.send) */
export function stationFlare(t: number, i: number, messages: readonly RoseMessage[], links: Array<[number, number]>): number {
  let f = 0;
  for (const m of messages) {
    if (m.t0 > t) break;
    if (receiver(m, links) === i) f += flare(t - m.t0 - m.dur);
    else if (sender(m, links) === i) f += FLARE.send * flare(t - m.t0 + FLARE.rise);
  }
  return Math.min(f, 1.5);
}

/** the raft's dial at sea s `t`: 0 … 1, its crackle as the network first answers (c4 + `at`, s: WAKE.dial, or CALL.dial
 * where the raft calls first): the static rises over a second and a half, holds while the first station answers, and
 * settles over a few seconds */
export function dialFlare(t: number, c4: number, at: number = WAKE.dial): number {
  const x = t - (c4 + at);
  if (x <= -1.5) return 0;
  if (x < 0) {
    const k = (x + 1.5) / 1.5;
    return k * k * (3 - 2 * k);
  }
  return x < 2 ? 1 : Math.exp(-(x - 2) / 2.5);
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// MOVE 1, CALL, WAIT, ANSWER (c4; params/drift.ts radioCall) — the 2026-11-02 next-level review: "Last light. The dial
// wakes on deck. The masthead lamp sends a call. It travels out and ends in nothing: no flare, no reply. About 8 s of
// stars and surf. A second, shorter call. Then, low and ahead in the focus zone, one lamp blinks the same rhythm back,
// on the music's step." Every time below is s into c4 (sea s − c4's start), c4 starting at 430.0 show s.
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** s into c4: THE ANSWER, on the music's step. Found in drift_audio.wav (audio offset 0), the 2026-11-02 review: the
 * score dips at 444–446.5 s (−21 … −22 dB RMS against −18 around it), swells from 446.9 (the low-mids up 6 dB by 447.5),
 * and the sub-bass (< 120 Hz) comes in at 447.93 s — +6 dB within 50 ms, the one hard edge in the stretch (the 1 s and
 * 2 s loudness step detectors both put the widest rise at 447.2, the swell's middle; the step the ear hears is the
 * bass). The answer's first flash peaks there: 430.0 + 17.93. The calls sit before it, the wait in the dip. */
export const ANSWER_AT = 17.93;
/** OUR CALL SIGN, as the masthead lamp flashes it and the answer repeats it: [s after the call begins, s held] —
 * two short and a long, a lamp's rhythm, not the L-864's even blink (36 a minute on the station ahead, radio/network.ts):
 * the answer has to be told from the lamp's own blink at a glance. At most ~1 flash a second, soft-edged (FLASH):
 * a small lamp low on the dome, never a strobe */
export const CALL_RHYTHM: ReadonlyArray<readonly [number, number]> = [
  [0, 0.45],
  [0.9, 0.45],
  [2.2, 1.1],
];
/** s: a flash's soft edges (a hand on a lamp's shutter, not a strobe's square edge) */
export const FLASH = { rise: 0.25, fall: 0.45 };
/**
 * THE CALLS (s into c4): the dial's crackle (`dial`, its peak: the static rises from 1.5 s before), the first call's
 * start (`first`), how many of CALL_RHYTHM's flashes the second, shorter call sends (`second`), the s a call's pulse
 * takes from the masthead to the lamp ahead (`travel`), and the breath between the second call's pulse reaching it and
 * the answer's first flash peaking (`beat`). The pulse leaves with the call's last flash.
 *
 * Laid out, show s: the dial 433.0 · the first call 434.5–438.3, its pulse out 436.7 → 439.3, at the lamp ahead:
 * nothing · the wait, 438.3–443.9: stars, surf, and the sail struck (beats.ts SAIL_STRIKE, 440–447) · the second call
 * 443.9–445.7, its pulse 444.8 → 447.4 · the answer, its flashes peaking 447.93 and 448.8, the long one 450.1–451.4 ·
 * the Rose from 452.0 (CASCADE). The doc's "about 8 s": 9.4 s from call to call, 5.7 s of dark lamp between them.
 * (The dial at WAKE.dial's 7.5 s left no room: a call, 8 s, a call and the answer have to fit before 447.93.)
 */
export const CALL = { dial: 3, first: 4.5, second: 2, travel: 2.6, beat: 0.5 };
/** the second call's start: so its pulse arrives CALL.beat before the answer's first flash peaks */
const SECOND_AT = ANSWER_AT - CALL.beat - CALL.travel - CALL_RHYTHM[CALL.second - 1][0];
/** the calls: when each starts (s into c4) and its flashes */
export const CALLS: ReadonlyArray<{ at: number; flashes: ReadonlyArray<readonly [number, number]> }> = [
  { at: CALL.first, flashes: CALL_RHYTHM },
  { at: SECOND_AT, flashes: CALL_RHYTHM.slice(0, CALL.second) },
];

/** one flash `x` s after it begins, held `hold` s: 0 … 1, smooth edges (FLASH) */
function flash(x: number, hold: number): number {
  if (x <= 0 || x >= hold + FLASH.fall) return 0;
  const sm = (k: number): number => k * k * (3 - 2 * k);
  if (x < FLASH.rise) return sm(x / FLASH.rise);
  if (x < hold) return 1;
  return 1 - sm((x - hold) / FLASH.fall);
}
const rhythm = (x: number, flashes: ReadonlyArray<readonly [number, number]>): number =>
  Math.min(1, flashes.reduce((f, [at, hold]) => f + flash(x - at, hold), 0));

/** OUR MASTHEAD LAMP at sea s `t`: 0 … 1 as it flashes the calls (dark between: a signal lamp, not a riding light) */
export function callLamp(t: number, c4: number): number {
  return CALLS.reduce((f, c) => Math.max(f, rhythm(t - c4 - c.at, c.flashes)), 0);
}
/** the calls' pulses, masthead → the lamp ahead: sea s each leaves (with its call's last flash) and s it takes */
export function callPulses(c4: number): Array<{ t0: number; dur: number }> {
  return CALLS.map((c) => ({ t0: c4 + c.at + c.flashes[c.flashes.length - 1][0], dur: CALL.travel }));
}
/** × the answer's flashes, against a Rose flare's 1 (stationFlare caps at 1.5) */
const ANSWER_GAIN = 1.2;
/** THE ANSWER at sea s `t`: the lamp ahead (WAKE_FROM) flashes our call sign back, its first flash peaking on the
 * step — a flare on its lamp (radioTower.ts setFlare) and in the haze about it (props.ts), as a Rose answer is */
export function answerFlare(t: number, c4: number): number {
  return ANSWER_GAIN * rhythm(t - (c4 + ANSWER_AT - FLASH.rise), CALL_RHYTHM);
}

/**
 * THE CASCADE: the Rose wakes outward from the lamp that answered — "only then … The cascade crosses the zenith and
 * runs behind the audience, one pulse in flight at a time, each crossing taking 5 s or more. It closes as a ring high
 * overhead on the peak" (the review). The ring alone, outward both ways from the answering station, one pulse in
 * flight a side: no answer sent back along a link (the station reached flares, and calls on), no chords — at WAKE's
 * pace the ring and the chords filled 23 s with up to ten pulses at once, the "fireworks problem" the review warns of.
 * One pulse at a time round all seven links would take ~40 s and end after the dissolve; one a side closes the ring
 * behind us at ~474.3 s (the left side, three hops, has reached the back at ~468.8; the right's fourth arrives), on
 * the score's last swell before its dip (476–479 s), where c4's Rose goes quiet (`quiet`: s before w1 its fade starts
 * and ends; WAKE's own runs 17 → 7, through the closing). Measured on the ring's own arcs (tests/radioStory.test.ts):
 * calls leave 452.0, the hops land 457.1/457.2, 462.7/463.1, 468.4/468.8 and 474.3 show s.
 *
 *   lead    s the answering station waits after its answer's first flash before it calls on (the raft has begun to
 *           turn toward it: ANSWER_TURN) — with `call`, its first calls leave at 452.0 s, the review's cue list
 *           "452–490: the cascade"
 *   call    s a reached station waits before it calls on
 *   speed   deg/s along the raised arch (and TRAVEL.base s): a neighbour's ~110° arch in ~5.1 s (at 24 the ring
 *           closed at 477.9 s, in the fade; the Rose's own 16 would take ~8 s a hop)
 *   min     s: no crossing shorter (the review: "each crossing taking 5 s or more")
 *   lift    the arches raised toward the zenith (props.ts arcPoint `lift`): a neighbour's apex ~50° up instead of ~9°,
 *           so the ring stands high over the dome — and behind us, where the 15° tilt puts the dome's rim 15° up,
 *           an arch of 9° was under the rim, unseen
 */
export const CASCADE = { lead: 3.5, call: 0.6, speed: 30, min: 5, lift: 0.5, quiet: [14, 6] as [number, number] };
export const cascadeTravel = (arcDeg: number): number => Math.max(CASCADE.min, TRAVEL.base + arcDeg / CASCADE.speed);
/** c4's wake under radioCall: the cascade from the answer (arcs `arcDeg` long as raised: CASCADE.lift) */
export function cascadeTraffic(c4: number, links: Array<[number, number]>, arcDeg: number[], n: number): { messages: RoseMessage[]; litAt: number[] } {
  return wakeTraffic(c4, links, arcDeg, n, {
    wake: { first: ANSWER_AT, call: CASCADE.call },
    travel: cascadeTravel,
    lead: CASCADE.lead,
    chords: false,
    answerBack: false,
  });
}

/**
 * THE RAFT TURNS ITS BOW TOWARD THE ANSWER, the eye does not turn (the review: "The raft slowly swings its bow toward
 * it"). Its heading against the eye's (beats.ts RaftPose, + bow to the left), held where c3 left it (70°, broadside)
 * until the answer, then eased to `heading` (deg) by `to` s into c4 — the station ahead stands 40° left of the front
 * 7 km off (props.ts STATIONS, WAKE_FROM), the raft 12 m out at 12° right of it, so its bow points at the lamp within
 * half a degree — and eased back onto the coast's course (0) from w1's pose key (6 s into w1) to `back` s into w1, in
 * the dark before first light (~19 s into w1). (Without the param c4 swings it 70° → 0 from c3 + 32 s to c4 + 30 s.)
 * Applied in beats.ts raftPose (its POSE_KEYS under radioCall), the one place every user of the pose — the raft, its
 * wake and its foam — reads it from.
 */
export const ANSWER_TURN = { heading: 40, to: 46, back: 24 };

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// MOVE 7, THE ENDING: OUR LAMP, THEN THE STRANGER (w6; params/drift.ts radioEnding, a prototype: it commits the game's
// lore — the review: "something that is not a station answers from the direction of the debris spiral. Nobody can
// read it. That open bearing is where the game begins"). Times s into w6 (710.0 show s); the title at 38 (main-drift.ts
// endTitle), black over the last 6 (END_FADE, 764–770).
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 *   ours      s: our island's dark mast lights (its lamp eased up over these) — at nightfall, after w6's dissolve
 *             from w5's dusk (698–722 s) is past its middle; dark from w1 on until then (coast.ts 'lagoon')
 *   chord     s: our lamp's first message, to the seaward station: "ashore, our own station lights and joins"
 *   seaward   s: the network's last messages, every station's to the seaward one, spread over these — "the Rose's
 *             traffic slowly turns seaward, toward one bearing, and falls quiet"; no answers
 *   quiet     s: the Rose fades over these, gone before the title (38)
 *   rafts     s: the far rafts' lanterns drift in toward our beach over these ("they made it")
 *   stranger  s it leaves the horizon, and s it climbs: one faint pulse in Act 1's two colours, from the seaward
 *             bearing to the one place (front, 52° up the tilted dome: Act 1's hero grain, undertime/timeline.ts
 *             domeAhead). The score's decay: −17 dB RMS at 758, falling through −21 at 762 to its −25 tail at 764
 *   flare     s: every lamp flares once in answer — and nothing comes back
 *   bearing   deg right of the coast's front: where the stranger comes from, out to sea and from no tower — between
 *             motu 1 (−78°, its tower dead) and the high island's foot, on open water
 */
export const ENDING = {
  ours: [8, 11] as [number, number],
  chord: 12.5,
  seaward: [15, 26] as [number, number],
  quiet: [30, 38] as [number, number],
  rafts: [0, 50] as [number, number],
  stranger: { at: 49, dur: 4.6 },
  flare: 53.9,
  bearing: -62,
};
const smoothK = (x: number): number => {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
};
/** our island's mast at sea s `t`: 0 dark … 1 lit (×its lamp) */
export const oursLit = (t: number, w6: number): number => smoothK((t - w6 - ENDING.ours[0]) / (ENDING.ours[1] - ENDING.ours[0]));
/** the w6 Rose's gain under radioEnding: × its own return, down over ENDING.quiet */
export const endingRose = (t: number, w6: number): number => 1 - smoothK((t - w6 - ENDING.quiet[0]) / (ENDING.quiet[1] - ENDING.quiet[0]));
/** the last flare of every lamp (FLARE's shape, ×0.8), at sea s `t` */
export const lastFlare = (t: number, w6: number): number => 0.8 * flare(t - w6 - ENDING.flare);
/** the stranger's pulse: sea s it leaves the horizon and s it takes to the one place */
export const strangerPulse = (w6: number): { t0: number; dur: number } => ({ t0: w6 + ENDING.stranger.at, dur: ENDING.stranger.dur });

/**
 * w6's traffic under radioEnding: the chatter until the turn (none to or from our station before it lights), our
 * lamp's call to the seaward station, and every other station's last message to it, nearest first, spread over
 * ENDING.seaward — then nothing. `ours` and `seaward` are station indices (props.ts STATIONS).
 */
export function endingTraffic(w6: number, links: Array<[number, number]>, arcDeg: number[], ours: number, seaward: number, n: number): RoseMessage[] {
  const linkOf = (a: number, b: number): number => links.findIndex(([x, y]) => (x === a && y === b) || (x === b && y === a));
  const lit = w6 + ENDING.ours[1];
  // (the chatter's answers that would leave after the turn are dropped with it)
  const out = chatterTraffic(w6 - 6, w6 + ENDING.seaward[0], links, arcDeg).filter((m) => {
    const touches = links[m.link][0] === ours || links[m.link][1] === ours;
    return (!touches || m.t0 > lit) && m.t0 < w6 + ENDING.seaward[0];
  });
  const to = (from: number, t0: number): RoseMessage => {
    const k = linkOf(from, seaward);
    return { link: k, from: links[k][0] === from ? 0 : 1, t0, dur: travel(arcDeg[k]) };
  };
  out.push(to(ours, w6 + ENDING.chord));
  // (nearest the seaward station round the ring first: the turn sweeps toward it)
  const ring = (i: number): number => Math.min((i - seaward + n) % n, (seaward - i + n) % n);
  const rest = Array.from({ length: n }, (_, i) => i).filter((i) => i !== seaward && i !== ours).sort((a, b) => ring(a) - ring(b) || a - b);
  const [s0, s1] = ENDING.seaward;
  rest.forEach((i, j) => out.push(to(i, w6 + s0 + ((s1 - s0) * j) / Math.max(1, rest.length - 1))));
  return out.sort((x, y) => x.t0 - y.t0);
}
