/**
 * §T.87 — THE MUZZLE CLOUD DID NOT READ, AND NEITHER DID THE IMPACT PUFF.
 *
 * User, in-game: "the smoke coming out at the barrel of the cannon on shot is
 * almost not visible at all … we definitely need a decent puff of smoke so
 * that it registers a cannon was fired. Impacts also still don't read."
 *
 * Every knob existed and none of them could fix it, because the smoke was
 * ADDITIVE (`alpha` 0): a 0.32-linear grey ADDED to a 1–3-linear sky hides
 * nothing, and a headless rasteriser of the shipped pool measured accumulated
 * OCCLUSION 0.000 for the whole life of both clouds. These tests assert the
 * cloud as the eye meets it — accumulated occlusion of a stack of sprites,
 * `1 − Π(1 − cover·alpha·fade)` — using the SAME per-sprite curves the shader
 * draws (`discCoverage` = the TSL `shape`, `brightnessAt` = the fade), driven
 * through the real pool at 60 Hz. §V.80: properties (a core that hides the
 * sea, a size, a lifetime, a drift bounded by the wind), never the numbers
 * that happen to produce them today.
 */
import { describe, expect, it } from 'vitest';
import { createCombatFx } from '../src/combat/combatFx';
import {
  brightnessAt, discCoverage, stackOcclusion,
} from '../src/combat/fxMath';
import { combatFxParams, combatParams } from '../src/params/combat';
import type { CombatFrame } from '../src/combat/combatSystem';
import type { ShipState } from '../src/state/simState';

const DT = 1 / 60;
const WIND = 10; // m/s true wind along +z; the gun fires along +x
const HALF_BEAM = 4.25;
const MUZZLE: [number, number, number] = [HALF_BEAM + combatParams.muzzleForward, 1.55, 0];
/** the ball's swept-sphere centre at first contact, `ballRadius` off the planking */
const HIT: [number, number, number] = [HALF_BEAM + combatParams.ballRadius, 1.2, 3];
const SHIP = {
  id: 'p', kind: 'player', position: [0, 0, 0], quaternion: [0, 0, 0, 1],
  velocity: [0, 0, 0], angularVelocity: [0, 0, 0],
} as unknown as ShipState;

interface Pool {
  position: Float32Array; color: Float32Array; size: Float32Array;
  alpha: Float32Array; kinds: string[];
}
interface Part { x: number; y: number; z: number; r: number; f: number; kind: string }

function emptyFrame(): CombatFrame {
  return { muzzles: [], hits: [], projectiles: [], destruction: [], detached: [] };
}

function rig() {
  const fx = createCombatFx(combatFxParams);
  const sprites = fx.group.getObjectByName('combat-sprites') as unknown as { userData: { fxPool: Pool } };
  return { fx, pool: sprites.userData.fxPool };
}

/** the live smoke sprites as discs: radius = size/2, f = the blender's alpha */
function parts(pool: Pool, kinds: ReadonlySet<string>): Part[] {
  const out: Part[] = [];
  for (let i = 0; i < pool.size.length; i++) {
    if (pool.size[i] <= 0 || !kinds.has(pool.kinds[i])) continue;
    out.push({
      x: pool.position[i * 3], y: pool.position[i * 3 + 1], z: pool.position[i * 3 + 2],
      r: pool.size[i] / 2, f: pool.alpha[i], kind: pool.kinds[i],
    });
  }
  return out;
}

/** accumulated occlusion at one point of the side (x–y) view */
function occlusionAt(ps: readonly Part[], x: number, y: number): number {
  const fr: number[] = [];
  for (const p of ps) {
    const d = Math.hypot(x - p.x, y - p.y);
    if (d < p.r) fr.push(discCoverage(d / p.r) * p.f);
  }
  return stackOcclusion(fr);
}

/** peak occlusion and the extent of the ≥0.1 region, sampled at 8 px/m */
function measure(ps: readonly Part[], cx: number, cy: number) {
  let peak = 0, minX = Infinity, maxX = -Infinity;
  for (let y = cy - 8; y <= cy + 12; y += 1 / 8) {
    for (let x = cx - 8; x <= cx + 16; x += 1 / 8) {
      const o = occlusionAt(ps, x, y);
      if (o > peak) peak = o;
      if (o >= 0.1) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
    }
  }
  return { peak, width: maxX > minX ? maxX - minX : 0 };
}

function centroidZ(ps: readonly Part[]): number {
  let s = 0, w = 0;
  for (const p of ps) { s += p.z * p.f; w += p.f; }
  return w > 0 ? s / w : NaN;
}

const MUZZLE_KINDS = new Set(['smoke']);
const IMPACT_KINDS = new Set(['impactSmoke']);

function fireOnce() {
  const { fx, pool } = rig();
  const f = emptyFrame();
  f.muzzles.push({ shipIndex: 0, socketId: 'g', position: MUZZLE, direction: [1, 0, 0], seed: 12345 });
  fx.emit(f, [], 0, [SHIP]);
  return { fx, pool };
}

function hitOnce() {
  const { fx, pool } = rig();
  const f = emptyFrame();
  f.hits.push({ shipIndex: 0, pieceId: 'hull-section-1', point: HIT, projectileId: 7, direction: [-0.9, -0.1, 0.42] });
  fx.emit(f, [], 0, [SHIP]);
  return { fx, pool };
}

function stepTo(fx: ReturnType<typeof rig>['fx'], seconds: number, from = 0): number {
  let t = from;
  while (t + 1e-9 < seconds) { fx.update(DT, [], undefined, 0, WIND); t += DT; }
  return t;
}

describe('§T.87 the muzzle cloud HIDES the sea behind it', () => {
  it('has an opaque core by 0.5 s — accumulated occlusion ≥ 0.7', () => {
    // THE defect: additive smoke measured 0.000 here at every t. Whatever
    // the tint, a cloud that cannot occlude is not a cloud.
    const { fx, pool } = fireOnce();
    stepTo(fx, 0.5);
    const m = measure(parts(pool, MUZZLE_KINDS), MUZZLE[0], MUZZLE[1]);
    expect(m.peak).toBeGreaterThanOrEqual(0.7);
  });

  it('is a FAT cloud by 0.5 s — the ≥0.1 region spans ≥ 4 m', () => {
    const { fx, pool } = fireOnce();
    stepTo(fx, 0.5);
    const m = measure(parts(pool, MUZZLE_KINDS), MUZZLE[0], MUZZLE[1]);
    expect(m.width).toBeGreaterThanOrEqual(4);
  });

  it('is still visible at 2.5 s (peak ≥ 0.15) — a puff that is gone in a second did not register', () => {
    const { fx, pool } = fireOnce();
    stepTo(fx, 2.5);
    const m = measure(parts(pool, MUZZLE_KINDS), MUZZLE[0], MUZZLE[1]);
    expect(m.peak).toBeGreaterThanOrEqual(0.15);
  });

  it('drifts DOWNWIND at a fraction of the true wind — never faster than the air, never stuck', () => {
    // The fx are simulated in the WORLD frame on `state.wind` (the true
    // wind), which is the right frame: a cloud at sea level is not in the
    // ship's apparent wind, the ship leaves it behind. Coupled at 0.7 it was
    // 5.7 m from the muzzle at 1 s and 12.7 m at 2 s — carried off before it
    // had billowed. Property: between 1 s and 2 s it moves downwind, and by
    // less than the air does.
    const { fx, pool } = fireOnce();
    stepTo(fx, 1);
    const z1 = centroidZ(parts(pool, MUZZLE_KINDS));
    stepTo(fx, 2, 1);
    const z2 = centroidZ(parts(pool, MUZZLE_KINDS));
    const drift = z2 - z1; // m in 1 s
    expect(drift).toBeGreaterThan(0.5);
    expect(drift).toBeLessThan(WIND * 0.6);
  });

  it('is lit warm by the flash for its first frames, then neutral', () => {
    const { fx, pool } = fireOnce();
    fx.update(DT, [], undefined, 0, 0);
    const warmth = (): number => {
      let r = 0, b = 0;
      for (let i = 0; i < pool.size.length; i++) {
        if (pool.kinds[i] !== 'smoke' || pool.size[i] <= 0) continue;
        r += pool.color[i * 3]; b += pool.color[i * 3 + 2];
      }
      return r / Math.max(1e-9, b);
    };
    const early = warmth();
    stepTo(fx, 0.5, DT);
    const late = warmth();
    expect(early).toBeGreaterThan(late * 1.3);
    // and neutral means SETTLED: no residual heat past the window, so the
    // ratio at 0.5 s is the ratio at 1 s exactly (the fade scales r and b alike)
    stepTo(fx, 1, 0.5);
    expect(warmth()).toBeCloseTo(late, 6);
  });
});

describe('§T.87 the impact throws a DUST cloud off the hull', () => {
  it('is born OUTSIDE the planking, a hand along the outward normal', () => {
    // `hit.point` is the swept-sphere centre at first contact: a sprite
    // centred there has its hull-side half depth-clipped at a grazing view
    const { pool } = hitOnce();
    let n = 0;
    for (let i = 0; i < pool.size.length; i++) {
      if (pool.kinds[i] !== 'impactSmoke') continue;
      // not yet stepped: positions are the spawn points
      const dx = pool.position[i * 3] - HIT[0];
      const dy = pool.position[i * 3 + 1] - HIT[1];
      const dz = pool.position[i * 3 + 2] - HIT[2];
      // outboard (+x is away from the hull's centreline here) …
      expect(dx).toBeGreaterThan(0);
      // … by the full standoff along the normal
      expect(Math.hypot(dx, dy, dz)).toBeCloseTo(combatFxParams.impactStandoff, 6);
      n++;
    }
    expect(n).toBe(combatFxParams.impactSmokePerHit);
  });

  it('is ≥ 2.5 m across with an opaque core by 0.5 s', () => {
    const { fx, pool } = hitOnce();
    stepTo(fx, 0.5);
    const m = measure(parts(pool, IMPACT_KINDS), HIT[0], HIT[1]);
    expect(m.width).toBeGreaterThanOrEqual(2.5);
    expect(m.peak).toBeGreaterThanOrEqual(0.7);
  });

  it('hangs ~2 s: still there at 2 s, gone by 3.5 s', () => {
    const { fx, pool } = hitOnce();
    stepTo(fx, 2);
    expect(measure(parts(pool, IMPACT_KINDS), HIT[0], HIT[1]).peak).toBeGreaterThanOrEqual(0.15);
    stepTo(fx, 3.5, 2);
    expect(measure(parts(pool, IMPACT_KINDS), HIT[0], HIT[1]).peak).toBeLessThan(0.15);
  });

  it('is dust-coloured — warmer than the powder smoke, so the two ends of a shot differ', () => {
    const tintOf = (pool: Pool, kind: string): [number, number, number] => {
      for (let i = 0; i < pool.size.length; i++) {
        if (pool.kinds[i] === kind && pool.size[i] > 0) {
          return [pool.color[i * 3], pool.color[i * 3 + 1], pool.color[i * 3 + 2]];
        }
      }
      throw new Error(`no live ${kind}`);
    };
    // one second in: past the flash-heat window, so the powder tint is neutral
    const hit = hitOnce(); stepTo(hit.fx, 1);
    const shot = fireOnce(); stepTo(shot.fx, 1);
    const dust = tintOf(hit.pool, 'impactSmoke');
    const powder = tintOf(shot.pool, 'smoke');
    // warmer = higher red:blue ratio
    expect(dust[0] / dust[2]).toBeGreaterThan(powder[0] / powder[2] * 1.15);
  });
});

describe('§T.87 the fade curve and the budget', () => {
  it('`linger` 1 is the original curve exactly, and a held fade is higher mid-life, zero at death', () => {
    for (let t = 0; t <= 1; t += 0.01) {
      expect(brightnessAt(t, 1)).toBe(brightnessAt(t));
      if (t > 0.1 && t < 1) expect(brightnessAt(t, 2)).toBeGreaterThan(brightnessAt(t, 1));
    }
    expect(brightnessAt(1, 2)).toBe(0);
    expect(brightnessAt(0.999, 3)).toBeLessThan(0.01);
    // bounded at source (§V.44): a held fade never exceeds 1
    for (let t = 0; t <= 1; t += 0.01) expect(brightnessAt(t, 2.5)).toBeLessThanOrEqual(1);
  });

  it('a stack of sprites occludes more than any one of them, never above 1, and additive (f=0) occludes nothing', () => {
    expect(stackOcclusion([0, 0, 0])).toBe(0);
    expect(stackOcclusion([0.5])).toBeCloseTo(0.5);
    expect(stackOcclusion([0.5, 0.5])).toBeCloseTo(0.75);
    expect(stackOcclusion([1, 0.5])).toBe(1);
    expect(discCoverage(0)).toBe(1);
    expect(discCoverage(1)).toBe(0);
    expect(discCoverage(0.5)).toBeGreaterThan(discCoverage(0.8));
  });

  it('a full broadside of 8 guns plus 4 hits stays inside the pool with nothing evicted', () => {
    const { fx, pool } = rig();
    const f = emptyFrame();
    for (let g = 0; g < 8; g++) {
      f.muzzles.push({ shipIndex: 0, socketId: `g${g}`, position: [MUZZLE[0], MUZZLE[1], g * 4 - 14], direction: [1, 0, 0], seed: 100 + g });
    }
    for (let h = 0; h < 4; h++) {
      f.hits.push({ shipIndex: 0, pieceId: `hull-section-${h}`, point: [HIT[0], HIT[1], h * 5 - 8], projectileId: 50 + h, direction: [-1, 0, 0] });
    }
    fx.emit(f, [], 0, [SHIP]);
    fx.update(DT, [], undefined, 0, 0);
    const p = combatFxParams;
    const perGun = 1 + p.smokePerShot + p.breechPerShot + p.sparksPerShot;
    const perHit = 1 + p.debrisPerHit + p.impactSmokePerHit;
    const expected = 8 * perGun + 4 * perHit;
    let live = 0;
    for (let i = 0; i < pool.size.length; i++) if (pool.size[i] > 0) live++;
    // every spawned sprite is alive after one frame: the rotating pool did
    // not wrap onto its own burst
    expect(live).toBe(expected);
    expect(expected).toBeLessThan(p.particleCount);
    // and with the worst case on top — every one of the 8 balls also
    // splashing — there is still headroom
    const perSplash = p.columnPerHit + p.crownPerHit + p.splashPerHit;
    expect(expected + 8 * perSplash).toBeLessThan(p.particleCount);
  });
});
