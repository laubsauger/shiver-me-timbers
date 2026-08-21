/**
 * Boot splash hooks, shared by every entry (§V95).
 *
 * The splash lives in the HTML (`index.html`, `raft.html`) and talks to the
 * boot through two window hooks: `__bootProgress(label)` while the world is
 * built and `__bootReady()` once a real frame has been presented. Both entries
 * had their own untyped `window as unknown as { __bootProgress?… }` cast; the
 * cast is the contract, so it is written down once, here.
 *
 * Everything below the hooks is COSMETIC and bounded accordingly — a boot must
 * never be able to hang on a courtesy to a human watching.
 */

interface SplashHooks {
  __bootProgress?: (phase: string) => void;
  __bootReady?: () => void;
}

const hooks = (): SplashHooks => window as unknown as SplashHooks;

/** name the phase on the splash; a page without a splash simply has no hook */
export function bootProgress(label: string): void {
  hooks().__bootProgress?.(label);
}

/** dismiss the splash — called only after a frame has actually been presented */
export function bootReady(): void {
  hooks().__bootReady?.();
}

/**
 * Bound a COSMETIC wait so it can never gate boot (§V.39, §B.21).
 *
 * Everything the presentation layer offers to wait on — `requestAnimationFrame`
 * and the Web Animations `finished` promise alike — is driven by the frame
 * clock, and Chrome STOPS that clock in a hidden tab. Measured on this page:
 * 3037ms of wall clock, 0 rAF callbacks, animation `currentTime` still 0 with
 * `playState: 'running'`. A promise from that clock does not resolve late in a
 * background tab, it resolves NEVER — and every automated verification of this
 * project runs in exactly that tab.
 *
 * So: race the pretty thing against a real timer, and swallow its rejection.
 * `setTimeout` keeps running when hidden; that is the whole reason it is here
 * and not another rAF.
 */
export function atMost(work: Promise<unknown>, ms: number): Promise<void> {
  return Promise.race([
    // a cancelled animation REJECTS (AbortError) — cosmetics must not throw
    // into the boot chain, so the rejection is absorbed here.
    work.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, ms);
    }),
  ]);
}

/** two frames at 60Hz plus slack; a hidden tab pays this once per phase */
const PAINT_DEADLINE_MS = 120;
/** last letter lands at ~1.71s (888ms delay + 820ms); slack for a slow load */
const ENTRANCE_DEADLINE_MS = 2500;

export const afterSplashPaint = (): Promise<void> => {
  // a hidden tab paints nothing and fires no rAF, so there is no paint to wait
  // for — skip rather than pay the deadline once per boot phase.
  if (document.visibilityState === 'hidden') return Promise.resolve();
  return atMost(
    new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }),
    PAINT_DEADLINE_MS,
  );
};

/** name the phase AND give the splash a paint opportunity to show it */
export async function showBootPhase(label: string): Promise<void> {
  bootProgress(label);
  await afterSplashPaint();
}

/**
 * Let the splash title complete its entrance before scene construction takes
 * the main thread. CSS animation time keeps advancing during a long task, but
 * its intermediate frames cannot be painted; starting the build immediately
 * therefore left the title visibly stranded halfway through the word.
 *
 * This waits on the real final-letter animation rather than duplicating its
 * duration here. Two animation frames after `finished` are intentional: rAF
 * callbacks run before paint, so the first frame commits the final style and
 * the second proves that final style has actually had a paint opportunity.
 *
 * Every wait in here is a COURTESY to a human watching, and is bounded
 * accordingly (see `atMost`). Nothing cosmetic may throw either: a missing
 * splash element means the entrance cannot be watched, which is worth a
 * warning and nothing more — it is not worth the whole application.
 */
export async function finishSplashTitleEntrance(): Promise<void> {
  // nobody is watching a hidden tab, and its frame clock is stopped anyway
  if (document.visibilityState === 'hidden') return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const letters = document.querySelectorAll<HTMLElement>('.boot-splash__letter');
  const lastLetter = letters.item(letters.length - 1);
  if (!lastLetter) {
    console.warn('[boot] no splash title letters — skipping the entrance wait');
    return;
  }

  const entrance = lastLetter
    .getAnimations()
    .find(
      (animation) =>
        animation instanceof CSSAnimation && animation.animationName === 'boot-letter-rise',
    );
  if (!entrance) {
    console.warn('[boot] no splash title entrance animation — skipping the wait');
    return;
  }

  await atMost(entrance.finished, ENTRANCE_DEADLINE_MS);
  await afterSplashPaint();
}
