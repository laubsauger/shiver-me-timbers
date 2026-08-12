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
  viewportTexture,
} from 'three/tsl';
import type { OceanSimulation } from './oceanCascades';
import type { FoamSim } from '../foam';
import { foamDetailMask, foamTintNode } from '../foam';
import type { FlowFoam } from '../flowfoam';
import { oceanSurfaceParams as sp } from '../params/oceanSurface';
import { oceanParams } from '../params/ocean';
import { solveGrowthRate, type SurfaceGridOptions } from './surfaceGeometry';
import { seabedShallowFactorNode, type SeabedField } from '../island/seabed';
import type { PlanarReflection } from '../reflection';

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
  /** true when the scene-colour copy target was built for a half-float pass */
  readonly hdrSceneTarget: boolean;
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
  seabed?: SeabedField | null,
  reflection?: PlanarReflection | null,
  hdrSceneTarget = false,
): OceanSurfaceMaterial {
  /**
   * §V24 scene-colour copy target — and a §V28-class silent failure if it is
   * wrong. three's `viewportSharedTexture` allocates ONE module-level
   * FramebufferTexture, and FramebufferTexture forces its own format: the
   * render target's when it can see one, otherwise the CANVAS format
   * (bgra8unorm). With post-processing on, the scene is rendered into a
   * half-float pass target, so every frame
   *   copyFramebufferToTexture: source rgba16float, destination bgra8unorm
   * fails the format check. A copy that fails is a copy that DID NOT HAPPEN —
   * the read side then samples an uninitialised texture, silently, forever.
   * `internalFormat` is the only field that outranks that forced format, so
   * this is the one place it can be fixed from. It MUST track whatever the
   * scene is actually rendered into; see OceanSurface for the live check.
   */
  const sceneColorTexture = new THREE.FramebufferTexture(1, 1);
  sceneColorTexture.name = 'ocean-scene-color';
  if (hdrSceneTarget) {
    (sceneColorTexture as unknown as { internalFormat: string }).internalFormat =
      'rgba16float';
  }
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
  const uSkyRefHaze = uniform(color(sp.skyReferenceHaze));
  const uSkyFollow = uniform(sp.skyFollowStrength);
  const uSkyTintMax = uniform(sp.skyTintMax);
  const uSunHorizonFade = uniform(
    new THREE.Vector2(sp.sunHorizonFadeLow, sp.sunHorizonFadeHigh),
  );
  const uFoam = uniform(color(sp.foamColor));
  const uSssStrength = uniform(sp.sssStrength);
  const uSssPower = uniform(sp.sssPower);
  const uSssAmbient = uniform(sp.sssAmbient);
  const uShallowMix = uniform(sp.shallowTintStrength);
  const uShallowFullDepth = uniform(sp.shallowFullDepth);
  const uRefractDepthFull = uniform(sp.refractionDepthFull);
  const uFoamFarDamp = uniform(sp.foamFarDamp);
  const uSssChoppy = uniform(sp.sssChoppyScale);
  const uSkylightFloor = uniform(sp.sssSkylightFloor);
  const uStormGlowMax = uniform(sp.stormGlowMax);
  const uSeaRmsRef = uniform(sp.seaRmsReference);
  const uMicro = uniform(
    new THREE.Vector4(
      sp.microDetailStrength,
      sp.microDetailScale,
      sp.microDetailSpeed,
      sp.microDetailSlopeGate,
    ),
  );
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
  const uSkylightDesat = uniform(sp.skylightDesaturation);
  const uScatter = uniform(new THREE.Vector2(sp.sunScatterStrength, sp.sunScatterPower));
  const uSkySunGlow = uniform(new THREE.Vector2(sp.skySunGlowStrength, sp.skySunGlowPower));
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
  const lodWeight = (domain: number | TslNode, stretch: TslNode) => {
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
  const slopeX = der.x.div(denomX).toVar();
  const slopeZ = der.y.div(denomZ).toVar();

  // ── turbulent sub-noise (user, SoT storm reference) ──────────────────
  // Wave faces in the reference are visibly churned, not smooth flanks with
  // foam on top. That detail sits far below vertex spacing (~1 m at the ship)
  // so NO cascade LOD can carry it — it has to live in the slope. Four
  // wavelets at non-commensurate frequencies and golden-angle directions,
  // differentiated analytically (cos of a plane wave), so there are no finite
  // differences and no extra texture fetches. It rides the same Nyquist gate
  // as everything else (§V30): once a wavelet is finer than the pixel
  // footprint it fades instead of sizzling.
  const microScale = uMicro.y.max(0.05);
  const microFade = lodWeight(microScale, uNormalStretch);
  const microPhase = timeUniform.mul(uMicro.z);
  const wavelet = (dirX: number, dirZ: number, freqMul: number, phaseMul: number) => {
    const k = float((Math.PI * 2 * freqMul)).div(microScale);
    const arg = worldXZ.x
      .mul(dirX)
      .add(worldXZ.y.mul(dirZ))
      .mul(k)
      .add(microPhase.mul(phaseMul));
    const d = arg.cos().mul(k);
    return { x: d.mul(dirX), z: d.mul(dirZ) };
  };
  // golden-angle directions, irrational-ish frequency ratios: no visible grid
  const w0 = wavelet(0.966, 0.259, 1.0, 1.0);
  const w1 = wavelet(-0.259, 0.966, 1.618, -0.83);
  const w2 = wavelet(0.707, -0.707, 2.414, 1.31);
  const w3 = wavelet(-0.809, -0.588, 3.732, -1.07);
  const microAmp = uMicro.x.mul(microScale).mul(0.02).mul(microFade);
  // gate to wave FACES: troughs stay comparatively calm, flanks churn
  const slopeMag = slopeX.mul(slopeX).add(slopeZ.mul(slopeZ)).sqrt();
  const faceGate = smoothstep(float(0), uMicro.w.max(0.02), slopeMag);
  const microGain = microAmp.mul(faceGate);
  slopeX.addAssign(w0.x.add(w1.x).add(w2.x).add(w3.x).mul(microGain));
  slopeZ.addAssign(w0.z.add(w1.z).add(w2.z).add(w3.z).mul(microGain));

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

    // §V24 shallows: seabed depth under the DISPLACED water height, so the
    // tint breathes with the swell instead of sitting as a flat stencil.
    // Without a seabed (open-ocean scene) the factor is a constant 0 and the
    // whole term compiles out — the tint can never leak onto deep water,
    // which matters because this is the ONE legitimate path to bright
    // turquoise (user: acceptable "on a shore"), as opposed to §B.12's
    // sun-independent ambient glow that painted it everywhere.
    const shallowFactor = seabed
      ? seabedShallowFactorNode(seabed, worldXZ, totalDisp.y, uShallowFullDepth)
      : float(0);
    waterCol.assign(mix(waterCol, uShallow, uShallowMix.mul(shallowFactor)));

    // §V.24 transparency: refract the scene behind the surface, absorb by
    // water thickness along the view ray (turquoise → deep teal).
    // linearDepth() is normalized 0..1 over the camera range — scale by
    // far to get METERS or absorption density is meaningless (§B.3)
    const ownDepth = viewportLinearDepth;
    // Refraction displacement must scale with how much WATER is actually in
    // front of the geometry. A constant screen-space offset bends the image
    // of something touching the surface just as hard as the deep seabed, so
    // hulls and shorelines got a shimmering halo of pixels that belong to
    // neither side of the waterline. Probe depth straight first (cheap, one
    // extra fetch), then bend by the offset that thickness earns.
    const straightDepth = linearDepth(viewportDepthTexture(screenUV));
    const probeThickness = straightDepth.sub(ownDepth).max(0).mul(uCameraFar);
    const refractRamp = smoothstep(float(0), uRefractDepthFull.max(0.05), probeThickness);
    const refractedUV = screenUV.add(
      vec2(normalWorld.x, normalWorld.z).mul(uRefractStrength).mul(refractRamp),
    );
    const sceneDepthBehind = linearDepth(viewportDepthTexture(refractedUV));
    const thicknessMeters = sceneDepthBehind.sub(ownDepth).max(0).mul(uCameraFar);
    // nothing meaningfully close behind → fully water-colored (also guards
    // refraction pulling foreground pixels: fall back to straight UV)
    const validRefraction = sceneDepthBehind.greaterThan(ownDepth.add(1e-5));
    const seeThrough = thicknessMeters
      .mul(uAbsorption)
      .negate()
      .exp()
      .mul(validRefraction.select(float(1), float(0)));
    const sceneCol = viewportTexture(
      validRefraction.select(refractedUV, screenUV),
      null,
      sceneColorTexture,
    ).rgb;
    waterCol.assign(
      mix(waterCol, sceneCol.mul(uRefractTint), seeThrough.mul(0.9)),
    );

    // ── light (§V20): the material owns lighting, but it owns it as TWO
    // physically distinct sources, which the single sun-tinted wrap term did
    // not. The floor is SKYLIGHT — it arrives from the whole dome, so it is
    // sky-coloured and shadow-independent; the gain is SUNLIGHT — directional,
    // N·L, and cut by the shadow map. Tinting the floor with sunTint made
    // water facing away from the sun read as dim sunlight rather than as
    // sky-lit water, which is half of why rotating the camera looked like
    // switching the light off (user).
    // Skylight is desaturated toward its own luminance first: a sky colour
    // chosen to look right when PAINTED is not the colour that sky delivers
    // as LIGHT (sky agent's ambient rework, same principle).
    const ndl = normalWorld.dot(sunDirectionUniform).max(0);
    const skyLum = uHazeColor.dot(vec3(0.2126, 0.7152, 0.0722));
    const skylightCol = mix(uHazeColor, vec3(skyLum), uSkylightDesat.clamp(0, 1));
    const lightWrap = skylightCol
      .mul(uLightFloor)
      .add(uSunTint.mul(ndl.mul(uLightGain).mul(shade)));
    waterCol.assign(waterCol.mul(lightWrap));

    // Sunlight that entered the water, scattered, and came back out — the
    // body's own glow, carried in the water's pigment. Keyed to N·L ONLY, so
    // it is completely view-independent: faces tilted toward the sun stay
    // brighter no matter where the camera points, which is what makes a sea
    // read as three-dimensional and lit rather than flat.
    // This is deliberately NOT a specular: the glint road stays view-dependent
    // and still vanishes when you look away, because that is correct. What
    // must not vanish is the sea looking sunlit (user).
    const bodyScatter = pow(ndl, uScatter.y.max(0.05)).mul(uScatter.x).mul(shade);
    waterCol.assign(waterCol.add(uSss.mul(bodyScatter)));

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
    // LOCALISED WEATHER SWAP POINT (§T.38/§V.46): stormFactor is the only
    // inherently positional input here. Today it reads the GLOBAL sea state;
    // when weatherAt(x, z) lands, replace this one line with the sampled
    // field and every term below becomes position-dependent for free.
    const stormFactor = uSeaRms.div(uSeaRmsRef.max(0.05)).clamp(1, uStormGlowMax);
    // mix(floor,1,backlight): the floor is SKYLIGHT through the crest, which
    // does not need the sun — under the reference's dark overcast, storm
    // crests are MORE luminous, not less, because taller seas mean thinner,
    // steeper crest tops. Sun backlighting still takes it to full.
    const ambientSunGate = mix(
      uSkylightFloor.mul(stormFactor).clamp(0, 1),
      float(1),
      backlight,
    );
    const sss = pow(backlight, uSssPower)
      .mul(heightMask)
      .add(uSssAmbient.mul(crestMask).mul(ambientSunGate))
      .mul(choppyMask)
      .mul(uSssStrength)
      .mul(shade);
    waterCol.assign(waterCol.add(uSss.mul(sss)));

    // Sun-elevation gate: below the low edge there is no direct sun at all
    // (§B: at 18.5h the sun has SET, which is why the water went dead — not a
    // shader gate). The high edge must stay LOW or a horizon-kissing sunset
    // loses the water's sun terms exactly where the money shot lives (§T.39).
    const sunUpFactor = smoothstep(
      uSunHorizonFade.x,
      uSunHorizonFade.y.max(uSunHorizonFade.x.add(1e-4)),
      sunDirectionUniform.y,
    );

    // ── reflected sky, unified with the live day cycle ──────────────────
    // The authored pair above is the SHAPE of the sky (horizon lighter than
    // zenith); its colour comes from the live haze, which the sky rig retints
    // every frame and which the water already copies for its distance haze.
    // Dividing the live haze by the reference it was authored against gives a
    // day-cycle tint that is 1 at midday and warm amber at sunset, so the sea
    // warms in lockstep with sky, fog and ambient off ONE source instead of
    // holding cold constants under a warm sky (§T.39 — the sea stayed mint
    // turquoise while everything else warmed). §V28: floored divisor, capped.
    const skyDayTint = uHazeColor
      .div(uSkyRefHaze.max(vec3(0.02, 0.02, 0.02)))
      .clamp(0, uSkyTintMax);
    const follow = uSkyFollow.clamp(0, 1);
    const horizonLive = mix(uHorizon, uHorizon.mul(skyDayTint), follow);
    const zenithLive = mix(uZenith, uZenith.mul(skyDayTint), follow);

    // analytic sky reflection — capped so body color dominates (§V.20
    // watercolor look: references show pigment, not mirror). At grazing
    // angles a white sky used to bleach the sea gray (user critique), so the
    // reflected sky is pulled toward the water's own hue by grazingSaturation
    // — it keeps the sky's VALUE but not its whiteness.
    const refl = reflect(viewDir.negate(), normalWorld);
    const skyCol = mix(horizonLive, zenithLive, refl.y.clamp(0, 1).pow(0.6)).toVar();
    // The sky is far brighter AROUND the sun than elsewhere, so water reflects
    // a brighter sky on the sun's side of the view. This is the honest version
    // of "some scattering even when not looking at the sun" (user): a broad
    // halo that falls off smoothly across a turn, unlike the glint road's
    // pow(N·H, 180) which is a true specular and should snap off. Azimuth
    // matters here — the previous reflected-sky term used elevation only, so
    // the sun's side of the sky was no brighter than the opposite side.
    const reflSunAlign = refl.dot(sunDirectionUniform).max(0);
    skyCol.assign(
      skyCol.add(
        uSunTint.mul(pow(reflSunAlign, uSkySunGlow.y.max(1))).mul(uSkySunGlow.x).mul(sunUpFactor),
      ),
    );
    const bodyPeak = waterCol.r.max(waterCol.g).max(waterCol.b).max(0.001);
    const bodyTint = waterCol.div(bodyPeak); // hue with its brightest channel at 1
    const skyReflCol = mix(skyCol, skyCol.mul(bodyTint), uGrazingSat);
    // §V26 planar reflections: the module replaces the CONTENT of the
    // reflected colour, never its WEIGHT — fresnel × reflectionStrength stays
    // here, so the worst a mirror pass can do is change what that 13% is made
    // of, and §V20's painted-water bar cannot be broken by enabling it.
    // Absent reflection → the analytic sky term, unchanged.
    const reflCol = reflection
      ? reflection.shade({
          skyColor: skyReflCol,
          normalWorld,
          chop: totalDisp.xz.length(),
          camDist,
        })
      : skyReflCol;
    const col = mix(waterCol, reflCol, fresnel.mul(uReflStrength)).toVar();

    // §V.6 foam: progressive-blur sim mask (T5) with crest→soft detail
    // blend; §V.10 wake/intersection foam (T13) combines via max — foam is
    // foam, whichever system shed it. Falls back to raw jacobian threshold
    // when no sim is wired.
    // far-field foam damping rides the same distance ramp as the haze (both
    // are "how much atmosphere is in the way"), computed early because the
    // foam composite happens before the haze mix
    const foamFar = pow(smoothstep(uHaze.x, uHaze.y, camDist), uHazeCurve).clamp(0, 1);
    const foamGain = mix(float(1), uFoamFarDamp, foamFar);
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
      foamAmount.assign(foamMask.clamp(0, 1).mul(0.9).mul(foamGain));
      col.assign(mix(col, foamCol, foamAmount));
    } else {
      const foamMask = smoothstep(uFoamThreshold, uFoamThreshold.sub(0.35), jacobian);
      foamAmount.assign(foamMask.mul(0.85).mul(foamGain));
      col.assign(mix(col, uFoam, foamAmount));
    }

    // ── sun glints (§V20 "dense sun sparkle glints") ────────────────────
    // Half-vector specular: with a low sun and a grazing view TOWARD it, the
    // half vector stands almost straight up, so flat water lights up along
    // the sun's azimuth — that band IS the glint road. Two terms share it:
    // a broad continuous road and thresholded per-cell sparkles inside it.
    const halfVec = normalize(viewDir.add(sunDirectionUniform));
    const ndoth = normalWorld.dot(halfVec).max(0);
    const sunUp = sunUpFactor;
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
    const windowCol = mix(horizonLive, zenithLive, upDot).mul(uUnderWindow.x);
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
    (uSkyRefHaze.value as THREE.Color).set(sp.skyReferenceHaze);
    uSkyFollow.value = sp.skyFollowStrength;
    uSkyTintMax.value = sp.skyTintMax;
    (uSunHorizonFade.value as THREE.Vector2).set(
      sp.sunHorizonFadeLow,
      sp.sunHorizonFadeHigh,
    );
    (uFoam.value as THREE.Color).set(sp.foamColor);
    uSssStrength.value = sp.sssStrength;
    uSssPower.value = sp.sssPower;
    uSssAmbient.value = sp.sssAmbient;
    uShallowMix.value = sp.shallowTintStrength;
    uShallowFullDepth.value = sp.shallowFullDepth;
    uRefractDepthFull.value = sp.refractionDepthFull;
    uFoamFarDamp.value = sp.foamFarDamp;
    uSssChoppy.value = sp.sssChoppyScale;
    uSkylightFloor.value = sp.sssSkylightFloor;
    uStormGlowMax.value = sp.stormGlowMax;
    uSeaRmsRef.value = sp.seaRmsReference;
    (uMicro.value as THREE.Vector4).set(
      sp.microDetailStrength,
      sp.microDetailScale,
      sp.microDetailSpeed,
      sp.microDetailSlopeGate,
    );
    (uCrestBand.value as THREE.Vector2).set(sp.crestBandLow, sp.crestBandHigh);
    (uBodyBand.value as THREE.Vector2).set(sp.bodyBandLow, sp.bodyBandHigh);
    uLightFloor.value = sp.lightFloor;
    uSkylightDesat.value = sp.skylightDesaturation;
    (uScatter.value as THREE.Vector2).set(sp.sunScatterStrength, sp.sunScatterPower);
    (uSkySunGlow.value as THREE.Vector2).set(sp.skySunGlowStrength, sp.skySunGlowPower);
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
    hdrSceneTarget,
    updateFromParams,
  };
}
