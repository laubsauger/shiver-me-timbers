/**
 * Enemy AI data contracts (T19, §V.15).
 *
 * The AI emits INTENTS only — plain-data commands the sailing/combat
 * systems consume on a later step. The AI never moves a ship or spawns a
 * projectile itself (§V.3 one-way flow: it reads SimState, writes nothing
 * into it).
 *
 * §V.2: AiMemory lives OUTSIDE SimState for now, but must stay strictly
 * JSON-serializable (finite numbers, no functions/undefined) so that
 * multiplayer later can either fold it into the replicated state or
 * recompute it deterministically from the input log. stepAi is a pure
 * function of (SimState slices, memory, tick, params) — same inputs ⇒
 * same intent and same memory mutation.
 */

export interface AiIntent {
  /** -1..1, positive = turn to starboard (yaw+) */
  rudder: number;
  /** 0..1, 0 = furled */
  sailTrim: number;
  /** present only on the tick a broadside should fire */
  fire?: { side: 'port' | 'starboard' };
}

export type AiMode = 'patrol' | 'engage' | 'broadside' | 'flee';

export interface AiMemory {
  mode: AiMode;
  /** seconds spent in current mode (min-dwell gate) */
  modeTime: number;
  /** world [x, z] patrol waypoint */
  patrolTarget: [number, number];
  /** sim tick of the last fire intent; large negative = never (JSON-safe, no -Infinity) */
  lastFireTick: number;
}

/** Fresh memory. Pass the ship's [x, z] so patrol re-picks a waypoint immediately. */
export function createAiMemory(position: [number, number] = [0, 0]): AiMemory {
  return {
    mode: 'patrol',
    modeTime: 0,
    patrolTarget: [position[0], position[1]],
    lastFireTick: -1e9,
  };
}
