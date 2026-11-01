/**
 * What happens at sea level beyond the sea, the sky and the raft (drift-narrative/wandering-on/direction.md),
 * each a pure function of the sea's clock and placed by the beat being drawn (beats.ts):
 *
 *   people     figures on the raft (c1–w2): STAND-INS — no models yet (the user's call, 2026-10-27: crude
 *              placeholders now, real assets in a later pass), but jointed figures, sitting and standing (crew.ts)
 *   dolphin    c3: porpoising in, circling the raft, then flips the blue case onto the deck with its snout
 *              (dolphin.ts: its outline and its motion)
 *   case       the blue hard case; in c4 its radio's dial glows
 *   beams      c4: signals made visible, arcing between far stations below the horizon across the sky: the
 *              network wakes (our radio crackles, the station ahead answers, the rest light tower by tower from
 *              it), until every station answers every other: a mystic rose over the dome — slow, soft, warm
 *              (direction.md). Each station a radio tower on its island, the arcs light in the haze running
 *              lamp to lamp (radioTower.ts, the network's beacons), messages as pulses along them, each lamp
 *              flaring as one reaches it (roseTraffic.ts); in w6 the quieter chatter, the coast's stations
 *              answering from their towers on the coast
 *   field      w3–w4: Drift 3, Act 1's pairs (events.ts, loops.ts) at a breath of their energy, every pair
 *              meeting its partner — no bursts, no remainder: sensed more than seen; and again in w6, over
 *              the eye as it rises into the night, among the stars. Drawn only in the dark (FIELD_DARK: since
 *              the 2026-10-30 QA sweep, not by day), so in w6 alone for now
 *   walkers    w5: the wanderers — the crew ashore (crew.ts) — small, walking on along the waterline into the dusk
 *
 * Sea-scene metres (x east, y up, z north).
 */
import * as THREE from 'three/webgpu';
import { Fn, acos, asin, cameraPosition, cos, cross, exp, float, mix, modelPosition, normalize, sin, smoothstep, step, uniform, uv, vec3, vec4 } from 'three/tsl';
import { driftParams } from '../../params/drift';
import { generatePairs } from '../undertime/events';
import { spec } from './beats';
import { createLoopSprites, createLoopTrails, type LoopUniforms } from '../undertime/loops';
import type { Vec3 } from '../../cine/domeMaster';
import { CASE_FROM, DOLPHIN_SPAN, FLIP_AT_T, FLIP_RELEASE, NOSE_AT, caseAfloat, caseOnDeck, createDolphin, flipThrow } from './dolphin';
import { createHardCase } from './hardCase';
import { dolphinPose } from './dolphin';
import { CREW, createCrewFigure, createCrewWalker, strideLength } from './crew';
import { FILM_COAST, FILM_RING, createRadioTower, type RadioTower } from './radioTower';
import { createFarMotu, farMotuMaterial, type FarMotu } from './farMotu';
import { farAir } from './farAir';
import { hash2Cpu } from '../../terrain/noiseCpu';
import { stationOf, type MastLamp } from '../../radio/network';
import { beaconLevelNode } from '../../radio/mast';
import { chatterTraffic, dialFlare, roseLinks, stationFlare, wakeTraffic, type RoseMessage } from './roseTraffic';
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

/**
 * WANDERING, NOT MARCHING (the user, 2026-11-01: "the people could be more wandery"). They had walked one pace in
 * near single file, 0.45 m apart across, all the way. Now each keeps a pace of their own that drifts (±10% over ~11 s,
 * ±5% over ~4 s) and stops for what catches them (WANDER_STOPS: by time, s into w5 — looking out over the water,
 * stooping to pick something off the wet sand, a glance back at the others, a look along the tree line); and their way
 * wanders across the beach by the metres walked (WANDER_DRIFTS: up the dry sand and back, ankle-deep into the swash
 * after a find), so they drift apart and together. Lateral moves are by distance, so no one slides sideways standing
 * still, and they face their own way along it. Near the eye (`along` < 24 m: it holds at 12) they keep to the water's
 * edge — WALK_CLEAR holds there.
 */
interface WanderStop {
  /** s into w5 it starts and ends (the pace eases out and back in over STOP_EASE s round them) */
  at: number;
  end: number;
  /** what they do: look (rad, + to their left: the sea), or stoop to the sand */
  look?: number;
  stoop?: boolean;
}
const STOP_EASE = 0.8;
/** each one's pace (m/s) and its drift's phase; their stops (s into w5); their drifts across the beach (m walked
 * from, to, m: − up the beach, + toward the sea; eased in and out over a third of it each) */
const WANDER: Array<{ pace: number; stops: WanderStop[]; drifts: Array<[number, number, number]>; catchUp?: [number, number, number] }> = [
  { pace: 1.12, stops: [{ at: 15.5, end: 19.5, look: 0.9 }, { at: 41, end: 44, stoop: true }], drifts: [[30, 60, -1.2]] },
  // (the hat: stoops for a shell early, then catches up, wading out a little where it found it; a glance back)
  { pace: 1.05, stops: [{ at: 9, end: 12, stoop: true }, { at: 27, end: 29, look: -1.1 }], drifts: [[12, 30, 0.6], [38, 70, -0.8]], catchUp: [12.5, 24, 0.18] },
  // (wanders up the dry sand toward the trees, stops to look along them, and comes back down)
  { pace: 1.18, stops: [{ at: 30, end: 33.5, look: -0.7 }], drifts: [[18, 40, -3]] },
];
const smoothRamp = (a: number, b: number, x: number): number => smooth(Math.min(1, Math.max(0, (x - a) / (b - a))));
/** m/s wanderer i walks at, τ s into w5 (0 before it sets off) */
function wanderPace(i: number, tau: number): number {
  const w = WANDER[i];
  let v = WALK_SPEED * (w.pace / 1.12) * (1 + 0.1 * Math.sin((2 * Math.PI * tau) / 11 + 2 * i) + 0.05 * Math.sin((2 * Math.PI * tau) / 4.3 + i));
  for (const st of w.stops) v *= 1 - smoothRamp(st.at - STOP_EASE, st.at, tau) * (1 - smoothRamp(st.end, st.end + STOP_EASE, tau));
  if (w.catchUp) v *= 1 + w.catchUp[2] * smoothRamp(w.catchUp[0], w.catchUp[0] + 2, tau) * (1 - smoothRamp(w.catchUp[1] - 2, w.catchUp[1], tau));
  return v;
}
/** m across the beach (+ to sea) wanderer i strays from the water's edge, `walked` m into its walk at `along` */
function wanderLane(i: number, walked: number, along: number): number {
  let lane = (i - 1) * 0.45 + (0.35 * Math.sin(walked * 0.13 + 2 * i) + 0.2 * Math.sin(walked * 0.31 + i)) * smoothRamp(16, 30, along);
  for (const [a, b, d] of WANDER[i].drifts) {
    const third = (b - a) / 3;
    lane += d * smoothRamp(a, a + third, walked) * (1 - smoothRamp(b - third, b, walked)) * smoothRamp(16, 30, along);
  }
  return lane;
}
/** s of the walk's integration steps (midpoint: every frame the same sum for the same t) */
const WALK_STEP = 0.05;

export function wanderer(i: number, t: number, w5: number, edge: (along: number) => number): { along: number; off: number; walked: number; phase: number; amp: number; stoop: number; look: number; heading: number } {
  const tau = t - w5;
  const start = -WALK_LEAD + i * WALK_FILE[0];
  // the distance walked and the strides taken, summed from the start: a slower walk takes shorter strides
  const height = WALKERS[i].height;
  const strideOf = (v: number): number => strideLength(height) * (0.55 + 0.45 * Math.min(1, v / WALK_SPEED));
  let walked = 0;
  let phase = 0;
  const span = Math.max(0, tau - start);
  const n = Math.floor(span / WALK_STEP);
  for (let k = 0; k < n; k++) {
    const v = wanderPace(i, start + (k + 0.5) * WALK_STEP);
    walked += v * WALK_STEP;
    phase += (v / strideOf(v)) * WALK_STEP;
  }
  const rest = span - n * WALK_STEP;
  const vNow = span > 0 ? wanderPace(i, tau) : 0;
  if (rest > 0) {
    const v = wanderPace(i, start + n * WALK_STEP + rest / 2);
    walked += v * rest;
    phase += (v / strideOf(v)) * rest;
  }
  const along = WALK_FROM + walked - i * WALK_FILE[1];
  const offAt = (w: number): number => edge(WALK_FROM + w - i * WALK_FILE[1]) + wanderLane(i, w, WALK_FROM + w - i * WALK_FILE[1]);
  const off = offAt(walked);
  // facing its way: the path's turn per metre walked (defined standing still too)
  const heading = Math.atan2(offAt(walked + 0.5) - offAt(walked - 0.5), 1);
  let stoop = 0;
  let look = 0;
  for (const st of WANDER[i].stops) {
    const on = smoothRamp(st.at - 0.2, st.at + 0.9, tau) * (1 - smoothRamp(st.end - 0.6, st.end + 0.4, tau));
    if (st.stoop) stoop = Math.max(stoop, on);
    if (st.look) look += st.look * on;
  }
  return { along, off, walked, phase, amp: smoothRamp(0, 0.5, vNow) * (0.6 + 0.4 * Math.min(1, vNow / WALK_SPEED)), stoop, look, heading };
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
/** the field's share on the coast at t under a sky this dark: only in its own beats (w3's field to w5, and w6's
 * night), and there only in the dark — so not in w1's dark arrival from the sea's night (the 2026-11-01 dawn: the
 * night is the network's, the field comes later) */
export const fieldOnCoast = (t: number, starts: { w3: number; w5: number; w6: number }, night: number): number =>
  (t > starts.w3 - 3 && t < starts.w5) || t > starts.w6 - 3 ? fieldWeight(night) : 0;
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
  /** the sea's height (m) at a world x, z now: what the floating case rides (sea.ts heightAt) */
  water?: (x: number, z: number) => number;
  /** the network's stations that stand on the coast and their lamps (coast.ts): the Rose answers from them in w6 */
  towers?: ReadonlyArray<{ id: string; lamp: [number, number, number]; flare?(f: number): void }>;
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

/** the case's throw: m it rises over the higher of the snout and the deck — over the horizon, against the afterglow
 * (1.0 m: it stayed under the horizon line, in the glitter, and read as a dark dot; 2026-11-01) — and m/s² */
const CASE_LOB = 1.5;
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
 * shape appear"; it had been nine of the 21 links, and read lost): the ring of neighbours, the heptagram's chords and
 * the widest (roseTraffic.ts roseLinks; what runs along them, and when: roseTraffic.ts) */
const LINKS = roseLinks(STATIONS.length);
/** s the outro's Rose (w6) fades in over */
const BEAM_RETURN = 12;
/** s c4's beams take to go quiet, ending 7 s before w1 (its dissolve starts 5 s before it) */
const BEAM_QUIET = 10;
/**
 * THE ARCS AS LIGHT IN THE HAZE (the 2026-11-01 review of the Rose, the user and the client: "pasted on, slapped on,
 * cheap, not blending"). They had been 21 tubes of a constant 30 m radius, each lit whole once grown, a slow ripple
 * along it, dimmed toward the horizon — a drawn line. Now each is a camera-facing ribbon carrying a soft profile: a
 * thin core where a pulse is, and round it the glow the air scatters, both shaped by the air the arc runs through:
 * brighter and broader low, where the marine haze is thick (its density falls off over HAZE_H m of height), fainter
 * toward the zenith (to ARC.floor of it), softer the farther it is. Angles in degrees across the arc (σ of a gaussian).
 *
 *   segments  along the ribbon
 *   ext       the ribbon runs on this share of its arc past each lamp, so a flaring lamp's glow is round, not cut
 *   core      σ of a pulse's core aloft (×(1 + 0.6·density) low; 0.044° is a 4K master's pixel)
 *   halo      σ of the haze's glow aloft (×(0.6 + 0.8·density))
 *   floor     the air's scatter aloft, of the low air's
 *   flick     deg along the arc a lamp's own blink carries into it (its rhythm, not the network's)
 *   glow      σ of a lamp's answer flare in the haze about it
 */
const ARC = { segments: 256, ext: 0.03, core: 0.06, halo: 0.5, floor: 0.3, flick: 5, glow: 0.35 };
/** m: the marine haze's scale height (the boundary layer's aerosol, thickest within a kilometre or two of the sea) */
const HAZE_H = 1500;
/** a pulse (roseTraffic.ts): its head's σ (s, at TRAVEL.speed ~6° of arc), its short trail's and its afterglow's time
 * constants (s) and shares — the path a message has just run along glows on in the haze and fades. (A 1 s trail at
 * 0.55 and a 6 s afterglow, the first look, 2026-11-01: under the night's exposure every arc a message had crossed
 * stayed a full bright line for seconds — the drawn line again)
 */
const PULSE = { head: 0.35, trail: 0.6, trailK: 0.35, long: 4, longK: 0.12 };
/** radiances (scene units, at the night's exposure; the drawn tubes had peaked at 0.025): a pulse's core, the haze's
 * glow about it, the faint glow a lit path keeps between messages (halo only: no line), a lamp's flare in the haze */
// (rest 0.0022, then 0.0015: under w6's and c4's night exposure every lit path stayed a soft full line converging on its
// lamp — the drawn Rose again; at 0.0004 a path is barely sensed between its messages)
const ARC_L = { core: 0.035, halo: 0.01, rest: 0.0004, flare: 0.012 };
/** the light's colours (linear): the pulse's warm white, the haze's amber (the raft's dial's own), a lamp's red-amber */
const ARC_CORE: [number, number, number] = [1, 0.84, 0.6];
const ARC_HALO: [number, number, number] = [1, 0.62, 0.3];
const ARC_LAMP: [number, number, number] = [1, 0.3, 0.12];
/** the dial's crackle as the network first answers: × its glow at the peak (roseTraffic.ts dialFlare) */
const DIAL_FLARE = 2.2;

/** THE ARC'S PATH (CPU mirror of `arcPath` in createProps): from lamp `a` to lamp `b` (m from the eye) at `u` 0 … 1 — the
 * STRAIGHT CHORD between them as the dome's fisheye draws the sky about the zenith (equidistant: the zenith at 0, the
 * horizon at 1), so the 21 make the rose's figure overhead (a neighbour's an arch ~10° up, the widest pass ~20° from the
 * zenith), at a distance log-interpolated between the lamps' own (so it ends IN each lamp, depth-tested) */
export function arcPoint(a: THREE.Vector3, b: THREE.Vector3, u: number): THREE.Vector3 {
  const flatOf = (d: THREE.Vector3): THREE.Vector2 => {
    const n = d.clone().normalize();
    const r = Math.acos(Math.min(1, Math.max(-1, n.y))) / (Math.PI / 2);
    const l = Math.max(Math.hypot(n.x, n.z), 1e-9);
    return new THREE.Vector2((n.x / l) * r, (n.z / l) * r);
  };
  const q = flatOf(a).lerp(flatOf(b), u);
  const l = Math.max(q.length(), 1e-9);
  const th = (l * Math.PI) / 2;
  const r = a.length() * Math.pow(b.length() / a.length(), u);
  return new THREE.Vector3((q.x / l) * Math.sin(th), Math.cos(th), (q.y / l) * Math.sin(th)).multiplyScalar(r);
}
/** deg: the arc's length as the eye sees it */
export function arcDegrees(a: THREE.Vector3, b: THREE.Vector3): number {
  let deg = 0;
  let p = arcPoint(a, b, 0).normalize();
  for (let i = 1; i <= 128; i++) {
    const q = arcPoint(a, b, i / 128).normalize();
    deg += (p.angleTo(q) * 180) / Math.PI;
    p = q;
  }
  return deg;
}

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

  // THE BEAMS: one ribbon per link, about the eye (it follows the eye; each arc's path is laid out in its shader from
  // its two lamps, every frame)
  const beams = new THREE.Group();
  beams.name = 'drift-beams';
  const beamTime = uniform(0);
  const beamNight = uniform(0);
  // (the outro's network is the memory of c4's: fainter)
  const beamGain = uniform(1);
  /** each station's answer flare, 0 … ~1.5 (roseTraffic.ts stationFlare): its lamp, its road and its arcs' ends */
  const flareU = STATIONS.map(() => uniform(0));
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
  const roadMatFor = (lamp: MastLamp, i: number): THREE.MeshBasicNodeMaterial => {
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide });
    // (and it flares with its lamp as a message reaches the station)
    const level = beaconLevelNode(lampTime as unknown as THREE.Node<'float'>, lamp).add(flareU[i]);
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
      road = new THREE.Mesh(roadGeo, roadMatFor(spec.lamp, i));
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

  /** each station's lamp from the eye (m, world axes: the beams' group stands at the eye, unturned) — set every frame
   * from the very lamp positions the towers are drawn at, so every arc ends in its lamps however the eye moves */
  const lampU = beaconAt.map((v) => uniform(v.clone()));
  /** m: the eye over the sea (the air's density is by height) */
  const eyeY = uniform(0);
  /** each lamp's own blink (dead: none), for the arcs' ends */
  const levelN = STATIONS.map((_, i) => {
    const lamp = stationOf(FILM_RING[i]).mast.lamp;
    return lamp.alive ? beaconLevelNode(lampTime as unknown as THREE.Node<'float'>, lamp) : null;
  });
  type F = THREE.Node<'float'>;
  type V3 = THREE.Node<'vec3'>;
  /** the arc from A to B at u (TSL mirror of `arcPoint`) */
  const arcPath = (A: V3, B: V3, u: F): V3 => {
    const flatOf = (d: V3) => {
      const n = d.normalize();
      return n.xz.div(n.xz.length().max(1e-6)).mul(acos(n.y.clamp(-1, 1)).div(Math.PI / 2));
    };
    const q = mix(flatOf(A), flatOf(B), u);
    const l = q.length().max(1e-6);
    const th = l.mul(Math.PI / 2);
    const ra = A.length();
    const r = ra.mul(B.length().div(ra).pow(u));
    return vec3(q.x.div(l).mul(sin(th)), cos(th), q.y.div(l).mul(sin(th))).mul(r) as V3;
  };
  /** the eye in the beams' frame */
  const camL = cameraPosition.sub(modelPosition) as V3;
  /** rad between two unit directions (well-conditioned at small angles, as acos is not) */
  const angle = (p: V3, q: V3): F => asin(p.sub(q).length().mul(0.5).min(1)).mul(2) as F;
  const DEG = Math.PI / 180;
  /** the air about a point of the arc: its density (0 … 1, by height over the sea), its haze's σ across and its core's (rad) */
  const airAt = (P: V3) => {
    const density = exp(P.y.add(eyeY).max(0).div(-HAZE_H));
    const far = P.sub(camL).length().div(7000).clamp(0.3, 1.5);
    const halo = density.mul(0.8).add(0.6).mul(ARC.halo * DEG).mul(far.mul(0.3).add(0.7));
    const core = density.mul(0.6).add(1).mul(ARC.core * DEG).mul(far.mul(0.3).add(0.7));
    return { density, halo, core };
  };
  /** a pulse's slot: (t0 sea s, dur s, dir +1 from a / −1 from b, unused: t0 far ahead) */
  const NONE = 1e7;
  const SLOTS = 3;
  const links = LINKS.map(([a, b]) => {
    const slots = Array.from({ length: SLOTS }, () => uniform(new THREE.Vector3(NONE, 1, 1)));
    // the first message along it in this window: the path glows faintly once that has run (never before)
    const first = uniform(new THREE.Vector3(NONE, 1, 1));
    const g = new THREE.BufferGeometry();
    const pos: number[] = [];
    const uvs: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= ARC.segments; i++) {
      const u = -ARC.ext + ((1 + 2 * ARC.ext) * i) / ARC.segments;
      pos.push(0, 0, 0, 0, 0, 0);
      uvs.push(u, 0, u, 1);
      if (i < ARC.segments) idx.push(2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2);
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    // DEPTH-TESTED, AT THE LAMPS' OWN DISTANCES (the user, 2026-10-30, on a dusk frame from the water by the beach:
    // "These rose lines are drawn on top of both the trees and the sails and the boat and everything … it looks like
    // a cheap overlay"). Added light that writes no depth, after everything opaque — so whatever stands nearer than an
    // arc hides it: it ends IN its lamps, behind the trees and the masts in front of it, never over the near land, the
    // raft and its sails, and inside the face cameras' far plane (sea.ts FAR, 12 km) everywhere.
    // LAID OUT IN THE SHADER FROM ITS LAMPS, EVERY FRAME (the same review: "their position doesn't always align with
    // the towers when they fade in"). The tubes' paths were rebuilt on the CPU only when an end had turned by more than
    // 1e-4 rad, and every end's reference was reset at each rebuild, so a link whose two ends each moved a little was
    // never rebuilt and drifted off its lamps — by an amount that hung on the frames drawn before (a render lane
    // starting elsewhere drew it elsewhere). Now nothing is kept: the vertex shader lays the path from the two lamp
    // uniforms and faces the ribbon to the eye, so it runs on across the dome's cube faces (one eye for all six).
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthTest: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide });
    const A = lampU[a] as unknown as V3;
    const B = lampU[b] as unknown as V3;
    mat.positionNode = Fn(() => {
      const u = uv().x;
      const P = arcPath(A, B, u);
      const dP = arcPath(A, B, u.add(1e-3)).sub(arcPath(A, B, u.sub(1e-3)));
      const toEye = camL.sub(P);
      const side = normalize(cross(dP, toEye));
      // (3 σ of the haze's glow each side: the ribbon holds all of its light)
      const half = airAt(P).halo.mul(3);
      return P.add(side.mul(uv().y.mul(2).sub(1).mul(toEye.length()).mul(half)));
    })();
    mat.colorNode = Fn(() => {
      const u = uv().x;
      const P = arcPath(A, B, u);
      const air = airAt(P);
      const dir = P.sub(camL).normalize();
      // the angle across the arc, and along it from each lamp
      const across = uv().y.mul(2).sub(1).mul(air.halo.mul(3));
      const fromA = angle(dir, A.sub(camL).normalize());
      const fromB = angle(dir, B.sub(camL).normalize());
      const inside = step(0, u).mul(step(u, 1));
      // THE PULSES: each slot's head, and behind it the trail and the afterglow of the path it has just run along
      let coreK: F = float(0);
      let haloK: F = float(0);
      for (const slot of slots) {
        const sl = slot as unknown as V3;
        const s = u.mul(sl.z).add(float(1).sub(sl.z).mul(0.5));
        const tau = lampTime.sub(sl.x).sub(s.mul(sl.y));
        // (squares as products: WGSL's pow is undefined for a negative base)
        const h = tau.div(PULSE.head);
        const head = exp(h.mul(h).negate());
        const after = tau.max(0);
        const trail = step(0, tau).mul(exp(after.div(-PULSE.trail)).mul(PULSE.trailK));
        const long = step(0, tau).mul(exp(after.div(-PULSE.long)).mul(PULSE.longK));
        // (the core is the pulse and its short trail; the afterglow is the haze's alone)
        coreK = coreK.add(head.add(trail)) as F;
        haloK = haloK.add(head.mul(0.8).add(trail.mul(0.5)).add(long)) as F;
      }
      // a lit path's rest: faint, glow only
      const fs = u.mul(first.z).add(float(1).sub(first.z).mul(0.5));
      const lit = smoothstep(0, 3, lampTime.sub(first.x).sub(fs.mul(first.y)));
      // EACH LAMP'S OWN RHYTHM near it: the arc dims between its flashes and brightens with them (a dead lamp: none)
      const rhythm = (lv: F | null, from: F): F =>
        lv ? (exp(from.div(-ARC.flick * DEG)).mul(lv.mul(0.9).sub(0.35)).add(1) as F) : float(1);
      const flick = rhythm(levelN[a], fromA).mul(rhythm(levelN[b], fromB));
      const xc = across.div(air.core);
      const xh = across.div(air.halo);
      const coreProfile = exp(xc.mul(xc).negate());
      const haloProfile = exp(xh.mul(xh).negate());
      // the core keeps its light however soft it is drawn (σ against its aloft σ)
      const coreL = coreK.mul(coreProfile).mul(ARC_L.core).mul(float(ARC.core * DEG).div(air.core));
      const haloL = haloK.mul(ARC_L.halo).add(lit.mul(ARC_L.rest)).mul(haloProfile);
      // the air's scatter: more where it is dense, ARC.floor of it aloft
      const scatter = air.density.mul(1 - ARC.floor).add(ARC.floor);
      // (under the horizon: nothing — the ribbon runs on past a lamp, down toward the sea)
      const above = smoothstep(-0.006, 0, dir.y);
      const arc = vec3(...ARC_CORE).mul(coreL).add(vec3(...ARC_HALO).mul(haloL)).mul(inside).mul(flick).mul(scatter);
      // A LAMP'S ANSWER in the haze about it, as a message reaches it (and its own lamp flares: radioTower.ts setFlare)
      const glowAt = (f: unknown, from: F): F => exp(from.mul(from).add(across.mul(across)).div(-((ARC.glow * DEG) ** 2))).mul(f as F) as F;
      const lamps = vec3(...ARC_LAMP).mul(glowAt(flareU[a], fromA).add(glowAt(flareU[b], fromB)).mul(ARC_L.flare));
      return vec4(arc.add(lamps).mul(above).mul(beamNight).mul(beamGain), 1);
    })();
    const ribbon = new THREE.Mesh(g, mat);
    ribbon.frustumCulled = false;
    beams.add(ribbon);
    return { slots, first };
  });
  group.add(beams);
  /** the arcs' lengths as the eye at sea sees them (deg; the ring's lamps from 2.2 m over the sea): how long a pulse takes */
  const arcDeg = LINKS.map(([a, b]) => arcDegrees(beaconAt[a].clone().setY(beaconAt[a].y - 2.2), beaconAt[b].clone().setY(beaconAt[b].y - 2.2)));
  /** the traffic (roseTraffic.ts), laid once the beats' starts are known: per link, its messages by time, and each
   * window's first; and all of them by time, for the flares */
  let traffic: { all: RoseMessage[]; byLink: RoseMessage[][] } | null = null;
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

      // THE CASE: afloat in the debris from far out, drifting down on the raft as it sails (dolphin.ts caseAfloat), nosed
      // by the dolphin, lifted on its snout as it comes up under it, flicked off it on the way it was going, and down on
      // the fore-deck it was thrown at (dolphin.ts CASE_ON_DECK): a ballistic lob from the snout, CASE_LOB m over the
      // higher end, landing on whatever is on the deck there (found from above in the raft's own frame); then aboard.
      // (It had appeared out of nowhere at the flip, flying; afloat first, the audience has seen it before the dolphin
      // finds it — the 2026-11-01 review: "make it easier to understand what's happening")
      const cf = c3 - FLIP_RELEASE;
      const afloat = world === 'open' && c3 > CASE_FROM && cf <= 0;
      caseMesh.visible = world !== 'test' && ((aboard && cf > 0) || afloat);
      if (afloat) {
        const toWorld = (x: number, z: number): THREE.Vector3 =>
          new THREE.Vector3(x, 0, -z).applyAxisAngle(new THREE.Vector3(0, 1, 0), s.yaw).add(new THREE.Vector3(s.eye.x, 0, s.eye.z));
        const [ax, az] = caseAfloat(c3);
        const at = toWorld(ax, az);
        // riding the swell: on the water's height there, tilted with its slope (0.4 m across), a third of its 0.22 m
        // out of the water; it comes up out of the swell over its first 3 s, ~60 m out
        const h = (x: number, z: number): number => (s.water ? s.water(x, z) : 0);
        const y = h(at.x, at.z);
        const sx = (h(at.x + 0.3, at.z) - h(at.x - 0.3, at.z)) / 0.6;
        const sz = (h(at.x, at.z + 0.3) - h(at.x, at.z - 0.3)) / 0.6;
        const rise = Math.min(1, Math.max(0, (c3 - CASE_FROM) / 3));
        caseMesh.position.set(at.x, y + 0.04 - 0.4 * (1 - rise * rise * (3 - 2 * rise)), at.z);
        // turning slowly as it drifts; and the nose rocks it (a damped sway about the axis across the push)
        const push = c3 - NOSE_AT;
        const rock = push > 0 ? 0.45 * Math.exp(-push / 0.7) * Math.sin(push * 6.5) : 0;
        caseMesh.rotation.set(Math.atan(sz) + rock, s.yaw + 0.6 + 0.04 * c3, -Math.atan(sx), 'YXZ');
        // UP ON THE SNOUT from just before the dolphin leaves the water to the release: eased from the water onto its
        // beak (dolphin.ts flipThrow's own reach, 1.3 m), a little above it, nose-up with the head
        const lift = c3 - (FLIP_AT_T - 0.3);
        if (lift > 0) {
          const d = dolphinPose(c3);
          const beak = toWorld(d.x + Math.sin(d.heading) * 1.3 * Math.cos(d.pitch), d.z + Math.cos(d.heading) * 1.3 * Math.cos(d.pitch));
          beak.y = d.y + 1.3 * Math.sin(d.pitch);
          const k = Math.min(1, lift / 0.3);
          const w = k * k * (3 - 2 * k);
          caseMesh.position.lerp(beak.setY(Math.max(beak.y, caseMesh.position.y)), w);
          // (and turned onto the throw's heading, as its flight below starts: no turn at the release)
          const th = flipThrow();
          const onThrow = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, s.yaw - Math.atan2(th.dir[0], th.dir[1]), 0, 'YXZ'));
          caseMesh.quaternion.slerp(onThrow, w);
        }
      }
      if (caseMesh.visible && !afloat) {
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
      // the radio: its dial glows from c4 on (with the static's flicker), through the night and the change to the coast
      // in the dark, and goes out with the morning: as the Sun nears the horizon, ~22–32 s into w1 (beats.ts w1 `rise`:
      // first light ~19 s, the Sun up ~32 s). It went out over w1's first 3 s, before the dawn — "the radio goes dark
      // at w1's start", the 2026-11-01 review
      const radio = smooth((t - starts.c4 + 2) / 4) * (1 - smooth((t - starts.w1 - 22) / 10));
      // …and it CRACKLES as the network first answers (roseTraffic.ts dialFlare: the static rises, holds while the
      // station ahead answers, settles), its flicker deeper while it does — but slow, no flashing
      const crackle = dialFlare(t, starts.c4);
      const flicker = 0.85 + (0.15 + 0.25 * crackle) * Math.sin(t * 7.3) * Math.sin(t * 2.1);
      dialGlow.value = radio * flicker * (1 + DIAL_FLARE * crackle) * 6;
      radioLight.intensity = (dialGlow.value / 6) * 0.08;

      // THE BEAMS: about the eye, in c4's night
      beams.visible = (world === 'open' && t > starts.c4 - 6) || (world === 'coast' && t > starts.w6 - 6);
      beams.position.copy(s.eye);
      beams.rotation.set(0, 0, 0);
      // the stations' islands are on the open sea's horizon all along (the coast's are the archipelago's)
      stations.visible = world === 'open' || beams.visible;
      stations.position.set(s.eye.x, 0, s.eye.z);
      stations.rotation.set(0, s.yaw, 0);
      (uHorizon.value as THREE.Color).copy(s.horizon);
      beamTime.value = t - starts.c4;
      beamNight.value = s.night;
      eyeY.value = s.eye.y;
      // (in w6 the Rose comes back, so it fades in over BEAM_RETURN from its window's start instead of switching on in
      // one frame over the dusk sky — the 2026-10-30 night-ramp clip, 704 s)
      // (and c4's goes quiet over its last seconds, gone before w1's dissolve: the dissolve changes the world in the dark
      // and the night lifts into the morning after it — beams on one side and none on the other crossfaded, the
      // network fading out as the island faded in, the 2026-11-01 review: "abrupt and blendy")
      const roseIn = world === 'coast' ? smooth((t - (starts.w6 - 6)) / BEAM_RETURN) : 1 - smooth((t - (starts.w1 - 17)) / BEAM_QUIET);
      beamGain.value = world === 'coast' ? 0.4 * roseIn : roseIn;
      lampTime.value = t;
      for (const r of ring) r.tower.setTime(t);
      // THE TRAFFIC (roseTraffic.ts), once: c4's wake and w6's chatter, pure in the beats' starts
      if (!traffic) {
        const wake = wakeTraffic(starts.c4, LINKS, arcDeg, STATIONS.length).messages;
        const chatter = chatterTraffic(starts.w6 - 6, starts.w6 + spec('w6')!.length + 10, LINKS, arcDeg);
        const all = [...wake, ...chatter].sort((x, y) => x.t0 - y.t0);
        traffic = { all, byLink: LINKS.map((_, k) => all.filter((m) => m.link === k)) };
      }
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
      // each station's answer flare: its lamp (on the ring and on the coast), its road, its arcs' ends — c4's quiet
      // and w6's return fade them with the arcs
      ring.forEach((r, i) => {
        const f = stationFlare(t, i, traffic!.all, LINKS) * roseIn;
        flareU[i].value = f;
        r.tower.setFlare(f);
        s.towers?.find((x) => x.id === r.id)?.flare?.(f);
      });
      if (beams.visible) {
        ring.forEach((r, i) => {
          const at = fromCoast ? s.towers!.find((x) => x.id === r.id) : undefined;
          // each lamp from the eye (world axes): a coast tower's from the world, a ring station's from the stations'
          // frame (about the eye at the sea's level, turned with its yaw) — where the towers are drawn this frame
          if (at) lampsFrom[i].set(at.lamp[0] - s.eye.x, at.lamp[1] - s.eye.y, at.lamp[2] - s.eye.z);
          else lampsFrom[i].copy(beaconAt[i]).applyAxisAngle(UP, s.yaw).setY(beaconAt[i].y - s.eye.y);
          (lampU[i].value as THREE.Vector3).copy(lampsFrom[i]);
        });
        // each link's pulses: its last SLOTS messages to have left (or about to: a head glows a moment before), and
        // the first of this window (c4's before w1, w6's after)
        const from = world === 'coast' ? starts.w6 - 6 : -Infinity;
        const to = world === 'coast' ? Infinity : starts.w1;
        links.forEach((l, k) => {
          const ms = traffic!.byLink[k].filter((m) => m.t0 >= from && m.t0 < to);
          const gone = ms.filter((m) => m.t0 <= t + 1);
          const dirOf = (m: RoseMessage): number => (m.from === 0 ? 1 : -1);
          l.slots.forEach((u, j) => {
            const m = gone[gone.length - 1 - j];
            (u.value as THREE.Vector3).set(m ? m.t0 : NONE, m ? m.dur : 1, m ? dirOf(m) : 1);
          });
          const f = ms[0];
          (l.first.value as THREE.Vector3).set(f ? f.t0 : NONE, f ? f.dur : 1, f ? dirOf(f) : 1);
        });
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
      const dark = fieldOnCoast(t, starts, s.night);
      fieldGroup.visible = world === 'coast' && dark > 0;
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
          // facing along their way (−z, with its turns: wanderer), turned a little more as they look round
          w.group.position.set(x, Math.max(-0.05, s.ground(x, z)), z);
          w.group.rotation.y = p.heading + 0.25 * p.look;
          w.pose(p);
        });
      }
    },
  };
}
