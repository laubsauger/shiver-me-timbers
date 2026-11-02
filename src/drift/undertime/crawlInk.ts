/**
 * THE COPY'S PEN ON THE LETTERS' OWN STROKES: where the survivor's light is inside each body glyph as it writes it,
 * and how much of the glyph it has written.
 *
 * The 2026-11-02 review: the light that writes the copy (crawl.ts bodyPen) ran along the middle of the line, and each
 * glyph came up under it in a soft left-to-right wipe — so the light "follows the line's centre, not the letters'
 * strokes, so it looks fake", next to a title ("the Drift", ../titleInk.ts) that is written along its own strokes. The
 * client's note of 2026-10-31 asked for copy that looks "less stiff" too. So the body glyphs are now written as the
 * title is: each glyph's own pen path, baked offline from the face at the crawl's weight
 * (scripts/drift-copy-strokes.py → copyStrokes.json: per glyph, its strokes in writing order as polylines in em of the
 * glyph's own frame, with the ink's half-width at every point), reveals the filled glyph through a mask that runs along
 * it, and the light rides the pen point.
 *
 * TIME stays the crawl's: a glyph is written in the slot it already had (crawl.ts glyphInk: its share of the line's
 * width, of the line's writing time), so the phrases, their holds and every line's start and end are unchanged; only
 * what happens inside a slot changed. In it the pen comes in through the air from the last glyph (LIFT_IN of travel),
 * writes the strokes in order, lifting between them (LIFT, as the title's pen does), and the ink its round tip could not
 * reach (flared terminals, the corners of serifs — the bake reports ~0–4 % a glyph) comes up over the last part of the
 * slot (TAIL), so the glyph is whole, exactly the face's glyph, when its slot ends. A glyph with no baked path (a figure,
 * a dash the bake does not have) keeps the soft wipe, and the pen passes over it in the air.
 *
 * Pure (tested in tests/crawlInk.test.ts): `glyphWriting` is the state of one glyph at a fraction q of its slot,
 * `linePen` where the pen is on a line at a time since the phrase began, in the frame of the glyph it is on. Both
 * renderers (the dome's crawl.ts and the 16:9 cut's ../flatTitles.ts) map those glyph-frame points through their own
 * placement of the glyph (`GlyphFrame`), so the dome and the cut write the same strokes at the same moments.
 */
import strokeData from './copyStrokes.json';

/** em of pen travel a lift between two strokes of a glyph costs in time (the title's LIFT is 0.45 em over a word nine
 * glyphs long; a body glyph is ~1 em of strokes, so a lift costs less here or it would eat its slot) */
export const LIFT = 0.12;
/** em of travel the move in from the last glyph costs, at the start of a glyph's slot */
export const LIFT_IN = 0.1;
/** the mask's half-width over the ink's, and em added (as titleInk.ts REACH, REACH_PAD) */
export const REACH = 1.25;
export const REACH_PAD = 0.004;
/** q (fraction of a glyph's slot) from which the ink the round tip does not reach fades up, whole at q = 1 */
export const TAIL = 0.85;

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const smooth = (x: number): number => {
  const k = clamp01(x);
  return k * k * (3 - 2 * k);
};

/** a polyline point: x, y (em from the glyph's origin on its baseline, y down), the ink's half-width (em) */
type Pt = [number, number, number];
interface Baked {
  advance: number;
  strokes: Pt[][];
}
const GLYPHS = (strokeData as unknown as { glyphs: Record<string, Baked> }).glyphs;

interface Prepared {
  strokes: Pt[][];
  /** em, each stroke's segment lengths */
  lens: number[][];
  /** em of pen travel through the whole slot: the move in, the strokes, the lifts between them */
  total: number;
}
const prepared = new Map<string, Prepared | null>();
function prep(ch: string): Prepared | null {
  let p = prepared.get(ch);
  if (p !== undefined) return p;
  const g = GLYPHS[ch];
  if (!g) p = null;
  else {
    const lens = g.strokes.map((s) => s.slice(1).map((q, i) => Math.hypot(q[0] - s[i][0], q[1] - s[i][1])));
    const ink = lens.reduce((a, l) => a + l.reduce((b, x) => b + x, 0), 0);
    p = { strokes: g.strokes, lens, total: LIFT_IN + ink + LIFT * (g.strokes.length - 1) };
  }
  prepared.set(ch, p);
  return p;
}

/** whether glyph `ch` has a baked pen path (else it comes up in the old soft wipe) */
export const hasGlyphPath = (ch: string): boolean => prep(ch) !== null;
/** em, the baked advance of `ch` (the face's own; the tests check the bake against it) */
export const glyphAdvance = (ch: string): number | null => GLYPHS[ch]?.advance ?? null;

/** a point in glyph `g`'s own frame (em from its origin on the baseline, y down) */
export interface PenPoint {
  g: number;
  x: number;
  y: number;
}

/** one glyph at fraction q of its slot */
export interface GlyphWriting {
  /** the mask so far: segments x0, y0, x1, y1 and the ink's half-width (em, the glyph's frame) */
  segments: Array<[number, number, number, number, number]>;
  /** the pen: moving from a to b (k 0..1 of the way; a = b while it writes), on the paper or in the air; `entering`
   * while it is still coming in from the last glyph (a = b = the first stroke's start: the caller knows where from) */
  pen: { ax: number; ay: number; bx: number; by: number; k: number; down: boolean; entering: boolean };
  /** 0..1, how far up the ink the mask does not reach is */
  tail: number;
}

/** glyph `ch` written to fraction q (0..1) of its slot (pure); null if it has no baked path */
export function glyphWriting(ch: string, q: number): GlyphWriting | null {
  const p = prep(ch);
  if (!p) return null;
  const qq = clamp01(q);
  let left = qq * p.total;
  const first = p.strokes[0][0];
  const segments: GlyphWriting['segments'] = [];
  const at = (x: number, y: number) => ({ ax: x, ay: y, bx: x, by: y, k: 1 });
  let pen: GlyphWriting['pen'] = { ...at(first[0], first[1]), down: false, entering: true };
  left -= LIFT_IN;
  for (let s = 0; s < p.strokes.length && left > 0; s++) {
    const st = p.strokes[s];
    const lens = p.lens[s];
    const strokeLen = lens.reduce((a, b) => a + b, 0);
    if (strokeLen === 0) segments.push([st[0][0], st[0][1], st[0][0], st[0][1], st[0][2]]); // a dot: one touch
    for (let i = 0; i < lens.length && left > 0; i++) {
      const a = st[i];
      const b = st[i + 1];
      const f = Math.min(1, left / Math.max(1e-9, lens[i]));
      const x = a[0] + (b[0] - a[0]) * f;
      const y = a[1] + (b[1] - a[1]) * f;
      segments.push([a[0], a[1], x, y, Math.max(a[2], a[2] + (b[2] - a[2]) * f)]);
      pen = { ...at(x, y), down: true, entering: false };
      left -= lens[i];
    }
    if (strokeLen === 0 && left > 0) pen = { ...at(st[0][0], st[0][1]), down: true, entering: false };
    if (left > 0 && s + 1 < p.strokes.length) {
      // lifted: through the air to the next stroke's start
      const end = st[st.length - 1];
      const next = p.strokes[s + 1][0];
      const k = Math.min(1, left / LIFT);
      if (k < 1) pen = { ax: end[0], ay: end[1], bx: next[0], by: next[1], k, down: false, entering: false };
      left -= LIFT;
    }
  }
  return { segments, pen, tail: smooth((qq - TAIL) / (1 - TAIL)) };
}

/** the first stroke's start and the last stroke's end of glyph `ch`, em in its frame */
export function glyphEnds(ch: string): { first: [number, number]; last: [number, number] } | null {
  const p = prep(ch);
  if (!p) return null;
  const s = p.strokes;
  const last = s[s.length - 1][s[s.length - 1].length - 1];
  return { first: [s[0][0][0], s[0][0][1]], last: [last[0], last[1]] };
}

/** a glyph's share of its line, as crawl.ts glyphInk takes it: fractions [f0, f1] of the line's width */
export interface LineGlyph {
  ch: string;
  f0: number;
  f1: number;
}

/** the pen on a line: from a to b, k of the way (a = b while it writes), on the paper or in the air */
export interface LinePen {
  a: PenPoint;
  b: PenPoint;
  k: number;
  down: boolean;
}

/** where the line's writing begins (the first baked glyph's first stroke) and ends (the last one's last), or null */
export function lineEnds(glyphs: readonly LineGlyph[]): { first: PenPoint; last: PenPoint } | null {
  let first: PenPoint | null = null;
  let last: PenPoint | null = null;
  glyphs.forEach((gl, g) => {
    const e = glyphEnds(gl.ch);
    if (!e) return;
    if (!first) first = { g, x: e.first[0], y: e.first[1] };
    last = { g, x: e.last[0], y: e.last[1] };
  });
  return first && last ? { first, last } : null;
}

/**
 * The pen on a line `since` s after its phrase began, the line written from `start` over `dur` s (crawl.ts bodyPen's
 * starts and durs), its glyphs' shares `glyphs` (pure). Null if no glyph of the line has a path (it is written by the
 * old pen along the line's middle). Before its first glyph's slot the pen waits at the first stroke's start, after the
 * last at the last one's end; across a space, or a glyph with no path, and in the move in at a glyph's start, it is in
 * the air from where the last glyph ended to where the next begins.
 */
export function linePen(since: number, start: number, dur: number, glyphs: readonly LineGlyph[]): LinePen | null {
  const ends = lineEnds(glyphs);
  if (!ends) return null;
  const t0 = (gl: LineGlyph): number => start + dur * gl.f0;
  const t1 = (gl: LineGlyph): number => start + dur * gl.f1;
  if (since < t0(glyphs[ends.first.g])) return { a: ends.first, b: ends.first, k: 1, down: false };
  if (since >= t1(glyphs[ends.last.g])) return { a: ends.last, b: ends.last, k: 1, down: false };
  // the glyph whose slot holds `since` (the last one that has begun: slots touch, a tracking's width apart)
  let g = 0;
  for (let i = 0; i < glyphs.length; i++) if (t0(glyphs[i]) <= since) g = i;
  const q = (since - t0(glyphs[g])) / Math.max(1e-9, t1(glyphs[g]) - t0(glyphs[g]));
  const w = q < 1 ? glyphWriting(glyphs[g].ch, q) : null;
  if (w && !w.pen.entering) {
    return { a: { g, x: w.pen.ax, y: w.pen.ay }, b: { g, x: w.pen.bx, y: w.pen.by }, k: w.pen.k, down: w.pen.down };
  }
  // in the air: from the last glyph that has a path and is done (this one, in the tracking's gap after its slot) to the
  // next one that has a path (this one, while the pen comes in to it)
  let p = -1;
  for (let i = 0; i < (q >= 1 ? g + 1 : g); i++) if (hasGlyphPath(glyphs[i].ch)) p = i;
  let n = -1;
  for (let i = q >= 1 ? g + 1 : g; i < glyphs.length && n < 0; i++) if (hasGlyphPath(glyphs[i].ch)) n = i;
  if (p < 0 || n < 0) return { a: ends.first, b: ends.first, k: 1, down: false }; // (not reached: the guards above)
  const pe = glyphEnds(glyphs[p].ch)!.last;
  const ns = glyphEnds(glyphs[n].ch)!.first;
  const from = t1(glyphs[p]);
  const to = t0(glyphs[n]) + (LIFT_IN / prep(glyphs[n].ch)!.total) * (t1(glyphs[n]) - t0(glyphs[n]));
  return { a: { g: p, x: pe[0], y: pe[1] }, b: { g: n, x: ns[0], y: ns[1] }, k: clamp01((since - from) / Math.max(1e-9, to - from)), down: false };
}

/**
 * Where a renderer has put a glyph: its centre (x, y, canvas px) and turn (rad, the canvas's rotate()), as it calls
 * fillText with textAlign 'center' and textBaseline 'middle'; `ox`, `oy` the glyph's origin (its advance's left end on
 * the baseline) from there in px, `px` its em.
 */
export interface GlyphFrame {
  x: number;
  y: number;
  angle: number;
  ox: number;
  oy: number;
  px: number;
}

/** canvas px of the point (gx, gy) em in a glyph's frame */
export function framePoint(f: GlyphFrame, gx: number, gy: number): [number, number] {
  const lx = f.ox + gx * f.px;
  const ly = f.oy + gy * f.px;
  const c = Math.cos(f.angle);
  const s = Math.sin(f.angle);
  return [f.x + lx * c - ly * s, f.y + lx * s + ly * c];
}
