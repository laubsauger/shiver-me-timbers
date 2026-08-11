/**
 * §T.34 hull-side detail geometry: gunports, chainplate channels with their
 * deadeyes and lanyards, and the decorative sheer moulding.
 *
 * Everything here has to sit ON the lofted shell, which is a doubly-curved
 * surface — so nothing is axis-aligned. `shellFrame` reads the same hullMath
 * envelope the shell strips are built from (§V37's rule: mating pieces share
 * their sampling), and every fitting is placed and rotated with it. A port
 * frame pasted on an axis-aligned plane would float off the planking toward
 * the ends of the ship, which is exactly the class of bug that produced the
 * "ugly panels" report.
 */
import * as THREE from 'three';
import { hullHalfWidthAt, hullSheer, hullTopY, type HullShape } from './hullMath';
import { barBetween, mergeNonIndexed } from './pieceGeometryShapes';
import { shipDetailParams } from '../params/ship';
import { vhash, vjitter } from './variation';

/** where a fitting sits on the shell, and how it must be turned to lie flat */
export interface ShellFrame {
  x: number;
  yaw: number; // about y — follows the plan curve
  pitch: number; // about z — follows tumblehome / bilge turn
}

/**
 * Position and orientation of the shell surface at station (z, y) on `side`.
 * The angles come from finite differences of the SAME half-width function the
 * shell is lofted from, so a fitting turned by them lies in the planking.
 */
export function shellFrame(z: number, y: number, s: HullShape, side: number): ShellFrame {
  const d = 0.35;
  const halfAt = (zz: number, yy: number): number => hullHalfWidthAt(zz, yy, s);
  const dz = (halfAt(z + d, y) - halfAt(z - d, y)) / (2 * d);
  const dy = (halfAt(z, y + d) - halfAt(z, y - d)) / (2 * d);
  // The shell is x = side·H(z, y), so its outward normal is (side, −H_y, −H_z).
  // A part built facing +x reaches it with rotateZ(pitch) then rotateY(yaw);
  // note the ±x flip for the port side falls out of yaw ≈ π, which is why
  // pitch carries no `side` factor.
  return {
    x: side * halfAt(z, y),
    yaw: Math.atan2(dz, side),
    pitch: -Math.atan(dy),
  };
}

/** place a part built facing +x at the origin onto the shell */
function onShell(
  geo: THREE.BufferGeometry,
  frame: ShellFrame,
  y: number,
  z: number,
): THREE.BufferGeometry {
  geo.rotateZ(frame.pitch);
  geo.rotateY(frame.yaw);
  geo.translate(frame.x, y, z);
  return geo;
}

/**
 * Gunport band for one hull section: framed ports with lids. The reference
 * galleon's topsides are broken up by these; ours were a blank run of
 * planking (§T.34 gap list).
 *
 * `shape` = the section's hull hints + { ports, portSize, portY, zc, side }.
 * `zc` is the section's own z origin, since the piece rides that section and
 * dies with it (§V13/§V14).
 */
export function buildGunportGeometry(shape: Record<string, number>): THREE.BufferGeometry {
  const s = shape as unknown as HullShape;
  const side = shape.side >= 0 ? 1 : -1;
  const ports = Math.max(0, Math.round(shape.ports ?? 2));
  const size = Math.max(0.15, shape.portSize ?? 0.78);
  const baseY = shape.portY ?? 1.5;
  const zc = shape.zc ?? 0;
  const jitter = Math.max(0, shipDetailParams.irregularity);
  if (ports === 0) return mergeNonIndexed([new THREE.BoxGeometry(1e-3, 1e-3, 1e-3)]);

  const parts: THREE.BufferGeometry[] = [];
  const span = shape.z1 - shape.z0;
  for (let i = 0; i < ports; i++) {
    const t = (i + 0.5) / ports + vjitter(0.06 * jitter, side, i, zc);
    const z = shape.z0 + span * Math.min(0.94, Math.max(0.06, t));
    // ports were cut to the deck inside, not to a spirit level outside: the
    // sill follows the sheer, and each one is a touch off its neighbours
    const y = baseY + hullSheer(z, s) * 0.55 + vjitter(0.05 * jitter, i, z);
    if (y + size > hullTopY(z, s) - 0.12) continue; // never breach the sheer
    const frame = shellFrame(z, y, s, side);
    const w = size * (1 + vjitter(0.05 * jitter, z, i, 2));
    const t2 = 0.085;

    // one port, assembled in a flat frame facing +x, then laid on the shell
    // ONCE — offsetting a part locally and again in the placement would
    // double-count and scatter the frame off its own opening
    const port: THREE.BufferGeometry[] = [];
    for (const [oy, oz, sy, sz] of [
      [-w / 2, 0, t2, w + t2 * 2],
      [w / 2, 0, t2, w + t2 * 2],
      [0, -w / 2, w, t2],
      [0, w / 2, w, t2],
    ] as const) {
      const bar = new THREE.BoxGeometry(0.12, sy, sz);
      bar.translate(0.03, oy, oz);
      port.push(bar);
    }
    // the opening itself, recessed so the port reads as a hole not a decal
    const recess = new THREE.BoxGeometry(0.1, w * 0.92, w * 0.92);
    recess.translate(-0.07, 0, 0);
    port.push(recess);

    // lid: mostly closed, but one port in four is triced up — a ship at sea
    // with every single lid dressed to the same angle is the CG tell
    const open = vhash(z, i, side) > 0.74 ? 0.9 + vhash(i, z) * 0.5 : 0;
    const lid = new THREE.BoxGeometry(0.07, w * 0.96, w * 0.96);
    lid.translate(0.1, -w * 0.48, 0); // origin onto the lid's own top edge…
    lid.rotateZ(open); // …so tricing up swings it outboard and up
    lid.translate(0, w * 0.48, 0); // hinge back onto the port's head
    port.push(lid);

    parts.push(onShell(mergeNonIndexed(port), frame, y, z - zc));
  }
  if (parts.length === 0) return mergeNonIndexed([new THREE.BoxGeometry(1e-3, 1e-3, 1e-3)]);
  return mergeNonIndexed(parts);
}

/**
 * Channel + deadeyes + lanyards at a chainplate fan. The sockets existed and
 * the shrouds landed on them, but there was no ironwork under them at all —
 * the lines simply stopped in mid-air against the planking (§T.34 gap list).
 *
 * `shape` = { plates, p{i}x/p{i}y/p{i}z in PIECE-local space, side, radius }
 * plus the section's hull hints, so the channel board lies on the shell.
 */
export function buildChannelGeometry(shape: Record<string, number>): THREE.BufferGeometry {
  const s = shape as unknown as HullShape;
  const side = shape.side >= 0 ? 1 : -1;
  const plates = Math.max(1, Math.round(shape.plates ?? 3));
  const r = Math.max(0.03, shape.radius ?? 0.15);
  const zc = shape.zc ?? 0;
  const jitter = Math.max(0, shipDetailParams.irregularity);
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < plates; i++) {
    pts.push(
      new THREE.Vector3(shape[`p${i}x`] ?? 0, shape[`p${i}y`] ?? 0, shape[`p${i}z`] ?? 0),
    );
  }
  const parts: THREE.BufferGeometry[] = [];

  // the channel: a stout board projecting outboard, spreading the shrouds
  // clear of the topsides. Spans the fan with a little to spare each end.
  const zMin = Math.min(...pts.map((p) => p.z));
  const zMax = Math.max(...pts.map((p) => p.z));
  const yBoard = pts[0].y;
  const frame = shellFrame(zMax + zc, yBoard, s, side);
  const board = new THREE.BoxGeometry(0.42, 0.11, zMax - zMin + 0.7);
  board.translate(0.16, 0, 0);
  parts.push(onShell(board, frame, yBoard, (zMin + zMax) / 2));

  for (let i = 0; i < plates; i++) {
    const p = pts[i];
    const outX = p.x + side * 0.2;
    // iron chainplate strap: from under the channel, down the topsides, and
    // it is riveted by hand so no two rake alike
    const strapTilt = vjitter(0.05 * jitter, i, p.z);
    parts.push(
      barBetween(
        new THREE.Vector3(outX, p.y - 0.02, p.z),
        new THREE.Vector3(p.x - side * 0.05, p.y - 0.85, p.z + strapTilt),
        0.035,
        4,
      ),
    );
    // deadeye pair, lower on the channel and upper turned into the shroud,
    // with the lanyard rove between them
    const lower = new THREE.Vector3(outX, p.y + 0.09 + r, p.z);
    const upper = new THREE.Vector3(outX, lower.y + r * 2.6 + 0.12, p.z);
    for (const c of [lower, upper]) {
      const eye = new THREE.CylinderGeometry(r, r, 0.075, 9);
      eye.rotateX(Math.PI / 2); // flat faces fore-and-aft, in the shroud plane
      eye.translate(c.x, c.y, c.z);
      parts.push(eye);
    }
    const laced = 3;
    for (let k = 0; k < laced; k++) {
      const off = (k / (laced - 1) - 0.5) * r * 1.2;
      parts.push(
        barBetween(
          new THREE.Vector3(lower.x + off, lower.y + r * 0.7, lower.z),
          new THREE.Vector3(upper.x - off, upper.y - r * 0.7, upper.z),
          0.018,
          4,
        ),
      );
    }
  }
  return mergeNonIndexed(parts);
}

/**
 * Decorative sheer moulding: the carved batten that runs the length of the
 * topsides just under the rail. It is what gives the reference hull its long
 * horizontal read; ours had only the shaded wale strakes in the material.
 *
 * `shape` = hull hints + { drop, section, side }.
 */
export function buildMouldingGeometry(shape: Record<string, number>): THREE.BufferGeometry {
  const s = shape as unknown as HullShape;
  const side = shape.side >= 0 ? 1 : -1;
  const drop = shape.drop ?? 0.55;
  const section = Math.max(0.02, shape.section ?? 0.14);
  const stations = 16;
  const parts: THREE.BufferGeometry[] = [];
  const prev = new THREE.Vector3();
  const cur = new THREE.Vector3();
  for (let i = 0; i <= stations; i++) {
    const z = s.z0 + ((s.z1 - s.z0) * i) / stations;
    const y = hullTopY(z, s) - drop;
    cur.set(side * (hullHalfWidthAt(z, y, s) + section * 0.35), y, z);
    if (i > 0) parts.push(barBetween(prev, cur, section * 0.5, 5));
    prev.copy(cur);
  }
  // carved stop-ends: the moulding terminates in a boss, it does not just
  // stop dead in the middle of a plank
  for (const z of [s.z0, s.z1]) {
    const y = hullTopY(z, s) - drop;
    const boss = new THREE.SphereGeometry(section * 0.72, 6, 5);
    boss.translate(side * (hullHalfWidthAt(z, y, s) + section * 0.35), y, z);
    parts.push(boss);
  }
  return mergeNonIndexed(parts);
}
