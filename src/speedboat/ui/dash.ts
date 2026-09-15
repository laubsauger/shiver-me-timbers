/**
 * Cockpit dashboard readouts (design doc §9 cockpit variant: "the boat is the HUD").
 *
 * In the cockpit camera the screen overlay shrinks to position, gaps, radio and the gate marker, and
 * the instruments live on the modelled dash. The dash has two SCREENS and three physical parts:
 *  - `plotter` canvas: the strapped plotter tablet (course, rivals, next mark, lap clock);
 *  - `led` canvas: the LED speed readout with the three Surge lamps under it;
 *  - `rpmNeedleRad`, `trimBubble`, `governorDetentRad`: poses for the tach needle, the trim bubble
 *    level and the Governor dial, which are 3D parts (the Governor dial is not drawn by the HUD).
 * The page uploads the canvases as CanvasTextures (`needsUpdate` when `dirty` is true) and poses the
 * parts. Painting is allocation-free and only on change; the plotter repaints at most 15 Hz.
 *
 * §T.208 `gauges` canvas: the SB-12 GLB bakes its three round gauge needles into the merged parts mesh (no needle nodes),
 * so the page covers the three gauge glasses with this canvas, one square tile each, left → right as the pilot sees
 * them: tach, the LED speed readout (the `led` canvas) over the Governor lamp, trim. `plotterDirty` / `gaugesDirty` say
 * which texture to upload.
 *
 * §T.208 live needles: the canvas carries the dial FACES only (ticks, numerals); the tach and trim needles are 3D quads
 * the page turns every frame from `pose()` (`rpmNeedleRad`, `trimNeedleRad`, canvas angle convention: clockwise from 12
 * o'clock as the pilot sees it). So the needles move at the frame rate while the canvases repaint on change at a low
 * rate: the faces once, the middle tile when the knots, Surge or Governor change. The trim needle reads DRIVE trim
 * (a gauge on the drive, not the hull's pitch), `TRIM_DIAL_DEG` over ±60°.
 */
import { COUNTDOWN_LAMPS, RPM_MAX, RPM_REDLINE, SURGE_SEGMENTS, TRIM_DIAL_DEG, surgeSegmentFill, type HudCourse, type RaceHudModel } from './model';
import type { HudRacer } from './roster';
import { INT } from './text';

const DIGIT = '0123456789'.split('');
const AMBER = '#F2B54A';
const ORANGE = '#FF6B1F';
const SCREEN = '#0B1112';
const PLOT_HZ = 15;
const PAPER = '#F2F4EF';
/** gauges canvas: three square tiles */
export const GAUGE_TILE_PX = 160;

/** tach needle sweep, radians either side of straight up */
export const RPM_NEEDLE_SWEEP = (135 * Math.PI) / 180;
/** trim needle sweep, radians either side of straight up (TRIM_DIAL_DEG min .. max) */
export const TRIM_NEEDLE_SWEEP = Math.PI / 3;
/** Governor dial detents OFF · AIR · FULL */
export const GOVERNOR_DETENTS = { off: -0.7, air: 0, full: 0.7 } as const;
/** the needle quads in gauge-tile px (tile T = GAUGE_TILE_PX, its disc radius T/2): tail behind the hub, tip, width, hub radius */
export const NEEDLE_PX = { tail: 10, tip: 64, width: 5, hub: 7 } as const;
const GOV_TEXT = { off: 'GOV OFF', air: 'GOV AIR', full: 'GOV FULL' } as const;
const GOV_CODE = { off: 0, air: 1, full: 2 } as const;
const LAMP_DARK = '#2A3133';

/** the trim needle angle for a drive trim in degrees, clamped to the dial */
export function trimNeedleRadFor(trimDeg: number): number {
  const span = (TRIM_DIAL_DEG.max - TRIM_DIAL_DEG.min) / 2;
  const mid = (TRIM_DIAL_DEG.max + TRIM_DIAL_DEG.min) / 2;
  const b = (trimDeg - mid) / span;
  return (b < -1 ? -1 : b > 1 ? 1 : b) * TRIM_NEEDLE_SWEEP;
}

export class DashDisplays {
  readonly plotter: HTMLCanvasElement;
  readonly led: HTMLCanvasElement;
  rpmNeedleRad = -RPM_NEEDLE_SWEEP;
  /** −1 (bow down, bubble aft) .. +1 */
  trimBubble = 0;
  /** drive trim needle, −TRIM_NEEDLE_SWEEP (TRIM_DIAL_DEG.min) .. +TRIM_NEEDLE_SWEEP */
  trimNeedleRad = 0;
  governorDetentRad = 0;
  /** the Governor lamp as last painted: 0 off · 1 air · 2 full, −1 before the first paint */
  governorLamp = -1;
  /** a canvas was repainted this frame */
  dirty = false;
  readonly gauges: HTMLCanvasElement;
  plotterDirty = false;
  gaugesDirty = false;

  private readonly pc: CanvasRenderingContext2D;
  private readonly lc: CanvasRenderingContext2D;
  private course: HudCourse | null = null;
  private path: Path2D | null = null;
  private hues: string[] = [];
  private playerId = 0;
  private sx = 1;
  private ox = 0;
  private oz = 0;
  private minX = 0;
  private minZ = 0;
  private plotAcc = 1;
  private ledKey = -1;
  private gaugeKey = -1;
  private readonly gc: CanvasRenderingContext2D;

  constructor() {
    this.plotter = document.createElement('canvas');
    this.plotter.width = 320;
    this.plotter.height = 180;
    this.led = document.createElement('canvas');
    this.led.width = 256;
    this.led.height = 112;
    this.pc = this.plotter.getContext('2d') as CanvasRenderingContext2D;
    this.lc = this.led.getContext('2d') as CanvasRenderingContext2D;
    this.gauges = document.createElement('canvas');
    this.gauges.width = 3 * GAUGE_TILE_PX;
    this.gauges.height = GAUGE_TILE_PX;
    this.gc = this.gauges.getContext('2d') as CanvasRenderingContext2D;
  }

  /** edge */
  setCourse(hc: HudCourse): void {
    this.course = hc;
    const c = hc.course;
    const W = 320;
    const H = 150;
    const pad = 12;
    const dx = Math.max(1, c.bounds.max[0] - c.bounds.min[0]);
    const dz = Math.max(1, c.bounds.max[1] - c.bounds.min[1]);
    this.sx = Math.min((W - 2 * pad) / dx, (H - 2 * pad) / dz);
    this.minX = c.bounds.min[0];
    this.minZ = c.bounds.min[1];
    this.ox = (W - dx * this.sx) / 2;
    this.oz = (H - dz * this.sx) / 2;
    const p = new Path2D();
    c.referenceLine.forEach(([x, z], i) => (i === 0 ? p.moveTo(this.mx(x), this.mz(z)) : p.lineTo(this.mx(x), this.mz(z))));
    p.closePath();
    this.path = p;
    this.plotAcc = 1;
  }

  /** edge */
  setRoster(roster: readonly HudRacer[], fieldCap = 8): void {
    this.hues = Array.from({ length: fieldCap }, (_, id) => roster.find((r) => r.racerId === id)?.hue ?? '#9FB2B0');
    this.playerId = roster.find((r) => r.isPlayer)?.racerId ?? 0;
  }

  private mx(x: number): number {
    return this.ox + (x - this.minX) * this.sx;
  }
  private mz(z: number): number {
    return this.oz + (z - this.minZ) * this.sx;
  }

  /** every frame, no painting: the needle and knob poses from the model (the same telemetry the HUD reads) */
  pose(m: RaceHudModel): void {
    this.rpmNeedleRad = -RPM_NEEDLE_SWEEP + 2 * RPM_NEEDLE_SWEEP * m.rpmFrac;
    const span = (TRIM_DIAL_DEG.max - TRIM_DIAL_DEG.min) / 2;
    const mid = (TRIM_DIAL_DEG.max + TRIM_DIAL_DEG.min) / 2;
    const b = (m.attitudeDeg - mid) / span;
    this.trimBubble = b < -1 ? -1 : b > 1 ? 1 : b;
    this.trimNeedleRad = trimNeedleRadFor(m.trimDeg);
    this.governorDetentRad = GOVERNOR_DETENTS[m.governor];
  }

  update(m: RaceHudModel, dt: number): void {
    this.dirty = false;
    this.plotterDirty = false;
    this.gaugesDirty = false;
    this.pose(m);
    const ledKey = this.ledKey;
    this.updateLed(m);
    this.updateGauges(m, ledKey !== this.ledKey);
    this.plotAcc += dt;
    if (this.plotAcc >= 1 / PLOT_HZ) {
      this.plotAcc = 0;
      this.updatePlotter(m);
    }
  }

  private tick(cx: number, a: number, r0: number, r1: number): void {
    const c = this.gc;
    const cy = GAUGE_TILE_PX / 2;
    c.beginPath();
    c.moveTo(cx + Math.sin(a) * r0, cy - Math.cos(a) * r0);
    c.lineTo(cx + Math.sin(a) * r1, cy - Math.cos(a) * r1);
    c.stroke();
  }

  /** tach · LED + Governor lamp · trim tiles: the outer faces once, the middle tile when the LED or the Governor changed */
  private updateGauges(m: RaceHudModel, ledChanged: boolean): void {
    const gov = GOV_CODE[m.governor];
    const faces = this.gaugeKey < 0;
    if (!faces && !ledChanged && gov === this.governorLamp) return;
    this.gaugeKey = 1;
    this.governorLamp = gov;
    this.dirty = true;
    this.gaugesDirty = true;
    const c = this.gc;
    const T = GAUGE_TILE_PX;
    c.textBaseline = 'middle';
    // the middle tile: LED speed readout and the Governor lamp under it
    const cx = T + T / 2;
    c.fillStyle = SCREEN;
    c.fillRect(T, 0, T, T);
    c.drawImage(this.led, cx - 72, T / 2 - 40, 144, 63);
    c.beginPath();
    c.arc(cx - 40, T / 2 + 42, 7, 0, Math.PI * 2);
    c.fillStyle = gov === 0 ? LAMP_DARK : gov === 1 ? AMBER : ORANGE;
    c.fill();
    c.font = '600 17px "SB Saira Condensed", "Saira Condensed", sans-serif';
    c.textAlign = 'left';
    c.fillStyle = gov === 0 ? '#6E7A7B' : AMBER;
    c.fillText(GOV_TEXT[m.governor], cx - 28, T / 2 + 43);
    if (faces) this.paintFaces();
  }

  /** the tach and trim dial faces (no needles: those are the page's 3D quads) */
  private paintFaces(): void {
    const c = this.gc;
    const T = GAUGE_TILE_PX;
    const R = T / 2 - 2;
    c.fillStyle = SCREEN;
    c.fillRect(0, 0, T, T);
    c.fillRect(2 * T, 0, T, T);
    c.lineCap = 'round';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    // tach: 0..7 ×1000 over ±135°, red from the redline
    let cx = T / 2;
    c.lineWidth = 7;
    c.strokeStyle = '#D0402E';
    c.beginPath();
    c.arc(cx, T / 2, R - 8, -Math.PI / 2 - RPM_NEEDLE_SWEEP + 2 * RPM_NEEDLE_SWEEP * (RPM_REDLINE / RPM_MAX), -Math.PI / 2 + RPM_NEEDLE_SWEEP);
    c.stroke();
    c.strokeStyle = PAPER;
    c.fillStyle = PAPER;
    c.font = '600 22px "SB Saira Condensed", "Saira Condensed", sans-serif';
    for (let k = 0; k <= 7; k++) {
      const a = -RPM_NEEDLE_SWEEP + (2 * RPM_NEEDLE_SWEEP * k) / 7;
      c.lineWidth = 4;
      this.tick(cx, a, R - 22, R - 4);
      c.fillText(INT[k], cx + Math.sin(a) * (R - 40), T / 2 - Math.cos(a) * (R - 40));
    }
    c.font = '600 15px "SB Saira Condensed", "Saira Condensed", sans-serif';
    c.fillStyle = AMBER;
    c.fillText('RPM ×1000', cx, T / 2 + 42);
    // trim: TRIM_DIAL_DEG over ±60° (bow down left), a tick every 3°
    cx = 2 * T + T / 2;
    c.strokeStyle = PAPER;
    c.fillStyle = PAPER;
    c.font = '600 20px "SB Saira Condensed", "Saira Condensed", sans-serif';
    for (let d: number = TRIM_DIAL_DEG.min; d <= TRIM_DIAL_DEG.max; d += 3) {
      const a = trimNeedleRadFor(d);
      c.lineWidth = d === 0 ? 6 : 3;
      this.tick(cx, a, R - (d % 6 === 0 ? 22 : 14), R - 4);
      if (d % 6 === 0) c.fillText(d > 0 ? `+${INT[d]}` : d < 0 ? `−${INT[-d]}` : '0', cx + Math.sin(a) * (R - 40), T / 2 - Math.cos(a) * (R - 40));
    }
    c.font = '600 15px "SB Saira Condensed", "Saira Condensed", sans-serif';
    c.fillStyle = AMBER;
    c.fillText('TRIM °', cx, T / 2 + 42);
    // the needle hubs (the needle quads pivot here)
    c.fillStyle = PAPER;
    for (cx = T / 2; cx < 3 * T; cx += 2 * T) {
      c.beginPath();
      c.arc(cx, T / 2, NEEDLE_PX.hub, 0, Math.PI * 2);
      c.fill();
    }
  }

  private updateLed(m: RaceHudModel): void {
    const kn = Math.round(m.knots);
    const key = (kn < 0 ? 0 : kn > 199 ? 199 : kn) * 10000 + Math.round(m.surge * 100) * 2 + (m.surgeActive ? 1 : 0);
    if (key === this.ledKey) return;
    this.ledKey = key;
    this.dirty = true;
    const c = this.lc;
    c.fillStyle = SCREEN;
    c.fillRect(0, 0, 256, 112);
    c.font = '72px "SB Saira Stencil", "Saira Stencil One", sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'alphabetic';
    const v = kn < 0 ? 0 : kn > 199 ? 199 : kn;
    const hundreds = v >= 100 ? 1 : -1;
    const tens = v >= 10 ? Math.floor(v / 10) % 10 : -1;
    const ones = v % 10;
    c.fillStyle = m.surgeActive ? ORANGE : AMBER;
    if (hundreds > 0) c.fillText(DIGIT[1], 36, 76);
    if (tens >= 0) c.fillText(DIGIT[tens], 80, 76);
    c.fillText(DIGIT[ones], 124, 76);
    c.font = '600 18px "SB Saira Condensed", "Saira Condensed", sans-serif';
    c.fillStyle = AMBER;
    c.fillText('KN', 176, 76);
    // Surge lamps
    for (let i = 0; i < SURGE_SEGMENTS; i++) {
      const fill = surgeSegmentFill(m.surge, i);
      const x = 222;
      const y = 22 + i * 30;
      c.beginPath();
      c.arc(x, y, 10, 0, Math.PI * 2);
      c.lineWidth = 2.5;
      c.strokeStyle = ORANGE;
      c.stroke();
      if (fill > 0) {
        c.beginPath();
        c.moveTo(x, y);
        c.arc(x, y, 8, -Math.PI / 2, -Math.PI / 2 + fill * Math.PI * 2);
        c.closePath();
        c.fillStyle = ORANGE;
        c.fill();
      }
    }
  }

  private updatePlotter(m: RaceHudModel): void {
    const hc = this.course;
    if (hc === null || this.path === null) return;
    this.dirty = true;
    this.plotterDirty = true;
    const c = this.pc;
    c.fillStyle = SCREEN;
    c.fillRect(0, 0, 320, 180);
    c.lineWidth = 2.2;
    c.lineJoin = 'round';
    c.strokeStyle = AMBER;
    c.globalAlpha = 0.8;
    c.stroke(this.path);
    c.globalAlpha = 1;
    // next mark
    c.strokeStyle = ORANGE;
    c.lineWidth = 2;
    c.strokeRect(this.mx(hc.ex[m.nextElement]) - 6, this.mz(hc.ez[m.nextElement]) - 6, 12, 12);
    // rivals then player
    const n = this.hues.length;
    for (let id = 0; id < n; id++) {
      if (m.racerActive[id] !== 1 || id === this.playerId) continue;
      c.fillStyle = this.hues[id];
      c.beginPath();
      c.arc(this.mx(m.racerX[id]), this.mz(m.racerZ[id]), 4.5, 0, Math.PI * 2);
      c.fill();
    }
    if (m.racerActive[this.playerId] === 1) {
      const x = this.mx(m.racerX[this.playerId]);
      const y = this.mz(m.racerZ[this.playerId]);
      const hd = m.racerHeading[this.playerId];
      c.save();
      c.translate(x, y);
      c.rotate(hd);
      c.fillStyle = ORANGE;
      c.strokeStyle = '#F2F4EF';
      c.lineWidth = 1.2;
      c.beginPath();
      c.moveTo(0, -8);
      c.lineTo(6, 6);
      c.lineTo(0, 3);
      c.lineTo(-6, 6);
      c.closePath();
      c.fill();
      c.stroke();
      c.restore();
    }
    // footer: lap and clock, fixed advances so digits never shuffle
    c.fillStyle = 'rgba(242,181,74,0.12)';
    c.fillRect(0, 152, 320, 28);
    c.font = '600 14px "SB Saira Condensed", "Saira Condensed", sans-serif';
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    c.fillStyle = AMBER;
    c.fillText('LAP', 10, 166);
    c.fillText(INT[m.lap], 42, 166);
    c.fillText('/', 54, 166);
    c.fillText(INT[m.laps], 62, 166);
    c.textAlign = 'center';
    const t = m.lapTime >= 0 && m.lapTime < 6000 ? Math.floor(m.lapTime * 1000) : 0;
    const min = Math.floor(t / 60000);
    const sec = Math.floor(t / 1000) % 60;
    const ms = t % 1000;
    let x = 232;
    const adv = 10;
    c.fillText(DIGIT[min % 10], x, 166);
    x += adv * 0.8;
    c.fillText(':', x, 166);
    x += adv * 0.8;
    c.fillText(DIGIT[Math.floor(sec / 10)], x, 166);
    x += adv;
    c.fillText(DIGIT[sec % 10], x, 166);
    x += adv * 0.8;
    c.fillText('.', x, 166);
    x += adv * 0.8;
    c.fillText(DIGIT[Math.floor(ms / 100)], x, 166);
    x += adv;
    c.fillText(DIGIT[Math.floor(ms / 10) % 10], x, 166);
    x += adv;
    c.fillText(DIGIT[ms % 10], x, 166);
    if (m.lampsLit > 0) {
      for (let i = 0; i < COUNTDOWN_LAMPS; i++) {
        c.fillStyle = i < m.lampsLit ? '#FF3B2A' : '#2A3133';
        c.beginPath();
        c.arc(118 + i * 18, 166, 6, 0, Math.PI * 2);
        c.fill();
      }
    }
  }
}
