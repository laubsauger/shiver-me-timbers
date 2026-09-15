import { float, vec2, vec3, vec4 } from 'three/tsl';

// Structural TSL node type, matching the ocean's other shader helpers.
type Node = any;

/**
 * B125: WHERE THE TRANSMITTED RAY ACTUALLY GOES. The see-through lookup read the scene along the STRAIGHT view ray.
 * At a low lens that ray runs nearly flat under the surface, so the image of a submerged hull, and of the outboard
 * legs a metre down, hung under the boat at its above-water size, in the very spot her reflection occupies: it read
 * as a mirror that showed her underside (the "hovercraft" frames). Air to water bends the ray toward the normal
 * (θt ≤ 48.6°), so everything under the surface appears squashed up toward the waterline (apparent depth).
 *
 * One secant step: walk the refracted ray, through the flat mean-surface normal, as far as the straight ray travelled
 * behind the surface (`pathLen`), and look up the scene at that point's screen position. A straight-down view is the
 * identity; a grazing one lands deep and near, which is where the refracted ray really goes. Wave tilt is left to
 * `refractionOffsetNode`. `eyeToSurface` is unit length and points down (eye above the water).
 */
export function snellLookupPoint(
  surface: { x: number; y: number; z: number },
  eyeToSurface: { x: number; y: number; z: number },
  pathLen: number,
  ior: number,
): { x: number; y: number; z: number } {
  const eta = 1 / ior;
  const ty = -Math.sqrt(Math.max(0, 1 - eta * eta * (1 - eyeToSurface.y * eyeToSurface.y)));
  return {
    x: surface.x + eyeToSurface.x * eta * pathLen,
    y: surface.y + ty * pathLen,
    z: surface.z + eyeToSurface.z * eta * pathLen,
  };
}

/** TSL twin of {@link snellLookupPoint} (air → water through the flat normal; the xz part scales by 1/n) */
export function snellLookupPointNode(surface: Node, eyeToSurface: Node, pathLen: Node, ior: number): Node {
  const eta = 1 / ior;
  const ty = float(1).sub(float(1).sub(eyeToSurface.y.mul(eyeToSurface.y)).mul(eta * eta)).max(0).sqrt().negate();
  return surface.add(vec3(eyeToSurface.x.mul(eta), ty, eyeToSurface.z.mul(eta)).mul(pathLen));
}

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
