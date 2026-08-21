/**
 * Debris layer (T112c): rockfall source + Musgrave thermal erosion, and the
 * same operator on bedrock as the final smoothing pass. Pure CPU.
 *
 * Musgrave, Kolb, Mace 1989: per cell, the excess of the total height over
 * every lower neighbour beyond the repose threshold `tan(repose)·dist` is
 * moved downhill, split across the lower neighbours in proportion to their
 * excess. DOUBLE-BUFFERED (deltas accumulate into a scratch buffer and are
 * applied after the sweep), so the result is independent of sweep order and
 * exactly mass-conserving: every unit leaving a cell lands in a neighbour.
 * Half the largest excess per step keeps two facing cells from swapping.
 *
 * The beach guard: debris only moves INTO cells the erodible mask admits, so
 * talus stops at the top of the DG-sand band and §V90's ≤15° beach is never
 * buried under a 35° apron.
 */
import type { ErosionContext, ErosionField, ErosionPass } from './erosion';

const NB_DX = [1, -1, 0, 0, 1, 1, -1, -1];
const NB_DZ = [0, 0, 1, -1, 1, -1, 1, -1];
const NB_D = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

/**
 * Rockfall: steep bedrock sheds material into the debris layer. Amount per
 * step ∝ (slope − rockfallSlope)⁺ · cell · joint density; bedrock loses
 * exactly what debris gains.
 */
export function rockfallStep(field: ErosionField, ctx: ErosionContext): void {
  const { size, cell, bedrock, debris } = field;
  const { p } = ctx;
  const inv = 1 / (2 * cell);
  for (let iz = 1; iz < size - 1; iz++) {
    for (let ix = 1; ix < size - 1; ix++) {
      const i = iz * size + ix;
      const e = ctx.erodible[i];
      if (e <= 0) continue;
      const gx = (bedrock[i + 1] - bedrock[i - 1]) * inv;
      const gz = (bedrock[i + size] - bedrock[i - size]) * inv;
      const excess = Math.hypot(gx, gz) - p.rockfallSlope;
      if (excess <= 0) continue;
      const amount = p.rockfallRate * excess * cell * (0.3 + 0.7 * ctx.joint[i]) * e;
      bedrock[i] -= amount;
      debris[i] += amount;
    }
  }
}

/**
 * One thermal step of `layer` against the total surface (bedrock + debris),
 * at `repose` (tan). `movable[i]` caps what cell i may shed (its debris for
 * the talus pass, unbounded for the bedrock smoothing). Returns nothing; the
 * layer is updated in place after the double-buffered sweep.
 */
export function thermalStep(
  field: ErosionField,
  ctx: ErosionContext,
  layer: Float64Array,
  movable: Float64Array | null,
  repose: number,
): void {
  const { size, cell, bedrock, debris } = field;
  const n = size * size;
  const delta = ctx.scratch;
  delta.fill(0);
  const diffs = new Float64Array(8);
  for (let iz = 0; iz < size; iz++) {
    for (let ix = 0; ix < size; ix++) {
      const i = iz * size + ix;
      const cap = movable ? movable[i] : Infinity;
      if (cap <= 0 || ctx.erodible[i] <= 0) continue;
      const hi = bedrock[i] + debris[i];
      let total = 0;
      let maxDiff = 0;
      for (let k = 0; k < 8; k++) {
        diffs[k] = 0;
        const jx = ix + NB_DX[k];
        const jz = iz + NB_DZ[k];
        if (jx < 0 || jz < 0 || jx >= size || jz >= size) continue;
        const j = jz * size + jx;
        if (ctx.erodible[j] <= 0) continue;
        const diff = hi - (bedrock[j] + debris[j]) - repose * NB_D[k] * cell;
        if (diff <= 0) continue;
        diffs[k] = diff;
        total += diff;
        if (diff > maxDiff) maxDiff = diff;
      }
      if (total <= 0) continue;
      const move = Math.min(cap, 0.5 * maxDiff);
      delta[i] -= move;
      for (let k = 0; k < 8; k++) {
        if (diffs[k] <= 0) continue;
        const j = (iz + NB_DZ[k]) * size + ix + NB_DX[k];
        delta[j] += (move * diffs[k]) / total;
      }
    }
  }
  for (let i = 0; i < n; i++) layer[i] += delta[i];
}

/** rockfall source then talus settling at `talusRepose`; one rockfall per `rockfallEvery` steps */
export function rockfallThermalPass(iterations: number): ErosionPass {
  return {
    name: 'rockfallThermal',
    steps: Math.max(0, Math.floor(iterations)),
    advance(field, ctx, i) {
      if (i < ctx.p.rockfallSteps) rockfallStep(field, ctx);
      thermalStep(field, ctx, field.debris, field.debris, ctx.p.talusRepose);
    },
  };
}

/** bedrock-only thermal at a steep repose: takes the one-cell spikes off the channel walls */
export function thermalSmoothPass(iterations: number): ErosionPass {
  return {
    name: 'thermalSmooth',
    steps: Math.max(0, Math.floor(iterations)),
    advance(field, ctx) {
      thermalStep(field, ctx, field.bedrock, null, ctx.p.smoothRepose);
    },
  };
}
