/**
 * RAFT DECK FIELD (§T92, §V83) — the raft's own `DeckHeightfield` writer.
 *
 * Same type, same 512 × 192 grid and the same two consumers as the planked
 * ships' writer (deckHeightfield.ts): deckFieldTexture.ts packs it for the
 * deck material and the deck-water solver unchanged, and the player's
 * deckSurface.ts walks it unchanged. Nothing of the planked writer applies —
 * no camber, waterway, bulwark ring or plank jitter — so this is a separate
 * module rather than a branch in it (§V83: ⊥ the planked-camber writer).
 *
 * THREE SURFACES AT THREE HEIGHTS, round logs between. `deckY` (height 0) is
 * the crown of the tallest log — the raft's primary walking surface, bare
 * aft and port of the cabin. Bamboo mats sit a crossbeam diameter + mat
 * above it (fore deck + starboard strip); the cabin floor a box height above
 * the mats. The geometry of each is read from the PIECES (deck-*, cabin-*,
 * crossbeam-*, crates …) and the log field from raftLayout, so the field
 * cannot disagree with what is drawn.
 *
 * `mask` — the water domain — is 1 everywhere inside the hull outline (logs,
 * chinks, mats, cabin) and 0 outboard. Both consumers cut this channel at
 * 0.5: deckwater (`maskDrainBelow`) makes anything below it a sink, and the
 * walker (`maskThreshold`) makes anything below it "no ground". A chink
 * texel marked as a drain would therefore also be a hole the player falls
 * through, so "chinks drain" (T92) is realised as the HEIGHT dip along each
 * seam — water runs off the crowns and pools in the chink lines — not as a
 * drain cell. Water leaving the raft leaves over the outer logs' edges and
 * the stern, which are real edges (§V85).
 *
 * `plank` is zero: the logs' roundness IS the structure and lives in `data`;
 * the log material owns its own grain relief.
 *
 * `solid` = cabin walls (starboard doorway open), the bipod legs, mizzen and
 * flag poles, guara planks, crates, jerrycans, dinghy, drum, kitchen box,
 * stern block. Foot-rails and crossbeams are NOT solid: they are stepped
 * over (≤ 0.3 m bumps).
 */
import { SOLID_UNBOUNDED } from './deckHeightfield';
import type { PieceDef, Vec3 } from './pieceTypes';
import { DECK_FIELD_BEAM, DECK_FIELD_LENGTH, type DeckHeightfield } from './deckHeightfield';
import { raftParams, type RaftParams } from '../params/raft';
import { raftLayout } from './raftPartsLayout';
import { raftStructureAt, readRaftField, type RaftFieldLayout } from './raftDeckFieldCells';

export { RAFT_FOOT_RADIUS, RAFT_WALK_SLOPE } from './raftDeckFieldCells';

/** spacing of the climb-back points along the foot-rails and the stern */
const BOARDING_PITCH = 1.0;

/**
 * Build the raft's field from its piece graph. Pure and deterministic (§V2:
 * every number comes from the params + variation hashes); a few ms for the
 * default grid, paid once per raft.
 */
export function buildRaftDeckField(
  blueprint: PieceDef[],
  p: RaftParams = raftParams,
  opts: { width?: number; height?: number } = {},
): DeckHeightfield {
  const F = readRaftField(blueprint, p);
  // §V28: dimensions are sanitised construction-time ints
  const width = Math.max(8, Math.min(2048, Math.round(opts.width ?? DECK_FIELD_BEAM)));
  const height = Math.max(8, Math.min(4096, Math.round(opts.height ?? DECK_FIELD_LENGTH)));
  const { minX, maxX, minZ, maxZ, deckY } = F;
  const texelX = (maxX - minX) / width;
  const texelZ = (maxZ - minZ) / height;
  const data = new Float32Array(width * height);
  const plank = new Float32Array(width * height);
  const mask = new Float32Array(width * height);
  const solid = new Float32Array(width * height);
  // §T.158: metres relative to deckY, like `data` — see DeckHeightfield.solidTop
  const solidTop = new Float32Array(width * height);
  // a 25 mm guara plank or a 50 mm wall must own at least one whole texel,
  // or the bilinear `solid` sample never reaches the walker's 0.5
  const padX = texelX * 0.5;
  const padZ = texelZ * 0.5;
  for (let j = 0; j < height; j++) {
    const z = minZ + (j + 0.5) * texelZ;
    for (let i = 0; i < width; i++) {
      const x = minX + (i + 0.5) * texelX;
      const k = j * width + i;
      const c = raftStructureAt(F, x, z, padX, padZ);
      data[k] = c.y - deckY;
      mask[k] = c.mask;
      solid[k] = c.solid;
      solidTop[k] = c.solidTop >= SOLID_UNBOUNDED ? SOLID_UNBOUNDED : c.solidTop - deckY;
    }
  }
  return {
    width, height, minX, maxX, minZ, maxZ, texelX, texelZ, deckY,
    data, plank, mask, solid, solidTop,
  };
}

/**
 * Underside of the cabin roof in ship space, for `WalkSurface.ceilingAt`:
 * a gable from the eave at the walls to the ridge on the centreline, above
 * the cabin floor. Null outside the cabin footprint (open sky — the roof
 * overhang is ignored: nobody stands under 0.25 m of thatch edge).
 */
export function createRaftCeiling(p: RaftParams = raftParams): (x: number, z: number) => number | null {
  const L = raftLayout(p);
  const hw = p.cabinWidth / 2;
  const eaveY = L.cabinFloorY + p.cabinEave;
  const ridgeY = L.cabinFloorY + p.cabinRidge;
  return (x, z) => {
    if (!(Math.abs(x) <= hw && z >= L.cabinAftZ && z <= L.cabinFrontZ)) return null;
    return eaveY + (ridgeY - eaveY) * (1 - Math.abs(x) / hw);
  };
}

const ceilingCache = new WeakMap<RaftParams, (x: number, z: number) => number | null>();

/** `createRaftCeiling` for a params object, memoised — the default raft's roof */
export function raftCeilingAt(x: number, z: number, p: RaftParams = raftParams): number | null {
  let f = ceilingCache.get(p);
  if (f === undefined) {
    f = createRaftCeiling(p);
    ceilingCache.set(p, f);
  }
  return f(x, z);
}

/**
 * Ship-local points a swimmer can climb back aboard at (`WalkSurface.
 * boardingPoints`): every metre along both foot-rails, on the rail's crown,
 * and along the bare stern logs just forward of the square stern.
 */
export function raftBoardingPoints(blueprint: PieceDef[], p: RaftParams = raftParams): Vec3[] {
  const F = readRaftField(blueprint, p);
  const at = (x: number, z: number): Vec3 => [x, raftStructureAt(F, x, z).y, z];
  const out: Vec3[] = [];
  for (const bar of F.bars) {
    if (bar.axis !== 'z') continue; // foot-rails only
    for (let z = bar.lo + 0.3; z <= bar.hi - 0.3 + 1e-6; z += BOARDING_PITCH) out.push(at(bar.at, z));
  }
  const sternZ = F.L.sternZ + 0.3;
  const halfBeam = F.L.halfBeam;
  for (let x = -halfBeam; x <= halfBeam + 1e-6; x += BOARDING_PITCH) out.push(at(x, sternZ));
  return out;
}

export type { RaftFieldLayout };
