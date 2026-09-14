/**
 * THE BOAT STEP CORE (§T.178, §V110, §V2). One implementation of "advance N speedboats one
 * fixed tick" that every transport runs unchanged — in a SharedArrayBuffer worker, in a
 * transferable-ping-pong worker, and in-process on the main thread (§V95). It reads its
 * inputs from, and writes its outputs to, a `BoatSimLayout` and nothing else, so the only
 * thing a transport can change is where the bytes live.
 *
 * FULL FIDELITY, NOT CONFIGURABLE. Every boat gets `new HullWater(hull)` with the module
 * defaults (0.8 m patch), `planingSubsteps` (adaptive 2–4) and the full rigid6 step — the
 * same public step APIs a player boat uses. There is deliberately no option here that could
 * give a rival a coarser patch or fewer substeps (§V110: a rival that feels fewer waves is
 * unfair and looks wrong). The fidelity actually run is published into the header so a test
 * (and a HUD) can assert it rather than trust it.
 *
 * DETERMINISTIC INPUTS OF THE SEA (what makes this core's mirror equal the page's mirror):
 *  - seed                            → SpectrumScheduler h0 (constructor)
 *  - OceanParams per tick            → spectrum signature (rebuild arm/swap schedule), choppiness,
 *                                      fold cap, fetch/shoaling/swell-share coefficients
 *  - SeaPhysicsParams per tick       → mirrorResolution, updateEveryTicks, inverse-displacement
 *                                      iterations, Smith depth (hullDraft × smithDepthScale)
 *  - time (float64 SimState.time)    → wave phase; sent as the exact double, never re-derived
 *                                      from tick × dt (those differ in the last bits)
 *  - construction tick               → the scheduler's arm/build countdown is history; build
 *                                      this core at the same tick as the page mirror
 *  - seabed, fetch/swell shadow       → §T.191 `world` (worldData.ts): the page's baked seabed grid and
 *                                      fetch land mask, rebuilt here into the SAME mirror inputs the
 *                                      page mirror uses (bit-identical, tests/simWorkerWorldData)
 *  - wake                             → §T.207 `wakeField` layouts: every other boat's record in WAKE WORLD
 *                                      (src/wake/wakeField.ts), added to the pressure head this hull samples
 */
import { SIM_DT } from '../core/loop';
import type { OceanParams } from '../params/ocean';
import type { SeaPhysicsParams } from '../params/seaPhysics';
import { CpuOcean, MIRRORED_CASCADES } from '../sea-physics/cpuOcean';
import { HullWater, planingSubsteps } from '../sea-physics/hullWater';
import {
  createRigid6Memory,
  resetRigid6Memory,
  stepRigid6,
  type Rigid6Load,
  type Rigid6Memory,
  type Rigid6State,
} from '../sea-physics/rigidBody';
import { buildDeepVHull, type HullProxy } from '../speedboat/hullMesh';
import { TRIM_MAX, TRIM_MIN } from '../speedboat/assists/trim';
import {
  BOAT_COLLIDE_DEFAULTS,
  beginContactTick,
  buildCollisionHull,
  collideBoatWithFleet,
  collideBoatWithWorld,
  createBoatCollideMemory,
  prepareStaticWorld,
  resetBoatCollideMemory,
  type BoatCollideMemory,
  type BoatCollideParams,
  type BoatContactSetup,
  type CollisionHull,
  type StaticWorld,
} from '../sea-physics/boatCollide';
import { RacePilot, type PilotOutput, type PilotSetup } from '../race/ai/pilot';
import type { FetchField } from '../ocean/fetchField';
import { B, BoatSimLayout, F, H, WAKE_SAMPLE_LEN } from './layout';
import { SubstepPositions, writeTrace } from './trace';
import { writeBoatFx } from './fx';
import { gridSeabed, maskedFetchField, raceBed, type SimWorldData } from './worldData';
import { readParams } from './paramsVector';
import { WakeField, writeWakeSource } from '../wake/wakeField';

/**
 * CONTROLS → DRIVES (§T.179). The drive lives in the hull contact: `HullWater.setControls(steer, throttle)` yaws the
 * three drives (thrust at each prop point + gearcase lateral foils, immersion-gated) and `evaluate` adds that load
 * to the rigid6 load once per substep. The controls array carries a normalised steer ∈ [−1, 1], mapped here to the
 * drives' own lock (deepV12.hull.json `lowerUnit.maxSteerDeg`); throttle ∈ [−0.3, 1] goes straight through. (The
 * former stand-in thrust applied here would now double the drive load.) Thrust curve: TEMPORARY, hullWater
 * `STANDIN_THRUST`, until the rpm/prop model (T166).
 */
export interface BoatSimCoreInit {
  seed: number;
  /** the stepper's OWN copy (a structured clone on a worker); overwritten in place from the buffer */
  oceanParams: OceanParams;
  seaParams: SeaPhysicsParams;
  /**
   * NPC PILOT HOOK (§T.186). Present ⇒ every boat whose `pilot.boats[i]` is non-null is driven by `RacePilot`
   * inside this step (controls IN ignored for it); the layout must carry the AI block (`aiLen`). Absent ⇒ the
   * step is exactly the pre-T186 one.
   */
  pilot?: PilotSetup;
  /**
   * COLLISION HOOK (§T.188). Present ⇒ before each boat's step: boat↔boat contacts against the WORLD snapshot
   * (skipping `H.CONTACT_OFF_MASK` boats) and boat↔static colliders, the same `sea-physics/boatCollide` calls the
   * player boat makes. Absent ⇒ the step is exactly the pre-T188 one. The seabed is not wired into this core yet.
   */
  contacts?: BoatContactSetup;
  /**
   * WORLD DATA (§T.191, §V110). Present ⇒ this core's mirror shoals over the page's baked seabed grid and is
   * fetch-limited/shadowed by a field rebuilt from the page's land mask (worldData.ts), and hull↔terrain contact
   * (with `contacts`) reads the race bed. Absent ⇒ open sea, exactly the pre-T191 step.
   */
  world?: SimWorldData;
}

interface BoatSlot {
  state: Rigid6State;
  memory: Rigid6Memory;
  hw: HullWater;
  collide: BoatCollideMemory | null;
  resetSeq: number;
  throttle: number;
  steer: number;
}

export class BoatSimCore {
  readonly ocean: CpuOcean;
  readonly hull: HullProxy;
  private readonly oceanParams: OceanParams;
  private readonly seaParams: SeaPhysicsParams;
  private readonly slots = new Map<number, BoatSlot>();
  private paramsVersion = Number.NaN;
  private time = 0;
  /** §T.207 the field of every OTHER boat's wake, prepared per boat before its patch is sampled (§V108) */
  private readonly wakeField = new WakeField();
  private wakeOn = false;
  private readonly sampler = (x: number, z: number): number =>
    this.wakeOn ? this.ocean.pressureHeadAt(x, z, this.time) + this.wakeField.heightAt(x, z) : this.ocean.pressureHeadAt(x, z, this.time);
  private slot: BoatSlot | null = null;
  readonly pilot: RacePilot | null;
  private readonly contacts: { hull: CollisionHull; world: StaticWorld | null; boats: boolean; params: Readonly<BoatCollideParams> } | null;
  private readonly pilotOut: PilotOutput = { steer: 0, throttle: 0 };
  /** §T.191 world data: the masked fetch field (null = open sea) and the race bed */
  readonly fetchField: FetchField | null = null;
  private readonly bed: ((x: number, z: number) => number) | null = null;
  private readonly positions = new SubstepPositions();
  /** bow deck point for the trace's bow immersion (the collision hull's, built lazily when no contacts) */
  private bowDeck: readonly [number, number, number] | null = null;
  /** the params every boat's contact is built with — `new HullWater(hull)`, no overrides, same as each slot */
  private readonly contactParams: Readonly<HullWater['params']>;
  private readonly force = (s: Readonly<Rigid6State>, h: number, out: Rigid6Load): void => {
    const b = this.slot as BoatSlot;
    b.hw.evaluate(s, h, out);
  };

  constructor(init: BoatSimCoreInit) {
    this.oceanParams = init.oceanParams;
    this.seaParams = init.seaParams;
    this.ocean = new CpuOcean(init.seed, this.oceanParams, this.seaParams);
    this.hull = buildDeepVHull();
    this.contactParams = new HullWater(this.hull).params;
    this.pilot = init.pilot ? new RacePilot(init.pilot) : null;
    if (init.world) {
      // the page's order (core/seaScene.ts): mirror, then seabed, then fetch
      const bedGrid = gridSeabed(init.world);
      this.ocean.setSeabed(bedGrid, -bedGrid.openHeight);
      this.fetchField = maskedFetchField(init.world, this.oceanParams);
      this.ocean.setFetch(this.fetchField);
      const rb = raceBed(init.world);
      this.bed = (x, z) => rb.heightAt(x, z);
    }
    const c = init.contacts;
    this.contacts = c
      ? {
          hull: buildCollisionHull(this.hull),
          world: c.colliders && c.colliders.length > 0 ? prepareStaticWorld(c.colliders) : null,
          boats: c.boats,
          params: { ...BOAT_COLLIDE_DEFAULTS, ...(c.params ?? {}) },
        }
      : null;
  }

  private slotFor(i: number): BoatSlot {
    let s = this.slots.get(i);
    if (!s) {
      s = {
        state: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] },
        memory: createRigid6Memory(),
        hw: new HullWater(this.hull),
        collide: this.contacts ? createBoatCollideMemory(this.contacts.hull) : null,
        resetSeq: 0,
        throttle: 0,
        steer: 0,
      };
      this.slots.set(i, s);
    }
    return s;
  }

  /** the fidelity this core runs every boat at (§V110) — published, and asserted by tests */
  fidelity(): { patchSpacing: number; patchMargin: number; patchMaxAxis: number; mirrorResolution: number; mirroredCascades: number; inverseDisplacementIterations: number; updateEveryTicks: number } {
    const p = this.contactParams;
    return {
      patchSpacing: p.patchSpacing,
      patchMargin: p.patchMargin,
      patchMaxAxis: p.patchMaxAxis,
      mirrorResolution: this.seaParams.mirrorResolution,
      mirroredCascades: MIRRORED_CASCADES,
      inverseDisplacementIterations: this.seaParams.inverseDisplacementIterations,
      updateEveryTicks: this.seaParams.updateEveryTicks,
    };
  }

  /**
   * Advance the boats this buffer's shard owns [SHARD_START, SHARD_END) from tick k to k+1.
   * Reads: params (if PARAMS_VERSION moved), TIME, each owned boat's controls + reset request.
   * Writes: each owned boat's OUT block, and the fidelity header slots.
   */
  step(L: BoatSimLayout, row = 0): void {
    const f = L.f64;
    const i32 = L.i32;
    if (i32[H.PARAMS_VERSION] !== this.paramsVersion) {
      readParams(this.oceanParams, f, L.oceanOffset);
      readParams(this.seaParams, f, L.seaOffset);
      this.paramsVersion = i32[H.PARAMS_VERSION];
    }
    this.time = f[F.TIME];
    this.ocean.update(this.time);

    const fid = this.fidelity();
    f[F.PATCH_SPACING] = fid.patchSpacing;
    f[F.PATCH_MARGIN] = fid.patchMargin;
    f[F.PATCH_MAX_AXIS] = fid.patchMaxAxis;
    f[F.MIRROR_RESOLUTION] = fid.mirrorResolution;
    f[F.INVERSE_DISPLACEMENT_ITERATIONS] = fid.inverseDisplacementIterations;
    f[F.UPDATE_EVERY_TICKS] = fid.updateEveryTicks;

    const start = i32[H.SHARD_START];
    const end = i32[H.SHARD_END];
    const cap = L.spec.wakeCap;
    const tracing = L.spec.trace === true;
    for (let i = start; i < end; i++) {
      // §T.191: an external boat (the player) is main-driven: its WORLD/OUT pose is written by main, never stepped here
      if (L.isExternal(i)) continue;
      const o = L.boatOffset(i);
      const b = this.slotFor(i);
      const seq = f[o + B.RESET_SEQ];
      const justReset = seq !== b.resetSeq && b.resetSeq !== 0;
      const placed = seq !== b.resetSeq;
      if (seq !== b.resetSeq) {
        // V108 teleport contract: pose from the request, every per-location memory forgotten
        const s = b.state;
        const r = o + B.RESET_POSE;
        for (let c = 0; c < 3; c++) s.position[c] = f[r + c];
        for (let c = 0; c < 4; c++) s.quaternion[c] = f[r + 3 + c];
        for (let c = 0; c < 3; c++) s.velocity[c] = f[r + 7 + c];
        for (let c = 0; c < 3; c++) s.angularVelocity[c] = f[r + 10 + c];
        resetRigid6Memory(b.memory);
        b.hw.resetMemory();
        if (b.collide) resetBoatCollideMemory(b.collide);
        b.resetSeq = seq;
      }
      if (b.resetSeq === 0) throw new Error(`sim core: boat ${i} stepped before it was placed (write a reset pose first)`);
      // §T.207 Surge: the race's thrust multiplier as the engine boost (controls[3]; 0/≤ 1 = stock, bit-identical)
      b.hw.setBoost(f[o + B.CONTROLS + 3]);
      if (this.pilot !== null && this.pilot.drives(i)) {
        // §T.186: the pilot reads tick-k state (own pose, WORLD, the mirror at this.time, its AI block) and
        // returns the drive angle in rad; its memory stays in the buffer
        const po = this.pilotOut;
        this.pilot.control(i, L, b.state, this.ocean, this.time, justReset, po);
        b.throttle = po.throttle;
        b.steer = po.steer / this.hull.drives[0].maxSteerRad;
        // §T.207: the pilot's trim request reaches the drives through the SAME seam mapping the player's step uses
        b.hw.setControls(po.steer, po.throttle, unitTrimToRad(po.trim ?? 0));
      } else {
        b.throttle = f[o + B.CONTROLS];
        b.steer = f[o + B.CONTROLS + 1];

        const st = b.steer < -1 ? -1 : b.steer > 1 ? 1 : b.steer;
        // §T.191/§T.189: controls[2] is the seam's normalised drive trim, the SAME mapping the player's step uses
        b.hw.setControls(st * this.hull.drives[0].maxSteerRad, b.throttle, unitTrimToRad(f[o + B.CONTROLS + 2]));
      }
      const cx = this.contacts;
      if (cx !== null && b.collide !== null) {
        // §T.188: impulses from the tick-k WORLD snapshot, applied to this boat's velocities before its step
        beginContactTick(b.collide);
        if (cx.boats) collideBoatWithFleet(i, b.state, cx.hull, f, L.worldOffset, L.spec.boats, i32[H.CONTACT_OFF_MASK], SIM_DT, b.collide, cx.params, f[F.CONTACT_SOFT_MASK] >>> 0);
        if (cx.world || this.bed) collideBoatWithWorld(b.state, cx.hull, cx.world, this.bed, SIM_DT, b.collide, cx.params);
      }
      const wakes = L.spec.wakeField === true;
      if (wakes) this.wakeOn = this.wakeField.prepare(f, L.wakeWorldOffset(0), L.spec.boats, i, b.state.position[0], b.state.position[2]) > 0;
      b.hw.samplePatch(this.sampler, b.state, SIM_DT);
      this.wakeOn = false;
      const n = planingSubsteps(b.hw, b.state, SIM_DT);
      this.slot = b;
      stepRigid6(b.state, this.hull, SIM_DT, n, tracing ? this.positions.begin(this.force) : this.force, b.memory);
      this.slot = null;

      const s = b.state;
      const p = o + B.POSE;
      for (let c = 0; c < 3; c++) f[p + c] = s.position[c];
      for (let c = 0; c < 4; c++) f[p + 3 + c] = s.quaternion[c];
      for (let c = 0; c < 3; c++) f[p + 7 + c] = s.velocity[c];
      for (let c = 0; c < 3; c++) f[p + 10 + c] = s.angularVelocity[c];
      const hw = b.hw;
      f[o + B.SUBSTEPS] = n;
      f[o + B.WETTED_AREA] = hw.wettedArea;
      f[o + B.DISPLACED_VOLUME] = hw.displacedVolume;
      f[o + B.SLAM_IMPULSE] = hw.slamImpulse;
      f[o + B.CAP_SCALE] = hw.capScale;
      f[o + B.PROP_DEPTH] = hw.propDepth;
      f[o + B.PROP_IMMERSION] = hw.propImmersion;
      f[o + B.PATCH_OUTSIDE] = hw.patch.outside;
      f[o + B.PATCH_SAMPLES] = hw.patch.sampleCount;
      const w = hw.wake;
      const kept = Math.min(w.count, cap);
      f[o + B.WAKE_COUNT] = kept;
      f[o + B.WAKE_DEFICIT] = w.deficit;
      f[o + B.WAKE_RESCALE] = w.rescale;
      f[o + B.WAKE_OVERFLOW] = w.count - kept;
      // §T.207: this boat's wake record after its step (its previous one is its own WAKE WORLD slot; V108 on a placement)
      if (wakes) writeWakeSource(f, L.wakeOutOffset(row, i), f, L.wakeWorldOffset(i), placed, s, hw.wake, SIM_DT);
      // §T.195: this step's prop jets + waterline spray, next to the pose they belong to (fx.ts, the ONE writer)
      writeBoatFx(hw, s, f, o + B.FX);
      const base = o + B.WAKE;
      for (let k = 0; k < cap; k++) {
        const q = base + k * WAKE_SAMPLE_LEN;
        const live = k < kept;
        f[q] = live ? w.x[k] : 0;
        f[q + 1] = live ? w.z[k] : 0;
        f[q + 2] = live ? w.fy[k] : 0;
        f[q + 3] = live ? w.sigma[k] : 0;
        f[q + 4] = live ? w.depth[k] : 0;
      }
      if (tracing) {
        if (this.bowDeck === null) this.bowDeck = (this.contacts?.hull ?? buildCollisionHull(this.hull)).bowDeck as unknown as [number, number, number];
        writeTrace(f, L.traceOffset(row, i), {
          state: s,
          positions: this.positions,
          contact: hw,
          bowDeck: this.bowDeck,
          collide: b.collide,
          fetchVersion: this.fetchField ? this.fetchField.version : Number.NaN,
          throttle: b.throttle,
          steer: b.steer,
        });
      }
    }
  }
}

/**
 * §T.191 the seam's normalised drive trim (−1 bow down … +1 bow up, `BoatControls.trim`) → HullWater's trim angle, rad:
 * −1 → TRIM_MIN (−6°), +1 → TRIM_MAX (+8°), the range the §T.182 assists command. ONE mapping for the player's step
 * (page/playerBoat.ts) and every rival's (§V110). The physics clamps to each drive's own range.
 */
export function unitTrimToRad(u: number): number {
  if (!Number.isFinite(u)) return 0;
  const c = u < -1 ? -1 : u > 1 ? 1 : u;
  return c >= 0 ? c * TRIM_MAX : -c * TRIM_MIN;
}

/** pose → a boat's reset request; bumps the sequence so the stepper applies it exactly once */
export function writeResetPose(L: BoatSimLayout, i: number, pose: Readonly<Rigid6State>): void {
  const o = L.boatOffset(i);
  const f = L.f64;
  const r = o + B.RESET_POSE;
  for (let c = 0; c < 3; c++) f[r + c] = pose.position[c];
  for (let c = 0; c < 4; c++) f[r + 3 + c] = pose.quaternion[c];
  for (let c = 0; c < 3; c++) f[r + 7 + c] = pose.velocity[c];
  for (let c = 0; c < 3; c++) f[r + 10 + c] = pose.angularVelocity[c];
  f[o + B.RESET_SEQ] = f[o + B.RESET_SEQ] + 1;
}

