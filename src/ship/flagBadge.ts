/**
 * Jolly Roger, drawn as signed-distance shapes in the flag's own UV space —
 * no texture, no atlas, no asset (§C "procedural where possible").
 *
 * Everything is smoothstepped rather than stepped: this mask multiplies the
 * flag's albedo, and a hard edge on a 2 m flag seen from 40 m away aliases
 * into a crawling fringe as the cloth ripples.
 *
 * §V23: functional smoothstep(e0, e1, x) only, edges always low→high.
 */
import { float, max, min, smoothstep, vec2 } from 'three/tsl';

/** any TSL node — this is structural shape maths, not a typed graph */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

/** antialias width in badge units (the badge is ~1 unit tall) */
const AA = 0.014;

/** 1 inside a disc of radius r centred at (cx, cy), 0 outside */
function disc(q: Node, cx: number, cy: number, r: number): Node {
  const d = q.sub(vec2(cx, cy)).length();
  return float(1).sub(smoothstep(float(r - AA), float(r + AA), d));
}

/** 1 inside a rounded bar of half-length hl, half-width hw, rotated by `ang` */
function bar(q: Node, cx: number, cy: number, hl: number, hw: number, ang: number): Node {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const p = q.sub(vec2(cx, cy));
  // rotate INTO the bar's frame
  const rx = p.x.mul(c).add(p.y.mul(s));
  const ry = p.x.mul(-s).add(p.y.mul(c));
  const alongEnd = max(rx.abs().sub(hl), float(0));
  const d = vec2(alongEnd, ry).length();
  return float(1).sub(smoothstep(float(hw - AA), float(hw + AA), d));
}

/**
 * Skull-and-crossbones coverage mask for flag UVs.
 *
 * @param u  0 at the hoist … 1 at the fly
 * @param v  0 at the foot … 1 at the head
 * @param aspect  fly ÷ hoist — corrects u so the skull is round, not oval on
 *                a flag that is wider than it is tall
 * @returns 0..1 badge coverage
 */
export function jollyRoger(u: Node, v: Node, aspect: Node): Node {
  // centred a little inboard of the middle: a flag streams from its hoist, so
  // a badge dead-centre disappears round the curve of the cloth
  const q = vec2(u.sub(0.46).mul(aspect), v.sub(0.5));

  // crossed bones behind, with a knuckle at each of the four ends
  let bones: Node = bar(q, 0, -0.02, 0.3, 0.032, 0.62);
  bones = max(bones, bar(q, 0, -0.02, 0.3, 0.032, -0.62));
  for (const [bx, by] of [
    [0.244, 0.155],
    [-0.244, -0.195],
    [0.244, -0.195],
    [-0.244, 0.155],
  ] as const) {
    bones = max(bones, disc(q, bx, by, 0.052));
  }

  // cranium + jaw
  let skull: Node = disc(q, 0, 0.07, 0.17);
  skull = max(skull, bar(q, 0, -0.115, 0.055, 0.072, 0));

  // sockets: eyes, nose, and two tooth gaps cut out of the jaw
  let holes: Node = max(disc(q, -0.066, 0.085, 0.055), disc(q, 0.066, 0.085, 0.055));
  holes = max(holes, disc(q, 0, -0.005, 0.03));
  holes = max(holes, bar(q, -0.036, -0.155, 0.001, 0.016, 0));
  holes = max(holes, bar(q, 0.036, -0.155, 0.001, 0.016, 0));

  const solid = max(skull, bones);
  return min(solid, float(1).sub(holes.mul(skull)));
}
