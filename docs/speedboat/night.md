# Night racing and boat LEDs (T209)

User: "racing in the dark… with the moon out a little bit… give the boats some cool LED lighting that actually illuminates the surface of the water and maybe underwater… in the respective player color."

## Night time option

- `TIME_OPTIONS` (`src/speedboat/ui/boatSelect.ts`) gains `'Night'`. It is saved with the last selection, like the other options.
- The race applies it at start (`main-speedboat.ts` `onStart` → `applyRaceTime(sel.time)`, `src/speedboat/page/raceTime.ts`). Free roam's pause menu has a Time row next to the Sea row (`ui/pause.ts` `onTime`, `page/raceUi.ts`).
- `'Night'` writes the moonlit preset `MOONLIT_NIGHT` (`src/sky/nightPreset.ts`): 02:00, a waxing gibbous moon (phase 0.38, 86% lit) 17° up in the west. The same preset sets `moonIntensity` 0.3 (key 0.21), a soft terminator, limb darkening 0.6, earthshine 0.05, maria 0.8, glow 0.45, disc 0.95 and `moonRoadRadiusDeg` 0.35, which gives fine glitter instead of the sun's 2.6° mirrored plateaus. The new moon-surface params default to 0, so raft and pirate moons are unchanged. Leaving the preset restores every value it replaced.
- Everything else comes from the existing sky: `keyLight` → moon key, stars, night fog and ambient floor. Raft and pirate never call the preset.
- Clock labels drive the sky: `TIME_OPTIONS = ['06:30', '12:00', '15:00', '17:30', 'Night']`, and `applyRaceTime` writes the hour. The default label is now `'15:00'`, the params default the page always rendered, so the default look and the T205 baseline hold. A stored `'17:30'` selection now really renders 17:30.

## LEDs (hybrid)

| piece | who | where | cost |
|---|---|---|---|
| hull underglow strip (just above the boot line) + deck courtesy strip (band/non-skid seam) | every boat | `assets/slotMaterials.ts` emissive, colour = `ledColor(livery)`, one scene-wide level `setBoatLedLevel` | a few ALU per boat fragment, no texture |
| water light pool (ellipse along the hull, brighter on foam) + coloured LED glints on the wave facets, also seen from below | every boat (slot 0 = player) | `ocean/boatLightPool.ts`, 8-slot uniform arrays, opt-in before `buildSea` | fixed 8-iteration loop per ocean fragment, 0 samplers (§V40) |
| underwater glow sheet under each hull (additive, drawn before the ocean so the refraction copy carries it) | every boat | `page/boatLights.ts` | 8 small transparent draws, hidden in daylight |
| 2 real PointLights (port and starboard, at the waterline, no shadows) | player | `page/boatLights.ts`, applied to the boat slot materials only via `material.lightsNode` | boat fragments only |

- Level = `sky.nightFactor`, the single dusk clock: 0 above +1.7° of sun, 1 below −12°, a smooth ramp in between.
- `ledColor` is the signature hue at full brightness. A black or grey signature (levee-town) falls back to the pinstripe.
- Tunables: `src/params/boatLights.ts` (Tweakpane group `boatLights`).

Why the real lights are not in the scene graph: as scene lights, every lit fragment on screen evaluated them, the kit island terrain included. That measured +2–4 ms GPU at 1080p. Stated limit: a light added to the scene after the boats are built does not reach the boat materials.

## Night clouds and hull fill (follow-up)

- Clouds: `src/clouds/cloudPalette.ts` `moonlightDeficit()` measures the share of a full moon's light the night is missing (`nightRamp × (1 − moonAboveHorizon × moonBrightness(phase) / moonBrightness(0.5))`). That share dims the lit faces and the fill, and silvers the lit faces toward `moonColor` (`params/clouds.ts` `nightLitFloor / nightSkyFloor / nightMoonTint`). The cirrus band sheet goes through the same palette, so it dims too.
- The deficit is exactly 0 by day and under a risen full moon, so day and the raft/pirate default night (phase 0.5) stay bit-identical. The pinned "NIGHT IS UNTOUCHED" test in `tests/clouds.test.ts` still passes. Raft and pirate had the same bug only on nights with no moon or a partial one.
- Hulls: `slotMaterials.setBoatNightFill` adds a Fresnel rim biased toward the key (the moon) plus a little sky fill on the albedo, in the moon's hue × `nightFactor` (`boatLightParams.nightRim / nightFill`). It is 0 by day and ignores the LED override.
- Hero LED: `FLEET_LIVERIES.hero.led = 0xff7a1a`. A full-brightness `#e4572e` tonemapped to red. Liveries with their own signature never inherit it.

- The roll-arch courtesy light (`page/cockpitLights.ts`) takes each boat's LED colour. The hero's two real lights sit 1.1 m out from the hull, so the topsides get no hot spot. Pool shading lights the water from the strip as a line source (diffuse on N·L plus tight glints): the ripples and the strip reflections read, not a flat sheet. The glow sheet is down to 0.18.

## Ocean hook (shared with the water session)

`src/ocean/surfaceMaterial.ts`: an import, `const boatPool = activeBoatLightPool()` before `colorNode`, `col.addAssign(boatLight)` just before the haze mix, and `under.addAssign(boatLight)` after the underside foam mix. With no active pool no node is added, so the raft and pirate seas are unchanged.

## Cine API (deterministic, no wall clock)

- `applyNightPreset(on: boolean, skyParams)` in `src/sky/nightPreset.ts` turns the moonlit night on or off. Off restores what it replaced, then set your own `timeOfDay`. Race labels go through `applyRaceTime(label)` in `src/speedboat/page/raceTime.ts`.
- `boats.lights.setOverride(level: number | null)` in `src/speedboat/page/boatLights.ts` (`SpeedboatBoats.lights`, also `__speedboat.boats.lights`) forces the LED level 0..1. `null` follows the sky again.
- Tunables: `boatLightParams` in `src/params/boatLights.ts`, for example `poolIntensity`, `stripNits` and `playerLightIntensity` for a hero shot.

## Measured (2026-09-14, M3 Max, 1920×1080, Calm, staged 8-boat pack, chase camera, frozen frame)

The GPU lock was held, but other agents' vitest runs were loading the CPU. GPU busy, mean over about 100 frames:

| row | round 0 | round 1 |
|---|---|---|
| night, LEDs on | 29.1 | 28.4 |
| same frame, day sky (LEDs at 0) | 29.3 | 30.1 |
| night, boat materials without the 2 player lights | 27.9 | 28.2 |

- Night versus day: no measurable cost (−0.2 and −1.7 ms, which is noise).
- The player's two lights on boat materials: +0.2 to +1.2 ms.
- Draw calls: +41 at night (glow sheets across passes).
- Not isolated: the pool loop's unconditional arithmetic is present in every row. The A/B against a copy of the tree without the pool failed to boot, because the copy snapshot caught another agent mid-edit.

Shots: `scratchpad/t209/out4/led-pack-chase.jpg`, `led-pack-near.jpg`, `led-pack-chase-day.jpg`.

## Open

- Clouds and wind lines draw bright white at night. That is the shared sky/clouds system, not T209.
- Course lamps and start lights were not re-tuned: `src/circuit` is out of scope.
- The rolling race with rivals could not be shot, because an uncaught exception in `src/race/ai/pilot.ts` (AI agent WIP) stalls `?autopilot`. The pack above is staged.
