# Research — `squall01337/abyssal-ocean`, read against our ocean

Prompted by: *"This guy claims his 3 cascades are seamless. Maybe we can look in
there and see how he does it. He also seems to have a pretty neat below-the-surface
looking-up effect. But mostly: the cascades, the distances they use, and the
seamless tile-hiding thing."*

Read at commit `142265f` (3 commits total). The whole project is **one 1805-line
`index.html`** — WebGL2 + three.js from a CDN, no build step. Source read in full;
the demo was **not** run (source-only per brief).

Claims are tagged as in `docs/research-poseidon.md`:

- **[SRC]** — read in their source. File and line given. Checkable.
- **[OURS]** — read in this repo. File and line given.
- **[INF]** — my derivation on top of the above. Disagree with the reasoning, not the source.
- **[GAP]** — looked and could not determine. Not padded with a guess.

---

## 0. If you read nothing else

1. **There is no seam-hiding trick. I looked for one and it does not exist.**
   Every cascade sample in the file is a bare `texture(uD0, p/uL0)` — no rotation,
   no per-cascade world offset, no domain warp, no cross-fade between tile copies.
   I grepped the file for `mat2`, `rot`, `rotate`, `uOffset`; the only hit is the
   radial grid's own `cos(a)/sin(a)` at `[SRC index.html:1156]`. Their foam is
   generated in tile space exactly like ours `[SRC index.html:731]`, so their
   whitecaps are **exactly as statistically periodic as ours**. §1, §2.1.

2. **What they actually did is one line of spectral-partition discipline, and it
   is the real find.** `const BOUND = [ 2*Math.PI*6.0/CASC_L[1], 2*Math.PI*6.0/CASC_L[2] ]`
   `[SRC index.html:242]`. Read it out loud: *every band-limited cascade begins at
   its own sixth lattice ring.* Their W (tile ÷ its own longest wavelength) is
   **exactly 6.000 on both band-limited cascades, by construction**. Ours is
   **2.450 and 2.735** `[OURS src/params/ocean.ts:316,320]`. That is the same
   variable `docs/research-cascade-tiling.md` §1 identifies as the cause of the
   foam beat, and they set it as a design constant instead of letting it fall out
   of the domains. §2.2.

3. **Their tiles repeat MORE than ours, not less.** Cascade 2 is a **19 m** tile
   against our 22.7 m — **443 copies across a 400 m view against our 311**
   `[INF, same (400/L)² convention that produces the doc's 17×/311×]`. They did not
   reduce repetition. They made each tile's *contents* statistically rich enough
   that the repeat reads as sea rather than as pattern. **This is the crux: their
   technique attacks the temporal pulse and does nothing whatever for the spatial
   repetition.** Our defect is both. §2.3.

4. **Our own measured table yields a scaling law, and it prices everything below.**
   Fitting `docs/research-cascade-tiling.md` §2's four rows against W:
   **lane injection CV ∝ W^−0.97, composite coverage CV ∝ W^−0.47, peak/trough
   ratio ∝ W^−1.24** `[INF, §2.4 — least squares, fits the measured points to
   1–15%]`. At their W = 6.0 the peak/trough swing extrapolates to **4.0× against
   our shipped 12.1×**. So the lever is real and worth about 3×. §2.4.

5. **§V.8 is not the ceiling we have been treating it as.** The guard is
   `band.kMax >= π·redN/domain` `[OURS src/sea-physics/cpuOcean.ts:212-218]` with
   `redN = 64` `[OURS src/params/seaPhysics.ts:212]`. Substituting `kMax = 2π/λ_short`
   that is exactly **L < 32·λ_short** — which reproduces the tiling doc's "hard
   throw at 265 m" (32 × 8.3 = 265.6) to the metre. Rewritten in W it is
   **W < 32/B**, where B is the band's own frequency ratio. Cascade 1's allowance
   is **W < 6.64 and it is shipped at 2.45 — 37% of budget** `[INF]`. The mirror
   never capped W at 2.45. §2.5.

6. **The cheap lever nobody costed is the split, not the domain.** W = L/λ_long,
   so W rises either by raising L (all three of the tiling doc §4 gates fight you)
   **or by lowering λ_long — moving the band edge, at a completely fixed domain,
   fixed texel, fixed Nyquist and fixed grid.** Abyssal reaches W = 6 mostly this
   way. Applied to *our* worst cascade: **`splitWavelengths[1]` 8.3 → 5 m lifts
   cascade 2's W from 2.735 to 4.540 without moving a single domain.** That is the
   cascade the tiling doc §3 declared unfixable. §3.1, §4 item 1.

7. **Their underwater is one tenth of ours and beats us on exactly one point.**
   Their Snell's window is ten lines `[SRC index.html:1341-1350]` and it fills the
   window by refracting the view ray through the *real per-fragment wave normal*
   into the analytic sky. Ours computes the disc correctly from the 48.6° critical
   angle but fills it with a **1-D authored gradient lerped by the same `upDot`
   that defines the disc** `[OURS src/ocean/surfaceMaterial.ts:2062-2063]` — a
   rippling rim around a flat interior. Everything else about our underwater is
   better by a wide margin. §5.

8. **Two README claims are contradicted by the source.** "volumetric fog" is a
   single `exp()` on scene depth in the composite `[SRC index.html:1489-1493]`,
   and the underwater gif caption's "light shafts" **do not exist in the file** —
   there is no god-ray, shaft or radial-blur code anywhere in it. §6.

---

## 1. Licence

**MIT.** `Copyright (c) 2026 Sacha (@squall01337)` `[SRC LICENSE]`. Full standard
text, no additional clauses, no third-party notices bundled and none needed — the
file has no vendored code, only a CDN import map for three.js.

**We may copy code from it.** Same operational rule `docs/research-poseidon.md` §7
sets out:

- An idea or a single line: no notice.
- A whole function or shader block: an attribution comment in the receiving file
  naming project, licence and author.

In practice **this does not arise**, because nothing here is worth porting as
code. Their FFT is a WebGL2 fragment-shader chain and ours is WGSL compute
`[OURS src/ocean/fftPasses.ts:2-5]`; their `BOUND` line is arithmetic, not code.
Everything in §4 below is **"reimplement from the idea"**, and most of it is a
parameter edit. The licence is clean and the point is close to moot.

---

## 2. The seamlessness claim

### 2.1 What the source does not contain

The README says the three cascades give swell to the horizon and centimetre chop
under the camera "with no visible tiling" `[SRC README.md]`. Read against the file,
that sentence is doing more work than the code does.

Every cascade read in the project, in full:

| Site | Expression | `[SRC index.html:…]` |
|---|---|---|
| Surface vertex displacement | `textureLod(uD0, p.xz/uL0, 0.0).xyz*w0 + …` | `1215-1217` |
| Surface fragment slope | `texture(uV0, vW.xz/uL0) + …` | `1252-1254` |
| Surface fragment foam | `texture(uF0, vW.xz/uL0).r*0.7 + …` | `1263-1265` |
| Height probe | `texture(uD0, p/uL0).xyz + …` | `755` |
| Buoy vertex | `texture(uD0, p/uL0).xyz + …` | `1103,1106-1107` |
| Seabed caustics | `texture(uDeriv1, p/uL1).xy + …` | `1014` |

`worldPosition / tileSize`, six times, unmodified. **No rotation matrix, no
per-cascade offset, no warp, no tile cross-fade, no reflection.** The one thing
that *could* have decorrelated the three fields — `uSeed` `[SRC index.html:585,662]` —
is never varied per cascade: `rebuildSpectrum` sets `uL`, `uWind`, `uFetch`,
`uDepth`, `uSwell`, `uSpread`, `uShort`, `uCutLo`, `uCutHi`, `uAmp`, `uWindDir`
and leaves the seed at its literal `1337` `[SRC index.html:772-779]`.

Our side is identical in kind: `texture(cascade.displacement, worldXZ.div(domain).fract())`
`[OURS src/ocean/surfaceMaterial.ts:639-642,697-701]`, one global origin applied to
all three `[OURS src/ocean/surfaceMaterial.ts:474]`. **Neither project has any
sampling-side anti-tiling for the cascades.** We do have a rotated-lattice trick
already, but it is applied to the micro-detail *noise* field, not the FFT — a
second octave rotated ~31° at an irrational frequency ratio specifically so the
noise's square lattice does not grid up `[OURS src/ocean/surfaceMaterial.ts:925-938]`.

**So the honest answer to "how does he hide the tiling" is: he does not hide it.**
A tiled inverse FFT is periodic by construction and there is no seam *line* to hide
in the first place — the field is C^∞ across the wrap. The artifact is pattern
recognition, and the only three things in the file that touch it are §2.2 (the
partition), §2.6 (distance fade) and §2.7 (a foam noise). None of them is a
seam-hiding technique in the sense the user was hoping for.

### 2.2 What the source does contain — the `BOUND` line

```js
const CASC_L  = [768.0, 121.0, 19.0];                 // tile size (m) per cascade
// spectral band boundaries so cascades partition k-space without overlap
const BOUND   = [ 2*Math.PI*6.0/CASC_L[1], 2*Math.PI*6.0/CASC_L[2] ];
const CUT_LO  = [ 0.0001, BOUND[0], BOUND[1] ];
const CUT_HI  = [ BOUND[0], BOUND[1], 9999.0 ];
```
`[SRC index.html:240-244]`, applied as `kl >= uCutLo && kl < uCutHi`
`[SRC index.html:639]` — half-open, so an exact partition with no overlap and no gap.

`k = 2π·6/L` is `λ = L/6`. So cascade 1's longest wave is one sixth of cascade 1's
tile, and cascade 2's longest wave is one sixth of cascade 2's tile. In lattice
terms — cascade *n*'s modes live at multiples of `Δk = 2π/L_n` — **each
band-limited cascade's lowest retained mode sits on ring 6 exactly.**

That is the same number `docs/research-cascade-tiling.md` calls W. And the doc's
own diagnostic phrase, *"the energetic end of each band carries only ~15 modes"*
`[OURS docs/research-cascade-tiling.md:20-21]`, is the circumference of that
ring: **modes on the band-edge ring = 2πW** `[INF]`. Ours: 2π×2.450 = **15.4**.
The doc's number falls straight out, which is the check that the interpretation is
right. Theirs: 2π×6.000 = **37.7**.

**The constant `6.0` on line 242 is the entire seamlessness story.** Not a trick —
a refusal to let the band edge sit near DC.

### 2.3 Head-to-head geometry

All at N = 512 (theirs `[SRC index.html:237]`, ours `[OURS src/params/ocean.ts:299]`;
theirs drops to 256 on phones and is overridable with `?n=`).

| | **Abyssal** | **Ours** | Poseidon |
|---|---|---|---|
| Domains (m) | 768 / 121 / 19 `[SRC:240]` | 1010 / 98 / 22.7 `[OURS ocean.ts:316]` | 250 / 17 / 5 |
| Split λ (m) | 20.167 / 3.167 `[SRC:242, INF]` | 40 / 8.3 `[OURS ocean.ts:320]` | *not to hand* `[GAP]` |
| Band 0 (λ, m) | 20.17 → 768 | 40 → 1010 | — |
| Band 1 (λ, m) | 3.167 → 20.17 | 8.3 → 40 | — |
| Band 2 (λ, m) | 0.0742 → 3.167 | 0.0887 → 8.3 | — |
| Texel (m) | 1.500 / 0.2363 / 0.03711 | 1.973 / 0.1914 / 0.04434 | — |
| **W = L/λ_long** | **— / 6.000 / 6.000** | **— / 2.450 / 2.735** | — |
| **Band-edge modes 2πW** | **— / 37.7 / 37.7** | **— / 15.4 / 17.2** | — |
| Copies per 400 m view | 0.3 / **10.9** / **443** | 0.2 / **16.7** / **310** | — |
| Domain ratios | 6.347, 6.368 | 10.31, 4.32 `[OURS ocean.ts:313-314]` | — |

Four things to take from that table.

**Their cascade 2 is smaller than ours and repeats 43% more often.** 443 copies
against 310. Whatever "seamless" means here, it is not fewer repeats.

**Their cascade 2 reaches finer than ours.** A 19 m tile at 512² has a 0.0371 m
texel against our 0.0443 m, so their Nyquist wavelength is 0.0742 m against our
0.0887 m. This matters because `docs/research-cascade-tiling.md` §3 rejected
widening cascade 2 precisely on the grounds that a wider tile *deletes* the short
end that carries 65% of the sea's Jacobian variance. **Abyssal went the other way
and shrank it.** Their W = 6 on cascade 2 is bought entirely by moving the band
edge down (8.3 m-equivalent → 3.17 m), not by touching the tile. §3.1 is the whole
consequence of that observation.

**Their non-commensurability is accidental.** Nothing in the file mentions it and
the two ratios land within 0.3% of each other (6.347 and 6.368) — which is what you
get from picking round numbers, not from optimising. Our 10.31 / 4.32 are chosen
and documented `[OURS src/params/ocean.ts:300-315]`. **We are ahead here and
should not read their numbers as a design.** (Note in passing: that comment's
header line still reads `420/98 ≈ 4.29`, superseded by the `1010/98 = 10.31` given
fourteen lines later at `:313`. Cosmetic, but it will mislead the next reader.)

**Their band 1 is wider in octaves than ours** — 2.67 against 2.27 — because their
cascade 0 absorbs everything above 20.2 m while ours only absorbs above 40 m. That
is the trade §3.1 has to price.

### 2.4 What W is actually worth — a scaling law from our own measurements

`docs/research-cascade-tiling.md` §2 measured cascade 1 at four domains. Refit
against W rather than against metres `[INF, least squares in log-log]`:

| W | lane-1 injection CV | composite coverage CV | peak/trough |
|---|---|---|---|
| 2.45 (shipped) | 1.031 | 0.503 | 12.1× |
| 4.38 | 0.788 | 0.396 | 5.9× |
| 4.90 | 0.662 | 0.356 | 5.1× |
| 9.80 | 0.277 | — | — |

> **injection CV ≈ 2.81·W^−0.966  ·  coverage CV ≈ 0.770·W^−0.470  ·  peak/trough ≈ 36.9·W^−1.243**

Residuals against the measured points: coverage CV and peak/trough both within
1%, injection CV within 15%. In words: **lane injection CV falls as 1/W, composite
coverage CV as 1/√W, and the peak-to-trough swing — the thing the user actually
complained about — falls faster than 1/W.**

Extrapolated (**[INF]**, and note the series was measured by varying *L* at fixed
λ_long, whereas §3.1 proposes varying λ_long at fixed L; W is assumed to be the
common variable, which is the assumption most worth attacking in this document):

| W | source | coverage CV | peak/trough |
|---|---|---|---|
| **2.450** | shipped cascade 1 | 0.503 *(measured)* | **12.1× (measured)** |
| 2.735 | shipped cascade 2 | 0.480 | 10.6× |
| 2.97 | `split[0]` 40 → 33 m | 0.462 | 9.5× |
| 4.54 | **`split[1]` 8.3 → 5 m** | 0.378 | **5.6×** |
| 5.68 | `split[1]` 8.3 → 4 m | 0.340 | 4.3× |
| **6.000** | **Abyssal, both cascades** | 0.332 | **4.0×** |

**That is the honest quantified answer to "does his approach buy anything".**
Yes — about **3× less swing** at W = 6, extrapolated from our own instrument, on
the temporal axis only. It does nothing at all for "42 distinct whitecaps shown
17×", because W does not change the tile.

### 2.5 §V.8, restated — the mirror never capped W at 2.45

The constructor guard `[OURS src/sea-physics/cpuOcean.ts:205-218]`:

```
212    const kEdge = (Math.PI * redN) / this.domain;
213    if (band.kMax >= kEdge) { throw … }
```

with `redN = 64` `[OURS src/params/seaPhysics.ts:212]` and `kMax = 2π/λ_short`.
Legal iff `2π/λ_short < 64π/L`, i.e.

> **L < 32·λ_short**  and equivalently  **W < 32/B**, where **B = λ_long/λ_short**.

Every number in the tiling doc reproduces `[INF]`:

| cascade | λ_short | §V.8 cap `32·λ_short` | shipped L | % of cap | B | **W cap 32/B** | **shipped W** |
|---|---|---|---|---|---|---|---|
| 0 | 40 m | **1280 m** | 1010 m | 79% | — | — | — |
| 1 | 8.3 m | **265.6 m** | 98 m | 37% | 4.819 | **6.641** | **2.450** |
| 2 | — | *not mirrored* `[OURS cpuOcean.ts:66-67]` | 22.7 m | — | 2.735 | **unbounded by §V.8** | 2.735 |

265.6 m against the doc's "hard throw at 265 m" `[OURS docs/research-cascade-tiling.md:101-103]`.

Three consequences.

**Cascade 1 is shipped at 37% of the mirror's W allowance.** The tiling doc reads
§V.8 as a wall at 265 m; read as a ratio it is a wall at W = 6.64, and the doc's
own §7 candidate (213 m, W = 5.33) sits at 80% of it. §V.8 was never what pinned
us at 2.45.

**Cascade 2 is not mirrored at all**, so §V.8 has nothing to say about it. Its
constraint is the one in tiling-doc §3 — the band runs to the grid Nyquist, so
widening L deletes the short end. **Lowering the band edge does not.**

**Abyssal's exact geometry is illegal here.** Their cascade 1 has λ_short = 3.167 m,
so our cap would be `32 × 3.167 = 101.3 m` against their 121 m. Their numbers
would throw in `cpuOcean`'s constructor. **Take the principle, not the values.**

### 2.6 Distance fade — real, and we already do it better

Their second tile-hiding mechanism is simply deleting the cascades that repeat
most, past a distance:

```
float w0 = 1.0 - smoothstep(6000.0, 15000.0, d);
float w1 = 1.0 - smoothstep(3000.0, 11000.0, d);
float w2 = 1.0 - smoothstep( 300.0,  1600.0, d);
```
`[SRC index.html:1212-1214]`, with separate fades on the normals `[SRC:1250-1251]`
and a compensating `rough = clamp(0.008 + 0.115*(1-n2) + 0.075*(1-n1), 0.006, 0.32)`
`[SRC index.html:1260]` so the lost geometric detail returns as microfacet roughness.

Sound, standard, and **we already have a considerably more careful version**:
per-cascade LOD weights `normLod[i]` `[OURS src/ocean/surfaceMaterial.ts:785-791]`,
a global far fade riding the §V.30 LOD law `[OURS :578,703]`, and a §V.48b
variance handover that fades **each wavelet on its own wavelength against the pixel
footprint** and accumulates exactly the variance it threw away as roughness
`[OURS src/ocean/surfaceMaterial.ts:843-844,972-1003]`.

It also does not help our complaint. Their cascade 2 is at full strength out to
300 m; the user's measurement was over a **400 m view**. Fading is a far-field
tool and the defect is near-field.

### 2.7 The one genuinely non-tiling field — and its scale is wrong for us

```glsl
float fn = fbm(vW.xz*0.85 + vec2(uTime*0.04, -uTime*0.03), 4);
foam = sat(foam*uFoamAmount*(0.45 + 1.05*fn));
```
`[SRC index.html:1266-1267]`, `fbm` being 4 octaves of value noise starting at
amplitude 0.5, lacunarity 2.03, gain 0.5 `[SRC index.html:437-443]`.

This is the only field in the project evaluated in **world** space rather than tile
space, so it is the only thing that differs between two copies of the same tile.
It is exactly the "low-frequency non-tiling modulation" the brief lists as a
candidate — and **its scale is wrong for the job**.

`vW.xz*0.85` gives a base feature size of `1/0.85 ≈ 1.18 m` `[INF]`, against tiles
of 19 and 121 m. Its correlation length is one to two orders of magnitude *below*
the repeat it would have to break. It modulates foam by roughly ×0.45 to ×1.43
about a mean near 0.94 `[INF]`, drifting at ~0.06 m/s. **That decorrelates the
fine texture of the foam within a tile. It does not decorrelate one tile copy from
the next**, because at 19 m separation the field has long since decorrelated from
itself and is simply another sample of the same statistics.

To attack *our* defect — 42 distinct caps shown 17 times, in lockstep — the field
has to have a correlation length **at or above the tile**, 50–200 m, so that
neighbouring copies sit at systematically different points of it. Same idea,
inverted scale. That is §4 item 2, and it is the only item on the list that
touches spatial repetition at all.

---

## 3. So: is there a technique that removes the repetition without changing the domains?

Partly. Split the defect first, because the answer is different for each half.

| | our defect | does W fix it? | does Abyssal fix it? |
|---|---|---|---|
| **Temporal** — coverage 0.84% → 5.81%, 6.9× at 13.3 s, in lockstep | yes | **yes, ~3× at W = 6** (§2.4) | yes, structurally |
| **Spatial** — 42 caps shown 17×, 133 shown 311× | no | **no. W does not change the tile.** | only via a 1.2 m foam noise (§2.7) and a 300 m fade (§2.6) — neither reaches it |

**Their seamlessness is real about the pulse and empty about the pattern.** If the
user's "too regular, too large a pattern" is dominantly spatial, nothing in this
repository addresses it and the honest answer is that a tiled FFT cannot, without
a non-tiling term bolted on top.

### 3.1 The transferable idea: move the band edge, not the domain

W = L / λ_long. The tiling doc only ever varied L, and §4 of it records what
happens: three jagged gates within 15% of each other, and "landing any specific
domain means picking the value that makes three jagged, partly-random gates green
at once".

**Abyssal varies λ_long.** That path is not in the tiling doc's evaluated set — its
§7 lists a split change as "**Not evaluated**", and in the *opposite* direction
(8.3 → 11 m, to enable a wider cascade 1). Lowering the edge instead:

- **the domain does not move** → texel, Nyquist, metres-per-texel, `mirrorResolution`
  and every derived footprint are untouched;
- **§V.59's texel-ratio guard sees a fixed texel.** The doc's failure mode there is
  cascade 1's ratio *sweeping through* cascade 2's as the domain grows
  `[OURS docs/research-cascade-tiling.md:105-110]`. With the domain pinned there is
  no sweep — only a single step, which either passes or does not. Must still be
  re-checked, but it is not the same jagged near-random gate;
- **§V.69's realisation sensitivity is bounded rather than total.** A domain change
  remaps every texel to a new k and therefore reseeds the whole cascade — "before
  and after are *different seas*" `[OURS docs/research-cascade-tiling.md:113-114]`.
  A split change only re-draws **the modes that cross the boundary**; every mode
  that stays in its cascade keeps its exact gaussian, amplitude and phase, because
  the texel↔k map depends only on the domain `[INF, from the per-cascade seed
  `seed + index*7919` at `[OURS src/ocean/oceanCascades.ts:124]` and the
  fixed-domain grid]`. One octave is re-rolled instead of all of them. **That makes
  a genuine controlled before/after possible for the first time in this workstream.**

#### Lever B — `splitWavelengths[1]`, 8.3 → ~5 m. The good one.

Raises cascade 2's W with no domain change. Constraint: the 5–8.3 m band moves onto
cascade 1, so cascade 1's λ_short falls and its §V.8 cap tightens with it.

| `split[1]` | **cascade 2 W** | 2πW | cascade 1 §V.8 cap `32·y` | shipped L1 = 98 m | C1 mirror samples/cycle `64y/L1` |
|---|---|---|---|---|---|
| **8.3 (shipped)** | **2.735** | 17.2 | 265.6 m | 37% | **5.42** |
| 6 | 3.783 | 23.8 | 192 m | 51% | 3.92 |
| **5** | **4.540** | **28.5** | **160 m** | **61%** | **3.27** |
| 4 | 5.675 | 35.7 | 128 m | 77% | 2.61 |
| 3.167 *(Abyssal's)* | 7.17 | 45.0 | 101.3 m | 97% — **too tight** | 2.07 |

Cascade 0's shipped mirror resolution at its own band edge is `64×40/1010 = 2.53`
samples/cycle `[OURS src/sea-physics/cpuOcean.ts:184-193,210]`, which the code
already treats as marginal enough to switch on cubic reconstruction. **At
`split[1] = 5` cascade 1 still reads 3.27 — better than cascade 0 has ever had.**
At 4 it reads 2.61, level with cascade 0. Below that you are asking the mirror for
something it has never been asked for. **5 m is the defensible value; 4 m is the
aggressive one; Abyssal's 3.167 is out of reach.**

Costs, stated plainly:

1. **The ship gains 5–8.3 m waves.** `cpuOcean` mirrors cascades 0 and 1 only,
   on the stated grounds that cascade 2 is "sub-boat-length chop [that] averages
   out over a ~30 m hull" `[OURS src/sea-physics/cpuOcean.ts:6-9,66-67]`. This
   change moves one octave *onto* the hull. §V.69 must be re-measured — and per
   the tiling doc §6, **on curvature, not on mirror height error**. Halving the
   mirror cell alone moved peak pitch angular acceleration by a controlled −20%;
   this change is in the opposite direction (more content, same cell).
2. **Hs will rise slightly.** Cascade 1's `Δk = 2π/98 = 0.064` is 4.3× finer than
   cascade 2's `2π/22.7 = 0.277`, so the migrating band is better quadrature-
   integrated after the move. That is the same effect tiling-doc §5 measured as a
   +7–10% variance "quadrature correction" `[OURS docs/research-cascade-tiling.md:138-143]`,
   and it will not go away. Recalibrate, do not fight it.
3. `cpuOcean`'s cubic gate is `64·λ_short/L < 6` `[OURS src/sea-physics/cpuOcean.ts:210]`.
   Cascade 1 reads 5.42 shipped and 3.27 after — **the same side of the threshold**,
   so no gate flip to reason about.
4. h0 is a CPU-generated `DataTexture` `[OURS src/ocean/oceanCascades.ts:95]` at a
   measured 103 ms for a fused 3-cascade rebuild `[OURS :116-121]`. A split change
   is a params edit plus that rebuild — **no shader restructure**, unlike a domain
   change, which is baked as a WGSL literal `[OURS src/ocean/spectrumPass.ts:38,48-49]`.

#### Lever A — `splitWavelengths[0]`, 40 → 33 m. Marginal, and it hits a wall.

Raises cascade 1's W = 98/λ. But cascade 0 *is* mirrored, so its cap `32·λ` must
stay above its 1010 m domain: **λ > 31.6 m**. That leaves W1 = 2.45 → at most 3.10,
worth ~11% on coverage CV by §2.4. Going further means shrinking cascade 0 — and
that runs straight into a recorded, deliberate decision:

> `1010 m on cascade 0, raised from 420 m TO CARRY THE SWELL. An 11 s swell is
> λ ≈ 189 m: in a 420 m tile that is 2.2 waves per repeat, and this project already
> rejected 3.7 waves per tile as visibly repetitive`
> `[OURS src/params/ocean.ts:306-310]`

λ = 25 m would need cascade 0 ≤ 800 m, i.e. 4.2 swell waves per tile — below the
5.3 that comment is defending. **Lever A is worth taking only in its free sliver
(40 → 33 m, cascade 0 untouched), and is otherwise blocked by a decision that was
made for a reason.** Do not re-litigate it by accident.

---

## 4. Ranked shortlist

Ranked by (value against the measured defect) ÷ (cost against our real constraints).
Every entry is tagged **arithmetic-only** or **needs a binding** — per
`docs/research-poseidon.md` §9 we have one spare fragment sampler.

`docs/research-water-implementations.md` ranked 12 items and this repo records
**no** ranked item from either document as shipped `[GAP — I could not verify the
brief's "roughly two of nineteen"; no doc in `docs/` or `SPEC.md` carries a shipped
status for these lists]`. Read the effort column as the operative one.

| # | Thing | Attacks | Cost | Binding | Effort |
|---|---|---|---|---|---|
| 1 | **`splitWavelengths[1]` 8.3 → 5 m** (§3.1) — cascade 2's W 2.735 → 4.540 | **temporal**, on the worst cascade (CV 0.999, 311 copies, 65% of Jacobian variance) | One params line. 103 ms h0 rebuild. No domain, texel, Nyquist or shader change. | **arithmetic-only** — nothing new is sampled | **Small.** The harnesses already exist: `CASCADE_WIDEN=1` and `FOAM_SYNC=1` `[OURS docs/research-cascade-tiling.md:181-190]`. But §V.69 must be re-measured **on curvature** and Hs recalibrated for the quadrature gain. |
| 2 | **Large-scale non-tiling foam modulation** (§2.7) — Abyssal's idea at 50–200 m correlation length instead of 1.2 m | **spatial. The only item on this list that does.** | A world-space fbm multiply on foam coverage, mean-normalised. Shading stage only, so §V.8 does not apply — it never enters the sim. | **arithmetic-only** (we already have the noise; cf. the rotated-lattice micro-warp at `[OURS surfaceMaterial.ts:925-938]`) | **Small.** Two risks: it shifts the calibrated 0.62% coverage unless the mean is held exactly, and it decorrelates foam from the crests that caused it, so it must stay gentle. |
| 3 | **Restate §V.8 in `SPEC.md` as `L < 32·λ_short` / `W < 32/B`** (§2.5) | neither — it unlocks 1 and 4 | None. | n/a | **Tiny.** Documentation. Reproduces the 265 m throw exactly and shows cascade 1 sitting at 37% of budget, which is the fact the tiling doc's framing hides. |
| 4 | **`splitWavelengths[0]` 40 → 33 m** (§3.1) — cascade 1's W 2.450 → 2.970 | temporal, weakly (~11% on coverage CV) | One params line, cascade 0 untouched at 1010 m. | **arithmetic-only** | **Tiny — but low value.** Take it as a free rider on item 1 so one harness run prices both, never on its own. Do **not** push past 33 m; §3.1 shows what is on the other side. |
| 5 | **Refracted sky inside Snell's window** (§5) | neither — visual quality | Replace the authored gradient with a sky evaluation along `refract(-V, -N, 1.333)`. | **[GAP] — possibly needs a binding.** I did not verify that an evaluable sky node is reachable in that fragment stage; if it is not, we are at 15/16. | **Small–medium**, and gated on that GAP. |

**Not worth doing, and I want to be blunt about it:**

Items 1 and 4 are parameter changes with an existing harness. Item 2 is a shader
multiply. Item 3 is a paragraph. **If this list stalls the way the previous two
did, it will not be because the items were expensive — it will be because nobody
ran the harness.** Item 1 without a re-measured §V.69 is not landable, and that
measurement is most of the work.

---

## 5. Underwater, compared

| | **Abyssal** | **Ours** |
|---|---|---|
| Snell's window geometry | Emergent. `refract(-V, -N, 1.333)` per fragment; GLSL returns 0 on TIR and that is the test `[SRC:1344-1347]` | Explicit critical angle, `smoothstep(0.661∓soft, upDot)` with authored softness 0.12 `[OURS surfaceMaterial.ts:2058-2062; params/oceanSurface.ts:771]` |
| Window **contents** | **The analytic sky along the refracted ray**, roughness-blurred at half the surface roughness `[SRC:1347]` | A 1-D `mix(horizonLive, zenithLive, upDot)` — the same scalar that draws the disc `[OURS surfaceMaterial.ts:2063]` |
| TIR ceiling | `inScat*0.85 + behind*0.15` `[SRC:1346]` | Authored `#0e5a5e` × light floor `[OURS params/oceanSurface.ts:768]` |
| Absorption | Three uniform scalars, `exp(-uAbsorb*path)` `[SRC:1285]` | Per-channel **Jerlov K_d**, explicitly not a colour, no sRGB transfer `[OURS underwater/waterVolume.ts:157-159,233-234]` |
| Path length | Screen depth difference `[SRC:1283]` | Analytic `camDepth/max(rayUp,1e-4)`, so the window closes as 1/sin(elevation) with nothing drawing it `[OURS waterVolume.ts:57-59,222-227]` |
| Underwater fog | **One `exp()` on scene depth in the composite** `[SRC:1489-1493]` — README's "volumetric" is not in the source | Depth-lerped inscatter with downward darkening `[OURS waterVolume.ts:236-242]` |
| Light shafts | **None. No shaft/god-ray/radial-blur code exists in the file** (grepped), despite the gif caption | Dedicated `src/underwater/godRays.ts`, composited separately from the volume `[OURS underwater/index.ts:126-127]` |
| Caustics | Seabed only, from the slope-field Jacobian along the sun ray — 3 taps, finite-differenced `[SRC:1017-1030]` | Receiver-side on hull / seabed / beach / shoreline, `mode: 'both' \| 'below'` `[OURS caustics/causticsNode.ts:163,466-476]` |
| CPU mirror + tests | none | `submergedPathLength`, `transmittance` `[OURS waterVolume.ts:289-308]` |

**Architecturally identical where it counts** — both render the water `DoubleSide`
and branch on facing inside the same material `[SRC:1196,1342]`,
`[OURS surfaceMaterial.ts:2069,2088-2094]`.

**One thing they do that we do not, and it is worth having.** Our Snell disc has
the right *shape* — it ripples, because `upDot` uses the displaced normal — but
its *interior* is a vertical gradient indexed by that same scalar, so it carries no
sky structure and no lateral distortion. Theirs refracts into the sky properly, so
the sun, the horizon band and the sky gradient all bend through the wave as the
surface passes overhead. That is the "neat looking-up effect" the user noticed, and
it is ten lines. §4 item 5, gated on whether a sky node is reachable there.

**Everything else on that table we win, mostly by a lot.** Also relevant: the sign
error fixed in `1ee45cc` — the unflipped `ndc.y` mirrored every reconstructed ray,
which sign-flipped `rayUp` and opened Snell's window *downward* while measuring the
submerged path for the wrong hemisphere — is now at `waterVolume.ts:191` with the
reasoning at `:180-190`. It was one of four sites of one defect, three of them
blend-gated and therefore "wrong unseen". **Ours is repaired but lightly exercised;
Abyssal is no use as a cross-check because it does none of this.**

---

## 6. What NOT to take, and why

Blunt on purpose. Each of these looks reasonable in isolation and each is a
regression here.

| Their thing | Why not |
|---|---|
| **Their cascade geometry `[768,121,19]` / split `[20.2, 3.17]`** `[SRC:240,242]` | Illegal at our mirror. Cascade 1's λ_short of 3.167 m caps the domain at `32×3.167 = 101.3 m`; theirs is 121 m, so `cpuOcean`'s ctor throws `[OURS cpuOcean.ts:212-218]`. And 768 m on cascade 0 regresses the documented swell decision — 189 m swell at 4.1 waves per tile against the 5.3 that `[OURS ocean.ts:306-310]` was written to secure. **Take `BOUND`'s principle (§2.2), never its numbers.** |
| **Fragment-shader Cooley–Tukey FFT** `[SRC:687-704]` | `3 × (1 spectrum + 2·log2(512) butterfly + 1 unpack + 1 foam) = 63 fullscreen 512² passes per frame`. We do the same work in 60 compute dispatches `[OURS fftPasses.ts:2-5]` with MRT already packing 8 real fields from 4 complex IFFTs `[OURS spectrumPass.ts:5-7]`. Straight downgrade. |
| **`renderer.readRenderTargetPixels` every frame** `[SRC index.html:1735]` | A **synchronous blocking GPU readback**, i.e. a full pipeline stall, on a frame we already know is CPU-bound at 19–24 ms encode against 6–10 ms GPU. And it buys what `cpuOcean` already gives us for free, without a stall and with phase-exact h0 `[OURS cpuOcean.ts:10-19]`. Worst possible addition to this frame. |
| **GPU "buoyancy"** `[SRC:1100-1116]` | Kinematic surface-following in the buoy's own vertex shader: 3 fixed-point iterations to invert the horizontal displacement, then the mesh is placed on the surface and tilted to the normal. **No forces, no inertia, no dynamics, no CPU state.** Our ship needs rigid-body response; §V.69 measures pitch *angular acceleration*, which this cannot produce at all. |
| **Distance-fading cascades + roughness compensation** `[SRC:1212-1214,1260]` | We already do it, per-wavelet against the pixel footprint, with the §V.48b variance handover accounting for exactly what the fade removed `[OURS surfaceMaterial.ts:843-844,972-1003]`. Theirs is three hand-tuned `smoothstep` pairs. |
| **Absolute Jacobian foam threshold** `[SRC:733]` — `inj = sat((0.62 - J)*1.05)` | A fixed threshold on J, so the gate drifts with wind, choppiness and steepness. Ours is σ-relative by §V.36 and the tiling doc §1 confirms it works as designed — all three bands fire at the same z (2.5–3.3σ). Recorded regression. |
| **Their "volumetric" underwater fog** `[SRC:1489-1493]` | One `exp()` on the scene depth buffer at composite time. Not volumetric, not per-channel, no path-length geometry. Ours is Beer–Lambert on Jerlov K_d over an analytically-derived submerged segment `[OURS waterVolume.ts:222-234]`. |
| **Their non-commensurate domains** | Not a design. Nothing in the source mentions it and the two ratios land within 0.3% of each other. Ours are chosen and justified `[OURS ocean.ts:300-315]`. **Do not "adopt" numbers that were not aimed at anything.** |
| **The 1.2 m foam fbm, ported at their scale** `[SRC:1266-1267]` | The idea is worth item 2; **the scale is not**. At 1.18 m correlation length against a 19 m tile it re-textures within a tile and cannot decorrelate one copy from the next. Porting the constant `0.85` would add cost and buy nothing against our complaint. |

---

## 7. What I could not determine

- **[GAP] The demo was not run.** Source-only per the brief. So "no visible tiling"
  is untested as a *perceptual* claim; everything above tests it as a structural
  one, where it does not hold.
- **[GAP] The README/gif claims of "light shafts" are contradicted by the source** —
  no shaft, god-ray or radial-blur code exists in the file. Either the gif predates
  a removal or the caption overstates. I cannot tell which from three commits.
  Likewise "volumetric fog" (§6).
- **[GAP] Whether a sky node is reachable in our ocean fragment stage**, which
  decides whether §4 item 5 is arithmetic-only or spends the last sampler.
- **[GAP] Poseidon's split wavelengths.** The brief gives its domains `[250,17,5]`;
  without the splits I cannot compute its W and it is left blank in §2.3.
- **[GAP] The brief's "roughly two of nineteen ranked items have shipped."** No
  document in `docs/` and no line in `SPEC.md` records a shipped status for any
  ranked item. I report the ratio as unverified rather than repeat it.
- **[INF, and the assumption most worth attacking]** §2.4's law was fitted to a
  series measured by varying the **domain**. §3.1 proposes varying the **split**.
  Both change W, and the mode-count argument (2πW on the band-edge ring) is
  common to them — but they differ in `Δk`, so the *beat period* moves differently
  even where the *amplitude* agrees. Predicted injection periods
  (`Δω = ½√(g/k)·Δk`, halved for the rectified tail, the formula that reproduces
  the doc's 12.4 s and 6.3 s exactly): Abyssal **21.6 s and 8.5 s** against our
  12.4 s and 6.3 s. **Slower, and slower is not obviously better** — the user's
  complaint was a 13.3 s cycle. Only amplitude is unambiguously improved. **Nobody
  has measured either sea in a browser** (tiling doc §8 is explicit that the 13.3 s
  beat has no browser confirmation, before or after), so this whole workstream is
  still being steered by a harness nobody has validated against a pixel.
