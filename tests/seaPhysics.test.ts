/**
 * §V.8 sea-physics: the CPU spectrum mirror + buoyancy. These tests encode
 * WHY each mechanism exists: the mirror must reproduce the seeded GPU wave
 * math (or ships drift off the visible water), and the buoyancy integrator
 * must be stable and self-righting (or ships jitter, flip, or explode).
 */
import { describe, expect, it } from 'vitest';
import { generateButterfly, naiveIDFT } from '../src/ocean/oceanMath';
import { oceanParams, type OceanParams } from '../src/params/ocean';
import {
  seaPhysicsParams,
  type SeaPhysicsParams,
} from '../src/params/seaPhysics';
import { CpuOcean, cpuIFFT2D } from '../src/sea-physics/cpuOcean';
import { stepShipBuoyancy, PROBE_LAYOUT } from '../src/sea-physics/buoyancy';
import { quatFromAxisAngle, rotateVec } from '../src/combat/quatMath';
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
    // Choppiness 1.0: below the wave-folding regime (J>0) where the
    // fixed-point map is contractive — at λ→1.4 crests can fold and no
    // finite iteration count recovers a unique surface point.
    const op = testOceanParams({ choppiness: 1.0 });
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
      expect(Math.abs(found - s.height)).toBeLessThan(0.2);
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
