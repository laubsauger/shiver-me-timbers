/**
 * The title is written on like a pen (the client's note of 2026-10-31: "drawn on along its strokes like calligraphy /
 * handwriting over ~1.5–2 s"): the reveal follows the baked strokes in writing order, takes about that long, never
 * takes ink back, and leaves the whole word on the dome when it is done. Every frame is a function of show time, so
 * the progress is too.
 */
import { describe, expect, it } from 'vitest';
import { INK_DELAY, INK_DRAW, hasInkPath, inkPath, inkProgress } from '../src/drift/titleInk';
import strokes from '../src/drift/titleStrokes.json';

const TITLE = 'the Drift';
const reached = (p: number) => inkPath(TITLE, p)!.segments;

describe('the title, written on', () => {
  it('has a baked pen path for the title, and none for copy it was not baked for (that draws on as a wipe)', () => {
    expect(hasInkPath(TITLE)).toBe(true);
    expect(hasInkPath('Some later title')).toBe(false);
    expect(inkPath('Some later title', 0.5)).toBeNull();
  });

  it('writes over ~1.5–2 s after a short breath, as a function of the time since the phrase began', () => {
    expect(INK_DRAW).toBeGreaterThanOrEqual(1.5);
    expect(INK_DRAW).toBeLessThanOrEqual(2);
    expect(inkProgress(0)).toBe(0);
    expect(inkProgress(INK_DELAY)).toBe(0);
    expect(inkProgress(INK_DELAY + INK_DRAW)).toBe(1);
    expect(inkProgress(60)).toBe(1);
    let last = 0;
    for (let s = 0; s <= INK_DELAY + INK_DRAW; s += 0.01) {
      const p = inkProgress(s);
      expect(p).toBeGreaterThanOrEqual(last); // never takes ink back
      // never hangs: the pen keeps moving through the middle of the writing
      if (s > INK_DELAY + 0.1 && s < INK_DELAY + INK_DRAW - 0.1) expect(p - last).toBeGreaterThan(0);
      last = p;
    }
  });

  it('only ever adds ink: what is written at p is still written at any later p', () => {
    for (const [a, b] of [[0.1, 0.3], [0.3, 0.6], [0.6, 0.99]]) {
      const early = reached(a);
      const late = reached(b);
      expect(late.length).toBeGreaterThanOrEqual(early.length);
      // every whole segment of the earlier mask is in the later one, unchanged
      for (let i = 0; i < early.length - 1; i++) expect(late[i]).toEqual(early[i]);
    }
  });

  it('writes in reading order: "the" before the D, the D before "rift", the pen moving left to right overall', () => {
    const data = (strokes as unknown as Record<string, { strokes: number[][][] }>)[TITLE].strokes;
    const startX = data.map((s) => s[0][0]);
    // the first stroke is the t of "the", the D's stroke comes before any of "rift" (x past the D's bowl, ~1.0 em on)
    expect(startX[0]).toBeLessThan(0.5);
    const firstRift = startX.findIndex((x) => x > 2.0);
    expect(startX.slice(0, firstRift).every((x) => x < 2.2)).toBe(true);
    // the pen's position marches right: at quarter steps it is further along the word each time (give a little for the
    // D's bowl, which is written back over its own stem)
    // (where the ink has got to: the last segment's end — the pen itself is null while it is lifted between strokes)
    const penX = [0.2, 0.45, 0.7, 0.95].map((p) => reached(p).at(-1)![2]);
    for (let i = 1; i < penX.length; i++) expect(penX[i]).toBeGreaterThan(penX[i - 1] - 0.3);
    expect(penX[3]).toBeGreaterThan(penX[0] + 1.5);
  });

  it('leaves the whole word and no pen light when done, and nothing before it starts', () => {
    expect(reached(0)).toEqual([]);
    const done = inkPath(TITLE, 1)!;
    expect(done.pen).toBeNull();
    const all = (strokes as unknown as Record<string, { strokes: number[][][] }>)[TITLE].strokes;
    const segs = all.reduce((n, s) => n + Math.max(1, s.length - 1), 0);
    expect(done.segments.length).toBe(segs);
  });
});
