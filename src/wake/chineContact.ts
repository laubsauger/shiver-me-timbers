import type { WaterlineSpray } from '../foam/sprayMath';

/** A live sheet source. front is the distance travelled since continuous contact began. */
export interface ChineSheetEmitter {
  bow: Readonly<WaterlineSpray>;
  speed: number;
  front: number;
  vx: number;
  vz: number;
}

/** Fixed-tick contact history, keyed by vessel identity rather than camera ordering. */
export class ChineContactHistory {
  private readonly boats = new Map<number, { tick: number; distance: number; wet: boolean }>();

  update(id: number, tick: number, bow: Readonly<WaterlineSpray>, vx: number, vz: number, dt: number): ChineSheetEmitter {
    const speed = Math.hypot(vx, vz);
    const wet = bow.inContact && Number.isFinite(bow.flux) && bow.flux > 0 && Number.isFinite(speed) && speed > 0.5;
    let state = this.boats.get(id);
    if (!state) {
      state = { tick, distance: 0, wet };
      this.boats.set(id, state);
    } else if (tick !== state.tick) {
      // A restart or loss of contact starts a new source. The accumulation texture
      // owns old foam; resetting this front never deletes the deposited trail.
      state.distance = wet && state.wet && tick > state.tick ? state.distance + speed * dt * (tick - state.tick) : 0;
      state.tick = tick;
      state.wet = wet;
    }
    return { bow, speed, front: wet ? state.distance : 0, vx, vz };
  }

  remove(id: number): void { this.boats.delete(id); }
}
