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
import { vjitter, vrange } from './variation';

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
  const bottom = -(top * 0.4 + rise * (n - 1));
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
 * One slope of the thatch. `shape.eaveSign` says which way local +x runs down
 * the slope (the two slabs are mirrored about the ridge, so it is +1 to
 * starboard and −1 to port); the aabb gives the slope length (x), the roof
 * thickness (y) and the ridge length (z).
 */
export function buildThatchRoofGeometry(aabb: AABB, shape: Record<string, number> = {}): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const sign = (shape.eaveSign ?? 1) < 0 ? -1 : 1;
  const half = s.x / 2;
  const zHalf = s.z / 2;
  const courses = thatchCourses(s.x, aabb.max[1], shape);
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
      parts.push(boxBetween(x0, x1, c.bottom, c.top, -zHalf, zHalf));
      continue;
    }
    // THE EAVE COURSE IS RAGGED: broken into butts of different lengths, so
    // the roof ends in a torn fringe and not a ruled line [§3 Roof]
    const butts = thatchEaveButts(s.x, shape);
    const ragged = Math.max(0, shape.eaveRagged ?? 0.05);
    for (let j = 0; j < butts.length; j++) {
      const zA = -zHalf + (s.z * j) / butts.length;
      const zB = -zHalf + (s.z * (j + 1)) / butts.length;
      const bx = at(butts[j]);
      parts.push(boxBetween(Math.min(x0, bx), Math.max(x0, bx), c.bottom, c.top,
        zA + ragged * 0.1, zB - ragged * 0.1));
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
 * §B87 — THE RADIO. A jury-rigged shortwave built round a salvaged car-radio
 * face: case, face plate, tuning dial with a needle, signal meter with a
 * needle, speaker grille, one LED, a hand crank on the side and the aerial
 * lead-out. The piece's +z is the FACE; the material (raftMaterials
 * createRadioMaterial) reads local z to tell the pale plate from the dark
 * furniture standing proud of it, so the depth bands below are a contract with
 * it: plate/dial/meter faces below 0.42·d, needles/knob/LED above.
 *
 * This is the game's main interface (T103 drives the dial), so the dial and
 * the meter are modelled at a size that reads from a crouched player's eye,
 * not at a size that is cheap.
 */
export function buildRadioGeometry(aabb: AABB, shape: Record<string, number> = {}): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const c = aabbCenter(aabb);
  const w = s.x;
  const h = s.y;
  const d = s.z;
  const dialR = Math.max(0.02, shape.dial ?? w * 0.32) / 2;
  const meterW = Math.max(0.02, shape.meterWidth ?? w * 0.28);
  const meterH = Math.max(0.02, shape.meterHeight ?? h * 0.27);
  const crank = Math.max(0.03, shape.crank ?? 0.12);
  const dialAngle = shape.dialAngle ?? -0.6;
  const meterAngle = shape.meterAngle ?? 0.35;
  const parts: THREE.BufferGeometry[] = [];
  const zPlate = d * 0.2; // back of the face plate
  const zFace = d * 0.38; // plate surface — the pale field
  const zGlass = d * 0.42; // dial disc / meter glass, still pale
  const zProud = d * 0.5; // needles, knob, LED — dark

  // case + face plate
  parts.push(boxBetween(-w / 2, w / 2, -h / 2, h / 2, -d / 2, zPlate));
  parts.push(boxBetween(-w * 0.47, w * 0.47, -h * 0.42, h * 0.42, zPlate, zFace));

  // TUNING DIAL, port half of the face: a pale disc with a dark centre knob
  // and a dark needle — the one control a player must find at a glance
  const dialX = -w * 0.28;
  const dialY = -h * 0.06;
  const disc = new THREE.CylinderGeometry(dialR, dialR, zGlass - zFace, 14);
  disc.rotateX(Math.PI / 2);
  parts.push(disc.translate(dialX, dialY, (zFace + zGlass) / 2));
  const needle = boxBetween(-0.006, 0.006, -dialR * 0.1, dialR * 0.86, zGlass, zProud * 0.94);
  needle.rotateZ(dialAngle);
  parts.push(needle.translate(dialX, dialY, 0));
  const knob = new THREE.CylinderGeometry(dialR * 0.26, dialR * 0.3, zProud - zGlass, 8);
  knob.rotateX(Math.PI / 2);
  parts.push(knob.translate(dialX, dialY, (zGlass + zProud) / 2));

  // SIGNAL METER, starboard of the grille, and its needle
  const meterX = w * 0.24;
  const meterY = h * 0.21;
  parts.push(boxBetween(meterX - meterW / 2, meterX + meterW / 2,
    meterY - meterH / 2, meterY + meterH / 2, zFace, zGlass));
  const mNeedle = boxBetween(-0.005, 0.005, -meterH * 0.05, meterH * 0.8, zGlass, zProud * 0.94);
  mNeedle.rotateZ(meterAngle);
  parts.push(mNeedle.translate(meterX, meterY - meterH * 0.34, 0));

  // speaker grille (a recessed panel) and the one LED, top starboard corner
  parts.push(boxBetween(w * 0.06, w * 0.36, -h * 0.34, h * 0.02, zPlate, zFace * 0.96));
  const ledR = Math.max(0.008, w * 0.035);
  const led = new THREE.CylinderGeometry(ledR, ledR, zProud - zFace, 6);
  led.rotateX(Math.PI / 2);
  parts.push(led.translate(w * 0.44, h * 0.35, (zFace + zProud) / 2));

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
