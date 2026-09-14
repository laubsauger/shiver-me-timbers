/**
 * NO UI IN A SHOT, ENFORCED (user requirement for cine play AND record): while the trailer's cine is active nothing
 * but the WebGPU canvas is on screen — race HUD, dev overlays, perf HUD, Tweakpane, pause and menus, radio line,
 * markers, photo-mode captions, toasts, boot splash, the cursor. Diegetic 3D parts (the dash displays) are in the
 * scene and stay; there are no screen-space overlays drawn INTO the canvas on this page.
 *
 * Not by convention ("each overlay checks photo mode"), which is how one forgotten overlay lands in a frame: one
 * class on <html> and one rule hide EVERY element that is not the canvas or one of its ancestors, whoever created it
 * and whenever. The dev layer is switched off through its own channel as well (ui/devLayer.ts) so the debug shell
 * stops drawing rather than only being hidden, and the page's photo mode is forced by the host.
 *
 * The captured frames never contained DOM in the first place — capture reads a render target (src/cine/capture.ts) —
 * so this is what the PREVIEW shows being made to match what the RECORD writes.
 */
import { applyDevLayer, devLayerVisible } from '../../ui/devLayer';

export const CINE_CHROME_CLASS = 'smt-cine-shooting';
export const CINE_KEEP_ATTR = 'data-cine-keep';
export const CINE_CHROME_CSS =
  `html.${CINE_CHROME_CLASS}, html.${CINE_CHROME_CLASS} * { cursor: none !important; }\n` +
  `html.${CINE_CHROME_CLASS} body *:not([${CINE_KEEP_ATTR}]) { display: none !important; }`;

/** the DOM this touches, structurally (a test hands in a fake) */
export interface ChromeElement {
  parentElement: ChromeElement | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}
export interface ChromeDocument {
  documentElement: { classList: { add(c: string): void; remove(c: string): void } };
  body: ChromeElement;
  head: { appendChild(n: unknown): unknown };
  createElement(tag: 'style'): { textContent: string | null; remove(): void };
}

export interface CineChrome {
  set(on: boolean): void;
  readonly on: boolean;
}

export function createCineChrome(doc: ChromeDocument, canvas: ChromeElement): CineChrome {
  let on = false;
  let style: { remove(): void } | null = null;
  let kept: ChromeElement[] = [];
  let devBefore = true;
  return {
    get on() {
      return on;
    },
    set(next) {
      if (next === on) return;
      on = next;
      if (next) {
        // the canvas and every ancestor up to (not including) <body> survive the rule
        kept = [];
        for (let e: ChromeElement | null = canvas; e !== null && e !== doc.body; e = e.parentElement) {
          e.setAttribute(CINE_KEEP_ATTR, '');
          kept.push(e);
        }
        const s = doc.createElement('style');
        s.textContent = CINE_CHROME_CSS;
        doc.head.appendChild(s);
        style = s;
        doc.documentElement.classList.add(CINE_CHROME_CLASS);
        devBefore = devLayerVisible();
        applyDevLayer(false);
      } else {
        doc.documentElement.classList.remove(CINE_CHROME_CLASS);
        style?.remove();
        style = null;
        for (const e of kept) e.removeAttribute(CINE_KEEP_ATTR);
        kept = [];
        applyDevLayer(devBefore);
      }
    },
  };
}
