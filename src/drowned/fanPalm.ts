/**
 * TALL FAN PALMS — Washingtonia robusta, the Mexican fan palm every Los Angeles street is planted with — standing
 * in the sea: living, dying and dead. One builder for the film and, later, the Raft 2100 game: a list of palms in, a
 * group out. Our own geometry throughout (the beach's palms are BlenderKit models, licensed for renders, not to be
 * passed on: palms.ts), so the game may ship it.
 *
 * WHY (drift-narrative/wandering-on/sunken-world-cues.md, cue 5, "a drowned boulevard": "a straight ROW of tall fan
 * palms … standing in the water off the beach. Palms planted in a line are a street; in LA every viewer reads them";
 * the user, 2026-10-29: "without someone telling me the story it doesn't become apparent that this is what happened").
 *
 * THE TREE, from the species (W. robusta: to 25–30 m, a slender grey trunk ~0.5 m across at its swollen foot and
 * ~0.3 m under the crown, finely ringed; a compact crown ~4 m across of costapalmate leaves on ~1 m petioles, each
 * blade ~1 m, split about half way into ~60 drooping segments; the dead leaves kept as a hanging skirt unless
 * trimmed) and from what salt water does to it (salt-killed palms on storm-flooded shores: the crown browning from
 * the oldest leaves up, the leaves collapsing to hang grey along the trunk, then the head snapping off to leave a
 * bleached pole):
 *
 *   live     a green crown — young leaves upright, the mature ones out and drooping at their tips, the old ones
 *            yellowing below — over a skirt of dead leaves hanging grey-brown
 *   dying    a few yellow-green leaves at the top, the rest brown and drooping, a heavy skirt
 *   dead     the crown collapsed: grey leaves hanging, a few broken ones still out, ragged
 *   snag     the bare pole, its top snapped and jagged — or a stump
 *   fallen   a trunk down, lying from where it broke (its foot: a stump's top) across into the water, a few grey
 *            leaves left at its head
 *
 * GEOMETRY. Each trunk a tube along its own gently bent axis (the lean a dead palm settles into, a living one's
 * curving back up toward the light), merged into one mesh. Each leaf an instance of one of five leaf shapes
 * (`LEAF`): a petiole arcing out, the fan's segments radiating from its tip, each segment V-folded along its rib,
 * joined to its neighbours to `split` of its length and free beyond, drooping toward its tip; torn short on a share
 * of them (`torn`), drawn together where a dead leaf hangs (`clump`). No alpha cut: a leaf is its own triangles, so
 * it never sparkles as a cut card does at a dome face's pixel (palms.ts's alpha-to-coverage note).
 *
 * LIGHT. The leaves are lit through as palms.ts's are (a thin leaf glows with the Sun behind it), from a caller's
 * light (`FanPalmOptions.light`, the same three vectors palms.ts takes: the film hands it the beach palms' own); the
 * trunk under the water wears the sea's look (drownedLook.ts) up to its crust at the waterline.
 *
 * THE WIND: every part bends downwind with its height² as palms.ts's do (SWAY), the leaves fluttering each on a phase
 * of its own — a pure function of the time it is given (`setTime`).
 *
 * Positions are kept LOCAL to `origin` (the group stands there): see town.ts.
 */
import * as THREE from 'three/webgpu';
import { atan, attribute, cameraPosition, diffuseColor, float, length, mix, normalWorld, normalWorldGeometry, positionLocal, positionWorld, sin, smoothstep, uniform, vec2, vec3 } from 'three/tsl';
import { createRng } from '../state/rng';
import { drownedLook, fadedField, seedOf } from './drownedLook';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node unions
type Node = any;

export type FanPalmState = 'live' | 'dying' | 'dead' | 'snag' | 'fallen';

export interface FanPalmSpec {
  /** m: its foot, world x, z */
  x: number;
  z: number;
  /** m: world y it rises from (the sand, the ground; a fallen one: the top of the stump it broke from) */
  foot: number;
  /** m: the ground's height under it, where the sand drifts against it (default `foot`) */
  sand?: number;
  /** m: from its foot to the heart of its crown (a snag: to its broken top; a fallen one: its length) */
  height: number;
  /** rad from the vertical (past π/2 a fallen trunk runs down into the water), and the world bearing it leans
   * toward (atan2(z, x)) */
  lean: number;
  leanDir: number;
  state: FanPalmState;
  seed: number;
}

export interface FanPalmOptions {
  /** m: world x, z the group stands at (geometry is kept relative to it) */
  origin: [number, number];
  /** the light the leaves pass (palms.ts's: unit toward the Sun; the Sun's and the sky's radiance on a white surface).
   * Set per frame by the caller; absent, the leaves are lit as any surface is */
  light?: { sun: THREE.Vector3; sunLight: THREE.Vector3; skyLight: THREE.Vector3 };
  /** the wind the crowns bend in: unit, world x, z (default toward −z, the film's light air: palms.ts WIND) */
  wind?: [number, number];
  /** they cast the Sun's shadow (default true) */
  castShadow?: boolean;
}

/** a leaf shape (m at unit scale; rad) */
interface LeafShape {
  /** the fan's segments, and its half-spread about the petiole's line */
  segs: number;
  spread: number;
  /** m: a middle segment's length, and the petiole's */
  blade: number;
  petiole: number;
  /** rad: the petiole's rise from the leaf's own line, at its foot */
  arch: number;
  /** share of a segment's length its tip drops by (the side segments a half more) */
  droop: number;
  /** share of a segment's length it is joined to its neighbours for */
  split: number;
  /** the V of each segment's fold, as a share of its half-width */
  fold: number;
  /** 0..1: free segments drawn together (a dead leaf hanging: its fan closed) */
  clump: number;
  /** share of the segments torn short */
  torn: number;
}

export type LeafKind = 'young' | 'mature' | 'old' | 'hanging' | 'broken';
export const LEAF: Record<LeafKind, LeafShape> = {
  young: { segs: 18, spread: 1.6, blade: 0.85, petiole: 0.9, arch: 0.15, droop: 0.12, split: 0.62, fold: 0.45, clump: 0.25, torn: 0 },
  mature: { segs: 20, spread: 2.15, blade: 1.0, petiole: 1.05, arch: 0.25, droop: 0.38, split: 0.55, fold: 0.35, clump: 0, torn: 0.06 },
  old: { segs: 20, spread: 2.05, blade: 1.0, petiole: 1.15, arch: 0.1, droop: 0.62, split: 0.5, fold: 0.3, clump: 0.1, torn: 0.25 },
  hanging: { segs: 16, spread: 0.7, blade: 0.95, petiole: 1.0, arch: 0.05, droop: 0.08, split: 0.42, fold: 0.25, clump: 0.65, torn: 0.35 },
  broken: { segs: 14, spread: 1.7, blade: 0.8, petiole: 0.75, arch: -0.1, droop: 0.85, split: 0.45, fold: 0.2, clump: 0.3, torn: 0.6 },
};

/** linear albedos of a leaf by what it is now (the species' glossy mid-green; straw; dead brown; weathered grey) */
const LEAF_TINT = {
  green: [0.07, 0.13, 0.035],
  yellow: [0.2, 0.18, 0.055],
  straw: [0.25, 0.17, 0.08],
  grey: [0.29, 0.27, 0.23],
} as const;
/** linear albedo of the bark: a living trunk's grey-brown, a dead one's bleached silver-grey */
const BARK = { live: [0.22, 0.19, 0.16], dead: [0.3, 0.285, 0.26] } as const;

/** m: the trunk's radius at its foot (the swollen base), along it, under the crown; and how far its boots (the old
 * leaf bases) stand out over the top BOOTS m of a living trunk */
const TRUNK = { foot: 0.4, mid: 0.22, top: 0.18, boots: 0.12, bootLength: 2.2 };
/** the trunk's rings and sides */
const RINGS = 44;
const SIDES = 10;
/** the wind: m the crown moves at a 10 m height (downwind, across) — palms.ts SWAY; m per m of reach a leaf flutters */
const SWAY = { crown: 0.14, across: 0.04, flutter: 0.03 };
/** the share of the light a green leaf lets through (palms.ts TRANSMIT) */
const TRANSMIT = 0.45;

const smooth = (a: number, b: number, x: number): number => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

/**
 * One leaf at unit scale, in its own frame: its foot at the origin, its line along +x, up +y, its fan's plane x–z.
 * Attributes: `leafR` (0 at the hastula .. 1 at a segment's tip; the petiole −1..0), for the tips' own browning.
 */
export function leafGeometry(kind: LeafKind, seed = 1): THREE.BufferGeometry {
  const L = LEAF[kind];
  const r = createRng(seed * 7919 + kind.length * 104729);
  const pos: number[] = [];
  const rr: number[] = [];
  const idx: number[] = [];
  const vert = (x: number, y: number, z: number, along: number): number => {
    pos.push(x, y, z);
    rr.push(along);
    return pos.length / 3 - 1;
  };
  // THE PETIOLE: a thin four-sided stalk on a quadratic arc from the foot to the hastula
  const H = new THREE.Vector3(L.petiole * Math.cos(L.arch), L.petiole * Math.sin(L.arch) - 0.12 * L.petiole, 0);
  const ctrl = new THREE.Vector3(L.petiole * 0.5, L.petiole * 0.5 * Math.tan(L.arch) + 0.02, 0);
  // (a quadratic Bézier from the foot, through `ctrl`, to the hastula)
  const at = (u: number): THREE.Vector3 => new THREE.Vector3().addScaledVector(ctrl, 2 * u * (1 - u)).addScaledVector(H, u * u);
  const PET = 5;
  const pr = 0.022;
  for (let i = 0; i <= PET; i++) {
    const c = at(i / PET);
    const w = pr * (1 - 0.4 * (i / PET));
    vert(c.x, c.y + w, c.z, -1 + i / PET);
    vert(c.x, c.y, c.z + w, -1 + i / PET);
    vert(c.x, c.y - w, c.z, -1 + i / PET);
    vert(c.x, c.y, c.z - w, -1 + i / PET);
  }
  for (let i = 0; i < PET; i++) {
    for (let k = 0; k < 4; k++) {
      const a = i * 4 + k;
      const b = i * 4 + ((k + 1) % 4);
      idx.push(a, a + 4, b, b, a + 4, b + 4);
    }
  }
  // THE BLADE: segments radiating from the hastula in the fan's plane, about the petiole's own line there
  const tdir = new THREE.Vector3().subVectors(H, ctrl).normalize();
  const side = new THREE.Vector3(0, 0, 1);
  const up = new THREE.Vector3().crossVectors(side, tdir).normalize();
  const ROWS = [0, 0.22, 0.45, 0.62, 0.8, 1];
  const n = L.segs;
  const step = (2 * L.spread) / n;
  const P = new THREE.Vector3();
  for (let s = 0; s < n; s++) {
    const phi0 = -L.spread + (s + 0.5) * step;
    const torn = r() < L.torn;
    const end = torn ? L.split + (1 - L.split) * (0.15 + 0.5 * r()) : 1;
    const own = 0.85 + 0.3 * r();
    const len = L.blade * (0.62 + 0.38 * Math.cos(phi0 * 0.75)) * own;
    const sideDroop = 1 + 0.6 * Math.abs(phi0) / Math.max(L.spread, 1e-3);
    const tipHang = 0.6 + 0.8 * r();
    const row: number[][] = [];
    for (const u0 of ROWS) {
      const u = Math.min(u0, end);
      // free of its neighbours past `split`: the fan closes toward its middle as a dead leaf's does (clump), the
      // segment narrowing to its tip
      const free = smooth(L.split * 0.8, 1, u);
      const phi = phi0 * (1 - L.clump * free);
      const halfAng = (step / 2) * (1 - 0.85 * smooth(L.split, 1, u)) * (1 - L.clump * free * 0.6);
      const dist = u * len;
      const drop = L.droop * len * Math.pow(smooth(0.2, 1, u), 1.6) * sideDroop * (u > L.split ? tipHang : 1);
      // the costapalmate arch: the halves fall away from the rib
      const arch = 0.18 * len * u * Math.pow(Math.abs(phi0) / Math.max(L.spread, 1e-3), 1.3);
      const fold = L.fold * dist * Math.sin(halfAng);
      const ids: number[] = [];
      for (const k of [-1, 0, 1]) {
        const a = phi + k * halfAng;
        P.copy(H).addScaledVector(tdir, Math.cos(a) * dist).addScaledVector(side, Math.sin(a) * dist).addScaledVector(up, -drop - arch - (k === 0 ? fold : 0));
        ids.push(vert(P.x, P.y, P.z, u));
      }
      row.push(ids);
      if (u0 >= end) break;
    }
    for (let i = 0; i < row.length - 1; i++) {
      const [a0, a1, a2] = row[i];
      const [b0, b1, b2] = row[i + 1];
      idx.push(a0, b0, a1, a1, b0, b1, a1, b1, a2, a2, b1, b2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('leafR', new THREE.Float32BufferAttribute(rr, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** a crown's leaves: kind, its bearing round the crown (rad), its rise from level (rad), how far under the crown's
 * heart it springs (m), its size, and its colour's mix toward the next stage (0..1) */
interface Leaf {
  kind: LeafKind;
  bearing: number;
  rise: number;
  below: number;
  scale: number;
  tint: [number, number, number];
  /** 0..1: how much light a green leaf passes */
  live: number;
}

const mixTint = (a: readonly number[], b: readonly number[], k: number): [number, number, number] => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

/** the crown of a palm in `state` (seeded), from its oldest leaf at the bottom of the skirt to the spear */
export function crownOf(state: FanPalmState, seed: number): Leaf[] {
  if (state === 'snag') return [];
  const D = Math.PI / 180;
  if (state === 'fallen') {
    // (a few broken grey leaves splayed at its head, in and on the water)
    const r = createRng(seed * 31 + 17);
    return Array.from({ length: 3 + Math.floor(r() * 3) }, (_, i) => ({ kind: 'broken' as LeafKind, bearing: i * 2.39996 + r(), rise: (-25 + 40 * r()) * D, below: 0, scale: 0.8 + 0.2 * r(), tint: mixTint(LEAF_TINT.grey, LEAF_TINT.straw, r() * 0.3), live: 0 }));
  }
  const r = createRng(seed * 31 + 17);
  const out: Leaf[] = [];
  const golden = 2.39996;
  let b = r() * Math.PI * 2;
  const add = (kind: LeafKind, n: number, rise: [number, number], below: [number, number], tint: () => [number, number, number], live: number, scale = 1): void => {
    for (let i = 0; i < n; i++) {
      b += golden + (r() - 0.5) * 0.4;
      const k = n > 1 ? i / (n - 1) : 0.5;
      out.push({ kind, bearing: b, rise: rise[0] + (rise[1] - rise[0]) * (k * 0.7 + r() * 0.3), below: below[0] + (below[1] - below[0]) * r(), scale: scale * (0.88 + 0.24 * r()), tint: tint(), live });
    }
  };
  if (state === 'live') {
    add('hanging', 9 + Math.floor(r() * 5), [-86 * D, -74 * D], [0.5, 2.2], () => mixTint(LEAF_TINT.straw, LEAF_TINT.grey, 0.3 + 0.5 * r()), 0);
    add('old', 4 + Math.floor(r() * 3), [-28 * D, 2 * D], [0.05, 0.3], () => mixTint(LEAF_TINT.yellow, LEAF_TINT.straw, r() * 0.7), 0.3);
    add('mature', 9 + Math.floor(r() * 4), [8 * D, 42 * D], [-0.05, 0.12], () => mixTint(LEAF_TINT.green, LEAF_TINT.yellow, r() * 0.25), 1);
    add('young', 3 + Math.floor(r() * 2), [52 * D, 76 * D], [-0.35, -0.15], () => mixTint(LEAF_TINT.green, LEAF_TINT.yellow, r() * 0.15), 1, 0.9);
  } else if (state === 'dying') {
    add('hanging', 12 + Math.floor(r() * 5), [-87 * D, -72 * D], [0.4, 2.6], () => mixTint(LEAF_TINT.straw, LEAF_TINT.grey, 0.4 + 0.5 * r()), 0);
    add('old', 6 + Math.floor(r() * 3), [-35 * D, -5 * D], [0.0, 0.3], () => mixTint(LEAF_TINT.straw, LEAF_TINT.yellow, r() * 0.5), 0.15);
    add('mature', 3 + Math.floor(r() * 2), [10 * D, 35 * D], [-0.05, 0.1], () => mixTint(LEAF_TINT.yellow, LEAF_TINT.green, 0.3 + r() * 0.4), 0.6);
    add('young', 1, [55 * D, 70 * D], [-0.3, -0.2], () => mixTint(LEAF_TINT.yellow, LEAF_TINT.green, 0.4), 0.6, 0.8);
  } else {
    add('hanging', 8 + Math.floor(r() * 5), [-88 * D, -70 * D], [0.2, 1.6], () => mixTint(LEAF_TINT.grey, LEAF_TINT.straw, r() * 0.35), 0, 0.95);
    add('broken', 3 + Math.floor(r() * 4), [-40 * D, 5 * D], [-0.05, 0.25], () => mixTint(LEAF_TINT.grey, LEAF_TINT.straw, r() * 0.3), 0, 0.9);
  }
  return out;
}

/** the axis of a trunk at s (0 foot .. 1 crown), world-relative to its foot (m) */
export function trunkAxis(p: FanPalmSpec, s: number, out = new THREE.Vector3()): THREE.Vector3 {
  // a living palm leaning curves back toward the vertical as it grew (phototropism); a dead one has settled
  // straight along its lean; and every trunk a gentle wander of its own (±~1% of its height). The tilt is integrated
  // along the trunk (its angle lean·(1 − back·u²) at u), so a fallen one's ~100° comes out as long as it is
  const r = seedOf(p.seed);
  const back = p.state === 'live' || p.state === 'dying' ? 0.55 : p.state === 'fallen' ? 0 : 0.15;
  const h = p.height;
  const n = 16;
  let across = 0;
  let up = 0;
  for (let i = 0; i < n; i++) {
    const u = ((i + 0.5) / n) * s;
    const a = p.lean * (1 - back * u * u);
    across += (Math.sin(a) * s) / n;
    up += (Math.cos(a) * s) / n;
  }
  const wander = 0.012 * h * Math.sin(Math.PI * s * (1.3 + r)) * Math.sin(r * 9.1);
  const cx = Math.cos(p.leanDir);
  const cz = Math.sin(p.leanDir);
  return out.set(cx * across * h - cz * wander, up * h, cz * across * h + cx * wander);
}

/** m: the trunk's radius at s; the boots of a living or dying one under its crown */
export function trunkRadius(p: FanPalmSpec, s: number): number {
  const h = p.height;
  const fromFoot = s * h;
  const flare = (TRUNK.foot - TRUNK.mid) * Math.exp(-fromFoot / 0.9);
  const body = TRUNK.mid + (TRUNK.top - TRUNK.mid) * s;
  const boots = p.state === 'live' || p.state === 'dying' ? TRUNK.boots * smooth(h - TRUNK.bootLength, h - 0.3, fromFoot) : 0;
  // (a snag thins to its rotten break; a fallen trunk broke above its foot's flare, which stands as the stump)
  const pencil = p.state === 'snag' ? 1 - 0.35 * smooth(0.82, 1, s) : 1;
  if (p.state === 'fallen') return body * pencil;
  return (body + flare + boots) * pencil;
}

export interface FanPalms {
  readonly group: THREE.Group;
  /** s: the time the wind in them runs on */
  setTime(t: number): void;
  /** where each crown's heart is (world), for a caller's checks (clearances, framing) */
  readonly crowns: ReadonlyArray<[number, number, number]>;
}

export function buildFanPalms(palms: readonly FanPalmSpec[], o: FanPalmOptions): FanPalms {
  const group = new THREE.Group();
  group.name = 'drowned-fan-palms';
  const [ox, oz] = o.origin;
  group.position.set(ox, 0, oz);
  const uTime = uniform(0);
  const wind = o.wind ?? [0, -1];

  /**
   * The sway on every part of a palm: its foot (group frame) and height per vertex or instance (`palmFoot`), and how
   * far up it is (`up`, 0 foot .. 1 crown). palms.ts's sway, at a tall palm's own amplitude.
   */
  const swayAt = (foot: Node, up: Node): Node => {
    const h = foot.w;
    const own = foot.x.mul(0.37).add(foot.z.mul(0.61));
    const gust = sin(uTime.mul(0.9).add(own)).mul(0.6).add(sin(uTime.mul(1.7).add(own.mul(1.7))).mul(0.4)).mul(0.5).add(0.5);
    const across = sin(uTime.mul(0.7).add(own.mul(2.3)));
    const k = up.mul(up).mul(h.div(10));
    const w = vec2(wind[0], wind[1]);
    const bent = w.mul(gust.mul(SWAY.crown)).add(vec2(w.y.negate(), w.x).mul(across.mul(SWAY.across))).mul(k);
    return vec3(bent.x, 0, bent.y);
  };

  // ── THE TRUNKS, one merged mesh ──────────────────────────────────────────────────────────────────────────
  const tPos: number[] = [];
  const tNrm: number[] = [];
  const tFoot: number[] = [];
  const tS: number[] = [];
  const tLen: number[] = [];
  const tSand: number[] = [];
  const tDead: number[] = [];
  const tSeed: number[] = [];
  const tIdx: number[] = [];
  const crowns: Array<[number, number, number]> = [];
  const axis = new THREE.Vector3();
  const ahead = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const nx = new THREE.Vector3();
  const nz = new THREE.Vector3();
  for (const p of palms) {
    const fx = p.x - ox;
    const fz = p.z - oz;
    const r = createRng(p.seed * 131 + 7);
    const base = tPos.length / 3;
    const dead = p.state === 'live' ? 0 : p.state === 'dying' ? 0.4 : 1;
    // (a fallen trunk lies still: no sway — the sway's height is its share)
    const swayH = p.state === 'fallen' ? 0 : p.height;
    const sand = p.sand ?? p.foot;
    // the trunk's frame about an axis it never runs along (a fallen one lies near level)
    const run = trunkAxis(p, 1, new THREE.Vector3()).normalize();
    const ref = Math.abs(run.x) < 0.7 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
    // the snag's jagged break: each side's top a little higher or lower
    const jag = Array.from({ length: SIDES }, () => (p.state === 'snag' ? (r() - 0.5) * 0.5 : 0));
    for (let i = 0; i <= RINGS; i++) {
      // (rings closer near the foot and the waterline, where the growth's bands are)
      const s = Math.pow(i / RINGS, 1.25);
      trunkAxis(p, s, axis);
      trunkAxis(p, Math.min(1, s + 0.01), ahead);
      tangent.subVectors(ahead, trunkAxis(p, Math.max(0, s - 0.01), nz)).normalize();
      nx.copy(ref).addScaledVector(tangent, -ref.dot(tangent)).normalize();
      nz.crossVectors(nx, tangent).normalize();
      const rad = trunkRadius(p, s);
      for (let k = 0; k < SIDES; k++) {
        const a = (k / SIDES) * Math.PI * 2;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const lift = i === RINGS ? jag[k] : 0;
        tPos.push(fx + axis.x + (nx.x * ca + nz.x * sa) * rad, p.foot + axis.y + lift + (nx.y * ca + nz.y * sa) * rad, fz + axis.z + (nx.z * ca + nz.z * sa) * rad);
        tNrm.push(nx.x * ca + nz.x * sa, nx.y * ca + nz.y * sa, nx.z * ca + nz.z * sa);
        tFoot.push(fx, p.foot, fz, swayH);
        tS.push(s);
        tLen.push(p.height);
        tSand.push(sand);
        tDead.push(dead);
        tSeed.push(seedOf(p.seed));
      }
    }
    for (let i = 0; i < RINGS; i++) {
      for (let k = 0; k < SIDES; k++) {
        const a = base + i * SIDES + k;
        const b = base + i * SIDES + ((k + 1) % SIDES);
        tIdx.push(a, b, a + SIDES, b, b + SIDES, a + SIDES);
      }
    }
    // the top: a snag's rotten point, a crowned trunk's closed under its leaves
    const top = trunkAxis(p, 1, axis);
    trunkAxis(p, 0.98, ahead);
    tangent.subVectors(top, ahead).normalize();
    const apex = tPos.length / 3;
    const cap = p.state === 'snag' ? 0.15 : 0.1;
    tPos.push(fx + top.x + tangent.x * cap, p.foot + top.y + tangent.y * cap, fz + top.z + tangent.z * cap);
    tNrm.push(tangent.x, tangent.y, tangent.z);
    tFoot.push(fx, p.foot, fz, swayH);
    tS.push(1);
    tLen.push(p.height);
    tSand.push(sand);
    tDead.push(dead);
    tSeed.push(seedOf(p.seed));
    for (let k = 0; k < SIDES; k++) tIdx.push(base + RINGS * SIDES + k, base + RINGS * SIDES + ((k + 1) % SIDES), apex);
    if (p.state !== 'snag') crowns.push([p.x + top.x, p.foot + top.y, p.z + top.z]);
  }
  const trunkGeo = new THREE.BufferGeometry();
  trunkGeo.setAttribute('position', new THREE.Float32BufferAttribute(tPos, 3));
  trunkGeo.setAttribute('normal', new THREE.Float32BufferAttribute(tNrm, 3));
  trunkGeo.setAttribute('palmFoot', new THREE.Float32BufferAttribute(tFoot, 4));
  trunkGeo.setAttribute('palmS', new THREE.Float32BufferAttribute(tS, 1));
  trunkGeo.setAttribute('palmLen', new THREE.Float32BufferAttribute(tLen, 1));
  trunkGeo.setAttribute('palmSand', new THREE.Float32BufferAttribute(tSand, 1));
  trunkGeo.setAttribute('palmDead', new THREE.Float32BufferAttribute(tDead, 1));
  trunkGeo.setAttribute('palmSeed', new THREE.Float32BufferAttribute(tSeed, 1));
  trunkGeo.setIndex(tIdx);
  trunkGeo.computeBoundingSphere();

  const trunkMat = new THREE.MeshStandardNodeMaterial();
  trunkMat.name = 'drowned-palm-trunk';
  {
    const s = attribute('palmS', 'float');
    const foot = attribute('palmFoot', 'vec4');
    const dead = attribute('palmDead', 'float');
    const seed = attribute('palmSeed', 'float');
    const len = attribute('palmLen', 'float');
    const along = s.mul(len);
    // (round the trunk the patterns read its local x, z — a circle in the noise's plane, continuous all the way round;
    // an angle from atan would step at ±π, and a pattern's footprint (its derivative) with it, ruling a seam up it)
    const round = positionLocal.xz.sub(foot.xz);
    // THE BARK: fine leaf-scar rings up it (faded to their mean once under a couple of pixels), long shallow fissures,
    // and the wander of its own weathering
    const ring = fadedField(vec2(along.mul(14), seed.mul(5)), 1);
    const fissure = fadedField(round.mul(9).add(vec2(along.mul(0.35), seed.mul(13))), 2);
    const patch = fadedField(round.mul(2.5).add(vec2(along.mul(0.2), seed.mul(7).add(3))), 2);
    const bark = mix(vec3(...BARK.live), vec3(...BARK.dead), dead)
      .mul(ring.mul(0.25).add(0.88))
      .mul(smoothstep(0.25, 0.6, fissure).mul(0.3).add(0.75))
      .mul(patch.mul(0.3).add(0.85));
    // the boots under a living crown: darker, rougher, browner
    const boots = smoothstep(len.sub(TRUNK.bootLength), len.sub(TRUNK.bootLength * 0.6), along).mul(float(1).sub(dead));
    const albedo = mix(bark, vec3(0.16, 0.11, 0.07).mul(fissure.mul(0.5).add(0.75)), boots.mul(0.85));
    const look = drownedLook({
      albedo,
      rough: float(0.85),
      p: positionLocal,
      y: positionWorld.y,
      n: normalWorldGeometry,
      overSand: positionWorld.y.sub(attribute('palmSand', 'float')),
      seed,
    });
    trunkMat.colorNode = look.albedo;
    trunkMat.roughnessNode = look.rough;
    trunkMat.metalness = 0;
    trunkMat.positionNode = positionLocal.add(swayAt(foot, s));
  }
  const trunks = new THREE.Mesh(trunkGeo, trunkMat);
  trunks.name = 'drowned-palm-trunks';
  trunks.castShadow = o.castShadow ?? true;
  trunks.receiveShadow = true;
  group.add(trunks);

  // ── THE LEAVES, one instanced mesh per leaf shape ────────────────────────────────────────────────────────────
  const light = o.light;
  const uSun = light ? uniform(light.sun) : null;
  const uSunLight = light ? uniform(light.sunLight) : null;
  const uSkyLight = light ? uniform(light.skyLight) : null;
  const leafMat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide });
  leafMat.name = 'drowned-palm-leaf';
  {
    const tint = attribute('leafTint', 'vec3');
    const live = attribute('leafLive', 'float');
    const foot = attribute('palmFoot', 'vec4');
    const crown = attribute('palmCrown', 'vec3');
    const lr = attribute('leafR', 'float');
    // a leaf's tips brown first, its petiole straw-coloured
    const tip = smoothstep(0.7, 1, lr).mul(float(1).sub(live.mul(0.6)));
    const albedo = mix(mix(tint, vec3(...LEAF_TINT.straw), tip.mul(0.6)), vec3(...LEAF_TINT.straw).mul(0.9), smoothstep(0.02, -0.02, lr).mul(0.6));
    leafMat.colorNode = albedo;
    leafMat.roughnessNode = mix(float(0.85), float(0.55), live);
    leafMat.metalness = 0;
    if (uSun && uSunLight && uSkyLight) {
      // A LEAF IS LIT THROUGH (palms.ts leafOf): the Sun behind it glows through, brightest looking toward it, and the
      // bright sky above; a green leaf passes the most, a dead one next to none
      const toEye = cameraPosition.sub(positionWorld).normalize();
      const nv = normalWorld.dot(toEye);
      const nl = normalWorld.dot(uSun);
      const backlit = nv.mul(nl).negate().max(0).sqrt();
      const toward = toEye.negate().dot(uSun).max(0).pow(4);
      const sky = toEye.negate().y.max(0);
      const through = uSunLight.mul(backlit.mul(float(0.5).add(toward.mul(1.5)))).add(uSkyLight.mul(sky.add(0.8)));
      leafMat.emissiveNode = diffuseColor.rgb.mul(vec3(1.1, 1.3, 0.6)).mul(through).mul(live.mul(0.85).add(0.15)).mul(TRANSMIT);
    }
    // (positionNode runs after the instance transform: the leaf's vertex in the group's frame)
    const rel = positionLocal.sub(crown);
    const reach = length(rel.xz);
    const bearing = atan(rel.z, rel.x);
    const own = foot.x.mul(0.37).add(foot.z.mul(0.61));
    const flap = sin(uTime.mul(2.6).add(bearing.mul(5)).add(own)).mul(0.7).add(sin(uTime.mul(4.1).add(bearing.mul(3)).add(own.mul(0.5))).mul(0.3));
    leafMat.positionNode = positionLocal
      .add(swayAt(foot, float(1)))
      .add(vec3(0, flap.mul(reach.mul(SWAY.flutter)).mul(smoothstep(0.4, 2.2, reach)).mul(live.mul(0.6).add(0.4)), 0));
  }
  const shapes = new Map<LeafKind, THREE.BufferGeometry>();
  const perKind = new Map<LeafKind, Array<{ m: THREE.Matrix4; tint: [number, number, number]; live: number; foot: [number, number, number, number]; crown: [number, number, number] }>>();
  const q = new THREE.Quaternion();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const zAxis = new THREE.Vector3(0, 0, 1);
  for (const p of palms) {
    const leaves = crownOf(p.state, p.seed);
    if (!leaves.length) continue;
    const top = trunkAxis(p, 1, new THREE.Vector3());
    const heart = new THREE.Vector3(p.x - ox + top.x, p.foot + top.y, p.z - oz + top.z);
    const size = 0.95 + 0.2 * seedOf(p.seed + 0.5);
    for (const l of leaves) {
      // springs from the crown's heart (a hand out from the axis), turned to its bearing and raised by its rise
      const at = heart.clone().add(new THREE.Vector3(Math.cos(l.bearing) * 0.16, -l.below, -Math.sin(l.bearing) * 0.16));
      q.setFromAxisAngle(yAxis, l.bearing).multiply(new THREE.Quaternion().setFromAxisAngle(zAxis, l.rise));
      const m = new THREE.Matrix4().compose(at, q, new THREE.Vector3(l.scale * size, l.scale * size, l.scale * size));
      let list = perKind.get(l.kind);
      if (!list) perKind.set(l.kind, (list = []));
      list.push({ m, tint: l.tint, live: l.live, foot: [p.x - ox, p.foot, p.z - oz, p.state === 'fallen' ? 0 : p.height], crown: [heart.x, heart.y, heart.z] });
    }
  }
  for (const [kind, list] of perKind) {
    let g = shapes.get(kind);
    if (!g) shapes.set(kind, (g = leafGeometry(kind, kind.length)));
    const geo = g.clone();
    const tint = new Float32Array(list.length * 3);
    const live = new Float32Array(list.length);
    const foot = new Float32Array(list.length * 4);
    const crown = new Float32Array(list.length * 3);
    list.forEach((l, i) => {
      tint.set(l.tint, i * 3);
      live[i] = l.live;
      foot.set(l.foot, i * 4);
      crown.set(l.crown, i * 3);
    });
    geo.setAttribute('leafTint', new THREE.InstancedBufferAttribute(tint, 3));
    geo.setAttribute('leafLive', new THREE.InstancedBufferAttribute(live, 1));
    geo.setAttribute('palmFoot', new THREE.InstancedBufferAttribute(foot, 4));
    geo.setAttribute('palmCrown', new THREE.InstancedBufferAttribute(crown, 3));
    const inst = new THREE.InstancedMesh(geo, leafMat, list.length);
    list.forEach((l, i) => inst.setMatrixAt(i, l.m));
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = o.castShadow ?? true;
    inst.receiveShadow = true;
    inst.computeBoundingSphere();
    inst.name = `drowned-palm-leaves-${kind}`;
    group.add(inst);
  }
  return {
    group,
    crowns,
    setTime: (t) => void (uTime.value = t),
  };
}
