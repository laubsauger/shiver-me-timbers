# Wake detail fade: projected pixel area

2026-09-15. Small shader correction; no wake solver or emission changes.

The lace and churn relief fades used `sqrt(fwidth(worldXZ).x * fwidth(worldXZ).y)` as pixel size. This measures an axis-aligned bounding box. A long, thin projected pixel gains apparent area when rotated, retiring wake detail earlier at diagonal camera headings.

Both secondary fades now use `sqrt(abs(det(dFdx(worldXZ), dFdy(worldXZ))))`, retaining the existing numerical floor. Noise octave filtering still uses `coordFootprint`; area alone cannot filter grazing-angle aliasing.

## Validation

- Real WebGPU float render-target readback: a 1:16 pixel aspect ratio at 0°, 22.5°, 45°, and 90°. The old footprint, scaled by 8, was 0.125 / 0.323046 / 0.375652 / 0.125. The corrected result was 0.125 / 0.125001 / 0.125004 / 0.125. The small residual is GPU derivative precision.
- Reusable GPU diagnostic: serve `/docs/water-review/wake-area-probe.html` through Vite. It renders the actual production helper, reports both formulas, and fails if rotation changes the expected area beyond tolerance.
- Full game: a controlled three-second, 12 m/s forward tow rendered through the actual ocean material. `wake-area-after.png` shows the sunset chase view. This checks integration; it does not establish impact behavior or natural acceleration.
- Twenty wake readability/simulation tests pass. TypeScript passes.
- Broader band-limit audit fails at 182 findings against its 176 ceiling. Running its exact auditor against HEAD and the edited files gives identical counts: flowfoam 4/4, foamShading 1/1, with no added findings. The existing ceiling was not changed.

## Remaining work

The separate historical/rival direction issue was subsequently addressed in `wake-retained-orientation.md`. Review moving impacts and rival transom turbulence separately. No FPS improvement is claimed for this area correction: it replaces fragment arithmetic, adding no CPU sampling, textures, or render passes.
