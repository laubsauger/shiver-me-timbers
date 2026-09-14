/**
 * Speedboat page PER-TICK and PER-FRAME plumbing (§T.181 S0) — the `raftFrame` split for this
 * page: `main-speedboat.ts` owns the loop and the order, this file owns the calls.
 *
 *   FIXED TICK   tickSea    spectrum + the §V8 mirror to this tick's time (BEFORE the physics)
 *                tickBoat   AFTER the player's rigid6 step: wake sources + prop jets from THAT
 *                           step's contact (§V101), the sim wake anchored on the player's SIM
 *                           pose (§V105), rooster tail, then the interpolation pair shifts
 *   RENDER       renderSea  everything that does not depend on this frame's camera
 *                renderBoats hero + rivals at the interpolated poses, the lens, then the
 *                           camera-derived passes (clouds, reflection, surface)
 *
 * §V95: the sea sequence (spectrum + mirror, wake track, sky → rain, spray, shore, flowfoam,
 * camera passes, surface) is `core/seaFrame.ts`, the same runs `raft/raftFrame.ts` calls; this
 * file adds only the speedboat's own calls between them.
 *
 * CONTACT VIEWS (§V101): `HullWaterStations` reads the player's contact patch after each step —
 * its burial rates feed the sim churn (`setHullBurial`, §T.70) and its per-station waterline
 * feeds the hull wetline, the same way the raft's `HullContact` feeds both.
 *
 * WAKE ANCHOR (§V105): `wakeSim.tick(player.state, …)` takes the SimState ship — the pose rigid6
 * just wrote — never the camera and never the interpolated render view.
 */
import { Quaternion, Vector3 } from 'three/webgpu';
import type { App } from '../../core/app';
import { createSeaFrame } from '../../core/seaFrame';
import { HullWaterStations } from '../../sea-physics/hullWater';
import { unitTrimToRad } from '../../sim-worker/stepCore';
import type { Rigid6State } from '../../sea-physics/rigidBody';
import type { SkyHandle } from '../../sky';
import type { ShipState, SimState } from '../../state/simState';
import type { PropWashInput } from '../../wake/propWash';
import type { RivalEffects } from '../../wake/vesselFx';
import type { HydroSample } from '../../wake/wakeSolverMath';
import type { WeatherSample } from '../../weather';
import { roosterApex, roosterTailEmission } from '../../foam/roosterTail';
import { sprayParams } from '../../params/spray';
import type { NpcFleet } from './npcFleet';
import type { PlayerBoat } from './playerBoat';
import type { SpeedboatBoats, SpeedboatSea } from './speedboatScene';

/**
 * T192's drive-state hook on a boat instance (`boatModel.setDriveState`): outboards yaw with the helm, props spin.
 * Feature-detected — until the asset runtime ships it, nothing is called.
 */
export interface DriveState {
  steerRad: number;
  trimRad: number;
  propRpm: number[];
}
type DriveStateTarget = { setDriveState?: (s: DriveState, dt: number) => void };

/** what `renderBoats` may drive per frame (all optional; the frame is unchanged without it) */
export interface RenderBoatsDrive {
  /** the player's seam steer −1..1 and throttle this tick */
  heroSteer: number;
  heroThrottle: number;
  /** the player's seam trim −1..1 (drawn at the angle the physics used) */
  heroTrim?: number;
  /** per drive rpm (engine model or proxy); absent ⇒ `placeholderPropRpm(throttle)` */
  heroPropRpm?: ArrayLike<number>;
  /** NPC i's applied normalised steer −1..1 and throttle */
  npcSteer?(i: number): number;
  npcThrottle?(i: number): number;
}

/** PLACEHOLDER until §T.189's engine model: idle 700 rpm → 6200 at full throttle, linear. Spin only, not physics. */
export const PLACEHOLDER_IDLE_RPM = 700;
export const PLACEHOLDER_RATED_RPM = 6200;
export function placeholderPropRpm(throttle: number, drives: number, out: number[] = []): number[] {
  const t = Number.isFinite(throttle) ? Math.min(1, Math.max(0, Math.abs(throttle))) : 0;
  out.length = drives;
  for (let k = 0; k < drives; k++) out[k] = PLACEHOLDER_IDLE_RPM + (PLACEHOLDER_RATED_RPM - PLACEHOLDER_IDLE_RPM) * t;
  return out;
}

/** the prop jets' spray numbers (pure: the same `roosterTailEmission` the GPU emitter budgets from) */
export interface JetStats {
  jets: number;
  thrustN: number;
  /** mean prop immersion 0..1 and the largest blade-arc exposure 4·imm·(1 − imm) */
  meanImmersion: number;
  maxExposure: number;
  /** particles/s the rooster tail would emit, and the tallest arc (m) */
  roosterRate: number;
  roosterApexM: number;
}

export function jetStats(jets: readonly PropWashInput[]): JetStats {
  let thrust = 0;
  let imm = 0;
  let exposure = 0;
  let rate = 0;
  let launch = 0;
  for (const j of jets) {
    const e = roosterTailEmission(j, sprayParams);
    thrust += Number.isFinite(j.thrust) ? j.thrust : 0;
    imm += Number.isFinite(j.immersion) ? j.immersion : 0;
    exposure = Math.max(exposure, e.exposure);
    rate += e.rate;
    if (e.rate > 0) launch = Math.max(launch, e.launch);
  }
  return { jets: jets.length, thrustN: thrust, meanImmersion: jets.length ? imm / jets.length : 0, maxExposure: exposure, roosterRate: rate, roosterApexM: roosterApex(launch) };
}

export interface SpeedboatFrameDeps {
  app: App;
  sea: SpeedboatSea;
  boats: SpeedboatBoats;
  sky: SkyHandle;
  state: SimState;
  player: PlayerBoat;
  npcs: NpcFleet;
  weatherHere: WeatherSample;
  waterAt(x: number, z: number): number;
  /** the camera rig writes the lens between the boats and the camera-derived passes */
  placeCamera(view: ShipState, frameDt: number): void;
  /**
   * the trailer's scripted rivals (speedboat/cine/rivals.ts, `?cine` in free roam): they, not the idle fleet, pose
   * `boats.npcs` and feed vesselFx's rival wakes and spray
   */
  rivals?: { renderPose(i: number, alpha: number, out: Rigid6State): Rigid6State; readonly fx: RivalEffects };
}

export function createSpeedboatFrame(d: SpeedboatFrameDeps) {
  const { app, sea, boats, sky, state, player } = d;
  const boat = player.state;
  const hull = player.hull;
  const prevPos = new Vector3();
  const currPos = new Vector3();
  const prevQuat = new Quaternion();
  const currQuat = new Quaternion();
  const prevVel = new Vector3();
  const currVel = new Vector3();
  const tmpDir = new Vector3();
  const view: ShipState = structuredClone(boat);
  const npcView: Rigid6State = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] };
  const wakeSamples: HydroSample[] = [];
  const jets: PropWashInput[] = [];
  const seaFrame = createSeaFrame({ app, sea, sky, state, weatherHere: d.weatherHere, waterAt: d.waterAt });
  // §V101: burial rates + per-station waterline, off the contact patch the player's step just used
  const stations = new HullWaterStations(hull);
  let ticked = false;
  /** particles/s the GPU rooster tail budgeted on the last tick (its own return value) */
  let roosterRate = 0;
  let wakeSampleCount = 0;
  let wakeLoadN = 0;
  const heroRpm: number[] = [];
  const npcDrive: DriveState = { steerRad: 0, trimRad: 0, propRpm: [] };
  const heroDrive: DriveState = { steerRad: 0, trimRad: 0, propRpm: [] };

  const snap = (): void => {
    // V108: a teleport is not a burial — the next tick reports zero rate
    stations.reset();
    boats.vesselFx.resetContact();
    currPos.fromArray(boat.position);
    currQuat.fromArray(boat.quaternion);
    currVel.fromArray(boat.velocity);
    prevPos.copy(currPos);
    prevQuat.copy(currQuat);
    prevVel.copy(currVel);
  };
  snap();

  return {
    /** the interpolated player view the camera, HUD and audio read (object stable, contents not) */
    view,
    /** this tick's prop jets (after tickBoat) */
    jets,
    snap,
    /** FIXED TICK, before the player's physics: the sea this tick's forces read */
    tickSea(): void {
      seaFrame.tickSpectrum();
    },
    /** FIXED TICK, after the player's physics: wake, jets, spray, interpolation pair */
    tickBoat(dt: number): void {
      player.wakeSamples(wakeSamples);
      player.jets(jets);
      stations.update(player.hw, boat, dt);
      const ff = sea.flowFoam;
      seaFrame.trackWake(boat, hull.stemZ, hull.transomZ, hull.beam, dt);
      ticked = true;
      // §T.70 / §T.180 e: her chine stations' burial rates feed the sim churn; the sea's band slope the breaking increment
      ff.setHullBurial(stations);
      ff.setAmbientSea(sea.ocean.cascades);
      // §T.195 every boat marks the water: prop wash for all jets, ONE wake source buffer (the player's samples of this
      // step + each rival's last collected step), bow sheet / rooster tail / bubbles. §V105: anchored on the SIM pose
      // rigid6 just wrote. `bowAhead` = stem + 120 m: ~130 m of clear water ahead, so rivals in front keep their wakes
      // (coordinator decision, w6-multivessel.md §1). The camera is only the spray pools' priority viewer (visual-only).
      roosterRate = boats.vesselFx.tick(app.renderer, { hw: player.hw, state: boat, bowAhead: hull.stemZ + 120 }, d.rivals ? d.rivals.fx : d.npcs.fleet, dt, app.camera.position).rooster;
      wakeSampleCount = wakeSamples.length;
      wakeLoadN = 0;
      for (const w of wakeSamples) wakeLoadN += w.fy;
      prevPos.copy(currPos);
      prevQuat.copy(currQuat);
      prevVel.copy(currVel);
      currPos.fromArray(boat.position);
      currQuat.fromArray(boat.quaternion);
      currVel.fromArray(boat.velocity);
    },
    /** RENDER, part one: everything that does not depend on this frame's camera */
    renderSea(frameDt: number, paused: boolean): void {
      seaFrame.renderSeaBase(boat, frameDt, paused);
      // §V101: the ship-local height the sea reached at each chine station, from the same contact patch
      boats.wetline.updateFromHullContact(frameDt, stations.stations, stations.waterlineY);
      seaFrame.renderSpray(boat);
      seaFrame.renderShore();
      // a frame can land before the first tick (the loop runs 0 ticks on a short first frame): the
      // wake track is sim state, advanced only by tickBoat, and flowFoam.update reports an unadvanced one
      if (ticked) seaFrame.renderFlowFoam(frameDt);
    },
    /** RENDER, part two: boats at the interpolated poses, the lens, the camera-derived passes */
    renderBoats(alpha: number, frameDt: number, drive?: Readonly<RenderBoatsDrive>): { headingRad: number; knots: number } {
      const g = boats.hero.object;
      g.position.lerpVectors(prevPos, currPos, alpha);
      g.quaternion.slerpQuaternions(prevQuat, currQuat, alpha);
      g.position.toArray(view.position);
      g.quaternion.toArray(view.quaternion);
      view.velocity[0] = prevVel.x + (currVel.x - prevVel.x) * alpha;
      view.velocity[1] = prevVel.y + (currVel.y - prevVel.y) * alpha;
      view.velocity[2] = prevVel.z + (currVel.z - prevVel.z) * alpha;
      for (let i = 0; i < boats.npcs.length; i++) {
        if (d.rivals) d.rivals.renderPose(i, alpha, npcView);
        else d.npcs.renderPose(i, alpha, npcView);
        const o = boats.npcs[i].object;
        o.position.fromArray(npcView.position);
        o.quaternion.fromArray(npcView.quaternion);
        const t = boats.npcs[i] as unknown as DriveStateTarget;
        if (drive && t.setDriveState) {
          const lock = hull.drives[0]?.maxSteerRad ?? 0;
          const thr = drive.npcThrottle ? drive.npcThrottle(i) : 0;
          npcDrive.steerRad = (drive.npcSteer ? drive.npcSteer(i) : 0) * lock;
          placeholderPropRpm(thr, hull.drives.length, npcDrive.propRpm);
          t.setDriveState(npcDrive, frameDt);
        }
      }
      const ht = boats.hero as unknown as DriveStateTarget;
      if (drive && ht.setDriveState) {
        heroDrive.steerRad = Math.max(-1, Math.min(1, drive.heroSteer)) * (hull.drives[0]?.maxSteerRad ?? 0);
        heroDrive.trimRad = unitTrimToRad(drive.heroTrim ?? 0); // §T.189: the drive trim the physics ran
        if (drive.heroPropRpm) heroDrive.propRpm = Array.from(drive.heroPropRpm);
        else heroDrive.propRpm = placeholderPropRpm(drive.heroThrottle, hull.drives.length, heroRpm);
        ht.setDriveState(heroDrive, frameDt);
      }
      boats.lights.update(sky.nightFactor, sky.sunDirection); // §T.209 LEDs at this frame's poses, before any pass draws
      d.placeCamera(view, frameDt);
      seaFrame.renderCameraPasses();
      seaFrame.renderSurface();
      const fwd = g.getWorldDirection(tmpDir);
      return { headingRad: Math.atan2(fwd.x, fwd.z), knots: Math.hypot(boat.velocity[0], boat.velocity[2]) * 1.944 };
    },
    /**
     * Browser diagnosis numbers (§T.191): the player's prop jets and the rooster tail they feed, the wake load and
     * the sim wake. The sim wake's elevation lives on the GPU only (flowFoam.wakeHeightCpu reads 0 on the sim
     * backend), so no wake peak is reported here — that needs a solver readback (§T.170 owner).
     */
    debugStats() {
      const ff = sea.flowFoam;
      const solver = ff.wakeSim?.solver;
      return {
        ...jetStats(jets),
        roosterBudgetRate: roosterRate,
        roosterVisible: roosterRate > 0,
        wakeSampleCount,
        wakeLoadN,
        wakeBackend: ff.wakeBackend,
        wakeSim: !!ff.wakeSim,
        wakeTier: solver ? { n: solver.n, texel: solver.texel, domain: solver.domain, centerX: solver.centerX, centerZ: solver.centerZ } : null,
      };
    },
  };
}
export type SpeedboatFrame = ReturnType<typeof createSpeedboatFrame>;
