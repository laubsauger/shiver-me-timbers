/**
 * The in-game driver of the GPU wake (§T W2b, docs/wake/w2b-integration.md):
 * the one place the sim tick and the render frame meet the solver.
 *
 *   tick(pose, samples, bowAhead, dt)   FIXED TICK (§V2). Anchors the domain on
 *                                       the hero vessel's SIM pose (§V105, never
 *                                       the camera), uploads that tick's
 *                                       HydroSamples, and banks the sim time.
 *   step(renderer)                      RENDER FRAME. At most ONE splat + ONE
 *                                       compute group (§V104), advanced by the
 *                                       sim time banked since the last dispatch,
 *                                       and nothing at all when no tick ran.
 *
 * WHY THE SPLIT. §V2 wants the wake advanced by sim time, §V104 wants one
 * compute group per frame, and the loop runs 0..N ticks per frame. Stepping
 * inside the tick would dispatch N groups on a slow frame; stepping on frame
 * time would make the pattern a function of the frame rate. Banking tick dt
 * and dispatching once gives both: the GPU integrates exactly the sim seconds
 * that elapsed, in one group. The integrator is exact for any Δt (§V103), so
 * merging ticks changes quality (forcing held over the merged step), not
 * physics. A frame slower than WAKE_MAX_DT (10 fps) drops the excess — the
 * wake is visual-only (§V8 amendment), so a hitch cannot desync a hull.
 *
 * §V28: a non-finite pose leaves the centre where it was (`setCenter` guards)
 * and a vessel with any non-finite sample is dropped whole
 * (`WakeSourceBuffer.pushVessel`); a non-finite or negative dt banks nothing.
 */
import type * as THREE from 'three/webgpu';
import { rotateVec } from '../core/quat';
import { WakeSolverGpu } from './wakeSolverPasses';
import { WakeSourceBuffer, splatSigma, wakeAnchor, type HydroSample } from './wakeSolverMath';

export interface WakeSimTier {
  /** grid resolution (power of two) */
  n: number;
  /** texel size (m) */
  texel: number;
}

/** the hero pose the domain anchors on — ShipState's own fields */
export interface WakeSimPose {
  readonly position: readonly number[];
  readonly quaternion: readonly number[];
}

export class WakeSim {
  readonly solver: WakeSolverGpu;
  readonly sources: WakeSourceBuffer;
  /** sim seconds banked by ticks since the last dispatch */
  private pendingDt = 0;
  /** a tick ran since the last dispatch (a centre move needs its scroll dispatched) */
  private dirty = false;

  constructor(tier: WakeSimTier) {
    this.solver = new WakeSolverGpu({ n: tier.n, texel: tier.texel });
    this.sources = new WakeSourceBuffer();
  }

  /**
   * FIXED TICK. `bowAhead` is the stem's distance forward of the vessel origin
   * along her hull axis (m) — the anchor keeps the bow wave out of the front
   * sponge (`wakeAnchor`). The domain is a function of sim state only.
   */
  tick(pose: WakeSimPose, samples: readonly HydroSample[], bowAhead: number, dt: number): void {
    const { solver } = this;
    const fwd = rotateVec(pose.quaternion as [number, number, number, number], [0, 0, 1]);
    const clearance = 4 * splatSigma(0, solver.texel, solver.n);
    const c = wakeAnchor(pose.position[0], pose.position[2], fwd[0], fwd[2], bowAhead, solver.domain, solver.sponge, clearance);
    solver.setCenter(c.x, c.z);
    this.sources.clear();
    this.sources.pushVessel(samples);
    solver.setSources(this.sources);
    if (Number.isFinite(dt) && dt > 0) this.pendingDt += dt;
    this.dirty = true;
  }

  /** RENDER FRAME: one splat + one compute group if a tick ran; returns whether it dispatched */
  step(renderer: THREE.WebGPURenderer): boolean {
    if (!this.dirty) return false;
    this.solver.step(renderer, this.pendingDt);
    this.pendingDt = 0;
    this.dirty = false;
    return true;
  }

  dispose(): void {
    this.solver.dispose();
  }
}
