/**
 * Settings row controls (§V21 pirate theme, §V16-adjacent: these render the
 * store, they own no tunables). Three shapes, one vocabulary:
 *
 *   slider  — rope track, brass knob (already the idiom for volumes)
 *   switch  — brass lever thrown along an engraved slot cut into the chart
 *   segment — engraved plate divided into brass-lit cells
 *
 * Every row is label + optional hint + control. The hint is a promise about
 * what the player will SEE, never a description of the renderer.
 */
import { button, div, el } from './dom';

export interface Row {
  root: HTMLElement;
  /** first focusable element in the row — the screen tabs through these */
  control: HTMLElement;
}

function rowHead(label: string, hint?: string, value?: HTMLElement): HTMLElement {
  const text = div('smt-row-text', el('span', 'smt-row-label', label));
  if (hint) text.appendChild(el('span', 'smt-row-hint', hint));
  const top = div('smt-row-top', text);
  if (value) top.appendChild(value);
  return top;
}

export interface SliderSpec {
  label: string;
  hint?: string;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onInput: (v: number) => void;
}

export interface SliderRow extends Row {
  set(v: number): void;
}

export function sliderRow(spec: SliderSpec): SliderRow {
  const value = el('span', 'smt-row-value');
  const input = el('input', 'smt-range');
  input.type = 'range';
  input.min = String(spec.min);
  input.max = String(spec.max);
  input.step = String(spec.step);
  input.setAttribute('aria-label', spec.label);
  input.addEventListener('input', () => spec.onInput(Number(input.value)));
  const root = div('smt-row', rowHead(spec.label, spec.hint, value), input);
  return {
    root,
    control: input,
    set(v: number): void {
      input.value = String(v);
      value.textContent = spec.format(v);
    },
  };
}

export interface SwitchSpec {
  label: string;
  hint?: string;
  /** rendered indented, and greyed out while its parent switch is off */
  nested?: boolean;
  onToggle: (on: boolean) => void;
}

export interface SwitchRow extends Row {
  set(on: boolean): void;
  /** true = a params key backs this switch; false renders it unavailable */
  setWired(wired: boolean): void;
  /** parent switch is off, so this one cannot do anything right now */
  setMuted(muted: boolean): void;
  /** the change is real but only lands on the next launch */
  setPendingReload(pending: boolean): void;
}

export function switchRow(spec: SwitchSpec): SwitchRow {
  const lever = button('smt-switch', '');
  lever.setAttribute('role', 'switch');
  lever.setAttribute('aria-checked', 'false');
  lever.setAttribute('aria-label', spec.label);

  const badge = el('span', 'smt-badge', 'restart to apply');
  badge.hidden = true;
  const hintEl = el('span', 'smt-row-hint', spec.hint ?? '');
  const text = div('smt-row-text', el('span', 'smt-row-label', spec.label), hintEl, badge);

  const root = div(`smt-row is-switch${spec.nested ? ' is-nested' : ''}`, text, lever);
  let on = false;
  let wired = true;
  lever.addEventListener('click', () => spec.onToggle(!on));

  return {
    root,
    control: lever,
    set(next: boolean): void {
      on = next;
      lever.setAttribute('aria-checked', String(next));
    },
    setWired(next: boolean): void {
      wired = next;
      lever.disabled = !next;
      root.classList.toggle('is-unavailable', !next);
      // say WHY it is dead rather than greying it out mutely; restores the
      // real hint the moment something wires it up
      hintEl.textContent = next ? spec.hint ?? '' : 'Not in this build yet.';
    },
    setMuted(muted: boolean): void {
      root.classList.toggle('is-muted', muted && wired);
      lever.disabled = !wired || muted;
    },
    setPendingReload(pending: boolean): void {
      badge.hidden = !pending;
    },
  };
}

export interface SegmentSpec<T extends string | number> {
  label: string;
  hint?: string;
  options: readonly { value: T; label: string }[];
  onSelect: (v: T) => void;
}

export interface SegmentRow<T extends string | number> extends Row {
  set(v: T): void;
  setPendingReload(pending: boolean): void;
}

export function segmentRow<T extends string | number>(spec: SegmentSpec<T>): SegmentRow<T> {
  const seg = div('smt-seg');
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', spec.label);
  const cells = new Map<T, HTMLButtonElement>();
  for (const opt of spec.options) {
    const b = button('smt-seg-btn', opt.label);
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', 'false');
    b.addEventListener('click', () => spec.onSelect(opt.value));
    cells.set(opt.value, b);
    seg.appendChild(b);
  }
  const badge = el('span', 'smt-badge', 'restart to apply');
  badge.hidden = true;
  const text = div('smt-row-text', el('span', 'smt-row-label', spec.label));
  if (spec.hint) text.appendChild(el('span', 'smt-row-hint', spec.hint));
  text.appendChild(badge);
  const root = div('smt-row', div('smt-row-top', text), seg);
  const first = spec.options.length ? cells.get(spec.options[0].value)! : seg;
  return {
    root,
    control: first,
    set(v: T): void {
      for (const [val, b] of cells) {
        const active = val === v;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-checked', String(active));
      }
    },
    setPendingReload(pending: boolean): void {
      badge.hidden = !pending;
    },
  };
}

/** engraved section rule — groups rows by what the player is deciding about */
export function sectionHead(title: string): HTMLElement {
  return div('smt-section-head', el('span', 'smt-section-title', title), div('smt-section-rule'));
}
