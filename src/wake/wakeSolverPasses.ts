/**
 * eWave on the GPU — the TSL twin of `WakeSolverCpu` (§T W1,
 * docs/wake/wake-research.md §2.4). Visual-only until W4 (V8a).
 *
 * ONE STEP = one splat render pass + ONE compute group (V-W7):
 *
 *   splat   render   HydroSample instances → head RenderTarget (rgba16f, additive):
 *                    .r = total head h_P, .g = its deep-bin part (§T W2a depth bins)
 *   pack    1        state(ζ, φ, old bins) [+ integer scroll], new bins → centred spectra
 *   forward 2·log2N  ocean `buildFftPasses` with the CONJUGATED butterfly table
 *   evolve  1        ζ̂ += Σ e^(−|k|d)(ĥ_new − ĥ_old), exact rotation, 1/N², spectral ∇ζ
 *   inverse 2·log2N  ocean `buildFftPasses` with the ocean's own table
 *   post    1        un-centre, sponge, η_vis = ζ (±3 m at source), keep new bins, outputs
 *
 * 256² → 1 + 8+8 + 1 + 8+8 + 1 = 35 dispatches, submitted as ONE
 * `renderer.compute([...])` array: one compute pass, one encoder
 * (three `Renderer.compute` → `backend.beginCompute(list)`). The frame is
 * CPU-bound; 35 separate `compute()` calls would be 35 passes.
 *
 * OUTPUTS (not wired anywhere in W1 — W2 resamples them in flowfoam):
 *   `heightTexture` rgba16f  .r = η_vis (m)       — `elevTexture` layout
 *   `slopeTexture`  rgba16f  .ba = ∂η_vis/∂x, ∂z  — `foamTexture.ba` layout
 *   `stateTexture`  rgba32f  (ζ, φ, h_bin0, h_bin1) — solver state + exact readback
 *
 * ONE EXPRESSION (§V77) — what is SHARED vs TRANSLITERATED:
 *   shared (CPU functions evaluated once, uploaded):
 *     - per-mode ω = `dispersion(|k|)`, √(|k|/g), √(g/|k|), DC mask → `modeTexture`
 *     - signed wavenumber per axis (`modeWavenumber`, Nyquist → 0 for ∇) and
 *       sponge γ per axis (`spongeGammaAxis`) → `axisTexture`
 *     - per-instance σ_eff (`splatSigma`), peak head (`splatPeakHead`), deep-bin
 *       weight (`splatBinWeight`) and the bin depths (`WakeSourceBuffer.depthBins`)
 *     - the butterfly tables (`wakeButterflyTables` → ocean `generateButterfly`)
 *   transliterated (pinned by the browser CPU↔GPU comparison, preview.ts):
 *     - the rotation lines and e^(−|k|d) (`sourceDepthAttenuation`) in `evolve` ↔ `WakeSolverCpu.step`
 *     - the Gaussian falloff in the splat fragment ↔ `splatFalloff`
 *     - (−1)^(x+y) centring, e^(−γΔt) sponge, the ±3 m / ±1 clamps
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  cos,
  exp,
  float,
  instanceIndex,
  instancedBufferAttribute,
  int,
  ivec2,
  positionGeometry,
  select,
  sin,
  textureLoad,
  textureStore,
  uniform,
  varying,
  vec2,
  vec4,
} from 'three/tsl';
import { buildFftPasses } from '../ocean/fftPasses';
import { createDataTexture, createSpectrumTexture } from '../ocean/oceanTextures';
import { GRAVITY, dispersion } from '../ocean/oceanMath';
import {
  WAKE_ETA_CLAMP,
  WAKE_MAX_DT,
  WAKE_MAX_SAMPLES,
  WAKE_SAMPLE_STRIDE,
  WAKE_SLOPE_CLAMP,
  WAKE_SPLAT_RADIUS_SIGMAS,
  WAKE_TEX_CHANNEL,
  defaultSponge,
  modeWavenumber,
  spongeGammaAxis,
  splatBinWeight,
  splatPeakHead,
  spongeAdvectionScale,
  splatSigma,
  wakeButterflyTables,
  type WakeSourceBuffer,
  type WakeSpongeParams,
} from './wakeSolverMath';

/** any TSL node — the graph is structural, not typed */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNode = any;

export interface WakeSolverGpuOptions {
  /** grid resolution, power of two (default 256 — doc §2.4 default tier) */
  n?: number;
  /** texel size in metres (default 0.5) */
  texel?: number;
  sponge?: WakeSpongeParams;
}

/** compute dispatches per step for grid n — asserted by tests (V-W7) */
export function wakeDispatchCount(n: number): number {
  return 3 + 4 * Math.log2(n);
}

function storageTexture16(n: number, name: string): THREE.StorageTexture {
  const t = new THREE.StorageTexture(n, n);
  t.type = THREE.HalfFloatType; // rgba16float: filterable AND storable (accumulation.ts precedent)
  t.format = THREE.RGBAFormat;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.name = name;
  return t;
}

export class WakeSolverGpu {
  readonly n: number;
  readonly texel: number;
  readonly domain: number;
  readonly sponge: WakeSpongeParams;
  centerX = 0;
  centerZ = 0;

  readonly heightTexture: THREE.StorageTexture;
  readonly slopeTexture: THREE.StorageTexture;
  readonly stateTexture: THREE.StorageTexture;
  /** pressure head h_P, drawn by the splat pass */
  readonly headTarget: THREE.RenderTarget;
  /** the ONE compute group, in order */
  readonly computeNodes: AnyNode[];
  /** samples uploaded by the last `setSources` */
  sampleCount = 0;

  private readonly spec: THREE.StorageTexture[];
  private readonly modeTexture: THREE.DataTexture;
  private readonly axisTexture: THREE.DataTexture;
  private readonly forwardTexture: THREE.DataTexture;
  private readonly inverseTexture: THREE.DataTexture;
  private readonly uDt = uniform(0);
  /** bin depths of the head being splatted now, and of the head the state holds */
  private readonly uD0 = uniform(0);
  private readonly uD1 = uniform(0);
  private readonly uD0Old = uniform(0);
  private readonly uD1Old = uniform(0);
  /** per-axis sponge γ scale for the domain's own motion (§T.180, `spongeAdvectionScale`) */
  private readonly uSpongeScaleX = uniform(1);
  private readonly uSpongeScaleZ = uniform(1);
  private readonly uShiftX = uniform(0, 'int');
  private readonly uShiftZ = uniform(0, 'int');
  private pendingShiftX = 0;
  private pendingShiftZ = 0;

  private readonly splatScene = new THREE.Scene();
  private readonly splatCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly splatGeometry: THREE.InstancedBufferGeometry;
  private readonly splatMaterial: THREE.NodeMaterial;
  private readonly instanceData: Float32Array;
  private readonly instanceAttr: THREE.InstancedBufferAttribute;
  /** per instance: share of the peak in the deep bin */
  private readonly binData: Float32Array;
  private readonly binAttr: THREE.InstancedBufferAttribute;
  /** per instance: 1 for a JET source (§T.180 c), splatted into the head target's .b too */
  private readonly jetData: Float32Array;
  private readonly jetAttr: THREE.InstancedBufferAttribute;
  private readonly clearTmp = new THREE.Color();

  constructor(opts: WakeSolverGpuOptions = {}) {
    const n = opts.n ?? 256;
    const texel = opts.texel ?? 0.5;
    if (!Number.isInteger(Math.log2(n)) || n < 8) throw new Error(`wake: n must be a power of two ≥ 8, got ${n}`);
    this.n = n;
    this.texel = texel;
    this.domain = n * texel;
    this.sponge = opts.sponge ?? defaultSponge(n, texel);

    // --- shared-expression tables (§V77) --------------------------------
    const mode = new Float32Array(n * n * 4);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = Math.hypot(modeWavenumber(i, n, this.domain), modeWavenumber(j, n, this.domain));
        const o = (j * n + i) * 4;
        const live = k > 0;
        mode[o] = dispersion(k);
        mode[o + 1] = live ? Math.sqrt(k / GRAVITY) : 0;
        mode[o + 2] = live ? Math.sqrt(GRAVITY / k) : 0;
        mode[o + 3] = live ? 1 : 0;
      }
    }
    this.modeTexture = createDataTexture(mode, n, n);
    const axis = new Float32Array(n * 4);
    for (let m = 0; m < n; m++) {
      axis[m * 4] = m === 0 ? 0 : modeWavenumber(m, n, this.domain); // Nyquist has no signed k
      axis[m * 4 + 1] = spongeGammaAxis(m, n, this.sponge);
    }
    this.axisTexture = createDataTexture(axis, n, 1);
    const tables = wakeButterflyTables(n);
    const stages = Math.log2(n);
    this.forwardTexture = createDataTexture(tables.forward, n, stages);
    this.inverseTexture = createDataTexture(tables.inverse, n, stages);

    // --- textures -------------------------------------------------------
    this.spec = [0, 1, 2, 3].map(() => createSpectrumTexture(n));
    this.stateTexture = createSpectrumTexture(n);
    this.stateTexture.name = 'wake/state';
    this.heightTexture = storageTexture16(n, 'wake/height');
    this.slopeTexture = storageTexture16(n, 'wake/slope');
    this.headTarget = new THREE.RenderTarget(n, n, { depthBuffer: false, type: THREE.HalfFloatType });
    this.headTarget.texture.name = 'wake/head';
    this.headTarget.texture.minFilter = THREE.NearestFilter; // textureLoad only: no sampler (V40)
    this.headTarget.texture.magFilter = THREE.NearestFilter;
    this.headTarget.texture.generateMipmaps = false;

    // --- splat pass -----------------------------------------------------
    this.instanceData = new Float32Array(WAKE_MAX_SAMPLES * 4);
    this.instanceAttr = new THREE.InstancedBufferAttribute(this.instanceData, 4);
    this.instanceAttr.setUsage(THREE.DynamicDrawUsage);
    this.binData = new Float32Array(WAKE_MAX_SAMPLES);
    this.binAttr = new THREE.InstancedBufferAttribute(this.binData, 1);
    this.binAttr.setUsage(THREE.DynamicDrawUsage);
    this.jetData = new Float32Array(WAKE_MAX_SAMPLES);
    this.jetAttr = new THREE.InstancedBufferAttribute(this.jetData, 1);
    this.jetAttr.setUsage(THREE.DynamicDrawUsage);
    const quad = new THREE.PlaneGeometry(2, 2);
    this.splatGeometry = new THREE.InstancedBufferGeometry();
    this.splatGeometry.setIndex(quad.getIndex());
    this.splatGeometry.setAttribute('position', quad.getAttribute('position'));
    this.splatGeometry.instanceCount = 0; // §B5: dead instances are never drawn at all
    quad.dispose();
    this.splatMaterial = this.buildSplatMaterial();
    const mesh = new THREE.Mesh(this.splatGeometry, this.splatMaterial);
    mesh.frustumCulled = false;
    this.splatScene.add(mesh);

    // --- the compute group ---------------------------------------------
    const [s0a, s0b, s1a, s1b] = this.spec;
    const nodes: AnyNode[] = [this.buildPack(s0a, s1a)];
    const fwd = buildFftPasses(this.forwardTexture, { ping: s0a, pong: s0b }, { ping: s1a, pong: s1b }, n);
    nodes.push(...fwd.passes);
    const fwdOut0 = fwd.finalIndex === 0 ? s0a : s0b;
    const fwdOut1 = fwd.finalIndex === 0 ? s1a : s1b;
    const evoOut0 = fwd.finalIndex === 0 ? s0b : s0a;
    const evoOut1 = fwd.finalIndex === 0 ? s1b : s1a;
    nodes.push(this.buildEvolve(fwdOut0, fwdOut1, evoOut0, evoOut1));
    const inv = buildFftPasses(this.inverseTexture, { ping: evoOut0, pong: fwdOut0 }, { ping: evoOut1, pong: fwdOut1 }, n);
    nodes.push(...inv.passes);
    const invOut0 = inv.finalIndex === 0 ? evoOut0 : fwdOut0;
    const invOut1 = inv.finalIndex === 0 ? evoOut1 : fwdOut1;
    nodes.push(this.buildPost(invOut0, invOut1));
    this.computeNodes = nodes;
    if (nodes.length !== wakeDispatchCount(n)) {
      throw new Error(`wake: built ${nodes.length} dispatches, expected ${wakeDispatchCount(n)}`);
    }
  }

  /** Re-origin on whole texels (V-W5). The scroll is applied by the next step's pack pass. */
  setCenter(x: number, z: number): { sx: number; sz: number } {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return { sx: 0, sz: 0 };
    const sx = Math.round((x - this.centerX) / this.texel);
    const sz = Math.round((z - this.centerZ) / this.texel);
    this.centerX += sx * this.texel;
    this.centerZ += sz * this.texel;
    // a full-domain jump is a reset; clamp so the int uniform stays small
    this.pendingShiftX = Math.max(-this.n, Math.min(this.n, this.pendingShiftX + sx));
    this.pendingShiftZ = Math.max(-this.n, Math.min(this.n, this.pendingShiftZ + sz));
    return { sx, sz };
  }

  /** the domain's own velocity (m/s, world x/z) — scales the sponge per axis (↔ WakeSolverCpu.setDomainVelocity) */
  setDomainVelocity(vx: number, vz: number): void {
    this.uSpongeScaleX.value = spongeAdvectionScale(Number.isFinite(vx) ? vx : 0, this.n, this.texel);
    this.uSpongeScaleZ.value = spongeAdvectionScale(Number.isFinite(vz) ? vz : 0, this.n, this.texel);
  }

  /**
   * Upload the sources relative to the CURRENT centre (call after `setCenter`).
   * Samples are already finite and fy ≥ 0 by `WakeSourceBuffer`; σ_eff and
   * the peak head are the CPU functions, so only the falloff is transliterated.
   */
  setSources(src: WakeSourceBuffer): void {
    const { n, texel } = this;
    const { d0, d1 } = src.depthBins();
    this.uD0.value = d0;
    this.uD1.value = d1;
    let live = 0;
    const lists = [[src.data, src.count, 0], [src.jetData, src.jetCount, 1]] as const;
    for (const [data, count, jet] of lists) {
      for (let s = 0; s < count && live < WAKE_MAX_SAMPLES; s++) {
        const o = s * WAKE_SAMPLE_STRIDE;
        const sigma = splatSigma(data[o + 3], texel, n);
        const peak = splatPeakHead(data[o + 2], sigma);
        if (peak === 0 || !Number.isFinite(peak)) continue;
        const q = live * 4;
        this.instanceData[q] = (data[o] - this.centerX) / texel + n / 2;
        this.instanceData[q + 1] = (data[o + 1] - this.centerZ) / texel + n / 2;
        this.instanceData[q + 2] = sigma / texel;
        this.instanceData[q + 3] = peak;
        this.binData[live] = splatBinWeight(data[o + 4], d0, d1);
        this.jetData[live] = jet;
        live++;
      }
    }
    this.sampleCount = live;
    this.splatGeometry.instanceCount = live;
    this.instanceAttr.clearUpdateRanges();
    this.instanceAttr.addUpdateRange(0, Math.max(live, 1) * 4);
    this.instanceAttr.needsUpdate = true;
    this.binAttr.clearUpdateRanges();
    this.binAttr.addUpdateRange(0, Math.max(live, 1));
    this.binAttr.needsUpdate = true;
    this.jetAttr.clearUpdateRanges();
    this.jetAttr.addUpdateRange(0, Math.max(live, 1));
    this.jetAttr.needsUpdate = true;
  }

  /**
   * BOOT WARM-UP (§T W2b): build every pipeline `step` will need so none
   * compiles mid-play — the splat material against the head target's format,
   * and the whole compute group, which `computeAsync` runs once. That run is
   * inert: Δt is 0 (the rotation is the identity, the sponge factor 1) and no
   * sources were uploaded, so a fresh state stays at rest. Call from the boot
   * shader-compile list (core/bootCompile.ts). The render target is swapped only around the
   * synchronous part of `compileAsync` (the same rule as bootCompile.ts).
   */
  compileAsync(renderer: THREE.WebGPURenderer): Promise<unknown> {
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.headTarget);
    const splat = renderer.compileAsync(this.splatScene, this.splatCamera);
    renderer.setRenderTarget(prev);
    return Promise.all([splat, renderer.computeAsync(this.computeNodes)]);
  }

  /**
   * §T.180 defect 4: clear the head target INSIDE the splat's own render pass
   * (autoClear, loadOp clear) rather than with a separate `renderer.clear()`,
   * which in three r180 is its own command encoder and `queue.submit`. Kept
   * switchable so the pond can A/B it in one session (`__wakePond`).
   */
  mergeClear = true;
  /** when true, `step` records its CPU phases (ms) into `lastStepCpu` — the pond's encode breakdown */
  profile = false;
  readonly lastStepCpu = { splat: 0, compute: 0 };

  /** splat + one compute group. Δt is finite-guarded and clamped to [0, WAKE_MAX_DT] (V28). */
  step(renderer: THREE.WebGPURenderer, dtIn: number): void {
    const dt = Number.isFinite(dtIn) ? Math.min(Math.max(dtIn, 0), WAKE_MAX_DT) : 0;
    const t0 = this.profile ? performance.now() : 0;
    const prevTarget = renderer.getRenderTarget();
    // runtime getClearColor only target.copy()s, so a plain Color works (clouds/index.ts precedent)
    renderer.getClearColor(this.clearTmp as Parameters<typeof renderer.getClearColor>[0]);
    const prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0); // the RT clear uses the renderer's colour — never the app sky
    renderer.setRenderTarget(this.headTarget);
    if (this.mergeClear) {
      const prevAuto = renderer.autoClear;
      const prevAutoColor = renderer.autoClearColor;
      renderer.autoClear = true;
      renderer.autoClearColor = true;
      renderer.render(this.splatScene, this.splatCamera);
      renderer.autoClear = prevAuto;
      renderer.autoClearColor = prevAutoColor;
    } else {
      renderer.clear(true, false, false);
      renderer.render(this.splatScene, this.splatCamera);
    }
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(this.clearTmp, prevAlpha);
    const t1 = this.profile ? performance.now() : 0;

    this.uDt.value = dt;
    this.uShiftX.value = this.pendingShiftX;
    this.uShiftZ.value = this.pendingShiftZ;
    renderer.compute(this.computeNodes);
    this.pendingShiftX = 0;
    this.pendingShiftZ = 0;
    // the head just splatted is now the head the state holds (post stored its bins)
    this.uD0Old.value = this.uD0.value;
    this.uD1Old.value = this.uD1.value;
    if (this.profile) {
      this.lastStepCpu.splat = t1 - t0;
      this.lastStepCpu.compute = performance.now() - t1;
    }
  }

  dispose(): void {
    for (const node of this.computeNodes) node.dispose?.();
    for (const t of this.spec) t.dispose();
    this.stateTexture.dispose();
    this.heightTexture.dispose();
    this.slopeTexture.dispose();
    this.headTarget.dispose();
    this.modeTexture.dispose();
    this.axisTexture.dispose();
    this.forwardTexture.dispose();
    this.inverseTexture.dispose();
    this.splatGeometry.dispose();
    this.splatMaterial.dispose();
  }

  // -------------------------------------------------------------------------

  private buildSplatMaterial(): THREE.NodeMaterial {
    const n = this.n;
    const inst = instancedBufferAttribute(this.instanceAttr) as AnyNode; // (u, v, σ texels, peak m)
    const corner = positionGeometry.xy;
    const offset = corner.mul(inst.z.mul(WAKE_SPLAT_RADIUS_SIGMAS)); // texels
    const pix = inst.xy.add(offset);
    // texel i/row j centre → framebuffer pixel centre (i+0.5, j+0.5); WebGPU NDC y is up, row 0 is top
    const ndc = vec2(pix.x.add(0.5).div(n).mul(2).sub(1), float(1).sub(pix.y.add(0.5).div(n).mul(2)));
    const m = new THREE.NodeMaterial();
    m.vertexNode = vec4(ndc, 0, 1);
    const vOffset = varying(offset, 'vWakeOffset') as AnyNode;
    const vSigma = varying(inst.z, 'vWakeSigma') as AnyNode;
    const vPeak = varying(inst.w, 'vWakePeak') as AnyNode;
    const vDeep = varying(instancedBufferAttribute(this.binAttr) as AnyNode, 'vWakeDeep') as AnyNode;
    const vJet = varying(instancedBufferAttribute(this.jetAttr) as AnyNode, 'vWakeJet') as AnyNode;
    // ↔ splatFalloff: peak·e^(−r²/2σ²), r and σ both in texels. σ ≥ √2 texels by splatSigma (V28).
    const r2 = vOffset.dot(vOffset);
    const h = vPeak.mul(exp(r2.negate().div(vSigma.mul(vSigma).mul(2)))).toVar();
    // ↔ WakeSolverCpu.splat: head += h, head1 += h·deep, headJet += h·jet
    m.fragmentNode = vec4(h, h.mul(vDeep), h.mul(vJet), 0);
    m.blending = THREE.CustomBlending;
    m.blendEquation = THREE.AddEquation;
    m.blendSrc = THREE.OneFactor;
    m.blendDst = THREE.OneFactor;
    m.blendEquationAlpha = THREE.AddEquation;
    m.blendSrcAlpha = THREE.OneFactor;
    m.blendDstAlpha = THREE.OneFactor;
    m.depthTest = false;
    m.depthWrite = false;
    m.transparent = true;
    m.fog = false;
    m.toneMapped = false;
    m.side = THREE.DoubleSide;
    return m;
  }

  private coords(): { x: AnyNode; y: AnyNode; sign: AnyNode } {
    const x = int(instanceIndex.mod(this.n)).toVar();
    const y = int(instanceIndex.div(this.n)).toVar();
    // (−1)^(x+y): centres k-space on the grid (unpackPass precedent)
    const sign = float(1).sub(float(x.add(y).bitAnd(int(1))).mul(2)).toVar();
    return { x, y, sign };
  }

  private buildPack(out0: THREE.StorageTexture, out1: THREE.StorageTexture): AnyNode {
    const n = this.n;
    const kernel = Fn(() => {
      const { x, y, sign } = this.coords();
      const sx = x.add(this.uShiftX).toVar();
      const sy = y.add(this.uShiftZ).toVar();
      const inside = sx.greaterThanEqual(0).and(sx.lessThan(n)).and(sy.greaterThanEqual(0)).and(sy.lessThan(n));
      const keep = select(inside, float(1), float(0)).mul(sign);
      const st = textureLoad(this.stateTexture, ivec2(sx.clamp(0, n - 1), sy.clamp(0, n - 1))).toVar();
      const h = textureLoad(this.headTarget.texture, ivec2(x, y)).toVar(); // (total, deep part)
      textureStore(out0, ivec2(x, y), vec4(st.x.mul(keep), 0, st.y.mul(keep), 0)).toWriteOnly();
      // two complex fields: new bins h0 + i·h1, old bins (scrolled with the state) h0 + i·h1
      textureStore(
        out1,
        ivec2(x, y),
        vec4(h.x.sub(h.y).mul(sign), h.y.mul(sign), st.z.mul(keep), st.w.mul(keep)),
      ).toWriteOnly();
    });
    return (kernel() as AnyNode).compute(n * n);
  }

  private buildEvolve(
    in0: THREE.StorageTexture,
    in1: THREE.StorageTexture,
    out0: THREE.StorageTexture,
    out1: THREE.StorageTexture,
  ): AnyNode {
    const n = this.n;
    const invN2 = 1 / (n * n);
    const kernel = Fn(() => {
      const { x, y } = this.coords();
      const coord = ivec2(x, y);
      const f = textureLoad(in0, coord).mul(invN2).toVar(); // (ζ̂re, ζ̂im, φ̂re, φ̂im)
      const h = textureLoad(in1, coord).mul(invN2 * 0.5).toVar(); // (H_new, H_old) packed bins, ½ of the separation
      // mirrored mode −k (the conj F₋ of the bin separation) — same index rule as the CPU
      const mirror = ivec2(int(n).sub(x).mod(n), int(n).sub(y).mod(n));
      const hm = textureLoad(in1, mirror).mul(invN2 * 0.5).toVar();
      const mode = textureLoad(this.modeTexture, coord).toVar(); // (ω, √(k/g), √(g/k), live)
      // |k| = (√(k/g))²·g; ↔ sourceDepthAttenuation e^(−|k|d)
      const kMag = mode.y.mul(mode.y).mul(GRAVITY).toVar();
      const a0 = exp(kMag.mul(this.uD0).negate());
      const a1 = exp(kMag.mul(this.uD1).negate());
      const b0 = exp(kMag.mul(this.uD0Old).negate());
      const b1 = exp(kMag.mul(this.uD1Old).negate());
      // ĥ0 = (H + conj H₋)/2, ĥ1 = (H − conj H₋)/2i, for H_new (xy) and H_old (zw)
      const dr = a0.mul(h.x.add(hm.x)).add(a1.mul(h.y.add(hm.y))).sub(b0.mul(h.z.add(hm.z))).sub(b1.mul(h.w.add(hm.w)));
      const di = a0.mul(h.y.sub(hm.y)).add(a1.mul(hm.x.sub(h.x))).sub(b0.mul(h.w.sub(hm.w))).sub(b1.mul(hm.z.sub(h.z)));
      const kx = textureLoad(this.axisTexture, ivec2(x, 0)).x;
      const kz = textureLoad(this.axisTexture, ivec2(y, 0)).x;
      const wdt = mode.x.mul(this.uDt);
      const c = cos(wdt).toVar();
      const s = sin(wdt).toVar();
      const ka = mode.y.mul(s);
      const kb = mode.z.mul(s);
      // ↔ WakeSolverCpu.step evolve: ζ = ζ̂ + Δĥ'; ζ' = ζc + √(k/g)s·φ̂; φ̂' = φ̂c − √(g/k)s·ζ
      const zr = f.x.add(dr).toVar();
      const zi = f.y.add(di).toVar();
      // DC (mode.w = 0): ζ̂' = 0, φ̂' = 0 — the open-sea level (see WakeSolverCpu header)
      const nzr = zr.mul(c).add(ka.mul(f.z)).mul(mode.w).toVar();
      const nzi = zi.mul(c).add(ka.mul(f.w)).mul(mode.w).toVar();
      const pr = f.z.mul(c).sub(kb.mul(zr)).mul(mode.w);
      const pi = f.w.mul(c).sub(kb.mul(zi)).mul(mode.w);
      textureStore(out0, coord, vec4(nzr, nzi, pr, pi)).toWriteOnly();
      // spectral ∇ζ': i·kx·ζ̂', i·kz·ζ̂'
      textureStore(out1, coord, vec4(kx.negate().mul(nzi), kx.mul(nzr), kz.negate().mul(nzi), kz.mul(nzr))).toWriteOnly();
    });
    return (kernel() as AnyNode).compute(n * n);
  }

  private buildPost(in0: THREE.StorageTexture, in1: THREE.StorageTexture): AnyNode {
    const n = this.n;
    const kernel = Fn(() => {
      const { x, y, sign } = this.coords();
      const coord = ivec2(x, y);
      const a = textureLoad(in0, coord).mul(sign).toVar();
      const g = textureLoad(in1, coord).mul(sign).toVar();
      // per-axis γ, each scaled for the domain's own motion along that axis (↔ WakeSolverCpu spongeAxisX/Z)
      const gamma = textureLoad(this.axisTexture, ivec2(x, 0))
        .y.mul(this.uSpongeScaleX)
        .add(textureLoad(this.axisTexture, ivec2(y, 0)).y.mul(this.uSpongeScaleZ));
      const damp = exp(gamma.negate().mul(this.uDt)).toVar(); // ≤ 1 since γ ≥ 0, Δt ≥ 0
      const zeta = a.x.mul(damp).toVar();
      const phi = a.z.mul(damp);
      const h = textureLoad(this.headTarget.texture, coord).toVar();
      // §V44 bounded at source — the CPU surface mirrors the clamp
      const vis = zeta.clamp(-WAKE_ETA_CLAMP, WAKE_ETA_CLAMP).toVar();
      // the new bins become the head the state holds (world-anchored: the next pack scrolls them)
      textureStore(this.stateTexture, coord, vec4(zeta, phi, h.x.sub(h.y), h.y)).toWriteOnly();
      // channel indices are WAKE_TEX_CHANNEL's — the flowfoam resample reads by the same table
      const heightOut: AnyNode[] = [float(0), float(0), float(0), float(1)];
      heightOut[WAKE_TEX_CHANNEL.HEIGHT] = vis;
      textureStore(this.heightTexture, coord, vec4(...heightOut)).toWriteOnly();
      const slopeOut: AnyNode[] = [float(0), float(0), float(0), float(0)];
      slopeOut[WAKE_TEX_CHANNEL.SLOPE_DX] = g.x.clamp(-WAKE_SLOPE_CLAMP, WAKE_SLOPE_CLAMP);
      slopeOut[WAKE_TEX_CHANNEL.SLOPE_DZ] = g.z.clamp(-WAKE_SLOPE_CLAMP, WAKE_SLOPE_CLAMP);
      textureStore(this.slopeTexture, coord, vec4(...slopeOut)).toWriteOnly();
    });
    return (kernel() as AnyNode).compute(n * n);
  }
}
