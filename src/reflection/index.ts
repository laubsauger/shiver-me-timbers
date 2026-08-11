/**
 * Planar water reflections (T30, §V26) — integration surface.
 *
 * DEFAULT STATE: `reflectionParams.live` ships at 0 — the mirror pass is
 * BUILT and wired but does not run until the panel (or the graphics quality
 * setting) turns it on. See the comment on that param for the §V17 numbers
 * behind the decision; §V26 still requires this to end up on for the final
 * look. Wiring it in costs nothing while `live` is 0, so wire it now.
 *
 * ── OCEAN MATERIAL (src/ocean/surfaceMaterial.ts) — ALREADY LANDED
 * The reflection replaces the CONTENT of the reflected colour, never its
 * weight — the ocean keeps `fresnel × reflectionStrength` (0.13), so §V20's
 * painted-water bar cannot be broken by turning this on. The hook is a `? :`
 * on the optional `reflection` argument, so it is a no-op until main.ts
 * passes one in. No new uniforms and no `updateFromParams` entries on the
 * ocean side — this module owns its uniforms and pushes them itself.
 *
 * ── MAIN THREAD (src/main.ts) — exact sequence
 *
 * ① after `createClouds(...)` and `sky`, BEFORE `new OceanSurface(...)`
 *   (the material needs the handle at build time):
 *
 *     import { createPlanarReflection } from './reflection';
 *
 *     const reflection = createPlanarReflection({
 *       sunLight: sky.sunLight,   // pins the shadow camera mask, see LAYERS
 *       planeY: 0,                // the ocean's rest plane
 *       clouds: { blurred: clouds.blurredTexture, seed: state.seed },
 *     });
 *
 * ② pass it to the surface (replacing the existing options object):
 *
 *     const surface = new OceanSurface(ocean, foam, flowFoam, {
 *       sunLight: sky.sunLight,
 *       reflection,
 *     });
 *
 * ③ once, after the scene objects exist — order within the group does not
 *   matter, but all of it must happen before the first render:
 *
 *     reflection?.attachTo(app.scene);          // adds the cloud stand-in
 *
 *     // REQUIRED (§V11): the composite quad is pinned to the MAIN camera and
 *     // samples through screenUV. From the mirror camera it smears garbage
 *     // across the whole reflection. This is the one exclusion that is not
 *     // an optimisation.
 *     reflection?.excludeFromReflection(clouds.compositeQuad);
 *
 *     // cost control (§V17): fill-rate spenders that add nothing to a
 *     // reflection at this distance
 *     reflection?.excludeFromReflection(spray.mesh);
 *     reflection?.excludeFromReflection(bowSpray.mesh);
 *     reflection?.excludeFromReflection(ropes.mesh);
 *     reflection?.excludeFromReflection(blocks.mesh);
 *
 * ④ per frame, in the render callback — AFTER `followCam.update(...)` (the
 *   camera pose must be final) and BEFORE `surface.update(...)` /
 *   `post.render()`. The mirror pass itself runs later, inside the main
 *   render, at the moment the ocean material draws; this call only publishes
 *   the pose, the layer masks and the live params it will use:
 *
 *     reflection?.update(app.camera, state.time);
 *
 * ⑤ optional: expose `reflectionParams.live` in the graphics quality
 *   settings. 0 skips the entire second scene render, 1 restores it, live,
 *   with no rebuild.
 *
 * The ocean does NOT need excluding — three hides the reflector's own
 * material for the duration of the mirror pass, and the sea is a single mesh
 * with a single material, so the whole clipmap vanishes together. Excluding
 * it by layer as well would be harmless but redundant.
 *
 * The ISLANDS deliberately stay in the mirror pass: §V26 names them, and they
 * are the payoff shot. They are also the main reason the cost will grow.
 *
 * `excludeFromReflection` / `reflectionOnly` only move an object off layer 0;
 * every other layer bit survives (flowfoam tags hull meshes on layer 27).
 *
 * Omitting the `clouds` option is safe: everything else still works and the
 * reflection shows the sky gradient (scene.backgroundNode is camera-anchored,
 * §V32, so the mirror camera gets it for free), the ship and the islands —
 * just no clouds, which §V26 asks for by name.
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
