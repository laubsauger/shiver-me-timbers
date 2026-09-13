/**
 * §T.184 swept gate crossing and turn-mark rounding (§V107, §V80).
 *
 * WHY these properties:
 * - a boat at 60 m/s moves 0.5 m per substep; if the test looks at positions instead of the
 *   segment between them, a 1 m gate is skipped at some phases and double-counted at others,
 *   so a lap silently goes missing or a gate is credited twice — exactly-once over random phases;
 * - passing OUTSIDE a pole must not count, however close, or gates stop being a line;
 * - crossing backwards must not count, or a spin-and-return farms gates;
 * - a turn mark is rounded only by going around it on the side the course demands, outside
 *   its radius: cutting inside, passing on the other side or circling the wrong way must fail.
 */
import { describe, expect, it } from 'vitest';
import { gateCrossing, markRoundingPoles, segmentCrossesPoles } from '../src/race/gates';
import type { Gate, TurnMark, Vec2 } from '../src/race/types';

// course direction +z: left pole to port (−x), right to starboard (+x)
const gate1m: Gate = { id: 'g', left: [-0.5, 0], right: [0.5, 0], sector: 'exposed' };

/** deterministic LCG, no Math.random (§V2) */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function countCrossings(gate: Gate, path: Vec2[]) {
  let fwd = 0;
  let rev = 0;
  for (let i = 1; i < path.length; i++) {
    const c = gateCrossing(gate, path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
    if (c?.dir === 'forward') fwd++;
    if (c?.dir === 'reverse') rev++;
  }
  return { fwd, rev };
}

/** substep positions of a boat at `speed` crossing z = 0 along x = `x`, heading ±z */
function straightRun(speed: number, phase: number, x: number, dirZ: 1 | -1, substeps = 2): Vec2[] {
  const step = (speed / 60) / substeps;
  const pts: Vec2[] = [];
  for (let k = -40; k <= 40; k++) pts.push([x, dirZ * (k + phase) * step]);
  return pts;
}

describe('§T.184 swept gate crossing', () => {
  it('a boat at 5…60 m/s through a 1 m gate registers exactly once at 1000 random phases', () => {
    const rnd = lcg(184);
    for (let i = 0; i < 1000; i++) {
      const speed = 5 + 55 * rnd();
      const phase = rnd();
      const x = (rnd() - 0.5) * 0.98;
      const { fwd, rev } = countCrossings(gate1m, straightRun(speed, phase, x, 1));
      expect(fwd, `speed ${speed} phase ${phase}`).toBe(1);
      expect(rev).toBe(0);
    }
  });

  it('a substep that lands exactly on the gate line counts once, not twice or never', () => {
    const { fwd } = countCrossings(gate1m, straightRun(60, 0, 0, 1));
    expect(fwd).toBe(1);
  });

  it('a fast boat between two substeps counts although no position is near the line', () => {
    // 60 m/s at one substep per tick: 1 m jumps, neither endpoint within 0.4 m of the gate
    const c = gateCrossing(gate1m, 0.1, -0.45, 0.2, 0.55);
    expect(c?.dir).toBe('forward');
    // and a diagonal chord that crosses between the poles
    expect(gateCrossing(gate1m, -3, -1, 3, 1)?.dir).toBe('forward');
  });

  it('tunnelling past a pole or outside it does not count', () => {
    // crossing the gate line 0.05 m outside the right pole at 60 m/s
    expect(countCrossings(gate1m, straightRun(60, 0.3, 0.55, 1)).fwd).toBe(0);
    // a chord whose endpoints bracket the line but which meets it outside the left pole
    expect(gateCrossing(gate1m, -2, -0.5, -0.2, 0.5)).toBeNull();
    // while the same chord shifted to meet it inside does count (the test above is not vacuous)
    expect(gateCrossing(gate1m, -1.3, -0.5, 0.5, 0.5)?.dir).toBe('forward');
  });

  it('crossing against the course direction never counts as a pass', () => {
    const rnd = lcg(7);
    for (let i = 0; i < 200; i++) {
      const { fwd, rev } = countCrossings(gate1m, straightRun(5 + 55 * rnd(), rnd(), 0, -1));
      expect(fwd).toBe(0);
      expect(rev).toBe(1);
    }
  });

  it('course direction follows the poles: swapping them reverses what counts', () => {
    const swapped: Gate = { ...gate1m, left: gate1m.right, right: gate1m.left };
    expect(countCrossings(swapped, straightRun(30, 0.5, 0, 1)).fwd).toBe(0);
    expect(countCrossings(swapped, straightRun(30, 0.5, 0, -1)).fwd).toBe(1);
  });
});

describe('§T.184 turn-mark rounding', () => {
  // course: north up x = 0 to a mark at (15, 400), turn right (east). Mark kept to starboard.
  const mark: TurnMark = { id: 'm', at: [15, 400], keepOn: 'starboard', radius: 8 };
  const prev: Vec2 = [0, 0];
  const next: Vec2 = [400, 415];
  const poles = markRoundingPoles(mark, prev, next, 150);

  function circle(cx: number, cz: number, r: number, from: number, to: number, steps = 400): Vec2[] {
    const pts: Vec2[] = [];
    for (let i = 0; i <= steps; i++) {
      const a = from + ((to - from) * i) / steps;
      pts.push([cx + r * Math.sin(a), cz + r * Math.cos(a)]); // bearing a, steering.ts convention
    }
    return pts;
  }

  function rounds(path: Vec2[]) {
    let fwd = 0;
    for (let i = 1; i < path.length; i++) {
      const c = segmentCrossesPoles(poles.left, poles.right, path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
      if (c?.dir === 'forward') fwd++;
    }
    return fwd;
  }

  it('sweeping around the mark with it to starboard, outside the radius, rounds it once', () => {
    // bearing increasing = mark on starboard; from south-west (−3π/4) round to east (+π/2)
    expect(rounds(circle(15, 400, 25, (-3 * Math.PI) / 4, Math.PI / 2))).toBe(1);
    // a wide rounding 100 m out still counts
    expect(rounds(circle(15, 400, 100, (-3 * Math.PI) / 4, Math.PI / 2))).toBe(1);
  });

  it('the same sweep the wrong way round (mark to port) does not round it', () => {
    expect(rounds(circle(15, 400, 25, Math.PI / 2, (-3 * Math.PI) / 4))).toBe(0);
  });

  it('cutting inside the radius does not round it', () => {
    expect(rounds(circle(15, 400, 6, (-3 * Math.PI) / 4, Math.PI / 2))).toBe(0);
  });

  it('passing on the other side of the mark does not round it', () => {
    // straight north along x = 40: the mark stays to PORT the whole way
    const path: Vec2[] = [];
    for (let z = 200; z <= 600; z += 0.7) path.push([40, z]);
    expect(rounds(path)).toBe(0);
    // and a right turn south-east of the mark (inside the corner) likewise
    expect(rounds(circle(40, 380, 20, -Math.PI, Math.PI / 2))).toBe(0);
  });

  it('a port-hand mark mirrors the rule', () => {
    const portMark: TurnMark = { ...mark, at: [-15, 400], keepOn: 'port' };
    const p = markRoundingPoles(portMark, prev, [-400, 415], 150);
    const around = circle(-15, 400, 25, (3 * Math.PI) / 4, -Math.PI / 2);
    let fwd = 0;
    for (let i = 1; i < around.length; i++) {
      const c = segmentCrossesPoles(p.left, p.right, around[i - 1][0], around[i - 1][1], around[i][0], around[i][1]);
      if (c?.dir === 'forward') fwd++;
    }
    expect(fwd).toBe(1);
  });
});
