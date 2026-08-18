/**
 * Deck fittings greybox (T8 visual pass): cannon barrel + carriage, and
 * rails as post-and-top-rail runs instead of solid planks. Sized from the
 * piece AABB like every other builder (§V18).
 */
import * as THREE from 'three';
import type { AABB } from './pieceTypes';
import { aabbCenter, aabbSize, mergeNonIndexed } from './pieceGeometryShapes';
import {
  buildRailRun,
  railProfile,
  railSeed,
  readRailGaps,
  type RailPoint,
} from './pieceGeometryRail';
import { COAMING_HEIGHT, COAMING_WIDTH, GRATING_HEIGHT } from './deckHeightfield';

/**
 * Cannon: tapered barrel along +z (outboard once the piece is rotated),
 * carriage box + two wheel discs. Piece-local origin at the deck mount.
 */
export function buildCannonGeometry(aabb: AABB): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const barrelLen = s.z * 0.82;
  const barrelR = s.x * 0.2;
  const barrel = new THREE.CylinderGeometry(barrelR * 0.7, barrelR, barrelLen, 10);
  barrel.rotateX(Math.PI / 2); // cylinder +y → +z, muzzle outboard
  barrel.translate(0, s.y * 0.55, aabb.min[2] + s.z * 0.18 + barrelLen / 2);

  const carriage = new THREE.BoxGeometry(s.x * 0.7, s.y * 0.45, s.z * 0.4);
  carriage.translate(0, s.y * 0.24, aabb.min[2] + s.z * 0.28);

  const wheels: THREE.BufferGeometry[] = [];
  for (const dz of [-0.12, 0.16]) {
    const wheel = new THREE.CylinderGeometry(s.y * 0.16, s.y * 0.16, s.x * 0.8, 8);
    wheel.rotateZ(Math.PI / 2); // axle across the carriage (x)
    wheel.translate(0, s.y * 0.14, aabb.min[2] + s.z * (0.28 + dz));
    wheels.push(wheel);
  }
  return mergeNonIndexed([barrel, carriage, ...wheels]);
}

/** ship's wheel: spoked rim on a pedestal, athwartships plane (faces ±z) */
/**
 * THE WHEEL IS TWO PIECES BECAUSE ONE OF THEM TURNS.
 *
 * User: "the steering wheel should rotate as we steer… to make the
 * first-person view a little bit more interesting."
 *
 * It used to be ONE merged mesh — pedestal, rim, spokes and hub — with its
 * origin on the deck at the pedestal's foot. Nothing could animate that: the
 * piece's own transform is the only handle, and turning it would have swung
 * the pedestal round with the rim, about a point 0.93 m below the axle. So the
 * turning half is split off as its own piece, parented to the pedestal at the
 * hub, exactly as a yard is parented to its mast — one piece, one moving part,
 * one transform (§V.13), and `ShipAssembly.setHelmAngle` drives it the way
 * `setRigTrim` drives the yards.
 *
 * `buildWheelGeometry` keeps the STANDING half: the pedestal alone.
 */
export function buildWheelGeometry(aabb: AABB): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const pedestal = new THREE.BoxGeometry(s.x * 0.22, s.y * 0.62, s.z * 0.5);
  pedestal.translate(0, aabb.min[1] + s.y * 0.31, 0);
  return mergeNonIndexed([pedestal]);
}

/** where the axle sits, in the WHEEL PIECE's own local frame */
export function wheelHubHeight(aabb: AABB): number {
  return aabb.min[1] + aabbSize(aabb).y * 0.62;
}

/**
 * The turning half: rim, spokes and hub, CENTRED ON THE ORIGIN and lying in
 * XY so the axle is local +z (the wheel faces fore-and-aft).
 *
 * CENTRED IS THE WHOLE REQUIREMENT. This spins through three and a half full
 * turns lock to lock, so any offset between the mesh's centre and the axis it
 * rotates about would not read as an offset — it would read as a WOBBLE, and a
 * wobbling wheel is a worse artifact than a static one. Everything below is
 * built at the origin and never translated.
 *
 * The spoke count is also load-bearing at multiple turns: 4 crossed spokes is
 * 8 handles at 45°, so the geometry maps onto itself every 45° of rotation and
 * there is no orientation at which the wheel reads as "wrong way up". That was
 * already true and is worth not breaking.
 */
export function buildWheelDiscGeometry(aabb: AABB): THREE.BufferGeometry {
  const rimR = aabbSize(aabb).x * 0.36;
  const parts: THREE.BufferGeometry[] = [];
  parts.push(new THREE.TorusGeometry(rimR, rimR * 0.12, 8, 20));
  for (let i = 0; i < 4; i++) {
    // 4 crossed spokes = 8 handles poking past the rim
    const spoke = new THREE.CylinderGeometry(rimR * 0.07, rimR * 0.07, rimR * 2.55, 6);
    spoke.rotateZ((i * Math.PI) / 4);
    parts.push(spoke);
  }
  parts.push(new THREE.SphereGeometry(rimR * 0.2, 8, 6));
  return mergeNonIndexed(parts);
}

/** capstan: tapered drum + head disc + crossed handspike bars */
export function buildCapstanGeometry(aabb: AABB): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const drumH = s.y * 0.75;
  const parts: THREE.BufferGeometry[] = [];
  const drum = new THREE.CylinderGeometry(s.x * 0.2, s.x * 0.27, drumH, 10);
  drum.translate(0, aabb.min[1] + drumH / 2, 0);
  parts.push(drum);
  const head = new THREE.CylinderGeometry(s.x * 0.3, s.x * 0.26, s.y * 0.16, 10);
  head.translate(0, aabb.min[1] + drumH + s.y * 0.08, 0);
  parts.push(head);
  for (const angle of [0, Math.PI / 2]) {
    const bar = new THREE.CylinderGeometry(0.035, 0.035, s.x * 0.95, 6);
    bar.rotateZ(Math.PI / 2);
    bar.rotateY(angle);
    bar.translate(0, aabb.min[1] + drumH + s.y * 0.1, 0);
    parts.push(bar);
  }
  return mergeNonIndexed(parts);
}

/**
 * Hatch grating with its COAMING — the raised curb round the opening. The
 * grating had no curb at all, so the deck-water sim would have poured straight
 * down the hatch and the eye had nothing telling it there was an opening
 * there. Curb height/width come from deckHeightfield.ts so the lip the water
 * banks against is the lip you can see (§T.34 / talk "Surface Water: Setup").
 */
export function buildGratingGeometry(aabb: AABB): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const c = aabbCenter(aabb);
  const parts: THREE.BufferGeometry[] = [];

  // coaming: four curb timbers standing proud of the deck round the opening
  for (const [sx, sz, wx, wz] of [
    [-1, 0, COAMING_WIDTH, s.z + COAMING_WIDTH * 2],
    [1, 0, COAMING_WIDTH, s.z + COAMING_WIDTH * 2],
    [0, -1, s.x, COAMING_WIDTH],
    [0, 1, s.x, COAMING_WIDTH],
  ] as const) {
    const curb = new THREE.BoxGeometry(wx, COAMING_HEIGHT, wz);
    curb.translate(
      c.x + (sx * (s.x + COAMING_WIDTH)) / 2,
      aabb.min[1] + COAMING_HEIGHT / 2,
      c.z + (sz * (s.z + COAMING_WIDTH)) / 2,
    );
    parts.push(curb);
  }

  const frame = new THREE.BoxGeometry(s.x, GRATING_HEIGHT * 0.5, s.z);
  frame.translate(c.x, aabb.min[1] + GRATING_HEIGHT * 0.25, c.z);
  parts.push(frame);
  const bars = 5;
  for (let i = 0; i < bars; i++) {
    const off = -0.4 + (0.8 * i) / (bars - 1);
    const alongZ = new THREE.BoxGeometry(s.x * 0.08, GRATING_HEIGHT * 0.6, s.z * 0.94);
    alongZ.translate(c.x + off * s.x, aabb.min[1] + GRATING_HEIGHT * 0.7, c.z);
    parts.push(alongZ);
    const alongX = new THREE.BoxGeometry(s.x * 0.94, GRATING_HEIGHT * 0.6, s.z * 0.08);
    alongX.translate(c.x, aabb.min[1] + GRATING_HEIGHT * 0.7, c.z + off * s.z);
    parts.push(alongX);
  }
  return mergeNonIndexed(parts);
}

/** companionway stairs: even steps climbing toward +z over the aabb */
export function buildStairsGeometry(aabb: AABB): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const steps = Math.max(3, Math.round(s.y / 0.4));
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < steps; i++) {
    const h = (s.y * (i + 1)) / steps;
    const step = new THREE.BoxGeometry(s.x, h, s.z / steps);
    step.translate(0, aabb.min[1] + h / 2, aabb.min[2] + (s.z * (i + 0.5)) / steps);
    parts.push(step);
  }
  return mergeNonIndexed(parts);
}

/**
 * STRAIGHT rail run — the athwartships ones: the break of each castle deck and
 * the stern balustrade. Same joinery as the curved side runs (turned balusters
 * at a fixed SPACING, two-board chamfered cap, sill, newels at every span end);
 * the only difference is that the path is two points instead of a sampled hull
 * curve, so it shares `buildRailRun` rather than reimplementing a rail.
 *
 * THIS IS THE RUN THE STAIRCASES CUT (§T.45). The user asked for railings "all
 * the way around except for 2 staircases left and right around the steering
 * wheel", and the quarterdeck break is where those companionways land — so
 * this builder is the one that has to be able to express a hole. It reads the
 * gaps off the piece's `shape`, in metres from the run's PORT end.
 */
export function buildRailGeometry(
  aabb: AABB,
  shape?: Record<string, number>,
): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const c = aabbCenter(aabb);
  const alongZ = s.z >= s.x;
  const runLength = alongZ ? s.z : s.x;
  const thickness = alongZ ? s.x : s.z;
  const half = runLength / 2;
  const path: RailPoint[] = alongZ
    ? [
        [c.x, aabb.min[1], c.z - half],
        [c.x, aabb.min[1], c.z + half],
      ]
    : [
        [c.x - half, aabb.min[1], c.z],
        [c.x + half, aabb.min[1], c.z],
      ];
  return buildRailRun(
    path,
    railProfile(s.y, thickness, {
      panelHeight: shape?.panelHeight ?? 0,
      seed: railSeed(c.x, c.z, runLength),
    }),
    readRailGaps(shape),
  );
}
