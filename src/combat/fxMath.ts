/**
 * Pure particle math for the combat fx pool — no three.js, so the burst
 * shapes and the decay are unit-testable headlessly and the render module
 * stays a thin buffer-filling shell.
 *
 * §V.28 is the reason this is its own file: §B.5 was a NaN particle age
 * dividing to a NaN sprite size, which rasterized ×4096 additive quads and
 * read as a browser hang. Every division here has a floored divisor and
 * every spawn is finite-guarded at the boundary, where it can be tested.
 */

export type FxKind =
  | 'flash'
  | 'smoke'
  | 'spark'
  | 'splinter'
  | 'splash'
  | 'trail'
  /** the strike itself — brief and bright, the half a hit never had */
  | 'impactFlash'
  /** what a ball knocks out of oak: slow, brown, and it lingers for seconds */
  | 'impactSmoke'
  /** the vertical pillar a ball throws up out of the sea */
  | 'column'
  /** the vent puff off the BREECH — a muzzle-loader fires from both ends */
  | 'breech';

/**
 * Deterministic 0..1 hash of two integers (§V.2 — no Math.random reaches
 * the frame). This is what breaks the uniformity: every puff of powder
 * smoke draws its own size, speed and lifetime from (shot seed, particle
 * index), so two guns firing in the same volley throw visibly different
 * clouds and the same shot replays identically.
 */
export function hash01(a: number, b: number): number {
  let h = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x85ebca6b)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** hash01 remapped to [1-spread, 1+spread] — a multiplicative jitter */
export function jitterScale(a: number, b: number, spread: number): number {
  const s = Number.isFinite(spread) ? Math.max(0, Math.min(1, spread)) : 0;
  return 1 + (hash01(a, b) * 2 - 1) * s;
}

export interface FxProfile {
  /** seconds a particle of this kind lives (> 0) */
  life: number;
  /** metres, at birth → at death */
  sizeStart: number;
  sizeEnd: number;
  /** m/s² downward */
  gravity: number;
  /** 1/s exponential velocity bleed */
  drag: number;
  /** linear sRGB-authored tint, additive brightness at birth */
  color: [number, number, number];
  /** initial speed of the burst */
  speed: number;
  /** how much the burst spreads off its axis, 0 = a beam, 1 = a ball */
  spread: number;
  /**
   * TERMINAL RISE, m/s — what the parcel settles to climbing at, NOT a raw
   * buoyant acceleration. Parameterised this way on purpose: under linear
   * drag the steady rise is `buoyancy / drag`, so an acceleration knob
   * silently changes meaning every time `drag` moves, and the drag here is
   * doing real work (it is what stalls the muzzle jet). Quoting the speed
   * makes the knob mean what it says at any drag — §V.66, scale a feature by
   * its own dimension. Only meaningful with `drag > 0`.
   */
  riseSpeed: number;
  /**
   * 0..1 — how completely the parcel is carried by the moving air. Drag acts
   * on velocity RELATIVE TO THE WIND, so this is what makes a smoke bank blow
   * downwind across the deck instead of hanging where it was made. 0 for
   * anything with mass of its own: a splinter does not blow away.
   */
  windCoupling: number;
  /**
   * Exponent on the age fraction driving size. 1 = linear (every kind's
   * original behaviour, kept byte-identical). 0.5 = √t, the turbulent-puff
   * growth law: fast expansion while the eddies are energetic, tapering
   * after. Linear growth is what reads as a balloon inflating.
   */
  growthExp: number;
  /**
   * Multiplier on the additive brightness. §V.44 wants additive terms bounded
   * AT SOURCE, and this is where that bound lives: `brightnessAt` returns
   * [0,1] and `color` is [0,1] per channel, so peak output per channel is
   * exactly this number. Sanitized into [0, BOOST_MAX] when a profile is
   * built, so no params edit can push it past the bloom clamp.
   */
  boost: number;
}

/**
 * Ceiling on {@link FxProfile.boost}. Sits below `postParams.bloomClamp` (12)
 * on purpose: a particle may glare, it may not define the exposure.
 */
export const BOOST_MAX = 8;

/** §V.44: the additive bound, applied where the profile is built */
export function sanitizeBoost(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1;
  return Math.min(v, BOOST_MAX);
}

/** age → 0..1 normalized, with a floored divisor (§V.28) */
export function ageFraction(age: number, life: number): number {
  if (!Number.isFinite(age) || !Number.isFinite(life)) return 1;
  const t = age / Math.max(life, 1e-4);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * Sprite size at a normalized age. Dead particles return EXACTLY 0 — §V.28
 * requires dead particles to be zero-SIZE rather than merely transparent,
 * because an opacity-0 quad is still rasterized and still costs fill rate.
 */
export function sizeAt(profile: FxProfile, t: number): number {
  if (t >= 1) return 0;
  // growthExp 1 skips the pow entirely, so every kind that has not opted in
  // is not merely equivalent but takes the identical code path
  const g = profile.growthExp;
  const u = Number.isFinite(g) && g > 0 && g !== 1 ? Math.pow(Math.max(0, t), g) : t;
  const s = profile.sizeStart + (profile.sizeEnd - profile.sizeStart) * u;
  return Number.isFinite(s) && s > 0 ? s : 0;
}

/**
 * Per-particle aspect ratio, bounded to [1/ASPECT_MAX, ASPECT_MAX].
 *
 * WHY THIS EXISTS. A sprite is scaled uniformly, so its alpha falloff is a
 * disc and a burst of them is a cluster of discs — "not just circular puffs"
 * (user), and §V.65's shape: detail multiplied into a mask's INTERIOR leaves
 * the OUTLINE untouched and the eye reads the outline. Giving each particle
 * its own aspect and its own roll makes the cluster a union of ellipses at
 * differing angles, which is not a disc at any radius. It costs nothing in
 * the fragment shader — the whole change is in the vertex scale.
 *
 * Area-preserving by construction: the sprite is scaled `(s·a, s/a)`, so the
 * product is `s²` whatever `a` is, and the puff does not gain or lose mass
 * as it is stretched. `a` is bounded away from zero here so that the `s/a`
 * divisor is floored AT SOURCE (§V.28) rather than guarded at the use site.
 */
export const ASPECT_MAX = 2;

export function particleAspect(seed: number, index: number, spread: number): number {
  const s = Number.isFinite(spread) ? Math.min(1, Math.max(0, spread)) : 0;
  // exponential about 1 so stretch and squash are symmetric: a 2:1 wide puff
  // and a 2:1 tall one are equally far from round
  const e = (hash01(seed, index * 7 + 5) * 2 - 1) * s * Math.log(ASPECT_MAX);
  const a = Math.exp(e);
  return Math.min(ASPECT_MAX, Math.max(1 / ASPECT_MAX, a));
}

/** per-particle roll, radians — the other half of breaking the disc */
export function particleSpin(seed: number, index: number): number {
  return hash01(seed, index * 7 + 6) * Math.PI * 2;
}

/** additive brightness over life: quick bloom, then a fade to nothing */
export function brightnessAt(t: number): number {
  if (t >= 1 || t < 0) return 0;
  const rise = Math.min(1, t / 0.08); // floored: 0.08 is a literal, never 0
  return rise * (1 - t) * (1 - t);
}

/**
 * One particle step, semi-implicit Euler with exponential drag. Returns the
 * new velocity; caller integrates position with it (matching ballistics, so
 * a splinter and a cannonball obey the same integrator convention).
 */
export function stepVelocity(
  vx: number, vy: number, vz: number,
  profile: FxProfile,
  dt: number,
  windX = 0,
  windZ = 0,
): [number, number, number] {
  const drag = Math.max(0, profile.drag);
  const keep = Math.exp(-drag * dt);

  // DRAG ACTS ON VELOCITY RELATIVE TO THE AIR, not to the world. With
  // windCoupling 0 the air is still and this is exactly the old expression;
  // above 0 the parcel's horizontal velocity decays toward the WIND rather
  // than toward zero, which is what carries a broadside's smoke bank
  // downwind across the deck instead of leaving it hanging where it was made.
  const c = Number.isFinite(profile.windCoupling)
    ? Math.min(1, Math.max(0, profile.windCoupling))
    : 0;
  const wx = (Number.isFinite(windX) ? windX : 0) * c;
  const wz = (Number.isFinite(windZ) ? windZ : 0) * c;

  // `riseSpeed` is a terminal SPEED; the acceleration that produces it under
  // linear drag is speed x drag, which is why the two are multiplied here and
  // not stored apart. Steady state is then `riseSpeed - gravity/drag`, i.e.
  // exactly `riseSpeed` for a kind with no gravity of its own.
  const buoyancy = Math.max(0, nnz(profile.riseSpeed)) * drag;

  return [
    (vx - wx) * keep + wx,
    (vy - profile.gravity * dt + buoyancy * dt) * keep,
    (vz - wz) * keep + wz,
  ];
}

function nnz(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

/**
 * Deterministic unit burst direction around `axis`, index-keyed. Uses a
 * golden-angle spiral rather than an rng so the same event always throws the
 * same debris — cheap, and it replays identically for a netcode spectator.
 * `spread` 0 keeps every particle on the axis, 1 gives a full hemisphere.
 */
export function burstDirection(
  axis: readonly [number, number, number],
  index: number,
  spread: number,
): [number, number, number] {
  const ax = finite(axis[0]);
  const ay = finite(axis[1]);
  const az = finite(axis[2]);
  const len = Math.hypot(ax, ay, az);
  // a zero axis would divide to NaN and send a burst to Infinity
  const nx = len > 1e-6 ? ax / len : 0;
  const ny = len > 1e-6 ? ay / len : 1;
  const nz = len > 1e-6 ? az / len : 0;

  const s = clamp01(spread);
  if (s <= 0) return [nx, ny, nz];

  // orthonormal basis around the axis
  const helper: [number, number, number] = Math.abs(ny) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let ux = ny * helper[2] - nz * helper[1];
  let uy = nz * helper[0] - nx * helper[2];
  let uz = nx * helper[1] - ny * helper[0];
  const ul = Math.max(1e-6, Math.hypot(ux, uy, uz)); // floored divisor
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const vx = ny * uz - nz * uy;
  const vy = nz * ux - nx * uz;
  const vz = nx * uy - ny * ux;

  const golden = 2.399963229728653;
  const phi = index * golden;
  // deterministic radial stagger keeps a burst from banding into a ring
  const r = Math.sqrt(((index * 0.6180339887) % 1)) * s;
  const cone = Math.sqrt(Math.max(0, 1 - r * r));
  const cx = Math.cos(phi) * r;
  const cy = Math.sin(phi) * r;

  return [
    nx * cone + ux * cx + vx * cy,
    ny * cone + uy * cx + vy * cy,
    nz * cone + uz * cx + vz * cy,
  ];
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function finite(x: number): number {
  return Number.isFinite(x) ? x : 0;
}
