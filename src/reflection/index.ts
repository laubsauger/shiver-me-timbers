/**
 * Planar water reflections (T30, §V26) — integration surface.
 *
 * ── OCEAN MATERIAL (src/ocean/surfaceMaterial.ts, ocean agent owns the file)
 * The reflection replaces the CONTENT of the reflected colour, never its
 * weight — the ocean keeps `fresnel × reflectionStrength` (0.13), so §V20's
 * painted-water bar cannot be broken by turning this on. Three edits:
 *
 *   // 1. option in OceanSurfaceOptions / buildOceanSurfaceMaterial args
 *   import type { PlanarReflection } from '../reflection';
 *   ... reflection?: PlanarReflection | null
 *
 *   // 2. in the colorNode, replace the single line
 *   //      const col = mix(waterCol, skyReflCol, fresnel.mul(uReflStrength)).toVar();
 *   const reflCol = reflection
 *     ? reflection.shade({
 *         skyColor: skyReflCol,          // the existing analytic sky term
 *         normalWorld,                   // already computed above
 *         chop: totalDisp.xz.length(),   // horizontal displacement, metres
 *         camDist,                       // already computed above
 *       })
 *     : skyReflCol;
 *   const col = mix(waterCol, reflCol, fresnel.mul(uReflStrength)).toVar();
 *
 *   // 3. nothing else. No new uniforms, no updateFromParams entries — the
 *   //    reflection module owns its own uniforms and pushes them itself.
 *
 * ── MAIN THREAD (src/main.ts)
 *   const reflection = createPlanarReflection({
 *     sunLight: sky.sunLight,
 *     planeY: 0,
 *     clouds: { blurred: clouds.blurredTexture, seed: state.seed },  // optional
 *   });
 *   const surface = new OceanSurface(ocean, foam, flowFoam, {
 *     sunLight: sky.sunLight,
 *     reflection,
 *   });
 *   reflection?.attachTo(app.scene);
 *
 *   // cost control (§V17): keep out of the mirror pass anything that costs
 *   // fill rate and adds nothing to a reflection
 *   reflection?.excludeFromReflection(spray.mesh);
 *   reflection?.excludeFromReflection(bowSpray.mesh);
 *   reflection?.excludeFromReflection(ropes.mesh);
 *   reflection?.excludeFromReflection(blocks.mesh);
 *   reflection?.excludeFromReflection(cloudCompositeQuad);  // see note below
 *
 *   // per frame, AFTER the camera has its final pose (followCam.update) and
 *   // BEFORE surface.update()/post.render(). The mirror pass itself runs
 *   // inside the main render, when the ocean material draws; this call only
 *   // publishes the pose, the layer masks and the live params it will use.
 *   reflection?.update(app.camera, state.time);
 *
 * The ocean does NOT need excluding — three hides the reflector's own
 * material for the duration of the mirror pass, and the sea is a single mesh
 * with a single material, so the whole clipmap vanishes together. Excluding
 * it by layer as well would be harmless but redundant.
 *
 * `excludeFromReflection` / `reflectionOnly` only move an object off layer 0;
 * every other layer bit survives (flowfoam tags hull meshes on layer 27).
 *
 * ── CLOUDS (§V26 wants clouds visible in the water)
 * Needs two things this module cannot do from its own directory:
 *   a) `src/clouds/index.ts` must expose the blurred RT it already builds —
 *      add `blurredTexture: blur.output` to the returned object and to
 *      `CloudsHandle`. That is the texture `clouds` above wants.
 *   b) the main composite quad must be excluded from the mirror pass, so
 *      `createClouds` (or main.ts via a getter) has to hand out the quad for
 *      `excludeFromReflection`. Without (b) the camera-pinned quad renders
 *      from the mirror camera and smears its screenUV lookup across the
 *      reflection — see the header of cloudMirror.ts.
 * Skip the `clouds` option entirely and everything else still works; the
 * reflection then shows the sky gradient (scene.backgroundNode is
 * camera-anchored, §V32, so the mirror camera gets it for free), the ship and
 * the islands, but no clouds.
 *
 * ── LAYERS
 *   11 REFLECTION_HIDDEN_LAYER — main view only
 *   12 REFLECTION_ONLY_LAYER   — mirror pass only
 * (27 is taken by flowfoam's FOAM_INJECTION_LAYER.) `excludeFromReflection`
 * moves a subtree OFF layer 0, so the main camera's mask is widened in
 * `update()` to keep seeing it. Sun shadow casting is unaffected: the shadow
 * camera's mask is pinned at construction (see planarReflection.ts).
 */
export {
  createPlanarReflection,
  type PlanarReflection,
  type PlanarReflectionOptions,
} from './planarReflection';
export type { ReflectionShadeInput } from './reflectionShading';
export {
  REFLECTION_HIDDEN_LAYER,
  REFLECTION_ONLY_LAYER,
  clampResolutionScale,
  mirrorCameraPose,
} from './mirrorMath';
