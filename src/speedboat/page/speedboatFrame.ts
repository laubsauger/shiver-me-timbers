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
 * §V95 NOTE: `renderSea` repeats the sea-update sequence `raft/raftFrame.renderSea` runs (minus
 * the raft's vessel calls). tech-research §8 S0 planned that shared sequence as
 * `core/seaFrame.ts renderSeaCommon`; it does not exist yet and neither `src/core` nor `src/raft`
 * is this task's to reshape, so the extraction is reported rather than done. Nothing here is a
 * second implementation of a system — every call is into the shared module.
 *
 * WAKE ANCHOR (§V105): `wakeSim.tick(player.state, …)` takes the SimState ship — the pose rigid6
 * just wrote — never the camera and never the interpolated render view.
 */
import { Color, Quaternion, Vector2, Vector3, type PerspectiveCamera } from 'three/webgpu';
import type { App } from '../../core/app';
import { rotateVec } from '../../core/quat';
import { oceanParams } from '../../ocean';
import { skyParams } from '../../params/sky';
import type { Rigid6State } from '../../sea-physics/rigidBody';
import type { SkyHandle } from '../../sky';
import type { ShipState, SimState } from '../../state/simState';
import { palmWindStrength } from '../../vegetation';
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

const hazeFallback = new Color(skyParams.horizonColor);
const NO_CONTACTS = new Float32Array(0);

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
  const windVec = new Vector2();
  const tmpDir = new Vector3();
  const view: ShipState = structuredClone(boat);
  const npcView: Rigid6State = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] };
  const wakeSamples: HydroSample[] = [];
  const jets: PropWashInput[] = [];
  let lastOceanTime = Number.NaN;
  let ticked = false;

  const snap = (): void => {
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
      sea.ocean.advanceSpectrum(oceanParams);
      sea.cpuOcean.update(state.time);
    },
    /** FIXED TICK, after the player's physics: wake, jets, spray, interpolation pair */
    tickBoat(dt: number): void {
      player.wakeSamples(wakeSamples);
      player.jets(jets);
      const fwd = rotateVec(boat.quaternion, [0, 0, 1]);
      const speed = Math.hypot(boat.velocity[0], boat.velocity[2]);
      const ff = sea.flowFoam;
      ff.setCenter(boat.position[0], boat.position[2]);
      ff.setFlowDir([-boat.velocity[0], -boat.velocity[2]]);
      ff.setShip([boat.position[0], boat.position[2]], Math.atan2(fwd[0], fwd[2]), speed, hull.stemZ, hull.transomZ, hull.beam);
      ff.advanceWake(dt);
      ticked = true;
      ff.setAmbientSea(sea.ocean.cascades);
      // HOOK NEEDED (§T.180 e): burial rates come from sea-physics `HullContact`; HullWater has no
      // `HullBurialInput` view yet, so the sim churn gets no heave/pitch foam from this hull
      ff.setHullBurial(null);
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
      sky.setShadowFocus(boat.position[0], boat.position[1], boat.position[2]);
      sky.update(skyParams.timeOfDay, { direction: state.wind.direction, speed: state.wind.speed, dt: frameDt });
      if (paused || state.time !== lastOceanTime) {
        lastOceanTime = state.time;
        sea.ocean.update(app.renderer, state.time);
      }
      sea.foam.update(app.renderer, frameDt);
      sea.caustics.update(sky.sunDirection);
      sea.fetchField.update(oceanParams.windDirection);
      sea.rain.update({ intensity: d.weatherHere.rain, dt: frameDt, seaSigma: sea.ocean.heightRms });
      // HOOK NEEDED (§V101): a per-station waterline view of HullWater for the wetline; until then it dries
      boats.wetline.updateFromContacts(frameDt, NO_CONTACTS);
      sea.spray.centerUniform.value.set(boat.position[0], boat.position[2]);
      windVec.set(Math.cos(state.wind.direction) * state.wind.speed, Math.sin(state.wind.direction) * state.wind.speed);
      if (sea.spray.mesh.visible) {
        sea.spray.update(app.renderer, windVec, {
          heightRms: sea.ocean.heightRms, jacobianRms: sea.ocean.jacobianRms, choppiness: sea.ocean.effectiveChoppiness(),
        });
      }
      sea.archipelago.update(
        {
          time: state.time,
          windDir: [Math.cos(state.wind.direction), Math.sin(state.wind.direction)],
          windStrength: palmWindStrength(state.wind.speed),
          swell: sea.ocean.heightRms * 2,
          sunDirection: sky.sunDirection,
          hazeColor: app.scene.fog?.color ?? hazeFallback,
          cameraPosition: app.camera.position,
          camera: app.camera,
        },
        d.waterAt,
      );
      // a frame can land before the first tick (the loop runs 0 ticks on a short first frame): the
      // wake track is sim state, advanced only by tickBoat, and flowFoam.update reports an unadvanced one
      if (ticked) {
        sea.flowFoam.renderInjection(app.renderer, app.scene);
        sea.flowFoam.update(app.renderer, frameDt);
      }
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
      sea.clouds.update(state.time, sky.sunDirection);
      sea.reflection?.update(app.camera as PerspectiveCamera, state.time);
      sea.surface.update(app.camera, state.time, sky.sunDirection);
      const fwd = g.getWorldDirection(tmpDir);
      return { headingRad: Math.atan2(fwd.x, fwd.z), knots: Math.hypot(boat.velocity[0], boat.velocity[2]) * 1.944 };
    },
  };
}
export type SpeedboatFrame = ReturnType<typeof createSpeedboatFrame>;
