/**
 * DeckHeightfield → WalkSurface adapter (§T.94). Ship-local in, ship-local
 * out: the field's `data` is metres relative to `deckY`, so ground height in
 * ship space is `deckY + data`. Outboard of the planking the water mask is 0
 * and there is no deck to stand on — that is the overboard edge.
 *
 * `solid` is bilinear and continuous; the walker treats anything past
 * `solidThreshold` as a wall so the bulwark's inner face, a coaming's lip
 * and a mast partner all stop the capsule at its radius rather than its
 * centre. The capsule radius is applied by probing the footprint, not by
 * inflating the field.
 */
import { sampleDeckField, type DeckHeightfield } from '../ship/deckHeightfield';
import { playerParams } from '../params/player';
import type { Vec3, WalkSurface } from './playerStep';

export interface DeckSurfaceOptions {
  /** WORLD sea height — lets the walker notice a submerged deck and swim */
  waterAt?: (x: number, z: number) => number;
  /** ship-local foot-rail points a swimmer can climb back at */
  boardingPoints?: readonly Vec3[];
  /** live ship transform (ship-local → world) */
  shipToWorld?: (p: Vec3) => Vec3;
  /** optional overhead surface (cabin roof), ship-local y, null = sky */
  ceilingAt?: (x: number, z: number) => number | null;
  /** `mask` below this = no deck; `solid` above this = wall */
  maskThreshold?: number;
  solidThreshold?: number;
}

/** the four compass points of the capsule footprint plus its centre */
const FOOTPRINT: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export function createDeckSurface(
  field: DeckHeightfield,
  opts: DeckSurfaceOptions = {},
): WalkSurface {
  const maskMin = opts.maskThreshold ?? 0.5;
  const solidMin = opts.solidThreshold ?? 0.5;
  const inside = (x: number, z: number): boolean =>
    x >= field.minX && x <= field.maxX && z >= field.minZ && z <= field.maxZ;
  const surface: WalkSurface = {
    heightAt(x, z) {
      if (!inside(x, z)) return null;
      if (sampleDeckField(field, field.mask, x, z) < maskMin) return null;
      return field.deckY + sampleDeckField(field, field.data, x, z);
    },
    solidAt(x, z) {
      const r = playerParams.capsuleRadius;
      for (const [dx, dz] of FOOTPRINT) {
        const px = x + dx * r;
        const pz = z + dz * r;
        if (!inside(px, pz)) continue;
        if (sampleDeckField(field, field.solid, px, pz) >= solidMin) return true;
      }
      return false;
    },
  };
  if (opts.ceilingAt !== undefined) surface.ceilingAt = opts.ceilingAt;
  if (opts.waterAt !== undefined) surface.waterAt = opts.waterAt;
  if (opts.boardingPoints !== undefined) surface.boardingPoints = opts.boardingPoints;
  if (opts.shipToWorld !== undefined) surface.shipToWorld = opts.shipToWorld;
  return surface;
}
