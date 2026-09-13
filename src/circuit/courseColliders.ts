/**
 * The circuit's static colliders for the crash code (§T.187 → §T.188, src/sea-physics/boatCollide.ts
 * `StaticCollider` / `prepareStaticWorld`) and its bed height (`BedHeight` = createRaceSeabed(...).heightAt,
 * which passes boats through sandbars). Capsules are sized off the course GLB geometry (scripts/blender/course):
 *   gate pole  flexible, r 0.6 (drum float), y −0.5 → 6.6       id = gate element index
 *   turn buoy  r 1.35 (hull + fender), y −1 → 4                 id = mark element index
 *   bar stake  r 0.2, y −1 → 4.7 (leaned like the placement)
 *   pylon      r 2.9 (leg square at the waterline), y −4 → 12
 *   tower      r 1.6 around the mast axis (lean applied), y −4 → 30; guy anchors r 0.7
 * Roofs are boxes, not capsules: NOT included — §T.188 should add box/heightfield contact or approximate
 * each roof with 2 capsules along its ridge (contract `roofs` table gives eave/ridge heights). Boulders: the
 * seabed height field already carries them (bed contact).
 */
import type { StaticCollider } from '../sea-physics/boatCollide';
import type { TowerReachWorld } from './towerReach';

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
  return out;
}
