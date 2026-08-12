/**
 * §V12/§V45 rigging-block pose — the CPU reference of the maths the block
 * vertex stage in src/ropes/blocks.ts runs, in the same arrangement
 * catenaryMath.ts has for the §V12 solve and ropeDynamics.ts for §V42: the GPU
 * side cannot be unit-tested, so THIS is the tested ground truth and the shader
 * mirrors it term for term. Pure math, no three.js, never called per frame.
 *
 * WHY A BLOCK MUST NOT BE PLACED FROM ITS SOCKET (the user report: "they're
 * not really playing with the physics, as the ropes do"). A block used to be a
 * CPU-written instance matrix at the socket's world position with a fixed yaw:
 * it therefore rode the ship and NOTHING else. The line it is seized into sags,
 * swings and — once §V42 is on — carries lag and gust whip, and the block
 * simply ignored all of it. Same failure mode §V45 fixed for ratlines, same
 * cure: address the block into the rope's own index space (rope, t) and read
 * the SAME solved points/tangents buffer the rope is drawn from. Then the block
 * rides whatever the rope actually does, for free and forever — catenary sag
 * today, the Verlet chain the moment `ropeParams.dynamic` flips.
 *
 * ORIENTATION IS THE OTHER HALF. A real block hangs from its strop under its
 * own weight and is cocked over toward the pull of the line reeved through it:
 *   slack line  → the block hangs plumb and swings as its anchor moves
 *   taut line   → the block is dragged into the line and lies along it
 * `blockTension` is the visual proxy for that pull — it is derived from the
 * rope's own slack ratio (length ÷ chord), which is live data: §V46 hauls a
 * buntline's length in as the sail furls, so its block visibly snaps into line
 * with the rope going taut. It is a proxy, not a force solve; the honest force
 * solve is §V42's, and this is deliberately expressed so that when §V42 lands
 * the tangent it reads already carries the real dynamics.
 */
import { Z_MIN, type Vec3Like } from './catenaryMath';

/** gravity direction — the direction a block hangs when nothing pulls it */
export const DOWN: Vec3Like = { x: 0, y: -1, z: 0 };

/** below this a cross product is treated as degenerate (parallel inputs) */
const EPS = 1e-6;

/**
 * One block, addressed into the rope system's own index space — exactly like
 * §V45's RungDescriptor, and for the same reason.
 */
export interface BlockDescriptor {
  /** rigging-plan index of the rope this block is seized into */
  rope: number;
  /** curve parameter along that rope, 0 = socketA end, 1 = socketB end */
  t: number;
  /** shell height (m) */
  size: number;
  /** +1 when the line runs away from the block toward increasing t, -1 when
   *  the block sits at the far end and the line runs back */
  away: 1 | -1;
  /** the socket the block hangs at. CPU-side identity for determinism tests
   *  and debugging only — never packed, the GPU knows nothing about sockets */
  socket: string;
}

/** the block's orthonormal frame: `hang` is where the shell points (local −Y),
 *  `axle` the sheave's axis (local +Z), `side` the cheek normal-ish (local +X) */
export interface BlockFrame {
  hang: Vec3Like;
  axle: Vec3Like;
  side: Vec3Like;
}

export interface BlockPose {
  /** world position of the block's CROWN — the point on the rope it hangs from */
  position: Vec3Like;
  frame: BlockFrame;
  /** 1 = dragged fully into the line, 0 = hanging plumb */
  tension: number;
}

const sub = (a: Vec3Like, b: Vec3Like): Vec3Like =>
  ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scale = (a: Vec3Like, s: number): Vec3Like => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const len = (a: Vec3Like): number => Math.hypot(a.x, a.y, a.z);
const cross = (a: Vec3Like, b: Vec3Like): Vec3Like => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const mix = (a: Vec3Like, b: Vec3Like, t: number): Vec3Like => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});

/** unit vector, or `fallback` when the input is degenerate or non-finite —
 *  mirrors the shader's `select(len < eps, fallback, normalize(v))` */
function unit(v: Vec3Like, fallback: Vec3Like): Vec3Like {
  const l = len(v);
  return l > EPS && Number.isFinite(l) ? scale(v, 1 / l) : { ...fallback };
}

/** smoothstep, 3-arg functional form (§V23/§B1 — never the chained one) */
function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / Math.max(e1 - e0, Z_MIN)));
  return t * t * (3 - 2 * t);
}

/**
 * How hard the line is pulling on the block, 0..1, from the rope's slack ratio
 * (arc length ÷ chord, always ≥ 1). 1 at dead taut, falling to 0 once the rope
 * carries `span` of slack. This is what makes a block RESPOND to §V46: hauling
 * a buntline shortens its length while its anchors stay put, so the ratio drops
 * toward 1 and the block swings up into the line.
 */
export function blockTension(slackRatio: number, span: number): number {
  if (!Number.isFinite(slackRatio)) return 0;
  return 1 - smoothstep(0, Math.max(span, Z_MIN), slackRatio - 1);
}

/**
 * Which way the shell points: plumb down when nothing pulls, along the line
 * when the line is taut, and the honest blend between the two in the middle.
 * `tangentAway` is the rope's unit tangent pointing AWAY from the block.
 */
export function blockHang(tangentAway: Vec3Like, tension: number): Vec3Like {
  const t = Math.min(1, Math.max(0, Number.isFinite(tension) ? tension : 0));
  return unit(mix(DOWN, tangentAway, t), DOWN);
}

/**
 * The block's frame. The sheave's axle is horizontal and square to the line, so
 * the slot the rope reeves through lies in the VERTICAL plane the line runs in
 * — which is what a stropped block does, and is well defined for every case
 * that matters. `hang` always lies in that same plane (it is a blend of DOWN
 * and the tangent), so the frame is orthonormal by construction rather than by
 * a re-orthogonalisation step.
 *
 * A dead-vertical line leaves the plane undefined; `seed` (the rope index)
 * then picks a deterministic axle, so two blocks on two vertical lines do not
 * face identically and neither of them flickers frame to frame.
 */
export function blockFrame(
  hang: Vec3Like,
  tangentAway: Vec3Like,
  seed: number,
): BlockFrame {
  const angle = seed * 2.399; // golden angle: deterministic, well spread
  const ref: Vec3Like = { x: Math.cos(angle), y: 0, z: Math.sin(angle) };
  const raw = cross(tangentAway, DOWN);
  const axle = len(raw) > EPS ? unit(raw, ref) : unit(cross(ref, DOWN), { x: 1, y: 0, z: 0 });
  const side = cross(axle, hang);
  return { hang, axle, side: unit(side, { x: 1, y: 0, z: 0 }) };
}

/**
 * Sample a solved rope's polyline at curve parameter t — the transliteration
 * of the vertex stage's two storage reads and a lerp. `points` is one rope's
 * slice of the compute-written points buffer.
 */
export function sampleCurve(points: Vec3Like[], t: number): Vec3Like {
  const segments = points.length - 1;
  if (segments < 1) return points[0] ?? { x: 0, y: 0, z: 0 };
  const s = Math.min(Math.max(Number.isFinite(t) ? t : 0, 0), 1) * segments;
  const i0 = Math.min(Math.floor(s), segments - 1);
  const frac = s - i0;
  return mix(points[i0], points[i0 + 1], frac);
}

/**
 * Unit tangents by central difference over the samples — the CPU mirror of the
 * tangent pass at the end of the rope kernel. Tests build these from
 * solveCatenary so they exercise the same data the GPU hands the block.
 */
export function curveTangents(points: Vec3Like[]): Vec3Like[] {
  const last = points.length - 1;
  return points.map((_, i) => {
    const d = sub(points[Math.min(i + 1, last)], points[Math.max(i - 1, 0)]);
    return unit(d, { x: 0, y: 1, z: 0 });
  });
}

/**
 * Everything the vertex stage computes before it places a vertex: where the
 * block hangs from, and which way it is cocked.
 *
 * `slackRatio` is the rope's own length ÷ chord, read on the GPU from the same
 * descriptor buffer the solver reads — so it tracks §V46 reefing live.
 */
export function blockPose(
  points: Vec3Like[],
  tangents: Vec3Like[],
  desc: BlockDescriptor,
  slackRatio: number,
  slackSpan: number,
): BlockPose {
  const position = sampleCurve(points, desc.t);
  const tangentAway = unit(scale(sampleCurve(tangents, desc.t), desc.away), DOWN);
  const tension = blockTension(slackRatio, slackSpan);
  const hang = blockHang(tangentAway, tension);
  return { position, frame: blockFrame(hang, tangentAway, desc.rope), tension };
}

/**
 * §V48 band limit for the block's INTERNAL contrast (the dark sheave in the
 * slot, the hemp strop in the score), by the shell's projected pixel width:
 * 1 = draw it, 0 = the whole block is one flat wood tone.
 *
 * A block is ~0.25 m; its sheave slot is ~0.04 m and goes sub-pixel an order of
 * magnitude sooner than the shell does. §B.20 is exactly this failure — an
 * unfiltered high-contrast feature narrower than the sample grid, differenced
 * per pixel into speckle — and its cure's second half is to FADE the feature's
 * amplitude to the average that pixel should have seen. That average is the
 * shell, because the shell is nearly all of the block. The first half of the
 * §B.20 cure (widen the transition) has no analogue here: the transition is a
 * geometric edge, not a procedural one, so there is nothing to widen.
 */
export function blockDetail(widthPx: number, minPx: number, maxPx: number): number {
  if (!Number.isFinite(widthPx)) return 0;
  return smoothstep(Math.min(minPx, maxPx), Math.max(maxPx, minPx + Z_MIN), widthPx);
}

/**
 * Pack descriptors into the single vec4 lane the block mesh reads:
 *   (rope, t, size, away)
 * Written once when the rig is built — no per-frame CPU work, exactly as §V12
 * requires of the ropes themselves. Blocks used to break that rule with a
 * per-frame setBlock() per pulley; they no longer touch the CPU at all.
 */
export function packBlocks(blocks: BlockDescriptor[], arr: Float32Array): void {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const o = i * 4;
    arr[o] = b.rope;
    arr[o + 1] = b.t;
    arr[o + 2] = b.size;
    arr[o + 3] = b.away;
  }
}
