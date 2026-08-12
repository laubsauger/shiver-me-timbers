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
  /**
   * Half-angle of the no-go wedge engraved on the wind rose (deg off the bow).
   * It is a READOUT of the rig's own stall angle, so if sailing retunes how
   * close she points, move this to match or the dial starts lying.
   */
  windNoGoDegrees: number;
  /** wind vane damping per frame, 0..1 (1 = snap to the raw bearing) */
  windVaneSmoothing: number;
}

export const uiParams: UiParams = registerParams(
  'ui',
  {
    hudOpacity: 0.92,
    compassPixelsPerDegree: 3.4,
    pauseBackdropDim: 0.5,
    windNoGoDegrees: 42,
    windVaneSmoothing: 0.12,
  },
  {
    hudOpacity: { min: 0, max: 1, step: 0.01 },
    compassPixelsPerDegree: { min: 1, max: 8, step: 0.1 },
    pauseBackdropDim: { min: 0, max: 1, step: 0.01 },
    windNoGoDegrees: { min: 5, max: 80, step: 1 },
    windVaneSmoothing: { min: 0.01, max: 1, step: 0.01 },
  },
);
