# W8: the wake reads as water with shape, not a white blanket

Status: code + CPU tests green; browser measured (free roam, calm Tower Reach). Date: 2026-09-14.
USER: "the wake we leave is solid white almost at any kind of speed instantly … even at very slow speeds as soon as the
engine runs … we can never appreciate [the exhaust exit bubbles]". Coordinator add-on (trailer look pass): spray at
sunset reads as dark smoke; the wake glows constant cyan under a pink sky.

Legend: `[M]` measured in this repo. Tests: `tests/wakeFoamReadability.test.ts` (new), plus re-cut intent in
`tests/sprayFleet.test.ts`, `tests/wakeW5b.test.ts` c/d, `tests/chineEmissions.test.ts`, `tests/wakeMultiVessel.test.ts`.
Scratch (gitignored): `tests/zzScratchW8Foam.test.ts` (per-source steady dose). Browser scripts and shots: session
scratchpad `wake8/` (plan.mjs, probes inline), grid `wake/foam_before_after.png`.

## 1. Measurement and root causes `[M]`

The wake pond (`src/wake/preview.html`) draws the solver height only: no ocean material, no flowfoam. Foam cannot be
measured there, so the shots and the coverage readback come from `speedboat.html?mode=free` with a camera hook and a
speed/heading hold on `__speedboat.controls.sample`. Coverage = the near foam texture (.r coverage, .g slick) read back
over the wedge 1–60 m astern of the transom, |y| ≤ beam/2 + a·tan 19.47°, passed through the material's laws (dissolve
gate 0.005–0.225, stage-A freshness, froth law).

Injection breakdown at the hero (CPU twin over read-back solver fields) and the CPU steady-dose instrument agreed on
the causes:

1. **The prop ribbon was driven by the jet's Bernoulli-lifted excess, not by air.** `packPropJet` drive =
   lift(ΔV, d)·ΔV + aeration. At 5 m/s: 1.9–2.8 m/s of lifted excess against 0.3 of air; at race speed 0.08. The ribbon
   was widest and whitest at displacement speed, the inverse of the real thing (63 % of the dose at 5 m/s).
2. **A buried prop "ventilated" with no air path.** `ventilationAirSpeed` χ = 1 − (1 − e)·v(J) gave a fully immersed
   prop at low J 45 % of its pitch volume as air: 1.2–1.4 m/s at idle, 0.7 m down — foam "as soon as the engine runs".
3. **Chine sheet lines had no entrainment threshold.** Every m³ of landed waterline water became coverage (10 mm
   layer). A displacement-speed bow wave that barely climbs the hull (v_n ≈ 1 m/s) laid 29–69 % of the dose at
   5–13 m/s.
4. **Hull churn had no air criterion.** Lift saturates at F_D ≈ 1.4, so bury/emerge laid full churn from ~3 m/s.
5. **Saturation, not white, made the blanket.** Doses ran 3–12× past the dissolve gate's top (0.225): the aged lane
   drew as a uniform milky decal 2–6 beams wide (gate-saturated 22–26 % of the wedge at 5–31 m/s). Fresh froth was only
   1–8 %.
6. **The aged-lane colour was scalar-lit teal mixed over the reflection** (`uWakeFoam × luminance`), so it glowed the
   same cyan under any sky and hid the displaced surface's reflections.
7. **Rooster/mist spray: 0.02·key when front-lit** (AMBIENT 0.6 + 0.12·HG with g = 0.6): grey-brown smoke darker
   than the water behind it.

Not causes: tonemapping, decay half-lives (5 s near / 12 s far — unchanged), the far tier.

## 2. Sources (physics)

- **Ribbon = air only** (`simFoam.packPropJet`): drive = AERATION_SHARE·aerationSpeed. The jet's upwelling stays the
  surface's (`propJetSample`). meta.x now carries the exhaust boil amplitude.
- **Surface air needs the surface** (`propWash.ventilationAirSpeed`): e·P·|n|, e = 4·imm·(1 − imm). A buried prop's
  low-J ventilation is its own exhaust gas, counted once below.
- **Through-hub exhaust** (`propWash.exhaustGasFlux`, `exhaustBoil`): Q_ex = (V_d/2)·n_crank·MAP(τ)·T_ex/T_in from
  published jet fields only (rev/s, lost power, thrust, advance), so rivals get it too. 450R: 4.6 L, 1.6:1, MAP 0.3
  idle → 1.5 boosted, 1.2 temperature ratio. Idle ≈ 10 L/s, race 0.2–0.6 m³/s. The plume rises at 0.3 m/s (Clift,
  Grace & Weber) while carried aft at U_a: it surfaces d·U_a/w aft, σ = r + d + 0.1·path (plume growth + surface
  outflow), and a share φ = w/(w + U_a) boils out (0.23 at 1 m/s, 0.06 at 5, 0.01 at race). The rest, (1 − φ)·Q_ex/A,
  joins `aerationSpeed` (the wash swallows it). The boil is a Gaussian patch per drive (`exhaustBoilRate`, vessel
  mode, one more uniform array `uJetBoil`; no sampler). LOOK CALIBRATION: `EXHAUST_FOAM_LAYER` = 2 mm of gas per unit
  coverage — 13 mm and 3 mm were measured invisible at idle once the tier's blur spreads the patch.
- **Landed sheets** (`chineEmissions.sheetAirShare`): whitewater share (1 − V_e/v_up) past the plunge-entrainment
  onset V_e = 1 m/s (Ervine, McKeogh & Elsawy 1980; Cummings & Chanson 1999). 0 at 5–13 m/s (v_n ≈ 1.0), 0.36 at
  31 m/s (1.56).
- **Hull churn, vessel mode** (`simFoamRate` `airOnset`): bury/emerge count the vertical surface speed past the same
  V_e. The raft/galleon single-hull graph keeps the W5 law node for node (their lane is signed off; a stated fork).

## 3. Material: aerated water is subsurface (`surfaceMaterial.ts`, sim backend only)

Froth (fresh × dense) stays the surface film in the whitecap colour. The aged remainder re-tints the TRANSMITTED body:
`col += (uWakeFoam·lightWrap − transmitted)·aerated·(1 − reflWeight)`, lit by the body's own coloured irradiance (sky +
sun), so a sunset warms it and the Fresnel reflection and ripples stay on top. One hunk, no new binding (V40); the
analytic (pirate) graph never enters the branch.

## 4. Spray lighting (`roosterTail.ts`)

Radiance = ω·[key·(M + (1 − M)·min(HG, 8)) + ambient], ω = 1 (water drops do not absorb), M = 0.5 multiple-scattered
share. Down-sun ≈ 0.58·key + sky, backlit ≈ 4.5·key + sky. Shots: front-lit spray is warm white, backlit glows.
STATED: the plume's size/opacity are unchanged; brighter, it now dominates a 22 m rear chase when the props ventilate.

## 5. Before / after `[M]`

Browser, same controller, same camera, wedge 60 m (U 12.9/30.9 and sunset after-shots at the 3 mm boil layer; the
exhaust share there is ≤ 2 %):

| speed | gate-saturated (solid) | white (froth > 0.5) | solid width at 10 m |
|---|---|---|---|
| 1 m/s | 0.9 % → 1.8 % (the boil patch) | 0 → 0.2 % | 0 → 1.1 B |
| 5.1 m/s | 21.9 % → 4.0 % | 1.4 % → 0 % | 2.6 B → 0.3 B |
| 12.9 m/s | 24.5 % → 7.6 % | 4.2 % → 0.6 % | 2.3 B → 1.0 B |
| 30.9 m/s | 26.4 % → 26.4 % | 7.8 % → 8.7 % | 2.2 B → 1.2 B (white 2.3 → 1.2 B) |

Look: 5–13 m/s went from an opaque milky lane from the transom to a translucent turquoise centreline with the ripples
visible through it. At planing the smoky lane became a narrow white textured core with lace, then an aerated band; the
solid fraction did not fall (the core is still saturated for ~100 m). Sunset: the cyan glow is gone.

## 6. Tests

`tests/wakeFoamReadability.test.ts`: tow at the holding throttle, CPU solver, vessel-mode rates accumulated with the
near tier's clocks and cross-track blur, read through the material laws.
- 2 m/s: nothing solid ≥ 20 m astern, < 10 % solid, peak < 0.6, no white; every drive boils (flux > 0, share > 0.1),
  the boil ≥ 25 % of the lane and mostly within 15 m. The before-tree fails it (coverage 1.0 from 2 to 30 m).
- 30 m/s: a white core exists, ≤ 3 beams at 5/10/20 m, white < 10 % of the wedge, solid ≤ 3 B at 10/30 m, exhaust
  share < 2 %.

## 7. Other vessels

- Raft/galleon: single-hull flowfoam graph (no jets, no onset, centred window). The pond draws only solver sources,
  which W8 did not change, so no pond shot. The material's aged-lane change reaches every sim-backend sea, and the
  subsurface branch also runs on the analytic (pirate) backend, where froth is 0: its lane is now a subsurface tint.
- raft.html, towed at 2 m/s (round 2, `wake/raft_follow_v2.png`): the rim foam reads as torn lace flecks around the
  hull; no white slab, no regression seen. Pirate page not shot.

## 8. Round 2: the rooster tail is water, not puffs (`sprayPool.ts`, `roosterTail.ts`)

The round-1 lighting made the plume bright enough to show what it was: 1.3 m drops and 2.9 m mist discs, soft
round sprites, hanging in the air the chase camera flies through (spray keeps ~zero world speed while the boat runs
off at 31 m/s), so from a 22 m rear chase they filled the frame and hid the hull.
- `SprayPoolOptions.droplets` (rooster pools only; every other pool builds the pre-W8 graph): each sprite is
  `SPRAY_DROPLETS` = 5 hashed drops strung along its streak axis on a thin ligament that fades with age, instead of a
  soft disc; opacity × (1 − age)^1.8 (drops) / ^2.5 (mist); a 1.5 → 8 m eye-distance fade.
- LOOK: drops ×2.2 (0.18 → 0.7 m), mist ×5 (0.4 → 1.6 m, opacity 0.2), streak 5. Lighting kept.
- Shots: backlit and front-lit 25 m rear chase — fine glowing streaks and drops over a visible hull.

## 9. Round 2: the planing core breaks up, and the drawn wake runs further astern

Measured (browser readback at 30.9 m/s): near-tier coverage sat at 0.76–1.0 all the way to 60 m and read fresh
(0.38–0.51) at 20–40 m. The accumulation clamps at 1, so a pinned lane keeps its foam/slick ratio and the froth law
(freshness × a smooth ramp) drew a uniform white stripe until the window ended.
- `flowfoam.wakeWhiteNode` (sim backend; material hook one line): white = a gate on a ridged band-limited fbm
  (1.3 m cells, drifting), edge = mix(0.72 aged, 0.12 fresh, smoothstep(0.25, 0.92, freshness)) + 0.22 where the wake
  mask is thin; brightness × (0.65 + 0.35·ridge); past a pixel of 0.3 m it resolves to its mean 1 − √edge. Dense churn
  → solid white, ageing → lace/filaments, aged aerated water → sparse surfacing flecks (idle boil, old lane). A gate on
  the wake mask itself was tried first and drew flat white sheets (the porous mask has no texture at saturation).
- Vessel mode: the near window trails the hull by 1.2 s of speed, capped at 24 m (`NEAR_ASTERN_*`): the wake surface
  and detailed foam are drawn to ~75–85 m astern instead of 50–60 m.
- Result: 30.9 m/s top-down dense white ~25–35 m then lace and an aerated band; 12.9 m/s lace filaments on the
  turquoise wash; idle a small boil with flecks behind the drives.

## 10. Round 2: divergent arms `[M]`

The solver amplitude does reach the drawn surface: near-tier ζ 0.17–0.23 m and slope in the near foam texture's .ba
(the ocean normal term) 0.11–0.25 at the arm crests, 15–50 m astern. What hid them:
- the drawn surface ended at the near window (≈ 50–60 m astern) — fixed by §9's trailing window;
- at planing the arms are where Rabaud–Moisy puts them, ±3–5 m of the track at 50 m (3–4°), under the white core;
  at 25 kn ±5–10 m, outside it. The 448 m tier carries only 0.01–0.06 m.
Nothing was amplified. The 25 kn top-down now shows the V of dark ridges past the aerated wash; at 60 kn the V is
narrow and reads as the core's edges. A thin breaking lip near the hull comes from the existing breaking term.

## 11. Tests (round 2)

- `wakeFoamReadability`: the CPU accumulation now carries the tier's ≤ 1 clamp and reads through the new white law.
  30 m/s: dense white (> 0.5) at 10–20 m, ≤ 3 beams; below 0.5 at 40/50/60 m; lace (> 0.05) still at 40 and 60 m.
- `sprayFleet`: rooster sprite sizes bounded (drops ≤ 0.75 m, mist ≤ 1.7 m), eye fade present.
- `wakeW5b` d: the material calls `wakeWhiteNode`; analytic has none. Its foamDetailMask regex now fails on another
  session's `surfaceLift` argument in that call (not W8's line).

## 12. Open

- 8–20 kn white is lace, not a churned wash; more would need AERATION_SHARE (a source) or lower lace edges.
- The planing core is still "solid" (gate-saturated) aerated turquoise to the end of the near window: by design.
- The trailing window swings during hard turns (36 m lever at speed); not seen in the straight-line shots.
- The exhaust source reads the 450R constants for every drive.

## 13. Round 3 (coordinator + user frames: sunset rear chase, trailer 03 / 08 / 09, night pack)

**Foam look.**
- Lighting: the wake's white film is lit by the water body's coloured irradiance (sky colour·(floor + 0.1) + sun
  colour·N·L·gain·0.6·shadow), albedo 0.8, instead of luminance-lit grey-white. It warms at sunset and goes dark at
  night; the LED pools are added downstream by `boatLightPool`. The sky term is occluded by half at the hull contact
  (depth-compare proximity); the sun term carries the shadow map.
- Pattern: `wakeWhiteNode` gates a flow-aligned blend in her track frame — patches 6 × 24 m, filaments 0.9 × 5 m,
  bubbles 0.3 m — then ridged. The hole size grows with age through the edge. The hull-contact share swaps patches for
  8 cm bubbles and raises the edge, giving a thin broken contact line.
- Contact line (sim backend): scaled by the wake coverage there, 0.2 + 0.8·smoothstep(0.03, 0.4). It is thick where
  the sim churns (bow shoulder, quarters) and thin where the hull rests.
- Surface: `wakeSlopeNode` (vessel mode) adds churn relief to the normal: a two-way scrolled band-limited fbm height,
  differentiated, × coverage². The dense core boils; the thin aerated band keeps soft reflections. No displacement
  bumps (the vertex stage would need the foam texture: a new vertex binding, not taken).

**Rooster tail restored.**
- Streak/dash sprites (drops ×1.8, mist ×3.5).
- `ROOSTER_SPRITE_DENSITY` 4: the weight comes from the count.
- Pools are 16384 each.
- Droplet sprites start at 60 % of full size (no invisible root).
- Mist drag 2.5 → 1.6/s, and mist life no longer 1.6× the drops' (the floating detached cloud).
- The eye fade is now depth to the lens plane, 0.3 → 1.5 m (close/hard-mounted cameras keep the plume).
- Physics note: a surface-piercing prop's sheet leaves with ≈ zero horizontal world speed (the blade pushes water aft
  at about the boat's own speed), so a rooster tail trails astern while it falls. That is attached at its root, not
  carried along.

**Spray at night.** The rooster pools read the boat LED pool's uniform arrays (no sampler): colour/(1 + d²/R²),
R = 3 m, through the drop phase function. Moonlight comes through the key-light phase; ambient is unchanged.

**Water thrown to the side.** `strutSheetEmission`: each drive strut's leading edge throws a sheet at
v_n = U·sin(atan(2t/c)) up and 2v_n·cos α outboard. Flux per side is v_n·min(h, v_n²/2g)·t. It takes the rooster
slots the props leave; the fleet emitter has 48 slots.

**8–20 kn white.** `propWash.slipAirSpeed`: a loaded buried prop's vortex ventilation,
K·slip·P·n·e^(−d/D)·τ·(1 − e), gated by tip-vortex cavitation σ (1 → 0.4). K = 80 is a LOOK calibration. Aeration
drive: 2 m/s 0.08, 5 m/s 1.0, 13 m/s 0.93, 31 m/s 2.8.

**Appendages** (`src/wake/appendages.ts`). Generic `AppendageInput`: waterline point, flow direction, chord,
thickness, immersion, speed. Consumers:
- a hull-type solver source of weight ρg·t·c·h (the split ripple);
- a thin foam streak (`strutFoamRate`: an eddy street at low speed, a ventilated cavity past Fn_h ≈ 2).
The speedboat producer derives struts from the drive jets (live steer/trim pose, rivals included). NOT WIRED: the raft
oar and the galleon rudder need producers on their own pages.

**Impacts.**
- The hero's wake load rises over 80 ms (`wakeLoadRamp`); a falling load passes straight through.
- Vessel mode drops the instant vertical-burial rim ring. The impact water is the chine sheet: retained packets that
  travel outward over their life; the spray particles are ballistic.
- A landing-delayed packet deposition was tried and reverted: it moved the calibrated steady V lines (T199 §3 tests).

**wakeW5b d failure (another session).** `surfaceMaterial.ts` now passes `surfaceLift` (the ocean's crest elevation in
σ units) as the wake `foamDetailMask`'s 4th argument, so the wake mask is carved by the ambient waves' tips, like
whitecaps. The test pins the wake mask as uncarved (`undefined`). What it breaks: the §V.10 separation (the wake foam
should not be decimated by unrelated sea-crest elevation) and that regex. W8 did not revert it.

**Tests.**
- `wakeFoamReadability`: load ramp; no vessel-mode rim ring; strut streak/source.
- `sprayFleet`: strut sheet; mist fall; lens-plane fade ≤ 2 m; sprite density.

## 14. Round 4: spray is a soft volume of tiny drops; drops die in the water; the landing lane lays over time

- **Root cause (needles/straw).** Round 3 sprites were 0.14–0.58 m square quads squashed ×5 into dashes. A dash is
  its quad's full length, so near the chase camera they were metre-long needles. Nothing killed a particle at the
  water, so the drops that fell back lay on the lane (the "hay" carpet) until their life ended.
- **Drops** (`SprayPoolOptions.motionBlur`): each sprite is one drop's motion blur. It is 2.5 cm wide and
  |v|·1/120 s long (≤ 10 widths), and its size is capped at 6 mrad × view depth. A soft capsule shape replaces the
  hashed dots. Opacity is 0.55; the drop pool is 4× the emitter count (65 k); the density is ×40 per unit sheet flux.
- **Mist** (soft pre-W8 disc, ×8 size, opacity 0.1, 0.3 of the drop rate) carries the plume silhouette. It fades
  within 1.5–6 m of the lens plane.
- **Water kill** (`killBelow`): a falling particle below the sources' mean surface − 5 cm dies.
- **Sub-tick emission:** each particle is born rT ∈ [0, 1) of a tick earlier, along the prop's path (advance·rT·dt
  aft), and has already flown rT·dt. No clumps.
- **Lace band limit:** it resolves against the filament width (0.09 → 0.025 m pixel), not the 0.9 m cell. The churn
  relief fades past a 0.04–0.12 m pixel. The far wake is the soft mean.
- **Landing lane** (`jetRunWindow`): a prop's ribbon exists only as far aft as it has run since it re-entered the
  water (per-slot run metres, per fixed tick). Before this, the steady 12–60 m ribbon appeared on the re-entry tick.
- **wakeW5b d:** the wake `foamDetailMask` is uncarved again (`undefined` 4th argument, §V.10). The round-3
  `surfaceLift` was in the W8 hunk. The wiring test regexes follow the crest-max and `aerTint` arguments.
- **√2 sea-height change:** the wake breaking increment reads the ocean's own band slope variance (`bandSlopeVariance`
  from the cascades), so it follows the smaller seas with no threshold edit. Whitecap thresholds are not W8's.
- **Shots:** `wake/round4_review.png` (sunset 25 m rear chase front/back, 3/4 at 60 kn, low drive-by, night pack,
  03 dolly) and `wake/round4_landing_1-15s.png`.
- **Open:**
  - The 2–5 m rooster arc does not read from the drive-by (the plume reads low, ~1 m); tall drops are sub-pixel at
    25 m.
  - The 03 transom water at 5 kn reads as a pale flat sheet at that grazing view (lace resolved to its mean).
  - Night spray is faint.

## 15. Round 5: rooster height, the close camera, night light, spray DOF

- **Rooster tail height `[M]`** (GPU readback of the pools at 31 m/s, free roam, calm):
  - props at 55.7 rev/s, immersion 0.62, 0.36 m deep → tip speed 70 m/s, UP launch 14.9 m/s, drag apex 5.4 m;
  - 49 k drops alive, 28 % above 3 m, the tallest at 5.5 m.
  - So the emitter's ejection is not clamped or damped. What read as "~1 m" was VISIBILITY: at a 25 m drive-by a
    2.5 cm drop is under a pixel across, so the tall drops missed pixel centres, and the mist (0.8 × launch, drag
    2.5 → 1.6) topped out near 3 m.
  - Fixes: sub-pixel drops are drawn at 1.5 px with opacity × (true/drawn)² (coverage-conserving haze); the mist
    launches at 0.95 × launch with drag 1.35/s and opacity 0.13, so the plume silhouette reaches the drops' height.
  - Cine trim burying the props: not checked (the sea agent's pending trim fix).
- **03 close camera:** the lace resolve and the churn relief now use the AREA footprint √(fx·fz) of the screen
  derivatives in world units. The material's max-axis footprint is the along-view stretch of a grazing view and had
  faded a 7 m camera's lace to its mean (the milky sheet). The fbm octaves band-limit themselves per axis, and the
  gate's knee widens with fwidth.
- **Night:** `flowfoam/wakeLight.ts` lights the wake foam (white film + aerated band) by each boat LED at
  colour/(1 + d²/R²), R = 8 m, reading the pool's uniform arrays (no sampler). Spray LED lamp size 3 → 8 m, gain
  1.5 → 3. Moonlight already reaches foam through the key-light term.
- **DOF (trailer agent's user-approved fix):** spray meshes go on `postParticleLayer(material)`. Sprites grow by
  1 + 2·`particleDefocus(viewZ)` with opacity ÷ that squared (energy-conserving). This applies to every spray pool.

## 16. Round 5 (sea agent's trim note): transom hollow + spray root

- **Transom hollow** (`src/wake/transomHollow.ts`): the hollow enters the linear solver as a VIRTUAL HULL
  EXTENSION, the linear-theory treatment of transom-stern flow (Doctors & Day 1997).
  - Weight ρg·dep·dA over HOLLOW_DEPTHS = 8 cells up to where the hollow closes. The drawn surface (η + h) dips, and
    the solver radiates the closure hump.
  - dep comes LIVE from the physics' own `HullWater.transomWakeDepthAt(x, z)`, sampled along the centreline aft of
    the transom (the transom point from the pose and `mesh.transomZ`; the beam is 2·max chine half-beam).
  - It rides the effects record: `FX_HOLLOW`, `FX_HOLLOW_LEN` 14 (x, z, fwd, length, width, 8 depths), written by
    `writeBoatFx` and decoded by `readBoatFx`. The hero and every rival draw it through vesselFx.
  - The transport parity hashes stay identical across transports; the layout length follows `FX_LEN`.
  - Shots at 20/30 m/s side views: the hollow is too subtle to see at that distance (a 0.2–0.35 m dip under the
    rooster root). Not claimed as a visible change.
- **Spray root / whisker spray** (`bowSpray.createBowSprayFleet`): the bow sheet leaves as motion-blur drops (2 cm,
  |v|·1/120 s), with density ×8, a pool ×4, killed at the water. The raft/pirate emitter is unchanged. No separate
  hull-surface root line was added.
- **Round-5 look `[M]`:**
  - Midday side/front-3/4 at 20–30 m/s: a tall rooster-tail arc from the drives.
  - Night: the lanes carry each boat's LED colour 20 m astern.
  - STILL OPEN: at the sunset drive-by the backlit plume reads faint and low; the 03 view at 5 kn still reads as a
    pale sheet under the drives (the area footprint did not change it, so the cause is likely the aerated tint or the
    reflection, not the lace band limit). Rival hollow and spray-root visibility not checked.

## 17. Round 6 (final): mist envelope, night lanes, the 03 sheet

- **Mist.** Opacity 0.13 → 0.05, radiance × 0.6, and a drifting metre-scale 3-D density field of each sprite's world
  position (`SprayPoolOptions.mistStructure`), so the envelope has clumps along the arc. The forward-scatter cap
  (`ROOSTER_PHASE_CAP`) is 8 → 3, so backlit plumes glow without clipping. The drops carry the detail.
- **Night lanes.** LED-on-wake gain 0.6 → 0.15, R 8 → 11 m, × smoothstep(0.05, 0.4, wake coverage): only the lane's
  foam catches it.
- **03 pale sheet: cause found by toggling each term in isolation** (aerated tint, white film, churn relief, contact
  line, slick damping; frozen frame, `wake/round6_03_before_after.png` has the fix). Only the WHITE film term removed
  it. Inside `wakeWhiteNode` there were two defects:
  - blending three fbm fields shrank the value spread to σ ≈ 0.1 about 0.5, so the ridge sat near its maximum and the
    gate passed almost everywhere — restored ×4 about the mean before ridging;
  - an unresolved filament field (a grazing close view) returned its mean, whose ridge is the maximum — the gate is
    now also retired by the filament field's own coordinate footprint, and the unresolved fallback is (1 − √edge)².
  - Also edgeFresh 0.12 → 0.22 and SLIP_DRAW_GAIN 80 → 40.
  - Result: dark reflective water with a broken white boil at 5 kn.
- **DOF contract changed under us:** `core/skyDof` now exports `POST_PARTICLE_LAYER` (a coverage pass, spray in
  focus), not `postParticleLayer`/`particleDefocus`. Spray meshes `layers.enable(POST_PARTICLE_LAYER)`; the
  per-particle defocus growth was removed with that API.
- Final 8-view sheet: `wake/round6_final.png`. It predates the ridge-spread fix, which only changes the white film's
  pattern; the 03 frame after the fix is `wake/round6_03_before_after.png`.

