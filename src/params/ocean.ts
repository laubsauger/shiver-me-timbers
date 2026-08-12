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
  };
}
