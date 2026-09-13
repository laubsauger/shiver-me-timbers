/**
 * §T.185 RaceHudModel adapter: what the speedboat HUD tells the player, derived from RaceState
 * (§T.184) and page telemetry.
 *
 * WHY these properties: a racing HUD that is wrong by a sign, a lap or a place misleads the player
 * at 80 kn. The design doc's rules are encoded directly: deltas carry a sign (− ahead, + behind),
 * speed is in knots, Surge is three segments that fill fractionally, the crash overlay reports the
 * place you had BEFORE the crash, and the clock the HUD draws from lookup tables must read exactly
 * what the readable formatter says (two code paths, one truth).
 */
import { describe, expect, it } from 'vitest';
import type { Course, RaceState, RacerStanding } from '../src/race/types';
import {
  LANDING_WINDOW_DEG,
  MPS_TO_KNOTS,
  buildResults,
  createHudTelemetry,
  createRaceHudModel,
  formatDeg,
  formatGap,
  formatKnots,
  formatLap,
  formatLapTime,
  formatPosition,
  landingWindowFor,
  prepareCourse,
  relativeBearing,
  surgeSegmentFill,
  updateRaceHudModel,
} from '../src/speedboat/ui/model';
import { DEG_MIN, DEG_TEXT, INT, MINUS, PAD2, PAD3 } from '../src/speedboat/ui/text';

const course: Course = {
  id: 't',
  name: 'Test Reach',
  elements: [
    { kind: 'gate', gate: { id: 'sf', left: [-50, 0], right: [50, 0], sector: 'sheltered' } },
    { kind: 'mark', mark: { id: 'm1', at: [0, -500], keepOn: 'port', radius: 20 } },
    { kind: 'gate', gate: { id: 'g1', left: [450, -1000], right: [550, -1000], sector: 'exposed' } },
  ],
  startGateId: 'sf',
  laps: 3,
  referenceLine: [[0, 0], [0, -1000], [500, -1000], [500, 0]],
  paceLine: [],
  bounds: { min: [-100, -1100], max: [600, 100] },
};
const hc = prepareCourse(course);

function standing(racerId: number, position: number, gapToLeader: number, extra: Partial<RacerStanding> = {}): RacerStanding {
  return { racerId, position, lap: 2, nextElement: 1, progress: 0, gapToLeader, finished: false, state: 'racing', surge: 0, ...extra };
}

function race(standings: RacerStanding[], extra: Partial<RaceState> = {}): RaceState {
  return { phase: 'racing', raceTime: 200, standings, lapTimes: standings.map(() => []), ...extra };
}

/** eight boats, player (id 0) in P3 */
function field(playerPos = 3): RacerStanding[] {
  const out: RacerStanding[] = [];
  const order = [1, 2, 0, 3, 4, 5, 6, 7];
  order.splice(order.indexOf(0), 1);
  order.splice(playerPos - 1, 0, 0);
  order.forEach((id, i) => out.push(standing(id, i + 1, i * 1.5)));
  return out.sort((a, b) => a.racerId - b.racerId);
}

describe('formatters: the strings the player reads', () => {
  it('lap time is m:ss.mmm, truncated like race timing, and never shows 60 seconds', () => {
    expect(formatLapTime(98.318)).toBe('1:38.318');
    expect(formatLapTime(59.9996)).toBe('0:59.999');
    expect(formatLapTime(60)).toBe('1:00.000');
    expect(formatLapTime(Number.NaN)).toBe('–:––.–––');
  });

  it('gaps always carry a sign: typographic minus when the other boat is ahead, plus when behind', () => {
    expect(formatGap(-0.84)).toBe(`${MINUS}0.84`);
    expect(formatGap(1.2)).toBe('+1.20');
    expect(formatGap(0)).toBe('+0.00');
    expect(formatGap(62.3)).toBe('+1:02.3');
  });

  it('position, lap and degrees', () => {
    expect(formatPosition(3, 8)).toBe('P3/8');
    expect(formatLap(2, 3)).toBe('2/3');
    expect(formatDeg(4.2)).toBe('+4°');
    expect(formatDeg(-6)).toBe(`${MINUS}6°`);
  });

  it('knots: the design top speed (80 kn) is the 42 m/s class, not km/h or mph', () => {
    expect(MPS_TO_KNOTS).toBeCloseTo(1.943844, 5);
    expect(formatKnots(41.156)).toBe('80');
    expect(formatKnots(46.3)).toBe('90'); // Surge ceiling
  });

  it('the HUD lookup tables compose exactly what the formatters say', () => {
    for (const s of [0, 7.5, 98.318, 133.904, 412.061]) {
      const ms = Math.floor(s * 1000 + 1e-6);
      const composed = `${INT[Math.floor(ms / 60000)]}:${PAD2[Math.floor(ms / 1000) % 60]}.${PAD3[ms % 1000]}`;
      expect(composed).toBe(formatLapTime(s));
    }
    for (const d of [-6, -1, 0, 4, 12]) expect(DEG_TEXT[d - DEG_MIN]).toBe(formatDeg(d));
  });
});

describe('Surge segments', () => {
  it('three segments fill in order, fractionally, and clamp', () => {
    expect([0, 1, 2].map((i) => surgeSegmentFill(2.33, i))).toEqual([1, 1, expect.closeTo(0.33, 5)]);
    expect([0, 1, 2].map((i) => surgeSegmentFill(0.5, i))).toEqual([0.5, 0, 0]);
    expect([0, 1, 2].map((i) => surgeSegmentFill(5, i))).toEqual([1, 1, 1]);
  });
});

describe('landing window (design doc §3 clean landing: pitch −2..+7°)', () => {
  it('only means something in the air', () => {
    expect(landingWindowFor(false, 20)).toBe('water');
    expect(landingWindowFor(true, 4)).toBe('in');
    expect(landingWindowFor(true, LANDING_WINDOW_DEG.max + 0.5)).toBe('high');
    expect(landingWindowFor(true, LANDING_WINDOW_DEG.min - 0.5)).toBe('low');
  });
});

describe('updateRaceHudModel', () => {
  it('position, field, lap and the three rows ahead / you / behind with signed relative gaps', () => {
    const m = createRaceHudModel();
    const st = field(3);
    updateRaceHudModel(m, race(st), hc, 0, createHudTelemetry(), 1 / 60);
    expect(m.position).toBe(3);
    expect(m.fieldSize).toBe(8);
    expect(m.lap).toBe(2);
    expect(m.rows.map((r) => r.position)).toEqual([2, 3, 4]);
    expect(m.rows[1].isPlayer).toBe(true);
    // player gap to leader = 3.0; P2 at 1.5 is 1.5 s AHEAD → negative; P4 at 4.5 is behind → positive
    expect(m.rows[0].gap).toBeCloseTo(-1.5);
    expect(m.rows[1].gap).toBeCloseTo(3.0);
    expect(m.rows[2].gap).toBeCloseTo(1.5);
  });

  it('leading shows you and the two behind; last shows the two ahead and you', () => {
    const m = createRaceHudModel();
    updateRaceHudModel(m, race(field(1)), hc, 0, createHudTelemetry(), 0);
    expect(m.rows.map((r) => [r.position, r.isPlayer])).toEqual([[1, true], [2, false], [3, false]]);
    updateRaceHudModel(m, race(field(8)), hc, 0, createHudTelemetry(), 0);
    expect(m.rows.map((r) => [r.position, r.isPlayer])).toEqual([[6, false], [7, false], [8, true]]);
  });

  it('lap is clamped to the race: 0 before the line reads lap 1, never past the last lap', () => {
    const m = createRaceHudModel();
    const st = field(3);
    st[0].lap = 0;
    updateRaceHudModel(m, race(st, { phase: 'rolling', raceTime: -8 }), hc, 0, createHudTelemetry(), 0);
    expect(m.lap).toBe(1);
    st[0].lap = 4;
    updateRaceHudModel(m, race(st), hc, 0, createHudTelemetry(), 0);
    expect(m.lap).toBe(3);
  });

  it('lap clock = race time minus completed splits; last and best come from the splits', () => {
    const m = createRaceHudModel();
    const st = field(3);
    const r = race(st, { raceTime: 300 });
    (r.lapTimes as number[][])[0] = [140.5, 133.9];
    updateRaceHudModel(m, r, hc, 0, createHudTelemetry(), 0);
    expect(m.lapTime).toBeCloseTo(300 - 274.4);
    expect(m.lastLap).toBeCloseTo(133.9);
    expect(m.bestLap).toBeCloseTo(133.9);
  });

  it('knots and averaged rpm from telemetry; Surge being spent is visible', () => {
    const m = createRaceHudModel();
    const tel = createHudTelemetry();
    tel.speedMps = 41.156;
    tel.rpm.set([5800, 5850, 5900]);
    const st = field(3);
    st[0].surge = 2.33;
    st[0].surgeBoostRemaining = 1.2;
    updateRaceHudModel(m, race(st), hc, 0, tel, 0);
    expect(Math.round(m.knots)).toBe(80);
    expect(m.rpmAvg).toBeCloseTo(5850);
    expect(m.surge).toBeCloseTo(2.33);
    expect(m.surgeActive).toBe(true);
  });

  it('the dial shows drive trim on the water and hull pitch in the air', () => {
    const m = createRaceHudModel();
    const tel = createHudTelemetry();
    tel.trimDeg = 3;
    tel.pitchDeg = 9;
    updateRaceHudModel(m, race(field()), hc, 0, tel, 0);
    expect(m.attitudeDeg).toBe(3);
    expect(m.landing).toBe('water');
    tel.airborne = true;
    updateRaceHudModel(m, race(field()), hc, 0, tel, 0);
    expect(m.attitudeDeg).toBe(9);
    expect(m.landing).toBe('high');
  });

  it('crash overlay: reports the place held BEFORE the crash, counts each crash once, then ghost', () => {
    const m = createRaceHudModel();
    const tel = createHudTelemetry();
    const st = field(3);
    updateRaceHudModel(m, race(st), hc, 0, tel, 0);
    st[0].state = 'crashed';
    updateRaceHudModel(m, race(st), hc, 0, tel, 0);
    expect(m.crash).toBe('crash');
    expect(m.crashId).toBe(1);
    // the field passes while the crash cam runs: P3 → P5, but "before" stays 3
    const st2 = field(5);
    st2[0].state = 'respawning';
    tel.respawnTotalS = 3;
    tel.respawnRemainingS = 0.75;
    for (let i = 0; i < 30; i++) updateRaceHudModel(m, race(st2), hc, 0, tel, 1 / 60);
    expect(m.crash).toBe('respawn');
    expect(m.positionBeforeCrash).toBe(3);
    expect(m.position).toBe(5);
    expect(m.crashId).toBe(1);
    expect(m.respawnProgress).toBeCloseTo(0.75);
    st2[0].state = 'ghost';
    tel.ghostTotalS = 2;
    tel.ghostRemainingS = 0.5;
    updateRaceHudModel(m, race(st2), hc, 0, tel, 0);
    expect(m.crash).toBe('ghost');
    expect(m.ghostProgress).toBeCloseTo(0.25);
    st2[0].state = 'crashed';
    updateRaceHudModel(m, race(st2), hc, 0, tel, 0);
    expect(m.crashId).toBe(2);
    expect(m.positionBeforeCrash).toBe(5);
  });

  it('tower lamps: race logic `lights` wins; the count called is the lamps still to light + 1', () => {
    const m = createRaceHudModel();
    updateRaceHudModel(m, race(field(), { phase: 'countdown', raceTime: -2.5, lights: { lit: 3, of: 5, green: false } }), hc, 0, createHudTelemetry(), 0);
    expect([m.lampsLit, m.countdown]).toEqual([3, 3]);
    // no lights from race logic: derived from the clock (2.5 s left → 3 called, 3 lamps)
    updateRaceHudModel(m, race(field(), { phase: 'countdown', raceTime: -2.5 }), hc, 0, createHudTelemetry(), 0);
    expect([m.lampsLit, m.countdown]).toEqual([3, 3]);
    updateRaceHudModel(m, race(field(), { phase: 'racing', raceTime: 0.01, lights: { lit: 5, of: 5, green: true } }), hc, 0, createHudTelemetry(), 0);
    expect([m.lampsLit, m.countdown]).toEqual([0, 0]);
    expect(m.greenS).toBeGreaterThan(0);
  });

  it('next element: label, distance and bearing (+ = starboard)', () => {
    const m = createRaceHudModel();
    const tel = createHudTelemetry();
    tel.x = 0;
    tel.z = 0;
    tel.headingRad = 0; // facing north (−z)
    updateRaceHudModel(m, race(field()), hc, 0, tel, 0);
    expect(hc.labels).toEqual(['S/F', 'T1', 'G1']);
    expect(m.nextLabel).toBe('T1');
    expect(m.gateDistanceM).toBeCloseTo(500);
    expect(m.gateBearingRad).toBeCloseTo(0);
    expect(relativeBearing(0, 0, 0, 100, 0)).toBeCloseTo(Math.PI / 2); // due east = starboard
    expect(relativeBearing(0, 0, Math.PI / 2, 0, -100)).toBeCloseTo(-Math.PI / 2); // heading east, north is to port
  });

  it('toasts age out after 1.2 s and restart on a new id', () => {
    const m = createRaceHudModel();
    const tel = createHudTelemetry();
    tel.toastId = 1;
    tel.toastTitle = 'Air 1.4 s';
    updateRaceHudModel(m, race(field()), hc, 0, tel, 0);
    expect(m.toastAgeS).toBe(0);
    for (let i = 0; i < 80; i++) updateRaceHudModel(m, race(field()), hc, 0, tel, 1 / 60);
    expect(m.toastAgeS).toBeGreaterThanOrEqual(1.2);
    tel.toastId = 2;
    updateRaceHudModel(m, race(field()), hc, 0, tel, 1 / 60);
    expect(m.toastAgeS).toBe(0);
  });
});

describe('buildResults', () => {
  it('uses race logic classification when present (penalties included in the time)', () => {
    const r = race(field(2), {
      phase: 'finished',
      results: [
        { racerId: 1, place: 1, status: 'finished', lapsCompleted: 3, finishTime: 400, penaltySeconds: 0, totalTime: 400, lapTimes: [140, 130, 130], bestLap: 130 },
        { racerId: 0, place: 2, status: 'finished', lapsCompleted: 3, finishTime: 397, penaltySeconds: 5, totalTime: 402, lapTimes: [135, 129, 133], bestLap: 129 },
        { racerId: 2, place: 3, status: 'dnf', lapsCompleted: 2, finishTime: null, penaltySeconds: 0, totalTime: null, lapTimes: [150, 151], bestLap: 150 },
      ],
    });
    const res = buildResults(r);
    expect(res.rows.map((x) => x.racerId)).toEqual([1, 0, 2]);
    expect(res.rows[1].gap).toBeCloseTo(2);
    expect(res.rows[2].status).toBe('dnf');
    expect(res.fastestRacerId).toBe(0);
    expect(res.fastestLap).toBe(129);
  });

  it('falls back to standings order and summed splits', () => {
    const st = field(1).slice(0, 2);
    st.forEach((s) => (s.finished = true));
    const r = race(st, { phase: 'finished' });
    (r.lapTimes as number[][])[0] = [100, 101, 102];
    (r.lapTimes as number[][])[1] = [99, 104, 105];
    const res = buildResults(r);
    expect(res.rows[0].racerId).toBe(0);
    expect(res.rows[0].total).toBe(303);
    expect(res.rows[1].gap).toBe(5);
    expect(res.fastestRacerId).toBe(1);
  });
});
