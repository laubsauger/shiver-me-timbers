/**
 * Caustic TSL nodes (§V.34, §T.32). Line-for-line mirror of causticsMath.ts,
 * which tests/caustics.test.ts proves against a brute-force ray trace.
 *
 * NO COMPUTE PASS, NO CAUSTIC TEXTURE. The whole effect is evaluated in the
 * receiver's own fragment shader from the ocean's EXISTING derivative
 * textures, so it costs exactly what the receivers cover on screen and adds
 * zero passes to the frame (§V.17). A scrolling caustic atlas is forbidden
 * by §V.34 and would not track the sun anyway; the pattern here is the live
 * FFT surface, so it inherits the cascades' non-commensurate domains
 * (420/98/22.7 m) and cannot read as a loop (§V.19).
 *
 * §V.23: 3-arg math uses FUNCTIONAL mix(a,b,t) / smoothstep(e0,e1,x). Every
 * smoothstep with e0 > e1 is commented with its reading.
 * §V.28: the ray's vertical component is floored, and the caustic reciprocal
 * — which legitimately runs to infinity at a fold — is regularised, never
 * hard-clamped. See `causticGainNode`.
 */
import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  float,
  mix,
  refract,
  reflect,
  smoothstep,
  texture,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import type { OceanSimulation } from '../ocean/oceanCascades';
import { sampleCascadeLayer } from '../ocean/oceanTextures';
import { oceanParams } from '../params/ocean';
import { breakerClipNodes, shoalFactorNode, shoalWavenumber } from '../ocean/shoaling';
import {
  developmentRatioNode,
  fetchBandCoefficient,
  fetchBandGainNode,
  fullyDevelopedFetch,
  fullyDevelopedPeakWavenumber,
} from '../ocean/fetch';
import { causticsParams as cp } from '../params/caustics';
import { MIN_VERTICAL } from './causticsMath';

/** TSL nodes only line up structurally at runtime (same convention as foam) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TslNode = any;

export interface CausticsUniforms {
  sunDirection: TslNode;
  eta: TslNode;
  epsilon: TslNode;
  epsilonPerMeter: TslNode;
  softness: TslNode;
  softnessPerMeter: TslNode;
  strength: TslNode;
  maxGain: TslNode;
  darkStrength: TslNode;
  minDepth: TslNode;
  maxDepth: TslNode;
  /** Jerlov K_d per channel (1/m) — attenuates the caustic AND the hull */
  absorption: TslNode;
  fade: TslNode;
  reflectedStrength: TslNode;
  reflectedFalloff: TslNode;
  /** hard ceiling on the reflected branch, m above the waterline */
  reflectedMaxHeight: TslNode;
  /** receiver n.y at which sea-bounced light stops reaching it */
  reflectedFaceLimit: TslNode;
  /** 0..1 how much of the physical cos(incidence) the reflected branch obeys */
  reflectedIncidence: TslNode;
  /** 0..1 how far the above-water waterline band is shrunk by receiver slope */
  waterlineSlopeBound: TslNode;
  choppiness: TslNode;
  waterlineBlend: TslNode;
  faceGate: TslNode;
  maxDrift: TslNode;
}

export function createCausticsUniforms(): CausticsUniforms {
  return {
    // seeded with THREE vectors, NOT vec3()/vec2() nodes: a node-valued
    // uniform has no .x/.y to write, so the value would silently never
    // update (the trap foam/foamShading.ts documents for uPropX/uPropZ)
    sunDirection: uniform(new THREE.Vector3(0.4, 0.8, 0.2).normalize()),
    eta: uniform(1 / cp.waterIor),
    epsilon: uniform(cp.curvatureEpsilon),
    epsilonPerMeter: uniform(cp.curvatureEpsilonPerMeter),
    softness: uniform(cp.foldSoftness),
    softnessPerMeter: uniform(cp.foldSoftnessPerMeter),
    strength: uniform(cp.strength),
    maxGain: uniform(cp.maxGain),
    darkStrength: uniform(cp.darkStrength),
    minDepth: uniform(cp.minEffectiveDepth),
    maxDepth: uniform(cp.maxDepth),
    // physical coefficients, NOT a colour — no sRGB transfer (§V.31)
    absorption: uniform(
      new THREE.Vector3(
        cp.submergedAbsorptionR, cp.submergedAbsorptionG, cp.submergedAbsorptionB,
      ),
    ),
    fade: uniform(new THREE.Vector2(cp.fadeStart, cp.fadeEnd)),
    reflectedStrength: uniform(cp.reflectedStrength),
    reflectedFalloff: uniform(cp.reflectedHeightFalloff),
    reflectedMaxHeight: uniform(cp.reflectedMaxHeight),
    reflectedFaceLimit: uniform(cp.reflectedFaceLimit),
    reflectedIncidence: uniform(cp.reflectedIncidence),
    waterlineSlopeBound: uniform(cp.waterlineSlopeBound),
    choppiness: uniform(oceanParams.choppiness),
    waterlineBlend: uniform(cp.waterlineBlend),
    faceGate: uniform(cp.faceGateSoftness),
    maxDrift: uniform(cp.maxDrift),
  };
}

/** push live params into the caustic uniforms (call per frame, §V.16) */
export function refreshCausticsUniforms(u: CausticsUniforms): void {
  u.eta.value = 1 / Math.max(cp.waterIor, 1e-3);
  u.epsilon.value = cp.curvatureEpsilon;
  u.epsilonPerMeter.value = cp.curvatureEpsilonPerMeter;
  u.softness.value = cp.foldSoftness;
  u.softnessPerMeter.value = cp.foldSoftnessPerMeter;
  u.strength.value = cp.strength;
  u.maxGain.value = cp.maxGain;
  u.darkStrength.value = cp.darkStrength;
  u.minDepth.value = cp.minEffectiveDepth;
  u.maxDepth.value = cp.maxDepth;
  u.absorption.value.set(
    cp.submergedAbsorptionR, cp.submergedAbsorptionG, cp.submergedAbsorptionB,
  );
  u.fade.value.set(cp.fadeStart, cp.fadeEnd);
  u.reflectedStrength.value = cp.reflectedStrength;
  u.reflectedFalloff.value = cp.reflectedHeightFalloff;
  u.reflectedMaxHeight.value = cp.reflectedMaxHeight;
  u.reflectedFaceLimit.value = cp.reflectedFaceLimit;
  u.reflectedIncidence.value = cp.reflectedIncidence;
  u.waterlineSlopeBound.value = cp.waterlineSlopeBound;
  u.choppiness.value = oceanParams.choppiness;
  u.waterlineBlend.value = cp.waterlineBlend;
  u.faceGate.value = cp.faceGateSoftness;
  u.maxDrift.value = cp.maxDrift;
}

/** cascade uv for a world XZ — matches ocean/surfaceMaterial's convention */
const cascadeUv = (worldXZ: TslNode, domain: number) =>
  worldXZ.div(domain).fract();

/**
 * Summed world-space surface slope + the choppy stretch diagonal, from the
 * derivatives textures ONLY (§V.34: reuse, no second surface eval).
 * Returns { g, a11, a22 } exactly as causticsMath.surfaceStretch defines.
 *
 * The LOD/Nyquist gates the ocean geometry applies are deliberately NOT
 * repeated here: caustic receivers are hull/seabed/beach at close range,
 * where every gate is 1 anyway, and the whole term is distance-faded out by
 * `fade` long before the cascades would drop.
 */
export function surfaceSlopeNode(sim: OceanSimulation, u: CausticsUniforms, worldXZ: TslNode) {
  let der: TslNode = null;
  for (const c of sim.cascades) {
    // one array texture, one sampler, all three cascades (§V.40)
    const t = sampleCascadeLayer(c.derivatives, cascadeUv(worldXZ, c.domain));
    der = der === null ? t : der.add(t);
  }
  // (∂h/∂x, ∂h/∂z, ∂Dx/∂x, ∂Dz/∂z) → true slope needs the choppy stretch out
  const a11 = float(1).add(der.z.mul(u.choppiness)).max(0.05); // floored (§V28)
  const a22 = float(1).add(der.w.mul(u.choppiness)).max(0.05);
  return { g: vec2(der.x.div(a11), der.y.div(a22)), a11, a22 };
}

/**
 * §V.72 — the shoaling uniforms a RECEIVER needs to reconstruct the sea
 * surface at the height the ocean actually draws it.
 *
 * A third copy of these, alongside surfaceMaterial's `uShoalK`/`uBreaker` and
 * `CpuOcean.shoalK`, and that is the established shape rather than a smell:
 * all three derive their values from the ONE law in `ocean/shoaling.ts`
 * (`shoalWavenumber`), exactly as `CpuOcean.refreshShoal()` does. The law has
 * one owner; the uniform buffers cannot be shared because the three consumers
 * are a material, a mirror and a receiver built at different times.
 */
export interface ShoalingUniforms {
  /** per-cascade shoaling wavenumber (rad/m) */
  k: TslNode[];
  /** (shoalBreakerIndex, shoalColumnCeiling) */
  breaker: TslNode;
  /**
   * §V.73 per-cascade fetch coefficient, (k_pfull/k_band)². Carried in the
   * SAME bag as the shoaling wavenumbers on purpose: the two are the two
   * factors of one per-cascade gain, and a receiver that reconstructed the sea
   * with one of them and not the other would be f62e037 all over again — that
   * bug was `waterHeightNode` summing the raw spectrum while the ocean drew a
   * modulated one, and it cost four user reports in a day.
   */
  fetchC: TslNode[];
  /** world metres of clear upwind water for full development at this wind */
  fetchFull: TslNode;
  /** §V.44 ceiling on the young-sea steepening term */
  fetchMaxGain: TslNode;
}

export function createShoalingUniforms(sim: OceanSimulation): ShoalingUniforms {
  return {
    k: sim.cascades.map(() => uniform(0)),
    breaker: uniform(
      new THREE.Vector2(oceanParams.shoalBreakerIndex, oceanParams.shoalColumnCeiling),
    ),
    fetchC: sim.cascades.map(() => uniform(0)),
    fetchFull: uniform(1),
    fetchMaxGain: uniform(oceanParams.fetchMaxGain),
  };
}

/**
 * Push the current spectrum + params into `u`. `openDepth` is the seabed's own
 * open-ocean depth (m, positive); 0 means "no seabed wired", which pins every
 * wavenumber at the floor and is only ever read when a caller supplies a
 * depth node anyway.
 */
export function refreshShoalingUniforms(
  u: ShoalingUniforms,
  sim: OceanSimulation,
  openDepth: number,
): void {
  for (const [i, c] of sim.cascades.entries()) {
    u.k[i].value = shoalWavenumber(c.meanWavenumber, openDepth, oceanParams);
  }
  (u.breaker.value as THREE.Vector2).set(
    oceanParams.shoalBreakerIndex,
    oceanParams.shoalColumnCeiling,
  );
  // §V.73, from the same one law surfaceMaterial and CpuOcean call
  const peakK = fullyDevelopedPeakWavenumber(oceanParams.windSpeed);
  for (const [i, c] of sim.cascades.entries()) {
    u.fetchC[i].value = fetchBandCoefficient(peakK, c.meanWavenumber, oceanParams);
  }
  u.fetchFull.value = fullyDevelopedFetch(oceanParams.windSpeed, oceanParams);
  u.fetchMaxGain.value = oceanParams.fetchMaxGain;
}

/**
 * World Y of the sea surface at a world XZ, summed over all cascades.
 *
 * §V.72, AND THE BUG THIS SIGNATURE EXISTS TO CLOSE. Without `shoal` this is
 * the RAW open-ocean spectrum — the same quantity `CpuOcean.sampleRaw` returns
 * and, like it, NOT "how high is the water here". The ocean surface material
 * draws its vertices at Σ heightᵢ·shoalFactor(kᵢ, d) put through
 * `breakerClip`, so a receiver that asks this question without a depth gets a
 * sea level that disagrees with the one on screen by the whole shoaling term
 * — which goes to 1.0 offshore and to ZERO at the waterline, i.e. it is
 * wrong by the entire wave amplitude exactly where a beach is.
 *
 * Measured on the showcase island's 180° transect (swell preset, one instant):
 * raw swung -1.945 m … +1.610 m across the 100 m of beach either side of the
 * waterline while the drawn sea sat at 0.000 … 0.281 m. On a 0.2-2° beach that
 * false sea level marks a hundred metres of DRY SAND as submerged — the user's
 * "weird purple patches marching over the land" (the §V.34 absorption tint and
 * caustics painted onto land) — and, on the half-cycle where it swings the
 * other way, leaves genuinely submerged sand with NO darkening at all ("the
 * terrain underwater is not really getting darkened"). One sign error's worth
 * of the same disagreement, both symptoms, one cause.
 *
 * `shoal.depth` is the still-water column (m, ≥ 0) at this point. It is the
 * CALLER's, deliberately: a terrain receiver knows its own depth exactly as
 * `-positionWorld.y` — the surface IS the seabed — which is a better number
 * than any resample of the baked field and, being the position the fragment is
 * actually being shaded at, cannot drift from the geometry the way a second
 * texture lookup can. A receiver that is NOT the bed (a hull) must pass the
 * bed's depth or nothing at all.
 *
 * This is the line-for-line TSL twin of `CpuOcean.shoaledSum` (§V.8), built
 * from the same `shoalFactor` / `breakerClip` exports.
 */
export function waterHeightNode(
  sim: OceanSimulation,
  worldXZ: TslNode,
  shoal?: { u: ShoalingUniforms; depth: TslNode; fetch?: TslNode | null },
): TslNode {
  // §V.73: one ratio for every band — it is a property of the place, not of
  // the band. Absent shelter field ⟹ null ⟹ the whole term folds away and the
  // reconstruction is bit-identically the shoaling-only one.
  const ratio =
    shoal && shoal.fetch ? developmentRatioNode(shoal.fetch, shoal.u.fetchFull) : null;
  let h: TslNode = null;
  for (const [i, c] of sim.cascades.entries()) {
    let t = texture(c.displacement, cascadeUv(worldXZ, c.domain)).y;
    // per cascade, by its OWN wavenumber — long swell feels the bottom far
    // offshore, short chop stays lively until it is almost aground (§V.19)
    if (shoal) t = t.mul(shoalFactorNode(shoal.u.k[i], shoal.depth));
    // ...and by its own band's fetch gain, the SAME product surfaceMaterial's
    // `shoal[i]` and `CpuOcean.shoaledSum` build (§V.8)
    if (shoal && ratio) {
      t = t.mul(fetchBandGainNode(shoal.u.fetchC[i], ratio, shoal.u.fetchMaxGain));
    }
    h = h === null ? t : h.add(t);
  }
  if (!shoal) return h;
  // term B on the SUMMED elevation, same as the vertex stage (§V.72)
  return breakerClipNodes(h, shoal.depth, shoal.u.breaker.x, shoal.u.breaker.y).clipped;
}

/** normalize(-gx, 1, -gz) — the water normal from its world slope */
const normalFromSlope = (g: TslNode) => vec3(g.x.negate(), 1, g.y.negate()).normalize();

/**
 * Lateral drift per metre of span for the refracted (below) or reflected
 * (above) sun ray. `.valid` is 0 where the sun sits behind the local wave
 * face, which is what stops light appearing under a shadowed trough.
 */
export function driftNode(u: CausticsUniforms, g: TslNode, below: boolean) {
  const n = normalFromSlope(g);
  const incident = u.sunDirection.negate();
  // anti-aliased form of causticsMath's hard `cosI > 0` predicate: a step()
  // here stair-steps along every wave face turning away from the sun
  const faceLit = smoothstep(float(0), u.faceGate, n.dot(u.sunDirection));

  /**
   * §B.11: flooring the divisor keeps the DIVISION finite but lets the
   * QUOTIENT reach ray/MIN_VERTICAL. Clamping the magnitude is what actually
   * bounds the finite difference that builds det M.
   */
  const limit = (v: TslNode) => {
    const cap = u.maxDrift.max(1e-3);
    // floored divisor, and length ≥ 0 so the ratio never goes negative
    return v.mul(cap.div(v.length().max(cap)));
  };

  if (below) {
    const t = refract(incident, n, u.eta);
    const down = t.y.negate().max(MIN_VERTICAL); // §V28 floored divisor
    const drift = limit(vec2(t.x.div(down), t.z.div(down)));
    return { drift: drift.mul(faceLit), vertical: down, valid: faceLit };
  }

  const r = reflect(incident, n);
  // §B.11: reflection has no Snell bound. A wave face can throw the sun
  // horizontally or back down into the sea, and such a ray cannot light
  // anything above the water — gate it out instead of dividing by a floored
  // near-zero, which pinned drift at 20 over 28% of the surface at a low sun
  // and made det M flip sign between neighbouring pixels.
  const goesUp = smoothstep(float(MIN_VERTICAL), u.faceGate.add(MIN_VERTICAL), r.y);
  const valid = faceLit.mul(goesUp);
  const up = r.y.max(MIN_VERTICAL);
  const drift = limit(vec2(r.x.div(up), r.z.div(up)));
  return { drift: drift.mul(valid), vertical: up, valid };
}

/** coefficients of det M(span) = detC + span·mixed + span²·detB */
function rayJacobianNode(
  a11: TslNode,
  a22: TslNode,
  w: TslNode,
  g: TslNode,
  dDx: TslNode,
  dDz: TslNode,
) {
  const c11 = a11.add(w.x.mul(g.x));
  const c12 = w.x.mul(g.y);
  const c21 = w.y.mul(g.x);
  const c22 = a22.add(w.y.mul(g.y));
  return {
    detA: a11.mul(a22),
    detC: c11.mul(c22).sub(c12.mul(c21)),
    mixed: c11.mul(dDz.y).add(dDx.x.mul(c22)).sub(c12.mul(dDx.y)).sub(dDz.x.mul(c21)),
    detB: dDx.x.mul(dDz.y).sub(dDz.x.mul(dDx.y)),
  };
}

const detAtSpan = (j: TslNode, span: TslNode) =>
  j.detC.add(span.mul(j.mixed.add(span.mul(j.detB))));

/**
 * The regularised reciprocal (§V.28). det M crosses zero at a caustic fold —
 * precisely where intensity should spike — so a hard clamp would plateau and
 * alias. sqrt(det² + σ²) keeps the bright ridge, is bounded by |detA|/σ, and
 * has no branch. σ grows with span, which is also the physical defocus.
 */
function causticGainNode(j: TslNode, span: TslNode, u: CausticsUniforms): TslNode {
  const sigma = u.softness.add(u.softnessPerMeter.mul(span.max(0))).max(1e-4);
  const det = detAtSpan(j, span);
  return j.detA.abs().div(det.mul(det).add(sigma.mul(sigma)).sqrt());
}

/**
 * Bright lobe (ADDITIVE, Reinhard-capped) and dark lobe (MULTIPLICATIVE).
 *
 * §B.11: the dark lobe used to be a negative number folded into the same
 * additive result, which reached `emissiveNode` as negative light. Ray
 * divergence means less light ARRIVES — a multiplication — so it now leaves
 * as a factor in [1 − darkStrength, 1] and negative light is impossible by
 * construction. Flat water → { bright: 0, darken: 1 }.
 */
function causticResponseNode(gain: TslNode, u: CausticsUniforms) {
  const raw = gain.sub(1);
  const lit = raw.max(0);
  // gain ≥ 0 by construction, so raw ≥ −1 and the shortfall is already 0..1
  const shortfall = raw.min(0).negate().clamp(0, 1);
  return {
    bright: lit.div(float(1).add(lit.div(u.maxGain.max(1e-3)))),
    darken: float(1).sub(shortfall.mul(u.darkStrength.clamp(0, 1))),
  };
}

/**
 * Full caustic evaluation for one receiver.
 * `depth` is metres below the sea surface (positive submerged, negative
 * above). Returns TWO terms, and they are not interchangeable (§B.11):
 *   bright — vec3 ≥ 0, ADDITIVE, carrying its own per-channel Jerlov
 *            extinction, which is what shifts it blue-green with depth.
 *   darken — float in [0,1], MULTIPLICATIVE on albedo, the divergent gaps
 *            between filaments. Never additive, so it cannot make light
 *            negative however badly the Jacobian behaves.
 *
 * Note the depth response is TWO-SIDED and emergent, not an authored curve.
 * det M(span) starts at det C ≈ 1 (no contrast at the surface), sharpens as
 * the span approaches the polynomial's root, then washes out past it. That
 * root IS the focal depth, per texel and per sun angle — Wei et al. 2014 give
 * its closed form for a sinusoid, and this gets it for free. Implementations
 * that hard-code "sharp near the surface, blurry deep" have only the far half.
 *
 * TAP BUDGET (per shaded pixel, RGBA32F, no mips):
 *   3  derivatives @ receiver XZ   (back-projection seed, iterations=1 only)
 *   9  derivatives @ entry, +εx, +εz
 *   = 12, plus 3 displacement taps if the caller does not supply waterHeight.
 */
export function causticsNode(
  sim: OceanSimulation,
  u: CausticsUniforms,
  worldPos: TslNode,
  depth: TslNode,
  /**
   * 'below' compiles the ABOVE-WATER (reflected) branch away — an ALU
   * saving for receivers that never want sun bouncing off the waves onto
   * them, i.e. seabed, beach and shoreline.
   *
   * §B.17: it does NOT assert that the fragment is submerged. It used to,
   * and that was a bug: a beach or an island is one material spanning
   * seabed to hilltop, so hard-coding `submerged = 1` lit an entire
   * landmass with underwater caustics. Both modes now gate on the real
   * depth; `mode` only chooses which branches exist.
   */
  mode: 'both' | 'below' = 'both',
  /**
   * The RECEIVER's own world normal. Only the reflected branch uses it, and
   * omitting it leaves that branch ungated — which is what it was until the
   * user reported caustics "spilling way too high up on the boats, across the
   * deck and a little bit onto the other side".
   */
  receiverNormal?: TslNode,
): { bright: TslNode; darken: TslNode } {
  const worldXZ = vec2(worldPos.x, worldPos.z);
  // span travelled through/over water. Below the line the receiver borrows a
  // little virtual depth: real caustics have no focal length at depth 0, so a
  // hull exactly at the waterline would otherwise get nothing at all.
  const belowSpan = depth.max(u.minDepth);
  const aboveSpan = depth.negate().max(0);
  // 1 below the waterline, 0 above — the two branches share every texture tap.
  // The band is wide enough to smear the step `minEffectiveDepth` puts at
  // depth 0, which would otherwise draw a crisp line along the hull.
  //
  // §B.17: this is computed for BOTH modes. `mode: 'below'` used to replace
  // it with a constant 1, which asserted "this fragment is underwater"
  // rather than merely "this receiver wants no reflected branch". Nothing
  // else in the chain could catch that: `belowSpan` clamps negative depths
  // up to `minEffectiveDepth`, and the maxDepth ramp is DECREASING so it
  // returns 1 for every negative depth. Dry land therefore passed every
  // gate at full strength, out to `fadeEnd`.
  //
  // THE ABOVE-WATER HALF IS BOUND IN THE RECEIVER'S OWN DIMENSION (§V.66).
  // `waterlineBlend` is 0.8 m because a HULL needed that much to stop the two
  // branches meeting in a visible seam, and on a hull 0.8 m of height is 0.8 m
  // of surface. On a beach it is 0.8/slope metres of DRY SAND — 6 m at 1:10,
  // 24 m at 1:40 — which is the user's "on shore seem to go up a little bit too
  // high", reported separately from the hull and never tuned because the shore
  // reads a gate no caustics param owns (terrainParams.causticsWaterlineBand).
  // One constant was setting two physically independent reaches: §V.52's shape.
  // Scaling by the normal's horizontal component leaves a vertical side at the
  // full 0.8 m — the signed-off hull crossfade is bit-identical — and takes a
  // flat beach to zero. Only the ABOVE side moves; below the line a receiver is
  // genuinely lit through water whatever its slope.
  const slope =
    receiverNormal === undefined
      ? float(1)
      : vec2(receiverNormal.x, receiverNormal.z).length().clamp(0, 1);
  const aboveBand = u.waterlineBlend.mul(
    mix(float(1), slope, u.waterlineSlopeBound),
  );
  const submerged = smoothstep(aboveBand.negate(), u.waterlineBlend, depth);

  // ── back-projection: find the surface point that actually lights us ──
  let entry: TslNode = worldXZ;
  if (cp.backprojectIterations > 0) {
    const seed = surfaceSlopeNode(sim, u, worldXZ);
    const below = driftNode(u, seed.g, true).drift.mul(belowSpan);
    entry = mode === 'below'
      ? worldXZ.sub(below)
      : worldXZ.sub(mix(driftNode(u, seed.g, false).drift.mul(aboveSpan), below, submerged));
  }

  // ── one tap set at the entry point and two finite-difference neighbours ──
  // §B.17: the stencil must track the span ACTUALLY in use. Deriving it from
  // belowSpan alone meant every above-water fragment — which travels
  // `aboveSpan`, not `belowSpan` — was evaluated at the narrowest legal
  // stencil, because belowSpan had been clamped up to `minEffectiveDepth`.
  // The two spans are mutually exclusive (one is always 0), so the max is
  // simply "whichever applies".
  const travel = belowSpan.max(aboveSpan);
  // floored at one texel of the FINEST cascade (22.7 m / 512 ≈ 0.044 m):
  // below that the difference only reads the bilinear interpolant and the
  // caustic goes blocky, and |∂w| ≤ 2·maxDrift/eps stops being a bound
  const eps = u.epsilon.add(u.epsilonPerMeter.mul(travel)).max(0.05);
  const s0 = surfaceSlopeNode(sim, u, entry);
  const sx = surfaceSlopeNode(sim, u, entry.add(vec2(eps, 0)));
  const sz = surfaceSlopeNode(sim, u, entry.add(vec2(0, eps)));

  const build = (isBelow: boolean) => {
    const w0 = driftNode(u, s0.g, isBelow);
    const wx = driftNode(u, sx.g, isBelow).drift;
    const wz = driftNode(u, sz.g, isBelow).drift;
    const j = rayJacobianNode(
      s0.a11, s0.a22, w0.drift, s0.g,
      wx.sub(w0.drift).div(eps),
      wz.sub(w0.drift).div(eps),
    );
    return { j, ...w0 };
  };

  const response = (j: TslNode, span: TslNode) =>
    causticResponseNode(causticGainNode(j, span, u), u);

  const refr = build(true);
  const refrResp = response(refr.j, belowSpan);

  // Beer–Lambert PER CHANNEL down the SLANTED path, not straight down. Red
  // dies ~19× faster than blue (Jerlov K_d), so a single greyscale caustic
  // shifts to blue-green with depth for free — which is why there is no
  // separate "deep caustic colour" to tune, and no dispersion term.
  const path = belowSpan.div(refr.vertical);
  const attenuation = u.absorption
    .mul(path)
    .negate()
    .exp()
    // hard depth budget: nothing below maxDepth is worth the ALU
    // smoothstep(e0,e1,x) with e0 > e1: 1 while shallower than maxDepth
    .mul(smoothstep(u.maxDepth, u.maxDepth.mul(0.7), depth));

  const underwater = attenuation.mul(refrResp.bright).mul(refr.valid);

  // sun below the horizon → no caustics at all (matches the water's own gate)
  const sunUp = smoothstep(float(-0.02), float(0.06), u.sunDirection.y);
  // smoothstep(e0,e1,x) with e0 > e1: 1 inside fadeStart, 0 past fadeEnd
  const distFade = smoothstep(u.fade.y, u.fade.x, worldPos.sub(cameraPosition).length());

  // every global gate must scale the DARKENING toward 1 as well, or a sunset
  // or a distant hull would keep a shadow the sun is no longer casting
  const gate = sunUp.mul(distFade);
  // §B.17: the underwater lobes are gated on the REAL submersion mask in
  // both modes. Without this a dry hilltop 150 m away is lit as seabed.
  let bright: TslNode = underwater.mul(submerged);
  let darken: TslNode = mix(
    float(1), refrResp.darken, refr.valid.mul(gate).mul(submerged),
  );

  if (mode === 'both') {
    // sun specularly reflected UP off the waves onto the hull side — this is
    // the "light dancing on the boat" half, and it reuses every tap above
    const refl = build(false);
    const reflResp = response(refl.j, aboveSpan);
    // TWO BOUNDS, and they kill different symptoms.
    //
    // 1. exp() NEVER REACHES ZERO. At the shipped 4.5 m falloff a deck 6 m up
    //    still receives exp(-1.33) = 26%, and the upper works keep a few per
    //    cent all the way into the rig. A decaying term is not a bounded one —
    //    §V.48's lesson about band-limiting, in the vertical. So ramp it hard
    //    to zero by reflectedMaxHeight and let the ALU stop there.
    const heightFade = aboveSpan
      .div(u.reflectedFalloff.max(0.01))
      .negate()
      .exp()
      // decreasing smoothstep (e0 > e1): 1 while well under the ceiling, 0 above
      .mul(smoothstep(u.reflectedMaxHeight, u.reflectedMaxHeight.mul(0.6), aboveSpan));
    // 2. THE RECEIVER'S OWN ORIENTATION WAS NEVER CONSULTED. Every face gate
    //    in driftNode() is about the WATER's normal — is this wave face lit,
    //    does its reflected ray travel upward. Nothing asked whether the
    //    surface being lit can physically see the sea. This light is going UP,
    //    so a deck (n.y = +1) cannot be struck by it at all, while a vertical
    //    topside (n.y = 0) catches it square — which is the "light dancing on
    //    the hull" this branch exists to draw. Absent a normal the gate is 1,
    //    so existing callers keep their old behaviour rather than going dark.
    const facing =
      receiverNormal === undefined
        ? float(1)
        : smoothstep(u.reflectedFaceLimit.max(1e-3), float(0), receiverNormal.y);
    // 3. AND THAT GATE IS A FUNCTION OF n.y ALONE, so it answers only "is this
    //    surface pointing up". A hull curving round the bow holds n.y = 0
    //    through the entire azimuthal sweep, so `facing` reads 1.000 for every
    //    one of those fragments while the PROJECTION behind it stretches
    //    without bound — the user's "due to the curvature they become very
    //    distorted at the furthest out of the water".
    //
    //    The pattern is transported ALONG THE REFLECTED RAY, and the areal
    //    stretch of a beam landing on a surface is 1/|cos(incidence)|. So the
    //    missing term is the cosine itself, and it is missing in the strongest
    //    possible sense: at a 60 deg sun the sea's reflected light travels
    //    nearly straight up, cos(incidence) on a vertical topside is ~0.5 and
    //    heading to 0 at noon, and the old code lit it at FULL strength there.
    //    Measured stretch on a vertical side: 1.4x square to a 45 deg sun,
    //    2.8x at 45 deg off it, past 2x everywhere once the sun clears 60 deg.
    //    Fading by the cosine takes the contribution out exactly as the stretch
    //    diverges, and it is physics rather than a tuned curve. It also
    //    SUBSUMES `facing` (a deck's cosine is negative), which is kept only so
    //    that `reflectedIncidence` = 0 restores the old behaviour exactly.
    const incidence =
      receiverNormal === undefined
        ? float(1)
        : mix(
            float(1),
            // ray direction is (drift.x, 1, drift.z) normalized; light TRAVELS
            // along it, so it lands on a face whose normal opposes it. Clamped
            // to [0,1] at source (§V.44) — a non-unit normal cannot amplify.
            vec3(refl.drift.x, 1, refl.drift.y)
              .normalize()
              .dot(receiverNormal)
              .negate()
              .clamp(0, 1),
            u.reflectedIncidence,
          );
    const overwater = vec3(reflResp.bright)
      .mul(heightFade)
      .mul(facing)
      .mul(incidence)
      .mul(u.reflectedStrength)
      .mul(refl.valid);
    bright = mix(overwater, underwater, submerged);
    darken = mix(
      // the darkening rides the SAME two gates — a gate applied to the bright
      // lobe alone leaves a shadow cast by light that is no longer arriving
      // ... and `incidence` is one of those gates, or a bow would keep an
      // inter-filament shadow cast by a pattern no longer being drawn on it
      mix(
        float(1),
        reflResp.darken,
        refl.valid.mul(heightFade).mul(facing).mul(incidence).mul(gate),
      ),
      darken,
      submerged,
    );
  }

  return {
    bright: bright.mul(u.strength).mul(gate).max(0),
    darken: darken.clamp(0, 1),
  };
}
