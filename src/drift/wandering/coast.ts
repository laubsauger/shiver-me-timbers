/**
 * THE COAST FOR THE FILM (w1–w6), a set built for its shots in place of the game's archipelago (the user,
 * 2026-10-29: the landing's terrain "looks horrendous … aim for Unreal Engine level"). The game's showcase lagoon
 * island was a 128² heightmap — 4 m cells — of smooth sand domes, the scattered islands bare tan blocks, and its
 * seabed grid's square edge showed in the water. This is drawn on the references instead
 * (drift-narrative/references §12, tropical-coast-lagoon: Tubuai, Aitutaki, Bora Bora):
 *
 *   - OUR ISLAND is a MOTU, a low, long island on a lagoon's reef: a white beach on its lagoon side, a berm, the
 *     island behind it 2–3 m over the sea (its height is its trees: forest.ts), a sand flat a couple of metres
 *     deep running 300 m out to where the lagoon floor drops away, and a sandbar trailing off its point ahead;
 *   - ACROSS THE LAGOON, three more motus (wide low bands of trees on a white rim) and a HIGH ISLAND, an eroded
 *     volcano 7 km off: "from sea level, islands are low slivers" — Tubuai spans 63° and peaks 3.2° up (§12.6).
 *   - ON THE HIGH ISLAND'S SUMMIT, a guyed radio mast with one red lamp still blinking (radioTower.ts): the hill was
 *     a mountaintop over a drowned coast, not a tropical island (the user, 2026-10-29: the first sunken-world cue).
 *
 * Every shape is a pure function of position, built once: its own terrain meshes on the game's terrain material
 * (the scanned beach through `hooks`, the swash, the wet sand, the water light over the shallows, the haze), and
 * the seabed the ocean reads (its shallows tint, its shoaling) from the same functions, so the drawn floor and the
 * shaded depth are one surface.
 *
 * Beach coordinates (beats.ts COAST): `along` up the beach toward −z, `off` out to sea toward −x, from `beach`,
 * the waterline at the middle of the walk.
 */
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { createIslandMaterials, type IslandMaterials } from '../../island/islandMaterials';
import type { IslandFrame } from '../../island/island';
import type { SeabedField } from '../../island/seabed';
import type { WaterLevelFn } from '../../island/archipelago';
import type { TerrainBlendHooks } from '../../terrain/sandMaterial';
import type { AerialUniforms } from '../../terrain/aerialPerspective';
import { fbm2Cpu, gradNoise2Cpu } from '../../terrain/noiseCpu';
import { createRadioTower, summitOf } from './radioTower';

type Keys = Array<[number, number]>;

/** a monotone cubic through hand-drawn keys (Fritsch–Carlson: no overshoot between them), flat past the ends */
export function monotone(keys: Keys): (x: number) => number {
  const n = keys.length;
  const xs = keys.map((k) => k[0]);
  const ys = keys.map((k) => k[1]);
  const d = xs.slice(1).map((x, i) => (ys[i + 1] - ys[i]) / (x - xs[i]));
  const m = xs.map((_, i) => (i === 0 ? d[0] : i === n - 1 ? d[n - 2] : d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2));
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const smooth = (a: number, b: number, x: number): number => {
  const k = clamp01((x - a) / (b - a));
  return k * k * (3 - 2 * k);
};
/** polynomial smooth minimum (k m): two shores meeting at a spit round off instead of creasing */
const smin = (a: number, b: number, k: number): number => {
  const h = clamp01(0.5 + (0.5 * (b - a)) / k);
  return b + (a - b) * h - k * h * (1 - h);
};
const bell = (x: number, w: number): number => Math.exp(-(x * x) / (w * w));

/** m: the lagoon's floor between the islands (its deep blue band, §12.3), and the open sea's beyond the reef */
const LAGOON_FLOOR = -24;
const OPEN_FLOOR = -200;
/** m: the seabed field's square, from the beach (its origin corner, its side); the reef REEF_IN m inside its edge,
 * the floor dropping to the ocean's over REEF_DROP m past it */
const SEABED_ORIGIN: [number, number] = [-2600, -4200];
const SEABED_SIZE = 5600;
const REEF_IN = 500;
const REEF_DROP = 250;

/**
 * A MOTU in its own frame: `along` its length, `off` out across its lagoon-side beach. Its lagoon shore runs at
 * off = `shore(along)`, its ocean shore `width(along)` inland of that; between them the ground is the nearer
 * shore's profile, `front` (m inland of the waterline → height) on the lagoon side, `back` on the ocean's. Past
 * its tips the width goes negative and the two profiles meet under water: a sandbar sinking away.
 */
interface MotuShape {
  shore: (along: number) => number;
  width: (along: number) => number;
  front: (s: number) => number;
  back: (s: number) => number;
  /** m: the island's own relief (hummocks, the berm's wander, the beach cusps) at (along, off, s front, s back) */
  detail?: (along: number, off: number, sf: number, sb: number) => number;
}

function motuHeight(m: MotuShape, along: number, off: number): number {
  const w = m.shore(along);
  const sf = w - off;
  const sb = off - (w - m.width(along));
  const h = smin(m.front(sf), m.back(sb), 0.8);
  return h + (m.detail ? m.detail(along, off, sf, sb) : 0);
}

/**
 * OUR ISLAND. Its lagoon-side profile, m inland of the waterline → m over the sea (§12.2–4: a sand flat a couple
 * of metres deep out to the lagoon's drop; a beach face of about 1:11; the berm a metre and a half up; the island
 * behind it under 3 m).
 */
const OURS_FRONT = monotone([
  [-430, LAGOON_FLOOR],
  [-345, -17],
  [-305, -5.5],
  [-275, -2.9],
  [-180, -2.45],
  [-90, -1.95],
  [-36, -1.2],
  [-12, -0.66],
  [-5, -0.36],
  [0, 0],
  [7, 0.6],
  [14, 1.17],
  [19, 1.5],
  [23, 1.46],
  // the beach ridge the scrub holds, rising out of the sand at the vegetation line (the user, 2026-10-29: the
  // ground there read "too straight up flat")
  [30, 2.05],
  [38, 2.45],
  [56, 2.6],
  [110, 2.9],
  [400, 3.05],
]);
/** the ocean side, behind the island: a steeper, narrower shore onto the outer reef */
const OURS_BACK = monotone([
  [-220, -38],
  [-120, -14],
  [-60, -3],
  [-18, -0.9],
  [0, 0],
  [9, 1.1],
  [18, 2.3],
  [40, 2.8],
  [300, 3.05],
]);
/** off of the lagoon shore along the island: nearly straight along the walk, curving out to a point ahead */
const OURS_SHORE = monotone([
  [-1100, 20],
  [-750, -22],
  [-420, -24],
  [-220, -9],
  [-60, 0],
  [60, 2],
  [170, 15],
  [300, 42],
  [440, 72],
  [700, 120],
]);
/** m across, lagoon shore to ocean shore: its tips at −1000 and +440, the sandbar sinking away past the point */
const OURS_WIDTH = monotone([
  [-1150, -120],
  [-1000, 0],
  [-930, 130],
  [-700, 260],
  [-250, 300],
  [100, 285],
  [300, 165],
  [440, 0],
  [560, -60],
  [800, -240],
]);
const OURS: MotuShape = {
  shore: OURS_SHORE,
  width: OURS_WIDTH,
  front: OURS_FRONT,
  back: OURS_BACK,
  detail: (along, off, sf, sb) => {
    let h = 0;
    // BEACH CUSPS: the swash scallops the face every ~24 m, the waterline wandering a metre in and out
    h += 0.11 * Math.sin((2 * Math.PI * along) / 24 + 0.35 * Math.sin(along / 57)) * bell(sf - 3.5, 5);
    // the berm's crest wanders along the beach
    h += 0.22 * (fbm2Cpu(along / 45, 3.7, 3) - 0.5) * bell(sf - 19, 7);
    // the island's hummocks, under its trees
    h += 1.3 * (fbm2Cpu(along / 50, off / 50, 4) - 0.5) * smooth(28, 75, Math.min(sf, sb));
    // THE OPEN BEACH'S OWN RELIEF (the user, 2026-10-29: the dry sand above the berm ran "super straight and
    // entirely perfectly flat"): low swells of blown sand, longer along the shore than across it, rising behind the
    // berm (kept off the walk's line, ~8 m in, so the eye does not bob), and the berm itself higher here, lower there
    const dry = smooth(12, 24, sf) * (1 - smooth(70, 100, sf));
    h += dry * (1.3 * (fbm2Cpu(along / 26 + 5, off / 11, 3) - 0.5) + 0.35 * (fbm2Cpu(along / 7 + 2, off / 5, 2) - 0.5));
    h += smooth(6, 16, sf) * (1 - smooth(30, 50, sf)) * 0.6 * (fbm2Cpu(along / 90 + 21, 1.3, 2) - 0.5);
    // SAND MOUNDS round the scrub at the vegetation line (coppice dunes: blown sand held by the plants' feet,
    // half a metre high, a few metres across) and the ground's own unevenness there, roots and litter
    const band = smooth(15, 21, sf) * (1 - smooth(55, 80, sf));
    h += band * (1.25 * Math.max(0, fbm2Cpu(along / 5.5 + 40, off / 5.5, 3) - 0.45) + 0.12 * (fbm2Cpu(along / 1.6, off / 1.6 + 9, 2) - 0.5));
    // the sand flat's low waves and hollows, and where its edge drops into the lagoon
    const flat = smooth(-8, -40, sf) * (1 - smooth(-250, -300, sf));
    // (gentle: at ±0.27 m the flat's waves and hollows read as dark blotches and a sandbar the raft crossed coming
    // in, the 2026-10-29 review)
    h += 0.2 * (fbm2Cpu(along / 32 + 11, off / 32, 4) - 0.5) * flat;
    // (the flat's edge is never a ruled line: where it drops into the lagoon, it wanders)
    h += 5 * (fbm2Cpu(along / 90 + 3, 0.5, 3) - 0.5) * smooth(-270, -330, sf) * (1 - smooth(-380, -430, sf));
    return h;
  },
};

/** a far motu: a low, treed island on a white rim, its own sand flat round it */
function farMotu(length: number, width: number, seed: number): MotuShape {
  const front = monotone([
    [-160, LAGOON_FLOOR],
    [-110, -16],
    [-75, -3],
    [-40, -1.6],
    [-8, -0.6],
    [0, 0],
    [8, 0.8],
    [14, 1.4],
    [26, 1.8],
    [60, 2.6],
    [200, 2.9],
  ]);
  const half = length / 2;
  return {
    shore: (a) => 8 * Math.sin(a / 70 + seed),
    width: (a) => width * Math.sqrt(clamp01(1 - (a / half) ** 2)) - 120 * clamp01((Math.abs(a) - half) / 200),
    front,
    back: front,
    detail: (a, o, sf, sb) => 1.1 * (fbm2Cpu(a / 40 + seed * 7, o / 40, 3) - 0.5) * smooth(20, 60, Math.min(sf, sb)),
  };
}

/** the far islands across the lagoon, from the beach: bearing (deg right of the front), m away, the turn of
 * their long axis (deg), length and width m (§12.6: the motus wide, low bands) */
const FAR_MOTUS: Array<{ bearing: number; dist: number; turn: number; length: number; width: number; seed: number }> = [
  { bearing: -78, dist: 1450, turn: 20, length: 620, width: 150, seed: 1 },
  { bearing: -30, dist: 2600, turn: -15, length: 480, width: 120, seed: 2 },
  { bearing: 9, dist: 3500, turn: 70, length: 900, width: 170, seed: 3 },
];
/** the high island: bearing, distance (m), the turn of its long axis (deg), its half-extents (m) and peak (m) */
const HIGH = { bearing: -42, dist: 7400, turn: 25, rx: 3000, rz: 1700, peak: 430 };
/** m: the high island's air, an exponential haze over distance (§12.5: islands 10+ km off go sky-blue; at 7 km the
 * high island across the lagoon is blue-grey, not gone — the ocean's own haze, which the near land shares, is done
 * by its 4.6 km rim). Its ground (forest.ts createForestGround) and the radio tower on its summit melt on it alike. */
export const HIGH_AIR = 8500;

/**
 * THE HIGH ISLAND, an old eroded volcano: a dome of ridges round a summit, cut by stream-power erosion (D8 flow,
 * the implicit kernel of terrain/erosionStream.ts, without its sierra context) into valleys running to a narrow
 * coastal plain, and a fringing reef round it. Baked once on a grid in its own frame; sampled bilinearly.
 */
function bakeHighIsland(size: number, half: number): (x: number, z: number) => number {
  const cell = (2 * half) / (size - 1);
  const h = new Float64Array(size * size);
  for (let iz = 0; iz < size; iz++) {
    for (let ix = 0; ix < size; ix++) {
      const x = -half + ix * cell;
      const z = -half + iz * cell;
      const r = Math.hypot(x / HIGH.rx, z / HIGH.rz);
      // the summit a little off centre, ridges radiating, two shoulders
      const warp = 0.18 * gradNoise2Cpu(x / 900, z / 900).v;
      const rr = r + warp;
      const dome = Math.pow(clamp01(1 - rr), 1.5);
      const shoulder = 0.35 * Math.pow(clamp01(1 - Math.hypot((x - 1200) / 1300, (z + 300) / 900)), 1.3);
      const shoulder2 = 0.25 * Math.pow(clamp01(1 - Math.hypot((x + 1500) / 1000, (z - 400) / 800)), 1.4);
      const ridge = 1 - Math.abs(gradNoise2Cpu(x / 520 + 9, z / 520).v);
      const relief = (dome + shoulder + shoulder2) * (0.75 + 0.35 * ridge * ridge);
      h[iz * size + ix] = HIGH.peak * relief + 60 * (fbm2Cpu(x / 300, z / 300, 4) - 0.5) * dome;
    }
  }
  // STREAM-POWER EROSION: steepest-descent receivers, drainage area in descending height, the implicit update
  // ascending (unconditionally stable; a cell never cut under its outlet). Cells at sea level are base level.
  const n = size * size;
  const recv = new Int32Array(n);
  const area = new Float64Array(n);
  const order = new Int32Array(n);
  const K = 0.0011;
  const M = 0.5;
  for (let it = 0; it < 40; it++) {
    for (let i = 0; i < n; i++) {
      const ix = i % size;
      const iz = (i / size) | 0;
      let best = i;
      let drop = 0;
      if (h[i] > 0) {
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dz) continue;
            const jx = ix + dx;
            const jz = iz + dz;
            if (jx < 0 || jz < 0 || jx >= size || jz >= size) continue;
            const j = jz * size + jx;
            const s = (h[i] - h[j]) / (dx && dz ? Math.SQRT2 : 1);
            if (s > drop) {
              drop = s;
              best = j;
            }
          }
        }
      }
      recv[i] = best;
      area[i] = cell * cell;
      order[i] = i;
    }
    order.sort((a, b) => h[b] - h[a]);
    for (let k = 0; k < n; k++) {
      const i = order[k];
      if (recv[i] !== i) area[recv[i]] += area[i];
    }
    for (let k = n - 1; k >= 0; k--) {
      const i = order[k];
      const r = recv[i];
      if (r === i) continue;
      const C = (K * Math.pow(area[i], M)) / cell;
      h[i] = (h[i] + C * h[r]) / (1 + C);
    }
  }
  // the coastal plain and the fringing reef: the land's foot flattened to a few metres, a shallow flat round it
  for (let i = 0; i < n; i++) {
    const ix = i % size;
    const iz = (i / size) | 0;
    const x = -half + ix * cell;
    const z = -half + iz * cell;
    const r = Math.hypot(x / HIGH.rx, z / HIGH.rz);
    const plain = 3 + 3 * fbm2Cpu(x / 200, z / 200, 2);
    const lift = smooth(0.8, 0.97, r);
    const land = Math.max(0.5, h[i] * (1 - lift) + Math.min(h[i], plain) * lift);
    const sea = -1.8 - 28 * smooth(1.12, 1.3, r);
    const w = smooth(0.97, 1.03, r);
    h[i] = land * (1 - w) + sea * w;
  }
  return (x, z) => {
    const fx = Math.min(size - 1.001, Math.max(0, (x + half) / cell));
    const fz = Math.min(size - 1.001, Math.max(0, (z + half) / cell));
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const i = iz * size + ix;
    const a = h[i] + (h[i + 1] - h[i]) * tx;
    const b = h[i + size] + (h[i + size + 1] - h[i + size]) * tx;
    return a + (b - a) * tz;
  };
}

/** coordinates from lo to hi: `fine` apart inside [f0, f1], growing by `grow` a step outside it up to `coarse` */
export function graded(lo: number, hi: number, f0: number, f1: number, fine: number, coarse: number, grow = 1.08): number[] {
  const out: number[] = [];
  for (let x = f0; x < f1; x += fine) out.push(x);
  out.push(f1);
  let step = fine;
  for (let x = f1; x < hi; ) {
    step = Math.min(coarse, step * grow);
    x = Math.min(hi, x + step);
    out.push(x);
  }
  step = fine;
  for (let x = f0; x > lo; ) {
    step = Math.min(coarse, step * grow);
    x = Math.max(lo, x - step);
    out.unshift(x);
  }
  return out;
}

/** a terrain mesh over a tensor grid (u × v, each graded where the eye needs it), placed by `to` (u, v → world
 * x, z) and lifted by `height` (world x, z) */
function gridMesh(us: number[], vs: number[], to: (u: number, v: number, out: [number, number]) => void, height: (x: number, z: number) => number): THREE.BufferGeometry {
  const nu = us.length;
  const nv = vs.length;
  const pos = new Float32Array(nu * nv * 3);
  const xz: [number, number] = [0, 0];
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      to(us[i], vs[j], xz);
      const k = (j * nu + i) * 3;
      pos[k] = xz[0];
      pos[k + 1] = height(xz[0], xz[1]);
      pos[k + 2] = xz[1];
    }
  }
  const idx = new Uint32Array((nu - 1) * (nv - 1) * 6);
  let k = 0;
  for (let j = 0; j < nv - 1; j++) {
    for (let i = 0; i < nu - 1; i++) {
      const a = j * nu + i;
      const b = a + 1;
      const c = a + nu;
      const d = c + 1;
      idx[k++] = a;
      idx[k++] = c;
      idx[k++] = b;
      idx[k++] = b;
      idx[k++] = c;
      idx[k++] = d;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  // (a consistent winding: faces up whichever way `to` maps the grid)
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  if (n.getY(((nv >> 1) * nu + (nu >> 1)) | 0) < 0) {
    for (let t = 0; t < idx.length; t += 3) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]];
    g.getIndex()!.needsUpdate = true;
    g.computeVertexNormals();
  }
  g.computeBoundingSphere();
  return g;
}

export interface FilmCoast {
  readonly group: THREE.Group;
  /** the waterline at the middle of the walk (beats.ts COAST) */
  readonly beach: { x: number; z: number };
  /** our island's ground (m over the sea) at a world x, z */
  ground(x: number, z: number): number;
  /** every island's ground and the lagoon floor between them (m, negative under water) */
  heightAt(x: number, z: number): number;
  /** the floor the ocean shades its depth against */
  readonly seabed: SeabedField;
  readonly materials: IslandMaterials;
  /** resolves once the set's own models are in: the radio tower's (radioTower.ts) */
  readonly ready: Promise<void>;
  /** per frame: the terrain's light, haze, swash and the live sea level at our beach, and the tower's lamp */
  update(frame: Omit<IslandFrame, 'waterLevel'>, waterLevelAt: WaterLevelFn): void;
  /** the far islands: each one's world centre, its height function and its rough reach (m) — forest.ts grows
   * their trees */
  readonly islands: Array<{ name: string; box: { x: [number, number]; z: [number, number] }; heightAt: (x: number, z: number) => number; inland: (x: number, z: number) => number }>;
}

/**
 * The coast with its beach's waterline at `at` (world x, z), our island along −z from there, the lagoon to −x.
 * `hooks` is the ground (beachMaterial.ts); `high`, the high island's (forest.ts createForestGround: from 7 km its
 * ground is its forest).
 */
export function createFilmCoast(at: [number, number], hooks: TerrainBlendHooks, o: { high?: (haze: AerialUniforms['color']) => THREE.Material } = {}): FilmCoast {
  const [bx, bz] = at;
  const group = new THREE.Group();
  group.name = 'drift-coast';
  const materials = createIslandMaterials({ terrainHooks: hooks });
  const terrainMat = materials.terrain.material;

  // OUR ISLAND, in beach coordinates (along toward −z, off toward −x)
  const oursAt = (x: number, z: number): number => motuHeight(OURS, bz - z, bx - x);
  /** m inland of our nearer shore (forest.ts: where the trees may stand) */
  const oursInland = (x: number, z: number): number => {
    const along = bz - z;
    const off = bx - x;
    const w = OURS.shore(along);
    // (the vegetation line wanders: the scrub reaching ~7 m further down the beach here, holding back there — a
    // forest edge parallel to the waterline read as ruled, the same review)
    const wander = 14 * (fbm2Cpu(along / 80 + 3, 7.1, 3) - 0.5);
    return Math.min(w - off - wander, off - (w - OURS.width(along)));
  };

  // THE FAR ISLANDS, each in its own frame
  const place = (bearing: number, dist: number): [number, number] => {
    const b = (bearing * Math.PI) / 180;
    return [bx + Math.sin(b) * dist, bz - Math.cos(b) * dist];
  };
  const motus = FAR_MOTUS.map((f) => {
    const c = place(f.bearing, f.dist);
    const shape = farMotu(f.length, f.width, f.seed);
    const t = (f.turn * Math.PI) / 180;
    const ct = Math.cos(t);
    const st = Math.sin(t);
    // local: along its length (rotated off the world's −z by `turn`), off across it; centred on its middle
    const local = (x: number, z: number): [number, number] => {
      const dx = x - c[0];
      const dz = z - c[1];
      return [dx * st - dz * ct, -(dx * ct + dz * st) - f.width / 2];
    };
    // (and back: the rotation is its own inverse)
    const toWorld = (a: number, o2: number, out: [number, number]): void => {
      out[0] = c[0] + st * a - ct * o2;
      out[1] = c[1] - ct * a - st * o2;
    };
    return {
      f,
      c,
      heightAt: (x: number, z: number): number => {
        const [a, o] = local(x, z);
        return motuHeight(shape, a, o);
      },
      inland: (x: number, z: number): number => {
        const [a, o] = local(x, z);
        const w = shape.shore(a);
        return Math.min(w - o, o - (w - shape.width(a)));
      },
      toWorld,
      reach: f.length / 2 + 250,
      box: (() => {
        // the land's world box: its local corners, a little out
        const xs: number[] = [];
        const zs: number[] = [];
        const q: [number, number] = [0, 0];
        for (const a of [-f.length / 2 - 20, f.length / 2 + 20]) {
          for (const o2 of [-f.width / 2 - 30, f.width / 2 + 30]) {
            toWorld(a, o2, q);
            xs.push(q[0]);
            zs.push(q[1]);
          }
        }
        return { x: [Math.min(...xs), Math.max(...xs)] as [number, number], z: [Math.min(...zs), Math.max(...zs)] as [number, number] };
      })(),
    };
  });
  const hc = place(HIGH.bearing, HIGH.dist);
  const HALF = 4200;
  const highLocal = bakeHighIsland(512, HALF);
  const ht = (HIGH.turn * Math.PI) / 180;
  const highAt = (x: number, z: number): number => {
    const dx = x - hc[0];
    const dz = z - hc[1];
    return highLocal(dx * Math.cos(ht) + dz * Math.sin(ht), -dx * Math.sin(ht) + dz * Math.cos(ht));
  };

  /** the lagoon's floor, and past the reef the ocean's: the lagoon is the seabed field's square less REEF_IN m each
   * side, and the floor drops to OPEN_FLOOR over REEF_DROP m outside it (so the sea out there, and the clamped edge
   * of the field that the open sea's worlds kilometres away read, is deep water that no swell feels — the open sea
   * shoaled over a 24 m "lagoon" everywhere, and the raft's sea with it, the 2026-10-29 review) */
  const floorAt = (x: number, z: number): number => {
    const x0 = bx + SEABED_ORIGIN[0] + REEF_IN;
    const z0 = bz + SEABED_ORIGIN[1] + REEF_IN;
    const span = SEABED_SIZE - 2 * REEF_IN;
    const dx = Math.max(x0 - x, x - (x0 + span), 0);
    const dz = Math.max(z0 - z, z - (z0 + span), 0);
    return LAGOON_FLOOR + (OPEN_FLOOR - LAGOON_FLOOR) * smooth(0, REEF_DROP, Math.max(dx, dz));
  };
  /** the whole set's floor: the max of every island's (each sinks to the lagoon floor away from it) */
  const heightAt = (x: number, z: number): number => {
    const along = bz - z;
    const off = bx - x;
    const floor = floorAt(x, z);
    let h = along > -1150 && along < 800 && off > -560 && off < 470 ? Math.max(floor, oursAt(x, z)) : floor;
    for (const m of motus) {
      if (Math.abs(x - m.c[0]) < m.reach + 300 && Math.abs(z - m.c[1]) < m.reach + 300) h = Math.max(h, m.heightAt(x, z));
    }
    if (Math.abs(x - hc[0]) < HALF && Math.abs(z - hc[1]) < HALF) h = Math.max(h, highAt(x, z));
    return h;
  };

  const add = (g: THREE.BufferGeometry, name: string, shadows: boolean, material: THREE.Material = terrainMat): void => {
    const mesh = new THREE.Mesh(g, material);
    mesh.name = name;
    mesh.receiveShadow = true;
    mesh.castShadow = shadows;
    // §V10: the shore is an intersection-foam target, as the game's islands are
    mesh.userData.foamTarget = true;
    group.add(mesh);
  };
  // our island: half-metre cells where the eye walks and looks, coarser out to where the floor is deep
  {
    const us = graded(-1150, 800, -190, 170, 0.5, 6);
    const vs = graded(-560, 470, -55, 32, 0.4, 5);
    add(
      gridMesh(us, vs, (along, off, out) => ((out[0] = bx - off), (out[1] = bz - along)), (x, z) => Math.max(LAGOON_FLOOR, oursAt(x, z))),
      'coast-ours',
      true,
    );
  }
  // the far motus in their own frames: 2.5 m cells over the island and its rim, coarse out to the lagoon floor
  for (const m of motus) {
    const ha = m.f.length / 2;
    const hw = m.f.width / 2;
    const us = graded(-ha - 300, ha + 300, -ha - 40, ha + 40, 2.5, 12);
    const vs = graded(-hw - 260, hw + 260, -hw - 60, hw + 60, 2.5, 12);
    add(gridMesh(us, vs, m.toWorld, (x, z) => Math.max(LAGOON_FLOOR, m.heightAt(x, z))), 'coast-motu', false);
  }
  {
    const us = graded(hc[0] - HALF, hc[0] + HALF, hc[0] - 3600, hc[0] + 3600, 14, 30);
    const vs = graded(hc[1] - HALF, hc[1] + HALF, hc[1] - 3600, hc[1] + 3600, 14, 30);
    add(gridMesh(us, vs, (x, z, out) => ((out[0] = x), (out[1] = z)), (x, z) => Math.max(LAGOON_FLOOR - 16, highAt(x, z))), 'coast-high', false, o.high?.(materials.terrain.uniforms.aerial.color));
  }
  // THE RADIO TOWER on the high island's summit, its first leg's guys toward our beach (radioTower.ts): the summit is
  // the skyline from every eye of w1–w6 (radioTower.ts has the numbers), so the whole mast stands against the sky
  const summit = summitOf(highAt, hc, 3600);
  const tower = createRadioTower({ ground: highAt, at: [summit.x, summit.z], toward: [bx, bz], haze: materials.terrain.uniforms.aerial.color, air: HIGH_AIR });
  group.add(tower.group);

  // THE SEABED the ocean reads: the same floor, baked over the lagoon round our island and the near motus (5.6 km
  // square, 2.7 m texels; the high island's own shallows are too far to read), half-float, mipped (seabed.ts says
  // why)
  const RES = 2048;
  const SIZE = SEABED_SIZE;
  const origin: [number, number] = [bx + SEABED_ORIGIN[0], bz + SEABED_ORIGIN[1]];
  const cell = SIZE / RES;
  const data = new Uint16Array(RES * RES);
  for (let iz = 0; iz < RES; iz++) {
    const z = origin[1] + (iz + 0.5) * cell;
    for (let ix = 0; ix < RES; ix++) data[iz * RES + ix] = THREE.DataUtils.toHalfFloat(heightAt(origin[0] + (ix + 0.5) * cell, z));
  }
  const tex = new THREE.DataTexture(data, RES, RES, THREE.RedFormat, THREE.HalfFloatType);
  tex.name = 'drift/coastSeabed';
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  const seabed: SeabedField = {
    heightAt,
    depthAt: (x, z, waterY = 0) => Math.max(waterY - heightAt(x, z), 0),
    texture: tex,
    origin,
    size: SIZE,
    texelSize: cell,
    openHeight: OPEN_FLOOR,
    uniforms: { origin: uniform(new THREE.Vector2(origin[0], origin[1])), invSize: uniform(1 / SIZE) },
    dispose: () => tex.dispose(),
  };

  return {
    group,
    beach: { x: bx, z: bz },
    ground: oursAt,
    heightAt,
    seabed,
    materials,
    ready: tower.ready,
    islands: [
      { name: 'ours', box: { x: [bx - 75, bx + 335], z: [bz - 445, bz + 1005] }, heightAt: oursAt, inland: oursInland },
      ...motus.map((m, i) => ({ name: `motu${i + 1}`, box: m.box, heightAt: m.heightAt, inland: m.inland })),
    ],
    update(frame, waterLevelAt) {
      // the swash reads the live sea at our beach, where the eye is (the far islands' shores are too far to read)
      materials.update({ ...frame, waterLevel: waterLevelAt(bx - 10, bz) });
      // (the tower's lamp blinks on the sea's clock)
      tower.setTime(frame.time);
    },
  };
}
