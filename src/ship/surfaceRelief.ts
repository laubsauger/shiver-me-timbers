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
  const dHdx = height.dFdx().mul(scale);
  const dHdy = height.dFdy().mul(scale);

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
