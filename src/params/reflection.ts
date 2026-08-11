/**
 * Planar water reflection tunables (§V16, §V26, §V17).
 *
 * §V26 is the contract this module serves: ocean reflections are a MIRRORED
 * SCENE PASS (ship, islands, clouds visible in the water), resolution ≤ half,
 * blur ok, fresnel-blended. Analytic-sky-only is explicitly not acceptable as
 * the final look — but it stays as the fallback whenever the mirror pass is
 * off (quality setting, camera underwater, first frame).
 *
 * Two levels of control, mirroring src/core/postPipeline's convention:
 *  - `enabled` / `generateMipmaps` / `cloudsInReflection` are CONSTRUCTION
 *    gates (reload to apply). They decide whether nodes/objects exist at all.
 *  - everything else is a live uniform, and `strength: 0` is an exact
 *    identity — the water falls back to the analytic sky with no rebuild.
 *  - `live` is the runtime kill switch that actually SKIPS the second scene
 *    pass (it early-returns out of the reflector's updateBefore), so the
 *    graphics-quality setting buys back the whole render cost, not just the
 *    texture fetch.
 *
 * §V17 note: this is a SECOND full scene render every frame. resolutionScale
 * is hard-clamped to REFLECTION_MAX_RESOLUTION_SCALE in code (§V26 "res ≤
 * half") — the clamp is an invariant, not a suggestion, so the panel cannot
 * push it past half.
 */
import { registerParams } from './registry';

/** §V26: reflection resolution may never exceed half the drawing buffer. */
export const REFLECTION_MAX_RESOLUTION_SCALE = 0.5;
/** below this the RT degenerates to a few texels and mip blur goes to mush */
export const REFLECTION_MIN_RESOLUTION_SCALE = 0.05;

export interface ReflectionParams {
  /** build the mirror pass at all, 0|1 (reload) — 0 = analytic sky only */
  enabled: number;
  /** runtime on/off: 0 skips the whole second scene render this frame */
  live: number;
  /** RT size as a fraction of the drawing buffer — clamped to ≤ 0.5 (§V26) */
  resolutionScale: number;
  /**
   * how much of the reflected colour comes from the mirror pass vs the
   * analytic sky gradient. This sits INSIDE the ocean's own fresnel ×
   * `reflectionStrength` cap (0.13), so 1.0 here is still painted water,
   * not a mirror (§V20).
   */
  strength: number;
  /** multiplier on the sampled reflection — desaturate/cool it into the sea */
  tint: string;
  /** screen-space UV offset per unit of surface slope (fraction of screen) */
  distortSlope: number;
  /** extra offset per metre of horizontal (choppy) displacement */
  distortChop: number;
  /** hard cap on the total screen offset — keeps the tap local (§V28) */
  distortMax: number;
  /** metres: full mirror pass inside this radius */
  fadeStart: number;
  /** metres: pure analytic sky beyond this — the RT carries no detail there */
  fadeEnd: number;
  /** mip level sampled at the camera */
  blurNear: number;
  /** mip level sampled at fadeEnd */
  blurFar: number;
  /** extra mip level per metre of horizontal displacement (chop → mush) */
  blurChop: number;
  /** ceiling on the mip level so the reflection never turns into a flat block */
  blurMax: number;
  /** build the mip chain for the blur, 0|1 (reload). 0 pins blur* to 0. */
  generateMipmaps: number;
  /** add the mirrored cloud quad to the reflection pass, 0|1 (reload) */
  cloudsInReflection: number;
}

export const reflectionParams: ReflectionParams = registerParams(
  'reflection',
  {
    // BUILT, but OFF by default — a §V17 decision, not a §V26 retreat.
    //
    // Measured budget (§V39 method: renderAsync + onSubmittedWorkDone, never
    // rAF-derived fps): the whole frame is 8.1 ms against a §V17 render
    // ceiling of 8 ms, with islands, caustics and the new foam reduction
    // passes still to be accounted for. The mirror pass is a SECOND scene
    // render — estimated +1.0–2.0 ms at half resolution — which would put the
    // frame around 10 ms. Shipping that on by default would be choosing this
    // feature over §V17 before the user has seen either side of the trade.
    //
    // §V26 still stands: analytic-sky-only is ⊥ as the FINAL look, so this
    // has to end up on. `live` is the lever — flipping it in the panel skips
    // or restores the entire second scene render, live, so the look and its
    // cost can be judged side by side and the call made on real numbers.
    //
    // Why `enabled: 1` while `live: 0`: `enabled` is the CONSTRUCTION gate,
    // so leaving it on keeps the reflector node compiled into the ocean
    // material and makes the toggle instant instead of reload-gated. The
    // residual cost of that is one fetch of a 1×1 default texture per water
    // pixel, multiplied by a zero weight — fully cached, well under 0.05 ms.
    // No render target is allocated until the pass first runs. Set `enabled`
    // to 0 for a genuinely zero-cost build (reload to apply).
    enabled: 1,
    live: 0,
    resolutionScale: 0.5,
    strength: 1.0,
    // reflections read hard next to watercolour pigment; a touch cool and
    // under 1 lets the body colour keep the frame (§V20)
    tint: '#dfeef5',
    distortSlope: 0.06,
    distortChop: 0.012,
    distortMax: 0.05,
    fadeStart: 350,
    fadeEnd: 1400,
    blurNear: 0.35,
    blurFar: 2.5,
    blurChop: 0.6,
    blurMax: 4.0,
    generateMipmaps: 1,
    cloudsInReflection: 1,
  },
  {
    enabled: { min: 0, max: 1, step: 1 },
    live: { min: 0, max: 1, step: 1 },
    resolutionScale: {
      min: REFLECTION_MIN_RESOLUTION_SCALE,
      max: REFLECTION_MAX_RESOLUTION_SCALE,
      step: 0.05,
    },
    strength: { min: 0, max: 1, step: 0.01 },
    distortSlope: { min: 0, max: 0.3, step: 0.002 },
    distortChop: { min: 0, max: 0.1, step: 0.001 },
    distortMax: { min: 0, max: 0.2, step: 0.002 },
    fadeStart: { min: 20, max: 4000, step: 10 },
    fadeEnd: { min: 50, max: 8000, step: 10 },
    blurNear: { min: 0, max: 4, step: 0.05 },
    blurFar: { min: 0, max: 8, step: 0.05 },
    blurChop: { min: 0, max: 4, step: 0.05 },
    blurMax: { min: 0, max: 8, step: 0.1 },
    generateMipmaps: { min: 0, max: 1, step: 1 },
    cloudsInReflection: { min: 0, max: 1, step: 1 },
  },
);
