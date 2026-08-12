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
  dFdx,
  dFdy,
  float,
  frontFacing,
  exp2,
  fwidth,
  linearDepth,
  log2,
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
  /** live sun colour — push from the DirectionalLight every frame */
  sunColorUniform: { value: THREE.Color };
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
  skyDomeColor?: (dir: TslNode) => TslNode,
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
  /**
   * §V.56 (near, far, fullDist): re-saturation of the reflected sky, RAMPED
   * with distance. One constant cannot serve both ends of the frame — see
   * src/ocean/seaChroma.ts (`grazingSaturationAt`), the CPU half of this pair.
   */
  const uGrazingSat = uniform(
    new THREE.Vector3(
      sp.grazingSaturation,
      sp.grazingSaturationFar,
      sp.grazingSaturationFullDist,
    ),
  );
  /** §V.56 (chroma floor, strength) — seaChroma.ts `pigmentFloor` */
  const uPigFloor = uniform(
    new THREE.Vector2(sp.pigmentFloorChroma, sp.pigmentFloorStrength),
  );
  const uLightFloor = uniform(sp.lightFloor);
  const uSkylightDesat = uniform(sp.skylightDesaturation);
  const uScatter = uniform(new THREE.Vector2(sp.sunScatterStrength, sp.sunScatterPower));
  const uLightGain = uniform(sp.lightGain);
  /** LIVE sun colour, pushed from the DirectionalLight each frame. Every
   *  sun-driven term must be tinted by this or the water is lit by a static
   *  near-white sun while the sky burns amber (§T.39). */
  const uSunLightColor = uniform(color(sp.sunTint));
  const uSssMaxMix = uniform(sp.sssMaxMix);
  const uSssBrightness = uniform(sp.sssBrightness);
  const uFresnelR0 = uniform(sp.fresnelR0);
  const uSparkleCell = uniform(
    new THREE.Vector2(sp.sparkleCellPixels, sp.sparkleMinCell),
  );
  const uSpecAA = uniform(new THREE.Vector2(sp.specularAaStrength, sp.specularAaMax));
  const uCrestFoam = uniform(
    new THREE.Vector3(sp.crestFoamBandLow, sp.crestFoamBandHigh, sp.crestFoamStrength),
  );
  const uCrestFoamSlope = uniform(sp.crestFoamSlopeGate);
  const uFoamPatch = uniform(
    new THREE.Vector3(sp.crestFoamPatchScale, sp.crestFoamPatchLow, sp.crestFoamPatchHigh),
  );
  const uFoamEdge = uniform(
    new THREE.Vector2(sp.crestFoamEdgeWidth, sp.crestFoamEdgeStrength),
  );
  const uFoamSkyTint = uniform(sp.foamSkyTint);
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
  const uTransmitFloor = uniform(sp.transmissionFloor);
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
  const uNormPix = uniform(
    new THREE.Vector2(sp.normalTexelFull, sp.normalTexelCut),
  );

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

  /**
   * World size of one PIXEL on the water — `fwidth` of the very coordinate
   * every world-locked term below is evaluated at, so it is the footprint by
   * construction. Needed at module scope because the fragment normals are
   * band-limited against it (see normLod); also reused inside colorNode.
   * Distance × view-angle is NOT a substitute: on a plane seen at a grazing
   * angle the footprint is stretched by 1/sin(grazing) and runs to tens of
   * metres, which is precisely the sunset framing.
   */
  const foot = fwidth(worldXZ);
  const pixWorld = foot.x.max(foot.y).max(1e-4);

  /**
   * §V.48, this surface's own occurrence. The cascade DERIVATIVE textures are
   * compute-written StorageTextures, so they cannot carry a mip chain: a
   * minified `texture()` fetch is a point sample of a zero-mean slope field,
   * i.e. per-pixel noise, and the specular lobes downstream amplify it into
   * the fibrous golden "hair" that covers the whole sea when zoomed out
   * (user). The gate below is the missing filtered tier: each cascade's
   * NORMAL contribution is measured against ITS OWN texel size (domain/N —
   * the sharpest feature it can carry, per §V.48's "measure against the
   * feature, not the repeat") and faded out once a pixel spans more than one
   * of them. Fading to ZERO is the correct average here, because the mean of
   * a zero-mean slope field over a large footprint is zero — and the coarser
   * cascade, whose texels are still resolved, keeps carrying the large-scale
   * wave shading. That is the cascade pyramid acting as the mip chain the
   * textures cannot have.
   *
   * The vertex gate above deliberately stays on VERTEX SPACING: that is the
   * mesh's Nyquist limit, a different quantity from the screen's.
   */
  const texelWorld = (c: { domain: number }) =>
    c.domain / Math.max(1, oceanParams.resolution);
  const normLod = sim.cascades.map((c) => {
    // smoothstep(e0,e1,x), e0 > e1: 1 below `full`, 0 above `cut` (§V23)
    const pxPerTexel = pixWorld.div(Math.max(1e-4, texelWorld(c)));
    const filtered = smoothstep(uNormPix.y, uNormPix.x, pxPerTexel);
    return lodWeight(c.domain, uNormalStretch).mul(filtered);
  });

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
  /**
   * THE SHADING NORMAL — and it MUST be built inside the fragment `Fn()`.
   *
   * §B: this block used to sit at module scope, where `toVar()` + `addAssign()`
   * are a SILENT NO-OP. three's `Node.prototype.assign` (TSLCore.js:57) needs
   * `currentStack`, which only exists while an `Fn()` BODY is executing; with
   * no stack it logs "THREE.TSL: No stack defined for assign operation" once
   * at boot and returns `this` UNCHANGED. So every `addAssign` below — the
   * whole §V.5 turbulent sub-noise on wave faces, i.e. every `microDetail*`
   * param — has never reached a pixel. The tell was two console errors at
   * boot that read as noise, plus a sea the user calls "too clean" while its
   * churn term measured as tuned-in. Same class as §B.8/§B.14/§B.18: no
   * error, no NaN, the value is simply never written.
   *
   * Anything added here later (the wake below is the second such term) is
   * dead the moment this moves back out of the Fn.
   */
  const buildSurfaceSlope = () => {
    // §V.10 CAPILLARY DAMPING (flowfoam). A ship's track kills the SHORT
    // waves — turbulence plus surfactant — leaving the glassy lane astern
    // that reflects the sky coherently and reads as a darker mirror stripe.
    // It multiplies the FINE terms only (shortest cascade, churn, sparkle);
    // a wake does not flatten the swell. 1 = undisturbed sea, so with no
    // flowfoam wired the whole thing folds away.
    const wakeSmooth = flowFoam
      ? flowFoam.wakeSmoothNode(worldXZ, pixWorld)
      : float(1);
    const der = sampleDeriv(0)
      .mul(normLod[0])
      .add(sampleDeriv(1).mul(normLod[1]))
      .add(sampleDeriv(2).mul(normLod[2]).mul(wakeSmooth))
      .mul(normFade);
    // the SAME λ the vertex displacement was built with (anti-fold cap
    // applied), pushed per frame — a baked oceanParams.choppiness read here
    // meant the normals solved a different surface than the geometry drew
    // whenever the cap engaged or the slider moved
    const lambda = uChoppiness;
    const denomX = float(1).add(der.z.mul(lambda)).max(0.05);
    const denomZ = float(1).add(der.w.mul(lambda)).max(0.05);
    const slopeX = der.x.div(denomX).toVar();
    const slopeZ = der.y.div(denomZ).toVar();

    // ── turbulent sub-noise (user, SoT storm reference) ──────────────────
    // Wave faces in the reference are visibly churned, not smooth flanks with
    // foam on top. That detail sits far below vertex spacing (~1 m at the
    // ship) so NO cascade LOD can carry it — it has to live in the slope.
    // Four wavelets at non-commensurate frequencies and golden-angle
    // directions, differentiated analytically (cos of a plane wave), so there
    // are no finite differences and no extra texture fetches. It rides the
    // same Nyquist gate as everything else (§V30): once a wavelet is finer
    // than the pixel footprint it fades instead of sizzling.
    const microScale = uMicro.y.max(0.05);
    const microFade = lodWeight(microScale, uNormalStretch);
    const microPhase = timeUniform.mul(uMicro.z);
    const wavelet = (dirX: number, dirZ: number, freqMul: number, phaseMul: number) => {
      const k = float(Math.PI * 2 * freqMul).div(microScale);
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
    // gate to wave FACES: troughs stay comparatively calm, flanks churn.
    // Captured BEFORE the churn is added — this is the swell's own steepness,
    // and the foam gates downstream want that, not the churn's contribution.
    const slopeMag = slopeX.mul(slopeX).add(slopeZ.mul(slopeZ)).sqrt().toVar();
    const faceGate = smoothstep(float(0), uMicro.w.max(0.02), slopeMag);
    const microGain = microAmp.mul(faceGate).mul(wakeSmooth);
    slopeX.addAssign(w0.x.add(w1.x).add(w2.x).add(w3.x).mul(microGain));
    slopeZ.addAssign(w0.z.add(w1.z).add(w2.z).add(w3.z).mul(microGain));

    // §V.10 THE WAKE'S OWN SURFACE (flowfoam) — the shape under the white
    // paint. Bow mound + divergent cusp crests + transverse train are summed
    // into ONE signed world-XZ slope on the flowfoam side (its Kelvin
    // stationary-phase solve owns the 19.47° envelope and the λ = 2πv²/g
    // scaling), so a fourth mechanism later needs no change here. It is
    // bounded and band-limited at its source, so it adds straight on.
    // A slope, never a displacement: the ocean owns its geometry.
    if (flowFoam) {
      const wSlope = flowFoam.wakeSlopeNode(worldXZ, pixWorld);
      slopeX.addAssign(wSlope.x);
      slopeZ.addAssign(wSlope.y);
    }

    return {
      slopeMag,
      wakeSmooth,
      normalWorld: normalize(vec3(slopeX.negate(), 1, slopeZ.negate())),
    };
  };

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
    // FIRST, and inside the Fn on purpose — see buildSurfaceSlope's header.
    const { slopeMag, wakeSmooth, normalWorld } = buildSurfaceSlope();
    const surfacePos = vec3(worldXZ.x, totalDisp.y, worldXZ.y);
    const viewDir = normalize(cameraPosition.sub(surfacePos)); // surface → eye

    // ── filtered specular (§V.48, Kaplanyan "filtering distributions of
    // normals") ────────────────────────────────────────────────────────
    // A pow(N·H, 180) lobe point-sampled on a normal field that swings
    // through many wave faces inside one pixel returns "blazing" or "nothing"
    // essentially at random, and boils under motion — the noise the user sees
    // zoomed out. The cure is NOT less specular (that flattens the sea): it is
    // to carry the sub-pixel normal VARIANCE into the lobe width, so the lobe
    // broadens exactly where the normals are noisy and stays tight where they
    // are coherent. σ² from screen-space derivatives, because the normals here
    // are procedural/FFT — there is no authored normal map to mip (Toksvig).
    // Blinn-Phong form of α'² = α² + 2σ²  ⟹  p' = p / (1 + p·σ²), and the
    // peak scales by p'/p so the lobe's ENERGY is conserved: the glint road
    // (low variance, coherent) survives at full brightness while isolated
    // pixel-sized sparkles are spread back into the average they should have
    // been. §V.44: σ² is a sum of squares (≥0) and is capped, so `gain` ∈ (0,1]
    // and no term can grow.
    const nDx = dFdx(normalWorld);
    const nDy = dFdy(normalWorld);
    const normalVar = nDx
      .dot(nDx)
      .add(nDy.dot(nDy))
      .mul(uSpecAA.x)
      .clamp(0, uSpecAA.y.max(1e-5));
    // Schlick with the real R0 for water (0.02). The old form dropped R0 and
    // then multiplied by a 0.13 CAP, so the sea could never show more than 13%
    // sky — roughly right looking straight down, badly wrong at grazing
    // incidence, and a sunset frame is nothing but grazing incidence. Physical
    // Fresnel gives the reference's own description for free: pigment close in
    // (steep view), sky-dominated further out (grazing).
    const cosTheta = viewDir.dot(normalWorld).max(0);
    const fresnel = uFresnelR0
      .add(float(1).sub(uFresnelR0).mul(pow(float(1).sub(cosTheta), 5)))
      .clamp(0, 1);
    const shade = mix(float(1), shadowMask, uShadowStrength);
    // Sun-elevation gate: below the low edge there is no direct sun at all
    // (§B: at 18.5h the sun has SET, which is why the water went dead — not a
    // shader gate). The high edge must stay LOW or a horizon-kissing sunset
    // loses the water's sun terms exactly where the money shot lives (§T.39).
    const sunUpFactor = smoothstep(
      uSunHorizonFade.x,
      uSunHorizonFade.y.max(uSunHorizonFade.x.add(1e-4)),
      sunDirectionUniform.y,
    );

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
    // THIS FRAGMENT's depth, not the scene's. `viewportLinearDepth` reads as if
    // it were ours — three's own docstring above it even says "of the current
    // fragment" — but it is defined as `linearDepth(viewportDepthTexture())`,
    // i.e. the depth of whatever is already in the buffer at screenUV. It was
    // therefore byte-identical to `straightDepth` below, so `probeThickness`
    // was IDENTICALLY ZERO, `refractRamp` zero, `validRefraction` always false
    // and `seeThrough` always zero. The entire §V.24 transmission channel —
    // refraction offset, absorption by thickness, and the transmitFloor cap on
    // the mirror — was multiplied by nothing, and the water could never show a
    // submerged hull however the Fresnel was tuned. `linearDepth()` with no
    // argument is the fragment's own (ViewportDepthNode.js:281).
    const ownDepth = linearDepth();
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
    // NOTE: `sceneCol`/`seeThrough` are deliberately NOT composited into
    // `waterCol` here — see the transmission channel at the fresnel split
    // below. `waterCol` from this point on is the water's BODY radiance only.

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
      .add(uSunLightColor.mul(ndl.mul(uLightGain).mul(shade)));
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
    waterCol.assign(waterCol.add(uSss.mul(uSunLightColor).mul(bodyScatter)));

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
    // §V.44 BOUNDED AT SOURCE. This lobe is keyed on view·sun, so when the
    // camera faces a low sun the alignment holds across the WHOLE visible sea
    // at once — not a glint road, the entire frame. As an unbounded additive
    // term (peak 2.3 x a saturated cyan, ~40x the lit body luminance) that
    // turned the sea electric cyan facing the sun and left it dark teal facing
    // away: rotating the camera restaged the scene (user, 4-angle set).
    // Three changes, all bounding rather than scaling:
    //   1. a MIX, not an add — the sea can take the scatter colour but can
    //      never exceed it, at any sun elevation or view angle;
    //   2. gated by the TIGHT crest band (top ~5% of the surface), because
    //      light only transmits where the wave is genuinely thin — the old
    //      heightMask let it fire over every raised face;
    //   3. tinted by the LIVE sun colour and gated by sun elevation, so a dim
    //      amber sunset scatters dim amber light, not vivid noon cyan.
    // Away-facing frames are untouched (backlight = 0 there), which is the
    // point: this must not re-open the "scene goes unlit on rotation" fix.
    const sssDrive = pow(backlight, uSssPower)
      .mul(crestMask)
      .add(uSssAmbient.mul(crestMask).mul(ambientSunGate))
      .mul(choppyMask)
      .mul(uSssStrength)
      .mul(shade)
      .mul(sunUpFactor);
    const sssAmount = sssDrive.clamp(0, uSssMaxMix.clamp(0, 1));
    const scatterCol = uSss.mul(uSunLightColor).mul(uSssBrightness);
    waterCol.assign(mix(waterCol, scatterCol, sssAmount));

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

    // ── reflected sky: THE sky, asked directly ─────────────────────────
    // `skyDomeColor` is src/sky/skyBackground.ts's own dome function — the
    // same one `scene.backgroundNode` calls — evaluated along the reflection
    // ray, with the sun DISC, GLOW and HALO deliberately excluded. Two things
    // follow, and both were user complaints:
    //   (a) the sea no longer takes the sunlight colour uniformly in every
    //       direction. The term this replaces was mix(horizon, zenith, refl.y)
    //       — an ELEVATION ramp with no azimuth at all — plus a sun-aligned
    //       halo that only ever ADDED warmth toward the sun and never cooled
    //       the opposite side. skyDome's haze/warmth terms all ride `sunSide`,
    //       so the anti-solar water now genuinely reflects a cooler sky.
    //   (b) the reflected sun is not re-added here. On a rough sea the sun's
    //       reflection is not a mirror image of the disc, it is the glint
    //       road: each wave facet lights up only where its own normal
    //       bisects view and sun, which the pow(N·H) terms below already
    //       model. Re-adding an HDR disc through a reflection — analytic OR
    //       through the planar mirror — paints the clean circular blob the
    //       user shot.
    // SINGLE AUTHORITY (§T.39): the ocean must not hold a second sky model.
    // The fallback below exists only for a build with no sky wired at all
    // (the material is constructible standalone); it is the plain elevation
    // ramp, with no sun term, so it can never disagree about the sun.
    // refl is unit by construction (both inputs are), so no normalize.
    const refl = reflect(viewDir.negate(), normalWorld);
    const skyCol = (
      skyDomeColor
        ? skyDomeColor(refl)
        : mix(horizonLive, zenithLive, refl.y.clamp(0, 1).pow(0.6))
    ).toVar();
    // At grazing angles a white sky used to bleach the sea gray (user
    // critique), so the reflected sky is pulled toward the water's own hue by
    // grazingSaturation — it keeps the sky's VALUE but not its whiteness.
    const bodyPeak = waterCol.r.max(waterCol.g).max(waterCol.b).max(0.001);
    const bodyTint = waterCol.div(bodyPeak).toVar(); // brightest channel at 1
    // §V.56 lever 1. Close water can afford raw Fresnel — you see its body
    // THROUGH the surface (§V.24), so the pigment is present whatever the
    // reflection does, and re-saturating hard there is what made the sea read
    // as over-saturated teal. Distant water is ENTIRELY grazing: Schlick ≈ 1,
    // nothing transmits, the pixel is pure reflected sky, and without its
    // pigment handed back it greys out (user: "the water at distance still has
    // a very high tendency to get grey and washed out"). Transliterated by
    // seaChroma.grazingSaturationAt — keep the two in step.
    const grazSat = mix(
      uGrazingSat.x,
      uGrazingSat.y,
      smoothstep(float(0), uGrazingSat.z.max(1), camDist),
    );
    const skyReflCol = mix(skyCol, skyCol.mul(bodyTint), grazSat);
    // §V26 planar reflections: the module replaces the CONTENT of the
    // reflected colour, never its WEIGHT — fresnel × reflectionStrength stays
    // here, so §V20's painted-water bar is owned by this file alone.
    // Absent reflection → the analytic sky term, unchanged.
    const reflCol = reflection
      ? reflection.shade({
          skyColor: skyReflCol,
          normalWorld,
          chop: totalDisp.xz.length(),
          camDist,
        })
      : skyReflCol;

    // ── §V.24 interface split: reflection and transmission are COMPLEMENTS ──
    // §V.49, and both halves landed from different owners. (a) the 0.13 hard
    // cap on `reflectionStrength` was replaced by physical Schlick at R0=0.02,
    // which is ~9× more reflection at an ordinary 20° view (old: pow(1−cos,5)
    // ×0.13 = 0.015; new: 0.02+0.98·pow(1−cos,5) = 0.134) and →1 at grazing;
    // (b) `reflection.live` went 1, so that weight now carries a bright, real
    // mirror instead of the analytic sky. Neither is wrong alone. The PRODUCT
    // was an opaque wall, because the refracted scene was composited into
    // `waterCol` ~150 lines up and then (i) multiplied by the water's own wrap
    // light, (ii) mixed away by the SSS/scatter terms, and (iii) finally
    // painted over by the mirror. A submerged hull is TRANSMITTED light; it
    // must not be crushed together with the pigment.
    //
    // So: absorption stays INSIDE the volume (Beer-Lambert between the body
    // pigment and what is behind the water — cf. the reference's "absorption
    // applies within water, not to the interface itself"), and the interface
    // splits that transmitted radiance against the reflection exactly once:
    //   L = F·L_refl + (1−F)·[ T·L_behind + (1−T)·L_body ]
    const transmitted = mix(waterCol, sceneCol.mul(uRefractTint), seeThrough.mul(0.9));
    // §V.24 forbids "opaque-wall water @ grazing/shallow view", and Schlick
    // alone produces exactly that: F→1 deletes the submerged geometry. Cap the
    // mirror in proportion to `seeThrough`, so the floor exists ONLY where
    // there is something submerged to see. Open water has nothing behind it
    // (thickness → ∞ ⟹ seeThrough → 0), so the grazing sunset sea keeps its
    // full physical Fresnel mirror and §T.39 is untouched.
    const reflWeight = fresnel
      .mul(uReflStrength)
      .min(float(1).sub(uTransmitFloor.clamp(0, 0.9).mul(seeThrough)))
      .clamp(0, 1);
    const col = mix(transmitted, reflCol, reflWeight).toVar();

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
      // INTERIM (§Rule 8 — this is NOT §T.5). The foam sim owns real whitecap
      // injection; at normal swell it currently produces nothing, so the sea
      // reads "synthetic, like a weird liquid" (user). This adds sparse foam on
      // the steepest crest tops so swell is not bare, and it is σ-RELATIVE
      // (§V.36): the same multiple of heightRms gives sparse patches in swell
      // and heavy coverage in storm with no per-preset tuning. It combines by
      // max, so it never fights the sim where the sim is producing foam.
      //
      // v2 (user, at the default swell preset): "too long, too white, too
      // thick, too regular, too big — just too chunky, like a milk cut."
      // ROOT SHAPE PROBLEM: a smooth gate on a smooth field. Both σ-height and
      // slope are band-limited continuous fields, so their super-level set is
      // a smooth connected CONTOUR — one unbroken ribbon following every crest
      // line. That is what reads as painted-on rather than as water. Real
      // whitecaps are patchy because breaking is a threshold on an
      // intermittent quantity. Three changes, none of which drop the mechanism:
      //   (a) BREAK UP — multiply coverage by a world-locked noise field, so
      //       the ribbon becomes patches. Band-limited per §V.48 (each octave
      //       fades to its own mean once a pixel spans a lattice cell) or this
      //       trades chunky foam for the stipple the user already reported;
      //   (b) TRANSLUCENT BODY — the patch body no longer reaches full
      //       opacity. Thin foam takes the water and sky beneath it; only the
      //       breaking edge is allowed to read white;
      //   (c) BREAKING EDGE — a separate, much narrower gate on the extreme
      //       crest tops AND the steepest faces, which is the bright lip in
      //       docs/ref-storm-whitecaps.png.
      // STILL MISSING, say so (§Rule 8): temporal decay and the trailing
      // streaks down the wave face. Both need foam to PERSIST after the crest
      // that made it has moved on, i.e. state — that is the foam sim's job
      // (§T.5), not a per-pixel gate's, and it is the single biggest remaining
      // gap between this and the reference.
      const bandNoise = (scale: TslNode) => {
        const s = scale.max(0.05);
        // §V.48(b): fade the octave toward its own MEAN once one pixel spans a
        // lattice cell — that mean IS the average the pixel should have seen.
        // smoothstep(e0,e1,x), e0 > e1: 1 below 0.3, 0 above 1.
        const keep = smoothstep(float(1), float(0.3), pixWorld.div(s));
        return mix(float(0.5), valueNoise(worldXZ.div(s)), keep);
      };
      const patchScale = uFoamPatch.x.max(0.5);
      const patch = bandNoise(patchScale)
        .mul(0.62)
        .add(bandNoise(patchScale.mul(0.34)).mul(0.38));
      const patchGate = smoothstep(uFoamPatch.y, uFoamPatch.z, patch).clamp(0, 1);
      const slopeGate = uCrestFoamSlope.max(0.02);
      // σ-relative HEIGHT band (§V.36 — keeps meaning "crest tops" at any sea
      // state) × ABSOLUTE slope gate. The slope gate is deliberately NOT
      // σ-relative: a σ-relative pair on both axes would give literally
      // constant coverage at every sea state, and the user wants sparse in
      // swell, heavy in storm. Steepness is the physically honest carrier of
      // that difference — a storm sea really is steeper, not just taller — so
      // one pair of numbers serves calm/swell/storm without preset tuning.
      const crestFoam = smoothstep(
        sigma.mul(uCrestFoam.x),
        sigma.mul(uCrestFoam.y),
        totalDisp.y,
      )
        .mul(smoothstep(float(0), slopeGate, slopeMag))
        .mul(patchGate)
        .mul(uCrestFoam.z);
      const breakEdge = smoothstep(
        sigma.mul(uCrestFoam.y),
        sigma.mul(uCrestFoam.y.add(uFoamEdge.x.max(0.05))),
        totalDisp.y,
      )
        .mul(smoothstep(slopeGate, slopeGate.mul(1.9), slopeMag))
        .mul(patchGate)
        .mul(uFoamEdge.y);
      foamMask = foamMask.max(crestFoam.max(breakEdge));
      // foam takes the sky's colour — the reference's foam is warm cream, not
      // the cool near-white it is authored as, and against a warm sunset sky a
      // cool white foam reads wrong even once coverage is right
      const foamBase = mix(uFoam, uHazeColor, uFoamSkyTint.clamp(0, 1));
      const foamCol = foamBase
        .mul(foamTintNode())
        .mul(ndl.mul(uLightGain.mul(0.6)).mul(shade).add(uLightFloor.add(0.1)));
      foamAmount.assign(foamMask.clamp(0, 1).mul(0.9).mul(foamGain));
      col.assign(mix(col, foamCol, foamAmount));
    } else {
      const foamMask = smoothstep(uFoamThreshold, uFoamThreshold.sub(0.35), jacobian);
      foamAmount.assign(foamMask.mul(0.85).mul(foamGain));
      col.assign(mix(col, uFoam, foamAmount));
    }

    // ── §V.56 THE PIGMENT FLOOR ─────────────────────────────────────────
    // The one place in this material that is deliberately a STYLISATION and
    // not a physical term, and it is named so it can be found. §V.20 is a LOOK
    // bar, not a physics bar: if honest Fresnel against a pale sky means a
    // correct equation deletes the sea's colour, the stylisation pushes back
    // HERE rather than the look being quietly lost.
    //
    // It acts on the SUM — reflection, transmission, body, foam, everything
    // composited so far — because that is where the defect lives. Five
    // separate complaints (§B.12's cow pattern, the teal hull, the rotation
    // blowout, this grazing grey wash, the wake's white curtain) were each a
    // different individually-defensible term, and each was fixed locally
    // without making the sea ROBUST to losing its pigment. The §V.49 lesson,
    // applied to a whole material instead of to two owners.
    //
    // Below the floor only: a sea that already has its colour is untouched,
    // bit-exact. Gated by (1 − foam) because breaking foam IS allowed to read
    // white — it is the disturbed water BETWEEN the caps that must not go grey.
    // Value-preserving (renormalised by the tint's own luminance) so this
    // restores hue without darkening the frame — §V.44, a multiply, never a
    // subtraction. CPU transliteration: seaChroma.pigmentFloor.
    const colHi = col.r.max(col.g).max(col.b);
    const colLo = col.r.min(col.g).min(col.b);
    const colChroma = colHi.sub(colLo).div(colHi.max(1e-4));
    // smoothstep(e0,e1,x) with e0 > e1: 1 at chroma 0, 0 at the floor (§V23)
    const pigNeed = smoothstep(uPigFloor.x, float(0), colChroma)
      .mul(uPigFloor.y.clamp(0, 1))
      .mul(float(1).sub(foamAmount.clamp(0, 1)));
    const tintLum = bodyTint.dot(vec3(0.2126, 0.7152, 0.0722)).max(1e-4);
    col.assign(mix(col, col.mul(bodyTint).div(tintLum), pigNeed));

    // ── sun glints (§V20 "dense sun sparkle glints") ────────────────────
    // Half-vector specular: with a low sun and a grazing view TOWARD it, the
    // half vector stands almost straight up, so flat water lights up along
    // the sun's azimuth — that band IS the glint road. Two terms share it:
    // a broad continuous road and thresholded per-cell sparkles inside it.
    const halfVec = normalize(viewDir.add(sunDirectionUniform));
    const ndoth = normalWorld.dot(halfVec).max(0);
    const sunUp = sunUpFactor;
    // widened exponent + energy-conserving peak for one lobe (see normalVar)
    const widen = (p: TslNode) => float(1).add(float(p).mul(normalVar));
    const trainWiden = widen(uGlintTrainPower);
    // the train is a FOOTPRINT (it selects where sparkles are dense), not a
    // radiance, so it takes the widened exponent WITHOUT the energy rescale —
    // damping it would thin the sun path instead of just de-aliasing it
    const glintTrain = pow(ndoth, uGlintTrainPower.div(trainWiden));
    // per-cell phase offset (2nd hash) so cells twinkle independently — one
    // shared time offset pulses the whole ocean in sync (§B.4)
    // §V.48 band-limiting. World-locked 5.6 cm cells are ~24 px blocks at 2 m
    // (white squares beside the hull) and ~0.25 px at 200 m, where the on/off
    // threshold becomes per-pixel noise — the dense stipple over mid-distance
    // water. Sizing cells by the pixel's own WORLD FOOTPRINT keeps them a
    // fixed number of pixels across at every distance AND every view angle;
    // quantising to octaves keeps them world-locked within a band so the
    // pattern does not boil as the camera moves. (v2: the previous
    // distance × angle estimate ignored grazing stretch, so a low camera —
    // exactly the sunset framing — still stippled everything past mid-field.)
    const cellTarget = pixWorld.mul(uSparkleCell.x).max(uSparkleCell.y);
    const cellSize = exp2(log2(cellTarget).floor()).max(uSparkleCell.y);
    const cell = worldXZ.div(cellSize).floor();
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
    const roadWiden = widen(uGlintRoad.y);
    const road = pow(ndoth, uGlintRoad.y.div(roadWiden))
      .div(roadWiden)
      .mul(uGlintRoad.x);
    const sparkWiden = widen(uSparklePower);
    const sparkle = twinkle
      .mul(pow(ndoth, uSparklePower.div(sparkWiden)).div(sparkWiden))
      .mul(uSparkleStrength)
      .mul(grazeFade)
      // §V.10: the sparkle field is a world-cell HASH and does not read the
      // normal, so a wake-flattened lane would stay stippled with glints and
      // lose the coherent mirror read that IS the slick.
      .mul(wakeSmooth)
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
  // §V25: visible from below (see the Snell's-window branch above).
  // forceSinglePass keeps DoubleSide but stops three compiling AND drawing a
  // separate back-side pipeline: without it this material's 524k triangles are
  // rasterised twice per frame through the heaviest fragment shader in the
  // project. Single-pass loses the back-then-front draw ordering, which only
  // matters where front and back faces of the SAME surface overlap in one
  // pixel — at the §V25 waterline crossing. Watch that case.
  material.side = THREE.DoubleSide;
  material.forceSinglePass = true;
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
    uLightGain.value = sp.lightGain;
    uSssMaxMix.value = sp.sssMaxMix;
    uSssBrightness.value = sp.sssBrightness;
    uFresnelR0.value = sp.fresnelR0;
    (uSparkleCell.value as THREE.Vector2).set(sp.sparkleCellPixels, sp.sparkleMinCell);
    (uSpecAA.value as THREE.Vector2).set(sp.specularAaStrength, sp.specularAaMax);
    (uCrestFoam.value as THREE.Vector3).set(
      sp.crestFoamBandLow,
      sp.crestFoamBandHigh,
      sp.crestFoamStrength,
    );
    uCrestFoamSlope.value = sp.crestFoamSlopeGate;
    (uFoamPatch.value as THREE.Vector3).set(
      sp.crestFoamPatchScale,
      sp.crestFoamPatchLow,
      sp.crestFoamPatchHigh,
    );
    (uFoamEdge.value as THREE.Vector2).set(
      sp.crestFoamEdgeWidth,
      sp.crestFoamEdgeStrength,
    );
    uFoamSkyTint.value = sp.foamSkyTint;
    uShadowStrength.value = sp.shadowStrength;
    uReflStrength.value = sp.reflectionStrength;
    (uGrazingSat.value as THREE.Vector3).set(
      sp.grazingSaturation,
      sp.grazingSaturationFar,
      sp.grazingSaturationFullDist,
    );
    (uPigFloor.value as THREE.Vector2).set(
      sp.pigmentFloorChroma,
      sp.pigmentFloorStrength,
    );
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
    uTransmitFloor.value = sp.transmissionFloor;
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
    (uNormPix.value as THREE.Vector2).set(sp.normalTexelFull, sp.normalTexelCut);
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
    sunColorUniform: uSunLightColor as unknown as { value: THREE.Color },
    updateFromParams,
  };
}
