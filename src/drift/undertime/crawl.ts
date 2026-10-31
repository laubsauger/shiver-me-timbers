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
 */
import * as THREE from 'three/webgpu';
import { InkWord, inkProgress } from '../titleInk';

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
const FADE_IN = 0.9;
const FADE_OUT = 1.1;
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

const FONTS: CrawlFonts = {
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
      p.lines.forEach((line, j) => {
        const el = at.el - j * textDeg(at.size) * LINE_PITCH;
        if (p.signature) this.drawSignature(line, el, at.size, at.alpha, at.ink);
        else this.drawLine(line, el, at.size, at.alpha);
      });
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

  private drawLine(text: string, el: number, sizeFrac: number, alpha: number): void {
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
    ctx.fillStyle = `rgba(236,239,246,${0.92 * alpha})`;
    // a soft dark halo behind every glyph: whatever the field does behind the text, the letterforms keep
    // their own edge (the overlay is mixed over the frame by its alpha, so the halo darkens what is behind)
    ctx.shadowColor = `rgba(0,0,0,${0.85 * alpha})`;
    ctx.shadowBlur = px * 0.5;
    // azimuth grows to the viewer's right; start half the arc to the left of the front
    let az = -m.total / 2 / R;
    m.chars.forEach((ch, k) => {
      const w = m.widths[k] - tracking * px;
      const mid = az + w / 2 / R;
      // canvas y points down; the front (azimuth 0) is the bottom of the frame
      const x = c + R * Math.sin(mid);
      const y = c + R * Math.cos(mid);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-mid); // glyph top toward the zenith (frame centre)
      ctx.fillText(ch, 0, 0);
      ctx.restore();
      az += m.widths[k] / R;
    });
  }
}
