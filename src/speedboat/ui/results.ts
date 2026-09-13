/**
 * Results (design doc §9 results mockup): finishing order with each pilot's community, lap times,
 * best lap with the fastest lap marked, your race, and the tower's broadcast to all stations in place
 * of a podium. Built on open; nothing per frame.
 */
import { h, txt } from './dom';
import { formatGap, formatLapTime, type ResultsData } from './model';
import { MenuNav, type NavItem } from './nav';
import type { HudRacer } from './roster';

export interface ResultsMeta {
  courseName: string;
  laps: number;
  /** "Working sea · 17:30" */
  conditions: string;
  /** page-provided skill stats (§T.184/§T.188); fallback derives what the results carry */
  stats?: readonly (readonly [label: string, value: string])[];
  /** island stations calling the result (§T.183 radio); fallback names the winner */
  broadcast?: readonly string[];
  canReplay: boolean;
}

export interface ResultsCallbacks {
  onRaceAgain(): void;
  onReplay(): void;
  onMenu(): void;
}

/** classification gap to the thousandth, as the mockup: "+2.117", "+1:02.908" */
export function resultGap(g: number): string {
  if (g < 60) return `+${g.toFixed(3)}`;
  return `+${formatLapTime(g)}`;
}

export class ResultsScreen {
  readonly root: HTMLDivElement;
  private readonly frame: HTMLDivElement;
  private readonly nav: MenuNav;
  private readonly title = txt('');

  constructor(parent: HTMLElement, private readonly cb: ResultsCallbacks) {
    this.nav = new MenuNav(() => cb.onMenu());
    this.frame = h('div', 'sbs-frame');
    this.root = h('div', 'sb-ui sbs sbs-results', h('div', 'sbs-dim'), this.frame);
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Results');
    parent.appendChild(this.root);
  }

  open(data: ResultsData, roster: readonly HudRacer[], meta: ResultsMeta): void {
    const byId = new Map(roster.map((r) => [r.racerId, r]));
    const lapCols = Math.max(1, meta.laps);
    const cols = `calc(40 * var(--u)) calc(22 * var(--u)) calc(150 * var(--u)) 1fr repeat(${lapCols}, calc(72 * var(--u))) calc(92 * var(--u)) calc(96 * var(--u))`;

    const head = h('div', 'sbs-tr is-head sb-label', h('span', '', 'Pos'), h('span'), h('span', '', 'Boat'), h('span', '', 'Pilot · community'));
    for (let i = 0; i < lapCols; i++) head.appendChild(h('span', 'r', `L${i + 1}`));
    head.append(h('span', 'r', 'Time'), h('span', 'r', 'Best lap'));
    head.style.gridTemplateColumns = cols;
    const table = h('div', 'sbs-table', head);

    const player = roster.find((r) => r.isPlayer);
    let playerRow = data.rows.find((r) => r.racerId === player?.racerId);
    for (const row of data.rows) {
      const r = byId.get(row.racerId);
      const you = r?.isPlayer === true;
      const sw = h('span', 'sbh-swatch');
      sw.style.background = r?.hue ?? '#9FB2B0';
      sw.style.setProperty('--ring', you ? '#0B1516' : r?.ring || 'transparent');
      const who = you ? 'Player' : r ? `${r.pilot} · ${r.community}` : '';
      const pen = row.penaltyS > 0 ? ` · +${Math.round(row.penaltyS)} s penalty` : '';
      const time =
        row.status === 'dnf' ? 'DNF' : row.status === 'running' ? 'Running' : row.place === 1 || !Number.isFinite(row.gap) ? formatLapTime(row.total) : resultGap(row.gap);
      const tr = h('div', `sbs-tr${you ? ' is-you' : ''}`,
        h('span', 'pos', String(row.place)),
        sw,
        h('span', 'sb-label', r ? (you ? `${r.number} You` : `${r.number} ${r.boat}`) : `#${row.racerId}`),
        h('span', 'pilot', who + pen));
      for (let i = 0; i < lapCols; i++) {
        const v = row.laps[i];
        tr.appendChild(h('span', 'num r lapc', v === undefined ? '' : formatLapTime(v)));
      }
      const best = h('span', `num r${row.racerId === data.fastestRacerId ? ' fast' : ''}`, formatLapTime(row.best));
      tr.append(h('span', 'num r', time === 'Running' ? '—' : time), best);
      tr.style.gridTemplateColumns = cols;
      table.appendChild(tr);
    }
    playerRow ??= data.rows[0];

    // your race
    const stats = meta.stats ?? [
      ['Finish', playerRow ? `P${playerRow.place} of ${data.rows.length}` : '—'],
      ['Best lap', formatLapTime(playerRow?.best ?? Number.NaN)],
      ['Gap to the winner', playerRow && playerRow.place > 1 && Number.isFinite(playerRow.gap) ? formatGap(playerRow.gap) : '—'],
      ['Fastest lap of the race', formatLapTime(data.fastestLap)],
      ['Penalties', playerRow && playerRow.penaltyS > 0 ? `+${Math.round(playerRow.penaltyS)} s` : 'None'],
    ];
    const statsEl = h('div', 'sbs-stats', h('h2', 'sb-label', 'Your race'));
    for (const [label, value] of stats) statsEl.appendChild(h('div', 'sbs-stat', h('span', 'sb-label', label), h('span', 'sb-stencil', value)));

    const winner = byId.get(data.rows[0]?.racerId ?? -1);
    const lines = meta.broadcast ?? [winner ? (winner.isPlayer ? '“You take the run. Well flown.”' : `“${winner.boat} takes the run.”`) : ''];
    const broadcast = h('div', 'sbs-broadcast', h('div', 'sb-label sb-amber', 'RC · ch16 → all stations'), ...lines.map((l) => h('p', '', l)));

    const again = h('button', 'sb-label sbs-btn is-primary', 'Race again');
    const replay = h('button', 'sb-label sbs-btn', 'Watch replay');
    replay.disabled = !meta.canReplay;
    const menu = h('button', 'sb-label sbs-btn', 'Menu');
    const actions = h('div', 'sbs-actions', again, replay, menu);

    this.title.data = `${meta.courseName} · ${meta.laps} laps · ${meta.conditions}`;
    const t1 = h('div', 'sb-stencil sbs-h1', 'Results');
    t1.style.cssText = 'left:calc(60 * var(--u));top:calc(46 * var(--u));font-size:calc(60 * var(--u));';
    const t2 = h('div', 'sb-label sbs-sub', this.title);
    t2.style.cssText = 'left:calc(64 * var(--u));top:calc(120 * var(--u));';
    const note = h('div', 'sb-label sbs-note', 'Fastest lap');
    this.frame.replaceChildren(t1, t2, table, note, statsEl, broadcast, actions);
    note.style.top = `calc(${(186 + 48 * data.rows.length + 22).toFixed(0)} * var(--u))`;

    const items: NavItem[] = [
      { el: again, activate: () => this.cb.onRaceAgain() },
      { el: replay, activate: () => this.cb.onReplay(), disabled: !meta.canReplay },
      { el: menu, activate: () => this.cb.onMenu() },
    ];
    this.root.hidden = false;
    this.nav.setItems(items, 0);
    this.nav.attach();
  }

  close(): void {
    this.root.hidden = true;
    this.nav.detach();
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  poll(now: number): void {
    if (this.isOpen) this.nav.poll(now);
  }
}
