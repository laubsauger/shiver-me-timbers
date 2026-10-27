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
import { terrainParams } from '../../params/terrain';
import { vegetationParams } from '../../params/vegetation';
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
import { shadowTexelSize, snapShadowCenter } from '../../sky/shadowMath';
import { createCubeMirror } from './mirror';
import { DEBRIS_SPIN, clearOf, createDebrisField, debrisPieces, keepIf, matPieces, type DebrisUniforms } from '../getTheDrift/debrisField';
import { createProps } from './props';
import { createBeachTerrain } from './beachMaterial';
import { createScannedRocks } from './scannedRocks';
import { createPlants } from './plants';
import { createPalms } from './palms';
import { COAST_YAW, OPEN_AT, OPEN_YAW, beatStarts, beatSun, beatsAt, coastEye, coastLook, landfall, raftPose, sailsAt, spec, travelled, type BeatName, type RaftPose, type WorldName } from './beats';

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
/** rad: where the light air blows TOWARD (a heading: 0 +z, π −z) — every raft sails dead downwind along −z,
 * the open sea's and the coast's eye facing the same way (beats.ts) */
const WIND_TO = Math.PI;
/** the open sea's scattered debris (the flood's matter drifting apart): a Gaussian of `sigma` m centred behind
 * where the rig sets off, so the raft sails out of it; none in the lane the raft and the eye sail */
const OPEN_DEBRIS = { pieces: 2600, sigma: 220, behind: 90, lane: [-9, 15] as [number, number] };
/** px: each face of the water's mirror capture */
const MIRROR_SIZE = 512;
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
  /** resolves once its data (the clouds' noise, the flock's keys) is loaded */
  readonly ready: Promise<void>;
  /** the beats drawn at time t and their shares (two across a dissolve: beats.ts); the test act's one */
  passes(t: number): Array<{ beat: BeatName; weight: number }>;
  /** put the sea into the state of time t in `beat` (c1 if none) and the eye where it watches from */
  update(t: number, eye: THREE.Object3D, renderer: THREE.WebGPURenderer, beat?: BeatName): void;
  setPixelAngle(rad: number): void;
}

/** m: the coast's world, west of everything else (the islands kilometres from the flood's debris and the open
 * sea, so each world is alone in the far plane) */
const COAST_AT: [number, number] = [-40000, 0];
/** the far rafts of the open sea (c2–c4: "other rafts and small vessels far off on the horizon, each alone, all
 * drifting the same way"): deg right of the front, m away, rad their heading turns off ours */
const FAR_RAFTS: Array<[number, number, number]> = [
  [-48, 950, 0.2],
  [-12, 1750, -0.3],
  [21, 1250, 0.5],
  [58, 2100, 0.1],
  [118, 1500, -0.4],
];
/** THE ISLANDS FOR THE FILM, until they get real materials and plants (the game's are its painterly look):
 * the rock's posterized bands smoothed out, and the greens of the scrub and the palms darker and far less
 * saturated (authored bright yellow-green; under the low Sun and the sea's grade they read neon: the v6 notes) */
const FILM_TERRAIN = {
  rockBandSoftness: 1,
  vegBaseColor: 0x5e7442,
  vegShadeColor: 0x3e5030,
  vegDryColor: 0x958a5c,
  coverBaseColor: 0x55703d,
  coverTipColor: 0x6e8a49,
  coverDryColor: 0x958a5e,
};
const FILM_FRONDS = { frondColorDark: 0x2e4f2a, frondColorLight: 0x6a8a45 };
/** m: the shallows tint gone by this depth (the game's 18 m outlasted each island's square seabed grid, whose
 * edge then showed as a straight line in the water) */
const SHALLOWS = 6;
/** m: the beach strip kept clear of boulders (beats.ts COAST): either side of its middle, inland, out to sea */
const BEACH_CLEAR = { along: 60, inland: 25, out: 20 };
/** m: how far the logs' centreline rides over the sand once aground (their radius, about) */
const ON_SAND = 0.25;

/**
 * `drive`: Act 2 hands over (see SeaDrive) and c1 comes to rest by `c1End`, then the beats run on (beats.ts);
 * without it, the test act: `hour` held, `flock` flying, an island.
 */
export function createSea(
  renderer: THREE.WebGPURenderer,
  o: { hour?: number; flock?: boolean; total?: number; drive?: (t: number) => SeaDrive; c1End?: number } = {},
): SeaAct {
  const hour = o.hour ?? HOUR;
  const c1End = o.c1End ?? 0;
  const beats = beatStarts(c1End);
  const total = o.drive ? beats.total : (o.total ?? 60);
  const scene = new THREE.Scene();
  scene.name = 'drift-sea';
  // the sky retints it every update; the ocean melts into its colour at range
  scene.fog = new THREE.Fog(0xa1e7ff, 700, 4500);
  skyParams.timeOfDay = hour;
  // the sun's shadow map: twice the game's reach at the same texel (7.8 cm), so a low Sun's long shadows of the
  // island's hills and palms reach the beach instead of stopping at the map's edge 80 m out
  skyParams.shadowExtent = 160;
  skyParams.shadowMapSize = 4096;
  // the game's sky rig for its lights (the sun and the ambient the ocean and the raft are built to read); what
  // they are set to, and the sky itself, come from Act 2's air (seaSky.ts): one sky from orbit to sea
  const sky = createSky({ scene });
  scene.backgroundNode = null;
  // the sky is a sphere (seaSky.ts), which never forces a clear: a colour background does (the faces would
  // keep the last scene's colour and depth — with autoClear off, as the show renders)
  scene.background = new THREE.Color(0x000000);
  // where c1 comes to rest and which way it looks (the night sky is laid for it, the raft placed by it)
  const testSun = new THREE.Vector3(...sunDirection(hour, skyParams.latitude));
  const rest = o.drive?.(c1End);
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
  // what floats mirrored in the water: one cube capture from the eye mirrored under it (mirror.ts); the sky in
  // the water stays the ocean's analytic dome
  const mirror = createCubeMirror(MIRROR_SIZE, FAR);
  const afloat = new THREE.Group();
  afloat.name = 'drift-afloat';
  scene.add(afloat);
  let hemi: THREE.HemisphereLight | undefined;
  scene.traverse((x) => {
    if ((x as THREE.HemisphereLight).isHemisphereLight) hemi = x as THREE.HemisphereLight;
  });
  // no caustics bound in this page: neutral without the warning
  causticsParams.enabled = false;
  oceanSurfaceParams.radialLodPixels = 0;
  oceanSurfaceParams.shallowFullDepth = SHALLOWS;
  Object.assign(terrainParams, FILM_TERRAIN);
  Object.assign(vegetationParams, FILM_FRONDS);

  // THE ISLANDS: the test act's one, near the eye; the show's archipelago in the coast's world (w1–w5), the
  // game's own islands moved west by COAST_AT, its lagoon island the one we land on — their ground the scanned
  // PBR beach (beachMaterial.ts), not the game's painted one
  const beachTerrain = createBeachTerrain();
  let archipelago: ReturnType<typeof createArchipelago> | undefined;
  if (!o.drive) {
    const bearing = yaw + (ISLAND_LEFT_OF_SUN * Math.PI) / 180;
    const site = { ...generateIslandSites(SEED)[0], position: [-Math.sin(bearing) * ISLAND_DISTANCE, -Math.cos(bearing) * ISLAND_DISTANCE] as [number, number] };
    archipelago = createArchipelago({ seed: SEED, sites: [site], terrainHooks: beachTerrain.hooks });
  } else {
    const sites = generateIslandSites(SEED).map((s) => ({ ...s, position: [s.position[0] + COAST_AT[0], s.position[1] + COAST_AT[1]] as [number, number] }));
    archipelago = createArchipelago({ seed: SEED, sites, terrainHooks: beachTerrain.hooks });
  }
  afloat.add(archipelago.group);
  // the beach (beats.ts COAST): the lagoon island's shore straight west of its centre
  const lagoon = archipelago.islands[0];
  const beach = { x: lagoon.center[0], z: lagoon.center[1] };
  for (let r = 0; r < 400; r += 0.5) {
    if (lagoon.heightAt(lagoon.center[0] - r, lagoon.center[1]) < 0) {
      beach.x = lagoon.center[0] - r;
      break;
    }
  }
  const ground = (x: number, z: number): number => lagoon.heightAt(x, z);
  // the rocks: scanned stone at the game's own placements (scannedRocks.ts), none in the strip we land and walk
  // on (2–4 m of them strewn along the shore: the walk would run into them)
  const scannedRocks = createScannedRocks(archipelago, (x, z) => {
    if (!o.drive) return true;
    const along = beach.z - z;
    const off = beach.x - x;
    return !(Math.abs(along) < BEACH_CLEAR.along && off > -BEACH_CLEAR.inland && off < BEACH_CLEAR.out);
  });
  afloat.add(scannedRocks.group);
  // the plants: scanned ferns and broad leaves on the ground above our beach, in place of the game's cards and
  // palms (plants.ts) — from the palm line back (scattered over the open sand, backlit by the low Sun, they read
  // as litter in the v9 review)
  const plants = o.drive
    ? createPlants(archipelago, ground, { x0: beach.x + 16, x1: beach.x + 95, z0: beach.z - 110, z1: beach.z + 110 }, { minH: 1.4, maxH: 9, maxSlope: 0.45 })
    : undefined;
  if (plants) afloat.add(plants.group);
  const palms = o.drive ? createPalms(beach, ground) : undefined;
  if (palms) afloat.add(palms.group);

  // a calm sea, near glass (the v6 notes; the game's default is a working sea, Hs ~2.8 m): the game's glass
  // preset with a light air's ripples (RIPPLE) over a long low ground swell (direction.md: the swell lifts and
  // sets the raft down). Set before the spectrum is built, never changed during the act
  Object.assign(oceanParams, weatherPresets.glass.ocean, RIPPLE, { swellAmplitude: SWELL_RMS, swellPeriod: SWELL_PERIOD, windDirection: WIND_TO });
  const ocean = createOceanSim(SEED);
  const surface = new OceanSurface(ocean, undefined, undefined, {
    reflection: mirror.reflection,
    sunLight: sky.sunLight,
    skyDomeColor: seaSky.dome,
    skySunTerm: seaSky.sunTerm,
    seabed: archipelago.seabed,
    // the dome's cube target is half-float, as the game's HDR scene target
    hdrSceneTarget: true,
  });
  scene.add(surface.group);
  surface.group.traverse((x) => {
    if ((x as THREE.Mesh).isMesh) x.receiveShadow = true;
  });
  const cpu = new CpuOcean(SEED, oceanParams, { ...raftSeaParams, updateEveryTicks: 0 }, ocean.spectrum);
  // a raft floats on the sea, or rests on the sand once aground (w2)
  const floating = (x: number, z: number, t: number): number => Math.max(cpu.heightAt(x, z, t), ground(x, z) + ON_SAND);
  // the raft, off the Sun's bearing from where the eye comes to rest, its bow turned off the eye's heading
  const raft = createRaft(floating);
  afloat.add(raft.group);
  const restSun = rest ? rest.sun : testSun;
  const sunRight = Math.atan2(restSun.dot(right), restSun.dot(front));
  const raftRight = sunRight - Math.sign(sunRight || -1) * ((RAFT_OFF_SUN * Math.PI) / 180);
  const raftAt = restAt.clone().addScaledVector(front, Math.cos(raftRight) * RAFT_DISTANCE).addScaledVector(right, Math.sin(raftRight) * RAFT_DISTANCE);
  // it floats in the field and turns with it (DEBRIS_SPIN: the current the eye follows, timeline.ts), so it is
  // where `raftAt` says when c1 ends, and at a fixed place in the field's own frame
  const UP = new THREE.Vector3(0, 1, 0);
  const restTurn = rest ? DEBRIS_SPIN * rest.driftTime : 0;
  const raftInField = raftAt.clone().applyAxisAngle(UP, -restTurn);
  const raftNow = new THREE.Vector3();
  // c1's rest, as the pose of the raft against the eye that every later beat moves on from (beats.ts)
  const restPose: RaftPose = {
    bearing: raftRight,
    distance: RAFT_DISTANCE,
    heading: -raftRight - Math.PI / 2 + RAFT_SHEER,
    height: rest ? rest.eye.y : EYE_HEIGHT,
  };

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
    afloat.add(debris);
    debris.add(createDebrisField(berth(matPieces(raftInField.x, raftInField.z, MAT_SIGMA, MAT_PIECES)), du as unknown as DebrisUniforms));
  }
  // the open sea's scattered debris, and its far rafts
  const openDebris = o.drive
    ? createDebrisField(
        keepIf(matPieces(OPEN_AT[0], OPEN_AT[1] + OPEN_DEBRIS.behind, OPEN_DEBRIS.sigma, OPEN_DEBRIS.pieces, 2102), (x, _z, len) => x - OPEN_AT[0] + len / 2 < OPEN_DEBRIS.lane[0] || x - OPEN_AT[0] - len / 2 > OPEN_DEBRIS.lane[1]),
        du as unknown as DebrisUniforms,
      )
    : undefined;
  if (openDebris) afloat.add(openDebris);
  const farRafts = o.drive ? FAR_RAFTS.map(() => createRaft(floating)) : [];
  for (const r of farRafts) afloat.add(r.group);
  // the people, the dolphin and the case, the beams, the field, the walkers (props.ts)
  const props = o.drive ? createProps() : undefined;
  if (props) afloat.add(props.group);
  const fieldEye = new THREE.Vector3();
  if (o.drive) {
    const at = coastEye(beats.starts.w3 + 25, c1End, beach);
    fieldEye.set(at.x, Math.max(0, ground(at.x, at.z)) + at.height, at.z);
  }

  // the sandpipers (W4), startled FLOCK_START s into the test act; the bake's front turned to the dome's front
  const flockData = loadFlock();
  const fu = {
    time: uniform(0),
    origin: uniform(new THREE.Vector3(0, 0, 0)),
    basis: uniform(new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationY(o.drive ? COAST_YAW : yaw))),
    sun: uniform(new THREE.Vector3()),
    eye: uniform(new THREE.Vector3()),
    pixelAngle: uniform(0.0015),
    presence: uniform(1),
    sunLight: uniform(new THREE.Vector3()),
    skyLight: uniform(new THREE.Vector3()),
  };
  if (o.drive) {
    // w4: the audience stands on the beach (beats.ts), the waterline across the view ahead
    const at = coastEye(beats.starts.w4, c1End, beach);
    fu.origin.value.set(at.x, 0, at.z);
  }
  // (its shader bakes the key count in: built once the keys are loaded)
  let flock: THREE.Object3D | undefined;
  const ready =
    o.flock === false
      ? Promise.resolve()
      : flockData.ready.then(() => {
          flock = createFlock(flockData, fu as unknown as FlockUniforms);
          flock.frustumCulled = false;
          scene.add(flock);
        });

  // the surface reads one camera: a proxy at the eye with the faces' field and far plane
  const proxy = new THREE.PerspectiveCamera(90, 1, 0.05, FAR);
  const windDir: [number, number] = [Math.cos(oceanParams.windDirection), Math.sin(oceanParams.windDirection)];
  const sun = new THREE.Vector3();
  const lum = (c: THREE.Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const v = new THREE.Vector3();
  /** a direction `bearing` rad right of a front turned `turn` rad about y */
  const across = (turn: number, bearing: number, out: THREE.Vector3): THREE.Vector3 => out.set(Math.sin(bearing), 0, -Math.cos(bearing)).applyAxisAngle(UP, turn);
  const smooth01 = (x: number): number => {
    const k = Math.min(1, Math.max(0, x));
    return k * k * (3 - 2 * k);
  };

  return {
    scene,
    far: FAR,
    total,
    get exposure() {
      return seaSky.exposure;
    },
    ready: Promise.all([ready, cloudData.ready, beachTerrain.ready, scannedRocks.ready, plants?.ready, palms?.ready]).then(() => undefined),
    passes(t) {
      return o.drive ? beatsAt(t, c1End).map((p) => ({ beat: p.name, weight: p.weight })) : [{ beat: 'c1', weight: 1 }];
    },
    setPixelAngle(rad) {
      fu.pixelAngle.value = rad;
      du.pixelAngle.value = rad;
      props?.setPixelAngle(rad);
    },
    update(t, eye, renderer, beat = 'c1') {
      const d = o.drive && beat === 'c1' ? o.drive(t) : undefined;
      const b = beat === 'c1' ? undefined : spec(beat);
      const world: WorldName | 'test' = !o.drive ? 'test' : b ? b.world : 'flood';
      // WHERE THE EYE AND THE RAFT ARE, and the Sun
      let raftX = 0;
      let raftZ = 0;
      let raftHeading = 0;
      let eyeYaw = yaw;
      const turn = d ? DEBRIS_SPIN * d.driftTime : 0;
      let sails = 0;
      let speed = 0;
      if (!o.drive) {
        eye.position.set(0, EYE_HEIGHT, 0);
        eye.rotation.set(0, yaw, 0);
        sun.copy(testSun);
        raftX = raftAt.x;
        raftZ = raftAt.z;
        raftHeading = yaw - raftRight + Math.PI / 2 + RAFT_SHEER;
      } else if (d) {
        // c1: Act 2's landing, the raft drifting with the debris galaxy
        eye.position.copy(d.eye);
        eye.quaternion.copy(d.turn);
        sun.copy(d.sun);
        raftNow.copy(raftInField).applyAxisAngle(UP, turn);
        raftX = raftNow.x;
        raftZ = raftNow.z;
        // (its bow swings round to the front through the follow: beats.ts raftPose)
        raftHeading = yaw + raftPose(t, c1End, restPose).heading + Math.PI + turn - restTurn;
      } else {
        const pose = raftPose(t, c1End, restPose);
        if (world === 'open') {
          // the open sea: the rig sails on downwind (−z) at the raft's speed (beats.ts travelled)
          eyeYaw = OPEN_YAW;
          eye.position.set(OPEN_AT[0], pose.height, OPEN_AT[1] - travelled(beats.starts.c2 - 6, t, c1End));
        } else {
          // the coast: along it, in to the beach, ashore (beats.ts coastEye)
          eyeYaw = COAST_YAW;
          const c = coastEye(t, c1End, beach);
          const ashoreY = Math.max(ground(c.x, c.z), 0) + c.height;
          eye.position.set(c.x, pose.height + (ashoreY - pose.height) * c.ashore, c.z);
        }
        // (on the coast the eye looks round toward the land through the landfall; the world, the Sun with it,
        // stays laid out by eyeYaw)
        eye.rotation.set(0, eyeYaw + (world === 'coast' ? coastLook(t, c1End) : 0), 0);
        across(eyeYaw, pose.bearing, v);
        raftX = eye.position.x + v.x * pose.distance;
        raftZ = eye.position.z + v.z * pose.distance;
        raftHeading = eyeYaw + pose.heading + Math.PI;
        sails = sailsAt(beat, t, c1End);
        speed = travelled(t - 0.5, t + 0.5, c1End);
        if (world === 'coast' && t > beats.starts.w2) {
          // w2: it runs in under sail, bow first, and grounds in the shallows while the eye goes ashore
          const at = coastEye(beats.starts.w2, c1End, beach);
          const p0 = raftPose(beats.starts.w2, c1End, restPose);
          across(eyeYaw, p0.bearing, v);
          const from = { x: at.x + v.x * p0.distance, z: at.z + v.z * p0.distance };
          const run = landfall(t, c1End, from, beach);
          const a = landfall(t - 0.5, c1End, from, beach);
          const b = landfall(t + 0.5, c1End, from, beach);
          raftX = run.x;
          raftZ = run.z;
          raftHeading = run.heading;
          speed = Math.hypot(b.x - a.x, b.z - a.z);
        }
        sun.set(...beatSun(beat, t, c1End)).applyAxisAngle(UP, eyeYaw);
      }
      eye.updateMatrixWorld();
      // what each world holds
      if (debris) debris.visible = world === 'flood';
      for (const r of farRafts) r.group.visible = world === 'open';
      archipelago.group.visible = world === 'coast' || world === 'test';
      scannedRocks.group.visible = archipelago.group.visible;
      if (plants) plants.group.visible = archipelago.group.visible;
      if (palms) palms.group.visible = archipelago.group.visible;
      const flockT = o.drive ? t - beats.starts.w4 - 2 : t - FLOCK_START;
      if (flock) flock.visible = world === 'test' || (world === 'coast' && flockT > -1);

      skyParams.timeOfDay = hour;
      sky.setShadowFocus(eye.position.x, 0, eye.position.z);
      sky.update(hour);
      // the key light aimed at this act's Sun (the rig aims it from its own hour), its frustum centre snapped to
      // whole shadow texels in THIS Sun's basis (the rig snapped it in its own: kept, every shadow edge crawls
      // as the eye moves)
      const texel = shadowTexelSize(skyParams.shadowExtent, sky.sunLight.shadow.mapSize.x);
      const [sx, sy, sz] = snapShadowCenter([eye.position.x, 0, eye.position.z], [sun.x, sun.y, sun.z], texel);
      sky.sunLight.target.position.set(sx, sy, sz);
      sky.sunLight.position.set(sx, sy, sz).addScaledVector(sun, skyParams.sunDistance);
      // the lights from the air: the sunlight reaching the sea, the sky's irradiance (a little of it back off
      // the water below), the haze at the horizon
      seaSky.update(eye.position, sun);
      cu.time.value = t;
      cu.sun.value.copy(sun);
      // c1's clouds form as thin veils over most of their field and thicken (coverage rising from zero only
      // pops scattered lumps into the sky); each later beat has its own sky
      const formed = d ? d.clouds : 1;
      cu.coverage.value = b ? b.cover : CLOUD_COVER * (0.4 + 0.6 * formed);
      cu.presence.value = formed;
      cu.cirrusCover.value = b ? b.cirrus : CIRRUS_COVER * formed;
      const atCloud = (h: number, out: THREE.Vector3): void => {
        const c = sunlightCpu(EARTH_R + h * 1e-6, sun.y);
        out.set(c[0], c[1], c[2]).multiplyScalar(SUN_E / Math.PI);
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
      if (archipelago.group.visible) {
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
      }
      const light = { sun: lum(seaSky.sunColour), sky: Math.min(1, lum(seaSky.irradiance) / 0.4) };
      raft.update(t, raftX, raftZ, raftHeading, light, sails, speed);
      if (world === 'open') {
        FAR_RAFTS.forEach(([bearing, distance, off], i) => {
          across(eyeYaw, (bearing * Math.PI) / 180, v);
          farRafts[i].update(t, eye.position.x + v.x * distance, eye.position.z + v.z * distance, raftHeading + off * 0.3, light, sails, speed);
        });
      }
      if (props) {
        props.update({
          t,
          starts: beats.starts,
          world,
          eye: eye.position,
          yaw: eyeYaw,
          raft: raft.group,
          beach,
          night: 1 - smooth01((sun.y + 0.1) / 0.12),
          fieldEye,
          ground,
        });
      }
      if (openDebris) openDebris.visible = world === 'open';
      if (debris) {
        debris.rotation.y = turn;
        du.sun.value.copy(sun);
        du.sunLight.value.set(seaSky.sunColour.r, seaSky.sunColour.g, seaSky.sunColour.b).multiplyScalar(SUN_E / Math.PI);
        du.skyLight.value.set(seaSky.irradiance.r, seaSky.irradiance.g, seaSky.irradiance.b).multiplyScalar(1 / Math.PI);
      }
      proxy.position.copy(eye.position);
      proxy.updateMatrixWorld();
      surface.update(proxy, t, sun);
      // (on the coast, the islands' ground, rocks and low plants stay out of it: unclipped, the seabed above the
      // mirrored eye would hide the sky the shallows reflect; the palms, the raft and the people are mirrored)
      const underwater = world === 'coast' ? [archipelago.group, scannedRocks.group, ...(plants ? [plants.group] : [])] : [];
      mirror.update(renderer, scene, eye.position, [surface.group, seaSky.mesh, ...underwater, ...(props ? props.glows : [])]);
      fu.time.value = flockT;
      fu.sun.value.copy(sun);
      // radiance of a white surface: the Sun's E·T/π facing it, the sky's irradiance/π
      fu.sunLight.value.set(seaSky.sunColour.r, seaSky.sunColour.g, seaSky.sunColour.b).multiplyScalar(SUN_E / Math.PI);
      fu.skyLight.value.set(seaSky.irradiance.r, seaSky.irradiance.g, seaSky.irradiance.b).multiplyScalar(1 / Math.PI);
      fu.eye.value.copy(eye.position);
    },
  };
}
