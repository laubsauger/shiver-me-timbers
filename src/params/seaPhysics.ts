/**
 * Sea-physics tunables (§V.8, §V.16): CPU spectrum mirror + ship buoyancy.
 * Mirror params control fidelity/cost of the CPU ocean copy; the rest are
 * rigid-body constants for the buoyancy integrator.
 */
import { registerParams } from './registry';

export interface SeaPhysicsParams {
  /** CPU mirror grid N×N, power of two ≤ ocean resolution (§V.8) */
  mirrorResolution: number;
  /** re-run CPU spectrum+IFFT every K sim ticks (grids cached between) */
  updateEveryTicks: number;
  /** fixed-point iterations for inverse-displacement height lookup */
  inverseDisplacementIterations: number;
  /** scales the canonical ~35 m station layout to the hull size */
  probeLayoutScale: number;
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
   * σ (m) of the athwartships footprint kernel — the Smith effect
   * (e^(−k·draft) pressure decay) as a Gaussian patch. This is the ONLY
   * thing keeping short beam chop from rolling the ship: 8.5 m of beam has
   * no length to integrate a 17 m wave away with.
   */
  hullFootprintBeam: number;
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
  /** N per meter of submersion for the WHOLE waterplane (ρ·g·A_wp; station
   * weights sum to 1, so this and the mass set the ride height together:
   * immersion = mass·g/spring − hullDraft) */
  buoyancySpring: number;
  /** N·s/m vertical damping for the whole waterplane — HEAVE damping.
   * Roll and pitch take scaled shares of it, see below */
  buoyancyDamping: number;
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
  /** inertia tensor diagonal, body frame — pitch about x (beam axis) */
  inertiaPitch: number;
  /** roll about z (forward axis) */
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

export const seaPhysicsParams: SeaPhysicsParams = registerParams(
  'seaPhysics',
  {
    mirrorResolution: 64,
    updateEveryTicks: 1,
    inverseDisplacementIterations: 3,
    probeLayoutScale: 1,
    // 18 slices = 1.97 m apart over the 35.5 m waterline: 4.2 samples per
    // wavelength at the shortest mirrored wave (λ 8.3 m, cascade 2 is not
    // mirrored), so the length integral is honest across the whole band the
    // mirror carries. Measured: past ~18 the count stops buying anything
    // (24 and 32 slices move an 8 m ripple's pitch by 2%), because what is
    // left at that wavelength is not quadrature error — it is the hull
    // genuinely feeling the ripple, and the fore-aft footprint below is the
    // thing that answers it.
    probeSlices: 18,
    // fore-aft: the hull's own length integral does most of this now
    // (§B.22), but not all — 1.5 m of panel/Smith averaging cuts what an
    // 8 m ripple can pitch the hull by almost in half (0.29° → 0.17°) and
    // costs the swell nothing measurable (heave RAO at λ 40/90/150 moves
    // 0.312→0.305, 0.962→0.958, 1.081→1.079, i.e. under half a percent)
    hullFootprintLength: 1.5,
    // athwartships: the Smith effect, e^(−k·2 m draft) ≈ exp(−k²·3.5²/2)
    // over λ 10–25 m — response λ10→0.09, λ17→0.48, λ25→0.75, λ60→0.95
    hullFootprintBeam: 3.5,
    // the galleon's own loft (params/ship): keel 2.0 m below the design
    // waterline, deck 2.6 m above it
    hullDraft: 2.0,
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
    // Linear half of the roll damping. Small, because most of this hull's
    // roll damping is meant to come from the quadratic term below: at the
    // swell's roll rates the pair lands at ζ ≈ 0.11 (a galleon swings 5+
    // cycles after a wave knocks her over — the single loudest cue that
    // she is a ship and not a prop), and at storm rates at ζ ≈ 0.6, which
    // is what keeps her the right way up. At 1.0, sharing heave's damper,
    // it measured 0.41 flat: dead in a cycle and a half.
    rollDampingScale: 0.09,
    // ζ_pitch 0.41. Pitch was never the over-damped axis — what suppressed
    // the bow was the probe layout aliasing the swell away (§B.22). With
    // that fixed, ζ 0.29 gave pitch RMS 9.7° in the shipped swell, which is
    // hobby-horsing, not life; 0.41 sits at 3–4°, still ~2.5× the old hull.
    // Bounded ABOVE as well, and by heave, not by taste: past ~0.75 the
    // measured heave RAO in a head sea falls back under 0.7 and the peak
    // immersion climbs again. A bow that cannot pitch cannot ride a wave,
    // so over-damping this axis brings back the complaint it was raised to
    // answer ("dipping into the water too heavily").
    pitchDampingScale: 0.5,
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
    // Rotational feel. The station weights sum to 1, so the waterplane's
    // second moments are Σw·z² = 82.97 m² and Σw·x² = 4.48 m² — both an
    // order of magnitude below the old 8-probe layout's, because that
    // layout hung every probe at the FULL half-beam and both ends of the
    // hull (a rectangular strip's equivalent lever is b/√3, not b).
    // Inertias are re-derived to hold the same periods:
    // pitch ω=√(2.43e6·82.66/I)=1.53 rad/s → T 4.1 s, gyradius 0.34·L
    // roll  ω=√(2.43e6·4.49/I)=0.89 rad/s → T 7.1 s, gyradius 0.56·B
    // Both gyradii are now within reach of a real rigged ship (0.24–0.27·L,
    // 0.35–0.45·B, and a galleon carries a lot of weight aloft). At the old
    // 150 t mass the SAME periods demanded 0.73·L and 1.32·B.
    inertiaPitch: 8.55e7,
    inertiaRoll: 1.39e7,
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
  {
    updateEveryTicks: { min: 1, max: 10, step: 1 },
    inverseDisplacementIterations: { min: 0, max: 6, step: 1 },
    hullDraft: { min: 0, max: 6, step: 0.05 },
    hullFreeboard: { min: 0, max: 8, step: 0.05 },
    probeLayoutScale: { min: 0.2, max: 3, step: 0.05 },
    probeSlices: { min: 1, max: 32, step: 1 },
    hullFootprintLength: { min: 0, max: 15, step: 0.25 },
    hullFootprintBeam: { min: 0, max: 8, step: 0.25 },
    buoyancySpring: { min: 1e5, max: 1.6e7, step: 1e5 },
    buoyancyDamping: { min: 0, max: 1e7, step: 1e4 },
    rollDampingScale: { min: 0, max: 2, step: 0.01 },
    pitchDampingScale: { min: 0, max: 2, step: 0.01 },
    quadraticDampingRate: { min: 0, max: 20, step: 0.1 },
    waveSurgeGain: { min: 0, max: 1.5, step: 0.01 },
    mass: { min: 1e4, max: 2e6, step: 1e4 },
    addedMassHeave: { min: 0, max: 6, step: 0.1 },
    inertiaPitch: { min: 1e5, max: 5e8, step: 1e5 },
    inertiaRoll: { min: 1e5, max: 5e8, step: 1e5 },
    angularDamping: { min: 0, max: 5, step: 0.01 },
    groundingSpring: { min: 0, max: 2e7, step: 1e5 },
    groundingDamping: { min: 0, max: 8e6, step: 1e4 },
    groundingMaxSupport: { min: 1, max: 20, step: 0.1 },
    groundingFriction: { min: 0, max: 3, step: 0.05 },
  },
);
