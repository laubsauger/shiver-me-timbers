# Stern sheets, directional startup wash and foam combs

## Scope

The side and close views need airborne water with visible thickness and a
finite breakup time. Startup wash must extend behind the engines under thrust,
even before the hull moves. Surface foam must not inherit the ambient swell's
crosswise texture or form a nearly opaque painted strip.

## Changes

- Rooster droplets begin as 11 cm ragged fragments, narrowing into the existing
  2.5 cm drops over about 0.24 seconds, varied per particle. A separate 20 mrad
  young-fragment cap preserves close-view visibility; mature drops retain their
  6 mrad cap. Existing ballistic positions, source heights, drag and emission
  budgets remain in use. These are particle fragments, not a connected fluid mesh.
- Hull sheet launches vary speed along the reflection ray rather than varying
  vertical and lateral speeds independently. Filled boil emitters keep their
  turbulent fan. Clump opacity decays with exponent 1.5 instead of 2.5 so the
  airborne arc remains visible longer; lifetime and launch energy are unchanged.
- The finite prop-wash front advances from boat travel **and** jet excess speed.
  Jet transport decays beyond the potential core. A powered stationary prop
  grows an aft wash; zero thrust and zero travel do not grow the front.
- Exhaust surfacing includes the prop's own current during bubble rise. Its
  steady source is also clipped to the reached front. Neutral exhaust remains
  local; powered exhaust is carried aft instead of forming a round source at
  the prop just because boat advance is zero.
- The porous wake mask no longer applies the ocean's crest-oriented transform.
  Whitecaps retain their existing transform.
- The retained-direction implementation from plan section 36 had a second
  defect: multiplying absolute world positions by a spatially varying direction
  tensor introduces a `worldPosition * gradient(direction)` term. This produces
  dense combs far from the origin. Direction now blends **values** from four
  fixed axes (0, 45, 90, 135 degrees), with centered contrast normalization.
  Crossing wakes blend without a live player-heading dependency. Four single
  noise octaves replace the previous three-octave filament field; the broad
  patch is isotropic. A bounded coordinate bend breaks the lattice silhouette.
- Fresh dense foam retains more openings (boil threshold 0.16, previously 0.03),
  more bubble-scale variation, and softer edges. Final froth opacity now uses
  the existing wake optical-depth control rather than a linear 90% paint layer.
  This lets displaced water remain visible underneath the airborne effect.

## Validation

CPU tests cover finite stationary transport, no-thrust behavior, slower growth
outside the jet core, stationary timestep invariance, powered exhaust placement,
retained direction and continuous axis blending. Low-speed readability checks
now measure plume spread relative to the transported surfacing point, with an
explicit five-metre bound on the added displacement. The high-speed test requires
50–70% resolved core froth instead of the obsolete >75% blanket requirement.

GPU checks use an isolated Vite/Chrome instance. A constrained wet-hull tow at
20 m/s near world coordinates (-1000, -1000) exercises the large-coordinate
case. One sampled frame contained 26,535 above-surface rooster particles younger
than 0.8 seconds, including 8,158 younger than 0.24 seconds; maximum sampled
height above the source surface was 2.85 m. The side view and close chase view
were inspected, with a separate render hiding airborne pools to expose the
surface mask. This is a controlled visual test, not a natural race or FPS test.

Final captures: [side](stern-side.png), [chase](stern-chase.png),
[surface only](stern-water-only.png), [powered standstill](stern-startup.png).
The last standstill check resets wet-contact history by holding the hull clear
before pinning it at rest under 65% throttle for two seconds. It is a source
isolation test, not a claim about natural acceleration or landing dynamics.

Across the affected suites, 75 tests pass (wake W5b, binding budget, readability,
spray fleet, at-speed disturbance, orientation, prop transport and spray return).
Workspace and isolated-review TypeScript checks pass. Final shaders compile and
render on WebGPU.

An interrupted review exposed a mismatched isolated snapshot: its newer
`surfaceMaterial.ts` imported `snellLookupPointNode` from an older
`surfaceRefraction.ts`, and its surface parameters lacked `refractionSnell`.
The review helper and parameters were synchronized with the workspace. The
workspace already exported the helper; no compatibility fallback was added.

## Cost and remaining limits

No new particle pools, storage buffers, textures, draw calls or compute passes.
The directional foam adds one noise octave and blending arithmetic. Young spray
fragments cover more pixels and therefore increase near-source overdraw. No FPS
improvement or fixed frame-time cost is claimed on the shared machine.

The surface-wave solver remains in use: pressure waves can propagate sideways
and ahead of an engine. The directional transport above controls the wash and
exhaust foam, not a new velocity solver for the surrounding ocean. It does not
turn every outward pressure ripple into aft-moving water. Retained foam still
uses the existing ambient advection/diffusion after emission; full jet-driven
surface advection would be a separate simulation change.
