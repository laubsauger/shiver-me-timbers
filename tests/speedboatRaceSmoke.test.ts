/**
 * §T.191 ONE PLAYABLE RACE SLICE, HEADLESS: Tower Reach, Calm, rolling start behind the pace boat, the player flown by
 * the rivals' own pilot, seven rival pilots on the fleet driver, one lap, results.
 *
 * WHY each assertion:
 *  - RESULTS FOR ALL EIGHT, THE PLAYER FINISHED: every system the page wires (course world, race logic, crash machines,
 *    collisions, the worker world data, the rivals' pilot, the delayed race pipeline) has to hold together for a lap
 *    to be classified. A race that never produces results is a page that never ends.
 *  - NO NaN: a non-finite pose anywhere poisons the fleet buffer and every rival after it (rigid6 throws, the fleet
 *    stops, the page freezes).
 *  - THE SAME HASH AT 60 FPS AND AT 20 FPS PACING (§V2): the race runs RACE_DELAY_TICKS behind the page precisely so
 *    that the rivals coming home late cannot change the race. This pumps the fleet every tick in one run and only at
 *    3-tick frame ends in the other (the loop holds when the fleet trails) and requires identical fleet OUT, player
 *    state and standings at tick 1500.
 *  - A RESET PUTS HER BACK ON THE WATER, LEVEL (user playtest 2026-09-13: "reset is throwing us out of the water and
 *    rotating us, making us land upside down"): hold reset → crash machine → the race's respawn point on the line →
 *    V108 teleport. The pose must be level at the rest float height on the surface, heading down the line, with no
 *    angular velocity; the first tick exchanges no leaked-memory slam (< 10 N·s against > 100 N·s); a second later she
 *    is upright on the water.
 * Working-sea capsizes are §T.189's known physics issue; this slice runs Calm and does not gate on them.
 */
import { describe, expect, it } from 'vitest';
import { RACE_DELAY_TICKS } from '../src/speedboat/page/raceSession';
import type { Rigid6State } from '../src/sea-physics/rigidBody';
import { NPCS, runSlice } from './speedboatRaceHarness';

const LAP_TICKS_MAX = 60 * 60 * 8; // 8 min of sim: rolling start (~30 s) + a 4.1 km lap well inside it

describe('§T.191 headless race slice on Tower Reach', () => {
  it('one lap in Calm completes with results for all eight racers, no NaN, and a pacing-independent hash', async () => {
    const full = await runSlice({ sea: 'calm', laps: 1, maxTicks: LAP_TICKS_MAX, untilPlayerFinish: true, hashTicks: [1500] });
    const st = full.state;
    expect(full.nonFinite).toBeNull();
    expect(full.slice.session.starvedTicks).toBe(0);
    expect(st, 'race state').not.toBeNull();
    expect(st?.results, 'results').toBeDefined();
    const results = st?.results ?? [];
    expect(results.length).toBe(NPCS + 1);
    const me = results.find((r) => r.racerId === 0);
    console.log(
      `[smoke] ticks ${full.ticks}; player machine ${full.slice.session.machines[0].phase}; results`,
      results.map((r) => `#${r.racerId} P${r.place} ${r.status} ${r.totalTime?.toFixed(1) ?? '-'}s laps ${r.lapsCompleted} +${r.penaltySeconds}s`).join(' | '),
    );
    expect(me?.status).toBe('finished');
    expect(me?.lapTimes.length).toBe(1);
    // a real lap of a 4.1 km course, not a start-line shuffle: ≥ 60 s at ≤ 70 m/s
    expect(me?.lapTimes[0] ?? 0).toBeGreaterThan(60);
    const finished = results.filter((r) => r.status === 'finished').length;
    expect(finished).toBeGreaterThanOrEqual(1);

    const paced = await runSlice({ sea: 'calm', laps: 1, maxTicks: 1500, ticksPerFrame: 3, pumpInTicks: false, hashTicks: [1500] });
    expect(paced.heldFrames, '20 fps pacing must actually make the fleet trail and the loop hold').toBeGreaterThan(0);
    expect(paced.nonFinite).toBeNull();
    expect(paced.hashes.get(1500)).toBe(full.hashes.get(1500));
  }, 3_600_000);

  it('a held reset lands the player level on the water, on the line, with no slam and no spin (V108)', async () => {
    let teleport: { tick: number; pose: Rigid6State; water: number } | null = null;
    let firstTickChecked = false;
    let firstSlam = Infinity;
    let settled: { tilt: number; above: number } | null = null;
    const RESET = 900;
    await runSlice({
      sea: 'calm', laps: 1, maxTicks: RESET + RACE_DELAY_TICKS + 240,
      resetAt: RESET,
      onPlayerTeleport: (tick, pose, s) => {
        if (tick < RESET) return; // the grid placement
        teleport = { tick, pose: structuredClone(pose) as Rigid6State, water: s.mirror.heightAt(pose.position[0], pose.position[2], s.time) };
      },
      onTick: (tick, s) => {
        const t = teleport as { tick: number } | null;
        if (!t) return;
        if (!firstTickChecked && tick === t.tick + 1) {
          // a per-location memory that survived the move slams > 100 N·s (crash.md); what remains here is the level
          // float height (flat-water rest) and the respawn speed (≥ 25 kn) wetting new sections between the tick's substeps:
          // 0.05–1.7 N·s measured on a 5.35 t hull (≤ 3e-4 m/s)
          firstSlam = Math.abs(s.player.hw.slamImpulse);
          firstTickChecked = true;
        }
        if (tick === t.tick + 60) {
          const q = s.player.state.quaternion;
          const upY = 1 - 2 * (q[0] * q[0] + q[2] * q[2]);
          const p = s.player.state.position;
          settled = { tilt: (Math.acos(Math.max(-1, Math.min(1, upY))) * 180) / Math.PI, above: p[1] - s.mirror.heightAt(p[0], p[2], s.time) };
        }
      },
    });
    const tp = teleport as { tick: number; pose: Rigid6State; water: number } | null;
    expect(tp, 'the reset teleported the player').not.toBeNull();
    if (!tp) return;
    const { pose, water } = tp;
    // level: a pure yaw quaternion; resting float height on the local surface; no spin; moving along its heading
    expect(Math.abs(pose.quaternion[0]) + Math.abs(pose.quaternion[2])).toBeLessThan(1e-12);
    expect(pose.position[1] - water).toBeGreaterThan(0.1);
    expect(pose.position[1] - water).toBeLessThan(0.4);
    expect(Math.hypot(...pose.angularVelocity)).toBe(0);
    expect(pose.velocity[1]).toBe(0);
    const yaw = 2 * Math.atan2(pose.quaternion[1], pose.quaternion[3]);
    const vyaw = Math.atan2(pose.velocity[0], pose.velocity[2]);
    expect(Math.abs(Math.atan2(Math.sin(yaw - vyaw), Math.cos(yaw - vyaw)))).toBeLessThan(1e-9);
    expect(firstTickChecked).toBe(true);
    expect(firstSlam).toBeLessThan(10);
    const st = settled as { tilt: number; above: number } | null;
    expect(st, 'one second after the respawn').not.toBeNull();
    expect(st?.tilt ?? 180).toBeLessThan(15);
    expect(Math.abs(st?.above ?? 9)).toBeLessThan(0.8);
  }, 1_800_000);
});
