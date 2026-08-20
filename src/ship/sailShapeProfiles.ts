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
 * {@link leechFraction} for why pinning it at every height was wrong.
 */
export const SAIL_DRAFT_MIN = 0.28; // draft cannot crowd the luff…
export const SAIL_DRAFT_MAX = 0.72; // …nor the leech
export const SAIL_LEAD_MAX = 0.3; // |lead|·π < 1 keeps the warp monotone
/**
 * VERTICAL BELLY PROFILE — see {@link sailBellyProfile}. The section's
 * REFERENCE STATION is where `sailCamberRatio` MEANS what it says: the corner
 * tension field is normalised to 1 at (0.5, SAIL_BELLY_REF), the vertical
 * strips' bow is sampled there, and the twist pivots there. The profile alone
 * peaks at the foot; the clews' grip lifts the realised peak to v ≈ 0.03 on a
 * wide sail and v ≈ 0.24 on a square one. 0.12 sits between: MEASURED peak
 * depth / `sailCamberRatio` = 0.977…0.979 over six aspects from 18×6 to
 * 12×12 (0.942…0.971 at 0.22), re-measured by tests/sailMembrane.test.ts.
 */
export const SAIL_BELLY_REF = 0.12;
export const SAIL_FLUTTER_BASE = 0.3; // shake floor before luff adds to it
export const SAIL_FLUTTER_EDGE = 1.3; // extra ripple toward the leeches
export const SAIL_FLUTTER_V = 2.1; // ripple phase advance down the cloth

/**
 * ARC-LENGTH COEFFICIENT: the EXCESS LENGTH a bowed strip carries, as a
 * multiple of the square of its camber ratio. `L = span·(1 + COEFF·(d/span)²)`.
 *
 * It owns BOTH directions of one relation and that is deliberate (§V.72's
 * shape): `arcShorten` spends it to work out how much span a strip gives up to
 * pay for its bow, and `sailCamberRatio` INVERTS it to work out how much bow a
 * given excess buys. Two constants would let the sail's depth and the sail's
 * outline disagree about the same piece of cloth.
 *
 * Without it the sail gains SURFACE AREA as the wind rises — it inflates like
 * a balloon instead of bowing like a fixed piece of canvas, and no amount of
 * depth tuning can hide that.
 *
 * 1.9, AND IT IS MEASURED, NOT DERIVED — this is the change §T.74a forced.
 * 8/3 is the exact coefficient for a PARABOLA, which is what this used to be
 * and what {@link sailDraftProfile} is on its own. The cloth is not a parabola
 * any more: the corner tension field flattens both ends of every strip, the
 * leech standoff adds a term that peaks where the membrane vanishes, and the
 * vertical profile was never one to begin with. Integrating `∫f'²/2` over the
 * realised shape family gives coefficients from 0.50 (v=0.8, where there is
 * almost no bow left) through 1.43 at the draft to 2.54 along the foot — a
 * FIVEFOLD spread that no single number fits.
 *
 * So it is fitted rather than assumed, against the only thing that matters:
 * whether the cloth keeps its length. Worst-case |L/cut − 1| over 6 horizontal
 * and 9 vertical strips × 4 fills:
 *
 *     8/3 (the parabola)          6.81%   ← and it SIGN-FLIPS: the foot GAINS
 *                                            2.95% of cloth while the draft
 *                                            loses 2.06%, which is a sail that
 *                                            stretches, not one that bows
 *     1.9 (fitted, shipped)       2.67%
 *
 * The exact quadratic solve of the same relation — `span = cut·(1 + √(1 −
 * 4·C·k²))/2`, which is what the first-order form approximates — was tried and
 * is WORSE (3.46% at its own best coefficient). Recorded because it looks like
 * the obvious upgrade: it is exact for the length model, and the length model
 * is the part that is wrong, so being exact about it buys nothing.
 *
 * WHAT THIS DOES NOT DO: 2.67% of the cloth's own length is still 2.67%. Full
 * conservation needs the strip's true arc length, which is an integral along
 * the strip and therefore a per-vertex quadrature in the vertex stage. That is
 * the next model up, not this one (§Rule 2).
 */
export const SAIL_ARC_COEFF = 1.9;

/**
 * THE SAME RELATION FOR A VERTICAL STRIP, WHICH IS A DIFFERENT CURVE.
 *
 * A horizontal strip is held at both ends and bows between them — a parabola,
 * coefficient 8/3 before the clews flatten it. A vertical strip is bent to the
 * yard at its head and FREE at its foot: it does not bow back, it swings
 * forward as `1 − v²` ({@link sailBellyProfile}), and ∫½(dz/dv)² over that
 * curve is exactly 2/3 of (d/h)². Spending the horizontal 1.9 on it shortens
 * every vertical strip ~3× too much. MEASURED on the main course at full
 * load, |L/cut − 1| per strip:
 *
 *     1.9   vertical strips at u = 0.25…0.5 read 7.2…9.1% SHORT of cut (a
 *           sign flip against the horizontal strips, which read 2-4% long),
 *           and the foot centre rises 1.17 m — 9.6% of chord
 *     2/3   worst strip anywhere 2.5% (horizontal, v = 0.15), NO strip short,
 *           foot centre rises 0.46 m — which is what the curve's own length
 *           demands: √(6.3² − 2.05²) is 0.44 m shorter than 6.3
 *
 * Derived from the profile, not fitted; the length test in
 * tests/sailMembrane.test.ts is what holds it honest.
 */
export const SAIL_ARC_COEFF_V = 2 / 3;

/** slack-canvas folds: cycles across the cloth and the phase of each.
 *  Two incommensurate wavelengths so the hang is not a regular corrugation
 *  (§V43 — a regular repeat is the "generated" tell). */
export const SAIL_FOLD_CYCLES_A = 1.5;
export const SAIL_FOLD_CYCLES_B = 3.5;
export const SAIL_FOLD_PHASE_A = 0.9;
export const SAIL_FOLD_PHASE_B = 2.3;

/** the radius, as a fraction of the sail's diagonal, over which a clew's grip
 *  stops growing — a cringle has a size, and 1/r must not run to infinity */
export const SAIL_CLEW_SOFTEN = 0.03;

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
 * Peak camber as a fraction of the CHORD. Signed: a backed sail bows the other
 * way. Bounded at source (§V44).
 *
 * §T.74a — DEPTH IS NOT AUTHORED, IT IS THE CONSEQUENCE OF EXCESS CLOTH.
 * `sailClothExcess` is how much longer the cloth is than the line between the
 * points it is set between; a strip of chord `c` bowing by `d` is
 * `c·(1 + 8/3·(d/c)²)` long ({@link SAIL_ARC_COEFF}), so inverting that gives
 * `d/c = √(3e/8)` and there is no free parameter left. The drive multiplies the
 * excess TAKEN UP, not the depth: slack cloth has not yet formed an arc, and
 * once it has, more wind buys tension rather than belly.
 *
 * The observable consequence, and the reason this is not a rename: camber goes
 * as √drive. The old law was linear, so a gale looked twice as deep as a breeze
 * however the curve upstream was shaped. Now a sail fills EARLY and then stops
 * — which is what canvas does, and is why the cap below almost never binds.
 */
export function sailCamberRatio(drive: number, p: ShipMaterialParams): number {
  const cap = Math.max(0, finite(p.sailCamberMax, 0.15));
  const d = clamp(finite(drive), -1, 1);
  /**
   * `drive` IS THE FULLNESS. sailDynamics.sailDrive maps the dynamic pressure
   * the canvas actually sees onto 0..1 with a saturating curve (~0 at 2 kn,
   * slack at 5, half at ~10, drum-tight by 20), signed for a backed sail. The
   * camber is LINEAR in it: the full excess buys `√(e/COEFF)` of camber, and a
   * half-loaded sail shows half of that. The old form took √(smoothstep(drive))
   * here on top of a front-loaded load curve, so the cloth was at 61% of full
   * camber in 2 kn of wind and a breeze and a gale were the same sail — the
   * user's "binary has-wind / has-no-wind". Linear is also C1 through zero, so
   * a sail crossing from backed to drawing moves at a bounded rate (§V.71).
   */
  // e = SAIL_ARC_COEFF·k²  ⟹  k = √(e / SAIL_ARC_COEFF). ONE inversion, and it
  // is the same coefficient `arcShorten` spends, so the two cannot drift.
  // §V28: excess ≥ 0, so the sqrt argument can never go negative.
  const full = Math.sqrt(Math.max(0, finite(p.sailClothExcess)) / SAIL_ARC_COEFF);
  return clamp(full * d, -cap, cap);
}

/**
 * HOW MUCH HARDER THE CLOTH IS PULLING AT (u, v) THAN AT THE BELLY'S OWN
 * REFERENCE STATION. ≥ 0, and exactly 1 at (0.5, SAIL_BELLY_REF) by
 * construction, for a sail of any size.
 *
 * §T.74c, and the user's words: "really shaping the bulge FROM THE CORNERS
 * where force is applied… they should only be anchored where it makes sense,
 * and in this case only at the corners with the ropes — that's where the
 * tension point should be."
 *
 * THE PHYSICS. A square sail's boundary is fixed along the head (bent to its
 * yard) and at exactly TWO POINTS, the clews. The pressure on every element of
 * cloth in the lower sail has to be carried to one of those two points, so the
 * load crossing a circle of radius r about a clew is roughly FIXED while the
 * circumference it crosses is 2πr — tension per unit length therefore grows as
 * 1/r, without bound. Cloth pulled that hard cannot bow: the membrane equation
 * ∇·(T∇w) = −p with T ∝ 1/r gives w ∝ r³ at the corner against w ∝ r² in the
 * field, so the clew sits in a flat, taut, nearly ruled triangle of canvas and
 * the belly hangs slack inboard of it.
 *
 * That is the OPPOSITE of the separable field this replaced, whose depth at a
 * clew was set by a profile that knew nothing about the pin. Measured on the
 * old shape at full drive, local slack (arc/chord − 1 over a ±0.06u window) ran
 * 0.00169 at the clew against 0.00083 in the belly — TWICE AS SLACK where it
 * should have been tautest, which is precisely why the sail read as a bulge
 * pushed into a plate.
 *
 * WHY IT IS NORMALISED AT THE REFERENCE STATION rather than at its own minimum:
 * `sailCamberRatio` is defined as the camber AT the belly's deepest point, and
 * (mid-width, SAIL_BELLY_REF) is where the realised section
 * peaks. Pinning the field to 1 there keeps camber meaning what it says on
 * every sail of every aspect, so `sailCamberMax` stays a true ceiling (§V44)
 * and the chord-relative camber law survives unchanged.
 *
 * §V66 — SCALED BY ITS OWN DIMENSION. The distances are METRES on the cut
 * panel, not (u, v): a clew's grip reaches a physical distance into the cloth,
 * so a 12 m course and a 6 m topgallant must not get the same reach in
 * normalised coordinates. That is why this needs the drop as well as the width.
 *
 * §V28 — the distance is SOFTENED (`√(r² + ε²)`), not floored with a `max`. A
 * max is C0, and the surface's normal comes from a finite difference of this
 * function across a 0.03-in-u step that straddles the kink at the clew; the
 * soft form is smooth everywhere and costs the same.
 */
export function cornerTension(
  u: number,
  v: number,
  width: number,
  drop: number,
  grip: number,
): number {
  const c = Math.max(0.01, finite(width)); // §V28
  const h = Math.max(0.01, finite(drop)); // §V28
  const diag = Math.hypot(c, h);
  const reach = Math.max(0, finite(grip)) * diag;
  // the softening length: a clew is a CRINGLE, not a mathematical point, and
  // this is the radius over which its grip stops growing. A fixed fraction of
  // the diagonal, so it rides the sail's size like everything else.
  const eps2 = (SAIL_CLEW_SOFTEN * diag) ** 2;
  const t = (uu: number, vv: number): number => {
    const rp = Math.sqrt((uu * c) ** 2 + (vv * h) ** 2 + eps2);
    const rs = Math.sqrt(((1 - uu) * c) ** 2 + (vv * h) ** 2 + eps2);
    return 1 + reach / rp + reach / rs; // divisors ≥ ε·diag > 0 by construction
  };
  return t(clamp01(finite(u)), clamp01(finite(v))) / t(0.5, SAIL_BELLY_REF);
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
export function arcShorten(camberRatio: number, coeff: number = SAIL_ARC_COEFF): number {
  const k = finite(camberRatio);
  return 1 / (1 + Math.max(0, finite(coeff, SAIL_ARC_COEFF)) * k * k);
}

/**
 * How far the free LEECH flies forward at height v, as a fraction of the
 * centre's depth at that height — the edge's own bow between the two points
 * it is actually made fast at. Zero at v = 0 (the clew, sheeted) and v = 1
 * (the yardarm), a parabola between: a free edge under uniform load, exactly
 * the shape a horizontal strip takes between the leeches.
 *
 * THE OLD MODEL PINNED BOTH LEECHES TO ZERO AT EVERY HEIGHT, on the reasoning
 * that they are "bolt-roped and sheeted". A bolt rope is sewn ALONG an edge; it
 * stiffens it, it does not attach it to anything. Pinning it is why the sail's
 * outline was a perfect rectangle in every wind.
 */
export function leechFraction(v: number): number {
  const vv = clamp01(finite(v));
  return 4 * vv * (1 - vv);
}

/**
 * THE SECTION — ONE 2D FUNCTION OF (u, v), as a fraction of the peak depth,
 * before the corner tension field divides it (§V.77: one expression, not an
 * interior term and an edge term that have to agree).
 *
 * At height v the cloth is an arc from leech to leech: the leeches themselves
 * stand `leechOpen·leechFraction(v)` of the way forward, and the interior
 * bows the rest of the way to the centre line on the membrane parabola
 * ({@link sailDraftProfile}, carrying the draft lead). The whole section is
 * then scaled by the vertical profile: flat at the yard, deepest at the foot.
 *
 *   v = 1  → 0 everywhere: the head is bent to its yard.
 *   v = 0  → a clean arc clew to clew: the foot is a FREE edge, held only at
 *            its two corners, and bows forward as one piece.
 *   0<v<1  → the leech is forward of the yard plane, the centre further.
 *
 * User: "very central bow bulge instead of the whole fabric stretching". The
 * old field was `across × down`, zero on all three free edges, so the shape
 * was a dome that died before it reached any edge.
 */
export function sailSection(
  u: number,
  v: number,
  lead: number,
  fullness: number,
  leechOpen: number,
): number {
  const across = sailDraftProfile(u, lead, fullness);
  const e = clamp01(finite(leechOpen)) * leechFraction(v);
  return sailBellyProfile(v) * (e + (1 - e) * across);
}

/**
 * How much the vertical strip at width u bows, relative to the centre strip —
 * its section at the reference height. The arc-length shrink of that strip
 * is paid against this (sailShape.sailClothPoint).
 */
export function sailStripBow(u: number, lead: number, fullness: number, leechOpen: number): number {
  const e = clamp01(finite(leechOpen)) * leechFraction(SAIL_BELLY_REF);
  return e + (1 - e) * sailDraftProfile(u, lead, fullness);
}

/**
 * SLACK CANVAS HANGS IN FOLDS, it does not lie flat. A square sail with no
 * wind in it hangs from its yard under gravity with the clews sheeted, so the
 * cloth falls in a few vertical folds that grow toward the free foot. Zero at
 * the head (laced), growing as (1 − v); a couple of low-frequency sines across
 * the cloth, and ZERO AT THE CLEWS — the sheets hold those two corners
 * whatever the wind does — via `1 − (1 − v)·(1 − midArch(u))`, which is 1
 * along the head line and at mid-foot and 0 at exactly the two clews. The
 * tension field divides it again like every other term. Scaled by
 * (1 − fullness) by the caller — the wind pulls the folds out as it fills
 * her, which is the continuous slack → full read the user asked for instead
 * of a binary has-wind / no-wind.
 */
export function slackFoldProfile(u: number, v: number): number {
  const uu = clamp01(finite(u));
  const vv = clamp01(finite(v));
  const TAU = Math.PI * 2;
  const sheeted = 1 - (1 - vv) * (1 - midArch(uu));
  return (
    (0.6 * Math.sin(TAU * SAIL_FOLD_CYCLES_A * uu + SAIL_FOLD_PHASE_A)
      + 0.4 * Math.sin(TAU * SAIL_FOLD_CYCLES_B * uu + SAIL_FOLD_PHASE_B))
    * (1 - vv)
    * sheeted
  );
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
    + finite(p.sailTwist) * finite(drive) * (vv - SAIL_BELLY_REF)
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

/**
 * VERTICAL BELLY PROFILE: 1 at the free foot, 0 at the yard, `1 − v²`.
 *
 * A square sail is bent to its yard along the head and is FREE below it: the
 * foot is held at the two clews only, and between them it is the freest cloth
 * on the sail. So the vertical section is deepest LOW — the foot bellies most
 * and the cloth comes back to the yard with curvature the whole way (constant
 * second derivative, so it never reads as a tilted plane). The previous
 * profile peaked at mid-height and came back to 55% at the foot, which put a
 * dome in the middle of the sail and left the foot nearly flat.
 *
 * The corner tension field then lifts the REALISED peak off the foot edge
 * toward SAIL_BELLY_REF, because the clews grip the cloth nearest them.
 */
export function sailBellyProfile(v: number): number {
  const vv = clamp01(finite(v));
  return 1 - vv * vv;
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
