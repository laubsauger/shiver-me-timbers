/**
 * AUTOPILOT CONTROL SOURCE (§T.191): the player's boat driven by the SAME §T.186 `RacePilot` a rival runs, behind the
 * `ControlSource` seam. For the headless smoke race (tests/speedboatRaceSmoke.test.ts) and `?autopilot` on the page.
 *
 * Same inputs a rival's pilot reads in `BoatSimCore.step`: its own tick pose, a WORLD snapshot of every boat (the race
 * session's tick-start snapshot, fleet index order), the sea at the tick time (the page mirror, already advanced to
 * this tick by `frame.tickSea` — never a future-time read, which would step the mirror), and its race standing
 * (AI IN, `session.playerAiIn`). Its memory lives in a private one-boat-block layout, exactly as a rival's lives in
 * the sim buffer.
 *
 * WAKES (§T.213 follow-up): the pilot's wake reads (the wave read's surface, the lane/gap behind a boat ahead, the helm
 * brace) are gated on `L.spec.wakeField` and read WAKE WORLD out of the layout. This private layout carried none, so
 * `?autopilot` raced the same policy with an empty wake field while every rival read one. `wakeSources` now hands in the
 * SAME per-tick rival records the player's own hull already floats on (`PlayerBoat.setWakeSources`, race session
 * `rivalWake`) and they are copied into a WAKE WORLD region of this layout, fleet index order. The player's own slot
 * stays zero — `WakeField.prepare` excludes the reader anyway (§V108) — so she reads exactly what a rival in her
 * position would.
 */
import { AI_BLOCK_LEN, AI_IN_LEN, AI_OUT_LEN, B, BoatSimLayout, POSE_LEN, layoutByteLength, type LayoutSpec } from '../../sim-worker/layout';
import { WAKE_SRC_LEN } from '../../wake/wakeField';
import type { Archetype, ArchetypeId } from '../../race/ai/archetypes';
import { ARCHETYPES } from '../../race/ai/archetypes';
import { RacePilot, type PilotOutput, type PilotSetup, type SeaHeight } from '../../race/ai/pilot';
import type { Rigid6State } from '../../sea-physics/rigidBody';
import type { BoatControls, ControlSource } from './seams';

export interface AutopilotDeps {
  /** the rivals' setup (lines + profiles are shared; only `boats` differs) */
  setup: PilotSetup;
  /** the player's fleet index (the external slot) and the fleet's boat count */
  index: number;
  boats: number;
  archetype?: ArchetypeId | Archetype;
  /** drives' lock, rad (the seam's steer is normalised by it) */
  lockRad: number;
  sea: SeaHeight;
  /** SimState.time of this tick (the mirror's time after tickSea) */
  time(): number;
  /** tick-start WORLD snapshot, fleet index order, stride 13 */
  world(): Float64Array;
  /** the player's AI IN (AI_IN_LEN) */
  standing(): Float64Array;
  /** last tick's prop immersion (HullWater.propImmersion): the pilot feathers dry props, as a rival reads B.PROP_IMMERSION */
  propImmersion(): number;
  /**
   * §T.213 follow-up: the OTHER boats' wake records for this tick, fleet index order from index 0 (the race session's
   * `rivalWake`, `count` = the rivals). Absent ⇒ no WAKE WORLD and the pilot is wake-blind, as before. `count` must not
   * reach the player's own fleet index (she is the last slot: raceSession enforces `playerIndex === nNpc`).
   */
  wakeSources?(): { rec: ArrayLike<number>; count: number } | null;
}

export function createAutopilotControls(d: AutopilotDeps): ControlSource & { reset(): void; readAi(slot: number): number } {
  const arch = d.archetype ?? 'veteran';
  const boats = d.setup.boats.map((_b, i) => (i === d.index ? (typeof arch === 'string' ? { ...ARCHETYPES[arch] } : { ...arch }) : null));
  while (boats.length < d.boats) boats.push(boats.length === d.index ? (typeof arch === 'string' ? { ...ARCHETYPES[arch] } : { ...arch }) : null);
  const pilot = new RacePilot({ ...d.setup, boats });
  const wakeSources = d.wakeSources;
  const spec: LayoutSpec = { boats: d.boats, wakeCap: 0, oceanLen: 0, seaLen: 0, aiLen: AI_BLOCK_LEN, ...(wakeSources ? { wakeField: true } : {}) };
  const L = new BoatSimLayout(new ArrayBuffer(layoutByteLength(spec)), spec);
  const wakeWorld = wakeSources ? L.wakeWorldOffset(0) : 0;
  const po: PilotOutput = { steer: 0, throttle: 0 };
  const out: BoatControls = { steer: 0, throttle: 0, trim: 0, surge: false };
  let justReset = true;
  return {
    sample(_dt: number, boat: Readonly<Rigid6State>) {
      const w = d.world();
      L.f64.set(w.subarray(0, d.boats * POSE_LEN), L.worldOffset);
      if (wakeSources) {
        const src = wakeSources();
        const n = src ? Math.min(src.count, d.boats) : 0;
        if (n > d.index) throw new Error(`[speedboat] autopilot: ${n} wake records reach the player's own fleet slot ${d.index}`);
        L.f64.fill(0, wakeWorld, wakeWorld + d.boats * WAKE_SRC_LEN);
        if (src) for (let k = 0; k < n * WAKE_SRC_LEN; k++) L.f64[wakeWorld + k] = src.rec[k];
      }
      L.f64.set(d.standing().subarray(0, AI_IN_LEN), L.aiOffset(d.index) + AI_OUT_LEN);
      L.f64[L.boatOffset(d.index) + B.PROP_IMMERSION] = d.propImmersion();
      pilot.control(d.index, L, boat, d.sea, d.time(), justReset, po);
      justReset = false;
      out.steer = d.lockRad > 0 ? po.steer / d.lockRad : 0;
      out.throttle = po.throttle;
      out.trim = po.trim ?? 0;
      return out;
    },
    reset() {
      justReset = true;
    },
    /** the pilot's own AI OUT slot (`AI.*`), as `fleet.readAi(i, slot)` gives a rival's: HUD, debug and tests */
    readAi(slot: number): number {
      return L.f64[L.aiOffset(d.index) + slot];
    },
    dispose() {},
  };
}
