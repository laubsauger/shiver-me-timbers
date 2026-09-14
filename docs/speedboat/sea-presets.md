# Speedboat sea presets: calm, working, open

Source: `src/params/speedboatSea.ts` (`SPEEDBOAT_SEAS`). Test: `tests/speedboatSeaPresets.test.ts`.

User, playtest and trailer review, 2026-09-14: "calibrate how hard a swell we present … the sea has wider intervals
between waves, more deep-ocean swell … in certain places maybe use lee". Later: waves in the breeze/swell shots "feel
like 5 m", with constant air, bow stuffing and green water.

## What was wrong

1. **The drawn and floated sea was √2 taller than its spectrum said, in every mode.** Every FFT mode is
   h0(k)e^{iωt} + conj(h0(−k))e^{−iωt}: two independent Gaussians land on one mode, so the field carried 2× the variance
   that every moment counts (ladder Hs labels, fold cap, foam σ, shoaling σ).
   - Measured on the CPU mirror (seeds 2100/7/188, 1 km²): swell-only spectrum Hs 1.18 → realised 1.69–1.73 m.
   - The race's old Working sea: 2.83 → 3.64–3.82 m.
   - Fixed at the root by `H0_AMPLITUDE_SCALE` = 1/√2 on h0 (`src/ocean/oceanMath.ts`); the user chose this, and pirate
     and raft seas are ~29 % calmer too. That sea now realises 2.58–2.71 m.
2. **The race's "Working sea" was the ladder's `swell` rung.** Most of it is an 11 m/s wind sea peaking at λ 95 m /
   T 7.8 s: short steep faces a 12 m hull meets about once a second at 30 m/s.
3. **The ladder's `calm` (swell bearing 0.62π) and `breeze` (1.15π) put the lee on the wrong water.** Tower Reach's
   sheltered sectors were drawn on 1.68π. On `calm` the start straight sat in open swell (K 1.00) and the exposed Stuff
   Run gates were sheltered (K 0.30–0.35).
4. **The swell-direction sign bug is closed.** It was fixed in 9ddbf7e and re-checked here: a 12 s swell pattern moves
   +40 m in 2 s along `+swellDirection` at 0, 0.62π and 1.68π (phase speed 18.7 m/s).

## The presets

Each preset is a weather rung, used for the sky (clouds, haze, storminess), plus five ocean spectrum keys through
`weather.apply(rung, { ocean })` (`weather/applyPreset.ts`, same lanes and same lerp). Choppiness and foam bias stay the
rung's. All three use swell bearing `SPEEDBOAT_SWELL_DIRECTION` = 1.68π.

| preset | sky rung | wind m/s | `amplitude` | swell T s (λ m) | `swellAmplitude` | realised Hs (3 seeds) | wind-sea peak λ | felt slope ≥ 12 m |
|---|---|---|---|---|---|---|---|---|
| `calm` | calm | 3 | 0.15 | 12 (225) | 0.04 | 0.16 m | 7 m | 0.1° |
| `working` (race default) | breeze | 4 | 0.12 | 10 (156) | 0.12 | 0.49–0.56 m | 13 m | 0.8° |
| `open` (jumps) | swell | 6.5 | 0.12 | 8 (100) | 0.36 | 1.44–1.60 m | 33 m | 2.6° |
| old Working sea (ladder `swell`, after the √2 fix) | swell | 11 | 0.24 | 11 (189) | 0.34 | 2.58–2.71 m | 95 m | 5.2° |

"Felt slope" is the RMS slope of waves at least 12 m long. A 12 m hull rides those waves; shorter ones it bridges.

`open` is shorter-period on purpose. A 13 s swell at Hs 0.8–1.2 m never launched her (0 % airborne at 80 kn). "Wide
intervals" is `working`'s job.

## How she rides them

Setup: headless, the page's player step, no assists, no wake field, 60 s after a 15 s run-up, seed 2100 unless noted.
Harness: `scratchpad/sk/phys/sea.test.ts` (env `PRESET KN HEAD HEADREF OCEAN SECS SEED`). Heading is relative to the
swell. "Bow under" = the stem deck point below the local pressure head.

| sea | 60 / 80 kn | airborne | bow under | pitch std | heave std (CG vs surface) | vertical accel p50 / p95 |
|---|---|---|---|---|---|---|
| `working` | head, follow | 0 % | 0 | 0.47–0.62° | 0.03 m | 0.10–0.16 / 0.29–0.43 g |
| `open` | head | 4.0 / 4.8 % (seed 7: 3.4 / 4.6 %) | 0 | 2.8° | 0.28–0.32 m | 0.55–0.57 / 1.1 g |
| `open` | beam | 2.4 / 4.0 % | 0 | 1.2–1.3° | 0.17–0.18 m | 0.6 / 1.3–1.5 g |
| `open` | follow | 0 % | 0 | 2.1° | 0.14–0.16 m | 0.3 / 0.8 g |
| old Working sea, before the √2 fix | 50 kn head / follow | 12 % / 41–49 % | 5–20 % / 0–5 % | 8.4–11.3° / – | – | capsized on some seeds |
| old Working sea, after the √2 fix | 50 kn head / follow | 14.7 % / 6.1 % | 3.5 % / 1.7 % | 4.6° / 4.0° | 0.56 / 0.44 m | 0.73 / 1.52 g |

The physics itself was measured and left alone, because no change was justified:
- Flat-water natural periods, heave / pitch / roll: 2.33 / 2.42 / 3.42 s, with ζ 0.32 / 0.30 / 0.03.
- Mass 5351 kg. Gyradii: pitch 0.260 L, roll 0.359 B. The outboards' lever arm is included in the pitch inertia (about
  19.5 of 52 t·m²).
- Added mass at rest: heave 3.55 m, pitch 2.75 I.
- Flat-water landings from 1–2.5 m at 15–25 m/s rebound 0.10–0.14, with no second flight.
- None of these reduced stuffing, and several made it worse: +8° flare in the proxy, 0.45 m sheer spring, added mass
  ×1.5, relative water velocity off, transom wake off.
- In the old sea, the stuffing, the airtime and the chatter (angular-rate energy above 2 Hz: 14–23 % running downwind)
  came from the short, steep wind sea.

## Lee (swell shadow K at the gates, mean of mid/left/right)

| sea | S | G1 | G2 | G3 | G4 | G5 | G6 | G7 | G8 |
|---|---|---|---|---|---|---|---|---|---|
| reference (T 11) | 0.12 | 0.94 | 1.00 | 1.00 | 1.00 | 0.38 | 0.29 | 0.23 | 0.11 |
| T 12 (`calm`) | 0.14 | 0.93 | 1.00 | 1.00 | 1.00 | 0.39 | 0.32 | 0.23 | 0.12 |
| T 10 (`working`) | 0.10 | 0.95 | 1.00 | 1.00 | 1.00 | 0.37 | 0.27 | 0.24 | 0.09 |
| T 8 (`open`) | 0.06 | 0.97 | 1.00 | 1.00 | 1.00 | 0.35 | 0.22 | 0.26 | 0.08 |
| ladder `calm` (0.62π) | 1.00 | 1.00 | 0.74 | 0.30 | 0.35 | 0.53 | 0.76 | 0.99 | 1.00 |

The start straight and G5–G8 are sheltered; G1–G4 are open swell. Only the swell train is shadowed (cascade 0), so the
lee keeps its light wind ripple. `oceanParams.swellShadowStrength` stays at 1, the physical model: the lees already sit
at K 0.06–0.4.

## Where they are used

- **Race / free roam boat select.** `Calm` → `calm`, `Working sea` → `working` (default), `Open swell` → `open`,
  `Squall` → the ladder's `squall` rung, unchanged (`speedboat/page/raceSettings.ts SEA_PRESET`, `seaApplyArgs`).
  `Breeze` was removed; a stored `Breeze` selection falls back to the default.
- **Trailer** (cine `WorldPatch`): `{ weather: SPEEDBOAT_SEAS.open.weather, ocean: { ...SPEEDBOAT_SEAS.open.ocean } }`,
  and the same shape for the other two.

## Knobs

| key | what it does to the ride |
|---|---|
| `swellAmplitude` | RMS swell height in metres (swell Hs ≈ 4×; realised equals spectrum since the √2 fix). Adds size; slope is k·a. |
| `swellPeriod` | Wavelength λ = gT²/2π. Longer means wider crest spacing and a lower slope at the same height. It diffracts further into a lee (the start's K goes 0.06 → 0.14 from T 8 → 12). Below ~9 s at Hs ≥ 1.4 m she starts to launch. |
| `windSpeed` | Moves the wind-sea peak (λ ∝ U²). This is the knob that makes short steep chop. Keep it ≤ 7 m/s. |
| `amplitude` | Wind-sea energy at a given wind. |
| `swellDirection` | Keep 1.68π on Tower Reach, or the lee moves off the course's sheltered sectors. |
| `swellShadowStrength` | Scales the lee (0 = none, 1 = physical). |
