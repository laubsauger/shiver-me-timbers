/**
 * Intersection mask node factories (§V10 depth-compare, docs/handoff.md §4).
 * Pure node-graph factories — all inputs are injected nodes, so the ocean
 * material (main thread) owns the actual depth/uniform wiring.
 *
 * 1) SCREEN-SPACE variant — inside the WATER material's fragment stage:
 *    compares the scene depth BEHIND the water fragment against the water
 *    fragment's own view depth; |Δ| < threshold → 1 (feathered). Requires
 *    the water to be rendered where the scene depth texture excludes the
 *    water itself (transparent pass reads the opaque prepass depth).
 *
 *    // in src/ocean/surfaceMaterial.ts:
 *    import {
 *      cameraNear, cameraFar, perspectiveDepthToViewZ,
 *      positionView, uniform, viewportDepthTexture,
 *    } from 'three/tsl';
 *    import { intersectionMaskNode } from '../flowfoam/intersectionMask';
 *    import { flowFoamParams as fp } from '../params/flowfoam';
 *
 *    const uThreshold = uniform(fp.depthThreshold); // push in updateFromParams
 *    const uFeather = uniform(fp.maskFeather);
 *    const sceneViewZ = perspectiveDepthToViewZ(
 *      viewportDepthTexture(), cameraNear, cameraFar);
 *    const mask = intersectionMaskNode({
 *      sceneViewZNode: sceneViewZ,       // view z of opaque geo behind fragment
 *      waterViewZNode: positionView.z,   // water fragment's own view z
 *      thresholdNode: uThreshold,
 *      featherNode: uFeather,
 *    });
 *    // mask → whiten colorNode at the waterline and/or feed extra injection.
 *
 * 2) WORLD-SPACE fallback — used by the accumulation ortho capture
 *    (accumulation.ts): foam-target meshes are rendered top-down and the
 *    mask is a feathered band around the waterline,
 *    |mesh world height − water height| < threshold.
 */
import { smoothstep } from 'three/tsl';

export interface IntersectionMaskInputs {
  /** linear view z of the opaque scene behind the fragment (negative in front of camera) */
  sceneViewZNode: any;
  /** the water fragment's own linear view z (same sign convention) */
  waterViewZNode: any;
  /** world-units distance below which surfaces count as intersecting */
  thresholdNode: any;
  /** fraction of threshold over which the mask feathers 1→0, (0..1] */
  featherNode: any;
}

/**
 * Feathered proximity mask from an absolute delta:
 * 1 while |Δ| ≤ threshold·(1−feather), smoothstep down to 0 at threshold.
 * §V23: functional smoothstep(e0, e1, x); chained .oneMinus() is unary.
 */
function maskFromDelta(delta: any, thresholdNode: any, featherNode: any): any {
  const inner = thresholdNode.mul(featherNode.oneMinus());
  return smoothstep(inner, thresholdNode, delta).oneMinus();
}

/** screen-space depth-compare mask for the water material (wiring above) */
export function intersectionMaskNode(i: IntersectionMaskInputs): any {
  const delta = i.sceneViewZNode.sub(i.waterViewZNode).abs();
  return maskFromDelta(delta, i.thresholdNode, i.featherNode);
}

export interface WorldMaskInputs {
  /** world-space height of the rendered surface (e.g. positionWorld.y) */
  heightNode: any;
  /** water surface height at the region (uniform) */
  waterHeightNode: any;
  thresholdNode: any;
  featherNode: any;
}

/** world-space waterline-band mask for the top-down injection capture */
export function worldIntersectionMaskNode(i: WorldMaskInputs): any {
  const delta = i.heightNode.sub(i.waterHeightNode).abs();
  return maskFromDelta(delta, i.thresholdNode, i.featherNode);
}
