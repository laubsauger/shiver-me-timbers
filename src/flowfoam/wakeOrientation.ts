/** Source-weighted line orientation: opposing travel directions share an axis.
 * Store (cos(2θ), sin(2θ)) multiplied by foam coverage. Averaging perpendicular
 * wakes gives zero anisotropy, rather than inventing a diagonal direction.
 */
export interface OrientationOps<T> {
  k(v: number): T;
  add(a: T, b: T): T;
  sub(a: T, b: T): T;
  mul(a: T, b: T): T;
  div(a: T, b: T): T;
  max(a: T, b: T): T;
}

export function orientationMoment<T>(A: OrientationOps<T>, vx: T, vz: T, weight: T): [T, T] {
  const xx = A.mul(vx, vx), zz = A.mul(vz, vz);
  const gain = A.div(weight, A.max(A.add(xx, zz), A.k(1e-6)));
  return [A.mul(A.sub(xx, zz), gain), A.mul(A.mul(A.k(2), A.mul(vx, vz)), gain)];
}

/** Apply the coverage clock and saturation to a premultiplied moment. */
export function retainOrientation<T>(A: OrientationOps<T>, previous: T, injected: T, decay: T, coverage: T, uncappedCoverage: T): T {
  return A.mul(A.add(A.mul(previous, decay), injected), A.div(coverage, A.max(uncappedCoverage, A.k(1e-6))));
}

/** Blend fixed 0°, 45°, 90° and 135° detail fields. Never multiply a spatially
 * varying orientation by an absolute world position: its derivative includes
 * worldPosition × gradient(orientation), producing combs far from the origin.
 * Opposite headings share an axis; incoherent crossings mix all four fields.
 */
export function orientationWeights<T>(A: OrientationOps<T>, qx: T, qz: T): [T, T, T, T] {
  const zero = A.k(0);
  const values = [qx, qz, A.sub(zero, qx), A.sub(zero, qz)];
  const coherence = A.max(A.max(values[0], values[2]), A.max(values[1], values[3]));
  const isotropic = A.mul(A.max(zero, A.sub(A.k(1), coherence)), A.k(0.25));
  const weights = values.map(v => A.add(A.max(zero, v), isotropic));
  const total = weights.reduce((a, b) => A.add(a, b));
  return weights.map(w => A.div(w, total)) as [T, T, T, T];
}
