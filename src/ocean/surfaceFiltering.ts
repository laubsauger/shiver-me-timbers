import { float, smoothstep } from 'three/tsl';

type Node = any;

/** Remaining slope variance after a [0, 1] amplitude fade of a wave band. */
export function unresolvedSlopeVarianceNode(amplitude: Node, variance: Node): Node {
  // Variance scales with amplitude squared. The resolved normal and the
  // unresolved specular distribution must partition the original variance.
  return float(1).sub(amplitude.mul(amplitude)).max(0).mul(variance);
}

/** Sky share of the water environment along a reflected ray. */
export function reflectionSkyVisibilityNode(
  rayHeight: Node,
  pixelWidth: Node,
  unresolvedVariance: Node,
): Node {
  // Reflection doubles small normal-angle changes. Include the slope spread
  // retired from the normal, or distant rough water would become a hard sky
  // mirror as its resolved derivatives disappear. The pixel width filters
  // the remaining resolved horizon crossing without adding another sample.
  const width = unresolvedVariance.max(0).sqrt().mul(2)
    .max(pixelWidth.mul(2)).max(1e-4);
  return smoothstep(width.mul(-1), width, rayHeight);
}
