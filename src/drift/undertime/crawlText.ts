/**
 * PLACEHOLDER text, until Dimi's orders-of-magnitude narration arrives (drift-narrative/undertime/treatment.md,
 * "The crawl on a dome"). Phrases of at most two short lines (about 24 characters, so a line fits the front
 * safe zone at full size), timed to the direction's calm windows: the cooling, the remain beat, the middle
 * of the pull-back, and the signature as the first stars come up. Never during the wave.
 *
 * ON THE MUSIC'S CALM (audioCues.ts calmest; the 2026-11-01 brief: "the text entries on calm moments"): each phrase
 * comes in at the quietest moment of a window about its old fixed time (beat start + 3, + 9, …), so a line arrives as
 * the score breathes rather than over a hit. The windows keep the old rules: one phrase at a time (the second of the
 * cooling waits for the first to leave), and the cooling's last phrase gone before the wave's build begins.
 */
import { phraseHold, type CrawlPhrase } from './crawl';
import type { DriftParams } from '../../params/drift';
import { beatStarts } from './timeline';
import { calmest } from './audioCues';

/** s a body phrase is on the dome: crawl.ts FADE_IN + hold + FADE_OUT */
const life = (lines: string[]): number => 0.9 + phraseHold({ lines, at: 0 }) + 1.1;

export function undertimeCrawl(p: DriftParams): CrawlPhrase[] {
  const { starts } = beatStarts(p);
  const L1 = ['Before there was a before,'];
  const L2 = ['matter and antimatter', 'arose, and cancelled.'];
  const L3 = ['For every billion lost,', 'one grain remained.'];
  const L4 = ['Everything we know', 'is made of what remained.'];
  const a1 = calmest(starts.cool + 2, starts.cool + 4);
  // after the first has gone, and gone itself (with 0.2 s to spare) before the build starts (timeline.ts waveEnvelope)
  const buildFrom = starts.wave - p.waveBuild;
  const a2 = calmest(Math.max(a1 + life(L1) + 0.05, starts.cool + 8), Math.max(a1 + life(L1) + 0.05, Math.min(starts.cool + 10, buildFrom - 0.2 - life(L2))));
  return [
    { lines: L1, at: a1 },
    { lines: L2, at: a2 },
    { lines: L3, at: calmest(starts.remain + 2, starts.remain + 4) },
    { lines: L4, at: calmest(starts.zoom + 5, starts.zoom + 7) },
    { lines: ['the Drift'], at: calmest(starts.gather + 3, starts.gather + 5), signature: true },
  ];
}
