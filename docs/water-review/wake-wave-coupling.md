# Wake follows the water surface

**Status update:** the later W8 visual pass removed ambient-elevation carving
from the wake mask because it produced crest-height holes in the lane. The
GPU measurements below describe the earlier experiment, not the current wake
call. Preserve the later decision: wake shading uses the combined surface
normal, while its breakup is handled by W8's own filament and age model.

Review target: the September 14 sunset stern screenshot shows an opaque wake
and water that appears to lose detail a short distance ahead of the boat.

The solver already supplies wake elevation to ocean vertices and wake slopes
to the water normal. The propeller sources contribute to that solver. Short
ocean waves are damped in the disturbed lane; the long swell remains. This
patch does not introduce another engine turbulence model.

Two material connections were missing:

- Wake detail now receives the existing ocean elevation in RMS units, using
  the same bounded texture-coordinate displacement as whitecaps. Previously
  its breakup ignored the wave elevation. This changes the detail lookup,
  not the simulation's coverage, age, velocity or source placement.
- Fresh wake froth now uses the combined ocean and wake normal for diffuse
  lighting. Previously it inherited the relief normal of the unrelated
  whitecap mask. Whitecaps retain their own relief lighting.

The concurrent W8 changes remain intact: aged aerated water colors the
transmitted body below the reflection, and only dense fresh froth becomes a
surface film. This patch adds no texture bindings, slope taps, simulation
passes, geometry or lights. It adds bounded arithmetic for the detail warp.

## Verification

`wake-wave-probe.js` runs the actual foam detail shader on WebGPU at 256 × 128,
comparing an uncoupled field against a sinusoidal ocean elevation. Mean absolute
mask difference is 0.0825082; average coverage changes from 0.2275631 to
0.2278030 (0.024 percentage points). All output samples remain finite and in
[0, 1]. This proves material response, not full hydrodynamic coupling or visual
approval of the moving boat.

The existing foam and wake readability suites pass: 102 tests. Four ocean
binding-budget tests and TypeScript pass. The complete ocean shader also
rebuilt successfully in the isolated full scene.

## Distance-detail diagnosis

Global normal fading starts at 2.2 km and ends at 4.2 km. It cannot by itself
explain disappearance within a few metres. Per-band pixel filtering, grazing
reflection, haze and foam opacity remain separate factors.

A paused full-scene sunset comparison with identical camera and DOF bokeh 0
versus 2 showed less than 0.2% change in horizontal image gradients in selected
near/mid/far water regions. Defocus therefore was not the dominant loss in this
particular view; no lens or camera change was made. This does not cover the
trailer's close-up shots, which have different focus settings.

The initial review's NPC worker stopped on existing `process is not defined`
debug code. A subsequent free-roam capture bypassed the NPCs and successfully
advanced the player and wake: 180 fixed ticks with horizontal speed held at
20 m/s, throttle 0.7, a stern camera 17 m behind and 5 m above the hull.
This is a controlled diagnostic, not a natural acceleration or landing test.

![Wake with spray](wake-spray-visible.png)

![Same wake with vessel spray hidden](wake-spray-hidden.png)

Hiding all four vessel particle meshes leaves the opaque sheet largely intact.
Surface foam, rather than the airborne plume alone, is therefore the dominant
obstruction in this view. The wave-coupled mask and normal correction by
themselves do not solve saturated white coverage.

**Concurrent-work boundary:** these captures use the earlier W8 whitening
function. The newer `WAKE_LACE` / `laceUniforms` implementation appeared in
`src/flowfoam/index.ts` during review and is not represented in these images.
Do not treat them as a rejection of that newer implementation or overwrite its
tuning with this snapshot. Its separate filament coordinates should also be
checked for wave response; passing elevation to `foamDetailMask` only affects
the existing detail mask, not an independent noise field. Moving impact and
sustained planing review of the combined latest code remains necessary.

No FPS conclusions under concurrent machine load. No commits.
