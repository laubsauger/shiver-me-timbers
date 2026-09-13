/**
 * THE MULTI-TICK KICK, STEPPER SIDE (§T.181 S0, §V2, §V110). One function every transport runs in place of
 * `core.step(L)` — the main-thread transport in `kick`, the SAB worker loop and the transferable tick in
 * `workerHost` — so the three cannot disagree on how a batch is unrolled (§V95).
 *
 * A kick with COUNT = 0 (or a layout without a BATCH region) is exactly one `core.step(L)` on the slots main wrote:
 * the pre-§T.181 contract, byte for byte. A kick with COUNT = n unrolls n ticks; before tick j it copies ROW j into
 * the very slots a one-tick kick for that tick would have written, and calls the UNCHANGED `BoatSimCore.step`:
 *   TICK, TIME                           row tick, row time (the exact float64 SimState.time of that page tick)
 *   CONTACT_OFF_MASK                     row mask (§T.188: a placed boat is contact-off on its first tick only)
 *   OCEAN, SEA                           row params; PARAMS_VERSION bumped iff a leaf differs (`writeParams` rule)
 *   CONTROLS (+ AI IN) of every boat     row inputs
 *   WORLD                                j ≥ 1 on a single-shard layout: every boat's OUT pose after tick j−1, which
 *                                        is what main's `kick` copies in before a one-tick kick. With several
 *                                        shards the other shards' poses are not visible mid-batch, so WORLD stays
 *                                        the batch-start snapshot (the fleet caps batches at 1 when a WORLD reader —
 *                                        the §T.186 pilot — runs on several shards)
 *   PREV POSE                            each owned boat's OUT pose just before the last tick (render pair)
 * Not carried per row: RESET requests (applied on the batch's first tick, as on a one-tick kick).
 */
import { BATCH_ROW, B, CONTROL_LEN, F, H, POSE_LEN, AI_IN_LEN, AI_OUT_LEN, type BoatSimLayout } from './layout';

export interface BatchStepper {
  step(L: BoatSimLayout): void;
}

/** ticks in the kick currently in the buffer (0 = classic one-tick kick) */
export function batchCount(L: BoatSimLayout): number {
  return L.spec.batchCap ? L.f64[L.batchOffset()] : 0;
}

function applyRow(L: BoatSimLayout, j: number): void {
  const f = L.f64;
  const r = L.batchRowOffset(j);
  L.i32[H.TICK] = f[r + BATCH_ROW.TICK];
  f[F.TIME] = f[r + BATCH_ROW.TIME];
  L.i32[H.CONTACT_OFF_MASK] = f[r + BATCH_ROW.CONTACT_OFF_MASK] | 0;
  const n = L.spec.oceanLen + L.spec.seaLen;
  const src = r + BATCH_ROW.PARAMS;
  let changed = false;
  for (let k = 0; k < n; k++) {
    const x = f[src + k];
    if (!Object.is(f[L.oceanOffset + k], x)) {
      f[L.oceanOffset + k] = x;
      changed = true;
    }
  }
  if (changed) L.i32[H.PARAMS_VERSION]++;
  const ai = L.spec.aiLen ? AI_IN_LEN : 0;
  for (let i = 0; i < L.spec.boats; i++) {
    const s = L.batchBoatInputOffset(r, i);
    const c = L.boatOffset(i) + B.CONTROLS;
    for (let k = 0; k < CONTROL_LEN; k++) f[c + k] = f[s + k];
    if (ai) {
      const a = L.aiOffset(i) + AI_OUT_LEN;
      for (let k = 0; k < ai; k++) f[a + k] = f[s + CONTROL_LEN + k];
    }
  }
}

/** step whatever kick is in the buffer: one tick (COUNT 0) or COUNT ticks, row by row */
export function stepKick(core: BatchStepper, L: BoatSimLayout): number {
  const count = batchCount(L);
  if (!(count > 0)) {
    core.step(L);
    return 1;
  }
  const cap = L.spec.batchCap ?? 0;
  if (!Number.isInteger(count) || count > cap) throw new Error(`sim batch: count ${count} outside [1, ${cap}]`);
  const f = L.f64;
  const start = L.i32[H.SHARD_START];
  const end = L.i32[H.SHARD_END];
  const whole = start === 0 && end === L.spec.boats;
  for (let j = 0; j < count; j++) {
    applyRow(L, j);
    if (j > 0 && whole) {
      for (let i = 0; i < L.spec.boats; i++) {
        const from = L.boatOffset(i) + B.POSE;
        const to = L.worldPoseOffset(i);
        for (let c = 0; c < POSE_LEN; c++) f[to + c] = f[from + c];
      }
    }
    if (j === count - 1) {
      for (let i = start; i < end; i++) {
        const from = L.boatOffset(i) + B.POSE;
        const to = L.batchPrevPoseOffset(i);
        for (let c = 0; c < POSE_LEN; c++) f[to + c] = f[from + c];
      }
    }
    core.step(L);
  }
  return count;
}
