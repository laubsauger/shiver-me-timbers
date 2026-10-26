# Terrain and atmosphere: diagnosis and plan (2026-10-26)

Research pass by a read-only agent, done during the three.js 0.186.1 upgrade. Nothing here is built yet. Water is
out of scope except for a note; bird flocks are a separate topic.

Path roots: `SMT/` = this repo, `TS/` = /Users/flo/work/code/terra-sim.

**Baseline caveat.** There is no capture of the current build. The R3 frames in `docs/raft2100/lookdev/R3/` were
shot on 2026-08-22 at fd4450b, before B96 (the zeroed blue channel that turned the islands chartreuse), T122 (the
sheeting lattice), T130 (the re-profiled, shallower islands), T119 (cloud lighting and circular edges) and B122 (the
cloud quad painting over everything beyond 500 m, which made the Half Dome look transparent). The diagnosis combines
those frames with the current code. Step 0 below is a fresh baseline.

## 1. Diagnosis

The look is bad for structural reasons. Tuning will not fix it.

**Landform**
- Islands are radial primitives plus fbm noise plus monotone remaps (`src/island/heightmap.ts:638-718`), not eroded
  landscapes. Stream-power erosion runs 0 iterations on the dome and 12 on the ridge and cirque
  (`src/params/sierra.ts:746-748`). There is no sediment transport or deposition, so there are no fans, spits, bars
  or shelves.
- Beaches are a height remap: `beachApron` (`heightmap.ts:345`) and `profileApron` (`:413`) give a constant-width sand
  ring that follows the contour line.
- The scale contradicts the premise. Three slice islands of radius 150–280 m with crests around 21–25 m, spaced
  500–700 m apart (`sierra.ts:574-601`), plus two fillers and the Half Dome on a 128² grid over 480 m (7.5 m per
  texel, so it reads as a smooth cone; `sierraSites.ts:333`, `sierra.ts:582-588`). Nothing sits on the horizon beyond
  about 2 km. A flooded Sierra should read as the peaks of one drowned range.

**Surface shading**
- No value range: every sierra layer is a warm grey within about 0.15 lightness of the others (granite `a39e92`, grus
  `cdb98f`, polished `b0b9c2`, fractured `7b7368`; `sierra.ts:631-649, 803-845`). There is no green ground cover.
  After ACES each island collapses to one value.
- Grain, lichen and macro noise are projected on world XZ (`src/island/sierraMaterial.ts:426, 473`), so they streak
  on cliffs. Joints and sheeting are still drawn as darkening lines in the albedo (`:444-464`).
- Flat light: screen-space AO is off (`src/params/post.ts:96`), the ambient is a flat hemisphere light
  (`src/sky/lighting.ts:90`), and there is no cloud shadow anywhere.
- The terrain fragment stage uses 8 of its 9 sampler slots (`src/island/terrainInfo.ts:11-17`, §V40).

**Atmosphere**
- Haze is one colour with an XZ-distance smoothstep from 750 m to 4600 m, raised to the power 1.7
  (`src/terrain/aerialPerspective.ts:119-137`, `src/params/oceanSurface.ts:869-872`): 0–3 % at 1–1.5 km, so islands
  there read as cut-outs. There is no height falloff, no sun-direction lobe (§V47 asks for one), no split between
  extinction and in-scatter, and no blue shift with distance.
- The sky is a hand-authored 3-stop gradient (`src/sky/skyBackground.ts:17-22`). §B93 is open: `sunColor`
  (`sunCycle.ts:79`) and `lowSunWarmth` (`:218`) ramp on different schedules, so the sun stays near white under a warm
  sky at sunset.
- The radial cirrus streaks (T126b) also show by day.

**Clouds**: a 2.5D design (polygonal cores, blur, camera-pinned quad; §V11, `src/clouds/cloudComposite.ts`). In R3
they are flat grey-violet blobs with no common base, no perspective rows toward the horizon and no altitude layers,
and they cast no shadow.

**Vegetation**: pines are 3–4 stacked 8-sided cones, at most 300 triangles (`src/vegetation/pineGeometry.ts:8-12`);
manzanita and juniper read as hexagonal umbrellas. No grass, dune grass or meadow. The placement logic in
`sierraScatter.ts` is sound; the geometry and the missing ground layer are the problem.

**Grade**: effectively none. All four LUT strips are identity (`assets/lut/README.md`), and lift/gamma/gain and split
tone are at identity (`src/params/grade.ts:42, 50`). The output is plain ACES.

## 2. Target look

"Hokusai pushed to modern rendering" (`rift/docs/init.md:88-106, 168-175`), with Sea of Thieves parity as the floor
(§V43).
- Value in print layers: dark saturated foreground, a midground shifted toward Prussian blue and indigo, background
  ranges as pale blue silhouettes in banded haze.
- Limited inks: pale warm sand, ochre-grey granite, deep pine green, indigo shadows, a vermilion-to-peach accent at
  sunrise.
- Readable landforms (From Dust): granite domes with exfoliation shells, talus aprons, drainage ending in fans and
  spits, beaches whose width follows wave exposure, dune grass behind the berm.
- Low-sun light: warm key, cool sky-lit shadow side, cloud shadows sweeping the water, forward-scatter glow toward the
  sun.

## 3. Approach, ranked by payoff per effort

| # | What | SMT files | From terra-sim | Size | Frame cost |
|---|---|---|---|---|---|
| A | Island lookdev harness: one island, no raft sim; URL seed/archetype/tod/view/tonemap; fixed views (deck eye at 60 m and 200 m, beach eye, 45° aerial, plan, 1.5 km, 4 km) | new `src/island/lookdev.ts` (pattern: `speedboat/lookdev.ts`), one Vite input | `TS/src/lookdev.ts` | S | 0 |
| B | Grade, tonemap, palette: A/B ACES vs AgX vs Neutral; dawn/noon/dusk LUTs via `grade.bake`; widen value range (rock darker and cooler than sand, foliage darkest) | `core/grade*.ts`, `assets/lut/*`, `params/grade.ts`, `params/sierra.ts` | split tone + S-curve, `TS/src/render/post.ts:127-140` | S | ~0 |
| C | Aerial perspective v2: closed-form height-exponential fog; in-scatter = sky colour along the ray + sun colour × Henyey-Greenstein forward lobe; per-channel extinction. One function for terrain, props and ocean (replace `aerialHazeFactor`/`aerialOutputNode` and the ocean's ramp at `ocean/surfaceMaterial.ts:1277, 2495`, §V77) | `terrain/aerialPerspective.ts`, new `params/atmosphere.ts`; `island/islandMaterials.ts:146-184` is the hook for props | the idea of hazing toward the same sky function (`TS/src/render/backdrop.ts:53-63`) | S–M | ~0.1–0.2 ms |
| D | Far-field ranges: low-res silhouette strips of drowned ranges at 3–15 km | new `island/farField.ts`, `island/archipelago.ts` | none | M | <0.3 ms |
| E | Cloud shadows: world-space 512² cover texture around the camera from cloud cluster sites × coverage noise, multiplied in terrain/ocean/foliage `receivedShadowNode` | `clouds/cloudCores.ts`, new `clouds/cloudShadow.ts`, terrain and ocean materials | shadow step in `TS/src/atmo/clouds.ts`, used at `TS/src/render/terrain.ts:464` | S–M | ~0.15 ms, needs one sampler |
| F | Landform v2: erode a range, then flood it (steps below) | `island/heightmap.ts`, `island/erosion*.ts`, `island/sierraArchetypes.ts`, `island/sierraSites.ts`, `island/terrainInfoBake.ts`, `params/sierra.ts` | `TS/src/sim/hydro.ts` (pipe model), `TS/src/sim/erosion.ts` (capacity ∝ √q·S·depth, deposition in standing water, talus incl. `talusWave` :63/:274), `TS/src/sim/climate.ts` (orographic precipitation, rain shadow) | L | 0 per frame; 1–3 s bake or offline asset |
| G | Terrain material v2: layers keyed on sediment × slope × wetness × exposure; ragged height-blend edges; one mipped tileable detail texture (R broad, G mid, B fine, A ridged), triplanar on steep faces, replacing ~5 noise fields; vertex Laplacian cavity; turn on SSAO and measure; split `sierraMaterial.ts` (1037 lines) | `island/sierraMaterial.ts`, `terrain/rockMaterial.ts`, `terrain/sandMaterial.ts`, `params/post.ts:96` | `TS/src/render/textures.ts:93-114`, `TS/src/render/terrain.ts:139-146` (cavity), `:192-312` (layering) | M | neutral or cheaper |
| H | Vegetation v2: clump-card conifers (trunk/branch skeleton + alpha-tested needle cards, keep the cluster-normal bake, impostors at distance per T120); GPU slot-grid ground cover (dune grass above high water, bunchgrass in moist hollows, patch noise, distance thinning) | `vegetation/pineGeometry.ts`, `vegetation/sierraScatter.ts`, `vegetation/impostor.ts`, `vegetation/cull.ts`, `terrain/groundCoverMesh.ts` | `TS/src/life/flora.ts` (jittered slot grids, refresh kernel, compaction to indirect draw args), `TS/src/life/geometry.ts` | M–L | ≤1 ms at 1440p for the fine cover |
| I | Cloud forms within §V11: shared condensation base, rows receding to the horizon, a high altocumulus/cirrus layer for sunrise colour; fix §B93 with one low-sun ramp | `clouds/*`, `sky/sunCycle.ts` | density and weather-map ideas from `TS/src/atmo/clouds.ts`, `TS/src/atmo/noise3d.ts` | M | ~0 |
| J | Film only: raymarched cloud volume (port `TS/src/atmo/clouds.ts`), footprints in beach sand. Needs §V11 amended for an offline path | `cine/*` | as I | L | offline only |

**F in steps**
1. One master heightfield 6–12 km across (~1024² at 8 m); archetypes become uplift stamps, not final shapes.
2. Stream-power erosion for many iterations to lay down drainage (`island/erosionStream.ts` exists).
3. Pipe-model hydraulic erosion with sediment transport and deposition.
4. Thermal talus.
5. Wave erosion: coastal ground relaxes toward a gentle slope above the water, rubble fills the shelf, so beaches and
   shelves emerge instead of being painted on.
6. Flood at sea level; each island is a connected region above water.
7. Re-erode each playable island in a 512² window at 1 m, then run the T112b path carve.
8. Bake sediment thickness, flow, wetness and wave exposure for G and H.

**Water, later**: shallow turquoise over the new deposited shelves, swash and foam keyed to the real beach profile
(§V72 already keys on depth), and a decision on planar reflections for the dome.

## 4. Order of work and the lookdev checks

0. New baseline (R4): harness A plus `raft.html?tod=6.2|12|17.8` at the R3 views (dome, ridge, cirque, far 1.5 km,
   vegetation close-up), with per-pass GPU ms from timestamp queries (§V39).
1. B: same views under all three tonemaps, user picks. Pass when rock, sand and foliage are ≥ 0.15 apart in OKLab
   lightness at noon.
2. C and D: islands at 0.5/1.5/4 km sit on a steady value ramp; land and sea at the same distance differ < 1/255 at
   the shoreline (CPU-mirror test as today); haze toward and away from the sun differs at tod 6.2 (§V47).
3. E: a tod 12 time-lapse from the deck shows shadow patches crossing sea and land.
4. F: plan view shows a drainage tree, fans and spits; beach width varies with exposure; §V90 and T112b tests stay
   green; stepping ashore works on at least 3 bearings (T130).
5. G, then H: beach-eye and 45° views at tod 6.2 and 17.8 beside `docs/inspo/island/*.png`.
6. I and J, then the T112h painterly pass last.

## 5. Risks and open questions

- Fulldome breaks per-view tricks: the camera-pinned cloud quad, screen-space god rays, planar reflection, DoF and
  SMAA will not stitch across cubemap faces. Decide the dome pipeline (e.g. 5-face cubemap → domemaster) before
  investing in I. There is no "The Drift" shot list or look document in this repo yet.
- §V11 forbids raymarched clouds: accept an offline-only volumetric path for the film?
- World premise: small walkable islets, or the summits of one kilometre-scale drowned range? F assumes the range with
  high-res windows for playable islands. Biome: Sierra granite and grus, or the softer pale sand and grass the film
  describes?
- Determinism (§V2): GPU float erosion is not bit-identical across devices. Proposal: bake offline to a shipped asset,
  which also helps boot time (§B98, T128). Pirate island hashes stay pinned.
- Sampler limit (§V40): terrain is at 8 of 9; E and G each need one, so pack the horizon planes (e.g. an array
  texture) first.
- Start C, G and H after the 0.186.1 upgrade lands. The upgrade also brings `CSMShadowNode`, which would give island
  shadows beyond the ship-centred 80 m shadow map.
- Frame budget (§V17): D and the fine ground cover in H are the risky items; each needs its own graphics toggle (§I).
