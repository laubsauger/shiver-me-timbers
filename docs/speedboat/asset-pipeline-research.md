# Speedboat hero model — asset pipeline research (§T176)

Status: research only, 2026-09-13. Nothing installed, no keys, no uploads. Every price and licence below is
from vendor pages read on that date; re-check before paying. Items marked **UNVERIFIED** could not be
confirmed from a primary source.

Brief (user): "find and use an image-to-3D skill to build a proper speedboat model … high fidelity,
different materials … AAA standards." Target: salvaged/rebuilt deep-V offshore racer, 12–14 m, β 24°,
solo pilot visible, cosmetic damage, 8 boats on screen, cockpit cam. Physics proxy stays
`src/speedboat/hullMesh.ts` (286 tris, §V101/D12). The render mesh is a separate asset.

Two things in the repo disagree with the brief. Settle both before modelling:
- **Length.** `REFERENCE_DEEP_V` in `hullMesh.ts` is 11 m / chine beam 2.4 m. The brief says 12–14 m.
  The render hull and the proxy must come from the same numbers (§V77), so pick one.
- **Cockpit timing.** `design-doc.md` decision 15 puts the cockpit cam in phase 5, not first playable.
  That decides whether the LOD0 interior is in scope now.

---

## 1. Summary

**No image-to-3D tool today produces a AAA hard-surface boat you can drop in as-is.** All of them return a
triangle soup or a remeshed quad cage with baked or approximated PBR in one UV atlas. On a planing hull
they soften the parts that matter most: sharp chines, lifting strakes, the transom edge, a
symmetric V, and exact dimensions. The best ones (Rodin Gen-2.5, Meshy 7, Hunyuan 3.1) are good at
**secondary organic or greebly parts** (pilot, seats, engine cowl, salvage clutter) and at **fast blockout
and lookdev**. They are not good at the hull.

**Recommended pipeline:** a hybrid, driven by code.
- **Hull and deck:** parametric, generated in headless Blender Python from the same shape functions as the
  physics proxy.
- **Secondary parts:** image-to-3D via Rodin Gen-2.5 (fal.ai or Hyper3D API), then cleaned and baked in Blender.
- **Materials:** authored as a fixed slot contract and rebuilt at load time as TSL node materials with the
  existing `waterLighting()` hook.
- **Output:** KTX2 + meshopt through gltf-transform.

Details are in §6.

---

## 2. Claude Code skills, plugins and MCP servers

Local plugin check (2026-09-13):
- `~/.claude/plugins/cache` has no 3D, Blender or image-to-3D skill (cavekit, caveman,
  claude-plugins-official {claude-md-management, code-simplifier, frontend-design}, humanizer,
  openai-codex, webgpu-threejs-tsl).
- The official marketplace manifest (`marketplaces/claude-plugins-official`, 295 plugins) has **no Anthropic
  or third-party image-to-3D or Blender plugin**. The nearest are `adobe-for-creativity` (2D image editing),
  `runway-api` (image and video gen), `unity`, and `unreal-engine-skills-for-claude-code`.
- So "an image-to-3D skill" means an MCP server or a vendor API.

| Tool | Install | Output | Mesh quality (hard surface) | Cost / key | Commercial licence | Uploads | Local on M3? |
|---|---|---|---|---|---|---|---|
| **blender-mcp** (ahujasid, community) [gh](https://github.com/ahujasid/blender-mcp) | `claude mcp add blender uvx blender-mcp` + addon.py in Blender ≥3.0 | Whatever the backend returns, imported into the scene. Also Poly Haven (CC0), Sketchfab, Poly Pizza | Backend-dependent. Adds `execute_blender_code` (arbitrary Python) and viewport screenshots | Free. Rodin, Hunyuan, Sketchfab and Poly Pizza each need their own key | MIT tool. Asset licence per source | **Telemetry ON by default** (opt out: `DISABLE_TELEMETRY=true`). Images go to Rodin/Tencent when those tools are used | Blender side yes. Generation is remote unless a local Hunyuan API URL is set |
| **Official Blender Lab MCP** [blender.org](https://www.blender.org/lab/mcp-server/), [projects](https://projects.blender.org/lab/blender_mcp) | Blender add-on + separate MCP process over TCP | Python API access only, no generators | n/a | Free | GPL-family (Blender) | None built in. Docs warn LLM code runs unguarded | Yes |
| **Meshy MCP** (official) [gh](https://github.com/meshy-dev/meshy-mcp-server), [guide](https://www.meshy.ai/tutorials/meshy-mcp-guide) | npm `@meshy-ai/meshy-mcp-server`, API key | GLB/FBX/OBJ/USDZ/blend. PBR base/metal/rough/normal (+emission), 2k/4k/8k, **single atlas**. Quad or tri remesh, 100–300k target | Meshy 7 (released 2026-08-10) leads on image alignment and "surface detail" [blog](https://www.meshy.ai/blog/meshy-7-image-to-3d-geometry-alignment). Reviewers still report melting on hard-surface props [unite.ai](https://www.unite.ai/meshy-7-puts-a-number-on-image-to-3d-alignment/) | API needs a paid plan. Pro $20/mo = 1000 credits. ~30 credits per textured multi-image gen [pricing](https://www.meshy.ai/pricing) | Paid: user owns output. **Free: CC BY 4.0** | Yes (URL or base64) | No |
| **Tripo MCP** (official, alpha) [gh](https://github.com/VAST-AI-Research/tripo-mcp) | Python MCP + Tripo Blender addon | GLB. H3.1 PBR + quad remesh. Smart Mesh P1 low-poly 48–20k faces [blog](https://www.tripo3d.ai/blog/introducing-smart-mesh-v1) | Best quad topology in several 2026 comparisons. Hard-surface fidelity below Rodin | Pay-as-you-go credits, 300 free [docs](https://docs.tripo3d.ai/get-started/pricing.html) | **UNVERIFIED** (read ToS) | Yes | No |
| **Hyper3D Rodin Gen-2.5** [docs](https://docs.hyper3d.ai/en/api-specification/rodin-gen2-5), [fal](https://fal.ai/models/fal-ai/hyper3d/rodin) | REST (Hyper3D or fal.ai). Reachable from blender-mcp. [Deemos Blender integration](https://github.com/DeemosTech/blender-mcp-rodin-integration) | GLB/FBX/OBJ/USDZ. PBR or Shaded. Raw tri (up to 10M+), Quad, Smart Low-Poly. 2K→4K (HighPack) up to 12K textures. 1–5 images `concat` multi-view. Bounding-box condition | Gen-2.5 (May 2026). **Best hard-surface of the generators** in 2026 tests (panel lines, mechanical parts) [cinevva](https://app.cinevva.com/guides/ai-3d-model-generators), [rundiffusion](https://learn.rundiffusion.com/ai-3d-model-generators/). Still bevels chines into fillets | fal ≈ **$0.40/gen, HighPack 3×**. Hyper3D direct API only on Business $120/mo [pricing](https://hyper3d.ai/pricing) | Output use not limited on paid tiers [ToS](https://hyper3d.ai/legal/terms). fal page lists commercial use | Yes. Hyper3D API data kept 7 days, not used for training [data policy](https://developer.hyper3d.ai/legal/data-policy) | No |
| **Tencent Hunyuan 3D 3.1** (cloud) [runware](https://runware.ai/docs/models/tencent-hunyuan-3d-3-1-pro), [Tencent](https://www.tencentcloud.com/techpedia/146576?lang=en) | Tencent Cloud API (SecretId/Key). blender-mcp supports it | GLB. PBR. **Up to 8 views**. Part split endpoint. PolyGen Smart Topology (quad/tri) [fal](https://fal.ai/models/fal-ai/hunyuan-3d/v3.1/smart-topology) | Strong default. Watertight. Part splitting helps kitbash | Credits. 1000 free on promo. Express 15 credits/run | Cloud ToS **UNVERIFIED** | Yes (to Tencent) | No |
| **3D AI Studio** [api](https://www.3daistudio.com/Platform/API/Hunyuan3D) | Aggregator API | Rodin / Meshy / Tripo / Hunyuan behind one key | Same as upstream | Subscription | Per its ToS | Yes (to aggregator + upstream) | No |
| **Microsoft TRELLIS.2-4B** [gh](https://github.com/microsoft/TRELLIS.2) | Official: Linux + NVIDIA ≥24 GB only. Mac ports below | GLB. Base/rough/metal/opacity | O-Voxel keeps sharp features better than older SDF models. Dense tri soup (400k+ verts) | Free weights. HF gated deps (DINOv3, RMBG-2.0) | **MIT**. nvdiffrast/nvdiffrec are non-commercial (texturing path) | No, if local | Via community port (§3) |
| **Stability SF3D / SPAR3D** [gh](https://github.com/Stability-AI/stable-fast-3d), [SPAR3D](https://huggingface.co/stabilityai/stable-point-aware-3d) | pip. Experimental MPS | GLB, UV-unwrapped, low-res albedo + rough/metal scalars | Fast (<1 s CUDA). **Low fidelity**, blob-like on hard surface | Free | Stability Community Licence: commercial only **< $1M annual revenue** | No | Yes (experimental MPS) |

Where the generators fit on this boat:
- Single-image input fixes the silhouette only. Multi-view (Rodin 5, Hunyuan 8, Meshy 4) is needed for
  deck and cockpit layout.
- Rodin warns that views that disagree on design or lighting produce a mash-up.
- None of them take a dimension-exact spec. Rodin's bbox condition only scales the result.

---

## 3. Local options on M3 Max 36 GB (no CUDA)

| Model | Port | Measured on Apple silicon | Fits 36 GB? | Verdict |
|---|---|---|---|---|
| TRELLIS.2-4B | [trellis-mac](https://github.com/shivampkumar/trellis-mac) (PyTorch MPS), [trellis2-apple](https://github.com/pedronaugusto/trellis2-apple) (MLX) | M1 Max 64 GB: shape ~3.3 min. Peak RAM 17.5–18.5 GB. **PBR bake 3954 s and pure-PyTorch textures come out as noise**, so the author uses `--no-texture` [lilting, 2026-04-21](https://lilting.ch/en/articles/trellis2-m1-max-hands-on). M4 Pro ~5 min at 512 | Yes | Usable for **geometry-only blockouts**, no uploads. Textures unusable |
| Hunyuan3D 2.1 | [hunyuan3d-2.1-mac-rocm](https://github.com/VladimirTalyzin/hunyuan3d-2.1-mac-rocm), [Brainkeys](https://github.com/Brainkeys/Hunyuan3D-2.1-mac) | M4 Pro 24 GB: shape ~6 min. PBR "Safe" preset = **6 views @ 256 px** (no flash-attn on MPS) → low-res textures. ~30 GB download | Yes | Geometry OK, textures below AAA. **Licence does not apply in EU, UK or South Korea**, so it cannot be used from those territories |
| SF3D / SPAR3D | official, MPS experimental | seconds | Yes | Too coarse for hero use. Fine for quick silhouette tests |

Local runs keep images private and cost nothing, but they are 5–10× slower than CUDA and **worse than the
2026 cloud models** (Rodin 2.5, Meshy 7, Hunyuan 3.1). Each needs an install plus a Hugging Face account for
gated weights, which needs user approval.

---

## 4. Reference images

Available to us today, with nothing new installed:
- **Codex CLI 0.154.0 is installed** (`~/.local/bin/codex`) with `image_generation` = stable/true (gpt-image
  through the user's OpenAI/ChatGPT account). Calling it sends prompts to OpenAI and uses the user's plan.
  **Needs approval.**
- **Adobe Photoshop 2026** is installed: Firefly generative fill/expand, Adobe's commercially-indemnified model.
  Good for livery masks, damage decals and turning a concept into consistent views.
- Claude has no image generation. It can write exact orthographic SVG line drawings (profile, plan, body
  plan, transom) from `hullMesh.ts` numbers.
- Licensed photos of real offshore racers (Fountain, Cigarette, Class 1 cats) are fine as **mood/AD refs**.
  Feeding a trademarked, recognisable boat into a generator and shipping the result is a likeness/IP risk.
  Don't.

Getting consistent multi-view input (this is where hard-surface fidelity is won or lost):
1. Headless Blender renders the parametric hull (§6 step 2) as clay: front, side, back, top, 3/4. The
   geometry is consistent across views by construction.
2. Paint over it: gpt-image edit or Photoshop Firefly, same prompt and seed, per view (salvaged 2100 racer,
   patched gelcoat, livery, exposed outboards). The generator keeps the silhouette and adds surface design.
3. Feed only **part crops** (engine pod, seat pair, windscreen frame, pilot) to Rodin/Hunyuan multi-view.
   The hull is never fed.

---

## 5. Getting to AAA

### 5.1 Why generators fail on this hull
- Chines, strakes and the transom need crisp edges on a smooth hull.
- Generators run implicit fields (SDF or voxel) through marching cubes and then remesh. That rounds edges
  under ~1–2 % of the bbox. On a 13 m boat that is 13–26 cm, bigger than a strake.
- They output one atlas at 2–4k. Over 13 m that is ~3 mm/px at 4k, before UV waste. It does not hold up
  in a cockpit cam.
- Lighting is often baked into albedo. No clearcoat, transmission or livery separation.
- They are asymmetric and not dimension-matched to the proxy. A render hull that doesn't match the proxy
  produces a visible sink or float offset and a wetline in the wrong place.

### 5.2 The three routes compared

| | A. Parametric hull in Blender + gen parts (**recommended**) | B. Generator-first (Rodin multi-view whole boat → cleanup) | C. Pure code (extend TS loft + TSL materials) |
|---|---|---|---|
| Hull fidelity | Exact β, chines, strakes. Beveled edges with weighted normals. Matches proxy (§V77) | Soft chines, asymmetry. Needs full manual retopo → effectively a remodel | Exact, and matches proxy for free |
| Parts / pilot | Gen + retopo: good | Good-ish, fused to hull (needs separating) | **Weak.** A convincing pilot or outboard in code is weeks of work |
| Texturing | Real UVs, baked AO/curvature, trim sheets, livery mask | One atlas, baked light | Tri-planar procedural. No baked AO or edge wear |
| Automation / repeatability | Scripted `.py` in git. Rebuild on param change | Stochastic, per-seed | Fully in code |
| Effort to AAA (1 agent + user review) | ~2–3 weeks | ~1 week to a "good demo". **Can't reach AAA** without doing A anyway | ~3–4 weeks, parts stay the weak spot |
| Cost | ~$30–80 API | ~$20–50 API | $0 |
| Risk | Blender scripting depth, bake quality | High: melted details, IP-like outputs | Pilot/engine read as procedural |

### 5.3 Budgets for 8 boats (WebGPU, §V17 render ≤ 8 ms)

| LOD | Switch (screen height) | Tris (hero / NPC) | Contents |
|---|---|---|---|
| LOD0 | > 35 % or cockpit cam | **90–120k** hero incl. cockpit + pilot / **45–60k** NPC (no interior detail) | all parts, beveled hull, rails, cleats |
| LOD1 | 12–35 % | 15–20k | merged small parts, interior boxed |
| LOD2 | 4–12 % | 4–6k | hull + deck + engines + pilot silhouette |
| LOD3 | < 4 % | ~1k | hull shell + windscreen card |

Worst case (1 hero LOD0 + 7 NPCs near): ~120k + 7×50k ≈ 470k tris, ~×2 with shadow pass. Acceptable on M3
Max. Measure with the perf HUD (§V17).

Draw calls and pipelines:
- **≤ 7 material slots per boat, shared by all 8 boats** (one pipeline set, §T.40). Livery hue goes through
  an object-scoped uniform, the same mechanism as `setSailTint` → `userData.sailTint`. No texture set per boat.
- Merge static parts per material per LOD. About 7 draws per boat, ×8, plus shadow draws.

Textures (KTX2, shared across all boats):
- Hull/deck UDIM-free 4096² set: baseColor (+ livery mask in a separate 1k R8), normal, ORM packed.
- Trim sheet 2048² for fittings/metal/rubber.
- Cockpit/instrument 2048² (hero only, lazily loaded).
- Pilot 2048².
- Rough GPU memory with mips, BC7 via Basis UASTC: 4k ≈ 21 MB/map. Total ≈ 3×21 + 3×5 + 5 ≈ **~85 MB**.

**§V40 sampler wall (16 per stage on Metal):**
- `waterLighting()` already binds caustics/wetline/ocean samplers in the receiver fragment stage.
- Keep hull PBR to **≤ 4 filterable textures** (baseColor, normal, ORM, livery/damage mask packed RG).
- Recount in a binding-ledger test like `tests/oceanBindingBudget.test.ts`.

### 5.4 Material slots (glTF material name → TSL factory)

| Slot | Surface | Node material notes |
|---|---|---|
| `M_Gelcoat` | hull topsides + deck gelcoat | MeshPhysicalNodeMaterial, `clearcoat` 0.8–1, clearcoatRoughness 0.05–0.15. Livery = mask × uniform hue. Wear/patch mask. waterLighting tint/roughness |
| `M_Antifoul` | below waterline | rough, matte. Wetline darkening is strongest here |
| `M_NonSlip` | deck walk areas | tileable diamond-tread normal (detail UV2 or tri-planar), rough 0.7 |
| `M_Carbon` | cowls, dash, spoiler | anisotropic-looking weave via normal + clearcoat. r180 has `anisotropy` on physical node material. Test the cost |
| `M_Metal` | rails, cleats, props, trim tabs | trim sheet, brushed stainless + rust/salt mask (Poly Haven CC0 for rust detail) |
| `M_Perspex` | windscreen/canopy | **hero:** `transmission` (costs a viewport-texture copy). **NPC:** `transparent`, ior 1.49, thin specular. No transmission × 8. Cracked variant = normal/alpha decal |
| `M_Rubber` | fenders, rub-rail, seals | rough 0.85, dark |
| `M_Cockpit` | instrument panel, seats, harness | hero-only atlas. Emissive gauges driven by uniforms |
| `M_Pilot` | suit, helmet (visor = physical clearcoat) | separate skinned or rigid mesh. Head/arm bob can come later |

Damage variants:
- A `damage` mask channel (scuffs, gelcoat chips showing grey fibreglass, scorch) blended by a per-boat
  uniform `0..1`.
- Plus 2–3 geometry swaps as hidden nodes (cracked windscreen, bent bow rail, missing cowl panel).
- No per-damage meshes of the whole boat. Cosmetic-only per `design-doc.md` decision 7.

---

## 6. Integration with three.js r180 WebGPU (checked in `node_modules/three`)

Loader:
- `GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder)`.
- `KTX2Loader.detectSupport(renderer)` has a WebGPU branch (`renderer.hasFeature('texture-compression-bc'|'astc'|'etc2')`).
  Call it **after `await renderer.init()`**.
- Basis transcoder ships at `three/examples/jsm/libs/basis/`, meshopt at
  `three/examples/jsm/libs/meshopt_decoder.module.js`. Copy both to `public/` or use a Vite `?url` import.
- `@gltf-transform/*` is not in `package.json`.

What a GLB import must provide to join the existing sea systems:

1. **Frame.**
   - Must be meters, +Y up, bow toward **+Z**, origin at the **CG = body frame** of `buildDeepVHull`
     (hull frame minus CG).
   - `waterLightingNode` maps `shipLocalPos.z` onto the wetline texture via `wetlineSpan = (sternZ, 1/(bowZ−sternZ))`
     and reads `shipLocalPos.x` sign for port/starboard (`src/caustics/waterLighting.ts:301-318`).
   - So the render mesh must share the proxy's stern/bow Z. Export stemZ/transomZ in glTF `extras` and
     assert them against `hullMesh.ts` in a test.
2. **Foam tag.**
   - Flowfoam injects every mesh with `userData.foamTarget = true` (`src/flowfoam/accumulation.ts:432`,
     layer via `FOAM_INJECTION_LAYER`).
   - Pirate/raft tag by name (`hull*`, `*-hull`, `log*`: `main.ts:594`, `raft/raftScene.ts:77`), but the
     speedboat entry cannot import those (§V109).
   - Set a Blender custom property `foamTarget=true` on the hull object and export with "Custom Properties".
     GLTFLoader copies glTF `extras` into `userData`.
   - Tag only the **hull shell LOD in use**, not rails or pilot. Fewer injection draws, and the foam comes
     from the hull.
3. **Materials rebuilt, not used as loaded.**
   - GLTFLoader creates MeshStandard/PhysicalMaterial. WebGPURenderer can draw those, but they carry no
     caustics, bounce light, wetness or absorption.
   - Traverse, then map by material name (§5.4) to factories that build `MeshPhysicalNodeMaterial` from the
     loaded textures:
     `colorNode = texture(map).mul(w.tint)`, `emissiveNode = w.addLight`, `roughnessNode = orm.g.mul(w.roughnessScale)`.
   - That is the same contract as `src/ship/fittingMaterials.ts:44-52`.
   - `setActiveCaustics` must be bound **before** building them (`caustics/index.ts:249-261` warns when it isn't).
   - Dispose the loader's original materials.
4. **Tangents.** Export MikkTSpace tangents from Blender, the same space the bake used. Without them the
   node material falls back to derivative TBN, which seams baked normals.
5. **Shadows.** `castShadow`/`receiveShadow` on LOD0/1. LOD2/3 cast only.
6. **Physics.** Never derive the proxy from the GLB. `hullMesh.ts` stays the source (§V101, D12). A test
   checks the GLB hull bbox against `halfBeamAt`/`deckHeight` within ±2 cm.
7. **Mips.** KTX2 with full mip chains (§V48). Encode with `--genmipmap` or gltf-transform's default mips.

---

## 7. Recommended pipeline (one)

**"Parametric hull + generated parts + Blender bake → KTX2/meshopt GLB → TSL slot materials."**
Driven by scripts in git, run headless:
`/Applications/Blender.app/Contents/MacOS/Blender -b -P tools/speedboat/*.py` (Blender **5.1.2** installed,
no MCP needed).

1. **AD lock (user).**
   - Resolve the length (11 vs 12–14 m) and the cockpit phase.
   - Build a mood board of 6–10 licensed or real photos: offshore racers, weathered gelcoat, salvaged
     fittings. Palette is already in `design-doc.md`.
2. **Hull in code.**
   - `tools/speedboat/build_hull.py` reads a JSON dump of `DeepVHullSpec`, written by a tiny TS script from
     `REFERENCE_DEEP_V`, so there is one source of truth (§V77).
   - Lofts a high-res hull with strakes, chine flats, spray rails and transom. Symmetric by mirror
     modifier. Beveled edges + weighted normals.
   - Deck and cockpit tub from boolean-free extrusions.
   - Output: clean quad hull, ~30–50k tris for LOD0.
3. **Clay renders.** Front, side, back, top and 3/4 from Blender (Workbench, seconds).
4. **Concepts.** Paint-over of the clay renders with Codex `image_generation` or Photoshop Firefly (§4).
   User picks one direction.
5. **Parts via Rodin Gen-2.5 on fal.ai.**
   - Per-part multi-view (`condition_mode=concat`, PBR, Quad or Raw + HighPack for bake sources):
     twin outboards/sterndrive pod, bucket seats, windscreen frame, instrument binnacle, pilot (seated,
     helmet), salvage clutter (jerrycans, lashed tarp, rope coil, patched panel).
   - ~15 parts × 2–3 seeds ≈ 40 gens ≈ **$16 base / $48 with HighPack**.
   - Fallback per part: Meshy 7 (Pro $20/mo) or Hunyuan 3.1 (free promo credits).
6. **Cleanup in Blender, scripted plus user review of screenshots.**
   - Decimate or remesh to the budget. For hard parts, re-model the primitive silhouette and **bake the
     generated high-poly detail onto it** (normal + AO + curvature, Cycles on Metal).
   - Generator albedo is used only as a paint reference, never shipped.
7. **UVs and texturing.**
   - Hull: 4k set with livery mask.
   - Trim sheet: metal, rubber, carbon.
   - Tileable detail: non-slip normal, Poly Haven CC0 rust/scratches.
   - Photoshop for livery stripes, race numbers, 2100 patch decals, damage mask.
8. **LODs.** Scripted decimate (LOD1–3) with UV-seam preservation. Pilot/cockpit dropped at LOD2.
9. **Export.**
   - glTF: materials named per §5.4, tangents on, custom props on (`foamTarget`, `stemZ`, `transomZ`).
   - Then `gltf-transform` (`meshopt`, `uastc` for normal/ORM, `etc1s` or `uastc` for baseColor, `resize`,
     `dedup`, `prune`).
   - Needs `@gltf-transform/cli` (devDep) + KTX-Software `ktx` CLI (Homebrew).
10. **Runtime.**
    - `src/speedboat/boatModel.ts`: loader, material factory map, LOD object, livery/damage uniforms,
      foam tag.
    - Tests:
      - extras stem/transom vs proxy
      - bbox vs `halfBeamAt`
      - ≤ 7 materials
      - sampler ledger ≤ 16
      - tri budget per LOD
11. **§V22 signoff.** In-browser screenshots (chase, near chase, cockpit, 8-boat grid, wetline at speed)
    against the mood board. The user signs off the hero visual.

**What the user must approve:**
- **Keys and paid plans:** fal.ai key (pay-as-you-go, ~$20–60 total). Optional Meshy Pro $20/mo as fallback.
- **Uploads:** part concept images to fal/Hyper3D (retained 7 days, not trained on). Prompts to OpenAI if
  Codex image gen is used.
- **Installs:** `@gltf-transform/cli` devDependency, `brew install ktx-software` (or equivalent), optionally
  blender-mcp (turn its telemetry off).
- **Licence posture:** generated output owned by paid-tier user (fal/Rodin, Meshy paid). No Hunyuan
  open-weights if the user is in the EU/UK/KR. No TurboSquid/Fab models without checking their
  web-distribution clause (GLBs served to a browser are extractable).
- **Time:** ~2–3 agent-weeks plus several user review rounds.

**Fallbacks:**
- (a) Rodin quality insufficient for a part → Meshy 7 or Hunyuan 3.1 multi-view, or model that part by hand
  in Blender Python.
- (b) No paid APIs approved → local TRELLIS.2 via trellis-mac, **geometry only**, baked onto hand-built low
  poly. Textures authored, not generated. Slower, same pipeline.
- (c) Blender route stalls → route C: TS loft render hull + TSL tri-planar materials. Hull quality holds up.
  Pilot and engines stay the weak spot.

---

## 8. AAA-fidelity risk

- **Hull:** low risk on route A. It's parametric and exact, and bevels plus weighted normals and clearcoat
  gelcoat are well understood.
- **Parts:** medium. Generated parts need re-topology and baking. Skip that step and the boat reads as
  "AI kitbash" up close.
- **Pilot:** medium-high. Seated figure plus helmet via Rodin is fine at chase distance. In the cockpit cam
  it needs hand cleanup of hands and harness.
- **Texturing:** the real AAA gate and the biggest effort. There is no Substance Painter here, so bakes are
  Cycles/Blender, paint is Photoshop, and wear is procedural masks. That's achievable but slower.
  Substance 3D Painter would be the industry tool and would need a paid Adobe subscription.
- **Honest bar:** route A can reach "current-gen console racing game at chase cam" quality. A true
  AAA-studio hero asset normally takes a dedicated artist 4–8 weeks. Scripted plus generated pipelines get
  close on hull and materials and fall short on hand-crafted micro-detail unless the user reviews iteratively.
