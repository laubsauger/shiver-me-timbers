/**
 * WAVE SHOALING (§V.8, §V.19, §V.72) — the sea calms itself over its own
 * shallows, and roughens back to the open-ocean swell on its own.
 *
 * THE ASK (user): "the swell should probably, at least towards beaches, tame
 * down — a little bit further out, and then blend into the open ocean swell …
 * so that we can still have rough cliffs basically, where the waves are just
 * doing what they're doing. But we should probably have some mechanism where,
 * if we generate shallows and beaches, that would automatically calm a certain
 * little area around this and then blend to open ocean."
 *
 * THE ONE DESIGN DECISION, AND IT IS WHY "ROUGH CLIFFS" NEEDS NO CODE:
 * everything here keys off DEPTH, never off distance to land. A shelving sand
 * beach has a wide band of shallow water, so it gets a wide zone of calm sea
 * and gentle lapping. A cliff plunging into 40 m has NO shallow band at all,
 * so it gets no attenuation and the sea stays rough right up to the rock.
 * The user's artistic direction falls out of the physics. DO NOT ADD A CLIFF
 * EXCEPTION — there is nothing for it to except.
 *
 * TWO TERMS, and they are deliberately disjoint (measured, see below):
 *
 *  A. LINEAR SHOALING — `shoalFactor` = tanh(k·d), per cascade. This is not a
 *     smoothstep somebody liked the shape of: tanh(k·d) IS the deep/shallow
 *     transition function of linear wave theory (the same factor appears in
 *     the dispersion relation ω² = g·k·tanh(k·d) and in the dynamic pressure),
 *     and it reaches 0.996 at d = λ/2 — the textbook "a wave feels the bottom
 *     below half its wavelength" — for free, with no authored endpoints.
 *     Because k is PER CASCADE (§V.19 band-splits them), long swell calms far
 *     offshore and short chop stays lively until it is almost aground, which
 *     is what makes this read as real rather than as a global fade.
 *
 *  B. DEPTH-LIMITED BREAKING — `breakerClip`, a soft clip on the SUMMED
 *     elevation. Exact identity while the wave occupies less than
 *     `shoalBreakerIndex` of the local water column (0.78, the McCowan breaker
 *     index — below it a wave is not breaking, so leave it alone), then
 *     saturating smoothly to `shoalColumnCeiling` (0.85), which is a hard
 *     guarantee that (1 − ceiling)·d of water always remains.
 *
 *     MEASURED, and this is why B is safe to ship: over 60 s of the CpuOcean
 *     mirror at every depth from 1 m to 200 m, term B NEVER FIRES at calm or
 *     at swell — 0.00% of samples reach the knee. The shipped seas therefore
 *     get pure linear shoaling and their look cannot move. It engages only at
 *     storm (21.6% of the surface at d = 1 m, 7.0% at 10 m, 0.8% at 20 m,
 *     0 at 45 m), which is the sea state that would otherwise drain the whole
 *     island: storm's raw trough is −24.3 m, so today everything shallower
 *     than 24 m goes dry once a cycle.
 *
 * WHAT IS DELIBERATELY NOT MODELLED, so it does not read as a physics error:
 * real shoaling STEEPENS AND GROWS waves before they break (Green's law, the
 * shoaling coefficient Ks = √(cg_deep/cg_local) > 1). We attenuate only. Two
 * reasons: the user asked for calming, and our world is scale-compressed, so a
 * growth term near shore would fight the runup/swash system that already owns
 * the beach (src/terrain/shoreRunup.ts). This is an artistic simplification
 * made on purpose, not an omission.
 *
 * THE ONE HONEST COMPRESSION — `shoalWavenumberFloor`. Our sea floor is 45 m
 * (islandParams.seabedOpenDepth) where a real 143 m storm swell would need
 * 71 m to be in deep water, so the uncompressed criterion would damp the OPEN
 * OCEAN by 37% at storm. The floor pins every band's transition inside the
 * depth range the world actually has. Measured consequence: 1 − tanh(k·45) =
 * 5.7e-5 for every band at every preset, i.e. the shipped open ocean cannot
 * move. That is the whole price, and it is paid in one number.
 *
 * §V.8 — THE TRANSLITERATION PAIR. The GPU displacement and the CPU mirror the
 * ship floats on must agree, so both sides call the CPU functions here or
 * their TSL twins immediately below them (same convention as bandLimit.ts,
 * shoreRunup.ts, foamMath.ts). A one-sided change floats the hull at
 * open-ocean height over a calmed lagoon. See §V.72 for the two traps that
 * make "same formula" insufficient on its own: WHERE the depth is sampled,
 * and WHAT it is measured against.
 *
 * §V.23: no 3-arg chained math here at all — every expression is 1- or 2-arg.
 * §V.28: every divisor floored.
 */
import { float } from 'three/tsl';

/** any TSL node — this math is structural, not typed (file-local convention) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNode = any;

/** floor for every divisor here (§V.28) */
const EPS = 1e-6;

/**
 * tanh, WRITTEN OUT, because three r180's TSL has no `tanh` — `MathNode` ships
 * `tan` and stops there (verified in node_modules; the full op list is SIN,
 * COS, TAN, ASIN, ACOS, ATAN). The identity is
 *   tanh(x) = 1 − 2/(e^{2x} + 1)
 * which is the numerically friendly form for the x ≥ 0 branch this file uses:
 * e^{2x} overflows to +inf rather than to NaN, 2/inf is 0, and the result
 * saturates cleanly at 1 instead of going undefined. Both sides use this
 * expression rather than `Math.tanh` so the CPU mirror and the shader agree
 * on the same rounding, not merely on the same limit.
 */
export function tanhCpu(x: number): number {
  return 1 - 2 / (Math.exp(2 * x) + 1);
}

/** TSL twin of `tanhCpu` — see it for why this is not a library call */
export function tanhNode(x: AnyNode): AnyNode {
  return float(1).sub(float(2).div(x.mul(2).exp().add(1)));
}

/** the three dimensionless constants this file is parameterised by (§V.16) */
export interface ShoalingParams {
  /** fraction of the seabed's open depth by which every band is open-ocean */
  shoalDeepFraction: number;
  /** fraction of the local column a wave may occupy before breaking bites */
  shoalBreakerIndex: number;
  /** fraction of the local column a wave may NEVER exceed */
  shoalColumnCeiling: number;
}

/**
 * THE COMPRESSION, and the only art decision in this file.
 *
 * A band with wavenumber k is back to full open-ocean amplitude once
 * tanh(k·d) ≈ 1, i.e. once k·d ≥ π (tanh(π) = 0.9963). We require that to
 * happen at or before `shoalDeepFraction` of the world's own open-ocean depth,
 * which floors k at π/(fraction·openDepth). Bands shorter than that are
 * untouched and keep their true physical gate; only the long swell — whose
 * real gate is deeper than our sea floor — is pulled in.
 *
 * At the shipped 45 m open depth and 0.6, the floor is λ = 54 m. Ordering
 * after the floor, on the swell preset: cascade 0 at 54 m, cascade 1 at 22 m,
 * cascade 2 at 4 m — so the per-cascade behaviour §V.19 makes possible
 * survives the compression, which is the point of doing it this way rather
 * than by fading the whole sea.
 *
 * `openDepth` is DATA from the seabed field (`SeabedField.openHeight`), not an
 * import: the ocean does not depend on params/island.
 */
export function shoalWavenumberFloor(openDepth: number, p: ShoalingParams): number {
  return Math.PI / Math.max(p.shoalDeepFraction * openDepth, EPS);
}

/**
 * The band's shoaling wavenumber: its energy-weighted mean k (measured from
 * the live spectrum by `spectralMeanWavenumber`, so weather presets move it
 * for free), floored as above. One place, so the GPU uniform and the mirror's
 * per-cascade factor cannot be derived differently.
 */
export function shoalWavenumber(
  meanK: number,
  openDepth: number,
  p: ShoalingParams,
): number {
  return Math.max(meanK, shoalWavenumberFloor(openDepth, p));
}

/**
 * TERM A: how much of this band survives in `depth` metres of water, 0..1.
 * 0 at the waterline, 0.996 at d = λ/2, indistinguishable from 1 in open sea.
 */
export function shoalFactor(shoalK: number, depth: number): number {
  return tanhCpu(shoalK * Math.max(depth, 0));
}

/** TSL twin of `shoalFactor`. `shoalK` is a uniform, `depth` a node. */
export function shoalFactorNode(shoalK: AnyNode, depth: AnyNode): AnyNode {
  return tanhNode(float(shoalK).mul(depth.max(0)));
}

/**
 * TERM B, expressed once as the SATURATION 0..1 that both the clipped value
 * and its slope are built from.
 *
 * With a = |elevation|, knee = breakerIndex·d and head = (ceiling − index)·d:
 *   saturation = tanh(max(a − knee, 0) / head)
 * It is EXACTLY 0 below the knee — which is what makes term B a true no-op on
 * calm and swell rather than a small everywhere-tax — and → 1 as the wave runs
 * out of water column.
 *
 * It is also the honest measure of HOW HARD THE WATER IS BREAKING HERE, which
 * is what a shore-whitewater consumer should key on if one is ever built (see
 * the note in surfaceMaterial's foam block about why that consumer does not
 * live in the ocean material).
 */
export function breakerSaturation(
  elevation: number,
  depth: number,
  p: ShoalingParams,
): number {
  const d = Math.max(depth, 0);
  const knee = p.shoalBreakerIndex * d;
  // the HEAD ROOM between the knee and the ceiling, written as a difference of
  // the two levels rather than as (ceiling − index)·d so that knee + head is
  // the ceiling itself instead of one ULP away from it — the clip's asymptote
  // IS the guarantee, and it should not need a tolerance to be recognised
  const head = Math.max(p.shoalColumnCeiling * d - knee, EPS);
  return tanhCpu(Math.max(Math.abs(elevation) - knee, 0) / head);
}

/**
 * TERM B applied: the surface elevation a wave is allowed to reach over
 * `depth` metres of water.
 *
 * Written as `min(|y|, knee) + head·saturation` rather than as a branch,
 * because that single expression IS both cases: below the knee the saturation
 * is 0 and the min is |y|, so it returns y exactly; above it the min pins to
 * the knee and the tanh tail carries the rest. C1 at the join — the tail's
 * slope at 0 is sech²(0) = 1, matching the identity branch — so no crease
 * appears along a depth contour.
 */
export function breakerClip(elevation: number, depth: number, p: ShoalingParams): number {
  const d = Math.max(depth, 0);
  const knee = p.shoalBreakerIndex * d;
  // the HEAD ROOM between the knee and the ceiling, written as a difference of
  // the two levels rather than as (ceiling − index)·d so that knee + head is
  // the ceiling itself instead of one ULP away from it — the clip's asymptote
  // IS the guarantee, and it should not need a tolerance to be recognised
  const head = Math.max(p.shoalColumnCeiling * d - knee, EPS);
  const a = Math.abs(elevation);
  const s = tanhCpu(Math.max(a - knee, 0) / head);
  return Math.sign(elevation) * (Math.min(a, knee) + head * s);
}

/**
 * d(clipped)/d(elevation) — the factor the SHADING NORMAL has to carry, or the
 * geometry and the shading disagree on exactly the flat trough bottoms term B
 * creates (a clipped surface shaded with unclipped slopes is a flat sheet
 * wearing the reflections of a wave).
 *
 * It is free: 1 − saturation², i.e. sech² of the same argument, so the caller
 * that already has the saturation pays one multiply for it.
 */
export function breakerClipSlope(saturation: number): number {
  return 1 - saturation * saturation;
}

/**
 * TSL twin of `breakerClip` + `breakerClipSlope`. Returns both, because the
 * two share the saturation and the fragment stage needs the slope while the
 * vertex stage needs the value — computing them separately would double the
 * exp() and let them drift apart.
 */
export function breakerClipNodes(
  elevation: AnyNode,
  depth: AnyNode,
  uBreaker: AnyNode,
  uCeiling: AnyNode,
): { clipped: AnyNode; slope: AnyNode } {
  const d = depth.max(0);
  const knee = float(uBreaker).mul(d);
  // same difference-of-levels form as `breakerClip` — see the note there
  const head = float(uCeiling).mul(d).sub(knee).max(EPS);
  const a = elevation.abs();
  const s = tanhNode(a.sub(knee).max(0).div(head));
  return {
    clipped: elevation.sign().mul(a.min(knee).add(head.mul(s))),
    slope: float(1).sub(s.mul(s)),
  };
}
