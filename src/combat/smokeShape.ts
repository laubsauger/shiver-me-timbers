/**
 * The smoke sprite's SILHOUETTE — a torn contour instead of a disc.
 *
 * ── WHY A DISSOLVE AND NOT A NICER FILL ────────────────────────────────
 * The sprite's alpha is `1 - |q|²` raised to a power: round level sets BY
 * CONSTRUCTION, so a burst of them is a cluster of discs however the inside
 * is shaded. That is §V.65 stated exactly — "detail MULTIPLIED onto a mask's
 * interior leaves the OUTLINE untouched, and the eye reads the outline" — and
 * §B.39 is the same defect one system over: foam read as discs because value
 * noise has round level sets, and the cure that finally worked was a per-texel
 * DISSOLVE THRESHOLD so the boundary became the noise's own torn contour.
 * User, this round: "Not just circular puffs".
 *
 * ── WHAT IT FADES TOWARD, WHICH IS THE WHOLE §V.48/§V.70 QUESTION ──────
 * §V.70's diagnostic: ask what ONE infinitely-distant pixel sees. A sprite
 * whose tear has gone sub-pixel averages back to the SMOOTH DISC at its
 * original alpha — not to zero (that would delete the puff at range) and not
 * to flat. So the tear is written as a ZERO-MEAN PERTURBATION of the disc:
 *
 *     tear  = 1 + amount x keep x (2·torn - 1)      mean(torn) = ½
 *     alpha = disc x tear
 *
 * `torn` is a smoothstep of symmetric noise about its own median, so its mean
 * is ½ and `2·torn - 1` has mean ZERO. The far limit is therefore EXACTLY
 * `disc` — the plain sprite — with no correction factor to get wrong, and the
 * §V.48b "fade to its own mean" half is satisfied by construction rather than
 * by a fudge. `keep` (bandLimitAmplitude) is that fade; `bandLimitWidth`
 * supplies the §V.48a WIDEN half, holding the transition at ≥ 2 px of the
 * noise coordinate's own footprint so the function never varies faster than
 * the sample grid.
 *
 * §V.44: `amount ∈ [0,1]` and `keep ∈ [0,1]`, so `tear ∈ [0,2]` — bounded at
 * source. Bloom is live and an unbounded multiplier here would glare.
 *
 * §V.57 SAFETY: this graph is built from `createCombatFx`, a plain function
 * called at BOOT, not inside a live `Fn()` body. Every node here is therefore
 * a pure expression tree — no `.assign`, no `.toVar()`, no `Loop` — because
 * a TSL mutator outside `Fn()` is silently DROPPED (§B.31 cost the ocean its
 * entire turbulent sub-noise that way, with two console lines as the only
 * tell). `fbm2` was checked and qualifies: it reassigns a JS local and
 * unrolls at build time.
 */
import { float, smoothstep, vec2 } from 'three/tsl';
import { fbm2 } from '../terrain/noise';
import { bandLimitAmplitude, bandLimitWidth } from '../ship/bandLimit';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyNode = any;

/**
 * fbm octaves in the tear. A MODULE CONSTANT and deliberately not a param:
 * `fbm2` unrolls at build time, so this can only change on a material
 * rebuild, and §V.62 is unambiguous that a knob which cannot drive anything
 * at runtime must not be offered as one ("wire the sink IN THE SAME CHANGE as
 * the knob, or do not add the knob" — ten occurrences and counting). It is a
 * cost/quality decision, so it is edited here, in one line, on purpose.
 */
const DISSOLVE_OCTAVES = 2;

/**
 * The finest lobe a `DISSOLVE_OCTAVES` fbm produces, in its OWN coordinate
 * units: the top octave runs at `lacunarity^(n-1)`, so its features are that
 * much smaller than the base cell. THIS is the width the band limit must be
 * measured against — §V.48's sixth-occurrence lesson was that limiting
 * against the REPEAT instead of the SHARPEST FEATURE leaves everything in
 * between speckling (§B.20: a 0.044 m seam gated on a 0.55 m plank, 12x too
 * late).
 */
const FINEST_LOBE = 1 / 2 ** (DISSOLVE_OCTAVES - 1);

/** authored half-width of the tear's edge, in noise-coordinate units */
const EDGE_HALF_WIDTH = 0.16;

/**
 * Build the torn-alpha node.
 *
 * @param disc    the plain radial falloff — the alpha this replaces
 * @param uvNode  the sprite's own uv (0..1)
 * @param amount  per-instance tear strength, 0 for non-smoke kinds
 * @param seed    per-instance 0..1, decorrelates one puff's tear from the next
 * @param scale   noise cells across the sprite (live uniform)
 */
export function tornAlpha(
  disc: AnyNode,
  uvNode: AnyNode,
  amount: AnyNode,
  seed: AnyNode,
  scale: AnyNode,
): AnyNode {
  // each puff tears differently: without the offset every sprite in a burst
  // carries the IDENTICAL contour and the cluster reads as one stamped shape
  // repeated, which is the uniformity complaint this project keeps paying for
  const offset = vec2(seed.mul(37.1), seed.mul(17.3));
  const coord = uvNode.add(offset).mul(scale);

  // scalar footprint of the noise coordinate. coordFilter returns a vec2 for
  // a vec2 coord, so the two axes are collapsed with max() — the conservative
  // choice, since under-reporting the filter is what lets aliasing through.
  const d = coord.dFdx().abs().add(coord.dFdy().abs());
  const filter = d.x.max(d.y);

  // §V.48a WIDEN: the transition is never narrower than 2 px of its own coord
  const halfWidth = bandLimitWidth(float(EDGE_HALF_WIDTH), coord, filter);
  // §V.48b FADE: → 0 once the finest lobe is sub-pixel, which takes `tear`
  // to exactly 1 and leaves the plain disc (§V.70's correct limit)
  const keep = bandLimitAmplitude(float(FINEST_LOBE), coord, filter);

  const n = fbm2(coord, DISSOLVE_OCTAVES);
  // §V.23: functional smoothstep(e0, e1, x) — the chained form makes the
  // RECEIVER the factor (§B.1/§B.2 both cost a day to that reading)
  const torn = smoothstep(float(0.5).sub(halfWidth), float(0.5).add(halfWidth), n);

  // zero-mean perturbation: mean(2·torn − 1) = 0 because the noise is
  // symmetric about the 0.5 the threshold sits on, so the far limit is the
  // untouched disc rather than a dimmed one
  const tear = float(1).add(amount.mul(keep).mul(torn.mul(2).sub(1)));
  return disc.mul(tear.max(0));
}

/** exported for the CPU mirror in tests — the far limit must be provable */
export const DISSOLVE_CONSTANTS = {
  octaves: DISSOLVE_OCTAVES,
  finestLobe: FINEST_LOBE,
  edgeHalfWidth: EDGE_HALF_WIDTH,
};
