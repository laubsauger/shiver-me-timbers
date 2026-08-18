/**
 * Per-kind particle recipes for the combat fx pool.
 *
 * Split out of combatFx.ts when the hull-impact kinds landed: that file is
 * the buffer-filling shell and this is the LOOK, and §C's ~250-line cap was
 * already spent on the shell alone.
 *
 * REFILLED IN PLACE, never reallocated. `update()` rebuilds these every
 * rendered frame so a Tweakpane edit shows up live (§V.16), and at nine
 * kinds a fresh record per frame is nine objects and nine arrays of GC churn
 * for values that usually did not change. `fillProfiles` writes into a
 * caller-owned record instead; the tint arrays are module constants and are
 * never mutated, so they can be shared by reference.
 *
 * §V.31: every tint is authored sRGB and enters through THREE.Color — a bare
 * setRGB writes the LINEAR working space and lands ~2x too bright (§B.9).
 * §V.44: `boost` is the additive bound and it is applied HERE, at the source,
 * rather than clamped after the multiply.
 */
import * as THREE from 'three/webgpu';
import type { CombatFxParams } from '../params/combat';
import { sanitizeBoost, type FxKind, type FxProfile } from './fxMath';

/** §V.31: sRGB-authored tints enter through THREE.Color, never bare setRGB */
const TINTS: Record<FxKind, THREE.Color> = {
  flash: new THREE.Color(0xffd08a),
  smoke: new THREE.Color(0x9a958c),
  // burning powder grains: hotter and far more saturated than the smoke they
  // fly through, which is the only reason they read at all against it
  spark: new THREE.Color(0xffa53a),
  splinter: new THREE.Color(0xa97c4e),
  splash: new THREE.Color(0xcfe6e2),
  // the vent puff: the same powder as the muzzle bank, and it must read as
  // the same substance, so it shares the tint and differs only in scale
  breech: new THREE.Color(0x9a958c),
  // the ball's own wake: thin, cool, and DIM on purpose — a bright trail
  // turns a wooden-ship demo into science fiction
  trail: new THREE.Color(0x6f7a80),
  // iron on oak, not powder igniting: whiter and harder than the muzzle
  // bloom, so a hit does not read as a second gun going off on the target
  impactFlash: new THREE.Color(0xffe9c4),
  // oak dust, distinctly BROWNER than powder smoke — the two appear at
  // opposite ends of the same shot and must not read as the same cloud
  impactSmoke: new THREE.Color(0x8a7f70),
  // the pillar is aerated water: brighter and greener than the droplets that
  // detach off its top, which are already thinning toward spray
  column: new THREE.Color(0xdaeeea),
};

/** shared by reference — profiles read `color`, nothing writes it */
const RGB: Record<FxKind, [number, number, number]> = Object.fromEntries(
  Object.entries(TINTS).map(([k, c]) => [k, [c.r, c.g, c.b]]),
) as Record<FxKind, [number, number, number]>;

/** an empty record to be filled — allocated once per fx instance */
export function createProfiles(): Record<FxKind, FxProfile> {
  const blank = (kind: FxKind): FxProfile => ({
    life: 1,
    sizeStart: 1,
    sizeEnd: 1,
    gravity: 0,
    drag: 0,
    color: RGB[kind],
    speed: 0,
    spread: 0,
    boost: 1,
    riseSpeed: 0,
    windCoupling: 0,
    growthExp: 1,
  });
  return {
    flash: blank('flash'),
    smoke: blank('smoke'),
    spark: blank('spark'),
    splinter: blank('splinter'),
    splash: blank('splash'),
    trail: blank('trail'),
    breech: blank('breech'),
    impactFlash: blank('impactFlash'),
    impactSmoke: blank('impactSmoke'),
    column: blank('column'),
  };
}

/** overwrite `dst` from the live params. Returns `dst` for convenience. */
export function fillProfiles(
  dst: Record<FxKind, FxProfile>,
  p: CombatFxParams,
): Record<FxKind, FxProfile> {
  const boost = sanitizeBoost(p.flashBoost);

  set(dst.flash, {
    life: pos(p.flashLife, 0.09), sizeStart: pos(p.flashSize, 2.2),
    sizeEnd: pos(p.flashSize, 2.2) * 0.4, gravity: 0, drag: 6,
    speed: 2, spread: 0.35, boost,
  });
  // POWDER SMOKE, in the three phases the user described ("smoke balls
  // bellow out and then that kinda moves towards the top"). They are not
  // three mechanisms — they are one set of numbers whose timescales separate:
  //
  //   JET     0 → ~0.25 s   speed 14 m/s along the barrel against drag 4.5
  //                         (tau = 0.22 s), so it throws ~2 m and stalls.
  //   BILLOW  ~0.25 → ~1 s  horizontal motion spent; size is still climbing
  //                         fastest here because growth is sqrt(t).
  //   RISE    ~1 s → end    all that is left is riseSpeed, and the parcel is
  //                         now moving with the air, so it lifts and drifts.
  //
  // The phases OVERLAP in time and still read in sequence, because early on
  // the jet (14 m/s) is 7x the rise (2 m/s) and drowns it; once the jet is
  // spent the rise is the only motion left. That is why no ramp, no timer and
  // no second emitter is needed to get "and then".
  //
  // gravity 0 rather than the old -0.6: buoyancy is now `riseSpeed`, which
  // states the steady climb directly instead of hiding it in a ratio against
  // drag. The old pair gave a terminal rise of 0.6/1.6 = 0.37 m/s, and at the
  // drag needed to stall a jet it would have been 0.13 m/s — the smoke could
  // not have risen at any setting of the knobs that existed.
  set(dst.smoke, {
    life: pos(p.smokeLife, 3.2), sizeStart: pos(p.smokeSize, 0.8),
    sizeEnd: pos(p.smokeSize, 0.8) * pos(p.smokeGrowth, 7),
    gravity: 0, drag: nn(p.smokeDrag, 4.5), speed: nn(p.smokeSpeed, 14),
    spread: 0.3, boost: 1,
    riseSpeed: nn(p.smokeRiseSpeed, 2), windCoupling: nn(p.smokeWind, 0.7),
    growthExp: pos(p.smokeGrowthExp, 0.5),
  });
  set(dst.spark, {
    life: pos(p.sparkLife, 0.4), sizeStart: pos(p.sparkSize, 0.14),
    sizeEnd: pos(p.sparkSize, 0.14) * 0.3, gravity: 9.81, drag: 1.1,
    speed: nn(p.sparkSpeed, 24), spread: 0.45, boost: 1,
  });
  set(dst.trail, {
    life: pos(p.trailLife, 0.5), sizeStart: pos(p.trailSize, 0.22),
    sizeEnd: pos(p.trailSize, 0.22) * pos(p.trailGrowth, 3.2),
    gravity: -0.2, drag: 2.5, speed: 0.6, spread: 1, boost: 1,
  });
  set(dst.splinter, {
    life: pos(p.splinterLife, 1.1), sizeStart: pos(p.splinterSize, 0.28),
    sizeEnd: pos(p.splinterSize, 0.28) * 0.5, gravity: 9.81, drag: 0.4,
    speed: nn(p.splinterSpeed, 9), spread: 0.85, boost: 1,
  });
  set(dst.splash, {
    life: pos(p.splashLife, 1), sizeStart: pos(p.splashSize, 1.4),
    sizeEnd: pos(p.splashSize, 1.4) * 2.2, gravity: 9.81, drag: 0.9,
    speed: nn(p.splashSpeed, 6), spread: 0.5, boost: 1,
  });

  // --- the hull impact ---------------------------------------------------
  // drag 7 on the flash and 1.2 on the smoke is the timescale contrast made
  // mechanical: the flash is gone before it has travelled its own radius,
  // the smoke coasts out and then hangs.
  set(dst.impactFlash, {
    life: pos(p.impactFlashLife, 0.07), sizeStart: pos(p.impactFlashSize, 1.5),
    sizeEnd: pos(p.impactFlashSize, 1.5) * 0.35, gravity: 0, drag: 7,
    speed: 3, spread: 0.5, boost,
  });
  // the same three phases as powder smoke, but knocked OUT of oak rather than
  // jetted out of a barrel: a slower, wider spray and a gentler climb
  set(dst.impactSmoke, {
    life: pos(p.impactSmokeLife, 3.4), sizeStart: pos(p.impactSmokeSize, 0.65),
    sizeEnd: pos(p.impactSmokeSize, 0.65) * pos(p.impactSmokeGrowth, 6),
    gravity: 0, drag: 3, speed: nn(p.impactSmokeSpeed, 5),
    spread: 0.55, boost: 1,
    riseSpeed: nn(p.impactSmokeRise, 1.2), windCoupling: nn(p.smokeWind, 0.7) * 0.8,
    growthExp: pos(p.smokeGrowthExp, 0.5),
  });

  // BREECH VENT. A muzzle-loader fires through the vent as well as the
  // muzzle, and the vent puff is the tell that separates a cannon from a
  // firework: smaller, sharper, straight up off the breech, gone quickly.
  set(dst.breech, {
    life: pos(p.breechLife, 1.4), sizeStart: pos(p.breechSize, 0.3),
    sizeEnd: pos(p.breechSize, 0.3) * pos(p.breechGrowth, 5),
    gravity: 0, drag: 5, speed: nn(p.breechSpeed, 6), spread: 0.28, boost: 1,
    riseSpeed: nn(p.breechRise, 2.6), windCoupling: nn(p.smokeWind, 0.7),
    growthExp: pos(p.smokeGrowthExp, 0.5),
  });

  // --- the water column --------------------------------------------------
  // spread 0.12 is what makes it a PILLAR and not another round puff: the
  // burst stays on its axis, and gravity brings it back down as a plume.
  set(dst.column, {
    life: pos(p.columnLife, 0.95), sizeStart: pos(p.columnSize, 0.5),
    sizeEnd: pos(p.columnSize, 0.5) * pos(p.columnGrowth, 2.4),
    gravity: 9.81, drag: 0.35, speed: nn(p.columnSpeed, 15),
    spread: 0.12, boost: 1,
  });

  return dst;
}

/**
 * In-place field copy; `color` is deliberately untouched (shared constant).
 *
 * The three air fields default to NEUTRAL — `riseSpeed` 0, `windCoupling` 0,
 * `growthExp` 1 — so a kind that does not name them behaves exactly as it did
 * before they existed, and `stepVelocity`/`sizeAt` take their original code
 * paths rather than merely equivalent ones. Only the smoke kinds opt in, and
 * you can see which by reading this file.
 */
type ProfileFields = Omit<FxProfile, 'color' | 'riseSpeed' | 'windCoupling' | 'growthExp'>
  & Partial<Pick<FxProfile, 'riseSpeed' | 'windCoupling' | 'growthExp'>>;

function set(dst: FxProfile, src: ProfileFields): void {
  dst.life = src.life;
  dst.sizeStart = src.sizeStart;
  dst.sizeEnd = src.sizeEnd;
  dst.gravity = src.gravity;
  dst.drag = src.drag;
  dst.speed = src.speed;
  dst.spread = src.spread;
  dst.boost = src.boost;
  dst.riseSpeed = src.riseSpeed ?? 0;
  dst.windCoupling = src.windCoupling ?? 0;
  dst.growthExp = src.growthExp ?? 1;
}

function pos(v: number, fallback: number): number {
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function nn(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}
