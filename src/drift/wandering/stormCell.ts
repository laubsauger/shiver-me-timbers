/**
 * THE DISTANT STORM (Part C at sea, c2–c4; params/drift.ts `distantStorm`, OFF by default): one cumulonimbus cell on
 * the horizon, the 2026-11-02 next-level review's move 4, phase 1 ("The near miss: weather as radio interference";
 * drift-narrative/next-level-2026-11-02.md) — "A shelf cloud stands on the horizon from c2, unremarked. In c4 the cell
 * flickers silently inside itself, low on the horizon. Each flash spits sferics into the dial's static … The cell
 * clears just before the call." The sea state does not change, there is no rain near the eye, no beat moves.
 *
 * WHY A VOLUME OF ITS OWN, not the cumulus layer (clouds.ts): the layer is a shell 1.2–2.3 km above the sea marched to
 * 45 km, its light volume 16 layers through that 1.1 km. A cumulonimbus is 1.3–13 km tall, and to stand on the
 * horizon as a far cell (not a wall overhead) it has to be ~55 km off — past the layer's reach, ten times its height.
 * Raising the layer's top would thin every fair-weather cumulus' light volume tenfold and change the approved skies.
 * So the cell is its own analytic shape, marched only along the rays that cross its footprint (a bounding circle,
 * ~30° of azimuth and 10° of elevation), in the sky's own shader (seaSky.ts `withClouds`): it takes the same light
 * as the cumulus — the air's sunlight at each sample's height and own Sun elevation (`sunAt`, so the Earth's shadow
 * climbs it at dusk: the base goes dark while the anvil, 12 km up, keeps the Sun ~3° longer), the droplets' phase
 * function and Wrenninge's octaves (clouds.ts `cloudPhase`, OCTAVES), the light diffusing deep into a thick body
 * (DIFFUSION), the bath of sky and sea light (seaSky.ts `cloudBath`) — and sits in the same air (cloudAir.ts
 * `airTo`), so 55 km of sunset haze reddens and veils it as it does the sky beside it.
 *
 * THE SHAPE (`stormField`), a COMPOSITION of clouds, as a real cell is (since the 2026-11-03 night frames; phase 1's one
 * carved body — a leaning cylinder, a dome, a plate — showed a ruled vertical flank square to the anvil's underside,
 * "a straight-up right angle", once the night had thinned the other clouds away): the main updraft a stack of cumulus
 * masses leaning downshear; flanking towers at their own stages on both sides, stepping down, some merged, some
 * apart; the overshooting top a hard dome; the anvil a sheet of ice spread downwind along the upper wind (ANVIL_TO),
 * thick over the tower, thinning and fraying to fibres at its edge (the cirrus' look); a flat base with a shelf along
 * its front, scud under it and a grey rain shaft fading toward the sea (partly beyond the curve of the sea: at 55 km
 * the horizon hides its first ~0.25 km). Every piece is read through one slow domain warp, so no line in it is
 * ruled; the masses take the cumulus' own billows (the shape volume's Perlin–Worley, scripts/drift-cloud-noise.py),
 * rising slowly (RISE), and the detail volume's last ~350 m.
 *
 * THE FLICKER (`stormFlashes`): intracloud lightning only, an emission term inside the march — a flash lights the
 * cloud around its channel from within (the light diffuses out over ~LIGHTNING_REACH of cloud before it leaves it), on
 * a seeded schedule that is a pure function of the show's clock: from c3's last light on into c4's night (the
 * review's "end of c3 to c4", carried into the night at the 56e951c master: "it could look really cool at night"),
 * never in the radio's moments (`radioMoments`: the dial waking, the calls, the answer, the cascade's landings — the
 * flashes fall in the waits between them), at most one flash per FLASH_GAP[0] s, each 2–4 soft pulses over ~0.2–0.7 s (the
 * multi-stroke flicker of real intracloud flashes: a fast rise, a decay of ~0.1 s, the channel moving on between
 * pulses), dim — and by night held to the eye's opening (`lightningGain`). Never a bolt (no channel is drawn, only the cloud's glow), never near the zenith (the cell is ≤10° up),
 * never a full-dome flash (the light is the cell's alone: nothing else in the scene is lit by it).
 *
 * THE CLEARING: the cell builds out of the haze in c1's sunset time-lapse (GROW) and dies over c4's last stretch
 * (CLEAR: the tower collapsing, its body eroding from the thin edges in as a dying cell's does), gone before w1's
 * dissolve. Phase 1 had it gone before the dial woke, so the call went out under a clear sky; the user kept it into
 * the night (2026-11-03), and the call still goes out with no flash in it — the cell far off to the right, quiet
 * through the call, the answer and each landing, still the reason the sail was struck (beats.ts SAIL_STRIKE).
 *
 * THE SFERICS: each flash spits into the radio. `dialStutter` is the dial's glow stuttering with it where the dial is
 * lit (props.ts), and scripts/drift-sferics-cues.ts writes the flash times out as a cue sheet for the composer — there
 * is no sound layer in the film itself.
 *
 * FILM ONLY: nothing in src/sky or src/ocean changes; built only when `?distantStorm=1` is in the page's query (as
 * biolum is), so with it off every shader is the one the approved cut drew.
 */
import * as THREE from 'three/webgpu';
import { Break, If, Loop, exp, float, fract, max, min, mix, select, smoothstep, sqrt, texture3D, uniform, vec2, vec3 } from 'three/tsl';
import { blueNoise } from './blueNoise';
import { DIFFUSE, DIFFUSION, DIFFUSION_SKIN, OCTAVES, POWDER, SEA_UP, cloudPhase, type CloudData, type CloudUniforms } from './clouds';
import { C1_FOLLOW, type BeatName } from './beats';
import { CALL, CALLS, FLASH, callPulses, type CallPulse } from './roseTraffic';
import { driftParams } from '../../params/drift';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

const R = 6.371e6;

// ── WHERE ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/** deg right of the open sea's front (the eye's level frame, c1's rest yaw): the cell's core. Between the Rose's
 * stations 10° and 55° right (props.ts STATIONS: its base, ~±4.5° wide, clears both by 25° and 10°), 62° round from c2–c4's
 * Sun (−22°, beats.ts): off the sunset's road and the glare, side-lit, so its Sun-facing flank and its top take the
 * low Sun's pink and gold while the far side and the base lie in shade; and 80° from the station that answers (−40°,
 * roseTraffic.ts WAKE_FROM). Inside the row-8 seat view (±68°) and right of the raft in c3–c4 (it lies 10–12° right,
 * ~±17° wide broadside: beats.ts POSE_KEYS) */
export const STORM_BEARING = 40;
/** m from the eye: far enough to stand on the horizon as a far cell (its top ~13° up, the curve of the sea hiding its
 * first ~0.25 km; thunder carries ~20 km, so it is silent), near enough that its anvil and dome stand clear over c2's
 * starboard sail (~11° high at this bearing: at 72 km the whole cell hid behind it through c2, the first stills) and
 * the air leaves it a shape, not a smudge */
export const STORM_DIST = 55000;
/** deg (as STORM_BEARING): the way the upper wind carries the anvil — to the right and a little away, so it is seen
 * nearly broadside (its full spread) and stays above the horizon's stations, the flanking line stepping down on the
 * upwind side, toward the raft */
const ANVIL_TO = 115;

// ── THE SHAPE: A COMPOSITION OF CLOUDS (m above the sea; local x along the upper wind — to the right as the eye sees
// it — y across it, away from the eye; h up) ──────────────────────────────────────────────────────────────────────
//
// The user, at the 2026-11-03 night frames: "The storm cloud has a straight-up right angle in there … Maybe that's not
// good enough", then: "it might need a different construction, or a compilation of different kinds of clouds and a bit
// of reshaping". Phase 1 carved one analytic body (a leaning cylinder, a dome, an egg-shaped plate): its far flank
// came down from the anvil as a cylinder's tangent — a ruled vertical edge — square to the plate's flat underside.
// Now the cell is COMPOSED, as a real one is (references: mature cumulonimbus capillatus incus at sunset; its shape
// from the cloud atlas): the main updraft a STACK of cumulus masses rising and leaning downshear, each billowing on
// its own; FLANKING TOWERS around it at their own stages, stepping down, some merged into it, some apart; the ANVIL a
// sheet of ice spread downwind at the tropopause, fibrous like the cirrus (clouds.ts `cirrus`), thinning to wisps at
// its edge, the overshooting top a dome over it; the BASE flat with a shelf along its front and scud under it, a rain
// shaft fading down. Every piece is read through one DOMAIN WARP (a slow noise moving every point up to WARP m) before
// its shape is taken, so no line in it is straight; the masses take the cumulus' own billows and detail.
/** m above the sea: the condensation level (every mass's flat base, ± BASE_JITTER), the anvil's underside over the
 * core and at its edge, its top, and the march's ceiling */
const BASE = 1300;
const BASE_JITTER = 180;
const ANVIL_BASE = 8900;
const ANVIL_TOP = 11800;
const CEILING = 13800;
/** a mass: [x, y, h (its centre), r (m, across), rv (m, up)] */
type Mass = readonly [number, number, number, number, number];
/** THE MAIN UPDRAFT: cumulus masses stacked from the base to the tropopause, each overlapping the last, leaning
 * downshear (+x) as it rises and wandering a little off the line (a seeded walk, fixed); the overshooting top last */
const TOWER: readonly Mass[] = [
  [0, 0, 2500, 4300, 2300],
  [500, 400, 4200, 4100, 2200],
  [900, -300, 5800, 3900, 2100],
  [1500, 300, 7300, 3700, 2000],
  [1900, -200, 8700, 3500, 1800],
  [2300, 200, 10000, 3300, 1600],
  [2500, -100, 11500, 2500, 1350],
];
/** THE FLANKING TOWERS, around the main one at their own stages: congestus merged into it, mediocris and humilis
 * stepping down and apart — on the upwind side (−x, the eye's left) a line, and down the other side under the anvil's
 * spread (with one line only, the far flank had been one smooth wall), a couple in front and behind */
const FLANKS: readonly Mass[] = [
  [-4600, 600, 4600, 2700, 2600],
  [-7400, 1500, 3500, 2200, 2000],
  [-9800, 700, 2600, 1800, 1300],
  [-12600, 1900, 2000, 1300, 700],
  [-3200, -3600, 3900, 2300, 2000],
  [4200, -1800, 4500, 2500, 2300],
  [6800, -2600, 3200, 2000, 1700],
  [9200, -1500, 2200, 1500, 900],
  [2400, 3600, 5000, 2600, 2600],
];
/** THE SHELF: a low roll along the cell's front edge (toward the eye), from x0 to x1 at y, its axis' height, its
 * radius — ragged, under the base */
const SHELF = { x: [-6500, 5500], y: -4600, h: 1050, r: 700 };
/** THE ANVIL's plan: downwind reach and upwind overhang from the top of the tower (m), half-width over it and at its
 * reach */
const ANVIL_REACH = 15000;
const ANVIL_BACK = 4000;
const ANVIL_HALF: [number, number] = [5500, 9500];
/** m: smooth-union widths: the masses with each other, the anvil with them */
const BLEND = [1100, 1400];
/** m: the domain warp (± about, horizontally; vertically less) and its tile */
const WARP = 1400;
const WARP_UP = 500;
const WARP_TILE = 26000;
/** m: the billows' amplitude on the masses (±half from the big octave), the anvil's streaks', the detail's; the most
 * they push the surface out (the empty-space skip's margin); the base's raggedness */
const DISP = 1700;
const DISP_ANVIL = 450;
const DISP_DETAIL = 350;
const DISP_MAX = 2600;
/** × the bound's distance the empty-space skip steps: under 1 / its slope (the masses' ≤ 1, the warp's ~1.3 on top) */
const SKIP = 0.6;
const RAGGED = 500;
/** m: the noise volumes' tiles (the shape volume's Perlin–Worley cells are a quarter of a tile: ~2.5 km and ~0.8 km
 * billows), the anvil's fibres' (long along the wind, as the cirrus' streaks), the detail's */
const BILLOW_TILE = 10000;
const BILLOW_TILE2 = 3300;
const STREAK_TILE: [number, number, number] = [28000, 6000, 7000];
const DETAIL_TILE = 1400;
/** m/s on the clouds' clock: the masses' billows rise, the anvil's fibres drift downwind — never a still sky (at
 * 55 km 5 m/s is 0.005°/s: ~0.3° a minute, the boiling read as life, not motion) */
const RISE = 5;
const STREAM = 9;
/** m: the surface's fringe on the masses (dense water cloud: a crisp edge) and on the anvil (ice: soft) */
const SKIN = 260;
const SKIN_ANVIL = 900;
/** m: how far in the density reaches full (from 0.4 of it at the surface) */
const CORE_DEPTH = 1500;
/** per m: extinction of the water cloud (density 1: a mean free path of 20 m) and of the anvil's ice (thinner: its
 * far edge lets the sky through) */
const SIGMA = 0.05;
const SIGMA_ANVIL = 0.015;
/** THE ANVIL'S EDGE: its fibres' share of its density (the rest a smooth sheet), and how thin it goes over the outer
 * part of its plan, where only the fibres are left: wisps */
const FIBRES = 0.3;
const FRAY_THIN = 0.25;
/** the rain shaft's density (per SIGMA: ~0.0005/m, an optical depth of ~2 across 4 km of shaft: a grey veil) and the
 * scud's */
const RAIN = 0.01;
const SCUD = 0.35;
/** m: the bounding circle (centre downwind of the core's foot, radius) the march looks in */
const BOUND_C = 2500;
const BOUND_R = 19500;

// ── THE LIGHT ─────────────────────────────────────────────────────────────────────────────────────────────────────
/** the march: steps of its own (m, in the shape; the empty space between is skipped), how many at most, and the
 * fine march toward the Sun (steps doubling from SUN_STEP) — the sky's and the water's (a rough sea blurs it) */
export interface StormQuality {
  step: number;
  steps: number;
  lightSteps: number;
  detail: boolean;
  airSteps: number;
}
export const STORM_FULL: StormQuality = { step: 160, steps: 200, lightSteps: 6, detail: true, airSteps: 8 };
export const STORM_REFLECTED: StormQuality = { step: 500, steps: 48, lightSteps: 3, detail: false, airSteps: 3 };
const SUN_STEP = 200;

// ── THE FLICKER (s, the sea's clock against c4's start; c4 starts at 430.0 show s) ──────────────────────────────────
/** s against c4's start: the flicker's window, from after the case has landed on deck (dolphin.ts FLIP_T, 411.8 show
 * s: the flip is its own moment) INTO THE NIGHT, to ~8 s before w1's dissolve — the user, at the 56e951c master
 * (2026-11-03): "maybe we keep the thunderstorm in the distance there for a while. It could look really cool at night
 * and enhance the scene" (it had died before the dial woke, 431 s); and how it swells and dies inside it (s: up by,
 * held to). Every stroke is done FLICKER_TAIL s past the end */
export const FLICKER: [number, number] = [-15.5, 48];
const FLICKER_TAIL = 0.9;
const FLICKER_SWELL: [number, number] = [-11, 40];
/** s between flashes: at least the first (the review's "at most one flash per 2 s"), up to the second; longer as the
 * cell dies */
export const FLASH_GAP: [number, number] = [2.1, 3.2];
/** s against c4's start: THE RADIO'S MOMENTS, kept clear of flashes (the coordinator, 2026-11-03: no flash during the
 * calls, the answer or the cascade's landings — "flashes fall in the waits between them, so they never steal the
 * beat"): no stroke of a flash runs inside one. Read from roseTraffic.ts where it says them: the dial's wake (its
 * crackle's peak, CALL.dial, ±0.8 s); each call from its first pulse leaving to its last one held and gone (CALLS,
 * ±0.5 s; the second call on through the answer, which follows it by CALL.beat); the answer's flashes and the pulses
 * they send back to us (callPulses' `back`, to their arrival); and the cascade's landings, ±0.8 s each — those last
 * measured on the ring's raised arcs, as roseTraffic.ts CASCADE says them (458.7/459.7, 465.9/466.8, 473.1/474.1 show
 * s; tests/driftDistantStorm.test.ts measures them again from cascadeTraffic, so a re-timed cascade fails it) */
export const CASCADE_LANDINGS = [28.68, 29.66, 35.95, 36.83, 43.1, 44.1];
const LANDING_CLEAR = 0.8;
export function radioMoments(): Array<[number, number]> {
  const out: Array<[number, number]> = [[CALL.dial - 0.8, CALL.dial + 0.8]];
  const calls = callPulses(0);
  const ours = calls.filter((p) => !p.back);
  const back = calls.filter((p) => p.back);
  const first = ours.filter((p) => p.t0 < CALLS[1].at - 0.01);
  const second = ours.filter((p) => p.t0 >= CALLS[1].at - 0.01);
  const end = (q: CallPulse): number => q.t0 + q.hold + FLASH.fall;
  out.push([first[0].t0 - 0.5, Math.max(...first.map(end)) + 0.5]);
  // (the second call, the answer and its pulses back to us: one run, 443 → 454 s)
  out.push([second[0].t0 - 0.5, Math.max(...back.map(end)) + CALL.travel + 0.5]);
  for (const l of CASCADE_LANDINGS) out.push([l - LANDING_CLEAR, l + LANDING_CLEAR]);
  return out;
}
/** s: a pulse's rise and its decay (shortest, longest) — soft, never a one-frame spike at 30 fps; the pulses' spacing
 * inside a flash */
const PULSE_RISE = 0.025;
const PULSE_DECAY: [number, number] = [0.08, 0.16];
const PULSE_SPACING: [number, number] = [0.07, 0.24];
/** m: how far the light of a channel spreads through the cloud before it leaves it (a few hundred mean free paths:
 * diffusion, the glow a patch of the cell ~5 km wide) */
const LIGHTNING_REACH = 2000;
/** m: the tile of the noise that makes the glow patchy (lobes ~1–2 km) */
const LIGHTNING_PATCH = 6000;
/** linear radiance of the glow at a channel at a flash's peak (the sky's units), and its colour: a hot channel's
 * blue-white, scattered by droplets (grey: they scatter every colour alike), reddened by the haze on its way to us.
 * Dim: at its peak the lit patch is about as bright as the sunset band beside the cell, never brighter than the lit
 * anvil above it (measured in the 16:9 stills at 420 s) */
export const LIGHTNING_PEAK = 0.6;
/** THE EYE'S ADAPTATION (seaSky.ts `exposure`): ~2.1 at the dusk the flashes were tuned in, 14 in the full night. A
 * flash's light is the same at night, but the eye opens ~7× on the dark — at LIGHTNING_PEAK the night's flashes came
 * out ~7× as bright on the screen as the dusk's, a strobe against a black sky. So its radiance is held to what reads
 * the same on the screen as at dusk (∝ 1/exposure), and toward the full night a little under it (NIGHT_SCREEN of the
 * dusk's): against the dark the flicker reads more for less light — "dim, in-cloud only" */
const EXPOSURE_DUSK = 2.1;
const EXPOSURE_NIGHT = 14;
const NIGHT_SCREEN = 0.5;
/** 0 at dusk's exposure and under it, 1 at the night's (smooth in log exposure) */
const nightOf = (e: number): number => (e > EXPOSURE_DUSK ? smooth(Math.log(e / EXPOSURE_DUSK) / Math.log(EXPOSURE_NIGHT / EXPOSURE_DUSK)) : 0);
/** × LIGHTNING_PEAK for the eye's exposure `e`: 1 up to dusk's, falling as 1/e, NIGHT_SCREEN of that by night's */
export function lightningGain(e: number): number {
  if (!(e > EXPOSURE_DUSK)) return 1;
  return (EXPOSURE_DUSK / e) * (1 + (NIGHT_SCREEN - 1) * nightOf(e));
}
/** THE CELL IN THE DARK: × the sky's and the sea's light on it (the cloudBath, with the film's night lift in it,
 * seaSky.ts NIGHT_LIGHT) — 1 to dusk, NIGHT_SKY by the night's exposure. With the eye opened 14×, that lift lit the
 * cell's whole face a moonlit grey-yellow (the first night stills, 455–464 s), the flashes lost in it; a moonless
 * night's cumulonimbus is a mass darker than the stars it hides, seen by its flashes — the user's "could look really
 * cool at night". (The fair-weather cumulus keep their lift: thinned away by beats.ts NIGHT_AT_SEA instead) */
const NIGHT_SKY = 0.3;
export const nightShade = (e: number): number => 1 + (NIGHT_SKY - 1) * nightOf(e);
const LIGHTNING_RGB: [number, number, number] = [0.84, 0.9, 1];
/** where the channels run (local m): x, y about the core's axis, and height — inside the tower, under the anvil */
const CHANNEL_X: [number, number] = [-2500, 4500];
const CHANNEL_Y: [number, number] = [-2600, 2600];
const CHANNEL_H: [number, number] = [3800, 8600];
const CHANNEL_LEN: [number, number] = [1500, 4200];
/** the schedule's seed: chosen (of the first 400, when the flicker ended at c4's +1 s) for seven dusk flashes ~2–3 s
 * apart, faint at first, two of them in the dial's first glow (from c4's −2 s); the night's follow on from it */
const SEED = 309;

// ── GROWTH AND CLEARING ───────────────────────────────────────────────────────────────────────────────────────────
/** s against c2's start: the cell builds through c1's sunset time-lapse (sea.ts LAPSE: the follow's 3–40 s, the
 * clouds' clock hurried 6×), full by c2 — "from c2 on, unremarked" */
const GROW: [number, number] = [-C1_FOLLOW + 4, 0];
/** s against c4's start: it dies away over c4's last stretch, slowly (12 s: no time-lapse runs then to excuse a
 * faster collapse) as the cascade closes its ring (474.1 s) and the Rose goes quiet, gone 5 s before w1's dissolve
 * begins (485 s) — the night lifts into the morning over the island with no storm in it (until 2026-11-03 it died in
 * c4's first seconds, gone before the dial woke) */
export const CLEAR: [number, number] = [38, 50];

const smooth = (x: number): number => {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
};

/** 0 … 1: how far the cell has built at sea s `t` (beats' starts): its tower risen, its anvil spread */
export function stormGrowth(t: number, starts: Record<BeatName, number>): number {
  return smooth((t - starts.c2 - GROW[0]) / (GROW[1] - GROW[0]));
}
/** 1 … 0: how much of it still stands as it dies in c4 (0 once CLEAR is over) */
export function stormStanding(t: number, starts: Record<BeatName, number>): number {
  return 1 - smooth((t - starts.c4 - CLEAR[0]) / (CLEAR[1] - CLEAR[0]));
}
/** 0 … 1: how much of the cell there is at sea s `t` — 0 outside c1's follow to c4's first seconds */
export function stormPresence(t: number, starts: Record<BeatName, number>): number {
  return stormGrowth(t, starts) * stormStanding(t, starts);
}

/** one pulse of a flash: s after the flash begins, its height (0..1 of the flash's peak), its decay (s), and the
 * channel it lights (local m: x, y, height) */
export interface Pulse {
  at: number;
  amp: number;
  decay: number;
  a: [number, number, number];
  b: [number, number, number];
}
/** a flash: its start (sea s), its peak (0..1, the flicker's swell and its own strength), its pulses */
export interface Flash {
  t: number;
  peak: number;
  pulses: Pulse[];
}

/** a pulse's shape, s after it begins: a soft rise and an exponential decay, peaking at 1 */
export function pulseShape(x: number, decay: number): number {
  if (x <= 0) return 0;
  const f = (s: number): number => (1 - Math.exp(-s / PULSE_RISE)) * Math.exp(-s / decay);
  // (its peak, where the rise meets the decay: d/ds = 0)
  const top = PULSE_RISE * Math.log(1 + decay / PULSE_RISE);
  return f(x) / f(top);
}
/** s after a pulse begins by which it has decayed under 1% (it is cut there) */
const pulseEnd = (decay: number): number => decay * Math.log(100) + 4 * PULSE_RISE;

/** the flicker's swell (0..1) at s `x` against c4's start */
function swell(x: number): number {
  return smooth((x - FLICKER[0]) / (FLICKER_SWELL[0] - FLICKER[0])) * (1 - smooth((x - FLICKER_SWELL[1]) / (FLICKER[1] + 0.8 - FLICKER_SWELL[1])));
}
/** the radio's moment (s against c4's start) that a flash from `x` lasting `length` s would run into, if any */
const clash = (x: number, length: number, moments: Array<[number, number]>): [number, number] | undefined => moments.find(([a, b]) => x < b && x + length > a);

/**
 * THE FLASHES for a c4 starting at sea s `c4`: a seeded schedule (mulberry32, SEED), the same on every machine and in
 * every lane. One flash at a time, FLASH_GAP apart (longer as the flicker dies), each 2–4 pulses along a channel that
 * moves on between them, inside the core.
 */
export function stormFlashes(c4: number): Flash[] {
  let s = SEED >>> 0;
  const rnd = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
  const lerp = (r: [number, number], k: number): number => r[0] + (r[1] - r[0]) * k;
  const out: Flash[] = [];
  const moments = radioMoments();
  let x = FLICKER[0] + 0.6 + rnd() * 1.2;
  while (x < FLICKER[1]) {
    const sw = swell(x);
    const n = 2 + Math.floor(rnd() * 3);
    const pulses: Pulse[] = [];
    let at = 0;
    let p: [number, number, number] = [lerp(CHANNEL_X, rnd()), lerp(CHANNEL_Y, rnd()), lerp(CHANNEL_H, rnd())];
    for (let i = 0; i < n; i++) {
      // the channel runs on from where the last pulse's ended, mostly level (intracloud: along the charge layers)
      const len = lerp(CHANNEL_LEN, rnd());
      const az = rnd() * Math.PI * 2;
      const q: [number, number, number] = [
        Math.min(CHANNEL_X[1], Math.max(CHANNEL_X[0], p[0] + Math.cos(az) * len)),
        Math.min(CHANNEL_Y[1], Math.max(CHANNEL_Y[0], p[1] + Math.sin(az) * len)),
        Math.min(CHANNEL_H[1], Math.max(CHANNEL_H[0], p[2] + (rnd() - 0.5) * 1600)),
      ];
      pulses.push({ at, amp: i === 0 ? 1 : 0.35 + 0.6 * rnd(), decay: lerp(PULSE_DECAY, rnd()), a: p, b: q });
      p = q;
      at += lerp(PULSE_SPACING, rnd());
    }
    // (the last flash's tail cut where it would run on toward the dial's wake: its strokes are done by the end)
    const kept = pulses.filter((q) => x + q.at + pulseEnd(q.decay) <= FLICKER[1] + FLICKER_TAIL);
    if (kept.length < 2) break;
    {
      // (a flash that would run into one of the radio's moments waits for the wait after it: it starts a breath to a
      // second after the moment, its draws unchanged — so the flashes fall in the waits, never on the beat)
      const last = kept[kept.length - 1];
      const hit = clash(x, last.at + pulseEnd(last.decay), moments);
      if (hit) {
        x = Math.max(hit[1] + 0.3 + 0.7 * rnd(), out.length ? out[out.length - 1].t - c4 + FLASH_GAP[0] : -Infinity);
        continue;
      }
    }
    out.push({ t: c4 + x, peak: Math.max(0.2, sw) * (0.55 + 0.45 * rnd()), pulses: kept });
    const last = kept[kept.length - 1];
    const length = last.at + pulseEnd(last.decay);
    // (the next flash once this one is over, and at least FLASH_GAP[0] from its start; a little sparser where the
    // swell is low, as it starts and as it dies)
    x += Math.max(FLASH_GAP[0], length + 0.5, lerp(FLASH_GAP, rnd()) * (1 + 0.35 * (1 - sw)));
  }
  return out;
}

/** the pulses lit at sea s `t`: each one's channel and its light now (0..1 of LIGHTNING_PEAK; `radio`: its strength
 * on the radio instead, every flash whole — a far flash dim to the eye through 55 km of haze is still loud on the
 * dial), brightest first */
export function lightningAt(t: number, flashes: Flash[], radio = false): Array<{ pulse: Pulse; light: number }> {
  const lit: Array<{ pulse: Pulse; light: number }> = [];
  for (const f of flashes) {
    if (t < f.t || t > f.t + 2) continue;
    for (const p of f.pulses) {
      const x = t - f.t - p.at;
      if (x <= 0 || x > pulseEnd(p.decay)) continue;
      lit.push({ pulse: p, light: (radio ? 1 : f.peak) * p.amp * pulseShape(x, p.decay) });
    }
  }
  return lit.sort((a, b) => b.light - a.light);
}

/** THE SFERICS at sea s `t`: 0..1, what the radio hears of the flashes (their pulses summed, every flash whole) */
export function sfericsAt(t: number, flashes: Flash[]): number {
  return Math.min(1, lightningAt(t, flashes, true).reduce((s, l) => s + l.light, 0));
}

/** s: the dial's stutter steps (the crackle's grain: two to three frames at 30 fps, not a strobe) */
const STUTTER_STEP = 1 / 12;
/**
 * × THE DIAL'S GLOW at sea s `t` (props.ts, where the dial is lit: from c4's −2 s on): each flash spits into the
 * radio, and while it does the glow jumps up and cuts out in steps of STUTTER_STEP, by how much the sferics are; 1
 * between flashes. A pure function of t (a hash of the step).
 */
export function dialStutter(t: number, flashes: Flash[]): number {
  const s = sfericsAt(t, flashes);
  if (s <= 0.01) return 1;
  const k = Math.floor(t / STUTTER_STEP);
  const h = Math.abs(Math.sin(k * 12.9898 + 78.233) * 43758.5453) % 1;
  return Math.max(0, 1 + Math.min(1, s * 1.6) * (h > 0.45 ? 1.2 : -0.85));
}

export interface StormUniforms {
  /** m, world xz: the core's foot */
  centre: THREE.Node<'vec2'>;
  /** unit, world xz: along the upper wind (the anvil's way), and across it */
  along: THREE.Node<'vec2'>;
  across: THREE.Node<'vec2'>;
  /** 0..1: stormPresence (none: nothing marched), stormGrowth (the tower's rise, the anvil's spread) and
   * stormStanding (1 → 0 as it dies) */
  presence: F;
  grow: F;
  standing: F;
  /** the two brightest channels lit now (local m) and their light (linear radiance at the channel) */
  a0: V3;
  a1: V3;
  aLight: F;
  b0: V3;
  b1: V3;
  bLight: F;
  /** × the sky's and the sea's light on the cell (nightShade): 1 to dusk, less in the full night */
  skyLight: F;
}

export interface DistantStorm {
  readonly uniforms: StormUniforms;
  /** the flashes, from c4's start (sea s) */
  readonly flashes: Flash[];
  /** stand the cell STORM_DIST from `eye` (world, m; where the eye is at c2's start) at STORM_BEARING right of the
   * front `yaw` (rad, the open sea's: sea.ts `yaw`) — fixed in the world from then on */
  place(eye: THREE.Vector3, yaw: number): void;
  /** its state at sea s `t` (its growth, the channels lit) under the eye's `exposure` (seaSky.ts: the flashes' light
   * held against it, lightningGain) */
  update(t: number, exposure?: number): void;
}

export function createDistantStorm(starts: Record<BeatName, number>): DistantStorm {
  const u = {
    centre: uniform(new THREE.Vector2()),
    along: uniform(new THREE.Vector2(1, 0)),
    across: uniform(new THREE.Vector2(0, 1)),
    presence: uniform(0),
    grow: uniform(0),
    standing: uniform(0),
    a0: uniform(new THREE.Vector3()),
    a1: uniform(new THREE.Vector3()),
    aLight: uniform(0),
    b0: uniform(new THREE.Vector3()),
    b1: uniform(new THREE.Vector3()),
    bLight: uniform(0),
    skyLight: uniform(1),
  };
  const flashes = stormFlashes(starts.c4);
  const dir = (deg: number, yaw: number): THREE.Vector2 => {
    // (the eye's level frame, x right, −z ahead, turned by the front's yaw about y — as beatSun's Sun is)
    const v = new THREE.Vector3(Math.sin((deg * Math.PI) / 180), 0, -Math.cos((deg * Math.PI) / 180)).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    return new THREE.Vector2(v.x, v.z);
  };
  return {
    uniforms: u as unknown as StormUniforms,
    flashes,
    place(eye, yaw) {
      const d = dir(STORM_BEARING, yaw);
      u.centre.value.set(eye.x + d.x * STORM_DIST, eye.z + d.y * STORM_DIST);
      const a = dir(ANVIL_TO, yaw);
      u.along.value.copy(a);
      // (across: the along turned 90° toward the front's left — y > 0 lies toward smaller bearings)
      const c = dir(ANVIL_TO - 90, yaw);
      u.across.value.copy(c);
    },
    update(t, exposure = EXPOSURE_DUSK) {
      const on = driftParams.distantStorm;
      const presence = on ? stormPresence(t, starts) : 0;
      u.presence.value = presence;
      u.grow.value = stormGrowth(t, starts);
      u.standing.value = stormStanding(t, starts);
      const lit = presence > 0 ? lightningAt(t, flashes) : [];
      const set = (i: number, p0: THREE.Vector3, p1: THREE.Vector3, light: { value: number }): void => {
        const l = lit[i];
        light.value = l ? l.light * LIGHTNING_PEAK * lightningGain(exposure) * Math.min(1, presence * 1.5) : 0;
        if (l) {
          p0.set(...l.pulse.a);
          p1.set(...l.pulse.b);
        }
      };
      set(0, u.a0.value, u.a1.value, u.aLight);
      set(1, u.b0.value, u.b1.value, u.bLight);
      u.skyLight.value = nightShade(exposure);
    },
  };
}

// ── THE SHADER ────────────────────────────────────────────────────────────────────────────────────────────────────
const sat = (x: F): F => x.clamp(0, 1) as F;
/** the smooth union of two inside-positive distances (m), over `k` m */
const smax = (a: F, b: F, k: number): F => {
  const h = float(k).sub(a.sub(b).abs()).max(0).div(k);
  return max(a, b).add(h.mul(h).mul(k * 0.25)) as F;
};
/** a point's distance from the segment a–b (local m) */
const toSegment = (p: V3, a: V3, b: V3): F => {
  const pa = p.sub(a);
  const ba = b.sub(a);
  const k = sat(pa.dot(ba).div(ba.dot(ba).max(1)));
  return pa.sub(ba.mul(k)).length() as F;
};

interface CellPoint {
  /** local m: along the upper wind, across it, height above the sea */
  x: F;
  y: F;
  h: F;
}

/** a point's place in the cell (stormField `shape`): how far inside the composition's surface (m, + inside; a
 * distance near the surface, a bound away from it — the empty-space skip steps by it, so it carries no noise but the
 * warp), how much of it is the anvil's ice (0..1), how far out on the anvil's plan (0 over the tower, 1 at its edge),
 * how far from the main updraft's foot (m, for the rain and the scud), and the warped point itself */
interface CellShape {
  sd: F;
  ice: F;
  edge: F;
  foot: F;
  w: CellPoint;
}

/** an ellipsoid mass (m: + inside, about its smaller radius' scale), its base cut flat at `base` */
const massSd = (x: F, y: F, h: F, m: Mass, base: number): F => {
  const [cx, cy, ch, r, rv] = m;
  const q = vec3(x.sub(cx).div(r), y.sub(cy).div(r), h.sub(ch).div(rv)).length();
  return min(float(1).sub(q).mul(Math.min(r, rv)), h.sub(base)) as F;
};
/** a mass's own condensation level: BASE ± BASE_JITTER, fixed per mass (a hash of its index) */
const baseOf = (i: number): number => BASE + BASE_JITTER * (2 * ((((Math.sin(i * 12.9898 + 4.1) * 43758.5453) % 1) + 1) % 1) - 1);

export interface StormField {
  /** local coordinates of a world point (m; the sea's curve under the eye `o`) */
  local: (p: V3) => CellPoint;
  /** the composition's shape alone (for the empty-space skip) */
  bound: (c: CellPoint) => F;
  /** the cell's extinction at a local point, per SIGMA (density × its share of the water cloud's σ); `blur` (m): the
   * surface spread over a step that long */
  density: (c: CellPoint, detailed: boolean, blur?: number | F) => F;
}

export function stormField(data: CloudData, U: CloudUniforms, S: StormUniforms, o: V3): StormField {
  const local = (p: V3): CellPoint => {
    const rx = p.x.sub(S.centre.x);
    const rz = p.z.sub(S.centre.y);
    const ex = p.x.sub(o.x);
    const ez = p.z.sub(o.z);
    return {
      x: rx.mul(S.along.x).add(rz.mul(S.along.y)) as F,
      y: rx.mul(S.across.x).add(rz.mul(S.across.y)) as F,
      h: p.y.add(ex.mul(ex).add(ez.mul(ez)).div(2 * R)) as F,
    };
  };
  const shape = (c: CellPoint): CellShape => {
    // THE WARP: every piece read at a point moved by a slow noise (drifting with the clouds' clock), so no edge of it
    // is a ruled line or a perfect curve
    const wn = texture3D(data.shape, vec3(c.x, c.h.mul(0.5), c.y).div(WARP_TILE).add(vec3(U.time.mul(1 / 40000), 0.21, 0.63)));
    const wx = c.x.add(wn.r.sub(0.5).mul(2 * WARP));
    const wy = c.y.add(wn.g.sub(0.5).mul(2 * WARP));
    // (it builds from its base up: the heights read stretched while it forms, the towers rising)
    const wh = c.h.add(wn.b.sub(0.5).mul(2 * WARP_UP)).sub(BASE).div(mix(float(0.35), float(1), S.grow)).add(BASE);
    // THE MASSES: the main updraft's stack, then the flanking towers, each merged into what is there
    let masses = massSd(wx, wy, wh, TOWER[0], baseOf(0));
    TOWER.slice(1).forEach((m, i) => (masses = smax(masses, massSd(wx, wy, wh, m, baseOf(i + 1)), BLEND[0])));
    FLANKS.forEach((m, i) => (masses = smax(masses, massSd(wx, wy, wh, m, baseOf(i + 20)), BLEND[0])));
    // THE SHELF: a low roll along the front, ending softly
    const along = wx.clamp(SHELF.x[0], SHELF.x[1]);
    const shelf = min(
      float(SHELF.r).sub(vec3(wx.sub(along), wy.sub(SHELF.y), wh.sub(SHELF.h)).length()),
      min(wx.sub(SHELF.x[0]), float(SHELF.x[1]).sub(wx)).mul(0.25),
    ) as F;
    masses = smax(masses, shelf, BLEND[0]);
    // THE ANVIL: over the tower's top, short upwind, long and widening downwind, its underside rising to the edge (a
    // wedge), its top flat at the tropopause — only once the tower has reached it
    const top = TOWER[TOWER.length - 2];
    const ux = wx.sub(top[0]);
    const k = sat(ux.add(ANVIL_BACK).div(ANVIL_BACK + ANVIL_REACH));
    const half = mix(float(ANVIL_HALF[0]), float(ANVIL_HALF[1]), k.mul(k).mul(k.mul(-2).add(3)));
    const eu = select(ux.lessThan(0), ux.div(ANVIL_BACK), ux.div(ANVIL_REACH));
    const e = vec2(eu, wy.sub(top[1]).div(half)).length();
    // (× at most 0.9 of the upwind overhang: a distance the empty-space skip can trust — at 6000 m upwind its slope
    // was 1.5, the skip stepped past the surface and planed the billows off in flat facets)
    const plan = float(1).sub(e).mul(half.min(ANVIL_BACK * 0.9));
    const anvilTop = float(ANVIL_TOP).sub(e.mul(e).mul(600));
    const anvilBottom = mix(float(ANVIL_BASE), float(ANVIL_TOP - 600), sat(e).pow(1.4));
    const anvil = min(min(plan, wh.sub(anvilBottom)), anvilTop.sub(wh)).sub(float(1).sub(smoothstep(0.6, 0.95, S.grow)).mul(8000)) as F;
    const sd = smax(masses, anvil, BLEND[1]);
    // (ice: the anvil's sheet where no mass is — the overshooting top stays a cumulus' hard dome)
    // (ice only clear of the masses, by ~1.5 km: within it the fibres had laid ripples over the overshooting top)
    const ice = smoothstep(ANVIL_BASE - 700, ANVIL_BASE + 500, wh).mul(float(1).sub(sat(masses.div(1500).add(1)))) as F;
    const foot = vec2(wx.sub(TOWER[0][0]), wy.sub(TOWER[0][1])).length() as F;
    return { sd, ice, edge: e as F, foot, w: { x: wx as F, y: wy as F, h: wh as F } };
  };
  const bound = (c: CellPoint): F => shape(c).sd;
  const density = (c: CellPoint, detailed: boolean, blur: number | F = 0): F => {
    const { sd, ice, edge, foot, w } = shape(c);
    // the billows: the masses', rising (the shape volume's Perlin–Worley, uniform on [0, 1]; its body blend as the
    // cumulus', clouds.ts); the anvil's fibres, along the wind as the cirrus' streaks are
    const q = vec3(w.x, w.h.sub(U.time.mul(RISE)), w.y);
    const s1 = texture3D(data.shape, q.div(BILLOW_TILE));
    const s2 = texture3D(data.shape, q.div(BILLOW_TILE2).add(vec3(0.37, 0.11, 0.73)));
    const b1 = s1.r.mul(0.7).add(s1.g.mul(0.2)).add(s1.b.mul(0.1));
    const b2 = s2.r.mul(0.7).add(s2.g.mul(0.2)).add(s2.b.mul(0.1));
    const billow = b1.sub(0.5).add(b2.sub(0.5).mul(0.6));
    const st = texture3D(data.shape, vec3(w.x.sub(U.time.mul(STREAM)).div(STREAK_TILE[0]), w.h.div(STREAK_TILE[1]), w.y.div(STREAK_TILE[2])).add(vec3(0.61, 0.29, 0.05)));
    // (the base flatter: a cumulonimbus' base is the condensation level — ragged, not ruled)
    const flat = smoothstep(BASE, BASE + 900, w.h).mul(0.85).add(0.15);
    const ragged = b2.sub(0.5).mul(RAGGED).mul(float(1).sub(smoothstep(BASE, BASE + 700, w.h)));
    let inside = sd.add(billow.mul(DISP).mul(flat).mul(ice.mul(-0.45).add(1))).add(st.g.sub(0.5).mul(DISP_ANVIL * 2).mul(ice)).add(ragged) as F;
    if (detailed) {
      const dt = texture3D(data.detail, q.div(DETAIL_TILE));
      const dfbm = dt.r.mul(0.625).add(dt.g.mul(0.25)).add(dt.b.mul(0.125));
      inside = inside.add(dfbm.sub(0.5).mul(DISP_DETAIL)) as F;
    }
    // (forming, it fills out from its thin edges; dying, the towers collapse first — eroding from their billows in —
    // while the anvil's ice, cut off from them, thins in place and lingers a little longer, as a dying cell's does)
    inside = inside.sub(float(1).sub(S.grow).mul(1800)).sub(float(1).sub(S.standing).mul(mix(float(2600), float(1300), ice))) as F;
    const skin = mix(float(SKIN), float(SKIN_ANVIL), ice);
    const wide = typeof blur === 'number' ? float(blur) : blur;
    const ramp = sat(inside.div(skin.add(wide.mul(0.5))));
    // the anvil's ice: a sheet with fibres in it, and toward its edge the fibres alone — wisps (the cirrus' look)
    const outer = smoothstep(0.6, 1, edge).mul(ice);
    const fibre = smoothstep(0.35, 0.75, st.g.mul(0.7).add(st.b.mul(0.3)));
    // (the fibres only where the sheet thins: over the body of the anvil they had drawn brushstrokes, "painted")
    const sheet = mix(float(1), float(1 - FIBRES).add(fibre.mul(FIBRES)).mul(mix(float(1), fibre.mul(FRAY_THIN / (1 - FIBRES * 0.5)), outer)), smoothstep(0.35, 0.8, edge));
    const body = ramp
      .mul(ramp.sqrt())
      .mul(sat(inside.div(CORE_DEPTH)).mul(0.6).add(0.4))
      .mul(mix(float(1), sheet.mul(SIGMA_ANVIL / SIGMA), ice));
    // under the base: the rain shaft from the main updraft, grey streaks fading toward the sea, and the scud, ragged
    const under = float(1).sub(smoothstep(BASE - 150, BASE + 100, c.h));
    const streak = smoothstep(0.35, 0.8, texture3D(data.shape, vec3(w.x.div(1800), c.h.div(30000), w.y.div(1800)).add(vec3(0.2, 0.9, 0.4))).b);
    const rain = sat(float(3800).sub(foot).div(1800)).mul(under).mul(streak).mul(smoothstep(0, 900, c.h)).mul(RAIN);
    const scudN = texture3D(data.shape, vec3(w.x, c.h.mul(2), w.y).div(2600).add(vec3(0.5, 0.15, 0.85))).r;
    const scud = smoothstep(0.62, 0.8, scudN).mul(sat(float(6500).sub(foot).div(2500))).mul(smoothstep(500, 900, c.h)).mul(under).mul(SCUD);
    return body.add(rain).add(scud).mul(sat(S.grow.mul(3))).mul(S.standing.sqrt()) as F;
  };
  return { local, bound, density };
}

export interface StormMarchOptions {
  quality?: StormQuality;
  /** the sunlight's irradiance (linear) at height h (m) where the Sun's cos-zenith is mu (seaSky.ts sunAt) */
  sunAt: (h: F, mu: F) => V3;
  /** 0..1, this (sub-)frame's offset of the march's jitter (clouds.ts CloudLight.jitter) */
  jitter?: F;
}

/**
 * The cell along a ray from the eye `o` (world m, sea level at y = 0) in direction d: its light (linear, already
 * weighted by its opacity), opacity, and how far its light comes from (m, opacity-weighted: for the air in front).
 * The light as clouds.ts cloudMarch's, from the cell's own body only (the cumulus layer is far nearer and below most
 * of it; its shadow on the cell is left out), plus the lightning's glow.
 */
export function stormMarch(o: V3, d: V3, data: CloudData, U: CloudUniforms, S: StormUniforms, opt: StormMarchOptions): { light: V3; alpha: F; dist: F } {
  const quality = opt.quality ?? STORM_FULL;
  const f = stormField(data, U, S, o);
  const light = vec3(0).toVar();
  const T = float(1).toVar();
  const distW = float(0).toVar();
  // the bounding circle on the sea's plane (the ray's xz)
  const cb = S.centre.add(S.along.mul(BOUND_C));
  const ox = o.x.sub(cb.x);
  const oz = o.z.sub(cb.y);
  const a2 = d.x.mul(d.x).add(d.z.mul(d.z)).max(1e-6);
  const b = ox.mul(d.x).add(oz.mul(d.z));
  const disc = b.mul(b).sub(a2.mul(ox.mul(ox).add(oz.mul(oz)).sub(BOUND_R * BOUND_R)));
  If(S.presence.greaterThan(0).and(disc.greaterThan(0)).and(d.y.greaterThan(-0.001)), () => {
    const root = sqrt(disc);
    const t0 = b.negate().sub(root).div(a2).max(0);
    // (and under the ceiling: the ray climbs over the sea's curve)
    const r0 = float(R).add(o.y);
    const k = float(CEILING).sub(o.y).mul(float(2 * R + CEILING).add(o.y));
    const tTop = k.div(r0.mul(d.y).add(sqrt(r0.mul(r0).mul(d.y.mul(d.y)).add(k))));
    const t1 = b.negate().add(root).div(a2).min(tTop);
    const cosT = d.dot(U.sun);
    const phases = Array.from({ length: OCTAVES }, (_, i) => cloudPhase(cosT, 0.5 ** i).toVar());
    const powderK = sat(cosT.negate().mul(0.5).add(0.5)).mul(POWDER);
    const jitter = opt.jitter ? fract(blueNoise(2).add(opt.jitter)) : blueNoise(2);
    const jitterL = opt.jitter ? fract(blueNoise(3).add(fract(opt.jitter.mul(1.618034).add(0.5)))) : blueNoise(3);
    const near: [number, number][] = [];
    for (let i = 0, at = 0, step = SUN_STEP; i < quality.lightSteps; i++, at += step, step *= 2) near.push([at, step]);
    const seaUp = U.skyBelow.add(U.sunBase.mul(U.sun.y.max(0)).mul(SEA_UP)).mul(0.5);
    const ds = float(quality.step);
    const t = t0.add(jitter.mul(ds)).toVar();
    const flashRgb = vec3(...LIGHTNING_RGB);
    Loop(quality.steps, () => {
      If(t.greaterThan(t1).or(T.lessThan(0.01)), () => {
        Break();
      });
      const p = o.add(d.mul(t)).toVar();
      const c = f.local(p);
      const sd = f.bound(c);
      // (far outside the shape: skip ahead by the distance the billows cannot reach past — the bound's slope is ≤ ~1.1)
      If(sd.lessThan(-DISP_MAX), () => {
        t.addAssign(max(ds, sd.negate().sub(DISP_MAX).mul(SKIP)));
      }).Else(() => {
        // (the surface spread over half a step, and the steps toward the Sun over their whole length: a crisp 260 m skin
        // met by 220 m steps, each jittered per pixel, hit or missed a billow pixel by pixel — a fine stipple over every
        // lit face in the 1920 stills)
        const rho = f.density(c, quality.detail, ds.mul(0.5)).toVar();
        If(rho.greaterThan(0.002), () => {
          // the cell between here and the Sun (its own body: doubling steps, each sampled jittered, blurred over its length)
          const od = float(0).toVar();
          for (const [at, step] of near) od.addAssign(f.density(f.local(p.add(U.sun.mul(jitterL.mul(step).add(at)))), false, step * 2).mul(step));
          const tau = od.mul(SIGMA);
          const e: F[] = new Array(OCTAVES);
          e[OCTAVES - 1] = exp(tau.div(-(2 ** (OCTAVES - 1)))).toVar() as F;
          for (let i = OCTAVES - 2; i >= 0; i--) e[i] = e[i + 1].mul(e[i + 1]) as F;
          let ms = e[0].mul(phases[0]) as F;
          for (let i = 1; i < OCTAVES; i++) ms = ms.add(e[i].mul(phases[i]).mul(0.5 ** i)) as F;
          const powder = float(1).sub(exp(od.mul(-SIGMA * 2)).mul(powderK));
          // the sunlight here: the air's, at this height and this point's own Sun elevation (its Earth's shadow)
          const ex = p.x.sub(o.x);
          const ez = p.z.sub(o.z);
          const muS = U.sun.y.mul(float(1).sub(ex.mul(ex).add(ez.mul(ez)).div(2 * R * R))).add(U.sun.x.mul(ex).add(U.sun.z.mul(ez)).div(R));
          const E = opt.sunAt(c.h, muS);
          // the sky's light from above and the sea's from below, through the cell over and under this point (three
          // samples up, two down: the anvil's overhang shades the tower's flank, the clear air under it lights its base)
          // (each sample jittered along its stretch and blurred over twice it: at fixed heights the edge of a mass
          // overhead cut the sky's light off in one step, and the shade under every overhang came down in vertical
          // streaks — "drips" on the far flank in the composed cell's first dusk stills)
          const j = jitterL.add(0.5);
          const upAt = (at: number, len: number): F => f.density(f.local(p.add(vec3(0, j.mul(at), 0))), false, len * 2).mul(len) as F;
          const downAt = (at: number, len: number): F => f.density(f.local(p.sub(vec3(0, j.mul(at), 0))), false, len * 2).mul(len) as F;
          const up = upAt(600, 1200).add(upAt(1800, 1200)).add(upAt(4200, 3600));
          const down = downAt(600, 1200).add(downAt(2400, 3600));
          const amb = U.skyAbove.mul(0.5).div(up.mul(SIGMA * DIFFUSE * 0.5).add(1)).add(seaUp.div(down.mul(SIGMA * DIFFUSE).add(1))).mul(S.skyLight);
          const diffused = sat(tau.div(DIFFUSION_SKIN)).div(tau.mul(DIFFUSE).add(1)).mul(DIFFUSION / (4 * Math.PI));
          // THE LIGHTNING: the cloud about a lit channel glowing, falling off as the light diffuses out to here
          const lp = vec3(c.x, c.y, c.h);
          // (patchy, not a smooth spotlight: the light comes out where the cloud between it and the surface is thinner —
          // the billows' crevices and thin lobes lit, the thick ones dark. A plain falloff drew a soft round white disc on
          // the flank in the third stills)
          // (soft: a deep patch pattern, 0.1–1.3, lit the night's cell in leopard spots)
          const patch = texture3D(data.shape, lp.div(LIGHTNING_PATCH).add(vec3(0.43, 0.17, 0.81))).r.mul(0.8).add(0.6).clamp(0.6, 1.3);
          const glow = S.aLight.mul(exp(toSegment(lp, S.a0, S.a1).div(-LIGHTNING_REACH))).add(S.bLight.mul(exp(toSegment(lp, S.b0, S.b1).div(-LIGHTNING_REACH)))).mul(patch);
          const Sl = E.mul(ms.mul(powder).add(diffused)).add(amb).add(flashRgb.mul(glow));
          const a = float(1).sub(exp(rho.mul(-SIGMA).mul(ds)));
          light.addAssign(Sl.mul(a).mul(T));
          distW.addAssign(t.mul(a).mul(T));
          T.mulAssign(a.oneMinus());
        });
        t.addAssign(ds);
      });
    });
  });
  const alpha = T.oneMinus();
  return { light: light as unknown as V3, alpha: alpha as F, dist: distW.div(alpha.max(1e-4)) as F };
}
