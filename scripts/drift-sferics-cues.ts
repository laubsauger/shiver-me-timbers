/**
 * THE SFERICS CUE SHEET for the composer: when the distant storm's flashes spit into the radio (src/drift/wandering/
 * stormCell.ts; params distantStorm — the 2026-11-02 next-level review's move 4: "Each flash spits sferics into the
 * dial's static"). The film has no sound layer; the brief to the client and composer asks for a diegetic stem (static,
 * sferics, a tone), and this is where its crackles go. The schedule is the film's own (a pure function of c4's start),
 * so the sheet always matches the picture; run it again whenever stormCell.ts' schedule changes.
 *
 *   node_modules/.bin/vite-node scripts/drift-sferics-cues.ts [--c4 430.0] [--out out/drift/sferics-cues.json]
 *
 * --c4: c4's start in show s (430.0 in the cut of 2026-11-02; `__drift.flatMarks().c4` on a page says it). Times in the
 * sheet are show s (= the soundtrack's, audio offset 0).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CLEAR, LIGHTNING_PEAK, STORM_BEARING, STORM_DIST, lightningAt, pulseShape, stormFlashes } from '../src/drift/wandering/stormCell';
import { CALL } from '../src/drift/wandering/roseTraffic';

const argv = process.argv.slice(2);
const arg = (k: string, d: string): string => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const c4 = Number(arg('c4', '430.0'));
const out = arg('out', 'out/drift/sferics-cues.json');
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

const flashes = stormFlashes(c4);
// the radio's level, frame by frame at 100 Hz, over each flash (every flash whole on the radio: stormCell.ts sfericsAt)
const cues = flashes.map((f, i) => {
  const end = Math.max(...f.pulses.map((p) => p.at + p.decay * Math.log(100)));
  const envelope: number[] = [];
  for (let x = 0; x <= end; x += 0.01) envelope.push(r3(Math.min(1, lightningAt(f.t + x, flashes, true).reduce((s, l) => s + l.light, 0))));
  return {
    n: i + 1,
    /** show s */
    t: r3(f.t),
    /** s */
    length: r3(end),
    /** 0..1: how bright it is to the eye (the flicker's swell); on the radio every flash is whole */
    seen: r3(f.peak),
    /** the strokes: show s each begins, its strength on the radio (0..1), its decay (s) */
    strokes: f.pulses.map((p) => ({ t: r3(f.t + p.at), level: r3(p.amp), decay: r3(p.decay) })),
    /** the radio's level from `t`, every 10 ms */
    envelope,
    /** whether the dial is lit to show it (it glows from c4 − 2 s, props.ts): a stutter in its glow */
    onDial: f.t >= c4 - 2,
  };
});

const sheet = {
  what: 'The Drift, c3–c4: the distant storm\'s flashes as sferics in the radio (params distantStorm, src/drift/wandering/stormCell.ts)',
  note:
    'Times in show s, audio offset 0 (drift_audio.wav). Intracloud flashes in a cell ' +
    `${STORM_DIST / 1000} km off at ${STORM_BEARING}° right of the front, low on the horizon: silent to the ear (thunder carries ~20 km), ` +
    'loud on the radio as clicks and crackles, each a burst of 2–4 strokes. The cell dies away and the radio is clear before ' +
    `the dial wakes at ${r3(c4 + CALL.dial)} s (its crackle peak) and the first call at ${r3(c4 + CALL.first)} s.`,
  c4: c4,
  dialWakes: r3(c4 + CALL.dial),
  cellGone: r3(c4 + CLEAR[1]),
  pulseShape: { rise: 0.025, note: 'each stroke rises over ~25 ms and decays exponentially over its `decay`' },
  lightningPeak: LIGHTNING_PEAK,
  flashes: cues,
};
// (the pulse shape is the film's: a check that the sheet's numbers are the ones drawn)
if (Math.abs(pulseShape(0.025 * Math.log(1 + 0.1 / 0.025), 0.1) - 1) > 1e-9) throw new Error('sferics: pulse shape out of step with stormCell.ts');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(sheet, null, 1) + '\n');
console.log(`sferics: ${cues.length} flashes, ${cues[0].t}–${cues[cues.length - 1].t} s → ${out}`);
for (const c of cues) console.log(`  ${c.n}  ${c.t.toFixed(2)} s  ${c.strokes.length} strokes  seen ${c.seen.toFixed(2)}${c.onDial ? '  (on the dial)' : ''}`);
