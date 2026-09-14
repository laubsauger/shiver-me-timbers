/**
 * AUTOPILOT CONTROL SOURCE (§T.191): the player's boat driven by the SAME §T.186 `RacePilot` a rival runs, behind the
 * `ControlSource` seam. For the headless smoke race (tests/speedboatRaceSmoke.test.ts) and `?autopilot` on the page.
 *
 * Same inputs a rival's pilot reads in `BoatSimCore.step`: its own tick pose, a WORLD snapshot of every boat (the race
 * session's tick-start snapshot, fleet index order), the sea at the tick time (the page mirror, already advanced to
 * this tick by `frame.tickSea` — never a future-time read, which would step the mirror), and its race standing
 * (AI IN, `session.playerAiIn`). Its memory lives in a private one-boat-block layout, exactly as a rival's lives in
 * the sim buffer.
 */
import { AI_BLOCK_LEN, AI_IN_LEN, AI_OUT_LEN, B, BoatSimLayout, POSE_LEN, layoutByteLength, type LayoutSpec } from '../../sim-worker/layout';
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
}

export function createAutopilotControls(d: AutopilotDeps): ControlSource & { reset(): void } {
  const arch = d.archetype ?? 'veteran';
  const boats = d.setup.boats.map((_b, i) => (i === d.index ? (typeof arch === 'string' ? { ...ARCHETYPES[arch] } : { ...arch }) : null));
  while (boats.length < d.boats) boats.push(boats.length === d.index ? (typeof arch === 'string' ? { ...ARCHETYPES[arch] } : { ...arch }) : null);
  const pilot = new RacePilot({ ...d.setup, boats });
  const spec: LayoutSpec = { boats: d.boats, wakeCap: 0, oceanLen: 0, seaLen: 0, aiLen: AI_BLOCK_LEN };
  const L = new BoatSimLayout(new ArrayBuffer(layoutByteLength(spec)), spec);
  const po: PilotOutput = { steer: 0, throttle: 0 };
  const out: BoatControls = { steer: 0, throttle: 0, trim: 0, surge: false };
  let justReset = true;
  return {
    sample(_dt: number, boat: Readonly<Rigid6State>) {
      const w = d.world();
      L.f64.set(w.subarray(0, d.boats * POSE_LEN), L.worldOffset);
      L.f64.set(d.standing().subarray(0, AI_IN_LEN), L.aiOffset(d.index) + AI_OUT_LEN);
      L.f64[L.boatOffset(d.index) + B.PROP_IMMERSION] = d.propImmersion();
      pilot.control(d.index, L, boat, d.sea, d.time(), justReset, po);
      justReset = false;
      out.steer = d.lockRad > 0 ? po.steer / d.lockRad : 0;
      out.throttle = po.throttle;
      return out;
    },
    reset() {
      justReset = true;
    },
    dispose() {},
  };
}
