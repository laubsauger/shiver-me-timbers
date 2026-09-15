# Spray returns to its source surface

2026-09-15. Applies to hull whitewater clumps, prop droplets and prop mist.

## Failure and correction

The shared pools used the current mean water height across their emitters as
the plane that kills falling particles. Two boats four metres apart vertically
therefore shared a plane halfway between them. The lower boat's spray died as
soon as it started descending, even while still above its own water. Changing
the active fleet could also move the return plane of already airborne particles.

`createSprayPool({ returnBelowBirth: 0.05 })` allocates one source-height float
per particle. Each emitter writes `birthHeight` alongside position, age and
velocity in the existing spawn pass. The falling particle dies five centimetres
below that retained surface. Reusing a slot replaces its height. Prop births
include a sub-tick ballistic offset, so they explicitly store the original
water height, not their already elevated spawn position.

The old shared-plane option remains available for callers that deliberately
need a uniform plane. Combining the two modes or supplying an invalid retained
offset throws. None of the three fleet spray pools uses the shared plane now.

## Verification

- `spray-return-probe.html` runs the production kernels on WebGPU. Eight
  assertions reproduce the old early death, verify two vertically separated
  sprays survive and return independently, and cover reused slots and sub-tick
  births. All pass.
- In the reproduction, after eight fixed ticks the old lower particle is dead
  (age 10000), while the higher particle is alive. Both corrected particles
  are alive at age 0.133333 and at y=0.035233 / 4.035233. Both then die on return.
- Actual speedboat GPU readback finds finite retained heights in all three
  active pools. The checked frame contains 1,993 young hull clumps, 12,533 young
  prop drops and 3,645 young mist particles.
- Full-game integration at a controlled 12 m/s tow is captured in
  `spray-return-game.png`. A diagnostic hop raises the boat 1.5 m and sets
  downward speed to 5 m/s: new hull spray remains zero while airborne, starts
  at contact around frame 10, rises through impact and decreases afterward.
  `spray-return-impact.png` records the resulting frame. This is a controlled
  integration check, not a naturally driven jump or approval of spray styling.
- 81 tests pass across spray, fleet spray, return-plane validation, at-speed
  disturbance and hull masking. The earlier chine suites also pass (11 tests).
  TypeScript and diff whitespace checks pass.
- One pre-existing spray test used obsolete eigenvalue calibration constants
  from before the ocean amplitude correction. It now reads the shared calibrated
  constants while independently checking the spray/foam z-score contract;
  `foam.test.ts` owns verification of the constants against generated spectra.

## Cost and limits

One compute-only float per particle: 32,768 hull clumps + 65,536 prop drops +
16,384 mist slots = **448 KiB** in the actual speedboat fleet. No added ocean
texture, simulation pass, render pass, draw or particle. Each affected update
kernel gains one storage-buffer binding. Spawn writes the height once per birth;
falling-particle checks read it instead of the shared uniform. Factory defaults
alone would allocate 148 KiB; the fleet deliberately uses larger prop pools.

The plane is local to the source at emission. It does not follow subsequent
wave motion or sample wave height at each particle's current XZ. Full dynamic
surface collision remains separate work. Sprite size, density, lighting and
launch tuning are unchanged.

The isolated review server now uses its own dependency cache to avoid mixing
Three.js module instances while other agents run Vite. This is review-environment
configuration only; the repository's Vite config was not changed.
