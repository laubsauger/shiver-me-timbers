# Transcript learnings — talk vs handoff.md vs SPEC vs implementation

Sources: `docs/talk-transcript.md` (verbatim, partial — cuts ~27:54 mid-ropes),
`docs/handoff.md`, `SPEC.md`, and `src/{ocean,foam,flowfoam,deckwater,clouds,ropes}`
plus `src/main.ts`, `src/ship/destruction.ts`, `src/weather/presets.ts` as of 2026-08-11.
Timestamps = transcript lines. Verdict tags: MATCH (impl matches transcript),
PARTIAL, MISSING (not implemented), DIVERGE (implemented differently on purpose).

---

## Confirmed (transcript backs what we built)

- [04:58] FFT ocean per Tessendorf 2001 — V4, `src/ocean/spectrumPass.ts` + `fftPasses.ts`.
- [06:04–06:25] Simplifying wave shape/specular looked worse; keep realistic detail, stylize via shading+foam only — V4 "style from shading only".
- [05:58–06:04] SSS deliberately boosted beyond realistic (handoff §1 already has "artificially boosted") — V5; `surfaceMaterial.ts` has `sssStrength` knob with no physical ceiling. MATCH.
- [06:28–06:43] SSS = choppiness vertex-offset mask × dot(light, view) — V5; `surfaceMaterial.ts` `choppyMask × pow(backlight)`.
- [06:50–07:13] Foam: Jacobian determinant of the transform goes negative → inject pixels into a render target that **tiles across the water surface** — V6; handoff §2 already captured the tiling. Our per-cascade foam StorageTextures wrap/tile with each cascade domain (`foam/index.ts`, `foamPasses.ts`). MATCH.
- [07:13–07:24] Bias the Jacobian down for more foam — `oceanParams.jacobianFoamBias`.
- [07:31–07:49] Foam RT progressively blurred every frame: sharp crest at birth, dissipates over frames — `createBlurDecayPass`.
- [07:49–08:01] High-frequency crest texture blending to low-frequency texture as foam blurs out — `foamShading.ts` detail blend.
- [08:18–08:24] Storm = amplitude↑ + Jacobian biased further — V7, `weather/presets.ts` (params-only patches).
- [09:14–10:43] Deck water: "leaky deck" assumption, heightfield RT (512×192 in handoff; audio garbled at [09:40] "512 by one line two"), two-pass shallow-water sim, outflow biased by ship-surface normal, inflow−outflow resolve, **Blue=water volume, Green=persistent wetness**, per-frame subtraction from both → drains/dries — V9; `deckwater/*` mirrors all of it (R=deck height, G=wetness, B=volume; tilt-biased outflow; evap constants). Module-level MATCH — but see New #5: it is not wired into `main.ts`.
- [10:51–11:05] Normal map from sim modifies deck material (normal, specular, gloss, diffuse) — documented material hookup in `deckwater/index.ts` header.
- [11:56–13:11] Intersection foam via depth comparison: rendered geo distance vs sampled scene depth, close ⇒ mark pixel; free depth occlusion (bridge occluding waterfall) — V10, `flowfoam/intersectionMask.ts` (screen-space + world-space variants).
- [13:25–13:40] Accumulation: additively blend with previous frame, advect, blur — `flowfoam/accumulation.ts` (prev·decay + injection + wake, semi-Lagrangian advect, 3×3 gaussian).
- [14:17–14:31] Ocean-surface variant = traveling window RT around the player, progressively blurred → foam trails behind movers **and** around static geometry like islands — our sliding flowfoam region follows the ship; island rocks straddling the waterline are tagged `foamTarget` (`island/rocks.ts`) and captured by the same system. MATCH.
- [17:24–17:38] Clouds forward-rendered to a small off-screen RT, then blurred — V11 pipeline (`clouds/`).
- [17:45–17:53] Gaussian blur standard deviation scaled by scene/cloud depth — `cloudBlur.ts` `radius = mix(uRadiusNear, uRadiusFar, depthN)`.
- [18:08–18:21] Pack depth+alpha into the RT, leaving two channels for color: R=sunlight, G=skylight — `cloudCores.ts` packs R=sun, G=sky, B=alpha/coverage, A=depth (matches `docs/clouds-channels.png`).
- [18:59–19:15] Camera-frustum-pinned quad held ~500 m out; quad pixel shader is the dominant cost; nearer objects occlude quad pixels — `cloudComposite.ts` `quadDistance: 500` (literally), depth-tested transparent quad.
- [20:10–20:29] View-direction noise lookup for edge distortion; distance-blended noise; clouds fall off toward horizon — composite samples tileable 3D noise by view direction (declared cubemap stand-in). PARTIAL — see New #8g.
- [26:22–26:37] Masts fall when hit by cannonballs — V14, `ship/destruction.ts` (`mastFall` event, detachable subtrees, rope re-solve path).
- [26:51–27:45] Ropes solved as a curve from start point + end point + rope length; "ropes are hyperbolas" (catenary), transcendental so no analytic solution; hyperbolic functions in the shader — V12, `ropes/catenaryMath.ts` (bounded Newton on sinh(z)−rz) + GPU mirror `ropeCompute.ts`.
- [04:13–04:25] "Bottlenecks have primarily been on CPU… offloading work from the CPU onto the GPU" — SPEC §C compute-first philosophy (`Fn().compute()`, storage textures) is the same doctrine.
- [03:34–03:40] UE4 deferred, Xbox One 900p30 reference — recorded in handoff; context for all their timings (see New #10).

## New details not in handoff.md

Each: timestamp · exact claim · does our impl already match · concrete change if not.

1. **[03:59] Planar reflections, not SSR.** "We don't use screen space Reflections, we just use planar water Reflections for the ocean."
   - Impl: **MISSING.** `surfaceMaterial.ts` reflects only an analytic two-color sky gradient (`mix(uHorizon, uZenith, refl.y)`); no scene content (islands, ship, clouds) ever reflects in the water.
   - Change: add a planar reflection pass — mirror the camera about the water plane, render sky+island+ship at ≤½ res into an RT, sample it in the surface material with normal-based UV distortion, fresnel-gated, replacing the gradient-only term. Directly serves V20 parity (reference PNGs show island/ship reflections). See amendment §V26.

2. **[05:58] SSS boosted beyond realistic** — evaluated: already captured by handoff §1; moved to Confirmed.

3. **[06:58] Foam RT "tiles across the water surface"** — evaluated: handoff §2 already has the tiling sentence; our per-cascade RepeatWrapping foam textures are exactly this. Moved to Confirmed.

4. **[08:10] Spray particles from the same crest data.** "We use the same wave crests where we generate foam to generate some particles off the top of the waves."
   - Impl: **MATCH (already, by design not accident).** `foam/spray.ts` respawns particles where the *same* combined cascade Jacobian falls below `jacobianFoamBias + sprayBiasOffset` — one data source for foam and spray, storm density scales free (V7).
   - No change. Worth a V6 footnote so it survives refactors (amendment below).

5. **[11:12–11:26] Deck water is event-driven: "connected up to sensors on the front of the ship which trigger the bow waves when you crash into a wave… and this splashes water onto the deck." Also [11:35]: "we tend to make sure we only do it for a ship at a time." Cost 0.2 ms/ship.**
   - Impl: **MISSING (wiring).** `deckwater/` has a `splash(u, v, amount)` injection queue — the right API — but `createDeckWater` is never instantiated in `main.ts` and nothing calls `splash()`. Meanwhile `foam/bowSpray.ts` already computes the exact sensor (gate = bow `immersionDepth > θ ∧ speed > θ`, from buoyancy data) but feeds only spray particles.
   - Change: instantiate deck water for the player ship; reuse `sprayMath.burstGate` as the bow sensor; when gated, queue `splash()` at bow-region deck UVs with amount ∝ immersion depth; run the sim for the player/nearest ship only. Amendment to V9/T12 below.

6. **[13:25–13:54] Intersection foam pipeline details: additive blend with previous frame + advected + blurred; "only pixels that are marked on screen are updated — that's also a mask we generate during that render target pass"; "the flow map is also scrolled."**
   - Impl: additive-accumulate + advect + blur MATCH (`accumulation.ts`); scrolled flow map MATCH (`flowNoise.ts` `uScrollSpeed`, time-scrolled curl noise).
   - The on-screen-mark update gating is **DIVERGE-by-architecture**: theirs is a screen/UV-space RT so they must gate updates to marked pixels; ours is a fixed 512² world-space window updated wholesale each tick — cost is bounded and tiny, gating buys nothing. No change; note it as a perf lever if the region ever grows.

7. **[14:23] Island foam via the same traveling-window system** — impl MATCH (window follows player; island rocks tagged into the same capture). Not in handoff, but already in V10 ("hull waterline + rocks"). No change.

8. **Clouds — the [17:31]–[24:13] block is almost entirely absent from handoff §5:**
   a. [17:31] *All lighting calculated per vertex* in the forward pass, on solid poly meshes. Impl: per-**fragment** fake-sphere lighting on billboard sprites. DIVERGE (see Contradiction #3). Cost is bounded by the 768×432 RT, so no change required; option noted.
   b. [17:38] *Downsample to quarter res before blur.* Impl: we render cores directly at 768×432 (≈1/11 of 1440p area) — cheaper than render-then-downsample. PARTIAL/spirit-MATCH. No change.
   c. [17:45] *Single-pass compute gaussian.* Impl: two separable compute passes — algebraically cheaper for the same kernel. DIVERGE (fine). No change.
   d. [18:36] *Box blur on the depth channel → flat depth on mid-cloud, doesn't blend off at edges* (needed so the later world-pos reconstruction doesn't bow). Impl: depth (A) gets the same gaussian as color, BUT we store premultiplied depth and recover `depthN = A/B` (coverage-weighted average) — this already resists edge falloff, arguably equivalently. PARTIAL. Re-evaluate only when world-pos reconstruction (h) lands; if edges bow, switch A to a box kernel.
   e. [19:26] *Initial sample of the depth map, discard pixels that cannot possibly contain clouds.* Impl: **MISSING** — composite quad shades every sky pixel including empty blue. Change: first tap blurred coverage (B); `Discard()` below epsilon before the 3D-noise and color work.
   f. [19:44] *Blurred world-space position reconstruction* from blurred depth — too jittery for lighting, used for compositing: fog blend by cloud height, distortion control. Impl: **MISSING** (no world-pos, no fog: `material.fog = false`). Change: reconstruct `worldPos = camPos + viewDir · depthN·maxCloudDist` in the composite and drive haze from it — this is also the V20 "atmospheric haze" requirement for clouds.
   g. [20:19] *Distortion cubemap: LOW-frequency noise in RG, HIGH-frequency in BA, blended by depth.* Impl: single-band 3D value noise, no frequency split, no depth blend. PARTIAL. Change: bake a second, higher-frequency octave into the spare channels and `mix` bands by `depthN`.
   h. [20:35] *Noise killed below a height line so feature clouds (skulls) below the cloud line keep their shape.* Impl: N/A (no feature clouds yet). Record for any future POI-cloud task.
   i. [20:57] *Alpha thresholded by distance → distant clouds sharper, overhead clouds soft/fuzzy.* Impl: **MISSING** — our rim threshold is noise-driven only. Change: `rimT += k · depthN` in `cloudComposite.ts` opacity.
   j. [21:18] *Fogging controlled by world-space position* — same change as (f).
   k. [21:34] *Spyglass FOV zoom: gaussian blur diameter NOT changed with FOV ("that would be expensive"), distortion constant → feature-preserving, holds up.* Impl: **accidental MATCH** — our blur radius is in RT texels, FOV-independent. Free correctness whenever a spyglass/zoom is added.
   l. [22:15–22:52] *Per-vertex baked "bulk of the mass" direction for lighting; intersecting meshes don't know about each other (accepted); the same point-light test does the lightning — a point light whizzing around lighting the cloud surface.* Impl: mass-direction is **accidentally PARTIAL-MATCHED** — each puff carries its unit offset-from-cluster-centre (`dirAttr`), dotted with sun for the sun-side gradient: same idea at puff granularity. Lightning point light: **MISSING** — no lightning anywhere (`grep lightning src` → nothing). Change: storm-preset lightning = transient point light term in the cores material (cheap: one extra dot per puff).
   m. [23:17–23:30] *Rain: a couple of cylinders of rain sheets under the storm, blended with a rain post process inside; artificially punch a hole through the rain sheets in the sun direction ("screenshotable moment").* Impl: **MISSING** — storm preset only patches ocean/sky/cloud params. Change: new task (T31 proposal).
   n. [24:13] *Temporal blending listed as future work* (would allow translucency sorting-free blending). Neither has it; parity with the shipped game. No change.

9. **[26:13–27:54] Ropes block:**
   a. [26:22–26:30] *Players adjust the height of the sails AND the rotation of the sails via rigging.* Impl: `sailTrim` scalar only (furled/reefed/full visual states, thrust efficiency) — **no yard rotation/bracing** anywhere in state, input, or rigging. Change: add brace angle to ship state + input + yard piece transform + rigging re-solve (ropes already re-solve from moved sockets every frame). Amendment to T9 below.
   b. [26:30–26:37] Masts fall on cannonball hit — MATCH (Confirmed).
   c. [27:45–27:54] *HLSL hyperbolic intrinsics; "we're dealing with mesh deformation so we only really need to compute this per vertex."* Impl: **DIVERGE deliberately (better):** one compute thread per rope solves Newton once and writes all samples + tangents to a StorageBuffer (`ropeCompute.ts` header states the rationale — per-vertex would re-solve the same transcendental per sample). Keep; SPEC V12 already encodes our version.

10. **Budgets [08:34, 11:26, 14:37, 22:07] vs V17.** Talk numbers @ Xbox One 900p30 (~20 ms frames when quoted): ocean ≈ **8 ms** when water fills the screen ("by far the most expensive bit"; mostly pixel-shader bound, pay-per-pixel) ≈ 40% of frame; deck water **0.2 ms per ship, one ship at a time**; intersection foam **< 0.1 ms**; clouds **1.3 ms**, again dominated by the composite pixel shader.
    - Mapping to V17 (compute ≤ 4 ms + render ≤ 8 ms @1440p60 on far stronger GPUs): the *proportions* are the transferable signal — ocean surface draw is allowed to dominate the render budget (≈ 4–5 ms of the 8 worst-case fullscreen-water), clouds should stay ≤ ~0.5 ms, deck water + flow foam ≤ ~0.3 ms combined, and both cloud+ocean costs scale with covered pixels (their stated property, and ours).
    - Gap: our perf HUD currently logs only **CPU dispatch** ms (`main.ts` `setPassTiming('ocean+foam cpu-dispatch', …)`) — V17 says "per-pass ms"; GPU timestamps are still owed by T23. Fail-loud note: V17 cannot be *verified* today.

## Contradictions (hard flags)

1. **Ocean reflections.** Transcript [03:59]: planar water reflections (explicitly *not* SSR). handoff: silent. SPEC: silent (V20 implies via reference parity). Impl: analytic 2-color sky gradient only — no scene ever reflects. This is the largest visible divergence from the ground-truth look and is invisible to the current spec text. → amendment §V26.
2. **handoff §6 rope claims exceed the authoritative transcript.** handoff cites a frame at **[28:19]** — *past the 27:54 cutoff* — and asserts "WebGL required running a 20-iteration numerical approximation loop inside the Vertex Shader." The transcript (up to cutoff) never states an iteration count or a WebGL comparison; it says HLSL hyperbolic intrinsics + per-vertex mesh deformation and cuts off at "that horrible equation." Our `CATENARY_ITERATIONS = 20` therefore traces to handoff's extrapolation, not the talk. Harmless (our Newton solve is independently convergence-argued and unit-tested), but handoff must not be treated as transcript-backed for anything ≥ ~27:54.
3. **Cloud cores: billboards were explicitly REJECTED by Rare.** Transcript [16:50–17:09]: the billboard-on-core approach failed style requirements and suffered sorting + overdraw; the shipped approach forward-renders **solid poly meshes with per-vertex lighting** [17:31, 23:52]. handoff §5 says only "cloud core geometry." Our impl uses billboard sprite puffs (`cloudCores.ts`) — with ONE/ONE additive blending (sorting-free) and a tiny RT (overdraw-cheap), sidestepping both stated reasons for rejection. Functionally defensible, but the silhouette character differs from solid-geometry cores; SPEC V11's "core billboards/geo" quietly permits what the source of truth rejected. Flagged for a V20-style visual check of cloud shapes vs footage (T14/V22 signoff should look specifically at silhouettes).
4. **Deck water trigger model.** handoff §3 frames deck water as passive ("when waves crash over a ship, water pools"); transcript [11:12] is explicit that injection is **sensor-triggered** by bow-wave crash events. Our unwired module is compatible with either (splash queue), but any implementation reading only handoff would build passive rain-in, which is wrong.
5. **Repo state (fail-loud, not transcript):** `npx tsc --noEmit` currently fails with 4 errors, all in `src/ocean/surfaceMaterial.ts` (`uRoughness` never declared, `sp.roughness` not in the params type, material type mismatch) on a clean `main`. Pre-existing; surfaced per Rule 8.

## Spec amendment proposals (propose only — main thread is sole mutator)

- **New V26 (ocean reflections):**
  `V26: ocean reflections = planar RT: mirror cam about water plane, sky+island+ship @ ≤½ res, sampled in surface material w/ normal-distort UV, fresnel-gated. SSR ⊥. Analytic-gradient-only ⊥ final (talk 03:59). Cites V20.`
  Plus task: `T30|.|planar reflection pass: mirrored cam RT, clip below waterline, material hookup + distortion|V26,V20`
- **V9 append:**
  `+ injection event-driven: bow sensor (bow immersion>θ ∧ speed>θ, sprayMath.burstGate) → deckwater.splash @ bow deck uv, amount ∝ immersion (talk 11:12). Passive rain-in ⊥ primary. Sim runs player/nearest ship only (talk 11:35).`
  And T12 cites unchanged; add "wire into main loop" to T12 text (module exists, unwired).
- **V11 append:**
  `+ composite: early coverage-tap discard on cloudless pixels (19:26); alpha rim threshold ∝ depth → far sharp / near fuzzy (20:57); world-pos from blurred depth → height fog/haze (19:44,21:18); distort noise 2 bands low+high freq blended by depth (20:19). Blur radius in RT texels — FOV-invariant (21:34).`
- **V6 footnote:** `foam + crest spray share ONE data source: cascade jacobian vs bias (talk 08:10) — spray ⊥ own crest detector.`
- **T9 amend:** `sail+steer: rudder, sail trim (height) + yard brace (rotation) vs wind (talk 26:22), ship kinematics on water` — brace angle ∈ SimState, rigging re-solves on brace change (V12 path already live).
- **New T31 (storm fx):** `T31|.|storm fx: rain cylinder sheets + rain post inside, sun-direction hole punch (23:17-30); lightning = roaming point light term on cloud cores (22:44)|V11,V7`
- **V17 append (budget sanity from talk, scaled):**
  `Talk ref @XB1 900p30: ocean ≈8ms fullscreen (pay-per-pixel), deck 0.2ms/ship (1 ship), int.foam <0.1ms, clouds 1.3ms. Our envelopes: ocean surface ≤5ms of render 8, clouds ≤0.5, deck+flowfoam ≤0.3. HUD ! GPU per-pass timestamps (CPU dispatch ms ⊥ sufficient) — T23.`

## Transcript gaps (cutoff ~27:54)

- **The rope equation itself.** Cuts at "that horrible equation we really" — the actual catenary parameterization slide, whether they use Newton (and how many iterations), an approximation, or direct intrinsics per vertex: unknown. handoff's "[28:19]" frame and "20-iteration loop" claim are unverifiable until the rest of the transcript arrives.
- **Rope rendering mechanics:** batching/instancing scheme, vertices per rope, rope count and ms budget, how "hundreds of rope segments" are drawn — unknown.
- **Sail cloth / flags:** "fun things with vertices" almost certainly continues into sail deformation, wind flutter, flags/pennants — entirely missing.
- **Mast-fall dynamics:** how ropes behave *during* the fall (re-solve cadence, constraints, slack changes) — unknown; our V14 re-solve-on-move is an assumption.
- **Anything after ropes:** wind visuals, character/water interaction, kraken/creature tech, wrap-up, Q&A — unknown.
- Sections already complete in the transcript: intro/context, ocean, deck water, intersection foam, clouds (incl. limitations + future work) — no gaps there.
