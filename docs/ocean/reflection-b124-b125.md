# B124 + B125: bars on the far sea, boats floating on their reflection

Shared ocean (pirate `index.html`, raft `raft.html`, speedboat `speedboat.html`). Evidence frames live in the session
scratchpad (`scratchpad/b124/`), listed per bug below.

## B124: rows of blocky bars on the water near the horizon

### Analysis (one frozen frame, A/B toggles)

Frame: `speedboat.html?mode=free&cine`, shot R6 (sunset, lens 1.05 m over the water, fov 20, straight into the sun),
frozen with `loop.setFixedDt(0)` at shot time ≈ 3 s, 1920×1080. Each toggle was set live, captured, and restored.
Crops are the horizon band x 1150–1750, y 540–580, ×3.

| toggle | bars |
| --- | --- |
| sun glitter off (`sparkleStrength 0`, `glintRoadStrength 0`) | stay |
| planar reflection `live 0` / `strength 0` | stay |
| far normals off (`normalFadeStart/End 30/60`) | stay |
| reflection RT ×0.5 (×2 is clamped by §V26) / no mip blur | stay |
| refraction 0, foam off, haze off, flat sea (amplitude 0), radial LOD off | stay |
| micro detail, SSS, shallow tint, normal keep, slope variance AA off | stay |
| hide each top-level scene group (archipelago, course furniture, hero, sprites, cloud mirror) | stay (hiding the ocean removes the water) |
| god rays, bloom, DoF, grain, SMAA off | stay |
| **`postParams.aoStrength 0`** | **gone** |

minWidth (f) was not toggled on its own: hiding course furniture (every thin-axis member in that frame) left the bars.

Crops: `ab-r6.png`, `ab-r6-bisect.png`, `ab-r6-c.png`, `ab-r6-d.png`, `ab-r6-e.png`.

### Root cause

The ocean writes depth (`surfaceMaterial.ts`, §V28 early-Z), so GTAO marches the water sheet itself. A kilometre out,
at a grazing angle, a half-resolution march over depth-reconstructed normals of a displaced surface finds its own
neighbouring texels as occluders, and the half-res result lands on the frame as blocks: rows along the distance bands,
bars across them. It is brightest into the sun because the multiply darkens the brightest water. AO is on through the
graphics settings (`postAo`), which is why pirate mode shows it too.

A first fix keyed AO on "the view ray crossed the mean water plane" (assuming the depth held the bed under a
depth-write-off sea, as `params/post.ts` still says). It removed most of the bars and left a residual. A debug view of
the keep mask showed ≈1 on the water, which is how the depth-writing sea was found. That fix was replaced.

### Fix

AO lands only on surfaces that receive it (`src/core/aoReceiver.ts`). While AO is built, the scene pass carries one
extra 8-bit MRT target. Each draw writes its receptivity (the ocean 0, everything else 1), covered by its own output
alpha, and the composite scales AO by it. The receptivity is decided per material inside the pass's MRT node, not
through `material.mrtNode`: three r180 would make an mrtNode the whole output in any non-MRT target pass. Hulls keep
their contact shading against the water. The sea is unlit pigment plus Fresnel reflection and transmission (§V20,
§V24), and hemisphere AO is the wrong term for it at any distance.

After: `b124-final.png` (top: before; middle: after with AO on; bottom: AO strength 0, the reference).

Cost: one RGBA8 attachment on the scene pass while `aoEnabled`, and nothing when it is off. The GPU time was not
measured on its own, because `aoEnabled` is a construction gate and cannot be toggled live.

## B125: boats float on their own reflection

### What the mirror actually contains

- three's `ReflectorNode` already applies Lengyel oblique near-plane clipping at the target plane (y = 0). Checked
  live: a full copy of the hero hull placed 6 m, then 1.5 m under the water, left no trace in the reflection
  (`b125-03-diag.png`).
- The clip is right for the plane. The drawn sea is not the plane: at a hull on a crest, or in her own displacement
  mound, the water stands η above y = 0. The slice of hull between the plane and the real surface is under water in
  the frame, yet it sits above the clip and is mirrored below her.

### Fix (the mirror side: the slice between the rest plane and a raised surface)

`reflectionShading.ts`: the pass now keeps its depth (`reflector({ depth: true })`, a Nearest depth texture read by
`textureLoad`: +1 texture, +0 samplers, ledger updated). Per water fragment, the real world point behind the texel it
reads is rebuilt through the virtual camera's own oblique projection. `planarReflection.ts` copies that projection's
inverse and world matrix after each mirror render, because three rewrites the projection without refreshing the
inverse. The texel is dropped when that point lies below the fragment's drawn water (`positionWorld.y`: cascades plus
wake elevation, including the transom hollow). The drop is band-limited on `fwidth` of the height difference, clamped
to 5–25 cm. `mirrorMath.aboveSurfaceKeep` is the tested CPU twin. `reflectionParams.surfaceClip` (live, identity at 0)
is the A/B lever.

### Tried and removed: mirroring each facet in its own height

The complete answer would also close the 2η parallax gap under a raised hull, by re-reading the single-plane target
at the texel a mirror at the facet's own height would show. That was built (CPU twin, then TSL, with seeds at the
contact and at the pixel and a residual test) and measured in the browser. It failed in two ways:

- The texels it needs lie 2·(H − plane) away on screen, and the target only covers the main frustum. With the clip
  lowered 0.5 m to keep troughs, a lens 0.45 m over the water needed texels below the frame for every water pixel
  within ~8 m.
- Where both seeds converged on different roots, the reflection ghosted (a doubled red band and a doubled galleon).

A single-plane render target cannot answer it robustly. It was removed rather than shipped half-working.

### The legs were never in the mirror: they came through the water

The clip fix above did not change the decisive frame (shot 03, boat at rest, low rear quarter on the outboards). A
false-colour pass settled what the water was showing: every hero mesh painted by world height (magenta below y = 0,
green above), then the reflection toggled.

- Reflection on: the mirror image is green only. Nothing under the plane is in the mirror.
- Reflection off (`reflectionParams.live 0`): the magenta hull and the three lower units still hang under the boat,
  in the same place as her reflection.

Evidence: `k-03-legs-b.png` (top: reflection on, false colour; bottom-right: reflection off).

So the "mirrored lower units" were the §V.24 see-through channel. `surfaceMaterial` read the scene behind the water
along the STRAIGHT view ray. From a lens 25–70 cm over the water that ray runs almost flat under the surface and
shows submerged geometry at its above-water size, directly under the hull. The transmission floor (≥ 45 % where
something is behind) kept it visible against the grazing Fresnel mirror. Lowering the floor to 0 alone left the legs
visible, because wave-tilted normals lower F.

### Fix (the transmission side)

`surfaceRefraction.snellLookupPoint` (a CPU twin, tested) and `snellLookupPointNode`: the scene is looked up where
the REFRACTED ray goes. The step walks the ray through the flat mean-surface normal, as far as the straight ray
travelled behind the surface, then projects that point to screen. Air to water bends every ray to ≤ 48.6° from the
vertical, so the submerged hull squashes up to the waterline (apparent depth). A grazing lookup that lands off the
screen, or on nothing, shows the water body. A straight-down view is the identity, and the wave-tilt offset rides
on top unchanged. Eye above the water only. `oceanSurfaceParams.refractionSnell` (live, exact old lookup at 0) is
the A/B lever. Cost: one more read of the shared viewport depth texture (+1 call site, +0 bindings, ledger updated)
and a few arithmetic ops per water fragment. §V.24 still holds at steeper views: from 2.5 m the legs stay visible,
shortened (`z-03-high.png`).

### Verification (1920×1080, frozen frames; before = `surfaceClip 0, refractionSnell 0`, after = `1, 1`)

- speedboat at rest, sunset, low rear quarter on the legs: `z-03-legs.png` (legs gone from under the cowl reflection)
- speedboat side at rest: `z-03-side-*.png` (no legs in frame, unchanged)
- speedboat R1 at 24.5–27.5 m/s, low: `z-R1.png` (the submerged-slice band under the hull is gone)
- galleon side, 48 m and 22 m: `z-galleon.png` (the black slab of submerged hull under her is gone)
- raft low side: `z-raft-*.png` (live sea, not a frozen A/B; no artefacts)

Perf: GPU `renderer.info.render.timestamp` median on R1 with both levers on vs off: 298/299 vs 300/308 (two
rounds). That is inside the noise. The number is headless and relative only.
