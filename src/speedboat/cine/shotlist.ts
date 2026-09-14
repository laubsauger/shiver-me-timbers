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
import type { DriveSpec } from './drive';
import { LOCATIONS, type LocationId } from './locations';

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
}

export const TRAILER_NAME = 'sb-trailer-v1';
export const TRAILER_SECONDS = 60;
/** edit handle on each side of every clip, s */
export const HANDLE = 1;
/** delivery: one frame rate and one master size for every clip (doc §Delivery) */
export const TRAILER_FPS = 60;
export const TRAILER_MASTER: readonly [number, number] = [3840, 2160];
export const TRAILER_PROXY: readonly [number, number] = [1920, 1080];

const PREROLL = 6;
/** low sunset: the sun 3° above the western horizon */
const SUNSET: WorldPatch = { sunElevationDeg: 3, sunSide: 'evening' };
const GLASS: WorldPatch = { ...SUNSET, sunElevationDeg: 3.5, weather: 'glass' };
const BREEZE: WorldPatch = { ...SUNSET, weather: 'breeze' };
/**
 * The open-water swell. NOT the `swell` preset: at its 11 m/s wind sea the scripted boat stalls and stuffs (headless
 * sim: 18 -> 4 m/s in 3 s, 23 m off her line — a crash respawn in the page). `breeze` with a taller ground swell
 * gives the lift-and-settle the beats ask for and keeps her on her feet.
 */
const SWELL: WorldPatch = { ...SUNSET, weather: 'breeze', ocean: { swellAmplitude: 0.55, swellPeriod: 10 } };
const dof = (focus: number, range: number, bokeh = 3): WorldPatch['post'] => ({ dofFocus: focus, dofRange: range, dofBokeh: bokeh });

/** at rest in the bay, pointing east */
const REST: DriveSpec = { path: LOCATIONS.bay.path, speed: [{ t: -99, v: 0 }] };
/**
 * Running on a location's line from `startS` at `v` m/s. Placed at 80% of it: a level placement at full speed into
 * a wave face stuffs the bow (headless sim, shot 14c: 33 -> 3 m/s inside the preroll).
 */
const along = (loc: LocationId, startS: number, v: number, extra: Partial<DriveSpec> = {}): DriveSpec => ({
  path: LOCATIONS[loc].path,
  startS,
  startSpeed: v * 0.8,
  speed: [{ t: -99, v }],
  ...extra,
});
/** engine buzz on a hull mount: fine and fast, never a drift */
const BUZZ = { yaw: 0.18, pitch: 0.35, roll: 0.3, alt: 0.006, hz: 6.5 };

const base = { transition: 'cut' as const, preroll: PREROLL, handle: HANDLE };

export const TRAILER_SHOTS: readonly TrailerShot[] = [
  // ── 00-15: restrained detail reveals, slow deliberate dollies, at rest in the bay ────────────────────────────────
  {
    ...base, id: '01', beat: '01', slug: 'waterline-bow', in: 0, out: 3, location: 'bay', primitive: 'dolly', drive: REST,
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
    ...base, id: '02', beat: '02', slug: 'number-slide', in: 3, out: 6, location: 'bay', primitive: 'slide', drive: REST,
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
    ...base, id: '03', beat: '03', slug: 'outboards-dolly', in: 6, out: 9, location: 'bay', primitive: 'dolly', drive: REST,
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
    ...base, id: '04', beat: '04', slug: 'foredeck-glide', in: 9, out: 12, location: 'bay', primitive: 'mount', drive: REST,
    frame: 'hull',
    keys: [
      { t: -1, pos: [0.15, 1.05, 8.4], aim: [0, 0.95, 0.3], fov: 46 },
      { t: 4, pos: [0.1, 0.95, 3.2], aim: [0, 1.05, 0.3] },
    ],
    world: { ...GLASS, post: dof(3.0, 4, 2.5) },
    cue: 'A small musical pulse enters.',
    note: 'Just above the foredeck toward the windshield, looking aft: she points east, so the sunset is behind the pilot and he is a silhouette. CARGO: no courier cargo prop exists (gap).',
  },
  {
    ...base, id: '05', beat: '05', slug: 'first-reveal', in: 12, out: 14, location: 'bay', primitive: 'reveal', drive: REST,
    frame: 'locked', rideSwell: 0.7,
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
    ...base, id: '06', beat: '06', slug: 'throttle-insert', in: 14, out: 15, location: 'bay', primitive: 'insert',
    drive: { ...REST, throttle: [{ t: -99, v: 0 }, { t: 0.2, v: 0 }, { t: 0.85, v: 1 }, { t: 2, v: 1 }], speed: [{ t: -99, v: 36 }] },
    frame: 'hull',
    keys: [{ t: 0, pos: [0.8, 1.05, 1.4], aim: [0.28, 0.72, 0.85], fov: 38 }],
    wobble: BUZZ,
    world: { ...GLASS, post: dof(0.9, 0.8, 5) },
    cue: 'Music briefly pulls out. Engine rev surges.',
    note: 'The hand pushes the lever forward. Throttle scripted 0 -> 1 over 0.2-0.85 s. The pilot rig does not play a throttle clip (pilotRig.ts), so the hand may not move (gap).',
  },
  // ── 15-60: decisive cuts, physical camera placement, real speed ───────────────────────────────────────────────────
  {
    ...base, id: '07', beat: '07', slug: 'rear-chase-launch', in: 15, out: 19, location: 'bay', primitive: 'chase',
    drive: { ...REST, throttle: [{ t: -99, v: 0 }, { t: -2.0, v: 0 }, { t: -1.7, v: 1 }], speed: [{ t: -99, v: 38 }] },
    // riding the WATER, not her CG: at the ship-frame 1.6 m of the first take the lens sank into her own wake trough
    // as she squatted and the frame was a wall of sea (frame check, 720p)
    frame: 'ship', follow: { halfLife: 0.35, headingOnly: true }, rideSwell: 2.6, focusShip: true,
    keys: [
      { t: -1, pos: [0.6, 0, -16], aim: [0, 0.9, 12], fov: 48 },
      // falls back to 26 m as she gets on the plane: at 21 m her rooster tail filled the lens (browser check)
      { t: 5, pos: [0.4, 0, -26], aim: [0, 0.9, 14] },
    ],
    wobble: { yaw: 0.3, pitch: 0.25, roll: 0.4, hz: 0.5 },
    // the bay's own glass: the first take switched to `calm` at this cue and logged a crash respawn in the preroll
    world: GLASS,
    cue: 'Music drops hard. Full engine roar.',
    note: 'Hard cut. Throttle hits at t −2.0 (before the head handle), so at the cut she is climbing the planing hump: stern dug in, bow up.',
  },
  {
    ...base, id: '08', beat: '08', slug: 'side-tracking', in: 19, out: 23, location: 'openSwell', primitive: 'follow',
    drive: along('openSwell', 230, 33),
    frame: 'ship', follow: { halfLife: 0.3, headingOnly: true }, rideSwell: 0.9, focusShip: true,
    keys: [
      { t: -1, pos: [-15, 0, -3.5], aim: [0, 0.6, -0.5], fov: 42 },
      { t: 5, pos: [-15, 0, 3.5], aim: [0, 0.6, 2] },
    ],
    wobble: { yaw: 0.5, pitch: 0.4, roll: 0.8, hz: 0.4 },
    world: BREEZE,
    cue: 'Distinct hull impacts through the beat.',
    note: 'Low, abeam, at speed. Heading east: the lens looks north-ish with the sun off frame left, spray backlit as it streaks aft.',
  },
  {
    ...base, id: '09', beat: '09', slug: 'rocky-point-pass', in: 23, out: 26, location: 'rockyPoint', primitive: 'static-long',
    drive: along('rockyPoint', 554, 35),
    // 1.2 m: at 0.55 m the breeze swell and her own wake closed over the lens at the pass (frame check)
    frame: 'world', rideSwell: 1.2, aimShip: [0, 0.6, 1.5], focusShip: true,
    keys: [{ t: 0, pos: [441, 0, 530], aim: [441, 0, 600], fov: 30 }],
    wobble: { yaw: 0.15, pitch: 0.1, roll: 0.3, hz: 0.2 },
    world: { ...BREEZE, post: { dofRange: 40, dofBokeh: 2 } },
    cue: 'Approach, sharp Doppler pass, spray.',
    note: "Lens on the knob's east shoulder, 1.2 m above the water; she comes up the lap's own line and passes ~11 m off at t ≈ 2.2 s, then the frame holds on her wake.",
  },
  {
    ...base, id: '10', beat: '10', slug: 'bow-lookback', in: 26, out: 30, location: 'openSwell', primitive: 'mount',
    // re-placed 80 m on: from s 520 she crashed in the preroll (browser check; the water is the same every take now)
    drive: along('openSwell', 600, 32, { weave: { amp: 0.1, hz: 0.45, from: -1, to: 5 } }),
    // 1.7 m over the foredeck, aimed at his eye: at 1.0 m the deck filled the frame and he was a speck (browser check)
    frame: 'hull', focusShip: true,
    keys: [{ t: 0, pos: [0, 1.7, 6.5], aim: [0, 1.1, 0.5], fov: 55 }],
    wobble: BUZZ,
    world: BREEZE,
    cue: 'Wind and engine strain.',
    note: 'Bow mount looking back at the pilot. Heading east, so the sunset and the wake flick across the frame behind him as she weaves.',
  },
  {
    ...base, id: '11', beat: '11', slug: 'overhead-carve', in: 30, out: 34, location: 'towerTip', primitive: 'overhead',
    preroll: 7.3, drive: along('towerTip', 256, 20, { steerLimit: 0.4, lookaheadS: 2.2 }),
    frame: 'world', aimShip: [0, 0, 4], focusShip: true,
    keys: [
      { t: -1, pos: [262, 215, -185], aim: [262, 0, -150], fov: 50 },
      { t: 5, pos: [236, 222, -150], aim: [236, 0, -120] },
    ],
    wobble: { yaw: 0.2, pitch: 0.15, roll: 0.2, hz: 0.05 },
    world: BREEZE,
    cue: 'Musical hook opens up.',
    note: 'High over the SE tip of Tower Cay; she rounds it at ~20 m/s and draws the arc. The arc apex (s ≈ 416 m, due east of the tip) at t ≈ 2 s.',
  },
  {
    ...base, id: '12', beat: '12', slug: 'rear-quarter-turn', in: 34, out: 38, location: 'towerTip', primitive: 'follow',
    preroll: 7.3, drive: along('towerTip', 256, 20, { steerLimit: 0.4, lookaheadS: 2.2 }),
    frame: 'ship', follow: { halfLife: 0.25, headingOnly: true }, focusShip: true,
    keys: [{ t: 0, pos: [3.2, 1.1, -8.5], aim: [0, 0.5, 3], fov: 58 }],
    wobble: { yaw: 0.4, pitch: 0.35, roll: 0.5, hz: 0.6 },
    world: BREEZE,
    cue: 'Engine pitch shifts under load.',
    note: 'Tight on the outboards through the same turn, the stern throwing spray outward.',
  },
  {
    ...base, id: '13', beat: '13', slug: 'head-on-swells', in: 38, out: 42, location: 'openSwell', primitive: 'follow',
    drive: along('openSwell', 150, 33),
    // off the sun axis and 2.4 m up: dead ahead and 1.1 m up, the first take was glare and a crest (frame check)
    frame: 'ship', follow: { halfLife: 1.5, headingOnly: true }, rideSwell: 2.4, focusShip: true,
    keys: [
      { t: -1, pos: [10, 0, 44], aim: [0, 0.9, 0], fov: 34 },
      { t: 5, pos: [7, 0, 28], aim: [0, 0.9, 0] },
    ],
    wobble: { yaw: 0.4, pitch: 0.3, roll: 0.9, hz: 0.25 },
    world: { ...SWELL, post: { dofRange: 50, dofBokeh: 2 } },
    cue: 'Clear impacts, sustained musical drive.',
    note: 'Low ahead, looking back west: the sunset behind her as she charges over the open swell, bow lifting and settling.',
  },
  {
    ...base, id: '14a', beat: '14', slug: 'steering-insert', in: 42, out: 43.6, location: 'openSwell', primitive: 'insert',
    drive: along('openSwell', 300, 32, { weave: { amp: 0.12, hz: 0.7, from: -1, to: 3 } }),
    frame: 'hull',
    keys: [{ t: 0, pos: [-0.6, 1.15, 1.5], aim: [0, 0.85, 1.0], fov: 40 }],
    wobble: BUZZ,
    world: { ...SWELL, post: dof(0.9, 0.8, 4) },
    cue: 'Cuts follow movement and impacts (1/3: steering correction).',
    note: 'Hands on the wheel through a scripted steering correction (weave). The wheel turns with steer (pilotRig wheelAngleFor).',
  },
  {
    ...base, id: '14b', beat: '14', slug: 'side-clears-swell', in: 43.6, out: 45.3, location: 'openSwell', primitive: 'follow',
    drive: along('openSwell', 420, 33),
    frame: 'ship', follow: { halfLife: 0.5, headingOnly: true }, rideSwell: 0.5, focusShip: true,
    keys: [{ t: 0, pos: [16, 0, 3], aim: [0, 1.0, 1], fov: 40 }],
    wobble: { yaw: 0.4, pitch: 0.3, roll: 1.0, hz: 0.5 },
    world: SWELL,
    cue: 'Cuts follow movement and impacts (2/3: clearing a swell).',
    note: 'Low abeam as the hull clears a crest and hangs.',
  },
  {
    ...base, id: '14c', beat: '14', slug: 'chase-landing', in: 45.3, out: 47, location: 'openSwell', primitive: 'chase',
    // re-placed from s 560, where the preroll crashed twice at the same spot (browser checks)
    drive: along('openSwell', 660, 33),
    frame: 'ship', follow: { halfLife: 0.3, headingOnly: true }, focusShip: true,
    keys: [{ t: 0, pos: [-1.5, 2.2, -20], aim: [0, 0.5, 15], fov: 50 }],
    wobble: { yaw: 0.5, pitch: 0.5, roll: 0.6, hz: 0.7 },
    world: SWELL,
    cue: 'Cuts follow movement and impacts (3/3: lands and accelerates away).',
    note: 'Chase as the hull lands and pulls away.',
  },
  {
    ...base, id: '15', beat: '15', slug: 'rock-gap-burst', in: 47, out: 52, location: 'knuckleGap', primitive: 'static-long',
    drive: along('knuckleGap', 266, 26, { steerLimit: 0.9 }),
    // 1.6 m: at 1.0 m the chop between lens and channel hid her for most of the take (frame check)
    frame: 'world', rideSwell: 1.6, focusShip: true,
    keys: [
      { t: -1, pos: [100, 0, 262], aim: [300, 1.5, 352], fov: 16 },
      { t: 6, pos: [100, 0, 263.5], aim: [300, 1.5, 350] },
    ],
    wobble: { yaw: 0.12, pitch: 0.1, roll: 0.2, hz: 0.15 },
    world: { ...BREEZE, post: { dofRange: 60, dofBokeh: 2 } },
    cue: 'Engine briefly dominates the music.',
    note: 'Long lens from outside the NW mouth of the Knuckle channel: she bursts out from behind the middle knob, races the channel toward the lens and exits frame close. FLAGGED: not a true island gap (none on Tower Reach).',
  },
  {
    ...base, id: '16', beat: '16', slug: 'horizon-rise', in: 52, out: 56, location: 'horizon', primitive: 'rising',
    drive: along('horizon', 100, 34),
    frame: 'ship', follow: { halfLife: 1.2, headingOnly: true }, focusShip: true,
    // off the sun's glitter road: on the centreline her dark hull sat inside the bloom and vanished (browser check)
    keys: [
      { t: -1, pos: [-7, 5, -32], aim: [3, 1, 40], fov: 50 },
      { t: 5, pos: [-9, 22, -55], aim: [3, 0, 60] },
    ],
    wobble: { yaw: 0.3, pitch: 0.2, roll: 0.3, alt: 0.3, hz: 0.08 },
    world: BREEZE,
    cue: 'Musical hit on the cut out; engine trails away.',
    note: 'Wide rear follow rising slowly as she runs due west into the glow, the wake stretching back to the lens.',
  },
];

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
  { atS: 38, name: 'sustained drive', color: 'Green', note: 'Clear impacts, sustained musical drive.' },
  { atS: 42, name: 'cuts on impacts', color: 'Red', note: 'Three quick cuts (14a/14b/14c) follow movement and impacts.' },
  { atS: 47, name: 'engine dominates', color: 'Orange', note: 'Engine briefly dominates the music.' },
  { atS: 56, name: 'musical hit', color: 'Red', note: 'Title on black; engine trails into the distance.' },
];

export const TRAILER_SLOTS: readonly { kind: string; recordInS?: number; recordOutS?: number; track?: string; name: string }[] = [
  { kind: 'title', recordInS: 56, recordOutS: 60, name: '17 title on black (working title + tagline)' },
  { kind: 'music', track: 'A3', name: 'music (user)' },
];
