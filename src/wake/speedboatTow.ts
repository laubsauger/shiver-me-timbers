/**
 * THE POND'S SPEEDBOAT, CONTACT-DRIVEN (§T.180 c; docs/wake/w5b.md §3). Replaces
 * the W2a planing stand-in (`planingPatchSamples`) wherever a pond or a CPU tow
 * wants the real hull: the deep-V's own `HullWater` contact on the rigid-6 step,
 * TOWED in surge (speed held along world +x, heading held) and FREE in heave,
 * pitch and roll, so her running trim, wetted plan and drive immersion are the
 * physics agent's model at that speed rather than a Savitsky table.
 *
 * Measured (flat sea, full throttle, scratch tow): 40 m/s settles by 4 s at
 * trim 1.6°, Σ wake fy / W = 1.00, props 0.43 m deep, 4.6 kN each (the
 * TEMPORARY stand-in thrust curve, §T.179).
 *
 * Deterministic in its tick sequence: fixed SIM_DT ticks from t = 0, so a CPU
 * tow and a GPU pond fed from fresh instances see identical samples. Reads the
 * `HullWater` public API only (the physics agent owns the class).
 */
import { SIM_DT } from '../core/loop';
import { quatFromAxisAngle } from '../core/quat';
import { HullWater, planingSubsteps } from '../sea-physics/hullWater';
import { createRigid6Memory, stepRigid6, type Rigid6Memory, type Rigid6State } from '../sea-physics/rigidBody';
import { buildDeepVHull, type HullProxy } from '../speedboat/hullMesh';
import type { PropWashInput } from './propWash';
import { propWashFromHullWater } from './propWashHullWater';
import { hullWaterSamples } from './stationSources';
import type { HydroSample } from './wakeSolverMath';

/** the plan outline the calibration readouts need (`wakeCalibration.HullFrame`) */
export interface TowFrame {
  stem: number;
  transom: number;
  halfBeam: number;
  halfBreadth(x: number): number;
  length: number;
}

export class SpeedboatTow {
  readonly hull: HullProxy;
  readonly frame: TowFrame;
  private hw!: HullWater;
  private state!: Rigid6State;
  private memory!: Rigid6Memory;
  private ticks = 0;
  private readonly jetsOut: PropWashInput[] = [];

  constructor(
    readonly speed: number,
    readonly throttle = 1,
  ) {
    this.hull = buildDeepVHull();
    const hb = this.hull.beam / 2;
    const stem = this.hull.stemZ;
    const transom = this.hull.transomZ;
    this.frame = { stem, transom, halfBeam: hb, length: stem - transom, halfBreadth: (x) => (x < transom || x > stem ? -1 : hb) };
    this.reset();
  }

  private reset(): void {
    this.hw = new HullWater(this.hull);
    this.state = {
      position: [0, 0.2, 0],
      // body +z (forward) → world +x
      quaternion: quatFromAxisAngle([0, 1, 0], Math.PI / 2),
      velocity: [this.speed, 0, 0],
      angularVelocity: [0, 0, 0],
    };
    this.memory = createRigid6Memory();
    this.ticks = 0;
  }

  /** advance in whole ticks until her origin is at x = speed·t (restarts if x went backwards) */
  advanceTo(x: number): void {
    const t = this.speed > 0 ? x / this.speed : 0;
    if (!Number.isFinite(t)) return;
    const want = Math.floor(t / SIM_DT + 1e-9);
    if (want < this.ticks) this.reset();
    const hw = this.hw;
    const s = this.state;
    const force = (st: Readonly<Rigid6State>, h: number, out: Parameters<HullWater['evaluate']>[2]) => hw.evaluate(st, h, out);
    while (this.ticks < want) {
      hw.setControls(0, this.throttle);
      s.position[0] = this.speed * this.ticks * SIM_DT;
      hw.samplePatch(() => 0, s, SIM_DT);
      stepRigid6(s, this.hull, SIM_DT, planingSubsteps(hw, s, SIM_DT), force, this.memory);
      // the tow: surge speed, track and heading are held; heave, pitch and roll are hers
      s.velocity[0] = this.speed;
      s.velocity[2] = 0;
      s.position[2] = 0;
      s.angularVelocity[1] = 0;
      this.ticks++;
    }
    s.position[0] = x;
  }

  /** this tick's contact wake samples (hullWater's plan-column loads) */
  samples(out: HydroSample[] = []): HydroSample[] {
    // before her first tick there is no contact result (the patch is unbuilt): no samples
    if (this.ticks === 0) {
      out.length = 0;
      return out;
    }
    return hullWaterSamples(this.hw.wake, out);
  }

  /** this tick's prop jets (none before her first tick) */
  jets(): readonly PropWashInput[] {
    if (this.ticks === 0) {
      this.jetsOut.length = 0;
      return this.jetsOut;
    }
    propWashFromHullWater(this.hw, this.state, this.jetsOut);
    return this.jetsOut;
  }

  get pose(): Readonly<Rigid6State> {
    return this.state;
  }
}
