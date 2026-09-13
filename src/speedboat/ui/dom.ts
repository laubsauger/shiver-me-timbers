/**
 * DOM builders for the speedboat UI. Build-time only: every node the HUD updates is created here
 * once and kept by reference; the frame loop writes `Text.data`, SVG animated values and class
 * toggles, never markup (no innerHTML anywhere in src/speedboat/ui).
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/** a Text node to keep and update */
export const txt = (s = ''): Text => document.createTextNode(s);

export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, ...children: SVGElement[]): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) node.setAttribute(k, String(attrs[k]));
  for (const c of children) node.appendChild(c);
  return node;
}

export function svgRoot(viewBox: string, cls: string, ...children: SVGElement[]): SVGSVGElement {
  const node = s('svg', { viewBox, class: cls, 'aria-hidden': 'true', focusable: 'false' }, ...children);
  return node;
}

/**
 * Give an SVG element a preallocated transform list [translate, rotate] and return both, so the
 * frame loop can call `setTranslate`/`setRotate` without building attribute strings.
 */
export function transformPair(owner: SVGSVGElement, el: SVGGraphicsElement): { move: SVGTransform; turn: SVGTransform } {
  const move = owner.createSVGTransform();
  const turn = owner.createSVGTransform();
  el.transform.baseVal.initialize(move);
  el.transform.baseVal.appendItem(turn);
  return { move: el.transform.baseVal.getItem(0), turn: el.transform.baseVal.getItem(1) };
}

/** a single rotate transform */
export function transformOne(owner: SVGSVGElement, el: SVGGraphicsElement): SVGTransform {
  el.transform.baseVal.initialize(owner.createSVGTransform());
  return el.transform.baseVal.getItem(0);
}

/** a stencil-black plane with the one clipped corner */
export const plane = (cls: string, ...children: Child[]): HTMLDivElement => h('div', `sb-plane ${cls}`, ...children);

/** ◂ ▸ as SVG (neither Saira face carries the small triangles) */
export function chevrons(): [SVGSVGElement, SVGSVGElement] {
  return [svgRoot('0 0 8 12', '', s('path', { d: 'M8 0 L0 6 L8 12 Z' })), svgRoot('0 0 8 12', '', s('path', { d: 'M0 0 L8 6 L0 12 Z' }))];
}
