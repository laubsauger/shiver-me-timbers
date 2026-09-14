/**
 * Pause over the frozen race (design doc §9 pause mockup). Governor and camera change in place,
 * the assists preset (Default / Pro) and its dials and the audio levels open in the side panel,
 * controls sit one glance away. The page owns what each change does (§T.182 assists, §T.183 audio);
 * this screen only reports it.
 */
import { chevrons, h, txt } from './dom';
import { MenuNav, type NavItem } from './nav';
import type { GovernorMode, HudCamera } from './model';
import { HUD_SCALES } from './layout';

export interface AssistSettings {
  preset: 'default' | 'pro' | 'custom';
  governor: GovernorMode;
  /** landing-attitude assist, 0..1 */
  landingAssist: number;
  /** speed-limited steering lock (§T.182: ±12° at top speed) */
  steeringLock: boolean;
  autoReset: boolean;
}

/** design doc §3: AIR is default; Pro sets the assists off; auto reset stays on in both */
export const ASSIST_PRESETS: Record<'default' | 'pro', Omit<AssistSettings, 'preset'>> = {
  default: { governor: 'air', landingAssist: 0.5, steeringLock: true, autoReset: true },
  pro: { governor: 'off', landingAssist: 0, steeringLock: false, autoReset: true },
};

export interface AudioSettings {
  master: number;
  engines: number;
  radio: number;
  music: number;
}

export interface PauseState {
  assists: AssistSettings;
  camera: HudCamera;
  audio: AudioSettings;
  /** race HUD size, one of HUD_SCALES[].scale (RaceHud.setScale) */
  hudScale: number;
  /** §T.201 graphics quality label (the page's settings store); omitted = no Graphics row */
  graphics?: string;
  /** real full-screen state; null/omitted = the browser refuses it, no row */
  fullscreen?: boolean | null;
  /** dev overlays (perf HUD, Tweakpane) shown; omitted = no row */
  devOverlays?: boolean;
}

export interface PauseCallbacks {
  onResume(): void;
  onRestart(): void;
  onQuit(): void;
  onAssists(a: AssistSettings): void;
  onCamera(c: HudCamera): void;
  onAudio(a: AudioSettings): void;
  onHudScale(scale: number): void;
  /** §T.201: change boat mid-race (the select's Back returns here) */
  onBoatSelect?(): void;
  /** step the graphics quality; the page answers with `setState` */
  onGraphics?(dir: -1 | 1): void;
  /** MUST reach the fullscreen request inside this call (a user gesture); the page answers with `setState` */
  onFullscreen?(): void;
  onDevOverlays?(): void;
}

const GOV: GovernorMode[] = ['off', 'air', 'full'];
const GOV_LABEL: Record<GovernorMode, string> = { off: 'Off', air: 'Air', full: 'Full' };
const CAMS: HudCamera[] = ['chase', 'near', 'cockpit'];
const CAM_LABEL: Record<HudCamera, string> = { chase: 'Chase', near: 'Near chase', cockpit: 'Cockpit' };

const CONTROLS: [string, string, string][] = [
  ['Throttle', 'W', 'RT'],
  ['Off / reverse', 'S', 'LT'],
  ['Steer', 'A · D', 'L stick ↔'],
  ['Trim bow down / up', '↑ · ↓', 'R stick ↕'],
  ['Surge', 'Shift', 'A'],
  ['Look back / mirror', 'C', 'R stick click'],
  ['Camera', 'V', 'Y'],
  ['Reset', 'Hold R', 'Hold View'],
];

function valueRow(label: string, value: Text | Node, cls = ''): HTMLButtonElement {
  const [l, r] = chevrons();
  const b = h('button', `sb-label sbs-item ${cls}`, label, h('span', 'val', l, value, r));
  b.type = 'button';
  return b;
}

function meter(): { el: HTMLSpanElement; set(v: number): void } {
  const cells: HTMLElement[] = [];
  for (let i = 0; i < 10; i++) cells.push(h('i'));
  const el = h('span', 'sbs-meter', ...cells);
  return { el, set: (v) => cells.forEach((c, i) => c.classList.toggle('is-on', i < Math.round(v * 10))) };
}

export class PauseScreen {
  readonly root: HTMLDivElement;
  private readonly nav: MenuNav;
  private state: PauseState;
  private readonly summary = txt('');
  private readonly conditions = txt('');
  private readonly side: HTMLDivElement;
  private readonly controlsView: HTMLElement;
  private readonly assistsView: HTMLElement;
  private readonly audioView: HTMLElement;
  private readonly menuItems: NavItem[] = [];
  private readonly assistItems: NavItem[] = [];
  private readonly audioItems: NavItem[] = [];
  private readonly refresh: (() => void)[] = [];
  private layer: 'menu' | 'assists' | 'audio' = 'menu';
  private assistsRow!: HTMLElement;
  private audioRow!: HTMLElement;

  constructor(parent: HTMLElement, initial: PauseState, private readonly cb: PauseCallbacks) {
    this.state = structuredClone(initial);
    this.nav = new MenuNav(() => this.back());

    // — left menu
    const resume = h('button', 'sb-label sbs-item', 'Resume');
    const restart = h('button', 'sb-label sbs-item', 'Restart race');
    const govV = txt('');
    const gov = valueRow('Governor', govV);
    (gov.querySelector('.val') as HTMLElement).classList.add('sb-amber');
    const presetV = txt('');
    const assists = valueRow('Assists', presetV);
    const camV = txt('');
    const cam = valueRow('Camera', camV);
    const sizeV = txt('');
    const size = valueRow('HUD size', sizeV);
    const audio = h('button', 'sb-label sbs-item', 'Audio');
    const quit = h('button', 'sb-label sbs-item is-muted', 'Quit to menu');
    // §T.201 (USER: "missing a pause menu / ways to go fullscreen and hide the dev stuff"): rows the page may omit
    const boat = h('button', 'sb-label sbs-item', 'Boat select');
    const gfxV = txt('');
    const gfx = valueRow('Graphics', gfxV);
    const fullV = txt('');
    const full = valueRow('Full screen', fullV);
    const devV = txt('');
    const dev = valueRow('Dev overlays', devV);
    const menu = h('div', 'sbs-menu', resume, restart,
      cb.onBoatSelect ? boat : null, gov, assists, cam, size, audio,
      cb.onGraphics && initial.graphics !== undefined ? gfx : null,
      cb.onFullscreen && typeof initial.fullscreen === 'boolean' ? full : null,
      cb.onDevOverlays && initial.devOverlays !== undefined ? dev : null,
      quit);
    this.refresh.push(() => {
      govV.data = GOV_LABEL[this.state.assists.governor];
      presetV.data = this.state.assists.preset === 'default' ? 'Default' : this.state.assists.preset === 'pro' ? 'Pro' : 'Custom';
      camV.data = CAM_LABEL[this.state.camera];
      sizeV.data = (HUD_SCALES.find((s) => s.scale === this.state.hudScale) ?? HUD_SCALES[1]).label;
      gfxV.data = this.state.graphics ?? '';
      fullV.data = this.state.fullscreen ? 'On' : 'Off';
      devV.data = this.state.devOverlays ? 'Shown' : 'Hidden';
    });

    // — side: controls
    const keys = h('div', 'sbs-keys');
    for (const [a, k, p] of CONTROLS) keys.append(h('span', '', a), h('span', 'k', k), h('span', 'k', p));
    this.controlsView = h('div', '', h('h2', 'sb-label', 'Controls', h('span', '', 'Keyboard · gamepad')), keys);

    // — side: assists dials
    const dGovV = txt('');
    const dGov = valueRow('Governor', dGovV);
    const landM = meter();
    const dLand = valueRow('Landing assist', landM.el);
    const lockV = txt('');
    const dLock = valueRow('Steering lock at speed', lockV);
    const resetV = txt('');
    const dReset = valueRow('Auto reset', resetV);
    const dPreset = valueRow('Preset', txt(''));
    const presetText = dPreset.querySelector('.val')?.childNodes[1] as Text;
    this.assistsView = h('div', '', h('h2', 'sb-label', 'Assists', h('span', '', 'The Governor and its dials')), h('div', 'sbs-dials', dPreset, dGov, dLand, dLock, dReset));
    this.refresh.push(() => {
      const a = this.state.assists;
      presetText.data = a.preset === 'default' ? 'Default' : a.preset === 'pro' ? 'Pro · all off' : 'Custom';
      dGovV.data = GOV_LABEL[a.governor];
      landM.set(a.landingAssist);
      lockV.data = a.steeringLock ? 'On' : 'Off';
      resetV.data = a.autoReset ? 'On' : 'Off';
    });

    // — side: audio
    const levels: [keyof AudioSettings, string][] = [['master', 'Master'], ['engines', 'Engines'], ['radio', 'Race radio'], ['music', 'Menu music']];
    const audioRows = levels.map(([key, label]) => {
      const m = meter();
      const row = valueRow(label, m.el);
      this.refresh.push(() => m.set(this.state.audio[key]));
      this.audioItems.push({
        el: row,
        adjust: (d) => {
          this.state.audio[key] = Math.min(1, Math.max(0, Math.round((this.state.audio[key] + d * 0.1) * 10) / 10));
          this.cb.onAudio({ ...this.state.audio });
          this.sync();
        },
      });
      return row;
    });
    this.audioView = h('div', '', h('h2', 'sb-label', 'Audio', h('span', '', 'Levels')), h('div', 'sbs-dials', ...audioRows));

    this.side = h('div', 'sb-plane sbs-side', this.controlsView, this.assistsView, this.audioView, h('div', 'sbs-cond', h('div', 'sb-label sbs-sub', 'Conditions'), h('div', 'sb-label', this.conditions)));

    // — nav items
    const setGov = (d: -1 | 1): void => {
      const i = (GOV.indexOf(this.state.assists.governor) + d + GOV.length) % GOV.length;
      this.state.assists.governor = GOV[i];
      this.state.assists.preset = this.matchPreset();
      this.emitAssists();
    };
    const cyclePreset = (): void => {
      const next = this.state.assists.preset === 'default' ? 'pro' : 'default';
      this.state.assists = { preset: next, ...ASSIST_PRESETS[next] };
      this.emitAssists();
    };
    const onControls = (): void => this.showSide('controls');
    this.menuItems.push(
      { el: resume, activate: () => cb.onResume(), focus: onControls },
      { el: restart, activate: () => cb.onRestart(), focus: onControls },
      ...(menu.contains(boat) ? [{ el: boat, activate: () => cb.onBoatSelect?.(), focus: onControls }] : []),
      { el: gov, adjust: setGov, focus: () => this.showSide('assists') },
      { el: assists, activate: () => this.enter('assists'), adjust: () => cyclePreset(), focus: () => this.showSide('assists') },
      {
        el: cam,
        adjust: (d) => {
          this.state.camera = CAMS[(CAMS.indexOf(this.state.camera) + d + CAMS.length) % CAMS.length];
          cb.onCamera(this.state.camera);
          this.sync();
        },
        focus: () => this.showSide('controls'),
      },
      {
        el: size,
        adjust: (d) => {
          const i = HUD_SCALES.findIndex((s) => s.scale === this.state.hudScale);
          const next = HUD_SCALES[Math.min(HUD_SCALES.length - 1, Math.max(0, (i < 0 ? 1 : i) + d))];
          this.state.hudScale = next.scale;
          cb.onHudScale(next.scale);
          this.sync();
        },
        focus: () => this.showSide('controls'),
      },
      { el: audio, activate: () => this.enter('audio'), focus: () => this.showSide('audio') },
      ...(menu.contains(gfx) ? [{ el: gfx, adjust: (d: -1 | 1) => cb.onGraphics?.(d), focus: onControls }] : []),
      ...(menu.contains(full) ? [{ el: full, activate: () => cb.onFullscreen?.(), adjust: () => cb.onFullscreen?.(), focus: onControls }] : []),
      ...(menu.contains(dev) ? [{ el: dev, activate: () => cb.onDevOverlays?.(), adjust: () => cb.onDevOverlays?.(), focus: onControls }] : []),
      { el: quit, activate: () => cb.onQuit(), focus: onControls },
    );
    this.assistsRow = assists;
    this.audioRow = audio;
    this.assistItems.push(
      { el: dPreset, adjust: () => cyclePreset(), activate: () => cyclePreset() },
      { el: dGov, adjust: setGov },
      {
        el: dLand,
        adjust: (d) => {
          this.state.assists.landingAssist = Math.min(1, Math.max(0, Math.round((this.state.assists.landingAssist + d * 0.1) * 10) / 10));
          this.state.assists.preset = this.matchPreset();
          this.emitAssists();
        },
      },
      { el: dLock, adjust: () => this.toggleAssist('steeringLock') },
      { el: dReset, adjust: () => this.toggleAssist('autoReset') },
    );

    const hints = h('div', 'sb-label sbs-hint',
      h('span', '', h('b', '', 'Enter / A'), 'Select'),
      h('span', '', h('b', '', 'Left / right'), 'Change'),
      h('span', '', h('b', '', 'Esc / B'), 'Back'));

    const frame = h('div', 'sbs-frame',
      h('div', 'sb-stencil sbs-h1', 'Paused'),
      h('div', 'sb-label sbs-sub', this.summary),
      menu, this.side, hints);
    (frame.children[0] as HTMLElement).style.cssText = `left:calc(56 * var(--u));top:calc(56 * var(--u));`;
    (frame.children[1] as HTMLElement).style.cssText = `left:calc(64 * var(--u));top:calc(144 * var(--u));`;
    this.root = h('div', 'sb-ui sbs sbs-pause', h('div', 'sbs-dim'), frame);
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Paused');
    parent.appendChild(this.root);
    this.sync();
    this.showSide('controls');
  }

  private toggleAssist(key: 'steeringLock' | 'autoReset'): void {
    this.state.assists[key] = !this.state.assists[key];
    this.state.assists.preset = this.matchPreset();
    this.emitAssists();
  }

  private matchPreset(): AssistSettings['preset'] {
    const a = this.state.assists;
    for (const p of ['default', 'pro'] as const) {
      const q = ASSIST_PRESETS[p];
      if (a.governor === q.governor && a.landingAssist === q.landingAssist && a.steeringLock === q.steeringLock && a.autoReset === q.autoReset) return p;
    }
    return 'custom';
  }

  private emitAssists(): void {
    this.cb.onAssists({ ...this.state.assists });
    this.sync();
  }

  private sync(): void {
    for (const f of this.refresh) f();
  }

  private showSide(which: 'controls' | 'assists' | 'audio'): void {
    this.controlsView.hidden = which !== 'controls';
    this.assistsView.hidden = which !== 'assists';
    this.audioView.hidden = which !== 'audio';
  }

  private enter(layer: 'assists' | 'audio'): void {
    this.layer = layer;
    this.assistsRow.classList.toggle('is-open', layer === 'assists');
    this.audioRow.classList.toggle('is-open', layer === 'audio');
    this.showSide(layer);
    this.nav.setItems([...(layer === 'assists' ? this.assistItems : this.audioItems)]);
  }

  private back(): void {
    if (this.layer === 'menu') {
      this.cb.onResume();
      return;
    }
    const from = this.layer;
    this.layer = 'menu';
    for (const it of this.menuItems) it.el.classList.remove('is-open');
    const row = from === 'assists' ? this.assistsRow : this.audioRow;
    this.nav.setItems(this.menuItems, this.menuItems.findIndex((it) => it.el === row));
  }

  /** §T.201: the page's answer to a row it owns (graphics quality, real full-screen state, dev overlays) */
  setState(patch: Partial<Pick<PauseState, 'graphics' | 'fullscreen' | 'devOverlays'>>): void {
    Object.assign(this.state, patch);
    this.sync();
  }

  open(summary: string, conditions: string, state?: PauseState): void {
    if (state) this.state = structuredClone(state);
    this.summary.data = summary;
    this.conditions.data = conditions;
    this.sync();
    this.root.hidden = false;
    this.layer = 'menu';
    this.nav.setItems(this.menuItems, 0);
    this.showSide('controls');
    this.nav.attach();
  }

  /** open straight into a side panel (harness screenshots) */
  openPanel(layer: 'assists' | 'audio'): void {
    this.enter(layer);
  }

  close(): void {
    this.root.hidden = true;
    this.nav.detach();
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** per frame while open (gamepad) */
  poll(now: number): void {
    if (this.isOpen) this.nav.poll(now);
  }
}
