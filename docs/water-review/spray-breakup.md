# Hull-spray clump breakup

2026-09-15. Render-mask change in `src/foam/sprayPool.ts`, only for `clumps` pools.

## Cause and change

The old angular lobes perturbed the edge of a mostly opaque radial core. At
gameplay distance, the result was a repeated row of round white puffs. A layer
isolation in the actual game confirmed those puffs disappeared when hull clumps
were hidden, while prop mist, fine drops and surface foam remained.

The clump shader now changes both the interior and the boundary. A single
filtered noise octave has an independent phase per particle, a rotated and
warped sampling domain, and slow motion over particle age. Erosion increases
with age. The warp prevents thresholding the noise into straight lattice cutouts.
The gate uses the field's pixel derivative; unresolved holes fade to an authored
partial-coverage approximation, rather than an opaque centre.

Fine holes alone were insufficient at gameplay scale. The broad silhouette also
varies per particle and narrows along projected motion as the fragment ages.
That variation remains visible when the small breakup cells no longer resolve.
Clump width is reduced; apparent coverage is deliberately lower. Spawn rate,
particle count, overall sprite length, lighting and launch physics are unchanged.

## Review and checks

- `spray-breakup-before.png` and `spray-breakup-after.png`: matched GPU mask
  captures with identical positions, ages, velocities, lighting and particle
  counts. Only the clump mask differs. Rows represent increasing ages.
- `spray-breakup-layer-check.png`: actual game with hull clumps hidden to
  identify the source of the round shapes. This was a diagnostic visibility
  change, not a removal from the game.
- `spray-breakup-game.png`: final integrated wake at a controlled 12 m/s tow.
  This is a visual integration check, not a matched gameplay benchmark.
- `spray-breakup-review.html`: repeatable current-shader age grid, served by
  Vite, using the actual production particle pool.
- 81 tests pass across spray, fleet spray, return-height validation, at-speed
  disturbance and hull masking. TypeScript and diff whitespace checks pass.

## Performance and remaining limits

The final mask adds one procedural noise octave and domain-warp arithmetic,
replacing the angular rim calculation. There are no additional textures,
storage buffers, particles, compute passes or draws. Existing geometry culling
and lifetime handling remain in force. The cost is fragment arithmetic and
depends on visible clump area and overlap; it is not free.

The isolated GPU timestamp batches varied substantially across consecutive
runs. They do not establish a reliable frame-time delta, and no FPS improvement
is claimed. Larger fleet and close-camera overdraw still deserve a controlled
performance review when machine load is stable.

This remains a particle approximation. Dense overlapping roots can still read
as a continuous plume. Broader night/storm and moving-pack review, and collision
against the evolving wave surface, remain separate work.
