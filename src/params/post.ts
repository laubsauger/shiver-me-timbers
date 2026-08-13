/**
 * Post-processing tunables (§V.16, §V.22 aesthetic lift).
 *
 * Two levels of control (see src/core/postPipeline.ts for the why):
 *  - `*Enabled` are CONSTRUCTION-time gates. They add or omit whole nodes, so
 *    changing one needs a reload — deliberate: a stage that renders wrong has
 *    to LEAVE the graph to be ruled out, damping its output is not enough.
 *    A disabled stage also costs nothing at boot (no pipelines compiled),
 *    which matters while the splash waits on compileAsync.
 *  - the numeric knobs are LIVE uniforms with an exact identity value, so the
 *    panel can fade any stage out mid-frame without a rebuild.
 */
import { registerParams } from './registry';

export const postParams = registerParams(
  'post',
  {
    enabled: true,

    // --- AO ------------------------------------------------------------
    // OFF by default, and it is a real trade rather than a hedge:
    //  * GTAO reads the scene pass DEPTH, and a multisampled depth attachment
    //    cannot be resolved on WebGPU — so constructing AO forces the scene
    //    pass to `samples: 0`, i.e. it costs the WHOLE FRAME its MSAA. On a
    //    rig with 48 ropes and thin yard/rail geometry that is a bigger
    //    visual loss than the occlusion is a gain.
    //  * the ocean is transparent + depthWrite=false, so water is absent from
    //    that depth buffer: AO can only ground the ship against ITSELF, never
    //    against the sea. Hull-to-water contact darkening needs T30 planar
    //    reflections or a dedicated pass.
    // Turn it on when shooting a close hull/deck shot where the interior
    // occlusion is the point and edge aliasing is not.
    aoEnabled: false,
    aoStrength: 0.6,

    // --- bloom ---------------------------------------------------------
    // The one effect that actually reads as "premium" here: the scene is full
    // of small very-bright things against dark water (sun disc, glint road,
    // foam crests, sunlit canvas) which is exactly what bloom flatters.
    bloomEnabled: true,
    // DISPLAY-REFERRED threshold: 1.0 means "the luminance that tone-maps to
    // white". The scene pass is scene-linear and PRE-exposure, so the pipeline
    // divides this by renderer.toneMappingExposure before it reaches the
    // shader (§V.31b — maths in the wrong space under-corrects silently).
    // Authoring it this way keeps the knob meaningful when exposure moves.
    // Below ~0.8 the sky itself starts to contribute and bloom reads as FOG.
    bloomThreshold: 1.0,
    // soft knee width above the threshold, in the same display-referred unit.
    // three's default (0.01) is a razor edge, which makes the ocean glint
    // field pop on and off as sparkles cross it — the same class of problem
    // as §V.48 aliasing, one threshold away.
    bloomKnee: 0.5,
    bloomStrength: 0.35,
    bloomRadius: 0.55,
    // §V.44: bloom is an ADDITIVE term, so bound its input AT SOURCE. Linear
    // scene units; the sun disc and specular spikes run far past this and the
    // blur would otherwise smear a four-digit value across a fifth of the
    // screen. Bounds the bloom path only — the beauty keeps its full range.
    bloomClamp: 12,

    // --- god rays / fake volumetric light ------------------------------
    // Radial blur of a bright pass, marched toward the sun's screen position.
    // The ship's own rigging is the shaft generator — see src/core/postGodRays.
    godRaysEnabled: true,
    /** overall gain. The additive term is bounded by godRayClamp × this. */
    godRayIntensity: 0.55,
    /** per-tap weight; shapes shaft LENGTH. Brightness is normalised out. */
    godRayDecay: 0.96,
    /** display-referred, like bloomThreshold: 1.0 = "tone-maps to white" */
    godRayThreshold: 1.0,
    godRayKnee: 0.6,
    /**
     * Fraction of the distance to the sun covered by the march.
     *
     * THIS IS THE KNOB THAT SET THE CONE. A pixel at radial distance d samples
     * radial distances [(1−length)·d, d], so it can only reach a bright region
     * of radius R when (1−length)·d ≤ R: the smear extends to 1/(1−length)
     * times the radius of whatever is above threshold. At 0.65 that is 2.86×,
     * and at sunset the aureole above `godRayThreshold` is already a large soft
     * blob, so it was magnified into the smooth plume the user reported —
     * "projected in a very weird direction, like either very much up into the
     * sky". The up/down asymmetry is the sea: below the sun the frame is ocean,
     * mostly under threshold, so only the upward half of the smear had anything
     * to carry. The ocean was the only occluder in the shot and it occluded
     * exactly one side.
     *
     * 0.28 caps the magnification at 1.39×, which reads as a tight glow hugging
     * the disc. That is the honest shape for this technique on open water:
     * shafts are made by OCCLUDERS, and with nothing between the camera and the
     * sun there is no shaft structure to reveal, only a smear. The masts, yards,
     * 48 ropes and 162 ratline rungs earn the shafts back the moment they are
     * between the camera and the sun, which is what the module was built for.
     */
    godRayLength: 0.28,
    /**
     * Radius around the sun over which shafts fade to nothing, in the ROUND
     * screen metric (postGodRays applies the aspect ratio — screenUV is 0..1
     * per axis, so a raw UV radius is an ellipse and changed shape with the
     * window).
     *
     * 0.9 → 0.32. At 0.9 this term was ≈1 everywhere the march has any energy,
     * i.e. inert: it never hugged anything, and the comment claiming it did was
     * describing an intention rather than the number. 0.32 sits just outside
     * the reach of the shortened march above, so it now does the job it is
     * named for without clipping the effect it is bounding.
     */
    godRayFalloff: 0.32,
    /** §V.44 — bounds every tap the march can read, in linear scene units */
    godRayClamp: 12,
    /** DEGREES past the frame corner over which the sun fades out. Not a hard
     *  cut at the border: real shafts continue when the source is just
     *  off-screen, and cutting there is what makes this technique snap.
     *  Measured in angle, not NDC — NDC is tan(θ)/tan(halfFov) and runs to
     *  infinity at the frustum plane, which compressed the whole fade into
     *  ~8° of camera rotation (caught by tests/postGodRays.test.ts). */
    godRayEdgeFade: 25,
    /** BUILD-TIME (§V.28: Loop bounds must be literal). Reload to change. */
    godRayTaps: 32,
    /** BUILD-TIME resolution scale for both god-ray targets. Reload. */
    godRayScale: 0.5,

    // --- depth of field ------------------------------------------------
    // OFF, and it should stay off for gameplay: the follow cam sits ~28m out
    // and everything else in frame runs to the horizon, so a DoF tuned to
    // separate the ship blurs ~everything else — a horizon-heavy image turns
    // to smear. It is also NOT cheap (4 extra render targets, a 64-tap plus a
    // 16-tap bokeh gather). Kept as an opt-in for photo mode / close hull
    // shots, where it genuinely earns its keep.
    dofEnabled: false,
    /** metres along the view axis that stay sharp (follow-cam ship distance) */
    dofFocus: 28,
    /** metres from the focal plane to fully out-of-focus */
    dofRange: 45,
    /** unitless bokeh size */
    dofBokeh: 2,

    // --- grade ---------------------------------------------------------
    // Applied AFTER tone mapping, on purpose. `vibrance` EXTRAPOLATES away
    // from the max channel, so on unbounded HDR input it drives channels
    // NEGATIVE (measured on a linear (2.0, 0.3, 0.05) sunset pixel: green
    // −1.25, blue −1.73), and ACES + the sRGB transfer both turn negatives
    // into NaN. In display space the input is 0..1 and the operation is
    // bounded by construction (§V.44).
    vibranceEnabled: true,
    vibrance: 0.18,

    // Vignette stays PRE tone map: there it is a lens exposure falloff, a
    // plain multiply that the tone curve then rolls off gracefully. Applied
    // after the curve it just crushes the corners toward black.
    vignetteEnabled: true,
    vignetteStrength: 0.35,
    /** screenUV radius where falloff starts (frame centre = 0) */
    vignetteStart: 0.45,
    /** radius of full strength. The frame corner is always exactly √0.5 ≈
     *  0.707 in screenUV, so anything past ~0.72 never reaches full effect —
     *  the old 1.15 end edge is why the vignette was invisible. */
    vignetteEnd: 0.72,

    // --- output dither -------------------------------------------------
    // Interleaved-gradient dither before the 8-bit framebuffer. The sky is one
    // huge smooth gradient and banding on it is the artifact that survives
    // video compression WORST — it is the cheapest thing in this file and the
    // most visible on a recorded capture (§T.39). Static, not animated:
    // moving grain destroys H.264 bitrate for no visual gain here.
    grainEnabled: true,
    /** display-space amplitude; ~1.5/255 */
    grainAmount: 0.006,
  },
  {
    aoStrength: { min: 0, max: 1, step: 0.01 },
    bloomThreshold: { min: 0, max: 3, step: 0.01 },
    bloomKnee: { min: 0.01, max: 2, step: 0.01 },
    bloomStrength: { min: 0, max: 2, step: 0.01 },
    bloomRadius: { min: 0, max: 1, step: 0.01 },
    bloomClamp: { min: 1, max: 64, step: 0.5 },
    godRayIntensity: { min: 0, max: 3, step: 0.01 },
    godRayDecay: { min: 0.5, max: 1, step: 0.001 },
    godRayThreshold: { min: 0, max: 3, step: 0.01 },
    godRayKnee: { min: 0.01, max: 2, step: 0.01 },
    godRayLength: { min: 0, max: 1.5, step: 0.01 },
    godRayFalloff: { min: 0.05, max: 2, step: 0.01 },
    godRayClamp: { min: 1, max: 64, step: 0.5 },
    godRayEdgeFade: { min: 1, max: 90, step: 1 },
    godRayTaps: { min: 4, max: 128, step: 1 },
    godRayScale: { min: 0.1, max: 1, step: 0.05 },
    dofFocus: { min: 1, max: 400, step: 0.5 },
    dofRange: { min: 1, max: 400, step: 0.5 },
    dofBokeh: { min: 0, max: 8, step: 0.05 },
    vibrance: { min: -1, max: 1, step: 0.01 },
    vignetteStrength: { min: 0, max: 2, step: 0.01 },
    vignetteStart: { min: 0, max: 1, step: 0.01 },
    vignetteEnd: { min: 0, max: 1, step: 0.01 },
    grainAmount: { min: 0, max: 0.05, step: 0.001 },
  },
);
