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
    buoyancySpring: 2.5e5,
    buoyancyDamping: 6e4,
    mass: 2e5,
    inertiaPitch: 1.6e7,
    inertiaYaw: 1.6e7,
    inertiaRoll: 1.5e6,
    angularDamping: 0.4,
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
