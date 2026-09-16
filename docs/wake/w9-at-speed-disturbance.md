# W9: a planing hull visibly works the water (T211 + B125(b))

Status: code and CPU tests green; browser shots at 1080p (sunset R1 duel, R3 night pack) and a pack perf check. Date: 2026-09-15.
USER (1080p trailer): "at high speed the hull and engines barely disturb the water"; "chasing behind a rival, the boats
read as floating". They expect heavy, visible water thrown sideways and aft. In the R1 low front 3/4 both V bottoms
show with no contact cue.

Legend: `[M]` measured in this repo. Tests: `tests/wakeAtSpeedDisturbance.test.ts` (new), plus the churn-core term in
`tests/wakeFoamReadability.test.ts`. Scratch (gitignored): `tests/zzScratchW9Contact.test.ts`, `tests/zzScratchW9Hollow.test.ts`.
Browser harness, shots and grids: session scratchpad `w9/` (plan.mjs, tune2.mjs, perf.mjs;
`w9_sunset_before_after.jpg`, `w9_night_before_after.jpg`).

## 1. Before `[M]`

The cine R1 geometry had speeds held constant (hero 25 m/s, rival #8 30 m/s, 8.5 m to port) and cameras placed
relative to each boat. The R3 night pack ran as scripted (hero 25, pack 25–28 m/s).

- **Airborne water at a planing hull.** Only the rooster tail's 2.5 cm motion-blur drops (sub-pixel past about 10 m)
  and the bow whisker drops. Neither reads at 15–30 m. Nothing sat at the chines, the transom or the waterline.
- **Wake foam.** A readback of the near foam texture at 25 m/s found coverage 0.9 and freshness 0.9 across ±2 m at
  6–10 m astern. The W8 lace law still drew it as dark water with lace lines: fresh edge 0.22 gives 53 % white when
  resolved and 28 % when unresolved (a chase view).
- **Transom hollow.** It was present (L_h 12–16 m, 0.3 m deep) but invisible.
- The physics' planing contact (CPU tow of the deep-V, `HullWater.sections`):

| U m/s | keel wetted to body z | transom immersion | Wagner root at transom (chine 1.15) | trim |
|---|---|---|---|---|
| 20 | 4.3 m | 0.37 m | 1.29 → capped 1.15 | 2.7° |
| 25 | 5.1 m | 0.32 m | 1.13 | 2.2° |
| 30 | 5.1 m | 0.29 m | 1.03 | 2.0° |
| 35 | 5.1 m | 0.27 m | 0.95 | 1.8° |

The chines run dry, as the sea agent said. What was missing was the drawing of the wetted contact.

## 2. The contact, for every boat (`src/wake/planingContact.ts`)

It is built from her pose, the SHARED hull strips (§V110: every boat is the deep-V) and the surface points her effects
record already carries: the waterline centroid y and the drives' `surfaceY`. The same code runs for the hero and every
rival, and adds no record fields.

- The surface is a line along the hull through those two points.
- Keel immersion per strip: d_i = y_s(z_i) − y_keel,i.
- Wagner spray-root half-beam: c = min((π/2)·d/tan β, b_chine).
- The forward wetted point is where d crosses 0. The transom immersion is extrapolated from the two aft strips.
- Test: within one strip (0.83 m) of the physics' forward wet strip, ≤ 5 cm on transom immersion and ≤ 15 cm on the
  root at 20–35 m/s. Translating a boat's pose and record translates her emitters and changes nothing else (the rival
  parity test).

## 3. What it throws (`src/foam/hullSpray.ts`: one pool, 8 boats × 3 emitters)

**SHEET (spray root).**
- The spawn run is the root line, from the keel at the forward wetted point to ±c_t at the transom.
- The jet leaves the stagnation line reflected by 2θ, where tan θ = c_t/run. It runs up the V (deadrise β) and
  separates at the chine.
- World launch: outboard U·sin 2θ·cos β, up U·sin 2θ·sin β, forward U(1 − cos 2θ).
- Values: 25 m/s: 6.1 / 2.7 / 0.9 m/s (apex 0.37 m). 35 m/s: 7.5 / 3.3 / 1.0 m/s.
- Rate ∝ the waterline's lifted flux (physics).
- Seen abeam, it gives a broken white contact line along the aft half of the hull and a sheet off the quarter.

**BOIL (transom, prop wash).**
- Spawned across the hollow's width from the props aft over 3 m.
- Up = BOIL_LAUNCH_SHARE 0.3 × the props' rooster launch V_s·√e: 4.2 m/s at 25 m/s, 4.9 at 35. The floor is the
  hollow's plunge speed √(2g·d_t).
- Outboard is half of that, in proportion to where the clump was born, so the fan stays filled. Aft = the jet excess ΔV.
- Rate ∝ the drives' surface air Σ ventAirSpeed·A.
- Look calibration: a breaking sheet's thick rim and ligaments leave slowest (Villermaux 2007). The fine drops keep the
  full launch (the existing rooster tail); the heavy water is the mound.

**HUMP (hollow closure).**
- Spawned at 0.8–1.2 L_h aft of the transom.
- Up √(2g·d_max) ≈ 2.5 m/s.
- Rate ∝ the refill flux w·d̄·U × the plunge entrainment share (`sheetAirShare`).

**Speed gates.**
- Nothing below 6 m/s.
- Boil and hump × `dryTransomShare`, a smoothstep of the transom Froude number U/√(gT) from 3 to 5 (Doctors & Day
  1997; Maki 2006). A wet stern makes the solver's stern wave, not a hump.
- Measured on the tow (clumps/s, sheet / boil / hump): 8 m/s 1.3 k / 0 / 0; 12 m/s 3.9 k / 2.9 k / 0.7 k;
  25 m/s 5.8 k / 5.9 k / 0.7 k; 35 m/s 8.8 k / 7.1 k / 0.9 k. The W8 "white as soon as the engine runs" does not
  return (3 m/s: nothing).

**Sprites (`SprayPoolOptions.clumps`).**
- Torn lobed rims with a hashed phase and a flat opaque core.
- Born at 60 % of full size.
- Brightness jittered 0.45–1.25 per clump.
- Opacity × (1 − age)^2.5, and a clump is culled once faded below 1 %.
- Drawn half their size up, so a clump born at the surface is not cut by the ocean's depth.
- Normal blend.

**Lighting.**
- The rooster's `dropRadianceNode` (sun HG, sky fill, the boat LED pools), factored out and shared.
- Whitewater is optically thick: multiply-scattered share 0.85, lobe cap 2, key gain 0.6, sky gain 1.5.
- Evaluated per vertex (a varying): the eight-LED loop per fragment × pack overdraw was the cost.
- Measured with gains 1: clumps drew at sRGB (207, 98, 38) against the sky's (160, 96, 64) and the lace's (134, 88, 59).
  After: (166, 85, 50), the scene's own foam tone.

**LOOK CALIBRATION (stated).** Browser-tuned over ten sessions against R1 chase, front 3/4 and abeam, plus the night pack:
- densities: sheet 7000, boil 500 and hump 100 per m³/s;
- sizes: 0.65 m (sheet ×0.7, hump ×0.8);
- life 0.8 s, drag 1.4 /s;
- pool 32 768.

## 4. The rooster hump on the surface (`transomHollow.humpSamples`, `wakeSim` `lifts`)

At planing speed the linear solver cannot raise the closure crest: its free wave at 25 m/s is 2πU²/g ≈ 400 m long.
The closure therefore gets signed jet-type samples (negative load = lift):
- three samples at 0.85 / 1 / 1.15 L_h;
- a peak head of HUMP_HEIGHT_SHARE 0.6 × the hollow's deepest point × `dryTransomShare`, about 0.2 m at 25–30 m/s.

The hero's and each rival's lifts go into both solver tiers through `pushJet`, which keeps the sign. A jet head is
excluded from the churn foam (`simFoam` hullHead), so the hump makes no foam of its own. No shot claims the hump as a
separate visible feature. At 15–20 m aft it sits under the boil and hump whitewater.

## 5. The churn core in the foam (`flowfoam.wakeWhiteNode`, `WAKE_LACE.boil*`)

White edge = mix(lace edge, edgeBoil 0.03, smoothstep(0.55, 0.9, coverage) × freshness gate).
- Dense, fresh foam (the drives' boil and the planing core's first τ_A, about 13 m at 25 m/s) draws as churned white
  water: 83 % resolved, 69 % unresolved.
- Aged or thin foam keeps its lace.
- The W8 readability test (CPU twin updated) still holds at 30 m/s: white core ≤ 3 beams, below 0.5 at 40–60 m, lace
  at 40/60 m. At 2 m/s there is no white.

## 6. After `[M]` (grids: `w9/w9_sunset_before_after.jpg`, `w9/w9_night_before_after.jpg`)

- **Abeam, 25–30 m/s.** A broken white contact line runs along the aft half of the waterline. A churned white wash
  surges off the transom quarter under the rooster streaks.
- **Chase behind the rival at 30 m (30 m/s).** A heavy white mound and trail behind the drives, the two sheet wings,
  and the lane's core white beyond it. Before: dark water with lace lines.
- **Low front 3/4, 25 m/s.** Sheets and whitewater at the stern quarter, and a white contact band under the aft hull.
  The forward half still shows the dry V over its reflection. That is physical for dry chines: the root is under the
  bottom and the sheet exits aft. The remaining "hovering" there is B125(a), the mirror clip, which belongs to the
  reflection agent.
- **Night pack.** Every rival lays a visible grey-white whitewater trail. Spray near a boat takes its LED colour.
- **Rivals match the hero.** It is the same code (§2 test). The shots show #8's wash equal to #27's.
- **Not verified.** The night "rival abeam" camera framed empty sea both before and after (a harness targeting miss).
  The night abeam comparison is missing.

## 7. Performance `[M]` (race `?autopilot`, 8 boats, pack within 95 m at 16–20 m/s, under the shared GPU lock)

- Pool: 24 emitters, 8 boats planing, budget-capped at 40 960 clumps/s, 18.5 k alive.
- **Compute.** Step + spawn over 32 768 particles: 0.02 ms per tick (timestamp queries, loop stopped, 8 submits × 5).
- **Render.** Frozen frame, full scene with the pool visible vs hidden, 5 alternated pairs: +0.5 to +6.4 ms, median
  +5 ms on a 69 ms scene draw. A mesh-only draw by the same clock reads 20 ms, against 56 ms for the existing rooster
  mist pool and 10 ms for its drops.
- **Reliability.** The render timestamps in this headless, shared session are NOT trustworthy as absolutes (an empty
  scene read −167 ms; other agents' Resolve exports shared the machine between sessions). The relative order is the
  finding: the new pool costs less than the rooster mist and a few percent of the frame. An earlier 65 536-particle,
  per-fragment-lit version measured +10–13 ms and was cut to the numbers above.

## 8. Open

- **Front half of the hull.** No contact cue at planing speed beyond the mirror fix (B125(a)). A whisker-spray fan at
  the forward wetted point was considered and not added: the sheet's front end already starts there, and its world
  forward speed is small.
- **Hump visibility.** The hump is not measured as a separate surface feature (no height readback taken).
- **Budget.** In a tight pack the pool runs budget-capped: the nearest boats get full density, and far boats starve
  first (priority by camera distance).
- **Kill height.** The kill height is the emitters' mean surface, so a pack spread across a swell kills a few clumps
  early or late.
- **Concurrent work.** Another session is editing `flowfoam/index.ts`, `simFoam.ts`, `accumulation.ts` and
  `foamShading.ts` (oriented lace, area footprint). Their uncommitted hunks are not part of W9. The binding-budget test
  failure in `flowfoam/index.ts` (7 → 8 texture sites) and the `bandLimitAudit` count (182 vs baseline 176) come from
  that work and from other directories, not from W9's lines. `tests/spray.test.ts` "fold gate" already fails at HEAD
  inputs.

## 9. W10: where the round blobs come from (diagnosis; the cure is not in the tree)

USER on the same 1080p sunset grid (chase and rear-3/4 panels): the trail behind the boat reads as LARGE ROUND SOFT
BLOBS — bokeh, bubble-wrap — not churned water. Date: 2026-09-16.

**The source `[M]`.** `src/foam/sprayPool.ts`, the `if (options.clumps)` branch of the sprite FRAGMENT shader — the
pool this page built in §3, driven by `foam/hullSpray.ts`. It is not the lane's surface white (`flowfoam.wakeWhiteNode`
§5, which is band-limited and behaves), not a texture, and not the rooster/mist pools.

**Why it is a compositing failure and not a tuning value.** The pool is NORMAL-blended with an opaque core and runs
about 10 k clumps alive per boat (§7). At 10–30 m the only thing on screen is the FRONT-MOST sprite's silhouette: every
hole its own hashed mask carries is painted over by the sprite behind it, and its interior is never seen at all. §3
gave each clump its own noise phase on the stated reasoning that "no two clumps share an outline"; at this density that
reasoning inverts. Per-sprite breakup **cannot** draw churn at any tuning — it can only draw a mosaic of half-metre
discs, and the discs are the report. What is left visible of the W9 mask is its outline: a level set of a single
band-limited octave, which is a lobed circle.

**Two cures, one of them already in flight.**

1. *Make the sprite small enough and its silhouette elongated enough that no one disc reads.* The concurrent water
   session's uncommitted `hullSpray` change does exactly this — `sizeDeath` 0.65 → 0.5 m and the pool `streak`
   2.5 → 1.2 — and on its own it removes the blob read: the rear-3/4 trail becomes a torn fibrous mass.
   `[M]` 1080p, R1 duel at 25/30 m/s: session scratchpad `w10/shots/b1-head-rear34.png` against
   `w9/shots/after-sun-hero-rear34.png`.
2. *Carve the mask with a field of the WORLD POINT the fragment stands on*, shared by every sprite that overlaps there,
   so neighbours erode identically and the individual outlines stop existing. A sprite quad is offset in VIEW space
   (three's `SpriteNodeMaterial`: `mvPosition.xy + geometry.xy·scale`, and `q = 2·uv − 1 = 2·geometry.xy`), so the
   fragment's world point is `centre + (camera right·q.x + camera up·q.y)·½size`. A world-locked, slowly drifting fbm
   of that point sets both the erosion threshold and the window's radius; the threshold's half-width grows with the
   field's own coordinate footprint, so the far wake resolves to a soft pale trail (§V48b) with no seam against §5.

**Status of (2): prepared, measured, NOT adopted.** Patch parked at session scratchpad `w10/churn-field.patch`
(`sprayPool.ts` + its tests). It compiles, typechecks, the wake/spray suites stay green and `bandLimitAudit` goes
186 → 185. A six-variant browser sweep over live uniforms (`w10/shots/t2-v*.png`, 1080p, same cameras) says the idea is
right and my cell sizes are wrong: at 0.30–0.85 m the field is COARSER than a 0.5 m sprite, so it modulates whole
sprites instead of carving their interiors, coverage falls and the result is a regression against the current tree.
Flattening the window (v5: rim 0.35, falloff 0.7) brings the bokeh straight back, which is the diagnosis confirming
itself. Next values when `src/foam/**` frees up: cell 0.10–0.15 m (several cells across a sprite), no field modulation
of the window rim, erosion ≈ 0.30 — then re-tune against whatever `sizeDeath` the water session settles on.

**Ownership.** `src/foam/**` is held by the concurrent water session (`docs/water-review/AGENT-COORD.md`); the patch is
requested there and is deliberately not in the working tree. No perf delta is claimed: the change was never a candidate
for landing, so no 8-boat pack measurement was taken.
