/**
 * §V.48 band limiting for PROCEDURAL edges — the companion to surfaceRelief.ts.
 *
 * THE BUG THIS EXISTS TO KILL (five occurrences in this project). A procedural
 * feature — a caulking groove, a butt joint, a wale edge — is a step in the
 * height field with a finite width. `reliefNormal` differentiates that height
 * field in SCREEN SPACE. While the feature is several pixels wide the
 * derivative is the honest slope of its wall. Once the feature is narrower
 * than a pixel the sampling grid lands on a random point of the wall each
 * pixel, the derivative becomes per-pixel random, and the shading normal with
 * it: uniform white specular speckle over the entire surface (and, on the
 * masts, diffuse averaging to black).
 *
 * WHY THE PERIOD IS THE WRONG THING TO MEASURE — and why the first fix, which
 * faded on `fwidth(plankCoord)` against the PERIOD, left the hull speckling.
 * The plank period is 0.55 m and the seam inside it is 0.044 m: the seam goes
 * sub-pixel about twelve times farther out than the period does. Everything
 * between those two distances is the speckle band the user was looking at.
 * A band limit must be measured against the width of the SHARPEST FEATURE, not
 * against the repeat.
 *
 * THE FIX is what a mip chain does for a texture, done by hand for an analytic
 * edge, in two halves that are both required:
 *   1. WIDEN — the transition is never allowed to be narrower than the pixel
 *      footprint of its own coordinate, so the function stops varying faster
 *      than the sampling grid. This alone removes the aliasing.
 *   2. FADE — widening alone would smear a 4 cm groove across a whole plank at
 *      range, so the amplitude is scaled by featureWidth / effectiveWidth,
 *      which is the average the pixel should have seen. It reaches zero on its
 *      own once the repeat itself is sub-pixel, so no separate period fade is
 *      needed for edges.
 *
 * The result resolves to smooth timber at distance and shows full plank detail
 * up close, which is the requirement: the detail is wanted, the speckle is not.
 *
 * The CPU functions here and the TSL builder are a DOCUMENTED TRANSLITERATION
 * PAIR (same convention as sailShape.ts ↔ the sail TSL graph): the CPU pair is
 * what tests/shipDetail.test.ts drives to prove the contribution actually
 * decays, since a TSL node graph cannot be evaluated headless.
 */
import { float, mix, smoothstep } from 'three/tsl';

/** any TSL node — this math is structural, not typed */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNode = any;

/** floor for every divisor here (§V28) */
const EPS = 1e-6;

/**
 * Minimum width, in pixels, that a transition is allowed to occupy.
 *
 * NYQUIST, and it must be 2 rather than 1. At exactly one pixel per transition
 * two neighbouring samples still land on opposite ends of the wall, so the
 * screen-space difference `reliefNormal` takes is still the full step — the
 * speckle survives untouched. Two pixels guarantees at least one sample lands
 * partway up, which is what turns the difference back into a slope.
 */
const FILTER_PIXELS = 2;

/** the width a transition is actually drawn at, given its pixel footprint */
function effectiveWidth(featureWidth: number, filterWidth: number): number {
  return Math.max(featureWidth, filterWidth * FILTER_PIXELS, EPS);
}

/**
 * How much of an edge survives filtering, 0..1.
 * 1 while the feature is at least {@link FILTER_PIXELS} wide; falls as
 * 1/filterWidth after — which is the average a pixel that size should see.
 */
export function bandLimitEnergy(featureWidth: number, filterWidth: number): number {
  return featureWidth / effectiveWidth(featureWidth, filterWidth);
}

function smoothstep01(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / Math.max(edge1 - edge0, EPS)));
  return t * t * (3 - 2 * t);
}

/**
 * CPU mirror of {@link bandLimitedEdge}.
 *
 * @param distance    distance to the feature, in the coordinate's own units
 *                    (0 on the feature, growing away from it)
 * @param featureWidth the feature's authored width, same units
 * @param filterWidth the coordinate's screen-space footprint (fwidth), same units
 * @returns 1 away from the feature, → 0 on it, and → 1 everywhere once the
 *          feature can no longer be resolved
 */
export function bandLimitedEdgeValue(
  distance: number,
  featureWidth: number,
  filterWidth: number,
): number {
  const eff = effectiveWidth(featureWidth, filterWidth);
  return 1 - (featureWidth / eff) * (1 - smoothstep01(0, eff, distance));
}

/**
 * TSL builder. Transliteration of {@link bandLimitedEdgeValue}.
 *
 * @param distance a node giving distance to the feature in `coord`'s units
 * @param coord    the pattern coordinate itself — its screen-space derivatives
 *                 ARE the filter width. Pass the SMOOTH coordinate, never one
 *                 that already has a per-plank constant folded into it: a
 *                 per-plank step differentiates to a spike and would report a
 *                 huge filter width along every seam.
 * @param feature  authored feature width, in `coord`'s units (uniform or float)
 */
export function bandLimitedEdge(distance: AnyNode, coord: AnyNode, feature: AnyNode): AnyNode {
  const filter = coord.dFdx().abs().add(coord.dFdy().abs());
  const eff = feature.max(filter.mul(FILTER_PIXELS)).max(EPS);
  const energy = feature.div(eff);
  return mix(float(1), smoothstep(float(0), eff, distance), energy);
}

/**
 * Screen-space footprint of a coordinate, for callers that band-limit an
 * amplitude directly rather than an edge (the crowned per-board lift, the
 * per-board tone jitter, the grain ridges — smooth terms with no edge, whose
 * only failure mode is the whole REPEAT going sub-pixel).
 *
 * @returns 1 while one period spans a couple of pixels, 0 once it does not
 */
export function periodResolved(coord: AnyNode): AnyNode {
  const filter = coord.dFdx().abs().add(coord.dFdy().abs());
  return float(1).sub(smoothstep(float(0.4), float(1.1), filter));
}

/** CPU mirror of {@link periodResolved}, for tests */
export function periodResolvedValue(filterWidth: number): number {
  return 1 - smoothstep01(0.4, 1.1, filterWidth);
}
