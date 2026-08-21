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
  screenSize,
  screenUV,
  shadow,
  smoothstep,
  texture,
  uniform,
  varying,
  vec2,
  vec3,
  viewportDepthTexture,
  viewportTexture,
} from 'three/tsl';
import type { OceanSimulation } from './oceanCascades';
import { sampleCascadeLayer } from './oceanTextures';
import type { FoamSim } from '../foam';
import { foamDetailMask, foamTintNode } from '../foam';
import type { FlowFoam } from '../flowfoam';
import { oceanSurfaceParams as sp } from '../params/oceanSurface';
// §V.33: the water's per-channel extinction K_d has ONE owner and it is not
// this file — see `uAbsorption` below. Params module only, so no import cycle
// with the caustics runtime (which itself imports the ocean sim).
import { causticsParams as cp } from '../params/caustics';
import { oceanParams } from '../params/ocean';
import {
  radialLodXZNode,
  solveGrowthRate,
  type SurfaceGridOptions,
} from './surfaceGeometry';
import {
  seabedHeightLodNode,
  seabedShallowFactorNode,
  type SeabedField,
} from '../island/seabed';
import {
  breakerClipNodes,
  shoalFactorNode,
  shoalWavenumber,
} from './shoaling';
import {
  developmentRatioNode,
  fetchBandCoefficient,
  fetchBandGainNode,
  fullyDevelopedFetch,
  fullyDevelopedPeakWavenumber,
} from './fetch';
import { fetchFieldNode, type FetchField } from './fetchField';
import type { PlanarReflection } from '../reflection';

export interface OceanSurfaceMaterial {
  material: THREE.MeshBasicNodeMaterial;
  /** world-space XZ of the mesh origin — set on camera snap */
  originUniform: { value: THREE.Vector2 };
  sunDirectionUniform: { value: THREE.Vector3 };
  /**
   * §V92 the SUN'S WIDTH, as the road sees it: (tan r, tan r/2, gateLo,
   * gateHi) with r = drawn disc radius + glare (degrees → radians on the
   * CPU), and the gate edges in sin(elevation) = key.y — the same edges as the
   * sky's disc gate, so the road exists exactly while the disc is drawn.
   * Owned per frame by `OceanSurface.update` (it reads the sky params; this
   * file deliberately does not).
   */
  sunSourceUniform: { value: THREE.Vector4 };
  timeUniform: { value: number };
  /** camera far plane, in meters — B3: linearDepth() is normalized, not meters */
  cameraFarUniform: { value: number };
  /** haze target colour — copied from the scene fog so water and objects melt alike */
  hazeColorUniform: { value: THREE.Color };
  /** RMS surface elevation (m) — sea-state scale for every crest threshold */
  seaRmsUniform: { value: number };
  /** fold-capped choppiness λ — must match what the displacement was built with */
  choppinessUniform: { value: number };
  /**
   * §V.30b radial LOD: `2·radialLodPixels·tan(fov/2) / eyeHeight`. The shader
   * divides by the drawing-buffer height to get kRadial. 0 disables the LOD
   * and restores the pre-LOD mesh bit-identically. OceanSurface.update owns it.
   */
  radialLodUniform: { value: number };
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

/**
 * THE CHURN WAVELETS: [dirX, dirZ, frequency multiplier, phase-speed multiplier].
 *
 * Six, not four, and the extra two sit INSIDE the existing frequency band
 * (1.0 … 3.732 ⟹ λ 2.4 … 0.643 m at the default scale) rather than beyond it.
 * That is deliberate: adding a finer wavelet would move the sharpest feature,
 * and the sharpest feature is the one that aliases first and the one that has
 * already caused this file two §V.48 findings. More DIRECTIONS at the same
 * sharpness costs nothing at the band limit and buys isotropy.
 *
 * Headings are spread by the golden angle taken mod 180° (a stripe family and
 * its reverse are the same pattern, so 360° spreading wastes half the budget on
 * duplicates — which is how the old four ended up with two of them 99° apart
 * and reading as a weave). Multipliers are mutually irrational (1, √2, φ, √5,
 * 1+√2, 2+√3) — necessary but nowhere near sufficient on its own, see the note
 * at the call site.
 */
const MICRO_WAVELETS: ReadonlyArray<readonly [number, number, number, number]> = [
  [0.966, 0.259, 1.0, 1.0], //   15.0°
  [-0.591, 0.807, 1.41421, -0.83], // 126.2°
  [0.537, 0.843, 1.61803, 1.31], //  57.5°
  [-0.981, 0.195, 2.23607, -1.07], // 168.8°
  [-0.174, 0.985, 2.41421, 0.79], // 100.0°
  [0.855, 0.519, 3.73205, -1.29], //  31.2°
];

/**
 * Per-wavelet slope amplitude is EQUAL (`amp` ∝ 1/freqMul at the call site), so
 * this constant sets what that common level is. It is chosen to hold the
 * stack's TOTAL slope variance at what the previous four equal-HEIGHT wavelets
 * produced, so `microDetailStrength` keeps its calibration and the near sea does
 * not change loudness: with amp = A/f every wavelet contributes (2π·A/scale)²/2,
 * so N·A² must equal the old Σf², over the old frequency list.
 */
const MICRO_AMP_SCALE = Math.sqrt(
  [1, 1.618, 2.414, 3.732].reduce((s, f) => s + f * f, 0) / MICRO_WAVELETS.length,
);

/**
 * §V.75 COX & MUNK (1954), "Measurement of the roughness of the sea surface
 * from photographs of the sun's glitter", J. Opt. Soc. Am. 44(11):838 — the
 * ZERO-WIND INTERCEPT of their clean-surface regression
 *
 *     σ²_total = 0.003 + 0.00512·U      (U in m/s at 12.5 m)
 *
 * σ² here is the TOTAL mean square slope, up-wind plus cross-wind, which is
 * exactly what `OceanCascade.slopeVariance()` sums (`slopeWavelengthHistogram`
 * bins 2|h|²k² = |∇h|²), so the two quantities are directly comparable.
 *
 * MEASURED LIVE at the shipped swell preset, U = 11 m/s: 0.00263 / 0.00700 /
 * 0.01762 per cascade, total 0.0273, against Cox & Munk's 0.0593 for that
 * wind. The sim carries 46% of the real sea's mean square slope, so the glint
 * road this drives is ~1.5x NARROWER than a photographed one at the same
 * wind. That is a spectrum question, not a shading one — the lobe reads
 * whatever the sim publishes and widens for free if the spectrum is retuned —
 * but it is recorded here because this is the term that makes it visible.
 *
 * It is used as the FLOOR on the glint lobe's roughness. The floor is not a
 * numerical guard dressed up as physics: it is the statement that a sea
 * surface is never a mirror. Even at dead calm there is capillary structure
 * below anything the three cascades carry, and without a floor the Beckmann
 * peak 1/(πσ²) runs away as the shading normal resolves — which is both an
 * unbounded term (§V.44) and the §V.26 mirror disc coming back in through the
 * specular door.
 */
const COX_MUNK_CALM_SLOPE_VAR = 0.003;

/**
 * §V.44 ceiling on the sun lobe's radiance, in scene-linear units BEFORE
 * exposure. Not a look knob — a saturation guard. The renderer tone maps with
 * ACES filmic (`src/sky/lighting.ts`), whose curve reaches 0.97 of white at a
 * scene-linear 4 and 0.995 at 8, so every value past ~8 is the same pixel.
 * 32 is two more stops of headroom on top of that, i.e. it cannot change a
 * shipped frame; what it does stop is the `D · V` product going unbounded on a
 * degenerate normal at the exact grazing limit and handing bloom an Inf.
 */
const GLINT_RADIANCE_MAX = 32;

/**
 * Refractive index of sea water at visible wavelengths. ONE number, three
 * consequences, all of them in the Snell's-window block at the bottom of
 * `colorNode` — which is why it is stated once here rather than as three
 * unrelated literals down there:
 *
 *   · the critical angle,      cos θc = sqrt(1 − 1/n²) = 0.6614  (48.61°)
 *   · the refraction itself,   sin θ_air = n · sin θ_water
 *   · the RADIANCE SCALING,    L_water = L_air · n²
 *
 * The third is the one this project did not have anywhere. Radiance is not
 * conserved across a refractive boundary; the invariant is L/n², so light
 * crossing air→water is multiplied by n² = 1.777. The whole above-water sky is
 * 1.777× brighter seen from below than seen from above, before any of the
 * water's own extinction — that is most of "looking up should feel bright".
 * It is PHYSICS and it is deliberately NOT `underWindowBrightness`, which is
 * the artistic trim on top; conflating the two is how a 1.15 knob came to be
 * standing in for a 1.777 constant and left the window's rim 3× too dark.
 */
export const WATER_IOR = 1.333;
/** n², the air→water radiance scale — exported so the §T.61 test asserts THIS
 *  number rather than a copy of it that could drift from the shader's */
export const WATER_RADIANCE_GAIN = WATER_IOR * WATER_IOR;
/** cos of the critical angle — derived, so it cannot drift from `WATER_IOR` */
export const CRITICAL_COS = Math.sqrt(1 - 1 / (WATER_IOR * WATER_IOR));

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
  fetch?: FetchField | null,
  /**
   * §T.61 — the SUN's own disc/glow/halo toward an arbitrary direction
   * (`SkyHandle.skySunTerm`). Consumed in exactly ONE place: the Snell's-window
   * branch at the bottom of `colorNode`. It is a separate argument from
   * `skyDomeColor` rather than a flag on it precisely so that the reflected sky
   * cannot reach it — §V.26 is about REFLECTION off a rough interface and stays
   * in force there.
   */
  skySunTerm?: (dir: TslNode) => TslNode,
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
  // pre-first-update placeholder: a 2.6° source, gate −2.1°..+1.1° (see the
  // interface note — the live values come from OceanSurface.update)
  const uSunSource = uniform(new THREE.Vector4(0.0454, 0.0227, -0.0366, 0.0192));
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
  const uWakeFoam = uniform(color(sp.wakeFoamColor));
  const uWakeFoamDepth = uniform(sp.wakeFoamDepth);
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
  const uMicroWarp = uniform(sp.microDetailWarp);
  const uMicroWarpScale = uniform(sp.microDetailWarpScale);
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
  /** gain on the ANALYTIC (spectral) sub-pixel slope variance — see `unresolvedVar` */
  const uSlopeVarAa = uniform(sp.slopeVarianceAa);
  const uSparkleShape = uniform(
    new THREE.Vector2(sp.sparkleRadiusPixels, sp.sparkleResolveCells),
  );
  const uMicroSamples = uniform(sp.microDetailSamplesFull);
  const uFoamSkyTint = uniform(sp.foamSkyTint);
  const uShadowStrength = uniform(sp.shadowStrength);
  const uSparkleStrength = uniform(sp.sparkleStrength);
  const uSparkleScale = uniform(sp.sparkleScale);
  const uSparklePower = uniform(sp.sparklePower);
  const uGlintTrainPower = uniform(sp.glintTrainPower);
  const uSparkleDensity = uniform(
    new THREE.Vector2(sp.sparkleDensityBase, sp.sparkleDensityTrain),
  );
  // §V.75: scalar. The lobe's WIDTH is the sea's own σ², so there is no second
  // exponent to author — see the sun-glint block in colorNode.
  const uGlintRoad = uniform(sp.glintRoadStrength);
  const uGraze = uniform(new THREE.Vector2(sp.sparkleGrazeStart, sp.sparkleGrazeEnd));
  const uFoamThreshold = uniform(sp.foamThreshold);
  const uNormFade = uniform(new THREE.Vector2(sp.normalFadeStart, sp.normalFadeEnd));
  /**
   * §V.33 SINGLE OWNER — the water's extinction coefficient K_d (1/m), PER
   * CHANNEL, and it lives in `causticsParams`, not here.
   *
   * WHAT THIS REPLACED, and why it was the whole "I can't see the sea floor"
   * report. This used to be `sp.absorptionDensity`, a SCALAR 0.35 applied to
   * all three channels — i.e. the RED Jerlov coefficient applied to blue.
   * Meanwhile `causticsParams.submergedAbsorption{R,G,B}` = (0.36, 0.08, 0.03)
   * (Jerlov I–IB, Solonenko & Mobley) was already the single owner for three
   * other consumers: the caustic's own depth attenuation (causticsNode), the
   * submerged-hull tint (waterLighting), and the underwater volume
   * (underwater/waterVolume.ts — whose header explicitly cedes the ABOVE-water
   * case to this line). So the sea attenuated one way when you looked down
   * through it and another way once your eye went under, and the way you
   * looked down through it was 12× too opaque in blue:
   *
   *   4 m of water    scalar 0.35 → 0.25 flat    Jerlov → R .24  G .73  B .89
   *   6 m             0.12 flat                          R .12  G .62  B .84
   *  10 m             0.03 flat                          R .03  G .45  B .74
   *
   * 2–6 m is the band you can actually sail in over the island shelf (galleon
   * draft 2.0 m, rim depth 6 m), so this is ~3× more transmitted light exactly
   * where the floor is, and it now arrives TURQUOISE instead of uniformly grey
   * — red dies, blue survives, which is what "clear shallow water" looks like.
   *
   * NO `refractionTint` ANY MORE. It was a fixed teal (#7fd4c9) multiplied onto
   * the refracted scene — a hand-authored, DEPTH-INDEPENDENT stand-in for the
   * per-channel curve that is now actually here. Keeping both double-tints, and
   * worse, the flat one gives sand at 0.5 m the same cast as sand at 8 m, which
   * is the one thing depth-dependent absorption exists to distinguish.
   */
  const uAbsorption = uniform(
    new THREE.Vector3(
      cp.submergedAbsorptionR,
      cp.submergedAbsorptionG,
      cp.submergedAbsorptionB,
    ),
  );
  const uRefractStrength = uniform(sp.refractionStrength);
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
  const gridK = solveGrowthRate(gridOpts);
  const uLodLaw = uniform(new THREE.Vector2(gridOpts.coreSpacing, gridK));
  /**
   * §V.30b radial LOD, in the form the vertex stage can use without knowing the
   * viewport: `2·pixels·tan(fov/2) / h`, so kRadial = this / screenSize.y.
   * OceanSurface.update owns it (it has the camera, and the hysteresis on h).
   * 0 ⟹ every vertex stays on its own ring, bit-identically.
   */
  const uRadialA = uniform(0);
  const uLodSamples = uniform(new THREE.Vector2(sp.lodSamplesFull, sp.lodSamplesCut));
  const uNormalStretch = uniform(sp.normalDetailStretch);
  // (full, cut) footprint in METRES per cascade — measured from the live
  // spectrum, not derived from a texel count. See `normLod` and
  // oceanMath.slopeResolutionFootprint.
  const uNormFoot = sim.cascades.map(() => uniform(new THREE.Vector2(1, 1)));
  /**
   * TOTAL slope variance (σ²) of each cascade's band, from the same binned
   * spectrum the footprints above are inverted out of. `normLod` scales this;
   * the part it scales AWAY is what `unresolvedVar` hands to the specular lobe
   * as roughness (§V.48b). Refreshed on the same rebuild, from the same
   * measurement, so the two can never disagree about what a cascade contains.
   */
  const uSlopeVar = sim.cascades.map(() => uniform(0));
  /**
   * §V.72 SHOALING — per-cascade shoaling wavenumber (rad/m), and the breaker
   * pair (index, column ceiling).
   *
   * Per cascade because shoaling is wavelength-dependent: long swell feels the
   * bottom in deep water, short chop barely notices until it is aground. §V.19
   * band-splits the cascades, so each already HAS a characteristic wavelength
   * and this costs three scalars to exploit. Refreshed in `updateFromParams`
   * rather than only on rebuild, because two of its three inputs
   * (`shoalDeepFraction`, and the seabed's open depth) are not spectrum
   * params and would otherwise never move (§V.62).
   */
  const uShoalK = sim.cascades.map(() => uniform(0));
  const uBreaker = uniform(
    new THREE.Vector2(oceanParams.shoalBreakerIndex, oceanParams.shoalColumnCeiling),
  );
  const refreshShoal = () => {
    // no seabed (open-ocean scene) ⟹ nothing to shoal against; the whole term
    // is compiled out below, so these uniforms are never read
    const openDepth = seabed ? Math.max(-seabed.openHeight, 0) : 0;
    for (const [i, c] of sim.cascades.entries()) {
      uShoalK[i].value = shoalWavenumber(c.meanWavenumber, openDepth, oceanParams);
    }
    (uBreaker.value as THREE.Vector2).set(
      oceanParams.shoalBreakerIndex,
      oceanParams.shoalColumnCeiling,
    );
  };
  /**
   * §V.73 FETCH — per-cascade (k_pfull/k_band)², plus the two scalars the
   * per-vertex half needs.
   *
   * The split is deliberate and it is what makes this affordable: everything
   * that depends only on the WIND and the SPECTRUM is a uniform refreshed once
   * a frame, so the per-vertex work is one texture fetch, one divide and one
   * exp() per cascade. Per cascade for the same reason shoaling is — §V.19 has
   * already band-split the spectrum, and a fetch limit is precisely a statement
   * about which bands survive, so killing the long cascades and keeping the
   * short ones IS fetch limitation and it comes out as short steep chop for
   * free. See src/ocean/fetch.ts.
   */
  const uFetchC = sim.cascades.map(() => uniform(0));
  const uFetchFull = uniform(1);
  const uFetchMaxGain = uniform(oceanParams.fetchMaxGain);
  const refreshFetch = () => {
    const peakK = fullyDevelopedPeakWavenumber(oceanParams.windSpeed);
    for (const [i, c] of sim.cascades.entries()) {
      uFetchC[i].value = fetchBandCoefficient(peakK, c.meanWavenumber, oceanParams);
    }
    uFetchFull.value = fullyDevelopedFetch(oceanParams.windSpeed, oceanParams);
    uFetchMaxGain.value = oceanParams.fetchMaxGain;
  };
  const refreshNormFoot = () => {
    for (const [i, c] of sim.cascades.entries()) {
      (uNormFoot[i].value as THREE.Vector2).set(
        Math.max(1e-4, c.slopeFootprint(sp.normalKeepFull)),
        Math.max(2e-4, c.slopeFootprint(sp.normalKeepCut)),
      );
      uSlopeVar[i].value = Math.max(0, c.slopeVariance());
    }
  };
  refreshNormFoot();
  refreshShoal();
  refreshFetch();

  /**
   * §V.30b — THE VERTEX'S MESH-LOCAL XZ, after the radial LOD has decided which
   * ring it sits on. `positionLocal.xz` everywhere below is replaced by this,
   * and it must be: `worldXZ` is what the cascades are sampled at, what the
   * shoaling depth is read at and what the fragment stage interpolates, so a
   * vertex that MOVED and a vertex that was SAMPLED somewhere else are two
   * different bugs and only the first one is wanted.
   *
   * When the LOD is off (or the vertex is inside the core, or its ring is
   * already a stride multiple) this is `positionLocal.xz` itself, not a
   * re-derivation of it — see `radialLodXZNode`.
   */
  const gridXZ = radialLodXZNode(
    gridOpts,
    gridK,
    uRadialA.div(screenSize.y.max(1)),
    Math.max(0, Math.round(sp.radialLodMaxLevel)),
    sp.radialLodMorph,
  );
  const worldXZ = gridXZ.add(originUniform);
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
   * (user). The gate below is the missing filtered tier.
   *
   * WHAT IT IS MEASURED AGAINST, and this is the whole correction. It used to
   * compare the footprint to the cascade's TEXEL SIZE (domain/N) and delete the
   * cascade once a pixel spanned 3.5 texels, with the justification that "the
   * cascade pyramid IS the mip chain". Both halves were wrong, measured:
   *   - a texel is the finest thing the grid can HOLD, not what the band is
   *     MADE OF. Cascade 2's slope-carrying wavelength is 2.4 m = 53 texels, so
   *     at the 0.155 m footprint where it was being retired outright it still
   *     had 89% of its slope variance resolvable — the criterion was 15× finer
   *     than the feature. §V.48's own rule ("measure against the feature, not
   *     the grid"), with the sign flipped;
   *   - the pyramid CANNOT carry it. §V.19 band-splits the cascades so no
   *     wavelength appears twice; a mip chain is the same wavelengths at
   *     several resolutions. When cascade 2 goes, λ ≤ 8.3 m is gone from the
   *     sea entirely. Measured composite: shading slope RMS fell to 59% of its
   *     near-field value by 53 m, 31% by 130 m, and EXACTLY ZERO past 365 m —
   *     half a kilometre of perfect mirror before the haze starts at 900 m,
   *     against 40% still resolvable there. A mirror takes the sky uniformly,
   *     which is the "greys out under sky reflection" report arriving as a
   *     geometry defect (§V.56 — a colour lever was compensating for this).
   * The gate now fades between the footprints at which `normalKeepFull` and
   * `normalKeepCut` of THAT cascade's own slope variance are still resolvable,
   * both measured from the live spectrum on every rebuild. Fading to ZERO is
   * still the correct endpoint — the mean of a zero-mean slope field over a
   * large footprint is zero — it just has to happen where the band actually
   * runs out, not where its grid does. The residual between the two is what
   * `specularAaStrength` exists to swallow.
   *
   * The vertex gate above deliberately stays on VERTEX SPACING: that is the
   * mesh's Nyquist limit, a different quantity from the screen's.
   */
  const normLod = sim.cascades.map((c, i) => {
    // smoothstep(e0,e1,x), e0 > e1: 1 below `full`, 0 above `cut` (§V23)
    const filtered = smoothstep(uNormFoot[i].y, uNormFoot[i].x, pixWorld);
    return lodWeight(c.domain, uNormalStretch).mul(filtered);
  });

  /**
   * §V.72 WATER DEPTH UNDER THIS VERTEX — and the two things about it that
   * make the CPU mirror agree instead of merely using the same formula.
   *
   * MEASURED AGAINST STILL WATER (y = 0), never against the displaced surface.
   * The displacement is what we are about to attenuate, so keying its own
   * attenuation on it would be a feedback loop; the bed's depth below the
   * waterline is a property of the bed alone, which is also what makes it
   * trivially reproducible on the CPU side.
   *
   * SAMPLED AT THE UNDISPLACED GRID POSITION. This vertex will LAND at
   * worldXZ + D, but it IS the grid point worldXZ, and `CpuOcean.heightAt`
   * inverts the displacement to find exactly this grid coord before summing.
   * Sampling at the displaced position instead would put the two seas 1–2 m
   * apart horizontally near shore — §B.34's defect by a different route.
   *
   * §V.40: this is +1 texture and +1 SAMPLER IN THE VERTEX STAGE, which was at
   * 3/3 against a ceiling of 16. The contested spare everyone budgets against
   * is a FRAGMENT spare; bindings are keyed on (node, shaderStage), so vertex
   * has twelve free and this spends none of the fragment's one. The fragment
   * half of shoaling (below) re-reads a texture that is ALREADY bound there
   * for the §V.24 tint, so it costs nothing at all.
   *
   * §V.48: read through `seabedHeightLodNode`, at the level this vertex's own
   * SPACING earns. The vertex stage cannot take an implicit-derivative sample
   * in three r180 — every non-fragment read is rewritten to level 0 — so a mip
   * chain alone would leave the rim, where one vertex spans ~13 seabed texels,
   * point-sampling the island heightmap's noise and crawling as the clipmap
   * snaps. `spacing` is the §V.30 LOD law itself, so this fade rides the LOD.
   */
  const shoalDepth = seabed
    ? seabedHeightLodNode(seabed, worldXZ, spacing).negate().max(0)
    : null;
  /**
   * Per-cascade survival fraction, 0..1 — see src/ocean/shoaling.ts for why
   * this is tanh(k·d) and why keying on DEPTH rather than on distance-to-land
   * is what gives the user rough cliffs for free.
   *
   * Without a seabed the factor is the constant 1 and every multiply below
   * folds away at compile time, so an open-ocean scene is bit-identical to
   * what it was before shoaling existed.
   */
  /**
   * §V.73 HOW GROWN THE SEA IS HERE, 0..1 — and the two decisions in this line.
   *
   * IT IS A `varying`, which is why fetch costs the FRAGMENT stage NOTHING.
   * The gain is needed in both stages (the vertex displacement and the shading
   * normals must agree about how much wave is here, exactly as §V.72 requires
   * for shoaling), and bindings are keyed on (node, shaderStage) — so sampling
   * the field in both would have spent the ONE fragment sampler of headroom
   * this material has left. `varying()` forces the sample into the vertex
   * stage and interpolates the scalar across the triangle, so the ledger moves
   * only on the vertex axis, which has twelve spare (§V.40). The residual is
   * the interpolation error of a field the blur has already band-limited to
   * several texels; it is bounded and quoted in the report.
   *
   * ONE SCALAR, NOT THREE GAINS. The development ratio is a property of the
   * PLACE, not of the band — every cascade divides the same number by its own
   * coefficient — so interpolating it carries all three gains for one varying
   * and keeps the per-cascade law where the law lives.
   */
  const fetchRatio = fetch
    ? varying(developmentRatioNode(fetchFieldNode(fetch, worldXZ), uFetchFull))
    : null;
  /**
   * THE ONE PER-CASCADE GAIN, and it must stay one expression.
   *
   * Shoaling (depth: can this wave still stand up here) and fetch (upwind
   * water: was this wave ever built) are disjoint physics and compose as a
   * product. Folding them together HERE rather than at the call sites is what
   * makes the rest of this file correct for free: `dispGain`, the Jacobian the
   * §V.6 foam gate reads, the shading normals and the slope variance all
   * already multiply by `shoal[i]`, so every one of them carries fetch without
   * a second edit and none of them can be forgotten. f62e037 is the cost of
   * the alternative — one consumer summing a differently-modulated sea
   * produced four separate user reports in a day.
   *
   * With neither field wired both factors are the constant 1 and the whole
   * chain folds away at compile time, so an open-ocean scene is bit-identical
   * to what it was before either feature existed.
   */
  const shoal = sim.cascades.map((_, i) => {
    const s = shoalDepth ? shoalFactorNode(uShoalK[i], shoalDepth) : float(1);
    if (!fetchRatio) return s;
    return s.mul(fetchBandGainNode(uFetchC[i], fetchRatio, uFetchMaxGain));
  });

  // vertex displacement: Σ cascades (λDx, h, λDz, J), each Nyquist-gated and
  // each shoaled by its OWN wavelength (§V.72)
  const sampleDisp = (i: number) =>
    texture(sim.cascades[i].displacement, worldXZ.div(sim.cascades[i].domain).fract());
  const d0 = sampleDisp(0);
  const d1 = sampleDisp(1);
  const d2 = sampleDisp(2);
  const dispGain = sim.cascades.map((_, i) => dispLod[i].mul(shoal[i]));
  const rawDisp = d0.xyz
    .mul(dispGain[0])
    .add(d1.xyz.mul(dispGain[1]))
    .add(d2.xyz.mul(dispGain[2]));
  /**
   * THE JACOBIAN CARRIES THE SAME GAIN, and this is a correctness item rather
   * than a look one. `displacement.w` is det J of that cascade's horizontal
   * displacement, ≈1 at rest; scaling the displacement by g scales its
   * gradients by g too, so the deviation from rest scales by g. Leaving it
   * alone would leave the foam gate (§V.6, which reads this sum) firing over a
   * lagoon whose surface has been flattened — white caps on glass.
   *
   * The `1 + Σ(w−1)·g` shape keeps this quantity ≈1 AT REST, which is the
   * convention every downstream reader is calibrated against
   * (`oceanParams.jacobianFoamBias`'s docstring names it explicitly). At gain
   * 1 it is algebraically identical to the `d0.w+d1.w+d2.w−2` it replaces.
   */
  const jacobian = float(1)
    .add(d0.w.sub(1).mul(dispGain[0]))
    .add(d1.w.sub(1).mul(dispGain[1]))
    .add(d2.w.sub(1).mul(dispGain[2]));

  /**
   * §V.72 TERM B — depth-limited breaking, applied to the SUMMED elevation.
   *
   * Exact identity until a wave occupies `shoalBreakerIndex` of the local
   * water column, then saturating to `shoalColumnCeiling` of it, so the sheet
   * can never dig through the sand and flicker a lagoon dry. Measured: it
   * never fires at calm or at swell, at any depth — the shipped seas get pure
   * term A and their look cannot move. See shoaling.ts.
   *
   * `slope` is the clip's own derivative and it is NOT optional: the fragment
   * normals have to carry it or the flat trough bottoms this creates get shaded
   * with the slopes of the wave that was clipped away — a flat sheet wearing a
   * wave's reflections. It is free here (1 − saturation²).
   */
  const clip =
    shoalDepth !== null
      ? breakerClipNodes(rawDisp.y, shoalDepth, uBreaker.x, uBreaker.y)
      : null;
  const totalDisp = clip
    ? vec3(rawDisp.x, clip.clipped, rawDisp.z)
    : rawDisp;

  /**
   * §V.30b: the drawn vertex is the LOD-placed grid point plus the displacement
   * that was sampled AT that same point — one coordinate, never two.
   *
   * THE WAKE IS GEOMETRY NOW (flowfoam/index.ts `wakeHeightNode`, `790e6b2`).
   * Its elevation texture has been written every frame and read by nobody; this
   * is the line that turns it on. Sampled at the UNDISPLACED `worldXZ` like
   * every other field here, per §V.72(a) — `CpuOcean.heightAt` inverts the
   * horizontal displacement to find exactly that grid coord before it sums, so
   * reading at the post-displacement point puts the drawn sea and the floated
   * sea 1–2 m apart horizontally (§B.34 by a third route).
   *
   * NO NYQUIST GATE ON IT, deliberately, and §V.30b does not add one: a gate on
   * vertex spacing cannot be mirrored because spacing is a function of the
   * CAMERA, and §V.8 forbids the floated sea depending on where anyone is
   * looking (slickMath.ts's header states this). What the radial LOD DOES do is
   * move the self-limiting bound that stands in a gate's place — see
   * `radialLodPixels` for the recheck.
   */
  const positionNode = vec3(gridXZ.x, positionLocal.y, gridXZ.y)
    .add(totalDisp)
    .add(flowFoam ? vec3(0, flowFoam.wakeHeightNode(worldXZ), 0) : vec3(0));

  // fragment normal from Σ derivatives: (∂h/∂x, ∂h/∂z, ∂Dx/∂x, ∂Dz/∂z).
  // Normals are per-pixel so they outlive the geometry (normalDetailStretch),
  // then a global far fade turns the last kilometre to glass under the haze.
  // All three cascades are LAYERS of one array texture, so these three calls
  // are ONE texture and ONE sampler in this stage, not three of each (§V.40).
  // Never swap this back to a bare texture() — see sampleCascadeLayer.
  const sampleDeriv = (i: number) =>
    sampleCascadeLayer(
      sim.cascades[i].derivatives,
      worldXZ.div(sim.cascades[i].domain).fract(),
    );
  // smoothstep(e0,e1,x), e0 > e1: 1 inside normalFadeStart, 0 past End
  const normFade = smoothstep(uNormFade.y, uNormFade.x, camDist);

  /**
   * THE SLOPE VARIANCE THIS PIXEL CANNOT SEE — §V.48b's missing half, and the
   * quantity that makes the far sea a rough surface instead of a mirror.
   *
   * `normLod[i]` is the fraction of cascade i's normals this pixel keeps, and
   * `normFade` is the global far cut. So `1 − normLod[i]·normFade` is the
   * fraction that was DELETED, and multiplying it by that cascade's own total
   * slope variance recovers exactly the σ² the fade threw away. Summed across
   * the band-split cascades (§V.19 guarantees no wavelength appears twice, so
   * these add without double-counting) this is the sub-pixel slope variance —
   * analytically, from the Tessendorf spectrum, per cascade.
   *
   * WHY THIS IS NOT A DUPLICATE OF `specularAaStrength`. That term estimates
   * σ² from `dFdx(normalWorld)`: the normal that SURVIVED the fades. It is
   * structurally blind to the band the fades removed, which is the band that
   * matters — the removal is precisely why the surface goes mirror-flat. The
   * two measure disjoint things and are ADDED downstream, not blended.
   *
   * WHY NOT A MIP CHAIN, since §V.48's usual cure is one. Three reasons, all
   * decisive here: the derivative textures are compute-written storage
   * textures and cannot carry mips; §V.19 band-splits the cascades so a mip
   * chain would hold wavelengths no other cascade has, which is the same
   * "cascade pyramid IS the mip chain" fallacy `slopeResolutionFootprint`
   * already documents; and in three r180 `generateTextureGrad` DROPS the array
   * layer index (§V.40), so explicit-gradient sampling of `derivatives` — the
   * usual way to drive a mip level — emits invalid WGSL. The spectrum gives
   * the answer exactly, for three scalar uniforms and no fetch at all.
   *
   * §V.40: ZERO textures, ZERO samplers. §V.44: a sum of non-negative terms,
   * and the consumer clamps it to `specularAaMax`.
   *
   * THE SHOALING FACTOR IS DELIBERATELY ABSENT HERE, and someone will try to
   * "fix" that, so: §V.64 is about SUB-PIXEL variance, where roughness is the
   * correct fate because the detail is still there and the pixel simply cannot
   * resolve it. Shoaled-away slope is not unresolved — the water over a shelf
   * genuinely IS calmer, and there is no missing microfacet distribution to
   * account for. Routing it here would make a glassy lagoon shade as frosted
   * glass, i.e. the exact opposite of the look the calming exists to produce.
   * The energy shoaling removes belongs to the SHORE (runup, swash, breaking),
   * not to the specular lobe — see the note in the foam block below for where
   * that consumer should live and why it is not in this material.
   */
  const cascadeUnresolvedVar = sim.cascades
    .map((_, i) => float(1).sub(normLod[i].mul(normFade)).max(0).mul(uSlopeVar[i]))
    .reduce((a: TslNode, b: TslNode) => a.add(b));
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
    // The two LONG cascades on their own, kept as a var: the churn below warps
    // its phase coordinate by exactly this field, so the warp costs no extra
    // fetch and — because §V.19 band-splits at 8.3 m — carries no wavelength
    // short enough for the churn to alias against.
    // §V.72: the SAME per-cascade shoaling gain the vertex displacement was
    // built with. Geometry and shading have to agree about how much wave is
    // here or the calmed water shades as open sea — and it is the same
    // expression, not a second one, so they cannot drift.
    const derLong = sampleDeriv(0)
      .mul(normLod[0].mul(shoal[0]))
      .add(sampleDeriv(1).mul(normLod[1].mul(shoal[1])))
      .mul(normFade)
      .toVar();
    const der = derLong.add(
      sampleDeriv(2).mul(normLod[2].mul(shoal[2])).mul(wakeSmooth).mul(normFade),
    );
    // the SAME λ the vertex displacement was built with (anti-fold cap
    // applied), pushed per frame — a baked oceanParams.choppiness read here
    // meant the normals solved a different surface than the geometry drew
    // whenever the cap engaged or the slider moved
    const lambda = uChoppiness;
    const denomX = float(1).add(der.z.mul(lambda)).max(0.05);
    const denomZ = float(1).add(der.w.mul(lambda)).max(0.05);
    /**
     * §V.72 TERM B's derivative, on the FFT slope only.
     *
     * The vertex stage clipped the summed elevation; d(clipped)/d(elevation) is
     * therefore the factor its slope was scaled by, and without it the flat
     * trough bottoms the clip creates would be shaded with the slopes of the
     * wave that was clipped away — a flat sheet wearing a wave's reflections.
     * It is exactly 1 wherever the clip is the identity, i.e. everywhere at
     * calm and swell, so this costs the shipped seas nothing.
     *
     * Applied HERE, before the churn and the wake are added: those are separate
     * surface fields riding on top of the water, not part of the wave whose
     * amplitude the breaker limited. (The churn is gated on `slopeMag` below,
     * so it still calms with the sea it rides on.)
     */
    const clipSlope = clip ? clip.slope : float(1);
    const slopeX = der.x.div(denomX).mul(clipSlope).toVar();
    const slopeZ = der.y.div(denomZ).mul(clipSlope).toVar();

    // ── turbulent sub-noise (user, SoT storm reference) ──────────────────
    // Wave faces in the reference are visibly churned, not smooth flanks with
    // foam on top. That detail sits far below vertex spacing (~1 m at the
    // ship) so NO cascade LOD can carry it — it has to live in the slope.
    // Four wavelets at non-commensurate frequencies and golden-angle
    // directions, differentiated analytically (cos of a plane wave), so there
    // are no finite differences and no extra texture fetches. It rides the
    // same Nyquist gate as everything else (§V30): once a wavelet is finer
    // than the pixel footprint it fades instead of sizzling.
    //
    // §V.48 TENTH AND ELEVENTH OCCURRENCES, both in the single expression that
    // used to stand here: one `microFade` = lodWeight(microScale, stretch).
    //  - WRONG QUANTITY. `lodWeight` measures VERTEX spacing (coreSpacing +
    //    k·camDist), the MESH's Nyquist limit and a function of camera distance
    //    alone. These wavelets are a fragment-stage procedural term, and
    //    `pixWorld`'s docstring already warns — twelve lines above the old call
    //    — that distance is not a substitute because a grazing view stretches
    //    the footprint by 1/sin(θ). The §T.39 sunset framing is grazing nearly
    //    everywhere, so the gate was wrong exactly where the user was looking.
    //  - WRONG FEATURE. One gate for the whole stack, measured against
    //    `microScale` = the COARSEST wavelet. Slope goes as k, so the 3.732×
    //    wavelet carries 3.73× more slope than the base it was gated by and
    //    goes sub-pixel 3.73× sooner. §V.48's own rule with the sign flipped,
    //    and §B.20's caulk seam / §B.33's crackle octave for the third time.
    // Each wavelet now fades on ITS OWN wavelength against the PIXEL footprint,
    // and what it loses becomes roughness rather than nothing (§V.48b, below).
    //
    // BUT THE BAND LIMIT IS NOT THE WHOLE JOB, and removing the old gate
    // outright was a REGRESSION (user: "a very very regular grid, no bueno").
    // These are FOUR cosine plane waves at four fixed directions — that is an
    // interference LATTICE by construction, and no per-wavelet Nyquist gate can
    // make a lattice stop being regular. The old `lodWeight` gate was wrong as a
    // band limit (it measured vertex spacing against the coarsest wavelet) but
    // it was also doing a second, unstated job: keeping the lattice confined to
    // the near field, where it reads as churn on a wave face rather than as a
    // weave over the whole sea. Measured, head-on at fov 55: the old gate held
    // the churn to 15 m and killed it by 55 m; the per-wavelet gate alone runs
    // the finest wavelet to 136 m and the base to 507 m — a 9-18× extension of
    // a regular pattern. §V.48b's lesson has a mirror image: a fade can be
    // measured against the wrong thing AND still be load-bearing for the look.
    //
    // So BOTH, with distinct jobs: `microReach` owns HOW FAR the churn goes (an
    // art decision — this is near-field detail by design), each wavelet's own
    // `fade` owns whether it ALIASES inside that reach (§V.48). Neither
    // subsumes the other, and what either one removes still becomes roughness.
    //
    // AND NEITHER OF THEM IS THE LATTICE FIX. The line that used to stand at
    // the wavelet list read "golden-angle directions, irrational-ish frequency
    // ratios: no visible grid" — asserted, never measured, and false. MEASURED
    // (top-down over calm water, sim frozen, the churn isolated by rendering
    // the same tick with `microDetailStrength` 0.35 and 0 and differencing the
    // two): the churn's own contribution carries two spectral spikes 1220× and
    // 308× above the local background of its own radial ring, at
    //   λ 0.623 m, heading (−0.799, −0.602)  →  w3: λ 0.643 m, (−0.809, −0.588)
    //   λ 0.978 m, heading ( 0.707, −0.707)  →  w2: λ 0.994 m, ( 0.707, −0.707)
    // i.e. 0.0° of direction error and 3%/2% of wavelength error against two
    // named wavelets. Not a beat, not a cascade tile (those are 1010/98/22.7 m):
    // the individual plane waves themselves, showing as straight parallel
    // stripes 99° apart, which is the weave the user drew a line along.
    //
    // WHY THE IRRATIONAL RATIOS COULD NEVER HAVE WORKED. They control where the
    // SUM repeats. A single cosine plane wave is already an infinite family of
    // straight parallel lines on its own, at every point of the plane, with no
    // repeat length involved — so no choice of ratios makes any one of them
    // stop being striped. And slope goes as k, so the two SHARPEST wavelets
    // carry 2.41× and 3.73× the slope of the base and dominate what the
    // specular lobe reads, which is why the user sees it in the sun reflections.
    // §B.33's lesson for the second time: a regular field is cured
    // structurally, never by fading it (a fade shrinks the area, and the user
    // reported the same defect after the reach was restored).
    //
    // THE CURE, and it is structural: the wavelets are no longer evaluated at
    // `worldXZ` but at a coordinate WARPED BY THE SWELL'S OWN SLOPE. Straight
    // stripes become wandering ones, because the coordinate they are straight
    // in is itself bent by a field with no period.
    //
    // THE WARP FIELD'S OWN SCALE IS THE WHOLE DESIGN, and getting it wrong is a
    // measured dead end, not a hypothesis. The first version warped by the SWELL
    // slope (`derLong`) alone — free, and physically the right story, since short
    // waves really are strained by the long waves they ride on. It moved the
    // lattice score 344 → 287, i.e. almost nothing, for one reason: §V.19 splits
    // those cascades at λ ≥ 8.3 m, so across a 12 m patch the warp is very nearly
    // a CONSTANT TRANSLATION, and translating a lattice leaves a lattice. A warp
    // only smears a spike if it VARIES over a few wavelengths of the thing it is
    // bending. So the field has to live at metres, not tens of metres.
    //
    // Two terms, and both are wanted:
    //   - value noise at `microDetailWarpScale` (two octaves, the second at an
    //     irrational ratio and rotated, so the noise's own square lattice does
    //     not print through — §B.33's warning, and the reason this is not a
    //     single octave);
    //   - the swell slope, kept because it is free and because it makes the
    //     ripple trains follow the water they sit on rather than ignore it.
    // Phase excursion is what does the work: a warp of A metres along a
    // wavelet's own direction moves its phase by 2π·A/λ, so A = 0.35 m shifts
    // the 0.643 m wavelet by 3.4 rad. Because the warp is a VECTOR and each
    // wavelet projects it onto its own direction, all six decorrelate from one
    // field — no per-wavelet noise evaluation needed.
    const microScale = uMicro.y.max(0.05);
    const microReach = lodWeight(microScale, uNormalStretch);
    const microPhase = timeUniform.mul(uMicro.z);
    // §V.48: this noise never aliases where it can be seen. Its finest octave is
    // microDetailWarpScale/2.19 ≈ 2.3 m, sub-pixel only past a ~1.1 m footprint,
    // while `microReach` has already taken the churn it warps to zero by 55 m
    // (footprint ≈ 0.1 m there). It is also an input to a PHASE, not to an edge:
    // there is no step or threshold anywhere in this path to sharpen it.
    const warpUv = worldXZ.div(uMicroWarpScale.max(0.5));
    // second octave rotated ~31° and at an irrational frequency ratio, so the
    // two octaves' lattices never line up into one visible grid
    const warpUv2 = vec2(
      warpUv.x.mul(0.857).sub(warpUv.y.mul(0.515)),
      warpUv.x.mul(0.515).add(warpUv.y.mul(0.857)),
    ).mul(2.19);
    const warpNoise = vec2(
      valueNoise(warpUv).sub(0.5).add(valueNoise(warpUv2).sub(0.5).mul(0.5)),
      valueNoise(warpUv.add(vec2(37.3, 11.7)))
        .sub(0.5)
        .add(valueNoise(warpUv2.add(vec2(19.1, 43.9))).sub(0.5).mul(0.5)),
    ).mul(1.333); // ×1.333 so the two octaves span ±0.5 again, i.e. ±1 peak-to-peak
    const microXZ = worldXZ
      .add(warpNoise.mul(uMicroWarp))
      .add(derLong.xy.mul(uMicroWarp))
      .toVar();
    /**
     * Worst-case local frequency gain from that warp. The warped coordinate has
     * Jacobian I + ∇W, so a wavelength is locally COMPRESSED by up to |∇W|, and
     * the band limit below must be measured against the shortest wavelength that
     * can produce — §V.48's own rule ("the sharpest feature, never the repeat")
     * applied to a feature whose width is now a field rather than a constant.
     * Bound, per unit of `microDetailWarp`: the noise term contributes at most
     * 2π/(2.3 m) · 0.5 ≈ 1.37/m from its finest octave, the swell term at most
     * 0.5·2π/8.3 ≈ 0.38/m (§V.19 splits cascades 0-1 at λ ≥ 8.3 m and their
     * slope RMS stays ≲ 0.5 even at storm). The noise bound scales with
     * 1/warpScale, so it is computed rather than baked.
     */
    const warpGrad = uMicroWarp.mul(
      float(2 * Math.PI * 2.19 * 0.5)
        .div(uMicroWarpScale.max(0.5))
        .add(0.38),
    );
    const warpSqueeze = float(1).div(float(1).add(warpGrad));
    /** unresolved slope variance shed by the wavelets, in (microGain)² units */
    const microUnresolvedRaw = float(0).toVar();
    const wavelet = (dirX: number, dirZ: number, freqMul: number, phaseMul: number) => {
      const k = float(Math.PI * 2 * freqMul).div(microScale);
      // this wavelet's own wavelength — NOT microScale (§V.48: the sharpest
      // feature, never the repeat) — and shortened by whatever the warp can do
      // to it, so the gate still leads the aliasing rather than trailing it
      const lambda = microScale.div(freqMul).mul(warpSqueeze);
      // smoothstep(e0,e1,x), e0 > e1: 1 while a wavelength spans
      // microDetailSamplesFull pixels, 0 at 2 (Nyquist — a math constant, not
      // a tunable). Measured against fwidth(worldXZ), so grazing is included.
      // ×microReach: the envelope is folded in HERE, not applied to the sum, so
      // `microUnresolvedRaw` below sees the total fade and hands the roughness
      // everything removed — by the reach as well as by Nyquist. Applying the
      // envelope outside would silently reintroduce the mirror this fix removes.
      //
      // Nyquist half: 1 while a wavelength spans microDetailSamplesFull pixels,
      // 0 at 2. Measured against pixWorld = fwidth(worldXZ), so grazing counts.
      const fade = smoothstep(
        lambda.mul(0.5),
        lambda.div(uMicroSamples.max(2.001)),
        pixWorld,
      ).mul(microReach);
      // EQUAL SLOPE PER WAVELET, not equal height. `amp` ∝ 1/freqMul, so every
      // wavelet contributes the same slope amplitude k·amp and none of them can
      // dominate the sum the way w3 did (3.73× the base, and the loudest term
      // was also the finest and therefore the first to alias — §V.48 with the
      // sign flipped once more). It is also the physical shape: a wind-wave
      // spectrum carries roughly constant slope variance per octave, not
      // constant height.
      const amp = float(MICRO_AMP_SCALE / freqMul);
      const kAmp = k.mul(amp);
      const arg = microXZ.x
        .mul(dirX)
        .add(microXZ.y.mul(dirZ))
        .mul(k)
        .add(microPhase.mul(phaseMul));
      const d = arg.cos().mul(kAmp).mul(fade);
      // §V.48b: a sinusoid of slope amplitude k·amp has slope variance
      // (k·amp)²/2, and the share this pixel can no longer resolve is (1 − fade)
      // of it. Handed to the specular lobe instead of being dropped on the
      // floor — this is the §V.64 path, and it must see the new amplitudes or
      // the roughness handover silently under-reports.
      microUnresolvedRaw.addAssign(float(1).sub(fade).mul(kAmp).mul(kAmp).mul(0.5));
      return { x: d.mul(dirX), z: d.mul(dirZ) };
    };
    const w = MICRO_WAVELETS.map((q) => wavelet(q[0], q[1], q[2], q[3]));
    const microSumX = w.map((q) => q.x).reduce((a: TslNode, b: TslNode) => a.add(b));
    const microSumZ = w.map((q) => q.z).reduce((a: TslNode, b: TslNode) => a.add(b));
    const microAmp = uMicro.x.mul(microScale).mul(0.02);
    // gate to wave FACES: troughs stay comparatively calm, flanks churn.
    // Captured BEFORE the churn is added — this is the swell's own steepness,
    // and the foam gates downstream want that, not the churn's contribution.
    const slopeMag = slopeX.mul(slopeX).add(slopeZ.mul(slopeZ)).sqrt().toVar();
    const faceGate = smoothstep(float(0), uMicro.w.max(0.02), slopeMag);
    const microGain = microAmp.mul(faceGate).mul(wakeSmooth);
    slopeX.addAssign(microSumX.mul(microGain));
    slopeZ.addAssign(microSumZ.mul(microGain));
    // amplitude scales the wavelets, so it scales their variance SQUARED
    const microUnresolvedVar = microUnresolvedRaw.mul(microGain).mul(microGain);

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
      microUnresolvedVar,
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
    const { wakeSmooth, microUnresolvedVar, normalWorld } = buildSurfaceSlope();

    // ── how much ATMOSPHERE is in the way (§V30) ────────────────────────
    // Hoisted: three terms want this exact ramp — the far-field foam damp, the
    // final haze mix, and the §V.56 handover below — and it costs a `pow`.
    // It used to be computed twice with the same arguments.
    const hazeRamp = pow(smoothstep(uHaze.x, uHaze.y, camDist), uHazeCurve).clamp(0, 1);
    const hazeT = hazeRamp.mul(uHazeStrength).clamp(0, 1).toVar();
    /**
     * §V.56 HANDOVER: the pigment floor protects WATER, never ATMOSPHERE.
     * Both §V.56 levers are scaled by this. Where a pixel has melted into the
     * distance haze it is no longer a water surface — it is the air in front of
     * one — and re-tinting it toward the sea's body colour is what painted the
     * horizon as a solid turquoise band (user, 3rd report). The far field is
     * supposed to read as HAZE: that is what makes the sea look like it goes
     * somewhere (§V.30) instead of ending in a coloured wall.
     */
    const waterness = float(1).sub(hazeT);
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
    // are coherent.
    // Blinn-Phong form of α'² = α² + 2σ²  ⟹  p' = p / (1 + p·σ²), and the
    // peak scales by p'/p so the lobe's ENERGY is conserved: the glint road
    // (low variance, coherent) survives at full brightness while isolated
    // pixel-sized sparkles are spread back into the average they should have
    // been. §V.44: σ² is a sum of squares (≥0) and is capped, so `gain` ∈ (0,1]
    // and no term can grow.
    //
    // TWO DISJOINT ESTIMATORS OF σ², ADDED. Getting this wrong is why the
    // screen-space term alone never finished the job however hard it was tuned:
    //  (a) SCREEN-SPACE, `dFdx(normalWorld)`. Sees the noise still present in
    //      the sampled normal. This is the Kaplanyan/Tokuyoshi form, chosen
    //      over Toksvig because there is no authored normal map to mip — which
    //      was and remains correct about the MECHANISM.
    //  (b) SPECTRAL, `unresolvedVar`. Sees the variance the LOD fades ALREADY
    //      DELETED — which (a) cannot see by construction, because (a) only
    //      ever measures the normal that survived. That deleted band is
    //      exactly why the far sea flattens into a mirror (normLod's own
    //      measurement: slope RMS exactly zero past 365 m), and a grazing
    //      mirror is maximally sensitive to whatever residual normal is left.
    // Toksvig's INPUT (a mipped normal map) is absent here; Toksvig's IDEA —
    // variance becomes roughness — is what (b) restores, with the Tessendorf
    // spectrum standing in for the mip chain and beating it, since it is exact
    // rather than a one-sample estimate and costs no fetch at all (§V.40).
    const nDx = dFdx(normalWorld);
    const nDy = dFdy(normalWorld);
    const unresolvedVar = cascadeUnresolvedVar.add(microUnresolvedVar).max(0);
    const normalVar = nDx
      .dot(nDx)
      .add(nDy.dot(nDy))
      .mul(uSpecAA.x)
      .add(unresolvedVar.mul(uSlopeVarAa))
      .clamp(0, uSpecAA.y.max(1e-5));

    /**
     * ── §V.48b THE ONE σ² EVERY SUN TERM USES, and the double count it ends ──
     *
     * MEASURED DEFECT (user, tod 15.0, deck framing: "the sun is still
     * reflecting bright blue in the ocean"). Screenshot A/B at that framing,
     * scene-linear, post bypassed: killing `glintRoadStrength` AND
     * `sparkleStrength` removes the entire pale blue-white wash over the
     * sun-ward half of the sea; road alone reproduces it; sparkle alone is
     * invisible. So the wash is the ROAD.
     *
     * WHY THE ROAD WASHES. `glintVar` used to be `normalVar` — the sum of the
     * SPECTRAL sub-pixel variance and `specularAaStrength × dFdx(N)`. The dFdx
     * half is not a variance: over a footprint spanning many wavelengths a
     * finite difference saturates at the full normal swing whatever the
     * footprint, and `specularAaMax`'s own docstring measures it at σ² =
     * 0.41–2.56 against a sea whose ENTIRE mean square slope is 0.0273, i.e.
     * 15–94× too large. It therefore pinned `normalVar` at its cap everywhere,
     * and `.min(seaSlopeVar)` then pinned σ² at the sea's TOTAL slope variance
     * at every pixel — including the near field, where the shading normal
     * already carries every one of those facets geometrically. The sea's slope
     * was counted twice: once as real wave facets through N·H, and again as a
     * statistical lobe of the same width laid on top.
     *
     * WHAT THAT LOOKS LIKE, evaluated from these very expressions (flat water,
     * camera 8 m, sun 43.1°, radiance of the road by ground distance):
     *
     *   σ² = 0.0273 (the old pin)  8m 0.18  20m 0.18  50m 0.084  150m 0.050
     *                              300m 0.043  3km 0.037   ← never reaches zero
     *   σ² = 0.003  (Cox & Munk)   8m 1.50  12m 0.27  20m 0.000  and beyond
     *
     * The pinned lobe is not a road at all: it is a flat 0.04–0.22 pedestal of
     * sunlight laid over the whole sea to the horizon, because the Smith 1/(N·V)
     * grows at grazing at very nearly the rate the Beckmann exponential decays
     * and the two cancel. An angularly unselective sheen over everything is the
     * definition of plastic, and added to a body measured at warmth
     * (r−b)/max = −0.78 it reads as exactly what the user shot: bright blue.
     * At a 5.8° sun the same code gives 12.6 at 50 m and 29 at 150 m — a real
     * road — which is why the rebuild validated at sunset and failed at 15.0.
     *
     * THE FIX IS THE QUANTITY, NOT A NUMBER. σ² for a microfacet lobe is by
     * definition the slope the shading normal does NOT already carry, and this
     * material already computes it exactly: `unresolvedVar`, from the
     * Tessendorf spectrum, per cascade, plus the churn's own faded-out share
     * (§V.64). Floored at Cox & Munk's zero-wind intercept, ceilinged at the
     * sea's own summed (shoaled) slope variance, because a patch of water
     * cannot be rougher than the sea it is part of. Near the camera it now
     * falls to the floor and the sun becomes a tight broken glitter path; far
     * out it rises to the ceiling and the lobe broadens into the statistical
     * road — the §V.48b handover, doing the job it was written for.
     *
     * §Rule 8 — WHAT THIS COMMIT DOES AND DOES NOT DO. The composition below is
     * unchanged: `glintVar` is still `normalVar` clamped into
     * [Cox-Munk, seaSlopeVar]. What changed is that it is BUILT HERE, beside
     * the variance it is made of, and that `widen()` — the sparkle and the
     * glint train — now reads it instead of reading the raw, unceilinged
     * `normalVar`. That half is arithmetic, not taste: 40·1.0 = 41 against
     * 40·0.0273 = 2.1, and 1.0 is 37× the sea's entire mean square slope.
     *
     * The dFdx half is left IN, behind its existing knob, because removing it
     * is a change to the sun's appearance that only the browser can sign off
     * and this session could not hold a stable WebGPU context long enough to
     * do it. `specularAaStrength = 0` collapses `normalVar` to the exact
     * spectral quantity and is therefore the whole experiment, live, on one
     * uniform, with no rebuild — run it at tod 15.0 from the deck before
     * changing anything here.
     */
    const seaSlopeVar = uSlopeVar
      .map((v, i) => v.mul(shoal[i]).mul(shoal[i]))
      .reduce((a: TslNode, b: TslNode) => a.add(b))
      .add(microUnresolvedVar)
      .max(COX_MUNK_CALM_SLOPE_VAR);
    const glintVar = normalVar.max(COX_MUNK_CALM_SLOPE_VAR).min(seaSlopeVar).toVar();

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
    // vec3, not a scalar: Beer–Lambert PER CHANNEL (see `uAbsorption`). Red is
    // gone by ~4 m while blue is still 90% alive, and that DIFFERENCE is what
    // reads as water rather than as a grey veil over a photograph.
    // vec3 on the left, matching causticsNode/waterLighting's
    // `absorption.mul(path)` — same expression, same units, so the above-water
    // and below-water halves of the sea visibly agree.
    const seeThrough = uAbsorption
      .mul(thicknessMeters)
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
    //
    // AND DO NOT MULTIPLY `sceneCol` BY `shadowMask`. It looks like the obvious
    // way to "put the ship's shadow on the sea floor" and it is wrong twice
    // over. The floor is real geometry with `receiveShadow` (island terrain,
    // MeshStandardNodeMaterial), so the shadow is ALREADY in the scene colour
    // this samples — sampled at the FLOOR's own world position, which is where
    // it belongs. `shadowMask` here is the shadow at the WATER SURFACE, a
    // different point entirely; the two are separated by refraction and by the
    // depth of the column, and that separation is a large part of what sells
    // the water as a volume. Multiplying them would double-darken the floor AND
    // stamp the surface's shadow onto it in the wrong place.
    // The asymmetry three lines below is therefore DELIBERATE and load-bearing:
    //   `waterCol` is shadowed (it is the body's own scattered sunlight),
    //   `sceneCol` is NOT   (it carries its own shadow already),
    //   `reflCol`  is NEVER (the sky dome is not blocked by the ship).
    // It will read as an inconsistency to the next person through here. It is
    // not one.

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
    // A HUMP, not a rising ramp. Pigment influence must be LOW near (§V.24
    // shows the body through the surface, so it needs no help and forcing it
    // read as over-saturated teal), HIGH in the mid-field (entirely grazing,
    // nothing transmits, the pixel is pure reflected sky and greys out), and
    // LOW again far away (atmosphere owns it — see `waterness`). Shipping the
    // rising half alone is what turned the horizon turquoise.
    const grazSat = mix(
      uGrazingSat.x,
      uGrazingSat.y,
      smoothstep(float(0), uGrazingSat.z.max(1), camDist),
    ).mul(waterness);
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
          // §V.26 sub-pixel roughness: the mirror needs to know what one water
          // pixel actually COVERS. Same footprint every band-limit in this
          // file is measured against, so both owners agree by construction.
          footprint: pixWorld,
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
    // per-channel mix: `seeThrough` is a vec3, so the floor comes through the
    // column already reddened-out and blue-shifted. No separate tint — the
    // curve IS the tint (see `uAbsorption`).
    const transmitted = mix(waterCol, sceneCol, seeThrough.mul(0.9));
    // §V.24 forbids "opaque-wall water @ grazing/shallow view", and Schlick
    // alone produces exactly that: F→1 deletes the submerged geometry. Cap the
    // mirror in proportion to `seeThrough`, so the floor exists ONLY where
    // there is something submerged to see. Open water has nothing behind it
    // (thickness → ∞ ⟹ seeThrough → 0), so the grazing sunset sea keeps its
    // full physical Fresnel mirror and §T.39 is untouched.
    //
    // `.g` AND NOT A PER-CHANNEL CAP. The tempting "consistent" refactor once
    // `seeThrough` went vec3 is to let this weight go vec3 too. Don't: Fresnel
    // is an INTERFACE property — the fraction of energy the air/water boundary
    // reflects — and at n = 1.333 it is flat across the visible band. Only the
    // VOLUME behind the interface is dispersive. A per-channel cap would let
    // blue (which survives 10 m of water) hold the mirror open while red (dead
    // at 4 m) let it close, so the reflected sky would be split into coloured
    // fringes that no physical water surface produces — chromatic aberration
    // invented at the wrong boundary.
    // Green, not max(): max is blue in all but zero-depth water, and blue is
    // the near-transparent channel, so it would peg the cap wide open and
    // effectively delete the mirror in any shallows. Green is the middle
    // coefficient and it is the channel the turquoise read actually rides.
    const reflWeight = fresnel
      .mul(uReflStrength)
      .min(float(1).sub(uTransmitFloor.clamp(0, 0.9).mul(seeThrough.g)))
      .clamp(0, 1);
    const col = mix(transmitted, reflCol, reflWeight).toVar();

    // §V.6 foam: progressive-blur sim mask (T5) with crest→soft detail
    // blend; §V.10 wake/intersection foam (T13) combines via max — foam is
    // foam, whichever system shed it. Falls back to raw jacobian threshold
    // when no sim is wired.
    // far-field foam damping rides the same distance ramp as the haze (both
    // are "how much atmosphere is in the way"), computed early because the
    // foam composite happens before the haze mix
    const foamGain = mix(float(1), uFoamFarDamp, hazeRamp);
    const foamAmount = float(0).toVar();
    if (foam || flowFoam) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node union
      let foamMask: any = float(0);
      // §B THE WAVE CARVES THE FOAM. The foam shading used to consult nothing
      // about the surface it sits on, so it read as a decal (user: the layers
      // are "not properly … decimated by the tips of the wave"). This hands
      // over the local elevation IN UNITS OF THE SEA'S OWN RMS — the same
      // quantity `crestMask` above is built from, and free here because both
      // halves are already in this stage. NOT det J: that is the honest
      // stretch signal (§V.58) but it lives in the displacement textures,
      // which are bound in the VERTEX stage only, and §V.72 records that the
      // contested spare is a FRAGMENT spare.
      const surfaceLift = totalDisp.y.div(sigma);
      // §T.42 FOAM'S OWN NORMAL. `src/foam/foamShading` finite-differences the
      // foam alpha it has already built, from two extra taps of the art
      // texture it has already bound (no new binding, no new sampler, §V.40),
      // and hands back the world-XZ tilt. It is an OUT-PARAM so the mask this
      // block composites is the same scalar expression it always was —
      // `foamAmount`, and therefore coverage, cannot move. See foamShading for
      // the gain-aware band limit and for why there is no Phong lobe.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node
      const foamRelief: { slope?: any } = {};
      if (foam) foamMask = foam.shadingNode(worldXZ, surfaceLift, foamRelief);
      // §V.10 THE WAKE IS NOT A WHITECAP, and it is kept on its own mask all
      // the way to the composite for that reason. It used to be `max`ed into
      // the whitecap mask on the line it was built, which forced two different
      // materials through one colour: sea-spray white (#eef6f2, linear
      // luminance 0.905) for water that is actually aerated green churn beside
      // a wooden hull. Two user reports came out of that single merge — "too
      // white… depending on the sun angle it's too much" (that luminance sits
      // within a few percent of the bloom threshold at every sky colour) and
      // "too solid white… should only do that on the leading edges".
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node union
      let wakeAlpha: any = float(0);
      if (flowFoam) {
        // wake foam runs through the same crackle/mottle detail blend but
        // slightly damped — bow/stern trails read softer than whitecaps
        const wakeMask = foamDetailMask(
          flowFoam.foamSampleNode(worldXZ).clamp(0, 1),
          worldXZ,
        );
        // OPTICAL DEPTH, not a hard alpha (§B, the sim-foam lesson): a straight
        // mask saturates, so every texel the wake covers reached full opacity
        // and the track rendered as one flat sheet with breakup holes punched
        // through it instead of water thinning astern. 1 − e^(−density·cov)
        // approaches 1 without ever reaching it, so coverage goes on modulating
        // brightness across its whole range and the leading edges — where
        // coverage genuinely is highest — are the only places that read solid.
        wakeAlpha = wakeMask
          .mul(0.85)
          .mul(uWakeFoamDepth)
          .negate()
          .exp()
          .oneMinus()
          .clamp(0, 1);
      }
      // foam sits in the same light as the water (wrap floor+gain). Scalar
      // light only — sunTint here would double the warm tint (foamTintNode
      // already warms it) and low-alpha foam went beige-brown on deep teal.
      // THE INTERIM PER-PIXEL CREST GATE WAS DELETED HERE (§B).
      //
      // It existed for one stated reason — "the foam sim owns real whitecap
      // injection; at normal swell it currently produces nothing, so the sea
      // reads synthetic" — and it combined by `max`, so it was a SECOND,
      // INDEPENDENT foam source layered over the sim's. Both halves of its
      // premise are now gone:
      //
      //  · THE SIM PRODUCES FOAM. Measured on the real spectrum at the default
      //    swell preset, the sim covers 1.70% of the sea against Monahan &
      //    O'Muircheartaigh 1980's ~4% for that wind — the right order, not
      //    nothing. This gate carried 12.0% of the visible foam mass there and
      //    1.9% at storm, and won the `max` on 1.3% of the sea.
      //  · A BARE CALM SEA IS CORRECT (user: "if it's rather calm then I think
      //    it's fine that there's no foam"). At calm the sim correctly produces
      //    0.00% and this gate was the ONLY foam on the water — 0.57% coverage
      //    of exactly the whitecaps the user says should not be there.
      //
      // And its own comment recorded the user rejecting its output twice ("too
      // long, too white, too thick, too regular, too big — like a milk cut"),
      // diagnosing the cause correctly as a smooth gate on a smooth field
      // whose super-level set is one unbroken ribbon per crest line. That is
      // not tunable: it is what a threshold on a band-limited field IS. The
      // sim reaches the same place with an accumulator, a fold metric that
      // knows the crest axis, and a breakup field — see src/foam/foamMath.
      //
      // DO NOT REINTRODUCE A SECOND FOAM SOURCE HERE. If the sea looks bare,
      // the knob is the sim's gate (`oceanParams.jacobianFoamBias`) or its
      // strength (`foamParams.injectStrength`), both of which keep the shape,
      // the placement and the two-clock intensity the sim spent four commits
      // earning. `max`-ing a smooth ribbon over that can only degrade it.
      //
      // §V.72 TOOK THAT RULING AND OBEYED IT, which is worth recording because
      // the obvious next feature lands right here. Shoaling removes wave
      // energy near shore, and the honest place for that energy is
      // whitewater — so a "shore break" term keyed on `breakerSaturation`
      // (shoaling.ts) is the natural §V.64 accounting, and it would cost ZERO
      // bindings because the seabed texture is already bound in this stage.
      // It is deliberately NOT built, because it would be exactly the thing
      // this block forbids: a smooth gate on a smooth field, whose super-level
      // set is one unbroken ribbon — here following a DEPTH CONTOUR, i.e. a
      // painted ring around every island. The shape problem is not tunable.
      // If shore break is wanted, it belongs in src/foam, where the
      // accumulator, the fold metric and the breakup field already exist to
      // turn an injection rate into broken caps; the seabed depth would have
      // to reach that compute pass. Until then the shoaled sea simply sheds
      // less foam, which is at least honest about the geometry it is drawing.
      // foam takes the sky's colour — the reference's foam is warm cream, not
      // the cool near-white it is authored as, and against a warm sunset sky a
      // cool white foam reads wrong even once coverage is right
      const foamBase = mix(uFoam, uHazeColor, uFoamSkyTint.clamp(0, 1));
      // §T.42 — FOAM IS LIT BY ITS OWN NORMAL, not by the water's. Foam
      // composited as albedo over a shared normal is the mechanical cause of
      // "slapped on top": every pixel of a cap took the same N·L as the water
      // under it, so the cap had no interior shading at all and read as a flat
      // decal however torn its outline was. `foamRelief.slope` is the tilt the
      // dissolve's OWN silhouette implies (built in foamShading from taps it
      // already had), so a cap now has a lit side and a shaded side that follow
      // its lace. Water-side terms are untouched: this normal is used for the
      // foam's diffuse and nothing else, and never for the specular, the
      // reflection or the slope variance.
      const foamNdl = foamRelief.slope
        ? normalize(vec3(
            normalWorld.x.add(foamRelief.slope.x),
            normalWorld.y,
            normalWorld.z.add(foamRelief.slope.y),
          )).dot(sunDirectionUniform).max(0)
        : ndl;
      const foamCol = foamBase
        .mul(foamTintNode())
        .mul(foamNdl.mul(uLightGain.mul(0.6)).mul(shade).add(uLightFloor.add(0.1)));
      // whitecaps first, then the wake over them in ITS own colour. Two
      // composites rather than one over a `max`, which is what lets the two
      // carry different materials; `foamAmount` still reports the union so the
      // pigment floor and the underwater tint below see all the foam there is.
      const whitecapAmount = foamMask.clamp(0, 1).mul(0.9).mul(foamGain);
      col.assign(mix(col, foamCol, whitecapAmount));
      const wakeCol = uWakeFoam
        .mul(foamTintNode())
        .mul(ndl.mul(uLightGain.mul(0.6)).mul(shade).add(uLightFloor.add(0.1)));
      const wakeAmount = wakeAlpha.mul(foamGain);
      col.assign(mix(col, wakeCol, wakeAmount));
      foamAmount.assign(whitecapAmount.max(wakeAmount).clamp(0, 1));
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
      // §V.56 handover — see `waterness`. Without this the floor fires on the
      // warm, low-chroma horizon haze (a legitimately lit atmosphere, not a
      // grey wash) and repaints the whole band in the water's hue.
      .mul(waterness)
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
    // Widened exponent + energy-conserving peak for one lobe. Driven by
    // `glintVar` — the SAME physically-ceilinged σ² the road's Beckmann lobe
    // takes — and not by the raw `normalVar` it used to read. `normalVar` is
    // capped at `specularAaMax` (1.0 = RMS slope 45°), i.e. 37× the entire
    // sea's mean square slope, so `sparkWiden` = 1 + 40·σ² reached 41: the
    // sparkle was divided by 41 and its exponent collapsed from 40 to 0.98,
    // which is a shapeless wash rather than a glint. Worse, the dFdx half is
    // DISTANCE-DEPENDENT, so the division swung between ~41 near the camera
    // and ~1.1 once the churn's own LOD fade had removed the high-frequency
    // normals — the sparkle and the surface detail were anti-correlated across
    // that boundary by construction (user: "wherever the high-detail noise is
    // visible, we don't see the sparkle"). Bounded by the sea's own slope
    // variance the factor spans 1.0–2.1 instead of 1–41, and it varies with
    // the SPECTRUM rather than with a screen-space estimator, so there is no
    // boundary for it to flip across.
    const widen = (p: TslNode) => float(1).add(float(p).mul(glintVar));
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
    const cellUv = worldXZ.div(cellSize);
    const cell = cellUv.floor();
    // These `.fract()`s are a HASH of an INTEGER cell index, not an edge on a
    // spatially-varying coordinate: within a cell they are constant, so they
    // have no gradient to alias. What CAN alias is the cell LATTICE, and that is
    // band-limited where it is built (`cellSize` from `pixWorld`, above) and
    // dissolved into its own mean by `resolvable` below.
    // @band-limited-elsewhere — hash of an integer lattice index, no gradient
    const sparkleHash = cell.dot(vec2(127.1, 311.7)).sin().mul(43758.5453).fract();
    const phase = cell.dot(vec2(269.5, 183.3)).sin().mul(19741.77).fract();
    const wobble = phase.mul(6.28).add(timeUniform.mul(0.9)).sin().mul(0.05);
    // density threshold: sparse outside the sun path, dense inside it
    const thr = mix(uSparkleDensity.x, uSparkleDensity.y, glintTrain);
    const twinkle = smoothstep(thr, thr.add(0.012), sparkleHash.add(wobble));

    /**
     * A GLINT IS A POINT, NOT A CELL (user: "sparkles are little squares").
     *
     * `twinkle` above is a per-cell binary: one hash, a 0.012-wide transition
     * on a uniform variate, i.e. on or off over a world-locked axis-aligned
     * SQUARE. That is the white blocks in the screenshot at the coarse end of
     * the octave quantisation (~2.6 px) and a per-pixel random binary field at
     * the fine end (~1.3 px) — and since it rides `normFade` out to 4.2 km it
     * is also a large part of the "noisy in the distance" report. One defect,
     * two symptoms.
     *
     * §V.48's cure, both halves, exactly as §B.20 and §B.33 had to learn it:
     *
     * (a) SHAPE. Hash the glint to a POSITION inside its cell and give it a
     *     radial falloff whose radius is expressed in PIXELS against the
     *     footprint. Round, sub-pixel-placeable, and band-limited by
     *     construction instead of by a distance fade. The point is inset by its
     *     own radius so the disc can never be clipped by its cell border, which
     *     would put the lattice straight back; when the cell is too small to
     *     hold it the inset saturates and the point sits at the centre — which
     *     is precisely when (b) has already dissolved it.
     *
     * (b) MEAN. (a) alone still leaves a per-cell coin flip, just with a round
     *     outline instead of a square one. So as the cell stops being able to
     *     hold a distinguishable point, BOTH binary terms fade to their own
     *     expectations: the disc to its coverage (½πr²/c², the average the
     *     pixel should have seen) and the on/off hash to its probability
     *     (1 − thr). The two branches have EQUAL MEAN by construction, so
     *     energy is continuous across the whole crossfade — the sun path keeps
     *     its brightness and simply stops being made of dots. This is what lets
     *     the fix preserve the detail instead of blurring it away.
     */
    const cellPix = cellSize.div(pixWorld).max(0.25);
    /**
     * §V.48b, AND THE RING THE USER DREW A LINE ALONG. `radPix` used to be the
     * raw `sparkleRadiusPixels` — a CONSTANT screen radius against a cell whose
     * screen size is a SAWTOOTH.
     *
     * `cellSize` is quantised to octaves (`exp2(log2(cellTarget).floor())`) so
     * the lattice stays world-locked inside a band; the price is that
     * `cellPix = cellSize / pixWorld` ramps 2.60 → 1.30 across an octave of
     * footprint and then jumps straight back to 2.60. Both of this term's
     * band-limit quantities are functions of it, so both inherited the jump.
     * Evaluated over six octaves of `pixWorld`, inside the sun path:
     *
     *   cellPix   coverage   resolvable   mean(sparkleField)
     *     2.48      0.163       0.575          0.0294     ← 57% discrete points
     *     1.97      0.259       0.135          0.0467
     *     1.56      0.412       0.000          0.0741     ← flat wash, no points
     *   (then cellSize doubles and it snaps back to the first row)
     *
     * i.e. a HARD 2.52× step in the term's own mean at every doubling of the
     * footprint, and `resolvable` sweeping 0.575 → 0 across the same span, so
     * the band alternates "dimmer and made of points" with "brighter and
     * featureless" and steps between them. That is the report exactly: hard
     * edges at visibility ranges, the fine detail present on one side and gone
     * on the other, and the sparkle showing up precisely where the detail
     * went. §V.48b says a band-limited term must retire into its OWN MEAN —
     * this one did, but its mean was itself discontinuous in distance, so the
     * crossfade was mean-preserving across the `mix` and not across the ring.
     *
     * THE CURE, and it is the cheap half of the two available. Size the glint
     * as a fixed FRACTION of its cell instead of a fixed number of pixels:
     * `coverage` = π/2·(rad/cell)² and `cellPix/radPix` = `sparkleCellPixels /
     * sparkleRadiusPixels` both become octave-invariant, so both
     * discontinuities go at once and at zero cost. The disc's screen radius
     * now breathes 0.40–0.80 px across an octave instead of sitting at 0.80 —
     * a CONTINUOUS variation, and sub-pixel at both ends, so it cannot alias.
     * (The other cure is an inter-octave crossfade of the whole cell field,
     * which is a second hash set and a second disc for the same result.)
     *
     * `sparkleRadiusPixels` keeps its meaning at the top of an octave, which is
     * where it was authored, so the shipped look is anchored where it was tuned.
     */
    const radPix = cellPix
      .mul(uSparkleShape.x.max(0.25).div(uSparkleCell.x.max(0.5)))
      .max(0.05);
    // Same class as `sparkleHash`: a hash of an integer cell index, constant
    // within the cell. It picks WHERE the glint sits; the glint's own extent is
    // `radPix`, sized in pixels against the footprint.
    // @band-limited-elsewhere — hash of an integer lattice index, no gradient
    const jx = cell.add(vec2(0.37, 0.11)).dot(vec2(419.2, 371.9)).sin().mul(29831.3).fract();
    const jz = cell.add(vec2(0.71, 0.53)).dot(vec2(213.7, 157.3)).sin().mul(17635.9).fract();
    const inset = radPix.div(cellPix).min(0.5);
    const jitter = vec2(jx, jz).mul(float(1).sub(inset.mul(2))).add(inset);
    const distPix = cellUv.sub(cell).sub(jitter).mul(cellPix).length();
    // smoothstep(e0,e1,x) with e0 > e1: 1 at the point, 0 at the radius (§V23).
    // Both operands are in PIXELS: `distPix` comes through `cellPix`, which is
    // cellSize / pixWorld, and pixWorld is `fwidth(worldXZ)` (module scope, the
    // same footprint every band limit in this file is measured against). This
    // is the band limit itself, not an edge that still needs one.
    const disc = smoothstep(radPix, float(0), distPix);
    // the disc's own mean over its cell (½ for the smoothstep profile), and the
    // hash's own mean — the two values (b) fades to
    const coverage = radPix
      .mul(radPix)
      .mul(Math.PI * 0.5)
      .div(cellPix.mul(cellPix).max(1e-4))
      .clamp(0, 1);
    const onProb = float(1).sub(thr).clamp(0, 1);
    // smoothstep(e0,e1,x) ascending: 0 while the cell is under `resolveCells`
    // radii across (no room for a distinguishable point), 1 past twice that.
    // Also the band limit rather than a thing needing one — `cellPix` is
    // cellSize / pixWorld, and pixWorld is `fwidth(worldXZ)` at module scope.
    const resolvable = smoothstep(
      uSparkleShape.y,
      uSparkleShape.y.mul(2),
      cellPix.div(radPix),
    );
    const sparkleField = mix(onProb.mul(coverage), twinkle.mul(disc), resolvable);
    // straight-down views turn the whole field into starfield noise — fade
    // sparkles out as the view leaves grazing angles.
    // smoothstep(e0,e1,x), e0 > e1: 1 below grazeStart, 0 above grazeEnd
    const grazeFade = smoothstep(uGraze.y, uGraze.x, viewDir.y);
    /**
     * ── §V.75 THE SUN'S REFLECTION, AS ENERGY ──────────────────────────
     *
     * What stood here was `pow(N·H, 180)/widen · 0.55`. Its PEAK radiance is
     * `glintRoadStrength / widen`, and `widen` = 1 + 180·σ² reaches ~180 at the
     * §T.39 sunset framing, so the brightest pixel the sun could put on this
     * water was 0.003 — while the reflected sky, three hundred lines up, is
     * delivering ~0.1 over the whole frame. MEASURED at the lagoon, tod 17.6,
     * sun 5.8°, camera 7 m, mean water luminance over a mid-field band:
     *
     *     baseline                                     93
     *     sparkleStrength 0 AND glintRoadStrength 0    90   (−4%)
     *     + reflectionStrength 0                       28   (−70%)
     *
     * i.e. with BOTH glint terms switched off the frame was visually identical.
     * The sun contributed 4% of the sea's light and the sky mirror 70%, and the
     * sea measured 22% BRIGHTER looking away from the sun than toward it. Every
     * symptom the user reported is that one fact: no golden cone (there was no
     * sun term to make one), the sun "reflecting all over" (that is the SKY,
     * reflecting all over, because nothing else was competing), and the whole
     * surface reading as plastic — an angularly unselective sheen with no sun
     * structure is the definition of plastic.
     *
     * §V.26 IS NOT REOPENED. This does not put the sun disc back into the
     * reflected sky, analytically or through the mirror; `skyDomeColor` is
     * still asked for a sun-free sky and still answers with one. What is
     * restored is the sun's ENERGY, spread by the SURFACE'S OWN STATISTICS —
     * which is the thing a glint road physically is, and which cannot paint a
     * clean circular blob because its shape is the sea's slope distribution,
     * not the sun's outline.
     *
     * THE MODEL. Standard microfacet reflection, every factor from a stated
     * source and none of them dialled:
     *
     *   L = f_r · E_⊥ · (N·L),   f_r = F·D·G / (4 (N·L)(N·V))
     *
     *  · D — BECKMANN, which IS the Gaussian slope law Cox & Munk fitted to the
     *    sea (see COX_MUNK_CALM_SLOPE_VAR): D = exp(−tan²θ_h/σ²)/(π σ² cos⁴θ_h),
     *    normalised so ∫D(h)(N·h)dω = 1. Its peak is 1/(πσ²) — the energy
     *    normalisation is INSIDE the NDF, which is why the old `widen()` peak
     *    rescale must not also be applied here (that was the double count that
     *    made this term invisible).
     *  · σ² — `glintVar` below. NOT a roughness constant: the pixel's own
     *    unresolved slope variance, which is what §V.48b already computes.
     *  · G/V — Smith height-correlated, α = σ, folded with the 1/(4 N·L N·V)
     *    denominator into `vis`. GGX-Smith masking against a Beckmann D is the
     *    usual production pairing; the alternative (Walter's rational fit to
     *    Beckmann's own Λ) is a branch and agrees to within a few percent over
     *    the range σ ≤ 0.25 this surface ever reaches. It is what bounds the
     *    grazing 1/(N·V), and a sunset frame is nothing but grazing.
     *  · F — Schlick at the MICROFACET's incidence (V·H), not the surface's.
     *    This is where the golden cone gets its intensity: at a 5.8° sun and a
     *    grazing view, V·H ≈ 0.09, i.e. 85° incidence, and Fresnel there is
     *    0.62 rather than the 0.02 of a face-on look. Physics, not a boost.
     *
     * THE UNIT BRIDGE, which is the whole calibration and the reason this is
     * derived rather than tuned. E_⊥ is the sun's irradiance in whatever units
     * this renderer's radiance is in, and the material already states it: the
     * diffuse term ~500 lines up is `waterCol · uSunLightColor · uLightGain ·
     * (N·L)`, i.e. an unnormalised Lambert, so `uSunLightColor · uLightGain` is
     * E_⊥/π by definition of that convention. Hence the `π · uLightGain` here,
     * and hence `uSunLightColor` staying where it always was on the composite
     * line below. Read off the sun's own diffuse term, so the two cannot drift:
     * dim the sun and its road dims with it.
     *
     * `glintRoadStrength` survives as the one artistic trim, and 1.0 now MEANS
     * something — energy-correct against the material's own key light. Its old
     * companion `glintRoadPower` is deleted: lobe width is σ²'s job now, and a
     * second, independent width knob is exactly how the two terms drifted two
     * orders of magnitude apart in the first place.
     */
    // ── σ² for the lobe ──────────────────────────────────────────────
    // `glintVar` is built beside `normalVar` ~700 lines up, floored at Cox &
    // Munk's zero-wind intercept and ceilinged at the sea's own summed shoaled
    // slope variance. It is defined there rather than here because `widen()`
    // above needs the same quantity — there is ONE σ² in this material and
    // every sun term reads it. See that block for the measurement that moved
    // it off `normalVar`.
    /**
     * §V92 THE SUN HAS A WIDTH — the representative point of a disc source.
     *
     * MEASURED DEFECT (user: "the reflection road… converges in too small of
     * a spot, like a point source"). With L the sun's CENTRE, the road's
     * azimuthal half-width at its apex (the water point whose half vector is
     * vertical) is 2·tan(elev)·θ_hm exactly — a facet has to tilt
     * φ/(2 tan elev) across the sun's bearing to swing a grazing reflection
     * by φ, so as the sun sets the road's apex narrows to NOTHING whatever
     * σ² is. CPU mirror, σ² = 0.003: 0.09° at 1°, 0.46° at 5°, 9.1° at 60°,
     * against a drawn disc 1.1° in radius. No widening of σ² can fix it,
     * because σ² widens the lobe in HALF-VECTOR space and the pinch is the
     * Jacobian from half vector to reflection direction going to zero at
     * grazing. Only a source with an angular extent survives it: the mirror
     * image of a disc on the horizon is as wide as the disc.
     *
     * THE MODEL (Karis 2013, "representative point"): move the light to the
     * point of the disc nearest the pixel's own mirror direction `refl`, and
     * shade with THAT direction. Inside the disc's image the half vector is
     * exactly N (the plateau = the mirrored disc, saturating at
     * GLINT_RADIANCE_MAX like a real sun's reflection blows out); outside it
     * the Beckmann lobe decays from the disc's RIM instead of from its centre.
     * The disc radius `r` is the DRAWN disc plus `sunGlareRadiusDeg`
     * (sunSourceUniform, from the sky params — §V66, the dimension the user
     * sees). Normalised by Karis's (σ/(σ + tan(r/2)))², the peak of a lobe
     * whose width grew by the source: measured against the true disc-averaged
     * point lobe (clamped at GLINT_RADIANCE_MAX, CPU mirror, σ² 0.003 and
     * 0.0607) it is 0.97–1.2 at 30–60° where the daytime look lives, and
     * 1.4–3.5 at 1–5° where the widened apex bar IS the requested change. k ≤ 1 and the clamp keep it bounded at source
     * (§V44): no pixel can exceed the point lobe's own peak.
     *
     * `halfVec`/`ndoth` (the sparkle and the glint TRAIN) keep the centre:
     * those are footprints, not radiances, and a point-sized sparkle is the
     * point. Only the road — the energy — takes the source's width.
     */
    const srcAlong = refl.dot(sunDirectionUniform);
    const srcToRay = refl.mul(srcAlong).sub(sunDirectionUniform); // centre → mirror ray, ⊥ L
    const srcToRayLen = srcToRay.length().max(1e-6);
    const srcDir = normalize(
      sunDirectionUniform.add(srcToRay.mul(uSunSource.x.div(srcToRayLen).min(1))),
    ).toVar();
    const srcSigma = glintVar.sqrt();
    const srcNorm = srcSigma.div(srcSigma.add(uSunSource.y.max(0)));
    const srcEnergy = srcNorm.mul(srcNorm).toVar();
    // ── Beckmann D(h) — on the SOURCE's half vector (§V92, see srcDir) ──
    const srcHalf = normalize(viewDir.add(srcDir));
    const srcNdoth = normalWorld.dot(srcHalf).max(0);
    const cosH2 = srcNdoth.mul(srcNdoth).max(1e-4);
    const tanH2 = float(1).sub(cosH2).div(cosH2);
    const ndf = tanH2
      .div(glintVar)
      .negate()
      .exp()
      .div(glintVar.mul(Math.PI).mul(cosH2).mul(cosH2));
    // ── Smith height-correlated visibility (includes 1/(4 N·L N·V)) ──
    // N·L of the representative point: a half-set sun's UPPER rim still
    // lights the water, which is why the road can outlive `sunUpFactor`
    const nol = normalWorld.dot(srcDir).max(1e-3);
    const nov = cosTheta.max(1e-3);
    const oneMinusA2 = float(1).sub(glintVar).max(0);
    const vis = float(0.5).div(
      nol
        .mul(nov.mul(nov).mul(oneMinusA2).add(glintVar).sqrt())
        .add(nov.mul(nol.mul(nol).mul(oneMinusA2).add(glintVar).sqrt()))
        .max(1e-5),
    );
    // ── Schlick at the microfacet's own incidence ────────────────────
    const voh = viewDir.dot(srcHalf).clamp(0, 1);
    const fSun = uFresnelR0.add(
      float(1).sub(uFresnelR0).mul(pow(float(1).sub(voh), 5)),
    );
    const road = ndf
      .mul(vis)
      .mul(fSun)
      .mul(nol)
      .mul(Math.PI)
      .mul(uLightGain)
      .mul(uGlintRoad)
      .mul(srcEnergy)
      .clamp(0, GLINT_RADIANCE_MAX);
    // §V92 the road's own horizon gate: the sky's disc-gate edges in key.y
    // (fully set at −(disc + margin), clear at +disc). `sunUpFactor` starts at
    // +0.3°, which left a half-set disc on the horizon with NO road under it
    // — part of the "wonky horizon". The sparkle keeps `sunUp`: it is a
    // footprint over a hash, not the sun's energy. §V28: edge gap floored.
    // @band-limited-elsewhere: a ramp over a per-frame UNIFORM (key.y), no
    // pixel footprint — same class as sunUpFactor above.
    const roadGate = smoothstep(
      uSunSource.z,
      uSunSource.w.max(uSunSource.z.add(1e-4)),
      sunDirectionUniform.y,
    );
    const sparkWiden = widen(uSparklePower);
    const sparkle = sparkleField
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
      .mul(sunUp)
      .add(road.mul(roadGate))
      .mul(shade)
      .mul(float(1).sub(foamAmount.mul(0.7)));

    // ── distance haze (§V30) ───────────────────────────────────────────
    // The water ignores scene fog (material.fog = false) and melts itself:
    // a linear fog wall starting at 900 m is what made the world read as a
    // painted dome. Curve > 1 keeps the mid-field readable and pushes the
    // melt into the last stretch, ending exactly on the sky's haze colour so
    // the disc rim is invisible.
    //
    // THE MELT TARGET IS THE SKY ITSELF, ASKED ALONG THIS PIXEL'S OWN VIEW RAY
    // — not `uHazeColor`. Same §T.39 single-authority argument that put
    // `skyDomeColor(refl)` in the reflected-sky term 500 lines up, and it fixes
    // the same class of drift, here at the one place in the frame where the two
    // models are drawn EDGE TO EDGE.
    //
    // `uHazeColor` is `scene.fog.color`, a CPU reproduction of the dome
    // (src/sky/lighting.ts, "reproduce that exact blend here"). It is not one,
    // and cannot be: `skyDome` at the horizon is
    //   mix( mix(uMid, uHaze, hazeStrength + sunSide·sunHazeStrength),
    //        uWarm, sunSide²·horizonWarmStrength·warm )
    // — AZIMUTHAL through `sunSide` — while the CPU form drops `sunHazeStrength`
    // entirely and warms toward the SUN colour at a flat 0.35·lowSunWarmth
    // instead of toward `horizonWarmColor` at sunSide². So the far water melts
    // to one colour for the whole compass while the sky above it does not, and
    // the sea ends on a line. MEASURED against what the background node
    // actually draws, ACES + exposure 1.1, 0-255:
    //   tod 15.0  seam 4-9/255, roughly flat in azimuth
    //   tod 17.6  seam 21-25/255, and SWINGING 25→14→22→23 across the compass,
    //             i.e. not a constant offset anyone could dial out with a tint
    // After this line the seam is 0 at every azimuth at both angles by
    // CONSTRUCTION, except within ~5° of the sun where the background adds its
    // glow/halo lobe that the water deliberately does not (see the reflected-sky
    // note above — re-adding the disc through the water paints a blob):
    // residual 3/255 at 15.0, 17/255 at 17.6, inside the lobe only.
    //
    // `viewDir.negate()` is eye→surface, which points DOWN for any water below
    // the camera — and `skyDome`'s first line is `dir.y.max(0)`, so every
    // downward ray already collapses to the horizon colour at that azimuth.
    // The flattening is free; do not add a separate horizon ray.
    // No new binding: `skyDomeColor` is pure ALU (one `pow`, one `exp`).
    // `uHazeColor` stays the fallback for a build with no sky wired, and stays
    // the source for the skylight/foam/sky-tint terms above — those want ONE
    // scene-wide sky, not a per-pixel azimuth.
    const hazeTarget = skyDomeColor ? skyDomeColor(viewDir.negate()) : uHazeColor;
    col.assign(mix(col, hazeTarget, hazeT));
    // glints punch partway through the haze — a sun path fading to nothing
    // at 2 km looks like fog, not distance
    //
    // TINTED BY THE KEY, NOT BY A LITERAL. This multiply is the ONLY colour
    // the road and the sparkles ever carry, so a baked warm cream here was
    // the one key-driven term in the material that escaped `uSunLightColor` —
    // and the moon owns the key after dark (src/sky/moonCycle.ts). With the
    // literal in place the moon painted a NOON-BRIGHT DAYLIGHT-CREAM road on
    // black water. It now carries the key, so the road is amber at sunset and
    // cool under the moon for free.
    //
    // `uSunLightColor` IS RADIANCE, NOT HUE, and that correction is younger
    // than this block. It used to be a bare copy of `sunLight.color`, so the
    // sentence that stood here — "cool at 0x8ea9d6 · moonBrightness" — was
    // false in its second half: `moonBrightness` never reached this multiply,
    // and the road burned at the moon's HUE luminance (0.390, i.e. 43% of a
    // noon sun) at every phase, whether the moon was full or a sliver. The
    // level now arrives with the colour (oceanSurface.ts, §V.72), so the road
    // scales with `moonKeyWeight` — phase, moon elevation and the night ramp —
    // exactly as the key that lights the ship does, and the sentence is true.
    // See §V.75's UNIT BRIDGE note above: E_⊥/π is `uSunLightColor ·
    // uLightGain`, so a `uSunLightColor` missing its level is a bridge
    // anchored to the wrong irradiance, not a bridge that is wrong.
    //
    // §B.9 colour space: `uSunLightColor` is a three Color, written from the
    // key by `setSrgb()` (sRGB → working space) and read here as LINEAR
    // radiance — the same space the literal it replaces was in. No sRGB
    // triple reaches this multiply.
    col.assign(
      col.add(uSunLightColor.mul(glint).mul(mix(float(1), uGlintHaze, hazeT))),
    );

    // ── underside (§V.24/§V.25): the camera can dive under the surface ──
    // Front-face culling used to make the surface VANISH from below ("the
    // surface is kinda broken off"). From underneath the sea is a mirror
    // ceiling except inside Snell's window (θ < 48.6°, cos ≈ 0.661), where
    // the sky pours through.
    //
    // THE WINDOW SHOWS THE SKY, REFRACTED — not a two-stop ramp indexed by the
    // water-side angle. What was here was `mix(horizonLive, zenithLive, upDot)`,
    // and `upDot` inside the window only ever spans 0.661→1, so the entire
    // 180° hemisphere above the sea was drawn as the TOP THIRD of an elevation
    // gradient. It never reached the horizon colour at all: no azimuth, no
    // sunset band, no sense of where the sun is. Measured against the sky the
    // background node actually draws, scene-linear at tod 17.6, the rim of the
    // window came out at 0.359 where the correct answer (sky × n²) is 1.092 —
    // 3× too dark exactly where the sunset lives, while the CENTRE was
    // accidentally within 8% because the 1.15 brightness knob happens to sit
    // near n². The user's report is that shape precisely: "as soon as we go
    // below the surface it's very dark immediately, even looking towards the
    // sun".
    //
    // This is the SAME defect that was fixed for the reflected sky 600 lines
    // up, and the same fix: ask `skyDomeColor`. The underwater window was
    // simply left on the pre-fix formulation. §T.39 — one sky model.
    //
    // §V.26 IS NOT REOPENED, AND IS NOW SCOPED. The exclusion of the sun
    // disc/glow/halo from `skyDomeColor` was written for the ABOVE-WATER
    // REFLECTION, where re-adding the disc paints the clean circular blob the
    // user shot: a rough sea reflects the sun as a glint road, not as a mirror
    // image. That argument is about a REFLECTION off a rough interface and it
    // does not transfer to TRANSMISSION through it — from below, the sun is a
    // real object that ought to be visible in the compressed hemisphere. It is
    // still absent here only because the disc term lives in
    // src/sky/skyBackground.ts and is not exported; see the note in the
    // session report. Nothing here re-derives it.
    //
    // No new binding, and the §V.40 budget is untouched: `skyDomeColor` is
    // pure ALU (one `pow`, one `exp`) and is already called twice in this same
    // body. The refraction below is a dot, a sqrt and a normalize-by-known-
    // length — no texture, no uniform, no branch.
    const eyeToSurf = viewDir.negate(); // eye→surface; points UP from below
    const upDot = eyeToSurf.dot(normalWorld).max(0); // cos θ in WATER
    const soft = uUnderWindow.y.max(0.01);
    const snellWindow = smoothstep(
      float(CRITICAL_COS).sub(soft),
      float(CRITICAL_COS).add(soft),
      upDot,
    );
    // Refract water→air about the LIVE wave normal (§V.71: the window rides
    // the surface's real shape, so rolling swell swings it — which is what it
    // does in life). Built explicitly rather than with `refract()` because
    // refract returns vec3(0) past the critical angle and a normalize of that
    // is a NaN that `snellWindow`'s zero cannot mop up (0 × NaN = NaN).
    // `tangent` has length exactly sin θ_water — both inputs are unit and
    // `upDot` is their dot — so the §V.28-floored divide IS the normalize, and
    // it degenerates to 0 looking straight up, where the tangent is unused.
    const sinW = float(1).sub(upDot.mul(upDot)).max(0).sqrt();
    const tangent = eyeToSurf.sub(normalWorld.mul(upDot)).div(sinW.max(1e-4));
    const sinA = sinW.mul(WATER_IOR).min(1); // Snell; clamped past critical
    const cosA = float(1).sub(sinA.mul(sinA)).max(0).sqrt();
    const airDir = tangent.mul(sinA).add(normalWorld.mul(cosA));
    // n² is PHYSICS (see WATER_RADIANCE_GAIN); `uUnderWindow.x` is the trim.
    // Two quantities, two names — its default drops 1.15 → 1.0 because the
    // 1.15 was standing in for the n² that was missing.
    // The fallback keeps its two-stop ramp but is now indexed by the AIR-side
    // cosine, so even a build with no sky wired sweeps horizon→zenith across
    // the window instead of showing its top third.
    /**
     * §T.61 — THE SUN, THROUGH THE WINDOW. The user has asked for this four
     * times, most recently with a frame in which the hull's specular is blown
     * out, the god rays converge on a point past the bow and caustics dance
     * overhead: three independent paths all reading the sun's direction
     * correctly while the window that is the SOURCE of all three shows
     * nothing. It showed nothing because `skyDomeColor` is by construction
     * incapable of containing a sun (§V.26) and it was the only thing filling
     * the window.
     *
     * §V.26 IS SCOPED, NOT REOPENED, and the code now says so structurally:
     * the disc arrives through its OWN argument (`skySunTerm`), used on this
     * one line and nowhere else, so the reflected sky 700 lines up cannot
     * reach it. The exclusion's argument — "re-adding the disc paints a clean
     * circular blob, because a rough sea reflects the sun as a glint ROAD" —
     * is about REFLECTION OFF a rough interface. Transmission THROUGH one is
     * the opposite case: from below, the sun is a real object at a real place
     * in a compressed hemisphere, and its absence is the defect.
     *
     * NOT A CLEAN DISC, and nothing extra is needed to make that true (user:
     * "at least like this distorted bright spot"). `airDir` is refracted about
     * `normalWorld`, the LIVE per-pixel wave normal, and near the rim of the
     * window the refraction's own Jacobian dθ_air/dθ_water = n·cosθ_w/cosθ_a
     * runs away — so a millimetre of wave slope swings the sun's image by
     * degrees and it smears and wobbles with the surface exactly as it does in
     * life. The disc's ANGULAR SIZE is correctly left alone: it is evaluated in
     * AIR space where the sun really is ~0.5° across, and all of the
     * compression into the 48.6° cone is carried by the mapping.
     *
     * ADDED BEFORE THE n² GAIN ON PURPOSE. The sun's disc is a radiance in air
     * like any other part of the sky, so it takes the same L_water = n²·L_air
     * scaling; pulling it out to add afterwards would make it the one part of
     * the hemisphere that did not obey the boundary condition.
     *
     * §V.40: zero textures, zero samplers — one smoothstep and two `pow` on
     * uniforms the sky already owns. The fragment stage is at 15/16 and does
     * not move.
     */
    const skyIn = skyDomeColor ? skyDomeColor(airDir) : mix(horizonLive, zenithLive, cosA);
    const windowCol = (skySunTerm ? skyIn.add(skySunTerm(airDir)) : skyIn)
      .mul(WATER_RADIANCE_GAIN)
      .mul(uUnderWindow.x);
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
    (uWakeFoam.value as THREE.Color).set(sp.wakeFoamColor);
    uWakeFoamDepth.value = sp.wakeFoamDepth;
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
    uSlopeVarAa.value = sp.slopeVarianceAa;
    (uSparkleShape.value as THREE.Vector2).set(
      sp.sparkleRadiusPixels,
      sp.sparkleResolveCells,
    );
    uMicroSamples.value = sp.microDetailSamplesFull;
    uMicroWarp.value = Math.max(0, sp.microDetailWarp);
    uMicroWarpScale.value = Math.max(0.5, sp.microDetailWarpScale);
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
    uGlintRoad.value = sp.glintRoadStrength;
    (uGraze.value as THREE.Vector2).set(sp.sparkleGrazeStart, sp.sparkleGrazeEnd);
    uFoamThreshold.value = sp.foamThreshold;
    (uNormFade.value as THREE.Vector2).set(sp.normalFadeStart, sp.normalFadeEnd);
    // §V.33: read from causticsParams, the single owner — a Tweakpane drag on
    // the Jerlov coefficients has to move the see-through path, the caustic,
    // the submerged hull and the underwater volume together, or they disagree
    // about what water this is.
    (uAbsorption.value as THREE.Vector3).set(
      cp.submergedAbsorptionR,
      cp.submergedAbsorptionG,
      cp.submergedAbsorptionB,
    );
    uRefractStrength.value = sp.refractionStrength;
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
    // cheap (a 256-bin walk ×3) and it MUST run here: the footprints are
    // spectrum-derived, so a weather preset or a slider that rebuilds h0 moves
    // them — a value cached at construction is §B.7's shape one level up.
    refreshNormFoot();
    // §V.72: same argument, one level further out. The shoaling wavenumbers are
    // spectrum-derived (cascade 0's mean wavelength moves 249 → 87 → 143 m
    // across the presets) AND depend on two params that never touch h0, so
    // neither the rebuild path nor construction alone would keep them live.
    refreshShoal();
    // §V.73: the fetch coefficients depend on the live WIND SPEED as well as
    // on each band's mean wavenumber, and windSpeed is published continuously
    // by the §V.46 weather field — so this cannot live on the rebuild path.
    refreshFetch();
  };

  return {
    material,
    originUniform: originUniform as unknown as { value: THREE.Vector2 },
    sunDirectionUniform: sunDirectionUniform as unknown as { value: THREE.Vector3 },
    sunSourceUniform: uSunSource as unknown as { value: THREE.Vector4 },
    timeUniform: timeUniform as unknown as { value: number },
    cameraFarUniform: uCameraFar as unknown as { value: number },
    hazeColorUniform: uHazeColor as unknown as { value: THREE.Color },
    seaRmsUniform: uSeaRms as unknown as { value: number },
    choppinessUniform: uChoppiness as unknown as { value: number },
    radialLodUniform: uRadialA as unknown as { value: number },
    hdrSceneTarget,
    sunColorUniform: uSunLightColor as unknown as { value: THREE.Color },
    updateFromParams,
  };
}
