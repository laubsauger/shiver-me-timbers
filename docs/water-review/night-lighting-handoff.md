# Night appearance review — 14 September 2026

User screenshot: `Screenshot 2026-09-14 at 15.03.29.png`.

The stars read as large white discs, sky wind lines dominate, and isolated
orange hotspots interrupt the boat's continuous LED strip. The requested look
is fine stars, subdued night streaks, and distributed LED illumination.

Applied parameter changes:

- Star angular radius: 0.04 to 0.024 degrees. Integrated flux becomes 36% of
  its old value; the existing two-pixel reconstruction floor remains. This
  reduces visible/bloomed extent rather than introducing unstable subpixel dots.
- Night wind-line multiplier: 0.15 to 0.035. Full-night line radiance is 23.3%
  of its previous level; daytime brightness is unchanged.
- Hull strip radiance: 14 to 8. Hero point lights: 40 to 6 candela, range 14
  to 6 metres. These soften concentrated hull highlights while retaining the
  continuous strip. No new lights, shader loops or render passes.

The point lights are a plausible hotspot source, not isolated proof: strip
bloom and water specular pools also contribute. Recheck the same camera and
exposure before changing bloom globally. No new GPU benchmark was run under
shared machine load. Saved parameter overrides can supersede these defaults.

## Boat-lighting owner: requested geometry follow-up

No other agent is reachable through this thread's collaboration channel; this
file is the coordination handoff, not confirmation that another agent accepted
work. Existing boat-light geometry remains owned by the active boat agent.

1. Add continuous submerged LED lines along both hull sides, below the loaded
   waterline. Existing `boat-led-glow` is an underwater glow plane, not a strip.
   Reuse per-boat signature color, night level and the existing bounded water
   pool. Check wave occlusion and underwater transmission rather than drawing
   through the hull or adding more unshadowed point lights.
2. Add a restrained red courtesy emitter beneath the top bar to reveal the
   cockpit. Keep it local to the cabin; avoid lighting the entire sea. Prefer
   emissive geometry first, with one short-range hero-only light if needed.
3. Position lights are optional per the user's suggestion. Keep red port and
   green starboard distinct from signature LEDs; verify boat-local orientation.
4. Review idle and planing boats at the supplied night camera: continuous
   strips, no searchlight-like hotspots, readable cockpit, and no daytime glow.

These geometry additions are pending; this pass only changes the existing
star, wind-line and LED-light defaults.

Validation: 119 starfield, wind-line, sky and night-lighting tests pass with one
worker. The star calibration assertions now match the reduced flux; flux
conservation and sampling stability checks remain unchanged. `git diff --check`
is clean. A matching-camera after-image has not yet been captured. No commits.

## Follow-up: actual star footprint and submerged strips

The user clarified that the star radius itself was too large. The earlier flux
change alone did not remove the two-pixel reconstruction radius. That radius
is now 1.2 pixels, with four quarter-pixel coverage samples sharing the same
star/hash lookup. The general material-detail filter is unchanged. Across a
21×21 subpixel phase sweep, integrated brightness varies by 1.88%, versus
2.22% for the original point-sampled two-pixel disc. The compact kernel has
zero support at 1.5 pixels along either image axis in the square-pixel probe.
This adds three radial profile evaluations per background pixel, no extra star
lookups or texture reads. The star-only WebGPU shader compiled and rendered;
87 sky/star tests passed before the subsequent boat-material change.

Submerged LED lines are now implemented directly in the hull's existing
emissive material, 45 mm below the authored boot line, 20 mm wide and at
radiance 3. They reuse the signature color, night level, normal-side gate,
existing mask texture and normal depth/refraction path. Their mask stays inside
the texture's ±80 mm distance range so the saturated bottom cannot become one
large light. They require no extra geometry, draw calls, point lights or
samplers. Actual immersion varies with boat pose and waves; these are not
camera-facing lines forced to stay visible through the water.

The red top-bar/cockpit fixture and optional position lights remain pending.
A matching gameplay camera review of the submerged lines is still needed.


## Follow-up: red cockpit fixture implemented

`cockpitLights.ts` mounts a 420 × 18 × 25 mm red diffuser below the aft roll-arch
crossbar. Mounting uses the GLB's `partsAnchors.archZ` and the same authored arch
height as the Blender builder; missing anchors fail instead of inventing a
location. The runtime does not edit or rebuild the actively changing GLB.

Each boat gets one shared-geometry/shared-material fixture draw when lit. One
2.5-candela, 2.8-metre, softly edged spotlight illuminates the player's cockpit.
It is outside the scene light set and is appended only to the boat-material
light node, so the sea and island terrain do not evaluate it. No shadow pass.
The light and target follow the hero's world transform, and daylight/hidden
hero states turn illumination off. The pipeline-test hull has no arch and
explicitly does not create these fixtures. Cleanup removes the fixtures and
disposes their resources. Optional navigation lights remain unimplemented.

Eleven cockpit/night tests pass, including mounting against the actual GLB,
pose following, day/night visibility, local light ownership and cleanup. An
isolated WebGPU scene compiled the exact boat-only spotlight setup and showed
red illumination on cockpit surrogate geometry. This is not a full-boat visual
review or a frame-time benchmark. The initial whole-workspace type check found
concurrent trailer `CineOpts.takes` errors; the final check is recorded below.

Final TypeScript check passes. `git diff --check` is clean. No commits.


## Final sky composite: preserve focus, retain sparse wisps

The screenshot remained soft after the star-kernel change because the cinematic
grade enables DOF. The previous post pipeline passed the background's far depth
straight into DOF, so compact stars were blurred back into discs. `skyDof.ts`
uses the scene depth-clear sentinel (1) to give background pixels zero far CoC
and restore their original color after near-field spreading. Geometry retains
DOF. This is an intentional art-direction exception to photographic sky blur;
it does not change star brightness or cloud geometry.

The actual Three DOF regression uses single-pixel points on both sky and geometry.
Previous sky maximum error is 0.93683; corrected sky error is exactly zero,
while geometry still differs by 0.93683 from its sharp reference. Probe and
raw output: `sky-dof-probe.js`, `sky-dof-gpu.json`.

User explicitly requested tuning rather than removing streaks. Full-night
wind-line dimming remains 0.035. A new `windLineNightDensity` of 1/3 narrows
the existing per-line hash gate, leaving irregular gaps rather than keeping
every third meridian. Dusk interpolates smoothly. Gust modulation deepens
from the authored setting toward 0.96 at night, giving longer dark gaps within
each surviving streak. Daytime density and gust strength remain unchanged.
Cloud masses are not removed or changed in this pass.

`night-sky-focused.png` shows the actual sky node through corrected DOF at
1000×600, 22:00, quarter moon, 11 m/s wind, exposure 0.9. It excludes cloud
meshes, sea, bloom and final grade, so it verifies focused stars and wisps,
not the complete game composition. The matched game view still needs review.
72 star/wind/post tests pass. TypeScript checking passes. No timing claim and
no commits.
