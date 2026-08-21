# R0 lookdev gate — prototype grade, params only (T88)

Engine: working tree at HEAD `9aafd64` **plus other agents' uncommitted edits at capture time** (`src/params/sky.ts`, `src/sky/sunCycle.ts`, `src/camera/followCam.ts`, `src/ship/piece*.ts`, `src/state/simState.ts`, `src/input/controlMap.ts`). Served from an isolated rsync snapshot (harness §5) because live Vite reloads from those edits kept wiping page state. No code was edited for the capture.

Frames are 1920×1080 PNG, read back from the post-processing output into a fresh RenderTarget (harness §2/§3: the tab was hidden the whole session, so `toDataURL` and extension screenshots returned the first boot frame forever; the loop was pumped from a worker with `nodeFrame.update()` per tick). Source buffer 1920×1052, center-cropped to 16:9 and scaled.

## Camera / scene (identical in all six frames)

| thing | value |
|---|---|
| boot | `/?at=lagoon`, photo mode (`P`), dev layer off |
| pose | `__game.followCam.setDebugPose([1500, 4, 600], [1000, 10, 530])` — 4 m over the water, looking WSW: lagoon island + anchored ship right, far island (site 2, ~1.5 km) left, horizon gap centre |
| weather | preset `calm` (dropdown) + `weather.cellIntensity = 0` (kills the storm-cell clouds/virga that `calm` alone leaves in the field) |
| sea | wind is held at ~8 m/s by the weather field regardless of the preset's 4 (§V.46 hold / spatial wind); not pinnable from params |
| pixel ratio | 1 (`setPixelRatio(1920/innerWidth)`) |

## Per-frame params (everything else = `src/params/*.ts` defaults at capture)

`*-base.png` = defaults + the timeOfDay in the row. Hex values are the sRGB params as typed.

| param | dawn | noon | dusk |
|---|---|---|---|
| `sky.timeOfDay` | **6.0** | **12.0** | **17.8** (see note) |
| `sky.exposure` | 1.15 | 1.10 | 1.00 |
| `sky.hazeStrength` | 0.80 | 0.45 | 0.70 |
| `sky.fogNear / fogFar` | 150 / 1400 | 400 / 2400 | 200 / 1600 |
| `sky.zenithColor` | – | 0x3E8FA8 | – |
| `sky.midColor` | – | 0x7FBCE0 | – |
| `sky.horizonColor` | – | 0xBFE3F0 | – |
| `sky.sunsetZenithColor` | 0x6C8FA8 | – | 0x5A4B7A |
| `sky.sunsetMidColor` | 0x8EB0C4 | – | 0x9A6A7A |
| `sky.sunsetHorizonColor` | 0xF5C39E | – | 0xF0A45A |
| `sky.sunsetHazeFalloff` | 0.16 | – | 0.12 |
| `sky.horizonWarmColor` | 0xF3C9A8 | – | 0xF0A45A |
| `sky.horizonWarmStrength` | 0.85 | – | 0.70 |
| `sky.sunsetGroundColor` | 0x7A93A6 | – | 0x6A5570 |
| `post.vibrance` | 0.45 | 0.35 | 0.40 |
| `post.vignetteStrength` | 0.30 | 0.30 | 0.40 |
| `post.grainAmount` | 0 | 0 | 0 |

Defaults the rows override: exposure 1.1, hazeStrength 0.45 (calm preset), fog 1800/4900, zenith 0x336cb1, mid 0x558fbe, horizon 0xa1e7ff, sunsetZenith 0x6f5473, sunsetMid 0xe37156, sunsetHorizon 0xffd183, sunsetHazeFalloff 0.1, horizonWarm 0xffaf57 @ 0.45, sunsetGround 0x6d5b53, vibrance 0.18, vignette 0.35, grain 0.006.

**Dusk hour note.** The engine's sun sets at exactly 18:00 (`sunDirection.y` = 0 at 18.0, key light hands over to the moon by 18.25, `nightFactor` = 1 at 19). `timeOfDay = 19` is full night with stars — kept as `dusk-19-literal.png` (ungraded) so the gap is on record. `dusk.png` uses 17.8 (sun 3° up, due west, in frame). If the doc's "19:00 dusk" is a hard requirement, the day length / sunset hour is a sunCycle change, not a grade.

## What the current stack cannot reach without the T101 LUT node

- **Violet shadows / peach highlights (split toning).** Every colour lever here is a *light or sky* colour, so it tints highlights and shadows together. Dusk zenith is 0x5A4B7A as authored but lands as mauve because ACES + the sun's warm fill lift it; shadow side of the islands is black-brown, not violet.
- **Dawn peach band is thin.** The sunset crossfade (`lowSunWarmth`) is shared by sky, fog and ambient; pushing peach into the horizon pushes it into the sea bounce too. A LUT could hold peach in the top 20 % of luminance only.
- **Far-plane flattening is not monotonic.** The site-2 island at ~1.5 km stays sharp brown while the lagoon island at 0.75 km is fully hazed in the same frame (visible in every graded frame, left vs right). The distant-LOD island path appears not to take the aerial-perspective node. Fog range alone cannot give the Firewatch 2–3-tone far plane until that is fixed.
- **Noon "hard shadows, white granite"**: sun is 75° up at lat 15 so shadows are fine, but rock albedo is warm grey-brown and there is no per-material grade; vibrance pushes the water to the Ghibli cyan but also greens the rocks.
- **Grain** at 0 and vignette ~0.3 are reachable as-is.
- **Sea state** cannot be calmed for a still: the wind field overrides `ocean.windSpeed`.

Files: `dawn.png`, `noon.png`, `dusk.png` (graded) · `dawn-base.png`, `noon-base.png`, `dusk-base.png` (ungraded, same hour/camera) · `dusk-19-literal.png` (ungraded, tod 19).
