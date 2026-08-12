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
import { oceanParams } from '../params/ocean';
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
    const t = texture(c.derivatives, cascadeUv(worldXZ, c.domain));
    der = der === null ? t : der.add(t);
  }
  // (∂h/∂x, ∂h/∂z, ∂Dx/∂x, ∂Dz/∂z) → true slope needs the choppy stretch out
  const a11 = float(1).add(der.z.mul(u.choppiness)).max(0.05); // floored (§V28)
  const a22 = float(1).add(der.w.mul(u.choppiness)).max(0.05);
  return { g: vec2(der.x.div(a11), der.y.div(a22)), a11, a22 };
}

/** world Y of the sea surface at a world XZ, summed over all cascades */
export function waterHeightNode(sim: OceanSimulation, worldXZ: TslNode): TslNode {
  let h: TslNode = null;
  for (const c of sim.cascades) {
    const t = texture(c.displacement, cascadeUv(worldXZ, c.domain)).y;
    h = h === null ? t : h.add(t);
  }
  return h;
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
  const submerged = smoothstep(
    u.waterlineBlend.negate(), u.waterlineBlend, depth,
  );

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
    const overwater = vec3(reflResp.bright)
      .mul(heightFade)
      .mul(facing)
      .mul(u.reflectedStrength)
      .mul(refl.valid);
    bright = mix(overwater, underwater, submerged);
    darken = mix(
      // the darkening rides the SAME two gates — a gate applied to the bright
      // lobe alone leaves a shadow cast by light that is no longer arriving
      mix(float(1), reflResp.darken, refl.valid.mul(heightFade).mul(facing).mul(gate)),
      darken,
      submerged,
    );
  }

  return {
    bright: bright.mul(u.strength).mul(gate).max(0),
    darken: darken.clamp(0, 1),
  };
}
