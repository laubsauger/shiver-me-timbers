/**
 * Ocean surface TSL material (§V.4, §V.5, §V.20, §V.24, §V.30).
 * - vertex: sums 3 cascade displacements, each gated by the LOD's Nyquist
 *   limit (§V30) so detail dies where the triangles can't carry it
 * - fragment: slope-corrected normals from derivative textures,
 *   stylized SSS on wave sides (§V.5: choppy mask × dot(L,V)),
 *   sun-shadow sample folded into the wrap light, sky reflection tinted by
 *   the body colour at grazing angles, glint road + sparkle, foam,
 *   own distance haze (the water ignores scene fog), and a Snell's-window
 *   underside for the submerged camera.
 *
 * §V23 REMINDER: 3-arg math uses the FUNCTIONAL forms mix(a,b,t) /
 * smoothstep(e0,e1,x). Chained `a.mix(b,t)` reads the RECEIVER as the factor
 * (§B.1, §B.2 both cost a session). Chained `x.smoothstep(e0,e1)` is fine but
 * is not used here — every smoothstep below is functional, and the ones with
 * e0 > e1 are commented with their reading.
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  cameraPosition,
  color,
  float,
  frontFacing,
  linearDepth,
  mix,
  normalize,
  positionLocal,
  pow,
  reflect,
  screenUV,
  shadow,
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
import { solveGrowthRate, type SurfaceGridOptions } from './surfaceGeometry';

export interface OceanSurfaceMaterial {
  material: THREE.MeshBasicNodeMaterial;
  /** world-space XZ of the mesh origin — set on camera snap */
  originUniform: { value: THREE.Vector2 };
  sunDirectionUniform: { value: THREE.Vector3 };
  timeUniform: { value: number };
  /** camera far plane, in meters — B3: linearDepth() is normalized, not meters */
  cameraFarUniform: { value: number };
  /** haze target colour — copied from the scene fog so water and objects melt alike */
  hazeColorUniform: { value: THREE.Color };
  /** RMS surface elevation (m) — sea-state scale for every crest threshold */
  seaRmsUniform: { value: number };
  /** fold-capped choppiness λ — must match what the displacement was built with */
  choppinessUniform: { value: number };
  /** push live param values into uniforms (call per frame) */
  updateFromParams(): void;
}

/**
 * TSL nodes are a union of ~40 node classes that only line up structurally at
 * runtime; the codebase types local shader helpers loosely rather than
 * threading generics (same convention as flowfoam/foam).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TslNode = any;

/** 2D value noise on world meters — hash lattice + smooth interpolation. */
function valueNoise(p: TslNode): TslNode {
  const hash = (c: TslNode) =>
    c.dot(vec2(127.1, 311.7)).sin().mul(43758.5453).fract();
  const i = p.floor();
  const f = p.fract();
  // Hermite weights, written out (no smoothstep call — f is already 0..1)
  const u = f.mul(f).mul(f.mul(-2).add(3));
  const a = hash(i);
  const b = hash(i.add(vec2(1, 0)));
  const c = hash(i.add(vec2(0, 1)));
  const d = hash(i.add(vec2(1, 1)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

export function buildOceanSurfaceMaterial(
  sim: OceanSimulation,
  foam?: FoamSim,
  flowFoam?: FlowFoam,
  grid?: SurfaceGridOptions,
  sunLight?: THREE.DirectionalLight,
): OceanSurfaceMaterial {
  const originUniform = uniform(new THREE.Vector2());
  const sunDirectionUniform = uniform(new THREE.Vector3(0.5, 0.6, 0.2).normalize());
  const timeUniform = uniform(0);

  const uDeep = uniform(color(sp.deepColor));
  const uShallow = uniform(color(sp.shallowColor));
  const uVariationScale = uniform(sp.variationScale);
  const uVariationStrength = uniform(sp.variationStrength);
  const uSss = uniform(color(sp.sssColor));
  const uHorizon = uniform(color(sp.skyHorizonColor));
  const uZenith = uniform(color(sp.skyZenithColor));
  const uFoam = uniform(color(sp.foamColor));
  const uSssStrength = uniform(sp.sssStrength);
  const uSssPower = uniform(sp.sssPower);
  const uSssAmbient = uniform(sp.sssAmbient);
  const uShallowMix = uniform(sp.shallowTintStrength);
  const uSssChoppy = uniform(sp.sssChoppyScale);
  const uSssAmbientSunGate = uniform(sp.sssAmbientSunGate);
  const uCrestBand = uniform(new THREE.Vector2(sp.crestBandLow, sp.crestBandHigh));
  const uBodyBand = uniform(new THREE.Vector2(sp.bodyBandLow, sp.bodyBandHigh));
  // sea-state scale (RMS surface elevation, m) — every "is this a crest"
  // threshold is a MULTIPLE of this, never absolute metres (§B cow-pattern)
  const uSeaRms = uniform(0.7);
  // effective (fold-capped) Tessendorf λ — see OceanSimulation.effectiveChoppiness
  const uChoppiness = uniform(oceanParams.choppiness);
  const uReflStrength = uniform(sp.reflectionStrength);
  const uGrazingSat = uniform(sp.grazingSaturation);
  const uLightFloor = uniform(sp.lightFloor);
  const uLightGain = uniform(sp.lightGain);
  const uSunTint = uniform(color(sp.sunTint));
  const uShadowStrength = uniform(sp.shadowStrength);
  const uSparkleStrength = uniform(sp.sparkleStrength);
  const uSparkleScale = uniform(sp.sparkleScale);
  const uSparklePower = uniform(sp.sparklePower);
  const uGlintTrainPower = uniform(sp.glintTrainPower);
  const uSparkleDensity = uniform(
    new THREE.Vector2(sp.sparkleDensityBase, sp.sparkleDensityTrain),
  );
  const uGlintRoad = uniform(new THREE.Vector2(sp.glintRoadStrength, sp.glintRoadPower));
  const uGraze = uniform(new THREE.Vector2(sp.sparkleGrazeStart, sp.sparkleGrazeEnd));
  const uFoamThreshold = uniform(sp.foamThreshold);
  const uNormFade = uniform(new THREE.Vector2(sp.normalFadeStart, sp.normalFadeEnd));
  const uAbsorption = uniform(sp.absorptionDensity);
  const uRefractStrength = uniform(sp.refractionStrength);
  const uRefractTint = uniform(color(sp.refractionTint));
  const uCameraFar = uniform(5000); // synced from the live camera in update()
  // haze target colour: driven per frame from the scene fog / sky horizon
  // (see OceanSurface.update) — this literal is only the pre-first-frame value
  const uHazeColor = uniform(color(0xcfe6f0));
  const uHaze = uniform(new THREE.Vector2(sp.hazeStart, sp.hazeEnd));
  const uHazeCurve = uniform(sp.hazeCurve);
  const uHazeStrength = uniform(sp.hazeStrength);
  const uGlintHaze = uniform(sp.glintHazePenetration);
  const uUnderCeiling = uniform(color(sp.underCeilingColor));
  const uUnderWindow = uniform(new THREE.Vector2(sp.underWindowBrightness, sp.underWindowSoftness));
  // (coreSpacing, growth k): the clipmap's spacing law, spacing = s0 + k·dist
  const gridOpts: SurfaceGridOptions = grid ?? {
    segments: sp.gridSegments,
    coreSpacing: sp.gridCoreSpacing,
    horizonRadius: sp.gridHorizonRadius,
    rimRound: sp.gridRimRound,
  };
  const uLodLaw = uniform(
    new THREE.Vector2(gridOpts.coreSpacing, solveGrowthRate(gridOpts)),
  );
  const uLodSamples = uniform(new THREE.Vector2(sp.lodSamplesFull, sp.lodSamplesCut));
  const uNormalStretch = uniform(sp.normalDetailStretch);

  const worldXZ = positionLocal.xz.add(originUniform);
  const camDist = worldXZ.sub(cameraPosition.xz).length();

  // §V30: local vertex spacing from the clipmap law (surfaceGeometry header).
  // Everything that can alias is gated on THIS, not on hand-picked radii, so
  // the fades ride the LOD and never end in a visible ring.
  const spacing = uLodLaw.x.add(camDist.mul(uLodLaw.y));
  /**
   * Cascade weight: 1 while `domain` spans ≥ lodSamplesFull vertices, 0 once
   * it spans ≤ lodSamplesCut. smoothstep(e0,e1,x) with e0 > e1 reads as
   * "1 below e1, 0 above e0" (§V23 — functional form, receiver-free).
   */
  const lodWeight = (domain: number, stretch: TslNode) => {
    const cut = float(domain).mul(stretch).div(uLodSamples.y.max(0.5));
    const full = float(domain).mul(stretch).div(uLodSamples.x.max(0.5));
    return smoothstep(cut, full, spacing);
  };
  const one = float(1);
  const dispLod = sim.cascades.map((c) => lodWeight(c.domain, one));
  const normLod = sim.cascades.map((c) => lodWeight(c.domain, uNormalStretch));

  // vertex displacement: Σ cascades (λDx, h, λDz, J), each Nyquist-gated
  const sampleDisp = (i: number) =>
    texture(sim.cascades[i].displacement, worldXZ.div(sim.cascades[i].domain).fract());
  const d0 = sampleDisp(0);
  const d1 = sampleDisp(1);
  const d2 = sampleDisp(2);
  const totalDisp = d0.xyz
    .mul(dispLod[0])
    .add(d1.xyz.mul(dispLod[1]))
    .add(d2.xyz.mul(dispLod[2]));
  const jacobian = d0.w.add(d1.w).add(d2.w).sub(2); // 3 cascades each ≈1 at rest

  const positionNode = positionLocal.add(totalDisp);

  // fragment normal from Σ derivatives: (∂h/∂x, ∂h/∂z, ∂Dx/∂x, ∂Dz/∂z).
  // Normals are per-pixel so they outlive the geometry (normalDetailStretch),
  // then a global far fade turns the last kilometre to glass under the haze.
  const sampleDeriv = (i: number) =>
    texture(sim.cascades[i].derivatives, worldXZ.div(sim.cascades[i].domain).fract());
  // smoothstep(e0,e1,x), e0 > e1: 1 inside normalFadeStart, 0 past End
  const normFade = smoothstep(uNormFade.y, uNormFade.x, camDist);
  const der = sampleDeriv(0)
    .mul(normLod[0])
    .add(sampleDeriv(1).mul(normLod[1]))
    .add(sampleDeriv(2).mul(normLod[2]))
    .mul(normFade);
  // the SAME λ the vertex displacement was built with (anti-fold cap applied),
  // pushed per frame — a baked oceanParams.choppiness read here meant the
  // normals solved a different surface than the geometry drew whenever the
  // cap engaged or the slider moved
  const lambda = uChoppiness;
  const denomX = float(1).add(der.z.mul(lambda)).max(0.05);
  const denomZ = float(1).add(der.w.mul(lambda)).max(0.05);
  const slopeX = der.x.div(denomX);
  const slopeZ = der.y.div(denomZ);
  const normalWorld = normalize(vec3(slopeX.negate(), 1, slopeZ.negate()));

  // §V20 water shadows: MeshBasicNodeMaterial gets no lighting from the
  // renderer (PBR washed the pigment gray — that was the white-sheen bug), so
  // `mesh.receiveShadow` is inert and the sun shadow map has to be sampled
  // explicitly and folded into the wrap light.
  // shadow() returns 1 where lit, 0 in shadow, and 1 outside the shadow
  // frustum (three's own frustumTest) — so the open sea never goes black.
  // The node is published on light.shadow.shadowNode (three's documented
  // extension point, cf. CSMShadowNode): the lit ship materials then REUSE it
  // instead of building a second ShadowNode, so the scene still renders the
  // shadow map exactly once per frame (§V17 budget).
  // vec3() first: the node is vec3 for coloured shadows, float otherwise.
  let shadowMask: TslNode = float(1);
  if (sunLight) {
    const shadowSlot = sunLight.shadow as unknown as { shadowNode?: TslNode };
    const node = shadowSlot.shadowNode ?? shadow(sunLight);
    shadowSlot.shadowNode = node;
    shadowMask = vec3(node).x.clamp(0, 1);
  }

  const colorNode = Fn(() => {
    const surfacePos = vec3(worldXZ.x, totalDisp.y, worldXZ.y);
    const viewDir = normalize(cameraPosition.sub(surfacePos)); // surface → eye
    const fresnel = pow(float(1).sub(viewDir.dot(normalWorld).max(0)), 5).clamp(0, 1);
    const shade = mix(float(1), shadowMask, uShadowStrength);

    // base water: ONE deep body tone — height only lightens value subtly.
    // A height-keyed hue shift painted wandering turquoise patches on open
    // ocean (user critique); turquoise now arrives via SSS (sun-angled) or
    // the shallows hook below.
    // both bands are in units of σ (RMS elevation), so they keep meaning the
    // same thing when wind/amplitude change — an absolute metre gate silently
    // went from "top 9% of the sea" to "36% of the sea" after the swell
    // retune, which is what painted the turquoise cow pattern (§B)
    const sigma = uSeaRms.max(0.05);
    const heightMask = smoothstep(
      sigma.mul(uBodyBand.x),
      sigma.mul(uBodyBand.y),
      totalDisp.y,
    );
    const waterCol = uDeep.mul(mix(float(0.85), float(1.18), heightMask)).toVar();

    // §V20 repetition break — VALUE ONLY, never hue (user rule, §B).
    // v1 lerped the body toward a second, greener tone at 900 m scale and the
    // open sea read as bright turquoise blotches on deep teal — "a cow
    // pattern". Real open ocean does not change HUE in patches; its variation
    // comes from slope, foam, sky reflection and glint. Bright turquoise is
    // allowed only where it is physically motivated: sun through a crest
    // (the SSS path below, §V5) or genuine shallows (shallowTintStrength).
    // So this is a symmetric ±strength brightness ripple on the SAME pigment,
    // sized to stop a flat sheet reading dead — if you can see it as a shape
    // with a boundary, it is too strong.
    const nUv = worldXZ.div(uVariationScale.max(1));
    const bodyNoise = valueNoise(nUv)
      .mul(0.65)
      .add(valueNoise(nUv.mul(2.37).add(vec2(17.3, 5.1))).mul(0.35))
      .mul(2)
      .sub(1); // −1..1, so it darkens as often as it lightens
    waterCol.assign(waterCol.mul(float(1).add(bodyNoise.mul(uVariationStrength))));

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
    // saturated body color via the floor; crest faces pick up warm sun,
    // and the sun term (only the sun term) is cut by the shadow map.
    const ndl = normalWorld.dot(sunDirectionUniform).max(0);
    const lightWrap = uSunTint.mul(ndl.mul(uLightGain).mul(shade).add(uLightFloor));
    waterCol.assign(waterCol.mul(lightWrap));

    // §V.5 SSS fake: choppy horizontal offset isolates wave sides;
    // boost where the camera looks toward the sun through the crest.
    const choppyMask = totalDisp.xz.length().mul(uSssChoppy).clamp(0, 1);
    const backlight = viewDir.negate().dot(sunDirectionUniform).max(0);
    // Ambient crest glow: a TIGHT band in σ units (top few % of crests), and
    // gated on real sun backlighting. The user's rule for open ocean is that
    // bright turquoise is only allowed where sun actually comes THROUGH the
    // water toward the eye (this term) or in genuine shallows
    // (shallowTintStrength) — never as a saturated second hue in big patches.
    // The old version added a sun-INDEPENDENT slug over any water above
    // 0.25 m, i.e. 36% of the sea, at 4× the body colour's green: the blobs.
    const crestMask = smoothstep(
      sigma.mul(uCrestBand.x),
      sigma.mul(uCrestBand.y),
      totalDisp.y,
    );
    // mix(floor,1,backlight): keeps a whisper of translucency on crests facing
    // away from the sun, but the glow only really lights up looking into it
    const ambientSunGate = mix(float(1).sub(uSssAmbientSunGate), float(1), backlight);
    const sss = pow(backlight, uSssPower)
      .mul(heightMask)
      .add(uSssAmbient.mul(crestMask).mul(ambientSunGate))
      .mul(choppyMask)
      .mul(uSssStrength)
      .mul(shade);
    waterCol.assign(waterCol.add(uSss.mul(sss)));

    // analytic sky reflection — capped so body color dominates (§V.20
    // watercolor look: references show pigment, not mirror). At grazing
    // angles a white sky used to bleach the sea gray (user critique), so the
    // reflected sky is pulled toward the water's own hue by grazingSaturation
    // — it keeps the sky's VALUE but not its whiteness.
    const refl = reflect(viewDir.negate(), normalWorld);
    const skyCol = mix(uHorizon, uZenith, refl.y.clamp(0, 1).pow(0.6));
    const bodyPeak = waterCol.r.max(waterCol.g).max(waterCol.b).max(0.001);
    const bodyTint = waterCol.div(bodyPeak); // hue with its brightest channel at 1
    const skyReflCol = mix(skyCol, skyCol.mul(bodyTint), uGrazingSat);
    const col = mix(waterCol, skyReflCol, fresnel.mul(uReflStrength)).toVar();

    // §V.6 foam: progressive-blur sim mask (T5) with crest→soft detail
    // blend; §V.10 wake/intersection foam (T13) combines via max — foam is
    // foam, whichever system shed it. Falls back to raw jacobian threshold
    // when no sim is wired.
    const foamAmount = float(0).toVar();
    if (foam || flowFoam) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node union
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
        .mul(ndl.mul(uLightGain.mul(0.6)).mul(shade).add(uLightFloor.add(0.1)));
      foamAmount.assign(foamMask.clamp(0, 1).mul(0.9));
      col.assign(mix(col, foamCol, foamAmount));
    } else {
      const foamMask = smoothstep(uFoamThreshold, uFoamThreshold.sub(0.35), jacobian);
      foamAmount.assign(foamMask.mul(0.85));
      col.assign(mix(col, uFoam, foamAmount));
    }

    // ── sun glints (§V20 "dense sun sparkle glints") ────────────────────
    // Half-vector specular: with a low sun and a grazing view TOWARD it, the
    // half vector stands almost straight up, so flat water lights up along
    // the sun's azimuth — that band IS the glint road. Two terms share it:
    // a broad continuous road and thresholded per-cell sparkles inside it.
    const halfVec = normalize(viewDir.add(sunDirectionUniform));
    const ndoth = normalWorld.dot(halfVec).max(0);
    // sun below the horizon → no glints at all (evening check: at 18.5h the
    // sun has SET, which is why the water went dead — not a shader gate)
    const sunUp = smoothstep(-0.02, 0.06, sunDirectionUniform.y);
    const glintTrain = pow(ndoth, uGlintTrainPower);
    // per-cell phase offset (2nd hash) so cells twinkle independently — one
    // shared time offset pulses the whole ocean in sync (§B.4)
    const cell = worldXZ.mul(uSparkleScale).floor();
    const sparkleHash = cell.dot(vec2(127.1, 311.7)).sin().mul(43758.5453).fract();
    const phase = cell.dot(vec2(269.5, 183.3)).sin().mul(19741.77).fract();
    const wobble = phase.mul(6.28).add(timeUniform.mul(0.9)).sin().mul(0.05);
    // density threshold: sparse outside the sun path, dense inside it
    const thr = mix(uSparkleDensity.x, uSparkleDensity.y, glintTrain);
    const twinkle = smoothstep(thr, thr.add(0.012), sparkleHash.add(wobble));
    // straight-down views turn the whole field into starfield noise — fade
    // sparkles out as the view leaves grazing angles.
    // smoothstep(e0,e1,x), e0 > e1: 1 below grazeStart, 0 above grazeEnd
    const grazeFade = smoothstep(uGraze.y, uGraze.x, viewDir.y);
    // the road survives everywhere the sparkles do not: it is what makes the
    // sun's reflection READ as a path on the water rather than dots
    const road = pow(ndoth, uGlintRoad.y).mul(uGlintRoad.x);
    const sparkle = twinkle
      .mul(pow(ndoth, uSparklePower))
      .mul(uSparkleStrength)
      .mul(grazeFade)
      // hash sparkle is high-frequency detail, so it obeys the same far fade
      // as the slopes — but that fade now ends at 4.2 km, not 1.2 km. The old
      // 250→1200 m fade deleted the glint train exactly where it lives, the
      // stretch of water between the ship and the sun (user: "I don't see any
      // of the beautiful sparkle and the sun reflection anymore").
      .mul(normFade);
    // the road is a smooth low-frequency lobe: nothing to alias, so it is
    // NOT distance-faded and carries the sun path all the way to the rim
    const glint = sparkle
      .add(road)
      .mul(sunUp)
      .mul(shade)
      .mul(float(1).sub(foamAmount.mul(0.7)));

    // ── distance haze (§V30) ───────────────────────────────────────────
    // The water ignores scene fog (material.fog = false) and melts itself:
    // a linear fog wall starting at 900 m is what made the world read as a
    // painted dome. Curve > 1 keeps the mid-field readable and pushes the
    // melt into the last stretch, ending exactly on the sky's haze colour so
    // the disc rim is invisible.
    const hazeT = pow(smoothstep(uHaze.x, uHaze.y, camDist), uHazeCurve)
      .mul(uHazeStrength)
      .clamp(0, 1);
    col.assign(mix(col, uHazeColor, hazeT));
    // glints punch partway through the haze — a sun path fading to nothing
    // at 2 km looks like fog, not distance
    col.assign(
      col.add(vec3(1.0, 0.95, 0.82).mul(glint).mul(mix(float(1), uGlintHaze, hazeT))),
    );

    // ── underside (§V.24/§V.25): the camera can dive under the surface ──
    // Front-face culling used to make the surface VANISH from below ("the
    // surface is kinda broken off"). From underneath the sea is a mirror
    // ceiling except inside Snell's window (θ < 48.6°, cos ≈ 0.661), where
    // the sky pours through.
    const upDot = viewDir.negate().dot(normalWorld).max(0); // eye→surface vs up
    const soft = uUnderWindow.y.max(0.01);
    const snellWindow = smoothstep(float(0.661).sub(soft), float(0.661).add(soft), upDot);
    const windowCol = mix(uHorizon, uZenith, upDot).mul(uUnderWindow.x);
    const ceiling = uUnderCeiling.mul(uLightFloor.add(ndl.mul(uLightGain).mul(0.5)));
    const under = mix(ceiling, windowCol, snellWindow).toVar();
    // whitecaps and wake still read as bright patches from below
    under.assign(mix(under, uFoam.mul(0.9), foamAmount.mul(0.6)));

    return frontFacing.select(col, under);
  })();

  // MeshBasicNodeMaterial: scene lights bypassed — colorNode owns lighting
  // (§V20 stylized pigment; PBR spec/hemi wash was the "white sheen" bug)
  const material = new THREE.MeshBasicNodeMaterial();
  material.positionNode = positionNode;
  material.colorNode = colorNode;
  // §V.24: transparent flag routes the mesh into the transparent pass where
  // viewportSharedTexture/viewportDepthTexture hold the opaque scene behind.
  material.transparent = true;
  // depthWrite ON (§V28 fill-rate safety). Those viewport copies happen once
  // per FRAME, before the first object that reads them, so the water's own
  // depth never lands in the captured texture — the reason it used to be off.
  // With displacement now reaching kilometres, a depth-write-less ocean would
  // blend every wave layer along the view ray in the horizon band; writing
  // depth lets early-Z drop the hidden ones. Measured 100 fps / 9.8 ms with
  // this on at 512² and a 4.6 km rim.
  material.depthWrite = true;
  // §V25: visible from below (see the Snell's-window branch above)
  material.side = THREE.DoubleSide;
  // §V30: the water does its own distance haze; scene fog would double it
  // and its linear ramp is the "wall" the user sees
  material.fog = false;

  const updateFromParams = () => {
    (uDeep.value as THREE.Color).set(sp.deepColor);
    (uShallow.value as THREE.Color).set(sp.shallowColor);
    uVariationScale.value = sp.variationScale;
    uVariationStrength.value = sp.variationStrength;
    (uSss.value as THREE.Color).set(sp.sssColor);
    (uHorizon.value as THREE.Color).set(sp.skyHorizonColor);
    (uZenith.value as THREE.Color).set(sp.skyZenithColor);
    (uFoam.value as THREE.Color).set(sp.foamColor);
    uSssStrength.value = sp.sssStrength;
    uSssPower.value = sp.sssPower;
    uSssAmbient.value = sp.sssAmbient;
    uShallowMix.value = sp.shallowTintStrength;
    uSssChoppy.value = sp.sssChoppyScale;
    uSssAmbientSunGate.value = sp.sssAmbientSunGate;
    (uCrestBand.value as THREE.Vector2).set(sp.crestBandLow, sp.crestBandHigh);
    (uBodyBand.value as THREE.Vector2).set(sp.bodyBandLow, sp.bodyBandHigh);
    uLightFloor.value = sp.lightFloor;
    uLightGain.value = sp.lightGain;
    (uSunTint.value as THREE.Color).set(sp.sunTint);
    uShadowStrength.value = sp.shadowStrength;
    uReflStrength.value = sp.reflectionStrength;
    uGrazingSat.value = sp.grazingSaturation;
    uSparkleStrength.value = sp.sparkleStrength;
    uSparkleScale.value = sp.sparkleScale;
    uSparklePower.value = sp.sparklePower;
    uGlintTrainPower.value = sp.glintTrainPower;
    (uSparkleDensity.value as THREE.Vector2).set(
      sp.sparkleDensityBase,
      sp.sparkleDensityTrain,
    );
    (uGlintRoad.value as THREE.Vector2).set(sp.glintRoadStrength, sp.glintRoadPower);
    (uGraze.value as THREE.Vector2).set(sp.sparkleGrazeStart, sp.sparkleGrazeEnd);
    uFoamThreshold.value = sp.foamThreshold;
    (uNormFade.value as THREE.Vector2).set(sp.normalFadeStart, sp.normalFadeEnd);
    uAbsorption.value = sp.absorptionDensity;
    uRefractStrength.value = sp.refractionStrength;
    (uRefractTint.value as THREE.Color).set(sp.refractionTint);
    (uHaze.value as THREE.Vector2).set(sp.hazeStart, sp.hazeEnd);
    uHazeCurve.value = sp.hazeCurve;
    uHazeStrength.value = sp.hazeStrength;
    uGlintHaze.value = sp.glintHazePenetration;
    (uUnderCeiling.value as THREE.Color).set(sp.underCeilingColor);
    (uUnderWindow.value as THREE.Vector2).set(
      sp.underWindowBrightness,
      sp.underWindowSoftness,
    );
    (uLodSamples.value as THREE.Vector2).set(sp.lodSamplesFull, sp.lodSamplesCut);
    uNormalStretch.value = sp.normalDetailStretch;
  };

  return {
    material,
    originUniform: originUniform as unknown as { value: THREE.Vector2 },
    sunDirectionUniform: sunDirectionUniform as unknown as { value: THREE.Vector3 },
    timeUniform: timeUniform as unknown as { value: number },
    cameraFarUniform: uCameraFar as unknown as { value: number },
    hazeColorUniform: uHazeColor as unknown as { value: THREE.Color },
    seaRmsUniform: uSeaRms as unknown as { value: number },
    choppinessUniform: uChoppiness as unknown as { value: number },
    updateFromParams,
  };
}
