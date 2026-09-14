/**
 * CINE RIVALS (docs/cine/speedboat-trailer-v1.md §Rivals): the trailer's other boats — a duel, an overtake through a wake,
 * the night pack — in free roam, where the page has no race and no NPC fleet.
 *
 * DRIVEN, NOT ANIMATED, ON THE HERO'S PHYSICS (§V110). Each rival is a `createPlayerBoat` — the very step the hero runs
 * (rigid6 + HullWater on the deep-V, the page's pressure head) — driven by its own `PathFollower` (drive.ts) on its own
 * `DriveSpec`, in the page's FIXED TICK, on the driver's own tick clock. No race AI and no worker: the race pilot is not
 * a scripted line, and the fleet worker is the race's. Deterministic like the hero: the same shot re-rendered lands on
 * the same water.
 *
 * WHAT THEY SHARE WITH THE HERO, per tick (`tick`, called BEFORE the race session steps the hero):
 *   wakes     every hull reads every OTHER boat's T207 wake record of the tick start (the hero's included); the hero
 *             reads the rivals' through `setWakeSources` (free roam never sets them otherwise)
 *   contact   boat↔boat pairs through `collideBoatWithFleet` on a tick-start snapshot of hero + rivals, both shares
 *             applied (the hero's through a cine-only memory, so her crash machine does not see these hits), and each
 *             rival against the statics and the bed with `collideBoatWithWorld` — the calls the step core makes
 *   crash     each rival runs the page's crash machine (detect.ts thresholds); a rival that crashes is NOT respawned, it
 *             is logged loudly (`[cine] rival 2 CRASHED …`) and counted: that take is not the scripted one
 *   render    the page's NPC boat instances (built hidden for `?cine` in free roam), interpolated like the hero; the
 *             LED rig (page/boatLights.ts) already carries them, colour from each livery; wake/foam/spray go to
 *             vesselFx as `RivalEffects` (the page's rival FX input)
 *
 * Not stepped, not drawn and not read by the hero when no armed shot names rivals.
 */
import type { Vector3 } from 'three';
import { SIM_DT } from '../../core/loop';
import {
  beginContactTick,
  buildCollisionHull,
  collideBoatWithFleet,
  collideBoatWithWorld,
  createBoatCollideMemory,
  POSE_STRIDE,
  prepareStaticWorld,
  resetBoatCollideMemory,
  writePose,
  type BedHeight,
  type StaticCollider,
} from '../../sea-physics/boatCollide';
import type { Rigid6State } from '../../sea-physics/rigidBody';
import { createBoatEffects, type BoatEffects } from '../../sim-worker/fleet';
import { FX_LEN, readBoatFx, writeBoatFx } from '../../sim-worker/fx';
import type { ShipState } from '../../state/simState';
import { hullWaterSamples } from '../../wake/stationSources';
import { WAKE_SRC_LEN } from '../../wake/wakeField';
import type { BoatLivery } from '../assets/livery';
import { createCrashMachine, createCrashSensors, damageGeometryFor, measureCrashSensors, restCgHeight, stepCrashMachine, type CrashEvent } from '../crash';
import type { HullProxy } from '../hullMesh';
import { createPlayerBoat, type PlayerBoat } from '../page/playerBoat';
import { drivePose, PathFollower, type DriveSpec } from './drive';

/** most rivals one shot can name: the LED pool holds 8 boats (ocean/boatLightPool.ts), the page builds this many */
export const CINE_RIVAL_MAX = 5;

/** one rival of a shot */
export interface RivalSpec {
  /** its own line, placement and speeds — the hero's DriveSpec, on the rival's path (a parallel offset line for a duel) */
  drive: DriveSpec;
  /** its paint + number + LED colour (page/liveries.ts `liveryFor`); omitted = the page's NPC livery for that slot */
  livery?: BoatLivery;
  /** for the logs */
  name?: string;
}

/** the page objects a rival is drawn with (a BoatInstance's subset) */
export interface RivalInstance {
  readonly object: { visible: boolean; position: Vector3; quaternion: { fromArray(a: ArrayLike<number>): unknown; slerpQuaternions?: unknown } };
  setLivery(l: BoatLivery | number | null): void;
}

export interface CineRivalsDeps {
  hull: HullProxy;
  /** the hero's physics (the other half of every wake and contact) */
  hero: PlayerBoat;
  /** the page's §V68 pressure head at sim time t (the hero's own sea) */
  pressureHeadAt(x: number, z: number, t: number): number;
  /** the water a placement stands on (the hero's `drivePose` height function) */
  waterAt(x: number, z: number): number;
  colliders?: readonly StaticCollider[];
  bed?: BedHeight | null;
  /** up to CINE_RIVAL_MAX page boat instances (absent headless) */
  instances?: readonly RivalInstance[];
}

const newShip = (i: number): ShipState => ({
  id: `cine-rival-${i}`,
  kind: 'enemy',
  position: [0, 0, 0],
  quaternion: [0, 0, 0, 1],
  velocity: [0, 0, 0],
  angularVelocity: [0, 0, 0],
  rudder: 0,
  sailTrim: 0,
  anchored: false,
  flood: 0,
  damage: {},
});

export function createCineRivals(d: CineRivalsDeps) {
  const cHull = buildCollisionHull(d.hull);
  const statics = d.colliders && d.colliders.length > 0 ? prepareStaticWorld(d.colliders) : null;
  const dmg = damageGeometryFor(cHull);
  const cgAbove = restCgHeight(d.hull);
  const heroMem = createBoatCollideMemory(cHull);

  const rivals = Array.from({ length: CINE_RIVAL_MAX }, (_, i) => {
    const state = newShip(i);
    return {
      state,
      boat: createPlayerBoat({ hull: d.hull, pressureHeadAt: d.pressureHeadAt }, state),
      follower: null as PathFollower | null,
      spec: null as RivalSpec | null,
      mem: createBoatCollideMemory(cHull),
      machine: createCrashMachine(),
      sensors: createCrashSensors(),
      crashed: false,
      /** the pose pair the render interpolates (tick ends) */
      prev: new Float64Array(7),
      curr: new Float64Array(7),
      effects: createBoatEffects(),
      fxRecord: new Float64Array(FX_LEN),
      /** the other boats' wake records this rival reads (hero + the other rivals) */
      wakeIn: new Float64Array(CINE_RIVAL_MAX * WAKE_SRC_LEN),
      steer: 0,
      throttle: 0,
    };
  });
  let active = 0;
  let t = 0;
  let time = 0;
  let crashes = 0;
  let tickNo = 0;
  const snapshot = new Float64Array((CINE_RIVAL_MAX + 1) * POSE_STRIDE);
  /** tick-start wake records: [hero, rival 0 … rival n−1] */
  const wakeStart = new Float64Array((CINE_RIVAL_MAX + 1) * WAKE_SRC_LEN);
  /** what the hero reads: the rivals' tick-start records */
  const heroWakeIn = new Float64Array(CINE_RIVAL_MAX * WAKE_SRC_LEN);
  const events: CrashEvent[] = [];
  const zero: [number, number, number] = [0, 0, 0];

  const storePose = (s: Readonly<Rigid6State>, out: Float64Array): void => {
    for (let c = 0; c < 3; c++) out[c] = s.position[c];
    for (let c = 0; c < 4; c++) out[3 + c] = s.quaternion[c];
  };
  const hide = (): void => {
    for (const inst of d.instances ?? []) inst.object.visible = false;
  };
  hide();

  const api = {
    /**
     * Place a shot's rivals (null = none) at shot time `t0` — call it at the hero's placement, the same tick. Engines
     * idle, crash machines fresh, every contact and wake memory forgotten (§V108).
     */
    arm(specs: readonly RivalSpec[] | null | undefined, t0: number): void {
      const list = (specs ?? []).slice(0, CINE_RIVAL_MAX);
      if ((specs?.length ?? 0) > CINE_RIVAL_MAX) console.warn(`[cine] a shot names ${specs?.length} rivals; the page has ${CINE_RIVAL_MAX}`);
      active = list.length;
      t = t0;
      crashes = 0;
      tickNo = 0;
      for (let i = 0; i < CINE_RIVAL_MAX; i++) {
        const r = rivals[i];
        const spec = list[i] ?? null;
        r.spec = spec;
        r.follower = spec ? new PathFollower(spec.drive) : null;
        r.crashed = false;
        r.steer = 0;
        r.throttle = 0;
        r.effects.tick = -1;
        if (spec === null) continue;
        r.boat.place(drivePose(spec.drive, d.waterAt));
        r.boat.hw.resetEngines();
        r.machine = createCrashMachine();
        resetBoatCollideMemory(r.mem);
        storePose(r.state, r.prev);
        storePose(r.state, r.curr);
        const inst = d.instances?.[i];
        if (inst && spec.livery) inst.setLivery(spec.livery);
      }
      resetBoatCollideMemory(heroMem);
      d.hero.setWakeSources(heroWakeIn, 0);
      if (d.instances) for (let i = 0; i < d.instances.length; i++) d.instances[i].object.visible = i < active;
    },

    /**
     * FIXED TICK, after the tick's time advanced and the shot's world/placement were applied, BEFORE the race session
     * collides and steps the hero. `simTime` = SimState.time after this tick's increment (what the hero's step reads).
     */
    tick(simTime: number, dt = SIM_DT): void {
      if (active === 0) return;
      time = simTime;
      const hero = d.hero;
      // tick-start snapshot: poses for the contacts, wake records for every hull
      writePose(snapshot, 0, 0, hero.state);
      wakeStart.set(hero.wakeRecord, 0);
      for (let i = 0; i < active; i++) {
        writePose(snapshot, 0, i + 1, rivals[i].state);
        wakeStart.set(rivals[i].boat.wakeRecord, (i + 1) * WAKE_SRC_LEN);
      }
      // boat ↔ boat: the hero's share (cine memory), then each rival's (its own index i + 1), and each rival ↔ world
      beginContactTick(heroMem);
      collideBoatWithFleet(0, hero.state, cHull, snapshot, 0, active + 1, 0, dt, heroMem);
      heroWakeIn.set(wakeStart.subarray(WAKE_SRC_LEN, (active + 1) * WAKE_SRC_LEN), 0);
      hero.setWakeSources(heroWakeIn, active);
      for (let i = 0; i < active; i++) {
        const r = rivals[i];
        beginContactTick(r.mem);
        collideBoatWithFleet(i + 1, r.state, cHull, snapshot, 0, active + 1, 0, dt, r.mem);
        collideBoatWithWorld(r.state, cHull, statics, d.bed ?? null, dt, r.mem);
        // the others' wakes: every tick-start record but its own
        let n = 0;
        for (let j = 0; j <= active; j++) {
          if (j === i + 1) continue;
          r.wakeIn.set(wakeStart.subarray(j * WAKE_SRC_LEN, (j + 1) * WAKE_SRC_LEN), n * WAKE_SRC_LEN);
          n++;
        }
        r.boat.setWakeSources(r.wakeIn, n);
        const c = (r.follower as PathFollower).step(t, dt, r.state);
        r.steer = c.steer;
        r.throttle = c.throttle;
        r.boat.tick(c, time, dt);
        // the page's crash machine, contact included; a crash is logged, never respawned
        const rep = r.mem.report;
        measureCrashSensors(
          r.state,
          { bowDeck: cHull.bowDeck, wettedArea: r.boat.hw.wettedArea, waterHeightAt: (x, z) => r.boat.hw.patch.heightAt(x, z), contactDeltaV: rep.maxDeltaV, contactSource: rep.source },
          r.sensors,
        );
        events.length = 0;
        stepCrashMachine(
          r.machine,
          { dt, state: r.state, sensors: r.sensors, contactPoint: zero, contactOther: rep.other, overlapsBoat: rep.overlapsBoat, autoReset: false, resetRequested: false },
          {
            respawn: () => ({ x: r.state.position[0], z: r.state.position[2], heading: 0, speed: 0 }),
            teleport: () => undefined,
            waterHeightAt: (x, z) => d.waterAt(x, z),
            cgAboveWater: cgAbove,
            damageGeometry: dmg,
          },
          events,
        );
        if (!r.crashed && r.machine.phase === 'crashed') {
          r.crashed = true;
          crashes++;
          const p = r.state.position;
          console.warn(
            `[cine] rival ${i}${r.spec?.name ? ` (${r.spec.name})` : ''} CRASHED (${r.machine.kind} at ${p[0].toFixed(0)}, ${p[2].toFixed(0)}, ` +
              `${r.sensors.groundSpeed.toFixed(1)} m/s, heel ${r.sensors.heelDeg.toFixed(0)}°) at shot time ${t.toFixed(2)} s — this take is not the scripted one`,
          );
        }
        // render pair + the FX the page's vesselFx reads for rivals
        r.prev.set(r.curr);
        storePose(r.state, r.curr);
        writeBoatFx(r.boat.hw, r.state, r.fxRecord, 0);
        readBoatFx(r.fxRecord, 0, r.effects.fx);
        hullWaterSamples(r.boat.hw.wake, r.effects.wake);
        const e = r.effects.pose;
        for (let c = 0; c < 3; c++) {
          e.position[c] = r.state.position[c];
          e.velocity[c] = r.state.velocity[c];
          e.angularVelocity[c] = r.state.angularVelocity[c];
        }
        for (let c = 0; c < 4; c++) e.quaternion[c] = r.state.quaternion[c];
        r.effects.tick = tickNo;
      }
      tickNo++;
      t += dt;
    },

    /** rivals of the armed shot */
    get active(): number {
      return active;
    },
    /** crashes logged since the last `arm` */
    get crashes(): number {
      return crashes;
    },
    /** rival i's live physics state (sim side) */
    state(i: number): Readonly<Rigid6State> {
      return rivals[i].state;
    },
    steer: (i: number): number => rivals[i]?.steer ?? 0,
    throttle: (i: number): number => rivals[i]?.throttle ?? 0,
    /** RENDER: rival i's pose between the last two tick ends */
    renderPose(i: number, alpha: number, out: Rigid6State): Rigid6State {
      const r = rivals[i];
      const a = Math.min(1, Math.max(0, Number.isFinite(alpha) ? alpha : 1));
      for (let c = 0; c < 3; c++) out.position[c] = r.prev[c] + (r.curr[c] - r.prev[c]) * a;
      // nlerp is enough between two ticks 1/60 s apart
      let dot = 0;
      for (let c = 0; c < 4; c++) dot += r.prev[3 + c] * r.curr[3 + c];
      const s = dot < 0 ? -1 : 1;
      let len = 0;
      for (let c = 0; c < 4; c++) {
        out.quaternion[c] = r.prev[3 + c] * s + (r.curr[3 + c] - r.prev[3 + c] * s) * a;
        len += out.quaternion[c] ** 2;
      }
      len = Math.sqrt(len) || 1;
      for (let c = 0; c < 4; c++) out.quaternion[c] /= len;
      return out;
    },
    /** the page's vesselFx rival input (wake, foam, spray): the armed rivals' effects of their last step */
    fx: {
      spec: {
        get boats(): number {
          return active;
        },
      },
      effects: (i: number): Readonly<BoatEffects> => rivals[i].effects,
    },
    /** hand the boat back: nothing stepped, drawn or read */
    disarm(): void {
      api.arm(null, 0);
    },
  };
  return api;
}
export type CineRivals = ReturnType<typeof createCineRivals>;
