/**
 * THE SHOWCASE LAGOON — one deliberately hand-placed island (§T.52).
 *
 * WHY THIS EXISTS AT ALL. Several systems have never been observable because
 * there was nowhere to observe them: `terrain/shoreRunup.ts` (swash, foam
 * line, wet-sand memory), the §V24 shallows tint, §V34 caustics on a seabed,
 * the ship's shadow on a sea floor, and the whole sand / wet-sand / waterline
 * family. All of them need the same thing — shallow clear water over sand,
 * close enough to look at. The scatter cannot supply it: `generateIslandSites`
 * places into a 700-3600 m annulus with a 450 m spawn clearance, and the
 * nearest island in the shipped world (seed 1337) is 1170 m away with a bay
 * whose floor is wherever the noise happened to leave it.
 *
 * WHY IT IS HAND-PLACED AND NOT SEED-HUNTED. `lagoon` comes up on 23% of
 * seeds; hunting for a seed that happened to produce a good bay near spawn
 * would be a magic constant with no explanation attached, and it would break
 * the moment anyone changed the world seed. This is the opposite: a stated
 * exception with its reasons in the file, still a pure function of
 * (world seed, params) so §V2 holds and multiplayer clients rebuild it
 * identically. It takes ONE OF the scattered slots rather than adding a sixth
 * island, so island count, draw cost and the "every archetype distinct" §V43
 * contract are all unchanged.
 *
 * WHAT THE NUMBERS ARE FOR:
 *  - position: the ship spawns at the origin facing +z, so +x is off her
 *    starboard bow — "to the right" at boot. 912 m out with a 260 m footprint
 *    leaves 652 m of open water, comfortably past `spawnClearance` (450 m).
 *  - radius 260: the top of the scatter's own range. Big enough that the bay
 *    inside the arc of lobes is a place rather than a notch.
 *  - rimDepth / skirtDepth: raised from the world default 6 / 8 m. The terrain
 *    mesh is a SQUARE grid over [-R, R]² and there is no floor geometry at all
 *    outside it, while the seabed field keeps ramping to -45 m and the shallows
 *    tint keeps reading out to `shallowFullDepth` (18 m). That leaves bright
 *    shallow-looking water over nothing, ending on a straight edge — invisible
 *    at the 1.2 km the scatter puts islands at, and unavoidable at 900 m.
 *    Sinking this island's own rim puts its mesh edge below the readable band.
 *    (The general fix is another agent's; this is the local mitigation.)
 *  - lagoon*: see `params/island.ts` — the floor depth is set by the measured
 *    swell trough, not by taste.
 */
import { islandParams, type IslandParams } from '../params/island';
import type { ArchetypeName } from './archetypes';
import type { IslandHeightmap } from './heightmap';

/** decorrelates the showcase island's own generation stream from the scatter */
export const SHOWCASE_SEED_STRIDE = 104729;

/** bearings scanned when searching for a berth — resolution, not a look knob */
const BERTH_SCAN_ANGLES = 128;
/** radial steps per bearing in the same scan */
const BERTH_SCAN_STEPS = 80;

export interface ShowcaseIsland {
  /** centre on the world XZ plane */
  position: [number, number];
  /** footprint radius (m) */
  radius: number;
  /** forced silhouette family */
  archetype: ArchetypeName;
  /** applied on top of islandParams for this island only */
  overrides: Partial<IslandParams>;
}

export const SHOWCASE_LAGOON: ShowcaseIsland = {
  position: [900, 150],
  radius: 260,
  archetype: 'lagoon',
  overrides: {
    rimDepth: 12,
    skirtDepth: 16,
    // Pulls the rim envelope in from 0.84·R to 0.78·R, which moves the berth
    // from 7 m inside the footprint edge to 16 m. Directly a trade against the
    // shore break: it also costs 10% of the 0-3 m shelf (25.5k → 23.0k m²),
    // which is the band the swash actually happens in, so it is deliberately
    // a nudge and not the 0.66 that would buy 39 m.
    rimStart: 0.78,
    // ~4.5 m clears the measured -3.96 m swell trough with margin, so the
    // basin always holds water. The 0-3 m band lives OUTSIDE it, on the beach
    // shelf, where it dries and refloods every wave — that is the shore break.
    lagoonDepth: 4.5,
    // offset + radius were SWEPT, not chosen: over five world seeds, the
    // worst-case bay mouth goes 2° (basin at the island origin — a landlocked
    // crater) → 60° at offset 0.5 → 136° here, while the basin stays ~49k m².
    // Past 0.7 the bight opens further but the berth drifts out of it.
    lagoonOffset: 0.6,
    lagoonRadius: 0.36,
    lagoonFeather: 0.24,
    lagoonLandGuard: 6,
    lagoonFloorRelief: 0.05,
  },
};

/** resolved params for the showcase island (tests + the archipelago builder) */
export function showcaseParams(base: IslandParams = islandParams): IslandParams {
  return { ...base, radius: SHOWCASE_LAGOON.radius, ...SHOWCASE_LAGOON.overrides };
}

export interface Anchorage {
  /** island-LOCAL metres; add the island centre for world coords */
  x: number;
  z: number;
  /** yaw (radians) putting the island dead ahead — the shot faces the lagoon */
  heading: number;
  /** water depth (m) under the anchorage at still water */
  depth: number;
}

export interface AnchorageOptions {
  /**
   * Water she must have under her at still water (m).
   *
   * NOT a comfort figure. The galleon draws 2 m, the measured swell trough is
   * -3.96 m, and `stepShipGrounding` compares the KEEL against the seabed —
   * so anchoring in 5 m of water puts her keel 1.96 m INTO the bank every time
   * a trough passes, and she grounds and heels over while nominally afloat.
   * draft + trough + margin is the floor, not a preference.
   */
  minDepth: number;
  /**
   * Radius (m) of the disc around the berth that must ALSO stay clear.
   *
   * §V54's lesson applied to a placement instead of a force: a lumped model
   * must give its sample points the body's own extent. A galleon is 35 m long,
   * so a berth tested at a single point can drop her bow onto a bank that the
   * centre sample never saw — and she would arrive already aground, which
   * reads as the teleport being broken rather than as the berth being wrong.
   */
  clearRadius: number;
  /** depth (m) required across that whole disc — draft + trough + margin */
  clearDepth: number;
}

/**
 * Draft 2 m + the measured swell trough 3.96 m = 5.96 m before the keel
 * touches at all. `clearDepth` is that plus a little, held across her whole
 * footprint; `minDepth` adds a further metre under her middle. Bigger numbers
 * are not free — every metre pushes the berth further out toward the footprint
 * edge, where the drawn seabed stops.
 */
const DEFAULT_ANCHORAGE: AnchorageOptions = {
  minDepth: 7,
  clearRadius: 22,
  clearDepth: 6.2,
};

/** samples on the clearance ring — cheap, and a ring catches banks a point misses */
const CLEARANCE_SAMPLES = 16;

function clearanceOk(hm: IslandHeightmap, x: number, z: number, o: AnchorageOptions): boolean {
  for (let i = 0; i < CLEARANCE_SAMPLES; i++) {
    const a = (i / CLEARANCE_SAMPLES) * Math.PI * 2;
    const px = x + Math.cos(a) * o.clearRadius;
    const pz = z + Math.sin(a) * o.clearRadius;
    if (-hm.heightAt(px, pz) < o.clearDepth) return false;
  }
  return true;
}

/**
 * Where to park to look at the lagoon, DERIVED from the heightmap rather than
 * typed in — the bay moves with the archetype's own seeded spin, so a literal
 * coordinate would be right for exactly one seed (§V71: resolve against the
 * live surface, not against a rest pose that happened to match).
 *
 * ONE OBJECTIVE: the safe berth CLOSEST TO THE LAGOON'S OWN CENTRE, which the
 * heightmap publishes (`lagoonCenter`) rather than anyone re-deriving. She
 * cannot lie IN the basin — it is 4.5 m deep by design and she needs about
 * nine — so the objective puts her as deep into the approach as the water
 * allows, and facing back at the basin puts the lagoon, the shelf and the
 * beach behind it in one frame with nobody touching the camera.
 *
 * An earlier version scanned for the bay MOUTH (longest open run) and berthed
 * along that one bearing. It threw: on a shelving 260 m island the mouth
 * bearing has shallow patches, and no radius on it satisfied the clearance
 * disc. Searching every bearing and letting the objective choose is simpler
 * and strictly more likely to find a berth.
 *
 * Throws rather than returning a berth she would ground on (§Rule 8).
 */
export function findLagoonAnchorage(
  hm: IslandHeightmap,
  opts: AnchorageOptions = DEFAULT_ANCHORAGE,
): Anchorage {
  const R = hm.worldRadius;
  const [tx, tz] = hm.lagoonCenter ?? [0, 0];
  let best: Anchorage | undefined;
  let bestD = Infinity;

  for (let i = 0; i < BERTH_SCAN_ANGLES; i++) {
    const angle = (i / BERTH_SCAN_ANGLES) * Math.PI * 2;
    const cx = Math.cos(angle);
    const cz = Math.sin(angle);
    for (let k = 0; k <= BERTH_SCAN_STEPS; k++) {
      const r = (k / BERTH_SCAN_STEPS) * R;
      const x = cx * r;
      const z = cz * r;
      const d = Math.hypot(x - tx, z - tz);
      if (d >= bestD) continue;
      const depth = -hm.heightAt(x, z);
      if (depth < opts.minDepth) continue;
      if (!clearanceOk(hm, x, z, opts)) continue;
      bestD = d;
      best = {
        x,
        z,
        // face the lagoon: the follow camera sits astern of the bow
        heading: Math.atan2(tx - x, tz - z),
        depth,
      };
    }
  }

  if (best === undefined) {
    throw new Error(
      `findLagoonAnchorage: nowhere on a ${R} m island with ${opts.minDepth} m under her ` +
        `and ${opts.clearDepth} m across a ${opts.clearRadius} m disc — rimDepth must ` +
        `exceed minDepth, or she will ground on arrival`,
    );
  }
  return best;
}
