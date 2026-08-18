/**
 * Cascade-view key channel (§I ui/cinematic) — the same one-value channel shape
 * as `devLayer.ts`, and for the same reason: the instrument lives in src/debug
 * and needs three.js, the key owner lives here and must not.
 *
 * `src/ui/viewModes.ts` is the documented SINGLE OWNER of dev-layer keys
 * (research-poseidon §2.3: "the key must be registered through viewModes, do
 * not add a bare addEventListener"), so the reader stays there and only the
 * ACTION crosses this boundary. src/debug owns which field is on screen.
 *
 * THE SINK RETURNS A BOOLEAN ON PURPOSE. `1`/`2`/`3` and `[`/`]` mean nothing
 * while the view is off, and a key that silently swallows itself is §V.62's
 * whole family. An unconsumed action is reported back so `viewModes` can leave
 * `preventDefault` alone and the key stays available to whoever wants it next.
 */

export type CascadeViewAction =
  /** open the view, or close it and give the frame back to the game */
  | { type: 'toggle' }
  /** jump straight to a band — 0 is the 1010 m domain, 2 the 22.7 m one */
  | { type: 'cascade'; index: number }
  /** step through the field list (h, λD, ∇h, det J, λ⁻, foam) */
  | { type: 'stepField'; delta: number };

/** returns true if the view actually acted on it */
export type CascadeViewSink = (action: CascadeViewAction) => boolean;

let sink: CascadeViewSink | null = null;

/** src/debug calls this; returns a detach function */
export function setCascadeViewSink(fn: CascadeViewSink): () => void {
  sink = fn;
  return () => {
    if (sink === fn) sink = null;
  };
}

/** true when an instrument is actually listening — false in tests/prod builds */
export function cascadeViewAttached(): boolean {
  return sink !== null;
}

/** false when nothing is listening OR the listener declined the key */
export function emitCascadeView(action: CascadeViewAction): boolean {
  return sink?.(action) ?? false;
}

/** test helper — drop the sink */
export function resetCascadeViewSink(): void {
  sink = null;
}

/**
 * Physical-key map, pure so the binding is pinned by a test rather than by the
 * order of DOM handlers. `code` and not `key`, matching `input/controlMap.ts`.
 *
 * G is free: FreeCam swallows only W/A/S/D/R/F, X is the anchor, C the free
 * cam, H the helm, J the jump, B/V the combat arena, Space fires, the arrows
 * lay the guns. Digits and brackets are bound nowhere in `src/` at all.
 */
export function cascadeViewAction(code: string): CascadeViewAction | null {
  if (code === 'KeyG') return { type: 'toggle' };
  if (code === 'Digit1') return { type: 'cascade', index: 0 };
  if (code === 'Digit2') return { type: 'cascade', index: 1 };
  if (code === 'Digit3') return { type: 'cascade', index: 2 };
  if (code === 'BracketLeft') return { type: 'stepField', delta: -1 };
  if (code === 'BracketRight') return { type: 'stepField', delta: 1 };
  return null;
}
