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
- input/freecam: `C` toggles free↔follow. Free: WASD fly view-axes, R/F rise/descend, Shift fast ×12, Ctrl slow ×0.1, mouse look, wheel = travel speed. Free swallows WASD/R/F in capture phase (⊥ leak to rudder); keyup never swallowed; Q/E sail trim still live. Free ⊥ ship-relative → no snap-back by construction; dives to `freeMinY` −300m.
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
V13: ship = piece graph (hull segments, planks, masts, yards, rails; optional parent links → detachable subtrees) + named sockets (rope anchors, cannon mounts, damage zones, fixtures). Destruction ops only via piece graph ops.
V14: cannonball hit → damage zone swap intact→holed piece + splinter burst; hole below waterline → flood rate↑; flood ≥ cap → sink sequence. Mast hit ≥ threshold → mast piece detaches, ropes re-solve (V12 handles).
V15: enemy AI: state machine (patrol→engage→broadside→flee) reads/writes SimState only, tick-rate = sim tick.
V16: ∀ tunable ∈ params module & appears in Tweakpane. Shader literal consts ⊥ (except math consts π etc).
V17: frame budget @ ref GPU: compute total ≤ 4ms, render ≤ 8ms. Perf HUD shows per-pass ms; regression > 20% = bug.
V18: piece meshes swappable: piece contract = {id, socket transforms, damage states, AABB}. AI-gen mesh drop-in ⊥ code change outside ship/pieces data.
V19: ocean FFT ≥ 3 cascades (≈250m/60m/15m domains), ≥ 512² each, independent choppy+Jacobian per cascade. Visible tiling @ any demo camera ⊥.
V20: ocean visual bar = reference parity: side-by-side vs `docs/final-full-result.png` (primary, in-game SoT), `docs/ocean-foam-result.png` + talk footage. ! match: turquoise SSS glow thru crests, dense sun sparkle glints, warm-tinted foam, atmospheric haze on distant islands. "good enough / later" ⊥ — user signs off ocean before T22 polish counts done.
V21: game UI: AAA pirate theme, designed w/ frontend-design skill — cheap clipart/templated look ⊥. DOM overlay reads settings store; Esc → pause (sim tick halts, render continues); settings survive reload.
V22: ∀ visual system (ocean, clouds, sky, ship, foam, terrain, ropes, fx): agent/code done ≠ task done. Task `x` ! requires in-browser screenshot check vs refs; hero visuals (ocean, clouds, ship) ! user signoff. Unit tests + tsc alone ⊥ sufficient.
V23: TSL chained math w/ reordered args (`a.mix(b,t)` → receiver=FACTOR via mixElement) ⊥. ! use functional forms `mix(a,b,t)`, `smoothstep(e0,e1,x)` for 3-arg math. Chained `x.smoothstep(e0,e1)`/`x.step(edge)` OK (receiver=x) but ! comment the reading at use site.
V24: water transparency (refs docs/underwater-*.png): near-surface see-through — submerged geo visible, tinted by depth (turquoise→deep teal, exp falloff), screen-space refraction distortion via scene color+depth textures. Opaque-wall water @ grazing/shallow view ⊥.
V25: underwater camera: submerged → full-screen underwater grade (teal exp fog by dist, desat blue-green, soft god-ray fake OK, slight view wobble), waterline crossing → split view w/ meniscus band, no pop. Weather/day-cycle drive underwater tint too.
V26: ocean reflections = PLANAR (mirrored scene pass: ship, islands, clouds visible in water) per talk 03:59 — SSR ⊥, analytic-sky-only ⊥ final. Reflection res ≤ half, blur ok, fresnel-blended.
V27: deck water = event-driven per talk 11:12: bow-immersion sensor (immersion+speed gates, same signal as bow spray) → splash() injection; runs for player ship only (1 ship budget). Passive always-on splashing ⊥.
V28: GPU safety: ∀ shader division ! floored divisor (`.max(ε)`); ∀ dispatch count & buffer size from sanitized construction-time ints; ∀ caller-fed uniform ! finite-guarded; dead/invisible particles ! zero-size (no opacity-0 rasterization). TSL Loop ! literal bounds.
V29: compute-written storage buffer sampled by render ! SEPARATE read-only view (`storage(buf.value,type,count).toReadOnly()`). `.toReadOnly()` on the write-side node ⊥ — setAccess returns `this`, mutates the shared node, compute writes then compile vs a read-only binding & vanish SILENT (no error, no NaN, buffer stays 0). ∀ new compute→render buffer ! one browser readback proving non-zero.
V30: ocean view = open 360° horizon, ≥ ~4km readable sea. Visible world-edge/cutoff ⊥, fog wall ⊥, "square of water" ⊥. Displacement/normal fades ! ride LOD, never end in a hard ring.
V31: colors authored sRGB (hex/params) ! enter via `new THREE.Color(hex)` or `setRGB(r,g,b,THREE.SRGBColorSpace)`. Bare `setRGB(r,g,b)` / `new THREE.Color(r,g,b)` ⊥ — writes LINEAR working space w/ no transfer fn → ~2× too bright + desaturated, silently. Applies ∀ color: material, light, fog, uniform.
V32: sky background ! camera-anchored @ infinity (`scene.backgroundNode`, depth off). Finite world-fixed dome ⊥ — ship travels unbounded, so any radius eventually clips vs camera.far (→ clear-color void cone) or is exited entirely (→ pale ball). Fog far ! saturate exactly where water ends: earlier = haze wall (V30), later = hard water/sky seam.
V37: closed-hull proof = weld shell pieces → count tris per edge. Edge used once = open boundary; only legit boundary is the top rim. ! also assert consistent winding (a flipped strip reads exactly like a hole). Containment/silhouette sweeps ⊥ sufficient — they prove pieces sit inside the outline, not that the surface is closed. Mating pieces ! SHARE their sampling constants; two polylines through one curve w/ different sample points agree only at the ends.
V38: procedural relief ! surface-gradient method on screen-space derivs of the height (one eval). three's `bumpMap()` ⊥ w/ procedural nodes — it re-samples its TEXTURE at UV+dFdx(UV), so a procedural node returns the same value 3× → zero gradient → no relief, NO ERROR. ∀ height field feeding it ! C0-continuous: any `step()`/per-tile constant spikes to a 1px line under differentiation.
V40: WebGPU per-stage resource limits ! REQUESTED at device creation (`requiredLimits`), clamped to `adapter.limits`. Defaults are low (16 sampled textures/stage) and the ocean material is far past that. Overrun = CreateBindGroupLayout fails → invalid pipeline → the render pass aborts: material never draws, and the console error names the DESCRIPTOR, not the feature that added the 17th texture. ∀ new sampler added to a big material ! recount.
V39: perf numbers ! measured via `renderAsync()` + `device.queue.onSubmittedWorkDone()`. rAF-derived fps ⊥ in an automated tab: Chrome suspends rAF entirely when `document.visibilityState === 'hidden'` (measured: 0 callbacks/10s; a screenshot forces ~3), so frame time goes content-INDEPENDENT and reads as a catastrophic regression. Tell: hiding 1M tris barely moves the number. Cost of an occluder can be NEGATIVE (ship = −1.06ms: hull fragments are cheaper than the sea they cover).
V35: ref GPU (Apple Silicon) = TILE-BASED DEFERRED. Index buffers ! row-major/spatially-local. Front-to-back "early-Z" primitive ordering ⊥ — consecutive tris landing in different screen tiles forces the tiler to hold every tile's prim list open → frame 1 never completes, reads as a browser hang. Immediate-mode raster optimisations ! assumed to transfer.
V36: ∀ crest/foam/SSS threshold ! expressed as a multiple of live sea σ (`heightRms`, published by the ocean & refreshed on spectrum rebuild). Absolute metre gates ⊥ — they silently change meaning when the spectrum moves (a 0.25m gate meant top 9% of the sea, later 36%). `amplitude` ⊥ as normaliser: it fell 0.75→0.32 while Hs ROSE 2.3→2.8.
V34: caustics ! derived from the LIVE FFT surface (divergence/Jacobian of refracted sun rays), projected along the refracted sun direction & depth-attenuated. Tiled scrolling caustic-texture loop ⊥ ("nasty loop look"). Receivers: hull @ waterline, seabed shallows, beach. ! reuse the existing per-cascade Jacobian/derivative data — a second full-res surface eval ⊥ (V17).
V33: ship orientation single-owner (was §B.6, promoted after 2nd near-miss): sailing owns yaw ANGLE **and** yaw RATE (`angularVelocity[1]`) + heel-as-offset, and ! preserve buoyancy's pitch (Tait-Bryan decompose). Buoyancy owns pitch/roll dynamics & ⊥ write `angularVelocity[1]` at all — even decay/smear. Physically free: vertical probe forces give `cross(r,[0,f,0]).y ≡ 0`, flood-list torque y-free. Silent overwrite = helm's built-up turn bleeds away.

## §T TASKS
id|status|task|cites
T1|x|scaffold: Vite+TS+three WebGPU, gate page, rAF+fixed-tick loop, SimState store|V1,V2,V3
T2|x|debug shell: Tweakpane auto-bind params modules, perf HUD per-pass timers|V16,V17
T3|~|FFT ocean compute: spectrum gen (Phillips+wind), IFFT passes, 3-cascade displacement+choppy+Jacobian StorageTextures|V4,V19
T4|~|ocean surface mesh+material: clipmap grid, TSL cascade-blend displace, SSS fake, specular+sparkle glints, depth-based color|V4,V5,V20
T5|~|foam sim: Jacobian inject compute, progressive blur ping StorageTextures, crest/soft tex blend|V6
T6|~|weather presets: calm/swell/storm param sets, wind vector, storm foam bias|V7
T7|x|buoyancy: CPU spectrum mirror or readback, sample heights @ ship probe points, float+righting torque|V8
T8|~|proc ship: piece graph gen, 2 classes (galleon 3-mast per docs/ship-*.png + brigantine 2-mast), sockets, sail states, wood PBR tri-planar|V13,V18
T9|~|sail+steer: rudder, sail trim vs wind, ship kinematics on water|V2,V8
T10|x|camera: follow+orbit, deck walk optional later|-
T11|~|ropes: catenary compute + instanced render, anchor @ sockets, re-solve on mast move|V12,V13
T12|~|deck water: Mei 2-pass compute 512x192, rotation bias, wet material hook|V9
T13|~|intersection foam: depth mask in water material, advect+accum compute, flowmap noise tex|V10
T14|~|clouds: core billboards/geo → 4ch RT, depth-scaled blur compute, frustum quad + distort cubemap|V11
T15|~|sky+light: day cycle, sun/sky params, tonemap, fits painterly look|V16
T16|~|cannons: aim, fire, ball ballistic in sim, muzzle fx|V2,V3
T17|~|destruction: damage zones, piece swap holed, splinters, mast break + rope re-solve|V13,V14,V12
T18|.|flooding+sink: hole-below-waterline ingress, list/trim, sink sequence|V14,V8
T19|~|enemy AI ship: state machine, broadside logic, uses same ship systems|V15
T20|~|island: heightmap terrain, rock intersection foam, waterfall plane w/ flow foam|V10
T21|x|audio: waves, creaks, cannon, ambience (howler or WebAudio thin)|-
T22|.|polish pass: LUT/grade, vignette, foam art tex, param tuning vs talk footage|V17
T23|.|perf pass: budget audit, pass timings vs V17, resolution scaling knob|V17
T24|.|ocean acceptance: side-by-side capture vs reference PNGs+footage, iterate until user signoff|V20
T25|~|game UI: pause menu (Esc), settings screens (graphics res-scale/quality, audio volumes), HUD frame — frontend-design skill, pirate AAA theme|V21,V16
T26|~|palms+vegetation: proc palm geo, TSL wind sway (trunk+frond flutter), instanced scatter API|V16
T27|~|terrain materials: stylized tri-planar rock, sand/beach w/ shore blend + sparkle, proc noise texs|V16
T28|~|water transparency: depth-tinted see-through + screen-space refraction in surface material|V24,V20
T29|~|underwater mode: submersion detect, underwater grade, waterline split + meniscus|V25
T30|~|planar water reflections: mirrored scene RT, half-res, fresnel blend in surface material|V26,V20
T35|.|SPEC'D ONLY, POSTPONED (user): ray-traced reflections/GI as an optional quality tier above T30 planar. Eval WebGPU RT availability in three; must stay opt-in, planar = default path|V26,V17
T34|~|ship detail pass: plank geo w/ real gaps+thickness (⊥ painted lines), chamfered edges (90° arrises ⊥), mast taper/hoops rework, midship rail height, stern rails, quarterdeck stair, stern cabin windows, pennants/flags, fine fittings. METHOD: hero side + full shot side-by-side vs docs/ship-full-view.png + ship-reference-schema.png, enumerate every missing element, then close the list. "Ultra regular everywhere" ⊥ — variation/asymmetry/wear ! present|V13,V18,V20,V22
T33|~|shoreline: island scatter into scene, seabed depth field → ocean shallows tint + buoyancy merge, wave runup/lapping foam on beach, wet-sand band|V10,V34,V30,V8
T32|~|caustics: refraction-Jacobian caustic map from live FFT surface, sun-angle projected onto hull waterline + seabed/shallows/beach|V34,V20,V17
T31|~|deck water wiring: bow sensor → splash(), stateTexture → deck material wet hook, ship-rotation tilt feed|V27,V9

## §B BUGS
id|date|cause|fix
B1|2026-08-11|sky dome brown: `a.mix(b,t)` chained TSL = mixElement(t,e1,e2) → receiver read as factor, blend inverted+washed|V23
B2|2026-08-11|ocean sparkle 88% dense not 12%: `x.step(0.12)` = step(edge=0.12,x) — edge/x order misread|V23
B3|2026-08-11|water transparency mint-wash: linearDepth normalized 0..1 treated as meters — absorption meaningless|-
B4|2026-08-11|3s global ocean pulse: sparkle twinkle shared one time phase — all cells flipped in sync|-
B5|2026-08-11|GPU wedge: spray life=0 → 0/0 NaN age → NaN-size additive quads ×4096 = fill-rate hang; also dead particles rasterized at sizeMax|V28
B6|2026-08-11|ship never pitched: sailing recompose = pure yaw∘heel, erased buoyancy pitch 60×/s; fixed: Tait-Bryan decompose preserves pitch, heel=offset, yaw single-owner|-
B7|2026-08-11|ships floated on launch-time sea: CpuOcean never rebuilt h0 on param change while GPU did → V8 divergence under weather|-
B8|2026-08-11|`.toReadOnly()` mutates shared StorageBufferNode (setAccess→`this`, no clone) → render-side view downgraded the compute's WRITE binding → ropes invisible many sessions (mesh.count=768, descs uploaded, points all-zero) + whole spray pool frozen @ buffer-zero. Silent: no error, no NaN|V29
B9|2026-08-11|sky/sun/hemi/fog all washed white-grey: `setRGB(r,g,b)` + `new THREE.Color(r,g,b)` write the LINEAR working space, so sRGB-authored params entered ~2× bright & desaturated. Fog inherited it → far water whited out too|V31
B14|2026-08-12|audio dead silent, no error: `attachGestureResume(engine)` called `engine.resume()` (unlocks AudioContext only) instead of the OUTER `resume()` that builds bed/ship/loader. Post-gesture `ctx.state==='running'` so `update()` passed its guard, then every layer was `bed?.update()` on a permanent null. 5th silent no-op this project|-
B13|2026-08-11|hull open to interior 2 ways: (a) transom cap sampled its curve in 10 even steps vs shell's 8 over a different range → polylines agree only at ends → seam gaping ≤0.35m up both quarters; (b) hull had NO BOTTOM — side shells stopped at the keel line leaving a 0.125m slot/side down most of the length. Containment-sweep test passed both: it proves pieces are inside the silhouette, ⊥ that the shell is closed|V37
B11|2026-08-11|"GPU wedge" that killed Chrome tab groups = ocean clipmap index buffer emitted RING-BY-RING (front-to-back, an immediate-mode early-Z win). On TBDR Apple Silicon consecutive tris span all screen tiles → tiler holds every tile list open → frame 1 never completes. Row-major: boots instantly @100.6fps. Same mesh/shader/everything|V35
B12|2026-08-11|"cow pattern" turquoise blotches: `uSssAmbient` added sun-INDEPENDENT SSS colour (green 4.15×, blue 2.78× body) through absolute `smoothstep(0.25,0.95,h)` gate. Meant top 9% of sea when written; after swell retune fired over 36%, saturated 9%. Magic metre constant that silently changed meaning|V36
B10|2026-08-11|phantom pale sphere + black void sky: dome = BackSide sphere r4200 fixed @ world origin, ship sails away → far wall crosses camera.far=5000 → clipped cone renders clear color; past 4200m camera exits dome entirely → far wall reads as one pale ball|V32
