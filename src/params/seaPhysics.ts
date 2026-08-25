/**
 * Sea-physics tunables (§V.8, §V.16): CPU spectrum mirror + ship buoyancy.
 * Mirror params control fidelity/cost of the CPU ocean copy; the rest are
 * rigid-body constants for the buoyancy integrator.
 */
import { raftWaterplane } from '../sailing/raftWaterplane';
import { registerParams, type ParamMeta } from './registry';
import { brigantineParams, galleonParams, type ShipClassParams } from './ship';
import { raftParams, type RaftParams } from './raft';

export interface SeaPhysicsParams {
  /** CPU mirror grid N×N, power of two ≤ ocean resolution (§V.8) */
  mirrorResolution: number;
  /** re-run CPU spectrum+IFFT every K sim ticks (grids cached between) */
  updateEveryTicks: number;
  /** fixed-point iterations for inverse-displacement height lookup */
  inverseDisplacementIterations: number;
  /** scales the station layout to the hull size (a live tweak knob; the
   * layout itself is the class's own waterline below) */
  probeLayoutScale: number;
  /**
   * DESIGN-WATERLINE PLAN of this hull class, ship space (§V.13: forward +z,
   * beam x): z of the stem and transom where the loft meets y = 0, and the
   * half-beam there. These three ARE the hull the station quadrature
   * integrates — waterplane area, second moments, added-mass gyradii, the
   * lot (see buoyancy `buildStations`) — so they are per CLASS, not sea
   * constants. Read from the class's `ShipClassParams` through
   * `waterlineOf`, never typed in twice (§V.77).
   */
  hullBowZ: number;
  hullSternZ: number;
  hullHalfBeam: number;
  /**
   * Number of waterplane slices sampled bow→stern (each becomes a
   * port/starboard station pair). This is the resolution of the ∫b(z)h(z)dz
   * the hull's heave force IS, so it sets which wavelengths the ship can
   * respond to correctly: Δz ≈ 35/slices must stay well under the shortest
   * mirrored wave (λ 8.3 m, cascade 2 is not mirrored). Too few and the sum
   * ALIASES — the old 8-probe layout returned the wrong SIGN at λ 40 m
   * (§B.22). 1 slice = a cork on a stick, and the tests use it as the guard.
   */
  probeSlices: number;
  /**
   * σ (m) of the fore-aft footprint kernel. Defaults to 0: with a proper
   * station quadrature the hull's own LENGTH does the fore-aft filtering,
   * correctly phased. Only useful as an anti-alias pre-filter at very low
   * `probeSlices`.
   */
  hullFootprintLength: number;
  /**
   * σ (m) of the athwartships footprint kernel. Defaults to 0: it used to
   * stand in for the Smith effect, which is now applied EXACTLY and per mode
   * in the spectrum (§V.68, cpuOcean `head`), so leaving it up would attenuate
   * the sea twice — and it never covered head seas at all, a Gaussian along
   * the beam axis being flat in the direction a head sea varies. Kept only as
   * an anti-alias pre-filter, same status as `hullFootprintLength`.
   */
  hullFootprintBeam: number;
  /**
   * Depth the wave-pressure decay e^(−k·d) is evaluated at, as a multiple of
   * `hullDraft` (§V.66: a feature scaled by its own dimension, not by a metre
   * constant that silently stops meaning "the keel" when the hull changes).
   * 1 is exact for the wall-sided prism sections `immersedDepth` models — the
   * vertical Froude–Krylov force on a prism is the pressure at its BOTTOM
   * times its waterplane. Below 1 a finer section shape carries more of its
   * volume nearer the surface; 0 disables the correction and gives back a
   * hull that tracks the outer curve of every wave regardless of draft.
   */
  smithDepthScale: number;
  /**
   * Depth (m) of the keel below the ship-space waterline plane, and height
   * of the deck above it — the hull's own body, which is what decides when
   * buoyancy actually runs out (§B.27). Mirrors the galleon loft in
   * params/ship (draft 2.0, freeboard 2.6), like the station geometry above.
   * With these at 0 the hull is an infinitely thin sheet and she goes
   * ballistic the moment the waterline plane clears a crest.
   */
  hullDraft: number;
  hullFreeboard: number;
  /**
   * §T.162/§V71 — this hull's own waterplane, sampled from the stern (index 0,
   * u = −1) to the bow (last, u = +1), each value the half-breadth there as a
   * fraction of `hullHalfBeam`. Absent = the elliptical galleon plan
   * `buoyancy.halfBreadth` has always used, so every ship in the pirate sim is
   * untouched. The raft fills it from her own log stations, because floating a
   * nine-log raft on a galleon's fine entry and 0.55-beam transom is what made
   * her "way too light in the back".
   */
  hullPlan?: readonly number[];
  /**
   * §T.162 — LONGITUDINAL CENTRE OF GRAVITY, metres from the waterplane's own
   * centroid; NEGATIVE IS AFT. The probe stations are re-centred so that
   * Σw·z = 0 (flat water makes exactly zero pitch torque), which floats every
   * hull dead level — and a raft whose cabin, stern block and steering oar are
   * all abaft midships does not float dead level.
   *
   * USER: "our baseline sitting in the water should be a little bit heavier on
   * the back and a little bit lighter on the front… it'd be weird to be way
   * too light in the back, which is probably the heaviest part of the ship."
   * This is that trim, as the one number that causes it: a constant pitch
   * moment m·g·`cgOffsetZ` the waterplane's own stiffness balances, so the
   * angle follows from the hull instead of being authored twice.
   */
  cgOffsetZ: number;
  /** N per meter of submersion for the WHOLE waterplane (ρ·g·A_wp; station
   * weights sum to 1, so this and the mass set the ride height together:
   * immersion = mass·g/spring − hullDraft) */
  buoyancySpring: number;
  /** N·s/m reference vertical damping for the whole waterplane. Heave, roll
   * and pitch each take a scaled share of it, see below — 0 means no
   * hydrodynamic damping at all, in any of the three. */
  buoyancyDamping: number;
  /**
   * Fraction of `buoyancyDamping` that resists the HEAVE component of a
   * station's vertical velocity, i.e. the linear (wave-radiation) half.
   * Small on purpose: this is the coefficient that survives at LOW relative
   * speed, so it alone sets how many cycles she rings for after a knock, and
   * at 1.0 it measured ζ_heave 0.90 — dead-beat, no ring at all, and large
   * enough that it acted as a velocity CONSTRAINT rather than a force. See
   * `heaveQuadraticRate` for the half that answers a slam.
   */
  heaveDampingScale: number;
  /**
   * Nonlinear heave damping, 1/(m/s): `heaveDampingScale` becomes
   * ×(1 + this·|relative vertical speed|). Same shape as
   * `quadraticDampingRate` does for roll, and here for the same reason —
   * ONE term has to be gentle enough to let her reverberate after an impact
   * and hard enough to stop her flying off a crest, and those are different
   * SPEEDS, not different tunings. Quadratic drag bites as v² so it is
   * negligible in a ring-down and dominant in a slam.
   */
  heaveQuadraticRate: number;
  /**
   * Fraction of `buoyancyDamping` that resists the ROLL component of a
   * station's vertical velocity. Heave damping is wave radiation — large,
   * real, and the thing that stops the hull flying off crests. Roll damping
   * is viscous — small: a real ship's roll damping ratio is 0.05–0.10 and
   * she swings for many cycles, which is what "alive in a seaway" looks
   * like. Sharing ONE coefficient forced them together, so every heave fix
   * pinned the ship upright (measured ζ_roll 0.41 at scale 1).
   */
  rollDampingScale: number;
  /** same, for the PITCH component. Pitch radiation damping is real but not
   * heave's equal; ζ_pitch ≈ 0.3 lets the bow ride a swell and overshoot
   * slightly instead of tracking the surface rigidly (ζ 0.62 at scale 1) */
  pitchDampingScale: number;
  /**
   * Nonlinear (eddy-making) ROLL damping, 1/(rad/s): `rollDampingScale`
   * becomes ×(1 + this·|roll rate|). Real roll damping is only partly
   * linear — the bilge/eddy half goes as ω|ω| — and that nonlinearity is
   * what lets a hull swing freely in a swell and still refuse to roll
   * itself over in a gale. 0 = linear only, which capsized her in storm
   * the moment roll damping was cut to a realistic ζ (§B.22). Roll only:
   * pitch damping is wave radiation, which really is linear.
   */
  quadraticDampingRate: number;
  /**
   * Wave-surge coupling: fraction of g·(water slope under the hull) applied
   * as horizontal acceleration. This is the ONLY path by which the sea can
   * change the ship's speed — at 0 the horizontal channel is deaf to the
   * water (measured surge accel RMS 0.000 m/s² in a swell) and she reads as
   * a vehicle on rails. 1 would be a raft with no resistance; a displacement
   * hull loses most of it to added mass and wave-making.
   */
  waveSurgeGain: number;
  /** ship mass kg */
  mass: number;
  /**
   * heave added mass, ×mass: entrained water that must be accelerated with
   * the hull. Inertia only — weight and therefore draft are unchanged, but
   * the heave period stretches by √(1+a). 0 = weightless cork response.
   */
  addedMassHeave: number;
  /**
   * WATER-ENTRY DEPTH, ×`hullDraft`: the immersion over which a section's
   * entrained water builds from nothing to `addedMassHeave` (§V.70). This is
   * the parameter that makes a SLAM exist at all. The reaction to a hull
   * dropping onto the sea is mostly d(m_added·v)/dt — the rate of change of
   * added mass, von Kármán's water-entry model — so an added mass that is a
   * STEP (0 while the keel is dry, full the instant it touches, which is what
   * a per-station wet/dry test gives) has dm/dt = 0 at every tick that
   * matters and produces no impact force whatever. Measured on the step
   * model: a 604 t hull entering at 5.6 m/s peaked at 0.86 g of retardation
   * and reversed over 1.65 s with zero overshoot — a settle, not a bang.
   *
   * The build-up goes as immersion², because for a section with any deadrise
   * the wetted half-width grows with penetration and the added mass goes as
   * its square. That quadratic is what makes the peak force scale as v²
   * without a v² term being written down anywhere: the hull always loses the
   * same FRACTION of its momentum entering (m/(m+A) = 1/3), and the faster it
   * enters the less time it has to lose it in.
   *
   * 1 = fully developed at the design draft, so a floating hull is at full
   * added mass and nothing about her ride height, heave period or trim moves
   * (immersion at rest is 2.44 m against a 2.0 m draft). Smaller = a sharper,
   * more violent entry. 0 disables the ramp and gives back the step.
   */
  slamEntryDepth: number;
  /**
   * Slam (m/s of speed the water took in one tick, see `stepShipBuoyancy`)
   * at which the camera shake reaches full strength, and the floor below
   * which no shake is raised at all. Feel, not physics — but it lives here
   * because the SIGNAL does, and a threshold that cannot be seen next to the
   * quantity it thresholds is how a slider stops meaning anything (§V.62).
   * The floor matters more than the ceiling: the entry exchange fires a
   * little on every wave that rises past the ramp, and shaking the lens for
   * those would be a permanent tremor rather than an impact.
   */
  slamShakeFloor: number;
  slamShakeFull: number;
  /**
   * The same entrained water, as ROTATIONAL inertia (§V.69): the added
   * moments in pitch and roll are `addedMassHeave·mass` distributed over the
   * stations by b² and taken about the hull's own axes (Σa·z², Σa·x²). 1 =
   * the physical consequence of the heave coefficient already chosen — this
   * is a section-shape allowance, not a feel knob. 0 recovers the model that
   * had NO pitch added-inertia and paid for it with damping instead (§B.37):
   * a hull that can reverse its pitch momentum in a tick or two.
   */
  addedInertiaScale: number;
  /**
   * RIGID-BODY inertia tensor diagonal, body frame — pitch about x (beam
   * axis), roll about z (forward axis). The hull's own mass distribution and
   * NOTHING else: the water it drags is `addedInertiaScale` above. Keeping
   * them apart is what lets the gyradius be checked against a real ship
   * (§V.53) — they were previously one number, so the entrained water had to
   * be smuggled in as a 0.34·L pitch gyradius against a real 0.24–0.27·L.
   */
  inertiaPitch: number;
  inertiaRoll: number;
  /** global angular velocity decay 1/s (covers yaw, which probes can't damp) */
  angularDamping: number;
  /** seabed contact: N per meter the keel is buried in the bank */
  groundingSpring: number;
  /** seabed contact: N·s/m against the keel driving further in */
  groundingDamping: number;
  /**
   * Hard cap on the seabed's total upward reaction, as a multiple of the
   * ship's weight (§V.44 — bound the result, not just the inputs). The
   * spring is unbounded in penetration and penetration is unbounded in
   * geometry, so a cliff shelf produced 100× her weight and launched her
   * (§B.22). At the resting penetrations this model is built around
   * (~0.07 m) the cap is nowhere near binding.
   */
  groundingMaxSupport: number;
  /** seabed friction coefficient — planar decel per newton of bed support */
  groundingFriction: number;
}

/**
 * Where a class's LOFT crosses the design waterline, from its own params.
 * The galleon's station plan was MEASURED against her loft in §B.22 at
 * bow 19 / stern −16.5 / half-beam 4.25 on a stem point at 21, transom at
 * −17.5, beam 8.5: the raked stem meets y = 0 three-sevenths of the way
 * along the bow wedge, the rounded transom 1 m forward of the loft's sternZ
 * on a 17.5 m half-length. Those are RATIOS of the loft, so one expression
 * reproduces the galleon's numbers exactly AND gives every other class hers
 * (§V.77 — the brigantine's plan is not a second set of typed constants that
 * agree with `brigantineParams` today).
 */
export function waterlineOf(c: ShipClassParams): {
  bowZ: number;
  sternZ: number;
  halfBeam: number;
} {
  return {
    bowZ: c.hullLength / 2 + c.bowLength * (1.5 / 3.5),
    sternZ: (-c.hullLength / 2) * (16.5 / 17.5),
    halfBeam: c.beam / 2,
  };
}

const galleonWaterline = waterlineOf(galleonParams);

/**
 * THE GALLEON — the player's hull, and the hull every number below was
 * measured on (§B.22, §B.27, §V.68–70). Registered as `sea-galleon` next to
 * `ship-galleon`; the brigantine's group is derived from it further down.
 */
export const seaPhysicsParams: SeaPhysicsParams = registerParams(
  'sea-galleon',
  {
    mirrorResolution: 64,
    updateEveryTicks: 1,
    inverseDisplacementIterations: 3,
    probeLayoutScale: 1,
    // 19 / −16.5 / 4.25 — the §B.22 plan, now READ off `galleonParams`
    hullBowZ: galleonWaterline.bowZ,
    hullSternZ: galleonWaterline.sternZ,
    hullHalfBeam: galleonWaterline.halfBeam,
    // 18 slices = 1.97 m apart over the 35.5 m waterline: 4.2 samples per
    // wavelength at the shortest mirrored wave (λ 8.3 m, cascade 2 is not
    // mirrored), so the length integral is honest across the whole band the
    // mirror carries. Measured: past ~18 the count stops buying anything
    // (24 and 32 slices move an 8 m ripple's pitch by 2%), because what is
    // left at that wavelength is not quadrature error — it is the hull
    // genuinely feeling the ripple, and the fore-aft footprint below is the
    // thing that answers it.
    probeSlices: 18,
    // fore-aft: 0, because the hull's own length integral already does it
    // (§B.22). A 1.5 m kernel here does cut what an 8 m ripple can pitch
    // the hull by (0.29° → 0.17°), but it is a 5×5 quadrature instead of
    // 1×5 — measured 0.72 ms/tick/ship against 0.18 — and it buys that in a
    // band the mirror does not even carry (cascade 2, λ ≤ 8.3 m, is not
    // mirrored). 0.55 ms of frame budget for 0.12° of a wave the sim never
    // generates is the wrong trade; the beam kernel below is the one doing
    // real work (the Smith effect, which no amount of hull length replaces)
    hullFootprintLength: 0,
    // athwartships: 0, because the Smith effect is now the real thing rather
    // than a Gaussian shaped like it (§V.68). The kernel was wrong in three
    // ways at once and each of them cost: it was flat along the hull, so a
    // HEAD sea — where the pitch forcing lives — got no depth attenuation at
    // all; its σ 3.5 m spread each station over 10.5 m of sea, wider than the
    // 8.5 m beam it was meant to average across, so it over-suppressed beam
    // chop (λ8 → 0.02 against a true 0.21); and it cost 5 heightAt calls per
    // station, 180/tick, where the spectral form costs one multiply per mode
    // and no extra transform.
    hullFootprintBeam: 0,
    // the hull's own draft — see the interface. Full pressure at the keel is
    // what a wall-sided prism section feels, and that is the section this
    // model integrates.
    smithDepthScale: 1,
    // the galleon's own loft (params/ship): keel 2.0 m below the design
    // waterline, deck 2.6 m above it
    hullDraft: 2.0,
    cgOffsetZ: 0, // the galleon is ballasted to her marks (§T.162)
    hullFreeboard: 2.6,
    // ρ·g·A_wp with the station model's own waterplane, A_wp = 241.7 m²
    // (Cwp 0.80). Measured, not chosen: it is the area the 18 slices span.
    // Was 3.36e6, i.e. a 334 m² waterplane on a 35.5 × 8.5 hull.
    buoyancySpring: 2.43e6,
    // ζ_heave 0.90 — the SAME damping RATIO as before, re-derived for the
    // hull's real mass and stiffness (2ζ√(K·M(1+a))). The absolute number
    // rose because the ship did; heave is not damped one bit harder, which
    // matters because damping heave hard is what previously pinned roll. It was raised on the user report "sometimes
    // we're losing contact with the waves — we start to fly a little bit
    // early", and it costs nothing in feel because the damper works
    // RELATIVE to the surface: more of it means the hull tracks the swell's
    // motion more closely, so vertical accel RMS went DOWN too. What it DID
    // cost was roll and pitch, which shared it — hence the scales below.
    buoyancyDamping: 3.78e6,
    // HEAVE, split into its linear and quadratic halves (§V.70). The pair
    // was one flat coefficient at ζ 0.90, and that is what "it can basically
    // more or less immediately change direction" was: a linear damper this
    // large is a velocity CONSTRAINT, not a force. Its relaxation time is
    // M(1+a)/c = 0.48 s, so the hull's vertical velocity was being dragged
    // onto the water's inside half a second whatever her momentum was, and a
    // 4 m drop into calm water overshot her own equilibrium by 35 mm and
    // crept back without one oscillation.
    //
    // ζ_heave 0.36 LINEAR (0.4 × the 0.901 the reference coefficient is) —
    // the small-signal ratio, which is the one that decides whether she
    // rings. MEASURED on a 1 m pluck in calm: extrema 0.061, −0.016, 0.004,
    // −0.001 m, i.e. four visible turning points and ζ 0.39 by log decrement,
    // against ONE at 0.90 (0.0011 m then nothing). The lost force comes back
    // as v², where the complaint never was: ×(1 + 3·|v_rel|) restores the old
    // coefficient at 0.5 m/s of relative vertical speed and triples it at
    // 2 m/s. Measured relative-speed RMS is 0.35 m/s in the sea she is sailed
    // in and 0.82 m/s at three times that energy, so the sea she LIVES in
    // sits in the gentle part of the curve and only an impact reaches the
    // hard part.
    //
    // WHY NOT LOWER, since lower rings longer — every bound here is a
    // measurement, not taste, and 0.4 is the floor all three leave:
    //  - beam-sea roll. Each station damps against ITS OWN water velocity, so
    //    the heave damper is also part of what rolls her in a beam sea:
    //    scale 0.28 took the λ60 beam-sea roll to 7.9° against the 8° §B.22
    //    holds her to. Counter-intuitive and measured twice before believed.
    //  - heave RAO shape. Resonance is at T 5.43 s (λ ≈ 46 m), INSIDE the
    //    swell band, and the linear ratio alone sets the peak: RAO/Smith at
    //    λ50 measured 0.57 at ζ 0.90, 0.78 at 0.45, 0.95 at 0.35, 1.42 at
    //    0.25. Past ~0.45 it breaks the monotone shape §B.22 protects. The
    //    QUADRATIC term is what buys 0.36 back — near resonance the relative
    //    speed is large, so the v² half bites exactly where it is needed and
    //    flattens the peak without touching the ring-down.
    //  - heave PHASE at λ40, which is the one bound §V.70 had to move rather
    //    than meet: see the §B.22 phase test for the argument and the numbers.
    heaveDampingScale: 0.4,
    heaveQuadraticRate: 3,
    // Linear half of the roll damping. Small, because most of this hull's
    // roll damping is meant to come from the quadratic term below: at the
    // swell's roll rates the pair lands at ζ ≈ 0.11 (a galleon swings 5+
    // cycles after a wave knocks her over — the single loudest cue that
    // she is a ship and not a prop), and at storm rates at ζ ≈ 0.6, which
    // is what keeps her the right way up. At 1.0, sharing heave's damper,
    // it measured 0.41 flat: dead in a cycle and a half.
    rollDampingScale: 0.09,
    // ζ_pitch 0.41 — the PHYSICAL value (real ships 0.2–0.4), and it took a
    // measurement to stop compromising on it. It sat at 0.62 through two
    // rounds as a "lumped model has no pitch added-inertia" concession, on
    // the assumption that damping the bow harder must at least keep her dry.
    // Swept against the short-crested sea, the opposite is true — median
    // green water over 8 runs: ζ 0.41 → 1.33%, ζ 0.61 → 2.17%, ζ 0.85 →
    // 2.94%. A bow held rigid PLOUGHS a crest; a bow free to lift rides over
    // it. So the physical value is also the one that answers "it dips into
    // the water too heavily", and it costs only pitch MOTION (RMS 4.9° →
    // 6.0° in that severe sea), which is the thing the user asked for more
    // of. Pitch was never the over-damped axis — what suppressed
    // the bow was the probe layout aliasing the swell away (§B.22). With
    // that fixed, ζ 0.29 gave pitch RMS 9.7° in the shipped swell, which is
    // hobby-horsing, not life; 0.41 sits at 3–4°, still ~2.5× the old hull.
    // Bounded ABOVE as well, and by heave, not by taste: past ~0.75 the
    // measured heave RAO in a head sea falls back under 0.7 and the peak
    // immersion climbs again. A bow that cannot pitch cannot ride a wave,
    // so over-damping this axis brings back the complaint it was raised to
    // answer ("dipping into the water too heavily").
    pitchDampingScale: 0.33,
    // ×2 at a gentle swell roll, ×6 at a hard one, ×25+ in a storm. Raised
    // from 10 when the hull got its real displacement (§B.27): giving the
    // stations a BODY means the ones over a trough still make torque, which
    // is right, and roughly doubled the roll forcing — storm went back to
    // 180°. Measured trade at swell: q10 → roll RMS 10.5°, q25 → 7.4°,
    // q50 → 5.9°; storm max 60° / 40° / 30°. 25 keeps the swing and stops
    // the capsize.
    quadraticDampingRate: 25,
    // 0.3 g of the surface slope: she gains ~1 m/s running down the face of
    // a swell and loses it climbing the next. Full 1.0 would be a raft;
    // a displacement hull spends most of it on added mass and wave-making.
    waveSurgeGain: 0.3,
    // 604 t. The single number behind "it feels a little bit too light":
    // she was 150 t, where a 35 m × 8.5 m galleon displaces 500–700 t, and
    // every inertia had been inflated to get ship-like periods out of a
    // dinghy-weight hull (pitch gyradius 0.73·L, roll 1.32·B — both roughly
    // 3× anything that floats). Derived, not guessed: it is the displacement
    // that floats this waterplane at the ride height the rest of the game
    // already reads, M = K·(immersion + draft)/g.
    mass: 6.04e5,
    // 2× displacement of entrained water: heave T 1.3 s → 2.3 s. Draft is
    // spring/mass-locked, so this is the ONLY knob that slows heave
    // without floating the ship higher or drowning the deck.
    addedMassHeave: 2,
    // 1 = the entrained water is fully developed by the time a section is in
    // to its design draft, which is the shallowest ramp that leaves a
    // FLOATING hull untouched (she rests 2.44 m in, past the 2.0 m ramp, so
    // draft, heave period and trim are all bit-identical to the step model).
    // It is also the gentlest: peak entry retardation goes as 1/depth, and
    // shortening the ramp is the knob for a harder bang if one is wanted.
    slamEntryDepth: 1,
    // MEASURED, and the two populations are two orders of magnitude apart, so
    // the gate is not a judgement call. The entry exchange is really an
    // AIRBORNE RE-ENTRY detector: a hull that stays in the water entrains
    // almost nothing new tick to tick, so riding the sea it reads p99 0.0016
    // m/s in the shipped swell (worst 0.0036 over 80 s) and p99 0.011 in
    // storm (worst 0.026) — while a 4 m drop onto flat calm takes 0.44 m/s in
    // ONE tick. So the lens is still in the shipped sea by an order of
    // magnitude, twitches on the hardest storm re-entries, and is hit
    // properly when she has actually been in the air. That is the right
    // shape: shake means "she came down", not "there are waves".
    slamShakeFloor: 0.02,
    slamShakeFull: 0.3,
    // 1 = the geometry's own answer, and it is not a small correction: the
    // station field gives Σa·z² = 66.79 m² and Σa·x² = 4.77 m², so the
    // 1208 t of entrained water adds A55 = 8.07e7 and A44 = 5.77e6 — 1.7×
    // the hull's own pitch inertia and 0.65× its roll inertia.
    addedInertiaScale: 1,
    // RIGID BODY ONLY, at a real ship's gyradii — 0.25·L in pitch (real
    // 0.24–0.27) and 0.45·B in roll (0.35–0.45 for a merchant hull; a
    // square-rigger carries a lot of weight aloft, so the top of it).
    //
    // These used to be 8.55e7 / 1.39e7, i.e. 0.34·L and 0.56·B, and the
    // excess WAS the entrained water — §B.27 derived them by holding the
    // periods fixed, so whatever the model was missing ended up inside the
    // gyradius where §V.53's dimensionless check could only widen its bounds
    // to accommodate it. Split out, the periods come back on their own and
    // slightly longer, which is the point:
    //   pitch  I 4.76e7 + A 8.07e7 = 1.28e8 over C55 2.01e8 → T 5.02 s
    //   roll   I 8.84e6 + A 5.77e6 = 1.46e7 over C44 1.09e7 → T 7.27 s
    // Pitch was 4.10 s against a heave period of 5.43 s — a hull that pitches
    // half again as fast as it heaves, which is what "it can flip forwards
    // and change its momentum basically instantly" is. Real hulls pitch and
    // heave at about the same period, and now this one does.
    inertiaPitch: 4.76e7,
    inertiaRoll: 8.84e6,
    // Roll/pitch bleed only — buoyancy has not touched yaw since §V.33, so
    // the old "yaw cover" note is stale. Kept small: it is a flat rate
    // decay with no physical partner, and at 0.2 it alone contributed
    // ζ_roll 0.11, over half the target roll damping.
    angularDamping: 0.05,
    // 22 keel stations share the load, so ~4e6 N/m each settles the hull
    // ~0.07 m into the bank at rest: she sits ON it, not in it, and the
    // stations that touch first carry more — that IS the list. Scaled ×4
    // with the hull's corrected 604 t displacement, which is what sets the
    // penetration; the grip she feels (μ·N/m) is mass-independent.
    groundingSpring: 4e6,
    groundingDamping: 8e5,
    // 3× weight = up to ~2 g of upward arrest: she stops hard against a
    // bank and stays there, and cannot be thrown clear of the water
    groundingMaxSupport: 3,
    // μ sets the whole "is she stuck" balance, because sailing subtracts
    // μ·N/m from thrust (grounding.groundGrip). Hard aground the bed takes
    // the full 1.5e5 kg, so the hold is μ·9.81 m/s² against a best-case
    // thrust of thrustScale·wind² = 0.03·wind²: at μ=1 she is held up to
    // ~18 m/s of wind and only a real storm drives her further on, which is
    // what a storm should do. μ=0.5 let a fresh breeze grind her over a
    // mountain — the user's "our sails magically continue to propulse us".
    groundingFriction: 1,
  },
  seaPhysicsMeta(),
);

/**
 * THE BRIGANTINE (§T.73) — ship 1. She is built from the SAME loft family as
 * the galleon (`hullMath`: one `hullEnvelope`, one `sectionHalf`), so her
 * block coefficient IS the galleon's, and every hull-form number here is the
 * galleon's scaled by her own dimensions — read from `brigantineParams`, and
 * nothing else typed in:
 *   plan          waterlineOf(brigantineParams): bow 16.2 / stern −14.14 /
 *                 half-beam 3.6 → L_wl 30.34 m on the galleon's 35.5
 *   draft/freeb.  1.7 / 1.8 m, her loft's own
 *   A_wp ratio    s = (L_wl·B)_b/(L_wl·B)_g = 0.724 → spring ρgA_wp 1.76e6
 *   ∇ ratio       r = (L_wl·B·T)_b/(L_wl·B·T)_g = 0.615 → mass 372 t
 *                 (heavier than a historical ~200 t brigantine because her
 *                 authored loft is fuller and beamier than one; she must
 *                 float her OWN loft, not a textbook's)
 *   ride          m·g/K − T = 2.438·(T_b/T_g) − T_b = 0.37 m below her marks,
 *                 the same 0.22·T the galleon floats past hers
 *   damping       c ∝ √(K·M) so ζ (§V.53, dimensionless) is unchanged
 *   inertia       same gyradii (0.25·L_wl pitch, 0.45·B roll): I ∝ m·L²
 *   grounding     spring/damper ∝ mass, so rest penetration is unchanged
 * Everything dimensionless or belonging to the SEA (mirror, slices, kernels,
 * Smith scale, damping ratios, added-mass coefficients, slam thresholds,
 * friction) is carried over as-is.
 */
function brigantineSea(g: SeaPhysicsParams): SeaPhysicsParams {
  const b = waterlineOf(brigantineParams);
  const lwlB = b.bowZ - b.sternZ;
  const lwlG = g.hullBowZ - g.hullSternZ;
  const planRatio = (lwlB * b.halfBeam) / (lwlG * g.hullHalfBeam);
  const volumeRatio = (planRatio * brigantineParams.draft) / g.hullDraft;
  return {
    ...g,
    hullBowZ: b.bowZ,
    hullSternZ: b.sternZ,
    hullHalfBeam: b.halfBeam,
    hullDraft: brigantineParams.draft,
    hullFreeboard: brigantineParams.freeboard,
    buoyancySpring: g.buoyancySpring * planRatio,
    mass: g.mass * volumeRatio,
    buoyancyDamping: g.buoyancyDamping * Math.sqrt(planRatio * volumeRatio),
    inertiaPitch: g.inertiaPitch * volumeRatio * (lwlB / lwlG) ** 2,
    inertiaRoll: g.inertiaRoll * volumeRatio * (b.halfBeam / g.hullHalfBeam) ** 2,
    groundingSpring: g.groundingSpring * volumeRatio,
    groundingDamping: g.groundingDamping * volumeRatio,
  };
}

export const brigantineSeaParams: SeaPhysicsParams = registerParams(
  'sea-brigantine',
  brigantineSea(seaPhysicsParams),
  seaPhysicsMeta(),
);

/**
 * THE RAFT (§T.109 R3e) — Kon-Tiki, nine balsa logs and no loft at all
 * (`hullContact` falls back to the blueprint box). Every hull-form number is
 * read off `raftParams` or `docs/raft2100/kon-tiki-reference.md` §1 and
 * cited per key; `// EST` marks a guess. She floats with her logs HALF
 * submerged [§1 Draft], so the design waterline is the log axis
 * (`logAxisY` = 0), the keel is the log underside one radius below it, and
 * the spring is set so m·g/K lands exactly on that draft — the marks are
 * hers, not a textbook's. `mass` deliberately matches `raftBeachingParams`
 * (15 t: green logs mid-voyage; 20 t is the Oslo 1947 waterlogged figure).
 * Everything belonging to the SEA (mirror, slices, kernels, Smith scale,
 * slam thresholds, friction) is the galleon's, as for the brigantine.
 */
function raftSea(g: SeaPhysicsParams, r: RaftParams = raftParams): SeaPhysicsParams {
  const GRAVITY = 9.81;
  const mass = 15000; // [§1 Weight] ~20 t waterlogged (Oslo 1947); 15 t = raftBeachingParams.mass, one number for buoyancy AND beaching
  const draft = r.logDiameterMax / 2; // [§1 Draft] logs ~half submerged → keel = log underside, one radius (0.3 m) under the axis
  const freeboard = r.logDiameterMax / 2; // [§1 Freeboard] the body ends at the log TOP, 0.3 m up (the 45 cm cabin sill is a structure, not hull)
  const bowZ = r.logCentreLength / 2; // [§1 Centre log] 13.7 m, projecting at both ends
  const sternZ = -r.logCentreLength / 2 - r.sternProjection; // [§1 Stern] three middle logs project ~0.6 m
  const halfBeam = r.crossbeamLength / 2; // [§1 Cross-beams] ~5.5 m long → beam 5–5.5 m [§1 Overall]
  const lwl = bowZ - sternZ;
  // ρ·g·A_wp: nine logs × ~0.55 m mean beam × ~11.4 m mean length ≈ 56 m² → 5.6e5 N/m (EST); the
  // ride-height form m·g/T = 4.9e5 is within 15 % of it and puts her exactly on her marks, so it wins
  const spring = (mass * GRAVITY) / draft;
  const planRatio = spring / g.buoyancySpring;
  const massRatio = mass / g.mass;
  return {
    ...g,
    hullBowZ: bowZ,
    hullSternZ: sternZ,
    hullHalfBeam: halfBeam,
    hullDraft: draft,
    hullFreeboard: freeboard,
    buoyancySpring: spring,
    mass,
    // c ∝ √(K·M) keeps ζ (§V.53) the galleon's; the flat-raft scales below are what differ
    buoyancyDamping: g.buoyancyDamping * Math.sqrt(planRatio * massRatio),
    // EST: a 5.5 m wide slab with no keel and no bilge follows the surface instead of
    // swinging through it — nothing to roll ABOUT. ζ_roll up from 0.09 toward critical.
    rollDampingScale: 0.6,
    /**
     * §T.162 — 0.6 → 1.2. USER: "it feels like we are careening back and
     * forth… our heaving up and down front and back is not really feeling
     * like it should be."
     *
     * The argument was already in this file and only half-applied: nine logs
     * lashed across three crossbeams BEND to a swell, they do not swing
     * against it, and 0.6 (against the galleon's 0.33) was a first step in
     * that direction. Measured peak pitch swing over a minute of the shipped
     * sea: 13.1° at 0.6, 11.4° at 0.9, 10.6° at 1.2, 9.4° at 1.6. 1.2 puts her
     * a fifth calmer than she was BEFORE this task's waterplane change — which
     * on its own cost 1.5° of swing, because her true plan is finer forward
     * than the ellipse it replaced.
     */
    pitchDampingScale: 1.2,
    // gyradii as the galleon's (0.25·L_wl pitch, 0.45·B roll) on 15 t: I ∝ m·L² — low, as a log raft is
    inertiaPitch: mass * (0.25 * lwl) ** 2,
    inertiaRoll: mass * (0.45 * 2 * halfBeam) ** 2,
    /**
     * §T.162 — HER OWN WATERPLANE, off her own logs, and a stern that is
     * genuinely heavier than her bow.
     *
     * `hullPlan` replaces the elliptical galleon curve for this hull only; see
     * `sailing/raftWaterplane.ts` for the measurement that made it necessary.
     * `cgOffsetZ` is the trim on top of it: her cabin, her stern block, her
     * steering oar and her helmsman are all abaft midships, so she floats a
     * little down by the stern. −0.35 m of a 14.3 m hull is about a degree,
     * which is what "a little bit heavier on the back" looks like from the
     * deck — visible in how she meets a swell, not as a slope you stand on.
     */
    hullPlan: raftWaterplane(sternZ, bowZ, halfBeam, r),
    cgOffsetZ: -0.35, // EST — see above
    // spring/damper ∝ mass, so rest penetration in the sand is unchanged (raftBeaching scales the same way)
    groundingSpring: g.groundingSpring * massRatio,
    groundingDamping: g.groundingDamping * massRatio,
  };
}

export const raftSeaParams: SeaPhysicsParams = registerParams(
  'sea-physics-raft',
  raftSea(seaPhysicsParams),
  {
    ...seaPhysicsMeta(),
    mass: { min: 5e3, max: 6e4, step: 500 },
    inertiaPitch: { min: 1e4, max: 1e7, step: 1e4 },
    inertiaRoll: { min: 1e4, max: 1e7, step: 1e4 },
  },
);

function seaPhysicsMeta(): Partial<Record<keyof SeaPhysicsParams, ParamMeta>> {
  return {
    updateEveryTicks: { min: 1, max: 10, step: 1 },
    inverseDisplacementIterations: { min: 0, max: 6, step: 1 },
    hullBowZ: { min: 5, max: 40, step: 0.1 },
    hullSternZ: { min: -40, max: -5, step: 0.1 },
    hullHalfBeam: { min: 1, max: 10, step: 0.05 },
    hullDraft: { min: 0, max: 6, step: 0.05 },
    hullFreeboard: { min: 0, max: 8, step: 0.05 },
    cgOffsetZ: { min: -4, max: 4, step: 0.05 },
    probeLayoutScale: { min: 0.2, max: 3, step: 0.05 },
    probeSlices: { min: 1, max: 32, step: 1 },
    hullFootprintLength: { min: 0, max: 15, step: 0.25 },
    hullFootprintBeam: { min: 0, max: 8, step: 0.25 },
    smithDepthScale: { min: 0, max: 2, step: 0.05 },
    buoyancySpring: { min: 1e5, max: 1.6e7, step: 1e5 },
    buoyancyDamping: { min: 0, max: 1e7, step: 1e4 },
    heaveDampingScale: { min: 0, max: 2, step: 0.01 },
    heaveQuadraticRate: { min: 0, max: 20, step: 0.1 },
    rollDampingScale: { min: 0, max: 2, step: 0.01 },
    pitchDampingScale: { min: 0, max: 2, step: 0.01 },
    quadraticDampingRate: { min: 0, max: 20, step: 0.1 },
    waveSurgeGain: { min: 0, max: 1.5, step: 0.01 },
    mass: { min: 1e4, max: 2e6, step: 1e4 },
    addedMassHeave: { min: 0, max: 6, step: 0.1 },
    slamEntryDepth: { min: 0, max: 3, step: 0.05 },
    slamShakeFloor: { min: 0, max: 2, step: 0.01 },
    slamShakeFull: { min: 0.05, max: 5, step: 0.05 },
    addedInertiaScale: { min: 0, max: 3, step: 0.05 },
    inertiaPitch: { min: 1e5, max: 5e8, step: 1e5 },
    inertiaRoll: { min: 1e5, max: 5e8, step: 1e5 },
    angularDamping: { min: 0, max: 5, step: 0.01 },
    groundingSpring: { min: 0, max: 2e7, step: 1e5 },
    groundingDamping: { min: 0, max: 8e6, step: 1e4 },
    groundingMaxSupport: { min: 1, max: 20, step: 0.1 },
    groundingFriction: { min: 0, max: 3, step: 0.05 },
  };
}
