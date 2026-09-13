/**
 * THE NPC FLEET ON THE PAGE LOOP (§T.181 S0, §T.178, §V110): 7 rivals stepped by
 * `src/sim-worker` on whichever transport `createNpcFleet` selects (SAB → transferable worker →
 * main thread), at the SAME fidelity as the player, without touching `core/loop.ts`.
 *
 * PIPELINED KICK / COLLECT (docs/speedboat/sim-worker.md "Tick handshake"). The browser main
 * thread may never block on the worker, so `pump()` is called at two points the loop already
 * has — at the end of every fixed tick and at the end of every rendered frame — and each call:
 *   1. if a kick is out and the steppers are done: COLLECT (shift prev ← curr, read OUT poses);
 *   2. if nothing is out and the fleet trails the page's tick: write the controls for the next
 *      NPC tick and KICK it.
 * At most one tick is in flight. The worker steps inside the render/encode window between the two
 * pump points. On a frame that runs several player ticks the fleet falls behind by the extra
 * ticks and catches up on later pumps (one NPC tick per round trip); `lagTicks` reports it.
 *
 * DETERMINISM (§V2): NPC tick k is kicked with `timeAt(k)` — the exact float64 SimState.time of
 * page tick k, kept in a ring — so a rival's trajectory is a function of its tick index, not of
 * when the round trip came home. RESIDUE, stated: the OCEAN/SEA PARAMS are the live objects at
 * kick time, so a param change (weather transition, panel drag) that lands while the fleet trails
 * reaches its lagging ticks up to `lagTicks` early. Storm cells are off on this page and the
 * preset is fixed at boot; a per-tick params snapshot is the fix if that ever matters.
 * If the lag outgrows the time ring (a long stall), the fleet DROPS the ticks it can no longer
 * time exactly, counts them in `droppedTicks` and warns once — never silently (§Rule 8).
 *
 * RENDER: `renderPose(i, alpha, out)` lerps/slerps between the last two COLLECTED poses, as the
 * doc prescribes; a trailing fleet is therefore drawn `lagTicks` behind the player.
 *
 * ERRORS: a stepper error rejects the kick's `done()` (SAB STATUS_ERROR, transfer 'error'
 * message); the fleet stops kicking and `error` holds it, logged once.
 */
import type { OceanParams } from '../../params/ocean';
import type { SeaPhysicsParams } from '../../params/seaPhysics';
import type { Rigid6State } from '../../sea-physics/rigidBody';
import type { BoatFleet } from '../../sim-worker/fleet';
import type { TransportCaps } from '../../sim-worker/select';
import { createNpcFleet, detectCaps } from '../../sim-worker/select';

/** ticks of page time the ring can replay to a trailing fleet (≈ 2 s at 60 Hz) */
export const NPC_TIME_RING = 128;

/** placeholder rival controls until §T.186: a straight line at a fixed throttle */
export interface NpcControlFn {
  (boat: number, tick: number, pose: Readonly<Rigid6State>): { throttle: number; steer: number };
}
export const STRAIGHT_LINE_THROTTLE = 0.6;
export const straightLine: NpcControlFn = () => ({ throttle: STRAIGHT_LINE_THROTTLE, steer: 0 });

export interface NpcFleetDeps {
  seed: number;
  boats: number;
  oceanParams: OceanParams;
  seaParams: SeaPhysicsParams;
  /** grid slot poses, NPC i → slot i + 1 */
  spawn(i: number): Rigid6State;
  controls?: NpcControlFn;
  /** capability override for tests; default `detectCaps()` */
  caps?: TransportCaps;
}

const pose = (): Rigid6State => ({ position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] });

export interface NpcFleet {
  readonly fleet: BoatFleet;
  readonly boats: number;
  /** last collected NPC tick (0 = the spawn, before the first collect) */
  readonly collectedTick: number;
  /** page ticks the fleet trails by */
  readonly lagTicks: number;
  readonly droppedTicks: number;
  readonly error: Error | null;
  /** FIXED TICK: record page tick `tick`'s time (call after SimState.time advanced) */
  recordTick(tick: number, time: number): void;
  /** end of a tick and end of a frame: collect if home, kick the next trailing tick */
  pump(tick: number): void;
  /** the last two collected poses, interpolated */
  renderPose(i: number, alpha: number, out: Rigid6State): Rigid6State;
  /** live collected pose (sim side, for AI/HUD) */
  pose(i: number): Readonly<Rigid6State>;
  dispose(): void;
}

/**
 * Build the fleet at boot, BEFORE page tick 1 and on the same tick as the page mirror (the
 * worker's spectrum scheduler countdown is history, sim-worker.md), wait for its steppers, place
 * every rival.
 */
export async function createNpcFleetDriver(d: NpcFleetDeps): Promise<NpcFleet> {
  const fleet = createNpcFleet({ seed: d.seed, boats: d.boats, oceanParams: d.oceanParams, seaParams: d.seaParams }, d.caps ?? detectCaps());
  await fleet.ready;
  const controls = d.controls ?? straightLine;
  const prev = Array.from({ length: d.boats }, pose);
  const curr = Array.from({ length: d.boats }, pose);
  for (let i = 0; i < d.boats; i++) {
    const p = d.spawn(i);
    fleet.place(i, p);
    // OUT is zero until the first collect: both render poses start at the spawn
    for (const dst of [prev[i], curr[i]]) {
      dst.position.splice(0, 3, ...p.position);
      dst.quaternion.splice(0, 4, ...p.quaternion);
      dst.velocity.splice(0, 3, ...p.velocity);
      dst.angularVelocity.splice(0, 3, ...p.angularVelocity);
    }
  }
  const times = new Float64Array(NPC_TIME_RING);
  const ticksAt = new Float64Array(NPC_TIME_RING).fill(-1);
  let pageTick = 0;
  /** NPC tick in flight, or −1 */
  let inFlight = -1;
  let collected = 0;
  let dropped = 0;
  let error: Error | null = null;
  let warnedDrop = false;

  const collect = (): void => {
    for (let i = 0; i < d.boats; i++) {
      const a = prev[i];
      prev[i] = curr[i];
      curr[i] = fleet.readPose(i, a);
    }
    collected = inFlight;
    inFlight = -1;
  };

  return {
    fleet,
    boats: d.boats,
    get collectedTick() {
      return collected;
    },
    get lagTicks() {
      return pageTick - collected;
    },
    get droppedTicks() {
      return dropped;
    },
    get error() {
      return error;
    },
    recordTick(tick, time) {
      pageTick = tick;
      times[tick % NPC_TIME_RING] = time;
      ticksAt[tick % NPC_TIME_RING] = tick;
    },
    pump(tick) {
      if (error) return;
      if (inFlight >= 0) {
        if (!fleet.poll()) return;
        collect();
      }
      let next = collected + 1;
      if (next > tick) return;
      if (ticksAt[next % NPC_TIME_RING] !== next) {
        // the ring no longer holds tick `next`'s exact time: skip to the oldest tick it still times
        const oldest = Math.max(next, tick - NPC_TIME_RING + 1);
        dropped += oldest - next;
        if (!warnedDrop) {
          warnedDrop = true;
          console.warn(`[speedboat] NPC fleet fell ${tick - collected} ticks behind; dropped ${oldest - next} it could no longer time exactly`);
        }
        next = oldest;
        collected = next - 1;
      }
      for (let i = 0; i < d.boats; i++) {
        const c = controls(i, next, curr[i]);
        fleet.setControls(i, c.throttle, c.steer);
      }
      fleet.kick(next, times[next % NPC_TIME_RING], d.oceanParams, d.seaParams);
      inFlight = next;
      fleet.done().catch((e: unknown) => {
        if (error) return;
        error = e instanceof Error ? e : new Error(String(e));
        console.error('[speedboat] NPC physics stopped:', error);
      });
    },
    renderPose(i, alpha, out) {
      const a = prev[i];
      const b = curr[i];
      for (let c = 0; c < 3; c++) out.position[c] = a.position[c] + (b.position[c] - a.position[c]) * alpha;
      for (let c = 0; c < 3; c++) out.velocity[c] = a.velocity[c] + (b.velocity[c] - a.velocity[c]) * alpha;
      // nlerp on the shorter arc: two ticks apart the angle is small, and this allocates nothing
      const qa = a.quaternion;
      const qb = b.quaternion;
      const s = qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3] < 0 ? -1 : 1;
      let n = 0;
      for (let c = 0; c < 4; c++) {
        out.quaternion[c] = qa[c] + (s * qb[c] - qa[c]) * alpha;
        n += out.quaternion[c] * out.quaternion[c];
      }
      n = Math.sqrt(n) || 1;
      for (let c = 0; c < 4; c++) out.quaternion[c] /= n;
      return out;
    },
    pose(i) {
      return curr[i];
    },
    dispose() {
      fleet.dispose();
    },
  };
}
