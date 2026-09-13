/**
 * TOWER REACH — the authored layout (§T.187, design doc §5 and its circuit map).
 *
 * Authored in the SWELL FRAME of the reference sea: u runs down-swell (the way
 * the swell travels), v is u turned +90° (x → z). On a top view (x right,
 * z down) the design doc's map reads straight: swell left → right, north up.
 * `swellFrame` rotates it onto the world, so the layout keeps its relation to
 * the swell if the shipped bearing ever moves (and the tests re-measure).
 *
 * The lap, counter-clockwise on the map, every turn to PORT:
 *   Tower straight (lee of Tower Cay)  S → G1 → T1 hairpin
 *   The Bar (head sea, breaking bar)   G2 → G3
 *   Pylon Row (beam sea, power line)   T2 → G4 → T3
 *   Stuff Run (following sea)          G5
 *   Main Street → lee chicane          G6 (roofs) → G7 → G8 (lee of Knuckle)
 *
 * Numbers here are LAYOUT, not tuning of the sea: sectors, crest depths, lap
 * length and corridor depth are all measured off the built terrain and pinned
 * by tests/circuit.test.ts.
 */
import type { BarSpec, DrownedTownSpec, RockGardenSpec, SandCaySpec } from './kitFamilies';

export type UV = readonly [u: number, v: number];

/** swell travel bearing the layout is authored against (checked against the preset in tests) */
export const TOWER_REACH_SWELL_DIRECTION = Math.PI * 1.68;

/** uniform scale on every authored length (islands, positions); gate widths and depths do not scale */
export const LAYOUT_SCALE = 1;

export interface KitIslandLayout {
  id: string;
  /** centre in the swell frame (m) */
  at: UV;
  /** heightmap footprint half-extent (m) */
  radius: number;
  gridSize: number;
  /** spec in LOCAL swell-frame metres (rotated onto the world by towerReach.ts) */
  spec: SandCaySpec | RockGardenSpec | DrownedTownSpec;
}

const bar: BarSpec = {
  crest: [[-15, -230], [-11, -80], [-1, 70], [29, 220]],
  crestDepth: 2.1,
  crestUndulation: 0.9,
  halfWidth: 60,
  shoalDepth: 9,
};

export const ISLANDS: readonly KitIslandLayout[] = [
  {
    id: 'tower-cay',
    at: [230, -140],
    radius: 440,
    gridSize: 256,
    spec: {
      kind: 'sandCay',
      spine: [[-15, -270], [-45, -120], [-45, 100], [5, 255]],
      halfWidth: 85,
      crestHeight: 8,
      crestInland: 22,
      floorDepth: 30,
      shelf: 130,
    },
  },
  {
    id: 'bar-head',
    at: [5, -630],
    radius: 400,
    gridSize: 256,
    spec: {
      kind: 'sandCay',
      spine: [[-45, -250], [-5, -225]],
      halfWidth: 24,
      crestHeight: 3,
      crestInland: 14,
      floorDepth: 28,
      shelf: 110,
      bar,
    },
  },
  {
    id: 'knuckle',
    at: [-250, 400],
    radius: 400,
    gridSize: 256,
    spec: {
      kind: 'rockGarden',
      knobs: [
        { x: -10, z: -40, a: 120, b: 62, axis: Math.PI * 0.46, height: 17 },
        { x: 25, z: 110, a: 70, b: 42, axis: Math.PI * 0.58, height: 10 },
        { x: -30, z: -190, a: 55, b: 36, axis: Math.PI * 0.4, height: 8 },
        { x: 40, z: 205, a: 40, b: 26, axis: Math.PI * 0.7, height: 6 },
      ],
      garden: { x: 165, z: 60, a: 175, b: 70, axis: Math.PI * 0.42 },
      boulders: 55,
      boulderRadius: [5, 16],
      boulderTop: [-0.8, 5.5],
      platformDepth: 4.5,
      floorDepth: 28,
      shelf: 110,
    },
  },
  {
    id: 'main-street',
    at: [150, 470],
    radius: 360,
    gridSize: 256,
    spec: {
      kind: 'drownedTown',
      knoll: { x: 135, z: 175, r: 62, height: 11 },
      bench: { x: -20, z: -10, halfLength: 235, halfWidth: 80, axis: Math.PI / 2, depth: 7.2, edge: 110 },
      floorDepth: 24,
      shelf: 150,
    },
  },
];

export interface GateLayout {
  id: string;
  at: UV;
  /** pole-to-pole width (m) — see MIN_GATE_WIDTH */
  width: number;
  /** what the daymark boards carry: 0 = chequer (start/finish), 1..8 = gate number */
  number: number;
  sectorName: string;
}

export interface MarkLayout {
  id: string;
  at: UV;
  keepOn: 'port' | 'starboard';
  /** race-logic rounding radius (m) — types.ts TurnMark.radius */
  radius: number;
  /** the reference line's distance from the mark centre (m) */
  clearance: number;
}

export type ElementLayout = { kind: 'gate'; gate: GateLayout } | { kind: 'mark'; mark: MarkLayout };

const G = (id: string, at: UV, width: number, number: number, sectorName: string): ElementLayout => ({
  kind: 'gate',
  gate: { id, at, width, number, sectorName },
});
const T = (id: string, at: UV): ElementLayout => ({
  kind: 'mark',
  mark: { id, at, keepOn: 'port', radius: 28, clearance: 48 },
});

export const ELEMENTS: readonly ElementLayout[] = [
  G('S', [420, -40], 72, 0, 'Tower straight'),
  G('G1', [440, -330], 70, 1, 'Tower straight'),
  T('T1', [485, -470]),
  G('G2', [220, -620], 110, 2, 'The Bar'),
  G('G3', [-220, -612], 110, 3, 'The Bar'),
  T('T2', [-425, -505]),
  G('G4', [-455, -30], 80, 4, 'Pylon Row'),
  T('T3', [-425, 585]),
  G('G5', [-335, 695], 90, 5, 'Stuff Run'),
  G('G6', [130, 590], 46, 6, 'Main Street'),
  G('G7', [130, 300], 42, 7, 'Lee chicane'),
  G('G8', [330, 200], 50, 8, 'Lee chicane'),
];

/** the drowned power line through Pylon Row: two parallel lines of pylon tops */
export const PYLON_LINES: readonly { u: number; v: readonly number[] }[] = [
  { u: -515, v: [-360, -110, 140, 390] },
  { u: -385, v: [-360, -110, 140] },
];

/** the drowned radio tower at start/finish, east of the start straight */
export const TOWER = {
  at: [500, -30] as UV,
  /** lean (rad) and the swell-frame bearing it leans toward (away from the course) */
  lean: 0.075,
  leanToward: 0.35,
  /**
   * guy anchor radius (m) and swell-frame azimuths: the start straight runs between the mast and
   * its western anchor, under that guy (it crosses the course ~25 m up)
   */
  anchorRadius: 130,
  anchorAzimuths: [Math.PI, Math.PI / 3, -Math.PI / 3],
};

/** Main Street: the street axis in the town's LOCAL swell frame (from the south end to the north end) */
export const MAIN_STREET = {
  island: 'main-street',
  from: [-20, 215] as UV,
  to: [-20, -215] as UV,
  /** eave-to-eave clear width of the street (m) */
  clearWidth: 50,
  /** house plot pitch along the street (m) */
  pitch: 21,
};
