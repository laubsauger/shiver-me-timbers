/**
 * The soundtrack's baked cues (scripts/drift-audio-cues.py → src/drift/undertime/audioCues.json, read through
 * audioCues.ts). The envelope the film breathes with must be ON the music's clock: the 2026-11-02 review of the 665ba98
 * render found the act's swell before the wave 5 s early — the envelope had been sampled every 4th analysis frame
 * (23.4 Hz) and read as 20 Hz, so every envelope time came out 17 % late and the score's boom at 30.75 s read at 36 s.
 * The onsets and peaks carry their own times, measured straight from the file; the envelope must agree with them.
 */
import { describe, expect, it } from 'vitest';
import cues from '../src/drift/undertime/audioCues.json';
import { CUES_END, levelAt } from '../src/drift/undertime/audioCues';

describe('Undertime audio cues', () => {
  it('the level envelope peaks where the measured peaks are (one clock for both)', () => {
    // the five loudest peaks of the act: the envelope's own maximum within ±1.5 s of each sits within 0.1 s of it
    for (const pk of cues.peaks.slice(0, 5)) {
      let best = -1;
      let at = 0;
      for (let t = pk.t - 1.5; t <= pk.t + 1.5; t += 0.01) {
        const v = levelAt(t);
        if (v > best) [best, at] = [v, t];
      }
      expect(Math.abs(at - pk.t)).toBeLessThan(0.1);
    }
  });

  it('covers the analysed span at its stated rate', () => {
    expect(cues.level.length).toBe(Math.round(CUES_END * cues.envelopeRate));
    expect(cues.flux.length).toBe(cues.level.length);
  });

  it('the pulse before the wave is quiet and the drop is loud (what the act times its crescendo on)', () => {
    // 35–38.5 s: the score's ticking pulse, well under its boom at 30.75 s and under the drop's fill from 39.25 s
    let pulse = 0;
    for (let t = 35; t < 38.5; t += 0.05) pulse = Math.max(pulse, levelAt(t));
    expect(pulse).toBeLessThan(0.7 * levelAt(30.75));
    expect(pulse).toBeLessThan(levelAt(39.25));
  });
});
