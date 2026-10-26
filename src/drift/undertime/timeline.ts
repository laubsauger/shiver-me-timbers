/**
 * Undertime beat timeline — a PURE function of act time (§cine: shots must re-render frame-exact).
 *
 * Every value the field and the dome read comes from here, so a frame is fully decided by `t`. Values are
 * continuous across beat boundaries (tests/undertimeTimeline.test.ts): a cut in density or light at a
 * boundary would read as a pop on a dome, where the whole field of view changes at once.
 *
 * Physics it stages (drift-narrative/undertime/treatment.md): pair creation and annihilation in balance
 * (boil), creation stops as the universe cools (cool), the last pairs annihilate (annihilate), what is left
 * is the one-in-a-billion matter plus the light (remain), the scale pulls back (zoom), the leftover clumps
 * into the first stars (gather).
 */
import type { DriftParams } from '../../params/drift';

export const BEATS = ['boil', 'cool', 'annihilate', 'remain', 'zoom', 'gather'] as const;
export type Beat = (typeof BEATS)[number] | 'end';

export interface UndertimeState {
  beat: Beat;
  /** 0..1 progress inside the current beat (1 at 'end') */
  u: number;
  /** 0..1 fraction of pair slots alive */
  pairDensity: number;
  /** multiplier on each flash's brightness */
  flashGain: number;
  /** 0..1 dome-wide light fill (the annihilation light) */
  glow: number;
  /** 0..1 how far the leftover grains have appeared */
  grains: number;
  /** linear scale of the field: 1 = native, 10^-zoomDecades at the end of the zoom */
  scale: number;
  /** 0..1 how far the grains have gathered into clusters */
  gather: number;
  /** 0..1 brightness of the first starlight */
  starlight: number;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const smooth = (x: number): number => {
  const k = clamp01(x);
  return k * k * (3 - 2 * k);
};
const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;

/** start time (s) of each beat, plus the total length */
export function beatStarts(p: DriftParams): { starts: Record<(typeof BEATS)[number], number>; total: number } {
  let acc = 0;
  const starts = {} as Record<(typeof BEATS)[number], number>;
  for (const b of BEATS) {
    starts[b] = acc;
    acc += Math.max(0, p[b]);
  }
  return { starts, total: acc };
}

export function undertimeState(t: number, p: DriftParams): UndertimeState {
  const { starts, total } = beatStarts(p);
  let beat: Beat = 'end';
  let u = 1;
  for (const b of BEATS) {
    const len = Math.max(0, p[b]);
    if (t < starts[b] + len) {
      beat = b;
      u = len > 0 ? clamp01((t - starts[b]) / len) : 1;
      break;
    }
  }
  const at = (b: (typeof BEATS)[number]): number => {
    const len = Math.max(1e-6, p[b]);
    return clamp01((t - starts[b]) / len);
  };
  const cool = at('cool');
  const ann = at('annihilate');
  const rem = at('remain');
  const zoom = at('zoom');
  const gather = at('gather');
  void total;

  // pairs: all slots while boiling, thinning as it cools, the last ones go in the final wave
  const pairDensity = lerp(lerp(1, 0.22, smooth(cool)), 0, smooth(ann));
  // a flash reads brighter once pairs are readable, brightest in the final wave
  const flashGain = lerp(0.55, 1, smooth(cool)) * lerp(1, 1.6, Math.sin(Math.PI * ann));
  // light: near white while boiling, falling as it cools, a surge in the final wave, then a long fade
  const surge = Math.sin(Math.PI * ann);
  const base = lerp(lerp(1, 0.32, smooth(cool)), 0.14, smooth(ann));
  const glow = lerp(base + (1 - base) * 0.85 * surge, 0.1, smooth(rem)) * lerp(1, 0.45, smooth(zoom));
  // grains appear through the final wave (they are what the cancelling leaves behind)
  const grains = smooth(ann);
  const scale = Math.pow(10, -p.zoomDecades * smooth(zoom));
  return {
    beat,
    u,
    pairDensity,
    flashGain,
    glow,
    grains,
    scale,
    gather: smooth(gather),
    starlight: smooth((gather - 0.35) / 0.65),
  };
}
