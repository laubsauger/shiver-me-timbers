/**
 * Per-tick inputs the race logic reads for ONE racer (§T.184). The page (§T.181) fills one
 * per racer per sim tick, in the race's racer order. Everything the race decides comes from
 * here plus the sim tick count (§V2): no clocks, no randomness.
 */
import type { Vec2 } from './types';

export interface RacerSensors {
  racerId: number;
  /**
   * Hull reference point (x, z) at the END of every physics substep of this tick, in order,
   * at least one. Gates are tested on the segments between consecutive points (§V107), the
   * first segment starting from the previous tick's last point.
   */
  positions: readonly Vec2[];
  /** speed over ground, m/s (respawn speed is taken from the last pre-crash value) */
  speed: number;
  /** no hull contact with the water this tick */
  airborne: boolean;
  /**
   * Landing slam this tick in g: Σ `HullWater.slamImpulse` over the substeps / hull mass / tick
   * dt / 9.81. 0 while airborne or running clean.
   */
  slam: number;
  /** hull pitch relative to the local sea surface, rad, bow up positive */
  pitch: number;
  /** hull roll relative to the local sea surface, rad */
  roll: number;
  /** the crash state machine (`src/speedboat`) has this boat in a crash */
  crashed: boolean;
  /**
   * this airborne event was launched off another boat's wake crest (the page decides; it needs
   * the wake field). Read while airborne; true on any airborne tick latches it for the jump.
   */
  launchedFromWake: boolean;
  /** Surge button held (a rising edge fires) */
  surgePressed: boolean;
  /**
   * the page wants this boat put back on the line now (crash machine timed out, or the
   * player's hold-to-reset completed). A rising edge emits a `respawn` event.
   */
  respawnRequested: boolean;
}
