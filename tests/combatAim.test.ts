/**
 * THE GUNS MUST SHOOT AT THE SEA, NOT AT THE SKY (§T.16 aim).
 *
 * User, verbatim: "I guess we need some sort of way to aim our cannons,
 * right? Right now they're shooting just like super high in the sky and I
 * don't know if there's anything I can do against it."
 *
 * MEASURED, in the browser, through the real runtime before anything was
 * changed: muzzle direction y = 0.570 → 34.8° above horizontal on every gun of
 * the broadside, apex 36.1 m, splash 137.8 m away after ~5 s of flight.
 *
 * THE CAUSE was not the launch math. `combatRuntime.layGuns` auto-lays any
 * fire order that carries no explicit elevation, aiming at the NEAREST OTHER
 * SHIP; the player's order never carried one, so her guns were laid for the
 * enemy galleon — 1014 m off at spawn, against a measured maximum range of
 * 133.6 m — and `elevationForRange` returned the `maxElevation` clamp every
 * single shot, whatever the player was looking at.
 *
 * These tests are written against the REPORT, not the mechanism (§Rule 6):
 * they fire through the same runtime main.ts drives and assert where the ball
 * ends up. Deleting layGuns, rewriting it, or replacing the aim module with
 * something else entirely keeps them meaningful — they only go green when a
 * gun laid by the player puts its ball in the water at a range a gunner would
 * recognise.
 */
import { describe, expect, it } from 'vitest';
import type { Material } from 'three';
import { SIM_DT } from '../src/core/loop';
import { createInitialState, type ShipState, type SimState } from '../src/state/simState';
import { buildGalleonBlueprint } from '../src/ship/shipBlueprint';
import { ShipAssembly } from '../src/ship/shipAssembly';
import { createCombatRuntime } from '../src/combat/combatRuntime';
import { buildBattery, batterySide } from '../src/combat/battery';
import { clampElevation, createAim, muzzleLay, predictImpact } from '../src/combat/aim';
import { combatParams } from '../src/params/combat';
import type { FireOrder } from '../src/combat/combatSystem';

/**
 * 1014 m apart, and that distance is the whole point: past the 133.6 m a ball
 * can reach, so `layGuns` must not answer with the maxElevation clamp.
 *
 * This WAS the shipped pair — the lagoon berth against the hardcoded enemy
 * spawn (36c5a8d). The enemy's berth is derived now (src/ai/enemySpawn.ts) and
 * comes out 150-220 m away, so the game no longer produces this geometry at
 * boot. The guard is kept, and kept at this range, because the FAILURE it
 * pins is "an out-of-range solution silently becomes a mortar shot" and that
 * is reachable from any range the player can open up by sailing away.
 */
const PLAYER_SPAWN: [number, number] = [1129.5, 232.1];
const ENEMY_SPAWN: [number, number] = [190, -150];

const stub = (): Material => ({ dispose(): void {} }) as unknown as Material;

function makeShip(id: string, x: number, z: number, kind: ShipState['kind']): ShipState {
  return {
    id,
    kind,
    position: [x, 0, z],
    quaternion: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    rudder: 0,
    sailTrim: 0.7,
    flood: 0,
    damage: {},
  };
}

interface Rig {
  state: SimState;
  runtime: ReturnType<typeof createCombatRuntime>;
}

function rig(): Rig {
  const state = createInitialState(1337);
  state.ships.push(makeShip('player', PLAYER_SPAWN[0], PLAYER_SPAWN[1], 'player'));
  state.ships.push(makeShip('enemy-1', ENEMY_SPAWN[0], ENEMY_SPAWN[1], 'enemy'));
  const assemblies = state.ships.map(() => new ShipAssembly(buildGalleonBlueprint(), stub));
  assemblies.forEach((a, i) => {
    a.group.position.fromArray(state.ships[i].position);
    a.group.updateMatrixWorld(true);
  });
  const runtime = createCombatRuntime({
    ships: assemblies.map((assembly, shipIndex) => ({
      shipIndex,
      blueprint: buildGalleonBlueprint(),
      assembly,
    })),
    waterHeightAt: () => 0,
    audio: null,
  });
  return { state, runtime };
}

interface Volley {
  /** rad above horizontal each gun actually left at */
  launchElevations: number[];
  /** highest any ball of this volley climbed, m above the sea */
  apex: number;
  /** horizontal m from the ship to the first splash */
  firstSplashRange: number | null;
  splashes: number;
  balls: number;
}

/**
 * Run `body` with the per-shot aim jitter switched off. Spread is ±0.86° and
 * moves the fall point by metres — real, wanted, and noise for any assertion
 * about WHERE a given lay puts the ball. The param is restored afterwards so
 * no other test inherits a spread-free world.
 */
function withoutSpread<T>(body: () => T): T {
  const saved = combatParams.spreadAngle;
  combatParams.spreadAngle = 0;
  try {
    return body();
  } finally {
    combatParams.spreadAngle = saved;
  }
}

/** fire one broadside and follow it all the way to the water */
function volley(order: Omit<FireOrder, 'shipIndex' | 'fire'>): Volley {
  const { state, runtime } = rig();
  const ship = state.ships[0];
  const out: Volley = {
    launchElevations: [],
    apex: -Infinity,
    firstSplashRange: null,
    splashes: 0,
    balls: 0,
  };

  const step = (fire: boolean): void => {
    state.tick++;
    state.time += SIM_DT;
    const frame = runtime.tick(state, SIM_DT, [
      { shipIndex: 0, fire, ...order },
      { shipIndex: 1, fire: false },
    ]);
    for (const m of frame.muzzles) {
      if (m.shipIndex !== 0) continue;
      out.launchElevations.push(Math.asin(m.direction[1]));
    }
    for (const p of state.projectiles) {
      if (p.owner === 0) out.apex = Math.max(out.apex, p.position[1]);
    }
    out.balls = Math.max(out.balls, state.projectiles.length);
    for (const e of frame.projectiles) {
      if (e.type !== 'splash') continue;
      out.splashes++;
      if (out.firstSplashRange === null) {
        out.firstSplashRange = Math.hypot(
          e.position[0] - ship.position[0],
          e.position[2] - ship.position[2],
        );
      }
    }
  };

  step(true);
  // 15 s: past maxAge, so every ball of the broadside has resolved
  for (let i = 0; i < 60 * 15; i++) step(false);
  return out;
}

describe("the player's broadside falls in the sea, not out of the sky (§T.16)", () => {
  it('puts its shot on the water at a range a gunner would recognise', () => {
    // exactly what main.ts sends now: the player's own lay, at its default
    const aim = createAim();
    const shot = volley({ elevation: aim.elevation() });

    expect(shot.balls).toBeGreaterThan(0);
    expect(shot.splashes).toBeGreaterThan(0);
    // THE REPORT, as a number. A shot arcing 36 m into the air is what "super
    // high in the sky" looks like; a broadside is a flat-trajectory weapon.
    expect(shot.apex).toBeLessThan(15);
    // and it has to come DOWN somewhere useful — not at your own feet, not
    // over the horizon
    expect(shot.firstSplashRange).not.toBeNull();
    expect(shot.firstSplashRange as number).toBeGreaterThan(20);
    expect(shot.firstSplashRange as number).toBeLessThan(200);
  });

  it('never lets anything but the player lay the player\'s guns', () => {
    // THE DEFECT ITSELF: with an enemy 1014 m away — far past the ~133 m a
    // ball can reach — auto-lay used to answer with the maxElevation clamp.
    // An order that carries its own elevation must come out at that elevation
    // whatever else is on the water.
    for (const elevation of [0.02, 0.12, 0.3]) {
      const shot = volley({ elevation });
      expect(shot.launchElevations.length).toBeGreaterThan(0);
      for (const launched of shot.launchElevations) {
        // the only thing allowed to move it is the per-shot spread (§V.2)
        expect(Math.abs(launched - elevation)).toBeLessThanOrEqual(
          combatParams.spreadAngle + 1e-6,
        );
      }
      expect(shot.launchElevations.every((e) => e < combatParams.maxElevation - 0.05)).toBe(true);
    }
  });

  it('still auto-lays the ships that have no gunner — the AI keeps hers', () => {
    // the fix must not cost the enemy her range-keeping: an order WITHOUT an
    // elevation is still laid for the target, and at 1014 m that means the
    // clamp, honestly (ballistics.elevationForRange documents this).
    const { state, runtime } = rig();
    const elevations: number[] = [];
    // her broadside ripples fore → aft over ~a second, so follow it out
    for (let i = 0; i < 120; i++) {
      state.tick++;
      const frame = runtime.tick(state, SIM_DT, [
        { shipIndex: 0, fire: false },
        { shipIndex: 1, fire: i === 0 },
      ]);
      for (const m of frame.muzzles) {
        if (m.shipIndex === 1) elevations.push(Math.asin(m.direction[1]));
      }
    }
    expect(elevations.length).toBeGreaterThan(0);
    for (const e of elevations) {
      expect(e).toBeGreaterThan(combatParams.maxElevation - combatParams.spreadAngle - 1e-6);
    }
  });

  it('answers the aim: raising the guns lengthens the shot, monotonically', () => {
    // "is there anything I can do against it" — this is the yes. Four rungs
    // across the clamp, each one further downrange than the last.
    const ranges = withoutSpread(() =>
      [0.02, 0.1, 0.2, 0.35].map((e) => volley({ elevation: e }).firstSplashRange),
    );
    for (const r of ranges) expect(r).not.toBeNull();
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i] as number).toBeGreaterThan((ranges[i - 1] as number) + 5);
    }
  });
});

describe('the crosshair cannot lie about where the ball goes (§V.72 one expression)', () => {
  it('predicts the splash the sim actually produces, to within a metre or two', () => {
    const blueprint = buildGalleonBlueprint();
    const guns = batterySide(buildBattery(blueprint), 'starboard');
    // the same gun the reticle speaks for: the middle of the battery
    const mount = guns[Math.floor((guns.length - 1) / 2)].position;

    for (const elevation of [0.02, 0.1, 0.25, 0.45]) {
      const lay = muzzleLay(
        [PLAYER_SPAWN[0], 0, PLAYER_SPAWN[1]],
        [0, 0, 0, 1],
        mount,
        'starboard',
        elevation,
      );
      const predicted = predictImpact(lay, 0);
      expect(predicted).not.toBeNull();

      const shot = withoutSpread(() => volley({ elevation, side: 'starboard' }));
      expect(shot.firstSplashRange).not.toBeNull();
      // predictImpact measures from the MUZZLE, the splash from the ship's
      // origin — a beam's half-width apart, which is why this compares the
      // predicted fall POINT with the measured one rather than two ranges
      const predictedRange = Math.hypot(
        (predicted as { point: number[] }).point[0] - PLAYER_SPAWN[0],
        (predicted as { point: number[] }).point[2] - PLAYER_SPAWN[1],
      );
      expect(Math.abs(predictedRange - (shot.firstSplashRange as number))).toBeLessThan(2);
    }
  });
});

describe('the gun lay itself', () => {
  it('cannot be driven outside what the carriages allow', () => {
    const aim = createAim();
    aim.adjust(100);
    expect(aim.elevation()).toBeCloseTo(combatParams.maxElevation, 6);
    expect(aim.fraction()).toBeCloseTo(1, 6);
    aim.adjust(-100);
    expect(aim.elevation()).toBeCloseTo(combatParams.minElevation, 6);
    expect(aim.fraction()).toBeCloseTo(0, 6);
    // a NaN out of a pointer event must not poison the lay — it would send the
    // fire order's elevation to NaN and every ball to nowhere
    aim.adjust(Number.NaN);
    expect(Number.isFinite(aim.elevation())).toBe(true);
    expect(clampElevation(Number.NaN)).toBe(combatParams.minElevation);
  });

  it('starts where the guns are actually laid — the default is a flat shot', () => {
    const aim = createAim();
    expect(aim.elevation()).toBe(clampElevation(combatParams.defaultElevation));
    // and the default must be a fighting lay, not a mortar: under 10°
    expect(aim.elevation()).toBeLessThan(0.18);
  });
});
