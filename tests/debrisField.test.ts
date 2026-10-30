/**
 * The flood's debris (src/drift/getTheDrift/debrisField.ts): what the pieces ARE changed (boards, logs, panels, the
 * people's things; the 2026-10-29 review), but WHERE they lie must not. The field is laid out to rhyme with the sea's
 * own colour pattern from afar (debris.ts draws the same arms and clumps), the descent comes down onto a point of it,
 * and sea.ts clears the raft's berth and way through it by position — a piece that moved would float through the hull
 * or leave a hole in the arms. So the pieces' draws from the seeded stream must stay the boxes' draws, in their order.
 */
import { describe, expect, it } from 'vitest';
import { DEBRIS_RADIUS, debrisDensity, debrisPieces, matPieces, thingsAt } from '../src/drift/getTheDrift/debrisField';
import { rng } from '../src/drift/undertime/web';

/** the boxes' own layout, as it was before the pieces became flotsam: the same stream, the same draws per piece */
function boxesLayout(count: number, seed: number): Array<[number, number, number, number]> {
  const r = rng(seed);
  const out: Array<[number, number, number, number]> = [];
  while (out.length < count) {
    const a = r() * Math.PI * 2;
    const rr = Math.sqrt(r()) * DEBRIS_RADIUS * 1.15;
    const x = Math.cos(a) * rr;
    const z = Math.sin(a) * rr;
    if (r() * 2.6 > debrisDensity(x, z)) continue;
    // the old makePiece: kind, length, then three draws (two for the logs), then tone and yaw
    const kind = r();
    r();
    if (kind < 0.55 || kind >= 0.88) r(), r(), r();
    else r(), r();
    r();
    const yaw = r() * Math.PI;
    out.push([x, z, yaw, kind]);
  }
  return out;
}

describe('debrisField', () => {
  it('lays every piece where the boxes lay, turned as they were', () => {
    const n = 3000;
    const old = boxesLayout(n, 2100);
    const now = debrisPieces(n, 2100);
    for (let i = 0; i < n; i++) {
      // (bit for bit, as the Float32Array stores them)
      expect(now.place[i * 4]).toBe(Math.fround(old[i][0]));
      expect(now.place[i * 4 + 1]).toBe(Math.fround(old[i][1]));
      expect(now.place[i * 4 + 2]).toBe(Math.fround(old[i][2]));
    }
  });

  it('floats every piece low (a share of its height out of the water), and mixes in the things people owned', () => {
    const d = matPieces(0, 0, 90, 6000);
    const kinds = new Map<number, number>();
    for (let i = 0; i < d.count; i++) {
      const fb = d.extra[i * 4];
      expect(fb).toBeGreaterThan(0.1);
      // the wood waterlogged, under 40% of its height out; the things ride as they float (an upturned table's legs
      // stand up out of the water)
      expect(fb).toBeLessThan(d.kind[i] <= 3 ? 0.4 : 0.9);
      kinds.set(d.kind[i], (kinds.get(d.kind[i]) ?? 0) + 1);
    }
    // the mass is waterlogged wood (planks, beams, logs, panels: kinds 0–3); the things are a few percent of it
    const wood = [0, 1, 2, 3].reduce((s, k) => s + (kinds.get(k) ?? 0), 0);
    const things = d.count - wood;
    expect(wood / d.count).toBeGreaterThan(0.9);
    expect(things).toBeGreaterThan(30);
    // and the wood is not one kind everywhere: logs and planks both present
    expect(kinds.get(0) ?? 0).toBeGreaterThan(500);
    expect(kinds.get(2) ?? 0).toBeGreaterThan(200);
  });

  it('sets a recognisable thing at every spot it is asked to, at its real size', () => {
    const at: Array<[number, number]> = [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10], [11, 12]];
    const d = thingsAt(at);
    expect(d.count).toBe(at.length);
    for (let i = 0; i < d.count; i++) {
      expect(d.kind[i]).toBeGreaterThanOrEqual(4);
      expect(d.place[i * 4]).toBe(at[i][0]);
      // a thing at its real size: the longest, the upturned picnic table, is 3 m
      expect(d.place[i * 4 + 3]).toBeLessThan(3.5);
    }
  });
});
