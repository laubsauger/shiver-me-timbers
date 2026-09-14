/**
 * §V110 RIVALS FEEL THE WAVES (§T.191; user playtest 2026-09-13: "npcs don't feel the waves it seems and look like
 * they're just floating straight along").
 *
 * WHY: a rival that is drawn from a placeholder path, a flattened pose, or a physics step that does not sample the
 * sea would read as a toy next to the player — and would race a different, easier sea (§V110). This drives the rivals
 * through the page's own fleet driver (`createNpcFleetDriver`, the pipelined worker path on the 'main' transport)
 * and the player through the page's `createPlayerBoat` on a page-style mirror of the SAME Working sea, same seed, same
 * params, same throttle, and compares what each hull does in pitch and roll — on the RENDER pose the page draws for
 * the rivals, not just the sim state.
 *
 * It fails if the rivals' pitch/roll variance is zero (a flattened or scripted pose) or more than an order of
 * magnitude away from the player's (a different sea, or a different step).
 */
import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../src/core/loop';
import { oceanParams } from '../src/params/ocean';
import { CpuOcean } from '../src/sea-physics/cpuOcean';
import type { Rigid6State } from '../src/sea-physics/rigidBody';
import { buildDeepVHull } from '../src/speedboat/hullMesh';
import { gridSlot } from '../src/speedboat/page/course';
import { createNpcFleetDriver } from '../src/speedboat/page/npcFleet';
import { createPlayerBoat } from '../src/speedboat/page/playerBoat';
import { speedboatSeaParams } from '../src/speedboat/page/seaParams';
import type { ShipState } from '../src/state/simState';

const DEG = 180 / Math.PI;
const THROTTLE = 0.6;

/** pitch (bow up) and heel from a quaternion, degrees — total functions over SO(3) like crash/sensors.ts */
function attitude(q: ArrayLike<number>): { pitch: number; roll: number } {
  const [x, y, z, w] = [q[0], q[1], q[2], q[3]];
  const fwdY = 2 * (y * z - w * x);
  const rightY = 2 * (x * y + w * z);
  const upY = 1 - 2 * (x * x + z * z);
  return { pitch: Math.asin(Math.max(-1, Math.min(1, fwdY))) * DEG, roll: Math.atan2(rightY, upY) * DEG };
}

function std(v: number[]): number {
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
}

describe('§V110 rivals pitch and roll on the Working sea like the player', () => {
  it('render-pose pitch/roll std of every rival is > 0 and within 10× of the player on the same sea', async () => {
    const hull = buildDeepVHull();
    const seed = 2100;
    const ocean = structuredClone(oceanParams); // shipped default 'swell' = Working sea
    const seaParams = speedboatSeaParams(hull);
    const mirror = new CpuOcean(seed, ocean, seaParams);
    const state = { ...gridSlot(0) } as unknown as ShipState;
    const player = createPlayerBoat({ hull, pressureHeadAt: (x, z, t) => mirror.pressureHeadAt(x, z, t) }, state);
    player.place(gridSlot(0));
    const warn = console.warn;
    console.warn = () => {};
    const npcs = await createNpcFleetDriver({
      seed, boats: 3, oceanParams: ocean, seaParams, spawn: (i) => gridSlot(i + 1),
      controls: () => ({ throttle: THROTTLE, steer: 0 }),
      caps: { crossOriginIsolated: false, sharedArrayBuffer: false, worker: false }, budgetMs: 1e6,
    });
    console.warn = warn;
    const P = { pitch: [] as number[], roll: [] as number[] };
    let playerCapsized = false;
    const N = [0, 1, 2].map(() => ({ pitch: [] as number[], roll: [] as number[], speed: [] as number[] }));
    const playerSpeed: number[] = [];
    const capsized = [false, false, false];
    const pose: Rigid6State = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] };
    let time = 0;
    try {
      for (let tick = 1; tick <= 900; tick++) {
        time += SIM_DT;
        mirror.update(time);
        player.tick({ steer: 0, throttle: THROTTLE, trim: 0, surge: false }, time);
        npcs.recordTick(tick, time);
        npcs.pump(tick);
        npcs.pump(tick);
        if (tick < 300) continue; // up to speed first
        const a = attitude(state.quaternion);
        if (playerCapsized || Math.abs(a.roll) > 60) playerCapsized = true;
        else {
          P.pitch.push(a.pitch);
          P.roll.push(a.roll);
          playerSpeed.push(Math.hypot(state.velocity[0], state.velocity[2]));
        }
        for (let i = 0; i < 3; i++) {
          const b = attitude(npcs.renderPose(i, 0.5, pose).quaternion);
          // a capsize (the known Working-sea roll-over, §T.189) ends that hull's attitude record: it is a different motion
          if (capsized[i] || Math.abs(b.roll) > 60) {
            capsized[i] = true;
            continue;
          }
          N[i].pitch.push(b.pitch);
          N[i].roll.push(b.roll);
          N[i].speed.push(Math.hypot(npcs.pose(i).velocity[0], npcs.pose(i).velocity[2]));
        }
      }
    } finally {
      npcs.dispose();
    }
    console.log('capsized (§T.189, not gated)', capsized, 'player', std(P.pitch).toFixed(3), std(P.roll).toFixed(3), 'rivals', N.map((n) => `${std(n.pitch).toFixed(3)}/${std(n.roll).toFixed(3)} maxRoll ${Math.max(...n.roll.map(Math.abs)).toFixed(0)} v̄ ${(n.speed.reduce((q, b) => q + b, 0) / n.speed.length).toFixed(2)}`).join(' | '), 'player v̄', (playerSpeed.reduce((q, b) => q + b, 0) / playerSpeed.length).toFixed(2));
    const ps = std(P.pitch);
    const pr = std(P.roll);
    expect(P.pitch.length, 'player upright record').toBeGreaterThanOrEqual(150);
    expect(ps).toBeGreaterThan(0.05);
    expect(pr).toBeGreaterThan(0.05);
    let compared = 0;
    for (let i = 0; i < 3; i++) {
      if (N[i].pitch.length < 150) continue;
      compared++;
      const ns = std(N[i].pitch);
      const nr = std(N[i].roll);
      expect(ns, `rival ${i} pitch std ${ns.toFixed(3)}° vs player ${ps.toFixed(3)}°`).toBeGreaterThan(ps / 10);
      expect(ns).toBeLessThan(ps * 10);
      expect(nr, `rival ${i} roll std ${nr.toFixed(3)}° vs player ${pr.toFixed(3)}°`).toBeGreaterThan(pr / 10);
      expect(nr).toBeLessThan(pr * 10);
      // under way like the player on the same throttle (not drifting, not on a scripted speed). MEAN speed over the upright
      // record, not the last tick's: at 0.6 throttle every hull in this sea climbs and falls off the swell at 1–7 m/s, so
      // one instantaneous sample is a coin toss. [M] the swell-travel sign fix (src/ocean/oceanMath.ts swellSpectrum, 9ddbf7e)
      // changed the realization and the final-tick sample went 3.17 m/s player vs 7.20 rival (fail) while the means stayed
      // within 2× of each other.
      if (!capsized[i] && !playerCapsized) {
        const mean = (v: number[]): number => v.reduce((q, b) => q + b, 0) / v.length;
        const vn = mean(N[i].speed);
        const vp = mean(playerSpeed);
        expect(vn, `rival ${i} ${vn.toFixed(1)} m/s vs player ${vp.toFixed(1)} m/s`).toBeGreaterThan(0.5 * vp);
        expect(vn).toBeLessThan(2 * vp);
      }
    }
    expect(compared, 'rivals with ≥ 2.5 s of upright record').toBeGreaterThanOrEqual(2);
  }, 300_000);
});
