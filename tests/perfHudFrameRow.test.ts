/**
 * The frame row must never be able to disagree with the fps row.
 *
 * `fps 261.1` printed beside `frame 0.00 ms` was two statistics of different
 * things — a 30-frame average next to a single sample — and neither was
 * labelled. An earlier capture reading `frame 9.30 ms` was honest and still
 * misleading: the same window averaged 23.3 ms, so the frame was JITTERY, not
 * cheap, and a whole investigation was steered by reading one sample as steady
 * state (§Rule 8).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createPerfHud, FPS_WINDOW } from '../src/debug/perfHud';

beforeAll(() => {
  const el = (): unknown => ({
    style: { cssText: '' },
    textContent: '',
    appendChild: () => undefined,
    remove: () => undefined,
  });
  (globalThis as unknown as Record<string, unknown>).document = {
    createElement: el,
    body: el(),
  };
});

function hudWith(samples: number[]): string {
  const hud = createPerfHud((globalThis as any).document.body);
  for (const s of samples) hud.frame(s);
  return (hud.el as unknown as { textContent: string }).textContent;
}

const num = (text: string, label: string): number => {
  const m = new RegExp(`${label}\\s+([0-9.]+)`).exec(text);
  if (m === null) throw new Error(`no "${label}" in:\n${text}`);
  return Number(m[1]);
};

describe('perf HUD frame row', () => {
  it('reports the SAME window as fps — avg is exactly 1000/fps', () => {
    // The two rows are derived from one ring, so no capture can ever show a
    // frame time that contradicts the fps beside it.
    const text = hudWith([10, 20, 30, 12, 18]);
    const fps = num(text, 'fps');
    const avg = num(text, 'frame');
    expect(1000 / avg).toBeCloseTo(fps, 1);
  });

  it('shows the spread, so a jittery frame cannot read as a cheap one', () => {
    // 9.30 ms was a real sample from a window averaging 23.3 ms. The min alone
    // is not a lie; presenting it as "the frame" is.
    const text = hudWith([9.3, 40, 30, 9.3, 28]);
    expect(num(text, 'frame')).toBeCloseTo(23.32, 1);
    expect(text).toContain('9.30 min');
    expect(text).toContain('40.00 max');
  });

  it('says out loud when a frame had dt <= 0, because fps is then inflated', () => {
    // Chrome hands every callback fired for one frame the same rAF timestamp,
    // so dt === 0 means the render callback ran TWICE against one timestamp —
    // which doubles the reported fps while printing 0 in the frame row. That is
    // the exact shape of `fps 261.1` / `frame 0.00 ms`.
    const alternating = Array.from({ length: FPS_WINDOW }, (_, i) => (i % 2 === 0 ? 7.66 : 0));
    const text = hudWith(alternating);
    expect(text).toContain('frames had dt<=0');
    expect(text).toContain('INFLATED');
    // and the inflation is visible: 3.83 ms avg on a machine really running 7.66
    expect(num(text, 'fps')).toBeCloseTo(261, 0);
  });

  it('does not cry wolf on a healthy window', () => {
    const text = hudWith([16.7, 16.6, 16.8, 16.7]);
    expect(text).not.toContain('dt<=0');
  });
});
