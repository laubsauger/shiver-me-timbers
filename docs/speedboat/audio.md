# Speedboat engine and hull audio (§T.183, S3)

Status: built, node-tested, and the worklet was checked in the browser on the harness. It is **not wired into `speedboat.html` yet**, because the page belongs to T181. The swap is one line, shown under [Wiring](#wiring-for-the-page-t181).

This file covers engine and hull audio only. Race-control radio is a separate task.

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
| `engineModel.ts` | **The V77 seam.** The only import point for the engine model; re-exports `rpmModel` until `sea-physics/engine.ts` lands |
| `rpmModel.ts` | Temporary adapter: pure crank + propeller ODE per engine, plus archetype specs (V8, turbine, two-stroke, electric) |
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

### Engine-model seam (V77, §T.189)

Thrust, the Governor assist and audio must read one rpm. The physics agent (T189) is building that model in `src/sea-physics/engine.ts`, using `rpmModel.ts` as a starting reference.

- **The seam is `src/audio/boat/engineModel.ts`.** Every boat-audio module imports the engine model through it, and `tests/boatAudioGraph.test.ts` enforces that. Today it re-exports `./rpmModel`, which is a temporary adapter.
- **The switch is one line** in that file: `from './rpmModel'` becomes `from '../../sea-physics/engine'`. It compiles unchanged if engine.ts exports `VoiceKind`, `GovernorMode`, `EngineSpec`, `EngineState`, `EngineInput`, `VOICE_KINDS`, `ENGINE_SPECS`, `createEngineState` and `stepEngine`, and provides the `EngineState` fields the voices read (listed in the file). The worklet bundle test already allows `sea-physics/engine.ts`.
- **Physical state goes in engine.ts:** limiter and fuel cut, overrun, spool, ventilation flare.
- **Sound-only behaviour stays in audio:** the 20 ms rpm de-zipper, pop timing, and cam-lope wobble.
- **Once the sim integrates rpm**, the page passes it per boat as `telemetry.rpm`. That override path is already wired: the worklet follows the sim's rpm instead of integrating its own, and only the fuel-cut and overrun state machine keeps running. For exact V77 parity, that state machine should then also come from the sim, as per-drive `fuelCut` / `overrun` telemetry. Those fields do not exist yet; this is hook 8.

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
  - In air: a lowpass that opens with load and rpm (the bark).
  - Underwater at idle through the hub: a ~300 Hz lowpass with bubble amplitude modulation, a re-pitched bubble resonator, and idle-relief rasp.
- **Pops.** Overrun, limiter and re-fire bursts are injected into the pipe, so they ring like the exhaust. The re-fire after a cut is a single bang.
- **Extras.**
  - Lower-unit gear whine at 14× crank.
  - An explicit loudness law, because pulse energy scales with 1/rpm while pulse rate scales with rpm. Measured: idle −33 dBFS, cruise −28, WOT −15.
- **Three engines** use unequal weights (1.12 / 0.95 / 0.8), so they beat without cancelling out.

### Other voices

- **Two-stroke triple ("Flat Jack").**
  - Fires 3 times per revolution into an expansion chamber (positive reflection), then a nasal 1 kHz band.
  - At light load it skips firings irregularly, which gives the ring-ding character, with a 2.65 kHz high-Q ringing.
  - Pops and muffling behave the same as the V8.
- **Turbine ("Shine").**
  - The gas generator spools behind the lever (τ 1.3 s up, 0.9 s down).
  - Blade-pass whine (11 blades) with shaft sidebands.
  - Combustor roar opens with spool, plus an exhaust rumble and a power-turbine tone.
  - The limiter is soft; there is no bounce.
- **Electric ("Spark").**
  - PMSM whine at 6×, 12× and 24× f_e (4 pole pairs).
  - Inverter carrier: synchronous PWM ratios 45 / 27 / 15 / 9 below f_e = 200 Hz, so it audibly steps like a singing inverter; asynchronous 4.5 kHz above that.
  - Sidebands at the carrier ± 2 f_e, plus gear whine and fan noise.

### Water layer

- **Planing hiss:** band-pass noise whose centre rises with speed. Gain scales with wetted^0.6 × speed².
- **Water rush** and **prop-wash spray roar:** the roar scales with Σ|thrust| × speed and gets louder as the prop surfaces.
- **Ventilation howl:** two resonant bands at 3× and 5× blade rate (4 blades from rpm) plus a 2× tone. It is gated on partial immersion and thins out when the prop is fully in air.
- **Events:**
  - Hull slap: 118 and 265 Hz body resonances plus a splash band.
  - Landing: a boom gliding from 112 Hz to 50 Hz, a low crash, and a 1 s spray tail.
  - Wake crossing: two slaps 0.16 s apart.

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

1. **`BoatAudioFrame.contact.driveAdvance` / `driveImmersion`.** Point them at `player.hw.driveAdvance` / `player.hw.driveImmersion` (zero-copy, like `driveThrust`). Without them the rpm load uses ground speed and the scalar `propImmersion` for all three drives, which loses per-drive ventilation.
2. **`slamImpulse` should be summed over the ticks a frame covers.** The page currently overwrites it every tick, so on a frame that covers two ticks, the first tick's slam is lost. Change it to `c.slamImpulse += player.hw.slamImpulse` in the tick, and reset it to 0 after `audio.update`.
3. **NPC contact.** The sim-worker already writes `WETTED_AREA`, `SLAM_IMPULSE` and `PROP_IMMERSION` per boat, but `NpcFleet` does not expose them. Without them, NPC slaps and landings are silent and rival ventilation is fixed at 0.85 immersion.
4. **NPC throttle** from the race AI (T186). The default is 0.8.
5. **`Governor` mode** from the assists (T182) into `telemetry.governor`. `pageSink` does not pass it yet because the seam frame lacks it.
6. **Wake crossing strength** from the wake system into `telemetry.wakeCrossing`. There is no source for it today.
7. **Engine cluster offset.** `engineOffsetZ` = −4.6 m from the CG is an estimate. Using the mean of `hw.driveProp` as `enginePosition` would be exact.
8. **Per-drive `fuelCut` / `overrun` flags** from `sea-physics/engine.ts`, once it lands. Audio currently re-derives them from its own copy of the limiter thresholds, even when the rpm is overridden.

## Verification

- `npx vitest run tests/boatAudio`: 58 tests pass, and 6 WAV renders are skipped unless `BOAT_AUDIO_WAV_DIR` is set.
  - `boatAudioModel`: planing slip 5–20% for all 4 archetypes; rpm rises with advance and with ventilation; throttle lag; airborne reaches the limiter in < 0.35 s without overshoot; bounce period 40–250 ms; Governor 'air'; bog on re-entry; overrun windmill; NaN and extreme inputs; override; determinism.
  - `boatAudioMix`: §V96 plateau measured vs. monotonic boat law; air absorption; doppler ratios and zipper; steal sequence; tier hysteresis; landing and slam detection; muffling; packing sanitisation.
  - `boatAudioSynth`: V8 firing line at rpm·8/120 ±3% at 900/2500/4500/6300 rpm; two-stroke at rpm·3/60; inverter at 6 f_e; identical pitch at 0 and 40 m/s; half-order energy (lump); underwater exhaust darker; limiter bounce visible in the envelope spectrum (4–25 Hz); three-engine beating; landing boom at 50–120 Hz; hiss grows with speed; ramp schedule; bit-identical renders; finite output on garbage input; CPU.
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

## Samples

None are used. Adding rpm-indexed loops (tech-research §6.3 layer 1) needs steady-rpm, on-load and off-load recordings of a marine V8 outboard, pitch-tracked. No CC0 set is known to exist, and no search for one was run in this task.

The hybrid path is ready if one turns up: a sample layer would mix into each slot inside the worklet, or as `layer.ts` loops per slot. The budget has 24 nodes spare.

## Honest assessment

Nobody has listened to these renders yet. They were judged from spectrograms, levels and the tests.

**What the analysis supports:**

- Clearly pitched harmonic stacks that track rpm.
- A grouped, uneven idle waveform (lumpy).
- Beating between the three engines.
- A bright howl band while airborne.
- Visible limiter chop, and the Governor's lower band.
- Doppler bends on the flybys.
- Roughly 18 dB between idle and WOT.

**Risks to listen for:**

- The fixed pipe resonances (~90 / 300–450 Hz) may read as a "formant" that stays put while rpm moves.
- Beating may still be too deep at steady WOT.
- The turbine and electric voices are simple additive designs and may sound synthetic.
- Water hiss and spray are filtered noise.

**Tuning.** All levels are in the `boatAudio` params panel.
