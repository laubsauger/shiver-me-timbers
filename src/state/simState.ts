/**
 * SimState — single source of truth for simulation.
 * §V.2: plain JSON-serializable data, deterministic under fixed tick.
 * §V.3: sim writes, render only reads.
 */

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
  weather: 'calm' | 'swell' | 'storm';
  ships: ShipState[];
  projectiles: ProjectileState[];
  nextProjectileId: number;
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
