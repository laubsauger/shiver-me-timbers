/**
 * The crawl is Mark's reversed Star Wars titles: lines appear at mid-heaven, recede toward the horizon and
 * shrink, in order, and the act is signed with "the Drift", which stops and holds. On a dome, text outside
 * the front safe zone is text half the audience cannot read, so every line stays between elTop and elBottom.
 */
import { describe, expect, it } from 'vitest';
import { crawlPlacement, type CrawlLayout } from '../src/drift/undertime/crawl';
import { UNDERTIME_CRAWL } from '../src/drift/undertime/crawlText';

const L: CrawlLayout = {
  start: 9, gap: 5, travel: 14, elTop: 58, elBottom: 12, holdEl: 32, sizeTop: 0.032, sizeBottom: 0.012, fade: 3, end: 64, maxArc: 1.6,
};
const lines = UNDERTIME_CRAWL;
const n = lines.length;
const sig = lines.findIndex((l) => l.signature);

describe('Undertime crawl', () => {
  it('ends on the signature line, "the Drift"', () => {
    expect(sig).toBe(n - 1);
    expect(lines[sig].text).toBe('the Drift');
  });

  it('lines appear in order, recede and shrink, and stay inside the safe elevations', () => {
    for (let i = 0; i < n; i++) {
      const t0 = L.start + i * L.gap;
      expect(crawlPlacement(t0 - 0.01, i, n, lines[i], L)).toBeNull();
      let prev = crawlPlacement(t0 + 0.05, i, n, lines[i], L)!;
      expect(prev.el).toBeLessThanOrEqual(L.elTop);
      for (let dt = 0.5; dt < L.travel; dt += 0.5) {
        const at = crawlPlacement(t0 + dt, i, n, lines[i], L);
        if (!at) break;
        expect(at.el).toBeLessThanOrEqual(prev.el + 1e-9);
        expect(at.size).toBeLessThanOrEqual(prev.size + 1e-9);
        expect(at.el).toBeGreaterThanOrEqual(L.elBottom - 1e-9);
        prev = at;
      }
    }
  });

  it('a body line is gone once it reaches the horizon; the signature stops at holdEl and holds until the end', () => {
    expect(crawlPlacement(L.start + L.travel + 0.01, 0, n, lines[0], L)).toBeNull();
    const t0 = L.start + sig * L.gap;
    const settled = crawlPlacement(t0 + L.travel, sig, n, lines[sig], L)!;
    expect(settled.el).toBeCloseTo(L.holdEl, 9);
    expect(crawlPlacement(L.end - L.fade - 0.5, sig, n, lines[sig], L)!.alpha).toBeCloseTo(1, 9);
    expect(crawlPlacement(L.end + 0.01, sig, n, lines[sig], L)).toBeNull();
  });

  it('the signature is set larger than the body lines', () => {
    const body = crawlPlacement(L.start + 1, 0, n, lines[0], L)!;
    const s = crawlPlacement(L.start + sig * L.gap + 1, sig, n, lines[sig], L)!;
    expect(s.size).toBeGreaterThan(body.size);
  });
});
