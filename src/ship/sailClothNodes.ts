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
  SAIL_DRAFT_MAX,
  SAIL_DRAFT_MIN,
  SAIL_FLUTTER_BASE,
  SAIL_FLUTTER_EDGE,
  SAIL_FLUTTER_V,
  SAIL_FOOT_FILL,
  SAIL_LEAD_MAX,
  SAIL_SKEW_LEAD,
} from './sailShape';
import type { SailWindUniforms } from './sailDriver';

const TAU = Math.PI * 2;

type Node = ReturnType<typeof float>;
type UniformNode = ReturnType<typeof uniform>;

/** the shape uniforms, so the material can refresh them from params */
export interface SailShapeUniforms {
  camber: UniformNode;
  camberMax: UniformNode;
  leechOpen: UniformNode;
  footRoach: UniformNode;
  twist: UniformNode;
  sheetPull: UniformNode;
  draftPos: UniformNode;
  draftFullness: UniformNode;
  furlSwag: UniformNode;
  furlBays: UniformNode;
  flutterAmp: UniformNode;
  luffFlap: UniformNode;
  rippleCount: UniformNode;
}

export interface SailClothNodes {
  /** material.positionNode */
  position: Node;
  /** the billowed surface normal, in LOCAL space (pre-view-transform) */
  localNormal: Node;
  /** the cloth's own u tangent in local space — the seam ridge tilts along it */
  uTangent: Node;
  /** 1 on cloth the shader may move, 0 on robands and the furled bundle */
  clothWeight: Node;
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
  // live trim: easing the sheets shortens the canvas continuously instead of
  // popping between trim states
  const set = clamp(wind.dropScale, float(0), float(1));

  /**
   * PEAK CAMBER AS A FRACTION OF THE CHORD, bounded at source (§V44), and
   * eased by the trim because a deeply reefed sail is flatter.
   *
   * This used to be `sailBillow × drop` — a fraction of the sail's HEIGHT for
   * a bow that runs across its WIDTH. Measured on the shipped params, the main
   * course carried 24.8% of chord at the default sea and 40.7% in a storm,
   * against a real square sail's 10-15%. That mis-scaling is the whole of the
   * user's "still looks very very bulgy".
   */
  const camber = clamp(
    wind.drive.mul(u.camber),
    u.camberMax.negate(),
    u.camberMax,
  ).mul(set);
  const depth = camber.mul(width);

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
  const downAt = Fn(([v]: [Node]) =>
    smoothstep(float(0), float(SAIL_BELLY_HEAD), v.oneMinus()).mul(
      mix(float(SAIL_FOOT_FILL), float(1), smoothstep(float(0), float(SAIL_BELLY_FOOT), v)),
    ),
  );

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
    const belly = depth.mul(
      acrossAt(uu, v).mul(downAt(v)).add(u.leechOpen.mul(leechAt(uu, v))),
    );
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
    return belly
      .add(wave.mul(u.flutterAmp).mul(shake).mul(v.oneMinus()).mul(edge))
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
  const clothX = Fn(([uu, v]: [Node, Node]) =>
    uu.sub(0.5).mul(width).mul(arcShorten(camber.mul(downAt(v)))).add(cornerPull(uu, v).x),
  );
  const clothY = Fn(([uu, v]: [Node, Node]) => {
    // both terms of the section bow this strip: the membrane belly (zero at
    // the leech) and the leech's own standoff (zero at mid-width)
    const stripBow = acrossAt(uu, v).add(u.leechOpen.mul(midArch(uu).oneMinus()));
    const spanShrink = arcShorten(camber.mul(stripBow).mul(width).div(builtDrop));
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
  const position = positionLocal.add(shaped.sub(flat).mul(clothWeight));

  // normals rebuilt from the live surface (finite differences in cloth space)
  // — without this the billow is invisible to the lighting. All three
  // components move now, so both tangents carry all three.
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

  return {
    position,
    localNormal: cross(du, dv).normalize(),
    uTangent: du.normalize(),
    clothWeight,
    width,
  };
}

/** build the shape uniforms; the material owns refreshing them */
export function createSailShapeUniforms(p: ShipMaterialParams): SailShapeUniforms {
  return {
    camber: uniform(p.sailCamber),
    camberMax: uniform(p.sailCamberMax),
    leechOpen: uniform(p.sailLeechOpen),
    footRoach: uniform(p.sailFootRoach),
    twist: uniform(p.sailTwist),
    sheetPull: uniform(p.sailSheetPull),
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
  u.camber.value = p.sailCamber;
  u.camberMax.value = p.sailCamberMax;
  u.leechOpen.value = p.sailLeechOpen;
  u.footRoach.value = p.sailFootRoach;
  u.twist.value = p.sailTwist;
  u.sheetPull.value = p.sailSheetPull;
  u.draftPos.value = p.sailDraftPos;
  u.draftFullness.value = p.sailDraftFullness;
  u.furlSwag.value = p.sailFurlSwag;
  u.furlBays.value = p.sailFurlBays;
  u.flutterAmp.value = p.sailFlutterAmp;
  u.luffFlap.value = p.sailLuffFlap;
  u.rippleCount.value = p.sailRippleCount;
}
