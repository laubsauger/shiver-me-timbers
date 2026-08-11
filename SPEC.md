# SPEC

## §G GOAL
Web pirate combat demo (SoT-class water/sky/ropes/destruction) @ WebGPU three.js TSL. Company showcase — visual bar high.

## §C CONSTRAINTS
- three.js `WebGPURenderer` + TSL only. WebGL path ⊥. No fallback code.
- Shaders in TSL nodes; raw WGSL only where TSL can't (FFT butterfly OK).
- Desktop Chrome/Edge/Safari-26. 60fps @ 1440p, Apple Silicon / discrete GPU ref.
- TypeScript + Vite. No game engine libs. Physics hand-rolled (buoyancy, projectile) — no ammo/rapier unless task says.
- Modular files: 1 system = 1 dir, file ≤ ~250 lines soft cap. Shader chunks own files.
- All tunables ∈ `params/*.ts` modules → Tweakpane debug panel. Magic constants in shaders ⊥.
- Sim deterministic & serializable (multiplayer later): fixed timestep, seeded RNG, sim state plain-data store.
- Ships procedural, destruction-first (modular pieces). Later AI-gen mesh swap ! keep same socket/piece contract.
- Heavy sims = compute passes (`Fn().compute()`), storage buffers/textures. Frag-shader ping-pong GPGPU ⊥.
- Ref doc: `docs/handoff.md` + PNGs. YouTube talk y9BOz2dFZzs = ground truth for look.

## §I INTERFACES
- app: `npm run dev` → Vite @ localhost, single page canvas.
- gate: no WebGPU → static "WebGPU required" page, zero crash.
- input: WASD/mouse sail+steer, camera orbit+follow, Space fire cannon, Tab debug panel.
- debug: Tweakpane — ∀ params/* groups, weather presets (calm|swell|storm), perf HUD (fps, ms per pass).
- file: `src/params/*.ts` — one module per system, typed, hot-reload.
- state: `SimState` plain JSON-serializable object — ships, wind, time, seed, projectiles, damage.
- assets: `assets/` textures (foam crest/soft, flowmap noise, cloud distort cubemap, wood PBR). Procedural where possible.
- src layout: `src/core|ocean|foam|deckwater|flowfoam|clouds|ropes|ship|sea-physics|combat|ai|sky|params|debug|state|ui`.
- ui: DOM overlay (no canvas UI) — HUD, pause menu (Esc), settings: graphics (res scale, quality), audio (master/sfx/ambience volumes). Settings persist localStorage.

## §V INVARIANTS
V1: WebGPU absent → gate page, console clean, no exception.
V2: sim tick fixed 60Hz, decoupled from rAF. Same seed+input log → identical `SimState` hash.
V3: render reads `SimState`, ⊥ writes it. One-way data flow sim→render.
V4: ocean = Tessendorf FFT spectrum → compute IFFT → displacement+choppy StorageTexture. Geo high-freq kept; style from shading only.
V5: SSS fake: choppiness mask × dot(L,V) boost on wave sides. No physical SSS.
V6: foam: Jacobian det < bias → inject foam RT; RT progressive-blurred ∀ frame; blurred mask mixes crest-tex → soft-tex.
V7: storm preset → amp↑ & Jacobian bias↓ → big foam patches. Weather presets only touch params, no code path change.
V8: buoyancy samples same FFT displacement data GPU wrote (readback or CPU mirror of spectrum) — ship float matches visible waves, drift ⊥.
V9: deck water: Mei 2-pass (outflow biased by ship rotation → inflow+resolve), B=volume G=wetness, evap const/frame → deck dries. Deck material roughness↓ where wet.
V10: intersection foam: depth-compare in water TSL material → mask RT → advect by flowmap + blur, accumulate prev frame. Works ∀ hull waterline + rocks.
V11: clouds: fwd-render cores → RT (sunlight R, skylight G, alpha B, depth A per clouds-channels.png) → depth-scaled blur compute → camera-pinned quad + distortion cubemap. Raymarch ⊥.
V12: ropes: 1 compute thread = 1 rope, catenary f(A,B,L) solved in WGSL, verts → StorageBuffer → instanced/batched mesh. CPU per-frame rope math ⊥.
V13: ship = piece graph (hull segments, planks, masts, yards, rails) + named sockets (rope anchors, cannon mounts, damage zones). Destruction ops only via piece graph ops.
V14: cannonball hit → damage zone swap intact→holed piece + splinter burst; hole below waterline → flood rate↑; flood ≥ cap → sink sequence. Mast hit ≥ threshold → mast piece detaches, ropes re-solve (V12 handles).
V15: enemy AI: state machine (patrol→engage→broadside→flee) reads/writes SimState only, tick-rate = sim tick.
V16: ∀ tunable ∈ params module & appears in Tweakpane. Shader literal consts ⊥ (except math consts π etc).
V17: frame budget @ ref GPU: compute total ≤ 4ms, render ≤ 8ms. Perf HUD shows per-pass ms; regression > 20% = bug.
V18: piece meshes swappable: piece contract = {id, socket transforms, damage states, AABB}. AI-gen mesh drop-in ⊥ code change outside ship/pieces data.
V19: ocean FFT ≥ 3 cascades (≈250m/60m/15m domains), ≥ 512² each, independent choppy+Jacobian per cascade. Visible tiling @ any demo camera ⊥.
V20: ocean visual bar = reference parity: side-by-side vs `docs/final-full-result.png` (primary, in-game SoT), `docs/ocean-foam-result.png` + talk footage. ! match: turquoise SSS glow thru crests, dense sun sparkle glints, warm-tinted foam, atmospheric haze on distant islands. "good enough / later" ⊥ — user signs off ocean before T22 polish counts done.
V21: game UI: AAA pirate theme, designed w/ frontend-design skill — cheap clipart/templated look ⊥. DOM overlay reads settings store; Esc → pause (sim tick halts, render continues); settings survive reload.

## §T TASKS
id|status|task|cites
T1|x|scaffold: Vite+TS+three WebGPU, gate page, rAF+fixed-tick loop, SimState store|V1,V2,V3
T2|.|debug shell: Tweakpane auto-bind params modules, perf HUD per-pass timers|V16,V17
T3|.|FFT ocean compute: spectrum gen (Phillips+wind), IFFT passes, 3-cascade displacement+choppy+Jacobian StorageTextures|V4,V19
T4|.|ocean surface mesh+material: clipmap grid, TSL cascade-blend displace, SSS fake, specular+sparkle glints, depth-based color|V4,V5,V20
T5|.|foam sim: Jacobian inject compute, progressive blur ping StorageTextures, crest/soft tex blend|V6
T6|.|weather presets: calm/swell/storm param sets, wind vector, storm foam bias|V7
T7|.|buoyancy: CPU spectrum mirror or readback, sample heights @ ship probe points, float+righting torque|V8
T8|.|proc ship: piece graph gen (hull/masts/yards/rails/planks), sockets, wood PBR tri-planar|V13,V18
T9|.|sail+steer: rudder, sail trim vs wind, ship kinematics on water|V2,V8
T10|.|camera: follow+orbit, deck walk optional later|-
T11|.|ropes: catenary compute + instanced render, anchor @ sockets, re-solve on mast move|V12,V13
T12|.|deck water: Mei 2-pass compute 512x192, rotation bias, wet material hook|V9
T13|.|intersection foam: depth mask in water material, advect+accum compute, flowmap noise tex|V10
T14|.|clouds: core billboards/geo → 4ch RT, depth-scaled blur compute, frustum quad + distort cubemap|V11
T15|.|sky+light: day cycle, sun/sky params, tonemap, fits painterly look|V16
T16|.|cannons: aim, fire, ball ballistic in sim, muzzle fx|V2,V3
T17|.|destruction: damage zones, piece swap holed, splinters, mast break + rope re-solve|V13,V14,V12
T18|.|flooding+sink: hole-below-waterline ingress, list/trim, sink sequence|V14,V8
T19|.|enemy AI ship: state machine, broadside logic, uses same ship systems|V15
T20|.|island: heightmap terrain, rock intersection foam, waterfall plane w/ flow foam|V10
T21|.|audio: waves, creaks, cannon, ambience (howler or WebAudio thin)|-
T22|.|polish pass: LUT/grade, vignette, foam art tex, param tuning vs talk footage|V17
T23|.|perf pass: budget audit, pass timings vs V17, resolution scaling knob|V17
T24|.|ocean acceptance: side-by-side capture vs reference PNGs+footage, iterate until user signoff|V20
T25|.|game UI: pause menu (Esc), settings screens (graphics res-scale/quality, audio volumes), HUD frame — frontend-design skill, pirate AAA theme|V21,V16

## §B BUGS
id|date|cause|fix
