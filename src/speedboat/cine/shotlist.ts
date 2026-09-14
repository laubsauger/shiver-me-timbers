/**
 * "sb-trailer-v1" — the 60 s speedboat trailer script (docs/cine/speedboat-trailer-v1.md) as data.
 *
 * Seventeen script BEATS on a 60 s timeline. Sixteen are rendered; beat 14 ("three quick cuts") is three shots
 * (14a/14b/14c) because a cut is a new camera, and beat 17 (title on black) is not rendered at all — it is a `title`
 * slot in the edit plan, built in Resolve. Every rendered shot is a separate clip with `HANDLE` seconds of footage on
 * each side (the durations are targets; the edit is cut to music).
 *
 * THE HULL, MEASURED (deepV12.hull.json; body frame = CG origin, +Z bow, +Y up, +X to one side — the director's `hull`
 * and `ship` frames resolve keys in it):
 *
 *   length 12 m: transom z −3.6 .. stem z +8.4     beam 2.47 m: x ±1.23     deck y +0.54, keel y −0.76
 *   still waterline y ≈ −0.24 at rest (SPAWN_CG_Y)  three outboards at x −0.66 / 0 / +0.66, z ≈ −4.4
 *   pilot eye (0, 1.17, 0.52) (camera/raceCamEye.ts)  cockpit z −1.2 .. +1.8 (renderOnly.cockpit)
 *
 * Camera primitives (`primitive`) are named uses of the director's existing machinery (src/cine/director.ts):
 *   dolly / slide     `ship` frame, two keys, `rideSwell` — the lens rides the water beside her
 *   mount / insert    `hull` frame — bolted to her, inherits every pitch and slam (`wobble` adds engine buzz)
 *   reveal            `locked` frame — her pose captured at the first frame, then held, so she drifts in it
 *   chase / follow    `ship` frame + `follow` damper
 *   rising            `ship` + `follow`, keys climbing
 *   static-long       `world` frame + `aimShip` (pans with her) + `focusShip`, long lens
 *   overhead          `world` frame high over the location + `aimShip`
 *
 * Drives: every take re-places her (drive.ts `drivePose`) and runs its preroll through the same physics, so each
 * clip is repeatable on its own. `startS` values were solved headless (scratch drive sim, doc §Choreography) so she
 * is where the static lenses need her at the listed shot time.
 */
import type { Shot, WorldPatch } from '../../cine/types';
import type { RivalSpec } from './rivals';
import type { DriveSpec } from './drive';
import { LOCATIONS, type LocationId } from './locations';
import { TIME_LOOK, type TrailerTime } from './look';
import { liveryFor } from '../page/liveries';
import { SPEEDBOAT_SEAS } from '../../params/speedboatSea';

export type CameraPrimitive = 'dolly' | 'slide' | 'mount' | 'insert' | 'reveal' | 'chase' | 'follow' | 'rising' | 'static-long' | 'overhead';
export const CAMERA_PRIMITIVES: readonly CameraPrimitive[] = ['dolly', 'slide', 'mount', 'insert', 'reveal', 'chase', 'follow', 'rising', 'static-long', 'overhead'];

export interface TrailerShot extends Shot {
  /** the script beat it belongs to ('01'..'16'; 14a/b/c are beat '14') */
  beat: string;
  location: LocationId;
  primitive: CameraPrimitive;
  drive: DriveSpec;
  /** the script's sound column: it explains the cut rhythm and goes to the editor as the shot's notes */
  cue: string;
  /** sunset / dusk / night: the shot's sky, exposure and live grade come from look.ts `TIME_LOOK`, under its own world */
  timeOfDay: TrailerTime;
  /**
   * TIME-OF-DAY VARIANTS: the times this shot is ALSO rendered at, frame-identical but for the sky, sun, moon, grade and
   * LEDs, so the edit can strobe between them on a beat (doc §Variants). Includes `timeOfDay` (the primary, on V1).
   */
  variants?: readonly TrailerTime[];
  /** set on a take that is one of several times of day: it goes into the clip name (`…_10_bow-lookback_night_take01`) */
  variant?: TrailerTime;
  /** the pilot's right hand leaves the rim for the throttle lever, and the lever rides the scripted throttle (host.ts, pilotRig `cineThrottle`) */
  throttleHand?: boolean;
  /**
   * the other boats in the shot (rivals.ts): each on its own scripted drive, in the hero's physics, placed with her.
   * At most CINE_RIVAL_MAX; keep ≥ 1.5 beams (≈ 3.5 m) between hulls unless a contact is choreographed.
   */
  rivals?: readonly RivalSpec[];
  /**
   * COVERAGE: more lenses on the SAME run (cine/index.ts `cameras`) — every one renders the whole take (handles
   * included) from the same simulated instant, to its own clip (`…_08_side-tracking_cam-pov-forward_take01`), so each
   * is fully cuttable and they line up for multicam. The shot's own lens is camera 0 ("main"). doc §Coverage.
   */
  coverage?: readonly CoverageCamera[];
  /** a coverage-only SETUP (TRAILER_RUNS): rendered and binned, not on the default assembly timeline */
  run?: boolean;
  /** set on a coverage camera's take: its `cam` slug, in the clip name */
  camera?: string;
  /** the frame to cut a variant pair on, shot time (s): marked in the edit plan (`cutS`) */
  cutAtS?: number;
}

/** A: the assembly's own lenses, the rival masters, the hard mounts · B: more coverage · C: the insert library */
export type CoverageTier = 'A' | 'B' | 'C';
export const COVERAGE_TIERS: readonly CoverageTier[] = ['A', 'B', 'C'];
export type CoverageKind = 'wide' | 'chase' | 'front' | 'abeam' | 'mount' | 'tele' | 'insert';

/** one extra lens on a run: only camera fields — the run's drive, rivals, sea and time are the run's */
export interface CoverageCamera extends Pick<Shot, 'frame' | 'keys' | 'follow' | 'platform' | 'rideSwell' | 'waterClearance' | 'aimShip' | 'focusShip' | 'wobble' | 'mountIsolation'> {
  /** slug, unique within the run */
  cam: string;
  tier: CoverageTier;
  kind: CoverageKind;
  /** lens refinements over the run's look (DOF, an exposure for a shaded insert) */
  world?: Pick<WorldPatch, 'post' | 'sky'>;
  note: string;
}

export const TRAILER_NAME = 'sb-trailer-v2';
export const TRAILER_SECONDS = 60;
/** edit handle on each side of every clip, s */
export const HANDLE = 1;
/**
 * Delivery: one frame rate and one master size for every clip (doc §Delivery). USER: the first real record is 1920x1080
 * at 30 fps; the 4K60 master comes once the shots are final (`record({ res: '4k', fps: TRAILER_FPS_4K })`).
 */
export const TRAILER_FPS = 30;
export const TRAILER_MASTER: readonly [number, number] = [1920, 1080];
export const TRAILER_PROXY: readonly [number, number] = [960, 540];
export const TRAILER_FPS_4K = 60;
export const TRAILER_MASTER_4K: readonly [number, number] = [3840, 2160];
/** the record's anti-aliasing and motion blur (capture.ts / recorder.ts): 16 jittered subframes over a 180° shutter */
export const TRAILER_SAMPLES = 16;
export const TRAILER_SHUTTER_DEG = 180;

const PREROLL = 6;
/**
 * SEA SETTLE, seconds added in front of every preroll (host.ts places her only once they have run). A take's weather is
 * applied at its cue, but the sea does not arrive at a new state in one tick: 15 ran clean on its own and crashed at the
 * same spot every time it followed 14c (`swell` → `breeze`), and 14c crashed whenever it was the first take after the
 * page's own sea (browser, 640x360 takes 40–42). With the boat placed only after the sea has had these seconds, a take
 * no longer depends on what was shot before it. Placement time, and so every drive's timing, is unchanged.
 */
export const SEA_SETTLE = 4;
// The sea per shot. The time of day (sun, sky, exposure, grade) is NOT in these: it is the shot's `timeOfDay`, merged
// under its world at the bottom of this file (withLook).
/**
 * The bay's glass; only sunset shots use it, with the sun half a degree higher over the island. USER (look-pass
 * reviews): "the waterline at rest looks pasted on", then, on a moored hull bobbing in a 7 cm swell, "the boat just got
 * blobbed in" (04: circular rings radiating off a stationary hull) and "feels completely parked" (05). So she is no
 * longer moored (CRUISE below) and the sea is the sea agent's `calm` preset (docs/speedboat/sea-presets.md: a 12 s
 * swell, Hs ~0.23 m, Beaufort 2 — "bay glass with a breeze on it"), so the water reads as water and not as a mirror.
 */
/** the calm preset at the time's own sun (GLASS without the bay's 3.5° refinement) */
const GLASS_OPEN: WorldPatch = { weather: SPEEDBOAT_SEAS.calm.weather, ocean: { ...SPEEDBOAT_SEAS.calm.ocean } };
const GLASS: WorldPatch = { sunElevationDeg: 3.5, weather: SPEEDBOAT_SEAS.calm.weather, ocean: { ...SPEEDBOAT_SEAS.calm.ocean } };
// SPEED holds her on her feet out in the swell (headless crash machine, 14 ways a take on the old seas): at 32–33 m/s
// targets she made 25–27, flew 2–4 s a take and hooked a third of the runs; 24–28 m/s kept the landings under the
// knock-down heel. The at-speed runs below keep those speeds on the presets' gentler seas.
/**
 * THE CINE SEA for every at-speed run but the swell triple (08–13, 15, 16, R1–R4): the sea agent's `working` preset
 * (docs/speedboat/sea-presets.md, retuned: 10 s swell, Hs ~0.5 m, Beaufort 3, on the course's own swell bearing).
 * USER (review of 08–12): "waves still massive… smashing around, going underwater hard… flying a bunch of the time…
 * nothing you'd race a speedboat through" — wanted a long low swell of Hs ~0.3–0.6 m with a light wind texture; and the
 * night pack "more chill". Checked per take: airborne fraction and bow-under frames (host.ts `takeCheck`).
 */
const CINE_SEA: WorldPatch = { weather: SPEEDBOAT_SEAS.working.weather, ocean: { ...SPEEDBOAT_SEAS.working.ocean } };
/** 14a–c, the one place for deliberate air: the `open` preset (13 s swell, Hs ~1.15 m) — moderate hops, no stuffing */
const SWELL_TRIPLE: WorldPatch = { weather: SPEEDBOAT_SEAS.open.weather, ocean: { ...SPEEDBOAT_SEAS.open.ocean } };
const dof = (focus: number, range: number, bokeh = 3): WorldPatch['post'] => ({ dofFocus: focus, dofRange: range, dofBokeh: bokeh });

/**
 * IDLE CRUISE in the bay, pointing east: ~6 kn, placed already under way. USER: the detail shots must be "IN
 * MOTION (slow cruise, a little wake)" — a stationary hull on glass read as floating, parked, or blobbed in.
 */
const CRUISE_MPS = 3.5; // the 3 m/s target settled at 2.5 m/s (4.9 kn, take 06 trace); the brief is 5–8 kn
const REST: DriveSpec = { path: LOCATIONS.bay.path, startSpeed: CRUISE_MPS, speed: [{ t: -99, v: CRUISE_MPS }] };
/** the same idle cruise on the NNE line, so the sun rakes her starboard flank (locations.ts `bayDetail`) */
const REST_DETAIL: DriveSpec = { path: LOCATIONS.bayDetail.path, startSpeed: CRUISE_MPS, speed: [{ t: -99, v: CRUISE_MPS }] };
/** the open-loop throttle that holds the idle cruise before a push (06, 07): the speed loop's own feed-forward at 3 m/s */
const IDLE_THROTTLE = 0.1;
/**
 * AT SPEED, SETTLED (USER: "some shots record too early before we're up to speed… a weird acceleration from almost
 * standing… lots of loss if we cut it off"). `s0` is where she is on the line at shot time 0 — measured off the tuned
 * takes (outv3 traces), so static lenses keep their passes — and `v` her steady speed. `withLook` places her at `v`,
 * `AT_SPEED_SETTLE` s before the head handle, `v · (handle + settle)` m back along the line, so every recorded frame is
 * already at speed and planing; the settle runs unrendered (recorder preroll). Acceleration is scripted only in 06/07.
 */
const along = (loc: LocationId, s0: number, v: number, extra: Partial<DriveSpec> = {}): DriveSpec => ({
  path: LOCATIONS[loc].path,
  startS: s0,
  startSpeed: v,
  speed: [{ t: -99, v }],
  steady: { s0, v },
  ...extra,
});
/** s of steady running between the at-speed placement and the first recorded frame */
export const AT_SPEED_SETTLE = 8;
/** edit handles of an at-speed run: its takes are the long, cuttable coverage (≥ 3 s each side) */
const AT_SPEED_HANDLE = 3;
/**
 * A hull mount's engine life: it was a 6.5 Hz buzz (8.9 Hz on pitch) — the same frame-rate judder as the hard mounts'
 * (see GOPRO). Slow mount flex instead; the hull's own motion is the action.
 */
const BUZZ = { yaw: 0.08, pitch: 0.12, roll: 0.1, alt: 0.002, hz: 1.3 };

// `waterClearance`: no follow, chase or static lens ever below the surface under it (USER: 12's "camera diving into the
// water"); hull rigs are exempt (director.ts)
const base = { transition: 'cut' as const, preroll: PREROLL, handle: HANDLE, waterClearance: 0.4 };

const SHOTS: readonly TrailerShot[] = [
  // ── 00-15: restrained detail reveals, slow deliberate dollies, at rest in the bay ────────────────────────────────
  {
    ...base, id: '01', beat: '01', timeOfDay: 'sunset', slug: 'waterline-bow', in: 0, out: 3, location: 'bayDetail', primitive: 'dolly', drive: REST_DETAIL,
    frame: 'ship', rideSwell: 0.3,
    keys: [
      { t: -1, pos: [2.3, 0, 9.4], aim: [0.5, -0.25, 8.2], fov: 34 },
      { t: 4, pos: [2.3, 0, 6.6], aim: [0.7, -0.25, 5.4] },
    ],
    wobble: { yaw: 0.2, pitch: 0.15, roll: 0.5, hz: 0.07 },
    world: { ...GLASS, post: dof(2.4, 2.5, 4) },
    cue: 'Gentle water, sparse musical tension.',
    note: 'Along the bow at the waterline; the flank and its trembling reflection fill the frame, the full boat never does.',
  },
  {
    ...base, id: '02', beat: '02', timeOfDay: 'sunset', slug: 'number-slide', in: 3, out: 6, location: 'bayDetail', primitive: 'slide', drive: REST_DETAIL,
    frame: 'ship', rideSwell: 0.8,
    keys: [
      { t: -1, pos: [3.4, 0, -2.4], aim: [0, 0.25, -1.4], fov: 30 },
      { t: 4, pos: [3.4, 0, 3.0], aim: [0, 0.25, 4.0] },
    ],
    wobble: { yaw: 0.15, pitch: 0.12, roll: 0.35, hz: 0.06 },
    world: { ...GLASS, post: dof(3.5, 3, 3) },
    cue: 'Low engine idle begins underneath.',
    note: 'Tight lateral slide along the side: the 27, the orange band, worn gelcoat, low sun raking the surface.',
  },
  {
    ...base, id: '03', beat: '03', timeOfDay: 'sunset', slug: 'outboards-dolly', in: 6, out: 9, location: 'bayDetail', primitive: 'dolly', drive: REST_DETAIL,
    frame: 'ship', rideSwell: 0.45,
    keys: [
      { t: -1, pos: [3.4, 0, -6.0], aim: [0.8, 0, -4.3], fov: 36 },
      { t: 4, pos: [-2.4, 0, -7.6], aim: [-0.3, 0, -4.3] },
    ],
    wobble: { yaw: 0.15, pitch: 0.12, roll: 0.4, hz: 0.06 },
    world: { ...GLASS, post: dof(3.2, 3, 3) },
    cue: 'Mechanical vibration, tension grows.',
    note: 'Low rear quarter, sliding past the three cowlings; ripples round the legs.',
  },
  {
    ...base, id: '04', beat: '04', timeOfDay: 'sunset', slug: 'foredeck-glide', in: 9, out: 12, location: 'bay', primitive: 'mount', drive: REST,
    frame: 'hull', mountIsolation: 0.08,
    keys: [
      { t: -1, pos: [0.15, 1.05, 8.4], aim: [0, 0.95, 0.3], fov: 46 },
      { t: 4, pos: [0.1, 0.95, 3.2], aim: [0, 1.05, 0.3] },
    ],
    world: { ...GLASS, post: dof(3.0, 4, 2.5) },
    cue: 'A small musical pulse enters.',
    note: 'Just above the foredeck toward the windshield, looking aft: she points east, so the sunset is behind the pilot and he is a silhouette. The courier cargo (cargo.ts: two cases and a dry bag strapped to the aft-deck cleats) shows either side of his shoulders.',
  },
  {
    ...base, id: '05', beat: '05', timeOfDay: 'sunset', slug: 'first-reveal', in: 12, out: 14, location: 'bay', primitive: 'reveal', drive: REST,
    // cruising now (USER "looks wonky… like it's going backwards or standing"): the lens is locked where she was at the
    // head frame and PANS with her (aimShip) as she comes on toward it, so the island parallax reads her way forward
    frame: 'locked', rideSwell: 0.7, aimShip: [0, 1.0, 1],
    keys: [
      { t: -1, pos: [11, 0, 17], aim: [0, 1.0, 1], fov: 32 },
      { t: 3, pos: [8.5, 0, 18.5], aim: [0, 1.0, 0] },
    ],
    wobble: { yaw: 0.2, pitch: 0.15, roll: 0.5, hz: 0.05 },
    world: { ...GLASS, post: dof(20, 30, 2) },
    cue: 'Hold the tension.',
    note: 'Low front three-quarter looking back WSW: the whole boat for the first time, against the sunset and the island.',
  },
  {
    ...base, id: '06', beat: '06', timeOfDay: 'sunset', slug: 'throttle-insert', in: 14, out: 15, location: 'bayThrottle', primitive: 'insert',
    // ~2.5 s of action inside a 4 s clip (review: the 1 s insert read as a still): the hand reaches −0.7..−0.1, the lever
    // rises over 0–1.2 s and holds; the edit's 1 s sits at the start of the pull, the handles carry reach and hold
    handle: HANDLE + 0.5,
    drive: {
      path: LOCATIONS.bayThrottle.path, startSpeed: CRUISE_MPS, speed: [{ t: -99, v: 36 }],
      throttle: [{ t: -99, v: IDLE_THROTTLE }, { t: 0, v: IDLE_THROTTLE }, { t: 1.2, v: 1 }, { t: 3, v: 1 }],
    },
    throttleHand: true,
    frame: 'hull', mountIsolation: 0.05,
    // HERO INSERT (user: "close-up of the hand pulling on the throttle… cool framing… must flow with the lighting around
    // it"). A 16° lens (~85 mm) low on the dash side, looking aft over the three-lever quadrant (Throttle_LOD0 pivot
    // (−0.36, 0.42, 0.73), handles ≈ (−0.37, 0.62, 0.70)), pushing in ~20 cm through the pull. Review of the first take:
    // soft (focus sat mid-push, 0.25 m range) and a black silhouette (looking aft into the sun). Now the SUN IS ON HER
    // PORT SIDE (bayThrottle heading) raking the knuckles, and focus TRACKS THE GRIP (aimShip on the handle, focusShip)
    // with a 0.4 m range, so grip and knuckles hold while the lever travels.
    keys: [
      { t: -1, pos: [-0.287, 0.573, 1.443], aim: [-0.37, 0.62, 0.7], fov: 16 },
      { t: 2.5, pos: [-0.308, 0.585, 1.254], aim: [-0.37, 0.62, 0.7] },
    ],
    aimShip: [-0.37, 0.62, 0.72], focusShip: true,
    // a slow macro breathing (a 4 Hz buzz judders at 30 fps: see GOPRO)
    wobble: { yaw: 0.05, pitch: 0.08, roll: 0.06, alt: 0.002, hz: 0.9 },
    // 06b, "night throttle": the same insert in the LED world (doc §Variants) — a punch for the night act or a music break
    variants: ['sunset', 'night'],
    // a fill for the cockpit shade (the gunwale still shadows the well at a 3.5° sun); the LEDs light it at night
    world: { ...GLASS, sky: { exposure: 1.35, ambientIntensity: 0.8 }, post: { dofRange: 0.6, dofBokeh: 2.5 } },
    cue: 'Music briefly pulls out. Engine rev surges.',
    note: 'Hero macro insert, low from the dash side, the sunset raking across the quadrant from her port side: the glove reaches onto the lever (−0.7 s), grips and pushes it through (0–1.2 s) and holds. `throttleHand` + pilotRig `cineThrottle`; focus tracks the grip.',
  },
  // ── 15-60: decisive cuts, physical camera placement, real speed ───────────────────────────────────────────────────
  {
    ...base, id: '07', beat: '07', timeOfDay: 'sunset', slug: 'rear-chase-launch', in: 15, out: 19, location: 'bay', primitive: 'chase',
    drive: { ...REST, throttle: [{ t: -99, v: IDLE_THROTTLE }, { t: -2.0, v: IDLE_THROTTLE }, { t: -1.7, v: 1 }], speed: [{ t: -99, v: 38 }] },
    // riding the WATER, not her CG: at the ship-frame 1.6 m of the first take the lens sank into her own wake trough
    // as she squatted and the frame was a wall of sea (frame check, 720p)
    // v2 look pass: 2.2 m off her centreline, 3.4 m over the water and a 36° lens, closing only 11 → 14 m. The rooster
    // tail leaves her centreline and climbs past the lens's side instead of into it, and the cowls fill a third of the
    // frame. Tried against it (640x360 takes 11–13): the centred 16 → 26 m fall-back left her a speck; 2.5 m / 40° /
    // 12 → 18 m still shrank her; port-side 2.6 m cut the cowls off the bottom of the first second.
    // PLATFORM (USER: "camera… bounces with it… steel beam"): a chase boat that answers her launch over 0.5 s, so she
    // squats and pulls away IN the frame; a 28° lens from further back (heavier, compressed) instead of 36° close in
    frame: 'ship', platform: { lag: 0.5, headingLag: 1.2 }, rideSwell: 3.4, focusShip: true,
    keys: [
      { t: -1, pos: [2.8, 0, -14], aim: [0, 0.9, 6], fov: 28 },
      { t: 5, pos: [3.6, 0, -18], aim: [0, 0.9, 8] },
    ],
    wobble: { yaw: 0.3, pitch: 0.25, roll: 0.4, hz: 0.5 },
    // the bay's own glass: the first take switched to `calm` at this cue and logged a crash respawn in the preroll
    world: GLASS,
    cue: 'Music drops hard. Full engine roar.',
    note: 'Hard cut. Throttle hits at t −2.0 (before the head handle), so at the cut she is climbing the planing hump: stern dug in, bow up.',
  },
  {
    ...base, id: '08', beat: '08', timeOfDay: 'sunset', slug: 'side-tracking', in: 19, out: 23, location: 'openSwell', primitive: 'follow',
    drive: along('openSwell', 379, 27),
    // USER: "the way the camera follows is unbelievable/weird". A camera boat (platform): holds station abeam, answers her
    // slams over 0.7 s, follows her course not her yaw, rides the smoothed sea, a slow 1° roll of its own; 30° lens 21 m off
    frame: 'ship', platform: { lag: 0.7, headingLag: 1.5, roll: 1.2, rollPeriod: 5 }, rideSwell: 1.1, focusShip: true,
    keys: [
      { t: -1, pos: [-21, 0, -4.5], aim: [0, 0.6, -0.5], fov: 30 },
      { t: 5, pos: [-21, 0, 4.5], aim: [0, 0.6, 2] },
    ],
    // a level horizon: the roll wobble was the other half of "weird"
    wobble: { yaw: 0.3, pitch: 0.25, roll: 0.15, hz: 0.3 },
    world: CINE_SEA,
    cue: 'Distinct hull impacts through the beat.',
    note: 'Low, abeam, at speed. Heading east: the lens looks north-ish with the sun off frame left, spray backlit as it streaks aft.',
  },
  {
    ...base, id: '09', beat: '09', timeOfDay: 'sunset', slug: 'rocky-point-pass', in: 23, out: 26, location: 'rockyPoint', primitive: 'static-long',
    drive: along('rockyPoint', 721, 30),
    // 1.2 m: at 0.55 m the breeze swell and her own wake closed over the lens at the pass (frame check)
    frame: 'world', rideSwell: 1.2, aimShip: [0, 0.6, 1.5], focusShip: true,
    // tightened 30° → 22° (USER: "has some good bits"): she is a real shape sooner and fills more of the pass
    keys: [{ t: 0, pos: [441, 0, 530], aim: [441, 0, 600], fov: 22 }],
    wobble: { yaw: 0.15, pitch: 0.1, roll: 0.3, hz: 0.2 },
    world: { ...CINE_SEA, post: { dofRange: 40, dofBokeh: 2 } },
    cue: 'Approach, sharp Doppler pass, spray.',
    note: "Lens on the knob's east shoulder, 1.2 m above the water; she comes up the lap's own line and passes ~11 m off at t ≈ 2.2 s, then the frame holds on her wake.",
  },
  {
    ...base, id: '10', beat: '10', timeOfDay: 'dusk', slug: 'bow-lookback', in: 26, out: 30, location: 'openSwell', primitive: 'mount',
    // the dusk time cut at three times of day (straight cuts / dissolves only, no flicker — the day→night switch is R5 06c)
    // + noon / golden (USER: the edit's time-lapse segment): the same take at the race Time option's 12:00 and 17:30
    variants: ['sunset', 'dusk', 'night', 'noon', 'golden'], handle: HANDLE + 1.5,
    // 26 m/s from s 420, weave 0.04: at 32 m/s from s 600 with a 0.1 weave she hooked (heel 50°) at t 2.1 with idle
    // engines and at t 0.0 with warm ones (headless crash machine); every s 420-660 placement at 26 m/s with a 0.06 weave
    // still hooked in 1-6 of 14 runs, this one in 1 (+80 m, warm). `calm` would be 14/14 clean at 31-34 m/s if it has to be.
    drive: along('openSwell', 550, 26, { weave: { amp: 0.04, hz: 0.45, from: -1, to: 5 } }),
    // 1.7 m over the foredeck, aimed at his eye: at 1.0 m the deck filled the frame and he was a speck (browser check)
    frame: 'hull', mountIsolation: 0.06, focusShip: true,
    keys: [{ t: 0, pos: [0, 1.7, 6.5], aim: [0, 1.1, 0.5], fov: 55 }],
    wobble: BUZZ,
    world: CINE_SEA,
    cue: 'Wind and engine strain.',
    note: 'DUSK, the time cut: last light, the sun 5° under the horizon, the sky going blue and her LED strips just on. Bow mount looking back at the pilot; heading east, the afterglow and the wake flick across the frame behind him as she weaves.',
  },
  {
    ...base, id: '11', beat: '11', timeOfDay: 'night', slug: 'front-quarter-carve', in: 30, out: 34, location: 'towerTip', primitive: 'follow',
    drive: along('towerTip', 397, 20, { steerLimit: 0.4, lookaheadS: 2.2 }),
    // USER: "NO far bird's-eye for night"; wanted "a low shot close to the water, from the FRONT at ~45°, a follow cam
    // riding with the boat as it comes through". The overhead was the weakest night shot, so it is this now: 0.9 m over
    // the smoothed sea, 45° off her starboard bow at ~13 m, on the chase damper through the carve, her LED pool and the
    // spray coming at the lens
    frame: 'ship', platform: { lag: 0.6, headingLag: 0.9, roll: 1 }, rideSwell: 0.9, focusShip: true,
    keys: [
      { t: -1, pos: [11.5, 0, 14], aim: [0, 0.8, 0.5], fov: 32 },
      { t: 5, pos: [10, 0, 12], aim: [0, 0.8, 0] },
    ],
    wobble: { yaw: 0.3, pitch: 0.25, roll: 0.2, hz: 0.35 },
    world: CINE_SEA,
    cue: 'Musical hook opens up.',
    note: 'NIGHT. Low front three-quarter tracking shot round the SE tip of Tower Cay: she carves toward the lens at ~20 m/s, her LED pool on the water and the bow spray lit orange coming at camera. (Replaces the v1 overhead; with the pack, their pools trail her through the turn.)',
  },
  {
    ...base, id: '12', beat: '12', timeOfDay: 'night', slug: 'rear-quarter-turn', in: 34, out: 38, location: 'towerTip', primitive: 'follow',
    drive: along('towerTip', 397, 20, { steerLimit: 0.4, lookaheadS: 2.2 }),
    // USER: "jumps around too much and too hard… camera diving into the water": the chase damper instead of an exact hold,
    // a calmer wobble, the clearance clamp (base), and the night's rideable sea
    frame: 'ship', platform: { lag: 0.6, headingLag: 0.8, roll: 1 }, focusShip: true,
    keys: [{ t: 0, pos: [4.6, 1.6, -12.3], aim: [0, 0.5, 3], fov: 40 }],
    wobble: { yaw: 0.25, pitch: 0.2, roll: 0.15, hz: 0.4 },
    world: CINE_SEA,
    cue: 'Engine pitch shifts under load.',
    note: 'NIGHT. Tight on the outboards through the same turn; the LEDs light the spray the stern throws outward under load.',
  },
  {
    ...base, id: '13', beat: '13', timeOfDay: 'night', slug: 'head-on-swells', in: 38, out: 42, location: 'openSwell', primitive: 'follow',
    drive: along('openSwell', 308, 28),
    // off the sun axis and 2.4 m up: dead ahead and 1.1 m up, the first take was glare and a crest (frame check)
    frame: 'ship', platform: { lag: 0.9, headingLag: 2, roll: 1.5, rollPeriod: 6 }, rideSwell: 2.4, focusShip: true,
    keys: [
      { t: -1, pos: [13, 0, 56], aim: [0, 0.9, 0], fov: 26 },
      { t: 5, pos: [9, 0, 36], aim: [0, 0.9, 0] },
    ],
    wobble: { yaw: 0.4, pitch: 0.3, roll: 0.9, hz: 0.25 },
    world: { ...CINE_SEA, post: { dofRange: 50, dofBokeh: 2 } },
    cue: 'Clear impacts, sustained musical drive.',
    note: 'NIGHT. Low ahead, looking back west: the moon behind her as she charges over the open swell, bow lifting and settling. The pack\'s LED pools behind her once the pack exists (doc §Night).',
  },
  {
    ...base, id: '14a', beat: '14', timeOfDay: 'night', slug: 'steering-insert', in: 42, out: 43.6, location: 'swellHead', primitive: 'insert',
    // INTO the swell on `open` (headless crash machine, 6/6 clean: air 6.6–10.5 %, longest hop 0.63 s, no bow-under)
    drive: along('swellHead', 500, 30, { weave: { amp: 0.12, hz: 0.7, from: -1, to: 3 } }),
    frame: 'hull', mountIsolation: 0.06,
    keys: [{ t: 0, pos: [-0.6, 1.15, 1.5], aim: [0, 0.85, 1.0], fov: 40 }],
    wobble: BUZZ,
    world: { ...SWELL_TRIPLE, post: dof(0.9, 0.8, 4) },
    cue: 'Cuts follow movement and impacts (1/3: steering correction).',
    note: 'NIGHT. Hands on the wheel through a scripted steering correction (weave), lit by the dash and the LED strips. The wheel turns with steer (pilotRig wheelAngleFor).',
  },
  {
    ...base, id: '14b', beat: '14', timeOfDay: 'night', slug: 'side-clears-swell', in: 43.6, out: 45.3, location: 'swellHead', primitive: 'follow',
    // air 6.5–12.1 %, longest hop 0.73 s, pitch peaks 17–18°, no bow-under, 6/6 clean
    drive: along('swellHead', 1300, 30),
    frame: 'ship', platform: { lag: 0.6, headingLag: 1.2, roll: 1 }, rideSwell: 0.8, focusShip: true,
    keys: [{ t: 0, pos: [21, 0, 4], aim: [0, 1.0, 1], fov: 30 }],
    wobble: { yaw: 0.4, pitch: 0.3, roll: 1.0, hz: 0.5 },
    world: SWELL_TRIPLE,
    cue: 'Cuts follow movement and impacts (2/3: clearing a swell).',
    note: 'NIGHT. Low abeam as the hull clears a crest and hangs; the LED-lit spray on landing.',
  },
  {
    ...base, id: '14c', beat: '14', timeOfDay: 'night', slug: 'chase-landing', in: 45.3, out: 47, location: 'swellHead', primitive: 'chase',
    // into the swell on `open`: air 3.5–7.8 %, longest hop 0.27 s, no bow-under, 6/6 clean (headless crash machine)
    drive: along('swellHead', 650, 33),
    frame: 'ship', platform: { lag: 0.5, headingLag: 1 }, focusShip: true,
    keys: [{ t: 0, pos: [-2, 3, -28], aim: [0, 0.5, 15], fov: 36 }],
    wobble: { yaw: 0.5, pitch: 0.5, roll: 0.6, hz: 0.7 },
    world: SWELL_TRIPLE,
    cue: 'Cuts follow movement and impacts (3/3: lands and accelerates away).',
    note: 'NIGHT. Chase as the hull lands and pulls away, the rooster tail catching her LEDs.',
  },
  {
    ...base, id: '15', beat: '15', timeOfDay: 'night', slug: 'rock-gap-burst', in: 47, out: 52, location: 'knuckleGap', primitive: 'static-long',
    drive: along('knuckleGap', 415, 26, { steerLimit: 0.9 }),
    // 1.6 m: at 1.0 m the chop between lens and channel hid her for most of the take (frame check)
    // NIGHT, re-scouted (CPU, seabed occlusion only): the old 16° lens from outside the NW mouth held nothing lit or built,
    // only Knuckle rock. From (180, 330) — 4.8 m deep, 15 m from any collider — panning with her on a 24° lens, she is in
    // frame the whole take and passes ~32 m off at t ≈ 3.1 s, with the drowned town's roofs, the steeple and the G5 strobe
    // behind her at t 0–2 and the G6 strobes and the water tower at the pass: an island gap with lit structures in it
    frame: 'world', rideSwell: 1.5, aimShip: [0, 0.6, 1.5], focusShip: true,
    keys: [{ t: 0, pos: [180, 0, 330], aim: [300, 1.5, 352], fov: 24 }],
    wobble: { yaw: 0.12, pitch: 0.1, roll: 0.2, hz: 0.15 },
    world: { ...CINE_SEA, post: { dofRange: 60, dofBokeh: 2 } },
    cue: 'Engine briefly dominates the music.',
    note: 'NIGHT. Close lens on the channel\'s inner shoulder panning with her: she bursts through the Knuckle gap past the drowned town — roofs, steeple, the G5/G6 strobes — with her LED reflections on the water. Knuckle is the best gap Tower Reach has (no true island channel).',
  },
  {
    ...base, id: '16', beat: '16', timeOfDay: 'night', slug: 'horizon-rise', in: 52, out: 56, location: 'horizon', primitive: 'rising',
    drive: along('horizon', 262, 31),
    frame: 'ship', platform: { lag: 1.0, headingLag: 2, roll: 0.8, rollPeriod: 6 }, focusShip: true,
    // off the sun's glitter road: on the centreline her dark hull sat inside the bloom and vanished (browser check)
    keys: [
      { t: -1, pos: [-9, 6, -40], aim: [3, 1, 40], fov: 40 },
      { t: 5, pos: [-11, 26, -68], aim: [3, 0, 60] },
    ],
    wobble: { yaw: 0.3, pitch: 0.2, roll: 0.3, alt: 0.3, hz: 0.08 },
    world: CINE_SEA,
    cue: 'Musical hit on the cut out; engine trails away.',
    note: 'NIGHT. Wide rear follow rising slowly as she runs due west under the moon, her LED trail fading behind her toward the lens.',
  },
];

// ── COVERAGE LENSES (doc §Coverage). Numbers in the hull body frame (+Z bow, +Y up; pilot eye (0, 1.17, 0.45), wheel
// ≈ (0, 0.9, 0.9), throttle quadrant (−0.37, 0.62, 0.70), windshield ≈ z 1.4, deck y 0.54, cowls z −4.4) or in the
// platform's heading frame. Hard mounts are rigid on purpose (the GoPro language) with a small isolation spring and a
// wide lens; everything that follows is a `platform`. None of these has been framed in a browser yet except where the
// note says so — the per-run contact sheets of the coverage look pass are where they get judged.
/**
 * A hard mount's own flex: slow and small. It was a 5 Hz "GoPro buzz" (its pitch axis at 6.9 Hz) and that was the R1
 * judder (USER: "windshield-back… slightly jittery"): at 30 fps a 4–9 Hz shake is 3–7 frames a cycle and no shutter blurs
 * it — measured camera-rotation 2nd difference p50 0.21°, sign reversing on 42 % of frames, while the hull itself has
 * < 3.5 % of its pitch/roll/heave energy above 2 Hz and none above 5 Hz. Micro-vibration cannot be shown at this frame
 * rate; the mount keeps the hull's real motion (through `mountIsolation`) and only a gentle 1 Hz flex of its own.
 */
const GOPRO = { yaw: 0.05, pitch: 0.07, roll: 0.05, alt: 0.001, hz: 1.1 };
const DRONE_ROLL = { roll: 0.8, rollPeriod: 6 };
const hardMount = {
  windshieldBack: (tier: CoverageTier = 'A'): CoverageCamera => ({
    cam: 'windshield-back', tier, kind: 'mount', frame: 'hull', mountIsolation: 0.06, focusShip: false, wobble: GOPRO,
    keys: [{ t: 0, pos: [0.05, 1.42, 1.72], aim: [0, 1.05, 0.2], fov: 64 }],
    world: { post: { dofFocus: 1.4, dofRange: 6, dofBokeh: 1 } },
    note: 'Windshield/dash mount looking back at the pilot: goggles, hands on the turning wheel, the arch and cowls behind, the wake beyond.',
  }),
  povForward: (tier: CoverageTier = 'A'): CoverageCamera => ({
    cam: 'pov-forward', tier, kind: 'mount', frame: 'hull', mountIsolation: 0.07, focusShip: false, wobble: GOPRO,
    keys: [{ t: 0, pos: [0.3, 1.45, -0.2], aim: [-0.05, 0.95, 3.6], fov: 58 }],
    world: { post: { dofFocus: 3, dofRange: 20, dofBokeh: 1 } },
    note: 'Over the right shoulder, forward: gauges and dash, the wheel, the windshield, the water or the rival ahead.',
  }),
  bowAft: (tier: CoverageTier = 'A'): CoverageCamera => ({
    cam: 'bow-aft', tier, kind: 'mount', frame: 'hull', mountIsolation: 0.05, focusShip: false, wobble: GOPRO,
    keys: [{ t: 0, pos: [0, 1.12, 7.4], aim: [0, 1.1, 0.4], fov: 64 }],
    world: { post: { dofFocus: 6, dofRange: 30, dofBokeh: 1 } },
    note: 'Bow-top looking aft over the deck at the cockpit, the bow working through the swell, spray past the lens edges (the hull volume water mask keeps the sea out of the hull).',
  }),
  engineBracket: (tier: CoverageTier = 'B'): CoverageCamera => ({
    cam: 'engine-bracket', tier, kind: 'mount', frame: 'hull', mountIsolation: 0.05, focusShip: false, wobble: GOPRO,
    keys: [{ t: 0, pos: [0.95, 1.05, -4.6], aim: [0.1, 1.15, 0.8], fov: 62 }],
    world: { post: { dofFocus: 4, dofRange: 20, dofBokeh: 1 } },
    note: 'Transom bracket looking forward along the starboard cowl at the pilot\'s back.',
  }),
};
const follow = {
  frontLow: (tier: CoverageTier = 'B', side = 1, fov = 32): CoverageCamera => ({
    cam: side > 0 ? 'front-low' : 'front-low-port', tier, kind: 'front', frame: 'ship', platform: { lag: 0.6, headingLag: 1, ...DRONE_ROLL }, rideSwell: 0.9, focusShip: true,
    keys: [{ t: -1, pos: [11 * side, 0, 14], aim: [0, 0.8, 0.5], fov }, { t: 12, pos: [9.5 * side, 0, 12], aim: [0, 0.8, 0] }],
    wobble: { yaw: 0.25, pitch: 0.2, roll: 0.15, hz: 0.35 },
    note: 'Low front three-quarter tracker, 45° off the bow, the bow wave and spray coming at the lens.',
  }),
  abeam: (tier: CoverageTier = 'B', side = -1, dist = 20, fov = 30): CoverageCamera => ({
    cam: side > 0 ? 'abeam-stbd' : 'abeam-port', tier, kind: 'abeam', frame: 'ship', platform: { lag: 0.7, headingLag: 1.5, ...DRONE_ROLL }, rideSwell: 1.1, focusShip: true,
    keys: [{ t: -1, pos: [dist * side, 0, -3], aim: [0, 0.6, 0], fov }, { t: 12, pos: [dist * side, 0, 4], aim: [0, 0.6, 1.5] }],
    wobble: { yaw: 0.25, pitch: 0.2, roll: 0.12, hz: 0.3 },
    note: 'Camera boat abeam, level horizon, the hull working through the water.',
  }),
  chase: (tier: CoverageTier = 'B', fov = 30, back = 22, up = 3): CoverageCamera => ({
    cam: 'chase', tier, kind: 'chase', frame: 'ship', platform: { lag: 0.55, headingLag: 1.2, ...DRONE_ROLL }, rideSwell: up, focusShip: true,
    keys: [{ t: -1, pos: [2.5, 0, -back], aim: [0, 0.9, 6], fov }, { t: 12, pos: [3, 0, -back - 3], aim: [0, 0.9, 8] }],
    wobble: { yaw: 0.25, pitch: 0.2, roll: 0.1, hz: 0.3 },
    note: 'Chase boat behind and off her quarter.',
  }),
  // scale < 1 pulls the drone in (08 review: at 1 she was a small shape in a corner of the frame, 50 m off and 28 m up)
  droneWide: (tier: CoverageTier = 'B', scale = 1): CoverageCamera => ({
    cam: 'drone-wide', tier, kind: 'wide', frame: 'ship', platform: { lag: 1.2, headingLag: 2.5, heightLag: 3, roll: 0.5, rollPeriod: 7 }, rideSwell: 28 * scale, focusShip: true,
    keys: [{ t: -1, pos: [-30 * scale, 0, -40 * scale], aim: [0, 0, 20 * scale], fov: 40 - 6 * (1 - scale) }, { t: 12, pos: [-24 * scale, 0, -30 * scale], aim: [0, 0, 25 * scale] }],
    wobble: { yaw: 0.3, pitch: 0.2, roll: 0.1, alt: 0.3, hz: 0.08 },
    note: 'Drone establishing wide from behind and above her quarter, the wake laid out on the water.',
  }),
  tele: (tier: CoverageTier = 'B', ahead = 70, side = 14): CoverageCamera => ({
    cam: 'tele', tier, kind: 'tele', frame: 'ship', platform: { lag: 1.0, headingLag: 2, heightLag: 2, roll: 0.4, rollPeriod: 7 }, rideSwell: 1.6, focusShip: true,
    keys: [{ t: -1, pos: [side, 0, ahead], aim: [0, 0.9, 0], fov: 12 }, { t: 12, pos: [side * 0.8, 0, ahead * 0.85], aim: [0, 0.9, 0] }],
    wobble: { yaw: 0.08, pitch: 0.06, roll: 0.05, hz: 0.2 },
    note: 'Long lens from ahead: compressed, heavy, the hull filling the frame over the swell (the tighter option the night wides asked for).',
  }),
};
const insert = {
  props: (tier: CoverageTier = 'C'): CoverageCamera => ({
    cam: 'insert-props', tier, kind: 'insert', frame: 'hull', mountIsolation: 0.05, focusShip: false, wobble: GOPRO,
    keys: [{ t: 0, pos: [1.7, 0.3, -6.3], aim: [0.66, -0.35, -4.6], fov: 40 }],
    world: { post: { dofFocus: 2.1, dofRange: 1.5, dofBokeh: 3 } },
    note: 'The three lower units and props ventilating, from behind the starboard quarter.',
  }),
  cowlNumber: (tier: CoverageTier = 'C'): CoverageCamera => ({
    cam: 'insert-cowl-27', tier, kind: 'insert', frame: 'hull', mountIsolation: 0.06, focusShip: false, wobble: GOPRO,
    keys: [{ t: 0, pos: [2.4, 0.9, -3.4], aim: [0.9, 0.5, -1.2], fov: 34 }],
    world: { post: { dofFocus: 2.6, dofRange: 2.5, dofBokeh: 3 } },
    note: 'Along the starboard flank past the cowls to the 27 and the orange band.',
  }),
  gauges: (tier: CoverageTier = 'C'): CoverageCamera => ({
    cam: 'insert-gauges', tier, kind: 'insert', frame: 'hull', mountIsolation: 0.06, focusShip: false, wobble: GOPRO,
    // placed from a cockpit probe (top / side / front / eye views, shots/cockpit_probe.png): the wheel hub ≈ (0, 0.9, 0.9),
    // the gauge console under the windshield ≈ z 1.15, y 0.75–0.85, tilted to the pilot. The first numbers looked over the
    // windshield at the foredeck. Now just behind the wheel, looking forward-down through the spokes at the gauges.
    keys: [{ t: 0, pos: [0.16, 1.04, 0.68], aim: [0.1, 0.64, 1.16], fov: 44 }],
    // the dash face is in its own shade against the sunset (first framing frame, shots/inserts_gauges_spray.png): +1 stop
    world: { sky: { exposure: 1.8, ambientIntensity: 0.9 }, post: { dofFocus: 0.5, dofRange: 0.5, dofBokeh: 3 } },
    note: 'Through the wheel spokes at the dash: gauges and needles moving.',
  }),
  spray: (tier: CoverageTier = 'C'): CoverageCamera => ({
    cam: 'insert-windshield-spray', tier, kind: 'insert', frame: 'hull', mountIsolation: 0.05, focusShip: false, wobble: GOPRO,
    // just behind the windshield glass (z ≈ 1.45, top y ≈ 1.35, cockpit probe), below its top edge, looking out through it
    keys: [{ t: 0, pos: [0.15, 1.18, 1.22], aim: [0.1, 1.24, 5], fov: 55 }],
    world: { post: { dofFocus: 0.3, dofRange: 0.4, dofBokeh: 4 } },
    note: 'Behind the windshield, focus on the glass: spray sheeting across it, the water soft beyond.',
  }),
  // USER: favour behind / over-the-shoulder / silhouette framings of the pilot over frontal face close-ups
  shoulderSilhouette: (tier: CoverageTier = 'C'): CoverageCamera => ({
    cam: 'insert-shoulder-silhouette', tier, kind: 'insert', frame: 'hull', mountIsolation: 0.06, focusShip: false, wobble: GOPRO,
    keys: [{ t: 0, pos: [-0.5, 1.38, -0.55], aim: [0.15, 1.2, 1.2], fov: 34 }],
    world: { post: { dofFocus: 1.0, dofRange: 0.9, dofBokeh: 3 } },
    note: 'Tight behind the pilot\'s left shoulder: helmet, arm and wheel in silhouette against the sky or the LED glow.',
  }),
  ledStrip: (tier: CoverageTier = 'C'): CoverageCamera => ({
    cam: 'insert-led-strip', tier, kind: 'insert', frame: 'hull', mountIsolation: 0.05, focusShip: false, wobble: GOPRO,
    keys: [{ t: 0, pos: [1.95, 0.35, 2.6], aim: [1.2, 0.2, 0.3], fov: 38 }],
    world: { post: { dofFocus: 1.2, dofRange: 1.5, dofBokeh: 4 } },
    note: 'The LED strip along the starboard chine and its light on the water rushing past.',
  }),
  wake: (tier: CoverageTier = 'C'): CoverageCamera => ({
    cam: 'insert-wake', tier, kind: 'insert', frame: 'ship', platform: { lag: 0.5, headingLag: 1 }, rideSwell: 0.45, focusShip: false,
    keys: [{ t: 0, pos: [2.4, 0, -12], aim: [0.4, -0.3, -5], fov: 36 }],
    world: { post: { dofFocus: 7, dofRange: 5, dofBokeh: 3 } },
    note: 'Low over the wake behind her: the lace, the V arms, the prop wash.',
  }),
  roosterBacklit: (tier: CoverageTier = 'C'): CoverageCamera => ({
    cam: 'insert-rooster-backlit', tier, kind: 'insert', frame: 'ship', platform: { lag: 0.6, headingLag: 1.2 }, rideSwell: 0.7, focusShip: false,
    keys: [{ t: 0, pos: [7, 0, 26], aim: [0, 1.6, -9], fov: 26 }],
    world: { post: { dofFocus: 34, dofRange: 25, dofBokeh: 2 } },
    note: 'Ahead and to the side looking back along her into the low sun: the rooster tail backlit.',
  }),
  moonGlitter: (tier: CoverageTier = 'C'): CoverageCamera => ({
    cam: 'insert-moon-road', tier, kind: 'insert', frame: 'ship', platform: { lag: 1.0, headingLag: 2 }, rideSwell: 3.5, focusShip: false,
    // pulled back to 26 m on a 22° lens (review: no spray in this insert at 14 m — the spray fades inside ~8 m of the lens
    // and the plume sat between the lens and her; at 26 m her plume is in frame, measured at 25 m/s)
    keys: [{ t: 0, pos: [-5, 0, -26], aim: [2, 0.5, 60], fov: 22 }],
    world: { post: { dofFocus: 60, dofRange: 120, dofBokeh: 2 } },
    note: 'Past her toward the moon road on the water, her LED trail crossing it.',
  }),
};

/**
 * THE COVERAGE MAP: extra lenses on the assembly's own runs, keyed by shot id (additive — every shot keeps its own lens
 * as camera 0). A camera renders the whole take; its clip goes to the run's bin. doc §Coverage lists the setups.
 */
const COVERAGE: Readonly<Record<string, readonly CoverageCamera[]>> = {
  // bay idle cruise reveal
  '05': [follow.droneWide(), follow.frontLow('B', 1, 36), insert.cowlNumber()],
  // the launch
  '07': [hardMount.windshieldBack(), hardMount.engineBracket(), follow.abeam('B', 1, 18, 32), follow.frontLow('B', -1, 34), insert.props()],
  // open-water run (sunset)
  '08': [hardMount.povForward(), follow.chase('B'), follow.tele('B'), follow.droneWide('B', 0.5), insert.roosterBacklit(), insert.wake(), insert.spray(), insert.gauges()],
  // the dusk time cut: the windshield-back mount at three times is the LED-underglow variant
  '10': [hardMount.windshieldBack(), hardMount.bowAft(), insert.shoulderSilhouette()],
  // tower-tip carve (night)
  '12': [follow.droneWide(), follow.abeam('B', -1, 22, 28), insert.ledStrip()],
  // night solo front run
  '13': [hardMount.windshieldBack(), follow.tele('A', 60, 10), follow.chase('B', 26, 18, 2.4), insert.ledStrip(), insert.moonGlitter()],
  // swell triple
  '14b': [follow.frontLow('B', -1, 30), hardMount.povForward('B')],
  '14c': [follow.tele('B', 55, -8), insert.props()],
  // Knuckle gap
  '15': [hardMount.povForward(), follow.chase('B', 30, 20, 2.5)],
  // horizon under the moon: the tighter lens the night wide wanted
  '16': [follow.chase('A', 26, 16, 2.2), insert.moonGlitter()],
};

/**
 * A shot's world = its time of day's look, then its own patch on top. The param blocks merge one level deep, so a shot
 * can move one exposure or one DOF number without restating its time's sky or grade.
 */
function withLook(s: TrailerShot): TrailerShot {
  const look = TIME_LOOK[s.timeOfDay];
  const own = s.world ?? {};
  const world: WorldPatch = { ...look, ...own };
  for (const k of ['sky', 'clouds', 'ocean', 'oceanSurface', 'post', 'grade', 'lanterns'] as const) {
    if (look[k] !== undefined || own[k] !== undefined) (world as Record<string, unknown>)[k] = { ...look[k], ...own[k] };
  }
  // a shot's own sun elevation is a SUNSET refinement (the bay's 3.5°); at any other time the time's sun (or clock) rules,
  // or a dusk/night variant of a bay shot would keep a 3.5° sun — the director prefers an elevation over a clock
  if (s.timeOfDay !== 'sunset') {
    if (look.sunElevationDeg === undefined) delete world.sunElevationDeg;
    else world.sunElevationDeg = look.sunElevationDeg;
  }
  // AT SPEED, SETTLED (see `along`): placed at v, AT_SPEED_SETTLE s before the head handle, where the line puts her at s0
  // by shot time 0; longer handles so every camera of the run has a long cuttable take
  const steady = s.drive.steady;
  const handle = steady !== undefined ? Math.max(s.handle ?? HANDLE, AT_SPEED_HANDLE) : s.handle;
  const lead = steady !== undefined ? (handle ?? 0) + AT_SPEED_SETTLE : 0;
  const drive = steady !== undefined ? { ...s.drive, startS: steady.s0 - steady.v * lead } : s.drive;
  return {
    ...s,
    world,
    drive,
    handle,
    coverage: s.coverage ?? COVERAGE[s.id],
    // the idle cruise settles slowly (take 02 check: 2.6 → 3.3 m/s across 01–05's clips), so its preroll gets the same 8 s
    preroll: (steady !== undefined ? lead : (s.preroll ?? PREROLL) + (s.drive.speed[0]?.v === CRUISE_MPS && s.drive.throttle === undefined ? AT_SPEED_SETTLE : 0)) + SEA_SETTLE,
    variant: s.variants !== undefined && s.variants.length > 1 ? s.timeOfDay : s.variant,
  };
}

export const TRAILER_SHOTS: readonly TrailerShot[] = SHOTS.map(withLook);

/**
 * COVERAGE-ONLY SETUPS (doc §Coverage): choreographed runs that are not on the default assembly — the duel, the
 * overtake through a wake, the night pack. Rendered with their cameras and binned; their `in` sits after the trailer
 * (60 s +) only so a `play()` of everything reaches them in order. Filled from the headless-verified choreography.
 */
// Choreography solved headless on the page's player physics, the rivals' wake/contact coupling and the crash machine
// (scratchpad runs/runsim.ts): each run clean 6/6 on `calm` (placement −30/0/+30 m × engines idle/warm). `breeze` hooks a
// duel (fork F: sim and browser) — calm until the named sea presets land.
const RUN = { ...base, handle: HANDLE, location: 'openSwell' as const, run: true };
// SUNSET RIVALS contrast under warm light (USER: "in the duel both boats read ORANGE"): the duel's #8 was Dome Ten's
// charcoal + signal yellow, which the amber key turns into a second orange boat. Sunset setups use a neutral white hull
// (Levee Town: concrete white / black) or a cool hue (Solar Ridge: violet on taupe) — no red/orange/yellow paint at sunset
// (the roster has no blue/teal: they vanish on this sea, assets/livery.ts). Paint is render-only: the choreography holds.
const RUNS: readonly TrailerShot[] = [
  {
    ...RUN, id: 'R1', beat: 'R1', timeOfDay: 'sunset', slug: 'duel', in: 60, out: 70, primitive: 'follow',
    // hero 24.5 → 27.5 → 22.5 m/s, rival 8.5 m to port 26.5 → 22.5 → 27.5: the lead changes at t ≈ 0.4 (rival), 4.8 (hero),
    // 8.5 (rival), each by ≥ half a length; the lateral gap holds 8.2–8.4 m (3.4 beams)
    drive: {path: [[-1700, 150], [-630, 150]], startS: 260, startSpeed: 20, speed: [{t: -99, v: 24.5}, {t: 0.8, v: 24.5}, {t: 1.8, v: 27.5}, {t: 4.2, v: 27.5}, {t: 5.0, v: 22.5}]},
    rivals: [
      { name: 'duel', livery: liveryFor('levee-town', 8), drive: {path: [[-1700, 141.5], [-630, 141.5]], startS: 260, startSpeed: 20, speed: [{t: -99, v: 26.5}, {t: 0.8, v: 26.5}, {t: 1.8, v: 22.5}, {t: 4.2, v: 22.5}, {t: 5.0, v: 27.5}]} },
    ],
    // outside the pair, on the rival's side: a low camera boat 26 m out, aimed between them so both hulls and both wakes read
    frame: 'ship', platform: { lag: 0.8, headingLag: 1.8, roll: 1, rollPeriod: 5 }, rideSwell: 1.0, focusShip: false,
    keys: [{ t: -1, pos: [-27, 0, -2], aim: [-4.25, 0.7, 0], fov: 34 }, { t: 11, pos: [-26, 0, 3], aim: [-4.25, 0.7, 1.5] }],
    wobble: { yaw: 0.25, pitch: 0.2, roll: 0.12, hz: 0.3 },
    world: { ...CINE_SEA, post: { dofFocus: 27, dofRange: 30, dofBokeh: 2 } },
    cue: 'Duel: two boats abeam, trading the lead.',
    note: 'Hero #27 and #8 side by side at speed, 8.5 m apart, the lead changing hands twice; low tracker from outside the pair.',
    coverage: [
      follow.frontLow('A', 1, 30), hardMount.windshieldBack('A'), hardMount.povForward('A'), follow.chase('B', 34, 30, 4),
      follow.tele('B', 70, 6), follow.droneWide('B'),
      {
        cam: 'insert-rival-whoosh', tier: 'C', kind: 'insert', frame: 'world', focusShip: false,
        // a static lens 8.5 m outside the rival's line where the pair passes at t ≈ 4: #8 fills the frame and is gone
        keys: [{ t: 0, pos: [-1190, 0.9, 133], aim: [-1186, 1.2, 145], fov: 50 }], rideSwell: 0.9,
        world: { post: { dofFocus: 9, dofRange: 8, dofBokeh: 3 } },
        note: 'Rival hull passing close to a low static lens (whoosh), the hero beyond it.',
      },
    ],
  },
  {
    ...RUN, id: 'R2', beat: 'R2', timeOfDay: 'sunset', slug: 'overtake-wake', in: 70, out: 80, primitive: 'chase',
    // rival #14 ~40 m ahead on z 150; the hero jogs from z 162 across its line ~30 m behind its stern (t ≈ 2.1) to z 138,
    // passes 15–18 m abeam and leads from t ≈ 7.6. On calm the rival's wake gives a lift (≤ 0.2 s light, 4° pitch), not
    // a jump; a crossing 10 m behind it at 28.5 m/s hooked the hero (sim), so the crossing stays at 30 m
    drive: {path: [[-1700, 162], [-1300, 162], [-1270, 159], [-1220, 141], [-1190, 138], [-630, 138]], startS: 260, startSpeed: 21, speed: [{t: -99, v: 27}, {t: 2.5, v: 27}, {t: 3.5, v: 29}], steerLimit: 0.4, lookaheadS: 1.8},
    rivals: [
      { name: 'overtaken', livery: liveryFor('solar-ridge', 14), drive: {path: [[-1700, 150], [-630, 150]], startS: 318, startSpeed: 18, speed: [{t: -99, v: 23}, {t: 2.5, v: 23}, {t: 3.5, v: 22}]} },
    ],
    frame: 'ship', platform: { lag: 0.7, headingLag: 1.5, roll: 0.8, rollPeriod: 6 }, rideSwell: 5, focusShip: true,
    keys: [{ t: -1, pos: [4, 0, -38], aim: [-2, 0.5, 30], fov: 34 }, { t: 11, pos: [6, 0, -34], aim: [0, 0.5, 30] }],
    wobble: { yaw: 0.2, pitch: 0.15, roll: 0.1, hz: 0.25 },
    world: { ...CINE_SEA, post: { dofRange: 60, dofBokeh: 2 } },
    cue: 'Overtake: cross the rival\'s wake and go by.',
    note: 'High chase behind the hero as she cuts across #14\'s wake and runs it down.',
    coverage: [hardMount.povForward('A'), hardMount.windshieldBack('A'), follow.abeam('B', 1, 22, 30), follow.frontLow('B', 1, 32), insert.wake()],
  },
  {
    ...RUN, id: 'R3', beat: 'R3', timeOfDay: 'night', slug: 'night-pack', in: 80, out: 90, primitive: 'follow',
    // hero leads at 25 m/s; chevron row 1 ~14 m behind at ±8 m, row 2 ~28 m behind at ±12 m; #3 pulls up to 28 m/s from
    // t 6.5 and comes abeam at t 10–11 (closest pair 7.6–8.2 m)
    drive: {path: [[-1700, 150], [-630, 150]], startS: 270, startSpeed: 20, speed: [{t: -99, v: 25}]},
    rivals: [
      { name: 'pack-port-1', livery: liveryFor('solar-ridge', 3), drive: {path: [[-1700, 142], [-630, 142]], startS: 256, startSpeed: 20, speed: [{t: -99, v: 25}, {t: 5.5, v: 25}, {t: 6.5, v: 28}, {t: 9.5, v: 28}, {t: 10.5, v: 25}]} },
      { name: 'pack-stbd-1', livery: liveryFor('dome-ten', 11), drive: {path: [[-1700, 158], [-630, 158]], startS: 254, startSpeed: 20, speed: [{t: -99, v: 25}]} },
      { name: 'pack-port-2', livery: liveryFor('the-stills', 42), drive: {path: [[-1700, 138], [-630, 138]], startS: 242, startSpeed: 20, speed: [{t: -99, v: 25}]} },
      { name: 'pack-stbd-2', livery: liveryFor('outer-bar', 5), drive: {path: [[-1700, 162], [-630, 162]], startS: 240, startSpeed: 20, speed: [{t: -99, v: 25}]} },
    ],
    // low front three-quarter ahead of the pack: her LED pool first, the pack's coloured pools behind her
    // USER (night review): "more chill… slower, smoother camera moves, longer holds on the pack… less bouncing" — a heavy
    // platform (1.2 s), a slow course, a near-still move and a quiet wobble
    frame: 'ship', platform: { lag: 1.2, headingLag: 2.5, heightLag: 2.5, roll: 0.5, rollPeriod: 7 }, rideSwell: 1.2, focusShip: true,
    keys: [{ t: -1, pos: [17, 0, 22], aim: [0, 0.8, -10], fov: 36 }, { t: 11, pos: [16, 0, 21], aim: [0, 0.8, -11] }],
    wobble: { yaw: 0.12, pitch: 0.1, roll: 0.06, hz: 0.15 },
    world: { ...CINE_SEA, post: { dofRange: 60, dofBokeh: 2 } },
    cue: 'Night pack: five boats, five colours of light.',
    note: 'The hero leads a chevron of four rivals under the moon; the LED pools on the black water; #3 challenges late.',
    coverage: [
      follow.droneWide('A'), hardMount.windshieldBack('A'), follow.chase('B', 36, 46, 5), follow.tele('B', 80, 10),
      follow.abeam('B', -1, 30, 32), insert.ledStrip(), insert.moonGlitter(),
    ],
  },
  {
    ...RUN, id: 'R4', beat: 'R4', timeOfDay: 'night', slug: 'night-pack-cruise', in: 90, out: 100, primitive: 'follow',
    // USER: "moderate cruise speeds for some of the pack coverage (e.g. 35–50 kn) so the LED pools and reflections
    // read". R3's chevron at 72 % speed (hero 18 m/s = 35 kn): same placements and structure, the rows hold their spacing
    // (equal speeds), the challenger closes 6 m instead of 9 over its surge and ends a few metres short of abeam, 8 m
    // out. NOT re-run headless (R3 was, 6/6 at 25 m/s); slower on the same sea is the easier case — the take check and
    // the rivals' crash log decide.
    drive: { path: [[-1700, 150], [-630, 150]], startS: 270, startSpeed: 14.4, speed: [{ t: -99, v: 18 }] },
    rivals: [
      { name: 'pack-port-1', livery: liveryFor('solar-ridge', 3), drive: { path: [[-1700, 142], [-630, 142]], startS: 256, startSpeed: 14.4, speed: [{ t: -99, v: 18 }, { t: 5.5, v: 18 }, { t: 6.5, v: 20 }, { t: 9.5, v: 20 }, { t: 10.5, v: 18 }] } },
      { name: 'pack-stbd-1', livery: liveryFor('dome-ten', 11), drive: { path: [[-1700, 158], [-630, 158]], startS: 254, startSpeed: 14.4, speed: [{ t: -99, v: 18 }] } },
      { name: 'pack-port-2', livery: liveryFor('the-stills', 42), drive: { path: [[-1700, 138], [-630, 138]], startS: 242, startSpeed: 14.4, speed: [{ t: -99, v: 18 }] } },
      { name: 'pack-stbd-2', livery: liveryFor('outer-bar', 5), drive: { path: [[-1700, 162], [-630, 162]], startS: 240, startSpeed: 14.4, speed: [{ t: -99, v: 18 }] } },
    ],
    // a slow drone hold from high off the pack's port quarter: every pool and reflection on the water at once
    frame: 'ship', platform: { lag: 1.5, headingLag: 3, heightLag: 3, roll: 0.3, rollPeriod: 8 }, rideSwell: 14, focusShip: true,
    keys: [{ t: -1, pos: [-26, 0, -30], aim: [0, 0, -12], fov: 38 }, { t: 11, pos: [-24, 0, -26], aim: [0, 0, -10] }],
    wobble: { yaw: 0.1, pitch: 0.08, roll: 0.04, alt: 0.1, hz: 0.1 },
    world: { ...CINE_SEA, post: { dofRange: 80, dofBokeh: 1.5 } },
    cue: 'Night pack at cruise: the lights read.',
    note: 'The same chevron at ~35 kn, held from a slow drone: five LED pools and their reflections on the black water.',
    coverage: [follow.frontLow('A', 1, 34), follow.abeam('A', 1, 26, 30), hardMount.windshieldBack('B'), follow.tele('B', 70, 8), insert.ledStrip()],
  },
  {
    ...RUN, id: 'R5', beat: 'R5', timeOfDay: 'sunset', slug: 'throttle-to-night', in: 100, out: 102.5, location: 'bayThrottle', primitive: 'insert',
    // USER (edit direction): the flicker between variants "doesn't work"; instead a SECOND throttle grab at the day→night
    // boundary (after 10, into 11 at 30 s) — "at the moment the lever pushes forward the image switches to night", a
    // match cut on continuous hand and lever motion. Delivered as the frame-identical sunset and night LOOKS of one take
    // (same sim, camera, subframe jitter); the edit plan marks the push-start frame (`cutAtS` 0: the throttle starts to
    // rise at shot time 0) and the editor dissolves or cuts by overlapping them in Resolve (night on V2 over sunset).
    // Handles 2 s each side for the dissolve.
    handle: 2,
    drive: {
      path: LOCATIONS.bayThrottle.path, startSpeed: CRUISE_MPS, speed: [{ t: -99, v: 36 }],
      throttle: [{ t: -99, v: IDLE_THROTTLE }, { t: 0, v: IDLE_THROTTLE }, { t: 1.2, v: 1 }, { t: 3, v: 1 }],
    },
    throttleHand: true,
    variants: ['sunset', 'night'],
    cutAtS: 0,
    // NOT 06's angle: higher, over the dash just inboard of the wheel, close (~0.6 m) and looking down-aft to port at the
    // quadrant — into the low sun (bow NNE, port = west), so the glove and levers are rim-lit silhouettes, with a slow
    // 10 cm push-in; focus on the grip. Framed from numbers, not yet from a frame.
    frame: 'hull', mountIsolation: 0.05,
    keys: [
      { t: -1.5, pos: [-0.04, 0.97, 1.16], aim: [-0.37, 0.63, 0.7], fov: 22 },
      { t: 2, pos: [-0.1, 0.93, 1.07], aim: [-0.37, 0.63, 0.7] },
    ],
    aimShip: [-0.37, 0.62, 0.72], focusShip: true,
    wobble: { yaw: 0.05, pitch: 0.07, roll: 0.05, alt: 0.002, hz: 0.9 },
    world: { ...GLASS, sky: { exposure: 1.35, ambientIntensity: 0.8 }, post: { dofRange: 0.6, dofBokeh: 2.5 } },
    cue: 'Throttle to night: the push is the switch into the night act.',
    note: 'Second throttle grab at the day→night boundary: the glove grips and pushes; cut or dissolve from the sunset take to the night take on the push-start frame (edit plan `cutS`).',
  },
  // ── INTRO / OUTRO material (post notes, docs/cine/speedboat-trailer-post.md): code and plan only, not headless-checked ──
  {
    ...RUN, id: 'R6', beat: 'R6', timeOfDay: 'sunset', slug: 'intro-horizon', in: 110, out: 120, location: 'horizonInbound', primitive: 'static-long',
    // "fade in from black and build tension first": a slow push low over the water straight into the low sun, nothing in
    // frame; the hero comes out of the western horizon at 25 m/s on the line 12 m to the lens's side — ~400 m off at
    // t 0 (a speck in the sun road), ~150 m at t 10 — so she only reads in the last 3–4 s, her engine on the stem first
    handle: 2,
    drive: along('horizonInbound', 1700, 25),
    frame: 'world', rideSwell: 1.0, focusShip: false,
    keys: [
      { t: -2, pos: [-690, 0, 248], aim: [-2400, 6, 262], fov: 20 },
      { t: 12, pos: [-712, 0, 248], aim: [-2400, 5, 262] },
    ],
    wobble: { yaw: 0.06, pitch: 0.05, roll: 0.05, alt: 0.05, hz: 0.06 },
    world: { ...GLASS_OPEN, post: { dofFocus: 300, dofRange: 600, dofBokeh: 1.5 } },
    cue: 'Intro: fade from black, the build before the boat.',
    note: 'Empty sunset horizon, the low sun on glassy water, a slow push; the hero appears out of the sun road late in the take.',
  },
  {
    ...RUN, id: 'R7', beat: 'R7', timeOfDay: 'night', slug: 'outro-moonroad', in: 120, out: 130, location: 'horizon', primitive: 'static-long',
    // "the night moon road after the pack has passed, LED glow fading": the R3 chevron (same offsets and speeds) run WEST
    // along the horizon line toward the moon, past a near-still lens a second before the take — the pools recede ~250 m
    // down the moon road over 10 s and the wakes settle in front of the lens. Clean background for credits.
    handle: 2,
    drive: along('horizon', 75, 25),
    // hero placed at s −175 (steady: 75 − 25·10); row 1 14 m behind, row 2 28 m behind, as R3
    rivals: [
      { name: 'pack-port-1', livery: liveryFor('solar-ridge', 3), drive: { path: [[-650, 268], [-2800, 268]], startS: -189, startSpeed: 25, speed: [{ t: -99, v: 25 }] } },
      { name: 'pack-stbd-1', livery: liveryFor('dome-ten', 11), drive: { path: [[-650, 252], [-2800, 252]], startS: -189, startSpeed: 25, speed: [{ t: -99, v: 25 }] } },
      { name: 'pack-port-2', livery: liveryFor('the-stills', 42), drive: { path: [[-650, 272], [-2800, 272]], startS: -203, startSpeed: 25, speed: [{ t: -99, v: 25 }] } },
      { name: 'pack-stbd-2', livery: liveryFor('outer-bar', 5), drive: { path: [[-650, 248], [-2800, 248]], startS: -203, startSpeed: 25, speed: [{ t: -99, v: 25 }] } },
    ],
    frame: 'world', rideSwell: 1.6, focusShip: false,
    keys: [
      { t: -2, pos: [-705, 0, 232], aim: [-1600, 3, 262], fov: 30 },
      { t: 12, pos: [-712, 0, 233], aim: [-1600, 2.5, 262] },
    ],
    wobble: { yaw: 0.05, pitch: 0.04, roll: 0.04, alt: 0.05, hz: 0.05 },
    world: { ...CINE_SEA, post: { dofFocus: 200, dofRange: 500, dofBokeh: 1.5 } },
    cue: 'Outro: title and credits over the moon road.',
    note: 'The pack has just passed a still lens; their LED pools recede down the moon road and the wakes settle. Credits background.',
  },
];
export const TRAILER_RUNS: readonly TrailerShot[] = RUNS.map(withLook);

const RAW = new Map<string, TrailerShot>([...SHOTS, ...RUNS].map((s) => [s.id, s]));

/** `shot` at another time of day: the same take (choreography, camera, sea) under that time's look */
export function shotAtTime(shot: Pick<TrailerShot, 'id'>, time: TrailerTime): TrailerShot {
  const raw = RAW.get(shot.id);
  if (raw === undefined) throw new Error(`cine: no trailer shot ${shot.id}`);
  return { ...withLook({ ...raw, timeOfDay: time }), variant: time };
}

/**
 * The looks a record run renders per shot: its own `variants`, or — `override` — every picked shot at those times as
 * well (the whole-trailer variant, behind a flag: doc §Variants for the cost). The shot's own time is ALWAYS the first:
 * the recorder draws look 0 straight after the tick, which has just written the shot's own world. A shot with one time
 * and no override is one take with no variant suffix.
 */
export function trailerTakes(shots: readonly TrailerShot[], override?: readonly TrailerTime[]): TrailerShot[] {
  const out: TrailerShot[] = [];
  for (const s of shots) {
    const forced = override !== undefined && override.length > 0;
    const times = forced ? override : s.variants;
    // a shot's own single time is no variant; a forced list, even of one time, is (every take named by its time)
    if (times === undefined || (!forced && times.length <= 1)) {
      out.push(s);
      continue;
    }
    const ordered = [s.timeOfDay, ...times.filter((t) => t !== s.timeOfDay)];
    for (const t of ordered) out.push(t === s.timeOfDay && s.variant === t ? s : shotAtTime(s, t));
  }
  return out;
}

/** a coverage camera's lens as a Shot of its run: the run's everything, the camera's camera fields, its lens world */
export function cameraShot(run: TrailerShot, cam: CoverageCamera): TrailerShot {
  const { follow: _f, platform: _p, rideSwell: _r, aimShip: _a, focusShip: _fs, wobble: _w, mountIsolation: _m, aimSun: _as, ...rest } = run;
  const world: WorldPatch = { ...run.world, post: { ...run.world?.post, ...cam.world?.post }, sky: { ...run.world?.sky, ...cam.world?.sky } };
  return {
    ...rest,
    frame: cam.frame,
    keys: cam.keys,
    follow: cam.follow,
    platform: cam.platform,
    rideSwell: cam.rideSwell,
    waterClearance: cam.waterClearance ?? run.waterClearance,
    aimShip: cam.aimShip,
    focusShip: cam.focusShip,
    wobble: cam.wobble,
    mountIsolation: cam.mountIsolation,
    world,
    camera: cam.cam,
    throttleHand: false,
  };
}

/** the run's coverage cameras at or above a tier (A ⊂ B ⊂ C) */
export function coverageFor(run: Pick<TrailerShot, 'coverage'>, tier: CoverageTier = 'C'): readonly CoverageCamera[] {
  const max = COVERAGE_TIERS.indexOf(tier);
  return (run.coverage ?? []).filter((c) => COVERAGE_TIERS.indexOf(c.tier) <= max);
}

/** the 17 beats on the 60 s timeline; beat 17 is not rendered (title slot) */
export const TRAILER_BEATS: readonly { beat: string; in: number; out: number; rendered: boolean }[] = [
  ...[...new Set(TRAILER_SHOTS.map((s) => s.beat))].map((beat) => {
    const shots = TRAILER_SHOTS.filter((s) => s.beat === beat);
    return { beat, in: Math.min(...shots.map((s) => s.in)), out: Math.max(...shots.map((s) => s.out)), rendered: true };
  }),
  { beat: '17', in: 56, out: 60, rendered: false },
];

/** rhythm cues from the script's sound column, timeline seconds (edit-plan markers) */
export const TRAILER_MARKERS: readonly { atS: number; name: string; color: string; note: string }[] = [
  { atS: 0, name: 'sparse tension', color: 'Blue', note: 'Gentle water, sparse musical tension.' },
  { atS: 3, name: 'engine idle in', color: 'Blue', note: 'Low engine idle begins underneath.' },
  { atS: 9, name: 'musical pulse', color: 'Blue', note: 'A small musical pulse enters.' },
  { atS: 14, name: 'music pulls out', color: 'Yellow', note: 'Music briefly pulls out; engine rev surges (throttle insert).' },
  { atS: 15, name: 'music drop', color: 'Red', note: 'Hard launch into action. Before 15 s: slow dollies; after: decisive cuts.' },
  { atS: 19, name: 'hull impacts', color: 'Orange', note: 'Distinct hull impacts through the beat.' },
  { atS: 23, name: 'doppler pass', color: 'Orange', note: 'Approach, sharp Doppler pass (~25.2 s), spray.' },
  { atS: 30, name: 'hook opens', color: 'Green', note: 'Musical hook opens up.' },
  { atS: 29.5, name: 'day→night: R5 06c', color: 'Purple', note: 'R5 throttle-to-night (bin): the push-start frame is the switch — its sunset and night takes stacked, cut/dissolve on `cutS`.' },
  { atS: 38, name: 'sustained drive', color: 'Green', note: 'Clear impacts, sustained musical drive.' },
  { atS: 42, name: 'cuts on impacts', color: 'Red', note: 'Three quick cuts (14a/14b/14c) follow movement and impacts.' },
  { atS: 47, name: 'engine dominates', color: 'Orange', note: 'Engine briefly dominates the music.' },
  { atS: 56, name: 'musical hit', color: 'Red', note: 'Title on black; engine trails into the distance.' },
];

export const TRAILER_SLOTS: readonly { kind: string; recordInS?: number; recordOutS?: number; track?: string; name: string }[] = [
  { kind: 'intro', recordInS: -8, recordOutS: 0, name: 'intro: fade from black, dramatic build (R6 intro-horizon)' },
  { kind: 'title', recordInS: 56, recordOutS: 60, name: '17 title on black (working title + tagline)' },
  { kind: 'end', recordInS: 60, recordOutS: 70, name: 'end: title + short credits (R7 outro-moonroad or black)' },
  { kind: 'music', track: 'A3', name: 'music (user)' },
];
