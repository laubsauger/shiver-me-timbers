/**
 * The in-race overlay: chase HUD, cockpit overlay, rolling start + countdown, crash overlay, ghost
 * chip, finish call. One DOM tree built once; `update(model, dt)` is the only per-frame entry.
 *
 * Hot-path contract (tests/speedboatUiHotPath.test.ts): `update*` bodies write Text.data from the
 * ./text tables, SVGTransforms, cached flags and table transforms only. Anything that must build a
 * string (the crash cause line, the conditions line) lives in a `rebuild*` method that runs on an
 * edge: its call site is guarded by a change check, so it runs once per event, not per frame.
 */
import { h, s, svgRoot, transformPair, txt } from './dom';
import { ClockText, Flag, GapText, Plotter, ScaleBar, SpeedTach, SurgeCells, TrimDial } from './gauges';
import { unitFor } from './layout';
import {
  CRASH_TITLES,
  SEA_HEADING_LABEL,
  TOAST_S,
  formatCrashCause,
  type CrashKind,
  type HudCourse,
  type RaceHudModel,
  type SeaHeading,
} from './model';
import type { HudRacer } from './roster';
import { INT, setData } from './text';

const RC = 'RC · ch16';
const RC_ALL = 'RC · ch16 → all stations';

export class RaceHud {
  readonly root: HTMLDivElement;
  private readonly frame: HTMLDivElement;
  private roster: readonly HudRacer[] = [];
  private course: HudCourse | null = null;

  // position block
  private readonly posEl: HTMLDivElement;
  private readonly posP = txt('1');
  private readonly posN = txt('8');
  private readonly lapV = txt('1');
  private readonly lapN = txt('3');
  private readonly gain: Flag;
  private readonly loss: Flag;
  private readonly ghostOn: Flag;
  private readonly ghostBar: ScaleBar;

  // standings
  private readonly rowEls: HTMLDivElement[] = [];
  private readonly rowP: Text[] = [];
  private readonly rowName: Text[] = [];
  private readonly rowGap: GapText[] = [];
  private readonly rowYou: Flag[] = [];
  private readonly rowHidden: Flag[] = [];
  private readonly rowRacer: number[] = [-1, -1, -1];

  // clock
  private readonly lapClock = new ClockText('sb-stencil sbh-timer-v sb-float');
  private readonly lastClock = new ClockText('');
  private readonly bestClock = new ClockText('');

  // radio
  private readonly radioEl: HTMLDivElement;
  private readonly radioLine = txt('');
  private readonly radioCh = txt(RC);
  private readonly crashRadioLine = txt('');
  private readonly radioLive: Flag;
  private readonly radioQuiet: Flag;
  private radioId = -1;
  private radioAge = 99;
  private readonly startRules = txt('');
  private readonly startRulesWarn = txt('');

  // instruments
  private readonly trim = new TrimDial();
  private readonly speed = new SpeedTach();
  private readonly surge = new SurgeCells();
  private readonly plotter = new Plotter();
  private readonly seaText = txt('');
  private sea$: SeaHeading | '' = '';
  private swellTenth = -1;

  // gate marker
  private readonly gateSvg: SVGSVGElement;
  private readonly gateMove: SVGTransform;
  private readonly arrowTurn: SVGTransform;
  private readonly gateText: SVGTextElement;
  private readonly gateLabel = txt('');
  private readonly gateDist = txt('0');
  private readonly gateHidden: Flag;
  private gateLabel$ = '';
  private gateDistStep = -1;
  private gateSide = 2;
  private vw = 1280;
  private vh = 720;
  private px = 1;
  private scale = 1;

  // toast
  private readonly toastOn: Flag;
  private readonly toastT = txt('');
  private readonly toastD = txt('');
  private toastId = -1;

  // start
  private readonly lamps: Flag[] = [];
  private readonly countV = txt('');
  private readonly countL = txt('');
  private readonly countGreen: Flag;
  private readonly gridP = txt('1');
  private readonly gridN = txt('8');
  private readonly condTop = txt('');
  private readonly condLine = txt('');
  private lampsLit = -1;
  private count$ = -1;
  private cond$ = '';
  private tod$ = '';
  private pace$ = -1;

  // crash
  private readonly crashTitle = txt('');
  private readonly crashCause = txt('');
  private readonly slowTag = txt('');
  private readonly slowOff: Flag;
  private readonly crashBar: ScaleBar;
  private readonly crashFrom = txt('1');
  private readonly crashTo = txt('1');
  private readonly crashSame: Flag;
  private crashId = -1;

  // finish
  private readonly finishP = txt('1');
  private readonly finishL = txt('Finished');

  // phase flags
  private readonly fChase: Flag;
  private readonly fCockpit: Flag;
  private readonly fStart: Flag;
  private readonly fHideRace: Flag;
  private readonly fCrash: Flag;
  private readonly fCrashCam: Flag;
  private readonly fFinished: Flag;

  constructor(parent: HTMLElement) {
    // — position + lap
    const trend = svgRoot('0 0 18 18', 'sbh-pos-trend', s('path', { d: 'M9 2 L17 15 L1 15 Z' }));
    const ghostFill = h('i', 'sbh-ghost-fill');
    const ghost = h('div', 'sb-label sbh-ghost', 'Ghost', h('span', 'sbh-ghost-bar', ghostFill));
    this.posEl = h('div', 'sb-plane sbh-pos',
      h('span', 'sb-stencil sbh-pos-p', 'P', this.posP),
      h('span', 'sb-stencil sbh-pos-n', '/', this.posN),
      trend,
      h('div', 'sbh-lap', h('span', 'sb-label sbh-lap-l', 'Lap'), h('span', 'sb-stencil sbh-lap-v', this.lapV, '/', this.lapN)),
      ghost);
    this.posEl.dataset.panel = 'position';
    this.gain = new Flag(this.posEl, 'is-gain');
    this.loss = new Flag(this.posEl, 'is-loss');
    this.ghostOn = new Flag(ghost, 'is-on');
    this.ghostBar = new ScaleBar(ghostFill);

    // — standings
    const rows = h('div', 'sbh-rows');
    rows.dataset.panel = 'standings';
    for (let i = 0; i < 3; i++) {
      const p = txt('1');
      const name = txt('');
      const gap = new GapText('sbh-row-gap');
      const row = h('div', 'sb-plane sbh-row', h('span', 'sbh-swatch'), h('span', 'sb-stencil sbh-row-p', 'P', p), h('span', 'sb-label sbh-row-name', name), gap.el);
      rows.appendChild(row);
      this.rowEls.push(row);
      this.rowP.push(p);
      this.rowName.push(name);
      this.rowGap.push(gap);
      this.rowYou.push(new Flag(row, 'is-you'));
      this.rowHidden.push(new Flag(row, 'is-hidden'));
    }

    // — clock
    const sep = (): HTMLSpanElement => h('span', 'sep', '·');
    const timer = h('div', 'sbh-timer',
      this.lapClock.el,
      h('span', 'sb-label sbh-timer-sub sb-float', 'Last ', this.lastClock.el, sep(), 'Best ', this.bestClock.el));
    timer.dataset.panel = 'timer';

    // — radio
    const bars = h('span', 'sbh-radio-bars', h('i'), h('i'), h('i'), h('i'));
    this.radioEl = h('div', 'sb-plane sbh-radio', bars, h('span', 'sb-label sbh-radio-ch', this.radioCh), h('span', 'sbh-radio-line', this.radioLine),
      h('div', 'sb-label sbh-radio-sub sb-float', this.startRules, h('b', '', this.startRulesWarn)));
    this.radioEl.dataset.panel = 'radio';
    this.radioLive = new Flag(this.radioEl, 'is-live');
    this.radioQuiet = new Flag(this.radioEl, 'is-quiet');

    // — sea chip
    const sea = h('div', 'sb-plane sb-label sbh-sea', svgRoot('0 0 10 10', '', s('path', { d: 'M1 0 L10 5 L1 10 Z' })), this.seaText);
    sea.dataset.panel = 'sea';

    this.frame = h('div', 'sbh-frame', this.posEl, rows, timer, this.radioEl, this.plotter.el, sea, this.trim.el, this.surge.el, this.speed.el);

    // — gate marker (viewport px)
    this.gateSvg = svgRoot('0 0 1 1', 'sbh-gate');
    this.gateSvg.removeAttribute('viewBox');
    const arrow = s('path', { class: 'sbh-gate-arrow', d: 'M-12 -18 L12 -18 L0 0 Z' });
    const arrowG = s('g', {}, arrow);
    const at = transformPair(this.gateSvg, arrowG);
    this.arrowTurn = at.turn;
    this.gateText = s('text', { class: 'sbh-gate-text', x: 0, y: -28, 'text-anchor': 'middle', 'font-size': 17 });
    this.gateText.append(this.gateLabel, ' · ', this.gateDist, ' M');
    const gateG = s('g', {}, arrowG, this.gateText);
    const gm = transformPair(this.gateSvg, gateG);
    this.gateMove = gm.move;
    this.gateSvg.appendChild(gateG);
    this.gateHidden = new Flag(this.gateSvg, 'is-hidden');

    // — toast
    const toast = h('div', 'sbh-toast sb-float', h('span', 'sb-stencil sbh-toast-t', this.toastT), h('span', 'sb-label sbh-toast-d', this.toastD));
    this.toastOn = new Flag(toast, 'is-on');

    // — rolling start + countdown
    const lampRow = h('div', 'sbh-lamps-row');
    for (let i = 0; i < 5; i++) {
      const lamp = h('span', 'sbh-lamp');
      lampRow.appendChild(lamp);
      this.lamps.push(new Flag(lamp, 'is-on'));
    }
    const count = h('div', 'sbh-count sb-float', h('span', 'sb-stencil sbh-count-v', this.countV), h('span', 'sb-label sbh-count-l', this.countL));
    this.countGreen = new Flag(count, 'is-green');
    const start = h('div', 'sbh-start',
      h('div', 'sb-plane sbh-lamps', h('div', 'sb-label sbh-lamps-l', 'Tower lamps'), lampRow),
      count,
      h('div', 'sb-plane sbh-chip is-grid', h('div', 'sb-label sbh-chip-l', 'Grid'), h('div', 'sb-stencil sbh-chip-v', 'P', this.gridP, ' / ', this.gridN)),
      h('div', 'sb-plane sbh-chip is-cond', h('div', 'sb-label sbh-chip-l', this.condTop), h('div', 'sb-label sbh-chip-t', this.condLine)));

    // — crash
    const crashFill = h('i');
    const crashBar = h('div', 'sbh-crash-bar', crashFill);
    const tag = h('div', 'sb-label sbh-crash-tag', this.slowTag);
    const crashPos = h('div', 'sb-stencil sbh-crash-pos sb-float', h('span', '', 'P', this.crashFrom),
      svgRoot('0 0 34 24', '', s('path', { d: 'M0 9 H20 V1 L34 12 L20 23 V15 H0 Z' })), h('span', 'to', 'P', this.crashTo));
    const crash = h('div', 'sbh-crash',
      h('div', 'sbh-crash-tint'),
      h('div', 'sbh-letterbox is-top'), h('div', 'sbh-letterbox is-bottom'),
      h('div', 'sbh-crash-body',
        h('div', 'sb-stencil sbh-crash-t sb-float', this.crashTitle),
        h('div', 'sb-label sbh-crash-c sb-float', this.crashCause),
        tag,
        h('div', 'sb-plane sbh-crash-radio', h('span', 'sb-label sbh-radio-ch', RC), h('span', 'sbh-radio-line', this.crashRadioLine)),
        h('div', 'sb-label sbh-crash-gov sb-float', 'Governor: fuel cut · resetting on the racing line'),
        crashBar,
        h('div', 'sb-label sbh-crash-skip sb-float', 'Hold R · View to skip'),
        crashPos));
    this.slowOff = new Flag(tag, 'is-off');
    this.crashBar = new ScaleBar(crashFill);
    this.crashSame = new Flag(crashPos, 'is-same');

    // — finish
    const finish = h('div', 'sbh-finish sb-float', h('span', 'sb-stencil sbh-finish-t', 'P', this.finishP), h('span', 'sb-label sbh-finish-l', this.finishL));

    this.root = h('div', 'sb-ui sbh is-chase', start, this.frame, this.gateSvg, toast, crash, finish);
    this.root.setAttribute('aria-hidden', 'true');
    this.fChase = new Flag(this.root, 'is-chase');
    this.fChase.set(true);
    this.fCockpit = new Flag(this.root, 'is-cockpit');
    this.fStart = new Flag(this.root, 'is-start');
    this.fHideRace = new Flag(this.root, 'is-hidden-race');
    this.fCrash = new Flag(this.root, 'is-crash');
    this.fCrashCam = new Flag(this.root, 'is-crashcam');
    this.fFinished = new Flag(this.root, 'is-finished');
    parent.appendChild(this.root);
    this.resize(window.innerWidth, window.innerHeight);
  }

  /** edge: once per roster (names, swatches, plotter dots) */
  setRoster(roster: readonly HudRacer[], fieldCap = 8): void {
    this.roster = roster;
    this.plotter.setRoster(roster, fieldCap);
    const player = roster.find((r) => r.isPlayer);
    if (player) this.root.style.setProperty('--player', player.hue);
    for (let i = 0; i < 3; i++) this.rowRacer[i] = -1;
  }

  /** edge: once per course */
  setCourse(hc: HudCourse): void {
    this.course = hc;
    this.plotter.setCourse(hc);
    this.cond$ = '';
  }

  /** edge: on window resize (the gate marker works in viewport px) */
  resize(vw: number, vh: number): void {
    this.vw = vw;
    this.vh = vh;
    this.px = unitFor(vw, vh) * this.scale;
    this.gateText.setAttribute('font-size', (14 * this.px).toFixed(2));
    this.gateText.setAttribute('y', (-22 * this.px).toFixed(2));
    const a = 9 * this.px;
    this.gateSvg.querySelector('.sbh-gate-arrow')?.setAttribute('d', `M${-a} ${-1.5 * a} L${a} ${-1.5 * a} L0 0 Z`);
  }

  /** edge: HUD size option (layout.ts HUD_SCALES); one CSS variable scales the whole race HUD */
  setScale(scale: number): void {
    this.scale = scale;
    this.root.style.setProperty('--hud-scale', String(scale));
    this.resize(this.vw, this.vh);
  }

  update(m: RaceHudModel, dt: number): void {
    const cockpit = m.camera === 'cockpit';
    this.fCockpit.set(cockpit);
    this.fChase.set(!cockpit);
    const starting = m.phase === 'prestart' || m.phase === 'rolling' || m.phase === 'countdown' || m.greenS > 0;
    const crashing = m.crash === 'crash' || m.crash === 'respawn';
    const finished = m.phase === 'finished' && m.finished;
    this.fStart.set(starting);
    this.fHideRace.set(starting || finished);
    this.fCrash.set(crashing);
    this.fCrashCam.set(m.crash === 'crash');
    this.fFinished.set(finished);

    this.updatePosition(m);
    this.updateRows(m);
    this.lapClock.update(m.lapTime);
    this.lastClock.update(m.lastLap);
    this.bestClock.update(m.bestLap);
    this.updateRadio(m, dt);
    // trim + speed show in both layouts (cockpit overlay carries them until the 3D dash displays are mounted)
    this.trim.update(m.attitudeDeg, m.airborne, m.landing);
    this.speed.update(m.knots, m.rpmAvg, m.rpmFrac, m.governor, m.surgeActive);
    if (!cockpit) {
      this.surge.update(m.surge);
      this.plotter.update(m.racerX, m.racerZ, m.racerHeading, m.racerActive, m.nextElement, m.nextLabel, m.gateDistanceM);
      if (m.seaHeading !== this.sea$ || Math.round(m.swellM * 10) !== this.swellTenth) this.rebuildSea(m.seaHeading, m.swellM);
    }
    this.updateGate(m, starting || crashing || finished);
    this.updateToast(m);
    if (starting) this.updateStart(m);
    if (crashing) this.updateCrash(m);
    if (finished) setData(this.finishP, INT[m.position]);
  }

  private updatePosition(m: RaceHudModel): void {
    setData(this.posP, INT[m.position]);
    setData(this.posN, INT[m.fieldSize]);
    setData(this.lapV, INT[m.lap]);
    setData(this.lapN, INT[m.laps]);
    this.gain.set(m.positionTrend > 0);
    this.loss.set(m.positionTrend < 0);
    this.ghostOn.set(m.crash === 'ghost');
    if (m.crash === 'ghost') this.ghostBar.update(m.ghostProgress);
  }

  private updateRows(m: RaceHudModel): void {
    for (let i = 0; i < 3; i++) {
      const row = m.rows[i];
      this.rowHidden[i].set(!row.visible);
      if (!row.visible) continue;
      if (row.racerId !== this.rowRacer[i]) this.rebuildRow(i, row.racerId);
      setData(this.rowP[i], INT[row.position]);
      this.rowYou[i].set(row.isPlayer);
      if (row.isPlayer && row.position === 1) this.rowGap[i].showWord('Leader');
      else this.rowGap[i].update(row.gap);
    }
  }

  /** edge: a different racer moved into this row */
  private rebuildRow(i: number, racerId: number): void {
    this.rowRacer[i] = racerId;
    const r = this.roster.find((x) => x.racerId === racerId);
    setData(this.rowName[i], r ? (r.isPlayer ? 'You' : `${r.number} ${r.boat}`) : `#${racerId}`);
    const sw = this.rowEls[i].firstElementChild as HTMLElement;
    sw.style.background = r ? r.hue : '#9FB2B0';
    sw.style.setProperty('--ring', r && r.ring ? r.ring : 'transparent');
  }

  private updateRadio(m: RaceHudModel, dt: number): void {
    if (m.radioId !== this.radioId) {
      this.radioId = m.radioId;
      this.radioAge = 0;
      setData(this.radioLine, m.radioText);
      setData(this.crashRadioLine, m.radioText);
      setData(this.radioCh, m.radioTo === '' ? RC : RC_ALL);
    } else if (this.radioAge < 99) {
      this.radioAge += dt;
    }
    this.radioLive.set(this.radioAge < 2.4);
    this.radioQuiet.set(this.radioAge > 8);
  }

  /** edge: sea heading or swell changed */
  private rebuildSea(heading: SeaHeading, swellM: number): void {
    this.sea$ = heading;
    this.swellTenth = Math.round(swellM * 10);
    setData(this.seaText, `${SEA_HEADING_LABEL[heading]} · ${(this.swellTenth / 10).toFixed(1)} m`);
  }

  private updateGate(m: RaceHudModel, hide: boolean): void {
    this.gateHidden.set(hide || m.finished);
    if (hide || m.finished) return;
    if (m.nextLabel !== this.gateLabel$) {
      this.gateLabel$ = m.nextLabel;
      setData(this.gateLabel, m.nextLabel);
    }
    const step = Math.round(m.gateDistanceM / 10);
    if (step !== this.gateDistStep) {
      this.gateDistStep = step;
      setData(this.gateDist, INT[step * 10 > 999 ? 999 : step * 10]);
    }
    // on screen: the page's projection; otherwise bearing → a point on the horizon, or the side edge
    const b = m.gateBearingRad;
    let x: number;
    let y: number;
    let side = 0;
    if (m.gateOnScreen) {
      x = m.gateScreenX * this.vw;
      y = m.gateScreenY * this.vh - 20 * this.px;
    } else if (b > -0.5 && b < 0.5) {
      x = (0.5 + b / 1.1) * this.vw;
      y = 0.4 * this.vh;
    } else {
      side = b > 0 ? 1 : -1;
      x = side > 0 ? this.vw - 70 * this.px : 70 * this.px;
      y = 0.44 * this.vh;
    }
    this.gateMove.setTranslate(x, y);
    if (side !== this.gateSide) {
      this.gateSide = side;
      this.arrowTurn.setRotate(side * -90, 0, 0);
    }
  }

  private updateToast(m: RaceHudModel): void {
    if (m.wrongWay) {
      if (this.toastId !== -2) {
        this.toastId = -2;
        setData(this.toastT, 'Wrong way');
        setData(this.toastD, 'Turn back to the course');
      }
      this.toastOn.set(true);
      return;
    }
    if (m.toastId !== this.toastId) {
      this.toastId = m.toastId;
      setData(this.toastT, m.toastTitle);
      setData(this.toastD, m.toastDetail);
    }
    this.toastOn.set(m.toastAgeS < TOAST_S && m.toastTitle !== '' && m.crash !== 'crash' && m.crash !== 'respawn');
  }

  private updateStart(m: RaceHudModel): void {
    const lit = m.lampsLit;
    if (lit !== this.lampsLit) {
      this.lampsLit = lit;
      for (let i = 0; i < this.lamps.length; i++) this.lamps[i].set(i < lit);
    }
    const c = m.greenS > 0 ? 0 : m.countdown;
    const code = m.greenS > 0 ? -2 : m.phase === 'countdown' ? c : m.phase === 'rolling' ? -3 : -4;
    if (code !== this.count$) {
      this.count$ = code;
      this.countGreen.set(code === -2);
      setData(this.countV, code === -2 ? 'Green' : code > 0 ? INT[c] : '');
      setData(this.countL, code === -2 ? '' : code > 0 ? 'Hold your lane' : code === -3 ? 'Follow the marshal skiff' : 'Grid forming');
    }
    setData(this.gridP, INT[m.position]);
    setData(this.gridN, INT[m.fieldSize]);
    if (m.seaLabel !== this.cond$ || m.timeOfDay !== this.tod$) this.rebuildConditions(m);
    if (m.paceKn !== this.pace$) this.rebuildRules(m.paceKn);
  }

  /** edge: conditions changed */
  private rebuildConditions(m: RaceHudModel): void {
    this.cond$ = m.seaLabel;
    this.tod$ = m.timeOfDay;
    const c = this.course?.course;
    setData(this.condTop, c ? `${c.name} · ${c.laps} laps` : '');
    const wind = m.windKn > 0 ? ` · wind ${Math.round(m.windKn)} kn ${m.windFrom}` : '';
    setData(this.condLine, `${m.seaLabel} · ${m.timeOfDay}${wind}`);
  }

  /** edge: pace speed changed */
  private rebuildRules(paceKn: number): void {
    this.pace$ = paceKn;
    setData(this.startRules, `Throttle held at ${Math.round(paceKn)} kn · steering free · `);
    setData(this.startRulesWarn, 'cross early = +5 s');
  }

  private updateCrash(m: RaceHudModel): void {
    if (m.crashId !== this.crashId) this.rebuildCrash(m.crashId, m.crashKind, m.crashSpeedKn, m.crashStopS, m.crashPeakG, m.slowMo);
    this.slowOff.set(m.crash !== 'crash' || m.slowMo >= 1);
    this.crashBar.update(m.respawnProgress);
    setData(this.crashFrom, INT[m.positionBeforeCrash]);
    setData(this.crashTo, INT[m.position]);
    this.crashSame.set(m.positionBeforeCrash === m.position);
  }

  /** edge: a new crash */
  private rebuildCrash(id: number, kind: CrashKind, speedKn: number, stopS: number, peakG: number, slowMo: number): void {
    this.crashId = id;
    setData(this.crashTitle, CRASH_TITLES[kind]);
    setData(this.crashCause, formatCrashCause(kind, speedKn, stopS, peakG));
    setData(this.slowTag, `Slow-mo ${slowMo.toFixed(2)}×`);
  }

  /**
   * §T.201 the pause for mouse users (Esc and gamepad Start are the others): a small plane left of the plotter. It
   * lives in the HUD frame so it hides with the HUD under every screen. Built once; `onClick` is the page's openPause.
   */
  addPauseButton(onClick: () => void): HTMLButtonElement {
    const b = h('button', 'sbp-btn', svgRoot('0 0 12 14', '', s('path', { d: 'M0 0 H4 V14 H0 Z M8 0 H12 V14 H8 Z' })));
    b.type = 'button';
    b.tabIndex = -1; // the HUD root is aria-hidden; Esc is the keyboard path
    b.title = 'Pause (Esc)';
    b.addEventListener('click', (e) => {
      e.preventDefault();
      b.blur();
      onClick();
    });
    this.frame.appendChild(b);
    return b;
  }

  /** edge: hide the in-race layer while a full screen (pause, results, select) is up */
  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
  }

  dispose(): void {
    this.root.remove();
  }
}
