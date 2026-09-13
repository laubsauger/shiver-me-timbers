/**
 * The seabed as RACE PHYSICS should see it (§T.187 → §T.188 hook).
 *
 * Design doc §3: a sandbar NEVER grounds a boat. The terrain keeps ≥ 2 m of
 * still water over every bar crest in the corridor (tests/circuit.test.ts),
 * but a static margin is not a dynamic one: a V-39 landing off the bar's own
 * breaker buries its forefoot a metre or more, and in a trough the column
 * over the crest is shallower still. So the collision/grounding step reads
 * this field instead of the archipelago's: inside a bar zone the bed is
 * pushed down to at least BAR_PASS_THROUGH_DEPTH, blended over a skirt so no
 * step appears at the zone edge. Everywhere else it IS the archipelago seabed.
 *
 * The drawn seabed, the shoaling and the swell shadow keep the real bar — only
 * hull contact is told to ignore it. Structural `SeabedField` shape, so it
 * drops into `stepShipGrounding(ship, contact, seabed, …)` unchanged.
 */
import type { Vec2 } from '../race/types';
import { polylineDistance, smoothstep } from './kitFamilies';

/** physics bed depth over a bar (m): deeper than any keel + landing plunge + trough */
export const BAR_PASS_THROUGH_DEPTH = 6;
/** skirt (m) beyond a bar's half-width over which the pass-through fades out */
export const BAR_PASS_THROUGH_SKIRT = 40;

export interface BarZone {
  crest: readonly Vec2[];
  halfWidth: number;
}

export interface RaceSeabed {
  heightAt(x: number, z: number): number;
}

export function createRaceSeabed(seabedAt: (x: number, z: number) => number, bars: readonly BarZone[]): RaceSeabed {
  return {
    heightAt(x, z) {
      const bed = seabedAt(x, z);
      let w = 0;
      for (const b of bars) {
        const d = polylineDistance(b.crest, x, z).d;
        // the zone is the bar's broad back on both sides (the swell side is 1.35× wider)
        w = Math.max(w, smoothstep(b.halfWidth * 1.4 + BAR_PASS_THROUGH_SKIRT, b.halfWidth * 1.4, d));
      }
      if (w <= 0) return bed;
      return Math.min(bed, bed + (-BAR_PASS_THROUGH_DEPTH - bed) * w);
    },
  };
}
