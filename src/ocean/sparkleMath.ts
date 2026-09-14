/**
 * Mean of smoothstep(radius, 0, distance) over a unit square sparkle cell.
 * Small discs are inset inside their cell. Discs wider than half a cell are
 * centred, so the integral must include square clipping rather than the whole
 * circle. Radius is measured in cell widths.
 */
export function sparkleDiscMean(radius: number): number {
  if (!Number.isFinite(radius) || radius < 0) {
    throw new Error('sparkle disc radius must be finite and non-negative');
  }
  // 2π∫₀ᴿ r[1 − 3(r/R)² + 2(r/R)³]dr = 3πR²/10.
  if (radius <= 0.5) return 0.3 * Math.PI * radius * radius;

  // Integrate one eighth of the square in polar coordinates. Before `angle`
  // the ray reaches the square edge at 0.5 sec(θ); afterwards it reaches the
  // disc edge. At R >= sqrt(1/2), every ray ends at the square.
  const angle = Math.min(Math.PI / 4, Math.acos(0.5 / radius));
  const tangent = Math.tan(angle);
  const secant = 1 / Math.cos(angle);
  const integral2 = tangent;
  const integral4 = tangent + tangent ** 3 / 3;
  const integral5 = secant ** 3 * tangent / 4
    + 3 * secant * tangent / 8
    + 3 * Math.log(secant + tangent) / 8;
  return 8 * (
    integral2 / 8
    - 3 * integral4 / (64 * radius * radius)
    + integral5 / (80 * radius ** 3)
    + 0.15 * radius * radius * (Math.PI / 4 - angle)
  );
}
