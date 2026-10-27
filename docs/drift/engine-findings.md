# Engine findings from The Drift's offline renders

The Drift renders the game's own world (FFT ocean, raft, islands, sky rig) offline through a fulldome
capture: six cube faces a frame, every frame a pure function of show time, rendered out of order in parallel
lanes at 2–5 fps. That use stresses parts of the engine the real-time game never exercises. This page records
what broke, how the film works around it, and what it suggests for the engine. Written 2026-10-27.

The film's workarounds all live under `src/drift/`. The game's systems are unchanged, except where a small
optional hook was added; those additions are listed under each finding.

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

**Film workaround.** No clip. The island ground, rocks and low plants are left out of the coast's mirror
capture instead.

**For the engine.** Don't toggle a `ClippingGroup` per render pass. For a planar or probe mirror, clip in the
mirror's own material variant (a `positionWorld.y` discard in an override material) or by an oblique
near plane, which costs nothing per object.

## 3. Sail, flag and other cloth drivers run on wall-clock time

`src/ship/sailDriver.ts` (and `flagDriver.ts`) integrate the flutter phase and smooth the sail's drive with
the renderer's frame time. Offline, at a few frames a second and out of order, sails flapped about ten
times too fast ("hyperlapse"), and frames depended on render order.

**Film workaround** (`src/drift/wandering/raft.ts`):
- the pennant is struck;
- the sail is held still: flutter, luff flap, gusts and turn skew off, response fast;
- a wind frame is published from the raft itself, since the game's `rigTrim` doesn't run.

**For the engine.** Drive the cloth from the simulation clock (fixed tick, the game's own `t`), not
`frame.time`. Then a replay, a slow-motion shot or an offline render shows the same cloth.

## 4. Island seabed: square grid, straight shallows edge

Each island's seabed grid is a square over [−R, R]². Past it the depth jumps, so the shallows tint (`shallowFullDepth`, 18 m) ends on a straight line in the water. From altitude, every island
sits in a bright square (`island/showcase.ts` notes the same for its rim).

**Film workaround.** `shallowFullDepth` set to 6 m, so the tint is gone inside the grid.

**For the engine.** Fade the tint by distance to the grid's edge, or extend the seabed field radially.

## 5. Night has no light in the single-scattering sky

The film's own air (`getTheDrift/atmosphere.ts`) gives zero irradiance once the Sun is well down: 1e-13 at
−20°. A moonless scene then lit nothing: the raft went black and popped at every dissolve into night.

**Film workaround.** A starlight and airglow floor (`seaSky.ts` `NIGHT_LIGHT`), added to the light, not to
the eye's adaptation.

**For the engine.** The game's own sky rig may want the same floor.

## 6. Terrain, rocks and plants read as flat colour in a photoreal frame

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

## 7. Smaller notes

- **CPU ocean.** `CpuOcean` reuses its height grid for ~1/60 s by default. Offline, set `updateEveryTicks: 0`
  or buoyancy reads a stale sea.
- **Ocean refraction.** It uses a per-frame `viewportSharedTexture`. Under several cameras per frame it is
  right for the first only (seams at the dome's face edges). Not yet fixed in the film.
- **Atmosphere sampling.** In the film's air, even steps along level rays from the sea (35 km each) left the
  per-pixel jitter visible as a halftone over the sky. Samples now crowd toward the eye (`scatter`, `CROWD`).
  The game's sky rig is a separate model and was not checked.
- **Low-sun shadows on the beach.** The user reported "glitchy" dark shadows from the island's hills across
  the beach. Not yet reproduced: shadow map resolution and the shadow camera's focus at a very low Sun are
  the likely place to look.
