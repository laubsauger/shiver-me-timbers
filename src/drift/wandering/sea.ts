/**
 * The Drift at sea level (drift-narrative/wandering-on/direction.md, "Engine plan"): the game's own sea — its
 * FFT ocean, one island, the raft — under Act 2's own air, in a scene of its own, drawn through the dome
 * capture. Two uses: the TEST ACT (`drift.html?sea[&hour=h]`, one hour held, the flock flying) and PART C's
 * first sketch on the show's clock (`PART_C`: golden hour into night). Every frame is a pure function of its
 * time, in any order.
 *
 * Built by hand rather than with the game's `buildSea`, which always adds the systems that carry state from
 * frame to frame (foam, the wake, spray, rain) or assume one camera (clouds, the planar reflection). Here:
 *   - the ocean's spectrum phase is ω·t, so `ocean.update(renderer, t)` is pure in t (its params must not
 *     change during the act: a change arms a rebuild spread over frames);
 *   - the sky is pure in the hour (no wind given: its wind lines accumulate phase);
 *   - the island is pure in time given no camera (its plant cull is stateful and single-camera);
 *   - the surface's grid snaps to the eye; its radial LOD keeps a band across frames, so it is off;
 *   - the CPU ocean recomputes for every new t (`updateEveryTicks: 0`; by default it reuses a grid ~1/60 s).
 * The camera is stabilised (direction.md: the horizon never moves): the eye sits EYE_HEIGHT above the mean
 * sea, turned to face the low sun.
 */
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { createSky } from '../../sky';
import { skyParams } from '../../params/sky';
import { createOceanSim, oceanParams } from '../../ocean';
import { OceanSurface } from '../../ocean/oceanSurface';
import { oceanSurfaceParams } from '../../params/oceanSurface';
import { causticsParams } from '../../params/caustics';
import { createArchipelago, generateIslandSites } from '../../island/archipelago';
import { CpuOcean } from '../../sea-physics/cpuOcean';
import { raftSeaParams } from '../../params/seaPhysics';
import { weatherPresets } from '../../weather/presets';
import { createFlock, loadFlock, type FlockUniforms } from './flock';
import { createSeaSky } from './seaSky';
import { bakeNightSky } from './nightSky';
import { createRaft } from './raft';
import { CIRRUS_H, CLOUD_BASE, CLOUD_TOP, loadClouds, type CloudUniforms } from './clouds';
import { sunlightCpu } from './seaSky';
import { EARTH_R } from '../getTheDrift/atmosphere';
import { sunDirection } from '../../sky/sunCycle';
import { SUN_E } from '../getTheDrift/atmosphere';

/** the game's world seed (Raft 2100) */
const SEED = 2100;
/** m above the mean sea: just above a raft's deck */
const EYE_HEIGHT = 3;
/** golden hour (sunCycle.ts: ~14° up in the west at latitude 15) */
const HOUR = 17.5;

/**
 * Part C's first sketch (direction.md C2–C4, before the dolphin, the radio and the beams): seafaring from
 * golden hour through sunset and twilight into the Milky Way night. Only the light moves faster than real
 * time, and gently (the Sun ~0.25°/s).
 */
export const PART_C = { total: 80, hour: (t: number): number => 17.55 + (Math.min(Math.max(t, 0), 80) / 80) * 1.25, flock: false };
/** m, the face cameras' far plane: past the sea's rim (~4.6 km), short enough for the depth precision the
 * ocean's refraction thickness reads */
const FAR = 12000;
/** the island: m away, and deg to the left of the sun */
const ISLAND_DISTANCE = 650;
const ISLAND_LEFT_OF_SUN = 35;
/** s into the act the sandpipers take off */
const FLOCK_START = 5;
/** the clouds: how much sky the field covers, and the wind that carries it (m/s, rad on the xz plane) */
const CLOUD_COVER = 0.32;
const CIRRUS_COVER = 0.45;
const WIND = 7;
const WIND_DIR = 0.6;
/** m: the raft ahead of the eye, and to its right — off the Sun's line (~30°), so its mast never stands in
 * the sunset or across the glitter road; and the rad its bow turns from the Sun toward its right */
const RAFT_AHEAD = 10;
const RAFT_RIGHT = 6;
const RAFT_SHEER = 0.5;

export interface SeaAct {
  readonly scene: THREE.Scene;
  readonly far: number;
  /** s, the act's length */
  readonly total: number;
  /** the eye's adaptation to the light (multiplies the show's exposure) */
  readonly exposure: number;
  /** resolves once its data (the clouds' noise, the flock's keys) is loaded */
  readonly ready: Promise<void>;
  /** put the sea into the state of time t and the eye where it watches from */
  update(t: number, eye: THREE.Object3D, renderer: THREE.WebGPURenderer): void;
  setPixelAngle(rad: number): void;
}

/** `hour`: the time of day the act holds, or follows (default golden hour); `flock`: the sandpipers fly */
export function createSea(renderer: THREE.WebGPURenderer, o: { hour?: number | ((t: number) => number); flock?: boolean; total?: number } = {}): SeaAct {
  const hourAt = typeof o.hour === 'function' ? o.hour : (): number => (o.hour as number | undefined) ?? HOUR;
  const hour = hourAt(0);
  const scene = new THREE.Scene();
  scene.name = 'drift-sea';
  // the sky retints it every update; the ocean and the island melt into its colour at range
  scene.fog = new THREE.Fog(0xa1e7ff, 700, 4500);
  skyParams.timeOfDay = hour;
  // the game's sky rig for its lights (the sun and the ambient the island and the ocean are built to read);
  // what they are set to, and the sky itself, come from Act 2's air (seaSky.ts): one sky from orbit to sea
  const sky = createSky({ scene });
  scene.backgroundNode = null;
  // the Sun's own direction (the rig's key turns to the Moon at night), and the dome's front toward its bearing
  // at the act's start (the eye does not turn after it)
  const sun = new THREE.Vector3(...sunDirection(hour, skyParams.latitude));
  const yaw = Math.atan2(-sun.x, -sun.z);
  const front = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  // the clouds: a fair-weather cumulus field drifting on the wind (clouds.ts)
  const cloudData = loadClouds();
  const cu = {
    time: uniform(0),
    wind: uniform(new THREE.Vector2(Math.cos(WIND_DIR) * WIND, Math.sin(WIND_DIR) * WIND)),
    coverage: uniform(CLOUD_COVER),
    sun: uniform(new THREE.Vector3()),
    sunBase: uniform(new THREE.Vector3()),
    sunTop: uniform(new THREE.Vector3()),
    ambient: uniform(new THREE.Vector3()),
    cirrusCover: uniform(CIRRUS_COVER),
    sunCirrus: uniform(new THREE.Vector3()),
  };
  const seaSky = createSeaSky(FAR * 0.8, bakeNightSky(renderer, front, new THREE.Vector3(0, 1, 0)), {
    data: cloudData,
    uniforms: cu as unknown as CloudUniforms,
  });
  scene.add(seaSky.mesh);
  let hemi: THREE.HemisphereLight | undefined;
  scene.traverse((o) => {
    if ((o as THREE.HemisphereLight).isHemisphereLight) hemi = o as THREE.HemisphereLight;
  });
  // no caustics bound in this page: neutral without the warning
  causticsParams.enabled = false;
  oceanSurfaceParams.radialLodPixels = 0;

  const bearing = yaw + (ISLAND_LEFT_OF_SUN * Math.PI) / 180;
  const site = { ...generateIslandSites(SEED)[0], position: [-Math.sin(bearing) * ISLAND_DISTANCE, -Math.cos(bearing) * ISLAND_DISTANCE] as [number, number] };
  const archipelago = createArchipelago({ seed: SEED, sites: [site] });
  scene.add(archipelago.group);

  // a calm sea (direction.md: the swell lifts and sets the raft down; the game's default is a working sea,
  // Hs ~2.8 m): the game's calm preset — a light breeze over a long low ground swell. Set before the
  // spectrum is built, never changed during the act
  Object.assign(oceanParams, weatherPresets.calm.ocean);
  const ocean = createOceanSim(SEED);
  const surface = new OceanSurface(ocean, undefined, undefined, {
    sunLight: sky.sunLight,
    skyDomeColor: seaSky.dome,
    skySunTerm: seaSky.sunTerm,
    seabed: archipelago.seabed,
    // the dome's cube target is half-float, as the game's HDR scene target
    hdrSceneTarget: true,
  });
  scene.add(surface.group);
  surface.group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.receiveShadow = true;
  });
  const cpu = new CpuOcean(SEED, oceanParams, { ...raftSeaParams, updateEveryTicks: 0 }, ocean.spectrum);
  // the raft (C1–C3), RAFT_AHEAD m in front of the eye, sailing toward the low sun
  const raft = createRaft((x, z, t) => cpu.heightAt(x, z, t));
  scene.add(raft.group);

  // the sandpipers (W4), startled FLOCK_START s into the act; the bake's front turned to the dome's front
  const flockData = loadFlock();
  const fu = {
    time: uniform(0),
    origin: uniform(new THREE.Vector3(0, 0, 0)),
    basis: uniform(new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationY(yaw))),
    sun: uniform(new THREE.Vector3()),
    eye: uniform(new THREE.Vector3()),
    pixelAngle: uniform(0.0015),
    presence: uniform(1),
    sunLight: uniform(new THREE.Vector3()),
    skyLight: uniform(new THREE.Vector3()),
  };
  // (its shader bakes the key count in: built once the keys are loaded)
  const ready = o.flock === false ? Promise.resolve() : flockData.ready.then(() => {
    const flock = createFlock(flockData, fu as unknown as FlockUniforms);
    flock.frustumCulled = false;
    scene.add(flock);
  });

  // the surface reads one camera: a proxy at the eye with the faces' field and far plane
  const proxy = new THREE.PerspectiveCamera(90, 1, 0.05, FAR);
  const windDir: [number, number] = [Math.cos(oceanParams.windDirection), Math.sin(oceanParams.windDirection)];

  return {
    scene,
    far: FAR,
    total: o.total ?? 60,
    get exposure() {
      return seaSky.exposure;
    },
    ready: Promise.all([ready, cloudData.ready]).then(() => undefined),
    setPixelAngle(rad) {
      fu.pixelAngle.value = rad;
    },
    update(t, eye, renderer) {
      eye.position.set(0, EYE_HEIGHT, 0);
      eye.rotation.set(0, yaw, 0);
      eye.updateMatrixWorld();
      const h = hourAt(t);
      sun.set(...sunDirection(h, skyParams.latitude));
      // (the sail reads the hour from skyParams for its own Sun)
      skyParams.timeOfDay = h;
      sky.setShadowFocus(0, 0, 0);
      sky.update(h);
      // the lights from the air: the sunlight reaching the sea, the sky's irradiance (a little of it back off
      // the water and the sand below), the haze at the horizon
      seaSky.update(eye.position, sun);
      cu.time.value = t;
      cu.sun.value.copy(sun);
      const atCloud = (h: number, v: THREE.Vector3): void => {
        const c = sunlightCpu(EARTH_R + h * 1e-6, sun.y);
        v.set(c[0], c[1], c[2]).multiplyScalar(SUN_E / Math.PI);
      };
      atCloud(CLOUD_BASE, cu.sunBase.value);
      atCloud(CLOUD_TOP, cu.sunTop.value);
      atCloud(CIRRUS_H, cu.sunCirrus.value);
      cu.ambient.value.set(seaSky.irradiance.r, seaSky.irradiance.g, seaSky.irradiance.b).multiplyScalar(1 / Math.PI);
      sky.sunLight.color.copy(seaSky.sunColour);
      sky.sunLight.intensity = SUN_E;
      if (hemi) {
        hemi.color.copy(seaSky.irradiance);
        hemi.groundColor.copy(seaSky.irradiance).multiplyScalar(0.15);
        hemi.intensity = 1;
      }
      (scene.fog as THREE.Fog).color.copy(seaSky.horizon);
      ocean.update(renderer, t);
      archipelago.update(
        {
          time: t,
          windDir,
          windStrength: 0.4,
          swell: ocean.heightRms * 2,
          sunDirection: sun,
          hazeColor: (scene.fog as THREE.Fog).color,
          cameraPosition: eye.position,
        },
        (x, z) => cpu.heightAt(x, z, t),
      );
      const lum = (c: THREE.Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      raft.update(t, front.x * RAFT_AHEAD - front.z * RAFT_RIGHT, front.z * RAFT_AHEAD + front.x * RAFT_RIGHT, yaw + Math.PI - RAFT_SHEER, {
        sun: lum(seaSky.sunColour),
        sky: Math.min(1, lum(seaSky.irradiance) / 0.4),
      });
      proxy.position.copy(eye.position);
      proxy.updateMatrixWorld();
      surface.update(proxy, t, sun);
      fu.time.value = t - FLOCK_START;
      fu.sun.value.copy(sun);
      // radiance of a white surface: the Sun's E·T/π facing it, the sky's irradiance/π
      fu.sunLight.value.set(seaSky.sunColour.r, seaSky.sunColour.g, seaSky.sunColour.b).multiplyScalar(SUN_E / Math.PI);
      fu.skyLight.value.set(seaSky.irradiance.r, seaSky.irradiance.g, seaSky.irradiance.b).multiplyScalar(1 / Math.PI);
      fu.eye.value.copy(eye.position);
    },
  };
}
