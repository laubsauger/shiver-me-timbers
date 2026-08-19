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
 * §V23: functional mix()/smoothstep() only. A chained `a.mix(b,t)` reads the
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
  smoothstep,
  uniform,
  uv,
  vec3,
} from 'three/tsl';
import type { ShipMaterialParams } from '../params/ship';
import {
  SAIL_ARC_COEFF,
  SAIL_BELLY_FOOT,
  SAIL_BELLY_HEAD,
  SAIL_CLEW_SOFTEN,
  SAIL_DRAFT_MAX,
  SAIL_DRAFT_MIN,
  SAIL_FLUTTER_BASE,
  SAIL_FLUTTER_EDGE,
  SAIL_FLUTTER_V,
  SAIL_FOOT_FILL,
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
 * `1 / (1 + 8/3·k²)` — the span a bowed strip gives up to keep its arc length.
 * Divisor ≥ 1 by construction, so §V28 needs no floor (cf. arcShorten).
 */
function arcShorten(k: Node): Node {
  return float(1).div(float(1).add(k.mul(k).mul(SAIL_ARC_COEFF)));
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
   * DERIVED FROM EXCESS CLOTH, not authored. `e = SAIL_ARC_COEFF·k²` inverted,
   * with the drive scaling the excess TAKEN UP rather than the depth, so camber
   * goes as √drive: the sail fills early and then stops deepening.
   *
   * `max(…, 0)` before the sqrt is §V28/§B.5's rule for `pow`: a WGSL `sqrt` of
   * a value a hair below zero is undefined, and undefined here is a NaN vertex.
   */
  // smoothstep, NOT |drive| — √|d| has an infinite derivative at zero, so a
  // sail crossing from backed to drawing would snap between the two shapes at
  // unbounded rate (measured: 0.102 m of anchor travel over the first 1% of
  // drive, against §V.71's 0.063 m whole-travel bound). smoothstep is quadratic
  // at the origin, so its √ is linear there. §V23: functional 3-arg form.
  // @band-limited-elsewhere: the argument is `drive`, a UNIFORM — one wind
  // scalar for the whole sail. No spatial coordinate, no period, no pixel, so
  // there is nothing for it to alias against (§V.48).
  const takenUp = max(u.clothExcess, float(0)).mul(
    // @band-limited-elsewhere
    smoothstep(float(0), float(1), wind.drive.abs()),
  );
  const camber = clamp(
    takenUp.div(SAIL_ARC_COEFF).max(float(0)).sqrt().mul(wind.drive.sign()),
    u.camberMax.negate(),
    u.camberMax,
  ).mul(set);
  const depth = camber.mul(width);

  /**
   * THE CORNER TENSION FIELD (§T.74c) — transliteration of
   * sailShapeProfiles.cornerTension. Distances in METRES on the cut panel
   * (§V66), softened rather than floored so the finite-difference normal below
   * never straddles a kink (§V28), and normalised at (0.5, SAIL_BELLY_FOOT) so
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
  const tensionRef = tensionRaw(float(0.5), float(SAIL_BELLY_FOOT));
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
        .add(u.twist.mul(wind.drive).mul(v.sub(SAIL_BELLY_FOOT))),
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

  /** deepest around mid-height, tapering to the yard, easing at the free foot */
  // VERTEX STAGE. A vertex displacement is band-limited
  // by the MESH, not the pixel grid — `fwidth` is not even defined here, and the
  // panel can carry no feature finer than its own quads. The limit is
  // samples-per-feature on the mesh, and it is ENFORCED: buildSailGeometry sizes
  // its segments through sailClothSegments() from the same lacing count the
  // shape uses, at SAIL_SAMPLES_PER_PANEL each. This profile is one smooth hump
  // over the whole drop — far coarser than the quilting that sets that bound.
  // @band-limited-elsewhere
  const downAt = Fn(([v]: [Node]) => {
    const headTaper = smoothstep(float(0), float(SAIL_BELLY_HEAD), v.oneMinus());
    // @band-limited-elsewhere — see above
    const footEase = mix(float(SAIL_FOOT_FILL), float(1), smoothstep(float(0), float(SAIL_BELLY_FOOT), v));
    return headTaper.mul(footEase);
  });

  /**
   * The free LEECH: zero at the yardarm (v = 1) and at the clew (v = 0),
   * maximal between; zero at mid-width, maximal at both edges. A square sail's
   * leech is bent to the ship at exactly two points and flies between them —
   * pinning it at every height is what made the outline a perfect rectangle.
   */
  const leechAt = Fn(([uu, v]: [Node, Node]) =>
    midArch(uu).oneMinus().mul(sin(v.mul(Math.PI))),
  );

  /** billow + flutter offset (m, along local +z = forward of the yard) */
  const clothZ = Fn(([uu, v]: [Node, Node]) => {
    // QUILTING (sailShapeProfiles.seamQuiltProfile): each cloth panel bellies
    // between its two seams, which hold. Zero-mean, so it redistributes camber
    // rather than adding any, and it rides the belly envelope so it dies at the
    // pinned leeches and at the head. IN THE SHAPE, not the shading — a line
    // painted on a smooth interior does not change how the surface reads.
    const q = sin(uu.sub(SAIL_LACE_MARGIN).div(SAIL_LACE_SPAN).mul(laces.sub(1)).mul(Math.PI));
    const quilt = u.seamQuilt.mul(q.mul(q).sub(0.5)).mul(acrossAt(uu, v)).mul(downAt(v));
    // §T.74c: the tension field divides the WHOLE section — quilting and leech
    // standoff are cloth too, and cloth hauled bar-taut into a clew cannot
    // corrugate or fly any more than it can belly. Division only ever takes
    // depth away, so `depth` stays the §V44 bound on the whole expression.
    const belly = depth
      .mul(acrossAt(uu, v).mul(downAt(v)).add(quilt).add(u.leechOpen.mul(leechAt(uu, v))))
      .div(tensionAt(uu, v));
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
    return belly
      .add(wave.mul(u.flutterAmp).mul(shake).mul(v.oneMinus()).mul(edge).mul(set))
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
      .mul(arcShorten(camber.mul(downAt(v)).div(tensionAt(float(0.5), v))))
      .add(cornerPull(uu, v).x),
  );
  const clothY = Fn(([uu, v]: [Node, Node]) => {
    // both terms of the section bow this strip: the membrane belly (zero at
    // the leech) and the leech's own standoff (zero at mid-width)
    const stripBow = acrossAt(uu, v).add(u.leechOpen.mul(midArch(uu).oneMinus()));
    const spanShrink = arcShorten(
      camber
        .mul(stripBow)
        .mul(width)
        .div(builtDrop)
        .div(tensionAt(uu, float(SAIL_BELLY_FOOT))),
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
