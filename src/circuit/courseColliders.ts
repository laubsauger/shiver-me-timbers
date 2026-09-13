/**
 * The circuit's static colliders for the crash code (§T.187 → §T.188, src/sea-physics/boatCollide.ts
 * `StaticCollider` / `prepareStaticWorld`) and its bed height (`BedHeight` = createRaceSeabed(...).heightAt,
 * which passes boats through sandbars). Capsules are sized off the course GLB geometry (scripts/blender/course):
 *   gate pole  flexible, r 0.6 (drum float), y −0.5 → 6.6       id = gate element index
 *   turn buoy  r 1.35 (hull + fender), y −1 → 4                 id = mark element index
 *   bar stake  r 0.2, y −1 → 4.7 (leaned like the placement)
 *   pylon      r 2.9 (leg square at the waterline), y −4 → 12
 *   tower      r 1.6 around the mast axis (lean applied), y −4 → 30; guy anchors r 0.7
 *   roofs      Main Street: every part of a drowned building that reaches within a hull's draft of the surface
 *              (`roofColliders` below): ridge capsules sized to the roof's width at the waterline, chimneys,
 *              the store's false front and tin roof, the church tower, the water tower's frame and tank
 * Boulders: the seabed height field already carries them (bed contact).
 */
import type { StaticCollider } from '../sea-physics/boatCollide';
import type { Vec3 } from '../state/simState';
import contractRaw from './assets/courseAssetContract.json?raw';
import { BOAT_DRAFT, type RoofPlacement, type TowerReachWorld } from './towerReach';

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

/**
 * Capsules for one drowned building. A pitched roof above the water is a triangular prism; the capsule along the
 * ridge sits at the waterline with the roof's half-width there as radius, so its sides meet the slopes where a
 * hull meets them (it bulges up to ~0.5 m over a low ridge: a boat is not meant to skim a roof).
 */
export function roofColliders(r: RoofPlacement): StaticCollider[] {
  const h = ROOFS[ROOF_KEY[r.kind]];
  const out: StaticCollider[] = [];
  const c = Math.cos(r.yaw);
  const s = Math.sin(r.yaw);
  // asset frame → world (three rotation.y = yaw, then translate; y is above the old floor)
  const W = (x: number, y: number, z: number): Vec3 => [r.at[0] + x * c + z * s, y + r.floor, r.at[1] - x * s + z * c];
  const water = -r.floor; // still water in the asset frame
  const breaks = (top: number): boolean => top + r.floor > ROOF_CLEAR_DEPTH;
  const push = (a: Vec3, b: Vec3, radius: number): void => {
    out.push({ a, b, radius });
  };
  /** ridge along asset z (or x) from −half..half at ridge height, slopes dropping `slope` per metre */
  const ridge = (along: 'x' | 'z', half: number, zc: number, ridgeY: number, slope: number, maxHalfWidth: number): void => {
    const y = Math.min(water, ridgeY);
    const radius = Math.max(0.4, Math.min(maxHalfWidth, (ridgeY - y) / slope + 0.2));
    const e = Math.max(0, half - radius);
    if (along === 'z') push(W(0, y, zc - e), W(0, y, zc + e), radius);
    else push(W(-e, y, zc), W(e, y, zc), radius);
  };

  if (r.kind === 'gable' || r.kind === 'gableChimney') {
    const slope = (h.ridge - h.eave) / (HOUSE.w / 2);
    if (breaks(h.ridge)) ridge('z', HOUSE.d / 2 + HOUSE.over, 0, h.ridge, slope, HOUSE.w / 2 + HOUSE.over);
    if (r.kind === 'gableChimney' && breaks(h.top)) push(W(HOUSE.w * 0.26, h.eave, -HOUSE.d * 0.2), W(HOUSE.w * 0.26, h.top, -HOUSE.d * 0.2), 0.6);
  } else if (r.kind === 'hip') {
    const slope = (h.ridge - h.eave) / (HIP.w / 2 - HIP.ridgeHalf);
    if (breaks(h.ridge)) ridge('x', HIP.ridgeHalf + HIP.w / 2, 0, h.ridge, slope, HIP.w / 2 + HIP.over);
  } else if (r.kind === 'shed') {
    // the false front (0.5 m brick, `top` high) and the tin roof falling from `ridge` at the front to `eave` at the back
    const fz = SHED.d / 2 + 0.25;
    if (breaks(h.top)) {
      for (const dy of [0.1, 1.1]) {
        const y = Math.min(water + dy, h.top - 0.5);
        push(W(-(SHED.w / 2 - 0.2), y, fz), W(SHED.w / 2 - 0.2, y, fz), 0.55);
      }
    }
    if (breaks(h.ridge)) {
      const radius = 1.6;
      for (const x of [-3.1, 0, 3.1]) push(W(x, h.eave - radius + 0.1, -SHED.d / 2 + radius), W(x, h.ridge - radius + 0.1, SHED.d / 2 - radius), radius);
    }
  } else if (r.kind === 'steeple') {
    const slope = (h.ridge - h.eave) / (STEEPLE.w / 2);
    if (breaks(h.ridge)) ridge('z', STEEPLE.d / 2 + STEEPLE.over, STEEPLE.z, h.ridge, slope, STEEPLE.w / 2 + STEEPLE.over);
    const tz = STEEPLE.d / 2 + STEEPLE.z + STEEPLE.tower / 2 - 0.4;
    if (breaks(h.top)) push(W(0, 0, tz), W(0, STEEPLE.towerTop + 1, tz), STEEPLE.tower / 2 + 0.35);
  } else {
    // the braced leg frame (boats do not thread the X-braces) and the tank with its catwalk
    if (breaks(h.eave)) push(W(0, 0, 0), W(0, h.eave - 1, 0), Math.SQRT2 * ((WATER_TOWER.spread + WATER_TOWER.waist) / 2) + 0.3);
    if (breaks(h.top)) push(W(0, h.eave - 1.2, 0), W(0, h.ridge, 0), WATER_TOWER.tankR + WATER_TOWER.catwalk);
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

export function courseColliders(world: TowerReachWorld): StaticCollider[] {
  const out: StaticCollider[] = [];
  const idx = new Map(world.course.elements.map((e, i) => [e.kind === 'gate' ? e.gate.id : e.mark.id, i]));
  const f = world.furniture;
  for (const p of f.poles) out.push({ a: [p.at[0], -0.5, p.at[1]], b: [p.at[0], 6.6, p.at[1]], radius: 0.6, flexible: true, id: idx.get(p.gateId) });
  for (const b of f.buoys) out.push({ a: [b.at[0], -1, b.at[1]], b: [b.at[0], 4, b.at[1]], radius: 1.35, id: idx.get(b.markId) });
  for (const s of f.stakes) {
    const lx = Math.cos(s.leanDir) * Math.sin(s.lean);
    const lz = Math.sin(s.leanDir) * Math.sin(s.lean);
    out.push({ a: [s.at[0] - lx, -1, s.at[1] - lz], b: [s.at[0] + lx * 4.7, 4.7, s.at[1] + lz * 4.7], radius: 0.2 });
  }
  for (const p of f.pylons) out.push({ a: [p.at[0], -4, p.at[1]], b: [p.at[0], 12, p.at[1]], radius: 2.9 });
  const t = f.tower;
  const foot = world.seabedAt(t.at[0], t.at[1]);
  const lean = (y: number): [number, number, number] => {
    const h = y - foot;
    return [t.at[0] + Math.cos(t.leanDir) * Math.sin(t.lean) * h, y, t.at[1] + Math.sin(t.leanDir) * Math.sin(t.lean) * h];
  };
  out.push({ a: lean(-4), b: lean(30), radius: 1.6 });
  for (const a of t.anchors) out.push({ a: [a[0], -0.6, a[1]], b: [a[0], 1.5, a[1]], radius: 0.7 });
  for (const r of f.roofs) out.push(...roofColliders(r));
  return out;
}
