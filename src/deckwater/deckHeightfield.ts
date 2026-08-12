/**
 * The static deck heightfield the §V9 solve runs on — the Rare talk's
 * "Surface Water: Setup" slide's *artist supplied static heightfield texture*,
 * which for us is generated from the ship's own pieces (src/ship's
 * deckHeightfield.ts) rather than painted.
 *
 * WHY IT IS THE WHOLE EFFECT, not a detail: on a flat plane the Mei solve
 * produces a uniform sheet that slides bodily around as the ship rotates and
 * reads as a moving decal. The field is what turns rotation bias into water
 * FINDING the low side — running to the waterway inboard of the bulwark,
 * held out of a hatch by its coaming, lingering in the cup of an old board,
 * and leaving through the freeing ports in channels instead of as a wall.
 *
 * ONE FIELD, TWO CONSUMERS. src/ship drives the deck's plank relief and tone
 * from the SAME array. That is the point of not generating our own: two
 * independently authored fields would disagree about where the low spots are,
 * the water would pool where the timber does not dish, and no test would
 * notice. This module therefore AUTHORS NOTHING except a synthetic field for
 * headless tests — it adapts.
 *
 * AXES — src/ship's, adopted wholesale rather than transposed:
 *   grid x (0 … width−1)  = ACROSS THE BEAM, ship +x (toward starboard)
 *   grid y (0 … height−1) = ALONG THE LENGTH, ship +z (toward the bow)
 * so the talk's 512 × 192 is `width` 192 across the beam and `height` 512
 * along the length, row-major with x fastest. Everything downstream — uv,
 * the tilt gradient, splash placement — follows this and nothing transposes
 * anywhere, because a transpose that is right in three places and wrong in
 * the fourth is invisible until the deck is on screen.
 */
import { deckWaterParams } from '../params/deckwater';
import type { DeckFrame } from './deckFrame';

/**
 * Structural view of `DeckHeightfield` from src/ship/deckHeightfield.ts —
 * declared here rather than imported, the same convention foam/bowSpray uses
 * for hullContact's cutwater: this module stays out of the ship's import
 * graph and testable without one. Field names and units match exactly.
 *
 * `solid` (bulwarks, coamings, mast partners, the capstan drum) is
 * deliberately NOT consumed: those obstacles are already standing proud in
 * `data`, so the hydraulic head keeps water out of them for free. Treating
 * them as drains instead would make the bulwark a sink and quietly empty the
 * deck through its own rail.
 */
export interface DeckHeightfieldSource {
  /** texels across the beam (ship x) */
  width: number;
  /** texels along the length (ship z) */
  height: number;
  /** ship-space rectangle the field covers */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** ship-space y of the reference deck plane — the field's height 0 */
  deckY: number;
  /** terrain height in metres relative to `deckY`, row-major, x fastest */
  data: Float32Array;
  /** 0..1 coverage of the water domain; 0 = outboard of the planking */
  mask: Float32Array;
}

/** what the solver actually seeds its state texture from */
export interface DeckField {
  width: number;
  height: number;
  /** metres above the deck plane, row-major (index = y * width + x) */
  heights: Float32Array;
  /**
   * 1 = this cell is the WAIST — the main deck's walking plane, the surface
   * the deck material actually shades. The field spans the whole ship, so the
   * forecastle and quarterdeck soles are in it too, standing ~1.6 m proud.
   * Water injected onto those is invisible (the material gates to the deck
   * plane) and runs off their edges instead of onto the waist, so injection
   * snaps into this mask. Derived, not authored: |height| ≤ waistBand.
   */
  waist: Uint8Array;
  /**
   * Where water LEAVES the ship: 1 = drain, 0 = deck. Derived from the
   * source's coverage mask — the grid is a rectangle and the deck is not, so
   * the corners abreast of the stem are thin air. A drain cell holds no
   * water: the resolve zeroes its volume and wetness every step, which makes
   * it a permanent low-head sink its neighbours pour into, with no mask
   * branch anywhere in either compute pass.
   */
  drain: Uint8Array;
}

/** every cell finite and both arrays the right length (Rule 8, §V28) */
export function validateDeckField(f: DeckField): void {
  const n = f.width * f.height;
  if (!(f.width > 1 && f.height > 1)) {
    throw new Error(`deckwater: DeckField dims ${f.width}×${f.height} must exceed 1`);
  }
  if (f.heights.length !== n) {
    throw new Error(`deckwater: DeckField heights ${f.heights.length} ≠ ${f.width}×${f.height}`);
  }
  if (f.drain.length !== n) {
    throw new Error(`deckwater: DeckField drain ${f.drain.length} ≠ ${f.width}×${f.height}`);
  }
  if (f.waist.length !== n) {
    throw new Error(`deckwater: DeckField waist ${f.waist.length} ≠ ${f.width}×${f.height}`);
  }
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(f.heights[i])) {
      throw new Error(`deckwater: DeckField height[${i}] is not finite`);
    }
  }
}

/** where the source's ship-space rectangle puts the grid (§T31 mapping) */
export function frameFromSource(src: DeckHeightfieldSource): DeckFrame {
  return {
    minX: src.minX,
    maxX: src.maxX,
    minZ: src.minZ,
    maxZ: src.maxZ,
    planeY: src.deckY,
  };
}

/**
 * Adapt src/ship's field to what the solver seeds from. The only real work is
 * the drain mask: coverage is fractional at the outline, and a texel that is
 * mostly outboard is not deck.
 */
export function deckFieldFromSource(src: DeckHeightfieldSource): DeckField {
  const n = src.width * src.height;
  if (src.data.length !== n || src.mask.length !== n) {
    throw new Error(
      `deckwater: source arrays (${src.data.length}/${src.mask.length}) ` +
      `≠ ${src.width}×${src.height} — deck field contract broken`,
    );
  }
  const drain = new Uint8Array(n);
  const waist = new Uint8Array(n);
  const cut = deckWaterParams.maskDrainBelow;
  const band = deckWaterParams.waistBand;
  for (let i = 0; i < n; i++) {
    // NaN coverage counts as off-deck: a hole in the mask must drain, never
    // become a cell that hoards water no head difference can reach
    if (!(src.mask[i] >= cut)) drain[i] = 1;
    else if (Math.abs(src.data[i]) <= band) waist[i] = 1;
  }
  cutFreeingPorts(src, drain, waist);
  const field: DeckField = {
    width: src.width,
    height: src.height,
    heights: src.data,
    drain,
    waist,
  };
  validateDeckField(field);
  return field;
}

export interface SyntheticDeckOptions {
  /** cells across the beam (ship x) */
  width: number;
  /** cells along the length (ship z) */
  height: number;
  /** crown at the centreline, metres — decks shed water outboard */
  camber?: number;
  /** gutter depth inboard of the bulwark, metres */
  waterwayDepth?: number;
  /** bulwark ring height, metres */
  bulwarkHeight?: number;
  /** freeing ports per side, cut through the bulwark to waterway level */
  portCount?: number;
}

/**
 * A synthetic stand-in for the ship's field, for headless tests and for
 * bringing the solver up before the ship exists. Deliberately crude — camber,
 * a waterway, a bulwark ring, freeing ports — because anything richer would
 * be a second authority on deck shape competing with src/ship's, which is the
 * one failure this module's header exists to prevent. Deterministic (§V2).
 */
export function syntheticDeckField(o: SyntheticDeckOptions): DeckHeightfieldSource {
  const w = Math.max(4, Math.round(o.width));
  const h = Math.max(4, Math.round(o.height));
  const camber = o.camber ?? 0.085;
  const waterway = o.waterwayDepth ?? 0.028;
  const bulwark = o.bulwarkHeight ?? 0.95;
  const ports = Math.max(0, Math.round(o.portCount ?? 4));
  const data = new Float32Array(w * h);
  const mask = new Float32Array(w * h);
  const ring = Math.max(1, Math.round(w * 0.04)); // bulwark thickness in cells

  for (let y = 0; y < h; y++) {
    // elliptical plan view, pointed at the stem — the same silhouette family
    // as sea-physics' waterlineFromBox fallback
    const t = (y + 0.5) / h; // 0 = transom, 1 = stem
    const halfSpan = 0.5 * Math.sqrt(Math.max(0, 1 - Math.pow(t * 1.9 - 0.9, 6)));
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const u = (x + 0.5) / w - 0.5; // −0.5 … +0.5 across the beam
      const inside = Math.abs(u) <= halfSpan;
      mask[i] = inside ? 1 : 0;
      if (!inside) {
        data[i] = 0;
        continue;
      }
      const across = halfSpan > 0 ? u / halfSpan : 0; // −1 … 1
      let height = camber * (1 - across * across);
      const edge = (1 - Math.abs(across)) * halfSpan * w; // cells from the outline
      if (edge < ring) {
        // freeing ports: cut the bulwark to waterway level at intervals, so
        // the deck has real drain paths rather than leaking off the border
        const port = ports > 0 && Math.abs(((y / h) * (ports + 1)) % 1 - 0.5) < 0.06;
        height = port ? -waterway : bulwark;
      } else if (edge < ring * 2.4) {
        height = -waterway; // the waterway gutter
      }
      data[i] = height;
    }
  }
  return {
    width: w,
    height: h,
    minX: -0.5,
    maxX: 0.5,
    minZ: -0.5,
    maxZ: 0.5,
    deckY: 0,
    data,
    mask,
  };
}

/**
 * Cut freeing ports through the bulwark, port and starboard, at intervals
 * along the length — a BOUNDARY CONDITION for the solve, not a change to the
 * ship's geometry (nothing here writes `heights`).
 *
 * WHY THIS IS NEEDED: the generated field rings the waist with a ~0.8 m
 * bulwark, and the outline drain sits OUTSIDE it. Measured on the galleon,
 * exactly 2 cells in 98,304 were both at waist level and touching a drain, so
 * the deck was a sealed tub: a boarding sea had no way off it and standing
 * water climbed past 1.5 m, held only by evaporation. Real ships solve this
 * with freeing ports — openings cut through the bulwark at deck level, which
 * is precisely what this marks.
 *
 * A port is a run of `scupperWidth` rows in which the bulwark cells on that
 * side become drains, so water in the waterway runs out through them in
 * channels (the look the talk shows) rather than seeping off everywhere.
 */
function cutFreeingPorts(
  src: DeckHeightfieldSource,
  drain: Uint8Array,
  waist: Uint8Array,
): void {
  const w = src.width;
  const h = src.height;
  const spacing = Math.max(2, Math.round(deckWaterParams.scupperSpacing));
  const width = Math.max(1, Math.round(deckWaterParams.scupperWidth));
  const band = deckWaterParams.waistBand;
  // §V28: literal-bounded walk — a port never eats more than a quarter beam,
  // so a malformed row cannot chew a hole clean across the deck
  const maxDepth = Math.max(1, Math.floor(w / 4));

  for (let y = 0; y < h; y++) {
    if (y % spacing >= width) continue;
    // The port has to reach the GUTTER, not merely deck level. The waterway
    // runs ~0.10 m below the deck plane with a ~0.27 m lip inboard of the
    // bulwark; a cut that stopped at the first waist-band cell left that lip
    // standing, and water needed 0.37 m of depth before it could climb out.
    let rowMin = Infinity;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (drain[i] === 0 && Math.abs(src.data[i]) <= band) {
        rowMin = Math.min(rowMin, src.data[i]);
      }
    }
    if (!Number.isFinite(rowMin)) continue; // no deck on this row at all
    const sill = rowMin + deckWaterParams.scupperSill;
    for (const dir of [1, -1] as const) {
      let x = dir === 1 ? 0 : w - 1;
      // find the outboard-most cell that is actually deck on this row
      while (x >= 0 && x < w && drain[y * w + x] === 1) x += dir;
      // ...then cut inward until the channel is down at gutter level
      for (let step = 0; step < maxDepth; step++) {
        const i = y * w + x;
        if (x < 0 || x >= w) break;
        if (drain[i] === 1) break;
        if (src.data[i] <= sill) break; // reached the gutter: the port is open
        drain[i] = 1;
        waist[i] = 0;
        x += dir;
      }
    }
  }
}
