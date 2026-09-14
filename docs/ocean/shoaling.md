# Shoaling grows, then breaks (T190)

## The gap

§V72 shoaled by attenuation only: `tanh(k·d)` per cascade. That was a deliberate calming choice, and it made the
Tower Reach sandbar the calmest water on the lap (23–29% of the swell kept over the crest). The circuit wants the bar
to be where the sea breaks. On 2026-09-13 the user asked for linear theory in every mode: growth, depth-limited
breaking, then surf-zone decay.

## The law (`src/ocean/shoaling.ts`)

Per cascade i, with band deep-water wavenumber k₀ᵢ (energy-weighted mean, floored as before) and still-water depth d:

1. **Local kd.** Fenton & McKee (1990): `kd ≈ x·coth(x^¾)^⅔`, x = k₀d. Within 1.7% of the Newton root.
2. **Shoaling coefficient.** Energy flux is conserved at the group velocity (Dean & Dalrymple 1991 §4.10;
   Holthuijsen 2007 §7.2): `Ks = √(cg_deep/cg)`, where `cg/cg_deep = 2n·tanh kd = T + kd(1 − T²)` and T = tanh kd.
   kd is clamped at π (d = λ/2) and Ks is normalised by its value there, so deep water is **exactly** 1. That folds
   linear theory's last 1% (true Ks(π) = 0.990) into the shallows.
3. **Composition.** `aᵢ = σᵢ · Ksᵢ · externalᵢ`, where external = fetch × swell shadow. Those two gains decide how
   much wave arrives. Shoaling grows what arrived.
4. **Depth-limited breaking, one factor for all bands.** `Hs = 4√Σaᵢ²`, soft-capped at γ·d:
   `limited = min(Hs, knee) + head·tanh(max(Hs − knee, 0)/head)` with knee = onset·γ·d and head = γ·d − knee.
   `B = limited/Hs`. Below the knee B is exactly 1. The curve is C1 through the knee. Past it, Hs = γ·d, so the
   surf zone decays linearly to 0 at the waterline, and dry land gets exactly 0. A single factor keeps every band's
   share of the energy.
5. **Gain** `gᵢ = Ksᵢ · externalᵢ · B` multiplies all of the following: displacement (horizontal included), the
   Jacobian deviation, the normals and the slope variance. The column guard `breakerClip` (0.78/0.85 on |η|) is
   unchanged. With Hs ≤ 0.6·d, a sample reaches it only past 5.2σ.
6. **Breaking intensity** `1 − B²` is the fraction of arriving energy dissipated. It drives the shore-foam
   injection.

**γ = 0.6 on Hs.** Thornton & Guza (1983) found a saturated inner surf zone at Hrms/h = 0.42, which gives
Hs/h = 0.59. For a Rayleigh sea H₁/₁₀ = 1.27·Hs, so the highest tenth sits at 0.76·h. That is McCowan's 0.78
individual-wave limit. The onset is 0.8 (the knee's width). Params: `shoalSurfGamma` and `shoalSurfOnset`.

## One expression, five consumers (§V77)

| Consumer | Call |
|---|---|
| GPU vertex + normals + Jacobian (`surfaceMaterial.ts`) | `shoalBandGainNodes(shoalDepth, uShoalK, uShoalSigma, external, uSurf)` |
| CPU mirror (`CpuOcean.shoaledGains`) | `shoalBandGains(depth, shoalK, shoalSigma, ext, p, out)` over all 3 adopted bands |
| Beach/caustics receiver (`causticsNode.waterHeightNode`) | `shoalBandGainNodes` on `ShoalingUniforms.{k,sigma,surf}` |
| Shore foam (`foam/shoreFoam.ts`) | `shoalSurfNodes` gains, plus `breaking` in the injection drive |

σᵢ is the spectrum's `√heightVariance`, never the camera `dispLod`, because the mirror has no camera. The CPU mirror
draws two bands, but breaking reads all three bands' Hs, just as the GPU does.

## Not modelled

- **Wavelength shortening.** The cascades are global FFT tiles with deep-water ω(k), so phase is shared by the whole
  tile. Shortening near shore needs a per-position phase integrated along rays (∫k dx), and a local UV warp tears the
  tile. kd feeds the amplitude law only.
- **Crest asymmetry.** (Superseded by §T.193 below.) The cheap, band-limited candidate is the Airy surface orbit ellipse: scale each band's
  horizontal Tessendorf displacement by `coth(kd)/coth(π)` (Fournier & Reeves 1986). It sharpens crests and flattens
  troughs. Near the break it multiplies λ·∂D/∂x by about 1.4. With the global fold cap at 0.51 σ, that folds ~16%
  of the breaking zone, and the mirror's fixed-point inverse needs |λ∂D/∂x| < 1. It was left out: it needs a
  fold-safe cap and a decision.

## Measured

- **Open sea.** With the real seabed and fetch wired, open-water `heightAt`/`pressureHeadAt` plus a 600-tick
  buoyancy run hash identically to the same run with no seabed. Before the change, the seabed run differed by up to
  1.9e-4 m, the old `tanh` tax.
- **Tower Reach (seed 1965, reference swell, CpuOcean, 90 s per point on the reference line, old → new).**

  | Location | Hs | Max crest | Breaking |
  |---|---|---|---|
  | Bar crest (d 3.0–3.3 m) | 1.64–1.70 → 2.47–2.70 m | 1.00–1.09 → 1.58–1.75 m | 0 → 0.49–0.59, the only breaking on the lap |
  | Exposed straights | 3.75 mean / 4.90 max (both unchanged) | 3.53 (unchanged) | 0 |

  The bar has the highest Hs/d on the lap, but it is **not** the lap's highest or steepest water. A 2.83 m sea on a
  3 m crest is capped by breaking, and the wavelength cannot shorten.
- **Realised vs spectral.** At a single point over 90 s the mirror's variance runs ~1.3× the spectral σ (few swell
  modes interfere in fixed patterns). So the realised 4·std over the bar reaches 0.89·d while the law's Hs is ≤ 0.6·d.
  The column guard keeps the water above the bed.

# T193: breaking faces steepen

USER, 2026-09-13: "steepen breaking faces". Shoaling waves skew (sharp crests, flat troughs) and pitch forward
(steep front, long back). T193 adds that shape so the Tower Reach bar has ramps.

## The parameterisation

Ruessink, Ramaekers & van Rijn (2012), *On the parameterization of the free-stream non-linear wave orbital motion
in nearshore morphodynamic models*, Coastal Engineering 65, 56–63:

- `Ur = (3/4)·a_w·k/(kd)³` with `a_w = Hs/2`
- `B = p1 + (p2 − p1)/(1 + exp((p3 − log10 Ur)/p4))`
- `ψ = −90° + 90°·tanh(p5/Ur^p6)`
- `Sk = B·cos ψ`, `As = B·sin ψ`
- p1..p6 = 0, 0.857, −0.471, 0.297, 0.815, 0.672

Constants, log10 and `a_w` were checked against Delft3D's `morphology_kernel/sed_support_routines.f90`. XBeach's
`RvR` carries the older 0.79/−0.61/0.35/0.64/0.60 fit, which we do not use. The fit is for near-bed velocity.
Taking the surface shape from it is the approximation (u ≈ η·√(g/d) in shallow water).

Two inputs are this project's choice:

- **Hs** is the local post-breaking Hs of all three cascades (the same m0 breaking reads).
- **k** is each band's **unfloored** mean k, solved to local kd by Fenton–McKee. The depth *gate* uses the floored
  k, so open water stays exact. The floor applied to Ur would understate a 190 m swell's non-linearity over 3 m
  about tenfold.

## The construction (`src/ocean/shoalAsymmetry.ts`)

Per band (cascades 0 and 1, the mirror's bands), at the grid point:

1. **Hilbert partner.** η = hᵢ·gᵢ is the band's shoaled elevation. Tessendorf's D = λ·∇η/|k|, so
   `H = −(Dᵢ·ŝᵢ)·gᵢ/λ` is the band's spatial Hilbert transform along its travel direction ŝᵢ. This needs no
   derivative texture and no extra FFT.
2. **Second harmonic.** `η² − H_q²` and `2η·H_R` carry cos 2φ and sin 2φ.
   `dy = f·[κ_S(η² − H_q²) + κ_A·2η·H_R]`, with `κ_S = c·cos ψ/σ̂` and `κ_A = −c·sin ψ/σ̂`.
   σ̂ = σᵢ·gᵢ, and c inverts the Gaussian-band `B = 6c/(1 + 4c²)^{3/2}`.
   - `H_q = H/q` with q = √⟨cos²θ⟩, zero-mean.
   - `H_R = H/R` with R = |⟨k̂⟩|.
   - q and R restore the directional spread's dilution in the ensemble.
   - ŝ, q and R are `bandPropagation(h0)`, cached per h0 and identical on every side.
3. **Profile guard.** `cos φ + ρ·cos(2φ − β)` grows a second crest past ρ = 0.25 (β = 0) … 0.5 (β = 90°). Fit:
   `0.25 + 0.25·sin^0.6 β`, at most 0.012 above the bisected onset. f saturates the local ratio `ρ = c·|A|/σ̂` at
   `shoalAsymmetryHarmonicCap` (0.95) × onset. It is exactly 1 below 75% of that, with the breaking factor's knee
   construction, and keyed on the envelope.
4. **Deep water.** B × `max(1 − (kd/π)⁴, 0)` on the floored kd, so c = 0 and y + 0 bit for bit.

**ŝ is measured, not assumed.** The h0(k) energy travels toward −k̂: −∂η/∂t·∇η on the mirror agrees with ŝ to
cos > 0.95. **The swell train therefore travels OPPOSITE `swellDirection`** ("direction of travel" in
params/ocean.ts). That is a pre-existing convention mismatch, not changed here. The circuit's "head sea at the
bar" bearings (docs/speedboat/circuit.md) should be re-checked against it by the circuit owner.

### Why vertical, not a forward lean

The horizontal lean `x += ŝ·α·η` has the same first-order harmonic, and it was built and measured first.

- **It folds.** Its Jacobian needs ∂η/∂s, which the mirror does not have pointwise. An envelope guard held the
  narrow-band det estimate `1 − Σk̄q(λqη + αH)` ≥ 0.35. The true finite-difference det of the CpuOcean map still
  reached **−0.15** (d = 1.5 m, swell, seed 42) and was < 0.1 at 2–6 of 8000 points in 5 of 9 preset × seed
  cases. Raising the floor to 0.75 still gave 0.084.
- **Its guard cut the asymmetry.** It removed the fitted As down to 0.54×.
- **The mirror would need a Newton inverse**, because plain fixed-point iteration contracts only by 1 − floor.

The vertical harmonic leaves the horizontal map bit-identical (tested), so its det IS T190's. Measured minimum
0.55 over calm/swell/storm × seeds 1965/42 × 1.5/3/5 m. On the bar it gave equal or more ramp than the lean.
`shoalAsymmetryFoldFloor` became `shoalAsymmetryHarmonicCap`.

## One expression, four consumers (§V.77)

| Consumer | Call |
|---|---|
| GPU vertex (`surfaceMaterial.ts`) | `shoalAsymmetryNodes(shoalDepth, uShoalK, uAsymBand, uAsymDir, uShoalSigma, shoal, η, D, uChoppiness, uAsym)`, `dy·dispLod` added before `breakerClipNodes` |
| GPU normals (same file) | `asym[i].slope(deriv_i.xy·shoal_i)·normLod_i·normFade` added to `der.xy` before the Tessendorf division. ∇η is exact; ∇H is the band ensemble `k̄·q²·η·ŝ` (∂Dx/∂z is not stored), exact for a plane wave (tested vs finite differences). |
| CPU mirror (`CpuOcean.shoaledSum`) | `shoalAsymmetryCoefficients` + `shoalAsymmetrySample` at the grid coord, before `breakerClip`. `pressureHeadAt` takes each band's harmonic × e^(−2k̄T) (its Smith depth). |
| Beach/caustics (`causticsNode.waterHeightNode`) | the same nodes on `ShoalingUniforms.{asymBand, asymDir, asym, choppiness}` |
| Shore foam (`shoreFoam.ts`) | breaking drive × `face`, where the harmonic lifts the crest half (Σdy > 0 and η > 0) |

## Measured

**Open sea.** Pirate and raft archipelagos, real seabed + fetch, 48 open points, heightAt/pressureHeadAt plus a
600-tick buoyancy run:

| World | Hash |
|---|---|
| pirate | `1f12c35d745bbf5c` |
| raft | `45105f343d29bd5a` |

Each hash is identical with seabed vs null AND with gain 1 vs gain 0; max |dh| = 0.

**Sk/As on the mirror** (reference sea, seed 1965, flat bed, 40 points × 128 s, As by Hilbert transform):

| Depth | Ur | Fit Sk / As | Measured Sk / As |
|---|---|---|---|
| 3 m | 0.99 | 0.619 / −0.348 | 0.531 / −0.230 (0.86×, 0.66×) |
| 4 m | 0.72 | 0.602 / −0.229 | 0.529 / −0.148 (0.88×, 0.65×) |

Swell-only sea at 3 m: Sk 0.76 vs 0.57, As −0.40 vs −0.54. Few swell modes make the realised variance 2.1× the
spectral one, so a²/σ̂ overshoots Sk there.

**Tower Reach lap** (CpuOcean, reference line every 20 m, 90 s at 0.5 s). Front = max drop over 1 m along ŝ₀,
ramp = crest − surface 5 m ahead. "Bar" = within 60 m of the crossing, the T190 test's definition. "Exposed" =
K > 0.9, d > 8 m.

| Seed | Bar p99 front (off → on) | Exposed p99 front | Bar p99 ramp (off → on) | Exposed p99 ramp | Bar max ramp | Exposed max ramp |
|---|---|---|---|---|---|---|
| 1965 | 0.396 → **0.455** | 0.427 | 1.29 → **1.68** | 1.44 | **1.85** | 1.69 |
| 42 | 0.330 → 0.420 | **0.515** | 1.55 → 1.30 | **1.92** | 1.61 | **2.02** |
| 777 | 0.337 → 0.347 | **0.420** | 1.14 → 0.98 | **1.33** | 1.16 | **1.62** |

**Acceptance "bar steepest on the lap": met on seed 1965 only. NOT met on 42 or 777.**

- **Why.** On those seeds the exposed straights keep swells up to 4.6 m while breaking caps the bar near
  γ·d = 1.8 m. The FFT still cannot shorten wavelength.
- **Where the steepest bar water is.** Its seaward flank (d ≈ 6 m), just before breaking, not the 3 m crest line.
- **Gain 2 (beyond the fit, B capped 0.95).** The bar's max front slope becomes the lap's steepest on all three
  seeds (0.585/0.653/0.469 vs 0.482/0.545/0.453). The 5 m ramp still does not on 42/777 (1.91 vs 2.03,
  1.28 vs 1.63).
- **Open.** Reaching the target on every seed needs more than the fit (a user decision on the gain), or refraction /
  wavelength shortening, which the shared FFT phase does not allow.

**Boat launch** (headless HullWater + rigid6, deep-V proxy, 25 m/s head sea on −ŝ₀, 16 crossings per point, 50 m
run-in from the flat-water planing pose, bow-up pitch above trim within ±20 m). Scratch:
`tests/zzScratchT193Launch.test.ts`, gitignored, deliberately not a committed test while T189 is changing
hullWater.ts.

| Location | Linear shoaling | With T193 |
|---|---|---|
| Bar crest #52 (3.0 m) | 14.8° | **19.6°** (+4.8°) |
| Bar crest #53 (3.3 m) | 19.2° | **23.5°** (+4.2°) |
| Bar flank #51 (6.1 m) | 22.4° | **25.0°** |
| Bar zone mean (6 pts) | 20.1° | **21.8°** |
| Exposed straights mean (8 pts) | 19.9° | 19.9° (unchanged) |

The best exposed point (#85, 25.9°) still edges the best bar point (25.0°). The launch gain is measurable but
modest, consistent with the slope table.

**Cost.** CpuOcean `pressureHeadAt` is 2.25 µs in open water (unchanged). Over a 3 m bed it is 2.52 → 4.00 µs (four
extra grid samples plus the per-band fit). GPU: the full shipped material builds headless, 21.6 kB vertex /
145.4 kB fragment WGSL. No new texture or sampler (the §V.40 ledger is unchanged). Band moments cost 0.9 + 0.7 ms
once per spectrum rebuild (zero texels skipped, cascades 0 and 1 only), then are cached per h0.

## T193 hunks (for the committing session)

New files:

- `src/ocean/shoalAsymmetry.ts`
- `tests/shoalingAsymmetry.test.ts`

Edits (line numbers as of this writing):

- `src/params/ocean.ts`
  - interface: `shoalAsymmetryGain`, `shoalAsymmetryHarmonicCap` after `shoalSurfOnset` (L219–234)
  - defaults 1 / 0.95 (L515–517)
  - meta ranges (L558–559)
- `src/ocean/shoaling.ts`: header "CREST ASYMMETRY" bullet now points at shoalAsymmetry.ts (L69–70).
- `src/sea-physics/cpuOcean.ts`
  - import block (L60–66)
  - `asymBands/asymHead` + scratch fields (L580–593)
  - band moments in `refreshShoal` (L712–719)
  - harmonic added in `shoaledSum` before `breakerClip` (L975–984)
  - new private `asymmetryAt` (L993–1017)
  - `gridCoord` is unchanged.
- `src/ocean/surfaceMaterial.ts`
  - `vec4` import (L46)
  - shoalAsymmetry import (L82)
  - `uAsymBand/uAsymDir/uAsym` (L501–510)
  - their refresh in `refreshShoal` (L524–530)
  - `asym` nodes + `surfaceY` fed to `breakerClipNodes` (L814–830)
  - normals: `deriv0/deriv1` split, `asymSlope`, `derBands`, `der` (L955–971)
- `src/caustics/causticsNode.ts`
  - import (L36)
  - `ShoalingUniforms.asymBand/asymDir/asym/choppiness` (L236–241)
  - created (L256–259)
  - refreshed (L294–301)
  - `waterHeightNode` keeps the displacement sample and adds the harmonic before the clip (L373–388)
- `src/foam/shoreFoam.ts`
  - import (L14)
  - uniforms (L50–54)
  - refresh in `prepare` (L80–86)
  - `bandDisp` collection (L118, L126)
  - `face` gate on the breaking drive (L172–184)
- `tests/shoaling.test.ts`: shore-foam source assertion now `near.max(shoal.breaking.mul(face))` (L573–574).
- `tests/shoalingCircuit.test.ts`
  - header note (L19)
  - imports (L36–37)
  - new `§T.193 Tower Reach` describe (L123–211)
- `tests/ocean.test.ts`: `shoalAsymmetryGain`, `shoalAsymmetryHarmonicCap` added to `NOT_SPECTRAL` (L693–696). Outside
  T193's listed ownership, but required by the new params, which are per-vertex and not spectral.
- `docs/ocean/shoaling.md`: "Crest asymmetry" bullet marked superseded; this section.
