/**
 * WebGPU availability gate (§V.1).
 * No WebGPU → static info page, no exceptions, no fallback path.
 */

export async function webgpuAvailable(): Promise<boolean> {
  if (!('gpu' in navigator)) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return adapter !== null;
  } catch {
    return false;
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
