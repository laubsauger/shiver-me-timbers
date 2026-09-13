# Speedboat asset pipeline (§T176)

Status, 2026-09-13: the pipeline runs end to end on a **pipeline-test hull**. That hull is not the hero
model. It exists to prove every stage, and modelling of the real boat can start once the references
are signed off. The plan behind it is [asset-pipeline-research.md](asset-pipeline-research.md);
deviations from that plan are listed at the end.

```
src/speedboat/hullMesh.ts + deepV12.hull.json  (physics proxy, owned by the physics agent)
        │  scripts/blender/hullOffsets.ts   (vite-node: the proxy's own shape functions, 241 stations)
        ▼
headless Blender 5.1  scripts/blender/build_pipeline_test.py  (+ sb_conventions.py)
        │  loft hull LOD0/1/2, parts, UVs, Cycles bake stubs, 7 slots, extras → raw.glb
        ▼
checker (raw)  scripts/blender/checkGlb.mjs   ── fails the build on any convention break
        ▼
normalise alphaMode/clearcoat → dedup (not materials) → prune
        ▼
gltf-transform CLI: resize → UASTC (normal, ORM) → ETC1S (baseColor)      [KTX-Software `ktx`]
        ▼
meshopt (JS API; positions stay float) → assets/models/<name>.glb
        ▼
checker (final: + meshopt, KTX2, full mip chains, proxy match) + slot-set-unchanged guard
        ▼
runtime  src/speedboat/assets/  → lookdev  speedboat-lookdev.html
```

## Commands

| What | Command |
|---|---|
| Full build (default 1024² bakes, AO 16 spp, 4 CPU threads) | `node scripts/asset-build.mjs` |
| Quick build | `node scripts/asset-build.mjs --bake-size 256 --ao-samples 4 --max-texture 256` |
| Keep intermediates (hull.json, raw.glb, baked PNGs, step GLBs) | `node scripts/asset-build.mjs --work /tmp/sb-build` |
| Check any GLB | `node scripts/blender/checkGlb.mjs file.glb [--stage raw\|final] [--expect hull.json]` |
| Hull offsets only | `npx vite-node scripts/blender/hullOffsets.ts -- hull.json 240` |
| Blender step only | `/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python-exit-code 1 -P scripts/blender/build_pipeline_test.py -- --hull hull.json --out raw.glb --work <dir>` |
| CPU preview render of a raw GLB | `/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P scripts/blender/render_preview.py -- --glb <work>/raw.glb --out p.png [--view three_quarter\|side\|front\|top\|below] [--lod N] [--clay]` |
| Tests | `npx vitest run tests/assetPipeline*` |
| Lookdev | `npm run dev`, then open `/speedboat-lookdev.html` (query params below) |

Flags: `--kind player|npc`, `--threads N`, `--blender <path>` (or `BLENDER_BIN`), `--ktx-bin <dir>` (or
`KTX_BIN_DIR`; the default is `~/.local/opt/ktx-software-4.4.2/bin`, then PATH). Blender runs with
`--factory-startup`, so user add-ons (blender-mcp included) and user preferences never touch a build.

**Determinism.** Two builds with the same flags produce byte-identical final GLBs. Default flags
gave sha256 `7d1409154c7aefa7…` twice, from different work dirs. The quick flags gave `fb6509c68c898021…`
twice. UASTC runs without RDO, so its non-deterministic multithreaded RDO is never used. The raw
Blender GLB can differ between work dirs, but the packaged file does not.

**Output today** (`assets/models/speedboat_pipeline_test.glb`): 1.14 MB. Tris per LOD 33 292 / 5 964 / 724.
Draws per LOD 7 / 7 / 5. 7 materials. 3 textures, all 1024² KTX2 with mips.
Whole build ≈ 5 s on the M3 Max.

## Conventions (the contract)

One file, `src/speedboat/assets/assetContract.json`, is read by the Blender scripts (Python), the
checker (node) and the runtime (TS, via `?raw`). Change it there only.

- **Frame.**
  - Metres, +Y up, bow toward **+Z**.
  - Origin at the **CG**, i.e. the body frame of `buildDeepVHull` (hull frame minus
    `lcgFromTransom`/`vcgAboveKeel`).
  - In Blender, author at `(x, −z, y)` of the three.js coordinates (`sb_conventions.three_to_blender`):
    bow toward Blender −Y (Blender's "front"), up +Z. The glTF exporter's +Y-up conversion does the rest.
  - **All node transforms are identity.** The runtime shades with `positionLocal` as the ship-local
    frame in metres (waterLighting's `shipLocalPos`, the wetline span). This is also why the meshopt
    step does not quantize POSITION: quantization moves the dequantisation into node transforms.
- **Hierarchy and names.**
  ```
  SB_<asset>                 extras: assetKind, contractVersion, bowZ, sternZ, beam, keelY, deckY, pipelineTest
    LOD0 … LOD2              extras: lodLevel
      Hull_LOD<n>            extras: lodLevel, foamTarget: true   ← exactly one per LOD
      <Part>_LOD<n>          extras: lodLevel
  ```
  Extras are Blender custom properties, exported with `export_extras`. GLTFLoader copies them into
  `userData`.
  - `bowZ`/`sternZ` use `HullWetline`'s names and are measured from the exported hull, not typed
    in.
  - `beam` is the render beam. That includes the render-only topside flare, so today it is 2.93 m
    against the proxy's 2.618 m chine beam.
- **Material slots.**
  - ≤ 7 per boat, named from the contract: `M_Gelcoat M_Antifoul M_NonSlip M_Carbon M_Metal
    M_Perspex M_Rubber M_Cockpit M_Pilot`.
  - Each slot has a fixed alphaMode. Only `M_Perspex` is BLEND.
  - The exporter's doubleSided comes from Blender backface culling, and only see-through slots are
    double-sided.
- **Textures.**
  - ≤ 4 per material (§V40).
  - The test hull uses 3, shared by its three hull slots: `baseColor` (RGB; **A = livery mask**),
    `ORM` (R occlusion, G roughness, B metal), and a tangent-space `normal`. MikkTSpace tangents are
    exported.
  - Packaging: normal and ORM go to UASTC + zstd, baseColor to ETC1S, and all get full mip chains.
- **LODs.**
  - Parametric parts (the hull) are **re-lofted** at lower station and section resolution from the
    same offsets. That keeps them exact, manifold, and on the same parametric UVs, so every LOD reuses
    the LOD0 bake.
  - Generic parts are collapse-decimated with X symmetry, then welded (`sb_conventions.decimated_copy`).
  - Small parts drop out at LOD2.
  - Switching is by screen-height fraction (0.35 / 0.12). The runtime converts that to distance for
    the camera FOV.
- **UV and bake stubs.**
  - Hull UVs are parametric: u = station, v = girth, and the transom and stem caps get their own
    islands.
  - Parts use `smart_uv`.
  - Cycles CPU bakes run on hull LOD0 with the other LOD0 parts present as occluders:
    - AO
    - curvature, as Cycles *pointiness* in emission bakes, which drive edge wear in colour and roughness
    - normal detail from procedural bumps (gelcoat orange peel, diamond tread, antifoul grain)
    - livery mask
  - numpy packs the results into baseColor and ORM.
  - These are **stubs**. They prove the bake → pack → export → KTX2 path, not the art.

## Checker rules (`scripts/blender/checkGlb.mjs`; the build exits 1 on any)

1. **Hierarchy.**
   - Exactly one root.
   - Root children are `LOD<n>` groups, contiguous from 0, with a matching `lodLevel`, and at most
     `lod.levels` of them.
2. **Root extras.** All of `assetKind contractVersion bowZ sternZ beam keelY deckY` are present,
   numeric where they should be, and `assetKind ∈ player|npc`. The version equals the contract, and
   `sternZ < 0 < bowZ` (origin between transom and stem).
3. **Identity transforms** on every node.
4. **Mesh nodes.** Each is named `*_LOD<n>` and carries `lodLevel = n`. Every primitive has a
   material.
5. **Foam tag.** Exactly one `foamTarget: true` mesh per LOD, named `Hull_LOD<n>`.
6. **Tri budgets.** LOD0 ≤ 120 000 for a player boat and ≤ 50 000 for an NPC. LOD1 ≤ 20 000,
   LOD2 ≤ 6 000. Every LOD must be strictly lighter than the one before.
7. **Manifold hull, per LOD.**
   - Positions are welded on a 10 µm grid, across primitives, because glTF splits vertices at seams.
   - Every edge must be used exactly twice, in opposite directions.
   - No degenerate triangles, and the signed volume must be above 0 (not inside-out).
8. **Frame and axis**, from hull geometry rather than from extras.
   - The hull is longest along Z and symmetric about x = 0.
   - It is narrower near +Z than near −Z, so the bow is at +Z.
   - Its lowest points are near the centreline, so the keel is down.
   - LOD0 extras `bowZ sternZ beam keelY deckY` match the geometry within ±2 cm.
   - With `--expect`: stem, transom, keel and deck match the **physics proxy** within ±2 cm, and the
     render beam is at least the proxy chine beam.
9. **Materials.** At most 7. Every name is a contract slot, with no duplicates. At the final stage,
   alphaMode equals the contract.
10. **Textures.** At most 4 distinct textures per material, extension slots included.
11. **Tangents** are present wherever a normal map is used, and **TEXCOORD_0** wherever a material
    has textures.
12. **Final stage only.** `EXT_meshopt_compression` is present. Every texture is `image/ktx2`, and
    the KTX2 header level count is at least the full mip chain (§V48).
13. **Build-script guard.** The material slot set must be identical before and after packaging.
    gltf-transform `dedup` merged two identical-factor slots on the first run, which is why materials
    are excluded from dedup.

## Runtime (`src/speedboat/assets/`)

```ts
const loader = await createBoatAssetLoader(app.renderer);     // after renderer.init()
const asset = await loader.load(PIPELINE_TEST_BOAT_URL);      // GLTFLoader + KTX2Loader + MeshoptDecoder
const wetline = sea.caustics.attachHullWetline(wetlineOptions(asset.extras)); // BEFORE instantiate
const boat = asset.instantiate({ variant: 'hero', water: true, livery: 0xd9442b });
scene.add(boat.object);                                       // THREE.LOD, origin = CG
```

- **KTX2 transcoder.**
  - The files are imported with `?url` (`three/addons/libs/basis/basis_transcoder.{js,wasm}`), so
    Vite emits hashed assets in dev and build alike.
  - KTX2Loader's fixed filenames are redirected to those URLs through its `LoadingManager`
    URL modifier. There is no `public/` copy. Verified: `vite build` emits both files and the GLB,
    and the bundle references their hashed names.
  - `detectSupportAsync(renderer)` runs after init.
- **Slot materials** (`slotMaterials.ts`).
  - Each slot is rebuilt as a `MeshPhysicalNodeMaterial` from the loaded textures and factors, with
    `waterLighting()` folded in the same way `ship/fittingMaterials.ts` does it: tint × albedo,
    addLight → emissive, roughness × wet, normal relief × wet.
  - ORM is sampled once.
  - Gelcoat and carbon get clearcoat.
  - Perspex uses `transmission` on the hero and alpha on NPCs.
  - Livery is `mix(albedo, hue, mask)`. The hue is an **object-group uniform** read from
    `userData.liveryTint` (the `sailTint` mechanism), so all boats share one material per slot and
    variant.
- **Foam.**
  - `tagFoamTargets` carries the hull node's `foamTarget` down to its meshes and enables layer 27.
    GLTFLoader turns a multi-material hull node into a Group, and flowfoam's injection walk only
    tests meshes.
- **Shadows.** LOD0 and LOD1 cast and receive. LOD2 only casts.
- **§V109.** The runtime imports nothing from `main.ts`, `main-raft.ts`, `raft/`, `combat/` or `ai/`
  at any depth. `tests/assetPipelineIsolation.test.ts` enforces this.

### Lookdev (`speedboat-lookdev.html`, `src/speedboat/lookdev.ts`)

Query parameters:
- `scene=studio|sea`. Studio is sky plus a grey ground with no ocean. Sea is the shared `buildSea`
  open sea, with the wetline attached and foam injection running.
- `variant=hero|npc`
- `view=lit|slot|uv|normal|lod` (`v` key cycles)
- `livery=<hex>` (`l` key cycles)
- `spin=0|1` (space toggles)
- `count=1..8`
- `dist=<m>`, `y=<m>`, `tod=<h>`, `glb=<url>`

The HUD is the shared `createHarnessHud` perf HUD. Its notes show tris and draws per LOD, material
and texture counts, GPU texture MB (summed from the transcoded mip chains), the hero's current LOD,
and the frame's draw calls and triangles. `window.__lookdev` exposes `{app, asset, boats, sea,
setView, stats, extras}`.

**Browser check: PENDING.** The GPU was pinned by other work, so it was deferred on coordinator
instruction. Steps for the sync pass:
1. Start `npm run dev -- --port 5223` in the background and open a new tab.
2. Open `http://localhost:5223/speedboat-lookdev.html?spin=0`. Screenshot `studio-lit`. The hull should
   be opaque white gelcoat, with a dark antifoul bottom, grey tread deck, black rub rail, rails, a
   perspex screen and a carbon cowl. The bow should be toward +Z.
3. Open `?spin=0&view=slot`, `?view=uv`, `?view=lod&dist=80` and `&dist=250`. The LOD colour should
   change with distance.
4. Open `?spin=0&livery=d9442b`. A red stripe band should run below the sheer.
5. Open `?scene=sea&spin=0`. The boat should float at `y=0.3`. There should be a wetline band and
   caustics on the topsides, and no `[caustics] waterLighting() called before setActiveCaustics()`
   warning.
6. Open `?count=8&dist=45&spin=0`. Record `__lookdev.app.renderer.info.render.drawCalls`. The mesh
   draws should be about 7 × 8 plus shadow draws, never 7 materials per boat.
7. Read the console for any `[gpu]` error, KTX2/transcoder 404, or `speedboat asset:` throw. Record
   `__lookdev.stats` (texture MB) and the HUD frame ms (§V17: render ≤ 8 ms).
8. Kill the server and close the tab.

## Installs, and how to undo each one

| Install | What changed | Undo |
|---|---|---|
| npm devDependencies | `package.json` gained exactly five lines: `"@gltf-transform/cli": "^4.5.0"`, `"@gltf-transform/core": "^4.5.0"`, `"@gltf-transform/extensions": "^4.5.0"`, `"@gltf-transform/functions": "^4.5.0"` and `"meshoptimizer": "^1.2.0"`. meshoptimizer is the encoder and decoder that gltf-transform's meshopt and the checker need. `package-lock.json` added 199 packages and removed none. The only version move is root `meshoptimizer` 0.22.0 → 1.2.0; `@types/three` keeps its own nested 0.22.0. | `npm uninstall @gltf-transform/cli @gltf-transform/core @gltf-transform/extensions @gltf-transform/functions meshoptimizer` |
| KTX-Software 4.4.2 (`ktx`, `toktx`, …) | **Homebrew has no formula or cask** for KTX-Software (checked the formulae.brew.sh API: only `basis_universal`, which gltf-transform does not use). Installed instead from the official Khronos release `KTX-Software-4.4.2-Darwin-arm64.pkg` (sha1 `f6bc075b…`). The pkg was unpacked with `pkgutil --expand-full`, **with no sudo and no system install**, into `~/.local/opt/ktx-software-4.4.2/{bin,lib}`. The binaries find `libktx` through `@executable_path/../lib`. PATH is unchanged; `asset-build.mjs` prepends the bin dir for its own child processes. | `rm -rf ~/.local/opt/ktx-software-4.4.2` |
| blender-mcp add-on 1.9.1 | `~/Library/Application Support/Blender/5.1/scripts/addons/blender_mcp.py`, the bundled `addon.py` from the PyPI 1.9.1 wheel (sha256 `ede3aed3…`), under the filename its own `install-addon` uses. It is enabled in user preferences with **Allow Telemetry = off** (`telemetry_consent=False`). Preferences were backed up first to `…/5.1/config/userpref.blend.pre-blender-mcp.bak`. The Poly Haven, Hyper3D/Rodin, Sketchfab, Poly Pizza and Hunyuan toggles are per-scene properties that default to **off**, verified headless; none were enabled. **Note:** when GUI Blender starts, the add-on auto-starts a socket server on `localhost:9876` that executes the Python it is sent. Turn off "Auto-Start Server" in its N-panel if you don't want that. | In Blender, go to Preferences → Add-ons, disable "MCP for Blender" and remove it. Alternatively, `rm ".../5.1/scripts/addons/blender_mcp.py"` and restore `userpref.blend.pre-blender-mcp.bak` over `userpref.blend`. |
| blender-mcp MCP server registration | **Not done.** Registering an MCP server changes Claude Code configuration, which a subagent may not do on a relayed instruction. Run it yourself: `claude mcp add blender --scope local -e DISABLE_TELEMETRY=true -- uvx blender-mcp@1.9.1`. The version is pinned to the one whose telemetry code was read. Optionally add `-e BLENDER_MCP_SAFE_MODE=1` to block risky scripts. Restart Claude Code to get the tools. | `claude mcp remove blender --scope local` |

**How telemetry-off was verified.** This is source reading, not a network capture, because the MCP
server was never run.
- The blender-mcp 1.9.1 wheel is the one `uvx` resolves. In its `telemetry.py`,
  `TelemetryCollector._is_disabled()` turns collection off when any of `DISABLE_TELEMETRY`,
  `BLENDER_MCP_DISABLE_TELEMETRY` or `MCP_DISABLE_TELEMETRY` is `true|1|yes|on`, by setting
  `config.enabled = False`.
- `record_event`, `upload_screenshot` and the trajectory writer (`trajectory.py:578`) each return
  early when `config.enabled` is false.
- The README's "Telemetry Control" section documents the same variable: `DISABLE_TELEMETRY=true`.
- As a second layer, the add-on's own consent preference is off. With it off, the server sends
  nothing private even if the environment variable were lost, though the README says minimal
  anonymous usage data would still be sent.
- Headless check after saving: `addons["blender_mcp"].preferences.telemetry_consent == False`.

## Deviations from asset-pipeline-research.md

- **Paths.** Scripts live in `scripts/blender/`, not `tools/speedboat/`. The runtime is
  `src/speedboat/assets/boatModel.ts`, not `src/speedboat/boatModel.ts`.
- **Hull input.** The doc called for "a JSON dump of `DeepVHullSpec` written by a tiny TS script".
  The physics agent has since made `deepV12.hull.json` the data file.
  - `hullOffsets.ts` evaluates that module's own `hullStations`/`buildDeepVHull` at 241 stations,
    and adds the proxy stem, transom, keel and deck for the checker.
  - The Blender script also accepts the raw 29-station JSON, with a warning and linear resampling.
- **Extras names** are `bowZ`/`sternZ` (HullWetline's names), not `stemZ`/`transomZ`. `keelY`,
  `deckY`, `assetKind` and `contractVersion` were added.
- **Masks.** The livery mask is baseColor alpha, not a separate R8/RG mask texture, because glTF has
  no generic mask slot. The damage mask and damage uniform are not built yet. Options for the hero: a
  sidecar KTX2 referenced from material extras, or ORM alpha.
- **LOD3** (~1k tris, hull plus screen card) is not generated. The contract has 3 levels, and LOD2
  holds below 12 % screen height.
- **Hull LODs are re-lofted, not decimated.** That keeps them exact, manifold and on shared UVs.
  Decimate and weld are used for generic parts.
- **Bevels.** The test hull has no bevel or weighted-normal modifier. It uses sharp-by-angle (35°)
  smoothing. Bevels would break the shared parametric UVs and are a hero-modelling decision.
- **Meshopt** runs through the JS API, not the CLI, and without POSITION quantization (see Frame).
  Normals and tangents are quantized to 10 bits, UVs stay float.
- **bbox test.** "GLB hull bbox vs `halfBeamAt`/`deckHeight` ±2 cm" is implemented as stem, transom,
  keel and deck vs the proxy ±2 cm, plus render beam ≥ proxy chine beam. `renderOnly.topsideFlareDeg`
  (8°) makes the render beam legitimately wider.
- **Chine.** The render chine flat (`renderOnly.chineFlat`, 8 cm) puts the outer chine edge about
  3.5 cm below the proxy chine point.
- **Not built yet.**
  - The §V40 sampler ledger for the speedboat receiver material (doc step 10). It needs the
    receiver's binding count measured the way `tests/oceanBindingBudget.test.ts` does.
  - The clay-render → paint-over concept step.

## Open issues for the speedboat page (outside this pipeline's directories)

- **Wetline.** `Caustics.attachHullWetline` holds **one** wetline per page, and receiver materials bake
  its texture and span. With 8 boats sharing slot materials, NPC hulls would read the hero's drying
  memory through their own ship-local z. Multi-boat wetness needs a per-boat span and texture, or a
  wetline-free NPC variant. The runtime already keys materials by variant, so an NPC variant with
  `water` but without a wetline is a small change in `caustics/`.
- **LOD and foam capture.** THREE.LOD picks its level per rendering camera, so flowfoam's overhead
  capture camera probably injects the LOD2 hull. The silhouette is right and cheaper, but this has not
  been checked in the browser.
