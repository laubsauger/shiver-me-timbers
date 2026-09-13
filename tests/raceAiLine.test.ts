/**
 * §T.186 NPC racing line, speed profile and the sim-buffer AI block — pure, no physics run.
 *
 * WHY: the pilot can only be as good as the line it follows. A line that clips a pole, rounds a mark on the wrong
 * side or asks for a corner speed the boat cannot turn at makes every NPC miss gates or run wide however well the
 * controller tracks it — and those failures would show up later as "the AI is bad", far from the cause. The profile
 * must come from the MEASURED boat (capability.ts), so it is checked against those tables, not against numbers
 * restated here. The AI block rides the sim buffer; a layout without a pilot must stay byte-identical so the
 * existing sim-worker hashes and tests are untouched.
 */
import { describe, expect, it } from 'vitest';
import { AI, AI_IN, encodeStanding } from '../src/race/ai/aiBlock';
import { accelAt, curvatureAt, decelAt, lockLimit, steerForCurvature } from '../src/race/ai/capability';
import { buildRacingLine, corridorsOf, type RacingLine } from '../src/race/ai/line';
import { buildPilotSetup, LINE_LEVELS } from '../src/race/ai/pilot';
import { speedProfile } from '../src/race/ai/profile';
import type { Course } from '../src/race/types';
import { AI_BLOCK_LEN, AI_IN_LEN, AI_OUT_LEN, B, BoatSimLayout, hashBoatOutput, layoutByteLength } from '../src/sim-worker/layout';
import { syntheticCourse } from './raceAiHarness';

const course = syntheticCourse();
const setup = buildPilotSetup(course, ['veteran'], { seed: 1 });

/** where the closed line crosses the infinite line through (ox,oz) along (ux,uz), travelling along (dx,dz) */
function crossings(line: RacingLine, ox: number, oz: number, ux: number, uz: number, dx: number, dz: number): { u: number; i: number }[] {
  const out: { u: number; i: number }[] = [];
  for (let i = 0; i < line.n; i++) {
    const j = (i + 1) % line.n;
    const da = (line.x[i] - ox) * dx + (line.z[i] - oz) * dz;
    const db = (line.x[j] - ox) * dx + (line.z[j] - oz) * dz;
    if (da < 0 && db >= 0) {
      const t = da / (da - db);
      const hx = line.x[i] + (line.x[j] - line.x[i]) * t;
      const hz = line.z[i] + (line.z[j] - line.z[i]) * t;
      out.push({ u: (hx - ox) * ux + (hz - oz) * uz, i });
    }
  }
  return out;
}

const lapTime = (line: RacingLine, v: Float64Array): number => {
  let t = 0;
  for (let i = 0; i < line.n; i++) t += line.ds / v[i];
  return t;
};

function checkCourse(c: Course, line: RacingLine, margin: number): { slack: number[] } {
  const slack: number[] = [];
  const m = c.elements.length;
  const ctr = (k: number): [number, number] => {
    const e = c.elements[k];
    return e.kind === 'gate' ? [(e.gate.left[0] + e.gate.right[0]) / 2, (e.gate.left[1] + e.gate.right[1]) / 2] : [e.mark.at[0], e.mark.at[1]];
  };
  c.elements.forEach((e, k) => {
    if (e.kind === 'gate') {
      const { left, right } = e.gate;
      const w = Math.hypot(right[0] - left[0], right[1] - left[1]);
      const ux = (right[0] - left[0]) / w;
      const uz = (right[1] - left[1]) / w;
      const hits = crossings(line, left[0], left[1], ux, uz, -uz, ux).filter((h) => h.u > -3 * w && h.u < 4 * w);
      expect(hits.length, `gate ${e.gate.id}: crossed once in the course direction`).toBe(1);
      const u = hits[0].u;
      expect(u, `gate ${e.gate.id}: ≥ margin off the left pole`).toBeGreaterThanOrEqual(margin - 0.05);
      expect(u, `gate ${e.gate.id}: ≥ margin off the right pole`).toBeLessThanOrEqual(w - margin + 0.05);
      slack.push(Math.min(u - margin, w - margin - u));
    } else {
      const p = ctr((k + m - 1) % m);
      const q = ctr((k + 1) % m);
      const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const dx = (q[0] - p[0]) / l;
      const dz = (q[1] - p[1]) / l;
      // keepOn 'port' ⇒ the boat passes on the mark's starboard side of the chord direction
      const hits = crossings(line, e.mark.at[0], e.mark.at[1], dz, -dx, dx, dz).filter((h) => Math.abs(h.u) < 200);
      expect(hits.length, `mark ${e.mark.id}: rounded once`).toBe(1);
      expect(hits[0].u, `mark ${e.mark.id}: on the keepOn side, clear of its radius`).toBeGreaterThan(e.mark.radius);
      for (let i = 0; i < line.n; i++) {
        expect(Math.hypot(line.x[i] - e.mark.at[0], line.z[i] - e.mark.at[1]), `mark ${e.mark.id} keep-out at sample ${i}`).toBeGreaterThanOrEqual(e.mark.radius + margin - 0.05);
      }
    }
  });
  return { slack };
}

describe('§T.186 racing line', () => {
  it('goes through every gate at least `margin` off the poles and rounds every mark on its side, at every risk level', () => {
    for (const lv of setup.levels) {
      const { slack } = checkCourse(course, lv.line, lv.margin);
      // the margin must actually bind somewhere, or this test could not see a margin bug: the relaxed line leans
      // on a corridor edge at some gate
      expect(Math.min(...slack), `risk ${lv.risk}: the line uses a corridor edge`).toBeLessThan(0.5);
    }
  });

  it('relaxation is what makes it a racing line: less Σκ² and a faster profile than joining the corridor midpoints', () => {
    const shape = setup.levels[2];
    const relaxed = shape.line;
    const raw = buildRacingLine(course, { margin: shape.margin, relax: false });
    const k2 = (l: RacingLine): number => l.kappa.reduce((a, k) => a + k * k * l.ds, 0);
    expect(k2(relaxed)).toBeLessThan(0.5 * k2(raw));
    expect(lapTime(relaxed, shape.speed)).toBeLessThan(0.9 * lapTime(raw, speedProfile(raw, shape)));
  });

  it('risk buys time: a tighter margin and more of the measured grip give a strictly faster profile per level', () => {
    const t = setup.levels.map((lv) => lapTime(lv.line, lv.speed));
    expect(setup.levels.length).toBe(LINE_LEVELS);
    for (let k = 1; k < t.length; k++) expect(t[k], `level ${k} vs ${k - 1}`).toBeLessThan(t[k - 1]);
    // and the margin really moved: the riskiest line passes closer to some pole than the safest may
    expect(setup.levels[4].margin).toBeLessThan(setup.levels[0].margin);
  });

  it('the profile never asks for more than the measured boat: corner speed within its turning, speed changes within its accel/decel', () => {
    for (const lv of setup.levels) {
      const { line, speed: v } = lv;
      for (let i = 0; i < line.n; i++) {
        const j = (i + 1) % line.n;
        if (v[i] > 4 + 1e-9) {
          expect(curvatureAt(v[i], lockLimit(v[i])) * lv.latUse, `risk ${lv.risk} sample ${i}: turning`).toBeGreaterThanOrEqual(Math.abs(line.kappa[i]) - 1e-6);
        }
        const dv2 = (v[j] * v[j] - v[i] * v[i]) / (2 * line.ds);
        expect(dv2, `sample ${i}: accel`).toBeLessThanOrEqual(accelAt(v[i], steerForCurvature(v[i], line.kappa[i])) + 1e-6);
        expect(-dv2, `sample ${i}: decel`).toBeLessThanOrEqual(decelAt(v[j], lv.brakeUse) + 1e-6);
      }
    }
  });

  it('marks: the rounding corridor sits on the side away from keepOn (a starboard mark mirrors a port one)', () => {
    const port = corridorsOf(course, 5).find((c) => c.keepOut)!;
    const mirrored: Course = {
      ...course,
      elements: course.elements.map((e) => (e.kind === 'mark' ? { kind: 'mark', mark: { ...e.mark, keepOn: 'starboard' } } : e)),
    };
    const stbd = corridorsOf(mirrored, 5).find((c) => c.keepOut)!;
    const mk = port.keepOut!;
    const side = (c: typeof port): number => ((c.ax + c.bx) / 2 - mk.x) * ((stbd.ax + stbd.bx) / 2 - mk.x) + ((c.az + c.bz) / 2 - mk.z) * ((stbd.az + stbd.bz) / 2 - mk.z);
    expect(side(port), 'opposite sides of the mark').toBeLessThan(0);
  });
});

describe('§T.186 AI block in the sim buffer', () => {
  const base = { boats: 3, wakeCap: 4, oceanLen: 10, seaLen: 5 };

  it('a layout without a pilot is byte-for-byte the pre-T186 layout (existing hashes and offsets unchanged)', () => {
    // the pre-T186 formula, restated on purpose: header 16 f64, params, WORLD, per-boat 44 + wakeCap×5
    expect(layoutByteLength(base)).toBe((16 + 10 + 5 + 3 * 13 + 3 * (44 + 4 * 5)) * 8);
    const L = new BoatSimLayout(new ArrayBuffer(layoutByteLength(base)), base);
    expect(new BoatSimLayout(L.buffer).spec).toEqual(base);
    expect(L.outRange(1)).toEqual([L.boatOffset(1) + B.POSE, L.boatOffset(1) + 44 + 4 * 5]);
    expect(() => L.aiOffset(0)).toThrow(/no AI block/);
  });

  it('with a pilot: AI OUT (the pilot memory) is inside the V2 hash, AI IN (standings from main) is not', () => {
    const spec = { ...base, aiLen: AI_BLOCK_LEN };
    const L = new BoatSimLayout(new ArrayBuffer(layoutByteLength(spec)), spec);
    expect(new BoatSimLayout(L.buffer).spec).toEqual(spec);
    const h0 = hashBoatOutput(L, 2);
    L.f64[L.aiOffset(2) + AI_OUT_LEN + AI_IN.GAP_TO_LEADER] = 3.5;
    expect(hashBoatOutput(L, 2), 'AI IN is an input, not hashed').toBe(h0);
    L.f64[L.aiOffset(2) + AI.STATION] = 0.25;
    expect(hashBoatOutput(L, 2), 'AI OUT is state, hashed').not.toBe(h0);
    expect(hashBoatOutput(L, 1)).toBe(hashBoatOutput(L, 1));
    expect(Object.keys(AI).length).toBe(AI_OUT_LEN);
    expect(Object.keys(AI_IN).length).toBe(AI_IN_LEN);
  });

  it('a rolling-start speed is encoded as a cap the pilot can only slow to — there is no way to encode "faster"', () => {
    const f = new Float64Array(AI_IN_LEN);
    const st = { racerId: 0, position: 2, lap: 0, nextElement: 0, progress: 0, gapToLeader: 1, finished: false, state: 'racing', surge: 0 } as const;
    encodeStanding(f, -AI_OUT_LEN, st, 8, 22);
    expect(f[AI_IN.GO]).toBe(-22);
    encodeStanding(f, -AI_OUT_LEN, st, 8, -5);
    expect(f[AI_IN.GO]).toBe(-0);
    encodeStanding(f, -AI_OUT_LEN, st, 8, true);
    expect(f[AI_IN.GO]).toBe(1);
  });
});
