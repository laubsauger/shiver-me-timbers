/**
 * Wake source adapters (§T W2a, docs/wake/w2a-source-model.md §3) — every
 * producer reduces to the ONE `HydroSample` contract the solver splats:
 *
 *   { x, z, fy, footprint, depth }   world plan position (m), vertical force
 *   this sample carried (N, ≥ 0), plan footprint radius √A/2 (m), and the
 *   depth below the local surface at which that force acts (m).
 *
 * Nothing here is a wake parameter: each field is read off the hull's own
 * contact model, so amplitude, footprint and attenuation all belong to the
 * vessel (V-W2 / proposed V101: one contact, many consumers).
 *
 *  - `stationSamples`   galleon, brigantine, raft: the buoyancy quadrature
 *                       (18 slices × 3 Gauss points, `probeStations`) at a
 *                       GIVEN pose, for engine-free tows (calibration, pond).
 *                       In game, `stepShipBuoyancy(..., wakeOut)` emits the
 *                       same samples from its own loop (§T W2b).
 *  - `hullWaterSamples` speedboat: the plan-column wake load of
 *                       `HullWater.evaluate()` (`hw.wake`, hullWater.ts
 *                       `WakeLoadSamples`: every fy ≥ 0, Σ = max(0, net load)).
 *  - `planingPatchSamples` a Savitsky-sized planing proxy for the pond only,
 *                       until a trimmed 6DOF speedboat pose exists to feed
 *                       `hullWaterSamples` (W4).
 *
 * §V77 CLOSED (§T W2b): `stationSamples` is a thin reader. The immersion
 * rule (`immersedDepth`) and the sample itself (`writeStationSample`) are
 * buoyancy.ts's own exports; this file only places the stations at a pose and
 * reads a head. Unlike the in-loop emission it reads `ship.quaternion` as
 * given (buoyancy re-applies a remembered pitch when sailing stripped it) and
 * a point head (buoyancy may footprint-average) — a tow has neither.
 */
import { rotateVec } from '../core/quat';
import { GRAVITY } from '../ocean/oceanMath';
import type { SeaPhysicsParams } from '../params/seaPhysics';
import { immersedDepth, probeStations, sizeStationSamples, writeStationSample } from '../sea-physics/buoyancy';
import { buoyancyScale } from '../sea-physics/flooding';
import type { WakeLoadSamples } from '../sea-physics/hullWater';
import type { ShipState } from '../state/simState';
import { type HydroSample } from './wakeSolverMath';

/** pressure-head elevation of the ambient sea at world (x, z), m — flat calm when omitted */
export type HeadSampler = (x: number, z: number) => number;

const FLAT_SEA: HeadSampler = () => 0;

const sized = sizeStationSamples;

/**
 * The ship's buoyancy stations as wake samples. One sample per station,
 * in `probeStations` order (stern→bow slices, port/centre/starboard).
 *
 *   immersion  = clamp(head − station y + hullDraft, 0, hullDraft + hullFreeboard)
 *                (buoyancy.ts `immersedDepth`, the slice's own body — §B.27)
 *   fy         = buoyancySpring · immersion · weight · support   (Σ = hydrostatic ΣF_y)
 *   footprint  = √(weight · A_wp)/2,  A_wp = buoyancySpring/(ρg)
 *   depth      = immersion · smithDepthScale — the keel depth the station's
 *                pressure acts at, the same depth §V68 attenuates the sea by
 *
 * `head` should be the sampler buoyancy integrates (`pressureHeadAt`), not the
 * drawn surface, and — per proposed V111 — never this hull's own wake.
 */
export function stationSamples(
  ship: Readonly<ShipState>,
  p: SeaPhysicsParams,
  out: HydroSample[] = [],
  head: HeadSampler = FLAT_SEA,
): HydroSample[] {
  const stations = probeStations(p.probeSlices, p).stations;
  sized(out, stations.length);
  const q = ship.quaternion;
  const pos = ship.position;
  const support = buoyancyScale(ship as ShipState);
  const scale = p.probeLayoutScale;
  for (let i = 0; i < stations.length; i++) {
    const st = stations[i];
    const r = rotateVec(q, [st.local[0] * scale, st.local[1] * scale, st.local[2] * scale]);
    const x = pos[0] + r[0];
    const z = pos[2] + r[2];
    writeStationSample(out[i], st.weight, x, z, immersedDepth(head(x, z) - (pos[1] + r[1]), p), support, p);
  }
  return out;
}

/**
 * The speedboat contact's wake load as wake samples (hullWater.ts
 * `WakeLoadSamples`, `hw.wake`: signed wet-triangle loads summed per 0.8 m
 * plan column, plan-area-weighted position and depth). A straight copy — the
 * producer already guarantees every fy ≥ 0 and Σ fy = max(0, load.force[1]),
 * so the §W2a signed-fy gap (a downward-facing wet triangle clamped to 0 by
 * `WakeSourceBuffer`, over-counting ∫ρg·h dA under a buried bow or an inverted
 * landing) is closed at the source (§V101: one contact result, many consumers).
 */
export function hullWaterSamples(wake: Readonly<WakeLoadSamples>, out: HydroSample[] = []): HydroSample[] {
  sized(out, wake.count);
  for (let j = 0; j < wake.count; j++) {
    const s = out[j];
    s.x = wake.x[j];
    s.z = wake.z[j];
    s.fy = wake.fy[j];
    s.footprint = wake.sigma[j];
    s.depth = wake.depth[j];
  }
  return out;
}

export interface PlaningPatch {
  /** displacement mass carried by dynamic lift, kg */
  mass: number;
  /** chine beam, m */
  beam: number;
  /** Savitsky mean wetted length λ·b, m */
  wettedLength: number;
  /** running trim, rad */
  trim: number;
}

/**
 * POND PROXY for a planing hull (§T W2a; not a contact model). Weight m·g on a
 * rectangle `wettedLength` × `beam` ahead of the transom, 8 × 3 samples,
 * pressure rising linearly from 0 at the transom (dry-transom Kutta) to the
 * stagnation line; depth = keel immersion (l − ξ)·tan τ. Transom at (x, z),
 * running along the unit (fx, fz). Numbers come from the Savitsky oracle in
 * docs/speedboat/tech-research.md §2.4 — replace with `hullWaterSamples` when
 * a trimmed speedboat pose exists (W4).
 */
export function planingPatchSamples(
  patch: PlaningPatch,
  x: number,
  z: number,
  fx: number,
  fz: number,
  out: HydroSample[] = [],
): HydroSample[] {
  const along = 8;
  const across = 3;
  sized(out, along * across);
  const len = Math.hypot(fx, fz) || 1;
  const ux = fx / len;
  const uz = fz / len;
  const dl = patch.wettedLength / along;
  const db = patch.beam / across;
  let wsum = 0;
  for (let a = 0; a < along; a++) wsum += (a + 0.5) / along;
  const weight = patch.mass * GRAVITY;
  for (let a = 0; a < along; a++) {
    const xi = (a + 0.5) * dl; // from the transom
    const share = ((a + 0.5) / along / wsum) / across;
    for (let c = 0; c < across; c++) {
      const side = (c - (across - 1) / 2) * db;
      const s = out[a * across + c];
      s.x = x + ux * xi - uz * side;
      s.z = z + uz * xi + ux * side;
      s.fy = weight * share;
      s.footprint = 0.5 * Math.sqrt(dl * db);
      s.depth = (patch.wettedLength - xi) * Math.tan(patch.trim);
    }
  }
  return out;
}
