# W6: every boat marks the water (SPEC T195)

Status: code + CPU/transport tests green; browser pass §6. Date: 2026-09-13.
SPEC: §T.195, V100, V101, V104, V105, V108, V110, V2, V28, V40, V77, V80.
USER: "we're missing the wakes and all that from NPCs. Only our boat shows any kind of reaction on the water in terms
of foam or wake or bow displacement or trail." + "bubble trail from the engine blades / rotors is maybe missing. and
rooster tails etc for all boats."

Legend: `[M]` measured in this repo. Tests: `tests/wakeMultiVessel.test.ts`, `tests/simWorkerEffects.test.ts`,
`tests/sprayFleet.test.ts`. Scratch (gitignored): `tests/zzScratchT195Fingerprint.test.ts` (pirate/raft hashes),
`tests/zzScratchT195Numbers.test.ts` (tow numbers).

---

## 1. Source pipeline

```
worker step (stepCore)  HullWater.evaluate ─┬─ OUT pose, contact summary
                                            ├─ OUT FX record (sim-worker/fx.ts writeBoatFx, 61 f64): 4 drives × PropWashInput
                                            │     (+ lossPower, ventAirSpeed) and the WaterlineSpray (param-free)
                                            └─ OUT wake samples (hw.wake, unchanged)
BoatFleet.poll/done     first time a request is seen home: COPY every stepped boat's pose + wake + FX (the request's
                        LAST step) into main-owned `effects(i)` — the driver kicks again in the same pump, so reading
                        OUT later is illegal; the copy is stable until the next request lands
page tick (vesselFx)    hero: writeBoatFx(player.hw) → readBoatFx (the SAME writer the worker runs, V77)
                        rivals: fleet.effects(i), nearest the hero first
                        wakeSim.tick(hero pose, hero samples, stem, dt, hero jets, rivals)   ONE source buffer
                        flowFoam.setPropWash(every jet, hero first)                           ribbon + aeration
                        bow sheet / rooster tail / bubbles: one pool each, camera-priority budget
```

- **Layout v3.** `B.FX = 44`, `B.WAKE = 44 + FX_LEN`; the record is inside the hashed OUT range, so the §V2 hash
  covers it. A layout without it does not exist (the speedboat is the only fleet).
- **Same step as the pose.** A multi-tick request publishes its last row only; the effects carry `tick` = that row.
  `[M]` batched ×4 on main and sab×1 hashes the per-tick source buffer identically to one tick per kick.
- **Transport determinism** `[M]`: 150 ticks × 8 boats, per-tick hash of the WakeSim source buffer (hull + jet data,
  counts, centre) + every bow record: main = sab×1 = sab×2 = transfer×1 = main/4 = sab×1/4.
- **Domain (§V105).** Anchored on the hero's sim pose as before. Rivals: `vesselDomainWeight` — e = distance of the
  footprint (plan radius + 4σ splat reach) from the grid border on the tighter axis; e ≤ 0 → dropped WHOLE (never a
  clipped splat for the periodic FFT to wrap), smoothstep over the sponge band (67 m on 448 m), 1 inside. Weight
  scales fy (x·1 is exact: the hero's samples are bit-identical). At most 8 vessels; a rival whose samples + jets do
  not all fit the 512-source capacity is skipped whole (`vesselsOverflowed`, 0 measured).
- **Outside the domain** a rival draws no surface; its prop ribbons are still laid (the jets are evaluated outside
  the solver window in vessel mode), so the far foam tier carries its trail.
- **§V108 / §V8a.** The wake stays visual-only; no hull reads it, so a hull never reads its own same-tick wake.
- **Anchor note (not changed, T191's call).** The anchor keeps ≈ 300 m astern of the hero and only ~16 m ahead of
  her stem inside the interior; a rival AHEAD of the player sits in the forward sponge band (faded) or outside.
  `bowAhead` is the page's argument: `hull.stemZ + 120` would give ~130 m clear water ahead and ~180 m astern.

## 2. Cost for 8 boats

- **GPU wake:** unchanged dispatch count — 35 dispatches, one group (§V104); the per-boat cost is splat instances
  (≈ 22–38 hull samples + 3 jets per boat `[M]`, ≤ 300 instances of ≤ 11×11-texel quads). Browser numbers §6.
- **CPU:** the effects copy (≤ 8 × (13 + 61 + 5·38) f64 per collect), the hero FX write, one sort of ≤ 7 rivals, the
  source push, three emitter allocations (≤ 24 jets). No allocation in the hot path beyond the sort array.
- **Worker:** `writeBoatFx` per boat per tick — the prop adapter (3 drives) + one pass over ~73–97 waterline segments.

## 3. Foam per boat (flowfoam simFoam VESSEL MODE)

On by default where a page carries prop jets (`FlowFoamOptions.vessels = WAKE_MAX_VESSELS` when `propJets`; the raft
and pirate build the single-hull graph, bit-identical — §5).

- **Churn at each hull's own velocity.** One head field, several hulls: per texel g_i = exp(−d²/2R_i²), hull velocity,
  lift and depth = Σ g·(·)/Σ g, the hero's burial plane × her share g₀/Σg (`blendVessels`, CPU + TSL one expression).
  Without it a rival's head was advected at the HERO's velocity — a rival running the other way laid its bury foam at
  its transom `[M]` (test).
- **Prop ribbons for every drive of every boat:** 8 × 3 = 24 jet slots, each behind a bounding test
  (`jetInReach`: 60 m along, ±4 half-widths across — stated truncation).
- **Aeration (the bubble trail).** `propWash.aerationSpeed` = η_e·imm·P_loss/(ρgAD) + χ·P·|n|:
  - turbulent: P_loss = |2πnQ| − |T·U_a| from the §T.189 engine model (propTorque, propRps), η_e = 0.3
    (Lamarre & Melville 1991, air entrainment share of dissipation — ASSUMED to carry to a slipstream);
  - ventilation: χ = 1 − (1 − 4·imm(1−imm))·v(J), v = `engine.ventilationFactor` (hole shot 0.55 → 1);
  - ribbon drive += `AERATION_SHARE` (0.033, the one look number) × u_air.
  `[M]` tow: 40 m/s WOT u_air 94 m/s → drive 3.1 (lifted jet 0.08) ⇒ ribbon dose ≈ 0.35·3.1·18/40 ≈ 0.5;
  25 m/s WOT 2.2; 15 m/s @ 0.6 throttle 0.43; 8 m/s @ 0.4 0.08; throttle 0 (neutral) exactly 0.
- **No ocean hook added** (no new fragment sampler, §V40): the aeration is foam (.r) + slick (.g) the surface
  already reads. A turquoise under-tint would need the ocean owner (§7).

## 4. Spray per boat

One pool each, emitter slots by camera distance, budget = pool count / life (`sprayMath.prioritiseEmitters`: nearest
first, a far rival starves before a near one thins).

- **Bow sheet** (`createBowSprayFleet`, 8 slots, 4096): emission `liftedFluxEmission` (the rule `bowContactEmission`
  now shares) of `waterlineSprayEmission` — Σ v_n·min(D, v_n²/2g)·Δl over the contact's REAL waterline segments
  (`hw.waterline`), so a planing hull's spray root lifts water. Launch from reflection off the stagnation line:
  forward 2v_n²/U, outboard 2v_n√(1−(v_n/U)²), up v_n·sheet. `[M]` 40 m/s: flux 1.49 m³/s, v_n 1.66 m/s, 305/s,
  outboard 3.3 m/s, forward 0.14 m/s — the wings, left behind as she runs off.
- **Rooster tail** (`createRoosterTail({ maxJets: 24, count: 2048 })`, viewer-prioritised). Physics unchanged: only a
  surface-piercing prop throws one. `[M]` calm-water tows: every prop 0.42–1.0 m deep ⇒ rate 0; rooster tails appear
  when props ventilate (swell, jumps, hard turns).
- **Prop bubbles** (`createPropBubbles`, 24 jets, 4096): BUBBLE_PER_M3 · A · share · u_air per prop, buoyant rise
  0.12 m/s against drag, 1.6 s, turquoise-white, 25→80 m fade. `[M]` WOT 783/s per drive, idle-off 0.

## 5. Pirate / raft bit-identity

`tests/zzScratchT195Fingerprint.test.ts`, before any edit vs after (sha256, canonical WGSL): analytic flowfoam
(226 388 B), raft sim flowfoam (39 passes, 294 556 B), bow spray legacy + contact, default rooster tail, crest
spray, raft CPU (WakeSim sources + simFoam CPU twin over a tow): all 7 identical. Raft seaFrame
(`zzScratchSeaFrameHash`): sim hash identical; wiring log identical except `shoalAsymmetryHarmonicCap` 0.25 → 0.95
in the logged ocean params (the ocean session's params edit, not T195).

KNOWN RED, NOT T195: `tests/wakeFoamSim.test.ts` §5 pin (219 518 B) — the analytic flowfoam graph already compiled to
226 388 B before any T195 edit (the uncommitted `accumulation.ts` source-duration/history change of another session).
Its owner must re-pin deliberately. T195 adapted the four tests that assumed one compute call per pass (the same
change batches [advect, blur]).

## 6. Browser

Headless Chrome (`--headless=new`, WebGPU/Metal, CDP, 1600×900), `speedboat.html?autopilot`, the calm Tower Reach
race, served by a Vite dev server with HMR and watching OFF (other sessions' edits reloaded the first run's page
mid-race). The T191 wiring was emulated at runtime (patched `frame.tickBoat` to call `vesselFx.tick` after the
page's own calls, whose hero-only wake/prop-wash calls were suppressed; the page's rooster tail hidden). Scripts and
shots: scratchpad `t195/shoot.mjs`, `t195/shots/`.

- **Seen:** every rival lays its own white trail (01/03/07 chase and 3/4 views, 06/11 overhead: three separate
  trails, a lone rival's ≈ 60 m trail at 300+ m from the player); churn at the rivals' gearcases (05, 08).
  Domain: 8 vessels taken at the start and in the pack; rivals 250–600 m away culled (`culled` 4–5) — their prop
  ribbons still trail on the far tier.
- **Not distinguishable in the shots (stated):** the rooster tails (granted 5–45 particles/s: calm water, props
  0.4–1.0 m deep — the model throws none there) and the bubble sprites (pool budget-capped at 2560/s but not
  separable from the foam at these camera distances). The bow sheet pool ran budget-capped (5057/s) in the pack.
- **GPU** (`renderer.info.compute.timestamp`, all compute of the frame incl. ocean FFT and foam, median of 60
  frames, alternated twice, pack of 8 in the domain): page path (hero only) 10.4 / 6.8 ms; T195 wake + foam with 7
  rivals (sprays hidden) 5.4 / 6.3 ms; T195 full (+ bow, rooster, bubble pools) 9.6 / 13.6 ms. Frame-to-frame noise in
  headless Chrome (±4 ms) exceeds any wake-source delta: the wake's 35 dispatches are unchanged and 8 boats add only
  splat instances. The spray pools are NOT shown to fit a budget by this measurement; a timestamp per pass is §7.
- **Anchor seen:** the pace boat start puts rivals ahead of the player; with the default `bowAhead` they sit in the
  forward sponge band until the player passes (§1 note).

## 7. Open

- Per-pass GPU timestamps for the three spray pools and the 24-jet flowfoam graph (the frame-total numbers in §6
  cannot resolve them).

- T191 wiring (`page/speedboatFrame.ts`, `page/speedboatScene.ts`, `main-speedboat.ts`) — lines in the T195 report.
- Ocean owner: an under-surface tint for aerated water would read the same foam/slick texels (no new sampler).
- `hullWater` (T189): nothing new required; the adapter reads `engines[k].propTorque/propRps/advanceRatio` and
  `params.engine` (public).
