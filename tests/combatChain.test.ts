/**
 * The combat chain end to end (T16→T17→T18, §V13/§V14/§V15).
 *
 * WHY this file exists separately from the unit tests: every piece of this
 * chain already had passing unit tests while the chain as a whole did
 * nothing at all, because nothing had ever pulled the trigger on a real
 * blueprint. These tests fire actual guns off an actual galleon's
 * cannon-mount sockets at an actual second galleon, and assert the
 * consequences reach the far end — hp down, piece swapped, hole recorded,
 * flood rising, ship gone. A green unit suite over a chain that is never
 * connected is exactly the failure mode this project keeps hitting.
 */
import { describe, expect, it } from 'vitest';
import type { Material } from 'three';
import { SIM_DT } from '../src/core/loop';
import {
  createInitialState,
  type ShipState,
  type SimState,
  type Vec3,
} from '../src/state/simState';
import { buildGalleonBlueprint } from '../src/ship/shipBlueprint';
import { ShipAssembly } from '../src/ship/shipAssembly';
import { createCombat, type CombatShipConfig } from '../src/combat/combatSystem';
import { buildBattery, sideForBearing } from '../src/combat/battery';
import { buildHitTargetSet, poseTargets } from '../src/combat/hitTargets';
import { testHits, type HitTarget } from '../src/combat/hitTest';
import {
  controlAuthority,
  isSunk,
  sinkPhase,
  stepSinkSettle,
} from '../src/combat/sinking';
import { stepFlooding } from '../src/sea-physics/flooding';
import type { FloodingParams } from '../src/params/flooding';
import { combatParams } from '../src/params/combat';
import { createAiShip, stepAiShip } from '../src/ai/aiShip';
import { aiParams } from '../src/params/ai';

const stub = (): Material => ({ dispose(): void {} }) as unknown as Material;

/** fixed flooding params so the chain test never drifts with panel tuning */
const FLOOD: FloodingParams = {
  ingressRatePerHole: 0.02,
  depthFactor: 0.5,
  pumpRate: 0.03,
  sinkThreshold: 0.6,
  sinkDuration: 12,
  listStrength: 1,
  massGain: 0.8,
  sunkDepth: 14,
  sunkDrag: 0.9,
  founderFraction: 0.6,
};

function makeShip(id: string, position: Vec3, kind: ShipState['kind']): ShipState {
  return {
    id, kind, position, quaternion: [0, 0, 0, 1],
    velocity: [0, 0, 0], angularVelocity: [0, 0, 0],
    rudder: 0, sailTrim: 0.6, flood: 0, damage: {},
  };
}

function scene(shipPositions: Vec3[]): {
  state: SimState;
  configs: CombatShipConfig[];
  dispose(): void;
} {
  const state = createInitialState(1337);
  const configs: CombatShipConfig[] = [];
  shipPositions.forEach((position, shipIndex) => {
    state.ships.push(
      makeShip(shipIndex === 0 ? 'player' : `enemy${shipIndex}`, position,
        shipIndex === 0 ? 'player' : 'enemy'),
    );
    const blueprint = buildGalleonBlueprint();
    configs.push({ shipIndex, blueprint, assembly: new ShipAssembly(blueprint, stub) });
  });
  return {
    state,
    configs,
    dispose: () => configs.forEach((c) => c.assembly.dispose()),
  };
}

describe('battery from the piece graph (§V.13/§V.18)', () => {
  const battery = buildBattery(buildGalleonBlueprint());

  it('finds guns on both sides from cannon-mount sockets alone', () => {
    expect(battery.port.length).toBeGreaterThan(0);
    expect(battery.starboard).toHaveLength(battery.port.length);
  });

  it('sides match the sign of the resolved ship-local x (no id-string guessing)', () => {
    for (const gun of battery.port) expect(gun.position[0]).toBeLessThan(0);
    for (const gun of battery.starboard) expect(gun.position[0]).toBeGreaterThan(0);
  });

  it('mounts resolve THROUGH the parent chain, not at the piece origin', () => {
    // galleon guns hang off the deck piece, which is itself lifted to the
    // freeboard — a mount left in piece-local space would sit at y≈0.05,
    // firing out of the bilge
    for (const gun of battery.starboard) expect(gun.position[1]).toBeGreaterThan(1);
  });

  it('orders guns bow → stern so a broadside ripples', () => {
    for (let i = 1; i < battery.port.length; i++) {
      expect(battery.port[i - 1].position[2]).toBeGreaterThanOrEqual(
        battery.port[i].position[2],
      );
    }
  });

  it('picks the battery that bears on a target', () => {
    expect(sideForBearing(0, Math.PI / 2)).toBe('starboard'); // bow +z, target +x
    expect(sideForBearing(0, -Math.PI / 2)).toBe('port');
    // yawed 90°: bow now points +x, so a target at +x is dead ahead and a
    // target at +z is to port
    expect(sideForBearing(Math.PI / 2, 0)).toBe('port');
  });
});

describe('a ship never shoots itself (§V.3 owner contract)', () => {
  /**
   * WHY: deck cannon-mount sockets sit at |x| = 3.25 m on a hull whose
   * half-beam is 4.25 m — INSIDE the firing ship's own hull-section AABB. A
   * hit test with no notion of who fired scores a hull breach on the very
   * tick of every shot, so the player's opening broadside holes his own
   * hull, floods it and sinks him. It fails by working: shots fire, hits
   * register, damage accrues, and nothing anywhere throws.
   */
  it('a full broadside from a lone ship produces zero hits on herself', () => {
    const { state, configs, dispose } = scene([[0, 0, 0]]);
    const combat = createCombat(configs);
    let hits = 0;
    let muzzles = 0;
    for (let i = 0; i < 400; i++) {
      state.tick++;
      const frame = combat.step(state, SIM_DT, [
        { shipIndex: 0, fire: true, side: 'starboard' },
      ]);
      hits += frame.hits.length;
      muzzles += frame.muzzles.length;
    }
    expect(muzzles).toBeGreaterThan(0); // guard: the guns really did fire
    expect(hits).toBe(0);
    expect(state.ships[0].damage).toEqual({});
    expect(state.ships[0].flood).toBe(0);
    dispose();
  });

  it('...and the geometry really does overlap — only `owner` prevents it', () => {
    const { state, configs, dispose } = scene([[0, 0, 0]]);
    const set = buildHitTargetSet(configs[0].blueprint);
    const n = poseTargets(set, 0, state.ships[0]);
    const targets: HitTarget[] = set.buffer.slice(0, n);

    // a ball sitting exactly on a starboard mount, moving outboard
    const mount = buildBattery(configs[0].blueprint).starboard[0].position;
    const shot = (owner: number): SimState => {
      const s = createInitialState(1);
      s.ships.push(state.ships[0]);
      s.projectiles.push({
        id: 0,
        position: [mount[0], mount[1], mount[2]],
        velocity: [60, 0, 0],
        age: 0,
        owner,
      });
      return s;
    };
    // fired by someone else: the muzzle station is inside the hull box, so
    // this MUST hit — proving the box overlap is real
    expect(testHits(shot(1), targets, SIM_DT).length).toBe(1);
    // fired by this ship: excluded
    expect(testHits(shot(0), targets, SIM_DT).length).toBe(0);
    dispose();
  });
});

describe('fire → hit → breach → hole → flood → sink (§V14 end to end)', () => {
  it('a sustained broadside sinks the ship it is aimed at', () => {
    const { state, configs, dispose } = scene([[0, 0, 0], [45, 0, 0]]);
    const combat = createCombat(configs);
    const player = state.ships[0];
    const enemy = state.ships[1];

    let firstBreachTick = -1;
    let sinkingTick = -1;
    let sunkTick = -1;
    let splinterBursts = 0;

    for (let tick = 0; tick < 60 * 180; tick++) {
      state.tick++;
      const frame = combat.step(state, SIM_DT, [
        { shipIndex: 0, fire: true, side: 'starboard' },
      ]);
      splinterBursts += frame.destruction.filter((e) => e.type === 'splinters').length;

      const holes = combat.floodHoles(state, 1, 0);
      if (holes.length > 0 && firstBreachTick < 0) firstBreachTick = tick;
      stepFlooding(enemy, holes, SIM_DT, FLOOD);

      if (sinkingTick < 0 && enemy.flood >= FLOOD.sinkThreshold) sinkingTick = tick;
      if (isSunk(enemy)) {
        sunkTick = tick;
        break;
      }
    }

    // every link in the chain, in order
    expect(Object.keys(enemy.damage).length).toBeGreaterThan(0); // hits landed
    expect(splinterBursts).toBeGreaterThan(0); // §V14 piece swap fired
    expect(firstBreachTick).toBeGreaterThan(0); // holes recorded
    expect(sinkingTick).toBeGreaterThan(firstBreachTick); // flood outran pumps
    expect(sunkTick).toBeGreaterThan(sinkingTick); // she went down
    expect(sinkPhase(enemy, FLOOD)).toBe('sunk');
    // the shooter is untouched throughout
    expect(player.damage).toEqual({});
    expect(player.flood).toBe(0);
    dispose();
  });

  it('holes are recorded per breach and stop the ship being unsinkable', () => {
    const { state, configs, dispose } = scene([[0, 0, 0], [45, 0, 0]]);
    const combat = createCombat(configs);
    for (let tick = 0; tick < 60 * 40; tick++) {
      state.tick++;
      combat.step(state, SIM_DT, [{ shipIndex: 0, fire: true, side: 'starboard' }]);
    }
    const holes = combat.floodHoles(state, 1, 0);
    expect(holes.length).toBeGreaterThan(0);
    // at least one hole must be genuinely BELOW the surface, or ingressRate
    // returns 0 for all of them and the ship floats forever while every
    // "damage applied" assertion still passes
    expect(holes.some((h) => h[1] < 0)).toBe(true);
    dispose();
  });

  it('a hole above the live sea surface takes no water (§V.8 waterline)', () => {
    const { state, configs, dispose } = scene([[0, 0, 0], [45, 0, 0]]);
    const combat = createCombat(configs);
    for (let tick = 0; tick < 60 * 40; tick++) {
      state.tick++;
      combat.step(state, SIM_DT, [{ shipIndex: 0, fire: true, side: 'starboard' }]);
    }
    const onFlat = combat.floodHoles(state, 1, 0);
    const submerged = onFlat.filter((h) => h[1] < 0).length;
    // same breaches, but the hull is now riding 3 m clear of the surface:
    // strictly fewer holes are under water
    const lifted = combat.floodHoles(state, 1, -3).filter((h) => h[1] < 0).length;
    expect(lifted).toBeLessThan(submerged);
    dispose();
  });

  it('is deterministic — same seed and same orders replay identically (§V.2)', () => {
    const run = (): string => {
      const { state, configs, dispose } = scene([[0, 0, 0], [45, 0, 0]]);
      const combat = createCombat(configs);
      for (let tick = 0; tick < 60 * 20; tick++) {
        state.tick++;
        combat.step(state, SIM_DT, [{ shipIndex: 0, fire: true, side: 'starboard' }]);
        stepFlooding(state.ships[1], combat.floodHoles(state, 1, 0), SIM_DT, FLOOD);
      }
      const out = JSON.stringify({
        damage: state.ships[1].damage,
        flood: state.ships[1].flood,
        memory: combat.memoryOf(0),
      });
      dispose();
      return out;
    };
    expect(run()).toBe(run());
  });

  it('combat memory stays plain JSON-serializable (§V.2 lockstep)', () => {
    const { state, configs, dispose } = scene([[0, 0, 0], [45, 0, 0]]);
    const combat = createCombat(configs);
    for (let tick = 0; tick < 600; tick++) {
      state.tick++;
      combat.step(state, SIM_DT, [{ shipIndex: 0, fire: true, side: 'starboard' }]);
    }
    const memory = combat.memoryOf(0);
    expect(JSON.parse(JSON.stringify(memory))).toEqual(memory);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    dispose();
  });

  it('guns respect reload — a held trigger cannot empty the deck at once', () => {
    const { state, configs, dispose } = scene([[0, 0, 0]]);
    const combat = createCombat(configs);
    const guns = buildBattery(configs[0].blueprint).starboard.length;
    let fired = 0;
    // one reload period, plus the ripple tail
    const ticks = Math.round(combatParams.reloadTime / SIM_DT);
    for (let i = 0; i < ticks; i++) {
      state.tick++;
      fired += combat.step(state, SIM_DT, [
        { shipIndex: 0, fire: true, side: 'starboard' },
      ]).muzzles.length;
    }
    expect(fired).toBe(guns); // exactly one full broadside inside one reload
    dispose();
  });

  it('a broadside ripples fore → aft rather than firing as one slab', () => {
    const { state, configs, dispose } = scene([[0, 0, 0]]);
    const combat = createCombat(configs);
    const order: number[] = [];
    for (let i = 0; i < 120; i++) {
      state.tick++;
      for (const m of combat.step(state, SIM_DT, [
        { shipIndex: 0, fire: true, side: 'starboard' },
      ]).muzzles) {
        order.push(m.position[2]);
      }
      if (order.length >= 2) break;
    }
    expect(order.length).toBeGreaterThanOrEqual(2);
    expect(order[0]).toBeGreaterThan(order[1]); // bow gun spoke first
    dispose();
  });
});

describe('sink sequence (§T.18)', () => {
  const ship = (flood: number): ShipState => {
    const s = makeShip('s', [0, 0, 0], 'enemy');
    s.flood = flood;
    return s;
  };

  it('walks dry → damaged → sinking → foundering → sunk', () => {
    expect(sinkPhase(ship(0), FLOOD)).toBe('dry');
    expect(sinkPhase(ship(0.3), FLOOD)).toBe('damaged');
    expect(sinkPhase(ship(0.65), FLOOD)).toBe('sinking');
    expect(sinkPhase(ship(0.95), FLOOD)).toBe('foundering');
    expect(sinkPhase(ship(1), FLOOD)).toBe('sunk');
  });

  it('control fades to nothing by the time she founders, and never returns', () => {
    expect(controlAuthority(ship(0), FLOOD)).toBe(1);
    expect(controlAuthority(ship(0.5), FLOOD)).toBe(1);
    let prev = 1;
    for (let f = FLOOD.sinkThreshold; f <= 1.0001; f += 0.01) {
      const a = controlAuthority(ship(f), FLOOD);
      expect(a).toBeLessThanOrEqual(prev + 1e-9); // monotone down
      expect(a).toBeGreaterThanOrEqual(0);
      prev = a;
    }
    expect(controlAuthority(ship(1), FLOOD)).toBe(0);
  });

  it('does nothing at all while the ship is still afloat', () => {
    const s = ship(0.9);
    s.position[1] = -500;
    s.sailTrim = 0.8;
    stepSinkSettle(s, 0, SIM_DT, FLOOD);
    expect(s.position[1]).toBe(-500); // buoyancy still owns her
    expect(s.sailTrim).toBe(0.8);
  });

  it('puts a floor under the fall — support hits 0 and nothing else does', () => {
    /**
     * WHY: at flood = 1 buoyancyScale is 0, which removes the probe spring
     * AND its damping, so the wreck is in free fall with no opposing term.
     * Unclamped she is kilometres down within a minute, outside camera.far,
     * carrying a velocity that dominates every other force in the integrator.
     */
    const s = ship(1);
    s.position[1] = -1000;
    s.velocity = [4, -60, 3];
    s.angularVelocity = [1, 1, 1];
    stepSinkSettle(s, 0, SIM_DT, FLOOD);
    expect(s.position[1]).toBe(-FLOOD.sunkDepth);
    expect(s.velocity[1]).toBe(0);
    expect(Math.abs(s.velocity[0])).toBeLessThan(4);
    expect(Math.abs(s.angularVelocity[1])).toBeLessThan(1);
    expect(s.sailTrim).toBe(0);
    expect(s.rudder).toBe(0);
  });

  it('rests relative to the LIVE surface, not a flat plane (§V.36 spirit)', () => {
    const s = ship(1);
    s.position[1] = -1000;
    stepSinkSettle(s, 2.5, SIM_DT, FLOOD); // riding under a 2.5 m crest
    expect(s.position[1]).toBeCloseTo(2.5 - FLOOD.sunkDepth, 9);
  });

  it('survives a non-finite sea height without writing NaN into the pose', () => {
    const s = ship(1);
    s.position[1] = -1000;
    stepSinkSettle(s, Number.NaN, SIM_DT, FLOOD);
    expect(Number.isFinite(s.position[1])).toBe(true);
  });
});

describe('AI ship drives the PLAYER path (§V.15)', () => {
  const world = (enemyFlood = 0): SimState => {
    const state = createInitialState(9);
    state.ships.push(makeShip('player', [0, 0, 0], 'player'));
    state.ships.push(makeShip('enemy', [60, 0, 0], 'enemy'));
    state.ships[1].flood = enemyFlood;
    return state;
  };

  it('emits the same InputState shape a keyboard does', () => {
    const state = world();
    const ai = createAiShip(1, [60, 0]);
    for (let i = 0; i < 400; i++) {
      state.tick++;
      const { input } = stepAiShip(ai, state, 0, aiParams);
      expect(input.rudder).toBeGreaterThanOrEqual(-1);
      expect(input.rudder).toBeLessThanOrEqual(1);
      expect([-1, 0, 1]).toContain(input.sailTrimDelta);
      expect(typeof input.brake).toBe('boolean');
    }
  });

  it('is deterministic: same state + same memory ⇒ same commands (§V.2)', () => {
    const run = (): string => {
      const state = world();
      const ai = createAiShip(1, [60, 0]);
      const log: string[] = [];
      for (let i = 0; i < 300; i++) {
        state.tick++;
        log.push(JSON.stringify(stepAiShip(ai, state, 0, aiParams)));
      }
      return log.join('|') + JSON.stringify(ai.memory);
    };
    expect(run()).toBe(run());
  });

  it('a foundering ship stops answering the helm', () => {
    const healthy = world(0);
    const dying = world(0.95);
    const a = createAiShip(1, [60, 0]);
    const b = createAiShip(1, [60, 0]);
    // put both hard over by placing the player abeam
    healthy.ships[0].position = [0, 0, 200];
    dying.ships[0].position = [0, 0, 200];
    let helm = 0;
    let dyingHelm = 0;
    for (let i = 0; i < 200; i++) {
      healthy.tick++;
      dying.tick++;
      helm = Math.max(helm, Math.abs(stepAiShip(a, healthy, 0, aiParams).input.rudder));
      dyingHelm = Math.max(
        dyingHelm, Math.abs(stepAiShip(b, dying, 0, aiParams).input.rudder),
      );
    }
    expect(helm).toBeGreaterThan(0);
    expect(dyingHelm).toBe(0);
  });

  it('a sunk ship neither steers nor shoots — she furls and goes', () => {
    const state = world(1);
    const ai = createAiShip(1, [60, 0]);
    state.ships[0].position = [40, 0, 0]; // player right alongside: firing geometry
    for (let i = 0; i < 600; i++) {
      state.tick++;
      const { input, order } = stepAiShip(ai, state, 0, aiParams);
      expect(order.fire).toBe(false);
      expect(input.rudder).toBe(0);
      expect(input.sailTrimDelta).toBe(-1); // hauling the canvas in
    }
  });

  it('a fire intent becomes a fire order on the side that bears', () => {
    const state = world();
    const ai = createAiShip(1, [60, 0]);
    let sides = new Set<string>();
    for (let i = 0; i < 60 * 60; i++) {
      state.tick++;
      const { order } = stepAiShip(ai, state, 0, aiParams);
      if (order.fire) sides.add(order.side ?? 'none');
    }
    expect(sides.size).toBeGreaterThan(0);
    expect(sides.has('none')).toBe(false);
  });
});
