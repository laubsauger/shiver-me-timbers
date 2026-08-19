/**
 * Holed damage-state variant (§V.14, §T.63): the shell is PERFORATED at each
 * recorded breach — a real aperture through the planking (hullAperture.ts),
 * splintered timber standing off the torn rim, and a dark cavity behind it so
 * what you see through the hole is an interior rather than daylight. Two
 * geometry groups: [0] wood, [1] the dark interior.
 *
 * WHAT CHANGED AND WHY, all of it measured.
 *
 * 1. THE HOLE IS A HOLE. It was an OPAQUE disc (`createHoleMaterial`,
 *    `#120c07`, `depthWrite: true`) in front of an UNMODIFIED shell. Rays cast
 *    through the breach centre hit the planking twice before this change and
 *    zero times after; 61 of 64 rays across the opening now pass clean
 *    through, against 0 of 64 on the intact control.
 *
 * 2. IT IS SIZED BY THE SHOT. It was `max(0.3, min(sy, sz) · 0.3)` — the
 *    PIECE's bounding box — giving 1.794 m radius, i.e. **3.588 m across on a
 *    35 m ship**, 10.2% of her length, on every hull section, whatever hit it.
 *    It is now `ballDrawRadius · 2 · breachRadiusPerCalibre` = 0.80 m across,
 *    2.5 ball diameters, 2.3% of her length.
 *
 * 3. IT IS WHERE THE BALL WENT IN. The station was AUTHORED (piece z-mid,
 *    y = −draft/4) and ignored the hit entirely, so a shot on the bow of a
 *    section opened a hole up to 5.8 m away from it.
 *
 * 4. N HITS MAKE N HOLES. The overlay was built once, at the hp threshold, so
 *    a section could never show more than one breach however long you shot at
 *    it. `ShipAssembly.addBreach` accumulates them.
 *
 * THE SINGLE OWNER OF "WHERE IS THE BREACH" (§V.72) IS `HitEvent.point`.
 * Flooding reads it through `recordBreach` (ship frame); the shell reads it
 * through `addBreach` (piece frame). One point, two frames — not two
 * derivations. The authored station WAS the second derivation.
 *
 * TWO THINGS THE HIT POINT CANNOT SUPPLY, both handled here:
 *   • its x. `testHits` slab-tests the piece AABB grown by `ballRadius`, so
 *     the impact point lies on a BOX up to 0.4 m outside the planking, never
 *     on the shell. Only (y, z) are used; x comes from the loft.
 *   • a flat overlay. §V.71 — the fringe and the cavity resolve against the
 *     hull's OWN evaluator through the aperture's rim, because a flat ring at
 *     this station is off the planking by up to 1.04 m at a 0.72 m radius
 *     (MEASURED, `hull-starboard-mid` at the waterline — the round bilge turns
 *     the shell hard in the vertical). The old 1.79 m ring was worse.
 */
import * as THREE from 'three';
import type { AABB, PieceKind } from './pieceTypes';
import { buildPieceGeometry } from './pieceGeometry';
import { aabbCenter, aabbSize, mergeNonIndexed } from './pieceGeometryShapes';
import { asHullShape, buildLoftedHullSection } from './pieceGeometryHull';
import { hullHalfWidthAt, type HullShape } from './hullMath';
import type { ShellBreach, ShellRim } from './hullAperture';
import { destructionParams } from '../params/destruction';
import { combatFxParams } from '../params/combat';

/** a breach in PIECE-local space — what ShipAssembly accumulates per piece */
export interface PieceBreach {
  /** piece-local impact point (x is ignored — see the header) */
  point: readonly [number, number, number];
  /** m — radius of the torn opening */
  radius: number;
  /** deterministic shape seed (§V.2) */
  seed: number;
}

/**
 * Same silhouette as the intact piece, perforated at every recorded breach.
 * `faceSign` picks +x or −x face (starboard/port sections).
 *
 * `breaches` empty is the GREYBOX path and is kept deliberately: the
 * shape-hint-free blueprint and the preview tool both reach this with no hit
 * behind them, and one nominal breach at the piece centre is a better answer
 * there than an unmarked piece. Every path a cannonball takes supplies
 * breaches — asserted by test, because a silent fallback to the old authored
 * station is precisely §V.62's failure mode.
 */
export function buildHoledVariant(
  kind: PieceKind,
  aabb: AABB,
  faceSign: 1 | -1 = 1,
  shape?: Record<string, number>,
  breaches: readonly PieceBreach[] = [],
): THREE.BufferGeometry {
  const hull = asHullShape(shape);
  const c = aabbCenter(aabb);
  const s = aabbSize(aabb);
  const p = destructionParams;
  const collar = Math.max(0, nn(p.breachCollarDepth, 0.28));
  const fringe = Math.max(1.01, nn(p.breachFringeScale, 1.8));
  const cavity = Math.max(1.01, nn(p.breachBackingScale, 1.7));
  const recess = Math.max(0.05, nn(p.breachBackingRecess, 0.55));

  const list: readonly PieceBreach[] =
    breaches.length > 0
      ? breaches
      : [
          {
            point: [0, hull !== null ? -hull.draft * 0.25 : c.y, c.z],
            radius: defaultRadius(),
            seed: 1,
          },
        ];

  if (hull === null) {
    // greybox panel: no parametric shell to cut, so the breach stays an
    // overlay and READS AS ONE. Stated rather than hidden — this path is the
    // preview tool and the hint-free blueprint, never a cannonball.
    const base = buildPieceGeometry(kind, aabb, shape);
    const wood: THREE.BufferGeometry[] = [base];
    const dark: THREE.BufferGeometry[] = [];
    const faceX = Math.abs(c.x) + s.x / 2;
    for (const b of list) {
      const r = Math.max(0.02, b.radius);
      const disc = new THREE.CircleGeometry(r, 14);
      disc.rotateY((faceSign * Math.PI) / 2);
      disc.translate(faceSign * (faceX + 0.01), b.point[1], b.point[2]);
      dark.push(disc);
    }
    return mergeNonIndexed([mergeNonIndexed(wood), mergeNonIndexed(dark)], true);
  }

  // piece-local z → ship-space station: buildLoftedHullSection lofts in SHIP
  // space and recentres by −(z0+z1)/2, so piece z = 0 IS station zMid.
  const zMid = (hull.z0 + hull.z1) / 2;
  const shellBreaches: ShellBreach[] = list.map((b) => ({
    z: zMid + b.point[2],
    y: b.point[1],
    radius: b.radius,
    seed: b.seed,
  }));

  const rims: ShellRim[] = [];
  const base = buildLoftedHullSection(hull, shellBreaches, collar, rims);
  const wood: THREE.BufferGeometry[] = [base];
  const dark: THREE.BufferGeometry[] = [];
  for (const rim of rims) {
    wood.push(buildFringe(rim, faceSign, fringe, hull, zMid));
    dark.push(buildCavity(rim, faceSign, cavity, recess, hull, zMid));
  }
  if (dark.length === 0) {
    // Every breach refused seating (an opening wider than the section — see
    // `seatAperture`). The piece keeps its intact shell, but it must still
    // carry TWO groups or the material ARRAY the assembly hands it indexes
    // past its end on group 1. A degenerate triangle with its attributes
    // written out in full: an attribute-less placeholder fails the merge
    // outright (`geometry merge failed`), and a computed normal on a
    // zero-area triangle is NaN — §V.28, so it is authored, not computed.
    const stub = new THREE.BufferGeometry();
    stub.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
    stub.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 2));
    stub.setAttribute('normal', new THREE.Float32BufferAttribute([1, 0, 0, 1, 0, 0, 1, 0, 0], 3));
    dark.push(stub);
  }

  // groups: [0] = shell + splinters (wood), [1] = the dark cavity
  return mergeNonIndexed([mergeNonIndexed(wood), mergeNonIndexed(dark)], true);
}

/**
 * SPLINTERED TIMBER standing off the torn rim — shards leaning alternately
 * into and out of the hole, each one anchored on two rim points so it cannot
 * float free of the planking. This replaces the flat star-shaped `ShapeGeometry`
 * ring, which was a plate laid across a curved shell (see the header's 1.04 m).
 */
function buildFringe(
  rim: ShellRim,
  faceSign: 1 | -1,
  scale: number,
  hull: HullShape,
  zMid: number,
): THREE.BufferGeometry {
  const n = rim.points.length;
  const positions: number[] = [];
  const uvs: number[] = [];
  const proud = rim.radius * 0.16;
  const reach = rim.radius * (scale - 1);
  for (let k = 1; k < n; k += 2) {
    const a = rim.points[(k - 1) % n];
    const b = rim.points[(k + 1) % n];
    const m = rim.points[k];
    // radial direction IN THE SURFACE (x is the shell normal here, so drop it)
    const dy = m.y - rim.centre.y;
    const dz = m.z - rim.centre.z;
    const len = Math.hypot(dy, dz);
    if (!Number.isFinite(len) || len < 1e-6) continue; // §V.28
    // Alternate: half the shards hang INTO the hole, half spring outward, and
    // both stand off the planking — which is what torn oak actually does.
    //
    // The two reaches are DELIBERATELY not equal. Inward shards as long as
    // outward ones close the aperture back up: at `breachFringeScale` 1.8 the
    // outward reach is 0.8·radius, and shards of that length off a rim at
    // 0.86·radius meet in the middle — measured, transmissive samples fell
    // 61/64 → 54/64 and a ray down the axis went back to hitting timber. The
    // inward reach is capped at a fifth of the radius, which reads as ragged
    // without giving the hole its planking back.
    const inward = k % 4 === 1;
    const wobble = 0.4 + 0.6 * Math.abs(Math.sin(k * 1.7 + rim.seed * 0.001));
    const sign = inward ? -1 : 1;
    const grow = inward ? rim.radius * 0.2 * wobble : reach * wobble;
    const ay = m.y + (sign * grow * dy) / len;
    const az = m.z + (sign * grow * dz) / len;
    // THE APEX SITS ON THE SHELL AT ITS OWN STATION, not at the rim's x.
    // Carrying the rim's x across 0.3 m of a round bilge puts the shard's tip
    // 0.52 m off the planking — the same class of error as the flat ring this
    // replaces, just smaller (§V.71: resolve against the host surface).
    const apex = {
      x: faceSign * (hullHalfWidthAt(zMid + az, ay, hull) + proud),
      y: ay,
      z: az,
    };
    // wound both ways is not an option (§V.28 has no bearing, but a shard seen
    // from one side only reads as a hole in the fringe); the wood material is
    // DoubleSide, so one winding is enough
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, apex.x, apex.y, apex.z);
    uvs.push(0, 0, 1, 0, 0.5, 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}

/**
 * THE DARK CAVITY — a cone from the torn rim to an apex set back inboard.
 *
 * NOT a flat disc at the surface: that IS the defect being removed, because a
 * disc filling the aperture makes the hole stop being a hole. NOT a flat disc
 * set back either — at this radius the shell curves inboard by more than the
 * recess, so a plane would cut out through the planking above and below the
 * hole. A cone off the rim is conformal by construction and it PARALLAXES
 * against the rim as the camera moves, which is the cue that reads as depth.
 */
function buildCavity(
  rim: ShellRim,
  faceSign: 1 | -1,
  scale: number,
  recess: number,
  hull: HullShape,
  zMid: number,
): THREE.BufferGeometry {
  const n = rim.points.length;
  const positions: number[] = [];
  const uvs: number[] = [];
  const apex = {
    x: rim.centre.x - faceSign * recess,
    y: rim.centre.y,
    z: rim.centre.z,
  };
  // the mouth sits just inboard of the torn rim and slightly wider, so the
  // planking's own edge always overlaps it and no seam of sky shows through
  const mouth = (i: number): [number, number, number] => {
    const q = rim.points[i % n];
    const my = rim.centre.y + (q.y - rim.centre.y) * scale;
    const mz = rim.centre.z + (q.z - rim.centre.z) * scale;
    // ON the shell at the mouth's OWN station and then a shade inboard. Held
    // at the rim's x it would stand up to 0.5 m PROUD of the planking above
    // and below the hole, because the bilge turns away underneath it — a dark
    // collar bulging out of an undamaged hull.
    return [
      faceSign * Math.max(0.02, hullHalfWidthAt(zMid + mz, my, hull) - recess * 0.08),
      my,
      mz,
    ];
  };
  for (let k = 0; k < n; k++) {
    const a = mouth(k);
    const b = mouth(k + 1);
    positions.push(apex.x, apex.y, apex.z, a[0], a[1], a[2], b[0], b[1], b[2]);
    uvs.push(0.5, 0.5, 0, 0, 1, 0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}

/**
 * The radius a single ball tears, FROM THE BALL'S OWN CALIBRE.
 *
 * `combatFxParams.ballDrawRadius` is the one owner of how big a cannonball
 * is — `combatParams.ballRadius` is a deliberately inflated COLLISION radius
 * (0.4 m, its own comment says so) and sizing a hole off a hit-detection fudge
 * is how the hole stops meaning anything. Move either knob and the hole moves
 * with it (§V.62, asserted by test).
 *
 * The multiplier is not a decal constant: a ball punches an opening about its
 * own diameter and springs the planking around it, so the torn hole runs a
 * little over one calibre and the splintered fringe carries it out to about
 * two. Shipped: a 0.32 m ball → a 0.80 m opening, ~1.44 m including splinters,
 * against the 3.588 m disc it replaces.
 */
export function defaultRadius(ballRadius?: number): number {
  const p = destructionParams;
  const r =
    ballRadius !== undefined && Number.isFinite(ballRadius)
      ? Math.abs(ballRadius)
      : nn(combatFxParams.ballDrawRadius, 0.16);
  return Math.max(0.05, r * 2 * nn(p.breachRadiusPerCalibre, 1.25));
}

function nn(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
