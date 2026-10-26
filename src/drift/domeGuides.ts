/**
 * Dome-master staging guides, drawn as a DOM canvas OVER the letterboxed master — never into it, so a
 * recording can never pick them up.
 *
 * What a dome layout needs at a glance (studio-world SPEC R11 for the numbers):
 *   - elevation rings (the master's radius is linear in zenith angle) and azimuth spokes, labelled
 *   - the FRONT SAFE ZONE: ±50° azimuth, 10–60° elevation — where text and the key action belong on a
 *     unidirectional (tilted) dome, because that is what every seat can see without turning
 *   - the EYE-LEVEL HORIZON: on a dome tilted by τ the world's horizontal plane is not the spring line; it
 *     sits at elevation atan(tan τ · cos az) — τ above the spring line at the front, τ below it at the back
 *   - zenith and the four directions
 *
 * Point mapping matches domeMaster.ts and the crawl: r = (90 − el)/90 · R, front (az 0) at the bottom,
 * the viewer's right at the right.
 */

export interface DomeGuidesOptions {
  /** front safe zone, deg */
  safeAz: number;
  safeElMin: number;
  safeElMax: number;
}

const DEG = Math.PI / 180;

/** master-space point (canvas px, y down) of elevation/azimuth in degrees */
export function domePoint(elDeg: number, azDeg: number, cx: number, cy: number, R: number): [number, number] {
  const r = ((90 - elDeg) / 90) * R;
  return [cx + r * Math.sin(azDeg * DEG), cy + r * Math.cos(azDeg * DEG)];
}

/** elevation (deg) of the world's horizontal plane at azimuth az on a dome tilted by tiltDeg */
export function eyeLevelElevation(azDeg: number, tiltDeg: number): number {
  return Math.atan(Math.tan(tiltDeg * DEG) * Math.cos(azDeg * DEG)) / DEG;
}

export class DomeGuides {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private key = '';

  constructor(
    parent: HTMLElement,
    private readonly o: DomeGuidesOptions = { safeAz: 50, safeElMin: 10, safeElMax: 60 },
  ) {
    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' });
    parent.appendChild(this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('domeGuides: 2D canvas unavailable');
    this.ctx = ctx;
  }

  /** redraw only when something it depends on changed */
  update(visible: boolean, tiltDeg: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(window.innerWidth * dpr);
    const h = Math.round(window.innerHeight * dpr);
    const key = `${visible}|${tiltDeg}|${w}x${h}`;
    if (key === this.key) return;
    this.key = key;
    this.canvas.width = w;
    this.canvas.height = h;
    const g = this.ctx;
    g.clearRect(0, 0, w, h);
    if (!visible) return;
    const s = Math.min(w, h);
    const cx = w / 2;
    const cy = h / 2;
    const R = s / 2;
    const P = (el: number, az: number): [number, number] => domePoint(el, az, cx, cy, R);
    const px = (n: number): number => n * dpr;

    // front safe zone
    const { safeAz, safeElMin, safeElMax } = this.o;
    g.beginPath();
    for (let az = -safeAz; az <= safeAz; az += 2) g.lineTo(...P(safeElMin, az));
    for (let az = safeAz; az >= -safeAz; az -= 2) g.lineTo(...P(safeElMax, az));
    g.closePath();
    g.fillStyle = 'rgba(255, 190, 90, 0.10)';
    g.fill();
    g.strokeStyle = 'rgba(255, 190, 90, 0.75)';
    g.lineWidth = px(1.5);
    g.setLineDash([]);
    g.stroke();

    // elevation rings
    g.strokeStyle = 'rgba(200, 215, 255, 0.28)';
    g.lineWidth = px(1);
    g.font = `${px(11)}px ui-monospace, Menlo, monospace`;
    g.fillStyle = 'rgba(200, 215, 255, 0.7)';
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    for (const el of [0, 10, 30, 45, 60, 80]) {
      g.beginPath();
      g.arc(cx, cy, ((90 - el) / 90) * R, 0, Math.PI * 2);
      g.lineWidth = px(el === 0 ? 1.5 : 1);
      g.stroke();
      if (el > 0) {
        const [x, y] = P(el, 135); // label on the back-right diagonal, out of the safe zone
        g.fillText(`${el}°`, x + px(3), y);
      }
    }

    // azimuth spokes, labelled at the rim
    for (let az = 0; az < 360; az += 30) {
      const [x0, y0] = P(80, az);
      const [x1, y1] = P(0, az);
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.strokeStyle = az % 90 === 0 ? 'rgba(200, 215, 255, 0.35)' : 'rgba(200, 215, 255, 0.16)';
      g.stroke();
    }
    const names: Array<[number, string]> = [[0, 'FRONT'], [90, 'RIGHT'], [180, 'BACK'], [270, 'LEFT']];
    g.textAlign = 'center';
    g.font = `600 ${px(12)}px ui-monospace, Menlo, monospace`;
    for (const [az, name] of names) {
      // just inside the rim: the master fills the shorter side, so outside it is off-screen
      const [x, y] = domePoint(az === 0 || az === 180 ? 3 : 5, az, cx, cy, R);
      g.fillStyle = az === 0 ? 'rgba(255, 200, 120, 0.95)' : 'rgba(200, 215, 255, 0.8)';
      g.fillText(name, x, y);
    }

    // eye-level horizon (only differs from the spring line on a tilted dome)
    if (tiltDeg > 0) {
      g.beginPath();
      let started = false;
      for (let az = -180; az <= 180; az += 2) {
        const el = eyeLevelElevation(az, tiltDeg);
        if (el < 0) {
          started = false;
          continue;
        }
        const [x, y] = P(el, az);
        if (started) g.lineTo(x, y);
        else g.moveTo(x, y);
        started = true;
      }
      g.strokeStyle = 'rgba(120, 230, 200, 0.8)';
      g.setLineDash([px(6), px(5)]);
      g.lineWidth = px(1.5);
      g.stroke();
      g.setLineDash([]);
      // label off to the front-left, clear of the crawl, which runs down the front
      const az = -62;
      const [lx, ly] = P(eyeLevelElevation(az, tiltDeg) + 3, az);
      g.fillStyle = 'rgba(120, 230, 200, 0.9)';
      g.font = `${px(11)}px ui-monospace, Menlo, monospace`;
      g.fillText(`eye level (tilt ${tiltDeg}°)`, lx, ly);
    }

    // zenith
    g.strokeStyle = 'rgba(200, 215, 255, 0.6)';
    g.lineWidth = px(1);
    g.beginPath();
    g.moveTo(cx - px(8), cy);
    g.lineTo(cx + px(8), cy);
    g.moveTo(cx, cy - px(8));
    g.lineTo(cx, cy + px(8));
    g.stroke();
    g.fillStyle = 'rgba(200, 215, 255, 0.7)';
    g.fillText('ZENITH', cx, cy - px(14));
    g.fillStyle = 'rgba(255, 190, 90, 0.9)';
    const [sx, sy] = P(safeElMax, 0);
    g.fillText('front safe zone', sx, sy - px(10));
  }
}
