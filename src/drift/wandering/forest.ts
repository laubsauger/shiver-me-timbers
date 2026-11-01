/**
 * THE ISLANDS' TREES for the film's coast (coast.ts): what makes a motu read as one (§12.5–6 of the references:
 * "island greens are dark and olive, and turn blue with distance"; from sea level an island is a wide, low band of
 * trees on a white rim). The game's islands had none — bare sand domes and tan blocks, the v11 review.
 *
 *   - THE CANOPY: every motu's interior is a shell over its trees' crowns. A crown is a few lobes on a jittered
 *     grid (a pure hash of its cell, so any point finds its neighbours without a table), and the shell is the highest
 *     crown over each point, over a sub-canopy of smaller trees: a broadleaf forest's rough top, in groves and
 *     clearings (THE CANOPY AS A MOTU'S, below). Its edge ramps down to grey-green scrub over the last metres before
 *     the sand, the forest's wall facing the beach. Each crown has its own green (its species', turned in hue and
 *     value) baked into the vertices with its shade.
 *   - THE LEAVES at the edge we walk along: alpha-cut cards of the anthurium scan's leaves (Poly Haven CC0, the
 *     plants already on the beach: plants.ts) laid over the shell's surface, so the wall the eye passes at 25 m is
 *     leaves with sky between them, not a smooth green hull. Lit by the shell's own normal, as a crown's leaves are.
 *   - THE HIGH ISLAND's forest is too far for any geometry of its own (a crown is 3 px at 7 km): its ground is
 *     shaded as canopy (`createForestGround`), bare rock where too steep, a sand rim at the water.
 */
import * as THREE from 'three/webgpu';
import { attribute, cameraPosition, cameraViewMatrix, diffuseColor, exp, float, mix, modelWorldMatrix, normalView, normalWorld, normalWorldGeometry, positionViewDirection, positionWorld, select, smoothstep, texture, uniform, vec3, vec4, vertexColor } from 'three/tsl';
import { fbm2, cellular2 } from '../../terrain/noise';
import { fbm2Cpu, hash2Cpu } from '../../terrain/noiseCpu';
import { LITTER_RES } from './beachMaterial';
import { graded } from './coast';
// (the high island's air: the light 7 km of marine air scatters in front of it, as its radio towers have it)
import { farAir } from './farAir';
import { rng } from '../undertime/web';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

/** one island's trees: where it is, how far its trees reach, its ground, and m inland of its nearer shore */
export interface ForestIsland {
  name: string;
  /** world x, z box the island's land lies in */
  box: { x: [number, number]; z: [number, number] };
  heightAt: (x: number, z: number) => number;
  inland: (x: number, z: number) => number;
}

/** the trees of a forest: crown spacing (m), heights (m), radii (m), where they start inland (m), the shell's
 * cell (m) — fine near the walk, coarse elsewhere — a seed, and its emergents: the share of crowns that stand out
 * of the canopy, and whether they are PALM HEADS (narrow, tall: a far motu's, whose real palms are too far to draw)
 * or broad spreading crowns (ours, among the real palms: palms.ts) */
interface Stand {
  spacing: number;
  top: [number, number];
  radius: [number, number];
  /** m inland of the shore the scrub starts, and the trees reach full height by */
  edge: [number, number];
  cell: [number, number];
  seed: number;
  emergent: number;
  heads: boolean;
}

/**
 * THE CANOPY AS A MOTU'S (the 2026-10-30 QA sweep, item 4: "far canopy = rows of identical egg-shaped crowns … reads
 * as CG at once"; and the user that night, on the landing approach: "these higher trees look a little bit silly … too
 * much of a homogeneous canopy … too evenly distributed … these high trees look like something from Mario … all of
 * these leaves are kind of exactly the same colour"). An A/B at 575 s pinned the eggs on this shell, not on the edge
 * trees' far clumps: each crown was a paraboloid cap only 0.75 r deep on a jittered 6.2 m grid, and between the crowns
 * the shell fell to the understorey 1.2 m over the ground — so every crown taller than its neighbours stood on a
 * vertical wall of its own, a column with a round top, and the one-in-eleven emergents (narrower, 5–11 m taller) were
 * the lollipops on the ridge. Four greens, each crown's only change its brightness.
 *
 * What an island's broadleaf forest is (Pisonia, Calophyllum, Barringtonia, breadfruit, Tournefortia; the palms above
 * it are palms.ts): crowns wider than they are tall, irregular — a main dome and lesser lobes leaning off it, some
 * round, some flat-topped and spreading — packed over a lower layer of smaller trees, so the canopy is a continuous
 * rough surface, not crowns on stalks; taller in groves and lower and broken in clearings (GROVE); every crown its own
 * hue and value; here and there a dead one. So:
 *   - a crown is a main dome and up to three lesser lobes, each with a profile `top − depth·d^p`: p 1.6 rounded …
 *     4.8 flat-topped, depth 0.3–0.6 of its radius (wider than tall), its height and radius tied (a big tree has a
 *     big crown); an emergent broadleaf broad and spreading, its skirt down into the canopy;
 *   - between crowns the shell falls to the SUB-CANOPY (SUB of the stand's mean height, less in clearings), not to
 *     the ground, so no crown stands on a wall; at the forest's edge the scrub's 1.2 m as before;
 *   - groves (GROVE m across) raise or lower whole stretches and thin them out: a crown in GAP is missing where the
 *     grove is thinnest;
 *   - every crown's leaves broken up in height by BUMP (a ragged top against the sky, not a smooth dome);
 *   - its colour a species' (SPECIES) turned in hue and value per crown (HUE, VALUE: ±12%).
 */
/** m: the groves' and clearings' scale */
const GROVE = 60;
/** share of the stand's mean height the sub-canopy stands at, between the crowns (in a grove; less in a clearing) */
const SUB = 0.5;
/** the most crowns missing where the grove is thinnest */
const GAP = 0.35;
/** a crown's height broken up by its leaf masses: ± this share of its radius, at BUMP_SCALE m */
const BUMP = 0.14;
const BUMP_SCALE = 2.4;
/** each crown's own hue (warmer ↔ cooler) and value, ± (shares) */
const HUE = 0.12;
const VALUE = 0.13;

/** linear albedos of the crowns (leaf greens are dark: 5–10% reflectance) and their shares (§12.5: dark and olive) */
const SPECIES: Array<{ share: number; albedo: [number, number, number]; name: string }> = [
  { name: 'pisonia', share: 0.28, albedo: [0.066, 0.083, 0.03] },
  { name: 'calophyllum', share: 0.22, albedo: [0.026, 0.038, 0.019] },
  { name: 'barringtonia', share: 0.2, albedo: [0.045, 0.06, 0.028] },
  { name: 'breadfruit', share: 0.1, albedo: [0.058, 0.082, 0.026] },
  { name: 'tournefortia', share: 0.12, albedo: [0.058, 0.066, 0.05] },
  // (a Terminalia's leaves turning red before they drop, a few in every crown)
  { name: 'terminalia', share: 0.05, albedo: [0.066, 0.054, 0.028] },
  // (dead or dying: bare grey-brown branches and a few leaves)
  { name: 'dead', share: 0.03, albedo: [0.074, 0.065, 0.052] },
];
const DEAD = SPECIES.length - 1;
/** the understorey between crowns (dark: light that never gets in), and the grey-green scrub at the forest's edge
 * (Scaevola, the strand's shrub) */
const UNDER: [number, number, number] = [0.03, 0.041, 0.022];
const SCRUB_TINT: [number, number, number] = [0.05, 0.06, 0.043];

interface Crown {
  x: number;
  z: number;
  /** m: its lobes, the main one first — x, z, radius, top */
  lobes: Array<[number, number, number, number]>;
  /** m from a lobe's top to its rim, and the profile's exponent */
  depth: number;
  p: number;
  /** m: the main lobe's radius (the bump's scale) */
  r: number;
  /** linear albedo, this crown's own */
  c: [number, number, number];
}

/** the groves: 0 a clearing … 1 the tallest, densest stand (a slow field over the island) */
const groveAt = (s: Stand, x: number, z: number): number => Math.min(1, Math.max(0, (fbm2Cpu(x / GROVE + s.seed * 1.7, z / GROVE - s.seed * 0.9, 3) - 0.5) * 2.2 + 0.5));

/** the crown of grid cell (i, j), or null where nothing grows (each worked out once a build: `memo`) */
function crownAt(isl: ForestIsland, s: Stand, i: number, j: number, memo: Map<number, Crown | null>): Crown | null {
  const key = i * 1000003 + j;
  const had = memo.get(key);
  if (had !== undefined) return had;
  const c = crownOf(isl, s, i, j);
  memo.set(key, c);
  return c;
}

function crownOf(isl: ForestIsland, s: Stand, i: number, j: number): Crown | null {
  const h = (k: number): number => hash2Cpu(i * 1.31 + k * 17.17 + s.seed * 3.7, j * 0.97 - k * 5.3 + s.seed);
  // (anywhere in its cell, not its middle 70%: the grid showed through as rows)
  const x = (i + 0.05 + 0.9 * h(0)) * s.spacing;
  const z = (j + 0.05 + 0.9 * h(1)) * s.spacing;
  const inland = isl.inland(x, z);
  if (inland < s.edge[0]) return null;
  // the forest's edge: scrub at the sand, the trees growing to full height over the next metres
  const e = Math.min(1, Math.max(0, (inland - s.edge[0]) / (s.edge[1] - s.edge[0])));
  const grow = 0.18 + 0.82 * e * e * (3 - 2 * e);
  const grove = groveAt(s, x, z);
  // a clearing: the thinner the grove, the more crowns missing (the sub-canopy, lower there, shows instead)
  if (h(8) < GAP * (1 - grove) ** 1.5) return null;
  // its size in the stand (height and radius tied: a tall tree spreads), and the grove's stature
  const u = h(3);
  const stature = 0.72 + 0.56 * grove;
  let r = (s.radius[0] + (s.radius[1] - s.radius[0]) * (0.35 * h(2) + 0.65 * u)) * (0.55 + 0.45 * grow);
  let top = isl.heightAt(x, z) + (s.top[0] + (s.top[1] - s.top[0]) * u ** 1.3) * grow * stature;
  // its form: 1.6 rounded … 4.8 flat-topped and spreading; wider than tall
  let p = 1.6 + 3.2 * h(9);
  let depth = r * (0.3 + 0.3 * h(10));
  let pick = h(4);
  let species = 0;
  for (; species < SPECIES.length - 1 && pick > SPECIES[species].share; species++) pick -= SPECIES[species].share;
  if (species === DEAD) {
    // a dead tree: lower, its crown thin and ragged
    top -= 0.25 * (top - isl.heightAt(x, z));
    p = 1.3;
    depth = r * 0.7;
  }
  if (h(6) < s.emergent) {
    if (s.heads) {
      // (a FAR MOTU's palm heads: one crown in eleven standing 5–11 m out of the canopy, narrow — from across the
      // lagoon a motu's line is its ragged top, palm heads above the trees; without them a far motu read as a flat
      // dark bar on the horizon, the 2026-10-29 review. A few pixels at 1.5–3.5 km; ours has real palms instead)
      r *= 0.65;
      top += (5 + 6 * h(7)) * grow * grow;
    } else {
      // an emergent broadleaf: a broad, flat-topped crown over the canopy, its skirt reaching down into it (no wall)
      r *= 1.3;
      // (2–4 m: at 3–7 m one read from the water as a smooth dark dome over the edge trees, the first round)
      const lift = (2 + 2 * h(7)) * grow;
      top += lift;
      p = 2.6 + 1.2 * h(9);
      depth = r * 0.35 + lift;
    }
  }
  // its lobes: up to three lesser domes leaning off the main one, a little lower (an irregular outline)
  const lobes: Crown['lobes'] = [[x, z, r, top]];
  const n = Math.floor(h(11) * 3.6);
  for (let k = 0; k < n; k++) {
    const a = Math.PI * 2 * h(12 + k);
    const off = r * (0.35 + 0.25 * h(15 + k));
    lobes.push([x + Math.cos(a) * off, z + Math.sin(a) * off, r * (0.4 + 0.2 * h(18 + k)), top - depth * (0.15 + 0.5 * h(21 + k))]);
  }
  // its own colour: the species', warmer or cooler and lighter or darker
  const a = SPECIES[species].albedo;
  const hue = HUE * (2 * h(5) - 1);
  const value = 1 + VALUE * (2 * h(13) - 1);
  const c: [number, number, number] = [a[0] * (1 + hue) * value, a[1] * value, a[2] * (1 - 1.4 * hue) * value];
  return { x, z, lobes, depth, p, r, c };
}

/** the shell over a forest at (x, z): its height, the crown's shade there (1 at a crown's top, dark in a gap),
 * and its albedo; null outside the forest */
function shellAt(isl: ForestIsland, s: Stand, x: number, z: number, out: { y: number; ao: number; c: [number, number, number] }, memo: Map<number, Crown | null>): boolean {
  const inland = isl.inland(x, z);
  if (inland < s.edge[0] - 3) return false;
  const ci = Math.floor(x / s.spacing);
  const cj = Math.floor(z / s.spacing);
  let best = -Infinity;
  let ao = 0.2;
  let crown: Crown | null = null;
  // (two cells round: a lobe of a broad crown reaches 1.6 of its radius from its centre, anywhere in its cell)
  for (let dj = -2; dj <= 2; dj++) {
    for (let di = -2; di <= 2; di++) {
      const c = crownAt(isl, s, ci + di, cj + dj, memo);
      if (!c) continue;
      for (const [lx, lz, lr, lt] of c.lobes) {
        const d2 = ((x - lx) ** 2 + (z - lz) ** 2) / (lr * lr);
        if (d2 >= 1) continue;
        const y = lt - c.depth * d2 ** (c.p / 2);
        if (y > best) {
          best = y;
          ao = 1 - 0.6 * d2;
          crown = c;
        }
      }
    }
  }
  const ground = isl.heightAt(x, z);
  // between the crowns: the sub-canopy (smaller trees, lower in a clearing) — over the scrub's 1.2 m at the edge
  const e = Math.min(1, Math.max(0, (inland - s.edge[0]) / (s.edge[1] - s.edge[0])));
  const grove = groveAt(s, x, z);
  const sub = SUB * ((s.top[0] + s.top[1]) / 2) * e * e * (3 - 2 * e) * (0.45 + 0.75 * grove);
  const under = ground + 1.2 * Math.min(1, Math.max(0, (inland - s.edge[0] + 3) / 6)) + sub;
  // the leaf masses: a crown's top is ragged, not a smooth dome
  if (crown) best += BUMP * crown.r * 2 * (fbm2Cpu(x / BUMP_SCALE + s.seed, z / BUMP_SCALE, 2) - 0.5);
  out.y = Math.max(best, under);
  if (!crown || best < under) {
    out.ao = 0.18 + 0.2 * Math.min(1, sub / 4);
    // (the grey-green scrub at the edge, the dark understorey deeper in)
    const k = Math.min(1, Math.max(0, (inland - s.edge[0]) / 8));
    out.c = [SCRUB_TINT[0] + (UNDER[0] - SCRUB_TINT[0]) * k, SCRUB_TINT[1] + (UNDER[1] - SCRUB_TINT[1]) * k, SCRUB_TINT[2] + (UNDER[2] - SCRUB_TINT[2]) * k];
    return true;
  }
  out.ao = ao;
  out.c = crown.c;
  return true;
}

/** the canopy shell over one island: a tensor grid (fine where `near` says), the cells outside the forest dropped */
function shellGeometry(isl: ForestIsland, s: Stand, near: { x: [number, number]; z: [number, number] }): THREE.BufferGeometry {
  const box = isl.box;
  const memo = new Map<number, Crown | null>();
  const us = graded(box.x[0], box.x[1], near.x[0], near.x[1], s.cell[0], s.cell[1]);
  const vs = graded(box.z[0], box.z[1], near.z[0], near.z[1], s.cell[0], s.cell[1]);
  const nu = us.length;
  const nv = vs.length;
  const pos = new Float32Array(nu * nv * 3);
  const col = new Float32Array(nu * nv * 3);
  const inside = new Uint8Array(nu * nv);
  const o = { y: 0, ao: 0, c: [0, 0, 0] as [number, number, number] };
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const k = j * nu + i;
      const x = us[i];
      const z = vs[j];
      pos[k * 3] = x;
      pos[k * 3 + 2] = z;
      if (shellAt(isl, s, x, z, o, memo)) {
        inside[k] = 1;
        pos[k * 3 + 1] = o.y;
        // the crown's shade into its albedo (vertex colour: the gaps' darkness is light that never gets in)
        col[k * 3] = o.c[0] * o.ao;
        col[k * 3 + 1] = o.c[1] * o.ao;
        col[k * 3 + 2] = o.c[2] * o.ao;
      } else {
        pos[k * 3 + 1] = isl.heightAt(x, z) - 0.5;
      }
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < nv - 1; j++) {
    for (let i = 0; i < nu - 1; i++) {
      const a = j * nu + i;
      const b = a + 1;
      const c = a + nu;
      const d = c + 1;
      if (inside[a] + inside[b] + inside[c] + inside[d] === 0) continue;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** the share of the sunlight a sunlit layer of leaves passes on toward a viewer behind it (the through-light's
 * strength against the sunlit side's: the shell is many layers deep, only its outer one glows) */
const LEAF_THROUGH = 0.35;

/** the canopy's material: the crowns' baked greens, leaf-scale breakup, and the light through the leaves when
 * the Sun is behind them */
function canopyMaterial(sun: THREE.Vector3): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.82, metalness: 0 });
  const p = positionWorld.xz;
  // leaf clusters (0.5 m) and twigs' shadows (0.15 m) over each crown's own green
  const detail = fbm2(p.mul(2.1), 3).mul(0.55).add(fbm2(p.mul(6.3), 2).mul(0.35)).add(0.55) as F;
  m.colorNode = vertexColor().rgb.mul(detail);
  // the shell's normal tilted by the same clusters, so a crown is many facets of leaves, not one dome
  const tilt = vec3(fbm2(p.mul(1.7).add(3.1), 2).sub(0.5), 0, fbm2(p.mul(1.7).add(7.7), 2).sub(0.5)).mul(0.9) as V3;
  // (normalNode is view space)
  m.normalNode = cameraViewMatrix.mul(vec4(normalWorld.add(tilt).normalize(), 0)).xyz.normalize();
  const sunU = uniform(sun);
  const lightU = uniform(new THREE.Color(0, 0, 0));
  // LIGHT THROUGH THE LEAVES: the Sun behind the canopy, the viewer looking toward it — the sunlight itself (its
  // colour and strength, nothing once it has set), a leaf passing on about as much as it reflects, yellower
  const view = cameraPosition.sub(positionWorld).normalize();
  const through = view.dot(sunU.negate()).max(0).pow(4).mul(normalWorldGeometry.dot(sunU).negate().max(0).mul(0.6).add(0.4)) as F;
  m.emissiveNode = vertexColor().rgb.mul(vec3(1.3, 1.5, 0.6)).mul(vec3(lightU as unknown as V3)).mul(through).mul(LEAF_THROUGH / Math.PI);
  m.receivedShadowNode = scattered;
  m.userData.sun = sunU;
  m.userData.light = lightU;
  return m;
}

/**
 * The high island's ground, shaded as forest from 7 km: canopy greens in crown-sized cells with the gaps dark,
 * bare rock on the steepest slopes, sand at the water, seen through the air in front of it (farAir.ts: the light
 * those 7 km of marine air scatter toward the eye, in its bearing). It had melted into the terrain's haze colour —
 * the horizon's, averaged over every bearing — over HIGH_AIR, and read paler and warmer than the sky over its summit
 * (the user, 2026-10-30: "the white weird islands … probably an effect of haze … but it doesn't work").
 */
export function createForestGround(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
  const p = positionWorld.xz;
  const cell = cellular2(p.div(9)) as V3;
  const crown = smoothstep(0.75, 0.15, cell.x) as F;
  const hue = cell.z;
  const green = mix(mix(vec3(0.05, 0.075, 0.03), vec3(0.08, 0.095, 0.035), hue), vec3(0.04, 0.055, 0.04), hue.mul(hue)) as V3;
  const canopy = green.mul(crown.mul(0.7).add(0.3)).mul(fbm2(p.div(60), 3).mul(0.6).add(0.7)) as V3;
  const up = normalWorldGeometry.y;
  const steep = smoothstep(0.62, 0.45, up) as F;
  const rock = vec3(0.13, 0.12, 0.1).mul(fbm2(p.div(14), 3).mul(0.6).add(0.6)) as V3;
  const shore = smoothstep(4.5, 2.2, positionWorld.y) as F;
  const sand = vec3(0.55, 0.5, 0.42) as V3;
  m.colorNode = mix(mix(canopy, rock, steep), sand, shore);
  m.roughnessNode = mix(float(0.85), float(0.95), steep);
  m.fog = false;
  farAir.air.output(m);
  return m;
}

export interface Forest {
  readonly group: THREE.Group;
  readonly ready: Promise<void>;
  /** the edge's trees' and shrubs' feet (x, z, the litter's radius m) */
  readonly feet: Array<[number, number, number]>;
  /** per frame: where the eye is (which edge trees are drawn from their full scans) */
  setEye(eye: THREE.Vector3): void;
  /** the Sun (world, unit, toward it) and its light (the key light's colour × intensity): the light through the
   * leaves */
  setSun(sun: THREE.Vector3, light: THREE.Color): void;
}

/** leaf cards: about one per this many m² of the shell along the walk, each this wide (m), stood this far off it */
const CARD_AREA = 0.45;
const CARD_SIZE: [number, number] = [1.1, 2.1];
const CARD_LIFT: [number, number] = [0.05, 0.7];

/**
 * THE LEAVES over the shell where the eye passes: alpha-cut cards of the anthurium scan's leaf atlas, each laid
 * near the shell's own surface (tilted up to ~55° off it, any roll), tinted by its crown's green and lit by the
 * shell's normal — a crown's leaves catch the light as the crown does, not each as a flat card.
 */
function leafCards(
  shell: THREE.BufferGeometry,
  walk: { x: [number, number]; z: [number, number] },
  sun: THREE.UniformNode<'vec3', THREE.Vector3>,
  light: THREE.UniformNode<'color', THREE.Color>,
  base: string, loads: Promise<unknown>[]): THREE.InstancedMesh {
  const pos = shell.getAttribute('position') as THREE.BufferAttribute;
  const nor = shell.getAttribute('normal') as THREE.BufferAttribute;
  const col = shell.getAttribute('color') as THREE.BufferAttribute;
  const idx = shell.getIndex()!;
  const rnd = rng(9173);
  const A = new THREE.Vector3();
  const B = new THREE.Vector3();
  const C = new THREE.Vector3();
  const mats: THREE.Matrix4[] = [];
  const normals: number[] = [];
  const tints: number[] = [];
  const P = new THREE.Vector3();
  const N = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const tilt = new THREE.Quaternion();
  const Z = new THREE.Vector3(0, 0, 1);
  const ax = new THREE.Vector3();
  for (let t = 0; t < idx.count; t += 3) {
    const ia = idx.getX(t);
    const ib = idx.getX(t + 1);
    const ic = idx.getX(t + 2);
    A.fromBufferAttribute(pos, ia);
    B.fromBufferAttribute(pos, ib);
    C.fromBufferAttribute(pos, ic);
    if (A.x < walk.x[0] || A.x > walk.x[1] || A.z < walk.z[0] || A.z > walk.z[1]) continue;
    // only over the forest (a dark understorey cell carries no crown's leaves)
    if (col.getY(ia) < 0.004) continue;
    const area = B.clone().sub(A).cross(C.clone().sub(A)).length() / 2;
    let n = area / CARD_AREA;
    const whole = Math.floor(n);
    n = whole + (rnd() < n - whole ? 1 : 0);
    for (let k = 0; k < n; k++) {
      let u = rnd();
      let v = rnd();
      if (u + v > 1) [u, v] = [1 - u, 1 - v];
      const w = 1 - u - v;
      P.set(0, 0, 0).addScaledVector(A, w).addScaledVector(B, u).addScaledVector(C, v);
      N.set(0, 0, 0)
        .addScaledVector(new THREE.Vector3().fromBufferAttribute(nor, ia), w)
        .addScaledVector(new THREE.Vector3().fromBufferAttribute(nor, ib), u)
        .addScaledVector(new THREE.Vector3().fromBufferAttribute(nor, ic), v)
        .normalize();
      P.addScaledVector(N, CARD_LIFT[0] + (CARD_LIFT[1] - CARD_LIFT[0]) * rnd());
      // the card's face along the shell's normal, tipped off it and rolled
      q.setFromUnitVectors(Z, N);
      ax.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
      tilt.setFromAxisAngle(ax, rnd() * 0.95);
      q.premultiply(tilt);
      q.multiply(new THREE.Quaternion().setFromAxisAngle(Z, rnd() * Math.PI * 2));
      const sz = CARD_SIZE[0] + (CARD_SIZE[1] - CARD_SIZE[0]) * rnd();
      mats.push(new THREE.Matrix4().compose(P.clone(), q.clone(), new THREE.Vector3(sz, sz, sz)));
      normals.push(N.x, N.y, N.z);
      tints.push(col.getX(ia), col.getY(ia), col.getZ(ia));
    }
  }
  const quad = new THREE.PlaneGeometry(1, 1);
  quad.setAttribute('leafNormal', new THREE.InstancedBufferAttribute(new Float32Array(normals), 3));
  quad.setAttribute('leafTint', new THREE.InstancedBufferAttribute(new Float32Array(tints), 3));
  const loader = new THREE.TextureLoader();
  const load = (file: string, srgb: boolean): THREE.Texture => {
    let t!: THREE.Texture;
    loads.push(new Promise((ok, fail) => (t = loader.load(`${base}anthurium_botany_01/textures/${file}`, ok, undefined, () => fail(new Error(`forest: ${file}`))))));
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 8;
    return t;
  };
  const diff = load('anthurium_botany_01_diff_4k.jpg', true);
  const alpha = load('anthurium_botany_01_alpha_4k.png', false);
  const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.6, metalness: 0 });
  const tint = attribute('leafTint', 'vec3') as V3;
  const leafN = attribute('leafNormal', 'vec3') as V3;
  // the scan's own green, brought to its crown's (the scan is a houseplant's glossy dark leaf: ~0.07 albedo)
  const scan = texture(diff).rgb;
  // (its glossy houseplant green, desaturated a little toward the forest's olive)
  const leaf = mix(scan, vec3(scan.dot(vec3(0.2126, 0.7152, 0.0722))), 0.3) as V3;
  m.colorNode = leaf.mul(tint.div(0.06)).mul(0.8);
  m.opacityNode = texture(alpha).r;
  m.alphaTest = 0.5;
  // (graded into coverage once the faces have MSAA; the plain cut without)
  m.alphaToCoverage = true;
  m.receivedShadowNode = scattered;
  m.normalNode = cameraViewMatrix.mul(vec4(leafN.mul(0.75).add(normalWorld.mul(0.25)).normalize(), 0)).xyz.normalize();
  const view = cameraPosition.sub(positionWorld).normalize();
  const through = view.dot(sun.negate()).max(0).pow(4) as F;
  m.emissiveNode = leaf.mul(tint.div(0.06)).mul(0.8).mul(vec3(1.3, 1.5, 0.6)).mul(vec3(light as unknown as V3)).mul(through).mul(LEAF_THROUGH / Math.PI);
  const mesh = new THREE.InstancedMesh(quad, m, mats.length);
  mats.forEach((x, i) => mesh.setMatrixAt(i, x));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.name = 'forest-leaves';
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  // (instances scattered over a wide box: no culling against one bounding sphere's guess)
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * THE FOREST'S EDGE along the walk: scanned trees (Poly Haven's island trees and small tree, CC0, decimated to
 * ~90k triangles by scripts/drift-tree-export.py) in two staggered rows where the sand ends, scaled up to the
 * motu's 8–14 m broadleaf trees (the scans are saplings of 2.6–5 m: their leaves come out 20–40 cm, a
 * Terminalia's or a Calophyllum's), Pachira scrub in front of them. Their leaves are modelled one by one on a
 * black ground with no alpha: cut out here from the colour.
 */
const EDGE_TREES: Array<{ id: string; height: [number, number]; share: number; sprig: [number, number] }> = [
  { id: 'island_tree_01', height: [10, 14], share: 0.32, sprig: [0, 1] },
  { id: 'island_tree_02', height: [8, 11], share: 0.24, sprig: [0, 1] },
  { id: 'island_tree_03', height: [7, 10], share: 0.16, sprig: [0, 1] },
  { id: 'tree_small_02', height: [9, 13], share: 0.28, sprig: [0, 0.6] },
];
/** (`sprig`: the u range of its leaf atlas a far clump card shows — the island trees' is eight leaves, the small
 * tree's sprigs of leaves left of its bark) */
const EDGE_SHRUB = { id: 'pachira_aquatica_01', height: [1.8, 3.4] as [number, number] };
/** m inland of the shore: the two rows of trees, and the scrub in front of them; m along between them */
const ROWS: Array<{ inland: [number, number]; step: [number, number] }> = [
  { inland: [23, 29], step: [6, 9] },
  { inland: [31, 41], step: [5, 8] },
];
const SCRUB = { inland: [17, 26] as [number, number], step: [1.6, 3.2] as [number, number] };

/** m: within this of the eye an edge tree is drawn from its full scan */
const NEAR = 55;
/** TREES OF THEIR OWN: an edge tree's stretch across and up (× its kind's), its lean (rad, ±), and its leaves' hue
 * and value (±, shares); the scrub's leaves toward Scaevola's grey-green (a multiplier on the scan's green) */
const TREE_WIDE: [number, number] = [0.9, 1.5];
const TREE_TALL: [number, number] = [0.8, 1.08];
const LEAN = 0.1;
const TREE_HUE = 0.12;
const TREE_VALUE = 0.15;
const SCAEVOLA: [number, number, number] = [1.12, 0.95, 1.18];

/**
 * A CROWN IS LIT AS ONE VOLUME (the 2026-10-29 beach review at 600–610 s: "horrendous black flickering across all
 * the trees, insanely nervous. In any given frame half of the nature stuff is just black … the sun is coming from the
 * left, why would anything be that dark?"). Measured at 604 s (16:9 at 1280, three frames 1/30 s apart): the forest
 * wall's frame-to-frame change survived motion compensation almost whole (mean |ΔY| 9.3 → 9.1 after matching each
 * 16 px block to its best sub-pixel shift: not parallax but flicker), and 29–48% of its pixels were near black
 * (luma < 20). Each scanned leaf was shaded by its own normal (random, a leaf's tilt and the far LOD's collapsed
 * shards worse), its back face black but for the sky, and dappled by the shadow map's 7.8 cm texels — its own crown's
 * leaves over it — so every leaf a pixel or three across at 50–200 m was on or off at random, and moved.
 *
 * As foliage is lit in film and games: each leaf takes its CROWN's normal (an ellipsoid's, about the instance's
 * `leafCrown`), turned a little (LEAF_OWN) by its own; the sunlight through its own crown is worked out, not looked
 * up — the path to the crown's sunward side through leaves of density CROWN_DENSITY — and its shadow is looked up
 * only from past that side (receivedShadowPositionNode: what shades it from another tree, a palm, still does); a
 * leaf with the Sun behind it passes LEAF_TRANSMIT of it on, yellower (a leaf transmits about what it reflects); in
 * another's shadow it still has CANOPY_SCATTER of the light, scattered to it through the leaves round it; deep in its
 * crown it sees less sky. The bark inside a crown takes the same through-crown sunlight and shadow lookup.
 */
/** m⁻¹: the sunlight's fall through a crown's leaves (Beer's law: half of it gone in 1.7 m, all but a tenth in 6) */
const CROWN_DENSITY = 0.4;
/** m: past the sunward side of its own crown, where a leaf looks up the shadow (leaves stand out of the fit) */
const CROWN_MARGIN = 0.8;
/** share of a leaf's own normal in its shading (the rest its crown's): enough to keep its texture of light */
const LEAF_OWN = 0.3;
/** a leaf's diffuse transmittance against its reflectance, and the tint the light through it takes */
const LEAF_TRANSMIT = 0.7;
const LEAF_TINT: [number, number, number] = [1.05, 1.25, 0.55];
/** the share of the sunlight that reaches a leaf in another's shadow, scattered through the leaves round it */
const CANOPY_SCATTER = 0.25;
/** (a material's received shadow so lifted: the edge's leaves, and the canopy shell and its leaf cards behind them —
 * in the edge trees' shadow at a low Sun, the forest's inside was black) */
const scattered = ((s: F) => s.mul(1 - CANOPY_SCATTER).add(CANOPY_SCATTER)) as unknown as () => THREE.Node;
/** m: a crown's leaf clusters, the sprays its shading breaks into */
const CLUSTER = 0.9;
/** share of the way a leaf's colour goes to its own grey (the scans' leaves are a saturated yellow-green, and lit
 * whole by their crowns they read lime, not the olive of an island's trees: §12.5) */
const LEAF_GREY = 0.25;
/** a leaf's roughness (the scans' maps say 0.3–0.6, a houseplant's gloss: a glint per leaf in a low Sun, sparkle) */
const LEAF_ROUGHNESS = 0.8;

/** the lighting of a crown's leaves and bark: the Sun dimmed by `crownT` (its own crown's leaves), and for leaves
 * (`transmit` > 0) the light through a leaf with the Sun behind it */
class CrownLighting extends THREE.PhysicalLightingModel {
  constructor(
    private readonly crownT: F,
    private readonly transmit: number,
  ) {
    super();
  }

  override direct(input: THREE.LightingModelDirectInput, builder: THREE.NodeBuilder): void {
    const lightColor = (input.lightColor as V3).mul(this.crownT);
    if (this.transmit > 0) {
      // (Lambertian, through the face away from the light; a little more looking toward the Sun, as a lit leaf
      // glows brightest with the Sun straight behind it)
      const back = normalView.dot(input.lightDirection as V3).negate().max(0);
      const toward = positionViewDirection.dot(input.lightDirection as V3).negate().max(0).pow(4);
      const through = vec3(...LEAF_TINT).mul(this.transmit / Math.PI).mul(toward.mul(0.8).add(0.7));
      (input.reflectedLight.directDiffuse as V3).addAssign(lightColor.mul(diffuseColor.rgb).mul(back).mul(through));
    }
    super.direct({ ...input, lightColor }, builder);
  }
}

class CrownMaterial extends THREE.MeshStandardNodeMaterial {
  constructor(
    params: THREE.MeshStandardNodeMaterialParameters,
    private readonly crownT: F,
    private readonly transmit: number,
  ) {
    super(params);
  }

  override setupLightingModel(): THREE.PhysicalLightingModel {
    return new CrownLighting(this.crownT, this.transmit);
  }
}

/**
 * The crown a fragment is in: the instance's `leafCrown` (its centre in the mesh's space, its horizontal radius m)
 * and `leafCrownH` (its vertical radius m: each instance its own, as each is stretched its own way). Returns its outward normal there (world), turned by the crown's leaf
 * clusters (CLUSTER), its depth (0 at the centre, 1 on the ellipsoid), the sunlight left after its leaves on the way
 * in, and where to look its shadow up from.
 *
 * (Shading every leaf of a far crown where its pixel's ray enters the ellipsoid — so that the leaves at every depth
 * along it agree — was tried: the forest wall's flicker did not drop, and from the raft the far crowns read as
 * smooth green balls, the 2026-10-29 "broccoli/lollipop" note. So were opaque cores inside the crowns, behind the
 * gaps: the flicker fell by a third, but the balls showed through.)
 */
function crownLight(sun: THREE.UniformNode<'vec3', THREE.Vector3>): { normal: V3; depth: F; light: F; shadowAt: V3 } {
  const crown = attribute('leafCrown', 'vec4');
  const centre = modelWorldMatrix.mul(vec4(crown.xyz, 1)).xyz;
  const radii = vec3(crown.w, attribute('leafCrownH', 'float'), crown.w);
  // in the crown's unit sphere: the point, and the ray toward the Sun (its parameter still in metres)
  const q = positionWorld.sub(centre).div(radii);
  const s = vec3(sun as unknown as V3).div(radii);
  const a = s.dot(s);
  const b = q.dot(s);
  const disc = b.mul(b).sub(a.mul(q.dot(q).sub(1)));
  const root = disc.max(0).sqrt();
  const out = root.sub(b).div(a);
  const into = root.negate().sub(b).div(a).max(0);
  const hit = disc.greaterThan(0).and(out.greaterThan(0));
  const path = select(hit, out.sub(into), float(0));
  // the leaf clusters: the crown's surface tilted in world-fixed patches CLUSTER m across (a crown is many sprays of
  // leaves, each catching the light its own way: lumpy, not a ball), still the same at every depth of a patch
  const p = positionWorld.div(CLUSTER);
  const tilt = vec3(fbm2(p.xz.add(p.y.mul(0.7)), 2).sub(0.5), fbm2(p.xz.add(5.3), 2).sub(0.5).mul(0.6), fbm2(p.zx.add(p.y.mul(0.7)).add(11.1), 2).sub(0.5));
  return {
    normal: q.div(radii).normalize().add(tilt.mul(1.6)),
    depth: q.length(),
    light: exp(path.mul(-CROWN_DENSITY)),
    shadowAt: positionWorld.add(vec3(sun as unknown as V3).mul(select(hit, out, float(0)).add(CROWN_MARGIN))),
  };
}

/** a crown's ellipsoid in its model (m): the middle 96% of its leaves' vertices on each axis */
function crownFit(parts: THREE.Mesh[]): { centre: THREE.Vector3; rh: number; ratio: number } {
  const axes: number[][] = [[], [], []];
  const v = new THREE.Vector3();
  for (const p of parts) {
    const pos = p.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i += 5) {
      v.fromBufferAttribute(pos, i).applyMatrix4(p.matrixWorld);
      axes[0].push(v.x);
      axes[1].push(v.y);
      axes[2].push(v.z);
    }
  }
  const span = axes.map((xs) => {
    xs.sort((m, n) => m - n);
    return [xs[Math.floor(xs.length * 0.02)], xs[Math.floor(xs.length * 0.98)]];
  });
  const rh = (span[0][1] - span[0][0] + span[2][1] - span[2][0]) / 4;
  return {
    centre: new THREE.Vector3((span[0][0] + span[0][1]) / 2, (span[1][0] + span[1][1]) / 2, (span[2][0] + span[2][1]) / 2),
    rh,
    ratio: (span[1][1] - span[1][0]) / 2 / rh,
  };
}

/**
 * FAR CROWNS AS CLUMPS (the 2026-10-29 review again, on the forest at 600 s: "very, very grizzly … so noisy … I'd much
 * rather have stuff disappear than look like this"): past NEAR a tree's leaves are not its scan's — collapsed to ~80k
 * shards a pixel or two across, each cut and lit its own way, a fresh draw of specks every frame the eye moved — but
 * CLUMPS of leaves: CLUMPS crossed pairs of cards CLUMP m across, each showing the scan's own leaf atlas (its `sprig`:
 * the same leaves, at the same size, as the near scan's), set where the scan's leaves are, by their area (so the crown
 * keeps its ragged outline), sunk a little into it and facing out of it, tipped and
 * rolled at random, and lit by the crown as the near leaves are. A card turned edge-on to the eye is let go (EDGE_ON)
 * rather than drawn as a sliver. (Cards of the anthurium atlas, the canopy's, were tried: calm, but big leaves in
 * dense balls, the island trees' open crowns of small leaves and pale branches gone.)
 */
const CLUMPS = 120;
const CLUMP: [number, number] = [1.2, 2.0];
/** |cos| of a clump card's angle to the eye: gone under the first, whole over the second */
const EDGE_ON: [number, number] = [0.12, 0.35];

/** the clump cards of a crown, in its model's space (`scale`: the model's m to the world's, a mean over the kind) */
function clumpCards(leaves: THREE.BufferGeometry, crown: ReturnType<typeof crownFit>, scale: number, sprig: [number, number], seed: number): THREE.BufferGeometry {
  const pos = leaves.getAttribute('position');
  const index = leaves.getIndex();
  const corner = (t: number, k: number, out: THREE.Vector3): THREE.Vector3 => out.fromBufferAttribute(pos, index ? index.getX(t * 3 + k) : t * 3 + k);
  const n = (index ? index.count : pos.count) / 3;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const cum = new Float64Array(n);
  let total = 0;
  for (let t = 0; t < n; t++) {
    corner(t, 0, a);
    total += corner(t, 1, b).sub(a).cross(corner(t, 2, c).sub(a)).length() / 2;
    cum[t] = total;
  }
  const r = rng(seed);
  const radii = new THREE.Vector3(crown.rh, crown.rh * crown.ratio, crown.rh);
  const P: number[] = [];
  const N: number[] = [];
  const U: number[] = [];
  const I: number[] = [];
  const m = new THREE.Vector3();
  const out = new THREE.Vector3();
  const side = new THREE.Vector3();
  const up = new THREE.Vector3();
  const q = new THREE.Quaternion();
  for (let k = 0; k < CLUMPS; k++) {
    // a leaf triangle, by its area
    const x = r() * total;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    m.copy(corner(lo, 0, a)).add(corner(lo, 1, b)).add(corner(lo, 2, c)).divideScalar(3);
    out.copy(m).sub(crown.centre).divide(radii).divide(radii).normalize();
    const size = (CLUMP[0] + (CLUMP[1] - CLUMP[0]) * r()) / scale;
    m.addScaledVector(out, -size * 0.3);
    q.setFromAxisAngle(side.set(r() - 0.5, r() - 0.5, r() - 0.5).normalize(), r() * 0.6);
    out.applyQuaternion(q);
    side.set(out.y, -out.x, 0);
    if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
    side.normalize().applyAxisAngle(out, r() * Math.PI * 2);
    up.crossVectors(out, side);
    // two cards crossed about `up`: one facing out of the crown, one across it
    for (const [u, f] of [[side, out], [out, side]] as const) {
      const base = P.length / 3;
      for (const [su, sv] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
        P.push(m.x + (u.x * su + up.x * sv) * size, m.y + (u.y * su + up.y * sv) * size, m.z + (u.z * su + up.z * sv) * size);
        N.push(f.x, f.y, f.z);
        U.push(sprig[0] + (sprig[1] - sprig[0]) * (su + 0.5), sv + 0.5);
      }
      I.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  g.setIndex(I);
  return g;
}

/**
 * DEAD TREES over the canopy (the user, 2026-10-30: "the occasional dead or broken tree"; the Tubuai motu reference —
 * drift-narrative/references/tropical-coast-lagoon/motu-mitiha-tubuai-shallow-lagoon-sea-level.jpg — has bleached bare
 * crowns standing out of the forest's line): DEAD_TREES of the island scans' far LODs, their trunks and branches only
 * (~11k triangles each), bleached toward a pale grey (BLEACH), DEAD_H m tall so they stand out of the 7–13 m canopy,
 * scattered DEAD_INLAND m in along the coast the walk sees (`walk`, widened by DEAD_REACH). No shadows (they fall
 * inland at the film's low Suns, on the canopy).
 */
const DEAD_TREES = 9;
const DEAD_H: [number, number] = [11, 16];
const DEAD_INLAND: [number, number] = [45, 170];
const DEAD_REACH = 160;
const BLEACH = 0.65;
function deadTrees(isl: ForestIsland, walk: { x: [number, number]; z: [number, number] }, base: string, loads: Promise<unknown>[], aerial: (m: THREE.Material) => void): THREE.Group {
  const group = new THREE.Group();
  group.name = 'forest-dead';
  const r = rng(6607);
  const spots: Array<{ x: number; z: number; h: number; turn: number; lean: number; kind: number }> = [];
  for (let i = 0; spots.length < DEAD_TREES && i < 5000; i++) {
    const x = isl.box.x[0] + (isl.box.x[1] - isl.box.x[0]) * r();
    const z = walk.z[0] - DEAD_REACH + (walk.z[1] - walk.z[0] + 2 * DEAD_REACH) * r();
    const inland = isl.inland(x, z);
    if (inland < DEAD_INLAND[0] || inland > DEAD_INLAND[1] || isl.heightAt(x, z) < 1) continue;
    if (spots.some((s) => Math.hypot(s.x - x, s.z - z) < 40)) continue;
    spots.push({ x, z, h: DEAD_H[0] + (DEAD_H[1] - DEAD_H[0]) * r(), turn: r() * Math.PI * 2, lean: 0.12 * (2 * r() - 1), kind: r() < 0.5 ? 0 : 1 });
  }
  const loader = new GLTFLoader();
  ['island_tree_01', 'island_tree_02'].forEach((id, k) => {
    const mine = spots.filter((s) => s.kind === k);
    if (!mine.length) return;
    loads.push(
      loader.loadAsync(`${base}${id}/${id}_lod.glb`).then((g) => {
        g.scene.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(g.scene);
        const tall = box.max.y - box.min.y;
        g.scene.traverse((o) => {
          const part = o as THREE.Mesh;
          const src = part.material as THREE.MeshStandardMaterial;
          if (!part.isMesh || /leaves/.test(src.name) || !src.map) return;
          const m = new THREE.MeshStandardNodeMaterial({ map: src.map, normalMap: src.normalMap, roughness: 1, metalness: 0 });
          // bleached: the bark's own pattern, its colour gone most of the way to a pale grey
          const bark = texture(src.map).rgb;
          m.colorNode = mix(bark, vec3(bark.dot(vec3(0.2126, 0.7152, 0.0722)).mul(1.7)), BLEACH);
          aerial(m);
          const geo = part.geometry.clone().applyMatrix4(part.matrixWorld);
          geo.translate(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
          const inst = new THREE.InstancedMesh(geo, m, mine.length);
          const q = new THREE.Quaternion();
          mine.forEach((s, i) => {
            const k = s.h / tall;
            q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.turn).premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(Math.cos(s.turn), 0, Math.sin(s.turn)), s.lean));
            inst.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(s.x, isl.heightAt(s.x, s.z) - 0.3, s.z), q, new THREE.Vector3(k, k, k)));
          });
          inst.instanceMatrix.needsUpdate = true;
          inst.castShadow = false;
          inst.receiveShadow = true;
          inst.frustumCulled = false;
          inst.name = `forest-dead-${id}`;
          group.add(inst);
        });
      }),
    );
  });
  return group;
}

function edgeTrees(
  isl: ForestIsland,
  walk: { x: [number, number]; z: [number, number] },
  base: string,
  loads: Promise<unknown>[],
  sun: THREE.UniformNode<'vec3', THREE.Vector3>,
): { group: THREE.Group; feet: Array<[number, number, number]>; setEye: (eye: THREE.Vector3) => void } {
  const group = new THREE.Group();
  group.name = 'forest-edge';
  const loader = new GLTFLoader();
  const r = rng(5521);
  /** world x, z of a point `inland` m in from our shore at world z (inland grows 1:1 with x on the lagoon side) */
  const at = (inland: number, z: number): [number, number] => [walk.x[0] + inland - isl.inland(walk.x[0], z), z];
  const plant = (rows: typeof ROWS, pick: () => number): Array<{ k: number; x: number; z: number; u: number }> => {
    const out: Array<{ k: number; x: number; z: number; u: number }> = [];
    for (const row of rows) {
      for (let z = walk.z[0] + r() * row.step[1]; z < walk.z[1]; z += row.step[0] + (row.step[1] - row.step[0]) * r()) {
        const [x] = at(row.inland[0] + (row.inland[1] - row.inland[0]) * r(), z);
        out.push({ k: pick(), x, z, u: r() });
      }
    }
    return out;
  };
  const pickTree = (): number => {
    let u = r();
    for (let i = 0; i < EDGE_TREES.length - 1; i++) if ((u -= EDGE_TREES[i].share) < 0) return i;
    return EDGE_TREES.length - 1;
  };
  const tex = new THREE.TextureLoader();
  /** a tree's prepared leaf map (scripts/drift-leaf-alpha.py) */
  const leafTex = (id: string, which: 'diff_bled' | 'alpha', srgb: boolean): THREE.Texture => {
    let t!: THREE.Texture;
    loads.push(new Promise((ok, fail) => (t = tex.load(`${base}${id}/textures/${id}_leaves_${which}_2k.png`, ok, undefined, () => fail(new Error(`forest: ${id} ${which} (run scripts/drift-leaf-alpha.py)`))))));
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.flipY = false;
    t.anisotropy = 8;
    return t;
  };
  const trees = plant(ROWS, pickTree);
  const shrubs = plant([SCRUB], () => EDGE_TREES.length);
  /** the litter each drops round its foot: x, z, m */
  const feet: Array<[number, number, number]> = [...trees.map((t): [number, number, number] => [t.x, t.z, 5]), ...shrubs.map((t): [number, number, number] => [t.x, t.z, 2.6])];
  const kinds = [...EDGE_TREES.map((t) => ({ id: t.id, height: t.height, sprig: t.sprig })), { ...EDGE_SHRUB, sprig: null }];
  /** NEAR AND FAR (the 2026-10-29 review: the trees "falling apart … flickery, grainy tiny leaves … even at higher
   * resolution"): their modelled leaves, collapsed to ~90k triangles a tree, went to shards. Within NEAR m of the eye
   * a tree is drawn from its full scan (1–2M triangles); further off from the light one's trunk, its leaves as clumps
   * (FAR CROWNS AS CLUMPS). Which is which is set per frame from the eye (`setEye`): a pure function of where it is. */
  const lods: Array<{ spots: Array<{ x: number; z: number }>; mats: THREE.Matrix4[]; tints: THREE.Color[]; near: THREE.InstancedMesh[]; far: THREE.InstancedMesh[] }> = [];
  /** each mesh's crown (`userData.crown`, crownFit) per instance in the meshes' space — x, y, z, horizontal radius
   * m — into its `leafCrown` at `slot`, its vertical radius into `leafCrownH`, with the instance's matrix (and its
   * colour, `tint`: TREES OF THEIR OWN) */
  const cv = new THREE.Vector3();
  const bark = new THREE.Color();
  const putCrown = (m: THREE.InstancedMesh, slot: number, mat: THREE.Matrix4, tint: THREE.Color): void => {
    const fit = m.userData.crown as ReturnType<typeof crownFit>;
    const e = mat.elements;
    cv.copy(fit.centre).applyMatrix4(mat);
    (m.geometry.getAttribute('leafCrown') as THREE.InstancedBufferAttribute).setXYZW(slot, cv.x, cv.y, cv.z, fit.rh * Math.hypot(e[0], e[1], e[2]));
    (m.geometry.getAttribute('leafCrownH') as THREE.InstancedBufferAttribute).setX(slot, fit.rh * fit.ratio * Math.hypot(e[4], e[5], e[6]));
    m.setColorAt(slot, m.userData.leaf ? tint : bark.setScalar((tint.r + tint.g + tint.b) / 3));
  };
  kinds.forEach((kind, k) => {
    const spots = (k < EDGE_TREES.length ? trees : shrubs).filter((t) => t.k === k);
    if (!spots.length) return;
    const tree = k < EDGE_TREES.length;
    const entry = { spots, mats: [] as THREE.Matrix4[], tints: [] as THREE.Color[], near: [] as THREE.InstancedMesh[], far: [] as THREE.InstancedMesh[] };
    lods.push(entry);
    const build = (g: { scene: THREE.Object3D }, which: 'near' | 'far'): void => {
      g.scene.updateMatrixWorld(true);
      const parts: THREE.Mesh[] = [];
      g.scene.traverse((x) => {
        if ((x as THREE.Mesh).isMesh) parts.push(x as THREE.Mesh);
      });
      const box = new THREE.Box3().setFromObject(g.scene);
      const tall = box.max.y - box.min.y;
      const q = new THREE.Quaternion();
      const tilt = new THREE.Quaternion();
      const ax = new THREE.Vector3();
      // TREES OF THEIR OWN (the 2026-10-30 review: "too much of a homogeneous canopy … all of these leaves are kind
      // of exactly the same colour"): four scans, each instance stretched its own way — WIDE (×) across and TALL (×)
      // up, so a crown is as often wider than it is tall as not — leaning up to LEAN, and its leaves turned in hue
      // and value (TREE_HUE, TREE_VALUE; the bark in value only), the scrub toward the strand's grey-green Scaevola
      const v = (t: { u: number }, n: number): number => {
        const x = Math.sin(t.u * n + n * 0.37) * 43758.5453;
        return x - Math.floor(x);
      };
      const mats = spots.map((t) => {
        const h = kind.height[0] + (kind.height[1] - kind.height[0]) * t.u;
        const sc = h / tall;
        const sx = sc * (TREE_WIDE[0] + (TREE_WIDE[1] - TREE_WIDE[0]) * v(t, 17.3));
        const sy = sc * (TREE_TALL[0] + (TREE_TALL[1] - TREE_TALL[0]) * v(t, 23.9));
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.u * 977 % (Math.PI * 2));
        ax.set(Math.cos(t.u * 311), 0, Math.sin(t.u * 311));
        tilt.setFromAxisAngle(ax, LEAN * (2 * v(t, 59.1) - 1));
        q.premultiply(tilt);
        const foot = new THREE.Vector3(-(box.min.x + box.max.x) / 2 * sx, -box.min.y * sy, -(box.min.z + box.max.z) / 2 * sx).applyQuaternion(q);
        const y = isl.heightAt(t.x, t.z) - 0.25;
        return new THREE.Matrix4().compose(new THREE.Vector3(t.x, y, t.z).add(foot), q, new THREE.Vector3(sx, sy, sx));
      });
      entry.mats = mats;
      entry.tints = spots.map((t) => {
        const hue = TREE_HUE * (2 * v(t, 31.7) - 1);
        const value = 1 + TREE_VALUE * (2 * v(t, 41.3) - 1);
        const c = new THREE.Color(value * (1 + hue), value, value * (1 - 1.4 * hue));
        return tree ? c : c.multiply(new THREE.Color(...SCAEVOLA));
      });
      const isLeaf = (p: THREE.Mesh): boolean => /leaves/.test((p.material as THREE.Material).name);
      // (each leaf mesh its own crown — a tree's leaves are one, the Pachira file four plants side by side, one
      // crown round all four lit them as the far side of a ball — and the bark its nearest leaves')
      const leafParts = parts.filter(isLeaf);
      const middle = (p: THREE.Mesh): THREE.Vector3 => new THREE.Box3().setFromObject(p).getCenter(new THREE.Vector3());
      const fits = new Map(leafParts.map((p) => [p, { fit: crownFit([p]), at: middle(p) }]));
      const crownOf = (p: THREE.Mesh): ReturnType<typeof crownFit> => {
        if (!leafParts.length) return crownFit([p]);
        const at = middle(p);
        let best = fits.get(leafParts[0])!;
        for (const f of fits.values()) if (f.at.distanceTo(at) < best.at.distanceTo(at)) best = f;
        return fits.get(p)?.fit ?? best.fit;
      };
      const olive = (rgb: V3): V3 => mix(rgb, vec3(rgb.dot(vec3(0.2126, 0.7152, 0.0722))), LEAF_GREY) as V3;
      for (const part of parts) {
        const src = part.material as THREE.MeshStandardMaterial;
        // (past NEAR a crown's twigs are a few cm across, under a tenth of a pixel: drawn, they were dark specks all
        // through the far crowns — the far bark's share of their flicker was a ninth, 8.4 → 7.4. The trunk stays.)
        if (which === 'far' && tree && /branches/.test(src.name)) continue;
        const crown = crownOf(part);
        const lit = crownLight(sun);
        const leaf = isLeaf(part);
        const leaves = leaf && tree;
        const sprig = leaves && which === 'far' ? kind.sprig : null;
        const m = new CrownMaterial(
          {
            map: leaves ? leafTex(kind.id, 'diff_bled', true) : src.map,
            // (a leaf's own normal map and its ARM map's gloss and occlusion are past what its crown's shading
            // keeps: left off, two texture reads a leaf fewer)
            normalMap: leaf ? null : src.normalMap,
            roughnessMap: leaf ? null : src.roughnessMap,
            // (the scans' ARM maps carry their ambient occlusion in red: the crevices of the bark — unused until
            // now, the 2026-10-29 "pasted on" review)
            aoMap: leaf ? null : src.roughnessMap,
            roughness: leaf ? LEAF_ROUGHNESS : 1,
            metalness: 0,
            side: THREE.DoubleSide,
          },
          lit.light,
          leaf ? LEAF_TRANSMIT : 0,
        );
        m.receivedShadowPositionNode = lit.shadowAt;
        if (leaf) {
          // a leaf: its crown's normal, turned a little by its own (normalNode is view space; normalWorld in it the
          // leaf's own, turned to the eye on its back face — fading its share out with distance was tried: the far
          // crowns flickered a little more, 7.2 → 7.6); less sky deep in its crown; some light in another's shadow
          m.normalNode = cameraViewMatrix.mul(vec4(lit.normal.add(normalWorld.mul(LEAF_OWN)).normalize(), 0)).xyz.normalize();
          m.aoNode = smoothstep(0.1, 1, lit.depth).mul(0.6).add(0.4);
          m.receivedShadowNode = scattered;
          m.colorNode = olive(texture(m.map!).rgb);
        }
        if (sprig) {
          const alpha = texture(leafTex(kind.id, 'alpha', false)).r;
          const facing = normalWorldGeometry.dot(cameraPosition.sub(positionWorld).normalize()).abs();
          m.opacityNode = alpha.mul(smoothstep(EDGE_ON[0], EDGE_ON[1], facing));
          m.alphaTest = 0.5;
          m.alphaToCoverage = true;
          // (the shadow pass cuts by the map's alpha, which the bled atlas has none of: a card's own cut, or each
          // clump cast a square)
          m.maskShadowNode = alpha.greaterThan(0.5);
        }
        if (leaves && !sprig) {
          // (each leaf is its own shape in the scan, laid on black: cut out by its own alpha and coloured with
          // the leaf bled over the black, scripts/drift-leaf-alpha.py — cut by brightness, the black came through
          // every mip as dark fringes and specks). With alpha-to-coverage, in the faces' 4× MSAA (cine/domeCapture.ts)
          // three grades the cut over one fwidth of the alpha past 0.5 — Golus's sharpened alpha test: a leaf's edge a
          // pixel wide at any distance, a quarter of the pixel at a time; single-sampled, the plain cut. (It was
          // sharpened here by hand before, which only matters with coverage, and under three's own grading would
          // have halved the edge.)
          m.opacityNode = texture(leafTex(kind.id, 'alpha', false)).r;
          m.alphaTest = 0.5;
          m.alphaToCoverage = true;
        }
        const scanned = part.geometry.clone().applyMatrix4(part.matrixWorld);
        const geo = sprig ? clumpCards(scanned, crown, (kind.height[0] + kind.height[1]) / 2 / tall, sprig, 7717 + k * 131) : scanned;
        geo.setAttribute('leafCrown', new THREE.InstancedBufferAttribute(new Float32Array(mats.length * 4), 4));
        geo.setAttribute('leafCrownH', new THREE.InstancedBufferAttribute(new Float32Array(mats.length), 1));
        const inst = new THREE.InstancedMesh(geo, m, mats.length);
        inst.userData.crown = crown;
        inst.userData.leaf = leaf;
        mats.forEach((x, i) => {
          inst.setMatrixAt(i, x);
          putCrown(inst, i, x, entry.tints[i]);
        });
        inst.count = which === 'far' ? mats.length : 0;
        inst.instanceMatrix.needsUpdate = true;
        inst.computeBoundingSphere();
        // (instances move between the two per frame: no culling against a stale sphere)
        inst.frustumCulled = false;
        inst.castShadow = true;
        inst.receiveShadow = true;
        inst.name = `forest-edge-${kind.id}-${which}`;
        group.add(inst);
        entry[which].push(inst);
      }
    };
    loads.push(loader.loadAsync(`${base}${kind.id}/${kind.id}_lod.glb`).then((g) => build(g, 'far')));
    // (the Pachira too: its LOD's collapsed leaves were shards at 25 m, the scrub the walk passes closest)
    loads.push(loader.loadAsync(`${base}${kind.id}/${kind.id}_2k.gltf`).then((g) => build(g, 'near')));
  });
  const setEye = (eye: THREE.Vector3): void => {
    for (const e of lods) {
      if (!e.near.length || !e.mats.length) continue;
      let n = 0;
      let f = 0;
      e.spots.forEach((t, i) => {
        const near = Math.hypot(t.x - eye.x, t.z - eye.z) < NEAR;
        const slot = near ? n : f;
        for (const m of near ? e.near : e.far) {
          m.setMatrixAt(slot, e.mats[i]);
          putCrown(m, slot, e.mats[i], e.tints[i]);
        }
        if (near) n++;
        else f++;
      });
      for (const m of e.near) {
        m.count = n;
        m.instanceMatrix.needsUpdate = true;
      }
      for (const m of e.far) {
        m.count = f;
        m.instanceMatrix.needsUpdate = true;
      }
      for (const m of [...e.near, ...e.far]) {
        m.geometry.getAttribute('leafCrown').needsUpdate = true;
        m.geometry.getAttribute('leafCrownH').needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
    }
  };
  return { group, feet, setEye };
}

/**
 * THE LITTER on the ground (beachMaterial.ts setLitter): the forest floor where the trees stand (from `edge` m in
 * from the shore, its line wandering), and round every foot in `feet` (x, z, radius m) a pool of fallen leaves —
 * fronds and husks under a palm — fading out over its radius. LITTER_RES² weights over the square from `origin`,
 * `size` m on a side.
 */
export function litterMask(isl: ForestIsland, feet: Array<[number, number, number]>, origin: [number, number], size: number, edge: [number, number] = [14, 22]): Uint8Array {
  const n = LITTER_RES;
  const cell = size / n;
  const w = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const z = origin[1] + (j + 0.5) * cell;
    for (let i = 0; i < n; i++) {
      const x = origin[0] + (i + 0.5) * cell;
      const wander = 4 * (fbm2Cpu(x / 9, z / 9, 3) - 0.5);
      const e = Math.min(1, Math.max(0, (isl.inland(x, z) + wander - edge[0]) / (edge[1] - edge[0])));
      w[j * n + i] = e * e * (3 - 2 * e);
    }
  }
  for (const [fx, fz, r] of feet) {
    const ci = (fx - origin[0]) / cell;
    const cj = (fz - origin[1]) / cell;
    const k = Math.ceil((r * 1.6) / cell);
    for (let j = Math.max(0, Math.floor(cj - k)); j <= Math.min(n - 1, Math.ceil(cj + k)); j++) {
      for (let i = Math.max(0, Math.floor(ci - k)); i <= Math.min(n - 1, Math.ceil(ci + k)); i++) {
        const d2 = ((i + 0.5 - ci) ** 2 + (j + 0.5 - cj) ** 2) * cell * cell;
        // (a pool: full under the plant, falling off toward its radius — the review's bases had a faint ring)
        const v = Math.exp(-Math.pow(d2 / (r * r), 1.4));
        const idx = j * n + i;
        w[idx] = 1 - (1 - w[idx]) * (1 - v);
      }
    }
  }
  const out = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) {
    // (patchy: bare sand shows through in places)
    const x = origin[0] + ((i % n) + 0.5) * cell;
    const z = origin[1] + (((i / n) | 0) + 0.5) * cell;
    const patch = 0.7 + 0.3 * fbm2Cpu(x / 2.3 + 17, z / 2.3, 2);
    out[i] = Math.round(255 * Math.min(1, w[i] * patch));
  }
  return out;
}

/**
 * The trees on `islands` (coast.ts). The first is ours: fine cells and leaf cards where the eye passes (`walk`:
 * the world box along the beach the eye sees the forest's edge from at close range).
 */
export function createForest(
  islands: ForestIsland[],
  walk: { x: [number, number]; z: [number, number] },
  /** the terrain's haze put on a material (islandMaterials.ts aerialOutput): the trees melt into the air as their
   * ground does */
  aerial: (m: THREE.Material) => void,
  base = `${import.meta.env.BASE_URL}drift/pbr/`,
): Forest {
  const group = new THREE.Group();
  group.name = 'drift-forest';
  const sun = new THREE.Vector3(0, 1, 0);
  const shellMat = canopyMaterial(sun);
  aerial(shellMat);
  // THE FAR MOTUS' CANOPY in the air in front of them (farAir.ts), as their ground and towers are (coast.ts): on the
  // terrain's haze curve, which melts toward the horizon's mean colour, motu 1 (1.45 km, 78° left of the beach's
  // front) came out "a small island with a tower that is entirely white, even though an even further island looks
  // correct" (the user, 2026-11-01, of the view going ashore) — the high island beyond it already on farAir
  const farShellMat = canopyMaterial(sun);
  farShellMat.fog = false;
  farAir.air.output(farShellMat);
  const farLightU = farShellMat.userData.light as THREE.UniformNode<'color', THREE.Color>;
  const sunU = shellMat.userData.sun as THREE.UniformNode<'vec3', THREE.Vector3>;
  const lightU = shellMat.userData.light as THREE.UniformNode<'color', THREE.Color>;
  const loads: Promise<unknown>[] = [];
  const feet: Array<[number, number, number]> = [];
  const eyeSetters: Array<(eye: THREE.Vector3) => void> = [];
  islands.forEach((isl, n) => {
    const ours = n === 0;
    // (ours lower and broader than it was, 7–13 m, not 9–17: the palms stand out of it — palms.ts — as on a real
    // motu; its far cells 2 m, not 3, so a crown's lobes and leaf masses show on the skyline: THE CANOPY AS A MOTU'S)
    const stand: Stand = ours
      ? { spacing: 6.2, top: [7, 13], radius: [3.4, 7], edge: [27, 46], cell: [0.6, 2], seed: 11, emergent: 0.015, heads: false }
      : // (the far motus' trees growing up over 70 m from their shores, so each island's ends taper down to its
        // rim and its line is a low mound of trees, not a slab with square ends)
        { spacing: 6.8, top: [8, 15], radius: [3.4, 6.6], edge: [12, 80], cell: [2.5, 2.5], seed: 23 + n, emergent: 0.09, heads: true };
    const geo = shellGeometry(isl, stand, ours ? walk : isl.box);
    const mesh = new THREE.Mesh(geo, ours ? shellMat : farShellMat);
    mesh.name = `forest-${isl.name}`;
    mesh.castShadow = ours;
    mesh.receiveShadow = ours;
    group.add(mesh);
    if (ours) {
      const edge = edgeTrees(isl, walk, base, loads, sunU);
      group.add(deadTrees(isl, walk, base, loads, aerial));
      group.add(edge.group);
      feet.push(...edge.feet);
      eyeSetters.push(edge.setEye);
      const leaves = leafCards(geo, walk, sunU, lightU, base, loads);
      aerial(leaves.material as THREE.Material);
      group.add(leaves);
    }
  });
  return {
    group,
    ready: Promise.all(loads).then(() => undefined),
    feet,
    setEye(eye) {
      for (const f of eyeSetters) f(eye);
    },
    setSun(s, light) {
      sun.copy(s);
      sunU.value.copy(s);
      lightU.value.copy(light);
      farLightU.value.copy(light);
    },
  };
}
