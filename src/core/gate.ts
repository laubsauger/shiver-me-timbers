/**
 * WebGPU availability gate (§V.1).
 * No WebGPU → static info page, no exceptions, no fallback path.
 */

/**
 * `waitMs` (opt-in, The Drift's render nodes): while the browser has WebGPU but no adapter yet, ask again every
 * 0.5 s for up to this long. On Linux, headless Chrome's GPU process brings Vulkan up about 2 s after launch, and an
 * adapter asked for before that is null: linux-monster's RTX 4090 came back as no adapter at +0.3 s and as
 * nvidia/lovelace at +2.4 s (2026-10-30), and the page showed its "requires WebGPU" gate on a box that has the GPU.
 * Default 0: the game's pages answer at once, as before.
 */
export async function webgpuAvailable(waitMs = 0): Promise<boolean> {
  if (!('gpu' in navigator)) return false;
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      if ((await navigator.gpu.requestAdapter()) !== null) return true;
    } catch {
      return false;
    }
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

export function renderGatePage(root: HTMLElement): void {
  root.innerHTML = `
    <div style="
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      height:100%;color:#cfe8f0;font-family:Georgia,serif;text-align:center;gap:1rem;
      background:radial-gradient(ellipse at 50% 40%, #123243 0%, #0a1a24 70%);
    ">
      <h1 style="margin:0;font-size:2.2rem;">⚓ Shiver Me Timbers</h1>
      <p style="max-width:34rem;line-height:1.5;margin:0 1rem;">
        This experience requires <strong>WebGPU</strong>, which your browser
        does not support. Try the latest Chrome, Edge, or Safari on a desktop
        machine.
      </p>
    </div>`;
}
