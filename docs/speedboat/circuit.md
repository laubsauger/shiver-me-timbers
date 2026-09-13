# Tower Reach circuit and the race island kit (§T.187)

Status 2026-09-13 (T187b, see §T187b at the end): course data, kit terrain, runtime, preview harness, the course asset
pipeline and all 6 furniture GLBs packaged checker-OK; roof colliders in; browser look checked headless (tab was hidden).

```
src/circuit/towerReachLayout.ts   authored layout in the SWELL FRAME (islands, gates, marks, pylons, tower, Main Street)
src/circuit/kitFamilies.ts        race island kit: sandCay (+ bar), rockGarden, drownedTown → sierra family hook
src/circuit/towerReach.ts         towerReachSites(seed) → sites;  buildTowerReach(seed, {heightmaps, seabed}) → world
src/circuit/shelter.ts            reference-sea swell-shadow K (fetch field over the circuit seabed)
src/circuit/courseLine.ts         centripetal Catmull-Rom line, mark arcs, contours, simplification
src/circuit/raceSeabed.ts         physics seabed with sandbar pass-through (BedHeight for §T.188)
src/circuit/courseColliders.ts    StaticCollider[] for src/sea-physics/boatCollide.ts (poles flexible, buoys, stakes, pylons, mast, anchors)
src/circuit/validateCourse.ts     runtime Course validation (what the types cannot say)
src/circuit/courseFurniture.ts    instanced GLB furniture, water lighting, bob hook, lamps, cables
src/circuit/preview.ts            circuit-preview.html harness
scripts/blender/course/           course asset build (Blender modules, checker, packager, renders)
src/circuit/assets/courseAssetContract.json   ONE furniture contract (Blender, checker, runtime, tests)
```

## Page wiring

```ts
const layout = towerReachSites(seed);                       // registers the kit families, no terrain baked
const sea = buildSea(app, state, sky, weather, { sites: layout.sites, … });
const world = buildTowerReach(seed, {
  heightmaps: sea.archipelago.islands.map((i) => i.heightmap),
  seabed: sea.archipelago.seabed,
});                                                         // world.course is the src/race/types.ts Course
const furniture = await createCourseFurniture({ renderer, data: world.furniture, course: world.course, seabedAt: world.seabedAt });
scene.add(furniture.group);
// per frame: furniture.update({ camera, time, dt, waterHeightAt, nextElement, startLamps, startGreen })
```

## The lap

Authored in the swell frame of the shipped default sea ('swell', "Working sea", travel bearing 1.68π): u down-swell,
v = u turned +90°. On a top view the design doc's map reads straight. Every turn is to port.

| Element | Sector (measured) | K | Width | What it tests |
|---|---|---|---|---|
| S start/finish | sheltered | 0.04 | 72 m | lee of Tower Cay, under the western guy |
| G1 | sheltered | 0.22 | 70 m | top of the Tower straight |
| T1 hairpin | – | – | r 28, line 48 | lift, hold trim |
| G2, G3 The Bar | exposed | 0.95, 1.00 | 110 m | head sea (170°, 171° to the swell), the bar between them |
| T2 → G4 Pylon Row → T3 | exposed | 1.00 | 80 m | beam sea (90°), between two drowned power lines |
| G5 Stuff Run | exposed | 1.00 | 90 m | following sea (10°) |
| G6 Main Street | sheltered | 0.37 | 46 m | down the drowned street between the roofs |
| G7, G8 lee chicane | sheltered | 0.27, 0.22 | 42, 50 m | lee of Knuckle's rock garden |

Numbers at seed 1965; `buildTowerReach(seed).gates[i].k` is the live value. **Lap 4100.7 m** (2.2 nm = 4074 m, +0.65 %).
Corridor (±14 m) keeps ≥ 6.2 m of water everywhere but the bar. Bar crest in the corridor: 2.5–2.7 m over seeds 1, 42, 777, 1965, 2100 (sheltered K ≤ 0.38, exposed K ≥ 0.94 on all of them). Main Street: 34 of 35 houses break the surface (ridges up to +2 m, chimneys and parapets higher), steeple and water tower stand 11–17 m proud.

**Sectors are measured.** `sectorOf(K)` splits at 0.65, and tests require every gate DECISIVE (K ≤ 0.5 or ≥ 0.8) on an
independently built shelter field, so a small change in the shadow model cannot flip a tag silently. K is taken on the
reference sea (frozen `weatherPresets.swell.ocean`), not the live params: a sector gates Surge earning and must not move
when the player picks Calm. Other sea states rotate the lee with their swell; that is the sea working.

## Gates

`MIN_GATE_WIDTH = 40 m`: two boats abreast (2 × 2.47 m beam) with three beams between them, the National AI line
tolerance ±9 m each side, and 3 m of pole flex/wash per pole: 4.9 + 7.4 + 18 + 6 = 36 m → 40 m. At 42 m/s a 1° heading
error is 0.7 m/s of drift, so 40 m is forgiving at speed and still a chicane at 40 kn. Fast gates are wider (70–110 m).

Gate orientation is perpendicular to the reference line at the gate; `left` = port looking along the course (■ board),
`right` = starboard (▲ board). The start gate carries chequer boards.

## Race island kit

New families, not the pirate or Sierra sites (user). Each authors ONE height field for land and water and rides the
sierra pipeline through a registry hook in `src/island/sierraArchetypes.ts` (`registerSierraFamily`, `kit:` names):
land goes through sink⁻¹ → coast noise, beach apron, T130 profile, erosion, granite/DG-sand material, rocks and plants;
water is pulled onto the authored depth by the `shape` hook, so contract depths (bar crest, bench, corridor) are exact.

| Family | Island | Shape |
|---|---|---|
| sandCay | Tower Cay | curved lens (Chaikin spine, warped outline), foredune on the swell side, swale, back dune, shelving beach |
| sandCay + bar | Bar Head | small drying cay + a detached, asymmetric bar (long gentle swell back, short slip face, sand waves, broad shoal apron at 9 m); crest never above −crestDepth |
| rockGarden | Knuckle | chain of lobed granite whalebacks with ridged joints + a clustered boulder field (elongated tilted slabs, awash to +5.5 m) on a warped rock platform |
| drownedTown | Main Street | river-terrace bench at −7.2 m (warped two-octave outline, 0.4 % street grade, an old creek groove behind the east houses) + a two-lobed knoll |
| (furniture) | Pylon Row | two parallel drowned power lines, 7 pylon tops, cables at runtime |

**Hook proof (bit-identical pirate/raft islands).** sha256 over the heightmaps of `generateIslandSites(1)`,
`generateIslandSites(1965)` and `generateSierraSites(1965)` (grids + archetypes + sierra meta): `7c23cb56e24f4af5…`
before the hook and after every edit to `sierraArchetypes.ts` (script run 2026-09-13). tests/circuit.test.ts also checks
that registering kit families changes no built-in grid in-process, that an unregistered `kit:` name throws, and that a
name cannot be rebound.

## Sandbars never ground a boat

1. **Terrain:** `BAR_MIN_CREST_DEPTH = 2.0 m` (design doc says ≥ 1.5). Static keel ≈ 0.55 m (5.35 t on a 24° vee, derived
   in the test from deepV12.hull.json), so 1.4 m clear. Tested along the whole crest, not only at the crossing.
2. **Physics hook:** `createRaceSeabed(world.seabedAt, world.bars)` returns the seabed with a smooth pass-through to
   −6 m inside each bar zone (half-width × 1.4 + 40 m skirt). §T.188's terrain contact should read THIS field, not
   `archipelago.seabed`: a landing plunge off the bar's own breaker is deeper than any static margin.

## Ramps over the bar — NEEDS AN OCEAN HOOK

The engine shoals by ATTENUATION ONLY (§V72, deliberate). Over the crest the swell cascade keeps `tanh(k·d)`:
**0.23 at 2.0 m, 0.26 at 2.3 m, 0.29 at 2.6 m** (k floored at π/(0.6·45 m)), and `breakerClip` never fires below storm.
So today the bar is the CALMEST water on the lap, the opposite of "biggest air". The design needs an ocean-owner term:
Green's-law growth (Ks > 1) ahead of a depth gradient plus a breaking crest profile keyed on a bar mask or on
∂depth/∂x along the swell, with its CPU twin in `CpuOcean` (§V8). The circuit exports the bar crest polylines
(`world.bars`) if a mask is the cheaper route.

## Other hooks needed from other owners

- **§T.188 collisions (src/sea-physics/boatCollide.ts):** statics = `prepareStaticWorld(courseColliders(world))`
  (src/circuit/courseColliders.ts: gate poles flexible r 0.6 with id = element index, buoys r 1.35, stakes r 0.2,
  pylons r 2.9 y −4→12, mast r 1.6 with its lean y −4→30, guy anchors r 0.7, and Main Street's `roofColliders`).
  `BedHeight` = `createRaceSeabed(world.seabedAt, world.bars).heightAt` (sandbar pass-through; boulders are in the bed).
- **sim-worker (docs/speedboat/sim-worker.md blockers 1–2):** the NPC mirrors float on open-ocean depth with no fetch/
  shadow. They need the archipelago seabed (1024² half-float, `seabed.texture` data + origin/size) and the fetch field
  (`fetchField` R/G arrays + `version`) copied to the worker, or the circuit's sites rebuilt there (heightmaps bake in
  ~1 s for all four kit islands).
- **src/race/types.ts (additive, optional):** `Course.lapLength` (m), `Gate.width`/`Gate.number` (the HUD's gate number;
  today via `world.gates`), `Course.hazards` (bar crest polylines), `Course.swellDirection` (the reference bearing the
  sectors were measured on).
- **speedboat page (`page/course.ts`):** `CourseHook` builds `course` before the sea; Tower Reach needs two phases (sites →
  sea → course). Grid slots: the pace line's last 700 m ends on the start gate midpoint.
- **§V95 duplication to fold:** `courseFurniture.ts` has its own 10-line GLTF + KTX2 + meshopt loader setup, the same as
  `speedboat/assets/boatModel.ts`'s; that setup belongs in `core/` for both.
- **flowfoam:** furniture InstancedMeshes straddling the water are tagged `userData.foamTarget` (`furniture.foamTargets`);
  whether the injection capture draws InstancedMeshes is unverified.

## Assets

`node scripts/blender/course/build-course.mjs [--asset name|all] [--bake-size 1024] [--ao-samples 16] [--threads N] [--work dir] [--render dir]`

Same pipeline as the boat parts, by import: `parts/kit.py` geometry and finishing, `parts/bake.py` per-slot atlas pack,
Cycles CPU data bakes and the numpy wear compositor, `parts/looks.py` looks and patterns (course looks and patterns are
registered on top in `course_kit.py`), `sb_conventions.py` export. Numerals and lettering use the HUD's stencil face
(assets/fonts/speedboat/SairaStencilOne, OFL). Wear follows STYLE-SPEC §5.2's legibility guards (daymarks, numbers and
chequers stay crisp; faded, never dirty).

Contract: ≤ 4 materials from `C_Steel C_Paint C_Build C_Lamp`, ≤ 4 textures each, per-slot atlas fractions
(`slotTextureScale`, global, overridable per asset), identity transforms, one node per
variant per LOD (`<Variant>_LOD<n>`, extras `lodLevel`, `variant`), budgets per PLACED INSTANCE (`instances`), roofs'
eave/ridge/top table checked against geometry, KTX2 full mips + meshopt at the final stage. `checkCourseGlb.mjs` gates
the build; tests/circuitAssets.test.ts proves it fails on the breaks it guards.

| Asset | Variants | What it is |
|---|---|---|
| course_gate_pole | Spar, Strobe, BoardSquare/Triangle/Chequer, Numeral1–8 | spar marker on a drum float, flex coupling, tape, battery + solar amber strobe, daymark bracket |
| course_turn_buoy | Buoy, Lantern, Tag1–3 | salvaged pillar buoy, chequer band, cage with chequer daymarks, solar, LED lantern, radar reflector |
| course_bar_stake | Stake | timber pile, hazard wrap, tape, barnacles, yellow X topmark, BAR plate |
| course_pylon | Pylon, Insulators | 230 kV lattice top from −14 m, trussed arms, glazed insulator strings, hazard band, danger plate |
| course_radio_tower | Mast, Hut, LampRig, StartLamp1–5, StartGreen, Beacons, GuyAnchor | 110 m banded triangular mast (4° list), race control shack + pontoon, lamp boom, beacons, anchor floats |
| course_roofs | Gable, GableChimney, Hip, Shed, Steeple, WaterTower | whole buildings from the old ground floor: clapboard houses, brick false-front store, church, water tower |

Tri/draw/MB per asset: printed by the build summary; the shipped numbers are in §T187b.

## Verification

- `npx vitest run tests/circuit*`: contract, lap, gates, corridor, measured sectors, three swell headings, bar crest +
  physics pass-through, minimap, determinism, hook; asset contract, checker mutations, placements vs geometry (roofs
  poke, stakes reach the floor, cables ≥ 8 m, guys leg→anchor and ≥ 12 m over the course, lamp board faces the grid).
- CPU renders: `--render <dir>` on the build (hero, detail, clay, LOD strip per asset).
- Browser: `circuit-preview.html?cam=overhead|start|bar|pylons|street|tower` (keys 1–6), `window.__circuit`.

## T187b (2026-09-13): packaging fix, rebuilds, review

### The tower lost its lamp texture: root cause

Not packaging. `course_kit.build_asset` computed the UV pack margin from the ASSET atlas (`size // 256` = 8 px at 2048)
and applied it to the lamp slot's atlas, which `slotTextureScale` had just shrunk to 256². A 16 px pad per island on
256 px packed all 89 lens islands to zero area (extras `courseTexelDensity.C_Lamp`: uvUsed 0.0, coverage 0.0), so the
compositor wrote its "outside coverage" fill (0.5 grey, alpha 0) over the whole atlas. The raw checker only asks that
an emissive texture exists, so raw passed; then gltf-transform `prune()` (v4 default `keepSolidTextures: false`) folded
the four solid textures into factors and deleted them, and the final checker failed. The pole and buoy would have hit
the same thing on their rebuild (128² lamp atlas, 8 px pad).

Fixes: the margin is in pixels of the slot's own atlas; the Blender build fails loud if any slot atlas comes out under
5 % used or covered; the packager passes `keepSolidTextures: true` (a slot's texture set is contract, not an
optimisation). The checker is unchanged. `tests/circuitAssets.test.ts` now also requires every shipped slot to carry
its bake (coverage and uvUsed > 0.05), because with solid textures kept the final checker alone can no longer see an
empty atlas (verified: the test failed on the broken tower GLB before the rebuild).

### Shipped numbers (bake 1024, AO 16)

| Asset | MB | Instance tris LOD0/1/2 | Draws | Atlases (px/m exterior) | Textures MB |
|---|---|---|---|---|---|
| course_gate_pole | 2.31 | 5356 / 1473 / 129 | 5 / 5 / 4 | Paint 1024 (65), Steel 1024, Lamp 128 | 1.94 |
| course_turn_buoy | 2.47 | 6504 / 1436 / 168 | 4 / 4 / 3 | Paint 1024 (96), Steel 1024 (138), Lamp 128 | 2.19 |
| course_bar_stake | 0.83 | 2924 / 532 / 32 | 3 / 3 / 2 | 3 × 512 | 0.70 |
| course_pylon | 4.08 | 15508 / 3402 / 1318 | 4 / 4 / 3 | Steel 1024 (38, was 25), Paint 1024, Build 1024 | 3.31 |
| course_radio_tower | 7.60 | 34937 / 4916 / 447 | 20 / 20 / 16 | Paint 2048 (77), Steel 1024 (26), Build 512, Lamp 256 | 6.24 |
| course_roofs | 3.90 | 4046 max (Steeple) / 758 / 88 | 3 / 3 / 2 | 3 × 1024: Build hero 16, close 32, Paint 41, Steel 19 | 3.44 |

Roofs per texture (MB): Build base 0.13 / ORM 0.52 / normal 0.37; Paint 0.11 / 0.55 / 0.43; Steel 0.14 / 0.83 / 0.36
(11.69 → 3.90 MB). Tower: Paint 0.48 / 2.87 / 1.22, Steel 0.14 / 0.75 / 0.43, Build 0.04 / 0.13 / 0.09, Lamp 0.08 total.
The tower is over 4 MB on purpose: it is the one landmark seen from every sector and sat in front of for the whole
countdown; its C_Paint (mast bands, hut, boards, banner) keeps 2048². Its glass and pontoon (C_Build, 2 pieces) and its
steel drop to 512² / 1024² via the per-asset `slotTextureScale` (was 14.1 MB with everything at 2048).

### What changed in the assets

- **Roofs:** texel budget moved to what breaks the surface. Walls under the water (house eaves sit ≤ 1.5 m) are `low`
  tier with no hidden top/bottom faces; roof undersides are split off `low`; gable triangles and roof faces `hero`,
  brick chimneys a new `close` tier (4×); the store's false front `hero`; 2 px pads on the ~1000 trim/steel islands.
  Roof and spire faces are now shingle/shake COURSES in geometry (a 35 mm sawtooth, one step per 0.2 m of height,
  on the texture's own course lines, one param-UV island per slope, plain slab at LOD1+): a flat textured slab is what
  went mushy at a boat's grazing angle. Looks: salt crust, grime and chips cut (they baked as white camouflage blotches).
- **Tower:** ladder rails in 3.2 m lengths (one 85 m tube was one 85 m UV island that forced all C_Steel to 24 px/m and
  10 % of the atlas); chequer banner on the course-side railing (design doc "checker banner"); relay dishes at 44 m
  and 67 m, FM ring bays at 83–91 m and coax runs (they break the 110 m stick into a landmark); the lamp board border
  and tape are mitred frames (butted members overlapped at the corners and baked AO-black squares).
- **Pylon:** chequer boards on the two faces the boats pass (design doc "checker band"), gusset plates instead of node
  cubes, galvanising with fewer pits and less salt.
- **Pole:** mitred border/tape frames (same black-corner bug), cleaner stencil numerals. **Stake:** the X topmark's bars
  are bolted one over the other (crossed in one plane they baked a black diamond). Buoy: rebuilt only.
- Renders: `render_course.py` stages the tower with its placement's 4.3° list.
- **Runtime:** `createCourseFurniture` sets anisotropy on every furniture texture (renderer max, optional
  `maxAnisotropy` cap for the quality presets; `stats().anisotropy`). Before, KTX2 atlases sampled trilinear only.
- **Colliders:** `roofColliders(placement)` in src/circuit/courseColliders.ts, included by `courseColliders(world)`:
  anything within a hull's draft of the surface (top > −0.6 m) collides. Pitched roofs: one capsule along the ridge at
  the waterline, radius = the roof's half-width there (+0.2 m); chimneys r 0.6; the store's false front (two stacked
  capsules) and tin roof (three sloped capsules); the church tower r 2.15; the water tower's braced frame r 4.3 and tank
  r 3.95. Tested: every building that breaks the surface is solid at the waterline and at its ridge, a house sunk below
  the draft stops colliding, no roof capsule reaches the ±14 m corridor.

### Verification

- Every build exited 0 with checker OK (raw + final); last runs 2026-09-13 20:35–20:47.
- Inherited, flagged: the previous session lowered the guy-over-course bound in tests/circuitAssets.test.ts from 12 m
  to 8 m (lowest guy point in the ±15 m band is 9.96 m; the reasoning is a ~5 m jump). Worth a user decision.
- `npx vitest run tests/circuit*`: exit 0, 41/41 (circuit 22, circuitAssets 19).
- `npx tsc --noEmit`: exit 2, only tests/assetPipelineChecker.test.ts (3 × missing exports from
  scripts/blender/checkGlb.mjs, another agent's uncommitted work); src/circuit, scripts, tests/circuit* clean.
- Browser: the Chrome-extension tab stayed `document.hidden` and never finished booting (another page held the
  foreground), so the preview was driven headless (Chrome --headless=new, WebGPU, CDP) at 1600×900, storm cells off.
  Readout at the tower preset: frame 204 draws / 3.17 M tris (the sea dominates); furniture 52 draws, 175 instances,
  66 k tris, LOD 4/5/65; ~64 MB estimated GPU texture memory for all furniture; anisotropy 16×. Street: 61 draws, 49 k tris.

### Self-critique (against STYLE-SPEC §5 and the design doc: 2100 drowned Sierra foothill towns, salvaged race furniture)

- **Tower — good, not yet hero-grade.** The list, guys, bands, dishes, hut and lamp board read in the water-level shot,
  and the lamps are finally red/green. From 150 m+ it is still a thin stick (true to a guyed mast); the landmark read
  rests on the runtime lamps and guys. The hut is a box with a board; no interior light, no cable spaghetti, no crowd of
  salvage (fenders, jerrycans) on the pontoon. Next: a lit window at dusk, pontoon clutter, a larger banner.
- **Roofs — decent mid-tier.** The courses fixed the flat grey slab and the chimneys now read as brick, but the houses
  are still boxes: no porches, window frames or sagging ridges, no tide line or weed at the waterline. The Build atlas
  is 16 px/m on roof faces and 8 px/m on gable triangles, so clapboard and glass go blocky within ~10 m. The slate is
  a little too blue-grey and even. Next: tide/algae band from the placement's floor in the runtime shader, sag and a
  missing-shingle patch, porch roofs on two variants.
- **Pylons — the best of the set.** The silhouette, insulators, hazard band and chequer boards read at course distance
  (Pylon Row shot). Galvanising is still a little bright and speckled up close.
- **Pole, buoy, stake — solid.** Legible at speed, clean stencils, wear stays faded not dirty. The stake's timber pile
  is plain brown; the barnacle crust only shows at the base.
- **Preview presets:** `bar` looks past the stakes at open water and does not show the bar; the ramps need the ocean
  hook (§Ramps over the bar).
