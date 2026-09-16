/**
 * §T.213 follow-up — THE PLAYER'S AUTOPILOT IS NO LONGER WAKE-BLIND.
 *
 * WHY: `?autopilot` runs the rivals' own `RacePilot`, but its memory lives in a PRIVATE one-boat layout
 * (`page/autopilot.ts`), and that layout carried no WAKE WORLD. Every wake term in the pilot is gated on
 * `L.spec.wakeField`, so the player raced the same policy with an empty wake field while all seven rivals read one: her
 * lap could not look like a rival's, and the one boat a player watches most closely was the one boat that drove through
 * wakes as if they were not there.
 *
 * WHAT IS ASSERTED: with the race session's own per-tick rival records (`session.rivalWake`, the SAME array the player's
 * hull already floats on) handed to `wakeSources`, the pilot's wake reads fire and change what she does. The sea here is
 * FLAT, so `AI.SEA` — the running mean of the airtime the wave read predicts — can only leave zero if another boat's
 * wake reached that read: wake-blind it is exactly 0, wake-aware it is not, and the controls diverge. The fixture record
 * is checked against `WakeField` itself first, so a record that laid no field could not pass silently.
 *
 * NOT asserted here: `AI.WAKE_BRACE`. One 40 kN source at 8–14 m/s puts 1.7–2.7 % of roll slope across her path where
 * `BRACE_ROLL` starts at 4 % ([M]: a sweep of source speed 8–14 m/s × lateral −6…+12 m × 25–50 m ahead never reached
 * 0.2 of brace). The brace is a pack phenomenon and the sweep measures it; what this file proves is the WIRING.
 */
import { describe, expect, it } from 'vitest';
import { AI } from '../src/race/ai/aiBlock';
import { buildPilotSetup, type PilotSetup } from '../src/race/ai/pilot';
import { createAutopilotControls } from '../src/speedboat/page/autopilot';
import type { Rigid6State } from '../src/sea-physics/rigidBody';
import { AI_IN_LEN, POSE_LEN } from '../src/sim-worker/layout';
import { WakeField, WAKE_SRC_LEN, WS } from '../src/wake/wakeField';
import { syntheticCourse } from './raceAiHarness';

const BOATS = 2;
const PLAYER = 1;
/** flat water: the pilot's sea read is the ocean, and only the wake moves it */
const FLAT = { heightAt: (): number => 0 };

/** a planing hull's record: ~4 t of lift spread over a 12 m running length, 0.2 m under, 400 m of established pattern */
function record(x: number, z: number, vx: number, vz: number): Float64Array {
  const r = new Float64Array(WAKE_SRC_LEN);
  const F = 40000;
  r[WS.X] = x;
  r[WS.Z] = z;
  r[WS.VX] = vx;
  r[WS.VZ] = vz;
  r[WS.RUN] = 400;
  r[WS.F] = F;
  r[WS.FA] = 0;
  r[WS.FC] = 0;
  r[WS.FAA] = F * 9;
  r[WS.FCC] = F * 1;
  r[WS.FD] = F * 0.2;
  return r;
}

function pose(out: Float64Array, i: number, x: number, z: number, vx: number, vz: number): void {
  const o = i * POSE_LEN;
  out[o] = x;
  out[o + 1] = 0;
  out[o + 2] = z;
  out[o + 3] = 0;
  out[o + 4] = Math.sin(Math.atan2(vx, vz) / 2);
  out[o + 5] = 0;
  out[o + 6] = Math.cos(Math.atan2(vx, vz) / 2);
  out[o + 7] = vx;
  out[o + 9] = vz;
}

/** 4 s of ticks with the leader 35 m ahead at hump speed; returns the controls and the pilot's wave read */
function run(setup: PilotSetup, wake: Float64Array | null): { steer: number[]; throttle: number[]; sea: number } {
  const world = new Float64Array(BOATS * POSE_LEN);
  const standing = new Float64Array(AI_IN_LEN);
  standing[0] = 1; // VALID
  standing[7] = 1; // GO: racing
  const ap = createAutopilotControls({
    setup, index: PLAYER, boats: BOATS, lockRad: 0.33, sea: FLAT,
    time: () => 0, world: () => world, standing: () => standing, propImmersion: () => 1,
    ...(wake ? { wakeSources: () => ({ rec: wake, count: 1 }) } : {}),
  });
  const me: Rigid6State = {
    position: new Float64Array([0, 0, 0]), quaternion: new Float64Array([0, 0, 0, 1]),
    velocity: new Float64Array([0, 0, 22]), angularVelocity: new Float64Array([0, 0, 0]),
  } as unknown as Rigid6State;
  const steer: number[] = [];
  const throttle: number[] = [];
  for (let k = 0; k < 240; k++) {
    // she runs up the G0→G1 leg of the synthetic course (the racing line is near x = 4); the leader is 35 m ahead on it,
    // at hump speed — the case §T.213 measured as the one whose wake matters
    me.position[2] = 22 * k * (1 / 60);
    pose(world, PLAYER, me.position[0], me.position[2], 22, 0);
    pose(world, 0, 4.5, me.position[2] + 35, 0, 10);
    if (wake) wake.set(record(4.5, me.position[2] + 35, 0, 10));
    const c = ap.sample(1 / 60, me);
    steer.push(c.steer);
    throttle.push(c.throttle);
  }
  return { steer, throttle, sea: ap.readAi(AI.SEA) };
}

describe('§T.213 follow-up: the player autopilot reads wakes', () => {
  const setup = buildPilotSetup(syntheticCourse(1), [null, 'veteran'], { seed: 7, catchUp: true });

  it('the fixture record really lays a field (else the rest of this file proves nothing)', () => {
    const f = new WakeField();
    const rec = record(0, 40, 0, 10);
    expect(f.prepare(rec, 0, 1, PLAYER, 0, 0)).toBe(1);
    let peak = 0;
    for (let z = 0; z <= 35; z += 1) for (let x = -14; x <= 14; x += 1) peak = Math.max(peak, Math.abs(f.heightAt(x, z)));
    expect(peak, 'a hump-speed wake is decimetres, not zero').toBeGreaterThan(0.05);
  });

  it('with the session wake records wired in, the wake reaches the policy and changes what she does', () => {
    const blind = run(setup, null);
    const seeing = run(setup, new Float64Array(WAKE_SRC_LEN));
    // flat ocean: the only thing that can put a ramp under her wave read is another boat's wake
    expect(blind.sea, 'wake-blind on flat water: the wave read finds nothing').toBe(0);
    expect(seeing.sea, 'wake-aware: the wake is a ramp in the wave read').toBeGreaterThan(0.005);
    const moved = seeing.steer.some((s, k) => Math.abs(s - blind.steer[k]) > 1e-9) || seeing.throttle.some((t, k) => Math.abs(t - blind.throttle[k]) > 1e-9);
    expect(moved, 'the wake changes what she does').toBe(true);
  });

  it('a record with no load is inert: an empty wake world reads as flat water (§V108)', () => {
    const world = new Float64Array(BOATS * POSE_LEN);
    const standing = new Float64Array(AI_IN_LEN);
    standing[0] = 1;
    standing[7] = 1;
    const empty = new Float64Array(WAKE_SRC_LEN);
    const ap = createAutopilotControls({
      setup, index: PLAYER, boats: BOATS, lockRad: 0.33, sea: FLAT,
      time: () => 0, world: () => world, standing: () => standing, propImmersion: () => 1,
      wakeSources: () => ({ rec: empty, count: 1 }),
    });
    const me: Rigid6State = {
      position: new Float64Array([0, 0, 0]), quaternion: new Float64Array([0, 0, 0, 1]),
      velocity: new Float64Array([0, 0, 22]), angularVelocity: new Float64Array([0, 0, 0]),
    } as unknown as Rigid6State;
    for (let k = 0; k < 240; k++) {
      me.position[2] = 22 * k * (1 / 60);
      pose(world, PLAYER, me.position[0], me.position[2], 22, 0);
      pose(world, 0, 4.5, me.position[2] + 35, 0, 10);
      ap.sample(1 / 60, me);
    }
    expect(ap.readAi(AI.SEA), 'a zero-load record lays no field').toBe(0);
  });
});
