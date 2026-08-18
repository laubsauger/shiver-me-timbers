/**
 * §V.8 sea-physics: the CPU spectrum mirror + buoyancy. These tests encode
 * WHY each mechanism exists: the mirror must reproduce the seeded GPU wave
 * math (or ships drift off the visible water), and the buoyancy integrator
 * must be stable and self-righting (or ships jitter, flip, or explode).
 */
import { describe, expect, it } from 'vitest';
import {
  cascadeBand,
  effectiveChoppiness,
  spectralJacobianRms,
  generateButterfly,
  naiveIDFT,
} from '../src/ocean/oceanMath';
import { weatherPresets } from '../src/weather/presets';
import { oceanParams, type OceanParams } from '../src/params/ocean';
import {
  seaPhysicsParams,
  type SeaPhysicsParams,
} from '../src/params/seaPhysics';
import {
  CpuOcean,
  cpuIFFT2D,
  extractCentralBlock,
  MIRRORED_CASCADES,
} from '../src/sea-physics/cpuOcean';
import {
  equilibriumDraft,
  probeStations,
  stepShipBuoyancy,
} from '../src/sea-physics/buoyancy';
import { quatFromAxisAngle, quatMul, rotateVec } from '../src/combat/quatMath';
import { createRng } from '../src/state/rng';
import { generateH0, swellWavelengthFor } from '../src/ocean/oceanMath';
import {
  REBUILD_ARM_TICKS,
  SPECTRUM_REBUILD_STEPS,
} from '../src/ocean/spectrumRebuild';
import type { ShipState, Vec3 } from '../src/state/simState';

const DT = 1 / 60;

/** small configs so tests run fast; bands still fit the mirror grid */
function testOceanParams(over: Partial<OceanParams> = {}): OceanParams {
  return { ...oceanParams, resolution: 128, ...over };
}

/**
 * A GENUINELY flat sea. `amplitude: 0` no longer means this: the ocean now
 * carries TWO independent wave trains (wind sea + swell, src/ocean/oceanMath
 * `waveSpectrum`), and `amplitude` scales only the first. A test that means
 * "no waves at all" has to say so about both, or it is silently running on a
 * 1.4 m swell — which is exactly how these four tests failed when the swell
 * landed, with a 0.106 m residual heave that read as a broken equilibrium.
 * Same shape as §V.52: one coefficient stopped describing the whole thing.
 */
function flatOceanParams(over: Partial<OceanParams> = {}): OceanParams {
  return testOceanParams({ amplitude: 0, swellAmplitude: 0, ...over });
}

function testSeaParams(over: Partial<SeaPhysicsParams> = {}): SeaPhysicsParams {
  return { ...seaPhysicsParams, mirrorResolution: 64, ...over };
}

function makeShip(): ShipState {
  return {
    id: 's',
    kind: 'player',
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    rudder: 0,
    sailTrim: 0,
    flood: 0,
    damage: {},
  };
}

/** equilibrium draft: whole waterplane submerged, k·d = m·g */
function equilibriumY(p: SeaPhysicsParams): number {
  return equilibriumDraft(p);
}

describe('cpuIFFT2D (§V.8: 2D transform must equal the math the GPU runs)', () => {
  it('matches a naive 2D inverse DFT on random 8×8 complex input', () => {
    // Wrong row/column composition or butterfly reuse would give plausible-
    // looking but phase-broken grids — buoyancy would ride phantom waves.
    const N = 8;
    const rng = createRng(42);
    const size = N * N;
    const src = {
      re: Float32Array.from({ length: size }, () => rng() * 2 - 1),
      im: Float32Array.from({ length: size }, () => rng() * 2 - 1),
    };
    const fast = { re: Float32Array.from(src.re), im: Float32Array.from(src.im) };
    cpuIFFT2D(fast, generateButterfly(N), N);
    // naive 2D = naive 1D over rows, then over columns (separable oracle)
    const slow = { re: Float32Array.from(src.re), im: Float32Array.from(src.im) };
    for (let m = 0; m < N; m++) {
      const row = naiveIDFT(
        { re: slow.re.slice(m * N, m * N + N), im: slow.im.slice(m * N, m * N + N) },
        N,
      );
      slow.re.set(row.re, m * N);
      slow.im.set(row.im, m * N);
    }
    for (let c = 0; c < N; c++) {
      const colRe = new Float32Array(N);
      const colIm = new Float32Array(N);
      for (let m = 0; m < N; m++) {
        colRe[m] = slow.re[m * N + c];
        colIm[m] = slow.im[m * N + c];
      }
      const col = naiveIDFT({ re: colRe, im: colIm }, N);
      for (let m = 0; m < N; m++) {
        slow.re[m * N + c] = col.re[m];
        slow.im[m * N + c] = col.im[m];
      }
    }
    for (let i = 0; i < size; i++) {
      expect(fast.re[i]).toBeCloseTo(slow.re[i], 2);
      expect(fast.im[i]).toBeCloseTo(slow.im[i], 2);
    }
  });
});

describe('CpuOcean determinism (§V.2: same seed+time → same sea)', () => {
  it('two mirrors with the same seed agree exactly at heightAt', () => {
    const op = testOceanParams();
    const sp = testSeaParams();
    const a = new CpuOcean(1234, op, sp);
    const b = new CpuOcean(1234, op, sp);
    for (const [x, z] of [[0, 0], [17.3, -42.9], [201.5, 88.8]]) {
      expect(a.heightAt(x, z, 5.3)).toBe(b.heightAt(x, z, 5.3));
    }
  });

  it('different seed → different sea (mirror actually uses the seed)', () => {
    const op = testOceanParams();
    const sp = testSeaParams();
    const a = new CpuOcean(1234, op, sp);
    const b = new CpuOcean(4321, op, sp);
    expect(a.heightAt(10, 10, 5.3)).not.toBe(b.heightAt(10, 10, 5.3));
  });
});

describe('heightAt inverse displacement (§V.8: FFT heights live at displaced points)', () => {
  it('querying at a displaced surface point recovers that point height', () => {
    // Without inversion, choppy waves shift crests sideways and the ship
    // would float on water ~Dx meters away from where it visually sits.
    // Moderate sea (amp 0.4, λ 1.0): keeps the surface in the contractive
    // regime (J>0, |∇D|<1) where fixed-point iteration converges — folded
    // storm crests have no unique surface point for ANY iteration count,
    // so testing there would measure the sea, not the algorithm.
    const op = testOceanParams({ choppiness: 1.0, amplitude: 0.4 });
    const sp = testSeaParams();
    const ocean = new CpuOcean(7, op, sp);
    const t = 10;
    ocean.update(t);
    // find query points with meaningful horizontal displacement
    let tested = 0;
    for (let i = 0; i < 400; i++) {
      const x = (i % 20) * 12.5;
      const z = Math.floor(i / 20) * 12.5;
      const s = ocean.sampleRaw(x, z);
      if (Math.hypot(s.dx, s.dz) < 0.2) continue;
      const found = ocean.heightAt(x + s.dx, z + s.dz, t);
      expect(Math.abs(found - s.height)).toBeLessThan(0.15);
      tested++;
    }
    // fail loud if the sea was too calm for the test to mean anything
    expect(tested).toBeGreaterThan(5);
  });
});

describe('buoyancy on flat calm water (amplitude → 0)', () => {
  const op = flatOceanParams();
  const sp = testSeaParams();

  it('ship resting at equilibrium draft stays at rest', () => {
    // WHY: any drift here is integrator bias — it would surface as ships
    // slowly sinking or levitating in calm weather.
    const ocean = new CpuOcean(1, op, sp);
    ocean.update(0);
    const ship = makeShip();
    ship.position[1] = equilibriumY(sp);
    for (let i = 0; i < 300; i++) stepShipBuoyancy(ship, ocean, DT, sp);
    expect(Math.abs(ship.position[1] - equilibriumY(sp))).toBeLessThan(1e-6);
    expect(Math.abs(ship.velocity[1])).toBeLessThan(1e-6);
    expect(ship.quaternion[3]).toBeCloseTo(1, 6);
  });

  it('ship released at the surface settles to its design draft', () => {
    const ocean = new CpuOcean(1, op, sp);
    ocean.update(0);
    const ship = makeShip(); // y=0: zero submersion → sinks, then springs
    for (let i = 0; i < 1200; i++) stepShipBuoyancy(ship, ocean, DT, sp);
    expect(Math.abs(ship.position[1] - equilibriumY(sp))).toBeLessThan(0.02);
    expect(Math.abs(ship.velocity[1])).toBeLessThan(0.01);
  });

  it('tilted ship rights itself: roll RINGS DOWN, it does not stop dead', () => {
    // WHY: righting must EMERGE from station geometry (§V.8) — if the
    // torque sign or inertia frame is wrong the ship capsizes instead.
    // But "upright within 15 s" was the WRONG assertion and it silently
    // encoded a defect: it only passed while roll was damped at ζ ≈ 0.41,
    // which is 4× a real hull's and is what made her feel dead in a seaway
    // (§B.22). A galleon knocked over by a wave swings back PAST upright and
    // keeps swinging for several cycles. So assert the shape, not the speed:
    // she crosses upright repeatedly, and each swing is smaller than the
    // last (energy leaves — no capsize, no self-excitation).
    const ocean = new CpuOcean(1, op, sp);
    ocean.update(0);
    const ship = makeShip();
    ship.position[1] = equilibriumY(sp);
    ship.quaternion = quatFromAxisAngle([0, 0, 1], 0.35); // roll about forward
    const rolls: number[] = [];
    for (let i = 0; i < 3600; i++) {
      stepShipBuoyancy(ship, ocean, DT, sp);
      rolls.push(rollOf(ship));
    }
    // she swings THROUGH upright, several times: a ship, not a damper
    let crossings = 0;
    for (let i = 1; i < rolls.length; i++) {
      if (rolls[i - 1] > 0 !== rolls[i] > 0) crossings++;
    }
    expect(crossings).toBeGreaterThanOrEqual(6); // ≥ 3 full cycles in 60 s
    // ...and each swing is smaller: peak roll in the last 20 s is a small
    // fraction of the first 20 s, and never exceeds where she started
    const peak = (from: number, to: number): number =>
      Math.max(...rolls.slice(from, to).map(Math.abs));
    expect(peak(0, 1200)).toBeLessThanOrEqual(0.35 + 1e-6);
    expect(peak(2400, 3600)).toBeLessThan(peak(0, 1200) * 0.5);
    expect(Number.isFinite(ship.position[1])).toBe(true);
  });

  it('ship dropped above water oscillates then damps — no energy explosion', () => {
    const ocean = new CpuOcean(1, op, sp);
    ocean.update(0);
    const ship = makeShip();
    ship.position[1] = 2;
    let maxAbsY = 0;
    const tail: number[] = [];
    for (let i = 0; i < 2000; i++) {
      stepShipBuoyancy(ship, ocean, DT, sp);
      maxAbsY = Math.max(maxAbsY, Math.abs(ship.position[1]));
      if (i >= 1800) tail.push(ship.position[1]);
    }
    // bounded overshoot: a growing integrator would blow well past this
    expect(maxAbsY).toBeLessThan(6);
    // and the tail has settled to the draft, not still swinging
    const spread = Math.max(...tail) - Math.min(...tail);
    expect(spread).toBeLessThan(0.05);
    expect(Math.abs(ship.position[1] - equilibriumY(sp))).toBeLessThan(0.05);
  });
});

function clamp1(x: number): number {
  return x < -1 ? -1 : x > 1 ? 1 : x;
}

/** bow elevation angle, rad — positive = bow up */
function pitchOf(ship: ShipState): number {
  return Math.asin(clamp1(rotateVec(ship.quaternion, [0, 0, 1])[1]));
}

/** roll angle, rad — starboard-up positive (asin of right.y, as sailing) */
function rollOf(ship: ShipState): number {
  return Math.asin(clamp1(rotateVec(ship.quaternion, [1, 0, 0])[1]));
}

/**
 * Emulate stepShipSailing's quaternion recompose (shipKinematics SPLIT
 * CONTRACT): every tick it rebuilds the quat as yaw∘heel ONLY, which
 * strips any pitch buoyancy accumulated. Feel tests must run under this
 * hostile-but-real tick order or they'd pass while the game stays flat.
 */
function stripPitchLikeSailing(ship: ShipState): void {
  const fwd3 = rotateVec(ship.quaternion, [0, 0, 1]);
  const yaw = Math.atan2(fwd3[0], fwd3[2]);
  const heel = Math.asin(clamp1(rotateVec(ship.quaternion, [1, 0, 0])[1]));
  ship.quaternion = quatMul(
    quatFromAxisAngle([0, 1, 0], yaw),
    quatFromAxisAngle([0, 0, 1], heel),
  );
}

/** one heading's time series through the sea — shipY/waterY are paired by tick */
type HeadingRun = {
  shipY: number[];
  waterY: number[];
  pitches: number[];
  rolls: number[];
};

/**
 * Ride every heading through ONE sea and return each one's time series.
 *
 * WHY ONE OCEAN FOR ALL OF THEM. `CpuOcean.update(t)` is a pure function of
 * `time`: it reads no ship state, and buoyancy only ever READS the mirror
 * (stepShipBuoyancy takes `ocean.currentTime` and samples `heightAt`, it
 * never writes). So a mirror built per heading recomputed a bit-identical
 * IFFT sequence once per heading — and that IFFT is 71% of a tick, measured
 * 1.31 ms of 1.86 ms at 64². Sweeping headings is the point (§V.50);
 * rebuilding the sea underneath each one never was.
 *
 * Interleaving the ships over a single mirror is BIT-IDENTICAL, not an
 * approximation: each ship still sees the same field at the same t, stepped
 * in the same order, from the same seed. The ships never see each other —
 * there is no ship-ship coupling in buoyancy — so their interleaving is
 * unobservable. Cost falls by the number of headings.
 */
function rideHeadings(
  headings: number[],
  seed: number,
  op: OceanParams,
  sp: SeaPhysicsParams,
  ticks: number,
  warmup: number,
): HeadingRun[] {
  const ocean = new CpuOcean(seed, op, sp);
  const ships = headings.map((yaw) => {
    const ship = makeShip();
    ship.position[1] = equilibriumY(sp);
    ship.quaternion = quatFromAxisAngle([0, 1, 0], yaw);
    return ship;
  });
  const out: HeadingRun[] = headings.map(() => ({
    shipY: [],
    waterY: [],
    pitches: [],
    rolls: [],
  }));
  for (let i = 0; i < ticks; i++) {
    const t = (i + 1) * DT;
    ocean.update(t);
    for (let h = 0; h < ships.length; h++) {
      const ship = ships[h];
      stripPitchLikeSailing(ship); // real main.ts tick order (sailing first)
      stepShipBuoyancy(ship, ocean, DT, sp);
      if (i < warmup) continue; // discard transient
      const r = out[h];
      r.shipY.push(ship.position[1]);
      r.waterY.push(ocean.heightAt(ship.position[0], ship.position[2], t));
      r.pitches.push(pitchOf(ship));
      r.rolls.push(rollOf(ship));
    }
  }
  return out;
}

describe('feel targets: ponderous but ALIVE in a swell', () => {
  /**
   * A HEADING ENSEMBLE, not one run (§V.50, which this block violated).
   *
   * Every bound here used to come off a single 40 s realisation at a single
   * heading — the fixture built a ship with an identity quaternion, so it
   * only ever asked "what does she do pointing THAT way at THIS seed". Swept
   * over 8 headings × 4 seeds in the same sea, `maxPitch` ranges 9.3°–21.8°
   * and green water 0.00%–1.39%: the single sample was reading somewhere
   * around p85 of its own distribution and calling it the answer.
   *
   * That mattered the moment the sea stopped being long-crested. Wind-sea
   * directional spread is now frequency-dependent (Mitsuyasu/Hasselmann,
   * ocean agent) instead of a flat 16.5° at every scale, and the measured
   * consequence for this hull is that the heading anisotropy of the pitch
   * drive collapsed from 1.76× to 1.21× — the sheltered headings are gone.
   * The RESONANT forcing actually FELL 9.5% (bow-stern Δh RMS over the 35 m
   * hull, λ 25–70 m band, at matched σ), so the pitch that appeared is not
   * more energy, it is the same energy no longer avoidable by pointing.
   *
   * Sweeping is the fix for both: it is what makes the number mean "the
   * ship", and it is the only way an anisotropy change shows up as a change
   * in spread rather than as a mystery in one cell.
   */
  const op = testOceanParams({ amplitude: 1.0 });
  const sp = testSeaParams();
  const HEADINGS = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
  const runs = rideHeadings(HEADINGS, 7, op, sp, 2400, 600);

  const std = (a: number[]): number => {
    const m = a.reduce((s, v) => s + v, 0) / a.length;
    return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length);
  };
  const deg = (r: number): number => (r * 180) / Math.PI;
  /** the median across headings — "what she does", not "what that one did" */
  const median = (a: number[]): number =>
    a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const across = <T,>(f: (r: (typeof runs)[0]) => T): T[] => runs.map(f);

  it('the sea itself is rough enough for these assertions to mean anything', () => {
    // fail loud (guard for every test below): a param change that calms
    // the mirrored sea would green-wash the feel targets
    for (const r of runs) expect(std(r.waterY)).toBeGreaterThan(0.25);
  });

  it('ship pitches visibly into swells DESPITE sailing stripping pitch each tick', () => {
    // WHY: user report "never tips forward/backward — feels like improper
    // probes". Sailing recomposes yaw∘heel 60×/s; buoyancy must persist
    // its own pitch or the bow never rises/dips more than ω·dt ≈ 0.05°.
    //
    // MEASURED over the sweep, this sea (σ_wave ≈ 1.66 m, Hs ≈ 6.6 m — a
    // wave a fifth of her own length): pitch RMS median 6.0°, max 21.8°
    // over 32 runs. The RMS is the feel number and is pinned; the max is a
    // runaway guard on a statistic whose spread is 9°–22° and which no
    // single run can pin honestly.
    const rms = across((r) => deg(std(r.pitches)));
    const max = across((r) => Math.max(...r.pitches.map((v) => deg(Math.abs(v)))));
    expect(median(rms)).toBeGreaterThan(2); // she works in a seaway
    expect(median(rms)).toBeLessThan(9); // and does not hobby-horse
    expect(Math.max(...max)).toBeLessThan(30); // nothing runs away
    // and it is genuinely heading-dependent motion, not a uniform wobble
    expect(Math.max(...max)).toBeGreaterThan(2);
  });

  it('hull rides UP with a passing swell instead of letting it roll over the deck', () => {
    // WHY: user report "way too static — waves roll OVER the boat".
    // Damping relative to the surface lets heave track the swell: the
    // ship's vertical excursion must carry most of the water's.
    // MEASURED: tracking ratio 0.93–1.02 across the sweep — she rides it
    // essentially one-for-one, which is what a hull shorter than the wave
    // does. Green water median 0.00%, worst 1.39% over 32 runs.
    const track = across((r) => std(r.shipY) / std(r.waterY));
    expect(Math.min(...track)).toBeGreaterThan(0.6);
    const green = across(
      (r) => r.waterY.filter((h, i) => h > r.shipY[i] + 2.6).length / r.waterY.length,
    );
    // in a sea this size she MAY ship water — but rarely, and not as a
    // permanent feature of the waterline
    expect(median(green)).toBeLessThan(0.02);
    expect(Math.max(...green)).toBeLessThan(0.05);
  });

  it('swell actually rolls the ship (angularDamping must not pin it upright)', () => {
    const rms = across((r) => deg(std(r.rolls)));
    const max = across((r) => Math.max(...r.rolls.map((v) => deg(Math.abs(v)))));
    // MEASURED: roll RMS median ~10°, max ~24° in this near-storm sea. She
    // is near roll RESONANCE here (peak λ ≈ 109 m against her 78 m roll
    // wavelength), which is why the numbers are large and correct; the
    // FEEL-level roll assertion lives in the §B.22 block at the shipped sea.
    expect(median(rms)).toBeGreaterThan(3); // not pinned upright
    expect(median(rms)).toBeLessThan(18); // not thrown about
    expect(Math.max(...max)).toBeLessThan(55); // short of her righting arm
  });
});

describe('feel targets: roll period (calm-water free decay)', () => {
  it('rolls with a ~6-8 s natural period, swinging several cycles', () => {
    // WHY: many-tons galleon feel — 1.4e7 roll inertia gave a ~4 s yacht
    // wobble; too much damping would stop the swing dead (static ship).
    const op = flatOceanParams();
    const sp = testSeaParams();
    const ocean = new CpuOcean(1, op, sp);
    ocean.update(0);
    const ship = makeShip();
    ship.position[1] = equilibriumY(sp);
    ship.quaternion = quatFromAxisAngle([0, 0, 1], 0.25);
    const crossings: number[] = [];
    let prev = rollOf(ship);
    for (let i = 0; i < 1800; i++) {
      stepShipBuoyancy(ship, ocean, DT, sp);
      const r = rollOf(ship);
      if (prev > 0 !== r > 0) crossings.push(i * DT);
      prev = r;
    }
    // still oscillating: at least 3 half-periods within 30 s
    expect(crossings.length).toBeGreaterThanOrEqual(3);
    const halfPeriods = crossings.slice(1).map((t, i) => t - crossings[i]);
    const period = 2 * (halfPeriods.reduce((s, v) => s + v, 0) / halfPeriods.length);
    expect(period).toBeGreaterThan(5);
    expect(period).toBeLessThan(9);
  });
});

/**
 * Analytic monochromatic deep-water sea — one wavelength at a time, which
 * an FFT spectrum can never give us. `dir` is the travel direction in the
 * xz plane: [0,1] = head/following sea (crests athwartships), [1,0] = beam
 * sea (crests along the hull). Satisfies OceanHeightField structurally.
 */
function sineSea(
  amp: number,
  lambda: number,
  dir: [number, number],
  sp: SeaPhysicsParams = seaPhysicsParams,
) {
  const k = (2 * Math.PI) / lambda;
  const omega = Math.sqrt(9.81 * k);
  // §V.68 in closed form: ONE mode, so the Smith factor is one number, and
  // this sea is an ORACLE for the mirror's per-mode version rather than a
  // restatement of it — nothing here is copied from cpuOcean.
  const smith = Math.exp(-k * sp.hullDraft * sp.smithDepthScale);
  let t = 0;
  return {
    period: (2 * Math.PI) / omega,
    smith,
    get currentTime(): number {
      return t;
    },
    update(time: number): void {
      t = time;
    },
    heightAt(x: number, z: number, time: number): number {
      return amp * Math.sin(k * (dir[0] * x + dir[1] * z) - omega * time);
    },
    pressureHeadAt(x: number, z: number, time: number): number {
      return smith * amp * Math.sin(k * (dir[0] * x + dir[1] * z) - omega * time);
    },
  };
}

/** peak-to-peak/2 of ship y, pitch and roll over the settled second half */
function rideIn(
  sea: ReturnType<typeof sineSea>,
  sp: SeaPhysicsParams,
  amp: number,
): { heave: number; pitchDeg: number; rollDeg: number } {
  const ship = makeShip();
  ship.position[1] = equilibriumY(sp);
  const ticks = Math.round(Math.max(40, sea.period * 12) / DT);
  let hi = -Infinity;
  let lo = Infinity;
  let pitch = 0;
  let roll = 0;
  for (let i = 0; i < ticks; i++) {
    sea.update((i + 1) * DT);
    stepShipBuoyancy(ship, sea, DT, sp);
    if (i < ticks / 2) continue;
    hi = Math.max(hi, ship.position[1]);
    lo = Math.min(lo, ship.position[1]);
    pitch = Math.max(pitch, Math.abs(pitchOf(ship)));
    roll = Math.max(roll, Math.abs(rollOf(ship)));
  }
  return {
    heave: (hi - lo) / 2 / amp,
    pitchDeg: (pitch * 180) / Math.PI,
    rollDeg: (roll * 180) / Math.PI,
  };
}

describe('feel targets: a 35 m hull filters the sea by WAVELENGTH', () => {
  // WHY (user, sailing live): "movements are a little bit too quick — we're
  // not really respecting the inertia. Small waves up and down can be
  // immediately shifted." A probe reading one point of the surface makes
  // the ship a cork on a stick: every ripple shorter than the hull shoves
  // it at nearly full strength. Real hulls integrate pressure over their
  // footprint AND lose short-wave pressure with depth, so chop passes under
  // them. These tests pin that selectivity — they fail the moment the hull
  // goes back to point-sampling (hullFootprint* → 0).
  const sp = testSeaParams();
  const amp = 1;

  it('ripples barely lift the hull while swell of equal height carries it', () => {
    const chop = rideIn(sineSea(amp, 8, [0, 1]), sp, amp);
    const swell = rideIn(sineSea(amp, 150, [0, 1]), sp, amp);
    // 8 m chop against a 35 m ship: essentially invisible in heave
    expect(chop.heave).toBeLessThan(0.1);
    // 150 m swell: the ship rides it, as a ship must (§V.8 — it may not
    // sit still while a visible swell passes THROUGH the hull)
    expect(swell.heave).toBeGreaterThan(0.8);
    expect(swell.heave).toBeGreaterThan(chop.heave * 8);
  });

  it('ripples barely pitch the hull while swell pitches it degrees', () => {
    const chop = rideIn(sineSea(amp, 8, [0, 1]), sp, amp);
    const swell = rideIn(sineSea(amp, 150, [0, 1]), sp, amp);
    // The claim is SELECTIVITY, so the ratio is the assertion — an absolute
    // degree bound silently re-scales every time the hull's mass or the
    // sea's resolution moves, and it has now done so twice.
    // MEASURED: 8 m ripple 0.27°, 150 m swell 3.3° — a factor of 12.
    // 0.27° is 5 mm of bow movement, and the mirror does not even carry
    // this band (cascade 2, λ ≤ 8.3 m, is not mirrored), which is why the
    // 1.5 m fore-aft kernel that used to hold it under 0.2° was dropped:
    // it cost 0.55 ms/tick/ship (a 5×5 station quadrature instead of 1×5)
    // to suppress 0.12° of a wave the sim never generates.
    expect(chop.pitchDeg).toBeLessThan(0.4);
    expect(swell.pitchDeg).toBeGreaterThan(1.5);
    expect(swell.pitchDeg).toBeGreaterThan(chop.pitchDeg * 8);
  });

  it('short BEAM chop barely rolls the hull, beam swell rolls it properly', () => {
    // Beam seas are the case the hull's LENGTH cannot help with: crests
    // running parallel to the hull are the same all down her, so the ∫ along
    // 35 m of waterplane cancels nothing. What answers them is DEPTH — the
    // Smith attenuation (§V.68) — plus the athwartships quadrature.
    //
    // Asserted as a RATIO of roll per unit WAVE SLOPE (§V.66), because roll
    // is driven by slope and an absolute degree bound at one wavelength is a
    // statement about the sea, not about the ship. It also has to be: this
    // block previously demanded < 0.5° at λ 8, a number that only held
    // because a σ 3.5 m Gaussian was suppressing λ 8 to 2% where the real
    // pressure at the keel is 21%. The bound was measuring the workaround.
    //
    // MEASURED: roll per degree of slope 0.031 at λ 8, 0.136 at λ 12, 1.73 at
    // λ 60 — a 56× rejection of chop against beam swell, and monotone.
    const perSlope = (L: number): number =>
      rideIn(sineSea(amp, L, [1, 0], sp), sp, amp).rollDeg / ((360 * amp) / L);
    const chop = perSlope(8);
    const swell = perSlope(60);
    expect(chop).toBeLessThan(swell / 20);
    expect(perSlope(12)).toBeLessThan(swell / 5);
    expect(perSlope(12)).toBeGreaterThan(chop); // monotone, no notch
    // ...and she does roll to a beam swell, in degrees, or the ratio above
    // could be bought by a hull that does not roll at all
    expect(rideIn(sineSea(amp, 60, [1, 0], sp), sp, amp).rollDeg).toBeGreaterThan(4);
  });

  it('LENGTH and DEPTH reject chop independently — both are live', () => {
    // The guard for this whole block, and it now names both mechanisms
    // instead of one. Killing either alone must leave a hull that still
    // rejects chop; killing BOTH must give a cork, or these tests are
    // passing on a sea that is simply too long-period to challenge them.
    //
    // MEASURED, λ 8 m head-sea heave RAO on a 35.5 m hull:
    //   1 slice, no Smith   0.703  ← a cork on a stick: neither mechanism
    //   1 slice, Smith on   0.146  ← depth alone rejects 79%
    //   18 slices, no Smith 0.024  ← length alone rejects 97%
    //   18 slices, Smith on 0.005  ← the shipped hull
    // and at λ 150 all four ride it (1.16 / 1.07 / 1.08 / 0.99), so neither
    // mechanism is simply deadening the ship.
    const one = { probeSlices: 1, hullFootprintLength: 0, hullFootprintBeam: 0 };
    const raoAt = (L: number, over: Partial<SeaPhysicsParams>): number => {
      const p = testSeaParams(over);
      return rideIn(sineSea(amp, L, [0, 1], p), p, amp).heave;
    };
    const cork = raoAt(8, { ...one, smithDepthScale: 0 });
    const depthOnly = raoAt(8, one);
    const lengthOnly = raoAt(8, { smithDepthScale: 0 });
    const both = raoAt(8, {});
    expect(cork).toBeGreaterThan(0.3); // fail loud: the ripple IS a ripple
    expect(depthOnly).toBeLessThan(cork * 0.35); // draft alone does most of it
    expect(lengthOnly).toBeLessThan(cork * 0.1); // and the hull's length more
    expect(both).toBeLessThan(lengthOnly); // together, strictly better
    // none of them may buy that by killing the swell
    for (const over of [{ ...one, smithDepthScale: 0 }, one, { smithDepthScale: 0 }, {}]) {
      expect(raoAt(150, over)).toBeGreaterThan(0.9);
    }
  });
});

/**
 * §V.68 — the hull answers the PRESSURE FIELD, not the surface.
 *
 * WHY (user, sailing live): "the boat feels like it gets thrown around by
 * waves too easily, as if it's still not heavy enough… are we respecting the
 * boat sitting IN the water — it's influenced by the surface, but it's also
 * feeling the forces a bit deeper, so that it's not tracking the absolute
 * outer curve of the wave shape at all times."
 *
 * That is the Smith effect and it was entirely absent: buoyancy sampled
 * `heightAt` and every wavelength had full authority over the hull whatever
 * her draft. The stand-in was a Gaussian patch across the beam, which cannot
 * express a per-wavelength factor, did nothing at all in a head sea, and cost
 * five ocean samples per station.
 */
describe('§V.68: wave pressure decays with depth, so the hull low-passes the sea', () => {
  const sp = testSeaParams();
  const amp1 = 1;

  it('the mirror attenuates each mode by e^(−k·d), not by a fitted curve', () => {
    // The claim is per-MODE, so check it against the closed form at three
    // depths on a real spectrum. The ratio of head RMS to surface RMS is the
    // energy-weighted mean of e^(−k·d) over the sea's own modes, so it must
    // fall monotonically with depth, sit strictly inside (0,1), and be
    // exactly 1 when the correction is switched off — which is also the
    // proof that the field rides in the Dz transform's spare imaginary half
    // without disturbing it (MEASURED worst |head − height| = 2.9e-7 m).
    const rms = (scale: number): number => {
      const p = testSeaParams({ smithDepthScale: scale });
      const o = new CpuOcean(3, testOceanParams(), p);
      const t = 40.5;
      o.update(t);
      let hh = 0;
      let pp = 0;
      for (let i = 0; i < 400; i++) {
        const x = (i * 37.7) % 1500;
        const z = (i * 91.3) % 1500;
        hh += o.heightAt(x, z, t) ** 2;
        pp += o.pressureHeadAt(x, z, t) ** 2;
      }
      expect(hh).toBeGreaterThan(0); // fail loud: a flat sea proves nothing
      return Math.sqrt(pp / hh);
    };
    expect(rms(0)).toBeCloseTo(1, 6); // off = the surface, bit for bit
    const shallow = rms(0.5);
    const shipped = rms(1);
    const deep = rms(2);
    expect(shallow).toBeGreaterThan(shipped);
    expect(shipped).toBeGreaterThan(deep);
    expect(deep).toBeGreaterThan(0.4); // it is an attenuation, not a mute
    expect(shallow).toBeLessThan(1);
  });

  it('long swell is preserved while short chop is not — the RATIO is the claim', () => {
    // THE measurement this whole change exists for, and it is a ratio (§V.66)
    // because "the ship is heavy" and "the ship is damped" look identical in
    // any single number. Damping everything would move both ends together;
    // the Smith effect moves ONLY the short end.
    //
    // MEASURED heave RAO: λ 8 → 0.005, λ 20 → 0.056, λ 150 → 0.99, λ 300 →
    // 1.05. Before the correction: 0.024 / 0.105 / 1.08 / 1.09 — the long end
    // barely moved (−8%, and toward the physical asymptote of 1.0, which it
    // used to overshoot) while the short end fell by 4–5×.
    const rao = (L: number): number => rideIn(sineSea(amp1, L, [0, 1], sp), sp, amp1).heave;
    const long = rao(150);
    expect(long).toBeGreaterThan(0.9); // she still rides the swell
    expect(long).toBeLessThan(1.15); // and does not amplify it
    expect(rao(20) / long).toBeLessThan(0.1);
    expect(rao(8) / long).toBeLessThan(0.02);
  });

  it('the correction is the DRAFT, so a shallower hull feels more of the sea', () => {
    // The mechanism has to be the ship's own dimension (§V.66) or it is just
    // another filter constant. A hull with half the draft must respond MORE
    // to the same chop, at the same wavelength, with nothing else changed —
    // and a hull with none at all must respond like the free surface.
    const at = (scale: number): number => {
      const p = testSeaParams({ smithDepthScale: scale });
      return rideIn(sineSea(amp1, 25, [0, 1], p), p, amp1).heave;
    };
    const none = at(0);
    const half = at(0.5);
    const full = at(1);
    expect(half).toBeGreaterThan(full);
    expect(none).toBeGreaterThan(half);
    expect(full / none).toBeLessThan(0.75); // λ25 at 2 m draft: e^−0.50 = 0.61
  });

  it('geometry still reads the TRUE surface — §V.8 is untouched', () => {
    // The pressure head is a FORCE quantity. Waterline, spray, green water
    // and the camera must keep seeing the sea that is drawn, or the ship
    // floats on one ocean and splashes in another (§B.7's shape). The two
    // fields must therefore DIFFER, and heightAt must be the bigger one.
    const o = new CpuOcean(9, testOceanParams(), sp);
    const t = 21.5;
    o.update(t);
    let differed = 0;
    for (let i = 0; i < 200; i++) {
      const x = (i * 53.1) % 900;
      const z = (i * 17.9) % 900;
      const h = o.heightAt(x, z, t);
      const p = o.pressureHeadAt(x, z, t);
      if (Math.abs(h - p) > 1e-3) differed++;
      expect(Math.abs(p)).toBeLessThan(Math.abs(h) + 1.0);
    }
    expect(differed).toBeGreaterThan(180); // they are genuinely two fields
  });
});

/**
 * §V.69 — the water a hull drags with it resists ANGULAR acceleration too.
 *
 * WHY (user, sailing live): "if the ship gained momentum by getting pushed up
 * by a wave, then it can flip forwards and change its momentum basically
 * instantly — a little bit too fast — so it gets really kicked around, bum
 * bum bum. That's not how it would be. It has more inertia than that."
 *
 * The heave channel had `addedMassHeave` and the rotational channels had
 * nothing, so the only thing resisting a pitch reversal was the hull's own
 * rigid inertia — and §B.37 records that being papered over with damping
 * instead ("a lumped model has no pitch added-inertia"). Damping and inertia
 * are not interchangeable: one bleeds energy and reads SLUGGISH, the other
 * resists acceleration and reads HEAVY. The complaint is the second one.
 */
describe('§V.69: added moment of inertia — she cannot reverse her pitch in a tick', () => {
  const sp = testSeaParams();
  /** the model as it was: rigid inertias carrying the entrained water inside */
  const lumped = testSeaParams({
    addedInertiaScale: 0,
    inertiaPitch: 8.55e7,
    inertiaRoll: 1.39e7,
  });

  it('is DERIVED from the heave coefficient and the hull, not chosen', () => {
    // §V.53: a hand-tuned constant needs a dimensionless check. This one is
    // not hand-tuned at all — it is the same entrained water as
    // `addedMassHeave`, distributed over the same stations by b² and taken
    // about the hull's own axes. So the check is that the two moments come
    // out as LENGTHS that belong to this ship.
    const set = probeStations(sp.probeSlices);
    const LWL = 35.5;
    const BEAM = 8.5;
    // the added water's own gyradius: shorter than the hull's, because a
    // section's added mass goes as b² and b is fattest amidships
    const kAdded = Math.sqrt(set.az2);
    expect(kAdded / LWL).toBeGreaterThan(0.15);
    expect(kAdded / LWL).toBeLessThan(0.25);
    expect(kAdded).toBeLessThan(Math.sqrt(sp.inertiaPitch / sp.mass)); // < hull's
    // and the RIGID gyradii are now a real ship's, because the water is no
    // longer hiding inside them (they were 0.34·L and 0.56·B)
    expect(Math.sqrt(sp.inertiaPitch / sp.mass) / LWL).toBeCloseTo(0.25, 2);
    expect(Math.sqrt(sp.inertiaRoll / sp.mass) / BEAM).toBeCloseTo(0.45, 2);
    // athwartships the added water sits inside the beam, as it must
    expect(Math.sqrt(set.ax2)).toBeLessThan(4.25);
    expect(Math.sqrt(set.ax2)).toBeGreaterThan(1);
  });

  it('lengthens the pitch period to the heave period, which is where it belongs', () => {
    // A hull that pitches half again as fast as it heaves is the "flips
    // forward instantly" complaint in one number: measured T_pitch 4.48 s
    // against T_heave 5.43 s. Real hulls pitch and heave at about the same
    // period. MEASURED after: T_pitch 5.32 s.
    const period = (p: SeaPhysicsParams): number => {
      const ocean = new CpuOcean(1, flatOceanParams(), p);
      ocean.update(0);
      const ship = makeShip();
      ship.position[1] = equilibriumY(p);
      ship.quaternion = quatFromAxisAngle([1, 0, 0], 0.1);
      const crossings: number[] = [];
      let prev = pitchOf(ship);
      for (let i = 0; i < 3600; i++) {
        stepShipBuoyancy(ship, ocean, DT, p);
        const r = pitchOf(ship);
        if (prev > 0 !== r > 0) crossings.push(i * DT);
        prev = r;
      }
      return 2 * ((crossings[2] - crossings[0]) / 2);
    };
    const heave =
      2 * Math.PI * Math.sqrt((sp.mass * (1 + sp.addedMassHeave)) / sp.buoyancySpring);
    const withAdded = period(sp);
    const without = period(lumped);
    expect(withAdded).toBeGreaterThan(without); // the water is doing something
    expect(withAdded / heave).toBeGreaterThan(0.85);
    expect(withAdded / heave).toBeLessThan(1.15);
  });

  it('halves the worst pitch KICK in the sea she is sailed in', () => {
    // The time-domain half of the complaint, and the one a frequency plot
    // cannot show: "changes its momentum basically instantly". The statistic
    // is peak pitch ANGULAR ACCELERATION — inertia is exactly the thing that
    // bounds it, where damping bounds velocity instead.
    // MEASURED over 4 headings in the shipped swell: peak 60 → 34 °/s², RMS
    // 10.8 → 8.0, and peak pitch angle 16.4° → 8.1°.
    const kick = (p: SeaPhysicsParams) => {
      const runs = rideHeadings(
        [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2],
        11,
        testOceanParams({ amplitude: oceanParams.amplitude }),
        p,
        2400,
        600,
      );
      let worstAcc = 0;
      let worstAngle = 0;
      for (const r of runs) {
        for (let i = 2; i < r.pitches.length; i++) {
          const a = (r.pitches[i] - 2 * r.pitches[i - 1] + r.pitches[i - 2]) / (DT * DT);
          worstAcc = Math.max(worstAcc, (Math.abs(a) * 180) / Math.PI);
        }
        worstAngle = Math.max(worstAngle, ...r.pitches.map((v) => Math.abs((v * 180) / Math.PI)));
      }
      return { worstAcc, worstAngle };
    };
    const before = kick(lumped);
    const after = kick(sp);
    // THE ABSOLUTE NUMBER IS NOW THE CLAIM, and it has to be, because §V.70
    // took over most of this statistic. Water entry and the split heave
    // damper attack the same defect from the force side — the per-station
    // linear heave damper was itself the largest single source of pitch
    // kick, since each station damps against its OWN wave orbital velocity
    // and the difference bow-to-stern is a torque — so cutting it 2.5×
    // halved the kick again on top of what added inertia had already done.
    // MEASURED in the shipped swell over 4 headings, worst pitch angular
    // acceleration: 37.6 °/s² lumped and pre-§V.70 → 32.6 with added inertia
    // → 14.4 with §V.70. Peak pitch ANGLE 11.3° → 7.7° → 6.8°, so the sharp
    // accelerations went and the motion did not.
    expect(after.worstAcc).toBeLessThan(20);
    expect(after.worstAngle).toBeLessThan(before.worstAngle * 0.9);
    // The MARGINAL share left to added inertia is small now — 14.35 against
    // 14.61 with it removed — so a ratio bound here can no longer catch its
    // removal and pretending otherwise would be a test that cannot fail
    // (§Rule 6). What still can, and does, is the PERIOD test above: added
    // inertia is what puts T_pitch on T_heave, and nothing in §V.70 touches
    // that. This assertion is kept as the direction check it can still make.
    expect(after.worstAcc).toBeLessThan(before.worstAcc);
    // ...and she has NOT been deadened into it: she still pitches degrees
    expect(after.worstAngle).toBeGreaterThan(3);
  });

  it('closes §B.37: ζ_pitch is physical because the inertia is, not by taste', () => {
    // §B.37 held ζ_pitch at 0.62 against a real hull's 0.2–0.4 for two rounds
    // as a "lumped model has no pitch added-inertia" concession, then measured
    // it down to 0.41 — still at the very top of the range. Adding the
    // inertia that was missing takes it the rest of the way with the DAMPING
    // COEFFICIENT UNTOUCHED: ζ = B/(2√(C·I)) and I grew 50%.
    // MEASURED: 0.412 → 0.342 at the same pitchDampingScale.
    const zeta = (p: SeaPhysicsParams): number => {
      const ocean = new CpuOcean(1, flatOceanParams(), p);
      ocean.update(0);
      const ship = makeShip();
      ship.position[1] = equilibriumY(p);
      ship.quaternion = quatFromAxisAngle([1, 0, 0], 0.1);
      const peaks: number[] = [];
      let prev = 0;
      let prev2 = 0;
      for (let i = 0; i < 3600; i++) {
        stepShipBuoyancy(ship, ocean, DT, p);
        const r = pitchOf(ship);
        if (i > 1 && Math.abs(prev) > Math.abs(prev2) && Math.abs(prev) >= Math.abs(r)) {
          peaks.push(Math.abs(prev));
        }
        prev2 = prev;
        prev = r;
      }
      const d = Math.log(peaks[0] / peaks[2]);
      return d / Math.sqrt(4 * Math.PI * Math.PI + d * d);
    };
    expect(sp.pitchDampingScale).toBe(lumped.pitchDampingScale); // same damper
    const z = zeta(sp);
    expect(z).toBeGreaterThan(0.2); // a real hull's range, both ends asserted
    expect(z).toBeLessThan(0.4);
    expect(z).toBeLessThan(zeta(lumped)); // and it got there by gaining mass
  });

  it('cannot destabilise the step: it only ever divides by MORE', () => {
    // The user's own caveat — "while also making sure we're actually staying
    // above water". Added inertia enters as torque/(I + A·wet) with A ≥ 0, so
    // the explicit step's increment is strictly smaller than it was: there is
    // no implicit term that can go wrong and no path by which it moves a
    // force. Asserted as the thing that would actually break — she must float
    // at exactly the same draft and stay bounded at 3× the shipped sea.
    const ocean = new CpuOcean(4, testOceanParams({ amplitude: 1.0 }), sp);
    const ship = makeShip();
    ship.position[1] = equilibriumY(sp);
    for (let i = 0; i < 3600; i++) {
      const t = (i + 1) * DT;
      ocean.update(t);
      stepShipBuoyancy(ship, ocean, DT, sp);
      expect(Number.isFinite(ship.position[1])).toBe(true);
    }
    expect(Math.abs(ship.position[1])).toBeLessThan(6);
    // and the resting draft is inertia-independent, as a matter of physics
    const flat = new CpuOcean(1, flatOceanParams(), sp);
    flat.update(0);
    const still = makeShip();
    still.position[1] = equilibriumY(sp);
    for (let i = 0; i < 600; i++) stepShipBuoyancy(still, flat, DT, sp);
    expect(still.position[1]).toBeCloseTo(equilibriumY(sp), 6);
  });
});

/**
 * §V.70 — SHE SLAMS, AND SHE LOSES HER MOMENTUM DOING IT.
 *
 * The user, on a hull coming down on the sea: "right now it can basically
 * MORE OR LESS IMMEDIATELY CHANGE DIRECTION, where it should — it's HEAVY,
 * right? It should have some momentum… it really smashes into the water and
 * it's like BOOM and then reverberates for a little bit before it gets pushed
 * back up. IT HAS TO LOSE ITS MOMENTUM."
 *
 * These assert the REPORT, not the mechanism (§Rule 6). Every one of them is
 * a statement about what the hull does that a player could have made, and
 * each fails on the model as it was — a hull that landed at 6.2 m/s with 0.99
 * g of retardation, i.e. a firm settle, and then returned without one
 * oscillation. Nothing here mentions added mass, dm/dt or damping ratios, so
 * they stay true if the mechanism is ever replaced by a better one.
 *
 * The reference throughout is `noEntry`: the same hull with the water-entry
 * model off and the heave damper back in one linear lump. It is here so these
 * bounds are anchored to a measured alternative rather than to absolutes
 * pulled out of the current tuning (§V.36).
 */
describe('§V.70: water entry — she smashes in, and the sea keeps the energy', () => {
  const sp = testSeaParams();
  /** the model before §V.70: step added mass, one linear heave damper */
  const noEntry = testSeaParams({
    slamEntryDepth: 0,
    heaveDampingScale: 1,
    heaveQuadraticRate: 0,
  });

  /**
   * Drop her onto flat calm from `fall` metres of keel clearance and watch
   * the whole event. Flat water on purpose: a slam is a statement about the
   * HULL, and a seaway would let the wave's own motion supply half the answer.
   */
  function slam(p: SeaPhysicsParams, fall: number) {
    const ocean = new CpuOcean(1, flatOceanParams(), p);
    let t = 0;
    ocean.update(t);
    const eq = equilibriumY(p);
    const ship = makeShip();
    ship.position[1] = ocean.heightAt(0, 0, t) + p.hullDraft + fall;
    let entry = -1;
    let entryV = 0;
    let peakDecel = 0;
    let reversed = -1;
    let deepest = Infinity;
    let rebound = -Infinity;
    /** worst single-tick velocity change while she still had way on */
    let flippedInOneTick = false;
    for (let i = 0; i < 900; i++) {
      t += DT;
      ocean.update(t);
      const v0 = ship.velocity[1];
      const wet = ship.position[1] <= ocean.heightAt(0, 0, t) + p.hullDraft;
      stepShipBuoyancy(ship, ocean, DT, p);
      const v1 = ship.velocity[1];
      if (entry < 0 && wet) {
        entry = i;
        entryV = v0;
      }
      if (entry < 0) continue;
      peakDecel = Math.max(peakDecel, (v1 - v0) / DT);
      // THE LITERAL CLAIM: a hull carrying real momentum downward cannot come
      // out of one 16 ms tick going upward. Anything that sets position or
      // velocity instead of integrating a force does exactly this.
      if (v0 < -1 && v1 > 0) flippedInOneTick = true;
      if (reversed < 0 && v1 >= 0) reversed = i;
      deepest = Math.min(deepest, ship.position[1]);
      if (reversed >= 0) rebound = Math.max(rebound, ship.position[1]);
    }
    return {
      entryV,
      peakG: peakDecel / 9.81,
      ticksToReverse: reversed - entry,
      flippedInOneTick,
      belowRest: eq - deepest,
      reboundAboveRest: rebound - eq,
    };
  }

  it('cannot reverse in a tick: the sea takes her momentum over ~4 seconds', () => {
    // The complaint in its own words. The bound is on TIME, and it is a wide
    // one on purpose — the claim is "not instantaneous", not "exactly this
    // long" — plus the hard structural check that no single tick ever turns
    // downward motion into upward motion.
    const hard = slam(sp, 2.0);
    expect(hard.entryV).toBeLessThan(-5); // she really is coming down
    expect(hard.flippedInOneTick).toBe(false);
    expect(hard.ticksToReverse).toBeGreaterThan(60); // > 1 s, measured 236
    // and she has not simply been frozen: she does turn round, in this run
    expect(hard.ticksToReverse).toBeLessThan(600);
    // MEASURED against the model without the entry term: 92 ticks. Taking
    // three times as long to give up her downward momentum is the whole of
    // "it should have some momentum".
    expect(hard.ticksToReverse).toBeGreaterThan(slam(noEntry, 2.0).ticksToReverse * 2);
  });

  it('the impact is IMPULSIVE: gentle landings settle, hard ones bang', () => {
    // "It really smashes into the water and it's like BOOM." The signature of
    // a slam is that it is not a scaled-up settle — the retardation grows far
    // faster than the speed, because the reaction comes from the RATE at which
    // the hull entrains water and a faster entry does the same entrainment in
    // less time. One term has to produce both ends or it is two special cases.
    const gentle = slam(sp, 0.15);
    const hard = slam(sp, 4.0);
    expect(gentle.entryV).toBeGreaterThan(-2); // a touch-down
    expect(hard.entryV).toBeLessThan(-8); // a fall
    expect(gentle.peakG).toBeLessThan(1); // …she settles onto it (MEASURED 0.58)
    expect(hard.peakG).toBeGreaterThan(4); // …and she hits it. MEASURED 5.67
    // The old model could not tell these apart by much, because a linear
    // damper cannot: 0.33 g against 1.55 g for the same pair, so its hardest
    // landing was gentler than this hull's SOFTEST is now.
    expect(hard.peakG).toBeGreaterThan(slam(noEntry, 4.0).peakG * 2.5);
  });

  it('momentum is LOST, not returned: she does not pogo', () => {
    // The failure mode on the other side of this complaint, and the reason
    // the entry term is written as an inelastic mixing rather than a spring.
    // A hull that gave the energy back would leap out of the water after a
    // hard landing; this one comes up 16 mm past her marks after a 4 m drop.
    const hard = slam(sp, 4.0);
    expect(hard.reboundAboveRest).toBeLessThan(0.1);
    expect(hard.reboundAboveRest).toBeGreaterThan(0); // she DOES come back up
  });

  it('…and then she reverberates: a knock rings down over several cycles', () => {
    // "…and then reverberates for a little bit." Held under a metre and let
    // go, she must cross her own waterline repeatedly with a decaying swing.
    // This is the assertion that the single linear heave damper could not
    // meet at any setting that also stopped her flying off crests: at
    // ζ_heave 0.90 the second extremum is 0.00003 m — gone inside one cycle.
    const ring = (p: SeaPhysicsParams): number[] => {
      const ocean = new CpuOcean(1, flatOceanParams(), p);
      ocean.update(0);
      const eq = equilibriumY(p);
      const ship = makeShip();
      ship.position[1] = eq - 1.0; // pushed under, released
      const ex: number[] = [];
      let dir = 0;
      let prevY = ship.position[1];
      for (let i = 0; i < 1500; i++) {
        ocean.update((i + 1) * DT);
        stepShipBuoyancy(ship, ocean, DT, p);
        const d = Math.sign(ship.position[1] - prevY);
        if (d !== 0 && dir !== 0 && d !== dir) ex.push(prevY - eq);
        if (d !== 0) dir = d;
        prevY = ship.position[1];
      }
      return ex;
    };
    const ex = ring(sp);
    // at least four turning points still large enough to SEE on a 35 m hull
    const visible = ex.filter((v) => Math.abs(v) > 0.001);
    expect(visible.length).toBeGreaterThanOrEqual(4);
    // …alternating, and decaying — a ring, not a wobble and not a growth
    for (let i = 1; i < 4; i++) {
      expect(Math.sign(ex[i])).toBe(-Math.sign(ex[i - 1]));
      expect(Math.abs(ex[i])).toBeLessThan(Math.abs(ex[i - 1]));
    }
    // ζ from the log decrement over one full period. Bounded BOTH ends: below
    // ~0.2 she would swing for ten cycles like a cork, above ~0.6 the ring is
    // over before it is seen. MEASURED 0.39 on this pluck, tending to the
    // 0.36 linear ratio as the swing decays and the v² half falls away.
    const delta = Math.log(Math.abs(ex[0]) / Math.abs(ex[2]));
    const zeta = delta / Math.sqrt(4 * Math.PI * Math.PI + delta * delta);
    expect(zeta).toBeGreaterThan(0.2);
    expect(zeta).toBeLessThan(0.6);
    // and the guard that this test means anything: the OLD damper fails it
    const old = ring(noEntry).filter((v) => Math.abs(v) > 0.001);
    expect(old.length).toBeLessThan(visible.length);
  });

  it('she still floats level in a calm, at exactly the same draft', () => {
    // THE load-bearing invariant, and the one this change was most likely to
    // break: flotation is what everything else in the game reads. The entry
    // ramp is fully developed at 2.0 m of immersion and she rests 2.44 m in,
    // so a floating hull is past it and NOTHING about her rest state may move
    // — not the draft, not the trim, not by a millimetre.
    const rest = (p: SeaPhysicsParams, start: number): ShipState => {
      const ocean = new CpuOcean(1, flatOceanParams(), p);
      ocean.update(0);
      const ship = makeShip();
      ship.position[1] = start;
      for (let i = 0; i < 1800; i++) {
        ocean.update((i + 1) * DT);
        stepShipBuoyancy(ship, ocean, DT, p);
      }
      return ship;
    };
    // …from her marks, from below, and from a drop: one attractor, no memory
    for (const start of [equilibriumY(sp), equilibriumY(sp) - 1.5, sp.hullDraft + 2]) {
      const ship = rest(sp, start);
      expect(ship.position[1]).toBeCloseTo(equilibriumY(sp), 3);
      expect(Math.abs(ship.velocity[1])).toBeLessThan(1e-3);
      expect(Math.abs(pitchOf(ship))).toBeLessThan(1e-6); // level fore-and-aft
      expect(Math.abs(rollOf(ship))).toBeLessThan(1e-6); // and upright
    }
    // and it is the SAME draft as before §V.70, to the metre-per-thousand —
    // the entry model is inertia and dissipation, it moves no static force
    expect(rest(sp, equilibriumY(sp)).position[1]).toBeCloseTo(
      rest(noEntry, equilibriumY(noEntry)).position[1],
      9,
    );
    expect(equilibriumDraft(sp)).toBe(equilibriumDraft(noEntry));
  });
});

describe('feel targets: added mass (a heaving hull drags water with it)', () => {
  it('stretches the heave period ≈√(1+a) without changing where it floats', () => {
    // WHY: draft is locked by spring/mass (ω=√(g/draft)≈4.7 rad/s), so no
    // spring tuning can slow the bob without floating the ship higher or
    // drowning the deck. Added mass is the one honest knob: entrained
    // water is inertia, not weight.
    const measure = (a: number): { period: number; rest: number } => {
      const sp = testSeaParams({ addedMassHeave: a, buoyancyDamping: 0 });
      const ocean = new CpuOcean(1, flatOceanParams(), sp);
      ocean.update(0);
      const ship = makeShip();
      ship.position[1] = equilibriumY(sp) + 0.3; // pluck it, let it ring
      const crossings: number[] = [];
      let prev = ship.position[1] - equilibriumY(sp);
      // 60 s: the periods being measured are now seconds long, not tenths
      for (let i = 0; i < 3600; i++) {
        stepShipBuoyancy(ship, ocean, DT, sp);
        const d = ship.position[1] - equilibriumY(sp);
        if (prev > 0 !== d > 0) crossings.push(i * DT);
        prev = d;
      }
      const half =
        (crossings[crossings.length - 1] - crossings[0]) / (crossings.length - 1);
      return { period: 2 * half, rest: equilibriumY(sp) };
    };
    const cork = measure(0);
    const heavy = measure(seaPhysicsParams.addedMassHeave);
    // The un-added-mass bound is 2π√(immersion/g), and the immersion is the
    // hull's OWN — 2.44 m, her 2 m of draft plus the 0.44 m she floats down
    // past her marks. It read 1.1–1.6 s while she displaced 150 t and sat
    // 0.44 m into the water, which is a rowing boat's bob, and that number
    // WAS the "feels too light" complaint (§B.27): a hull cannot read as
    // heavy while it bobs at twice a ship's frequency, whatever it weighs.
    const bare = testSeaParams();
    const bareBound =
      (2 * Math.PI * Math.sqrt(-equilibriumY(bare) + bare.hullDraft)) /
      Math.sqrt(9.81);
    expect(cork.period).toBeGreaterThan(bareBound * 0.9);
    expect(cork.period).toBeLessThan(bareBound * 1.1);
    const expected = Math.sqrt(1 + seaPhysicsParams.addedMassHeave);
    expect(heavy.period / cork.period).toBeCloseTo(expected, 1);
    // and it still floats at exactly the same draft (§V.8 ride height)
    expect(heavy.rest).toBeCloseTo(cork.rest, 9);
  });
});

describe('§V.8: CPU mirror and GPU agree on the FOLD-CAPPED choppiness', () => {
  // WHY: the GPU displaces with effectiveChoppiness() — λ capped so that
  // λ·σ_gradient ≤ choppinessFoldLimit, which is what stops a storm sea
  // folding into shards. A mirror that kept using the raw p.choppiness puts
  // every crest at a different horizontal position than the one drawn, so
  // the ship floats on a sea nobody can see. That is §V.8 exactly, and the
  // §B.7 failure class (mirror silently describing a different ocean).
  // Pinned against the aggregation the GPU class performs — over ALL THREE
  // cascades, variance-summed — not against our own implementation, so
  // mirroring only the two cascades we simulate would fail here.
  const gpuLambda = (p: OceanParams): number => {
    let variance = 0;
    for (let i = 0; i < p.cascades.length; i++) {
      // §V.59: the fold cap's moment is the DIRECTION-FREE Jacobian trace,
      // not the x-projection `spectralSteepness` measures
      const s = spectralJacobianRms(p.resolution, p.cascades[i].domain, p, cascadeBand(i, p.splitWavelengths));
      variance += s * s;
    }
    return effectiveChoppiness(p.choppiness, Math.sqrt(variance), p.choppinessFoldLimit);
  };

  for (const name of ['calm', 'swell', 'storm'] as const) {
    it(`agrees under the ${name} preset`, () => {
      const op = testOceanParams({ ...weatherPresets[name].ocean });
      const mirror = new CpuOcean(5, op, testSeaParams());
      expect(mirror.effectiveChoppiness()).toBeCloseTo(gpuLambda(op), 12);
    });
  }

  it('tracks a live choppiness tweak without waiting for an h0 rebuild', () => {
    // the GPU derives λ per frame from a cached steepness; so must we, or a
    // slider drag desynchronises the two seas until the next rebuild
    const op = testOceanParams({ ...weatherPresets.storm.ocean });
    const mirror = new CpuOcean(5, op, testSeaParams());
    const before = mirror.effectiveChoppiness();
    op.choppiness *= 0.5;
    expect(mirror.effectiveChoppiness()).toBeCloseTo(gpuLambda(op), 12);
    expect(mirror.effectiveChoppiness()).toBeLessThan(before);
  });

  it('the cap actually BITES somewhere, or this test guards nothing', () => {
    // fail loud: if the cap never engages on any sea, a broken cap would look
    // identical to a working one in every test above it.
    //
    // IT IS NO LONGER EXERCISED BY A SHIPPED PRESET, and that is the point of
    // the second half of this test rather than a hole in the first. Until the
    // storm retune, `storm` authored choppiness 1.9 on an Hs 14.70 m sea and
    // the cap delivered 1.31 — the preset was over the fold limit and being
    // rescued by the safety on every frame. Every rung of the weather ladder
    // now authors a choppiness it actually GETS (tests/weather.test.ts pins
    // that), which is what "the number in the file means something" requires.
    // So the cap is exercised here on a DELIBERATELY over-steep sea instead.
    const over = testOceanParams({
      ...weatherPresets.storm.ocean,
      choppiness: weatherPresets.storm.ocean.choppiness * 4,
    });
    expect(gpuLambda(over)).toBeLessThan(over.choppiness - 1e-9);

    // and no shipped preset relies on it — a rung that did would be authoring
    // a sea it does not get
    for (const n of Object.keys(weatherPresets) as (keyof typeof weatherPresets)[]) {
      const op = testOceanParams({ ...weatherPresets[n].ocean });
      expect(gpuLambda(op), `${n} is being rescued by the anti-fold cap`)
        .toBeCloseTo(op.choppiness, 9);
    }
  });
});

describe('live spectrum-param changes (§V.8: weather transitions re-shape the sea)', () => {
  it('rebuilds h0 after amplitude changes, matching a fresh mirror exactly', () => {
    // WHY: weather presets lerp oceanParams live and the GPU regenerates
    // its spectrum (oceanCascades spectrumSignature). A mirror pinned to
    // the launch-time sea floats ships on calm physics under storm waves —
    // the exact "waves roll over an unaffected ship" drift V8 forbids.
    const op = testOceanParams({ amplitude: 0.5 });
    const sp = testSeaParams();
    const mirror = new CpuOcean(99, op, sp);
    let t = 1;
    mirror.update(t);
    const before = mirror.heightAt(31.7, -12.4, t);
    op.amplitude = 1.5; // live tweak, same object (registry-style mutation)
    // within the 15-tick debounce the old sea persists (slider-drag calm)
    t += DT;
    mirror.update(t);
    const during = mirror.heightAt(31.7, -12.4, t);
    const fresh = new CpuOcean(99, op, sp);
    // §B.51: the rebuild is AMORTISED over `SPECTRUM_REBUILD_STEPS` ticks now
    // instead of landing in one, so the settle window is arm + steps, not 20.
    // Driven off the constants rather than a literal — a slice-count change
    // must not be able to make this test silently assert "still the old sea".
    for (let i = 0; i < REBUILD_ARM_TICKS + SPECTRUM_REBUILD_STEPS + 2; i++) {
      t += DT;
      mirror.update(t);
    }
    fresh.update(t);
    const after = mirror.heightAt(31.7, -12.4, t);
    expect(after).toBe(fresh.heightAt(31.7, -12.4, t)); // exact parity
    expect(after).not.toBe(before);
    expect(Math.abs(during - before)).toBeLessThan(0.2); // debounce held
  });
});

describe('mirror config guards (§V.8)', () => {
  it('rejects a mirror grid too coarse to hold the cascade band', () => {
    // Silently truncating the band would drop the GPU's mid-frequency waves
    // from buoyancy — exactly the drift V8 forbids. Fail loud instead.
    const op = testOceanParams();
    expect(
      () => new CpuOcean(1, op, testSeaParams({ mirrorResolution: 16 })),
    ).toThrow(/mirrorResolution/);
  });
});

/**
 * §B.22 — the four things the user said the ship was doing wrong, each as a
 * number the sim can be held to. These are FEEL tests: every one of them is
 * written so that it FAILS if the motion stops reading like a ship, not
 * merely if some quantity leaves a window. Where a bound is one-sided the
 * opposite side is asserted too, because "she barely moves" and "she is
 * thrown about" are both wrong answers and a one-sided test greenlights one
 * of them.
 */
describe('§B.22 feel: the hull answers the sea, in the right places', () => {
  const sp = testSeaParams();
  const amp = 1;

  it('heave RAO is smooth and IN PHASE across the whole swell band', () => {
    // THE defect behind "she dips into the water too heavily" and "she
    // doesn't feel dynamic": 8 hand-placed probes sampled ∫b(z)h(z)dz at 8
    // points, and 8 points cannot represent a wave the length of the ship.
    // Measured on the old layout: λ40 → −0.28 where the true integral is
    // +0.10 (SIGN-INVERTED — she rose on crests), λ50 → 0.18 (a null), λ70
    // → 0.42. The sea's energy sits exactly there (mean λ ≈ 69 m), so the
    // ship answered the swell weakly, erratically and sometimes backwards.
    //
    // The guard is the SHAPE, not one number: a hull shorter than the wave
    // must ride most of it, and the response must not collapse and revive
    // as λ sweeps. A single "λ=150 rides fine" assertion passes on the
    // broken layout too — the notch is in the middle of the band.
    const band = [40, 50, 60, 70, 90, 120, 150];
    const rao = band.map((L) => rideIn(sineSea(amp, L, [0, 1]), sp, amp).heave);
    // MONOTONE. This, not any level, is the guard: the broken layout's
    // signature was a curve that collapsed and revived as λ swept, and a
    // level bound can be met by a hull that is simply stiff everywhere.
    for (let i = 1; i < rao.length; i++) {
      expect(rao[i]).toBeGreaterThan(rao[i - 1]);
    }
    // She RIDES long swell (λ ≥ 2·L) — measured against WHAT SHE IS OFFERED,
    // not against the surface (§V.66). The pressure that reaches a 2 m draft
    // is e^(−k·T) of the surface elevation (§V.68), so a hull that tracked
    // the free surface one-for-one at λ 90 would be responding to 15% more
    // than the sea is pushing with. This bound used to read `> 0.85` against
    // the surface and it went red on the correction while the ship was
    // riding 96% of the actual forcing — an absolute against the wrong
    // dimension, exactly §V.66. MEASURED: 0.96 / 1.05 / 1.08 / 1.10 / 1.09 of
    // the Smith ceiling at λ 90 / 120 / 150 / 200 / 300.
    for (let i = 0; i < band.length; i++) {
      const smith = Math.exp((-2 * Math.PI * sp.hullDraft * sp.smithDepthScale) / band[i]);
      if (band[i] >= 90) expect(rao[i] / smith).toBeGreaterThan(0.9);
      expect(rao[i] / smith).toBeLessThan(1.25);
    }
    // ...and she does it IN PHASE. Peak-to-peak cannot see a sign flip, and
    // a sign flip is exactly what the old layout did at λ40: it summed to
    // −0.28 where the integral is +0.10, so the hull ROSE INTO crests. A
    // ship whose heave is anti-correlated with the water under her reads as
    // erratic no matter how big the number is.
    for (const L of [40, 90, 150]) {
      const sea = sineSea(amp, L, [0, 1]);
      const ship = makeShip();
      ship.position[1] = equilibriumY(sp);
      const ys: number[] = [];
      const hs: number[] = [];
      const ticks = Math.round(Math.max(60, sea.period * 16) / DT);
      for (let i = 0; i < ticks; i++) {
        sea.update((i + 1) * DT);
        stepShipBuoyancy(ship, sea, DT, sp);
        if (i < ticks * 0.6) continue;
        ys.push(ship.position[1]);
        hs.push(sea.heightAt(ship.position[0], ship.position[2], sea.currentTime));
      }
      const mean = (a: number[]) => a.reduce((x, v) => x + v, 0) / a.length;
      const my = mean(ys);
      const mh = mean(hs);
      let num = 0;
      let dy = 0;
      let dh = 0;
      for (let i = 0; i < ys.length; i++) {
        num += (ys[i] - my) * (hs[i] - mh);
        dy += (ys[i] - my) ** 2;
        dh += (hs[i] - mh) ** 2;
      }
      // BOUND BY BAND, because heave RESONANCE sits inside this sweep and a
      // lag there is the physics, not the defect (§V.70). T_heave is 5.43 s,
      // i.e. λ ≈ 46 m, so λ40 is 7% off the hull's own natural period and any
      // hull with a real damping ratio lags the wave there. This assertion is
      // aimed at SIGN INVERSION — the old layout summed to −0.28 where the
      // integral is +0.10 and she rose INTO crests, a correlation near −1 —
      // and a resonance lag is a different animal at the other end of the
      // scale. MEASURED at ζ_heave,linear 0.90 → 0.36: λ40 0.856 → 0.680,
      // λ50 0.899 → 0.801, λ60 0.923 → 0.868, λ90 0.961 → 0.949, λ189 0.992 →
      // 0.994. Only the resonant end moves, and it stays firmly positive.
      //
      // Holding λ40 at 0.8 would have pinned ζ_heave,linear above ~0.54, and
      // that ratio is dead-beat: it is the difference between a hull that
      // reverberates after a slam and one that does not, which is the whole
      // of §V.70. It also costs almost nothing to give up — the RAO at λ40 is
      // 0.40, so this is a phase bound on a response the hull barely makes,
      // in a band that carries little of this sea's energy (mean λ ≈ 69 m,
      // swell 189 m).
      expect(num / Math.sqrt(dy * dh)).toBeGreaterThan(L <= 40 ? 0.5 : 0.8);
    }
    // and the selectivity survives: chop under half the hull's length is
    // still averaged away, or we bought the swell back by becoming a cork
    expect(rideIn(sineSea(amp, 12, [0, 1]), sp, amp).heave).toBeLessThan(0.15);
  });

  it('she rolls in a BEAM sea and much less in a following one', () => {
    // Roll that does not depend on heading is not roll, it is a wobble
    // animation. A wave running along the hull cannot roll her; one running
    // across her must. (Old numbers: beam 6.5°, following 0.9° — the ratio
    // was fine, the beam roll was the problem.)
    const beam = rideIn(sineSea(amp, 90, [1, 0]), sp, amp).rollDeg;
    const following = rideIn(sineSea(amp, 90, [0, 1]), sp, amp).rollDeg;
    expect(beam).toBeGreaterThan(8); // a 2 m beam swell lays her over
    expect(beam).toBeLessThan(35); // but she is not a dinghy
    expect(beam).toBeGreaterThan(following * 5);
  });

  it('roll RINGS: ζ ≈ 0.1, so she swings, and hard rolling still stops', () => {
    // The single number behind "it doesn't feel dynamic". A ship's roll
    // damping ratio is 0.05–0.10 and she swings for many cycles; this hull
    // measured 0.41 because ONE damper served heave, roll and pitch, so the
    // (correct) decision to damp heave hard pinned her upright.
    //
    // The second half is why the fix needed a nonlinear term: at a flat
    // ζ 0.10 the storm preset rolled her 180° — she went over. Damping that
    // rises with roll RATE keeps the swing at swell rates and kills it at
    // storm rates, which is what a real bilge does.
    const decayZeta = (startDeg: number): number => {
      const ocean = new CpuOcean(1, flatOceanParams(), sp);
      ocean.update(0);
      const ship = makeShip();
      ship.position[1] = equilibriumY(sp);
      ship.quaternion = quatFromAxisAngle([0, 0, 1], (startDeg * Math.PI) / 180);
      const peaks: number[] = [];
      let prev = 0;
      let prev2 = 0;
      for (let i = 0; i < 3600; i++) {
        stepShipBuoyancy(ship, ocean, DT, sp);
        const r = rollOf(ship);
        if (i > 1 && Math.abs(prev) > Math.abs(prev2) && Math.abs(prev) >= Math.abs(r)) {
          peaks.push(Math.abs(prev));
        }
        prev2 = prev;
        prev = r;
      }
      // log decrement over two half-cycles
      const d = Math.log(peaks[0] / peaks[2]);
      return d / Math.sqrt(4 * Math.PI * Math.PI + d * d);
    };
    const gentle = decayZeta(6);
    expect(gentle).toBeGreaterThan(0.05); // she does settle
    expect(gentle).toBeLessThan(0.18); // but she rings first
    // and a violent roll is damped HARDER — the nonlinear half is live
    expect(decayZeta(35)).toBeGreaterThan(gentle * 1.2);
  });

  it('the sea drives her FORWARD and BACK — the surge channel is not deaf', () => {
    // "It's maybe not interacting with the water enough." Buoyancy applied
    // no horizontal force at all: measured forward-acceleration RMS 0.000
    // m/s² in a swell, so her speed was a pure function of wind and drag
    // and the sea could not touch it. A hull on a wave face slides down it.
    const run = (gain: number): number => {
      const spx = testSeaParams({ waveSurgeGain: gain });
      const sea = sineSea(1.5, 90, [0, 1]);
      const ship = makeShip();
      ship.position[1] = equilibriumY(spx);
      let vMin = Infinity;
      let vMax = -Infinity;
      for (let i = 0; i < 3600; i++) {
        sea.update((i + 1) * DT);
        stepShipBuoyancy(ship, sea, DT, spx);
        if (i < 1800) continue;
        vMin = Math.min(vMin, ship.velocity[2]);
        vMax = Math.max(vMax, ship.velocity[2]);
      }
      return vMax - vMin;
    };
    // it is the SEA doing this: at gain 0 the horizontal channel is silent
    expect(run(0)).toBeLessThan(1e-9);
    const swing = run(seaPhysicsParams.waveSurgeGain);
    // MEASURED 0.56 m/s ≈ 1.1 knots of speed swing on a 1.5 m / λ90 swell.
    // It fell from 0.63 when the surge started reading the pressure head
    // instead of the surface (§V.68) — the horizontal pressure gradient
    // decays with depth exactly as the vertical one does, so a keel 2 m down
    // is pushed along a λ 90 face by 87% of what the surface slope suggests.
    expect(swing).toBeGreaterThan(0.4); // felt, not a rounding error
    expect(swing).toBeLessThan(8); // and not a surfboard
  });

  it('she takes the water "too heavily and too easily" no longer', () => {
    // NOTE ON WHAT THIS TEST IS FOR. It measures GREEN WATER — how deep and
    // how often the sea comes over a rail 2.6 m up — so its bounds are
    // absolutes on purpose: they are scaled by the ship's own freeboard,
    // which is the dimension the complaint is about (§V.66). It is NOT the
    // test for "she gets thrown around too easily", and it passed all the
    // way through that complaint. The selectivity claim — long swell kept,
    // short chop rejected — is a RATIO and lives in the §V.68 block; the
    // "she reverses too fast" claim is a time-domain statistic and lives in
    // §V.69. Three complaints, three different quantities.
    //
    // The user's second complaint, in the words they used. Freeboard is
    // 2.6 m above the ship-space waterline plane and she floats 0.44 m
    // below it, so immersion past 2.6 m IS green water over the rail.
    //
    // The complaint has two halves and both are asserted, because fixing
    // one alone is how you get the other: "too heavily" is how DEEP, and
    // "too easily" is how OFTEN. Old numbers in the shipped swell: peak
    // immersion 2.75–3.10 m, i.e. she buried the rail, because she rode
    // less than half of each passing swell instead of rising over it.
    // Swept over headings (§V.50): green water is a tail statistic and one
    // heading cannot pin it — measured spread across 8 headings × 4 seeds in
    // this sea is 0.00%–1.39%, so a single sample can land anywhere in it.
    // Same four headings on ONE mirror (see rideHeadings): the sea is a
    // function of t alone, so the old per-heading CpuOcean was recomputing
    // the identical 5400-tick IFFT sequence four times for numbers that
    // cannot differ. Immersion is (water − ship) tick by tick, which is
    // exactly the pair rideHeadings records, so nothing about WHAT is
    // measured or over how long it is measured changes here.
    const measure = (amplitude: number) => {
      const runs = rideHeadings(
        [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2],
        11,
        testOceanParams({ amplitude }),
        sp,
        5400,
        600,
      );
      const worsts: number[] = [];
      const unders: number[] = [];
      const sigmas: number[] = [];
      for (const r of runs) {
        const n = r.shipY.length;
        let worst = 0;
        let under = 0;
        let sum2 = 0;
        for (let i = 0; i < n; i++) {
          const h = r.waterY[i];
          const immersion = h - r.shipY[i];
          worst = Math.max(worst, immersion);
          if (immersion > 2.6) under++;
          sum2 += h * h;
        }
        worsts.push(worst);
        unders.push(under / n);
        sigmas.push(Math.sqrt(sum2 / n));
      }
      const med = (a: number[]) =>
        a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
      return {
        worst: Math.max(...worsts),
        underFrac: med(unders),
        underWorst: Math.max(...unders),
        sigma: med(sigmas),
      };
    };

    // the sea she is normally sailed in
    const swell = measure(oceanParams.amplitude);
    // guard: a calm sea would make this pass for free (§V.36 — measure
    // against the live sea, never an absolute metre gate)
    expect(swell.sigma).toBeGreaterThan(0.4);
    expect(swell.worst).toBeLessThan(2.6); // the rail stays dry, always
    // and "always" as a COUNT, which is the half of the complaint that says
    // "too easily" — at the sea she is actually sailed in, never once
    expect(swell.underWorst).toBe(0);
    // ...and she is not simply riding a foot proud of everything: the hull
    // DOES bury, it just does not drown. A ship that never wets her topsides
    // has stopped interacting with the water, which is complaint THREE.
    expect(swell.worst).toBeGreaterThan(1.0);

    // three times that energy: she may ship water, but rarely, and the
    // deck must not be a permanent feature of the waterline
    const heavy = measure(1.0);
    expect(heavy.sigma).toBeGreaterThan(swell.sigma * 1.5);
    // Median across headings plus a cap on the worst: a tail statistic needs
    // both, or one unlucky heading either fails it or hides in it.
    //
    // MEASURED 1.7% median here, and the bound is deliberately well above
    // that rather than tight to it. This sea has Hs ≈ 6.6 m against 2.6 m of
    // freeboard — the waves are two and a half times the height of her rail.
    // A hull that never shipped water in that would be the bug. The tight
    // assertion is the one above, at the sea she is actually sailed in,
    // where the answer is exactly zero; this one only has to catch "she is
    // swamped", and swamped starts a long way above 2%.
    expect(heavy.underFrac).toBeLessThan(0.05);
    expect(heavy.underWorst).toBeLessThan(0.08);
    // runaway guard, sized off the hull and not off the last measurement:
    // freeboard 2.6 + draft 2.0, i.e. she is never wholly under the sea
    expect(heavy.worst).toBeLessThan(4.6);
  });
});

/**
 * §V.53/§V.54 — the hull as a 35 m × 8.5 m ship, not as a set of numbers
 * that happen to produce ship-like periods.
 *
 * WHY this block exists: every constant in seaPhysics was individually
 * defensible and the ensemble was still a 150 t model of a 600 t ship, which
 * the user felt immediately ("a little bit too light… it can kinda catch
 * airtime over the waves") and no test could see, because every test asserted
 * an EFFECT and the effects had all been tuned to be right. These assert the
 * constants against the object instead, in dimensionless form, so they keep
 * their meaning through any future retune.
 */
describe('§V.53: the constants describe a real 35 m galleon', () => {
  const p = testSeaParams();
  const RHO = 1025;
  const G = 9.81;
  const LWL = 35.5; // waterline length the station model spans
  const BEAM = 8.5;

  it('displaces what a hull this size displaces', () => {
    // 150 t was a large yacht. The check is against the volume she actually
    // pushes aside: mass = ρ·∇, and ∇ is the waterplane times how deep she
    // sits in it.
    const immersion = -equilibriumDraft(p) + p.hullDraft;
    const Awp = p.buoyancySpring / (RHO * G);
    const volume = p.mass / RHO;
    expect(p.mass).toBeGreaterThan(4.5e5); // 450 t
    expect(p.mass).toBeLessThan(8e5); // 800 t
    // the waterplane is the one the hull actually has
    expect(Awp).toBeGreaterThan(0.6 * LWL * BEAM);
    expect(Awp).toBeLessThan(0.95 * LWL * BEAM);
    // and the three agree with each other: ∇ = A_wp · immersion is what
    // "she floats where she floats" means, and it is the identity that was
    // broken — 146 m³ of hull under a 302 m² waterplane is a raft
    expect(volume / (Awp * immersion)).toBeCloseTo(1, 1);
    // block coefficient of a tubby square-rigger, not a barge or a needle
    const cb = volume / (LWL * BEAM * immersion);
    expect(cb).toBeGreaterThan(0.5);
    expect(cb).toBeLessThan(0.9);
  });

  it('has the mass distribution of a ship, not of its own periods', () => {
    // Roll and pitch periods can be made right at ANY mass by moving the
    // inertias, and that is exactly what had happened. The gyradius is the
    // number that cannot be faked: it is a length, and it has to be a
    // fraction of the hull.
    const kPitch = Math.sqrt(p.inertiaPitch / p.mass);
    const kRoll = Math.sqrt(p.inertiaRoll / p.mass);
    expect(kPitch / LWL).toBeGreaterThan(0.2);
    expect(kPitch / LWL).toBeLessThan(0.4); // was 0.73·L
    // a square-rigger carries a lot of weight aloft, so she sits above the
    // 0.35–0.40·B of a merchant hull — but not at 1.32·B, which is a mast
    // with a boat attached
    expect(kRoll / BEAM).toBeGreaterThan(0.3);
    expect(kRoll / BEAM).toBeLessThan(0.7);
  });

  it('heaves at the period its own draft implies', () => {
    // 2π√(immersion·(1+a)/g) is not a target, it is what a floating body
    // DOES. Reading 2.30 s against a closed form of 4.91 s meant the hull
    // was bobbing at twice a ship's frequency — the "too light" complaint,
    // available as a one-line check the whole time.
    const immersion = -equilibriumDraft(p) + p.hullDraft;
    const closedForm =
      2 * Math.PI * Math.sqrt((immersion * (1 + p.addedMassHeave)) / G);
    const modelled =
      2 * Math.PI * Math.sqrt((p.mass * (1 + p.addedMassHeave)) / p.buoyancySpring);
    expect(modelled).toBeCloseTo(closedForm, 6);
    expect(modelled).toBeGreaterThan(4); // a ship, not a cork
    expect(modelled).toBeLessThan(7);
  });

  it('§V.54: she is never ballistic in the sea she is sailed in', () => {
    // "It can kinda catch airtime over the waves." A hull whose stations sit
    // on one plane loses ALL buoyancy 0.44 m above equilibrium and then
    // free-falls at exactly −g. Measured before the fix: 0% of ticks at
    // swell but peak vertical accelerations of 19.2 m/s² (2 g), and 15.4% of
    // ticks with 1.87 s of continuous air in storm.
    const op = testOceanParams({ amplitude: 1.0 }); // 3× the shipped swell
    const ocean = new CpuOcean(21, op, p);
    const ship = makeShip();
    ship.position[1] = equilibriumY(p);
    const stations = probeStations(p.probeSlices).stations;
    let unsupported = 0;
    let worstAccel = 0;
    let n = 0;
    for (let i = 0; i < 5400; i++) {
      const t = (i + 1) * DT;
      ocean.update(t);
      const vy = ship.velocity[1];
      let support = 0;
      for (const st of stations) {
        const r = rotateVec(ship.quaternion, st.local as Vec3);
        // the field the FORCE is built from (§V.68), not the surface: an
        // independent estimate of support has to be an estimate of the same
        // support, or it drifts from the model it is auditing
        const h = ocean.pressureHeadAt(
          ship.position[0] + r[0],
          ship.position[2] + r[2],
          t,
        );
        const d = h - (ship.position[1] + r[1]);
        const imm = Math.min(p.hullDraft + p.hullFreeboard, Math.max(0, d + p.hullDraft));
        support += st.weight * p.buoyancySpring * imm;
      }
      stepShipBuoyancy(ship, ocean, DT, p);
      if (i < 600) continue;
      n++;
      if (support < 0.02 * p.mass * 9.81) unsupported++;
      worstAccel = Math.max(worstAccel, Math.abs((ship.velocity[1] - vy) / DT));
    }
    expect(unsupported / n).toBeLessThan(0.005); // she stays in the water
    expect(worstAccel).toBeLessThan(2 * 9.81); // and is never flung out of it
    // guard: a hull that simply never moves would pass both of the above
    expect(worstAccel).toBeGreaterThan(1);
  });
});

/**
 * §B.34 — the mirror must hand the hull the sea that is on the screen.
 *
 * This is §V.8's own claim, and nothing was checking it. The mirror carries
 * the GPU's exact modes (the block extraction is bit-exact, verified below),
 * but it READ them through a half-texel offset scaled to its own 64² grid
 * while the GPU reads through one scaled to 512². The offset is a distance,
 * so the two disagreed by domain·(1/128 − 1/1024): 2.9 m at the old 420 m
 * cascade, and 6.90 m — a fifth of the hull — once the domain went to 1010 m
 * to carry the swell. The ship was floating on a sea a third of a beam away
 * from the one drawn, silently, for as long as the mirror has existed.
 */
describe('§B.34/§V.8: the mirrored sea IS the rendered sea', () => {
  // resolution 256 so a 256² mirror is legal (mirrorResolution ≤ resolution)
  const op = testOceanParams({ resolution: 256 });

  it('a coarse mirror agrees with a full-resolution one', () => {
    // Both carry identical modes — the reduced grid is the central block of
    // the same h0 — so ANY disagreement beyond reconstruction is a bug in
    // how the grid is addressed, which is exactly what this caught.
    const coarse = new CpuOcean(1337, op, testSeaParams({ mirrorResolution: 64 }));
    const fine = new CpuOcean(1337, op, testSeaParams({ mirrorResolution: 256 }));
    const t = 123.456;
    coarse.update(t);
    fine.update(t);
    const rng = createRng(7);
    let err2 = 0;
    let sig2 = 0;
    for (let i = 0; i < 900; i++) {
      const x = (rng() - 0.5) * 3000;
      const z = (rng() - 0.5) * 3000;
      const a = fine.heightAt(x, z, t);
      const b = coarse.heightAt(x, z, t);
      err2 += (a - b) * (a - b);
      sig2 += a * a;
    }
    const rel = Math.sqrt(err2 / sig2);
    // guard: a flat sea would pass any error bound for free (§V.36)
    expect(Math.sqrt(sig2 / 900)).toBeGreaterThan(0.3);
    // MEASURED: 0.062 m RMS on a σ = 1.0 m sea = 6.2%, all of it honest
    // reconstruction between the coarse grid's nodes. With the offset wrong
    // it was 0.58 m = 58%, and no amount of interpolation quality touched
    // it — the tell that the error was registration, not sampling.
    expect(rel).toBeLessThan(0.15);
  });

  it('rejects a mirror finer than the spectrum it extracts from', () => {
    // silent out-of-bounds reads, not an error, before this guard
    expect(() => extractCentralBlock(new Float32Array(16 * 16 * 4), 16, 32)).toThrow(
      /extractCentralBlock/,
    );
  });

  it('the block extraction drops no energy at the shipped domains', () => {
    // The header PROMISES the dropped modes are the zero-amplitude ones,
    // and that promise is a function of the domain, which moved 2.4×.
    for (let ci = 0; ci < MIRRORED_CASCADES; ci++) {
      const band = cascadeBand(ci, op.splitWavelengths);
      const full = generateH0(
        op.resolution,
        op.cascades[ci].domain,
        1337 + ci * 7919,
        op,
        band,
      );
      const N = op.resolution;
      const red = 64;
      const lo = (N - red) / 2;
      let kept = 0;
      let total = 0;
      for (let m = 0; m < N; m++) {
        for (let n = 0; n < N; n++) {
          const i = (m * N + n) * 4;
          const e = full[i] * full[i] + full[i + 1] * full[i + 1];
          total += e;
          if (n >= lo && n < lo + red && m >= lo && m < lo + red) kept += e;
        }
      }
      expect(total).toBeGreaterThan(0); // the band actually carries energy
      expect(kept / total).toBeCloseTo(1, 6); // …and all of it survives
    }
  });

  it('she LIFTS to the swell rather than letting it break over her', () => {
    // The swell train is long and deliberately low-steepness. λ 100–350 m is
    // where a hull should approach RAO 1.0 and ride IN STEP — that is what
    // makes a sea read as an ocean instead of a washing machine, and no
    // other bound in this file would notice if she ploughed through it.
    // MEASURED at the shipped 11 s / 189 m swell: RAO 1.095, phase
    // correlation 0.992, and in a swell-only sea heave/wave = 1.09 with
    // zero green water — she goes up with it, not through it.
    const sp = testSeaParams();
    const lambda = swellWavelengthFor(oceanParams.swellPeriod);
    expect(lambda).toBeGreaterThan(100); // it IS a long swell
    const r = rideIn(sineSea(1, lambda, [0, 1]), sp, 1);
    expect(r.heave).toBeGreaterThan(0.9);
    expect(r.heave).toBeLessThan(1.2);
    // and short chop, for contrast, still passes underneath her
    expect(rideIn(sineSea(1, 12, [0, 1]), sp, 1).heave).toBeLessThan(0.15);
  });
});
