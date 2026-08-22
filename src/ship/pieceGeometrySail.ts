/**
 * Sail geometry per §V13 trim state. Split out of pieceGeometryShapes.ts when
 * the furled shape grew real gathering (file cap, §C).
 *
 * ANYTHING SEWN TO THIS SAIL MUST BE BUILT IN THE CLOTH'S OWN FRAME AT ITS
 * OWN (u, v) — position AND orientation. The cloth's shape is genuinely
 * wind-dependent now and keeps moving: a part that is merely translated to its
 * station keeps the flat panel's orientation and its corners come through the
 * canvas as soon as the sail carries any real camber. That is exactly how the
 * reef points broke when the belly went from 8% of chord to 14%. Author each
 * part as an offset from its station's FLAT position; sailClothNodes
 * re-expresses that offset in the surface's tangent/bitangent/normal basis.
 *
 * THE FULL SAIL IS FLAT ON PURPOSE. The belly, luff shake and gust ripple are
 * computed per frame in sailMaterial.ts from the live wind; a baked billow
 * cannot react to anything (§V22 "the sails appear too static"). Every part
 * carries `sailShape` = (clothWeight, width, drop): weight 1 is cloth the
 * shader may move, weight 0 is hardware — robands, gaskets, the furled bundle
 * — that must stay put.
 *
 * THE FURLED SAIL IS NOT A CYLINDER. User request, against a reference of a
 * galleon at anchor: "reefed sails should look like this here, kind of, where
 * they have some lines and that's part of the sail either in the centre or at
 * thirds, instead of just being like a completely straight line rolled up".
 * Real canvas is gathered to the yard with gaskets spaced along it, so it
 * bunches into SWAGS between them — a lumpy sausage with visible gathering
 * points, deepest in the middle of each bay. A smooth cylinder is the one
 * shape furled canvas never takes. This matters more than it sounds: the reef
 * states had never been rendered before this session, so the straight-rolled
 * look had never actually been seen.
 */
import * as THREE from 'three';
import type { AABB, SailStateId } from './pieceTypes';
import { aabbSize, mergeNonIndexed } from './pieceGeometryShapes';
import { shipDetailParams, shipMaterialParams } from '../params/ship';
import { sailClothSegments, sailLaceStation } from './sailShapeProfiles';
import { vhash, vjitter } from './variation';

/**
 * Tag a part with (clothWeight, width, drop) for the cloth shader, plus its
 * (buntWeight, occlusion) pair.
 *
 * THREE CLASSES OF VERTEX, and the two attributes name them together:
 *   cloth  (1, …) (0, 1)  — the shader may move it; rides the live surface
 *   hard   (0, …) (0, 1)  — robands, reef points' stations: stays put
 *   bunt   (0, …) (1, ao) — the gathered roll: stays off the cloth surface,
 *                           but its SECTION is scaled by the live trim
 *
 * `ao` is per-vertex on the bunt and 1 everywhere else — see {@link gatheredBunt}.
 */
export function withSailShape(
  geo: THREE.BufferGeometry,
  weight: number,
  width: number,
  drop: number,
  bunt = 0,
  ao?: number[],
): THREE.BufferGeometry {
  const count = geo.attributes.position.count;
  const data = new Float32Array(count * 3);
  const roll = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    data[i * 3] = weight;
    data[i * 3 + 1] = width;
    data[i * 3 + 2] = drop;
    roll[i * 2] = bunt;
    roll[i * 2 + 1] = ao === undefined ? 1 : (ao[i] ?? 1);
  }
  geo.setAttribute('sailShape', new THREE.BufferAttribute(data, 3));
  geo.setAttribute('sailBunt', new THREE.BufferAttribute(roll, 2));
  return geo;
}

/**
 * Robands: the short tie loops lashing the cloth to its yard (y≈0) — the
 * "lines on the beam" the sail's panel seams have to agree with.
 *
 * THE COUNT IS THE PANEL COUNT, from one owner (§V33/§V51). It used to be a
 * hard 7 sitting beside a panel grid derived from the bolt width, which is two
 * independent literals describing one physical thing and free to drift apart —
 * the same shape as the lantern socket and the lantern post, where the lamp
 * ended up hanging beside a post that reached nowhere near it. A roband is
 * passed through the head at each seam because the seam is the doubled, strong
 * part of the cloth, so on real canvas they genuinely are the same stations.
 */
/**
 * A roband's size, from the spar it is seized round (§B83, §V66). Without a
 * yard radius this is the galleon's authored tie (0.36 m tall, seen against a
 * 0.2–0.3 m yard); given one, the loop is 1.4 radii tall and sits on the
 * spar's axis — on the raft's 6 cm bamboo yard the galleon tie stood 0.26 m
 * proud, "a row of uniform wooden pegs".
 */
export function sailTieSpec(yardRadius?: number): { height: number; radius: number; centreY: number } {
  if (yardRadius === undefined || !Number.isFinite(yardRadius) || yardRadius <= 0) {
    return { height: 0.36, radius: 0.035, centreY: 0.08 };
  }
  return { height: Math.min(0.36, yardRadius * 1.4), radius: Math.min(0.035, yardRadius * 0.5), centreY: yardRadius * 0.5 };
}

function sailTies(width: number, drop: number, yardRadius?: number): THREE.BufferGeometry[] {
  const ties: THREE.BufferGeometry[] = [];
  const count = Math.max(2, Math.round(shipMaterialParams.sailLacingPoints));
  const spec = sailTieSpec(yardRadius);
  for (let i = 0; i < count; i++) {
    // the ONE definition of these stations — the cloth's seams read the same
    // function, so a roband can never end up between two seams
    const x = (sailLaceStation(i, count) - 0.5) * width;
    const tie = new THREE.CylinderGeometry(spec.radius, spec.radius, spec.height, 5);
    tie.translate(x, spec.centreY, 0);
    // WEIGHT 0, and that is correct rather than an oversight: a roband is
    // seized to the YARD, which does not deform, and the head of the cloth is
    // laced to that same spar. Every term of the shape carries a (1 − v) or a
    // `down(v)` that is zero at v = 1, so the canvas does not move here for the
    // shader to follow — checked, not assumed (tests/ship.test.ts).
    ties.push(withSailShape(tie, 0, width, drop));
  }
  return ties;
}

/** reef points are inset this far from each leech, in u */
const REEF_INSET = 0.04;
/** how far a sewn-on part stands off the cloth (m), along the surface normal */
const REEF_STANDOFF = 0.02;

/**
 * Cross-section segments round the bundle. 9 → 12 to carry the CREASES below:
 * the sharpest of them is the 3rd harmonic of the section angle, so 12 samples
 * is 4 per crease — the same "four samples per feature" bound
 * SAIL_SAMPLES_PER_PANEL sets for the quilting, and for the same reason (this
 * is baked geometry, so the mesh IS the band limit).
 */
const RING = 12;
const PER_BAY = 9; // stations along each gathering bay

/**
 * THE BUNDLE IS NOT A SMOOTH TUBE, and that is a SHADING fix as much as a
 * shape one (user: "the texture of it changes dramatically when it's packed
 * up, to a much brighter white").
 *
 * MEASURED, headless, through three's lambert + hemisphere + this project's
 * ACES/exposure: the furled bundle sits at p90 luminance 0.50-0.53 and max
 * 0.57-0.60 AT EVERY HEADING AND EVERY TIME OF DAY, while the flying canvas
 * beside it swings 0.11 → 0.58 with heading and sits at 0.087-0.27 at the
 * shipped default. A plane has ONE normal, so a square sail's N·L is a single
 * number over the whole surface and it is usually small (square sails face
 * fore-and-aft; the sun is up). A tube has ALL of them, so a smooth roll
 * ALWAYS contains a band at N·L ≈ 1 and never responds to anything. A thing
 * that never changes, beside a thing that changes constantly, reads as wrong
 * whatever colour it is — which is why "make it darker" was the wrong fix.
 *
 * Two terms answer it, both here rather than in the material, because the
 * material was doing the right thing to the wrong shape:
 *   · CREASES — harmonics of the section angle, so real folds run the length
 *     of each bay. They break that one continuous highlight into facets that
 *     turn over as the ship moves, which is what canvas does and a cylinder
 *     cannot.
 *   · OCCLUSION — baked per vertex. §B.48 recorded that there is NO ao
 *     anywhere on this ship and no environment map, so a crevice between two
 *     swags currently receives the FULL hemisphere. Gathered canvas is mostly
 *     crevice.
 */
const CREASE_LOBE = 0.62; // split between the 2nd and 3rd section harmonics
/** occlusion at the bottom of the roll, where it faces its own shadow */
const AO_UNDERSIDE = 0.34;
/** occlusion in the nipped waist at a gasket, closed in by both neighbours */
const AO_WAIST = 0.55;
/** extra occlusion in a crease valley against its ridge */
const AO_CREASE = 0.3;
/** the gaskets themselves sit IN the cinch they close */
const AO_GASKET = 0.5;

/**
 * Gasket stations along the yard, in local x. `bays` bays means bays+1
 * gaskets, jittered so the two sides of a ship are not mirror-identical and
 * the bays are not identical to each other.
 */
function gasketStations(width: number, bays: number, seed: number): number[] {
  const jitter = Math.max(0, shipDetailParams.irregularity);
  const half = width * 0.48;
  const stations: number[] = [];
  for (let k = 0; k <= bays; k++) {
    const even = -half + (half * 2 * k) / bays;
    // the end gaskets are fixed at the yardarms; the inner ones drift
    const drift = k === 0 || k === bays ? 0 : vjitter(width * 0.045 * jitter, seed, k);
    stations.push(even + drift);
  }
  return stations;
}

/**
 * Radius of the furled bundle at full furl — THE ONE OWNER (§V33), ∝ the
 * canvas it packs: cloth area ÷ the yard it is gathered along, i.e. the
 * drop, × a packed-cloth factor. §B75: this used to floor at 0.15 m, a
 * galleon-scaled constant that made a 1.4 m topsail's roll as fat as a
 * 3 m topgallant's — "a much larger sail than we unpack" (§V66). Only a
 * degeneracy guard remains; the galleon's bundles above 2.6 m drop are
 * unchanged to the millimetre.
 */
export const FURL_PACK = 0.0575;

export function furlBundleRadius(width: number, drop: number, yardLength?: number, pack = FURL_PACK): number {
  const w = Math.max(1e-3, Number.isFinite(width) ? width : 1e-3);
  const area = w * Math.max(0, Number.isFinite(drop) ? drop : 0);
  // §B86-3: the cloth is gathered along the YARD, which is longer than the
  // sail is wide, and how TIGHTLY it packs is a property of the cloth — heavy
  // flax on a galleon's course, light cotton on the raft's bamboo yard, whose
  // roll in the moored replica frame is about a hand thick. Both default to
  // what they were, so the galleon's bundles are unchanged to the millimetre.
  const along = yardLength !== undefined && Number.isFinite(yardLength) && yardLength > 1e-3 ? yardLength : w;
  const k = Number.isFinite(pack) && pack > 0 ? pack : FURL_PACK;
  // §T.140/§V66 — the floor is a DEGENERACY GUARD, not a size. At 0.02 m it
  // was a metre constant standing in front of the law, and the raft's 3.0 ×
  // 0.6 m topsail (§T.140 cut it to fit between the bipod crossing and a
  // standing lookout's eye) landed under it: 0.0153 m of roll reported as
  // 0.02, which is the "fixed floor makes a small sail's bundle read as a big
  // sail's" defect this function was written to remove. 5 mm is small enough
  // that only a sail with no area can reach it, and every existing bundle on
  // every class is orders above it.
  return Math.max(0.005, (area / along) * k);
}

/**
 * The gathered bundle: a tube along the yard whose section swells at the
 * middle of each bay and nips in at each gasket, and whose centre
 * sags as it swells. That combination — fat AND low between the gaskets — is
 * what makes the bottom edge read as a row of shallow curved swags rather
 * than as a straight line.
 */
function gatheredBunt(
  width: number,
  drop: number,
  baseRadius: number,
  seed: number,
): THREE.BufferGeometry {
  const d = shipDetailParams;
  const bays = Math.max(1, Math.round(d.sailBuntBays));
  const gaskets = gasketStations(width, bays, seed);
  const swell = Math.max(1, d.sailBuntSwell);
  const sagMax = Math.max(0, d.sailBuntSag) * baseRadius;
  const jitter = Math.max(0, shipDetailParams.irregularity);

  const crease = Math.max(0, shipDetailParams.sailBuntCrease);

  const positions: number[] = [];
  const uvs: number[] = [];
  const ao: number[] = [];
  const indices: number[] = [];
  const columns: number[] = [];

  for (let bay = 0; bay < bays; bay++) {
    const x0 = gaskets[bay];
    const x1 = gaskets[bay + 1];
    // no two bays hold the same amount of canvas
    const bulk = 1 + vjitter(0.22 * jitter, seed, bay, 11);
    // …and no two bays fold the same way: the creases are phased per bay, so
    // the folds break at each gasket the way real canvas does when it is
    // cinched, instead of running the whole yard as one corrugation
    const ph2 = vjitter(Math.PI, seed, bay, 23);
    const ph3 = vjitter(Math.PI, seed, bay, 29);
    const first = bay === 0 ? 0 : 1; // share the gasket column between bays
    for (let i = first; i <= PER_BAY; i++) {
      const t = i / PER_BAY;
      const x = x0 + (x1 - x0) * t;
      // fat-topped, not a pure sine: gathered cloth is bunched over most of
      // the bay and only nips in right at the gasket
      const s = Math.sin(Math.PI * t);
      const gather = Math.pow(s, 0.62);
      // the waist NEVER pinches to nothing: a gasket cinches the canvas, it
      // does not cut it, and a fully pinched waist reads as separate footballs
      // threaded on the yard rather than as one gathered bundle
      const r = baseRadius * (0.62 + (swell - 0.62) * gather * bulk);
      const sag = sagMax * Math.pow(gather, 1.25) * bulk;
      columns.push(positions.length / 3);
      for (let k = 0; k <= RING; k++) {
        const a = (k / RING) * Math.PI * 2;
        // LONGITUDINAL FOLDS. Integer harmonics of the section angle, so the
        // ring closes on itself exactly at k = 0 = RING (a fractional harmonic
        // leaves a seam down the bundle) and each lobe runs the LENGTH of the
        // bay rather than rippling along it — a fold in gathered canvas is a
        // line down the roll, not a lump on it.
        const fold =
          Math.sin(2 * a + ph2) * CREASE_LOBE + Math.sin(3 * a + ph3) * (1 - CREASE_LOBE);
        const swellK = 1 + crease * fold;
        // the section is deeper than it is thick: the weight of the canvas
        // pulls the swag down into a hanging fold, it does not stay round
        const ry = r * (1 + 0.55 * gather) * swellK;
        positions.push(x, -sag + Math.cos(a) * ry, Math.sin(a) * r * swellK);
        uvs.push((x / Math.max(0.01, width)) + 0.5, k / RING);
        // BAKED OCCLUSION (see the header block on CREASE_LOBE). Three
        // independent closings, multiplied because they occlude independently:
        // the underside of the roll faces its own shadow, the waist at a
        // gasket is closed in by the two swags either side of it, and a crease
        // valley is closed in by its own two ridges.
        const up = 0.5 + 0.5 * Math.cos(a);
        const aoAngle = AO_UNDERSIDE + (1 - AO_UNDERSIDE) * Math.pow(up, 0.8);
        const aoWaist = AO_WAIST + (1 - AO_WAIST) * gather;
        const aoFold = 1 - AO_CREASE * 0.5 * (1 - fold);
        ao.push(Math.min(1, Math.max(0, aoAngle * aoWaist * aoFold)));
      }
    }
  }
  for (let c = 0; c < columns.length - 1; c++) {
    for (let k = 0; k < RING; k++) {
      const a = columns[c] + k;
      const b = columns[c + 1] + k;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return withSailShape(geo, 0, width, drop, 1, ao);
}

/** the gaskets themselves: rope bands cinching the bundle at each station */
function gaskets(width: number, drop: number, baseRadius: number, seed: number): THREE.BufferGeometry[] {
  const bays = Math.max(1, Math.round(shipDetailParams.sailBuntBays));
  const jitter = Math.max(0, shipDetailParams.irregularity);
  const out: THREE.BufferGeometry[] = [];
  for (const x of gasketStations(width, bays, seed)) {
    // sized to sit OUTSIDE the waist it cinches, or the band is buried in
    // the cloth and the gathering point is invisible
    const r = baseRadius * 0.66;
    const band = new THREE.TorusGeometry(r, Math.max(0.02, r * 0.22), 4, 9);
    band.rotateY(Math.PI / 2); // ring lies across the yard
    band.rotateX(vjitter(0.12 * jitter, seed, x)); // hand-passed, never square
    band.translate(x, 0, 0);
    // BUNT-CLASS, so a gasket shrinks with the roll it cinches — a band left
    // at full size round a collapsing bundle is a hoop standing in mid-air.
    out.push(withSailShape(band, 0, width, drop, 1, new Array(band.attributes.position.count).fill(AO_GASKET)));
  }
  return out;
}

/**
 * Reef points: the short lines sewn in a band across the sail, used to tie a
 * reef down. Each is a small quad carrying ONE (u, v) for all four vertices,
 * so the cloth shader moves it as a RIGID piece rather than shearing it with
 * the local curvature — a weight-1 part needs a valid uv or it would be
 * displaced by whatever happened to be in the attribute.
 *
 * Its vertices are authored as an offset from their OWN station's flat
 * position, because sailClothNodes re-expresses that offset in the surface's
 * tangent basis (see the header). Two things follow, and both were wrong here:
 * the station's x must be exactly `(u − 0.5)·width` for the uv it carries —
 * the old `·0.92` made the authored point disagree with its own uv by up to
 * 8% of the width, which the shader then read as a real offset and sheared the
 * quad outward toward the leeches — and the standoff must be big enough to
 * clear the cloth rather than lie in it.
 */
function reefPoints(width: number, drop: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const count = 9;
  const jitter = Math.max(0, shipDetailParams.irregularity);
  for (const band of [0.34, 0.62]) {
    for (let i = 0; i < count; i++) {
      // inset from the leeches through u itself, so the station and its uv
      // describe the same point of canvas
      const u = REEF_INSET + (1 - 2 * REEF_INSET) * ((i + 0.5) / count);
      const x = (u - 0.5) * width;
      const y = -drop * band;
      const len = 0.3 + vjitter(0.09 * jitter, i, band);
      const line = new THREE.PlaneGeometry(0.035, len);
      line.rotateZ(vjitter(0.25 * jitter, i, band, 2));
      // proud of the cloth along its own normal — coplanar z-fights
      line.translate(x, y - len / 2, REEF_STANDOFF);
      // one uv for the whole quad: it rides the cloth at exactly this point
      const uvAttr = line.getAttribute('uv');
      for (let k = 0; k < uvAttr.count; k++) uvAttr.setXY(k, u, 1 - band);
      out.push(withSailShape(line, 1, width, drop));
    }
  }
  return out;
}

/**
 * ONE MESH FOR EVERY TRIM — there is no geometry swap left anywhere on the
 * sail, and `state` no longer selects a shape.
 *
 * WHY, and it is the doctrine `sailGeometryState` already stated turned on
 * itself. That function's own comment said "an intermediate mesh swap is a
 * jump wherever you put it", and then put one at the bottom of the travel. It
 * still jumped, because `trimDropMin` could only null ONE quantity — where the
 * foot of the canvas is — and the foot was not what popped. Measured across
 * the nine sails at the swap, with that constant at its own optimum:
 *   · the TOP jumped UP by 0.04-0.09 of the sail's drop (+0.61 m on the main
 *     course) — the bundle stands proud of the yard, the collapsed panel does
 *     not;
 *   · the THICKNESS jumped by 0.15-0.26 of the drop — 0.56 m → 1.70 m on the
 *     main course at working camber, a factor of THREE in one frame;
 *   · the foot's own scallop disagreed by 0.09 of the drop AT THE BUNTLINE
 *     STATIONS while matching mid-bay, which is the one point the fit measured;
 *   · and all of it landed inside the bottom 2% of the trim travel.
 * That is the user's "super abrupt transition… it goes to fully packed up".
 *
 * So the bundle is built into the SAME mesh as the canvas and its SECTION is
 * scaled by the live trim in the vertex stage (`furlBundleScale`, one owner in
 * sailShape.ts): a line tucked along the head at full sail, its full authored
 * size when she is in. The canvas shortens on the same ramp it always did, so
 * the two exchange continuously — cloth leaves the hanging part and arrives in
 * the roll, which is what furling IS.
 *
 * `state` is kept because `ShipAssembly.setSailState` types on it and the §V13
 * label still has three values for the HUD and the haul audio. It does not
 * change the mesh: a statically furled ship is `setSailDropScale(id, 0)`.
 */
export function buildSailGeometry(state: SailStateId, aabb: AABB, shape?: Record<string, number>): THREE.BufferGeometry {
  void state;
  const s = aabbSize(aabb);
  const width = s.x;
  const drop = -aabb.min[1];
  // per-sail seed from its own dimensions: the fore and main yards must not
  // gather into the same lumps (§V2 seeded, never Math.random)
  const seed = vhash(width * 100, drop * 100) * 1000;

  /**
   * Flat panel; the material owns the shape.
   *
   * THE SEGMENT COUNT IS DERIVED, NOT CHOSEN. The cloth's quilting is a
   * periodic term evaluated in the VERTEX stage, so its band limit is this
   * mesh — `fwidth` cannot reach it, because no fragment is involved. At the
   * old fixed 16 segments the shipped 9 panels would get 1.8 samples each,
   * far under Nyquist, and the quilting would alias into a corrugation
   * nobody authored. Deriving it from the same `sailPanelsFor` the panels
   * come from means the geometry can never silently fall behind the shape it
   * has to carry (§V33/§V51 single owner).
   */
  const segsU = sailClothSegments(shipMaterialParams.sailLacingPoints);
  const geo = new THREE.PlaneGeometry(width, drop, segsU, 16);
  geo.translate(0, -drop / 2, 0);
  // the bundle is authored at the size it reaches when she is fully in; the
  // shader scales its section down from there, about the head line
  const baseRadius = furlBundleRadius(width, drop, shape?.yardLength, shape?.furlPack);
  return mergeNonIndexed([
    withSailShape(geo, 1, width, drop),
    ...reefPoints(width, drop),
    ...sailTies(width, drop, shape?.yardR),
    gatheredBunt(width, drop, baseRadius, seed),
    ...gaskets(width, drop, baseRadius, seed),
  ]);
}
