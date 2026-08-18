# Cascade tiling and the synchronous foam pulse

**Status: diagnosed, fix evaluated, NOT landed. Do not re-attempt as a
parameter change without reading §4.**

---

## 1. The defect

User: *"The foaming is happening too regularly, in a way too large area and
pattern, too much at the same time, and too synchronous across the whole
screen — it comes into view and then goes out and comes back into view."*

**Each cascade tile is only ~2.5 of its own longest wavelength.**
`cascades = [1010, 98, 22.7]` m against `splitWavelengths = [40, 8.3]`:

- Cascade 1 holds 8.3–40 m waves in a **98 m** tile — 2.45 wavelengths.
- Cascade 2 holds ≤8.3 m in a **22.7 m** tile — 2.7 wavelengths.

The energetic end of each band therefore carries only ~15 modes, so **the
tile's breaking rate beats coherently**. And every gate term is tile-periodic
by construction: the inject pass computes `worldX = (x + 0.5)·texelMetres`,
which only ever spans `[0, domain)`, so no non-tiling field can enter at the
sim stage.

Caps per tile over 100 s:

| band | tile | caps/tile | range | CV | copies across a 400 m view |
|---|---|---|---|---|---|
| 0 | 1010 m | 486 | 421–550 | 0.060 | — |
| 1 | 98 m | 42 | **8–135** | 0.593 | **17×** |
| 2 | 22.7 m | 133 | **1–778** | 0.999 | **311×** |

Composite coverage swings **0.84% → 5.81% — 6.9× at a 13.3 s period,
identical in every tile copy on screen.**

**The periods are analytically predicted.** Neighbouring-mode beat
`Δω = ½√(g/k)·Δk` gives 24.8 s for cascade 1 and 12.6 s for cascade 2;
injection is a rectified tail statistic so it responds at half that — 12.4 s
and 6.3 s. Matches measurement.

**One cause explains all four complaints.** 42 distinct caps shown 17× is "too
regular" and "too large a pattern"; the tiles firing together is "too much at
once"; the beat is "too synchronous".

### Refuted along the way

- **Cascade 0 dominating the gate.** It does not. §V.36's σ-relative gate works
  as designed — all three bands fire at the same z (2.5–3.3σ), fired area
  0.73 / 0.70 / 0.50%, injection mass share **42.8 / 50.6 / 6.6%**.
- **A global scalar modulating the gate.** `uMeanResidue` / `uMeanBreaking` are
  read **only** by `shadingNode` for far-field retirement and never appear in
  the inject or blurDecay pass. `windScale` is pinned at exactly 1.000 at the
  shipped 11 m/s by its `Math.min(1, …)` clamp.
- **A gate tracking the tile's live spread.** Tile σ(λ⁻) wanders only ±11%
  while injection swings 1000×; normalising moved composite CV 0.528 → 0.500.
  The pulse is not a second-moment effect.
- **`injectFineCascade = 0`.** CV 0.528 → 0.521 for −6.6% injection.

---

## 2. Widening cascade 1 does work

At the shipped 512² cell, through the accumulator, over 100 s:

| cascade 1 domain | W = D/40 | lane-1 injection CV | coverage CV | peak/trough |
|---|---|---|---|---|
| **98 m (shipped)** | 2.45 | 1.031 | 0.503 | **12.1×** |
| 175 m | 4.38 | 0.788 | 0.396 | 5.9× |
| 196 m | 4.90 | 0.662 | 0.356 | 5.1× |
| 392 m | 9.80 | 0.277 | — | mirror forbids |

**The compression is two-sided**, which is the point: at 196 m the coverage
*minimum* rises 0.169% → 0.326% while the *maximum* falls 2.053% → 1.651%.
That is exactly "stops coming into view and going out". Tile copies across a
400 m view: 17 → 4.2.

---

## 3. Cascade 2 must NOT be widened — it is a regression on both axes

Its band runs to the grid's own Nyquist, so **a wider tile adds no modes; it
deletes the short end** (λ 0.089 → 0.355 m). That band carries **65% of the
sea's entire Jacobian variance**.

- 22.7 → 90.8 m: coverage **1.016% → 0.431%**, CV **0.503 → 0.721 (worse)**.
- Re-deriving `jacobianFoamBias` to hold the σ-multiple exactly does not
  rescue it (0.670% → 0.538%, CV 0.621 → 0.689), so it is not a confound of
  the mean having moved.
- Reproduced at 256² and 512².

The 311× lattice is real, but a wider domain is not its fix.

---

## 4. Why cascade 1 alone still does not land

**Three jagged ceilings inside 15% of each other.**

1. **§V.8 hard throw at 265 m.** The mirror keeps the central 64² of h0, so
   `cpuOcean`'s constructor throws once `π·64/domain` falls under the band's
   kMax. `mirrorResolution` cannot simply grow — §B.34 already measured
   1.40 ms/tick at 64² against 6.06 ms at 128², on a 15 ms CPU frame.
2. **§V.59 texel-ratio guard, previously undocumented.** `ocean.test.ts`
   requires the two bands' slopeFootprint/texel ratios stay >25% apart, and
   cascade 1's ratio sweeps *through* cascade 2's as the domain grows:
   **every value from 118 m to 180 m fails**, crossing near-exactly at
   128–153 m. It stays jagged to ~195 m because the footprint is quantised to
   ⅛-octave bins — 188 m passes at 0.343, 190 m fails at 0.244, 193 m passes
   at 0.264.
3. **§V.69 pitch kick is realisation-sensitive.** A domain change reseeds h0
   entirely, so before/after are *different seas*. Peak pitch angular
   acceleration across 130–215 m scatters **12.06–19.53 °/s²**, with the
   shipped 98 m at 14.35 — mid-scatter. The ratio bound passes at 130/175/190
   and fails at 147/196/205/215, and at 205/215 m added inertia makes the
   angle *worse*.

**Landing any specific domain means picking the value that makes three jagged,
partly-random gates green at once. That is fitting to noise (§Rule 6), and it
would silently re-roll on the next spectrum touch.**

---

## 5. Downstream consumers — what actually moved

`docs/research-poseidon.md` warns that the cost of a spectrum change "is not
the spectrum, it is the recalibration of nine downstream consumers". Measured:

**Did not move:** `breakupOctaves` (at its cap of 4 until a 1.0 m texel),
`metricSigmaScale`, the choppiness fold cap (`effectiveChoppiness` stays
unclamped at 0.95 in every config), `whitecapWindScale` (pinned 1.000), the
spray gates (already authored as σ-multiples), cascade 1's
`slopeResolutionFootprint` (4.757 m — its slope lives at λ ≈ 9.5 m, never near
its texel), the §V.40 sampler budget, and the §V.48 population (176, at
baseline — `params/ocean.ts` is not in `SHADER_DIRS` and the change adds no
edges).

**Moved:** `tensorRadiusTexels` on lane 1 (12 → 7 texels; derived and
self-correcting), and **+7–10% of cascade 1's own elevation variance**. That
last is not new energy but a **quadrature correction** — at Δk = 2π/98 the
shipped tile under-integrates its own annulus (σh 0.2729 against 0.2924–0.3015
at every wider domain). Hs 2.783 → 2.83 m. **The ship feels it, and it does
not go away at any domain.**

---

## 6. A method correction worth keeping

§V.8 was first cleared on **mirror height error** (0.0013 → 0.0151 m RMS,
still 5× under cascade 0's shipped 0.0738 m) and called free. **That was the
wrong statistic. The hull integrates curvature, not height.**

Differencing 18 stations bow-to-stern and then twice in time: holding the sea
fixed at 196 m and only halving the mirror cell (64² → 128²) moved peak pitch
angular acceleration **19.53 → 15.71 °/s²**, a controlled −20%. **A wider tile
at a fixed mirror does cost the ship.**

---

## 7. If this is ever landed

The constraints point at **cascade 1 ≈ 213 m**: §V.59 margin 0.52, ratios
4.74 / 9.38 both well off integers, mirror 2.49 samples/λ (≈ cascade 0's
shipped 2.53), W = 5.33.

**Two owner decisions first:**

1. **The mirror.** Either accept 64² at a wider domain — which costs the ship
   ~20% of its pitch response per §6 — or raise `mirrorResolution` and pay
   §B.34's 1.40 → 6.06 ms/tick on a 15 ms CPU frame.
2. **A §Rule 6 re-cut of the §V.69 ratio assertion** so it measures the ship
   rather than the seed. Its own docstring already concedes it "can no longer
   catch" what it was written for.

**Not evaluated:** re-splitting (`splitWavelengths[1]` 8.3 → 11 m, cascade 1 →
330 m, W = 8.25) buys the good regime but moves 8.3–11 m waves off the
mirrored band, i.e. off the ship.

---

## 8. Harness

Left on disk, gated and skipped by default:

- `tests/zzScratchCascadeWiden.test.ts` — `CASCADE_WIDEN=1`. Phases: band
  moments, composite coverage series, mirror reconstruction error, downstream
  consumer table, and `CW_HOLDZ=1` for σ-multiple-held comparisons.
- `tests/zzScratchRatio.test.ts` — the §V.59 sweep.
- `tests/zzScratchFoamSynchrony{,2,3}.test.ts` — `FOAM_SYNC=1`. The original
  per-cascade contribution and time-series measurement.

**Absolute coverage in these harnesses reads 1.016% against the pinned 0.62%**
(they omit the crest-bias tensor and use an isotropic frame). Comparisons are
relative only.

**Unverified:** no browser confirmation of the 13.3 s beat, before or after. At
0.62% coverage the whitecaps are largely sub-pixel and swamped by sails and
sky, so pixel luminance cannot resolve the signal — a real time series needs
an instrumented readback of the foam textures.
