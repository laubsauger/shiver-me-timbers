/**
 * Race events, emitted as an ORDERED list per tick (§T.184). Order within a tick:
 *   1. phase and lights (race-wide),
 *   2. per racer in race order: element crossings / penalties / laps / finish in the order
 *      they happened along the substeps, then wrongWay, surgeEarned, surgeFired, respawn,
 *   3. dnf,
 *   4. positionChanged, by new position.
 * Times are race time (s, negative before green), interpolated inside the substep.
 */
import type { RaceState } from './types';
import type { SurgeReason } from './surge';

export type RaceEvent =
  | { kind: 'phase'; phase: RaceState['phase'] }
  /** a lamp lit (`green` false, `lit` = lamps now lit) or all out for green (`green` true) */
  | { kind: 'lights'; lit: number; of: number; green: boolean }
  | {
      kind: 'gateCrossed';
      racerId: number;
      element: number;
      elementKind: 'gate' | 'mark';
      id: string;
      /** lap being run after this crossing, 1-based */
      lap: number;
      time: number;
    }
  | { kind: 'lapCompleted'; racerId: number; lap: number; lapTime: number; best: boolean; time: number }
  | { kind: 'positionChanged'; racerId: number; from: number; to: number }
  | { kind: 'surgeEarned'; racerId: number; reason: SurgeReason; amount: number; surge: number }
  | { kind: 'surgeFired'; racerId: number; surge: number; seconds: number }
  | {
      kind: 'penalty';
      racerId: number;
      reason: 'missedElement' | 'jumpStart';
      /** element index for missedElement */
      element: number;
      seconds: number;
      totalSeconds: number;
      time: number;
    }
  | { kind: 'wrongWay'; racerId: number; wrongWay: boolean }
  | {
      /** teleport contract: the page puts the hull here, resets per-location memories (§T.188) */
      kind: 'respawn';
      racerId: number;
      x: number;
      z: number;
      yaw: number;
      speed: number;
      ghostSeconds: number;
      clear: boolean;
    }
  | { kind: 'finish'; racerId: number; lapsCompleted: number; time: number; totalTime: number }
  | { kind: 'dnf'; racerId: number };
