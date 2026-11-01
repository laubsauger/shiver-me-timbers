/**
 * The Rose's traffic (src/drift/wandering/roseTraffic.ts): what must hold however it is retimed. The network WAKES from
 * our position outward — nothing speaks before the raft's radio crackles, one station answers first, and every
 * other station is reached by a message from one already awake (so it reads as a network coming alive, not lines being
 * drawn); every link carries a message, each answered; a lamp's answer is slow (comfort on the dome); and every pulse
 * and flare is a pure function of the clock (render lanes draw in any order).
 */
import { describe, expect, it } from 'vitest';
import { FLARE, WAKE, WAKE_FROM, chatterTraffic, dialFlare, flare, receiver, roseLinks, sender, stationFlare, wakeTraffic } from '../src/drift/wandering/roseTraffic';

const N = 7;
const links = roseLinks(N);
// (arcs as the eye at sea sees them: neighbours ~50°, the widest ~160°)
const arcDeg = links.map(([a, b]) => [0, 50, 110, 160][Math.min((b - a + N) % N, (a - b + N) % N)]);
const C4 = 420;

describe('the Rose\'s traffic', () => {
  it('joins every station to every other, once', () => {
    expect(links).toHaveLength((N * (N - 1)) / 2);
    expect(new Set(links.map(([a, b]) => [Math.min(a, b), Math.max(a, b)].join())).size).toBe(links.length);
  });

  it('wakes from one station, after our radio crackles, each station reached by one already awake', () => {
    const { messages, litAt } = wakeTraffic(C4, links, arcDeg, N);
    expect(Math.min(...messages.map((m) => m.t0))).toBeGreaterThan(C4 + WAKE.dial);
    expect(litAt[WAKE_FROM]).toBe(Math.min(...litAt));
    for (const m of messages) expect(m.t0).toBeGreaterThanOrEqual(litAt[sender(m, links)]);
    // the ring lights outward both ways: a station's neighbour toward the front is lit before it
    const ringDist = (i: number): number => Math.min((i - WAKE_FROM + N) % N, (WAKE_FROM - i + N) % N);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (ringDist(i) < ringDist(j)) expect(litAt[i]).toBeLessThan(litAt[j]);
  });

  it('carries a call and an answer along every link, the answer from the station called', () => {
    const { messages } = wakeTraffic(C4, links, arcDeg, N);
    links.forEach((_, k) => {
      const on = messages.filter((m) => m.link === k);
      expect(on.length).toBeGreaterThanOrEqual(2);
      expect(sender(on[1], links)).toBe(receiver(on[0], links));
      expect(on[1].t0).toBeGreaterThanOrEqual(on[0].t0 + on[0].dur);
    });
  });

  it('keeps w6 quieter than the wake, and lights each link by a message within its first ~45 s', () => {
    const w6 = 700;
    const chat = chatterTraffic(w6, w6 + 60, links, arcDeg);
    const wake = wakeTraffic(C4, links, arcDeg, N).messages;
    const rate = (ms: typeof chat, from: number, len: number): number => ms.filter((m) => m.t0 >= from && m.t0 < from + len).length / len;
    expect(rate(chat, w6, 60)).toBeLessThan(rate(wake, C4 + 9, 45));
    links.forEach((_, k) => expect(Math.min(...chat.filter((m) => m.link === k).map((m) => m.t0))).toBeLessThan(w6 + 50));
  });

  it("answers slowly: a lamp's flare takes over half a second to rise and seconds to fade", () => {
    expect(flare(0)).toBe(0);
    expect(flare(0.25)).toBeLessThan(0.5);
    expect(flare(FLARE.rise)).toBeCloseTo(1, 6);
    expect(flare(FLARE.rise + 1)).toBeGreaterThan(0.4);
    expect(dialFlare(C4, C4)).toBe(0);
    expect(dialFlare(C4 + WAKE.dial + 1, C4)).toBe(1);
  });

  it('is a pure function of the clock: any order of frames gives the same flares', () => {
    const { messages } = wakeTraffic(C4, links, arcDeg, N);
    const ts = Array.from({ length: 200 }, (_, i) => C4 + i * 0.3);
    const forward = ts.map((t) => stationFlare(t, 2, messages, links));
    const shuffled = [...ts].reverse().map((t) => stationFlare(t, 2, messages, links)).reverse();
    expect(shuffled).toEqual(forward);
    // and the station ahead flares only once the wake has begun
    expect(stationFlare(C4 + WAKE.first - 2, WAKE_FROM, messages, links)).toBe(0);
  });
});
