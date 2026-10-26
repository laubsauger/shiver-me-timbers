/**
 * PLACEHOLDER text, until Dimi's orders-of-magnitude narration arrives (drift-narrative/undertime/treatment.md,
 * "The crawl on a dome"). Phrases of at most two short lines (about 24 characters, so a line fits the front
 * safe zone at full size), timed to the direction's calm windows: the cooling, the remain beat, the middle
 * of the pull-back, and the signature as the first stars come up. Never during the wave.
 */
import type { CrawlPhrase } from './crawl';
import type { DriftParams } from '../../params/drift';
import { beatStarts } from './timeline';

export function undertimeCrawl(p: DriftParams): CrawlPhrase[] {
  const { starts } = beatStarts(p);
  return [
    { lines: ['Before there was a before,'], at: starts.cool + 3 },
    { lines: ['matter and antimatter', 'arose, and cancelled.'], at: starts.cool + 9 },
    { lines: ['For every billion lost,', 'one grain remained.'], at: starts.remain + 3 },
    { lines: ['Everything we know', 'is made of what remained.'], at: starts.zoom + 6 },
    { lines: ['the Drift'], at: starts.gather + 4, signature: true },
  ];
}
