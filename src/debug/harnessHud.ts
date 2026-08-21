/**
 * The perf HUD, wired for a preview harness (§V95, §V.17).
 *
 * `ship/preview.ts` used to count its own frames into its own `#hud` div —
 * `performance.now()` bookkeeping, a 500 ms window, one `toFixed(0)` fps
 * number. That number could not be compared with the game's, because the
 * game's is a 30-frame window that also says how much the frame JITTERS and
 * shouts when a dt of 0 has inflated it (see perfHud.ts). A harness exists to
 * measure; measuring it with a second, weaker instrument is how the two drift
 * apart. So the harness gets the real one, and the frame clock with it.
 */
import { createPerfHud, type PerfHud } from './perfHud';

export interface HarnessHud {
  /** the real perf HUD, for anything beyond the two calls below */
  hud: PerfHud;
  /**
   * Call FIRST in the animation loop. Feeds the frame ring and returns this
   * frame's dt in SECONDS, which is what a harness steps its rig with — one
   * clock, so the number on screen is the number the harness ran at.
   */
  frame(): number;
  /** facts to show under the timings; null clears them */
  setNotes(lines: readonly string[] | null): void;
  dispose(): void;
}

export function createHarnessHud(parent: HTMLElement = document.body): HarnessHud {
  const hud = createPerfHud(parent);
  let last = performance.now();
  return {
    hud,
    frame(): number {
      const now = performance.now();
      const ms = now - last;
      last = now;
      hud.frame(ms);
      return ms / 1000;
    },
    setNotes(lines: readonly string[] | null): void {
      hud.setNotes(lines);
    },
    dispose(): void {
      hud.dispose();
    },
  };
}
