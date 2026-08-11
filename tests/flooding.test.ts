/**
 * T18 flooding (§V14) WHY tests: pumps must win against nothing (early
 * hits recoverable) but lose to a riddled hull (sinking is earnable);
 * dry holes must not flood (roll decides which breaches matter, §V8);
 * the sink sequence must be one-way and monotone (no popping back up);
 * everything deterministic (§V2) and list torque must tilt the ship
 * toward the flooded side, not away from it.
 */
import { describe, expect, it } from 'vitest';
import {
  buoyancyScale,
  floodListTorque,
  floodMassFactor,
  isSinking,
  stepFlooding,
  type FloodingHole,
} from '../src/sea-physics/flooding';
import type { FloodingParams } from '../src/params/flooding';
import type { ShipState } from '../src/state/simState';

const DT = 1 / 60;

/** fixed params so tests don't drift when tuning defaults in the panel */
const P: FloodingParams = {
  ingressRatePerHole: 0.02,
  depthFactor: 0.5,
  pumpRate: 0.03,
  sinkThreshold: 0.6,
  sinkDuration: 12,
  listStrength: 1,
  massGain: 0.8,
  sunkDepth: 14,
  sunkDrag: 0.9,
  founderFraction: 0.6,
};

function ship(flood = 0): ShipState {
  return {
    id: 's', kind: 'player',
    position: [0, 0, 0], quaternion: [0, 0, 0, 1],
    velocity: [0, 0, 0], angularVelocity: [0, 0, 0],
    rudder: 0, sailTrim: 0, flood, damage: {},
  };
}

function run(s: ShipState, holes: FloodingHole[], seconds: number): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) stepFlooding(s, holes, DT, P);
}

describe('stepFlooding (§V14)', () => {
  it('no holes → pumps drain flood to 0, never below (early hits recoverable)', () => {
    const s = ship(0.3);
    run(s, [], 60);
    expect(s.flood).toBe(0);
  });

  it('ingress is per-hole proportional — three holes flood faster than one', () => {
    const one = ship();
    const three = ship();
    const hole: FloodingHole = [3, -2, 0]; // 2 m below waterline
    run(one, [hole], 5);
    run(three, [hole, [-3, -2, 0], [0, -2, 8]], 5);
    expect(three.flood).toBeGreaterThan(one.flood);
    // Σ rule: net1 = r(1) − pump = 0.01/s, net3 = 3·r(1) − pump = 0.09/s
    expect(three.flood / one.flood).toBeCloseTo(9, 3);
  });

  it('deeper hole floods faster (hydrostatic head)', () => {
    const shallow = ship();
    const deep = ship();
    run(shallow, [[3, -1, 0]], 5);
    run(deep, [[3, -3, 0]], 5);
    expect(deep.flood).toBeGreaterThan(shallow.flood);
  });

  it('hole above the waterline contributes nothing — roll decides what floods', () => {
    const s = ship();
    run(s, [[3, 1.5, 0]], 30);
    expect(s.flood).toBe(0);
  });

  it('one shallow hole: pump ≥ ingress, equilibrium below threshold (recoverable)', () => {
    const s = ship(0.3);
    run(s, [[3, -0.5, 0]], 120); // ingress 0.025/s < pump 0.03/s
    expect(s.flood).toBeLessThan(P.sinkThreshold);
    expect(isSinking(s, P)).toBe(false);
    expect(s.flood).toBe(0); // pumps actually win, not merely stall
  });

  it('three holes overwhelm the pumps → flood crosses sinkThreshold (doomed)', () => {
    const s = ship();
    const holes: FloodingHole[] = [[3, -2, 0], [-3, -2, 0], [0, -2, 8]];
    run(s, holes, 8); // net +0.09/s → past 0.6 threshold, well short of 1
    expect(isSinking(s, P)).toBe(true);
    expect(s.flood).toBeLessThan(1);
    // one-way: even if the sea calms (no submerged holes), pumps cannot recover
    const atThreshold = s.flood;
    run(s, [], 5);
    expect(s.flood).toBeGreaterThan(atThreshold);
  });

  it('deterministic (§V2): same holes + dt → identical flood trajectory', () => {
    const trace = (): number[] => {
      const s = ship();
      const out: number[] = [];
      for (let i = 0; i < 600; i++) {
        stepFlooding(s, [[3, -2, 0], [-3, -1, 4]], DT, P);
        out.push(s.flood);
      }
      return out;
    };
    expect(trace()).toEqual(trace());
  });
});

describe('sink sequence (§V14, §V8 hooks)', () => {
  it('buoyancyScale is 1 while recoverable, then ramps monotonically 1→0', () => {
    const s = ship(0.5);
    expect(buoyancyScale(s, P)).toBe(1);
    run(s, [[3, -2, 0], [-3, -2, 0], [0, -2, 8]], 5); // push past threshold
    expect(isSinking(s, P)).toBe(true);
    let prev = buoyancyScale(s, P);
    expect(prev).toBeLessThanOrEqual(1);
    for (let i = 0; i < Math.round(2 * P.sinkDuration / DT); i++) {
      stepFlooding(s, [], DT, P); // sinkDuration ramp needs no holes
      const scale = buoyancyScale(s, P);
      expect(scale).toBeLessThanOrEqual(prev); // fade never pops back up
      prev = scale;
    }
    expect(s.flood).toBe(1); // clamped, not overshooting
    expect(prev).toBe(0); // fully sunk = zero support
  });

  it('flooded ship is heavier — mass factor grows with flood (rides lower)', () => {
    expect(floodMassFactor(0, P)).toBe(1);
    expect(floodMassFactor(1, P)).toBeCloseTo(1 + P.massGain, 12);
    expect(floodMassFactor(0.5, P)).toBeGreaterThan(floodMassFactor(0.2, P));
  });
});

describe('floodListTorque (§V14 list/trim)', () => {
  it('starboard hole → roll couple sinks the starboard side (−z torque)', () => {
    const t = floodListTorque(ship(0.5), [[4, -1, 0]], 0.5, P);
    // torque = r̄ × down: about +z (forward), negative sense tips +x under
    expect(t[2]).toBeLessThan(0);
    expect(t[0]).toBe(0);
  });

  it('bow hole → trim couple buries the bow (+x torque)', () => {
    const t = floodListTorque(ship(0.5), [[0, -1, 15]], 0.5, P);
    // about +x (beam), positive sense rotates +z (bow) toward −y
    expect(t[0]).toBeGreaterThan(0);
    expect(t[2]).toBe(0);
  });

  it('no flood, or only dry holes → zero couple', () => {
    expect(floodListTorque(ship(0), [[4, -1, 0]], 0, P)).toEqual([0, 0, 0]);
    expect(floodListTorque(ship(0.5), [[4, 2, 0]], 0.5, P)).toEqual([0, 0, 0]);
  });
});
