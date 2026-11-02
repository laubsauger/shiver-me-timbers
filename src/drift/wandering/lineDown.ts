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
import { Fn, If, Loop, abs, cameraPosition, exp, float, min, mix, mx_noise_float, output, positionWorld, pow, smoothstep, uniform, vec3, vec4 } from 'three/tsl';
import { causticsParams } from '../../params/caustics';
import { oceanSurfaceParams } from '../../params/oceanSurface';
import { EARTH_R } from '../getTheDrift/atmosphere';
import { DEBRIS_SPIN } from '../getTheDrift/timeline';
import { createDolphin } from './dolphin';
import { createHardCase } from './hardCase';
import { skyIrradiance } from './seaSky';
import type { BeatName } from './beats';
import { DIVE, adaptAt, planDive, veilAt, type DivePlan } from './lineDownDive';
import { createFlotsam, createRaftWeed, type FlotsamPiece, type LeafSpec, type NetSpec } from './lineDownSet';
import { raftLogsInPlan } from './raft';
import { createLineDownVeil, type LineDownVeil } from './lineDownVeil';
import type { WindowRaft } from './lineDownWindow';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node unions
type Node = any;

const QUERY = typeof location !== 'undefined' ? new URLSearchParams(location.search) : undefined;
/** `drift.html?linedown`: the look-dev on (the review scripts' `--query linedown`); off, nothing here is built */
export const LINE_DOWN_ON = QUERY?.has('linedown') ?? false;
/**
 * WHICH LIGHT: `?linedown` (or `?linedown=sunset`) the synthesis's c2–c3 moment at sunset; `?linedown=day` the
 * brighter-water fallback in the morning landing (LINE_DOWN_DAY). Both stay: the sunset one is the gate-2 finding the
 * day one is measured against.
 */
export type LineDownLight = 'sunset' | 'day';
export const lineDownLight = (q: string | null | undefined): LineDownLight => (q === 'day' ? 'day' : 'sunset');
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
const SHAFTS = { reach: 60, gain: 0.05, scale: 0.32, drift: 0.35, g: 0.72, iso: 0.25, steps: 10, ridge: 0, tint: [1, 1, 1] as [number, number, number], far: false, raftShade: false };
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
 */
const SHAFTS_DAY = { ...SHAFTS, reach: 160, gain: 0.08, scale: 0.55, steps: 64, ridge: 6, tint: [0.42, 0.62, 1] as [number, number, number], far: true, raftShade: true };
/**
 * `far`: the steps laid QUADRATICALLY along the ray at fixed places (s = reach·u²), fine near the eye where a sheet is
 * wide on the screen, coarse far off where it is a hair and the water has dimmed it, so the march reaches 160 m, where
 * the blue light is down to 4% (e^−0.02·160) — the sunset's even 60 m stopped it at 30%. And it ends where the ray
 * leaves the water.
 * `raftShade`: the raft's shadow in the shafts — a beam that entered the water under the logs carries no light (the r2
 * stills: the glow round the Sun went on straight through the raft, a bright arch over its logs from below).
 */
const RAFT_SHADE = { halfWidth: 2.7, halfLength: 6.3, soft: 0.6 };
/** the day's window, as a share of the sky the audience saw above it, on the dome (after the eye's adaptation and n²:
 * trim = WINDOW_SKY_DAY / (adapt · n²); the review's "the window's brightness stays below the sky's" — at 1 it
 * meets it, before the few metres of water take their share). The r1 day stills' fixed 0.7 put the window at 1.6×
 * the sky at 1.25 adapt, and the adapt the 11° Sun needs (2.1) would have made that 2.6× */
const WINDOW_SKY_DAY = 1.0;
const CEILING_DAY = '#06243a';

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
const DAY_NET: NetSpec = { a: [-8.5, 4.5], b: [-5, 11.5], drop: 3.4 };
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
}

/**
 * The look-dev for `scene` (the sea's), its moments at beat starts `starts` (sea s). Sets the scene's fog node (the
 * water) and the underside's trim; builds the set. The day's dive needs `inputs` (without them — the tests — it is
 * not planned and the eye is never moved).
 */
export function createLineDown(_renderer: THREE.WebGPURenderer, scene: THREE.Scene, starts: Record<BeatName, number>, light: LineDownLight = LINE_DOWN_LIGHT, inputs?: LineDownDayInputs): LineDown {
  const at = ([b, s]: [BeatName, number]): number => starts[b] + s;
  const day = light === 'day';
  const WATER_ = day ? WATER_DAY : WATER;
  const SHAFTS_ = day ? SHAFTS_DAY : SHAFTS;
  const from = at(day ? LINE_DOWN_DAY.from : LINE_DOWN.from);
  const to = at(day ? LINE_DOWN_DAY.to : LINE_DOWN.to);
  const pass = at(DOLPHIN.pass);
  // THE DIVE (lineDownDive.ts): the eye's place from `from` to `to`, through the surface at two troughs
  const water = inputs?.water;
  const plan = day && inputs ? planDive(starts.c2, (t) => inputs.drive(t).eye.toArray() as [number, number, number], inputs.water, inputs.drive(to).yaw) : null;
  if (plan && !(plan.check.down && plan.check.up))
    // FAIL LOUD: a crossing that is not single, or slow through the waterline band, is a strobe on the dome
    console.error(`lineDown: the dive's crossings are not clean (down ${plan.check.down}, up ${plan.check.up}) — check the sea at ${plan.down.toFixed(2)} / ${plan.up.toFixed(2)} s`);
  if (plan) console.info(`lineDown: the dive goes in at sea ${plan.down.toFixed(2)} s, comes up at ${plan.up.toFixed(2)} s; clearance ${plan.check.clearance.toFixed(2)} m`);
  /** m under the mean sea at t (the sunset's eye holds its depth; the day's is the dive's) */
  const depthAt = (t: number): number => (plan ? -plan.y(t) : LINE_DOWN.depth);
  const offsetAt = (): [number, number] => LINE_DOWN.offset;
  // the day's set rides the debris field's turn from where it lies when the eye comes to rest (`to`): the raft does,
  // and the eye with the descent's drift, so the set keeps its place against both
  const rest = day && inputs ? inputs.drive(to) : null;
  const restEye = rest ? rest.eye.clone() : new THREE.Vector3();
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
        const depth = p.y.negate().max(0);
        const run = depth.div(uSunW.y.max(0.2));
        const entry = p.xz.add(uSunW.xz.mul(run));
        const n = mx_noise_float(vec3(entry.x.mul(SHAFTS_.scale), entry.y.mul(SHAFTS_.scale), uTime.mul(SHAFTS_.drift * SHAFTS_.scale)));
        const beam0 = SHAFTS_.ridge > 0 ? pow(float(1).sub(abs(n)).clamp(0, 1), SHAFTS_.ridge).mul(2.0) : pow(n.mul(0.5).add(0.5).clamp(0, 1), 3).mul(2.4);
        // (the raft's shadow: the entry point in the raft's frame, against its logs' footprint, soft-edged)
        let beam = beam0;
        if (SHAFTS_.raftShade) {
          const q = entry.sub(uRaft.xy);
          const along = abs(q.x.mul(uRaft.z.negate()).add(q.y.mul(uRaft.w.negate())));
          const across = abs(q.x.mul(uRaft.w).add(q.y.mul(uRaft.z.negate())));
          const { halfWidth: hw, halfLength: hl, soft } = RAFT_SHADE;
          const inside = float(1).sub(smoothstep(hw - soft, hw + soft, across)).mul(float(1).sub(smoothstep(hl - soft, hl + soft, along)));
          beam = beam0.mul(float(1).sub(inside));
        }
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
  const leaves: LeafSpec = { ...DAY_LEAVES, clear: plan ? [inRest(plan.xz(plan.down)), inRest(plan.xz(plan.up))] : [] };
  const flotsam = createFlotsam(day ? DAY_SET : PIECES, day ? DAY_NET : NET, day ? leaves : undefined);
  // (the sunset's set is laid in `group`, moved to the eye's place each frame; the day's group stays at the world's
  // origin and the flotsam is laid in the world, on the debris field's turn)
  group.add(flotsam.group);
  const [na, nb] = [local(...NET.a), local(...NET.b)];
  // THE VEIL, THE BUBBLES, THE SNOW (lineDownVeil.ts): the day's dive only, its bursts where the eye goes in and comes up
  let veil: LineDownVeil | null = null;
  if (plan) {
    const eIn = plan.xz(plan.down);
    const [a, b] = [plan.xz(plan.down - 0.5), plan.xz(plan.down + 0.5)];
    const eUp = plan.xz(plan.up);
    veil = createLineDownVeil({
      down: { t: plan.down, x: eIn[0], z: eIn[1], v: DIVE.vDown, vx: b[0] - a[0], vz: b[1] - a[1] },
      up: { t: plan.up, x: eUp[0], z: eUp[1] },
    });
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
  group.add(dolphin.group);
  const dayDolphin = new THREE.CatmullRomCurve3(DAY_DOLPHIN.map(([, x, z, y]) => new THREE.Vector3(x, y, z)));
  /** the day's dolphin in the rest's frame at sea s t: its place (x right, y up, z ahead) */
  const dayDolphinAt = (t: number, out: THREE.Vector3): THREE.Vector3 => {
    const k = t - starts.c2;
    const n = DAY_DOLPHIN.length;
    let i = 0;
    while (i < n - 2 && k > DAY_DOLPHIN[i + 1][0]) i++;
    const u = (k - DAY_DOLPHIN[i][0]) / (DAY_DOLPHIN[i + 1][0] - DAY_DOLPHIN[i][0]);
    return dayDolphin.getPoint(Math.min(1, Math.max(0, (i + u) / (n - 1))), out);
  };
  const dA = new THREE.Vector3();
  const dB = new THREE.Vector3();

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
          eye.position.set(x, plan.y(t), z);
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
      group.visible = day ? plan !== null && t >= from && t < plan.up + 0.1 : under;
      const v = plan && inMoment(t) ? veilAt(t, plan.down, plan.up) : 0;
      exposure = !inMoment(t) ? 1 : day ? (plan ? dayAdaptNow(t) : under ? dayAdapt : 1) : under ? LINE_DOWN.adapt : 1;
      if (!under && v <= 0 && !group.visible) {
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
        // THE DAY'S DOLPHIN (DAY_DOLPHIN): along its path in the rest's frame, turned with the debris field as the set is
        const k = t - starts.c2;
        const on = k >= DAY_DOLPHIN[0][0] && k < DAY_DOLPHIN_GONE;
        dolphin.group.visible = on;
        if (on) {
          const turn = inputs ? DEBRIS_SPIN * (inputs.drive(t).driftTime - restDrift) : 0;
          const yaw0 = restYaw + turn;
          const [c, sn] = [Math.cos(turn), Math.sin(turn)];
          const fx = restEye.x * c + restEye.z * sn;
          const fz = -restEye.x * sn + restEye.z * c;
          // (the rest's frame: right (cos, −sin), ahead (−sin, −cos) of its yaw)
          const toWorld = (p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 =>
            out.set(fx + p.x * Math.cos(yaw0) - p.z * Math.sin(yaw0), p.y, fz - p.x * Math.sin(yaw0) - p.z * Math.cos(yaw0));
          const p = toWorld(dayDolphinAt(t, dA), new THREE.Vector3());
          const q = toWorld(dayDolphinAt(t + 0.05, dB), new THREE.Vector3());
          const v = q.sub(p).divideScalar(0.05);
          const speed = v.length();
          // nose first (its body along −z): yaw turns its −z onto the way it swims, pitch lifts it
          dolphin.group.position.copy(p);
          dolphin.group.rotation.set(Math.asin(Math.max(-1, Math.min(1, v.y / Math.max(speed, 1e-3)))), Math.atan2(-v.x, -v.z), 0, 'YXZ');
          // (a pure function of t: the beat's phase from t itself, as dolphin.ts dolphinPose's; under the water only)
          const wet = p.y < (water ? water(p.x, p.z, t) : 0) ? 1 : 0;
          dolphin.set({ x: 0, y: 0, z: 0, heading: 0, pitch: 0, bend: 0, turn: 0, bank: 0, beat: 0.12 * wet, phase: 2 * Math.PI * 2.2 * t, speed, dry: wet ? 0 : 0.3 });
          // the water's light at its depth (the same model as the deep's: the sky's and the Sun's light on the level,
          // down through its depth), its belly's from the deep below a few percent of it
          const dd = Math.max(0, -p.y);
          const lit = (k2: number): number => ((skyE[k2] + [sunE.r, sunE.g, sunE.b][k2] * Math.max(0, sunDir.y)) * Math.exp(-[K.x, K.y, K.z][k2] * dd)) / Math.PI;
          uDolphinDown.value.set(lit(0), lit(1), lit(2));
          uDolphinUp.value.copy(uDolphinDown.value).multiplyScalar(0.05);
        }
      }
      if (day) {
        // THE WINDOW'S BRIGHTNESS FOLLOWS THE EYE'S ADAPTATION (WINDOW_SKY_DAY: the window at the sky's own brightness
        // on the dome): held at the adapted eye's trim, the window was half the sky's brightness through the eye's
        // re-adaptation before the surfacing — and the sky came back at twice the window's the moment the eye broke
        // through, over the window's whole disc
        oceanSurfaceParams.underWindowBrightness = WINDOW_SKY_DAY / (Math.max(1, exposure) * N_WATER * N_WATER);
        // THE VEIL'S LIGHT: a lit white foam in the air (the sky's and the Sun's light on it, over π, at foam's ~0.7
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
        veil?.update(t, eye.position, v, veilLight, waterLight, under, wet);
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
