/**
 * Type variant B (src/drift/undertime/crawlSans.ts; the client's note of 2026-10-31: "a suggestion that looks less
 * stiff … a clean airy helvetica or arial style for the main type … (but with this 'signature')"): the copy in a sans
 * whose glyphs arrive out of a soft blur and leave the same way. It must stay a second LOOK on the same film — off unless
 * asked for, in the crawl's slots to the hundredth — and the reveal must stay calm and must not cost the reading time.
 */
import { describe, expect, it } from 'vitest';
import { FADE_OUT, phraseHold, phraseLife } from '../src/drift/undertime/crawl';
import { SANS, sansGlyph, sansStart, sansWords, titleType } from '../src/drift/undertime/crawlSans';
import { undertimeCrawl } from '../src/drift/undertime/crawlText';
import { driftParams } from '../src/params/drift';

const body = undertimeCrawl({ ...driftParams }).filter((p) => !p.signature);
/** every glyph of a phrase: line j, index k, word, fraction along the line (by character count: close enough here) */
const glyphs = (lines: string[]) =>
  lines.flatMap((text, j) => {
    const words = sansWords(text);
    return [...text].map((ch, k) => ({ ch, j, k, word: words[k], f: (k + 0.5) / text.length })).filter((g) => g.ch.trim() !== '');
  });

describe('type variant B (?type=sans)', () => {
  it('is off unless the page asks for it, so the film draws as before by default', () => {
    expect(titleType('')).toBe('script');
    expect(titleType('?t=20&paused')).toBe('script');
    expect(titleType('?type=serif')).toBe('script');
    expect(titleType('?record&lane&type=sans')).toBe('sans');
  });

  it('has every glyph whole while most of the hold is still left to read it in (as the pen does)', () => {
    // the pen's test (undertimeCrawl.test.ts): whole by the fade-in plus half the hold
    for (const ph of body) {
      const life = phraseLife(ph.lines);
      const whole = 0.9 + phraseHold(ph) / 2;
      for (const g of glyphs(ph.lines)) {
        const s = sansGlyph(whole, life, FADE_OUT, g.j, g.k, g.word, g.f);
        expect(s.alpha, `${ph.lines[g.j]} [${g.k}]`).toBeCloseTo(1, 6);
        expect(s.blur).toBeCloseTo(0, 6);
        expect(Math.hypot(s.dx, s.dy)).toBeCloseTo(0, 6);
      }
    }
  });

  it('keeps the crawl\'s slots: nothing before the phrase starts, everything gone exactly when its life ends', () => {
    for (const ph of body) {
      const life = phraseLife(ph.lines);
      for (const g of glyphs(ph.lines)) {
        expect(sansGlyph(0, life, FADE_OUT, g.j, g.k, g.word, g.f).alpha).toBe(0);
        expect(sansGlyph(life, life, FADE_OUT, g.j, g.k, g.word, g.f).alpha).toBe(0);
        // and still whole just before the fade-out begins: the leaving does not eat into the hold
        expect(sansGlyph(life - FADE_OUT, life, FADE_OUT, g.j, g.k, g.word, g.f).alpha).toBeCloseTo(1, 6);
      }
    }
  });

  it('arrives calmly: opacity only rises, the blur only clears, and the drift settles without overshooting its place', () => {
    // ("nothing bouncy or techy": an overshoot would show as the offset crossing zero, a bounce as opacity dipping)
    const life = 10;
    let alpha = 0;
    let blur = Infinity;
    for (let t = 0; t < life - FADE_OUT; t += 0.01) {
      const s = sansGlyph(t, life, FADE_OUT, 1, 6, 1, 0.3);
      expect(s.alpha).toBeGreaterThanOrEqual(alpha - 1e-12);
      expect(s.blur).toBeLessThanOrEqual(blur + 1e-12);
      // it comes from behind and above (negative along and across the line) and never passes its place
      expect(s.dx).toBeLessThanOrEqual(1e-12);
      expect(s.dy).toBeLessThanOrEqual(1e-12);
      alpha = s.alpha;
      blur = s.blur;
    }
  });

  it('leaves the way it came: softening, fading and carrying on with the sink, in reading order', () => {
    const life = 10;
    const a = sansGlyph(life - 0.4, life, FADE_OUT, 0, 0, 0, 0.05);
    const b = sansGlyph(life - 0.4, life, FADE_OUT, 0, 20, 3, 0.95);
    expect(a.alpha).toBeLessThan(b.alpha); // the line's first glyph is further gone than its last
    expect(a.blur).toBeGreaterThan(0);
    expect(a.dy).toBeGreaterThan(0); // on down, the way the phrase sinks
    expect(a.dx).toBeGreaterThan(0); // and on along the line
  });

  it('is staggered in reading order, word by word and line under line, and the same every frame', () => {
    const text = 'is made of what remained.';
    const w = sansWords(text);
    expect(w[0]).toBe(0);
    expect(w[3]).toBe(1);
    expect(w[text.length - 1]).toBe(4);
    // later glyphs start later (the jitter is smaller than a glyph's step plus a word's breath)
    for (let k = 1; k < text.length; k++) if (text[k].trim()) expect(sansStart(0, k, w[k]) + SANS.jitter * 2).toBeGreaterThan(sansStart(0, k - 1, w[k - 1]));
    expect(sansStart(1, 0, 0)).toBeGreaterThan(sansStart(0, 0, 0));
    // pure: the same glyph at the same time is the same glyph
    expect(sansGlyph(1.234, 6, FADE_OUT, 1, 4, 1, 0.2)).toEqual(sansGlyph(1.234, 6, FADE_OUT, 1, 4, 1, 0.2));
  });
});
