/**
 * TRAILER LOCATIONS on Tower Reach (seed 1965, the page's `TOWER_REACH_SEED`), scouted off the built world headless:
 * seabed depth, the reference sea's swell shadow K (circuit/shelter.ts, 0 = full lee, 1 = open swell) and the page's
 * own collider list (tests/speedboatCollisionWorld.ts — the drawn kit decor + course furniture). World metres, XZ.
 *
 * Orientation facts every pick leans on:
 *   · the SUN SETS toward world −x (sky/sunCycle.ts: evening sun is −sin H on x; latitude 15° keeps it within a few
 *     degrees of due west), so "into the sunset" is a heading of −x and "sunset behind her" is a lens east of her;
 *   · the swell travels along (0.54, −0.84) (towerReachLayout TOWER_REACH_SWELL_DIRECTION), so the lee is NE of each
 *     island and the open swell is W/SW of the group;
 *   · a heading is atan2(x, z) (0 = +z).
 *
 * Paths are polylines the scripted driver follows (drive.ts); each was checked for depth (≥ 3 m on its line) and for
 * collider clearance headless (scratch scout, see docs/cine/speedboat-trailer-v1.md §Locations).
 */
import type { Vec2 } from '../../race/types';

export type LocationId = 'bay' | 'openSwell' | 'rockyPoint' | 'towerTip' | 'knuckleGap' | 'horizon';

export interface Location {
  id: LocationId;
  label: string;
  /** a representative point (the camera works around it) */
  at: Vec2;
  /** the line she drives here (or, at rest, the two points that give her heading) */
  path: readonly Vec2[];
  /** measured: the SHALLOWEST water on `path` (m), and K at `at` */
  depthM: number;
  k: number;
  why: string;
}

export const LOCATIONS: Readonly<Record<LocationId, Location>> = {
  bay: {
    id: 'bay',
    label: 'Tower Cay lee bay',
    at: [140, -330],
    // parked pointing +x (east): the sunset sits astern of her, over the island, for the 05 reveal; the launch runs
    // east between the G8 poles (80 m south) and G7 (150 m north) into 20 m of open lee water
    path: [[140, -330], [760, -330]],
    depthM: 14.6,
    k: 0.0,
    why: 'Full swell shadow (K 0.0) ~90 m off the NE shore of Tower Cay: the glassiest water on the map, 10 m deep, the island silhouette and the sunset behind her.',
  },
  openSwell: {
    id: 'openSwell',
    label: 'West reach, open swell',
    at: [-900, 150],
    // heading +x (east): a lens ahead looking back has the sunset behind her; the line ends 120 m short of the
    // Pylon Row power line (a pylon top stands 14 m off it at x −510)
    path: [[-1700, 150], [-630, 150]],
    depthM: 30,
    k: 1.0,
    why: 'Up-swell of the whole group: K 1.0 and 28-45 m of water for a kilometre, nothing on the horizon to the west.',
  },
  rockyPoint: {
    id: 'rockyPoint',
    label: 'Knuckle, south-east knob',
    at: [441, 530],
    // the lap's own line G4 -> G5, extended back south: collider-cleared by the circuit's corridor rules, and it
    // passes ~15 m off the knob's east shoulder
    path: [[182, 1282], [407, 655], [568, 206], [323, 51], [0, -60]],
    depthM: 4.9,
    k: 0.7,
    why: "Knuckle's small SE knob stands right on the racing line G4 -> G5: a lens on its shoulder sees her come up the open south water and pass within ~15 m.",
  },
  towerTip: {
    id: 'towerTip',
    label: 'Tower Cay SE tip',
    at: [230, -140],
    // down the NE shore ~100 m off, round the tip on an R 115 m arc about (240, −140) — through the middle of the
    // 49 m G7 gate (poles 29 / 20 m off) — then back west ~70 m off the south shore
    path: [[40, -388], [168, -315], [298, -240], [340, -198], [355, -140], [340, -83], [298, -40], [240, -25], [183, -38], [60, -48], [-200, -40]],
    depthM: 4.1,
    k: 0.3,
    why: 'The one island tip with open water all round the arc: 4.1 m at the shallowest, 17.6 m to the nearest collider (G7 poles ≥ 35 m, Main Street roofs ≥ 80 m south).',
  },
  knuckleGap: {
    id: 'knuckleGap',
    label: 'Knuckle rock channel',
    at: [300, 355],
    // in from the east between the rock garden and the small knob, west past the middle knob, out between the big
    // knob and the NW garden
    path: [[640, 445], [470, 428], [400, 425], [358, 392], [300, 355], [240, 318], [170, 300], [60, 280], [-300, 250]],
    depthM: 3.8,
    k: 0.2,
    why: 'No true island-to-island channel exists on Tower Reach; the best gap is this winding passage through Knuckle (30-50 m wide, 3.8 m at its shallowest, 9.9 m to the nearest rock collider). FLAGGED: tight.',
  },
  horizon: {
    id: 'horizon',
    label: 'West reach, run to the horizon',
    at: [-700, 260],
    // heading −x (west): straight into the sunset, open water to the edge of the world
    // starts 350 m west of the Pylon Row line (a pylon stands on x −300)
    path: [[-650, 260], [-2800, 260]],
    depthM: 34,
    k: 1.0,
    why: 'Due west into the sun with no land on that bearing: the wake stretches back toward a lens that rises behind her.',
  },
};
