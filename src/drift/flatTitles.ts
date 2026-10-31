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
 * The canvas is SQUARE, the master's size: the flat view is drawn square and cut to 16:9 after (scripts/drift-review-
 * clip.mjs), so its uv is the overlay's uv and the text is drawn into the middle 9/16 of the canvas.
 */
import * as THREE from 'three/webgpu';
import { LINE_PITCH, phrasePlacement, type CrawlLayout, type CrawlPhrase } from './undertime/crawl';
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
      out.push({ text, y: Math.min(hi, Math.max(lo, y)), em, alpha: at.alpha, signature: !!p.signature, ink: at.ink });
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
      const font = FONTS.body;
      const tracking = FONTS.bodyTracking;
      let px = line.em * h;
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
      ctx.fillStyle = `rgba(236,239,246,${0.92 * line.alpha})`;
      // the dome's dark halo behind every glyph (crawl.ts): the letterforms keep their edge over whatever is behind
      ctx.shadowColor = `rgba(0,0,0,${0.85 * line.alpha})`;
      ctx.shadowBlur = px * 0.5;
      // glyph by glyph along the arc (THE ARC): each at its advance in the whole line (the prefix's width: the face's
      // kerning and the tracking included), centred on the line, turned to the arc at its middle
      const glyphs = Array.from(line.text);
      const total = ctx.measureText(line.text).width - tracking * px;
      let prefix = '';
      for (const g of glyphs) {
        const x0 = ctx.measureText(prefix).width;
        prefix += g;
        const gw = ctx.measureText(g).width - tracking * px;
        if (g.trim() === '') continue;
        const at = arcPoint(x0 + gw / 2 - total / 2, size / 2, top + line.y * h, radius);
        ctx.save();
        ctx.translate(at.x, at.y);
        ctx.rotate(at.angle);
        ctx.fillText(g, 0, 0);
        ctx.restore();
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.texture.needsUpdate = true;
  }
}
