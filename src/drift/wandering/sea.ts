/**
 * The Drift at sea level (drift-narrative/wandering-on/direction.md, "Engine plan"): the game's own sea — its
 * FFT ocean, the raft — under Act 2's own air, in a scene of its own, drawn through the dome capture. Two
 * uses, every frame a pure function of its time, in any order:
 *   - DRIVEN (`drive`): the landing's last hundreds of metres and what follows it. Act 2 hands over each frame
 *     where the eye is, which way it heads and where the Sun stands, in the frame of Drift-2's debris galaxy
 *     (metres: x east, y above the mean sea, z north of the field's centre: debrisField.ts); the same field floats here
 *     (debrisField.ts), with a denser mat round the raft beside where the eye comes down. No island (the
 *     drowned Po plain has none near).
 *   - the TEST ACT (`drift.html?sea[&hour=h]`): one hour held, the eye 3 m up facing the Sun, an island, the
 *     flock flying.
 *
 * Built by hand rather than with the game's `buildSea`, which always adds the systems that carry state from
 * frame to frame (foam, the wake, spray, rain) or assume one camera (clouds, the planar reflection). Here:
 *   - the ocean's spectrum phase is ω·t, so `ocean.update(renderer, t)` is pure in t (its params must not
 *     change during the act: a change arms a rebuild spread over frames);
 *   - the sky rig is pure in the hour (no wind given: its wind lines accumulate phase); its key light is aimed
 *     at the Sun this act is given;
 *   - the island is pure in time given no camera (its plant cull is stateful and single-camera);
 *   - the surface's grid snaps to the eye; its radial LOD keeps a band across frames, so it is off;
 *   - the CPU ocean recomputes for every new t (`updateEveryTicks: 0`; by default it reuses a grid ~1/60 s).
 * The camera is stabilised (direction.md: the horizon never moves): no roll, no pitch — the driven eye takes
 * Act 2's turn, which has levelled out by the time it rests.
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
import { createSeaSky, sunlightCpu } from './seaSky';
import { bakeNightSky } from './nightSky';
import { createRaft } from './raft';
import { CIRRUS_H, CLOUD_BASE, CLOUD_TOP, loadClouds, type CloudUniforms } from './clouds';
import { EARTH_R, SUN_E } from '../getTheDrift/atmosphere';
import { sunDirection } from '../../sky/sunCycle';
import { createPlanarReflection } from '../../reflection';
import { mainCameraMask } from '../../reflection/mirrorMath';
import { DEBRIS_SPIN, clearOf, createDebrisField, debrisPieces, matPieces, type DebrisUniforms } from '../getTheDrift/debrisField';

/** the game's world seed (Raft 2100) */
const SEED = 2100;
/** m above the mean sea in the test act: just above a raft's deck */
const EYE_HEIGHT = 3;
/** the test act's golden hour (sunCycle.ts: ~14° up in the west at latitude 15) */
const HOUR = 17.5;
/** m, the face cameras' far plane: past the sea's rim (~4.6 km), short enough for the depth precision the
 * ocean's refraction thickness reads */
const FAR = 12000;
/** the test act's island: m away, and deg to the left of the sun */
const ISLAND_DISTANCE = 650;
const ISLAND_LEFT_OF_SUN = 35;
/** s into the test act the sandpipers take off */
const FLOCK_START = 5;
/** the clouds (once formed): how much sky the field covers, and the wind that carries it (m/s, rad) */
const CLOUD_COVER = 0.45;
const CIRRUS_COVER = 0.22;
const WIND = 10;
const WIND_DIR = 0.6;
/** m: the raft from where the eye comes to rest (its whole hull above the dome's front edge, 15° down: its
 * waterline ~10° down from 3 m, its mast up into the sky), and the deg its bearing keeps off the Sun's, on the
 * side nearer the front (to the Sun's right when the Sun is dead ahead) — so its mast never stands in the Sun
 * or across its glitter road; and the rad it turns off broadside to the eye (broadside, it reads as a raft: its
 * length, its deck, its mast; end-on, its near end dipped under the dome's edge) */
const RAFT_DISTANCE = 18;
const RAFT_OFF_SUN = 45;
const RAFT_SHEER = 0.35;
/** the sea: a light air's ripples (between the game's glass and calm presets: glass read too glassy, calm
 * bobbed), over a ground swell: m RMS (its Hs is 4×), s */
const RIPPLE = { amplitude: 0.15, windSpeed: 2.5, choppiness: 0.75 };
const SWELL_RMS = 0.08;
const SWELL_PERIOD = 14;
/** m: the mat of debris round the raft (a Gaussian's sigma: it thins into the field) and its pieces; the berth
 * kept clear round the raft (its logs reach 6.9 m from its centre) */
const MAT_SIGMA = 90;
const MAT_PIECES = 6000;
const RAFT_BERTH = 7.5;

/** what Act 2 hands the sea each frame (metres: x east, y above the mean sea, z north of the field's centre) */
export interface SeaDrive {
  eye: THREE.Vector3;
  /** rad: the heading the eye levels out on, a turn about y (0 looks toward −z) */
  yaw: number;
  /** the eye's turn (its −z the dome's front, +y its zenith) */
  turn: THREE.Quaternion;
  /** unit toward the Sun */
  sun: THREE.Vector3;
  /** s since the flood lifted the debris (the field's slow turn) */
  driftTime: number;
  /** 0..1 how much of the cloud field has formed */
  clouds: number;
}

export interface SeaAct {
  readonly scene: THREE.Scene;
  readonly far: number;
  /** s, the act's length */
  readonly total: number;
  /** the eye's adaptation to the light (multiplies the show's exposure) */
  readonly exposure: number;
  /** the layers the cameras drawing this scene must see (DomeCapture.setLayers) */
  readonly cameraLayers: number;
  /** resolves once its data (the clouds' noise, the flock's keys) is loaded */
  readonly ready: Promise<void>;
  /** put the sea into the state of time t and the eye where it watches from */
  update(t: number, eye: THREE.Object3D, renderer: THREE.WebGPURenderer): void;
  setPixelAngle(rad: number): void;
}

/**
 * `drive`: Act 2 hands over (see SeaDrive), the eye coming to rest by `total`; without it, the test act:
 * `hour` held, `flock` flying, an island.
 */
export function createSea(
  renderer: THREE.WebGPURenderer,
  o: { hour?: number; flock?: boolean; total?: number; drive?: (t: number) => SeaDrive } = {},
): SeaAct {
  const hour = o.hour ?? HOUR;
  const total = o.total ?? 60;
  const scene = new THREE.Scene();
  scene.name = 'drift-sea';
  // the sky retints it every update; the ocean melts into its colour at range
  scene.fog = new THREE.Fog(0xa1e7ff, 700, 4500);
  skyParams.timeOfDay = hour;
  // the game's sky rig for its lights (the sun and the ambient the ocean and the raft are built to read); what
  // they are set to, and the sky itself, come from Act 2's air (seaSky.ts): one sky from orbit to sea
  const sky = createSky({ scene });
  scene.backgroundNode = null;
  // the sky is a sphere (seaSky.ts), which never forces a clear: a colour background does (the faces would
  // keep the last scene's colour and depth — with autoClear off, as the show renders)
  scene.background = new THREE.Color(0x000000);
  // where the eye ends up and which way it looks (the night sky is laid for it, the raft placed by it)
  const testSun = new THREE.Vector3(...sunDirection(hour, skyParams.latitude));
  const rest = o.drive?.(total);
  const yaw = rest ? rest.yaw : Math.atan2(-testSun.x, -testSun.z);
  const front = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const right = new THREE.Vector3(-front.z, 0, front.x);
  const restAt = rest ? rest.eye.clone().setY(0) : new THREE.Vector3();
  // the clouds: a fair-weather cumulus field drifting on the wind (clouds.ts)
  const cloudData = loadClouds();
  const cu = {
    time: uniform(0),
    wind: uniform(new THREE.Vector2(Math.cos(WIND_DIR) * WIND, Math.sin(WIND_DIR) * WIND)),
    coverage: uniform(CLOUD_COVER),
    presence: uniform(1),
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
  scene.traverse((x) => {
    if ((x as THREE.HemisphereLight).isHemisphereLight) hemi = x as THREE.HemisphereLight;
  });
  // no caustics bound in this page: neutral without the warning
  causticsParams.enabled = false;
  oceanSurfaceParams.radialLodPixels = 0;

  // the test act's island
  let archipelago: ReturnType<typeof createArchipelago> | undefined;
  if (!o.drive) {
    const bearing = yaw + (ISLAND_LEFT_OF_SUN * Math.PI) / 180;
    const site = { ...generateIslandSites(SEED)[0], position: [-Math.sin(bearing) * ISLAND_DISTANCE, -Math.cos(bearing) * ISLAND_DISTANCE] as [number, number] };
    archipelago = createArchipelago({ seed: SEED, sites: [site] });
    scene.add(archipelago.group);
  }

  // a calm sea, near glass (the v6 notes; the game's default is a working sea, Hs ~2.8 m): the game's glass
  // preset with a light air's ripples (RIPPLE) over a long low ground swell (direction.md: the swell lifts and
  // sets the raft down). Set before the spectrum is built, never changed during the act
  Object.assign(oceanParams, weatherPresets.glass.ocean, RIPPLE, { swellAmplitude: SWELL_RMS, swellPeriod: SWELL_PERIOD });
  const ocean = createOceanSim(SEED);
  // the raft and the matter mirrored in the water (the game's planar mirror pass, src/reflection), rendered for
  // every cube face (each from its own camera); the sky in the water stays the ocean's analytic dome
  const reflection = createPlanarReflection({ sunLight: sky.sunLight, planeY: 0, perRender: true });
  const surface = new OceanSurface(ocean, undefined, undefined, {
    reflection,
    sunLight: sky.sunLight,
    skyDomeColor: seaSky.dome,
    skySunTerm: seaSky.sunTerm,
    seabed: archipelago?.seabed,
    // the dome's cube target is half-float, as the game's HDR scene target
    hdrSceneTarget: true,
  });
  scene.add(surface.group);
  surface.group.traverse((x) => {
    if ((x as THREE.Mesh).isMesh) x.receiveShadow = true;
  });
  reflection?.attachTo(scene);
  reflection?.excludeFromReflection(seaSky.mesh);
  reflection?.excludeFromReflection(surface.group);
  const cpu = new CpuOcean(SEED, oceanParams, { ...raftSeaParams, updateEveryTicks: 0 }, ocean.spectrum);
  // the raft, off the Sun's bearing from where the eye comes to rest, its bow turned off the eye's heading
  const raft = createRaft((x, z, t) => cpu.heightAt(x, z, t));
  scene.add(raft.group);
  const restSun = rest ? rest.sun : testSun;
  const sunRight = Math.atan2(restSun.dot(right), restSun.dot(front));
  const raftRight = sunRight - Math.sign(sunRight || -1) * ((RAFT_OFF_SUN * Math.PI) / 180);
  const raftAt = restAt.clone().addScaledVector(front, Math.cos(raftRight) * RAFT_DISTANCE).addScaledVector(right, Math.sin(raftRight) * RAFT_DISTANCE);
  // it floats in the field and turns with it (DEBRIS_SPIN: the current the eye follows, timeline.ts), so it is
  // where `raftAt` says when the eye rests at the act's end, and at a fixed place in the field's own frame
  const UP = new THREE.Vector3(0, 1, 0);
  const restTurn = rest ? DEBRIS_SPIN * rest.driftTime : 0;
  const raftInField = raftAt.clone().applyAxisAngle(UP, -restTurn);
  const raftNow = new THREE.Vector3();

  // Drift-2's debris: the galaxy (turning slowly as one) and the mat the raft floats in, turning with it; none
  // of it in the raft's berth
  const du = {
    sun: uniform(new THREE.Vector3()),
    sunLight: uniform(new THREE.Vector3()),
    skyLight: uniform(new THREE.Vector3()),
    presence: uniform(1),
    pixelAngle: uniform(0.0015),
    metres: uniform(1),
  };
  const berth = (data: ReturnType<typeof debrisPieces>): ReturnType<typeof debrisPieces> => clearOf(data, raftInField.x, raftInField.z, RAFT_BERTH);
  const debris = o.drive ? createDebrisField(berth(debrisPieces()), du as unknown as DebrisUniforms) : undefined;
  if (debris) {
    scene.add(debris);
    debris.add(createDebrisField(berth(matPieces(raftInField.x, raftInField.z, MAT_SIGMA, MAT_PIECES)), du as unknown as DebrisUniforms));
  }

  // the test act's sandpipers (W4), startled FLOCK_START s in; the bake's front turned to the dome's front
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
  const ready = o.drive || o.flock === false ? Promise.resolve() : flockData.ready.then(() => {
    const flock = createFlock(flockData, fu as unknown as FlockUniforms);
    flock.frustumCulled = false;
    scene.add(flock);
  });

  // the surface reads one camera: a proxy at the eye with the faces' field and far plane
  const proxy = new THREE.PerspectiveCamera(90, 1, 0.05, FAR);
  const windDir: [number, number] = [Math.cos(oceanParams.windDirection), Math.sin(oceanParams.windDirection)];
  const sun = new THREE.Vector3();
  const lum = (c: THREE.Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

  return {
    scene,
    far: FAR,
    total,
    get exposure() {
      return seaSky.exposure;
    },
    cameraLayers: mainCameraMask(1),
    ready: Promise.all([ready, cloudData.ready]).then(() => undefined),
    setPixelAngle(rad) {
      fu.pixelAngle.value = rad;
      du.pixelAngle.value = rad;
    },
    update(t, eye, renderer) {
      const d = o.drive?.(t);
      if (d) {
        eye.position.copy(d.eye);
        eye.quaternion.copy(d.turn);
        sun.copy(d.sun);
      } else {
        eye.position.set(0, EYE_HEIGHT, 0);
        eye.rotation.set(0, yaw, 0);
        sun.copy(testSun);
      }
      eye.updateMatrixWorld();
      skyParams.timeOfDay = hour;
      sky.setShadowFocus(eye.position.x, 0, eye.position.z);
      sky.update(hour);
      // the key light aimed at this act's Sun (the rig aims it from its own hour)
      sky.sunLight.position.copy(sky.sunLight.target.position).addScaledVector(sun, skyParams.sunDistance);
      // the lights from the air: the sunlight reaching the sea, the sky's irradiance (a little of it back off
      // the water below), the haze at the horizon
      seaSky.update(eye.position, sun);
      cu.time.value = t;
      cu.sun.value.copy(sun);
      const formed = d ? d.clouds : 1;
      // (they form as thin veils over most of their field and thicken: coverage rising from zero only pops
      // scattered lumps into the sky)
      cu.coverage.value = CLOUD_COVER * (0.4 + 0.6 * formed);
      cu.presence.value = formed;
      cu.cirrusCover.value = CIRRUS_COVER * formed;
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
      archipelago?.update(
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
      const turn = d ? DEBRIS_SPIN * d.driftTime : 0;
      raftNow.copy(raftInField).applyAxisAngle(UP, turn);
      raft.update(t, raftNow.x, raftNow.z, yaw - raftRight + Math.PI / 2 + RAFT_SHEER + turn - restTurn, {
        sun: lum(seaSky.sunColour),
        sky: Math.min(1, lum(seaSky.irradiance) / 0.4),
      });
      if (debris && d) {
        debris.rotation.y = turn;
        du.sun.value.copy(sun);
        du.sunLight.value.set(seaSky.sunColour.r, seaSky.sunColour.g, seaSky.sunColour.b).multiplyScalar(SUN_E / Math.PI);
        du.skyLight.value.set(seaSky.irradiance.r, seaSky.irradiance.g, seaSky.irradiance.b).multiplyScalar(1 / Math.PI);
      }
      proxy.position.copy(eye.position);
      proxy.updateMatrixWorld();
      reflection?.update(proxy, t);
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
