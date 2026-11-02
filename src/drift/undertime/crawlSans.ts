/**
 * TYPE VARIANT B: the copy in a clean, airy sans; "the Drift" stays the script, as its signature.
 *
 * The client's note of 2026-10-31, on the Garamond copy written on by the survivor's pen: "copy type. or at least a
 * suggestion that looks less stiff … Perhaps try one with the script just as the drift signature and a clean airy
 * helvetica or arial style for the main type jus to se how that looks too (but with this 'signature')". So this is a
 * second look, BEHIND A PAGE PARAM AND OFF BY DEFAULT: `drift.html?type=sans` (every review script and drift-render.mjs
 * pass it with `--query type=sans`). Without it nothing here runs and the film draws exactly as before. The copy's
 * text, its phrases, their slots and durations, where they sit and how they sink are all the crawl's own
 * (crawl.ts phrasePlacement, crawlText.ts); only the face and the way each glyph appears and leaves change. The title
 * (Act 1's signature at the end of the zoom, and the end title over W6) is the same Pinyon Script logo, written on along
 * its strokes as now (../titleInk.ts).
 *
 * THE FACE: Inter Light (300), SIL OFL 1.1, from the Inter Project (public/drift/fonts/Inter-Light.ttf, its OFL beside
 * it). Inter is drawn in the Helvetica/Arial spirit — a neo-grotesque with open apertures — but made for screens, so its
 * light weights keep their stems at small sizes where Helvetica Light's close up. The weight, measured against what the
 * dome does to a stroke: the crawl's canvas is 2048 px whatever the master's size, and a body em there is
 * crawlSize × SANS.em × 2048 ≈ 62 px as a phrase appears (53 px when it has sunk and shrunk 15 %). Inter v3.019's
 * stems, measured on its "l" (2816 units an em): Regular 0.084 em, Light 0.063, ExtraLight 0.043, Thin 0.023 — in
 * the canvas 3.4–3.9 px in Light, 2.3–2.7 px in ExtraLight, 1.2–1.4 px in Thin. The canvas is magnified 2× into a
 * 4096² master and resampled again by the seat views and the projectors, and the copy's dark halo (shadowBlur 0.5 em)
 * darkens round a stroke from both sides, so a stroke of two canvas pixels or less is one the dome softens into a
 * grey, broken line: Thin is far under that, ExtraLight on its edge (and under it on the diagonals of "v", "w", "y",
 * which run thinner than the stems), Light a pixel and more clear of it at its smallest. Light is still "airy" against
 * the Garamond at 560 — it is the tracking and the open counters that carry the air, not a hairline. Checked at 1:1
 * in a 4096² master (out/drift/review/type_sans_1102/).
 *
 * THE SIZE: Inter's x-height is 0.545 em, EB Garamond's 0.40, so at the Garamond's em the sans would stand 36 % taller
 * in its lowercase and run far wider. SANS.em = 0.8 of the crawl's em brings the x-height to 0.8 × 0.545 = 0.436 of
 * it: 0.436 × crawlSize × 180° ≈ 3.0° on the dome as a phrase appears, the fulldome legibility floor
 * (drift-narrative/undertime/direction.md: an x-height of 3° or more), a shade above the Garamond's 2.7°. THE TRACKING:
 * 0.08 em, generous (Inter's own spacing is set for text; at display size and in light weight it wants air between
 * the letters, and the dome's softening closes up what the canvas leaves). The longest line, "is made of what
 * remained.", is then ~1.5 rad of arc at the crawl's 37°, inside maxArc (1.6 rad); a longer line is shrunk to fit, as
 * every line is.
 *
 * THE REVEAL ("less stiff"): no pen — a pen writing a sans reads as a plotter, not a hand. Each glyph instead ARRIVES:
 * out of a soft blur (SANS.blur em, its standard deviation) to sharp, rising to full opacity as it comes, and settling
 * a small distance into its place from above and behind (SANS.drift: the way the phrase itself then sinks and reads, so
 * it comes in with the flow and never against it). The glyphs go in reading order, a little apart (SANS.perChar), with
 * a breath between words (SANS.perWord) and a few hundredths of a second of fixed, per-glyph irregularity (SANS.jitter:
 * a hash of the line and the glyph's index, so it is the same in every frame and every lane), each line beginning
 * while the one above it is still coming in (SANS.betweenLines). Every ease is an ease-OUT or a smoothstep: nothing
 * overshoots its place, nothing bounces, nothing snaps. It FADES OUT THE SAME WAY, mirrored: in the phrase's last
 * FADE_OUT s each glyph, again in reading order, softens back into a blur, carries on a little the way it came (down
 * and on, with the phrase's sink) and fades, the last one gone exactly when the phrase's life ends — so the slots are
 * the crawl's to the hundredth.
 *
 * Every glyph is a pure function of the time since its phrase began (`sansGlyph`, tested in tests/crawlSans.test.ts),
 * so each frame is a pure function of show time t. Shared by the dome's crawl (crawl.ts) and the 16:9 titles
 * (../flatTitles.ts), which draw the same glyph state: the same look on the dome and in the cut.
 */

/** the copy's look, variant A (EB Garamond Italic written on by the pen) or B (Inter Light, arriving) */
export type TitleType = 'script' | 'sans';

/**
 * which look this page draws: `?type=sans` for B, anything else (or no `type`) for the film as it was. Read once per
 * page from its query (a constant through the show, never a function of time); `search` for the tests.
 */
export function titleType(search: string = typeof location === 'undefined' ? '' : location.search): TitleType {
  return new URLSearchParams(search).get('type') === 'sans' ? 'sans' : 'script';
}

export const SANS = {
  /** CSS font with {px} (Inter, loaded before the first frame: ../titleFonts.ts; the fallbacks only name the spirit) */
  font: '300 {px}px "Inter", "Helvetica Neue", Arial, sans-serif',
  /** × the crawl's em: Inter's x-height (0.545 em) at ~3.0° on the dome (header: THE SIZE) */
  em: 0.8,
  /** em of tracking between glyphs (header: THE TRACKING) */
  tracking: 0.08,
  /** s from the phrase's start to its first glyph's start (the field's pocket has begun to clear: crawl.ts) */
  start: 0.1,
  /** s a glyph takes to arrive: blur to sharp, transparent to whole, settled into its place */
  arrive: 0.9,
  /** s between one glyph's start and the next's, along a line */
  perChar: 0.025,
  /** s more at each word: the eye reads in words, and a small breath between them keeps the run from a typewriter's */
  perWord: 0.08,
  /** s between one line's first glyph and the next line's (they overlap: a cascade, not a queue) */
  betweenLines: 0.35,
  /** s, ± the fixed irregularity of a glyph's start (a hash of its place, not noise in time) */
  jitter: 0.04,
  /** s over which the leaving runs across a line, first glyph to last; each glyph's own leaving takes the rest of
   * the phrase's FADE_OUT, so the last is gone exactly at the phrase's end */
  leaveSweep: 0.45,
  /** em, the blur's standard deviation as a glyph arrives (and as it is gone) */
  blur: 0.09,
  /** em a glyph drifts into its place from: along the line (−: from behind) and across it (−: from above) */
  drift: [-0.1, -0.08] as const,
} as const;

/** the copy's cool white, as the Garamond's (crawl.ts BODY_RGB) */
const SANS_RGB = '236,239,246';

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const smooth = (x: number): number => {
  const k = clamp01(x);
  return k * k * (3 - 2 * k);
};
/** ease-out, cubic: quick at first, settling with no overshoot */
const easeOut = (x: number): number => 1 - (1 - clamp01(x)) ** 3;

/** a fixed −1..1 for glyph k of line j (a 32-bit integer hash: the same in every frame, lane and machine) */
function hash(j: number, k: number): number {
  let h = Math.imul(j + 1, 0x9e3779b1) ^ Math.imul(k + 7, 0x85ebca77);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

/** the word each character of `text` belongs to (0, 1, …; a space belongs to the word before it) */
export function sansWords(text: string): number[] {
  let w = 0;
  let inSpace = false;
  return [...text].map((ch) => {
    const space = ch.trim() === '';
    if (!space && inSpace) w++;
    inSpace = space;
    return w;
  });
}

/** s after its phrase began that glyph k (word `word`) of line j starts to arrive */
export function sansStart(j: number, k: number, word: number): number {
  return SANS.start + j * SANS.betweenLines + k * SANS.perChar + word * SANS.perWord + SANS.jitter * hash(j, k);
}

/** one glyph's state: opacity 0..1, blur (em, standard deviation), offset from its place (em: along, across the line) */
export interface SansGlyph {
  alpha: number;
  blur: number;
  dx: number;
  dy: number;
}

/**
 * Glyph k (word `word`, at fraction `f` 0..1 of its line's width) of line j, `since` s after its phrase began, the
 * phrase on the dome for `life` s and leaving over its last `fadeOut` s (crawl.ts FADE_OUT). Pure.
 */
export function sansGlyph(since: number, life: number, fadeOut: number, j: number, k: number, word: number, f: number): SansGlyph {
  // arriving: opacity a little ahead of the sharpening, so a glyph is legible before it has quite settled
  const a = (since - sansStart(j, k, word)) / SANS.arrive;
  const inA = smooth(a / 0.8);
  const inK = easeOut(a);
  const inB = (1 - clamp01(a)) ** 2;
  // leaving, mirrored, in reading order; each glyph's own leaving fills the rest of the fade-out
  const leaveDur = Math.max(1e-3, fadeOut - SANS.leaveSweep);
  const l = (since - (life - fadeOut + f * SANS.leaveSweep)) / leaveDur;
  const outA = 1 - smooth(l);
  const outK = clamp01(l) ** 2;
  const outB = clamp01(l) ** 2;
  return {
    alpha: inA * outA,
    blur: SANS.blur * Math.max(inB, outB),
    // in from behind and above (1 − inK of the drift), out the same way on (outK of it past the place)
    dx: SANS.drift[0] * (1 - inK) - SANS.drift[0] * outK,
    dy: SANS.drift[1] * (1 - inK) - SANS.drift[1] * outK,
  };
}

/**
 * One sans glyph, centred at the origin of a frame whose x runs along the line and whose y points away from the
 * zenith (down the frame), in its state `g`, `alpha` the phrase's opacity on top. The copy's soft dark halo stays
 * behind it as behind the Garamond (crawl.ts inkGlyph), and blurs with it; the blur is the canvas's own filter (a
 * Gaussian of that standard deviation), so it is the glyph that is soft, not a second copy of it.
 */
export function sansGlyphPaint(ctx: CanvasRenderingContext2D, ch: string, px: number, g: SansGlyph, alpha: number): void {
  const a = g.alpha * alpha;
  if (a <= 0.002) return;
  ctx.save();
  // (the tracking is in the glyph's placement already: none on the one glyph drawn here, which would push it off
  // centre by half of it)
  ctx.letterSpacing = '0px';
  const blur = g.blur * px;
  if (blur > 0.25) ctx.filter = `blur(${blur.toFixed(2)}px)`;
  ctx.translate(g.dx * px, g.dy * px);
  ctx.shadowColor = `rgba(0,0,0,${0.85 * a})`;
  ctx.shadowBlur = px * 0.5;
  ctx.fillStyle = `rgba(${SANS_RGB},${0.92 * a})`;
  ctx.fillText(ch, 0, 0);
  ctx.restore();
}
