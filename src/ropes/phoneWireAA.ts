/**
 * §V41 phone-wire anti-aliasing — CPU reference of the maths the rope vertex
 * stage runs (ropeMesh.ts mirrors this term for term; the GPU side cannot be
 * unit-tested, so this file is the tested ground truth, exactly as
 * catenaryMath.ts is for the §V12 solve).
 *
 * THE PROBLEM. A rope is a tube of FIXED world radius (0.022–0.05 m). Its
 * projected width shrinks with distance, and once it falls under one pixel the
 * rasteriser either misses the pixel centre — the line goes dashed, and the
 * dashes crawl as the ship moves — or catches it at full strength, which
 * shimmers. Neither is fixable by more samples: the geometry is genuinely
 * sub-pixel, and at a 4.6 km horizon most of the rig is.
 *
 * THE FIX [Persson, "Phone Wire AA", 2012]. Never draw a wire thinner than
 * about a pixel. Clamp the drawn width to `minWidthPx` and multiply alpha by
 * `trueWidth / drawnWidth`. The wire stays a continuous, stable line, and
 * because coverage × alpha is preserved its total contribution — its ENERGY —
 * is exactly what the thin tube would have deposited. It fades out smoothly
 * instead of breaking up.
 *
 * WHY EVERYTHING HERE IS IN PIXELS, NEVER METRES. A distance threshold in
 * metres silently means something different at another FOV, another resolution
 * or in the half-res reflection pass — the §V36 lesson, and §B12 is what it
 * costs. Projected width in pixels is the quantity the artefact actually
 * depends on, so it is the quantity the regimes switch on.
 */

/** guards every divisor here — a rope exactly at the eye must not produce NaN
 *  and feed it into a vertex position (§V28, and §B5 for what that costs) */
const EPS = 1e-6;

/** Tunables the renderer feeds in; all widths are in PIXELS (see header). */
export interface PhoneWireParams {
  /** never draw a rope thinner than this. ~1 px is the technique's premise */
  minWidthPx: number;
  /** at or below this projected width the far regime owns the rope entirely */
  farWidthPx: number;
  /** at or above this it is the near regime's shaded tube. > farWidthPx */
  nearWidthPx: number;
}

/**
 * Projected width IN PIXELS of a tube of world `radius` seen `distance` away.
 *
 * Derived from the perspective projection: a half-width of r at view depth d
 * subtends r·f/d in NDC (f = 1/tan(fovY/2)), and NDC spans 2 across the
 * viewport, so the full width covers r·f/d·viewportHeightPx pixels. The
 * shader does the same thing without ever seeing an angle, by pushing a
 * view-space offset through the projection matrix.
 */
export function projectedWidthPx(
  radius: number,
  distance: number,
  viewportHeightPx: number,
  fovYRadians: number,
): number {
  const f = 1 / Math.max(Math.tan(fovYRadians / 2), EPS);
  return (radius * f * viewportHeightPx) / Math.max(distance, EPS);
}

/**
 * The phone-wire response for a projected width.
 *
 * `widen` ≥ 1 scales the rope's RADIUS so the drawn width never goes under
 * minWidthPx; `alpha` ≤ 1 pays that widening back. Their product is 1 by
 * construction, which is the whole trick — see `perceivedWidthPx`.
 */
export function phoneWire(
  projectedPx: number,
  params: PhoneWireParams,
): { widen: number; alpha: number; drawnWidthPx: number } {
  const width = Math.max(projectedPx, 0);
  const widen = Math.max(1, params.minWidthPx / Math.max(width, EPS));
  // equivalently 1/widen, written so a zero-width rope is alpha 0, not 0/0
  const alpha = Math.min(1, width / Math.max(params.minWidthPx, EPS));
  return { widen, alpha, drawnWidthPx: width * widen };
}

/**
 * How far into the FAR regime a rope is: 0 = near (shaded tube with normals),
 * 1 = far (simple translucent line, no normals). Smooth across the band so
 * the two regimes crossfade rather than pop (§V41).
 *
 * Reading: `smoothstep(farWidthPx, nearWidthPx, width)` is 0 at the far edge
 * and 1 at the near edge — the FUNCTIONAL 3-arg form, never the chained
 * receiver-is-factor one (§V23/§B1). Inverted because thin means far.
 */
export function farness(projectedPx: number, params: PhoneWireParams): number {
  const e0 = params.farWidthPx;
  const e1 = Math.max(params.nearWidthPx, e0 + EPS);
  const t = Math.min(1, Math.max(0, (projectedPx - e0) / (e1 - e0)));
  return 1 - t * t * (3 - 2 * t);
}

/**
 * What the viewer actually receives: drawn width × total alpha, summed over
 * both regimes. THE invariant of §V41 — this must equal the true projected
 * width at every distance, and must be continuous through both the regime
 * crossfade and the one-pixel clamp. If it ever steps, ropes visibly pop or
 * flicker as the camera pulls away, which is the artefact the whole feature
 * exists to remove.
 *
 * Both regimes draw at the SAME widened radius, so their alphas simply share
 * the rope between them: (1 − farness) + farness = 1.
 */
export function perceivedWidthPx(
  projectedPx: number,
  params: PhoneWireParams,
): number {
  const { alpha, drawnWidthPx } = phoneWire(projectedPx, params);
  const far = farness(projectedPx, params);
  const nearAlpha = (1 - far) * alpha;
  const farAlpha = far * alpha;
  return drawnWidthPx * (nearAlpha + farAlpha);
}
