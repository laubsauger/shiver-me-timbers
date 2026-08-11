/**
 * World-space wake TRACK history (§V10 follow-up — the "water remembers" fix).
 *
 * WHY THIS EXISTS (user review, twice): the old wake was a ship-LOCAL analytic
 * shape (bow V + stern band) evaluated out to `wakeRange` metres along the
 * ship's CURRENT heading every frame. Turning re-oriented ~40 m of already-laid
 * wake instantly — "immediately spraying out at a new angle at full distance",
 * "as if it's actually propelled out of the air when you turn". No amount of
 * tuning fixes that: the pattern had no memory.
 *
 * The fix is to record where the CUTWATER has been, in world space, and derive
 * every wake feature from that polyline instead of from the live heading. A
 * deposited sample never moves and never re-orients; it only ages. Turn hard
 * and the far end of the trail keeps pointing the old way, while the new
 * rooster tail has to be travelled into existence — a sample laid this frame
 * has dist = 0, so its Kelvin arms start ON the hull and open up over the
 * following seconds (wakeMath.ts: spread = dist · tan θ).
 *
 * PURE MODULE — zero three imports, so tests/flowfoam.test.ts runs in node
 * (same contract as flowMath.ts / wakeMath.ts). GPU side uploads this array
 * into uniform arrays; wakeInjection.ts is the only consumer.
 *
 * SAMPLE FIELDS (all world-space, all frozen at emission except age/dist):
 *   x, z    cutwater position when the sample was laid
 *   fx, fz  unit forward at that instant (port/starboard sign + forward clip)
 *   speed   speed over water at that instant — drives intensity, NOT geometry
 *   age     seconds since emission            → temporal fades, turbulent spread
 *   dist    arclength from the sample FORWARD to the live cutwater
 *           → Kelvin arm spread, hull-length offset for the stern features
 *
 * age and dist are deliberately separate: wave geometry is set by how far the
 * ship has travelled since (dist), turbulent diffusion by how long the water
 * has had to churn (age). Under acceleration the two decouple, and using
 * speed·age for both (the obvious shortcut) bends the V wrong.
 *
 * Index 0 = YOUNGEST. Ages and dists increase monotonically with index, which
 * the GPU segment walk relies on for its interpolation.
 */

/**
 * Recorded history samples. Build constant, not a param: it fixes the GPU
 * uniform-array size and the literal Loop bound (§V28). trackSpacing ×
 * TRACK_CAPACITY must span the foam region or the trail ends mid-window.
 */
export const TRACK_CAPACITY = 48;

export interface TrackSample {
  /** world X of the cutwater at emission */
  x: number;
  /** world Z of the cutwater at emission */
  z: number;
  /** unit forward X at emission */
  fx: number;
  /** unit forward Z at emission */
  fz: number;
  /** speed over water (m/s) at emission */
  speed: number;
  /** seconds since emission */
  age: number;
  /** arclength (m) from this sample forward along the track to the live cutwater */
  dist: number;
}

export interface TrackConfig {
  /** hard cap on stored samples — the GPU loop bound (§V28 literal bounds) */
  capacity: number;
  /** metres of travel between recorded samples */
  spacing: number;
  /** seconds after which a sample is dropped from the tail */
  life: number;
  /** below this speed (m/s) the ship lays no new track */
  minSpeed: number;
  /**
   * Heading change (radians) that also triggers a sample, before the ship has
   * travelled a full `spacing`. Distance-only sampling facets hard turns: with
   * the physics agent's ~1 s yaw ramp a 90° turn at 6 m/s covers ~9 m, which
   * at 2.2 m spacing is only 4 samples — a 22°-per-segment hinge rather than a
   * curve, and turn fidelity is the whole point of this system. Sampling on
   * turn rate spends capacity where the trail actually bends.
   */
  maxTurn: number;
}

/**
 * Minimum travel (as a fraction of `spacing`) before a turn may trigger a
 * sample. Without it a ship pivoting on the spot stacks samples on one point,
 * producing degenerate zero-length segments.
 */
const TURN_MIN_GAP_FRAC = 0.2;

export interface TrackPose {
  /** world X of the cutwater NOW */
  x: number;
  /** world Z of the cutwater NOW */
  z: number;
  fx: number;
  fz: number;
  speed: number;
}

export interface WakeTrack {
  /** index 0 = youngest recorded sample; the LIVE pose is not stored here */
  samples: TrackSample[];
  /** cutwater position at the previous advance (arclength integrator) */
  lastX: number;
  lastZ: number;
  /** false until the first advance seeds lastX/lastZ */
  primed: boolean;
}

export function createWakeTrack(): WakeTrack {
  return { samples: [], lastX: 0, lastZ: 0, primed: false };
}

/**
 * Frame-rate-independent first-order approach (exponential lag), used for the
 * bow mound's amplitude.
 *
 * WHY: the user wants the bow wave to "build and subside with the hull's
 * actual motion rather than snapping to a speed value" — a heavy hull shoves
 * a mound that takes a moment to pile up and a moment to fall away. Driving
 * the mound off raw speed makes it pop the instant the throttle changes.
 * Exact under subdivision (two dt/2 steps == one dt step), so the mound is not
 * a function of frame rate.
 */
export function approachExp(current: number, target: number, dt: number, tau: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(target)) return 0;
  if (!(tau > 0) || !(dt > 0)) return target;
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

const isFinite2 = (a: number, b: number): boolean => Number.isFinite(a) && Number.isFinite(b);

/**
 * Advance the history one frame: age every sample, grow every sample's
 * arclength by the distance the cutwater travelled, evict the tail, and lay a
 * new sample once the ship has moved a full `spacing` from the last one.
 *
 * Mutates in place (called 60×/s — no per-frame garbage). Returns nothing;
 * read `t.samples`.
 *
 * §V28: non-finite poses are ignored rather than propagated into uniforms, and
 * a jump larger than the whole track resets instead of drawing a wake across
 * the teleport chord.
 */
export function advanceTrack(t: WakeTrack, pose: TrackPose, dt: number, cfg: TrackConfig): void {
  if (!isFinite2(pose.x, pose.z) || !isFinite2(pose.fx, pose.fz)) return;
  if (!Number.isFinite(pose.speed) || !Number.isFinite(dt) || dt < 0) return;

  if (!t.primed) {
    t.lastX = pose.x;
    t.lastZ = pose.z;
    t.primed = true;
  }
  const moved = Math.hypot(pose.x - t.lastX, pose.z - t.lastZ);
  t.lastX = pose.x;
  t.lastZ = pose.z;

  // a jump bigger than the entire track is a teleport, not sailing
  if (moved > cfg.spacing * cfg.capacity) {
    t.samples.length = 0;
  }

  for (const s of t.samples) {
    s.age += dt;
    s.dist += moved;
  }
  // evict from the tail (samples are age-ordered, so this is a suffix trim)
  while (t.samples.length > 0 && t.samples[t.samples.length - 1].age > cfg.life) {
    t.samples.pop();
  }

  const head = t.samples[0];
  const gap = head === undefined ? Infinity : Math.hypot(pose.x - head.x, pose.z - head.z);
  // sample on distance travelled OR on heading change, whichever comes first,
  // so a hard turn is deposited as a curve rather than a few long chords
  const turned =
    head === undefined
      ? Infinity
      : Math.acos(Math.min(1, Math.max(-1, pose.fx * head.fx + pose.fz * head.fz)));
  const dueToTurn = turned >= cfg.maxTurn && gap >= cfg.spacing * TURN_MIN_GAP_FRAC;
  if (pose.speed >= cfg.minSpeed && (gap >= cfg.spacing || dueToTurn)) {
    t.samples.unshift({
      x: pose.x,
      z: pose.z,
      fx: pose.fx,
      fz: pose.fz,
      speed: pose.speed,
      age: 0,
      dist: 0,
    });
    while (t.samples.length > cfg.capacity) t.samples.pop();
  }
}

/**
 * The polyline the wake field is evaluated against: the LIVE cutwater pose
 * prepended (age 0, dist 0) to the recorded history.
 *
 * WHY prepend: recorded samples lag the ship by up to `spacing` metres, so
 * evaluating against history alone leaves the tip of the V floating behind the
 * stem and the very front of the boat reads clean (direct user complaint).
 * With the live pose as element 0 the V vertex sits exactly on the cutwater
 * every single frame, and `dist` (which advanceTrack keeps measured to the
 * live cutwater) stays consistent across the join.
 */
export function trackPoints(t: WakeTrack, pose: TrackPose): TrackSample[] {
  const live: TrackSample = {
    x: pose.x,
    z: pose.z,
    fx: pose.fx,
    fz: pose.fz,
    speed: pose.speed,
    age: 0,
    dist: 0,
  };
  return [live, ...t.samples];
}

/**
 * World-XZ AABB of the track, expanded by `margin`, for the GPU early-out.
 * Texels outside it cannot be touched by any wake feature, so the whole
 * segment walk is skipped — most of a 512² region is open water.
 * Returns null for a track too short to form a segment.
 */
export function trackBounds(
  points: TrackSample[],
  margin: number,
): { minX: number; minZ: number; maxX: number; maxZ: number } | null {
  if (points.length < 2) return null;
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  return { minX: minX - margin, minZ: minZ - margin, maxX: maxX + margin, maxZ: maxZ + margin };
}
