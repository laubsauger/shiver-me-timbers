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
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE CONSTRAINT THAT GOVERNS ANY FUTURE CLOTH WORK IN THIS FILE. READ THIS
 * BEFORE REACHING FOR A SOLVER.
 *
 * Everything here must stay CPU-EVALUABLE and PURE. 24 of the ship's 68 ropes
 * — every sheet, tack and buntline — resolve their endpoints through
 * `sailClothPoint`, via `ShipAssembly.socketWorldPosition`. That is the whole
 * reason this file exists (see the note above about the ratlines).
 *
 * ⟹ A GPU-SIDE PBD / VERLET CLOTH SOLVER IS RULED OUT. It has no CPU mirror,
 * so every sheet and buntline would end in mid-air beside the canvas it is
 * supposed to be hauling — §V.45's exact failure, the one this file was
 * written to prevent, reintroduced through the back door.
 *
 * If cloth ever needs real STATE (it does not today — everything below is a
 * stateless analytic field of (u, v, drive, luff, skew)), the architecture is:
 * own the state CPU-SIDE, integrate it at the FIXED SIM DT (§V2 — rigging
 * already integrates per RENDERED frame and is framerate-dependent because of
 * it), and publish it to the shader as a SMALL SET OF SCALARS, not a particle
 * grid. A dozen uniforms, mirrored by the same transliteration discipline the
 * rest of this file uses.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The dimensionless curves themselves live in sailShapeProfiles.ts (split at
 * the §C file cap); this file composes them into metres. They are re-exported
 * below so importers — sailMaterial.ts, the tests — keep one import site.
 */
import type { ShipMaterialParams } from '../params/ship';
import {
  SAIL_BELLY_FOOT,
  SAIL_FLUTTER_BASE,
  SAIL_FLUTTER_EDGE,
  SAIL_FLUTTER_V,
  arcShorten,
  clamp,
  clamp01,
  cornerTension,
  finite,
  midArch,
  sailBellyProfile,
  sailCamberRatio,
  sailDraftAt,
  sailDraftLead,
  sailDraftProfile,
  sailPanelCoord,
  seamQuiltProfile,
  leechStandoff,
} from './sailShapeProfiles';

export * from './sailShapeProfiles';


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
  /**
   * ∫ flutterRate dt, wrapped to [0, 2π), seeded per sail so no two ripple in
   * step (§B.4). ONE OWNER: `sailDriver.ts` accumulates it and publishes it on
   * the mesh; this evaluator and the shader both READ it.
   *
   * It replaces the old (`time`, `phase`) pair, and that is §B.30's recorded
   * "sailShape has TWO evaluators on TWO clocks (node `time` vs
   * `performance.now()`), so CPU/GPU flutter phase already disagrees by up to
   * ~0.28 m of rope anchor — §V.45-class, unfixed". There is now no clock in
   * this file at all, so there is nothing left to disagree.
   */
  flutterPhase: number;
  /**
   * Where each sheet hauls its clew, as a unit direction in the sail's own
   * frame (sailFrame.sheetLeadDirections). [0,0,0] = no sheet, corners flat.
   */
  sheetLeadPort: [number, number, number];
  sheetLeadStarboard: [number, number, number];
}

/**
 * How far each corner is hauled OUT OF THE SAIL'S PLANE, and how that
 * displacement spreads into the cloth.
 *
 * THE HEAD IS NOT A CORNER IN THIS SENSE. It is laced to its yard along its
 * whole length, so it genuinely is a straight line and must stay one — hence
 * the (1 − v), which is zero there. The CLEWS are a different thing entirely:
 * each is hauled by a sheet to a point on the ship that is nowhere near the
 * sail's plane, so the foot leaves that plane and the lower half of the sail
 * goes with it.
 *
 * User: "the actual pin points stop being flat in space and can actually be
 * ANGLED… instead of just being always perfectly flat against the mast."
 *
 * The two clews get their OWN leads, and the weights are linear in u so they
 * sum to exactly (1 − v). Two consequences, both wanted:
 *   · both sheets leading aft swings the whole foot aft — the sail stops
 *     being a plane bent in z and becomes a surface set at an angle to its
 *     yard;
 *   · the two leads DIFFERING rotates the foot's chord line against the
 *     head's, which is geometric TWIST. It is the same phenomenon as the
 *     aerodynamic draft migration in `sailDraftAt`, arriving from the other
 *     end — that one moves where the sail is deepest, this one moves where
 *     its corners are.
 */
export function sailCornerPull(
  u: number,
  v: number,
  width: number,
  s: SailClothState,
  p: ShipMaterialParams,
): [number, number, number] {
  const uu = clamp01(finite(u));
  const vv = clamp01(finite(v));
  const chord = Math.max(0.01, finite(width));
  // taut with the load: a slack sheet hauls nothing, a full sail brings it
  // bar-taut. Bounded at source because it moves vertices (§V44, §V28).
  const haul =
    Math.abs(sailCamberRatio(finite(s.drive), p) * clamp01(finite(s.dropScale, 1)))
    * Math.max(0, finite(p.sailSheetPull))
    * chord;
  const port = s.sheetLeadPort ?? [0, 0, 0];
  const stbd = s.sheetLeadStarboard ?? [0, 0, 0];
  const span = 1 - vv;
  const wp = (1 - uu) * span * haul;
  const ws = uu * span * haul;
  return [
    finite(port[0]) * wp + finite(stbd[0]) * ws,
    finite(port[1]) * wp + finite(stbd[1]) * ws,
    finite(port[2]) * wp + finite(stbd[2]) * ws,
  ];
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
  width: number,
  builtDrop: number,
  s: SailClothState,
  p: ShipMaterialParams,
): number {
  const uu = clamp01(finite(u));
  const vv = clamp01(finite(v));
  const chord = Math.max(0.01, finite(width)); // §V28 floored
  const drop = Math.max(0.01, finite(builtDrop)); // §V28 floored
  // a deeply reefed sail is FLATTER: the cloth that is left is stretched
  // between its yard and the reef band, so the belly eases with the trim
  const set = clamp01(finite(s.dropScale, 1));

  // belly: a membrane section across the cloth × the vertical profile. The
  // ship's swing lags the DRAFT to leeward rather than translating the whole
  // curve — translating it walked the belly off the leech (at full skew the
  // old form left 44% of the peak standing at the bolt rope). The head cannot
  // lag at all, hence the (1 − v) inside sailDraftAt.
  //
  // DEPTH IS CAMBER × CHORD, not a fraction of the drop: the section bows
  // across the WIDTH, so that is the length it must be measured against.
  const lead = sailDraftLead(sailDraftAt(vv, s.drive, s.skew, p));
  const across = sailDraftProfile(uu, lead, p.sailDraftFullness);
  const down = sailBellyProfile(vv);
  const depth = sailCamberRatio(finite(s.drive), p) * chord * set;
  // QUILTING: each cloth panel bellies between its two seams, which hold. It
  // rides the belly envelope, so it vanishes at the pinned leeches and at the
  // head and scales with the wind exactly as the main camber does — a
  // second-order camber on the primary one, never a fixed corrugation.
  const quilt =
    Math.max(0, finite(p.sailSeamQuilt))
    * seamQuiltProfile(sailPanelCoord(uu, p.sailLacingPoints))
    * across
    * down;
  /**
   * THE CORNER TENSION FIELD DIVIDES THE WHOLE SECTION (§T.74c).
   *
   * Not just the membrane term: the quilting and the leech's standoff are cloth
   * too, and cloth that is being pulled bar-taut into a clew cannot corrugate
   * or fly any more than it can belly. Dividing the bracket rather than one
   * term inside it is also what keeps the quilt zero-mean about the belly it
   * rides — see `seamQuiltProfile`.
   *
   * It is a DIVISION and the divisor is ≥ 1 wherever the clews pull harder than
   * the reference station, so this can only ever take depth away. `depth`
   * therefore stays the §V44 bound on the whole expression.
   */
  const tension = cornerTension(uu, vv, chord, drop, p.sailCornerGrip);
  const belly =
    (depth * (across * down + quilt + p.sailLeechOpen * leechStandoff(uu, vv)))
    / Math.max(1e-3, tension); // §V28

  // flutter: travelling ripples, biggest at the free foot and the leeches.
  //
  // THE CARRIER IS AN ACCUMULATED PHASE, NOT `time × rate`. `t·ω(t)` is the
  // phase of a sine only while ω is fixed; when it varies the instantaneous
  // frequency is ω + t·dω/dt, so elapsed time multiplies every wobble in the
  // rate — measured on the flags at 0.93 Hz intended, 59.5 Hz after ten
  // minutes, with sign flips (§V.55, §B.30). The old cure here was to hold
  // the rate CONSTANT and let luff drive amplitude only, because an
  // accumulator needs a single owner and this shape had two evaluators on two
  // clocks. It has one owner now (`sailDriver.ts`), so a luffing sail is
  // finally allowed to shake FASTER as well as harder.
  const luff = finite(s.luff);
  const shake = SAIL_FLUTTER_BASE + luff * p.sailLuffFlap;
  const wave = Math.sin(
    finite(s.flutterPhase)
      + uu * (p.sailRippleCount * Math.PI * 2)
      + vv * SAIL_FLUTTER_V,
  );
  const edge = 0.35 + Math.abs(uu - 0.5) * SAIL_FLUTTER_EDGE;
  /**
   * THE RIPPLE IS SCALED BY THE TRIM, AND THIS IS THE FLAPPY TABS (§V.66).
   *
   * User, on the finished furl: "the fully packed up, rolled up sails now have
   * a flappy end on all sides of the packages, on all sections of it, flapping
   * in the wind a bit."
   *
   * `sailFlutterAmp` is an amplitude in METRES and had no trim factor at all,
   * so a sail with 0.227 m of canvas left down was being waved ±0.406 m at
   * luff 1.0 and ±0.552 m at the cap — TWO AND A HALF TIMES the whole of the
   * remaining sail. Its two envelopes decide the shape of the result and both
   * point at what the user photographed: `(1 − v)` pins it at the head and
   * frees it at the foot, and `edge` peaks at BOTH leeches, so the cloth that
   * is left ends up as a triangular tab standing off each end of the roll,
   * lobed across the width by `sailRippleCount` — "on all sections of it".
   * Measured z span at luff 1.0: 0.810 m against the roll's own 0.843 m
   * diameter, which is the user's "roughly the size of the package" to 4%.
   *
   * It was invisible until the furl rework because `trimDropMin` pinned `set`
   * at 0.23: a 0.4 m ripple inside 1.74 m of hanging canvas is just a sail
   * shaking. This is the THIRD term found relying on that pin, after
   * `sailFurlLift` (which could lift the foot above its own head) and the
   * sewn-part offsets below. All three are one error: a length that is a
   * fraction of the sail AS CUT, applied to the sail AS SET.
   *
   * A furled sail cannot shake because there is no free canvas to shake —
   * that is the physical statement, and `× set` is it. The metres-vs-chord
   * scaling of `sailFlutterAmp` itself is left alone (§Rule 3); it is honest
   * for a sail that is actually set, which is every case but this one.
   */
  const flutter = wave * p.sailFlutterAmp * shake * (1 - vv) * edge * set;

  return finite(belly + flutter);
}

/**
 * Rate (rad/s) the cloth is shaking at right now. Bounded by construction so
 * the phase accumulator can never run away (§V44, §V.55).
 */
export function sailFlutterRate(luff: number, p: ShipMaterialParams): number {
  const shake = clamp(finite(luff), 0, 1.4) * Math.max(0, finite(p.sailFlutterLuffRate));
  return Math.max(0, finite(p.sailFlutterFreq)) * (1 + shake);
}

/**
 * How much of its authored section the gathered bundle is showing, 0..1.
 *
 * THE ONE OWNER of the furl roll's size: sailClothNodes transliterates it into
 * the vertex stage, and the tests measure the silhouette through it. There is
 * no geometry swap on a sail any more (see pieceGeometrySail.buildSailGeometry
 * for the measurements that killed it) — the roll is in the same mesh as the
 * canvas and simply grows as the canvas shortens.
 *
 * LINEAR IN THE FURL, deliberately. Canvas conserves area, so a roll holding
 * (1 − set) of the sail would grow as its SQUARE ROOT — which is 71% of full
 * size at half trim, i.e. most of the bundle arrives in the first half of the
 * travel and it is fat while she is still drawing. The complaint being fixed
 * is a transition that is too sudden, so the shape that keeps the change
 * SLOWEST for longest is the right one, and a roll of gathered cloth is loose
 * enough that neither curve is wrong. It reaches (1 − trimDropMin), not 1, at
 * trim 0; at the shipped 0.03 that is 97% of the authored size, and nothing
 * downstream needs it to be exactly 1 — which is the whole point of no longer
 * having a swap to line up.
 */
export function furlBundleScale(dropScale: number): number {
  return clamp01(1 - clamp01(finite(dropScale, 1)));
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
 *
 * THE SWAG IS A FRACTION OF WHAT IS STILL HANGING, NOT OF THE BUILT DROP
 * (§V.66: scale a feature by ITS OWN dimension). It used to be `swag · drop`
 * against a hanging length of `set · drop`, which is a ratio of `swag/set` —
 * unbounded as she comes in. That was harmless only because `trimDropMin` held
 * `set` at 0.23; the moment the roll took over and the canvas was allowed to
 * shorten properly, the gather at the stations exceeded the whole remaining
 * drop and lifted the foot ABOVE its own head. Written this way the lift can
 * never exceed `sailFurlSwag` of the hanging cloth, by construction, at any
 * value of any parameter.
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
  const set = clamp01(finite(s.dropScale, 1));
  const furl = 1 - set;
  const bays = Math.max(1, finite(p.sailFurlBays, 3));
  // 0 at each station (where a line is made fast), 1 in the middle of a bay
  const station = Math.abs(Math.sin(Math.PI * bays * uu));
  const drop = Math.max(0.01, finite(builtDrop));
  // the head is bent to its yard and cannot rise, hence (1 − v)
  return furl * finite(p.sailFurlSwag) * drop * set * (1 - vv) * (1 - station);
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
  const chord = Math.max(0.01, finite(width)); // §V28 floored
  const drop = Math.max(0.01, finite(builtDrop));
  // the SAME camber the surface is built from, trim scale included, or
  // the outline and the cloth inside it would disagree
  const camber = sailCamberRatio(finite(s.drive), p) * scale;

  // ── the outline. This is what stopped being a rectangle. ────────────────
  // Each strip of cloth gives up span to pay for its own bow, so the shrink
  // is LOCAL: the horizontal strip at height v bows by camber·down(v), and
  // the vertical strip at width u bows by camber·across(u)·chord. Neither
  // factor is constant over the panel, which is the whole point —
  //   · the leeches draw in most at the DRAFT HEIGHT and not at all at the
  //     head, so the side edges bow inward instead of running straight down;
  //   · the foot rises most at MID-WIDTH and not at all at the clews, so the
  //     bottom edge scallops instead of running straight across.
  // Both fall out of arc length alone. Neither is a shaping hack, and both
  // vanish correctly when the sail is becalmed.
  const lead = sailDraftLead(sailDraftAt(vv, s.drive, s.skew, p));
  const across = sailDraftProfile(uu, lead, p.sailDraftFullness);
  /**
   * EACH SHRINK READS THE BOW ITS OWN STRIP ACTUALLY TAKES, TENSION INCLUDED.
   *
   * This is the half of §T.74 that is not visible in the belly: a strip that is
   * held taut by a clew does not bow, and a strip that does not bow gives up no
   * span. Feeding `arcShorten` the raw profile while the surface was being
   * divided by the tension field would be §V.49's shape — two individually
   * defensible expressions whose PRODUCT is a sail whose outline disagrees with
   * its own cloth, and the disagreement shows up as the edges creeping away
   * from the canvas they bound.
   *
   * Each strip is shortened by its OWN PEAK bow, so the tension is sampled at
   * that peak and not at (u, v): a horizontal strip peaks near mid-width, a
   * vertical one at the draft height. Sampling at the point would shorten each
   * strip by a different amount at each end of itself, which is a shear, not a
   * shortening.
   */
  const chordShrink = arcShorten(
    (camber * sailBellyProfile(vv)) / Math.max(1e-3, cornerTension(0.5, vv, chord, drop, p.sailCornerGrip)),
  );
  // the vertical strip at width u bows by BOTH terms of the section — the
  // membrane belly, which is zero at the leech, and the leech's own standoff,
  // which is zero at mid-width. Counting only the first left the clews the one
  // part of the outline that did not move, and the leech is precisely the edge
  // that now flies.
  const stripBow = across + Math.max(0, finite(p.sailLeechOpen)) * (1 - midArch(uu));
  const spanShrink = arcShorten(
    (camber * stripBow * chord)
    / drop
    / Math.max(1e-3, cornerTension(uu, SAIL_BELLY_FOOT, chord, drop, p.sailCornerGrip)),
  );
  // ROACH: the foot is CUT with an arch — a static shortening at mid-width,
  // so the bottom edge is not a straight line even with no wind in her.
  const roach = 1 - Math.max(0, finite(p.sailFootRoach)) * midArch(uu);

  const pull = sailCornerPull(uu, vv, width, s, p);
  const x = (uu - 0.5) * chord * chordShrink + pull[0];
  const y =
    -(1 - vv) * drop * scale * spanShrink * roach
    + sailFurlLift(uu, vv, builtDrop, s, p)
    + pull[1];
  return [x, y, sailClothOffset(uu, vv, width, builtDrop, s, p) + pull[2]];
}

/**
 * The cloth's own orthonormal frame at (u, v): +u tangent, +v tangent, normal.
 *
 * CPU mirror of the basis sailClothNodes builds from the same finite
 * differences and the same step. It exists so the RIGID-PART placement below
 * is testable off the GPU — the shader is the only thing that draws it, but a
 * fix nobody can assert is a fix that comes back.
 */
export function sailClothFrame(
  u: number,
  v: number,
  width: number,
  builtDrop: number,
  s: SailClothState,
  p: ShipMaterialParams,
): { tanU: Vec3; tanV: Vec3; normal: Vec3 } {
  const e = 0.03; // the same step the shader uses
  const at = (uu: number, vv: number): Vec3 =>
    sailClothPoint(uu, vv, width, builtDrop, s, p);
  const o = at(u, v);
  const du = sub(at(u + e, v), o);
  const dv = sub(at(u, v + e), o);
  const normal = unit(cross(du, dv));
  const tanU = unit(du);
  return { tanU, tanV: cross(normal, tanU), normal };
}

/**
 * Where a part SEWN to the canvas puts one of its vertices.
 *
 * `offset` is that vertex's position relative to its station's FLAT panel
 * position. It is re-expressed in the cloth's own frame, so the part rides the
 * belly as a rigid body instead of staying in the flat panel's plane — which
 * is what put the reef points' corners through the cloth once the sail
 * carried real camber.
 *
 * AND IT GATHERS WITH THE CANVAS: the offset is scaled by the trim, so a reef
 * point rolls up into the bundle instead of standing off it at full size once
 * the cloth around it has gone. Transliteration pair with `rigid` in
 * sailClothNodes; see the note there for what it measured.
 */
export function sailSewnPoint(
  u: number,
  v: number,
  offset: Vec3,
  width: number,
  builtDrop: number,
  s: SailClothState,
  p: ShipMaterialParams,
): Vec3 {
  const o = sailClothPoint(u, v, width, builtDrop, s, p);
  const f = sailClothFrame(u, v, width, builtDrop, s, p);
  const k = clamp01(finite(s.dropScale, 1));
  const d: Vec3 = [offset[0] * k, offset[1] * k, offset[2] * k];
  return [
    o[0] + f.tanU[0] * d[0] + f.tanV[0] * d[1] + f.normal[0] * d[2],
    o[1] + f.tanU[1] * d[0] + f.tanV[1] * d[1] + f.normal[1] * d[2],
    o[2] + f.tanU[2] * d[0] + f.tanV[2] * d[1] + f.normal[2] * d[2],
  ];
}

type Vec3 = [number, number, number];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function unit(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l < 1e-9 ? [0, 0, 1] : [a[0] / l, a[1] / l, a[2] / l]; // §V28
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
  /**
   * BUNTLINE LEADS, and they are why the line stops cutting through the sail.
   *
   * A buntline used to be one rope from the foot straight to the masthead.
   * Any straight chord between a point on the foot and a point above the head
   * passes BEHIND the belly at mid-height and in FRONT of it near the head —
   * the belly IS the deviation from that chord — so it crossed the canvas
   * twice and read as a line glitching in and out of the cloth. Measured at
   * the shipped camber: 0.88 m behind the surface at mid-height.
   *
   * A real buntline is led up the sail's FRONT face through cringles at the
   * reef bands, which is exactly what fixes it: split the run at points that
   * ride the cloth, and each segment is then a SHORT chord across a gently
   * curving surface. Deviation falls with the square of the segment, so three
   * short legs hug where one long one could not.
   *
   * They sit on the reef bands (0.34 / 0.62, pieceGeometrySail.reefPoints) —
   * the same stations the reef points are sewn at, because that is where the
   * cloth is reinforced and where the gear is actually led.
   */
  'bunt-lead1-port': [0.3, 0.34],
  'bunt-lead2-port': [0.3, 0.62],
  'bunt-lead1-starboard': [0.7, 0.34],
  'bunt-lead2-starboard': [0.7, 0.62],
};
