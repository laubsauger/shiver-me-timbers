# SB-12 hero hull shell: build log and self-critique

Status, 2026-09-13: the hero hull replaces the pipeline-test hull in the default build. `node scripts/asset-build.mjs`
writes `assets/models/speedboat_hero.glb` (hero hull, 17 hero parts), and the raw and final checkers pass.
`node scripts/asset-build.mjs --pipeline-test` still builds the stand-in `speedboat_pipeline_test.glb`.

## How it is built

| Step | Where |
|---|---|
| Section, rings, LODs, UV atlas, plates, number field | `scripts/blender/hull/hero_hull.py` |
| Cycles CPU data bakes, numpy compositor, glyph strip, non-skid detail, runtime-equivalent previews | `scripts/blender/hull/hull_textures.py` |
| CPU preview renders (raw GLB + the build's preview maps) | `scripts/blender/hull/render_hull.py` |
| Integration | `build_pipeline_test.py --hull-kind hero` (new flag). `asset-build.mjs`: hero is the default, `--pipeline-test` builds the stand-in, the 4th texture per hull slot is attached from `hull_textures.json`, and the clearcoat texture slots are UASTC-packed |
| Runtime | `src/speedboat/assets/livery.ts` (new, pure), `slotMaterials.ts`, `boatModel.ts` (`HERO_BOAT_URL`, `livery: BoatLivery \| hex`) |

**One quad grid.** The hull is stations × ring points with a constant topology. The section is:
- keel arc (a cutwater radius growing to 22 mm at the stem) and a keel pad aft
- three strakes: flat underside, bevelled running edge, vertical outboard face
- chine flat with a bevelled outer edge
- forward spray rail
- vertical topsides easing into the 8° flare
- deck-edge radius, then flat deck columns and the cockpit well columns (lip radius, wall, sole fillet)

So:
- The shell is one closed manifold per LOD.
- Every LOD is an index subset of LOD0's vertices, so LOD1 and LOD2 reuse the LOD0 bake exactly.
- The cockpit well is part of the same grid. Well rings move the "well" columns down to the sole. A flat ring 12 mm
  away closes each end wall, so no booleans are needed.

Ring stations are spaced 0.15 m aft, 0.07 m forward, and closer in the strake fade and well corner zones.

**Bow.** Forward of the last station the checker slices (chine half-beam > 0.1, z 11.41), each section is the
z 11.41 section scaled:
- in x, to the proxy sheer half-beam, then rounded into a nose over the last 7 cm;
- in y, onto a Hermite stem profile. It leaves the keel line tangentially and reaches the deck at the stem head
  (z 12.00), which gives a rounded forefoot and a raked stem.

A fan closes it. The nose stays ~15 cm wide at the deck because the proxy's `halfBeamAt` floor is 4.6 cm, and the
parts' fairlead, bow light and rub rail sit on it.

**Deck and well from the parts sockets** (`anchors.py`):
- The well runs from the JSON aft end (2.4 m), with 22 cm plan corners.
- Its forward end follows the windscreen base curve (`windscreen.py`), 5 cm inboard. The screen flange therefore
  lands on the deck everywhere and the well wraps round the screen, as in concept 02.
- The sole is 0.75 m below the sheer.
- Deck hardware, the arch (now at 3.2 m), grab rails and vents all land on the deck (renders `deck34`, `top`).

**Salvage plates (STYLE-SPEC §5.3).** The starboard bow doubler and the aft starboard chine plate are thin closed
slabs, 3.5 mm proud, in LOD0 only. The compositor also paints them onto the shell texels, so LOD1/2 still show them.

## Materials and textures (7-slot plan kept)

The hull uses `M_Gelcoat` (topsides, bottom, transom, plates) and `M_NonSlip` (deck, well). Antifoul is folded into
the gelcoat. Hull (2) + parts (4) + `M_Pilot` = 7. The GLB has 6 materials, and `M_Antifoul` is gone.

The hull adds 5 textures and shares 3 of them across both slots. Each slot uses 4 (§V40):

| Texture | Size, codec | GPU (8 bpp + mips) | Content |
|---|---|---|---|
| `hull_baseColor` | 2048² ETC1S | 5.33 MB | Gelcoat islands: RGB overlay colour, A overlay coverage over the livery paint. Deck islands: real colour, A non-skid coverage |
| `hull_normal` | 2048² UASTC | 5.33 MB | chips, filler edges, crust, rivets, scrapes, hatch gaps, panel steps |
| `hull_orm` | 1024² UASTC | 1.33 MB | AO (parts as occluders), roughness, metal (plates, bronze plugs) |
| `hull_mask` | 1024² UASTC | 1.33 MB | `M_Gelcoat` only, as `KHR_materials_clearcoat.clearcoatTexture`. R band, G pinstripe, B antifoul: signed-distance fields, 0.5 at the edge, anti-aliased in the shader with `fwidth`. A = wear ramp. The 0–9 stencil glyph strip sits over the deck row (never sampled by `M_Gelcoat`) |
| `hull_nonslip_detail` | 512² UASTC | 0.33 MB | `M_NonSlip`, as `clearcoatNormalTexture` (factor 0, pilot precedent). Moulded diamond non-skid, tiled at 10 cm, faded out at 4–12 m |

- **Hull: 13.67 MB.** The whole boat GLB is 55.67 MB GPU (parts 42.0 MB, hull 13.67 MB). With the pilot set
  (~20 MB, pilot-log) the total is ~76 MB, under the ~85 MB shared budget.
- The GLB file is 14.7 MB.
- The atlas is 12.13 m across 2048 px: **169 px/m**, above the chase-cam 125 px/m floor. It is length-bound: the
  12 m shell islands cannot go smaller without seams mid-hull.

**Livery per boat (no per-boat textures).**
- `userData.boatLivery` holds topsides, band, stripe, antifoul, numeral colour, dominant hue and race number
  (`FLEET_LIVERIES`: hero 27, yellow 8, turquoise 41, charcoal 63).
- `liveryTint` (one hex) still works and recolours the band and the cowl tops.
- The number is a planar field in ship-local metres on each topside:
  - centred at z 4.9 m (hull frame), 0.6 m tall;
  - read left→right from outside on both sides;
  - one or two cells sampled from the glyph strip with the gradients of the continuous coordinate, so there is
    no mip seam between the digits.
- `M_Carbon` cowl tops take the dominant hue, keeping the baked shading by the luminance ratio against the hero
  orange. This is the parts agent's requested fix, done slightly better than the one-liner so chips survive.
- The Blender previews evaluate the same formula per texel (`preview_albedo`), so the variant renders show what
  the shader draws. The preview does not recolour the cowls: parts textures are used raw there.

**Wear (baked at the hero level 0.85, the ramp exported for a runtime threshold later).**
- chips to the laminate at chines, strake edges, keel, stem and transom corners, with lighter old-gelcoat rings
- band and pinstripe flaking at their edges, which reveals the topsides hue per livery
- speckled overspray halo on the band edge
- sanded fairing-compound patches with primer halos: four on the topsides, one on the transom, one grey on the
  bottom
- feathered filler and a sealant bead round the bow doubler
- riveted plates:
  - steel rivets with rust streaks on the chine plate; salt streaks on the doubler
  - tea staining under the stern and spring cleats and the tow eyes
- salt runs; the salt crust band and ≤ 8 cm algae line at the waterline
- antifoul:
  - sun bleach and older-coat patches
  - worn to primer at running edges
  - lime scale, barnacle scars aft and at the chine
  - longitudinal grounding scrapes
- chalk ghosts of old speed chevrons; mismatched repaint panels
- deck:
  - bone borders, the hatch frame with a salted gap, vent cut-outs
  - rust halos and spider cracks at hardware bases
  - worn walk paths, well sole border, drain slot

**Legibility stats** (`hull_textures.json`, §5.2):
- 98 % of band texels carry less than 25 % overlay (the guard is ≥ 70 %).
- Mean overlay on the band is 0.06, and on the number field 0.08.
- Numeral weathering is baked into the glyphs (chips, drips, brushed edge): 1.4–2.4 % of each digit's paint is
  lost (measured against the clean stencil), under the 20 % guard. It may be too light against concept 14a. The
  wear-ramp threshold adds nothing mid-topside.

## Numbers

| | LOD0 | LOD1 | LOD2 |
|---|---|---|---|
| Hull tris (budget 40 000 / 7 000 / 1 800) | 26 816 | 4 648 | 555 |
| Whole boat tris (contract 120 000 / 20 000 / 6 000) | 90 417 | 13 525 | 3 192 |
| Draws, whole boat (budget 24 / 10 / 8) | 20 | 8 | 6 |

- The hull is 2 primitives per LOD, where the pipeline-test hull had 3.
- **Physics fit** (checker section rule at 0 tolerance, all 240 proxy stations): the worst chine residual is 1 mm
  (z 11.36) and the worst sheer residual is 2 mm (z 8.15, the deck-edge radius). The rule allows ±20 mm. Stem,
  transom, keel and deck are on the proxy.
- Gates: `node scripts/asset-build.mjs` exit 0, raw + final checker OK. `npx tsc --noEmit` exit 0.
  `npx vitest run tests/assetPipeline*`: 40/40.
- Build time is about 6 min (hull bakes ≈ 40 s at 2048²).
- Final GLB sha256 `45845414113abc70`, 14.7 MB. The renders come from the previous build (`9df9189e`); the only
  change since is AO forced open on the shell texels under the plates, which fixed black plates at LOD1
  (`hero34_lod1.png` was re-rendered from the final build).

## Self-critique against the concepts (renders in `scratchpad/hull/final/`)

| Area | Holds up | Weak |
|---|---|---|
| Bottom / airborne (`below`, `close_chine`) | The V, three strakes with crisp flats and running edges, and the chine flats read strongly from below and bow-on. Bottom paint is mottled, scraped and worn to primer at the edges | At 1–2 m the antifoul is still a fairly even colour field. There are no real barnacle clusters (§5.2.6 keeps them sparse) |
| Chines / strakes | Real geometry with bevel arcs and weighted normals: flats stay flat, edges catch light | The strake ends taper to 4 mm rather than a moulded run-out. The keel pad is subtle (1.7 cm) |
| Bow (`close_bow`, `hero34`) | Raked stem, rounded forefoot, spray rail, trapezoid doubler with a sealant bead | The nose is ~15 cm wide at the deck (proxy floor plus parts). It reads blunter than concept 07's knife tip. The doubler rivets are barely visible at 169 px/m. The doubler looks like a flat card at distance |
| Transom (`close_transom`, `rear34`) | Rolled edge, band wrap, drain plugs, tea stains, filler patch | Plain next to concept 04. There is no moulded bracket pad: the parts' aluminium plate covers that area |
| Deck (`deck34`, `top`, `chase`) | Close to concept 02: bone borders, charcoal non-skid, hatch frame and gap, centre seam, fore-hatch ring, well following the screen. Parts sit on it | The deck is flat (no crown: parts assume the flat proxy deck). Panel lines are texture-only (1–2 px at chase range). No moulded coaming lip |
| Wear | Heavy but legible. Fairing patches, plates, stains and the waterline crust give "rebuilt many times" | The topsides between the band and the boot line are cleaner than the concept renders. Most of the concepts' fine scratch webs are sub-texel at this density |
| Livery / number | Band, pinstripe and boot edges are crisp. The hand-painted stencil numerals are legible at chase and side range. Rivals recolour correctly | The numeral font is an owned geometric stencil, simpler than 14a's brush stencil. On dark topsides the plates and filler patches read brighter than on bone |

## Deviations and asks for other owners

1. **Parts (not my files):**
   - The bracket's transom plate is a rectangle down to about keel height at x = ±0.96, so its outer bottom corners
     hang below the V bottom (visible in `close_chine`). It should be clipped to the transom outline.
   - The coaming pads run straight to the JSON forward end. The well now curves in along the screen from
     z 4.76 m, so their forward ends sit under the foredeck, hidden.
   - The rub rail follows the proxy sheer. It matches the hull everywhere, including the ~15 cm nose.
2. **Physics JSON:** no field is needed. The render nose width follows the proxy's `halfBeamAt` 4 % floor. A
   sharper bow would need that floor lowered on the physics side.
3. `docs/speedboat/asset-pipeline.md` "Output today" and its lookdev steps still name the pipeline-test GLB (not my
   file). `assets/models/speedboat_pipeline_test.glb` is no longer read by any test or runtime path. It already
   showed as modified in git before this pass; delete it or rebuild it with `--pipeline-test`.
4. **Not built:**
   - the runtime wear-level threshold (the ramp ships in mask A)
   - patchwork vertex-colour panel IDs (§5.5)
   - the browser lookdev check. The shader compiles under tsc and parses through GLTFLoader in the tests, but it
     has not been drawn on a GPU yet.

## v2, 2026-09-13: fixes after the new physics JSON (deck 1.30 m, stem half-beam fraction 0.005, flare knuckle 0.19 m)

Coordinator review of the hull2 renders, and what changed:

1. **Race number clipped into the band.**
   - Every painted height now comes from the live JSON topside (`hero_hull.HeroHull._layout_setup`, `band_lo`,
     `stripe_centre`, `boot_y`):
     - band 24 % of the transom topside (clamped to 0.12–0.24 m)
     - pinstripe gap and thickness likewise scaled with the topside
     - boot line at the rest waterline, clamped to the chine
   - The number field is sized into the clear topside between the pinstripe and the boot line, with 5 cm
     margins. It shrinks to fit, and the build fails loud below 0.18 m. At 1.30 m depth the numerals are
     **0.31 m tall** (concept wants ~0.6 m; there is no more clear topside).
   - The field and its clear band are written to the M_Gelcoat extras (`clearTopside`). `checkGlb.mjs liveryErrors`
     fails the build when the number leaves that band (±3 cm), when the band leaves < 0.10 m under the deck, or
     when the number drops below the proxy chine. Covered by a new test in `tests/assetPipelineChecker.test.ts`.
   - Scuffs, decal ghosts, repaint panels and repairs are placed by topside fraction, not absolute heights.
2. **Bow defects.**
   - *Dark slit:* the knuckle blend (0.3·(deck − chine)) reached down past the spray rail once the knuckle sat
     0.19 m above the chine. The topside ring points went out of order and folded. The blend is now clamped
     above the chine bevel, the rail sits just above the proxy chine height, and the build fails if they cannot
     fit.
   - *Black rectangle:* the bow doubler's top (0.40 m below deck) had fallen below its bottom (chine + 0.17) on the
     shallower topside, producing an inverted, inside-out slab. It now spans the pinstripe bottom → chine + 0.07,
     moved aft to z 9.55–10.70, and fails loud if under 0.10 m tall.
   - *Spoon forefoot:* the Hermite stem is replaced by the proxy's own stem: keel parabola to the forefoot, then
     the straight JSON `stemRake` line to the deck, joined by a 2 cm smooth-max radius. Clay renders show a clean
     straight raked cutwater; sections still scale to the proxy's (now pointed) sheer.
3. **Fairing patches.**
   - Six grey blobs become three masked, squarish sanded-filler repairs on the topsides, plus one primer repair on
     the bottom and one on the transom.
   - Each has a bone-toned core with a different gloss (roughness 0.62), a thin shrink line, and a wide feathered
     sanding halo: dulled, swirled paint.
   - The build refuses a repair placed over the race number.
4. **Parts below the hull at the transom (parts owner).**
   - Measured from the GLB: the bracket's transom plate bottom is at body y −0.496 (hull y 0.243), across
     x = ±0.989.
   - The hull transom bottom there is body y −0.347 (hull y 0.392), so the plate hangs **0.149 m** below the hull
     at the outer corners. The overhang starts where the V bottom drops below 0.243, at about |x| 0.58.
   - `checkGlb.mjs transomOverhangWarnings` prints this as a warning on every build, not a failure.
5. **Docs and GLB.**
   - `docs/speedboat/asset-pipeline.md` now names `speedboat_hero.glb` and documents `--pipeline-test` and
     `render_hull.py`.
   - `assets/models/speedboat_pipeline_test.glb` was **not deleted**. Grep still finds references outside docs:
     `scripts/blender/pilot/pilot_config.json` (the active pilot agent's socket provenance note),
     `PIPELINE_TEST_BOAT_URL` in `src/speedboat/assets/boatModel.ts`, and the `--pipeline-test` build path.

**v2 numbers** (`node scripts/asset-build.mjs`, exit 0, raw and final checker OK, sha256 `caeb2d4b595e592e`, 14.9 MB):
- tris per LOD 90 417 / 13 520 / 3 397; draws per LOD 20 / 8 / 6
- hull textures 13.67 MB GPU
- worst chine residual under 1 mm, sheer 2 mm
- band clean fraction 94 %
- `npx vitest run tests/assetPipeline*`: 41/41
- `npx tsc --noEmit` currently reports errors only in other agents' in-progress files
  (`tests/assetPilot.test.ts`, `src/audio/boat/rpmModel.ts`), none in hull or asset files.

Renders: `scratchpad/hull/v2/{hero34,rear34,side,below,close_bow}.png`.

**Honest read.**
- The bow is now a clean raked stem with no slit or black patch.
- The number sits fully in bone, but reads small at 0.31 m.
- The repairs read as repairs rather than smudges, although at chase range they are subtle.
- The doubler is plain flat aluminium at this distance.
- The bottom still reads as an even colour field up close.

## v3, 2026-09-13: last hull pass

1. **Livery edge aliasing.**
   - The runtime was already an SDF mask thresholded with `fwidth` (`aaStep`). The mask fields themselves had
     two defects:
     - hard `sd > 0` / `sd < 0` steps exactly at the 0.5 contour (flake and overspray terms), which snapped
       the edge to the texel grid;
     - ~2 cm noise baked into the 1024² SDF, which aliased into a serrated edge.
   - Both are fixed: smooth weights, and only ≥ 10 cm edge wobble (V48).
   - The Blender previews now evaluate the runtime formula at 2× the atlas (4096²), with a derivative-width
     threshold like `aaStep`. `close_bow` shows smooth band and pinstripe edges.
   - No resolution change: mask 1024², hull still 13.67 MB GPU, ≤ 4 textures per slot.
2. **Race number: option (c), both.**
   - *Side:* the band and pinstripe step up around the number (the band loses 62 % of its width over
     z ± 0.78 m with 14 cm ramps, all from the live layout). The side numerals grew from 0.31 m to **0.45 m**.
   - *Foredeck:* a painted gelcoat number panel, 1.24 × 1.10 m at z 6.55–7.65 m, carries **0.78 m** numerals.
     - Glyph up is the bow, reading from aft or above.
     - The panel faces are `M_Gelcoat` with their own UV island, so the per-boat mask/uniform system paints
       them: topsides hue plus numeral colour.
     - The deck well columns widen on the foredeck to frame the panel, with a bone border in the non-skid.
   - Shader: `slotMaterials.ts` picks side or deck coordinates by `normalLocal.y` with one glyph sample, using the
     gradients of the continuous coordinate.
   - Checker: `liveryErrors` also fails a deck number that leaves its panel. The test covers both numbers.
3. **Bow doubler.**
   - Double staggered rivet rows as geometry (LOD0, closed 6-sided domes, ~2.7k tris, both plates). The same
     pattern goes into the texture for LOD1/2.
   - Darker 9 mm sealant bead with relief; white aluminium-oxide halos and dark galvanic bleed streaks under
     the doubler rivets (rust stays on the chine plate's steel rivets).
   - Broad oil-canning relief and tone in the normal and albedo.
4. **Bracket (took over `scripts/blender/parts/bracket.py` for this fix).**
   - The transom plate is an extruded polygon whose bottom edge follows the hull V from the JSON
     (keel → chine at the transom, + 5 cm clearance for the pad and strakes).
   - Bottom chords, diagonals, bolt rows and the bottom skin start from the same clipped edge.
   - `checkGlb.mjs transomOverhangErrors` is now a **failure**. Test: a slab 0.35 m under the synthetic V fails,
     one above it passes. The hero GLB passes.
5. **Bottom.**
   - Antifoul tone patches (fresh, faded, dark) in hull-shaped bands.
   - A brown-grey scum line at the rest waterline under the algae and crust.
   - Strake and chine running-edge wear from the strake table.
   - Flow streaks baked in hull-shaped coordinates: vertex attribute `sb_frac` (fraction of the chine
     half-beam) × length, so the streaks follow the strakes and converge at the bow.

**v3 numbers:**
- `node scripts/asset-build.mjs` exit 0, checker OK (raw and final), sha256 `4829b868527a3f21`, 15.0 MB
- tris per LOD 93 341 / 13 702 / 3 461 (hull LOD0 29.5k); draws 20 / 8 / 6
- hull textures 13.67 MB
- chine residual under 1 mm, sheer 2 mm
- `npx vitest run tests/assetPipeline*` 42/42

Renders: `scratchpad/hull/v3/{hero34,close_bow,rear34,below,top,foredeck,close_chine,close_transom}.png`.

**Honest read.**
- Band and stripe edges are clean up close.
- The stepped band reads as deliberate livery, and the side number is legible at hero34 range.
- The foredeck "27" is big and clean from aft (`foredeck.png`); it reads upside down in the bow-down `top` render.
- The doubler rivets read as rows of dark dots rather than bright domes (small scale, grazing light).
- The bracket now sits inside the transom outline.
- Bottom variation is visible but restrained. At distance the antifoul is still mostly one colour.

## §T.192, 2026-09-13: water inside the hull, doubler proudness

**Water mask (USER: "we see water poking through the boat's bottom").** Diagnosis, case (a): the rest waterline
(≈ 0.60 m above the keel, `hero_hull.waterline`) stands above the cockpit sole (0.55 m), so the drawn sea surface passes
through the open well at rest and on every crest. The shell is closed at every LOD (rule 7), so the well opening is
the only window. The build now writes root extras `waterMask` = {y (deck), soleY, outline} — the well opening's lip
edge + 2 cm, from `HeroHull.water_mask()`, failing loud if it comes within 5 cm of the deck edge. The runtime caps the
opening with a depth-only mesh drawn after the opaque boat and before the (transparent) ocean
(`src/speedboat/assets/waterMask.ts`): no ocean change, no sampler, no discard. Checker `waterMaskErrors`: on the deck,
covering every sole vertex of LOD0 (interior vertices only), inside the deck edge; the hero GLB test fails an outline
shrunk 20 %.

**Bow doubler** stands 5 mm proud (was 3.5 mm, chamfer 2.5 mm): at 3.5 mm its forward corner came within 2 mm of the
bulging bow section over 6 × 3 cm (the new §V98 checker rule).

**Deck shape (USER: "the back and the top of the boat are too flat. a bit of a taper like in our initial reference").**
Render-only, from manifest `anchorsNotInHullJson.deckShape`, applied to every ring (`HeroHull._deck_shape`) and to
every part that stands on the deck (`anchors.deck_surface_y`):
- camber: the deck falls away from the centreline as a parabola, 4.5 cm at 1.23 m half-beam
- aft taper: the aft deck slopes down to the transom over its last 2.3 m, 7 cm at the transom (smoothstep)
- sheer edge radius 15 → 35 mm
- the deck centreline forward of the taper stays on the proxy deck, so the checker's deck ±2 cm, the section rule and
  the water-mask height still hold; the well walls and sole do not move (the lip drops with the camber, the well is
  2 cm shallower at its sides).

**Deck livery (USER: player colour band, white band, rubber non-skid).** Runtime paint on `M_NonSlip`, no new
texture: plan distance from the deck outline measured off `Hull_LOD0` (`boatModel.measureDeckEdge`, 64-entry uniform
array) → 0.17 m band in the boat's dominant hue (round the transom edge, closing to a point at the stem), 0.05 m
bone-white band, then the baked non-skid field; the paint lifts the non-skid relief and is satin.

## §T.200, 2026-09-14: the livery reaches the GPU, a bold side stripe, two-tone cowls

USER playtest: "we could use a stripe of player color on the side of the boat. and maybe a band of white on the bottom
big bucket section of the engines so they are not totally solid in player color."

**Root cause: the shipped GLB carried none of the livery masks.** gltf-transform's KTX commands pick the encoded
channels from each slot's glTF meaning (`getTextureChannelMask`). An OPAQUE material's baseColor went out RGB only, and a
`clearcoatTexture` R only. Decoded from the T192 GLB (`ktx info`: `ETC1S_RGB` without an alpha slice, `UASTC_RRR`):
- `M_Gelcoat`/`M_NonSlip` baseColor had no A. The runtime read overlay = 1, so the hull drew the baked overlay colour (bone
  topsides, red bottom) with no paint: no band, no pinstripe, no rival topsides (the T197 grid shot's hulls are all bone).
- `hull_mask` had R only (G = B = R when sampled), so the pinstripe and antifoul fields were wrong and the wear ramp was gone.
- `M_Carbon` baseColor had no A. The cowl livery mask read 1 everywhere, so the whole slot (lower cowl, midsection, lower
  unit) took the livery hue: the "solid orange top to bottom" cowls.

The Blender previews never showed it, because they sample the PNGs before packaging.

Fix (`scripts/asset-build.mjs encodeDataTextures`): those four textures are encoded in-process with `ktx create` at the
CLI's own settings, but keeping RGBA (ETC1S q160 sRGB; UASTC level 2 + zstd 18, linear). The CLI steps then skip them.
The final checker's `liveryChannelErrors` reads each KTX2 Data Format Descriptor and fails a boat whose livery textures
lose a channel. The test fails the pre-T200 RGB/RRR encoding, and the old GLB failed it with 4 errors.
- GPU cost: on BPTC/ASTC devices (the WebGPU targets) ETC1S transcodes to 8 bpp with or without alpha. That is the 8 bpp
  already in the texture table above, so the ledger is unchanged. A BC1-only device would pay 4 → 8 bpp for those 3 maps.

**Side stripe (mask R band, G pinstripes; no new channel, no shader change).**
- The sheer band is the player-colour stripe. It was 0.19 m (0.16 m visible under the rub rail). It is now 0.36 · topside,
  clamped to 0.14–0.30 m: **0.28 m** at the 0.79 m transom topside, about 0.25 m visible. It narrows to about half at the
  bow doubler, where the rising chine leaves a short topside (`band_lo`: 1 − 0.6·zn^2.2; a 30 % taper did not leave the
  doubler 0.10 m).
- Around the side number the band gives up 75 % of its width (was 62 %).
- A secondary pinstripe, half as thick with a 0.6× gap, runs under the first. G is the union of both SDFs in the same
  stripe hue.
- `stripe_bottom_depth` now means the lowest line, so the number field, clear-topside extras and checker rule, doubler
  top, fairing patches and transom repair all follow it.
- The side numerals shrink **0.45 → 0.42 m**: the price of the bolder band.
- The deck band (T192, dominant hue at the deck edge) wraps over the sheer into the hull band on every boat.

**Rival liveries (`livery.ts`, taken over after T197).** The §T.197 one-colour rows (topsides = band = dominant) hid the
stripe, the deck band edge and the cowl split. Every boat now wears the hero's scheme: a neutral-ish base, ONE signature
hue on the band, deck band and cowl tops, and a pinstripe that contrasts with both. The signatures are T197's hues, so the
roster's HUD/plotter hues still match.

| Boat | Base | Signature | Pinstripe | ΔE00 band/base |
|---|---|---|---|---|
| hero | bone `#E9E5DA` | orange `#E4572E` | teal `#1F4E5F` | 38 |
| dome-ten | charcoal `#2B2F33` | yellow `#FFD21F` | red `#C8372D` | 73 |
| outer-bar | wet-sand bronze `#5A4F42` | lime `#6CC24A` | bone | 45 |
| bench-hollow | sand `#CDBFA3` | wine `#7A1F2B` | black | 56 |
| pine-cut | white `#F4F3EE` | olive `#6B6B1E` | black | 45 |
| levee-town | concrete white `#D7DADB` | black `#141414` | red | 78 |
| solar-ridge | taupe `#A89C84` | violet `#6A3FD0` | black | 50 |
| the-stills | graphite `#3A3D40` | hot pink `#F25CB0` | bone | 42 |

- `tests/speedboatLiveries.test.ts` checks signatures ≥ 25 apart, no sea lookalike (≥ 15), HUD hue = signature, and
  band = dominant. It adds a new rule on every boat: band vs base ≥ 30, pinstripe vs base ≥ 25, pinstripe vs band ≥ 15.
  The old one-colour row fails that rule.
- The old "hulls ≥ 20 apart" rule is dropped. Neutral bases collide by design (bone/white ΔE 4), and identity rides on
  the signature.
- Not mine: `ui/roster.ts` COMMUNITY_PAINTS `hull`/`accent2` still describe the one-colour boats for the HUD hull art
  (`ui/hullArt.ts`). `hue`/`accent` still match.

**Renders** (`render_hull.py`): M_Carbon is now recoloured with the runtime cowl formula per `--variant`. New views
`farchase` (22 m back, 7.5 m up) and `farchase34`. `hull_textures.FLEET` carries the eight grid rows (a test fails on
drift from livery.ts) and the build writes a preview for each.
