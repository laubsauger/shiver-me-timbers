/**
 * The circuit's static colliders for the crash code (§T.187 → §T.188, src/sea-physics/boatCollide.ts
 * `StaticCollider` / `prepareStaticWorld`) and its bed height (`BedHeight` = createRaceSeabed(...).heightAt,
 * which passes boats through sandbars). Capsules are sized off the course GLB geometry (scripts/blender/course):
 *   gate pole  flexible, r 0.6 (drum float), y −0.5 → 6.6       id = gate element index
 *   turn buoy  r 1.35 (hull + fender), y −1 → 4                 id = mark element index
 *   bar stake  r 0.2, y −1 → 4.7 (leaned like the placement)
 *   pylon      r 3.9 (the leg square at the waterline, 2.09 m per leg, plus the §T.194 concrete footings, 0.86 m), y −4 → 12
 *   start pontoons  §T.202 their hull box (START_PONTOON), as parallel capsules
 *   tower      r 1.6 around the mast axis (lean applied), y −4 → 30; guy anchors r 0.7
 *   roofs      Main Street: every part of a drowned building that reaches within a hull's draft of the surface
 *              (`roofColliders` below): ridge capsules sized to the roof's width at the waterline, chimneys,
 *              the store's false front and tin roof, the church tower, the water tower's frame and tank
 * Boulders: the seabed height field already carries them (bed contact).
 */
import type { StaticCollider } from '../sea-physics/boatCollide';
import type { Vec3 } from '../state/simState';
import contractRaw from './assets/courseAssetContract.json?raw';
import { BOAT_DRAFT, START_PONTOON, type RoofPlacement, type TowerReachWorld } from './towerReach';

type RoofHeights = { eave: number; ridge: number; top: number };
const ROOFS = (JSON.parse(contractRaw) as { roofs: Record<string, RoofHeights> }).roofs;

/**
 * Plan dimensions of the buildings in scripts/blender/course/roofs.py (asset frame: origin on the old ground
 * floor, +Z the street front); heights come from the contract `roofs` table the checker ties to the geometry.
 */
const HOUSE = { w: 7.6, d: 10.0, over: 0.45 };
const HIP = { w: 8.4, over: 0.45, ridgeHalf: 1.0 };
const SHED = { w: 9.0, d: 14.0 };
const STEEPLE = { w: 9.0, d: 16.0, over: 0.35, z: -1.0, tower: 3.6, towerTop: 15.2 };
const WATER_TOWER = { spread: 3.4, waist: 2.3, tankR: 3.2, catwalk: 0.75 };

/** anything whose top is below this (m, world) is under every hull and does not collide */
export const ROOF_CLEAR_DEPTH = -BOAT_DRAFT;

/** a hull can reach this high (m, world) — a jumping boat; colliders stop here (the band the coverage test checks) */
export const HULL_REACH_TOP = 6;

type Frame = (x: number, y: number, z: number) => Vec3;

/**
 * §T.198 a solid box (asset-frame bounds, mapped to world by the rigid `W`) as a row of parallel capsules along its
 * longest side, spread across its middle side: n = round(mid / thin) (1..6), each capsule's radius the corner distance
 * of its cell, its segment shortened by a quarter radius at each end (the rounded caps still reach the box's end
 * faces over most of their area). Clipped to what a hull reaches: nothing below `clear`, nothing above HULL_REACH_TOP.
 */
function boxCapsules(W: Frame, lo: Vec3, hi: Vec3, clearY: number, topY: number, out: StaticCollider[]): void {
  const l: Vec3 = [lo[0], Math.max(lo[1], clearY), lo[2]];
  const h: Vec3 = [hi[0], Math.min(hi[1], topY), hi[2]];
  if (!(h[1] > l[1])) return;
  const half = [0.5 * (h[0] - l[0]), 0.5 * (h[1] - l[1]), 0.5 * (h[2] - l[2])];
  const mid = [0.5 * (h[0] + l[0]), 0.5 * (h[1] + l[1]), 0.5 * (h[2] + l[2])];
  const [iA, iB, iC] = [0, 1, 2].sort((a, b) => half[b] - half[a]);
  const n = Math.max(1, Math.min(6, Math.round(half[iB] / Math.max(half[iC], 1e-3))));
  const cell = half[iB] / n;
  const r = Math.max(0.2, Math.hypot(cell, half[iC]));
  const seg = Math.max(0, half[iA] - 0.25 * r);
  for (let k = 0; k < n; k++) {
    const p: number[] = [...mid];
    p[iB] = mid[iB] - half[iB] + cell * (2 * k + 1);
    const a = [...p];
    const b = [...p];
    a[iA] -= seg;
    b[iA] += seg;
    out.push({ a: W(a[0], a[1], a[2]), b: W(b[0], b[1], b[2]), radius: r });
  }
}

/** a roof's waterline wall stands this far above still water (m): above a hull's mid-depth, so a hull meets its side */
export const ROOF_WALL_ABOVE = 0.8;

/**
 * §T.198 a pitched roof (a prism along asset `along`, half-length `halfLen` about `c`, half-width `hw(y)` falling to 0 at
 * `apex`) as a hull meets it. Two findings shaped it:
 *  - COVERAGE (tests/speedboatCollisionCoverage.test.ts against the roofs GLB): §T.197's single waterline ridge capsule
 *    held 8–15 % of a gable's geometry within a hull's reach — the flanks between the draft line and the surface were out;
 *  - THE RAMP (live page + tests/speedboatCollisionDrive.test.ts): any collider whose rounded top meets the hull below the
 *    hull's mid-depth pushes it UP — a 36° gable was a boat ramp, a hull driven at it at 45 m/s flew 6 m and landed 30 m
 *    beyond. A drowned house has to stop a boat, so its waterline is a WALL:
 *  - `wall`: a row of VERTICAL capsules along the ridge line, radius = the roof's half-width at the draft line (+0.35),
 *    0.7 r apart (the scallop between two keeps 94 % of the width), the end ones reaching the corners, from below the
 *    draft line to ROOF_WALL_ABOVE over the surface — its side normals are horizontal where a hull meets them;
 *  - above that (`wall top` … apex): ONE capsule whose circle passes through the roof's edges at the wall top and the
 *    apex (the circumscribed circle of the triangle that remains), for a hull that jumps onto the ridge.
 * Cost: at deck height (+0.8 m) the wall stands up to ~2 m proud of the slope near the ridge.
 */
function prismCapsules(W: Frame, along: 'x' | 'z', c: number, halfLen: number, hw: (y: number) => number, apex: number, water: number, clearY: number, out: StaticCollider[]): void {
  const lo = clearY;
  if (apex <= lo) return;
  const at = (u: number, y: number, v: number): Vec3 => (along === 'z' ? W(v, y, c + u) : W(c + u, y, v));
  const wallTop = Math.min(apex, water + ROOF_WALL_ABOVE);
  const B = hw(lo);
  const R = B + 0.35;
  // the end capsules reach the roof's corners at the draft line: centre within √(R² − B²) of the end
  const e = Math.max(0, halfLen - Math.sqrt(R * R - B * B));
  const n = Math.max(1, Math.ceil((2 * e) / (0.7 * R)) + 1);
  for (let k = 0; k < n; k++) {
    const u = n === 1 ? 0 : -e + ((2 * e) * k) / (n - 1);
    out.push({ a: at(u, lo - 0.4, 0), b: at(u, Math.max(wallTop, lo + 0.05), 0), radius: R });
  }
  if (apex > wallTop) {
    const Bt = hw(wallTop);
    const H = apex - wallTop;
    const yc = wallTop + (H * H - Bt * Bt) / (2 * H);
    const r = apex - yc;
    const ee = Math.max(0, halfLen - 0.25 * r);
    out.push({ a: at(-ee, yc, 0), b: at(ee, yc, 0), radius: r });
  }
}

/**
 * Capsules for one drowned building: every part within a hull's reach (above −BOAT_DRAFT, below HULL_REACH_TOP), sized
 * off the roofs GLB (scripts/blender/course/roofs.py plan dims; contract eave/ridge/top heights) — see `prismCapsules`
 * and `boxCapsules`.
 */
export function roofColliders(r: RoofPlacement): StaticCollider[] {
  const h = ROOFS[ROOF_KEY[r.kind]];
  const out: StaticCollider[] = [];
  const c = Math.cos(r.yaw);
  const s = Math.sin(r.yaw);
  // asset frame → world (three rotation.y = yaw, then translate; y is above the old floor)
  const W = (x: number, y: number, z: number): Vec3 => [r.at[0] + x * c + z * s, y + r.floor, r.at[1] - x * s + z * c];
  const water = -r.floor; // still water in the asset frame
  const clearY = ROOF_CLEAR_DEPTH - r.floor;
  const topY = HULL_REACH_TOP - r.floor;
  if (h.top <= clearY) return out;
  /** the ridge cap stands ~0.1 m over the contract ridge line (GLB: Gable top 9.33 vs ridge 9.2) */
  const apex = h.ridge + 0.15;
  /** roof half-width at asset height y: the eave overhang at the eave line, falling linearly to 0 at the ridge */
  const pitched = (halfEave: number, halfWall: number) => (y: number): number => (y >= h.eave ? (halfEave * (h.ridge - y)) / (h.ridge - h.eave) : Math.max(halfEave, halfWall));

  if (r.kind === 'gable' || r.kind === 'gableChimney') {
    prismCapsules(W, 'z', 0, HOUSE.d / 2 + HOUSE.over, pitched(HOUSE.w / 2 + HOUSE.over, HOUSE.w / 2), apex, water, clearY, out);
    if (r.kind === 'gableChimney') boxCapsules(W, [HOUSE.w * 0.26 - 0.56, h.eave, -HOUSE.d * 0.2 - 0.56], [HOUSE.w * 0.26 + 0.56, h.top + 0.05, -HOUSE.d * 0.2 + 0.56], clearY, topY, out);
  } else if (r.kind === 'hip') {
    prismCapsules(W, 'x', 0, HIP.w / 2 + HIP.over, pitched(HIP.w / 2 + HIP.over, HIP.w / 2), apex, water, clearY, out);
    // the chimney on the front-right hip (GLB: x 3.5…4.2, z 4.0…4.5, up to 8.2)
    boxCapsules(W, [3.45, 6.0, 3.95], [4.25, 8.25, 4.55], clearY, topY, out);
  } else if (r.kind === 'shed') {
    // the store: walls up to the tin roof (ridge at the front, eave at the back) and the brick false front above it
    boxCapsules(W, [-SHED.w / 2 - 0.4, -1, -SHED.d / 2 - 0.4], [SHED.w / 2 + 0.4, h.ridge, SHED.d / 2 + 0.75], clearY, topY, out);
    boxCapsules(W, [-SHED.w / 2 - 0.4, h.ridge, SHED.d / 2 + 0.25], [SHED.w / 2 + 0.4, h.top, SHED.d / 2 + 0.75], clearY, topY, out);
  } else if (r.kind === 'steeple') {
    prismCapsules(W, 'z', STEEPLE.z, STEEPLE.d / 2 + STEEPLE.over, pitched(STEEPLE.w / 2 + STEEPLE.over, STEEPLE.w / 2), apex, water, clearY, out);
    const tz = STEEPLE.d / 2 + STEEPLE.z + STEEPLE.tower / 2 - 0.4;
    boxCapsules(W, [-STEEPLE.tower / 2 - 0.2, -1, tz - STEEPLE.tower / 2 - 0.2], [STEEPLE.tower / 2 + 0.2, STEEPLE.towerTop, tz + STEEPLE.tower / 2 + 0.2], clearY, topY, out);
  } else {
    // the braced leg frame (boats do not thread the X-braces) and the tank with its catwalk
    if (h.eave > clearY) out.push({ a: W(0, 0, 0), b: W(0, h.eave - 1, 0), radius: Math.SQRT2 * ((WATER_TOWER.spread + WATER_TOWER.waist) / 2) + 0.3 });
    if (h.top > clearY) out.push({ a: W(0, h.eave - 1.2, 0), b: W(0, h.ridge, 0), radius: WATER_TOWER.tankR + WATER_TOWER.catwalk });
  }
  return out;
}

const ROOF_KEY: Record<RoofPlacement['kind'], string> = {
  gable: 'Gable',
  gableChimney: 'GableChimney',
  hip: 'Hip',
  shed: 'Shed',
  steeple: 'Steeple',
  waterTower: 'WaterTower',
};

/**
 * courseFurniture.ts's placement matrix for a leaned, yawed asset as a point map: T(at, pivotY) · Lean · T(0, −pivotY) ·
 * Ry(yaw) (leanMatrix: about the horizontal axis ⟂ `leanDir`, by −lean, so +Y tips toward bearing leanDir)
 */
function placedFrame(at: readonly [number, number], pivotY: number, yaw: number, lean: number, leanDir: number): Frame {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const kx = -Math.sin(leanDir);
  const kz = Math.cos(leanDir);
  const ca = Math.cos(-lean);
  const sa = Math.sin(-lean);
  return (x, y, z) => {
    const px = x * cy + z * sy;
    const py = y - pivotY;
    const pz = -x * sy + z * cy;
    // Rodrigues about k = (kx, 0, kz)
    const kdot = kx * px + kz * pz;
    const cx = -kz * py; // k × p = (ky·pz − kz·py, kz·px − kx·pz, kx·py − ky·px) with ky = 0
    const cyy = kz * px - kx * pz;
    const cz = kx * py;
    return [
      at[0] + px * ca + cx * sa + kx * kdot * (1 - ca),
      pivotY + py * ca + cyy * sa,
      at[1] + pz * ca + cz * sa + kz * kdot * (1 - ca),
    ];
  };
}

export function courseColliders(world: TowerReachWorld): StaticCollider[] {
  const out: StaticCollider[] = [];
  const idx = new Map(world.course.elements.map((e, i) => [e.kind === 'gate' ? e.gate.id : e.mark.id, i]));
  const f = world.furniture;
  for (const p of f.poles) out.push({ a: [p.at[0], -0.5, p.at[1]], b: [p.at[0], 6.6, p.at[1]], radius: 0.6, flexible: true, id: idx.get(p.gateId) });
  // §T.202 the start pontoons (in-engine, src/circuit/startMarkers.ts): the hull box a boat can run into
  const P = START_PONTOON;
  for (const sp of f.startPontoons) {
    boxCapsules(placedFrame(sp.at, 0, sp.yaw, 0, 0), [-P.length / 2, -P.draft, -P.beam / 2], [P.length / 2, P.freeboard, P.beam / 2], -1e9, 1e9, out);
  }
  for (const b of f.buoys) out.push({ a: [b.at[0], -1, b.at[1]], b: [b.at[0], 4, b.at[1]], radius: 1.35, id: idx.get(b.markId) });
  for (const s of f.stakes) {
    const lx = Math.cos(s.leanDir) * Math.sin(s.lean);
    const lz = Math.sin(s.leanDir) * Math.sin(s.lean);
    out.push({ a: [s.at[0] - lx, -1, s.at[1] - lz], b: [s.at[0] + lx * 4.7, 4.7, s.at[1] + lz * 4.7], radius: 0.2 });
    // §T.198 the daymark board on top (stake GLB: x ±0.42, z −0.2…0.36, y 3…4.72), leaned and yawed like the draw
    boxCapsules(placedFrame(s.at, 0, s.yaw, s.lean, s.leanDir), [-0.42, 3, -0.2], [0.42, 4.72, 0.36], -1e9, 1e9, out);
  }
  for (const p of f.pylons) out.push({ a: [p.at[0], -4, p.at[1]], b: [p.at[0], 12, p.at[1]], radius: 3.9 });
  const t = f.tower;
  const foot = world.seabedAt(t.at[0], t.at[1]);
  const lean = (y: number): [number, number, number] => {
    const h = y - foot;
    return [t.at[0] + Math.cos(t.leanDir) * Math.sin(t.lean) * h, y, t.at[1] + Math.sin(t.leanDir) * Math.sin(t.lean) * h];
  };
  out.push({ a: lean(-4), b: lean(30), radius: 1.6 });
  // §T.198 the race-control hut hung off the mast (tower GLB `Hut`, asset frame): its landing stage at the water, the
  // stair, and the cabin a jumping hull can reach
  const hut = placedFrame(t.at, foot, t.yaw, t.lean, t.leanDir);
  boxCapsules(hut, [-5.95, -0.6, 2.75], [-2.25, 0.75, 5.6], ROOF_CLEAR_DEPTH, HULL_REACH_TOP, out);
  boxCapsules(hut, [-4.45, 0.75, -0.15], [-1.25, 4.6, 2.95], ROOF_CLEAR_DEPTH, HULL_REACH_TOP, out);
  boxCapsules(hut, [-7.6, 4.6, -2.75], [-1.2, 8.6, 2.95], ROOF_CLEAR_DEPTH, HULL_REACH_TOP, out);
  for (const a of t.anchors) out.push({ a: [a[0], -0.6, a[1]], b: [a[0], 1.5, a[1]], radius: 0.7 });
  for (const r of f.roofs) out.push(...roofColliders(r));
  return out;
}
