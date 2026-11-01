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
 *   - the raft's wake (the game's analytic one: bow mound, Kelvin crests, foam lane, glassy slick) does carry
 *     state, so it is REPLAYED: from a fixed start in each world (the follow; the coast's first dissolve), on a
 *     fixed step grid, stepped on from the state held for any forward jump and replayed from the start only on a jump
 *     back or into another world — `wakeTo`;
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
import { Fn, cameraPosition, float, normalize, positionWorld, smoothstep, texture, uniform, vec3 } from 'three/tsl';
import { createSky } from '../../sky';
import { skyParams } from '../../params/sky';
import { createOceanSim, oceanParams } from '../../ocean';
import { OceanSurface } from '../../ocean/oceanSurface';
import { createFlowFoam, type FlowFoam } from '../../flowfoam';
import { createHullContact, type HullContact } from '../../flowfoam/hullContact';
import { flowFoamParams, type FlowFoamParams } from '../../params/flowfoam';
import { raftWakeParams } from '../../params/raftSailing';
import { oceanSurfaceParams } from '../../params/oceanSurface';
import { terrainParams } from '../../params/terrain';
import { vegetationParams } from '../../params/vegetation';
import { causticsParams } from '../../params/caustics';
import { createArchipelago, generateIslandSites } from '../../island/archipelago';
import type { SeabedField } from '../../island/seabed';
import { CpuOcean } from '../../sea-physics/cpuOcean';
import { raftSeaParams } from '../../params/seaPhysics';
import { weatherPresets } from '../../weather/presets';
import { createFlock, loadFlock, type FlockUniforms } from './flock';
import { createSeaSky, sunlightCpu } from './seaSky';
import { bakeNightSky } from './nightSky';
import { createRaft, raftLogsInPlan } from './raft';
import { CIRRUS_H, CLOUD_BASE, CLOUD_TOP, loadClouds, type CloudUniforms } from './clouds';
import { EARTH_R, SUN_E } from '../getTheDrift/atmosphere';
import { sunDirection } from '../../sky/sunCycle';
import { shadowTexelSize, snapShadowCenter } from '../../sky/shadowMath';
import { createCubeMirror } from './mirror';
import { DEBRIS_SPIN, clearOf, createDebrisField, debrisPieces, matPieces, thingsAt, type DebrisLook, type DebrisUniforms } from '../getTheDrift/debrisField';
import { createProps } from './props';
import { DOLPHIN_SPAN, dolphinSplashes } from './dolphin';
import { createSplashes } from './splash';
import { createBeachTerrain } from './beachMaterial';
import { createScannedRocks } from './scannedRocks';
import { createFilmCoast, type FilmCoast } from './coast';
import { createForest, createForestGround, litterMask, type Forest } from './forest';
import { bindSwashToSea, createShoreline, swashLight } from './shoreline';
import { createSwashSim, swashSeaGone, type SwashSim } from './swashSim';
import { filmShadowFilter } from './filmShadowFilter';
import { createGroundDebris, type GroundDebris } from './groundDebris';
import { SAND_ALBEDO, createBeachDressing, type BeachDressing } from './beachDressing';
import { createPlants } from './plants';
import { createPalms, palmFeet } from './palms';
import { FAR_RAFTS, createFarCraft, createFarCraftLook, createFarLantern, farRaftsIn } from './farRafts';
import { lanternNight } from '../../ship/raftLanterns';
import { nightStep } from './radioTower';
import { createDrownedShallows, createSeaPowerLine } from './drowned';
import { C1_FOLLOW, COAST_YAW, airAt, beatSky, beatStarts, beatSun, beatsAt, coastEye, coastLook, landfall, raftPose, sailsAt, spec, speedAt, travelled, type BeatName, type BeatSpec, type RaftPose, type WorldName } from './beats';

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
/** the sea: a light breeze's ripples (between the game's glass and calm presets: glass read too glassy, calm
 * bobbed), over a ground swell: m RMS (its Hs is 4×), s. (A light air's — 2.5 m/s, 0.15, a 0.08 m swell — still
 * mirrored the clouds whole at the shore and came in flat on the approach: "awfully static", the 2026-10-29 review) */
const RIPPLE = { amplitude: 0.28, windSpeed: 4, choppiness: 0.8 };
const SWELL_RMS = 0.13;
/** rad: where the light air blows TOWARD (a heading: 0 +z, π −z) — every raft sails dead downwind along −z,
 * the open sea's and the coast's eye facing the same way (beats.ts) */
const WIND_TO = Math.PI;
/** s: the wake's step (the film's frame). The wake's state only ever stands ON THIS GRID from its world's start
 * (`wakeTo`), so a frame reached by stepping on and one replayed from the start see the same state, bit for bit */
const WAKE_DT = 1 / 30;
/** m/s: the water's slow drift with the light air (what the wake rides besides the flood's current at sea) */
const WATER_DRIFT = 0.05;
/**
 * THE RAFT'S WATER (the user, 2026-10-29: the raft "doesn't really cause a wake or any kind of displacement… floating
 * in a completely unimpressed liquid"; of the game wake's trail at raft scale, "way too stripey… super subtle… a weird
 * painted-on, almost oil-trail look"). The game's analytic wake is a ship's: at the raft's 0.2–1.9 m/s (Fr ≈ 0.1) its
 * Kelvin trains are sub-metre parallel stripes, its arms and cut thin lines, its stern churn and slick lane a smooth
 * band of tint and gloss — all of it OFF here. In its place the raft's own near field (flowfoam/hullContact.ts), all
 * shape and surface but one white collar: the water riding up and slapping on the logs, white only where it slaps,
 * the bow heap and the trough alongside, short rings off the logs, a stern wash, and the water churned alongside and
 * astern — its normal broken up so the sky's mirror and the glitter shatter — over a broad band stirred by eddies shed
 * off the stern corners, its surface heaved into lumps and boils, and the water pushed aside in waves launched along the
 * track — all of it astern DEPOSITED where the raft was and left in the world (hullContact.ts). On flowFoamParams (this page's own: no game page
 * builds the film): the near tier 96 m for 0.19 m texels, its centre WAKE_ASTERN m astern of the raft so the
 * trail's shape reaches ~65 m (a minute at sea speed) before the coarse tier, which carries no shape, takes over; the
 * foam short-lived and barely diffused (the slaps' white water
 * goes in seconds; a long-lived, spreading collar became a 14 m tinted swath), no base drift astern (the water stays
 * where it is: the wake is left in it, not carried off on a conveyor), the ambient curl gentler.
 */
const FILM_WAKE_WHITE = '#dfe9e6';
/** s: the near tier is centred where the raft was this long ago — on its own PATH, ~18 m astern at the landing's speed.
 * (It was centred 18 m astern along the raft's CURRENT heading: as the raft turned in to the beach its older wake fell
 * out of the detailed tier on one side, to the coarse tier's flat slick — "to the left it gets kind of pushed away,
 * flattened out", the 2026-10-30 review of 545 s) */
const WAKE_BEHIND_S = 10;
const FILM_WAKE: Partial<FlowFoamParams> = {
  regionSize: 96,
  // (the foam: the logs' slaps at rest, the bow's curl, the aerated clumps astern and the eddies' rings — bubbles that
  // last seconds; drawn as water turned milky under the surface, oceanSurfaceParams.wakeAeration, so thin coverage
  // never goes through the lace art that drew it as hair-fine streaks)
  // (7 s: the turbulent wake's patches last tens of seconds, swirled by the eddies, fading)
  decayHalfLife: 7,
  // (the wake scar, hullContact.ts `laneSlick`: the glassy lane lasts a minute or two; inside it the fine ripples are
  // all but gone, and the middle cascade's mostly — oceanSurfaceParams.wakeSmoothLong)
  slickHalfLife: 60,
  slickDamp: 0.9,
  // (little diffusion: the wake scar widens slowly — σ 1.5 m in a minute — its edges eaten by the eddies; at 0.5 m/√s
  // the lane had spread to three raft-widths 30 m astern)
  blurSpread: 0.2,
  // (the contact line's reach along the view, ocean surfaceMaterial `contactFoamNode`: at the game's 0.35 m it was a
  // grey veil over the whole submerged face of every log end — "very grey-bright", the user, 2026-10-29 — where the
  // water meets wood in a line a few centimetres wide)
  depthThreshold: 0.05,
  // (the water's own slow drift, along the light air — not astern of the raft: what it leaves stays where it was left)
  baseFlowSpeed: 0.05,
  // (the ambient curl gentle and NOT scaled up by the foam it carries: the game's churn, ×(1 + 1.8·foam) on a strength of
  // 3, ran ~0.8 m/s in the trail and drew every bubble clump out into long parallel filaments within seconds — the
  // last of the "stripey stuff", found by switching the clumps off, 2026-10-29. The swirl is the shed eddies')
  noiseStrength: 1,
  wakeChurn: 0,
  bowIntensity: 0,
  cutIntensity: 0,
  shoulderIntensity: 0,
  sternIntensity: 0,
  vortexIntensity: 0,
  moundIntensity: 0,
  slickIntensity: 0,
  transSlope: 0,
  divSlope: 0,
  eddySlope: 0,
  moundSlope: 0,
};
/** px: each face of the water's mirror capture */
const MIRROR_SIZE = 1024; // (was 512: 0.18° texels, 7–8 px of a 16:9 review — the blocky lagoon, mirror.ts)
/** CPU oceans kept, one per instant, least recently used out: the rafts sample the sea at 5 instants 0.3 s apart
 * (raft.ts SAMPLES, SETTLE: centred, t ± 0.6 s), which at 30 fps are the instants of the frames 18 and 9 ahead and 9
 * and 18 back — kept, each frame computes one new sea, not five. Until they are reached, 5 a frame are new, so the pool must outlast 9 frames of
 * them (45): at 40 it never warmed (~2 MB each) */
const SEA_POOL = 64;
/** s: the grid the sea's instants are keyed (and computed) on, so the same instant reached from two frames, or
 * from two lanes, is one key and one value */
const SEA_QUANTUM = 1e-4;
/** s: the ground swell's period (14 s, ~300 m long, held the raft all but still: "awfully static", the v9 review;
 * 10 s is ~155 m, the raft seen to lift and settle without bouncing) */
const SWELL_PERIOD = 10;
/** setting sail in c1's follow: s into it the sail is hoisted over, s it gathers way over, m/s it makes then
 * (beats.ts speedAt: c2's) */
const HOIST: [number, number] = [2, 9];
const WAY: [number, number] = [7, 16];
const COURSE_SPEED = 1.2;
/** the time-lapse that brings the landing's Sun down to c2's: s into the follow it runs over (from the hoist
 * to well into c2), and how many times faster the clouds go at its middle */
const LAPSE: [number, number] = [3, 40];
const LAPSE_CLOUDS = 6;
/** m: the mat of debris round the raft (a Gaussian's sigma: it thins into the field) and its pieces; the berth
 * kept clear round the raft (its logs reach 6.9 m from its centre) */
const MAT_SIGMA = 90;
const MAT_PIECES = 6000;
const RAFT_BERTH = 7.5;
/** the people's things set where the eye will be (debrisField.ts thingsAt): m ahead of and right of where it comes to
 * rest, in front and low in the dome; and one every THINGS_LANE_EVERY s of the raft's way, THINGS_LANE_OFF m to
 * alternate sides of it (off its berth) */
const THINGS_AT_REST: Array<[number, number]> = [[9, -4], [12, 3], [16, -9], [21, 7], [26, -2]];
const THINGS_LANE_EVERY = 6;
const THINGS_LANE_OFF = 11;

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
  /** the raft's wake (flowfoam: its look is flowFoamParams, live) */
  readonly wake: FlowFoam;
  /** the raft's own water round it and astern (flowfoam/hullContact.ts: its `params` are live) */
  readonly raftWater: HullContact;
  /** REVIEW ONLY (the drift review scripts' chase and aimed eyes): moves the eye once update has placed it and the
   * raft, before anything reads the eye (the sky's shadow focus, the surface's grid, the mirror's capture) — an eye
   * moved after update kept the show eye's mirror, its reflections metres off */
  reviewEye?: (eye: THREE.Object3D, raft: { x: number; z: number; heading: number }) => void;
  /**
   * ACT 2'S DESCENT BEFORE THE HAND-OVER (driven only; main-drift.ts): the sea's own cloud field laid over Act 2's sky,
   * so the clouds the sea's scene shows are already in the sky as the descent comes down to it (the 2026-10-30 review of
   * the final render: "we go from titanium sky to clouds"). `mesh` goes into Act 2's scene (a sphere round its eye,
   * drawn over its air); `update` puts the clouds in their state at sea time t (negative before the hand-over) for
   * Act 2's eye (world) and its frame's turn into the field's (`toField`: world → x east, y up, z north)
   */
  readonly descentSky?: { mesh: THREE.Mesh; update(t: number, renderer: THREE.WebGPURenderer, eyeWorld: THREE.Vector3, toField: THREE.Quaternion): void };
  /** REVIEW ONLY: the sea the rafts float on (the CpuOcean pool) and the ground, at (x, z) and sea time t */
  probeWater(x: number, z: number, t: number): { sea: number; ground: number };
  /** REVIEW ONLY: the raft as the wake is shed from it at sea time t in a world (x, z m; heading rad; speed m/s) */
  probeRaft(t: number, world: 'sea' | 'coast'): { x: number; z: number; heading: number; speed: number };
}

/** m: the coast's world, west of everything else (the islands kilometres from the flood's debris and the open
 * sea, so each world is alone in the far plane) */
const COAST_AT: [number, number] = [-40000, 0];
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
  // THE LAPPING AT THE WATERLINE (the user, 2026-10-29: "a super sharp line between the water … no lapping waves,
  // no foam"): the game's swash (terrain/shoreRunup.ts) scaled itself by the sea's swell, and a near-glass sea
  // starved it to half-height tongues no one could see. A lagoon's own: small waves every 6–7 s running 10–50 cm
  // of rise up the 1:11 face (1–5 m of sand), whatever the swell, a narrow lace of foam on their edge
  runupSwellResponse: 0,
  runupHeightMin: 0.1,
  runupHeightMax: 0.5,
  runupPeriod: 6.5,
  swashFoamWidth: 0.07,
  swashFoamStrength: 1,
  swashResidualStrength: 0.6,
  swashFoamNoiseScale: 1.4,
  // (the waves arrive a little staggered along the shore: a front 100 m and more long, its timing drifting along it.
  // At 0.05 (a 20 m phase field) the fronts broke into a few-metre lobes lapping in out of step — "tink tink tink,
  // as if three-metre-wide waves were coming in", the 2026-10-29 review)
  runupPhaseScale: 0.009,
};
const FILM_FRONDS = { frondColorDark: 0x2e4f2a, frondColorLight: 0x6a8a45 };
/**
 * THE SEA'S OWN COLOUR, per world (the user, 2026-10-29: from the flight to the raft the water "goes from blue to
 * very turquoise"). The game's water is its Sea of Thieves teal (deep #093642, crests #32d0c0) everywhere; the
 * landing's sea, seen from the air, is the Earth's deep blue, and the 3 s hand-over swapped one for the other.
 * Open ocean is blue (references §14.2–3: #182465 looking down by a raft, #204f77 mid-distance, #3f648a toward the
 * horizon), so the open sea takes those: a deep ultramarine body and blue-cyan light through its crests. Turquoise
 * is the lagoon's, over sand (the shallows tint) — its deep water teal-blue (§12.1: #40737e far, a deep channel
 * #6b9bc0, §12.3).
 */
const SEA_COLOUR: Record<'open' | 'coast', { deepColor: string; sssColor: string; sssMaxMix: number; contactFoamStrength: number }> = {
  // (the crests' light dimmer and capped lower on the open sea: facing a low Sun the lobe covers the whole sea
  // toward it, and in a bright blue it read as electric patches — the first try, #2f8fbf at the game's 0.45)
  // (and the thin line of bubbles where the water meets the logs and the debris, drawn white now (FILM_WAKE_WHITE),
  // so faint: at 0.7 it was a glowing grey band round every log — the user, 2026-10-29; the white is the slaps',
  // hullContact.ts)
  open: { deepColor: '#14253a', sssColor: '#24708c', sssMaxMix: 0.25, contactFoamStrength: 0.04 }, // (0.2 drew a grey-green outline round every log end at 365 s, the 2026-10-30 triage)
  // (and on the coast, the water's own foam where it meets the sand, the lip under the swash's lace)
  coast: { deepColor: '#0a3550', sssColor: '#36b5c2', sssMaxMix: 0.45, contactFoamStrength: 0.2 },
};
/** m: the sun shadow map's half-reach (its 8192² texels then 1.1 cm at sea, 2.2 cm on the coast): at sea only the
 * raft and the debris round it cast anything worth a shadow; on the coast the palms' and the forest's long shadows
 * at a low Sun reach ~80 m (the reason it was 160) */
const SHADOW_EXTENT = { sea: 45, coast: 90 };
/** texels: the PCF filter's radius */
const SHADOW_FILTER = 2.5;
/** m: the sun shadow camera's depth range (params/sky: near 50 .. far 2600), what a depth bias is a fraction of */
const SHADOW_DEPTH_RANGE = 2550;
/** m of water (along the view) over which the sea fades in from the sand (params/oceanSurface shoreFadeThickness) */
const SHORE_FADE = 0.6;
/** m: the shallows tint gone by this depth (the game's 18 m outlasted each island's square seabed grid, whose
 * edge then showed as a straight line in the water) */
const SHALLOWS = 6;
/** m: how far the logs' centreline rides over the sand once aground (their radius, about) */
const ON_SAND = 0.25;

/**
 * THE SHADOW ON THE LAGOON FLOOR, WHERE THE SUNLIGHT GOES (the 2026-10-29 review: "the raft should cast a shadow ON
 * THE WATER, and it's missing"). The floor is lit by the shadow map along the Sun's direction IN AIR, so a low Sun
 * (9–14° in w1–w2) threw the raft's shadow on 1.5 m of lagoon floor 6–9 m off to the side, detached from it — where
 * light under water runs refracted, ~42° up at a 9° Sun (Snell, n 1.333), and the shadow lies a metre or two from the
 * raft. A submerged floor point is therefore shadow-tested where its refracted sunbeam ENTERED the water: up through
 * the depth to the mean sea (y 0), across toward the Sun by depth·tan θ_water — whatever shades that entry point
 * (the raft, a palm) shades the floor under it. Above the water it is the point itself. Waves (±0.5 m) bend the
 * beam further; the mean surface is the honest middle of them.
 */
function seabedShadowAt(sunDir: { value: THREE.Vector3 } & THREE.Node<'vec3'>): THREE.Node<'vec3'> {
  const depth = float(0).sub(positionWorld.y).max(0);
  const horiz = vec3(sunDir.x, 0, sunDir.z);
  const cosE = horiz.length().max(1e-4);
  const sinW = cosE.div(1.333);
  const tanW = sinW.div(float(1).sub(sinW.mul(sinW)).max(1e-4).sqrt());
  return positionWorld.add(horiz.div(cosE).mul(depth.mul(tanW))).add(vec3(0, depth, 0));
}

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
  // (8192², not 4096²: at 4096 over ±160 m a texel was 7.8 cm — every leaf and pole smaller than one, so their
  // shadows aliased and crawled frame to frame as the raft bobbed and the eye moved, the raft and the forest
  // "wildly flickering" once the shadows went to full strength, the 2026-10-29 review. The extent also follows the
  // world each frame: SHADOW_EXTENT)
  skyParams.shadowMapSize = 8192;
  // SHADOWS THAT HOLD (the 2026-10-29 raft review: "are things really casting shadows on each other … the stuff
  // underneath looks unlit … the inside of the hut is bright"): the game lets 15% of the Sun into every shadow
  // (shadowIntensity 0.85, a stylised fill) — here the sky's own light is the fill, so a shadow takes the Sun out
  // entirely. And the depth bias: −0.0004 of the shadow camera's 2.55 km range is a metre, which erased every shadow
  // cast within a metre of its receiver (the beams under the cabin, the deck under the rails, the logs on the water);
  // now set per frame from the Sun's elevation (update: THE BIAS FOLLOWS THE SUN)
  skyParams.shadowIntensity = 1;
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
    shift: uniform(new THREE.Vector2()),
    coverage: uniform(CLOUD_COVER),
    presence: uniform(1),
    sun: uniform(new THREE.Vector3()),
    sunBase: uniform(new THREE.Vector3()),
    sunTop: uniform(new THREE.Vector3()),
    ambient: uniform(new THREE.Vector3()),
    cirrusCover: uniform(CIRRUS_COVER),
    sunCirrus: uniform(new THREE.Vector3()),
  };
  const nightSky = bakeNightSky(renderer, front, new THREE.Vector3(0, 1, 0));
  /** the night sky as it is laid for the open sea's eye (its `front`, c1's rest yaw), and turned for the coast's (see
   * the per-beat turn in `update`) */
  const toGalaxySea = nightSky.toGalaxy.clone();
  const toGalaxyCoast = toGalaxySea.clone().multiply(new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationY(yaw - COAST_YAW)));
  const seaSky = createSeaSky(FAR * 0.8, nightSky, {
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
  // THE WATER A LITTLE LESS CLEAR (the 2026-10-29 review: "the water can be ever so slightly less transparent — we see
  // the boards all the way down"): the extinction the sea sees through (ocean surfaceMaterial `uAbsorption`, per m,
  // R G B) from the game's Jerlov I (0.36, 0.08, 0.03) to a coastal lagoon's: the logs' submerged halves fade within
  // ~1 m of light path, deeper water greener and darker. (Read once, at the surface's build and each update; the
  // film binds no caustics, its other consumer)
  Object.assign(causticsParams, { submergedAbsorptionR: 0.5, submergedAbsorptionG: 0.17, submergedAbsorptionB: 0.13 });
  oceanSurfaceParams.radialLodPixels = 0;
  oceanSurfaceParams.shallowFullDepth = SHALLOWS;
  // the water thins to nothing on the sand instead of stopping at a line (the 2026-10-29 shoreline review)
  oceanSurfaceParams.shoreFadeThickness = SHORE_FADE;
  oceanSurfaceParams.shoreFadeEdge = 0.12; // (m: only the light through the water fades at the shore; its mirror runs on to the sand, shoreline.ts)
  // the floor seen through the water straight behind the surface, not along the bent ray (refractionSnell 0): the
  // bent lookup leaves a cube face near its edges and the floor vanished there — straight-edged pale rectangles and
  // a "sandbank" line through the shallows that moved with the camera, the 2026-10-29 review (the six faces are
  // each their own screen, so any screen-space lookup that can leave one does it along the faces' edges)
  oceanSurfaceParams.refractionSnell = 0;
  // WHAT IS UNDER THE WATER SEEN THROUGH IT (the 2026-10-29 review: "things below the waterline, like the raft logs,
  // should be darker — less light reaches them … we can look almost perfectly through the water. There's no
  // distortion really"): Beer–Lambert over the light's way down to them as well as the view's way back (two-way); the
  // wave-normal refraction twice the game's and at full strength from 0.4 m of water (the game ramps it in over 6 m,
  // so logs a few decimetres down never wavered), faded off each face's edges so it never reads across a seam
  oceanSurfaceParams.submergedLightPath = 1;
  // (and along the refracted ray: the straight one crossed ~4–5× the water at a grazing view — the lagoon floor
  // vanished a few metres from the raft, the 2026-10-30 note; params refractedLightPath)
  oceanSurfaceParams.refractedLightPath = 1;
  oceanSurfaceParams.refractionStrength = 0.12;
  oceanSurfaceParams.refractionDepthFull = 0.4;
  oceanSurfaceParams.refractionEdgeFade = 0.04;
  // the humid air's veil over the near field (params hazeNearDistance): ~3% at 200 m, 13% at 1 km, 35% at 3 km —
  // tropical marine air of ~25 km visibility (Koschmieder, 3.9/V), on land and sea alike (the 2026-10-29 review:
  // "atmospheric haze is truly missing … above our tree line it looks very pasty")
  oceanSurfaceParams.hazeNearDistance = 7000;
  Object.assign(oceanSurfaceParams, SEA_COLOUR.open);
  Object.assign(terrainParams, FILM_TERRAIN);
  Object.assign(vegetationParams, FILM_FRONDS);

  // THE ISLANDS: the test act's one (the game's, near the eye, its scanned stone at the game's own placements);
  // the show's coast (w1–w6) the film's own set, west of everything by COAST_AT (coast.ts) — both on the scanned
  // PBR beach (beachMaterial.ts), not the game's painted ground
  const beachTerrain = createBeachTerrain(undefined, { cloudSun: seaSky.cloudSun });
  let land: { group: THREE.Group; seabed: SeabedField; update: FilmCoast['update'] };
  let beach: { x: number; z: number };
  let ground: (x: number, z: number) => number;
  let scannedRocks: ReturnType<typeof createScannedRocks> | undefined;
  let archipelago: ReturnType<typeof createArchipelago> | undefined;
  let forest: Forest | undefined;
  let coast: FilmCoast | undefined;
  let swash: SwashSim | undefined;
  /** unit toward this frame's Sun, for the lagoon floor's shadow lookup (`seabedShadowAt`) */
  const seabedSun = uniform(new THREE.Vector3(0, 1, 0));
  let groundDebris: GroundDebris | undefined;
  let beachDressing: BeachDressing | undefined;
  const forestLight = new THREE.Color();
  /** the beach's albedo, and its bounce this frame (the hemisphere light's ground on the coast) */
  const SAND_GROUND = new THREE.Color(...SAND_ALBEDO);
  const sandBounce = new THREE.Color();
  if (!o.drive) {
    const bearing = yaw + (ISLAND_LEFT_OF_SUN * Math.PI) / 180;
    const site = { ...generateIslandSites(SEED)[0], position: [-Math.sin(bearing) * ISLAND_DISTANCE, -Math.cos(bearing) * ISLAND_DISTANCE] as [number, number] };
    const arch = createArchipelago({ seed: SEED, sites: [site], terrainHooks: beachTerrain.hooks });
    archipelago = arch;
    land = arch;
    const lagoon = arch.islands[0];
    beach = { x: lagoon.center[0], z: lagoon.center[1] };
    for (let r = 0; r < 400; r += 0.5) {
      if (lagoon.heightAt(lagoon.center[0] - r, lagoon.center[1]) < 0) {
        beach.x = lagoon.center[0] - r;
        break;
      }
    }
    ground = (x, z) => lagoon.heightAt(x, z);
    scannedRocks = createScannedRocks(arch, () => true);
    afloat.add(scannedRocks.group);
  } else {
    const film = createFilmCoast(COAST_AT, beachTerrain.hooks, { high: createForestGround });
    coast = film;
    // (the lagoon floor's shadows where the sunlight reaches it through the water: `seabedShadowAt`)
    (film.materials.terrain.material as THREE.NodeMaterial).receivedShadowPositionNode = seabedShadowAt(seabedSun);
    land = film;
    beach = film.beach;
    ground = film.ground;
    // the islands' trees (forest.ts), leaves on the forest's edge along the walk: the beach from the raft's w1
    // course to the point ahead, 5–120 m inland
    // the water's edge along our beach (shoreline.ts): the swash's sheet, its foam, the break, on the sand's own
    // swash model
    const shore = film.materials.terrain.shore;
    // the swash simulated along the walk (swashSim.ts); the sea fades out over it (shoreSim*)
    swash = createSwashSim({ ground: film.ground, beach });
    Object.assign(oceanSurfaceParams, { shoreSimX0: swash.rect[0], shoreSimZ0: swash.rect[1], shoreSimX1: swash.rect[2], shoreSimZ1: swash.rect[3] });
    if (!shore) throw new Error('sea: the coast needs the terrain swash (terrainParams.runupEnabled)');
    film.group.add(
      createShoreline({
        ground: film.ground,
        beach,
        along: [-320, 420],
        shore,
        waterline: film.materials.terrain.uniforms.sand.waterline as unknown as THREE.Node<'float'>,
        skyDome: seaSky.dome,
        skySun: seaSky.sunTerm,
        reflection: mirror.reflection,
        cloudSun: seaSky.cloudSun,
      }).mesh,
    );
    forest = createForest(film.islands, { x: [beach.x + 5, beach.x + 120], z: [beach.z - 260, beach.z + 220] }, (m) => film.materials.aerialOutput(m));
    land.group.add(forest.group);
  }
  afloat.add(land.group);
  // the plants: scanned ferns and broad leaves on the ground above our beach, in place of the game's cards and
  // palms (plants.ts) — from the palm line back (scattered over the open sand, backlit by the low Sun, they read
  // as litter in the v9 review)
  const plants = o.drive
    ? createPlants(archipelago, ground, { x0: beach.x + 16, x1: beach.x + 95, z0: beach.z - 110, z1: beach.z + 110 }, { minH: 1.4, maxH: 9, maxSlope: 0.45, feet: palmFeet(beach) })
    : undefined;
  if (plants) afloat.add(plants.group);
  const palms = o.drive ? createPalms(beach, ground, coast?.islands[0]) : undefined;
  if (palms) afloat.add(palms.group);
  if (palms) beachTerrain.setOccluders(palms.occluders);
  // the drowned town under the shallows and its boulevard off the beach (drowned.ts; sunken-world-cues.md 5, 6)
  const drowned = coast && palms ? createDrownedShallows(renderer, { beach, sand: ground, light: palms.light, shadowAt: seabedShadowAt(seabedSun) }) : undefined;
  if (drowned && coast) {
    coast.group.add(drowned.under);
    afloat.add(drowned.above);
  }
  if (forest && coast) {
    // the leaf litter under the forest's edge and round every foot along the walk (forest.ts litterMask): the
    // edge's trees and shrubs, and the palms' fronds and husks
    const feet = [...forest.feet, ...palmFeet(beach).map(([x, z]): [number, number, number] => [x, z, 3])];
    beachTerrain.setLitter(litterMask(coast.islands[0], feet, [beach.x - 10, beach.z - 280], 520), [beach.x - 10, beach.z - 280], 520);
    // and the things lying there (groundDebris.ts): roots, branches, bark and low plants at every foot, driftwood
    // on the strand line (where the beach first stands 1.4 m over the sea: the berm, the highest tides' reach)
    const strand = (z: number): number => {
      let lo = beach.x - 20;
      let hi = beach.x + 60;
      for (let i = 0; i < 30; i++) {
        const mid = (lo + hi) / 2;
        if (ground(mid, z) < 1.4) lo = mid;
        else hi = mid;
      }
      return (lo + hi) / 2;
    };
    groundDebris = createGroundDebris({ feet: forest.feet, palms: palmFeet(beach), ground, strand, along: [beach.z - 260, beach.z + 220] });
    afloat.add(groundDebris.group);
    // and the beach's small things (beachDressing.ts): coral pebbles and rubble, shells, the wrack line
    beachDressing = createBeachDressing({ ground, beach, inland: coast.islands[0].inland, palms: palmFeet(beach), cloudSun: seaSky.cloudSun });
    land.group.add(beachDressing.group);
  }

  // a calm sea, near glass (the v6 notes; the game's default is a working sea, Hs ~2.8 m): the game's glass
  // preset with a light air's ripples (RIPPLE) over a long low ground swell (direction.md: the swell lifts and
  // sets the raft down). Set before the spectrum is built, never changed during the act
  Object.assign(oceanParams, weatherPresets.glass.ocean, RIPPLE, { swellAmplitude: SWELL_RMS, swellPeriod: SWELL_PERIOD, windDirection: WIND_TO });
  const ocean = createOceanSim(SEED);
  // the raft's wake, at the game raft's scale (its ramp is the galleon's: raftScene.ts), and its own water (FILM_WAKE)
  Object.assign(flowFoamParams, FILM_WAKE);
  // (the wake's foam is the logs' white water alone here, so it is drawn white: the game's #70bbb5 is a ship's
  // aerated green churn, and at the raft it read as a teal paint)
  oceanSurfaceParams.wakeFoamColor = FILM_WAKE_WHITE;
  // the wake's thin coverage as bubbles under the surface (aerated, milky turquoise), white only where dense; and the
  // scar's slick reaching the middle cascade, so the lane reads glassy on a light-air sea (2026-10-29: "no visible
  // turbulence, no trailing")
  // (0.6, from 1.5: the 2026-11-01 review, "a bit too opaque … looks a bit pasted on" — at the trail's full dose the
  // body went 36% milky, a band of paint; now ~7%, and the trail's dose is less and ∝ the way², hullContact wakeDose)
  oceanSurfaceParams.wakeAeration = 0.6;
  oceanSurfaceParams.wakeAerationColor = '#86cfc4';
  oceanSurfaceParams.wakeSmoothLong = 0.7;
  const raftWater = createHullContact(raftLogsInPlan());
  const flowFoam = createFlowFoam({ hull: raftWater });
  flowFoam.setSpeedScale(raftWakeParams.speedScale);
  const surface = new OceanSurface(ocean, undefined, flowFoam, {
    reflection: mirror.reflection,
    sunLight: sky.sunLight,
    skyDomeColor: seaSky.dome,
    skySunTerm: seaSky.sunTerm,
    cloudSun: seaSky.cloudSun,
    // (none of the sea over the swash sim's water, on its own curving, feathered edges: swashSim.ts swashSeaGone)
    shoreSimMask: swash ? swashSeaGone : undefined,
    seabed: land.seabed,
    // the dome's cube target is half-float, as the game's HDR scene target
    hdrSceneTarget: true,
  });
  scene.add(surface.group);
  // (the swash's water lit and coloured as this sea's, shoreline.ts)
  bindSwashToSea(surface.lightUniforms);
  surface.group.traverse((x) => {
    if ((x as THREE.Mesh).isMesh) x.receiveShadow = true;
  });
  // ONE SEA PER INSTANT. A CpuOcean recomputes its grids whenever it is asked about a new time, and every raft
  // averages the sea over the same few instants (raft.ts SAMPLES): the main raft and the five far ones took
  // 30 recomputes a frame on the open sea, ~60 ms, most of the frame (engine-findings.md). A pool of oceans
  // sharing one spectrum, each holding the last instant it was asked about, computes each instant once.
  const seas = Array.from({ length: SEA_POOL }, () => ({ at: Number.NaN, sea: new CpuOcean(SEED, oceanParams, { ...raftSeaParams, updateEveryTicks: 0 }, ocean.spectrum) }));
  // the sea the rafts float on shoals over the same floor the drawn sea does (§V.8): without it the raft rode the
  // open ocean's swell over the lagoon's 2 m sand flat, where the drawn swell is flattened — out of the water on
  // every crest as it came in (the 2026-10-29 review: "the logs stand out of the water")
  for (const s of seas) s.sea.setSeabed(land.seabed, -land.seabed.openHeight);
  // (a Map's order is its recency: a hit moves to the back, the front is evicted)
  const seaSlot = new Map<number, (typeof seas)[number]>();
  let unused = seas.length;
  /** the sea at t, on SEA_QUANTUM's grid: its ocean, and the instant it is computed at */
  const seaAt = (t: number): { sea: CpuOcean; t: number } => {
    const key = Math.round(t / SEA_QUANTUM);
    let s = seaSlot.get(key);
    if (s) {
      seaSlot.delete(key);
    } else if (unused > 0) {
      s = seas[--unused];
    } else {
      const [oldest, slot] = seaSlot.entries().next().value!;
      seaSlot.delete(oldest);
      s = slot;
    }
    s.at = key * SEA_QUANTUM;
    seaSlot.set(key, s);
    return { sea: s.sea, t: s.at };
  };
  const heightAt = (x: number, z: number, t: number): number => {
    const s = seaAt(t);
    return s.sea.heightAt(x, z, s.t);
  };
  // a raft floats on the sea, or rests on the sand once aground (w2)
  const floating = (x: number, z: number, t: number): number => Math.max(heightAt(x, z, t), ground(x, z) + ON_SAND);
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
  const sunTmp = new THREE.Vector3();
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
  // ONE SEA, from the landing through the night (c1's follow to c4's end): no dissolve. The raft SETS SAIL in the
  // follow — the sail hoisted (HOIST, s into the follow), then way on along its own heading (WAY, to the course's
  // speed), its bow coming round onto the course as it goes (beats.ts raftPose) — and sails on with the eye
  // alongside, in the flood's debris field, riding its slow turn (the current). The Sun is brought down from the
  // landing's to c2's in a time-lapse through the follow (LAPSE), the clouds hurrying with it. (It used to dissolve
  // into another place, the "open sea", with the eye turned about: two suns and two rafts in the crossfade.)
  const smooth01 = (x: number): number => {
    const k = Math.min(1, Math.max(0, x));
    return k * k * (3 - 2 * k);
  };
  const followStart = c1End - C1_FOLLOW;
  const atFollow = o.drive ? o.drive(followStart) : undefined;
  const followEye = atFollow ? atFollow.eye.clone() : new THREE.Vector3();
  const followTurn = atFollow ? DEBRIS_SPIN * atFollow.driftTime : 0;
  const followSun = atFollow ? atFollow.sun.clone() : new THREE.Vector3(0, 1, 0);
  /** the field's turn at sea time t ≥ the follow (the drive's own, run on) */
  const fieldTurn = (t: number): number => followTurn + DEBRIS_SPIN * (t - followStart);
  const hoistAt = (t: number): number => smooth01((t - followStart - HOIST[0]) / (HOIST[1] - HOIST[0]));
  const wayAt = (t: number): number => COURSE_SPEED * smooth01((t - followStart - WAY[0]) / (WAY[1] - WAY[0]));
  const speedOf = (t: number): number => (t < beats.starts.c2 ? wayAt(t) : speedAt(t, beats.starts));
  /** sailedFrom's sums after each whole step, [x the next step starts at, out.x, out.z]: the same additions in the
   * same order, so the same result, without walking the whole way again (the wake's replay asks at every step) */
  const sailedSteps: Array<[number, number, number]> = [];
  /** the way made since the follow began, in the field's frame as it lay then: along the raft's own heading */
  const sailedFrom = (t: number, out: THREE.Vector3): THREE.Vector3 => {
    out.set(0, 0, 0);
    const h = 0.1;
    let x = followStart + WAY[0];
    let k = 0;
    for (; k < sailedSteps.length && t - x >= h; k++) [x, out.x, out.z] = sailedSteps[k];
    for (; x < t; x += h) {
      const step = Math.min(h, t - x);
      const m = x + step / 2;
      const v = speedOf(m) * step;
      const hd = yaw + raftPose(m, c1End, restPose).heading + Math.PI;
      out.x += Math.sin(hd) * v;
      out.z += Math.cos(hd) * v;
      if (step === h && k === sailedSteps.length) sailedSteps.push([x + h, out.x, out.z]), k++;
    }
    return out;
  };
  /** the eye at sea time t ≥ the follow: where it rested plus the way made, turned with the field */
  const sailingEye = (t: number, out: THREE.Vector3): THREE.Vector3 =>
    sailedFrom(t, out).add(followEye).applyAxisAngle(UP, fieldTurn(t) - followTurn);
  /** s the clouds' clock has gained by sea time t in the time-lapse (its speed-up a sin² bump over LAPSE) */
  const lapsedClouds = (t: number): number => {
    const span = LAPSE[1] - LAPSE[0];
    const u = Math.min(1, Math.max(0, (t - followStart - LAPSE[0]) / span));
    return (LAPSE_CLOUDS - 1) * span * (u / 2 - Math.sin(2 * Math.PI * u) / (4 * Math.PI));
  };
  const sea1End = beats.starts.w1;
  // none of the debris in the raft's berth, nor along the way it sails (in the field's frame: the debris turns)
  const lane: THREE.Vector3[] = [];
  if (o.drive) {
    const e = new THREE.Vector3();
    const toRaft = new THREE.Vector3();
    for (let x = followStart; x <= sea1End; x += 1) {
      const pose = raftPose(x, c1End, restPose);
      sailingEye(x, e);
      toRaft.set(Math.sin(pose.bearing), 0, -Math.cos(pose.bearing)).applyAxisAngle(UP, yaw).multiplyScalar(pose.distance);
      lane.push(e.clone().add(toRaft).setY(0).applyAxisAngle(UP, -fieldTurn(x)));
    }
  }
  const berth = (data: ReturnType<typeof debrisPieces>): ReturnType<typeof debrisPieces> =>
    [raftInField, ...lane].reduce((d, q) => clearOf(d, q.x, q.z, RAFT_BERTH), data);
  // what the sea gives the pieces (debrisField.ts DebrisLook): the sky its wet wood mirrors, and the swell they ride —
  // the ocean's two long cascades at the piece (the short chop is what slaps them, not what lifts them)
  const debrisLook: DebrisLook = {
    sky: seaSky.dome,
    swell: (xz) => [0, 1].map((i) => texture(ocean.cascades[i].displacement, xz.div(ocean.cascades[i].domain).fract()).y).reduce((a, b) => a.add(b)) as THREE.Node<'float'>,
  };
  const debris = o.drive ? createDebrisField(berth(debrisPieces()), du as unknown as DebrisUniforms, debrisLook) : undefined;
  const nearDebris = debris ? createDebrisField(berth(matPieces(raftInField.x, raftInField.z, MAT_SIGMA, MAT_PIECES)), du as unknown as DebrisUniforms, { ...debrisLook, tilt: true, scans: true }) : undefined;
  // THE PEOPLE'S THINGS WHERE THE EYE WILL BE (the user's story note, 2026-10-29: "without someone telling me the story it
  // doesn't become apparent"; sunken-world-cues.md cue 2): a crate, a plastic drum, a lifebuoy, a jerrycan… afloat a
  // few metres in front of where the eye comes to rest after the landing, and along the raft's way, off its berth
  const thingSpots: Array<[number, number]> = [];
  if (o.drive) {
    const eyeInField = restAt.clone().applyAxisAngle(UP, -restTurn);
    const f = front.clone().applyAxisAngle(UP, -restTurn);
    const rgt = right.clone().applyAxisAngle(UP, -restTurn);
    for (const [ahead, side] of THINGS_AT_REST) {
      thingSpots.push([eyeInField.x + f.x * ahead + rgt.x * side, eyeInField.z + f.z * ahead + rgt.z * side]);
    }
    lane.forEach((q, i) => {
      if (i % THINGS_LANE_EVERY !== 3 || i + 1 >= lane.length) return;
      const dx = lane[i + 1].x - q.x;
      const dz = lane[i + 1].z - q.z;
      const l = Math.hypot(dx, dz) || 1;
      const side = (i / THINGS_LANE_EVERY) % 2 < 1 ? 1 : -1;
      thingSpots.push([q.x - (dz / l) * side * THINGS_LANE_OFF, q.z + (dx / l) * side * THINGS_LANE_OFF]);
    });
  }
  const things = o.drive ? createDebrisField(berth(thingsAt(thingSpots)), du as unknown as DebrisUniforms, { ...debrisLook, tilt: true, scans: true }) : undefined;
  if (debris) {
    afloat.add(debris);
    if (nearDebris) debris.add(nearDebris);
    if (things) debris.add(Object.assign(things, { name: 'drift-debris-things' }));
  }
  // the far craft, about the eye, each its own kind and size — none of them a copy of our raft — and a lantern each
  // (farRafts.ts)
  const farLook = createFarCraftLook();
  const farRafts = o.drive ? FAR_RAFTS.map((f) => Object.assign(createFarCraft(f.kind, farLook, floating), { lantern: createFarLantern(), lampAt: new THREE.Vector3() })) : [];
  farRafts.forEach((r, i) => {
    r.group.scale.setScalar(FAR_RAFTS[i].scale);
    afloat.add(r.group, r.lantern.mesh);
  });
  // a power line marching out of the sea toward c2's sunset (drowned.ts; sunken-world-cues.md cue 3)
  const powerLine = o.drive ? createSeaPowerLine(renderer, { eye: sailingEye(beats.starts.c2, new THREE.Vector3()), yaw, horizon: seaSky.horizon }) : undefined;
  if (powerLine) afloat.add(powerLine.group);
  // the people, the dolphin and the case, the beams, the field, the walkers (props.ts)
  const props = o.drive ? createProps() : undefined;
  if (props) afloat.add(props.group);
  // the dolphin's spray (splash.ts), on c3's clock
  const splashes = o.drive ? createSplashes(dolphinSplashes()) : undefined;
  if (splashes) scene.add(splashes.mesh);
  const fieldEye = new THREE.Vector3();
  const coastEyeAt = (x: number): THREE.Vector3 => {
    const c = coastEye(x, c1End, beach);
    return new THREE.Vector3(c.x, Math.max(0, ground(c.x, c.z)) + c.height, c.z);
  };
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

  // THE WAKE, replayed (see the header). Two worlds shed one: the sea (from the follow, when the raft gets way on:
  // before it, it drifts with the field) and the coast (from w1's dissolve in). Across that dissolve the coast's
  // owns it; the coast is kilometres from the sea, so neither world draws the other's.
  type WakeWorld = 'sea' | 'coast';
  const wakeFrom: Record<WakeWorld, number> = { sea: followStart, coast: beats.starts.w1 - spec('w1')!.dissolve / 2 };
  const wakeEye = new THREE.Vector3();
  const wakeAcross = new THREE.Vector3();
  /** the raft at sea time t in `w` (update's own placement of it, the raft alone) */
  const raftOn = (t: number, w: WakeWorld): { x: number; z: number; heading: number; speed: number } => {
    const pose = raftPose(t, c1End, restPose);
    if (w === 'sea') {
      sailingEye(t, wakeEye);
      across(yaw, pose.bearing, wakeAcross);
      return { x: wakeEye.x + wakeAcross.x * pose.distance, z: wakeEye.z + wakeAcross.z * pose.distance, heading: yaw + pose.heading + Math.PI, speed: speedOf(t) };
    }
    const c = coastEye(t, c1End, beach);
    across(COAST_YAW, pose.bearing, wakeAcross);
    if (t > beats.starts.w2) {
      const at = coastEye(beats.starts.w2, c1End, beach);
      const p0 = raftPose(beats.starts.w2, c1End, restPose);
      across(COAST_YAW, p0.bearing, wakeAcross);
      const from = { x: at.x + wakeAcross.x * p0.distance, z: at.z + wakeAcross.z * p0.distance };
      const run = landfall(t, c1End, from, beach);
      const a = landfall(t - 0.5, c1End, from, beach);
      const b = landfall(t + 0.5, c1End, from, beach);
      return { x: run.x, z: run.z, heading: run.heading, speed: Math.hypot(b.x - a.x, b.z - a.z) };
    }
    return { x: c.x + wakeAcross.x * pose.distance, z: c.z + wakeAcross.z * pose.distance, heading: COAST_YAW + pose.heading + Math.PI, speed: travelled(t - 0.5, t + 0.5, c1End) };
  };
  /** the world whose wake is held, and how many WAKE_DT steps it has been run from that world's start (−1: none yet,
   * or cleared before its start) */
  let wakeWorld: WakeWorld | null = null;
  let wakeStep = -1;
  /**
   * Bring the wake of world `w` to sea time t. Its state stands on the step grid wakeFrom[w] + k·WAKE_DT: a frame
   * between two grid points is drawn from the one at or before it, not stepped to its own t — the last step used to be
   * a partial one (to t exactly), so a frame stepped on from an earlier one and the same frame replayed from the
   * world's start held different states. Now ANY forward jump steps on from where the state is (the same steps, in the
   * same order, as a replay would take: bit for bit the same state), and only a jump BACK, or into another world,
   * replays from the world's start. (It used to replay from the start on any jump of more than 10 s: 25–35 s at the
   * start of every still and chunk, the farm's profile, 2026-10-30.) Every frame stays a pure function of t.
   */
  const wakeTo = (t: number, w: WakeWorld, renderer: THREE.WebGPURenderer): void => {
    if (t < wakeFrom[w]) {
      if (wakeWorld !== w || wakeStep !== -1) flowFoam.reset(renderer, t);
      wakeWorld = w;
      wakeStep = -1;
      return;
    }
    // the last grid point at or before t (the 1e-6: a t on the grid, computed by another route, not to fall a step short)
    const target = Math.floor((t - wakeFrom[w]) / WAKE_DT + 1e-6);
    if (wakeWorld !== w || wakeStep < 0 || target < wakeStep) {
      flowFoam.reset(renderer, wakeFrom[w]);
      wakeWorld = w;
      wakeStep = 0;
    }
    while (wakeStep < target) {
      wakeStep++;
      // (the step's time from its index, never summed: the same float however the step was reached)
      const at = wakeFrom[w] + wakeStep * WAKE_DT;
      const r = raftOn(at, w);
      const was = raftOn(Math.max(wakeFrom[w], at - WAKE_BEHIND_S), w);
      flowFoam.setCenter(was.x, was.z);
      // THE WATER'S OWN MOTION, which carries what the raft leaves exactly as it carries the raft: at sea the flood's
      // current (the debris field's turn, DEBRIS_SPIN about the world's origin: the raft rides it, ~0.45 m/s across its
      // course in c2–c4), and everywhere the light air's slow drift. Without the current the wake stayed put in the
      // world while the raft and the debris were carried on, so it trailed off at an angle to the raft, ~7° to one side
      // at sea (the 2026-10-30 review: "not really left in the way the boat is moving relative to the water")
      const cur = w === 'sea' ? [DEBRIS_SPIN * r.z, -DEBRIS_SPIN * r.x] : [0, 0];
      const flow = [cur[0] + Math.sin(WIND_TO) * WATER_DRIFT, cur[1] + Math.cos(WIND_TO) * WATER_DRIFT];
      flowFoamParams.baseFlowSpeed = Math.hypot(flow[0], flow[1]);
      flowFoam.setFlowDir([flow[0], flow[1]]);
      raftWater.setCurrent(flow[0], flow[1]);
      // the stern's course THROUGH THE WATER (its world motion less the water's): what the trail is laid along
      const a0 = raftOn(at - 0.25, w);
      const a1 = raftOn(at + 0.25, w);
      const vx = (a1.x - a0.x) / 0.5 - flow[0];
      const vz = (a1.z - a0.z) / 0.5 - flow[1];
      const course = Math.hypot(vx, vz) > 0.05 ? Math.atan2(vx, vz) : r.heading;
      flowFoam.setShip([r.x, r.z], r.heading, r.speed, raft.hull.stemZ, raft.hull.transomZ, raft.hull.beam);
      // (the chop that slaps the logs runs with the sea's own wind)
      raftWater.setPose(r.x, r.z, r.heading, r.speed, at, WIND_TO, course);
      raftWater.advance(WAKE_DT);
      flowFoam.advanceWake(WAKE_DT);
      flowFoam.update(renderer, WAKE_DT);
    }
  };
  /** THE SKY AND ITS CLOUDS at sea time t, for an eye at `at` under a Sun toward `sun` (the sea's frame): the air's light,
   * the clouds' uniforms and their light volume. Shared by the sea's own frames (update) and Act 2's descent before the
   * hand-over (`descentSky`), so both draw the one cloud field in one state */
  const skyAt = (t: number, at: THREE.Vector3, sun: THREE.Vector3, d: SeaDrive | undefined, b: BeatSpec | undefined, sailing: boolean, renderer: THREE.WebGPURenderer): void => {
    seaSky.update(at, sun);
    // (the time-lapse hurries the clouds: their clock runs LAPSE_CLOUDS × at its middle)
    cu.time.value = sailing ? t + lapsedClouds(t) : t;
    cu.sun.value.copy(sun);
    // c1's clouds form as thin veils over most of their field and thicken (coverage rising from zero only
    // pops scattered lumps into the sky); each later beat has its own sky
    const formed = d ? d.clouds : 1;
    const beatClouds = b ? beatSky(b.name, t, c1End) : undefined;
    cu.coverage.value = beatClouds ? beatClouds.cover : CLOUD_COVER * (0.4 + 0.6 * formed);
    cu.presence.value = formed;
    cu.cirrusCover.value = beatClouds ? beatClouds.cirrus : CIRRUS_COVER * formed;
    if (sailing && t < followStart + LAPSE[1]) {
      // c1's sky turns into c2's through the time-lapse, across the beats' boundary (c2's own sky only once it is
      // done: switched at the boundary, the cover stepped there)
      const k = smooth01((t - followStart - LAPSE[0]) / (LAPSE[1] - LAPSE[0]));
      const c2 = spec('c2')!;
      cu.coverage.value = CLOUD_COVER * (0.4 + 0.6 * formed) + (c2.cover - CLOUD_COVER * (0.4 + 0.6 * formed)) * k;
      cu.cirrusCover.value = CIRRUS_COVER * formed + (c2.cirrus - CIRRUS_COVER * formed) * k;
    }
    const atCloud = (h: number, out: THREE.Vector3): void => {
      const c = sunlightCpu(EARTH_R + h * 1e-6, sun.y);
      out.set(c[0], c[1], c[2]).multiplyScalar(SUN_E / Math.PI);
    };
    atCloud(CLOUD_BASE, cu.sunBase.value);
    atCloud(CLOUD_TOP, cu.sunTop.value);
    atCloud(CIRRUS_H, cu.sunCirrus.value);
    cu.ambient.value.set(seaSky.irradiance.r, seaSky.irradiance.g, seaSky.irradiance.b).multiplyScalar(1 / Math.PI);
    // (the clouds' light volume for this instant, now that their uniforms are, and the marches' offset from the
    // sea's clock: clouds.ts)
    seaSky.updateClouds(renderer, t);
  };
  const descentSky = o.drive && seaSky.cloudsOver
    ? (() => {
        const drive = o.drive;
        const over = seaSky.cloudsOver;
        const toSea = uniform(new THREE.Matrix3());
        const eyeSea = uniform(new THREE.Vector3());
        const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, depthTest: false, transparent: true, fog: false });
        // (premultiplied, as Act 2's air: earth.ts atmosphere)
        material.blending = THREE.CustomBlending;
        material.blendSrc = THREE.OneFactor;
        material.blendDst = THREE.OneMinusSrcAlphaFactor;
        material.colorNode = Fn(() => {
          const d = normalize(toSea.mul(normalize(positionWorld.sub(cameraPosition))));
          // (over the eye's horizontal only: below it is Act 2's own sea, which the layer's march would find a far
          // crossing of the shell for)
          return over(eyeSea as unknown as THREE.Node<'vec3'>, d).mul(smoothstep(-0.002, 0.004, d.y));
        })();
        material.name = 'drift-sea-descent-clouds';
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), material);
        mesh.frustumCulled = false;
        // (after Act 2's air, earth.ts: renderOrder 2)
        mesh.renderOrder = 2.5;
        mesh.name = 'drift-sea-descent-clouds';
        const m4 = new THREE.Matrix4();
        return {
          mesh,
          update(t: number, renderer: THREE.WebGPURenderer, eyeWorld: THREE.Vector3, toField: THREE.Quaternion): void {
            const d = drive(t);
            // (none above the layer: the march looks up through it, and from above the forming field is still thin)
            mesh.visible = d.clouds > 0 && d.eye.y < CLOUD_TOP;
            if (!mesh.visible) return;
            // (10 km round the eye in Act 2's Mm: f32 world positions there are ~1 µm apart, a direction's error 1e-4°)
            mesh.position.copy(eyeWorld);
            mesh.scale.setScalar(0.01);
            mesh.updateMatrixWorld();
            toSea.value.setFromMatrix4(m4.makeRotationFromQuaternion(toField));
            eyeSea.value.copy(d.eye);
            skyAt(t, d.eye, d.sun, d, undefined, false, renderer);
          },
        };
      })()
    : undefined;
  const act: SeaAct = {
    descentSky,
    scene,
    far: FAR,
    total,
    wake: flowFoam,
    raftWater,
    probeWater: (x, z, t) => ({ sea: heightAt(x, z, t), ground: ground(x, z) }),
    probeRaft: (t, world) => raftOn(t, world),
    get exposure() {
      return seaSky.exposure;
    },
    ready: Promise.all([ready, debris?.ready, nearDebris?.ready, things?.ready, cloudData.ready, beachTerrain.ready, scannedRocks?.ready, forest?.ready, coast?.ready, props?.ready, groundDebris?.ready, beachDressing?.ready, plants?.ready, palms?.ready, drowned?.ready, powerLine?.ready, raft.ready]).then(() => undefined),
    passes(t) {
      return o.drive ? beatsAt(t, c1End).map((p) => ({ beat: p.name, weight: p.weight })) : [{ beat: 'c1', weight: 1 }];
    },
    setPixelAngle(rad) {
      fu.pixelAngle.value = rad;
      du.pixelAngle.value = rad;
      if (splashes) (splashes.uniforms.pixelAngle as unknown as { value: number }).value = rad;
      props?.setPixelAngle(rad);
      seaSky.setPixelAngle(rad);
    },
    update(t, eye, renderer, beat = 'c1') {
      // a node frame of its own for each beat drawn: three renders a light's shadow map once per camera per
      // node frame, so the second beat of a dissolve drew with the first's shadows (its own Sun's, not this
      // one's) — the raft unlit through w1's dissolve, popping lit as it ended (engine-findings.md)
      (renderer as unknown as { _nodes: { nodeFrame: { frameId: number } } })._nodes.nodeFrame.frameId++;
      const d = o.drive && beat === 'c1' ? o.drive(t) : undefined;
      const b = beat === 'c1' ? undefined : spec(beat);
      const world: WorldName | 'test' = !o.drive ? 'test' : b ? b.world : 'flood';
      // WHERE THE EYE AND THE RAFT ARE, and the Sun
      let raftX = 0;
      let raftZ = 0;
      let raftHeading = 0;
      let eyeYaw = yaw;
      // (from the follow on, the one sea's own turn: the drive's, run on through c4)
      const sailing = o.drive !== undefined && t >= followStart && (beat === 'c1' || world === 'open');
      const turn = sailing ? fieldTurn(t) : d ? DEBRIS_SPIN * d.driftTime : 0;
      let sails = 0;
      let speed = 0;
      if (!o.drive) {
        eye.position.set(0, EYE_HEIGHT, 0);
        eye.rotation.set(0, yaw, 0);
        sun.copy(testSun);
        // (review scripts only, the test act: a day–night cycle driven per frame — window.__seaSun(t) → [elevation,
        // azimuth left of the eye's front], deg; scratch clouds review)
        const cycle = (globalThis as { __seaSun?: (t: number) => [number, number] }).__seaSun?.(t);
        if (cycle) {
          const [el, az] = [(cycle[0] * Math.PI) / 180, (cycle[1] * Math.PI) / 180];
          sun.set(-Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).applyAxisAngle(UP, yaw);
        }
        raftX = raftAt.x;
        raftZ = raftAt.z;
        raftHeading = yaw - raftRight + Math.PI / 2 + RAFT_SHEER;
      } else if (sailing) {
        // THE ONE SEA (see its note above): the eye sails on from where the landing left it, the raft alongside
        // by its pose, the Sun brought down to c2's
        const pose = raftPose(t, c1End, restPose);
        sailingEye(t, eye.position);
        eye.position.y = pose.height;
        eyeYaw = yaw;
        eye.rotation.set(0, eyeYaw, 0);
        across(eyeYaw, pose.bearing, v);
        raftX = eye.position.x + v.x * pose.distance;
        raftZ = eye.position.z + v.z * pose.distance;
        raftHeading = eyeYaw + pose.heading + Math.PI;
        sails = beat === 'c1' ? hoistAt(t) : sailsAt(beat, t, c1End);
        speed = speedOf(t);
        const c2Sun = sunTmp.set(...beatSun(beat === 'c1' ? 'c2' : beat, Math.max(t, beats.starts.c2), c1End)).applyAxisAngle(UP, eyeYaw);
        const k = smooth01((t - followStart - LAPSE[0]) / (LAPSE[1] - LAPSE[0]));
        sun.copy(followSun).lerp(c2Sun, k).normalize();
      } else if (d) {
        // c1: Act 2's landing, the raft drifting with the debris galaxy
        eye.position.copy(d.eye);
        eye.quaternion.copy(d.turn);
        sun.copy(d.sun);
        raftNow.copy(raftInField).applyAxisAngle(UP, turn);
        raftX = raftNow.x;
        raftZ = raftNow.z;
        raftHeading = yaw + raftPose(t, c1End, restPose).heading + Math.PI + turn - restTurn;
      } else {
        const pose = raftPose(t, c1End, restPose);
        {
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
      // THE NIGHT SKY LAID FOR THE EYE, ON THE COAST'S NIGHT ARRIVAL TOO (the 2026-11-01 c4→w1 dissolve, the world
      // changing in the dark): the galaxy is placed for the open sea's front (c1's rest yaw), and the coast's eye faces
      // COAST_YAW — so across the dissolve the same view looked at two different stretches of the Milky Way, the
      // galactic centre's bright glow at sea and a dim reach of the band on the coast (a sky patch 101,72,38 against
      // 10,5,2: clouds, the Sun's bearing, the exposure and every mesh but the sky ruled out one by one). Through w1 and
      // w2 the sky is turned by the difference, so it stands over the eye as it did at sea. (Not in w6: its night is
      // framed on the sky as it has been laid there; by w3 the stars are long gone in the day)
      nightSky.toGalaxy.copy(beat === 'w1' || beat === 'w2' ? toGalaxyCoast : toGalaxySea);
      eye.updateMatrixWorld();
      if (act.reviewEye) {
        act.reviewEye(eye, { x: raftX, z: raftZ, heading: raftHeading });
        eye.updateMatrixWorld();
      }
      // what each world holds
      if (debris) debris.visible = world === 'flood' || world === 'open';
      if (powerLine) powerLine.group.visible = world === 'flood' || world === 'open';
      // (c2–c4 only, coming up out of the haze from c2's start: switched on with the follow they popped in at 335 s, in
      // the sea's first shot — "suddenly we see a second raft in the distance", the 2026-10-31 review — farRafts.ts)
      const farIn = sailing ? farRaftsIn(t, beats.starts.c2) : 0;
      const farOn = farIn > 0;
      farLook.fade.value = farIn;
      for (const r of farRafts) r.group.visible = r.lantern.mesh.visible = farOn;
      land.group.visible = world === 'coast' || world === 'test';
      if (scannedRocks) scannedRocks.group.visible = land.group.visible;
      if (plants) plants.group.visible = land.group.visible;
      if (groundDebris) groundDebris.group.visible = land.group.visible;
      if (palms) palms.group.visible = land.group.visible;
      if (drowned) {
        drowned.above.visible = land.group.visible;
        drowned.setTime(t);
      }
      const flockT = o.drive ? t - beats.starts.w4 - 2 : t - FLOCK_START;
      if (flock) flock.visible = world === 'test' || (world === 'coast' && flockT > -1);

      skyParams.timeOfDay = hour;
      // the shadow map's reach, per world (SHADOW_EXTENT), and its filter: a few texels of PCF, so an edge is a
      // gradient a texel can slide along rather than a step that jumps
      skyParams.shadowExtent = world === 'coast' || world === 'test' ? SHADOW_EXTENT.coast : SHADOW_EXTENT.sea;
      sky.sunLight.shadow.radius = SHADOW_FILTER;
      // the film's own filter: 16 fixed taps, no screen-space dither, widened by a fixed blocker search to the penumbra
      // the Sun's disc gives far casters (filmShadowFilter.ts)
      if ((sky.sunLight.shadow as unknown as { filterNode?: unknown }).filterNode !== filmShadowFilter) {
        (sky.sunLight.shadow as unknown as { filterNode?: unknown }).filterNode = filmShadowFilter;
      }
      // THE BIAS FOLLOWS THE SUN (the 2026-10-29 raft clip: whole walls flickering lit/shadowed frame to frame — shadow
      // acne): a surface the Sun grazes drops by texel/tan(elevation) across one shadow texel, and a fixed 5 cm depth
      // bias (set to keep the contact shadows) was a fraction of that at a 9–14° morning Sun — its own shadow map
      // shadowed it, in patches that moved with the map. So the depth bias is that drop (×1.5) and the normal bias a
      // texel and a half: at a high Sun a few cm, so the contact shadows stay; at a low one what acne needs, no more
      // (capped at 0.2 m: at the w3–w5 Sun of 1–6° the full drop reached 0.6 m and erased the contact shadow of
      // anything smaller — every pebble and shell on the beach). Until 2026-11-01; now:
      {
        const texelM = (2 * skyParams.shadowExtent) / skyParams.shadowMapSize;
        const tanEl = Math.max(Math.tan(Math.asin(Math.min(1, Math.max(0.087, sun.y)))), 0.087);
        // THE RECEIVER'S PLANE (the 2026-11-01 review: "the stern tiller shadow is too far away" — that bias, 15.8 cm
        // along the light + 3.3 cm along the normal at 568 s, left the first 15–30 cm of every contact shadow lit):
        // the film's filter now compares each texel against the receiver's own plane (filmShadowFilter.ts), so the
        // constant bias only covers the curvature of a log or a sagging sail across the ±3-texel window and the map's
        // quantisation (and the facets' bend off the mesh's smooth normal): a third of a texel's drop, at most 3 cm,
        // and half a texel along the normal
        const planeM = Math.min(0.03, (0.3 * texelM) / tanEl);
        skyParams.shadowBias = -planeM / SHADOW_DEPTH_RANGE;
        skyParams.shadowNormalBias = 0.5 * texelM;
      }
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
      skyAt(t, eye.position, sun, d, b, sailing, renderer);
      seabedSun.value.copy(sun);
      sky.sunLight.color.copy(seaSky.sunColour);
      sky.sunLight.intensity = SUN_E;
      forest?.setEye(eye.position);
      beachDressing?.setEye(eye.position);
      forest?.setSun(sun, forestLight.copy(seaSky.sunColour).multiplyScalar(SUN_E));
      if (hemi) {
        hemi.color.copy(seaSky.irradiance);
        // THE LIGHT FROM BELOW: at sea the dark water's, 0.15 × the sky; on the coast the sunlit sand's bounce, its
        // albedo × (the Sun on it × sin(elevation) + the sky on it), in as the eye comes in from 40 m out to the
        // waterline (the 2026-10-29 review: pebbles, sticks and leaves "read blue-grey under the evening sky light"
        // — at a low Sun a shaded side lit by the blue sky alone; a beach lights everything warm from below)
        const onSand = world === 'coast' ? smooth01((40 - (beach.x - coastEye(t, c1End, beach).x)) / 40) : 0;
        hemi.groundColor.copy(seaSky.irradiance).multiplyScalar(0.15 * (1 - onSand));
        hemi.groundColor.add(sandBounce.copy(seaSky.sunColour).multiplyScalar(SUN_E * Math.max(sun.y, 0)).add(seaSky.irradiance).multiply(SAND_GROUND).multiplyScalar(onSand));
        hemi.intensity = 1;
      }
      (scene.fog as THREE.Fog).color.copy(seaSky.horizon);
      ocean.update(renderer, t);
      if (land.group.visible) {
        land.update(
          {
            time: t,
            windDir,
            windStrength: 0.4,
            swell: ocean.heightRms * 2,
            sunDirection: sun,
            hazeColor: (scene.fog as THREE.Fog).color,
            cameraPosition: eye.position,
          },
          (x, z) => heightAt(x, z, t),
        );
        swash?.update(renderer as unknown as THREE.WebGPURenderer, t);
      }
      const light = { sun: lum(seaSky.sunColour), sky: Math.min(1, lum(seaSky.irradiance) / 0.4) };
      // THE AIR THE SAILS STAND IN: the light air the raft runs before. At sea it blows along the raft's own
      // course and turns with it — the one sea faces into the sea's wind (its sail had been pressed back against
      // the mast all through seafaring, the v9 review), and a fixed air did it again as the raft swung round for
      // the dolphin — and it dies at last light (beats.ts airAt). The coast's is the sea's own wind; the waves
      // keep the sea's wind throughout.
      const windTo = sailing ? raftHeading : undefined;
      const windSpeed = sailing ? RIPPLE.windSpeed * airAt(t, beats.starts) : undefined;
      raft.update(t, raftX, raftZ, raftHeading, light, sails, speed, windTo, windSpeed);
      if (farOn) {
        // (each on its own heading off the course, not ours — ours swings broadside in c3; its lantern lit as our
        // raft's are, stepped down at night as the towers' beacons are: farRafts.ts)
        const lit = lanternNight((Math.asin(Math.min(1, Math.max(-1, sun.y))) * 180) / Math.PI) * nightStep(lum(seaSky.horizon));
        FAR_RAFTS.forEach(({ bearing, distance, off }, i) => {
          across(eyeYaw, (bearing * Math.PI) / 180, v);
          const heading = eyeYaw + Math.PI + off;
          const r = farRafts[i];
          r.update(t, eye.position.x + v.x * distance, eye.position.z + v.z * distance, heading);
          r.lamp.getWorldPosition(r.lampAt);
          r.lantern.update(r.lampAt, eye.position, lit * farIn);
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
          horizon: seaSky.horizon,
          sun,
          fieldEye,
          coastEyeAt,
          ground,
          towers: coast?.towers,
        });
      }
      if (debris) {
        debris.rotation.y = turn;
        du.sun.value.copy(sun);
        du.sunLight.value.set(seaSky.sunColour.r, seaSky.sunColour.g, seaSky.sunColour.b).multiplyScalar(SUN_E / Math.PI);
        du.skyLight.value.set(seaSky.irradiance.r, seaSky.irradiance.g, seaSky.irradiance.b).multiplyScalar(1 / Math.PI);
      }
      // (the world drawn sheds the wake only where it owns it: the coast's through their dissolve)
      if (o.drive && world !== 'test') {
        const w: WakeWorld = world === 'coast' ? 'coast' : 'sea';
        if (w === (t >= wakeFrom.coast ? 'coast' : 'sea')) wakeTo(t, w, renderer);
      }
      proxy.position.copy(eye.position);
      proxy.updateMatrixWorld();
      // (the ocean re-reads its params in update: each pass of a dissolve its own world's water)
      Object.assign(oceanSurfaceParams, SEA_COLOUR[world === 'coast' ? 'coast' : 'open']);
      surface.update(proxy, t, sun);
      // (on the coast, the islands' ground, rocks and low plants stay out of it: mirrored, even clipped at the
      // waterline, the far islands reflected as teal blocks, not dark mirror images — tried 2026-10-27, cause not
      // isolated, likely the terrain's own under-water tint near y = 0; the palms, the raft and the people are
      // mirrored)
      const underwater = world === 'coast' ? [land.group, ...(scannedRocks ? [scannedRocks.group] : []), ...(plants ? [plants.group] : [])] : [];
      // (before the mirror's capture, or the flock and the spray reflect the frame before)
      fu.time.value = flockT;
      fu.sun.value.copy(sun);
      // radiance of a white surface: the Sun's E·T/π facing it, the sky's irradiance/π
      fu.sunLight.value.set(seaSky.sunColour.r, seaSky.sunColour.g, seaSky.sunColour.b).multiplyScalar(SUN_E / Math.PI);
      fu.skyLight.value.set(seaSky.irradiance.r, seaSky.irradiance.g, seaSky.irradiance.b).multiplyScalar(1 / Math.PI);
      swashLight.sun.value.copy(fu.sunLight.value);
      swashLight.sky.value.copy(fu.skyLight.value);
      swashLight.dir.value.copy(sun);
      fu.eye.value.copy(eye.position);
      if (palms) {
        palms.setTime(t);
        palms.light.sun.copy(sun);
        palms.light.sunLight.copy(fu.sunLight.value);
        palms.light.skyLight.copy(fu.skyLight.value);
      }
      if (splashes) {
        const c3 = t - beats.starts.c3;
        const U = splashes.uniforms as unknown as Record<string, { value: unknown }>;
        splashes.mesh.visible = world === 'open' && c3 > DOLPHIN_SPAN[0] && c3 < DOLPHIN_SPAN[1] + 3;
        U.time.value = c3;
        (U.eye.value as THREE.Vector3).set(eye.position.x, 0, eye.position.z);
        U.yaw.value = eyeYaw;
        (U.sun.value as THREE.Vector3).copy(sun);
        (U.sunLight.value as THREE.Vector3).copy(fu.sunLight.value);
        (U.skyLight.value as THREE.Vector3).copy(fu.skyLight.value);
      }
      mirror.update(renderer, scene, eye.position, [surface.group, seaSky.mesh, ...underwater, ...(props ? props.glows : [])]);
    },
  };
  return act;
}
