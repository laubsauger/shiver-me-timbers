/**
 * Tiny DOM builders (§V21): all overlay DOM is built programmatically —
 * no innerHTML blobs. SVG accents (rope divider, seal emblem) are drawn
 * with createElementNS so they stay inline, CSP-friendly, zero fetches.
 */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function div(className: string, ...children: (HTMLElement | SVGElement)[]): HTMLDivElement {
  const node = el('div', className);
  for (const c of children) node.appendChild(c);
  return node;
}

export function button(className: string, label: string): HTMLButtonElement {
  const node = el('button', className, label);
  node.type = 'button';
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg(
  viewBox: string,
  className: string,
  attrs: Record<string, string> = {},
): SVGSVGElement {
  const node = document.createElementNS(SVG_NS, 'svg');
  node.setAttribute('viewBox', viewBox);
  node.setAttribute('class', className);
  node.setAttribute('aria-hidden', 'true');
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

export function svgChild<K extends keyof SVGElementTagNameMap>(
  parent: SVGElement,
  tag: K,
  attrs: Record<string, string>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent.appendChild(node);
  return node;
}

/**
 * Engraved fleuron divider: two hairlines meeting a brass diamond, flanked
 * by dots — the chart-ornament that separates title from actions.
 */
export function fleuronDivider(): SVGSVGElement {
  const s = svg('0 0 240 14', 'smt-fleuron');
  const line = { stroke: 'currentColor', 'stroke-width': '1', opacity: '0.45' };
  svgChild(s, 'line', { x1: '4', y1: '7', x2: '98', y2: '7', ...line });
  svgChild(s, 'line', { x1: '142', y1: '7', x2: '236', y2: '7', ...line });
  svgChild(s, 'circle', { cx: '106', cy: '7', r: '1.6', fill: 'currentColor', opacity: '0.55' });
  svgChild(s, 'circle', { cx: '134', cy: '7', r: '1.6', fill: 'currentColor', opacity: '0.55' });
  svgChild(s, 'path', {
    d: 'M120 1.5 L126.5 7 L120 12.5 L113.5 7 Z',
    fill: 'var(--brass)',
    stroke: 'rgba(44,33,20,0.5)',
    'stroke-width': '0.75',
  });
  return s;
}

/** engraved anchor emblem for the wax seal — line art, not clipart */
export function sealEmblem(): SVGSVGElement {
  const s = svg('0 0 24 24', 'smt-seal-emblem');
  const stroke = {
    stroke: 'rgba(46,10,8,0.6)',
    'stroke-width': '1.6',
    fill: 'none',
    'stroke-linecap': 'round',
  };
  svgChild(s, 'circle', { cx: '12', cy: '4.4', r: '2', ...stroke });
  svgChild(s, 'line', { x1: '12', y1: '6.4', x2: '12', y2: '18.5', ...stroke });
  svgChild(s, 'line', { x1: '7.5', y1: '9.6', x2: '16.5', y2: '9.6', ...stroke });
  svgChild(s, 'path', { d: 'M5 13.5 c1.2 4.4 4.2 6.8 7 6.8 c2.8 0 5.8 -2.4 7 -6.8', ...stroke });
  return s;
}
