/**
 * UI overlay tunables (§V16: every tunable lives in a params module and
 * appears in Tweakpane). Consumed by src/ui/* — HUD legibility and pause
 * dim are look-tuning knobs, not settings the player owns (those live in
 * src/ui/settingsStore.ts and persist to localStorage per §V21).
 */
import { registerParams } from './registry';

export interface UiParams {
  /** overall HUD opacity 0..1 — HUD must not fight the 3D view */
  hudOpacity: number;
  /** compass tick-tape scale: horizontal pixels per degree of heading */
  compassPixelsPerDegree: number;
  /** pause backdrop dim strength 0..1 (render keeps running underneath) */
  pauseBackdropDim: number;
}

export const uiParams: UiParams = registerParams(
  'ui',
  {
    hudOpacity: 0.92,
    compassPixelsPerDegree: 3.4,
    pauseBackdropDim: 0.5,
  },
  {
    hudOpacity: { min: 0, max: 1, step: 0.01 },
    compassPixelsPerDegree: { min: 1, max: 8, step: 0.1 },
    pauseBackdropDim: { min: 0, max: 1, step: 0.01 },
  },
);
