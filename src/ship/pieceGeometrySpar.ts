/**
 * SPAR FITTINGS — the ironwork and cordage that makes a mast read as a made
 * spar rather than as a lathe-turned dowel.
 *
 * §T.34 has listed "mast taper/hoops rework" since the detail pass was written
 * and nothing had touched it: `mast`, `bowsprit` and `yard` all returned a bare
 * `CylinderGeometry`, 12-sided and 8-sided respectively, with no fitting of any
 * kind anywhere along their length. On a 31.5 m mainmast that is thirty metres
 * of unbroken cylinder, and it is the reason the rig reads as scaffolding poles
 * — there is no feature at any scale between the whole spar and the wood
 * grain, so the eye has nothing to judge size by.
 *
 * WHAT A REAL SPAR CARRIES, and what each one is doing here:
 *
 *  - HOOPS. A lower mast is not one tree; it is several baulks bound into a
 *    "made" mast with iron bands at intervals. They are the strongest size cue
 *    on the spar because their spacing is roughly constant while the mast
 *    tapers, so they read the taper for you.
 *  - WOOLDINGS. Rope wrappings, several turns tight together, laid where the
 *    made mast most needs binding — low down, and at the partners. Modelled as
 *    a tight group of small rings so they read as cordage next to the wider,
 *    flatter iron.
 *  - THE PARTNER COLLAR. Where a mast passes through the deck it is wedged and
 *    then covered with a canvas coat over a collar. `deckHeightfield.ts`
 *    already raises PARTNER_HEIGHT (0.055 m) of terrain there for the water to
 *    flow around, so the geometry and the water agreed about the wedge
 *    everywhere except that the geometry did not draw one (§V.37).
 *
 * §V2: band stations are jittered off the seeded hash, so a mast is not a
 * perfectly regular stack of rings — the same "ultra regular everywhere" note
 * that drove the plank work applies to a row of hoops.
 */
import * as THREE from 'three';
import type { AABB } from './pieceTypes';
import { aabbCenter, aabbSize, mergeNonIndexed } from './pieceGeometryShapes';
import { shipDetailParams } from '../params/ship';
import { vjitter } from './variation';

/** a band around a spar: a short, slightly-oversized cylinder */
function band(
  radius: number,
  thickness: number,
  y: number,
  sides: number,
): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(radius, radius, thickness, sides);
  geo.translate(0, y, 0);
  return geo;
}

/**
 * Radius of a linearly tapered spar at height fraction `t`, matching the
 * cylinder the bands are being wrapped around. A band sized off the FOOT
 * radius floats off the wood by the time it is halfway up a 31 m mast — the
 * taper is 45%, so that error is centimetres at the top and very visible.
 */
function radiusAt(rBase: number, topScale: number, t: number): number {
  return rBase * (1 + (topScale - 1) * t);
}

/**
 * A tapered spar with its ironwork: hoops up the length, a woolding group low
 * down, and (for a mast stepped on a deck) a partner collar at the foot.
 *
 * @param topScale radius at the head as a fraction of the radius at the foot
 * @param opts.partners draw the deck collar — masts yes, bowsprit no
 */
export function buildMastGeometry(
  aabb: AABB,
  topScale: number,
  opts: { partners?: boolean } = {},
): THREE.BufferGeometry {
  const d = shipDetailParams;
  const s = aabbSize(aabb);
  const c = aabbCenter(aabb);
  const rBase = s.x / 2;
  const length = s.y;
  const sides = 16; // was 12: a mast is the longest silhouette on the ship

  const parts: THREE.BufferGeometry[] = [
    new THREE.CylinderGeometry(rBase * topScale, rBase, length, sides).translate(
      0,
      length / 2,
      0,
    ),
  ];

  // HOOPS at a fixed SPACING, so a short foremast and a tall mainmast get the
  // same look rather than the same count (§V.66 — scale a feature by its own
  // dimension, and the dimension here is metres of spar, not "a mast")
  const spacing = Math.max(0.4, d.mastHoopSpacing);
  const count = Math.max(1, Math.floor(length / spacing) - 1);
  for (let i = 1; i <= count; i++) {
    const jitter = vjitter(0.16 * d.irregularity, i, rBase * 100);
    const t = Math.min(0.97, Math.max(0.02, (i * spacing + jitter) / length));
    const r = radiusAt(rBase, topScale, t);
    parts.push(band(r * 1.07, d.mastHoopThickness, t * length, sides));
  }

  // WOOLDING: several turns of rope together, low down where a made mast is
  // bound. Smaller in section than the iron and grouped, which is what tells
  // them apart at any distance where both are visible at all.
  const turns = Math.max(0, Math.round(d.mastWooldingTurns));
  const wooldY = length * 0.16;
  const turnGap = d.mastHoopThickness * 1.5;
  for (let i = 0; i < turns; i++) {
    const y = wooldY + (i - (turns - 1) / 2) * turnGap;
    const r = radiusAt(rBase, topScale, y / length);
    parts.push(band(r * 1.09, d.mastHoopThickness * 0.8, y, sides));
  }

  // PARTNER COLLAR at the deck — a wedged mast, coated. Matches the raised
  // terrain deckHeightfield already puts here for the deck water.
  if (opts.partners === true) {
    const collar = new THREE.CylinderGeometry(rBase * 1.45, rBase * 1.7, 0.22, sides);
    collar.translate(0, 0.11, 0);
    parts.push(collar);
  }

  return mergeNonIndexed(parts).translate(c.x, aabb.min[1], c.z);
}

/**
 * A yard: a spar tapering to BOTH ends, banded, with a thicker group at the
 * slings where it is bound to the mast.
 *
 * `case 'yard'` returned a plain 8-sided cylinder of constant radius — no
 * taper and no fitting at all, which another agent flagged while working on
 * the sails. The sail's own attachment points are the robands in `sailTies()`
 * and are not ours; this is the spar those ties are made fast to, and it
 * should look like something you could make a rope fast to.
 */
export function buildYardGeometry(aabb: AABB): THREE.BufferGeometry {
  const d = shipDetailParams;
  const s = aabbSize(aabb);
  const c = aabbCenter(aabb);
  const r = s.y / 2;
  const length = s.x;
  const sides = 8;
  const parts: THREE.BufferGeometry[] = [];

  /**
   * TAPERED TO BOTH ENDS, in three segments rather than one cylinder: a yard
   * is thickest at the slings and thinnest at the yardarms, and a constant
   * radius is the single most obvious thing wrong with a bare cylinder used as
   * a spar. Three frusta is enough — the silhouette is what carries it.
   */
  const rTip = r * 0.55;
  const rMid = r;
  const seg = length / 2;
  for (const sign of [-1, 1]) {
    const half = new THREE.CylinderGeometry(rTip, rMid, seg, sides);
    half.rotateZ(sign * Math.PI * 0.5);
    half.translate((sign * seg) / 2, 0, 0);
    parts.push(half);
  }

  // SLINGS: the doubled band at the centre where the yard is bound to the mast
  const slings = new THREE.CylinderGeometry(rMid * 1.22, rMid * 1.22, r * 1.6, sides);
  slings.rotateZ(Math.PI / 2);
  parts.push(slings);

  // and banding out toward the yardarms, on the same spacing rule as the mast
  const spacing = Math.max(0.4, d.mastHoopSpacing);
  const count = Math.max(1, Math.floor(seg / spacing));
  for (let i = 1; i <= count; i++) {
    for (const sign of [-1, 1]) {
      const t = (i * spacing) / seg;
      if (t > 0.95) continue;
      const x = sign * t * seg;
      const rr = rMid + (rTip - rMid) * t;
      const b = new THREE.CylinderGeometry(rr * 1.1, rr * 1.1, d.mastHoopThickness, sides);
      b.rotateZ(Math.PI / 2);
      b.translate(x, 0, 0);
      parts.push(b);
    }
  }

  return mergeNonIndexed(parts).translate(c.x, c.y, c.z);
}
