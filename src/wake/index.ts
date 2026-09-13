/**
 * Shared hull-sampled wake (docs/wake/wake-research.md). W1: the eWave solver
 * in isolation — CPU reference + GPU twin + source buffer. W2a
 * (docs/wake/w2a-source-model.md): the source contract (keel-depth pressure
 * samples) and the station / hull-water adapters. W2b
 * (docs/wake/w2b-integration.md): `WakeSim`, the tick/frame driver flowfoam
 * owns when a page selects `wakeBackend: 'sim'` (raft first). The pond harness
 * is /src/wake/preview.html.
 */
export {
  WAKE_ETA_CLAMP,
  WAKE_MAX_DT,
  WAKE_MAX_SAMPLES,
  WAKE_RHO,
  WakeSolverCpu,
  WakeSourceBuffer,
  sourceDepthAttenuation,
  type HydroSample,
  type WakeSolverOptions,
  type WakeSpongeParams,
} from './wakeSolverMath';
export { WakeSolverGpu, wakeDispatchCount, type WakeSolverGpuOptions } from './wakeSolverPasses';
export { hullWaterSamples, stationSamples, type HeadSampler } from './stationSources';
export { WAKE_RAFT_TIER, WAKE_SHIP_TIER, stationFrame } from './wakeCalibration';
export { WakeSim, type WakeSimPose, type WakeSimTier } from './wakeSim';
