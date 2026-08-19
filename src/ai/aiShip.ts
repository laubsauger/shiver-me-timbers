/**
 * Enemy ship driver (T19, §V.15) — the adapter that turns the state
 * machine's AiIntent into the SAME plain inputs a human produces, so the
 * enemy sails on exactly the player's code path: one `InputState` into
 * `stepShipSailing`, one `FireOrder` into the combat system. There is no
 * second, simplified kinematics anywhere in here; if the enemy handles
 * differently from the player, that is a sailing-params difference, not a
 * different simulation.
 *
 * §V.3: reads SimState, returns plain commands, writes nothing but its own
 * memory. §V.2: pure function of (state slices, memory, tick, dt) — the
 * memory struct is JSON-serializable so lockstep can replicate or rebuild it.
 *
 * §V.14 interaction: a foundering ship stops answering (controlAuthority
 * fades helm and sheets), and a sunk one neither steers nor shoots. Without
 * that the wreck keeps beating to windward on the bottom, still firing.
 */
import type { InputState } from '../sailing/input';
import type { SimState } from '../state/simState';
import type { FireOrder } from '../combat/combatSystem';
import { controlAuthority, isSunk } from '../combat/sinking';
import { aiParams, type AiParams } from '../params/ai';
import { createAiMemory, type AiMemory } from './aiTypes';
import { stepAi } from './stateMachine';

export interface AiShip {
  /** index into SimState.ships */
  shipIndex: number;
  memory: AiMemory;
}

export interface AiCommands {
  input: InputState;
  order: FireOrder;
}

export function createAiShip(shipIndex: number, position: [number, number]): AiShip {
  return { shipIndex, memory: createAiMemory(position) };
}

/**
 * Trim deadband: `InputState.sailTrimDelta` is the same -1|0|1 the keyboard
 * emits and sailing integrates it at trimSpeed, so the AI has to hunt its
 * target trim the way a crew hauls on a sheet. The band stops it chattering
 * ±1 forever around the target once it arrives.
 */
const TRIM_DEADBAND = 0.05;

/**
 * One sim tick for one enemy ship. Returns the input snapshot to feed
 * `stepShipSailing` and the fire order to feed the combat system.
 */
export function stepAiShip(
  ai: AiShip,
  state: SimState,
  playerIndex: number,
  params: AiParams = aiParams,
): AiCommands {
  const ship = state.ships[ai.shipIndex];
  const player = state.ships[playerIndex];
  const idle: AiCommands = {
    // the AI never anchors — she is here to fight, not to lie to a cable
    // braceDelta 0 = leave the yards to the crew's automatic brace (§T.76).
    // The AI does not work her yards by hand; auto is the best in-range angle
    // anyway, so she is not handicapped by it.
    input: {
      rudder: 0,
      sailTrimDelta: 0,
      braceDelta: 0,
      brake: false,
      fire: false,
      anchorToggle: false,
    },
    order: { shipIndex: ai.shipIndex, fire: false },
  };
  if (ship === undefined || player === undefined) return idle;
  if (isSunk(ship)) {
    // furl what is left and let her go; sailTrimDelta -1 walks trim to 0
    // through the same integrator the player uses
    idle.input.sailTrimDelta = -1;
    return idle;
  }

  const intent = stepAi(ship, player, state.wind, ai.memory, state.tick, params);
  const authority = controlAuthority(ship);
  const targetTrim = Math.max(0, Math.min(1, intent.sailTrim)) * authority;
  const trimError = targetTrim - ship.sailTrim;

  const commands: AiCommands = {
    input: {
      rudder: Math.max(-1, Math.min(1, intent.rudder)) * authority,
      sailTrimDelta: Math.abs(trimError) < TRIM_DEADBAND ? 0 : Math.sign(trimError),
      braceDelta: 0, // automatic brace — see `idle` above
      brake: false,
      fire: intent.fire !== undefined,
      anchorToggle: false,
    },
    order: { shipIndex: ai.shipIndex, fire: false },
  };
  if (intent.fire !== undefined && authority > 0) {
    commands.order.fire = true;
    commands.order.side = intent.fire.side;
  }
  return commands;
}
