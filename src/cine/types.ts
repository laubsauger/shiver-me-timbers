/**
 * Cinematic shot-list types — shared by every page that shoots: the pirate
 * piece (docs/cine/warfish-alan-watts-camera-script.md) and the speedboat
 * trailer (docs/cine/speedboat-trailer-v1.md). "Ship" below means whichever
 * hull the page's DirectorHost frames.
 *
 * A Shot is DATA. The director (director.ts) is the only thing that reads it,
 * and the recorder (recorder.ts) is the only thing that decides when. Nothing
 * here imports three or touches the renderer, so the whole timeline is unit
 * testable without a GPU.
 */
import type { WeatherPresetName } from '../weather/presets';
import type { skyParams } from '../params/sky';
import type { oceanParams } from '../params/ocean';
import type { oceanSurfaceParams } from '../params/oceanSurface';
import type { postParams } from '../params/post';
import type { gradeParams } from '../params/grade';
import type { lanternParams } from '../params/lanterns';
import type { cloudParams } from '../params/clouds';

export type Vec3 = readonly [number, number, number];

/**
 * Which frame a key's `pos`/`aim` are expressed in.
 *
 * - `world` — absolute world metres. For shots with no ship in them.
 * - `ship`  — ship origin + the ship's HEADING ONLY (yaw). What every aerial
 *             wants: the rig holds station on the hull without inheriting her
 *             roll, which is what a drone actually does.
 * - `hull`  — ship origin + her FULL attitude. Deck-mounted rigs, which must
 *             roll with her or they read as a matte painting.
 * - `locked` — resolved from the ship's pose ONCE, when the shot is cued, then
 *             held in world space for the whole take.
 *
 * `locked` is the reference's own opening move and it cannot be built out of
 * the others. The camera does not move at all; the boat enters the bottom-right
 * corner, drives across the frame and leaves at the top-left. A `ship`-frame
 * rig holds station on her and she never crosses anything; a hand-written
 * `world` pose has to guess where she will be. Locking her own frame at cue
 * time gives a repeatable composition AND lets her sail out of it.
 */
export type ShotFrame = 'world' | 'ship' | 'hull' | 'locked';

export type Transition = 'cut' | 'dissolve' | 'fade';

export interface ShotKey {
  /** seconds from the shot's own start, NOT timeline time */
  t: number;
  pos: Vec3;
  aim: Vec3;
  /** vertical FOV, deg. Omitted = inherit the previous key's. */
  fov?: number;
  /** camera roll about the view axis, deg. Omitted = 0. */
  roll?: number;
}

/**
 * Low-frequency motion laid over the interpolated pose. This is the difference
 * between "a camera" and "a rail": every aerial in the reference has it, and
 * without it the shot reads as a fly-through.
 *
 * All deterministic functions of shot-local time — no RNG, so a re-render of
 * frame 412 is byte-identical to the first one.
 */
export interface Wobble {
  /** deg */
  yaw?: number;
  /** deg */
  pitch?: number;
  /** deg */
  roll?: number;
  /** metres */
  alt?: number;
  /** base frequency, Hz. Each axis runs at a prime-ish multiple of it. */
  hz?: number;
}

/** Everything a shot asserts about the world. Re-applied EVERY TICK — see the
 *  note in director.applyWorld about what reverts it otherwise. */
export interface WorldPatch {
  /**
   * THE PREFERRED SUN CONTROL: where the sun sits above (or below) the
   * horizon, degrees. Solved to a `timeOfDay` against the engine's own
   * `sunElevation`, which is what makes the number mean the same thing after
   * anyone touches `latitude`.
   *
   * A clock time does NOT mean a light level. Shot D was written at 05:33 on
   * the reasoning that it is "blue hour", rendered as broad daylight, and the
   * measurement that explained it is that this sky is still bright at -6.5
   * degrees. Elevation is the thing the picture actually reads.
   */
  sunElevationDeg?: number;
  /** which side of noon to solve on. Default 'morning'. */
  sunSide?: 'morning' | 'evening';
  /** hours, 0..24. Only used when `sunElevationDeg` is absent. */
  timeOfDay?: number;
  weather?: WeatherPresetName;
  sky?: Partial<typeof skyParams>;
  /** cloud layer — `coverage: 0` is how a shot gets an empty sky */
  clouds?: Partial<typeof cloudParams>;
  ocean?: Partial<typeof oceanParams>;
  /**
   * The WATER's own distance haze. Not a duplicate of `sky.fogNear/fogFar`:
   * the ocean sets `material.fog = false` and melts itself instead
   * (surfaceMaterial.ts:2436, §V30), so scene fog reaches the SHIP and nothing
   * else. A fog bank needs both, or you get a ghostly hull under a clear sky —
   * which is exactly what the first fog take looked like.
   */
  oceanSurface?: Partial<typeof oceanSurfaceParams>;
  post?: Partial<typeof postParams>;
  grade?: Partial<typeof gradeParams>;
  lanterns?: Partial<typeof lanternParams>;
  /** drive the hull at this speed instead of waiting on the wind */
  shipKnots?: number;
  shipAnchored?: boolean;
}

export interface Shot {
  id: string;
  /** one line, for the render log and the EDL */
  slug: string;
  /** timeline in/out, seconds — from the reference cut list */
  in: number;
  out: number;
  /** how this shot LEAVES. `dissolve` needs handle frames; see `handle`. */
  transition: Transition;
  /** dissolve/fade length, s. Ignored for `cut`. */
  transitionSeconds?: number;
  frame: ShotFrame;
  keys: readonly ShotKey[];
  wobble?: Wobble;
  /**
   * Follow the hull through a DAMPER instead of being bolted to her.
   *
   * `frame: 'ship'` resolves against her live pose, so the rig inherits every
   * yaw and surge she makes — on a long take that reads as the camera wobbling
   * with the boat rather than watching it. A half-life here (seconds) smooths
   * the pose the keys are resolved against: the shot still follows her
   * anywhere she goes, it just stops twitching when she does. 1.5-4 s is a
   * drone holding station; below ~0.5 s there is no point.
   */
  follow?: {
    halfLife: number;
    /**
     * Damp the HEADING only; hold her position exactly. A position damper lags by speed × halfLife / ln 2 — a
     * few metres on an 8 kn brigantine, 15-70 m on a 30 m/s speedboat, which drops her out of a chase frame.
     */
    headingOnly?: boolean;
  };
  /**
   * A CAMERA PLATFORM with its own mass (a chase boat or a drone), instead of a rig bolted to the hull. Frame `ship`.
   * USER: "the camera is weirdly attached and bounces with it… like it's connected on a steel beam to the boat".
   *
   *  - position: a critically damped spring onto her position AND her smoothed velocity, so at a steady speed it holds
   *    station with no lag and on an impact or a surge it answers over `lag` seconds — the boat moves in the frame;
   *  - heading: her smoothed COURSE (velocity direction), low-passed over `headingLag` — not her yaw jitter;
   *  - height: the smoothed sea under the lens (`heightLag`) + `rideSwell` (or the key's y) — never her heave; the
   *    `waterClearance` clamp still applies;
   *  - aim: the key's aim point is taken relative to a low-passed point at her CG (`aimLag`), which only moves once
   *    she leaves a `deadZone` (m) around it — on a slam she moves inside the frame;
   *  - the platform's own motion: a slow roll of `roll`° over `rollPeriod` s (a camera boat), plus the shot's wobble;
   *  - her pitch and roll never transfer: the horizon stays level.
   * Keys are in the platform's heading frame, as for `ship`. `follow` is ignored when this is set.
   */
  platform?: {
    /** s, position response (critically damped); 0.4–1.0 for a chase */
    lag: number;
    /** s, heading low-pass (default 1.0) */
    headingLag?: number;
    /** s, sea-height low-pass under the lens (default 1.5) */
    heightLag?: number;
    /** s, aim-point low-pass (default 0.35) */
    aimLag?: number;
    /** m, the aim point eases in as she leaves this zone around it (soft, default 1.2) */
    deadZone?: number;
    /** deg, the platform's own slow roll amplitude (default 1) */
    roll?: number;
    /** s (default 5) */
    rollPeriod?: number;
  };
  /**
   * A HARD MOUNT's isolation (frame `hull`): her attitude reaches the lens through a spring of this half-life (s)
   * instead of 1:1, so a slam arrives as a quick lean rather than a jolt. The lens stays bolted in position (it is
   * inside or on the boat). 0.04–0.1 s reads as a GoPro on a rubber mount. Omitted = rigid.
   */
  mountIsolation?: number;
  /**
   * Half-life (s) of the water height `rideSwell` samples: the lens follows the swell, not every ripple under it.
   * Omitted = the raw sample every frame.
   */
  rideSmooth?: number;
  /**
   * Keep the lens at least this far (m) above the sea surface under it — a chase or follow camera must never dive into
   * a crest. Not applied to `hull` rigs (they are inside or on the boat). Omitted = no clamp.
   */
  waterClearance?: number;
  /**
   * Park the lens this many metres above the SAMPLED water height instead of
   * using the key's y. What makes the waterline shots ride the swell for free.
   */
  rideSwell?: number;
  /**
   * Seconds of sim to run before the first captured frame. The wake, the foam
   * and the weather lerp all need time to exist — shot D is 16 s of wake and
   * would open on flat water without this.
   */
  preroll?: number;
  world?: WorldPatch;
  /**
   * Aim at the SUN rather than at the key's `aim`, offset by these angles.
   * The reference's three strongest images (A, H, J) are all "the sun, placed
   * off-centre", and the sun's world direction is a function of `timeOfDay`
   * and `latitude` — so a hand-written aim vector would silently stop pointing
   * at it the moment either changed. `yaw` positive swings the disc toward
   * frame-RIGHT, `pitch` positive toward frame-TOP.
   */
  aimSun?: { yaw: number; pitch: number };
  /**
   * Aim at a point ON THE HULL (hull frame, her full live attitude) instead of
   * the key's `aim`. What a static long lens on a moving boat needs: the lens
   * stays put (`frame: 'world'`) and pans with her, so she can grow from a speck
   * to a close pass without a hand-written aim that has to guess where she is.
   */
  aimShip?: Vec3;
  /**
   * Pull focus to her every frame: `post.dofFocus` = lens → aim point distance.
   * DOF itself is a construction gate of the post pipeline (postPipeline.ts),
   * so this only reads when the page was BUILT with `dofEnabled`.
   */
  focusShip?: boolean;
  /**
   * Seconds of extra footage rendered BEFORE `in` and AFTER `out`, for an edit
   * cut to music. The shot's own duration is the target; the editor trims into
   * the handles. Omitted = 0 (the take is exactly the shot).
   */
  handle?: number;
  /** why this shot is framed the way it is — kept next to the numbers */
  note?: string;
}

/** first frame of a take, shot-local seconds (negative when it carries a head handle) */
export const shotHead = (s: Shot): number => s.handle ?? 0;

/** seconds rendered past `out`: the edit handle plus a dissolve's overlap frames */
export const shotTail = (s: Shot): number =>
  (s.handle ?? 0) + (s.transition === 'dissolve' ? (s.transitionSeconds ?? 1) : 0);

export const shotDuration = (s: Shot): number => s.out - s.in;
