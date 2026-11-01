/**
 * The text is Mark's reversed Star Wars titles, made readable on a dome: it comes in phrases that read top
 * to bottom (a scroll of sinking lines reads bottom-up), each held long enough to read, only one on the dome
 * at a time, inside the front's comfortable elevations, never during the wave, and signed with "the Drift",
 * which settles and holds.
 */
import { describe, expect, it } from 'vitest';
import { LINE_PITCH, bodyPen, glyphInk, phraseHold, phrasePlacement, type CrawlLayout } from '../src/drift/undertime/crawl';
import { undertimeCrawl } from '../src/drift/undertime/crawlText';
import { driftParams } from '../src/params/drift';
import { beatStarts } from '../src/drift/undertime/timeline';

const p = { ...driftParams };
const { starts, total } = beatStarts(p);
const L: CrawlLayout = { elTop: p.crawlElTop, sink: p.crawlSink, holdEl: p.crawlHoldEl, size: p.crawlSize, fade: 3, end: total, maxArc: p.crawlMaxArc };
const phrases = undertimeCrawl(p);
const visible = (t: number) => phrases.filter((ph) => phrasePlacement(t, ph, L) !== null);

describe('Undertime text', () => {
  it('ends on the signature, "the Drift", which settles at holdEl and holds to the end', () => {
    const sig = phrases[phrases.length - 1];
    expect(sig.signature).toBe(true);
    expect(sig.lines).toEqual(['the Drift']);
    expect(phrasePlacement(total - 3.5, sig, L)!.el).toBeCloseTo(L.holdEl, 6);
    expect(phrasePlacement(total - 3.5, sig, L)!.alpha).toBeCloseTo(1, 6);
    expect(phrasePlacement(total + 0.01, sig, L)).toBeNull();
  });

  it('shows one phrase at a time, so the dome never holds two that compete', () => {
    for (let t = 0; t < total; t += 0.1) expect(visible(t).length, `at ${t.toFixed(1)} s`).toBeLessThanOrEqual(1);
  });

  it('never puts text on the dome during the wave (U3)', () => {
    for (let t = starts.wave; t < starts.wave + p.wave; t += 0.1) expect(visible(t)).toEqual([]);
  });

  it('holds each phrase long enough to read: fully up for 1.5 s plus 0.3 s per word', () => {
    for (const ph of phrases.filter((x) => !x.signature)) {
      let up = 0;
      for (let t = ph.at; t < ph.at + 20; t += 0.02) if ((phrasePlacement(t, ph, L)?.alpha ?? 0) > 0.99) up += 0.02;
      expect(up).toBeGreaterThanOrEqual(phraseHold(ph) - 0.1);
    }
  });

  it('reads top to bottom and stays inside the comfortable front elevations (about 20–40°)', () => {
    for (const ph of phrases) {
      for (let t = ph.at; t < ph.at + 12; t += 0.25) {
        const at = phrasePlacement(t, ph, L);
        if (!at) continue;
        const lineEl = ph.lines.map((_, j) => at.el - j * at.size * 180 * LINE_PITCH);
        for (let j = 1; j < lineEl.length; j++) expect(lineEl[j]).toBeLessThan(lineEl[j - 1]);
        for (const el of lineEl) {
          expect(el).toBeLessThanOrEqual(40);
          expect(el).toBeGreaterThanOrEqual(20);
        }
      }
    }
  });

  it('sinks and shrinks as it is read (Mark: shrinking from mid-heaven toward the horizon)', () => {
    const ph = phrases[0];
    const a = phrasePlacement(ph.at + 1, ph, L)!;
    const b = phrasePlacement(ph.at + 3.5, ph, L)!;
    expect(b.el).toBeLessThan(a.el);
    expect(b.size).toBeLessThan(a.size);
  });

  it('sets text big enough for the back rows: an x-height of about 3° (half the text height) or more', () => {
    for (const ph of phrases) {
      const at = phrasePlacement(ph.at + 1, ph, L)!;
      expect(at.size * 180 * 0.5).toBeGreaterThanOrEqual(2.5);
    }
  });

  it('is written by the survivor\'s light, and whole while there is still most of the hold to read it in', () => {
    // (the 2026-11-01 brief: "the one surviving grain's light writes the copy … the text must stay readable") — the
    // pen comes down from the act's one place, writes line by line, goes back; every glyph is up by 0.9 s (the fade-in)
    // + half the hold, so the writing never eats the reading time
    for (const ph of phrases.filter((x) => !x.signature)) {
      const ink = bodyPen(0, ph.lines);
      expect(bodyPen(0.01, ph.lines).pen!.from.line).toBe(-1);
      const whole = 0.9 + phraseHold(ph) / 2;
      ph.lines.forEach((_, j) => expect(glyphInk(whole, ink.starts[j], ink.durs[j], 0.95, 1).alpha).toBeCloseTo(1, 6));
      // line by line, left to right: the second line starts after the first is written
      for (let j = 1; j < ph.lines.length; j++) expect(ink.starts[j]).toBeGreaterThan(ink.starts[j - 1] + ink.durs[j - 1]);
      let f = -1;
      for (let s = ink.starts[0]; s < ink.starts[0] + ink.durs[0]; s += 0.02) {
        const pen = bodyPen(s, ph.lines).pen!;
        expect(pen.to.f).toBeGreaterThanOrEqual(f);
        f = pen.to.f;
      }
      // and it goes back to the spot and out
      const end = ink.starts[ph.lines.length - 1] + ink.durs[ph.lines.length - 1];
      expect(bodyPen(end + 0.3, ph.lines).pen!.to.line).toBe(-1);
      expect(bodyPen(end + 1, ph.lines).pen).toBeNull();
    }
  });
});
