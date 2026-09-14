/**
 * Frame capture: renderer -> raw RGBA, and nothing else in the browser.
 *
 * TWO THINGS WERE TRIED FIRST AND BOTH FAILED IN A BACKGROUNDED TAB, which is
 * the state any render longer than a coffee break will spend most of its life
 * in:
 *
 *  - `canvas.toDataURL()`. The browser will not composite a hidden tab's
 *    WebGPU surface, so every frame comes back as whatever was on screen when
 *    the window lost focus. Measured: 173 rAF callbacks, the lens moved 400 m,
 *    three reads byte-identical.
 *  - Encoding the PNG here, via `OffscreenCanvas.convertToBlob`. The encode is
 *    a task the browser is free to deprioritise, and in a hidden tab at
 *    1920x1080 it simply stops: "convertToBlob did not finish in 20000ms".
 *
 * So this reads the pixels itself and hands the bytes straight out. The PNG is
 * written by node (scripts/cine-sink.mjs), which nothing throttles.
 *
 * Two readback traps, both from docs/agent-browser-harness.md §2:
 *  - The buffer is 256-byte ROW PADDED and comes back un-stripped; a width
 *    that is not a multiple of 64 is diagonally striped without the unpad.
 *  - Rows are top-down already. "Flip because GL is bottom-up" put the sky
 *    along the bottom of every frame of the first full take.
 *
 * The target is allocated ONCE per size, not per frame. Per-frame allocation
 * was a guess at the doc's "a reused target returns its first frame forever";
 * the real cause of that was the node-frame id (see `bumpNodeFrame`), and the
 * churn of building and disposing a 1080p target every frame was itself
 * producing `Invalid BindGroup` errors out of the WebGPU backend.
 */
import * as THREE from 'three/webgpu';

async function stage<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`cine: ${what} did not finish in ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, guard]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class Capture {
  private target: THREE.RenderTarget | null = null;
  private prev: THREE.RenderTarget | null = null;
  private packed: Uint8Array | null = null;

  constructor(
    private renderer: THREE.WebGPURenderer,
    public width: number,
    public height: number,
  ) {}

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.target?.dispose();
    this.target = null;
    this.packed = null;
  }

  /**
   * Force the node graph to treat the coming draw as a NEW frame.
   *
   * `PassNode` and `BloomNode` are `NodeUpdateType.FRAME` and skip their work
   * on an unchanged `frameId`, and that id is bumped from three's own
   * `Animation` rAF — which this app never starts, because it drives its own
   * loop. The consequence is the one docs/agent-browser-harness.md §3 records:
   * `post.render()` re-composites a STALE scene texture while looking like a
   * fresh frame. This is not a theory — the same capture loop was measured
   * giving three DIFFERENT frames through `renderer.render()` and three
   * IDENTICAL ones through `post.render()`, and this call is the difference.
   */
  private bumpNodeFrame(): void {
    const nodes = (this.renderer as unknown as { _nodes?: { nodeFrame?: { update?: () => void } } })
      ._nodes;
    nodes?.nodeFrame?.update?.();
  }

  /** point the next render at our own target instead of the canvas */
  bind(): void {
    this.bumpNodeFrame();
    if (this.target === null) {
      this.target = new THREE.RenderTarget(this.width, this.height, {
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        colorSpace: THREE.SRGBColorSpace,
        depthBuffer: true,
        samples: 0,
      });
    }
    this.prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.target);
  }

  /** hand the canvas back. Always paired with bind, including on the error path. */
  unbind(): void {
    this.renderer.setRenderTarget(this.prev);
    this.prev = null;
  }

  /** tightly packed, top-down RGBA — ready to POST as-is */
  async grab(): Promise<Uint8Array> {
    const t = this.target;
    if (t === null) throw new Error('cine: grab() without bind()');
    const w = this.width;
    const h = this.height;
    const raw = (await stage(
      this.renderer.readRenderTargetPixelsAsync(t, 0, 0, w, h) as Promise<unknown>,
      30000,
      'readRenderTargetPixelsAsync',
    )) as Uint8Array;

    const row = w * 4;
    const stride = Math.ceil(row / 256) * 256;
    if (stride === row && raw.length === row * h) return raw;
    if (this.packed === null) this.packed = new Uint8Array(row * h);
    for (let y = 0; y < h; y++) {
      this.packed.set(raw.subarray(y * stride, y * stride + row), y * row);
    }
    return this.packed;
  }

  dispose(): void {
    this.target?.dispose();
    this.target = null;
    this.packed = null;
  }
}
