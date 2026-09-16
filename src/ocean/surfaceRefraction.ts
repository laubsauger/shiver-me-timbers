import { float, smoothstep, vec2, vec3, vec4 } from 'three/tsl';

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

/**
 * B122 — THE SEA MUST STOP SHOWING THE FLOOR BEFORE THE WORLD STOPS DRAWING ONE.
 *
 * THE DEFECT: two hard-edged rectangles on the water, sized like an island's terrain square, one per island
 * (`browser-sync/t174-shadow*-overhead-900m.jpg`, §B122). They are the island's SHELF APRON — the square plate of
 * drawn seabed `islandMesh.buildIslandGeometry` continues out to ±(R + `seabedShelfWidth`), which is the whole of
 * the seabed that anything ever draws. Past that square there is no floor at all, so `refractionDepthNode.visible`
 * flips false and `seeThrough` drops to zero IN ONE PIXEL. What it drops FROM is not small: the apron's outer ring
 * is at `seabedOpenDepth` = 45 m, and Beer–Lambert on the shipped extinction still passes exp(−0.03·45) ≈ 0.26 of
 * the blue there. So the sea steps from a quarter of a lit sand floor to none of it, along four straight lines.
 * The depth FIELD is smooth across that boundary (`seabed.sampleSeabedHeight` reports −45 m on both sides, and the
 * apron's last ring sits exactly on it) — it is only the DRAWING that stops, which is why every CPU probe of the
 * bug came back clean.
 *
 * WHY NOT WIDEN THE SHELF. The step is set by the DEPTH the plate ends at, not by how far out it goes: at a constant
 * 45 m the water transmits the same 26 % however wide the apron is. Widening moves the rectangle; it does not close
 * it.
 *
 * THE RULE INSTEAD, and it is an identity, not a fade-to-taste: the water's body colour is the sea over the
 * open-ocean floor, so a floor AT `seabedOpenDepth` must already be inside it. Transmission is therefore taken to
 * zero by that depth, over the band between the two depths the sea already owns — `shallowFullDepth` (where the
 * shallow tint has completely given way to the body colour) and the field's own open depth. At the apron's rim the
 * two sides of the boundary are then BOTH zero, by construction rather than by agreement, and the shallows keep the
 * floor they always had.
 *
 * `thickness` is the water column along the VIEW RAY (the same quantity Beer–Lambert is fed), so a grazing view
 * loses the floor sooner — which is what a grazing view does anyway.
 */
export function seabedFloorFade(thickness: number, shallowFull: number, openDepth: number): number {
  const end = Math.max(openDepth, 1e-3);
  // §V28, and NOT a clamp to `end - ε`: a world whose shallow tint runs deeper than its floor ever gets would
  // then fade over nothing, i.e. STEP at the open depth — the very edge this exists to remove. Degenerate inputs
  // fall back to the widest possible band instead, which is the only answer that cannot draw a line.
  const start = shallowFull > 0 && shallowFull < end ? shallowFull : 0;
  const t = Math.min(Math.max((thickness - start) / (end - start), 0), 1);
  return 1 - t * t * (3 - 2 * t);
}

/** TSL twin of {@link seabedFloorFade} (§V23: functional smoothstep, e0 > e1 reads "1 at/below e1, 0 at/above e0") */
export function seabedFloorFadeNode(thickness: Node, shallowFull: Node, openDepth: Node): Node {
  const end = float(openDepth).max(1e-3);
  const full = float(shallowFull);
  const start = full.greaterThan(0).and(full.lessThan(end)).select(full, float(0));
  // @band-limited-elsewhere: a ramp on a water-column DEPTH in metres — no spatial period, so no sub-pixel regime,
  // and its two edges are tens of metres of water apart (18 → 45 m shipped), wider than any pixel footprint here.
  return smoothstep(end, start, thickness);
}
