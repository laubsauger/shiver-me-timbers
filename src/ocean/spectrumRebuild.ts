/**
 * AMORTISED SPECTRUM REBUILD (§B.51) — the one scheduler both the GPU
 * simulation and the CPU buoyancy mirror take their spectrum from.
 *
 * THE DEFECT. A sea-state change cost ONE TICK OF 515 ms: the GPU-side
 * `OceanSimulation` rebuild (407 ms) and the §V.8 `CpuOcean` mirror rebuild
 * (108 ms) fired on the SAME tick by design — they shared an identical
 * arm-at-15 countdown — so their costs ADDED. A weather preset transition
 * fired it sixteen times: 8140 ms of main-thread stall over a 4 s lerp.
 * `ddd2d77` fused six N² passes into one (378 → 103 ms, bit-identical) and got
 * the transition to 2221 ms with a worst tick of 222 ms. Better. Still a
 * stutter, which is what the user actually reports.
 *
 * TWO CURES, BOTH HERE, AND THEY ARE NOT THE SAME KIND OF FIX.
 *
 * (1) DELETE THE DUPLICATE, because removing work beats amortising it. The
 *     mirror was re-deriving numbers the GPU side had just computed from the
 *     same inputs on the same tick: `totalJacobianRms` re-ran
 *     `spectralJacobianRms` at full 512² for all THREE cascades (67.7 ms on
 *     cascade 2 alone), `MirrorCascade` re-ran `generateH0` and
 *     `spectralMeanWavenumber` as two more full-res passes per mirrored
 *     cascade. Measured: seven 512² passes, 126 ms, every number of which the
 *     GPU's three fused passes already contained. ONE scheduler publishes ONE
 *     snapshot and both sides read it, so the mirror's rebuild cost falls to a
 *     64² block extraction — under a millisecond.
 *
 * (2) AMORTISE THE REST by row slices (`SpectrumBuild`). Bit-identity is what
 *     makes this shippable and it is a property of the PARTITION, not of the
 *     slice count: any contiguous ascending row ranges with the `Rng` carried
 *     across give the same bits (see `SpectrumBuild`'s own docstring).
 *
 * (1) IS ALSO WHAT MAKES §V.8 PROVABLE, and that is the reason to prefer it
 * over two independent sliced builds. The mirror is what buoyancy floats on.
 * If the GPU swapped on frame N and the mirror on frame N+3, the ship would
 * float on a different sea from the one drawn — §B.34's failure, which cost
 * four separate user reports in one day. With one scheduler there is ONE
 * snapshot object and both sides key on its IDENTITY, so "they swap
 * atomically" is not a scheduling argument that has to be re-checked every
 * time either side is touched; it is the same pointer.
 *
 * DOUBLE BUFFER. `current` is the last COMPLETE snapshot and is what both
 * sides are using; the in-flight build writes into its own fresh arrays and is
 * unreachable until it finishes. A half-rebuilt spectrum can never be drawn or
 * floated on, and `SpectrumBuild.result()` throws rather than hand one out.
 *
 * PARAMS ARE FROZEN AT BUILD START, and this is a hazard the amortisation
 * introduces that the single-tick rebuild did not have. A preset lerp moves
 * `windSpeed` and `amplitude` EVERY tick; a build that read the live params
 * would give slice 0 an 11 m/s spectrum and slice 23 an 18 m/s one, i.e. a sea
 * that is not any sea state at all and whose moments describe none of its
 * texels. The snapshot therefore carries the exact `OceanParams` it was built
 * from, and every consumer that needs a band, a domain or a resolution to
 * interpret it reads THOSE, not the live singleton.
 */
import { oceanParams, type OceanParams } from '../params/ocean';
import {
  cascadeBand,
  SpectrumBuild,
  type SpectrumData,
} from './oceanMath';

/** §V.19 floor: three independent bands. Also the derivatives array's depth. */
export const CASCADE_COUNT = 3;

/**
 * Ticks between "a spectrum param moved" and "start rebuilding".
 *
 * RATE LIMIT, NOT A QUIET-DETECTOR. Re-arming on every changed tick makes a
 * CONTINUOUSLY-changing input starve the countdown forever — it never reaches
 * 0, so the sea never rebuilds at all. §V.46 drives windSpeed and amplitude
 * off the storm field at the ship's own position, so a ship under way changes
 * the signature EVERY TICK. Arming once and letting it run down gives a
 * rebuild on a fixed cadence on a moving input, and still coalesces a slider
 * drag into one rebuild after it stops.
 */
export const REBUILD_ARM_TICKS = 15;

/**
 * Row slices for phase A of the build (the spectrum + moment loops).
 *
 * THE TRADE, stated because there is no free choice here: settle time is
 * total_cost / per_tick_budget whatever the schedule, so the only thing a
 * slice count buys is WHERE the cost lands. Measured headless at the shipped
 * 512² × 3 cascades — phase A ≈ 135 ms (17 / 18 / 100 for cascades 0 / 1 / 2),
 * phase B ≈ 7 ms:
 *
 *     slices    worst tick    settle
 *          8       17.0 ms    0.17 s
 *         16        8.5 ms    0.30 s
 *         24        5.6 ms    0.43 s      <- shipped
 *         32        4.2 ms    0.57 s
 *
 * 24 because the frame is CPU-BOUND: encode is 19–24 ms against a GPU 6–10 ms,
 * so a slice lands on the scarce side and 5.6 ms is about a third of a 60 Hz
 * frame. 8 slices is NOT enough — 17 ms is a whole frame, which is a dropped
 * frame every tick for 10 ticks, i.e. the stutter in miniature.
 *
 * The 0.43 s is paid as the sea TAKING LONGER TO BECOME the new state. During
 * a 4 s weather-preset lerp that is 11% of the transition and invisible. On a
 * single rung click it is a sea that eases into its new state over a quarter
 * of a second, which reads as a transition rather than as lag — but it IS
 * visible if someone drags the wind slider and watches for the snap.
 *
 * ALL cascades advance by the same row range on the same step, rather than one
 * cascade at a time. Same total settle either way, but the slices come out
 * EVEN: cascade 2 is 100 ms of the 135 and stepping the cascades sequentially
 * makes its slices 5× the cost of cascade 0's, so the worst tick is set by the
 * worst cascade instead of by the average. Measured, the prototype's
 * sequential 8-slices-per-cascade was 11.6 ms worst over 24 ticks; the same 24
 * ticks interleaved is 5.6 ms.
 */
export const SPECTRUM_REBUILD_SLICES = 24;

/**
 * Row slices for phase B (packing h0's RGBA texels with their −k mirror).
 * Phase B is ≈ 7 ms of the ≈ 142 ms total, so 2 slices puts it at 3.5 ms —
 * under phase A's 5.6 ms, which is what keeps the worst tick set by phase A.
 */
export const SPECTRUM_REBUILD_PACK_SLICES = 2;

/** total `advance` calls a rebuild takes, once it starts */
export const SPECTRUM_REBUILD_STEPS =
  SPECTRUM_REBUILD_SLICES + SPECTRUM_REBUILD_PACK_SLICES;

/**
 * A COMPLETE spectrum for every cascade, plus the whole-sea moments that are
 * quadrature sums over the bands. Immutable and replaced wholesale on a swap,
 * so consumers can — and do — detect a rebuild by object identity alone.
 */
export interface SpectrumSnapshot {
  /**
   * The params this spectrum was BUILT FROM, frozen at build start. Read the
   * band, the domain and the resolution from here, never from the live
   * singleton: an amortised build spans ticks and a preset lerp moves the
   * singleton on every one of them.
   */
  readonly params: OceanParams;
  readonly cascades: readonly SpectrumData[];
  /** √m₀ of the whole sea (m) — Hs = 4× this */
  readonly heightRms: number;
  /** RMS ∂Dx/∂x summed over cascades, at choppiness 1 */
  readonly steepnessRms: number;
  /** RMS Jacobian trace summed over cascades, at choppiness 1 (§V.59) */
  readonly jacobianRms: number;
}

/** params whose change requires h0 regeneration (vs live uniforms) */
/**
 * EVERY param `waveSpectrum` reads. Omitting one is §B.7 verbatim — the GPU
 * keeps the launch-time h0 while the panel and the weather presets move the
 * number, silently, and the CPU buoyancy mirror then floats ships on a
 * different ocean than the one drawn (§V.8). tests/ocean.test.ts pins the list
 * against `OceanParams` so the NEXT spectrum param cannot be forgotten either.
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

/**
 * The spectrum params, detached from the live singleton. Only the fields
 * `waveSpectrum` and the cascade geometry read need to survive — but copying
 * the whole object costs nothing and means a param added to the signature
 * cannot be silently left aliasing the live one.
 */
function freezeSpectrumParams(p: OceanParams): OceanParams {
  return {
    ...p,
    cascades: p.cascades.map((c) => ({ ...c })) as OceanParams['cascades'],
    splitWavelengths: [...p.splitWavelengths] as [number, number],
  };
}

/** bands are independent, so their variances add (quadrature on the RMS) */
function aggregate(params: OceanParams, cascades: SpectrumData[]): SpectrumSnapshot {
  let heightVariance = 0;
  let steepnessVariance = 0;
  let jacobianVariance = 0;
  for (const c of cascades) {
    heightVariance += c.heightVariance;
    steepnessVariance += c.steepnessRms * c.steepnessRms;
    jacobianVariance += c.jacobianRms * c.jacobianRms;
  }
  return {
    params,
    cascades,
    heightRms: Math.sqrt(Math.max(1e-6, heightVariance)),
    steepnessRms: Math.sqrt(Math.max(0, steepnessVariance)),
    jacobianRms: Math.sqrt(Math.max(0, jacobianVariance)),
  };
}

export class SpectrumScheduler {
  /** the last COMPLETE spectrum — the double buffer's front */
  private snapshot: SpectrumSnapshot;
  /** the back buffer: one resumable build per cascade, or null when idle */
  private build: SpectrumBuild[] | null = null;
  private buildParams: OceanParams | null = null;
  private signature: string;
  private countdown = -1;
  /** step index within the in-flight build — see `advance` */
  private step = 0;
  private readonly seed: number;
  private readonly cascadeCount: number;

  constructor(
    seed: number,
    p: OceanParams = oceanParams,
    cascadeCount: number = CASCADE_COUNT,
  ) {
    this.seed = seed;
    this.cascadeCount = cascadeCount;
    this.signature = spectrumSignature(p);
    // the launch spectrum is synchronous by necessity: there is no previous
    // buffer to keep showing, and nothing can be drawn or floated on until it
    // exists. It is also the one rebuild that is not competing with a frame.
    const params = freezeSpectrumParams(p);
    this.snapshot = aggregate(params, this.buildAll(params).map((b) => b.finish()));
  }

  /** the spectrum every consumer is currently on — never a partial one */
  get current(): SpectrumSnapshot {
    return this.snapshot;
  }

  /** true while a rebuild is in flight (the old spectrum is still live) */
  get building(): boolean {
    return this.build !== null;
  }

  /** 0..1 through the in-flight build; 1 when idle */
  get progress(): number {
    if (!this.build) return 1;
    let acc = 0;
    for (const b of this.build) acc += b.progress;
    return acc / this.build.length;
  }

  private buildAll(params: OceanParams): SpectrumBuild[] {
    const out: SpectrumBuild[] = [];
    for (let i = 0; i < this.cascadeCount; i++) {
      out.push(
        new SpectrumBuild(
          params.resolution,
          params.cascades[i].domain,
          // seed offset per cascade → uncorrelated gaussians across cascades
          this.seed + i * 7919,
          params,
          cascadeBand(i, params.splitWavelengths),
        ),
      );
    }
    return out;
  }

  /**
   * One tick of the rebuild state machine. Call EXACTLY ONCE PER SIM TICK, and
   * from ONE place: the schedule is what keeps the drawn sea and the floated
   * sea on the same spectrum, so a second caller would silently double the
   * slice rate for one side of §V.8.
   *
   * Returns true on the tick a NEW snapshot was published — the swap.
   */
  advance(p: OceanParams = oceanParams): boolean {
    const sig = spectrumSignature(p);
    if (sig !== this.signature) {
      this.signature = sig;
      if (this.countdown < 0) this.countdown = REBUILD_ARM_TICKS;
    }
    if (this.build) {
      // THE COUNTDOWN IS FROZEN WHILE A BUILD IS IN FLIGHT. A rebuild already
      // under way IS the reaction to the change, so re-arming behind it would
      // start a second build the tick the first lands — more total work for a
      // spectrum nobody saw. Under a continuous lerp this makes the cadence
      // arm + build (15 + 26 ticks) instead of arm alone, which is fewer
      // rebuilds of the same amortised cost.
      const N = (this.buildParams as OceanParams).resolution;
      const j = this.step++;
      // ROW TARGETS, so the step COUNT is exactly SLICES + PACK_SLICES for any
      // resolution — see SpectrumBuild.runTo. Both sides of the §V.8 pair take
      // their schedule from this one loop, but the mirror's 64² grid and the
      // GPU's 512² one would otherwise settle on different ticks in any
      // configuration where the mirror ran its own build.
      const spectrumRow =
        j < SPECTRUM_REBUILD_SLICES
          ? Math.floor(((j + 1) * N) / SPECTRUM_REBUILD_SLICES)
          : N;
      const packRow =
        j < SPECTRUM_REBUILD_SLICES
          ? 0
          : Math.floor(((j + 1 - SPECTRUM_REBUILD_SLICES) * N) / SPECTRUM_REBUILD_PACK_SLICES);
      let allDone = true;
      for (const b of this.build) {
        if (!b.runTo(spectrumRow, packRow)) allDone = false;
      }
      if (!allDone) return false;
      // THE SWAP, and it is one statement: until this line every consumer is
      // still reading the old spectrum, after it every consumer reads the new
      // one. There is no window in which a partial build is reachable.
      this.snapshot = aggregate(
        this.buildParams as OceanParams,
        this.build.map((b) => b.result()),
      );
      this.build = null;
      this.buildParams = null;
      return true;
    }
    if (this.countdown >= 0 && this.countdown-- === 0) {
      // The signature is updated on every change, so what gets built is the
      // LATEST spectrum, not the one that armed the counter.
      this.buildParams = freezeSpectrumParams(p);
      this.build = this.buildAll(this.buildParams);
      this.step = 0;
    }
    return false;
  }
}
