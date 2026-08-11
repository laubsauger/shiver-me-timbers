/**
 * Post-processing tunables (§V.16, §V.22 aesthetic lift).
 */
import { registerParams } from './registry';

export const postParams = registerParams(
  'post',
  {
    // OFF pending fix: the pipeline currently renders a black frame (§V22
    // in-browser check, 2026-08-11). §B.5 was NOT the cause — the renderer
    // keeps ticking, the post chain just outputs black. Default stays false
    // so the shared tree is always reviewable; flip it at RUNTIME
    // (`await import('/src/params/post.ts')` → postParams.enabled = true)
    // to work on it. Per-stage gates below bisect which stage blackens it.
    enabled: false,
    // per-stage gates (§V.16). The `*Enabled` flags are read when the
    // pipeline is CONSTRUCTED: they add/omit whole nodes, so flipping one
    // needs a reload — that is deliberate, a misbehaving pass has to leave
    // the graph to be ruled out, damping its output is not enough. The
    // numeric knobs below are live uniforms with 0 as an exact identity,
    // so a value-level regression can still be faded out from the panel.
    aoEnabled: true,
    // conservative: full-strength AO flattens the stylised pigment look
    // (§V.20) even where it grounds the hull. Needs a visual tuning pass.
    aoStrength: 0.6,
    bloomEnabled: true,
    vibranceEnabled: true,
    vignetteEnabled: true,
    bloomThreshold: 0.85,
    bloomStrength: 0.22,
    bloomRadius: 0.4,
    vibrance: 0.25,
    vignetteStrength: 0.55,
    vignetteStart: 0.55,
  },
  {
    aoStrength: { min: 0, max: 1, step: 0.01 },
    bloomThreshold: { min: 0, max: 2, step: 0.01 },
    bloomStrength: { min: 0, max: 2, step: 0.01 },
    bloomRadius: { min: 0, max: 1, step: 0.01 },
    vibrance: { min: -1, max: 1, step: 0.01 },
    vignetteStrength: { min: 0, max: 2, step: 0.01 },
    vignetteStart: { min: 0, max: 1, step: 0.01 },
  },
);
