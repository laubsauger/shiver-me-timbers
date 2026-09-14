import { vec2, vec4 } from 'three/tsl';

// Structural TSL node type, matching the ocean's other shader helpers.
type Node = any;

/**
 * Perturb the refraction lookup in camera coordinates. Strength is measured
 * as a fraction of viewport height, so resizing cannot stretch the distortion.
 * The flat-water normal contributes no perturbation. Refraction bends away
 * from a surface-normal tilt; screen UV has its origin at the top left.
 */
export function refractionOffsetNode(
  normalWorld: Node, viewMatrix: Node, viewport: Node, strength: Node,
): Node {
  const tilt = viewMatrix.mul(vec4(normalWorld.x, 0, normalWorld.z, 0));
  return vec2(tilt.x.negate().mul(viewport.y.div(viewport.x)), tilt.y).mul(strength);
}

/**
 * Color and optical path must come from the same lookup. When the bent ray
 * hits foreground geometry, the existing straight-UV selection must also
 * select straight depth; otherwise the submerged hull becomes opaque there.
 * Cleared background is not submerged geometry.
 */
export function refractionDepthNode(straight: Node, bent: Node, water: Node) {
  const behind = (depth: Node): Node => depth.greaterThan(water.add(1e-5)).and(depth.lessThan(1));
  const useBent = behind(bent);
  const depth = useBent.select(bent, straight);
  return { useBent, depth, visible: behind(depth) };
}
