/**
 * Cascade orchestration (§V.4, §V.19): three independent FFT simulations
 * at different world domains, band-split so no wavelength is counted twice.
 * Each frame: spectrum evolve → 2·log2(N) butterfly passes → unpack.
 */
import * as THREE from 'three/webgpu';
import { oceanParams, type OceanParams } from '../params/ocean';
import {
  cascadeBand,
  effectiveChoppiness,
  generateButterfly,
  generateH0,
  spectralHeightVariance,
  spectralSteepness,
} from './oceanMath';
import { createDataTexture, createOutputTexture, createSpectrumTexture } from './oceanTextures';
import { buildSpectrumPass } from './spectrumPass';
import { buildFftPasses } from './fftPasses';
import { buildUnpackPass } from './unpackPass';

export class OceanCascade {
  readonly domain: number;
  readonly displacement: THREE.StorageTexture;
  readonly derivatives: THREE.StorageTexture;

  /** RMS ∂Dx/∂x of this cascade's band — feeds the anti-fold choppiness cap */
  steepnessRms = 0;
  /** elevation variance of this cascade's band (m²) — sea-state scale */
  heightVariance = 0;
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
    // measured on the same grid the spectrum uses, so the cap tracks every
    // spectrum-shaping param (amplitude, wind, band split) automatically
    this.steepnessRms = spectralSteepness(p.resolution, this.domain, p, band);
    this.heightVariance = spectralHeightVariance(p.resolution, this.domain, p, band);
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
  /**
   * RMS surface elevation of the whole sea (m) — √m₀, the zeroth spectral
   * moment. Shading reads this so that "a crest" scales with the sea state
   * instead of being a magic metre value that silently changes meaning when
   * wind or amplitude move (§B).
   */
  heightRms = 0;
  /**
   * RMS of ∂Dx/∂x summed over cascades, at choppiness 1. The fold test is on
   * the SUMMED displacement gradient — cascades are independent, so their
   * variances add — which is why the cap is global and not per-cascade.
   */
  steepnessRms = 0;
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
    this.refreshSeaState();
  }

  /** bands are independent, so their variances add (quadrature on the RMS) */
  private refreshSeaState(): void {
    let heightVariance = 0;
    let steepnessVariance = 0;
    for (const c of this.cascades) {
      heightVariance += c.heightVariance;
      steepnessVariance += c.steepnessRms * c.steepnessRms;
    }
    this.heightRms = Math.sqrt(Math.max(1e-6, heightVariance));
    this.steepnessRms = Math.sqrt(Math.max(0, steepnessVariance));
  }

  /**
   * Significant wave height Hs = 4√m₀ (m) — the sea state as a mariner reads
   * it, live and always in step with the spectrum (rebuilt through the same
   * signature path as §B.7).
   *
   * THE normaliser for every "is this a crest" gate in the project. Absolute
   * metre thresholds silently change meaning on every spectrum, and amplitude
   * is NOT a substitute: the swell retune dropped amplitude 0.75 → 0.32 while
   * Hs ROSE 2.3 → 2.8 m, so the two move in opposite directions.
   */
  significantWaveHeight(): number {
    return 4 * this.heightRms;
  }

  /**
   * Choppiness actually sent to the GPU (§B storm fold). One value for all
   * cascades — see steepnessRms. Never raises the artist's setting; at the
   * shipped defaults it does not bite at all (calm/swell fold at ~10σ+), and
   * it only engages on seas that would genuinely self-intersect.
   */
  effectiveChoppiness(p: OceanParams = oceanParams): number {
    return effectiveChoppiness(p.choppiness, this.steepnessRms, p.choppinessFoldLimit);
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
      this.refreshSeaState();
    }
    // anti-fold cap, NOT the raw slider: storm raises amplitude AND choppiness,
    // and the summed displacement gradient then passes −1 over ~1.5% of the
    // surface — the sheet turns inside out (faceted crests) and every folded
    // texel is a negative Jacobian, i.e. a foam trigger (§V6). Both user
    // symptoms, one cause. §V7 stays intact: presets still only touch params.
    const lambda = this.effectiveChoppiness(p);
    for (const c of this.cascades) c.update(renderer, time, lambda);
  }
}
