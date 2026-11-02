/**
 * Undertime's text — Mark's "Star Wars titles, reversed": type that sinks from mid-heaven toward the
 * front horizon, shrinking as it goes, signed at the end with "the Drift", which settles and holds.
 *
 * PHRASES, NOT A SCROLL. A crawl of lines that all sink reads bottom-up on a dome (the newest line is
 * always on top). So the text comes in PHRASES of one or two lines that enter together and read top to
 * bottom; a phrase sinks a few degrees and shrinks a little while it is read, then fades before the next
 * arrives. Each phrase holds long enough to be read: 1.5 s plus 0.3 s per word.
 *
 * Laid out in DOME-MASTER space, not in the 3D scene: on a dome a line of text that reads as horizontal lies
 * on a circle of constant elevation, and in the master that circle is concentric with the frame. Each glyph
 * sits on that circle, centred on the front (frame bottom), upright toward the zenith, reading left to right
 * for the seated viewer (domeMaster.ts convention). Text stays at 25–40° elevation in front, with an
 * x-height of 3° or more (fulldome legibility guidance: drift-narrative/undertime/direction.md).
 *
 * `phrasePlacement` is pure (tested); `CrawlOverlay` draws it into a canvas texture the dome capture
 * composites over the master.
 *
 * THE TYPE (the client's note of 2026-10-31: the Avenir Next "not good enough", it did not fit the epic mood): the copy
 * in EB Garamond Italic, the title "the Drift" in Pinyon Script, written on along its strokes (../titleInk.ts). Both
 * OFL, served from public/drift/fonts and loaded before the first frame (../titleFonts.ts). The body is set at weight
 * 560, not the face's 400: the dome softens a hairline serif to nothing at an x-height of 3°, and the halo eats into
 * thin strokes too; 500–600 keeps the italic's shape and reads (the user's brief: "not thinner than ~500").
 *
 * VARIANT B, `?type=sans` (the client's note of 2026-10-31 again: "a clean airy helvetica or arial style for the main
 * type … (but with this 'signature')"): the copy in Inter Light, each glyph arriving out of a soft blur and settling
 * into its place instead of being written by the pen, and leaving the same way; the signature unchanged. Off by
 * default; the face, its size and the reveal are ./crawlSans.ts. The phrases, their slots and their placement here are
 * the same in both.
 */
import * as THREE from 'three/webgpu';
import { InkWord, inkProgress } from '../titleInk';
import { SANS, sansGlyph, sansGlyphPaint, sansWords, titleType } from './crawlSans';
import { REACH, REACH_PAD, framePoint, glyphWriting, hasGlyphPath, lineEnds, linePen, type GlyphFrame, type GlyphWriting, type LineGlyph, type PenPoint } from './crawlInk';

export interface CrawlPhrase {
  /** one or two lines, read top to bottom */
  lines: string[];
  /** s, act time it starts to appear */
  at: number;
  /** the signature: display weight, larger, settles at `holdEl` and holds until `end` */
  signature?: boolean;
}

export interface CrawlLayout {
  /** deg, elevation of a phrase's first line as it appears */
  elTop: number;
  /** deg, how far a phrase sinks while it is read */
  sink: number;
  /** deg, where the signature settles */
  holdEl: number;
  /** text height as a fraction of the master's width as a phrase appears (it shrinks 15 % as it sinks) */
  size: number;
  /** s the signature fades out over, ending at `end` */
  fade: number;
  /** s, act time everything is gone */
  end: number;
  /** rad, the widest a line may span in azimuth; longer lines are drawn smaller */
  maxArc: number;
}

export interface Placement {
  /** deg, elevation of the first line */
  el: number;
  /** fraction of master width */
  size: number;
  alpha: number;
  /** 0..1, how much of it is written (the signature draws on: ../titleInk.ts; the body is always 1) */
  ink: number;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const smooth = (x: number): number => {
  const k = clamp01(x);
  return k * k * (3 - 2 * k);
};
/** s a body phrase fades in over, and out over at the end of its life */
export const FADE_IN = 0.9;
export const FADE_OUT = 1.1;
/** line pitch, in text heights */
export const LINE_PITCH = 1.35;
/**
 * the signature's em over the body's: 1.6 in Avenir Next; 2 in Pinyon Script, whose lowercase is small for its em
 * (x-height ~0.2 em) — at 1.6 "the Drift" was a thin, small word from the back rows (a seat view from row 9 of
 * Horizon 18, 2026-10-31: out/drift/review/titles_1031/seat_dome_title_79.5s_row9.png)
 */
export const SIGNATURE_SCALE = 2;

/** s a phrase is fully up: long enough to read it */
export function phraseHold(p: CrawlPhrase): number {
  const words = p.lines.join(' ').split(/\s+/).filter(Boolean).length;
  return 1.5 + 0.3 * words;
}

/** s a body phrase of `lines` is on the dome: its fade-in, its hold, its fade-out */
export function phraseLife(lines: string[]): number {
  return FADE_IN + phraseHold({ lines, at: 0 }) + FADE_OUT;
}

/** where phrase `p` is at act time `t`, or null if it is not on the dome */
export function phrasePlacement(t: number, p: CrawlPhrase, L: CrawlLayout): Placement | null {
  if (t < p.at || t > L.end) return null;
  const hold = phraseHold(p);
  if (p.signature) {
    const k = smooth((t - p.at) / (FADE_IN + hold));
    // no fade-in: the pen writes it out of nothing (its alpha is up from the start, so the field's pocket clears first)
    const alpha = clamp01((L.end - t) / Math.max(1e-6, L.fade));
    return alpha > 0 ? { el: L.elTop + (L.holdEl - L.elTop) * k, size: L.size * SIGNATURE_SCALE, alpha, ink: inkProgress(t - p.at) } : null;
  }
  const life = FADE_IN + hold + FADE_OUT;
  const k = (t - p.at) / life;
  if (k >= 1) return null;
  const alpha = smooth((t - p.at) / FADE_IN) * smooth((p.at + life - t) / FADE_OUT);
  return alpha > 0 ? { el: L.elTop - L.sink * k, size: L.size * (1 - 0.15 * k), alpha, ink: 1 } : null;
}

/**
 * THE COPY WRITTEN BY THE SURVIVOR'S LIGHT (the 2026-11-01 brief: "the one surviving grain's light writes the copy
 * (the crawl lines) line by line, like the title's pen reveal … the text must stay readable"). The act's one place
 * (direction.md: the first light, the matter that gets away, the grain that remains — the same spot, in front at 52°)
 * sends a point of warm light down to each phrase: it descends to the first line's start, writes the line left to right
 * — each glyph coming up under it in a soft wipe, amber-hot as it is written, cooling to the copy's white in about half
 * a second — crosses to the next line, and when the phrase is written rises back to the spot and goes out. Before the
 * wave that spot is where the first light was; after it, the grain itself sits there.
 *
 * The body is the same face, weight and size; only its appearing changed. The pen is fast — 28 characters a second,
 * quicker than anyone reads — so the reading follows the light rather than waiting for it, and every phrase is whole
 * ~2 s after it begins (its hold, 1.5 s + 0.3 s a word, counts from its fade-in as before). Pure in the time since
 * the phrase began (tested), as the title's pen is (../titleInk.ts).
 *
 * ON THE LETTERS' OWN STROKES (the 2026-11-02 review: the light "follows the line's centre, not the letters' strokes,
 * so it looks fake"; the client's note of 2026-10-31: "less stiff"): while it writes a line the light no longer runs
 * along the line's middle over a soft wipe. In each glyph's slot (glyphInk's, unchanged) it runs that glyph's baked
 * strokes in writing order and the glyph comes up under it through a stroke mask, as the title does (./crawlInk.ts,
 * scripts/drift-copy-strokes.py); between strokes and glyphs it lifts, dimmed to PEN.air. At this pace a glyph's
 * slot is ~35 ms, about a frame at 30 fps, so the light also leaves a short STREAK along the way it came over the last
 * PEN.trail s — what a camera's open shutter would see of a point of light moving that fast — which is what draws the
 * letter's shape at the pen; without it the point would hop a glyph a frame. The arc down from the spot, the crossing
 * between lines and the rise back are as they were, ending and starting on the strokes.
 */
export const PEN = {
  /** s the light takes from the spot down to the first line's start */
  descend: 0.3,
  /** s a character takes to write, and the least a line takes */
  perChar: 0.035,
  minLine: 0.3,
  /** s it takes to cross from one line's end to the next one's start */
  between: 0.15,
  /** s it takes to rise back to the spot, going out */
  back: 0.45,
  /** s a glyph's wipe softens over, beyond its own width */
  soft: 0.12,
  /** s e-fold a written glyph cools over, amber to the copy's white */
  cool: 0.5,
  /** deg, the spot's dome elevation (timeline.ts heroGrainPosition: heroGrainEl, straight ahead) */
  spotEl: 52,
  /** the light's strength while lifted, between strokes and between glyphs (a point of light that went out at every
   * lift would flicker 28 times a second; the title's pen, slower, does go out) */
  air: 0.4,
  /** s of the way it came the streak shows: half a frame at 30 fps (a 180° shutter) */
  trail: 1 / 60,
  /** samples along the streak: near enough that the points merge into a line at the pen's speed (~2.5k canvas px/s
   * on the dome's 2048 canvas while it writes: 24 over 1/60 s ≈ 1.8 px apart, inside the core's 2.2 px width) */
  trailSamples: 24,
} as const;

/** where the pen is: on line `line` (−1: the spot) at fraction `f` of its width */
export interface PenAt {
  line: number;
  f: number;
}

/** the pen `since` s after the phrase began: moving from `from` to `to` (k 0..1 of the way), its light 0..1; null when
 * not on the dome. `starts`, `durs`: s after the phrase began that each line's writing starts, and how long it takes */
export function bodyPen(since: number, lines: readonly string[]): { starts: number[]; durs: number[]; pen: { from: PenAt; to: PenAt; k: number; glow: number } | null } {
  const starts: number[] = [];
  const durs: number[] = [];
  let a = PEN.descend;
  for (const line of lines) {
    const d = Math.max(PEN.minLine, PEN.perChar * [...line].length);
    starts.push(a);
    durs.push(d);
    a += d + PEN.between;
  }
  const last = lines.length - 1;
  const end = starts[last] + durs[last];
  let pen: { from: PenAt; to: PenAt; k: number; glow: number } | null = null;
  if (since >= 0 && since < PEN.descend) pen = { from: { line: -1, f: 0 }, to: { line: 0, f: 0 }, k: smooth(since / PEN.descend), glow: smooth(since / 0.15) };
  else if (since >= end && since < end + PEN.back) {
    const k = (since - end) / PEN.back;
    pen = { from: { line: last, f: 1 }, to: { line: -1, f: 0 }, k: smooth(k), glow: 1 - smooth(k) };
  } else {
    for (let j = 0; j <= last; j++) {
      if (since >= starts[j] && since < starts[j] + durs[j]) pen = { from: { line: j, f: (since - starts[j]) / durs[j] }, to: { line: j, f: (since - starts[j]) / durs[j] }, k: 1, glow: 1 };
      else if (j < last && since >= starts[j] + durs[j] && since < starts[j + 1]) pen = { from: { line: j, f: 1 }, to: { line: j + 1, f: 0 }, k: smooth((since - starts[j] - durs[j]) / PEN.between), glow: 0.85 };
    }
  }
  return { starts, durs, pen };
}

/** a glyph spanning fractions [f0, f1] of its line's width, `since` s after the phrase began: its opacity (0..1) and its
 * warmth (1 being written, cooling after) */
export function glyphInk(since: number, start: number, dur: number, f0: number, f1: number): { alpha: number; warm: number } {
  const t0 = start + dur * f0;
  const t1 = start + dur * f1;
  const alpha = smooth((since - t0) / Math.max(1e-3, t1 - t0 + PEN.soft));
  const warm = since < t0 ? 0 : since < t1 ? 1 : Math.exp(-(since - t1) / PEN.cool);
  return { alpha, warm };
}

/** deg of elevation one text height spans (the master's width covers 180° across its diameter) */
const textDeg = (size: number): number => size * 180;

/**
 * The sky the text occupies at act time t: elevation band (deg) spanning every visible line plus a margin of
 * about one text height, and how present the text is (max alpha). Drives the field's text pocket.
 */
export function crawlBand(t: number, phrases: readonly CrawlPhrase[], L: CrawlLayout): { lo: number; hi: number; strength: number } {
  let lo = Infinity;
  let hi = -Infinity;
  let strength = 0;
  for (const p of phrases) {
    const at = phrasePlacement(t, p, L);
    if (!at) continue;
    const h = textDeg(at.size);
    const last = at.el - (p.lines.length - 1) * h * LINE_PITCH;
    lo = Math.min(lo, last - h * 1.2 - 3);
    hi = Math.max(hi, at.el + h * 1.2 + 3);
    strength = Math.max(strength, at.alpha);
  }
  return strength > 0 ? { lo, hi, strength } : { lo: 0, hi: 0, strength: 0 };
}

export interface CrawlFonts {
  /** CSS font with {px}; tracking in em */
  body: string;
  bodyTracking: number;
  signature: string;
  signatureTracking: number;
}

export const FONTS: CrawlFonts = {
  body: 'italic 560 {px}px "EB Garamond", Georgia, serif',
  bodyTracking: 0.01,
  // (a script's letters join: no tracking, and the baked pen path is for the word as the face sets it)
  signature: '400 {px}px "Pinyon Script", cursive',
  signatureTracking: 0,
};

/** the signature's colour, warm; the body's is a cool white */
const SIGNATURE_RGB = '255,236,206';

export class CrawlOverlay {
  readonly texture: THREE.CanvasTexture;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly size: number;
  /** the signature, written on, before it is bent onto its circle */
  private readonly word = new InkWord();
  /** variant B (./crawlSans.ts, `?type=sans`): the copy in the sans, arriving glyph by glyph, no pen */
  private readonly sans = titleType() === 'sans';

  constructor(
    /** replaceable: the phrase times follow the beat lengths, which are live tunables */
    public phrases: readonly CrawlPhrase[],
    readonly layout: CrawlLayout,
    size = 2048,
    private readonly fonts: CrawlFonts = FONTS,
  ) {
    this.size = size;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('crawl: 2D canvas unavailable');
    this.ctx = ctx;
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
  }

  /** redraw for act time `t` (cheap: a handful of lines, glyph by glyph) */
  draw(t: number): void {
    const { ctx, size } = this;
    ctx.clearRect(0, 0, size, size);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const p of this.phrases) {
      const at = phrasePlacement(t, p, this.layout);
      if (!at) continue;
      const since = t - p.at;
      const ink = p.signature || this.sans ? null : bodyPen(since, p.lines);
      const drawn: InkLine[] = [];
      const life = phraseLife(p.lines);
      p.lines.forEach((line, j) => {
        const el = at.el - j * textDeg(at.size) * LINE_PITCH;
        if (p.signature) this.drawSignature(line, el, at.size, at.alpha, at.ink);
        else if (ink) drawn.push(this.drawLine(line, el, at.size, at.alpha, since, ink.starts[j], ink.durs[j]));
        else this.drawSansLine(line, el, at.size, since, life, j);
      });
      if (ink) {
        const c = size / 2;
        drawBodyPen(ctx, since, p.lines, drawn, [c, c + ((90 - PEN.spotEl) / 90) * c], at.alpha);
      }
    }
    this.texture.needsUpdate = true;
  }

  /**
   * The signature: written on in a canvas of its own (InkWord: the fill, the halo, the light on the pen), then bent onto
   * its circle of elevation in strips two pixels wide, each turned upright toward the zenith as the body's glyphs are.
   * (Glyph by glyph, as the body is drawn, would break a script's joins and could not follow a pen across them.)
   */
  private drawSignature(text: string, el: number, sizeFrac: number, alpha: number, ink: number): void {
    const { ctx, size } = this;
    const c = size / 2;
    const R = ((90 - el) / 90) * c;
    let px = sizeFrac * size;
    const font = (): string => this.fonts.signature.replace('{px}', px.toFixed(1));
    const w = this.word.measure(text, font());
    if (w / R > this.layout.maxArc) px *= (this.layout.maxArc * R) / w;
    this.word.render(text, font(), px, ink, `rgb(${SIGNATURE_RGB})`);
    const img = this.word.canvas;
    const W = img.width;
    const H = img.height;
    /** px of the word per strip */
    const STRIP = 2;
    ctx.save();
    ctx.globalAlpha = alpha;
    for (let x = 0; x < W; x += STRIP) {
      const sw = Math.min(STRIP, W - x);
      const mid = (x + sw / 2 - W / 2) / R;
      ctx.setTransform(1, 0, 0, 1, c + R * Math.sin(mid), c + R * Math.cos(mid));
      ctx.rotate(-mid);
      // (0.4 px wider than the strip: below the line the circle is longer than the word, and the strips would part —
      // by 0.2 px at the f's descender; wider still would smear the letters above the line, where they crowd)
      ctx.drawImage(img, x, 0, sw, H, -sw / 2, -H / 2, sw + 0.4, H);
    }
    ctx.restore();
  }

  /**
   * a body line in variant B (./crawlSans.ts): the sans, tracked, each glyph on its circle as `drawLine` sets the
   * Garamond's, in its own arriving or leaving state. The phrase's own fade (phrasePlacement's alpha) is not applied on
   * top: the glyphs' arriving and leaving ARE the fade, over the same seconds, and multiplying the two would hold the
   * first glyphs back in a dimness the reveal did not mean.
   */
  private drawSansLine(text: string, el: number, sizeFrac: number, since: number, life: number, j: number): void {
    const { ctx, size } = this;
    const c = size / 2;
    const R = ((90 - el) / 90) * c;
    let px = sizeFrac * size * SANS.em;
    const measure = (): { chars: string[]; widths: number[]; total: number } => {
      ctx.font = SANS.font.replace('{px}', px.toFixed(1));
      ctx.letterSpacing = '0px';
      const chars = [...text];
      const widths = chars.map((ch) => ctx.measureText(ch).width + SANS.tracking * px);
      return { chars, widths, total: widths.reduce((a, b) => a + b, 0) - SANS.tracking * px };
    };
    let m = measure();
    if (m.total / R > this.layout.maxArc) {
      px *= (this.layout.maxArc * R) / m.total;
      m = measure();
    }
    const words = sansWords(text);
    let az = -m.total / 2 / R;
    let run = 0;
    m.chars.forEach((ch, k) => {
      const w = m.widths[k] - SANS.tracking * px;
      const mid = az + w / 2 / R;
      const f = (run + w / 2) / m.total;
      run += m.widths[k];
      az += m.widths[k] / R;
      if (ch.trim() === '') return;
      const g = sansGlyph(since, life, FADE_OUT, j, k, words[k], f);
      if (g.alpha <= 0.002) return;
      ctx.save();
      ctx.translate(c + R * Math.sin(mid), c + R * Math.cos(mid));
      ctx.rotate(-mid); // glyph top toward the zenith; its x along the line, its y away from the zenith
      sansGlyphPaint(ctx, ch, px, g, 1);
      ctx.restore();
    });
  }

  /** a body line written from `start` over `dur` s after its phrase began (bodyPen), each glyph as far as the pen has
   * written it `since` s after; returns where its glyphs are and where fraction f of the line is on the canvas (the pen) */
  private drawLine(text: string, el: number, sizeFrac: number, alpha: number, since: number, start: number, dur: number): InkLine {
    const { ctx, size } = this;
    const c = size / 2;
    const R = ((90 - el) / 90) * c; // master radius of this elevation circle
    const font = this.fonts.body;
    const tracking = this.fonts.bodyTracking;
    let px = sizeFrac * size;
    const measure = (): { chars: string[]; widths: number[]; total: number } => {
      ctx.font = font.replace('{px}', px.toFixed(1));
      const chars = [...text];
      const widths = chars.map((ch) => ctx.measureText(ch).width + tracking * px);
      return { chars, widths, total: widths.reduce((a, b) => a + b, 0) - tracking * px };
    };
    let m = measure();
    if (m.total / R > this.layout.maxArc) {
      // keep the line inside the safe zone: shrink it rather than wrap it round the dome
      px *= (this.layout.maxArc * R) / m.total;
      m = measure();
    }
    const oy = baselineBelowMiddle(ctx);
    // azimuth grows to the viewer's right; start half the arc to the left of the front
    const az0 = -m.total / 2 / R;
    let az = az0;
    let run = 0;
    const glyphs: InkLine['glyphs'] = [];
    m.chars.forEach((ch, k) => {
      const w = m.widths[k] - tracking * px;
      const mid = az + w / 2 / R;
      const f0 = run / m.total;
      const f1 = (run + w) / m.total;
      run += m.widths[k];
      az += m.widths[k] / R;
      // canvas y points down; the front (azimuth 0) is the bottom of the frame; glyph top toward the zenith (frame centre)
      const frame: GlyphFrame = { x: c + R * Math.sin(mid), y: c + R * Math.cos(mid), angle: -mid, ox: -w / 2, oy, px };
      glyphs.push({ ch, f0, f1, frame });
      if (ch.trim() === '') return;
      ctx.save();
      ctx.translate(frame.x, frame.y);
      ctx.rotate(frame.angle);
      writeBodyGlyph(ctx, ch, px, alpha, since, start, dur, f0, f1, frame);
      ctx.restore();
    });
    return {
      glyphs,
      at: (f: number): [number, number] => {
        const a = az0 + (f * m.total) / R;
        return [c + R * Math.sin(a), c + R * Math.cos(a)];
      },
    };
  }
}

/** the copy's white, and the amber a glyph is written in (the matter's light: field.ts matterColor, paled) */
const BODY_RGB = [236, 239, 246];
const PEN_RGB = [255, 196, 120];

/**
 * One body glyph at the origin, `alpha` its opacity, `warm` 1 → 0 as it cools from the pen's amber to the copy's white.
 * The copy's soft dark halo stays behind every glyph — whatever the field does behind the text, the letterforms keep
 * their own edge (the overlay is mixed over the frame by its alpha, so the halo darkens what is behind) — and a warm
 * glow sits on the glyph while it is hot. Shared with the 16:9 titles (../flatTitles.ts).
 */
export function inkGlyph(ctx: CanvasRenderingContext2D, ch: string, px: number, alpha: number, warm: number): void {
  const mixc = (i: number): number => Math.round(BODY_RGB[i] + (PEN_RGB[i] - BODY_RGB[i]) * warm);
  ctx.shadowColor = `rgba(0,0,0,${0.85 * alpha})`;
  ctx.shadowBlur = px * 0.5;
  ctx.fillStyle = `rgba(${mixc(0)},${mixc(1)},${mixc(2)},${0.92 * alpha})`;
  ctx.fillText(ch, 0, 0);
  if (warm > 0.03) {
    ctx.shadowColor = `rgba(${PEN_RGB.join(',')},${0.9 * warm * alpha})`;
    ctx.shadowBlur = px * 0.35;
    ctx.fillStyle = `rgba(${PEN_RGB.join(',')},${0.35 * warm * alpha})`;
    ctx.fillText(ch, 0, 0);
  }
}

/** a written body line as a renderer placed it: its glyphs (their shares of the line, crawlInk.ts, and where each is on
 * the canvas), and where fraction f of the line is (the pen over a line none of whose glyphs has a baked path) */
export interface InkLine {
  glyphs: Array<LineGlyph & { frame: GlyphFrame }>;
  at: (f: number) => [number, number];
}

/** px the alphabetic baseline lies below the 'middle' one in `ctx`'s current font (a glyph's origin, from where
 * fillText with textBaseline 'middle' puts it) */
export function baselineBelowMiddle(ctx: CanvasRenderingContext2D): number {
  const was = ctx.textBaseline;
  ctx.textBaseline = 'alphabetic';
  const a = ctx.measureText('x').fontBoundingBoxAscent;
  ctx.textBaseline = 'middle';
  const m = ctx.measureText('x').fontBoundingBoxAscent;
  ctx.textBaseline = was;
  return a - m;
}

/**
 * One body glyph, its centre at the context's origin (turned to its line), as the pen has written it `since` s after its
 * phrase began; its line written from `start` over `dur` s, its share of the line [f0, f1]. A glyph with a baked path
 * (./crawlInk.ts) is nothing before its slot, written through the stroke mask in it, and whole after it, cooling from
 * the pen's amber (glyphInk's warmth); one without keeps the soft wipe. Shared with the 16:9 titles (../flatTitles.ts).
 */
export function writeBodyGlyph(ctx: CanvasRenderingContext2D, ch: string, px: number, alpha: number, since: number, start: number, dur: number, f0: number, f1: number, frame: GlyphFrame): void {
  const g = glyphInk(since, start, dur, f0, f1);
  if (!hasGlyphPath(ch)) {
    if (g.alpha > 0.002) inkGlyph(ctx, ch, px, alpha * g.alpha, g.warm);
    return;
  }
  const q = (since - start - dur * f0) / Math.max(1e-9, dur * (f1 - f0));
  if (q <= 0) return;
  if (q >= 1) inkGlyph(ctx, ch, px, alpha, g.warm);
  else maskedGlyph(ctx, ch, px, alpha, glyphWriting(ch, q)!, frame);
}

/**
 * A glyph part-written: the face's own glyph, kept only inside the pen's mask (round-ended capsules along the strokes so
 * far, each as wide as the ink there × REACH: a canvas clip, the union of them under the nonzero rule), hot (warm 1:
 * the ink at the pen is the amber it is written in). The ink the mask does not reach comes up over the slot's end
 * (`tail`) under it, the two summed to the glyph's own opacity, so at the slot's end it is exactly the whole glyph.
 * (The clip also clips the glyph's dark halo to the mask: for the ~35 ms the glyph is being written.)
 */
function maskedGlyph(ctx: CanvasRenderingContext2D, ch: string, px: number, alpha: number, w: GlyphWriting, f: GlyphFrame): void {
  /** the glyph's fill opacity (inkGlyph: 0.92 × alpha) from the tail, and what the mask adds over it to reach it */
  const aTail = 0.92 * alpha * w.tail;
  if (aTail > 0.002) inkGlyph(ctx, ch, px, alpha * w.tail, 1);
  const aMask = (0.92 * alpha - aTail) / Math.max(1e-6, 1 - aTail) / 0.92;
  if (!w.segments.length || aMask <= 0.002) return;
  const path = new Path2D();
  const P = (x: number, y: number): [number, number] => [f.ox + x * f.px, f.oy + y * f.px];
  for (const [x0, y0, x1, y1, r] of w.segments) {
    const rad = (r * REACH + REACH_PAD) * f.px + 0.5;
    const a = P(x0, y0);
    const b = P(x1, y1);
    // (every piece wound the same way, so the clip is their union)
    path.moveTo(a[0] + rad, a[1]);
    path.arc(a[0], a[1], rad, 0, 2 * Math.PI);
    path.moveTo(b[0] + rad, b[1]);
    path.arc(b[0], b[1], rad, 0, 2 * Math.PI);
    const n = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (n < 1e-6) continue;
    const nx = (-(b[1] - a[1]) / n) * rad;
    const ny = ((b[0] - a[0]) / n) * rad;
    let quad: Array<[number, number]> = [[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]];
    let area = 0;
    for (let i = 0; i < 4; i++) area += quad[i][0] * quad[(i + 1) % 4][1] - quad[(i + 1) % 4][0] * quad[i][1];
    if (area < 0) quad = quad.reverse(); // the arcs' winding: clockwise on the canvas, a positive area with y down
    path.moveTo(quad[0][0], quad[0][1]);
    for (let i = 1; i < 4; i++) path.lineTo(quad[i][0], quad[i][1]);
    path.closePath();
  }
  ctx.save();
  ctx.clip(path);
  inkGlyph(ctx, ch, px, aMask * alpha, 1);
  ctx.restore();
}

/** where the pen is `since` s after its phrase began, on the canvas: from a to b, k of the way, its light 0..1 */
function bodyPenAt(since: number, lines: readonly string[], drawn: readonly InkLine[], spot: [number, number]): { a: [number, number]; b: [number, number]; k: number; glow: number } | null {
  const ink = bodyPen(since, lines);
  const pen = ink.pen;
  if (!pen) return null;
  const P = (pt: PenPoint, j: number): [number, number] => framePoint(drawn[j].glyphs[pt.g].frame, pt.x, pt.y);
  // writing a line: on the strokes of the glyph in hand, or in the air between them
  if (pen.from.line >= 0 && pen.from.line === pen.to.line && drawn[pen.from.line]) {
    const j = pen.from.line;
    const lp = linePen(since, ink.starts[j], ink.durs[j], drawn[j].glyphs);
    if (lp) return { a: P(lp.a, j), b: P(lp.b, j), k: lp.k, glow: pen.glow * (lp.down ? 1 : PEN.air) };
  }
  // coming down from the spot, crossing to the next line, going back: to and from where the line's writing begins and ends
  const pos = (a: PenAt): [number, number] => {
    const d = a.line >= 0 ? drawn[a.line] : undefined;
    if (!d) return spot;
    const e = lineEnds(d.glyphs);
    if (e && a.f <= 0) return P(e.first, a.line);
    if (e && a.f >= 1) return P(e.last, a.line);
    return d.at(a.f);
  };
  return { a: pos(pen.from), b: pos(pen.to), k: pen.k, glow: pen.glow };
}

/**
 * The survivor's light on a body phrase `since` s after it began: the point at the pen and its streak along the way it
 * came over the last PEN.trail s (a pure function of `since`: each sample is the pen at an earlier time, never a
 * remembered position). `drawn` the phrase's lines as the renderer placed them, `spot` the act's one place on its
 * canvas, `alpha` the phrase's, `core` the point's size (drawPen). Shared with the 16:9 titles (../flatTitles.ts).
 */
export function drawBodyPen(ctx: CanvasRenderingContext2D, since: number, lines: readonly string[], drawn: readonly InkLine[], spot: [number, number], alpha: number, core = PEN_CORE): void {
  const n: number = PEN.trailSamples;
  // the streak first, the point last (on top): the tail fading toward the way it came, only the point with a skirt
  for (let i = n; i >= 0; i--) {
    const at = bodyPenAt(since - (i / n) * PEN.trail, lines, drawn, spot);
    if (!at) continue;
    const fade = i === 0 ? 1 : 0.55 * (1 - i / (n + 1));
    drawPen(ctx, at.a, at.b, at.k, at.glow * alpha * fade, core, i === 0 ? 1 : 0);
  }
}

/** canvas px: the pen's core (its Moffat α) — ~1.6 px of the 16:9 cut at 1280, ~2 px of the master at 2K, 4 at 4K */
export const PEN_CORE = 2;

/**
 * The pen's light between canvas points a and b, k of the way (on a gentle arc that lifts over the move, as a hand
 * lifts between strokes), `glow` its strength: a POINT of light, as the title's pen glow is.
 *
 * (A radial disc of 0.55 em, then 0.32 em, read as a flat warm ball parked on the line — the user, 2026-11-01: "this
 * looks horrendous. What's up with those things being so blobby?" Now a point-spread function sized in pixels, not
 * ems: a Moffat core (1 + (r/α)²)^−2.5, α = PEN_CORE px, white-hot, over a faint warm skirt 3.5α wide that falls
 * continuously to zero — no plateau, no edge. The canvas is LDR, so "hot" is its centre at full opacity and white.)
 * `core` the α in canvas px (the 16:9 cut draws a larger one: ../flatTitles.ts FLAT_PEN_CORE), `skirt` 0..1 the warm
 * skirt's share (0 for the samples of the streak behind the point: drawBodyPen).
 */
export function drawPen(ctx: CanvasRenderingContext2D, a: [number, number], b: [number, number], k: number, glow: number, core = PEN_CORE, skirt = 1): void {
  if (glow <= 0.002) return;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const n = Math.hypot(dx, dy) || 1;
  const lift = n * 0.18 * Math.sin(Math.PI * k);
  const x = a[0] + dx * k + (dy / n) * lift;
  const y = a[1] + dy * k - (dx / n) * lift;
  const al = core;
  const R = al * (skirt > 0 ? 10 : 4);
  // (the skirt at 0.16 over 6α read as a brown disc round the point at 1:1 — the overlay is mixed over the frame by its
  // alpha, so a broad low-alpha film is a film, not light: 0.06 over 3.5α)
  // (the streak's samples, `skirt` 0, are the core alone: two dozen skirts summed would be that film again)
  const profile = (r: number): number => Math.min(1, (1 + (r / al) ** 2) ** -2.5 + skirt * 0.06 * Math.exp(-((r / (3.5 * al)) ** 2)) * (1 - (r / R) ** 2) ** 2);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  const g = ctx.createRadialGradient(x, y, 0, x, y, R);
  for (let i = 0; i <= 24; i++) {
    const f = (i / 24) ** 2;
    const v = profile(f * R) * glow;
    // white at the core, warming outward (the matter's light)
    const w = Math.min(1, (f * R) / (3 * al));
    g.addColorStop(f, `rgba(255,${Math.round(250 - 60 * w)},${Math.round(240 - 130 * w)},${v.toFixed(4)})`);
  }
  ctx.fillStyle = g;
  ctx.fillRect(x - R, y - R, 2 * R, 2 * R);
  ctx.restore();
}
