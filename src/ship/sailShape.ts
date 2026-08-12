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
export const SAIL_SKEW_LEAD = 0.22; // how far the DRAFT shifts to leeward
/**
 * HORIZONTAL DRAFT PROFILE (user: "way too steep a bulge in the middle and
 * then nothing towards the sides… it has to be more distributed").
 *
 * This used to be `sin²(πu)`, and the vertical profile below was MULTIPLIED
 * into it. Two centred bumps in a product is the worst possible arrangement:
 * measured over a whole course, the mean depth came to 0.31 of the peak, and
 * one tenth of the way in from a leech the cloth was at 9.5% of full — i.e.
 * the outer fifth of the sail on each side was flat panel, with all the shape
 * crammed into a lens in the middle. sin² also leaves BOTH edges with zero
 * slope, so the canvas lies down tangent to the flat plane at the leeches
 * rather than pulling away from them.
 *
 * The replacement is the actual small-deflection solution for a membrane
 * under uniform pressure with both edges held: a PARABOLA. It carries 0.66 of
 * its peak as a mean (+29% of average depth at the same peak) and leaves each
 * leech at a real angle. `sailDraftFullness` is the exponent on it — 1 is the
 * membrane, higher narrows back toward the old lens — and `sailDraftPos`
 * moves the deepest point, which on real canvas sits about 40% aft of the
 * luff rather than at the midpoint.
 *
 * Both leeches still go to exactly zero. They are bolt-roped and sheeted, so
 * a belly that did not close there would tear the cloth off its own edges —
 * "distributed" means the falloff is a boundary layer at the edge, not the
 * whole half-width.
 */
export const SAIL_DRAFT_MIN = 0.28; // draft cannot crowd the luff…
export const SAIL_DRAFT_MAX = 0.72; // …nor the leech
export const SAIL_LEAD_MAX = 0.3; // |lead|·π < 1 keeps the warp monotone
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

/**
 * Warp lead that puts the section's deepest point at `draftPos`.
 *
 * The section itself is symmetric, so the draft is moved by warping u through
 * `u + lead·sin(πu)` — endpoints fixed (the leeches stay pinned), smooth, and
 * monotone as long as |lead|·π < 1. That last part is not cosmetic: a warp
 * that folds maps two points of cloth onto one, which is a self-intersecting
 * sail. Hence SAIL_LEAD_MAX, and the draft band it corresponds to.
 */
export function sailDraftLead(draftPos: number): number {
  const d = clamp(finite(draftPos, 0.4), SAIL_DRAFT_MIN, SAIL_DRAFT_MAX);
  const lead = (0.5 - d) / Math.max(1e-3, Math.sin(Math.PI * d)); // §V28 floored
  return clamp(lead, -SAIL_LEAD_MAX, SAIL_LEAD_MAX);
}

/**
 * Section depth as a fraction of the draft, across the cloth from the port
 * leech (u = 0) to the starboard one (u = 1). Exported so the DISTRIBUTION can
 * be asserted directly — a re-centred or re-narrowed bulge is a shape bug that
 * no displacement-magnitude test can see.
 */
export function sailDraftProfile(u: number, lead: number, fullness: number): number {
  const uu = clamp01(finite(u));
  const w = clamp01(uu + finite(lead) * Math.sin(Math.PI * uu));
  // membrane under uniform pressure, both edges held
  const arc = Math.max(0, 4 * w * (1 - w));
  return Math.pow(arc, Math.max(0.5, finite(fullness, 1)));
}

function finite(x: number, fallback = 0): number {
  return Number.isFinite(x) ? x : fallback;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
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

  // belly: a membrane section across the cloth × the vertical profile. The
  // ship's swing lags the DRAFT to leeward rather than translating the whole
  // curve — translating it walked the belly off the leech (at full skew the
  // old form left 44% of the peak standing at the bolt rope), and the leeches
  // are held. The head cannot lag at all, hence (1 − v).
  const lead = sailDraftLead(p.sailDraftPos - finite(s.skew) * SAIL_SKEW_LEAD * (1 - vv));
  const across = sailDraftProfile(uu, lead, p.sailDraftFullness);
  const down = sailBellyProfile(vv);
  const belly = across * down * finite(s.drive) * p.sailBillow * drop;

  // flutter: travelling ripples, biggest at the free foot and the leeches.
  //
  // The RATE IS CONSTANT and must stay constant. It used to be
  // `sailFlutterFreq · (1 + luff)`, multiplied by `time` — but t·ω(t) is the
  // phase of a sine only while ω is fixed, and luff breathes with every gust
  // and every turn of the helm. Its instantaneous frequency is ω + t·dω/dt, so
  // the ripple ran away with elapsed time exactly as the flags' did (measured
  // there: 0.93 Hz intended, 59.5 Hz after ten minutes, with sign flips). The
  // same defect, in two files, from the same expression.
  //
  // A luffing sail does shake faster, but buying that cue back needs an
  // integrated phase, and this function has TWO evaluators reading two
  // different clocks (see the note in shipAssembly.clothState) — an
  // accumulator would have to be a single owner across both. Luff drives the
  // AMPLITUDE instead, which it already did, over a 10× range.
  const luff = finite(s.luff);
  const shake = SAIL_FLUTTER_BASE + luff * p.sailLuffFlap;
  const rippleFreq = Math.max(0, finite(p.sailFlutterFreq));
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
 * How far a point of canvas is hauled UP as the sail gathers, in metres.
 *
 * The reef is now one continuous ramp (sailDynamics.trimDropScale), which fixes
 * the jerk but on its own would slide a flat rectangle of canvas up a slot —
 * not "packed-up sails". Real canvas comes up on its BUNTLINES and CLEWLINES,
 * which are made fast at a handful of stations along the foot, so the foot
 * rises at those stations and swags down between them. That is also the user's
 * standing note about the reefed look: "some lines… either in the centre or at
 * thirds, instead of just being like a completely straight line rolled up".
 *
 * Zero at full canvas, so a flying sail is untouched — this must not disturb
 * the belly (§B.21, and the draft work above it).
 */
export function sailFurlLift(
  u: number,
  v: number,
  builtDrop: number,
  s: SailClothState,
  p: ShipMaterialParams,
): number {
  const uu = clamp01(finite(u));
  const vv = clamp01(finite(v));
  const furl = 1 - clamp01(finite(s.dropScale, 1));
  const bays = Math.max(1, finite(p.sailFurlBays, 3));
  // 0 at each station (where a line is made fast), 1 in the middle of a bay
  const station = Math.abs(Math.sin(Math.PI * bays * uu));
  const drop = Math.max(0.01, finite(builtDrop));
  // the head is bent to its yard and cannot rise, hence (1 − v)
  return furl * finite(p.sailFurlSwag) * drop * (1 - vv) * (1 - station);
}

/**
 * Full piece-local position of a point of canvas: the flat panel position,
 * shortened from the foot up by the trim scale and gathered at its stations,
 * plus the cloth displacement. This is the function a sail-attached socket
 * resolves through — §V.45: a buntline whose end did not ride the gather would
 * hang beside the cloth it is supposed to be hauling.
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
  const y =
    -(1 - vv) * Math.max(0.01, finite(builtDrop)) * scale + sailFurlLift(uu, vv, builtDrop, s, p);
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
