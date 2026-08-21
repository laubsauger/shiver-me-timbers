/**
 * Terrain → WalkSurface adapter (§T.100): the ground ashore, in WORLD
 * coordinates. The deck adapter (`deckSurface.ts`) is ship-local and rides
 * the hull; this one is static terrain — `Island.heightAt` (§V90) or any
 * `groundAt` — so it carries NO `shipToWorld`: the walker's `pos` IS world
 * while `frame === 'world'`, and `goOverboard` from here is an identity
 * transform into the swim frame.
 *
 * Ground under more than `swimDepth` of water is not ground: `heightAt`
 * returns null there and the walker swims (the same edge the deck mask
 * gives outboard). Slope steeper than `terrainSlopeDeg` anywhere in the
 * capsule footprint is a wall — in EVERY direction, not only uphill, since
 * a 40° bank is no more walkable going down it — measured by central
 * finite differences on the live height function, so the rule follows
 * whatever terrain the island agent ships. `obstacleAt` is the hook for
 * clue props (§T.104) and anything else solid that is not terrain.
 */
import { playerParams, type PlayerParams } from '../params/player';
import type { WalkSurface } from './playerStep';

export interface TerrainSurfaceOptions {
  /** WORLD ground height at (x,z); null where there is no terrain at all */
  groundAt: (x: number, z: number) => number | null;
  /** WORLD sea-surface height; absent = flat sea at y = 0 */
  waterAt?: (x: number, z: number) => number;
  /** solid non-terrain things (props); absent = none */
  obstacleAt?: (x: number, z: number) => boolean;
  /** finite-difference half-step for the slope, m */
  gradientStep?: number;
}

/** the four compass points of the capsule footprint plus its centre */
const FOOTPRINT: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const fin = (v: number | null): v is number => v !== null && Number.isFinite(v);

/** |∇h| at (x,z) by central differences; Infinity when terrain ends inside the stencil */
export function terrainSlopeAt(
  groundAt: (x: number, z: number) => number | null,
  x: number,
  z: number,
  step: number,
): number {
  const hx0 = groundAt(x - step, z);
  const hx1 = groundAt(x + step, z);
  const hz0 = groundAt(x, z - step);
  const hz1 = groundAt(x, z + step);
  if (!fin(hx0) || !fin(hx1) || !fin(hz0) || !fin(hz1)) return Infinity;
  return Math.hypot((hx1 - hx0) / (2 * step), (hz1 - hz0) / (2 * step));
}

export function createTerrainSurface(o: TerrainSurfaceOptions, p: PlayerParams = playerParams): WalkSurface {
  const waterAt = o.waterAt ?? ((): number => 0);
  const step = o.gradientStep ?? 0.25;
  const tanMax = (): number => Math.tan((p.terrainSlopeDeg * Math.PI) / 180);
  const surface: WalkSurface = {
    heightAt(x, z) {
      const g = o.groundAt(x, z);
      if (!fin(g)) return null;
      if (g < waterAt(x, z) - p.swimDepth) return null;
      return g;
    },
    solidAt(x, z) {
      const r = p.capsuleRadius;
      const lim = tanMax();
      for (const [dx, dz] of FOOTPRINT) {
        const px = x + dx * r;
        const pz = z + dz * r;
        if (o.obstacleAt?.(px, pz) === true) return true;
        const g = o.groundAt(px, pz);
        if (!fin(g)) continue; // off the terrain is water, not wall
        if (terrainSlopeAt(o.groundAt, px, pz, step) > lim) return true;
      }
      return false;
    },
    ceilingAt: () => null,
    waterAt,
    speedAt(x, z) {
      // linear from full speed on the flat to `slopeSlowdown` at the limit
      const s = terrainSlopeAt(o.groundAt, x, z, step);
      if (!Number.isFinite(s)) return 1;
      const t = Math.min(1, s / Math.max(1e-6, tanMax()));
      return 1 + (p.slopeSlowdown - 1) * t;
    },
  };
  return surface;
}
