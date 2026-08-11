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
  /** N per meter of probe submersion (per probe) */
  buoyancySpring: number;
  /** N·s/m vertical damping at each submerged probe */
  buoyancyDamping: number;
  /** ship mass kg */
  mass: number;
  /** inertia tensor diagonal, body frame — pitch about x (beam axis) */
  inertiaPitch: number;
  /** yaw about y (up axis) */
  inertiaYaw: number;
  /** roll about z (forward axis) */
  inertiaRoll: number;
  /** global angular velocity decay 1/s (covers yaw, which probes can't damp) */
  angularDamping: number;
}

export const seaPhysicsParams: SeaPhysicsParams = registerParams(
  'seaPhysics',
  {
    mirrorResolution: 64,
    updateEveryTicks: 1,
    inverseDisplacementIterations: 3,
    probeLayoutScale: 1,
    // spring/mass ratio sets ride height — user report: deck awash, waves
    // constantly breaking over the ship → stiffer spring, lighter hull
    buoyancySpring: 4.2e5,
    buoyancyDamping: 9e4,
    mass: 1.5e5,
    // Rotational feel (probe layout spans the galleon, Σz²≈1417 Σx²≈97):
    // pitch ω=√(k·Σz²/I)≈3.1 rad/s (T≈2s, ζ≈0.37) — ponderous slope-
    // tracking: bow rises into swells with visible lag, no dinghy-snap.
    // roll ω≈0.9 rad/s → the target 6-8s roll period, ζ≈0.2 so beam
    // swells (same band) actually roll the ship and it swings a few
    // cycles before settling.
    inertiaPitch: 6e7,
    inertiaYaw: 2.4e7,
    inertiaRoll: 5e7,
    // light global decay only (yaw cover) — 0.65 added ζ≈0.36 to roll and
    // pinned the ship upright through storms ("way too static")
    angularDamping: 0.2,
  },
  {
    updateEveryTicks: { min: 1, max: 10, step: 1 },
    inverseDisplacementIterations: { min: 0, max: 6, step: 1 },
    probeLayoutScale: { min: 0.2, max: 3, step: 0.05 },
    buoyancySpring: { min: 1e4, max: 2e6, step: 1e4 },
    buoyancyDamping: { min: 0, max: 5e5, step: 1e3 },
    mass: { min: 1e4, max: 2e6, step: 1e4 },
    inertiaPitch: { min: 1e5, max: 1e8, step: 1e5 },
    inertiaYaw: { min: 1e5, max: 1e8, step: 1e5 },
    inertiaRoll: { min: 1e5, max: 1e8, step: 1e5 },
    angularDamping: { min: 0, max: 5, step: 0.01 },
  },
);
