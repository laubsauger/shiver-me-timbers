# Speedboat controls, assists and cameras (§T.182 S2)

Status: built and tested headless, not yet swapped into the page, and nothing checked in a browser (§V22 is still open). Numbers come from the real `HullWater` + `rigid6` unless marked ASSUMED.

## Page wiring (T181 seams, `src/speedboat/page/seams.ts`)

`src/main-speedboat.ts` swaps two lines. Keep the current order: camera first, then controls.

```ts
import { createRaceCameraRig } from './camera/raceCam';
import { createRaceControls } from './speedboat/controls';

const camera = createRaceCameraRig(app.camera, { player }); // §T.182
const controls = createRaceControls({ player, camera, enabled: () => !camera.capturesInput() }); // §T.182
```

- `createRaceControls` → `ControlSource`. It runs in the fixed tick, before the player's physics step. Pipeline: devices → `BoatInput` → assists → the seam's `BoatControls`.
- The seam fields are filled like this:
  - `steer` = assisted drive angle ÷ `drives[0].maxSteerRad`. The page multiplies it back, so the drives get the assisted angle exactly. + is right, the same sense as `HullWater`: body −x is starboard.
  - `throttle` is the governed value, −0.3…1.
  - `trim` is the drive trim angle scaled to −1…1 over −6°…+8°.
  - `surge` is true when held or tapped.
- Extra members:
  - `input`: the raw `BoatInput`. The input log records this (§V2).
  - `command`: the drive command in radians.
  - `assist`: `lockRad`, `governor.rpm`, trim state.
  - `settings`: live assist dials.
  - `reset()`: call it on respawn (V108).
- `createRaceCameraRig` → `CameraRig`. The controls call `pilotInput(input, slamΔv)` every tick, which carries look back, camera presses (latched until the next frame) and the slam. `cam` is the `RaceCam`, for:
  - the crash owner: `beginCrash(point)` / `endCrash()`
  - the pilot: `setEyeSource`, `onCockpitChange`
  - the HUD: `mirrorActive`

## Controls (`src/speedboat/controls/`)

| File | What |
|---|---|
| `boatInput.ts` | `BoatInput {throttle −1..1, steer −1..1 (+ right), trim −1..1 (+ bow up), surge, lookBack, reset (one-tick pulse after a 1 s hold), resetHold 0..1, cameraCycle, pause}` |
| `bindings.ts` | Rebindable map. Keys use `KeyboardEvent.code`; the pad uses standard-mapping indices. `rebindKey` removes the key from every other action and reports what it displaced. `SPEEDBOAT_CONTROL_GROUPS` is for the settings page. |
| `curves.ts` | Deadzone with rescale, then a power curve. |
| `inputDevices.ts` | `BoatInputDevices`: keyboard events + Gamepad API. `mapBoatInput` is the pure per-tick fold. |
| `raceControls.ts` | The seam adapter above. |

- **Defaults, design §3:**
  - W/RT throttle; S/LT off/reverse
  - A D / left stick steer
  - ↑ bow down, ↓ bow up / right stick ↕; pulling the stick back = bow up, and `invertTrim` flips the stick only
  - Shift/A Surge; C / RS click look back; V/Y camera; hold R / View 1 s reset; Esc/Menu pause
- **Deadzones (ASSUMED):** steer 0.12 with exponent 1.5; trim 0.25; triggers 0.05.
- **Taps:** presses are counted on keydown and used by the next tick, so a tap shorter than a tick is not lost. Held state is read at the tick. The pad is polled at the tick. Window blur releases every key.
- **Reverse:** only below 3 m/s, after S has been held 0.3 s (tech-research §3.2). At speed S is throttle off.

## Assists (`src/speedboat/assists/`)

The assists are pure functions: `stepAssists(input, sim, settings, state, dt, driveLock) → {steerRad, throttle, trimRad}`.

- **Input:** `readBoatSim(hw, state)` fills `BoatSimSample` from the rigid6 state and the previous tick's contact.
- **No forces:** nothing writes a force. With no trim path into the physics, landing assist on and off fly bit-identical paths (tested).
- **Presets:** Default = lock curve 1, helm 30°/s, Governor AIR, landing assist 0.5, auto reset. Pro = all off; the helm keeps the physical 30°/s actuator.

### Speed-limited lock + heel guard (`steering.ts`)

- **Raw envelope** (assists off, flat water, 30°/s helm, 20 s hold). Values are peak heel in degrees; H = hooked (heel or slip past 45°).

  | C_v | 12° | 14° | 16° | 18° | 20° | 24° | 30° |
  |---|---|---|---|---|---|---|---|
  | 2 | 18 | 21 | 24 | 28 | 36 | H | H |
  | 3 | 17 | 20 | 24 | 33 | 40 | H | H |
  | 4 | 16 | 20 | 24 | 29 | H | H | H |
  | 5 | 17 | 21 | 26 | H | H | H | H |
  | 6 | 19 | 24 | 31 | H | H | H | H |
  | 7 | 22 | 26 | H | H | H | H | H |
  | 8 | 24 | H | H | H | H | H | H |
  | 9 | 25 | H | H | H | H | H | H |
  | 10 | 29 | H | H | H | H | H | H |

  At 120°/s, 12° hooks at C_v 10.
- **Curve** (C_v → degrees): 1→30, 1.5→20, 2→16, 5→16, 6→14, 7→14, 8→12, 10→12. It is non-increasing with speed and gives ±12° at 42 m/s (C_v 8.8).
- **Rule:** min(first hooking angle − 2°, largest angle with heel ≤ 30°). A dynamic pass then tightened C_v 1.5–2: a C_v 3 turn bleeds to C_v 1.6, and the wider lock there peaked at 33.9°.
- **Heel guard:** the lock is multiplied by 1 up to 20° of heel, falling linearly to 0.3 at 32°.
- **Flat water, full stick 20 s, C_v 3–10:** no hook; peak heel 23.0–24.6°. At a 60°/s helm, still no hook (23.5–26.4°). Cost: in a steady flat-water turn at top speed the lock in force settles near 9°.
- **Sea, full stick:** crossing swell of amplitude 0.6·A + 0.3·A m (λ 100 m and 52 m), A 0.66 and 1, 4 headings × 2 turn directions × C_v 4/6/8/10:
  - the curve alone hooks 63/64
  - with the guard, 27/64 (by C_v: 4 → 2, 6 → 2, 8 → 11, 10 → 12)
  - the guard variants tried manage 21–23/64
- **Why the sea still hooks:** the raw hull hooks in that sea at 4–6° of drive (see Hooks 1). No lock limit fixes this.

### Governor (`governor.ts`)

- **rpm proxy:** there is no engine model yet. ρ = n/n_rated, with τ·dρ/dt = |thr| − (0.12 + 0.88·s)·ρ², where s is prop immersion (tech-research §3.1 prop torque).
  - The props run fully immersed (`driveImmersion` 1.000) in straight running at every C_v 0–10, so ρ = 1 is full throttle on the plane.
  - τ 0.25 s and the limiter at 1.15 are ASSUMED.
- **AIR:** caps throttle at (0.12 + 0.88·s), i.e. rated rpm at the current immersion. Airborne that means 0.12.
- **FULL:** AIR, plus throttle ≤ 0.5 for 0.6 s after any flight of 0.3 s or more.
- **Measured** on a real 2 m sandbar at C_v 8, 1.2 s of air, full throttle: OFF sits on the limiter; AIR peaks at ≤ 1.02.

### Trim and landing assist (`trim.ts`)

- **Trim:** a persistent setpoint moved by the stick. Range −6°…+8°. The drive actuator slews at 8°/s (ASSUMED; the doc's 4°/s was too slow for a 0.5 s ramp face).
- **Landing assist:** adds −dial·1.5·(predicted landing pitch − 2.5°).
  - Prediction: pitch + pitch rate × ballistic time to land.
  - Active only while rising faster than 0.5 m/s or airborne.
- **Measured** with test-only thrust-line emulation, bars 1.2–2.5 m at C_v 6–10:
  - landing pitch 14.3/16.3/15.1/16.3/19.0° with the assist off
  - 12.8/12.5/12.8/12.7/14.4° at 0.5
  - The trim saturates at −6°. Landings still come in above the 7° clean limit.

## Cameras (`src/camera/raceCam.ts`, `raceCamMath.ts`, `raceCamEye.ts`)

A new rig. `followCam.ts` and `camMath.ts` are only imported.

| Rig | Numbers (design §6) |
|---|---|
| chase | 7.5 m back / 2.4 m up; FOV 60→76° over 15–45 m/s, slewed ≤ 20°/s; heave low-pass 0.8 s; roll follow 30% (fades out airborne or past 60° tilt); yaw half-life 0.2 s; airborne look target 30% toward the ballistic landing point |
| near | 4 m / 1.5 m; FOV 68→82°; yaw half-life 0.15 s |
| cockpit | `cam_eye` world pose via `setEyeSource`. Fallback: seat station + 0.63 above the sheer and 0.29 ahead of the seat (pilot-log blocker 1: the rigged eyes sit 0.13 m above and 0.16 m aft of the parts anchor). Head follows 100% of tilt up to 12°; beyond that it lags with a 0.25 s half-life. Landing dip ≤ 6 cm (exact critical spring). FOV 72→86°. `onCockpitChange(true/false)` → collapse/restore `head_geo`. Look back = `mirrorActive` (hoop mirror). |
| crash | World-anchored orbit: radius 14 m, 5 m up, 12°/s, looking at the hull. Blends in from chase (0.5 s) and cuts from the cockpit. `endCrash` blends back over 0.8 s. `crashTimeScale` (0.35× for 1.2 s) and `crashCamAllowed` (20 s cooldown) are helpers for the page. |

- **Frame-rate independence:** every smoother is `dampMoving`, a rate limit or a closed form.
- **Heading:** hull yaw only while wet and |fwd_xz| > 0.5; otherwise velocity yaw; otherwise the last heading is held. The switch blends over 0.25 s. No Euler angles.
- **Look back:** a cut both ways.
- **Slam shake:** ≤ 1.5° per axis, 0.25 s half-life. Reduced motion turns off shake, dip and head lag.

## Tests

Command: `npx vitest run tests/speedboatControls.test.ts tests/speedboatAssist.test.ts tests/raceCam.test.ts` → 42 passed, including one `it.fails` known limit.

- **speedboatControls (12):**
  - key and pad signs
  - taps latched; key repeat is not a press
  - reset fires once, on the 1 s tick
  - blur releases keys
  - rebind with displacement
  - deadzone continuity
  - pad edges
  - the same schedule with split or repeated events gives identical `BoatInput`
  - the seam adapter hands the drives exactly the assisted angle: 12° at 42 m/s; Pro gets full lock
  - trim normalisation; disabled input goes neutral
- **speedboatAssist (12, real physics):**
  - curve anchors and monotonicity
  - full-stick sweep C_v 3–10: no hook, heel ≤ 35°
  - left/right mirror
  - sea: guarded hooks ≤ half the unguarded
  - `it.fails`: the raw hull hooks at C_v 10 with 4° of drive in that sea
  - Pro commands match the raw harness to 1e-12 and hook within 2 ticks of it
  - helm rate
  - Governor on a real jump; FULL landing cap
  - landing assist beats off on 5 bars; bit-identical without a trim path
  - determinism
  - Mutation-checked: heel guard off, Governor off and landing sign flipped each fail their test.
- **raceCam (18):**
  - 50/60/100/144/jittery fps within 1 mm and 0.1 px of 960 fps
  - the 50↔100 fps flip does not shake the hull on screen (jerk under 2× steady)
  - the smoothers are exercised (lag > 1°)
  - barrel roll: heading holds within 2°, horizon within 12°, no NaN or jumps
  - bow-up to 120°: heading moves < 1° per frame (the naive atan2 flips 180°)
  - cockpit through flips
  - FOV bounds, monotonicity and slew per rig
  - fallback eye; head hook; `cam_eye` used when present
  - head lag; dip ≤ 6 cm; shake bound; reduced motion
  - crash anchor and a return with no pop
  - the seam rig
  - Mutation-checked: `expDamp` yaw → 8–25 mm; hull heading without gating → the flip test fails.

## Hooks needed from other owners

1. **Physics, BLOCKER for sea play: roll stability while turning in waves.**
   - Raw hull, Pro, 20 s, crossing swell as above (slopes about 2°):
     - C_v 8: 4° of drive hooks 3/16, 6° hooks 9/16
     - C_v 10: 4° hooks 8/16, 6° hooks 11/16
   - Straight running is fine (peak heel ≤ 6°), and in flat water 12° is a steady turn at both speeds.
   - Likely the ~1 Hz heave–roll limit cycle (physics-log T179 round 2) being excited by the sea.
   - Pinned by `it.fails` in `tests/speedboatAssist.test.ts`.
2. **Physics, drive trim input.** `HullWater.setControls(steer, throttle)` (`hullWater.ts:1707`) needs a `trim` argument (rad, + = trim out).
   - In `evaluateDrives`, tip the drive line: `rot(sn, 0, cs, D)` (`:1769`) becomes `rot(sn·cosθ, −sinθ, cs·cosθ, D)`.
   - Ideally also rotate `prop`/`foilCe` about the mount's tilt pin.
   - Sign: trim out tips the thrust down at the stern (bow up). That matches `tests/speedboatAssist.test.ts` `jump(..., {emulateTrim})`.
3. **Physics / design decision, airborne pitch authority.** Design §3's "motocross rule" is not in the physics: a dry prop makes no thrust (`:1880` `imm > 0`). Until it is, trim and throttle cannot pitch her in the air, and the landing assist only acts on the launch.
4. **Engine (S2 drive / T183).** A real rpm model should replace the Governor's proxy (`governor.ts` reads immersion today). Top speed at default power is 29.5 m/s (C_v 6.2) against the design's 42 m/s; the tests use the 4 MW stand-in like physics-log. Surge power (+⅓ segments) is T184.
5. **Pilot.**
   - `rig.cam.setEyeSource((p, q) => { eye.getWorldPosition(p); eye.getWorldQuaternion(q); return true; })` with `eye` = the `cam_eye` node.
   - `rig.cam.onCockpitChange = (on) => collapse('head_geo', on)`.
6. **Page / crash (T188).**
   - On respawn: `controls.reset()` and `camera.cam.endCrash()`. `snap()` is a plain cut.
   - The crash owner calls `camera.cam.beginCrash(point)` and applies `crashTimeScale`.
   - Draw the hoop mirror while `cam.mirrorActive`.
7. **Params (§V62 live).** `ASSIST_PRESETS`, `RACE_CAM_DEFAULTS` and `DEFAULT_BOAT_CONTROL_OPTIONS` are frozen objects in their modules. Registering them in `src/params/speedboat.ts` is for the params owner.
8. **NPCs (T186).** The same `stepAssists` with a synthetic `BoatInput` gives rivals the same lock, Governor and trim. The worker's `CONTROLS` are normalised steer × lock, like the seam.
