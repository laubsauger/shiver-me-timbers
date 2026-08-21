/**
 * Boot glue about SHADER PIPELINES, shared by every mode (§V95).
 *
 * `main.ts` and `main-raft.ts` both warm the scene before the splash lifts and
 * both flip the post path on mid-session, and both had their own copy of the
 * two mechanisms below — the raft's `withFullCoverage` was a verbatim paste,
 * comment and all. A copy is not a shared helper: the moment one side learns
 * something (and the coverage guard below is nothing BUT things learned the
 * hard way) the other silently keeps the old bug. One definition, two callers.
 *
 * Nothing here builds a scene: the heavy systems each mode chooses to include
 * or leave out stay where they are (§V95 allows a mode to leave a system OUT,
 * never to re-implement it).
 */
import type { Object3D } from 'three/webgpu';

/**
 * COVERAGE GUARD, and it is a real hole rather than a precaution.
 * `Renderer.compileAsync()` runs the same `_projectObject` walk a render
 * does — including the frustum cull — but it never rebuilds `_frustum`
 * (only `_renderScene` does, three r180 Renderer.js:1410). So the warm-up
 * culls against whatever was left there: on a cold boot, a default Frustum
 * whose six planes are all `x + 0 = 0`, which rejects every object whose
 * centre sits at negative world X. Those materials are then MISSING from
 * the warm-up and compile synchronously on their first draw — a hitch,
 * silently, and exactly what the splash is meant to have already paid for.
 * Nor does it update matrices, so the cull runs on stale ones.
 *
 * Turn culling off for the walk, restore precisely what was there. The
 * restore happens BEFORE the await: compileAsync is synchronous up to its
 * final `Promise.all`, so by then the walk is done, and leaving the flags
 * off across the wait would silently un-cull the running game.
 */
export function withFullCoverage(root: Object3D, compile: () => Promise<unknown>): Promise<unknown> {
  const culled: boolean[] = [];
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    culled.push(o.frustumCulled);
    o.frustumCulled = false;
  });
  const pending = compile();
  let i = 0;
  root.traverse((o) => {
    o.frustumCulled = culled[i++] ?? o.frustumCulled;
  });
  return pending;
}

/**
 * §T.40. The post switch has `reload: false`, so it can flip mid-session —
 * and post renders the scene into its OWN target, whose colour format and
 * sample count give every material a different pipeline cache key. Flipping
 * it on cold recompiles the entire scene synchronously inside one frame
 * (seconds, frozen). So: warm it in the background on the first request and
 * keep drawing direct to the canvas until the pipelines exist.
 *
 * `enabled()` is read on EVERY call (§V.62: the switch is a live knob), while
 * the initial warm state is sampled ONCE at construction — post that was on
 * at boot was compiled by the boot warm-up, so it needs no second pass.
 *
 * Returns the gate: true = the post path is compiled, draw through it.
 */
export function createPostWarmGate(d: {
  /** the live `postParams.enabled` switch */
  enabled: () => boolean;
  /** compile the post path; whatever profiling/logging the caller wants goes here */
  warm: () => Promise<unknown>;
}): () => boolean {
  let warm = d.enabled();
  let warming = false;
  return (): boolean => {
    if (!d.enabled()) return false;
    if (warm) return true;
    if (!warming) {
      warming = true;
      void d.warm().then(() => {
        warm = true;
        warming = false;
      });
    }
    return false;
  };
}
