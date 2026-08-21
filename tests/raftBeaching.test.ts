/**
 * §T.100 raft beaching — WHY each block: a raft that sails THROUGH a beach
 * has no island to land on; one that stops dead at an invisible wall reads
 * as a collision, not a landing; and one that holds only approximately
 * creeps up the sand for as long as the trade wind blows (the sail's drive
 * is re-applied every tick from whatever velocity it finds — §raftBeaching
 * header). So: she grounds on a shelving apron, comes to rest, STAYS, and
 * leaves only when pushed. Properties, with limits read from the params
 * (§V80); GPU-free (§V88).
 */
import { describe, expect, it } from 'vitest';
import { accessibleRaftTuning } from '../src/params/raftSailing';
import { raftBeachingParams } from '../src/params/raftBeaching';
import { raftParams } from '../src/params/raft';
import { neutralRaftControls, stepRaftSailing, type RaftControls, type RaftMotion } from '../src/sailing/raftKinematics';
import {
  neutralRaftBeaching,
  pushOff,
  raftContactPoints,
  stepRaftBeaching,
  type RaftBeachingState,
} from '../src/sailing/raftBeaching';
import { raftLayout } from '../src/ship/raftPartsLayout';
import type { SeabedField } from '../src/sea-physics/grounding';
import type { Vec3 } from '../src/state/simState';

const DT = 1 / 60;
const B = raftBeachingParams;
const T = accessibleRaftTuning;
const POINTS = raftContactPoints();

/** a beach apron along +z: −10 m at z ≤ 0 rising linearly to +1 m at z ≥ 40 */
const RAMP: SeabedField = {
  heightAt: (_x, z) => -10 + 11 * Math.min(1, Math.max(0, z / 40)),
};
const DEEP: SeabedField = { heightAt: () => -5 };
/** a trade wind blowing toward +z — dead run onto the beach */
const TRADE = { direction: 0, speed: 7 };
const CALM = { direction: 0, speed: 0 };

function motion(z: number, speed: number): RaftMotion {
  return { position: [0, 0, z], yaw: 0, velocity: [0, 0, speed], yawRate: 0 };
}

interface Run {
  m: RaftMotion;
  b: RaftBeachingState;
  aground: boolean;
}

/** sail + beach for `seconds`, calling `each` after every tick */
function sail(
  m: RaftMotion,
  b: RaftBeachingState,
  controls: RaftControls,
  wind: { direction: number; speed: number },
  seabed: SeabedField,
  seconds: number,
  each?: (r: Run, t: number) => void,
): Run {
  let aground = false;
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    const s = stepRaftSailing(m, controls, wind, T, DT);
    const r = stepRaftBeaching(s, b, POINTS, seabed, DT);
    m = r.motion;
    b = r.beach;
    aground = r.aground;
    each?.({ m, b, aground }, (i + 1) * DT);
  }
  return { m, b, aground };
}

const speedOf = (m: RaftMotion): number => Math.hypot(m.velocity[0], m.velocity[2]);

describe('§T.100 the raft grounds on the apron and holds', () => {
  it('at 2 m/s with the trade behind her she grounds, stops (< beachHoldSpeed within 10 s) and is beached', () => {
    let tStop = Infinity;
    const r = sail(motion(22, 2), neutralRaftBeaching(), neutralRaftControls(), TRADE, RAMP, 10, (s, t) => {
      if (s.b.beached && tStop === Infinity) tStop = t;
    });
    expect(r.aground).toBe(true);
    expect(r.b.beached).toBe(true);
    expect(speedOf(r.m)).toBeLessThan(B.beachHoldSpeed);
    expect(tStop).toBeLessThan(10);
    // she came to rest ON the apron, not past it: the bow reached shallow water, the hold is where she stopped
    expect(r.b.hold).not.toBeNull();
    expect(r.m.position[2]).toBeCloseTo(r.b.hold![2], 12);
    // the log bottoms are in the sand somewhere, nowhere near the +1 m crest (she did not drive up the beach)
    expect(RAMP.heightAt(0, r.m.position[2] + raftLayout(raftParams).bowZ)).toBeLessThan(0.5);
  });

  it('beached with the wind still on, she does not drift: 60 s later she is within 0.2 m and has not yawed', () => {
    const landed = sail(motion(22, 2), neutralRaftBeaching(), neutralRaftControls(), TRADE, RAMP, 12);
    expect(landed.b.beached).toBe(true);
    const at: Vec3 = [...landed.m.position];
    const yaw = landed.m.yaw;
    // a beam wind and a hard-over oar, which would swing a floating raft, move a beached one not at all
    const controls = { ...neutralRaftControls(), oarAngle: 1 };
    let maxDrift = 0;
    const r = sail(landed.m, landed.b, controls, { direction: Math.PI / 2, speed: 9 }, RAMP, 60, (s) => {
      maxDrift = Math.max(maxDrift, Math.hypot(s.m.position[0] - at[0], s.m.position[2] - at[2]));
    });
    expect(maxDrift).toBeLessThan(0.2);
    expect(r.m.yaw).toBeCloseTo(yaw, 9);
    expect(r.b.beached).toBe(true);
    expect(speedOf(r.m)).toBe(0);
  });

  it('push-off: she backs off astern faster than 0.3 m/s, is no longer beached, and is afloat again once the grace ends', () => {
    const landed = sail(motion(22, 2), neutralRaftBeaching(), neutralRaftControls(), TRADE, RAMP, 12);
    expect(landed.b.beached).toBe(true);
    const shoved = pushOff(landed.m, landed.b);
    expect(shoved.beach.beached).toBe(false);
    expect(shoved.beach.release).toBeGreaterThan(0);
    // astern = −forward = −z at yaw 0
    expect(shoved.motion.velocity[2]).toBeLessThan(-0.3);
    // sail down — nobody pushes a raft off with the square sail drawing
    const controls = { ...neutralRaftControls(), sailUp: false };
    let minVz = 0;
    const r = sail(shoved.motion, shoved.beach, controls, CALM, RAMP, B.pushOffTime + 5, (s) => {
      minVz = Math.min(minVz, s.m.velocity[2]);
    });
    expect(minVz).toBeLessThan(-0.3);
    expect(r.aground).toBe(false);
    expect(r.b.beached).toBe(false);
    expect(r.m.position[2]).toBeLessThan(landed.m.position[2] - 0.5);
    // push-off on a raft that is not beached is a no-op that returns its inputs
    const again = pushOff(r.m, r.b);
    expect(again.motion).toBe(r.m);
    expect(again.beach).toBe(r.b);
  });

  it('over −5 m of water she never touches, never beaches, and the motion is exactly what sailing produced', () => {
    let m = motion(0, 2);
    let b = neutralRaftBeaching();
    const c = neutralRaftControls();
    for (let i = 0; i < 60 * 30; i++) {
      const s = stepRaftSailing(m, c, TRADE, T, DT);
      const r = stepRaftBeaching(s, b, POINTS, DEEP, DT);
      expect(r.aground).toBe(false);
      expect(r.grip).toBe(0);
      expect(r.motion.velocity).toEqual(s.velocity);
      expect(r.motion.position).toEqual(s.position);
      m = r.motion;
      b = r.beach;
    }
    expect(b.beached).toBe(false);
  });
});

describe('§T.100 contact points are the log bottoms', () => {
  const L = raftLayout(raftParams);

  it('every point lies within the log field in plan and below the log centrelines (under the deck), and there is at least one per log', () => {
    const maxR = Math.max(...L.logs.map((l) => l.r));
    const zMin = Math.min(...L.logs.map((l) => l.zStern));
    expect(POINTS.length).toBeGreaterThanOrEqual(L.logs.length * 2);
    for (const [x, y, z] of POINTS) {
      expect(Math.abs(x)).toBeLessThanOrEqual(L.halfBeam + 1e-9);
      expect(z).toBeGreaterThanOrEqual(zMin - 1e-9);
      expect(z).toBeLessThanOrEqual(L.bowZ + 1e-9);
      expect(y).toBeLessThan(raftParams.logAxisY);
      expect(y).toBeGreaterThanOrEqual(raftParams.logAxisY - maxR - 1e-9);
      expect(y).toBeLessThan(L.deckY);
    }
    const xs = new Set(POINTS.map(([x]) => x));
    expect(xs.size).toBe(L.logs.length);
  });

  it('points follow the raft params: a wider log spacing widens the contact field (§V71 — no baked geometry)', () => {
    const wide = raftContactPoints({ ...raftParams, chinkMin: raftParams.chinkMin + 0.5, chinkMax: raftParams.chinkMax + 0.5 });
    const span = (pts: Vec3[]): number => Math.max(...pts.map(([x]) => x)) - Math.min(...pts.map(([x]) => x));
    expect(span(wide)).toBeGreaterThan(span(POINTS) + 1);
  });
});

describe('§T.100 beaching is safe and deterministic', () => {
  it('a NaN velocity or position never becomes NaN state', () => {
    const bad: RaftMotion = { position: [NaN, 0, 22], yaw: NaN, velocity: [0, 0, NaN], yawRate: NaN };
    const r = stepRaftBeaching(bad, neutralRaftBeaching(), POINTS, RAMP, DT);
    for (const v of [...r.motion.position, ...r.motion.velocity, r.motion.yaw, r.motion.yawRate]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    const held = stepRaftBeaching(motion(30, 0), { beached: true, release: NaN, hold: [NaN, 0, 30], holdYaw: NaN }, POINTS, RAMP, NaN);
    for (const v of [...held.motion.position, held.motion.yaw]) expect(Number.isFinite(v)).toBe(true);
  });

  it('dt ≤ 0 and an empty point list change nothing', () => {
    const m = motion(30, 1);
    const b = neutralRaftBeaching();
    expect(stepRaftBeaching(m, b, POINTS, RAMP, 0).motion).toEqual(m);
    expect(stepRaftBeaching(m, b, [], RAMP, DT).motion).toEqual(m);
  });

  it('two identical runs produce identical state, tick for tick (§V2)', () => {
    const trace = (): string[] => {
      const out: string[] = [];
      sail(motion(22, 2), neutralRaftBeaching(), neutralRaftControls(), TRADE, RAMP, 15, (s) => {
        out.push(`${s.m.position.join(',')}|${s.m.velocity.join(',')}|${s.m.yaw}|${s.b.beached}|${s.b.release}`);
      });
      return out;
    };
    expect(trace()).toEqual(trace());
  });

  it('inputs are not mutated: the motion and beach handed in are the same afterwards', () => {
    const m = motion(34, 1.5);
    const b = neutralRaftBeaching();
    const mCopy = JSON.stringify(m);
    const bCopy = JSON.stringify(b);
    stepRaftBeaching(m, b, POINTS, RAMP, DT);
    expect(JSON.stringify(m)).toBe(mCopy);
    expect(JSON.stringify(b)).toBe(bCopy);
  });
});
