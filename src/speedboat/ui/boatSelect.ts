/**
 * Hull and paint (design doc §9 boat-select mockup). One class, so the screen is the spec sheet plus
 * paint (8 community liveries), race number and eyewear (STYLE-SPEC §0: bare head, strap goggles),
 * then conditions. The chosen paint hue becomes your HUD and plotter colour.
 *
 * 3D preview hook: `onPreviewMount(host)` hands the page a sized element to put its render in
 * (canvas or view rect); `onChange(selection)` fires on every change so the preview repaints. The
 * 2D profile below stays visible until the page marks the host live with `setPreviewLive(true)`.
 */
import { chevrons, h, txt } from './dom';
import { hullProfile } from './hullArt';
import { MenuNav, type NavItem } from './nav';
import { COMMUNITY_PAINTS, GOGGLES, RIVAL_NUMBERS } from './roster';

export interface BoatSelection {
  paintId: string;
  number: number;
  gogglesId: string;
  sea: string;
  time: string;
  rivals: string;
}

export interface BoatSelectCallbacks {
  onChange(sel: BoatSelection): void;
  onConfirm(sel: BoatSelection): void;
  onBack(): void;
  /** mount a 3D preview into `host`; return a disposer */
  onPreviewMount?(host: HTMLElement): (() => void) | void;
}

export const SEA_OPTIONS = ['Calm', 'Breeze', 'Working sea', 'Squall'] as const;
export const TIME_OPTIONS = ['06:30', '12:00', '17:30'] as const;
export const RIVAL_OPTIONS = ['Club', 'National'] as const;

export const DEFAULT_SELECTION: BoatSelection = { paintId: 'signal', number: 1, gogglesId: 'strap-amber', sea: 'Working sea', time: '17:30', rivals: 'National' };

/** next free race number in direction d (1..99, skipping the rivals' numbers) */
export function stepNumber(n: number, d: -1 | 1): number {
  let v = n;
  for (let i = 0; i < 100; i++) {
    v = ((v - 1 + d + 99) % 99) + 1;
    if (!RIVAL_NUMBERS.includes(v)) return v;
  }
  return n;
}

const cycle = <T>(list: readonly T[], v: T, d: -1 | 1): T => list[(list.indexOf(v) + d + list.length) % list.length];

export class BoatSelectScreen {
  readonly root: HTMLDivElement;
  private readonly nav: MenuNav;
  private sel: BoatSelection;
  private readonly preview: HTMLDivElement;
  private readonly previewHost: HTMLDivElement;
  private readonly paintCards: HTMLButtonElement[] = [];
  private readonly paintCount = txt('');
  private readonly numberV = txt('');
  private readonly gogglesV = txt('');
  private readonly seaV = txt('');
  private readonly timeV = txt('');
  private readonly rivalsV = txt('');
  private readonly items: NavItem[] = [];
  private disposePreview: (() => void) | void = undefined;

  constructor(parent: HTMLElement, initial: BoatSelection, private readonly cb: BoatSelectCallbacks) {
    this.sel = { ...initial };
    this.nav = new MenuNav(() => cb.onBack());

    const lab = (cls: string, text: string, top: number, left: number): HTMLDivElement => {
      const d = h('div', cls, text);
      d.style.cssText = `left:calc(${left} * var(--u));top:calc(${top} * var(--u));`;
      return d;
    };

    this.previewHost = h('div', 'sbs-preview-host');
    this.preview = h('div', 'sbs-preview', this.previewHost);

    const spec = h('div', 'sbs-spec');
    for (const [l, v] of [
      ['Length', '39 ft · 12.0 m'],
      ['Deadrise', '24°'],
      ['Weight', '5.8 t'],
      ['Power', '3 × V8 outboard'],
      ['Top speed', '80 · Surge 90'],
      ['Pilot', 'Solo'],
    ]) spec.appendChild(h('div', '', h('div', 'sb-label', l), h('div', 'sb-stencil', v)));

    // paints
    const grid = h('div', 'sbs-paints');
    COMMUNITY_PAINTS.forEach((p) => {
      const card = h('button', 'sbs-paint', hullProfile(p, this.sel.number, null, false), h('span', 'sb-label', p.community));
      card.type = 'button';
      card.setAttribute('aria-label', `${p.community} paint`);
      grid.appendChild(card);
      this.paintCards.push(card);
      this.items.push({
        el: card,
        activate: () => {
          this.sel.paintId = p.id;
          this.changed();
        },
      });
    });

    const opt = (label: string, value: Text, adjust: (d: -1 | 1) => void): HTMLButtonElement => {
      const [l, r] = chevrons();
      const b = h('button', 'sb-label sbs-item', label, h('span', 'val', l, value, r));
      b.type = 'button';
      this.items.push({ el: b, adjust: (d) => { adjust(d); this.changed(); } });
      return b;
    };
    const opts = h('div', 'sbs-opts',
      opt('Number', this.numberV, (d) => (this.sel.number = stepNumber(this.sel.number, d))),
      opt('Eyewear', this.gogglesV, (d) => (this.sel.gogglesId = cycle(GOGGLES.map((g) => g.id), this.sel.gogglesId, d))),
      opt('Sea', this.seaV, (d) => (this.sel.sea = cycle(SEA_OPTIONS, this.sel.sea as (typeof SEA_OPTIONS)[number], d))),
      opt('Time', this.timeV, (d) => (this.sel.time = cycle(TIME_OPTIONS, this.sel.time as (typeof TIME_OPTIONS)[number], d))),
      opt('Rivals', this.rivalsV, (d) => (this.sel.rivals = cycle(RIVAL_OPTIONS, this.sel.rivals as (typeof RIVAL_OPTIONS)[number], d))));

    const go = h('button', 'sb-label sbs-btn', 'To the start line');
    go.type = 'button';
    this.items.push({ el: go, activate: () => cb.onConfirm({ ...this.sel }) });

    const pick = h('div', 'sbs-pick', h('div', 'sb-label sbs-pick-h', h('span', '', 'Paint'), h('b', '', this.paintCount)), grid, opts);

    const frame = h('div', 'sbs-frame',
      lab('sb-label sbs-hull-l', 'Your hull', 72, 64),
      lab('sb-stencil sbs-hull-t', 'V-39', 92, 58),
      lab('sb-label sbs-hull-s', 'Salvage open · built 2031 · rebuilt 2094 · one class in this build', 200, 66),
      this.preview, spec, pick, h('div', 'sbs-go', go));
    this.root = h('div', 'sb-ui sbs sbs-select', h('div', 'sbs-dim'), h('div', 'sbs-rail'), frame);
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Hull and paint');
    parent.appendChild(this.root);
  }

  private changed(): void {
    this.render();
    this.cb.onChange({ ...this.sel });
  }

  private render(): void {
    const paint = COMMUNITY_PAINTS.find((p) => p.id === this.sel.paintId) ?? COMMUNITY_PAINTS[0];
    const goggles = GOGGLES.find((g) => g.id === this.sel.gogglesId) ?? GOGGLES[0];
    const idx = COMMUNITY_PAINTS.indexOf(paint);
    this.paintCount.data = `${idx + 1} / ${COMMUNITY_PAINTS.length} · ${paint.community}`;
    this.paintCards.forEach((c, i) => c.classList.toggle('is-chosen', i === idx));
    this.numberV.data = `#${this.sel.number}`;
    this.gogglesV.data = goggles.label;
    this.seaV.data = this.sel.sea;
    this.timeV.data = this.sel.time;
    this.rivalsV.data = this.sel.rivals;
    const old = this.preview.querySelector(':scope > svg');
    const art = hullProfile(paint, this.sel.number, goggles, true);
    if (old) old.replaceWith(art);
    else this.preview.prepend(art);
    this.root.style.setProperty('--player', paint.hue);
  }

  /** the page calls this once its 3D preview is drawing into the host */
  setPreviewLive(live: boolean): void {
    this.preview.classList.toggle('is-3d', live);
  }

  open(sel?: BoatSelection): void {
    if (sel) this.sel = { ...sel };
    this.render();
    this.root.hidden = false;
    const chosen = COMMUNITY_PAINTS.findIndex((p) => p.id === this.sel.paintId);
    this.nav.setItems(this.items, chosen < 0 ? 0 : chosen);
    this.nav.attach();
    if (this.cb.onPreviewMount && !this.disposePreview) this.disposePreview = this.cb.onPreviewMount(this.previewHost);
  }

  close(): void {
    this.root.hidden = true;
    this.nav.detach();
    if (typeof this.disposePreview === 'function') this.disposePreview();
    this.disposePreview = undefined;
    this.setPreviewLive(false);
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  get selection(): BoatSelection {
    return { ...this.sel };
  }

  poll(now: number): void {
    if (this.isOpen) this.nav.poll(now);
  }
}
