/**
 * RAIL RUNS — balusters, cap, sill, bulwark panel, and the gaps a staircase
 * lands in. One idiom, shared by the curved side runs (pieceGeometryCastle's
 * `buildCurvedRail`) and the straight athwartships runs (pieceGeometryFittings'
 * `buildRailGeometry`), so a rail looks like a rail wherever it is.
 *
 * WHY THIS EXISTS (§T.45, user: "railings that are all the way around except
 * for 2 staircases left and right around the steering wheel", and "make it feel
 * much more solid"). Both builders previously emitted three axis-aligned boxes
 * per bay — a 0.09 m square post, a cap, a mid rail — at a FIXED 13 stations
 * regardless of run length. On the 28 m main run that is a post every 2.154 m,
 * where the reference has turned balusters every 0.2-0.3 m: seven to ten times
 * too coarse, and square, so the "railing" read as scaffolding.
 *
 * THREE THINGS THIS FIXES AT ONCE, all of which the old shape made impossible:
 *
 *  1. SPACING IS A DIMENSION, NOT A COUNT. Stations come from
 *     `balusterSpacing` against the run's own arc length, so a 5 m castle run
 *     and a 20 m waist run get the same LOOK rather than the same number of
 *     posts.
 *  2. GAPS. Neither builder could express an opening, so the stairs simply
 *     intersected the rails and the bulkheads (nothing anywhere cut a hole).
 *     A run is now a path minus a set of arc-length intervals, and each
 *     resulting SPAN gets its own cap, sill and NEWEL posts — which is what
 *     makes an opening read as a companionway rather than as damage.
 *  3. THE BULWARK. Amidships the solid topside is only `bulwarkLip` (0.28 m)
 *     and the cap rail stands 1.0 m up and 0.22 m inboard of it, leaving a
 *     0.72 m band of open air crossed by one thin mid rail. That is why the
 *     waist reads as a fence beside a kerb instead of a bulwark you shelter
 *     behind. `panelHeight` fills it with solid boarding, which is also what
 *     the deck-water solver has believed all along — `deckHeightfield.ts` uses
 *     BULWARK_HEIGHT 0.95 as the wall its water cannot cross (§V.37: mating
 *     systems should share their dimensions, and these two disagreed by 3x).
 *
 * §V2: every jitter is the seeded hash, so two clients build the same rail.
 */
import * as THREE from 'three';
import { mergeNonIndexed } from './pieceGeometryShapes';
import { shipDetailParams } from '../params/ship';
import { vhash, vjitter } from './variation';

export type RailPoint = [x: number, y: number, z: number];

/** an opening in a run, as an interval of ARC LENGTH from the run's start */
export interface RailGap {
  center: number;
  half: number;
}

export interface RailProfile {
  /** deck → top of the cap rail, in metres */
  height: number;
  /** cap rail cross-section */
  capWidth: number;
  capHeight: number;
  /** metres between balusters — a DIMENSION, never a count */
  balusterSpacing: number;
  /** the baluster's widest radius (its belly) */
  balusterRadius: number;
  /**
   * Height of the SOLID boarding at the foot of the run, in metres. 0 gives an
   * open balustrade, which is right on a castle deck you look over; the waist
   * wants real bulwark.
   */
  panelHeight: number;
  /** how far the newel posts either side of a gap over-stand the cap */
  newelRise: number;
  /** seed so port and starboard are not mirror images (§V2) */
  seed: number;
}

/** cumulative arc length at each path point; last entry is the run length */
function arcLengths(path: readonly RailPoint[]): number[] {
  const cum = [0];
  for (let i = 1; i < path.length; i++) {
    const [x0, , z0] = path[i - 1];
    const [x1, , z1] = path[i];
    cum.push(cum[i - 1] + Math.hypot(x1 - x0, z1 - z0));
  }
  return cum;
}

/** point on the run at arc length `s`, linearly interpolated */
function pointAt(path: readonly RailPoint[], cum: readonly number[], s: number): RailPoint {
  const total = cum[cum.length - 1];
  const t = Math.min(total, Math.max(0, s));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < t) i++;
  const span = Math.max(1e-6, cum[i] - cum[i - 1]);
  const f = (t - cum[i - 1]) / span;
  const a = path[i - 1];
  const b = path[i];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/**
 * The run's spans — the path with the gaps removed. Returned as arc-length
 * intervals, so everything downstream works in one parameter and none of it
 * has to know the path is curved.
 */
function spansOf(total: number, gaps: readonly RailGap[]): Array<[number, number]> {
  const cuts = gaps
    .map((g) => [Math.max(0, g.center - g.half), Math.min(total, g.center + g.half)] as const)
    .filter(([a, b]) => b > a)
    .sort((p, q) => p[0] - q[0]);
  const spans: Array<[number, number]> = [];
  let cursor = 0;
  for (const [a, b] of cuts) {
    if (a - cursor > 0.05) spans.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (total - cursor > 0.05) spans.push([cursor, total]);
  return spans;
}

/**
 * A TURNED baluster — the single change that does most of the work.
 *
 * A lathe profile, not a box: the reference's balusters have a foot block, a
 * cove, a belly and a neck, and it is the belly catching a highlight down a
 * whole run that reads as "turned timber" rather than "fence". Six radial
 * segments is deliberately coarse — at 0.28 m spacing there are hundreds of
 * these per ship and none is ever more than a few centimetres across on
 * screen, so the profile silhouette is what matters and the roundness is not.
 */
function baluster(radius: number, height: number, seed: number): THREE.BufferGeometry {
  // (radius fraction, height fraction) up the baluster
  const PROFILE: ReadonlyArray<readonly [number, number]> = [
    [0.78, 0.0],
    [0.78, 0.09],
    [0.46, 0.19],
    [1.0, 0.36],
    [0.5, 0.58],
    [0.72, 0.74],
    [0.44, 0.88],
    [0.7, 0.95],
    [0.7, 1.0],
  ];
  // §V2: a couple of percent of per-baluster size and twist, so a run of two
  // hundred is not two hundred copies of one object
  const wobble = 1 + vjitter(0.06 * shipDetailParams.irregularity, seed, 3.7);
  const points = PROFILE.map(
    ([r, h]) => new THREE.Vector2(Math.max(0.004, radius * r * wobble), height * h),
  );
  const geo = new THREE.LatheGeometry(points, 6);
  geo.rotateY(vjitter(0.5 * shipDetailParams.irregularity, seed, 9.1));
  return geo;
}

/** a box spanning one segment of the run, aligned to it */
function segmentBox(
  a: RailPoint,
  b: RailPoint,
  width: number,
  heightAbove: number,
  thickness: number,
): THREE.BufferGeometry {
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  const len = Math.hypot(dx, dz);
  if (len < 1e-4) return new THREE.BufferGeometry();
  const geo = new THREE.BoxGeometry(width, thickness, len + width * 0.5);
  geo.rotateY(Math.atan2(dx, dz));
  geo.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + heightAbove, (a[2] + b[2]) / 2);
  return geo;
}

/**
 * Build a rail run along `path` (the rail centreline at DECK level — the
 * caller has already applied taper and sheer), with `gaps` cut out of it.
 *
 * Everything is measured UP from each path point, so a run over a sheered deck
 * keeps a constant rail height above the planking rather than following a
 * straight line through it.
 */
export function buildRailRun(
  path: readonly RailPoint[],
  profile: RailProfile,
  gaps: readonly RailGap[] = [],
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  if (path.length < 2) return new THREE.BufferGeometry();
  const cum = arcLengths(path);
  const total = cum[cum.length - 1];
  const { height, capWidth, capHeight, panelHeight, balusterRadius, seed } = profile;
  // never let a bad param produce a run with no balusters at all
  const spacing = Math.max(0.08, profile.balusterSpacing);
  const sillH = Math.min(0.08, height * 0.12);
  const capBottom = height - capHeight;

  for (const [s0, s1] of spansOf(total, gaps)) {
    const spanLen = s1 - s0;
    // resample this span finely enough that the cap follows the hull curve
    // rather than chording across it
    const segs = Math.max(1, Math.round(spanLen / 0.6));
    const pts: RailPoint[] = [];
    for (let i = 0; i <= segs; i++) pts.push(pointAt(path, cum, s0 + (spanLen * i) / segs));

    for (let i = 0; i < segs; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      // CAP RAIL, in two stacked boards: the upper one narrower, which is a
      // chamfered arris for the price of a box (§T.34 "90° arrises ⊥" — a true
      // sharp edge reads as one aliased line whatever the light does)
      parts.push(segmentBox(a, b, capWidth, capBottom + capHeight * 0.35, capHeight * 0.7));
      parts.push(
        segmentBox(a, b, capWidth * 0.78, capBottom + capHeight * 0.85, capHeight * 0.3),
      );
      // SILL the balusters stand on
      parts.push(segmentBox(a, b, capWidth * 0.8, sillH / 2, sillH));
      // SOLID BULWARK BOARDING, where this run carries it
      if (panelHeight > 0.01) {
        parts.push(
          segmentBox(a, b, capWidth * 0.62, sillH + panelHeight / 2, panelHeight),
        );
      }
    }

    // BALUSTERS, spaced by dimension and inset from the newels at both ends
    const inset = Math.min(spanLen * 0.5, capWidth * 0.9);
    const usable = Math.max(0, spanLen - inset * 2);
    const count = Math.max(1, Math.round(usable / spacing));
    const footY = sillH + panelHeight;
    const balusterH = Math.max(0.1, capBottom - footY);
    for (let i = 0; i <= count; i++) {
      const s = s0 + inset + (count === 0 ? usable / 2 : (usable * i) / count);
      const [x, y, z] = pointAt(path, cum, s);
      const bal = baluster(balusterRadius, balusterH, seed + s * 3.1);
      bal.translate(x, y + footY, z);
      parts.push(bal);
    }

    // NEWELS at both ends of every span. On a gap boundary this is the post a
    // companionway hand-rail dies into; on a run end it is the stanchion that
    // stops the cap rail floating.
    for (const s of [s0, s1]) {
      const [x, y, z] = pointAt(path, cum, s);
      const w = capWidth * 0.95;
      const h = height + profile.newelRise;
      const post = new THREE.BoxGeometry(w, h, w);
      post.translate(x, y + h / 2, z);
      parts.push(post);
      // a chamfered cap block, so a newel terminates instead of stopping
      const knob = new THREE.BoxGeometry(w * 1.35, w * 0.5, w * 1.35);
      knob.translate(x, y + h + w * 0.22, z);
      parts.push(knob);
    }
  }

  return mergeNonIndexed(parts.filter((g) => g.getAttribute('position') !== undefined));
}

/**
 * Read the gap declarations a blueprint attaches to a rail piece.
 *
 * `PieceDef.shape` is `Record<string, number>`, so a variable-length list has
 * to be spelled out. Kept as one reader rather than parsed at each call site,
 * because a silently-unread gap is a staircase that opens into a railing
 * (§V.62: a declaration nothing consumes is the same defect as a dead knob).
 */
export function readRailGaps(shape?: Record<string, number>): RailGap[] {
  if (shape === undefined) return [];
  const gaps: RailGap[] = [];
  const count = Math.max(0, Math.min(4, Math.round(shape.gapCount ?? 0)));
  for (let i = 0; i < count; i++) {
    const center = shape[`gap${i}Center`];
    const half = shape[`gap${i}Half`];
    if (center === undefined || half === undefined || !(half > 0)) continue;
    gaps.push({ center, half });
  }
  return gaps;
}

/** the shared profile, so every run on a ship is recognisably the same joinery */
export function railProfile(
  height: number,
  thickness: number,
  opts: { panelHeight?: number; seed?: number } = {},
): RailProfile {
  const d = shipDetailParams;
  return {
    height,
    capWidth: thickness * 1.5,
    capHeight: Math.min(0.14, height * 0.16),
    balusterSpacing: d.balusterSpacing,
    balusterRadius: d.balusterRadius,
    panelHeight: opts.panelHeight ?? 0,
    newelRise: Math.min(0.18, height * 0.16),
    seed: opts.seed ?? 1,
  };
}

/**
 * Deterministic per-run seed, so port and starboard are not mirror images
 * (§V2). Keyed on numbers the run already knows — its side and its station —
 * rather than on a piece id, so `buildPieceGeometry`'s signature does not have
 * to grow one just to carry a seed.
 */
export function railSeed(...keys: number[]): number {
  return vhash(...keys) * 1000;
}
