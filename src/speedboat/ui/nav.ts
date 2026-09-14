/**
 * Focus navigation for the speedboat screens: keyboard, gamepad and pointer drive one focus ring.
 *
 *  - Arrows / D-pad / left stick move focus spatially (nearest item in that direction, by rect;
 *    rects are read on the input edge only, never per frame).
 *  - On an item with `adjust`, left/right change its value in place instead of moving (Governor,
 *    camera, assist dials: design doc §9 "change in place").
 *  - Enter / Space / gamepad A activate. Esc / Backspace / gamepad B go back. Start = back too
 *    (on the pause menu that is Resume).
 *
 * Gamepad state is polled by the page's frame loop (`poll(now)`), not by a timer of its own.
 */

export interface NavItem {
  el: HTMLElement;
  activate?: () => void;
  adjust?: (dir: -1 | 1) => void;
  /** focus lands here but the item stays inert */
  disabled?: boolean;
  /** called when this item gains focus (e.g. a side panel follows the focused row) */
  focus?: () => void;
}

type Dir = 'up' | 'down' | 'left' | 'right';

const REPEAT_FIRST_MS = 380;
const REPEAT_MS = 110;
const STICK = 0.55;

export class MenuNav {
  private items: NavItem[] = [];
  private index = -1;
  private attached = false;
  private readonly prevButtons = new Uint8Array(17);
  private held: Dir | null = null;
  private nextRepeat = 0;

  constructor(private readonly onBack: () => void) {}

  setItems(items: NavItem[], focusIndex = 0): void {
    for (const it of this.items) it.el.classList.remove('is-focus');
    this.items = items;
    for (const [i, it] of items.entries()) {
      it.el.tabIndex = -1;
      it.el.onpointerenter = () => this.focusAt(i);
      it.el.onclick = (e) => {
        e.preventDefault();
        this.focusAt(i);
        if (it.disabled) return;
        if (it.activate) it.activate();
        else if (it.adjust) it.adjust(1);
      };
    }
    this.index = -1;
    this.focusAt(Math.min(Math.max(0, focusIndex), items.length - 1));
  }

  get focused(): NavItem | null {
    return this.items[this.index] ?? null;
  }

  focusEl(el: HTMLElement): void {
    const i = this.items.findIndex((it) => it.el === el);
    if (i >= 0) this.focusAt(i);
  }

  focusAt(i: number): void {
    if (i === this.index || i < 0 || i >= this.items.length) return;
    this.items[this.index]?.el.classList.remove('is-focus');
    this.index = i;
    const it = this.items[i];
    it.el.classList.add('is-focus');
    it.el.focus({ preventScroll: true });
    it.focus?.();
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    window.addEventListener('keydown', this.onKey, true);
    this.primePad();
  }

  /**
   * §T.201: take the pad's CURRENT buttons as already seen. The race opens the pause on a Start edge; with a stale
   * (all-up) record, the next frame's `poll` read that same held Start as a fresh press, which is Back = Resume, and the
   * pause closed one frame after it opened. The same for A confirming the boat select into a screen that reads A.
   */
  private primePad(): void {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : null;
    this.prevButtons.fill(0);
    if (!pads) return;
    let pad: Gamepad | null = null;
    for (let i = 0; i < pads.length; i++) if (pads[i]?.connected) pad = pads[i];
    if (!pad) return;
    for (let i = 0; i < this.prevButtons.length; i++) this.prevButtons[i] = pad.buttons[i]?.pressed ? 1 : 0;
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    window.removeEventListener('keydown', this.onKey, true);
    this.held = null;
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    const k = e.key;
    let handled = true;
    if (k === 'ArrowUp' || k === 'w' || k === 'W') this.move('up');
    else if (k === 'ArrowDown' || k === 's' || k === 'S') this.move('down');
    else if (k === 'ArrowLeft' || k === 'a' || k === 'A') this.move('left');
    else if (k === 'ArrowRight' || k === 'd' || k === 'D') this.move('right');
    else if (k === 'Enter' || k === ' ') this.activate();
    else if (k === 'Escape' || k === 'Backspace') {
      // a held Esc auto-repeats: one press is one layer, never open → close → open at the key-repeat rate
      if (!e.repeat) this.onBack();
    }
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  activate(): void {
    const it = this.focused;
    if (!it || it.disabled) return;
    if (it.activate) it.activate();
    else if (it.adjust) it.adjust(1);
  }

  move(dir: Dir): void {
    const cur = this.focused;
    if (!cur) return;
    if ((dir === 'left' || dir === 'right') && cur.adjust && !cur.disabled) {
      cur.adjust(dir === 'left' ? -1 : 1);
      return;
    }
    const a = cur.el.getBoundingClientRect();
    const ax = a.left + a.width / 2;
    const ay = a.top + a.height / 2;
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < this.items.length; i++) {
      if (i === this.index) continue;
      const b = this.items[i].el.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) continue;
      const bx = b.left + b.width / 2;
      const by = b.top + b.height / 2;
      const dx = bx - ax;
      const dy = by - ay;
      const along = dir === 'up' ? -dy : dir === 'down' ? dy : dir === 'left' ? -dx : dx;
      if (along <= 1) continue;
      const across = dir === 'up' || dir === 'down' ? Math.abs(dx) : Math.abs(dy);
      const score = along + across * 2.5;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best >= 0) this.focusAt(best);
    else if (dir === 'up' || dir === 'down') {
      // wrap vertically within the list
      this.focusAt(dir === 'down' ? 0 : this.items.length - 1);
    }
  }

  /** read gamepads; call once per frame while the screen is open */
  poll(now: number): void {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : null;
    if (!pads) return;
    let pad: Gamepad | null = null;
    for (let i = 0; i < pads.length; i++) if (pads[i]?.connected) pad = pads[i];
    if (!pad) return;
    const pressed = (i: number): boolean => (pad as Gamepad).buttons[i]?.pressed === true;
    const edge = (i: number): boolean => {
      const p = pressed(i);
      const was = this.prevButtons[i] === 1;
      this.prevButtons[i] = p ? 1 : 0;
      return p && !was;
    };
    if (edge(0)) this.activate();
    if (edge(1) || edge(9)) this.onBack();
    const ax = pad.axes[0] ?? 0;
    const ay = pad.axes[1] ?? 0;
    let dir: Dir | null = null;
    if (pressed(12) || ay < -STICK) dir = 'up';
    else if (pressed(13) || ay > STICK) dir = 'down';
    else if (pressed(14) || ax < -STICK) dir = 'left';
    else if (pressed(15) || ax > STICK) dir = 'right';
    for (const b of [12, 13, 14, 15]) this.prevButtons[b] = pressed(b) ? 1 : 0;
    if (dir === null) {
      this.held = null;
      return;
    }
    if (dir !== this.held) {
      this.held = dir;
      this.nextRepeat = now + REPEAT_FIRST_MS;
      this.move(dir);
    } else if (now >= this.nextRepeat) {
      this.nextRepeat = now + REPEAT_MS;
      this.move(dir);
    }
  }
}
