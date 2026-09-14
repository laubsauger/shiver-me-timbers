/**
 * TOWER REACH CIRCUIT (§T.187) — sites, course and furniture for the first
 * speedboat circuit, generated from the authored layout (towerReachLayout.ts)
 * over terrain built by the race island kit (kitFamilies.ts).
 *
 * Two entry points, because the page builds the sea BETWEEN them:
 *
 *   const layout = towerReachSites(seed);                    // cheap: registers the kit, returns sites
 *   const sea = buildSea(app, state, sky, weather, { sites: layout.sites, … });
 *   const world = buildTowerReach(seed, {
 *     heightmaps: sea.archipelago.islands.map((i) => i.heightmap),
 *     seabed: sea.archipelago.seabed,
 *   });
 *
 * Without `heightmaps` the builder bakes them itself (tests, tools). Either
 * way the course is the same function of the seed (§V2).
 *
 * WHAT IS MEASURED, NOT AUTHORED:
 *   · gate sectors — swell-shadow K at the gate on the reference sea (shelter.ts)
 *   · gate orientation — perpendicular to the reference line at the gate
 *   · lap length, corridor depth, bar crest depth — off the built seabed
 *   · roof, stake and minimap heights/outlines — off the finished heightmaps
 */
import type { Course, CourseElement, Gate, TurnMark, Vec2 } from '../race/types';
import { siteParams, type IslandSite } from '../island/archipelago';
import { generateIslandHeightmap, type IslandHeightmap } from '../island/heightmap';
import type { SeabedField } from '../island/seabed';
import type { KitArchetypeName } from '../island/sierraArchetypes';
import { createRng } from '../state/rng';
import {
  catmullRomClosed,
  closedLength,
  contourRings,
  distanceToClosed,
  len,
  markArc,
  nearestIndex,
  portOf,
  resampleClosed,
  ringArea,
  simplifyClosed,
  tangentAt,
} from './courseLine';
import { cayBars, kitOverrides, polylineDistance, registerKitIsland, type KitSpec } from './kitFamilies';
import { createShelterField, sectorOf } from './shelter';
import { registerKitRenderInfo } from './kitRender';
import {
  ELEMENTS,
  ISLANDS,
  LAYOUT_SCALE,
  MAIN_STREET,
  PYLON_LINES,
  TOWER,
  TOWER_REACH_SWELL_DIRECTION,
  type UV,
} from './towerReachLayout';

export const TOWER_REACH_ID = 'tower-reach';
export const TOWER_REACH_LAPS = 3;
/** decorrelates each island's stream from the world seed (same stride as the sierra slice) */
const SITE_SEED_STRIDE = 7919;

/**
 * THE BOAT the corridor is sized against (docs/speedboat/circuit.md §Gates):
 * the V-39 / deepV12 hull — 2.47 m overall beam, ~0.55 m static draft
 * (5.35 t on a 24° vee, see tests/circuit.test.ts for the derivation from
 * src/speedboat/deepV12.hull.json).
 */
export const BOAT_BEAM = 2.47;
export const BOAT_DRAFT = 0.6;
/**
 * MIN_GATE_WIDTH 40 m: two boats abreast (2 × 2.47 m) with 3 beams between
 * them, the National AI line tolerance ±9 m on each side (design doc §4), and
 * a 3 m flex/wash margin at each pole: 4.9 + 7.4 + 18 + 6 = 36 m → 40 m. At
 * 42 m/s a 1° heading error is 0.7 m/s of drift, so a gate this wide is ~20 s
 * of an uncorrected degree — forgiving at speed, still a chicane at 40 kn.
 */
export const MIN_GATE_WIDTH = 40;
/**
 * Water the corridor must keep everywhere but over a bar (m): static draft +
 * a stuffed landing burying the bow ~1.5 m + the Working-sea trough over a
 * shelf (~1 m) + margin.
 */
export const CORRIDOR_MIN_DEPTH = 4;
/** half-width of the corridor tested around the reference line (m) */
export const CORRIDOR_HALF_WIDTH = 14;
/**
 * Water over a bar crest (m): design doc §3 says ≥ 1.5; 2.0 keeps the static
 * keel 1.4 m clear and still lies inside the shoaling band that breaks the sea.
 * Physics gets a pass-through too (raceSeabed.ts) — a landing plunge is deeper
 * than any static margin.
 */
export const BAR_MIN_CREST_DEPTH = 2.0;
/**
 * §T.202 the authored pace line's length (m): the page's longest wanted clear straight (page/course.ts
 * PACE_STRAIGHT_MAX = grid room 175 + a 700 m pace run) plus sampling slack. The page shortens it to what is clear.
 */
export const PACE_RUN_IN = 880;
/** §T.194: metres beyond the corridor half-width a kit prop (block, log, rubble) must keep clear, plus its own size */
export const KIT_PROP_CORRIDOR_MARGIN = 6;

export interface SwellFrame {
  direction: number;
  toWorld(p: UV): Vec2;
  /** a swell-frame offset (du, dv) as a world offset (dx, dz) */
  rotate(p: UV): Vec2;
}

export function swellFrame(direction = TOWER_REACH_SWELL_DIRECTION): SwellFrame {
  const c = Math.cos(direction);
  const s = Math.sin(direction);
  const rotate = (p: UV): Vec2 => [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
  return {
    direction,
    rotate,
    toWorld: (p) => rotate([p[0] * LAYOUT_SCALE, p[1] * LAYOUT_SCALE]),
  };
}

const scaleUV = (p: UV): UV => [p[0] * LAYOUT_SCALE, p[1] * LAYOUT_SCALE];

/** a kit spec from the swell frame into the island's WORLD-aligned local frame */
function worldSpec(spec: KitSpec, f: SwellFrame): KitSpec {
  const P = (p: UV): Vec2 => f.rotate(scaleUV(p));
  const L = LAYOUT_SCALE;
  switch (spec.kind) {
    case 'sandCay':
      return {
        ...spec,
        spine: spec.spine.map(P),
        halfWidth: spec.halfWidth * L,
        crestInland: spec.crestInland * L,
        shelf: spec.shelf * L,
        bar: spec.bar ? { ...spec.bar, crest: spec.bar.crest.map(P), halfWidth: spec.bar.halfWidth * L } : undefined,
        bars: spec.bars?.map((b) => ({ ...b, crest: b.crest.map(P), halfWidth: b.halfWidth * L })),
      };
    case 'rockGarden': {
      const g = P([spec.garden.x, spec.garden.z]);
      return {
        ...spec,
        knobs: spec.knobs.map((kn) => {
          const k = P([kn.x, kn.z]);
          return { ...kn, x: k[0], z: k[1], a: kn.a * L, b: kn.b * L, axis: kn.axis + f.direction };
        }),
        garden: { ...spec.garden, x: g[0], z: g[1], a: spec.garden.a * L, b: spec.garden.b * L, axis: spec.garden.axis + f.direction },
        shelf: spec.shelf * L,
      };
    }
    case 'drownedTown': {
      const k = P([spec.knoll.x, spec.knoll.z]);
      const b = P([spec.bench.x, spec.bench.z]);
      return {
        ...spec,
        knoll: { ...spec.knoll, x: k[0], z: k[1], r: spec.knoll.r * L },
        bench: {
          ...spec.bench, x: b[0], z: b[1], halfLength: spec.bench.halfLength * L, halfWidth: spec.bench.halfWidth * L,
          axis: spec.bench.axis + f.direction, edge: spec.bench.edge * L,
        },
        shelf: spec.shelf * L,
      };
    }
  }
}

export interface TowerReachSites {
  seed: number;
  frame: SwellFrame;
  sites: IslandSite[];
  /** island ids, parallel to `sites` */
  ids: string[];
  /** the world-frame specs the sites were built from, parallel to `sites` */
  specs: KitSpec[];
}

/**
 * The lap's reference loop (world frame, 2 m spacing, index 0 at the start
 * gate) and the element anchors. Layout only — no terrain — so the kit's props
 * can keep clear of the corridor before the course itself is built (§T.194).
 */
export function referenceLoop(frame: SwellFrame): { anchor(i: number): Vec2; loop: Vec2[] } {
  const W = (p: UV): Vec2 => frame.toWorld(p);
  const n = ELEMENTS.length;
  const anchor = (i: number): Vec2 => {
    const e = ELEMENTS[(i + n) % n];
    return W(e.kind === 'gate' ? e.gate.at : e.mark.at);
  };
  const waypoints: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const e = ELEMENTS[i];
    if (e.kind === 'gate') waypoints.push(anchor(i));
    else waypoints.push(...markArc(anchor(i - 1), anchor(i), anchor(i + 1), e.mark.clearance, e.mark.keepOn, 6));
  }
  const dense = resampleClosed(catmullRomClosed(waypoints, 14), 2);
  // index 0 at the start gate
  const s0 = nearestIndex(dense, anchor(0));
  return { anchor, loop: [...dense.slice(s0), ...dense.slice(0, s0)] };
}

/** Register the kit families for this seed and return the site list (cheap, no terrain baked). */
export function towerReachSites(seed: number): TowerReachSites {
  const frame = swellFrame();
  // the corridor the kit's props keep clear of, resampled coarser (8 m) for the placement tests
  const corridorLine = resampleClosed(referenceLoop(frame).loop, 8);
  const sites: IslandSite[] = [];
  const ids: string[] = [];
  const specs: KitSpec[] = [];
  ISLANDS.forEach((isl, i) => {
    const siteSeed = seed + SITE_SEED_STRIDE * (i + 1);
    const spec = worldSpec(isl.spec, frame);
    const name = registerKitIsland(`kit:${TOWER_REACH_ID}/${seed}/${isl.id}` as KitArchetypeName, spec, siteSeed);
    // Spectrum travel now agrees with the authored direction and swell shadow.
    const at = frame.toWorld(isl.at);
    registerKitRenderInfo(name, {
      kind: spec.kind,
      spec,
      swellTravel: [Math.cos(frame.direction), Math.sin(frame.direction)],
      seed: siteSeed,
      corridor: corridorLine.map((p) => [p[0] - at[0], p[1] - at[1]] as const),
      corridorClearance: CORRIDOR_HALF_WIDTH + KIT_PROP_CORRIDOR_MARGIN,
    });
    sites.push({
      seed: siteSeed,
      position: frame.toWorld(isl.at) as [number, number],
      radius: isl.radius * LAYOUT_SCALE,
      archetype: name,
      overrides: kitOverrides(spec, isl.gridSize),
    });
    ids.push(isl.id);
    specs.push(spec);
  });
  return { seed, frame, sites, ids, specs };
}

// ── world output ─────────────────────────────────────────────────────────────

export interface GateInfo {
  id: string;
  number: number;
  sectorName: string;
  width: number;
  mid: Vec2;
  /** unit course direction through the gate */
  heading: Vec2;
  /** measured swell-shadow K (mean of the midpoint and both poles), reference sea */
  k: number;
  /** water depth at the left / right pole (m) */
  poleDepth: readonly [number, number];
}

export interface BarInfo {
  island: string;
  /** crest polyline, world */
  crest: Vec2[];
  /** where the reference line crosses the crest (null if it does not) */
  crossing: Vec2 | null;
  /** shallowest water over the crest inside the corridor (m) */
  corridorCrestDepth: number;
  /** half-width of the bar zone around its crest (m) */
  halfWidth: number;
}

export interface PolePlacement {
  gateId: string;
  side: 'left' | 'right';
  at: Vec2;
  /** asset +Z (the daymark face) toward approaching boats; forward = (sin yaw, cos yaw) */
  yaw: number;
  number: number;
  board: 'square' | 'triangle';
  depth: number;
}

export interface BuoyPlacement {
  markId: string;
  at: Vec2;
  yaw: number;
  depth: number;
}

export interface StakePlacement {
  at: Vec2;
  yaw: number;
  /** seabed height at the foot (m, negative) */
  floor: number;
  lean: number;
  leanDir: number;
}

export interface PylonPlacement {
  line: number;
  index: number;
  at: Vec2;
  /** asset +Z along the power line */
  yaw: number;
}

export type RoofKind = 'gable' | 'gableChimney' | 'hip' | 'shed' | 'steeple' | 'waterTower';

export interface RoofPlacement {
  kind: RoofKind;
  at: Vec2;
  /** asset +Z (the street front) toward the street */
  yaw: number;
  /** seabed (the old ground floor) under the building (m, negative) */
  floor: number;
}

export interface TowerPlacement {
  at: Vec2;
  /**
   * three.js rotation.y of the asset: asset −X (race control, the lamp boom) toward the start straight, asset +Z
   * toward the boats running up it, the three legs at asset −X and ±60° toward `anchors` (in that order)
   */
  yaw: number;
  lean: number;
  /** world bearing (atan2 z, x) the mast leans toward */
  leanDir: number;
  anchors: Vec2[];
}

/**
 * §T.202 START PONTOONS: one moored just short of the start line outboard of each start pole, long axis along the line.
 * Chequer flags and a lamp board that repeats the tower's start lamps face the boats running up to the line.
 */
export const START_PONTOON = {
  /** along the gate line, beam across it, deck above still water, hull below it (m) */
  length: 9,
  beam: 3,
  freeboard: 0.7,
  draft: 0.5,
  /** gap from the pole to the pontoon's near end, and how far short of the line its centre is moored (m) */
  poleGap: 4,
  shortOfLine: 14,
};

export interface StartPontoonPlacement {
  side: 'left' | 'right';
  /** pontoon centre on still water, world */
  at: Vec2;
  /** asset +Z (flags, lamp board) toward the boats running up to the line; asset X along the line */
  yaw: number;
  depth: number;
}

export interface CourseFurnitureData {
  poles: PolePlacement[];
  startPontoons: StartPontoonPlacement[];
  buoys: BuoyPlacement[];
  stakes: StakePlacement[];
  pylons: PylonPlacement[];
  /** consecutive pylon pairs a cable set spans, by index into `pylons` */
  spans: readonly [number, number][];
  roofs: RoofPlacement[];
  tower: TowerPlacement;
}

export interface MinimapData {
  bounds: { min: Vec2; max: Vec2 };
  /** simplified reference line (closed) */
  course: Vec2[];
  /** simplified coastline rings (still water), world */
  land: Vec2[][];
  /** shallow-water rings at −3 m (bars, platforms) */
  shallows: Vec2[][];
  gates: { id: string; left: Vec2; right: Vec2; number: number }[];
  marks: { id: string; at: Vec2 }[];
  tower: Vec2;
}

export interface TowerReachWorld {
  seed: number;
  sites: IslandSite[];
  ids: string[];
  heightmaps: IslandHeightmap[];
  course: Course;
  lapLength: number;
  gates: GateInfo[];
  bars: BarInfo[];
  furniture: CourseFurnitureData;
  minimap: MinimapData;
  /** shallowest corridor water outside bar zones (m) and where */
  corridor: { minDepth: number; at: Vec2 };
  /** stable 32-bit FNV-1a over the generated data — the determinism handle */
  hash: string;
  /** seabed height (m) at a world XZ over this circuit's terrain */
  seabedAt(x: number, z: number): number;
  dispose(): void;
}

export interface BuildTowerReachOptions {
  /** the archipelago's finished heightmaps, parallel to `towerReachSites(seed).sites` */
  heightmaps?: readonly IslandHeightmap[];
  /** the archipelago's seabed (saves a 1024² bake) */
  seabed?: SeabedField;
}

export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const rv = (p: Vec2): Vec2 => [r3(p[0]), r3(p[1])];

export function buildTowerReach(seed: number, opts: BuildTowerReachOptions = {}): TowerReachWorld {
  const layout = towerReachSites(seed);
  const { frame, sites, ids, specs } = layout;
  const heightmaps = opts.heightmaps
    ? [...opts.heightmaps]
    : sites.map((s) => generateIslandHeightmap(s.seed, siteParams(s)));
  if (heightmaps.length !== sites.length) {
    throw new Error(`buildTowerReach: ${heightmaps.length} heightmaps for ${sites.length} sites`);
  }
  const shelter = createShelterField(
    heightmaps.map((hm, i) => ({ heightmap: hm, center: sites[i].position })),
    opts.seabed,
  );
  const bed = shelter.seabed;
  const seabedAt = (x: number, z: number): number => bed.heightAt(x, z);
  const depthAt = (p: Vec2): number => -bed.heightAt(p[0], p[1]);

  // ── the reference line ────────────────────────────────────────────────────
  const W = (p: UV): Vec2 => frame.toWorld(p);
  const n = ELEMENTS.length;
  const { anchor, loop } = referenceLoop(frame);
  const lapLength = closedLength(loop);

  // ── gates + marks ─────────────────────────────────────────────────────────
  const gates: GateInfo[] = [];
  const elements: CourseElement[] = [];
  for (let i = 0; i < n; i++) {
    const e = ELEMENTS[i];
    if (e.kind === 'mark') {
      const mark: TurnMark = { id: e.mark.id, at: rv(anchor(i)), keepOn: e.mark.keepOn, radius: e.mark.radius };
      elements.push({ kind: 'mark', mark });
      continue;
    }
    const mid = anchor(i);
    const heading = tangentAt(loop, nearestIndex(loop, mid));
    const port = portOf(heading[0], heading[1]);
    const hw = e.gate.width / 2;
    const left: Vec2 = [mid[0] + port[0] * hw, mid[1] + port[1] * hw];
    const right: Vec2 = [mid[0] - port[0] * hw, mid[1] - port[1] * hw];
    const k = (shelter.kAt(mid[0], mid[1]) + shelter.kAt(left[0], left[1]) + shelter.kAt(right[0], right[1])) / 3;
    const gate: Gate = { id: e.gate.id, left: rv(left), right: rv(right), sector: sectorOf(k) };
    elements.push({ kind: 'gate', gate });
    gates.push({
      id: e.gate.id, number: e.gate.number, sectorName: e.gate.sectorName, width: e.gate.width,
      mid: rv(mid), heading: rv(heading), k: r3(k), poleDepth: [r3(depthAt(left)), r3(depthAt(right))],
    });
  }

  const referenceLine = resampleClosed(loop, 8).map(rv);
  // §T.202 pace line: the STRAIGHT run-in along the start gate's heading, ending ON its midpoint. The layout points
  // it into the open lee east of the Tower straight, clear of Main Street, so the grid rolls in open water (tested).
  const s0 = gates[0];
  const paceLine: Vec2[] = [];
  for (let d = PACE_RUN_IN; d > 0; d -= 8) paceLine.push(rv([s0.mid[0] - s0.heading[0] * d, s0.mid[1] - s0.heading[1] * d]));
  paceLine.push(s0.mid);

  // ── bars ──────────────────────────────────────────────────────────────────
  const bars: BarInfo[] = [];
  specs.forEach((spec, i) => {
    if (spec.kind !== 'sandCay') return;
    for (const barSpec of cayBars(spec)) {
      const c = sites[i].position;
      const crest: Vec2[] = barSpec.crest.map((p) => [p[0] + c[0], p[1] + c[1]]);
      let crossing: Vec2 | null = null;
      let corridorCrestDepth = Infinity;
      for (let j = 0; j < loop.length; j += 1) {
        const p = loop[j];
        const b = polylineDistance(crest, p[0], p[1]);
        if (b.d > barSpec.halfWidth) continue;
        if (b.d < 4 && !crossing) crossing = rv(p);
        const t = tangentAt(loop, j);
        const pt = portOf(t[0], t[1]);
        for (const o of [-CORRIDOR_HALF_WIDTH, 0, CORRIDOR_HALF_WIDTH]) {
          corridorCrestDepth = Math.min(corridorCrestDepth, depthAt([p[0] + pt[0] * o, p[1] + pt[1] * o]));
        }
      }
      bars.push({ island: ids[i], crest: crest.map(rv), crossing, corridorCrestDepth: r3(corridorCrestDepth), halfWidth: barSpec.halfWidth });
    }
  });
  const inBarZone = (p: Vec2): boolean =>
    bars.some((b) => polylineDistance(b.crest, p[0], p[1]).d <= b.halfWidth);

  // ── corridor ──────────────────────────────────────────────────────────────
  let minDepth = Infinity;
  let minAt: Vec2 = [0, 0];
  for (let j = 0; j < loop.length; j += 2) {
    const p = loop[j];
    const t = tangentAt(loop, j);
    const pt = portOf(t[0], t[1]);
    for (const o of [-CORRIDOR_HALF_WIDTH, -CORRIDOR_HALF_WIDTH / 2, 0, CORRIDOR_HALF_WIDTH / 2, CORRIDOR_HALF_WIDTH]) {
      const q: Vec2 = [p[0] + pt[0] * o, p[1] + pt[1] * o];
      if (inBarZone(q)) continue;
      const d = depthAt(q);
      if (d < minDepth) {
        minDepth = d;
        minAt = q;
      }
    }
  }

  // ── furniture ─────────────────────────────────────────────────────────────
  const rng = createRng(seed ^ 0x5eed_c0de);
  const poles: PolePlacement[] = [];
  for (const g of gates) {
    const port = portOf(g.heading[0], g.heading[1]);
    const hw = g.width / 2;
    // the board faces the boats coming at it: asset +Z = −heading
    const yaw = Math.atan2(-g.heading[0], -g.heading[1]);
    for (const side of ['left', 'right'] as const) {
      const sgn = side === 'left' ? 1 : -1;
      const at: Vec2 = [g.mid[0] + port[0] * hw * sgn, g.mid[1] + port[1] * hw * sgn];
      poles.push({ gateId: g.id, side, at: rv(at), yaw: r3(yaw), number: g.number, board: side === 'left' ? 'square' : 'triangle', depth: r3(depthAt(at)) });
    }
  }
  const startPontoons: StartPontoonPlacement[] = [];
  {
    const g = gates[0];
    const port = portOf(g.heading[0], g.heading[1]);
    const out = g.width / 2 + START_PONTOON.poleGap + START_PONTOON.length / 2;
    for (const side of ['left', 'right'] as const) {
      const sgn = side === 'left' ? 1 : -1;
      const at: Vec2 = [
        g.mid[0] + port[0] * out * sgn - g.heading[0] * START_PONTOON.shortOfLine,
        g.mid[1] + port[1] * out * sgn - g.heading[1] * START_PONTOON.shortOfLine,
      ];
      startPontoons.push({ side, at: rv(at), yaw: r3(Math.atan2(-g.heading[0], -g.heading[1])), depth: r3(depthAt(at)) });
    }
  }
  const buoys: BuoyPlacement[] = [];
  for (let i = 0; i < n; i++) {
    const e = ELEMENTS[i];
    if (e.kind !== 'mark') continue;
    const at = anchor(i);
    const from = anchor(i - 1);
    buoys.push({ markId: e.mark.id, at: rv(at), yaw: r3(Math.atan2(from[0] - at[0], from[1] - at[1])), depth: r3(depthAt(at)) });
  }
  const stakes: StakePlacement[] = [];
  for (const b of bars) {
    let acc = 0;
    for (let j = 0; j + 1 < b.crest.length; j++) {
      const a = b.crest[j];
      const c = b.crest[j + 1];
      const l = len(a, c);
      for (let s = (55 - (acc % 55)) % 55; s < l; s += 55) {
        const p: Vec2 = [a[0] + ((c[0] - a[0]) * s) / l, a[1] + ((c[1] - a[1]) * s) / l];
        const floor = bed.heightAt(p[0], p[1]);
        const clear = distanceToClosed(referenceLine, p) >= 55;
        const draw = [rng(), rng(), rng()];
        if (!clear || floor > -1.2 || floor < -5) continue;
        stakes.push({ at: rv(p), yaw: r3(draw[0] * Math.PI * 2), floor: r3(floor), lean: r3(0.02 + draw[1] * 0.07), leanDir: r3(draw[2] * Math.PI * 2) });
      }
      acc += l;
    }
  }
  const pylons: PylonPlacement[] = [];
  const spans: [number, number][] = [];
  const lineYaw = (() => {
    const d = frame.rotate([0, 1]);
    return Math.atan2(d[0], d[1]);
  })();
  PYLON_LINES.forEach((line, li) => {
    line.v.forEach((v, k) => {
      if (k > 0) spans.push([pylons.length - 1, pylons.length]);
      pylons.push({ line: li, index: k, at: rv(W([line.u, v])), yaw: r3(lineYaw) });
    });
  });

  // Main Street: plots down both sides of the street, fronts to the street
  const roofs: RoofPlacement[] = [];
  {
    const ti = ids.indexOf(MAIN_STREET.island);
    const c = sites[ti].position;
    const a = frame.rotate(scaleUV(MAIN_STREET.from));
    const b = frame.rotate(scaleUV(MAIN_STREET.to));
    const A: Vec2 = [a[0] + c[0], a[1] + c[1]];
    const B: Vec2 = [b[0] + c[0], b[1] + c[1]];
    const L = len(A, B);
    const dir: Vec2 = [(B[0] - A[0]) / L, (B[1] - A[1]) / L];
    const side = portOf(dir[0], dir[1]);
    const kinds: RoofKind[] = ['gable', 'gableChimney', 'hip', 'gable', 'shed', 'gableChimney'];
    const pitch = MAIN_STREET.pitch * LAYOUT_SCALE;
    // the street front, then a back row behind it; plots the racing line swings into are left empty
    const rows: [number, number, number][] = [
      [1, 0, 0.16],
      [-1, 0, 0.16],
      [1, 22, 0.45],
      [-1, 22, 0.45],
    ];
    for (const [sgn, back, gap] of rows) {
      for (let s = pitch * 0.5 + (back ? pitch * 0.4 : 0); s < L - pitch * 0.25; s += pitch) {
        const draw = [rng(), rng(), rng()];
        // a missing house now and then: a street is not a comb
        if (draw[0] < gap) continue;
        const setback = MAIN_STREET.clearWidth / 2 + 6 + back + draw[1] * 3;
        const at: Vec2 = [A[0] + dir[0] * s + side[0] * setback * sgn, A[1] + dir[1] * s + side[1] * setback * sgn];
        if (distanceToClosed(referenceLine, at) < MAIN_STREET.clearWidth / 2 + 4) continue;
        const toStreet: Vec2 = [-side[0] * sgn, -side[1] * sgn];
        roofs.push({
          kind: kinds[Math.floor(draw[2] * kinds.length) % kinds.length],
          at: rv(at),
          yaw: r3(Math.atan2(toStreet[0], toStreet[1])),
          floor: r3(bed.heightAt(at[0], at[1])),
        });
      }
    }
    // the steeple a third of the way up, set back on the port side; the water tower at the far end
    const landmark = (kind: RoofKind, s: number, setback: number, sgn: number): void => {
      const at: Vec2 = [A[0] + dir[0] * s + side[0] * setback * sgn, A[1] + dir[1] * s + side[1] * setback * sgn];
      roofs.push({ kind, at: rv(at), yaw: r3(Math.atan2(-side[0] * sgn, -side[1] * sgn)), floor: r3(bed.heightAt(at[0], at[1])) });
    };
    landmark('steeple', L * 0.36, MAIN_STREET.clearWidth / 2 + 30, 1);
    landmark('waterTower', L * 0.9, MAIN_STREET.clearWidth / 2 + 34, -1);
  }

  const towerAt = W(TOWER.at);
  const tower: TowerPlacement = {
    at: rv(towerAt),
    // the asset's legs point along its −X and ±60° (course_radio_tower), the layout's guy anchors sit at π and
    // ±π/3 in the swell frame: yaw −θ maps asset +X onto the swell's u, so every guy runs from a leg to its anchor,
    // asset −X (race control, the lamp boom) faces the start straight and +Z faces the boats running up it
    yaw: r3(-frame.direction),
    lean: TOWER.lean,
    leanDir: r3(frame.direction + TOWER.leanToward),
    anchors: TOWER.anchorAzimuths.map((az) => rv(W([TOWER.at[0] + Math.cos(az) * TOWER.anchorRadius, TOWER.at[1] + Math.sin(az) * TOWER.anchorRadius]))),
  };

  // ── minimap ───────────────────────────────────────────────────────────────
  const land: Vec2[][] = [];
  const shallows: Vec2[][] = [];
  heightmaps.forEach((hm, i) => {
    const c = sites[i].position;
    const cell = (2 * hm.worldRadius) / (hm.size - 1);
    const place = (rings: Vec2[][], minArea: number, tol: number, out: Vec2[][]): void => {
      for (const r of rings) {
        if (Math.abs(ringArea(r)) < minArea) continue;
        out.push(simplifyClosed(r, tol).map((p) => rv([p[0] + c[0], p[1] + c[1]])));
      }
    };
    place(contourRings(hm.data, hm.size, -hm.worldRadius, -hm.worldRadius, cell, 0), 60, 2.5, land);
    place(contourRings(hm.data, hm.size, -hm.worldRadius, -hm.worldRadius, cell, -3), 400, 4, shallows);
  });
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  const grow = (p: Vec2): void => {
    minX = Math.min(minX, p[0]);
    maxX = Math.max(maxX, p[0]);
    minZ = Math.min(minZ, p[1]);
    maxZ = Math.max(maxZ, p[1]);
  };
  referenceLine.forEach(grow);
  paceLine.forEach(grow);
  land.forEach((r) => r.forEach(grow));
  pylons.forEach((p) => grow(p.at));
  roofs.forEach((p) => grow(p.at));
  tower.anchors.forEach(grow);
  const pad = 120;
  const bounds = { min: rv([minX - pad, minZ - pad]), max: rv([maxX + pad, maxZ + pad]) };
  const minimap: MinimapData = {
    bounds,
    course: simplifyClosed(referenceLine, 3).map(rv),
    land,
    shallows,
    gates: elements.flatMap((e) => (e.kind === 'gate' ? [{ id: e.gate.id, left: e.gate.left, right: e.gate.right, number: gates.find((g) => g.id === e.gate.id)!.number }] : [])),
    marks: elements.flatMap((e) => (e.kind === 'mark' ? [{ id: e.mark.id, at: e.mark.at }] : [])),
    tower: tower.at,
  };

  const course: Course = {
    id: TOWER_REACH_ID,
    name: 'Tower Reach',
    elements,
    startGateId: 'S',
    laps: TOWER_REACH_LAPS,
    referenceLine,
    paceLine,
    bounds,
  };
  const furniture: CourseFurnitureData = { poles, startPontoons, buoys, stakes, pylons, spans, roofs, tower };
  const hash = fnv1a(JSON.stringify({ course, furniture, minimap, gates, bars, sites }));

  return {
    seed,
    sites,
    ids,
    heightmaps,
    course,
    lapLength,
    gates,
    bars,
    furniture,
    minimap,
    corridor: { minDepth: r3(minDepth), at: rv(minAt) },
    hash,
    seabedAt,
    dispose: () => shelter.dispose(),
  };
}
