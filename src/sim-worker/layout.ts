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
 *     OUT  pose[13], contact summary, wake load samples                   (stepper writes, main reads)
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
 * lives on. A shared WAKE FIELD belongs in a separate read-only SharedArrayBuffer written by
 * the main thread between ticks (one copy for every worker); on the transferable path it
 * would be a second transferred buffer per shard. See docs/speedboat/sim-worker.md.
 */

/** 13 channels, the order rigid6 owns them in: position 3, quaternion 4, velocity 3, angularVelocity 3 */
export const POSE_LEN = 13;
export const CONTROL_LEN = 4;
/** per wake load sample: x, z, fy, sigma, depth (hullWater WakeLoadSamples) */
export const WAKE_SAMPLE_LEN = 5;

export const LAYOUT_MAGIC = 0x0b0a7178;
export const LAYOUT_VERSION = 1;

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
} as const;
const HEADER_END_F64 = 16;

/** boat block slots, relative to `boatOffset(i)` */
export const B = {
  CONTROLS: 0, // throttle, steer, trim, reserved
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
  WAKE: 44,
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

export interface LayoutSpec {
  boats: number;
  wakeCap: number;
  oceanLen: number;
  seaLen: number;
  /** 0/absent = no NPC pilot block; AI_BLOCK_LEN = one per boat (§T.186) */
  aiLen?: number;
  /** 0/absent = no BATCH region (one tick per kick only); n = up to n ticks per kick (§T.181) */
  batchCap?: number;
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
 *   ROW j      tick, time, contact-off mask, ocean[oceanLen], sea[seaLen], per boat: controls[4] (+ AI IN[8] when aiLen)
 *                                      main writes; the stepper copies row j into the normal slots, then steps
 */
export const BATCH_ROW_FIXED = 3;
/** row slots; CONTACT_OFF_MASK is the §T.188 header mask for THAT tick (a uint32 held exactly in a double) */
export const BATCH_ROW = { TICK: 0, TIME: 1, CONTACT_OFF_MASK: 2, PARAMS: 3 } as const;

export function batchRowLength(s: LayoutSpec): number {
  return BATCH_ROW_FIXED + s.oceanLen + s.seaLen + s.boats * (CONTROL_LEN + (s.aiLen ? AI_IN_LEN : 0));
}

export function batchRegionLength(s: LayoutSpec): number {
  const cap = s.batchCap ?? 0;
  return cap > 0 ? 1 + s.boats * POSE_LEN + cap * batchRowLength(s) : 0;
}

export function boatBlockLength(wakeCap: number, aiLen = 0): number {
  return BOAT_FIXED + wakeCap * WAKE_SAMPLE_LEN + aiLen;
}

export function layoutByteLength(s: LayoutSpec): number {
  return (HEADER_END_F64 + s.oceanLen + s.seaLen + s.boats * POSE_LEN + s.boats * boatBlockLength(s.wakeCap, s.aiLen ?? 0) + batchRegionLength(s)) * 8;
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
        if (!Number.isInteger(v) || v < 0) throw new Error(`sim layout: ${k} must be a non-negative integer, got ${v}`);
      }
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
    }
    if (i32[H.MAGIC] !== LAYOUT_MAGIC || i32[H.VERSION] !== LAYOUT_VERSION) {
      throw new Error(`sim layout: bad magic/version ${i32[H.MAGIC]}/${i32[H.VERSION]}`);
    }
    this.spec = Object.freeze({
      boats: i32[H.BOATS],
      wakeCap: i32[H.WAKE_CAP],
      oceanLen: i32[H.OCEAN_LEN],
      seaLen: i32[H.SEA_LEN],
      // present only when set, so a pilot-less layout's spec is exactly what it was before §T.186
      ...(i32[H.AI_LEN] > 0 ? { aiLen: i32[H.AI_LEN] } : {}),
      ...(i32[H.BATCH_CAP] > 0 ? { batchCap: i32[H.BATCH_CAP] } : {}),
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
