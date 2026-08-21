/**
 * SimState — single source of truth for simulation.
 * §V.2: plain JSON-serializable data, deterministic under fixed tick.
 * §V.3: sim writes, render only reads.
 */
// TYPE-ONLY, and that matters: it is erased at compile time, so this adds no
// runtime edge from the sim to the weather module and §V.3's "weather never
// imports SimState" still holds in the only direction it constrains. Spelling
// the seven preset names out again here instead would be a §V.62 silent drop
// waiting to happen — a rung added to the ladder but not to this union stops
// type-checking at the one call site that writes it (src/main.ts), while a
// rung REMOVED from the ladder would leave a name here nothing can produce.
import type { WeatherPresetName } from '../weather/presets';
// Type-only for the same reason: the player core is plain data (§T.94).
import type { PlayerState } from '../player/playerStep';

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export interface ShipState {
  id: string;
  kind: 'player' | 'enemy';
  position: Vec3;
  quaternion: Quat;
  velocity: Vec3;
  angularVelocity: Vec3;
  rudder: number; // -1..1
  sailTrim: number; // 0..1 (0 = furled)
  /**
   * Riding to her anchor: the cable holds her, the sails drive nothing
   * (§B.49). SIM state, not a UI flag — it gates a force, so it has to
   * serialize with the ship and replay with the input log (§V.2/§V.3).
   *
   * OPTIONAL so the fifteen existing ShipState literals (and any saved
   * state) stay valid, and so a ship that never anchors serializes — and
   * therefore hashes — exactly as it did before this field existed.
   * `undefined` and `false` both mean "under way".
   */
  anchored?: boolean;
  /**
   * THE YARDS (§T.76): brace angle in radians about the ship's vertical,
   * positive sending the starboard yardarm aft. SIM state, not a render
   * animation — it scales the drive (`shipKinematics.braceDrive`), so it has
   * to advance on the fixed tick and replay from the input log like every
   * other force term. `src/ship/rigTrim.ts` only DISPLAYS it.
   *
   * OPTIONAL for the same reason `anchored` is: the existing ShipState
   * literals stay valid, and an unset value means "wherever the crew would
   * have her", which `stepShipSailing` seeds on the first tick.
   */
  brace?: number;
  /**
   * Seconds of MANUAL brace authority left. Q/E set it to `braceHoldTime`;
   * when it runs out the yards slew back to the automatic brace. State rather
   * than a collector latch for the §V.3 reason `anchorToggle` is not latched:
   * the input snapshot has to be the whole truth of its tick.
   */
  braceHold?: number;
  flood: number; // 0..1, 1 = sunk
  /** damage zone id → remaining hp 0..1 */
  damage: Record<string, number>;
}

export interface ProjectileState {
  id: number;
  position: Vec3;
  velocity: Vec3;
  age: number;
  /**
   * index into `ships` of the gun that fired this ball. Hit tests skip the
   * owner's own pieces: deck-mounted cannon-mount sockets sit INSIDE their
   * own hull-section AABB (galleon mounts at |x| = 3.25 m inside a 4.25 m
   * half-beam), so without this every shot holes the firing ship on the tick
   * it is fired — the ship then floods and sinks from its own broadside.
   */
  owner: number;
}

export interface SimState {
  seed: number;
  /** sim ticks elapsed since start */
  tick: number;
  /** seconds elapsed = tick * SIM_DT */
  time: number;
  wind: { direction: number; speed: number }; // direction radians, speed m/s
  weather: WeatherPresetName;
  ships: ShipState[];
  projectiles: ProjectileState[];
  nextProjectileId: number;
  /**
   * FIRST-PERSON WALKER (§T.94/§V85). Ship-local feet position while aboard,
   * world while swimming. OPTIONAL for the reason `anchored` is: a state
   * without a walker serializes — and hashes — exactly as it did before.
   */
  player?: PlayerState;
}

export function createInitialState(seed: number): SimState {
  return {
    seed,
    tick: 0,
    time: 0,
    wind: { direction: 0, speed: 8 },
    weather: 'swell',
    ships: [],
    projectiles: [],
    nextProjectileId: 0,
  };
}

export function serializeState(state: SimState): string {
  return JSON.stringify(state);
}

export function deserializeState(json: string): SimState {
  return JSON.parse(json) as SimState;
}

/** FNV-1a 32-bit over serialized state. Cheap determinism check (§V.2). */
export function hashState(state: SimState): number {
  const str = serializeState(state);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
