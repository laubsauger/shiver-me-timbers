/**
 * OPEN-SEA course stub (§T.181 S0) behind the `CourseHook` seam: no islands, no course, a
 * two-column grid. §T.187 replaces it with a course + race archipelago from `src/circuit`
 * (the sites go to `buildSea`, the course's `paceLine`/grid to `spawn`).
 *
 * ARCHIPELAGO CAVEAT for T187 (docs/speedboat/sim-worker.md blockers 1–2): the NPC workers
 * float on OPEN-OCEAN depth and have no fetch/swell-shadow grids. With `sites` non-empty the
 * page mirror (player) and the worker mirrors (rivals) stop being the same sea (§V110) until
 * the seabed and fetch exports land.
 */
import { buildTowerReach, CORRIDOR_HALF_WIDTH, towerReachSites, type TowerReachWorld } from '../../circuit';
import { courseColliders } from '../../circuit/courseColliders';
import { islandPropColliders, type PropNode } from '../../circuit/propColliders';
import { quatFromAxisAngle } from '../../core/quat';
import { restCgHeight } from '../crash/teleport';
import { buildDeepVHull } from '../hullMesh';
import type { IslandHeightmap } from '../../island/heightmap';
import type { RockPlacement } from '../../island/rocks';
import type { SeabedField } from '../../island/seabed';
import { oceanParams } from '../../params/ocean';
import { raceParams } from '../../race/params';
import { gridDepth } from '../../race/rollingStart';
import type { Course } from '../../race/types';
import type { StaticCollider } from '../../sea-physics/boatCollide';
import { bakeSimWorldData, gridSeabed, raceBed, type SimWorldData } from '../../sim-worker/worldData';
import type { Rigid6State } from '../../sea-physics/rigidBody';
import type { CourseHook } from './seams';

/**
 * CG height of a spawn above the still-water plane, m. §T.198: DERIVED, not a constant — the level deep-V's hydrostatic
 * equilibrium of the contact itself (`crash/teleport restCgHeight`, bisection on the same mesh the forces use; ≈ 0.26 m
 * after §T.196's physics, 0.239 before). A spawn is placed LEVEL, so the level rest is the height it floats at without a
 * drop or a pop; she then trims a few cm lower on her own (the settled trimmed rest). One solve at module load (~0.2 s).
 */
export const SPAWN_CG_Y = restCgHeight(buildDeepVHull());
/** grid geometry: columns ±COLUMN_X, rows ROW_Z apart, NPCs AHEAD of the player (slot 0) */
export const GRID_COLUMN_X = 10;
export const GRID_ROW_Z = 25;

/** slot → x/z on a grid heading `heading` rad (0 = world +z) about `origin` */
export function gridSlot(slot: number, origin: readonly [number, number] = [0, 0], heading = 0): Rigid6State {
  const lx = slot === 0 ? 0 : slot % 2 === 1 ? GRID_COLUMN_X : -GRID_COLUMN_X;
  const lz = Math.ceil(slot / 2) * GRID_ROW_Z;
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  return {
    position: [origin[0] + lx * c + lz * s, SPAWN_CG_Y, origin[1] - lx * s + lz * c],
    quaternion: quatFromAxisAngle([0, 1, 0], heading),
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
  };
}

export function openSeaCourse(): CourseHook {
  return { sites: [], course: null, spawn: (slot) => gridSlot(slot) };
}

// ── §T.191: Tower Reach, the two-phase course hook ───────────────────────────────────────────────

/** the seed Tower Reach's measured numbers are quoted at (docs/speedboat/circuit.md: lap 4140.5 m, sectors, bar crest) */
export const TOWER_REACH_SEED = 1965;
/**
 * The course's own sea (user playtest 2026-09-13: "start on calm sea or whatever is dictated by map and luv/lee
 * design"). Tower Reach's start straight sits in the lee of Tower Cay; the first-playable slice opens on Calm and
 * the boat-select sea choice (Working sea is one option) is applied on top of it.
 */
export const TOWER_REACH_SEA = 'calm';

/** the parts of the built sea phase two reads (structural: `buildSea`'s return satisfies it) */
/** an island as rock colliders need it (structural: `island/island.ts` Island satisfies it) */
export interface RockIsland {
  center: readonly [number, number];
  rocks: { placements: readonly RockPlacement[] };
}

/** a rock this far below the still water cannot touch a hull (draft 0.6 m + a trough and a landing plunge), m */
export const ROCK_REACH_BELOW = -2;
/** ...and one whose base is this high up the beach is on land (the bed field already stops a boat there), m */
export const ROCK_REACH_ABOVE = 3;

/**
 * ROCKS ARE SOLID (§T.191, user playtest 2026-09-13: "missing collision between boats and the terrain"; the player
 * spawned inside a rock). The island rock scatter (`island/rocks.ts`: headland masses, shore boulders, talus) is a
 * render prop the physics bed never saw — the 3 m seabed grid smooths a boulder away, and a rock mass standing out of
 * the water is not in the heightmap at all. Every rock a hull can reach becomes a vertical capsule over its placement:
 * radius = scale × max(aspect, 1) (the long axis of its footprint, conservative), half-height = scale × squash.
 * The SAME list goes to the player's collide and to the workers (`contacts.colliders`), and to grid/respawn clearance.
 *
 * EXCEPT inside the course corridor (`corridor`): the circuit contracts open water there (tests/circuit.test.ts:
 * ≥ 6.2 m, ±14 m), and a scatter rock that intrudes breaks that contract — on Tower Reach 11 rocks sit on the lap's
 * line at Main Street and Bar Head, most of them hovering at the waterline over 7–14 m of water (a kit-island rock
 * placement fault, reported to the island/circuit owners). Making those solid would put the racing line through
 * rocks; they are returned as `inCorridor` for a loud warning and left out of the physics until the scatter respects
 * the corridor.
 *
 * §T.198: the page now fits colliders to the RENDERED props of every island that has a scene group
 * (circuit/propColliders, rocks included); this placement-based list is the fallback for a headless course only.
 */
export interface RockCorridor {
  /** the closed reference line */
  line: readonly (readonly [number, number])[];
  /** metres either side the circuit keeps as open water (circuit CORRIDOR_HALF_WIDTH) */
  halfWidth: number;
}

export function rockColliders(islands: readonly RockIsland[], corridor?: RockCorridor): { colliders: StaticCollider[]; inCorridor: StaticCollider[] } {
  const colliders: StaticCollider[] = [];
  const inCorridor: StaticCollider[] = [];
  for (const isl of islands) {
    for (const r of isl.rocks.placements) {
      const radius = r.scale * Math.max(r.aspect, 1);
      const half = r.scale * r.squash;
      const top = r.position[1] + half;
      const base = r.position[1] - half;
      if (top < ROCK_REACH_BELOW || base > ROCK_REACH_ABOVE || !(radius > 0.05)) continue;
      const x = isl.center[0] + r.position[0];
      const z = isl.center[1] + r.position[2];
      const c: StaticCollider = { a: [x, base, z], b: [x, Math.max(top, base + 1e-3), z], radius };
      if (corridor && distanceToClosedLine(corridor.line, x, z) < corridor.halfWidth + radius) inCorridor.push(c);
      else colliders.push(c);
    }
  }
  return { colliders, inCorridor };
}

function distanceToClosedLine(line: readonly (readonly [number, number])[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < line.length; i++) {
    const a = line[i];
    const b = line[(i + 1) % line.length];
    const ax = b[0] - a[0];
    const az = b[1] - a[1];
    const l2 = ax * ax + az * az;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * ax + (z - a[1]) * az) / l2)) : 0;
    const d = Math.hypot(x - a[0] - ax * t, z - a[1] - az * t);
    if (d < best) best = d;
  }
  return best;
}

/**
 * CLEARANCE for spawns and respawns (§T.191): open water under the hull (bed below `minDepth`) and no solid collider
 * within `margin` of the point (flexible gate poles excepted: a boat is meant to pass between them). Pure; tested
 * over every grid slot, the pace line and the respawn candidates in tests/speedboatCourseClearance.test.ts.
 */
export function clearanceAt(
  colliders: readonly StaticCollider[],
  bed: (x: number, z: number) => number,
  x: number,
  z: number,
  margin: number,
  minDepth = 2,
): { clear: boolean; bed: number; nearest: number; nearestIndex: number } {
  const b = bed(x, z);
  let nearest = Infinity;
  let nearestIndex = -1;
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    if (c.flexible) continue;
    // horizontal distance to the capsule axis segment (the boat is at the waterline, the axis spans it or is near)
    const ax = c.b[0] - c.a[0];
    const az = c.b[2] - c.a[2];
    const l2 = ax * ax + az * az;
    const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((x - c.a[0]) * ax + (z - c.a[2]) * az) / l2)) : 0;
    const d = Math.hypot(x - (c.a[0] + ax * t), z - (c.a[2] + az * t)) - c.radius;
    if (d < nearest) {
      nearest = d;
      nearestIndex = i;
    }
  }
  return { clear: b <= -minDepth && nearest >= margin, bed: b, nearest, nearestIndex };
}

/** a respawn point: 3 m of water and 10 m from any rock or structure (race/respawn.ts `IsClear`) */
export const RESPAWN_MARGIN = 10;
export function respawnClear(colliders: readonly StaticCollider[], bed: (x: number, z: number) => number): (x: number, z: number) => boolean {
  return (x, z) => clearanceAt(colliders, bed, x, z, RESPAWN_MARGIN, 3).clear;
}

export interface CourseSea {
  /** `group`: the island's rendered scene group — its solid props' colliders are fitted to the drawn instances (§T.198) */
  archipelago: { islands: readonly (RockIsland & { heightmap: IslandHeightmap; group?: PropNode })[]; seabed: SeabedField };
  cpuOcean: { setSeabed(seabed: { heightAt(x: number, z: number): number } | null, openDepth: number): void };
}

/**
 * THE PILOTS' HANDEDNESS ADAPTER (§T.191 → §T.197). src/race and src/circuit now share ONE handedness (race/types.ts:
 * physical, y up, facing +z port = +x; `left` = port pole, `keepOn` = the boat's side), so Race and the HUD read the
 * authored course. `src/race/ai` still reads mark sides in the mirrored sense — race/ai/line.ts `corridorsOf`
 * (L95–L96 hairpin apex turned "toward the mark", L101–L110 "starboard of the apex" = (bz, −bx), the near/far pole
 * order) — and its tests encode that sense (tests/raceAiLine.test.ts L72, tests/raceAiHarness.ts L63/L130). Until the
 * race/ai owner moves it to types.ts handedness, the PILOTS alone get the course with each gate's poles swapped and
 * each mark's `keepOn` flipped: exactly the course §T.191 handed them. Element order, ids, lines and bounds unchanged.
 */
export function aiHandedCourse(c: Course): Course {
  return {
    ...c,
    elements: c.elements.map((e) =>
      e.kind === 'gate'
        ? { kind: 'gate', gate: { ...e.gate, left: e.gate.right, right: e.gate.left } }
        : { kind: 'mark', mark: { ...e.mark, keepOn: e.mark.keepOn === 'port' ? 'starboard' : 'port' } },
    ),
  };
}

/** racers on the grid (7 rivals + the player) */
export const GRID_RACERS = 8;
/** metres of clear straight left behind the last grid row at t = 0 (a 12 m hull's stern + clearance sampling slack) */
export const GRID_TAIL = 40;
/**
 * metres of pace line the grid occupies at t = 0: race/rollingStart `gridDepth` (the pace boat starts that far along the
 * line so the last row sits on its start, §T.197) + GRID_TAIL
 */
export const GRID_ROOM = gridDepth(raceParams.start, GRID_RACERS) + GRID_TAIL;

/** the pace line's longest wanted straight: grid room + the pace boat's run to its pull-off (≈ the lap's last 700 m) */
export const PACE_STRAIGHT_MAX = GRID_ROOM + 700;
/** below this the rolling start is a formality: grid room + pull-off (150 m) + 100 m of pacing */
export const PACE_STRAIGHT_MIN = GRID_ROOM + 250;
/** grid slot half-spread across the pace line (race/params start.columnSpacing 14 m) */
const GRID_HALF_SPREAD = 7;

/**
 * A CLEAR ROLLING START (§T.191, user playtest 2026-09-13: "the player spawned inside a rock"). Tower Reach's authored
 * pace line was the lap's last 700 m — through the lee chicane and past Main Street's roofs — and a two-column grid of
 * 12 m hulls cannot roll through that (§T.202: it is now an 880 m straight run-in through open water, circuit.md §T202,
 * and this check trims it to what the page's colliders leave clear). The race is handed a STRAIGHT pace line, ending
 * on the start gate midpoint along the course direction there, as long as it stays open water: every 8 m, at the
 * line and ±GRID_HALF_SPREAD across it, `clearanceAt(margin, 2 m of water)`. It runs back to the first blocked sample
 * (at most PACE_STRAIGHT_MAX), less GRID_TAIL; race/rollingStart puts the last grid row on the line's start and the pace
 * boat `gridDepth` along it, so the whole grid is on the line and rolls in the clear. Shorter than PACE_STRAIGHT_MIN
 * fails loud and falls back to the authored pace line.
 */
export function clearPaceLine(c: Course, colliders: readonly StaticCollider[], bed: (x: number, z: number) => number, margin = 8): Course['paceLine'] {
  const first = c.elements[0];
  if (first.kind !== 'gate') return c.paceLine;
  const mx = (first.gate.left[0] + first.gate.right[0]) / 2;
  const mz = (first.gate.left[1] + first.gate.right[1]) / 2;
  const ref = c.referenceLine;
  const k = Math.min(3, ref.length - 1);
  let tx = ref[k][0] - ref[0][0];
  let tz = ref[k][1] - ref[0][1];
  const l = Math.hypot(tx, tz);
  tx /= l;
  tz /= l;
  let run = 0;
  for (let d = 8; d <= PACE_STRAIGHT_MAX; d += 8) {
    let ok = true;
    for (const lat of [-GRID_HALF_SPREAD, 0, GRID_HALF_SPREAD]) {
      const x = mx - tx * d + tz * lat;
      const z = mz - tz * d - tx * lat;
      if (!clearanceAt(colliders, bed, x, z, margin, 2).clear) ok = false;
    }
    if (!ok) break;
    run = d;
  }
  if (run < PACE_STRAIGHT_MIN) {
    console.error(`[speedboat] course: only ${run} m of clear straight behind the start gate (need ${PACE_STRAIGHT_MIN}); using the authored pace line`);
    return c.paceLine;
  }
  // the grid is ON the line (race/rollingStart, §T.197): the line starts GRID_TAIL ahead of the last clear sample
  const out: (readonly [number, number])[] = [];
  for (let d = run - GRID_TAIL; d > 0; d -= 8) out.push([mx - tx * d, mz - tz * d]);
  out.push([mx, mz]);
  return out;
}

export interface CourseWorld {
  world: TowerReachWorld;
  /** the authored course with the race's laps and clear pace line: Race and the HUD read it (`world.course` = authored) */
  course: Course;
  /** the same course in the rival pilots' mirrored handedness (`aiHandedCourse`; race/ai owner item) — buildPilotSetup only */
  aiCourse: Course;
  /** the data the NPC workers float on and collide with (§V110) */
  simWorld: SimWorldData;
  colliders: StaticCollider[];
  /** the physics bed: sandbars pass through (circuit/raceSeabed), the SAME function the workers use */
  bed(x: number, z: number): number;
}

export interface TowerReachHook extends CourseHook {
  readonly seaPreset: string;
  readonly world: CourseWorld | null;
  attach(sea: CourseSea): CourseWorld;
}

/**
 * PHASE ONE (before `buildSea`): the kit sites. PHASE TWO (`attach`, after `buildSea`): the Tower Reach world from
 * the archipelago's own heightmaps and seabed, the worker world data, the colliders and the physics bed.
 *
 * §V110 + §V8, one seabed for every racer: the page mirror is re-pointed at the SAME texel-centre grid the workers
 * rebuild (`gridSeabed`), so the player's shoaling and every rival's are one function of one array. The grid is
 * baked from the seabed the ocean material's texture is baked from, at full float precision.
 */
export function towerReachCourse(seed = TOWER_REACH_SEED, sea = oceanParams): TowerReachHook {
  const layout = towerReachSites(seed);
  let built: CourseWorld | null = null;
  return {
    sites: layout.sites,
    seaPreset: TOWER_REACH_SEA,
    get course() {
      return built ? built.course : null;
    },
    get world() {
      return built;
    },
    spawn: (slot) => gridSlot(slot),
    attach(s) {
      if (built) return built;
      const world = buildTowerReach(seed, { heightmaps: s.archipelago.islands.map((i) => i.heightmap), seabed: s.archipelago.seabed });
      const simWorld = bakeSimWorldData(s.archipelago.seabed, sea, world.bars);
      s.cpuOcean.setSeabed(gridSeabed(simWorld), -simWorld.seabed.openHeight);
      const bed = raceBed(simWorld);
      const bedAt = (x: number, z: number): number => bed.heightAt(x, z);
      // §T.198 SOLID PROPS: every island's rendered solid instances (kit granite blocks, beachrock slabs, rubble,
      // driftwood, rock scatter) get colliders fitted to what the GPU draws (circuit/propColliders, §V77). Tower Reach's
      // kit islands have rockCount 0, so the placement-based `rockColliders` found nothing there and the live page had
      // no rock colliders at all. An island without a scene group (a headless course) falls back to its rock placements.
      const withGroup = s.archipelago.islands.filter((i) => i.group);
      const headless = s.archipelago.islands.filter((i) => !i.group);
      const props = islandPropColliders(withGroup.map((i) => i.group as PropNode), bedAt);
      if (props.unclassified.length > 0) {
        console.error(`[speedboat] course: island meshes neither solid nor soft — classify them in circuit/propColliders (SOLID_PROP_MESHES / SOFT_PROP_MESHES):`, [...new Set(props.unclassified)]);
      }
      const corridor = { line: world.course.referenceLine, halfWidth: CORRIDOR_HALF_WIDTH };
      const propsInCorridor = props.colliders.filter((c) => distanceToClosedLine(corridor.line, (c.a[0] + c.b[0]) / 2, (c.a[2] + c.b[2]) / 2) < corridor.halfWidth + c.radius);
      if (propsInCorridor.length > 0) {
        console.warn(`[speedboat] course: ${propsInCorridor.length} solid island props intrude the ±${corridor.halfWidth} m course corridor (they ARE solid; island kit owner)`, propsInCorridor.slice(0, 20).map((c) => [Math.round(c.a[0]), Math.round(c.a[2]), +c.radius.toFixed(1)]));
      }
      const rocks = rockColliders(headless, corridor);
      if (rocks.inCorridor.length > 0) {
        console.warn(`[speedboat] course: ${rocks.inCorridor.length} island scatter rocks intrude the course corridor and are NOT solid (render/physics disagree there; island kit owner)`, rocks.inCorridor.map((c) => [Math.round(c.a[0]), Math.round(c.a[2]), +c.radius.toFixed(1)]));
      }
      const colliders = [...courseColliders(world), ...rocks.colliders, ...props.colliders];
      const course: Course = { ...world.course, paceLine: clearPaceLine(world.course, colliders, bedAt) };
      built = { world, course, aiCourse: aiHandedCourse(course), simWorld, colliders, bed: bedAt };
      return built;
    },
  };
}
