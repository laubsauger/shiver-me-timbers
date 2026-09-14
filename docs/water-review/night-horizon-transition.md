# Night sky: horizon shelf fixed at the projection

Status: GPU-reviewed in the actual speedboat scene; user approved the result
("that's much better") on September 14. Changes remain uncommitted.

## Cause and final change

The cloud sheet used `min(height / rayUp, bandRange)`. At a 2 m eye height,
the 2100 m deck and 34000 m limit froze the lookup radius below 3.54°.
That entire angular strip lost its elevation coordinate. The resulting
footprint collapse was suppressed by replacing its structure with a uniform
veil, producing the shared horizontal stop above the sea.

The range is now `height / sqrt(rayUp² + (height / bandRange)²)`: continuous,
monotonic and bounded by the same range. It approaches the plane intersection
away from the horizon and approaches the range limit only at the horizon.
Cloud detail can therefore continue below the former cutoff, with uneven ends,
while its existing density and horizon attenuation taper it out.

The original `bandDegenerateFade: 0.2` remains, with cubic endpoints. The earlier
0.6 widening experiment was rejected: it made little difference and removed
interesting detail higher in the sky. Stars, cloud population, haze colors and
wind-line population are unchanged. No new texture, rendering pass or CPU
per-frame work; the cloud-sheet fragment adds a square root and scalar arithmetic.

## Verification

- 105 cloud and coupling tests pass, single worker. Tests prove bounded range,
  no derivative jump at the old cutoff, retained detail below it, monotonic
  fading, smooth endpoints and the correct horizon mean.
- TypeScript passes.
- Actual WebGPU sky/cloud pipeline checked along and across the band direction,
  with the current moonlit preset, an older brighter night, and daylight.
- Full speedboat scene rendered at 1280 × 720, paused free roam, same camera,
  seed and night lighting for the old/new projection comparison. The earlier
  spray/DOF import mismatch had cleared, allowing full-game verification.
- Full-game daylight checked. No FPS claim under shared machine load.

[Original night](horizon-game-before.png) · [Revised night](horizon-game-after.png)
· [Daylight](horizon-game-day.png) · [Crosswind diagnostic](horizon-crosswind-after.png)

The isolated diagnostics remain useful but are not the final acceptance images.
The approved full-game comparison is the record to use for this change.

Separate small fix completed earlier: race clock parsing rejects overflowing
minutes, and invalid labels cannot disable an active night preset. Both
regressions were reproduced before the fix; the 11 clock/night tests pass.
