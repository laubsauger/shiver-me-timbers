# B122: hard-edged rectangles on the water, and the straight line on the spire

Three separate straight edges were in the one report. They have three different owners. Everything below was
bisected on frozen frames (`loop.setFixedDt(0)`, `followCam.setDebugPose`, captured through `src/cine/capture.ts`
into a local sink, never through `toDataURL` — docs/agent-browser-harness.md §2).

Original user evidence: `scratchpad/browser-sync/t174-shadow{0,1}-overhead-900m.jpg` (the rectangles) and
`t174-shadow{0,1}-windward-elevated.jpg` (the spire).

## 1. The rectangles: the island shelf apron is the only seabed anyone draws

### What they are

Two hard-edged squares of differently-coloured water, one per island, axis-aligned in world space, each much larger
than its island. Reproduced in pirate `index.html?at=lagoon`, camera 900 m over island 0 (centre 900, 150, R 260),
1080p, frozen: `scratchpad/b122/shots/j00-overhead900.png`.

Measured, not guessed. The island's two candidate squares were projected into the frame through the live camera:

| square | half-extent | far edge in frame | matches the visible edge |
| --- | --- | --- | --- |
| the heightmap footprint, ±R | 260 m | y = 377, x 756…1164 | no — nothing there |
| the shelf apron, ±(R + `seabedShelfWidth`) | 520 m | y = 222, x 591…1329 | **yes** |

and hiding one object — `archipelago.islands[0].terrain.mesh` (`island-terrain`) — removes the square while leaving
the island's rocks, the shallow tint and the lagoon halo exactly as they were: `j01-noTerrainPlate.png` against
`j00-overhead900.png`.

### Why it has a hard edge

`islandMesh.buildIslandGeometry` continues each island's terrain outward as a square SHELF APRON riding
`seabed.shelfRamp`, from the footprint rim to ±(R + `seabedShelfWidth`), and closes it with a skirt. That plate is
the ONLY seabed anything in the game draws. Past it there is no floor at all, so in `surfaceMaterial`'s §V24
transmission channel `refractionDepthNode.visible` (`depth < 1`) flips false and `seeThrough` drops to zero in one
pixel.

What it drops FROM is not small. The apron's outer ring sits exactly on `seabedOpenDepth` = 45 m (the ramp reaches
1 there by construction), and Beer–Lambert on the shipped extinction still passes

    exp(−0.36·45) ≈ 0      exp(−0.08·45) ≈ 0.03      exp(−0.03·45) ≈ 0.26

so the sea steps from a quarter of a lit sand floor to none of it, along four straight lines, once per island.

This is also why every CPU probe came back clean and the bug survived a year: the depth FIELD is continuous across
that boundary — `seabed.sampleSeabedHeight` reports −45 m on both sides of it, and the apron's last ring sits
exactly on that value. Only the DRAWING stops. `islandMesh`'s own header records the previous incarnation of the
same defect ("the FLOOR under it simply stopped — on a straight line, four of them, in a square"); this is that
defect one step further out.

### Why not simply widen the shelf

The step is set by the DEPTH the plate ends at, not by how far out it runs. At a constant 45 m the water transmits
the same 26 % of the floor however wide the apron is, so widening moves the rectangle and does not close it.

### Fix

`surfaceRefraction.seabedFloorFade` / `seabedFloorFadeNode`, multiplied into `seeThrough`
(`src/ocean/surfaceMaterial.ts`). The water's body colour IS the sea over the open-ocean floor, so a floor at
`seabedOpenDepth` must already be inside it; transmission is taken to zero by that depth, over the band between the
two depths the sea already owns — `oceanSurfaceParams.shallowFullDepth` (where the shallow tint has completely given
way to the body colour) and the seabed field's own `openHeight`. No new tunable.

At the apron's rim both sides are then zero **by construction rather than by agreement**, and the term compiles out
to 1 in a scene with no seabed. The shallows keep the floor they always had: the fade is exactly 1 at and above
`shallowFullDepth`, and the outer apron (already 40–45 m down over its last two rings) is where it closes. The
argument is fed the water column along the VIEW RAY, the same quantity Beer–Lambert is fed, so a grazing view loses
the floor sooner — which is what a grazing view does anyway.

CPU twin + tests: `tests/waterImprovements.test.ts`, "seabed floor fade (§B122 …)".

## 2. A second, different straight edge: the cloud composite cuts the world at 500 m

Found while bisecting the above, and **not** the same defect — it is a screen-wide band, not a square.

`clouds/cloudComposite.ts` pins a camera-facing quad at `cloudParams.quadDistance` = 500 m. It is `transparent`,
`depthWrite: false` and **`depthTest` ON**, under a standing comment that "only the DIRECTION through each fragment
matters, so the distance is free". True of the shading, false of the depth: every drawn thing BEYOND 500 m failed
the depth test against it and was painted over with cloud, everything nearer was not.

Measured on one frozen frame, pirate `index.html?at=spawn`, camera `[0,180,-500]` → `[900,0,150]`:

| leg | result |
| --- | --- |
| `app.render()` (no post) vs `post.render()` | the edge is in BOTH — it is in the scene, not in post |
| `godRayIntensity`, `bloomStrength`, `aoStrength`, vibrance, vignette, grain, SMAA | stays |
| `oceanSurface.hazeStrength / shallowTintStrength / refractionStrength / refractionSnell`, `caustics.enabled` | stays |
| unproject the edge at fov 30 / 55 / 80 | view depth **500.8 / 501.7 / 501.1 m** — one PLANE, three screen rows |
| `clouds.compositeQuad.visible = false` | **gone** |

Crops: `scratchpad/b122/shots/h00-base.png` vs `i00-noCloudQuad.png`; after the fix `n00-pin500.png` vs
`n01-pinFar.png` on one frozen frame (the quad re-pinned immediately before each capture).

Fix: `cloudComposite.cloudPinDistance(camera) = camera.far * 0.9` — behind every piece of world geometry, inside the
far plane, so ordinary depth testing gives the answer the sky background already gives. Applied to the composite and
to the reflection's stand-in (`src/reflection/cloudMirror.ts`), which had the same cut inside the mirror pass and put
a SECOND straight edge on the water. The band sheet keeps `quadDistance`: it draws alone into the cores RT with
nothing to be tested against, so there the distance really is free.

## 3. The line on the spire: the horizon self-shadow. Separate again, and NOT fixed here

Reproduced in `raft.html` on the Half Dome (`generateSierraSites` site 5, centre 93, −2542, R 480, peak 509 m),
camera 950 m off at 220 m, day clock pinned to 15.5 so the two legs share one sun. A dead-straight razor line runs
from the apex down the flank; left of it lit granite, right of it near-black, with no penumbra anywhere on a
smoothly curved cone.

| `sierraParams.horizonShadowStrength` | result |
| --- | --- |
| 0.9 (shipped) | `shots/spire-horizonShadow-0.9.jpg` — the straight line, and a hard black lower-right skirt |
| 0 | `shots/spire-horizonShadow-0.jpg` — **gone**; the terminator is a soft curved N·L rolloff and the skirt keeps its texture |

So the owner is `island/horizonMap.horizonNodes` → `sierraMaterial.applyHorizon`
(`material.receivedShadowNode = shadow × mix(1, sunVisibility, shadowStrength)`). NOT the sun shadow map (the user
already reported shadows-off changing nothing at the island), NOT the cloud quad of §2 (the spire is inside 500 m
and the line follows the cone's own ruling), and NOT the apron of §1.

Why it is a hard line in the wrong place. `sunVisibility = smoothstep(horizon − softness, horizon + softness,
elevation)` with `horizonShadowSoftness` 0.06 rad ≈ 3.4°, while `horizon` is interpolated between the two nearest
of only EIGHT baked azimuths, 45° apart, by a triangular hat. A cone's true self-shadow terminator is a straight
ruling through the summit — so a correct map would put the cut exactly where N·L already reaches zero, and the extra
multiply would be invisible. The 8-ray blend puts it somewhere else, cutting into the lit side, and a 3.4°
terminator over data that resolves direction to ±22.5° makes that error a razor edge. `horizonShadowStrength` 0.9
then takes the wrong side to 10 % of its key light.

Proposed fix, NOT applied in this pass (it changes the look of every sierra island and the race kit's surfaces,
which is a bigger decision than B122): band-limit the terminator to the resolution the data actually has. The two
rays being blended are already in hand in `horizonNodes`; their DISAGREEMENT is the uncertainty of the blend, so the
terminator half-width should be `softness + |rayA − rayB| · (hat weight spread)` rather than a constant. That keeps
the cut sharp where the eight rays agree (a real canyon wall) and softens it exactly where the sampling cannot
support an edge (a cone flank, where neighbouring azimuths disagree by tens of degrees) — §V.48's rule, applied to
the azimuth axis instead of the spatial one. A CPU twin already exists next to the azimuth hat for tests to pin.
