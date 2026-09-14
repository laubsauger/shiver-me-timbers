/**
 * §T.186 NPC pilot, unit level (no hull physics; boats moved kinematically so each property is isolated).
 *
 * WHY each block:
 *  - sea reads at the tick's own time: `CpuOcean.heightAt(x, z, t)` with t ≠ its time REBUILDS the mirror and steps
 *    the spectrum scheduler. A pilot peeking at a future sea would change the sea every boat floats on (and cost a
 *    64² IFFT per read — measured 39 ms/tick for 7 boats when it did).
 *  - memory lives in the buffer: a pilot object rebuilt mid-race (worker restart, transport downgrade) must carry on
 *    bit-identically, or a replay (V2) diverges on a machine event.
 *  - avoidance and blocking come from the WORLD snapshot and move the boat the right way.
 *  - catch-up is a RISK change only; the throttle stays the physics' own −0.3..1.
 */
import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../src/core/loop';
import { AI, AI_IN, encodeStanding } from '../src/race/ai/aiBlock';
import { buildPilotSetup, RacePilot, type PilotOutput, type PilotSetup, type SeaHeight } from '../src/race/ai/pilot';
import type { Rigid6State } from '../src/sea-physics/rigidBody';
import { AI_BLOCK_LEN, AI_OUT_LEN, BoatSimLayout, layoutByteLength } from '../src/sim-worker/layout';
import { writeResetPose } from '../src/sim-worker/stepCore';
import { seaParams, syntheticCourse } from './raceAiHarness';
import { CpuOcean } from '../src/sea-physics/cpuOcean';
import { keepOutClearance } from '../src/race/ai/keepOut';
import type { ArchetypeId } from '../src/race/ai/archetypes';

const course = syntheticCourse();

function layoutFor(boats: number): BoatSimLayout {
  const spec = { boats, wakeCap: 2, oceanLen: 1, seaLen: 1, aiLen: AI_BLOCK_LEN };
  return new BoatSimLayout(new ArrayBuffer(layoutByteLength(spec)), spec);
}

function poseAt(setup: PilotSetup, station: number, lateral: number, speed: number): Rigid6State {
  const line = setup.levels[2].line;
  const i = ((Math.round(station / line.ds) % line.n) + line.n) % line.n;
  const tx = line.tx[i];
  const tz = line.tz[i];
  const yaw = Math.atan2(tx, tz);
  return {
    position: [line.x[i] + tz * lateral, 0.5, line.z[i] - tx * lateral],
    quaternion: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
    velocity: [tx * speed, 0, tz * speed],
    angularVelocity: [0, 0, 0],
  };
}

/** WORLD ← poses, and mark the boats placed (the core does this through the reset path) */
function publish(L: BoatSimLayout, poses: Rigid6State[]): void {
  poses.forEach((p, j) => {
    const w = L.worldPoseOffset(j);
    [...p.position, ...p.quaternion, ...p.velocity, ...p.angularVelocity].forEach((v, c) => (L.f64[w + c] = v));
  });
}

/** crude kinematic boat: speed kept, yaw rate from the drive angle (+ = port), enough to close the loop */
function advance(p: Rigid6State, out: PilotOutput): void {
  const V = Math.hypot(p.velocity[0], p.velocity[2]);
  let yaw = Math.atan2(p.velocity[0], p.velocity[2]);
  yaw += -out.steer * 0.06 * V * SIM_DT;
  p.velocity[0] = Math.sin(yaw) * V;
  p.velocity[2] = Math.cos(yaw) * V;
  p.position[0] += p.velocity[0] * SIM_DT;
  p.position[2] += p.velocity[2] * SIM_DT;
  p.quaternion = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
}

const flatSea: SeaHeight = { heightAt: () => 0 };

describe('§T.186 pilot', () => {
  it('reads the sea only at the tick it is stepping (a future-time read would rebuild the shared mirror)', () => {
    const setup = buildPilotSetup(course, ['swell'], { seed: 3 });
    const pilot = new RacePilot(setup);
    const L = layoutFor(1);
    const p = poseAt(setup, 300, 0, 22);
    const times: number[] = [];
    const sea: SeaHeight = { heightAt: (_x, _z, t) => (times.push(t), 0) };
    const out = { steer: 0, throttle: 0 };
    for (let k = 0; k < 60; k++) {
      publish(L, [p]);
      const time = 10 + k * SIM_DT;
      const before = times.length;
      pilot.control(0, L, p, sea, time, false, out);
      for (let q = before; q < times.length; q++) expect(times[q]).toBe(time);
      advance(p, out);
    }
    expect(times.length, 'the wave read ran').toBeGreaterThan(50);
    // and against the real mirror: its clock does not move
    const ps = seaParams('calm');
    const ocean = new CpuOcean(5, ps.ocean, ps.sea);
    ocean.update(10);
    pilot.control(0, L, p, ocean, 10, false, out);
    expect(ocean.currentTime).toBe(10);
  });

  it('keeps no memory outside the buffer: a pilot rebuilt mid-race continues bit-identically', () => {
    const roster: ArchetypeId[] = ['rookie', 'hothead', 'blocker'];
    const setup = buildPilotSetup(course, roster, { seed: 11 });
    const run = (rebuildAt: number): { bytes: Uint8Array; outs: number[] } => {
      let pilot = new RacePilot(setup);
      const L = layoutFor(3);
      const poses = [poseAt(setup, 100, 0, 20), poseAt(setup, 80, 4, 24), poseAt(setup, 60, -4, 26)];
      poses.forEach((p, i) => writeResetPose(L, i, p));
      const outs: number[] = [];
      const out = { steer: 0, throttle: 0 };
      for (let k = 0; k < 400; k++) {
        if (k === rebuildAt) pilot = new RacePilot(structuredClone(setup));
        publish(L, poses);
        for (let i = 0; i < 3; i++) {
          encodeStanding(L.f64, L.aiOffset(i), { racerId: i, position: i + 1, lap: 0, nextElement: 1, progress: 0, gapToLeader: i * 2.5, finished: false, state: 'racing', surge: 0 }, 3, true);
          pilot.control(i, L, poses[i], flatSea, k * SIM_DT, false, out);
          outs.push(out.steer, out.throttle);
          advance(poses[i], out);
        }
      }
      return { bytes: new Uint8Array(L.buffer.slice(0)), outs };
    };
    const a = run(-1);
    const b = run(173);
    expect(b.outs).toEqual(a.outs);
    expect(b.bytes).toEqual(a.bytes);
    // the run is not trivially static: the pilots steered, throttled and drew mistakes from the rng
    expect(new Set(a.outs.filter((_, k) => k % 2 === 0)).size).toBeGreaterThan(50);
  });

  it('avoidance: a slower boat just ahead on the line pushes the pilot to the side away from it', () => {
    for (const side of [1, -1]) {
      const setup = buildPilotSetup(course, ['veteran', null], { seed: 1 });
      const pilot = new RacePilot(setup);
      const L = layoutFor(2);
      const me = poseAt(setup, 60, 0, 22);
      const other = poseAt(setup, 68, 1.5 * side, 12);
      const out = { steer: 0, throttle: 0 };
      for (let k = 0; k < 20; k++) {
        publish(L, [me, other]);
        pilot.control(0, L, me, flatSea, k * SIM_DT, false, out);
      }
      expect(Math.sign(L.f64[L.aiOffset(0) + AI.OFFSET]), `other to ${side > 0 ? 'starboard' : 'port'}`).toBe(-side);
      expect(Math.abs(L.f64[L.aiOffset(0) + AI.OFFSET])).toBeGreaterThan(0.5);
    }
  });

  it('blocking: a faster boat close behind makes an aggressive pilot cover the inside of the next turn; a rookie barely moves', () => {
    const offsetFor = (id: ArchetypeId): { blocking: number; offset: number; inside: number } => {
      const setup = buildPilotSetup(course, [id, null], { seed: 1 });
      const line = setup.levels[2].line;
      // a station with a clear turn in the next 150 m
      let best = 0;
      let bestK = 0;
      for (let i = 0; i < line.n; i += 5) {
        let k = 0;
        for (let q = 0; q < Math.round(150 / line.ds); q++) k += line.kappa[(i + q) % line.n];
        if (Math.abs(k) > Math.abs(bestK)) {
          bestK = k;
          best = i;
        }
      }
      const pilot = new RacePilot(setup);
      const L = layoutFor(2);
      const me = poseAt(setup, best * line.ds, 0, 18);
      const chaser = poseAt(setup, best * line.ds - 14, 0, 25);
      const out = { steer: 0, throttle: 0 };
      for (let k = 0; k < 60; k++) {
        publish(L, [me, chaser]);
        pilot.control(0, L, me, flatSea, k * SIM_DT, false, out);
      }
      return { blocking: L.f64[L.aiOffset(0) + AI.BLOCKING], offset: L.f64[L.aiOffset(0) + AI.OFFSET], inside: Math.sign(bestK) };
    };
    const wall = offsetFor('blocker');
    expect(wall.blocking).toBe(1);
    expect(Math.sign(wall.offset), 'toward the inside').toBe(wall.inside);
    expect(Math.abs(wall.offset)).toBeGreaterThan(1.5);
    const rookie = offsetFor('rookie');
    expect(Math.abs(rookie.offset)).toBeLessThan(0.5 * Math.abs(wall.offset));
  });

  it('catch-up raises RISK (line level) for a trailing boat and nothing else; off, the same boat takes base risk', () => {
    const risk = (catchUp: boolean, gap: number): { risk: number; level: number; thr: number[] } => {
      const setup = buildPilotSetup(course, ['rival'], { seed: 1, catchUp });
      const pilot = new RacePilot(setup);
      const L = layoutFor(1);
      const p = poseAt(setup, 200, 0, 20);
      const out = { steer: 0, throttle: 0 };
      const thr: number[] = [];
      for (let k = 0; k < 120; k++) {
        publish(L, [p]);
        encodeStanding(L.f64, L.aiOffset(0), { racerId: 0, position: gap > 0 ? 7 : 1, lap: 1, nextElement: 2, progress: 500, gapToLeader: gap, finished: false, state: 'racing', surge: 0 }, 8, true);
        pilot.control(0, L, p, flatSea, k * SIM_DT, false, out);
        thr.push(out.throttle);
        advance(p, out);
      }
      return { risk: L.f64[L.aiOffset(0) + AI.RISK], level: L.f64[L.aiOffset(0) + AI.LEVEL], thr };
    };
    const lead = risk(true, 0);
    const trail = risk(true, 9);
    const off = risk(false, 9);
    expect(trail.risk).toBeGreaterThan(lead.risk + 0.3);
    expect(trail.level).toBeGreaterThan(lead.level);
    expect(off.risk).toBe(lead.risk);
    for (const t of [...lead.thr, ...trail.thr]) {
      expect(t).toBeLessThanOrEqual(1);
      expect(t).toBeGreaterThanOrEqual(-0.3);
    }
  });

  // WHY: the trim request was computed and dropped (HullWater had no trim input). The sim core can only apply what the
  // pilot hands it: the request must leave the pilot in its output, as the seam's unit trim, and be the value it records.
  it('trim: the request is returned in the output (bow down over a steep sea, a little bow up on a fast flat straight)', () => {
    const trimOver = (sea: SeaHeight): number[] => {
      const setup = buildPilotSetup(course, ['swell'], { seed: 3 });
      const pilot = new RacePilot(setup);
      const L = layoutFor(1);
      const p = poseAt(setup, 40, 0, 25);
      const out: PilotOutput = { steer: 0, throttle: 0 };
      const trims: number[] = [];
      for (let k = 0; k < 90; k++) {
        publish(L, [p]);
        pilot.control(0, L, p, sea, k * SIM_DT, false, out);
        expect(out.trim, 'output = recorded request').toBe(L.f64[L.aiOffset(0) + AI.TRIM]);
        trims.push(out.trim as number);
      }
      return trims;
    };
    expect(trimOver(flatSea).at(-1)).toBeGreaterThan(0);
    expect(Math.min(...trimOver({ heightAt: (x, z) => 3 * Math.sin((x + z) * 0.2) })), 'bow down for the waves').toBeLessThan(-0.2);
  });

  // WHY: collisions with statics are solid (§T.198); a pilot knocked off its line pursues a chord straight back to it,
  // and on Tower Reach that chord crossed Main Street's roof walls. A keep-out between the boat and its line must bend
  // the pursuit around it; the same run without keep-outs proves the chord really went through the wall.
  it('keep-outs: a boat off its line steers around a wall between it and the line instead of through it', () => {
    const open = buildPilotSetup(course, ['veteran'], { seed: 1 });
    const ln = open.levels[2].line;
    const wall: { a: number[]; b: number[]; radius: number }[] = [];
    for (let st = 60; st <= 150; st += 3) {
      const i = Math.round(st / ln.ds);
      const wx = ln.x[i] + ln.tz[i] * 10;
      const wz = ln.z[i] - ln.tx[i] * 10;
      wall.push({ a: [wx, -0.5, wz], b: [wx, 1, wz], radius: 1.5 });
    }
    const minClear = (withKeepOuts: boolean): number => {
      const setup = buildPilotSetup(course, ['veteran'], { seed: 1, colliders: withKeepOuts ? wall : undefined });
      const probe = buildPilotSetup(course, ['veteran'], { seed: 1, colliders: wall }).keepOuts!;
      const pilot = new RacePilot(setup);
      const L = layoutFor(1);
      const p = poseAt(open, 40, 20, 20);
      const out: PilotOutput = { steer: 0, throttle: 0 };
      let m = Infinity;
      for (let k = 0; k < 360; k++) {
        publish(L, [p]);
        pilot.control(0, L, p, flatSea, k * SIM_DT, false, out);
        advance(p, out);
        m = Math.min(m, keepOutClearance(probe, p.position[0], p.position[2]));
      }
      return m;
    };
    expect(minClear(false), 'without keep-outs the pursuit chord runs through the wall').toBeLessThan(0);
    expect(minClear(true), 'with keep-outs the hull stays clear of it').toBeGreaterThan(1.5);
  });

  it('a capsized boat or a crashed standing cuts the throttle and centres the helm', () => {
    const setup = buildPilotSetup(course, ['hothead'], { seed: 1 });
    const pilot = new RacePilot(setup);
    const L = layoutFor(1);
    const p = poseAt(setup, 200, 0, 20);
    const out = { steer: 0, throttle: 0 };
    publish(L, [p]);
    pilot.control(0, L, p, flatSea, 0, false, out);
    p.quaternion = [Math.sin(1.2), 0, 0, Math.cos(1.2)]; // 137° over
    pilot.control(0, L, p, flatSea, SIM_DT, false, out);
    expect(out.throttle).toBe(0);
    expect(L.f64[L.aiOffset(0) + AI.UPSET]).toBe(1);
    p.quaternion = [0, 0, 0, 1];
    L.f64[L.aiOffset(0) + AI_OUT_LEN + AI_IN.VALID] = 1;
    L.f64[L.aiOffset(0) + AI_OUT_LEN + AI_IN.STATE] = 1;
    pilot.control(0, L, p, flatSea, 2 * SIM_DT, false, out);
    expect(out.throttle).toBe(0);
  });
});
