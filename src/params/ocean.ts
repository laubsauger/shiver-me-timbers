/**
 * Ocean simulation tunables (§V.16, §V.19).
 * 3 FFT cascades; band-split by wavelength so energy is never duplicated.
 */
import { registerParams } from './registry';

export interface CascadeParams {
  /** world-space domain size in meters this cascade tiles over */
  domain: number;
}

export interface OceanParams {
  /** texture resolution per cascade (N×N), power of two (§V.19 ≥512) */
  resolution: number;
  cascades: [CascadeParams, CascadeParams, CascadeParams];
  /**
   * wavelength (m) boundaries between cascades: cascade0 keeps λ > split[0],
   * cascade1 keeps split[0] ≥ λ > split[1], cascade2 keeps λ ≤ split[1].
   * Prevents double-counted spectrum energy across cascades.
   */
  splitWavelengths: [number, number];
  /** Phillips spectrum scale — overall wave energy */
  amplitude: number;
  windSpeed: number; // m/s
  windDirection: number; // radians
  /**
   * Longuet-Higgins spreading exponent s AT THE SPECTRAL PEAK. The wind sea's
   * directional factor is cos^{2s}(Δθ/2) with s a function of ω/ω_p
   * (Hasselmann/Mitsuyasu, as used by Horvath 2015) — see `windSeaSpread`.
   * Higher = a tighter fan at the peak. 9.8 measures 22.9° of axial spread
   * there, which is a fully developed wind sea.
   *
   * This REPLACES `directionality`, which was a single cos^n applied at every
   * wavenumber and measured a flat 16.5°/16.5°/16.4° across the three
   * cascades — the same narrow comb on the 2 m ripples as on the 100 m
   * rollers, which is what "very obvious sine-wavy feeling" (user) is.
   */
  spreadPeak: number;
  /**
   * Exponent μ on (ω/ω_p) BELOW the peak — swell-ward of the wind sea, where
   * the fan re-broadens because those components were raised by a different,
   * older wind. Mitsuyasu's fit is 5.
   */
  spreadBelowPeak: number;
  /**
   * Exponent μ on (ω/ω_p)^−1 ABOVE the peak — the short waves. This is the
   * number that fixes the chop: at 2.5 the spread reaches ~39° (very nearly
   * isotropic) by λ ≈ 8 m, against the 16.4° the flat cos¹⁰ gave. Lower it
   * toward 0 and the whole sea combs into one direction again.
   */
  spreadAbovePeak: number;
  /**
   * Floor on s. Below ~1 the spread has already saturated at the isotropic
   * limit (39.1° at s=0.5 vs 40.5° at s=1), so this costs no realism; it
   * exists to keep the closed-form normalisation away from Γ's small-argument
   * behaviour and to give a knob if fully isotropic chop reads as mush.
   */
  spreadMin: number;
  /**
   * Fraction of the energy that runs ISOTROPICALLY rather than with the wind —
   * a real sea always has some. It used to be a hard multiplier on the
   * upwind half-plane, i.e. a step at 90°; cos^{2s}(Δθ/2) already reaches zero
   * at 180° on its own, so this is now a smooth pedestal with the same
   * meaning and no corner.
   */
  oppositeWaveDamp: number;
  /** small-wave suppression length (m) — kills sub-texel chop */
  smallWaveCutoff: number;

  // ── SWELL: the second, independent wave train (§V.19, user) ───────────
  // Everything above describes WIND SEA — the waves the local wind is raising
  // right now. Swell is a different animal entirely: long, low, narrowly
  // directional, radiated by a storm hundreds of miles away days ago. One
  // Phillips fit cannot be both, which is why there was no setting that gave
  // "not calm, but also not this 2-second interval of waves" (user).
  /**
   * Peak PERIOD in seconds — the interval between crests, which is how a sea
   * state is actually described and what the user asked in. Wavelength is
   * derived (λ = gT²/2π), never authored separately: two knobs for one
   * physical quantity can disagree. 8–15 s is real swell; 11 s ⟹ λ ≈ 189 m.
   */
  swellPeriod: number;
  /**
   * RMS swell elevation in METRES — the swell's own significant height is
   * 4× this. It is a real number you can read because the spectrum is
   * normalised for it (`swellScale`): change the period, the bandwidth or the
   * directional spread and the swell stays the same HEIGHT, which is the
   * whole point. 0 disables the train exactly and the sea is pure wind sea.
   */
  swellAmplitude: number;
  /**
   * Direction of travel in radians, DECOUPLED from `windDirection` on purpose.
   * A swell running across the wind is the single biggest cue that this water
   * came from somewhere — it is what makes a sea read as an ocean rather than
   * a pond. Tying it to the wind would throw that away for one saved param.
   */
  swellDirection: number;
  /**
   * cos^n directional spread. Swell is far more unidirectional than wind sea
   * after travelling: a distant storm's fan has long since sorted itself out by
   * dispersion and angular spreading.
   *
   * CEILED BY THE GRID (`swellEffectiveDirectionality`) exactly as
   * `swellBandwidth` is by `swellGridModes`, and for the same reason on the
   * other axis: a spread narrower than the grid's angular resolution at k_p
   * lands the whole train on one ray of modes, i.e. a plane wave. The authored
   * 24 is above that ceiling on every shipped preset (calm 3.7, swell 7.1,
   * storm 16.0), so this reads as "as narrow as the grid can carry".
   */
  swellDirectionality: number;
  /**
   * Relative bandwidth σ_k/k_peak. Real swell is very narrow (0.05–0.15).
   * FLOORED against the grid by `swellGridModes` — see swellSpectrum.
   */
  swellBandwidth: number;
  /**
   * Minimum bandwidth in GRID STEPS (2π/domain). Below ~2 the swell collapses
   * onto one or two modes and tiles the world as a single clean sinusoid,
   * which §V.19 forbids by name. This is the spectral face of §V.48: do not
   * ask the grid for a feature finer than it can represent.
   */
  swellGridModes: number;
  /** horizontal displacement scale (Tessendorf choppiness λ) */
  choppiness: number;
  /**
   * Anti-fold cap: λ is limited so λ·RMS(∂Dx/∂x + ∂Dz/∂z) ≤ this, summed over
   * cascades. Read it as 1/n: det J ≈ 1 + λ·tr to first order, so the surface
   * folds where the trace reaches n sigma — 0.5102 = folds past 1.96σ.
   *
   * §V.59: the divisor is the DIRECTION-FREE trace moment (`jacobianRms`),
   * not `steepnessRms`. It used to be the latter, which is the x-projection
   * kx²/|k|, and that reads 1.79× low on a wind sea and 2.6× low on a
   * swell-dominated band. Two consequences, both worth stating:
   *   - the VALUE moved 0.2857 → 0.5102 = 0.2857 × 1.786, so every sea this
   *     was calibrated on gets a bit-identical λ. Nothing about storm's
   *     "crests crossing over" fix is re-litigated;
   *   - the DOCUMENTED MEANING was wrong all along. "Folds only past 3.5σ,
   *     ≈0.02% of the surface" was measured against a σ that was 1.79× too
   *     small; the true figure was always 1.96σ, ≈2.5%. The sea has been
   *     folding more than the comment claimed since the cap was written —
   *     which is consistent with foam being visible at all.
   * At 1.0 folds start at 1σ, a third of the sea, which is what shattered storm.
   */
  choppinessFoldLimit: number;
  /**
   * Foam gate (§V.6, §V.7). Threshold on the SUMMED three-cascade jacobian
   * `d0.w+d1.w+d2.w−2`, which is ≈1 at rest — read it as a σ-multiple below
   * that rest value: at the shipped swell spectrum σ(ΣJ)=0.183, so 0.55 means
   * "the sea is folding 2.5σ worth here", ≈0.5% of the surface.
   *
   * It is NOT an absolute number for one cascade's own det J (§V36, §B): a
   * single band's σ is 2–3× narrower, so the same value there is a 5–8σ event
   * and injects nothing. src/foam re-expresses this per band against that
   * band's live σ (foamMath.cascadeFoamBias) — anything else reading a
   * per-cascade `displacement.w` must do the same.
   */
  jacobianFoamBias: number;

  // -- shoaling (§V.72): the sea calms over its own shallows ----------------
  /**
   * THE ONE ARTISTIC COMPRESSION IN THE SHOALING MODEL, as a fraction of the
   * seabed's OWN open-ocean depth: every band must be back to full open-ocean
   * amplitude by this fraction of it.
   *
   * Needed because our world is not planet-scale. A wave is in deep water
   * below d = λ/2; the shipped storm swell is λ 143 m, so it would want 71 m
   * while the sea floor is 45 m — the uncompressed criterion damps the OPEN
   * OCEAN by 37% at storm. This pins the transition inside the depth range
   * the world actually has, by flooring the wavenumber at π/(fraction·depth)
   * (`shoaling.shoalWavenumberFloor`).
   *
   * MEASURED at 0.6: 1 − tanh(k·45 m) = 5.7e-5 for every band at every preset,
   * i.e. the shipped open ocean cannot move. Raising it toward 1 starts the
   * calming further out and eventually eats into the open sea; lowering it
   * squeezes the whole shoaling band into the last few metres of shelf, which
   * is what makes a beach look like a bathtub edge.
   */
  shoalDeepFraction: number;
  /**
   * The McCowan breaker index: the fraction of the local water column a wave
   * may occupy before depth-limited breaking starts to bite. 0.78 is the
   * textbook value (H ≈ 0.78·d at breaking), NOT a tuned one, and below it the
   * clip is EXACTLY the identity — so this term is a true no-op on any sea
   * that is not about to run out of water.
   *
   * Measured over 60 s of the mirror at depths 1–200 m: it never fires at calm
   * or at swell (0.00% of samples), and fires on 21.6% of the surface at 1 m /
   * 7.0% at 10 m / 0.8% at 20 m / 0% at 45 m at storm. That disjointness is
   * the design, not a coincidence to be tuned away.
   */
  shoalBreakerIndex: number;
  /**
   * Hard saturation: the fraction of the local water column a wave may NEVER
   * exceed. This is the playability guarantee — (1 − this)·d metres of water
   * always remain, so the ocean mesh can never drop below the sand and flicker
   * a lagoon dry. At 0.85 a 4.5 m basin keeps 0.67 m at the deepest storm
   * trough, against −24.3 m of raw storm swell.
   *
   * MUST stay above `shoalBreakerIndex` (the gap between them is the soft
   * knee's width); at or below it the clip becomes a hard corner along a depth
   * contour, which reads as a painted ring on the water.
   */
  shoalColumnCeiling: number;

  // -- fetch (§V.73): water with land upwind cannot grow the sea the wind asks
  /**
   * THE ONE COMPRESSION IN THE FETCH MODEL, and the exact counterpart of
   * `shoalDeepFraction`: world metres → physical fetch metres.
   *
   * Needed because our world is not planet-scale. Full development at the
   * shipped 11 m/s takes F̃ = 2.2e4, i.e. 271 km of open water; our archipelago
   * is 9 km across, so the UNCOMPRESSED model would fetch-limit the entire
   * world and collapse the open ocean — the same failure the shoaling floor
   * exists to prevent, one file over.
   *
   * At 260 the sea is fully developed after 138 m of clear upwind water at
   * calm (4 m/s), 1043 m at the shipped swell (11 m/s) and 2794 m at storm
   * (18 m/s). So open water between islands is untouched and the model acts
   * inside rims and in the few hundred metres directly downwind of land.
   * RAISING it weakens the shelter (full development arrives sooner);
   * LOWERING it strengthens the shelter and lengthens the lee shadow, which
   * must stay inside `fetchFieldMargin` or the shadow is truncated at the
   * field border. See src/ocean/fetch.ts.
   */
  fetchWorldScale: number;
  /**
   * Ceiling on the young-sea steepening term, `r^(−0.11)` = √(the JONSWAP α
   * ratio). A short-fetch sea has a FATTER equilibrium tail than a fully
   * developed one at the same wind — that is real, and it is why enclosed
   * water looks choppy and mean while being half a metre high — but it is the
   * only term in the model that ADDS energy and it diverges as fetch → 0.
   *
   * This is a §V.44 boundedness guard, not a look knob: the gain scales the
   * Jacobian the §V.6 foam gate reads, so an unbounded version would eventually
   * whitecap a puddle. At 1.25 it binds only below r ≈ 0.03, i.e. a few metres
   * of upwind water. Must be ≥ 1 or it would damp the OPEN ocean.
   */
  fetchMaxGain: number;
  /**
   * THE SECOND COMPRESSION (§V.73): the largest λ_band/λ_peak a band may be
   * treated as. It bounds how SHARP the low-frequency cutoff can get.
   *
   * The cutoff's exponent carries (λ_band/λ_peak)², so a band far longer than
   * the fully developed peak turns a smooth exponential into a step. MEASURED
   * on calm (4 m/s, peak λ 16 m) where cascade 0's mean λ is 249 m: the raw
   * coefficient is 256 and the gain falls 1.000 → 0.000 across FOURTEEN METRES
   * of fetch — a painted ring on the water.
   *
   * That band's energy at calm is not wind sea; it is the authored swell train,
   * which §V.36 deliberately decouples from `windSpeed`. This is where that
   * interaction is paid for. At 2 it touches neither swell (0.74) nor storm
   * (0.45) and spreads calm's step over ~100 m of fetch. Raising it sharpens
   * the shelter edge; 1 flattens the model's whole band selectivity, which is
   * the one thing that must not happen — see src/ocean/fetch.ts.
   */
  fetchLongBandLimit: number;
  /**
   * Texels per axis of the baked shelter field (src/ocean/fetchField.ts). The
   * field spans the seabed's bounds plus `fetchFieldMargin` on every side, so
   * this sets the texel size: at the shipped archipelago (9.0 km) and margin
   * that is ~30 m, i.e. a 120 m anchorage is ~4 texels across. Doubling it
   * quadruples the sweep, which is the per-wind-turn CPU cost.
   */
  fetchFieldSize: number;
  /**
   * World metres the shelter field extends BEYOND the seabed's own bounds.
   *
   * It must exceed `fullyDevelopedFetch` at the highest wind in play, or a lee
   * shadow is still recovering when it reaches the field border and
   * clamp-to-edge draws a ring on the water. At the shipped 3200 against
   * storm's 2794 m there is 400 m of headroom; the 30 m/s slider limit wants
   * 7763 m and is knowingly not covered (see the report's residuals).
   */
  fetchFieldMargin: number;
  /**
   * Separable box-blur radius, in texels, applied to the swept field.
   *
   * Two jobs, one number. It is the §V.48 BAND LIMIT — this texture carries no
   * mip chain (it is re-swept when the wind turns, so a chain would have to be
   * regenerated with it) and the ocean's vertex spacing reaches ~90 m against a
   * ~30 m texel. And it is the honest SHAPE of a wind shadow's edge, which is a
   * turbulent mixing layer rather than the hard line a binary land mask gives.
   * 0 disables it and draws that hard line; do not.
   */
  fetchBlurTexels: number;
  /**
   * How far the wind must turn (radians) before the shelter field is re-swept.
   *
   * The sweep is the only per-direction cost in the model — wind SPEED enters
   * as a scalar uniform and never rebuilds anything — and `windDirection` is
   * not a key the weather presets patch, so in practice this fires on a panel
   * drag and almost never in play. At 0.03 rad (1.7°) a shadow 3 km downwind
   * moves ~50 m between sweeps, under two texels, which the blur hides.
   */
  fetchRebuildRadians: number;
}

export const oceanParams: OceanParams = registerParams('ocean', {
  resolution: 512,
  // non-commensurate domains (§V19): 420/98 ≈ 4.29, 98/22.7 ≈ 4.32 — no pair
  // re-aligns on a short world period, so foam/wave repeats don't grid up.
  // Scaled 1.66× off the old 253/59/13.7 to carry OPEN-OCEAN swell: at the
  // wind below the energy-weighted mean wavelength is ≈69 m, and 3.7 waves
  // per tile (the old 253 m domain) reads as repetition (user: "wave
  // frequency for open ocean is a little high", "pattern is repetitive").
  // 1010 m on cascade 0, raised from 420 m TO CARRY THE SWELL. An 11 s swell
  // is λ ≈ 189 m: in a 420 m tile that is 2.2 waves per repeat, and this
  // project already rejected 3.7 waves per tile as visibly repetitive (§V.19,
  // the note below). 1010 m gives 5.3, and it costs NOTHING — same texture
  // size, same FFT, same bindings; only the metres-per-texel changes (0.82 →
  // 1.97 m), and cascade 0's shortest wavelength is 40 m = 20 texels, so it
  // has plenty of margin. Non-commensurate is still checked: 1010/98 = 10.31,
  // 98/22.7 = 4.32. The CPU buoyancy mirror's guard also still holds — its
  // 64² central block reaches k = π·64/1010 = 0.199 against a band kMax of
  // 2π/40 = 0.157 (§V.8, cpuOcean's ctor throws if that ever inverts).
  cascades: [{ domain: 1010 }, { domain: 98 }, { domain: 22.7 }],
  // band edges scale with the domains so no cascade is asked for wavelengths
  // its grid can't hold (also keeps the CPU buoyancy mirror's kMax inside its
  // reduced grid — see sea-physics/cpuOcean ctor guard)
  //
  // 8.3 → 5 WAS EVALUATED IN FULL AND NOT LANDED. Blocked by ONE number and it
  // is not the one anybody expected — see the end. Written down because every
  // physics cost came out at zero, so the next reader will otherwise re-run a
  // day of measurement to rediscover the same wall. Harnesses left on disk:
  // `CASCADE_WIDEN=1` (+`CW_HOLDZ=1`), `SPLIT_PITCH=1`, `FOAM_SYNC=1`,
  // `FOAM_RESEARCH=1 FOAM_N=256`.
  //
  // THE VARIABLE IS W = domain/λ_long — how many of the band's own longest
  // wave fit in its tile, hence how many modes its energetic end carries
  // (2πW on the edge ring). At W ≈ 2.5 a tile holds ~15 modes there and its
  // breaking rate BEATS coherently: docs/research-cascade-tiling.md, and the
  // user's "too synchronous across the whole screen; it comes into view and
  // goes out and comes back". That doc could only raise W by widening the
  // DOMAIN and rejected it. docs/research-abyssal-ocean.md §3.1 found the
  // other lever — lower λ_long, which moves NOTHING about the grid (same
  // domains, texels, Nyquist, shader literals, bindings) and takes cascade 2's
  // W 2.735 → 4.540.
  //
  // IT WORKS, AND NOT FOR THE REASON THE IMPORTED SCALING LAW SAYS. That law
  // (coverage CV ∝ W^−0.47, peak/trough ∝ W^−1.24, injection CV ∝ W^−0.97) was
  // fitted on the DOMAIN axis. Transposed to the split axis it holds for
  // exactly one metric: peak/trough predicted ×0.533, measured ×0.533 (34.3 →
  // 18.3, 100 s composite at held §V.36 z). It fails for both CV metrics —
  // coverage CV predicted −21%, measured −4.9%; lane-2 injection CV predicted
  // −39%, measured −8.6%. And lane 1's injection CV falls 19% while cascade
  // 1's own W never moves at all, which the law cannot express. The real
  // variable is the lattice ring index of the ENERGETIC modes, not of the band
  // edge: the 5–8.3 m octave lived on rings 2.7–4.5 of cascade 2's 22.7 m tile
  // and lands on rings 11.8–19.6 of cascade 1's 98 m tile — 4.32× finer, the
  // domain ratio. W only ever described the edge.
  //
  // EVERY PHYSICS COST MEASURED AT ~ZERO:
  //  · Hs 2.7832 → 2.7819 m (−0.05%). The +7–10% quadrature gain a DOMAIN
  //    change pays does not arise, because no Δk moves.
  //  · §V.69 re-measured ON CURVATURE (18 stations bow-to-stern, then twice in
  //    time), 3 seeds × 4 headings through the real integrator: peak pitch
  //    angular acceleration 16.035 → 16.054 °/s², +0.12%. The octave does
  //    reach the hull and the hull rejects it twice — e^(−k·2 m) Smith
  //    attenuation passes 8–22% (§V.68) and a 35.5 m waterline averages out
  //    the rest (§B.47). The whole 8.3 → 4 sweep spans 0.5%, against
  //    12.06–19.53 °/s² for the domain route, because a split change re-draws
  //    ONLY the crossing octave (`generateH0` draws its gaussian for EVERY
  //    texel and masks by band afterwards, so every mode that keeps its
  //    cascade keeps its exact amplitude and phase).
  //  · §V.8, restated L < 32·λ_short: cascade 1's cap 265.6 → 160 m against a
  //    98 m domain, 61% of budget (was 37%). Cascade 2 is not mirrored
  //    (MIRRORED_CASCADES = 2) so the guard has nothing to say about it.
  //    cpuOcean's cubic gate 64·λ_short/L reads 5.42 → 3.27, same side of its
  //    threshold of 6, so nothing flips.
  //  · §V.59's texel-ratio guard GAINS margin, 0.300 → 0.546 against its 0.25
  //    floor. (Worth knowing on its own: the SHIPPED sea sits at 0.300, i.e.
  //    20% above a floor that fails outright at `splitWavelengths[0]` = 33.)
  //  · caustics `foldDepth` re-derived from this spectrum 2.4108 → 2.4110 m —
  //    its σ_∇²h is a k⁴ moment living at cascade 2's Nyquist, untouched.
  //  · every domain untouched, so §V.19's 1010/98 = 10.31 and 98/22.7 = 4.32
  //    stand; §V.48's population and the §V.40 sampler budget cannot move.
  //
  // WHAT BLOCKS IT IS THE PINNED WHITECAP COVERAGE. The summed σ barely moves
  // (0.15684 → 0.15567) but it REDISTRIBUTES — cascade 1's own σJ +16.5%,
  // cascade 2's −8.6% — and the §V.36 gate is re-expressed against each band's
  // own σ. Measured through the real shading chain at the N=256 mirror that
  // reproduces the pinned figure to three digits: 0.6192% → 0.4146%, A THIRD
  // OF THE WHITECAPS GONE. Restoring it needs `jacobianFoamBias` 0.60 → 0.632
  // (measured 0.6221%, +0.47%) — and that number is 0.015 ABOVE its own
  // ceiling: `tests/foam.test.ts` §V.36 requires storm's gate a full σ looser
  // than swell's, and the gap reads 1.1003 at 0.600, 0.9919 at 0.617, 0.8963
  // at 0.632. The split is NOT what eats the margin (at the shipped 8.3 the
  // gap is 1.1003 and at 5 it is 1.1110 — the split slightly IMPROVES it); the
  // bias raise is. Landing at the legal ceiling 0.617 leaves coverage ≈0.513%,
  // −17% on a pinned invariant, with 0.002σ of headroom on a test another
  // agent's storm retune moves. That is fitting to a wall, which is what
  // research-cascade-tiling.md §4 rejected the domain route for.
  //
  // TO REVIVE IT, one owner decision, both outside this file: raise
  // `foamParams.injectStrength` (linear on the amount, does not touch z, so
  // §V.36's cross-preset contract never sees it — but it scales calm and storm
  // too, which is unmeasured), or re-derive storm's own `jacobianFoamBias`
  // (0.53) down to restore the gap. Either way NOT fixed by this: the SPATIAL
  // half of the complaint — W does not change the tile, so 133 distinct caps
  // are still shown 311× across a 400 m view.
  splitWavelengths: [40, 8.3],
  // wave SCALE is windSpeed (Phillips peak ∝ V²/g), not domain: 8 → 11 m/s
  // moves the mean wavelength 37 m → 69 m. Amplitude drops 0.75 → 0.32 to
  // hold significant wave height near the old sea state (Hs ≈ 2.3 → 2.8 m)
  // instead of letting longer waves also get much taller.
  // 0.32 → 0.24: the SWELL now carries part of the sea's energy, and the point
  // of adding it was a LESS nervous ocean, not a bigger one. Measured Hs holds
  // at 2.79 m against the calibrated 2.81 m, with the wind sea's share down
  // ~25% and 1.4 m of 11 s swell under it.
  amplitude: 0.24,
  windSpeed: 11,
  windDirection: Math.PI * 0.25,
  // Hasselmann/Mitsuyasu, the fit Horvath 2015 uses. Measured axial spread
  // that these produce, against the flat 16.4° they replace:
  //   λ 189 m  37.7°   λ 95 m (peak)  22.9°   λ 40 m  32.8°
  //   λ 20 m   39.0°   λ 8.3 m        39.1°   λ 2.4 m 39.3°
  spreadPeak: 9.8,
  spreadBelowPeak: 5,
  spreadAbovePeak: 2.5,
  spreadMin: 0.5,
  oppositeWaveDamp: 0.06,
  smallWaveCutoff: 0.03,
  choppiness: 0.95,
  // 0.2857 × 1.786 (§V.59 — same λ on every calibrated sea, correct λ on a
  // swell-dominated one; see the interface doc for why the number moved and
  // why the σ-multiple it was documented with was never right).
  choppinessFoldLimit: 0.5102,
  // longer swell at the same height is LESS steep → less jacobian folding,
  // so the foam gate opens slightly to keep whitecap coverage (§V6)
  // 0.55 → 0.615. §V.36 in action rather than a tuning drift: this number is
  // an ABSOLUTE threshold on det J that is DOCUMENTED as a σ-multiple, so it
  // has to be re-derived whenever the sea state moves. Trimming `amplitude`
  // for the swell train took the summed σ down, which pushed the same 0.55
  // from 2.5σ to 2.86σ — i.e. quietly less foam on a sea that is meant to look
  // the same. 0.60 puts it back at 2.54σ, inside the calibrated 2.2–2.6 band
  // and still a full σ looser than storm's gate. (calm/storm set their own
  // amplitude, so their biases are untouched.)
  // THE CEILING ON THIS NUMBER IS 0.6172 AND IT IS NOT SELF-EVIDENT — measured
  // while evaluating `splitWavelengths[1]` 8.3 → 5 (see there), which needed
  // 0.632 to hold the pinned whitecap coverage and could not have it.
  // `tests/foam.test.ts` §V.36 requires storm's gate to sit a FULL σ looser
  // than swell's (the promise this file's own comment above makes), and
  // storm's z is pinned at 1.450–1.459 by its own preset bias. So the gap
  // swell−storm is 1.1003 at 0.600, 0.9919 at 0.617 and 0.8963 at 0.632: this
  // knob has ~0.017 of headroom, ≈35% of the move it took to restore a −33%
  // coverage loss. IF THE PINNED COVERAGE EVER HAS TO BE RESTORED BY MORE THAN
  // THAT, the knob is `foamParams.injectStrength` (linear on the amount, does
  // not touch z, so §V.36's cross-preset contract does not see it) or a
  // matching re-derivation of storm's own bias — both in other files.
  jacobianFoamBias: 0.6,
  // 11 s ⟹ λ 189 m, 5.3 waves across the 1010 m tile. Long enough that the
  // ship lifts to it over several seconds instead of bobbing.
  swellPeriod: 11,
  // 0.34 m RMS ⟹ Hs_swell ≈ 1.4 m under a 2.8 m wind sea: clearly felt as a
  // long lift, never the dominant surface.
  swellAmplitude: 0.34,
  // ~78° off the shipped windDirection (0.25π): running visibly ACROSS the
  // wind sea, which is the whole point of having two trains.
  swellDirection: Math.PI * 1.68,
  swellDirectionality: 24,
  swellBandwidth: 0.12,
  swellGridModes: 2,
  // see the interface docs — 0.6 measured at 5.7e-5 of open-ocean change,
  // 0.78 is the McCowan breaker index, 0.85 is the playability guarantee
  shoalDeepFraction: 0.6,
  shoalBreakerIndex: 0.78,
  shoalColumnCeiling: 0.85,
  // §V.73 — see the interface docs. 260 puts full development at 1043 m of
  // clear upwind water at the shipped 11 m/s, so the open sea between islands
  // is exactly the sea it was and the model acts inside rims and lee shadows.
  fetchWorldScale: 260,
  fetchMaxGain: 1.25,
  fetchLongBandLimit: 2,
  fetchFieldSize: 512,
  // 3200 > storm's 2794 m fully-developed fetch, so a lee shadow has recovered
  // before the field border and clamp-to-edge cannot draw a ring
  fetchFieldMargin: 3200,
  fetchBlurTexels: 3,
  fetchRebuildRadians: 0.03,
}, oceanParamsMeta());

function oceanParamsMeta() {
  return {
    amplitude: { min: 0, max: 4, step: 0.01 },
    windSpeed: { min: 0.5, max: 30, step: 0.1 },
    windDirection: { min: 0, max: Math.PI * 2, step: 0.01 },
    spreadPeak: { min: 0.5, max: 40, step: 0.1 },
    spreadBelowPeak: { min: 0, max: 10, step: 0.1 },
    spreadAbovePeak: { min: 0, max: 8, step: 0.1 },
    spreadMin: { min: 0.1, max: 8, step: 0.1 },
    oppositeWaveDamp: { min: 0, max: 1, step: 0.01 },
    smallWaveCutoff: { min: 0, max: 0.5, step: 0.005 },
    choppiness: { min: 0, max: 3, step: 0.01 },
    choppinessFoldLimit: { min: 0.05, max: 1.2, step: 0.005 },
    jacobianFoamBias: { min: -1, max: 1, step: 0.01 },
    swellPeriod: { min: 2, max: 20, step: 0.1 },
    swellAmplitude: { min: 0, max: 4, step: 0.01 },
    swellDirection: { min: 0, max: Math.PI * 2, step: 0.01 },
    swellDirectionality: { min: 0, max: 64, step: 0.5 },
    swellBandwidth: { min: 0.02, max: 1, step: 0.01 },
    swellGridModes: { min: 0.5, max: 8, step: 0.1 },
    shoalDeepFraction: { min: 0.05, max: 1.5, step: 0.01 },
    shoalBreakerIndex: { min: 0.1, max: 0.95, step: 0.01 },
    shoalColumnCeiling: { min: 0.15, max: 0.99, step: 0.01 },
    // §V.73. The floor on `fetchWorldScale` is not cosmetic: at 1 the world is
    // uncompressed and every square metre of it is fetch-limited.
    fetchWorldScale: { min: 20, max: 4000, step: 10 },
    // min 1 — below it the model would damp the OPEN ocean, which is the one
    // thing it may never do
    fetchMaxGain: { min: 1, max: 3, step: 0.01 },
    // min 1 — at 1 every band longer than the peak is treated identically and
    // the model stops selecting bands at all, i.e. it becomes the amplitude
    // fade this whole file exists not to be
    fetchLongBandLimit: { min: 1, max: 16, step: 0.1 },
    fetchFieldSize: { min: 64, max: 1024, step: 64 },
    fetchFieldMargin: { min: 0, max: 8000, step: 100 },
    fetchBlurTexels: { min: 0, max: 8, step: 1 },
    fetchRebuildRadians: { min: 0.005, max: 0.5, step: 0.005 },
  };
}
