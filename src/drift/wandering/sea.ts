/**
 * The Drift at sea level (drift-narrative/wandering-on/direction.md, "Engine plan"): the game's own sea — its
 * FFT ocean, its sky and one island — in a scene of its own, drawn through the dome capture. A TEST ACT
 * (`drift.html?sea`) before Part C and Act 3 are built on it: it proves the sea renders through six cube faces
 * and that every frame is a pure function of show time, in any order.
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
import { createSky } from '../../sky';
import { skyParams } from '../../params/sky';
import { createOceanSim, oceanParams } from '../../ocean';
import { OceanSurface } from '../../ocean/oceanSurface';
import { oceanSurfaceParams } from '../../params/oceanSurface';
import { causticsParams } from '../../params/caustics';
import { createArchipelago, generateIslandSites } from '../../island/archipelago';
import { CpuOcean } from '../../sea-physics/cpuOcean';
import { raftSeaParams } from '../../params/seaPhysics';

/** the game's world seed (Raft 2100) */
const SEED = 2100;
/** m above the mean sea: just above a raft's deck */
const EYE_HEIGHT = 3;
/** golden hour (sunCycle.ts: ~14° up in the west at latitude 15) */
const HOUR = 17.5;
/** m, the face cameras' far plane: past the sea's rim (~4.6 km), short enough for the depth precision the
 * ocean's refraction thickness reads */
const FAR = 12000;
/** the island: m away, and deg to the left of the sun */
const ISLAND_DISTANCE = 650;
const ISLAND_LEFT_OF_SUN = 35;

export interface SeaAct {
  readonly scene: THREE.Scene;
  readonly far: number;
  /** s, the test act's length */
  readonly total: number;
  /** the tone map's exposure (ACES, as the game's skyParams.exposure) */
  readonly exposure: number;
  /** put the sea into the state of time t and the eye where it watches from */
  update(t: number, eye: THREE.Object3D, renderer: THREE.WebGPURenderer): void;
}

export function createSea(): SeaAct {
  const scene = new THREE.Scene();
  scene.name = 'drift-sea';
  // the sky retints it every update; the ocean and the island melt into its colour at range
  scene.fog = new THREE.Fog(0xa1e7ff, 700, 4500);
  skyParams.timeOfDay = HOUR;
  const sky = createSky({ scene });
  // the sky's shading takes its view ray as world position minus camera position, which holds only on a
  // sphere centred on the camera; three r186 draws `scene.backgroundNode` on a unit sphere at the world
  // ORIGIN, so from the eye every ray pointed the same way and the sky came out one flat colour. Drawn here
  // on a sphere that follows the eye instead
  const skyMaterial = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
  skyMaterial.colorNode = scene.backgroundNode as THREE.Node<'vec3'>;
  scene.backgroundNode = null;
  const skyDome = new THREE.Mesh(new THREE.SphereGeometry(FAR * 0.8, 64, 32), skyMaterial);
  skyDome.renderOrder = -1;
  skyDome.frustumCulled = false;
  scene.add(skyDome);
  // no caustics bound in this page: neutral without the warning
  causticsParams.enabled = false;
  oceanSurfaceParams.radialLodPixels = 0;

  const sun = sky.sunDirection.clone();
  // the dome's front toward the sun's bearing
  const yaw = Math.atan2(-sun.x, -sun.z);
  const bearing = yaw + (ISLAND_LEFT_OF_SUN * Math.PI) / 180;
  const site = { ...generateIslandSites(SEED)[0], position: [-Math.sin(bearing) * ISLAND_DISTANCE, -Math.cos(bearing) * ISLAND_DISTANCE] as [number, number] };
  const archipelago = createArchipelago({ seed: SEED, sites: [site] });
  scene.add(archipelago.group);

  const ocean = createOceanSim(SEED);
  const surface = new OceanSurface(ocean, undefined, undefined, {
    sunLight: sky.sunLight,
    skyDomeColor: sky.skyDomeColor,
    skySunTerm: sky.skySunTerm,
    seabed: archipelago.seabed,
    // the dome's cube target is half-float, as the game's HDR scene target
    hdrSceneTarget: true,
  });
  scene.add(surface.group);
  surface.group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.receiveShadow = true;
  });
  const cpu = new CpuOcean(SEED, oceanParams, { ...raftSeaParams, updateEveryTicks: 0 }, ocean.spectrum);

  // the surface reads one camera: a proxy at the eye with the faces' field and far plane
  const proxy = new THREE.PerspectiveCamera(90, 1, 0.05, FAR);
  const windDir: [number, number] = [Math.cos(oceanParams.windDirection), Math.sin(oceanParams.windDirection)];

  return {
    scene,
    far: FAR,
    total: 60,
    exposure: skyParams.exposure,
    update(t, eye, renderer) {
      eye.position.set(0, EYE_HEIGHT, 0);
      eye.rotation.set(0, yaw, 0);
      eye.updateMatrixWorld();
      skyDome.position.copy(eye.position);
      skyParams.timeOfDay = HOUR;
      sky.setShadowFocus(0, 0, 0);
      sky.update(HOUR);
      ocean.update(renderer, t);
      archipelago.update(
        {
          time: t,
          windDir,
          windStrength: 0.4,
          swell: ocean.heightRms * 2,
          sunDirection: sky.sunDirection,
          hazeColor: (scene.fog as THREE.Fog).color,
          cameraPosition: eye.position,
        },
        (x, z) => cpu.heightAt(x, z, t),
      );
      proxy.position.copy(eye.position);
      proxy.updateMatrixWorld();
      surface.update(proxy, t, sky.sunDirection);
    },
  };
}
