/**
 * SAIL SHAPE PROFILES — the pure, dimensionless curves the cloth is built
 * from, and the constants they share.
 *
 * Split out of sailShape.ts at the §C file cap. Nothing here knows about a
 * sail's size, its wind state or its clock: every function takes a normalised
 * coordinate and returns a fraction. sailShape.ts composes them into metres,
 * and sailMaterial.ts transliterates the same expressions into TSL — which is
 * why the constants are exported rather than repeated (the material used to
 * carry its own copies of 0.22/0.9/0.3/1.3/2.1).
 *
 * §V28: every divisor floored. These feed rope endpoints and shader uniforms,
 * and a NaN here becomes a NaN rope.
 */
import type { ShipMaterialParams } from '../params/ship';

/**
 * The shape constants. sailMaterial.ts IMPORTS these rather than repeating the
 * literals — it used to carry its own copies of 0.22/0.9/0.3/1.3/2.1, which is
 * the drift this file's header warns about sitting one typo away from
 * happening. There is no cost to sharing them: they are plain numbers, and
 * only the expressions around them have to be transliterated.
 */
export const SAIL_SKEW_LEAD = 0.22; // how far the DRAFT shifts to leeward
/**
 * HORIZONTAL DRAFT PROFILE (user: "way too steep a bulge in the middle and
 * then nothing towards the sides… it has to be more distributed").
 *
 * This used to be `sin²(πu)`, and the vertical profile below was MULTIPLIED
 * into it. Two centred bumps in a product is the worst possible arrangement:
 * measured over a whole course, the mean depth came to 0.31 of the peak, and
 * one tenth of the way in from a leech the cloth was at 9.5% of full — i.e.
 * the outer fifth of the sail on each side was flat panel, with all the shape
 * crammed into a lens in the middle. sin² also leaves BOTH edges with zero
 * slope, so the canvas lies down tangent to the flat plane at the leeches
 * rather than pulling away from them.
 *
 * The replacement is the actual small-deflection solution for a membrane
 * under uniform pressure with both edges held: a PARABOLA. It carries 0.66 of
 * its peak as a mean (+29% of average depth at the same peak) and leaves each
 * leech at a real angle. `sailDraftFullness` is the exponent on it — 1 is the
 * membrane, higher narrows back toward the old lens — and `sailDraftPos`
 * moves the deepest point, which on real canvas sits about 40% aft of the
 * luff rather than at the midpoint.
 *
 * The SECTION still goes to exactly zero at both leeches — "distributed"
 * means the falloff is a boundary layer at the edge, not the whole
 * half-width. The EDGE ITSELF is then allowed to stand off the bellied
 * surface by `sailLeechOpen`, which is a separate term; see
 * {@link leechStandoff} for why pinning it at every height was wrong.
 */
export const SAIL_DRAFT_MIN = 0.28; // draft cannot crowd the luff…
export const SAIL_DRAFT_MAX = 0.72; // …nor the leech
export const SAIL_LEAD_MAX = 0.3; // |lead|·π < 1 keeps the warp monotone
/**
 * VERTICAL BELLY PROFILE (user: "they have no billow to them").
 *
 * This used to be one monotone ramp — `smoothstep(0, 0.9, 1−v)` — which is
 * zero at the head and DEEPEST AT THE FOOT. That is the shape of a flag
 * blowing off a pole, not of a sail under load: the vertical section has no
 * inflection, so the whole lower sail moves forward together and the surface
 * reads as a tilted plane no matter how deep the number says it is. It shaded
 * flat because it genuinely was flat in one direction.
 *
 * A square sail is bent to its yard at the head and hauled down at the clews,
 * so the canvas is deepest around the middle and comes back at BOTH ends. The
 * foot never returns fully — it is a free edge — hence FOOT_FILL rather than
 * a second taper to zero.
 */
export const SAIL_BELLY_HEAD = 0.55; // taper span below the head, in v
export const SAIL_BELLY_FOOT = 0.45; // ease span above the foot, in v
export const SAIL_FOOT_FILL = 0.55; // belly remaining at the free foot
export const SAIL_FLUTTER_BASE = 0.3; // shake floor before luff adds to it
export const SAIL_FLUTTER_EDGE = 1.3; // extra ripple toward the leeches
export const SAIL_FLUTTER_V = 2.1; // ripple phase advance down the cloth

/**
 * ARC-LENGTH COEFFICIENT. A parabolic arc of depth d over a chord c has
 * length c·(1 + 8/3·(d/c)² − …), so a strip of cloth that bows by d must give
 * up that much SPAN to keep the length it was cut with.
 *
 * This is the term that was missing, and it is a third cause of "bulgy",
 * independent of how deep the belly is: without it the sail gains SURFACE
 * AREA as the wind rises. It inflates like a balloon instead of bowing like a
 * fixed piece of canvas, and no amount of depth tuning can hide that.
 *
 * Exact for the horizontal section, which IS a parabola pinned at both
 * leeches ({@link sailDraftProfile}). Reused verbatim for the vertical bow,
 * whose profile is a different single-hump shape — nobody can perceive the
 * difference between 8/3 and the ~2.4 that profile's own integral gives, and
 * one coefficient with one derivation is worth more than two.
 */
export const SAIL_ARC_COEFF = 8 / 3;

/** 1 at mid-width, 0 at both leeches. Its complement is the leech weight. */
export function midArch(u: number): number {
  return 4 * u * (1 - u);
}

/**
 * How many vertical cloths a sail of this width is sewn from.
 *
 * A bolt of canvas is a FIXED width, so a wider sail is made of MORE cloths,
 * not wider ones. This used to be a flat `sailPanelCount = 7` on every sail,
 * which gave the 12.17 m main course 1.74 m "cloths" and the 8.69 m topsail
 * 1.24 m — not a bolt of anything, and different on two sails of the same
 * ship, which is the "ultra regular / generated" tell §V43 is about.
 *
 * sailMaterial.ts transliterates this expression against the sail's own
 * `sailShape.y` attribute; it lives here so the intent is testable.
 * §V28: floored divisor, and never fewer than two cloths.
 */
/**
 * Peak camber as a fraction of the CHORD, from the wind drive. Signed: a
 * backed sail bows the other way. Bounded at source (§V44).
 */
export function sailCamberRatio(drive: number, p: ShipMaterialParams): number {
  const cap = Math.max(0, finite(p.sailCamberMax, 0.15));
  return clamp(finite(drive) * Math.max(0, finite(p.sailCamber)), -cap, cap);
}

/**
 * The factor a bowed strip's SPAN shrinks by to hold its arc length, given
 * that strip's own camber ratio. ≤ 1 always, and the divisor is ≥ 1 by
 * construction so §V28 needs no floor here.
 *
 * This is what makes the clews visibly draw INWARD and UP as she fills — the
 * single cue that separates cloth from an inflating bag, and the reason the
 * sheets and their blocks now have something real to follow.
 */
export function arcShorten(camberRatio: number): number {
  const k = finite(camberRatio);
  return 1 / (1 + SAIL_ARC_COEFF * k * k);
}

/**
 * How far the free LEECH stands off the bellied surface, as a fraction of the
 * peak camber depth.
 *
 * THE OLD MODEL PINNED BOTH LEECHES TO ZERO AT EVERY HEIGHT, on the reasoning
 * that they are "bolt-roped and sheeted, so a belly that did not close there
 * would tear the cloth off its own edges". That reasoning is wrong, and it is
 * why the sail's projected outline was a PERFECT RECTANGLE in every wind, at
 * every angle, at every trim. A bolt rope is sewn ALONG an edge; it stiffens
 * the edge, it does not attach it to anything. A square sail's leech is bent
 * to the ship at exactly TWO points — the yardarm at the head and the clew at
 * the foot — and flies free between them.
 *
 * So: zero at v = 1 (bent to the yard) and at v = 0 (hauled to the sheet),
 * maximal in between; zero at mid-width, maximal at both edges. That is the
 * curved leech in the reference, and half of the user's twice-made complaint
 * that "the top and bottom corners don't have to be perfectly straight
 * aligned" — a z-only displacement field pinned at its edges cannot round a
 * corner, by construction.
 */
export function leechStandoff(u: number, v: number): number {
  return (1 - midArch(clamp01(finite(u)))) * Math.sin(Math.PI * clamp01(finite(v)));
}

/**
 * The draft position at height v: the base position, less the leeward lag of
 * a swing, plus TWIST — the draft migrating aft between the foot and the head
 * under load, so the upper sections present at a different angle from the
 * lower ones.
 *
 * Twist shares the base draft's tack-blindness: `sailDraftPos` is documented
 * as "aft of the luff" but u is just port→starboard, so the asymmetry points
 * the same way on both tacks. Pre-existing (§Rule 3), recorded here because
 * twist makes it more visible, not because twist introduced it.
 */
export function sailDraftAt(
  v: number,
  drive: number,
  skew: number,
  p: ShipMaterialParams,
): number {
  const vv = clamp01(finite(v));
  return (
    finite(p.sailDraftPos, 0.4)
    - finite(skew) * SAIL_SKEW_LEAD * (1 - vv)
    + finite(p.sailTwist) * finite(drive) * (vv - SAIL_BELLY_FOOT)
  );
}

/**
 * MESH SAMPLES PER CLOTH PANEL. The quilting below is a periodic term carried
 * in the VERTEX stage, so its band limit is the MESH, not the pixel grid — a
 * panel the mesh cannot resolve aliases into a shape nobody authored, and no
 * amount of `fwidth` reaches it because there is no fragment involved.
 *
 * Four is the working minimum: two is exactly Nyquist and puts every sample on
 * a node or an antinode depending on phase, which is how a real repeat turns
 * into a beat. `buildSailGeometry` derives its segment count from this and the
 * lacing count, so the geometry can never silently fall behind the shape it
 * has to carry.
 */
export const SAIL_SAMPLES_PER_PANEL = 4;

/**
 * WHERE THE SAIL'S HEAD IS LASHED TO ITS YARD, in the sail's own u.
 *
 * ONE SOURCE FOR TWO THINGS THAT ARE THE SAME THING. `sailTies()` builds the
 * robands you can see on the cross beam from these stations, and the cloth's
 * vertical seams land on exactly the same u — because a seam IS where a
 * roband goes. A seam is doubled, stiffer canvas; that is what you pass a
 * lashing through.
 *
 * They used to be two independent numbers — a hard `count = 7` in `sailTies()`
 * beside a seam grid derived from a bolt width in metres — and the user
 * counted the mismatch: "It didn't align with the number of mounting points we
 * do have on the cross beams." Same shape as the lantern socket and the
 * lantern post (999071d), two literals for one joint.
 *
 * The span is inset from the leeches because the outermost roband is passed
 * inboard of the yardarm, not off the end of it.
 */
export const SAIL_LACE_MARGIN = 0.06; // u of the first station
export const SAIL_LACE_SPAN = 0.88; // u covered by the lashings

/** the u of lashing `i` of `count` — the ONLY definition of these stations */
export function sailLaceStation(i: number, count: number): number {
  const n = Math.max(2, Math.round(finite(count, 2)));
  const k = clamp(finite(i), 0, n - 1);
  return SAIL_LACE_MARGIN + (SAIL_LACE_SPAN * k) / (n - 1);
}

/**
 * The cloth's seam coordinate: INTEGER exactly on each lashing station, so
 * `fract()` of it is the distance across one cloth and every seam line the
 * shader draws sits on a roband the yard actually carries.
 */
export function sailPanelCoord(u: number, count: number): number {
  const n = Math.max(2, Math.round(finite(count, 2)));
  return ((clamp01(finite(u)) - SAIL_LACE_MARGIN) / SAIL_LACE_SPAN) * (n - 1);
}

/** segments across the cloth needed to resolve the quilting between lashings */
export function sailClothSegments(count: number): number {
  const n = Math.max(2, Math.round(finite(count, 2)));
  const cloths = Math.ceil((n - 1) / SAIL_LACE_SPAN);
  return Math.max(16, cloths * SAIL_SAMPLES_PER_PANEL);
}

/**
 * Where a point of cloth sits between its two seams, −0.5 … +0.5, ZERO MEAN.
 *
 * A seam is doubled, stitched, stiffer canvas: it holds while the cloth either
 * side blows out, so the panel bellies between its seams and the sail reads as
 * quilted rather than smooth. −0.5 exactly on a seam (an integer panel
 * coordinate, i.e. a lashing station), +0.5 at a cloth's centre. Zero mean
 * because this REDISTRIBUTES camber, it does not add any.
 */
export function seamQuiltProfile(panelCoord: number): number {
  const s = Math.sin(Math.PI * finite(panelCoord));
  return s * s - 0.5;
}

export function sailBellyProfile(v: number): number {
  const vv = clamp01(finite(v));
  // THIS FILE IS PLAIN CPU ARITHMETIC — the mirror the
  // rope anchors resolve through. There is no fragment and no pixel here, so
  // there is no footprint to measure against. Its shader twin lives in
  // sailClothNodes.ts and is band-limited by the MESH; see the marker there.
  // @band-limited-elsewhere
  const headTaper = smoothstep(0, SAIL_BELLY_HEAD, 1 - vv);
  const footEase = SAIL_FOOT_FILL + (1 - SAIL_FOOT_FILL) * smoothstep(0, SAIL_BELLY_FOOT, vv);
  return headTaper * footEase;
}

/**
 * Warp lead that puts the section's deepest point at `draftPos`.
 *
 * The section itself is symmetric, so the draft is moved by warping u through
 * `u + lead·sin(πu)` — endpoints fixed (the leeches stay pinned), smooth, and
 * monotone as long as |lead|·π < 1. That last part is not cosmetic: a warp
 * that folds maps two points of cloth onto one, which is a self-intersecting
 * sail. Hence SAIL_LEAD_MAX, and the draft band it corresponds to.
 */
export function sailDraftLead(draftPos: number): number {
  const d = clamp(finite(draftPos, 0.4), SAIL_DRAFT_MIN, SAIL_DRAFT_MAX);
  const lead = (0.5 - d) / Math.max(1e-3, Math.sin(Math.PI * d)); // §V28 floored
  return clamp(lead, -SAIL_LEAD_MAX, SAIL_LEAD_MAX);
}

/**
 * Section depth as a fraction of the draft, across the cloth from the port
 * leech (u = 0) to the starboard one (u = 1). Exported so the DISTRIBUTION can
 * be asserted directly — a re-centred or re-narrowed bulge is a shape bug that
 * no displacement-magnitude test can see.
 */
export function sailDraftProfile(u: number, lead: number, fullness: number): number {
  const uu = clamp01(finite(u));
  const w = clamp01(uu + finite(lead) * Math.sin(Math.PI * uu));
  // membrane under uniform pressure, both edges held
  const arc = Math.max(0, 4 * w * (1 - w));
  return Math.pow(arc, Math.max(0.5, finite(fullness, 1)));
}

export function finite(x: number, fallback = 0): number {
  return Number.isFinite(x) ? x : fallback;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// @band-limited-elsewhere: the DEFINITION of the CPU helper, not a use of it.
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / Math.max(1e-6, e1 - e0));
  return t * t * (3 - 2 * t);
}
