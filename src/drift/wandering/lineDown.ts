/**
 * "THE LINE DOWN" — LOOK-DEV ONLY. The bold option of the 2026-11-02 next-level review (drift-narrative/
 * next-level-2026-11-02.md §4): one underwater stretch in c2–c3, the sunset sky squeezed into Snell's window
 * overhead, the raft a dark cross in it. The user wants to SEE what is there before deciding, behind the synthesis's
 * gates:
 *
 *   gate 1  a 16:9 look-dev still of the view from below;
 *   gate 2  one dome-master frame of the same moment, remapped to a row-8 seat, checked for seams across the faces.
 *
 * So this is not the sequence. It is the moment under the water, drawn by the film's own pipeline (the real sea, its
 * sky, its raft and debris, the dome's faces, AO, bloom and grade), switched by `drift.html?linedown` (the review
 * scripts' `--query linedown`) and OFF by default: nothing here is built, and the show draws exactly as it did, unless
 * the query asks for it. Not built (the synthesis's own list, deliberately left for after the gates): the crossings
 * (here the eye simply IS under the water from LINE_DOWN.from to .to — a cut at either end), the re-blocked c2/c3
 * poses, the set laid along the raft's way in the world (here it rides with the eye: see `place`), above-water things
 * refracted into the window (see WHAT THE WINDOW SHOWS).
 *
 * WHAT IS REUSED, AND WHAT IS NOT:
 *
 *   - THE SURFACE FROM BELOW is the game's own ocean underside (ocean/surfaceMaterial.ts, §V.24/§V.25): Snell's window
 *     at the critical angle (48.6° off the live wave normal: ~97° across, centred on TRUE up — 15° behind the tilted
 *     dome's zenith), the sea's own sky refracted into it through the LIVE FFT normal (seaSky `dome` and `sunTerm`, the
 *     sky the sea reflects), n² of radiance gain, and the silver ceiling of total internal reflection outside it. The
 *     sea already wires its sky into it (sea.ts `skyDomeColor`, `skySunTerm`); the ocean decides top or underside by
 *     the eye's depth at its own xz (oceanSurface.ts), so putting the eye under the water is all it takes.
 *   - THE WATER VOLUME is NOT src/underwater's: waterVolume.ts and godRays.ts are post-pipeline passes over one
 *     camera's depth and colour, and the dome is six cube faces — a screen-space radial blur seams across their edges
 *     (the synthesis: "godRays.ts is a screen-space radial blur, so it will seam across cube faces"). Here the water is
 *     a per-fragment term on every material (`scene.fogNode`), computed from the world ray eye → fragment alone, so
 *     every face computes the same thing for the same ray: face-safe by construction. Its coefficients ARE the
 *     shared ones (params/caustics submergedAbsorption*: Jerlov K_d, the hull's and the caustics' numbers) × WATER.murk.
 *   - LIGHT SHAFTS: analytic, in the same term — the refracted Sun's light in-scattered along the view ray, marched in
 *     SHAFTS.steps world-space steps, each step's light gated by where its sunbeam entered the water (a noise of the
 *     surface point, drifting with t: the focusing of the waves). World-space, so face-safe as well.
 *   - THE DOLPHIN (dolphin.ts: an outline and a motion, made to be seen as a silhouette) and the blue case
 *     (hardCase.ts). The wreckage and the net are stand-ins (boxes, a cut-out grid): the look, not the set.
 *
 * WHAT THE WINDOW SHOWS. The underside draws the SKY through the window and nothing else: the raft's deck and sail,
 * are behind the surface's opaque underside and not refracted into it. So everything that must read against the window
 * here is UNDER the water (the synthesis: "everything that must read … is seen as a silhouette against the window"):
 * the raft's submerged logs, the floating pieces' undersides, the net, the dolphin. Refracting the world above the
 * water into the window (a cube of it, sampled along the refracted ray) is part of the XL build ("the FFT surface seen
 * from below, with refraction and total internal reflection"), not of this look.
 *
 * OPEN OCEAN, NOT A DROWNED TOWN (the user, 2026-11-02, on the c2 power-line stills: "we zoomed into what really looks
 * like an ocean, flooding or not"; the coordinator: "in the open ocean there is no seabed structure near the surface
 * … below is deep blue void and depth … the vertigo of the depth below is the point"). The synthesis's storyboard put
 * a pylon crown and a drowned radio mast with the case in its guy wires under the window; the first build of this file
 * had both, and neither was ever drawn: they are gone. What is near the surface is only what floats — the sea's own
 * debris field, a few pieces of wreckage drifting over the window, a ghost net hanging from its floats with the blue
 * case snagged in it, the dolphin passing — and under it, nothing: the water clear (the shared open-ocean K_d, ~100 m
 * of blue), the Sun's shafts slanting down through it and converging toward their vanishing point far below.
 *
 * Every frame a pure function of t: the set is laid from the eye's pose at t, the dolphin and the drifting pieces move
 * on t, the shafts' noise drifts on t.
 *
 * TWO LIGHTS (after gate 2, 2026-11-02, the user: "yes lets do it, try stuff, lets see"): `?linedown` is the sunset
 * moment above; `?linedown=day` the synthesis's brighter-water fallback, 319–335 s in the morning landing, the eye
 * gliding in under the raft through the flood's debris (LINE_DOWN_DAY: the slot, and why). Same water model, same
 * shared K_d; the day's own scatter, trim and ceiling (WATER_DAY).
 *
 * THE DAY, BUILT (after the 2026-11-02 review of the look-dev clip: "water scenes start to look interesting, some more
 * polish and lets go"; still behind `?linedown=day`, the default off until the user has seen it). The look-dev's cuts
 * in and out are gone: the descent's last 20 s DIVE (lineDownDive.ts: the eye re-blocked from 315 s, through the
 * surface at a wave's trough at ~322 s, gliding on 8 m down to hang under the raft's near side, drifting back up
 * through it at ~331 s onto the landing's own rest at 335 s, so c1's follow begins from the very frame it always did),
 * each crossing under a veil of bubbles and foam with the eye's adaptation eased across it (lineDownVeil.ts,
 * `exposure`); the stand-ins are real flotsam (lineDownSet.ts) and the raft has weed under it; the raft's rig shows in
 * the window (lineDownWindow.ts); marine snow gives the water depth; and the dolphin is met here first (DAY_DOLPHIN).
 * The sunset version (`?linedown`) keeps its cut-in moment and takes the new flotsam.
 */
import * as THREE from 'three/webgpu';
import { Fn, If, Loop, abs, cameraPosition, exp, float, min, mix, mx_noise_float, output, positionWorld, pow, sin, smoothstep, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { causticsParams } from '../../params/caustics';
import { oceanSurfaceParams } from '../../params/oceanSurface';
import { EARTH_R } from '../getTheDrift/atmosphere';
import { DEBRIS_SPIN } from '../getTheDrift/timeline';
import { createDolphin, swimEnvelope, type Dolphin } from './dolphin';
import { createHardCase } from './hardCase';
import { skyIrradiance } from './seaSky';
import type { BeatName } from './beats';
import { DIVE, DIVE_A3, DIVE_LATE, DIVE_PACED, adaptAt, foamAt, planDive, type DivePlan, type DiveSpec } from './lineDownDive';
import { createFlotsam, createRaftWeed, type FlotsamPiece, type LeafSpec, type NetSpec } from './lineDownSet';
import { raftLogsInPlan } from './raft';
import { createLineDownVeil, type LineDownVeil } from './lineDownVeil';
import type { WindowRaft } from './lineDownWindow';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node unions
type Node = any;

const QUERY = typeof location !== 'undefined' ? new URLSearchParams(location.search) : undefined;
/**
 * ON BY DEFAULT, AS A3 (the user, 2026-11-02, on A3's round-3 clip: "I really like the way the dive and the dolphins look
 * now"; the coordinator: A3 becomes the film's, with a switch to turn it off). `drift.html?linedown=off` (or `=0`) draws
 * the approved landing without the dive, nothing here built; any other value picks a variant (lineDownLight).
 */
export const lineDownOn = (q: string | null | undefined): boolean => q !== 'off' && q !== '0';
export const LINE_DOWN_ON = lineDownOn(QUERY?.get('linedown'));
/**
 * WHICH LIGHT: A3 unless asked otherwise (`?linedown` bare, or no query at all); `?linedown=sunset` the synthesis's
 * c2–c3 moment at sunset; `?linedown=day` (A) the first daylight dive, `=paced` (A2), `=late` (B) — kept for the
 * comparisons they were built for.
 */
export type LineDownLight = 'sunset' | 'day' | 'paced' | 'late' | 'a3';
/**
 * `?linedown=day` A: the dive straight out of the descent (319–335 s); `?linedown=paced` A2: the raft seen from above
 * first, a gentle dip and ~12 s of calm under it, a slow surfacing onto the follow (lineDownDive.ts DIVE_PACED);
 * `?linedown=late` B: the landing as approved, then the dolphin takes us under in the follow's last light (DIVE_LATE).
 * `?linedown=a3` A3: between A and A2 — the landing whole, ~15 s with the raft, a ~9.5 s dip under A's framing with two
 * dolphins (lineDownDive.ts DIVE_A3). All the same day water; the user compares them (2026-11-02).
 */
export const lineDownLight = (q: string | null | undefined): LineDownLight => (q === 'sunset' || q === 'day' || q === 'paced' || q === 'late' || q === 'a3' ? q : 'a3');
export const LINE_DOWN_LIGHT: LineDownLight = lineDownLight(QUERY?.get('linedown'));
/**
 * LOOK-DEV ONLY, `&ldsun=<deg>`: the Sun raised to this elevation (its bearing kept) in the sea's drive — what the
 * synthesis's "brighter midday water" would look like. The landing's own Sun is a morning one (timeline.ts
 * MORNING_SUN, 11°): a real high Sun at 320 s would mean re-blocking Act 2's Sun-day, which this does not do. Off
 * (undefined) unless asked.
 */
export const LINE_DOWN_SUN_EL: number | undefined = QUERY?.has('ldsun') ? Number(QUERY.get('ldsun')) : undefined;
/** `sun` (unit, toward the Sun) turned up to `el` deg over the horizon about its own bearing, in place */
export function raiseSun(sun: THREE.Vector3, el: number): THREE.Vector3 {
  const h = Math.hypot(sun.x, sun.z);
  const r = (el * Math.PI) / 180;
  const [x, z] = h > 1e-6 ? [sun.x / h, sun.z / h] : [0, -1];
  return sun.set(x * Math.cos(r), Math.sin(r), z * Math.cos(r));
}

/**
 * THE MOMENT (the synthesis's storyboard, 365–410 s: beneath, the case, the dolphin). Beat-relative (beats.ts),
 * so it holds the show's times: c2 starts at ~355 s, c3 at ~385 s.
 */
export const LINE_DOWN = {
  /** under from here … (beat, s into it; the synthesis's 365–410 s) */
  from: ['c2', 10] as [BeatName, number],
  /** … to here */
  to: ['c3', 25] as [BeatName, number],
  /** m: the eye under the mean sea. Deep enough that the window (radius depth·tan 48.6° on the surface: 5.7 m at 5 m)
   * holds the raft's cross and the drifting wreckage at once, shallow enough that the sunset's red survives the way up
   * (K_red 0.36/m: e^(−0.36·5) = 0.17 — the look's main risk, see WATER; at 6 m, r1, 0.12 and the window read as
   * no sunset at all) */
  depth: 5,
  /** m: the eye from the raft's centre, right and ahead in the eye's level frame — under the raft's quarter, so the
   * logs cross one side of the window and the wreckage the other */
  offset: [-3, -4] as [number, number],
  /** × the show's exposure while under: the eye adapting to the water's dimmer light (1 = none) */
  adapt: 1.6,
};

/**
 * THE BRIGHTER-WATER FALLBACK (`?linedown=day`; the synthesis: "the dome pitch's 300–345 slot (beneath the debris
 * spiral, brighter midday water) is the fallback if the sunset water proves too dark in look-dev" — and gate 2 found
 * exactly that: at sunset 83% of the red is gone 5 m down, the window turned teal-green and swampy, the deep black).
 *
 * WHAT IS THERE NOW (the 665ba98 preview, 2026-11-02): 296–318 s the descent is still in the air, over the cloud
 * deck, then through it; ~326 s the raft is a speck ahead; ~335 s the descent comes to rest beside it (c1's follow
 * starts, C1_FOLLOW before c2); 337–344 s the sail goes up, 342–351 s it gets way on, and from ~338 s the Sun is
 * time-lapsed down to c2's sunset. THE SUN IS NOT A MIDDAY ONE: the landing's is a morning Sun, 11° up, ahead and a
 * little left (timeline.ts MORNING_SUN). So "brighter" here comes from the sky's colour, not its height: a blue
 * morning sky and a white Sun lose little on the way down (K_blue 0.02/m), where the sunset's light was nearly all
 * the red the water eats. (`&ldsun=<deg>` shows a high Sun for comparison: LINE_DOWN_SUN_EL.)
 *
 * THE SLOT, 319–335 s, the last of the descent: the eye does not stop at the surface — it carries on down into the
 * flood's debris field, the drowned world's flotsam overhead in the window, and FINDS THE RAFT FROM BELOW: its logs a
 * dark shape low ahead against the silver ceiling, rising into the window as the eye glides in under it, and the eye
 * comes up beside it where the landing comes to rest. Everything lost, a few remain, they find each other — the first
 * close sight of the raft is from the drowned side. It ends at c1's follow (c2 − C1_FOLLOW), so the hoist and the
 * sail are untouched: the dramaturg's objection to this slot ("it eats C1_FOLLOW") does not apply to it. The
 * critics' other one does: at 320 s there is no character yet but the raft itself.
 *
 * WHAT THE STILLS SHOWED (rounds r1–r5, 2026-11-02, 16:9 and one 4096² dome frame to a row-8 seat): at the landing's
 * own 11° Sun the water reads blue, not the sunset's swamp, once the eye adapts (`adapt`) and the shafts are sheets
 * (SHAFTS_DAY); the low Sun slants them steeply, fanning out from its spot at the window's front edge just beside the
 * raft — on the dome they come down toward the audience. A 40° Sun (`&ldsun=40`) is bluer and brighter still, but
 * flatter: the shafts nearly vertical, the raft's silhouette washed out by the light between it and the eye. So the
 * look does not need a higher Sun, and the landing's light stays as it is.
 */
export const LINE_DOWN_DAY = {
  /** the dive from here … (beat, s into it: before c2, so within c1; lineDownDive.ts DIVE has its inner keys) */
  from: ['c2', DIVE.from] as [BeatName, number],
  /** … to here: the follow's start, where the descent comes to rest beside the raft (the eye back at its height) */
  to: ['c2', DIVE.to] as [BeatName, number],
  /** × the show's exposure while under, at the landing's own 11° Sun: the r1 day stills at 1.25 were a dark teal
   * (the light on the level at 11° is a third of a 40° Sun's: sin 11° against sin 40°), the same scene at a 40° Sun
   * (&ldsun=40) clear blue at 1.25 — so the eye adapts the difference, and the high-Sun look keeps 1.25 */
  adapt: 2.1,
  adaptHighSun: 1.25,
};

/**
 * THE WATER (per fragment: see the header). `murk` × the shared Jerlov K_d (params/caustics: R 0.36, G 0.06, B 0.02
 * per m — open ocean, ~100 m of blue: the open sea's clear water, the depth's vertigo; a drowned coast's would be
 * ~1.8, ~30 m of seeing). `scatter`: the water's in-scatter as a
 * share of the light it is bathed in (b/c per channel: red absorbed before it scatters, blue the colour of the open
 * deep — at (0.02, 0.11, 0.14) the r1 stills read as a green swamp, not the ocean); `up`/`down`: the deep's radiance looking up toward the light against looking down into the dark.
 */
const WATER = { murk: 1, scatter: [0.01, 0.05, 0.12] as [number, number, number], up: 1.4, down: 0.4 };
/** the shafts: m of view ray marched, steps, × the refracted Sun's in-scatter (β·phase, a look gain), the surface
 * noise's scale (1/m) and drift (m/s), the forward lobe's g (Henyey–Greenstein) and the share of an even (isotropic)
 * lobe beside it: with the forward lobe alone, the shafts looking DOWN — away from the Sun, the depth's vertigo —
 * were black (the r1 stills: 0–1 of 255); water's own phase function has a long side- and back-scattering tail */
const SHAFTS = { reach: 60, gain: 0.05, scale: 0.32, drift: 0.35, g: 0.72, iso: 0.25, steps: 10, ridge: 0, tint: [1, 1, 1] as [number, number, number], far: false, raftShade: false, warp: [0, 0, 0] as [number, number, number] };
/** n of sea water */
const N_WATER = 1.333;
/** cos of the critical angle, 48.6°: the edge of Snell's window seen from below a flat surface */
const CRITICAL_COS = Math.sqrt(1 - 1 / (N_WATER * N_WATER));

/** THE WINDOW TRIM AND THE CEILING (params/oceanSurface: live, read by the underside only — never seen in the show
 * above the water). The window carries n² = 1.78 of the sky's radiance by physics; the review asks that it "stay below
 * the sky's" (no brighter on the dome than the sky the audience has just seen), so it is trimmed to WINDOW_TRIM before
 * the water's own extinction on the way down. The ceiling outside the window mirrors the deep below, so it is DARK: at
 * the game's teal (#0e5a5e) and at #082a30 (r1) it shone as bright as the window and the disc did not read at all. */
const WINDOW_TRIM = 0.5;
const CEILING = '#020a0c';

/**
 * THE DAY'S WATER (`?linedown=day`): the same model, the same shared K_d. What changes is what the light is made of —
 * the deep's scatter leans further to the blue (the sunset's teal came from green being the colour that survived; in
 * a white light the open ocean's own in-scatter is blue, b_blue ≫ b_green: Morel's clear-water ratio), the window is
 * trimmed to the sky's own brightness after the eye's adaptation (WINDOW_SKY_DAY), and the ceiling outside it
 * mirrors a blue deep, not a black one — still darker than the window, so the disc reads. `down` stays well above 0:
 * looking down is the vertigo, deep blue, never black (the brief: "blue fading to deep blue … not black").
 */
const WATER_DAY = { murk: 1, scatter: [0.005, 0.05, 0.18] as [number, number, number], up: 1.5, down: 0.6 };
/**
 * The day's shafts (the r1 day stills, 2026-11-02: a soft glow toward the Sun, no shafts — the noise's 3 m blobs
 * extruded along the beam are fog, not light): RIDGED, `pow(1 − |noise|, ridge)`, the thin network where the noise
 * crosses zero — the lines the waves' lenses focus the light into (caustics are that network on a wall; the shafts are
 * it extruded down the refracted Sun), at 1.8 m. 64 steps: at the fixed places `far` needs, a ray looking up meets
 * only the steps short of the surface, and at 24 (and still at 48) each step's shell of the network showed on its own —
 * a web of bright curves across the lower dome, faint rings round the window — where 64 at ridge 6 reads as shafts (the
 * s48/s64 dome frames, 2026-11-02; the clip renders 16 s of 4096² in ~2 min on one farm box, so the cost is fine). `tint`:
 * the in-scatter's own colour (clear water scatters blue far more than red: b ∝ λ^−4.3 for the water itself, flat for
 * its particles — about half of each), which the sunset's soft shafts never needed: there, there was no blue to scatter.
 * ROUND 2 (2026-11-02: "still a bit wonky"): ridge 4 at 0.42/m, not 6 at 0.55 — wider, softer sheets — gain 0.07, and
 * `warp` (m, 1/m, rad/s): the entry point swayed by a slow undulation, so the sheets bend and sway with the surface
 * (beamAt).
 */
const SHAFTS_DAY = { ...SHAFTS, reach: 160, gain: 0.07, scale: 0.42, steps: 64, ridge: 4, tint: [0.42, 0.62, 1] as [number, number, number], far: true, raftShade: true, warp: [0.7, 0.45, 0.35] as [number, number, number] };
/**
 * `far`: the steps laid QUADRATICALLY along the ray at fixed places (s = reach·u²), fine near the eye where a sheet is
 * wide on the screen, coarse far off where it is a hair and the water has dimmed it, so the march reaches 160 m, where
 * the blue light is down to 4% (e^−0.02·160) — the sunset's even 60 m stopped it at 30%. And it ends where the ray
 * leaves the water.
 * `raftShade`: the raft's shadow in the shafts — a beam that entered the water under the logs carries no light (the r2
 * stills: the glow round the Sun went on straight through the raft, a bright arch over its logs from below).
 */
const RAFT_SHADE = { halfWidth: 2.7, halfLength: 6.3, soft: 1.0 };
/** the day's window, as a share of the sky the audience saw above it, on the dome (after the eye's adaptation and n²:
 * trim = WINDOW_SKY_DAY / (adapt · n²); the review's "the window's brightness stays below the sky's" — at 1 it
 * meets it, before the few metres of water take their share). The r1 day stills' fixed 0.7 put the window at 1.6×
 * the sky at 1.25 adapt, and the adapt the 11° Sun needs (2.1) would have made that 2.6× */
const WINDOW_SKY_DAY = 1.0;
const CEILING_DAY = '#06243a';
/**
 * THE LAST QUARTER-METRE (m, ×): round 2's seat clips of A2 and B showed one frame darker by a third at each surfacing
 * (87 → 50 → 91 of 255): the eye a few centimetres under the surface, the ceiling's dark ring round the window at its
 * widest on the dome. Narrowing the ocean's waterline band (params undersideEyeBand) to 3 cm through the dive, the first
 * try, made it a black frame (88 → 30 → 96, A3's clip): with the eye a hair above the CPU's sea a crest beside it is
 * drawn from behind with the top's shading. So the band stays the show's, and the eye's exposure lifts by up to
 * NEAR_LIFT within NEAR_SURFACE of the surface, on either side (A3's re-render: the dark frame is the first in the air,
 * 4 cm over the water, 99 → 46 → 74 → 96) — the frame comes up to its neighbours.
 */
const NEAR_SURFACE = 0.35;
const NEAR_LIFT = 0.7;
/** the first frames in the air (× on top of AIR_START's 0.6): the frame the surface passes the eye still measured 96 →
 * 73 → 110 at 0.7 (A3's round-2 clip); 1.4 overshot to 130 against 120 (round 3) */
const NEAR_LIFT_AIR = 1.0;

/**
 * THE SET, in the eye's level frame (x right, y up from the mean sea, z AHEAD), laid about the eye under the water:
 * only what floats (lineDownSet.ts: what each piece is, and where it comes from).
 *   pieces  planks, a door, a chair, a barrel, a tyre, a branch in leaf afloat over the window, drifting (the Act 2
 *           debris galaxy's rhyme): m right, m ahead, a turn (rad)
 *   net     a ghost net hanging from a line of floats, NET.drop m deep, billowing; the case snagged in it at NET.snag
 *   dolphin crossing the window from the left, 2.5 m under, at DOLPHIN.pass
 */
const PIECES: FlotsamPiece[] = [
  { kind: 'plank', at: [-2.5, 2], turn: 0.4, length: 2.6 },
  { kind: 'door', at: [3.2, -1.5], turn: -0.3 },
  { kind: 'chair', at: [-1, -5.5], turn: 0.9 },
  { kind: 'barrel', at: [-5.5, -2.5], turn: 0.5 },
  { kind: 'tyre', at: [1.5, 6.5], turn: 0 },
  { kind: 'branch', at: [2.5, 3], turn: -0.6 },
];
/** the net: its float line from `a` to `b` (m right, m ahead), hanging `drop` m, the case snagged at (share along,
 * m down) */
const NET = { a: [-7, -0.5] as [number, number], b: [-2.5, 5.5] as [number, number], drop: 3.2, snag: [0.55, 1.7] as [number, number] };
/**
 * THE DAY'S SET, about the landing's rest (x right, z ahead of where the eye comes to rest; the dive's way under the
 * water runs from ~(3.7, 5.6) at the entry out to its hang at ~(3.4, 8.1), 8 m down, and back to ~(1.0, 1.2) at the
 * surfacing; the raft is at ~(4.7, 17.4)). Overhead of the way, inside the window's 9 m: the door, the planks, the tyre,
 * the chair, the barrel, a twig and the branch in leaf with its loose leaves; to the left, seen across the blue, the
 * ghost net. None within the raft's berth (sea.ts RAFT_BERTH, 7.5 m), each piece 2.5 m or more from where the eye goes
 * through the surface (in the first round's stills a branch beside the surfacing filled the veil with leaves a hand's
 * breadth from the lens), and the set is gone with the surfacing's veil: it would float beside c1's first frame.
 */
const DAY_SET: FlotsamPiece[] = [
  { kind: 'door', at: [-1.0, 9.0], turn: 0.4 },
  { kind: 'plank', at: [6.5, 6.5], turn: 0.3, length: 2.6 },
  { kind: 'plank', at: [-2.5, 4.5], turn: 1.2, length: 1.9 },
  { kind: 'plank', at: [-3.5, 11.0], turn: -0.5, length: 2.2 },
  { kind: 'plank', at: [7.5, 2.5], turn: 0.9, length: 2.4 },
  { kind: 'chair', at: [7.5, 9.5], turn: 2.1 },
  { kind: 'barrel', at: [-4.5, 7.0], turn: 0.8 },
  { kind: 'tyre', at: [0.5, 6.0], turn: 0 },
  { kind: 'branch', at: [-1.5, 2.0], turn: 0.25, length: 2.8 },
  { kind: 'twig', at: [5.8, 3.0], turn: -1.1, length: 1.2 },
  { kind: 'twig', at: [-6.0, 12.0], turn: 0.7, length: 1.4 },
];
/**
 * THE DOLPHIN, FIRST MET UNDER THE WATER (`?linedown=day`; the user, 2026-11-02: "seeing the dolphin under water could
 * be a thing too right? maybe a great opportunity?" — and the coordinator: it answers the dive's gap, no character
 * until the raft, and sets up its c3 scene at ~400 s). One dolphin, in the rest's frame (x right, z ahead, m; y m under
 * the mean sea; times s from c2's start: 323–332 s of the show). It comes out of the blue deep low ahead, past the raft's
 * keel, rises and crosses over the eye's hang through the window from front to back (~3.3 m/s, ~3 s inside the
 * window, ~4–5 m over the eye; the eye drifting back under it, the same way), swings round to the right and up, and
 * breaks the surface ~5 m right of where the eye comes up, just before it — leading us up — its leap coming down
 * behind the eye as it surfaces (gone with the set, under the surfacing's veil). Seen from below as an outline
 * against the window (dolphin.ts: its beak, its falcate fin, its flukes beating up and down, not side to side).
 */
export const DAY_DOLPHIN: Array<[number, number, number, number]> = [
  [-31.5, -4, 27, -12],
  [-30.0, -1.5, 19, -7],
  [-28.5, 0.8, 14.0, -3.8],
  [-27.0, 2.4, 10.5, -2.6],
  [-25.6, 3.6, 7.0, -2.2],
  [-24.8, 5.0, 4.2, -1.6],
  [-24.3, 6.0, 2.4, -0.2],
  [-23.9, 6.6, 0.6, 0.8],
  [-23.4, 7.2, -1.4, 0.0],
  [-22.8, 7.7, -3.4, -1.5],
];

/** s (from c2's start) after which it is gone: back under the water behind the eye, which is in the air by then */
export const DAY_DOLPHIN_GONE = -23.4;
/** m: how far short of the raft's centre the later dips hang (A's hang: ~9.4 m) */
const HANG = 9.5;
/** m: A3's, shallow (3.5 m down): ~6 m short of the raft's centre puts its near logs in the window, as A's framing had them */
const HANG_A3 = 6;
/** the raft in the day set's frame (m right, ahead of the rest) that DAY_SET, DAY_NET, DAY_LEAVES and DAY_DOLPHIN were
 * laid against (A's rest); the later dips' rests see it elsewhere, and the layout is turned and scaled onto it */
const DAY_RAFT: [number, number] = [4.7, 17.4];
/**
 * B'S DOLPHIN LEADS (`?linedown=late`; the writers' room's "the dolphin takes us under"): before the dip it comes up
 * beside the raft's near side — its back and fin out for a breath — and dives ahead of the eye, which follows it down;
 * under the water it is A's dolphin (DAY_DOLPHIN), its times stretched over the longer dip. Keys: s before the dip's
 * entry, m from the raft (right, ahead in the set's frame), m under the mean sea.
 */
const LATE_DOLPHIN_LEAD: Array<[number, number, number, number]> = [
  [-3.2, -2.5, -9, -0.9],
  [-2.4, -2.0, -6.5, -0.15],
  [-1.6, -1.6, -4.5, -0.6],
  [-0.6, -1.2, -2.5, -3.2],
];
/**
 * A3'S DOLPHINS (the user, 2026-11-02, on A2's: "the dolphin's movement looks too weak for being there so long … too stiff
 * in its movements"; the coordinator: "closer and more alive … a roll to show its belly … maybe a second dolphin, or a
 * circling pass around the raft's shadow column … an exit that leads us up"). Two, in A's set frame (DAY_SET's: m right,
 * m ahead of the rest; m under the mean sea), timed in s from the eye's own entry over A3_UNDER s to its surfacing (the
 * dip's real crossings, at the sea's troughs). ONE comes out of the blue low ahead-left and crosses the window over the
 * eye's hang ~4.5 m above it, rolling through a full turn as it passes (`roll`, s: the belly, the flippers, the back
 * turning over against the light), swings right and back and rises to break the surface ahead of the raft's near
 * side just before the eye comes up. THE OTHER circles the raft's shadow column — the dark slant under the logs where
 * the Sun's shafts are cut off (lineDown.ts RAFT_SHADE: it falls away from the Sun, ~1.1 m aside per metre down at the
 * landing's 11°) — once round at 5 m down, then rises with the first. Both beat in bursts and glide between them
 * (dolphin.ts swimEnvelope), bank into their turns, and break the surface clear of the raft's berth.
 */
export const A3_UNDER = 9.5;
/** s of A3's dip with only the water in it before the dolphins come (the user: "first … a bit of time to breathe"):
 * the sink and the rest at the bottom (lineDownDive.ts DIVE_A3 `rest`) */
export const A3_BREATHE = 5;
export const A3_LEAD: { keys: Array<[number, number, number, number]>; gone: number; roll: [number, number]; hz: number } = {
  // (round 2: the eye hangs shallow, ~6 m short of the raft — at ~(3.1, 11.6), 3.5 m down — and the pass goes over it
  // ~3 m off, the roll there)
  keys: [
    [0.0, -8, 20, -9],
    [1.5, -4, 17, -5.5],
    [3.0, -0.5, 14.5, -1.8],
    [4.2, 4.0, 12.6, -0.8],
    [5.5, 8.0, 10.0, -1.4],
    [7.0, 9.6, 12.0, -3.0],
    [8.3, 7.8, 13.7, -1.2],
    [9.0, 7.2, 13.0, 0.2],
    [9.6, 6.6, 12.4, -0.9],
  ],
  gone: 9.65,
  roll: [3.6, 5.0],
  hz: 1.7,
};
export const A3_CIRCLER = (() => {
  // (the shadow column at 5 m down: the raft's centre, carried away from the Sun — 30° left of the front, 11° up,
  // refracted to ~47° off the vertical — by ~1.09 m a metre of depth)
  // (round 2: the column's slant taken a little further aside, so the circle keeps ~4 m off the shallow eye)
  const c: [number, number] = [9.5, 14.5];
  const keys: Array<[number, number, number, number]> = [];
  for (let k = 0; k <= 6.0001; k += 0.5) {
    const a = -2.2 + (2 * Math.PI * k) / 5.6;
    keys.push([k, c[0] + 2.5 * Math.cos(a), c[1] + 2.5 * Math.sin(a), -4.8 + 0.5 * Math.sin(2 * a)]);
  }
  keys.push([7.0, 11.0, 13.0, -2.8], [8.2, 11.6, 12.4, -0.6], [8.8, 11.8, 12.0, 0.4], [9.4, 12.0, 11.6, -0.8]);
  return { keys, gone: 9.45, roll: [0, 0] as [number, number], hz: 1.5 };
})()
const DAY_NET: NetSpec = { a: [-8.5, 4.5], b: [-5, 11.5], drop: 3.4 };
/** A3's furniture (round 2, the shallow hang ~(3.1, 11.6), its window ~4 m across): the door, the chair, the tyre and the
 * barrel brought in over the hang, each still 7.5 m or more from the raft's centre (its berth), in DAY_SET's order (the
 * rest where DAY_SET has them) */
const A3_FURNITURE: Array<[number, number] | undefined> = [[2.0, 9.0], undefined, undefined, undefined, undefined, [4.6, 9.4], [-1.5, 8.0], [0.2, 10.4]];
/** the loose leaves round the branch, none within 1.8 m of where the eye goes in and comes up (`clear`: the dive's
 * own places, filled in when it is planned) */
const DAY_LEAVES: LeafSpec = { at: [-0.5, 5.5], spread: 5, clearRadius: 1.8 };
/** the dolphin: the time it crosses over the eye (beat, s), m under, m/s, m ahead of the eye where it crosses, m either side it is drawn */
const DOLPHIN = { pass: ['c2', 17] as [BeatName, number], depth: 2.5, speed: 4.2, ahead: 2, reach: 30 };

export interface LineDown {
  /** the set: add to the sea's scene */
  readonly group: THREE.Group;
  readonly ready: Promise<void>;
  /** put the eye under the water (the sea's eye hook: sea.ts `reviewEye`'s place, see main-drift.ts) when `t` (sea s)
   * is in the moment; returns whether it did */
  place(t: number, eye: THREE.Object3D, raft: { x: number; z: number; heading: number }): boolean;
  /** after the sea's update: the water's light, the set's motion, for sea time t */
  update(t: number, eye: THREE.Object3D): void;
  /** × the show's exposure this frame */
  readonly exposure: number;
  /** the dive (the day's, once it has its drive and its sea: lineDownDive.ts) */
  readonly plan: DivePlan | null;
  setPixelAngle(rad: number): void;
}

/** what the day's dive is built from (main-drift.ts): the descent's eye at sea s, the sea the GPU draws, the window */
export interface LineDownDayInputs {
  /** the descent (Act 2's drive, as the sea takes it): the eye, its heading, the debris field's drift time */
  drive: (t: number) => { eye: THREE.Vector3; yaw: number; driftTime: number };
  /** the sea's height (m) at world x, z and sea s t (sea.ts probeWater: the CpuOcean the rafts float on) */
  water: (x: number, z: number, t: number) => number;
  /** the raft's rig in Snell's window (lineDownWindow.ts; wired into the sea as its `windowSky`) */
  window?: WindowRaft;
  /** the show eye's own place at sea s t (sea.ts baseEye: the descent, then the follow): the later dips' path */
  base?: (t: number, out: THREE.Vector3) => THREE.Vector3;
  /** the raft's place at sea s t once it sails (sea.ts probeRaft 'sea'): where the later dips glide to */
  raft?: (t: number) => { x: number; z: number };
}

/**
 * The look-dev for `scene` (the sea's), its moments at beat starts `starts` (sea s). Sets the scene's fog node (the
 * water) and the underside's trim; builds the set. The day's dive needs `inputs` (without them — the tests — it is
 * not planned and the eye is never moved).
 */
export function createLineDown(_renderer: THREE.WebGPURenderer, scene: THREE.Scene, starts: Record<BeatName, number>, light: LineDownLight = LINE_DOWN_LIGHT, inputs?: LineDownDayInputs): LineDown {
  const at = ([b, s]: [BeatName, number]): number => starts[b] + s;
  // (the day's water, its set and its dolphin, for all three day variants; `spec` the dip's timing and shape)
  const day = light !== 'sunset';
  const variant: DiveSpec = light === 'paced' ? DIVE_PACED : light === 'late' ? DIVE_LATE : light === 'a3' ? DIVE_A3 : DIVE;
  const later = light === 'paced' || light === 'late' || light === 'a3';
  const WATER_ = day ? WATER_DAY : WATER;
  const SHAFTS_ = day ? SHAFTS_DAY : SHAFTS;
  const from = day ? starts.c2 + variant.from : at(LINE_DOWN.from);
  const to = day ? starts.c2 + variant.to : at(LINE_DOWN.to);
  const pass = at(DOLPHIN.pass);
  // THE DIVE (lineDownDive.ts): the eye's place from `from` to `to`, through the surface at two troughs
  const water = inputs?.water;
  /** the path the dip leaves and comes back to: A's the descent's drive; the later ones the show eye's own (the follow) */
  const basePath = (t: number): [number, number, number] =>
    (later && inputs?.base ? inputs.base(t, new THREE.Vector3()) : inputs!.drive(t).eye).toArray() as [number, number, number];
  // THE LATER DIPS' GLIDE (A2, B): toward the raft, to hang ~HANG m short of its centre at the bottom (A's own glide
  // was laid by hand to the same end: lineDownDive.ts DIVE.glide)
  const restYaw0 = inputs ? inputs.drive(to).yaw : 0;
  const spec: DiveSpec = { ...variant };
  if (later && inputs?.raft) {
    const tb = starts.c2 + variant.bottom;
    const [bx, , bz] = basePath(tb);
    const rf = inputs.raft(tb);
    const [dx, dz] = [rf.x - bx, rf.z - bz];
    const right = dx * Math.cos(restYaw0) - dz * Math.sin(restYaw0);
    const ahead = -dx * Math.sin(restYaw0) - dz * Math.cos(restYaw0);
    const k = Math.max(0, 1 - (light === 'a3' ? HANG_A3 : HANG) / Math.max(1e-3, Math.hypot(right, ahead)));
    spec.glide = [right * k, ahead * k];
  }
  const plan = day && inputs ? planDive(starts.c2, basePath, inputs.water, restYaw0, spec) : null;
  if (plan && !(plan.check.down && plan.check.up))
    // FAIL LOUD: a crossing that is not single, or slow through the waterline band, is a strobe on the dome
    console.error(`lineDown: the dive's crossings are not clean (down ${plan.check.down}, up ${plan.check.up}) — check the sea at ${plan.down.toFixed(2)} / ${plan.up.toFixed(2)} s`);
  if (plan) console.info(`lineDown: the dive goes in at sea ${plan.down.toFixed(2)} s, comes up at ${plan.up.toFixed(2)} s; clearance ${plan.check.clearance.toFixed(2)} m`);
  /** m under the mean sea at t (the sunset's eye holds its depth; the day's is the dive's) */
  const depthAt = (t: number): number => (plan ? -plan.y(t) : LINE_DOWN.depth);
  const offsetAt = (): [number, number] => LINE_DOWN.offset;
  // the day's set rides the debris field's turn from where it lies when the eye comes to rest (`to`): the raft does,
  // and the eye with the descent's drift, so the set keeps its place against both
  // (the set's frame: A's at the rest it comes up onto; the later dips' at the eye's place at the bottom, where the
  // eye, sailing with the raft, hangs — the set lies in the field round its way under the water)
  const tFrame = later ? starts.c2 + variant.bottom : to;
  const rest = day && inputs ? inputs.drive(tFrame) : null;
  const restEye = rest ? new THREE.Vector3(...basePath(tFrame)) : new THREE.Vector3();
  const restYaw = rest ? rest.yaw : 0;
  const restDrift = rest ? rest.driftTime : 0;

  // ── THE WATER: every material's output, per fragment, from the world ray eye → fragment ──────────────────────
  const uUnder = uniform(0);
  const K = new THREE.Vector3(causticsParams.submergedAbsorptionR, causticsParams.submergedAbsorptionG, causticsParams.submergedAbsorptionB).multiplyScalar(WATER_.murk);
  const uK = uniform(K);
  /** the deep's radiance at the eye (looking level), linear */
  const uDeep = uniform(new THREE.Vector3(0, 0, 0));
  /** unit, toward the Sun as it is under the water (refracted) */
  const uSunW = uniform(new THREE.Vector3(0, 1, 0));
  /** the refracted Sun's irradiance just under the surface, × the shafts' gain */
  const uShaft = uniform(new THREE.Vector3(0, 0, 0));
  const uTime = uniform(0);
  /** the raft for its shadow in the shafts: x, z (m), sin and cos of its heading */
  const uRaft = uniform(new THREE.Vector4(0, 0, 0, 1));
  /**
   * THE SHAFTS' GATE at a point p under the water (0..~2): the light of the refracted Sun that reaches p, by where its
   * beam entered the water — a ridged noise of that surface point drifting on t (the lines the waves' lenses focus the
   * light into), the raft's shadow cut out of it. One function for the march (waterOf) and the marine snow (lit only
   * where a shaft passes it: lineDownVeil.ts). ROUND 2 (the user, 2026-11-02, on the r-build clip: the shafts "start to
   * look okay, but still a bit wonky"): the entry point is WARPED by a slow swell-like undulation before the noise reads
   * it (SHAFTS.warp: m, rad/s), so the sheets sway and bend with the surface instead of sliding as rigid lines; the
   * ridges are softer (ridge 6 → 4, the sheets wider) and the raft's shadow column's edges a metre soft, not 0.6 m (its
   * box's straight edges read as a cut in the light).
   */
  const beamAt = (p: Node): Node => {
    const depth = p.y.negate().max(0);
    const run = depth.div(uSunW.y.max(0.2));
    const entry0 = p.xz.add(uSunW.xz.mul(run));
    const [wa, wf, ws] = SHAFTS_.warp;
    const entry = wa > 0 ? entry0.add(vec2(sin(entry0.y.mul(wf).add(uTime.mul(ws))), sin(entry0.x.mul(wf * 0.83).sub(uTime.mul(ws * 0.77)).add(1.3))).mul(wa)) : entry0;
    const n = mx_noise_float(vec3(entry.x.mul(SHAFTS_.scale), entry.y.mul(SHAFTS_.scale), uTime.mul(SHAFTS_.drift * SHAFTS_.scale)));
    const beam0 = SHAFTS_.ridge > 0 ? pow(float(1).sub(abs(n)).clamp(0, 1), SHAFTS_.ridge).mul(2.0) : pow(n.mul(0.5).add(0.5).clamp(0, 1), 3).mul(2.4);
    if (!SHAFTS_.raftShade) return beam0;
    // (the raft's shadow: the entry point in the raft's frame, against its logs' footprint, soft-edged)
    const q = entry0.sub(uRaft.xy);
    const along = abs(q.x.mul(uRaft.z.negate()).add(q.y.mul(uRaft.w.negate())));
    const across = abs(q.x.mul(uRaft.w).add(q.y.mul(uRaft.z.negate())));
    const { halfWidth: hw, halfLength: hl, soft } = RAFT_SHADE;
    const inside = float(1).sub(smoothstep(hw - soft, hw + soft, across)).mul(float(1).sub(smoothstep(hl - soft, hl + soft, along)));
    return beam0.mul(float(1).sub(inside));
  };
  /** the water applied to a material's colour `col` (vec4): its fog node's `output`, or a custom outputNode's */
  const waterOf = (col: Node, mirror = false): Node => Fn(() => {
    const c = vec4(col).toVar();
    If(uUnder.greaterThan(0.5), () => {
      const e = cameraPosition;
      const v = positionWorld.sub(e);
      const L = v.length();
      const d = v.div(L.max(1e-4));
      const T = exp(uK.mul(L).negate());
      // the deep: brighter toward the light overhead, dark below
      const deep = uDeep.mul(mix(float(WATER_.down), float(WATER_.up), smoothstep(-0.6, 0.9, d.y)));
      // the shafts: the refracted Sun's light scattered toward the eye along the ray, each step's beam gated by where it
      // entered the water (a noise of that surface point, drifting on t) and dimmed along its way down and to the eye
      // (`far`: and no further than where the ray leaves the water — a ray rising toward the surface ends there, whatever
      // it lands on behind it: the sea's underside melts into the sky at a grazing view past ~120 m, and the sky's
      // fragments behind it would march on through the air over the sea)
      const toSurface = d.y.greaterThan(1e-4).select(e.y.negate().max(0).div(d.y.max(1e-4)), float(1e9));
      const reach = SHAFTS_.far ? min(min(L, toSurface), float(SHAFTS_.reach)) : min(L, float(SHAFTS_.reach));
      const ds = reach.div(SHAFTS_.steps);
      const sum = vec3(0).toVar();
      Loop(SHAFTS_.steps, ({ i }: { i: Node }) => {
        // (even steps over the ray's reach; `far`: FIXED places s = SHAFTS.reach·u², each step 2u·reach/steps, and a
        // step past the ray's own end weighed out. The places must not move with the ray's length: laid over each ray's
        // own reach, a ray that met the sea's underside at 121 m and its neighbour a degree lower that ran on to 157 m
        // sampled the ridged sheets near the eye at different places, and the two estimates differed by a fifth — a hard
        // ring round the whole dome a few degrees over the eye's level (the r3–r4 day stills and the gate-2 dome frame,
        // 2026-11-02; found by hiding everything but the sea and the sky, and the water's other terms one by one))
        const u = float(i).add(0.5).div(SHAFTS_.steps);
        const s = SHAFTS_.far ? u.mul(u).mul(SHAFTS_.reach) : float(i).add(0.5).mul(ds);
        const step = SHAFTS_.far ? u.mul(2 * SHAFTS_.reach / SHAFTS_.steps).mul(reach.sub(s).div(u.mul(2 * SHAFTS_.reach / SHAFTS_.steps).max(1e-4)).add(0.5).clamp(0, 1)) : ds;
        const p = e.add(d.mul(s));
        const run = p.y.negate().max(0).div(uSunW.y.max(0.2));
        const beam = beamAt(p);
        sum.addAssign(exp(uK.mul(run.add(s)).negate()).mul(beam).mul(step));
      });
      // Henyey–Greenstein toward the refracted Sun
      const g = SHAFTS_.g;
      const mu = d.dot(uSunW);
      const hg = mix(float(1 - g * g).div(pow(float(1 + g * g).sub(mu.mul(2 * g)), 1.5).mul(4 * Math.PI)), float(1 / (4 * Math.PI)), SHAFTS_.iso);
      const inscatter = deep.mul(vec3(1).sub(T)).add(uShaft.mul(hg).mul(sum).mul(vec3(...SHAFTS_.tint)));
      // THE CEILING MIRRORS THE DEEP (`mirror`: the sea's underside, the day's only). Outside Snell's window the surface
      // reflects everything back down — what it shows there is the deep below, looked at along the mirrored ray. The
      // underside draws its ceiling as one dark colour (ocean/surfaceMaterial.ts underCeilingColor), so the mirrored deep
      // is added outside the window (by the flat surface's critical cosine, as soft as the window's own edge): at the
      // horizon the mirrored ray is the level one, and the far ceiling meets the deep below it.
      const rgb = c.rgb.toVar();
      if (mirror) {
        const outside = float(1).sub(smoothstep(CRITICAL_COS - 0.12, CRITICAL_COS + 0.12, d.y));
        const mirrored = uDeep.mul(mix(float(WATER_.down), float(WATER_.up), smoothstep(-0.6, 0.9, d.y.negate())));
        rgb.addAssign(mirrored.mul(outside));
      }
      c.assign(vec4(rgb.mul(T).add(inscatter), c.a));
    });
    return c;
  })();
  scene.fogNode = waterOf(output);
  const dayAdapt = LINE_DOWN_SUN_EL !== undefined ? LINE_DOWN_DAY.adaptHighSun : LINE_DOWN_DAY.adapt;
  oceanSurfaceParams.underWindowBrightness = day ? WINDOW_SKY_DAY / (dayAdapt * N_WATER * N_WATER) : WINDOW_TRIM;
  oceanSurfaceParams.underCeilingColor = day ? CEILING_DAY : CEILING;


  // ── THE SET ────────────────────────────────────────────────────────────────────────────────────────────────
  const group = new THREE.Group();
  group.name = 'line-down-set';
  group.visible = false;
  /** the eye's level frame → the group's (rotated by the eye's yaw: its −z the front) */
  const local = (x: number, z: number): [number, number] => [x, -z];

  // THE FLOTSAM (lineDownSet.ts): real pieces in place of the look-dev's boxes, riding the sea the GPU draws (the
  // sunset's eye-held set, without the sea at hand in its moment, rides the mean sea), and the ghost net with its floats
  /** a world place (x, z m) in the day's set frame: m right of and ahead of the eye's rest */
  const inRest = ([x, z]: [number, number]): [number, number] => {
    const [dx, dz] = [x - restEye.x, z - restEye.z];
    return [dx * Math.cos(restYaw) - dz * Math.sin(restYaw), -dx * Math.sin(restYaw) - dz * Math.cos(restYaw)];
  };
  /** a world place at sea s t in the set's frame: the field's turn since the frame's time taken back first (the set
   * rides the turn, ~0.5 m/s here, so a place seen 8 s off the frame's time is ~4 m from where it lies in the frame) */
  const inRestAt = ([x, z]: [number, number], t: number): [number, number] => {
    const th = inputs ? -DEBRIS_SPIN * (inputs.drive(t).driftTime - restDrift) : 0;
    return inRest([x * Math.cos(th) + z * Math.sin(th), -x * Math.sin(th) + z * Math.cos(th)]);
  };
  // (the later dips' layout: A's, turned and scaled so A's raft lands on where the raft is at the dip's end)
  const layoutTurn = { c: 1, s: 0, k: 1 };
  if (later && inputs?.raft) {
    const r = inRest([inputs.raft(tFrame).x, inputs.raft(tFrame).z]);
    const a0 = Math.atan2(DAY_RAFT[0], DAY_RAFT[1]);
    const a1 = Math.atan2(r[0], r[1]);
    layoutTurn.k = Math.min(1.4, Math.max(0.6, Math.hypot(...r) / Math.hypot(...DAY_RAFT)));
    layoutTurn.c = Math.cos(a1 - a0);
    layoutTurn.s = Math.sin(a1 - a0);
  }
  const lay = ([x, z]: [number, number]): [number, number] => {
    const { c, s, k } = layoutTurn;
    return [(x * c + z * s) * k, (-x * s + z * c) * k];
  };
  const leaves: LeafSpec = { ...DAY_LEAVES, at: lay(DAY_LEAVES.at), clear: plan ? [inRestAt(plan.xz(plan.down), plan.down), inRestAt(plan.xz(plan.up), plan.up)] : [] };
  const daySet = (light === 'a3' ? DAY_SET.map((q, i) => ({ ...q, at: A3_FURNITURE[i] ?? q.at })) : DAY_SET).map((q) => ({ ...q, at: lay(q.at) }));
  const dayNet = { ...DAY_NET, a: lay(DAY_NET.a), b: lay(DAY_NET.b) };
  const flotsam = createFlotsam(day ? daySet : PIECES, day ? dayNet : NET, day ? leaves : undefined);
  // (the sunset's set is laid in `group`, moved to the eye's place each frame; the day's group stays at the world's
  // origin and the flotsam is laid in the world, on the debris field's turn)
  group.add(flotsam.group);
  const [na, nb] = [local(...NET.a), local(...NET.b)];
  // THE WATERLINE'S FOAM, THE BUBBLES, THE SNOW, THE WET LENS (lineDownVeil.ts): the day's dive only, its bursts where the
  // eye goes in and comes up, the snow lit by the shafts' own gate
  let veil: LineDownVeil | null = null;
  if (plan) {
    const eIn = plan.xz(plan.down);
    const [a, b] = [plan.xz(plan.down - 0.5), plan.xz(plan.down + 0.5)];
    const eUp = plan.xz(plan.up);
    veil = createLineDownVeil({
      down: { t: plan.down, x: eIn[0], z: eIn[1], v: DIVE.vDown, vx: b[0] - a[0], vz: b[1] - a[1] },
      up: { t: plan.up, x: eUp[0], z: eUp[1], front: [-Math.sin(restYaw), -Math.cos(restYaw)] },
    }, { beam: beamAt });
    scene.add(veil.group);
  }
  // the case, snagged in it, tilted
  const theCase = createHardCase();
  theCase.position.set(na[0] + (nb[0] - na[0]) * NET.snag[0], -NET.snag[1], na[1] + (nb[1] - na[1]) * NET.snag[0]);
  theCase.rotation.set(0.6, 0.9, -0.4);
  group.add(theCase);
  // (the day's slot is the landing, before the case and the dolphin are in the story — c3's: the drowned world's
  // flotsam and the net only)
  theCase.visible = !day;

  // (the day's dolphin takes the water's light, dolphin.ts DolphinWater: set per frame from the light down there)
  const uDolphinDown = uniform(new THREE.Vector3());
  const uDolphinUp = uniform(new THREE.Vector3());
  const dolphin = createDolphin(day ? { water: { down: uDolphinDown, up: uDolphinUp } } : {});
  // (the day's dolphin in the scene itself: B's comes before the set does, in the air beside the raft)
  (day ? scene : group).add(dolphin.group);
  // THE DAY'S DOLPHIN'S KEYS for this variant (s from c2's start, m right, m ahead, m under): A's as laid; the later
  // dips' A's stretched in time over their own dip (A's keys are timed to A's nominal entry and surfacing) and turned with
  // the layout — and B's led in by LATE_DOLPHIN_LEAD, from beside the raft
  const stretch = (k: number): number => variant.down + ((k - DIVE.down) * (variant.up - variant.down)) / (DIVE.up - DIVE.down);
  const dolphinKeys: Array<[number, number, number, number]> = later
    ? [
        ...(light === 'late'
          ? LATE_DOLPHIN_LEAD.map(([k, x, z, y]) => {
              // (beside the raft where it is then: it sails on through the field while the dolphin leads)
              const rf = inputs?.raft ? inputs.raft(starts.c2 + variant.down + k) : { x: 0, z: 0 };
              const tk = starts.c2 + variant.down + k;
              const [rx, rz] = inputs?.raft ? inRestAt([rf.x, rf.z], tk) : lay(DAY_RAFT);
              const [ox, oz] = lay([x, z]).map((v) => v / layoutTurn.k) as [number, number];
              return [variant.down + k, rx + ox, rz + oz, y] as [number, number, number, number];
            })
          : []),
        ...DAY_DOLPHIN.map(([k, x, z, y]) => {
          const [lx, lz] = lay([x, z]);
          return [stretch(k), lx, lz, y] as [number, number, number, number];
        }),
      ]
    : DAY_DOLPHIN;
  const dolphinGone = later ? stretch(DAY_DOLPHIN_GONE) : DAY_DOLPHIN_GONE;
  // THE DAY'S DOLPHINS as TRACKS (sea s, m right, m ahead, m under, in the set's frame): A, A2, B one (dolphinKeys, from
  // c2's start); A3 two (A3_LEAD, A3_CIRCLER), timed from the dip's own entry to its surfacing
  interface Track {
    keys: Array<[number, number, number, number]>;
    gone: number;
    roll: [number, number];
    hz: number;
    seed: number;
    curve: THREE.CatmullRomCurve3;
    d: Dolphin;
    down: typeof uDolphinDown;
    up: typeof uDolphinUp;
  }
  const trackOf = (keys: Array<[number, number, number, number]>, gone: number, roll: [number, number], hz: number, seed: number, d: Dolphin, down = uDolphinDown, up = uDolphinUp): Track => ({
    keys,
    gone,
    roll,
    hz,
    seed,
    curve: new THREE.CatmullRomCurve3(keys.map(([, x, z, y]) => new THREE.Vector3(x, y, z))),
    d,
    down,
    up,
  });
  const tracks: Track[] = [];
  if (day && light === 'a3' && plan) {
    // (the dolphins' A3_UNDER s laid over the dip after its breather, ending just before the eye comes up)
    const at = (k: number): number => plan.down + A3_BREATHE + (k * (plan.up - 0.4 - plan.down - A3_BREATHE)) / A3_UNDER;
    const keysOf = (ks: Array<[number, number, number, number]>): Array<[number, number, number, number]> =>
      ks.map(([k, x, z, y]) => {
        const [lx, lz] = lay([x, z]);
        return [at(k), lx, lz, y];
      });
    tracks.push(trackOf(keysOf(A3_LEAD.keys), at(A3_LEAD.gone), [at(A3_LEAD.roll[0]), at(A3_LEAD.roll[1])], A3_LEAD.hz, 0, dolphin));
    const down2 = uniform(new THREE.Vector3());
    const up2 = uniform(new THREE.Vector3());
    const second = createDolphin({ water: { down: down2, up: up2 } });
    scene.add(second.group);
    tracks.push(trackOf(keysOf(A3_CIRCLER.keys), at(A3_CIRCLER.gone), [0, 0], A3_CIRCLER.hz, 1, second, down2, up2));
  } else if (day) {
    tracks.push(trackOf(dolphinKeys.map(([k, x, z, y]) => [starts.c2 + k, x, z, y]), starts.c2 + dolphinGone, [0, 0], 1.6, 0, dolphin));
  }
  /** a track's place in the set's frame at sea s t (x right, y up, z ahead) */
  const trackAt = (tr: Track, t: number, out: THREE.Vector3): THREE.Vector3 => {
    const n = tr.keys.length;
    let i = 0;
    while (i < n - 2 && t > tr.keys[i + 1][0]) i++;
    const u = (t - tr.keys[i][0]) / (tr.keys[i + 1][0] - tr.keys[i][0]);
    return tr.curve.getPoint(Math.min(1, Math.max(0, (i + u) / (n - 1))), out);
  };
  const trackOn = (tr: Track, t: number): boolean => t >= tr.keys[0][0] && t < tr.gone;
  /** whether any of the day's dolphins is out at sea s t */
  const dolphinOn = (t: number): boolean => tracks.some((tr) => trackOn(tr, t));
  const dA = new THREE.Vector3();
  const dB = new THREE.Vector3();
  const dC = new THREE.Vector3();

  for (const o of [group]) o.traverse((x) => void ((x as THREE.Mesh).isMesh && ((x as THREE.Mesh).castShadow = false)));

  // ── PER FRAME ──────────────────────────────────────────────────────────────────────────────────────────────
  const inMoment = (t: number): boolean => t >= from && t < to;
  let exposure = 1;
  let skyFor = new THREE.Vector3(0, -2, 0);
  let skyE: [number, number, number] = [0, 0, 0];
  let sun: THREE.DirectionalLight | null = null;
  const fogged = new WeakSet<THREE.Material>();
  const sunDir = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  /** where the sunset's set is laid (x, z m; yaw rad): where the eye is */
  const anchor = { x: 0, z: 0, yaw: 0 };
  /** the hero raft's group (sea.ts's `drift-raft` nearest the raft the eye hook reports), for the window and the weed */
  let raftGroup: THREE.Object3D | null = null;
  const weed = day ? createRaftWeed(raftLogsInPlan()) : null;
  const raftAt = { x: 0, z: 0 };
  const veilLight = new THREE.Vector3();
  const waterLight = new THREE.Vector3();
  const sunEv = new THREE.Vector3();
  const skyEv = new THREE.Vector3();
  const dayAdaptNow = (t: number): number => (plan ? adaptAt(t, plan.down, plan.up, dayAdapt) : dayAdapt);
  return {
    group,
    ready: flotsam.ready,
    plan,
    get exposure() {
      return exposure;
    },
    setPixelAngle(rad) {
      veil?.setPixelAngle(rad);
    },
    place(t, eye, raft) {
      if (!inMoment(t)) return false;
      raftAt.x = raft.x;
      raftAt.z = raft.z;
      // (heading 0 looks toward −z, as the eye's: the raft's logs lie along its heading)
      uRaft.value.set(raft.x, raft.z, Math.sin(raft.heading), Math.cos(raft.heading));
      if (day) {
        // THE DIVE: the descent's own turn (sea.ts put the eye there), its place the dive's
        if (plan) {
          const [x, z] = plan.xz(t);
          // (A3's rest at the bottom: still, but for a breath of sway — ±4 cm over 4 s, eased in and out with the rest)
          const r0 = starts.c2 + variant.bottom;
          const rr = variant.rest ? Math.sin(Math.PI * Math.min(1, Math.max(0, (t - r0 + 1) / (variant.rest + 2)))) : 0;
          eye.position.set(x, plan.y(t) + 0.04 * rr * rr * Math.sin((2 * Math.PI * (t - r0)) / 4), z);
        }
        return plan !== null;
      }
      // (the eye's level frame: its yaw, as sea.ts set it; heading 0 looks toward −z. Taken from its front, not
      // rotation.y: in c1 before the follow the eye is the landing's turn (sea.ts: eye.quaternion = the drive's), which
      // still holds the descent's pitch — its Euler y is not its heading then)
      fwd.set(0, 0, -1).applyQuaternion(eye.quaternion);
      const yaw = Math.atan2(-fwd.x, -fwd.z);
      const f = [-Math.sin(yaw), -Math.cos(yaw)];
      const r = [Math.cos(yaw), -Math.sin(yaw)];
      const [ox, oz] = offsetAt();
      eye.position.set(raft.x + r[0] * ox + f[0] * oz, -depthAt(t), raft.z + r[1] * ox + f[1] * oz);
      eye.rotation.set(0, yaw, 0, 'YXZ');
      anchor.x = eye.position.x;
      anchor.z = eye.position.z;
      anchor.yaw = yaw;
      return true;
    },
    update(t, eye) {
      // UNDER: the eye below the sea the GPU draws, at its own place (the ocean's own test: oceanSurface.ts
      // setWaterHeightAt) — so the water's fog and the sea's underside switch on the same frame
      const surface = water ? water(eye.position.x, eye.position.z, t) : 0;
      const depth = surface - eye.position.y;
      const under = inMoment(t) && (day ? depth > 0 : eye.position.y < -0.5);
      uUnder.value = under ? 1 : 0;
      // (the day's set from the dive's start, tiny from 100 m up among the field's pieces, to just after the surfacing,
      // under the veil — it would float beside c1's first frame; the sunset's while under)
      // (the later dips: the set comes and goes with the crossings themselves, the frames where everything changes —
      // from 315 s A's is a speck from 100 m up; at 3 m beside the raft it would pop in)
      group.visible = day ? plan !== null && (later ? t >= plan.down && t < plan.up : t >= from && t < plan.up + 0.1) : under;
      const v = plan && inMoment(t) ? foamAt(t, plan.down, plan.up) : 0;
      exposure = !inMoment(t) ? 1 : day ? (plan ? dayAdaptNow(t) : under ? dayAdapt : 1) : under ? LINE_DOWN.adapt : 1;
      // (under the water, and in the air just after the surfacing — not before the entry: lifted there, the last frame
      // in the air flashed, 134 against 120 round it, A3's round-2 clip)
      if (day && plan && inMoment(t) && Math.abs(depth) < NEAR_SURFACE && (under || t > plan.up))
        exposure *= 1 + (under ? NEAR_LIFT : NEAR_LIFT_AIR) * (1 - Math.abs(depth) / NEAR_SURFACE);
      // (the wet lens runs on ~1.5 s past the surfacing, into the follow: its light is this frame's, worked out below)
      const wetting = plan !== null && t > plan.up && t < plan.up + 1.7;
      if (day) for (const tr of tracks) tr.d.group.visible = trackOn(tr, t);
      if (!under && v <= 0 && !group.visible && !wetting && !dolphinOn(t)) {
        inputs?.window?.update(null, false, sunDir, sunEv, skyEv);
        veil?.update(t, eye.position, 0, veilLight, waterLight, false);
        return;
      }
      if (under) {
        // every material in the water takes the water (the sky's and the sea's had `fog: false`: from above, they do
        // their own haze — from below, the sky past the window's edge and below the horizontal IS the deep)
        scene.traverse((x) => {
          // (the veil, the bubbles and the snow are the water's own: lit as it, never fogged by it)
          if (x.userData.lineDownOwn) return;
          const m = (x as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
          for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
            if (fogged.has(mat)) continue;
            fogged.add(mat);
            // (the day's sea underside: the water through its own output, with the mirrored deep — fog left off, or the
            // water would go on twice: an outputNode is taken after the fog)
            if (day && x.name === 'ocean-surface') {
              (mat as THREE.Material & { outputNode?: Node }).outputNode = waterOf(output, true);
              mat.needsUpdate = true;
              continue;
            }
            const nm = mat as THREE.Material & { fog?: boolean; outputNode?: Node };
            if (nm.fog === false) {
              nm.fog = true;
              mat.needsUpdate = true;
            }
            // A CUSTOM OUTPUT REPLACES THE FOG (three's NodeMaterial: the outputNode is taken after setupOutput, which
            // is where the fog goes): the masts' and the stations' air (radioTower.ts expAir) mixes its haze over the
            // fogged colour, and the ring's stations on the horizon came through the deep as three bright unfogged
            // streaks in the gate-2 dome frame. Their output takes the water as well (the object's own colour twice:
            // it is in the deep at that range either way).
            if (nm.outputNode) {
              nm.outputNode = waterOf(nm.outputNode);
              mat.needsUpdate = true;
            }
          }
        });
      }
      // THE SET: the day's in the world, on the debris field's turn from the rest (the raft's and the eye's current);
      // the sunset's laid about the eye in its level frame
      if (day) {
        group.position.set(0, 0, 0);
        group.rotation.set(0, 0, 0);
        const turn = inputs ? DEBRIS_SPIN * (inputs.drive(t).driftTime - restDrift) : 0;
        const c = Math.cos(turn);
        const s = Math.sin(turn);
        // (three's turn about +y, as applyAxisAngle(UP, turn): x' = x cos + z sin, z' = −x sin + z cos)
        flotsam.update(t, { x: restEye.x * c + restEye.z * s, z: -restEye.x * s + restEye.z * c, yaw: restYaw + turn }, (x, z) => (water ? water(x, z, t) : 0));
      } else {
        group.position.set(anchor.x, 0, anchor.z);
        group.rotation.set(0, anchor.yaw, 0);
        flotsam.update(t, { x: 0, z: 0, yaw: 0 }, () => 0);
      }
      theCase.position.y = -NET.snag[1] + 0.06 * Math.sin(t * 0.5);
      // the dolphin across the window, nose first (its body along −z), its tail beating
      const s = t - pass;
      if (!day) {
        const [dx, dz] = local(DOLPHIN.speed * s, DOLPHIN.ahead + 0.15 * s);
        dolphin.group.position.set(dx, -DOLPHIN.depth + 0.25 * Math.sin(s * 0.8), dz);
        // heading: toward +x (its right) in the eye's frame, a little ahead: −90° about y turns its −z nose to +x
        dolphin.group.rotation.set(0.04 * Math.cos(s * 0.8), -Math.PI / 2 + 0.035, 0, 'YXZ');
        dolphin.set({ x: 0, y: 0, z: 0, heading: 0, pitch: 0, bend: 0.02, turn: 0, bank: 0, beat: 0.12, phase: s * 2.2 * Math.PI * 2, speed: DOLPHIN.speed, dry: 100 });
        dolphin.group.visible = Math.abs(DOLPHIN.speed * s) < DOLPHIN.reach;
      }

      // the water's light: the Sun as sea.ts set it this frame, the sky's irradiance for it (cached per direction)
      if (!sun) scene.traverse((x) => void (!sun && (x as THREE.DirectionalLight).isDirectionalLight && x.castShadow && (sun = x as THREE.DirectionalLight)));
      if (!sun) return;
      const S = sun as THREE.DirectionalLight;
      sunDir.copy(S.position).sub(S.target.position).normalize();
      if (sunDir.distanceTo(skyFor) > 2e-3) {
        skyFor = sunDir.clone();
        skyE = skyIrradiance(EARTH_R + 3e-6, new THREE.Vector3(0, Math.max(sunDir.y, -0.3), Math.hypot(sunDir.x, sunDir.z)).normalize());
      }
      const sunE = S.color.clone().multiplyScalar(S.intensity);
      // the light the water is bathed in at the eye's depth: the sky's irradiance and the Sun's on the level, down
      // through the eye's depth of water (Fresnel's loss at a low Sun left in the scatter's look gains)
      const el = Math.max(0, sunDir.y);
      const dEye = Math.max(0, depthAt(t));
      const down = (k: number): number => Math.exp(-[K.x, K.y, K.z][k] * dEye);
      const E = [0, 1, 2].map((k) => (skyE[k] + [sunE.r, sunE.g, sunE.b][k] * el) * down(k));
      uDeep.value.set((E[0] * WATER_.scatter[0]) / Math.PI, (E[1] * WATER_.scatter[1]) / Math.PI, (E[2] * WATER_.scatter[2]) / Math.PI);
      // the Sun refracted into the water: its horizontal run kept, sin θw = cos(el)/n
      const h = Math.hypot(sunDir.x, sunDir.z);
      const sinW = Math.min(1, h / N_WATER);
      const cosW = Math.sqrt(1 - sinW * sinW);
      uSunW.value.set((sunDir.x / Math.max(h, 1e-6)) * sinW, cosW, (sunDir.z / Math.max(h, 1e-6)) * sinW);
      uShaft.value.set(sunE.r, sunE.g, sunE.b).multiplyScalar(SHAFTS_.gain);
      uTime.value = t;
      if (day) {
        // THE DAY'S DOLPHINS: along their tracks in the set's frame, turned with the debris field as the set is
        const turn = inputs ? DEBRIS_SPIN * (inputs.drive(t).driftTime - restDrift) : 0;
        const yaw0 = restYaw + turn;
        const [c, sn] = [Math.cos(turn), Math.sin(turn)];
        const fx = restEye.x * c + restEye.z * sn;
        const fz = -restEye.x * sn + restEye.z * c;
        // (the set's frame: right (cos, −sin), ahead (−sin, −cos) of its yaw)
        const toWorld = (p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 =>
          out.set(fx + p.x * Math.cos(yaw0) - p.z * Math.sin(yaw0), p.y, fz - p.x * Math.sin(yaw0) - p.z * Math.cos(yaw0));
        const headingAt = (tr: Track, x: number): { h: number; v: THREE.Vector3 } => {
          const a1 = toWorld(trackAt(tr, x - 0.05, dA), new THREE.Vector3());
          const b1 = toWorld(trackAt(tr, x + 0.05, dB), new THREE.Vector3());
          const v = b1.sub(a1).divideScalar(0.1);
          return { h: Math.atan2(-v.x, -v.z), v };
        };
        for (const tr of tracks) {
          const on = trackOn(tr, t);
          tr.d.group.visible = on;
          if (!on) continue;
          const p = toWorld(trackAt(tr, t, dC), new THREE.Vector3());
          const { h, v } = headingAt(tr, t);
          const speed = v.length();
          const pitch = Math.asin(Math.max(-1, Math.min(1, v.y / Math.max(speed, 1e-3))));
          // ITS TURN AND ITS BANK (the 2026-11-02 brief: "banking turns with roll"; "a small body undulation as it changes
          // depth"): the heading's rate, the lean into it that a turn at this speed needs (tan = v·ω/g), the body's
          // sideways curve into the turn and its arch with the pitch's rate
          const h0 = headingAt(tr, t - 0.2).h;
          const h1 = headingAt(tr, t + 0.2).h;
          const w = Math.atan2(Math.sin(h1 - h0), Math.cos(h1 - h0)) / 0.4;
          const p0 = Math.asin(Math.max(-1, Math.min(1, headingAt(tr, t - 0.2).v.y / Math.max(speed, 1e-3))));
          const p1 = Math.asin(Math.max(-1, Math.min(1, headingAt(tr, t + 0.2).v.y / Math.max(speed, 1e-3))));
          const bank = Math.max(-0.7, Math.min(0.7, Math.atan((speed * -w) / 9.81) * 1.3));
          const ease = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
          const roll = tr.roll[1] > tr.roll[0] ? 2 * Math.PI * ease((t - tr.roll[0]) / (tr.roll[1] - tr.roll[0])) : 0;
          // nose first (its body along −z): yaw turns its −z onto the way it swims, pitch lifts it, the bank and the
          // roll turn it about its own length
          tr.d.group.position.copy(p);
          tr.d.group.rotation.set(pitch, h, bank + roll, 'YXZ');
          // (a pure function of t: the beat's phase from t itself; bursts and glides; harder when it is fast; under the
          // water only)
          const wet = p.y < (water ? water(p.x, p.z, t) : 0) ? 1 : 0;
          const beat = 0.16 * wet * swimEnvelope(t, tr.seed) * (0.7 + 0.3 * Math.min(1, speed / 4));
          const bend = Math.max(-0.4, Math.min(0.4, -(p1 - p0) / (0.4 * Math.max(speed, 1))));
          const turnBend = Math.max(-0.4, Math.min(0.4, w / Math.max(speed, 1)));
          tr.d.set({ x: 0, y: 0, z: 0, heading: 0, pitch: 0, bend, turn: turnBend, bank: 0, beat, phase: 2 * Math.PI * tr.hz * t, speed, dry: wet ? 0 : 0.3 });
          // the water's light at its depth (the same model as the deep's: the sky's and the Sun's light on the level,
          // down through its depth), its belly's from the deep below a few percent of it
          const dd = Math.max(0, -p.y);
          const lit = (k2: number): number => ((skyE[k2] + [sunE.r, sunE.g, sunE.b][k2] * Math.max(0, sunDir.y)) * Math.exp(-[K.x, K.y, K.z][k2] * dd)) / Math.PI;
          tr.down.value.set(lit(0), lit(1), lit(2));
          tr.up.value.copy(tr.down.value).multiplyScalar(0.05);
        }
      }
      if (day) {
        // THE WINDOW'S BRIGHTNESS FOLLOWS THE EYE'S ADAPTATION (WINDOW_SKY_DAY: the window at the sky's own brightness
        // on the dome): held at the adapted eye's trim, the window was half the sky's brightness through the eye's
        // re-adaptation before the surfacing — and the sky came back at twice the window's the moment the eye broke
        // through, over the window's whole disc
        oceanSurfaceParams.underWindowBrightness = WINDOW_SKY_DAY / (Math.max(1, exposure) * N_WATER * N_WATER);
        // THE FOAM'S AND THE LENS'S LIGHT: a lit white foam in the air (the sky's and the Sun's light on it, over π, at foam's ~0.7
        // albedo), the water's milky in-scatter under it (a third of that: the light down there, the aerated water
        // whiter than the deep) — blended through the waterline, so the veil does not jump as the eye goes through
        const airFoam = [0, 1, 2].map((k) => ((skyE[k] + [sunE.r, sunE.g, sunE.b][k] * el) * 0.7) / Math.PI);
        // (the first round's: a third of the foam's light under, tinted barely blue — a grey smoke over the dome. The
        // aerated water is the water's own cyan, at ~0.55 of the foam's light, the air's foam a sunlit white)
        // (round 3's tint of the warm foam light still read grey-green under the water: the aerated water is the
        // water's cyan at the foam's brightness, AQUA, not the Sun's colour dimmed)
        const kWet = Math.min(1, Math.max(0, (depth + 0.3) / 0.6));
        const wet = kWet * kWet * (3 - 2 * kWet);
        const lum = 0.2126 * airFoam[0] + 0.7152 * airFoam[1] + 0.0722 * airFoam[2];
        const AQUA = [0.36, 0.66, 0.84];
        veilLight.set(...([0, 1, 2].map((k) => airFoam[k] * (1 - wet) + lum * AQUA[k] * wet) as [number, number, number]));
        waterLight.copy(uDeep.value);
        veil?.update(t, eye.position, v, veilLight, waterLight, under);
        // the raft's rig in the window (only while under: above, the same sky is the sea's reflection), and its weed
        if (inputs) {
          if (!raftGroup) {
            let best = Infinity;
            scene.traverse((x) => {
              if (x.name !== 'drift-raft') return;
              const d = Math.hypot(x.position.x - raftAt.x, x.position.z - raftAt.z);
              if (d < best) {
                best = d;
                raftGroup = x;
              }
            });
          }
          sunEv.set(sunE.r, sunE.g, sunE.b);
          skyEv.set(skyE[0], skyE[1], skyE[2]);
          inputs.window?.update(raftGroup, under, sunDir, sunEv, skyEv);
          const rg = raftGroup as THREE.Object3D | null;
          if (weed && rg && weed.mesh.parent !== rg) rg.add(weed.mesh);
          if (weed) {
            weed.mesh.visible = under;
            weed.update(t);
          }
        }
      }
    },
  };
}
