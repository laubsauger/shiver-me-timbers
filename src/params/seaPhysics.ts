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
  /** scales the canonical ~30 m probe layout to the hull size */
  probeLayoutScale: number;
  /**
   * σ (m) of the fore-aft half of the hull footprint kernel: each probe
   * averages the surface over this patch instead of sampling a point, so
   * waves with λ ≲ 2πσ are averaged away and only swell moves the ship.
   * 0 = point sampling (cork). Raise for a heavier, more selective hull.
   */
  hullFootprintLength: number;
  /** σ (m) of the athwartships half of the same kernel — sets how much
   * short BEAM chop can still roll the ship (long σ can't filter it) */
  hullFootprintBeam: number;
  /** N per meter of probe submersion (per probe) */
  buoyancySpring: number;
  /** N·s/m vertical damping at each submerged probe */
  buoyancyDamping: number;
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
    // Footprint σ vs the real hull (35 m × 8.5 m): fore-aft 5 m spans
    // ±7.5 m of the 19 m half-length, athwartships 3.5 m spans ±5.25 m vs
    // the 4.25 m half-beam (the extra covers the isotropic e^(−k·draft)
    // pressure falloff, which the panel width alone can't stand in for).
    // Measured heave response: λ6m→0.02, λ10m→0.00, λ25m→0.29, λ60m→0.40
    // (hull-straddle cancellation), λ100m→0.71, λ250m→0.97.
    hullFootprintLength: 5,
    hullFootprintBeam: 3.5,
    // spring/mass ratio sets ride height — user report: deck awash, waves
    // constantly breaking over the ship → stiffer spring, lighter hull
    buoyancySpring: 4.2e5,
    // ζ_heave ≈ 0.9 with the added mass below. Raised from 1.6e5 (ζ 0.5)
    // on the user report "sometimes we're losing contact with the waves —
    // we start to fly a little bit early": at 8 m/s in a beam or following
    // sea the stem's keel line was clear of the water 13% of the time, and
    // damping was the only lever that moved it (13.1 → 9.1%, pitch p95 6.1
    // → 4.7°). It costs nothing in feel because this damper works RELATIVE
    // to the surface: more of it means the hull tracks the swell's motion
    // more closely, so the vertical accel RMS went DOWN too (1.01 → 0.88).
    // Past ~4e5 the hull starts to sit in the water rather than ride it
    // (swell tracking 0.94 → 0.82) — the old "way too static" complaint.
    buoyancyDamping: 2.8e5,
    mass: 1.5e5,
    // 2× displacement of entrained water: heave T 1.3 s → 2.3 s. Draft is
    // spring/mass-locked, so this is the ONLY knob that slows heave
    // without floating the ship higher or drowning the deck.
    addedMassHeave: 2,
    // Rotational feel (probe layout spans the galleon, Σz²≈1432 Σx²≈97):
    // pitch ω=√(k·Σz²/I)≈1.65 rad/s (T≈3.8 s, ζ≈0.30) — the bow takes a
    // couple of seconds to lift into a swell and a couple to come down;
    // at 6e7 (T≈2 s) it followed the water surface almost rigidly.
    // roll ω≈0.9 rad/s → the target 6-8 s roll period, ζ≈0.17 so beam
    // swells (same band) actually roll the ship and it swings a few
    // cycles before settling.
    inertiaPitch: 2.2e8,
    inertiaRoll: 5e7,
    // light global decay only (yaw cover) — 0.65 added ζ≈0.36 to roll and
    // pinned the ship upright through storms ("way too static")
    angularDamping: 0.2,
    // 22 keel stations share the load, so ~1e6 N/m each settles the hull
    // ~0.07 m into the bank at rest: she sits ON it, not in it, and the
    // stations that touch first carry more — that IS the list.
    groundingSpring: 1e6,
    groundingDamping: 2e5,
    // μ=0.5: a light touch at 8 kn scrubs speed off over a couple of
    // seconds, a hard one stops her; higher reads as hitting a wall
    groundingFriction: 0.5,
  },
  {
    updateEveryTicks: { min: 1, max: 10, step: 1 },
    inverseDisplacementIterations: { min: 0, max: 6, step: 1 },
    probeLayoutScale: { min: 0.2, max: 3, step: 0.05 },
    hullFootprintLength: { min: 0, max: 15, step: 0.25 },
    hullFootprintBeam: { min: 0, max: 8, step: 0.25 },
    buoyancySpring: { min: 1e4, max: 2e6, step: 1e4 },
    buoyancyDamping: { min: 0, max: 5e5, step: 1e3 },
    mass: { min: 1e4, max: 2e6, step: 1e4 },
    addedMassHeave: { min: 0, max: 6, step: 0.1 },
    inertiaPitch: { min: 1e5, max: 5e8, step: 1e5 },
    inertiaRoll: { min: 1e5, max: 5e8, step: 1e5 },
    angularDamping: { min: 0, max: 5, step: 0.01 },
    groundingSpring: { min: 0, max: 5e6, step: 1e4 },
    groundingDamping: { min: 0, max: 2e6, step: 1e4 },
    groundingFriction: { min: 0, max: 3, step: 0.05 },
  },
);
