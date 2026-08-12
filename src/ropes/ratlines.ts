/**
 * §V45 ratlines — the ladder rungs seized across each shroud fan.
 *
 * The ship system hands over INTENT (src/ship/ratlinePlan.ts): which shrouds a
 * ladder spans, where each rung sits along them, how thick. This module turns
 * that into per-rung descriptors addressed by ROPE INDEX, so the rung mesh can
 * read the same solved points buffer the shrouds are drawn from.
 *
 * WHY IT MUST SAMPLE THE SOLVED CURVE, not the sockets. A rung authored from
 * the chainplate and masthead positions would be straight, and correct only
 * while the shrouds are. They already sag slightly at slack 1.004, and once
 * §V42 dynamics is on they swing — at which point an authored ladder stays
 * exactly where it was authored and floats off its own ropes. Nothing errors;
 * it just looks wrong. Sampling `points` costs nothing extra and makes a mast
 * that breaks and swings carry its ratlines with it for free (§V14).
 *
 * COST. One rung crosses the WHOLE fan — a ratline is a single line seized
 * across every shroud, not a separate ladder per adjacent pair. That is why
 * the galleon needs 162 rungs and not the ~440 a pairwise reading implies.
 */
import { MIN_RUNG, type RatlineLadder } from '../ship/ratlinePlan';
import type { Vec3Like } from './catenaryMath';
import { ropeParams } from '../params/ropes';
import type { RiggingRope } from './shipRigging';

/**
 * One rung, addressed into the rope system's own index space.
 *
 * `tA`/`tB` are 0 at the CHAINPLATE and 1 at the masthead, matching the ship's
 * plan. The rope's samples run the other way — a shroud is stored masthead →
 * chainplate — so the mesh flips them; keeping the ship's convention here
 * means the two plans can be diffed against each other by eye.
 */
export interface RungDescriptor {
  /** rigging-plan index of the shroud at the outboard end of the fan */
  ropeA: number;
  /** …and at the inboard end */
  ropeB: number;
  tA: number;
  tB: number;
  /** belly below the straight A→B line, as a fraction of the rung's span */
  sag: number;
  /** tube radius (m) */
  radius: number;
}

/** the shroud rope index rising from `foot` to `masthead`, or -1 */
function findShroud(plan: RiggingRope[], masthead: string, foot: string): number {
  return plan.findIndex(
    (r) => r.role === 'shroud' && r.socketA === masthead && r.socketB === foot,
  );
}

/**
 * Map the ship's ladders onto rope indices. Ladders whose shrouds are not in
 * the rigging plan are DROPPED, not thrown on: the plan legitimately omits a
 * mast's shrouds when its chainplates sit below the deck it is stepped on, and
 * that mast should simply have no ratlines rather than fail the boot.
 *
 * A silent drop is still a bug the moment it is not that case, so
 * tests/ratlines.test.ts asserts the shipped blueprints produce a ladder for
 * every fan — the tripwire lives there rather than in a throw here.
 */
export function buildRungDescriptors(
  ladders: RatlineLadder[],
  plan: RiggingRope[],
): RungDescriptor[] {
  const rungs: RungDescriptor[] = [];
  for (const ladder of ladders) {
    const ropeA = findShroud(plan, ladder.masthead, ladder.footA);
    const ropeB = findShroud(plan, ladder.masthead, ladder.footB);
    if (ropeA < 0 || ropeB < 0 || ropeA === ropeB) continue;
    ladder.rungs.forEach((rung, index) => {
      rungs.push({
        ropeA,
        ropeB,
        tA: clamp01(rung.tA),
        tB: clamp01(boundTiltOffset(ladder.rungs, index)),
        sag: Math.max(0, rung.sag),
        radius: Math.max(1e-4, ladder.radius),
      });
    });
  }
  return rungs;
}

function clamp01(t: number): number {
  return Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
}

/**
 * CPU mirror of the rung mesh's arc-length sampler (ratlineMesh.sampleRope).
 * `t` is 0 at the CHAINPLATE and 1 at the masthead, while a shroud's samples
 * run masthead → chainplate — hence the flip, exactly as in the shader.
 *
 * The GPU side cannot be unit-tested, so this is the tested ground truth for
 * "where is a rung's end", the same arrangement catenaryMath.ts has for the
 * §V12 solve. See the shader for WHY this is arc length and not sample index.
 */
export function sampleRopeByArcLength(points: Vec3Like[], t: number): Vec3Like {
  const last = points.length - 1;
  if (last < 1) return points[0] ?? { x: 0, y: 0, z: 0 };
  const links: number[] = [];
  let total = 0;
  for (let i = 0; i < last; i++) {
    const l = Math.max(
      Math.hypot(
        points[i + 1].x - points[i].x,
        points[i + 1].y - points[i].y,
        points[i + 1].z - points[i].z,
      ),
      1e-9,
    );
    links.push(l);
    total += l;
  }
  const want = Math.min(total, Math.max(0, (1 - clamp01(t)) * total));
  let acc = 0;
  let idx = last - 1;
  let frac = 1;
  for (let i = 0; i < last; i++) {
    if (want >= acc && want <= acc + links[i]) {
      idx = i;
      frac = (want - acc) / links[i];
      break;
    }
    acc += links[i];
  }
  const a = points[idx];
  const b = points[idx + 1];
  return {
    x: a.x + (b.x - a.x) * frac,
    y: a.y + (b.y - a.y) * frac,
    z: a.z + (b.z - a.z) * frac,
  };
}

/**
 * §V45 MIN_RUNG as the rung mesh applies it: 1 = draw, 0 = collapse to
 * nothing. CPU mirror of the `smoothstep(MIN_RUNG × fade, MIN_RUNG, span)` in
 * ratlineMesh.segmentNodes.
 *
 * The ship plan applies the same cutoff to STRAIGHT LINES between sockets in
 * ship space; the drawn rung is a chord between two solved curves resolved
 * through the piece graph, and the two disagree. Once rungs are placed by arc
 * length they actually reach the top of the fan, where the shrouds close, and
 * 40 of the galleon's 162 come out under the cutoff. "A rung you cannot put a
 * foot on is not a rung, and a ladder that tapers to a point reads as a spike"
 * — so the span has to be judged where the span is known, which is the shader.
 * Faded rather than switched so nothing pops as §V42 works the fan.
 */
export function rungVisibility(span: number, minRung = MIN_RUNG, fade = 0.8): number {
  if (!Number.isFinite(span)) return 0;
  const e0 = minRung * fade;
  const t = Math.min(1, Math.max(0, (span - e0) / Math.max(minRung - e0, 1e-9)));
  return t * t * (3 - 2 * t);
}

/**
 * Bound how far a rung's two ends may sit apart ALONG their shrouds.
 *
 * The ship plan deliberately offsets tB from tA so the ladder is not machine
 * level (§V2 hand-seizing look), but it expresses that offset as a fraction of
 * a WHOLE SHROUD — and a shroud is 26 m, so the shipped 0.006 is a 16 cm
 * height difference across a rung that may only be 0.4 m wide. That is a 22°
 * cocked rung, which is the tail of the user's report that survives the
 * arc-length fix. The physical quantity is "a rung is seized a centimetre or
 * two off level", whose natural unit here is the ladder's OWN rung spacing —
 * which is knowable from the plan without any world positions.
 *
 * The offset keeps its sign and its relative variation, so the ladder still
 * reads as hand-seized; only the tail is bounded.
 */
function boundTiltOffset(rungs: RatlineLadder['rungs'], index: number): number {
  const here = rungs[index];
  const neighbour = index > 0 ? rungs[index - 1] : rungs[Math.min(1, rungs.length - 1)];
  const spacing = Math.abs(here.tA - neighbour.tA);
  const limit = Math.max(0, ropeParams.rungTiltFraction) * spacing;
  const offset = here.tB - here.tA;
  return here.tA + Math.min(limit, Math.max(-limit, Number.isFinite(offset) ? offset : 0));
}

/**
 * Pack descriptors into the two vec4 lanes the rung mesh reads.
 *   A: (ropeA, ropeB, tA, tB)
 *   B: (sag, radius, 0, 0)
 * Written once when the rig is built — there is no per-frame CPU work here,
 * exactly as §V12 requires of the ropes themselves.
 */
export function packRungs(
  rungs: RungDescriptor[],
  arrA: Float32Array,
  arrB: Float32Array,
): void {
  for (let i = 0; i < rungs.length; i++) {
    const r = rungs[i];
    const o = i * 4;
    arrA[o] = r.ropeA;
    arrA[o + 1] = r.ropeB;
    arrA[o + 2] = r.tA;
    arrA[o + 3] = r.tB;
    arrB[o] = r.sag;
    arrB[o + 1] = r.radius;
    arrB[o + 2] = 0;
    arrB[o + 3] = 0;
  }
}
