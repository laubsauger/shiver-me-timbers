/**
 * §T.186 — the NPC pilot's own cost per boat per tick (the physics is not in this number).
 *
 * WHY: the pilot runs inside the step core for every rival on every tick, next to ~60 µs of hull physics. An
 * algorithmic slip there — a global line search every tick, a sea read that rebuilds the mirror (it did, once:
 * 39 ms/tick for 7 boats) — multiplies by boats × ticks. The budget is machine-scaled (tests/perfBudget.ts, V80: a
 * time budget is a decision about a machine).
 */
import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../src/core/loop';
import { encodeStanding } from '../src/race/ai/aiBlock';
import { ARCHETYPE_ORDER } from '../src/race/ai/archetypes';
import { buildPilotSetup, RacePilot } from '../src/race/ai/pilot';
import { CpuOcean } from '../src/sea-physics/cpuOcean';
import type { Rigid6State } from '../src/sea-physics/rigidBody';
import { AI_BLOCK_LEN, BoatSimLayout, layoutByteLength } from '../src/sim-worker/layout';
import { writeResetPose } from '../src/sim-worker/stepCore';
import { budgetMs, machineFactor } from './perfBudget';
import { seaParams, syntheticCourse } from './raceAiHarness';

/** µs per boat per tick on the reference machine, with margin for a loaded box (measured ~10–30 µs) */
const REFERENCE_US = 60;

describe('§T.186 pilot cost', () => {
  it('µs per NPC per tick for the pilot alone (8 boats, real sea mirror, wave reads, traffic loop)', () => {
    const roster = [...ARCHETYPE_ORDER, 'rival' as const];
    const setup = buildPilotSetup(syntheticCourse(), roster, { seed: 9 });
    const pilot = new RacePilot(setup);
    const N = roster.length;
    const spec = { boats: N, wakeCap: 2, oceanLen: 1, seaLen: 1, aiLen: AI_BLOCK_LEN };
    const L = new BoatSimLayout(new ArrayBuffer(layoutByteLength(spec)), spec);
    const p = seaParams('working');
    const ocean = new CpuOcean(9, p.ocean, p.sea);
    const line = setup.levels[2].line;
    const poses: Rigid6State[] = roster.map((_, i) => {
      const k = (i * 7) % line.n;
      const yaw = Math.atan2(line.tx[k], line.tz[k]);
      return { position: [line.x[k] + (i % 2) * 3, 0.5, line.z[k]], quaternion: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], velocity: [line.tx[k] * 22, 0, line.tz[k] * 22], angularVelocity: [0, 0, 0] };
    });
    poses.forEach((ps, i) => writeResetPose(L, i, ps));
    const out = { steer: 0, throttle: 0 };
    const TICKS = 900;
    let spent = 0;
    for (let t = 0; t < TICKS; t++) {
      const time = t * SIM_DT;
      ocean.update(time);
      poses.forEach((ps, j) => {
        const w = L.worldPoseOffset(j);
        [...ps.position, ...ps.quaternion, ...ps.velocity, ...ps.angularVelocity].forEach((v, c) => (L.f64[w + c] = v));
        encodeStanding(L.f64, L.aiOffset(j), { racerId: j, position: j + 1, lap: 0, nextElement: 1, progress: 0, gapToLeader: j, finished: false, state: 'racing', surge: 0 }, N, true);
      });
      const t0 = performance.now();
      for (let i = 0; i < N; i++) pilot.control(i, L, poses[i], ocean, time, false, out);
      if (t >= 200) spent += performance.now() - t0; // after JIT warm-up
      // move the boats along their lines so the tracker and the wave read see new water
      for (const ps of poses) {
        ps.position[0] += ps.velocity[0] * SIM_DT;
        ps.position[2] += ps.velocity[2] * SIM_DT;
      }
    }
    const us = (spent / ((TICKS - 200) * N)) * 1000;
    // eslint-disable-next-line no-console
    console.info(`[raceAi perf] pilot ${us.toFixed(1)} µs per NPC per tick (machine ×${machineFactor().toFixed(2)})`);
    expect(us).toBeLessThan(budgetMs(REFERENCE_US / 1000) * 1000);
  }, 120_000);
});
