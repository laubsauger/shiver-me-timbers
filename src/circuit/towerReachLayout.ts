/**
 * TOWER REACH — the authored layout (§T.187, design doc §5 and its circuit map).
 *
 * Authored in the SWELL FRAME of the reference sea: u runs down-swell (the way
 * the swell travels), v is u turned +90° (x → z). On a top view (x right,
 * z down) the design doc's map reads straight: swell left → right, north up.
 * `swellFrame` rotates it onto the world, so the layout keeps its relation to
 * the swell if the shipped bearing ever moves (and the tests re-measure).
 *
 * The lap, counter-clockwise on the map, every turn mark to PORT:
 *   Start (lee of Tower Cay)           S → T1
 *   The Bar (head sea, breaking bar)   G1 → G2
 *   Pylon Row (beam sea, power line)   T2 → G3 → T3
 *   Stuff Run (following sea)          G4
 *   Main Street → lee chicane          G5 (roofs) → G6 → G7 (lee of Knuckle)
 *   Tower straight                     G8 → S
 *
 * §T.202 THE START (user playtest: the grid "pulled through the houses before even making course"): S sits at the top
 * of the Tower straight and the lap leans the straight so its run-in points NNW out of the open lee east of Tower Cay,
 * > 300 m from Main Street. The grid rolls ~880 m up it (through G8) with the tower's lamps ahead; the town is the
 * late-lap highlight. T1 is set west of the straight so the line leaves S without a starboard wiggle.
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

/**
 * THE BAR (§T.194 retune, measured — docs/speedboat/circuit.md §T194 "The bar").
 * The §T.187 bar (crest 2.1 m, 9 m shoal) put its steepest water on one flank
 * point and the breaking cap on the crest: its p99 face slope beat the exposed
 * straights on 1 seed of 5. The lap's steep bar water is at 4-6 m, just before
 * breaking (T193), so the bar is now a THREE-BAR SYSTEM laid along the swell:
 * an outer bar the swell meets first (+u, the side it arrives from), the main
 * bar, and an inner bar — each a broad 6.5-7 m shoal with a 3.4-3.8 m crest
 * and its steep flank on the swell side. The course crosses all three.
 */
const bar: BarSpec = {
  crest: [[-15, -230], [-11, -80], [-1, 70], [29, 220]],
  crestDepth: 3.4,
  crestUndulation: 0.3,
  waveRelief: 0.15,
  halfWidth: 60,
  shoalDepth: 6.5,
  faceWidth: 1.6,
  backWidth: 1.2,
  profilePower: 0.8,
  apron: 1.6,
};
const shifted = (b: BarSpec, du: number, over: Partial<BarSpec>): BarSpec => ({ ...b, ...over, crest: b.crest.map((p) => [p[0] + du, p[1]] as const) });
const outerBar = shifted(bar, 115, { crestDepth: 3.8, halfWidth: 55 });
const innerBar = shifted(bar, -115, { crestDepth: 3.6, halfWidth: 50 });

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
      bars: [outerBar, innerBar],
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
  G('S', [455, -254], 72, 0, 'Tower straight'),
  T('T1', [380, -560]),
  G('G1', [220, -620], 110, 1, 'The Bar'),
  G('G2', [-220, -612], 110, 2, 'The Bar'),
  T('T2', [-425, -505]),
  G('G3', [-455, -30], 80, 3, 'Pylon Row'),
  T('T3', [-425, 585]),
  G('G4', [-335, 695], 90, 4, 'Stuff Run'),
  G('G5', [130, 590], 46, 5, 'Main Street'),
  G('G6', [130, 300], 42, 6, 'Lee chicane'),
  G('G7', [330, 200], 50, 7, 'Lee chicane'),
  G('G8', [540, 40], 70, 8, 'Tower straight'),
];

/** the drowned power line through Pylon Row: two parallel lines of pylon tops */
export const PYLON_LINES: readonly { u: number; v: readonly number[] }[] = [
  { u: -515, v: [-360, -110, 140, 390] },
  { u: -385, v: [-360, -110, 140] },
];

/** the drowned radio tower at start/finish, 80 m east of the start gate */
export const TOWER = {
  at: [535, -244] as UV,
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
