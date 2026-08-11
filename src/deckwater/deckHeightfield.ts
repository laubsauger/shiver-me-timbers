/**
 * Placeholder deck heightfield for the §V9 shallow water sim: top-down 2D
 * height grid of the ship deck (x = along length, y = across beam). Encodes
 * deck camber (center crown so water runs to the sides), plank seam grooves
 * (water lingers in crevices), and raised rails at every edge so water pools
 * before draining through a few scupper gaps cut to deck level.
 * Deterministic pure function — ship piece-graph integration replaces this
 * later (§V13) but must keep the same Float32Array row-major contract.
 */

export interface DeckHeightfieldOptions {
  /** cells along ship length (x) */
  width: number;
  /** cells across the beam (y) */
  height: number;
  /** camber crown height at beam centerline (height units) */
  camberHeight?: number;
  /** cells between plank seams — planks run lengthwise (seams at const y) */
  plankSpacing?: number;
  /** seam groove depth (height units) */
  plankGrooveDepth?: number;
  /** seam groove width in cells */
  plankGrooveWidth?: number;
  /** rail height above deck at the grid border (height units) */
  railHeight?: number;
  /** rail thickness in cells */
  railWidth?: number;
  /** scupper gaps per side (long) rail, cut down to deck level */
  scupperCount?: number;
  /** scupper gap width in cells */
  scupperWidth?: number;
}

/**
 * Row-major Float32Array, index = y * width + x. Height 0 = deck base at the
 * rail line; interior deck rises with camber; rails sit railHeight above.
 * Off-grid hydraulic head is 0 (fluxMath.EDGE_DRAIN_HEAD) so scupper cells
 * (height 0) are the preferred drain paths.
 */
export function generateDeckHeightfield(o: DeckHeightfieldOptions): Float32Array {
  const {
    width: w,
    height: h,
    camberHeight = 0.03,
    plankSpacing = 8,
    plankGrooveDepth = 0.008,
    plankGrooveWidth = 1,
    railHeight = 0.15,
    railWidth = 3,
    scupperCount = 4,
    scupperWidth = 6,
  } = o;

  const field = new Float32Array(w * h);
  const halfBeam = (h - 1) / 2;

  for (let y = 0; y < h; y++) {
    // camber: parabolic crown, max at beam center, 0 at the rail line
    const t = (y - halfBeam) / halfBeam; // -1..1 across the beam
    const camber = camberHeight * (1 - t * t);
    // plank seam grooves run lengthwise → rows at regular y intervals
    const seam = y % plankSpacing < plankGrooveWidth;
    for (let x = 0; x < w; x++) {
      let v = camber;
      if (seam) v = Math.max(0, v - plankGrooveDepth);
      if (isRail(x, y, w, h, railWidth, scupperCount, scupperWidth)) {
        v = camberHeight + railHeight; // rails top out above any deck point
      } else if (isScupper(x, y, w, h, railWidth, scupperCount, scupperWidth)) {
        v = 0; // scupper: rail cut to base level — drains overboard
      }
      field[y * w + x] = v;
    }
  }
  return field;
}

/** cell is inside the rail band along any edge (and not a scupper gap) */
function isRail(
  x: number,
  y: number,
  w: number,
  h: number,
  railWidth: number,
  scupperCount: number,
  scupperWidth: number,
): boolean {
  const inBand = x < railWidth || x >= w - railWidth || y < railWidth || y >= h - railWidth;
  if (!inBand) return false;
  return !isScupper(x, y, w, h, railWidth, scupperCount, scupperWidth);
}

/**
 * Scupper gaps: evenly spaced cuts in the two long (side) rails only,
 * excluding the corners so bow/stern rails stay closed.
 */
function isScupper(
  x: number,
  y: number,
  w: number,
  h: number,
  railWidth: number,
  scupperCount: number,
  scupperWidth: number,
): boolean {
  if (scupperCount <= 0) return false;
  const onSideRail = y < railWidth || y >= h - railWidth;
  if (!onSideRail) return false;
  if (x < railWidth || x >= w - railWidth) return false; // keep corners closed
  for (let i = 0; i < scupperCount; i++) {
    const center = ((i + 1) * w) / (scupperCount + 1);
    if (Math.abs(x - center) <= scupperWidth / 2) return true;
  }
  return false;
}
