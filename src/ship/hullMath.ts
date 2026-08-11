/**
 * Pure hull-loft math (§V18 data → shape). No three.js, no side effects, so
 * BOTH the blueprint generators (which must stay mesh-free) and the geometry
 * builders read the SAME envelope — a castle slab, a gallery band and the
 * shell strip can never disagree about how wide the hull is at a station.
 * That disagreement was the "ugly panels poking out of the stern" bug.
 */

/** shape hints every hull-family piece carries (all plain numbers, §V18) */
export interface HullShape {
  side: number; // -1 port, +1 starboard, 0 = both (bow/transom pieces)
  z0: number; // ship-space span of this piece
  z1: number;
  beamHalf: number;
  bowZ: number; // z of the stem point
  sternZ: number; // z of the transom
  draft: number;
  freeboard: number;
  sheerBow: number;
  sheerStern: number;
  tumblehome: number;
  keelPinch: number;
}

export function asHullShape(shape: Record<string, number> | undefined): HullShape | null {
  if (shape === undefined || shape.beamHalf === undefined) return null;
  return shape as unknown as HullShape;
}

/** plan-view half-breadth multiplier: 1 amidships → 0 at the stem,
 *  rounded in to ~0.55 at the transom */
export function hullEnvelope(z: number, s: HullShape): number {
  const bowStart = s.bowZ * 0.3;
  const sternStart = s.sternZ * 0.55;
  if (z >= bowStart) {
    const v = Math.max(0, (s.bowZ - z) / Math.max(1e-3, s.bowZ - bowStart));
    return Math.pow(v, 0.72); // convex waterlines → pointed stem
  }
  if (z <= sternStart) {
    const w = Math.max(0, (z - s.sternZ) / Math.max(1e-3, sternStart - s.sternZ));
    return 0.55 + 0.45 * Math.pow(w, 0.65); // rounded stern quarters
  }
  return 1;
}

/** rail rise toward bow/stern (sheer curve) */
export function hullSheer(z: number, s: HullShape): number {
  const fore = Math.max(0, z) / Math.max(1e-3, s.bowZ);
  const aft = Math.max(0, -z) / Math.max(1e-3, -s.sternZ);
  return s.sheerBow * fore * fore + s.sheerStern * aft * aft;
}

/** cross-section half-width at height fraction h (0 keel → 1 rail):
 *  pinched keel, round bilge widest near the waterline, tumblehome above */
export function sectionHalf(env: number, h: number, s: HullShape): number {
  const hMax = 0.6;
  const hc = Math.min(1, Math.max(0, h));
  if (hc <= hMax) {
    const t = hc / hMax;
    const bilge = Math.sin((t * Math.PI) / 2);
    return env * (s.keelPinch + (1 - s.keelPinch) * Math.pow(bilge, 0.8));
  }
  const t = (hc - hMax) / (1 - hMax);
  return env * (1 - s.tumblehome * t * t);
}

/** shell top (rail line) height at station z */
export function hullTopY(z: number, s: HullShape): number {
  return s.freeboard + hullSheer(z, s);
}

/**
 * Half-width of the SHELL at station z and world height y (clamped to the
 * rail line). Any piece that must stay inside the hull silhouette — decks,
 * castle slabs, cabin, gallery, balustrade — sizes itself from this instead
 * of from a hand-picked fraction of the beam.
 */
export function hullHalfWidthAt(z: number, y: number, s: HullShape): number {
  const top = hullTopY(z, s);
  const h = (y + s.draft) / Math.max(1e-3, top + s.draft);
  return s.beamHalf * sectionHalf(hullEnvelope(z, s), h, s);
}
