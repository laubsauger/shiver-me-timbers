/**
 * Undertime's text crawl — Mark's "Star Wars titles, reversed": lines start at mid-heaven and recede toward
 * the front horizon, shrinking as they go, and the act is signed with "the Drift", which settles and holds.
 *
 * Laid out in DOME-MASTER space, not in the 3D scene: on a dome a line of text that reads as horizontal lies
 * on a circle of constant elevation, and in the master that circle is concentric with the frame. Each glyph
 * sits on that circle, centred on the front (frame bottom), upright toward the zenith, reading left to right
 * for the seated viewer (domeMaster.ts convention). Keep text inside the front safe zone (studio-world R11:
 * about ±50° azimuth, 10–60° elevation) — `elTop`/`elBottom` default inside it.
 *
 * `crawlPlacement` is pure (tested); `CrawlOverlay` draws it into a canvas texture the dome capture
 * composites over the master.
 */
import * as THREE from 'three/webgpu';

export interface CrawlLine {
  text: string;
  /** the signature line: display face, larger, stops at `holdEl` and holds */
  signature?: boolean;
}

export interface CrawlLayout {
  /** s, act time the first line appears */
  start: number;
  /** s between line starts */
  gap: number;
  /** s a line takes from `elTop` to `elBottom` */
  travel: number;
  /** deg, where lines appear (mid-heaven, front) */
  elTop: number;
  /** deg, where lines leave (near the front horizon) */
  elBottom: number;
  /** deg, where the signature stops */
  holdEl: number;
  /** text height as a fraction of the master's width, at elTop and at elBottom */
  sizeTop: number;
  sizeBottom: number;
  /** s the signature fades out over, ending at `end` */
  fade: number;
  /** s, act time everything is gone */
  end: number;
  /** rad, the widest a line may span in azimuth; longer lines are drawn smaller */
  maxArc: number;
}

export interface Placement {
  /** deg */
  el: number;
  /** fraction of master width */
  size: number;
  alpha: number;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const easeOut = (x: number): number => 1 - (1 - x) * (1 - x);

/** where line `i` of `n` is at act time `t`, or null if it is not on the dome */
export function crawlPlacement(t: number, i: number, n: number, line: CrawlLine, L: CrawlLayout): Placement | null {
  const t0 = L.start + i * L.gap;
  if (t < t0 || t > L.end) return null;
  const k = (t - t0) / L.travel; // 0 at elTop, 1 at elBottom
  let alpha = clamp01(k * 6);
  // decelerates as it recedes, like a crawl into depth
  let e = easeOut(clamp01(k));
  if (line.signature) {
    // stop in ELEVATION terms, after the easing, so it settles exactly at holdEl
    e = Math.min(e, (L.elTop - L.holdEl) / (L.elTop - L.elBottom));
    alpha *= clamp01((L.end - t) / Math.max(1e-6, L.fade));
  } else {
    if (k >= 1) return null;
    alpha *= clamp01((1 - k) * 4);
  }
  void n;
  const el = L.elTop + (L.elBottom - L.elTop) * e;
  const size = (L.sizeTop + (L.sizeBottom - L.sizeTop) * e) * (line.signature ? 1.9 : 1);
  return alpha > 0 ? { el, size, alpha } : null;
}

export class CrawlOverlay {
  readonly texture: THREE.CanvasTexture;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly size: number;

  constructor(
    private readonly lines: readonly CrawlLine[],
    readonly layout: CrawlLayout,
    size = 2048,
    private readonly fonts = { body: '300 {px}px Georgia, "Times New Roman", serif', signature: 'italic 300 {px}px Georgia, "Times New Roman", serif' },
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
    const c = size / 2;
    ctx.clearRect(0, 0, size, size);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const n = this.lines.length;
    this.lines.forEach((line, i) => {
      const at = crawlPlacement(t, i, n, line, this.layout);
      if (!at) return;
      const px = at.size * size;
      const R = ((90 - at.el) / 90) * c; // master radius of this elevation circle
      ctx.font = (line.signature ? this.fonts.signature : this.fonts.body).replace('{px}', px.toFixed(1));
      ctx.fillStyle = line.signature ? `rgba(255,214,150,${at.alpha})` : `rgba(236,240,255,${at.alpha})`;
      let chars = [...line.text];
      let widths = chars.map((ch) => ctx.measureText(ch).width);
      let total = widths.reduce((a, b) => a + b, 0);
      if (total / R > this.layout.maxArc) {
        // keep the line inside the safe zone: shrink it rather than wrap it round the dome
        const fit = (px * this.layout.maxArc * R) / total;
        ctx.font = (line.signature ? this.fonts.signature : this.fonts.body).replace('{px}', fit.toFixed(1));
        chars = [...line.text];
        widths = chars.map((ch) => ctx.measureText(ch).width);
        total = widths.reduce((a, b) => a + b, 0);
      }
      // azimuth grows to the viewer's right; start half the arc to the left of the front
      let az = -total / 2 / R;
      chars.forEach((ch, k) => {
        const mid = az + widths[k] / 2 / R;
        // canvas y points down; the front (azimuth 0) is the bottom of the frame
        const x = c + R * Math.sin(mid);
        const y = c + R * Math.cos(mid);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(-mid); // glyph top toward the zenith (frame centre)
        ctx.fillText(ch, 0, 0);
        ctx.restore();
        az += widths[k] / R;
      });
    });
    this.texture.needsUpdate = true;
  }
}
