/**
 * THE BEACH'S SMALL THINGS (the user, 2026-10-29: "some pebbles on the beach could be a thing" — up close our sand
 * read as a clean plane). A motu's lagoon beach is coral sand with what the sea leaves on it (references §12,
 * tropical-coast-lagoon): pale coral pebbles and rubble, shells, a few bleached sticks, and at the highest tides'
 * reach a wrack line of dried seagrass, leaves and twigs. Dark basalt pebbles would be another beach. Scanned CC0
 * pieces (fetched by scripts/drift-pbr-fetch.py, cut down by scripts/drift-prop-export.py and
 * scripts/drift-shell-export.py), instanced, seeded, each turned to lie as such a thing lies and sunk into the sand:
 *
 *   pebble, cobble  Poly Haven namaqualand_boulder_05, a rounded stone: worn coral pebbles (5–12 cm) and a few
 *                   cobbles (8–18 cm), tumbled every way, squashed and stretched, taken to coral's cream-white
 *   stick           Poly Haven dead_quiver_branch_01: a rare bleached stick (8–24 cm)
 *   shell           ambientCG ShellSet001: nine scanned scallops (5–9 cm), most cup-down, some cup-up
 *   conch           Poly Haven lambis_shell, a spider conch (11–15 cm): a few along the walk
 *   leaf, twig      Poly Haven dry_quiver_leaf and dry_branches_medium_01: the wrack line's dried leaves and twigs
 *
 * WHERE the water and the wind put them (the beach's height `ground` m over the sea, the share of the sand it is
 * on), in small groups (a pebble or a shell seldom lies alone), along two lines that run the length of the beach:
 *
 *   - the swash, the sand the waves run up (under ~0.5 m): almost nothing; the waves rework it;
 *   - THE SWASH'S UPPER LIMIT, ~0.6 m: pebbles and shells where the last waves dropped them, clumped along it;
 *   - the open dry sand between the lines: a very thin scatter (a patchy scatter over it — dense patches a few metres
 *     across, bare sand round them — read as "a planted rectangle of dots" mid-beach, the 2026-10-29 review);
 *   - THE WRACK LINE, ~1 m (a few metres below the strand line sea.ts lays the driftwood on): dried leaves, twigs,
 *     rubble and shells in clumps. beachMaterial.ts carries the same line on as a decal (`WRACK`, the same noise)
 *     where the scattered things are gone;
 *   - under the scrub's litter (forest.ts), fading out.
 *
 * SITTING IN THE SAND, NOT ON IT (the user on the first pass, 2026-10-29: "it doesn't cast shadows, it looks like
 * floating pebbles … whatever makes it look less cheap"). Every piece casts into the Sun's shadow map (8192², ~2.2 cm
 * texels over the coast, sea.ts); a pebble of a few centimetres is still only a texel or two there, so each piece
 * also lays a CONTACT FOOTPRINT on the sand under it, independent of the map: a soft dark ellipse sized and turned
 * to the piece's own outline on the ground, darkest at its middle, deeper for a piece standing taller than it is
 * wide, with a faint lighter lip round it (the sand it pushed up as it settled); and the piece's own foot takes the
 * sand's colour for a few millimetres over its burial line (sand clinging to it).
 *
 * WHAT IS DRAWN: never a speck (the same review: "our sub-pixel rendering is horrendous: I'd much rather have stuff
 * disappear than look like that"; "it just adds noise at the far end"). A piece is drawn only where it spans at
 * least COVERAGE.gone from the eye — 4.5 mrad, ~4.4 px of the 16:9 review at 1280 px over 75° and ~6 of a 4K dome
 * master (at 3.6 mrad the pieces 10–20 m off still read as dark specks in the review stills) — and fades out by
 * coverage on the way there: from COVERAGE.full (6.5 mrad) down to COVERAGE.gone it shrinks into the sand at its
 * foot (its footprint with it), so a piece leaves rather than shrinks to a twinkle — over a short way (from 8 mrad,
 * half the pebbles a few metres off were already shrunk to crumbs in the stills). A 5 cm pebble is whole to ~7.7 m
 * and gone by ~11 m, a conch by ~30 m. Live from the eye (`setEye`), the shadow pass included; and
 * placed only where some point of the eye's path (beats.ts coastEye, the raft's w1 drift to w6's rise) sees it
 * that large. Nothing within half a metre of the walked line, nothing over 6 cm on the wanderers' path (props.ts
 * walkers), nothing at a palm's foot. Instanced per kind, per piece and per 40 m tile along the beach (so a cube
 * face culls the tiles out of its view); the footprints one instanced quad per piece, per tile.
 */
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { attribute, exp, float, mix, positionLocal, positionWorld, smoothstep, texture, uniform, uv, vec3 } from 'three/tsl';
import { fbm2Cpu } from '../../terrain/noiseCpu';
import { rng } from '../undertime/web';
import { beatStarts, coastEye } from './beats';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

const smooth = (a: number, b: number, x: number): number => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

/**
 * THE WRACK LINE, where the highest tides leave what they carry: a band round a height over the sea that wanders
 * along the beach, broken into clumps. One definition for the things laid on it here and the decal beachMaterial.ts
 * paints with it (the same value noise, terrain/noise.ts and its CPU mirror, at the same world coordinates).
 */
export const WRACK = {
  /** m over the sea: the line's middle, how far it wanders up and down, the half-width (in height) of its core. A
   * few metres seaward of the vegetation line (sea.ts lays the driftwood on the 1.4 m strand): at 1.32 m the line
   * lay under the scrub's leaf litter (forest.ts litterMask, from ~14 m inland) and could not be told from it */
  height: 1.0,
  wander: 0.12,
  half: 0.07,
  /** m: the scale of its wander along the beach, and of its clumps */
  wanderScale: 31,
  clumpScale: 3.7,
  /** the clumps: the noise's share between bare sand and a full clump */
  clump: [0.32, 0.6] as [number, number],
};

/** 0..1: the wrack line's weight at world (x, z), on ground `y` m over the sea; `spread` widens its band */
export function wrackAt(x: number, z: number, y: number, spread = 1): number {
  const mid = WRACK.height + 2 * WRACK.wander * (fbm2Cpu(x / WRACK.wanderScale + 7.3, z / WRACK.wanderScale, 2) - 0.5);
  const band = Math.exp(-(((y - mid) / (WRACK.half * spread)) ** 2));
  return band * smooth(WRACK.clump[0], WRACK.clump[1], fbm2Cpu(x / WRACK.clumpScale + 1.9, z / WRACK.clumpScale, 3));
}

/** rad: the angle a piece spans from the eye (its largest extent over its distance) below which it is gone, and
 * above which it is whole; between, it sinks away into the sand (see the header) */
export const COVERAGE = { gone: 0.0045, full: 0.0065 };
/** each piece leaves at its own coverage, COVERAGE × 1 … this (log-uniform): the scatter thins out with distance,
 * one piece after another, instead of all of them shrinking at one distance — with one threshold, the far edge of
 * what is drawn was a line across the beach, behind it bare sand */
const FADE_SPREAD = 2.2;

/** THE SWASH'S UPPER LIMIT: m over the sea (the lagoon's run-up reaches ~0.5 m up the face, sea.ts FILM_TERRAIN, on
 * a swell of ~0.13 m), its wander and its half-width in height (~1 m across the 1:11 face) */
const LIMIT = { height: 0.62, wander: 0.06, half: 0.07 };
/** m over the sea under which the waves rework the sand: almost nothing lies there */
const SWASH: [number, number] = [0.4, 0.52];
/** m inland (coast.ts `inland`: the vegetation line's own wander included) over which the scrub's litter takes over */
const VEG: [number, number] = [14, 22];


type Name = 'pebble' | 'cobble' | 'stick' | 'shell' | 'conch' | 'leaf' | 'twig';
type Pose = 'tumble' | 'flat' | 'lie';
interface Kind {
  file: string;
  /** m: the instance's largest extent */
  size: [number, number];
  /** pieces per m²: on the open sand, at the swash limit's middle, on the wrack line's (before the patches) */
  per: { open: number; limit: number; wrack: number };
  /** pieces in a group, least and most, within `spread` m of the first */
  group: [number, number];
  spread: number;
  /** share of its own height sunk into the sand */
  sink: [number, number];
  pose: Pose;
  /** for 'tumble': its height squashed by (and its width stretched by up to 1/squash^0.4) */
  squash?: [number, number];
  /** for 'flat': the share turned over (a shell cup-up) */
  flip?: number;
  /** the scan's colour taken toward its luminance (0 grey … 1 its own) and normalised by its mean luminance, then
   * one of `tints` (linear albedo, weighted) per instance, varied ±`vary` */
  sat: number;
  lum: number;
  tints: Array<[number, number, number, number]>;
  vary: number;
  /** its file carries an ARM map (Poly Haven): the ambient occlusion in its red */
  arm: boolean;
}

/** coral, worn: cream, white, weathered grey, a pink of coralline algae (§12.4: the sand itself is #e6d9c1 sunlit;
 * a fragment of coral lies whiter on it) */
const CORAL: Kind['tints'] = [
  [0.62, 0.58, 0.5, 0.5],
  [0.7, 0.68, 0.62, 0.25],
  [0.46, 0.45, 0.42, 0.1],
  [0.62, 0.51, 0.47, 0.15],
];
// (the densities: the first pass (2026-10-29) had 3–10× these, spread evenly and drawn down to 1.2 mrad — "too
// regular, too much; it just adds noise at the far end", and its bleached sticks read as "little bones": now rare;
// fewer and larger near the eye, the open sand nearly bare, the lines carrying it)
const KINDS: Record<Name, Kind> = {
  pebble: {
    file: 'namaqualand_boulder_05/namaqualand_boulder_05_pebble.glb',
    // (no 3 cm crumbs: sunk by half and squashed, one shows a centimetre of itself, a speck from the walk)
    size: [0.05, 0.12],
    per: { open: 0.08, limit: 6, wrack: 1.5 },
    group: [1, 5],
    spread: 0.45,
    sink: [0.3, 0.55],
    pose: 'tumble',
    squash: [0.45, 0.95],
    // (the scan's mean linear luminance, 0.288: the colour normalised to it before the coral tint)
    sat: 0.2,
    lum: 0.288,
    tints: CORAL,
    vary: 0.12,
    arm: true,
  },
  cobble: {
    file: 'namaqualand_boulder_05/namaqualand_boulder_05_beach.glb',
    size: [0.08, 0.18],
    per: { open: 0.006, limit: 0.06, wrack: 0.06 },
    group: [1, 2],
    spread: 0.5,
    sink: [0.35, 0.55],
    pose: 'tumble',
    squash: [0.5, 0.85],
    sat: 0.2,
    lum: 0.288,
    tints: CORAL,
    vary: 0.1,
    arm: true,
  },
  stick: {
    file: 'dead_quiver_branch_01/dead_quiver_branch_01_beach.glb',
    size: [0.08, 0.24],
    per: { open: 0.001, limit: 0.01, wrack: 0.04 },
    group: [1, 1],
    spread: 0,
    sink: [0.2, 0.4],
    pose: 'lie',
    // (weathered grey-brown, not bone: the first pass's bone-white Y shapes read as bones)
    sat: 0.25,
    lum: 0.174,
    tints: [
      [0.5, 0.47, 0.42, 0.6],
      [0.38, 0.36, 0.33, 0.4],
    ],
    vary: 0.1,
    arm: true,
  },
  shell: {
    file: 'ShellSet001/shellset_beach.glb',
    size: [0.05, 0.09],
    per: { open: 0.04, limit: 4, wrack: 1 },
    group: [1, 4],
    spread: 0.4,
    sink: [0.1, 0.45],
    pose: 'flat',
    flip: 0.25,
    sat: 1,
    lum: 1,
    tints: [[1, 1, 1, 1]],
    vary: 0.12,
    arm: false,
  },
  conch: {
    file: 'lambis_shell/lambis_shell_beach.glb',
    size: [0.11, 0.15],
    per: { open: 0.003, limit: 0.01, wrack: 0.01 },
    group: [1, 1],
    spread: 0,
    sink: [0.15, 0.3],
    pose: 'flat',
    flip: 0.3,
    sat: 1,
    lum: 1,
    tints: [[1, 1, 1, 1]],
    vary: 0.08,
    arm: true,
  },
  leaf: {
    file: 'dry_quiver_leaf/dry_quiver_leaf_beach.glb',
    size: [0.1, 0.24],
    per: { open: 0.008, limit: 0.01, wrack: 2.5 },
    group: [1, 3],
    spread: 0.35,
    sink: [0.1, 0.3],
    pose: 'lie',
    // (dried leaves and seagrass at the tide line: brown-grey, darker than the scan's karoo tan)
    sat: 0.6,
    lum: 1,
    tints: [
      [0.72, 0.64, 0.56, 0.5],
      [0.48, 0.44, 0.4, 0.5],
    ],
    vary: 0.12,
    arm: true,
  },
  twig: {
    file: 'dry_branches_medium_01/dry_branches_medium_01_beach.glb',
    size: [0.15, 0.45],
    per: { open: 0.005, limit: 0.01, wrack: 0.6 },
    group: [1, 2],
    spread: 0.4,
    sink: [0.15, 0.35],
    pose: 'flat',
    // (sun-greyed: the scan's forest-floor twigs are near black, 0.07)
    sat: 0.7,
    lum: 1,
    tints: [
      [2.6, 2.5, 2.4, 0.6],
      [1.9, 1.85, 1.8, 0.4],
    ],
    vary: 0.15,
    arm: true,
  },
};

/** m: kept clear round the walked line (and, for anything over CLEAR_SMALL, the wider berth) */
const CLEAR = 0.5;
const CLEAR_BIG = 1.1;
const CLEAR_SMALL = 0.08;
/** m along the beach a tile of instances spans (one InstancedMesh per kind, piece and tile) */
const TILE = 40;
/** the stretch dressed, m along the beach (beats.ts: −z) and m inland of the still waterline */
const ALONG: [number, number] = [-90, 170];
const INLAND: [number, number] = [-1, 30];

/** THE CONTACT FOOTPRINT: its quad's half-size over the piece's own outline on the ground, its darkness (the
 * share of the light under it taken away at its middle) for a flat piece and how much more per unit of height over
 * width, and the lip's brightening. (At 1.6× and 0.22 it hid under the piece: only drawn 4× larger, as a test, did
 * the footprints show at all; now ~0.3 of the light is gone at the piece's outline, fading out by ~1.9× it) */
const FOOT = { spread: 2.2, dark: 0.35, tall: 0.4, darkMax: 0.7, lip: 0.04 };
/** m the footprint floats over the sand (with a depth offset): the terrain mesh is ground() at half-metre vertices */
const FOOT_LIFT = 0.008;
/** linear albedo of the dry sand (beachMaterial.ts's dry layer, measured): what clings to a piece's foot */
const SAND: [number, number, number] = [0.52, 0.43, 0.34];

export interface BeachDressing {
  readonly group: THREE.Group;
  readonly ready: Promise<void>;
  /** per frame: the eye the pieces fade by (world m) */
  setEye(eye: THREE.Vector3): void;
}

/** the beach dressed: `ground` its height (m over the sea) at world x, z; `beach` the waterline at the walk's middle
 * (beats.ts); `inland` m inland of the shore (coast.ts, the vegetation line's wander in it); `palms` the palms' feet
 * (world x, z) */
export interface DressingSite {
  ground: (x: number, z: number) => number;
  beach: { x: number; z: number };
  inland: (x: number, z: number) => number;
  palms: Array<[number, number]>;
}
export type DressingKind = Name;
/** one thing on the sand: world x, z; its largest extent s (m); `fade`, its own share of COVERAGE (1 … FADE_SPREAD:
 * it leaves at that many times the coverage of the least); which piece of its file (0..1); its turn before the
 * slope's; its squash and stretch; the share of its height sunk; its tint (linear) */
export interface DressingPlace {
  x: number;
  z: number;
  s: number;
  fade: number;
  piece: number;
  q: THREE.Quaternion;
  squash: number;
  stretch: number;
  sink: number;
  tint: THREE.Color;
}

/** the eye's path (beats.ts: the coast keys are in beach coordinates, the same for any c1End), world x, y, z every
 * ~0.4 m, and whether it is walked (ashore, at eye height: the glide, not w5–w6's rise) */
export function eyePath(beach: { x: number; z: number }, ground: (x: number, z: number) => number): Array<[number, number, number, boolean]> {
  const path: Array<[number, number, number, boolean]> = [];
  const { starts, total } = beatStarts(0);
  for (let t = starts.w1; t <= total; t += 0.2) {
    const c = coastEye(t, 0, beach);
    const last = path[path.length - 1];
    if (last && Math.hypot(c.x - last[0], c.z - last[2]) < 0.4 && t + 0.2 <= total) continue;
    const g = Math.max(0, ground(c.x, c.z));
    const ashore = c.ashore > 0.5;
    // (afloat, the raft's deck carries the eye ~1.6 m over the sea)
    path.push([c.x, ashore ? g + c.height : 1.6, c.z, ashore && c.height < 2.5]);
  }
  return path;
}

/** where every thing lies (seeded: the same beach every run), per kind — the placement alone, no assets */
export function placeBeachDressing(o: DressingSite): Record<DressingKind, DressingPlace[]> {
  const { ground, beach } = o;
  const r = rng(9157);

  // THE STILL WATERLINE along the beach, off (m out to sea) where the ground crosses 0: a table a metre apart
  const wl: number[] = [];
  for (let a = ALONG[0]; a <= ALONG[1] + 1; a++) {
    let lo = -60;
    let hi = 160;
    for (let i = 0; i < 32; i++) {
      const mid = (lo + hi) / 2;
      if (ground(beach.x - mid, beach.z - a) > 0) lo = mid;
      else hi = mid;
    }
    wl.push((lo + hi) / 2);
  }
  const waterline = (along: number): number => {
    const f = Math.min(wl.length - 1.001, Math.max(0, along - ALONG[0]));
    const i = Math.floor(f);
    return wl[i] + (wl[i + 1] - wl[i]) * (f - i);
  };

  const path = eyePath(beach, ground);
  /** m from (x, y, z) to the nearest point of the path, and horizontally to the nearest walked one */
  const toPath = (x: number, y: number, z: number): { seen: number; walked: number } => {
    let seen = Infinity;
    let walked = Infinity;
    for (const [px, py, pz, w] of path) {
      const h2 = (px - x) ** 2 + (pz - z) ** 2;
      seen = Math.min(seen, h2 + (py - y) ** 2);
      if (w) walked = Math.min(walked, h2);
    }
    return { seen: Math.sqrt(seen), walked: Math.sqrt(walked) };
  };
  // (a coarse horizontal distance to the path, 2 m cells, to skip candidates too far to see before the ground is
  // evaluated for them)
  const CELL = 2;
  const nA = Math.ceil((ALONG[1] - ALONG[0]) / CELL) + 1;
  const nS = Math.ceil((INLAND[1] - INLAND[0]) / CELL) + 1;
  const near = new Float32Array(nA * nS);
  for (let i = 0; i < nA; i++) {
    const along = ALONG[0] + i * CELL;
    for (let j = 0; j < nS; j++) {
      const x = beach.x - (waterline(along) - (INLAND[0] + j * CELL));
      const z = beach.z - along;
      let d = Infinity;
      for (const [px, , pz] of path) d = Math.min(d, (px - x) ** 2 + (pz - z) ** 2);
      near[i * nS + j] = Math.sqrt(d) - CELL;
    }
  }
  const nearAt = (along: number, sf: number): number => near[Math.round((along - ALONG[0]) / CELL) * nS + Math.round((sf - INLAND[0]) / CELL)];

  /** the zones' weights at world (x, z) on ground h */
  const zones = (x: number, z: number, h: number): { open: number; limit: number; wrack: number } => {
    // (in the swash 3% of the density above it)
    const keep = (0.03 + 0.97 * smooth(SWASH[0], SWASH[1], h)) * (1 - 0.85 * smooth(VEG[0], VEG[1], o.inland(x, z)));
    const mid = LIMIT.height + 2 * LIMIT.wander * (fbm2Cpu(x / 17 + 3.1, z / 17, 2) - 0.5);
    // (the limit's line is clumped too: thick here, a few shells there)
    const limit = Math.exp(-(((h - mid) / LIMIT.half) ** 2)) * (0.3 + 1.4 * smooth(0.35, 0.7, fbm2Cpu(x / 5.3 + 11, z / 5.3, 3)));
    return { open: keep * smooth(SWASH[0], SWASH[1] + 0.1, h), limit: keep * limit, wrack: keep * wrackAt(x, z, h, 1.5) };
  };

  // THE PLACEMENTS, per kind: group seeds uniform over the stretch at the kind's highest density (over its mean
  // group), each kept at its own density's share of that; each seed a group of pieces round it, every piece kept if
  // it is seen large enough from the path and is clear of the walk, the walkers and the palms
  const placed: Record<Name, DressingPlace[]> = { pebble: [], cobble: [], stick: [], shell: [], conch: [], leaf: [], twig: [] };
  const area = (ALONG[1] - ALONG[0]) * (INLAND[1] - INLAND[0]);
  for (const name of Object.keys(KINDS) as Name[]) {
    const k = KINDS[name];
    const meanGroup = (k.group[0] + k.group[1]) / 2;
    const top = Math.max(k.per.open, k.per.limit * 1.7, k.per.wrack);
    const n = Math.round((top / meanGroup) * area);
    const reach = k.size[1] / COVERAGE.gone + k.spread;
    const tw = k.tints.reduce((s, t) => s + t[3], 0);
    for (let i = 0; i < n; i++) {
      const along = ALONG[0] + (ALONG[1] - ALONG[0]) * r();
      const sf = INLAND[0] + (INLAND[1] - INLAND[0]) * r();
      const u = r();
      if (nearAt(along, sf) > reach) continue;
      const x0 = beach.x - (waterline(along) - sf);
      const z0 = beach.z - along;
      const h0 = ground(x0, z0);
      if (h0 < 0.05) continue;
      const w = zones(x0, z0, h0);
      if (u * top > k.per.open * w.open + k.per.limit * w.limit + k.per.wrack * w.wrack) continue;
      const count = k.group[0] + Math.floor(r() * (k.group[1] - k.group[0] + 1));
      for (let j = 0; j < count; j++) {
        // (the group's first at the seed, the rest scattered round it, closer more often than not)
        const a = 2 * Math.PI * r();
        const rad = j === 0 ? 0 : k.spread * Math.sqrt(r()) * (0.25 + 0.75 * r());
        const x = x0 + Math.cos(a) * rad;
        const z = z0 + Math.sin(a) * rad;
        const v = r();
        const s = k.size[0] + (k.size[1] - k.size[0]) * v * v;
        const h = j === 0 ? h0 : ground(x, z);
        if (h < SWASH[0] && j > 0) continue;
        const d = toPath(x, h, z);
        const fade = Math.exp(Math.log(FADE_SPREAD) * r());
        if (s / fade / d.seen < COVERAGE.gone) continue;
        if (d.walked < (s > CLEAR_SMALL ? CLEAR_BIG : CLEAR)) continue;
        // the wanderers' path (props.ts: off −5.3 ± 1, from along ~4 on)
        const off = beach.x - x;
        const al = beach.z - z;
        if (s > 0.06 && al > 3 && off > -6.6 && off < -4) continue;
        if (o.palms.some(([px, pz]) => (px - x) ** 2 + (pz - z) ** 2 < 0.7 * 0.7)) continue;
        // its turn: tumbled any way, or lying on its belly (turned over, a share), or a long thing laid on its side
        const q = new THREE.Quaternion();
        if (k.pose === 'tumble') {
          // (uniform over all turns, Shoemake)
          const ua = r();
          const ub = 2 * Math.PI * r();
          const uc = 2 * Math.PI * r();
          q.set(Math.sqrt(1 - ua) * Math.sin(ub), Math.sqrt(1 - ua) * Math.cos(ub), Math.sqrt(ua) * Math.sin(uc), Math.sqrt(ua) * Math.cos(uc));
        } else if (k.pose === 'lie') {
          // (the scan stands along y: laid along z, rolled about its length)
          q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 2 * Math.PI * r()).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2));
          q.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (r() - 0.5) * 0.5));
        } else if (r() < (k.flip ?? 0)) q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
        q.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 2 * Math.PI * r()));
        const squash = k.squash ? k.squash[0] + (k.squash[1] - k.squash[0]) * r() : 1;
        let pick = r() * tw;
        const t = k.tints.find((c) => (pick -= c[3]) < 0) ?? k.tints[0];
        const g = 1 + k.vary * (2 * r() - 1);
        placed[name].push({
          x,
          z,
          s,
          fade,
          piece: r(),
          q,
          squash,
          stretch: 1 / Math.sqrt(squash) ** (r() * 0.8),
          sink: k.sink[0] + (k.sink[1] - k.sink[0]) * r(),
          tint: new THREE.Color(t[0] * g, t[1] * g, t[2] * g),
        });
      }
    }
  }
  return placed;
}

/** the dressing of our beach (placeBeachDressing), its scans loaded from `base` and instanced, each piece with its
 * contact footprint */
export function createBeachDressing(o: DressingSite & { base?: string }): BeachDressing {
  const { ground, beach } = o;
  const base = o.base ?? `${import.meta.env.BASE_URL}drift/pbr/`;
  const group = new THREE.Group();
  group.name = 'drift-beach-dressing';
  const placed = placeBeachDressing(o);

  // THE FADE BY COVERAGE, from the eye (a uniform, so the shadow pass fades with it — its own camera is the Sun's):
  // per instance `anchor` = its foot on the sand (world x, y, z) and its size (m) over its own `fade`
  const eye = uniform(new THREE.Vector3(beach.x, 2, beach.z));
  // (on the group for a review probe: the eye the pieces last faded by)
  group.userData.eye = eye.value;
  const fadeOf = (anchor: V4): F => smoothstep(COVERAGE.gone, COVERAGE.full, anchor.w.div(eye.sub(anchor.xyz).length().max(0.05))) as F;

  /** a scan's material as a node material: its colour taken toward coral's, beach's or the wrack's (× the
   * instance's `tint`), sand on its foot, its own normal and roughness; it sinks into the sand at its foot as it
   * fades */
  const made = new Map<string, THREE.MeshStandardNodeMaterial>();
  const material = (src: THREE.MeshStandardMaterial, k: Kind): THREE.MeshStandardNodeMaterial => {
    const key = `${src.uuid}:${k.sat}:${k.lum}`;
    const had = made.get(key);
    if (had) return had;
    const m = new THREE.MeshStandardNodeMaterial({
      normalMap: src.normalMap,
      // (GLTFLoader flips its y for meshes without tangents, as all of these are: carried over, or the bumps invert)
      normalScale: src.normalScale,
      roughnessMap: src.roughnessMap,
      // (the Poly Haven files' ARM map carries the occlusion in its red; the shells' roughness map is roughness only)
      aoMap: k.arm ? (src.aoMap ?? src.roughnessMap) : null,
      // (half of it: the scans' occlusion is a whole object's, and a pebble's shaded side, all a low Sun ahead shows,
      // went near black under it)
      aoMapIntensity: 0.5,
      roughness: src.roughness,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    const anchor = attribute('anchor', 'vec4') as V4;
    const tint = attribute('tint', 'vec3') as V3;
    m.positionNode = anchor.xyz.add(positionLocal.sub(anchor.xyz).mul(fadeOf(anchor)));
    const c = texture(src.map!).rgb;
    const lum = c.dot(vec3(0.2126, 0.7152, 0.0722));
    const own = mix(vec3(lum), c, k.sat).div(k.lum).mul(tint);
    // (sand on its foot: from its burial line up a few millimetres, more on a bigger piece — at a centimetre and more
    // it covered nearly all a sunk pebble shows, ~1–2 cm, and the pale coral read as brown sand)
    const over = positionWorld.y.sub(anchor.y);
    const sanded = float(1).sub(smoothstep(0.001, anchor.w.mul(0.04).add(0.003), over)).mul(0.5);
    m.colorNode = mix(own, vec3(...SAND), sanded);
    m.name = `drift-beach-${src.name}`;
    made.set(key, m);
    return m;
  };

  // THE CONTACT FOOTPRINT's material: multiplied into what is already drawn (dst × 2·src, so 0.5 leaves it), never
  // writing depth, a hair in front of the sand
  const foot = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false, toneMapped: false });
  foot.blending = THREE.CustomBlending;
  foot.blendEquation = THREE.AddEquation;
  foot.blendSrc = THREE.DstColorFactor;
  foot.blendDst = THREE.SrcColorFactor;
  foot.blendEquationAlpha = THREE.AddEquation;
  foot.blendSrcAlpha = THREE.ZeroFactor;
  foot.blendDstAlpha = THREE.OneFactor;
  foot.polygonOffset = true;
  foot.polygonOffsetFactor = -2;
  foot.polygonOffsetUnits = -2;
  {
    const anchor = attribute('anchor', 'vec4') as V4;
    const strength = attribute('contact', 'float') as F;
    const p = uv().mul(2).sub(1);
    // (1 at the piece's own outline)
    const rp = p.length().mul(FOOT.spread);
    const dark = strength.mul(float(1).sub(smoothstep(0.6, 1.9, rp)).pow(1.5));
    const lip = rp.sub(1.15).div(0.14);
    const ridge = exp(lip.mul(lip).negate()).mul(FOOT.lip);
    const f = fadeOf(anchor);
    foot.colorNode = vec3(float(1).sub(dark).add(ridge).sub(1).mul(f).add(1).mul(0.5));
    foot.name = 'drift-beach-contact';
  }
  const quad = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);

  const loader = new GLTFLoader();
  const up = new THREE.Vector3(0, 1, 0);
  const nrm = new THREE.Vector3();
  const tilt = new THREE.Quaternion();
  const turn = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const p = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  const files = new Map<string, Promise<THREE.Group>>();
  /** the footprints by tile: matrices, anchors, strengths */
  const feet = new Map<number, { m: THREE.Matrix4[]; a: number[]; k: number[] }>();
  /** a geometry of `geo`'s own attributes (shared) with per-instance ones of its own */
  const withInstanced = (geo: THREE.BufferGeometry, extra: Record<string, [Float32Array, number]>): THREE.BufferGeometry => {
    const g = new THREE.BufferGeometry();
    for (const [n, a] of Object.entries(geo.attributes)) g.setAttribute(n, a);
    g.setIndex(geo.index);
    for (const [n, [arr, size]] of Object.entries(extra)) g.setAttribute(n, new THREE.InstancedBufferAttribute(arr, size));
    return g;
  };
  const ready = Promise.all(
    (Object.keys(KINDS) as Name[])
      .filter((name) => placed[name].length)
      .map(async (name) => {
        const k = KINDS[name];
        if (!files.has(k.file)) files.set(k.file, loader.loadAsync(base + k.file).then((g) => g.scene));
        const scene = await files.get(k.file)!;
        scene.updateMatrixWorld(true);
        // its pieces (a file of several: the nine shells, the two leaves, the three twigs), each centred on its own
        // box, with a sample of its vertices to seat it by
        const pieces: Array<{ geo: THREE.BufferGeometry; mat: THREE.Material; extent: number; verts: THREE.Vector3[] }> = [];
        scene.traverse((m) => {
          const mesh = m as THREE.Mesh;
          if (!mesh.isMesh) return;
          const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
          geo.computeBoundingBox();
          const c = geo.boundingBox!.getCenter(new THREE.Vector3());
          geo.translate(-c.x, -c.y, -c.z);
          geo.computeBoundingBox();
          const size = geo.boundingBox!.getSize(new THREE.Vector3());
          const pos = geo.getAttribute('position') as THREE.BufferAttribute;
          const verts: THREE.Vector3[] = [];
          const step = Math.max(1, Math.floor(pos.count / 400));
          for (let i = 0; i < pos.count; i += step) verts.push(new THREE.Vector3().fromBufferAttribute(pos, i));
          pieces.push({ geo, mat: material(mesh.material as THREE.MeshStandardMaterial, k), extent: Math.max(size.x, size.y, size.z), verts });
        });
        // the instances, by piece and tile
        const lots = new Map<string, { piece: number; m: THREE.Matrix4[]; a: number[]; t: number[] }>();
        for (const pl of placed[name]) {
          const piece = Math.floor(pl.piece * pieces.length);
          const pc = pieces[piece];
          const s = pl.s / pc.extent;
          scale.set(s * pl.stretch, s * pl.squash, s);
          // on the ground's own slope
          const e = 0.3;
          nrm.set(ground(pl.x - e, pl.z) - ground(pl.x + e, pl.z), 2 * e, ground(pl.x, pl.z - e) - ground(pl.x, pl.z + e)).normalize();
          tilt.setFromUnitVectors(up, nrm);
          turn.copy(pl.q).premultiply(tilt);
          // seated: its lowest point `sink` of its height under the sand; and its outline on the ground (the
          // principal axes of its vertices' plan, their reach along each)
          let lo = Infinity;
          let hi = -Infinity;
          let mx = 0;
          let mz = 0;
          const plan: Array<[number, number]> = [];
          for (const v of pc.verts) {
            p.copy(v).multiply(scale).applyQuaternion(turn);
            lo = Math.min(lo, p.y);
            hi = Math.max(hi, p.y);
            plan.push([p.x, p.z]);
            mx += p.x;
            mz += p.z;
          }
          mx /= plan.length;
          mz /= plan.length;
          let cxx = 0;
          let czz = 0;
          let cxz = 0;
          for (const [x, z] of plan) {
            cxx += (x - mx) ** 2;
            czz += (z - mz) ** 2;
            cxz += (x - mx) * (z - mz);
          }
          const th = 0.5 * Math.atan2(2 * cxz, cxx - czz);
          const ux = Math.cos(th);
          const uz = Math.sin(th);
          let ea = 0;
          let eb = 0;
          for (const [x, z] of plan) {
            ea = Math.max(ea, Math.abs((x - mx) * ux + (z - mz) * uz));
            eb = Math.max(eb, Math.abs(-(x - mx) * uz + (z - mz) * ux));
          }
          ea = Math.max(ea, 0.3 * eb);
          eb = Math.max(eb, 0.3 * ea);
          const gy = ground(pl.x, pl.z);
          p.set(pl.x, gy - lo - pl.sink * (hi - lo), pl.z);
          const tile = Math.floor((beach.z - pl.z - ALONG[0]) / TILE);
          const key = `${piece}:${tile}`;
          if (!lots.has(key)) lots.set(key, { piece, m: [], a: [], t: [] });
          const lot = lots.get(key)!;
          lot.m.push(new THREE.Matrix4().compose(p, turn, scale));
          lot.a.push(pl.x, gy, pl.z, pl.s / pl.fade);
          lot.t.push(pl.tint.r, pl.tint.g, pl.tint.b);
          // its footprint, under its outline's middle, turned to its long axis and laid on the slope; darker the
          // more it stands up out of the sand for its width
          const showing = (hi - lo) * (1 - pl.sink);
          const strength = Math.min(FOOT.darkMax, FOOT.dark + (FOOT.tall * showing) / Math.sqrt(ea * eb));
          basis.makeBasis(new THREE.Vector3(ux, 0, uz), up, new THREE.Vector3(-uz, 0, ux));
          const fq = new THREE.Quaternion().setFromRotationMatrix(basis).premultiply(tilt);
          const fx = pl.x + mx;
          const fz = pl.z + mz;
          if (!feet.has(tile)) feet.set(tile, { m: [], a: [], k: [] });
          const ft = feet.get(tile)!;
          ft.m.push(new THREE.Matrix4().compose(new THREE.Vector3(fx, ground(fx, fz) + FOOT_LIFT, fz), fq, new THREE.Vector3(ea * FOOT.spread, 1, eb * FOOT.spread)));
          ft.a.push(pl.x, gy, pl.z, pl.s / pl.fade);
          ft.k.push(strength);
        }
        for (const [key, lot] of lots) {
          const pc = pieces[lot.piece];
          const geo = withInstanced(pc.geo, { anchor: [new Float32Array(lot.a), 4], tint: [new Float32Array(lot.t), 3] });
          const inst = new THREE.InstancedMesh(geo, pc.mat, lot.m.length);
          lot.m.forEach((m, i) => inst.setMatrixAt(i, m));
          inst.instanceMatrix.needsUpdate = true;
          inst.computeBoundingSphere();
          inst.castShadow = true;
          inst.receiveShadow = true;
          inst.name = `drift-beach-${name}-${key}`;
          group.add(inst);
        }
      }),
  ).then(() => {
    for (const [tile, ft] of feet) {
      const geo = withInstanced(quad, { anchor: [new Float32Array(ft.a), 4], contact: [new Float32Array(ft.k), 1] });
      const inst = new THREE.InstancedMesh(geo, foot, ft.m.length);
      ft.m.forEach((m, i) => inst.setMatrixAt(i, m));
      inst.instanceMatrix.needsUpdate = true;
      inst.computeBoundingSphere();
      inst.castShadow = false;
      inst.receiveShadow = false;
      inst.name = `drift-beach-contact-${tile}`;
      group.add(inst);
    }
  });
  return {
    group,
    ready,
    setEye(at) {
      eye.value.copy(at);
    },
  };
}
