/**
 * What happens at sea level beyond the sea, the sky and the raft (drift-narrative/wandering-on/direction.md),
 * each a pure function of the sea's clock and placed by the beat being drawn (beats.ts):
 *
 *   people     figures on the raft (c1–w2): STAND-INS — no models yet (the user's call, 2026-10-27: crude
 *              placeholders now, real assets in a later pass), but jointed figures, sitting and standing (crew.ts)
 *   dolphin    c3: porpoising in, circling the raft, then flips the blue case onto the deck with its snout
 *              (dolphin.ts: its outline and its motion)
 *   case       the blue hard case; in c4 its radio's dial glows
 *   beams      c4: signals made visible, arcing between far stations below the horizon across the sky,
 *              few at first, more as stations answer, until every station answers every other: a mystic rose
 *              over the dome — thin, slow, soft-edged, warm (direction.md); each station a radio tower on its
 *              island, the beams running lamp to lamp (radioTower.ts, the network's beacons); in w6 the coast's
 *              stations answer from their towers on the coast
 *   field      w3–w4: Drift 3, Act 1's pairs (events.ts, loops.ts) at a breath of their energy, every pair
 *              meeting its partner — no bursts, no remainder: sensed more than seen; and again in w6, over
 *              the eye as it rises into the night, among the stars. Drawn only in the dark (FIELD_DARK: since
 *              the 2026-10-30 QA sweep, not by day), so in w6 alone for now
 *   walkers    w5: the wanderers — the crew ashore (crew.ts) — small, walking on along the waterline into the dusk
 *
 * Sea-scene metres (x east, y up, z north).
 */
import * as THREE from 'three/webgpu';
import { Fn, abs, cameraPosition, float, normalWorld, positionLocal, positionWorld, sin, smoothstep, uniform, uv, vec3, vec4 } from 'three/tsl';
import { driftParams } from '../../params/drift';
import { generatePairs } from '../undertime/events';
import { spec } from './beats';
import { createLoopSprites, createLoopTrails, type LoopUniforms } from '../undertime/loops';
import type { Vec3 } from '../../cine/domeMaster';
import { DOLPHIN_SPAN, FLIP_RELEASE, caseOnDeck, createDolphin, flipThrow } from './dolphin';
import { createHardCase } from './hardCase';
import { dolphinPose } from './dolphin';
import { CREW, createCrewFigure, createCrewWalker, strideLength } from './crew';
import { FILM_COAST, FILM_RING, createRadioTower, type RadioTower } from './radioTower';
import { createFarMotu, farMotuMaterial, type FarMotu } from './farMotu';
import { farAir } from './farAir';
import { hash2Cpu } from '../../terrain/noiseCpu';
import { stationOf, type MastLamp } from '../../radio/network';
import { beaconLevelNode } from '../../radio/mast';
import type { AerialUniforms } from '../../terrain/aerialPerspective';

const smooth = (x: number): number => {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
};

/**
 * THE WANDERERS (w5) are the raft's three, ashore (crew.ts createCrewWalker: jointed, dressed as they were aboard),
 * walking on along the water's edge the way the flock went. They had been black box-limbed stand-ins that stepped
 * into frame from behind the eye 2–3 m off it — "one fills the left third of the frame at 682.5 … the crudest thing
 * in the act" (the 2026-10-30 QA sweep). Now they come up from behind along the WET SAND at the water's edge — the
 * line where the sand stands WALK_LEVEL m over the mean sea, found along the beach from the ground itself, so they
 * follow the shore's curve instead of a straight line that ran up the sand or into the sea — which keeps them
 * WALK_CLEAR m or more off the eye as they pass it (the eye holds 8 m up the beach: beats.ts COAST_KEYS). Behind the
 * eye they are under the tilted dome's back rim; they rise into it at the side and walk away ahead, small.
 */
const WALKERS: Array<{ crew: number; height: number }> = [
  { crew: 0, height: 1.78 },
  { crew: 1, height: 1.64 },
  { crew: 2, height: 1.72 },
];
/** m/s they walk at, s before w5 they set off, and where along the beach (beats.ts: `along`, m) the first starts */
const WALK_SPEED = 1.15;
const WALK_LEAD = 1;
const WALK_FROM = 4;
/** m over the mean sea: the wet sand they walk on (the swash's reach at dusk's calm: at 0.15 they walked a few
 * metres up from the dark wet band, the first round's 705 s still); and how they string out, one behind another
 * (s, m) */
const WALK_LEVEL = 0.06;
const WALK_FILE: [number, number] = [0.7, 1.5];
/** m along the beach the wet-sand line is averaged over (wetSand) */
const WET_SPAN = 12;
/** m: the nearest a wanderer comes to the eye (tests/driftCoastProps.test.ts holds it, on the coast's own ground;
 * the stand-ins passed it at 2.7) */
export const WALK_CLEAR = 6;

/**
 * Where wanderer i is at sea time t (beach coordinates, m: `along` up the beach, `off` out to sea; beats.ts), with how
 * far it has walked (m), given the beach's wet-sand line `edge(along)` (the off at which the sand stands WALK_LEVEL
 * over the sea). A pure function of t.
 */
/** the beach's wet-sand line: at `along`, the `off` (m, beach coordinates) where the sand falls through WALK_LEVEL
 * going out to sea (bisected between the upper beach and the shallows), averaged over WET_SPAN m along — the sand's
 * ripples move the line ±1 m within a few metres on a beach this flat (1:12), and the walkers zigzagged with it */
export function wetSand(ground: (x: number, z: number) => number, beach: { x: number; z: number }): (along: number) => number {
  const at = (along: number): number => {
    let land = -16;
    let sea = 8;
    const z = beach.z - along;
    for (let k = 0; k < 16; k++) {
      const mid = (land + sea) / 2;
      if (ground(beach.x - mid, z) > WALK_LEVEL) land = mid;
      else sea = mid;
    }
    return (land + sea) / 2;
  };
  return (along) => {
    let sum = 0;
    for (let k = -2; k <= 2; k++) sum += at(along + (k * WET_SPAN) / 4);
    return sum / 5;
  };
}

export function wanderer(i: number, t: number, w5: number, edge: (along: number) => number): { along: number; off: number; walked: number } {
  const walked = WALK_SPEED * Math.max(0, t - w5 + WALK_LEAD - i * WALK_FILE[0]);
  const along = WALK_FROM + walked - i * WALK_FILE[1];
  // (not quite in single file: a little landward or seaward of each other, wandering a little as they go)
  const off = edge(along) + (i - 1) * 0.45 + 0.2 * Math.sin(walked * 0.11 + i);
  return { along, off, walked };
}

/**
 * THE FIELD BY DAY (w3–w4) was read as faults: "white star-like sparkles near the clouds and thin streaks", a
 * "lens-flare ring" at the top of the 604 s frame, a round white blob by the waterline (the 2026-10-29 review; a
 * runtime A/B with the field hidden took every one of them out of the frame, and the stars, the clouds and the bloom
 * none). They were its white parts against the blue sky — each meeting's flash (a warm-white disc, up to 200 levels
 * over the sky in 8 bits), a bead's white-hot core and a fresh trail's white head (50–70 levels) — and one loop that
 * passed 2.5 m from the eye and drew its trail as a ring ~20° across. The direction asks for none of that: "very
 * faint … matter and antimatter colours meeting and leaving nothing. No fireballs … something you sense more than
 * see" (drift-narrative/wandering-on/direction.md, W3). So by day: no flashes, no white (loops.ts `hot`), the trails
 * at 0.4 of their old radiance, and no pair within FIELD_CLEARANCE of the eye. Measured against the same frame with
 * the field hidden: in the 604 s wide view's open sky 89 pixels more than 10 levels off became 7 (the most 55 → 13);
 * at 0.031° a pixel (between a 4K and an 8K master's) 5108 → 153 (203 → 56: a trail head's core, amber or blue, a
 * pixel or two). The night field (w6, among the stars) keeps its look.
 *
 * …AND THEN NO FIELD BY DAY AT ALL (the 2026-10-30 QA sweep before the clean full-show render, its one blocker: "the
 * daytime sky is full of white dots", ~25 in a 16:9 still and ~700 across a 2K dome master at 587–675 s, 2–3 px, 100+
 * levels over the sky; a runtime A/B with `drift-field` removed took every one out, 620 s: 23 → 0. The dimmed day look
 * above did not take them out at the cut's size.) The user's call for that render: the field's weight is 0 in daylight
 * and comes in only as the sky darkens toward w6's night — by the sky the pass is drawn under (`night`, from its Sun:
 * FIELD_DARK), not by the clock, so it cannot switch on in one frame as the day field did at the w3 window's edge
 * (586 s clean, 588 s full). In w6 the darkness is the w6 pass's own (its Sun at −17°: whole), brought in under the
 * dissolve's weight, and its pairs' rate ramps from 4 s into w6 over 18 s: the field fades in, it does not pop. The w3
 * pairs are still built (one tunable from coming back by day) but drawn at 0, so never drawn at all.
 */
/** the sky's darkness (PropsState.night, 0 day … 1 night: from the Sun's elevation, ~1° → −5.7°) over which the field
 * comes in: none at or below the first (w5's last light, the Sun at −3°, is 0.65), whole from the second */
const FIELD_DARK: [number, number] = [0.7, 1];
/** the field's weight under a sky of darkness `night` (PropsState.night): 0 by day and through dusk, 1 at night */
export const fieldWeight = (night: number): number => smooth((night - FIELD_DARK[0]) / (FIELD_DARK[1] - FIELD_DARK[0]));
/** m: no pair is born nearer the eye than this (a 0.5 m loop at 7 m spans 8°; at 2.5 m it was a 23° ring) */
const FIELD_CLEARANCE = 7;

export interface PropsState {
  /** sea s, and the beat's start times it is placed by */
  t: number;
  starts: { c3: number; c4: number; w1: number; w2: number; w3: number; w4: number; w5: number; w6: number };
  world: 'flood' | 'open' | 'coast' | 'test';
  eye: THREE.Vector3;
  /** the eye's front, a turn about y (beats.ts) */
  yaw: number;
  raft: THREE.Object3D;
  /** the beach's middle, and the w5 walkers' line (beats.ts: along runs toward −z) */
  beach: { x: number; z: number };
  /** the night's darkness 0..1 (the radio and the beams are lights against it) */
  night: number;
  /** the sky's radiance just above the horizon (linear): the stations' lamps step down against it at night */
  horizon: THREE.Color;
  /** the Sun (world, unit, toward it): the light the air scatters in front of the far islands (farAir.ts) */
  sun: THREE.Vector3;
  /** where the eye stands in w3 (the field gathers about it), and the ground's height (m, the sea's 0) */
  fieldEye: THREE.Vector3;
  /** where the eye is on the coast at sea time t (w6's field gathers over it as it rises) */
  coastEyeAt: (t: number) => THREE.Vector3;
  ground: (x: number, z: number) => number;
  /** the network's stations that stand on the coast and their lamps (coast.ts): the Rose answers from them in w6 */
  towers?: ReadonlyArray<{ id: string; lamp: [number, number, number] }>;
}

export interface Props {
  readonly group: THREE.Group;
  /** what the water's mirror leaves out: what glows (added light: the beams, the field) — its capture is cleared
   * transparent and would take their coverage for a dark body — and the Rose's islands, 7 km off: their reflection
   * lies in water from ~400 m out to the horizon, where the waves bend the lookup by more than the mirror's texels and
   * it broke into hard horizontal stripes under each island (the user, 2026-10-30, on a c2–c3 frame: "this can't look
   * like that"). A wavy sea 1–7 km off returns the sky's light there, as the ocean's own sky reflection does. (The
   * beams would reflect in the real sea, but high in the sky as they are, at the steep angles their reflections are
   * seen at near the eye, the water returns 2–3% of them: nothing beside the stars' glitter.) */
  readonly glows: THREE.Object3D[];
  /** resolves once the Rose's towers are built */
  readonly ready: Promise<void>;
  update(s: PropsState): void;
  setPixelAngle(rad: number): void;
}

/** the case's throw: m it rises over the higher of the snout and the deck (up against the afterglow), m/s² */
const CASE_LOB = 1.0;
/** m it skids on along the deck once it lands */
const CASE_SKID = 0.35;
const G_CASE = 9.81;
/** the beams: stations' bearings (deg right of the front), and which answer which, when (s into c4: LINKS). Each
 * station is a radio tower on a far motu on the horizon (STATION_*; farMotu.ts; which station of the network:
 * radioTower.ts FILM_RING): the beams start and end at its lamp, so they point at something (they had met in empty
 * sky just under the horizon: the v9 review) */
export const STATIONS = [-150, -95, -40, 10, 55, 105, 160];
if (FILM_RING.length !== STATIONS.length) throw new Error('props: the Rose has one station of the network per island');
/** m: how far the stations' islands lie; their seeds (farMotu.ts: the first of seven), and how far each one's long
 * axis turns from square-on to the eye (deg, seeded ±) */
const STATION_DIST = 7000;
const STATION_SEED = 11;
const STATION_TURN = 35;
/** a station's road on the water: its lamp's red (linear, unit luminance) and its peak radiance (scene units) —
 * under the night's exposure a deep red, as the lamp's own core is kept (radioTower.ts NIGHT) */
const ROAD_RED: [number, number, number] = [1, 0.045, 0.02].map((c) => c / (0.2126 + 0.7152 * 0.045 + 0.0722 * 0.02)) as [number, number, number];
const ROAD = 3e-3;
const UP = new THREE.Vector3(0, 1, 0);
/** EVERY STATION TO EVERY OTHER (the user, 2026-10-28: "connect each to each … have a cool little thing, like
 * shape appear"; it had been nine of the 21 links, and read lost): the ring of neighbours first, then the
 * heptagram's chords, then the widest — each round from the front, a beam every 1.8 s from 9 s into c4 */
const LINKS: Array<[number, number, number]> = [1, 2, 3].flatMap((skip, layer) =>
  [2, 3, 1, 4, 0, 5, 6].map((a, i): [number, number, number] => [a, (a + skip) % STATIONS.length, 9 + (layer * 7 + i) * 1.8]),
);
/** m: the sphere the beams' paths are laid out on (each is then drawn at its lamps' own distances: `chord`), and
 * their tube's radius there (soft: brightest at its core, a few pixels across in the master) */
const BEAM_R = 9000;
const BEAM_W = 30;
/** s the outro's Rose (w6) fades in over */
const BEAM_RETURN = 12;
/** rad an end of a beam turns by before its path is laid out again (0.13 px of the 4K master: the eye's bob at sea
 * turns the ring's lamps by less) */
const AIM_TURN = 1e-4;

export function createProps(): Props {
  const group = new THREE.Group();
  group.name = 'drift-props';

  // PEOPLE on the raft (raft-local: deck height found below, by a ray onto its planks)
  const people = new THREE.Group();
  // (crew.ts: jointed figures sitting and standing — the capsules were the 2026-10-29 notes' "capsule people")
  for (const c of CREW) {
    const f = createCrewFigure(c.pose, c.look);
    f.position.set(c.x, 0, c.z);
    f.rotation.y = c.rot;
    people.add(f);
  }
  let deckY: number | null = null;

  // THE DOLPHIN and THE CASE
  const dolphin = createDolphin();
  const fish = dolphin.group;
  group.add(fish);
  // (a moulded hard case, hardCase.ts: 0.55 × 0.22 × 0.40 m about its centre, as the blue box it was)
  const caseMesh = createHardCase(0x1f5fa8);
  const dialGlow = uniform(0);
  const dialMat = new THREE.MeshBasicNodeMaterial({ fog: false });
  dialMat.colorNode = vec3(1, 0.62, 0.25).mul(dialGlow);
  const dial = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.07), dialMat);
  dial.rotation.x = -Math.PI / 2;
  dial.position.set(0.08, 0.112, 0.05);
  caseMesh.add(dial);
  // the dial's glow, seen from across the deck (a soft halo facing the eye)
  const haloMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  haloMat.colorNode = Fn(() => {
    const d = uv().sub(0.5).length().mul(2);
    return vec4(vec3(1, 0.6, 0.25).mul(dialGlow.mul(0.35)).mul(float(1).sub(d).max(0).pow(2.5)), 1);
  })();
  const halo = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), haloMat);
  halo.position.set(0.08, 0.2, 0.05);
  caseMesh.add(halo);
  // and its light on the deck and the sails about it (always in the scene, so the light count never changes)
  const radioLight = new THREE.PointLight(0xffa35a, 0, 7, 2);
  radioLight.position.set(0.08, 0.35, 0.05);
  caseMesh.add(radioLight);
  group.add(caseMesh);

  // THE BEAMS: one tube per link on a sphere about the eye (it follows the eye: they are far)
  const beams = new THREE.Group();
  beams.name = 'drift-beams';
  const beamTime = uniform(0);
  const beamNight = uniform(0);
  // (the outro's network is the memory of c4's: fainter)
  const beamGain = uniform(1);
  const dirAt = (bearingDeg: number, elDeg: number): THREE.Vector3 => {
    const b = (bearingDeg * Math.PI) / 180;
    const e = (elDeg * Math.PI) / 180;
    return new THREE.Vector3(Math.sin(b) * Math.cos(e), Math.sin(e), -Math.cos(b) * Math.cos(e));
  };
  // THE STATIONS: a far motu on the horizon each (farMotu.ts: a low treed island, its outline, canopy and palms
  // seeded), lit by the scene and seen through 7 km of marine air (farAir.ts), and on it the station's own radio tower
  // (radioTower.ts, the network's mast for that station: FILM_RING), its red lamp the light the beams run to. They
  // had been flattened domes, 33–77 m high, drawn in the horizon's colour × 0.55 — "What exactly is this weird white
  // thing in the back? Is this supposed to be a super ugly island with the tower on it?" (the user, 2026-10-30, on a
  // c2–c3 frame: lit pale by the low Sun once the towers stood on them). (Their warm light 6 m over the island
  // retired, 2026-10-29: the beams join the beacons now, as the user put it, "the beacons that the radio in the game
  // is connecting to and also that the Rose was illustrating on the sky".)
  const stations = new THREE.Group();
  stations.name = 'drift-stations';
  /** the sky just over the horizon (linear): the lamps' night step (radioTower.ts filmLamp) */
  const uHorizon = uniform(new THREE.Color());
  /** s: the lamps' clock (the sea's) */
  const lampTime = uniform(0);
  const motuMat = farMotuMaterial(farAir.air);
  // …and its road on the water below it: a light on the horizon is a column of glitter down to the eye (the mirror
  // fades out at 2.5 km, the stations are 7 km off) — red now, blinking with its lamp, and far dimmer than the warm
  // light's was (ROAD: a deep red under the night's exposure, as the lamp's own core is kept)
  const roadMatFor = (lamp: MastLamp): THREE.MeshBasicNodeMaterial => {
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide });
    const level = beaconLevelNode(lampTime as unknown as THREE.Node<'float'>, lamp);
    m.colorNode = Fn(() => {
      const q = uv();
      const across = smoothstep(0.5, 0, q.x.sub(0.5).abs());
      // brightest toward the horizon (q.y = 1), broken into glints along it
      const along = float(0.2).add(q.y.pow(2).mul(0.8));
      const glint = sin(q.y.mul(173).add(beamTime.mul(2.1))).mul(sin(q.y.mul(61).sub(beamTime.mul(1.3)))).mul(0.5).add(0.5);
      return vec4(vec3(...ROAD_RED).mul(across.mul(along).mul(glint.pow(3)).mul(ROAD).mul(level).mul(beamNight).mul(beamGain)), 1);
    })();
    return m;
  };
  /** each station's lamp in the ring's frame (m: about the eye at the sea's level) */
  const beaconAt: THREE.Vector3[] = [];
  // one road along −z (turned to each bearing): a trapezoid from 150 m to the station, half-width ∝ distance
  const roadGeo = (() => {
    const g = new THREE.BufferGeometry();
    const n = 24;
    const pos: number[] = [];
    const uvs: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      // (spaced geometrically: as many rows near as far)
      const d = 150 * Math.pow(STATION_DIST / 150, u);
      const w = d * 0.0045;
      pos.push(-w, 0, -d, w, 0, -d);
      uvs.push(0, u, 1, u);
      if (i < n) idx.push(2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2);
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    return g;
  })();
  /** each station of the Rose: its id, its island, its tower and its road (a dead lamp has none) */
  const ring: Array<{ id: string; island: FarMotu; tower: RadioTower; road: THREE.Mesh | null }> = [];
  STATIONS.forEach((bearing, i) => {
    const id = FILM_RING[i];
    const spec = stationOf(id).mast;
    const island = createFarMotu(STATION_SEED + i, motuMat);
    const at = dirAt(bearing, 0).multiplyScalar(STATION_DIST);
    // its long axis across the line of sight, turned a little (a band on the horizon, not a mound)
    const turn = ((-bearing + STATION_TURN * (2 * hash2Cpu(i * 7.3 + 1.1, 3.7) - 1)) * Math.PI) / 180;
    island.mesh.position.set(at.x, 0, at.z);
    island.mesh.rotation.y = turn;
    stations.add(island.mesh);
    // the island's land (in the ring's frame), for the tower's foot and its guys' anchors: the motu's own frame is
    // `along` its x, `across` its z, turned by `turn`
    const c = Math.cos(turn);
    const sn = Math.sin(turn);
    const ground = (x: number, z: number): number => {
      const dx = x - at.x;
      const dz = z - at.z;
      return island.land(dx * c - dz * sn, dx * sn + dz * c);
    };
    const [sa, sc] = island.site;
    const foot: [number, number] = [at.x + sa * c + sc * sn, at.z - sa * sn + sc * c];
    // (its first leg toward the eye; seen through the same 7 km of marine air as its island)
    const tower = createRadioTower({ ground, at: foot, toward: [0, 0] }, spec, { air: farAir.air, haze: uHorizon as unknown as AerialUniforms['color'] });
    stations.add(tower.group);
    beaconAt.push(new THREE.Vector3(...tower.lamp));
    let road: THREE.Mesh | null = null;
    if (spec.lamp.alive) {
      // the road: flat on the sea from near the eye out to the island's foot, a constant ~0.5° wide as seen from
      // the eye (a strip of constant width is a sub-pixel line at the horizon and a slab close by)
      road = new THREE.Mesh(roadGeo, roadMatFor(spec.lamp));
      road.rotation.y = (-bearing * Math.PI) / 180;
      // (1.6 m over the mean sea, under the night eye (2.2 m and up): lower, the sea hid it; from 150 m out, as a
      // road comes in to the one who sees it)
      road.position.y = 1.6;
      // (after the sea: both transparent, sorted by place, and the sea writes depth)
      road.renderOrder = 2;
      stations.add(road);
    }
    ring.push({ id, island, tower, road });
  });
  group.add(stations);

  /** a direction as the dome's fisheye draws it about the zenith (equidistant: the zenith at 0, the horizon at 1) */
  const flat = (d: THREE.Vector3): THREE.Vector2 => {
    const r = Math.acos(Math.min(1, Math.max(-1, d.y))) / (Math.PI / 2);
    const l = Math.hypot(d.x, d.z);
    return new THREE.Vector2((d.x / l) * r, (d.z / l) * r);
  };
  /** from station to station, lamp to lamp (on the beams' sphere, along the lamps' own directions): the STRAIGHT
   * CHORD between them as the fisheye draws the sky about the zenith, so the 21 make the rose's figure overhead — a
   * neighbour's an arch ~10° up, the widest pass ~20° from the zenith (7 stations: none opposite) */
  const chord = (a: THREE.Vector3, b: THREE.Vector3): THREE.BufferGeometry => {
    const A = flat(a);
    const B = flat(b);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 64; i++) {
      const q = A.clone().lerp(B, i / 64);
      const th = (q.length() * Math.PI) / 2;
      const l = Math.max(q.length(), 1e-9);
      pts.push(new THREE.Vector3((q.x / l) * Math.sin(th), Math.cos(th), (q.y / l) * Math.sin(th)).multiplyScalar(BEAM_R));
    }
    return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 160, BEAM_W, 8, false);
  };
  /** m: each station's lamp from the beams' origin (the eye) — where its beams end */
  const reach = beaconAt.map(() => uniform(STATION_DIST));
  const tubes: THREE.Mesh[] = [];
  for (const [a, b, at] of LINKS) {
    const geo = chord(beaconAt[a].clone().normalize(), beaconAt[b].clone().normalize());
    // DEPTH-TESTED, AT THE LAMPS' OWN DISTANCES (the user, 2026-10-30, on a dusk frame from the water by the beach:
    // "These rose lines are drawn on top of both the trees and the sails and the boat and everything … it looks like
    // a cheap overlay"). Added light that writes no depth, after everything opaque — so whatever stands nearer than a
    // beam hides it. Each is laid out on the BEAM_R sphere and drawn pushed in or out along its own directions to
    // its lamps' distances (log-interpolated from end to end: 7 km round the Rose's ring, from a few hundred metres
    // to 7.6 km between the coast's towers in w6): the figure the eye sees is the same, the tube's width the same
    // angle, and it ends IN its lamp — behind the trees and the masts in front of it, never over the near land, the
    // raft and its sails, and inside the face cameras' far plane (sea.ts FAR, 12 km) everywhere. A world-space tube,
    // so it runs on across the dome's cube faces as any geometry does.
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthTest: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide });
    mat.positionNode = positionLocal.mul(reach[a].mul(reach[b].div(reach[a]).pow(uv().x)).div(BEAM_R));
    const start = uniform(at);
    mat.colorNode = Fn(() => {
      const u = uv().x;
      // it grows from the station that calls to the one that answers over 4 s, then a slow pulse runs along it
      const grown = smoothstep(u.sub(0.04), u, beamTime.sub(start).div(4));
      const pulse = sin(u.mul(18).sub(beamTime.mul(0.9))).mul(0.25).add(0.75);
      // soft-edged: brightest where the tube faces the eye
      const facing = abs(normalWorld.dot(cameraPosition.sub(positionWorld).normalize())).pow(3);
      const ends = smoothstep(0, 0.01, u).mul(smoothstep(1, 0.99, u));
      // the haze: low over the sea a beam is seen through kilometres more air, and dims into the horizon
      const up = positionWorld.sub(cameraPosition).normalize().y;
      const haze = smoothstep(-0.01, 0.2, up).mul(0.75).add(0.25);
      const k = grown.mul(pulse).mul(facing).mul(ends).mul(haze).mul(beamNight);
      return vec4(vec3(1, 0.74, 0.42).mul(k.mul(0.025).mul(beamGain)), 1);
    })();
    const tube = new THREE.Mesh(geo, mat);
    tube.frustumCulled = false;
    tubes.push(tube);
    beams.add(tube);
  }
  group.add(beams);
  /** THE BEAMS RE-AIMED: each link run between the lamps at `lamps` (m from the eye, the beams' frame) — their
   * distances every frame, their paths rebuilt only where an end turned by more than AIM_TURN (in w6 the coast's
   * stations answer from their coast towers, seen from an eye that rises; at sea, the ring) */
  const aimed = beaconAt.map((v) => v.clone().normalize());
  const dirs = beaconAt.map(() => new THREE.Vector3());
  const aim = (lamps: THREE.Vector3[]): void => {
    lamps.forEach((v, i) => {
      reach[i].value = v.length();
      dirs[i].copy(v).normalize();
    });
    const moved = dirs.map((d, i) => d.angleTo(aimed[i]) > AIM_TURN);
    if (!moved.some(Boolean)) return;
    LINKS.forEach(([a, b], k) => {
      if (!moved[a] && !moved[b]) return;
      const g = chord(dirs[a], dirs[b]);
      const geo = tubes[k].geometry;
      for (const name of ['position', 'normal']) {
        const to = geo.getAttribute(name) as THREE.BufferAttribute;
        (to.array as Float32Array).set(g.getAttribute(name).array as Float32Array);
        to.needsUpdate = true;
      }
      geo.computeBoundingSphere();
      g.dispose();
    });
    dirs.forEach((d, i) => aimed[i].copy(d));
  };
  const lampsFrom = beaconAt.map(() => new THREE.Vector3());

  // THE FIELD (Drift 3): Act 1's grammar on the beach, at a breath of its energy
  const P = driftParams;
  const fieldU = {
    time: uniform(0),
    pixelAngle: uniform(0.0015),
    fog: uniform(0),
    matter: uniform(new THREE.Color(P.matterColor)),
    anti: uniform(new THREE.Color(P.antimatterColor)),
    light: uniform(new THREE.Color(P.lightColor)),
    trailRadiance: uniform(0),
    beadRadiance: uniform(0),
    flashRadiance: uniform(0),
    hot: uniform(0),
    eye: uniform(new THREE.Vector3()),
    pocket: {
      domeAxis: uniform(new THREE.Vector3(0, 1, 0)),
      domeFront: uniform(new THREE.Vector3(0, 0, -1)),
      domeRight: uniform(new THREE.Vector3(1, 0, 0)),
      pocketLo: uniform(0),
      pocketHi: uniform(0),
      pocketAz: uniform(0),
      pocket: uniform(0),
    },
  };
  let fieldBuilt: { trails: THREE.Object3D; sprites: THREE.Object3D } | null = null;
  const fieldGroup = new THREE.Group();
  fieldGroup.name = 'drift-field';
  group.add(fieldGroup);

  // THE WALKERS (w5): the crew ashore, walking (THE WANDERERS)
  const walkers = new THREE.Group();
  const walkerShapes = WALKERS.map((w) => createCrewWalker(CREW[w.crew].look, w.height));
  walkerShapes.forEach((w) => walkers.add(w.group));
  group.add(walkers);

  const tmp = new THREE.Vector3();
  const deckAt = new THREE.Vector3(0.6, 0, -1.4);
  // the top of what stands on the raft at raft-local (x, z), under anything over 1.3 m (the roof, the sail): a ray
  // straight down in the raft's frame
  const deckRay = new THREE.Raycaster();
  const deckTop = (x: number, z: number): THREE.Vector3 => {
    const r = raftOf.current!;
    deckRay.set(new THREE.Vector3(x, 6, z).applyMatrix4(r.matrixWorld), new THREE.Vector3(0, -1, 0).transformDirection(r.matrixWorld));
    const ys = deckRay.intersectObject(r, true).map((h) => r.worldToLocal(h.point.clone()).y).filter((y) => y < 1.3);
    return new THREE.Vector3(x, ys.length ? Math.max(...ys) : 0.6, z);
  };
  const raftOf: { current: THREE.Object3D | null } = { current: null };
  return {
    group,
    glows: [beams, fieldGroup, stations],
    ready: Promise.all(ring.map((r) => r.tower.ready)).then(() => undefined),
    setPixelAngle(rad) {
      fieldU.pixelAngle.value = rad;
    },
    update(s) {
      const { t, starts, world, raft } = s;
      raftOf.current = raft;
      // people ride the raft wherever it goes
      if (deckY === null) {
        // where each stands, found by a ray down onto the raft (raft-local): out from under the cabin's roof
        // (anything over 1.5 m), on the top of what is there (deck, crates: under 1.3 m)
        raft.updateMatrixWorld(true);
        const ray = new THREE.Raycaster();
        const footing = (x: number, z: number): THREE.Vector3 => {
          for (let k = 0; k < 16; k++) {
            const zz = z + Math.sign(z || 1) * 0.5 * k;
            ray.set(new THREE.Vector3(x, 6, zz).applyMatrix4(raft.matrixWorld), new THREE.Vector3(0, -1, 0));
            const ys = ray.intersectObject(raft, true).map((h) => raft.worldToLocal(h.point.clone()).y);
            if (ys.some((y) => y > 1.5)) continue;
            const under = ys.filter((y) => y < 1.3);
            return new THREE.Vector3(x, under.length ? Math.max(...under) : 0.6, zz);
          }
          return new THREE.Vector3(x, 0.6, z);
        };
        people.children.forEach((f) => {
          f.position.copy(footing(f.position.x, f.position.z));
        });
        deckAt.copy(footing(deckAt.x, deckAt.z)).add(new THREE.Vector3(0, 0.11, 0));
        deckY = deckAt.y;
        raft.add(people);
      }
      // (aboard until the raft, aground, is far behind the eye on the beach: gone sooner, they popped out of a
      // raft in plain view as it ran in)
      const aboard = t < starts.w3 + 25;
      people.visible = world !== 'test' && aboard;

      // THE DOLPHIN (dolphin.ts), in the eye's level frame: x right, z ahead
      const c3 = t - starts.c3;
      fish.visible = world === 'open' && c3 > DOLPHIN_SPAN[0] && c3 < DOLPHIN_SPAN[1];
      if (fish.visible) {
        const d = dolphinPose(c3);
        tmp.set(d.x, 0, -d.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), s.yaw).add(s.eye);
        fish.position.set(tmp.x, d.y, tmp.z);
        // (its body along −z: heading 0 is ahead, −z in the eye's frame)
        fish.rotation.set(d.pitch, s.yaw - d.heading, -d.bank, 'YXZ');
        dolphin.set(d);
      }

      // THE CASE: flicked from the dolphin's snout as it rises in the flip, on the way it was going, and down on
      // the fore-deck it was thrown at (dolphin.ts CASE_ON_DECK): a ballistic lob from the snout, CASE_LOB m over the
      // higher end, landing on whatever is on the deck there (found from above in the raft's own frame); then aboard
      const cf = c3 - FLIP_RELEASE;
      caseMesh.visible = world !== 'test' && aboard && cf > 0;
      if (caseMesh.visible) {
        raft.updateMatrixWorld(true);
        const throwAt = flipThrow();
        const toWorld = (x: number, y: number, z: number): THREE.Vector3 =>
          new THREE.Vector3(x, 0, -z).applyAxisAngle(new THREE.Vector3(0, 1, 0), s.yaw).add(new THREE.Vector3(s.eye.x, y, s.eye.z));
        const from = toWorld(...throwAt.from);
        // the spot in the raft's own frame and its flight's direction there (for the skid), from c3's pose
        // (dolphin.ts caseOnDeck), and the deck's top there (pure in t: the raft's pose now)
        const onDeck = caseOnDeck();
        const spot = new THREE.Vector3(onDeck.spot[0], 0, onDeck.spot[1]);
        const spotDir = new THREE.Vector3(onDeck.dir[0], 0, onDeck.dir[1]).normalize();
        const end = raft.localToWorld(deckTop(spot.x, spot.z).add(new THREE.Vector3(0, 0.11, 0)));
        const apex = Math.max(from.y, end.y) + CASE_LOB;
        const vy0 = Math.sqrt(2 * G_CASE * (apex - from.y));
        const flight = vy0 / G_CASE + Math.sqrt((2 * (apex - end.y)) / G_CASE);
        const heading = s.yaw - Math.atan2(throwAt.dir[0], throwAt.dir[1]);
        if (cf < flight && world === 'open') {
          const u = cf / flight;
          caseMesh.position.lerpVectors(from, end, u);
          caseMesh.position.y = from.y + vy0 * cf - 0.5 * G_CASE * cf * cf;
          // tumbling end over end about the axis across its flight, a turn and a half, landing flat
          caseMesh.rotation.set(0, heading, 0, 'YXZ');
          caseMesh.rotateX(-u * Math.PI * 3);
        } else {
          // LANDED: it hits the deck, hops twice and skids to a stop along its flight (so it reads as landing ON
          // something), then sits there aboard, riding the raft
          const k = cf - flight;
          const hop = (a: number, at: number, len: number): number => (k > at && k < at + len ? a * Math.sin((Math.PI * (k - at)) / len) : 0);
          const skid = CASE_SKID * (1 - Math.exp(-k / 0.25));
          const settle = raft.worldToLocal(end.clone());
          settle.x += (spotDir.x * skid);
          settle.z += (spotDir.z * skid);
          caseMesh.position.copy(raft.localToWorld(settle)).add(new THREE.Vector3(0, hop(0.22, 0, 0.3) + hop(0.07, 0.3, 0.18), 0));
          caseMesh.rotation.set(0, heading, 0, 'YXZ');
          caseMesh.rotateX(-0.25 * hop(1, 0, 0.3));
        }
      }
      // the radio: its dial glows from c4 on (with the static's flicker), dark again by day
      const radio = smooth((t - starts.c4 + 2) / 4) * (1 - smooth((t - starts.w1 + 3) / 6));
      dialGlow.value = radio * (0.85 + 0.15 * Math.sin(t * 7.3) * Math.sin(t * 2.1)) * 6;
      radioLight.intensity = (dialGlow.value / 6) * 0.08;

      // THE BEAMS: about the eye, in c4's night
      beams.visible = (world === 'open' && t > starts.c4 - 6) || (world === 'coast' && t > starts.w6 - 6);
      beams.position.copy(s.eye);
      beams.rotation.set(0, s.yaw, 0);
      // the stations' islands are on the open sea's horizon all along (the coast's are the archipelago's)
      stations.visible = world === 'open' || beams.visible;
      stations.position.set(s.eye.x, 0, s.eye.z);
      stations.rotation.set(0, s.yaw, 0);
      (uHorizon.value as THREE.Color).copy(s.horizon);
      beamTime.value = t - starts.c4;
      beamNight.value = s.night;
      // (in w6 the Rose comes back with every link long grown, so it fades in over BEAM_RETURN from its window's start
      // instead of switching on whole in one frame over the dusk sky — the 2026-10-30 night-ramp clip, 704 s)
      beamGain.value = world === 'coast' ? 0.4 * smooth((t - (starts.w6 - 6)) / BEAM_RETURN) : 1;
      lampTime.value = t;
      for (const r of ring) r.tower.setTime(t);
      // IN W6 THE COAST'S STATIONS ANSWER FROM THEIR COAST TOWERS (radioTower.ts FILM_COAST): their ring islands go,
      // and their beams run to the coast towers' lamps as the rising eye sees them; the other three stay on the ring
      // (the ring's −40° island had stood right in front of the high island, whose station it is)
      const fromCoast = world === 'coast' && s.towers !== undefined && s.towers.length > 0;
      for (const r of ring) {
        const here = !(fromCoast && FILM_COAST[r.id] !== undefined);
        r.island.mesh.visible = here;
        r.tower.group.visible = here;
        if (r.road) r.road.visible = here;
      }
      if (beams.visible) {
        ring.forEach((r, i) => {
          const at = fromCoast ? s.towers!.find((x) => x.id === r.id) : undefined;
          // each lamp from the eye, in the beams' frame (turned with the eye's yaw): a coast tower's from the world,
          // a ring station's from the stations' frame (about the eye at the sea's level)
          if (at) lampsFrom[i].set(at.lamp[0] - s.eye.x, at.lamp[1] - s.eye.y, at.lamp[2] - s.eye.z).applyAxisAngle(UP, -s.yaw);
          else lampsFrom[i].copy(beaconAt[i]).setY(beaconAt[i].y - s.eye.y);
        });
        aim(lampsFrom);
      }
      // the far islands' air, from this eye under this Sun (farAir.ts; the coast's own update asks the same)
      if (stations.visible) farAir.update(s.eye, s.sun);

      // THE FIELD: w3 swells and settles; it fades through w4
      if (!fieldBuilt && world === 'coast') {
        const events = generatePairs(
          {
            seed: 2103,
            rate: (x) => 30 * smooth((x - starts.w3) / 14) * (1 - smooth((x - starts.w4 - 10) / 20)),
            from: starts.w3 - 2,
            to: starts.w5,
            centre: () => [s.fieldEye.x, s.fieldEye.y + 3, s.fieldEye.z - 12],
            radius: 16,
            // (from the eye where it is at each birth: it glides ~7 m along the beach through w3–w4)
            eye: (x) => s.coastEyeAt(x).toArray() as Vec3,
            clearance: FIELD_CLEARANCE,
            loopRadius: [0.15, 0.5],
            loopTime: [1.2, 2.4],
          },
          30,
        ).filter((e) => e.meets === 1);
        // w6: over the eye as it rises into the night, wider and slower, the loops larger (seen from tens of
        // metres, against the stars)
        const night = generatePairs(
          {
            seed: 2106,
            rate: (x) => 25 * smooth((x - starts.w6 - 4) / 18),
            from: starts.w6 - 2,
            to: starts.w6 + spec('w6')!.length,
            centre: (x) => {
              const e = s.coastEyeAt(x);
              return [e.x, e.y + 24, e.z - 18];
            },
            radius: 34,
            eye: (x) => s.coastEyeAt(x).toArray() as Vec3,
            clearance: 7,
            loopRadius: [0.5, 1.6],
            loopTime: [1.6, 3.2],
          },
          25,
        ).filter((e) => e.meets === 1);
        events.push(...night);
        for (const e of events) {
          // no creation burst; and under the energy that draws photons and gammas (loops.ts: rays only above 0.45)
          e.burst = 0;
          e.energy = Math.min(0.4, e.energy * 0.5);
        }
        const U = fieldU as unknown as LoopUniforms;
        fieldBuilt = { trails: createLoopTrails(events, U), sprites: createLoopSprites(events, U) };
        fieldGroup.add(fieldBuilt.trails, fieldBuilt.sprites);
      }
      // (only in the dark: FIELD_DARK — by day it is not drawn at all, the 2026-10-30 QA sweep)
      const dark = fieldWeight(s.night);
      fieldGroup.visible = world === 'coast' && dark > 0 && ((t > starts.w3 - 3 && t < starts.w5) || t > starts.w6 - 3);
      fieldU.time.value = t;
      fieldU.eye.value.copy(s.eye);
      // at the edge of seeing (direction: "like heat shimmer or dust in sunlight"; brighter, the beads read as
      // stars by day in the v9 review)
      // (at night the eye has opened to the stars: the same radiance read as scribbles over the Milky Way)
      fieldU.trailRadiance.value = 0.06 * 0.6 * dark;
      fieldU.beadRadiance.value = 0.02 * 0.6 * dark;
      fieldU.flashRadiance.value = 0.02 * 0.6 * dark;
      fieldU.hot.value = 1;

      // THE WALKERS: from behind the eye on its left, along the wet sand at the water's edge, the way the flock went
      walkers.visible = world === 'coast' && t > starts.w5 - WALK_LEAD;
      if (walkers.visible) {
        const edge = wetSand(s.ground, s.beach);
        walkerShapes.forEach((w, i) => {
          const p = wanderer(i, t, starts.w5, edge);
          const x = s.beach.x - p.off;
          const z = s.beach.z - p.along;
          // facing along their way (−z, with the shore's turn: the line a metre ahead)
          const ahead = edge(p.along + 1) - edge(p.along - 1);
          w.group.position.set(x, Math.max(-0.05, s.ground(x, z)), z);
          w.group.rotation.y = Math.atan2(ahead, 2);
          w.stride(p.walked / strideLength(WALKERS[i].height));
        });
      }
    },
  };
}
