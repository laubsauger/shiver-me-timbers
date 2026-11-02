/**
 * THE TITLES OF THE 16:9 CUT: the crawl and the end title ("the Drift"), composed for the flat frame.
 *
 * On the dome the text lives in MASTER space (undertime/crawl.ts): each line on a circle of constant elevation at
 * 25–40° in front, ~6° tall. The review view (`DomeCapture.setFlat`) used to composite that same layer at the flat
 * frame's own uv, as if it were the master, so the crawl landed on the 16:9 frame's bottom edge cut in half ("Bef…
 * …fore,") and the end title fell below the crop altogether (the QA sweep of 2026-10-30, item 2:
 * out/drift/review/qa_sweep_1030/sheets/pitch_views.png). Re-projecting the dome's text through the flat camera does
 * not fit either: a line spans up to `maxArc` (1.6 rad) of azimuth, ~70° of sky — wider than the 60° frame.
 *
 * So the cut gets its own layer, drawn in the frame's own space and swapped in by the capture while the flat view is
 * on (DomeCapture `flatOverlay`): the same phrases on the same clock (`phrasePlacement`: when each comes, how long it
 * holds, its fade, the sink and the shrink as it is read), the same faces, colours and dark halo, but on gentle
 * arcs centred across the frame (THE ARC below), sized to the frame, kept inside its title-safe area.
 *
 * WHERE: in the lower middle of the frame (first line at FLAT_TOP of the frame's height as it appears), below the
 * centre — where the dome's text sits relative to its action, under it toward the front. At the cut's Act 1 framing
 * (pitch 30, flatFraming.ts) the frame's centre holds the action, Undertime's one warm grain among it (remain, 45–55 s:
 * "For every billion lost, one grain remained." comes at 48 s), and the text would cover it there.
 * HOW BIG: a body em of FLAT_EM of the frame's height (~86 px at 1152; subtitles run ~6 %), the signature SIGNATURE_SCALE× that as
 * on the dome, a line no wider than FLAT_WIDTH of the frame (longer ones drawn smaller, as the dome's `maxArc`).
 * HOW IT MOVES: as on the dome, in ems — a phrase sinks `sink` degrees while read, which is sink / its text height in
 * ems (~0.8), and the signature settles from `elTop` to `holdEl` (~1.2 em). The dome's placement stays the dome's: only
 * these offsets are read from it, and a change to its elevations moves the flat text by the same number of ems, held
 * inside the title-safe area (FLAT_SAFE).
 *
 * THE ARC (the client, 2026-10-31: titles "with gentle curvature parallel to the coming Earth horizon … high to low
 * orbit, grand and sweeping"): on the dome each line already lies on its circle of elevation; here every line — the
 * crawl's and the signature — is set on an arc of radius FLAT_ARC frame widths whose centre lies below it, its middle
 * where the straight line's was and its ends falling away, as a planet's limb arches across a frame. Gentle: a line of
 * 60 % of the frame's width falls ~3.5 % of the frame's height at its ends, its end glyphs turned ~8°. The body is set
 * glyph by glyph along the arc (each placed by the face's own advances, kerning included, and turned to it); the
 * written-on signature, a picture, is bent in thin vertical slices, each turned to the arc at its place.
 *
 * VARIANT B, `?type=sans` (the client's note of 2026-10-31: "a clean airy helvetica or arial style for the main type …
 * (but with this 'signature')"; undertime/crawlSans.ts): the body in Inter Light, each glyph arriving out of a soft
 * blur and leaving the same way, by the same pure function of the time since its phrase began as the dome's crawl, so
 * the cut shows what the dome shows; the signature unchanged. Its em is SANS.em of the body's here as there.
 *
 * The canvas is SQUARE, the master's size: the flat view is drawn square and cut to 16:9 after (scripts/drift-review-
 * clip.mjs), so its uv is the overlay's uv and the text is drawn into the middle 9/16 of the canvas.
 */
import * as THREE from 'three/webgpu';
import { FADE_OUT, LINE_PITCH, PEN, PEN_CORE, baselineBelowMiddle, bodyPen, drawBodyPen, phraseLife, phrasePlacement, writeBodyGlyph, type CrawlLayout, type CrawlPhrase, type InkLine } from './undertime/crawl';
import { SANS, sansGlyph, sansGlyphPaint, sansWords, titleType } from './undertime/crawlSans';
import { InkWord } from './titleInk';

/** the 16:9 frame's height as a fraction of the square frame it is cut from */
export const FLAT_BAND = 9 / 16;
/** fraction of the 16:9 frame's height from its top: the centre of a phrase's first line as it appears */
export const FLAT_TOP = 0.62;
/** a body line's em (font px) as a fraction of the 16:9 frame's height, before the shrink (0.065 in Avenir Next; 15 %
 * more in EB Garamond Italic, whose x-height is 12 % smaller: a shade larger letters, as the dome's crawlSize) */
export const FLAT_EM = 0.075;
/** the widest a line may be, as a fraction of the frame's width */
export const FLAT_WIDTH = 0.8;
/** title-safe: every line's centre stays this far (fraction of the height) plus half its em inside the frame's edges */
export const FLAT_SAFE = 0.1;
/** the radius of every line's arc, in frame widths (its centre below the line: THE ARC above) */
export const FLAT_ARC = 2.2;
/** px of the square canvas: the width of the slices the signature is bent in */
const ARC_SLICE = 2;
/**
 * px of the square canvas: the core of the pen's light here (crawl.ts drawPen), 1.6× the dome's. The canvas is cut to a
 * 1280 frame at 0.625×, so the dome's 2 px core was ~1.25 px there, "barely visible at 1280" (the 2026-11-02 review);
 * 3.2 px is 2 px of the cut, a point still (the dome's core is 4 px of a 4096 master, about 2.6 % of a body em, and this
 * is about 3.7 % of the cut's em: a shade bolder against the text, for a frame seen at its own size, not round a dome)
 */
export const FLAT_PEN_CORE = PEN_CORE * 1.6;

/** a point `s` px along a line's arc from its middle (mx, my): where it lies and how far it is turned (rad, clockwise) */
export function arcPoint(s: number, mx: number, my: number, radius: number): { x: number; y: number; angle: number } {
  const a = s / radius;
  return { x: mx + radius * Math.sin(a), y: my + radius * (1 - Math.cos(a)), angle: a };
}

/**
 * The faces, as the dome's crawl draws them (undertime/crawl.ts FONTS; repeated here, not shared, so the flat cut
 * never changes what the dome's text draws)
 */
const FONTS = {
  body: 'italic 560 {px}px "EB Garamond", Georgia, serif',
  bodyTracking: 0.01,
  signature: '400 {px}px "Pinyon Script", cursive',
};

/** one line of a phrase in the 16:9 frame: centre y and em as fractions of its height, opacity */
export interface FlatLine {
  text: string;
  y: number;
  em: number;
  alpha: number;
  signature: boolean;
  /** 0..1, how much of it is written (the signature draws on: titleInk.ts) */
  ink: number;
  /** the body's pen (undertime/crawl.ts bodyPen): s since its phrase began, this line's place in it, and the phrase's
   * lines (null for the signature) */
  pen: { since: number; line: number; lines: string[] } | null;
}

/**
 * The lines on the 16:9 frame at show time t (pure; the canvas draws exactly these). Line widths are the canvas's
 * business (it measures the face), so the em here is before any shrink-to-fit.
 */
export function flatTitleLines(t: number, phrases: readonly CrawlPhrase[], L: CrawlLayout): FlatLine[] {
  const out: FlatLine[] = [];
  /** deg of elevation one body em spans on the dome (crawl.ts textDeg) */
  const emDeg = L.size * 180;
  for (const p of phrases) {
    const at = phrasePlacement(t, p, L);
    if (!at) continue;
    const em = FLAT_EM * (at.size / L.size);
    const top = FLAT_TOP + ((L.elTop - at.el) / emDeg) * FLAT_EM;
    p.lines.forEach((text, j) => {
      const y = top + j * em * LINE_PITCH;
      const lo = FLAT_SAFE + em / 2;
      const hi = 1 - FLAT_SAFE - em / 2;
      out.push({ text, y: Math.min(hi, Math.max(lo, y)), em, alpha: at.alpha, signature: !!p.signature, ink: at.ink, pen: p.signature ? null : { since: t - p.at, line: j, lines: p.lines } });
    });
  }
  return out;
}

export class FlatTitles {
  readonly texture: THREE.CanvasTexture;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly size: number;
  /** what the canvas holds now (`draw` redraws only on a change: the canvas upload is the cost) */
  private drawn = '';
  /** the signature, written on (the dome's crawl has its own) */
  private readonly word = new InkWord();
  /** variant B (undertime/crawlSans.ts, `?type=sans`): the body in the sans, arriving glyph by glyph, no pen */
  private readonly sans = titleType() === 'sans';

  constructor(size = 2048) {
    this.size = size;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('flat titles: 2D canvas unavailable');
    this.ctx = ctx;
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
  }

  /** redraw for show time t, the crawl's phrases and layout as the dome's crawl has them now */
  draw(t: number, phrases: readonly CrawlPhrase[], L: CrawlLayout): void {
    const lines = flatTitleLines(t, phrases, L);
    const key = JSON.stringify(lines);
    if (key === this.drawn) return;
    this.drawn = key;
    const { ctx, size } = this;
    ctx.clearRect(0, 0, size, size);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const h = size * FLAT_BAND;
    const top = (size - h) / 2;
    const radius = FLAT_ARC * size;
    /** each body line of the phrase being written, by line index, as placed here (its glyphs, where fraction f of it is),
     * for the pen; and the pen's phrase */
    const drawn: InkLine[] = [];
    let penLine: FlatLine | null = null;
    for (const line of lines) {
      if (line.signature) {
        // written on in its own canvas (fill, halo, the light on the pen), set centred on the line
        let px = line.em * h;
        const w = this.word.measure(line.text, FONTS.signature.replace('{px}', px.toFixed(1)));
        if (w > FLAT_WIDTH * size) px *= (FLAT_WIDTH * size) / w;
        this.word.render(line.text, FONTS.signature.replace('{px}', px.toFixed(1)), px, line.ink, 'rgb(255,236,206)');
        const img = this.word.canvas;
        ctx.save();
        ctx.globalAlpha = line.alpha;
        // bent onto the arc in thin slices, each turned to it (THE ARC)
        for (let x0 = 0; x0 < img.width; x0 += ARC_SLICE) {
          const sw = Math.min(ARC_SLICE, img.width - x0);
          const at = arcPoint(x0 + sw / 2 - img.width / 2, size / 2, top + line.y * h, radius);
          ctx.setTransform(Math.cos(at.angle), Math.sin(at.angle), -Math.sin(at.angle), Math.cos(at.angle), at.x, at.y);
          // (a hair wider than the slice, so no seam opens between neighbours turned a hair apart)
          ctx.drawImage(img, x0, 0, sw, img.height, -sw / 2 - 0.25, -img.height / 2, sw + 0.5, img.height);
        }
        ctx.restore();
        continue;
      }
      const font = this.sans ? SANS.font : FONTS.body;
      const tracking = this.sans ? SANS.tracking : FONTS.bodyTracking;
      let px = line.em * h * (this.sans ? SANS.em : 1);
      const width = (): number => {
        ctx.font = font.replace('{px}', px.toFixed(1));
        ctx.letterSpacing = `${(tracking * px).toFixed(2)}px`;
        // (letterSpacing adds its space after the last glyph too)
        return ctx.measureText(line.text).width - tracking * px;
      };
      const w = width();
      if (w > FLAT_WIDTH * size) {
        px *= (FLAT_WIDTH * size) / w;
        width();
      }
      // written by the survivor's light, glyph by glyph along each glyph's own strokes (undertime/crawl.ts bodyPen and
      // writeBodyGlyph, undertime/crawlInk.ts; the dome's dark halo behind every glyph, crawl.ts inkGlyph)
      const ink = line.pen && !this.sans ? bodyPen(line.pen.since, line.pen.lines) : null;
      const oy = baselineBelowMiddle(ctx);
      const placed: InkLine['glyphs'] = [];
      const words = this.sans ? sansWords(line.text) : null;
      const life = line.pen ? phraseLife(line.pen.lines) : 0;
      // glyph by glyph along the arc (THE ARC): each at its advance in the whole line (the prefix's width: the face's
      // kerning and the tracking included), centred on the line, turned to the arc at its middle
      const glyphs = Array.from(line.text);
      const total = ctx.measureText(line.text).width - tracking * px;
      let prefix = '';
      for (const [k, g] of glyphs.entries()) {
        const x0 = ctx.measureText(prefix).width;
        prefix += g;
        const gw = ctx.measureText(g).width - tracking * px;
        const at = arcPoint(x0 + gw / 2 - total / 2, size / 2, top + line.y * h, radius);
        // (fillText centres the glyph with its letterSpacing after it: its origin is half of both to the left)
        const frame = { x: at.x, y: at.y, angle: at.angle, ox: -(gw + tracking * px) / 2, oy, px };
        placed.push({ ch: g, f0: x0 / total, f1: (x0 + gw) / total, frame });
        if (g.trim() === '') continue;
        if (words && line.pen) {
          // variant B: the glyph's own arriving or leaving state is its fade (as on the dome: crawl.ts drawSansLine)
          const s = sansGlyph(line.pen.since, life, FADE_OUT, line.pen.line, k, words[k], (x0 + gw / 2) / total);
          if (s.alpha <= 0.002) continue;
          ctx.save();
          ctx.translate(at.x, at.y);
          ctx.rotate(at.angle);
          sansGlyphPaint(ctx, g, px, s, 1);
          ctx.restore();
          continue;
        }
        if (!ink || !line.pen) continue;
        ctx.save();
        ctx.translate(at.x, at.y);
        ctx.rotate(at.angle);
        writeBodyGlyph(ctx, g, px, line.alpha, line.pen.since, ink.starts[line.pen.line], ink.durs[line.pen.line], x0 / total, (x0 + gw) / total, frame);
        ctx.restore();
      }
      if (line.pen) {
        const y = top + line.y * h;
        drawn[line.pen.line] = {
          glyphs: placed,
          at: (f: number): [number, number] => {
            const at = arcPoint((f - 0.5) * total, size / 2, y, radius);
            return [at.x, at.y];
          },
        };
        penLine = line;
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // the pen's light: it comes down from above the text (the act's one place, the grain's spot — PEN.spotEl on the
    // dome, as many ems above the first line here as there), writes, and goes back up
    if (penLine?.pen && !this.sans) {
      const first = lines.find((l) => l.pen && l.pen.lines === penLine?.pen?.lines);
      if (first && drawn[0]) {
        const emPx = first.em * h;
        const spotY = Math.max(top + FLAT_SAFE * h, top + first.y * h - ((PEN.spotEl - L.elTop) / (L.size * 180)) * emPx);
        drawBodyPen(ctx, penLine.pen.since, penLine.pen.lines, drawn, [size / 2, spotY], first.alpha, FLAT_PEN_CORE);
      }
    }
    this.texture.needsUpdate = true;
  }
}
