/**
 * UI harness page (speedboat-ui-harness.html): every HUD state and screen, driven by the fake race
 * in ./harnessTimeline, over a neutral sea or a concept still.
 *
 * URL: ?t=<seconds>|<moment> &cam=chase|cockpit &screen=select|pause|assists|audio|results
 *      &bg=sea|chase|cockpit|none &bar=0 &play=0 &wrong=1
 * Keys: Space play/pause · ←/→ scrub · V camera · P pause screen · B boat select · H harness bar
 * `window.__sbHarness` exposes seek/cam/open/rects for browser checks.
 */
import {
  ASSIST_PRESETS,
  BoatSelectScreen,
  DEFAULT_SELECTION,
  DashDisplays,
  PauseScreen,
  RaceHud,
  ResultsScreen,
  buildResults,
  buildRoster,
  createRaceHudModel,
  injectSpeedboatUiCss,
  loadSpeedboatFonts,
  lowerCentreKeepOut,
  prepareCourse,
  updateRaceHudModel,
  CHASE_PANELS,
  COCKPIT_PANELS,
  placePanel,
  type HudCamera,
  type HudRacer,
} from './index';
import { HARNESS_COURSE, MOMENTS, T_END, T_RESULTS, createSample, sampleAt } from './harnessTimeline';
import { h, s, svgRoot } from './dom';

const params = new URLSearchParams(location.search);
const app = document.getElementById('app') as HTMLDivElement;

injectSpeedboatUiCss();

// ————————————————————————————————————————— background

function seaScene(): SVGSVGElement {
  const svg = svgRoot('0 0 1280 720', 'hx-scene');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
  const defs = s('defs', {},
    s('linearGradient', { id: 'hxSky', x1: 0, y1: 0, x2: 0, y2: 1 }, s('stop', { offset: 0, 'stop-color': '#76ABBE' }), s('stop', { offset: 0.62, 'stop-color': '#D5DCCB' }), s('stop', { offset: 1, 'stop-color': '#F0C48C' })),
    s('linearGradient', { id: 'hxSea', x1: 0, y1: 0, x2: 0, y2: 1 }, s('stop', { offset: 0, 'stop-color': '#4E8F8F' }), s('stop', { offset: 0.35, 'stop-color': '#1E4B50' }), s('stop', { offset: 1, 'stop-color': '#081E20' })),
    s('radialGradient', { id: 'hxSun' }, s('stop', { offset: 0, 'stop-color': '#FFF2D2' }), s('stop', { offset: 0.3, 'stop-color': '#FFDDA0', 'stop-opacity': 0.7 }), s('stop', { offset: 1, 'stop-color': '#FFCF88', 'stop-opacity': 0 })),
    s('filter', { id: 'hxBlur' }, s('feGaussianBlur', { stdDeviation: 4 })));
  svg.append(defs,
    s('rect', { width: 1280, height: 332, fill: 'url(#hxSky)' }),
    s('circle', { cx: 880, cy: 300, r: 170, fill: 'url(#hxSun)' }),
    s('path', { d: 'M0 332 L0 316 Q70 290 140 308 Q200 284 270 302 Q330 296 360 332 Z M620 332 Q700 300 780 312 Q840 296 900 318 L940 332 Z M1150 332 Q1190 296 1240 300 L1280 312 L1280 332 Z', fill: '#A6BDBB' }),
    s('path', { d: 'M1036 332 L1046 150 L1056 332', stroke: '#34484B', 'stroke-width': 2.4, fill: 'none' }),
    s('circle', { cx: 1046, cy: 150, r: 4, fill: '#FF3B2A' }),
    s('rect', { y: 332, width: 1280, height: 388, fill: 'url(#hxSea)' }),
    s('path', { d: 'M866 332 L894 332 L1050 720 L730 720 Z', fill: '#FFE2A6', opacity: 0.12 }),
    // the wake the lower centre must leave visible (§B121)
    s('path', { d: 'M612 598 L668 598 L780 720 L500 720 Z', fill: '#EAF4F4', 'fill-opacity': 0.22 }),
    s('path', { d: 'M598 600 L360 720 M682 600 L920 720', stroke: '#EAF4F4', 'stroke-opacity': 0.45, 'stroke-width': 10, filter: 'url(#hxBlur)' }),
    s('path', { d: 'M560 548 L720 548 L704 523 L576 523 Z', fill: '#1A2426' }),
    s('path', { d: 'M600 524 L610 480 L670 480 L680 524', fill: 'none', stroke: '#9AA3A7', 'stroke-width': 5 }),
    s('circle', { cx: 640, cy: 508, r: 10, fill: '#C99B78' }),
    s('path', { d: 'M548 548 L732 548 L704 588 L640 610 L576 588 Z', fill: '#E9E5DA' }),
    s('path', { d: 'M551 555 L729 555 L723 567 L557 567 Z', fill: '#E4572E' }),
    s('path', { d: 'M562 588 L600 604 L618 600 L590 580 Z M718 588 L680 604 L662 600 L690 580 Z', fill: '#D9D3C4' }));
  return svg;
}

const bg = h('div', 'hx-bg');
app.appendChild(bg);
function setBackground(kind: string): void {
  bg.replaceChildren();
  bg.dataset.kind = kind;
  if (kind === 'chase' || kind === 'cockpit') {
    const img = h('img', 'hx-img');
    img.src = kind === 'chase' ? '/docs/speedboat/concept/13-chase-bare-head.png' : '/docs/speedboat/concept/05-cockpit-pov.png';
    img.alt = '';
    img.onerror = () => setBackground('sea'); // concept stills are dev-only files
    bg.appendChild(img);
  } else if (kind === 'sea') bg.appendChild(seaScene());
}

// ————————————————————————————————————————— UI

const course = prepareCourse(HARNESS_COURSE);
let roster: HudRacer[] = buildRoster(DEFAULT_SELECTION.paintId, DEFAULT_SELECTION.number);
const hud = new RaceHud(app);
hud.setCourse(course);
hud.setRoster(roster);
const dash = new DashDisplays();
dash.setCourse(course);
dash.setRoster(roster);
const model = createRaceHudModel(8);
const sample = createSample();

// stand-in cockpit dash (the real one is a 3D part, §T.181/§T.182)
const tachNeedle = s('path', { d: 'M0 0 L0 -40', stroke: '#FF6B1F', 'stroke-width': 3.5, 'stroke-linecap': 'round' });
const bubble = s('circle', { cx: 0, cy: 0, r: 9, fill: '#E9E5DA' });
const govPointer = s('path', { d: 'M0 0 L0 -26', stroke: '#FF6B1F', 'stroke-width': 5, 'stroke-linecap': 'round' });
const dashSvg = svgRoot('0 0 1280 200', 'hx-dash-svg',
  s('path', { d: 'M0 48 Q640 0 1280 48 L1280 200 L0 200 Z', fill: '#1A2224' }),
  s('path', { d: 'M0 48 Q640 0 1280 48', stroke: '#3A4548', 'stroke-width': 3, fill: 'none' }),
  s('rect', { x: 88, y: 52, width: 194, height: 110, rx: 5, fill: '#0B1112', stroke: '#48535A', 'stroke-width': 3 }),
  s('circle', { cx: 400, cy: 108, r: 50, fill: '#0B1112', stroke: '#8E979B', 'stroke-width': 4 }),
  s('path', { d: 'M362 134 A46 46 0 1 1 438 134', fill: 'none', stroke: '#F2F4EF', 'stroke-opacity': 0.5, 'stroke-width': 6, 'stroke-dasharray': '1 9' }),
  s('g', { transform: 'translate(400 108)' }, tachNeedle), s('circle', { cx: 400, cy: 108, r: 5, fill: '#8E979B' }),
  s('rect', { x: 542, y: 36, width: 196, height: 88, rx: 3, fill: '#0B1112', stroke: '#48535A', 'stroke-width': 3 }),
  s('rect', { x: 770, y: 62, width: 130, height: 50, rx: 25, fill: '#0B1112', stroke: '#8E979B', 'stroke-width': 3 }),
  s('path', { d: 'M790 92 Q835 78 880 92', stroke: '#5FD39A', 'stroke-width': 6, fill: 'none', 'stroke-opacity': 0.6 }),
  s('g', { transform: 'translate(835 85)' }, bubble),
  s('circle', { cx: 990, cy: 102, r: 34, fill: '#20292B', stroke: '#8E979B', 'stroke-width': 3 }),
  s('g', { transform: 'translate(990 102)' }, govPointer),
  s('rect', { x: 950, y: 48, width: 80, height: 16, fill: '#D8CFB8', transform: 'rotate(-3 990 56)' }),
  s('rect', { x: 1092, y: 62, width: 132, height: 70, rx: 4, fill: '#0B1112', stroke: '#48535A', 'stroke-width': 3 }));
const tape = s('text', { x: 990, y: 60, 'text-anchor': 'middle', 'font-size': 10, fill: '#0B1516', 'font-family': 'SB Saira Condensed', 'font-weight': 600, 'letter-spacing': '1.2', transform: 'rotate(-3 990 56)' });
tape.textContent = 'OFF  AIR  FULL';
const radioBox = s('text', { x: 1108, y: 104, 'font-size': 28, fill: '#F2B54A', 'font-family': 'SB Saira Stencil' });
radioBox.textContent = '16';
dashSvg.append(tape, radioBox);
dash.plotter.className = 'hx-dash-plotter';
dash.led.className = 'hx-dash-led';
const dashEl = h('div', 'hx-dash', dashSvg, dash.plotter, dash.led, h('div', 'hx-dash-note', 'Harness stand-in for the 3D dash · canvases are the real DashDisplays'));
app.appendChild(dashEl);

const hudScale = Number(params.get('scale') ?? '1') || 1;
hud.setScale(hudScale);
let camera: HudCamera =params.get('cam') === 'cockpit' ? 'cockpit' : params.get('cam') === 'near' ? 'near' : 'chase';

const pause = new PauseScreen(app, {
  assists: { preset: 'default', ...ASSIST_PRESETS.default },
  camera,
  audio: { master: 0.8, engines: 0.9, radio: 0.7, music: 0.5 },
  hudScale,
}, {
  onHudScale: (sc) => hud.setScale(sc),
  onResume: () => closeScreens(),
  onRestart: () => { closeScreens(); seek(0); },
  onQuit: () => { closeScreens(); select.open(); },
  onAssists: (a) => log(`assists ${JSON.stringify(a)}`),
  onCamera: (c) => { camera = c; },
  onAudio: (a) => log(`audio ${JSON.stringify(a)}`),
});
const results = new ResultsScreen(app, {
  onRaceAgain: () => { closeScreens(); seek(0); playing = true; },
  onReplay: () => log('replay'),
  onMenu: () => { closeScreens(); select.open(); },
});
const select = new BoatSelectScreen(app, DEFAULT_SELECTION, {
  onChange: (sel) => {
    roster = buildRoster(sel.paintId, sel.number);
    hud.setRoster(roster);
    dash.setRoster(roster);
  },
  onConfirm: () => { closeScreens(); seek(0); playing = true; },
  onBack: () => closeScreens(),
  onPreviewMount: (host) => {
    host.dataset.hook = 'mounted'; // the page renders the 3D hull here
  },
});

function closeScreens(): void {
  pause.close();
  results.close();
  select.close();
}

function openResults(): void {
  sampleAt(sample, T_END);
  const data = buildResults(sample.race);
  results.open(data, roster, {
    courseName: HARNESS_COURSE.name,
    laps: HARNESS_COURSE.laps,
    conditions: 'Working sea · 17:30',
    stats: [
      ['Top speed', '88.6 kn'],
      ['Airtime', '41.6 s'],
      ['Longest jump', '2.4 s · 68 m'],
      ['Clean landings', '18 / 22'],
      ['Wake jumps', '5'],
      ['Crashes', '1 · Stuff Run L2'],
      ['Gates missed', '0'],
    ],
    broadcast: ['“Crosswind takes the run.', 'One, two point one back.”'],
    canReplay: false,
  });
}

function openScreen(name: string): void {
  closeScreens();
  if (name === 'select') select.open();
  else if (name === 'results') openResults();
  else if (name === 'pause' || name === 'assists' || name === 'audio') {
    pause.open(`Lap ${model.lap} / ${model.laps} · P${model.position} · ${fmt(model.lapTime)}`, 'Working sea · swell 2.1 m / 9.5 s from 285° · 17:30');
    if (name !== 'pause') pause.openPanel(name);
  }
}

const fmt = (sec: number): string => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}.${String(Math.floor((sec % 1) * 1000)).padStart(3, '0')}`;

// ————————————————————————————————————————— harness bar

let t = 0;
let playing = params.get('play') !== '0';
const scrub = h('input', 'hx-scrub');
scrub.type = 'range';
scrub.min = '0';
scrub.max = String(T_END);
scrub.step = '0.05';
const clock = h('span', 'hx-clock', '0.0');
const perf = h('span', 'hx-perf', '');
const logEl = h('span', 'hx-log', '');
function log(msg: string): void {
  logEl.textContent = msg;
}
const btn = (label: string, fn: () => void): HTMLButtonElement => {
  const b = h('button', 'hx-btn', label);
  b.type = 'button';
  b.onclick = (e) => {
    fn();
    (e.currentTarget as HTMLElement).blur();
  };
  return b;
};
const playBtn = btn('Pause', () => { playing = !playing; });
const bar = h('div', 'hx-bar', playBtn, scrub, clock,
  ...Object.entries(MOMENTS).map(([k, v]) => btn(k, () => { closeScreens(); seek(v); playing = false; })),
  btn('cam', () => { camera = camera === 'cockpit' ? 'chase' : 'cockpit'; }),
  btn('select', () => openScreen('select')),
  btn('pause', () => openScreen('pause')),
  btn('results', () => openScreen('results')),
  btn('bg', () => setBackground(bg.dataset.kind === 'sea' ? 'chase' : bg.dataset.kind === 'chase' ? 'cockpit' : bg.dataset.kind === 'cockpit' ? 'none' : 'sea')),
  perf, logEl);
app.appendChild(bar);
bar.hidden = params.get('bar') === '0';
scrub.oninput = () => { seek(Number(scrub.value)); playing = false; };

function seek(v: number): void {
  t = Math.max(0, Math.min(T_END, v));
}

window.addEventListener('keydown', (e) => {
  if (pause.isOpen || results.isOpen || select.isOpen) return;
  if (e.key === ' ') playing = !playing;
  else if (e.key === 'ArrowRight') seek(t + 0.5);
  else if (e.key === 'ArrowLeft') seek(t - 0.5);
  else if (e.key === 'v' || e.key === 'V') camera = camera === 'cockpit' ? 'chase' : 'cockpit';
  else if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') openScreen('pause');
  else if (e.key === 'b' || e.key === 'B') openScreen('select');
  else if (e.key === 'h' || e.key === 'H') bar.hidden = !bar.hidden;
  else return;
  e.preventDefault();
});
window.addEventListener('resize', () => hud.resize(window.innerWidth, window.innerHeight));

// ————————————————————————————————————————— loop

let last = performance.now();
let perfAcc = 0;
let perfN = 0;
let resultsShown = false;
const wrong = params.get('wrong') === '1';

function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const screenOpen = pause.isOpen || results.isOpen || select.isOpen;
  if (hud.root.hidden !== screenOpen) hud.setVisible(!screenOpen);
  if (playing && !screenOpen) t += dt;
  if (t >= T_END) t = 0;
  if (playing && !resultsShown && t >= T_RESULTS) {
    resultsShown = true;
    openScreen('results');
  }
  if (t < T_RESULTS) resultsShown = false;
  sampleAt(sample, t, { wrongWay: wrong });
  sample.telemetry.camera = camera;

  const t0 = performance.now();
  updateRaceHudModel(model, sample.race, course, sample.playerId, sample.telemetry, dt);
  hud.update(model, dt);
  if (camera === 'cockpit') dash.update(model, dt);
  perfAcc += performance.now() - t0;
  perfN++;
  if (perfN >= 60) {
    perf.textContent = `model+hud ${(perfAcc / perfN).toFixed(3)} ms`;
    perfAcc = 0;
    perfN = 0;
  }

  dashEl.hidden = camera !== 'cockpit';
  if (camera === 'cockpit') {
    tachNeedle.setAttribute('transform', `rotate(${(dash.rpmNeedleRad * 180) / Math.PI})`);
    bubble.setAttribute('cx', String(dash.trimBubble * 38));
    govPointer.setAttribute('transform', `rotate(${(dash.governorDetentRad * 180) / Math.PI})`);
  }
  pause.poll(now);
  results.poll(now);
  select.poll(now);
  scrub.value = String(t);
  clock.textContent = `${t.toFixed(1)} s · ${sample.race.phase}`;
  requestAnimationFrame(frame);
}

// ————————————————————————————————————————— boot

const tParam = params.get('t');
if (tParam !== null || params.get('screen') !== null) {
  // pinned stills: a screenshot may land before a 0.2 s transition finishes (or in a tab whose
  // timeline is frozen), so transitions are off when the harness is pinned to a moment
  const still = document.createElement('style');
  still.textContent = '.sb-ui *, .sb-ui *::before, .sb-ui *::after { transition: none !important; animation: none !important; }';
  document.head.appendChild(still);
}
if (tParam !== null) {
  seek(tParam in MOMENTS ? MOMENTS[tParam] : Number(tParam));
  if (params.get('play') === null) playing = false;
}
setBackground(params.get('bg') ?? (camera === 'cockpit' ? 'sea' : 'sea'));

interface HarnessApi {
  seek(v: number | string): void;
  cam(c: HudCamera): void;
  open(screen: string): void;
  close(): void;
  play(on: boolean): void;
  bg(kind: string): void;
  bar(on: boolean): void;
  /** data-panel rects vs the layout model and the §B121 keep-out */
  rects(): { id: string; dom: number[]; model: number[] | null; hitsLowerCentre: boolean }[];
}

const api: HarnessApi = {
  seek: (v) => seek(typeof v === 'string' ? MOMENTS[v] ?? Number(v) : v),
  cam: (c) => { camera = c; },
  open: (sc) => openScreen(sc),
  close: () => closeScreens(),
  play: (on) => { playing = on; },
  bg: (k) => setBackground(k),
  bar: (on) => { bar.hidden = !on; },
  rects: () => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const keep = lowerCentreKeepOut(vw, vh);
    const panels = camera === 'cockpit' ? COCKPIT_PANELS : CHASE_PANELS;
    const sc = Number(hud.root.style.getPropertyValue('--hud-scale')) || 1;
    return [...hud.root.querySelectorAll<HTMLElement>('[data-panel]')].filter((el) => el.getClientRects().length > 0).map((el) => {
      const r = el.getBoundingClientRect();
      const p = panels.find((q) => q.id === el.dataset.panel);
      const m = p ? placePanel(p, vw, vh, sc) : null;
      return {
        id: el.dataset.panel ?? '',
        dom: [r.left, r.top, r.right, r.bottom].map((n) => Math.round(n)),
        model: m ? [m.left, m.top, m.right, m.bottom].map((n) => Math.round(n)) : null,
        hitsLowerCentre: r.left < keep.right && r.right > keep.left && r.top < keep.bottom && r.bottom > keep.top,
      };
    });
  },
};
(window as unknown as { __sbHarness: HarnessApi }).__sbHarness = api;

void loadSpeedboatFonts().then(() => {
  requestAnimationFrame((n) => {
    last = n;
    frame(n);
    const sc = params.get('screen'); // after one frame, so the pause summary reads a primed model
    if (sc) openScreen(sc);
  });
});
