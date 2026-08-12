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
import type { RatlineLadder } from '../ship/ratlinePlan';
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
    for (const rung of ladder.rungs) {
      rungs.push({
        ropeA,
        ropeB,
        tA: clamp01(rung.tA),
        tB: clamp01(rung.tB),
        sag: Math.max(0, rung.sag),
        radius: Math.max(1e-4, ladder.radius),
      });
    }
  }
  return rungs;
}

function clamp01(t: number): number {
  return Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
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
