/**
 * SAIL CLOTH SHAPE — the TSL half. Split out of sailMaterial.ts at the §C file
 * cap, which leaves that file owning colour and light.
 *
 * This is a LINE-FOR-LINE TRANSLITERATION of sailShape.ts /
 * sailShapeProfiles.ts: same constants (imported, never copied), same
 * expression order, same clamps. The two evaluators cannot literally share
 * code — one is JS arithmetic and the other is a node graph — so the next best
 * thing is that any drift shows up in a side-by-side diff. Keep the order.
 *
 * §V23: functional mix() only. A chained `a.mix(b,t)` reads the
 * RECEIVER as the factor (§B.1/§B.2).
 * §V28: every divisor floored; a NaN here is a NaN vertex.
 * §V57: every node below is built inside `createSailClothNodes` (called from
 * the material factory), never at module scope — a TSL mutator outside a live
 * `Fn()` body silently drops the write.
 */
import {
  Fn,
  attribute,
  clamp,
  cross,
  float,
  max,
  mix,
  positionLocal,
  sin,
  uniform,
  uv,
  vec3,
} from 'three/tsl';
import type { ShipMaterialParams } from '../params/ship';
import {
  SAIL_ARC_COEFF,
  SAIL_ARC_COEFF_V,
  SAIL_BELLY_REF,
  SAIL_CLEW_SOFTEN,
  SAIL_DRAFT_MAX,
  SAIL_DRAFT_MIN,
  SAIL_FLUTTER_BASE,
  SAIL_FLUTTER_EDGE,
  SAIL_FLUTTER_V,
  SAIL_FOLD_CYCLES_A,
  SAIL_FOLD_CYCLES_B,
  SAIL_FOLD_PHASE_A,
  SAIL_FOLD_PHASE_B,
  SAIL_LACE_MARGIN,
  SAIL_LACE_SPAN,
  SAIL_LEAD_MAX,
  SAIL_SKEW_LEAD,
} from './sailShape';
import type { SailWindUniforms } from './sailDriver';

const TAU = Math.PI * 2;

type Node = ReturnType<typeof float>;
type UniformNode = ReturnType<typeof uniform>;

/** the shape uniforms, so the material can refresh them from params */
export interface SailShapeUniforms {
  clothExcess: UniformNode;
  cornerGrip: UniformNode;
  camberMax: UniformNode;
  slackFold: UniformNode;
  leechOpen: UniformNode;
  footRoach: UniformNode;
  twist: UniformNode;
  sheetPull: UniformNode;
  lacingPoints: UniformNode;
  seamQuilt: UniformNode;
  draftPos: UniformNode;
  draftFullness: UniformNode;
  furlSwag: UniformNode;
  furlBays: UniformNode;
  flutterAmp: UniformNode;
  luffFlap: UniformNode;
  rippleCount: UniformNode;
}

export interface SailClothNodes {
  /** the panel grid, `u × panels` — ONE owner for the quilted GEOMETRY here
   *  and the seam shading in sailMaterial.ts, so a seam's ridge cannot land
   *  beside the fold it is supposed to be sitting in */
  panelCoord: Node;
  /** material.positionNode */
  position: Node;
  /** the billowed surface normal, in LOCAL space (pre-view-transform) */
  localNormal: Node;
  /** the cloth's own u tangent in local space — the seam ridge tilts along it */
  uTangent: Node;
  /** 1 on cloth the shader may move, 0 on robands and the furled bundle */
  clothWeight: Node;
  /** baked fold occlusion — 1 on cloth, < 1 in the bundle's creases and waists */
  occlusion: Node;
  /** the sail's BUILT width (m), floored */
  width: Node;
}

/**
 * `1 / (1 + C·k²)` — the span a bowed strip gives up to keep its arc length.
 * Divisor ≥ 1 by construction, so §V28 needs no floor (cf. arcShorten). `C` is
 * SAIL_ARC_COEFF for a horizontal strip (held at both ends) and
 * SAIL_ARC_COEFF_V for a vertical one (free at the foot) — see the constants.
 */
function arcShorten(k: Node, coeff: number = SAIL_ARC_COEFF): Node {
  return float(1).div(float(1).add(k.mul(k).mul(coeff)));
}

/** 1 at mid-width, 0 at both leeches — its complement is the leech weight */
function midArch(u: Node): Node {
  return u.mul(u.oneMinus()).mul(4);
}

export function createSailClothNodes(
  wind: SailWindUniforms,
  u: SailShapeUniforms,
): SailClothNodes {
  // (clothWeight, width, drop): robands and the furled roll carry weight 0 so
  // only cloth moves; width/drop let one shared material serve every sail size
  const shapeAttr = attribute('sailShape', 'vec3');
  const clothWeight = shapeAttr.x;
  const width = max(shapeAttr.y, float(0.01)); // §V28 floored divisor
  const builtDrop = max(shapeAttr.z, float(0.01)); // BEFORE the trim scale
  // (buntWeight, bakedOcclusion) — the third vertex class, see withSailShape
  const buntAttr = attribute('sailBunt', 'vec2');
  const buntWeight = buntAttr.x;
  const occlusion = buntAttr.y;
  // live trim: easing the sheets shortens the canvas continuously instead of
  // popping between trim states
  const set = clamp(wind.dropScale, float(0), float(1));

  /**
   * PEAK CAMBER AS A FRACTION OF THE CHORD, bounded at source (§V44), and
   * eased by the trim because a deeply reefed sail is flatter.
   *
   * Transliteration of sailShapeProfiles.sailCamberRatio — §T.74a: DEPTH IS
   * DERIVED FROM EXCESS CLOTH, not authored: `e = SAIL_ARC_COEFF·k²` inverted.
   * `drive` IS THE FULLNESS (sailDynamics.sailDrive maps dynamic pressure to
   * 0..1, signed for aback) and camber is LINEAR in it — a half-loaded sail
   * shows half its camber, and the old √smoothstep front-loading that put the
   * cloth at 61% of full in 2 kn is gone. Linear is C1 through zero (§V.71).
   *
   * `max(…, 0)` before the sqrt is §V28/§B.5's rule: a WGSL `sqrt` of a value
   * a hair below zero is undefined, and undefined here is a NaN vertex.
   */
  const fill = clamp(wind.drive, float(-1), float(1));
  const camber = clamp(
    max(u.clothExcess, float(0)).div(SAIL_ARC_COEFF).sqrt().mul(fill),
    u.camberMax.negate(),
    u.camberMax,
  ).mul(set);
  /** how full she is, 0..1 — scales the slack folds and the flutter OUT */
  const fullness = fill.abs();
  const depth = camber.mul(width);

  /**
   * THE CORNER TENSION FIELD (§T.74c) — transliteration of
   * sailShapeProfiles.cornerTension. Distances in METRES on the cut panel
   * (§V66), softened rather than floored so the finite-difference normal below
   * never straddles a kink (§V28), and normalised at (0.5, SAIL_BELLY_REF) so
   * `camber` keeps meaning the peak on a sail of any aspect.
   */
  const diag = width.mul(width).add(builtDrop.mul(builtDrop)).sqrt();
  const reach = max(u.cornerGrip, float(0)).mul(diag);
  const eps2 = diag.mul(SAIL_CLEW_SOFTEN).mul(diag.mul(SAIL_CLEW_SOFTEN));
  const tensionRaw = Fn(([uu, v]: [Node, Node]) => {
    const dy = v.mul(builtDrop);
    const dp = uu.mul(width);
    const ds = uu.oneMinus().mul(width);
    // squared by multiplication, never pow(): a WGSL pow() with a base a hair
    // below zero is undefined (§V28, §B.5), and sqrt of a sum of squares is
    // non-negative by construction here
    const rp = dp.mul(dp).add(dy.mul(dy)).add(eps2).sqrt();
    const rs = ds.mul(ds).add(dy.mul(dy)).add(eps2).sqrt();
    // divisors ≥ SAIL_CLEW_SOFTEN·diag > 0 by construction (§V28)
    return float(1).add(reach.div(rp)).add(reach.div(rs));
  });
  const tensionRef = tensionRaw(float(0.5), float(SAIL_BELLY_REF));
  const tensionAt = Fn(([uu, v]: [Node, Node]) =>
    max(tensionRaw(uu, v).div(tensionRef), float(1e-3)), // §V28
  );

  /**
   * THE CORNER CONSTRAINT — transliteration of sailShape.sailCornerPull.
   *
   * The head is laced to its yard along its whole length and genuinely is a
   * straight line; the CLEWS are hauled by sheets to points nowhere near the
   * sail's plane, so the foot leaves that plane and the lower half of the sail
   * goes with it. Weights are linear in u and sum to exactly (1 − v), so both
   * leads together swing the whole foot, and the two leads DIFFERING rotates
   * the foot's chord against the head's — geometric twist.
   */
  // Transliteration of sailShapeProfiles.sailPanelCoord. INTEGER on every
  // lashing station, so each seam the shader draws sits on a roband the yard
  // actually carries — one number owns both (§V33/§V51).
  const laces = max(u.lacingPoints, float(2));
  const panelCoord = uv()
    .x.sub(SAIL_LACE_MARGIN)
    .div(SAIL_LACE_SPAN)
    .mul(laces.sub(1));

  const haul = camber.abs().mul(u.sheetPull).mul(width);
  const cornerPull = Fn(([uu, v]: [Node, Node]) => {
    const span = v.oneMinus().mul(haul);
    return wind.sheetLeadPort
      .mul(uu.oneMinus().mul(span))
      .add(wind.sheetLeadStarboard.mul(uu.mul(span)));
  });

  /** the section's warp lead, at height v — carries skew AND twist */
  const leadAt = Fn(([v]: [Node]) => {
    const draft = clamp(
      u.draftPos
        .sub(wind.skew.mul(SAIL_SKEW_LEAD).mul(v.oneMinus()))
        .add(u.twist.mul(wind.drive).mul(v.sub(SAIL_BELLY_REF))),
      float(SAIL_DRAFT_MIN),
      float(SAIL_DRAFT_MAX),
    );
    return clamp(
      float(0.5).sub(draft).div(max(sin(draft.mul(Math.PI)), float(1e-3))), // §V28
      float(-SAIL_LEAD_MAX),
      float(SAIL_LEAD_MAX),
    );
  });

  /** membrane section across the cloth, pinned at both leeches */
  const acrossAt = Fn(([uu, v]: [Node, Node]) => {
    const w = clamp(uu.add(leadAt(v).mul(sin(uu.mul(Math.PI)))), float(0), float(1));
    // max() BEFORE pow(): WGSL pow() with a base a hair below zero is
    // undefined → NaN vertices (§V28, §B.5). Chained .pow() is receiver^arg,
    // i.e. arc^fullness (§V23: 2-arg chained form, receiver = base).
    return max(w.mul(w.oneMinus()).mul(4), float(0)).pow(u.draftFullness);
  });

  /**
   * VERTICAL PROFILE — transliteration of sailShapeProfiles.sailBellyProfile:
   * `1 − v²`, 1 at the free foot, 0 at the yard. Deepest LOW, curving the
   * whole way up.
   *
   * VERTEX STAGE. A vertex displacement is band-limited by the MESH, not the
   * pixel grid — `fwidth` is not even defined here. The limit is samples-per-
   * feature on the mesh, ENFORCED by buildSailGeometry through
   * sailClothSegments(); this profile is one smooth curve over the whole drop.
   */
  // @band-limited-elsewhere
  const downAt = Fn(([v]: [Node]) => v.mul(v).oneMinus());

  /** how far the free LEECH flies at height v, as a fraction of the centre's
   *  depth there — sailShapeProfiles.leechFraction × sailLeechOpen. Zero at
   *  the clew and the yardarm, where the edge is actually made fast. */
  const leechAt = Fn(([v]: [Node]) =>
    clamp(u.leechOpen, float(0), float(1)).mul(v.mul(v.oneMinus()).mul(4)),
  );

  /**
   * THE SECTION — ONE 2D FUNCTION OF (u, v), transliteration of
   * sailShapeProfiles.sailSection. At height v an arc from leech to leech,
   * the leeches standing `leechAt(v)` of the way forward and the interior
   * bowing the rest on the membrane parabola; the whole scaled by the vertical
   * profile. §V23: functional 3-arg mix, factor LAST.
   */
  const sectionAt = Fn(([uu, v]: [Node, Node]) =>
    downAt(v).mul(mix(leechAt(v), float(1), acrossAt(uu, v))),
  );

  /** the vertical strip at width u's bow relative to the centre strip — its
   *  section at the reference height (sailShapeProfiles.sailStripBow) */
  const stripBowAt = Fn(([uu]: [Node]) =>
    mix(leechAt(float(SAIL_BELLY_REF)), float(1), acrossAt(uu, float(SAIL_BELLY_REF))),
  );

  /**
   * SLACK FOLDS — transliteration of sailShapeProfiles.slackFoldProfile. Two
   * incommensurate sines across the cloth, growing toward the free foot.
   * Scaled by (1 − fullness) below: the wind pulls them out as it fills her.
   * @band-limited-elsewhere — 3.5 cycles across a cloth the mesh samples at
   * ≥ 4 per panel over ≥ 7 panels; see SAIL_SAMPLES_PER_PANEL.
   */
  const foldAt = Fn(([uu, v]: [Node, Node]) => {
    // zero at exactly the two clews, which the sheets hold whatever the wind
    const sheeted = float(1).sub(v.oneMinus().mul(midArch(uu).oneMinus()));
    return sin(uu.mul(TAU * SAIL_FOLD_CYCLES_A).add(SAIL_FOLD_PHASE_A))
      .mul(0.6)
      .add(sin(uu.mul(TAU * SAIL_FOLD_CYCLES_B).add(SAIL_FOLD_PHASE_B)).mul(0.4))
      .mul(v.oneMinus())
      .mul(sheeted);
  });

  /** billow + flutter offset (m, along local +z = forward of the yard) */
  const clothZ = Fn(([uu, v]: [Node, Node]) => {
    const section = sectionAt(uu, v);
    // QUILTING (sailShapeProfiles.seamQuiltProfile): each cloth panel bellies
    // between its two seams, which hold. Zero-mean, so it redistributes camber
    // rather than adding any, and it rides the section so it dies at the head.
    // IN THE SHAPE, not the shading — a line painted on a smooth interior does
    // not change how the surface reads.
    const q = sin(uu.sub(SAIL_LACE_MARGIN).div(SAIL_LACE_SPAN).mul(laces.sub(1)).mul(Math.PI));
    const quilt = u.seamQuilt.mul(q.mul(q).sub(0.5)).mul(section);
    // SLACK: becalmed canvas hangs in folds; amplitude a fraction of the chord
    const slack = max(u.slackFold, float(0))
      .mul(width)
      .mul(set)
      .mul(fullness.oneMinus())
      .mul(foldAt(uu, v));
    // §T.74c: the tension field divides the WHOLE section — quilting and the
    // folds are cloth too, and cloth hauled bar-taut into a clew cannot
    // corrugate or hang any more than it can belly. Division only ever takes
    // depth away, so `depth` stays the §V44 bound on the filled expression.
    const belly = depth.mul(section.add(quilt)).add(slack).div(tensionAt(uu, v));
    // THE CARRIER IS AN ACCUMULATED PHASE (§V.55, §B.30). `time × ω(luff)` is
    // a phase only while ω is constant, and luff breathes with every gust —
    // measured on the flags at 0.93 Hz intended, 59.5 Hz after ten minutes.
    // sailDriver.ts integrates it, so there is no clock in this graph at all
    // and the CPU evaluator feeding the rope anchors reads the SAME number.
    const shake = float(SAIL_FLUTTER_BASE).add(wind.luff.mul(u.luffFlap));
    const wave = sin(
      wind.flutterPhase.add(uu.mul(u.rippleCount.mul(TAU))).add(v.mul(SAIL_FLUTTER_V)),
    );
    const edge = float(0.35).add(uu.sub(0.5).abs().mul(SAIL_FLUTTER_EDGE));
    // `.mul(set)` — a furled sail has no free canvas to shake. See
    // sailShape.sailClothOffset for the measurement: without it, 0.227 m of
    // remaining canvas was being waved ±0.406 m, which is the flapping tab the
    // user photographed on the packed bundles.
    // `.mul(1 − fullness)` — a drum-tight sail does not ripple; the flutter is
    // the luffing/slack read and fades as the wind fills her.
    return belly
      .add(
        wave
          .mul(u.flutterAmp)
          .mul(shake)
          .mul(v.oneMinus())
          .mul(edge)
          .mul(set)
          .mul(fullness.oneMinus()),
      )
      .add(cornerPull(uu, v).z);
  });

  /**
   * How far a point of canvas is hauled UP as the sail gathers (m).
   * Transliteration of sailShape.sailFurlLift — same params, same order.
   */
  const furlLift = Fn(([uu, v]: [Node, Node]) => {
    const furl = set.oneMinus();
    // 0 at each station (a line made fast), 1 in the middle of a bay
    const station = sin(uu.mul(max(u.furlBays, float(1))).mul(Math.PI)).abs();
    return furl.mul(u.furlSwag).mul(builtDrop).mul(v.oneMinus()).mul(station.oneMinus());
  });

  /**
   * THE OUTLINE — and this is the part that stopped being a rectangle.
   *
   * Every strip of cloth gives up span to pay for its own bow, so the shrink
   * is LOCAL: the horizontal strip at height v bows by camber·down(v), the
   * vertical strip at width u by camber·across(u)·chord. Neither factor is
   * constant over the panel, so the leeches draw in most at the DRAFT HEIGHT
   * and the foot rises most at MID-WIDTH — a bowed side edge and a scalloped
   * foot, out of arc length alone. `sailFootRoach` is the static cut on top,
   * so the bottom edge is not a straight line even becalmed.
   */
  // EACH SHRINK READS THE BOW ITS OWN STRIP ACTUALLY TAKES, tension included —
  // a strip held taut by a clew does not bow, so it gives up no span. Sampled
  // at the strip's own PEAK (mid-width across, the draft height down), because
  // sampling at (u, v) would shorten a strip differently at each of its ends,
  // which is a shear rather than a shortening. See sailShape.sailClothPoint.
  const clothX = Fn(([uu, v]: [Node, Node]) =>
    uu
      .sub(0.5)
      .mul(width)
      // the horizontal strip bows from its LEECHES to its centre — the
      // leeches stand forward too, so the bow is the difference
      .mul(arcShorten(camber.mul(downAt(v)).mul(leechAt(v).oneMinus()).div(tensionAt(float(0.5), v))))
      .add(cornerPull(uu, v).x),
  );
  const clothY = Fn(([uu, v]: [Node, Node]) => {
    // the vertical strip is bent to the yard and FREE at the foot: it swings
    // forward rather than bowing back — a different curve with its own
    // coefficient (SAIL_ARC_COEFF_V), bow sampled at the reference height
    const spanShrink = arcShorten(
      camber
        .mul(stripBowAt(uu))
        .mul(width)
        .div(builtDrop)
        .div(tensionAt(uu, float(SAIL_BELLY_REF))),
      SAIL_ARC_COEFF_V,
    );
    const roach = float(1).sub(u.footRoach.mul(midArch(uu)));
    return v
      .oneMinus()
      .negate()
      .mul(builtDrop)
      .mul(set)
      .mul(spanShrink)
      .mul(roach)
      .add(furlLift(uu, v))
      .add(cornerPull(uu, v).y);
  });

  const cloth = uv();
  const u0 = cloth.x;
  const v0 = cloth.y;
  // The flat panel this uv WOULD sit at, and where the cloth actually puts it.
  // The DIFFERENCE is what gets applied, weighted by clothWeight: weight 0
  // (robands, gaskets, the furled bundle) keeps its authored place, weight 1
  // rides the canvas. Sending a difference rather than an absolute is what
  // lets a reef-point quad — four vertices sharing ONE uv — move rigidly with
  // the point of cloth it is sewn to.
  const flat = vec3(u0.sub(0.5).mul(width), v0.oneMinus().negate().mul(builtDrop), float(0));
  const shaped = vec3(clothX(u0, v0), clothY(u0, v0), clothZ(u0, v0));

  // The surface's own frame at this (u, v), from the same finite differences
  // the normal is built from. `e` is a fixed step in cloth space, so these are
  // proportional to the true tangents and only need normalising.
  const e = float(0.03);
  const du = vec3(
    clothX(u0.add(e), v0).sub(shaped.x),
    clothY(u0.add(e), v0).sub(shaped.y),
    clothZ(u0.add(e), v0).sub(shaped.z),
  );
  const dv = vec3(
    clothX(u0, v0.add(e)).sub(shaped.x),
    clothY(u0, v0.add(e)).sub(shaped.y),
    clothZ(u0, v0.add(e)).sub(shaped.z),
  );
  const nrm = cross(du, dv).normalize();
  const tanU = du.normalize();
  const tanV = cross(nrm, tanU); // orthogonalised +v, so the basis is rigid

  /**
   * ANYTHING SEWN TO THIS SAIL RIDES ITS FRAME, NOT JUST ITS POSITION.
   *
   * A reef point is a small quad carrying ONE (u, v) for all four of its
   * vertices, so the cloth moves it as a rigid piece rather than shearing it.
   * That is the right instinct and it was only half-built: the quad was
   * TRANSLATED to its point of canvas while keeping the flat panel's
   * orientation. On a nearly-flat sail that is invisible. Once the camber fix
   * took the main course to 14% of chord the cloth curved out from under
   * quads still lying in the original plane, and their corners punched through
   * — the user circled every one of them, on both courses and both sides.
   *
   * So each vertex's offset FROM its station is re-expressed in the surface's
   * own basis at that station. The main panel is unaffected by construction:
   * its vertices sit exactly at their own flat station, so the offset is zero
   * and this reduces to `shaped`.
   */
  /**
   * A PART SEWN TO THE CANVAS GATHERS WITH THE CANVAS (§V.66, and the second
   * half of the flapping tabs).
   *
   * `rigid` is a vertex's offset from its own flat station, in metres, and it
   * is exactly zero on the main panel by construction — so this scales one
   * thing and one thing only: the reef points. Measured on the main course,
   * 108 vertices carrying offsets up to 0.390 m, against 0.227 m of hanging
   * canvas at full furl: every reef point was 1.7x the size of the entire
   * sail it was sewn to, standing off a bundle it should be rolled up inside.
   * Like the ripple above, it only ever looked right because `trimDropMin`
   * held the sail at 0.23 of its drop.
   */
  const rigid = positionLocal.sub(flat).mul(set);
  const onCloth = shaped
    .add(tanU.mul(rigid.x))
    .add(tanV.mul(rigid.y))
    .add(nrm.mul(rigid.z));

  /**
   * THE GATHERED ROLL, and the reason there is no mesh swap left.
   * Transliteration of sailShape.furlBundleScale — same expression, same
   * clamp; see buildSailGeometry for the measurements that killed the swap.
   *
   * The bundle is authored at the size it reaches when she is fully in, and
   * its SECTION is scaled about the head line (y = z = 0, where the canvas is
   * laced to its yard) by how far she is furled. At full sail the scale is
   * exactly zero, so the roll collapses to a degenerate line along the head
   * and rasterises nothing at all — no z-fight with the cloth it is lying on,
   * because a zero-area triangle produces no fragments. Its x is untouched:
   * canvas gathers ACROSS the yard, it does not slide along it.
   *
   * The authored normals ride along unchanged. A uniform scale of the section
   * leaves the normal's in-section direction exact and only mis-tilts its x
   * component by the same factor the radius changed — a fraction of a degree
   * at the scales this runs at, against recomputing a second finite-difference
   * basis for a part that is only fully visible at one end of the travel.
   */
  const furl = clamp(float(1).sub(set), float(0), float(1));
  const buntLocal = vec3(positionLocal.x, positionLocal.y.mul(furl), positionLocal.z.mul(furl));
  // three vertex classes, two mixes, and they are mutually exclusive by
  // construction: cloth is (1, 0), the roll is (0, 1), hardware is (0, 0).
  const hardware = mix(positionLocal, buntLocal, buntWeight);
  const position = mix(hardware, onCloth, clothWeight);

  return {
    panelCoord,
    position,
    localNormal: nrm,
    uTangent: tanU,
    clothWeight,
    occlusion,
    width,
  };
}

/** build the shape uniforms; the material owns refreshing them */
export function createSailShapeUniforms(p: ShipMaterialParams): SailShapeUniforms {
  return {
    clothExcess: uniform(p.sailClothExcess),
    cornerGrip: uniform(p.sailCornerGrip),
    camberMax: uniform(p.sailCamberMax),
    slackFold: uniform(p.sailSlackFold),
    leechOpen: uniform(p.sailLeechOpen),
    footRoach: uniform(p.sailFootRoach),
    twist: uniform(p.sailTwist),
    sheetPull: uniform(p.sailSheetPull),
    lacingPoints: uniform(p.sailLacingPoints),
    seamQuilt: uniform(p.sailSeamQuilt),
    draftPos: uniform(p.sailDraftPos),
    draftFullness: uniform(p.sailDraftFullness),
    furlSwag: uniform(p.sailFurlSwag),
    furlBays: uniform(p.sailFurlBays),
    flutterAmp: uniform(p.sailFlutterAmp),
    luffFlap: uniform(p.sailLuffFlap),
    rippleCount: uniform(p.sailRippleCount),
  };
}

/** push live param values into the shape uniforms (§V16: Tweakpane drives them) */
export function refreshSailShapeUniforms(u: SailShapeUniforms, p: ShipMaterialParams): void {
  u.clothExcess.value = p.sailClothExcess;
  u.cornerGrip.value = p.sailCornerGrip;
  u.camberMax.value = p.sailCamberMax;
  u.slackFold.value = p.sailSlackFold;
  u.leechOpen.value = p.sailLeechOpen;
  u.footRoach.value = p.sailFootRoach;
  u.twist.value = p.sailTwist;
  u.sheetPull.value = p.sailSheetPull;
  u.lacingPoints.value = p.sailLacingPoints;
  u.seamQuilt.value = p.sailSeamQuilt;
  u.draftPos.value = p.sailDraftPos;
  u.draftFullness.value = p.sailDraftFullness;
  u.furlSwag.value = p.sailFurlSwag;
  u.furlBays.value = p.sailFurlBays;
  u.flutterAmp.value = p.sailFlutterAmp;
  u.luffFlap.value = p.sailLuffFlap;
  u.rippleCount.value = p.sailRippleCount;
}
