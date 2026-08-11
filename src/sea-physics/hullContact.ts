/**
 * Hull waterline CONTACT sampler (§V.8 data source for §V.6 spray / §V.10
 * wake): where is the hull actually touching the water RIGHT NOW?
 *
 * WHY (user, sailing live): "the bow wake needs to better sample which part
 * of the boat is actually hitting the water surface first — right now we see
 * it detach when we're lifting out of the water or going over a wave trough,
 * because the spray comes out from something that is in the air where
 * there's nothing touching the water." Emitters keyed off ONE fixed stem
 * point (bowZ from the hull AABB) keep firing from that point whether or not
 * it is in the sea. A pitching hull lifts its stem clear several times a
 * minute — more often now that the hull answers only to swell — so the
 * emitter hangs in mid-air on every crest.
 *
 * The fix is coarse and cheap, as the user said it should be: a handful of
 * stations down the hull's waterline outline, each asking the SAME CpuOcean
 * mirror buoyancy uses (§V.8 — one sea for physics and pixels; §B.7 is what
 * a second, staler sea costs) how deep it is this tick. The forward-most
 * station in contact is the true cutwater at this instant, and the point
 * where the outline crosses the surface between the last dry station and the
 * first wet one is where spray should actually come from.
 *
 * NOT part of SimState (§V.2): this is a derived per-tick view, a pure
 * function of (ship pose, ocean, previous tick's depths). Keeping it out of
 * the state keeps the replay hash small and free of render-only data; the
 * one carried value (previous depths, for the burial rate) costs a single
 * tick of zero rate if it is lost, and nothing accumulates.
 *
 * Deterministic and engine-free: plain numbers, no three.js, fixed-dt.
 */
import { rotateVec } from '../combat/quatMath';
import { asHullShape, hullHalfWidthAt } from '../ship/hullMath';
import type { ShipState, Vec3 } from '../state/simState';
import type { OceanHeightField } from './cpuOcean';

/**
 * The hull's plan view at the design waterline, as the sampler needs it.
 * Structural on purpose: the galleon loft (ship/hullMath), a box fallback
 * and a future AI-gen hull (§V.18) all satisfy it without this module
 * knowing which one it got.
 */
export interface HullWaterline {
  /** ship-space z of the stem (bow), > sternZ */
  bowZ: number;
  /** ship-space z of the transom */
  sternZ: number;
  /** half-breadth (m) of the waterline outline at station z, ≥ 0 */
  halfWidthAt(z: number): number;
}

/** one sampling point on the waterline outline, in ship-local space */
export interface ContactStation {
  /** local x (signed: −port, +starboard) */
  x: number;
  /** local z (bow positive) */
  z: number;
  /** −1 port, +1 starboard (a station pair shares its z) */
  side: -1 | 1;
  /** index of this station's z slice, 0 = bow-most */
  slice: number;
}

/**
 * Where the hull meets the sea this tick. All arrays are index-aligned and
 * REUSED every tick — consumers must read them, not retain them.
 */
export interface HullContactResult {
  /** sim time of the last update, NaN before the first */
  time: number;
  /** per station: immersion (m). > 0 under water, < 0 clear of it */
  readonly depth: Float64Array;
  /** per station: d(depth)/dt (m/s). > 0 burying, < 0 emerging */
  readonly rate: Float64Array;
  /** per station: world position of the HULL point (not the surface) */
  readonly worldX: Float64Array;
  readonly worldY: Float64Array;
  readonly worldZ: Float64Array;
  /** per z slice, bow-most first: centreline immersion and its rate */
  readonly sliceDepth: Float64Array;
  readonly sliceRate: Float64Array;
  /** any part of the hull in the water at all — false = fully airborne */
  inContact: boolean;
  /**
   * The cutwater: where the hull enters the water this instant. `world` is
   * the interpolated crossing point ON the surface (that is the whole
   * point — emit from here and spray can never appear in mid-air), while
   * `depth`/`rate` come from the forward-most WET slice, because a crossing
   * point is by definition at depth 0 and would give an emitter nothing to
   * scale intensity by.
   */
  readonly cutwater: {
    inContact: boolean;
    world: Vec3;
    /** ship-space z of the crossing — the EFFECTIVE bow offset this tick */
    localZ: number;
    /** immersion of the forward-most wet slice (m, ≥ 0) */
    depth: number;
    /** burial rate there (m/s, > 0 = driving under) */
    rate: number;
    /** half-breadth of the hull at the crossing (m) — how wide a sheet */
    halfWidth: number;
  };
  /** ship-space z of the forward-most / aft-most slice in contact */
  contactZFore: number;
  contactZAft: number;
  /** fraction of z slices in contact, 0..1 — 1 = hull evenly in the sea */
  wetFraction: number;
}

export interface HullContact extends HullContactResult {
  readonly stations: readonly ContactStation[];
  readonly sliceZ: Float64Array;
  /**
   * Hull half-breadth (m) at each slice — constant geometry, bow → stern.
   * With `sliceDepth` this is the wetted outline a wake needs: the hull is
   * pushing water aside over `sliceHalfWidth[s]` wherever `sliceDepth[s]`
   * is positive, and over nothing where it is not. Feather on depth rather
   * than gating hard if the wake should fade in as the bow settles.
   */
  readonly sliceHalfWidth: Float64Array;
  /** one fixed-dt sample; ocean must already be advanced to `time` */
  update(ship: ShipState, ocean: OceanHeightField, time: number): void;
}

/** burial rate clamp: a K-tick mirror recompute steps the surface, and an
 *  unclamped spike would fire a spray burst out of nowhere (cf. B5) */
const MAX_CONTACT_RATE = 20;

/** below this the station counts as clear of the water (m) */
const CONTACT_EPS = 1e-4;

/**
 * Bow-biased z slices: uniform spacing wastes resolution on the run aft
 * where nothing happens, while the cutwater lives in the forward third and
 * wants fine steps or it visibly jumps aft in metre-long hops as the stem
 * lifts. t^1.6 from the stem puts roughly half the slices in the forward
 * third for a handful of samples total.
 */
export function buildWaterlineStations(
  hull: HullWaterline,
  slices = 9,
): { stations: ContactStation[]; sliceZ: Float64Array } {
  const n = Math.max(2, Math.round(slices));
  const length = hull.bowZ - hull.sternZ;
  if (!(length > 0)) {
    throw new Error(`buildWaterlineStations: bowZ ${hull.bowZ} must exceed sternZ ${hull.sternZ}`);
  }
  const stations: ContactStation[] = [];
  const sliceZ = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const z = hull.bowZ - length * Math.pow(t, 1.6);
    sliceZ[i] = z;
    // a station pair per slice; at the stem the pair collapses onto the
    // centreline, which is exactly the hull there
    const half = Math.max(0, hull.halfWidthAt(z));
    stations.push({ x: -half, z, side: -1, slice: i });
    stations.push({ x: half, z, side: 1, slice: i });
  }
  return { stations, sliceZ };
}

/** the shape-hint carrier we need off a blueprint piece (§V.18 plain data) */
interface ShapedPiece {
  shape?: Record<string, number>;
}

/**
 * Waterline read off the SHIP'S OWN LOFT: hull-family pieces carry the
 * hullMath shape hints the geometry is built from, so the stations follow
 * the hull when the ship agent reshapes it instead of describing last
 * week's boat. Returns null when a blueprint carries no hull shape (a
 * future §V.18 mesh-swap hull, say) — callers fall back to
 * `waterlineFromBox` with the AABB extents they already compute.
 */
export function waterlineFromBlueprint(pieces: readonly ShapedPiece[]): HullWaterline | null {
  for (const piece of pieces) {
    const shape = asHullShape(piece.shape);
    if (shape === null) continue;
    return {
      bowZ: shape.bowZ,
      sternZ: shape.sternZ,
      // y = 0 is the design waterline plane in ship space (draft is measured
      // down from it), so this is the loft's half-breadth exactly there
      halfWidthAt: (z: number) => hullHalfWidthAt(z, 0, shape),
    };
  }
  return null;
}

/**
 * Coarse fallback when only the hull AABB is to hand (what main.ts already
 * derives for the wake): an elliptical plan view, pointed at the stem and
 * cut off at ~0.55 beam at the transom — the same silhouette family as the
 * loft, good enough for "which end is in the water".
 */
export function waterlineFromBox(
  bowZ: number,
  sternZ: number,
  beamHalf: number,
): HullWaterline {
  const mid = (bowZ + sternZ) / 2;
  const halfLen = Math.max(1e-3, (bowZ - sternZ) / 2);
  return {
    bowZ,
    sternZ,
    halfWidthAt(z: number): number {
      const u = Math.min(1, Math.max(-1, (z - mid) / halfLen));
      const ell = Math.sqrt(Math.max(0, 1 - u * u));
      return beamHalf * (u >= 0 ? ell : Math.max(ell, 0.55));
    },
  };
}

export function createHullContact(
  hull: HullWaterline,
  slices = 9,
): HullContact {
  const { stations, sliceZ } = buildWaterlineStations(hull, slices);
  const n = stations.length;
  const nSlice = sliceZ.length;
  const prevDepth = new Float64Array(n).fill(Number.NaN);
  const halfWidth = new Float64Array(nSlice);
  for (const s of stations) if (s.side === 1) halfWidth[s.slice] = s.x;

  const self: HullContact = {
    stations,
    sliceZ,
    sliceHalfWidth: halfWidth,
    time: Number.NaN,
    depth: new Float64Array(n),
    rate: new Float64Array(n),
    worldX: new Float64Array(n),
    worldY: new Float64Array(n),
    worldZ: new Float64Array(n),
    sliceDepth: new Float64Array(nSlice),
    sliceRate: new Float64Array(nSlice),
    inContact: false,
    cutwater: {
      inContact: false,
      world: [0, 0, 0],
      localZ: hull.bowZ,
      depth: 0,
      rate: 0,
      halfWidth: 0,
    },
    contactZFore: Number.NaN,
    contactZAft: Number.NaN,
    wetFraction: 0,
    update(ship, ocean, time) {
      if (Number.isNaN(ocean.currentTime)) {
        // fail loud: sampling a never-computed sea is the §B.7 failure mode
        throw new Error('hullContact.update: call ocean.update(time) first');
      }
      const dt = time - self.time;
      const local: Vec3 = [0, 0, 0];
      for (let i = 0; i < n; i++) {
        const st = stations[i];
        local[0] = st.x;
        local[1] = 0; // stations live ON the design waterline plane
        local[2] = st.z;
        const r = rotateVec(ship.quaternion, local);
        const wx = ship.position[0] + r[0];
        const wy = ship.position[1] + r[1];
        const wz = ship.position[2] + r[2];
        const depth = ocean.heightAt(wx, wz, time) - wy;
        self.worldX[i] = wx;
        self.worldY[i] = wy;
        self.worldZ[i] = wz;
        self.depth[i] = depth;
        if (dt > 0 && Number.isFinite(prevDepth[i])) {
          const raw = (depth - prevDepth[i]) / dt;
          self.rate[i] = Math.max(-MAX_CONTACT_RATE, Math.min(MAX_CONTACT_RATE, raw));
        } else {
          self.rate[i] = 0;
        }
        prevDepth[i] = depth;
      }
      self.time = time;

      // centreline profile: the mean of a station pair IS the depth on the
      // centreline for any surface that is locally planar across the beam —
      // 8.5 m of curvature error is far below "coarse" and it costs nothing
      let wet = 0;
      let fore = Number.NaN;
      let aft = Number.NaN;
      for (let s = 0; s < nSlice; s++) {
        const a = 2 * s;
        self.sliceDepth[s] = (self.depth[a] + self.depth[a + 1]) / 2;
        self.sliceRate[s] = (self.rate[a] + self.rate[a + 1]) / 2;
        if (self.sliceDepth[s] > CONTACT_EPS) {
          wet++;
          if (Number.isNaN(fore)) fore = sliceZ[s]; // slices run bow → stern
          aft = sliceZ[s];
        }
      }
      self.wetFraction = wet / nSlice;
      self.inContact = wet > 0;
      self.contactZFore = fore;
      self.contactZAft = aft;

      // cutwater: forward-most wet slice, and the surface crossing just
      // ahead of it. Fully airborne → hold the stem pose and flag it, so a
      // consumer that ignores the flag at least emits from the stem rather
      // than from stale coordinates.
      const cw = self.cutwater;
      cw.inContact = self.inContact;
      let first = -1;
      for (let s = 0; s < nSlice; s++) {
        if (self.sliceDepth[s] > CONTACT_EPS) {
          first = s;
          break;
        }
      }
      if (first < 0) {
        cw.localZ = sliceZ[0];
        cw.depth = 0;
        cw.rate = 0;
        cw.halfWidth = halfWidth[0];
        cw.world[0] = (self.worldX[0] + self.worldX[1]) / 2;
        cw.world[1] = (self.worldY[0] + self.worldY[1]) / 2;
        cw.world[2] = (self.worldZ[0] + self.worldZ[1]) / 2;
        return;
      }
      cw.depth = self.sliceDepth[first];
      cw.rate = self.sliceRate[first];
      const aW = 2 * first;
      let cx = (self.worldX[aW] + self.worldX[aW + 1]) / 2;
      let cz = (self.worldZ[aW] + self.worldZ[aW + 1]) / 2;
      let localZ = sliceZ[first];
      let half = halfWidth[first];
      if (first > 0) {
        // slice `first−1` is forward of the crossing and dry: walk back to
        // where the outline pierces the surface. Without this the emitter
        // would still step aft in whole-slice jumps as the bow rises.
        const dryDepth = self.sliceDepth[first - 1];
        const span = cw.depth - dryDepth; // > 0: wet minus dry
        const t = span > 1e-9 ? cw.depth / span : 0;
        const bW = 2 * (first - 1);
        const dx = (self.worldX[bW] + self.worldX[bW + 1]) / 2;
        const dz = (self.worldZ[bW] + self.worldZ[bW + 1]) / 2;
        cx += (dx - cx) * t;
        cz += (dz - cz) * t;
        localZ += (sliceZ[first - 1] - localZ) * t;
        half += (halfWidth[first - 1] - half) * t;
      }
      cw.world[0] = cx;
      // SNAP to the surface. The interpolation above locates WHERE along the
      // hull the waterline is pierced; the chord between two coarse slices
      // then misses a curved wave by up to ~0.35 m vertically, which is
      // exactly the "emitter is not on the water" error this module exists
      // to remove. One more heightAt buys an emitter point that is on the
      // drawn surface by construction (§V.8), at any slice count.
      cw.world[1] = ocean.heightAt(cx, cz, time);
      cw.world[2] = cz;
      cw.localZ = localZ;
      cw.halfWidth = half;
    },
  };
  return self;
}
