/**
 * Cascade orchestration (§V.4, §V.19): three independent FFT simulations
 * at different world domains, band-split so no wavelength is counted twice.
 * Each frame: spectrum evolve → 2·log2(N) butterfly passes → unpack.
 */
import * as THREE from 'three/webgpu';
import { oceanParams, type OceanParams } from '../params/ocean';
import { cascadeBand, generateButterfly, generateH0 } from './oceanMath';
import { createDataTexture, createOutputTexture, createSpectrumTexture } from './oceanTextures';
import { buildSpectrumPass } from './spectrumPass';
import { buildFftPasses } from './fftPasses';
import { buildUnpackPass } from './unpackPass';

export class OceanCascade {
  readonly domain: number;
  readonly displacement: THREE.StorageTexture;
  readonly derivatives: THREE.StorageTexture;

  private h0Texture: THREE.DataTexture;
  private passes: unknown[] = [];
  private timeUniform!: { value: number };
  private choppinessUniform!: { value: number };
  private readonly index: number;
  private readonly seed: number;

  constructor(index: number, seed: number, butterfly: THREE.DataTexture, p: OceanParams) {
    this.index = index;
    this.seed = seed;
    this.domain = p.cascades[index].domain;
    const n = p.resolution;

    this.h0Texture = createDataTexture(this.generateSpectrumData(p), n, n);
    this.displacement = createOutputTexture(n);
    this.derivatives = createOutputTexture(n);

    const spec0 = { ping: createSpectrumTexture(n), pong: createSpectrumTexture(n) };
    const spec1 = { ping: createSpectrumTexture(n), pong: createSpectrumTexture(n) };

    const spectrum = buildSpectrumPass(this.h0Texture, spec0.ping, spec1.ping, n, this.domain);
    const fft = buildFftPasses(butterfly, spec0, spec1, n);
    const finalSpec0 = fft.finalIndex === 0 ? spec0.ping : spec0.pong;
    const finalSpec1 = fft.finalIndex === 0 ? spec1.ping : spec1.pong;
    const unpack = buildUnpackPass(finalSpec0, finalSpec1, this.displacement, this.derivatives, n);

    this.timeUniform = spectrum.timeUniform;
    this.choppinessUniform = unpack.choppinessUniform;
    this.passes = [spectrum.computeNode, ...fft.passes, unpack.computeNode];
  }

  private generateSpectrumData(p: OceanParams): Float32Array {
    const band = cascadeBand(this.index, p.splitWavelengths);
    // seed offset per cascade → uncorrelated gaussians across cascades
    return generateH0(p.resolution, this.domain, this.seed + this.index * 7919, p, band);
  }

  /** re-generate h0 after spectrum-shaping params change (live tweak) */
  rebuild(p: OceanParams): void {
    const data = this.generateSpectrumData(p);
    (this.h0Texture.image as { data: unknown }).data = data;
    this.h0Texture.needsUpdate = true;
  }

  update(renderer: THREE.WebGPURenderer, time: number, choppiness: number): void {
    this.timeUniform.value = time;
    this.choppinessUniform.value = choppiness;
    for (const pass of this.passes) {
      renderer.compute(pass as Parameters<THREE.WebGPURenderer['compute']>[0]);
    }
  }
}

/** params whose change requires h0 regeneration (vs live uniforms) */
function spectrumSignature(p: OceanParams): string {
  return [
    p.resolution, p.amplitude, p.windSpeed, p.windDirection,
    p.directionality, p.oppositeWaveDamp, p.smallWaveCutoff,
    p.splitWavelengths, p.cascades.map((c) => c.domain),
  ].join('|');
}

export class OceanSimulation {
  readonly cascades: OceanCascade[];
  private signature: string;
  private rebuildCountdown = -1;

  constructor(seed: number, p: OceanParams = oceanParams) {
    const butterfly = createDataTexture(
      generateButterfly(p.resolution),
      p.resolution,
      Math.log2(p.resolution),
    );
    this.cascades = [0, 1, 2].map((i) => new OceanCascade(i, seed, butterfly, p));
    this.signature = spectrumSignature(p);
  }

  /** call once per rendered frame with sim time (§V.2: time from SimState) */
  update(renderer: THREE.WebGPURenderer, time: number, p: OceanParams = oceanParams): void {
    const sig = spectrumSignature(p);
    if (sig !== this.signature) {
      this.signature = sig;
      this.rebuildCountdown = 15; // debounce slider drags (~250ms)
    }
    if (this.rebuildCountdown >= 0 && this.rebuildCountdown-- === 0) {
      for (const c of this.cascades) c.rebuild(p);
    }
    for (const c of this.cascades) c.update(renderer, time, p.choppiness);
  }
}
