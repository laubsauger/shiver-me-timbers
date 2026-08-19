/**
 * ISLAND STRUCTURES — jetties, piers and huts.
 *
 * THE GAP THIS CLOSES. The references in docs/inspo/island/ are not landscapes,
 * they are PLACES: ref-island-150 has five or six jetties of wildly different
 * lengths radiating off one sandbar with stilt huts behind them, ref-island-147
 * a pier with a plank ramp running up the beach, ref-island-149 a half-wrecked
 * jetty whose shore end is four loose boards splayed on the sand. The islands
 * shipped with none of it — terrain, rocks, palms and cover, and nothing built.
 * A pier was designed once (see the note in ship/woodMaterial.ts about a pier
 * sharing that material) and never built; this is that, plus the huts.
 *
 * ── THE COST RULE ──────────────────────────────────────────────────────────
 * The frame is CPU-BOUND — draw calls are the scarce resource, triangles and
 * fragments are nearly free. So every structure on an island is ONE MERGED
 * BufferGeometry drawn by ONE Mesh with ONE material shared across the whole
 * world (§V17), LOD-gated as a unit like the rocks. A draw call per hut, or per
 * plank, would be the single worst thing anyone could do to this frame.
 *
 * MERGED, NOT INSTANCED, AND THAT IS THE POINT. Instancing costs the same one
 * draw call but forces every copy to be the same mesh, so all the variety has
 * to be squeezed through the instance transform — which is exactly the failure
 * the palms have ("they read as placed props"). Merging costs the same draw
 * call and buys UNBOUNDED shape variety: every plank on every jetty can have
 * its own length, cant and gap, and a wrecked jetty can be genuinely missing
 * boards rather than scaled differently. The price is CPU build time (once, at
 * island construction) and ~1 MB of buffers per island, neither of which is on
 * the frame budget. Vertices are the resource this project HAS.
 *
 * ── THE MATERIAL IS THE SHIP'S ─────────────────────────────────────────────
 * `createWoodMaterial` (src/ship/woodMaterial.ts) with NO LocalFrame. That is
 * not a shortcut, it is what that file's own doc prescribes: omitting the frame
 * makes `waterLighting` fall back to plain depth-below-surface wetness, "which
 * is what a pier or a hut wants" — a fixed structure's wet band belongs where
 * the water is, not where a hull's drying memory says. Zero samplers, and the
 * dock is made of the same timber as the ship by construction rather than by
 * two palettes being kept in sync by hand.
 *
 * The one thing added on top is a per-vertex `timberTint`, multiplied into the
 * finished colour from HERE rather than by editing that material: it is what
 * lets weathered deck boards, structural timber and the references' red-brown
 * roofs share one draw call. It cannot alias — the tint is constant across a
 * board and the boards do not share vertices, so its only edges are geometric
 * ones the rasteriser already antialiases (§V.48 has nothing to gate).
 *
 * §V2-adjacent: pure f(seed, heightmap, params) through createRng only.
 * §V16: every tunable in params/island.ts. §V28: every divisor floored.
 */
import * as THREE from 'three/webgpu';
import { attribute } from 'three/tsl';
import { createRng, type Rng } from '../state/rng';
import { createWoodMaterial, type ShipMaterialHandle } from '../ship/woodMaterial';
import { islandParams, type IslandParams } from '../params/island';
import { findShoreRadius, gradientAt, type IslandHeightmap } from './heightmap';

/* -------------------------------------------------------------------------
 * PALETTE
 *
 * Multipliers on the wood material's own colour, NOT replacements — so a
 * Tweakpane edit to the ship's timber still moves the docks, and none of these
 * can push a channel anywhere the base palette does not already go.
 *
 * Deliberately near 1.0 except the roof. Two colour bugs on this island came
 * from assuming saturation and value are free axes (a low-chroma yellow-olive
 * that rendered grey-purple because the sky fill out-blued it; purple patches
 * that turned out to be a grazing sky specular and survived a BLACK albedo), so
 * the tints here move value and hue and leave chroma alone wherever they can.
 * ---------------------------------------------------------------------- */

/** structural timber — posts, piles, beams. The base tone, barely touched. */
const TINT_TIMBER: Tint = [1.0, 0.97, 0.92];
/** decking: sun-bleached and greyer. The material bleaches horizontals too. */
const TINT_DECK: Tint = [1.04, 1.02, 0.98];
/** old / wrecked boards: greyer, cooler, down in value */
const TINT_WEATHERED: Tint = [0.84, 0.84, 0.86];
/**
 * Roof boards. The references' roofs are a red-brown that reads at 300 m and is
 * most of what makes a hut cluster legible as a settlement rather than as
 * driftwood. This is the one tint that genuinely moves hue, and it moves it
 * toward the WARM end where the sky fill cannot fight it — the grey-purple bug
 * was a colour with barely more green than the ambient had blue.
 */
const TINT_ROOF: Tint = [1.02, 0.55, 0.36];

type Tint = readonly [number, number, number];

/* -------------------------------------------------------------------------
 * MESH BUILDER
 *
 * Two primitive templates copied and transformed, rather than trigonometry per
 * part: a box for every sawn timber and a cylinder for every round pile. Copying
 * a template keeps the normals exact under non-uniform scale (normal matrix) and
 * keeps the box edges CRISP — a merged `computeVertexNormals()` would round the
 * arris of every plank into mush, which is the opposite of what sawn timber
 * looks like.
 * ---------------------------------------------------------------------- */

interface Builder {
  pos: number[];
  nrm: number[];
  tint: number[];
  idx: number[];
}

const newBuilder = (): Builder => ({ pos: [], nrm: [], tint: [], idx: [] });

/** unit cube, unit cylinder (axis +y). Module-level: built once, never mutated. */
let BOX: THREE.BufferGeometry | null = null;
/** three taper ratios — a driven pile is a tree, not a pipe */
let LOGS: THREE.BufferGeometry[] | null = null;

function boxTemplate(): THREE.BufferGeometry {
  BOX ??= new THREE.BoxGeometry(1, 1, 1);
  return BOX;
}

function logTemplates(): THREE.BufferGeometry[] {
  // 7 radial segments, not 6 or 8: an even count puts a facet edge dead centre
  // on both silhouettes at once, so a lit pile shows one flat highlight down its
  // middle. Odd staggers them. Caps closed — a pile stub is seen end-on.
  LOGS ??= [1.0, 0.82, 0.66].map((taper) => new THREE.CylinderGeometry(taper, 1, 1, 7, 1, false));
  return LOGS;
}

const _m = new THREE.Matrix4();
const _nm = new THREE.Matrix3();
const _v = new THREE.Vector3();
const _p0 = new THREE.Vector3();
const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _u = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _basis = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);
const SIDE = new THREE.Vector3(1, 0, 0);

/** copy a template through `m`, tagging every vertex with `tint` */
function pushTemplate(b: Builder, src: THREE.BufferGeometry, m: THREE.Matrix4, tint: Tint): void {
  const sp = src.getAttribute('position');
  const sn = src.getAttribute('normal');
  const si = src.getIndex();
  if (si === null) throw new Error('pushTemplate: template geometry must be indexed');
  const base = b.pos.length / 3;
  _nm.getNormalMatrix(m);
  for (let i = 0; i < sp.count; i++) {
    _v.fromBufferAttribute(sp, i).applyMatrix4(m);
    b.pos.push(_v.x, _v.y, _v.z);
    _v.fromBufferAttribute(sn, i).applyMatrix3(_nm).normalize();
    b.nrm.push(_v.x, _v.y, _v.z);
    b.tint.push(tint[0], tint[1], tint[2]);
  }
  for (let i = 0; i < si.count; i++) b.idx.push(base + si.getX(i));
}

/**
 * One sawn timber running p0 → p1, `w` wide and `h` deep, optionally rolled
 * about its own length axis. Every plank, beam, rail, brace and wall board in
 * this file is one of these.
 */
function beam(
  b: Builder,
  p0: THREE.Vector3,
  p1: THREE.Vector3,
  w: number,
  h: number,
  tint: Tint,
  roll = 0,
): void {
  _f.subVectors(p1, p0);
  const len = _f.length();
  if (len < 1e-4) return; // §V28: degenerate timber, not a divide by zero
  _f.divideScalar(len);
  // build an orthonormal basis with `up` as the reference, falling back to a
  // horizontal reference when the timber is near-vertical (a stilt or a post)
  const ref = Math.abs(_f.y) > 0.98 ? SIDE : UP;
  _r.crossVectors(ref, _f).normalize();
  _u.crossVectors(_f, _r);
  if (roll !== 0) {
    _q.setFromAxisAngle(_f, roll);
    _r.applyQuaternion(_q);
    _u.applyQuaternion(_q);
  }
  _basis.makeBasis(_r, _u, _f);
  _v.addVectors(p0, p1).multiplyScalar(0.5);
  _m.copy(_basis).setPosition(_v).scale(_v.set(w, h, len));
  pushTemplate(b, boxTemplate(), _m, tint);
}

/** one round pile / post, p0 → p1, tapering toward p1 */
function log(
  b: Builder,
  p0: THREE.Vector3,
  p1: THREE.Vector3,
  radius: number,
  taper: number,
  tint: Tint,
): void {
  _f.subVectors(p1, p0);
  const len = _f.length();
  if (len < 1e-4) return; // §V28
  _f.divideScalar(len);
  _q.setFromUnitVectors(UP, _f);
  _v.addVectors(p0, p1).multiplyScalar(0.5);
  _m.compose(_v, _q, _p0.set(radius, len, radius));
  pushTemplate(b, logTemplates()[taper], _m, tint);
}

/** per-piece tint jitter: no two boards the same, and it decorrelates the
 *  shader's own per-board tone, which is continuous across merged geometry */
function jitterTint(rng: Rng, base: Tint, amount: number): Tint {
  const k = 1 + (rng() * 2 - 1) * amount;
  return [base[0] * k, base[1] * k, base[2] * k];
}

/* -------------------------------------------------------------------------
 * PLANS — pure data, so tests can pin placement without a renderer
 * ---------------------------------------------------------------------- */

export interface JettyPlan {
  /** island-local shore end */
  root: [number, number];
  /** unit direction out to sea */
  dir: [number, number];
  /** deck run (m) from the root, set by the BATHYMETRY — see planJetty */
  length: number;
  width: number;
  /** deck top (m above still water) — a deck is level, so this is one number */
  deckY: number;
  /** 0 = sound and railed, 1 = a wreck with half its boards gone */
  decay: number;
  rail: boolean;
}

export interface HutPlan {
  /** island-local */
  position: [number, number];
  yaw: number;
  /** footprint (m) */
  width: number;
  depth: number;
  /** floor top (m, island-local y) */
  floorY: number;
  wallHeight: number;
  /** ridge rise above the eave (m); 0 ⟹ a flat-ish shed roof */
  roofRise: number;
  /** gable (two slopes) vs shed (one) */
  gable: boolean;
  /** a hut standing in the shallows on stilts, per ref-island-150 */
  overWater: boolean;
}

export interface StructurePlan {
  jetties: JettyPlan[];
  huts: HutPlan[];
}

/** counts scale with FOOTPRINT, exactly as islandPalmCount and the rocks do */
function countForRadius(base: number, hm: IslandHeightmap, p: IslandParams): number {
  const ref = Math.max(p.radius, 1e-3); // §V28 floored divisor
  return Math.max(0, Math.round(base * (hm.worldRadius / ref)));
}

/**
 * Settlement bearings. Built stuff CLUSTERS — the references put every jetty
 * and every hut on one or two stretches of shore and leave the rest of the
 * island empty, which is the same reason `palmGroveAngles` and
 * `cliffGroupAngles` exist. Its own decorrelated stream so a settlement does
 * not land on a headland just because the cliffs did.
 */
export function settlementAngles(seed: number, p: IslandParams = islandParams): number[] {
  const rng = createRng(seed);
  // 0 HONOURED, unlike palmGroveAngles/cliffGroupAngles which floor at 1: those
  // gate a count that is separately zeroable, this one is the only switch there
  // is, so flooring it would make the Tweakpane minimum a lie (§Rule 8).
  const count = Math.max(0, Math.floor(p.structureSettlements));
  const phase = rng();
  const angles: number[] = [];
  for (let i = 0; i < count; i++) {
    angles.push(((i + 0.25 + rng() * 0.5) / count + phase) * Math.PI * 2);
  }
  return angles;
}

/**
 * ONE JETTY, ITS LENGTH READ OFF THE SEABED.
 *
 * The user's note on the references was "the dock structures and the
 * interesting NATURALLY DIFFERENT LENGTHS", and the word doing the work is
 * `naturally`. A random length in a range is not that — it is the same
 * uniform-scatter tell this island has already collected twice. A real jetty is
 * as long as it has to be to reach water a boat floats in, so it walks out from
 * the root a bay at a time and STOPS when the water is deep enough (or when the
 * piles would no longer reach the bottom). A jetty on a steeply shelving shore
 * comes out short and one on a sand flat runs a long way, from one rule, and
 * the variety is the island's own bathymetry rather than a second rng.
 *
 * Returns null when this bearing cannot carry a jetty at all — too steep at the
 * shore (a cliff, not a beach), or the shelf never gets deep enough inside the
 * length limit.
 */
export function planJetty(
  hm: IslandHeightmap,
  angle: number,
  rng: Rng,
  p: IslandParams = islandParams,
): JettyPlan | null {
  const shoreR = findShoreRadius(hm, angle);
  const cx = Math.cos(angle);
  const cz = Math.sin(angle);
  // root sits a little INLAND of the waterline: the ramp bridges the rest
  const rootR = Math.max(shoreR - p.structureRootInset, 0);
  const rootX = cx * rootR;
  const rootZ = cz * rootR;
  // a jetty is built on a beach, not against a cliff
  if (gradientAt(hm, rootX, rootZ) > p.structureShoreSlopeLimit) return null;

  const bay = Math.max(p.structureBayLength, 0.5); // §V28
  /**
   * THE TARGET DEPTH IS PER JETTY, and that is where most of the length spread
   * comes from. Measured without it, a settlement's three jetties came out
   * 16.8, 16.8 and 16.8 m — because a 34 m arc of a 260 m island is 7.5° of
   * bearing and the shore profile barely changes across it, so every walk
   * terminated on the same bay. Physically the jetties are not identical
   * because they are not for the same boat: a skiff wants a metre and a lugger
   * wants three, so each one reaches for its own water and stops there.
   */
  const v = p.structureBerthDepthVar;
  const berth = p.structureBerthDepth * (1 - v + 2 * v * rng());
  let length = 0;
  let reachedDepth = false;
  for (let s = bay; s <= p.structureJettyMaxLength; s += bay) {
    const x = rootX + cx * s;
    const z = rootZ + cz * s;
    const h = hm.heightAt(x, z);
    // past here a pile no longer reaches the bottom — stop, whatever the depth
    if (h < -p.structureMaxPileDepth) break;
    length = s;
    if (h < -berth) {
      reachedDepth = true;
      break;
    }
  }
  if (!reachedDepth || length < p.structureJettyMinLength) return null;

  const decay = rng() < p.structureDecayChance ? 0.45 + rng() * 0.55 : rng() * 0.25;
  // …and a wreck no longer reaches its own berth: the outer bays are the ones
  // the sea takes first, which is exactly what ref-island-149 is a picture of.
  // Applied AFTER the walk so the surviving deck still ends over real water.
  if (decay > 0.4) {
    length = Math.max(p.structureJettyMinLength * 0.7, length * (0.45 + rng() * 0.5));
  }
  return {
    root: [rootX, rootZ],
    dir: [cx, cz],
    length,
    width: p.structureJettyWidth * (0.8 + rng() * 0.5),
    deckY: p.structureDeckHeight * (0.85 + rng() * 0.35),
    decay,
    // a wreck has no handrail left
    rail: decay < 0.35 && rng() < p.structureRailChance,
  };
}

/** bearings tried per jetty before the site is written off — see the note at
 *  the call site for the two islands that shipped with none without it */
const JETTY_ATTEMPTS = 12;

/** a new jetty must not be built through one that is already there */
function tooClose(candidate: JettyPlan, placed: JettyPlan[], p: IslandParams): boolean {
  for (const other of placed) {
    const dx = candidate.root[0] - other.root[0];
    const dz = candidate.root[1] - other.root[1];
    // roots are on the shoreline, so root separation is the alongshore gap —
    // measured against the widest of the two decks plus the clear water a boat
    // needs to lie between them
    if (Math.hypot(dx, dz) < Math.max(candidate.width, other.width) + p.structureJettyGap) {
      return true;
    }
  }
  return false;
}

/**
 * Deterministic structure layout for one island.
 *
 * Jetties come first and the huts cluster on the shore BEHIND them, because
 * that is the causal order in the references: ref-island-150's huts are not
 * scattered over the island, they are the settlement the jetties belong to.
 */
export function generateStructurePlan(
  seed: number,
  hm: IslandHeightmap,
  p: IslandParams = islandParams,
): StructurePlan {
  const rng = createRng(seed);
  const angles = settlementAngles(seed + 5303, p);
  const jetties: JettyPlan[] = [];
  const huts: HutPlan[] = [];

  const perSettlement = Math.max(1, Math.floor(p.structureJettiesPerSettlement));
  const hutBudget = countForRadius(p.structureHutCount, hm, p);
  const radiusForArc = Math.max(hm.worldRadius, 1e-3); // §V28 floored divisor

  for (const centre of angles) {
    const spread = p.structureSettlementSpread / radiusForArc;
    // -- jetties ----------------------------------------------------------
    const want = 1 + Math.floor(rng() * perSettlement);
    for (let j = 0; j < want; j++) {
      /**
       * REJECTION SAMPLING, like islandPalmPlacement, and it is not a nicety.
       * With ONE bearing attempt per jetty, the two `mesaCliff` islands in the
       * shipped world got zero jetties between them — every bearing tried
       * happened to land on ground steeper than `structureShoreSlopeLimit`,
       * which is the right verdict for that bearing and the wrong one for the
       * island. Unlike the palms this does NOT throw when it fails: an island
       * that is cliff all the way round genuinely has nowhere to build, and an
       * empty settlement is a legitimate result rather than a params bug.
       */
      let plan: JettyPlan | null = null;
      for (let attempt = 0; attempt < JETTY_ATTEMPTS && plan === null; attempt++) {
        // triangular jitter, same shape and reason as the palm groves
        const angle = centre + (rng() + rng() - 1) * spread;
        const candidate = planJetty(hm, angle, rng, p);
        // two jetties on the same bearing would be built through each other
        if (candidate !== null && !tooClose(candidate, jetties, p)) plan = candidate;
      }
      if (plan !== null) jetties.push(plan);
    }
  }

  // -- huts: on the shore behind a settlement, and on stilts beside a jetty --
  for (let i = 0; i < hutBudget; i++) {
    const centre = angles[Math.floor(rng() * angles.length) % angles.length];
    /**
     * DRAWN ONCE, OUTSIDE THE REJECTION LOOP, and that placement is the whole
     * point. Re-rolling it per attempt makes the SURVIVING mix a function of
     * how often each kind gets rejected, not of the parameter: an over-water
     * site only has to be wet, a dry site has to clear a height AND a slope
     * limit, so 0.3 came out as 6 stilt huts in 9. Deciding what this hut IS
     * before looking for somewhere to put it keeps the parameter honest.
     */
    const overWater = rng() < p.structureStiltFraction;
    let placed: HutPlan | null = null;
    for (let attempt = 0; attempt < 24 && placed === null; attempt++) {
      const spread = (p.structureSettlementSpread / radiusForArc) * p.structureHutFlare;
      const angle = centre + (rng() + rng() - 1) * spread;
      const shoreR = findShoreRadius(hm, angle);
      // over-water huts stand OUTSIDE the waterline in the shallows; the rest
      // sit on the dry beach and the flat ground behind it
      const r = overWater
        ? shoreR + p.structureRootInset * (0.4 + rng() * 1.6)
        : shoreR - p.structureHutSetback * (0.3 + rng() * 1.7);
      const x = Math.cos(angle) * r;
      const z = Math.sin(angle) * r;
      const h = hm.heightAt(x, z);
      if (overWater) {
        // must actually be in water a stilt can stand in
        if (h > -0.2 || h < -p.structureMaxPileDepth * 0.6) continue;
      } else {
        if (h < p.structureHutMinHeight) continue;
        if (gradientAt(hm, x, z) > p.structureHutSlopeLimit) continue;
      }
      const width = p.structureHutSize * (0.75 + rng() * 0.8);
      placed = {
        position: [x, z],
        // face the water, with a loose cant so a cluster is not a parade
        yaw: angle + Math.PI + (rng() * 2 - 1) * 0.5,
        width,
        depth: width * (0.7 + rng() * 0.7),
        floorY: overWater
          ? p.structureDeckHeight * (0.9 + rng() * 0.4)
          : Math.max(h, 0) + p.structureHutStilt * rng(),
        wallHeight: p.structureHutWallHeight * (0.85 + rng() * 0.4),
        roofRise: p.structureHutRoofRise * (0.6 + rng() * 0.9),
        gable: rng() < 0.65,
        overWater,
      };
    }
    if (placed !== null) huts.push(placed);
  }

  return { jetties, huts };
}

/* -------------------------------------------------------------------------
 * GEOMETRY
 * ---------------------------------------------------------------------- */

/** where a pile's foot sits: the seabed, but never deeper than it can reach */
function pileFoot(hm: IslandHeightmap, x: number, z: number, deckY: number, p: IslandParams): number {
  const ground = Math.max(hm.heightAt(x, z), deckY - p.structureMaxPileLength);
  return ground - p.structurePileEmbed;
}

function buildJetty(b: Builder, rng: Rng, plan: JettyPlan, hm: IslandHeightmap, p: IslandParams): void {
  const [rx, rz] = plan.root;
  const [dx, dz] = plan.dir;
  // perpendicular, i.e. across the jetty
  const px = -dz;
  const pz = dx;
  const half = plan.width * 0.5;
  const bay = Math.max(p.structureBayLength, 0.5); // §V28
  const bays = Math.max(2, Math.round(plan.length / bay));
  const step = plan.length / bays;
  const stringerH = p.structureStringerDepth;
  const plankT = p.structurePlankThickness;
  const deckTop = plan.deckY;
  const stringerTop = deckTop - plankT;

  const a = new THREE.Vector3();
  const c = new THREE.Vector3();

  // -- piles, two per bay line ---------------------------------------------
  for (let i = 0; i <= bays; i++) {
    const s = i * step;
    for (const side of [-1, 1] as const) {
      const x = rx + dx * s + px * side * half;
      const z = rz + dz * s + pz * side * half;
      const foot = pileFoot(hm, x, z, deckTop, p);
      // a driven pile is never plumb, and a rotten one leans further
      const lean = p.structurePileLean * (0.3 + plan.decay) * (rng() * 2 - 1);
      const leanDir = rng() * Math.PI * 2;
      // most piles stop under the deck; some stand proud as bollards, which is
      // the single most recognisable silhouette in ref-island-147 and -149
      const stub = rng() < p.structureBollardChance ? 0.25 + rng() * p.structureBollardRise : 0;
      const top = stringerTop - stringerH * 0.5 + stub;
      a.set(x, foot, z);
      c.set(x + Math.cos(leanDir) * lean, top, z + Math.sin(leanDir) * lean);
      log(
        b,
        a,
        c,
        p.structurePileRadius * (0.78 + rng() * 0.5),
        Math.floor(rng() * 3),
        jitterTint(rng, TINT_TIMBER, 0.09),
      );
    }
  }

  // -- stringers: the two beams the deck actually rests on -------------------
  for (const side of [-1, 1] as const) {
    a.set(rx + px * side * half, stringerTop - stringerH * 0.5, rz + pz * side * half);
    c.set(
      rx + dx * plan.length + px * side * half,
      stringerTop - stringerH * 0.5,
      rz + dz * plan.length + pz * side * half,
    );
    beam(b, a, c, p.structureStringerWidth, stringerH, jitterTint(rng, TINT_TIMBER, 0.07));
  }

  // -- cross braces under the deck -----------------------------------------
  for (let i = 0; i < bays; i++) {
    if (rng() > p.structureBraceChance) continue;
    const s0 = i * step;
    const s1 = (i + 1) * step;
    const sign = rng() < 0.5 ? 1 : -1;
    const yLow = Math.min(
      pileFoot(hm, rx + dx * s0, rz + dz * s0, deckTop, p) + p.structurePileEmbed + 0.35,
      stringerTop - 0.6,
    );
    a.set(rx + dx * s0 + px * sign * half, yLow, rz + dz * s0 + pz * sign * half);
    c.set(rx + dx * s1 - px * sign * half, stringerTop - stringerH, rz + dz * s1 - pz * sign * half);
    beam(b, a, c, p.structureBraceSize, p.structureBraceSize, jitterTint(rng, TINT_TIMBER, 0.1));
  }

  // -- deck boards, laid ACROSS ---------------------------------------------
  // Real, separate boards with real gaps — that is what makes ref-island-149
  // read as timber and not as a painted ribbon, and it is only affordable
  // because this whole island is one draw call.
  const pitch = Math.max(p.structurePlankWidth + p.structurePlankGap, 0.05); // §V28
  const boards = Math.max(1, Math.floor(plan.length / pitch));
  for (let i = 0; i <= boards; i++) {
    const t = i / boards;
    const s = t * plan.length;
    // a board is likelier to be gone at the exposed seaward end
    if (rng() < plan.decay * p.structureMissingPlank * (0.25 + 0.75 * t)) continue;
    const w = p.structurePlankWidth * (0.82 + rng() * 0.36);
    // cant: a hand-laid board is not square to the stringers
    const cant = (rng() * 2 - 1) * p.structurePlankCant;
    const ux = dx * Math.sin(cant) + px * Math.cos(cant);
    const uz = dz * Math.sin(cant) + pz * Math.cos(cant);
    const over0 = p.structurePlankOverhang * rng();
    const over1 = p.structurePlankOverhang * rng();
    const y = stringerTop + plankT * 0.5 + (rng() * 2 - 1) * p.structurePlankLift;
    a.set(rx + dx * s - ux * (half + over0), y, rz + dz * s - uz * (half + over0));
    c.set(rx + dx * s + ux * (half + over1), y, rz + dz * s + uz * (half + over1));
    beam(
      b,
      a,
      c,
      plankT,
      w,
      jitterTint(rng, plan.decay > 0.4 ? TINT_WEATHERED : TINT_DECK, 0.1),
      // a cocked board — the material's plank relief cannot fake this, it is
      // a silhouette you see against the water
      (rng() * 2 - 1) * p.structurePlankRoll,
    );
  }

  // -- the shore ramp -------------------------------------------------------
  // ref-island-149 is exactly this: a handful of loose boards splayed from the
  // deck down onto the sand, at their own angles, not a tidy staircase.
  const rampBoards = 3 + Math.floor(rng() * 4);
  for (let i = 0; i < rampBoards; i++) {
    const spreadT = rampBoards > 1 ? i / (rampBoards - 1) - 0.5 : 0;
    const lateral = spreadT * plan.width * (0.7 + rng() * 0.7);
    const run = p.structureRampRun * (0.7 + rng() * 0.7);
    const topX = rx + px * lateral;
    const topZ = rz + pz * lateral;
    const botX = topX - dx * run + px * (rng() * 2 - 1) * 0.5;
    const botZ = topZ - dz * run + pz * (rng() * 2 - 1) * 0.5;
    const botY = Math.max(hm.heightAt(botX, botZ), 0) + plankT * 0.5;
    a.set(topX, stringerTop + plankT * 0.5, topZ);
    c.set(botX, botY, botZ);
    beam(
      b,
      a,
      c,
      p.structurePlankThickness,
      p.structurePlankWidth * (0.9 + rng() * 0.5),
      jitterTint(rng, TINT_WEATHERED, 0.1),
      (rng() * 2 - 1) * 0.12,
    );
  }

  // -- handrail -------------------------------------------------------------
  if (plan.rail) {
    const railY = deckTop + p.structureRailHeight;
    const side = rng() < 0.35 ? 0 : rng() < 0.5 ? -1 : 1;
    const sides = side === 0 ? ([-1, 1] as const) : ([side] as const);
    for (const sd of sides) {
      for (let i = 0; i <= bays; i += 2) {
        const s = i * step;
        const x = rx + dx * s + px * sd * half;
        const z = rz + dz * s + pz * sd * half;
        a.set(x, deckTop - 0.1, z);
        c.set(x + (rng() * 2 - 1) * 0.06, railY, z + (rng() * 2 - 1) * 0.06);
        beam(b, a, c, p.structureRailSize, p.structureRailSize, jitterTint(rng, TINT_TIMBER, 0.08));
      }
      a.set(rx + px * sd * half, railY, rz + pz * sd * half);
      c.set(
        rx + dx * plan.length + px * sd * half,
        railY,
        rz + dz * plan.length + pz * sd * half,
      );
      beam(b, a, c, p.structureRailSize, p.structureRailSize * 0.8, jitterTint(rng, TINT_TIMBER, 0.08));
    }
  }
}

function buildHut(b: Builder, rng: Rng, plan: HutPlan, hm: IslandHeightmap, p: IslandParams): void {
  const [hx, hz] = plan.position;
  const ca = Math.cos(plan.yaw);
  const sa = Math.sin(plan.yaw);
  // hut-local (u across the front, v front-to-back) → island-local
  const toWorld = (u: number, v: number): [number, number] => [
    hx + ca * u - sa * v,
    hz + sa * u + ca * v,
  ];
  const hw = plan.width * 0.5;
  const hd = plan.depth * 0.5;
  const floorY = plan.floorY;
  const eaveY = floorY + plan.wallHeight;
  const plankT = p.structurePlankThickness;

  const a = new THREE.Vector3();
  const c = new THREE.Vector3();

  // -- corner posts, ground to eave ----------------------------------------
  const corners: [number, number][] = [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ];
  for (const [u, v] of corners) {
    const [x, z] = toWorld(u, v);
    const foot = pileFoot(hm, x, z, floorY, p);
    a.set(x, foot, z);
    c.set(x + (rng() * 2 - 1) * 0.05, eaveY, z + (rng() * 2 - 1) * 0.05);
    log(b, a, c, p.structurePostRadius * (0.85 + rng() * 0.4), Math.floor(rng() * 3), jitterTint(rng, TINT_TIMBER, 0.08));
  }
  // an over-water hut needs more legs than its four corners
  if (plan.overWater) {
    for (const [u, v] of [
      [0, -hd],
      [0, hd],
    ] as [number, number][]) {
      const [x, z] = toWorld(u, v);
      const foot = pileFoot(hm, x, z, floorY, p);
      a.set(x, foot, z);
      c.set(x, floorY, z);
      log(b, a, c, p.structurePileRadius * (0.8 + rng() * 0.4), Math.floor(rng() * 3), jitterTint(rng, TINT_TIMBER, 0.08));
    }
  }

  // -- floor bearers + boards ----------------------------------------------
  for (const u of [-hw, hw]) {
    const [x0, z0] = toWorld(u, -hd);
    const [x1, z1] = toWorld(u, hd);
    a.set(x0, floorY - plankT - 0.06, z0);
    c.set(x1, floorY - plankT - 0.06, z1);
    beam(b, a, c, p.structureStringerWidth * 0.8, p.structureStringerDepth * 0.7, jitterTint(rng, TINT_TIMBER, 0.07));
  }
  const floorPitch = Math.max(p.structurePlankWidth + p.structurePlankGap, 0.05); // §V28
  const floorBoards = Math.max(1, Math.round(plan.depth / floorPitch));
  for (let i = 0; i <= floorBoards; i++) {
    const v = -hd + (i / floorBoards) * plan.depth;
    const [x0, z0] = toWorld(-hw - 0.06 * rng(), v);
    const [x1, z1] = toWorld(hw + 0.06 * rng(), v);
    a.set(x0, floorY - plankT * 0.5, z0);
    c.set(x1, floorY - plankT * 0.5, z1);
    beam(b, a, c, plankT, p.structurePlankWidth * (0.85 + rng() * 0.3), jitterTint(rng, TINT_DECK, 0.09));
  }

  // -- walls: vertical boards with gaps, front left open (the references'
  //    huts are open-fronted shelters, and an open face is what lets the
  //    silhouette read as a building instead of as a crate)
  const wallPitch = Math.max(p.structurePlankWidth * 0.9 + p.structurePlankGap, 0.05); // §V28
  const walls: { u0: number; v0: number; u1: number; v1: number }[] = [
    { u0: -hw, v0: hd, u1: hw, v1: hd }, // back
    { u0: -hw, v0: -hd, u1: -hw, v1: hd }, // left
    { u0: hw, v0: -hd, u1: hw, v1: hd }, // right
  ];
  for (const w of walls) {
    const span = Math.hypot(w.u1 - w.u0, w.v1 - w.v0);
    const n = Math.max(1, Math.round(span / wallPitch));
    for (let i = 0; i <= n; i++) {
      if (rng() < p.structureMissingBoard) continue; // a gap you can see through
      const t = i / n;
      const u = w.u0 + (w.u1 - w.u0) * t;
      const v = w.v0 + (w.v1 - w.v0) * t;
      const [x, z] = toWorld(u, v);
      const top = eaveY - rng() * 0.12;
      a.set(x, floorY - 0.05, z);
      c.set(x + (rng() * 2 - 1) * 0.03, top, z + (rng() * 2 - 1) * 0.03);
      beam(
        b,
        a,
        c,
        p.structurePlankWidth * (0.8 + rng() * 0.35),
        plankT,
        jitterTint(rng, TINT_WEATHERED, 0.11),
        (rng() * 2 - 1) * 0.05,
      );
    }
  }

  // -- roof -----------------------------------------------------------------
  // Boards running down the slope, overlapping, on a ridge and two eave
  // plates. Tinted toward the references' red-brown, which is most of what
  // makes a hut cluster legible from the water.
  const over = p.structureEaveOverhang;
  const ridgeY = eaveY + plan.roofRise;
  const roofTint = TINT_ROOF;
  if (plan.gable) {
    // ridge beam along u
    const [rx0, rz0] = toWorld(-hw - over, 0);
    const [rx1, rz1] = toWorld(hw + over, 0);
    a.set(rx0, ridgeY, rz0);
    c.set(rx1, ridgeY, rz1);
    beam(b, a, c, 0.1, 0.12, jitterTint(rng, TINT_TIMBER, 0.06));
    for (const sign of [-1, 1] as const) {
      const slopePitch = Math.max(p.structurePlankWidth * 1.1, 0.06); // §V28
      const n = Math.max(1, Math.round((plan.width + 2 * over) / slopePitch));
      for (let i = 0; i <= n; i++) {
        const u = -hw - over + (i / n) * (plan.width + 2 * over);
        const [x0, z0] = toWorld(u, 0);
        const [x1, z1] = toWorld(u, sign * (hd + over));
        a.set(x0, ridgeY + 0.02, z0);
        c.set(x1, eaveY - 0.02, z1);
        beam(
          b,
          a,
          c,
          p.structurePlankWidth * 1.15,
          plankT * 1.2,
          jitterTint(rng, roofTint, 0.08),
          (rng() * 2 - 1) * 0.03,
        );
      }
    }
  } else {
    // shed: one slope, high at the back
    const slopePitch = Math.max(p.structurePlankWidth * 1.1, 0.06); // §V28
    const n = Math.max(1, Math.round((plan.width + 2 * over) / slopePitch));
    for (let i = 0; i <= n; i++) {
      const u = -hw - over + (i / n) * (plan.width + 2 * over);
      const [x0, z0] = toWorld(u, hd + over);
      const [x1, z1] = toWorld(u, -hd - over);
      a.set(x0, ridgeY, z0);
      c.set(x1, eaveY - 0.02, z1);
      beam(
        b,
        a,
        c,
        p.structurePlankWidth * 1.15,
        plankT * 1.2,
        jitterTint(rng, roofTint, 0.08),
        (rng() * 2 - 1) * 0.03,
      );
    }
  }
}

/**
 * Every structure on one island as ONE geometry, island-local. Pure over
 * (seed, heightmap, params) so a test can count its triangles without a GPU.
 */
export function buildStructureGeometry(
  seed: number,
  hm: IslandHeightmap,
  p: IslandParams = islandParams,
): { geometry: THREE.BufferGeometry; plan: StructurePlan } {
  const plan = generateStructurePlan(seed, hm, p);
  // its own stream: adding a hut must not reshuffle the boards of every jetty
  const rng = createRng(seed + 911);
  const b = newBuilder();
  for (const jetty of plan.jetties) buildJetty(b, rng, jetty, hm, p);
  for (const hut of plan.huts) buildHut(b, rng, hut, hm, p);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
  geometry.setAttribute('timberTint', new THREE.Float32BufferAttribute(b.tint, 3));
  geometry.setIndex(b.idx);
  geometry.computeBoundingSphere();
  return { geometry, plan };
}

/* -------------------------------------------------------------------------
 * MATERIAL + MESH
 * ---------------------------------------------------------------------- */

/**
 * The ship's timber, plus the per-vertex tint (see the file header). NO
 * LocalFrame — `woodMaterial` documents that omission as the correct answer for
 * a fixed structure: the wet band then comes straight off the sea surface
 * instead of out of a hull's drying memory.
 */
export function createStructureMaterial(): ShipMaterialHandle {
  const handle = createWoodMaterial({
    light: 0x9c7f5c,
    dark: 0x4e3c29,
    wale: false,
    // FALSE, and not because a dock has no waterline. `tones.waterline` darkens
    // by piece-local y < 0, which is a HULL fact — this geometry's y is already
    // island-local metres above still water, so it would work by accident here
    // and then be wrong the moment the sea moved. `waterLighting` below does
    // the same job against the LIVE surface, which is the honest source.
    waterline: false,
  });
  const tint = attribute('timberTint', 'vec3');
  // TSL nodes are structurally different per operation; the assembled colour
  // node needs the loose type to be multiplied through (same reason as
  // woodMaterial's own `AnyNode`)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base = handle.material.colorNode as any;
  if (base === null || base === undefined) {
    throw new Error('createStructureMaterial: wood material has no colorNode to tint'); // §Rule 8
  }
  handle.material.colorNode = base.mul(tint);
  return handle;
}

export interface CreateStructuresOptions {
  seed: number;
  heightmap: IslandHeightmap;
  /** shared material (islandMaterials); omit and this owns its own */
  material?: THREE.Material;
}

export interface Structures {
  mesh: THREE.Mesh;
  plan: StructurePlan;
  /** LOD (§V17): the whole settlement is one visibility flag */
  setLodDistance(cameraDistance: number): void;
  updateFromParams(): void;
  dispose(): void;
}

export function createStructures(opts: CreateStructuresOptions): Structures {
  const p = islandParams;
  const { geometry, plan } = buildStructureGeometry(opts.seed, opts.heightmap, p);
  const own: ShipMaterialHandle | null = opts.material ? null : createStructureMaterial();
  const material = opts.material ?? own!.material;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'island-structures';
  mesh.receiveShadow = true;
  // an island with no buildable shore builds nothing, and a zero-index draw is
  // still a draw in the main pass AND the shadow pass
  const empty = geometry.getIndex()!.count === 0;
  mesh.visible = !empty;

  return {
    mesh,
    plan,
    setLodDistance(cameraDistance: number): void {
      mesh.visible = !empty && cameraDistance <= p.lodStructureCull;
    },
    updateFromParams(): void {
      own?.refresh();
    },
    dispose(): void {
      geometry.dispose();
      own?.material.dispose();
    },
  };
}
