/**
 * Pure CPU mirror of one deck-water cell's Mei et al. 2007 two-pass update
 * (§V9). Exactly the math the TSL compute passes run on the GPU
 * (outflowPass.ts / inflowPass.ts) so vitest can verify the hydraulic model:
 * downhill flow, tilt-biased slosh, outflow ≤ volume, evaporation drying.
 * Keep both sides in lockstep when editing.
 */

/**
 * Neighbor order used everywhere (matches outflow texture RGBA packing):
 * index 0 = N (y-1), 1 = E (x+1), 2 = S (y+1), 3 = W (x-1).
 */
export const DIRECTIONS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/** hydraulic head outside the deck — "leaky deck" (§V9): edges always drain */
export const EDGE_DRAIN_HEAD = 0;

export interface OutflowParams {
  /** fraction of head difference moved this step (already dt-scaled) */
  fluxRate: number;
  /**
   * DIMENSIONLESS artistic gain on the rotation bias. 1 = the true physical
   * slope. It is not a head offset: see `cellSize`.
   */
  tiltBiasStrength: number;
  /**
   * Metres per cell in grid x and y. The tilt gradient is a SLOPE (rise over
   * run, = sin of the tilt), so the head a tilted deck drops between two
   * neighbouring cells is slope × the distance between them. Leaving the cell
   * size out treats the slope as though it were a head drop of that many
   * METRES per cell, which on this grid overdrives heel by ~5× and makes it
   * ~30× the deck's own camber gradient — the water then ignores the camber,
   * the waterway and every coaming, and slides across the deck as one
   * uniform sheet. Defaults to 1 m cells so the pure unit tests read as
   * plain slope arithmetic.
   */
  cellSize?: readonly [number, number];
  /**
   * Hydraulic head presented by everything that is not deck — off the grid,
   * and (on the GPU) every drain cell. MUST sit below the lowest point of the
   * deck: the ship's field measures heights relative to the deck plane and
   * the waterway gutter is NEGATIVE, so a drain left at datum would stand
   * higher than the gutter and the water would pool in it forever instead of
   * running out through the freeing ports. Defaults to EDGE_DRAIN_HEAD.
   */
  drainHead?: number;
}

export interface ResolveParams {
  /** volume evaporated this step (already dt-scaled) */
  evapVolume: number;
  /** wetness evaporated this step (already dt-scaled) */
  evapWetness: number;
  /** volume → wetness gain */
  wetnessGain: number;
}

export type Flux4 = [number, number, number, number];

/**
 * Pass 1 (outflow): flux to each neighbor ∝ max(0, head difference), where
 * head = deckHeight + volume. Ship tilt adds a directional slope so water
 * slides toward the low side as the ship rocks (§V9 "crucial logic").
 * `neighborHeads[i]` is deck+volume of neighbor i, or null when the neighbor
 * is off the deck (flux then drains against EDGE_DRAIN_HEAD).
 * Total outflow is scaled so it never exceeds the available volume.
 */
export function computeOutflow(
  deck: number,
  volume: number,
  neighborHeads: readonly (number | null)[],
  tiltGradient: readonly [number, number],
  p: OutflowParams,
): Flux4 {
  const head = deck + volume;
  const flux: Flux4 = [0, 0, 0, 0];
  const [cellX, cellY] = p.cellSize ?? [1, 1];
  let total = 0;
  for (let i = 0; i < 4; i++) {
    const [dx, dy] = DIRECTIONS[i];
    const nHead = neighborHeads[i] ?? p.drainHead ?? EDGE_DRAIN_HEAD;
    // slope × the distance actually travelled — see OutflowParams.cellSize
    const bias =
      p.tiltBiasStrength *
      (tiltGradient[0] * dx * cellX + tiltGradient[1] * dy * cellY);
    const f = Math.max(0, (head - nHead + bias) * p.fluxRate);
    flux[i] = f;
    total += f;
  }
  // clamp: a cell can never emit more water than it holds (no negative water)
  const scale = total > volume ? volume / total : 1;
  for (let i = 0; i < 4; i++) flux[i] *= scale;
  return flux;
}

export interface CellResolve {
  volume: number;
  wetness: number;
}

/**
 * Pass 2 (inflow + resolve): gather neighbor fluxes aimed at this cell,
 * subtract own outflow, then evaporate. Wetness ratchets up from standing
 * water (max) and decays independently, so planks stay visually wet after
 * the water itself has drained/evaporated, and eventually dry (§V9).
 */
export function applyInflow(
  volume: number,
  wetness: number,
  outflow: Readonly<Flux4>,
  inflowSum: number,
  p: ResolveParams,
  /**
   * DeckField.drain: this cell is off the deck outline, a scupper cut or an
   * open hatchway. Water that reaches it has left the ship, so it holds none
   * — which makes it a permanent low-head sink its neighbours pour into,
   * without the outflow pass needing to know anything about masks.
   */
  drain = false,
): CellResolve {
  if (drain) return { volume: 0, wetness: 0 };
  const outSum = outflow[0] + outflow[1] + outflow[2] + outflow[3];
  const settled = Math.max(0, volume - outSum + inflowSum);
  let wet = Math.max(wetness, Math.min(1, settled * p.wetnessGain));
  const vol = Math.max(0, settled - p.evapVolume);
  wet = Math.max(0, wet - p.evapWetness);
  return { volume: vol, wetness: wet };
}

/**
 * The inflow a cell receives is each neighbor's flux component pointing back
 * at it: N neighbor's S flux, E neighbor's W flux, S neighbor's N flux,
 * W neighbor's E flux. `neighborOutflows[i]` is the Flux4 of neighbor i
 * (null when off-deck: nothing flows in from beyond the edge).
 */
export function gatherInflow(neighborOutflows: readonly (Readonly<Flux4> | null)[]): number {
  // neighbor 0 (N) sends via its S component (2); neighbor 1 (E) via W (3);
  // neighbor 2 (S) via N (0); neighbor 3 (W) via E (1).
  const senders = [2, 3, 0, 1] as const;
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const nf = neighborOutflows[i];
    if (nf) sum += nf[senders[i]];
  }
  return sum;
}
