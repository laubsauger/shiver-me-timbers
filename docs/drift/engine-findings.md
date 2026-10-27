# Engine findings from The Drift's offline renders

The Drift renders the game's own world (FFT ocean, raft, islands, sky rig) offline through a fulldome
capture: six cube faces a frame, every frame a pure function of show time, rendered out of order in parallel
lanes (2–5 fps at first, 8–15 fps after findings 9 and 10). That use stresses parts of the engine the
real-time game never exercises. This page records what broke, how the film works around it, and what it
suggests for the engine. Written 2026-10-27.

The film's workarounds live under `src/drift/`, and the capture fixes in `src/cine/domeCapture.ts` and the
render driver. The game's systems are unchanged, except where a small optional hook was added; those additions
are listed under each finding.

## 1. Planar reflection fails under several cameras per frame

**Symptom.** Water showed no reflection of the raft or the debris through the dome capture. Objects looked
pasted onto the water.

**What was tried** (`src/reflection/planarReflection.ts`, `reflectionShading.ts`):

- **Update rate.** With `bounces: false` the mirror updates once per frame, from whichever camera renders
  first. With `bounces: true` it ran once per cube face. A probe confirmed both.
- **Readback.** The mirror render target did fill: about 2,400 covered texels per face at 192², and the
  dumped image was a correct flipped reflection.
- **What the ocean sampled.** The mirror's coverage alpha came out as **0 at every water fragment**, whatever
  was changed:
  - the UV flip (`screenUV`, `flipX`, `flipY`, both);
  - surface clip off;
  - local mirror off;
  - mipmaps off;
  - one render target shared by all faces, so the texture object never changed.
  - A debug view painted the shading's factors as colour: active × fade = 1, above-surface = 1, coverage = 0.
- **Root cause.** Not isolated. Candidates:
  - the ocean's texture binding keeps an older texture when the reflector's texture node changes between
    renders inside one frame (bind-group caching);
  - the reflector's oblique-clip and screen-UV maths under three's `CubeCamera`, whose face cameras use
    fov −90 (flipped projection).

**Film workaround.** `src/drift/wandering/mirror.ts`. One cube capture from the eye mirrored under the water,
of everything but the ocean and the sky. The ocean looks it up along the reflected ray through its existing
`reflection.shade` hook. This is exact for flat water. It is not clipped at the waterline (see finding 2):
the island ground and the rocks are hidden from the capture instead, so the seabed doesn't block it.

**For the engine.**
- Test the planar mirror with more than one camera per frame: VR, split screen, cube captures, picture-in-picture.
- If the binding theory holds, give the reflector a texture per camera that is bound per render, or document
  the mirror as single-camera.
- A mirrored cube probe is a cheap fallback for wide-angle and multi-view rendering.

## 2. A `ClippingGroup` is very slow under several cameras per frame

**Symptom.** With the cube mirror's waterline clip (`THREE.ClippingGroup`, one plane, enabled only during the
mirror capture), the sea rendered at 0.35 fps at 1024² in the open-sea beats and 0.85 fps on the coast.
Without the clip: 6.2 and 7.4 fps. Same scene, same mirror, only the group's `enabled` flag differs.

**Measured** (1 s at 1024², one lane, 30 fps):

| World | Clip on | Clip off | No mirror |
|---|---|---|---|
| open sea (c3) | 0.35 | 6.19 | 6.56 |
| coast (w3) | 0.85 | 7.36 | 8.22 |
| flood (c1) | 1.81 | 8.75 | 9.19 |

A smaller cube target (256²), no mipmaps or keeping the background changed almost nothing. The cost is the
clipping, not the capture.

**Likely cause.** The renderer re-plans clipping per camera. A frame here renders twelve cameras (six mirror
faces, six dome faces), and toggling the group between them invalidates every node material under it, so
pipelines or bind groups are rebuilt for every object, every face.

**Film workaround.** First no clip, which reflected the floating things' submerged halves as dark undersides.
Now `mirror.ts` `clipToWater` gives each mirror face an oblique near plane at the water (Lengyel's method,
adapted to WebGPU's [0, 1] depth), and skips the face that looks straight down. It costs nothing per object;
`tests/mirrorClip.test.ts` checks that the plain frustum above the water is kept and nothing under it. The
island ground, rocks and low plants stay out of the coast's mirror: mirrored, even clipped, the far islands
reflected as teal blocks (cause not isolated).

**For the engine.** Don't toggle a `ClippingGroup` per render pass. For a planar or probe mirror, clip by an
oblique near plane (as `clipToWater` does), which costs nothing per object, or in the mirror's own material
variant (a `positionWorld.y` discard in an override material).

## 3. Shadow maps update once per camera per node frame

**Symptom.** In a dissolve the film draws two beats into one frame, each with its own Sun. Through the
night-to-morning dissolve (w1) the raft stayed a dark silhouette, then popped lit the frame the dissolve
ended (+1.4 luma over the whole frame). The same at the w6 dissolve.

**Cause.** `ShadowNode.updateBefore` re-renders a light's map only when the camera's last update was in an
older `nodeFrame.frameId`. The id advances once per animation frame. The second beat reused the first beat's
map, cast from the first beat's Sun.

**Film workaround.** `sea.update` advances `renderer._nodes.nodeFrame.frameId` for each beat it draws.

**For the engine.**
- Anything that renders one scene twice in a frame with different lights (split screen, replays, a
  picture-in-picture) needs the shadow map invalidated between the two. A public way to do that, or a key on
  the light's state as well as the frame, would be safer than the private counter.
- The same check means a frame with N cameras renders each shadow map N times, though an orthographic sun
  map does not depend on the viewing camera. Here that is 12 renders a frame (six dome faces, six mirror
  faces). Keying directional-light maps on the light alone would save the rest.

## 4. Sail, flag and other cloth drivers run on wall-clock time

`src/ship/sailDriver.ts` (and `flagDriver.ts`) integrate the flutter phase and smooth the sail's drive with
the renderer's frame time. Offline, at a few frames a second and out of order, sails flapped about ten
times too fast ("hyperlapse"), and frames depended on render order.

**Film workaround** (`src/drift/wandering/raft.ts`):
- the pennant is struck;
- the sail is held still: flutter, luff flap, gusts and turn skew off, response fast;
- a wind frame is published from the raft itself, since the game's `rigTrim` doesn't run.

**For the engine.** Drive the cloth from the simulation clock (fixed tick, the game's own `t`), not
`frame.time`. Then a replay, a slow-motion shot or an offline render shows the same cloth.

## 5. Island seabed: square grid, straight shallows edge

Each island's seabed grid is a square over [−R, R]². Past it the depth jumps, so the shallows tint (`shallowFullDepth`, 18 m) ends on a straight line in the water. From altitude, every island
sits in a bright square (`island/showcase.ts` notes the same for its rim).

**Film workaround.** `shallowFullDepth` set to 6 m, so the tint is gone inside the grid.

**For the engine.** Fade the tint by distance to the grid's edge, or extend the seabed field radially.

## 6. Night has no light in the single-scattering sky

The film's own air (`getTheDrift/atmosphere.ts`) gives zero irradiance once the Sun is well down: 1e-13 at
−20°. A moonless scene then lit nothing: the raft went black and popped at every dissolve into night.

**Film workaround.** A starlight and airglow floor (`seaSky.ts` `NIGHT_LIGHT`), added to the light, not to
the eye's adaptation.

**For the engine.** The game's own sky rig may want the same floor.

## 7. Terrain, rocks and plants read as flat colour in a photoreal frame

This is not a bug, but it matters for the realistic look the film needs:

- the painterly terrain bands (`rockBands`, stepped shading);
- deformed-icosahedron rocks;
- card ground cover;
- bright yellow-green foliage. Under a low orange sun and a contrast grade it read as "neon".

**What worked.**
- `TerrainBlendHooks.ground` (`terrain/sandMaterial.ts`) is a good seam. The film swaps in scanned CC0 PBR
  layers there and keeps the swash, the water lighting and the aerial haze
  (`src/drift/wandering/beachMaterial.ts`).
- The only engine change was an optional `terrainHooks` on `createArchipelago` and `createIslandMaterials`;
  the default is unchanged.
- **WebGPU allows 16 sampled textures per fragment stage.** Five PBR layers × three maps exceeds it, so the
  layers are packed two RGBA maps each (`scripts/drift-pbr-pack.py`).

## 8. Smaller notes

- **CPU ocean.** `CpuOcean` reuses its height grid for ~1/60 s by default. Offline, set `updateEveryTicks: 0`
  or buoyancy reads a stale sea.
- **Ocean refraction.** Wrong on five of six cube faces, from a three bug: finding 11.
- **Atmosphere sampling.** In the film's air, even steps along level rays from the sea (35 km each) left the
  per-pixel jitter visible as a halftone over the sky. Samples now crowd toward the eye (`scatter`, `CROWD`).
  The game's sky rig is a separate model and was not checked.
- **Low-sun shadows on the beach.** The user reported "glitchy" dark shadows from the island's hills across
  the beach. Not yet reproduced: shadow map resolution and the shadow camera's focus at a very low Sun are
  the likely place to look.
- **Page memory grew during long sea renders.** Found and fixed: see finding 9.

## 9. Frame transport: a typed-array POST is slow, and is held until a GC

The recorder reads each master back and POSTs the raw RGBA to a local sink (`src/drift/record.ts`,
`scripts/cine-sink.mjs`). Two problems were in that one `fetch`.

**Memory.** At 2160² the page grew ~18 MB a frame, one frame's bytes, and a long render crashed both lanes
("Target crashed") at ~900 frames each.
- Probed with CDP heap usage and per-process RSS. The JS heap and the ArrayBuffer backing stores stayed flat.
  The renderer grew 4.2 → 6.4 GB, then fell to 1.9 GB on a natural major GC, and the same on a forced one.
- No GPU object churn: wrapping `GPUDevice`/`GPUQueue` counted zero buffers, textures or bind groups created
  per frame. Three's readback already destroys its staging buffer.
- Reproduced in a blank page posting 18 MB `Uint8Array` bodies to a local server: +18 MB per POST until a GC.
  Reading the response does not release it. Collecting every 10 posts holds the page flat.
- So Chrome keeps a fetch's request body in native memory until the request's JS objects are collected, and
  V8 does not count that memory, so nothing triggers the collection.

**Speed.** The same POST was most of the frame time:

| 2160², open sea, one lane | ms per frame |
|---|---|
| as rendered last night | 475 |
| `fetch` stubbed out | 86 |
| cube faces at 600² instead of 1200² | 478 |

Blank-page benchmark, 18 MB to a local server: `fetch(Uint8Array)` 440 ms (40 MB/s), XHR 437 ms, four parallel
fetches 434 ms, WebSocket 60 ms, **`fetch(Blob)` 17 ms (~1 GB/s)**. An in-process network service changed
nothing.

**Fix** (`src/drift/record.ts`, `scripts/drift-render.mjs`):
- frames are posted as a `Blob`;
- the lanes' Chrome runs with `--js-flags=--expose-gc`, and the recorder collects every 20 frames.

Measured after: 1,800 frames of the coast at 2160² in one take, renderer RSS steady at 0.4–0.7 GB a lane. The
render went from 3.6 to 15.4 fps (open sea, two lanes, x264 veryfast) and 10.9 fps on the coast, so the whole
film at 2160² takes ~25 min instead of ~2.5 h. The 20 s chunking is no longer needed.

**For the engine.** `src/cine/recorder.ts` (the other films' capture) posts the same way and has the same cost.
Any page that ships large binaries to a local process should send Blobs and keep an eye on native memory.

## 10. The dome capture rendered the whole cube

The master reads directions within 90° of the dome's zenith, about half the cube. All six faces were drawn in
full. With the 15° tilt the bottom face is never read, nor the lower part of each side face.

**Fix** (`src/cine/domeCapture.ts` `drawFaces`, `faceScissor`). The dome's edge is a great circle, a straight
line on each face, so each face is drawn with a scissor around the part the master reads (plus 4 px for the
master's bilinear lookups), and a face with none is skipped. `tests/domeFaceScissor.test.ts` checks that every
master pixel lands inside its face's rectangle, for any heading and tilt.

Measured (two lanes, 2160², with finding 9's fix):

| | full faces | scissored |
|---|---|---|
| coast, landfall (600–610 s) | 3.7 fps | 8.3 fps |
| open sea (400 s), one lane | 107 ms | 102 ms |

On the coast, the near beach and plants below the dome's edge filled most of the side faces' lower halves.

**For the engine.** Any cube capture that feeds a partial projection (a dome, a cylinder, a reflection probe of
the upper hemisphere) can scissor its faces the same way.

## 11. Three r186: three faults with cube render targets

All three hit any `CubeCamera` or cube target: environment probes, the dome, the mirror.

**The framebuffer copy reads face 0.** `WebGPUBackend.copyFramebufferToTexture`, which `viewportTexture` and
`viewportSharedTexture` run mid-pass (the ocean's refraction), copies from layer 0 whatever face is being drawn.
The layered path for array cameras passes its layer; this one does not. So on five of six faces the water
refracted another face's picture: on the coast the shallows' seabed differed across the face edges (open water,
being dark and even below, showed nothing). Fixed by `src/core/cubeFaceFramebufferCopy.ts`, installed in
`App.create` like `opaqueShadowCasters`: it copies from the render context's `activeCubeFace` when the source has
that layer. Worth reporting upstream: pass `renderContext.activeCubeFace` as `sourceLayer`.

**A cube target's mip chain is sized at creation, and CubeCamera creates it without one.** Three decides a
texture's mip levels when it first creates the GPU texture, from `generateMipmaps` at that moment.
`CubeCamera.update` switches `generateMipmaps` off for the first five faces, and the first face's render
creates the texture: one level, whatever the target asked for. Measured in the page: the dome's cube reported
`generateMipmaps: true` and a GPU `mipLevelCount` of 1. So the dome master never filtered its faces, and the
mirror's blur with distance and wave tilt (`level(...)` in `mirror.ts`) read nothing. Fixed by creating each
target with `renderer.initRenderTarget` before its first face. For the engine: `CubeCamera` should do this, or
three should size the chain from the target's options rather than the flag's state at first use.

**MSAA on a cube target fails validation.** `CubeRenderTarget({ samples: 4 })` renders, but its clear pass pairs
a 4-sample depth attachment with a 1-sample colour one ("depth stencil attachment sample count (4) does not
match"), and the frame is dropped. Not used. A 2D MSAA target per face, copied into the cube, would work around it.

## 12. The far sea is pixel noise at grazing angles

At the horizon the water shows 1–2 px dark specks that change every frame. They are in the faces, not the
master, and are the ocean's own shading aliasing: its FFT cascade textures (`src/ocean/oceanTextures.ts`) have
no mipmaps and minify with a linear filter, so where a pixel covers several wavelengths one tap picks a random
facet. A facet turned toward the eye has low Fresnel and shows the dark body colour.

What the dome can do, measured on the coast at 2160² (mean frame-to-frame flicker in the outer rings of the
master, lower is calmer; fps with two lanes):

| | rings 6–8 | spring line | fps |
|---|---|---|---|
| before | 1.18 1.37 1.02 | 2.13 | 15.8 |
| faces mipmapped (finding 11) | 0.97 1.14 0.92 | 1.98 | 15.8 |
| plus `--ss 2` (faces at 2× resolution) | 0.65 0.79 0.82 | 1.69 | 7.8 |

`--ss` (`scripts/drift-render.mjs`, `DriftRecordOptions.supersample`) renders the faces at a multiple of the
resolution the master needs; the master averages them through the mips. It reduces the noise, at four times the
face shading. It is off by default.

**Fixed at the source (the ocean, for the game's cameras as well).** Where the noise comes from, measured on open
sea (t = 400, 2160², mean flicker; ring 8 is the water 15–45 m out, ring 9 the spring line):

| | ring 8 | ring 9 |
|---|---|---|
| before | 0.61 | 5.63 |
| sparkle, glint road, micro detail, shadows, refraction or the cube mirror off (each) | 0.60–0.64 | 5.63–5.85 |
| cascade normals faded out past 20 m (the floor: no wave detail at all) | 0.17 | 1.90 |
| **derivative layers mipmapped, sampled over the pixel's footprint** | **0.35** | **3.86** |

So it was the cascade normals alone: the shader band-limits each cascade by fading its amplitude, but inside a band
that is still kept, a base-level tap point-samples every wavelength shorter than the pixel. The derivative array now
has a mip chain (three r186 rebuilds a storage texture's chain after each compute write) and 16× anisotropy, and
the surface samples it with `textureSampleGrad` on its own world-space derivatives (`sampleCascadeLayer`'s `grad`).
Every other reader of the layers (caustics, the debug view) is pinned to level 0, as before. The shader's notes
said this could not work: storage textures cannot carry mips, and `generateTextureGrad` drops the array index. Both
held for three r180, neither for r186. Cost: none measured (63 vs 62 ms a frame at sea, 72 vs 72 on the coast).
Coast spring line: 2.11 → 1.58.

What is left is geometry: the crests' own edges at 1 px, and the debris reflections broken up by the waves (which
real water does too). Only more samples per pixel reach those: `--ss 2`.

Not done: the variance the mips average away is not added to the specular roughness (the four channels are full;
the shader's `unresolvedVar` only counts what the amplitude fade removes). In the fade zone the far sea is therefore
a little smoother than the spectrum says. Not visible in the test frames.

## 13. Where a frame's time goes now (2160², after findings 9–11)

One lane, no encoder (an in-page harness timing `__drift.record` against a sink that discards):

| | open sea (400 s) | coast (640 s) |
|---|---|---|
| frame | 101 ms | 68 ms |
| shadows off | 99 ms | 66 ms |
| sun shadow map 1024² instead of 4096² | 106 ms | 70 ms |
| cube faces 600² instead of 1200² | ~the same | |

- **Shadows are cheap.** The twelve shadow renders a frame of finding 3 cost 2–5 ms in all; not worth an engine
  change for speed (finding 3's correctness point stands).
- **The CPU ocean was most of the open sea's frame.** `CpuOcean` recomputes its grids whenever it is asked about
  a new time. The raft averages the sea over five instants (`raft.ts` SAMPLES), and the five far rafts ask for
  the same five, so the grids were computed 30 times a frame: 60% of the main thread, ~64 ms. The film now keeps
  a pool of oceans sharing one spectrum, one per instant (`sea.ts` `seaAt`): 5 recomputes, ~17 ms, identical
  raft poses. Open sea: 106 → 78 ms a frame on one lane; 15.4 → 17.0 fps with two lanes and x264.
- With two lanes the rest is shared: two pages' main threads (three's per-object render work), the GPU, and two
  x264 encoders on the same CPU.

**For the engine.** A `CpuOcean` that keeps its last few grids by time (or computes several instants in one
pass) would do the same for the game, where every ship's buoyancy asks the same sea.

## 14. The first frame a page draws is wrong

Seen as a flash in a C3 test clip, exactly at the frame where the second lane's half begins: for one frame the
dolphin lay pale on the water beside the raft, where it is in fact a metre down and behind the raft's port logs.

Measured at t = 425 (C3), 1080², pixels differing by more than 3/255:

| | pixels |
|---|---|
| a fresh page's first frame vs a run from 2 s earlier | 7 483 |
| the same page drawing the same t a second time vs that run | 248 |
| two runs from different starts | 317 |
| two fresh pages' first frames | 32 |

So it is not history: it is the first frame only, and it is the same in every fresh page. Besides the dolphin
the raft, its sails and the water's patches of reflection differ: what changes looks like lighting, and the
likely part is the shadow maps, built on first use and not yet drawn into for that frame (not isolated).

Every render the film has had started each lane on such a frame. `recordDomeMaster` now draws one frame at
`from` and drops it before the take; after it the first frame matches a run's (259 px).
