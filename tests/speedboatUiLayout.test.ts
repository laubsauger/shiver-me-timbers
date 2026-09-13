/**
 * §B121 / §V21 for the speedboat HUD: THE LOWER CENTRE BELONGS TO THE WAKE.
 *
 * WHY: the chase camera frames the boat on the screen's centre line (design doc §6), so the rooster
 * tail and wake, which are how you read speed, a rival's line and a wake crest to jump, run straight
 * down the lower centre. B121 caught the pirate HUD sitting on exactly that. The design doc adds
 * that the central 40% holds only the gate marker and short toasts.
 *
 * Node has no layout engine, so this checks the ONE geometry the browser gets: the stylesheet is
 * generated from `CHASE_PANELS` (asserted below), and `placePanel` reproduces its anchoring, so
 * rect tests on `placePanel` are rect tests on the DOM. The browser pass cross-checks with
 * getBoundingClientRect (harness `__sbHarness.rects()`).
 */
import { describe, expect, it } from 'vitest';
import {
  CHASE_PANELS,
  COCKPIT_PANELS,
  HUD_SCALES,
  centralKeepOut,
  intersects,
  lowerCentreKeepOut,
  placePanel,
  unitFor,
  type HudPanelRect,
} from '../src/speedboat/ui/layout';
import { SPEEDBOAT_UI_CSS } from '../src/speedboat/ui/styles';

/** 16:9, 16:10, 4:3, 5:4, 21:9, 32:9 and a small laptop */
const VIEWPORTS: [number, number][] = [
  [1920, 1080], [1280, 720], [2560, 1440], [3840, 2160], [1920, 1200], [1440, 900], [1024, 768], [1280, 1024], [2560, 1080], [3440, 1440], [5120, 1440], [1366, 768],
];

describe('chase HUD leaves the view astern clear (§B121)', () => {
  it('every panel is clear of the lower-centre keep-out at every aspect and every HUD size', () => {
    for (const { scale } of HUD_SCALES) {
      for (const [vw, vh] of VIEWPORTS) {
        const keep = lowerCentreKeepOut(vw, vh);
        for (const p of CHASE_PANELS) {
          const r = placePanel(p, vw, vh, scale);
          expect(intersects(r, keep), `${p.id} at ${vw}×${vh} ×${scale}: ${JSON.stringify(r)}`).toBe(false);
        }
      }
    }
  });

  it('nothing but the gate marker and toasts sits in the central 40% (they are not panels)', () => {
    for (const [vw, vh] of VIEWPORTS) {
      const mid = centralKeepOut(vw, vh);
      for (const p of CHASE_PANELS) expect(intersects(placePanel(p, vw, vh), mid), `${p.id} at ${vw}×${vh}`).toBe(false);
    }
  });

  it('cockpit overlay also stays out of both', () => {
    for (const [vw, vh] of VIEWPORTS) {
      for (const p of COCKPIT_PANELS) {
        const r = placePanel(p, vw, vh, HUD_SCALES[HUD_SCALES.length - 1].scale);
        expect(intersects(r, lowerCentreKeepOut(vw, vh)), p.id).toBe(false);
        expect(intersects(r, centralKeepOut(vw, vh)), p.id).toBe(false);
      }
    }
  });

  it('panels stay on screen and do not overlap each other', () => {
    for (const [vw, vh] of VIEWPORTS) {
      for (const set of [CHASE_PANELS, COCKPIT_PANELS]) {
        const rects = set.map((p) => ({ id: p.id, r: placePanel(p, vw, vh, HUD_SCALES[HUD_SCALES.length - 1].scale) }));
        for (const { id, r } of rects) {
          expect(r.left, id).toBeGreaterThanOrEqual(0);
          expect(r.top, id).toBeGreaterThanOrEqual(0);
          expect(r.right, id).toBeLessThanOrEqual(vw + 1e-6);
          expect(r.bottom, id).toBeLessThanOrEqual(vh + 1e-6);
        }
        for (let i = 0; i < rects.length; i++)
          for (let j = i + 1; j < rects.length; j++)
            expect(intersects(rects[i].r, rects[j].r), `${rects[i].id} × ${rects[j].id} at ${vw}×${vh}`).toBe(false);
      }
    }
  });

  it('the check can fail: a centred bottom strip (the B121 shape) is caught', () => {
    const strip: HudPanelRect = { id: 'strip', anchor: 'bl', x: 290, y: 16, w: 700, h: 60 };
    expect(intersects(placePanel(strip, 1920, 1080), lowerCentreKeepOut(1920, 1080))).toBe(true);
  });

  it('ultrawide: the HUD frame is capped at 21:9, so corner panels do not fly to the bezels', () => {
    const speed = CHASE_PANELS.find((p) => p.id === 'speed') as HudPanelRect;
    const r = placePanel(speed, 5120, 1440);
    const fw = 1440 * (21 / 9);
    expect(r.right).toBeCloseTo((5120 + fw) / 2 - speed.x * unitFor(5120, 1440), 3);
  });
});

describe('the stylesheet is generated from the layout data', () => {
  const rule = (scope: string, id: string): string => {
    const m = new RegExp(`${scope.replace(/\./g, '\\.')} \\[data-panel="${id}"\\]\\{([^}]*)\\}`).exec(SPEEDBOAT_UI_CSS);
    expect(m, `${scope} ${id}`).not.toBeNull();
    return (m as RegExpExecArray)[1];
  };
  it('each chase and cockpit panel rule carries its rect', () => {
    for (const [scope, set] of [['.sbh.is-chase', CHASE_PANELS], ['.sbh.is-cockpit', COCKPIT_PANELS]] as const) {
      for (const p of set) {
        const css = rule(scope, p.id);
        expect(css).toContain(`width:calc(${p.w} * var(--hu))`);
        expect(css).toContain(`height:calc(${p.h} * var(--hu))`);
        if (p.anchor === 'bl' || p.anchor === 'br') expect(css).toContain(`bottom:calc(${p.y} * var(--hu))`);
        if (p.anchor === 'br' || p.anchor === 'tr') expect(css).toContain(`right:calc(${p.x} * var(--hu))`);
      }
    }
  });
  it('one variable scales the race HUD: --hu = the mockup unit × --hud-scale', () => {
    expect(SPEEDBOAT_UI_CSS).toMatch(/--u:\s*min\(calc\(100vw \/ 1280\), calc\(100vh \/ 720\)\)/);
    expect(SPEEDBOAT_UI_CSS).toMatch(/--hud-scale:\s*1;/);
    expect(SPEEDBOAT_UI_CSS).toMatch(/--hu:\s*calc\(var\(--u\) \* var\(--hud-scale\)\)/);
    // placePanel honours the same variable
    const p = CHASE_PANELS[0];
    expect(placePanel(p, 1920, 1080, 0.85).right - placePanel(p, 1920, 1080, 0.85).left).toBeCloseTo(p.w * 1.5 * 0.85);
  });
});

describe('legibility floors', () => {
  const fontUnits = (sel: string): number => {
    const m = new RegExp(`(^|\\n)${sel.replace(/\./g, '\\.')}\\s*\\{[^}]*font-size:\\s*calc\\(([\\d.]+) \\* var\\(--hu\\)\\)`).exec(SPEEDBOAT_UI_CSS);
    expect(m, sel).not.toBeNull();
    return Number((m as RegExpExecArray)[2]);
  };
  const u1080 = unitFor(1920, 1080);
  it('design doc §9 at 1080p, default size: speed ≥ 64 px, position ≥ 88 px (font size), chase and cockpit', () => {
    expect(fontUnits('.sbh-speed-v') * u1080).toBeGreaterThanOrEqual(64);
    expect(fontUnits('.sbh-pos-p') * u1080).toBeGreaterThanOrEqual(88);
    expect(fontUnits('.sbh.is-cockpit .sbh-pos-p') * u1080).toBeGreaterThanOrEqual(88);
  });
  it('1280×720 is the minimum screen: at the smallest HUD size no HUD text is under 8 px', () => {
    const smallest = Math.min(...HUD_SCALES.map((s) => s.scale));
    const u720 = unitFor(1280, 720);
    const hudCss = SPEEDBOAT_UI_CSS.slice(SPEEDBOAT_UI_CSS.indexOf('.sbh-frame'), SPEEDBOAT_UI_CSS.indexOf('.sbs {'));
    const sizes = [...hudCss.matchAll(/font-size:\s*calc\(([\d.]+) \* var\(--hu\)\)/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(30);
    expect(Math.min(...sizes) * u720 * smallest).toBeGreaterThanOrEqual(8);
  });
});
