/**
 * Raft layout — the resolved stations every raft part builder (and the raft
 * deck-field writer, §V83) reads from ONE place: where each log lies, how wide
 * each chink is, and the three deck heights (§V83: logs, mats, cabin floor).
 *
 * Pure function of raftParams; chinks and diameters come from variation.ts
 * hashes keyed on the seed, never Math.random (§V2).
 */
import { raftParams, type RaftParams } from '../params/raft';
import { vrange } from './variation';

export interface LogStation {
  /** index from port (−4) to starboard (+4); 0 = centre log */
  i: number;
  /** centreline x (+ = starboard) */
  x: number;
  /** radius at the stern end */
  r: number;
  length: number;
  zStern: number;
  zBow: number;
  /** one of the three middle logs that project aft to carry the steering block */
  projecting: boolean;
}

export interface RaftLayout {
  logs: LogStation[];
  /** chink width between log k and k+1 (port → starboard), m */
  chinks: number[];
  /** log-top y used for everything resting on the logs (tallest log) */
  logTopY: number;
  crossbeamTopY: number;
  /** mat surface forward of the cabin and on the starboard strip */
  deckY: number;
  /** cabin floor: mats over the box layer */
  cabinFloorY: number;
  cabinAftZ: number;
  cabinFrontZ: number;
  mastZ: number;
  /** stern line of the non-projecting logs */
  sternZ: number;
  /** centre-log bow tip */
  bowZ: number;
  /** x half-extent of the log field (outer log centreline) */
  halfBeam: number;
}

/** the chinks the guaras drop through: [chink index, z] — "without system" [§2 Positions] */
export function guaraStations(p: RaftParams): Array<{ chink: number; z: number }> {
  return [
    { chink: 1, z: p.guaraFwdZ }, // bow, port
    { chink: 6, z: p.guaraFwdZ + 0.3 }, // bow, starboard
    { chink: 4, z: p.guaraMidZ }, // midships, just starboard of centre, forward of the mast
    { chink: 2, z: p.guaraAftZ }, // stern, port
    { chink: 5, z: p.guaraAftZ - 0.2 }, // stern, starboard
  ].slice(0, p.guaraCount);
}

export function raftLayout(p: RaftParams = raftParams): RaftLayout {
  const n = Math.max(3, Math.round(p.logCount));
  const half = (n - 1) / 2;
  const guaraChinks = new Set(guaraStations(p).map((g) => g.chink));
  const chinks: number[] = [];
  for (let k = 0; k < n - 1; k++) {
    // guara chinks are the LARGER ones [§2 Positions]; a 25 mm plank cannot
    // drop through a 20 mm gap
    const lo = guaraChinks.has(k) ? Math.max(p.chinkMin, p.guaraChinkMin) : p.chinkMin;
    chinks.push(vrange(lo, Math.max(lo, p.chinkMax), p.seed, 11, k));
  }
  const radii: number[] = [];
  for (let k = 0; k < n; k++) {
    radii.push(vrange(p.logDiameterMin, p.logDiameterMax, p.seed, 23, k) / 2);
  }
  // lay the logs port → starboard, then centre the field on x = 0
  const xs: number[] = [];
  let x = 0;
  for (let k = 0; k < n; k++) {
    if (k > 0) x += radii[k - 1] + chinks[k - 1] + radii[k];
    xs.push(x);
  }
  const mid = (xs[0] + xs[n - 1]) / 2;

  const centreLen = p.logCentreLength;
  const sternZ = -centreLen / 2 + p.sternProjection;
  const projectHalf = (Math.max(1, Math.round(p.sternProjectingLogs)) - 1) / 2;
  const logs: LogStation[] = [];
  let bowZ = -Infinity;
  for (let k = 0; k < n; k++) {
    const i = k - half;
    // SYMMETRIC LINEAR STAGGER: centre 13.7 → outer 9.1 [§1 Side logs]
    const length = centreLen - (centreLen - p.logOuterLength) * (Math.abs(i) / half);
    const projecting = Math.abs(i) <= projectHalf;
    const zStern = projecting ? sternZ - p.sternProjection : sternZ;
    const zBow = zStern + length;
    bowZ = Math.max(bowZ, zBow);
    logs.push({ i, x: xs[k] - mid, r: radii[k], length, zStern, zBow, projecting });
  }
  const logTopY = p.logAxisY + Math.max(...radii);
  const crossbeamTopY = logTopY + p.crossbeamDiameter;
  const deckY = crossbeamTopY + p.matThickness;
  const cabinFloorY = crossbeamTopY + p.cabinBoxHeight + p.matThickness;
  const cabinAftZ = p.cabinAftZ;
  const cabinFrontZ = cabinAftZ + p.cabinLength;
  return {
    logs,
    chinks,
    logTopY,
    crossbeamTopY,
    deckY,
    cabinFloorY,
    cabinAftZ,
    cabinFrontZ,
    mastZ: cabinFrontZ + p.mastGapToCabin,
    sternZ,
    bowZ,
    halfBeam: logs[n - 1].x,
  };
}

/** the log whose bow reaches at least z, furthest from centre on the given side */
export function outermostLogAt(layout: RaftLayout, z: number, sign: 1 | -1): LogStation {
  let best = layout.logs.find((l) => l.i === 0)!;
  for (const l of layout.logs) {
    if (Math.sign(l.i) !== sign) continue;
    if (l.zBow >= z && Math.abs(l.i) > Math.abs(best.i)) best = l;
  }
  return best;
}
