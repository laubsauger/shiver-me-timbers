/**
 * HUD layout rule: THE LOWER CENTRE OF THE FRAME BELONGS TO THE SEA (§V21 —
 * the HUD is quiet and does not fight the view).
 *
 * WHY: every chase lens (the raft's follow cam, the galleon's) frames the
 * vessel on the screen's centre line, so the water astern — the wake the
 * whole W-series exists to draw — runs straight down the lower centre. The
 * plaque row used to be ONE 700 px strip centred there
 * (`left: 50%; translateX(-50%)`), and browser sync 2026-09-13 shot the raft's
 * wake disappearing under it (`raft-followcam-2ms-hud-covers-wake.jpg`).
 *
 * The property pinned here is structural, because node has no layout engine:
 * the row is two wings driven to the frame's gutters with the free space
 * BETWEEN them, and no plaque was dropped to buy that space (the fix moves
 * information, it does not delete it). A centred row, a third wing in the
 * middle, or a plaque quietly removed each fail one of these.
 * Node env, no DOM: reads the stylesheet string and the HUD module source.
 */
import { describe, expect, it } from 'vitest';
import { HUD_CSS } from '../src/ui/stylesHud';
import hudSource from '../src/ui/hud.ts?raw';

/** the declarations of the FIRST top-level rule whose selector is exactly `sel` */
function rule(css: string, sel: string): string {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(^|\\n)${esc}\\s*\\{([^}]*)\\}`).exec(css);
  expect(m, `rule ${sel}`).not.toBeNull();
  return (m as RegExpExecArray)[2];
}

describe('HUD plaque row leaves the lower centre to the view astern', () => {
  it('the binnacle spans the frame between gutters instead of centring one strip', () => {
    const b = rule(HUD_CSS, '.smt-binnacle');
    expect(b).not.toMatch(/left:\s*50%/);
    expect(b).not.toMatch(/translateX\(-50%\)/);
    expect(b).toMatch(/left:\s*\d+px/);
    expect(b).toMatch(/right:\s*\d+px/);
  });

  it('the row pushes its wings to the corners, free space in the middle', () => {
    const row = rule(HUD_CSS, '.smt-bottom');
    expect(row).toMatch(/justify-content:\s*space-between/);
    // it must fill the binnacle's width, or space-between has nothing to spread
    expect(row).toMatch(/align-self:\s*stretch/);
  });

  it('exactly two wings, and all four plaques survive the move, port to starboard', () => {
    const m = /div\(\s*'smt-bottom',([\s\S]*?)\n\s*\);/.exec(hudSource);
    expect(m, 'smt-bottom construction').not.toBeNull();
    const body = (m as RegExpExecArray)[1];
    const wings = [...body.matchAll(/div\('smt-wing is-(\w+)',\s*([^)]*)\)/g)].map((w) => [w[1], w[2].split(',').map((s) => s.trim())]);
    expect(wings).toEqual([
      ['port', ['anchorBtn', 'windCard']],
      ['starboard', ['plate', 'canvasCard']],
    ]);
  });
});
