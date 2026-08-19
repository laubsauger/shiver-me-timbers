/**
 * SHELL APERTURE — a cannonball hole that is a HOLE (§T.63, §V.14).
 *
 * WHAT THIS REPLACES. The breach used to be an OPAQUE DISC laid on an
 * UNMODIFIED shell: `createHoleMaterial` is `#120c07`, `depthWrite: true`,
 * `transparent: false`, so the "hole" wrote depth and occluded exactly like
 * planking. MEASURED on the shipped galleon before this file existed: outer
 * radius `max(0.3, min(sy, sz) · 0.3)` = 1.794 m ⟹ **3.588 m across, on a
 * 35 m hull** — 10.2% of her length, 60% of the hull section's own height,
 * and 11.2× the drawn ball's 0.32 m diameter. It was sized off the PIECE's
 * bounding box, so it could only ever be one size, and one per section.
 *
 * WHY GEOMETRY REMOVAL AND NOT AN ALPHA CUT. The brief allowed either. An
 * alpha cut needs `alphaTest` on the SHELL material (cutting the disc cuts
 * nothing — the planking behind it is what is opaque), which costs early-Z on
 * every hull fragment plus the same work again in the shadow pass, and that
 * cost is only measurable with a GPU timer in a browser — which this session
 * cannot open. Removing triangles at damage time has a cost that IS
 * measurable headlessly (vertex count, build time, draw calls) and is paid
 * ONCE PER BREACH rather than once per fragment per frame. Draw calls are
 * unchanged: the aperture is merged into the same two material groups the
 * holed variant already had.
 *
 * HOW. The side shell is a parametric grid (`Z_SLICES` × `H_STEPS` over the
 * loft). The aperture replaces a small integer block of that grid with a
 * polar annulus: an outer ring welded ONTO the block's perimeter and an inner
 * ring on a jagged star radius, plus a short collar extruded inboard so the
 * rim shows plank thickness instead of reading as a cut in paper.
 *
 * THE T-JUNCTION RULE, which is the only subtle part. Every outer-ring vertex
 * lies on the coarse grid's own boundary polyline, and every coarse lattice
 * point on that boundary is forced into the ring, so the aperture's outer
 * edge and its neighbouring coarse quads share collinear segments — no crack.
 * Interior rings are evaluated on the TRUE loft (§V.72: the same
 * `sectionHalf`/`hullTopY` expression the shell itself is built from, never a
 * second copy of it), so the patch lies exactly on the hull surface.
 */
import { hullEnvelope, hullTopY, sectionHalf, type HullShape } from './hullMath';

/** a breach in SHIP-space station/height, with the radius of its torn opening */
export interface ShellBreach {
  /** ship-space station (z) of the breach centre */
  z: number;
  /** ship-space height (y) of the breach centre */
  y: number;
  /** m — radius of the torn opening (the ragged rim wanders about this) */
  radius: number;
  /** deterministic per-breach shape seed (§V.2: no Math.random anywhere) */
  seed: number;
}

/**
 * Angular samples per coarse boundary segment of the aperture block. The
 * lattice points themselves are ALWAYS ring vertices (the T-junction rule);
 * this only sets how finely the ring is cut between them, and so it is the
 * knob the whole aperture's cost scales on. A 2x3-cell block has a 10-segment
 * perimeter, so 3 gives a 30-gon rim — ample raggedness for an 0.8 m hole.
 * MEASURED at 5: `addBreach` cost 0.96 ms median / 1.85 ms worst; at 3 it is
 * 0.60 / 1.11, for a rim nobody can count.
 */
const SUB_PER_SEGMENT = 3;
/** radial bands between the torn rim and the block perimeter */
const RADIAL_BANDS = 2;
/**
 * How far the block reaches past the nominal radius. Must exceed `JAG_MAX`
 * with room, or a long spike of the torn rim lands outside its own patch.
 */
const BLOCK_MARGIN = 2.1;
/** extreme values of `jagRadius` / radius — kept in step with it BY TEST */
export const JAG_MIN = 0.86 - 0.18 - 0.1;
export const JAG_MAX = 0.86 + 0.18 + 0.1;

/**
 * Ragged rim radius at angle θ, as a fraction of the nominal radius. Two odd
 * harmonics so the outline has both long tears and short ones and never
 * repeats across a diameter; `seed` rotates them so no two breaches on one
 * ship are the same shape.
 */
export function jagRadius(theta: number, seed: number): number {
  const phi = (seed % 1000) * 0.006283185307179587; // 2π/1000, deterministic
  return 0.86 + 0.18 * Math.sin(3 * theta + phi) + 0.1 * Math.sin(7 * theta + 2.3 * phi);
}

/** the coarse cell block [i0,i1) × [j0,j1) an aperture replaces */
export interface ApertureBlock {
  i0: number;
  i1: number;
  j0: number;
  j1: number;
  /** grid coords of the (possibly re-seated) centre */
  uc: number;
  vc: number;
  /** m per unit u / unit v at the centre */
  cellZ: number;
  cellY: number;
}

/**
 * Seat a breach on the grid, or refuse.
 *
 * THE CENTRE IS CLAMPED INTO THE CUTTABLE BAND rather than refused at its
 * edges, and that is a deliberate call with a cost. The parametric strip runs
 * keel → sheer; the two `LIP_ROWS` above the sheer are the bulwark and are not
 * on this parametrisation, so a ball that strikes the hull section's AABB
 * ABOVE the rail line has no cell to cut. MEASURED on the shipped galleon:
 * seating refused at y = 3.0 m (above `hullTopY` ≈ 2.6–3.3) at every station,
 * and refusing there would mean a hit high on the topsides left no mark at
 * all — which is the very complaint this work exists to answer. It is clamped
 * down to the highest cuttable row instead, so the hole is up to ~0.6 m below
 * where the ball actually went in. STATED, not hidden.
 *
 * Refusal is reserved for the case where the opening genuinely does not fit —
 * a radius wider than the section, or a degenerate shape hint.
 */
export function seatAperture(
  b: ShellBreach,
  s: HullShape,
  zSlices: number,
  hSteps: number,
): ApertureBlock | null {
  const zSpan = s.z1 - s.z0;
  if (!Number.isFinite(zSpan) || Math.abs(zSpan) < 1e-3) return null; // §V.28
  const radius = Number.isFinite(b.radius) ? Math.max(1e-3, b.radius) : 1e-3;
  const cellZ = Math.abs(zSpan) / zSlices;
  const zc = clamp(b.z, Math.min(s.z0, s.z1), Math.max(s.z0, s.z1));
  const span = hullTopY(zc, s) + s.draft;
  if (!Number.isFinite(span) || span < 1e-3) return null; // §V.28
  const cellY = span / hSteps;
  if (cellZ < 1e-6 || cellY < 1e-6) return null;

  let uc = ((zc - s.z0) / zSpan) * zSlices;
  let vc = ((b.y + s.draft) / span) * hSteps;
  if (!Number.isFinite(uc) || !Number.isFinite(vc)) return null;

  // the rim must stay strictly inside the block it replaces
  const keepU = (radius * JAG_MAX) / cellZ;
  const keepV = (radius * JAG_MAX) / cellY;
  const needU = Math.max(1, Math.ceil((2 * radius * BLOCK_MARGIN) / cellZ), Math.ceil(2 * keepU));
  const needV = Math.max(1, Math.ceil((2 * radius * BLOCK_MARGIN) / cellY), Math.ceil(2 * keepV));
  if (needU > zSlices || needV > hSteps) return null; // opening wider than the piece

  const i0 = clamp(Math.round(uc - needU / 2), 0, zSlices - needU);
  const j0 = clamp(Math.round(vc - needV / 2), 0, hSteps - needV);
  const i1 = i0 + needU;
  const j1 = j0 + needV;
  uc = clamp(uc, i0 + keepU, i1 - keepU);
  vc = clamp(vc, j0 + keepV, j1 - keepV);

  return { i0, i1, j0, j1, uc, vc, cellZ, cellY };
}

/** two blocks share at least one coarse cell */
export function blocksOverlap(a: ApertureBlock, b: ApertureBlock): boolean {
  return a.i0 < b.i1 && b.i0 < a.i1 && a.j0 < b.j1 && b.j0 < a.j1;
}

/**
 * The torn edge of one aperture, in ring order, plus the point on the shell
 * it is torn about. The splintered fringe and the dark cavity are BUILT FROM
 * THIS rather than from a second evaluation of the hull — a flat ring laid
 * over the same place is off the planking by up to **1.04 m** at a 0.72 m
 * radius, MEASURED on `hull-starboard-mid` at the waterline, because the
 * round bilge turns the shell hard in the vertical. That flat overlay is what
 * the breach used to be.
 */
export interface ShellRim {
  points: { x: number; y: number; z: number }[];
  centre: { x: number; y: number; z: number };
  radius: number;
  seed: number;
}

export interface AperturePatch {
  positions: number[];
  uvs: number[];
  indices: number[];
  rim: ShellRim;
}

/**
 * Build the annulus + collar that replaces `block`'s cells.
 *
 * `coarse(i, j)` must return the EXISTING grid vertex position — the outer
 * ring is interpolated along those, which is what makes the weld exact.
 */
export function buildAperturePatch(
  b: ShellBreach,
  block: ApertureBlock,
  s: HullShape,
  side: number,
  zSlices: number,
  hSteps: number,
  collarDepth: number,
  coarse: (i: number, j: number) => readonly [number, number, number],
): AperturePatch {
  const { i0, i1, j0, j1, uc, vc, cellZ, cellY } = block;
  const radius = Math.max(1e-3, b.radius);

  // ── the coarse boundary polyline, CCW in (u, v), lattice points included ──
  const lattice: [number, number][] = [];
  for (let i = i0; i < i1; i++) lattice.push([i, j0]);
  for (let j = j0; j < j1; j++) lattice.push([i1, j]);
  for (let i = i1; i > i0; i--) lattice.push([i, j1]);
  for (let j = j1; j > j0; j--) lattice.push([i0, j]);

  // ── OUTER RING: subdivide each lattice segment, positions LERPED along the
  // coarse edge (never re-evaluated on the loft) so the weld is exact ───────
  const outU: number[] = [];
  const outV: number[] = [];
  const outPos: number[] = [];
  for (let k = 0; k < lattice.length; k++) {
    const [ai, aj] = lattice[k];
    const [bi, bj] = lattice[(k + 1) % lattice.length];
    const pa = coarse(ai, aj);
    const pb = coarse(bi, bj);
    for (let t = 0; t < SUB_PER_SEGMENT; t++) {
      const f = t / SUB_PER_SEGMENT;
      outU.push(ai + (bi - ai) * f);
      outV.push(aj + (bj - aj) * f);
      outPos.push(pa[0] + (pb[0] - pa[0]) * f, pa[1] + (pb[1] - pa[1]) * f, pa[2] + (pb[2] - pa[2]) * f);
    }
  }
  const n = outU.length;

  // ── INNER RING: same angular order, on the jagged star ───────────────────
  const inU: number[] = [];
  const inV: number[] = [];
  for (let k = 0; k < n; k++) {
    const dz = (outU[k] - uc) * cellZ;
    const dy = (outV[k] - vc) * cellY;
    // §V.28: the ring is built from the block perimeter, which never passes
    // through its own centre, but a zero here would divide by zero in atan2's
    // consumers, so it is floored rather than assumed
    const theta = Math.abs(dz) + Math.abs(dy) < 1e-9 ? 0 : Math.atan2(dy, dz);
    const r = radius * jagRadius(theta, b.seed);
    inU.push(uc + (r * Math.cos(theta)) / cellZ);
    inV.push(vc + (r * Math.sin(theta)) / cellY);
  }

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const rimPoints: { x: number; y: number; z: number }[] = [];

  const shellPoint = (u: number, v: number): [number, number, number, number, number] => {
    const z = s.z0 + ((s.z1 - s.z0) * u) / zSlices;
    const env = hullEnvelope(z, s);
    const span = hullTopY(z, s) + s.draft;
    const h = v / hSteps;
    return [side * s.beamHalf * sectionHalf(env, h, s), -s.draft + span * h, z, u / zSlices, h];
  };

  // rings 0..RADIAL_BANDS: 0 = torn rim, RADIAL_BANDS = block perimeter
  for (let ring = 0; ring <= RADIAL_BANDS; ring++) {
    const f = ring / RADIAL_BANDS;
    for (let k = 0; k < n; k++) {
      const u = inU[k] + (outU[k] - inU[k]) * f;
      const v = inV[k] + (outV[k] - inV[k]) * f;
      if (ring === RADIAL_BANDS) {
        // welded, not lofted — see the T-junction rule in the header
        positions.push(outPos[k * 3], outPos[k * 3 + 1], outPos[k * 3 + 2]);
        uvs.push(u / zSlices, v / hSteps);
      } else {
        const p = shellPoint(u, v);
        positions.push(p[0], p[1], p[2]);
        uvs.push(p[3], p[4]);
        if (ring === 0) rimPoints.push({ x: p[0], y: p[1], z: p[2] });
      }
    }
  }
  for (let ring = 0; ring < RADIAL_BANDS; ring++) {
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;
      const a = ring * n + k;
      const a1 = ring * n + k1;
      const c = (ring + 1) * n + k;
      const c1 = (ring + 1) * n + k1;
      // (P, P+tangent, P+radial) faces outboard for side ≥ 0 — the same
      // handedness rule `sideStrip` winds its own quads by
      if (side >= 0) indices.push(a, a1, c, c, a1, c1);
      else indices.push(a, c, a1, a1, c, c1);
    }
  }

  // ── COLLAR: the rim carried inboard so the hole has plank thickness ──────
  if (collarDepth > 1e-4) {
    const base = positions.length / 3;
    for (let k = 0; k < n; k++) {
      const p = shellPoint(inU[k], inV[k]);
      positions.push(p[0] - side * collarDepth, p[1], p[2]);
      uvs.push(p[3], p[4]);
    }
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;
      // rim ring is ring 0, i.e. indices 0..n-1
      if (side >= 0) indices.push(k, base + k, k1, k1, base + k, base + k1);
      else indices.push(k, k1, base + k, k1, base + k1, base + k);
    }
  }

  const cp = shellPoint(uc, vc);
  return {
    positions,
    uvs,
    indices,
    rim: {
      points: rimPoints,
      centre: { x: cp[0], y: cp[1], z: cp[2] },
      radius,
      seed: b.seed,
    },
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
