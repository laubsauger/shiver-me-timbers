/**
 * SEATING A SCANNED PLANT ON THE GROUND (the user, 2026-11-01: "some plants like the smaller stumpy shrub or tree feel
 * like floating on the sand, as if they are not connected"). The plants were stood on the terrain at one point, the
 * middle of their file's bounding box, sunk a fixed amount. Two things lifted their stems off the sand:
 *
 *   - the Pachira scrub (forest.ts), shrub_02 and shrub_03 (groundDebris.ts) are SPECIMEN SHEETS: four plants laid
 *     side by side along x, ~2 m apart in the Pachira file. Each instance was the whole row, ~16 m long at the
 *     scrub's scale and stretch, stood on the ground at its middle and leaned as one (forest.ts LEAN, 0.1 rad): the
 *     end plants stood up to ~0.8 m over the coppice mounds and the berm's fall (coast.ts), on thin air;
 *   - a tree's or a palm's trunk is not under its box's middle (the crown leans off it): island_tree_02's trunk is
 *     1.1 m off it in the file, 5 m at the stand's scale, so its foot stood on the ground at another place.
 *
 * Now every plant is seated by its own FOOTPRINT: the points of its stems at the foot of the file (`footprint`), put
 * through the instance's turn, lean and stretch, and the instance dropped until every one of them is `sink` m under
 * the ground beneath it (`seatDrop`) — the lowest point under the footprint less a few centimetres, so no stem
 * shows a gap on a slope or a mound. A sheet's plants are each their own instance (`specimens`), seated on their own
 * ground; where they stand along the row is as before.
 */
import * as THREE from 'three/webgpu';

/** share of a file's height (from its lowest point) its footprint is taken over, and the most points kept */
const BAND = 0.03;
const MOST = 64;

/**
 * The foot of a plant: the outline of `geos` (in the file's space, as they will be instanced) at its lowest point —
 * where its points within BAND of its height above the lowest stand, each put down to the lowest's level (a point of
 * the trunk 30 cm up is not to go under the ground: its foot under it is) — thinned to MOST.
 */
export function footprint(geos: THREE.BufferGeometry[]): THREE.Vector3[] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const g of geos) {
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      lo = Math.min(lo, p.getY(i));
      hi = Math.max(hi, p.getY(i));
    }
  }
  const cut = lo + BAND * (hi - lo);
  const out: THREE.Vector3[] = [];
  for (const g of geos) {
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) if (p.getY(i) <= cut) out.push(new THREE.Vector3(p.getX(i), lo, p.getZ(i)));
  }
  if (out.length <= MOST) return out;
  // (thinned evenly through the list: the scans' vertices run round each stem in order, so every stem keeps points)
  return Array.from({ length: MOST }, (_, i) => out[Math.floor((i * out.length) / MOST)]);
}

const w = new THREE.Vector3();
/**
 * m to add to `m`'s translation in y so that every point of `foot` (the file's space), placed by `m`, is `sink` m or
 * more under `ground` beneath it.
 */
export function seatDrop(foot: THREE.Vector3[], m: THREE.Matrix4, ground: (x: number, z: number) => number, sink: number): number {
  let drop = Infinity;
  for (const p of foot) {
    w.copy(p).applyMatrix4(m);
    drop = Math.min(drop, ground(w.x, w.z) - sink - w.y);
  }
  return Number.isFinite(drop) ? drop : 0;
}

/** `m` seated: its translation dropped by `seatDrop` (a new matrix) */
export function seated(foot: THREE.Vector3[], m: THREE.Matrix4, ground: (x: number, z: number) => number, sink: number): THREE.Matrix4 {
  const out = m.clone();
  out.elements[13] += seatDrop(foot, m, ground, sink);
  return out;
}

/**
 * A specimen sheet's plants: its meshes grouped by the letter that ends their names (`pachira_aquatica_01_bark_a`,
 * `…_leaves_a` → `a`); a file whose meshes carry none is one plant. Returns the group of each mesh, in order.
 */
export function specimens(names: string[]): string[] {
  return names.map((n) => /_([a-z])$/.exec(n)?.[1] ?? '');
}

/**
 * Where a seated plant meets the ground, for its CONTACT SHADE (forest.ts contactMask): the middle of its footprint
 * placed by `m` (world x, z), the footprint's radius about it (m) and the plant's height (m: `tall`, the file's, by
 * `m`'s stretch up).
 */
export function contactOf(foot: THREE.Vector3[], m: THREE.Matrix4, tall: number): [number, number, number, number] {
  let x = 0;
  let z = 0;
  const pts = foot.map((p) => p.clone().applyMatrix4(m));
  for (const p of pts) {
    x += p.x / pts.length;
    z += p.z / pts.length;
  }
  let r = 0;
  for (const p of pts) r = Math.max(r, Math.hypot(p.x - x, p.z - z));
  const e = m.elements;
  return [x, z, r, tall * Math.hypot(e[4], e[5], e[6])];
}
