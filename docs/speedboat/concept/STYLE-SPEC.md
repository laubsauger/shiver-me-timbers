> **User picks 2026-09-13:** pilot eyewear = **strap goggles** (bare head); side number = **(a) hand-painted directly on the hull, weathered, no disc**; cockpit = **55–80 % LOA from bow**.

# Hero speedboat: style spec (modelling bible)

Status: rev B, 2026-09-13. The user signed off the decisions in §0; they are authoritative. Boat name TBD
(working code **SB-12**; design doc class "V-39 salvage").
Sources: `src/speedboat/deepV12.hull.json` (physics numbers, read-only here), `docs/speedboat/design-doc.md`
(world, art direction), `docs/speedboat/asset-pipeline-research.md` (slots, budgets),
`docs/speedboat/refs/REFERENCES.md` (real boats), `docs/speedboat/concept/*.png` (prompts in `PROMPTS.md`).

**Precedence when sources disagree:** §0 user decisions > `deepV12.hull.json` > this spec's numbers >
concept images. The images are for mood, part language, wear and materials. **Never measure proportions
off them.** Items marked **⚠ OPEN** still need a decision; **✓** marks a settled conflict.

---

## 0. Decisions 2026-09-13 (user, authoritative)

| Topic | Decision |
|---|---|
| Drives | **Triple outboards, salvaged ethanol V8s** (island-distilled ethanol, design-doc lore) on a **setback bracket**. The physics agent moves the thrust point to a realistic setback |
| Cockpit | **Open, welded roll arch**, radio whip antenna on the arch. **Single centreline seat** |
| Beam | Physics chine beam narrowed to **~2.30 m**, render topside flare **8°** kept |
| Wear | **Heavy salvage, as rendered** (the 70/20/10 recommendation was rejected). Rules in §5 keep silhouette and livery legible |
| Hero livery | **Bone / orange / teal**. Rivals: **yellow, turquoise, charcoal** |
| Strakes | **3 per side** |
| Bow repair | The rendered bare-metal bow patch is **accepted as a riveted aluminium doubler** (see §5.3) |
| Pilot | **No helmet.** Bare head, eyewear, headset. Helmet only as an optional later cosmetic (§8) |
| Number | Roundel rejected as too heavy-handed; three variants explored, **recommendation (a) hand-painted on the hull** (§4.3) |

---

## 1. What she is

A pre-flood 12 m deep-V offshore racer, pulled out of a drowned marina, rebuilt many times, now a courier
hull running three salvaged ethanol V8 outboards between the granite islands of the flooded Sierra. **Fast
first, salvaged second**: the wear is heavy, but she reads as a race boat at any distance. One pilot. The
whip antenna on the arch is the world's "there are people out here" sign, same as the raft's radio.

Tone: same light as Raft 2100 (Ghibli colour, Firewatch planes), Porco Rosso as the closest touchstone.
Not Mad Max: no spikes, skulls, armour or graffiti. Not neon.

---

## 2. Proportions (metres, hull frame: z forward from transom, y up from keel)

Rows marked *pending json* use the user's numbers ahead of the physics agent's `deepV12.hull.json` update.
When the json lands, the json wins and this table gets re-derived.

| Item | Value | Source / note |
|---|---|---|
| LOA (hull, excl. bracket and outboards) | **12.00** | json `length` |
| Length incl. setback bracket + outboards | ~13.1 | render; bracket setback per json when updated |
| Chine beam | **2.30** | user decision; json still 2.618 at rev B (*pending json*) ✓ C1 |
| Topside flare | **8°** | json `renderOnly` |
| Beam at sheer | **2.61** = 2.30 + 2·1.091·tan 8° | derived; L/B 4.6, in line with real 11.4–12.9 m racers (2.44–2.51 m overall) |
| Deadrise | **24°** constant from transom to taper | json **⚠ OPEN C8** |
| Chine height above keel (transom) | **0.512** = 1.15·tan 24° | derived (*pending json*) |
| Freeboard chine → sheer | 1.091 | json (may change with the beam update) |
| Hull depth keel → sheer (transom) | **1.603**, constant sheer | derived (*pending json*; 1.674 at the old beam) |
| Beam taper starts | z = 7.20 (60 % LOA), cosine to stem | json `taperStart` |
| Keel rise | from z = 8.40 (70 % LOA), parabolic, 0.982 at stem | json |
| Stem | render rake ≤ 0.35 m at forefoot | **⚠ OPEN C4** |
| Transom | vertical, full chine beam | json |
| Lifting strakes | **3 per side** at 25 / 50 / 75 % of chine half-beam, 0.06 flats; run aft→fwd to z 9.4 / 9.0 / 8.4 | user decision ✓ C9 (json `renderOnly` still lists 2) |
| Chine flat | 0.08 wide, 0° | json `renderOnly` |
| Steps | none | decision |
| Mass / LCG / VCG | per json (5842 kg / 3.60 / 0.818 at rev B) | json; physics owns the outboard weight aft |
| Thrust / prop point | per json after the setback update | **✓ C5** being resolved by physics |
| Rub rail | 0.07 tall × 0.05 proud, at the sheer | render |

### Deck layout (z from transom; % from bow in brackets)

| Zone | z range | Notes |
|---|---|---|
| Setback bracket + 3 outboards | about −0.9 → 0 | welded aluminium bracket with a small platform; outboard centres x = −0.69 / 0 / +0.69 (27 in, per Verado-class spacing, REFERENCES d7); cowl top ≈ sheer + 0.60; trim rams visible |
| Aft deck / fuel hatch | 0 → 3.85 (100–68 %) | ethanol tank bay under one 2.4 × 1.6 hatch; two to four low vents (renders show four: accepted); stencilled filler caps |
| Roll arch | legs at z 3.85–4.05 | Ø 0.06 welded stainless tube, raked legs, top sheer + 1.30; whip antenna 2.4 tall; small solar panel (radio and plotter charging); round nav light; hoop mirror (design doc) |
| Cockpit well | 3.85 → 6.00 (68–50 %) | 1.60 wide, sole 0.75 below sheer; padded coaming |
| Seat | single centreline bolster, front face at z 4.55 | semi-standing; seat pan 0.62 above sole |
| Pilot eye (cockpit cam) | z 5.10, sheer + 0.50, x 0 | 0.90 behind the screen base, sees just over the screen top |
| Dashboard | z 5.55 → 6.00 | carbon, 3 round gauges, strapped plotter tablet, VHF handset, Governor dial, throttle quadrant for three engines |
| Windscreen | base z 6.00 on centreline, wraps aft to z 5.40 | **0.40 tall**, top raked 35°, scratched polycarbonate in aluminium frame |
| Foredeck | 6.00 → 12.00 (50–0 %) | crown 0.06; flush Ø 0.50 hatch at z 10.2; bow cleat + fairlead; bow doubler plate on the starboard quarter |

**✅ C10 SETTLED (user 2026-09-13): cockpit at 55–80 % from the bow — the text below is superseded.** the Apache 42 3-view (REFERENCES a1) puts the cockpit at 55–80 % from the bow. We keep 50–68 %:
the fuel bay and outboards pull mass aft, and more foredeck in the cockpit cam reads faster.

### Silhouette rules
1. One long low wedge. Above-water side silhouette length : height ≥ 5.5 : 1 (excl. antenna).
2. Straight sheer. No cabin, no T-top, no canopy.
3. Only the arch and the antenna break the line. Windscreen never above 0.45. Lashed cargo stays below the
   arch crossbar; nothing loose hangs outboard of the rub rail.
4. Plan view: pointed bow, parallel sides aft of 60 % LOA, square transom, three cowls reading as one block.
5. Bow-on: the V and the 3 strakes read at 300 m. Crisp strake lines (bevel ≤ 1 cm, weighted normals).
6. Heavy wear never changes the silhouette: no missing chunks, holes or bent geometry at rest (race damage
   swaps excepted, §5.5).

---

## 3. Parts and material slots

Seven slots, shared by all 8 boats. ≤ 4 filterable textures per slot (§V40). Hue and wear level per boat are
object-scoped uniforms (like `sailTint`). No per-boat textures.

| Slot | Textures (KTX2) | Parts |
|---|---|---|
| **M_Hull** | 4k baseColor (neutral), normal, ORM, **mask RGBA**: R livery band, G pinstripe + number field, B wear ramp (§5.4), A antifoul region | hull shell, strakes, transom, chine flat, bow doubler + chine plate (modelled low, rivets in normal) |
| **M_Deck** | 2k baseColor, normal, ORM + tiling moulded non-slip normal (UV2) | foredeck, aft hatch, coaming, cockpit sole |
| **M_Composite** | 2k baseColor, normal, ORM, mask (R cowl livery, G wear ramp) | outboard cowls, dash shell, carbon panels, vents, screen frame |
| **M_Trim** | 2k trim sheet: baseColor, normal, ORM, mask (R rust/salt, G heat tint) | arch, bracket, rails, cleats, props, lower units, trim rams, rub rail, antenna, nav light, mirror |
| **M_Glass** | 1k normal + scratch/crazing mask | windscreen (polycarbonate scratches), gauge glass, lens. Hero `transmission`, NPC `transparent` ior 1.49 |
| **M_Cockpit** | 2k baseColor, normal, ORM, emissive | seat, harness, gauges, plotter, VHF, throttles, switches, wheel, jerrycans, spares case, strap, rope |
| **M_Pilot** | 2k baseColor, normal, ORM, mask (R livery accent, G wear) | head, face and hair cards, eyewear, headset, suit, vest, gloves, boots |

Budget (asset doc §5.3): hero LOD0 90–120k tris incl. cockpit + pilot; NPC LOD0 45–60k.

---

## 4. Palette and livery

### 4.1 World and hero
Hex values align with the design doc's shared palette where one exists.

| Name | Hex | Use |
|---|---|---|
| Old gelcoat (bone) | `#E9E5DA` | hero topsides, cowls (design doc token) |
| Salt chalk | `#D9D3C4` | oxidised gelcoat on up-facing surfaces |
| Raw glass | `#BFB59A` | exposed fibreglass in chips |
| Hero orange (paint, faded) | `#E4572E` | hero band, cowl tops. HUD uses design doc signal orange `#FF6B1F` |
| Deep teal | `#1F4E5F` | hero pinstripe |
| Oxide antifoul | `#6B2E25` | hero bottom |
| Deck charcoal | `#3A3D40` | non-slip, cockpit |
| Stencil black | `#151B1C` | race numbers, stencils (design doc token) |
| Bare aluminium | `#A7ADB0` | doubler plates, bracket, screen frame |
| Heat tint gold / blue | `#B8893E` / `#4A5C8A` | welds on arch and bracket only |
| Algae line | `#6E7A3C` | ≤ 8 cm waterline band |
| Suit sand | `#CDBFA3` | pilot suit (all boats) |

### 4.2 Fleet (same mask, only uniforms change; one dominant hue per boat = HUD/plotter colour)

| Boat | Dominant | Topsides | Band | Pinstripe | Antifoul | Wear level |
|---|---|---|---|---|---|---|
| Hero | orange | `#E9E5DA` | `#E4572E` | `#1F4E5F` | `#6B2E25` | 0.85 |
| Rival yellow | yellow | `#2B2F33` | `#E8B420` | `#C8372D` | `#6B2E25` | 1.00 |
| Rival turquoise | turquoise | `#3E8C8A` | `#F2E6C8` | `#2B2F33` | `#1E1F21` | 0.70 |
| Rival charcoal | charcoal / bone | `#2B2F33` | `#E9E5DA` | `#E4572E` | `#1E1F21` | 0.60 |
| NPC 5–8 | proposals | see board | | | | 0.60–1.00 |

Rival yellow and turquoise are the rendered 08 variants (yellow band on charcoal; turquoise topsides). **⚠ OPEN:**
charcoal as a HUD/plotter colour disappears on the design doc's stencil-black HUD planes, so rival charcoal
needs a light HUD accent (bone `#E9E5DA` recommended).

### 4.3 Race number (roundel replaced)
The white disc in the rev A renders is rejected. Three variants rendered (`14a`, `14b`, `14c`):

| Variant | What | Chase-cam read (7.5 m back, 2.4 m up) | Fleet system |
|---|---|---|---|
| **(a) hand-painted on the hull** (rec) | stencil-black numerals ~0.6 m tall on the topsides under the cockpit, faded and chipped | Side is foreshortened from behind; numbers read on overtakes, near chase, crash cam, helicopter/photo. Rivals are identified by dominant hue first anyway | One number field in mask G; numeral colour is a uniform (black on light topsides, bone on charcoal). Cheapest: no extra geometry |
| (b) riveted number plate, low and aft | small irregular aluminium plate, overpainted, black numerals | Lower and aft = in the spray sheet and wake at speed; read worst | Extra geometry per boat; repeats the chine-plate language, so the side gets busy |
| (c) ghost roundel + new numbers | chalk ghost of the pre-flood disc under new painted numerals | As (a), plus a faint disc that adds noise | Ghost lives in the shared wear map, so every boat carries the same ghost: fine for story, reads "copy-paste" across 8 boats |

Render drift: `14b` put the plate mid-hull instead of low and aft, and `14c`'s ghost disc still reads almost
solid. The modelled versions follow the table, not the renders.

Recommendation (a): lightest, most "community paint" (design doc), no new part, and the numeral colour flips per
boat. The design doc's "stencilled number on a painted square" can be a per-boat option in the same number
field if the user wants more jank.

---

## 5. Wear and salvage language (heavy)

### 5.1 Target
Heavy salvage as rendered: many seasons of repairs, fade and chips on every surface. It stays **faded and
repaired, not dirty**: no oil, soot, mud or grime (design doc "no grime"). Heavy wear is history, not filth.

### 5.2 Legibility guards (these outrank the look)
1. **Silhouette:** wear is surface-only (albedo, roughness, normal). No wear geometry at rest (§2 rule 6).
2. **Value:** light topsides keep mean albedo ≥ 0.55 after wear; dark topsides ≤ 0.20. Wear moves hue and
   roughness more than value, so the hull's value block survives at distance.
3. **Livery:** the band keeps ≥ 70 % of its area at ≥ 75 % of its chroma. Chips and peel cluster at band
   edges, not across the middle. Band-to-topsides luminance contrast ≥ 3 : 1 at every wear level.
4. **Number field** is repainted over the wear: clean enough to read, weathering ≤ 20 % coverage.
5. **Frequency:** at chase distance only macro wear shows (fade gradients, repaint panels ≥ 30 cm, the doubler
   plates). Chips 1–10 cm live in the mask and roughness and fade out with mips; sub-cm scratches are
   normal/roughness only and must band-limit (§V48).
6. **Waterline:** algae and barnacles stay on antifoul and a ≤ 8 cm band; never on topsides.

### 5.3 Salvage features (fixed positions, all boats)
- **Bow doubler (accepted drift):** the renders show bare metal on the starboard bow quarter. It is a
  **riveted and bonded aluminium doubler** over an old holed bow: perimeter rivet line, sealant squeeze-out,
  salt streaks, edges feathered with filler. **Not welded**, because aluminium can't be welded onto a
  fibreglass hull. Welding language (bead, heat tint) is reserved for metal parts: arch and bracket.
- **Aft chine plate:** riveted aluminium strip along the aft starboard chine.
- **Mismatched cowl panel:** one replacement panel on one outboard cowl.
- **Cockpit lashings:** ethanol jerrycans and a spares case lashed behind the seat with a ratchet strap and
  rope. (The rev A "battery case" and "charging port" are reinterpreted as a spares case and an ethanol
  filler/primer cap.)
- **Decal ghosts:** chalk silhouettes of older stripes and lettering under the current paint. No real brands.

### 5.4 How the wear works
- `M_Hull` mask B and `M_Composite` mask G hold one **wear ramp** each: a baked greyscale where the most-exposed
  areas (chines, strake leading edges, bow, coaming, cowl edges, walk paths) are darkest.
- The per-boat **wear level** uniform (0..1) thresholds the ramp with a height-blend. Higher levels expose more
  chips, peel and fade. Race damage adds to the same threshold (`damage` uniform) and adds scorch/scuff decals.
- Wear follows use: edges, impact zones, hands and feet. Nothing random.

### 5.5 NPC wear variation
Same maps on every boat; three things vary:
1. **Wear level** (table §4.2): 0.60 well kept, 0.70–0.85 working, 1.00 hard used (renders ≈ 0.85).
2. **Patchwork tint:** 4–6 hull panel regions carry a vertex-colour ID; each boat tints 0–2 of them to a slightly
   different white/grey (salvaged replacement panels, design doc "mismatched panels kept as they are").
3. **Geometry toggles:** replacement cowl panel on engine 1/2/3/none; cockpit clutter variant (jerrycans /
   crate / none); arch mirror present or missing. Race-damage swaps (cracked windscreen, bent arch leg,
   missing cowl panel) are hidden nodes.

---

## 6. Shared vs per-boat

| Shared by all 8 | Per boat (uniforms / toggles) |
|---|---|
| Hull, deck, arch, bracket, cowls, cockpit, pilot meshes and LODs | 4 livery hues + numeral colour, dominant (HUD) hue |
| All textures, all 7 materials, one pipeline set | Race number (UV offset into a numbers strip) |
| Salvage feature positions | Wear level, damage, patchwork tints |
| Pilot body, suit, vest | Pilot accent hue, eyewear choice, hair variant (§8) |
| | Geometry toggles (§5.5) |

Hero-only: windscreen transmission, full cockpit detail, LOD0 pilot face and hands.

---

## 7. Drives: triple ethanol V8 outboards

Salvaged big-block V8 outboards (Mercury 450R / Verado-class scale, REFERENCES d6, d7) running island-distilled
ethanol, on a welded aluminium setback bracket.
- **Look:** tall cowls, one mismatched panel, stencilled "ETOH" fuel marks (fictional), filler/primer caps,
  exposed trim rams and steering tie-bar, lower units with cleaver props.
- **Trim** = visible drive tilt about the bracket pivot, matching the trim control.
- **VFX tie-in:** design doc "ethanol pop" (pale blue flame on lift-off) comes out of the idle relief at the
  back of each cowl.
- **Mass and thrust point** belong to physics (`deepV12.hull.json`). Three ~310 kg outboards plus bracket put
  about a tonne behind the transom; the physics agent owns how that moves the LCG.
- **⚠ OPEN (design doc):** design-doc §2 slice and §7 audio still say "2 × ethanol V8" (inboard, "velocity
  stacks", "through-transom"). Triple outboards is the user decision; the design-doc owner should update the
  slice line and the engine audio (three outboard V8s).

---

## 8. Pilot (no helmet)

| Item | Spec |
|---|---|
| Body | adult, 1.78 m, average build, braced semi-standing against the bolster, hands on wheel |
| Head | **bare head.** Short weather-beaten hair, wind-swept; ordinary sun-tanned face, calm focus; not a caricature |
| Eyewear | **rec: leather-strap aviator goggles**, amber scratched lenses; worn down while racing, pushed up on the forehead in menus/results. Alt: wrap-around sport sunglasses on a cord (`12b`) |
| Comms | salvaged single-ear radio headset with a boom mic (radio is a core system) |
| Neck | no carbon collar (it belonged to the helmet); the flotation vest has a tall padded foam collar |
| Suit | one-piece, Suit sand `#CDBFA3`, stitched patches, tape on one sleeve; trim the military cargo pockets and heavy knee pads from `11` |
| Flotation | low-profile foam vest in the boat's accent hue, reflective tape, emergency air bottle |
| Harness | 4-point grey webbing to the bolster |
| Hands, feet | black-grey gloves with knuckle pads; short neoprene boots |
| Helmet | **optional later cosmetic only**, if good pieces are found (e.g. an open-face shell in community colours) |

Why goggles over sunglasses: at 80 kn spray and wind make open sunglasses implausible, the strap reads at chase
distance as a clear head silhouette, and goggles-up is Porco Rosso, the design doc's closest touchstone.

### 8.1 Hair and wind
- Hair is 6–10 alpha-tested card strips (alpha-to-coverage, no sorting), ~1.5k tris, on the pilot atlas.
- Wind is a vertex-shader sway: amplitude and frequency from apparent wind speed (0 at idle → full at 60 kn+)
  plus a gust noise, with root vertices pinned. No strand simulation, no CPU cost.
- Short hair keeps the silhouette tight and avoids long strands clipping the arch or the vest collar.

### 8.2 Face: visibility and cost
- **Chase cam** (7.5 m back, 2.4 m up): the pilot is seen from behind and above, so the face is mostly hidden. The
  head, hair motion, goggle strap and headset carry the read. Face ≈ 25–40 px tall at 1080p on near chase and
  overtakes.
- **Cockpit cam:** first-person, so the face isn't seen. Nothing should enter the view above the eyes: no brim,
  no goggle frame vignette (goggles are "worn" but not drawn in first person). Check `05-cockpit-pov`: no helmet
  brim is in view, only the gloved hands and forearms. The hoop mirror (look back) shows the transom, not the pilot.
- **Close cams** (crash cam, results, photo mode, hull select) are where the face costs:
  - **Geometry:** LOD0 head ~6–8k tris incl. hair cards; LOD1 ~1.5k; LOD2 merges head into the body.
  - **Texture:** the face takes ~20 % of the 2k pilot atlas (≈ 1k² equivalent); a skin roughness/SSS-look is a
    wrap-lighting term in the node material, not real SSS.
  - **Animation:** rigid head with look-at and a g-force bob from the boat's acceleration; eyes behind
    goggles, so no eye or blink rig; jaw/brow blendshapes only if a results-screen close-up needs them. No
    facial capture.
  - **Crash taste:** strapped in and visible; cockpit-cam crashes cut to the outside cam; nothing gory
    (design doc Q6, updated).
- **Risk:** a visible human face is the most scrutinised asset on screen. It is the part of the pilot most likely
  to need hand cleanup after image-to-3D generation (asset doc §8 rated the pilot medium-high risk already).

### 8.3 Alternative character reads (options, current direction kept)
1. **Current:** mid-career courier pilot, practical sand suit, calm focus (renders `12`, `12b`).
2. **Island mechanic-elder:** older, grey stubble, knitted cap under the headset, sleeves rolled, oil-cloth
   vest in community colours. Reads "rebuilt this hull herself/himself".
3. **Young community racer:** hair tied back under a cloth band in the boat's hue, a hand-painted community
   jacket over the vest, mismatched gloves. Reads "the islands' pick for the season".

---

## 9. Conflicts and drift log

| ID | Conflict | Status |
|---|---|---|
| C1 | Proxy chine beam 2.618 too wide; sheer 2.93 m at 8° flare | ✓ Settled: chine beam ~2.30, flare 8° (sheer 2.61). Pending the json update |
| C2 | Images show hull depth ≈ L/5.9 against the spec's L/7.2 | ✓ Rule: model to §2 numbers |
| C3 | Asset doc §6.6 test "GLB bbox vs `halfBeamAt` ± 2 cm" fails with any flare | ⚠ OPEN (test owner): test chine line vs `halfBeamAt`, sheer vs `halfBeamAt + freeboard·tan 8°` |
| C4 | Proxy stem is a vertical cap; render wants rake ≤ 0.35 m | ⚠ OPEN (wake/physics owner) |
| C5 | Prop point 0.436 m aft of transom too short for bracket outboards | ✓ Settled: physics moves it to a realistic setback. Read the json when it updates |
| C6 | Design doc vs this spec: "2 × ethanol V8" inboards/velocity stacks vs triple outboards; "no grime / faded not dirty" vs heavy wear; "stencilled number on a painted square" vs §4.3; slice mass 4.6 t vs json 5842 kg | ⚠ OPEN (design-doc owner). Drives and wear follow §0. Wear is reconciled as "heavy but not dirty" (§5.1). Pilot/helmet lines already updated in the design doc 2026-09-13 |
| C7 | Generator drift: 2 then 4 outboards (fixed by edit); bow patch as bare metal; non-slip as tread plate; front view bow too full and extra seat backs; first hero shot floating; alpine peaks in POV | ✓ Bow metal accepted as riveted doubler (§5.3). Others: model to spec (moulded non-slip, one seat, fine bow, granite domes) |
| C8 | Proxy deadrise constant; Hunt refs (a2, a3) say it varies, steeper forward | ⚠ OPEN: render keeps 24° aft of 60 % LOA, may steepen forward; wake owner to check forward strips |
| C9 | json `renderOnly` lists 2 strakes; refs show ~4 | ✓ Settled: 3 per side. json `renderOnly` update belongs to physics |
| C10 | Apache 3-view cockpit placement 55–80 % vs our 50–68 % | ✅ SETTLED 2026-09-13 (user): **55–80 % from the bow, Apache 42 placement.** Mass items in `deepV12.hull.json` follow |
| C11 | Rival charcoal as a HUD colour vanishes on stencil-black HUD planes | ✅ DEFAULT: bone HUD accent for the charcoal rival (low stakes; revisit at HUD lookdev) |
