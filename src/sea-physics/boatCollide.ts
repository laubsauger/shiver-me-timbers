/**
 * BOAT COLLISIONS for the speedboat (§T.188 S6; docs/speedboat/tech-research.md §4.2–4.3; docs/speedboat/crash.md).
 * Engine-free (§V3), pure, allocation-free per call after the per-boat memory is built, no module-level state
 * (§V2: the sim worker runs this file unchanged).
 *
 * WHAT IT DOES, ONCE PER TICK PER BOAT, BEFORE THE RIGID6 STEP
 *  1. boat↔boat: a capsule chain per hull, SWEPT over the tick (conservative advancement on linearly moving
 *     capsule endpoints — exact bound, so no tunnelling at any closing speed), one contact per pair at the
 *     earliest time of impact, a Catto sequential-impulse response with restitution, Coulomb friction and the
 *     FULL inverse inertia (an off-centre hit yaws both boats), bounded at result (V110 below).
 *  2. boat↔static colliders (marker poles, buoys, tower legs, pylons, rocks): the same swept chain test against
 *     capsules the circuit hands in (`StaticCollider`), infinite mass. `flexible` colliders (gate poles, GDD §3)
 *     push nothing and cost a one-off speed loss per contact episode.
 *  3. boat↔seabed/terrain: hull sample points against a height function (`BedHeight`, e.g. `seabed.heightAt`),
 *     each point's path over the tick sampled, normal from the central-difference GRADIENT (a cliff gives a
 *     near-horizontal normal — the boat is turned aside, not lifted), velocity-level impulses with speculative
 *     approach (a point may close the gap it has this tick, never more), Baumgarte push-out ≤ `maxBiasSpeed`,
 *     Coulomb friction. NOT `grounding.ts`: that is a vertical spring + planar friction, yaw-free by contract
 *     (§B.6) — right for a galleon settling on a bank, wrong for 40 m/s into a rock face.
 *
 * WHY TICK-LEVEL IMPULSES FROM THE TICK-START SNAPSHOT (and not a force inside the substep callback)
 * A worker shard steps boat i without boat j's live state — only the WORLD snapshot of every pose at tick k
 * (src/sim-worker/layout.ts). A contact both sides compute from that snapshot, with the lower index always
 * "A" (`collideBoatWithFleet`), is BIT-IDENTICAL on both shards, so boat i receives exactly −(what j receives):
 * linear momentum of the pair is conserved to round-off and the result does not depend on which thread a boat
 * lives on (§V2). Multiple contacts on one boat in one tick are resolved JACOBI (each from the snapshot), never
 * in an order that could differ between shards. The response acts on rigid momenta through
 * `applyRigid6Impulse` (velocities only; rigid6 stays the one integrator of pose, V100). It is independent of
 * the substep count, so SPEC §V107 (substep convergence) holds trivially for contacts. The TOI is resolved
 * inside the tick; the velocity change is applied at the tick's start, so a boat that would touch at t_c
 * turns back up to closingSpeed·t_c early (≤ 0.75 m at 45 m/s head-on, ≈ 5 cm at a 3 m/s racing rub).
 *
 * V110 (tech-research numbering: contact acceleration BOUNDED AT RESULT, force and torque scaled together):
 * one factor scales the whole impulse of a contact (both boats: momentum stays conserved) so no boat's
 * |Δv|/dt exceeds `maxImpactAccel` and no |Δω|/dt exceeds `maxImpactAngularAccel`; the world solve scales its
 * summed Δv/Δω the same way. A capped contact simply continues next tick (it is still penetrating or closing).
 *
 * CAPSULES ARE A PROXY: a circle of the hull's half-beam (+ margin) over its keel-to-deck depth, so the
 * vertical extent is generous (a boat landing on another touches ~0.5 m early). Built from the collision
 * hull's own vertices (§V77: the same deepV12 numbers the water sees), not hand-placed.
 */
import type { Vec3 } from '../state/simState';
import { applyRigid6Impulse, type Rigid6Body, type Rigid6State } from './rigidBody';

// ── params ───────────────────────────────────────────────────────────────────────────────────

export interface BoatCollideParams {
  /** boat↔boat restitution (Catto/tech-research §4.2: 0.25) */
  restitutionBoat: number;
  /** boat↔boat Coulomb friction (0.3) */
  frictionBoat: number;
  /** boat↔static/terrain restitution (0.1) */
  restitutionWorld: number;
  /** boat↔static/terrain Coulomb friction (0.5) */
  frictionWorld: number;
  /** V110: per-contact |Δv|/dt bound, m/s² (150 g: a 45 m/s head-on stops in two ticks) */
  maxImpactAccel: number;
  /** V110: per-contact |Δω|/dt bound, rad/s² (600: ≤ 10 rad/s per tick) */
  maxImpactAngularAccel: number;
  /** distance under which a swept pair counts as touching, m */
  touchSlop: number;
  /** allowed penetration before push-out, m */
  penetrationSlop: number;
  /** Baumgarte factor on penetration beyond the slop (tech-research ≤ 0.2) */
  baumgarte: number;
  /** push-out speed cap, m/s (a buried hull is walked out, never launched) */
  maxBiasSpeed: number;
  /** capsule radius beyond the proxy half-beam, m (render flare 2.47 vs chine 2.30 m + rub rail) */
  radiusMargin: number;
  /** bed gradient central-difference half-step, m */
  bedNormalStep: number;
  /** path samples per hull point per tick against the bed (≥ 1; 2 = start, middle, end) */
  bedSweepSamples: number;
  /** skip the bed solve when the bed under the hull axis is this far below the hull's reach, m */
  bedSkipMargin: number;
  /** Gauss–Seidel iterations over the bed contacts of one boat */
  bedIterations: number;
  /** speed fraction a flexible pole takes on first contact (GDD §3: gate pole −10%) */
  flexibleSpeedLoss: number;
  /**
   * §T.198 SOFT boat↔boat contact (the rolling-start formation, `softMask`): horizontal |Δv|/dt bound of the gentle
   * separation, m/s² — a fender rub that stops two converging hulls overlapping, never one that rolls a boat
   */
  softAccel: number;
  /** §T.198 soft contact push-out speed cap, m/s */
  softBiasSpeed: number;
}

export const BOAT_COLLIDE_DEFAULTS: Readonly<BoatCollideParams> = Object.freeze({
  restitutionBoat: 0.25,
  frictionBoat: 0.3,
  restitutionWorld: 0.1,
  frictionWorld: 0.5,
  maxImpactAccel: 150 * 9.81,
  maxImpactAngularAccel: 600,
  touchSlop: 0.01,
  penetrationSlop: 0.02,
  baumgarte: 0.2,
  maxBiasSpeed: 2,
  radiusMargin: 0.1,
  bedNormalStep: 0.5,
  bedSweepSamples: 2,
  bedSkipMargin: 1,
  bedIterations: 4,
  flexibleSpeedLoss: 0.1,
  softAccel: 3 * 9.81,
  softBiasSpeed: 1,
});

// ── geometry ─────────────────────────────────────────────────────────────────────────────────

/** what a collision hull is built from: the body-frame vertex cloud of the physics proxy (HullProxy satisfies it) */
export interface CollisionHullSource extends Rigid6Body {
  positions: Float64Array;
  vertexCount: number;
  /** body-frame prop points (the gearcases ground first) */
  drives?: readonly { prop: Vec3 }[];
}

export interface CollisionHull {
  /** capsule chain, body frame, stride 7: ax ay az bx by bz radius */
  capsules: Float64Array;
  capsuleCount: number;
  /** bed sample points, body frame, stride 3 */
  points: Float64Array;
  pointCount: number;
  /** max |x| over the capsules + radius, m (broadphase sphere about the CG) */
  boundRadius: number;
  /** max distance of any bed point from the CG, m */
  pointReach: number;
  /** foredeck point on the centreline (crash sensors: bow immersion), body frame */
  bowDeck: Vec3;
  /** body-frame z of the aft and forward extremes */
  zMin: number;
  zMax: number;
  mass: number;
  inertia: Vec3;
}

/** chain bin edges as fractions of the hull's z extent, aft → fore (finer where the bow tapers) */
const BIN_EDGES = [0, 0.3, 0.55, 0.72, 0.86, 1];

/**
 * The capsule chain and bed points from the proxy's vertices. Per z-bin: radius = max half-beam + margin (or half
 * the depth if deeper), axis at mid-depth; the chain's ends are pulled in by their radius so the rounded caps end
 * at the hull's (or the gearcases') extremes.
 */
export function buildCollisionHull(src: CollisionHullSource, params: Readonly<BoatCollideParams> = BOAT_COLLIDE_DEFAULTS): CollisionHull {
  const P = src.positions;
  const n = src.vertexCount;
  let zMin = Infinity;
  let zMax = -Infinity;
  for (let i = 0; i < n; i++) {
    zMin = Math.min(zMin, P[i * 3 + 2]);
    zMax = Math.max(zMax, P[i * 3 + 2]);
  }
  const props = src.drives ?? [];
  for (const d of props) zMin = Math.min(zMin, d.prop[2]);
  const span = zMax - zMin;
  const bins = BIN_EDGES.length - 1;
  const capsules = new Float64Array(bins * 7);
  let bound = 0;
  for (let k = 0; k < bins; k++) {
    const z0 = zMin + BIN_EDGES[k] * span;
    const z1 = zMin + BIN_EDGES[k + 1] * span;
    let hb = 0;
    let yLo = Infinity;
    let yHi = -Infinity;
    for (let i = 0; i < n; i++) {
      const z = P[i * 3 + 2];
      if (z < z0 - 1e-6 || z > z1 + 1e-6) continue;
      hb = Math.max(hb, Math.abs(P[i * 3]));
      yLo = Math.min(yLo, P[i * 3 + 1]);
      yHi = Math.max(yHi, P[i * 3 + 1]);
    }
    if (k === 0) {
      for (const d of props) {
        hb = Math.max(hb, Math.abs(d.prop[0]));
        yLo = Math.min(yLo, d.prop[1]);
      }
    }
    if (!(yHi >= yLo)) throw new Error(`boatCollide: collision hull bin ${k} holds no vertices`);
    const r = Math.max(hb + params.radiusMargin, 0.5 * (yHi - yLo));
    const yc = 0.5 * (yLo + yHi);
    let za = k === 0 ? z0 + r : z0;
    let zb = k === bins - 1 ? z1 - r : z1;
    if (za > zb) za = zb = 0.5 * (za + zb);
    capsules.set([0, yc, za, 0, yc, zb, r], k * 7);
    bound = Math.max(bound, Math.hypot(yc, za) + r, Math.hypot(yc, zb) + r);
  }

  // bed points: per bin the keel (lowest vertex), the widest-lowest vertex each side, the deck corners aft and
  // amidships, the foredeck stem, and every gearcase
  const pts: number[] = [];
  let bowDeck: Vec3 = [0, 0, zMax];
  let bowY = -Infinity;
  for (let k = 0; k < bins; k++) {
    const z0 = zMin + BIN_EDGES[k] * span;
    const z1 = zMin + BIN_EDGES[k + 1] * span;
    let keel = -1;
    let chP = -1;
    let chM = -1;
    for (let i = 0; i < n; i++) {
      const z = P[i * 3 + 2];
      if (z < z0 - 1e-6 || z > z1 + 1e-6) continue;
      const x = P[i * 3];
      const y = P[i * 3 + 1];
      if (keel < 0 || y < P[keel * 3 + 1]) keel = i;
      // chine = the widest vertex of the lower half of the section
      if (x > 0 && (chP < 0 || x - 0.3 * y > P[chP * 3] - 0.3 * P[chP * 3 + 1])) chP = i;
      if (x < 0 && (chM < 0 || -x - 0.3 * y > -P[chM * 3] - 0.3 * P[chM * 3 + 1])) chM = i;
    }
    for (const i of [keel, chP, chM]) if (i >= 0) pts.push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
  }
  let yDeck = -Infinity;
  for (let i = 0; i < n; i++) yDeck = Math.max(yDeck, P[i * 3 + 1]);
  for (const zf of [0.02, 0.45]) {
    const zt = zMin + zf * span;
    let best = -1;
    for (let i = 0; i < n; i++) {
      if (P[i * 3 + 1] < yDeck - 1e-6 || P[i * 3] <= 0) continue;
      if (best < 0 || Math.abs(P[i * 3 + 2] - zt) < Math.abs(P[best * 3 + 2] - zt)) best = i;
    }
    if (best >= 0) pts.push(P[best * 3], yDeck, P[best * 3 + 2], -P[best * 3], yDeck, P[best * 3 + 2]);
  }
  for (let i = 0; i < n; i++) {
    const y = P[i * 3 + 1];
    const z = P[i * 3 + 2];
    if (z >= zMax - 1e-6 && y > bowY) {
      bowY = y;
      bowDeck = [0, y, z];
    }
  }
  pts.push(bowDeck[0], bowDeck[1], bowDeck[2]);
  for (const d of props) pts.push(d.prop[0], d.prop[1], d.prop[2]);
  let reach = 0;
  for (let i = 0; i < pts.length; i += 3) reach = Math.max(reach, Math.hypot(pts[i], pts[i + 1], pts[i + 2]));
  // the crash sensors' foredeck point: centreline deck at 85% of the length (the stem vertex itself is a knife)
  const bowSensor: Vec3 = [0, yDeck, zMin + 0.85 * span];
  return {
    capsules,
    capsuleCount: bins,
    points: new Float64Array(pts),
    pointCount: pts.length / 3,
    boundRadius: bound,
    pointReach: reach,
    bowDeck: bowSensor,
    zMin,
    zMax,
    mass: src.mass,
    inertia: [src.inertia[0], src.inertia[1], src.inertia[2]],
  };
}

// ── static colliders (the circuit's interface) ───────────────────────────────────────────────

/**
 * A static obstacle, world frame. A vertical marker pole / tower leg / pylon leg = capsule from its foot (below
 * the seabed or waterline) to its top; a buoy or a rock = capsule with a = b (sphere). Guy wires and cables are
 * "high and harmless" (GDD §5) — do not list them.
 */
export interface StaticCollider {
  a: Vec3;
  b: Vec3;
  radius: number;
  /** a flexible gate pole: no push, a one-off `flexibleSpeedLoss` per contact episode (GDD §3) */
  flexible?: boolean;
  /** caller's id, reported back on contact (e.g. gate index) */
  id?: number;
}

/** the circuit's collider list, packed once (stride 9: ax ay az bx by bz r flexible id) with a bounding sphere each */
export interface StaticWorld {
  readonly data: Float64Array;
  readonly count: number;
  /** stride 4: cx cy cz radius */
  readonly bounds: Float64Array;
  /**
   * §T.198 broadphase: a uniform xz grid of bounding-sphere footprints (CSR: `cellStart[k]..cellStart[k+1]` index
   * `cellItems`). Tower Reach hands ~3 600 colliders (the drawn kit props); a linear scan cost 1–2.6 ms per boat per
   * tick. The grid only NARROWS the candidates — they are then tested in collider index order, exactly as the scan did.
   */
  readonly grid: { readonly cell: number; readonly x0: number; readonly z0: number; readonly nx: number; readonly nz: number; readonly cellStart: Int32Array; readonly cellItems: Int32Array };
}

/** broadphase cell size, m (a hull's reach at 45 m/s is ≈ 7 m: a query spans ≤ 2×2 cells) */
export const STATIC_GRID_CELL = 24;

export function prepareStaticWorld(colliders: readonly StaticCollider[]): StaticWorld {
  const data = new Float64Array(colliders.length * 9);
  const bounds = new Float64Array(colliders.length * 4);
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  colliders.forEach((c, i) => {
    if (!(c.radius > 0) || ![...c.a, ...c.b].every(Number.isFinite)) throw new Error(`boatCollide: bad static collider ${i}`);
    data.set([c.a[0], c.a[1], c.a[2], c.b[0], c.b[1], c.b[2], c.radius, c.flexible ? 1 : 0, c.id ?? i], i * 9);
    const cx = 0.5 * (c.a[0] + c.b[0]);
    const cy = 0.5 * (c.a[1] + c.b[1]);
    const cz = 0.5 * (c.a[2] + c.b[2]);
    const r = 0.5 * Math.hypot(c.b[0] - c.a[0], c.b[1] - c.a[1], c.b[2] - c.a[2]) + c.radius;
    bounds.set([cx, cy, cz, r], i * 4);
    minX = Math.min(minX, cx - r);
    minZ = Math.min(minZ, cz - r);
    maxX = Math.max(maxX, cx + r);
    maxZ = Math.max(maxZ, cz + r);
  });
  const cell = STATIC_GRID_CELL;
  const n = colliders.length;
  const x0 = n > 0 ? minX : 0;
  const z0 = n > 0 ? minZ : 0;
  const nx = n > 0 ? Math.max(1, Math.ceil((maxX - minX) / cell)) : 1;
  const nz = n > 0 ? Math.max(1, Math.ceil((maxZ - minZ) / cell)) : 1;
  const range = (i: number): [number, number, number, number] => {
    const cx = bounds[i * 4];
    const cz = bounds[i * 4 + 2];
    const r = bounds[i * 4 + 3];
    const clampX = (v: number): number => Math.max(0, Math.min(nx - 1, Math.floor((v - x0) / cell)));
    const clampZ = (v: number): number => Math.max(0, Math.min(nz - 1, Math.floor((v - z0) / cell)));
    return [clampX(cx - r), clampX(cx + r), clampZ(cz - r), clampZ(cz + r)];
  };
  const counts = new Int32Array(nx * nz + 1);
  for (let i = 0; i < n; i++) {
    const [ax, bx, az, bz] = range(i);
    for (let gz = az; gz <= bz; gz++) for (let gx = ax; gx <= bx; gx++) counts[gz * nx + gx + 1]++;
  }
  for (let k = 0; k < nx * nz; k++) counts[k + 1] += counts[k];
  const cellItems = new Int32Array(counts[nx * nz]);
  const fill = counts.slice(0, nx * nz);
  for (let i = 0; i < n; i++) {
    const [ax, bx, az, bz] = range(i);
    for (let gz = az; gz <= bz; gz++) for (let gx = ax; gx <= bx; gx++) cellItems[fill[gz * nx + gx]++] = i;
  }
  return { data, count: n, bounds, grid: { cell, x0, z0, nx, nz, cellStart: counts, cellItems } };
}

/** the sim worker's collision hook (plain data, structured-cloned into each worker once) */
export interface BoatContactSetup {
  /** boat↔boat contacts between the fleet's boats */
  boats: boolean;
  /** the circuit's static colliders */
  colliders?: StaticCollider[];
  params?: Partial<BoatCollideParams>;
}

/** world seabed / terrain elevation at (x, z), m (waterline 0) — `SeabedField.heightAt` satisfies it */
export type BedHeight = (x: number, z: number) => number;

// ── results and memory ───────────────────────────────────────────────────────────────────────

export const CONTACT_NONE = 0;
export const CONTACT_BOAT = 1;
export const CONTACT_SOLID = 2;
export const CONTACT_FLEXIBLE = 3;
export const CONTACT_BED = 4;

/** sub-contacts one boat pair may resolve in one tick (earliest first, re-swept after each) */
export const MAX_PAIR_CONTACTS = 4;

/** one swept pair result (boat↔boat or boat↔static), impulse = on B, world */
export interface PairContact {
  hit: boolean;
  /** resolved sub-contacts this tick (boat pairs; statics use 1): impulse k on B at armsA/armsB k, stride 3 */
  count: number;
  impulses: Float64Array;
  armsA: Float64Array;
  armsB: Float64Array;
  /** time of impact within the tick, s (0 = touching/penetrating at the start) */
  toi: number;
  /** signed surface distance at the tick start, m (< 0 penetrating) */
  depth0: number;
  /** unit normal A → B, world */
  normal: Float64Array;
  /** world contact point at the time of impact */
  point: Float64Array;
  /** arms from each CG (A, then B) of the largest sub-contact, world */
  armA: Float64Array;
  armB: Float64Array;
  /** Σ impulse on B (A receives −J), N·s, after the V110 bound */
  impulse: Float64Array;
  /** normal closing speed at the contact before the impulse, m/s (≥ 0) */
  approachSpeed: number;
  /** |Δv| of A and of B from this contact, m/s */
  deltaVA: number;
  deltaVB: number;
  /** V110 scale applied (1 = unbounded) */
  capScale: number;
}

export function createPairContact(): PairContact {
  return {
    hit: false,
    count: 0,
    impulses: new Float64Array(MAX_PAIR_CONTACTS * 3),
    armsA: new Float64Array(MAX_PAIR_CONTACTS * 3),
    armsB: new Float64Array(MAX_PAIR_CONTACTS * 3),
    toi: 0,
    depth0: 0,
    normal: new Float64Array(3),
    point: new Float64Array(3),
    armA: new Float64Array(3),
    armB: new Float64Array(3),
    impulse: new Float64Array(3),
    approachSpeed: 0,
    deltaVA: 0,
    deltaVB: 0,
    capScale: 1,
  };
}

/** what one boat's collisions did this tick (crash sensors, damage, HUD/audio/camera events read it) */
export interface BoatContactReport {
  /** contacts that pushed this boat this tick (all sources) */
  count: number;
  /** largest single-contact |Δv| on this boat this tick, m/s */
  maxDeltaV: number;
  /** CONTACT_* of that largest contact */
  source: number;
  /** its body-frame arm (where on the hull), m */
  bodyPoint: Float64Array;
  /** its closing speed, m/s */
  approachSpeed: number;
  /** other boat index (CONTACT_BOAT) or collider id (static), −1 otherwise */
  other: number;
  /** flexible poles newly hit this tick */
  flexibleHits: number;
  /** any boat capsule overlapping this one at the tick start, ghosts included (ghost ends only when clear) */
  overlapsBoat: boolean;
  /** Σ impulse on this boat this tick, world, N·s (after bounds) */
  impulse: Float64Array;
  /** V110 scale the world solve applied (1 = unbounded) */
  worldCapScale: number;
}

/** per-boat scratch + contact-episode memory; nothing here is location memory (a teleport needs no reset of it) */
export interface BoatCollideMemory {
  readonly pair: PairContact;
  /** one sub-contact's scratch */
  readonly sub: PairContact;
  readonly report: BoatContactReport;
  /** packed chain of this boat and of the other body, stride 13: a3 b3 ua3 ub3 r */
  readonly chainA: Float64Array;
  readonly chainB: Float64Array;
  readonly poseA: Rigid6State;
  readonly poseB: Rigid6State;
  /** the pair's velocities as sub-contacts are resolved */
  readonly workA: Rigid6State;
  readonly workB: Rigid6State;
  readonly tmp: Float64Array;
  /** swept hit scratch [toi, i, j, s, t, dist, depth0] */
  readonly hit: Float64Array;
  /** bed contacts, stride 14: arm3 normal3 gap touching vn0 accN accT Kn pad */
  readonly bed: Float64Array;
  /** flexible collider ids this boat is inside (contact episodes), −1 = free slot */
  readonly flexTouching: Float64Array;
  readonly flexSeen: Uint8Array;
  /** §T.198 broadphase candidates of the current query (grown once to the world's collider count) */
  cand: Int32Array;
  /** §T.198 the soft-contact params derived from the last `prm` seen (cached: no allocation per tick) */
  soft: { from: Readonly<BoatCollideParams>; prm: BoatCollideParams } | null;
}

export function createBoatCollideMemory(hull: CollisionHull): BoatCollideMemory {
  const n = Math.max(hull.capsuleCount, 1);
  return {
    pair: createPairContact(),
    sub: createPairContact(),
    report: {
      count: 0,
      maxDeltaV: 0,
      source: CONTACT_NONE,
      bodyPoint: new Float64Array(3),
      approachSpeed: 0,
      other: -1,
      flexibleHits: 0,
      overlapsBoat: false,
      impulse: new Float64Array(3),
      worldCapScale: 1,
    },
    chainA: new Float64Array(n * 13),
    chainB: new Float64Array(n * 13),
    poseA: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] },
    poseB: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] },
    workA: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] },
    workB: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] },
    tmp: new Float64Array(32),
    hit: new Float64Array(8),
    bed: new Float64Array(hull.pointCount * 14),
    flexTouching: new Float64Array(8).fill(-1),
    flexSeen: new Uint8Array(8),
    cand: new Int32Array(64),
    soft: null,
  };
}

/** the pair params of a SOFT contact: no bounce, no friction, the gentle bias; the V110 bound set to the soft accel */
function softParams(mem: BoatCollideMemory, prm: Readonly<BoatCollideParams>): Readonly<BoatCollideParams> {
  if (mem.soft && mem.soft.from === prm) return mem.soft.prm;
  const soft: BoatCollideParams = { ...prm, restitutionBoat: 0, frictionBoat: 0, maxBiasSpeed: prm.softBiasSpeed, maxImpactAccel: prm.softAccel, maxImpactAngularAccel: 1e12 };
  mem.soft = { from: prm, prm: soft };
  return soft;
}

/** V108 teleport: forget contact episodes (a flexible pole touched at the crash site is not touched at the respawn) */
export function resetBoatCollideMemory(mem: BoatCollideMemory): void {
  mem.flexTouching.fill(-1);
  mem.flexSeen.fill(0);
  beginContactTick(mem);
}

/** clear the per-tick report (collideBoatWithFleet / collideBoatWithWorld only ADD to it) */
export function beginContactTick(mem: BoatCollideMemory): void {
  const r = mem.report;
  r.count = 0;
  r.maxDeltaV = 0;
  r.source = CONTACT_NONE;
  r.bodyPoint.fill(0);
  r.approachSpeed = 0;
  r.other = -1;
  r.flexibleHits = 0;
  r.overlapsBoat = false;
  r.impulse.fill(0);
  r.worldCapScale = 1;
}

// ── small math (scalar, into scratch) ────────────────────────────────────────────────────────

/** out[o..o+3] = R(q)·(x, y, z) */
function rot(q: ArrayLike<number>, x: number, y: number, z: number, out: Float64Array, o: number): void {
  const qx = q[0];
  const qy = q[1];
  const qz = q[2];
  const qw = q[3];
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[o] = x + qw * tx + (qy * tz - qz * ty);
  out[o + 1] = y + qw * ty + (qz * tx - qx * tz);
  out[o + 2] = z + qw * tz + (qx * ty - qy * tx);
}

/** out[o..o+3] = Rᵀ(q)·(x, y, z) */
function rotInv(q: ArrayLike<number>, x: number, y: number, z: number, out: Float64Array, o: number): void {
  const qx = -q[0];
  const qy = -q[1];
  const qz = -q[2];
  const qw = q[3];
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[o] = x + qw * tx + (qy * tz - qz * ty);
  out[o + 1] = y + qw * ty + (qz * tx - qx * tz);
  out[o + 2] = z + qw * tz + (qx * ty - qy * tx);
}

/** out[o..o+3] = R·I⁻¹·Rᵀ·(x, y, z) (rigid inertia) */
function invInertiaWorld(q: ArrayLike<number>, I: ArrayLike<number>, x: number, y: number, z: number, out: Float64Array, o: number): void {
  rotInv(q, x, y, z, out, o);
  rot(q, out[o] / I[0], out[o + 1] / I[1], out[o + 2] / I[2], out, o);
}

/** n·((I⁻¹(r×n))×r) — the angular part of the effective inverse mass along n at arm r */
function angularK(q: ArrayLike<number>, I: ArrayLike<number>, rx: number, ry: number, rz: number, nx: number, ny: number, nz: number, s: Float64Array): number {
  invInertiaWorld(q, I, ry * nz - rz * ny, rz * nx - rx * nz, rx * ny - ry * nx, s, 0);
  const cx = s[1] * rz - s[2] * ry;
  const cy = s[2] * rx - s[0] * rz;
  const cz = s[0] * ry - s[1] * rx;
  return nx * cx + ny * cy + nz * cz;
}

/** |I⁻¹(r×J)| */
function angularDelta(q: ArrayLike<number>, I: ArrayLike<number>, rx: number, ry: number, rz: number, jx: number, jy: number, jz: number, s: Float64Array): number {
  invInertiaWorld(q, I, ry * jz - rz * jy, rz * jx - rx * jz, rx * jy - ry * jx, s, 0);
  return Math.hypot(s[0], s[1], s[2]);
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Closest points between segments P1Q1 and P2Q2 (Ericson 2005 §5.1.9). Writes s, t into out[0], out[1] and
 * returns the squared distance.
 */
function segSeg(
  p1x: number, p1y: number, p1z: number, q1x: number, q1y: number, q1z: number,
  p2x: number, p2y: number, p2z: number, q2x: number, q2y: number, q2z: number,
  out: Float64Array,
): number {
  const d1x = q1x - p1x;
  const d1y = q1y - p1y;
  const d1z = q1z - p1z;
  const d2x = q2x - p2x;
  const d2y = q2y - p2y;
  const d2z = q2z - p2z;
  const rx = p1x - p2x;
  const ry = p1y - p2y;
  const rz = p1z - p2z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s = 0;
  let t = 0;
  const EPS = 1e-12;
  if (a <= EPS && e <= EPS) {
    s = t = 0;
  } else if (a <= EPS) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPS) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      s = denom > EPS * a * e ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  out[0] = s;
  out[1] = t;
  const dx = p1x + d1x * s - (p2x + d2x * t);
  const dy = p1y + d1y * s - (p2y + d2y * t);
  const dz = p1z + d1z * s - (p2z + d2z * t);
  return dx * dx + dy * dy + dz * dz;
}

/** pack a body's capsule chain in world space with endpoint velocities (stride 13) */
function packChain(state: Readonly<Rigid6State>, hull: CollisionHull, out: Float64Array): void {
  const q = state.quaternion;
  const p = state.position;
  const v = state.velocity;
  const w = state.angularVelocity;
  const C = hull.capsules;
  for (let k = 0; k < hull.capsuleCount; k++) {
    const o = k * 13;
    const c = k * 7;
    for (let e = 0; e < 2; e++) {
      rot(q, C[c + 3 * e], C[c + 3 * e + 1], C[c + 3 * e + 2], out, o + 6 + 3 * e); // arm, temporarily in the velocity slot
      const ax = out[o + 6 + 3 * e];
      const ay = out[o + 7 + 3 * e];
      const az = out[o + 8 + 3 * e];
      out[o + 3 * e] = p[0] + ax;
      out[o + 3 * e + 1] = p[1] + ay;
      out[o + 3 * e + 2] = p[2] + az;
      out[o + 6 + 3 * e] = v[0] + (w[1] * az - w[2] * ay);
      out[o + 7 + 3 * e] = v[1] + (w[2] * ax - w[0] * az);
      out[o + 8 + 3 * e] = v[2] + (w[0] * ay - w[1] * ax);
    }
    out[o + 12] = C[c + 6];
  }
}

const MAX_CA_ITERATIONS = 32;

/**
 * Earliest time of impact in [0, dt] between two linearly moving capsule chains (conservative advancement per
 * capsule pair; the closing-rate bound is the largest endpoint relative velocity, which bounds every point pair
 * because a point's velocity is a convex blend of its endpoints'). Returns −1 for no contact; otherwise writes
 * the capsule pair and segment parameters into `hitOut` [toi, i, j, s, t, dist, depth0]. Capsule pairs whose bit
 * (i·nB + j) is set in `exclude` are skipped (≤ 32 pairs).
 */
function sweepChains(A: Float64Array, nA: number, B: Float64Array, nB: number, dt: number, slop: number, st: Float64Array, hitOut: Float64Array, exclude = 0): number {
  let best = Infinity;
  let bestDepth = Infinity;
  for (let i = 0; i < nA; i++) {
    const a = i * 13;
    for (let j = 0; j < nB; j++) {
      if (exclude !== 0 && ((exclude >>> (i * nB + j)) & 1) === 1) continue;
      const b = j * 13;
      const rs = A[a + 12] + B[b + 12];
      let bound = 0;
      for (let ea = 0; ea < 2; ea++) {
        for (let eb = 0; eb < 2; eb++) {
          const ux = A[a + 6 + 3 * ea] - B[b + 6 + 3 * eb];
          const uy = A[a + 7 + 3 * ea] - B[b + 7 + 3 * eb];
          const uz = A[a + 8 + 3 * ea] - B[b + 8 + 3 * eb];
          const m = ux * ux + uy * uy + uz * uz;
          if (m > bound) bound = m;
        }
      }
      bound = Math.sqrt(bound);
      let t = 0;
      let depth0 = 0;
      let hit = false;
      let dist = 0;
      for (let it = 0; it < MAX_CA_ITERATIONS; it++) {
        const d2 = segSeg(
          A[a] + t * A[a + 6], A[a + 1] + t * A[a + 7], A[a + 2] + t * A[a + 8],
          A[a + 3] + t * A[a + 9], A[a + 4] + t * A[a + 10], A[a + 5] + t * A[a + 11],
          B[b] + t * B[b + 6], B[b + 1] + t * B[b + 7], B[b + 2] + t * B[b + 8],
          B[b + 3] + t * B[b + 9], B[b + 4] + t * B[b + 10], B[b + 5] + t * B[b + 11],
          st,
        );
        dist = Math.sqrt(d2);
        const d = dist - rs;
        if (it === 0) depth0 = d;
        if (d <= slop) {
          hit = true;
          break;
        }
        if (bound <= 1e-9) break;
        t += d / bound;
        if (t > dt) break;
        if (it === MAX_CA_ITERATIONS - 1) hit = true; // grazing for the whole tick: report it (no impulse unless closing)
      }
      if (!hit) continue;
      // earliest wins; among pairs touching at the start, the deepest
      if (t < best - 1e-12 || (t <= 1e-12 && best <= 1e-12 && depth0 < bestDepth)) {
        best = t;
        bestDepth = depth0;
        hitOut[0] = t;
        hitOut[1] = i;
        hitOut[2] = j;
        hitOut[3] = st[0];
        hitOut[4] = st[1];
        hitOut[5] = dist;
        hitOut[6] = depth0;
      }
    }
  }
  return best === Infinity ? -1 : best;
}

/**
 * The response for a swept hit already in `hit` (from sweepChains). B may be static (bodyB null).
 * Fills `out`. Does NOT apply anything.
 */
function resolveSwept(
  sA: Readonly<Rigid6State>,
  bodyA: Rigid6Body,
  sB: Readonly<Rigid6State> | null,
  bodyB: Rigid6Body | null,
  A: Float64Array,
  B: Float64Array,
  dt: number,
  restitution: number,
  friction: number,
  prm: Readonly<BoatCollideParams>,
  hit: Float64Array,
  s: Float64Array,
  out: PairContact,
): void {
  const t = hit[0];
  const a = hit[1] * 13;
  const b = hit[2] * 13;
  const u = hit[3];
  const w = hit[4];
  const rA = A[a + 12];
  const rB = B[b + 12];
  const cAx = (A[a] + t * A[a + 6]) * (1 - u) + (A[a + 3] + t * A[a + 9]) * u;
  const cAy = (A[a + 1] + t * A[a + 7]) * (1 - u) + (A[a + 4] + t * A[a + 10]) * u;
  const cAz = (A[a + 2] + t * A[a + 8]) * (1 - u) + (A[a + 5] + t * A[a + 11]) * u;
  const cBx = (B[b] + t * B[b + 6]) * (1 - w) + (B[b + 3] + t * B[b + 9]) * w;
  const cBy = (B[b + 1] + t * B[b + 7]) * (1 - w) + (B[b + 4] + t * B[b + 10]) * w;
  const cBz = (B[b + 2] + t * B[b + 8]) * (1 - w) + (B[b + 5] + t * B[b + 11]) * w;
  let nx = cBx - cAx;
  let ny = cBy - cAy;
  let nz = cBz - cAz;
  let len = Math.hypot(nx, ny, nz);
  if (len < 1e-6) {
    // axes cross: separate along the horizontal line between the bodies' reference points
    nx = (sB ? sB.position[0] : cBx) - sA.position[0];
    ny = 0;
    nz = (sB ? sB.position[2] : cBz) - sA.position[2];
    len = Math.hypot(nx, nz);
    if (len < 1e-9) {
      nx = 1;
      nz = 0;
      len = 1;
    }
  }
  nx /= len;
  ny /= len;
  nz /= len;
  const gap = hit[5] - rA - rB;
  const px = cAx + nx * (rA + 0.5 * gap);
  const py = cAy + ny * (rA + 0.5 * gap);
  const pz = cAz + nz * (rA + 0.5 * gap);
  out.hit = true;
  out.toi = t;
  out.depth0 = hit[6];
  out.normal[0] = nx;
  out.normal[1] = ny;
  out.normal[2] = nz;
  out.point[0] = px;
  out.point[1] = py;
  out.point[2] = pz;
  const vA = sA.velocity;
  const wA = sA.angularVelocity;
  const aX = (out.armA[0] = px - (sA.position[0] + t * vA[0]));
  const aY = (out.armA[1] = py - (sA.position[1] + t * vA[1]));
  const aZ = (out.armA[2] = pz - (sA.position[2] + t * vA[2]));
  let vBx = 0;
  let vBy = 0;
  let vBz = 0;
  let bX = 0;
  let bY = 0;
  let bZ = 0;
  if (sB) {
    const vB = sB.velocity;
    const wB = sB.angularVelocity;
    bX = out.armB[0] = px - (sB.position[0] + t * vB[0]);
    bY = out.armB[1] = py - (sB.position[1] + t * vB[1]);
    bZ = out.armB[2] = pz - (sB.position[2] + t * vB[2]);
    vBx = vB[0] + (wB[1] * bZ - wB[2] * bY);
    vBy = vB[1] + (wB[2] * bX - wB[0] * bZ);
    vBz = vB[2] + (wB[0] * bY - wB[1] * bX);
  } else {
    out.armB.fill(0);
  }
  const rvx = vBx - (vA[0] + (wA[1] * aZ - wA[2] * aY));
  const rvy = vBy - (vA[1] + (wA[2] * aX - wA[0] * aZ));
  const rvz = vBz - (vA[2] + (wA[0] * aY - wA[1] * aX));
  const vn = rvx * nx + rvy * ny + rvz * nz;
  out.approachSpeed = vn < 0 ? -vn : 0;
  out.impulse.fill(0);
  out.deltaVA = out.deltaVB = 0;
  out.capScale = 1;
  let target = vn < 0 ? -restitution * vn : vn;
  if (hit[6] < 0) {
    const bias = Math.min((prm.baumgarte * Math.max(0, -hit[6] - prm.penetrationSlop)) / dt, prm.maxBiasSpeed);
    if (bias > target) target = bias;
  }
  if (target <= vn) return; // separating fast enough
  const imA = 1 / bodyA.mass;
  const imB = bodyB ? 1 / bodyB.mass : 0;
  const Kn = imA + angularK(sA.quaternion, bodyA.inertia, aX, aY, aZ, nx, ny, nz, s) + (sB && bodyB ? imB + angularK(sB.quaternion, bodyB.inertia, bX, bY, bZ, nx, ny, nz, s) : 0);
  const jn = (target - vn) / Kn;
  let jx = jn * nx;
  let jy = jn * ny;
  let jz = jn * nz;
  // Coulomb friction against the tangential slip at the contact
  const tx = rvx - vn * nx;
  const ty = rvy - vn * ny;
  const tz = rvz - vn * nz;
  const vt = Math.hypot(tx, ty, tz);
  if (vt > 1e-6 && friction > 0) {
    const ux = tx / vt;
    const uy = ty / vt;
    const uz = tz / vt;
    const Kt = imA + angularK(sA.quaternion, bodyA.inertia, aX, aY, aZ, ux, uy, uz, s) + (sB && bodyB ? imB + angularK(sB.quaternion, bodyB.inertia, bX, bY, bZ, ux, uy, uz, s) : 0);
    const jt = Math.min(vt / Kt, friction * jn);
    jx -= jt * ux;
    jy -= jt * uy;
    jz -= jt * uz;
  }
  // V110: one scale for the whole contact, both bodies
  const jm = Math.hypot(jx, jy, jz);
  const capV = prm.maxImpactAccel * dt;
  const capW = prm.maxImpactAngularAccel * dt;
  let sc = 1;
  const dvA = jm * imA;
  const dwA = angularDelta(sA.quaternion, bodyA.inertia, aX, aY, aZ, jx, jy, jz, s);
  if (dvA > capV) sc = Math.min(sc, capV / dvA);
  if (dwA > capW) sc = Math.min(sc, capW / dwA);
  if (sB && bodyB) {
    const dvB = jm * imB;
    const dwB = angularDelta(sB.quaternion, bodyB.inertia, bX, bY, bZ, jx, jy, jz, s);
    if (dvB > capV) sc = Math.min(sc, capV / dvB);
    if (dwB > capW) sc = Math.min(sc, capW / dwB);
  }
  out.impulse[0] = jx * sc;
  out.impulse[1] = jy * sc;
  out.impulse[2] = jz * sc;
  out.capScale = sc;
  out.deltaVA = jm * sc * imA;
  out.deltaVB = jm * sc * imB;
}

// ── boat ↔ boat ──────────────────────────────────────────────────────────────────────────────

function copyState(src: Readonly<Rigid6State>, dst: Rigid6State): void {
  for (let k = 0; k < 3; k++) {
    dst.position[k] = src.position[k];
    dst.velocity[k] = src.velocity[k];
    dst.angularVelocity[k] = src.angularVelocity[k];
  }
  for (let k = 0; k < 4; k++) dst.quaternion[k] = src.quaternion[k];
}

/**
 * The swept contact between boat A and boat B over one tick from their tick-start poses. Pure: reads the two
 * states, writes `mem.pair` (impulses on B; A gets the negatives). Up to MAX_PAIR_CONTACTS sub-contacts: after
 * each, the pair is re-swept with the new velocities, so a boat sliding along another at 100 m/s meets the next
 * capsule at its own time of impact instead of sinking into it. V110 bounds the pair's summed response with one
 * scale on every sub-impulse (both boats: momentum stays conserved). Returns true if anything was pushed.
 */
export function boatPairContact(
  a: Readonly<Rigid6State>,
  hullA: CollisionHull,
  b: Readonly<Rigid6State>,
  hullB: CollisionHull,
  dt: number,
  mem: BoatCollideMemory,
  prm: Readonly<BoatCollideParams> = BOAT_COLLIDE_DEFAULTS,
): boolean {
  const out = mem.pair;
  out.hit = false;
  out.count = 0;
  out.impulse.fill(0);
  out.approachSpeed = 0;
  out.deltaVA = out.deltaVB = 0;
  out.capScale = 1;
  out.depth0 = 0;
  // broadphase: bounding spheres, closing bound over the tick
  const dx = b.position[0] - a.position[0];
  const dy = b.position[1] - a.position[1];
  const dz = b.position[2] - a.position[2];
  const wa = Math.hypot(a.angularVelocity[0], a.angularVelocity[1], a.angularVelocity[2]);
  const wb = Math.hypot(b.angularVelocity[0], b.angularVelocity[1], b.angularVelocity[2]);
  const rv = Math.hypot(b.velocity[0] - a.velocity[0], b.velocity[1] - a.velocity[1], b.velocity[2] - a.velocity[2]);
  const reach = hullA.boundRadius + hullB.boundRadius + (rv + wa * hullA.boundRadius + wb * hullB.boundRadius) * dt + prm.touchSlop;
  if (dx * dx + dy * dy + dz * dz > reach * reach) return false;
  const A = mem.workA;
  const B = mem.workB;
  copyState(a, A);
  copyState(b, B);
  const sub = mem.sub;
  const hit = mem.hit;
  let biggest = 0;
  // capsule pairs found touching but already separating: skipped by the next sweep so an approaching pair behind
  // them is still found (a boat spinning alongside touches with one capsule and closes with another)
  let quiet = 0;
  const pairs = hullA.capsuleCount * hullB.capsuleCount;
  if (pairs > 32) throw new Error('boatCollide: at most 32 capsule pairs per boat pair');
  for (let sweep = 0; sweep < 2 * MAX_PAIR_CONTACTS && out.count < MAX_PAIR_CONTACTS; sweep++) {
    packChain(A, hullA, mem.chainA);
    packChain(B, hullB, mem.chainB);
    if (sweepChains(mem.chainA, hullA.capsuleCount, mem.chainB, hullB.capsuleCount, dt, prm.touchSlop, mem.tmp, hit, quiet) < 0) break;
    resolveSwept(A, hullA, B, hullB, mem.chainA, mem.chainB, dt, prm.restitutionBoat, prm.frictionBoat, prm, hit, mem.tmp, sub);
    if (!out.hit) {
      out.hit = true;
      out.toi = sub.toi;
      out.depth0 = sub.depth0;
      out.normal.set(sub.normal);
      out.point.set(sub.point);
    }
    out.approachSpeed = Math.max(out.approachSpeed, sub.approachSpeed);
    const J = sub.impulse;
    if (J[0] === 0 && J[1] === 0 && J[2] === 0) {
      quiet |= 1 << (hit[1] * hullB.capsuleCount + hit[2]);
      continue;
    }
    quiet = 0;
    const k = out.count++;
    out.impulses.set(J, k * 3);
    out.armsA.set(sub.armA, k * 3);
    out.armsB.set(sub.armB, k * 3);
    const jm = Math.hypot(J[0], J[1], J[2]);
    if (jm > biggest) {
      biggest = jm;
      out.armA.set(sub.armA);
      out.armB.set(sub.armB);
    }
    applyRigid6Impulse(A, hullA, sub.armA[0], sub.armA[1], sub.armA[2], -J[0], -J[1], -J[2]);
    applyRigid6Impulse(B, hullB, sub.armB[0], sub.armB[1], sub.armB[2], J[0], J[1], J[2]);
  }
  if (out.count === 0) return false;
  // V110 on the pair's summed response: one scale for every sub-impulse, both boats
  const capV = prm.maxImpactAccel * dt;
  const capW = prm.maxImpactAngularAccel * dt;
  const dvA = Math.hypot(A.velocity[0] - a.velocity[0], A.velocity[1] - a.velocity[1], A.velocity[2] - a.velocity[2]);
  const dvB = Math.hypot(B.velocity[0] - b.velocity[0], B.velocity[1] - b.velocity[1], B.velocity[2] - b.velocity[2]);
  const dwA = Math.hypot(A.angularVelocity[0] - a.angularVelocity[0], A.angularVelocity[1] - a.angularVelocity[1], A.angularVelocity[2] - a.angularVelocity[2]);
  const dwB = Math.hypot(B.angularVelocity[0] - b.angularVelocity[0], B.angularVelocity[1] - b.angularVelocity[1], B.angularVelocity[2] - b.angularVelocity[2]);
  let sc = 1;
  if (dvA > capV) sc = Math.min(sc, capV / dvA);
  if (dvB > capV) sc = Math.min(sc, capV / dvB);
  if (dwA > capW) sc = Math.min(sc, capW / dwA);
  if (dwB > capW) sc = Math.min(sc, capW / dwB);
  for (let k = 0; k < out.count * 3; k++) {
    out.impulses[k] *= sc;
    out.impulse[k % 3] += out.impulses[k];
  }
  out.capScale = sc;
  out.deltaVA = dvA * sc;
  out.deltaVB = dvB * sc;
  return true;
}

/** apply a pair result to both live boats (the in-process path; a worker applies one side via collideBoatWithFleet) */
export function applyPairContact(a: Rigid6State, bodyA: Rigid6Body, b: Rigid6State, bodyB: Rigid6Body, c: Readonly<PairContact>): void {
  for (let k = 0; k < c.count; k++) {
    const o = k * 3;
    const J = c.impulses;
    applyRigid6Impulse(a, bodyA, c.armsA[o], c.armsA[o + 1], c.armsA[o + 2], -J[o], -J[o + 1], -J[o + 2]);
    applyRigid6Impulse(b, bodyB, c.armsB[o], c.armsB[o + 1], c.armsB[o + 2], J[o], J[o + 1], J[o + 2]);
  }
}

export const POSE_STRIDE = 13;

function readPose(poses: Float64Array, base: number, i: number, out: Rigid6State): void {
  const o = base + i * POSE_STRIDE;
  out.position[0] = poses[o];
  out.position[1] = poses[o + 1];
  out.position[2] = poses[o + 2];
  out.quaternion[0] = poses[o + 3];
  out.quaternion[1] = poses[o + 4];
  out.quaternion[2] = poses[o + 5];
  out.quaternion[3] = poses[o + 6];
  out.velocity[0] = poses[o + 7];
  out.velocity[1] = poses[o + 8];
  out.velocity[2] = poses[o + 9];
  out.angularVelocity[0] = poses[o + 10];
  out.angularVelocity[1] = poses[o + 11];
  out.angularVelocity[2] = poses[o + 12];
}

/** pack a state into a pose array at slot i (the WORLD snapshot layout: p3 q4 v3 ω3) */
export function writePose(poses: Float64Array, base: number, i: number, s: Readonly<Rigid6State>): void {
  const o = base + i * POSE_STRIDE;
  poses[o] = s.position[0];
  poses[o + 1] = s.position[1];
  poses[o + 2] = s.position[2];
  poses[o + 3] = s.quaternion[0];
  poses[o + 4] = s.quaternion[1];
  poses[o + 5] = s.quaternion[2];
  poses[o + 6] = s.quaternion[3];
  poses[o + 7] = s.velocity[0];
  poses[o + 8] = s.velocity[1];
  poses[o + 9] = s.velocity[2];
  poses[o + 10] = s.angularVelocity[0];
  poses[o + 11] = s.angularVelocity[1];
  poses[o + 12] = s.angularVelocity[2];
}

/** is boat i a ghost in a 32-bit mask (boats ≥ 32 cannot be ghosted — collideBoatWithFleet throws for them) */
export function isGhost(mask: number, i: number): boolean {
  return i < 32 && ((mask >>> i) & 1) === 1;
}

/**
 * Boat i against every other boat of the tick-k snapshot `poses` (stride 13 from `base`, `count` boats), applying
 * THIS boat's share to `self` (its live state, normally equal to its snapshot). Pair (lo, hi) is always computed
 * as A = lo, B = hi, so a worker holding boat j computes the same numbers and applies the negative (§V2).
 * `ghostMask` bit i set ⇒ boat i makes and receives no boat contacts (respawn ghost, GDD 2 s), but overlap is
 * still reported so the ghost can end only when clear. Adds to `mem.report`; returns the contacts applied.
 *
 * §T.198 `softMask` bit i set (and neither boat a ghost) ⇒ the pair is a SOFT contact: the same swept pair with no
 * restitution or friction, bounded at `softAccel`, applied as a HORIZONTAL impulse through the CG (no roll, heave or
 * yaw). The rolling-start formation: hulls converging onto one line are kept apart instead of passing through each
 * other (contacts off) or rolling each other over (full contacts, §T.191's smoke race).
 */
export function collideBoatWithFleet(
  i: number,
  self: Rigid6State,
  hulls: CollisionHull | readonly CollisionHull[],
  poses: Float64Array,
  base: number,
  count: number,
  ghostMask: number,
  dt: number,
  mem: BoatCollideMemory,
  prm: Readonly<BoatCollideParams> = BOAT_COLLIDE_DEFAULTS,
  softMask = 0,
): number {
  if (count > 32) throw new Error(`boatCollide: the contact-off mask holds 32 boats, fleet has ${count}`);
  const rep = mem.report;
  const many = Array.isArray(hulls);
  const ghostI = isGhost(ghostMask, i);
  let applied = 0;
  for (let j = 0; j < count; j++) {
    if (j === i) continue;
    const lo = i < j ? i : j;
    const hi = i < j ? j : i;
    readPose(poses, base, lo, mem.poseA);
    readPose(poses, base, hi, mem.poseB);
    const ghost = ghostI || isGhost(ghostMask, j);
    const soft = !ghost && softMask !== 0 && (isGhost(softMask, i) || isGhost(softMask, j));
    const hLo = many ? (hulls as readonly CollisionHull[])[lo] : (hulls as CollisionHull);
    const hHi = many ? (hulls as readonly CollisionHull[])[hi] : (hulls as CollisionHull);
    const pushed = boatPairContact(mem.poseA, hLo, mem.poseB, hHi, dt, mem, soft ? softParams(mem, prm) : prm);
    const c = mem.pair;
    if (c.hit && c.depth0 < 0) rep.overlapsBoat = true;
    if (ghost || !pushed) continue;
    const sign = i === hi ? 1 : -1;
    const arms = i === hi ? c.armsB : c.armsA;
    const body = i === hi ? hHi : hLo;
    if (soft) {
      // horizontal, through the CG, bounded again after dropping the vertical part (it only ever shrinks)
      let jx = 0;
      let jz = 0;
      for (let k = 0; k < c.count; k++) {
        jx += sign * c.impulses[k * 3];
        jz += sign * c.impulses[k * 3 + 2];
      }
      const dv = Math.hypot(jx, jz) / body.mass;
      if (dv === 0) continue;
      self.velocity[0] += jx / body.mass;
      self.velocity[2] += jz / body.mass;
      applied++;
      rep.count++;
      rep.impulse[0] += jx;
      rep.impulse[2] += jz;
      if (dv > rep.maxDeltaV) {
        rep.maxDeltaV = dv;
        rep.source = CONTACT_BOAT;
        rep.approachSpeed = c.approachSpeed;
        rep.other = j;
        rep.bodyPoint.fill(0);
      }
      continue;
    }
    for (let k = 0; k < c.count; k++) {
      const o = k * 3;
      applyRigid6Impulse(self, body, arms[o], arms[o + 1], arms[o + 2], sign * c.impulses[o], sign * c.impulses[o + 1], sign * c.impulses[o + 2]);
    }
    const arm = i === hi ? c.armB : c.armA;
    const jx = sign * c.impulse[0];
    const jy = sign * c.impulse[1];
    const jz = sign * c.impulse[2];
    applied++;
    rep.count++;
    rep.impulse[0] += jx;
    rep.impulse[1] += jy;
    rep.impulse[2] += jz;
    const dv = i === hi ? c.deltaVB : c.deltaVA;
    if (dv > rep.maxDeltaV) {
      rep.maxDeltaV = dv;
      rep.source = CONTACT_BOAT;
      rep.approachSpeed = c.approachSpeed;
      rep.other = j;
      rotInv(self.quaternion, arm[0], arm[1], arm[2], rep.bodyPoint, 0);
    }
  }
  return applied;
}

// ── boat ↔ world ─────────────────────────────────────────────────────────────────────────────

function noteWorld(rep: BoatContactReport, dv: number, source: number, approach: number, other: number, q: ArrayLike<number>, ax: number, ay: number, az: number): void {
  rep.count++;
  if (dv > rep.maxDeltaV || (rep.source === CONTACT_NONE && source !== CONTACT_NONE)) {
    rep.maxDeltaV = Math.max(rep.maxDeltaV, dv);
    rep.source = source;
    rep.approachSpeed = approach;
    rep.other = other;
    rotInv(q, ax, ay, az, rep.bodyPoint, 0);
  }
}

/**
 * Boat against the static colliders and the bed. Mutates `state` velocities (through applyRigid6Impulse) and adds
 * to `mem.report`. `world` / `bed` may be null. Deterministic in collider index order.
 */
export function collideBoatWithWorld(
  state: Rigid6State,
  hull: CollisionHull,
  world: StaticWorld | null,
  bed: BedHeight | null,
  dt: number,
  mem: BoatCollideMemory,
  prm: Readonly<BoatCollideParams> = BOAT_COLLIDE_DEFAULTS,
): void {
  const rep = mem.report;
  const v = state.velocity;
  const w = state.angularVelocity;
  const q = state.quaternion;
  const p = state.position;
  const v0x = v[0];
  const v0y = v[1];
  const v0z = v[2];
  const w0x = w[0];
  const w0y = w[1];
  const w0z = w[2];
  const S = mem.tmp;

  // ---- static colliders
  if (world && world.count > 0) {
    const D = world.data;
    const Bd = world.bounds;
    for (let k = 0; k < mem.flexSeen.length; k++) mem.flexSeen[k] = 0;
    const wl = Math.hypot(w[0], w[1], w[2]);
    // broadphase: the grid cells under the hull's reach this tick, candidates de-duplicated and in index order
    const G = world.grid;
    const qr = hull.boundRadius + (Math.hypot(v[0], v[1], v[2]) + wl * hull.boundRadius) * dt + prm.touchSlop;
    const gx0 = Math.floor((p[0] - qr - G.x0) / G.cell);
    const gx1 = Math.floor((p[0] + qr - G.x0) / G.cell);
    const gz0 = Math.floor((p[2] - qr - G.z0) / G.cell);
    const gz1 = Math.floor((p[2] + qr - G.z0) / G.cell);
    let nCand = 0;
    if (gx1 >= 0 && gz1 >= 0 && gx0 < G.nx && gz0 < G.nz) {
      for (let gz = Math.max(0, gz0); gz <= Math.min(G.nz - 1, gz1); gz++) {
        for (let gx = Math.max(0, gx0); gx <= Math.min(G.nx - 1, gx1); gx++) {
          const k = gz * G.nx + gx;
          for (let e = G.cellStart[k]; e < G.cellStart[k + 1]; e++) {
            const c = G.cellItems[e];
            let dup = false;
            for (let q2 = 0; q2 < nCand; q2++) {
              if (mem.cand[q2] === c) {
                dup = true;
                break;
              }
            }
            if (dup) continue;
            if (nCand === mem.cand.length) {
              const grown = new Int32Array(Math.min(Math.max(64, world.count), mem.cand.length * 2));
              grown.set(mem.cand);
              mem.cand = grown;
            }
            // insertion keeps index order: the contacts resolve in the same order as the full scan
            let at = nCand++;
            while (at > 0 && mem.cand[at - 1] > c) {
              mem.cand[at] = mem.cand[at - 1];
              at--;
            }
            mem.cand[at] = c;
          }
        }
      }
    }
    // the chain is repacked only after something changed this boat's velocities (a pack per candidate was most of the cost)
    let packed = false;
    for (let ci = 0; ci < nCand; ci++) {
      const c = mem.cand[ci];
      const bx = Bd[c * 4] - p[0];
      const by = Bd[c * 4 + 1] - p[1];
      const bz = Bd[c * 4 + 2] - p[2];
      const reach = Bd[c * 4 + 3] + hull.boundRadius + (Math.hypot(v[0], v[1], v[2]) + wl * hull.boundRadius) * dt + prm.touchSlop;
      if (bx * bx + by * by + bz * bz > reach * reach) continue;
      const o = c * 9;
      const cb = mem.chainB;
      cb[0] = D[o];
      cb[1] = D[o + 1];
      cb[2] = D[o + 2];
      cb[3] = D[o + 3];
      cb[4] = D[o + 4];
      cb[5] = D[o + 5];
      for (let k = 6; k < 12; k++) cb[k] = 0;
      cb[12] = D[o + 6];
      if (!packed) {
        packChain(state, hull, mem.chainA);
        packed = true;
      }
      const hit = mem.hit;
      if (sweepChains(mem.chainA, hull.capsuleCount, cb, 1, dt, prm.touchSlop, S, hit) < 0) continue;
      const id = D[o + 8];
      if (D[o + 7] === 1) {
        // flexible: one speed loss per contact episode
        let slot = -1;
        for (let k = 0; k < mem.flexTouching.length; k++) if (mem.flexTouching[k] === id) slot = k;
        if (slot < 0) {
          for (let k = 0; k < mem.flexTouching.length; k++) {
            if (mem.flexTouching[k] < 0) {
              slot = k;
              break;
            }
          }
          if (slot >= 0) mem.flexTouching[slot] = id;
          const keep = 1 - prm.flexibleSpeedLoss;
          v[0] *= keep;
          v[1] *= keep;
          v[2] *= keep;
          packed = false;
          rep.flexibleHits++;
          noteWorld(rep, prm.flexibleSpeedLoss * Math.hypot(v[0], v[1], v[2]) / keep, CONTACT_FLEXIBLE, 0, id, q, 0, 0, 0);
        }
        if (slot >= 0) mem.flexSeen[slot] = 1;
        continue;
      }
      const pc = mem.sub;
      resolveSwept(state, hull, null, null, mem.chainA, cb, dt, prm.restitutionWorld, prm.frictionWorld, prm, hit, S, pc);
      // the impulse on B (the pole) is +J; the boat (A) receives −J
      const jx = -pc.impulse[0];
      const jy = -pc.impulse[1];
      const jz = -pc.impulse[2];
      if (jx === 0 && jy === 0 && jz === 0) continue;
      applyRigid6Impulse(state, hull, pc.armA[0], pc.armA[1], pc.armA[2], jx, jy, jz);
      packed = false;
      rep.impulse[0] += jx;
      rep.impulse[1] += jy;
      rep.impulse[2] += jz;
      noteWorld(rep, pc.deltaVA, CONTACT_SOLID, pc.approachSpeed, id, q, pc.armA[0], pc.armA[1], pc.armA[2]);
    }
    // episodes end when the pole is no longer touched
    for (let k = 0; k < mem.flexTouching.length; k++) if (mem.flexTouching[k] >= 0 && !mem.flexSeen[k]) mem.flexTouching[k] = -1;
  }

  // ---- bed
  if (bed) bedSolve(state, hull, bed, dt, mem, prm);

  // ---- V110 on the whole world response of this tick
  const dvx = v[0] - v0x;
  const dvy = v[1] - v0y;
  const dvz = v[2] - v0z;
  const dwx = w[0] - w0x;
  const dwy = w[1] - w0y;
  const dwz = w[2] - w0z;
  const dv = Math.hypot(dvx, dvy, dvz);
  const dw = Math.hypot(dwx, dwy, dwz);
  let sc = 1;
  if (dv > prm.maxImpactAccel * dt) sc = Math.min(sc, (prm.maxImpactAccel * dt) / dv);
  if (dw > prm.maxImpactAngularAccel * dt) sc = Math.min(sc, (prm.maxImpactAngularAccel * dt) / dw);
  if (sc < 1) {
    v[0] = v0x + sc * dvx;
    v[1] = v0y + sc * dvy;
    v[2] = v0z + sc * dvz;
    w[0] = w0x + sc * dwx;
    w[1] = w0y + sc * dwy;
    w[2] = w0z + sc * dwz;
    rep.worldCapScale = sc;
    if (rep.source !== CONTACT_BOAT) rep.maxDeltaV *= sc;
  }
}

const BED_STRIDE = 14;

function bedSolve(state: Rigid6State, hull: CollisionHull, bed: BedHeight, dt: number, mem: BoatCollideMemory, prm: Readonly<BoatCollideParams>): void {
  const p = state.position;
  const q = state.quaternion;
  const v = state.velocity;
  const w = state.angularVelocity;
  const S = mem.tmp;
  const rep = mem.report;
  // coarse skip: the bed under the hull axis at the tick's start and end, against the lowest the hull can reach
  rot(q, 0, 0, 1, S, 16);
  const fx = S[16];
  const fz = S[18];
  const lowest = p[1] - hull.pointReach - Math.hypot(v[0], v[1], v[2]) * dt;
  let near = false;
  for (let e = 0; e < 2 && !near; e++) {
    const tt = e * dt;
    for (let k = 0; k < 3; k++) {
      const zz = hull.zMin + 0.5 * k * (hull.zMax - hull.zMin);
      if (bed(p[0] + v[0] * tt + fx * zz, p[2] + v[2] * tt + fz * zz) > lowest - prm.bedSkipMargin) {
        near = true;
        break;
      }
    }
  }
  if (!near) return;

  const Pt = hull.points;
  const C = mem.bed;
  const samples = Math.max(1, Math.floor(prm.bedSweepSamples));
  const eps = prm.bedNormalStep;
  let nc = 0;
  for (let k = 0; k < hull.pointCount; k++) {
    rot(q, Pt[k * 3], Pt[k * 3 + 1], Pt[k * 3 + 2], S, 0);
    const ex = S[0];
    const ey = S[1];
    const ez = S[2];
    const p0x = p[0] + ex;
    const p0y = p[1] + ey;
    const p0z = p[2] + ez;
    const ux = v[0] + (w[1] * ez - w[2] * ey);
    const uy = v[1] + (w[2] * ex - w[0] * ez);
    const uz = v[2] + (w[0] * ey - w[1] * ex);
    for (let f = 0; f <= samples; f++) {
      const tt = (dt * f) / samples;
      const qx = p0x + ux * tt;
      const qy = p0y + uy * tt;
      const qz = p0z + uz * tt;
      const h = bed(qx, qz);
      const pen = h - qy;
      if (!(pen > 0)) continue;
      const hx = (bed(qx + eps, qz) - bed(qx - eps, qz)) / (2 * eps);
      const hz = (bed(qx, qz + eps) - bed(qx, qz - eps)) / (2 * eps);
      const nl = Math.sqrt(hx * hx + 1 + hz * hz);
      const nx = -hx / nl;
      const ny = 1 / nl;
      const nz = -hz / nl;
      const dN = -pen * ny; // signed distance along the normal (negative inside)
      const gap = f === 0 ? dN : Math.max(0, nx * (p0x - qx) + ny * (p0y - qy) + nz * (p0z - qz) + dN);
      const o = nc * BED_STRIDE;
      C[o] = ex;
      C[o + 1] = ey;
      C[o + 2] = ez;
      C[o + 3] = nx;
      C[o + 4] = ny;
      C[o + 5] = nz;
      C[o + 6] = gap;
      C[o + 7] = f === 0 || gap <= prm.touchSlop ? 1 : 0;
      C[o + 8] = nx * ux + ny * uy + nz * uz;
      C[o + 9] = 0;
      C[o + 10] = 0;
      C[o + 11] = 1 / (1 / hull.mass + angularK(q, hull.inertia, ex, ey, ez, nx, ny, nz, S));
      nc++;
      break;
    }
  }
  if (nc === 0) return;
  const bv0x = v[0];
  const bv0y = v[1];
  const bv0z = v[2];
  const e = prm.restitutionWorld;
  const mu = prm.frictionWorld;
  for (let it = 0; it < prm.bedIterations; it++) {
    for (let c = 0; c < nc; c++) {
      const o = c * BED_STRIDE;
      const ex = C[o];
      const ey = C[o + 1];
      const ez = C[o + 2];
      const nx = C[o + 3];
      const ny = C[o + 4];
      const nz = C[o + 5];
      const gap = C[o + 6];
      let px = v[0] + (w[1] * ez - w[2] * ey);
      let py = v[1] + (w[2] * ex - w[0] * ez);
      let pz = v[2] + (w[0] * ey - w[1] * ex);
      const vn = px * nx + py * ny + pz * nz;
      let target: number;
      if (C[o + 7] === 1) {
        const vn0 = C[o + 8];
        target = vn0 < 0 ? -e * vn0 : 0;
        const bias = Math.min((prm.baumgarte * Math.max(0, -gap - prm.penetrationSlop)) / dt, prm.maxBiasSpeed);
        if (bias > target) target = bias;
      } else {
        target = -gap / dt;
      }
      const acc = C[o + 9];
      let lam = (target - vn) * C[o + 11];
      const nacc = Math.max(0, acc + lam);
      lam = nacc - acc;
      C[o + 9] = nacc;
      if (lam !== 0) applyRigid6Impulse(state, hull, ex, ey, ez, lam * nx, lam * ny, lam * nz);
      if (mu > 0 && nacc > 0) {
        px = v[0] + (w[1] * ez - w[2] * ey);
        py = v[1] + (w[2] * ex - w[0] * ez);
        pz = v[2] + (w[0] * ey - w[1] * ex);
        const vn2 = px * nx + py * ny + pz * nz;
        const tx = px - vn2 * nx;
        const ty = py - vn2 * ny;
        const tz = pz - vn2 * nz;
        const vt = Math.hypot(tx, ty, tz);
        const budget = mu * nacc - C[o + 10];
        if (vt > 1e-6 && budget > 0) {
          const ux = tx / vt;
          const uy = ty / vt;
          const uz = tz / vt;
          const Kt = 1 / hull.mass + angularK(q, hull.inertia, ex, ey, ez, ux, uy, uz, S);
          const jt = Math.min(vt / Kt, budget);
          C[o + 10] += jt;
          applyRigid6Impulse(state, hull, ex, ey, ez, -jt * ux, -jt * uy, -jt * uz);
        }
      }
    }
  }
  // report: ONE bed contact whose |Δv| is the CG's over the whole solve (§T.198: the crash module's impact is "one
  // collision |Δv| ≥ 8 m/s"; the largest single point's share of a shore hit spread over a dozen hull points read
  // 7.7 m/s for a 20 m/s beaching in the live page), at the arm of the largest point impulse
  let big = -1;
  let bigJ = 0;
  let approach = 0;
  for (let c = 0; c < nc; c++) {
    const o = c * BED_STRIDE;
    const jn = C[o + 9];
    if (jn <= 0) continue;
    rep.impulse[0] += jn * C[o + 3];
    rep.impulse[1] += jn * C[o + 4];
    rep.impulse[2] += jn * C[o + 5];
    approach = Math.max(approach, -C[o + 8]);
    const jm = Math.hypot(jn, C[o + 10]);
    if (jm > bigJ) {
      bigJ = jm;
      big = o;
    }
  }
  if (big < 0) return;
  const dv = Math.hypot(v[0] - bv0x, v[1] - bv0y, v[2] - bv0z);
  noteWorld(rep, dv, CONTACT_BED, approach, -1, q, C[big], C[big + 1], C[big + 2]);
}
