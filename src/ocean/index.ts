/**
 * Ocean system entry (§V.4, §V.19, §V.20).
 * Usage:
 *   const ocean = createOceanSim(seed);
 *   // per frame, before main render:
 *   ocean.update(renderer, state.time);
 *   // materials sample:
 *   ocean.cascades[i].displacement  // (λ·Dx, h, λ·Dz, jacobian)
 *   ocean.cascades[i].derivatives   // (∂h/∂x, ∂h/∂z, ∂Dx/∂x, ∂Dz/∂z)
 *   ocean.cascades[i].domain        // world tiling size (m)
 */
export { OceanSimulation, OceanCascade } from './oceanCascades';
export { oceanParams } from '../params/ocean';
import { OceanSimulation } from './oceanCascades';

export function createOceanSim(seed: number): OceanSimulation {
  return new OceanSimulation(seed);
}
