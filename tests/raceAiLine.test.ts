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
import { buildRacingLine, corridorsOf, gateMargin, LINE_CLEAR, MARK_TRACK, ROOM_CAP, ROOM_CLEAR, type RacingLine } from '../src/race/ai/line';
import { buildKeepOuts, keepOutClearance } from '../src/race/ai/keepOut';
import { buildPilotSetup, LINE_LEVELS } from '../src/race/ai/pilot';
import { speedProfile } from '../src/race/ai/profile';
import type { Course } from '../src/race/types';
import { AI_BLOCK_LEN, AI_IN_LEN, AI_OUT_LEN, B, BoatSimLayout, hashBoatOutput, layoutByteLength } from '../src/sim-worker/layout';
import { FX_LEN } from '../src/sim-worker/fx';
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
      // gateMargin: + the pilot's tracking error near a gate, and a share of a wide gate (a 4.4 m margin let a boat 7 m off
      // its line miss G8)
      const gm = gateMargin(margin, w);
      expect(u, `gate ${e.gate.id}: ≥ margin + tracking off the left pole`).toBeGreaterThanOrEqual(gm - 0.05);
      expect(u, `gate ${e.gate.id}: ≥ margin + tracking off the right pole`).toBeLessThanOrEqual(w - gm + 0.05);
      slack.push(Math.min(u - gm, w - gm - u));
    } else {
      const p = ctr((k + m - 1) % m);
      const q = ctr((k + 1) % m);
      const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const dx = (q[0] - p[0]) / l;
      const dz = (q[1] - p[1]) / l;
      // race/types.ts handedness (T196: race/ai moved to it): keepOn 'port' ⇒ the mark on the boat's port ⇒ the boat passes
      // on the STARBOARD side of the chord direction, (−dz, dx); 'starboard' ⇒ its port side, (dz, −dx)
      const sg = e.mark.keepOn === 'port' ? -1 : 1;
      const hits = crossings(line, e.mark.at[0], e.mark.at[1], sg * dz, -sg * dx, dx, dz).filter((h) => Math.abs(h.u) < 200);
      expect(hits.length, `mark ${e.mark.id}: rounded once`).toBe(1);
      expect(hits[0].u, `mark ${e.mark.id}: on the keepOn side, clear of its radius`).toBeGreaterThan(e.mark.radius);
      // + MARK_TRACK: the pilot tracks its line to 4–6 m; a line at radius + margin let a boat cut the rounding radius
      for (let i = 0; i < line.n; i++) {
        expect(Math.hypot(line.x[i] - e.mark.at[0], line.z[i] - e.mark.at[1]), `mark ${e.mark.id} keep-out at sample ${i}`).toBeGreaterThanOrEqual(e.mark.radius + margin + MARK_TRACK - 0.05);
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

  // WHY: statics are solid (§T.198). The line knew only gates and marks, and between corridors it offered avoidance and
  // blocking a flat ROOM_CAP of room: on Tower Reach that room reached Main Street's roof walls. A solid wall laid ON the
  // open-water line must push the line LINE_CLEAR off it, and a wall beside the line must take the room on its side.
  it('keep-outs: the line bends LINE_CLEAR around a static solid on it, and a solid beside it takes the room on that side', () => {
    const open = setup.levels[2];
    const ln = open.line;
    const wallAt = (lat: number, from: number, to: number): { a: number[]; b: number[]; radius: number }[] => {
      const w: { a: number[]; b: number[]; radius: number }[] = [];
      for (let st = from; st <= to; st += 2) {
        const i = Math.round(st / ln.ds);
        const x = ln.x[i] + ln.tz[i] * lat;
        const z = ln.z[i] - ln.tx[i] * lat;
        w.push({ a: [x, -0.5, z], b: [x, 1, z], radius: 1 });
      }
      return w;
    };
    // on the line, mid-way between the start gates (open water), and 6 m to the side further on
    const on = wallAt(0, 80, 90);
    const beside = wallAt(-(ROOM_CLEAR + 4), 120, 170);
    const ko = buildKeepOuts([...on, ...beside]);
    const line = buildRacingLine(course, { margin: open.margin, keepOuts: ko });
    const clear = (l: RacingLine): number => Math.min(...Array.from(l.x, (x, i) => keepOutClearance(ko, x, l.z[i])));
    expect(clear(ln), 'the open-water line runs through the wall').toBeLessThan(0);
    expect(clear(line)).toBeGreaterThanOrEqual(LINE_CLEAR - 0.5);
    checkCourse(course, line, open.margin);
    // beside: every sample's room toward the wall ends ROOM_CLEAR short of it (the wall is at lateral −(ROOM_CLEAR + 4))
    const wallOnly = buildKeepOuts(beside);
    const lineB = buildRacingLine(course, { margin: open.margin, keepOuts: wallOnly });
    let checked = 0;
    for (let i = 0; i < lineB.n; i++) {
      const c = keepOutClearance(wallOnly, lineB.x[i], lineB.z[i]);
      if (c >= ROOM_CAP + ROOM_CLEAR) continue;
      const side = -1; // the wall lies to −n; room on −n is roomPort (line.ts: (tz, −tx) is the + side, roomStbd)
      const room = side < 0 ? lineB.roomPort[i] : lineB.roomStbd[i];
      const px = lineB.x[i] - lineB.tz[i] * room;
      const pz = lineB.z[i] + lineB.tx[i] * room;
      expect(keepOutClearance(wallOnly, px, pz), `sample ${i}: the offset hull clears the wall`).toBeGreaterThanOrEqual(ROOM_CLEAR - 1.01);
      checked++;
    }
    expect(checked, 'samples beside the wall').toBeGreaterThan(10);
  });

  it('marks: the rounding corridor sits on the side away from keepOn (a starboard mark mirrors a port one)', () => {
    const port = corridorsOf(course, 5).find((c) => c.keepOut)!;
    const mirrored: Course = {
      ...course,
      elements: course.elements.map((e) => (e.kind === 'mark' ? { kind: 'mark', mark: { ...e.mark, keepOn: e.mark.keepOn === 'port' ? 'starboard' : 'port' } } : e)),
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
    // the pre-T186 formula, restated on purpose: header f64, params, WORLD, per-boat 44 + wakeCap×5. The header is 20
    // f64 since sim layout v2 (§T.191 F.EXTERNAL_BOATS / F.TRACE_LEN); what this pins is that a pilot-less layout adds
    // no AI bytes, not the header size. Layout v3 (§T.195) put the per-boat EFFECTS record (FX_LEN f64) between the
    // fixed boat slots and the wake samples (re-pinned T196): still no AI bytes without a pilot
    expect(layoutByteLength(base)).toBe((20 + 10 + 5 + 3 * 13 + 3 * (44 + FX_LEN + 4 * 5)) * 8);
    const L = new BoatSimLayout(new ArrayBuffer(layoutByteLength(base)), base);
    expect(new BoatSimLayout(L.buffer).spec).toEqual(base);
    expect(L.outRange(1)).toEqual([L.boatOffset(1) + B.POSE, L.boatOffset(1) + 44 + FX_LEN + 4 * 5]);
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
