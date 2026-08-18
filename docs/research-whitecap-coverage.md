# Research — Sea state vs. whitecap coverage: the published laws

Status: research only. No code written, nothing in `src/` touched.

Written for the agent who will implement the coverage curve. **Every number is
tagged:**

- **[PRIMARY]** — the paper that first published it, and I read the statement.
- **[REVIEW]** — quoted by a review/secondary paper because the original is
  paywalled. Attributed to the review, not the original.
- **[OURS]** — measured or read out of this repo.
- **[INFERRED]** — my arithmetic or my reasoning on top of the above. Checkable,
  but nobody published it.

Paywall status is stated inline every time it matters. AMS (`journals.ametsoc.org`)
and AGU/Wiley (`agupubs.onlinelibrary.wiley.com`) both refused direct fetches;
everything below that comes from those journals is either from Crossref's
deposited abstract (which is the publisher's own text, so effectively primary for
the abstract's claims) or from an open-access paper that quotes it.

---

## 0. The three sentences that matter

1. **There is a real onset and it is ~3.7 m/s** (Beaufort 3, ~7 kt). Below it,
   published fits give literally zero coverage. The user's "if it's rather calm
   it's fine that there's no foam" is not an artistic liberty — it is the
   published law. [PRIMARY/REVIEW, §2]
2. **Observed coverage scatters by one to two orders of magnitude at a fixed
   wind speed.** Three independent open-access sources say so in those words.
   This is the sentence that licenses an art multiplier: a ×3 fudge is *inside
   the published error bar*, not a fudge. [REVIEW, §5]
3. **Wind speed is the driver; steepness is the distributor.** The literature
   tried steepness/mean-square-slope as a *replacement* for wind speed and it
   did not clearly win. Our Jacobian gate is the right thing to decide *where*
   foam goes; it is not the right thing to decide *how much*. [PRIMARY, §6]

---

## 1. The curve, in a form you can code

### 1.1 Recommended: Callaghan et al. (2008), threshold-cubic

This is the one to implement. It has an explicit onset, it is a cubic (cheap
polynomial, no LUT, no sampler), and an independent group refitted the same data
in friction-velocity space and landed within ~15 % of it (§1.3).

Quoted verbatim from Albert et al. 2016 (open access), their Eq. (2), where
**W is in percent** and **U10 is the 10 m neutral wind speed in m/s**: [REVIEW]

```
W(%) = 3.18e-3 * (U10 - 3.70)^3      for 3.70 < U10 <= 11.25 m/s
W(%) = 4.82e-4 * (U10 + 1.98)^3      for 9.25 < U10 <= 23.09 m/s
```

**As a fraction** (divide by 100) — this is the form to actually use, because
coverage in our sim is a fraction of area: [INFERRED, trivial arithmetic]

```
W = 3.18e-5 * (U10 - 3.70)^3         3.70 <= U10 <= 11.25
W = 4.82e-6 * (U10 + 1.98)^3         9.25 <= U10 <= 23.09
W = 0                                U10 < 3.70
```

**The two branches deliberately overlap on 9.25–11.25 m/s.** That overlap is in
the published domain statement, so crossfading between them across that window
is what the paper's own structure invites, not an invention. At U10 = 9.25 the
branches give 0.544 % and 0.683 % — a 26 % step — so a `smoothstep(9.25, 11.25,
U10)` blend removes a visible discontinuity for free. [INFERRED]

**Clamp the top at W = 0.10.** Brumer et al. 2017 measured out to sustained
U10N = 25 m/s and state: *"These measurements suggest that W levels off at high
wind speed, not exceeding 10 % when averaged over 20 min."* [PRIMARY — Crossref
abstract, `10.1175/JPO-D-17-0005.1`]. Our `windSpeed` slider goes to 30 m/s
[OURS], i.e. past the fit's 23.09 m/s validity edge, so the clamp is load-bearing
rather than defensive.

Implementable shape, ~8 ALU:

```
w = 0
if U10 > 3.70:
    a = 3.18e-5 * (U10 - 3.70)^3
    b = 4.82e-6 * (U10 + 1.98)^3
    t = smoothstep(9.25, 11.25, U10)
    w = min(mix(a, b, t), 0.10)
```

### 1.2 The classic: Monahan & O'Muircheartaigh 1980 ("MOM80")

The prior research doc cited this and flagged it as unsubstantiated. **It is now
substantiated.** Two published forms, from the AMS abstract of the original
(`journals.ametsoc.org/view/journals/phoc/10/12/1520-0485_1980_010_2094_opldoo_2_0_co_2.xml`,
paywalled body, abstract public) and independently reproduced as Eq. (3) of
Albert et al. 2016: [PRIMARY for the abstract text / REVIEW for Eq. 3]

```
W = 2.95e-6 * U10^3.52     (ordinary least squares)
W = 3.84e-6 * U10^3.41     (robust biweight — the one everyone cites)
```

**W here is a FRACTION, U10 in m/s at 10 m.** This is a real trap: the same law
is also published as `W(%) = 3.84e-4 * U10^3.41`, and the two coefficients differ
by exactly 100. Both forms appear in the literature and web search returns both
interchangeably. [INFERRED — I resolved it two ways: (a) the fraction reading
gives 0.99 % at 10 m/s and 10.5 % at 20 m/s, which matches every qualitative
description; (b) the Monahan et al. 1986 sea-spray source function is built as
`W(U10)/tau` with `tau = 3.53 s` and coefficient 1.373, and `3.84e-6/3.53 =
1.09e-6` is dimensionally consistent only if W is dimensionless.]

So the prior doc's "~1 % at 10 m/s, ~10 % at 20 m/s" **checks out exactly**:
`3.84e-6 * 10^3.41 = 0.0099` and `3.84e-6 * 20^3.41 = 0.105`. [INFERRED,
arithmetic]

**Why I am not recommending it anyway.** Albert et al. state that MOM80 was fit
to Monahan (1971) + Toba & Chaen (1973), that *"most of the wind speed values
from these two data sets are up to 12 m s−1 with only 10 % of the data points
for winds up to 17 m s−1"*, SST range 17–31 °C, and that *"Monahan and
O'Muircheartaigh (1986) emphasized that this is a regionally specific function,
but its widespread adoption in global models led to its application at wind
speeds and SSTs well beyond its range of validity."* [REVIEW]. It also has **no
onset term** — it is a bare power law, so it predicts nonzero foam at 1 m/s,
which is the exact failure the user is complaining about. And extrapolated it
reaches W = 1.0 (100 % coverage) at U10 = 38.7 m/s [INFERRED], which is absurd
against Brumer's measured 10 % ceiling.

Use it as a **cross-check**, not as the curve.

### 1.3 Corroboration: Hwang et al. 2019, in friction-velocity space

Open-access accepted manuscript (IFREMER Archimer,
`archimer.ifremer.fr/doc/00506/61757/65730.pdf`), published as JPO
`10.1175/JPO-D-19-0061.1`. Their Eq. (9), introduced by Hwang (2012) and
*"established on the whitecap measurements by Callaghan et al. (2008)"*:
[PRIMARY — I read the PDF]

```
Wc = 0                        u* <= 0.11 m/s
Wc = 0.30 * (u* - 0.11)^3     0.11 <= u* <= 0.40 m/s
Wc = 0.07 * u*^2.5            u* >= 0.40 m/s
```

and, verbatim: *"The two matching points of three branches in (9), i.e.
u\*=0.11 and 0.40 m s-1, correspond to U10=3.3 and 10.0 m s-1."* So this is an
**independent restatement of the same threshold-cubic shape**, with the onset at
U10 = 3.3 m/s rather than 3.70. Wc is a fraction here (at u* = 0.40 both branches
give 0.0073, i.e. 0.73 % at U10 = 10 m/s). [INFERRED, arithmetic]

Two independent fits agreeing on onset ≈ 3.3–3.7 m/s and on ≈ 0.7–1.0 % at
10 m/s is about as solid as this literature gets.

### 1.4 What the three laws actually disagree about

| U10 (m/s) | MOM80 | CAL08 | Hwang/u\* |
|---|---|---|---|
| 4.35 | 0.058 % | 0.0009 % | ~0 |
| 6.95 | 0.29 % | 0.11 % | — |
| 10.0 | 0.99 % | 0.78 % | 0.71 % |
| 15.7 | 4.6 % | 2.7 % | — |
| 20.0 | 10.5 % | 5.1 % | 5.6 % |

[INFERRED — all my arithmetic from the formulas above.]

Read the top row. **At the onset region the two published laws differ by a factor
of ~60.** That is not sloppiness on my part; it is the genuine state of the
field, because a bare power law and a threshold cubic behave completely
differently near zero and there are very few reliable measurements down there.
The consequence for us is direct: **the "little speckles of foam" regime is the
least-constrained part of the entire curve**, and shaping it by eye is not
cheating.

At 20 m/s they differ by ~2×, which is the well-behaved end.

---

## 2. Onset

| Source | Onset U10 | Type |
|---|---|---|
| Albert et al. 2016, intro | *"They form at wind speeds of around 3 m s−1 and higher"* | [REVIEW] |
| Callaghan et al. 2008 (via Albert Eq. 2) | 3.70 m/s | [REVIEW] |
| Hwang 2012/2019 Eq. (9) | 3.3 m/s (u\* = 0.11) | [PRIMARY] |
| Beaufort Force 3 lower bound | 7 kt = 3.60 m/s | [PRIMARY, NOAA] |
| Albert et al. 2016 own 10 GHz fit | ~1.1 m/s | [PRIMARY] |
| Published range, per Albert | 0.6 (Reising 2002) to 6.33 (Stramska & Petelski 2003) | [REVIEW] |

Albert et al. are blunt that this is not settled — their own fit yields 1.1 m/s
and they note that a *positive* y-intercept fell out of their 37 GHz fit, which
they call *"meaningless at first glance and intriguing upon some pondering"*
[PRIMARY, I read it].

**But the striking thing is the coincidence.** Beaufort Force 3 begins at 7 kt =
3.60 m/s and its description is the first mention of whitecaps in the entire
scale. Callaghan's independently fitted threshold is 3.70 m/s. A descriptive
19th-century observational scale and a 2008 least-squares fit to video imagery
land 0.1 m/s apart. **Use 3.7 m/s and stop worrying about it.** [INFERRED — the
coincidence is mine to point out; both numbers are sourced.]

---

## 3. The Beaufort table (art-facing cross-check)

Two NOAA sources, both fully public, both fetched directly:

- `https://www.spc.noaa.gov/faq/tornado/beaufort.html` — the terse WMO table.
- `https://www.weather.gov/media/pqr/beaufort/beaufort.pdf` — "Estimating Wind
  Speed and Sea State with Visual Clues", longer descriptions, uses the sailor's
  term *white horses*.

Merged, with m/s conversion (×0.5144) and MOM80/CAL08 coverage at each band's
midpoint. Sea descriptions are **verbatim NOAA**; the wind in m/s and the two
coverage columns are [INFERRED] arithmetic.

| F | Name | kt | m/s | NOAA sea description (foam terms in bold) | MOM80 | CAL08 |
|---|---|---|---|---|---|---|
| 0 | Calm | <1 | <0.5 | "Sea surface smooth and mirror-like" | 0 | 0 |
| 1 | Light Air | 1–3 | 0.5–1.5 | "Scaly ripples, **no foam crests**" | ~0 | 0 |
| 2 | Light Breeze | 4–6 | 2.1–3.1 | "Small wavelets, crests glassy, **do not break**" | 0.010 % | 0 |
| 3 | Gentle Breeze | 7–10 | 3.6–5.1 | "Large wavelets, crests begin to break. Foam of glassy appearance. Perhaps **scattered white horses**" | 0.058 % | 0.001 % |
| 4 | Moderate Breeze | 11–16 | 5.7–8.2 | "Small waves, becoming longer. **Fairly frequent white horses**" | 0.29 % | 0.11 % |
| 5 | Fresh Breeze | 17–21 | 8.7–10.8 | "Moderate waves, taking more pronounced long form. **Many white horses** are formed (chance of some spray)" | 0.91 % | 0.74 % |
| 6 | Strong Breeze | 22–27 | 11.3–13.9 | "Large waves begin to form. **White foam crests are more extensive everywhere**" | 2.2 % | 1.5 % |
| 7 | Near Gale | 28–33 | 14.4–17.0 | "Sea heaps up and **white foam from breaking waves begins to be blown in streaks** along the direction of wind" | 4.6 % | 2.7 % |
| 8 | Gale | 34–40 | 17.5–20.6 | "Edges of crests begin to break into the spindrift. **The foam is blown in well-marked streaks**" | 8.8 % | 4.5 % |
| 9 | Strong Gale | 41–47 | 21.1–24.2 | "High waves. **Dense streaks of foam** along direction of wind. Crests begin to topple, tumble and roll over" | 15.9 %† | 7.2 % |
| 10 | Storm | 48–55 | 24.7–28.3 | "Very high waves with long overhanging crests. **Foam in great patches blown in dense streaks.** On the whole, the sea takes on a whitish appearance" | 27 %† | — |
| 11 | Violent Storm | 56–63 | 28.8–32.4 | "**The sea is completely covered with long white patches of foam** lying along the direction of the wind" | 45 %† | — |
| 12 | Hurricane | 64+ | 32.9+ | "The air is filled with foam and spray. **The sea is completely white with driving spray**" | — | — |

† Beyond MOM80's data range (≤17 m/s) and contradicted by Brumer's measured
≤10 % ceiling. Do not use.

**Three things this table gives the art side that the formula does not:**

1. **F3 is the first foam.** "Perhaps scattered white horses" — *perhaps*. That
   is the speckle regime, at 0.001–0.06 % coverage.
2. **F7 is where foam stops being spots and becomes streaks.** "Blown in streaks
   along the direction of wind." This is a *directional* change, not just a
   coverage change — it is the earliest wind-aligned anisotropy in the scale, at
   ~14 m/s. Worth noting given the prior doc's §2.3 finding that our anisotropy
   currently runs along the crest rather than along the wind.
3. **Even F10 "Storm", at 27 % by MOM80, is described as "on the whole the sea
   takes on a whitish appearance" — not "white".** Full white is F12. Anything
   in normal play that reads as a white sea is off by several Beaufort forces.

---

## 4. What coverage depends on besides wind speed — and the swell question

Albert et al. 2016 list the secondary factors with citations [REVIEW]:
atmospheric stability (air–sea temperature difference), SST, friction velocity,
wave field, and surfactant activity. Dierssen 2019 adds fetch, duration,
salinity, current shear, long-wave interaction, wave age, and organic films
[REVIEW].

### 4.1 Does a big old swell with no local wind carry whitecaps? No.

This is the user's exact case and the answer is clean.

- **Mechanism.** Whitecapping is wind-driven wave breaking: the local wind must
  keep forcing the crest until it steepens past the limit and spills. Swell is
  by definition wave energy that has *left* its generating area; it has sorted
  into long, smooth-crested, low-steepness waves and there is no local forcing
  to break it. Standard oceanography-course material, e.g. Webb, *Introduction
  to Oceanography*, §10.2 "Waves at Sea"
  (`https://rwu.pressbooks.pub/webboceanography/chapter/10-2-waves-at-sea/`),
  which notes swell travels great distances "even where there is no local wind"
  and contrasts it with wind waves as "longer waves with smoother crests".
  [PRIMARY, open course text]
- **Quantitatively.** Callaghan et al. 2008, *"Observed physical and
  environmental causes of scatter in whitecap coverage values in a
  fetch-limited coastal zone"*, JGR `10.1029/2007JC004453` (paywalled; I have
  this via search summary only, so treat as **[REVIEW]**): whitecap coverage was
  **about one third lower in swell-dominated seas than in mixed seas**, and
  swell-dominated conditions introduced markedly more scatter, while scatter was
  *"markedly absent in mixed seas when the spectral intensity of the wind waves
  is of the same order of magnitude as the spectral intensity of the swell
  waves."*
- **Corroborating.** Brumer et al. 2017 [PRIMARY, Crossref abstract]: *"When
  expressing W in terms of wavefield statistics only or wave age, larger scatter
  is observed."* i.e. wave height/steepness alone, decoupled from wind, is a
  *worse* predictor — consistent with swell height not implying foam.

**Implication for us, and it is the important one.** A tall swell at low
`windSpeed` should produce **near-zero foam**. Our current foam gate is on the
Jacobian's minimum eigenvalue σ-relative per cascade, i.e. purely a
steepness/fold criterion [OURS]. A σ-relative gate is *scale-free*: crank the
swell with the wind low and the folds still exceed their own band's σ, so it
will still inject. **That is the mechanism by which we can produce foam on a
windless swell, which the literature says should not happen.** The fix is not to
change the gate — it is to scale the injected amount by a wind-derived target
(§7).

### 4.2 SST and stability

Mixed evidence, and worth knowing only so nobody wastes time on it. One study
found *"changes in sea surface temperature (2 to 13 °C) and near-water air
stability showed no discernible effect on whitecap coverage at any given wind
speed"*; others find W weakly decreasing with SST [REVIEW, via search of
Stramska 2003 / Ocean Science Journal 2022]. Albert et al.'s whole paper is an
attempt to fold SST in and they conclude its effect shows up *"implicitly
expressed as a change of the wind speed exponent"* [PRIMARY]. **Not worth
modelling.** It is inside the scatter.

### 4.3 Wind history

Callaghan et al. 2008 (GRL, `10.1029/2008GL036165`, paywalled): segregating by a
**2.5 hour wind history** reduced scatter above ~9.25 m/s, with W higher for
*decreasing* winds than increasing ones [REVIEW]. That is hysteresis — a dying
gale keeps its foam. Cheap to fake with a lagged `windSpeed` if anyone ever
wants it; not required.

---

## 5. The honest error bars — the single most important section

Three independent open-access statements, escalating:

> *"an order-of-magnitude scatter (spread) of W data remains, suggesting that
> U10 alone cannot fully predict the W variability."*
> — Albert et al. 2016, ACP, open access. [PRIMARY, I read the PDF]

> *"instantaneous whitecap coverage can vary by several orders of magnitude at
> the same wind speed"*
> — Dierssen 2019, Frontiers in Earth Science, open access, citing Anguelova &
> Webster 2006 and Brumer et al. 2017. [PRIMARY for the review's own sentence]

> Wide spread of the W data within and between in situ data sets has led to
> W(U10) parameterizations that predict W with **more than 2 orders of
> magnitude** variation at a given wind speed.
> — Anguelova & Webster 2006, JGR `10.1029/2005JC003158`, paywalled.
> [REVIEW — via search summary; I could not fetch the body.]

Hwang et al. 2019 add, on plotting choice: *"Log-log scales are used because the
data ranges of Wc and Et stretch 2 to 5 orders of magnitude."* [PRIMARY, I read
the PDF].

And Albert et al. note the *reason* the exponents differ everywhere: *"each
campaign conducted in different regions and conditions comes up with a specific
wind speed exponent."* Published exponents in this document alone span **1.59**
(Salisbury et al. 2013, satellite 37 GHz), **2** (Albert's own quadratic), **3**
(Callaghan), **3.41/3.52** (MOM80). [REVIEW/PRIMARY as tagged.]

**What this means for us, stated plainly:** a global art multiplier of 0.3× or
3× on the coverage target does not put us outside the published data. It puts us
in the middle of it. What is *not* defensible is the shape — the onset, the
monotonic rise, the ~10 % ceiling. Get the shape from the literature, keep one
scalar gain for the artist, and the result is honest.

---

## 6. Steepness vs. wind speed — are we keying off the right quantity?

Our foam injects on the minimum eigenvalue of the horizontal displacement
Jacobian, σ-relative per cascade [OURS] — a **steepness/fold** criterion, no wind
term. So this question is load-bearing. The literature has tested exactly this
and the answer is genuinely two-sided.

**For steepness.** Schwendeman & Thomson 2015, JGR `10.1002/2015JC011196`
(paywalled body; abstract below is the publisher's own deposited text via
Crossref, so [PRIMARY] for these claims):

> *"A threshold power law fit is proposed for all variables, which incorporates
> the flexibility of a power law with the threshold behavior commonly seen in
> whitecapping."* … *"Wave slope variables are examined for potential
> improvement over wind speed parameterizations. Of these variables, the mean
> square slope of the equilibrium range waves has the best statistics, which are
> further improved after normalizing by the directional spread and frequency
> bandwidth."*

Note also, same abstract: correlation with **turbulent dissipation** is *"worse
than the wind or wave relations"*, and the residuals *"show a strong negative
trend with wave age"*, attributed to microbreaking in older wind seas.

**Against steepness alone.** Brumer et al. 2017, JPO `10.1175/JPO-D-17-0005.1`
(paywalled body; Crossref abstract, [PRIMARY] for these claims) tested wind
speed, wave age, wave steepness, mean square slope, and two Reynolds numbers
against 600 × 20-minute imagery records:

> *"Combining wind speed and wave height in the form of the wind-wave Reynolds
> number resulted in closely agreeing models for both datasets… When expressing
> W in terms of wavefield statistics only or wave age, larger scatter is
> observed and/or there is little agreement between SO GasEx, HiWinGS, and
> previously published data. The wind speed–only parameterizations… agree
> closely and capture more of the observed W variability than Reynolds number
> parameterizations. However, these wind speed–only models do not agree as well
> with previous studies."*

**The honest reading.** Steepness is *competitive* with wind speed as a
predictor and is arguably more physical. It is **not** established as better,
and wavefield statistics *without* a wind term are established as **worse**.
Nobody has published a steepness→coverage law with the authority that MOM80 and
CAL08 have for wind→coverage, and I did not find one usable as a curve.

**So: keep the Jacobian, add a wind-driven scale.** §7.

---

## 7. What our sim should actually key off

We have, per the task brief and the repo [OURS]: wave height, steepness, the
Jacobian minimum eigenvalue per cascade, and `oceanParams.windSpeed`
(`src/params/ocean.ts:24`, default **11 m/s**, range 0.5–30, unit m/s, feeding
the Phillips peak ∝ V²/g).

**Recommendation: two-part, and it maps cleanly onto what we already have.**

- **The Jacobian gate decides *where*.** Unchanged. It is a fold criterion, it
  puts foam on the faces that are actually breaking, and no wind-speed formula
  can tell you *which* crest. Keep it.
- **`windSpeed` decides *how much*.** Compute the CAL08 target `W_target(U10)`
  from §1.1 once per frame on the CPU — it is ~8 scalar ops, no texture, no
  sampler, nothing near the 15/16 budget — and use it to scale the injection
  amount (or to modulate the σ-multiple of the gate) so that realised coverage
  tracks it.

Two caveats to state rather than bury:

1. **Reference height.** MOM80/CAL08/Brumer all use **U10**, the 10 m neutral
   wind. Tessendorf/Phillips implementations inherit `V` from Pierson–Moskowitz,
   whose original reference height is **19.5 m**. If our `windSpeed` is really a
   U19.5, then U10 ≈ 0.909 × U19.5 under a 1/7 power law, and using it raw as
   U10 inflates coverage by 1.10^3.41 ≈ **1.4×**. [INFERRED] That is a 40 %
   error — real, but an order of magnitude inside the scatter of §5. Worth one
   comment in the code, not worth a correction factor.
2. **Coverage is a 20-minute average.** Every W in this document is a temporal
   and spatial mean over minutes and hundreds of metres. Instantaneous coverage
   in a single frame legitimately fluctuates far above and below it. Matching the
   *mean* is the goal; per-frame equality is not meaningful.

### 7.1 Where we currently sit — a concrete calibration

We measure **~0.6–0.8 %** coverage at default swell in the injected-region
harness [OURS, from the task brief].

Inverting MOM80: `3.84e-6 · U10^3.41 = 0.006 … 0.008` gives **U10 = 8.6–9.4
m/s** [INFERRED]. That is **Beaufort 5, "Many white horses are formed"** — a
perfectly respectable fresh breeze, and reassuringly not absurd.

But our default `windSpeed` is **11 m/s**, for which CAL08 predicts **0.98 %**
and MOM80 **1.37 %** [INFERRED]. **So we are producing roughly half to
two-thirds of the literature coverage for our own nominal wind.** Combined with
§8 (our foam is ~2–4× too bright), that is a coherent diagnosis of the standing
complaint: **too little foam, each pixel far too white.** Those two errors partly
cancel in a thumbnail and do not cancel at all in motion, which is exactly what
"synthetic, like a weird liquid" describes.

---

## 8. Foam albedo — ours is high by a factor of ~2–4

All of the following is from Dierssen 2019, *"Hyperspectral Measurements,
Parameterizations, and Atmospheric Correction of Whitecaps and Foam From Visible
to Shortwave Infrared for Ocean Color Remote Sensing"*, Frontiers in Earth
Science, **open access**
(`https://www.frontiersin.org/journals/earth-science/articles/10.3389/feart.2019.00014/full`).
I read it directly, so it is [PRIMARY] for its own sentences and [REVIEW] for
the values it attributes to older papers.

| Quantity | Value | Source |
|---|---|---|
| Fresh dense foam, visible | **0.55** | Whitlock et al. 1982 [REVIEW] |
| Reflectance at initial breaking | **0.20–0.55** | Koepke 1984 [REVIEW] |
| Reflectance after ~10 s | **0.03–0.10** | Koepke 1984 [REVIEW] |
| Koepke's efficiency factor on Whitlock | **0.4 ± 0.2** | Koepke 1984 [REVIEW] |
| **Time-averaged effective whitecap reflectance** | **0.22** | Koepke 1984 [REVIEW] — this is the number used in operational atmospheric correction |
| Dierssen's own measurements, natural + manufactured foam, visible | **~0.18** | [PRIMARY] |
| Spread across past studies, visible | 0.40–0.75 | [PRIMARY, Dierssen's summary] |
| NIR/SWIR falloff from visible | −40 % @ 850 nm, −50 % @ 1020 nm, −85 % @ 1650 nm | Frouin et al. 1996 [REVIEW] |

Koepke 1984 is *Applied Optics* 23(11):1816 (`https://opg.optica.org/ao/abstract.cfm?uri=ao-23-11-1816`),
paywalled. A EUMETSAT-hosted copy exists at
`https://user.eumetsat.int/s3/eup-strapi-media/pdf_il_07_07_13_a_dfa14e9e2f.pdf`.

**Ours.** `foamColor: '#eef6f2'` (`src/params/oceanSurface.ts:612`) [OURS]. I
recomputed the linear luminance from the hex and confirm the stated **0.905**
(sRGB→linear per channel, Rec.709 weights) [INFERRED].

**The comparison, carefully.** These published figures are remote-sensing
*reflectances* — radiance/irradiance ratios under natural sky illumination — not
PBR diffuse albedos, so this is not apples to apples and I will not pretend
otherwise. **[INFERRED]** The closest analogue to a renderer's diffuse albedo is
the fresh-foam figure, because that is a measurement of the foam material rather
than a time- and scene-averaged effective quantity. Against that:

- vs. Whitlock's fresh dense foam (0.55): we are **1.6× too bright**
- vs. Koepke's effective 0.22: we are **4.1× too bright**
- vs. Dierssen's measured 0.18: we are **5.0× too bright**

Even the most charitable reading has us above the brightest fresh foam anyone has
measured. **A defensible target is 0.5–0.6 linear luminance** — i.e. Whitlock's
fresh foam — for the *active breaking* channel, dropping toward 0.1–0.2 for the
*residue*. Which brings us to §9, because the literature says these two should
not share a colour at all.

sRGB hex for linear luminance ≈ 0.55 holding our current hue: `#b9c8c0`
(I computed this to 0.554 [INFERRED]; it should still be eyeballed in-engine
rather than pasted in on my say-so).

---

## 9. Foam lifetime — our two-clock split is right, and slightly fast

The literature's Stage A / Stage B split is exactly our breaking/residue split.

**Definitions** (Monahan & Lu 1990; quoted by Dierssen 2019 [REVIEW]):

- **Stage A** — *"actively breaking wave or bright white portion of the wave"*;
  the crest spills, traps air, entrains a dense bubble plume. Characteristic
  lifetime **O(1 s)**.
- **Stage B** — *"residual plume of foam and subsurface bubbles"*; the plume
  surfaces, spreads, and decays by bubble bursting. Lifetimes **up to tens of
  seconds**.

**Relative contribution.** Stage B contributes **1.5–40× more** to total coverage
than Stage A, because it lives so much longer [REVIEW, via search of Scanlon &
Ward 2013/2016; the JGR paper `10.1002/2015JC011230` is paywalled and Crossref
has no abstract deposited, so I could not verify this range at source — treat the
range as soft, the direction as solid].

**Hard decay numbers.** Callaghan et al. 2012, *"Observed variation in the decay
time of oceanic whitecap foam"*, JGR `10.1029/2012JC008147`. Body paywalled;
**the full abstract is deposited in Crossref and I read it verbatim**, so
[PRIMARY] for the following:

- 552 individual breaking waves, sub-cm pixels, 3–6 fps, Martha's Vineyard.
- *"Whitecap foam decay times for individual events varied between **0.2 s to
  10.4 s** across the entire data set."*
- *"the effective whitecap foam decay time, which we define as the area-weighted
  mean decay time, varied by a factor of 3.4 between **1.4 s and 4.8 s**."*
- Decay is approximately **exponential**; decay time correlates positively with
  patch area; variation attributed to surfactants and breaking-wave type.

Separately, Monahan et al. 1986's sea-spray source function uses a **constant
`tau = 3.53 s`** whitecap decay timescale [REVIEW, via Albert et al. 2016 who
reproduce the SSSF]. That sits neatly inside the 1.4–4.8 s effective range.

**Ours.** `decayHalfLife: 0.9` s and `breakingHalfLife: 0.15` s
(`src/params/foam.ts:384,386`) [OURS]. These are **half-lives**, not e-folding
times — `decayFactorPerFrame` is `2^(−dt/halfLife)` (`src/foam/foamMath.ts:15`).
The literature's decay times are e-folding times. Convert with
`tau = halfLife / ln2 = halfLife × 1.4427` [INFERRED]:

| Channel | Our half-life | Our tau | Literature | Verdict |
|---|---|---|---|---|
| breaking (Stage A) | 0.15 s | **0.216 s** | O(1 s); individual events from 0.2 s | at the extreme fast edge |
| residue (Stage B) | 0.9 s | **1.30 s** | effective 1.4–4.8 s; individuals to 10.4 s; M86 uses 3.53 s | just below the observed floor |

**Verdict: the two-clock architecture is validated, the constants are fast.** The
residue clock at tau = 1.30 s sits *below* the entire observed range of
area-weighted effective decay times. Moving `decayHalfLife` from 0.9 to
**1.0–2.4 s** puts tau in 1.4–3.5 s, i.e. inside the measured range, with
**1.6 s (tau = 2.3 s)** a reasonable centre. Note also that `foamMath.ts:354`
already carries a half-life ladder including `0.90 s (was)`, so this has been
tuned by eye before — the literature now gives a range to tune *within*.

Two further hooks the literature offers, neither required:

- **Bigger patches live longer.** Callaghan's positive correlation between decay
  time and maximum patch area is free-ish to approximate if foam value already
  correlates with patch size.
- **Stage A and Stage B are different colours,** not just different lifetimes —
  0.20–0.55 fading to 0.03–0.10 within ~10 s (§8). Our two channels are already
  separate, so giving them separate tints is a change of constants, not of
  architecture.

---

## 10. What the literature does not answer

Per §Rule 8, stated plainly rather than papered over:

1. **No usable steepness→coverage law exists.** Schwendeman shows mean square
   slope of the equilibrium range has the best statistics *among slope
   variables*, but neither he nor Brumer publishes it in a form you could drop
   into a shader as "coverage = f(mss)" with the confidence MOM80/CAL08 offer for
   wind. I looked; it is not there. Our Jacobian gate therefore cannot be
   *calibrated* against the literature, only *scaled* by a wind-driven target.
2. **The onset region is genuinely unconstrained.** Factor-60 disagreement
   between two respectable published laws at Beaufort 3 (§1.4). Nobody can tell
   you what 4 m/s should look like.
3. **Global mean coverage is inconsistently reported.** Albert et al. quote
   Blanchard 1963's *"estimated annual global average of whitecap cover… is
   3.4 %"*; Dierssen 2019 says *"relatively small across the global ocean
   (<1 %)"*. Both are open-access reviews and they disagree by ~4×. I did not
   resolve it. Irrelevant to us — we render sea states, not global means — but
   it is a fair sample of how loose this field's numbers are.
4. **Stage A vs. Stage B coverage split is soft.** The 1.5–40× range is from a
   search summary of a paywalled paper I could not open (§9). Direction is
   certain; magnitude is not.
5. **Reflectance ≠ albedo.** The 0.22 and 0.55 figures are remote-sensing
   reflectances. Mapping them onto a PBR diffuse albedo is my inference (§8), and
   a careful renderer person might land somewhere different. What is *not*
   arguable is that 0.905 is above every published number in the table.

---

## 11. Sources

Fetched and read directly (open access):

- Albert, Anguelova, Manders, Schaap & de Leeuw (2016), *Parameterization of
  oceanic whitecap fraction based on satellite observations*, Atmos. Chem. Phys.
  16, 13725–13751. https://acp.copernicus.org/articles/16/13725/2016/acp-16-13725-2016.pdf
  — MOM80 and CAL08 formulas, order-of-magnitude scatter, onset survey, `tau = 3.53 s`.
- Dierssen (2019), *Hyperspectral Measurements, Parameterizations, and
  Atmospheric Correction of Whitecaps and Foam…*, Front. Earth Sci. 7:14.
  https://www.frontiersin.org/journals/earth-science/articles/10.3389/feart.2019.00014/full
  — all albedo numbers, Stage A/B definitions, "several orders of magnitude".
- Hwang, Reul, Meissner & Yueh (2019), *Whitecap and Wind Stress Observations by
  Microwave Radiometers*, J. Phys. Oceanogr. 49, 2291–2307. Accepted manuscript:
  https://archimer.ifremer.fr/doc/00506/61757/65730.pdf — Eq. (9) threshold
  cubic in u*, u*↔U10 matching points.
- NOAA SPC Beaufort table. https://www.spc.noaa.gov/faq/tornado/beaufort.html
- NOAA NWS, *Estimating Wind Speed and Sea State with Visual Clues*.
  https://www.weather.gov/media/pqr/beaufort/beaufort.pdf
- Webb, *Introduction to Oceanography* §10.2, Waves at Sea.
  https://rwu.pressbooks.pub/webboceanography/chapter/10-2-waves-at-sea/

Abstract read verbatim via Crossref (publisher's deposited text); body paywalled:

- Schwendeman & Thomson (2015), *Observations of whitecap coverage and the
  relation to wind stress, wave slope, and turbulent dissipation*, JGR Oceans.
  doi:10.1002/2015JC011196 — mean square slope result, threshold power law.
- Brumer et al. (2017), *Whitecap Coverage Dependence on Wind and Wave Statistics
  as Observed during SO GasEx and HiWinGS*, J. Phys. Oceanogr. 47, 2211–2235.
  doi:10.1175/JPO-D-17-0005.1 — 10 % ceiling, Reynolds number vs. wave statistics.
- Callaghan, Deane & Stokes (2012), *Observed variation in the decay time of
  oceanic whitecap foam*, JGR Oceans. doi:10.1029/2012JC008147 — 0.2–10.4 s
  individual, 1.4–4.8 s effective.

Abstract public, body paywalled:

- Monahan & O'Muircheartaigh (1980), *Optimal Power-Law Description of Oceanic
  Whitecap Coverage Dependence on Wind Speed*, J. Phys. Oceanogr. 10, 2094–2099.
  https://journals.ametsoc.org/view/journals/phoc/10/12/1520-0485_1980_010_2094_opldoo_2_0_co_2.xml

Paywalled, cited only through the reviews above or through search summaries —
**do not attribute these to me as read**:

- Callaghan et al. (2008), GRL, doi:10.1029/2008GL036165 — wind history.
- Callaghan et al. (2008), JGR, doi:10.1029/2007JC004453 — swell-dominated seas.
- Anguelova & Webster (2006), JGR, doi:10.1029/2005JC003158 — >2 orders of magnitude.
- Scanlon & Ward (2016), JGR, doi:10.1002/2015JC011230 — Stage A/B environmental controls.
- Koepke (1984), Appl. Opt. 23(11):1816 — effective reflectance 0.22.
- Whitlock et al. (1982) — fresh foam 0.55.
- Monahan & Lu (1990) — Stage A/B nomenclature.
