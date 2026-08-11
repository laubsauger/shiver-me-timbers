# Session handoff — 2026-08-11

Continuation brief for the next session. SPEC.md = source of truth (§T statuses,
§V invariants, §B bug ledger). This file = what SPEC doesn't carry.

## Run

- `npm run dev -- --port 5199` → chrome tab, ~100fps full scene.
- `npx vitest run` (354 green) + `npx tsc --noEmit` = merge gate.
- Tweakpane: Tab. Perf HUD top-left. `window.__game` = dev handle.

## Where things stand (beyond §T)

WORKING IN-GAME @100fps: FFT ocean 3 cascades (non-commensurate 253/59/13.7),
progressive foam (desynced lifecycles), ship wake (speed-scaled Kelvin V +
stern churn), crest+bow spray (NaN-guarded, B5), galleon (lofted hull, castles,
cannons, wheel, sails w/ billow+robands), 48-rope rigging + 13 blocks, sun
shadows (PCF 2048, frustum follows ship), buoyancy (pitch/heave/roll fixed,
B6/B7), sailing (Tait-Bryan contract), follow cam (free-dive enabled),
weather presets (swell=live-captured defaults), UI HUD (compass+knots plaque),
procedural audio (wired, unheard), clouds (agent-verified, user NOT signed off).

GATED/OFF:
- `postParams.enabled=false` — GTAO/bloom/vignette pipeline built
  (src/core/postPipeline.ts) but froze renderer pre-B5; RE-TEST now that B5
  fixed (likely innocent, like shadows were).
- Water receiveShadow inert — ocean went unlit wrap-lit (MeshBasicNodeMaterial)
  to kill white sheen; ship shadow on water needs custom shadow sample or wait
  for T30 planar reflections. User decision pending.

BUILT, NOT WIRED: underwater mode (src/underwater — buildPost conflicts w/
postPipeline, unify), deck water (T31: bow-sensor → splash(), deck material
hook), island (src/island createIsland — add to scene + buoyancy heightAt
merge), combat chain (input Space → fireCannon → hitTest → applyHitDamage →
flooding: ALL modules exist, main.ts wiring missing), enemy AI (intents →
sailing/cannon consumers), UI pause flow (Esc untested in-browser).

## Multi-agent workflow that worked

- Fan out per-directory owners (src layout = ownership map); agents NEVER
  touch main.ts/other dirs; main thread wires integrations.
- Browser-verifying agents: own dev-server port + own chrome tab
  (tabs_create_mcp), screenshot-iterate, V22 exit = visual parity not tsc.
- Resume agents by ID w/ user feedback verbatim; they keep context.
- Concurrent-edit noise: tsc/vitest failures in OTHER agents' dirs are
  expected mid-flight; filter by path, verify at sync points.
- ONE dev server when possible — parallel HMR reload storms churn GPU.

## Trap ledger (short form; full in SPEC §B + docs/transcript-learnings.md)

- TSL chained `.mix(b,t)`: receiver = FACTOR. Functional mix/smoothstep only (V23).
- `linearDepth()` normalized 0..1, NOT meters — scale by camera.far (B3).
- Any time-animated shader term needs per-position phase or whole ocean pulses (B4).
- NaN → particle scale → additive fullscreen quads = GPU-process wedge that
  looks like a Chrome hang (B5). V28 checklist for all new GPU code.
- Sailing/buoyancy/yaw split contract: sailing owns yaw+heel-offset+pitch-
  preserve; buoyancy owns pitch/roll dynamics, skips w[1] (B6).
- CpuOcean must track spectrum signature or physics floats on stale sea (B7).

## User's open critique list (V22 signoff NOT given on anything hero)

1. Ocean ~80-85% parity: evening glint-train shot pending; foam coverage may
   want bias 0.5→0.55; grazing desaturation under white sky.
2. Sails: structure improved but user hasn't re-reviewed; "unstructured" +
   self-shadow visibility to confirm sun-side.
3. Wake: much better; V-arm readability near hull still weak; "heaving water
   out" feel wanted.
4. Sky: "blown out white" overhead per user — haze retune vs zenith; sun disc
   rarely visible; wants sun reflection path on water (transcript: planar).
5. Vision range: "looking into the abyss immediately" — dispFade 350-900m +
   fog 900-4200 still reads short; consider extending displaced grid or
   displacement fade far out + LOD.
6. Fog/smoke/impact FX prep for combat (not started).
7. Terrain/beaches: built (src/island, src/terrain) but never seen in-game.

## Reference images

docs/final-full-result.png (PRIMARY ocean), -2.webp, -3.png (ship+scene),
ship-full-view/reference-schema/side-sails-fully-reefed.png (ship),
ocean-foam-*.png (foam), flows*.png (wake), clouds*.png. Underwater refs
still only in old chat — ask user to drop as docs/underwater-*.png.

## Immediate next actions (priority order)

1. Re-test post pipeline (flip postParams.enabled default) — AO grounds ship.
2. T30 planar reflections (biggest ref gap, V26) — agent w/ browser loop.
3. T31 deck water wiring + T29 underwater unify w/ postPipeline.
4. Island into scene (+ shallows tint hook in ocean material awaits seabed depth).
5. Combat wiring (Space→fire→damage→holes→flooding→sink) + enemy AI ship.
6. User signoff pass on ocean/clouds/ship/wake (V20/V22), then T22 polish/T23
   perf (GPU timestamps for V17) / T24 acceptance.
