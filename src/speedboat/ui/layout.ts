/**
 * Race HUD layout as data. The stylesheet is GENERATED from these rects (styles.ts), so the rect
 * test in tests/speedboatUiLayout.test.ts checks the geometry the browser actually gets.
 *
 * Units: the design doc's 1280×720 mockup frame. One design unit = `--u` CSS px, where
 * `--u = min(100vw / 1280, 100vh / 720)`: the mockup scales uniformly and each panel is pinned to
 * its corner, so wider screens push the panels outward and never toward the centre.
 * The HUD frame is at most 21:9 wide, centred (ultrawide safe zone, design doc §9).
 *
 * §B121 / §V21: in chase and near chase the boat sits on the screen's centre line and its wake runs
 * down the lower centre. Nothing but the gate marker and a ≤ 1.2 s toast may sit there.
 */

export const DESIGN_W = 1280;
export const DESIGN_H = 720;
/** ultrawide: the HUD frame never gets wider than this aspect */
export const MAX_ASPECT = 21 / 9;

export type Anchor = 'tl' | 'tr' | 'bl' | 'br' | 'tc';

export interface HudPanelRect {
  id: string;
  anchor: Anchor;
  /** distance from the anchor's vertical edge (tc: offset of the rect centre from the frame centre) */
  x: number;
  /** distance from the anchor's horizontal edge */
  y: number;
  w: number;
  h: number;
}

/**
 * chase + near chase. Arrangement from the design doc §9 chase mockup; sizes cut down after user
 * feedback 2026-09-13 ("too large and chunky top left, bottom left, bottom right"): the mockup's
 * blocks were ~22-25% larger in each dimension than these.
 */
export const CHASE_PANELS: readonly HudPanelRect[] = [
  { id: 'position', anchor: 'tl', x: 28, y: 24, w: 214, h: 88 },
  { id: 'standings', anchor: 'tl', x: 28, y: 120, w: 214, h: 74 },
  { id: 'timer', anchor: 'tc', x: 0, y: 18, w: 240, h: 50 },
  { id: 'radio', anchor: 'tc', x: 0, y: 74, w: 420, h: 30 },
  { id: 'plotter', anchor: 'tr', x: 24, y: 24, w: 160, h: 132 },
  { id: 'sea', anchor: 'bl', x: 28, y: 136, w: 214, h: 18 },
  { id: 'trim', anchor: 'bl', x: 28, y: 14, w: 214, h: 116 },
  { id: 'surge', anchor: 'br', x: 24, y: 136, w: 214, h: 18 },
  { id: 'speed', anchor: 'br', x: 24, y: 14, w: 214, h: 116 },
];

/**
 * cockpit: the dashboard carries speed, rpm, trim, Surge, Governor and the plotter (design doc §9).
 * The overlay keeps what the dash cannot: position/lap, the gaps either side (so no information is
 * missing versus chase, design doc §10 exit criteria), the radio strip and the gate marker.
 */
export const COCKPIT_PANELS: readonly HudPanelRect[] = [
  { id: 'position', anchor: 'tl', x: 28, y: 96, w: 176, h: 70 },
  { id: 'standings', anchor: 'tl', x: 28, y: 172, w: 190, h: 44 },
  { id: 'radio', anchor: 'tc', x: 0, y: 112, w: 420, h: 30 },
];

/** HUD size option (pause → HUD size); the whole race HUD scales by `--hud-scale` */
export const HUD_SCALES = [
  { id: 'small', label: 'Small', scale: 0.85 },
  { id: 'default', label: 'Default', scale: 1 },
  { id: 'large', label: 'Large', scale: 1.15 },
] as const;

export interface PxRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** CSS px per design unit for a viewport */
export const unitFor = (vw: number, vh: number): number => Math.min(vw / DESIGN_W, vh / DESIGN_H);

/** the HUD frame (21:9 cap, centred) */
export function frameFor(vw: number, vh: number): PxRect {
  const fw = Math.min(vw, vh * MAX_ASPECT);
  const left = (vw - fw) / 2;
  return { left, top: 0, right: left + fw, bottom: vh };
}

/** where a panel lands in CSS px, exactly as the generated stylesheet places it (`--hud-scale` = scale) */
export function placePanel(p: HudPanelRect, vw: number, vh: number, scale = 1): PxRect {
  const u = unitFor(vw, vh) * scale;
  const f = frameFor(vw, vh);
  const w = p.w * u;
  const h = p.h * u;
  let left: number;
  let top: number;
  switch (p.anchor) {
    case 'tl':
      left = f.left + p.x * u;
      top = f.top + p.y * u;
      break;
    case 'tr':
      left = f.right - p.x * u - w;
      top = f.top + p.y * u;
      break;
    case 'bl':
      left = f.left + p.x * u;
      top = f.bottom - p.y * u - h;
      break;
    case 'br':
      left = f.right - p.x * u - w;
      top = f.bottom - p.y * u - h;
      break;
    case 'tc':
      left = (f.left + f.right) / 2 + p.x * u - w / 2;
      top = f.top + p.y * u;
      break;
  }
  return { left, top, right: left + w, bottom: top + h };
}

/**
 * Width the boat and its wake scale with. three.js keeps the VERTICAL field of view, so on a
 * screen wider than 16:9 the boat and wake keep their size relative to the height and the extra
 * width is periphery; below 16:9 the width is the limit.
 */
const sceneWidth = (vw: number, vh: number): number => Math.min(vw, (vh * 16) / 9);

/** §B121: the view astern, lower centre of the VIEWPORT (the boat is centred on the viewport) */
export function lowerCentreKeepOut(vw: number, vh: number): PxRect {
  const half = 0.2 * sceneWidth(vw, vh);
  return { left: vw / 2 - half, right: vw / 2 + half, top: vh * 0.5, bottom: vh };
}

/** design doc §9: the central 40% holds only the gate marker and toasts */
export function centralKeepOut(vw: number, vh: number): PxRect {
  const half = 0.2 * sceneWidth(vw, vh);
  return { left: vw / 2 - half, right: vw / 2 + half, top: vh * 0.3, bottom: vh * 0.7 };
}

export const intersects = (a: PxRect, b: PxRect): boolean =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** `calc(n * var(--u))`: the mockup unit (full screens) */
export const u = (n: number): string => (n === 0 ? '0px' : `calc(${n} * var(--u))`);

/** `calc(n * var(--hu))`: the race-HUD unit, `--u × --hud-scale` */
export const hu = (n: number): string => (n === 0 ? '0px' : `calc(${n} * var(--hu))`);

/** CSS for one panel set, scoped under `scope` (e.g. `.sbh.is-chase`) */
export function panelCss(scope: string, panels: readonly HudPanelRect[]): string {
  return panels
    .map((p) => {
      const pos =
        p.anchor === 'tl'
          ? `left:${hu(p.x)};top:${hu(p.y)};`
          : p.anchor === 'tr'
            ? `right:${hu(p.x)};top:${hu(p.y)};`
            : p.anchor === 'bl'
              ? `left:${hu(p.x)};bottom:${hu(p.y)};`
              : p.anchor === 'br'
                ? `right:${hu(p.x)};bottom:${hu(p.y)};`
                : `left:calc(50% + ${p.x} * var(--hu) - ${p.w / 2} * var(--hu));top:${hu(p.y)};`;
      return `${scope} [data-panel="${p.id}"]{${pos}width:${hu(p.w)};height:${hu(p.h)};}`;
    })
    .join('\n');
}
