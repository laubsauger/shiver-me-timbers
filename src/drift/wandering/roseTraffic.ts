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

/**
 * c4's wake: the messages, from `c4` (sea s, c4's start), over `links` whose arcs are `arcDeg` long, for `n` stations.
 * Returns the messages and the sea s each station is first reached (the WAKE_FROM station: the first answer's).
 */
export function wakeTraffic(c4: number, links: Array<[number, number]>, arcDeg: number[], n: number): { messages: RoseMessage[]; litAt: number[] } {
  const linkOf = (a: number, b: number): number => links.findIndex(([x, y]) => (x === a && y === b) || (x === b && y === a));
  const messages: RoseMessage[] = [];
  const litAt = new Array<number>(n).fill(Infinity);
  litAt[WAKE_FROM] = c4 + WAKE.first;
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
        const dur = travel(arcDeg[k]);
        const t0 = litAt[s] + WAKE.call;
        const arrive = t0 + dur;
        messages.push({ link: k, from: links[k][0] === s ? 0 : 1, t0, dur });
        messages.push({ link: k, from: links[k][0] === m ? 0 : 1, t0: arrive + WAKE.answer, dur });
        if (arrive < litAt[m]) {
          litAt[m] = arrive;
          if (!next.includes(m)) next.push(m);
        }
      }
    }
    frontier = next;
  }
  // THE CHORDS, once the ring is closed: across the sky, each from its a and answered from its b
  let i = 0;
  links.forEach(([a, b], k) => {
    if (carried.has(k)) return;
    const dur = travel(arcDeg[k]);
    const t0 = Math.max(c4 + WAKE.chords + i++ * WAKE.chordGap, litAt[a] + WAKE.call, litAt[b] + WAKE.call);
    messages.push({ link: k, from: 0, t0, dur });
    messages.push({ link: k, from: 1, t0: t0 + dur + WAKE.answer, dur });
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

/** the raft's dial at sea s `t`: 0 … 1, its crackle as the network first answers (c4 + WAKE.dial): the static rises
 * over a second and a half, holds while the first station answers, and settles over a few seconds */
export function dialFlare(t: number, c4: number): number {
  const x = t - (c4 + WAKE.dial);
  if (x <= -1.5) return 0;
  if (x < 0) {
    const k = (x + 1.5) / 1.5;
    return k * k * (3 - 2 * k);
  }
  return x < 2 ? 1 : Math.exp(-(x - 2) / 2.5);
}
