/**
 * THE BOAT SIM BUFFER (§T.178, §V110). One flat buffer per stepper shard, the same
 * layout whether it is a SharedArrayBuffer (Atomics handshake), an ArrayBuffer
 * ping-ponged to a worker as a transferable, or an ArrayBuffer stepped in-process on
 * the main thread. The step core reads and writes ONLY this layout, so the three
 * transports cannot differ in what they carry — only in how the bytes move (§V95).
 *
 * Byte map (every region 8-byte aligned; `f64` indexes the whole buffer in 8-byte units):
 *
 *   [0, 64)           Int32 header, 16 slots — see `H`
 *   f64[8 .. 16)      Float64 header, 8 slots — see `F`
 *   OCEAN             oceanLen   f64  flattened OceanParams for tick k   (main writes, stepper reads)
 *   SEA               seaLen     f64  flattened SeaPhysicsParams          (main writes, stepper reads)
 *   WORLD             boats×13   f64  every boat's pose at tick k         (main writes, stepper READ-ONLY)
 *   BOAT i            BOAT_FIXED + wakeCap×5 f64 per boat:
 *     IN   controls[4], resetSeq, resetPose[13]                           (main writes)
 *     OUT  pose[13], contact summary, effects record (§T.195 fx.ts), wake load samples (stepper writes, main reads)
 *   (optional regions follow: AI per boat, BATCH, TRACE, WAKE WORLD + WAKE OUT — §T.207 `wakeRegionLength`)
 *
 * OWNERSHIP IS BY REGION, NOT BY LOCK. Between `kick` and `done` the main thread must not
 * touch the buffer; outside that window the stepper does not. A shard's stepper writes the
 * OUT block of its own boats [SHARD_START, SHARD_END) only, so several workers never write
 * the same byte.
 *
 * CROSS-BOAT DATA (T170/S6, designed here, not used yet). WORLD is the tick-k snapshot of
 * every boat's pose, copied in by the main thread before the kick. A stepper that needs
 * another boat (collision proxy, wake riding) reads WORLD, never another shard's OUT block:
 * OUT blocks are being written concurrently by other workers, WORLD is frozen for the tick,
 * so the result is a function of tick-k inputs only (§V2) regardless of which worker a boat
 * lives on. §T.207 the wake every hull feels follows the same rule: WAKE WORLD holds every
 * boat's compact wake record (src/wake/wakeField.ts), frozen for the tick like WORLD.
 */

import { FX_LEN } from './fx';
import { WAKE_SRC_LEN } from '../wake/wakeField';

/** 13 channels, the order rigid6 owns them in: position 3, quaternion 4, velocity 3, angularVelocity 3 */
export const POSE_LEN = 13;
export const CONTROL_LEN = 4;
/** per wake load sample: x, z, fy, sigma, depth (hullWater WakeLoadSamples) */
export const WAKE_SAMPLE_LEN = 5;

export const LAYOUT_MAGIC = 0x0b0a7178;
/** 2: §T.191 grew the Float64 header by 4 slots (external boats, trace) — every region moved by 32 bytes, OUT content unchanged */
/** 3: §T.195 the boat block carries the EFFECTS record (`B.FX`, fx.ts) before the wake samples — `B.WAKE` moved by FX_LEN */
export const LAYOUT_VERSION = 3;

/** Int32 header slots */
export const H = {
  MAGIC: 0,
  VERSION: 1,
  BOATS: 2,
  WAKE_CAP: 3,
  OCEAN_LEN: 4,
  SEA_LEN: 5,
  /** main → stepper: sequence number of the tick handed over (Atomics.notify on this slot) */
  KICK: 6,
  /** stepper → main: sequence number of the last tick finished (Atomics.notify on this slot) */
  DONE: 7,
  /** sim tick index k whose inputs are in the buffer */
  TICK: 8,
  /** bumped by main whenever OCEAN or SEA changed */
  PARAMS_VERSION: 9,
  SHARD_START: 10,
  SHARD_END: 11,
  /** STATUS_* */
  STATUS: 12,
  /** per-boat AI block length (0 = no NPC pilot in this layout; AI_BLOCK_LEN otherwise) — §T.186 */
  AI_LEN: 13,
  /**
   * §T.188 main → stepper: bit i set ⇒ boat i makes and receives no boat↔boat contact this tick (respawn ghost, or
   * placed since the last kick — its WORLD pose is the pre-teleport one). One mask every shard reads, so both boats
   * of a pair agree (§V2). Boats ≥ 32 cannot collide (sea-physics/boatCollide throws).
   */
  CONTACT_OFF_MASK: 14,
  /** §T.181 multi-tick kick: rows in the BATCH region (0 = no batch region; the layout is byte-identical to before) */
  BATCH_CAP: 15,
} as const;
export const HEADER_I32 = 16;

export const STATUS_OK = 0;
export const STATUS_ERROR = 1;
/** main asks a blocking stepper loop to exit */
export const KICK_STOP = -1;

/** Float64 header slots (absolute f64 indices) */
export const F = {
  TIME: 8,
  /** stepper wall time for the last tick, ms — telemetry, NOT part of the state hash */
  STEP_MS: 9,
  /** fidelity the stepper actually runs at, published by the stepper (§V110 evidence) */
  PATCH_SPACING: 10,
  PATCH_MARGIN: 11,
  PATCH_MAX_AXIS: 12,
  MIRROR_RESOLUTION: 13,
  INVERSE_DISPLACEMENT_ITERATIONS: 14,
  UPDATE_EVERY_TICKS: 15,
  /** §T.191 main-written at construction: the LAST n boats are EXTERNAL (main-driven poses, never stepped) */
  EXTERNAL_BOATS: 16,
  /** §T.191 main-written at construction: TRACE_LEN when the layout carries a TRACE region, else 0 */
  TRACE_LEN: 17,
  /**
   * §T.198 main → stepper: bit i set ⇒ boat i's boat↔boat contacts this tick are SOFT (sea-physics/boatCollide
   * `softMask`: the rolling-start formation's gentle separation). A uint32 held exactly in a double; one value every
   * shard reads, so both boats of a pair agree (§V2). Ghosts (CONTACT_OFF_MASK) win over it.
   */
  CONTACT_SOFT_MASK: 18,
  /** §T.207 main-written at construction: WAKE_SRC_LEN when the layout carries the WAKE regions, else 0 */
  WAKE_SRC_LEN: 19,
} as const;
const HEADER_END_F64 = 20;

/** boat block slots, relative to `boatOffset(i)` */
export const B = {
  CONTROLS: 0, // throttle, steer, trim, Surge boost (§T.207: engine boost multiplier, ≤ 1 = stock)
  RESET_SEQ: 4,
  RESET_POSE: 5,
  POSE: 18,
  SUBSTEPS: 31,
  WETTED_AREA: 32,
  DISPLACED_VOLUME: 33,
  SLAM_IMPULSE: 34,
  CAP_SCALE: 35,
  PROP_DEPTH: 36,
  PROP_IMMERSION: 37,
  PATCH_OUTSIDE: 38,
  PATCH_SAMPLES: 39,
  WAKE_COUNT: 40,
  WAKE_DEFICIT: 41,
  WAKE_RESCALE: 42,
  /** samples the contact produced beyond wakeCap (dropped — non-zero means raise the cap) */
  WAKE_OVERFLOW: 43,
  /** §T.195 the effects record: prop jets + waterline spray of this step (fx.ts, FX_LEN f64; stepper writes, hashed) */
  FX: 44,
  WAKE: 44 + FX_LEN,
} as const;
export const BOAT_FIXED = B.WAKE;

/**
 * NPC PILOT BLOCK (§T.186), appended after a boat's wake samples ONLY when the layout is built with
 * `aiLen: AI_BLOCK_LEN` (a fleet with a pilot setup). A layout without it is byte-identical to before.
 *   AI OUT  AI_OUT_LEN f64   the pilot's whole per-boat memory + its applied controls   (stepper writes, hashed)
 *   AI IN   AI_IN_LEN  f64   race standing for tick k (position, gap, state, go, …)     (main writes)
 * Slot meanings belong to src/race/ai/aiBlock.ts; this file only reserves the bytes.
 */
export const AI_OUT_LEN = 24;
export const AI_IN_LEN = 8;
export const AI_BLOCK_LEN = AI_OUT_LEN + AI_IN_LEN;

/**
 * TRACE (§T.191): per row per boat, what the page's race logic and crash machines need of a tick it never saw (a
 * rival stepped inside a multi-tick request). Written by the core after each stepped boat's step; the player's is
 * filled by the same `trace.ts writeTrace` on the page. Not hashed (OUT is).
 */
export const TR_MAX_POSITIONS = 4;
export const TR = {
  /** p3 q4 v3 ω3 after the step */
  POSE: 0,
  SUBSTEPS: 13,
  /** substep END x, z pairs (up to TR_MAX_POSITIONS; unused pairs repeat the final position) */
  POS: 14,
  WETTED: 22,
  SLAM: 23,
  PROP_IMM: 24,
  /** crash/sensors bowImmersion against the contact patch */
  BOW_IMM: 25,
  CONTACT_DV: 26,
  CONTACT_SRC: 27,
  /** body-frame point x, y, z */
  CONTACT_POINT: 28,
  CONTACT_OTHER: 31,
  /** 0/1 */
  OVERLAPS: 32,
  /** the core's fetch field version after the step (NaN without world data) */
  FETCH_VERSION: 33,
  THROTTLE: 34,
  /** normalised −1..1 applied */
  STEER: 35,
  /** §T.191 per-drive rpm of the §T.189 engine model (HullWater.driveRpm, drives 0..2; 0 past the hull's drives) — audio */
  RPM: 36,
} as const;
export const TRACE_LEN = 39;
/** drives whose rpm the trace carries */
export const TR_RPM_DRIVES = 3;

export interface LayoutSpec {
  boats: number;
  wakeCap: number;
  oceanLen: number;
  seaLen: number;
  /** 0/absent = no NPC pilot block; AI_BLOCK_LEN = one per boat (§T.186) */
  aiLen?: number;
  /** 0/absent = no BATCH region (one tick per kick only); n = up to n ticks per kick (§T.181) */
  batchCap?: number;
  /** §T.191: the LAST n boats are external (main writes their pose; no core steps them); batch rows carry their pose */
  externalBoats?: number;
  /** §T.191: a TRACE region, max(1, batchCap) rows × boats × TRACE_LEN */
  trace?: boolean;
  /**
   * §T.207 wakes move every boat: a WAKE WORLD region (boats × WAKE_SRC_LEN, every boat's wake record at tick k — main
   * writes, stepper READ-ONLY, like WORLD) and a WAKE OUT region (max(1, batchCap) rows × boats × WAKE_SRC_LEN, each
   * stepped boat's record after that row's step — stepper writes); batch rows carry each external boat's record.
   * Absent ⇒ no hull reads a wake and the layout is byte-identical to before.
   */
  wakeField?: boolean;
}

/**
 * WAKE REGIONS (§T.207, src/wake/wakeField.ts), appended after TRACE only when `wakeField`:
 *   WAKE WORLD  boats × WAKE_SRC_LEN                every boat's wake record at the START of tick k (after its step k−1)
 *   WAKE OUT    rows × boats × WAKE_SRC_LEN          row j: each stepped boat's record after its step j
 * The same freeze rule as WORLD: a stepper reads other boats' records from WAKE WORLD only, so a hull's field is a
 * function of tick-k inputs whichever shard it lives on, and never its own same-tick wake (§V108).
 */
export function wakeRegionLength(s: LayoutSpec): number {
  return s.wakeField ? (s.boats + Math.max(1, s.batchCap ?? 0) * s.boats) * WAKE_SRC_LEN : 0;
}

/**
 * MULTI-TICK KICK (§T.181 S0, §V2, §V110). Appended after the last boat block ONLY when the layout is built with
 * `batchCap > 0`; a layout without it is byte-identical to before. One kick then carries up to `batchCap` ticks,
 * each with its OWN inputs, so a fleet that trails the page catches up in one round trip instead of one tick per
 * round trip — and every tick is still stepped with exactly the inputs a one-tick kick would have carried.
 *
 *   COUNT      1 f64                   ticks in this kick; 0 ⇒ the classic kick (TIME/OCEAN/SEA/CONTROLS as written)
 *   PREV POSE  boats × 13 f64          each owned boat's pose BEFORE the kick's last tick (stepper writes) — the
 *                                      render interpolation pair of a multi-tick kick, from stepper output
 *   ROW j      tick, time, contact-off mask, contact-soft mask (§T.198), ocean[oceanLen], sea[seaLen], per boat: controls[4] (+ AI IN[8] when aiLen)
 *                                      main writes; the stepper copies row j into the normal slots, then steps
 */
export const BATCH_ROW_FIXED = 4;
/** row slots; CONTACT_OFF_MASK is the §T.188 header mask for THAT tick, CONTACT_SOFT_MASK §T.198's (uint32s held exactly in doubles) */
export const BATCH_ROW = { TICK: 0, TIME: 1, CONTACT_OFF_MASK: 2, CONTACT_SOFT_MASK: 3, PARAMS: 4 } as const;

export function batchRowLength(s: LayoutSpec): number {
  return BATCH_ROW_FIXED + s.oceanLen + s.seaLen + s.boats * (CONTROL_LEN + (s.aiLen ? AI_IN_LEN : 0)) + (s.externalBoats ?? 0) * (POSE_LEN + (s.wakeField ? WAKE_SRC_LEN : 0));
}

export function traceRegionLength(s: LayoutSpec): number {
  return s.trace ? Math.max(1, s.batchCap ?? 0) * s.boats * TRACE_LEN : 0;
}

export function batchRegionLength(s: LayoutSpec): number {
  const cap = s.batchCap ?? 0;
  return cap > 0 ? 1 + s.boats * POSE_LEN + cap * batchRowLength(s) : 0;
}

export function boatBlockLength(wakeCap: number, aiLen = 0): number {
  return BOAT_FIXED + wakeCap * WAKE_SAMPLE_LEN + aiLen;
}

export function layoutByteLength(s: LayoutSpec): number {
  return (HEADER_END_F64 + s.oceanLen + s.seaLen + s.boats * POSE_LEN + s.boats * boatBlockLength(s.wakeCap, s.aiLen ?? 0) + batchRegionLength(s) + traceRegionLength(s) + wakeRegionLength(s)) * 8;
}

type AnyBuffer = ArrayBuffer | SharedArrayBuffer;

export class BoatSimLayout {
  i32!: Int32Array;
  f64!: Float64Array;
  buffer!: AnyBuffer;
  readonly spec: Readonly<LayoutSpec>;
  readonly oceanOffset: number;
  readonly seaOffset: number;
  readonly worldOffset: number;
  readonly boatsOffset: number;
  readonly blockLength: number;

  /**
   * `spec` given ⇒ write a fresh header into `buffer`; omitted ⇒ adopt the header already in
   * it (the stepper side). Either way the header is validated, so a layout built against a
   * different version or a short buffer throws instead of reading garbage.
   */
  constructor(buffer: AnyBuffer, spec?: LayoutSpec) {
    const i32 = new Int32Array(buffer, 0, HEADER_I32);
    if (spec) {
      for (const [k, v] of Object.entries(spec)) {
        if (k === 'trace' || k === 'wakeField') {
          if (typeof v !== 'boolean') throw new Error(`sim layout: ${k} must be a boolean, got ${v}`);
          continue;
        }
        if (!Number.isInteger(v) || v < 0) throw new Error(`sim layout: ${k} must be a non-negative integer, got ${v}`);
      }
      if ((spec.externalBoats ?? 0) > spec.boats) throw new Error(`sim layout: ${spec.externalBoats} external boats > ${spec.boats} boats`);
      if (buffer.byteLength < layoutByteLength(spec)) {
        throw new Error(`sim layout: buffer ${buffer.byteLength} B < ${layoutByteLength(spec)} B`);
      }
      i32[H.MAGIC] = LAYOUT_MAGIC;
      i32[H.VERSION] = LAYOUT_VERSION;
      i32[H.BOATS] = spec.boats;
      i32[H.WAKE_CAP] = spec.wakeCap;
      i32[H.OCEAN_LEN] = spec.oceanLen;
      i32[H.SEA_LEN] = spec.seaLen;
      i32[H.SHARD_START] = 0;
      i32[H.SHARD_END] = spec.boats;
      const ai = spec.aiLen ?? 0;
      if (ai !== 0 && ai !== AI_BLOCK_LEN) throw new Error(`sim layout: aiLen must be 0 or ${AI_BLOCK_LEN}, got ${ai}`);
      i32[H.AI_LEN] = ai;
      i32[H.BATCH_CAP] = spec.batchCap ?? 0;
      const fh = new Float64Array(buffer, 0, HEADER_END_F64);
      fh[F.EXTERNAL_BOATS] = spec.externalBoats ?? 0;
      fh[F.TRACE_LEN] = spec.trace ? TRACE_LEN : 0;
      fh[F.WAKE_SRC_LEN] = spec.wakeField ? WAKE_SRC_LEN : 0;
    }
    if (i32[H.MAGIC] !== LAYOUT_MAGIC || i32[H.VERSION] !== LAYOUT_VERSION) {
      throw new Error(`sim layout: bad magic/version ${i32[H.MAGIC]}/${i32[H.VERSION]}`);
    }
    const fh = new Float64Array(buffer, 0, HEADER_END_F64);
    const ext = fh[F.EXTERNAL_BOATS];
    const trLen = fh[F.TRACE_LEN];
    if (!(Number.isInteger(ext) && ext >= 0 && ext <= i32[H.BOATS])) throw new Error(`sim layout: bad external boat count ${ext}`);
    if (trLen !== 0 && trLen !== TRACE_LEN) throw new Error(`sim layout: trace record ${trLen} f64, this build writes ${TRACE_LEN}`);
    const wsLen = fh[F.WAKE_SRC_LEN];
    if (wsLen !== 0 && wsLen !== WAKE_SRC_LEN) throw new Error(`sim layout: wake record ${wsLen} f64, this build writes ${WAKE_SRC_LEN}`);
    this.spec = Object.freeze({
      boats: i32[H.BOATS],
      wakeCap: i32[H.WAKE_CAP],
      oceanLen: i32[H.OCEAN_LEN],
      seaLen: i32[H.SEA_LEN],
      // present only when set, so a pilot-less layout's spec is exactly what it was before §T.186
      ...(i32[H.AI_LEN] > 0 ? { aiLen: i32[H.AI_LEN] } : {}),
      ...(i32[H.BATCH_CAP] > 0 ? { batchCap: i32[H.BATCH_CAP] } : {}),
      ...(ext > 0 ? { externalBoats: ext } : {}),
      ...(trLen > 0 ? { trace: true } : {}),
      ...(wsLen > 0 ? { wakeField: true } : {}),
    });
    if (buffer.byteLength < layoutByteLength(this.spec)) {
      throw new Error(`sim layout: buffer ${buffer.byteLength} B too short for its own header`);
    }
    this.oceanOffset = HEADER_END_F64;
    this.seaOffset = this.oceanOffset + this.spec.oceanLen;
    this.worldOffset = this.seaOffset + this.spec.seaLen;
    this.boatsOffset = this.worldOffset + this.spec.boats * POSE_LEN;
    this.blockLength = boatBlockLength(this.spec.wakeCap, this.spec.aiLen ?? 0);
    this.bind(buffer);
  }

  /** re-point the views at a buffer with the same layout (a transferable coming back) */
  bind(buffer: AnyBuffer): void {
    if (buffer.byteLength < layoutByteLength(this.spec)) throw new Error('sim layout: rebind to a short buffer');
    this.buffer = buffer;
    this.i32 = new Int32Array(buffer, 0, HEADER_I32);
    this.f64 = new Float64Array(buffer, 0, layoutByteLength(this.spec) / 8);
  }

  boatOffset(i: number): number {
    if (!(i >= 0 && i < this.spec.boats)) throw new Error(`sim layout: boat ${i} out of [0, ${this.spec.boats})`);
    return this.boatsOffset + i * this.blockLength;
  }

  worldPoseOffset(i: number): number {
    if (!(i >= 0 && i < this.spec.boats)) throw new Error(`sim layout: boat ${i} out of [0, ${this.spec.boats})`);
    return this.worldOffset + i * POSE_LEN;
  }

  /** start of boat i's NPC pilot block (AI OUT, then AI IN); throws when the layout has none */
  aiOffset(i: number): number {
    if (!this.spec.aiLen) throw new Error('sim layout: no AI block (build the layout with aiLen)');
    return this.boatOffset(i) + boatBlockLength(this.spec.wakeCap);
  }

  /** start of the BATCH region (its COUNT slot); throws when the layout has none (§T.181) */
  batchOffset(): number {
    if (!this.spec.batchCap) throw new Error('sim layout: no BATCH region (build the layout with batchCap)');
    return this.boatsOffset + this.spec.boats * this.blockLength;
  }

  /** boat i's PREV POSE slot in the BATCH region */
  batchPrevPoseOffset(i: number): number {
    if (!(i >= 0 && i < this.spec.boats)) throw new Error(`sim layout: boat ${i} out of [0, ${this.spec.boats})`);
    return this.batchOffset() + 1 + i * POSE_LEN;
  }

  /** start of batch row j */
  batchRowOffset(j: number): number {
    const cap = this.spec.batchCap ?? 0;
    if (!(j >= 0 && j < cap)) throw new Error(`sim layout: batch row ${j} out of [0, ${cap})`);
    return this.batchOffset() + 1 + this.spec.boats * POSE_LEN + j * batchRowLength(this.spec);
  }

  /** boat i's controls inside row `rowOffset` (AI IN, when present, follows at + CONTROL_LEN) */
  batchBoatInputOffset(rowOffset: number, i: number): number {
    if (!(i >= 0 && i < this.spec.boats)) throw new Error(`sim layout: boat ${i} out of [0, ${this.spec.boats})`);
    return rowOffset + BATCH_ROW_FIXED + this.spec.oceanLen + this.spec.seaLen + i * (CONTROL_LEN + (this.spec.aiLen ? AI_IN_LEN : 0));
  }

  /** §T.191: boat i is external (main-driven, never stepped) */
  isExternal(i: number): boolean {
    return i >= this.spec.boats - (this.spec.externalBoats ?? 0) && i < this.spec.boats;
  }

  /** §T.191: external boat i's pose slot inside batch row `rowOffset` */
  batchExternalPoseOffset(rowOffset: number, i: number): number {
    if (!this.isExternal(i)) throw new Error(`sim layout: boat ${i} is not external`);
    const first = this.spec.boats - (this.spec.externalBoats ?? 0);
    return rowOffset + BATCH_ROW_FIXED + this.spec.oceanLen + this.spec.seaLen + this.spec.boats * (CONTROL_LEN + (this.spec.aiLen ? AI_IN_LEN : 0)) + (i - first) * POSE_LEN;
  }

  /** §T.191: start of boat i's TRACE record for row j (row 0 = a classic kick's tick) */
  traceOffset(j: number, i: number): number {
    if (!this.spec.trace) throw new Error('sim layout: no TRACE region (build the layout with trace)');
    const rows = Math.max(1, this.spec.batchCap ?? 0);
    if (!(j >= 0 && j < rows)) throw new Error(`sim layout: trace row ${j} out of [0, ${rows})`);
    if (!(i >= 0 && i < this.spec.boats)) throw new Error(`sim layout: boat ${i} out of [0, ${this.spec.boats})`);
    return this.boatsOffset + this.spec.boats * this.blockLength + batchRegionLength(this.spec) + (j * this.spec.boats + i) * TRACE_LEN;
  }

  /** §T.207: boat i's slot in WAKE WORLD (tick-k record, main-written); throws without the wake regions */
  wakeWorldOffset(i: number): number {
    if (!this.spec.wakeField) throw new Error('sim layout: no WAKE regions (build the layout with wakeField)');
    if (!(i >= 0 && i < this.spec.boats)) throw new Error(`sim layout: boat ${i} out of [0, ${this.spec.boats})`);
    return this.boatsOffset + this.spec.boats * this.blockLength + batchRegionLength(this.spec) + traceRegionLength(this.spec) + i * WAKE_SRC_LEN;
  }

  /** §T.207: boat i's WAKE OUT record for row j (row 0 = a classic kick's tick) */
  wakeOutOffset(j: number, i: number): number {
    const rows = Math.max(1, this.spec.batchCap ?? 0);
    if (!(j >= 0 && j < rows)) throw new Error(`sim layout: wake row ${j} out of [0, ${rows})`);
    return this.wakeWorldOffset(0) + (this.spec.boats + j * this.spec.boats + i) * WAKE_SRC_LEN;
  }

  /** §T.207: external boat i's wake record slot inside batch row `rowOffset` (after the external poses) */
  batchExternalWakeOffset(rowOffset: number, i: number): number {
    if (!this.spec.wakeField) throw new Error('sim layout: no WAKE regions (build the layout with wakeField)');
    const ext = this.spec.externalBoats ?? 0;
    const k = i - (this.spec.boats - ext);
    return this.batchExternalPoseOffset(rowOffset, i) + (ext - k) * POSE_LEN + k * WAKE_SRC_LEN;
  }

  /** a byte-exact copy of the stepper's OUT region for one boat — what the V2 hash is taken over (AI OUT included, AI IN not) */
  outRange(i: number): [number, number] {
    const o = this.boatOffset(i);
    return [o + B.POSE, o + boatBlockLength(this.spec.wakeCap) + (this.spec.aiLen ? AI_OUT_LEN : 0)];
  }
}

export const HASH_SEED = 0x811c9dc5;

/**
 * FNV-1a over the raw bytes of ONE boat's OUT block — pose, contact summary and wake
 * samples, bit for bit. Excludes the header (it carries wall-clock telemetry). Chain it over
 * boats and ticks: h = hashBoatOutput(layoutOf(i), i, h).
 */
export function hashBoatOutput(layout: BoatSimLayout, i: number, seed: number = HASH_SEED): number {
  let h = seed >>> 0;
  const bytes = new Uint8Array(layout.buffer, 0, layoutByteLength(layout.spec));
  const [a, b] = layout.outRange(i);
  for (let k = a * 8; k < b * 8; k++) {
    h ^= bytes[k];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
