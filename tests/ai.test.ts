/**
 * WHY these tests (T19, §V.15/§V.2): the AI must be lockstep-safe (same
 * inputs+tick ⇒ same intent AND same memory — multiplayer later replays
 * it), must never command the impossible (upwind-dead waypoints, out-of-
 * range rudder/trim), must not flap modes at range boundaries (dwell), and
 * broadside geometry must fire the correct side at the reload cadence —
 * a wrong side or fire-spam is exactly what combat (§V.14) would amplify.
 */
import { describe, expect, it } from 'vitest';
import type { Quat, ShipState, Vec3 } from '../src/state/simState';
import { createRng } from '../src/state/rng';
import { SIM_DT } from '../src/core/loop';
import { quatFromAxisAngle } from '../src/core/quat';
import { combatParams } from '../src/params/combat';
import { aiParams, type AiParams } from '../src/params/ai';
import { createAiMemory, type AiMemory } from '../src/ai/aiTypes';
import { stepAi } from '../src/ai/stateMachine';
import { wrapAngle, yawOf, resolveHeading } from '../src/ai/steering';

const P: AiParams = { ...aiParams }; // isolate tests from live panel edits
const WIND = { direction: 0, speed: 8 }; // blows toward +z ⇒ upwind bearing = π

function makeShip(id: string, position: Vec3, yaw = 0, kind: ShipState['kind'] = 'enemy'): ShipState {
  const quaternion: Quat = quatFromAxisAngle([0, 1, 0], yaw);
  return {
    id, kind, position, quaternion,
    velocity: [0, 0, 0], angularVelocity: [0, 0, 0],
    rudder: 0, sailTrim: 0.5, flood: 0, damage: {},
  };
}

/** memory already settled in a mode (dwell elapsed) */
function settled(mode: AiMemory['mode'], pos: [number, number] = [0, 0]): AiMemory {
  const m = createAiMemory(pos);
  m.mode = mode;
  m.modeTime = P.minDwell;
  return m;
}

describe('determinism (§V.2)', () => {
  it('same inputs + tick ⇒ identical intent and identical memory evolution', () => {
    const run = () => {
      const intents: string[] = [];
      const memory = createAiMemory([0, 0]);
      for (let tick = 0; tick < 300; tick++) {
        // deterministic moving player: spirals through all range bands
        const r = 250 - tick * 0.7;
        const a = tick * 0.02;
        const ship = makeShip('e1', [0, 0, 0], a * 0.5);
        const player = makeShip('p', [Math.sin(a) * r, 0, Math.cos(a) * r], 0, 'player');
        intents.push(JSON.stringify(stepAi(ship, player, WIND, memory, tick, P)));
      }
      return { intents, memory: JSON.stringify(memory) };
    };
    const a = run();
    const b = run();
    expect(b.intents).toEqual(a.intents);
    expect(b.memory).toBe(a.memory);
  });
});

describe('patrol (§V.15)', () => {
  it('waypoints are always reachable — never inside the upwind irons cone', () => {
    const player = makeShip('p', [10000, 0, 10000], 0, 'player'); // far: stays patrol
    const upwind = wrapAngle(WIND.direction + Math.PI);
    for (let i = 0; i < 60; i++) {
      const ship = makeShip('e1', [i * 3, 0, -i * 2]);
      const memory = settled('patrol', [ship.position[0], ship.position[2]]);
      // memory target == ship pos ⇒ waypoint reached ⇒ new pick this tick
      stepAi(ship, player, WIND, memory, 1000 + i * 7, P);
      const [tx, tz] = memory.patrolTarget;
      const bearing = Math.atan2(tx - ship.position[0], tz - ship.position[2]);
      expect(Math.abs(wrapAngle(bearing - upwind))).toBeGreaterThanOrEqual(P.ironsCone - 1e-9);
      const leg = Math.hypot(tx - ship.position[0], tz - ship.position[2]);
      expect(leg).toBeGreaterThanOrEqual(P.patrolLegMin);
      expect(leg).toBeLessThanOrEqual(P.patrolLegMax);
    }
  });
});

describe('mode transitions with dwell (§V.15)', () => {
  it('engage triggers once at the range boundary; boundary flapping cannot flicker the mode', () => {
    const ship = makeShip('e1', [0, 0, 0]);
    const memory = settled('patrol');
    const near = makeShip('p', [0, 0, P.engageRange - 1], 0, 'player');
    const far = makeShip('p', [0, 0, P.engageRange + P.rangeHysteresis + 10], 0, 'player');

    const modes: string[] = [memory.mode];
    let tick = 0;
    stepAi(ship, near, WIND, memory, tick++, P);
    modes.push(memory.mode);
    expect(memory.mode).toBe('engage'); // dwell elapsed → transition fires
    expect(memory.modeTime).toBe(0); // reset on entry

    // player oscillates across the boundary every tick during the dwell window
    const dwellTicks = Math.floor(P.minDwell / SIM_DT) - 2;
    for (let i = 0; i < dwellTicks; i++) {
      stepAi(ship, i % 2 === 0 ? far : near, WIND, memory, tick++, P);
      modes.push(memory.mode);
    }
    const changes = modes.filter((m, i) => i > 0 && m !== modes[i - 1]).length;
    expect(changes).toBe(1); // exactly the single patrol→engage switch
    expect(memory.mode).toBe('engage');
  });

  it('drops back to patrol only beyond engageRange + hysteresis', () => {
    const ship = makeShip('e1', [0, 0, 0]);
    const memory = settled('engage');
    const inBand = makeShip('p', [0, 0, P.engageRange + P.rangeHysteresis - 1], 0, 'player');
    stepAi(ship, inBand, WIND, memory, 0, P);
    expect(memory.mode).toBe('engage'); // hysteresis band holds the mode
    memory.modeTime = P.minDwell;
    const out = makeShip('p', [0, 0, P.engageRange + P.rangeHysteresis + 1], 0, 'player');
    stepAi(ship, out, WIND, memory, 1, P);
    expect(memory.mode).toBe('patrol');
  });
});

describe('broadside (§V.15, §V.14 feeds destruction)', () => {
  it('player abeam within arc ⇒ fire intent with the geometrically correct side', () => {
    const ship = makeShip('e1', [0, 0, 0], 0); // bow +z, starboard +x
    const starboard = makeShip('p', [60, 0, 0], 0, 'player');
    const port = makeShip('p', [-60, 0, 0], 0, 'player');
    const ahead = makeShip('p', [0, 0, 60], 0, 'player');

    expect(stepAi(ship, starboard, WIND, settled('broadside'), 500, P).fire)
      .toEqual({ side: 'starboard' });
    expect(stepAi(ship, port, WIND, settled('broadside'), 500, P).fire)
      .toEqual({ side: 'port' });
    // dead ahead is outside the abeam arc: no shot
    expect(stepAi(ship, ahead, WIND, settled('broadside'), 500, P).fire).toBeUndefined();
  });

  it('reload is respected — no fire spam across consecutive ticks', () => {
    const ship = makeShip('e1', [0, 0, 0], 0);
    const player = makeShip('p', [60, 0, 0], 0, 'player');
    const memory = settled('broadside');
    const reloadTicks = Math.max(1, Math.round(combatParams.reloadTime / SIM_DT));

    const fireTicks: number[] = [];
    for (let tick = 0; tick < reloadTicks * 2 + 5; tick++) {
      memory.modeTime = P.minDwell; // geometry static; hold the mode
      if (stepAi(ship, player, WIND, memory, tick, P).fire) fireTicks.push(tick);
    }
    expect(fireTicks).toEqual([0, reloadTicks, reloadTicks * 2]);
  });
});

describe('flee (§V.15)', () => {
  it('high flood forces flee from any combat mode', () => {
    const player = makeShip('p', [0, 0, 50], 0, 'player');
    for (const mode of ['patrol', 'engage', 'broadside'] as const) {
      const ship = makeShip('e1', [0, 0, 0]);
      ship.flood = P.fleeFloodThreshold + 0.1;
      const memory = settled(mode);
      stepAi(ship, player, WIND, memory, 0, P);
      expect(memory.mode).toBe('flee');
    }
  });

  it('heavy mean damage forces flee even without flooding', () => {
    const ship = makeShip('e1', [0, 0, 0]);
    ship.damage = { hullPort0: 0.1, hullStar0: 0.2 }; // mean 0.15 < threshold
    const memory = settled('broadside');
    stepAi(ship, makeShip('p', [50, 0, 0], 0, 'player'), WIND, memory, 0, P);
    expect(memory.mode).toBe('flee');
  });
});

describe('steering sanity + fuzz (§V.2)', () => {
  it('upwind target resolves to a tack heading outside the irons cone', () => {
    const upwind = wrapAngle(WIND.direction + Math.PI);
    const resolved = resolveHeading(upwind, upwind + 0.3, WIND.direction, P);
    expect(Math.abs(wrapAngle(resolved - upwind))).toBeCloseTo(P.tackAngle, 6);
    expect(Math.abs(wrapAngle(resolved - upwind))).toBeGreaterThanOrEqual(P.ironsCone - 1e-9);
  });

  it('500-tick fuzz: intents always in valid ranges, memory stays JSON-safe', () => {
    const rng = createRng(1234);
    const memory = createAiMemory([0, 0]);
    for (let tick = 0; tick < 500; tick++) {
      const ship = makeShip('e1', [rng() * 400 - 200, 0, rng() * 400 - 200], rng() * Math.PI * 4);
      ship.flood = rng() < 0.1 ? rng() : 0;
      const player = makeShip('p', [rng() * 600 - 300, 0, rng() * 600 - 300], 0, 'player');
      const wind = { direction: rng() * Math.PI * 2, speed: 4 + rng() * 10 };
      const intent = stepAi(ship, player, wind, memory, tick, P);

      expect(intent.rudder).toBeGreaterThanOrEqual(-1);
      expect(intent.rudder).toBeLessThanOrEqual(1);
      expect(intent.sailTrim).toBeGreaterThanOrEqual(0);
      expect(intent.sailTrim).toBeLessThanOrEqual(1);
      if (intent.fire) expect(['port', 'starboard']).toContain(intent.fire.side);
      expect(Number.isFinite(yawOf(ship.quaternion))).toBe(true);
    }
    // JSON round-trip identity ⇒ no Infinity/NaN/undefined snuck in (§V.2)
    expect(JSON.parse(JSON.stringify(memory))).toEqual(memory);
  });
});
