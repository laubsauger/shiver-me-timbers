/**
 * Deck frame: where the §V9 solve grid sits on the ship, and which way is
 * downhill on it right now. Pure numbers, no three.js — the same reason
 * sea-physics/hullContact is engine-free, and it makes both halves testable.
 *
 * GRID ↔ SHIP AXES — src/ship's deck heightfield convention, adopted wholesale
 * (see deckHeightfield.ts's header for why nothing here transposes):
 *   grid x (0 … width−1)  = ACROSS THE BEAM,  ship +x toward starboard
 *   grid y (0 … height−1) = ALONG THE LENGTH, ship +z toward the bow
 * so uv is (u across the beam from port, v along the length from the transom),
 * and the talk's 512 × 192 grid is 192 wide by 512 high.
 *
 * Everything that maps a position onto the grid — the bow sensor's splash
 * placement, the deck material's TSL sampler — goes through this one mapping.
 * Two independent copies of it would put the water and its shading in
 * different places and no test would notice.
 */
import { invRotateVec } from '../core/quat';
import type { Quat } from '../state/simState';

/** the ship-space rectangle the grid covers (metres, ship-local) */
export interface DeckFrame {
  /** ship-local x of the grid's port edge (u = 0) */
  minX: number;
  /** ship-local x of the grid's starboard edge (u = 1) */
  maxX: number;
  /** ship-local z of the grid's aft edge (v = 0) */
  minZ: number;
  /** ship-local z of the grid's forward edge (v = 1) */
  maxZ: number;
  /** ship-local y of the deck's walking surface — the field's height 0 */
  planeY: number;
}

/** true when every field is finite and the frame has real extent (§V28) */
export function isValidDeckFrame(f: DeckFrame): boolean {
  return (
    Number.isFinite(f.minX) &&
    Number.isFinite(f.maxX) &&
    Number.isFinite(f.minZ) &&
    Number.isFinite(f.maxZ) &&
    Number.isFinite(f.planeY) &&
    f.maxX > f.minX &&
    f.maxZ > f.minZ
  );
}

/** ship-local (x, z) → deck uv, unclamped so callers can see the overhang */
export function deckUv(localX: number, localZ: number, f: DeckFrame): [number, number] {
  // §V28: floored divisors — a degenerate frame must not emit NaN uv, which
  // would splash at an undefined cell and poison the whole state texture
  const beam = Math.max(1e-6, f.maxX - f.minX);
  const length = Math.max(1e-6, f.maxZ - f.minZ);
  return [(localX - f.minX) / beam, (localZ - f.minZ) / length];
}

/**
 * Downhill direction of the deck plane in GRID axes, as the outflow pass
 * wants it: `[acrossBeam, alongLength]`, magnitude = sin(tilt), 0 when she is
 * upright. This is the whole reason the water reads as a fluid rather than a
 * decal — on a level deck it only follows the camber and the waterway, but
 * under heel and pitch it runs to the low rail and sloshes back as she rolls
 * through.
 *
 * Derivation: gravity is (0,−1,0) in world. Rotated into ship space by the
 * inverse of the hull's orientation, its component INSIDE the deck plane
 * (ship-local x and z; the y component just presses the water down) is the
 * slope the water feels. Grid axes then follow the mapping in the header.
 */
export function deckTiltGradient(q: Quat): [number, number] {
  const g = invRotateVec(q, [0, -1, 0]);
  // §V28: a non-finite pose must land on "level", not push NaN into a uniform
  // that every cell of the solve then multiplies by (§B.5's failure mode)
  if (!Number.isFinite(g[0]) || !Number.isFinite(g[2])) return [0, 0];
  return [g[0], g[2]];
}
