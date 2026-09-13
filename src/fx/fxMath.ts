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
  /**
   * The CROWN — the wall of water that lifts off the rim of the cavity and
   * falls back outward. It is what separates a real water entry from a puff
   * hung in the air: the column goes up the middle, the crown opens around it,
   * and the two collapse on different clocks.
   */
  | 'crown'
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
  /**
   * 0..1 — HOW OPAQUE the particle is, i.e. how much it hides what is behind
   * it. 0 is pure additive light and is the default, so every kind that does
   * not name it is bit-identical to what it was before this field existed
   * (see combatFx's blend note: at alpha 0 the custom blend function reduces
   * exactly to three's AdditiveBlending).
   *
   * WHY WATER NEEDS IT. Additive is a light model: it can only ever brighten
   * what is behind it, so an additive sprite over the sea reads as a glow
   * LATCHED ON TOP of the water rather than as water in front of it — and it
   * vanishes entirely against a bright sky, which is precisely where a splash
   * column is silhouetted. Powder smoke and muzzle flash genuinely are light
   * and stay at 0; aerated water is a substance and does not.
   */
  alpha: number;
  /**
   * ≥ 1 — how long the fade HOLDS before it lets go (see `brightnessAt`).
   * Optional and defaulting to 1 so every kind that does not name it keeps
   * the original `(1 − t)²` curve on the identical code path.
   */
  linger?: number;
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

/**
 * Ceiling on a SPLINTER's length:width ratio.
 *
 * Deliberately far above {@link ASPECT_MAX}, and the two are not the same
 * knob wearing different names. `ASPECT_MAX` = 2 bounds how far a puff of
 * SMOKE may deviate from round, and round is the correct base shape there —
 * the stretch only exists to stop a cluster of them reading as a cluster of
 * discs (§V.65). A splinter's base shape is not round at all: a shard blown
 * out of a plank is a SLIVER, and a 2:1 sliver still reads as a blob. 6:1 is
 * the ratio at which the silhouette stops being ambiguous.
 */
export const SPLINTER_ASPECT_MAX = 6;

/**
 * Length:width of one splinter, always ≥ 1 (long, never squat).
 *
 * `particleAspect` is symmetric about 1 on purpose — a squashed puff and a
 * stretched one are equally valid smoke. A squashed SPLINTER is not a
 * splinter, it is a chip, so this is one-sided: every shard is at least as
 * long as it is wide, and `ratio` sets how long the longest may be.
 *
 * AREA IS PRESERVED, exactly as it is for smoke: combatFx scales the sprite
 * `(s·a, s/a)`, so a 6:1 shard at `splinterSize` 0.3 is 1.8 m × 0.05 m and
 * carries the same footprint as the 0.3 m disc it replaces. That is the
 * reason the ratio is bounded rather than free — the `s/a` divisor is floored
 * AT SOURCE (§V.28) and, just as importantly, an unbounded ratio would thin
 * the shard below one pixel and delete it at exactly the moment it got
 * longest.
 */
export function splinterAspect(seed: number, index: number, ratio: number): number {
  const r = Number.isFinite(ratio)
    ? Math.min(SPLINTER_ASPECT_MAX, Math.max(1, ratio))
    : 1;
  // biased toward the LONG end: a burst of shards should read as slivers with
  // a few stubs in it, not as a uniform spread from chip to needle
  const u = hash01(seed, index * 7 + 8);
  return 1 + (r - 1) * (0.35 + 0.65 * u);
}

/**
 * Tumble rate for one splinter, rad/s, signed — a shard blown off a plank
 * spins, and a burst of them spins BOTH WAYS.
 *
 * A sprite that holds one roll angle for its whole life reads as a decal
 * sliding through the air, which is precisely why the elongation alone is not
 * enough: stretching a sprite without rotating it trades one static shape for
 * another. The rate is deterministic in (seed, index) like every other draw
 * here, so a replay tumbles identically (§V.2).
 */
export function splinterTumble(seed: number, index: number, rate: number): number {
  const r = Number.isFinite(rate) ? Math.max(0, rate) : 0;
  // exact +0, not the -0 the sign branch below would produce half the time.
  // combatFx gates its whole tumble path on `spin !== 0` and JS compares -0
  // equal to 0, so this is not load-bearing for the skip — it is load-bearing
  // for the TEST that proves the skip, and a property that can only be
  // asserted with Object.is is a property nobody will keep asserting.
  if (r === 0) return 0;
  // ±rate, with a floor on |spin| so no shard is frozen while its neighbours
  // turn — a stationary one in a spinning burst reads as a stuck sprite
  const s = hash01(seed, index * 7 + 9) * 2 - 1;
  return (s < 0 ? -1 : 1) * (0.25 + 0.75 * Math.abs(s)) * r;
}

/**
 * Brightness/coverage over life: quick bloom, then a fade to nothing.
 *
 * `linger` ≥ 1 holds the fade up before it lets go: the curve is
 * `(1 − t^linger)²`, so at 1 it is EXACTLY the original `(1 − t)²` and takes
 * the identical code path. Powder smoke needs it because `(1 − t)²` is a
 * FLASH curve — it is at a quarter by half-life and under 5% at 0.78, which
 * on a 3.2 s puff means the cloud is gone from the screen by ~1.5 s while
 * the pool is still stepping it. A 0.08 rise keeps a newborn from popping.
 */
export function brightnessAt(t: number, linger = 1): number {
  if (t >= 1 || t < 0) return 0;
  const rise = Math.min(1, t / 0.08); // floored: 0.08 is a literal, never 0
  const l = Number.isFinite(linger) && linger > 1 ? linger : 1;
  const u = l === 1 ? t : Math.pow(t, l);
  return rise * (1 - u) * (1 - u);
}

/**
 * The sprite's radial falloff exponent: the fragment shader's `shape` is
 * `(1 − |q|²)^DISC_FALLOFF_POW`, q ∈ [−1,1] across the quad. Owned HERE and
 * imported by the TSL call-site in combatFx so the CPU coverage mirror below
 * (used by the headless rasteriser and its tests) cannot drift from what is
 * drawn (§V.77).
 */
export const DISC_FALLOFF_POW = 1.5;

/**
 * Coverage of one sprite at normalised radius `r` (0 at the centre, 1 at the
 * quad's edge = half its `size`). The CPU twin of the shader's `shape`.
 */
export function discCoverage(r: number): number {
  if (!Number.isFinite(r)) return 0;
  const q = 1 - r * r;
  return q <= 0 ? 0 : Math.pow(q, DISC_FALLOFF_POW);
}

/**
 * Accumulated OCCLUSION of a stack of source-over fragments at one pixel:
 * `1 − Π(1 − fᵢ)` where each fᵢ is `cover·alpha·fade`. This is the blender's
 * `dst·(1 − f)` applied in sequence, so it is the number that says how much
 * of the sea/sky behind a cloud survives — an additive sprite has f = 0 and
 * contributes NOTHING here however bright it is, which is the whole
 * diagnosis of "the smoke is almost not visible".
 */
export function stackOcclusion(fractions: ArrayLike<number>): number {
  let keep = 1;
  for (let i = 0; i < fractions.length; i++) {
    const f = fractions[i];
    if (Number.isFinite(f) && f > 0) keep *= 1 - Math.min(1, f);
  }
  return 1 - keep;
}

/**
 * Warm FLASH TINT weight for fresh powder smoke: 1 at birth, 0 after
 * `window` seconds. The first puffs out of the bore are lit by the muzzle
 * flash from inside; without it the smoke is a grey cloud that appears in
 * the same frame as an orange flash and reads as two unrelated sprites.
 */
export function heatAt(age: number, window: number): number {
  if (!Number.isFinite(age) || !Number.isFinite(window) || window <= 0) return 0;
  const w = 1 - age / window;
  return w < 0 ? 0 : w > 1 ? 1 : w;
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

/**
 * Direction for one droplet of the CROWN — the sheet that lifts off the rim of
 * the cavity a ball punches in the sea.
 *
 * Deliberately NOT `burstDirection`: that fills a cone, so its particles are
 * densest ON the axis, which is how you get another round puff. A crown is a
 * SHEET — every droplet is at the same tilt off vertical and they differ only
 * in azimuth — so the silhouette is an open wall with a hole up the middle,
 * and the column is what fills that hole. §V.65: the eye reads the outline,
 * and the outline is the whole difference between a crown and a puff.
 *
 * `tilt` is radians off vertical (0 = straight up, π/2 = flat outward).
 * Azimuth is index/count plus a golden-angle stagger, so a low droplet count
 * still spreads instead of banding, and `jitter` breaks the perfect circle a
 * regular polygon would otherwise read as.
 */
export function crownDirection(
  index: number,
  count: number,
  tilt: number,
  seed = 0,
  jitter = 0,
): [number, number, number] {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
  const t = Number.isFinite(tilt) ? Math.min(Math.PI * 0.5, Math.max(0, tilt)) : 0.9;
  const j = clamp01(jitter);
  // even azimuth first (the sheet), then a bounded per-droplet wobble
  const phi = ((index % n) / n) * Math.PI * 2
    + (hash01(seed, index * 5 + 21) * 2 - 1) * j * (Math.PI / n);
  // per-droplet tilt spread: a real crown's rim is ragged, and a rim of
  // identical tilt reads as a cone of revolution — a shape, not water
  const tj = t * (1 + (hash01(seed, index * 5 + 22) * 2 - 1) * j * 0.45);
  const st = Math.sin(tj);
  return [Math.cos(phi) * st, Math.cos(tj), Math.sin(phi) * st];
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function finite(x: number): number {
  return Number.isFinite(x) ? x : 0;
}
