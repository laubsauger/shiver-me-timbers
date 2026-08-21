/**
 * The KON-TIKI FACE on the mainsail (§T90; docs/raft2100/kon-tiki-reference.md
 * §4 Decoration): Hesselberg's bearded sun-god head in rust red with a dark
 * outline — rectangular-oval face, zig-zag headband, round eyes with dots, long
 * nose, rectangular lip symbol, drooping beard outline, 8 short radiating rays.
 *
 * AN SDF, NOT A TEXTURE (§V40: no sampler to spend; §V48: an analytic edge can
 * be band-limited exactly where a bitmap would need a mip chain). The figure is
 * a small list of PRIMITIVES — rounded boxes, circles, segments — built once on
 * the CPU from params and evaluated twice from the same list: here in plain
 * TypeScript (what the tests drive) and in TSL (what the sail draws), the same
 * transliteration-pair convention as sailShape.ts ↔ sailClothNodes.ts. Every
 * point is mirrored about x = 0 by construction, so the face is symmetric
 * because the LIST is, not because each half was drawn carefully.
 *
 * COORDINATES are metres on the flat sail, origin at the face centre, +y up:
 * `x = (u − 0.5)·width`, `y = (v − faceCentreV)·drop`, where (u, v) is the
 * cloth's own uv (u across, v = 0 at the foot, 1 at the head — see
 * pieceGeometrySail's anchor convention `-(1 − v)·drop`).
 *
 * §V23: functional mix()/smoothstep() only.
 */
import * as THREE from 'three/webgpu';
import { float, mix, smoothstep, uniform, vec2 } from 'three/tsl';
import { bandLimitWidth, coordFilter, periodResolved } from './bandLimit';
import { fbm2 } from '../terrain/noise';
import { createRaftPieceUniforms, type AnyNode } from './raftMaterialNodes';
import type { SailDecal } from './sailMaterial';
import { raftParams, type RaftParams } from '../params/raft';
import { raftMaterialParams, type RaftMaterialParams } from '../params/raftMaterials';

type Pt = readonly [number, number];

/** a drawn element. `fill` primitives tint their inside; `stroke` ones draw their boundary */
export type FacePrimitive =
  | { kind: 'rbox'; centre: Pt; half: Pt; radius: number; role: 'fill' | 'stroke' }
  | { kind: 'circle'; centre: Pt; radius: number; role: 'fill' | 'stroke' }
  | { kind: 'segment'; a: Pt; b: Pt };

/** how many rays the head wears — the reference says eight */
export const FACE_RAYS = 8;

/** polynomial smooth-min radius (m): strokes that meet blend instead of notching */
const SMOOTH_K = 0.02;

/** mirror a primitive about x = 0 */
function mirror(p: FacePrimitive): FacePrimitive {
  const mx = (q: Pt): Pt => [-q[0], q[1]];
  switch (p.kind) {
    case 'rbox':
      return { ...p, centre: mx(p.centre) };
    case 'circle':
      return { ...p, centre: mx(p.centre) };
    case 'segment':
      return { kind: 'segment', a: mx(p.a), b: mx(p.b) };
  }
}

/** a polyline as segments */
function polyline(points: readonly Pt[]): FacePrimitive[] {
  const out: FacePrimitive[] = [];
  for (let i = 0; i + 1 < points.length; i++) out.push({ kind: 'segment', a: points[i], b: points[i + 1] });
  return out;
}

/**
 * The figure, from params. Inner features are FRACTIONS of the face's own
 * half-height so re-sizing the head keeps the likeness (§V66).
 */
export function konTikiFacePrimitives(p: RaftMaterialParams = raftMaterialParams): FacePrimitive[] {
  const hw = p.faceHalfWidth;
  const hh = p.faceHalfHeight;
  const s = hh / 0.9; // feature scale: authored at hh = 0.9
  const prims: FacePrimitive[] = [];
  // the head: fill and its outline
  prims.push({ kind: 'rbox', centre: [0, 0], half: [hw, hh], radius: p.faceCorner, role: 'fill' });
  prims.push({ kind: 'rbox', centre: [0, 0], half: [hw, hh], radius: p.faceCorner, role: 'stroke' });
  // zig-zag headband across the forehead, six teeth
  const bandHi = hh - 0.12 * s;
  const bandLo = hh - 0.28 * s;
  const bx0 = -hw + 0.1 * s;
  const teeth = 6;
  const band: Pt[] = [];
  for (let i = 0; i <= teeth * 2; i++) {
    band.push([bx0 + ((hw - 0.1 * s) * 2 * i) / (teeth * 2), i % 2 === 0 ? bandLo : bandHi]);
  }
  prims.push(...polyline(band));
  // eyes: a ring and a dot, right side then mirrored
  const eye: FacePrimitive[] = [
    { kind: 'circle', centre: [0.22 * s, 0.15 * s], radius: 0.12 * s, role: 'stroke' },
    { kind: 'circle', centre: [0.22 * s, 0.15 * s], radius: 0.045 * s, role: 'fill' },
  ];
  prims.push(...eye, ...eye.map(mirror));
  // long nose with a flat base
  prims.push({ kind: 'segment', a: [0, 0.12 * s], b: [0, -0.22 * s] });
  prims.push({ kind: 'segment', a: [-0.1 * s, -0.22 * s], b: [0.1 * s, -0.22 * s] });
  // rectangular lip symbol
  prims.push({ kind: 'rbox', centre: [0, -0.42 * s], half: [0.16 * s, 0.06 * s], radius: 0, role: 'stroke' });
  // drooping beard outline, cheek to chin, inside the head
  const beard: Pt[] = [
    [-(hw - 0.18 * s), -0.15 * s],
    [-(hw - 0.22 * s), -0.55 * s],
    [-0.2 * s, -0.78 * s],
    [0, -0.82 * s],
  ];
  const half = polyline(beard);
  prims.push(...half, ...half.map(mirror));
  // eight short rays on a ring about the head
  for (let k = 0; k < FACE_RAYS; k++) {
    const a = (k / FACE_RAYS) * Math.PI * 2;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    prims.push({
      kind: 'segment',
      a: [p.faceRayInner * c, p.faceRayInner * sn],
      b: [p.faceRayOuter * c, p.faceRayOuter * sn],
    });
  }
  return prims;
}

// ---------------------------------------------------------------------------
// CPU evaluation (the test mirror)

function sdRBox(x: number, y: number, hx: number, hy: number, r: number): number {
  const qx = Math.abs(x) - hx + r;
  const qy = Math.abs(y) - hy + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdSegment(x: number, y: number, a: Pt, b: Pt): number {
  const px = x - a[0];
  const py = y - a[1];
  const bx = b[0] - a[0];
  const by = b[1] - a[1];
  const h = Math.min(1, Math.max(0, (px * bx + py * by) / Math.max(1e-9, bx * bx + by * by)));
  return Math.hypot(px - bx * h, py - by * h);
}

function smin(a: number, b: number, k: number): number {
  const h = Math.min(1, Math.max(0, 0.5 + (0.5 * (b - a)) / k));
  return b + (a - b) * h - k * h * (1 - h);
}

export interface FaceDistances {
  /** signed distance to the painted FILL (the head and the eye dots), m */
  fill: number;
  /** signed distance to the OUTLINE strokes (negative inside a stroke), m */
  stroke: number;
}

/** evaluate the figure at face-centred metres (x, y) */
export function konTikiFaceDistances(
  x: number,
  y: number,
  prims: readonly FacePrimitive[],
  strokeHalf: number,
): FaceDistances {
  let fill = 1e3;
  let stroke = 1e3;
  for (const pr of prims) {
    let d: number;
    let role: 'fill' | 'stroke';
    if (pr.kind === 'rbox') {
      d = sdRBox(x - pr.centre[0], y - pr.centre[1], pr.half[0], pr.half[1], pr.radius);
      role = pr.role;
    } else if (pr.kind === 'circle') {
      d = Math.hypot(x - pr.centre[0], y - pr.centre[1]) - pr.radius;
      role = pr.role;
    } else {
      d = sdSegment(x, y, pr.a, pr.b);
      role = 'stroke';
    }
    if (role === 'fill') fill = smin(fill, d, SMOOTH_K);
    else stroke = smin(stroke, Math.abs(d) - strokeHalf, SMOOTH_K);
  }
  return { fill, stroke };
}

/**
 * The CPU MIRROR the tests drive: signed distance (m) to the painted figure —
 * fill and outline together — at cloth (u, v). Negative = paint.
 */
export function konTikiFaceSdf(
  u: number,
  v: number,
  p: RaftMaterialParams = raftMaterialParams,
  sail: RaftParams = raftParams,
): number {
  const x = (u - 0.5) * sail.mainSailWidth;
  const y = (v - p.faceCentreV) * sail.mainSailDrop;
  const d = konTikiFaceDistances(x, y, konTikiFacePrimitives(p), p.faceStroke);
  return Math.min(d.fill, d.stroke);
}

/**
 * Which sails wear the face: the raft's main course and nothing else. The
 * galleon also names a piece `sail-main-lower`, so the id alone is not enough;
 * its course is ~3× the raft's 5.5 m, and the width bound is what separates
 * them (§V80: the PROPERTY is "the small square main", not a ship name).
 */
export function konTikiFaceApplies(pieceId: string, width: number, p: RaftMaterialParams = raftMaterialParams): boolean {
  return pieceId === 'sail-main-lower' && Number.isFinite(width) && width > 0 && width <= p.faceSailMaxWidth;
}

// ---------------------------------------------------------------------------
// TSL transliteration

function sdRBoxNode(pt: AnyNode, half: Pt, r: number): AnyNode {
  const q = pt.abs().sub(vec2(half[0] - r, half[1] - r));
  return q.max(0).length().add(q.x.max(q.y).min(0)).sub(r);
}

function sdSegmentNode(pt: AnyNode, a: Pt, b: Pt): AnyNode {
  const bx = b[0] - a[0];
  const by = b[1] - a[1];
  const pa = pt.sub(vec2(a[0], a[1]));
  const ba = vec2(bx, by);
  const h = pa.dot(ba).div(Math.max(1e-9, bx * bx + by * by)).clamp(0, 1);
  return pa.sub(ba.mul(h)).length();
}

function sminNode(a: AnyNode, b: AnyNode): AnyNode {
  const h = b.sub(a).mul(0.5 / SMOOTH_K).add(0.5).clamp(0, 1);
  return mix(b, a, h).sub(h.mul(h.oneMinus()).mul(SMOOTH_K));
}

/** TSL twin of {@link konTikiFaceDistances}; `pt` = face-centred metres (vec2) */
export function konTikiFaceNodes(pt: AnyNode, prims: readonly FacePrimitive[], strokeHalf: AnyNode): { fill: AnyNode; stroke: AnyNode } {
  let fill: AnyNode = float(1e3);
  let stroke: AnyNode = float(1e3);
  for (const pr of prims) {
    let d: AnyNode;
    let role: 'fill' | 'stroke';
    if (pr.kind === 'rbox') {
      d = sdRBoxNode(pt.sub(vec2(pr.centre[0], pr.centre[1])), pr.half, pr.radius);
      role = pr.role;
    } else if (pr.kind === 'circle') {
      d = pt.sub(vec2(pr.centre[0], pr.centre[1])).length().sub(pr.radius);
      role = pr.role;
    } else {
      d = sdSegmentNode(pt, pr.a, pr.b);
      role = 'stroke';
    }
    if (role === 'fill') fill = sminNode(fill, d);
    else stroke = sminNode(stroke, d.abs().sub(strokeHalf));
  }
  return { fill, stroke };
}

/**
 * The decal the sail material composes in (see `SailDecal`). Shared by every
 * sail — ONE sail material — and switched on per object by
 * {@link konTikiFaceApplies} through an objectGroup uniform.
 *
 * BAND LIMIT (§V.48/§V.70): the paint edge is a STEP between cloth and paint,
 * so it is WIDENED to ≥ 2 px of the metres coordinate and NOT faded — a face
 * that faded out at range would be the §V.70 failure (the feature deleted, not
 * filtered). The crack noise IS faded, to its own mean, by `periodResolved`.
 */
export function createKonTikiDecal(p: RaftMaterialParams = raftMaterialParams, sail: RaftParams = raftParams): SailDecal {
  const uFill = uniform(new THREE.Color(p.faceFill));
  const uOutline = uniform(new THREE.Color(p.faceOutline));
  const uWidth = uniform(sail.mainSailWidth);
  const uDrop = uniform(sail.mainSailDrop);
  const uCentreV = uniform(p.faceCentreV);
  const uStroke = uniform(p.faceStroke);
  const uEdge = uniform(p.faceEdge);
  const uWear = uniform(p.faceWear);
  const piece = createRaftPieceUniforms({
    variantOf: (id, width) => (konTikiFaceApplies(id, width, p) ? 1 : 0),
  });
  const prims = konTikiFacePrimitives(p);

  return {
    apply(color: AnyNode, cloth: AnyNode, clothWeight: AnyNode): AnyNode {
      const pt = vec2(cloth.x.sub(0.5).mul(uWidth), cloth.y.sub(uCentreV).mul(uDrop));
      const d = konTikiFaceNodes(pt, prims, uStroke);
      // metres per pixel, the worse of the two axes
      const filter = coordFilter(pt.x).max(coordFilter(pt.y));
      const eff = bandLimitWidth(uEdge, pt.x, filter);
      // widened step, never faded (§V.70) — `eff` is the band limit
      const fillMask = smoothstep(float(0), eff, d.fill).oneMinus();
      // @band-limited-elsewhere: same widened `eff` (bandLimitWidth) as the fill
      const strokeMask = smoothstep(float(0), eff, d.stroke).oneMinus();
      // weathering: broad loss of pigment plus fine paint cracks
      const wear = fbm2(pt.mul(3), 3);
      const crackCoord = pt.mul(18);
      const crackNoise = fbm2(crackCoord, 2);
      const crackRaw = crackNoise.sub(0.62).mul(12).clamp(0, 1);
      // faded to its mean coverage (~0.08), not to zero (§V.48b)
      const crack = mix(float(0.08), crackRaw, periodResolved(crackCoord.x));
      const keep = float(1).sub(uWear.mul(wear)).mul(float(1).sub(crack.mul(0.6)));
      const on = piece.variant.mul(clothWeight);
      let out: AnyNode = mix(color, uFill, fillMask.mul(keep).mul(on));
      out = mix(out, uOutline, strokeMask.mul(keep.mul(0.5).add(0.5)).mul(on));
      return out;
    },
    refresh(): void {
      uFill.value.set(p.faceFill);
      uOutline.value.set(p.faceOutline);
      uWidth.value = sail.mainSailWidth;
      uDrop.value = sail.mainSailDrop;
      uCentreV.value = p.faceCentreV;
      uStroke.value = p.faceStroke;
      uEdge.value = p.faceEdge;
      uWear.value = p.faceWear;
    },
  };
}
