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
import type { Rigid6State } from '../../sea-physics/rigidBody';
import type { SkyHandle } from '../../sky';
import type { ShipState, SimState } from '../../state/simState';
import type { PropWashInput } from '../../wake/propWash';
import type { HydroSample } from '../../wake/wakeSolverMath';
import type { WeatherSample } from '../../weather';
import type { NpcFleet } from './npcFleet';
import type { PlayerBoat } from './playerBoat';
import type { SpeedboatBoats, SpeedboatSea } from './speedboatScene';

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

  const snap = (): void => {
    // V108: a teleport is not a burial — the next tick reports zero rate
    stations.reset();
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
      ff.setPropWash(jets);
      // §V105: anchored on the SIM pose rigid6 just wrote; §V101: the samples of that same step
      ff.wakeSim?.tick(boat, wakeSamples, hull.stemZ, dt, jets);
      if (boats.roosterTail.mesh.visible) boats.roosterTail.update(app.renderer, jets);
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
    renderBoats(alpha: number, frameDt: number): { headingRad: number; knots: number } {
      const g = boats.hero.object;
      g.position.lerpVectors(prevPos, currPos, alpha);
      g.quaternion.slerpQuaternions(prevQuat, currQuat, alpha);
      g.position.toArray(view.position);
      g.quaternion.toArray(view.quaternion);
      view.velocity[0] = prevVel.x + (currVel.x - prevVel.x) * alpha;
      view.velocity[1] = prevVel.y + (currVel.y - prevVel.y) * alpha;
      view.velocity[2] = prevVel.z + (currVel.z - prevVel.z) * alpha;
      for (let i = 0; i < boats.npcs.length; i++) {
        d.npcs.renderPose(i, alpha, npcView);
        const o = boats.npcs[i].object;
        o.position.fromArray(npcView.position);
        o.quaternion.fromArray(npcView.quaternion);
      }
      d.placeCamera(view, frameDt);
      seaFrame.renderCameraPasses();
      seaFrame.renderSurface();
      const fwd = g.getWorldDirection(tmpDir);
      return { headingRad: Math.atan2(fwd.x, fwd.z), knots: Math.hypot(boat.velocity[0], boat.velocity[2]) * 1.944 };
    },
  };
}
export type SpeedboatFrame = ReturnType<typeof createSpeedboatFrame>;
