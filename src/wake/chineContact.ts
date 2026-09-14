import type { WaterlineSpray } from '../foam/sprayMath';
import { CHINE_EMISSION_INTERVAL, CHINE_EMISSION_LIFE, CHINE_EMISSION_SLOTS, type ChineEmission } from './chineEmissions';

/** Current particle emitter plus its independently evolving, world-space foam emissions. */
export interface ChineSheetEmitter {
  bow: Readonly<WaterlineSpray>;
  speed: number;
  vx: number;
  vz: number;
  time: number;
  emissions: readonly ChineEmission[];
}

/** Fixed-tick contact history, keyed by vessel identity rather than camera ordering. */
export class ChineContactHistory {
  private readonly boats = new Map<number, { tick: number; wet: boolean; time: number; emissions: ChineEmission[] }>();

  update(id: number, tick: number, bow: Readonly<WaterlineSpray>, vx: number, vz: number, dt: number): ChineSheetEmitter {
    const speed = Math.hypot(vx, vz);
    const wet = bow.inContact && bow.flux > 0 && speed > 0.5
      && [speed, bow.flux, bow.x, bow.z, bow.halfWidth, bow.launch].every(Number.isFinite);
    let state = this.boats.get(id);
    if (!state) {
      state = { tick: tick - 1, wet: false, time: tick * dt, emissions: [] };
      this.boats.set(id, state);
    }
    state.time = Math.max(state.time + dt, (tick + 1) * dt);
    // Emission times stay ordered: new packets append, and coalescing only
    // moves the newest packet forward. Retire the expired prefix in place
    // instead of allocating an array on every fixed update (including dry ones).
    let expired = 0;
    while (expired < state.emissions.length
      && state.time - state.emissions[expired].time >= CHINE_EMISSION_LIFE) expired++;
    if (expired > 0) {
      state.emissions.copyWithin(0, expired);
      state.emissions.length -= expired;
    }
    if (tick !== state.tick) {
      if (tick < state.tick) state.emissions.length = 0;
      const elapsed = state.wet && tick > state.tick ? (tick - state.tick) * dt : dt;
      if (wet) {
        const bin = Math.floor(tick * dt / CHINE_EMISSION_INTERVAL);
        const emitted: ChineEmission = { bin, time: state.time, volume: bow.flux * elapsed, x: bow.x, z: bow.z, vx, vz, halfWidth: bow.halfWidth, launch: bow.launch, speed };
        const last = state.emissions[state.emissions.length - 1];
        // Coalesce only within a five-degree direction tolerance. A sharp turn
        // starts another packet even inside the same 50 ms emission interval.
        const aligned = last && last.vx * vx + last.vz * vz > Math.cos(5 * Math.PI / 180) * Math.hypot(last.vx, last.vz) * speed;
        if (last && last.bin === bin && state.wet && aligned) {
          const total = last.volume + emitted.volume;
          const w = emitted.volume / total;
          for (const key of ['time', 'x', 'z', 'vx', 'vz', 'halfWidth', 'launch', 'speed'] as const) last[key] += (emitted[key] - last[key]) * w;
          last.volume = total;
        } else {
          state.emissions.push(emitted);
        }
        if (state.emissions.length > CHINE_EMISSION_SLOTS) throw new Error('Chine emission history exceeded its fixed GPU capacity');
      }
      state.tick = tick;
      state.wet = wet;
    }
    return { bow, speed, vx, vz, time: state.time, emissions: state.emissions };
  }

  resetContact(id: number): void {
    const state = this.boats.get(id);
    if (state) { state.wet = false; }
  }

  remove(id: number): void { this.boats.delete(id); }
}
