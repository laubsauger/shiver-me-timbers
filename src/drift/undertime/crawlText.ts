/**
 * PLACEHOLDER crawl text, until Dimi's orders-of-magnitude narration arrives
 * (drift-narrative/undertime/treatment.md, "The crawl on a dome"). Short lines on purpose: each line must
 * fit the front safe zone (±50° azimuth) at the elevation where it is largest.
 */
import type { CrawlLine } from './crawl';
import type { DriftParams } from '../../params/drift';
import { beatStarts } from './timeline';

export const UNDERTIME_CRAWL: readonly CrawlLine[] = [
  { text: 'Before there was a before,' },
  { text: 'matter and antimatter' },
  { text: 'rose together, and cancelled.' },
  { text: 'For every billion that vanished,' },
  { text: 'one grain of matter remained.' },
  { text: 'Everything we know' },
  { text: 'is made of that remainder.' },
  { text: 'the Drift', signature: true },
];

/**
 * The crawl timed to the direction's text windows (direction.md): the cooling, the remain beat, the calm
 * middle of the pull-back, and the signature as the first stars come up. Never during the wave.
 */
export function undertimeCrawl(p: DriftParams): CrawlLine[] {
  const { starts } = beatStarts(p);
  const at = [starts.cool + 2.5, starts.cool + 6, starts.cool + 9.5, starts.remain + 2.5, starts.remain + 6, starts.zoom + 7, starts.zoom + 10.5, starts.gather + 3];
  return UNDERTIME_CRAWL.map((line, i) => ({ ...line, at: at[i] }));
}
