# SB-12 hero parts: build log and self-critique

Status, 2026-09-13: every hero part except the hull shell and the pilot is modelled, UV'd, baked, LOD'd and
packaged by the one build (`node scripts/asset-build.mjs`) into `assets/models/speedboat_pipeline_test.glb`,
on the pipeline-test hull. The hull waits on the hero hull pass. The pilot waits on the concept revision.

## How it is built

| Step | Where |
|---|---|
| Manifest: parts, sockets, LOD targets, slots, texel tiers, budget | `scripts/blender/parts/manifest.json` |
| Sockets from the hull JSON (sheer polyline with the raked stem, transom, engine mounts and prop points, arch, seat, well) | `scripts/blender/parts/anchors.py` |
| Modelling kit (lofts, sweeps, bevel + weighted normals, per-island outward orientation) | `scripts/blender/parts/kit.py` |
| One module per part | `outboard.py prop.py bracket.py roll_arch.py windscreen.py dash.py governor.py governor_dial.py throttle.py helm.py seat.py deck_hardware.py salvage.py` |
| Looks (pattern shaders + wear parameters) | `scripts/blender/parts/looks.py` |
| UV pack, bakes, compositor | `scripts/blender/parts/bake.py` |
| Orchestration (LOD0 → bake → LOD join/decimate → budget gate) | `scripts/blender/parts/build_parts.py`, called by `build_pipeline_test.py --parts` |
| CPU preview renders | `scripts/blender/parts/render_parts.py` (`asset-build.mjs --blend <file>` saves the scene) |

The integration touched these pipeline files:
- `asset-build.mjs` gained `--parts`/`--no-parts`/`--blend`, and `--max-texture` now defaults to 2048.
- `build_pipeline_test.py` gained `--parts` and `--blend`, a `__main__` guard, an `M_Cockpit` material, and a
  loft that honours the JSON's `topsideFlareStartAboveChine` and stem rake (`deckZ`). Without the rake the stem
  check failed after the JSON update.
- `hullOffsets.ts` now dumps `engines`.
- `checkGlb.mjs` gained two rules: the STYLE-SPEC C3 section rule, and a hero-parts rule.

**Placement follows the JSON.** On this pass the physics agent moved the seat to 3.84, the arch to 4.8 and the
well to 2.4–5.4. The next build moved the whole cockpit, helm chain and salvage stack with it, and nothing was
edited by hand. Numbers the JSON doesn't carry yet (eye, dash, screen, antenna, outboard anatomy) live in
`manifest.json` as offsets from the JSON seat, each with its source.

## Budget split (proposal)

| | LOD0 | LOD1 | LOD2 |
|---|---|---|---|
| Hull shell (hero pass; the pipeline-test hull is 40.0k / 7.2k / 0.8k today) | 40 000 | 7 000 | 1 800 |
| **Parts (this log)** | **64 000** | **9 500** | **3 000** |
| Pilot | 14 000 | 2 500 | 800 |
| Margin | 2 000 | 1 000 | 400 |
| **Player total (contract)** | **120 000** | **20 000** | **6 000** |

The parts budget is enforced by `build_parts.py`, which fails the build when a total goes over.
Actual parts tris: see the table at the end.

## Texel density

Every slot's islands are averaged to one scale and multiplied by their tier: cockpit ×2, exterior ×1, low ×0.5.
The pack then fits them into the slot atlas.

What the cameras need:
- Chase cam at 7.5 m (60° vertical FOV, 1080p): about 125 px/m on screen, so exterior surfaces want ≥ 256 px/m.
- Cockpit cam at 0.5–1 m: 700–1400 px/m.

The achieved figures are in the final table.
- Exterior clears the chase-cam floor everywhere except the M_Metal trim sheet.
- Cockpit reaches 410–990 px/m. That is short of 1400 at 0.5 m, so sub-mm detail is carried by normal and
  roughness, not by albedo.

## Materials and bakes

Four part slots out of the contract's seven:
- `M_Carbon`: cowl paint, lower-unit paint, carbon, vents.
- `M_Metal`: trim sheet for stainless, aluminium, castings, props, rams, rubber and the rub rail.
- `M_Cockpit`: vinyl, webbing, gauges, tablet, Governor, jerrycans, cases, rope.
- `M_Perspex`: screen, gauge glass, lenses.

No `M_Rubber`: rubber lives in the trim sheet, so hull + parts + pilot can fit in 7. Each slot uses 3 textures,
under the §V40 limit of 4:
- baseColor, with A = the livery mask on `M_Carbon` and opacity on `M_Perspex`.
- ORM.
- A tangent-space normal.

Cycles CPU data bakes run per slot on one joined copy of the slot's pieces:
- position and world normal
- edge (Bevel-node curvature) and cavity (local AO)
- a look-pattern shader: carbon twill, pleats, gauge dials, tablet chart, solar cells, hazard band, cowl decal,
  knurl, rope
- three world-noise octaves
- per-piece wear
- AO

A deterministic numpy compositor then turns those into the textures:
- edge wear and repaint chips reveal the under-layer, and livery chips cluster at the edges (STYLE-SPEC §5.2.3)
- sub-cm scratches go to roughness and normal only
- cavities dull toward grey-beige, never soot ("faded, not dirty")
- salt crust sits on ledges and in cavities, with dried salt runs on vertical faces
- up-facing paint fades in the sun
- carbon-steel fasteners get rust halos and streaks; stainless ones don't
- stainless welds get heat tint (gold → blue → straw)
- castings and anodes get pits
- fastener domes and chip depth feed a micro-height map, turned into a normal map with slopes measured against
  the baked positions

The build fails loud on any non-finite texel and on any UV operator that doesn't finish.

## Animation contract (extras; nodes stay identity)

| Node | extras |
|---|---|
| `Outboard_<P/C/S>_LOD*` | `steerPivot`/`steerAxis` (swivel tube), `trimPivot`/`trimAxis` (tilt tube) |
| `Prop_<id>_LOD*` | `animRole: propSpin`, `pivot` (JSON prop point), `axis` +Z, `handed` (S is left-handed), `follows: Outboard_<id>` |
| `Helm_LOD*` | `animRole: wheel`, `pivot` (hub), `axis` (shaft) |
| `GovernorDial_LOD*` | `animRole: governorDial`, `pivot`, `axis`, `detents` −60/0/60 for OFF/AIR/FULL |
| `Throttle_LOD*` | `animRole: throttle`, `pivot`, `axis`, `idleDeg`/`fullDeg` |

The checker enforces the prop, outboard, wheel, dial and throttle extras (`partsErrors`, covered by
`tests/assetPipelineChecker.test.ts`).

## Per-part self-critique (against concept 01c/04/05/06b/09/10 and REFERENCES)

Preview renders: `scratchpad/parts/`.
- One 2×2 turntable per part: `part_<Id>.png`.
- Assembled views: `rear34`, `hero34`, `side`, `chase`, `rear_close`, `arch`.
- Cockpit views: `pov` (seat eye point) and `helm` (0.6 m).
- LOD checks: `far25_lod0`, `far25_lod1`, `far60_lod2`.

### Outboards (×3)
**Matches:**
- The silhouette reads as a tall boxy V8 cowl: orange livery cap, bone body, a real panel gap between chaps,
  upper cowl and cap, and a moulded character groove.
- Rear louvre vent, front gills, latches, fuel/primer cap, rigging grommet and hoses.
- Clamp brackets, tilt tube, swivel tube, two trim rams and a tilt ram with chrome rods.
- The lower unit has a foil midsection, anti-ventilation plate, zinc trim tab, torpedo, skeg and pickups.
- Starboard carries the riveted aluminium replacement panel (09); port and starboard carry the teal chevron
  decal (fictional mark).
- Heavy but legible wear: chipped cap edges, salt runs, lower-unit corrosion.

**Weak:**
- **Cowl tops sit about 0.26 m below the sheer**, where STYLE-SPEC §2 wants sheer + 0.60. The JSON puts the
  prop 0.35 m below the keel, and a 30-inch shaft on 450R anatomy then tops out at about deck −0.26. Only a
  higher prop point (about keel level) or a lower transom/notch recovers the concept's "cowls above the deck"
  look. This is a physics/hull call, not a parts call.
- The JSON prop disc is only 0.30 m aft of the mount plane (a real 450R is about 0.55). The lower unit is
  compressed to fit, so the prop sits under the cowl's front third.
- The cap orange drifts toward salmon under AgX studio light. The texture holds `#E4572E`, but a lookdev check
  in the real renderer is still owed.
- No "ETOH" stencil on the cowls: they're only on the deck fillers.

### Props (×3)
**Matches:**
- 4-blade cupped cleaver on helical pitch lines (0.66 m), skewed, thick-root/thin-tip.
- Splined hub with an exhaust flare and nut; left-handed on starboard.
- Separate spin node; reads cleanly after the smoothing pass.

**Weak:**
- The leading edges are still slightly lumpy in close-up (9×7 blade grid).
- No tip nicks or bent blade.
- Mostly hidden from the chase cam at rest, because the cowls occlude it. It shows once the boat trims up.

### Setback bracket
**Matches:**
- Welded aluminium truss box, set from the JSON setback (0.762) and engine spacing.
- Tread platform, mount plates with bolt columns and rust-streaked fasteners, zinc anodes.
- Steering tie-bar and hydraulic ram; rigging conduits from through-transom fittings.

**Weak:**
- Reads a bit "crate-like"; no lightening holes.
- Weld beads exist only as a normal-map ripple.
- The tie-bar is static while the outboards steer as separate nodes.

### Roll arch
**Matches:**
- Two raked Ø60 stainless hoops with bent corners, top rails, braces and flanged bolted feet.
- Weld beads and heat tint at the joints (09 top-right).
- Welded sleeve repair on a leg; solar panel on a frame; GPS dome with its red band; all-round light.
- 2.4 m whip on a ratchet mount and spring, with the coax cable-tied down the leg; hoop mirror.

**Weak:**
- **The JSON now puts the arch forward of the seat** (4.8 against the seat at 3.84). The concept has it aft,
  and the mirror and crossbar now enter the top of the cockpit cam. Confirm with the physics owner/user.
- Height is 0.90 above the deck per the JSON, against 1.30 in STYLE-SPEC.
- The coax path is approximate.

### Windscreen
**Matches:**
- Wrap-around smoked, scratched polycarbonate slab (12 mm) on the helm chain's base curve.
- Thin black anodised top channel, centre and end posts, rubber gasket, screwed flange.
- Sees just over the top from the eye, as in concept 05.

**Weak:**
- The rake is read as 35° **from vertical**. Literal 35° from horizontal put the top edge 0.33 m from the eye and
  filled the POV.
- The glass carries no crazing or chips; it has scratches and salt film only.

### Dashboard (+ gauges, tablet, VHF, switches)
**Matches:**
- Carbon console across the well with a gauge brow and a bolted face panel.
- Three gauges with bezels, tick rings, red zones, needles and glass.
- Rugged chart tablet strapped on with orange webbing; VHF handset on its clip with a coiled cord.
- Guarded toggles, a kill switch with a red coiled lanyard, and gaffer tape over a crack.
- Holds up at 0.6 m (`helm.png`).

**Weak:**
- No numerals on the gauge faces; ticks only.
- The console exterior is a plain box, hidden under the foredeck.
- The tablet's "screen" is baked albedo, not emissive (no 4th texture, see blockers).

### Governor module + dial
**Matches:**
- Bolted box with a rusting bolt set, brushed plate and hazard band.
- Raised-paint labels (GOVERNOR / OFF / AIR / FULL), readable at 0.6 m.
- Detent ticks, green/amber/red lamps, brass cable gland with its cable.
- A separate knurled dial node with detents in extras.

**Weak:**
- The labels are geometry text: crisp, but about 1k tris.
- The lamps are not emissive.

### Throttle quadrant
**Matches:**
- Three ganged throttles with red anodised handles and a tie bar; a trim lever with a black knob.
- Brushed plate with slots and screws on a carbon pedestal at the pilot's right hand (c7 geometry).

**Weak:**
- The pedestal is a plain carbon box.
- No F/N/R marks (they would need text geometry or an albedo decal).

### Helm (wheel)
**Matches:**
- Three-spoke stainless wheel with a tan rope-wrapped rim and an orange marker tape at 12 o'clock (concept 05).
- Boss, nut, tilt-helm shaft and boot.

**Weak:**
- The spokes are flat bars without lightening slots.
- The wrap reads as fabric, not individual turns.

### Seat
**Matches:**
- Racing bucket back lofted from U-sections (wings, headrest), with pleated vinyl and orange piping.
- Bolster pan, harness slots.
- 4-point grey harness lying slack, with a cam-lock buckle and adjusters.
- Welded alloy pedestal with a rubber-gripped footrest.

**Weak:**
- The back of the seat is plain vinyl; no carbon shell.
- The straps lie on the surface without draping into folds.

### Deck hardware
**Matches:**
- Rub rail (rubber D-profile with a stainless insert) on the JSON sheer, including the raked stem.
- Five cast horn cleats and a bow fairlead.
- Three "ETOH" stencilled fuel fillers with tethers; four clamshell vents with louvre grilles.
- Hatch hinges and latches, grab rails, padded coaming.
- Foredeck hatch bezel and lid with dogs; bow sidelight; transom tow eyes.

**Weak:**
- The clamshell vents are single-sided shells (the open end would cull).
- The rub rail is in the `low` tier.
- The turntable is too wide to judge detail; `rear34.png` is the useful view.

### Salvage dressing
**Matches:**
- Two red jerrycans (X-pressings, three-bar handles, spouts, seam flange).
- Black spares case plus a smaller case, with latches, handle and corner guards.
- Orange ratchet straps to pad eyes; blue rope over the load with a knot.
- Behind the seat and below the arch crossbar (§2 rule 3).

**Weak:**
- The jerrycans are close to bevelled boxes; no NATO recess shoulders.
- The straps don't wrap around the handles.
- No fuel stain or tape on the cans.

## Deviations and blockers

1. **Livery tint on parts.**
   - The runtime (`src/speedboat/assets/slotMaterials.ts`) applies the livery mix only on `M_Gelcoat`.
   - The cowl-top mask is already baked into `M_Carbon` baseColor alpha, so the rivals' yellow/turquoise caps
     need a one-line change there (`slot === 'M_Gelcoat' || slot === 'M_Carbon'`).
   - Not my file.
2. **Slot plan for the hero hull.** Hull (`M_Gelcoat` + `M_NonSlip`) + parts (4) + `M_Pilot` = 7. That means
   the hero hull must fold antifoul into `M_Gelcoat`, as STYLE-SPEC §3's `M_Hull` does, and keep the painted
   side number in its mask.
3. **Wear ramp / damage mask** (STYLE-SPEC §5.4): not delivered as a separate channel. Wear is composited into
   baseColor/ORM. A runtime wear-level uniform needs a 4th texture or the ORM alpha, which is a runtime change.
4. **Draw calls (fixed after browser sync 2026-09-13, which measured 72 draws per boat with shadows).**
   - Static parts now merge into one `Parts_LOD<n>` node per LOD, one primitive per slot. Membership is the
     manifest's `nodes` field.
   - At LOD0 only the animated nodes stay separate: 3 outboards, 3 props, the wheel, the dial and the
     throttle levers.
   - At LOD1 the outboards and props fold into `Drives`, keeping trim/steer extras (the tilt tubes share one
     axis). At LOD2 everything is `Parts`.
   - Result: **21 / 9 / 7 draws per LOD** for the whole boat (was 40 / 37 / 24). The checker now enforces
     `assetKinds.*.drawBudget` (player 24/10/8, npc 12/10/8), covered by a new test.
   - Not done:
     - Instancing the three outboards. Each has unique UVs and wear, and the starboard one a different
       panel, so instancing would need a shared outboard atlas region.
     - NPC per-instance geometry sharing is already how `boatModel.instantiate` works (one asset, shared
       geometry and materials, livery by uniform).
5. **Texture memory and file size.**
   - `stats.textureBytes` was 56 MB in lookdev. That is **shared by all instances** (8 boats = one texture
     set, measured with `count=8`), not per boat.
   - About 90 % of it was the nine 2048² part maps (≈5.6 MB each with mips).
   - The `M_Carbon`/`M_Metal` ORM and the whole `M_Perspex` set are now half-resolution: **46.0 MB**, GLB
     13.9 MB.
   - Still a concern: the hero hull's planned 4k maps (STYLE-SPEC §3) plus the pilot must fit the ~85 MB
     shared budget alongside these.
   - `docs/speedboat/asset-pipeline.md` "Output today" is now stale; it is not my file.
6. **Build time:** 5 min 20 s at the default 4 threads (was about 5 s). About 4 min of that is Blender; the MASK
   bake is the long pole.
8. **Lookdev console errors (fixed, `src/speedboat/lookdev.ts`).**
   - "wake track has never been advanced": lookdev now calls `setShip` + `advanceWake(dt)` each frame, as
     `raftFrame.tickSea` does.
   - "copyFramebufferToTexture bgra8unorm rgba16float": this was not the hero perspex (it reproduced with
     `variant=npc`). It was the ocean's scene-colour copy compiled by a bare `compileAsync` against the
     8-bit canvas.
   - The sea scene now renders and warms through the shared post pipeline (`post.warmup()` binds the
     half-float pass target, §T.124).
   - `?scene=sea` reloads with zero console errors.
   - Frame draw calls could not be read back: post resets `renderer.info` per pass, and the 8-boat page was
     too busy under GPU contention for a screenshot.
7. **Context hull in previews:** the pipeline-test hull has no cockpit well. The previews loft a render-only
   hull with a boolean well from the same JSON, and it is never exported. In the GLB the cockpit parts sit
   inside the test hull's closed deck until the hero hull lands.

## Final numbers

Build `node scripts/asset-build.mjs` (defaults: bake-size 1024 → part atlases 2048², AO 16 spp, 4 threads),
2026-09-13. Exit 0, raw and final checker OK, about 5 min.
- Before the merge/downsample revision, two builds from different work dirs were byte-identical: raw
  `be977be540acc55f`, final `59a69cb1acb68961`.
- The final revision's two default builds (no `--blend`) have byte-identical final GLBs: `4e722c622bab1f6d`,
  13.9 MB, draws per LOD 21 / 9 / 7. Raw GLBs differ by work dir, as the pipeline doc already notes.
- **`--blend` is preview-only.** A build that also saves the .blend exported different final bytes
  (`4423a8e5…`), so never ship from a `--blend` run.
- `npx vitest run tests/assetPipeline*`: 36/36. `npx tsc --noEmit`: exit 0.

| Part | LOD0 | LOD1 | LOD2 |
|---|---|---|---|
| Outboard_P / C / S | 7 510 / 7 510 / 7 646 | 1 499 / 1 499 / 1 500 | 500 each |
| Prop_P / C / S | 1 688 each | 200 each | 60 each |
| Bracket | 3 612 | 600 | 412 |
| RollArch | 5 834 | 550 | 159 |
| Windscreen | 1 624 | 400 | 120 |
| Dash | 5 298 | 349 | 60 |
| Governor (incl. dial skirt) + GovernorDial | ≈1 300 + ≈360 | 80 + 30 | — |
| ThrottleBase + Throttle (levers) | 1 204 total | 60 + 60 | — |
| Helm | 1 452 | 149 | 40 |
| Seat | 2 780 | 400 | 120 |
| DeckHardware | 7 606 | 649 | 159 |
| Salvage | 4 802 | 450 | 100 |
| **Parts total** (budget 64 000 / 9 500 / 3 000) | **63 601** | **8 855** | **2 850** |
| Whole GLB with the pipeline-test hull (contract 120 000 / 20 000 / 6 000) | 95 409 | 13 926 | 3 229 |

| Slot | Atlas | UV used | px/m exterior / cockpit / low |
|---|---|---|---|
| M_Carbon | 2048² (ORM 1024²) | 63 % | 338 / 677 / — |
| M_Metal | 2048² (ORM 1024²) | 32 % | 249 / 498 / 124 |
| M_Cockpit | 2048² | 56 % | 460 / 920 / — |
| M_Perspex | baked 1024², shipped 512² | 52 % | 495 / 990 / — (baked) |

Weak spots in these numbers:
- M_Metal packs only 32 %. Its 163 pieces break into thousands of small bevel islands, and each pays the
  4 px bake margin.
- The trim sheet's exterior tier (249 px/m) is marginally under the 256 chase-cam target.
- The rub rail and bracket plates (`low`, 124 px/m) sit at about the chase-cam floor.

## §T.192, 2026-09-13: playtest polish (z-fighting, drives, gauge glass, water mask, helm ergonomics, sockets)

**Z-fighting (USER: "a bunch of z-fighting inside the cockpit").** New checker rule `coplanarErrors` (§V98 on the built
GLB): every LOD0 triangle in world space through the real node matrices (§B118), binned by plane; same-facing faces
(or opposite, if either material is double-sided) within 2 mm of each other's plane are clipped against each other,
the overlaps clustered, and a cluster wider than 2 cm in both in-plane axes fails the build. A face pressed against an
opposite-facing single-sided face (a cleat base on the deck) is buried and skipped. The first scan of the shipped GLB
found 60 fights; the fixes, all geometric:
- **coaming pads** (the cockpit report): their backs were the well wall's own plane over 2.14 × 0.11 m each side → 3 mm proud of the wall (`deck_hardware.py`)
- ETOH stencils 1.5 mm off the deck → 4 mm; bow sidelight lenses face-on-face with the body → centred on the body face
- harness shoulder straps overlapping 3 cm wide in one plane at the buckle → the port strap lies 6 mm on top (`seat.py`)
- ratchet strap centre line on the small case lid → 4 mm up (`salvage.py`)
- arch all-round light lens caps on the metal disc and cap → seated 4 mm into both (`roll_arch.py`)
- outboards (×3 each): ram collars sharing the barrel end cap (8.4 cm and 6 cm discs), tilt-tube end cap on the port nut, trim pump face on the cross web, fuel-cap collar bases (`outboard.py`)
- bracket truss: post and second diagonal shared side planes with the chords they butt into → 6 mm narrower (`bracket.py`)
- hull bow doubler 3.5 mm proud came within 2 mm of the bulging bow section → 5 mm (`hero_hull.py PLATE_PROUD`)

**Drive nodes (USER: "the engines should move when steering … and the propeller rotating").** LOD0 already had
`Outboard_<id>` / `Prop_<id>` with pivots. LOD1's single merged `Drives` node had ONE centre pivot, so the side cowls
would have swung about x = 0: LOD1 is now `Drive_<id>` per engine (outboard + prop, the outboard's own steer/trim
extras), LOD1 draws 8 → 12 (contract budget 10 → 12, player and npc). Runtime: `BoatInstance.setDriveState`
(`src/speedboat/assets/driveRig.ts`). New checker rules: LOD1 `Drive_<id>` must carry its pivots, and
`driveLodErrors`: every coarse drive surface sample (vertices, edge midpoints, centroids) within 2 cm of its LOD0
drive. Measured on the shipped GLB: LOD1 0.7 cm, LOD2 1.3–1.6 cm — **the LOD geometry does not poke out**, so the
"NPC engine out of the water at > 10 m" report is not a decimation defect (see the T192 report).

**Gauge glass** is its own LOD0 node `GaugeGlass` (manifest part `GaugeGlass`, `dash.py pieces='glass'`, LOD0 only):
it is the one see-through surface below the sheer inside the well, and the runtime draws it before the hull water
mask. LOD0 draws 20 → 21.

**Helm ergonomics (pilot-log v2 blocker, coordinator fold-in).** Hub moved from (0, −0.08, 0.73) to
(0, 0.30, 0.50) in the seat frame (pan top at the JSON station, manifest `helm.wheelHubAbovePan/AheadOfSeat`); the
shaft now runs from the hub down to the dash face 0.20 below its top, under the gauge cluster, so the axis is
(0, 0.678, −0.735) (43° column). The throttle quadrant is placed so the middle handle at idle lands 0.40 m outboard,
0.20 above the pan, 0.40 ahead, on a free-standing pedestal down to the sole (was 0.67 m off-centre at the well wall).
**The pilot GLB still grips the old wheel**: `scripts/blender/pilot/pilot_config.json helm` is hand-copied and not
re-read from the parts GLB, so the pilot owner must paste the new values (the T192 report lists them).

**Sockets.** Root extras `partsSockets` (JSON, body frame): `seat` (pan top, up, forward), `wheelRim` (centre, axis,
radius 0.18, tube 0.0165), `throttleHandle` (middle handle at idle, pivot, axis, idle/full), `footrest` (centre,
axis, half length, radius), `dashCableAnchor` (a new cable jack on the dash face, position + normal). Extras rather
than nodes: node transforms must stay identity (contract), so a socket node could carry nothing but extras anyway.
Checker `partsSocketErrors`: all present, `wheelRim.centre` = `Helm_LOD0` pivot and `throttleHandle.pivot` =
`Throttle_LOD0` pivot (±1 cm), and reach bands in the seat frame (hub 0.15–0.45 up / 0.35–0.65 ahead; handle
0.30–0.50 lateral / 0.05–0.35 up); the test fails the v1 helm and quadrant positions.

**Budget.** Pilot v2 is 17.9k, not the 14k line. Real totals: hull 29.5k + parts + pilot. Parts LOD0 trimmed
~1.8k (prop blades 9 × 7 → 7 × 5 per blade, −512 per prop: they run under water or behind the blur disc; cleat
horns 8 → 6 sides; jerrycan spouts 16 → 12) and the manifest parts line lowered 64k → 62k.

**Playtest round 2 (§T.192): deck, bow, transom.**
- Every deck-standing part asks `anchors.deck_surface_y(x, z)` (cleats, fillers and stencils, vents and grilles,
  hatch hinges/latches, grab rails and pads, fore hatch, arch feet, windscreen base, rub rail via the sheer polyline);
  flanges are sunk 4 mm so they sit on the camber all round.
- Bow ("a bit too blocky"): the square fairlead plate is replaced by a tapered stainless stem-head fitting that follows
  the pointed deck to the stem with a raised bow eye, and a thin Ø 22 mm bow rail runs 0.18 m over each foredeck edge on
  three stanchions, meeting over the stem head.
- Transom ("could use a bit more"): stainless boarding grab handles either side of the bracket, flanged drain scuppers
  low on the corners outboard of the bracket plate, and a riveted aluminium hull-ID plate with a stamped HIN; the tow
  eyes and the bracket platform step were already there.
- Budget line 64k (measured 63.7k before bakes): hull 29.5k + parts + pilot v2 17.9k ≈ 111k of 120k.
