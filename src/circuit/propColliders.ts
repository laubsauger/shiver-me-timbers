/**
 * SOLID ISLAND PROPS (§T.198). User playtest 2026-09-13: "collision with rocks, buildings, any kind of obstacle is not a
 * thing right now". Measured in the live page: Tower Reach's kit islands carry `rockCount: 0` (§T.194 moved the granite
 * to `circuit/kitDecor.ts`), so `page/course.ts rockColliders` found 0 placements and the 2 400 visible granite blocks,
 * beachrock slabs, rubble and driftwood logs had NO collider — a hull at 45 m/s drove straight through them.
 *
 * ONE SOURCE (§V77): colliders are fitted to the RENDERED instances — each InstancedMesh's own geometry vertices under
 * its own instance matrix and world matrix, exactly what the GPU draws — not to a second reading of the placement
 * rules (which live inside the renderer and change under §T.194). Structural types only: no three import, so the
 * coverage test runs the same function over the same meshes headless.
 *
 * WHICH instances are judged on the vertices above the bed; THE FIT then takes all of the instance's vertices:
 *   axes     the instance's own (orthonormalised) matrix columns, sorted by the vertices' extent: A ≥ B ≥ C
 *   capsules n = round(B / C) (1..MAX_PROP_CAPSULES) parallel capsules along A, spread across B: a round boulder is one
 *            capsule, a beachrock slab a row of thin ones (one fat capsule would stand a metre proud of a flat slab)
 *   radius   per capsule, the largest distance of its vertices from its axis (every vertex is inside by construction; one
 *            capsule is convex, so it holds the convex hull of a block too); a row's capsules also reach their cell's
 *            corners and span the prop's length, or a slab's middle — no vertices of its own — would be a gap
 *   length   per capsule, the shortest segment whose rounded caps still hold its vertices
 * Which instances: top above −BOAT_DRAFT (anything deeper is under every hull, the roofs' rule), base below
 * `PROP_REACH_ABOVE` (higher is on land, where the bed already stops a hull), at least `PROP_MIN_PROUD` above the bed.
 */
import type { StaticCollider } from '../sea-physics/boatCollide';
import type { Vec3 } from '../state/simState';

/** the island InstancedMeshes that are solid, by the name their builder gives them (island/rocks.ts, circuit/kitDecor.ts) */
export const SOLID_PROP_MESHES = ['island-rocks-', 'island-kit-blocks', 'island-kit-slabs', 'island-kit-rubble', 'island-kit-driftwood'] as const;
/** island InstancedMeshes that are deliberately NOT solid (plants and ground cover): a hull runs through grass */
export const SOFT_PROP_MESHES = ['island-pines', 'island-junipers', 'island-manzanita', 'island-dead-pines', 'island-bunchgrass', 'island-cover', 'island-palms'] as const;

/** a prop whose highest point is below this (m, world) is under every hull (roofs: ROOF_CLEAR_DEPTH = −BOAT_DRAFT) */
export const PROP_CLEAR_DEPTH = -0.6;
/** a prop whose lowest point above the bed is higher than this (m) sits on land: the bed stops a hull first */
export const PROP_REACH_ABOVE = 3;
/** a prop standing less than this above the bed (m) is not an obstacle to a hull (a plank, a flat plate in the sand) */
export const PROP_MIN_PROUD = 0.25;
/** vertices this far below the bed (m) still count toward an instance's top/reach (the embed a seated block has) */
const BED_EMBED = 0.25;
/** capsules per instance at most (a slab's row) */
export const MAX_PROP_CAPSULES = 4;
const MIN_RADIUS = 0.15;

/** the parts of a three.js InstancedMesh this module reads (structural) */
export interface PropMeshSource {
  name: string;
  count: number;
  geometry: { getAttribute(name: 'position'): { count: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number } };
  instanceMatrix: { array: ArrayLike<number> };
  /** column-major 4×4, current (the caller runs updateMatrixWorld) */
  matrixWorld: { elements: ArrayLike<number> };
}

export type PropMeshKind = 'solid' | 'soft' | 'unknown';

export function propMeshKind(name: string): PropMeshKind {
  if (SOLID_PROP_MESHES.some((p) => name.startsWith(p))) return 'solid';
  if (SOFT_PROP_MESHES.some((p) => name.startsWith(p))) return 'soft';
  return 'unknown';
}

/** column-major a·b into out */
function mul4(a: ArrayLike<number>, b: ArrayLike<number>, bo: number, out: Float64Array): void {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[bo + c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
}

export interface PropFitStats {
  instances: number;
  solid: number;
  skippedDeep: number;
  skippedLand: number;
  skippedFlat: number;
}

/**
 * Colliders for every instance of one solid mesh, appended to `out` (instance order: deterministic, §V2). `bed` is the
 * physics bed the hulls ground on. `instanceOf` (optional) receives the instance index of each collider pushed.
 */
export function fitPropColliders(
  mesh: PropMeshSource,
  bed: (x: number, z: number) => number,
  out: StaticCollider[],
  stats?: PropFitStats,
  instanceOf?: number[],
): void {
  const pos = mesh.geometry.getAttribute('position');
  const nv = pos.count;
  const M = new Float64Array(16);
  const P = new Float64Array(nv * 3);
  const keep = new Uint8Array(nv);
  const tA = new Float64Array(nv);
  const tB = new Float64Array(nv);
  const tC = new Float64Array(nv);
  for (let inst = 0; inst < mesh.count; inst++) {
    if (stats) stats.instances++;
    mul4(mesh.matrixWorld.elements, mesh.instanceMatrix.array, inst * 16, M);
    let top = -Infinity;
    let kept = 0;
    let lowestProud = Infinity;
    let proud = -Infinity;
    for (let i = 0; i < nv; i++) {
      const lx = pos.getX(i);
      const ly = pos.getY(i);
      const lz = pos.getZ(i);
      const x = M[0] * lx + M[4] * ly + M[8] * lz + M[12];
      const y = M[1] * lx + M[5] * ly + M[9] * lz + M[13];
      const z = M[2] * lx + M[6] * ly + M[10] * lz + M[14];
      P[i * 3] = x;
      P[i * 3 + 1] = y;
      P[i * 3 + 2] = z;
      const b = bed(x, z);
      keep[i] = y >= b - BED_EMBED ? 1 : 0;
      if (!keep[i]) continue;
      kept++;
      if (y > top) top = y;
      if (y - b > proud) proud = y - b;
      if (b < lowestProud) lowestProud = b;
    }
    if (kept < 4 || top < PROP_CLEAR_DEPTH) {
      if (stats) stats.skippedDeep++;
      continue;
    }
    if (lowestProud > PROP_REACH_ABOVE) {
      if (stats) stats.skippedLand++;
      continue;
    }
    if (proud < PROP_MIN_PROUD) {
      if (stats) stats.skippedFlat++;
      continue;
    }
    // the fit takes the WHOLE instance: a block's faces run on into the sand, and a fit to only its vertices above the
    // bed leaves those faces' visible part out (measured: 86% of a half-buried block's drawn surface); the buried part
    // of the collider is inside the bed, where no hull goes
    keep.fill(1);
    // orthonormal axes from the matrix columns (Gram–Schmidt: a parent with non-uniform scale still yields a frame)
    const ax: Vec3[] = [
      [M[0], M[1], M[2]],
      [M[4], M[5], M[6]],
      [M[8], M[9], M[10]],
    ];
    for (let k = 0; k < 3; k++) {
      for (let j = 0; j < k; j++) {
        const d = ax[k][0] * ax[j][0] + ax[k][1] * ax[j][1] + ax[k][2] * ax[j][2];
        for (let c = 0; c < 3; c++) ax[k][c] -= d * ax[j][c];
      }
      const l = Math.hypot(ax[k][0], ax[k][1], ax[k][2]) || 1;
      for (let c = 0; c < 3; c++) ax[k][c] /= l;
    }
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < nv; i++) {
      if (!keep[i]) continue;
      for (let k = 0; k < 3; k++) {
        const t = P[i * 3] * ax[k][0] + P[i * 3 + 1] * ax[k][1] + P[i * 3 + 2] * ax[k][2];
        if (t < lo[k]) lo[k] = t;
        if (t > hi[k]) hi[k] = t;
      }
    }
    const order = [0, 1, 2].sort((a, b) => hi[b] - lo[b] - (hi[a] - lo[a]));
    const [iA, iB, iC] = order;
    const A = ax[iA];
    const B = ax[iB];
    const C = ax[iC];
    const mA = 0.5 * (lo[iA] + hi[iA]);
    const mB = 0.5 * (lo[iB] + hi[iB]);
    const mC = 0.5 * (lo[iC] + hi[iC]);
    const hb = 0.5 * (hi[iB] - lo[iB]);
    const hc = Math.max(0.5 * (hi[iC] - lo[iC]), 1e-3);
    const n = Math.max(1, Math.min(MAX_PROP_CAPSULES, Math.round(hb / hc)));
    const cell = (2 * hb) / n;
    for (let i = 0; i < nv; i++) {
      if (!keep[i]) continue;
      tA[i] = P[i * 3] * A[0] + P[i * 3 + 1] * A[1] + P[i * 3 + 2] * A[2] - mA;
      tB[i] = P[i * 3] * B[0] + P[i * 3 + 1] * B[1] + P[i * 3 + 2] * B[2] - mB;
      tC[i] = P[i * 3] * C[0] + P[i * 3 + 1] * C[1] + P[i * 3 + 2] * C[2] - mC;
    }
    // the extent along A over every kept vertex: a capsule whose cell holds no vertex (a flat slab's middle, whose
    // vertices are all on its rim) still spans the prop and still reaches its cell's corners (§T.198 coverage test)
    let ha = 0;
    for (let i = 0; i < nv; i++) if (keep[i] && Math.abs(tA[i]) > ha) ha = Math.abs(tA[i]);
    for (let k = 0; k < n; k++) {
      const off = -hb + cell * (k + 0.5);
      // one capsule holds the convex hull of its vertices already; a row's capsule also reaches its cell's corners
      let r2 = n > 1 ? (0.5 * cell) ** 2 + hc * hc : 0;
      for (let i = 0; i < nv; i++) {
        if (!keep[i] || Math.min(n - 1, Math.max(0, Math.floor((tB[i] + hb) / cell))) !== k) continue;
        const d2 = (tB[i] - off) ** 2 + tC[i] ** 2;
        if (d2 > r2) r2 = d2;
      }
      const r = Math.max(MIN_RADIUS, Math.sqrt(r2));
      let half = n > 1 ? Math.max(0, ha - 0.5 * r) : 0;
      for (let i = 0; i < nv; i++) {
        if (!keep[i] || Math.min(n - 1, Math.max(0, Math.floor((tB[i] + hb) / cell))) !== k) continue;
        const d2 = (tB[i] - off) ** 2 + tC[i] ** 2;
        const need = Math.abs(tA[i]) - Math.sqrt(Math.max(0, r * r - d2));
        if (need > half) half = need;
      }
      const cx = A[0] * mA + B[0] * (mB + off) + C[0] * mC;
      const cy = A[1] * mA + B[1] * (mB + off) + C[1] * mC;
      const cz = A[2] * mA + B[2] * (mB + off) + C[2] * mC;
      const cap: StaticCollider = {
        a: [cx - A[0] * half, cy - A[1] * half, cz - A[2] * half],
        b: [cx + A[0] * half, cy + A[1] * half, cz + A[2] * half],
        radius: r,
      };
      out.push(cap);
      instanceOf?.push(inst);
      const walls = waterlineWall(cap, out);
      for (let w = 0; w < walls; w++) instanceOf?.push(inst);
    }
    if (stats) stats.solid++;
  }
}

/** the band a hull's side meets an obstacle in (m, world): below the draft line to above the hull's mid-depth */
export const WALL_BAND_LO = -0.6;
export const WALL_BAND_HI = 0.8;
/** the wall rises with its obstacle up to this height (m): a hull whose bow is lifted by the first hit meets wall, not dome */
export const WALL_TOP_MAX = 2;
const MAX_WALL_CAPSULES = 6;
/** capsules thinner than this (m) get no wall (a stone, a log): a hull meets them as a kick it may hop */
export const WALL_MIN_RADIUS = 0.75;

/**
 * §T.198 THE WATERLINE IS A WALL. A capsule whose rounded top meets a hull below the hull's mid-depth is a ramp: a
 * big granite block fitted as a dome with its axis under the surface threw a 20 m/s hull 2 m up and over it, 45 m/s
 * 3.7 m (tests/speedboatCollisionDrive). For every fitted capsule crossing the band a hull's side meets
 * (WALL_BAND_LO…WALL_BAND_HI), vertical capsules along the horizontal projection of its axis, each as wide as the
 * capsule's widest horizontal slice within the band there, from below the band to the capsule's top (at most
 * WALL_TOP_MAX: at 45 m/s the first, V110-capped hit pitches the bow up and a wall that stopped at +0.8 m let it climb
 * the dome, 6 m): the side a hull meets is vertical. In plan it never reaches beyond the capsule's own band slice; above
 * the band it stands proud of a dome by the slice's shrinkage there. Returns the capsules appended.
 */
export function waterlineWall(c: StaticCollider, out: StaticCollider[]): number {
  const ax = c.b[0] - c.a[0];
  const az = c.b[2] - c.a[2];
  const lh = Math.hypot(ax, az);
  const yTop = Math.max(c.a[1], c.b[1]) + c.radius;
  const yBot = Math.min(c.a[1], c.b[1]) - c.radius;
  if (yTop < WALL_BAND_LO || yBot > WALL_BAND_HI || c.radius < WALL_MIN_RADIUS) return 0;
  const slice = (yAxis: number): number => {
    // widest horizontal slice of a sphere of radius r at height yAxis, over the band
    const y = Math.max(WALL_BAND_LO, Math.min(WALL_BAND_HI, yAxis));
    const d = y - yAxis;
    return Math.sqrt(Math.max(0, c.radius * c.radius - d * d));
  };
  const rMin = Math.min(slice(c.a[1]), slice(c.b[1]));
  if (!(Math.max(slice(c.a[1]), slice(c.b[1])) > 0.25)) return 0;
  const n = lh < 0.35 * Math.max(rMin, 0.25) ? 1 : Math.max(2, Math.min(MAX_WALL_CAPSULES, Math.ceil(lh / (0.7 * Math.max(rMin, 0.25))) + 1));
  let added = 0;
  for (let k = 0; k < n; k++) {
    const t = n === 1 ? 0.5 : k / (n - 1);
    // one wall for a short capsule stands at its middle, as wide as the capsule's reach from there
    const reach = n === 1 ? 0.5 * lh : 0;
    const yAxis = c.a[1] + (c.b[1] - c.a[1]) * t;
    const R = slice(yAxis) + reach;
    if (R < 0.25) continue;
    const top = Math.min(WALL_TOP_MAX, yAxis + c.radius);
    const x = c.a[0] + ax * t;
    const z = c.a[2] + az * t;
    out.push({ a: [x, WALL_BAND_LO - 0.4, z], b: [x, Math.max(top, WALL_BAND_LO - 0.35), z], radius: R });
    added++;
  }
  return added;
}

/** a scene node as `islandPropColliders` walks it (structural: THREE.Object3D satisfies it) */
export interface PropNode {
  name: string;
  children: readonly PropNode[];
  isInstancedMesh?: boolean;
  updateMatrixWorld?(force?: boolean): void;
}

export interface IslandPropColliders {
  colliders: StaticCollider[];
  stats: PropFitStats;
  /** InstancedMesh names under the islands that are neither solid nor known-soft (a new prop class needs a decision) */
  unclassified: string[];
}

/** every solid prop instance under the island groups, in island → traversal → instance order (§V2) */
export function islandPropColliders(groups: readonly PropNode[], bed: (x: number, z: number) => number): IslandPropColliders {
  const colliders: StaticCollider[] = [];
  const stats: PropFitStats = { instances: 0, solid: 0, skippedDeep: 0, skippedLand: 0, skippedFlat: 0 };
  const unclassified: string[] = [];
  const walk = (o: PropNode): void => {
    if (o.isInstancedMesh) {
      const kind = propMeshKind(o.name);
      if (kind === 'solid') fitPropColliders(o as unknown as PropMeshSource, bed, colliders, stats);
      else if (kind === 'unknown') unclassified.push(o.name);
    }
    for (const c of o.children) walk(c);
  };
  for (const g of groups) {
    g.updateMatrixWorld?.(true);
    walk(g);
  }
  return { colliders, stats, unclassified };
}
