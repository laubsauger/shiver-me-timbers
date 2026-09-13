# Speedboat pilot: build log and self-critique

Status 2026-09-13 (v2): `assets/models/speedboat_pilot.glb` is built by `node scripts/pilot-build.mjs`
(exit 0, pilot checker clean at the raw and final stages) and gated by `tests/assetPilot.test.ts`
(13 tests). It is a separate skinned asset, parented at runtime to the boat's seat socket. **No runtime
code exists yet** (src/speedboat is outside this task); §Runtime lists what it needs. §v2 at the end
supersedes the v1 sections where they differ (seat frame, helm, hair styles, head hide, budget).

Direction kept from the concept (`11-pilot`, `12-pilot-goggles`, `13-chase-bare-head`,
`05-cockpit-pov`) and STYLE-SPEC §8: bare head, short wind-swept hair, strap goggles, single-ear
headset with boom mic, sand one-piece suit, orange foam vest with a tall collar and emergency air
bottle, 4-point harness, dark gloves, short boots, strapped in through every clip.

## Pipeline

```
MPFB 2.0.17 (MakeHuman base mesh + game_engine rig + CC0 weights, CC0 eyes/brows/lashes)
  body.py     3 variants solved to 1.78 m, evaluated to one topology (hero = mesh, NPCs = shape keys)
  fit.py      split skin / suit / gloves / boots (A-pose) and build the fitted gear
  rig.py      extra bones, seated pose solved in the seat frame, pose applied as the bind,
              variant skeletons re-posed, harness + coiled dash cable in the seated pose
  hair.py     numpy-rasterized strand atlas, Poisson-disc cards, scalp cap
  texture.py  atlas UVs, Cycles CPU data bakes, numpy compositor (gear); skin re-baked from CC0 skins
  anim.py     12 rotation-only clips baked from procedural poses with arm IK glued to the wheel
  lod.py      per-piece LOD0/1/2 reduction, joined per material, weights ≤ 4
  export.py   materials, root extras, raw GLB
scripts/pilot-build.mjs
  pilot checker (raw) → alphaMode / clearcoat / anisotropy / detail normals / KHR_materials_variants
  → resize → UASTC (normals, ORM, detail, hair) + ETC1S (albedos) → meshopt → pilot checker (final)
```

| Command | What |
|---|---|
| `node scripts/pilot-build.mjs` | full build (2048² gear bakes, 16 AO samples, 4 CPU threads) |
| `node scripts/pilot-build.mjs --bake-size 1024 --samples 8 --max-texture 1024` | quick build |
| `node scripts/pilot-build.mjs --work <dir> --stages lod,export` | re-run stages against checkpoints (dev loop) |
| `node scripts/blender/pilot/checkPilotGlb.mjs <glb> [--stage raw\|final]` | pilot checker |
| `Blender -b <work>/stage_export.blend --factory-startup -P scripts/blender/pilot/render_pilot.py -- --out <dir> --cockpit <decoded parts.glb>` | CPU verification renders in the real parts cockpit (v2; `--legacy` for a v1 build) |
| `npx vitest run tests/assetPilot.test.ts` | asset tests (v2: 13, incl. the real-helm grip and cam_eye) |

Blender runs with `--factory-startup`; the build enables only MPFB, fails loud if MPFB is missing
or not 2.0.17, and verifies the sha256 of every consumed CC0 file against
`scripts/blender/pilot/assets.lock.json`.

## Installs, and how to undo each one

| Install | What changed | Undo |
|---|---|---|
| MPFB 2.0.17 (Blender extension) | Official Blender Extensions platform build, `add-on-mpfb-v2.0.17.zip`, sha256 `4f0a879d64a39bf646fbf5f53601ac678855da329d650617dca5737548239a87`, `blender_version_min` 4.2.0, listed compatible with 5.1.2 by the platform API. Installed with `Blender --command extension install-file --repo user_default --enable`. Files: `~/Library/Application Support/Blender/5.1/extensions/user_default/mpfb/` (82 MB). MPFB also created `…/5.1/extensions/.user/user_default/mpfb/{data,config,cache,logs}` and `…/5.1/mpfb/config/log_levels.json`. `userpref.blend` was backed up first to `…/5.1/config/userpref.blend.pre-mpfb.bak` (the install enables the add-on there). | `Blender --command extension remove mpfb`, then `rm -rf ~/Library/Application\ Support/Blender/5.1/extensions/.user/user_default/mpfb ~/Library/Application\ Support/Blender/5.1/mpfb` and copy `userpref.blend.pre-mpfb.bak` over `userpref.blend`. |
| MakeHuman CC0 asset packs | Downloaded with curl from the official mirror `files2.makehumancommunity.org/asset_packs/` (no account): `makehuman_system_assets_cc0.zip` (sha256 `b542127a…`), `skins02_cc0.zip` (`1613f1ef…`), `eyebrows01_cc0.zip` (`5425891d…`), `bodyparts05_cc0.zip` (`262bba42…`). Unzipped into MPFB's user data dir `…/extensions/.user/user_default/mpfb/data/` (407 MB). Only system assets and skins02 are consumed; eyebrows01 and bodyparts05 are installed but unused. | Removed with the MPFB user data dir above. |

Online features: MPFB's only network permission is "(optional) interact with a local MakeHuman
instance"; its "online access" preference is off (logged at every start) and was not touched. MPFB
has no asset-store login; the packs were fetched by hand from the CC0 mirror. Nothing was uploaded.

## Licences of everything in the GLB

| Asset | Source | Licence |
|---|---|---|
| Base mesh hm08, targets, `game_engine` rig + weights | MPFB 2.0.17 data (`base.obj` header: "explicitly released as CC0 in september 2020") | CC0 |
| Low-poly eyes + `brown_eye.png`, `eyebrow001`, `eyelashes01` | makehuman_system_assets (pack json: `license: CC0`) | CC0 |
| Hero skin `mindfront_aksel_skin` (diffuse + NRM) | skins02, Mindfront (pack json: CC0) | CC0 |
| NPC B skin `mindfront_skin_male_african_middleage` | skins02, Mindfront | CC0 |
| NPC C skin `middleage_caucasian_male` | makehuman_system_assets | CC0 |
| Everything else (suit, gear, hair atlas, harness, textures, clips) | generated by this build | project-owned |

MPFB's code is GPL-3.0; it is a build tool only and none of its code ships. MakeHuman states that
models and assets generated with it carry no restriction (about/license: "all core assets are shared
under CC0").

## Decisions

**Body and variants.** MPFB `game_engine` skeleton (53 bones). Each variant's height macro is solved
by bisection to 1.78 m (STYLE-SPEC §8). Variants share topology and UVs: shape = glTF morph targets
`variant_b`/`variant_c` on every mesh, including hair and gear (gear follows the surface under it,
rigid parts move as one); skin = `KHR_materials_variants` swapping only the 1k albedo; hair = one of
two card sets (`Hair_swept_LOD*`, `Hair_cropped_LOD*`) plus a tint uniform.
- hero: man, early 30s, sun-tanned, swept hair
- npc_b: woman, 40s, dark skin, cropped hair
- npc_c: man, mid 50s, grey stubble, grey swept hair

A variant's arms and legs are up to 4 cm shorter than the hero's (worst joint drift in
`stage_body.json`). A morph alone would bend those arms at the hero's elbows, so root extras
`variants.<v>.jointHeads` carry every joint's seated position for each variant (seat frame, three.js
axes), and the clips are rotation-only so the re-bound skeleton plays them unchanged.

**Topology.** The suit, gloves and skin are the MakeHuman body split by skin weights and
re-surfaced: Taubin smoothing drops muscle definition, a per-region thickness plus "straight trouser
leg" radii makes coveralls instead of tights, and accordion creases sit at elbows, knees and hips.
Boots are voxel-remeshed so the toes merge. Vest, collars, goggles, headset, bottle, harness and
cable are procedural sweeps and grids (`meshops.sweep`), so their edges are clean.

**Seated bind.** The seated pose is the bind pose. Every clip is a small delta from sitting, the
harness is modelled strapped to the seat, and the GLB is correct with no clip playing. Pilot frame =
seat socket: origin at the pan front edge, +Z bow. The pose is solved against the seat, eye and wheel
anchors (§Blockers 1–2).

**First-person arms.** No separate arms mesh. LOD0 gloves carry 2,400 triangles, ~1,515 px/m in
the gear atlas (2.2× the suit's density), and the sleeves use the same skin. The cockpit cam hides
the head by collapsing the `head` bone (extras `firstPerson`): face, hair, goggles and headset are
all weighted under it. Justification: one rig, one IK solution and one draw path for both cameras.
A second mesh would need its own skinning and animation sync, and would cost memory for a view
where only forearms and gloves show. Trade-off: the sleeve cloth is the chase-cam mesh, a smooth
tube at < 1 m (see critique).

**Hair.** Real-time cards only. Atlas: 7 long clump cells, 6 tufts, a wisp cell, a dense cap cell,
and the CC0 brow/lash textures. Strands are rasterized per cell (clumping, taper, dark roots,
sun-bleached tips), unpremultiplied. The flow texture is `KHR_materials_anisotropy`: RG direction,
B strength, A root→tip gradient. Cards root on Poisson-disc samples of MakeHuman's scalp region and
are wind-swept back. Winding is made consistent so every card faces out of the hair volume.
TEXCOORD_1 = (along card, phase) drives the vertex-shader sway. Two things were tried and rejected:
- custom volume normals: black glossy shards under skinning
- hairline wisp cards: a saw-tooth fringe

**LOD reduction.** Collapse decimation is used only for organic pieces (skin, suit, gloves, boots,
cap). Thin swept parts and the vest grid are built at LOD0 resolution. Their lower LODs are split
along UV islands, collapsed, then welded back. Why:
- plain collapse folded a strap's top face onto its bottom face
- collapse and un-subdivide both dragged UVs across islands, so the vest sampled buckle metal and
  looked torn

Hair is never decimated. LOD1 keeps 36 % of the cards, widened, and LOD2 is the cap only.

## Budget (proposal)

| | Hero boat LOD0 total | Pilot LOD0 (worst variant) | Pilot LOD1 | Pilot LOD2 |
|---|---|---|---|---|
| contract | ≤ 120,000 | cap ≤ 25,000 (task) | ~8,000 | ~2,500 |
| parts manifest proposal | hull 40k / parts 64k / **pilot 14k** / margin 2k | 14,000 | 2,500 | 800 |
| built (worst variant) | | **23,846** (21,208 common + 2,638 swept hair) | **7,080** | **2,367** |

Proposal: pilot LOD0 ~24k worst case (21k + swept hair). That is ~10k over the parts manifest's 14k
line: either hull + parts give 10k back, or the hero's LOD0 total becomes ~130k. Cheapest
reductions if the pilot must shrink:
1. drop the NPC hair alternative from the hero file (a separate NPC GLB): no triangle saving
   per instance, but a smaller file
2. dash cable coil 900 → 300 (a straight cable with a coil texture)
3. skin 3,800 → 3,000 (the face stays behind goggles in the race)
4. gloves 2,400 → 1,800 (loses cockpit-cam finger shape)

The checker enforces the task caps (25k / 8k / 2.5k) per worst variant.

## Rig, clips, textures (as built)

- Bones: **63** joints (53 MPFB game_engine + lowerarm_twist_l/r + goggles, eye_l, eye_r + ik_hand_l/r,
  ik_foot_l/r, ik_look). 58 deform. ≤ 4 influences, normalized.
- IK: root extras `ik` lists chains for three.js CCDIKSolver (targets are joints) and the look-at
  bones with weights.
- Clips (rotation-only, 30 fps): seated_base, idle_seated (loop), steer_left, steer_right,
  throttle_push, brace_landing, airborne_tuck, impact_jolt, capsize_hang (loop), look_back,
  victory_fist, goggles_up. Additive intent per clip in root extras `clips` (reference: seated_base).
- Materials / textures (all ≤ 4 per material): see §Runtime.

## Runtime material requirements (for the TSL runtime; not built here)

| Material | Textures | Shading |
|---|---|---|
| `M_Pilot` OPAQUE | baseColor 2048 ETC1S (RGB albedo, **A = accent mask**), ORM 1024 UASTC, normal 2048 UASTC, detail normal 256 UASTC (carried as `KHR_materials_clearcoat.clearcoatNormalTexture` with factor 0, `KHR_texture_transform` ×24) | `albedo = mix(albedo, accentHue * luminance(albedo) * 1.6, mask)` (per-boat object uniform, the `sailTint` mechanism). Detail normal blended (whiteout) and faded out beyond ~3 m. waterLighting wetness like the slot materials |
| `M_PilotSkin` OPAQUE + 2 variant clones | baseColor 1024 ETC1S per variant (RGB albedo, **A = SSS thickness**), ORM 1024 UASTC (B unused = 0), normal 1024 UASTC, detail normal 256 UASTC (clearcoat carrier, ×18) | Wrap diffuse `(N·L + w)/(1 + w)`, w = 0.35 (× thickness), plus a back-scatter lobe `scatterColor (0.85, 0.32, 0.22) · thickness · pow(saturate(dot(V, -(L + N·0.4))), 3) · 0.6`. Roughness from ORM.G modulated ±0.05 by detail-normal variance. Detail normal faded beyond 3 m (it band-limits the pores, §V48). Pick the variant with `KHR_materials_variants` (or swap the map) |
| `M_PilotHair` MASK 0.35, double-sided | baseColor 1024 UASTC (A = coverage), anisotropy/flow 512 UASTC | alpha-to-coverage (no sorting). Kajiya-Kay-style two shifted specular lobes along the flow tangent, shift from flow.B. Root occlusion from flow.A. Tint `hairColor * luminance(albedo) / luminance(hero #5E4634)`. Vertex sway from TEXCOORD_1 (0 at the root) scaled by apparent wind (0 at idle → full at 60 kn+), plus gust noise |
| `M_PilotLens` BLEND | none | amber `(0.62, 0.34, 0.08)`, alpha 0.5, clearcoat 1, rough 0.1. Hero: optional screen-space refraction offset; NPC plain blend |

Other runtime needs:
- apply per-variant joint re-binding (`variants.<v>.jointHeads`, then `skeleton.calculateInverses()`)
- set morph weights and the hair node visibility per variant
- collapse `head` in the cockpit cam
- drive the IK chains to the helm sockets
- blend the additive clips on `seated_base`
- LOD by screen fraction 0.25 / 0.08 (root extras)

## Checker (`scripts/blender/pilot/checkPilotGlb.mjs`)

Reuses `createIO` and `ktx2LevelCount` from `scripts/blender/checkGlb.mjs` (read-only). The hull
rules (foam hull, manifold shell, body-frame identity meshes) do not apply to a skinned character,
so these rules are its own:
1. one root `SB_Pilot`, `assetKind pilot`, contractVersion = pilot_config
2. seat socket node at the origin
3. identity root / rig / LOD transforms
4. one shared skin, ≤ 64 joints, every required MPFB + extra bone present
5. every mesh skinned with JOINTS_0/WEIGHTS_0, no JOINTS_1 (≤ 4 influences), weights sum to 1, joint indices in range
6. mesh names `*_LOD<n>` with lodLevel
7. LOD0..2 present, worst-variant triangles ≤ cap and strictly decreasing
8. both hair styles at LOD0/1, TEXCOORD_1 on hair
9. `variant_b`/`variant_c` morph targets on every primitive
10. materials are pilot slots (variant clones `slot@variant`), ≤ 4 textures each; at final, alphaMode + doubleSided per slot, 3 skin variant materials, `KHR_materials_variants`, hair anisotropy texture
11. every configured clip present, channels target joints, rotation-only, loops ≥ 0.5 s
12. IK chain bones exist; per-variant jointHeads cover every joint
13. final: meshopt + KTX2 with full mip chains

`tests/assetPilot.test.ts` proves the built GLB passes, that the bind pose is seated on the helm
(pelvis on the pan, palms at the wheel grips, Root at the socket), that the hero jointHeads match the
skeleton and the variants differ, and that six broken documents fail.

## Verification renders

All renders are Cycles CPU, 40 samples, OpenImageDenoise, against a grey **proxy** cockpit (not the
parts agent's). Files in the session scratchpad `…/scratchpad/pilot/`:
- `portrait.png`, `portrait_side.png`, `portrait_goggles_up.png`: 85 mm close-up
- `chase_10m_rear34.png`, `chase_10m_front34.png`: 60° FOV at 10 m, 1080p
- `chase_10m_front34_crop.png`: the same 10 m view at 15° FOV, to judge the read
- `cockpit_pov.png`: from the pilot's own eyes, head bone collapsed, 86° FOV
- `lod1_front34_crop.png`, `lod1_near.png`: LOD1 (what the chase cam draws at ~10 m)
- `poses_sheet.png`, `pose_<clip>.png`: key frames. Rows top to bottom: seated_base, idle, steer_left, steer_right / throttle_push, brace, tuck, jolt / capsize_hang, look_back, victory_fist, goggles_up
- `variants_sheet.png`, `variant_<v>.png`: hero, npc_b, npc_c with goggles up

Defects the renders exposed, and what fixed them:

| Seen | Cause | Fix |
|---|---|---|
| suit rendered black, skin grey | Cycles premultiplies base colour by the alpha that holds data (accent mask, SSS thickness) | textures loaded CHANNEL_PACKED |
| spiky "punk" hair, then flat black hair | lift 20–40°; partially covered strand pixels baked premultiplied | lie-back comb and lift 3–22°; unpremultiplied rasterizer |
| black glossy hair shards | custom volume normals broke under skinning | normals removed, card winding made to face out |
| chrome chest straps | 24 cm "slide adjuster" sleeve: length followed path spacing | fixed 4 cm |
| torn orange / chrome vest | collapse and un-subdivide LODs dragged UVs across islands | build at LOD0 resolution; UV-island-split collapse below |
| hands off the wheel in some clips | per-frame IK didn't reproduce the bind | hands glued to the wheel relative to the bind pose |
| wheel under the chin, arms clamped | my assumed helm was too close for an upright pilot | helm moved forward (§Blockers 2) |
| dark ring round the eyes with goggles up | goggle AO baked into the skin, plus the CC0 skin's painted sockets | goggles excluded from skin AO; socket darkening pulled to the surrounding tone (partly works) |
| jagged neckline | MakeHuman face edges at the suit's neck opening | skin extended under the suit, edge smoothed, collar closed |
| npc_c grey hair rendered white | tint ratio overflow | luminance-preserving tint rule |

## Self-critique (honest, against the concept and refs)

Overall: at chase distance (the gameplay camera) the pilot reads as the concept: sand coverall,
orange foam vest with a tall collar, grey 4-point harness, brass strap goggles with amber lenses, an
olive single-ear headset with boom mic, dark gloves on the wheel, and a bare head with short brown
wind-swept hair. Close up it is **not AAA**. It is a solid mid-tier, procedural-plus-MakeHuman
character. The two weakest parts are the ones flagged as highest risk: hair and face.

- **Face (medium).** MakeHuman topology with a CC0 Mindfront skin reads as an ordinary, calm,
  weather-beaten man, not a caricature. Goggles down in the race hide the eyes, which avoids most
  uncanny risk.
  - Close-up, the 1k face texture (a crop of a 2k body atlas) is soft.
  - The brows and lashes are thin MakeHuman cards.
  - Goggles up, the hero still shows a faint greenish shadow under one eye from the source skin's
    painted socket.
  - There is no expression rig (per STYLE-SPEC).
  - npc_b was specified as a woman but still reads more male than female: the only CC0 dark-skin
    set is a male texture, and the gender macro only goes so far on a shared skeleton. A female CC0
    skin (skins01 pack) would fix it; not done.
  - npc_c (grey, older) reads correctly.
- **Hair (medium-low).** It reads as short brown hair swept back by the wind, and there is no
  helmet shell look at 10 m. At portrait distance the cards show as flat chunky blades with visible
  texture repetition and too few flyaway strands; the silhouette hugs the skull. Hand-placed cards
  or a hair-curve-to-card tool, plus a runtime anisotropic shader, are needed for AAA.
- **Gear (good at distance, mid close up).**
  - Goggles and headset match `12-pilot-goggles` well.
  - The vest reads as foam panels with quilting and reflective tape. Its salt and fade overlays
    read blotchy up close, and the shoulder straps are plain slabs.
  - Harness webbing and cam buckle are right. The chest adjusters are oversized and too mirror-like
    in Cycles.
  - The suit is sand with seams, stitched patches, tape and salt lines, but the fabric is smooth
    and low-frequency: no crisp folds, pockets or zip detail.
  - Gloves read as gloves, with puffy fingers. Boots are soft blobs (fine seated). Bottle and
    coiled dash cable are fine.
- **Cockpit arms (mid).** Hands grip the rim, and the arms enter the frame where `05-cockpit-pov`
  has them. The sleeves are smooth thick tubes with no wrinkles, and the orange cuff band barely
  reads. The concept's worn leather gloves and banded cuffs are roughly 60 % there.
- **Animation (acceptable blockout).** Key poses read (steer lean, brace, tuck, jolt, capsize
  hang, look-back, victory fist, goggles up) and the hands stay on the wheel. The motion is
  procedural with no secondary motion or overlap; capsize reads as "arms raised" in the seat frame.
- **Not verified:** the runtime look (no TSL material yet), GPU cost, and the browser. The
  renders are Cycles previews, where transparent shadows and SSS are more forgiving or harsher than
  the game shader will be.

## Blockers / coordination

1. **Eye anchor vs a 1.78 m pilot.** STYLE-SPEC §2 / parts manifest put the cockpit eye at
   sheer + 0.50 with a 0.62 m seat pan. A 1.78 m pilot needs a ~50° crouch to put their eyes there,
   which reads hunched in the chase cam. Lean is capped at 24° (`seat.maxLeanDeg`), so the eyes
   sit **0.16 m aft and 0.13 m above** the anchor (root extras `eyeAnchorError`). Either the cockpit
   camera uses the pilot's eye bones, or the anchor moves to about sheer + 0.63. Decision needed.
2. **Helm, throttle and dash sockets are ASSUMED** (`pilot_config.json helm`):
   - wheel centre (0, 0.28, 0.53) in the seat frame, r 0.19, tilted 40°
   - throttle (0.30, 0.16, 0.55)
   - cable anchor (0.36, 0.02, 0.70)

   The parts manifest lists Helm/Throttle modules with no coordinates. The first guess (wheel
   0.40 m ahead) put the wheel under the chin. When the parts agent publishes sockets, update
   `helm` and rebuild; the runtime IK covers small differences.
3. **Contract.** `src/speedboat/assets/assetContract.json` has one `M_Pilot` slot ("suit, helmet")
   and no skinned rules. The pilot uses its own four slots and checker (`pilot_config.json`,
   `checkPilotGlb.mjs`). Adding the pilot slots and a pilot section there is for the contract
   owner; nothing under src/ was touched.
4. **Budget.** LOD0 23.8k worst case vs the parts manifest's 14k pilot line (§Budget).
5. **Runtime not built.**
   - TSL skin/hair/lens materials
   - variant re-bind
   - IK to the helm sockets
   - hair wind
   - first-person head collapse
   - additive blending
6. **File size.** 7.97 MB final (production sha256 `35361f26cc336754…`), of which 6.1 MB is textures:
   - gear normal 2048² UASTC: 2.2 MB
   - gear ORM 1024²: 0.9 MB
   - hair base: 0.9 MB

   Options: gear normal at 1024² (−1.6 MB, softer seams), or an NPC-only GLB without the hero skin set.
7. **Determinism.** Two full quick builds (`--bake-size 256 --samples 4 --max-texture 512`) gave
   byte-identical final GLBs (sha256 `d1f99812e5751d3b…`). Getting there took two fixes:
   - the voxel-remeshed boots came out with a run-dependent face order, which changed every UV pack
     after them; they are now canonicalized
   - packed UVs carried float noise; they are now snapped to 1/65536

   The raw Blender export still differs by one tangent component (1e-4), and the 10-bit tangent
   quantization absorbs it. The 2048² production build was run once after these fixes; its
   reproducibility at production settings is expected but not re-verified (a second 8-minute run was
   not made).

---

## v2 (2026-09-13): rebuild against the real parts cockpit

Goal: push the MPFB2 pilot toward AAA close-up quality (user picked "keep improving MPFB2 v1"), pose it
on the parts build's actual helm, and ride the cockpit camera on the pilot's head.

### What changed, per v1 defect, with an honest verdict

| # | v1 defect | v2 change | Verdict |
|---|---|---|---|
| 1 | Hair read as flat chunky slabs | `hair.py` rewritten. Strand atlas with 2x2 supersampling: 8 thin strip cells, 3 base clumps, 3 wisps, a dense cap, a bun swirl. Strands converge into clumps, taper, fade in at the root and thin at the tip; card sides use a lateral alpha window. Cards are layered: a cap shell that fades out over its last 14 mm (surface distance to its edge; MakeHuman scalp weights are hard 0/1), ~110 base clumps, ~225 thin strips, 40 hairline strips rooted 8 mm behind the hairline, 34 flyaways. Scalp-density weighting and an 80 kn comb: up and over the brow, flat on top, down at the nape, tips curling at the crown. Shading normals lean 70 % toward the scalp normal. Flow/anisotropy texture as v1. Three styles: `swept` (hero), `bun` (npc_b), `buzz` (npc_c). No helmet. | Much better than v1 from the side and back: it reads as short, wind-combed hair with loose strands. From the front and above it still shows tapered card slivers on a dark undercoat, and it reads straw-like at 0.5 m. Mid-tier real-time cards, **not AAA**: that needs groom-to-card baking or strand rendering plus the runtime Kajiya-Kay shader. |
| 2 | Jagged neck seam | A knit neck gaiter (`fit.gaiter_geometry`): 24 x 12 rings with a soft fold, a rolled lip that turns inside, and ray-cast radii smoothed over the neck. It is taller at the back and runs from below the suit neckline to under the jaw. Delete-under-cloth: the suit neckline is cut inside the gaiter, and the skin stops inside it. Cloth weights hang from the collar (head share capped), and the gaiter's lower rows take the suit's weights, so nothing parts when the head pitches. v1's stand collar is gone. | Back and sides clean. The front is clean in rest. In the leaning bind pose, a front close-up still showed the throat skin's cut edge over the gaiter. The final build raises the gaiter front to 50 % of the neck, cuts the skin at 12 %, and gives the knit's top 65 % head weight. Verified in the last renders (see §v2 renders). |
| 3 | Plasticky suit tubes | Gear compositor rewritten around bone-local and surface coordinates (the bind is seated and leaning, so world axes are wrong). Height map (baked through a Bump node, Distance 3): leg and sleeve seams with double stitching, raglan and waist seams, zip placket, inner-elbow and back-of-knee compression rings, sleeve bunching above the gauntlet, twisted forearm pipe folds, upper-arm drape, hip diagonals. Also dark rubber knee pads, elbow patches, reflective arm tape, thigh cargo pockets with flaps, a cross-stitched shin repair, duct tape. Salt tide lines on legs and sleeves, salt crust and grime in fold valleys, abraded knees, sun fade, canvas roughness 0.86-0.97. Detail normal is now a tiling plain-weave canvas. Gloves: a swept leather gauntlet flares over the sleeve end (the sleeve is tucked 4 mm under it), with an accent band, velcro and stitching. The glove texture adds finger grooves. | Sleeves and knees now read as fabric with folds. The cockpit POV and sleeve close-ups show bunching and pipe folds, and the gauntlet overlaps the cuff as in concept 05. Silhouettes are still smooth tubes (the folds are normal-map only; LOD0 suit 2,000 tris). Fingers are one inflated surface, so the glove reads mitten-like up close. |
| 4 | Blotchy vest, oversized chrome buckles | Vest pattern driven by a baked `gc` attribute (girth, height, edge distance) instead of curvature noise: vertical quilted channels with stitched grooves and pillowed foam, a panel seam, black binding on every edge, reflective tape, a velcro pocket, and soft fade/salt mottling. Chest adjusters are now open tri-glide frames (58 x 26 mm, 4.4 mm bar) in dark anodised metal. Webbing is 50 mm (APBA / REFERENCES g8) with a weave and bound edges. The cam-lock plate is thinner. | Blotches gone; quilting and binding read at portrait distance. The harness covers most of the vest's front in this lean. Hardware is at real scale. |
| 5 | Plain soft face, socket shadow | Weathered courier face: 19 MPFB face targets (cheekbones, hollow cheeks, square jaw/chin, nose hump, heavy brow ridge, narrowed eyes, thin lips, laugh lines). Skin atlas at 2048: MakeHuman's head is ONE UV island, so a radial fisheye warp about the nose gives the face 2.6x linear density, and the scalp under the cap is deleted. Sculpted height baked with the Mindfront NRM into one tangent-space normal: forehead and frown lines, crow's feet, under-eye lines, nasolabial folds, a scar through the left brow. Albedo adds jittered stubble follicles with a beard shadow, sun spots, and scar tissue. Eye socket: pixels near an eye that are greener than the mirrored side of the face (sampled through an X-mirrored MH UV layer) take the mirror, then darker-than-ring pixels are pulled to the ring tone. Pores come from the tiling detail normal. | Reads older, sun-lined and characterful; goggles-up shows no socket shadow. Still a MakeHuman face: soft 3D form, CC0 source acne kept, no expression rig. The runtime also needs a proper skin shader. |
| 6 | npc_b read male | CC0 female skin `middleage_african_female` (system assets, mhmat header "released as CC0"), female face targets (fuller lips, cupid's bow, softer oval jaw, slimmer neck, raised brows) and a high bun on the crown (visible from the front and the chase cam). npc_c: CC0 `old_asian_male` skin, age ~60, heavier face, eye bags, full grey stubble, a cheek scar and a clipped grey buzz cut. | The three variants are distinct in hair silhouette, skin and age. npc_b reads female mainly through the face and the bun; the suit and vest hide the body, so it stays a close-up read, not a silhouette one. npc_c's buzz reads as a smooth grey cap beyond ~1 m. |
| 7 | LOD0 23.8k (budget 14k) | Per-piece targets (§v2 budget), suit hidden under the vest (578 faces), scalp under the cap removed, cable coil as a normal-mapped tube, lighter harness sections. | **LOD0 17,945** worst variant (hero), LOD1 6,123, LOD2 2,016. |
| 8 | Hands broken on the wheel (user feedback) | New `grip.py` solver on the real rim torus: palm frame searched for the smallest wrist bend; fingers wrap proximal to distal onto the contact circle; PIP/DIP never hyperextend; thumbs laid along the pilot-facing rim surface. The glove is measured against the rim and re-wrapped until no vertex is > 1 mm inside. The hand's roll goes to `lowerarm_twist` (weights ramp to 0.9 at the wrist). Elbows bend down and out (34 deg). Steer clips keep the grips glued to the rotating rim (IK each frame). The throttle clip solves a palm frame and finger wrap on the real throttle handle and rides the lever from idle to full. | Grips read as gloved fists wrapped round the rim at ten-to-two, thumbs on top, no penetration (glove clearance 0 to +8 mm), twist 2.7 deg, wrist bend 30 deg. The throttle reach needs a 24 deg torso roll and a 54 deg wrist bend: the quadrant sits 0.67 m off-centre at the well wall. |

### User feedback round 2: goggle strap and hairline

User, on the v2 portrait: "the headband of the goggles is disconnected and the hairline floats like 2 cm
above the forehead".

**Strap** (`fit.build_goggles`). One continuous band from the left cup's outer rim, round the back of
the skull, to the right cup:
- 41 samples in a plane through both cup attachments, rising 2.8 cm at the back
- each sample ray-cast onto the head (skin + the full MakeHuman scalp, `ScalpSrc`)
- lifted 2.5 mm over skin at the temples and 10 mm over the hair, blended along the band
- the first and last three samples blend into the cup attachment, and the smoothed band is pushed back out wherever it dips under its offset

The hair stage presses card vertices under the strap (187 on the hero). Rigging: the strap's back
half hands its weight from `goggles` to `head_geo`. In `goggles_up` it stretches back over the hair
instead of swinging into the nape.

**Hairline** (`hair.py`, `texture.py`):
- the cap shell lies on the scalp at its edge (0.4 mm) and rises to 3 mm, 2.5 cm inside it (surface distance to the cap boundary)
- cards within 3.5 cm of the hairline are rooted on the surface, with lift, stand-off, noise and curl scaled down to a quarter at the edge
- the skin gets a band of fine jittered root dots and root shadow just outside the cap's fade

Verdict after renders `after_head_front/side_l/side_r/back.png` and `after_portrait_goggles_up.png`:
- the strap is continuous and attached to both cups, rides over the hair at the back and sits on the temples
- the hairline sits on the skin with no gap
- still below AAA:
  - the cap edge is a crisp line from the side (MakeHuman faces are ~1 cm, so the 14 mm fade spans one face)
  - from the front, the up-combed hairline strips read as a short spiky brush
  - a few cards poke out under the strap's lower edge

### Helm, sockets and the seat frame (read from the parts build)

The pilot frame is now the hull JSON seat station on the pan top, following `scripts/blender/parts/seat.py`,
which centres the pan on the station. v1 used the pan's front edge. Values come from
`assets/models/speedboat_pipeline_test.glb`, which was built from the parts code at b092f2e against
the current `deepV12.hull.json`: `partsAnchors` seatZ 0.234, deckY 0.82. All positions below are in
the pilot frame, three.js axes, metres.

| Socket | Value | Source |
|---|---|---|
| seat socket | body (0, 0.69004, 0.234) | `partsAnchors.seatZ`, soleY + 0.62. **No seat socket node in the parts GLB** |
| wheel hub / axis | (0, -0.0797, 0.7284) / (0, 0.324, -0.946) | `Helm_LOD0` extras pivot/axis |
| rim radius / tube | 0.18 / 0.0165 | `helm.py` code only (**not in extras**) |
| throttle pivot / axis | (-0.67, -0.07, 0.67) / (0.990, 0.139, 0) | `Throttle_LOD0` extras (idle -28, full 32 deg) |
| throttle handle | local (-0.015, 0.215, 0.006), roll 8 deg | `throttle.py` code only (**not in extras**) |
| foot bar | (+-0.15, -0.40, 0.36) | `seat.py` code only (**not in extras**) |
| dash cable jack | (0.36, -0.2, 0.93) | **missing: no parts socket, still assumed** |
| parts eye anchor | (0, 0.63, 0.45) | `partsAnchors.eye` |

`tests/assetPilot.test.ts` reads the parts GLB and fails if its helm moves more than 2 cm from
`pilot_config.json helm`. The solver then re-poses on rebuild.

**Ergonomics blocker (parts/hull).** The wheel hub sits 8 cm *below* the seat pan and 0.73 m ahead of the
station. A 1.78 m pilot reaches the rim with bent elbows only by perching the hips forward (+0.12 m)
and leaning 43 deg. The hands end up under the face, so the seated eye is 0.65 m above the pan and 0.60 m ahead of the station
(parts eye anchor error: +1.5 cm up, +14.6 cm forward). At the runtime camera pitch (gaze 9 deg down)
the wheel is out of the 86 deg view (`after_cockpit_pov.png`); pitched a further 28 deg down, the view matches
concept 05 (`after_cockpit_pov_down.png`). Recommended helm for an upright racing seat: hub near
(0, +0.30, 0.50), about 0.38 m higher and 0.23 m aft, and the throttle handle near (-0.33, 0.20, 0.40).
The pose solver adapts on rebuild.

### Cockpit camera (user decision: rides the eye bones)

- `cam_eye`: an empty parented to the `head` joint (a node, not a skin joint), 0.055 m ahead of the eye
  midpoint along the head's forward axis, with node -Z = view and +Y = up (the glTF camera
  convention). A near plane of <= 0.01 m clears the goggle lenses.
- Head hide: new deform bone `head_geo` (child of `head`). It carries every head-weighted vertex:
  face, hair, brows, lashes, eyes, goggles, headset, and the cable top. The `goggles`, `eye_l` and
  `eye_r` bones are its children. Scaling `head_geo` to ~0 hides the head; `head` and `cam_eye` keep
  their transform. The skin is 64 joints. Extras: `firstPerson {collapseBone: head_geo, cameraNode:
  cam_eye}`.
- Checker rules (tested to fail when broken):
  - `cam_eye` is a child of `head`
  - it sits between the eyes at forwardM (+-1 cm)
  - it looks toward +Z and is not under the collapse bone
  - no vertex is weighted > 25 % to `head`

### v2 budget (LOD0 worst variant = hero with swept hair)

| Piece | LOD0 | LOD1 | LOD2 |
|---|---|---|---|
| Hair_swept (bun 1,488 / buzz 920) | 3,116 | 1,094 | - |
| HairCap | 668 | 199 | 139 |
| Skin (head, face, neck) | 2,298 | 899 | 457 |
| Suit (torso under vest deleted) | 2,000 | 878 | 469 |
| Gloves + gauntlets | 1,800 | 540 | 200 |
| Vest (+ VestLow at LOD2) | 1,780 | 600 | 260 |
| Goggles (incl. strap) / lenses | 1,300 / 120 | 420 / 60 | 180 / - |
| Harness | 1,050 | 419 | 200 |
| Headset | 876 | 336 | - |
| DashCable | 652 | - | - |
| Boots | 600 | 259 | 108 |
| Gaiter | 528 | 170 | - |
| VestCollar | 396 | 150 | - |
| Bottle, Eyes, Brows, Lashes | 300, 172, 139, 150 | -, -, 100, - | - |
| **Total** | **17,945** | **6,123** | **2,016** |

Checker caps: 18,000 / 8,000 / 2,500. Against the hero boat's 120k LOD0: hull ~40k + parts 63.6k +
pilot 17.9k = ~121.5k. The parts manifest line is 14k, so ~4k must come back from hull or parts, or
the total becomes ~122k (coordinator call). Cheapest further pilot cuts:
- goggles 1,292 -> 850: visible facets in the portrait
- dash cable 652 -> 300: a thinner tube
- HairCap 668 -> 400: its fade edge needs the vertices

### Texture memory (final GLB 9.79 MB, textures 8.0 MB, GPU ~22.8 MB with mips)

| Texture | Resolution, codec | File size |
|---|---|---|
| T_Pilot_normal | 2048 UASTC | 3.03 MB |
| T_PilotSkin_normal | 2048 UASTC | 1.82 MB |
| T_Pilot_orm | 1024 UASTC | 0.91 MB |
| T_PilotHair_base | 1024 UASTC | 0.63 MB |
| T_Pilot_base | 2048 ETC1S | 0.47 MB |
| T_PilotSkin_orm | 1024 UASTC | 0.38 MB |
| T_PilotSkin_base_hero | 2048 ETC1S | 0.27 MB |
| T_PilotHair_flow | 512 UASTC | 0.20 MB |
| NPC skin albedos | 1024 ETC1S | 0.08 + 0.10 MB |
| detail normals | 256 UASTC | 0.04 + 0.08 MB |

Saving option: gear normal at 1024 (-2.3 MB), at the cost of the fold relief in the cockpit view.

### New installs, assets, licences

No new installs, downloads or accounts. Two more CC0 skins from the already-installed
`makehuman_system_assets` pack are now consumed, each with an mhmat header reading "explicitly released as CC0 in september 2020":
- `skins/middleage_african_female/middleage_darkskinned_female_diffuse.png` (npc_b)
- `skins/old_asian_male/old_lightskinned_male_diffuse2.png` (npc_c)

The Mindfront male African skin is no longer used. `assets.lock.json` was rewritten with
`--write-lock`; the existing hashes are unchanged.

### v2 verification renders

Cycles CPU, 32 samples, OIDN. The pilot sits in the **real parts cockpit**: the parts GLB is decoded
(meshopt and KTX2 to PNG) with a one-off scratchpad script, the hull shell is hidden, and the ocean is a
flat plane. Files are in the session scratchpad `…/scratchpad/pilot-v2/final/`, as `after_*.png`
(v2 build) and `before_*.png` (v1 build through `render_pilot.py --legacy`, v1's grey proxy wheel). v1's
original portrait/chase/cockpit/pose/variant renders remain in `…/scratchpad/pilot/`. Shots:
- portrait, portrait_side, portrait_goggles_up
- head_front, head_side_l, head_side_r, head_back (hairline + strap)
- hair_front34 / side / back
- neck
- sleeve_glove_l
- hands_{l,r}_{pilot,outside,dash}
- cockpit_pov (runtime pitch) and cockpit_pov_down
- chase_10m_* (+ crop)
- variant_*, variants_sheet
- pose_*, poses_sheet

Honest comparison against concept 11 / 12 / 05:
- **Cockpit POV:** from the camera pitched down, closest to concept 05. Gloved hands at ten-to-two on the real rope rim, orange-banded gauntlets over folded sleeves, dash and gauges behind. The knees show under the wheel because the helm is low.
- **Chase at 10 m:** reads as the concept pilot (sand suit, orange vest, dark harness, goggles, headset, bare head), hunched onto the low wheel.
- **Portrait:** weathered and characterful, clean hairline, goggles and headset as concept 12. Hair reads short and wind-swept but card-like. The concept's messy volume and curls are not there.
- **Below AAA and why:** hair (cards, no groom bake, no runtime hair shader to judge); face form (MakeHuman topology, no sculpt pass beyond targets and a baked height layer, no wrinkle maps or expression rig); cloth silhouettes (folds are normal-map only at LOD0 budget); gloves (one inflated MakeHuman hand, no modelled seams); the pose (dictated by the parts helm).
- **Not verified:** runtime shaders (skin SSS, hair anisotropy, detail normals, alpha-to-coverage), GPU cost, browser.

