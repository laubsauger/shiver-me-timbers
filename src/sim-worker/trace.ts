/**
 * ONE TICK'S RACE/CRASH TRACE FOR ONE BOAT (§T.191). The page runs race logic and crash machines on the main thread
 * for every racer; for a rival stepped inside a multi-tick request the main thread never sees the intermediate
 * ticks, so the step core writes this summary per row (layout TRACE region) and the page reads it back after
 * collect. The PLAYER's trace is filled by the same two helpers below on the page, so a rival and the player are
 * measured the same way (§V110): substep END positions captured from the rigid6 force callback, bow immersion
 * against the contact patch the forces used (§V101), the collision report of that tick.
 */
import type { BoatCollideMemory } from '../sea-physics/boatCollide';
import type { Rigid6ForceFn, Rigid6State } from '../sea-physics/rigidBody';
import { bowImmersion } from '../speedboat/crash/sensors';
import { TR, TR_MAX_POSITIONS, TR_RPM_DRIVES } from './layout';

/**
 * Substep END positions of one `stepRigid6` call. rigid6 calls the force function ONCE per substep with the state
 * at the START of that substep, so the starts of substeps 1..n−1 are the ends of substeps 0..n−2 and the final
 * state is the end of the last one.
 */
export class SubstepPositions {
  /** x, z per captured substep start (index 0 = substep 0's start, not an end) */
  private readonly starts = new Float64Array(64 * 2);
  private calls = 0;
  private force: Rigid6ForceFn | null = null;
  readonly wrapped: Rigid6ForceFn = (s, h, out) => {
    if (this.calls < 64) {
      this.starts[this.calls * 2] = s.position[0];
      this.starts[this.calls * 2 + 1] = s.position[2];
    }
    this.calls++;
    (this.force as Rigid6ForceFn)(s, h, out);
  };

  /** before the step: the real force function; pass `wrapped` to stepRigid6 */
  begin(force: Rigid6ForceFn): Rigid6ForceFn {
    this.force = force;
    this.calls = 0;
    return this.wrapped;
  }

  /** substeps the last step ran */
  get substeps(): number {
    return this.calls;
  }

  /**
   * After the step: write up to TR_MAX_POSITIONS substep END positions (the LAST ones when a step ran more) into
   * `out` at `o` as x, z pairs, unused pairs = the final position. Returns the count written.
   */
  writeEnds(final: Readonly<Rigid6State>, out: Float64Array, o: number): number {
    const n = this.calls;
    const kept = Math.min(n, TR_MAX_POSITIONS);
    for (let k = 0; k < TR_MAX_POSITIONS; k++) {
      // end k' of the kept window: substep index e = n − kept + k
      const e = n - kept + k;
      let x = final.position[0];
      let z = final.position[2];
      if (k < kept && e < n - 1 && e + 1 < 64) {
        x = this.starts[(e + 1) * 2];
        z = this.starts[(e + 1) * 2 + 1];
      }
      out[o + 2 * k] = x;
      out[o + 2 * k + 1] = z;
    }
    return kept;
  }
}

export interface TraceInputs {
  state: Readonly<Rigid6State>;
  positions: SubstepPositions;
  contact: { wettedArea: number; slamImpulse: number; propImmersion: number; patch: { heightAt(x: number, z: number): number }; driveRpm?: ArrayLike<number> };
  bowDeck: readonly [number, number, number];
  /** this tick's collision report (null: no contacts wired) */
  collide: Readonly<BoatCollideMemory> | null;
  fetchVersion: number;
  throttle: number;
  /** normalised −1..1 */
  steer: number;
}

/** fill one TRACE_LEN record at `out[o]` (layout TR slots) */
export function writeTrace(out: Float64Array, o: number, t: TraceInputs): void {
  const s = t.state;
  for (let c = 0; c < 3; c++) out[o + TR.POSE + c] = s.position[c];
  for (let c = 0; c < 4; c++) out[o + TR.POSE + 3 + c] = s.quaternion[c];
  for (let c = 0; c < 3; c++) out[o + TR.POSE + 7 + c] = s.velocity[c];
  for (let c = 0; c < 3; c++) out[o + TR.POSE + 10 + c] = s.angularVelocity[c];
  out[o + TR.SUBSTEPS] = t.positions.substeps;
  t.positions.writeEnds(s, out, o + TR.POS);
  out[o + TR.WETTED] = t.contact.wettedArea;
  out[o + TR.SLAM] = t.contact.slamImpulse;
  out[o + TR.PROP_IMM] = t.contact.propImmersion;
  const patch = t.contact.patch;
  out[o + TR.BOW_IMM] = bowImmersion(s, t.bowDeck, (x, z) => patch.heightAt(x, z));
  const r = t.collide?.report;
  out[o + TR.CONTACT_DV] = r ? r.maxDeltaV : 0;
  out[o + TR.CONTACT_SRC] = r ? r.source : 0;
  for (let c = 0; c < 3; c++) out[o + TR.CONTACT_POINT + c] = r ? r.bodyPoint[c] : 0;
  out[o + TR.CONTACT_OTHER] = r ? r.other : -1;
  out[o + TR.OVERLAPS] = r && r.overlapsBoat ? 1 : 0;
  out[o + TR.FETCH_VERSION] = t.fetchVersion;
  out[o + TR.THROTTLE] = t.throttle;
  out[o + TR.STEER] = t.steer;
  const rpm = t.contact.driveRpm;
  for (let k = 0; k < TR_RPM_DRIVES; k++) out[o + TR.RPM + k] = rpm && k < rpm.length ? rpm[k] : 0;
}

/** a TRACE record's pose back into a state (reusing `out`'s arrays) */
export function readTracePose(src: Float64Array, o: number, out: Rigid6State): Rigid6State {
  for (let c = 0; c < 3; c++) out.position[c] = src[o + TR.POSE + c];
  for (let c = 0; c < 4; c++) out.quaternion[c] = src[o + TR.POSE + 3 + c];
  for (let c = 0; c < 3; c++) out.velocity[c] = src[o + TR.POSE + 7 + c];
  for (let c = 0; c < 3; c++) out.angularVelocity[c] = src[o + TR.POSE + 10 + c];
  return out;
}

