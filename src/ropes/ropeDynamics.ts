/**
 * §V42 dynamic rope — CPU reference of the Verlet chain the compute kernel in
 * src/ropes/ropeCompute.ts runs. Same arrangement as catenaryMath.ts is for
 * the §V12 catenary: the GPU side cannot be unit-tested, so this file is the
 * tested ground truth and the kernel mirrors it term for term. Pure math, no
 * three.js, and NOT called per frame at runtime (§V12: the CPU never solves
 * ropes) — it exists so tests can assert the behaviour the kernel must have.
 *
 * WHY VERLET, AND WHY IN WORLD SPACE. Position Verlet stores where a particle
 * was rather than how fast it is going, so velocity is implied by the last
 * step. That is what makes the effect work: PIN the anchors to sockets that
 * move with the ship and the particles between them keep their own momentum,
 * so when the hull heaves or accelerates away the rope is simply left behind
 * and swings back. Ship acceleration is never measured or passed in — it
 * emerges from integrating in world space, which is exactly what the canned
 * sine offset it replaces could never do, and why that read as dead.
 *
 * Distance constraints are Gauss-Seidel: correct one link, immediately use the
 * corrected position for the next. Sequential along the chain, which is legal
 * without barriers precisely because §V12 gives one thread the whole rope.
 */
import type { Vec3Like } from './catenaryMath';

/** frame delta is clamped into this window before integrating: a stalled
 *  frame or a backgrounded tab must not hand the integrator a step it
 *  explodes on, and Verlet is only conditionally stable (§V28) */
export const DT_MIN = 1 / 240;
export const DT_MAX = 1 / 30;

/** guards every divisor here — no NaN may reach a vertex position (§B5) */
const EPS = 1e-9;

export interface RopeDynamicsParams {
  /** m/s² downward */
  gravity: number;
  /** per-substep velocity retention, 0..1 */
  damping: number;
  /** acceleration (m/s²) per m/s of wind */
  windForce: number;
  /** constraint passes per substep */
  constraintIterations: number;
  /** integration substeps per frame */
  substeps: number;
  /** a particle may never stray further than this (m) from its rest curve */
  maxStray: number;
  /** an anchor moving further than this in one frame (m) means the rope was
   *  re-anchored, not sailed — reseed rather than snap it across the gap */
  teleportDistance: number;
}

const add = (a: Vec3Like, b: Vec3Like): Vec3Like =>
  ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a: Vec3Like, b: Vec3Like): Vec3Like =>
  ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scale = (a: Vec3Like, s: number): Vec3Like => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const len = (a: Vec3Like): number => Math.hypot(a.x, a.y, a.z);

/** the chain's mutable state: where every particle is, and was */
export interface RopeState {
  pos: Vec3Like[];
  prev: Vec3Like[];
}

/** seed a chain along a rest curve, at rest (pos === prev ⇒ zero velocity) */
export function seedRope(restCurve: Vec3Like[]): RopeState {
  return {
    pos: restCurve.map((p) => ({ ...p })),
    prev: restCurve.map((p) => ({ ...p })),
  };
}

/**
 * One Verlet position update. `prev` becomes the current position, so the
 * implied velocity carries to the next step — that carried momentum is the
 * lag the effect is made of.
 */
export function verletStep(
  cur: Vec3Like,
  prev: Vec3Like,
  accel: Vec3Like,
  dt: number,
  damping: number,
): Vec3Like {
  const vel = scale(sub(cur, prev), damping);
  return add(add(cur, vel), scale(accel, dt * dt));
}

/**
 * Gauss-Seidel distance constraints along the chain, then re-pin both anchors.
 * Each link is pulled to `rest`, splitting the correction between its two
 * particles; the anchors are restored afterwards, which is what makes the
 * whole rope hang FROM them rather than drift with them.
 */
export function solveConstraints(
  pos: Vec3Like[],
  rest: number,
  iterations: number,
  anchorA: Vec3Like,
  anchorB: Vec3Like,
): void {
  const last = pos.length - 1;
  if (last < 1) return;
  for (let k = 0; k < iterations; k++) {
    for (let i = 0; i < last; i++) {
      const d = sub(pos[i + 1], pos[i]);
      const l = Math.max(len(d), EPS);
      const corr = scale(d, ((l - rest) / l) * 0.5);
      pos[i] = add(pos[i], corr);
      pos[i + 1] = sub(pos[i + 1], corr);
    }
    pos[0] = { ...anchorA };
    pos[last] = { ...anchorB };
  }
}

/**
 * Pull a particle back onto its rest curve if it has strayed too far. The
 * stability net: a chain that has blown up — or gone non-finite — is dragged
 * back to a sane rope instead of drawing NaN-sized geometry and wedging the
 * GPU process (§V28, §B5). Also does the first-frame seeding job on the GPU,
 * where the buffers start zeroed.
 */
export function leash(p: Vec3Like, restPos: Vec3Like, maxStray: number): Vec3Like {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
    return { ...restPos };
  }
  const offset = sub(p, restPos);
  const d = Math.max(len(offset), EPS);
  return add(restPos, scale(offset, Math.min(d, maxStray) / d));
}

/**
 * How much of a rope is simulated, by camera distance: 1 near, 0 past
 * `simDistance + band`. Metres is the honest currency HERE because this gates
 * simulation COST — unlike the §V41 render regimes, which face a rasterisation
 * artefact and are therefore measured in pixels (§V36).
 */
export function simWeight(
  cameraDistance: number,
  simDistance: number,
  fadeBand: number,
): number {
  const e1 = simDistance + Math.max(fadeBand, 1);
  const t = Math.min(1, Math.max(0, (cameraDistance - simDistance) / Math.max(e1 - simDistance, EPS)));
  return 1 - t * t * (3 - 2 * t);
}

const finite = (p: Vec3Like): boolean =>
  Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);

/**
 * Must this chain be rebuilt from its rest curve rather than integrated?
 *
 * Three failure modes, one predicate, deliberately:
 *  1. never seeded — a chain starting at the world origin whips across the map.
 *  2. RE-ANCHORED — a mast breaking (§V14) teleports an anchor, and a chain
 *     still hanging off the old one is snapped violently across the gap by its
 *     own distance constraints. Anchors are pinned every frame, so `pos[0]`
 *     holds where the anchor was LAST frame: comparing it to the anchor now is
 *     exactly "did it jump".
 *  3. non-finite state — checked here rather than left to the leash, because
 *     the leash divides by the stray distance and NaN/NaN is still NaN. The
 *     GPU mirror gets this for free: `x <= t` is false for NaN in WGSL.
 */
export function needsReseed(
  state: RopeState,
  anchorA: Vec3Like,
  anchorB: Vec3Like,
  teleportDistance: number,
): boolean {
  const last = state.pos.length - 1;
  if (last < 1) return false;
  if (!state.pos.every(finite) || !state.prev.every(finite)) return true;
  return (
    len(sub(state.pos[0], anchorA)) > teleportDistance ||
    len(sub(state.pos[last], anchorB)) > teleportDistance
  );
}

/**
 * Advance a rope one frame: substepped integrate → pin → constrain → leash.
 * Mirrors the kernel's ordering exactly, because the ordering is load-bearing
 * (pinning before constraints is what propagates anchor motion down the chain
 * within the same frame).
 *
 * @param restCurve the catenary the rope hangs from — seeds and leashes it
 * @param wind      world-space wind vector (m/s)
 */
export function stepRope(
  state: RopeState,
  anchorA: Vec3Like,
  anchorB: Vec3Like,
  ropeLength: number,
  restCurve: Vec3Like[],
  wind: Vec3Like,
  frameDt: number,
  p: RopeDynamicsParams,
): void {
  const n = state.pos.length;
  if (n < 2) return;
  const last = n - 1;
  if (needsReseed(state, anchorA, anchorB, p.teleportDistance)) {
    // rebuild at rest: pos === prev, so the chain has no inherited velocity to
    // fling it anywhere. Everything below then proceeds normally.
    for (let i = 0; i < n; i++) {
      state.pos[i] = { ...restCurve[i] };
      state.prev[i] = { ...restCurve[i] };
    }
  }
  const dtFrame = Math.min(DT_MAX, Math.max(DT_MIN, Number.isFinite(frameDt) ? frameDt : DT_MIN));
  const substeps = Math.max(1, Math.round(p.substeps));
  const dt = dtFrame / substeps;
  const rest = ropeLength / Math.max(last, 1);
  const accel: Vec3Like = {
    x: wind.x * p.windForce,
    y: -p.gravity + wind.y * p.windForce,
    z: wind.z * p.windForce,
  };

  for (let s = 0; s < substeps; s++) {
    for (let i = 0; i < n; i++) {
      const next = verletStep(state.pos[i], state.prev[i], accel, dt, p.damping);
      state.prev[i] = state.pos[i];
      state.pos[i] = next;
    }
    // anchors ride their sockets — the ONLY place ship motion enters
    state.pos[0] = { ...anchorA };
    state.pos[last] = { ...anchorB };
    solveConstraints(state.pos, rest, Math.max(1, Math.round(p.constraintIterations)), anchorA, anchorB);
  }
  for (let i = 0; i < n; i++) {
    state.pos[i] = leash(state.pos[i], restCurve[i], p.maxStray);
  }
}
