/**
 * Stream-power erosion (T112c) — Schott et al. 2023 / Braun & Willett 2013
 * implicit kernel on the bedrock grid. Pure CPU, no three imports.
 *
 *   dh/dt = U − K · A^m · S^n,  n = 1
 *
 * Per iteration: steepest-descent receivers (D8), drainage area A by one
 * sweep in descending height order, then the IMPLICIT update in ascending
 * order (downstream first, so the receiver is already at its new height):
 *   h_i ← (h_i + U_i + C·h_recv) / (1 + C),  C = K·A^m / cell
 * which is unconditionally stable for any K and keeps h_i ≥ h_recv whenever
 * it held before (so it never digs a cell under its own outlet). Cells at or
 * below sea level are base level: receiver = self, never eroded. Cells with
 * no lower neighbour are sinks (a tread, a pit) — area pools there; flats are
 * not routed through, which is deliberate: a terrace tread stays a tread.
 *
 * Determinism: fixed iteration order; the height sort is a native numeric
 * sort on unique keys (quantised height ⊕ index), so ties resolve by index.
 */
import type { ErosionContext, ErosionField, ErosionPass } from './erosion';

const NB_DX = [1, -1, 0, 0, 1, 1, -1, -1];
const NB_DZ = [0, 0, 1, -1, 1, -1, 1, -1];
const NB_D = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];
/** index bits in the sort key — 2^20 > 512² */
const KEY_IDX = 1048576;
/** height quantum for the sort key (mm) */
const KEY_Q = 1000;
/** key offset so heights down to -1000 m stay positive */
const KEY_OFF = 1000 * KEY_Q;
const KEY_MAX = 4000 * KEY_Q;

export interface Drainage {
  /** steepest-descent receiver per cell (self = sink or base level) */
  recv: Int32Array;
  /** drainage area per cell, m² (own cell included) */
  area: Float64Array;
  /** cell indices in DESCENDING height order */
  order: Int32Array;
}

/** receivers + drainage area of a height grid (sea level = base level) */
export function computeDrainage(
  h: ArrayLike<number>,
  size: number,
  cell: number,
  seaLevel = 0,
  out?: Drainage,
): Drainage {
  const n = size * size;
  const d = out ?? {
    recv: new Int32Array(n),
    area: new Float64Array(n),
    order: new Int32Array(n),
  };
  const keys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const q = Math.min(Math.max(Math.round(h[i] * KEY_Q) + KEY_OFF, 0), KEY_MAX);
    keys[i] = (KEY_MAX - q) * KEY_IDX + i;
  }
  keys.sort();
  for (let k = 0; k < n; k++) d.order[k] = keys[k] % KEY_IDX;
  for (let iz = 0; iz < size; iz++) {
    for (let ix = 0; ix < size; ix++) {
      const i = iz * size + ix;
      let best = i;
      let bestS = 0;
      if (h[i] > seaLevel) {
        for (let k = 0; k < 8; k++) {
          const jx = ix + NB_DX[k];
          const jz = iz + NB_DZ[k];
          if (jx < 0 || jz < 0 || jx >= size || jz >= size) continue;
          const j = jz * size + jx;
          const s = (h[i] - h[j]) / NB_D[k];
          if (s > bestS) {
            bestS = s;
            best = j;
          }
        }
      }
      d.recv[i] = best;
      d.area[i] = cell * cell;
    }
  }
  for (let k = 0; k < n; k++) {
    const i = d.order[k];
    const r = d.recv[i];
    if (r !== i) d.area[r] += d.area[i];
  }
  return d;
}

/** one implicit stream-power iteration on `field.bedrock` */
export function streamPowerStep(field: ErosionField, ctx: ErosionContext, dr?: Drainage): Drainage {
  const { size, cell, bedrock } = field;
  const { p } = ctx;
  const d = computeDrainage(bedrock, size, cell, ctx.seaLevel, dr);
  const m = p.streamAreaExp;
  const n = size * size;
  for (let k = n - 1; k >= 0; k--) {
    const i = d.order[k];
    const e = ctx.erodible[i];
    if (e <= 0) continue;
    const r = d.recv[i];
    const U = p.streamUplift * ctx.uplift[i] * e;
    if (r === i) {
      bedrock[i] += U;
      continue;
    }
    const C = (p.streamRate * Math.pow(d.area[i], m) * e) / cell;
    bedrock[i] = (bedrock[i] + U + C * bedrock[r]) / (1 + C);
  }
  return d;
}

export function streamPowerPass(iterations: number): ErosionPass {
  let dr: Drainage | undefined;
  return {
    name: 'streamPower',
    steps: Math.max(0, Math.floor(iterations)),
    advance(field, ctx) {
      dr = streamPowerStep(field, ctx, dr);
    },
  };
}
