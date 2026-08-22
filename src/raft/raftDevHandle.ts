/**
 * The dev console handle the lookdev agent drives the raft page with (§V.88).
 *
 * NOT AN INTERFACE CONTRACT — nothing in the game reads it, and nothing should.
 * It lives out here rather than in `main-raft.ts` because the entry is capped
 * at 300 lines (§T.98 / `tests/raftIsolation.test.ts`) and a debug affordance
 * is the last thing that should be spending them.
 */
export function installRaftDevHandle(handle: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  (window as unknown as Record<string, unknown>).__game = handle;
}
