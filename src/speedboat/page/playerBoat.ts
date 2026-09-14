/**
 * THE PLAYER BOAT'S PHYSICS (§T.181 S0): `rigid6` + `HullWater` on the deep-V, stepped in the
 * page's FIXED tick only (§V2) — never from the render callback.
 *
 * SAME STEP AS EVERY RIVAL (§V110). The sequence below is `BoatSimCore.step`'s for one boat
 * (src/sim-worker/stepCore.ts): `setControls(steer·lock, throttle)` → `samplePatch` on the
 * mirror's PRESSURE head (§V68) → `planingSubsteps` → `stepRigid6` with the contact as the only
 * force provider. Same hull (`buildDeepVHull()`), same `new HullWater(hull)` defaults (0.8 m
 * patch), same substep rule — a player that felt more waves than a rival would be the unfairness
 * §V110 forbids in the other direction. The only difference is which `CpuOcean` answers: the
 * page mirror here (shared GPU spectrum scheduler), the worker's own mirror there; the sim-worker
 * doc's §V110 test pins those two equal.
 *
 * ONE CONTACT, MANY CONSUMERS (§V101): after `tick`, `hw` holds the last substep's result, and
 * the wake samples (`wakeSamples`), prop jets (`jets`), HUD, audio and crash hook all read it —
 * nobody samples the hull a second way.
 *
 * `state` IS the SimState ship: ShipState structurally satisfies Rigid6State, and rigid6 writes
 * its arrays element-wise, so references held by the camera or the frame stay valid.
 */
import { SIM_DT } from '../../core/loop';
import { HullWater, planingSubsteps } from '../../sea-physics/hullWater';
import { createRigid6Memory, resetRigid6Memory, stepRigid6, type Rigid6Load, type Rigid6State } from '../../sea-physics/rigidBody';
import type { ShipState } from '../../state/simState';
import type { PropWashInput } from '../../wake/propWash';
import { propWashFromHullWater } from '../../wake/propWashHullWater';
import { hullWaterSamples } from '../../wake/stationSources';
import type { HydroSample } from '../../wake/wakeSolverMath';
import type { HullProxy } from '../hullMesh';
import { unitTrimToRad } from '../../sim-worker/stepCore';
import { SubstepPositions } from '../../sim-worker/trace';
import type { BoatControls } from './seams';

export interface PlayerBoatDeps {
  hull: HullProxy;
  /** the §V68 pressure head of the sea this boat floats on, at sim time t */
  pressureHeadAt(x: number, z: number, t: number): number;
}

export interface PlayerBoat {
  readonly hull: HullProxy;
  readonly hw: HullWater;
  /** the SimState ship (id 'player') */
  readonly state: ShipState;
  /** substeps the last tick ran */
  readonly substeps: number;
  /**
   * §V107/§T.191: the substep END positions of the last tick, captured from the rigid6 force callback by the SAME
   * `sim-worker/trace` helper the step core's trace uses for every rival (§V110: measured the same way).
   */
  readonly positions: SubstepPositions;
  /**
   * FIXED TICK: this tick's controls → one rigid6 step, the sea read at `time` = `SimState.time`
   * AFTER the tick's increment, the same float64 the mirror was updated to and the NPC fleet is
   * kicked with for this tick
   */
  tick(controls: Readonly<BoatControls>, time: number, dt?: number): void;
  /** V108 teleport: pose in, every per-location memory (rigid6 added mass, contact dm_a/dt) out */
  place(pose: Readonly<Rigid6State>): void;
  /** this tick's contact wake load (§V101), reusing `out`'s objects */
  wakeSamples(out: HydroSample[]): HydroSample[];
  /** this tick's prop jets (per-drive thrust from the same evaluate), reusing `out`'s objects */
  jets(out: PropWashInput[]): PropWashInput[];
}

export function createPlayerBoat(d: PlayerBoatDeps, state: ShipState): PlayerBoat {
  const { hull } = d;
  const hw = new HullWater(hull);
  const memory = createRigid6Memory();
  let time = 0;
  let substeps = 0;
  let stepped = false;
  const sampler = (x: number, z: number): number => d.pressureHeadAt(x, z, time);
  const positions = new SubstepPositions();
  const force = (s: Readonly<Rigid6State>, h: number, out: Rigid6Load): void => hw.evaluate(s, h, out);
  const lock = hull.drives[0]?.maxSteerRad ?? 0;

  return {
    hull,
    hw,
    state,
    get substeps() {
      return substeps;
    },
    positions,
    tick(controls, t, dt = SIM_DT) {
      time = t;
      const steer = controls.steer < -1 ? -1 : controls.steer > 1 ? 1 : controls.steer;
      hw.setControls(steer * lock, controls.throttle, unitTrimToRad(controls.trim));
      hw.samplePatch(sampler, state, dt);
      substeps = planingSubsteps(hw, state, dt);
      stepRigid6(state, hull, dt, substeps, positions.begin(force), memory);
      stepped = true;
    },
    place(pose) {
      for (let c = 0; c < 3; c++) state.position[c] = pose.position[c];
      for (let c = 0; c < 4; c++) state.quaternion[c] = pose.quaternion[c];
      for (let c = 0; c < 3; c++) state.velocity[c] = pose.velocity[c];
      for (let c = 0; c < 3; c++) state.angularVelocity[c] = pose.angularVelocity[c];
      resetRigid6Memory(memory);
      hw.resetMemory();
      stepped = false;
    },
    wakeSamples(out) {
      // no contact result before the first step after a placement (the patch is unbuilt)
      if (!stepped) {
        out.length = 0;
        return out;
      }
      return hullWaterSamples(hw.wake, out);
    },
    jets(out) {
      if (!stepped) {
        out.length = 0;
        return out;
      }
      propWashFromHullWater(hw, state, out);
      return out;
    },
  };
}
