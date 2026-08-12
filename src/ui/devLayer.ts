/**
 * Dev-layer visibility channel (§I ui/cinematic).
 *
 * The debug shell (Tweakpane + perf HUD) lives in src/debug and the game UI
 * lives here, and neither should import the other: the UI must stay free of
 * Tweakpane, and the panel must not need the menu to exist. So the debug shell
 * REGISTERS itself with this one-value channel — the same shape as the
 * graphics feature sinks — and the view-mode controller writes to it. No
 * main.ts wiring, no import cycle, and order does not matter: a sink attached
 * later immediately receives the current state.
 */

export type DevLayerSink = (visible: boolean) => void;

let sink: DevLayerSink | null = null;
let visible = true;

/** src/debug calls this; returns a detach function */
export function setDevLayerSink(fn: DevLayerSink): () => void {
  sink = fn;
  fn(visible); // catch up, whichever side was built first
  return () => {
    if (sink === fn) sink = null;
  };
}

export function applyDevLayer(next: boolean): void {
  visible = next;
  sink?.(next);
}

export function devLayerVisible(): boolean {
  return visible;
}

/** true when a debug shell is actually listening — false in tests/prod builds */
export function devLayerAttached(): boolean {
  return sink !== null;
}

/** test helper — drop the sink and reset to the default visible state */
export function resetDevLayer(): void {
  sink = null;
  visible = true;
}
