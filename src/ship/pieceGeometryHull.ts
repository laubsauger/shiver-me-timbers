/**
 * Lofted hull geometry (T8 visual pass, §V22): pointed stem, rounded
 * transom, sheer curve rising fore+aft, tumblehome above the bilge.
 * Pure functions of the piece's serializable `shape` hints (§V18) — the
 * piece GRAPH is untouched, only the geometry inside pieces changed.
 * Ship-space loft, translated into piece-local at the end.
 */
import * as THREE from 'three';
import type { AABB } from './pieceTypes';
import {
  hullEnvelope,
  hullHalfWidthAt,
  hullTopY,
  sectionHalf,
  type HullShape,
} from './hullMath';
import { vjitter, vside } from './variation';
import {
  blocksOverlap,
  buildAperturePatch,
  seatAperture,
  type ApertureBlock,
  type ShellBreach,
  type ShellRim,
} from './hullAperture';

export type { ShellBreach, ShellRim } from './hullAperture';

export { asHullShape, hullEnvelope, hullHalfWidthAt, hullSheer, hullTopY } from './hullMath';
export type { HullShape } from './hullMath';

/**
 * SHARED SAMPLING — every surface that mates with the shell must land on the
 * SAME stations, or the seam opens. The transom used to sample its height in
 * 10 steps against the shell's 8 and the two polylines diverged by up to
 * 0.35 m: an open crack up both stern quarters that a silhouette-containment
 * check cannot see. Exported so pieceGeometryStern.ts cannot drift again.
 */
export const Z_SLICES = 12;
export const H_STEPS = 8;
/** half-width samples across the hull bottom (transom bottom row matches) */
export const U_HALF = 7;

/** half-width of the flat hull bottom at station z (the garboard line) */
export function hullBottomHalf(z: number, s: HullShape): number {
  return s.beamHalf * sectionHalf(hullEnvelope(z, s), 0, s);
}

/**
 * Bottom closure for ONE side, centreline → that side's garboard edge.
 * Without it the two side shells simply stop at the keel line, leaving a
 * 0.125 m slot per side running most of the hull — you could see straight
 * into the interior (the keel box is only 0.6 m wide and covers none of it
 * amidships). Each half-shell owns its own patch, so a blown-out hull
 * section takes its piece of the bottom with it (§V13/§V14).
 */
function bottomHalf(s: HullShape, side: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= Z_SLICES; i++) {
    const z = s.z0 + ((s.z1 - s.z0) * i) / Z_SLICES;
    const half = hullBottomHalf(z, s);
    for (let k = 0; k <= U_HALF; k++) {
      const t = k / U_HALF; // 0 = centreline, 1 = garboard seam w/ the side
      positions.push(side * half * t, -s.draft, z);
      uvs.push(i / Z_SLICES, t);
    }
  }
  const row = U_HALF + 1;
  for (let i = 0; i < Z_SLICES; i++) {
    for (let k = 0; k < U_HALF; k++) {
      const a = i * row + k;
      const b = (i + 1) * row + k;
      // wound so the face normal points DOWN (−y) on both sides
      if (side >= 0) indices.push(a, a + 1, b, b, a + 1, b + 1);
      else indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Extra rows carried ABOVE the sheer line when the topsides stand proud of
 * the deck: one at the foot of the rim's chamfer, one on the chamfered cap.
 * Two rather than one because a chamfer needs a facet, not a moved edge.
 */
const LIP_ROWS = 2;

/**
 * one side shell strip over [z0,z1] in SHIP space (indexed grid)
 *
 * THE PROUD RIM (§T.34, user: "we still see perfect 90 degree edges between
 * the deck and the sides ... everything is nailed to a millionth of an inch").
 * The strip used to stop dead on `hullTopY`, which amidships IS the deck
 * plane, so the planking and the deck met in a flush square corner — the
 * one join the follow camera looks at all day. It now carries `bulwarkLip`
 * higher, with the arris bevelled by `railChamfer`, and both of those wander
 * station to station off the shared `irregularity` dial (§V2 seeded, so the
 * same ship every run and on every client).
 *
 * TWO PROPERTIES THIS MUST NOT BREAK, both of them §B.13 scar tissue:
 *   • rows 0..H_STEPS are UNTOUCHED. They are the stations the transom cap
 *     and the bottom patch mate against, and a jittered shared station is
 *     exactly the "two polylines through one curve" crack §V37 is about.
 *     Only the rows above the sheer — which mate with nothing — move.
 *   • the jitter is keyed on SHIP-SPACE z, so the three hull sections per
 *     side and the bow piece all evaluate the same value at a shared station
 *     and the rim stays continuous across piece boundaries. Keying it on the
 *     station INDEX would put a step at every section join.
 * And `uv.y` stays (y + draft) / (hullTopY + draft) on every row including
 * the new ones, so the strake coordinate the wood material reads simply
 * continues up into the lip (uv.y > 1 there).
 */
function sideStrip(
  s: HullShape,
  side: number,
  breaches: readonly ShellBreach[] = [],
  collarDepth = 0,
  rimsOut?: ShellRim[],
): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const lip = Math.max(0, s.bulwarkLip ?? 0);
  const chamfer = Math.max(0, s.railChamfer ?? 0);
  const jitter = Math.max(0, s.irregularity ?? 0);
  const proud = lip > 1e-3;
  for (let i = 0; i <= Z_SLICES; i++) {
    const z = s.z0 + ((s.z1 - s.z0) * i) / Z_SLICES;
    const env = hullEnvelope(z, s);
    const topY = hullTopY(z, s);
    const span = topY + s.draft;
    for (let j = 0; j <= H_STEPS; j++) {
      const h = j / H_STEPS;
      positions.push(side * s.beamHalf * sectionHalf(env, h, s), -s.draft + span * h, z);
      uvs.push(i / Z_SLICES, h);
    }
    if (!proud) continue;
    // a sheer strake fitted by eye: height wanders along the ship, and the
    // two sides were planked by different hands (vside), so they differ
    const rise = lip * (1 + vjitter(0.16 * jitter, z, 3.17)) * vside(side, 0.05 * jitter, 9.7);
    const bevel = Math.min(
      Math.max(0, chamfer * (1 + vjitter(0.3 * jitter, z, 5.29))),
      rise * 0.5,
    );
    // the lip is a vertical continuation of the topside: sectionHalf clamps
    // its height fraction at 1, so the tumblehome stops leaning in here
    const half = s.beamHalf * sectionHalf(env, 1, s);
    for (const [y, inset] of [
      [topY + rise - bevel, 0],
      [topY + rise, bevel],
    ] as const) {
      positions.push(side * Math.max(0.05, half - inset), y, z);
      uvs.push(i / Z_SLICES, (y + s.draft) / span);
    }
  }
  const row = H_STEPS + 1 + (proud ? LIP_ROWS : 0);
  const hSteps = row - 1;
  // §T.63 — the cells a breach replaces. Seated FIRST so the quad loop below
  // can skip them; an aperture that cannot be seated (see `seatAperture`)
  // simply cuts nothing, which is visible rather than silent.
  const coarse = (i: number, j: number): readonly [number, number, number] => {
    const o = (i * row + j) * 3;
    return [positions[o], positions[o + 1], positions[o + 2]];
  };
  const blocks: ApertureBlock[] = [];
  const patches: { b: ShellBreach; block: ApertureBlock }[] = [];
  for (const b of breaches) {
    const block = seatAperture(b, s, Z_SLICES, H_STEPS);
    // two apertures sharing a cell would each weld to a perimeter the other
    // has already deleted; the later one is dropped (deterministic, §V.2)
    if (block === null || blocks.some((x) => blocksOverlap(x, block))) continue;
    blocks.push(block);
    patches.push({ b, block });
  }
  const cut = (i: number, j: number): boolean =>
    blocks.some((k) => i >= k.i0 && i < k.i1 && j >= k.j0 && j < k.j1);

  for (let i = 0; i < Z_SLICES; i++) {
    for (let j = 0; j < hSteps; j++) {
      if (cut(i, j)) continue;
      const a = i * row + j;
      const b = (i + 1) * row + j;
      // wind so the face normal points outboard (±x) for each side
      if (side >= 0) indices.push(a, a + 1, b, b, a + 1, b + 1);
      else indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  for (const { b, block } of patches) {
    const patch = buildAperturePatch(
      b, block, s, side, Z_SLICES, H_STEPS, collarDepth, coarse,
    );
    rimsOut?.push(patch.rim);
    const base = positions.length / 3;
    positions.push(...patch.positions);
    uvs.push(...patch.uvs);
    for (const idx of patch.indices) indices.push(base + idx);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** one hull half-shell (side planking + its half of the bottom), translated
 *  into piece-local (origin x=0, z=center).
 *
 *  `breaches` are SHIP-space (§T.63): each one removes a block of the shell
 *  grid and welds a torn annulus in its place. Empty = the intact hull, byte
 *  for byte — the intact path must not change when the damaged one gains a
 *  feature. */
export function buildLoftedHullSection(
  s: HullShape,
  breaches: readonly ShellBreach[] = [],
  collarDepth = 0,
  rimsOut?: ShellRim[],
): THREE.BufferGeometry {
  const geo = mergeStrips([
    sideStrip(s, s.side, breaches, collarDepth, rimsOut),
    bottomHalf(s, s.side),
  ]);
  geo.translate(0, 0, -(s.z0 + s.z1) / 2);
  // rims come out of the loft in SHIP space; hand them back in the SAME frame
  // the geometry is now in, so the fringe and the cavity cannot be built in a
  // different frame from the hole they belong to
  if (rimsOut !== undefined) {
    const dz = -(s.z0 + s.z1) / 2;
    for (const rim of rimsOut) {
      for (const pt of rim.points) pt.z += dz;
      rim.centre.z += dz;
    }
  }
  return geo;
}

/** beakhead deck plate: closes the bow triangle between the shell tops,
 *  following the plan envelope to the stem point under the bowsprit */
function bowDeckStrip(s: HullShape): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= Z_SLICES; i++) {
    const z = s.z0 + ((s.z1 - s.z0) * i) / Z_SLICES;
    const y = hullTopY(z, s) - 0.04;
    // width at the SHELL at deck height, not the plan envelope — the plan
    // ignores tumblehome and the plate then juts out past the planking
    const hw = hullHalfWidthAt(z, y, s) * 0.99;
    positions.push(-hw, y, z, hw, y, z);
    uvs.push(i / Z_SLICES, 0, i / Z_SLICES, 1);
  }
  for (let i = 0; i < Z_SLICES; i++) {
    const a = i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); // faces up (+y)
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** bow: both side strips continuing the loft to the stem point, plus the
 *  beakhead deck plate so there is no opening under the bowsprit (§V22) */
export function buildLoftedBow(s: HullShape): THREE.BufferGeometry {
  const starboard = sideStrip(s, 1);
  const port = sideStrip(s, -1);
  const deck = bowDeckStrip(s);
  // …and the forefoot underneath, or the hull is open along the stem too
  const merged = mergeStrips([
    starboard,
    port,
    bottomHalf(s, 1),
    bottomHalf(s, -1),
    deck,
  ]);
  merged.translate(0, 0, -s.z0); // bow piece origin sits at hull end
  return merged;
}

/** local index-preserving merge (both strips share attribute layout) */
function mergeStrips(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let offset = 0;
  for (const g of geos) {
    const pos = g.getAttribute('position');
    const uv = g.getAttribute('uv');
    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      uvs.push(uv.getX(i), uv.getY(i));
    }
    const idx = g.getIndex();
    if (idx) for (let i = 0; i < idx.count; i++) indices.push(idx.getX(i) + offset);
    offset += pos.count;
    g.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** deck outline following the hull envelope (plan view), piece-local */
export function buildEnvelopeDeck(aabb: AABB, s: HullShape): THREE.BufferGeometry {
  const thickness = aabb.max[1] - aabb.min[1];
  const shape = new THREE.Shape();
  const slices = 16;
  // deck edge follows the SHELL at deck height (§V22: a deck cut from the
  // plan envelope alone pokes through the tumblehome as a flat lip)
  const at = (i: number): [number, number] => {
    const z = s.z0 + ((s.z1 - s.z0) * i) / slices;
    return [hullHalfWidthAt(z, s.freeboard, s) * 0.99, z];
  };
  const [x0, z0] = at(0);
  shape.moveTo(-x0, z0);
  shape.lineTo(x0, z0);
  for (let i = 1; i <= slices; i++) {
    const [x, z] = at(i);
    shape.lineTo(x, z);
  }
  for (let i = slices; i >= 0; i--) {
    const [x, z] = at(i);
    shape.lineTo(-x, z);
  }
  const geo = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
  geo.rotateX(Math.PI / 2); // extrusion (+z) → downward: deck top at y=0
  return geo;
}
