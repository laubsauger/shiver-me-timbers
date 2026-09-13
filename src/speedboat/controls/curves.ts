/** Stick shaping: deadzone with rescale, then a power response curve. Pure, used by boatControls. */

/**
 * Axial deadzone WITH rescale: |v| ≤ inner → 0, then linear from 0 at `inner` to ±1 at `outer`, clamped. Without the
 * rescale the first usable value is `inner` itself — a step the helm feels as a jump off centre.
 */
export function deadzone(v: number, inner: number, outer = 1): number {
  if (!Number.isFinite(v)) return 0;
  const a = Math.abs(v);
  if (a <= inner) return 0;
  const t = (a - inner) / Math.max(1e-6, outer - inner);
  return Math.sign(v) * (t > 1 ? 1 : t);
}

/** sign-preserving power curve: exponent > 1 = finer near centre, full at the stops */
export function responseCurve(v: number, exponent: number): number {
  const c = v < -1 ? -1 : v > 1 ? 1 : v;
  return Math.sign(c) * Math.pow(Math.abs(c), exponent);
}

export function shapeAxis(v: number, inner: number, exponent: number, outer = 1): number {
  return responseCurve(deadzone(v, inner, outer), exponent);
}
