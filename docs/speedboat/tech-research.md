# Speedboat mode — tech research & design (vessel physics, crashes, NPC racing, engine audio, camera)

Status: RESEARCH / DESIGN ONLY. No production code. The game design doc (separate agent) must be
signed off before S1. The shared wake sim is designed in parallel in `docs/wake/wake-research.md`.
That file **did not exist** when this was written, so §2.7 states the contract this physics offers it.

Measurements come from scratch scripts that are NOT in the repo (see Appendix B). All numbers below
are node/V8 on the dev machine. Browser numbers need re-measuring in S1 (§V63).

---

## 0. TL;DR — recommendations

| # | Question | Recommendation |
|---|---|---|
| 1 | Rigid body | **New full 6DOF integrator** (`rigid6`): unit quaternion, world-frame momentum, symplectic Euler, implicit gyroscopic term, 2–3 substeps. It owns all 13 ShipState channels for speedboats. Galleon/raft keep the split model untouched. Do not try to extend the split (§1.2). |
| 2 | Hydro | **Hybrid.** Hydrostatics use Kerner's clipped submerged triangles (exact Archimedes, righting from geometry). Lift, slam and heave/pitch damping use **2D+t momentum sections** (Zarnick/Faltinsen: `f = d/dt(m_a·V_n)` + crossflow drag), sampled off the same clipped geometry. Viscous drag is Kerner/ITTC-57. Savitsky is the **test oracle**, not the force model. Porpoising and chine walk are emergent; damp them with assists. |
| 2b | Cost | Prototype: 246-tri deep-V hull, clip + all force terms = **44 µs/call** against a per-boat height patch. `CpuOcean.heightAt` = **2.2 µs** (open sea), **2.8 µs** with seabed+fetch wired. Per full-LOD boat ≈ 0.25 ms/tick at 2 substeps. 8 boats with LOD ≈ 1 ms/tick. |
| 2c | Substeps | 60 Hz is **not enough** at 40–60 m/s: planing heave damping B/m·dt ≈ 1.5 at 45 m/s. Use adaptive N = 2 (≤35 m/s) → 3 (≥50 m/s). The patch is sampled once per tick; forces are evaluated per substep. |
| 3 | Propulsion | Prop at drive location, thrust vector rotated by steer δ and drive trim θ. Engine torque vs prop torque (K_T/K_Q, Wageningen-like) drives an **rpm ODE**. When the prop is exposed, K_Q collapses, so rpm flares on its own; audio reads that rpm. Assist dial 0..1: stability PD, anti-porpoise, air control, slip limiter, landing cap, auto-recover. |
| 4 | Crashes | Swept capsule-chain boat↔boat impulses. Hull points vs `seabed.heightAt` with a gradient normal, as a velocity-level impulse (**not** `grounding.ts`). Crash state machine (capsized / stuffed / blow-over / impact). Respawn at last gate with a teleport contract and 2 s ghost. Move the generic fx (`debris.ts`, `fxMath.ts`, shake) out of `src/combat` to neutral `src/fx` per §V95 before using them. |
| 5 | NPC AI | Racing line = min-curvature elastic band through gate corridors, then a forward/backward speed profile from the **measured** boat turning circle, then pure-pursuit steer + PID throttle. Plus wave-read throttle lift, power-only rubber band (±8%), lateral-offset avoidance, and a difficulty dial. Distant NPCs run on-rails at 20 Hz. LOD keys on **SimState, never the camera**. Move the pure helpers in `src/ai/steering.ts` to `src/core`. |
| 6 | Audio | **Hybrid per boat.** rpm-indexed loop bank (on/off-load crossfade), AudioWorklet firing-pulse layer (one worklet, many voices), ventilation/cavitation noise, and hull slap/hiss from contact data. Doppler via a per-voice DelayNode (distance/c), because WebAudio removed panner doppler. HRTF for the player only, equalpower for NPCs. At most 3 full NPC voices; the rest share one pack drone. |
| 7 | Camera | Chase rig in `src/camera`: heading from smoothed velocity when airborne or tumbling, vertical spring for landing compression, speed FOV, slam shake, crash detach to a world-anchored orbit. `FollowCam` needs a FOV-override hook (it re-asserts `cameraParams.fov` every frame). |

---

## 1. Rigid-body model

### 1.1 What exists (verified)

- `src/sea-physics/buoyancy.ts` is a **split** model.
  - Integrates `position[1]` only (`:818`).
  - Adds planar *force* into `velocity[0,2]` (wave surge, `:707-719`, `:807-809`).
  - Integrates pitch/roll in the body frame with diagonal inertias (`:858-869`) and never writes `w[1]` (§V33).
  - Orientation: `integrateQuat` (private, `:368-378`), then pitch memorised by `asin(forward.y)` (`:873-875`).
  - It also re-injects pitch whenever `|forward.y|<1e-6` (`:437-442`), which is ambiguous for an inverted or vertical hull.
  - Stations: 18 slices × 3-point Gauss–Legendre across the beam (`:135-136`, `params/seaPhysics.ts:299`), all on the y=0 plane with a keel-to-deck body (`:249-254`, §V54).
  - Forces are **vertical only**, so `cross(r,[0,f,0]).y ≡ 0` (`:820-827`).
  - The header admits there is no recovery past 90° heel (`:504-507`).
- `src/sailing/shipKinematics.ts:210` recomposes yaw∘pitch∘roll via `asin(fwd.y)` (valid for |pitch|<π/2). `src/raft/raftShip.ts` uses the same Tait-Bryan split.
- `src/sea-physics/grounding.ts` has three limits:
  - vertical spring per station (`:165`)
  - result capped at `groundingMaxSupport·m·g` (`:180-203`)
  - planar Coulomb friction (`:214-221`), never yaw (`:223-231`)

### 1.2 Why not extend the split

1. Deep-V turning, sway grip, a slip angle (~20° hard turn per Kerner pt 2) and blow-over need hydrodynamic force **normal to the hull in all directions**, including yaw and sway moments. The split forbids buoyancy from producing yaw and gives sailing no hull geometry.
2. Flips need an orientation owner with no ±90° singularity. Two owners (sailing yaw, buoyancy pitch/roll) recombined through Tait-Bryan cannot pass through inversion. Gimbal lock at pitch ±90° is exactly the pose of a blow-over.
3. Tumbling needs the full inertia tensor and the gyroscopic term `ω×Iω`. The split has neither.
4. §V51/§V33 are satisfied more simply by one owner of everything than by a third partner in the split.

### 1.3 Proposed `rigid6` integrator (`src/sea-physics/rigidBody.ts`, engine-free, §V3)

State reuses `ShipState`, so FollowCam, audio feed, flowFoam and hullContact consumers keep working:
- `position` = CG (world)
- `quaternion`
- `velocity` (world)
- `angularVelocity` (world)
- new optional `drive?: { throttle, steer, trim, rpm, gear }` (precedent: `brace?`, `guaraDepth?`)

Per substep h = dt/N:

```
F,τ ← gravity + hullHydro (§2) + propulsion (§3) + aero + assists + contacts (§4)        // accumulate only
v   ← v + h·R·diag(1/(m + A_ii·wet_i))·Rᵀ·F                                              // body-frame added mass
L   ← body: ω_b ← solveImplicitGyro(I_b + ΔI_b·wet, ω_b, h) ; ω_b += h·I⁻¹·τ_b              // Catto GDC'15
x   ← x + h·v ;  q ← normalize(q + h/2·[ω,0]⊗q)                                           // semi-implicit
```

- **Inertia.** Body-frame diagonal from the collision hull mass distribution. Check via §V53: gyradius k_yy/L ≈ 0.25, k_xx/B ≈ 0.35–0.40.
- **Added mass/inertia.** Per §V69, derived from the same section geometry as the 2D+t term (§2.3), not tuned separately. Heave/pitch/roll/sway ramp with wetted fraction. Surge added mass ≈ 0.05 m is constant.
- **Gyroscopic term.** Explicit `ω×Iω` diverges for spinning asymmetric bodies. Use Catto's one-Newton-step implicit form (Box2D v3 / Bullet `computeGyroscopicImpulseImplicit_Body`).
- **Helpers.** Move `integrateQuat` from `buoyancy.ts:368` to `src/core/quat.ts`. There must be one implementation (§V95). Buoyancy would import it: a pure move, behaviour identical.
- **No Euler angles** anywhere in the `rigid6` path. HUD, AI and assists derive `up·Ŷ`, `fwd·Ŷ` and heading from `atan2(fwd.x, fwd.z)`, with a velocity-heading fallback when |fwd_xz| < 0.2.
- **§V51 guard.** `stepShipBuoyancy`, `stepShipSailing` and `stepShipGrounding` must `throw` when handed a ship with `dynamics === 'rigid6'` (fail loud). A test asserts this.

### 1.4 Coexistence

Speedboat page = `rigid6` only. Pirate and raft pages keep the split model, unchanged: diff = 0 in their integrators. The only shared edit is the pure `integrateQuat` move.

---

## 2. Hydrodynamics

### 2.1 Height source: per-boat patch (Kerner pt 1 "water patch")

- `CpuOcean.heightAt` costs 3 × 2 cascades × 16-tap Catmull-Rom for the inverse displacement (`cpuOcean.ts:829-859`), plus the sum.
- Measured (Appendix B):

| Query | µs/call, open sea | µs/call, analytic seabed + fetch |
|---|---|---|
| `heightAt` | 2.19 | 2.84 |
| `pressureHeadAt` | 2.20 | 3.61 |
| `CpuOcean.update` | 1.38 ms/tick | 1.71 ms/tick |
| existing `stepShipBuoyancy` (54 stations) | 0.11 ms | 0.19 ms |

  The real seabed loops over islands (`island/seabed.ts:57-91`), so expect ~4–6 µs in the archipelago.
- Querying ~150 welded hull vertices directly would cost ~0.6–0.9 ms per boat per substep. **Too expensive.**
- **Patch.** Once per tick, sample a hull-aligned grid covering the hull swept over the tick plus a margin: about 16 m × 5 m at ≤ 1.6 m spacing, ~10×4 = 40 samples ≈ 0.15 ms. Vertices then read the patch bilinearly (the prototype's 44 µs includes this).
- **Why this spacing is enough (§V50).** The mirror carries nothing shorter than λ = 8.3 m: `params/ocean.ts:401` splitWavelengths `[40, 8.3]`, and `cpuOcean.ts:6-8` excludes cascade 2. So 1.6 m spacing gives ≥ 5 samples per shortest wave. A hull-aligned patch is valid in any heading.
- **API suggestion.** Add `sampleSurfaceAndHead(x, z, out)` to `CpuOcean`, sharing one `gridCoord` for both fields. That saves ~45% when both are needed (§V77: one expression).
- **Smith depth.** The mirror has ONE Smith depth, `seaP.hullDraft·smithDepthScale` (`cpuOcean.ts:799-801`). The speedboat page must build its mirror with **speedboat** params (draft ≈ 0.4–0.6 m). At 2.0 m (galleon) a λ8 wave reaches the hull at 21%; at 0.5 m it reaches 68%.
  - Finding: `raftScene.ts:118` builds the raft's mirror with `seaPhysicsParams` (galleon). The raft's force field is therefore attenuated at 2.0 m, not her 0.3 m draft. Probable pre-existing defect; flag to raft owner.
- Chop shorter than 8.3 m (σ ≈ 0.07 m, unmirrored) should drive audio slap and camera micro-shake procedurally, not forces. Mirroring cascade 2 would add ≈ +50% `update` cost. Not recommended (open decision D7).

### 2.2 Hydrostatics — Kerner pt 1 (clipped triangles)

- **Clip.** Per triangle with vertex depths d_i = h(x_i, z_i) − y_i, there are 4 cases: 0/1/2/3 submerged. The 1- and 2-submerged cases split along the interpolated waterline into 1 or 2 fully wet triangles. The maximum output is 2 × tri count, so buffers pre-allocate.
- **Force.** `F_i = −ρ g d_c A_i n̂_i` (outward normal, centroid depth). Kerner uses the true centre of pressure to avoid residual torque on coarse meshes. With ~250 tris the centroid error is small. Add CoP only if the static-trim test fails.
- **Prototype result.** 11 m × 2.6 m hull, 24° deadrise, 3200 kg. The equilibrium keel depth from clipped-triangle forces gives displaced volume 3.129 m³ vs m/ρ = 3.122 m³. **Error 0.23%.** The residual is the linear bow taper.
- **Free waterline.** Clipping yields the waterline intersection polyline (the cut edges). That polyline is the spray root line, the wetted outline for wake injection (§2.7), and replaces the fixed-station cutwater in `hullContact.ts:139-161` for this mode.

### 2.3 Hydrodynamic forces

**Kerner pt 2.** Formula shapes confirmed from the article summary and the asv_wave_sim discussion; re-check coefficient conventions against the article at implementation:
- *Viscous:* `F_v = ½ ρ C_f(Rn) S_i |v_t| v_t`, with `C_f = 0.075/(log10 Rn − 2)²` (ITTC-57), `Rn = |V| L/ν`, and v_t the tangential point velocity.
- *Pressure drag:* `F_pd = −(C_PD1·v/v_r + C_PD2·(v/v_r)²)·cos^{f_P}θ·S_i·n̂` for cos θ > 0. The mirrored *suction* term `+(C_SD1…)·(−cosθ)^{f_S}` applies for cos θ < 0.
- *Slam:* `F_slam = clamp(Γ/Γ_max, 0, 1)^p · cosθ · F_stop`, where Γ is the swept-volume rate and F_stop is the force that **stops the triangle in one frame**.
- Kerner ran this with forward Euler at < 1 ms/boat in Just Cause 3, jet ski to corvette. He added **no added mass** ("didn't get what we hoped for").

**Problems for this repo:**
1. Nothing there is derived. C_PD, f_P and Γ_max are pure feel knobs, which conflicts with §V53.
2. `F_stop` is **dt-dependent**: halving h doubles it, so it breaks substep invariance (proposed V103).
3. f_P < 1 makes ∂F/∂θ singular at grazing incidence, which is exactly the planing bottom. That creates stiffness and chatter.
4. It has no added mass, which the repo already learned is necessary (§V69, §V70).

**Recommended hydrodynamic term: 2D+t momentum sections** (Zarnick 1978; Faltinsen 2005 ch. 9; Garme 2005).
- Slice the hull into ~16 transverse strips (hull-frame z).
- For each strip, take the local immersion d and relative normal velocity V_n from the clipped geometry and the patch. Deadrise β is tabulated from the mesh.
- Wetted half-beam: `c = min((π/2)·d/tanβ, b_chine)`. The π/2 is the Wagner splash-up factor. After the chine is wet, c = b_chine and the section behaves like a flat plate.
- Section added mass: `m_a = k(β)·ρ·(π/2)·c²`.
- Normal force: `f = d/dt(m_a V_n) + ½ ρ C_Dc (2c) V_n|V_n|`.
  - Here `d/dt = ∂/∂t − U ∂/∂x`, and the `−U·∂(m_a V_n)/∂x` part is **planing lift**.
  - `C_Dc ≈ 1.0`; crossflow drag of a wedge per Zarnick.
  - Apply at the strip centroid along the strip normal, tilted by the local heel (asymmetric-wedge roll lift → chine grip and chine walk).
- **Slam** is the `V_n·dm_a/dt` term. Write it as a per-section inelastic momentum exchange, like `buoyancy.ts:790-804` (§V70). It is unconditionally stable, dt-independent, and dissipative on entry only.
- **Transom.** Pressure → 0 at the transom (dry-transom Kutta), so `m_a` drops to 0 after the last wetted strip. That is what makes lift act ahead of the transom and produces the Savitsky centre of pressure.
- **Sway/yaw.** The same strips give lateral crossflow (`½ρ C_D,lat d_side |V_y|V_y`). Add a skeg/drive-leg foil at the prop location (§3).
- **Aero.** Deck plate `½ ρ_air V_rel² A_deck C_L(α)` with C_L ≈ 2π sin α·cos α capped at 1.0, applied at the deck centroid. Rough magnitude at 45 m/s, 26 m² deck: α 5° → ~3 kN; α 15° → ~19 kN, about 40% of weight. **This is what makes blow-over happen**; do not omit it.
- Keep Kerner's suction term as an arcade "stickiness" knob, **default 0**.

### 2.4 Savitsky (1964) as the oracle

- **Short form** (prismatic hull, thrust through CG):
  - `C_Lβ = Δ/(½ρV²b²)`
  - `C_Lβ = C_L0 − 0.0065·β·C_L0^0.6`
  - `C_L0 = τ^1.1(0.012 λ^0.5 + 0.0055 λ^2.5/C_v²)`
  - `l_p/(λb) = 0.75 − 1/(5.21 C_v²/λ² + 2.39)`
  - `R = Δ tanτ + D_f/cosτ`
- Script output for the proposed reference boat (4500 kg, chine beam 2.4 m, β 24°, LCG 3.3 m from transom):

| V m/s | C_v | τ ° | wetted L m | R kN | shaft kW (η 0.55) |
|---|---|---|---|---|---|
| 12 | 2.5 | 5.5 | 5.1 | 7.0 | 152 |
| 25 | 5.2 | 2.6 | 4.6 | 11.6 | 525 |
| 35 | 7.2 | 1.8 | 4.5 | 19.1 | 1217 |
| 45 | 9.3 | 1.4 | 4.4 | 29.4 | 2404 |
| 55 | 11.3 | 1.2 | 4.4 | 42.1 | 4210 (L/D ≈ 1, unrealistic) |

- **Consequence 1: the requested "trim 3–6° at speed" is not the free-running trim of a deep-V at 35–45 m/s** (1.4–1.8°). It is reached by **trimming the drive out**: thrust-line moment plus the arcade lean-back input. Success criteria therefore test *free trim vs Savitsky* and *trim-out authority* separately.
- **Consequence 2: speed.** A non-stepped prismatic hull needs ~2.4 MW at 45 m/s. Top speed 40–45 m/s is a realistic "nasty" target for twin ~1000–1350 hp. 60 m/s needs a stepped hull or ventilated bottom (wetted-area reduction). Model that, if wanted, as a documented `C_f` scale "step ventilation" with its own §V53 check (open decision D2).
- **Porpoising.** Savitsky's porpoising limit (after Day & Haag 1952) falls with speed as roughly τ_crit ∝ √(C_Lβ/2) and rises with deadrise. The β=0 approximation gives ≈ 6.3° at 25 m/s, 4.5° at 35 m/s, 3.5° at 45 m/s. So **trimming out past ~3.5° at top speed porpoises**. That is emergent risk/reward gameplay the 2D+t model should reproduce: Zarnick-type models do porpoise. It is also a test: at 45 m/s, τ 2° is stable, τ 6° oscillates.

### 2.5 Porpoising, chine walk, spray

- **Porpoising:** emergent (heave-pitch coupling of the lift centre). Assist: pitch-rate damping in a 0.7–3 Hz band, scaled by the assist dial (§3.4).
- **Chine walk:** emergent roll limit cycle at high speed and low trim-in, from asymmetric roll lift. Assist: roll-rate damper.
- **Spray root:** per section at `c_spray = (π/2)·d/tanβ`. Once `c_spray > b_chine`, spray leaves the chine as a sheet. The line of section spray roots is the emitter for `foam/bowSpray.ts`, which already takes a cutwater, plus a chine-sheet emitter in S8. Intensity ∝ V_n·dc/dt.

### 2.6 Cost and substepping

- **Cost table.**

| Item | Estimate |
|---|---|
| Patch (40 heightAt, archipelago) | ≈ 0.16–0.24 ms/boat/tick |
| Clip + forces (prototype, 246 tris, unwelded 490 verts) | 44 µs/substep; welded ~150 verts → ~30 µs |
| 2D+t strips (16) | ~10 µs |
| Integrate | ~3 µs |
| **Full-LOD boat, N=2** | **≈ 0.26–0.33 ms/tick** |
| **N=3** | **≈ 0.31–0.4 ms** |

- **Fleet.** 8 full-LOD boats ≈ 2.5 ms, too much for a frame already CPU-bound: 19–24 ms encode vs 6–10 ms GPU, per `ocean/fetchField.ts:16`. With LOD (§5.6):
  - player + 2 nearest full ≈ 1.0 ms
  - 5 far NPCs at 20 Hz ≈ 0.1 ms
  - mirror update 1.7 ms
  - **budget: speedboat sim ≤ 3.0 ms/tick total** (see §8).
- **Why 60 Hz is not enough.**
  - *Heave/pitch stiffness* is harmless: ω_n = √(ρgA_wp/m(1+a)) ≈ 6 rad/s, so ω·h ≪ 2.
  - *Planing heave damping* is the binding term. B₃₃ ≈ ρ·U·(π/2)c²-scale ≈ 1025·45·(π/2)·2.4²·~0.9 ≈ 4×10⁵ N·s/m. B/m·dt at 60 Hz ≈ 1.5: stable but ringing, close to the explicit limit of 2. 120 Hz → 0.77; 180 Hz at 55 m/s → 0.7. This is an estimate; measure in S1 via the eigen-sweep test.
  - *Encounter frequency* with the shortest mirrored wave at 50 m/s head sea: f_e = (c + V)/λ ≈ 6.5 Hz. 60 Hz gives 9 samples per period; 120 Hz gives 18.
  - *Water entry*: wetted-width growth at 5 m/s sink, β 24° is ~17 m/s, so the chine wets in ~75 ms (4 ticks at 60 Hz, 9 at 120 Hz).
  - **Rule:** `N = clamp(ceil(B₃₃(U)/m_eff · dt / 0.8), 2, 4)`, evaluated per boat per tick from sim state (deterministic, §V2).
  - Collisions and gate sweeps run per substep (§4, §5).
- `core/loop.ts` keeps SIM_DT = 1/60 (`:7`). Substepping is internal to the `rigid6` step, so §V2 is unchanged.

### 2.7 Hull↔water contact module — contract for the wake agent

`src/sea-physics/hullWater.ts` (engine-free) produces per substep, in reused buffers:
- wet triangles (world verts, area, normal, depth, point velocity)
- waterline segments (clipped cut edges, with local V_n)
- per-section `{c, d, V_n, dm_a/dt, sprayRoot}`
- totals: wetted area, displaced volume, slam momentum lost
- prop immersion

Consumers: rigid body (forces), wake injection (sources = waterline segments × V_n and displaced-volume rate), spray, audio (slap = Σ slam, hiss ∝ wetted area·V²), crash sensors.

**Feedback hazard.**
- `cpuOcean.ts:431-434` argues the wake cannot feed back into heave because `flowFoam.setShip` takes no y, pitch or roll.
- Hull-sampled wake sources *do* depend on y/pitch/roll, so a speed → wake → head → force loop opens.
- Rule (V111): a hull's force query **excludes its own wake source from the same tick** (one-tick lag at minimum, Smith-attenuated), and a stability sweep measures it.
- Other boats' wakes are included in the query. Jumping wakes is a Wave Race staple.
- `flowFoam` wake is single-ship today (`setShip`, `raftFrame.ts:99`). Multi-boat is the wake agent's problem.

---

## 3. Propulsion, control, assists

### 3.1 Drive model (`src/speedboat/drive.ts`)

- **Geometry.** Prop point P in the hull frame: aft of the transom, ~0.35 m below keel. The drive pivots about a steer axis (yaw δ ∈ ±30°) and a trim axis (θ ∈ −6°..+8°).
- **Engine.** `Q_e(rpm, throttle)` = torque curve × throttle shape (`throttle^1.6`), rev limiter with a hard cut plus hysteresis.
- **Prop** (Wageningen-B-like, linearised): advance `J = V_a/(nD)`, `K_T ≈ K_T0(1 − J/J0)`, `K_Q ≈ K_Q0(1 − J/J0')`.
  - `T = K_T ρ n² D⁴ · s^1.5`
  - `Q_p = K_Q ρ n² D⁵ · (0.12 + 0.88 s)`
  - where `s = smoothstep(−r, +r, depth_P)` is the immersion from the patch and r is the prop radius.
- **rpm ODE.** `I_drive·dω/dt = Q_e·gear − Q_p`. Exposed prop means Q_p collapses, so **rpm flares to the limiter** with no special case, and thrust drops. Re-entry means a torque spike, which is audible as a bog.
- **Thrust vector** in the hull frame: `T·[sinδ cosθ, sinθ, cosδ cosθ]` at P. That produces yaw torque, a roll torque (P below CG), and a bow-up/down moment from θ. This is the trim-out authority noted in §2.4.
- **Lower-unit foil** at P: `½ρV²A_skeg·C_Lα·α_local` (C_Lα ≈ 2π·AR/(AR+2)). It gives steering with the throttle off and resists sideslip.
- **Calibration** (§V53, dimensionless): at J at top speed, prop slip = 1 − V/(pitch·n) ∈ [0.08, 0.15], and top speed within ±3 m/s of target at full throttle, flat water.

### 3.2 Controls

- **Steer.** Analog input → δ target, slewed at 120°/s. Speed-sensitive range: full ±30° below 15 m/s, ±12° at top speed (arcade).
- **Trim ("lean").** Up/down input slews θ at 4°/s. Arcade mode adds a small direct pitch torque, `κ·m·g·L·input`, κ ≤ 0.02, **wet only**.
- **Throttle/brake.** Reverse gear below 3 m/s after 0.3 s held.
- **Gamepad.** No `getGamepads` exists in `src` today. Analog throttle and steer are effectively mandatory for racing, so add them in S2 (`src/input`).

### 3.3 rpm → audio

`drive.rpm`, `ventilation = 1 − s`, `load = Q_p/Q_max` and `cavitation ∝ max(0, σ_crit − σ)` are sim state and published to the audio feed (§6). Audio **never derives pitch from speed** (V112).

### 3.4 Assists (`src/speedboat/assists.ts`)

One dial a ∈ [0,1]; every term scales with a and is sim-side, deterministic, and in the input log. Individual scales are in params (§V16, §V52).

| Assist | Law | Gate |
|---|---|---|
| Stability | PD torque on roll toward `bank_target = k·steer·min(1,V/20)`; on pitch toward trim band [1.5°, τ_porp−0.5°] | wet fraction; cap 0.3·m·g·B |
| Anti-porpoise | pitch-rate damping, band-passed 0.7–3 Hz | V > 20 m/s |
| Anti-chine-walk | roll-rate damping | V > 25 m/s |
| Slip limiter | yaw-rate target from steer; lateral force if sideslip > 25°·(1−a)+10° | wet |
| Air control | pitch/roll torque from stick, α ≤ 2.5 rad/s²; auto-level toward predicted landing-surface slope (patch/heightAt at ballistic landing point) | **zero** if any triangle wet |
| Landing cap | per-substep vertical decel capped at (30 − 20a) g via momentum-exchange factor floor | slam |
| Auto-recover | if capsized and |v|<4 m/s: righting torque ramp over 1.5 s | a > 0; else respawn (§4) |

---

## 4. Crashes, collisions, damage, respawn

### 4.1 Detection (`src/speedboat/crash.ts`, pure, per tick)

| Event | Condition | Latency target |
|---|---|---|
| Capsized | `up·Ŷ < cos 110°` continuously 0.3 s while wet > 5% | ≤ 0.5 s |
| Stuffed / pitchpole | bow strip immersion > 0.8·freeboard AND V > 15 m/s AND decel > 2.5 g | same tick |
| Blow-over | airborne AND `fwd·Ŷ > sin 55°` AND pitch rate > 1 rad/s | same tick |
| Tumble | airborne AND |ω| > 4 rad/s for 0.4 s | 0.4 s |
| Hard impact | collision Δv_normal > 8 m/s (boat, rock, terrain) | same substep |

Events are **returned, not stored** (buoyancy's slam convention, `buoyancy.ts:385-396`). Only the crash state machine phase is SimState.

### 4.2 Boat ↔ boat

- **Proxy.** Two capsules along the keel (aft body r ≈ 1.2 m, fore body r tapering to 0.7 m) plus a deck-height capsule for stacking on landings. Much cheaper and more robust than OBB-SAT for ~1 m/tick relative motion.
- **Broadphase.** None (28 pairs).
- **Narrowphase.** Segment-segment closest points (Ericson 2005 §5.1.9), then conservative-advancement TOI when closing speed·h > r_min, so there is no tunnelling at 100 m/s closing.
- **Response.** Sequential impulse at the contact point with full inverse inertia (Catto 2006): e = 0.25, μ = 0.3. The angular response makes T-bones spin boats.
- **Cap.** Result bounded at `maxImpactAccel` with force and torque scaled together (§V44 and the `grounding.ts:180-203` lesson).

### 4.3 Boat ↔ terrain / rocks / buoys

- **Terrain.**
  - 16–24 hull points (keel line, chines, bow, transom corners) against `archipelago.seabed.heightAt` (the same field terrain and mirror read, §V8).
  - Penetration p = bed − y_pt. Normal from the central-difference gradient of heightAt; steep cliffs give a near-horizontal normal, which is wanted.
  - Velocity-level impulse cancelling the normal velocity (e = 0.1), plus Coulomb friction μ 0.5, plus positional correction Baumgarte ≤ 0.2·p/h.
  - **Do not reuse `grounding.ts`.** It is vertical-only and yaw-free by contract (§B.6), which is right for a galleon settling and wrong for a 40 m/s hull meeting a cliff.
- **Rocks.** `island/rocks.ts` `RockPlacement`s straddling the waterline become bounding spheres/capsules from placement scale, tested only within 30 m.
- **Buoys (gate markers).** 1-DOF heave bobbers (kinematic on patch height) with sphere colliders. A hit gives the boat a small impulse, the buoy a displaced spring return, and a gate penalty per the GDD.

### 4.4 Damage

- v1: **no persistent damage** (arcade).
- Optional D6: cumulative "engine health" from hard impacts reducing max power by ≤ 15%. The ship damage record (`ShipState.damage`) exists but is combat-shaped. Do not reuse it for semantics that differ.

### 4.5 Crash state machine and respawn

```
RACING ─event→ CRASHING (physics continues, input cut, 1.2–2.5 s)
  ├─ upright & wet & |ω|<1 within 3 s → RECOVER (input back, 0.5 s assist ramp) → RACING
  └─ else → RESPAWN (fade 0.4 s) → GHOST 2.0 s (no boat-boat contacts, alpha flicker) → RACING
```

**Respawn = teleport contract** (V108):
- Place at last passed gate + 15 m along the racing-line tangent, y = patch height − running draft.
- Speed = min(0.3·v_before, 15 m/s) along the tangent. ω = 0.
- **Reset every per-location memory**: patch, prev section m_a, prev heights, wake own-source history. Same lesson as `resetSeaMemory` (`buoyancy.ts:298-323`).
- Assert slam = 0 on the first tick.
- Placement search rejects spots within 6 m of any boat or rock and spots over seabed shallower than draft + 1 m.

### 4.6 Presentation and FX reuse (§V95 check)

- `combat/debris.ts` imports only `three/webgpu` and `./fxMath` (`:45-46`). It is generic (instanced tumbling chunks landing on the sea) but lives in `src/combat/`, which the isolation walk forbids (`tests/raftIsolation.test.ts:20-29`, KNOWN_LEAK `:125`).
- `combat/cameraShake.ts` imports `combatShakeParams` (`:47-48`). `impactRing.ts` imports the `CombatFxParams` type (`:63-65`).
- **Do not copy them.** A precursor T-task moves `debris.ts`, `fxMath.ts`, `cameraShake.ts` (params injected) and `impactRing.ts` (params type split) to `src/fx/`, with combat re-importing. That is a pure move, and pirate behaviour must stay bit-identical (test: combat fx tests unchanged).
- **Crash burst:**
  - spray column + crown from the existing spray pool (`src/foam`, generic)
  - 6–12 debris chunks (fibreglass/hull colours)
  - foam scar ring (impactRing)
  - camera shake impulse ∝ Δv
  - optional 0.35× sim-rate slow-mo for 0.4 s (deterministic in ticks; single-player only, D13)
- The boat itself tumbles physically. No ragdoll is needed; `rigid6` *is* the ragdoll. Optional detach of a cosmetic engine cowling as debris.

---

## 5. NPC racing AI (`src/race/` — not `src/ai/`)

### 5.1 Placement and shared helpers

- `src/ai/steering.ts` is pure, but `ai/` is a forbidden directory for non-pirate entries.
- `rudderFromError` takes pirate `AiParams`.
- `yawOf` is already duplicated in `raft/raftShip.ts:45` and `ai/steering.ts:26`.
- **Precursor:** move `wrapAngle`, `yawOf`, `bearingTo` and `headingError` to `src/core/steering.ts`. `ai/steering.ts` and `raftShip.ts` re-import them (§V95). Pirate diff is import lines only.

### 5.2 Track representation

- The circuit is an ordered list of gates `{p_left, p_right, width, side}`.
- Centerline = centripetal Catmull-Rom through gate midpoints, arc-length parameterised at 2 m samples, with corridor half-widths from gate widths blended between gates. Clip the corridor by seabed depth ≥ draft + 1.5 m and rock clearance.
- **Racing line.** Elastic-band min-curvature relaxation (Kapania et al. 2016 two-step idea, iterative form):
  - move each sample laterally to reduce `Σκ²` subject to the corridor minus a 3 m margin
  - 200 iterations offline at circuit build, deterministic
- Store `(s, lateral offset, κ, v_max)`.

### 5.3 Speed profile

- `v_lat(s) = √(a_lat/|κ|)`, where `a_lat` is **measured** from a `rigid6` steady turning-circle test per boat class (S5 pre-step), not guessed.
- Forward pass with the `a_acc(v)` table from a measured full-throttle run; backward pass with `a_dec(v)` from a measured throttle-off run. There are no brakes; drag is the brake.
- Per-difficulty scale `v_max·(0.88 + 0.12·skill)`.

### 5.4 Controller

- **Steer:** pure pursuit (Coulter 1992) on the racing line, lookahead `L = clamp(0.9·V, 12, 45) m`, curvature `2·sin α/L`, mapped to δ via the measured steady-turn gain, plus a small yaw-rate damper.
- **Throttle:** PI on `v_profile(s + V·0.5 s) − V`.
- **Trim schedule:** θ(V) from a sim-measured table (max speed below the porpoise onset minus a margin); lower in rough sea.

### 5.5 Wave reading

- Every 3 ticks, sample `CpuOcean.heightAt` at 4 points ahead along the line at t = 0.3, 0.6, 0.9, 1.2 s.
- Estimate launch vertical speed `v_y ≈ V·Δh/Δs` over the upcoming crest face, and airtime `t_air = 2 v_y/g`.
- If `t_air > T_air_max(skill)` or the predicted landing slope differs from hull pitch by > 12°, then:
  - lift throttle by `min(1, (t_air − T)/0.4)`
  - trim in (bow down) 0.4 s before the crest
- Cost: 16 samples/NPC per 3 ticks ≈ 12 µs/tick/NPC.
- skill 0 disables it (the NPC stuffs and flies more). Validate as an A/B over ≥ 20 seeds (§V50: sweep realisations, not one).

### 5.6 Rubber banding, avoidance, difficulty, LOD

- **Rubber band.** Gap g = progress_player − progress_npc in metres along the track. Engine power multiplier `1 + clamp(k·g, −0.08, +0.08)`, disabled in the last 25% of the final lap. **Power only**; never grip, never teleports. Tunable, defaults off at the "sim" preset.
- **Avoidance.** For each pair within 60 m, predict closest approach over 2 s (constant velocity, RVO-lite; van den Berg 2008). If it is < 2.5·r_capsule, shift the NPC's lateral target offset away (≤ 8 m, decays 1.5 s) and give way to the boat ahead. No speed-based avoidance, since boats cannot brake.
- **Difficulty dial** `skill ∈ [0,1]` drives:
  - line offset noise σ = 3(1−skill) m (Perlin in s)
  - reaction delay 0–200 ms
  - wave reading on/off threshold
  - trim aggressiveness
  - mistake rate (spontaneous throttle lift) λ = 0.02(1−skill)/s, seeded rng per NPC (§V2)
- **LOD** (decided from SimState: distance to the *player boat* and race rank, never camera or frustum, V106):
  - *FULL:* player, the 2 nearest NPCs, and any NPC within 250 m. Full `rigid6`, N substeps.
  - *RAIL:* NPCs beyond 300 m. `s += v·dt` on the line at 20 Hz; pose from 4-probe heave/pitch fit on heightAt; lateral offset dynamics as a first-order lag. Crash rate modelled statistically from the wave read (seeded).
  - *Handoff* within the 250–300 m hysteresis band: initialise `rigid6` from rail pose with velocity = tangent·v and y from patch equilibrium; reset memories (V108); blend render pose over 0.3 s.
  - Requirements: position jump < 0.5 m, speed jump < 1 m/s.

### 5.7 Gates and laps (`src/race/gates.ts`, pure)

- Crossing = the segment from CG_{k−1} to CG_k (per substep) intersects the gate's vertical plane segment between buoys, direction-checked (V107).
- At 60 m/s, 1 m/substep. Point-in-box would skip thin gates.
- Timers in ticks, events `{gatePassed, gateMissed, lap, finish}` for HUD hooks. Missed gate = time penalty or forced return per the GDD.

---

## 6. Engine audio

### 6.1 What exists

- `audio/engine.ts` = context + buses.
- `layer.ts` = looped sample layer with seeded offset.
- `emitters.ts:98-107` = PannerNode, **HRTF**, inverse distance.
- `oneshots.ts` *does* synthesize (oscillators + noise buffers for cannon/creak), so the pattern for procedural graphs exists.
- No AudioWorklet, no rpm model, no doppler.
- WebAudio removed panner doppler (`setVelocity`, `dopplerFactor` are no-ops; W3C issue #455).

### 6.2 Options

| Approach | + | − |
|---|---|---|
| Pure procedural (Baldan et al. 2015; Farnell 2010) | tiny assets, perfect rpm tracking, infinite voices cheap in one worklet | sounds synthetic without expert tuning; big-block marine V8 character hard |
| Granular (Crankcase REV, Audiokinetic blog) | most realistic ramps | needs rpm-annotated ramp recordings; grain scheduling in JS main thread is jittery → worklet; licensing |
| rpm-indexed loop crossfade (BOOM/Caviezel primer) | simple, robust, uses `layer.ts` | needs 4–6 steady-rpm loops ×2 (on/off load); ±25% rate stretch artefacts |

### 6.3 Recommendation: hybrid, per boat (`src/audio/boatEngine.ts` + `boatEngine.worklet.ts`)

**Layers:**
1. **Loop bank:** 5 steady-rpm loops (≈ 1000/2000/3200/4400/5600 rpm) × {on-load, off-load}. Equal-power crossfade between the 2 nearest rpm, `playbackRate = rpm/rpm_ref` within ±25%, load crossfade from `drive.load`.
2. **Firing layer** (AudioWorklet, one node, N voices inside):
   - pulse train at `f = rpm·n_cyl/120` (V8 4-stroke: 5000 rpm → 333 Hz)
   - per-cylinder amplitude and timing jitter (seeded)
   - exhaust resonator (2 comb/delay + lowpass)
   - Supplies transient truth (limiter cut, ventilation flare, bog) that loops smear.
3. **Prop layer:** band-passed noise, centre ∝ prop rps. Gain ∝ ventilation + cavitation; ventilation adds a high-Q whine.
4. **Hull layer:** reuse `hullEvents`/`sampleShot` one-shots triggered by the contact module's slam momentum (§2.7), plus a hiss loop with gain ∝ wetted area·V² and a lowpass opening with V.

**Doppler and propagation.** Each NPC voice is `sum → DelayNode(delayTime = distance/343, smoothed τ 50 ms) → PannerNode`. A smoothly varying delay produces exact doppler and pass-by arrival delay. Check: approaching 40 m/s → ×1.132, receding → ×0.896. Clamp delay slope to avoid zipper noise; max delay 1.0 s.

**Voices and LOD** (by listener distance; render-side, so the camera is fine here, §V3):

| Voice | Layers | Panner |
|---|---|---|
| Player | 1+2+3+4 | HRTF (existing `createPanner`) |
| NPC near (≤ 3 nearest within 250 m) | 1 (2 loops) + 2 | `equalpower` |
| NPC far | none of its own; contributes rpm/gain to one shared "pack" drone | one equalpower panner at the pack centroid |

**Node budget.** Player ~14 nodes; each near NPC ~9; pack ~5; worklet 1. **≤ 50 nodes total.** Only 2 HRTF panners (player engine + player hull).

**Assets** (licences to verify per file; repo already mixes Freesound + ElevenLabs, `audio/assets.ts:55-103`):
- Freesound CC0/CC-BY: outboard and sterndrive idle/rev/pass-by recordings. Pitch-track offline with a scratch script to annotate rpm.
- Sonniss GDC Game Audio Bundles: royalty-free commercial use, includes vehicle and boat material.
- ElevenLabs SFX: already used for cannon and splinters; fine for slap, crash and debris one-shots, weak for steady-rpm loops.
- BBC Sound Effects (RemArc): **non-commercial licence**. Reference only unless the project stays non-commercial.
- Paid: BOOM Library vehicles, Pro Sound Effects boats.

---

## 7. Camera (`src/camera/`)

- **Existing constraints.**
  - `FollowCam.update` forces `camera.fov = cameraParams.fov` each frame (`followCam.ts:540-543`), so speed FOV needs a `setFovOffset(deg)` hook, not a mutated global param (§V62 shape).
  - Chase heading comes from the hull forward vector (`:549-551`) and degenerates when the bow points vertically.
  - `camStations.ts` pulls in `combat/` (the existing KNOWN_LEAK ratchet); the speedboat isolation test inherits it.
- **Chase rig** (new mode `race` in FollowCam, or a thin `raceCam.ts` driving the same camera; both in `src/camera`, with pure math in `camMath.ts`):
  - **Heading source:** hull heading when wet and |fwd_xz| > 0.5, else smoothed velocity heading, blended over 0.25 s. The camera never follows a tumble's yaw.
  - **Pivot:** CG + 1.2 m up. Lateral half-life 0.12 s, vertical 0.25 s, plus a critically damped spring on vertical offset excited by the landing slam (compress 0.4 m per 10 m/s lost).
  - **Distance** `r = 9 + 0.12·V` m; pitch 12° lowering to 8° at speed.
  - **FOV** `55° + 13°·smoothstep(15, 45, V)`, slewed ≤ 20°/s.
  - **Shake:** slam impulse ∝ slam momentum, engine micro-vibration ∝ rpm/rpm_max·0.02°, collision impulse ∝ Δv. Uses the `src/fx/cameraShake` restore → update → apply order (`cameraShake.ts` header).
  - **Airtime:** lift the look-target 30% toward the landing point.
  - **Crash:** detach to a world-anchored orbit at the crash point, slow orbit, look at the hull; return on respawn with the existing mode-switch blend.
  - **Collision:** min height above water (`enforceMinHeight`) plus a camera→pivot ray against seabed heightAt so the camera never sits inside an island.

---

## 8. Phased build plan (after GDD sign-off)

Global rules:
- Each stage ends with vitest green (none skipped; §Rule 8) and `tsc --noEmit`.
- Visual stages need browser screenshots/gifs (§V22) and perf HUD numbers at the same tick (§V63).
- Perf reference: raft page frame time on the dev machine, measured at S0 start.

### Precursors (pure moves, pirate/raft behaviour unchanged)
- P1 `integrateQuat` → `core/quat.ts`
- P2 steering helpers → `core/steering.ts`
- P3 generic fx → `src/fx/`
- P4 flag raft Smith-depth finding to its owner (do not fix here)

### S0 — page skeleton + neutral sea
- **Owns:** `speedboat.html`, `src/main-speedboat.ts`, `vite.config.ts` input, `src/core/seaScene.ts` (new), `src/raft/raftScene.ts` (wrapper edit), `tests/speedboatIsolation.test.ts`.
- **De-raft.**
  - `buildSea(app, state, sky, weather, opts: { sites: IslandSite[]; wakeSpeedScale: number; seaParams: SeaPhysicsParams })` contains everything in today's `buildRaftSea` except the three raft decisions: Sierra sites (`raftScene.ts:80`), raft wake scale (`:68`), and mirror params (`:118`).
  - `buildRaftSea` becomes `const sierra = generateSierraSites(seed); return { ...buildSea(..., { sites: sierra.sites, wakeSpeedScale: raftWakeParams.speedScale, seaParams: seaPhysicsParams }), sierra }`. `RaftSea` type and behaviour are identical, including passing galleon params so the raft is bit-identical; the Smith fix is P4's.
  - Likewise split `raftFrame.renderSea` into `renderSeaCommon(focusPose)` in `core/seaFrame.ts`, with the raft keeping vessel-specific wetline/bowSpray calls.
- **Success criteria:**
  - raft page: same sim hash over 600 ticks, fixed seed, before and after the refactor (§V2; proves the refactor is behaviour-free)
  - `buildSea` defined in exactly one module (§V95 raw test)
  - speedboat transitive import walk contains no `main.ts|main-raft.ts|raft/|combat/|ai/` except KNOWN_LEAK (V109)
  - `main-speedboat.ts` ≤ 300 lines
- **Browser:** page boots, sea + islands + sky render, a placeholder hull floats via the existing buoyancy; console clean.
- **Perf:** frame time ≤ raft page +5%.

### S1 — `rigid6` + hull↔water on one boat, open sea
- **Owns:** `src/sea-physics/rigidBody.ts`, `hullWater.ts` (clip, hydrostatics, 2D+t, viscous, aero), `src/params/speedboat.ts`, `src/speedboat/hullMesh.ts` (collision hull from blueprint or procedural deep-V).
- **Success criteria (tests):**
  - Static float: displaced volume = m/ρ **within 3%** (prototype 0.23%).
  - Static trim: LCG shifted 0.3 m aft gives trim within 0.5° of the hydrostatic prediction from mesh LCB/BM_L.
  - GM_T from the mesh vs analytic wedge section ±5%. Heave period vs `2π√(m(1+a)/(ρgA_wp))` ±10% (§V53).
  - Orientation: 20 random full-SO(3) tumbles × 10 s gives no NaN, `||q|−1| < 1e-9`. Torque-free asymmetric body: |L| conserved ±1%, energy non-increasing.
  - **Savitsky oracle** (flat water, thrust through CG, drive trim 0): equilibrium trim ±1.0° and resistance ±25% for C_v ∈ [3, 9] (V104).
  - Porpoising: at 45 m/s, τ_drive held for 2° free trim is stable (pitch amplitude < 0.5° after 5 s); forced 6° trim oscillates > 2°.
  - **Substep invariance:** top speed, running trim and drop-test peak decel differ < 2% between N and 2N (V103).
  - Drop test from 3 m onto flat water: peak decel within ±30% of the Wagner/von Kármán estimate for the hull; rebound height < 15% of drop (§V70 dissipation).
  - Airtime: swell preset, 35 m/s head sea: airborne-tick fraction ∈ (1%, 30%), max continuous air < 2 s.
  - Wave sweep (§V50): heave RAO over λ ∈ {8.3…189} m × 4 headings × 3 seeds, no sign inversion or notch.
- **Browser:** gif of a free-running boat over swell (script-held throttle).
- **Perf:** full-LOD boat ≤ 0.35 ms/tick at N=2 (performance.now over 600 ticks).

### S2 — drive, controls, assists, camera
- **Owns:** `src/speedboat/drive.ts`, `assists.ts`, `src/input` (gamepad), `src/camera` (race rig + FOV hook).
- **Success criteria:**
  - Top speed 42 ± 3 m/s (param target) and 0→30 m/s in 6–9 s, flat water.
  - Prop slip at top speed ∈ [0.08, 0.15].
  - Prop lifted clear: rpm reaches the limiter ≤ 0.3 s, thrust < 10% (ventilation is emergent from K_Q).
  - Turning circle at 20 m/s: 3–6 boat lengths; peak sideslip 12–25° with assist 0 (Kerner pt 2 real-boat note).
  - Assist 1 vs 0: roll overshoot on a step steer reduced ≥ 50%; air-control torque = 0 on every tick with any wet triangle.
  - Camera: 0 frames with lens under water or inside terrain across a scripted crash suite; FOV monotonic in speed.
  - **Every assist and param is live** (§V62 test: moving each changes an observable).
- **Browser:** gamepad drive, jump/landing gif, user feel sign-off.

### S3 — engine & hull audio
- **Owns:** `src/audio/boatEngine.ts`, worklet, `src/audio/boatMix.ts` (pure curves, node-testable like `mix.ts`).
- **Success criteria:**
  - OfflineAudioContext render: the spectral peak of the firing layer = `rpm·n_cyl/120` ±3%.
  - Crossfade sweep 800→6000 rpm: no sample discontinuity > −30 dBFS step.
  - Doppler: a 40 m/s pass-by renders ×1.132/×0.896 ±2%.
  - Node count ≤ 50 with 8 boats (counting context wrapper); HRTF panners ≤ 2.
  - Pitch source is `drive.rpm` only (raw scan: no speed→rate mapping in boat audio, V112).
- **Browser:** audible limiter flare on a jump, pass-by recording.

### S4 — gates, laps, HUD hooks
- **Owns:** `src/race/gates.ts`, `src/race/raceState.ts`, `src/race/circuit.ts`.
- **Success criteria:**
  - Boats at 5…60 m/s crossing a 1 m gate at 1000 random phases register **exactly once** (swept, V107).
  - Wrong-direction crossing never counts.
  - Replay of the input log gives an identical lap time in ticks (§V2).
- **Browser:** HUD events fire (lap, split, missed gate).

### S5 — NPCs
- **Owns:** `src/race/ai/` (line, speed profile, controller, waveRead, rubberBand, lod).
- **Success criteria:**
  - Racing line ∫κ² ≤ 60% of centerline; 100% of samples inside corridor − margin.
  - skill 1 NPC laps within 5% of the scripted "optimal ghost" (full-throttle line follower with profile).
  - 0 gate misses in 20 calm laps; ≤ 1 in 20 swell laps.
  - Wave reading on vs off: NPC stuff+blow-over events reduced ≥ 50% in storm over 20 seeds.
  - Rubber band multiplier ∈ [0.92, 1.08] always.
  - LOD handoff: position jump < 0.5 m, speed jump < 1 m/s; LOD decision identical under different render frame rates (V106 test: run 60 vs 35 fps accumulators).
  - Perf: 7 NPCs ≤ 1.0 ms/tick total, player boat excluded.

### S6 — collisions, crashes, respawn
- **Owns:** `src/sea-physics/boatCollide.ts`, `src/speedboat/crash.ts`, `respawn.ts`, `src/fx` usage.
- **Success criteria:**
  - Boat-boat impulse: linear momentum conserved ±1%, KE non-increasing.
  - 1000 randomized head-ons at 100 m/s closing: 0 tunnel-throughs.
  - Terrain: max per-substep acceleration ≤ cap (V110) on the cliff/shelf archetypes; no launch > 2 m above the entry height.
  - Capsize detection ≤ 0.5 s. Respawn: first-tick slam = 0, not within 6 m of boat/rock, afloat within 0.5 s (V108). Ghost window 2.0 s.
- **Browser:** crash suite gif (T-bone, rock, stuff, blow-over).

### S7 — archipelago circuit
- **Owns:** `src/race/circuits/`, `src/island` site hooks (additive).
- **Success criteria:**
  - Every gate over depth ≥ draft + 1.5 m.
  - Every corner radius ≥ the measured min turning radius at `v_profile` (§5.3), so the circuit is feasible by construction.
  - At least 2 sheltered and 2 exposed segments differing in local Hs ≥ 2× via the fetch field (§V73), which is what makes wave reading gameplay.
- **Browser:** V22 screenshots vs GDD refs; user sign-off.

### S8 — polish
Chine spray sheets from spray roots, multi-boat wake integration (wake agent), debris, music, HUD, photo mode. Per-feature toggles (§I ui/settings).

### Perf budget summary (speedboat page)

| Item | Budget |
|---|---|
| Speedboat sim CPU (8 boats + AI + collisions) | ≤ 3.0 ms/tick |
| Mirror update | ≤ 1.8 ms |
| Audio main thread | ≤ 0.3 ms/frame |
| Draw calls | ≤ +60 over raft page (8 hulls + fx instanced) |
| Frame time | ≤ raft page +15% at S8 |

---

## 9. Proposed §V / §T and open decisions

§V numbers continue after V99 (last in SPEC). Renumber on merge if parallel agents also propose.

- **V100** RIGID6 = ONE INTEGRATOR, ALL 13 CHANNELS: a `rigid6` hull ⊥ passes `stepShipSailing|Buoyancy|Grounding` (each throws); everything else contributes F/τ only (§V51).
- **V101** ONE HULL↔WATER CONTACT PER HULL PER SUBSTEP: forces, wake sources, spray roots, audio slap, crash sensors read the same clipped-triangle result; a second sampler of the same hull ⊥.
- **V102** NO EULER ANGLES IN THE 6DOF PATH: orientation = unit quat; derived angles only via functions total over SO(3); tested through full loops.
- **V103** SUBSTEP INVARIANCE: steady observables (top speed, trim, turning circle, drop peak) change < 2% between N and 2N substeps; dt-dependent "stop it this frame" forces ⊥.
- **V104** PLANING LIFT & SLAM FROM MOMENTUM (2D+t), validated vs Savitsky trim ±1° / R ±25% over C_v 3–9 (§V53 extension).
- **V105** A MIRROR'S SMITH DEPTH = THE DRAFT OF THE HULLS IT FLOATS (§V66/§V68); a mode ⊥ inherits another class's draft.
- **V106** SIM DECISIONS (LOD, rubber band, AI) KEY ON SimState ONLY, ⊥ camera/frustum/frame rate (§V2).
- **V107** RACE EVENTS ARE SWEPT: gate crossing and contacts tested on the substep segment/TOI, ⊥ point-in-volume.
- **V108** RESPAWN = TELEPORT CONTRACT: all per-location memories reset; first-tick slam = 0 asserted.
- **V109** SPEEDBOAT ⊥ TOUCHES PIRATE OR RAFT BOOT: no `main.ts|main-raft.ts|raft/|combat/|ai/` at any import depth (KNOWN_LEAK ratchet shared with §V81).
- **V110** CONTACT/SLAM/COLLISION ACCELERATION BOUNDED AT RESULT (§V44), force and torque scaled together.
- **V111** OWN-WAKE FEEDBACK: a hull's force query ⊥ reads its own same-tick wake source when sources depend on heave/pitch/roll; lag + stability sweep.
- **V112** ENGINE PITCH = SIM RPM: boat audio reads `drive.rpm/load/ventilation`; ⊥ pitch-from-speed.

§T one-liners (numbering after T162):
- **T163** P1–P3 neutral-ground moves (integrateQuat, steering helpers, fx) — pirate/raft behaviour identical.
- **T164** S0 speedboat page + `buildSea` extraction; raft sim hash unchanged.
- **T165** S1 rigid6 + hullWater (Kerner hydrostatics, 2D+t hydrodynamics, aero); Archimedes/Savitsky/substep tests.
- **T166** S2 drive (rpm ODE, ventilation), controls + gamepad, assists dial, race camera + FOV hook.
- **T167** S3 hybrid engine audio (loop bank + worklet firing layer + prop/hull layers, delay doppler).
- **T168** S4 swept gates, lap state, HUD hooks.
- **T169** S5 NPC racing (line, profile, pursuit, wave read, rubber band, LOD).
- **T170** S6 collisions, crash state machine, respawn, fx.
- **T171** S7 archipelago circuit; S8 polish.

### Open decisions (my recommendation in bold)

- **D1** Boat classes: **one 11 m deep-V offshore class for v1**; NPCs identical physics, liveries differ.
- **D2** Top speed: **42 m/s (+ boost to 48)**, realistic for a non-stepped hull. 60 m/s needs a "stepped-hull C_f scale" knob with its own check.
- **D3** Hydro model: **Kerner hydrostatics + 2D+t lift/slam**. Alternative: pure Kerner (faster to first fun, fails V103/V53).
- **D4** Assist default: **0.6**, with the dial in settings.
- **D5** Crash consequence: **recover-in-place if upright within 3 s, else respawn at last gate**.
- **D6** Persistent damage: **none in v1**.
- **D7** Mirror cascade 2 for chop: **no**; procedural chop in audio/camera.
- **D8** State shape: **ShipState + optional `drive`/`dynamics` fields**, plus optional `SimState.race`. Alternative: separate `boats[]` (cleaner types, loses every existing consumer).
- **D9** AI home: **`src/race/ai/`** with shared helpers in `src/core`. Not `src/ai/`.
- **D10** Rubber band: **power-only ±8%, off on "sim" preset**.
- **D11** NPC audio: **3 near voices + pack drone**.
- **D12** Hull mesh source: **procedural deep-V collision hull (params) decoupled from the render mesh**. The render hull may be a blueprint/AI-gen model (§V18), with collision hull ≤ 300 tris.
- **D13** Crash slow-mo: **0.4 s at 0.35× sim rate, single-player only**, or skip.
- **D14** Fix the raft mirror Smith depth (P4): **raft owner decides**; it changes raft feel.

---

## 10. Code-map facts that were wrong or incomplete

1. "buoyancy integrates y/pitch/roll only": true for **position**, but it also adds wave-surge **force into velocity x/z** (`buoyancy.ts:707-719`, `:807-809`).
2. "No capsize": the model *can* capsize (righting arm reverses past 90°; header notes measured 180° roll, `:497`, `:504-507`). It has no detection or recovery, and the pitch memory (`:437-442`, `:875`) is ill-defined when inverted.
3. "no procedural synthesis": `audio/oneshots.ts` synthesizes one-shots with oscillators + noise. There is no AudioWorklet, rpm model or doppler.
4. "buildRaftSea de facto reusable": it hard-wires Sierra sites (`raftScene.ts:80`), raft wake scale (`:68`) and **galleon `seaPhysicsParams` for the mirror** (`:118`). So the raft's Smith depth is 2.0 m, not 0.3 m (probable defect).
5. "src/ai/steering.ts reusable": pure, but `ai/` is forbidden by the isolation-walk pattern, `rudderFromError` needs pirate `AiParams`, and `yawOf` is already duplicated in `raft/raftShip.ts:45`.
6. "combat fx generic enough": `debris.ts`/`fxMath.ts` are. `cameraShake.ts` and `impactRing.ts` depend on combat params, and all sit in forbidden `src/combat`.
7. `followCam` already reaches `combat/` via `camStations.ts` (recorded KNOWN_LEAK, `tests/raftIsolation.test.ts:125`). It also forces FOV from params every frame (`:540`).
8. `flowFoam` wake is single-ship (`setShip`), and `docs/wake/wake-research.md` does not exist yet.
9. `grounding.ts` is vertical spring + planar friction, yaw-free by contract. It is not a basis for high-speed impacts.

---

## Appendix A — references

- J. Kerner, "Water interaction model for boats in video games", Gamasutra 2015, [Part 1](https://www.gamedeveloper.com/programming/water-interaction-model-for-boats-in-video-games) and [Part 2](https://www.gamedeveloper.com/programming/water-interaction-model-for-boats-in-video-games-part-2). Coefficient discussion in a Kerner-style implementation: [asv_wave_sim #5](https://github.com/srmainwaring/asv_wave_sim/issues/5).
- D. Savitsky, "Hydrodynamic Design of Planing Hulls", *Marine Technology* 1(1), 1964, [DLBA library](https://dlba-inc.com/library/hydrodynamic-design-of-planing-hulls/).
- E. E. Zarnick, "A nonlinear mathematical model of motions of a planing boat in regular waves", DTNSRDC 78/032, 1978, [archive.org](https://archive.org/details/nonlinearmathema00zarn). Coupled heave/pitch/roll extension: [J. Eng. Math. 2016](https://link.springer.com/article/10.1007/s10665-016-9878-2).
- O. M. Faltinsen, *Hydrodynamics of High-Speed Marine Vehicles*, Cambridge UP 2005 (ch. 9 planing, 2D+t, slamming). H. Wagner 1932 / T. von Kármán 1929 (water entry). Day & Haag 1952 (porpoising). ITTC 1957 friction line.
- Oosterveld & van Oossanen, "Further computer-analyzed data of the Wageningen B-screw series", *Int. Shipbuilding Progress* 22, 1975 (K_T/K_Q).
- E. Catto, "Fast and Simple Physics using Sequential Impulses", GDC 2006; "Numerical Methods" (implicit gyroscopic), GDC 2015 (box2d.org/publications). G. Fiedler, ["Fix Your Timestep!"](https://gafferongames.com/post/fix_your_timestep/). Macklin et al., "Small Steps in Physics Simulation", SCA 2019. C. Ericson, *Real-Time Collision Detection*, 2005.
- R. C. Coulter, "Implementation of the Pure Pursuit Path Tracking Algorithm", CMU-RI-TR-92-01. Kapania, Subosits, Gerdes, "A Sequential Two-Step Algorithm for Fast Generation of Vehicle Racing Trajectories", *J. Dyn. Sys. Meas. Control* 2016. van den Berg, Lin, Manocha, "Reciprocal Velocity Obstacles", ICRA 2008. G. Biasillo, racing AI chapters, *AI Game Programming Wisdom* 1, 2002.
- Baldan, Lachambre, Delle Monache, Boussard, ["Physically informed car engine sound synthesis for virtual and augmented environments"](https://www.researchgate.net/publication/280086598_Physically_informed_car_engine_sound_synthesis_for_virtual_and_augmented_environments), IEEE SIVE 2015. A. Farnell, *Designing Sound*, MIT Press 2010. [Audiokinetic: engine sound from sampling to granular](https://www.audiokinetic.com/en/blog/engine-sound-modeling-from-sampling-to-granular-synthesis-in-wwise/). [BOOM Library car engine primer](https://www.boomlibrary.com/blog/the-car-engine-sound-primer-mike-caviezel/). [WebAudio engine-sound-generator (JS)](https://github.com/Antonio-R1/engine-sound-generator). [W3C WebAudio #455 — doppler removed](https://github.com/WebAudio/web-audio-api/issues/455).

## Appendix B — scratch measurements (not committed)

Scratchpad: `/private/tmp/claude-501/-Users-flo-work-code-shiver-me-timbers/adc53218-9260-41a8-8d6a-476d5936a376/scratchpad/`
- `bench-heightAt.ts` / `bench2.ts` (vite-node): `CpuOcean` update/heightAt/pressureHeadAt, and `stepShipBuoyancy`, open sea vs analytic seabed+fetch.
- `kerner-proto.mjs` (node): procedural 11 m deep-V hull (246 tris), 4-case clip, hydrostatic + pressure-drag + viscous terms. Archimedes check (0.23%) and cost (60 µs analytic water, 44 µs patch).
- `savitsky.mjs` (node): short-form equilibrium table (§2.4) and a rough porpoising-limit estimate.
