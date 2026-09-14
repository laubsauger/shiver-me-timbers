# Speedboat engine and hull audio (§T.183, S3)

Status: built, node-tested, and the worklet was checked in the browser on the harness. It is **not wired into `speedboat.html` yet**, because the page belongs to T181. The swap is one line, shown under [Wiring](#wiring-for-the-page-t181).

This file covers engine and hull audio, plus the race radio bus (below). Race-control speech is not voiced.

## What it is

- **Synthesis only.** No recordings are used, so `assets/audio/boat/` does not exist. See [Samples](#samples) for why.
- **One AudioWorkletNode holds all DSP and every rpm model.**
  - The DSP core `src/audio/boat/synthCore.ts` has no worklet globals.
  - Node tests render through the same object, so the offline WAVs are the same samples the browser computes.
  - The one exception is the WebAudio post-chain (delay, pan), which the tests emulate.
- **Pitch comes from engine rpm only (V112).**
  - Speed never sets a pitch.
  - Speed does drive the gains and cutoffs of the water layer, and the crossfade between underwater and in-air exhaust.

| File | Role |
|---|---|
| `engineModel.ts` | **The V77 seam.** The only import point for engine models; adapts `sea-physics/engine.ts` (V8) and `rpmModel` (other kinds) |
| `rpmModel.ts` | Temporary model for turbine, two-stroke and electric (its V8 spec is no longer used by the voices) |
| `dsp.ts` | Noise, one-pole, TPT state-variable filter, waveguide, pulse table, sine table |
| `voices.ts` | V8 / two-stroke / turbine / electric engine voices and the water layer |
| `synthCore.ts` | Boats (rpm models) and slots (voices); ramp schedule, events, NaN guards, rpm report |
| `protocol.ts` | Packed message layout shared by the page side and the worklet, plus the muffling law |
| `boatAudio.worklet.ts` | AudioWorkletProcessor shell, loaded via Vite `?worker&url` (`workletUrl.ts`) |
| `mixMath.ts` | Telemetry type, §V96 distance law, air absorption, doppler track, ramp clock, voice stealing, slam/landing detection |
| `boatAudio.ts` | `createBoatAudio(engine)`: node graph and per-frame `update(frames, dt, camera)` |
| `pageSink.ts` | `createSpeedboatAudioSink(...)`: adapter onto the page's `BoatAudioSink` seam |
| `params.ts` | `registerParams('boatAudio', …)`; voice tunables are forwarded to the worklet when they change |
| `harness.ts`, `/speedboat-audio-harness.html` | Listening harness |

## RPM model (`rpmModel.ts`)

The model is the tech-research §3.1 law. It runs in the worklet at control rate (32 samples, about 0.67 ms), sub-stepped at 0.5 ms or less.

```
I·dω/dt = Q_curve(rpm)·max(throttle_lag^1.6, idle_air)·fuel − Q_friction(rpm) − Q_prop/gear
Q_prop  = k·(n² − (V_a/(J0'·D))²)·(0.12 + 0.88·s)        n = prop rps, V_a = driveAdvance, s = driveImmersion
```

**Calibration.** `k` is solved from each archetype's design point: full throttle at `calSpeed`, `calRpm`, `calSlip` and `calImmersion`. The planing rpm is a result of the torque balance, not a lookup table.

The following behaviours emerge from the model with no special-casing:

- **Airborne.** The prop keeps 12% of its torque, so rpm flares to the limiter.
- **Hard limiter.** Fuel is cut until rpm falls 320 rpm and at least two engine cycles have passed. That cut is the bounce.
- **Re-entry.** The prop bites again and rpm bogs.
- **Lift at speed.** The water windmills the prop, holding rpm far above idle, and the overrun fuel cut is on. The voice pops during it.
- **Governor.** In `'air'` mode the airborne limit drops to 5400 rpm and it bounces there. `'full'` also eases the throttle near the limit while wet.
- **Detuning.** Each of the three engines gets ±0.4% on its calibration rpm and ±1.5% on idle, which produces physical beating.

Measured values (`tests/boatAudioModel.test.ts`):

| Behaviour | V8 |
|---|---|
| Idle | 615 rpm |
| Hole shot | 3280 rpm |
| 20 m/s, full throttle | 4270 rpm |
| 41 m/s, s = 0.85 | 6300 rpm, 10% slip |
| Lift at 41 m/s | windmills at 5140 rpm |
| Airborne | limiter reached in < 0.35 s; bounce period ~60 ms (≈16 Hz) |

### Engine-model seam (V77, §T.189): V8 now runs the sim engine

The seam is `src/audio/boat/engineModel.ts`. It is the only boat-audio module that imports an engine model, and `tests/boatAudioGraph.test.ts` enforces that. `src/sea-physics/engine.ts` did not match the audio interface one-for-one, so the seam **adapts** it instead of re-exporting:

- **V8 uses `sea-physics/engine.ts`.** The spec is `MERCURY_450R` (1.60:1 gear, surface-piercing prop). The adapter's local integration is step-for-step identical to the physics `stepEngine` (tested).
- **Turbine, two-stroke and electric still use `./rpmModel`.** engine.ts has no specs for them yet. When it does, move each kind in `ENGINE_SPECS` over; nothing else in audio changes.
- **Sim-published rpm wins.** When `hullWater.driveRpm` is passed per drive as `telemetry.rpm`, the adapter follows it with a 20 ms de-zipper, which is sound-only. The physics limiter and overrun logic then runs on the sim's rpm, using engine.ts's own thresholds, and those flags drive the pops.
- **Without sim rpm** (NPCs on the worker path, the harness), the same physics ODE integrates locally from drive advance and immersion.
- **Governor.** Physics takes a cap (`rpmLimit`). Audio's `GovernorMode` is mapped to that cap (5400 rpm when the props are out) only when audio integrates locally.
- **Neutral.** Throttle exactly 0 maps to `neutral`, matching the hull.
- **Sound-only fields** the physics does not own are derived in the adapter from its limiter and overrun transitions and its lagged throttle: `load`, `bark`, `refireCount`, `overrunTime`, `limiterActivity`. They shape loudness and pops, never rpm.
- **Sound-only detune.** A sim running three identical drives publishes identical rpm. On the override path, the voices get a perceptual ±0.25% per engine so the triple still beats. On the local path the per-engine specs are detuned instead (idle ±1.5%, limiter ±25 rpm).

Measured with the physics V8 through the seam:

| Behaviour | V8 (physics) |
|---|---|
| Idle | 648 rpm |
| Hole shot | 5910 rpm (the surface-piercing prop ventilates) |
| 20 m/s, full throttle | 5026 rpm |
| 38 m/s (calibration speed) | 6100 rpm |
| Airborne | 97% of the limiter in 19 ms; bounce ~80 ms |
| Governor 'air' peak | 5416 rpm |

The `rpmModel` numbers above now apply only to the turbine, two-stroke and electric kinds.

## Voices (`voices.ts`)

### V8 (cross-plane)

- **Crank and pulses.**
  - The crank phase fires cylinders in the order 1-8-4-3-6-5-7-2.
  - Each firing emits an exhaust pulse `v·e^(1−v)`. The blowdown front takes about 1.5 ms at idle and under 1 ms on load.
  - Turbulence noise rides under each pulse.
  - Each cylinder has its own gain and timing signature.
  - At idle, cam lope adds per-cycle amplitude variance, timing jitter and rpm wobble.
- **Exhaust pipes and body.**
  - Odd cylinders go to the left bank (0.85 m pipe waveguide), even cylinders to the right bank (1.15 m).
  - The uneven L R R L R L L R bank sequence is what puts energy at the half orders. That is the lump.
  - The banks merge into a 92 Hz body resonance and a 420 Hz midsection resonance, then a load-dependent soft clip.
- **Exhaust exit.**
  - In air: a lowpass that opens with load and rpm (the bark), up to about 4.6 kHz at WOT (T204; it was 5.8 kHz).
  - Underwater at idle through the hub: a ~300 Hz lowpass with bubble amplitude modulation, a low-Q hull gulp (140–340 Hz, Q 2.2), and idle-relief rasp.
- **Idle character (T206).** All of it scales with the existing lope weight (fades by 2400 rpm and with load; cruise/WOT renders are sample-identical to before):
  - A repeating per-cylinder charge (0.35–1.65) and spark-point (±1.6 % of a cycle) signature, plus a ±30 % per-cycle swing. The old ±50 % per-firing white variance became ±25 %.
  - Fatter blowdown at idle (peak ×1.9, ~3 ms): a whump, not a click. The level is compensated, so idle stays at its T183 level.
  - A trace of valvetrain tick (2.1 kHz band, 0.6 ms per firing), idle only.
  - Sim-rpm path: the triple's sound-only detune widens to ±1.15 % below 900 rpm (±0.25 % from 2000), so it beats like the local path's ±1.5 % idle spec.
- **Pops.** Overrun, limiter and re-fire bursts are injected into the pipe, so they ring like the exhaust. The re-fire after a cut is a single bang.
- **Extras.**
  - Lower-unit gear whine at 14× crank.
  - An explicit loudness law, because pulse energy scales with 1/rpm while pulse rate scales with rpm. Measured: idle −33 dBFS, cruise −28, WOT −15.
- **Three engines** use unequal weights (1.12 / 0.95 / 0.8), so they beat without cancelling out.

### Other voices

- **Two-stroke triple ("Flat Jack").**
  - Fires 3 times per revolution into an expansion chamber (positive reflection), then a nasal 1 kHz band.
  - At light load it skips firings irregularly, which gives the ring-ding character, with a 2.65 kHz ringing (Q 12; Q 28 read as a steady tone at idle, T204).
  - Pops and muffling behave the same as the V8.
- **Turbine ("Shine").**
  - The gas generator spools behind the lever (τ 1.3 s up, 0.9 s down).
  - Blade-pass whine (9 blades on a 22 000 rpm gas generator, so 2.2 kHz at idle to 3.3 kHz at full spool) with shaft sidebands. The idle whine is a trace that comes up with spool². T204: the old 11 blades × 41 000 rpm put a constant 4.9 kHz tone (+9.8 kHz) on the idling grid, which was the shrill tone in boat select.
  - Combustor roar opens with spool, plus an exhaust rumble and a power-turbine tone.
  - The limiter is soft; there is no bounce.
- **Electric ("Spark").**
  - PMSM whine at 6×, 12× and 24× f_e (4 pole pairs); the 12× and 24× partials sit well under the fundamental (T204).
  - Inverter carrier: synchronous PWM ratios 45 / 27 / 15 / 9 below f_e = 200 Hz, so it audibly steps like a singing inverter; asynchronous 4.5 kHz above that.
  - Sidebands at the carrier ± 2 f_e, plus gear whine and fan noise. The carrier and fan were cut about 10 dB in T204 (they stood 8 dB under the whine at cruise).

### Water layer

- **Planing hiss:** band-pass noise whose centre rises with speed (1 → 3.6 kHz at `speedRef`; T204 lowered it from 5 kHz). Gain scales with wetted^0.6 × speed².
- **Water rush** and **prop-wash spray roar:** the roar scales with Σ|thrust| × speed and gets louder as the prop surfaces.
- **Ventilation churn (T205):** a hollow low-Q band (Q 2.2) on blade rate (5 blades, from the ventilating drives' rpm) plus a lowpassed whoosh at 2.5× blade rate, chopped ±25% at blade rate, then a 1.6 kHz one-pole. Tunable: `howlGain`.
  - **Level is per drive, beyond normal running.** `ventilationWeight(s)` is ~0 in the T196 surfaced band (0.02 at s = 0.65), full by s = 0.15, and 20% for a prop in clear air. The layer takes the mean over drives.
  - **Slow.** Attack 200 ms, release 350 ms; the pitch follows rpm with τ 150 ms, so a limiter bounce does not warble it.
  - **Why it changed.** The old layer was two resonant noise bands at 3× and 5× blade rate (Q 14/18, peak gain ~50) plus a 2× sine, on mean immersion with a 26 ms lag, pitched on engine 0's raw rpm. That put 87% of the water energy in 600–1500 Hz whistles, which warbled with the limiter bounce.
  - **Measured** (planing 38 m/s, WOT, 3 drives; `ventilation states` WAV render; water layer vs the engine bed):

    | State | Water before | Water after | Mix before → after | Water energy 600–1500 Hz |
    |---|---|---|---|---|
    | All props at 1.0 | −12.1 dB | −12.1 dB | −14.0 → −14.1 dBFS | unchanged |
    | All at 0.65 (normal) | **−1.1 dB** | −13.1 dB | −11.6 → −13.9 dBFS | 85% → 5% |
    | One prop at 0.2 | **+6.4 dB** | −3.7 dB | −8.3 → −14.3 dBFS | 86% → 14% (77% now < 600 Hz) |
    | All airborne | **+6.1 dB** | −2.5 dB | −14.8 → −19.8 dBFS | 87% → 17% |

  - **Still in the physics.** A drive at s = 0.2 bounces its limiter (6340–6785 rpm). The engine voice follows that bounce; its layer stays dark (0.8% of energy above 3 kHz).
- **Events (T206):** every hit is a transient (noise under a 1.8–3.4 kHz lowpass, 2.5 ms) plus a noise-excited hull body (two low-Q modes) plus droplet grains (1–5 ms noise grains, each a random pitch in a band that brightens with the impulse, under a 4.2 kHz ceiling). Each hit draws its own body tuning (±14 %), decay and spray colour from the layer's seeded noise.
  - Chop slap: body 270 / 560 Hz, ~35 ms; spray ~90 ms.
  - Landing: body 165 / 360 Hz, ~100 ms; a noise sub (band-pass sliding 105 → 48 Hz, not a sine); spray tail ~0.45 s.
  - Wake crossing: two slaps 0.16 s apart.
  - **Why it changed** (playtest: landings "boomy, sine-wavy", slaps "white-noisy, too high"). Measured on the still-water event render (window of 0.34 s):

    | | Before | After |
    |---|---|---|
    | Slap 0.3: energy above 8 kHz / centroid | 62 % / 11.2 kHz | 0.4 % / 0.9 kHz |
    | Landing 1.0: energy under 120 Hz / 150–600 Hz | 93 % / 1.3 % | 18 % / 45 % |
    | Landing 1.0: share in its 3 strongest bins | 42 % (the sine) | 7 % |
    | Landing tail above 8 kHz | 5 % | 0.3 % |
    | A-weighted level, slaps / landings | reference | −2…−6 dB / −3…−4 dB |

- **Idle (T206)**, 648 rpm sim rpm, triple, at the dock: power centroid 151 → 98 Hz; 400–1500 Hz 1.9 → 0.2 %; 150–400 Hz 37 → 12 %; half-order/firing energy on one engine 0.33 → 0.75; RMS held (−35.9 → −35.7 dBFS). There is no narrow tone above 1.5 kHz in any voice at idle. The turbine's idle blade-pass trace dropped from 0.012 to 0.004: at 2.06 kHz it stood 18 dB out of the idle roar.

## Graph and node budget (`boatAudio.ts`)

```
AudioWorkletNode 'boat-audio' (9 mono outputs)
  out 0 player engines → Panner HRTF ─────────────────────────────┐
  out 1 player water   → Panner HRTF ─────────────────────────────┤
  out 2..8 NPC slot    → DelayNode (doppler) → Gain (steal) → Panner equalpower ─┤
                                                     bus Gain → DynamicsCompressor → engine sfx bus
```

- **26 nodes**, regardless of boat count (budget ≤ 50). There are 2 HRTF panners.
- The test counts through `createBoatAudio` on a mock context with 8 boats and with 12.
- **Tiers.** The 7 NPC slots take the 7 most audible rivals (distance gain × activity). The top 3 get full voices; the rest get a cheap voice (one engine, no pops, whine or events). Both assignments use 1.26× (2 dB) hysteresis, and tier changes crossfade over 80 ms.
- **Steal sequence.** Fade 40 ms, then switch the boat and set the delay instantly, then wait out the new boat's propagation delay, then play. Without the wait, the DelayNode would replay the previous boat.

**Cine SFX stems.** `boatAudio.stemTaps()` (also the sink's `stemTaps()`, which `src/speedboat/cine/host.ts` reads as `audio.stemTaps`) returns `{ engine: AudioNode[]; water: AudioNode[] } | null`. Connect every node of a stem into the recorder; never reroute them. The result is null until the worklet graph exists, and the nodes are built on the first call.
- `engine` is the player-engine panner, the 7 NPC panners, and a Gain(−1) fed by the NPC water mirrors. `water` is the player-water panner and the 7 NPC water mirrors.
- The worklet grows 7 water-only outputs (`STEM_WATER_OUTPUT0`), rendered only after `{ t: 'stems', on: true }`. Each mirror (Delay → Gain → Panner) receives the same doppler, steal and position automation as its NPC slot chain.
- The taps sit post-voice and pre-bus/compressor. They add 22 nodes, for 48 in total.
- Tested: the slot outputs are bit-identical with stems on and match the pre-stem code; mix − water stem equals the engine layer to within 1e-5.

**Panners set direction only** (`linear`, rolloff 0). Distance gain and air absorption are applied in the worklet. `emitters.createPanner` and `setPannerPosition` are not used, because they re-apply the shared inverse/350 m model every frame. If a shared "direction-only panner" helper is wanted under §V95, it belongs in `src/audio/emitters.ts`, which this task does not own.

**CPU.** Eight boats (player plus 3 full and 4 cheap NPCs) cost 16–31% of one core in node, depending on machine load. The browser audio thread is not profiled yet.

## §V96: distance law measured against race distances

The shared emitter model (ref 10 m, rolloff 1.1, max 350 m, inverse) goes flat at 350 m. The boat law is `(unityDistance / max(ref, d))^rolloff` with ref 1 m, unity 8 m (chase camera) and rolloff 1, with no clamp. Air absorption is a one-pole at the ISO 9613-1 3 dB frequency, α(f) = 3.7·(f/1 kHz)^1.65 dB/km.

| d (m) | 3 | 8 | 25 | 100 | 350 | 500 | 1000 | 1500 |
|---|---|---|---|---|---|---|---|---|
| shared model (dB) | 0 | 0 | −8.5 | −20.7 | −31.7 | **−31.7** | **−31.7** | **−31.7** |
| boat law (dB) | +8.5 | 0 | −9.9 | −21.9 | −32.8 | −35.9 | −41.9 | −45.5 |
| air cutoff (Hz) | 18k | 16.4k | 8.2k | 3.6k | 1.7k | 1.3k | 880 | 690 |

The +8.5 dB at 3 m is the cockpit camera. The bus compressor holds it.

## Doppler

- **Delay law.** The delay is `τ = d/(c + ḋ)`, the retarded distance for a moving source.
  - A plain `d/c` gives the moving-listener ratio instead: ×1.117 / ×0.883.
  - `τ` is smoothed by two ramp-invariant one-poles (τ 50 ms total).
  - It is scheduled as `linearRampToValueAtTime` at render-dt spacing (`RampClock`).
- **Measured (40 m/s pass-by at 15 m offset).**
  - Frames had ±30% dt jitter and the audio clock was quantised to 128 samples.
  - Result: **×1.1322 approaching and ×0.8957 receding** (spec ×1.132 / ×0.896 ±2%).
  - Pitch wobble during the approach stays under 0.5%.
  - A zero-order-hold smoother gave 3.3% wobble and was replaced.
- **Player voices** have no delay. The chase camera travels with the boat.

## Wiring for the page (T181)

`src/main-speedboat.ts`: replace the stub line

```ts
const audio = createSilentAudio(); // §T.183
```

with

```ts
const audio = createSpeedboatAudioSink({ camera: app.camera, npcs: npcs, settings }); // §T.183
```

and add the import

```ts
import { createSpeedboatAudioSink } from './audio/boat/pageSink';
```

- `installAudioUnlock(audio)` and `audio.update(audioFrame)` stay as they are.
- `npcs` is the `NpcFleet` returned by `createNpcFleetDriver`, which structurally matches `NpcSourceLike` (`boats`, `pose(i)`).
- `settings` is optional. It can be any `{ get(), subscribe() }` store carrying `audio` volumes.
- Pass `playerVoice: 'v8'` and `npcVoices` to override the defaults, `npcThrottle: (i) => …` once the race AI exposes throttle, and `npcContact: (i) => ({ wettedArea, slamImpulse, propImmersion })` once the fleet exposes contact.

For a page that does not use the seam, call `createBoatAudio` directly:

```ts
import { createEngine, attachGestureResume } from './audio/engine';
import { createBoatAudio, type BoatFrameTelemetry } from './audio/boat/boatAudio';
const engine = createEngine(); attachGestureResume(engine);
const boatAudio = createBoatAudio(engine);
// every render frame, after the camera is placed:
boatAudio.update(frames /* BoatFrameTelemetry[] */, frameDt, app.camera);
```

`BoatFrameTelemetry` (in `mixMath.ts`) has these fields: `id`, `isPlayer`, `voice`, `engines?`, `position`, `velocity`, `enginePosition?`, `throttle`, `governor?`, `driveAdvance?`, `driveImmersion?`, `driveThrust?`, `propImmersion?`, `wettedArea`, `slamImpulse`, `mass?`, `wakeCrossing?`, `rpm?`.

### Hooks the page and sim should add

None of these block the audio.

1. **`BoatAudioFrame.contact.driveAdvance` / `driveImmersion`.** Added to seams.ts as optional fields, and `pageSink` forwards them. The page still has to point them at `player.hw.driveAdvance` / `driveImmersion`; without them the rpm load uses ground speed and the scalar `propImmersion` for all three drives.
2. **`slamImpulse` should be summed over the ticks a frame covers.** The page currently overwrites it every tick, so on a frame that covers two ticks, the first tick's slam is lost. Change it to `c.slamImpulse += player.hw.slamImpulse` in the tick, and reset it to 0 after `audio.update`.
3. **NPC contact.** The sim-worker already writes `WETTED_AREA`, `SLAM_IMPULSE` and `PROP_IMMERSION` per boat, but `NpcFleet` does not expose them. Without them, NPC slaps and landings are silent and rival ventilation is fixed at 0.85 immersion.
4. **NPC throttle** from the race AI (T186). The default is 0.8.
5. **`Governor` mode.** `BoatAudioFrame.governor` is now in seams.ts and `pageSink` forwards it. The page still has to set it from the T182 assists.
6. **Wake crossing strength** from the wake system into `telemetry.wakeCrossing`. There is no source for it today.
7. **Engine cluster offset.** `engineOffsetZ` = −4.6 m from the CG is an estimate. Using the mean of `hw.driveProp` as `enginePosition` would be exact.
8. **`hw.driveRpm` into `BoatAudioFrame.contact.driveRpm`** (zero-copy, like `driveThrust`; seams.ts does not carry it yet). `pageSink` already forwards it as `telemetry.rpm` whenever it is present and non-zero; until then the player's rpm is integrated locally by the same physics model. NPCs need the worker to publish it too, via `npcContact(i).driveRpm`.

## Verification

- `npx vitest run tests/boatAudio`: 78 tests pass, and 7 WAV renders are skipped unless `BOAT_AUDIO_WAV_DIR` is set.
  - `boatAudioModel`: the seam (the V8 spec is the physics 450R; local integration identical to physics; limiter cuts and re-fires; sim rpm wins with limiter flags from it; overrun silences combustion); legacy model: planing slip 5–20% for all 4 archetypes; rpm rises with advance and with ventilation; throttle lag; airborne reaches the limiter in < 0.35 s without overshoot; bounce period 40–250 ms; Governor 'air'; bog on re-entry; overrun windmill; NaN and extreme inputs; override; determinism.
  - `boatAudioMix`: §V96 plateau measured vs. monotonic boat law; air absorption; doppler ratios and zipper; steal sequence; tier hysteresis; landing and slam detection; muffling; packing sanitisation.
  - `boatAudioSynth`: V8 firing line at rpm·8/120 ±3% at 900/2500/4500/6300 rpm; two-stroke at rpm·3/60; inverter at 6 f_e; identical pitch at 0 and 40 m/s; half-order energy (lump); underwater exhaust darker; limiter bounce visible in the envelope spectrum (4–25 Hz); three-engine beating; T206 dark lumpy idle (centroid, no 400–1500 Hz ring, warm 150–400 Hz, half orders ≥ 0.55) and no narrow tone above 1.5 kHz at idle in any voice; T206 landing is a hull hit (body over sub, no dominant bin, tail under 8 kHz) and slaps are dark, short and lighter; hiss grows with speed; ramp schedule; bit-identical renders; finite output on garbage input; CPU.
  - `boatAudioGraph`: ≤ 50 nodes and ≤ 2 HRTF with 8 and 12 boats; the graph does not grow; 7 slots with 3 full voices; §V109 walk; the worklet bundle stays inside `src/audio/boat`; engine-model seam; seam adapter; V112 phase scan.
- **Browser** (Chrome, Vite dev on :5247, COOP/COEP):
  - `crossOriginIsolated` true; the worklet loads through `?worker&url`; the console shows only Vite's connect messages.
  - 26 nodes; with 12 boats, 7 slots and 3 full voices.
  - Airborne telemetry reports limiter cuts at 6450–6570 rpm; output on the sfx bus is non-silent.
  - The automation tab is hidden, so rAF never ticks. `update` was driven from the console instead, and the harness readout itself could not be watched.
- **Listening WAVs.** Regenerate with `BOAT_AUDIO_WAV_DIR=<dir> npx vitest run tests/boatAudioSynth.test.ts`. The renders are 48 kHz 16-bit with a tanh standing in for the bus compressor.
  - `01-v8-idle-burble`
  - `02-v8-holeshot-planing-lift`
  - `03-v8-airborne-overrev-landing`
  - `04-v8-limiter-bounce-then-governor-air`
  - `05..08-npc-{v8,turbine,twostroke,electric}-flyby-40ms-15m` (stereo, emulated delay and equalpower pan)
  - `09-v8-wake-crossing-and-chop`
  - `vent-{planing-imm100,surfaced-imm065,one-prop-lifted-imm020,airborne}` (T205; logs level, band shares and rpm; `BOAT_AUDIO_VENT_PROBE=howlGain` renders with that tunable at 0)

## Samples

None are used. Adding rpm-indexed loops (tech-research §6.3 layer 1) needs steady-rpm, on-load and off-load recordings of a marine V8 outboard, pitch-tracked. No CC0 set is known to exist, and no search for one was run in this task.

The hybrid path is ready if one turns up: a sample layer would mix into each slot inside the worklet, or as `layer.ts` loops per slot. The budget has 24 nodes spare.

## Honest assessment

Nobody has listened to these renders yet. They were judged from spectrograms, levels and the tests.

**What the analysis supports:**

- Clearly pitched harmonic stacks that track rpm.
- A grouped, uneven idle waveform (lumpy).
- Beating between the three engines.
- A hollow ventilation churn (under 1.6 kHz) when a prop lifts (T205; it was a bright howl band).
- Visible limiter chop, and the Governor's lower band.
- Doppler bends on the flybys.
- Roughly 18 dB between idle and WOT.

**Risks to listen for:**

- The fixed pipe resonances (~90 / 300–450 Hz) may read as a "formant" that stays put while rpm moves.
- Beating may still be too deep at steady WOT.
- The turbine and electric voices are simple additive designs and may sound synthetic.
- Water hiss and spray are filtered noise.

**Tuning.** All levels are in the `boatAudio` params panel.

## Race radio bus (§T.197)

- **What is audible.** Race control's calls are text on the HUD strip (`page/raceRadio.ts`). Each new line plays a VHF squelch burst: 0.14 s of deterministic noise through a 1.8 kHz bandpass. No speech is synthesised.
- **The bus.** `src/audio/boat/radioBus.ts` `createRadioBus(engine)` routes source → envelope → shared bandpass → radio bus gain → destination. The graph is built lazily once the context runs. It has 3 persistent nodes plus 2 per burst, and the per-burst nodes are released on `ended`.
- **Level.** The level is `radioBusLevel(master, radio)`, the pause screen's Master × Race radio (`raceSettings.radioLevel`). `audio/engine.ts` does not expose its master gain, so master is folded in by the caller. Engines stay on the sfx bus, so Radio at 0 leaves them audible.
- **Page wiring.** The sink exposes `radio`. `createRaceUi({ audio: { setVolume, radioCall } })` calls `radioCall` once per new radio line with text.
- **Persistence.** `audio.radio` is stored in `speedboat.settings.v1` (default 0.7). A record without the field loads with the default.
- **Tests.** `tests/boatAudioRadio.test.ts`.
