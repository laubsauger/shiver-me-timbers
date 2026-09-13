/**
 * HUD instruments. Each builds its DOM once and exposes `update*` methods that only write what
 * changed: Text.data from the ./text tables, SVG animated values (cx/cy, SVGTransform), cached
 * class flags and precomputed transform strings. No markup, no allocation, no layout reads in any
 * `update*` body (tests/speedboatUiHotPath.test.ts).
 */
import { h, s, svgRoot, transformOne, transformPair, txt } from './dom';
import {
  LANDING_WINDOW_DEG,
  RPM_MAX,
  RPM_REDLINE,
  SURGE_SEGMENTS,
  TRIM_DIAL_DEG,
  surgeSegmentFill,
  type HudCourse,
  type LandingWindow,
} from './model';
import type { HudRacer } from './roster';
import { DEG_MIN, DEG_TEXT, INT, MINUS, PAD2, PAD3, RPM_STEP, RPM_TEXT, SCALE_STEPS, SCALE_X, clampInt, setData } from './text';

/** a class that is written only when its state flips */
export class Flag {
  private on = false;
  constructor(private readonly el: Element, private readonly cls: string) {}
  set(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.el.classList.toggle(this.cls, on);
  }
}

/** a style.transform written from the SCALE_X table, only when the step changes */
export class ScaleBar {
  private step = -1;
  constructor(private readonly el: HTMLElement) {
    el.style.transform = SCALE_X[0];
    this.step = 0;
  }
  update(frac: number): void {
    const k = clampInt(Math.round(frac * SCALE_STEPS), 0, SCALE_STEPS);
    if (k === this.step) return;
    this.step = k;
    this.el.style.transform = SCALE_X[k];
  }
}

// ————————————————————————————————————————— numbers

const DASH_M = '–';
const DASH_SS = '––';
const DASH_MS = '–––';

/** "m:ss.mmm" as five Text nodes; NaN shows dashes */
export class ClockText {
  readonly el: HTMLSpanElement;
  private readonly m = txt(DASH_M);
  private readonly ss = txt(DASH_SS);
  private readonly ms = txt(DASH_MS);
  private lastMs = -2;
  constructor(cls: string) {
    this.el = h('span', cls, this.m, ':', this.ss, '.', this.ms);
  }
  update(seconds: number): void {
    const total = seconds >= 0 && seconds < 60000 ? Math.floor(seconds * 1000 + 1e-6) : -1;
    if (total === this.lastMs) return;
    this.lastMs = total;
    if (total < 0) {
      setData(this.m, DASH_M);
      setData(this.ss, DASH_SS);
      setData(this.ms, DASH_MS);
      return;
    }
    const min = Math.floor(total / 60000);
    setData(this.m, INT[min > 999 ? 999 : min]);
    setData(this.ss, PAD2[Math.floor(total / 1000) % 60]);
    setData(this.ms, PAD3[total % 1000]);
  }
}

/** signed gap "−0.84" / "+1.20" as four Text nodes, or a word ("Leader") */
export class GapText {
  readonly el: HTMLSpanElement;
  private readonly sign = txt('+');
  private readonly whole = txt('0');
  private readonly frac = txt('00');
  private readonly word = txt('');
  private readonly num: HTMLSpanElement;
  private readonly wordEl: HTMLSpanElement;
  private last = Number.NaN;
  private wordOn = false;
  constructor(cls: string) {
    this.num = h('span', 'sb-stencil', this.sign, this.whole, '.', this.frac);
    this.wordEl = h('span', 'sb-label', this.word);
    this.wordEl.style.display = 'none';
    this.el = h('span', cls, this.num, this.wordEl);
  }
  update(gap: number): void {
    if (this.wordOn) {
      this.wordOn = false;
      this.wordEl.style.display = 'none';
      this.num.style.display = '';
    }
    const centi = Math.round(gap * 100);
    if (centi === this.last) return;
    this.last = centi;
    const a = centi < 0 ? -centi : centi;
    setData(this.sign, centi < 0 ? MINUS : '+');
    const w = Math.floor(a / 100);
    setData(this.whole, INT[w > 999 ? 999 : w]);
    setData(this.frac, PAD2[a % 100]);
  }
  showWord(word: string): void {
    setData(this.word, word);
    if (this.wordOn) return;
    this.wordOn = true;
    this.last = Number.NaN;
    this.wordEl.style.display = '';
    this.num.style.display = 'none';
  }
}

// ————————————————————————————————————————— trim dial

const TRIM_R = 95;
const TRIM_CX = 150;
const TRIM_CY = 150;
/** dial sweep: ±60° either side of vertical for TRIM_DIAL_DEG */
const trimAngle = (deg: number): number => -60 + ((deg - TRIM_DIAL_DEG.min) * 120) / (TRIM_DIAL_DEG.max - TRIM_DIAL_DEG.min);
const polar = (r: number, aDeg: number): [number, number] => {
  const a = (aDeg * Math.PI) / 180;
  return [TRIM_CX + r * Math.sin(a), TRIM_CY - r * Math.cos(a)];
};

const WINDOW_TEXT: Record<LandingWindow, string> = { in: 'In window', high: 'Nose high', low: 'Nose low', water: 'Drive trim' };

export class TrimDial {
  readonly el: HTMLDivElement;
  private readonly dots: SVGCircleElement[] = [];
  private readonly value = txt('0°');
  private readonly label = txt('Trim');
  private readonly status = txt(WINDOW_TEXT.water);
  private readonly statusEl: HTMLSpanElement;
  private readonly needle: SVGTransform;
  private readonly hull: SVGTransform;
  private readonly air: Flag;
  private lit = -1;
  private tenth = Number.NaN;
  private window: LandingWindow | '' = '';

  constructor() {
    const svg = svgRoot('0 0 298 164', '');
    const [bx0, by0] = polar(TRIM_R, trimAngle(LANDING_WINDOW_DEG.min));
    const [bx1, by1] = polar(TRIM_R, trimAngle(LANDING_WINDOW_DEG.max));
    svg.appendChild(s('path', { class: 'sbh-trim-band', d: `M${bx0} ${by0} A${TRIM_R} ${TRIM_R} 0 0 1 ${bx1} ${by1}`, 'stroke-width': 5 }));
    for (let d = TRIM_DIAL_DEG.min; d <= TRIM_DIAL_DEG.max; d++) {
      const [x, y] = polar(TRIM_R, trimAngle(d));
      const inWin = d >= LANDING_WINDOW_DEG.min && d <= LANDING_WINDOW_DEG.max;
      const dot = s('circle', { class: inWin ? 'sbh-dot is-window' : 'sbh-dot', cx: x.toFixed(2), cy: y.toFixed(2), r: d % 6 === 0 ? 3 : 2.1 });
      this.dots.push(dot);
      svg.appendChild(dot);
    }
    for (const d of [-6, 0, 6, 12]) {
      const [x, y] = polar(TRIM_R + 18, trimAngle(d));
      const t = s('text', { class: 'sbh-trim-tick', x: x.toFixed(1), y: (y + 4).toFixed(1), 'text-anchor': 'middle', 'font-size': 14 });
      t.textContent = d > 0 ? `+${d}` : d < 0 ? `${MINUS}${-d}` : '0';
      svg.appendChild(t);
    }
    svg.appendChild(s('path', { class: 'sbh-horizon', d: 'M80 136 H220', 'stroke-width': 1.2 }));
    const hull = s('g', {},
      s('path', { class: 'sbh-hull', d: 'M-40 -6 L32 -6 Q48 -6 58 -12 L50 1 Q32 12 8 14 L-36 14 Z' }),
      s('path', { class: 'sbh-hull-band', d: 'M-40 0 L56 -8 L53 -3 L-40 5 Z' }),
    );
    svg.appendChild(hull);
    const hp = transformPair(svg, hull);
    hp.move.setTranslate(TRIM_CX, 136);
    this.hull = hp.turn;
    const needle = s('path', { class: 'sbh-needle', d: `M0 0 L0 -100`, 'stroke-width': 2.6 });
    const ng = s('g', {}, needle);
    const np = transformPair(svg, ng);
    np.move.setTranslate(TRIM_CX, TRIM_CY);
    this.needle = np.turn;
    svg.appendChild(ng);
    svg.appendChild(s('circle', { class: 'sbh-hub', cx: TRIM_CX, cy: TRIM_CY, r: 4 }));

    this.statusEl = h('span', 'sb-label sbh-trim-s is-water', this.status);
    this.el = h('div', 'sb-plane sbh-trim', svg, h('span', 'sb-label sbh-trim-l', this.label), h('span', 'sb-stencil sbh-trim-v', this.value), this.statusEl);
    this.el.dataset.panel = 'trim';
    this.air = new Flag(this.el, 'is-air');
  }

  update(attitudeDeg: number, airborne: boolean, window: LandingWindow): void {
    const a = attitudeDeg < -40 ? -40 : attitudeDeg > 40 ? 40 : attitudeDeg;
    const tenth = Math.round(a * 10);
    if (tenth !== this.tenth) {
      this.tenth = tenth;
      const clamped = a < TRIM_DIAL_DEG.min - 2 ? TRIM_DIAL_DEG.min - 2 : a > TRIM_DIAL_DEG.max + 2 ? TRIM_DIAL_DEG.max + 2 : a;
      this.needle.setRotate(trimAngle(clamped), 0, 0);
      this.hull.setRotate(-a, 0, 0);
      setData(this.value, DEG_TEXT[clampInt(Math.round(a), DEG_MIN, -DEG_MIN) - DEG_MIN]);
      const i = clampInt(Math.round(a) - TRIM_DIAL_DEG.min, 0, this.dots.length - 1);
      if (i !== this.lit) {
        if (this.lit >= 0) this.dots[this.lit].classList.remove('is-on');
        this.dots[i].classList.add('is-on');
        this.lit = i;
      }
    }
    this.air.set(airborne);
    if (window !== this.window) {
      if (this.window !== '') this.statusEl.classList.remove(this.windowClass(this.window));
      this.statusEl.classList.add(this.windowClass(window));
      this.window = window;
      setData(this.status, WINDOW_TEXT[window]);
      setData(this.label, airborne ? 'Pitch' : 'Trim');
    }
  }

  private windowClass(w: LandingWindow): string {
    return w === 'in' ? 'is-in' : w === 'high' ? 'is-high' : w === 'low' ? 'is-low' : 'is-water';
  }
}

// ————————————————————————————————————————— speed + LED tach

const TACH_DOTS = 25;

export class SpeedTach {
  readonly el: HTMLDivElement;
  private readonly dots: SVGCircleElement[] = [];
  private readonly knots = txt('0');
  private readonly rpm = txt('0');
  private readonly gov = txt('Gov · Air');
  private readonly govOff: Flag;
  private readonly surging: Flag;
  private lit = -1;
  private rpmStep = -1;
  private gov$ = '';

  constructor() {
    const svg = svgRoot('0 0 292 164', '');
    for (let i = 0; i < TACH_DOTS; i++) {
      const th = Math.PI - (i * Math.PI) / (TACH_DOTS - 1);
      const red = (i / (TACH_DOTS - 1)) * RPM_MAX >= RPM_REDLINE;
      const dot = s('circle', { class: red ? 'sbh-tach is-red' : 'sbh-tach', cx: (142 + 100 * Math.cos(th)).toFixed(2), cy: (132 - 100 * Math.sin(th)).toFixed(2), r: 3.6 });
      this.dots.push(dot);
      svg.appendChild(dot);
    }
    const govEl = h('span', 'sb-label sbh-gov', this.gov);
    this.el = h('div', 'sb-plane sbh-speed', svg,
      h('span', 'sb-stencil sbh-speed-v', this.knots),
      h('span', 'sb-label sbh-speed-l', 'kn · ', this.rpm, ' rpm'),
      govEl);
    this.el.dataset.panel = 'speed';
    this.govOff = new Flag(govEl, 'is-off');
    this.surging = new Flag(this.el, 'is-surging');
  }

  update(knots: number, rpmAvg: number, rpmFrac: number, governor: 'off' | 'air' | 'full', surgeActive: boolean): void {
    setData(this.knots, INT[clampInt(Math.round(knots), 0, 999)]);
    const step = clampInt(Math.round(rpmAvg / RPM_STEP), 0, RPM_TEXT.length - 1);
    if (step !== this.rpmStep) {
      this.rpmStep = step;
      setData(this.rpm, RPM_TEXT[step]);
    }
    const lit = clampInt(Math.round(rpmFrac * (TACH_DOTS - 1)), 0, TACH_DOTS - 1) + (rpmFrac > 0.01 ? 1 : 0);
    if (lit !== this.lit) {
      const from = this.lit < 0 ? 0 : this.lit;
      if (lit > from) for (let i = from; i < lit; i++) this.dots[i].classList.add('is-on');
      else for (let i = lit; i < from; i++) this.dots[i].classList.remove('is-on');
      this.lit = lit;
    }
    if (governor !== this.gov$) {
      this.gov$ = governor;
      setData(this.gov, governor === 'off' ? 'Gov · Off' : governor === 'air' ? 'Gov · Air' : 'Gov · Full');
      this.govOff.set(governor === 'off');
    }
    this.surging.set(surgeActive);
  }
}

// ————————————————————————————————————————— surge cells

export class SurgeCells {
  readonly el: HTMLDivElement;
  private readonly bars: ScaleBar[] = [];
  private readonly full: Flag[] = [];
  private readonly filling: Flag[] = [];
  private last = -1;

  constructor() {
    const cells: HTMLElement[] = [];
    for (let i = 0; i < SURGE_SEGMENTS; i++) {
      const fill = h('i');
      const cell = h('div', 'sbh-cell', fill);
      this.bars.push(new ScaleBar(fill));
      this.full.push(new Flag(cell, 'is-full'));
      this.filling.push(new Flag(cell, 'is-filling'));
      cells.push(cell);
    }
    this.el = h('div', 'sb-plane sbh-surge', h('span', 'sb-label sbh-surge-l', 'Surge'), ...cells);
    this.el.dataset.panel = 'surge';
  }

  update(surge: number): void {
    const q = Math.round(surge * 200);
    if (q === this.last) return;
    this.last = q;
    for (let i = 0; i < SURGE_SEGMENTS; i++) {
      const f = surgeSegmentFill(surge, i);
      this.bars[i].update(f);
      this.full[i].set(f >= 1);
      this.filling[i].set(f > 0 && f < 1);
    }
  }
}

// ————————————————————————————————————————— plotter

const PLOT_W = 170;
const PLOT_H = 128;
const PLOT_PAD = 7;

/**
 * North-up plotter. Why not heading-up: over three laps of one closed circuit the player learns
 * the course as a SHAPE (hairpin at the tower, the Bar, Pylon Row), and a fixed shape is what makes
 * "Crosswind is two corners ahead" readable at a glance. A rotating map re-draws that shape every
 * turn, and the egocentric job ("where do I steer now") is already done by the gate marker in the
 * 3D view. The cockpit plotter is a tablet strapped to the dash and does not rotate either.
 */
export class Plotter {
  readonly el: HTMLDivElement;
  private readonly svg: SVGSVGElement;
  private readonly courseG: SVGGElement;
  private readonly dotsG: SVGGElement;
  private readonly next: SVGRectElement;
  private readonly nextMove: SVGTransform;
  private dots: SVGCircleElement[] = [];
  private dotShown: boolean[] = [];
  private you: SVGPathElement | null = null;
  private youMove: SVGTransform | null = null;
  private youTurn: SVGTransform | null = null;
  private playerId = 0;
  private readonly label = txt('');
  private readonly dist = txt('0');
  private labelStr = '';
  private distStep = -1;
  private nextIdx = -1;
  private sx = 1;
  private ox = 0;
  private oz = 0;
  private minX = 0;
  private minZ = 0;
  private course: HudCourse | null = null;

  constructor() {
    this.svg = svgRoot(`0 0 ${PLOT_W} ${PLOT_H}`, '');
    this.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    this.courseG = s('g');
    this.dotsG = s('g');
    this.next = s('rect', { class: 'sbh-plot-next', x: -5, y: -5, width: 10, height: 10, 'stroke-width': 1.8 });
    this.nextMove = transformOne(this.svg, this.next);
    this.svg.append(this.courseG, this.next, this.dotsG);
    this.el = h('div', 'sb-plane sbh-plot', this.svg, h('span', 'sb-label sbh-plot-label', this.label, ' next · ', this.dist, ' m'));
    this.el.dataset.panel = 'plotter';
  }

  /** build the course drawing (edge: once per course) */
  setCourse(hc: HudCourse): void {
    this.course = hc;
    const c = hc.course;
    const dx = Math.max(1, c.bounds.max[0] - c.bounds.min[0]);
    const dz = Math.max(1, c.bounds.max[1] - c.bounds.min[1]);
    this.sx = Math.min((PLOT_W - 2 * PLOT_PAD) / dx, (PLOT_H - 2 * PLOT_PAD) / dz);
    this.minX = c.bounds.min[0];
    this.minZ = c.bounds.min[1];
    this.ox = (PLOT_W - dx * this.sx) / 2;
    this.oz = (PLOT_H - dz * this.sx) / 2;
    this.courseG.replaceChildren();
    const pts = c.referenceLine.map(([x, z]) => `${this.mx(x).toFixed(1)} ${this.mz(z).toFixed(1)}`);
    if (pts.length > 1) this.courseG.appendChild(s('path', { class: 'sbh-plot-line', d: `M${pts.join(' L')} Z`, 'stroke-width': 2.6 }));
    c.elements.forEach((e, i) => {
      if (e.kind === 'gate') {
        const [lx, lz] = e.gate.left;
        const [rx, rz] = e.gate.right;
        if (hc.labels[i] === 'S/F') {
          const x = this.mx((lx + rx) / 2);
          const y = this.mz((lz + rz) / 2);
          this.courseG.appendChild(s('path', { class: 'sbh-plot-sf', d: `M${x} ${y - 7} L${x - 5} ${y + 2} L${x + 5} ${y + 2} Z` }));
        } else {
          this.courseG.appendChild(s('line', { class: 'sbh-plot-tick', x1: this.mx(lx), y1: this.mz(lz), x2: this.mx(rx), y2: this.mz(rz), 'stroke-width': 2.4 }));
        }
      } else {
        this.courseG.appendChild(s('circle', { class: 'sbh-plot-tick', cx: this.mx(e.mark.at[0]), cy: this.mz(e.mark.at[1]), r: 2.2, fill: 'none', 'stroke-width': 1.4 }));
      }
    });
    this.nextIdx = -1;
  }

  /** build racer dots (edge: once per roster) */
  setRoster(roster: readonly HudRacer[], fieldCap: number): void {
    this.dotsG.replaceChildren();
    this.dots = [];
    this.dotShown = [];
    for (let id = 0; id < fieldCap; id++) {
      const r = roster.find((x) => x.racerId === id);
      const dot = s('circle', { class: 'sbh-plot-dot', r: 4.6, fill: r ? r.hue : '#9FB2B0', stroke: r?.ring || 'none', 'stroke-width': r?.ring ? 1.6 : 0 });
      dot.style.visibility = 'hidden';
      this.dots.push(dot);
      this.dotShown.push(false);
      if (r?.isPlayer) {
        this.playerId = id;
        continue;
      }
      this.dotsG.appendChild(dot);
    }
    const player = roster.find((x) => x.isPlayer);
    this.you = s('path', { class: 'sbh-plot-you', d: 'M0 -7 L5 5 L0 2.5 L-5 5 Z', 'stroke-width': 1.2, fill: player?.hue ?? '#FF6B1F' });
    const g = s('g', {}, this.you);
    const tp = transformPair(this.svg, g);
    this.youMove = tp.move;
    this.youTurn = tp.turn;
    this.dotsG.appendChild(g);
  }

  private mx(x: number): number {
    return this.ox + (x - this.minX) * this.sx;
  }
  private mz(z: number): number {
    return this.oz + (z - this.minZ) * this.sx;
  }

  update(racerX: Float32Array, racerZ: Float32Array, racerHeading: Float32Array, active: Uint8Array, nextElement: number, nextLabel: string, distanceM: number): void {
    const hc = this.course;
    if (hc === null) return;
    const n = this.dots.length;
    for (let id = 0; id < n; id++) {
      const on = active[id] === 1;
      if (id === this.playerId) {
        if (on && this.youMove !== null && this.youTurn !== null) {
          this.youMove.setTranslate(this.mx(racerX[id]), this.mz(racerZ[id]));
          this.youTurn.setRotate((racerHeading[id] * 180) / Math.PI, 0, 0);
        }
        continue;
      }
      const dot = this.dots[id];
      if (on !== this.dotShown[id]) {
        this.dotShown[id] = on;
        dot.style.visibility = on ? 'visible' : 'hidden';
      }
      if (!on) continue;
      dot.cx.baseVal.value = this.mx(racerX[id]);
      dot.cy.baseVal.value = this.mz(racerZ[id]);
    }
    if (nextElement !== this.nextIdx) {
      this.nextIdx = nextElement;
      this.nextMove.setTranslate(this.mx(hc.ex[nextElement]), this.mz(hc.ez[nextElement]));
    }
    if (nextLabel !== this.labelStr) {
      this.labelStr = nextLabel;
      setData(this.label, nextLabel);
    }
    const step = clampInt(Math.round(distanceM / 10), 0, 999);
    if (step !== this.distStep) {
      this.distStep = step;
      setData(this.dist, INT[step * 10 > 999 ? 999 : step * 10]);
    }
  }
}
