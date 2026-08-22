/**
 * Low-poly greybox geometry for the raft's piece kinds (§T89). Sized from the
 * piece AABB like every other family (§V18); `shape` hints are plain numbers.
 * Logs = tapered cylinders, 12 sides; mats/planks/thatch = slabs; weave = a
 * thin box (the material does the weave, §T90). Tri budget well under the
 * brigantine — tests/raft.test.ts measures both.
 */
import * as THREE from 'three';
import type { AABB } from './pieceTypes';
import { aabbCenter, aabbSize, mergeNonIndexed } from './pieceGeometryShapes';
import { vhash, vjitter, vrange } from './variation';

function slab(aabb: AABB): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const c = aabbCenter(aabb);
  return new THREE.BoxGeometry(s.x, s.y, s.z).translate(c.x, c.y, c.z);
}

/** an axis-aligned box given as min/max in the piece's own frame */
function boxBetween(
  x0: number, x1: number, y0: number, y1: number, z0: number, z1: number,
): THREE.BufferGeometry {
  return new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0)
    .translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
}

/**
 * §B97 — CUT ONE FACE OF A BOX TO A SLANT, keeping every face planar so the
 * recomputed normals stay exact and unit (§T129's roof test asserts both).
 *
 * Every vertex sitting on the plane x = `xFace` slides to x − `shear`·y. The
 * cut face, the top, the bottom and the two ends all stay flat (the first
 * because it is the image of a plane under a shear, the others because they
 * are y- or z-constant), so `computeVertexNormals` on the non-indexed box
 * gives one exact normal per face and no vertex is shared across two.
 */
function mitreFace(box: THREE.BufferGeometry, xFace: number, shear: number): THREE.BufferGeometry {
  if (Math.abs(shear) < 1e-9) return box;
  const g = box.index !== null ? box.toNonIndexed() : box;
  if (g !== box) box.dispose();
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(pos.getX(i) - xFace) > 1e-9) continue;
    pos.setX(i, pos.getX(i) - shear * pos.getY(i));
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/**
 * A cylinder of radius `r` running from `a` to `b`. `sides` 4 is deliberate on
 * rope and wire: at 2 cm nobody reads the section, and a slack rope needs its
 * SAG (several segments), which is where the triangles are worth spending.
 */
function strut(a: THREE.Vector3, b: THREE.Vector3, r: number, sides = 4): THREE.BufferGeometry {
  const d = new THREE.Vector3().subVectors(b, a);
  const len = Math.max(1e-4, d.length());
  const geo = new THREE.CylinderGeometry(r, r, len, sides, 1);
  geo.rotateX(Math.PI / 2); // +y → +z, so the cylinder runs along local z
  // Matrix4.lookAt(eye, target, up) puts +z along (eye − target), so passing
  // the direction as the EYE aims +z down the direction
  geo.applyMatrix4(new THREE.Matrix4().lookAt(d, new THREE.Vector3(), new THREE.Vector3(0, 1, 0)));
  return geo.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
}

/** balsa log along local z: stern (−z) radius from the aabb, bow tapered + chamfered */
export function buildLogGeometry(aabb: AABB, shape: Record<string, number> = {}): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const c = aabbCenter(aabb);
  const r = s.x / 2;
  const taper = poleTaper(shape);
  const chamfer = Math.min(s.z * 0.4, Math.max(0, shape.chamfer ?? 0));
  const sides = Math.max(6, Math.round(shape.sides ?? 12));
  const bodyLen = s.z - chamfer;
  const rBow = r * taper;
  // §B81: the taper lives in the LAST `taperLen` of the log, not along its
  // whole length — a 13.7 m log tapering end to end opened 0.1 m of water
  // between neighbours amidships; the lashed body is full-round [§1 Gaps]
  const taperLen = Math.min(bodyLen, Math.max(0, shape.taperLen ?? bodyLen));
  const trunkLen = bodyLen - taperLen;
  const parts: THREE.BufferGeometry[] = [];
  // CylinderGeometry runs along +y with radiusTop at +y; rotateX(π/2) maps +y → +z (bow)
  if (trunkLen > 1e-4) {
    const trunk = new THREE.CylinderGeometry(r, r, trunkLen, sides);
    trunk.rotateX(Math.PI / 2);
    trunk.translate(0, 0, -s.z / 2 + trunkLen / 2);
    parts.push(trunk);
  }
  if (taperLen > 1e-4) {
    const body = new THREE.CylinderGeometry(rBow, r, taperLen, sides);
    body.rotateX(Math.PI / 2);
    body.translate(0, 0, -s.z / 2 + trunkLen + taperLen / 2);
    parts.push(body);
  }
  if (chamfer > 0) {
    const tip = new THREE.CylinderGeometry(rBow * 0.3, rBow, chamfer, sides);
    tip.rotateX(Math.PI / 2);
    tip.translate(0, 0, s.z / 2 - chamfer / 2);
    parts.push(tip);
  }
  return mergeNonIndexed(parts).translate(c.x, c.y, c.z);
}

/** crossbeam along local x */
export function buildCrossbeamGeometry(aabb: AABB, shape: Record<string, number> = {}): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const c = aabbCenter(aabb);
  const sides = Math.max(6, Math.round(shape.sides ?? 10));
  const geo = new THREE.CylinderGeometry(s.y / 2, s.y / 2, s.x, sides);
  geo.rotateZ(Math.PI / 2);
  return geo.translate(c.x, c.y, c.z);
}

/**
 * A POLE'S RADIUS AT THE HEAD, as a fraction of its radius at the foot. Same
 * one-owner rule as MAST_TOP_SCALE: the geometry below is built with it and
 * `shipAssembly.ts` builds the sail's collision capsule with it (§T.114).
 */
export function poleTaper(shape: Record<string, number> = {}): number {
  return Math.min(1, Math.max(0.3, shape.taper ?? 1));
}

/** a pole along local +y from aabb.min.y (bipod legs, flag pole), or a rope ladder */
export function buildPoleGeometry(aabb: AABB, shape: Record<string, number> = {}): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const c = aabbCenter(aabb);
  if ((shape.ladder ?? 0) > 0) return ladder(aabb, shape.rungPitch ?? 0.35);
  const r = s.x / 2;
  const taper = Math.min(1, Math.max(0.3, shape.taper ?? 1));
  const sides = Math.max(6, Math.round(shape.sides ?? 10));
  const geo = new THREE.CylinderGeometry(r * taper, r, s.y, sides);
  return geo.translate(c.x, aabb.min[1] + s.y / 2, c.z);
}

/** two side ropes + wooden rungs, in the aabb's xy plane */
function ladder(aabb: AABB, pitch: number): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const c = aabbCenter(aabb);
  const parts: THREE.BufferGeometry[] = [];
  const ropeR = 0.015;
  for (const sign of [-1, 1]) {
    const rope = new THREE.CylinderGeometry(ropeR, ropeR, s.y, 5);
    rope.translate(sign * (s.x / 2 - ropeR), aabb.min[1] + s.y / 2, c.z);
    parts.push(rope);
  }
  const count = Math.max(1, Math.floor(s.y / Math.max(0.15, pitch)));
  for (let i = 1; i <= count; i++) {
    const rung = new THREE.CylinderGeometry(0.02, 0.02, s.x, 6);
    rung.rotateZ(Math.PI / 2);
    rung.translate(0, aabb.min[1] + i * pitch, c.z);
    parts.push(rung);
  }
  return mergeNonIndexed(parts).translate(c.x, 0, 0);
}

/** woven wall panel; a gable end carries a triangle up to the ridge (`shape.gable` = rise) */
export function buildCabinWallGeometry(aabb: AABB, shape: Record<string, number> = {}): THREE.BufferGeometry {
  const rise = shape.gable ?? 0;
  if (rise <= 0) return slab(aabb);
  const s = aabbSize(aabb);
  const c = aabbCenter(aabb);
  const eave = s.y - rise;
  const profile = new THREE.Shape();
  profile.moveTo(-s.x / 2, 0);
  profile.lineTo(s.x / 2, 0);
  profile.lineTo(s.x / 2, eave);
  profile.lineTo(0, s.y);
  profile.lineTo(-s.x / 2, eave);
  profile.closePath();
  const geo = new THREE.ExtrudeGeometry(profile, { depth: s.z, bevelEnabled: false });
  return geo.translate(c.x, aabb.min[1], aabb.min[2]);
}

/** balsa block with its two thole-pins standing on top */
export function buildSternBlockGeometry(aabb: AABB, shape: Record<string, number> = {}): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const c = aabbCenter(aabb);
  const parts: THREE.BufferGeometry[] = [slab(aabb)];
  const pinH = shape.pinHeight ?? 0.3;
  const pinR = shape.pinRadius ?? 0.03;
  const spacing = shape.pinSpacing ?? 0.4;
  for (const sign of [-1, 1]) {
    const pin = new THREE.CylinderGeometry(pinR * 0.85, pinR, pinH, 6);
    pin.translate(c.x + sign * spacing / 2, aabb.max[1] + pinH / 2, c.z);
    parts.push(pin);
  }
  void s;
  return mergeNonIndexed(parts);
}

/** mangrove shaft along local z (+z inboard), fir blade at the aft end, tiller cross-piece */
export function buildSteeringOarGeometry(aabb: AABB, shape: Record<string, number> = {}): THREE.BufferGeometry {
  const inboard = shape.inboard ?? aabb.max[2];
  const aft = -aabb.min[2];
  const shaftR = shape.shaftRadius ?? 0.045;
  const bladeLen = Math.min(aft, shape.bladeLength ?? 1.2);
  const bladeW = shape.bladeWidth ?? 0.4;
  const tiller = shape.tillerLength ?? 0.9;
  const len = inboard + aft;
  const shaft = new THREE.CylinderGeometry(shaftR * 0.8, shaftR, len, 8);
  shaft.rotateX(Math.PI / 2);
  shaft.translate(0, 0, inboard - len / 2);
  const blade = new THREE.BoxGeometry(0.035, bladeW, bladeLen);
  blade.translate(0, 0, -aft + bladeLen / 2);
  const cross = new THREE.CylinderGeometry(0.03, 0.03, tiller, 6);
  cross.rotateZ(Math.PI / 2);
  cross.translate(0, 0, inboard - 0.3);
  return mergeNonIndexed([shaft, blade, cross]);
}

/**
 * Crates, cans, dinghy, cage: boxes; `shape.round` = a drum or a pot (with
 * `shape.sides` — a 0.24 m pot does not need a drum's 12), `shape.lash` = that
 * many hemp bands strapping the box down (§B87: three identical unlashed boxes
 * read as one box copied three times).
 */
export function buildCrateGeometry(aabb: AABB, shape: Record<string, number> = {}): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const c = aabbCenter(aabb);
  if ((shape.round ?? 0) > 0) {
    const r = Math.min(s.x, s.z) / 2;
    const sides = Math.max(5, Math.round(shape.sides ?? 12));
    return new THREE.CylinderGeometry(r, r, s.y, sides).translate(c.x, c.y, c.z);
  }
  /**
   * §T.150 — SALVAGED CARD IS NOT A SLAB. The radio corner's screen was one
   * flat box, and a flat box the size of a door is what the user kept calling
   * "this black huge box in the middle of the cabin". A sheet of card that has
   * been aboard a raft is FOLDED (that is how it got here and how it stands up
   * at all) and its top edge is TORN, so the shape carries a vertical crease
   * the light breaks on and a ragged head that never reads as a ruled line.
   * Same aabb, so the deck field and the §V83 obstacle are untouched.
   */
  if ((shape.card ?? 0) > 0) {
    const n = Math.max(2, Math.round(shape.leaves ?? 5));
    const fold = Math.max(0, shape.fold ?? s.x * 0.9);
    const tear = Math.max(0, shape.tear ?? s.y * 0.06);
    const seed = shape.seed ?? 0;
    const parts: THREE.BufferGeometry[] = [];
    for (let k = 0; k < n; k++) {
      const z0 = aabb.min[2] + (s.z * k) / n;
      const z1 = aabb.min[2] + (s.z * (k + 1)) / n;
      // a shallow V about the middle of the run: |2t−1| swings the leaf out
      const t = (k + 0.5) / n;
      const off = fold * (Math.abs(2 * t - 1) - 0.5);
      const top = aabb.max[1] - tear * (0.5 + vhash(seed, 71, k));
      parts.push(boxBetween(aabb.min[0] + off, aabb.max[0] + off, aabb.min[1], top, z0, z1));
    }
    return mergeNonIndexed(parts);
  }
  const bands = Math.max(0, Math.round(shape.lash ?? 0));
  if (bands === 0) return slab(aabb);
  const rope = Math.max(0.005, shape.lashRope ?? 0.02);
  const seed = shape.seed ?? 0;
  const parts: THREE.BufferGeometry[] = [slab(aabb)];
  for (let k = 0; k < bands; k++) {
    // one band = the three faces a rope crossing a crate on the deck shows:
    // over the top and down both sides. The underside is on the deck.
    const t = (k + 1) / (bands + 1) + vjitter(0.06, seed, 41, k);
    const z = aabb.min[2] + s.z * Math.min(0.9, Math.max(0.1, t));
    const z0 = z - rope / 2;
    const z1 = z + rope / 2;
    parts.push(boxBetween(aabb.min[0] - rope * 0.4, aabb.max[0] + rope * 0.4,
      aabb.max[1] - rope * 0.4, aabb.max[1] + rope * 0.6, z0, z1));
    for (const x of [aabb.min[0], aabb.max[0]]) {
      const sign = x < c.x ? -1 : 1;
      parts.push(boxBetween(x - (sign < 0 ? rope * 0.6 : rope * 0.4), x + (sign < 0 ? rope * 0.4 : rope * 0.6),
        aabb.min[1], aabb.max[1] - rope * 0.4, z0, z1));
    }
  }
  return mergeNonIndexed(parts);
}

/**
 * §T.144 — THE SLOT A GUARA STANDS IN.
 *
 * USER: "it could be neat to have the guara rails have a little bit of a slot
 * on top of the deck so that they don't look so plopped in and random." [§2
 * Fixing] holds the planks "on edge, wedges + ropes", which is the same thing
 * seen from the raft's side: a 25 mm fir board does not stand upright in a
 * chink by itself. Four timbers round a rectangular hole, pegged to whatever
 * surface the plank comes through — the mats forward, the bare logs aft.
 *
 * WHOSE FRAME (§V71): the collar is a piece of the RAFT, never a child of the
 * plank. §B100 wired `setGuaraDepths` to `shape.travel`, so a guara now slides
 * through this hole every time the crew works it; a collar parented to the
 * board would ride up with it, which is the same defect the parrel seizing
 * had (§T.138) in a new place. `slotX`/`slotZ` are the hole's HALF sizes.
 */
export function buildGuaraCollarGeometry(aabb: AABB, shape: Record<string, number> = {}): THREE.BufferGeometry {
  const sx = Math.max(1e-3, shape.slotX ?? aabbSize(aabb).x / 4);
  const sz = Math.max(1e-3, shape.slotZ ?? aabbSize(aabb).z / 4);
  const [x0, y0, z0] = aabb.min;
  const [x1, y1, z1] = aabb.max;
  return mergeNonIndexed([
    // the two cheeks the board is wedged between, running the length of the slot
    boxBetween(x0, Math.min(-sx, x1), y0, y1, z0, z1),
    boxBetween(Math.max(sx, x0), x1, y0, y1, z0, z1),
    // and the two end blocks that close the hole
    boxBetween(-sx, sx, y0, y1, z0, Math.min(-sz, z1)),
    boxBetween(-sx, sx, y0, y1, Math.max(sz, z0), z1),
  ]);
}

// ---------------------------------------------------------------------------
// §B87 — THE ROOF IS COURSES, NOT A SLAB.
//
// [§3 Roof] "bamboo laths + overlapping banana leaves (tiles); museum: palm
// thatch, ragged overhang 20–30 cm". A single smooth box has no step for the
// sun to catch, so at every hour it reads as a painted plane — which is what
// the user called it. The geometry here is what the reference describes: the
// courses are laid from the eave up, each lapping `overlap` back under the one
// above and standing `rise` proud of the one below, and the eave course is
// broken into butts of different lengths.

/** one thatch course, in the roof piece's own local axes */
export interface ThatchCourse {
  /** distance DOWN the slope from the ridge to the course's head (up-slope edge), m */
  head: number;
  /** …and to its butt (the exposed down-slope edge), m */
  butt: number;
  /** local y of the course's outer surface */
  top: number;
  /** local y of its underside — shared, so the laths sit under a flat ceiling */
  bottom: number;
}

/**
 * The courses of one roof slope, as a pure function of the slope's length and
 * the pitch/overlap/rise params. Exported because the §V80 property ("each
 * course overlaps its neighbour", "the eave hangs 20–30 cm") is a property of
 * THIS list, not of a merged BufferGeometry the test would have to re-derive.
 *
 * @param slabLen the slope's length from ridge to eave tip, m
 * @param top     local y of the ridge course's outer surface (= roof thickness)
 */
export function thatchCourses(
  slabLen: number,
  top: number,
  shape: Record<string, number> = {},
): ThatchCourse[] {
  const pitch = Math.max(0.05, shape.coursePitch ?? 0.3);
  const overlap = Math.max(0, shape.courseOverlap ?? 0.14);
  const rise = Math.max(0, shape.courseRise ?? 0.015);
  const seed = shape.seed ?? 0;
  const n = Math.max(1, Math.ceil(slabLen / pitch));
  /**
   * §T.140 / §B97 — THE UNDERSIDE IS THE PIECE'S OWN FLOOR, y = 0.
   *
   * It used to be −(top·0.4 + rise·(n−1)) = −0.092 while the piece's aabb
   * declared min y = 0, which made a "0.08 m" roof 0.172 m thick at the ridge
   * (0.112 at the eave) and hung the whole slab below the plane the walls
   * meet — the user's "the roof is a little bit too chunky", and the reason
   * each soffit crossed the ridge centreline into the other slope (§B97). The
   * stack now hangs DOWN from `top`: the ridge course is `roofThickness` deep,
   * every course toward the eave one `rise` shallower, and the shared
   * underside is the lath plane the aabb always claimed it was.
   */
  const bottom = 0;
  const out: ThatchCourse[] = [];
  for (let k = 0; k < n; k++) {
    // k = 0 at the RIDGE: the upper course lies over the lower one, so the
    // surface steps DOWN by `rise` at every butt going toward the eave
    const wander = vjitter(rise, seed, 61, k);
    const butt = k === n - 1 ? slabLen : Math.min(slabLen, (k + 1) * pitch + wander);
    out.push({
      head: Math.max(0, k * pitch - overlap),
      butt,
      top: top - k * rise,
      bottom,
    });
  }
  return out;
}

/**
 * THE RAGGED EAVE: how far down the slope each butt of the bottom course
 * reaches, one per segment along the ridge. Never PAST the slab, so the piece's
 * own `roofOverhang` stays the maximum and every butt lands inside the
 * reference's 20–30 cm [§3 Roof]. Exported for the same reason as
 * {@link thatchCourses}: the property is a property of these numbers.
 */
export function thatchEaveButts(slabLen: number, shape: Record<string, number> = {}): number[] {
  const segs = Math.max(1, Math.round(shape.eaveSegments ?? 6));
  const ragged = Math.max(0, shape.eaveRagged ?? 0.05);
  const seed = shape.seed ?? 0;
  const head = thatchCourses(slabLen, 1, shape).slice(-1)[0].head;
  const out: number[] = [];
  for (let j = 0; j < segs; j++) {
    const reach = slabLen - ragged * 0.5 + vjitter(ragged * 0.5, seed, 62, j);
    out.push(Math.min(slabLen, Math.max(head + 0.02, reach)));
  }
  return out;
}

/**
 * §B97/§T.140 — THE RIDGE IS A MITRE, and this is the run the courses are laid
 * over.
 *
 * The slab's ridge end is cut to a plane that is VERTICAL once the piece is
 * rotated onto its slope, so the two slopes meet ON the ridge plane instead of
 * each running its own soffit past it. That cut reaches `roofThickness·tan θ`
 * further up-slope at the top face than at the underside, so the piece's aabb
 * carries that much extra on its ridge side — and the COURSES must not, or a
 * 1.481 m slope would silently become 1.504 m and gain a sixth course. Both
 * the builder and the §V80 property tests ask this one function for the run.
 */
export function thatchSlabRun(aabb: AABB, shape: Record<string, number> = {}): number {
  return aabbSize(aabb).x - Math.max(0, shape.mitre ?? 0);
}

/**
 * One slope of the thatch. `shape.eaveSign` says which way local +x runs down
 * the slope (the two slabs are mirrored about the ridge, so it is +1 to
 * starboard and −1 to port); the aabb gives the slope length (x, plus the
 * ridge mitre's allowance), the roof thickness (y) and the ridge length (z).
 */
export function buildThatchRoofGeometry(aabb: AABB, shape: Record<string, number> = {}): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const sign = (shape.eaveSign ?? 1) < 0 ? -1 : 1;
  const run = thatchSlabRun(aabb, shape);
  const half = run / 2;
  const zHalf = s.z / 2;
  // local-x displacement per metre of local y that keeps the ridge face on the
  // ridge PLANE: the piece is rotated by −sign·θ about z, so a point (x, y)
  // lands at x·cos θ + sign·y·sin θ and the face has to solve for a constant
  const ridgeShear = sign * Math.tan(Math.max(0, shape.ridgeSlope ?? 0));
  const courses = thatchCourses(run, aabb.max[1], shape);
  // local x of a distance `d` down-slope from the ridge
  const at = (d: number): number => sign * (d - half);
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < courses.length; k++) {
    const c = courses[k];
    // §T129a — DRAW THE COURSE, NOT THE PART OF IT THAT IS BURIED. A course
    // laps back under the one above it (that lap is real, and `thatchCourses`
    // keeps it), but every course shares ONE underside, so the lapped stretch
    // put two course boxes on the same ceiling plane facing the same way over
    // 0.14 m × 4.8 m — 2 m² of z-fighting under each slope, and the fight lands
    // exactly on the eave soffit a man at the tiller is looking up at. The
    // upper course's box already fills that stretch (same bottom, higher top),
    // so the lower one starts where its neighbour's butt ends: identical
    // silhouette, no shared plane, no overdraw (same box count, so the tri
    // budget is untouched).
    const head = k === 0 ? c.head : Math.max(c.head, courses[k - 1].butt);
    const x0 = Math.min(at(head), at(c.butt));
    const x1 = Math.max(at(head), at(c.butt));
    if (k < courses.length - 1) {
      const box = boxBetween(x0, x1, c.bottom, c.top, -zHalf, zHalf);
      // only the RIDGE course reaches the centreline, so only it is mitred
      parts.push(head <= 1e-9 ? mitreFace(box, at(0), ridgeShear) : box);
      continue;
    }
    // THE EAVE COURSE IS RAGGED: broken into butts of different lengths, so
    // the roof ends in a torn fringe and not a ruled line [§3 Roof]
    //
    // §B109 — EACH BUTT SPANS `head` → ITS OWN BUTT, and that span is taken in
    // DOWN-SLOPE metres before it is mapped through `at`, never by min/max on
    // the already-mapped x. `at` REVERSES on the port slope (`eaveSign` −1), so
    // the old `Math.min(x0, bx)`/`Math.max(x0, bx)` — with x0 pinned to the
    // course's full butt — measured the port butt from the wrong end and drew
    // it as a `ragged`-wide sliver at the very tip. Everything from the fourth
    // course's butt down to the fringe went missing on that slope alone, which
    // is the user's "premature end of the roof… a finishing beam at the end":
    // 0.23 m of bare bamboo lath along the whole 4.8 m port eave. The
    // starboard slope was correct the entire time, which is exactly why it
    // read as deliberate.
    const butts = thatchEaveButts(run, shape);
    const ragged = Math.max(0, shape.eaveRagged ?? 0.05);
    for (let j = 0; j < butts.length; j++) {
      const zA = -zHalf + (s.z * j) / butts.length;
      const zB = -zHalf + (s.z * (j + 1)) / butts.length;
      const hx = at(head);
      const bx = at(butts[j]);
      const box = boxBetween(Math.min(hx, bx), Math.max(hx, bx), c.bottom, c.top,
        zA + ragged * 0.1, zB - ragged * 0.1);
      // a one-course slope is its own ridge course as well as its own eave
      parts.push(head <= 1e-9 ? mitreFace(box, at(0), ridgeShear) : box);
    }
  }
  return mergeNonIndexed(parts);
}

/**
 * The bamboo laths the thatch is tied to [§3 Roof]. Run DOWN the slope (local
 * x, the whole slab length) and spaced along the ridge, because that is the
 * axis the bamboo family's cane pattern runs along on a slab's underside —
 * and the underside is the only face anyone sees, from inside the cabin.
 */
export function buildRoofLathsGeometry(aabb: AABB, shape: Record<string, number> = {}): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const n = Math.max(1, Math.round(shape.laths ?? 4));
  const seed = shape.seed ?? 0;
  const w = Math.max(0.01, shape.section ?? s.y);
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < n; k++) {
    const z = aabb.min[2] + (s.z * (k + 0.5)) / n + vjitter(s.z / (n * 6), seed, 63, k);
    parts.push(boxBetween(aabb.min[0], aabb.max[0], aabb.min[1], aabb.min[1] + w, z - w / 2, z + w / 2));
  }
  return mergeNonIndexed(parts);
}

// ---------------------------------------------------------------------------

/**
 * §B87 / §T.150 — THE RADIO. A jury-rigged shortwave built round a salvaged
 * car-radio face [2100 dressing]: a case on rubber feet, a brow standing over
 * a recessed tuning dial in its bezel, a signal meter, a speaker grille, two
 * knobs (tuning and volume — design doc §05 names both), one LED, a carry bail
 * over the top, a hand crank on the flank and the aerial lead-out.
 *
 * §T.150 — WHY IT GREW. Measured from the doorway, the §T.117 set's silhouette
 * filled 0.88 of its own convex hull: a block with a stub on the side. A radio
 * is read by its OUTLINE first and its face second — the user's "it should
 * look like a radio, have a better shape, more complex than just a box" — so
 * the parts that earn their triangles here are the ones that notch the
 * outline: the bail, the brow, the feet, the two proud knobs. 260 → ~540 tris,
 * against a 14 k raft.
 *
 * DEPTH IS THE MATERIAL CONTRACT (raftMaterials createRadioMaterial). The
 * shader reads local z and nothing else: the body behind `radioFacePlane`, the
 * pale plate/dial/meter glass between the planes, the dark furniture in front
 * of `radioTrimPlane`, and — §T.150 — THE LED ALONE in front of
 * `radioLedPlane`, which is why nothing but the lens may reach `zLed`.
 *
 * §B111 — THE LED WAS NEVER LIT, and this is the file that broke it. The
 * material used to pick the lens out of the front band by its CORNER in the
 * mesh's own normalised bounds ("top starboard, the only thing up there"), but
 * the crank reaches 0.279 in x and the aerial lead 0.200 in y, so the box the
 * fractions are taken over is 0.47 × 0.33, not 0.40 × 0.26 — and the lens sat
 * at f = (0.785, 0.669) against a gate of (0.88, 0.84). It scored zero at
 * every fragment from the day the crank was added. A DEPTH plane cannot be
 * moved by anything bolted to a flank, which is the §V71 lesson: resolve a
 * part against the surface's own evaluator, not against a bound some sibling
 * is free to inflate.
 */
export function buildRadioGeometry(aabb: AABB, shape: Record<string, number> = {}): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const c = aabbCenter(aabb);
  const w = s.x;
  const h = s.y;
  const d = s.z;
  const dialR = Math.max(0.02, shape.dial ?? w * 0.32) / 2;
  const knobR = Math.max(0.008, shape.knob ?? w * 0.1) / 2;
  const meterW = Math.max(0.02, shape.meterWidth ?? w * 0.28);
  const meterH = Math.max(0.02, shape.meterHeight ?? h * 0.27);
  const crank = Math.max(0.03, shape.crank ?? 0.12);
  const bail = Math.max(0, shape.handle ?? h * 0.3);
  const foot = Math.max(0, shape.foot ?? h * 0.07);
  const volumeAngle = shape.volumeAngle ?? 0.4;
  const parts: THREE.BufferGeometry[] = [];
  const zPlate = d * 0.2; // back of the face plate
  const zFace = d * 0.38; // plate surface — the pale field
  const zGlass = d * 0.42; // dial disc / meter glass, still pale
  const zProud = d * 0.46; // needles, knobs, bezel, brow — dark
  const zLed = d * 0.5; // THE LENS, and nothing else, ever

  // FEET: the case stands off the crate on four blocks, so the bottom of the
  // silhouette is broken and a shadow runs under it
  const bodyY0 = -h / 2 + foot;
  for (const fx of [-1, 1]) {
    for (const fz of [-1, 1]) {
      const x = fx * w * 0.4;
      const z = fz * d * 0.26;
      parts.push(boxBetween(x - w * 0.06, x + w * 0.06, -h / 2, bodyY0 + 1e-4,
        z - d * 0.09, z + d * 0.09));
    }
  }

  // CASE + FACE PLATE. The body stops below the top so the brow can stand
  // over it: a plain box from foot to lid is the shape we are getting rid of.
  const browY = h * 0.34;
  parts.push(boxBetween(-w / 2, w / 2, bodyY0, browY, -d / 2, zPlate));
  parts.push(boxBetween(-w * 0.47, w * 0.47, -h * 0.42, browY - 1e-4, zPlate, zFace));
  // THE BROW: a lid that overhangs the plate. It is what stops the face
  // reading as a printed rectangle — it throws a hard line across the dial at
  // every hour, and it is the top edge of the outline from the doorway.
  parts.push(boxBetween(-w / 2, w / 2, browY, h / 2, -d / 2, zProud));

  // TUNING DIAL, port half of the face: a pale disc in a proud bezel with a
  // dark needle — the one control a player must find at a glance
  const dialX = -w * 0.28;
  const dialY = -h * 0.06;
  const disc = new THREE.CylinderGeometry(dialR, dialR, zGlass - zFace, 14);
  disc.rotateX(Math.PI / 2);
  parts.push(disc.translate(dialX, dialY, (zFace + zGlass) / 2));
  // the bezel: an open tube round the disc, standing proud of the plate, so
  // the dial is RECESSED rather than painted on
  const bezel = new THREE.CylinderGeometry(dialR * 1.14, dialR * 1.14, zProud - zFace, 16, 1, true);
  bezel.rotateX(Math.PI / 2);
  parts.push(bezel.translate(dialX, dialY, (zFace + zProud) / 2));
  const knob = new THREE.CylinderGeometry(dialR * 0.26, dialR * 0.3, zProud - zGlass, 8);
  knob.rotateX(Math.PI / 2);
  parts.push(knob.translate(dialX, dialY, (zGlass + zProud) / 2));

  // THE VOLUME KNOB [design doc §05: "one tuning knob, one volume knob"] —
  // a second knob low on the starboard half, with a pointer nub so a player
  // can see which way it is turned
  const volX = w * 0.4;
  const volY = -h * 0.24;
  const vol = new THREE.CylinderGeometry(knobR, knobR * 1.12, zProud - zFace, 10);
  vol.rotateX(Math.PI / 2);
  parts.push(vol.translate(volX, volY, (zFace + zProud) / 2));
  const nub = boxBetween(-0.004, 0.004, 0, knobR * 0.9, zProud - 0.004, zProud);
  nub.rotateZ(volumeAngle);
  parts.push(nub.translate(volX, volY, 0));

  // SIGNAL METER, starboard of the brow line, its needle, and a frame that
  // stands proud of the plate the way a meter's bezel does
  const meterX = w * 0.24;
  const meterY = h * 0.19;
  // …the needles themselves are their own PIECES (`radio-needle`,
  // `radio-meter-needle` in raftPartsCabin), because a needle merged into this
  // buffer can never move, and §T.136c/§V62 say a control the player turns has
  // to turn something he can see.
  parts.push(boxBetween(meterX - meterW / 2, meterX + meterW / 2,
    meterY - meterH / 2, meterY + meterH / 2, zFace, zGlass));
  const rim = 0.006;
  for (const [ax, ay, bx, by] of [
    [-meterW / 2 - rim, -meterH / 2 - rim, meterW / 2 + rim, -meterH / 2],
    [-meterW / 2 - rim, meterH / 2, meterW / 2 + rim, meterH / 2 + rim],
    [-meterW / 2 - rim, -meterH / 2, -meterW / 2, meterH / 2],
    [meterW / 2, -meterH / 2, meterW / 2 + rim, meterH / 2],
  ] as const) {
    parts.push(boxBetween(meterX + ax, meterX + bx, meterY + ay, meterY + by, zFace, zProud * 0.9));
  }

  // SPEAKER GRILLE: a recessed panel with four proud slats across it. Slats,
  // because a flat rectangle at this size is a sticker and a hole is a hole.
  const gx0 = w * 0.04;
  const gx1 = w * 0.34;
  const gy0 = -h * 0.36;
  const gy1 = h * 0.02;
  parts.push(boxBetween(gx0, gx1, gy0, gy1, zPlate, zFace * 0.96));
  for (let k = 0; k < 4; k++) {
    const y = gy0 + ((gy1 - gy0) * (k + 0.5)) / 4;
    parts.push(boxBetween(gx0, gx1, y - 0.004, y + 0.004, zFace * 0.96, zFace + 0.004));
  }

  // THE LED, top starboard of the plate. It is the ONLY geometry that reaches
  // `zLed`, which is the whole of how the shader finds it (§B111).
  const ledR = Math.max(0.006, w * 0.03);
  const led = new THREE.CylinderGeometry(ledR, ledR, zLed - zFace, 8);
  led.rotateX(Math.PI / 2);
  parts.push(led.translate(w * 0.42, h * 0.06, (zFace + zLed) / 2));

  // THE CARRY BAIL over the top: five short members swung up in an arch. The
  // single biggest break in the outline, and the reason the set reads as a
  // thing a person carried aboard rather than a block someone left.
  const bailR = 0.008;
  const segs = 5;
  for (let k = 0; k < segs; k++) {
    const t0 = k / segs;
    const t1 = (k + 1) / segs;
    const px = (t: number): number => (t * 2 - 1) * w * 0.34;
    const py = (t: number): number => h / 2 + bail * Math.sin(Math.PI * t);
    const ax = px(t0);
    const ay = py(t0);
    const bx = px(t1);
    const by = py(t1);
    const len = Math.hypot(bx - ax, by - ay);
    const seg = boxBetween(-len / 2 - bailR, len / 2 + bailR, -bailR, bailR, -bailR, bailR);
    seg.rotateZ(Math.atan2(by - ay, bx - ax));
    parts.push(seg.translate((ax + bx) / 2, (ay + by) / 2, -d * 0.08));
  }

  // HAND CRANK on the starboard side: shaft, arm, knob
  const shaft = new THREE.CylinderGeometry(0.012, 0.012, crank * 0.45, 6);
  shaft.rotateZ(Math.PI / 2);
  parts.push(shaft.translate(w / 2 + crank * 0.22, -h * 0.16, -d * 0.08));
  const arm = boxBetween(-0.012, 0.012, -0.012, crank * 0.62, -0.012, 0.012);
  parts.push(arm.translate(w / 2 + crank * 0.45, -h * 0.16, -d * 0.08));
  const grip = new THREE.CylinderGeometry(0.016, 0.016, 0.05, 6);
  grip.rotateZ(Math.PI / 2);
  parts.push(grip.translate(w / 2 + crank * 0.45, -h * 0.16 + crank * 0.6, -d * 0.08));

  // the aerial lead-out on the case top — the wire itself is its own piece
  const lead = new THREE.CylinderGeometry(0.005, 0.007, h * 0.28, 4);
  parts.push(lead.translate(-w * 0.36, h / 2 + h * 0.13, -d * 0.2));

  return mergeNonIndexed(parts).translate(c.x, c.y, c.z);
}

// ---------------------------------------------------------------------------

/**
 * §B87 / ref §10 — A SLACK-ROPE RAILING. Short stanchions along the deck edge
 * with a rope thrown between them; the reference's railing is sloppy, so the
 * posts lean, the spacing wanders and every span dips.
 *
 * With `shape.posts` at 0 the same builder is a bare sagging line between the
 * piece's two ends, which is what the radio's wire aerial is.
 *
 * The run is the piece's local z; the rope hangs at `aabb.max.y` and the posts
 * stand from `aabb.min.y`.
 */
export function buildRopeRailGeometry(aabb: AABB, shape: Record<string, number> = {}): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const c = aabbCenter(aabb);
  const posts = Math.max(0, Math.round(shape.posts ?? 0));
  const postR = Math.max(0.008, shape.postRadius ?? 0.04);
  const ropeR = Math.max(0.003, shape.rope ?? 0.02);
  const sag = Math.max(0, shape.sag ?? 0);
  const seg = Math.max(1, Math.round(shape.segments ?? 3));
  const seed = shape.seed ?? 0;
  const top = aabb.max[1];
  const foot = aabb.min[1];
  const parts: THREE.BufferGeometry[] = [];
  const stations: number[] = [];
  for (let k = 0; k < posts; k++) {
    const t = posts === 1 ? 0.5 : k / (posts - 1);
    stations.push(aabb.min[2] + s.z * t + vjitter(s.z * 0.035, seed, 71, k));
  }
  for (let k = 0; k < posts; k++) {
    const hk = (top - foot) * (1 + vjitter(0.09, seed, 72, k));
    const post = new THREE.CylinderGeometry(postR * 0.82, postR, hk, 6);
    post.rotateZ(vjitter(0.07, seed, 73, k));
    post.rotateX(vjitter(0.05, seed, 74, k));
    parts.push(post.translate(0, foot + hk / 2, stations[k]));
  }
  const nodes = stations.length >= 2 ? stations : [aabb.min[2], aabb.max[2]];
  for (let i = 0; i < nodes.length - 1; i++) {
    const dip = sag * vrange(0.6, 1.4, seed, 75, i);
    let prev = new THREE.Vector3(0, top, nodes[i]);
    for (let j = 1; j <= seg; j++) {
      const t = j / seg;
      const next = new THREE.Vector3(
        0,
        top - dip * 4 * t * (1 - t),
        nodes[i] + (nodes[i + 1] - nodes[i]) * t,
      );
      parts.push(strut(prev, next, ropeR));
      prev = next;
    }
  }
  if (parts.length === 0) return new THREE.BufferGeometry();
  return mergeNonIndexed(parts).translate(c.x, 0, 0);
}

/**
 * Lashings for ONE crossbeam: at each crossing listed in `shape` (`x0..x{n-1}`
 * = ship x of a log centreline, `logR` its radius, `beamR` the beam's) a
 * rope collar round the beam and a ring round the log, both `rope` thick and
 * `turns` ropes wide. The piece's origin is the beam's axis, so the log ring
 * hangs `beamR + logR` below it. One piece per beam keeps the draw count at
 * the beam count, not the crossing count.
 */
export function buildLashingGeometry(aabb: AABB, shape: Record<string, number> = {}): THREE.BufferGeometry {
  const n = Math.max(0, Math.round(shape.n ?? 0));
  const rope = Math.max(0.01, shape.rope ?? 0.03);
  const width = rope * Math.max(1, shape.turns ?? 4);
  const beamR = shape.beamR ?? aabb.max[1];
  const logR = shape.logR ?? beamR;
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < n; k++) {
    const x = shape[`x${k}`] ?? 0;
    // collar round the beam (beam runs along local x)
    const collar = new THREE.CylinderGeometry(beamR + rope * 0.6, beamR + rope * 0.6, width, 6, 1, true);
    collar.rotateZ(Math.PI / 2);
    collar.translate(x, 0, 0);
    parts.push(collar);
    if ((shape.ring ?? 1) <= 0) continue; // a wrap round one member only (the bipod crossing)
    // ring round the log under it (log runs along local z): a torus whose
    // axis is z, low-poly — the rope is 3 cm, nobody sees its section
    const ring = new THREE.TorusGeometry(logR + rope * 0.6, rope * 0.55, 3, 6);
    ring.translate(x, -(beamR + logR), 0);
    parts.push(ring);
  }
  if (parts.length === 0) return new THREE.BufferGeometry();
  return mergeNonIndexed(parts);
}

/** mats, thatch slabs, splashboards, guara planks: a box the size of the aabb */
export const buildRaftSlabGeometry = slab;
