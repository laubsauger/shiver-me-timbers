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

/** below this gradient magnitude the crest direction is noise, not a crest */
export const CREST_GRAD_EPS = 1e-4;

/**
 * Crest-aligned blur tap offset in texels (GPU mirror: blurDecayPass).
 *
 * WHY (user critique "foam caps are too circular, not following the cap of
 * the wave"): an axis-aligned isotropic 3×3 blur run every frame turns each
 * injected fold into a round blob. Whitecaps are ridges — they must spread
 * ALONG the crest line and barely across it. The crest line is perpendicular
 * to the horizontal height gradient ∇h, so the tap frame is
 * (tangent = perp(∇h), normal = ∇h/|∇h|), stretched `along` on the tangent
 * and squashed `across` on the normal.
 *
 * Degenerate gradient (flat water) → axis frame, which for the symmetric
 * gaussian kernel reproduces the isotropic blur exactly.
 */
export function crestTapOffset(
  gradX: number,
  gradY: number,
  dx: number,
  dy: number,
  along: number,
  across: number,
): [number, number] {
  const len = Math.hypot(gradX, gradY);
  const nx = len > CREST_GRAD_EPS ? gradX / len : 0;
  const ny = len > CREST_GRAD_EPS ? gradY / len : 1;
  // tangent = perp(normal): runs along the crest ridge
  const tx = -ny;
  const ty = nx;
  return [tx * dx * along + nx * dy * across, ty * dx * along + ny * dy * across];
}

/**
 * One texel of the crest-aligned decay+blur pass (GPU mirror: blurDecayPass).
 * `height` is the wave height field the crest direction is derived from
 * (displacement.y); `src` the foam field. along = across = 1 collapses to
 * blurDecayAt (same weights, mirrored taps).
 *
 * Mass note (fail loud, §V6): the weights still sum to 1, so a locally
 * CONSTANT crest frame conserves foam exactly — a rotation moves it, it does
 * not eat it. Where the frame rotates between neighbouring texels this gather
 * form redistributes unevenly and can shed a little foam, i.e. the effective
 * lifetime in swirling water is slightly shorter than decayHalfLife.
 */
export function blurDecayAnisoAt(
  src: Float32Array,
  height: Float32Array,
  n: number,
  x: number,
  y: number,
  radius: number,
  along: number,
  across: number,
  decay: number,
): number {
  const h = (ix: number, iy: number): number =>
    height[wrapIndex(iy, n) * n + wrapIndex(ix, n)];
  const gx = h(x + 1, y) - h(x - 1, y);
  const gy = h(x, y + 1) - h(x, y - 1);
  let sum = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const [ox, oy] = crestTapOffset(gx, gy, dx, dy, along, across);
      const sx = wrapIndex(x + Math.round(ox * radius), n);
      const sy = wrapIndex(y + Math.round(oy * radius), n);
      sum += src[sy * n + sx] * GAUSSIAN_3X3[(dy + 1) * 3 + (dx + 1)];
    }
  }
  return Math.min(1, sum * decay);
}
