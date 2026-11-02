/**
 * The copy is written by the survivor's light along the letters' own strokes (src/drift/undertime/crawlInk.ts; the
 * 2026-11-02 review: the light "follows the line's centre, not the letters' strokes, so it looks fake"; the client's
 * note of 2026-10-31: "less stiff"). What makes it read as writing rather than a wipe with a light on it: the light is
 * ON the ink while it writes, it goes through the strokes in the order a hand would and through the glyphs in reading
 * order, and it never takes ink back. What keeps the film as it was: every glyph is whole by the end of the slot it
 * already had, so the phrases are readable exactly when they were, and a copy glyph without a baked path cannot slip
 * in unnoticed.
 */
import { describe, expect, it } from 'vitest';
import strokes from '../src/drift/undertime/copyStrokes.json';
import { FONTS, PEN, bodyPen, glyphInk } from '../src/drift/undertime/crawl';
import { LIFT, LIFT_IN, glyphAdvance, glyphEnds, glyphWriting, hasGlyphPath, lineEnds, linePen, type LineGlyph } from '../src/drift/undertime/crawlInk';
import { undertimeCrawl } from '../src/drift/undertime/crawlText';
import { driftParams } from '../src/params/drift';

type Pt = [number, number, number];
const baked = (strokes as unknown as { weight: number; glyphs: Record<string, { strokes: Pt[][] }> }).glyphs;
const body = undertimeCrawl({ ...driftParams }).filter((p) => !p.signature);
const copyGlyphs = [...new Set(body.flatMap((p) => [...p.lines.join('')]).filter((c) => c.trim() !== ''))];

/** a line laid out as crawl.ts drawLine lays it: each glyph its advance, tracking after it, as fractions of the line */
function layout(text: string): LineGlyph[] {
  const tr = FONTS.bodyTracking;
  const w = [...text].map((c) => (glyphAdvance(c) ?? 0.25) + tr);
  const total = w.reduce((a, b) => a + b, 0) - tr;
  let run = 0;
  return [...text].map((ch, k) => {
    const g = { ch, f0: run / total, f1: (run + w[k] - tr) / total };
    run += w[k];
    return g;
  });
}

/** em from (x, y) to the nearest point of glyph `ch`'s baked strokes, and the ink's half-width there */
function nearestInk(ch: string, x: number, y: number): { d: number; r: number } {
  let best = { d: Infinity, r: 0 };
  for (const s of baked[ch].strokes) {
    for (let i = 0; i + 1 < s.length; i++) {
      const [ax, ay, ar] = s[i];
      const [bx, by, br] = s[i + 1];
      const L2 = (bx - ax) ** 2 + (by - ay) ** 2;
      const t = L2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / L2)) : 0;
      const d = Math.hypot(x - (ax + (bx - ax) * t), y - (ay + (by - ay) * t));
      if (d < best.d) best = { d, r: ar + (br - ar) * t };
    }
  }
  return best;
}

describe('the copy, written on along its strokes', () => {
  it('has a baked pen path for every glyph of the copy, baked at the weight the crawl draws', () => {
    // (a glyph without one would come up in the old wipe, under a light passing over it in the air: the look would
    // change mid-word without anyone noticing — rebake with scripts/drift-copy-strokes.py)
    for (const ch of copyGlyphs) expect(hasGlyphPath(ch), `"${ch}"`).toBe(true);
    // the strokes are the centrelines of the face at one weight; a heavier or lighter crawl would leave the pen off them
    const weight = Number(/italic (\d+)/.exec(FONTS.body)?.[1]);
    expect((strokes as unknown as { weight: number }).weight).toBe(weight);
  });

  it('keeps the light on the ink while it writes, and on the glyph whose slot it is', () => {
    for (const ph of body) {
      const ink = bodyPen(0, ph.lines);
      ph.lines.forEach((text, j) => {
        const gl = layout(text);
        for (let s = ink.starts[j]; s < ink.starts[j] + ink.durs[j]; s += 0.0011) {
          const lp = linePen(s, ink.starts[j], ink.durs[j], gl)!;
          if (!lp.down) continue;
          // writing: a and b are the same point, inside the half-width of a stroke of the glyph being written
          expect(lp.a).toEqual(lp.b);
          const g = gl[lp.a.g];
          expect(s).toBeGreaterThanOrEqual(ink.starts[j] + ink.durs[j] * g.f0 - 1e-9);
          expect(s).toBeLessThan(ink.starts[j] + ink.durs[j] * g.f1 + 1e-9);
          const n = nearestInk(g.ch, lp.a.x, lp.a.y);
          expect(n.d, `${text} "${g.ch}" at ${s.toFixed(4)} s`).toBeLessThanOrEqual(n.r + 1e-6);
        }
      });
    }
  });

  it('writes in order: glyph after glyph along the line, stroke after stroke within a glyph, never taking ink back', () => {
    for (const ch of copyGlyphs) {
      let prev = glyphWriting(ch, 0)!.segments;
      expect(prev).toEqual([]);
      for (let q = 0.02; q <= 1.0001; q += 0.02) {
        const now = glyphWriting(ch, q)!.segments;
        expect(now.length).toBeGreaterThanOrEqual(prev.length);
        // every whole segment written before is still there, unchanged (only the one at the pen grows)
        for (let i = 0; i < prev.length - 1; i++) expect(now[i]).toEqual(prev[i]);
        prev = now;
      }
    }
    for (const ph of body) {
      const ink = bodyPen(0, ph.lines);
      ph.lines.forEach((text, j) => {
        const gl = layout(text);
        let g = -1;
        for (let s = ink.starts[j] - 0.05; s < ink.starts[j] + ink.durs[j] + 0.05; s += 0.002) {
          const lp = linePen(s, ink.starts[j], ink.durs[j], gl)!;
          // (in the air between glyphs it is on its way from one to the next: b is never behind a)
          expect(lp.b.g).toBeGreaterThanOrEqual(lp.a.g);
          expect(lp.a.g).toBeGreaterThanOrEqual(g);
          g = lp.a.g;
        }
        // it starts where the line's first glyph starts and ends where the last one ends (the descent, the crossing
        // and the rise back meet it there: crawl.ts bodyPenAt)
        const ends = lineEnds(gl)!;
        expect(linePen(ink.starts[j], ink.starts[j], ink.durs[j], gl)!.a).toEqual(ends.first);
        expect(linePen(ink.starts[j] + ink.durs[j], ink.starts[j], ink.durs[j], gl)!.a).toEqual(ends.last);
      });
    }
  });

  it('starts each glyph high, as a hand does: in the upper half of its strokes or of the x-height', () => {
    // (an automatic walk that began in the middle of a stem, or wrote a bowl backwards from its foot, is what the hand
    // waypoints of the bake are for; this holds the bake to it for every glyph of the copy)
    for (const ch of copyGlyphs) {
      const pts = baked[ch].strokes.flat();
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const [x, y] = glyphEnds(ch)!.first;
      const u = (x - Math.min(...xs)) / Math.max(1e-6, Math.max(...xs) - Math.min(...xs));
      const v = (y - Math.min(...ys)) / Math.max(1e-6, Math.max(...ys) - Math.min(...ys));
      // the upper half of its strokes (a stem's top, an o's), or of the x-height, 0.2 em above the baseline (the a's and
      // the d's bowl, begun at its top right, half-way up a d's box; the e's bar): never at the foot of a stem or a bowl
      expect(v < 0.5 || y < -0.2, `"${ch}" starts at (${u.toFixed(2)}, ${v.toFixed(2)}) of its strokes' box, ${y.toFixed(3)} em`).toBe(true);
    }
  });

  it('has every glyph whole by the end of its slot, so the reading time is what it was', () => {
    for (const ch of copyGlyphs) {
      const done = glyphWriting(ch, 1)!;
      const segs = baked[ch].strokes.reduce((n, s) => n + s.length - 1, 0);
      expect(done.segments.length).toBe(segs);
      // what the round tip could not reach is up too: from here on the glyph is the face's own (crawl.ts writeBodyGlyph)
      expect(done.tail).toBe(1);
      expect(glyphWriting(ch, 0)!.tail).toBe(0);
    }
    // and the slots are the soft wipe's: whole by the time the old wipe was (glyphInk's alpha reaching 1)
    for (const ph of body) {
      const ink = bodyPen(0, ph.lines);
      ph.lines.forEach((text, j) => {
        for (const g of layout(text)) {
          const end = ink.starts[j] + ink.durs[j] * g.f1;
          expect(glyphInk(end + PEN.soft, ink.starts[j], ink.durs[j], g.f0, g.f1).alpha).toBeCloseTo(1, 6);
        }
      });
    }
  });

  it('spends a glyph\'s slot mostly writing: the lifts are short beside the strokes', () => {
    // (at 28 glyphs a second a slot is ~35 ms: if moves through the air took most of it, the strokes would come up in
    // a frame's jump and the light would be in the air more than on the ink)
    for (const ch of copyGlyphs) {
      const s = baked[ch].strokes;
      const ink = s.reduce((a, st) => a + st.slice(1).reduce((b, p, i) => b + Math.hypot(p[0] - st[i][0], p[1] - st[i][1]), 0), 0);
      const air = LIFT_IN + LIFT * (s.length - 1);
      // (a letter: a full stop is a touch of ink and its slot mostly the move to it)
      if (/\p{L}/u.test(ch)) expect(air / (air + ink), `"${ch}"`).toBeLessThan(0.45);
    }
  });
});
