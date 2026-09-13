/**
 * THE SHARED PER-TICK / PER-FRAME SEA SEQUENCE (§V95; tech-research §8 S0 "renderSeaCommon").
 * `core/seaScene.ts buildSea` builds ONE sea for a page; this file drives it. Every entry that
 * floats a hero vessel on that sea (raft `raft/raftFrame.ts`, speedboat
 * `speedboat/page/speedboatFrame.ts`) calls these in its own order and adds only its vessel's
 * work between them — so a new sea system is wired once, not once per mode. The pirate page
 * builds its sea inline in `main.ts` (user WIP) and does not use this yet.
 *
 * Each method is a fixed run of calls that BOTH entries made identically before the extraction;
 * the vessel-specific inputs (burial source, jets, wake stem, bow spray, wetline, rig) stay in the
 * entries, between the runs:
 *
 *   FIXED TICK   tickSpectrum     spectrum schedule + §V8 mirror to this tick's time (BEFORE forces)
 *                trackWake        flowfoam region + wake track on the hero's SIM pose (§V105)
 *   RENDER       renderSeaBase    sky → ocean (once per sim time) → foam → caustics → fetch → rain
 *                renderSpray      ambient spray centred on the hero
 *                renderShore      archipelago (tags the foam targets renderFlowFoam traverses for)
 *                renderFlowFoam   injection capture + advect/blur + the one wake compute group
 *   (lens)       renderCameraPasses  clouds + planar reflection — AFTER the camera rig wrote the lens
 *                renderSurface    the ocean surface's camera-derived update
 *
 * Nothing here reads the camera for sim state, and nothing here steps physics.
 */
import { Color, Vector2, type PerspectiveCamera } from 'three/webgpu';
import type { App } from './app';
import type { Sea } from './seaScene';
import { rotateVec } from './quat';
import { oceanParams } from '../ocean';
import { skyParams } from '../params/sky';
import type { SkyHandle } from '../sky';
import type { SimState } from '../state/simState';
import { palmWindStrength } from '../vegetation';
import type { WeatherSample } from '../weather';

/** the hero's sim pose, as ShipState and Rigid6State both carry it */
export interface SeaFramePose {
  readonly position: readonly number[];
  readonly quaternion: readonly number[];
  readonly velocity: readonly number[];
}

export interface SeaFrameDeps {
  app: App;
  sea: Pick<
    Sea,
    'ocean' | 'cpuOcean' | 'foam' | 'caustics' | 'fetchField' | 'rain' | 'spray' | 'archipelago' | 'flowFoam' | 'clouds' | 'reflection' | 'surface'
  >;
  sky: SkyHandle;
  state: SimState;
  weatherHere: WeatherSample;
  /** §V8 sea height at world XZ, this tick (the archipelago's shoreline reads it) */
  waterAt(x: number, z: number): number;
}

const hazeFallback = new Color(skyParams.horizonColor);

export function createSeaFrame(d: SeaFrameDeps) {
  const { app, sea, sky, state } = d;
  const windVec = new Vector2();
  let lastOceanTime = Number.NaN;

  return {
    /** FIXED TICK, before any force reads the sea: the spectrum schedule and the mirror to `state.time` */
    tickSpectrum(): void {
      sea.ocean.advanceSpectrum(oceanParams);
      sea.cpuOcean.update(state.time);
    },

    /**
     * FIXED TICK: the flowfoam region and the wake track follow the hero's SIM pose (§V105).
     * `stemZ`/`transomZ` body-frame, `beam` full breadth (m).
     */
    trackWake(ship: SeaFramePose, stemZ: number, transomZ: number, beam: number, dt: number): void {
      const fwd = rotateVec(ship.quaternion as [number, number, number, number], [0, 0, 1]);
      const speed = Math.hypot(ship.velocity[0], ship.velocity[2]);
      const ff = sea.flowFoam;
      ff.setCenter(ship.position[0], ship.position[2]);
      ff.setFlowDir([-ship.velocity[0], -ship.velocity[2]]);
      ff.setShip([ship.position[0], ship.position[2]], Math.atan2(fwd[0], fwd[2]), speed, stemZ, transomZ, beam);
      ff.advanceWake(dt);
    },

    /** RENDER, first: sky, the drawn ocean (once per sim time unless paused), foam, caustics, fetch, rain */
    renderSeaBase(focus: SeaFramePose, frameDt: number, paused: boolean): void {
      sky.setShadowFocus(focus.position[0], focus.position[1], focus.position[2]);
      sky.update(skyParams.timeOfDay, { direction: state.wind.direction, speed: state.wind.speed, dt: frameDt });
      if (paused || state.time !== lastOceanTime) {
        lastOceanTime = state.time;
        sea.ocean.update(app.renderer, state.time);
      }
      sea.foam.update(app.renderer, frameDt);
      sea.caustics.update(sky.sunDirection);
      sea.fetchField.update(oceanParams.windDirection);
      sea.rain.update({ intensity: d.weatherHere.rain, dt: frameDt, seaSigma: sea.ocean.heightRms });
    },

    /** RENDER: the ambient spray field, centred on the hero */
    renderSpray(focus: SeaFramePose): void {
      sea.spray.centerUniform.value.set(focus.position[0], focus.position[2]);
      windVec.set(Math.cos(state.wind.direction) * state.wind.speed, Math.sin(state.wind.direction) * state.wind.speed);
      if (sea.spray.mesh.visible) {
        sea.spray.update(app.renderer, windVec, {
          heightRms: sea.ocean.heightRms, jacobianRms: sea.ocean.jacobianRms, choppiness: sea.ocean.effectiveChoppiness(),
        });
      }
    },

    /** RENDER: islands, vegetation and shoreline — BEFORE renderFlowFoam (it tags the foam targets) */
    renderShore(): void {
      sea.archipelago.update(
        {
          time: state.time,
          windDir: [Math.cos(state.wind.direction), Math.sin(state.wind.direction)],
          windStrength: palmWindStrength(state.wind.speed),
          swell: sea.ocean.heightRms * 2,
          sunDirection: sky.sunDirection,
          hazeColor: app.scene.fog?.color ?? hazeFallback,
          cameraPosition: app.camera.position,
          // §T.112g: the per-instance vegetation cull needs the frustum, not just the position
          camera: app.camera,
        },
        d.waterAt,
      );
    },

    /** RENDER: hull foam capture, advect/blur, and the sim wake's one compute group (§V104) */
    renderFlowFoam(frameDt: number): void {
      sea.flowFoam.renderInjection(app.renderer, app.scene);
      sea.flowFoam.update(app.renderer, frameDt);
    },

    /** RENDER, after the camera rig wrote this frame's lens: clouds and the planar reflection */
    renderCameraPasses(): void {
      sea.clouds.update(state.time, sky.sunDirection);
      sea.reflection?.update(app.camera as PerspectiveCamera, state.time);
    },

    /** RENDER, last of the sea: the surface's camera-derived update */
    renderSurface(): void {
      sea.surface.update(app.camera, state.time, sky.sunDirection);
    },
  };
}
export type SeaFrame = ReturnType<typeof createSeaFrame>;
