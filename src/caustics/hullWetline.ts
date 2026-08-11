/**
 * Hull wetline memory — "wet where the water LAPPED", not where it is now.
 *
 * A band that tracks the instantaneous hull/water intersection reads as a
 * rigid painted ring, because the ship and the swell move together. What
 * makes timber read as wet is HYSTERESIS: the sea reaches up the planking,
 * the trough drops away, and the dark band stays for a few seconds before
 * drying from the top down. So the state kept here is the HIGHEST RECENT
 * contact height per station, decayed at a constant rate — the same
 * evaporation-per-frame model §V.9 uses for the deck, so hull wetness and
 * deck water read as one phenomenon once T31 wires the deck.
 *
 * FRAME: ship-LOCAL. The hull pitches and rolls; a world-space memory would
 * smear the band across the planking every time the ship turns.
 *
 * LAYOUT: `stations` samples uniformly spanning sternZ→bowZ, two rows
 * (row 0 = port, row 1 = starboard), value = ship-local Y the sea reached.
 * sea-physics/hullContact.ts samples a BOW-BIASED (t^1.6) set of slices, so
 * `updateFromHullContact` resamples rather than index-matching — feeding its
 * arrays in directly would bunch the whole waterline into the forward third.
 *
 * The update math is pure (dryStep) and pinned by tests; the class adds only
 * the resampling and the GPU upload.
 */
import * as THREE from 'three/webgpu';
import { causticsParams as cp } from '../params/caustics';

/**
 * One drying step. Contact wins instantly (the sea wets timber the moment it
 * touches it); drying is linear in time and never falls below the current
 * contact height. `dt` is clamped so an alt-tab stall cannot dry the whole
 * hull in one frame, and every input is finite-guarded (§V.28) — a NaN would
 * otherwise poison a station permanently and upload NaN to the texture.
 */
export function dryStep(
  previous: number,
  contact: number,
  dryRate: number,
  dt: number,
): number {
  const c = Number.isFinite(contact) ? contact : -Infinity;
  const p = Number.isFinite(previous) ? previous : c;
  const rate = Number.isFinite(dryRate) ? Math.max(dryRate, 0) : 0;
  const time = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.25) : 0;
  return Math.max(c, p - rate * time);
}

export interface HullWetlineOptions {
  /** ship-space z of the stem — matches sea-physics HullWaterline.bowZ */
  bowZ: number;
  /** ship-space z of the transom */
  sternZ: number;
  /** stations per side; defaults to the params value */
  stations?: number;
}

/**
 * Structural subset of sea-physics `ContactStation`. Typed structurally on
 * purpose: this module must not depend on another system's module graph.
 */
export interface WetlineStation {
  /** ship-local x, signed (− port, + starboard) */
  x: number;
  /** ship-local z */
  z: number;
}

export class HullWetline {
  /** stations × 2 (row 0 = port, row 1 = starboard), RGBA32F, R = wet height */
  readonly texture: THREE.DataTexture;
  /** ship-local Y the sea most recently reached, [port…, starboard…] */
  readonly wetHeight: Float32Array;
  readonly stations: number;
  readonly bowZ: number;
  readonly sternZ: number;

  private data: Float32Array;
  /** scratch: resampled contact height per grid cell, rebuilt each update */
  private contact: Float32Array;

  constructor(opts: HullWetlineOptions) {
    this.stations = Math.max(2, Math.floor(opts.stations ?? cp.wetStations));
    this.bowZ = opts.bowZ;
    this.sternZ = opts.sternZ;
    if (!(this.bowZ > this.sternZ)) {
      // fail loud (§Rule 8): a reversed hull silently maps every fragment to
      // one end of the texture and the band would never move
      throw new Error(`HullWetline: bowZ (${this.bowZ}) must exceed sternZ (${this.sternZ})`);
    }
    this.wetHeight = new Float32Array(this.stations * 2).fill(-Infinity);
    this.contact = new Float32Array(this.stations * 2);
    this.data = new Float32Array(this.stations * 2 * 4);
    this.texture = new THREE.DataTexture(
      this.data,
      this.stations,
      2,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    // linear along the hull so a handful of stations interpolate to a smooth
    // waterline; clamped so bow/stern never wrap onto the opposite end
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
  }

  /** ship-local z of grid station `i` (0 = stern, stations−1 = bow) */
  stationZ(i: number): number {
    const t = this.stations === 1 ? 0.5 : i / (this.stations - 1);
    return this.sternZ + t * (this.bowZ - this.sternZ);
  }

  /**
   * Feed from sea-physics `HullContact`: pass `contact.stations` and
   * `contact.depth`. Stations sit on the design waterline (local y = 0), so
   * a station's immersion IS the ship-local height the sea reached there.
   * Non-uniform slice spacing is resampled onto this grid by linear
   * interpolation in z, per side.
   */
  updateFromHullContact(
    dt: number,
    stations: readonly WetlineStation[],
    depth: ArrayLike<number>,
  ): void {
    const n = Math.min(stations.length, depth.length);
    for (let side = 0; side < 2; side++) {
      const wantStarboard = side === 1;
      for (let i = 0; i < this.stations; i++) {
        const z = this.stationZ(i);
        // nearest source station on each side of z, on the matching board
        let loZ = -Infinity;
        let hiZ = Infinity;
        let loV = 0;
        let hiV = 0;
        let any = false;
        for (let s = 0; s < n; s++) {
          if (stations[s].x >= 0 !== wantStarboard) continue;
          const sz = stations[s].z;
          const v = depth[s];
          if (!Number.isFinite(sz) || !Number.isFinite(v)) continue;
          any = true;
          if (sz <= z && sz > loZ) { loZ = sz; loV = v; }
          if (sz >= z && sz < hiZ) { hiZ = sz; hiV = v; }
        }
        let value: number;
        if (!any) value = -Infinity;
        else if (loZ === -Infinity) value = hiV; // z is forward of every station
        else if (hiZ === Infinity) value = loV; // z is aft of every station
        else if (hiZ === loZ) value = loV;
        else value = loV + ((hiV - loV) * (z - loZ)) / (hiZ - loZ);
        this.contact[side * this.stations + i] = value;
      }
    }
    this.applyContacts(dt, this.contact);
  }

  /**
   * Raw feed, index-aligned to THIS grid: [port stern→bow…, starboard…] in
   * ship-local Y. Use when a caller already has the wetted height directly.
   */
  updateFromContacts(dt: number, contactLocalY: ArrayLike<number>): void {
    this.applyContacts(dt, contactLocalY);
  }

  private applyContacts(dt: number, contact: ArrayLike<number>): void {
    const n = Math.min(this.wetHeight.length, contact.length);
    for (let k = 0; k < n; k++) {
      this.wetHeight[k] = dryStep(this.wetHeight[k], contact[k], cp.wetDryRate, dt);
    }
    // stations with no feed still dry out rather than freezing
    for (let k = n; k < this.wetHeight.length; k++) {
      this.wetHeight[k] = dryStep(this.wetHeight[k], -Infinity, cp.wetDryRate, dt);
    }
    for (let k = 0; k < this.wetHeight.length; k++) {
      const v = this.wetHeight[k];
      // −Infinity is the "never touched" seed; the shader wants a finite
      // number well below any planking (§V.28: no Inf reaches the GPU)
      this.data[k * 4] = Number.isFinite(v) ? v : -1e4;
    }
    this.texture.needsUpdate = true;
  }
}
