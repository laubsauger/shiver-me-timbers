/**
 * Procedural relief: turn a height FIELD into a shading normal, with no
 * texture fetches at all (§C "procedural where possible", §V17 budget).
 *
 * three's `bumpMap()` cannot do this. It re-samples its texture at UV+dFdx(UV)
 * to difference the height, so handing it a procedural node evaluates the
 * SAME value three times, yields a zero gradient, and silently produces no
 * relief — a §B-class silent no-op. Here the gradient comes from screen-space
 * derivatives of the height itself, which is both cheaper (one evaluation)
 * and exact.
 *
 * Method: Mikkelsen, "Bump Mapping Unparametrized Surfaces on the GPU" —
 * build the surface gradient from dH/dx, dH/dy and the screen-space
 * derivatives of view position, then subtract it from the interpolated
 * normal. Works on any geometry with no UVs and no tangents, which is what
 * the lofted hull needs.
 *
 * §V28: the determinant is floored before it divides anything, so a
 * degenerate quad cannot produce a NaN normal.
 */
import { cross, faceDirection, normalView, positionView } from 'three/tsl';

/** any TSL float/vec node — the relief math is structural, not typed */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

/**
 * @param height procedural height in METRES (any float node)
 * @param scale  relief strength multiplier (uniform)
 * @returns a view-space normal, ready for `material.normalNode`
 */
export function reliefNormal(height: Node, scale: Node): Node {
  return reliefNormalFromScreenGradient(height.dFdx().mul(scale), height.dFdy().mul(scale));
}

/**
 * The same Mikkelsen surface gradient, but taking dH/dx and dH/dy DIRECTLY
 * instead of finite-differencing a height node. {@link reliefNormal} is now a
 * one-line wrapper over this, so the ship's behaviour is unchanged by
 * construction.
 *
 * WHY A CALLER WOULD WANT THIS. Finite-differencing the height is exact while
 * the feature spans several pixels and GARBAGE once it does not: at 2.5 samples
 * per period the difference lands on two arbitrary points of the same wave and
 * reports a slope that has nothing to do with either. For a feature whose
 * height is a KNOWN oscillation — `A·sin(2π·c)` — the chain rule splits that
 * apart: `dH/dscreen = 2π·A·cos(2π·c)·dc/dscreen`. The fast factor (the cosine)
 * is then evaluated ANALYTICALLY at the fragment, and the only thing left being
 * differenced is `c`, which is linear-plus-bounded in world position and
 * therefore smooth at every distance. The seabed ripples (terrain/sandMaterial)
 * are built this way; the deck is not, because its height field is a sum of
 * masks with no closed form.
 */
export function reliefNormalFromScreenGradient(dHdx: Node, dHdy: Node): Node {
  const sigmaX = positionView.dFdx();
  const sigmaY = positionView.dFdy();
  const vN = normalView;

  const r1 = cross(sigmaY, vN);
  const r2 = cross(vN, sigmaX);
  const det = sigmaX.dot(r1).mul(faceDirection);
  // §V28: |det| floored — a degenerate derivative quad would divide by zero
  // inside normalize() and paint NaN normals across the hull
  const safeDet = det.abs().max(1e-9);

  const grad = det.sign().mul(r1.mul(dHdx).add(r2.mul(dHdy)));
  return safeDet.mul(vN).sub(grad).normalize();
}
