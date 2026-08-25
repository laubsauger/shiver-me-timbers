/**
 * §T.162/§V71 — THE RAFT'S OWN WATERPLANE, read off her own logs.
 *
 * USER: "it feels like the front wants to go down and the back kind of has
 * more buoyancy to it than it should… way too light in the back, which would
 * be weird because it's probably the heaviest part of the ship."
 *
 * He was describing a galleon. `buoyancy.halfBreadth` is one elliptical curve
 * — pointed at the stem, floored at 0.55 of the beam across the transom — and
 * every hull in the game floated on it, this raft included. Measured against
 * her real log plan, that curve is wrong at both ends and wrong in opposite
 * directions:
 *
 *   station u:   −1.00   −0.83   −0.50    0.00    0.50    0.83
 *   her logs:     0.00    0.31    0.91    0.91    0.69    0.10
 *   the ellipse:  0.55    0.55    0.87    1.00    0.87    0.55
 *
 * At the extreme stern it invents 0.55 of the beam where only three logs
 * project and the true breadth has already gone to nothing — the "more
 * buoyancy in the back than it should have" the user felt, exactly. Forward it
 * is fuller than her logs are, so the bow is modelled stiffer than it is and
 * the pair together put the pivot in the wrong place: she careens.
 *
 * So the plan comes from the blueprint's own log stations, sampled once. This
 * is §V71 in the water: a part positioned against another system's surface
 * resolves against THAT surface's evaluator, never against a curve that
 * happened to fit a different ship.
 */
import { raftParams, type RaftParams } from '../params/raft';
import { logHalfAt } from '../ship/raftPartsHull';
import { raftLayout, type RaftLayout } from '../ship/raftPartsLayout';

/**
 * Samples from the stern (u = −1) to the bow (u = +1), each the half-breadth
 * at that station as a fraction of `hullHalfBeam`. Odd count so a sample lands
 * exactly amidships.
 */
export const RAFT_PLAN_SAMPLES = 33;

/**
 * The WETTED breadth, not the outer extent: buoyancy is a waterplane integral
 * and the water between two logs is not displaced by anything. Σ of the logs'
 * own widths at the station, over the full beam.
 */
export function raftWaterplane(
  sternZ: number,
  bowZ: number,
  halfBeam: number,
  p: RaftParams = raftParams,
  L: RaftLayout = raftLayout(),
): number[] {
  const out: number[] = [];
  const beam = Math.max(1e-6, 2 * halfBeam);
  for (let i = 0; i < RAFT_PLAN_SAMPLES; i++) {
    const u = -1 + (2 * i) / (RAFT_PLAN_SAMPLES - 1);
    const z = (sternZ + bowZ) / 2 + u * ((bowZ - sternZ) / 2);
    let wetted = 0;
    for (const log of L.logs) {
      if (z > log.zBow || z < log.zStern) continue;
      wetted += 2 * logHalfAt(p, log, z);
    }
    out.push(Math.min(1, wetted / beam));
  }
  return out;
}
