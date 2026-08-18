# Binding audit — every sampler in the project, where it is spent, and what can be reclaimed

Static analysis only. No browser, no GPU timestamps (`info.render.timestamp` reads a constant
29.688 ms, so nothing here is measured in milliseconds — where cost matters it is stated as a
count of fetches or bytes, never as a guess at frame time). Read against three r180 in
`node_modules`, `SPEC.md §V.40`, `tests/oceanBindingBudget.test.ts`, `tests/shipBindingBudget.test.ts`.

Every item below names the file and line that creates the binding, so an implementing agent can
take any single row without re-deriving the picture.

---

## 0. The counting rules, restated once (verified in node_modules, r180)

1. **Bindings key on `(node, shaderStage)`.** `WGSLNodeBuilder.getUniformFromNode` keys
   `uniformGPU` on the pair, so the vertex and fragment stages get *separate* bindings for the
   same texture and are budgeted separately. Fragment is the scarce stage; the ocean vertex stage
   sits at 4/16.
2. **Within one stage, bindings dedupe by texture UUID**, not by node — `TextureNode.getUniformHash()`
   returns `this.value.uuid`. N `texture()` calls on one `THREE.Texture` object cost one binding.
3. **Every filterable texture carries its own sampler.** Samplers are never shared between
   textures, so *the sampler count is the filterable-texture count*.
   `WGSLNodeBuilder.isUnfilterable` (`:591`) returns true when the component type is not float,
   or (no `float32Filterable`) it is a `DataTexture` of `FloatType`, **or `minFilter === magFilter === NearestFilter` with no `compareFunction`**, or it is multisampled. Unfilterable → read with
   `textureLoad` → **zero samplers**.
4. **`textureLoad` needs no sampler in any stage**, and in r180 it is the only path that carries an
   array layer index correctly outside the fragment stage (`generateTextureLoad` passes
   `depthSnippet`; `generateTextureSampleLevel` / `generateTextureGrad` drop it).
5. **A depth texture with a `compareFunction` takes a comparison sampler** — still one sampler, not
   two. `src/sky/uncoloredShadowNode.ts` is what keeps the shadow at one *texture* by never
   building three's coloured-shadow colour read.
6. **Metal caps samplers per function at 16.** `adapter.limits.maxSamplersPerShaderStage` *is* 16 on
   this hardware, so `requiredLimits` buys nothing on that axis. Sampled textures are the roomy
   axis and are raised successfully (the ocean is at 17). **Budget samplers.**

### Two traps found while verifying, both live

- **`viewportTexture()` with no explicit texture costs a sampler.**
  `ViewportTextureNode.js:43` sets `defaultFramebuffer.minFilter = LinearMipmapLinearFilter` on the
  auto-created `FramebufferTexture`, which makes it *filterable*. The ocean is safe only because it
  passes its own texture (`src/ocean/surfaceMaterial.ts:178`, a bare `new THREE.FramebufferTexture`
  whose defaults are Nearest/Nearest, `FramebufferTexture.js:57/67`). Anyone writing a bare
  `viewportTexture()` on the ocean path spends the contested spare without touching a filter setting.
- **`viewportDepthTexture()` is free** — `DepthTexture.js:28` defaults both filters to Nearest and
  the shared buffer has no `compareFunction`, so rule 3 makes it unfilterable. Setting
  `compareFunction` or a Linear filter on it would cost a sampler on every reader at once.

---

## 1. The ledger

### 1a. Ocean surface — FRAGMENT stage: **17 sampled textures / 15 samplers of 16**

| # | Texture | Bound at | Samp | Notes |
|---|---|---|---|---|
| 1–3 | cascade `displacement` ×3 (`StorageTexture` 512², rgba32f, Linear/Repeat, `src/ocean/oceanTextures.ts:41`) | `src/ocean/surfaceMaterial.ts:520` (`sampleDisp`) | 3 | also bound in VERTEX — see §1b |
| 4 | `derivatives` **array** (3 layers, one object, `src/ocean/oceanTextures.ts:71`, allocated `src/ocean/oceanCascades.ts:241`) | `src/ocean/surfaceMaterial.ts:578` → `src/ocean/oceanTextures.ts:108` | 1 | 3 cascades, 1 binding. The reclamation §V.40 already banked |
| 5 | sun shadow map `DepthTexture` | three's lighting; fallback `src/ocean/surfaceMaterial.ts:936` never fires | 1 | comparison sampler. One texture not two, because of `src/sky/uncoloredShadowNode.ts` |
| 6 | shared viewport `DepthTexture` | `src/ocean/surfaceMaterial.ts:1094` and `:1100` (2 sites, 1 texture) | **0** | Nearest/Nearest → `textureLoad` |
| 7 | `sceneColorTexture` (`FramebufferTexture`) | created `src/ocean/surfaceMaterial.ts:178`, read `:1116` | **0** | Nearest/Nearest → `textureLoad` |
| 8–10 | foam `lane.front` ×3 (`createOutputTexture(512)`, `src/foam/index.ts:236`) | `src/foam/index.ts:487` | 3 | one per cascade |
| 11–12 | foam `lane.coarse` ×2 (`createOutputTexture(128)`, `src/foam/index.ts:266`) | `src/foam/index.ts:508` | 2 | lanes 0 and 1 only |
| 13 | foam art texture (`DataTexture` 256² rgba8, mips, aniso 8, `src/foam/foamTexture.ts:44`) | `src/foam/foamShading.ts:299` **and** `:300` | 1 | two world scales, one UUID → one sampler |
| 14 | flowfoam `acc.foamTexture` | `src/flowfoam/index.ts:278`, `:319`, `:344` | 1 | 3 call sites, 1 texture |
| 15 | flowfoam `far.foamTexture` | `src/flowfoam/index.ts:278` (far branch) | 1 | different resolution from `acc` |
| 16 | seabed field (`DataTexture`, **RedFormat**/HalfFloat, mips, `src/island/seabed.ts:146`) | `src/island/seabed.ts:203` | 1 | §V.24 tint |
| 17 | planar reflection RT (three's `ReflectorNode.js:411`, half-res, mips on) | `src/reflection/reflectionShading.ts:120` (+`.level()` `:160`, same UUID) | 1 | |

**17 / 15.** One spare, and it is a *fragment* spare.

### 1b. Ocean surface — VERTEX stage: **4 sampled textures / 4 samplers of 16. Twelve free.**

| Texture | Bound at | Samp |
|---|---|---|
| cascade `displacement` ×3 | `src/ocean/surfaceMaterial.ts:520`, reached from `positionNode` `:569` | 3 |
| seabed field (`.level()` variant) | `src/island/seabed.ts:233` ← `src/ocean/surfaceMaterial.ts:502` | 1 |

### 1c. Ship — the deck wood material is the widest: **8 sampled textures / 8 samplers of 16**

`tests/shipBindingBudget.test.ts` says 9. **It is one too high — see §2.1.** Corrected:

| Texture | Bound at | Samp | Family |
|---|---|---|---|
| deck heightfield (`DataTexture` rgba16f, mips, `src/ship/deckFieldTexture.ts:44`) | `src/ship/woodMaterial.ts:604` | 1 | deck only |
| deck-water `stateA` (`StorageTexture` 192×512) | `src/deckwater/deckMaterialNode.ts:164` | 1 | deck only |
| deck-water `coarse2` (12×32) | `src/deckwater/deckMaterialNode.ts:176` | 1 | deck only |
| ocean `derivatives` array | `src/caustics/causticsNode.ts:147` | 1 | all wood + iron |
| ocean `displacement` ×3 | `src/caustics/causticsNode.ts:160` (`waterHeightNode`) | 3 | all wood + iron |
| sun shadow map | three's lighting | 1 | every receiver |

Per family: **deck 8**, hull 5, spar/trim/cannon/rail/wheel/capstan 5, iron fittings 5,
glass 1, **sails 1**, flag 1, hole 1.
Ropes, ratlines, rigging blocks, lantern bulbs, cannonballs, impact rings, splinter/smoke/splash
sprites: **0** — they set `castShadow` but never `receiveShadow`, which is what gates the shadow
binding (`AnalyticLightNode.js:208`).

Sails bind **nothing but the shadow map**: `src/ship/sailMaterial.ts` has no `texture()` call at
all, cloth is `fbm2`/`hash2` and the `positionNode` (`src/ship/sailClothNodes.ts`) is pure ALU.

### 1d. Terrain and islands — **5 / 5**, and it has no ledger today

| Material | Site | Bindings |
|---|---|---|
| `createSandMaterial` | `src/terrain/sandMaterial.ts:294` | 3 ocean displacement + 1 derivatives array + 1 shadow |
| `terrainBlendMaterial` (the island) | `src/terrain/sandMaterial.ts:407` | identical |
| `createRockMaterial` | `src/terrain/rockMaterial.ts:163` | shadow only |

All four water bindings arrive through `applyWaterLighting` (`src/terrain/sandMaterial.ts:105`/`:430`)
and `seaDepthNode` (`:88`), gated at build time on `terrainParams.receiveCaustics` (default true).
Rock, ground cover, shore runup, and the whole albedo/roughness stack are analytic — no noise
textures anywhere in `src/terrain`.

**Terrain does not read the seabed texture.** `src/island/seabed.ts` has exactly two GPU consumers,
both in the ocean material (`surfaceMaterial.ts:502` vertex, `:1068` fragment).

### 1e. Everything else

| System | Material | Bindings | Samplers |
|---|---|---|---|
| Vegetation (palms) | `src/vegetation/palmMaterial.ts:25` | none; `positionNode` (`src/vegetation/windSway.ts:74`) reads attributes + uniforms only | 0 + shadow |
| Sky | `src/sky/skyBackground.ts:222` | none — sun, moon, starfield, haze all analytic | 0 |
| Clouds — composite | `src/clouds/cloudComposite.ts:268` | `texV` blurred RT `:273`; 3D noise `:133` + `:144` (**one** `Data3DTexture` 48³, `:90`) | 2 |
| Clouds — bands / cores / fluff | `cloudBands.ts:279`, `cloudCores.ts:566`, `:694` | none | 0 |
| Clouds — mirror stand-in | `src/reflection/cloudMirror.ts:113` | `texV` `:137`; **its own second copy** of the 48³ noise `:105` | 2 |
| Rain | `src/rain/index.ts:147` | none — hash-driven sprites | 0 |
| Spray (draw) | `src/foam/sprayPool.ts:118` | none | 0 |
| Spray (spawn) | `src/foam/spray.ts:225` compute | `textureLoad` displacement `:156` + `loadCascadeLayer` derivatives `:160` | **0** |
| Underwater grade + god rays + water volume | `src/underwater/underwaterGrade.ts:95`, `godRays.ts:61`, `waterVolume.ts:169` | one shared scene-pass colour node + the pass depth | 1 colour + 1 depth |
| Waterline band | `src/underwater/waterlineBand.ts:86` | none | 0 |
| Post god rays — bright pass | `src/core/postGodRays.ts:196–199` | 4 `.sample()` calls, **one** texture | 1 |
| Post god rays — rays pass | `src/core/postGodRays.ts:247` | 1 texture, 32 taps in a `Loop` | 1 |
| Final composite | `src/core/postPipeline.ts:291` | pass colour, pass depth, bloom out, `raysTex` | 4 |
| Deck-water solver passes | `inflowPass.ts`, `outflowPass.ts`, `reducePass.ts`, `index.ts:240` | all `textureLoad` on Nearest textures | **0** |
| Ocean FFT passes | `spectrumPass.ts`, `fftPasses.ts`, `unpackPass.ts` | all `textureLoad`/`textureStore` on Nearest textures | **0** |
| Foam sim passes | `src/foam/foamPasses.ts` | all `textureLoad`/`textureStore` | **0** |
| Cloud blur | `src/clouds/cloudBlur.ts:55/68/71` | `textureLoad`/`textureStore` | **0** |

The compute side is already fully on the sampler-free path. There is nothing to reclaim there.

### 1f. Textures bound in more than one material

| Texture | Readers |
|---|---|
| ocean `displacement` ×3 | ocean vertex, ocean fragment, `causticsNode.waterHeightNode` → **every wood + iron ship material and both terrain materials**, foam/spray compute (`textureLoad`, free) |
| ocean `derivatives` array | ocean fragment, `causticsNode.surfaceSlopeNode` → every ship + terrain material, spray compute (free) |
| seabed field | ocean vertex + ocean fragment (two stages = two bindings, one per stage) |
| foam art texture | ocean fragment only (singleton by design, `src/foam/foamTexture.ts`) |
| cloud `texV` blurred RT | cloud composite + cloud mirror |
| cloud 48³ noise | **two separate objects with identical content** — see §2.4 |
| sun shadow map | every `receiveShadow` material in the scene |

---

## 2. Waste, ranked

### 2.1 A ledger row for a binding that does not exist — the ship test overcounts by one

`tests/shipBindingBudget.test.ts:80-87` charges the deck material one texture and one sampler for
the hull wetline (`src/caustics/waterLighting.ts:319`). **That binding is never created.**

`wetDepthNode` (`src/caustics/waterLighting.ts:306-321`) decides at *material-construction time*
whether to emit the `texture()` call:

```
if (!ctx.wetline || !r.shipLocalPos || !ctx.wetlineSpan) return depth.add(rise);
```

`Caustics.wetline` is only ever set by `attachHullWetline`, called at **`src/main.ts:590`** — after
both `new ShipAssembly(...)` calls (`src/main.ts:424`, `:467`), which is where every wood and iron
material is built (`src/ship/shipAssembly.ts:88`). So the ship ships with the fallback wet band and
the drying-memory texture (`src/caustics/hullWetline.ts:93`) is allocated, updated, and never read
by a shader.

Three consequences, in order of importance:
1. the deck material's real worst case is **8/16**, not 9;
2. the §V.14 drying-memory feature documented at `src/caustics/waterLighting.ts:1-12` is **silently
   inert on the hull** — a §B-class silent no-op, and it is a behaviour bug, not a budget one;
3. `hullWetline.texture` is `FloatType` + `LinearFilter`, which needs the `float32-filterable`
   feature (rule 3) — the exact hazard `src/ship/deckFieldTexture.ts:14-19` warns about. If the
   ordering is ever fixed so the binding *does* appear, that is the second thing to check.

**Do not "fix" this by deleting the ledger row.** Fixing the ordering is the right repair; the row
then becomes correct. Recorded here so the next person does not shrink the budget to match a bug.

### 2.2 Five foam textures where two would do — the largest clean reclamation

`src/foam/index.ts:236` allocates `front` per lane at `createOutputTexture(resolution)` — the **same
resolution, format, filters and wrapping for all three lanes**. `:266` allocates `coarse` at
`createOutputTexture(coarseN)` for lanes 0 and 1 — again identical to each other. They are read at
`src/foam/index.ts:487` and `:508`, in the ocean **fragment** stage only.

That is exactly the shape `derivatives` already exploits. Three `front` textures → one
`StorageArrayTexture(512, 3)`; two `coarse` textures → one `StorageArrayTexture(128, 2)`.

**5 samplers and 5 textures become 2 and 2. Ocean fragment 15 → 12.**

Nothing outside `src/foam` reads them: `foamTextures` (`src/foam/index.ts:297`) is exported and has
**zero consumers** in `src/` or `tests/`. The compute side already goes through `textureLoad`/
`textureStore`, which is the array-safe path, and `storeCascadeLayer`/`loadCascadeLayer`
(`src/ocean/oceanTextures.ts:121`/`:140`) already encode all three r180 array traps.

### 2.3 Three fragment samplers spent re-deriving a value the rasterizer already interpolated

`totalDisp` (`src/ocean/surfaceMaterial.ts:565`) is built from the three displacement samples and is
used by **both** `positionNode` (`:569`) and `colorNode` (`:961`, `:1038`, `:1068`, `:1174`, `:1186`,
`:1307`). Because bindings key on `(node, shaderStage)`, the three textures are bound **twice** —
and the fragment copy is the expensive one.

What the fragment does with it, in full:
`surfacePos` (view direction), `heightMask` (body value ramp), `seabedShallowFactorNode` (§V.24
tint), `crestMask` (SSS band), `choppyMask` (SSS), and `chop` handed to the reflection. All six are
smooth, low-frequency masks.

**The height half is already free.** `positionLocal` is a varying
(`node_modules/three/src/nodes/accessors/Position.js:19`) and `NodeMaterial.js:772` *reassigns* it to
the displaced position in the vertex stage, so the fragment's `positionLocal.y` **is** the
interpolated `totalDisp.y` — no fetch, no sampler. (This is also why `worldXZ` at
`surfaceMaterial.ts:395` is the *displaced* world XZ in the fragment stage, which is what makes
`fwidth(worldXZ)` a genuine pixel footprint at `:424`.) The chop half needs one scalar varying
(`totalDisp.xz.length()`), computed in the vertex stage where those textures are already bound.

**−3 fragment textures, −3 fragment samplers, cost: one interpolant.**

This is *not* a no-op, and the reason is worth stating precisely: the fragment currently samples the
displacement field at the **displaced** coordinate, while the vertex sampled it at the **grid**
coordinate. Those are different lookups — 1–2 m apart horizontally in choppy water — so the value
the fragment reads today is not the displacement of the fragment it is shading. The varying is the
*rasterized* value and therefore agrees with the drawn geometry. Expect a small change in the SSS
and shallows-tint bands, most visible on steep crests. See §3 for how to land it.

### 2.4 The same 48³ noise allocated and bound twice

`src/clouds/cloudComposite.ts:263` and `src/reflection/cloudMirror.ts:105` each call
`createNoiseTexture(seed)`, producing two `Data3DTexture` objects with **identical content** and
different UUIDs. Rule 2 dedupes on UUID, so the mirror pays its own binding and sampler for a copy
of the composite's data. Neither material is near the wall (2 samplers each), so this is a tidy, not
a rescue — but it is free and it is precisely the "two systems each made their own" pattern.

### 2.5 Four samplers on ~25 ship material variants for a term that is numerically zero

Every spar, yard, rail, cannon, wheel, capstan and iron fitting binds the 3 ocean displacement
textures plus the derivatives array (`src/ship/woodMaterial.ts:640` → `applyWaterLighting`) so that a
masthead 40 m in the air can evaluate caustics and water absorption. The term is genuinely *read* —
`heightFade`/`submerged` gate it toward zero rather than compiling it out — so this is not a dead
binding. It is 4 samplers and 4 fetches spent to multiply by ~0.

The ship is at 5–8 of 16, so **this is not a budget problem**. Its real cost is §T.40: ~25 pipeline
variants each carrying four texture fetches they do not use, in a boot that spends 52 s in shader
compilation. `waterLighting.ts:255-261` already exposes a `WaterReceiver` hook that takes
`waterHeight`/`depthBelowSurface` directly; passing them for the dry families removes 3 samplers
each. Deferred, not recommended now: a rail *can* go under in a storm, so "always dry" is a
behaviour change, and the payoff is compile time rather than a slot anyone is fighting over.

### 2.6 Channel-level waste — free capacity, not reclaimable slots

| Texture | Channels written | Channels read | Free |
|---|---|---|---|
| foam art (`src/foam/foamPattern.ts`) | R crest lace, G soft mottle, B dissolve, A relief | R `foamShading.ts:320`, G `:320`, B `:381` | **A is never consumed** (§T.42) |
| foam `lane.front` / `lane.coarse` | R residue, G breaking | R+G (`src/foam/index.ts:509-513`) | **B, A free** |
| deck heightfield (`src/ship/deckFieldTexture.ts`) | RGBA | `.g`, `.b` only (`woodMaterial.ts:604-611`) | R, A free |
| deck-water `state` | R height, G wetness, B volume, A drain | `.b` multiplied by `waterHeightScale`, which defaults to 0 (`deckMaterialNode.ts:202`) | B effectively dead |
| seabed | R (RedFormat) | `.r` | already minimal |
| ocean displacement | λDx, h, λDz, det J | all four | none |
| ocean derivatives | ∂h/∂x, ∂h/∂z, ∂Dx/∂x, ∂Dz/∂z | all four | none |
| flowfoam `acc`/`far` | R foam, G slick, BA wake slope | all four | none |

**Read this table the right way round.** Packing does not free a slot that is already spent — but
`foam art .A` and `lane.front .B/.A` are *four channels of ocean-fragment capacity that cost zero
new bindings*. §T.46 (starfield), §T.42 (foam relief) and §T.41 (spray threshold) are all currently
blocked on "the one spare sampler is contested"; any of them that needs a world-locked greyscale
mask should ride an existing channel instead of asking for the spare. There are no loose greyscale
textures left to merge — the packing discipline in this codebase is already good.

### 2.7 Dead and near-dead allocations

| Item | Site | Verdict |
|---|---|---|
| `stateNode = texture(stateA)` | `src/deckwater/index.ts:269`, published `:310` | **Orphan node** — no consumer anywhere in `src/` or `tests/`. Costs nothing (a node not reached from a material graph creates no binding) but it is a standing invitation to double-bind `stateA`. Delete it. |
| `foamTextures` export | `src/foam/index.ts:297` | No consumer. Delete, or §2.2 will have to keep it working for nobody. |
| `injectionRT` for the far tier | `src/flowfoam/accumulation.ts:136` | `profile.useCapture === false` for `far` (`src/flowfoam/index.ts:106`), so it is a 1×1 target never rendered into and never read. One object, not memory. |
| `probeTarget` | `src/deckwater/index.ts:433` | Never a shader binding; lazily allocated inside `probe()` only. Fine. |
| coloured-shadow RT on the **preview page** | `src/ship/preview.ts:52-55` | Creates its own `DirectionalLight` with `castShadow = true` and **never calls `installUncoloredShadow`**. Every material on that dev page gets three's stock `ShadowNode`, i.e. **+1 texture and +1 sampler each**. A deck material there is 9–10, not 8. This is also why a §V.40 overrun would surface on the preview page first — or never, if nobody opens it. |

`installUncoloredShadow` has exactly one call site, `src/sky/lighting.ts:100`, on the scene's single
shadow-casting light. It publishes onto `light.shadow.shadowNode`, which three reads globally
(`AnalyticLightNode.js:167`), so no game material can miss it. **Shadow lookups are not doubling up:
one light, one depth texture, one comparison sampler.** The `shadow(sunLight)` fallback at
`src/ocean/surfaceMaterial.ts:936` never fires.

### 2.8 Found in passing, not a binding item

`src/core/postPipeline.ts:136` computes `readsDepth = pp.aoEnabled || pp.dofEnabled`, both default
false, so the scene pass keeps `samples = 4`. But `src/underwater/waterVolume.ts:169` calls
`scenePass.getViewZNode()` **unconditionally** and the underwater stage is always wired
(`src/main.ts:713-720`). WebGPU cannot resolve a multisampled depth attachment — this is the exact
hazard the header at `postPipeline.ts:130-135` documents. `readsDepth` should include the underwater
stage. Handed to whoever owns post.

---

## 3. Recoveries, ranked by (slots freed) / (risk)

### R1 — Fold the foam textures into two array textures. **+3 fragment samplers. Provable no-op.**

- **Changes:** `src/foam/index.ts` allocates `StorageArrayTexture(resolution, 3)` for `front` (and
  `back`) and `StorageArrayTexture(coarseN, 2)` for `coarse`; lanes hold `CascadeLayer` slices.
  `src/foam/foamPasses.ts` swaps `textureLoad`→`loadCascadeLayer` and `textureStore`→
  `storeCascadeLayer`. `src/foam/index.ts:487`/`:508` swap `texture()`→`sampleCascadeLayer()`.
- **Cost:** zero ALU, zero bandwidth, zero memory (same texels, same format). One extra `i32` in the
  emitted fetch.
- **Does it move a pixel?** No. Same data, same `LinearFilter`, same `RepeatWrapping`,
  `sampleCascadeLayer` emits the same `textureSample` with an added array index.
- **Risk:** the three r180 array traps, all three of which are already written down in
  `tests/oceanBindingBudget.test.ts` and already survived by `derivatives`. The reads are
  fragment-only (`shadingNode` is called at `src/ocean/surfaceMaterial.ts:1376`, inside `colorNode`),
  so trap 1 (no filterable array sampling outside fragment) does not apply.
- **Watch for:** each lane's compute passes now write different *layers of one texture*. They are
  separate dispatches, so the pass boundary is the barrier; no pass reads and writes the same array.
- **Result: ocean fragment 17/15 → 14/12. Three spare samplers.**

### R2 — Fold `displacement` into the `derivatives` array as layers 3–5. **+3 samplers in every fragment shader that reads the sea.**

- **Changes:** `createOutputArrayTexture(n, 6)` in `src/ocean/oceanCascades.ts:241`; cascade *i* owns
  derivative layer *i* and displacement layer *3+i*. `src/ocean/unpackPass.ts` writes both through
  `storeCascadeLayer`. Every **fragment** reader — `src/ocean/surfaceMaterial.ts:520`,
  `src/caustics/causticsNode.ts:160` — becomes `sampleCascadeLayer` on a texture *already bound in
  that stage*, i.e. **zero additional bindings**.
- **Effect:** ocean fragment −3; **terrain 5 → 2**; **ship deck 8 → 5, hull/spar/trim/iron 5 → 2**.
  That is 3 samplers off ~27 pipeline variants.
- **The price, and it is real:** the ocean **vertex** stage samples `displacement` *filtered*
  (`surfaceMaterial.ts:520` → `positionNode`), and r180 cannot filter-sample an array texture outside
  the fragment stage at all — `generateTextureSampleLevel` drops the layer index and emits invalid
  WGSL, which fails as a pipeline-creation error naming the descriptor. The vertex stage must move to
  a hand-rolled 4-tap `textureLoad` bilinear (`loadCascadeLayer`), 12 loads instead of 3 samples.
- **Does it move a pixel?** Fragment: no. Vertex: mathematically identical up to the hardware's
  fixed-point filter-weight quantisation — the software version is if anything more accurate.
  `RepeatWrapping` must be re-implemented by hand (`fract` on the texel coordinate) or the tile seam
  reappears across the whole sea.
- **Cost that cannot be measured here:** 9 extra texel fetches per ocean vertex. GPU timestamps are
  unusable, so this is stated as a fetch count, not a millisecond figure. §V.17 sits at ~8.1 ms
  against 8 ms, so **do not land R2 without a working instrument** — a separate agent is fixing the
  timer, and this is the first thing that should be run through it.
- **R2-lite, if the vertex cost turns out to bite:** keep the three standalone 2D displacement
  textures for the vertex stage *and* have `unpackPass` additionally write layers 3–5 of the array
  for fragment readers. Provably zero pixel change and no vertex work at all, paid for with
  **+12 MB VRAM and +12 MB/frame of stores** (512² rgba32f × 3). Ugly, honest, and reversible.

### R3 — Replace the ocean fragment's displacement reads with the rasterized position. **+3 fragment samplers, one interpolant.**

- **Changes:** in `src/ocean/surfaceMaterial.ts`, build a fragment-side `dispY = positionLocal.y` and
  a `vChop = totalDisp.xz.length().toVarying(...)` in the vertex stage; point `:961`, `:1038`,
  `:1068`, `:1186` at `dispY` and `:1174`, `:1307` at `vChop`. The three `texture()` calls at `:520`
  then exist only on the `positionNode` path and bind in the vertex stage alone.
- **Cost:** one scalar interpolant. No fetches, no ALU worth naming.
- **Does it move a pixel?** Yes, mildly — see §2.3. It replaces a resample-at-the-displaced-coordinate
  with the interpolated value the rasterizer actually used, so the shading agrees with the geometry
  where today it does not. Expect the SSS crest band and the §V.24 shallows tint to shift slightly on
  steep faces. **Propose, do not land silently.** It wants a browser A/B at swell and storm.
- **Redundant with R2's ocean half.** Take R2 *or* R3 for the ocean, not both — but R2 also pays out
  on terrain and the ship, and R3 does not.

### R4 — Make the 48³ cloud noise a singleton. **+1 sampler in the cloud mirror. Zero risk.**

- **Changes:** memoize `createNoiseTexture` in `src/clouds/cloudComposite.ts:42` on its seed (the
  same pattern `src/foam/foamTexture.ts:36` already uses) and let `src/reflection/cloudMirror.ts:105`
  take the cached object.
- **Cost:** none. Saves ~440 KB and one binding.
- **Does it move a pixel?** No. Keying the cache on the seed is correct whether or not the two call
  sites pass the same seed (`src/reflection/cloudMirror.ts:105` takes `src.seed`,
  `src/clouds/cloudComposite.ts:263` takes its `seed` argument) — equal seeds share, unequal seeds
  get their own entry, and the generator is pure (`createRng(seed ^ 0x9e3779b9)`).
- **The one thing that stops this being a two-line change:** ownership of `dispose()`. Sharing the
  object means whichever module disposes first pulls the texture out from under the other.
  `src/foam/foamTexture.ts:81` solves the same problem with an explicit module-level
  `disposeFoamArtTexture()`; copy that shape rather than leaving two owners.
- **Value:** low. Neither material is near the wall. Take it when someone is already in that file.

### R5 — Give the dry ship families an explicit `waterHeight`. **+3 samplers on ~20 variants. Deferred.**

See §2.5. Real payoff is §T.40 compile time, not a contested slot, and "a rail is never underwater"
is a behaviour claim this audit cannot make. Listed so it is not rediscovered as a budget item.

### Combined outcome

| Stage | Today | R1 | R1+R2 | R1+R3 |
|---|---|---|---|---|
| ocean fragment samplers | 15 | 12 | **9** | **9** |
| ocean vertex samplers | 4 | 4 | **1** | 4 |
| terrain samplers | 5 | 5 | **2** | 5 |
| ship deck samplers | 8 | 8 | **5** | 8 |

**R1 alone takes the ocean from one contested spare to four, changes no pixel, and touches one
module.** It is the item to do first, and it is the one that should unblock §T.46 / §T.41 / §T.42.

---

## 4. Guardrails

### 4.1 The failure mode the current tests cannot see

Both budget tests count **binding-creating call sites in source text**, then pin a **hand-derived
ledger** beside them. `tests/oceanBindingBudget.test.ts:10-24` is explicit that this is a compromise:
`material.colorNode` is `Fn(() => …)()`, whose body only runs inside `NodeBuilder.build()`, which
needs a live `GPUDevice`, and there is none in vitest.

That compromise caught a real escape today — a `texture()` call moved into a helper and the site
count dropped. It also has a matching blind spot, which §2.1 is an instance of: **a call site that
exists in the text but is short-circuited at build time is counted anyway.** The ship ledger has been
one sampler wrong for as long as `attachHullWetline` has run after `new ShipAssembly`.

So the discipline needs both halves, and they must be honest about which question each answers.

### 4.2 Keep the source tripwire, and extend it to the materials with no ledger

The tripwire is cheap, runs in CI, and its job is "you changed something that affects bindings — go
recount." Extend `LEDGER` coverage to the files that have none today:

| File | Why it needs a row |
|---|---|
| `src/terrain/sandMaterial.ts` | 5 samplers, two materials, zero coverage |
| `src/caustics/causticsNode.ts` | already in the ship test; also the terrain's whole cost |
| `src/ship/sailMaterial.ts`, `src/ship/flagMaterial.ts` | at 0 — a `map` added here should trip loudly |
| `src/vegetation/palmMaterial.ts` | same, at 0 |
| `src/clouds/cloudComposite.ts`, `src/reflection/cloudMirror.ts` | 2 each, and R4 lives here |
| `src/underwater/godRays.ts`, `underwaterGrade.ts`, `waterVolume.ts`, `src/core/postGodRays.ts`, `src/core/postPipeline.ts` | the composite's 4 |
| `src/deckwater/index.ts` | orphan node at `:269`; also where a Nearest→Linear flip would cost a sampler |
| `src/ship/preview.ts` | the missing `installUncoloredShadow` (§2.7) |

Two rules the extended tripwire should also encode, because both are one-character mistakes that
cost a sampler each and neither is a `texture()` call:

- **filter flips.** Assert that `oceanTextures.ts:22/34`, `deckwater/index.ts:187/210`,
  `surfaceMaterial.ts:178`'s framebuffer, and the shared viewport depth stay unfilterable. A test
  that greps for `NearestFilter` next to each creation site is crude but it is the actual invariant.
- **bare `viewportTexture()`.** Forbid it on the ocean path; the auto-created framebuffer is
  `LinearMipmapLinearFilter` (`ViewportTextureNode.js:43`) and costs a sampler.

### 4.3 The only counter that sees the built graph: a boot-time self-check

Add a dev-only assertion that runs **after the first frame**, when the pipelines exist, and reads the
counts out of three's own bind groups rather than out of the source:

```
renderObject.getBindings()            // RenderObject.js:399
  → bindings with .isSampledTexture   // SampledTexture.js:45
  → bindings with .isSampler          // Sampler.js:51
  → binding.visibility                // GPUShaderStage bitmask → per-stage split
```

Walk the scene once, group by material name, compare against a ledger of expected
`{ vertex, fragment }` sampler counts, and **throw** with the material's name and the offending
count. That is the only place the question "what does the built graph bind" can actually be asked,
and it answers it for *every* material at once — including the ~25 ship variants and both terrain
materials that no test covers today. It also catches the §2.1 class directly: a binding that the
source implies but the build short-circuits shows up as a ledger row that is too high.

Gate it on the debug flag, run it once, and let it fail loud. §V.40's failure mode is that the
pipeline never builds and the console names the descriptor; this check fires *before* that, naming
the material.

---

## 5. What could not be determined statically (§Rule 8)

1. **No cost figure anywhere in this document is measured.** `info.render.timestamp` reads a constant
   29.688 ms, so R2's vertex-stage bilinear, R3's interpolant, and R2-lite's extra 12 MB/frame of
   stores are stated as fetch counts and byte counts. Whether any of them moves the ~8.1 ms against
   §V.17's 8 ms ceiling is **unknown and must not be guessed**. R2 in particular should wait for the
   instrument.
2. **Whether the vertex stage's node cache deduplicates the `totalDisp` fetches under R3.** The three
   `texture()` nodes are the same objects, and the *bindings* certainly dedupe by UUID, but whether
   the *sample expressions* are emitted once or twice when `totalDisp` is consumed by both
   `positionNode` and a new varying depends on `builder.getDataFromNode` cache behaviour at generate
   time. It cannot cost a binding. It could cost three redundant vertex fetches. Confirm by dumping
   the emitted WGSL.
3. **The exact ordering of the varying write under R3.** I traced `positionLocal` as
   `positionGeometry.toVarying('positionLocal')` (`Position.js:19`), reassigned in the vertex stage by
   `NodeMaterial.js:772`, with `VaryingNode.generate` emitting the attribute copy first and the
   `assign` after — which puts the *displaced* position in the varying and makes the fragment's
   `worldXZ` the displaced world XZ. Everything in `surfaceMaterial.ts` reads as though the author
   believes this (`fwidth(worldXZ)` as a pixel footprint at `:424`; `surfacePos` at `:961`). But this
   is a build-order argument, not an observation. **Dump the vertex WGSL and confirm before landing
   R3** — if the varying turned out to carry the *undisplaced* position, R3 becomes an exact no-op
   instead of a small pixel change, which is a better answer, not a worse one, but it changes the
   review it needs.
4. **Whether writing two layers of one `StorageArrayTexture` from a single compute dispatch is
   accepted end to end** (R2's `unpackPass`). WGSL allows it and three's storage path handles the
   layer index (`storeCascadeLayer` exists precisely for this), but `derivatives` today writes *one*
   layer per dispatch. Unverified in this configuration.
5. **`float32-filterable`.** Several `StorageTexture`s are `FloatType` + `LinearFilter`, and
   `isUnfilterable` (`WGSLNodeBuilder.js:591`) has a `DataTexture`-specific escape clause for
   float32. Whether the adapter grants `float32-filterable` here was not checked — it is an
   `app.ts` device-creation question and it decides whether some of these are samplers at all.
   The wetline (`hullWetline.ts:93`, `DataTexture` + `FloatType` + `LinearFilter`) is the one that
   would break first, and §2.1 means nobody has found out yet.
6. **Contended files were read, not edited**, per the brief: `src/ship/woodMaterial.ts`,
   `src/ui/settingsScreen.ts`, `src/main.ts`. Nothing in this audit was implemented — every item in
   §3 is a proposal.
