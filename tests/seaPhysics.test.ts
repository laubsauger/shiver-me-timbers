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
  generateButterfly,
  naiveIDFT,
  spectralSteepness,
} from '../src/ocean/oceanMath';
import { weatherPresets } from '../src/weather/presets';
import { oceanParams, type OceanParams } from '../src/params/ocean';
import {
  seaPhysicsParams,
  type SeaPhysicsParams,
} from '../src/params/seaPhysics';
import { CpuOcean, cpuIFFT2D } from '../src/sea-physics/cpuOcean';
import { stepShipBuoyancy, PROBE_LAYOUT } from '../src/sea-physics/buoyancy';
import { quatFromAxisAngle, quatMul, rotateVec } from '../src/combat/quatMath';
import { createRng } from '../src/state/rng';
import type { ShipState } from '../src/state/simState';

const DT = 1 / 60;

/** small configs so tests run fast; bands still fit the mirror grid */
function testOceanParams(over: Partial<OceanParams> = {}): OceanParams {
  return { ...oceanParams, resolution: 128, ...over };
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

/** equilibrium draft: all probes submerged, N·k·d = m·g */
function equilibriumY(p: SeaPhysicsParams): number {
  return -(p.mass * 9.81) / (PROBE_LAYOUT.length * p.buoyancySpring);
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
  const op = testOceanParams({ amplitude: 0 });
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

  it('tilted ship rights itself: roll decays toward upright', () => {
    // WHY: righting must EMERGE from probe geometry (§V.8) — if the probe
    // torque sign or inertia frame is wrong the ship capsizes instead.
    const ocean = new CpuOcean(1, op, sp);
    ocean.update(0);
    const ship = makeShip();
    ship.position[1] = equilibriumY(sp);
    ship.quaternion = quatFromAxisAngle([0, 0, 1], 0.35); // roll about forward
    const upStart = rotateVec(ship.quaternion, [0, 1, 0])[1];
    for (let i = 0; i < 900; i++) stepShipBuoyancy(ship, ocean, DT, sp);
    const upEnd = rotateVec(ship.quaternion, [0, 1, 0])[1];
    expect(upEnd).toBeGreaterThan(upStart);
    expect(upEnd).toBeGreaterThan(0.998); // ≈ upright
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

describe('feel targets: ponderous but ALIVE in a swell', () => {
  // One shared 40 s storm-swell run (amplitude 1.0): sea state + ship
  // trajectory sampled per tick. Cheap tests then assert each feel target.
  const op = testOceanParams({ amplitude: 1.0 });
  const sp = testSeaParams();
  const ocean = new CpuOcean(7, op, sp);
  const ship = makeShip();
  ship.position[1] = equilibriumY(sp);
  const shipY: number[] = [];
  const waterY: number[] = [];
  const pitches: number[] = [];
  const rolls: number[] = [];
  const settle = 600; // discard 10 s transient
  for (let i = 0; i < 2400; i++) {
    const t = (i + 1) * DT;
    ocean.update(t);
    stripPitchLikeSailing(ship); // real main.ts tick order (sailing first)
    stepShipBuoyancy(ship, ocean, DT, sp);
    if (i < settle) continue;
    shipY.push(ship.position[1]);
    waterY.push(ocean.heightAt(ship.position[0], ship.position[2], t));
    pitches.push(pitchOf(ship));
    rolls.push(rollOf(ship));
  }
  const std = (a: number[]) => {
    const m = a.reduce((s, v) => s + v, 0) / a.length;
    return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length);
  };

  it('the sea itself is rough enough for these assertions to mean anything', () => {
    // fail loud (guard for every test below): a param change that calms
    // the mirrored sea would green-wash the feel targets
    expect(std(waterY)).toBeGreaterThan(0.25);
  });

  it('ship pitches visibly into swells DESPITE sailing stripping pitch each tick', () => {
    // WHY: user report "never tips forward/backward — feels like improper
    // probes". Sailing recomposes yaw∘heel 60×/s; buoyancy must persist
    // its own pitch or the bow never rises/dips more than ω·dt ≈ 0.05°.
    const maxPitchDeg = (Math.max(...pitches.map(Math.abs)) * 180) / Math.PI;
    expect(maxPitchDeg).toBeGreaterThan(2);
    // ...but ponderous, not dinghy-snappy ("bobbing like 10 grams")
    expect(maxPitchDeg).toBeLessThan(15);
  });

  it('hull rides UP with a passing swell instead of letting it roll over the deck', () => {
    // WHY: user report "way too static — waves roll OVER the boat".
    // Damping relative to the surface lets heave track the swell: the
    // ship's vertical excursion must carry most of the water's.
    expect(std(shipY)).toBeGreaterThan(0.6 * std(waterY));
    // deck (freeboard 2.6 m above the waterline plane) stays above water
    // except rare big-wave washes
    const submergedTicks = waterY.filter((h, i) => h > shipY[i] + 2.6).length;
    expect(submergedTicks / waterY.length).toBeLessThan(0.02);
  });

  it('swell actually rolls the ship (angularDamping must not pin it upright)', () => {
    const maxRollDeg = (Math.max(...rolls.map(Math.abs)) * 180) / Math.PI;
    expect(maxRollDeg).toBeGreaterThan(1);
    expect(maxRollDeg).toBeLessThan(20);
  });
});

describe('feel targets: roll period (calm-water free decay)', () => {
  it('rolls with a ~6-8 s natural period, swinging several cycles', () => {
    // WHY: many-tons galleon feel — 1.4e7 roll inertia gave a ~4 s yacht
    // wobble; too much damping would stop the swing dead (static ship).
    const op = testOceanParams({ amplitude: 0 });
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
function sineSea(amp: number, lambda: number, dir: [number, number]) {
  const k = (2 * Math.PI) / lambda;
  const omega = Math.sqrt(9.81 * k);
  let t = 0;
  return {
    period: (2 * Math.PI) / omega,
    get currentTime(): number {
      return t;
    },
    update(time: number): void {
      t = time;
    },
    heightAt(x: number, z: number, time: number): number {
      return amp * Math.sin(k * (dir[0] * x + dir[1] * z) - omega * time);
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
    expect(chop.pitchDeg).toBeLessThan(0.2);
    expect(swell.pitchDeg).toBeGreaterThan(1.5);
  });

  it('short BEAM chop barely rolls the hull, beam swell rolls it properly', () => {
    // the fore-aft footprint can do nothing about crests running parallel
    // to the hull — that is what hullFootprintBeam is for
    const chop = rideIn(sineSea(amp, 8, [1, 0]), sp, amp);
    const swell = rideIn(sineSea(amp, 60, [1, 0]), sp, amp);
    expect(chop.rollDeg).toBeLessThan(0.5);
    expect(swell.rollDeg).toBeGreaterThan(4);
  });

  it('point-sampling the surface WOULD make it a cork (the guard is real)', () => {
    // fail loud: if this ever stops holding, the sea got so long-period
    // that the tests above pass for free and no longer defend anything
    const cork = testSeaParams({ hullFootprintLength: 0, hullFootprintBeam: 0 });
    const chop = rideIn(sineSea(amp, 8, [0, 1]), cork, amp);
    expect(chop.heave).toBeGreaterThan(0.3);
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
      const ocean = new CpuOcean(1, testOceanParams({ amplitude: 0 }), sp);
      ocean.update(0);
      const ship = makeShip();
      ship.position[1] = equilibriumY(sp) + 0.3; // pluck it, let it ring
      const crossings: number[] = [];
      let prev = ship.position[1] - equilibriumY(sp);
      for (let i = 0; i < 1200; i++) {
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
    expect(cork.period).toBeGreaterThan(1.1);
    expect(cork.period).toBeLessThan(1.6); // √(g/draft), the cork bound
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
      const s = spectralSteepness(p.resolution, p.cascades[i].domain, p, cascadeBand(i, p.splitWavelengths));
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
    // fail loud: if no preset ever folds, a broken cap would look identical
    // to a working one here
    const capped = (['calm', 'swell', 'storm'] as const).filter((n) => {
      const op = testOceanParams({ ...weatherPresets[n].ocean });
      return gpuLambda(op) < op.choppiness - 1e-9;
    });
    expect(capped.length).toBeGreaterThan(0);
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
    for (let i = 0; i < 20; i++) {
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
