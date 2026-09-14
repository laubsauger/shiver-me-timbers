/**
 * §T.201 the speedboat's pause is reachable and really pauses; the dev overlays stay out of the player's way.
 *
 * WHY each block:
 *  - START MUST NOT CLOSE WHAT IT OPENED. The root cause of "missing a pause menu" on a pad: the race opened the pause
 *    on a Start edge, and the menu's nav read that same held Start as a fresh press on the next frame (Back = Resume),
 *    so the pause lived for one frame. A pause you cannot see is a missing pause.
 *  - PAUSE FREEZES THE SIM (§V21, §V2): a pause that still ticks moves the race (and the rivals' worker) on under the
 *    menu; the tick count is the one number that says it did not.
 *  - EVERY WAY IN reaches the same `openPause`, and the loop's pause predicate is `ui.blocking` — a new entry point that
 *    bypassed it would show a menu over a running race.
 *  - DEV OVERLAYS HIDDEN BY DEFAULT (USER: "hide the dev stuff"), `?dev` forces them on, a toggle is remembered, and a
 *    blocked store never throws at boot.
 */
import { afterEach, describe, expect, it } from 'vitest';
import raceUiSrc from '../src/speedboat/page/raceUi.ts?raw';
import mainSrc from '../src/main-speedboat.ts?raw';
import { GameLoop } from '../src/core/loop';
import { MenuNav } from '../src/speedboat/ui/nav';
import { DEV_OVERLAYS_KEY, chromeKeyFor, createPageChrome, initialDevOverlays } from '../src/speedboat/page/pageChrome';
import { devLayerVisible, resetDevLayer } from '../src/ui/devLayer';
import type { FullscreenControl } from '../src/ui/fullscreen';

const g = globalThis as unknown as Record<string, unknown>;
const saved = { window: g.window, navigator: g.navigator, raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame };
afterEach(() => {
  g.window = saved.window;
  Object.defineProperty(globalThis, 'navigator', { value: saved.navigator, configurable: true, writable: true });
  g.requestAnimationFrame = saved.raf;
  g.cancelAnimationFrame = saved.caf;
  resetDevLayer();
});

function padWithStart(held: { start: boolean }): void {
  const buttons = Array.from({ length: 17 }, (_, i) => ({ get pressed() { return i === 9 && held.start; }, value: 0 }));
  Object.defineProperty(globalThis, 'navigator', { value: { getGamepads: () => [{ connected: true, axes: [0, 0], buttons }] }, configurable: true, writable: true });
}

const fakeEl = () => ({ classList: { add() {}, remove() {} }, tabIndex: 0, focus() {}, onpointerenter: null, onclick: null, getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }) }) as unknown as HTMLElement;

describe('§T.201 pause is reachable', () => {
  it('a gamepad Start that opened the pause is not read again as Back on the next frame; a new press still is', () => {
    g.window = new EventTarget();
    const held = { start: true };
    padWithStart(held);
    let backs = 0;
    const nav = new MenuNav(() => backs++);
    nav.setItems([{ el: fakeEl(), activate() {} }]);
    nav.attach(); // the frame Start went down: raceUi.update → openPause → pause.open → nav.attach
    nav.poll(16);
    nav.poll(33);
    expect(backs, 'the held Start closed the pause it opened').toBe(0);
    held.start = false;
    nav.poll(50);
    held.start = true;
    nav.poll(66);
    expect(backs, 'a fresh Start on the open pause resumes').toBe(1);
  });

  it('Esc, gamepad Start and the on-screen button all go through openPause, and ui.blocking gates the loop', () => {
    const code = raceUiSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).toMatch(/e\.key !== 'Escape'[^\n]*\n\s*e\.preventDefault\(\);\s*openPause\(\);/);
    expect(code).toMatch(/buttons\[9\]\?\.pressed[\s\S]{0,160}openPause\(\)/);
    expect(code).toMatch(/hud\.addPauseButton\(\(\) => \{\s*if \(raceRunning && !blocking\(\)\) openPause\(\);/);
    expect(code).toMatch(/const blocking = \(\): boolean => select\.isOpen \|\| pause\.isOpen \|\| results\.isOpen;/);
    expect(mainSrc).toMatch(/\(\) => ui\.blocking \|\| session\.holdSim\(state\.tick\),\s*\);/);
  });

  it('while paused the loop keeps rendering and runs no tick; resuming ticks again', () => {
    const frames: FrameRequestCallback[] = [];
    g.requestAnimationFrame = (cb: FrameRequestCallback) => (frames.push(cb), frames.length);
    g.cancelAnimationFrame = () => undefined;
    let paused = false;
    let ticks = 0;
    let renders = 0;
    const loop = new GameLoop(() => ticks++, () => renders++, () => paused);
    loop.start();
    let t = 0;
    const step = (n: number): void => {
      for (let i = 0; i < n; i++) (frames.shift() as FrameRequestCallback)((t += 1000 / 60));
    };
    step(30);
    expect(ticks).toBeGreaterThan(0);
    paused = true;
    const atPause = ticks;
    const rendersAtPause = renders;
    step(120);
    expect(ticks, 'the sim ticked under the pause menu').toBe(atPause);
    expect(renders - rendersAtPause, 'render must continue under the menu').toBe(120);
    paused = false;
    step(30);
    expect(ticks).toBeGreaterThan(atPause);
    loop.stop();
  });
});

describe('§T.201 dev overlays', () => {
  const memStore = (init: Record<string, string> = {}) => {
    const m = new Map(Object.entries(init));
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };
  const noFullscreen: FullscreenControl = { supported: () => false, isActive: () => false, toggle() {}, subscribe: () => () => {}, dispose() {} };
  const key = (k: string, code = '') => Object.assign(new Event('keydown', { cancelable: true }), { key: k, code, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false });

  it('hidden by default; ?dev forces them on (and ?dev=0 off); a blocked store is just the default', () => {
    expect(initialDevOverlays('', null)).toBe(false);
    expect(initialDevOverlays('', memStore())).toBe(false);
    expect(initialDevOverlays('?dev', memStore())).toBe(true);
    expect(initialDevOverlays('?dev=1', memStore({ [DEV_OVERLAYS_KEY]: '0' }))).toBe(true);
    expect(initialDevOverlays('?dev=0', memStore({ [DEV_OVERLAYS_KEY]: '1' }))).toBe(false);
    expect(initialDevOverlays('', memStore({ [DEV_OVERLAYS_KEY]: '1' }))).toBe(true);
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(initialDevOverlays('', throwing)).toBe(false);
  });

  it('the page hides the debug shell at boot, Tab toggles it and the toggle is remembered', () => {
    const target = new EventTarget();
    const store = memStore();
    const chrome = createPageChrome({ search: '', store, target, fullscreen: noFullscreen });
    expect(devLayerVisible(), 'dev overlays visible on a plain speedboat.html').toBe(false);
    const e = key('Tab');
    target.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(devLayerVisible()).toBe(true);
    expect(store.m.get(DEV_OVERLAYS_KEY)).toBe('1');
    chrome.dispose();
    createPageChrome({ search: '?dev', store: memStore(), target: new EventTarget(), fullscreen: noFullscreen }).dispose();
    expect(devLayerVisible(), '?dev').toBe(true);
  });

  it('F and Alt+Enter mean full screen through the shared helper; typing into a panel field means nothing', () => {
    expect(chromeKeyFor({ ...key('f', 'KeyF'), target: null })).toBe('fullscreen');
    expect(chromeKeyFor({ ...key('Enter', 'Enter'), altKey: true, target: null })).toBe('fullscreen');
    expect(chromeKeyFor({ ...key('f', 'KeyF'), target: { tagName: 'INPUT' } as unknown as EventTarget })).toBeNull();
    let toggles = 0;
    const target = new EventTarget();
    const fs: FullscreenControl = { ...noFullscreen, supported: () => true, toggle: () => void toggles++ };
    createPageChrome({ search: '', store: null, target, fullscreen: fs });
    target.dispatchEvent(key('f', 'KeyF'));
    expect(toggles).toBe(1);
  });
});
