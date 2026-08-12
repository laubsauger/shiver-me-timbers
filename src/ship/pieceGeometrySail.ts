/**
 * Sail geometry per §V13 trim state. Split out of pieceGeometryShapes.ts when
 * the furled shape grew real gathering (file cap, §C).
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
import { shipDetailParams } from '../params/ship';
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

/** robands: short tie loops lashing the cloth to its yard (y≈0) */
function sailTies(width: number, drop: number): THREE.BufferGeometry[] {
  const ties: THREE.BufferGeometry[] = [];
  const count = 7;
  for (let i = 0; i < count; i++) {
    const x = -width * 0.44 + (width * 0.88 * i) / (count - 1);
    const tie = new THREE.CylinderGeometry(0.035, 0.035, 0.36, 5);
    tie.translate(x, 0.08, 0);
    ties.push(withSailShape(tie, 0, width, drop));
  }
  return ties;
}

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
 * so the cloth shader moves it rigidly with the point of canvas it is sewn to
 * — a weight-1 part needs a valid uv or it would be displaced by whatever
 * happened to be in the attribute.
 */
function reefPoints(width: number, drop: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const count = 9;
  const jitter = Math.max(0, shipDetailParams.irregularity);
  for (const band of [0.34, 0.62]) {
    for (let i = 0; i < count; i++) {
      const u = (i + 0.5) / count;
      const x = (u - 0.5) * width * 0.92;
      const y = -drop * band;
      const len = 0.3 + vjitter(0.09 * jitter, i, band);
      const line = new THREE.PlaneGeometry(0.035, len);
      line.rotateZ(vjitter(0.25 * jitter, i, band, 2));
      line.translate(x, y - len / 2, 0.012);
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
    // flat panel; the material owns the shape. Segmented enough (16×12) that
    // the shader billow and the luff ripple read smooth.
    const geo = new THREE.PlaneGeometry(width, drop, 16, 12);
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
