# W7: the speedboat's water effects read strongly (SPEC T199)

Status: code + CPU tests + browser measured. Date: 2026-09-14.
SPEC: §T.199, V100, V104, V105, V28, V48, V80, V22.
USER: "rooster tails are still pretty weak if visible at all. almost seems like they get rendered behind the ocean …
bow wake angle seems a bit round … not triangular enough … the water displacement / general 3D wake the boat does is
a bit weak. I know we built the plumbing but is it on? is it tuned down too hard?"

Legend: `[M]` measured in this repo (browser = headless Chrome WebGPU, `speedboat.html?autopilot`, calm Tower Reach;
scripts and shots in the session scratchpad `t199/`). Tests: `tests/wakeSpeedboatLook.test.ts`.
Scratch (gitignored): `tests/zzScratchT199NearTier.test.ts`, `tests/zzScratchT199Angle.test.ts`, `tests/zzScratchT199Flow.test.ts`.

Everything was ON. Nothing was tuned down. Three separate defects, each measured before it was changed.

## 1. Rooster tail

### Live cause `[M]`

- **Render order.** The ocean is a transparent, depth-writing mesh at renderOrder 0 (`surfaceMaterial.ts`). three sorts
  equal renderOrders back-to-front by each object's projected ORIGIN. A GPU particle pool's origin is (0,0,0); the race
  runs 400–600 m from it. Measured sort z: pools 414, ocean 3.8, so the pools drew first and the sea painted over every
  particle in front of it. Particles stayed visible only where the sky was behind them, which matches the user's
  "only where the camera gets clear line of sight".
- **Emission.** The T180 emitter launched at the actuator-disc excess ΔV: 0.9 m/s at race speed. The tallest particle
  in the pool stood 0.12 m above the water. With every prop forced half-in it reached 0.88 m.
- **Starved.** Props ran 0.4–1.0 m deep (T196), so exposure was 0 and rate 0 on most ticks. T196 has since landed:
  immersion 0.22–0.84 at 25 m/s.

### Fix

- `sprayPool` takes `renderOrder` and `blending` (pipeline state only; the WGSL is unchanged).
  - `SPRAY_OVER_WATER_ORDER = 0.5` for the bow sheet, rooster drops and rooster mist: after the ocean, before cockpit
    glass (1).
  - `SPRAY_UNDER_WATER_ORDER = −0.5` for prop bubbles: before the ocean, so its refraction copy carries them.
  - Particles stay depth-tested against the sea.
- **Blade model** (`roosterTail.ts` header). Launch UP = V_s·√e, where V_s = 0.22·2π|n|R is the shed-sheet speed.
  - e = 4·imm·(1−imm) is the exposed blade arc.
  - OUT = 0.5·V_s·√(1−e). AFT = ΔV.
  - Flux = e·V_s·A, rate = bowLiftRate·flux (the bow sheet's density, no new knob).
- **Two pools**, 4096 each, one emitter.
  - DROPS: linear air drag 1.2/s, from 3C_d·ρ_a·v/(8ρ_w·r) at r = 2 mm.
  - MIST: 2.5/s, launched at 0.8 of the drop speed, living 1.6× longer.
  - Lifetimes come from the drag flight time (`roosterFlightTime`).
- **Lighting.** Normal blend (a plume occludes), tinted by Henyey–Greenstein forward scattering (g = 0.6): backlit reads
  bright, down-sun reads grey-white. The sun comes from the scene's DirectionalLight, or from `sunDirection` if the page
  passes one.
- **Rev/s.** `PropWashInput.propRps` is filled from `hw.engines[k].propRps`. The hero's engines are read live. Rivals'
  FX records do not carry rev/s yet, so they use `propRpsEstimate` = (U_a + ΔV)/P. Measured −4 % at 40 m/s and −15 % at
  30 m/s against the engine.
- **LOOK CALIBRATION, stated:**
  - ROOSTER_SHEET_FRACTION 0.22, against offshore-racing footage (a plume several metres high peaking behind the transom);
  - sprite scales 4 / 9;
  - opacities 0.7 / 0.22;
  - ambient 0.6 / sun gain 0.12 / phase cap 8.

### After `[M]`

| | before | after |
|---|---|---|
| sort z, pools vs ocean | 414 vs 3.8 (pools drawn first) | renderOrder 0.5 vs 0 (after, independent of z) |
| rooster rate, 25 m/s, natural | 0–430 /s | 1322 /s |
| tallest particle above water | 0.12 m (forced half-in: 0.88 m) | drops 6.6–7.0 m, mist 2.8–3.4 m; 395–514 drops above 3 m |
| drag apex per prop | ΔV²/2g ≈ 0.04 m | 2.6–6.1 m |

## 2. The V is round, not triangular

### Live cause `[M]`

- **The trail is swirled sideways.** The accumulation advects foam on the curl field with gain ×(1 + wakeChurn 1.8)
  where foam is saturated. CPU mirror (`flowVectorCpu`, shipped params): open water median 0.42 / p90 0.86 m/s; inside
  the trail 1.18 / 2.40 m/s. Over the 5–12 s foam life that is 6–24 m of lateral smear: the round cloud.
- **The prop lane is wider than the V.** Each ribbon spread at the still-water jet rate S = 0.1: ±5–6 m at 50 m astern,
  saturated by three drives. The Kelvin/Rabaud–Moisy V at 4° is ±3.5 m there, so it could not read.
- **No breaking on the arms.** The sim's slope was at most 0.035–0.054 within 60 m on the 1.75 m tier, below the 0.30
  onset. Breaking foam was exactly 0.

### Fix

- **Fleet eddy gain.** `FLEET_WAKE_CHURN = 0` in vessel mode only, via a new `AccumProfile.wakeChurn` (uniform value).
  The galleon and raft keep 1.8. LOOK CALIBRATION: a planing hull leaves a thin turbulent layer, not a bluff-body eddy
  street.
- **Co-flow jet spread.** `jetSpreadRate` = S·ΔV/(ΔV + U_a), the small-deficit jet/wake similarity (Pope 2000 §5.5;
  Rajaratnam 1976). It is S in still water, and about 0.01 at race speed.
  - Measured ribbon rms half-width 0.64–0.98 m over 10–50 m astern, down from 3.5–6 m.
  - STATED RESIDUE: the sim source (`propJetSample`) keeps the still-water S (T180's pinned source strength).
- **Chine sheet lines** (`simFoam.packChineSheet` / `chineSheetFoamRate`, vessel mode).
  - Each hull's waterline spray (`WaterlineSpray`) leaves each chine outboard at v_out (`waterlineSheetLaunch`) and is
    left behind at U. It rides the ray tan α = v_out/U and is laid along L = U·(t_f + CHINE_SHEET_SLIDE).
  - Rate = Q_side/(h·√2π·b)·e^(−s/L)/L·e^(−n²/2b²), from conservation. It is independent of U and α.
  - LOOK CALIBRATION: h = 5 mm of landed sheet water reads as full coverage; slide 1.5 s; width 0.25 m + 0.02/m.
- **Breaking on the arms.** It now reads the near tier (§3): slope up to 0.16–0.22 next to the hull. That is still
  under the 0.30 onset, so the physics gives no breaking foam there. Stated, not forced.

### V half-angle vs prediction

Rabaud & Moisy 2013 hull-length law for L = 12 m; the 50 %-coverage edge of the accumulated sheet foam, fitted over
10–50 m astern (CPU, `tests/wakeSpeedboatLook.test.ts` §3) `[M]`:

| U (m/s) | Fr_L | R–M | foam V | ratio |
|---|---|---|---|---|
| 20 | 1.84 | 6.17° | 2.79° | 0.45 (outside tolerance; not asserted) |
| 25 | 2.30 | 4.95° | 4.12° | 0.83 |
| 30 | 2.77 | 4.13° | 4.00° | 0.97 |
| 40 | 3.69 | 3.10° | 3.55° | 1.15 |

- Arms are straight (linear fit R² > 0.97).
- The prop lane sits inside the V at 50 m astern.
- The 448 m tier's own solver arm at 30 m/s is 4.56°.
- At 20 m/s the sheet's landing length is short and the edge lags.

### Browser `[M]`

- Solo hero (rivals' effects removed for the measurement): the top-down shot shows a narrow lane from the transom with
  two diverging bright arms, a triangle.
- In the pack, the hero drives over the rivals' trails, so the wide foam there is theirs.
- Screenshots: `t199/shots/before-*` (baseline) and `final-solo-*` / `final-pack-*` (taken under the GPU lock).

## 3. Displacement "weak"

### Cause `[M]`

- The 448 m tier's splat σ ≥ √2·1.75 = 2.5 m band-limits the forcing. The W2a calibration is untouched (ΣF_y = weight).
- CPU tow at 30 m/s, 8 s: near-hull p2t 0.023 m, slope 0.021, arm 10–40 m 0.026 m.
- Live: max |ζ| 0.05–0.19 m within 15 m.

### Fix

- **The tier.** `WAKE_SPEEDBOAT_TIER.near` = 256² × 0.5 m (the raft grid). A second `WakeSolverGpu` in `WakeSim`, fed
  the same hero samples + jets, with rivals weighted against its domain.
- **One group (§V104).** `WakeSolverGpu.stepGroup` does both splats, then ONE `renderer.compute` over both node lists
  (70 dispatches).
- **Anchor.** Stem-led (`wakeNearStemLead`): the stem sits at the forward edge of full weight, with 35 m of wake astern
  at full weight. The wetted stem is held when the bow flies. A live 3-sample jump had scrolled the grid out and wiped
  it; it is now held, relaxing aft at 2 m/s.
- **Drawing.** The surface (`simInjection`) and sim foam (`simFoam`, S = 1 tiers) cross-fade far → near by
  `simNearWeight`: 0 in the near sponge, 1 after a further 0.5 sponge widths.
- **Bit-identity.** Raft and pirate build no near graph (their fingerprints are identical, §5).
- **Vertices.** Ocean spacing at a 20–45 m chase is 0.9–1.4 m (`surfaceGeometry`, core 0.5 + 0.0205·r). The forcing
  at λ = 1.4 m is e^(−k²σ²/2) ≈ 0.4 %.

### Before/after `[M]`

| 30 m/s CPU tow | 448 m tier | + near tier |
|---|---|---|
| near-hull p2t, 8 s | 0.023 m | 0.242 m |
| max slope within 15 m, 8 s | 0.021 | 0.221 |
| divergent arm, 10–40 m astern | 0.026 m | 0.32 m |
| 3 s tow (test): p2t / slope | 0.039 / 0.017 | 0.156 / 0.164 |

Live, the hero at 21–26 m/s, max |ζ| within 15 m (hull footprint included): far 0.05–0.27 m, near 0.37–0.99 m.

### GPU `[M]`

Measured under the shared GPU lock: page loop stopped, timestamp queries, 8 submits per sample, 5 samples.

| group | per step |
|---|---|
| far (448 m) | 0.35–0.38 ms |
| near (128 m) | 0.35–0.37 ms |
| both, one `renderer.compute` | 0.69–0.72 ms |

- The near tier adds ≈ 0.35 ms, inside the ≤ 1 ms budget for the whole wake group.
- Earlier measurements taken without the lock, while other agents held the GPU at 100 %, read 2–6 ms. Those numbers
  are INVALID and not used.

### Anchor robustness

- The near domain follows the hero's wetted stem, held while the bow flies and walking aft at ≤ 2 m/s. Samples farther
  than domain/4 from her origin are ignored. A teleport re-leads it from that tick's samples.
- Browser: a 3-sample wave jump wiped the grid before the hold, and a respawn left the domain 73 m off before the
  re-lead.
- Test: `wakeSpeedboatLook` §4 "stays on HER" (mutation: hold + bound removed → red).

## 4. Open

- `sim-worker/fx.ts` should carry rev/s per drive (FX_DRIVE_LEN 12 → 13, `PROP_RPS: 12`, write `j.propRps ?? NaN`,
  read back). That retires `propRpsEstimate` for rivals.
- An unloaded GPU cost measurement of the near group (pond or a dedicated machine).
- The sim source keeps the still-water jet spread (§2 residue).
