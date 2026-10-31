/**
 * THE TITLE, WRITTEN ON: "the Drift" drawn along its strokes like a pen, in Pinyon Script.
 *
 * The client's note of 2026-10-31: the Avenir title was "not good enough" for the epic mood; it should become "a proper
 * logo drawn on along its strokes like calligraphy / handwriting over ~1.5–2 s, without going cringy". So the filled
 * glyphs (the font's own letterforms, nothing redrawn) are revealed by a mask: a thick round pen that runs along the
 * letters' centrelines, in writing order, up to progress p. The path is baked offline from the font
 * (scripts/drift-title-strokes.py → titleStrokes.json: the strokes as polylines in em, with the ink's half-width at
 * every point), so the mask is as wide as the letter where it is, and a hairline next to a shaded stem is not given
 * away early. A soft warm light rides on the pen while it is down; it is gone once the word is written.
 *
 * Every frame is a pure function of show time: `inkProgress` maps the time since the phrase began to p, and
 * `inkPath(text, p)` is pure (tested). `InkWord` paints the result (and the title's dark halo) into a canvas both
 * the dome's crawl (bent onto its circle of elevation) and the 16:9 titles (straight) draw from.
 *
 * A text with no baked path (new copy, later) still draws on: a soft-edged wipe from left to right over the same time.
 */
import strokeData from './titleStrokes.json';

/** s from the phrase's start to the pen's first touch (the field has made room; a breath before the hand moves) */
export const INK_DELAY = 0.3;
/** s the writing takes, first touch to last (the note: ~1.5–2 s) */
export const INK_DRAW = 1.8;
/** em of pen travel a lift costs, in time: the hand's move to the next stroke through the air */
const LIFT = 0.45;
/** the mask's half-width over the ink's (the centreline is not always the middle of a swelling stroke) */
const REACH = 1.25;
/** em added to it: the bake's 1.5 px at 400 px per em (antialiased edges) */
const REACH_PAD = 0.004;
/** p from which what the pen's round tip has not reached (the last ~0.4 % of the ink: flared terminals) fades up */
const TAIL = 0.92;

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const smooth = (x: number): number => {
  const k = clamp01(x);
  return k * k * (3 - 2 * k);
};

/**
 * the writing's progress, 0..1, `since` s after the phrase began: a hand's pace — it gathers speed and settles,
 * but keeps moving (part linear, so it never hangs at either end)
 */
export function inkProgress(since: number): number {
  const x = clamp01((since - INK_DELAY) / INK_DRAW);
  return 0.4 * x + 0.6 * smooth(x);
}

/** a polyline point: x, y (em from the text's left end on its baseline, y down), the ink's half-width (em) */
type Pt = [number, number, number];
interface Baked {
  font: string;
  advance: number;
  strokes: Pt[][];
}
const BAKED = strokeData as unknown as Record<string, Baked>;

/** the mask so far: segments to stroke (x0, y0, x1, y1, half-width, all em) and the pen (null while lifted or done) */
export interface InkPath {
  segments: Array<[number, number, number, number, number]>;
  pen: { x: number; y: number; r: number; glow: number } | null;
}

/** whether `text` has a baked pen path (else it draws on as a wipe) */
export const hasInkPath = (text: string): boolean => text in BAKED;

/** the pen path of `text` written up to progress p (pure); null if the text has no baked path */
export function inkPath(text: string, p: number): InkPath | null {
  const baked = BAKED[text];
  if (!baked) return null;
  const lens = baked.strokes.map((s) => s.slice(1).map((q, i) => Math.hypot(q[0] - s[i][0], q[1] - s[i][1])));
  const total = lens.reduce((a, l) => a + l.reduce((b, x) => b + x, 0), 0) + LIFT * (baked.strokes.length - 1);
  let left = clamp01(p) * total;
  const segments: InkPath['segments'] = [];
  let pen: InkPath['pen'] = null;
  for (let k = 0; k < baked.strokes.length && left > 0; k++) {
    const s = baked.strokes[k];
    const strokeLen = lens[k].reduce((b, x) => b + x, 0);
    let along = 0;
    for (let i = 0; i < lens[k].length && left > 0; i++) {
      const a = s[i];
      const b = s[i + 1];
      const f = Math.min(1, left / Math.max(1e-9, lens[k][i]));
      const x = a[0] + (b[0] - a[0]) * f;
      const y = a[1] + (b[1] - a[1]) * f;
      const r = a[2] + (b[2] - a[2]) * f;
      segments.push([a[0], a[1], x, y, Math.max(a[2], r)]);
      left -= lens[k][i];
      along += lens[k][i] * f;
      // the light on the pen: up as it touches down, out as it lifts (over 0.08 em of stroke either way)
      if (left <= 0) pen = { x, y, r, glow: Math.min(smooth(along / 0.08), smooth((strokeLen - along) / 0.08)) };
    }
    if (strokeLen === 0 && left > 0) segments.push([s[0][0], s[0][1], s[0][0], s[0][1], s[0][2]]); // a dot
    left -= LIFT;
  }
  if (p >= 1) pen = null;
  return { segments, pen };
}

/**
 * The written word in a canvas of its own: the fill revealed by the pen's mask, the dark halo behind it, the light
 * on the pen. The line's position is the canvas's centre (the centre of the word's ink). Repaints only on a change.
 */
export class InkWord {
  /** the word, its halo and the pen's light, at full opacity (the caller applies the phrase's alpha) */
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** the revealed fill alone (the halo is cast from it) */
  private readonly ink: HTMLCanvasElement;
  private readonly inkCtx: CanvasRenderingContext2D;
  private key = '';

  constructor() {
    const make = (): [HTMLCanvasElement, CanvasRenderingContext2D] => {
      const c = document.createElement('canvas');
      const x = c.getContext('2d');
      if (!x) throw new Error('title ink: 2D canvas unavailable');
      return [c, x];
    };
    [this.canvas, this.ctx] = make();
    [this.ink, this.inkCtx] = make();
  }

  /** px, the advance width of `text` set in `font` (a CSS font string at its px size) */
  measure(text: string, font: string): number {
    this.inkCtx.font = font;
    this.inkCtx.letterSpacing = '0px';
    return this.inkCtx.measureText(text).width;
  }

  /** paint `text` in `font` (`px` its em) written up to progress p, in `colour` */
  render(text: string, font: string, px: number, p: number, colour: string): void {
    const key = `${text}|${font}|${p}|${colour}`;
    if (key === this.key) return;
    this.key = key;
    const g = this.inkCtx;
    g.font = font;
    g.letterSpacing = '0px';
    const m = g.measureText(text);
    // room for the halo (blur px/2) round the ink's own box
    const pad = Math.ceil(px * 0.8);
    const W = Math.ceil(m.actualBoundingBoxLeft + m.actualBoundingBoxRight) + 2 * pad;
    const H = Math.ceil(m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) + 2 * pad;
    for (const c of [this.canvas, this.ink]) {
      if (c.width !== W || c.height !== H) {
        c.width = W;
        c.height = H;
      }
    }
    const ox = pad + m.actualBoundingBoxLeft;
    const oy = pad + m.actualBoundingBoxAscent;
    g.clearRect(0, 0, W, H);
    const ctx = this.ctx;
    ctx.clearRect(0, 0, W, H);
    if (p <= 0) return;
    g.font = font; // (a resize resets the context's state)
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.fillStyle = colour;
    const path = p < 1 ? inkPath(text, p) : null;
    if (p >= 1) g.fillText(text, ox, oy);
    else if (path) {
      // the pen's mask, segment by segment (each as wide as the ink there), then the fill kept only inside it
      g.strokeStyle = '#fff';
      g.lineCap = 'round';
      g.lineJoin = 'round';
      for (const [x0, y0, x1, y1, r] of path.segments) {
        g.lineWidth = 2 * (r * REACH + REACH_PAD) * px + 1;
        g.beginPath();
        g.moveTo(ox + x0 * px, oy + y0 * px);
        g.lineTo(ox + x1 * px, oy + y1 * px);
        g.stroke();
      }
      g.globalCompositeOperation = 'source-in';
      g.fillText(text, ox, oy);
      // the wet ink at the pen: the last few hundredths of an em of the stroke a shade whiter than the dried ink
      const pen = path.pen;
      if (pen && pen.glow > 0) {
        const x = ox + pen.x * px;
        const y = oy + pen.y * px;
        const rad = 0.14 * px;
        const wet = g.createRadialGradient(x, y, 0, x, y, rad);
        wet.addColorStop(0, `rgba(255,253,248,${0.95 * pen.glow})`);
        wet.addColorStop(1, 'rgba(255,253,248,0)');
        g.globalCompositeOperation = 'source-atop';
        g.fillStyle = wet;
        g.fillRect(x - rad, y - rad, 2 * rad, 2 * rad);
        g.fillStyle = colour;
      }
      g.globalCompositeOperation = 'source-over';
      // what the round tip could not reach comes up as the last strokes go down (no pop at p = 1)
      const tail = smooth((p - TAIL) / (1 - TAIL));
      if (tail > 0) {
        g.globalAlpha = tail;
        g.fillText(text, ox, oy);
        g.globalAlpha = 1;
      }
    } else {
      // no baked path: a soft-edged wipe, left to right
      const x0 = ox - m.actualBoundingBoxLeft;
      const w = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
      const soft = 0.6 * px;
      const edge = x0 - soft + p * (w + soft);
      g.fillText(text, ox, oy);
      const grad = g.createLinearGradient(edge, 0, edge + soft, 0);
      grad.addColorStop(0, 'rgba(0,0,0,1)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.globalCompositeOperation = 'destination-in';
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
      g.globalCompositeOperation = 'source-over';
    }
    // the crawl's dark halo, cast from the ink revealed so far (the letterforms keep their edge over whatever is behind)
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = px * 0.5;
    ctx.drawImage(this.ink, 0, 0);
    ctx.restore();
    // the light on the pen: a small warm bloom round the tip, not a spark (the note: "without going cringy"; a first
    // try, 0.55 opaque over 3 ink widths, read as a grey blot on the dark sky, not as light: the overlay can only lay
    // its colour over the frame, so the bloom stays small and faint and the shine is carried by the wet ink above)
    const pen = path?.pen;
    if (pen && pen.glow > 0) {
      const x = ox + pen.x * px;
      const y = oy + pen.y * px;
      const rad = 0.09 * px;
      const grad = ctx.createRadialGradient(x, y, 0, x, y, rad);
      grad.addColorStop(0, `rgba(255,250,240,${0.35 * pen.glow})`);
      grad.addColorStop(1, 'rgba(255,240,215,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(x - rad, y - rad, 2 * rad, 2 * rad);
    }
  }
}
