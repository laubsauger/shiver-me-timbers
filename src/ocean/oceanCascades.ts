/**
 * Cascade orchestration (§V.4, §V.19): three independent FFT simulations
 * at different world domains, band-split so no wavelength is counted twice.
 * Each frame: spectrum evolve → 2·log2(N) butterfly passes → unpack.
 */
import * as THREE from 'three/webgpu';
import { oceanParams, type OceanParams } from '../params/ocean';
import {
  effectiveChoppiness,
  generateButterfly,
  slopeResolutionFootprint,
  slopeVarianceTotal,
  SLOPE_BIN_COUNT,
  type SpectrumData,
} from './oceanMath';
import {
  CASCADE_COUNT,
  SpectrumScheduler,
  type SpectrumSnapshot,
} from './spectrumRebuild';
import {
  createDataTexture,
  createOutputArrayTexture,
  createOutputTexture,
  createSpectrumTexture,
  type CascadeLayer,
} from './oceanTextures';
import { buildSpectrumPass } from './spectrumPass';
import { buildFftPasses } from './fftPasses';
import { buildUnpackPass } from './unpackPass';

export class OceanCascade {
  readonly domain: number;
  readonly displacement: THREE.StorageTexture;
  /**
   * This cascade's LAYER of the simulation's shared derivatives array texture,
   * not a texture of its own (§V.40). All three cascades write and read one
   * `StorageArrayTexture`, which is one binding and — the part that was
   * actually scarce — ONE SAMPLER for all three instead of three of each.
   * Sample it through `sampleCascadeLayer`, never with a bare `texture()`.
   *
   * `displacement` above deliberately stays three separate 2D textures: it is
   * sampled in the VERTEX stage by `positionNode`, and three r180 cannot sample
   * a filterable array texture there at all (the layer index is dropped from
   * the emitted WGSL). See tests/oceanBindingBudget.test.ts.
   */
  readonly derivatives: CascadeLayer;

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
  /**
   * Energy-weighted mean wavenumber of this band (rad/m) — the ONE k that
   * stands for this cascade when something needs to ask "how long are these
   * waves", and the input `src/ocean/shoaling.ts` keys the per-cascade
   * attenuation on (a wave feels the bottom below d = λ/2, so shoaling is
   * wavelength-dependent and §V.19's band split is what makes per-cascade
   * behaviour possible at all).
   *
   * Published as a live MEASUREMENT for the same reason `jacobianRms` is:
   * cascade 0's mean wavelength moves 249 → 87 → 143 m across calm/swell/storm
   * as the wind sea and the swell train trade dominance inside its band, so a
   * baked per-cascade constant would be wrong on two of the three presets
   * (§B.12: publish the moment, do not fit a constant to it).
   */
  meanWavenumber = 0;
  /** slope variance binned by wavelength — see `slopeFootprint` */
  private slopeBins: Float64Array<ArrayBufferLike> = new Float64Array(SLOPE_BIN_COUNT);
  private h0Texture: THREE.DataTexture;
  private passes: unknown[] = [];
  private timeUniform!: { value: number };
  private choppinessUniform!: { value: number };

  constructor(
    index: number,
    _seed: number,
    butterfly: THREE.DataTexture,
    derivatives: THREE.StorageArrayTexture,
    p: OceanParams,
    initial: SpectrumData,
  ) {
    this.domain = p.cascades[index].domain;
    const n = p.resolution;

    this.h0Texture = createDataTexture(this.adopt(initial), n, n);
    this.displacement = createOutputTexture(n);
    // the array is owned by OceanSimulation; this cascade owns layer `index`
    this.derivatives = { texture: derivatives, layer: index };

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

  /**
   * Take a COMPLETE spectrum for this band and publish its moments.
   *
   * The cascade no longer computes its own: `SpectrumScheduler` owns the one
   * amortised, double-buffered build and the §V.8 CPU mirror reads the SAME
   * snapshot object, which is what makes "both sides swap atomically" a
   * pointer identity rather than a schedule that has to be re-argued every
   * time either side is touched (see spectrumRebuild.ts). The moments still
   * come off the same grid the spectrum does, so the anti-fold cap keeps
   * tracking every spectrum-shaping param automatically.
   */
  private adopt(data: SpectrumData): Float32Array {
    this.steepnessRms = data.steepnessRms;
    this.jacobianRms = data.jacobianRms;
    this.heightVariance = data.heightVariance;
    this.meanWavenumber = data.meanWavenumber;
    this.slopeBins = data.slopeBins;
    return data.h0;
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

  /**
   * Total slope variance of this band (σ², dimensionless) — what the fragment
   * normal LOD is scaling when it fades this cascade out, so the shading can
   * turn the part it deletes into roughness instead of dropping it (§V.48b).
   * Same measurement discipline as `slopeFootprint`: the sim publishes the
   * moment, the shading decides what to do with it.
   */
  slopeVariance(): number {
    return slopeVarianceTotal(this.slopeBins);
  }

  /**
   * Install a finished spectrum — THE SWAP.
   *
   * One statement, and until it runs the texture still holds the previous
   * complete h0: the amortised build writes into its own arrays and this is
   * the only line that makes them visible, so a half-rebuilt spectrum can
   * never be drawn (see spectrumRebuild.ts's double-buffer note).
   */
  install(data: SpectrumData): void {
    (this.h0Texture.image as { data: unknown }).data = this.adopt(data);
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

/**
 * The signature and its key list moved to `spectrumRebuild.ts` — the scheduler
 * that owns the rebuild owns the definition of "the spectrum changed". Kept
 * re-exported here because every existing consumer imports them from this
 * module and the split is an implementation detail, not a contract change.
 */
export {
  SPECTRUM_SIGNATURE_KEYS,
  spectrumSignature,
  SpectrumScheduler,
  SPECTRUM_REBUILD_SLICES,
  SPECTRUM_REBUILD_STEPS,
  REBUILD_ARM_TICKS,
  type SpectrumSnapshot,
} from './spectrumRebuild';

export class OceanSimulation {
  readonly cascades: OceanCascade[];
  /**
   * The shared derivatives array texture (§V.40) — one binding and one sampler
   * for all three cascades. Consumers normally reach it through
   * `cascade.derivatives` + `sampleCascadeLayer`; it is public so the ledger
   * has one owner to point at.
   */
  readonly derivatives: THREE.StorageArrayTexture;
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
  /**
   * THE ONE OWNER OF THE REBUILD — shared with the §V.8 CPU mirror.
   *
   * Public so `CpuOcean.setSpectrumScheduler` can be handed THIS object rather
   * than a second one built from the same seed. Two schedulers with identical
   * inputs would swap on the same tick today and would stop doing so the first
   * time either side's schedule was touched; one scheduler makes the mirror
   * and the drawn sea the same pointer, which is a property nobody can break
   * by editing one file (see spectrumRebuild.ts).
   */
  readonly spectrum: SpectrumScheduler;
  /** last snapshot installed into the cascade textures — swap detector */
  private adopted: SpectrumSnapshot;
  /** guards `advanceSpectrum` to exactly one step per rendered frame */
  private advancedThisFrame = false;

  constructor(seed: number, p: OceanParams = oceanParams) {
    const butterfly = createDataTexture(
      generateButterfly(p.resolution),
      p.resolution,
      Math.log2(p.resolution),
    );
    // ONE array texture, one layer per cascade — see OceanCascade.derivatives.
    // Allocated here rather than per cascade because the whole point is that
    // the three cascades share a single binding and a single sampler (§V.40).
    this.derivatives = createOutputArrayTexture(p.resolution, CASCADE_COUNT);
    this.spectrum = new SpectrumScheduler(seed, p, CASCADE_COUNT);
    this.adopted = this.spectrum.current;
    this.cascades = [0, 1, 2].map(
      (i) =>
        new OceanCascade(i, seed, butterfly, this.derivatives, p, this.adopted.cascades[i]),
    );
    this.refreshSeaState();
  }

  /**
   * Adopt the scheduler's whole-sea moments. They are computed once, on the
   * snapshot, so the mirror's fold cap and this one cannot disagree by
   * aggregating the same per-band numbers in two places (§V.8).
   */
  private refreshSeaState(): void {
    this.heightRms = this.adopted.heightRms;
    this.steepnessRms = this.adopted.steepnessRms;
    this.jacobianRms = this.adopted.jacobianRms;
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

  /**
   * ONE STEP of the amortised rebuild, and the swap if this is the step it
   * lands on. Idempotent within a frame.
   *
   * CALL THIS FROM THE SIM TICK, BEFORE `CpuOcean.update`, and that ordering is
   * the §V.8 contract rather than a preference. Both sides adopt the same
   * snapshot the moment it exists; whoever runs first must therefore be the
   * side that BOTH of them are downstream of. main.ts calls it immediately
   * before `cpuOcean.update(state.time)`, so the mirror picks the new spectrum
   * up on the same tick, before buoyancy runs — which is what the old
   * "identical arm-at-15 countdown on both sides" bought, kept exactly.
   *
   * If nobody calls it, `update` below calls it, so a caller that only renders
   * (tests, the headless suite) still gets a live spectrum. The flag is what
   * stops it being stepped twice on a frame that does both.
   */
  advanceSpectrum(p: OceanParams = oceanParams): void {
    // ALWAYS steps, and the dedupe lives in `update` instead. The other way
    // round — `advanceSpectrum` skipping when a flag is set, `update` clearing
    // it — freezes the scheduler FOREVER for any caller that steps the sim
    // without also rendering it, and freezing is silent: the sea simply never
    // rebuilds again (§B.7's symptom, §Rule 8). This way the worst a
    // mis-wiring can do is step the build twice in a frame, which settles the
    // sea sooner and cannot desynchronise the two sides, because both read the
    // same snapshot whenever it appears.
    this.advancedThisFrame = true;
    if (!this.spectrum.advance(p)) return;
    // THE SWAP. Until this line the textures still hold the previous complete
    // h0; after it they hold the new one. There is no reachable in-between.
    this.adopted = this.spectrum.current;
    for (let i = 0; i < this.cascades.length; i++) {
      this.cascades[i].install(this.adopted.cascades[i]);
    }
    this.refreshSeaState();
  }

  /** call once per rendered frame with sim time (§V.2: time from SimState) */
  update(renderer: THREE.WebGPURenderer, time: number, p: OceanParams = oceanParams): void {
    if (!this.advancedThisFrame) this.advanceSpectrum(p);
    this.advancedThisFrame = false;
    // anti-fold cap, NOT the raw slider: storm raises amplitude AND choppiness,
    // and the summed displacement gradient then passes −1 over ~1.5% of the
    // surface — the sheet turns inside out (faceted crests) and every folded
    // texel is a negative Jacobian, i.e. a foam trigger (§V6). Both user
    // symptoms, one cause. §V7 stays intact: presets still only touch params.
    const lambda = this.effectiveChoppiness(p);
    for (const c of this.cascades) c.update(renderer, time, lambda);
  }
}
