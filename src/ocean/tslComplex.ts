/**
 * Complex-number helpers for TSL spectrum/FFT passes (§V.4).
 * A complex value is a vec2: (re, im).
 */
import { Fn, vec2 } from 'three/tsl';

/** complex multiply */
export const cmul = /*@__PURE__*/ Fn(([a, b]: any[]) =>
  vec2(
    a.x.mul(b.x).sub(a.y.mul(b.y)),
    a.x.mul(b.y).add(a.y.mul(b.x)),
  ),
);

/** A + i·B where A, B are complex — packs two real-output FFTs into one */
export const addImag = /*@__PURE__*/ Fn(([a, b]: any[]) =>
  vec2(a.x.sub(b.y), a.y.add(b.x)),
);

/** i·h — 90° rotation */
export const imul = /*@__PURE__*/ Fn(([a]: any[]) => vec2(a.y.negate(), a.x));

/** e^{iθ} */
export const expi = /*@__PURE__*/ Fn(([theta]: any[]) =>
  vec2(theta.cos(), theta.sin()),
);
