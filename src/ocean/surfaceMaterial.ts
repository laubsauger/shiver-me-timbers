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
  uniform,
  vec2,
  vec3,
  viewportDepthTexture,
  viewportLinearDepth,
  viewportSharedTexture,
} from 'three/tsl';
import type { OceanSimulation } from './oceanCascades';
import type { FoamSim } from '../foam';
import { foamDetailMask, foamTintNode } from '../foam';
import type { FlowFoam } from '../flowfoam';
import { oceanSurfaceParams as sp } from '../params/oceanSurface';
import { oceanParams } from '../params/ocean';

export interface OceanSurfaceMaterial {
  material: THREE.MeshBasicNodeMaterial;
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
  flowFoam?: FlowFoam,
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
  const uSssAmbient = uniform(sp.sssAmbient);
  const uShallowMix = uniform(sp.shallowTintStrength);
  const uSssChoppy = uniform(sp.sssChoppyScale);
  const uReflStrength = uniform(sp.reflectionStrength);
  const uLightFloor = uniform(sp.lightFloor);
  const uLightGain = uniform(sp.lightGain);
  const uSunTint = uniform(color(sp.sunTint));
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

  const colorNode = Fn(() => {
    const viewDir = normalize(cameraPosition.sub(vec3(worldXZ.x, totalDisp.y, worldXZ.y)));
    const fresnel = pow(float(1).sub(viewDir.dot(normalWorld).max(0)), 5).clamp(0, 1);

    // base water: ONE deep body tone — height only lightens value subtly.
    // A height-keyed hue shift painted wandering turquoise patches on open
    // ocean (user critique); turquoise now arrives via SSS (sun-angled) or
    // the shallows hook below.
    const heightMask = smoothstep(-1.2, 1.6, totalDisp.y);
    const waterCol = uDeep.mul(mix(float(0.85), float(1.18), heightMask)).toVar();

    // shallows hook: seabed-depth tint for coasts (T20/T27 islands) — uniform
    // stays 0 on open ocean until a depth input exists
    waterCol.assign(mix(waterCol, uShallow, uShallowMix));

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

    // stylized wrap lighting (§V20): the material owns light — PBR white
    // sun+hemi washed the pigment to gray (user critique). Troughs keep
    // saturated body color via the floor; crest faces pick up warm sun.
    const ndl = normalWorld.dot(sunDirectionUniform).max(0);
    const lightWrap = uSunTint.mul(ndl.mul(uLightGain).add(uLightFloor));
    waterCol.assign(waterCol.mul(lightWrap));

    // §V.5 SSS fake: choppy horizontal offset isolates wave sides;
    // boost where the camera looks toward the sun through the crest.
    const choppyMask = totalDisp.xz.length().mul(uSssChoppy).clamp(0, 1);
    const backlight = viewDir.negate().dot(sunDirectionUniform).max(0);
    // ambient crest glow gated by a TIGHT crest band — a broad gate tinted
    // the whole surface electric cyan (over-glow bug)
    const crestMask = smoothstep(0.25, 0.95, totalDisp.y);
    const sss = pow(backlight, uSssPower)
      .mul(heightMask)
      .add(uSssAmbient.mul(crestMask))
      .mul(choppyMask)
      .mul(uSssStrength);
    waterCol.assign(waterCol.add(uSss.mul(sss)));

    // analytic sky reflection — capped so body color dominates (§V.20
    // watercolor look: references show pigment, not mirror)
    const refl = reflect(viewDir.negate(), normalWorld);
    const skyCol = mix(uHorizon, uZenith, refl.y.clamp(0, 1).pow(0.6));
    const col = mix(waterCol, skyCol, fresnel.mul(uReflStrength)).toVar();

    // sparkle glints: thresholded hash on world XZ, gated by spec direction.
    // Per-cell phase offset (2nd hash) so cells twinkle independently —
    // a shared time offset pulses the whole ocean in sync (§B.4).
    const cell = worldXZ.mul(uSparkleScale).floor();
    const sparkleHash = cell.dot(vec2(127.1, 311.7)).sin().mul(43758.5453).fract();
    const phase = cell.dot(vec2(269.5, 183.3)).sin().mul(19741.77).fract();
    const halfVec = normalize(viewDir.add(sunDirectionUniform));
    const ndoth = normalWorld.dot(halfVec).max(0);
    // glint train footprint (broad) vs sparkle brightness gate (tight):
    // reference (§V20) = dense sparkles inside the sun path, sparse outside
    const glintTrain = pow(ndoth, 48);
    const wobble = phase.mul(6.28).add(timeUniform.mul(0.9)).sin().mul(0.05);
    // density threshold: ~1% of cells outside the train, ~11% inside
    const thr = mix(float(0.99), float(0.89), glintTrain);
    const twinkle = smoothstep(thr, thr.add(0.012), sparkleHash.add(wobble));
    // straight-down views (noon sun) turn the whole field into starfield
    // noise — fade sparkles as the view leaves grazing/mid angles.
    // smoothstep args e0>e1: reads "1 below viewDir.y 0.6, 0 above 0.85"
    const grazeFade = smoothstep(0.85, 0.6, viewDir.y);
    const sparkle = twinkle
      .mul(pow(ndoth, 40))
      .mul(uSparkleStrength)
      .mul(normFade)
      .mul(grazeFade);
    col.assign(col.add(vec3(1.0, 0.95, 0.82).mul(sparkle)));

    // §V.6 foam: progressive-blur sim mask (T5) with crest→soft detail
    // blend; §V.10 wake/intersection foam (T13) combines via max — foam is
    // foam, whichever system shed it. Falls back to raw jacobian threshold
    // when no sim is wired.
    if (foam || flowFoam) {
      let foamMask: any = float(0);
      if (foam) foamMask = foam.shadingNode(worldXZ);
      if (flowFoam) {
        // wake foam runs through the same crackle/mottle detail blend but
        // slightly damped — bow/stern trails read softer than whitecaps
        const wakeMask = foamDetailMask(
          flowFoam.foamSampleNode(worldXZ).clamp(0, 1),
          worldXZ,
        );
        foamMask = foamMask.max(wakeMask.mul(0.85));
      }
      // foam sits in the same light as the water (wrap floor+gain). Scalar
      // light only — sunTint here would double the warm tint (foamTintNode
      // already warms it) and low-alpha foam went beige-brown on deep teal.
      const foamCol = uFoam
        .mul(foamTintNode())
        .mul(ndl.mul(uLightGain.mul(0.6)).add(uLightFloor.add(0.1)));
      col.assign(mix(col, foamCol, foamMask.clamp(0, 1).mul(0.9)));
    } else {
      const foamMask = smoothstep(uFoamThreshold, uFoamThreshold.sub(0.35), jacobian);
      col.assign(mix(col, uFoam, foamMask.mul(0.85)));
    }
    return col;
  })();

  // MeshBasicNodeMaterial: scene lights bypassed — colorNode owns lighting
  // (§V20 stylized pigment; PBR spec/hemi wash was the "white sheen" bug)
  const material = new THREE.MeshBasicNodeMaterial();
  material.positionNode = positionNode;
  material.colorNode = colorNode;
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
    uSssAmbient.value = sp.sssAmbient;
    uShallowMix.value = sp.shallowTintStrength;
    uSssChoppy.value = sp.sssChoppyScale;
    uLightFloor.value = sp.lightFloor;
    uLightGain.value = sp.lightGain;
    (uSunTint.value as THREE.Color).set(sp.sunTint);
    uReflStrength.value = sp.reflectionStrength;
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
