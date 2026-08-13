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

/** tag a part with (clothWeight, width, drop) for the cloth shader */
export function withSailShape(
  geo: THREE.BufferGeometry,
  weight: number,
  width: number,
  drop: number,
): THREE.BufferGeometry {
  const count = geo.attributes.position.count;
  const data = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    data[i * 3] = weight;
    data[i * 3 + 1] = width;
    data[i * 3 + 2] = drop;
  }
  geo.setAttribute('sailShape', new THREE.BufferAttribute(data, 3));
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
function sailTies(width: number, drop: number): THREE.BufferGeometry[] {
  const ties: THREE.BufferGeometry[] = [];
  const count = Math.max(2, Math.round(shipMaterialParams.sailLacingPoints));
  for (let i = 0; i < count; i++) {
    // the ONE definition of these stations — the cloth's seams read the same
    // function, so a roband can never end up between two seams
    const x = (sailLaceStation(i, count) - 0.5) * width;
    const tie = new THREE.CylinderGeometry(0.035, 0.035, 0.36, 5);
    tie.translate(x, 0.08, 0);
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

const RING = 9; // cross-section segments round the bundle
const PER_BAY = 9; // stations along each gathering bay

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

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const columns: number[] = [];

  for (let bay = 0; bay < bays; bay++) {
    const x0 = gaskets[bay];
    const x1 = gaskets[bay + 1];
    // no two bays hold the same amount of canvas
    const bulk = 1 + vjitter(0.22 * jitter, seed, bay, 11);
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
        // the section is deeper than it is thick: the weight of the canvas
        // pulls the swag down into a hanging fold, it does not stay round
        const ry = r * (1 + 0.55 * gather);
        positions.push(x, -sag + Math.cos(a) * ry, Math.sin(a) * r);
        uvs.push((x / Math.max(0.01, width)) + 0.5, k / RING);
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
  return withSailShape(geo, 0, width, drop);
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
    out.push(withSailShape(band, 0, width, drop));
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

export function buildSailGeometry(state: SailStateId, aabb: AABB): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const width = s.x;
  const drop = -aabb.min[1];
  // per-sail seed from its own dimensions: the fore and main yards must not
  // gather into the same lumps (§V2 seeded, never Math.random)
  const seed = vhash(width * 100, drop * 100) * 1000;

  if (state === 'full') {
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
    return mergeNonIndexed([
      withSailShape(geo, 1, width, drop),
      ...reefPoints(width, drop),
      ...sailTies(width, drop),
    ]);
  }

  // furled: everything gathered to the yard. reefed: a smaller bundle, with
  // the working part of the sail still hanging below it.
  const baseRadius = Math.max(0.15, drop * 0.05) * (state === 'furled' ? 1.15 : 0.95);
  const parts = [
    gatheredBunt(width, drop, baseRadius, seed),
    ...gaskets(width, drop, baseRadius, seed),
    ...sailTies(width, drop),
  ];
  if (state === 'furled') return mergeNonIndexed(parts);

  // the skirt still draws, so it stays cloth (weight 1) and keeps flying; its
  // own drop keeps the shader's ripple in scale with how little is set
  const skirtDrop = drop * 0.22;
  const skirt = new THREE.PlaneGeometry(width * 0.9, skirtDrop, 8, 3);
  skirt.translate(0, -skirtDrop / 2 - baseRadius * 1.1, 0);
  parts.push(withSailShape(skirt, 1, width * 0.9, skirtDrop));
  return mergeNonIndexed(parts);
}
