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
  /** head units added per unit tilt gradient component */
  tiltBiasStrength: number;
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
  let total = 0;
  for (let i = 0; i < 4; i++) {
    const [dx, dy] = DIRECTIONS[i];
    const nHead = neighborHeads[i] ?? EDGE_DRAIN_HEAD;
    const bias = p.tiltBiasStrength * (tiltGradient[0] * dx + tiltGradient[1] * dy);
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
): CellResolve {
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
