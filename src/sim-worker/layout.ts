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

export interface LayoutSpec {
  boats: number;
  wakeCap: number;
  oceanLen: number;
  seaLen: number;
}

export function boatBlockLength(wakeCap: number): number {
  return BOAT_FIXED + wakeCap * WAKE_SAMPLE_LEN;
}

export function layoutByteLength(s: LayoutSpec): number {
  return (HEADER_END_F64 + s.oceanLen + s.seaLen + s.boats * POSE_LEN + s.boats * boatBlockLength(s.wakeCap)) * 8;
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
    }
    if (i32[H.MAGIC] !== LAYOUT_MAGIC || i32[H.VERSION] !== LAYOUT_VERSION) {
      throw new Error(`sim layout: bad magic/version ${i32[H.MAGIC]}/${i32[H.VERSION]}`);
    }
    this.spec = Object.freeze({
      boats: i32[H.BOATS],
      wakeCap: i32[H.WAKE_CAP],
      oceanLen: i32[H.OCEAN_LEN],
      seaLen: i32[H.SEA_LEN],
    });
    if (buffer.byteLength < layoutByteLength(this.spec)) {
      throw new Error(`sim layout: buffer ${buffer.byteLength} B too short for its own header`);
    }
    this.oceanOffset = HEADER_END_F64;
    this.seaOffset = this.oceanOffset + this.spec.oceanLen;
    this.worldOffset = this.seaOffset + this.spec.seaLen;
    this.boatsOffset = this.worldOffset + this.spec.boats * POSE_LEN;
    this.blockLength = boatBlockLength(this.spec.wakeCap);
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

  /** a byte-exact copy of the stepper's OUT region for one boat — what the V2 hash is taken over */
  outRange(i: number): [number, number] {
    const o = this.boatOffset(i);
    return [o + B.POSE, o + this.blockLength];
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
