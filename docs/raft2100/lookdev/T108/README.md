# T108 moon check — sky preview (`/src/sky/preview.html`), HEAD dd233c3

Captured 2026-08-21 from an rsync snapshot of HEAD served on :5197, hidden tab, worker-pumped
rAF, read back from a 1920×1080 output RenderTarget (ACES + sRGB applied by the renderer's
output path). Camera: `__skyPreview.look(yaw, pitch)`, fov 55. `skyParams.timeOfDay` /
`skyParams.moonPhase` set directly (`sky.update(tod)` runs every frame). Sun at 17.5 is at
−x, so **east = camera yaw −90, west = yaw +90**. `moonDirection(tod, phase, lat=15)` from
`src/sky/moonCycle.ts` was evaluated on the CPU for every frame and is quoted below.

| frame | tod | phase | view | CPU moon elev. | what the frame shows |
|---|---|---|---|---|---|
| dusk-tod18.5-phase0.5-east / -atmoon | 18.5 | 0.5 | east | +8.6° | one moon low in the east, blue-white glow, **thin CRESCENT** |
| dusk-tod19-phase0.5-east / -atmoon | 19.0 | 0.5 | east | +15.8° | same, higher; crescent lit on the RIGHT (south) limb |
| dusk-tod19.5-phase0.5-east / -atmoon | 19.5 | 0.5 | east | +23° | same, crescent |
| dusk-tod18.5-phase0.05-east / -atmoon | 18.5 | 0.05 | east / at moon (west, +8.9°) | +8.9° (west!) | nothing in the east ✓; a faint sliver IS drawn in the west 9° up in twilight |
| dusk-tod19-phase0.05-east / -atmoon | 19.0 | 0.05 | east / west +1.7° | +1.7° (west) | nothing east ✓; sliver at the western horizon, very faint |
| dusk-tod19.5-phase0.05-east | 19.5 | 0.05 | east | −5.5° | no moon anywhere ✓ |
| dawn-tod5.5-phase0.5-west / -east | 5.5 | 0.5 | west / east | +8.5° | moon setting in the west, crescent, glow; east: pre-dawn, no sun ✓ |
| dawn-tod6-phase0.5-west / -east | 6.0 | 0.5 | west / east | +1.3° | west: no moon visible (CPU says 1.3° up — disc already gated); east: sun disc exactly on the horizon ✓ |
| dawn-tod6.5-phase0.5-west / -east | 6.5 | 0.5 | west / east | −5.9° | west: gone ✓ (sky already pink, a few stars still drawn); east: sun 7° up ✓ |
| sunset-tod17.9-west | 17.9 | 0.5 | west | sun +1.4° | sun disc half-set, no moon near it ✓ |
| sunset-tod18.1-west | 18.1 | 0.5 | west | sun −1.4° | **no disc, no glow from under the sea** ✓ |
| sunset-tod18.3-west | 18.3 | 0.5 | west | sun −4.3° | no disc; stars already on over a bright pink sky |

## Verdict against the T108 expectations

- ✓ Phase 0.5: exactly one moon, rising in the **east** at dusk, opposite the sun; its glow is
  blue-white, no orange disc, no sunset tint on it. The "sun turns into the moon" failure is gone.
- ✓ Dawn: moon sets in the west and is gone by 06:30; at 06:00 the CPU still has it 1.3° up but the
  disc is already gated off (fine, it is inside the horizon margin).
- ✓ Sun disc appears only within ~2° of the horizon (visible at +1.4°, gone at −1.4°), no glow
  from below the sea.
- ✗ **Phase 0.5 renders as a thin crescent, not a full disc.** `moonIllumination(0.5)` on the CPU
  returns 1.0 (full) but the shader disc is ~20 % lit in every phase-0.5 frame, and the lit limb
  faces **away** from the sun (lit on the south/right limb when looking east; at dawn looking west
  it is lit on the right = north). The disc's lit-fraction / terminator vector does not use the
  same illumination as the CPU mirror — `tests/moonOrbit.test.ts` cannot catch this because it
  tests the CPU side. Needs a shader-side look (skyBackground moon disc).
- ✗ (minor) Phase 0.05 at 18.5/19.0: a faint sliver is still drawn 9°/2° above the western
  horizon, 2-5° from the sun's azimuth, while the sky is still bright. Expectation was "no moon
  visible at dusk" for a new moon; it is faint, but it is there (`dusk-tod18.5-phase0.05-atmoon`).
- ✗ (minor, pre-existing) Stars are fully on by 18:18 (sun −4°) over a pink sky, and still on at
  06:30 (sun +7°). Star fade is not tied to solar depression.
