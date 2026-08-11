/**
 * Flooding tunables (§V14, §V16). Consumed by src/sea-physics/flooding.ts;
 * flood level lives in SimState.ships[].flood (plain data, §V2) — these
 * only shape how fast water comes in, how hard the crew pumps, and how the
 * sink sequence plays out once the ship is past saving.
 */
import { registerParams } from './registry';

export interface FloodingParams {
  /** flood fraction/s added per submerged hole right at the waterline */
  ingressRatePerHole: number;
  /** extra ingress per meter of hole depth below the waterline (1/m) */
  depthFactor: number;
  /** flood fraction/s the crew pumps out (keeps early hits recoverable) */
  pumpRate: number;
  /** flood ≥ this → 'sinking': pumps overwhelmed, sequence is one-way */
  sinkThreshold: number;
  /** seconds from crossing sinkThreshold to fully sunk (flood = 1) */
  sinkDuration: number;
  /** list/trim torque N·m per meter of mean hole offset at full flood */
  listStrength: number;
  /** extra mass fraction at full flood (floodMassFactor = 1 + gain·flood) */
  massGain: number;
}

export const floodingParams: FloodingParams = registerParams(
  'flooding',
  {
    ingressRatePerHole: 0.02,
    depthFactor: 0.5,
    pumpRate: 0.03,
    sinkThreshold: 0.6,
    sinkDuration: 12,
    listStrength: 3e5,
    massGain: 0.8,
  },
  {
    ingressRatePerHole: { min: 0, max: 0.2, step: 0.005 },
    depthFactor: { min: 0, max: 3, step: 0.05 },
    pumpRate: { min: 0, max: 0.2, step: 0.005 },
    sinkThreshold: { min: 0.1, max: 0.95, step: 0.05 },
    sinkDuration: { min: 1, max: 60, step: 1 },
    listStrength: { min: 0, max: 2e6, step: 1e4 },
    massGain: { min: 0, max: 3, step: 0.05 },
  },
);
