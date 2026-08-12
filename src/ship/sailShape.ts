/**
 * SAIL CLOTH SHAPE — one definition, two evaluators.
 *
 * The sail's belly, luff shake and flutter are computed in the vertex stage,
 * so the world position of any point ON the canvas is normally known only
 * GPU-side. That is fine until something outside the shader needs it, and now
 * something does: src/ropes anchors sheets, tacks and buntlines to the sail's
 * clews and foot, and its whole contract is `socketWorldPosition(id) → [x,y,z]`
 * evaluated on the CPU once per frame (§V12 keeps rope descriptors CPU-owned).
 *
 * A clew anchored to the YARD instead would detach from the cloth the moment
 * there is any wind — the same failure as §V.45's ratlines floating off their
 * sagging shrouds, and it has the same answer: one source of truth for where
 * the thing actually is.
 *
 * So the shape lives here as a plain function, and sailMaterial.ts builds its
 * TSL graph from the SAME constants and the same expression order. The two
 * evaluators sit in one file's worth of reading distance of each other on
 * purpose: they cannot be literally shared (one is JS arithmetic, the other is
 * a node graph), so the next best thing is that any drift is visible in a
 * side-by-side diff rather than discovered on screen.
 *
 * §V28: every divisor floored; the CPU side is the one feeding rope endpoints,
 * and a NaN here becomes a NaN rope.
 */
import type { ShipMaterialParams } from '../params/ship';

/**
 * The shape constants. sailMaterial.ts IMPORTS these rather than repeating the
 * literals — it used to carry its own copies of 0.22/0.9/0.3/1.3/2.1, which is
 * the drift this file's header warns about sitting one typo away from
 * happening. There is no cost to sharing them: they are plain numbers, and
 * only the expressions around them have to be transliterated.
 */
export const SAIL_SKEW_LEAD = 0.22; // how far the belly shifts to leeward
/**
 * VERTICAL BELLY PROFILE (user: "they have no billow to them").
 *
 * This used to be one monotone ramp — `smoothstep(0, 0.9, 1−v)` — which is
 * zero at the head and DEEPEST AT THE FOOT. That is the shape of a flag
 * blowing off a pole, not of a sail under load: the vertical section has no
 * inflection, so the whole lower sail moves forward together and the surface
 * reads as a tilted plane no matter how deep the number says it is. It shaded
 * flat because it genuinely was flat in one direction.
 *
 * A square sail is bent to its yard at the head and hauled down at the clews,
 * so the canvas is deepest around the middle and comes back at BOTH ends. The
 * foot never returns fully — it is a free edge — hence FOOT_FILL rather than
 * a second taper to zero.
 */
export const SAIL_BELLY_HEAD = 0.55; // taper span below the head, in v
export const SAIL_BELLY_FOOT = 0.45; // ease span above the foot, in v
export const SAIL_FOOT_FILL = 0.55; // belly remaining at the free foot
export const SAIL_FLUTTER_BASE = 0.3; // shake floor before luff adds to it
export const SAIL_FLUTTER_EDGE = 1.3; // extra ripple toward the leeches
export const SAIL_FLUTTER_V = 2.1; // ripple phase advance down the cloth

/**
 * Belly depth as a fraction of its peak, from the sail's own v (0 = foot,
 * 1 = head). Peaks at exactly v = 1 − SAIL_BELLY_HEAD = SAIL_BELLY_FOOT.
 * Exported so the shape can be asserted directly rather than inferred from a
 * displacement that also carries flutter.
 */
export function sailBellyProfile(v: number): number {
  const vv = clamp01(finite(v));
  const headTaper = smoothstep(0, SAIL_BELLY_HEAD, 1 - vv);
  const footEase = SAIL_FOOT_FILL + (1 - SAIL_FOOT_FILL) * smoothstep(0, SAIL_BELLY_FOOT, vv);
  return headTaper * footEase;
}

function finite(x: number, fallback = 0): number {
  return Number.isFinite(x) ? x : fallback;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / Math.max(1e-6, e1 - e0));
  return t * t * (3 - 2 * t);
}

/** the live drive state the shader is running on, as the driver computed it */
export interface SailClothState {
  /** signed belly fill (sailDynamics.sailDrive) */
  drive: number;
  /** 0..1 shake */
  luff: number;
  /** −1..1 sideways belly lag while turning */
  skew: number;
  /** continuous trim scale, 0..1 — how much canvas is actually set */
  dropScale: number;
  /** seconds; the same clock the shader's `time` node is on */
  time: number;
  /** per-sail ripple phase — hash2(width·3.71, drop·1.17)·2π in the shader */
  phase: number;
}

/**
 * Displacement of a point of canvas along the sail's local +z (forward of the
 * yard), in metres. `u` runs 0..1 across the foot from the port leech, `v`
 * runs 0..1 from foot to head — the sail's own uv, exactly as the shader
 * reads it.
 */
export function sailClothOffset(
  u: number,
  v: number,
  builtDrop: number,
  s: SailClothState,
  p: ShipMaterialParams,
): number {
  const uu = clamp01(finite(u));
  const vv = clamp01(finite(v));
  const drop = Math.max(0.01, finite(builtDrop) * clamp01(finite(s.dropScale, 1)));

  // belly: sin² across, pinned at the head, shifted to leeward while turning
  const us = clamp01(uu + finite(s.skew) * SAIL_SKEW_LEAD * (1 - vv));
  const arch = Math.sin(us * Math.PI);
  const across = arch * arch;
  const down = sailBellyProfile(vv);
  const belly = across * down * finite(s.drive) * p.sailBillow * drop;

  // flutter: travelling ripples, biggest at the free foot and the leeches
  const luff = finite(s.luff);
  const shake = SAIL_FLUTTER_BASE + luff * p.sailLuffFlap;
  const rippleFreq = p.sailFlutterFreq * (1 + luff);
  const wave = Math.sin(
    finite(s.time) * rippleFreq
      + finite(s.phase)
      + uu * (p.sailRippleCount * Math.PI * 2)
      + vv * SAIL_FLUTTER_V,
  );
  const edge = 0.35 + Math.abs(uu - 0.5) * SAIL_FLUTTER_EDGE;
  const flutter = wave * p.sailFlutterAmp * shake * (1 - vv) * edge;

  return finite(belly + flutter);
}

/**
 * Full piece-local position of a point of canvas: the flat panel position,
 * shortened from the foot up by the trim scale, plus the cloth displacement.
 * This is the function a sail-attached socket resolves through.
 */
export function sailClothPoint(
  u: number,
  v: number,
  width: number,
  builtDrop: number,
  s: SailClothState,
  p: ShipMaterialParams,
): [number, number, number] {
  const uu = clamp01(finite(u));
  const vv = clamp01(finite(v));
  const scale = clamp01(finite(s.dropScale, 1));
  // the panel spans x ∈ [−width/2, width/2] and hangs from y = 0 down to
  // y = −drop; the shader scales y about the head, so the foot comes UP
  const x = (uu - 0.5) * width;
  const y = -(1 - vv) * Math.max(0.01, finite(builtDrop)) * scale;
  return [x, y, sailClothOffset(uu, vv, builtDrop, s, p)];
}

/** where each sail-attached anchor is sewn, in the sail's own uv */
export const SAIL_ANCHOR_UV: Record<string, [number, number]> = {
  // the two lower corners: sheets lead aft from here, tacks forward. This is
  // the pair the user noticed missing — "some of them should actually attach
  // to the sails in the appropriate spots".
  'clew-port': [0, 0],
  'clew-starboard': [1, 0],
  // buntlines gather the foot up to the yard; they run from the FOOT, up the
  // front of the sail and over the spar, which is the most recognisable
  // running-rigging shape on a square rig
  'bunt-port': [0.3, 0],
  'bunt-starboard': [0.7, 0],
};
