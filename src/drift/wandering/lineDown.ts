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
 */
import * as THREE from 'three/webgpu';
import { Fn, If, Loop, abs, cameraPosition, exp, float, fract, fwidth, max, min, mix, mx_noise_float, output, positionLocal, positionWorld, pow, sin, smoothstep, uniform, uv, vec2, vec3, vec4 } from 'three/tsl';
import { causticsParams } from '../../params/caustics';
import { oceanSurfaceParams } from '../../params/oceanSurface';
import { EARTH_R } from '../getTheDrift/atmosphere';
import { createDolphin } from './dolphin';
import { createHardCase } from './hardCase';
import { skyIrradiance } from './seaSky';
import type { BeatName } from './beats';

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
  /** under from here … (beat, s into it: before c2, so within c1) */
  from: ['c2', -36] as [BeatName, number],
  /** … to here: the follow's start, where the descent comes to rest beside the raft */
  to: ['c2', -20] as [BeatName, number],
  /** m under the mean sea at the moment's start and its end: rising in under the raft (the window's radius on the
   * surface, depth·tan 48.6°: 7.9 m → 5.1 m) */
  depth: [7, 4.5] as [number, number],
  /** m from the raft's centre (right, ahead) at the start and the end: gliding in from 28 m behind it (~1.5 m/s, eased) */
  offset: [[-3, -28], [-3, -5]] as [[number, number], [number, number]],
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
 * only what floats.
 *   pieces  a plank, a door, a chair, a barrel, a tyre afloat over the window, drifting (the Act 2 debris galaxy's
 *           rhyme): m right, m ahead, its rest depth (m), its slow turn (rad/s)
 *   net     a ghost net hanging from a line of floats, NET.drop m deep, billowing; the case snagged in it at NET.snag
 *   dolphin crossing the window from the left, 2.5 m under, at DOLPHIN.pass
 */
const PIECES: Array<{ kind: 'plank' | 'door' | 'chair' | 'barrel' | 'tyre'; at: [number, number]; y: number; spin: number }> = [
  { kind: 'plank', at: [-2.5, 2], y: -0.06, spin: 0.03 },
  { kind: 'door', at: [3.2, -1.5], y: -0.05, spin: -0.02 },
  { kind: 'chair', at: [-1, -5.5], y: -0.15, spin: 0.05 },
  { kind: 'barrel', at: [-5.5, -2.5], y: -0.25, spin: 0.04 },
  { kind: 'tyre', at: [1.5, 6.5], y: -0.12, spin: -0.03 },
];
/** the net: its float line from `a` to `b` (m right, m ahead), hanging `drop` m, its mesh (m), the case snagged at
 * (share along, m down) */
const NET = { a: [-7, -0.5] as [number, number], b: [-2.5, 5.5] as [number, number], drop: 3.2, cell: 0.14, snag: [0.55, 1.7] as [number, number] };
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
}

/**
 * The look-dev for `scene` (the sea's), its moments at beat starts `starts` (sea s). Sets the scene's fog node (the
 * water) and the underside's trim; builds the set.
 */
export function createLineDown(_renderer: THREE.WebGPURenderer, scene: THREE.Scene, starts: Record<BeatName, number>, light: LineDownLight = LINE_DOWN_LIGHT): LineDown {
  const at = ([b, s]: [BeatName, number]): number => starts[b] + s;
  const day = light === 'day';
  const WATER_ = day ? WATER_DAY : WATER;
  const SHAFTS_ = day ? SHAFTS_DAY : SHAFTS;
  const from = at(day ? LINE_DOWN_DAY.from : LINE_DOWN.from);
  const to = at(day ? LINE_DOWN_DAY.to : LINE_DOWN.to);
  const pass = at(DOLPHIN.pass);
  /** the moment's share 0..1 at t, eased (the day's glide in under the raft; the sunset's eye holds still) */
  const glide = (t: number): number => {
    const k = Math.min(1, Math.max(0, (t - from) / (to - from)));
    return k * k * (3 - 2 * k);
  };
  /** m under the mean sea, and m from the raft's centre (right, ahead), at t */
  const depthAt = (t: number): number => (day ? THREE.MathUtils.lerp(LINE_DOWN_DAY.depth[0], LINE_DOWN_DAY.depth[1], glide(t)) : LINE_DOWN.depth);
  const offsetAt = (t: number, end = false): [number, number] => {
    if (!day) return LINE_DOWN.offset;
    const [a, b] = LINE_DOWN_DAY.offset;
    const k = end ? 1 : glide(t);
    return [THREE.MathUtils.lerp(a[0], b[0], k), THREE.MathUtils.lerp(a[1], b[1], k)];
  };

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

  // the pieces afloat over the window (wet wood, paint, rubber: dark from below)
  const wood = new THREE.MeshStandardNodeMaterial({ color: 0x4a3a2a, roughness: 0.8 });
  const painted = new THREE.MeshStandardNodeMaterial({ color: 0x6f7a74, roughness: 0.7 });
  const rubber = new THREE.MeshStandardNodeMaterial({ color: 0x1b1b1b, roughness: 0.9 });
  const drum = new THREE.MeshStandardNodeMaterial({ color: 0x5a2a1e, roughness: 0.6, metalness: 0.3 });
  const pieces = PIECES.map((q) => {
    let mesh: THREE.Object3D;
    if (q.kind === 'plank') mesh = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.05, 0.24), wood);
    else if (q.kind === 'door') mesh = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.045, 2.0), painted);
    else if (q.kind === 'barrel') {
      // (a drum afloat on its side)
      mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.29, 0.29, 0.88, 20), drum);
      mesh.rotation.z = Math.PI / 2;
    } else if (q.kind === 'tyre') mesh = new THREE.Mesh(new THREE.TorusGeometry(0.33, 0.11, 10, 24).rotateX(Math.PI / 2), rubber);
    else {
      const chair = new THREE.Group();
      const part = (w: number, h: number, d: number, x: number, y: number, z: number): void => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wood);
        m.position.set(x, y, z);
        chair.add(m);
      };
      part(0.45, 0.04, 0.45, 0, 0, 0);
      part(0.45, 0.5, 0.04, 0, 0.25, -0.21);
      for (const [x, z] of [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]]) part(0.035, 0.45, 0.035, x, -0.22, z);
      // (afloat on its side, its legs out)
      chair.rotation.set(1.3, 0, 0.2);
      mesh = new THREE.Group().add(chair);
    }
    const holder = new THREE.Group().add(mesh);
    group.add(holder);
    return { ...q, mesh: holder };
  });

  // THE GHOST NET: a curtain hanging from its floats, a mesh of twine cut out of a sheet (a grid by its uv,
  // anti-aliased by the grid's own screen-space rate, so it greys out with distance instead of shimmering), billowing
  // in the slow swell — a pure function of t through `uNet`
  const [na, nb] = [local(...NET.a), local(...NET.b)];
  const span = Math.hypot(nb[0] - na[0], nb[1] - na[1]);
  const netGeo = new THREE.PlaneGeometry(span, NET.drop, 40, 16).translate(span / 2, -NET.drop / 2, 0);
  const uNet = uniform(0);
  const netMat = new THREE.MeshStandardNodeMaterial({ color: 0x2c3a33, roughness: 0.9, side: THREE.DoubleSide, transparent: true, depthWrite: false });
  {
    const u = uv();
    const g = vec2(u.x.mul(span / NET.cell), u.y.mul(NET.drop / NET.cell));
    const w = fwidth(g).max(1e-4);
    // (twine 1.2 cm on a 14 cm cell: a half-width of 0.043 of a cell. Sharp while a cell spans pixels; once a cell
    // nears a pixel, its mean — 0.086 a direction, 0.165 both — so a far net is a faint grey veil, not moiré)
    const dist = float(0.5).sub(abs(fract(g).sub(0.5)));
    const sharp = dist.negate().add(0.043).div(w).add(0.5).clamp(0, 1);
    const far = smoothstep(0.3, 1.0, max(w.x, w.y));
    const cover = mix(max(sharp.x, sharp.y), float(0.165), far);
    netMat.opacityNode = cover.mul(0.85);
    // the curtain: hung from the floats (y 0 at the top edge), bellied out with depth, swaying
    const depthShare = positionLocal.y.negate().div(NET.drop);
    const sway = sin(positionLocal.x.mul(0.9).add(uNet.mul(0.5))).mul(0.35).add(sin(positionLocal.x.mul(2.3).sub(uNet.mul(0.8))).mul(0.12));
    netMat.positionNode = positionLocal.add(vec3(0, positionLocal.y.mul(0.15).mul(depthShare), sway.mul(depthShare).add(depthShare.mul(depthShare).mul(0.8))));
  }
  const net = new THREE.Mesh(netGeo, netMat);
  net.frustumCulled = false;
  net.position.set(na[0], -0.05, na[1]);
  net.rotation.y = -Math.atan2(nb[1] - na[1], nb[0] - na[0]);
  group.add(net);
  // its floats: cork-orange balls along the top
  const floatMat = new THREE.MeshStandardNodeMaterial({ color: 0xa8582a, roughness: 0.7 });
  const floats = new THREE.InstancedMesh(new THREE.SphereGeometry(0.11, 12, 8), floatMat, 9);
  for (let i = 0; i < 9; i++) floats.setMatrixAt(i, new THREE.Matrix4().makeTranslation(na[0] + ((nb[0] - na[0]) * i) / 8, -0.02, na[1] + ((nb[1] - na[1]) * i) / 8));
  group.add(floats);
  // the case, snagged in it, tilted
  const theCase = createHardCase();
  theCase.position.set(na[0] + (nb[0] - na[0]) * NET.snag[0], -NET.snag[1], na[1] + (nb[1] - na[1]) * NET.snag[0]);
  theCase.rotation.set(0.6, 0.9, -0.4);
  group.add(theCase);
  // (the day's slot is the landing, before the case and the dolphin are in the story — c3's: the drowned world's
  // flotsam and the net only)
  theCase.visible = !day;

  const dolphin = createDolphin();
  group.add(dolphin.group);

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
  /** where the set is laid (x, z m; yaw rad): the eye's place at the moment's END, so the day's glide moves the eye
   * through the set (for the sunset's still eye, where the eye is) */
  const anchor = { x: 0, z: 0, yaw: 0 };
  return {
    group,
    ready: Promise.resolve(),
    get exposure() {
      return exposure;
    },
    place(t, eye, raft) {
      if (!inMoment(t)) return false;
      // (the eye's level frame: its yaw, as sea.ts set it; heading 0 looks toward −z. Taken from its front, not
      // rotation.y: in c1 before the follow the eye is the landing's turn (sea.ts: eye.quaternion = the drive's), which
      // still holds the descent's pitch — its Euler y is not its heading then)
      fwd.set(0, 0, -1).applyQuaternion(eye.quaternion);
      const yaw = Math.atan2(-fwd.x, -fwd.z);
      const f = [-Math.sin(yaw), -Math.cos(yaw)];
      const r = [Math.cos(yaw), -Math.sin(yaw)];
      const [ox, oz] = offsetAt(t);
      eye.position.set(raft.x + r[0] * ox + f[0] * oz, -depthAt(t), raft.z + r[1] * ox + f[1] * oz);
      eye.rotation.set(0, yaw, 0, 'YXZ');
      const [ex, ez] = offsetAt(t, true);
      anchor.x = raft.x + r[0] * ex + f[0] * ez;
      anchor.z = raft.z + r[1] * ex + f[1] * ez;
      anchor.yaw = yaw;
      // (heading 0 looks toward −z, as the eye's: the raft's logs lie along its heading)
      uRaft.value.set(raft.x, raft.z, Math.sin(raft.heading), Math.cos(raft.heading));
      return true;
    },
    update(t, eye) {
      const under = inMoment(t) && eye.position.y < -0.5;
      uUnder.value = under ? 1 : 0;
      group.visible = under;
      exposure = under ? (day ? dayAdapt : LINE_DOWN.adapt) : 1;
      if (!under) return;
      // every material in the water takes the water (the sky's and the sea's had `fog: false`: from above, they do
      // their own haze — from below, the sky past the window's edge and below the horizontal IS the deep)
      scene.traverse((x) => {
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
          // A CUSTOM OUTPUT REPLACES THE FOG (three's NodeMaterial: the outputNode is taken after setupOutput, which is
          // where the fog goes): the masts' and the stations' air (radioTower.ts expAir) mixes its haze over the fogged
          // colour, and the ring's stations on the horizon came through the deep as three bright unfogged streaks in
          // the gate-2 dome frame. Their output takes the water as well (the object's own colour twice: it is in the
          // deep at that range either way).
          if (nm.outputNode) {
            nm.outputNode = waterOf(nm.outputNode);
            mat.needsUpdate = true;
          }
        }
      });
      // the set, laid about the eye in its level frame
      group.position.set(anchor.x, 0, anchor.z);
      group.rotation.set(0, anchor.yaw, 0);
      for (const p of pieces) {
        const [x, z] = local(p.at[0] + 0.12 * Math.sin(t * 0.21 + p.at[1]), p.at[1] + 0.1 * Math.cos(t * 0.17 + p.at[0]));
        p.mesh.position.set(x, p.y + 0.04 * Math.sin(t * 0.9 + p.at[0]), z);
        p.mesh.rotation.y = p.spin * t;
      }
      uNet.value = t;
      theCase.position.y = -NET.snag[1] + 0.06 * Math.sin(t * 0.5);
      // the dolphin across the window, nose first (its body along −z), its tail beating
      const s = t - pass;
      const [dx, dz] = local(DOLPHIN.speed * s, DOLPHIN.ahead + 0.15 * s);
      dolphin.group.position.set(dx, -DOLPHIN.depth + 0.25 * Math.sin(s * 0.8), dz);
      // heading: toward +x (its right) in the eye's frame, a little ahead: −90° about y turns its −z nose to +x
      dolphin.group.rotation.set(0.04 * Math.cos(s * 0.8), -Math.PI / 2 + 0.035, 0, 'YXZ');
      dolphin.set({ x: 0, y: 0, z: 0, heading: 0, pitch: 0, bend: 0.02, turn: 0, bank: 0, beat: 0.12, phase: s * 2.2 * Math.PI * 2, speed: DOLPHIN.speed, dry: 100 });
      dolphin.group.visible = !day && Math.abs(DOLPHIN.speed * s) < DOLPHIN.reach;

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
      const down = (k: number): number => Math.exp(-[K.x, K.y, K.z][k] * depthAt(t));
      const E = [0, 1, 2].map((k) => (skyE[k] + [sunE.r, sunE.g, sunE.b][k] * el) * down(k));
      uDeep.value.set((E[0] * WATER_.scatter[0]) / Math.PI, (E[1] * WATER_.scatter[1]) / Math.PI, (E[2] * WATER_.scatter[2]) / Math.PI);
      // the Sun refracted into the water: its horizontal run kept, sin θw = cos(el)/n
      const h = Math.hypot(sunDir.x, sunDir.z);
      const sinW = Math.min(1, h / N_WATER);
      const cosW = Math.sqrt(1 - sinW * sinW);
      uSunW.value.set((sunDir.x / Math.max(h, 1e-6)) * sinW, cosW, (sunDir.z / Math.max(h, 1e-6)) * sinW);
      uShaft.value.set(sunE.r, sunE.g, sunE.b).multiplyScalar(SHAFTS_.gain);
      uTime.value = t;
    },
  };
}
