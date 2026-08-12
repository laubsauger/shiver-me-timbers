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
  slopeResolutionFootprint,
  slopeWavelengthHistogram,
  SLOPE_BIN_COUNT,
  spectralJacobianRms,
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
  /**
   * RMS of the Jacobian TRACE (∂Dx/∂x + ∂Dz/∂z, transfer |k|) — the moment the
   * foam gate and the §V.58 λ− fold metric are actually built on. Published
   * rather than converted from `steepnessRms` by a constant: the ratio between
   * the two is fixed by the spectrum's DIRECTIONAL SHAPE, and with the swell
   * train the sea now carries two very different shapes at once. Measured, the
   * baked 1.79 held to 1% for every wind-sea band and was 2.65× off in a
   * swell-dominated one (§B, and §B.12's lesson again: publish the moment, do
   * not fit a constant to it).
   */
  jacobianRms = 0;
  /** elevation variance of this cascade's band (m²) — sea-state scale */
  heightVariance = 0;
  /** slope variance binned by wavelength — see `slopeFootprint` */
  private slopeBins: Float64Array<ArrayBufferLike> = new Float64Array(SLOPE_BIN_COUNT);
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
    this.jacobianRms = spectralJacobianRms(p.resolution, this.domain, p, band);
    this.heightVariance = spectralHeightVariance(p.resolution, this.domain, p, band);
    this.slopeBins = slopeWavelengthHistogram(p.resolution, this.domain, p, band);
    // seed offset per cascade → uncorrelated gaussians across cascades
    return generateH0(p.resolution, this.domain, this.seed + this.index * 7919, p, band);
  }

  /**
   * Pixel footprint (m) at which `keep` of this band's SLOPE variance is still
   * resolvable — the quantity the fragment normal LOD fades against (§V.48).
   * Published as a method rather than two fields so the SHADING owns the keep
   * fractions it wants and the SIM owns only the measurement: the sim must not
   * import shading params to decide where a look ends.
   */
  slopeFootprint(keep: number): number {
    return slopeResolutionFootprint(this.slopeBins, keep);
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
/**
 * EVERY param `waveSpectrum` reads. Omitting one is §B.7 verbatim — the GPU
 * keeps the launch-time h0 while the panel and the weather presets move the
 * number, silently, and the CPU buoyancy mirror then floats ships on a
 * different ocean than the one drawn (§V.8). The swell block was missing here
 * for exactly as long as it took to write this comment, and the presets lerp
 * all three of its keys. tests/ocean.test.ts pins the list against
 * `OceanParams` so the NEXT spectrum param cannot be forgotten either.
 */
export const SPECTRUM_SIGNATURE_KEYS = [
  'resolution', 'amplitude', 'windSpeed', 'windDirection',
  'spreadPeak', 'spreadBelowPeak', 'spreadAbovePeak', 'spreadMin',
  'oppositeWaveDamp', 'smallWaveCutoff',
  'splitWavelengths', 'cascades',
  'swellPeriod', 'swellAmplitude', 'swellDirection',
  'swellDirectionality', 'swellBandwidth', 'swellGridModes',
] as const;

export function spectrumSignature(p: OceanParams): string {
  return [
    p.resolution, p.amplitude, p.windSpeed, p.windDirection,
    p.spreadPeak, p.spreadBelowPeak, p.spreadAbovePeak, p.spreadMin,
    p.oppositeWaveDamp, p.smallWaveCutoff,
    p.splitWavelengths, p.cascades.map((c) => c.domain),
    p.swellPeriod, p.swellAmplitude, p.swellDirection,
    p.swellDirectionality, p.swellBandwidth, p.swellGridModes,
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
  /** RMS Jacobian trace summed over cascades, at choppiness 1 — see the
   *  per-cascade field. Bands are independent, so variances add. */
  jacobianRms = 0;
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
    let jacobianVariance = 0;
    for (const c of this.cascades) {
      heightVariance += c.heightVariance;
      steepnessVariance += c.steepnessRms * c.steepnessRms;
      jacobianVariance += c.jacobianRms * c.jacobianRms;
    }
    this.heightRms = Math.sqrt(Math.max(1e-6, heightVariance));
    this.steepnessRms = Math.sqrt(Math.max(0, steepnessVariance));
    this.jacobianRms = Math.sqrt(Math.max(0, jacobianVariance));
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
    // §V.59: the fold cap reads the DIRECTION-FREE trace moment
    return effectiveChoppiness(p.choppiness, this.jacobianRms, p.choppinessFoldLimit);
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
