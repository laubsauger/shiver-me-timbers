/**
 * Pure CPU mirrors of the foam GPU math (§V6) — no three imports so
 * tests/foam.test.ts runs in node without a GPU. Change one side → change
 * the other (same mirror contract as deckwater/fluxMath.ts).
 */

/**
 * Half-life → per-frame decay factor: factor = 2^(−dt/halfLife), so after
 * halfLife seconds of frames the foam value has halved exactly. This is WHY
 * the tunable is a half-life and not a raw multiplier: artists reason in
 * "foam lasts ~a second", not "multiply by 0.9906 per frame" (§V6 dissipate).
 * halfLife ≤ 0 → 0 (foam dies instantly rather than dividing by zero).
 */
export function decayFactorPerFrame(halfLifeSeconds: number, dt: number): number {
  if (halfLifeSeconds <= 0) return 0;
  return Math.pow(2, -dt / halfLifeSeconds);
}

/**
 * Injection amount for one frame (§V6): jacobian below the bias means the
 * wave surface is folding over itself → foam ∝ how far below. GPU mirror:
 * injectPass. Never negative — calm water must not scrub existing foam.
 */
export function injectAmount(
  jacobian: number,
  bias: number,
  strengthPerSecond: number,
  dt: number,
): number {
  return Math.max(0, bias - jacobian) * strengthPerSecond * dt;
}

/** accumulate with existing foam, clamped ≤ 1 (§V6: mask feeds a mix factor) */
export function accumulateFoam(previous: number, injected: number): number {
  return Math.min(1, previous + injected);
}

/**
 * 3×3 gaussian weights (1 2 1 / 2 4 2 / 1 2 1)/16, row-major. Sum is exactly
 * 1 so the blur redistributes foam without creating or destroying any —
 * foam lifetime must be controlled ONLY by the decay factor, or the
 * decayHalfLife param would lie (§V6 progressive blur).
 */
export const GAUSSIAN_3X3: readonly number[] = [
  1 / 16, 2 / 16, 1 / 16,
  2 / 16, 4 / 16, 2 / 16,
  1 / 16, 2 / 16, 1 / 16,
];

/** wrap a texel index into [0, n) — cascade foam tiles with its domain (§V6) */
export function wrapIndex(i: number, n: number): number {
  return ((i % n) + n) % n;
}

/**
 * One texel of the decay+blur pass on an n×n wrapped grid (GPU mirror:
 * blurDecayPass): blur3x3(src) · decay, taps offset by `radius` texels.
 */
export function blurDecayAt(
  src: Float32Array,
  n: number,
  x: number,
  y: number,
  radius: number,
  decay: number,
): number {
  let sum = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const sx = wrapIndex(x + Math.round(dx * radius), n);
      const sy = wrapIndex(y + Math.round(dy * radius), n);
      sum += src[sy * n + sx] * GAUSSIAN_3X3[(dy + 1) * 3 + (dx + 1)];
    }
  }
  return Math.min(1, sum * decay);
}

/** below this direction magnitude the crest frame is undefined */
export const CREST_GRAD_EPS = 1e-4;

/**
 * Crest-aligned blur tap offset in texels (GPU mirror: blurDecayPass).
 *
 * WHY (user critique "foam caps are too circular, not following the cap of
 * the wave"): an axis-aligned isotropic 3×3 blur run every frame turns each
 * injected fold into a round blob. Whitecaps are ridges — they must spread
 * ALONG the crest line and barely across it. `acrossX/acrossZ` is the
 * across-crest direction (wave propagation); the frame is therefore
 * (tangent = perp(across) along the ridge, normal = across), stretched
 * `along` on the tangent and squashed `acrossScale` on the normal.
 *
 * The direction is UNIFORM over the field, not derived per texel from ∇h,
 * and that is load-bearing rather than a simplification:
 *  - ∇h VANISHES exactly at a crest line (the height turns over there) and
 *    flips sign across it, so a per-texel frame is at its most unstable
 *    precisely where foam is injected;
 *  - a frame that rotates between neighbouring texels makes this gather-form
 *    blur non-conservative — it sheds foam every frame, which quietly ate
 *    whitecaps (user: "I think we're missing some foam caps");
 *  - a constant frame is shift-invariant, so the kernel provably conserves
 *    mass and decayHalfLife remains the only thing that removes foam (§V6);
 *  - it is also cheaper: no neighbour texture loads at all (§V17).
 * Crest lines are statistically perpendicular to wave propagation, which is
 * also what §V7 asks storm foam to look like — streaks running with the swell.
 *
 * Degenerate direction → axis frame, which for the symmetric gaussian kernel
 * reproduces the isotropic blur exactly.
 */
export function crestTapOffset(
  acrossX: number,
  acrossZ: number,
  dx: number,
  dy: number,
  along: number,
  acrossScale: number,
): [number, number] {
  const len = Math.hypot(acrossX, acrossZ);
  const nx = len > CREST_GRAD_EPS ? acrossX / len : 0;
  const ny = len > CREST_GRAD_EPS ? acrossZ / len : 1;
  // tangent = perp(normal): runs along the crest ridge
  const tx = -ny;
  const ty = nx;
  return [
    tx * dx * along + nx * dy * acrossScale,
    ty * dx * along + ny * dy * acrossScale,
  ];
}

/**
 * One texel of the crest-aligned decay+blur pass (GPU mirror: blurDecayPass).
 * `acrossX/acrossZ` = across-crest (wave propagation) direction, uniform over
 * the field — see crestTapOffset for why it is not derived per texel.
 * along = acrossScale = 1 collapses to blurDecayAt (same weights, mirrored
 * taps). The frame is a rotation and the weights sum to 1, so this conserves
 * foam EXACTLY: decayHalfLife stays the only thing that removes it (§V6).
 */
export function blurDecayAnisoAt(
  src: Float32Array,
  acrossX: number,
  acrossZ: number,
  n: number,
  x: number,
  y: number,
  radius: number,
  along: number,
  acrossScale: number,
  decay: number,
): number {
  let sum = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const [ox, oy] = crestTapOffset(acrossX, acrossZ, dx, dy, along, acrossScale);
      const sx = wrapIndex(x + Math.round(ox * radius), n);
      const sy = wrapIndex(y + Math.round(oy * radius), n);
      sum += src[sy * n + sx] * GAUSSIAN_3X3[(dy + 1) * 3 + (dx + 1)];
    }
  }
  return Math.min(1, sum * decay);
}
