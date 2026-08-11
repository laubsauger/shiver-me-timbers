/**
 * Post-processing tunables (§V.16, §V.22 aesthetic lift).
 */
import { registerParams } from './registry';

export const postParams = registerParams(
  'post',
  {
    // default OFF until the pipeline is browser-verified — enabling it
    // stalled the renderer on first try (§V22: no unverified visuals)
    enabled: false,
    aoEnabled: true,
    bloomThreshold: 0.85,
    bloomStrength: 0.22,
    bloomRadius: 0.4,
    vibrance: 0.25,
    vignetteStrength: 0.55,
    vignetteStart: 0.55,
  },
  {
    bloomThreshold: { min: 0, max: 2, step: 0.01 },
    bloomStrength: { min: 0, max: 2, step: 0.01 },
    bloomRadius: { min: 0, max: 1, step: 0.01 },
    vibrance: { min: -1, max: 1, step: 0.01 },
    vignetteStrength: { min: 0, max: 2, step: 0.01 },
    vignetteStart: { min: 0, max: 1, step: 0.01 },
  },
);
