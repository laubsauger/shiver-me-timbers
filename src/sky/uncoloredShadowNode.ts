/**
 * A `ShadowNode` that does not bind three's coloured-shadow texture (§V.40).
 *
 * WHY THIS EXISTS. `ShadowNode.setupShadow` (three r180,
 * `src/nodes/lighting/ShadowNode.js:504`) ends with:
 *
 *     let shadowColor = texture( shadowMap.texture, shadowCoord );
 *     const shadowOutput = mix( 1, shadowNode.rgb.mix( shadowColor, 1 ),
 *                               shadowIntensity.mul( shadowColor.a ) ).toVar();
 *
 * so EVERY receiver binds TWO textures for one `shadow(light)`: the depth
 * texture the PCF filter compares against, and the shadow pass's COLOUR render
 * target. That colour target only carries information when something casts a
 * COLOURED (partially transmissive) shadow. Nothing in this scene does — the
 * shadow pass override material is `colorNode = vec4(0,0,0,1)`
 * (`ShadowFilterNode.js:262`) on a target cleared to `(0,0,0,0)`
 * (`ShadowNode.js:616`), i.e. the texture is a pure "did a caster cover this
 * shadow-map texel" stencil and nothing else.
 *
 * WHAT IT COSTS TO KEEP. One sampled texture and — the part that actually
 * hurts — one SAMPLER, in the fragment stage of every material that receives
 * shadows. The ocean surface material sat at exactly 16 samplers against a
 * ceiling of 16 (Metal caps samplers per function at 16, so raising
 * `maxSamplersPerShaderStage` buys nothing on Apple silicon). That is the
 * whole §V.40 wall, and this is the cheapest metre of it to reclaim.
 *
 * WHAT CHANGES VISUALLY. Read the upstream expression with three's method
 * chaining in mind (`mixElement(t, e1, e2) => mix(e1, e2, t)`, MathNode.js:1041
 * — the RECEIVER is the factor, §V23/§B.1): `shadowNode.rgb.mix(shadowColor, 1)`
 * is `mix(shadowColor, 1, shadowNode)`, so upstream is
 *
 *     mix( 1, mix(shadowColorRGB, 1, pcf), intensity * shadowColorAlpha )
 *
 * With an uncoloured caster shadowColorRGB is 0 and the inner mix collapses to
 * `pcf`, leaving `mix(1, pcf, intensity * alpha)`. This node emits
 * `mix(1, pcf, intensity)` — the same thing wherever alpha is 1 (inside a
 * caster's silhouette) and wherever pcf is 1 (unshadowed). They differ ONLY on
 * the sub-texel ring where alpha is fractional: the outer half of the PCF
 * penumbra, which upstream multiplies away and this node keeps. At the shipped
 * rig (shadowExtent 80, shadowMapSize 2048) one shadow texel is 7.8 cm, so
 * that ring is ~8 cm of softer shadow edge — below a pixel at any normal
 * framing, and in the direction of the filter being allowed to do its job.
 *
 * WHY A FULL `setupShadow` OVERRIDE AND NOT A HOOK. The `shadowColor` texture
 * node is folded into a `.toVar()`, and `toVar()` inside a live `Fn()` stack
 * emits its assignment whether or not anything reads the result — so the
 * binding is created even if the value is discarded downstream. The only way
 * not to bind it is to never build that expression.
 *
 * NOT SUPPORTED: VSM. The variance path needs two more render targets and its
 * own blur materials, all of which live in the branch this override drops.
 * The project runs `PCFSoftShadowMap` (core/app.ts); anything else throws
 * rather than silently rendering a different shadow (§Rule 8).
 */
import * as THREE from 'three/webgpu';
import {
  float,
  lightShadowMatrix,
  mix,
  nodeObject,
  normalWorld,
  reference,
  renderGroup,
  shadowPositionWorld,
} from 'three/tsl';

/**
 * The parts of `ShadowNode` this override calls that @types/three does not
 * declare (its .d.ts stops at the constructor). Named rather than `any` so a
 * three upgrade that changes one of these signatures is a compile error here,
 * not a black screen.
 */
interface ShadowNodeInternals {
  shadow: {
    camera: THREE.Camera & { updateProjectionMatrix(): void };
    filterNode?: unknown;
    map: unknown;
  };
  light: THREE.Light;
  depthLayer: number;
  shadowMap: unknown;
  setupRenderTarget(
    shadow: unknown,
    builder: unknown,
  ): { shadowMap: { texture: THREE.Texture }; depthTexture: THREE.DepthTexture };
  setupShadowCoord(builder: unknown, shadowPosition: unknown): unknown;
  setupShadowFilter(builder: unknown, inputs: Record<string, unknown>): unknown;
  getShadowFilterFn(type: number): unknown;
}

/** `reference()`'s .d.ts omits `.setGroup`, which three's own ShadowNode uses */
type Grouped = { setGroup(group: unknown): unknown };

type ShadowBuilder = { renderer: THREE.WebGPURenderer };

const ShadowNodeClass = THREE.ShadowNode as unknown as new (
  light: THREE.Light,
  shadow?: THREE.LightShadow | null,
) => object;

class UncoloredShadowNode extends ShadowNodeClass {
  setupShadow(builder: ShadowBuilder): unknown {
    const self = this as unknown as ShadowNodeInternals;
    const { renderer } = builder;
    const { light, shadow } = self;

    if (renderer.shadowMap.type === THREE.VSMShadowMap) {
      throw new Error(
        'UncoloredShadowNode: VSM is not supported (§V.40) — the variance ' +
          "passes live in the branch this override drops. Fall back to three's " +
          'stock shadow node, and re-count the sampler budget first.',
      );
    }

    const { depthTexture, shadowMap } = self.setupRenderTarget(shadow, builder);
    shadow.camera.updateProjectionMatrix();

    const shadowIntensity = (
      reference('intensity', 'float', shadow) as unknown as Grouped
    ).setGroup(renderGroup);
    const normalBias = (
      reference('normalBias', 'float', shadow) as unknown as Grouped
    ).setGroup(renderGroup);

    const shadowPosition = lightShadowMatrix(light).mul(
      shadowPositionWorld.add(normalWorld.mul(normalBias as never)),
    );
    const shadowCoord = self.setupShadowCoord(builder, shadowPosition);

    const filterFn =
      shadow.filterNode || self.getShadowFilterFn(renderer.shadowMap.type ?? 0) || null;
    if (filterFn === null) {
      throw new Error('UncoloredShadowNode: shadow map type not supported yet.');
    }

    // identical to three's, minus the coloured-shadow texture: `shadowTexture`
    // is passed through because the base filter signature takes it, but the
    // stock PCF filters read only `depthTexture`.
    const shadowNode = self.setupShadowFilter(builder, {
      filterFn,
      shadowTexture: shadowMap.texture,
      depthTexture,
      shadowCoord,
      shadow,
      depthLayer: self.depthLayer,
    });

    // upstream: mix(1, mix(shadowColorRGB, 1, pcf), intensity * shadowColorAlpha)
    const shadowOutput = mix(
      float(1),
      shadowNode as never,
      shadowIntensity as never,
    ).toVar();

    self.shadowMap = shadowMap;
    shadow.map = shadowMap;

    return shadowOutput;
  }
}

/**
 * Build the node and publish it on `light.shadow.shadowNode` — three's own
 * extension point (`AnalyticLightNode.js:167` reads it, and this project's
 * ocean material reads it too), so every receiver in the scene shares ONE
 * shadow node and the shadow map is still rendered exactly once per frame
 * (§V17).
 */
export function installUncoloredShadow(light: THREE.DirectionalLight): void {
  const slot = light.shadow as unknown as { shadowNode?: unknown };
  slot.shadowNode = nodeObject(new UncoloredShadowNode(light) as never);
}
