/**
 * §T W2a — the wake SOURCE CONTRACT (docs/wake/w2a-source-model.md §3).
 *
 * WHY: the wake is the reaction to each hull's own contact force (V-W2 /
 * proposed V101). If the samples drift from the force — a different station
 * rule, a lost support factor, a mis-scaled footprint — every wake in the game
 * is scaled by an error nobody can see, and the one-contact guarantee becomes a
 * second, tunable model. So these pin: ΣF_y of the samples IS buoyancy's
 * hydrostatic vertical force (and the speedboat contact's load), the splat
 * conserves it, the depth each sample forces at IS its own head, the raft's
 * wake comes from her waterplane with no speed knob, and the wave-making
 * resistance hump appears where ship hydrodynamics puts it.
 * The galleon amplitude calibration lives in tests/wakeCalibration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { quatFromAxisAngle, quatMul } from '../src/core/quat';
import { GRAVITY } from '../src/ocean/oceanMath';
import { brigantineSeaParams, raftSeaParams, seaPhysicsParams, type SeaPhysicsParams } from '../src/params/seaPhysics';
import { HullWater } from '../src/sea-physics/hullWater';
import { equilibriumDraft, stepShipBuoyancy } from '../src/sea-physics/buoyancy';
import type { OceanHeightField } from '../src/sea-physics/cpuOcean';
import { buildDeepVHull } from '../src/speedboat/hullMesh';
import type { ShipState } from '../src/state/simState';
import { hullWaterSamples, planingPatchSamples, stationSamples } from '../src/wake/stationSources';
import { SPEEDBOAT_PLANING, stationFrame, towPreset, towedShip, presetByName } from '../src/wake/wakeCalibration';
import { WAKE_RHO, WakeSolverCpu, WakeSourceBuffer, type HydroSample } from '../src/wake/wakeSolverMath';
import sourcesRaw from '../src/wake/stationSources.ts?raw';
import calibrationRaw from '../src/wake/wakeCalibration.ts?raw';

const FLAT_OCEAN: OceanHeightField = { currentTime: 0, heightAt: () => 0, pressureHeadAt: () => 0 };

/** a ship heaved, heeled and pitched off her marks, at rest — every station at a different immersion */
function disturbed(p: SeaPhysicsParams): ShipState {
  const ship = towedShip(p, 12.3);
  ship.position[1] = equilibriumDraft(p) - 0.15 * p.hullDraft;
  ship.position[2] = -4.1;
  const heel = quatFromAxisAngle([0, 0, 1], 0.09);
  const pitch = quatFromAxisAngle([1, 0, 0], -0.035);
  ship.quaternion = quatMul(quatMul(ship.quaternion, pitch), heel);
  return ship;
}

/** splat a vessel into a solver big enough to hold her; returns ∫ρg·head dA */
function splatIntegral(samples: readonly HydroSample[], cx: number, cz: number, n: number, texel: number): number {
  const s = new WakeSolverCpu({ n, texel });
  s.setCenter(cx, cz);
  const buf = new WakeSourceBuffer();
  expect(buf.pushVessel(samples)).toBe(samples.length);
  s.splat(buf);
  let sum = 0;
  for (const h of s.head) sum += h;
  return sum * WAKE_RHO * GRAVITY * texel * texel;
}

describe('V-W2 / V101 one contact: station samples carry exactly buoyancy’s hydrostatic force', () => {
  for (const [name, p] of [
    ['galleon', seaPhysicsParams],
    ['brigantine', brigantineSeaParams],
    ['raft', raftSeaParams],
  ] as const) {
    it(`${name}: ΣF_y(samples) = stepShipBuoyancy’s vertical force ±1%, and the splat conserves it ±1%`, () => {
      // added mass and the entry exchange off: then Δv·m/dt + m·g is exactly the
      // station force sum; at rest in still water the dampers read zero
      const q: SeaPhysicsParams = { ...p, addedMassHeave: 0, slamEntryDepth: 0, waveSurgeGain: 0 };
      const ship = disturbed(q);
      const samples = stationSamples(ship, q);
      const sumFy = samples.reduce((a, s) => a + s.fy, 0);
      const probe = disturbed(q);
      const dt = 1e-4;
      stepShipBuoyancy(probe, FLAT_OCEAN, dt, q);
      const buoyancyFy = (probe.velocity[1] / dt) * q.mass + q.mass * GRAVITY;
      expect(sumFy).toBeGreaterThan(0.5 * q.mass * GRAVITY); // she is really floating
      expect(Math.abs(sumFy / buoyancyFy - 1)).toBeLessThan(0.01);
      const frame = stationFrame(q);
      const texel = 0.5;
      const n = Math.max(64, 2 ** Math.ceil(Math.log2((frame.length + 24) / texel)));
      const integral = splatIntegral(samples, ship.position[0], ship.position[2], n, texel);
      expect(Math.abs(integral / sumFy - 1)).toBeLessThan(0.01);
    });
  }

  it('each station forces at its OWN head: fy = ρg·depth·A_plan (smithDepthScale 1), so depth cannot be tuned apart from force', () => {
    for (const p of [seaPhysicsParams, brigantineSeaParams, raftSeaParams]) {
      expect(p.smithDepthScale).toBe(1);
      for (const s of stationSamples(disturbed(p), p)) {
        const area = 4 * s.footprint * s.footprint; // footprint = √A/2
        if (area === 0) {
          expect(s.fy).toBe(0); // a station with no plan under it (raft log gaps) carries nothing
          continue;
        }
        if (s.fy === 0) {
          expect(s.depth).toBe(0);
          continue;
        }
        expect(Math.abs(s.fy / (WAKE_RHO * GRAVITY * s.depth * area) - 1)).toBeLessThan(1e-3);
      }
    }
    // and the depth that is used at rest is the flat-calm immersion m·g/K, not the loft draft
    const level = stationSamples(towedShip(seaPhysicsParams, 0), seaPhysicsParams);
    const immersion = (seaPhysicsParams.mass * GRAVITY) / seaPhysicsParams.buoyancySpring;
    for (const s of level) expect(s.depth).toBeCloseTo(immersion, 6);
  });

  it('speedboat: the contact’s plan-column wake samples sum to its vertical load and splat to it ±1%', () => {
    const hull = buildDeepVHull();
    const hw = new HullWater(hull, { planing: false, viscous: false });
    const state = { position: [3.2, -0.25, -1.7] as [number, number, number], quaternion: quatFromAxisAngle([1, 0, 0], 0.02), velocity: [0, 0, 0] as [number, number, number], angularVelocity: [0, 0, 0] as [number, number, number] };
    hw.samplePatch(() => 0, state, 1 / 60);
    hw.evaluate(state, 1 / 60);
    const samples = hullWaterSamples(hw.wake);
    expect(samples.length).toBeGreaterThan(0);
    for (const s of samples) expect(s.depth).toBeGreaterThanOrEqual(0);
    const sumFy = samples.reduce((a, s) => a + Math.max(0, s.fy), 0);
    expect(hw.load.force[1]).toBeGreaterThan(0.3 * hull.mass * GRAVITY);
    expect(Math.abs(sumFy / hw.load.force[1] - 1)).toBeLessThan(0.01);
    expect(Math.abs(splatIntegral(samples, 3, -2, 128, 0.25) / sumFy - 1)).toBeLessThan(0.01);
  });

  it('planing proxy carries the boat’s weight and is deepest at the transom (Kutta: no pressure there)', () => {
    const s = planingPatchSamples(SPEEDBOAT_PLANING, 0, 0, 1, 0);
    const sum = s.reduce((a, q) => a + q.fy, 0);
    expect(Math.abs(sum / (SPEEDBOAT_PLANING.mass * GRAVITY) - 1)).toBeLessThan(1e-9);
    const aft = s.filter((q) => q.x < 1);
    const fwd = s.filter((q) => q.x > SPEEDBOAT_PLANING.wettedLength - 1);
    expect(Math.max(...aft.map((q) => q.fy))).toBeLessThan(Math.min(...fwd.map((q) => q.fy)));
    expect(Math.min(...aft.map((q) => q.depth))).toBeGreaterThan(Math.max(...fwd.map((q) => q.depth)));
  });
});

describe('V71 / W3: the raft’s wake is her own waterplane’s, with no speed knob', () => {
  /**
   * WHY: T161(a)'s `speedScale` made the raft's drawn wake 0.62 m while
   * buoyancy felt 0.16 m (w0-measurement §1). The sim wake must need no raft
   * constant at all: the wavelength is ω² = gk's and the strength is her weight.
   */
  it('source strength is her weight from her own plan; no wake source file references speedScale', () => {
    const samples = stationSamples(towedShip(raftSeaParams, 0), raftSeaParams);
    const sum = samples.reduce((a, s) => a + s.fy, 0);
    expect(Math.abs(sum / (raftSeaParams.mass * GRAVITY) - 1)).toBeLessThan(0.01);
    for (const src of [sourcesRaw, calibrationRaw]) {
      expect(src).not.toMatch(/speedScale|raftWakeParams/);
    }
  });

  it('2 m/s: transverse wavelength astern = 2πU²/g ± 10%', () => {
    const preset = { ...presetByName('raft-2'), n: 128 };
    const tow = towPreset(preset, { dt: 0.05, duration: 30 });
    const s = tow.solver;
    const lambda = (2 * Math.PI * preset.speed ** 2) / GRAVITY;
    // centreline, from 1.5 λ aft of the transom to the interior's aft edge
    const aftEdge = s.centerX - 0.35 * s.domain;
    const crossings: number[] = [];
    const x0 = tow.x + tow.frame.transom - 1.5 * lambda;
    let prev = s.surfaceAt(x0, 0);
    for (let x = x0 - 0.05; x > aftEdge; x -= 0.05) {
      const v = s.surfaceAt(x, 0);
      if (prev < 0 && v >= 0) crossings.push(x + 0.05 * (v / (v - prev)));
      prev = v;
    }
    expect(crossings.length).toBeGreaterThanOrEqual(5);
    const measured = (crossings[0] - crossings[crossings.length - 1]) / (crossings.length - 1);
    expect(Math.abs(measured / lambda - 1)).toBeLessThan(0.1);
  });
});

describe('wave-making resistance: the hump near Fn_L ≈ 0.5 emerges', () => {
  it('waveResistance (Parseval) equals the spatial ∫ρg·h·∂ζ/∂x dA of a surface source', () => {
    // WHY: the hump below is read through this diagnostic; a sign or N² slip
    // in it would invent or hide the hump. Depth 0, so h' = h exactly.
    const s = new WakeSolverCpu({ n: 64, texel: 0.5 });
    const buf = new WakeSourceBuffer();
    for (let k = 0; k < 40; k++) {
      buf.clear();
      buf.push(-6 + 0.15 * k, 1.3, 4e4, 1.2, 0);
      s.splat(buf);
      s.step(0.05, { slope: true });
    }
    let spatial = 0;
    for (let i = 0; i < s.head.length; i++) spatial += s.head[i] * s.slopeX[i];
    spatial *= WAKE_RHO * GRAVITY * s.texel * s.texel;
    expect(Math.abs(spatial)).toBeGreaterThan(10);
    expect(Math.abs(s.waveResistance(1, 0) / spatial - 1)).toBeLessThan(1e-3);
  });

  /**
   * WHY: the classic displacement-ship resistance curve is a PROPERTY of a
   * finite hull in a dispersive sea — bow and stern systems interfere, and the
   * wave-resistance coefficient R/(Δ·Fn²) rises steeply to a main hump near
   * Fn_L 0.5 (λ_T ≈ 1.6 L) and falls beyond it. Nothing authored may put it
   * there. Measured with Havelock's R = ∫ρg·h'·∂η/∂x dA on a coarse 256 m tier
   * (128² × 2 m: the hump is carried by λ ≥ 20 m), time-averaged over 8 s.
   * The ≥ 3 rise also needs the keel-depth attenuation: a surface pressure
   * gives only 2.0 (measured), because it over-radiates the short low-Fn waves.
   */
  const coefficient = (fn: number): number => {
    const p = seaPhysicsParams;
    const L = stationFrame(p).length;
    const U = fn * Math.sqrt(GRAVITY * L);
    const preset = { name: 'hump', kind: 'galleon' as const, speed: U, n: 128, texel: 2 };
    const duration = (1.4 * 256) / U + 10;
    let sum = 0;
    let count = 0;
    towPreset(preset, {
      dt: Math.min(0.1, (0.4 * 2 * Math.SQRT2) / U),
      duration,
      hook: (t, time) => {
        if (time > duration - 8) {
          sum += t.solver.waveResistance(1, 0);
          count++;
        }
      },
    });
    return sum / count / (p.mass * GRAVITY * fn * fn);
  };

  it('R/(Δ·Fn²) at Fn 0.55 ≥ 3× its Fn 0.35 value, and falls again by Fn 0.75', () => {
    const low = coefficient(0.35);
    const hump = coefficient(0.55);
    const past = coefficient(0.75);
    expect(low).toBeGreaterThan(0);
    expect(hump / low).toBeGreaterThanOrEqual(3);
    expect(past / hump).toBeLessThan(0.8);
  }, 30_000);
});
