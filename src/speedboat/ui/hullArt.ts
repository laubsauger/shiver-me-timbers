/**
 * Side-profile hull drawing for the paint cards and the boat-select fallback preview (shown until
 * the page mounts the 3D preview). Drawn to STYLE-SPEC rev B, not to the older design-doc symbol:
 * one long low wedge with a straight sheer, welded roll arch + whip antenna, low windscreen, triple
 * outboards on a setback bracket, bare-headed pilot in strap goggles, number painted straight on the
 * topsides (no roundel, no plate). Built once per card; nothing here runs per frame.
 */
import { s, svgRoot } from './dom';
import type { CommunityPaint, GogglesOption } from './roster';

let uid = 0;

const HULL = 'M14 40 L334 40 Q372 42 396 50 L380 62 Q332 88 250 94 L22 94 Z';

export function hullProfile(paint: CommunityPaint, number: number, goggles: GogglesOption | null, detail = true): SVGSVGElement {
  const id = `sbhull${uid++}`;
  const svg = svgRoot('-34 -34 440 134', 'sb-hull-art');
  const clip = s('clipPath', { id }, s('path', { d: HULL }));
  const defs = s('defs', {}, clip);
  svg.appendChild(defs);

  // outboards + bracket (behind the transom)
  const motors = s('g');
  motors.appendChild(s('rect', { x: 2, y: 46, width: 16, height: 26, fill: '#A7ADB0' }));
  for (const [dx, shade] of [[-8, '#C9C3B6'], [0, '#E9E5DA'], [8, '#D9D3C4']] as const) {
    motors.appendChild(s('path', { d: `M${-18 + dx} 86 L${-8 + dx} 86 L${-6 + dx} 56 L${-14 + dx} 56 Z`, fill: '#3A3D40' }));
    motors.appendChild(s('path', { d: `M${-26 + dx} 34 Q${-28 + dx} 20 ${-14 + dx} 18 L${2 + dx} 18 Q${10 + dx} 20 ${8 + dx} 32 L${4 + dx} 56 L${-22 + dx} 56 Z`, fill: shade, stroke: '#151B1C', 'stroke-opacity': 0.25 }));
    motors.appendChild(s('path', { d: `M${-26 + dx} 30 L${7 + dx} 30 L${6 + dx} 36 L${-25 + dx} 36 Z`, fill: paint.hue === '#24292B' ? paint.accent : paint.hue, opacity: 0.9 }));
  }
  svg.appendChild(motors);

  // roll arch, antenna, pilot, windscreen
  if (detail) {
    svg.appendChild(s('path', { d: 'M226 12 L240 -30', stroke: '#8E979B', 'stroke-width': 1.2 }));
    svg.appendChild(s('circle', { cx: 198, cy: 22, r: 8, fill: '#C99B78' }));
    svg.appendChild(s('path', { d: 'M190 19 Q198 11 207 18 L207 15 Q198 8 189 16 Z', fill: '#3B2A20' }));
    if (goggles) {
      svg.appendChild(s('path', { d: 'M190 22 H206', stroke: goggles.strap, 'stroke-width': 2.4 }));
      svg.appendChild(s('rect', { x: 202, y: 19, width: 7, height: 5, rx: 1.5, fill: goggles.lens, stroke: '#151B1C', 'stroke-width': 0.8 }));
    }
    svg.appendChild(s('path', { d: 'M184 40 L190 30 L208 30 L212 40 Z', fill: '#CDBFA3' }));
    svg.appendChild(s('path', { d: 'M168 40 L178 12 L222 12 L232 40 M178 12 L232 40', fill: 'none', stroke: '#9AA3A7', 'stroke-width': 3.5, 'stroke-linejoin': 'round' }));
    svg.appendChild(s('path', { d: 'M236 40 L250 28 L266 28 L272 40 Z', fill: '#2A3C49', 'fill-opacity': 0.8, stroke: '#A7ADB0', 'stroke-width': 1.4 }));
  }

  // hull + paint, clipped
  svg.appendChild(s('path', { d: HULL, fill: paint.hull }));
  const g = s('g', { 'clip-path': `url(#${id})` });
  if (paint.pattern === 'band') {
    g.appendChild(s('path', { d: 'M0 50 L400 43 L400 57 L0 64 Z', fill: paint.accent }));
    g.appendChild(s('circle', { cx: 300, cy: 62, r: 7, fill: paint.accent2 }));
  } else if (paint.pattern === 'diagonals') {
    g.appendChild(s('path', { d: 'M232 94 L272 38 L288 38 L248 94 Z M264 94 L304 38 L320 38 L280 94 Z M296 94 L336 38 L352 38 L312 94 Z M328 94 L368 38 L384 38 L344 94 Z', fill: paint.accent }));
  } else {
    g.appendChild(s('path', { d: 'M40 46 L118 46 L118 80 L40 80 Z', fill: paint.accent }));
    g.appendChild(s('path', { d: 'M236 44 L290 44 L290 70 L236 72 Z', fill: paint.accent2 }));
  }
  if (paint.reflectiveTape) g.appendChild(s('path', { d: 'M0 76 L400 62', stroke: '#DCE2E3', 'stroke-width': 2.5 }));
  g.appendChild(s('path', { d: 'M60 86 L150 83 M190 80 L240 78', stroke: '#000', 'stroke-opacity': 0.1, 'stroke-width': 2 }));
  g.appendChild(s('path', { d: 'M0 88 L400 88 L400 110 L0 110 Z', fill: '#6B2E25' }));
  svg.appendChild(g);
  svg.appendChild(s('path', { d: HULL, fill: 'none', stroke: '#000', 'stroke-opacity': 0.35 }));
  svg.appendChild(s('path', { d: 'M14 39 L334 39', stroke: '#C9D0D4', 'stroke-width': 1.4 }));

  const num = s('text', { x: 150, y: 76, 'text-anchor': 'middle', fill: paint.numeral, 'font-size': 26, 'font-family': 'SB Saira Stencil, Saira Stencil One, sans-serif' });
  num.textContent = String(number);
  svg.appendChild(num);
  return svg;
}
