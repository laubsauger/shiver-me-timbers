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
import {
  equilibriumDraft,
  probeStations,
  stepShipBuoyancy,
} from '../src/sea-physics/buoyancy';
import { quatFromAxisAngle, quatMul, rotateVec } from '../src/combat/quatMath';
import { createRng } from '../src/state/rng';
import type { ShipState, Vec3 } from '../src/state/simState';

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

  it('a ONE-STATION hull would be a cork (the guard is real)', () => {
    // fail loud: if this ever stops holding, the sea got so long-period
    // that the tests above pass for free and no longer defend anything.
    // The guard now collapses the hull to a single waterplane station,
    // because that is where the fore-aft selectivity actually comes from
    // (§B.22): the ∫ along 35 m of hull. Killing the footprint kernel no
    // longer makes a cork, and a test that only proved the kernel was
    // alive would defend a mechanism the ship no longer relies on.
    const cork = testSeaParams({
      probeSlices: 1,
      hullFootprintLength: 0,
      hullFootprintBeam: 0,
    });
    const chop = rideIn(sineSea(amp, 8, [0, 1]), cork, amp);
    expect(chop.heave).toBeGreaterThan(0.3);
    // and the shipped hull rejects the same ripple by ~an order of magnitude
    expect(rideIn(sineSea(amp, 8, [0, 1]), sp, amp).heave).toBeLessThan(
      chop.heave * 0.2,
    );
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
    // she RIDES long swell (λ ≥ 2·L) and does not amplify it
    for (let i = 0; i < band.length; i++) {
      if (band[i] >= 90) expect(rao[i]).toBeGreaterThan(0.85);
      expect(rao[i]).toBeLessThan(1.25);
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
      expect(num / Math.sqrt(dy * dh)).toBeGreaterThan(0.8);
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
      const ocean = new CpuOcean(1, testOceanParams({ amplitude: 0 }), sp);
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
    expect(swing).toBeGreaterThan(0.6); // felt, not a rounding error
    expect(swing).toBeLessThan(8); // and not a surfboard
  });

  it('she takes the water "too heavily and too easily" no longer', () => {
    // The user's second complaint, in the words they used. Freeboard is
    // 2.6 m above the ship-space waterline plane and she floats 0.44 m
    // below it, so immersion past 2.6 m IS green water over the rail.
    //
    // The complaint has two halves and both are asserted, because fixing
    // one alone is how you get the other: "too heavily" is how DEEP, and
    // "too easily" is how OFTEN. Old numbers in the shipped swell: peak
    // immersion 2.75–3.10 m, i.e. she buried the rail, because she rode
    // less than half of each passing swell instead of rising over it.
    const measure = (amplitude: number) => {
      const ocean = new CpuOcean(11, testOceanParams({ amplitude }), sp);
      const ship = makeShip();
      ship.position[1] = equilibriumY(sp);
      let worst = 0;
      let under = 0;
      let n = 0;
      let sum2 = 0;
      for (let i = 0; i < 5400; i++) {
        const t = (i + 1) * DT;
        ocean.update(t);
        stripPitchLikeSailing(ship); // real tick order (sailing runs first)
        stepShipBuoyancy(ship, ocean, DT, sp);
        if (i < 600) continue;
        const h = ocean.heightAt(ship.position[0], ship.position[2], t);
        const immersion = h - ship.position[1];
        worst = Math.max(worst, immersion);
        if (immersion > 2.6) under++;
        sum2 += h * h;
        n++;
      }
      return { worst, underFrac: under / n, sigma: Math.sqrt(sum2 / n) };
    };

    // the sea she is normally sailed in
    const swell = measure(oceanParams.amplitude);
    // guard: a calm sea would make this pass for free (§V.36 — measure
    // against the live sea, never an absolute metre gate)
    expect(swell.sigma).toBeGreaterThan(0.4);
    expect(swell.worst).toBeLessThan(2.6); // the rail stays dry, always
    // ...and she is not simply riding a foot proud of everything: the hull
    // DOES bury, it just does not drown. A ship that never wets her topsides
    // has stopped interacting with the water, which is complaint THREE.
    expect(swell.worst).toBeGreaterThan(1.0);

    // three times that energy: she may ship water, but rarely, and the
    // deck must not be a permanent feature of the waterline
    const heavy = measure(1.0);
    expect(heavy.sigma).toBeGreaterThan(swell.sigma * 1.5);
    expect(heavy.underFrac).toBeLessThan(0.01);
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
        const h = ocean.heightAt(ship.position[0] + r[0], ship.position[2] + r[2], t);
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
