/**
 * Ocean surface TSL material (§V.4, §V.5, §V.20).
 * - vertex: sums 3 cascade displacements (distance-faded, §V.19)
 * - fragment: slope-corrected normals from derivative textures,
 *   stylized SSS on wave sides (§V.5: choppy mask × dot(L,V)),
 *   analytic sky reflection, sun sparkle glints,
 *   temporary direct-jacobian crest foam (replaced by T5 blur).
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  cameraPosition,
  color,
  float,
  linearDepth,
  mix,
  normalize,
  positionLocal,
  pow,
  reflect,
  screenUV,
  smoothstep,
  texture,
  transformNormalToView,
  uniform,
  vec2,
  vec3,
  viewportDepthTexture,
  viewportLinearDepth,
  viewportSharedTexture,
} from 'three/tsl';
import type { OceanSimulation } from './oceanCascades';
import type { FoamSim } from '../foam';
import { foamTintNode } from '../foam';
import { oceanSurfaceParams as sp } from '../params/oceanSurface';
import { oceanParams } from '../params/ocean';

export interface OceanSurfaceMaterial {
  material: THREE.MeshStandardNodeMaterial;
  /** world-space XZ of the mesh origin — set on camera snap */
  originUniform: { value: THREE.Vector2 };
  sunDirectionUniform: { value: THREE.Vector3 };
  timeUniform: { value: number };
  /** push live param values into uniforms (call per frame) */
  updateFromParams(): void;
}

export function buildOceanSurfaceMaterial(
  sim: OceanSimulation,
  foam?: FoamSim,
): OceanSurfaceMaterial {
  const originUniform = uniform(new THREE.Vector2());
  const sunDirectionUniform = uniform(new THREE.Vector3(0.5, 0.6, 0.2).normalize());
  const timeUniform = uniform(0);

  const uDeep = uniform(color(sp.deepColor));
  const uShallow = uniform(color(sp.shallowColor));
  const uSss = uniform(color(sp.sssColor));
  const uHorizon = uniform(color(sp.skyHorizonColor));
  const uZenith = uniform(color(sp.skyZenithColor));
  const uFoam = uniform(color(sp.foamColor));
  const uSssStrength = uniform(sp.sssStrength);
  const uSssPower = uniform(sp.sssPower);
  const uSssChoppy = uniform(sp.sssChoppyScale);
  const uRoughness = uniform(sp.roughness);
  const uSparkleStrength = uniform(sp.sparkleStrength);
  const uSparkleScale = uniform(sp.sparkleScale);
  const uFoamThreshold = uniform(sp.foamThreshold);
  const uDispFade = uniform(new THREE.Vector2(sp.displacementFadeStart, sp.displacementFadeEnd));
  const uNormFade = uniform(new THREE.Vector2(sp.normalFadeStart, sp.normalFadeEnd));
  const uAbsorption = uniform(sp.absorptionDensity);
  const uRefractStrength = uniform(sp.refractionStrength);
  const uRefractTint = uniform(color(sp.refractionTint));
  const uCameraFar = uniform(5000); // synced in update()

  const worldXZ = positionLocal.xz.add(originUniform);

  const camDist = worldXZ.sub(cameraPosition.xz).length();
  const dispFade = smoothstep(uDispFade.y, uDispFade.x, camDist);
  const normFade = smoothstep(uNormFade.y, uNormFade.x, camDist);

  // vertex displacement: Σ cascades (λDx, h, λDz, J)
  const sampleDisp = (i: number) =>
    texture(sim.cascades[i].displacement, worldXZ.div(sim.cascades[i].domain).fract());
  const d0 = sampleDisp(0);
  const d1 = sampleDisp(1);
  const d2 = sampleDisp(2);
  const totalDisp = d0.xyz.add(d1.xyz).add(d2.xyz).mul(dispFade);
  const jacobian = d0.w.add(d1.w).add(d2.w).sub(2); // 3 cascades each ≈1 at rest

  const positionNode = positionLocal.add(totalDisp);

  // fragment normal from Σ derivatives: (∂h/∂x, ∂h/∂z, ∂Dx/∂x, ∂Dz/∂z).
  // Per-cascade distance fade: fine cascades die early or their high-freq
  // slopes alias into white sizzle at grazing angles (user-reported).
  const sampleDeriv = (i: number) =>
    texture(sim.cascades[i].derivatives, worldXZ.div(sim.cascades[i].domain).fract());
  const fade2 = smoothstep(180, 45, camDist); // 15m ripple cascade
  const fade1 = smoothstep(700, 160, camDist); // 60m cascade
  const der = sampleDeriv(0)
    .add(sampleDeriv(1).mul(fade1))
    .add(sampleDeriv(2).mul(fade2))
    .mul(normFade);
  const lambda = float(oceanParams.choppiness);
  const denomX = float(1).add(der.z.mul(lambda)).max(0.05);
  const denomZ = float(1).add(der.w.mul(lambda)).max(0.05);
  const slopeX = der.x.div(denomX);
  const slopeZ = der.y.div(denomZ);
  const normalWorld = normalize(vec3(slopeX.negate(), 1, slopeZ.negate()));
  const normalNode = transformNormalToView(normalWorld);

  const colorNode = Fn(() => {
    const viewDir = normalize(cameraPosition.sub(vec3(worldXZ.x, totalDisp.y, worldXZ.y)));
    const fresnel = pow(float(1).sub(viewDir.dot(normalWorld).max(0)), 5).clamp(0, 1);

    // base water: deep → shallow by wave height
    const heightMask = smoothstep(-1.2, 1.6, totalDisp.y);
    const waterCol = mix(uDeep, uShallow, heightMask).toVar();

    // §V.24 transparency: refract the scene behind the surface, absorb by
    // water thickness along the view ray (turquoise → deep teal).
    const refractedUV = screenUV.add(
      vec2(normalWorld.x, normalWorld.z).mul(uRefractStrength),
    );
    // linearDepth() is normalized 0..1 over the camera range — scale by
    // far to get METERS or absorption density is meaningless (§B.3)
    const sceneDepthBehind = linearDepth(viewportDepthTexture(refractedUV));
    const ownDepth = viewportLinearDepth;
    const thicknessMeters = sceneDepthBehind.sub(ownDepth).max(0).mul(uCameraFar);
    // nothing meaningfully close behind → fully water-colored (also guards
    // refraction pulling foreground pixels: fall back to straight UV)
    const validRefraction = sceneDepthBehind.greaterThan(ownDepth.add(1e-5));
    const seeThrough = thicknessMeters
      .mul(uAbsorption)
      .negate()
      .exp()
      .mul(validRefraction.select(float(1), float(0)));
    const sceneCol = viewportSharedTexture(
      validRefraction.select(refractedUV, screenUV),
    ).rgb;
    waterCol.assign(
      mix(waterCol, sceneCol.mul(uRefractTint), seeThrough.mul(0.9)),
    );

    // §V.5 SSS fake: choppy horizontal offset isolates wave sides;
    // boost where the camera looks toward the sun through the crest.
    const choppyMask = totalDisp.xz.length().mul(uSssChoppy).clamp(0, 1);
    const backlight = viewDir.negate().dot(sunDirectionUniform).max(0);
    const sss = pow(backlight, uSssPower)
      .mul(choppyMask)
      .mul(heightMask)
      .mul(uSssStrength);
    waterCol.assign(waterCol.add(uSss.mul(sss)));

    // analytic sky reflection
    const refl = reflect(viewDir.negate(), normalWorld);
    const skyCol = mix(uHorizon, uZenith, refl.y.clamp(0, 1).pow(0.6));
    const col = mix(waterCol, skyCol, fresnel.mul(0.65)).toVar();

    // sparkle glints: thresholded hash on world XZ, gated by spec direction
    const cell = worldXZ.mul(uSparkleScale).floor();
    const sparkleHash = cell.dot(vec2(127.1, 311.7)).sin().mul(43758.5453).fract();
    const halfVec = normalize(viewDir.add(sunDirectionUniform));
    const specGate = pow(normalWorld.dot(halfVec).max(0), 64);
    // x.step(edge) = step(edge, x) = 1 when x ≥ edge → keep top 12% of cells
    const twinkle = sparkleHash.add(timeUniform.mul(0.7)).fract().step(0.88);
    const sparkle = specGate.mul(twinkle).mul(uSparkleStrength).mul(normFade);
    col.assign(col.add(vec3(1.0, 0.97, 0.88).mul(sparkle)));

    // §V.6 foam: progressive-blur sim mask (T5) with crest→soft detail
    // blend; falls back to raw jacobian threshold when no sim is wired.
    if (foam) {
      const foamMask = foam.shadingNode(worldXZ);
      const foamCol = uFoam.mul(foamTintNode());
      col.assign(mix(col, foamCol, foamMask.clamp(0, 1).mul(0.9)));
    } else {
      const foamMask = smoothstep(uFoamThreshold, uFoamThreshold.sub(0.35), jacobian);
      col.assign(mix(col, uFoam, foamMask.mul(0.85)));
    }
    return col;
  })();

  const material = new THREE.MeshStandardNodeMaterial({ roughness: sp.roughness, metalness: 0 });
  material.positionNode = positionNode;
  material.normalNode = normalNode;
  material.colorNode = colorNode;
  material.roughnessNode = uRoughness;
  // §V.24: transparent flag routes the mesh into the transparent pass where
  // viewportSharedTexture/viewportDepthTexture hold the opaque scene behind.
  // depthWrite OFF so the captured depth never contains the water itself.
  material.transparent = true;
  material.depthWrite = false;

  const updateFromParams = () => {
    (uDeep.value as THREE.Color).set(sp.deepColor);
    (uShallow.value as THREE.Color).set(sp.shallowColor);
    (uSss.value as THREE.Color).set(sp.sssColor);
    (uHorizon.value as THREE.Color).set(sp.skyHorizonColor);
    (uZenith.value as THREE.Color).set(sp.skyZenithColor);
    (uFoam.value as THREE.Color).set(sp.foamColor);
    uSssStrength.value = sp.sssStrength;
    uSssPower.value = sp.sssPower;
    uSssChoppy.value = sp.sssChoppyScale;
    uRoughness.value = sp.roughness;
    uSparkleStrength.value = sp.sparkleStrength;
    uSparkleScale.value = sp.sparkleScale;
    uFoamThreshold.value = sp.foamThreshold;
    (uDispFade.value as THREE.Vector2).set(sp.displacementFadeStart, sp.displacementFadeEnd);
    (uNormFade.value as THREE.Vector2).set(sp.normalFadeStart, sp.normalFadeEnd);
    uAbsorption.value = sp.absorptionDensity;
    uRefractStrength.value = sp.refractionStrength;
    (uRefractTint.value as THREE.Color).set(sp.refractionTint);
  };

  return {
    material,
    originUniform: originUniform as unknown as { value: THREE.Vector2 },
    sunDirectionUniform: sunDirectionUniform as unknown as { value: THREE.Vector3 },
    timeUniform: timeUniform as unknown as { value: number },
    updateFromParams,
  };
}
