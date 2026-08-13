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
  });
  return {
    flash: blank('flash'),
    smoke: blank('smoke'),
    spark: blank('spark'),
    splinter: blank('splinter'),
    splash: blank('splash'),
    trail: blank('trail'),
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
  set(dst.smoke, {
    life: pos(p.smokeLife, 2.4), sizeStart: pos(p.smokeSize, 1.1),
    sizeEnd: pos(p.smokeSize, 1.1) * pos(p.smokeGrowth, 4.5),
    gravity: -0.6, drag: 1.6, speed: nn(p.smokeSpeed, 7), spread: 0.4, boost: 1,
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
  set(dst.impactSmoke, {
    life: pos(p.impactSmokeLife, 3.4), sizeStart: pos(p.impactSmokeSize, 0.65),
    sizeEnd: pos(p.impactSmokeSize, 0.65) * pos(p.impactSmokeGrowth, 6),
    // buoyant, so the puff drifts UP off the strike and stays readable
    // against the hull instead of sliding down it
    gravity: -0.5, drag: 1.2, speed: nn(p.impactSmokeSpeed, 3.5),
    spread: 0.55, boost: 1,
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

/** in-place field copy; `color` is deliberately untouched (shared constant) */
function set(dst: FxProfile, src: Omit<FxProfile, 'color'>): void {
  dst.life = src.life;
  dst.sizeStart = src.sizeStart;
  dst.sizeEnd = src.sizeEnd;
  dst.gravity = src.gravity;
  dst.drag = src.drag;
  dst.speed = src.speed;
  dst.spread = src.spread;
  dst.boost = src.boost;
}

function pos(v: number, fallback: number): number {
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function nn(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}
