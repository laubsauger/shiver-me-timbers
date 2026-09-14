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
import { sRGBTransferEOTF, sRGBTransferOETF, texture, uniform, vec4 } from 'three/tsl';

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

/**
 * SUPERSAMPLED CAPTURE (`samples`, the offline anti-aliasing). The post pipeline renders its scene pass with
 * `samples: 0` whenever a stage reads depth (DOF, refraction — core/postPipeline.ts), so a captured frame has no
 * anti-aliasing at all: the antenna, the rails, the hull edges and the far shoreline crawl, and a 4K master does not
 * fix a crawl. The recorder therefore draws each output frame `samples` times with the world frozen and the
 * projection shifted by a sub-pixel Halton offset (recorder.ts), and this class sums the subframes and resolves the
 * mean: a jittered box filter over one pixel, the same every frame, so a thin line is stable instead of shimmering.
 *
 * WHERE THE COLOUR GOES. Each subframe is drawn into a half-float target with NO colour space — the post chain's own
 * output transform (renderOutput: ACES + sRGB) is already in the pixels, so the GPU must not encode it again. The
 * subframes are averaged in LINEAR light (decoded, summed, divided, re-encoded) — averaging display values darkens
 * every anti-aliased edge — and the mean is written to a plain `rgba8unorm` target, so the bytes that reach the sink
 * are exactly the display-encoded picture.
 *
 * The single-sample path below it (`samples` undefined) is the original capture, kept byte-for-byte for the pirate
 * piece. Its `SRGBColorSpace` 8-bit target is an `rgba8unorm-srgb` texture on WebGPU (WebGPUTextureUtils), i.e. the
 * GPU sRGB-encodes a picture the post chain has already encoded — see docs/cine/speedboat-trailer-v1.md §Look for the
 * side-by-side that measured it.
 */
class Accumulator {
  readonly sub: THREE.RenderTarget;
  private readonly sum: THREE.RenderTarget;
  readonly out: THREE.RenderTarget;
  private readonly add: THREE.QuadMesh;
  private readonly resolveQuad: THREE.QuadMesh;
  private readonly count = uniform(1);
  private readonly clear = new THREE.Color();

  constructor(
    private renderer: THREE.WebGPURenderer,
    width: number,
    height: number,
  ) {
    const float = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, colorSpace: THREE.NoColorSpace, samples: 0 };
    this.sub = new THREE.RenderTarget(width, height, { ...float, depthBuffer: true });
    this.sum = new THREE.RenderTarget(width, height, { ...float, depthBuffer: false });
    this.out = new THREE.RenderTarget(width, height, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
      depthBuffer: false,
      samples: 0,
    });
    const add = new THREE.NodeMaterial();
    add.fragmentNode = vec4(sRGBTransferEOTF(texture(this.sub.texture).rgb), 1);
    add.blending = THREE.AdditiveBlending;
    add.transparent = true;
    add.depthTest = false;
    add.depthWrite = false;
    this.add = new THREE.QuadMesh(add);
    const resolve = new THREE.NodeMaterial();
    resolve.fragmentNode = vec4(sRGBTransferOETF(texture(this.sum.texture).rgb.div(this.count)), 1);
    resolve.depthTest = false;
    resolve.depthWrite = false;
    this.resolveQuad = new THREE.QuadMesh(resolve);
  }

  /** add the subframe just drawn into `sub` to the running sum; `first` starts a new frame */
  accumulate(first: boolean): void {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    const autoClear = r.autoClear;
    r.setRenderTarget(this.sum);
    if (first) {
      r.getClearColor(this.clear as Parameters<THREE.WebGPURenderer["getClearColor"]>[0]);
      const alpha = r.getClearAlpha();
      r.setClearColor(0x000000, 0);
      r.clear(true, false, false);
      r.setClearColor(this.clear, alpha);
    }
    r.autoClear = false;
    this.add.render(r);
    r.autoClear = autoClear;
    r.setRenderTarget(prev);
  }

  /** the mean of `n` subframes, re-encoded, into `out` */
  resolve(n: number): void {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    this.count.value = Math.max(1, n);
    r.setRenderTarget(this.out);
    this.resolveQuad.render(r);
    r.setRenderTarget(prev);
  }

  dispose(): void {
    this.sub.dispose();
    this.sum.dispose();
    this.out.dispose();
    (this.add.material as THREE.Material).dispose();
    (this.resolveQuad.material as THREE.Material).dispose();
  }
}

export class Capture {
  private target: THREE.RenderTarget | null = null;
  private prev: THREE.RenderTarget | null = null;
  private packed: Uint8Array | null = null;
  /** one accumulator per LOOK (recorder.ts `looks`): the looks of one subframe are summed side by side */
  private accs: Accumulator[] = [];

  /** `samples` set = the supersampled path (Accumulator); undefined = the original single-sample capture */
  constructor(
    private renderer: THREE.WebGPURenderer,
    public width: number,
    public height: number,
    readonly samples?: number,
  ) {}

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.target?.dispose();
    this.target = null;
    for (const a of this.accs) a.dispose();
    this.accs = [];
    this.packed = null;
  }

  /** add the subframe just drawn (look `look`) to that look's sum (supersampled path only) */
  accumulate(first: boolean, look = 0): void {
    this.accs[look]?.accumulate(first);
  }

  /** resolve the mean of `n` subframes of look `look` into the target `grab(look)` reads (supersampled path only) */
  resolve(n: number, look = 0): void {
    this.accs[look]?.resolve(n);
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
  bind(look = 0): void {
    this.bumpNodeFrame();
    if (this.samples !== undefined) {
      while (this.accs.length <= look) this.accs.push(new Accumulator(this.renderer, this.width, this.height));
      this.prev = this.renderer.getRenderTarget();
      this.renderer.setRenderTarget((this.accs[look] as Accumulator).sub);
      return;
    }
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
  async grab(look = 0): Promise<Uint8Array> {
    const t = this.samples !== undefined ? (this.accs[look]?.out ?? null) : this.target;
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
    for (const a of this.accs) a.dispose();
    this.accs = [];
    this.packed = null;
  }
}
