/**
 * Raft-entry per-tick and per-frame updates (§T.98) for the sea and the
 * vessel built in `raftScene.ts` — the same calls, in the same order and for
 * the same reasons as `src/main.ts`'s loop, with the combat, enemy and
 * lantern work removed. `main-raft.ts` owns the loop and the sim; this file
 * owns the plumbing so the entry stays boot-only.
 *
 * Order matters in `renderSea`: `archipelago.update` tags foam targets that
 * `flowFoam.renderInjection` traverses for, and every camera-derived pass
 * (clouds, reflection) runs in `renderVessel` AFTER the follow cam has
 * written the lens for this frame.
 */
import { Color, Quaternion, Vector2, Vector3, type PerspectiveCamera } from 'three/webgpu';
import type { App } from '../core/app';
import type { SkyHandle } from '../sky';
import type { ShipState, SimState } from '../state/simState';
import type { WeatherSample } from '../weather';
import type { AudioFrame, AudioSystem, ShipAudioInput } from '../audio';
import { oceanParams } from '../ocean';
import { skyParams } from '../params/sky';
import { shipRigParams } from '../params/ship';
import { raftSeaParams } from '../params/seaPhysics';
import { stepShipBuoyancy } from '../sea-physics/buoyancy';
import { raftContactPoints } from '../sailing/raftBeaching';
import { updateRig } from '../ship/rigTrim';
import { trimDropScale } from '../ship/sailDynamics';
import { palmWindStrength } from '../vegetation';
import { rotateVec, stepRaftBeach, type BeachHolder } from './raftShip';
import type { RaftSea, RaftVessel } from './raftScene';

export interface RaftFrameDeps {
  app: App;
  sea: RaftSea;
  vessel: RaftVessel;
  sky: SkyHandle;
  state: SimState;
  raft: ShipState;
  /** §T.100 beaching memory (`raftActions.raftBeach`); `.state` is replaced each tick */
  beach: BeachHolder;
  weatherHere: WeatherSample;
  audio: AudioSystem;
  /** §V.8 sea height at world XZ, this tick */
  waterAt(x: number, z: number): number;
  /** the follow cam writes the lens between renderSea and renderVessel */
  placeCamera(view: ShipState, frameDt: number): void;
}

const hazeFallback = new Color(skyParams.horizonColor);

export function createRaftFrame(d: RaftFrameDeps) {
  const { app, sea, vessel, sky, state, raft } = d;
  const prevPos = new Vector3();
  const currPos = new Vector3();
  const prevQuat = new Quaternion();
  const currQuat = new Quaternion();
  const windVec = new Vector2();
  const bowWorld = new Vector3();
  const shipVel = new Vector3();
  const shipFwd = new Vector3();
  const tmpDir = new Vector3();
  const renderShipView = structuredClone(raft);
  // the log undersides (§T.100): a pure function of raftParams, taken once —
  // the raft is not reshaped mid-sail, and the set is ~60 points a tick
  const contacts = raftContactPoints();
  let lastOceanTime = Number.NaN;
  let bowImmersion = 0;
  let drop = 1;

  const audioShip: ShipAudioInput = {
    position: raft.position, quaternion: raft.quaternion, velocity: raft.velocity,
    angularVelocity: raft.angularVelocity, sailTrim: raft.sailTrim, bowImmersion: 0, bowWorld: [0, 0, 0],
  };
  const audioBowWorld = audioShip.bowWorld as [number, number, number];
  const audioFrame: AudioFrame = {
    dt: 0, camera: app.camera, wind: { speed: 0, direction: 0 }, weather: state.weather, ship: audioShip,
  };

  const snap = (): void => {
    currPos.fromArray(raft.position);
    currQuat.fromArray(raft.quaternion);
    prevPos.copy(currPos);
    prevQuat.copy(currQuat);
  };
  snap();

  return {
    /** collapse the interpolation pair after a teleport */
    snap,
    /** sim tick, AFTER sailing wrote x/z/yaw: wake, buoyancy, contact, beaching, deck water */
    tickSea(dt: number): { aground: boolean; beached: boolean } {
      sea.ocean.advanceSpectrum(oceanParams);
      sea.cpuOcean.update(state.time);
      const fwd = rotateVec(raft.quaternion, [0, 0, 1]);
      const speed = Math.hypot(raft.velocity[0], raft.velocity[2]);
      sea.flowFoam.setCenter(raft.position[0], raft.position[2]);
      sea.flowFoam.setFlowDir([-raft.velocity[0], -raft.velocity[2]]);
      sea.flowFoam.setShip(
        [raft.position[0], raft.position[2]], Math.atan2(fwd[0], fwd[2]), speed,
        vessel.stemZ, vessel.transomZ, vessel.beamHalf * 2,
      );
      sea.flowFoam.advanceWake(dt);
      // the raft's own displacement (§T.109): 15 t on a 0.3 m draft, not the galleon's 604 t on 2 m
      stepShipBuoyancy(raft, sea.cpuOcean, dt, raftSeaParams);
      vessel.hullContact.update(raft, sea.cpuOcean, state.time);
      // §T.100 in place of keel grounding: the log undersides meet the sand, she
      // slows, and below beachHoldSpeed she is HELD until the crew push off
      const b = stepRaftBeach(raft, d.beach, contacts, sea.archipelago.seabed, dt);
      vessel.deckWater.update(
        app.renderer,
        { quaternion: raft.quaternion, speed, seaSigma: sea.ocean.heightRms, hull: vessel.hullContact },
        dt,
      );
      prevPos.copy(currPos);
      prevQuat.copy(currQuat);
      currPos.fromArray(raft.position);
      currQuat.fromArray(raft.quaternion);
      return { aground: b.aground, beached: b.beach.beached };
    },
    /** render, part one: everything that does not depend on this frame's camera */
    renderSea(frameDt: number, paused: boolean): void {
      sky.setShadowFocus(raft.position[0], raft.position[1], raft.position[2]);
      sky.update(skyParams.timeOfDay, { direction: state.wind.direction, speed: state.wind.speed, dt: frameDt });
      if (paused || state.time !== lastOceanTime) {
        lastOceanTime = state.time;
        sea.ocean.update(app.renderer, state.time);
      }
      sea.foam.update(app.renderer, frameDt);
      sea.caustics.update(sky.sunDirection);
      sea.fetchField.update(oceanParams.windDirection);
      sea.rain.update({ intensity: d.weatherHere.rain, dt: frameDt, seaSigma: sea.ocean.heightRms });
      vessel.wetline.updateFromHullContact(frameDt, vessel.hullContact.stations, vessel.hullContact.depth);
      sea.spray.centerUniform.value.set(raft.position[0], raft.position[2]);
      windVec.set(Math.cos(state.wind.direction) * state.wind.speed, Math.sin(state.wind.direction) * state.wind.speed);
      if (sea.spray.mesh.visible) {
        sea.spray.update(app.renderer, windVec, {
          heightRms: sea.ocean.heightRms, jacobianRms: sea.ocean.jacobianRms, choppiness: sea.ocean.effectiveChoppiness(),
        });
      }
      const bowLocal = rotateVec(raft.quaternion, [0, 0, vessel.stemZ]);
      bowWorld.set(raft.position[0] + bowLocal[0], raft.position[1] + bowLocal[1], raft.position[2] + bowLocal[2]);
      shipVel.fromArray(raft.velocity);
      const f = rotateVec(raft.quaternion, [0, 0, 1]);
      shipFwd.set(f[0], f[1], f[2]).normalize();
      bowImmersion = d.waterAt(bowWorld.x, bowWorld.z) - bowWorld.y;
      if (sea.bowSpray.mesh.visible) {
        sea.bowSpray.update(app.renderer, {
          bowWorldPos: bowWorld, shipVelocity: shipVel, shipForward: shipFwd,
          immersionDepth: bowImmersion, cutwater: vessel.hullContact.cutwater,
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
        },
        d.waterAt,
      );
      sea.flowFoam.renderInjection(app.renderer, app.scene);
      sea.flowFoam.update(app.renderer, frameDt);
    },
    /** render, part two: the hull at the interpolated pose, the lens, then the camera-derived passes */
    renderVessel(alpha: number, frameDt: number): { headingRad: number; knots: number } {
      const g = vessel.assembly.group;
      g.position.lerpVectors(prevPos, currPos, alpha);
      g.quaternion.slerpQuaternions(prevQuat, currQuat, alpha);
      g.position.toArray(renderShipView.position);
      g.quaternion.toArray(renderShipView.quaternion);
      renderShipView.velocity[0] = raft.velocity[0];
      renderShipView.velocity[1] = raft.velocity[1];
      renderShipView.velocity[2] = raft.velocity[2];
      d.placeCamera(renderShipView, frameDt);
      sea.clouds.update(state.time, sky.sunDirection);
      sea.reflection?.update(app.camera as PerspectiveCamera, state.time);
      updateRig(vessel.assembly, frameDt, raft.sailTrim, raft.rudder);
      drop = trimDropScale(raft.sailTrim, shipRigParams);
      vessel.updateRopes(Math.min(1, Math.max(0, (1 - drop) / Math.max(1e-3, 1 - shipRigParams.trimDropMin))));
      sea.surface.update(app.camera, state.time, sky.sunDirection);
      const fwd = g.getWorldDirection(tmpDir);
      return {
        headingRad: Math.atan2(fwd.x, fwd.z),
        knots: Math.hypot(raft.velocity[0], raft.velocity[2]) * 1.944,
      };
    },
    /** audio LAST: the listener reads camera.matrixWorld, final only after the render */
    renderAudio(frameDt: number): void {
      audioFrame.dt = frameDt;
      audioFrame.wind.speed = state.wind.speed;
      audioFrame.wind.direction = state.wind.direction;
      audioFrame.weather = state.weather;
      audioShip.position = renderShipView.position;
      audioShip.quaternion = renderShipView.quaternion;
      audioShip.velocity = raft.velocity;
      audioShip.angularVelocity = raft.angularVelocity;
      audioShip.sailTrim = raft.sailTrim;
      audioShip.bowImmersion = bowImmersion;
      audioShip.contact = vessel.hullContact;
      audioShip.sailDrop = drop;
      audioBowWorld[0] = bowWorld.x;
      audioBowWorld[1] = bowWorld.y;
      audioBowWorld[2] = bowWorld.z;
      d.audio.update(audioFrame);
    },
  };
}
