/**
 * §T.184 race logic on a SYNTHETIC course (§V80; the real Tower Reach is §T.187's and not
 * depended on). The course has a 90° corner at a mark, an acute V (two legs 31° apart) and a
 * lap seam on a straight, which is where projection, lap counting and timing go wrong.
 *
 * WHY each block:
 * - progress: positions, gaps and the minimap all read it; a backward jump at a corner flips
 *   positions and fires false wrong-way calls, a flip between the legs of a V jumps tens of
 *   metres, and a lost seam turns lap 2 into lap 1;
 * - ordering: a lapped boat further round its own lap must not lead, and abreast boats must
 *   not flicker positions every tick;
 * - gap: seconds, not metres, and not quantised to the tick;
 * - rolling start: crossing before green is a penalty, holding the slot is not;
 * - respawn: behind the crash, ON the line, pointing along it, clear of other boats;
 * - results: finishers by laps then classified time (penalties count), DNF last.
 */
import { describe, expect, it } from 'vitest';
import { raceParams, type RaceParams } from '../src/race/params';
import { Polyline } from '../src/race/polyline';
import { CourseLine, ProgressTracker } from '../src/race/progress';
import { Race, type RaceTick } from '../src/race/race';
import type { RaceEvent } from '../src/race/events';
import type { RacerSensors } from '../src/race/sensors';
import { rankRacers, type RankEntry } from '../src/race/standings';
import type { Course, Gate, Vec2 } from '../src/race/types';

const DT = 1 / 60;

/** gate across a leg: poles ±15 m either side of `at`, course direction `dir` */
function gateAt(id: string, at: Vec2, dir: Vec2, sector: Gate['sector']): Gate {
  const [dx, dz] = dir;
  // left = port = (−dz, dx)
  return { id, left: [at[0] - dz * 15, at[1] + dx * 15], right: [at[0] + dz * 15, at[1] - dx * 15], sector };
}

const REF: Vec2[] = [
  [0, 0],
  [0, 400], // 90° right
  [300, 400], // 90° right
  [300, -100], // acute: ~149° right
  [150, 150], // acute: ~149° right
  [150, -200], // 90° right
  [0, -200], // 90° right
];

function course(laps = 3, paceLine: Vec2[] = [[0, -100], [0, 0]]): Course {
  return {
    id: 'synthetic',
    name: 'Synthetic Reach',
    startGateId: 'G0',
    laps,
    referenceLine: REF,
    paceLine,
    bounds: { min: [-100, -300], max: [400, 500] },
    elements: [
      { kind: 'gate', gate: gateAt('G0', [0, 0], [0, 1], 'sheltered') },
      { kind: 'gate', gate: gateAt('G1', [0, 200], [0, 1], 'exposed') },
      { kind: 'mark', mark: { id: 'M1', at: [15, 385], keepOn: 'starboard', radius: 8 } },
      { kind: 'gate', gate: gateAt('G2', [150, 400], [1, 0], 'exposed') },
      { kind: 'gate', gate: gateAt('G3', [300, 150], [0, -1], 'sheltered') },
      { kind: 'gate', gate: gateAt('G4', [150, 0], [0, -1], 'exposed') },
      { kind: 'mark', mark: { id: 'M2', at: [135, -185], keepOn: 'starboard', radius: 8 } },
      { kind: 'gate', gate: gateAt('G5', [75, -200], [-1, 0], 'sheltered') },
      { kind: 'mark', mark: { id: 'M3', at: [15, -185], keepOn: 'starboard', radius: 8 } },
    ],
  };
}

const LINE = new CourseLine(REF, 0, 0);
const L = LINE.length;

/** green at t = 0: no pace run, no lamps */
function instantStart(over: Partial<RaceParams> = {}): RaceParams {
  return { ...raceParams, start: { ...raceParams.start, prestartSeconds: 0, pullOffDistance: 1000 }, ...over };
}

type Script = (simTime: number) => { pos: Vec2; extra?: Partial<RacerSensors> };

function sensors(id: number, positions: Vec2[], extra: Partial<RacerSensors> = {}): RacerSensors {
  return {
    racerId: id,
    positions,
    speed: 40,
    airborne: false,
    slam: 0,
    pitch: 0,
    roll: 0,
    crashed: false,
    launchedFromWake: false,
    surgePressed: false,
    respawnRequested: false,
    ...extra,
  };
}

/** run `seconds` of ticks with 2 substeps; returns all events and the last tick */
function run(race: Race, ids: number[], scripts: Script[], seconds: number, onTick?: (t: RaceTick) => void) {
  const events: RaceEvent[] = [];
  let last!: RaceTick;
  const n = Math.round(seconds / DT);
  for (let k = 0; k < n; k++) {
    const t0 = race.simTime;
    const s = scripts.map((script, i) => {
      const a = script(t0 + DT / 2);
      const b = script(t0 + DT);
      return sensors(ids[i], [a.pos, b.pos], b.extra);
    });
    last = race.step(s);
    events.push(...last.events);
    onTick?.(last);
  }
  return { events, last };
}

/** on the reference line at constant speed from progress u0 */
const onLine =
  (u0: number, v: number, extra?: (t: number) => Partial<RacerSensors> | undefined): Script =>
  (t) => {
    const p = LINE.at(u0 + v * t);
    return { pos: [p.x, p.z], extra: extra?.(t) };
  };

// ---------------------------------------------------------------------------------------------

function chaikin(pts: Vec2[], iterations: number): Vec2[] {
  let out = pts;
  for (let k = 0; k < iterations; k++) {
    const next: Vec2[] = [];
    for (let i = 0; i < out.length; i++) {
      const a = out[i];
      const b = out[(i + 1) % out.length];
      next.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
      next.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    out = next;
  }
  return out;
}

/** samples every `step` m along a closed path for `laps` laps, starting at the path's arc of (0,0) */
function samplePath(path: Polyline, laps: number, step: number, lateral: (s: number) => number = () => 0): Vec2[] {
  const s0 = path.nearestArc(0, 0).arc;
  const pts: Vec2[] = [];
  for (let s = 0; s <= laps * path.length; s += step) {
    const q = path.pointAt(s0 + s);
    const off = lateral(s);
    pts.push([q.x + q.tz * off, q.z - q.tx * off]);
  }
  return pts;
}

describe('§T.184 progress along the reference line', () => {
  const paths: [string, Vec2[]][] = [
    // corner-cutting, deep inside the acute V
    ['inside every corner (chaikin)', samplePath(new Polyline(chaikin(REF, 4), true), 2, 0.5)],
    // weaving ±12 m every 70 m, which swings across the corners and the V
    [
      'weaving across the line',
      samplePath(new Polyline(chaikin(REF, 2), true), 2, 0.5, (s) => 12 * Math.sin((2 * Math.PI * s) / 70)),
    ],
    // wide of every corner: vertices pushed 20 m outside
    [
      'wide of every corner',
      samplePath(
        new Polyline(
          REF.map((p, i) => {
            const a = REF[(i - 1 + REF.length) % REF.length];
            const b = REF[(i + 1) % REF.length];
            const mx = (a[0] + b[0]) / 2 - p[0];
            const mz = (a[1] + b[1]) / 2 - p[1];
            const n = Math.hypot(mx, mz);
            return [p[0] - (20 * mx) / n, p[1] - (20 * mz) / n] as Vec2;
          }),
          true,
        ),
        2,
        0.5,
      ),
    ],
  ];

  for (const [name, pts] of paths) {
    it(`never goes backwards and wraps the seam: ${name}`, () => {
      const tr = new ProgressTracker(LINE, raceParams.progress);
      tr.reset(pts[0][0], pts[0][1], 0);
      let prev = tr.progress;
      let worstLeg = 0;
      let crossedSeam = false;
      for (let i = 1; i < pts.length; i++) {
        const [x, z] = pts[i];
        const p = tr.update(x, z);
        const where = `sample ${i} at (${x.toFixed(1)}, ${z.toFixed(1)})`;
        expect(p, where).toBeGreaterThanOrEqual(prev);
        // on the right leg: the tracked point is about as near the boat as the nearest point of
        // the whole line — neither stuck on the leg it left nor flipped onto another
        const q = LINE.at(tr.raw);
        const nearest = Math.sqrt(LINE.line.nearestArc(x, z).d2);
        worstLeg = Math.max(worstLeg, Math.hypot(q.x - x, q.z - z) - nearest);
        if (prev < L && p >= L) crossedSeam = true;
        prev = p;
        expect(tr.wrongWay, where).toBe(false);
      }
      expect(worstLeg).toBeLessThan(10);
      expect(crossedSeam).toBe(true);
      // two laps ≈ 2 L (the path ends where it began)
      expect(Math.abs(prev - 2 * L)).toBeLessThan(25);
    });
  }

  it('follows a genuine reversal (wrong way) once past the hysteresis, and flags it', () => {
    const tr = new ProgressTracker(LINE, raceParams.progress);
    tr.reset(0, 100, 0);
    for (let z = 100; z <= 300; z += 0.5) tr.update(0, z);
    expect(tr.progress).toBeCloseTo(300, 6);
    for (let z = 300; z >= 200; z -= 0.5) tr.update(0, z);
    expect(tr.progress).toBeCloseTo(200 + raceParams.progress.hysteresis, 6);
    expect(tr.wrongWay).toBe(true);
  });
});

describe('§T.184 positions', () => {
  const entry = (index: number, o: Partial<RankEntry>): RankEntry => ({
    index,
    dnf: false,
    finished: false,
    elementsDone: 0,
    progress: 0,
    classifiedTime: 0,
    prevPosition: 0,
    ...o,
  });

  it('a lapped boat further round its own lap stays behind the leader', () => {
    const N = 9;
    const leader = entry(0, { elementsDone: N + 3, progress: L + 500 });
    const lapped = entry(1, { elementsDone: 6, progress: 1500 });
    expect(rankRacers([lapped, leader])).toEqual([0, 1]);
  });

  it('passing the gate beats being further along the line without passing it', () => {
    const passed = entry(0, { elementsDone: 4, progress: 1000 });
    const cutting = entry(1, { elementsDone: 3, progress: 1030 });
    expect(rankRacers([cutting, passed])).toEqual([0, 1]);
  });

  it('exact ties keep the previous order (no flicker), and are deterministic without one', () => {
    const a = entry(0, { elementsDone: 2, progress: 700, prevPosition: 2 });
    const b = entry(1, { elementsDone: 2, progress: 700, prevPosition: 1 });
    expect(rankRacers([a, b])).toEqual([1, 0]);
    expect(rankRacers([b, a])).toEqual([1, 0]);
    const c = entry(2, { elementsDone: 2, progress: 700 });
    const d = entry(3, { elementsDone: 2, progress: 700 });
    expect(rankRacers([d, c])).toEqual([2, 3]);
  });

  it('finishers with equal laps order by classified time; DNF last', () => {
    const fast = entry(0, { finished: true, elementsDone: 27, progress: 3 * L, classifiedTime: 105 });
    const pen = entry(1, { finished: true, elementsDone: 27, progress: 3 * L + 5, classifiedTime: 103 });
    const dnf = entry(2, { dnf: true, elementsDone: 30, progress: 3 * L + 900 });
    expect(rankRacers([dnf, fast, pen])).toEqual([1, 0, 2]);
  });

  it('in a race, abreast boats do not swap positions tick to tick', () => {
    const race = new Race({ course: course(), racerIds: [7, 3], params: instantStart() });
    // same progress, 10 m apart across the line
    const abreast = (side: number): Script => (t) => {
      const p = LINE.at(-20 + 40 * t);
      return { pos: [p.x + p.tz * side, p.z - p.tx * side] };
    };
    const { events } = run(race, [7, 3], [abreast(-5), abreast(5)], 5);
    expect(events.filter((e) => e.kind === 'positionChanged')).toEqual([]);
  });
});

describe('§T.184 gap to leader', () => {
  it('two boats at constant speed d metres apart are d / v seconds apart', () => {
    const v = 37.3;
    const d = 50;
    const race = new Race({ course: course(), racerIds: [1, 2], params: instantStart() });
    const { last } = run(race, [1, 2], [onLine(-10, v), onLine(-10 - d, v)], 40);
    const [a, b] = last.state.standings;
    expect(a.position).toBe(1);
    expect(a.gapToLeader).toBe(0);
    expect(b.gapToLeader).toBeCloseTo(d / v, 4);
  });
});

describe('§T.184 laps and timing', () => {
  it('counts laps at the start line, times them from green, and passes every element in order', () => {
    const v = 40;
    const race = new Race({ course: course(2), racerIds: [1], params: instantStart() });
    const { events } = run(race, [1], [onLine(-10, v)], (2 * L + 30) / v);
    const crossed = events.filter((e) => e.kind === 'gateCrossed').map((e) => (e.kind === 'gateCrossed' ? e.id : ''));
    const ids = course().elements.map((e) => (e.kind === 'gate' ? e.gate.id : e.mark.id));
    expect(crossed).toEqual([...ids, ...ids, 'G0']);
    expect(events.filter((e) => e.kind === 'penalty')).toEqual([]);
    const laps = events.filter((e) => e.kind === 'lapCompleted');
    expect(laps.map((e) => (e.kind === 'lapCompleted' ? e.lapTime : 0))).toEqual([
      expect.closeTo((L + 10) / v, 6),
      expect.closeTo(L / v, 6),
    ]);
    expect(events.some((e) => e.kind === 'finish')).toBe(true);
  });

  it('a boat that goes outside a gate pole is penalised once and still finishes the lap', () => {
    const race = new Race({ course: course(1), racerIds: [1], params: instantStart() });
    // swing 25 m to starboard around G1 (right pole at x = 15)
    const swing = (u: number) => 25 * Math.max(0, Math.min(1, (u - 120) / 40, (280 - u) / 40));
    const script: Script = (t) => {
      const u = -10 + 40 * t;
      const p = LINE.at(u);
      const off = swing(u);
      return { pos: [p.x + p.tz * off, p.z - p.tx * off] };
    };
    const { events, last } = run(race, [1], [script], (L + 30) / 40);
    const pens = events.filter((e) => e.kind === 'penalty');
    expect(pens).toEqual([expect.objectContaining({ reason: 'missedElement', element: 1, seconds: 5 })]);
    // called as soon as the boat is missDistance past the gate (race control calls it then),
    // not only when it reaches the next mark 200 m later
    const pen = pens[0];
    expect(pen.kind === 'penalty' && pen.time).toBeCloseTo((200 + raceParams.missDistance + 10) / 40, 1);
    expect(events.filter((e) => e.kind === 'gateCrossed').map((e) => (e.kind === 'gateCrossed' ? e.id : ''))).not.toContain('G1');
    expect(last.state.results?.[0]).toMatchObject({ status: 'finished', penaltySeconds: 5 });
    expect(last.state.results?.[0].totalTime).toBeCloseTo((L + 10) / 40 + 5, 6);
  });
});

describe('§T.184 rolling start', () => {
  const params: RaceParams = {
    ...raceParams,
    start: { ...raceParams.start, prestartSeconds: 1, pullOffDistance: 100, lampCount: 5, lampInterval: 1 },
  };
  const c = course(3, [
    [0, -300],
    [0, 0],
  ]);

  it('lamps light one per second into green; holding the slot is clean, crossing early is penalised', () => {
    const race = new Race({ course: c, racerIds: [1, 2], params });
    const green = race.schedule.green;
    const holder: Script = (t) => {
      if (t < green) {
        const s = race.gridSlot(1, t);
        return { pos: [s.x, s.z] };
      }
      const s = race.gridSlot(1, green);
      return { pos: [s.x, s.z + 30 * (t - green)] };
    };
    const jumper: Script = (t) => {
      const s = race.gridSlot(2, Math.min(t, 5));
      return { pos: [s.x, s.z + 60 * Math.max(0, t - 5)] };
    };
    const phases: string[] = [];
    const caps: (number | null)[] = [];
    const { events } = run(race, [1, 2], [holder, jumper], green + 12, (tick) => {
      if (phases[phases.length - 1] !== tick.state.phase) phases.push(tick.state.phase);
      if (caps[caps.length - 1] !== tick.outputs[0].speedCap) caps.push(tick.outputs[0].speedCap);
    });

    expect(phases).toEqual(['prestart', 'rolling', 'countdown', 'racing']);
    expect(caps).toEqual([0, params.start.paceSpeed * params.start.speedCapFactor, null]);
    const lights = events.filter((e) => e.kind === 'lights');
    expect(lights.map((e) => (e.kind === 'lights' ? (e.green ? 'G' : e.lit) : ''))).toEqual([1, 2, 3, 4, 5, 'G']);

    const pens = events.filter((e) => e.kind === 'penalty');
    expect(pens).toEqual([expect.objectContaining({ racerId: 2, reason: 'jumpStart' })]);
    const pen = pens[0];
    expect(pen.kind === 'penalty' && pen.time).toBeLessThan(0);
    // the holder crossed after green without a penalty
    const start1 = events.find((e) => e.kind === 'gateCrossed' && e.racerId === 1 && e.element === 0);
    expect(start1 && start1.kind === 'gateCrossed' && start1.time).toBeGreaterThan(0);
  });

  it('grid slots are abreast in rows behind the pace boat', () => {
    const race = new Race({ course: c, racerIds: [1, 2, 3, 4], params });
    const t = 4;
    const [s1, s2, s3, s4] = [1, 2, 3, 4].map((id) => race.gridSlot(id, t));
    expect(s1.z).toBeCloseTo(s2.z, 9);
    expect(s2.x - s1.x).toBeCloseTo(params.start.columnSpacing, 9);
    expect(s1.z - s3.z).toBeCloseTo(params.start.rowSpacing, 9);
    expect(s3.z).toBeCloseTo(s4.z, 9);
    const pace = run(race, [1, 2, 3, 4], [1, 2, 3, 4].map((id) => (tt: number) => {
      const s = race.gridSlot(id, tt);
      return { pos: [s.x, s.z] as Vec2 };
    }), t).last.state.paceBoat!;
    expect(pace.z - s1.z).toBeCloseTo(params.start.firstRowGap, 6);
    expect(s1.yaw).toBeCloseTo(0, 9);
  });
});

describe('§T.184 respawn', () => {
  const v = 40;
  /** drives the line, crashes at `crashAt`, tumbles 30 m off the line and 25 m on, asks for a reset 1 s later */
  const crasher = (crashAt: number): Script => {
    const tCrash = (crashAt + 10) / v;
    return (t) => {
      if (t < tCrash) {
        const p = LINE.at(-10 + v * t);
        return { pos: [p.x, p.z] };
      }
      const p = LINE.at(crashAt + 25);
      return {
        pos: [p.x + 30, p.z],
        extra: { crashed: t < tCrash + 1, respawnRequested: t >= tCrash + 1 && t < tCrash + 1.2, speed: 3 },
      };
    };
  };

  function respawnOf(events: RaceEvent[]) {
    const r = events.find((e) => e.kind === 'respawn');
    if (!r || r.kind !== 'respawn') throw new Error('no respawn event');
    return r;
  }

  it('lands 60 m behind the crash point, on the line, heading along it, at planing speed', () => {
    const crashAt = 1300; // on the diagonal leg P3 → P4 (arc 1200 … 1491)
    const race = new Race({ course: course(), racerIds: [1], params: instantStart() });
    const states: string[] = [];
    const { events } = run(race, [1], [crasher(crashAt)], (crashAt + 10) / v + 4, (tick) => {
      const s = tick.state.standings[0].state;
      if (states[states.length - 1] !== s) states.push(s);
    });
    const r = respawnOf(events);
    const want = LINE.at(crashAt - raceParams.respawn.backDistance);
    // within one tick of travel of the crash onset, not where the hull tumbled to
    expect(Math.hypot(r.x - want.x, r.z - want.z)).toBeLessThan(v * DT + 1e-6);
    expect(r.yaw).toBeCloseTo(Math.atan2(-150, 250), 9); // along P3 → P4
    expect(r.speed).toBeCloseTo(v * raceParams.respawn.speedFraction, 9); // pre-crash speed, not the tumble
    expect(r.ghostSeconds).toBe(2);
    expect(r.clear).toBe(true);
    expect(states).toEqual(['racing', 'crashed', 'respawning', 'ghost', 'racing']);
  });

  it('steps further back until clear of other boats, then of the page hook', () => {
    const crashAt = 380; // straight leg P0 → P1, so arc distance = distance
    const parkedAt = LINE.at(crashAt - 60);
    const parked: Script = () => ({ pos: [parkedAt.x, parkedAt.z] });

    const boats = new Race({ course: course(), racerIds: [1, 2], params: instantStart() });
    const rb = respawnOf(run(boats, [1, 2], [crasher(crashAt), parked], (crashAt + 10) / v + 2).events);
    // 40 m clearance from the parked boat: 60 + 40 back
    expect(Math.hypot(rb.x, rb.z - (crashAt - 100))).toBeLessThan(v * DT + 1e-6);

    const rocks = new Race({
      course: course(),
      racerIds: [1, 2],
      params: instantStart(),
      isClear: (x, z) => Math.hypot(x - parkedAt.x, z - parkedAt.z) > 75,
    });
    const rr = respawnOf(run(rocks, [1, 2], [crasher(crashAt), parked], (crashAt + 10) / v + 2).events);
    // first 10 m step more than 75 m from the parked boat: 60 + 80 back
    expect(Math.hypot(rr.x, rr.z - (crashAt - 140))).toBeLessThan(v * DT + 1e-6);
    expect(rr.clear).toBe(true);
  });
});

describe('§T.184 results', () => {
  it('winner, a lapped finisher and a DNF, with lap times and best lap', () => {
    const params = instantStart({ dnfAfterWinnerSeconds: 30 });
    const race = new Race({ course: course(2), racerIds: [10, 20, 30], params });
    const stopAt = 20;
    const stopper: Script = (t) => onLine(-20, 40)(Math.min(t, stopAt));
    let midRace: RaceTick | null = null;
    const { last } = run(race, [10, 20, 30], [onLine(-10, 40), onLine(-40, 18), stopper], 150, (tick) => {
      if (Math.abs(race.simTime - 70) < DT / 2) midRace = tick;
    });

    // at 70 s the slow boat is further round ITS lap than the leader is round his, but a lap down
    const mid = midRace as RaceTick | null;
    expect(mid).not.toBeNull();
    const pos = Object.fromEntries(mid!.state.standings.map((s) => [s.racerId, s.position]));
    expect(pos).toEqual({ 10: 1, 20: 2, 30: 3 });
    expect(((-40 + 18 * 70) % L) > ((-10 + 40 * 70) % L)).toBe(true);

    const res = last.state.results!;
    expect(last.state.phase).toBe('finished');
    expect(res.map((r) => [r.racerId, r.place, r.status, r.lapsCompleted])).toEqual([
      [10, 1, 'finished', 2],
      [20, 2, 'finished', 1],
      [30, 3, 'dnf', 0],
    ]);
    expect(res[0].lapTimes).toEqual([expect.closeTo((L + 10) / 40, 6), expect.closeTo(L / 40, 6)]);
    expect(res[0].bestLap).toBeCloseTo(L / 40, 6);
    expect(res[0].totalTime).toBeCloseTo((2 * L + 10) / 40, 6);
    expect(res[1].lapTimes).toEqual([expect.closeTo((L + 40) / 18, 6)]);
    expect(res[2]).toMatchObject({ finishTime: null, totalTime: null, bestLap: null });
    expect(last.state.standings.find((s) => s.racerId === 30)).toMatchObject({ dnf: true, finished: false });
  });

  it('a penalty decides the classification between two close finishers', () => {
    const race = new Race({ course: course(1), racerIds: [1, 2], params: instantStart() });
    const swing = (u: number) => 25 * Math.max(0, Math.min(1, (u - 120) / 40, (280 - u) / 40));
    const cutter: Script = (t) => {
      const u = -10 + 40 * t;
      const p = LINE.at(u);
      return { pos: [p.x + p.tz * swing(u), p.z - p.tx * swing(u)] };
    };
    // clean boat 2 s behind on the road
    const { events, last } = run(race, [1, 2], [cutter, onLine(-90, 40)], (L + 120) / 40);
    const finishes = events.filter((e) => e.kind === 'finish').map((e) => (e.kind === 'finish' ? e.racerId : 0));
    expect(finishes).toEqual([1, 2]); // cutter crossed first
    expect(last.state.results!.map((r) => r.racerId)).toEqual([2, 1]); // but is classified second
  });

  it('is deterministic: the same inputs give the same event stream (§V2)', () => {
    const go = () => {
      const race = new Race({ course: course(1), racerIds: [1, 2], params: instantStart() });
      return JSON.stringify(run(race, [1, 2], [onLine(-10, 41), onLine(-30, 39.5)], 70).events);
    };
    expect(go()).toBe(go());
  });
});
