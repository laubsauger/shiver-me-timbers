/**
 * Foam compute passes (§V6, §C: heavy sims = `Fn().compute()`):
 * - inject: the MINIMUM EIGENVALUE of the displacement jacobian (foamMath
 *   .minEigenvalue — Tessendorf's actual folding signal, not det J), biased by
 *   the elevation the other cascades contribute here, below the live per-band
 *   gate adds foam ∝ how far below, accumulated onto the previous frame's
 *   foam, clamped ≤ 1. TWO CHANNELS: R is the long residue, G the short-clock
 *   BREAKING rate — see foamMath, "THE MASK WAS DWELL TIME".
 * - blurDecay: isotropic 3×3 gaussian × decay factor every frame — the
 *   progressive blur that leaves crests sharp at birth then spreads and
 *   dissipates them (Rare, SIGGRAPH '18: "we progressively blur the result of
 *   the foam buffer WITH FEEDBACK", i.e. one blur per frame, age = blur
 *   count; there is no anisotropy in the reference and there is none here).
 * Taps wrap (texture tiles with its cascade domain — a seam would draw grid
 * lines on the ocean). CPU mirror of the math: foamMath.ts (tested).
 */
import {
  Fn,
  float,
  instanceIndex,
  int,
  ivec2,
  textureLoad,
  select,
  textureStore,
  uniform,
  vec2,
  vec4,
} from 'three/tsl';
import type * as THREE from 'three/webgpu';
import { loadCascadeLayer, type CascadeLayer } from '../ocean/oceanTextures';
import { fbm2 } from '../terrain/noise';
import { GAUSSIAN_3X3 } from './foamMath';

/** live-tweaked uniforms shared by every cascade's passes */
export function createFoamUniforms() {
  return {
    /** λ− gate for THIS band, in λ− units (foamMath.eigenFoamGate, §V36) */
    uBias: uniform(0),
    /** injectStrength · dt / σ(λ−), precomputed CPU-side per fixed tick (§V2) */
    uInjectPerFrame: uniform(0),
    /** per-frame decay factor from decayHalfLife (foamMath.decayFactorPerFrame) */
    uDecay: uniform(1),
    /**
     * per-frame decay of the BREAKING channel (G), from breakingHalfLife.
     * ~6× faster than uDecay, which is the whole point: see foamMath, "THE
     * MASK WAS DWELL TIME, NOT BREAKING INTENSITY".
     */
    uDecayBreaking: uniform(1),
    /**
     * λ− bias per METRE of the elevation the OTHER cascades contribute at this
     * texel — the long-wave straining term (foamMath.crestBiasPerMetre). 0
     * restores the pre-cross-band gate exactly.
     */
    uCrestBias: uniform(0),
    /**
     * Amplitude of the per-texel breakup jitter, ALREADY in λ− units
     * (breakupSigma × this band's σ(λ−), precomputed per tick). 0 restores the
     * un-broken gate exactly. See foamMath, "A CAP IS THE SIZE OF THE BAND
     * THAT MADE IT".
     */
    uBreakupAmp: uniform(0),
    /** 1 / breakupMetres — the breakup field's base frequency in world units */
    uBreakupFreq: uniform(1),
    /** domain-warp amplitude, in units of one breakup cell (§B.39 anti-lattice) */
    uBreakupWarp: uniform(0),
    /**
     * How far the breakup field is stretched ALONG the local crest line. 1 is
     * isotropic, which measured aspect 1.73 / align +0.52 against λ−'s own
     * 2.48 / +0.96 — see foamMath, "THE BREAKUP TRADED SHAPE FOR SIZE".
     */
    uBreakupElong: uniform(1),
    /** slow drift of the breakup field, so the same texels do not always foam */
    uBreakupTime: uniform(0),
    /**
     * The MEAN foam this band settles at — what an infinitely-distant pixel of
     * it should see (§V.70, foamMath.expectedBandFoam). Read by the SHADING
     * node, not by any compute pass: it lives here because it is per-lane and
     * this is the per-lane uniform block.
     */
    uMeanResidue: uniform(0),
    uMeanBreaking: uniform(0),
    /**
     * Ceiling on BOTH accumulators. No longer 1: at cascade 0's shipped
     * numbers the residue settles at 1.86 for a TYPICAL firing texel, so a
     * clamp at 1 threw away the intensity ranking that `75bc563` introduced
     * the second clock to provide (foamMath, "THE SECOND HALF OF THE TWO-CLOCK
     * FIX"). The composite soft-saturates instead, so values above 1 are
     * meaningful rather than illegal.
     */
    uAccumMax: uniform(1),
    /** blur tap offset in texels */
    uRadius: uniform(1),
    /**
     * per-tick weight of the gaussian against the identity, per band
     * (foamMath.blurMixPerStep). 1 = the old full-strength kernel. This is
     * what makes the diffusion a WORLD length rather than a texel count —
     * without it cascade 0 spent 4.6σ of isotropic blur on a 2.65 m cap and
     * every whitecap in the frame came out a disc (foamMath, "THE BLUR WAS
     * THE SHAPE").
     */
    uBlurMix: uniform(1),
    /**
     * effective Tessendorf choppiness λ the GPU is running (the anti-fold cap,
     * not the slider). The derivatives texture stores ∂Dx/∂x and ∂Dz/∂z
     * UNSCALED, so the jacobian trace has to re-apply λ here — reading the
     * slider instead would silently mis-scale the metric the moment the
     * fold cap engages, which is exactly when foam matters most.
     */
    uChoppiness: uniform(1),
  };
}

export type FoamUniforms = ReturnType<typeof createFoamUniforms>;

/**
 * Structure-tensor ring: taps and radius IN TEXELS, both build-time.
 *
 * A RING and not a 3×3 block, on purpose — the tensor exists to read the crest
 * direction, ∇h vanishes ON the crest line, and a ring samples the flanks
 * where the gradient actually carries the direction. 8 taps is the cheapest
 * count that still resolves an axis to better than the ±22.5° a 4-tap cross
 * gives; radius 2 keeps the estimate local to one crest rather than averaging
 * across the trough behind it (cascade 0: 3.9 m against 40 m-and-longer waves).
 *
 * The RADIUS is not here — it is per band, from that band's own shortest
 * wavelength (foamMath.tensorRadiusTexels), because it has a sharp optimum and
 * a fixed texel count lands on the wrong side of it in every band but one.
 *
 * §V.17: this is +8 `textureLoad` per texel in a COMPUTE pass, on top of the 4
 * it already did. Compute budget is ≤4 ms against a render budget of 8 that is
 * the one under pressure, and these are unfiltered integer loads of a texture
 * already resident and already read this pass. Costed rather than assumed —
 * but NOT measured on hardware, and nobody has profiled the frame since post
 * landed, so this is the first thing to look at if the compute total moves.
 */
const TENSOR_TAPS = 8;

/** wrap a texel index into [0, n) — cascade textures tile with their domain */
function wrapTexel(v: ReturnType<typeof int>, n: number) {
  return v.add(int(n)).mod(int(n));
}

/** one cascade's ocean outputs, as the inject pass needs them */
export interface InjectCascade {
  /** unpack output (λDx, h, λDz, det J) */
  displacement: THREE.StorageTexture;
  /** unpack output (∂h/∂x, ∂h/∂z, ∂Dx/∂x, ∂Dz/∂z) — a layer of the array */
  derivatives: CascadeLayer;
  /** world metres this cascade tiles over */
  domain: number;
}

/**
 * Inject pass, TWO CHANNELS ON TWO CLOCKS:
 *   R (residue)  = min(1, src.r + deficit·injectPerFrame)
 *   G (breaking) = min(1, src.g + deficit·injectPerFrame)
 * both fed by the SAME deficit — they differ only in how fast blurDecay drains
 * them, which is what turns G into a RATE and R into a history. See foamMath,
 * "THE MASK WAS DWELL TIME, NOT BREAKING INTENSITY" for the measurement that
 * forced the split. The texture was always RGBA and G/B were always written as
 * zero, so this costs nothing anywhere (§V.40 untouched).
 *
 * deficit = max(0, gate − (λ− − crestBias·h_other)).
 *
 * λ− = ½(tr − √(tr² − 4·det)) is the minimum eigenvalue of J = I + λ∇D, and
 * it is the metric because det J is direction-free: area compression fires in
 * round blobs of one size, λ− fires along the axis the water is actually
 * folding on, so the injected footprint is a RIDGE that already follows the
 * local crest (foamMath, "THE FOLD METRIC"). ∇D is symmetric (D is a gradient
 * field), so both eigenvalues are real and trace+determinant is all we need —
 * which is exactly what the ocean already publishes, in two textures it
 * already writes. The off-diagonal term is never reconstructed; it only ever
 * appears squared, and it is already inside `det`.
 *
 * `h_other` is the elevation the OTHER cascades contribute at this texel's
 * world position — the long-wave straining term, without which this band's
 * caps are blind to the swell they ride on (foamMath.crestBiasPerMetre). It is
 * `textureLoad` on the other bands' displacement textures: this is a COMPUTE
 * pass, so it costs no sampler and cannot touch the ocean fragment stage's
 * budget (§V.40). `spray.ts` reads all three cascades in one compute kernel
 * for the same reason and has done since it shipped.
 *
 * Reads previous-frame foam from `src` and writes `dst` (ping-pong halves —
 * never read+write the same storage texture in one pass).
 */
export function createInjectPass(
  cascades: readonly InjectCascade[],
  index: number,
  src: THREE.StorageTexture,
  dst: THREE.StorageTexture,
  n: number,
  u: FoamUniforms,
  /**
   * Octaves of the breakup field this band's texels can hold
   * (foamMath.breakupOctaves). A BUILD-TIME count, like `CAP_VAR_OCTAVES` and
   * every other octave count in this project: it unrolls the loop, and moving
   * `breakupMetres` live rescales the field without rebuilding the graph.
   * 0 disables the breakup entirely.
   */
  octaves = 0,
  /** structure-tensor ring radius in texels (foamMath.tensorRadiusTexels) */
  tensorRadius = 1,
) {
  const own = cascades[index];
  if (!own) throw new Error(`foam: inject pass for missing cascade ${index}`);
  // world metres per texel of THIS cascade — a build-time constant, so the
  // cross-band lookup below is a multiply and not a divide per texel
  const texelMetres = own.domain / n;
  return Fn(() => {
    const x = int(instanceIndex.mod(n)).toVar();
    const y = int(instanceIndex.div(n)).toVar();
    const coord = ivec2(x, y);

    // (λDx, h, λDz, det J) and (∂h/∂x, ∂h/∂z, ∂Dx/∂x, ∂Dz/∂z) — see unpackPass
    const det = textureLoad(own.displacement, coord).w;
    // derivatives is a LAYER of the ocean's shared array texture (§V.40)
    const d = loadCascadeLayer(own.derivatives, coord);
    // tr J = 2 + λ(∂Dx/∂x + ∂Dz/∂z)
    const trace = float(2).add(u.uChoppiness.mul(d.z.add(d.w))).toVar();
    // foamMath.minEigenvalue. The discriminant is ≥ 0 for a real symmetric
    // matrix; the floor is float error, and without it one ulp of negative
    // returns NaN into an accumulator that has no way back (§V28).
    const disc = trace.mul(trace).sub(det.mul(4)).max(0);
    const minEigen = trace.sub(disc.sqrt()).mul(0.5).toVar();

    // ── the long-wave straining term ───────────────────────────────────────
    // This texel's world position, at the texel CENTRE (+0.5) so the sample
    // lands where the texel actually is rather than half a texel upwind.
    const worldX = float(x).add(0.5).mul(texelMetres);
    const worldZ = float(y).add(0.5).mul(texelMetres);
    const hOther = float(0).toVar();
    for (let c = 0; c < cascades.length; c++) {
      if (c === index) continue;
      const other = cascades[c];
      // fract before scaling: these textures tile with their own domain, and
      // an out-of-range textureLoad returns ZERO in WGSL rather than wrapping
      // — which would silently drop the term instead of erroring (§V28)
      // COMPUTE pass over integer texel indices: no fragment, no screen
      // footprint, nothing to alias against — these are texture WRAPS.
      // @band-limited-elsewhere: compute pass, no fragment (see above)
      const ux = worldX.div(other.domain).fract();
      // @band-limited-elsewhere: compute pass, no fragment (see above)
      const uz = worldZ.div(other.domain).fract();
      const otherTexel = ivec2(
        int(ux.mul(n)).clamp(0, n - 1),
        int(uz.mul(n)).clamp(0, n - 1),
      );
      hOther.addAssign(textureLoad(other.displacement, otherTexel).y);
    }
    // a POSITIVE elevation lowers λ−, i.e. pushes this texel toward breaking:
    // riding high on a long wave is what steepens a short one
    const metric = minEigen.sub(u.uCrestBias.mul(hOther)).toVar();

    // ── THE BREAKUP: metre-scale islands inside a band-scale region ────────
    // A super-level set of a band-limited field has that band's own scale, so
    // cascade 0 (40–1010 m waves) injects patches 20–70 m across and no amount
    // of downstream work makes them smaller — measured, foamMath. This raises
    // the gate per texel by a zero-mean field at METRE scale, so a hard-
    // breaking core still fires whole while the marginal skirt is carved into
    // islands. §B.39's dissolve, one stage upstream: break the region ALLOWED
    // to fire rather than the silhouette of a mask that already exists.
    if (octaves > 0) {
      // ── THE CREST FRAME, from the structure tensor of ∇h ─────────────────
      // Isotropic noise erodes a crest-following ribbon into discs: measured,
      // it took aspect 2.48 → 1.73 and crest alignment +0.96 → +0.52 while
      // hitting its size target (foamMath, "THE BREAKUP TRADED SHAPE FOR
      // SIZE"). Stretching the field ALONG the crest cuts the ribbon into
      // shorter ribbons instead.
      //
      // WHY THE TENSOR AND NOT SOMETHING SIMPLER — do not "simplify" this back:
      //  · λ−'s own eigenvector is the natural frame and is UNREACHABLE. It
      //    needs the SIGN of ∂Dx/∂z, which §V.58 records is never
      //    reconstructed because it only ever appears squared inside det J,
      //    and both ocean textures are full so there is nowhere to publish it.
      //  · raw ∇h is worst exactly here: it VANISHES AND FLIPS SIGN ON THE
      //    CREST LINE (foamMath's own note), which is the only place this is
      //    asked.
      // The tensor is QUADRATIC in ∇h, so it yields a DIRECTOR — an axis with
      // no head or tail — and the sign §V.58 calls unreconstructable is simply
      // not needed rather than worked around. Accumulated over a RING and not
      // at the texel, it samples the flanks where ∇h is large instead of the
      // crest line where it is zero.
      const jxx = float(0).toVar();
      const jzz = float(0).toVar();
      const jxz = float(0).toVar();
      for (let t = 0; t < TENSOR_TAPS; t++) {
        const ang = (t / TENSOR_TAPS) * Math.PI * 2;
        const ox = Math.round(Math.cos(ang) * tensorRadius);
        const oz = Math.round(Math.sin(ang) * tensorRadius);
        const tx = wrapTexel(x.add(int(ox)), n);
        const tz = wrapTexel(y.add(int(oz)), n);
        const g = loadCascadeLayer(own.derivatives, ivec2(tx, tz));
        jxx.addAssign(g.x.mul(g.x));
        jzz.addAssign(g.y.mul(g.y));
        jxz.addAssign(g.x.mul(g.y));
      }
      // foamMath.crestFrame: doubled angle of the propagation axis, turned a
      // quarter onto the crest line (a negation in doubled-angle form), then
      // half-angled back without an atan2 round trip.
      const dxT = jxx.sub(jzz);
      const dyT = jxz.mul(2);
      const rT = dxT.mul(dxT).add(dyT.mul(dyT)).sqrt().max(1e-20);
      const c2 = dxT.div(rT).negate();
      const s2 = dyT.div(rT).negate();
      const ct = c2.add(1).mul(0.5).max(0).sqrt();
      // sign(0) must read +1 or a crest exactly on the z axis collapses the
      // frame to zero length — `select`, not `sign` (§V28)
      const st = float(1).sub(c2).mul(0.5).max(0).sqrt()
        .mul(select(s2.lessThan(0), float(-1), float(1)));
      // stretch the SAMPLE COORDINATE along the crest ⟹ the FEATURES stretch
      // along it, so the field cuts across the cap at intervals
      const along = worldX.mul(ct).add(worldZ.mul(st)).div(u.uBreakupElong.max(1));
      const across = worldX.mul(st).negate().add(worldZ.mul(ct));
      const bp = vec2(along, across).mul(u.uBreakupFreq).toVar();
      const drift = u.uBreakupTime;
      // DOMAIN WARP, and it is the anti-lattice half. Value noise has round
      // level sets (§B.39), so on its own this would bite round holes and
      // leave round islands; bending the coordinate by a field with no period
      // of its own is what makes the tears irregular. Same cure the ocean's
      // wavelet lattice took, at a different scale.
      const wu = fbm2(bp.mul(0.35).add(vec2(11.3, -4.1)), 2).sub(0.5);
      const wv = fbm2(bp.mul(0.35).add(vec2(-7.7, 19.4)), 2).sub(0.5);
      const warped = bp
        .add(vec2(wu, wv).mul(u.uBreakupWarp))
        .add(vec2(drift, drift.mul(-0.6)));
      // fbm2 is [0,1]; centre it so the jitter is zero-mean and the band's
      // total injection is preserved to first order (§V.64 — nothing deleted)
      metric.addAssign(u.uBreakupAmp.mul(fbm2(warped, octaves).sub(0.5).mul(2)));
    }

    const previous = textureLoad(src, coord);
    // deficit below the gate → foam, never negative: calm water must not
    // scrub foam that is already there
    const injected = u.uBias.sub(metric).max(0).mul(u.uInjectPerFrame);
    // foamMath.accumulateFoam: clamp ≤ 1 (mask feeds a mix factor)
    const residue = previous.r.add(injected).min(u.uAccumMax);
    const breaking = previous.g.add(injected).min(u.uAccumMax);
    textureStore(dst, coord, vec4(residue, breaking, 0, 1)).toWriteOnly();
  })().compute(n * n);
}

/**
 * Box-reduction pass: dst[i] = mean of the factor×factor source block.
 *
 * WHY (ocean agent, horizon sizzle): StorageTextures carry NO mip chain, so a
 * grazing-angle pixel covering thousands of foam texels receives exactly ONE
 * of them, re-picked every frame — textbook minification aliasing, and the
 * real cause of the shimmering white band. A distance fade or a compositing
 * cap only hides it. This builds the missing filtered tier explicitly.
 *
 * `factor` is a build-time literal so the taps unroll (§V28 forbids dynamic
 * loop bounds), and the weights are a plain mean: this must not sharpen or
 * dim foam, only band-limit it.
 */
export function createReducePass(
  src: THREE.StorageTexture,
  dst: THREE.StorageTexture,
  dstN: number,
  factor: number,
) {
  if (!Number.isInteger(factor) || factor < 2) {
    throw new Error(`foam: reduce factor must be an integer ≥ 2, got ${factor}`);
  }
  const inv = 1 / (factor * factor);
  return Fn(() => {
    const x = int(instanceIndex.mod(dstN)).toVar();
    const y = int(instanceIndex.div(dstN)).toVar();
    const sx = x.mul(int(factor)).toVar();
    const sy = y.mul(int(factor)).toVar();
    // BOTH channels: the tier is a filtered view of the whole mask, and a tier
    // that carried only the residue would make distant water lose exactly the
    // breaking foam this split exists to show
    const sum = vec2(0, 0).toVar();
    for (let dy = 0; dy < factor; dy++) {
      for (let dx = 0; dx < factor; dx++) {
        sum.addAssign(textureLoad(src, ivec2(sx.add(int(dx)), sy.add(int(dy)))).rg);
      }
    }
    const mean = sum.mul(inv);
    textureStore(dst, ivec2(x, y), vec4(mean.x, mean.y, 0, 1)).toWriteOnly();
  })().compute(dstN * dstN);
}

/**
 * Decay+blur pass: dst = min(1, mix(src, blur3x3(src), uBlurMix) · decay).
 *
 * ISOTROPIC — see foamMath, "REMOVED, ON PURPOSE". Gaussian weights sum to 1
 * (foamMath.GAUSSIAN_3X3) so only uDecay removes foam, and an axis-aligned
 * kernel is shift-invariant, so the conservation the old crest frame was
 * built to protect is kept, not traded. Mixing against the IDENTITY keeps both
 * properties exactly ((1−w)·δ + w·G is still normalised and still axis-aligned)
 * while making the diffusion RATE a world quantity — see foamMath,
 * "THE BLUR WAS THE SHAPE, AND IT WAS A GRID QUANTITY".
 * CPU mirror: foamMath.blurDecayAt.
 */
export function createBlurDecayPass(
  src: THREE.StorageTexture,
  dst: THREE.StorageTexture,
  n: number,
  u: FoamUniforms,
) {
  const wrap = (v: any) => v.add(int(n)).mod(int(n));
  return Fn(() => {
    const x = int(instanceIndex.mod(n)).toVar();
    const y = int(instanceIndex.div(n)).toVar();

    // ONE kernel, BOTH channels: spreading is one physical process at one
    // world rate, so the breaking channel must not get its own diffusion —
    // only its own DECAY. It comes out crisper than the residue simply
    // because it is younger, which is the correct reason.
    const sum = vec2(0, 0).toVar();
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        // tap offset in texels, scaled by radius; +n before mod keeps the
        // wrap positive
        const ox = u.uRadius.mul(dx).round();
        const oy = u.uRadius.mul(dy).round();
        const sx = wrap(x.add(int(ox)));
        const sy = wrap(y.add(int(oy)));
        const w = GAUSSIAN_3X3[(dy + 1) * 3 + (dx + 1)];
        sum.addAssign(textureLoad(src, ivec2(sx, sy)).rg.mul(w).mul(u.uBlurMix));
      }
    }
    // identity half of the mixed kernel — the tap the gaussian is blended
    // against, so total weight is exactly (1−w) + w·Σg = 1 (mass conserved)
    sum.addAssign(textureLoad(src, ivec2(x, y)).rg.mul(float(1).sub(u.uBlurMix)));
    const residue = sum.x.mul(u.uDecay).min(u.uAccumMax);
    const breaking = sum.y.mul(u.uDecayBreaking).min(u.uAccumMax);
    textureStore(dst, ivec2(x, y), vec4(residue, breaking, 0, 1)).toWriteOnly();
  })().compute(n * n);
}
