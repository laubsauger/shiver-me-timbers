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
 * LAYOUT: `stations` samples uniformly spanning sternZ→bowZ, TWO ROWS PER
 * HULL (row 2·slot = port, row 2·slot + 1 = starboard), value = ship-local Y
 * the sea reached. sea-physics/hullContact.ts samples a BOW-BIASED (t^1.6) set
 * of slices, so `updateFromHullContact` resamples rather than index-matching —
 * feeding its arrays in directly would bunch the whole waterline into the
 * forward third.
 *
 * §T177 — ONE WETLINE PER PAGE WAS ONE HULL. The eight speedboats share seven
 * materials (docs/speedboat/asset-pipeline.md §5.3), and a material bakes ONE
 * TSL graph, so every rival was reading the HERO's drying memory: a rival on
 * her chines next to a hero flying carried the hero's boot-top. The fix is an
 * ATLAS, not a second texture — `slots` hulls in the one RGBA32F feed, picked
 * by an object-scoped slot uniform in waterLighting.ts. No new sampler and no
 * new binding (§V40, tests/shipBindingBudget.test.ts), and `slots = 1` is the
 * old texture byte for byte, so the raft and the pirate ship are untouched.
 *
 * ROWS CANNOT BLEED. A boat's two rows are sampled at their own texel centres
 * and `side` is a smoothstep in [0,1], so v never leaves [row, row+1] of THIS
 * hull — the LinearFilter blend across the keel is the same one it always was
 * and the neighbouring hull's rows are unreachable.
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

/**
 * Hulls one atlas may carry. The race is ≤ 8 boats and the page also builds a
 * marshal skiff, so 12 leaves room without pretending the cap is free: the
 * feed is `stations × 2 × slots` floats on the CPU and the same RGBA32F on the
 * GPU (24 × 24 × 4 × 4 B = 9 KB at the cap — a rounding error against the
 * ocean's cascades, and still ONE binding).
 */
export const WETLINE_MAX_SLOTS = 12;

/** the atlas row a hull's side lives on: 2·slot = port, 2·slot + 1 = starboard (§T177) */
export function wetlineRow(slot: number, side: 0 | 1): number {
  return slot * 2 + side;
}

/**
 * Texture v of a row — its OWN texel centre. The shader's v is this with the
 * port/starboard smoothstep sliding between the pair, so a hull can reach
 * both of its rows and neither of anyone else's (waterLighting `wetDepthNode`).
 */
export function wetlineRowV(row: number, rows: number): number {
  return (row + 0.5) / rows;
}

export interface HullWetlineOptions {
  /** ship-space z of the stem — matches sea-physics HullWaterline.bowZ */
  bowZ: number;
  /** ship-space z of the transom */
  sternZ: number;
  /** stations per side; defaults to the params value */
  stations?: number;
  /**
   * hulls this atlas carries, each with its own drying memory (§T177).
   * Default 1 — the single-hull pages (raft, pirate ship) are unchanged.
   * The receiver picks its slot from `userData.wetlineSlot` on the drawn
   * object or its nearest ancestor (waterLighting.ts `wetlineSlotOf`).
   */
  slots?: number;
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
  /** stations × rows (2 per hull: 2·slot = port, 2·slot + 1 = starboard), RGBA32F, R = wet height */
  readonly texture: THREE.DataTexture;
  /** ship-local Y the sea most recently reached, row-major [slot 0 port…, slot 0 starboard…, slot 1 port…, …] */
  readonly wetHeight: Float32Array;
  readonly stations: number;
  /** hulls this atlas carries (§T177) */
  readonly slots: number;
  /** texture rows — `2 * slots`; waterLighting maps a slot onto its pair */
  readonly rows: number;
  readonly bowZ: number;
  readonly sternZ: number;

  private data: Float32Array;
  /** scratch: resampled contact height per grid cell of ONE slot, rebuilt each update */
  private contact: Float32Array;

  constructor(opts: HullWetlineOptions) {
    this.stations = Math.max(2, Math.floor(opts.stations ?? cp.wetStations));
    const want = Math.floor(opts.slots ?? 1);
    if (!(want >= 1 && want <= WETLINE_MAX_SLOTS)) {
      // fail loud (§Rule 8): silently clamping would hand two boats one slot
      // and reintroduce exactly the §T177 bug this atlas exists to kill
      throw new Error(`HullWetline: slots (${opts.slots}) must be 1…${WETLINE_MAX_SLOTS}`);
    }
    this.slots = want;
    this.rows = want * 2;
    this.bowZ = opts.bowZ;
    this.sternZ = opts.sternZ;
    if (!(this.bowZ > this.sternZ)) {
      // fail loud (§Rule 8): a reversed hull silently maps every fragment to
      // one end of the texture and the band would never move
      throw new Error(`HullWetline: bowZ (${this.bowZ}) must exceed sternZ (${this.sternZ})`);
    }
    this.wetHeight = new Float32Array(this.stations * this.rows).fill(-Infinity);
    this.contact = new Float32Array(this.stations * 2);
    this.data = new Float32Array(this.stations * this.rows * 4);
    this.texture = new THREE.DataTexture(
      this.data,
      this.stations,
      this.rows,
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
    // §V.28 / §B.8 class: publish the seed BEFORE the first update, so the
    // texture never spends a frame holding an implicit zero. A raw zero here
    // would read as "the sea reached ship-local y = 0" — plausible enough to
    // hide a wiring failure, which is exactly the silent-wrongness this
    // project keeps paying for. The seed is bone dry instead: unambiguous,
    // and the first updateFromHullContact corrects it the same frame.
    this.publish();
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
    /** which hull (§T177); 0 on the single-hull pages */
    slot = 0,
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
    this.applyContacts(dt, this.contact, slot);
  }

  /**
   * Raw feed, index-aligned to ONE slot's grid: [port stern→bow…, starboard…]
   * in ship-local Y. Use when a caller already has the wetted height directly.
   */
  updateFromContacts(dt: number, contactLocalY: ArrayLike<number>, slot = 0): void {
    this.applyContacts(dt, contactLocalY, slot);
  }

  /** base index of a slot's block in `wetHeight`; throws on an unallocated slot (§Rule 8) */
  private base(slot: number): number {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.slots) {
      throw new Error(`HullWetline: slot ${slot} is outside 0…${this.slots - 1} (built with slots: ${this.slots})`);
    }
    return slot * 2 * this.stations;
  }

  private applyContacts(dt: number, contact: ArrayLike<number>, slot: number): void {
    // ONE SLOT ONLY. A hull that stops being fed keeps its last memory rather
    // than drying — nothing draws it (no object maps to a free slot), and
    // drying every other boat on every boat's update would make the rate
    // depend on how many boats the page happens to run.
    const base = this.base(slot);
    const span = this.stations * 2;
    const n = Math.min(span, contact.length);
    for (let k = 0; k < n; k++) {
      this.wetHeight[base + k] = dryStep(this.wetHeight[base + k], contact[k], cp.wetDryRate, dt);
    }
    // stations with no feed still dry out rather than freezing
    for (let k = n; k < span; k++) {
      this.wetHeight[base + k] = dryStep(this.wetHeight[base + k], -Infinity, cp.wetDryRate, dt);
    }
    this.publish();
  }

  private publish(): void {
    for (let k = 0; k < this.wetHeight.length; k++) {
      const v = this.wetHeight[k];
      // −Infinity is the "never touched" seed; the shader wants a finite
      // number well below any planking (§V.28: no Inf reaches the GPU)
      this.data[k * 4] = Number.isFinite(v) ? v : -1e4;
    }
    this.texture.needsUpdate = true;
  }
}

/**
 * §T177 — THE WATERLINE OF A HULL THE PHYSICS DOES NOT SOLVE ON THIS THREAD.
 *
 * The player's wetline comes off her own contact patch (`HullWaterStations`,
 * sea-physics/hullWater.ts): the sea she was actually pushed by. A rival is
 * stepped in the sim worker and only her POSE crosses back, so her wetline is
 * reconstructed here from that pose against the page's water sampler — the
 * same `waterAt` the pace boat floats on, so the band sits on the water the
 * page draws (B125: `waterAt` is `pressureHeadAt + wakeField.heightAt`, her
 * own mound included) rather than on still water.
 *
 * WHAT IT SOLVES: the ship-local y at which the BODY-vertical line through
 * body station (x, z) crosses the surface. Body-vertical, not world-vertical,
 * because the wetline's whole frame is ship-local — that is what makes the
 * band stay on the planking when she rolls. The surface moves as y does (the
 * line leans), so it is the same 3-step fixed point `HullWaterStations.update`
 * runs, deliberately mirrored rather than shared: that method needs a whole
 * `HullWater` and its solved patch, neither of which a rival has here.
 *
 * NaN out when the hull is past ~84° of heel (`upY > 0.1`: no vertical line
 * left to intersect) or the sampler has no data — `updateFromHullContact`
 * skips non-finite stations and interpolates the neighbours, and a station
 * with no neighbour dries. Never a clamped guess (§V.28, §Rule 8).
 */
export function wetlineContactsFromPose(
  position: ArrayLike<number>,
  quaternion: ArrayLike<number>,
  stations: readonly WetlineStation[],
  waterAt: (x: number, z: number) => number,
  out: Float32Array | Float64Array,
): void {
  const qx = quaternion[0], qy = quaternion[1], qz = quaternion[2], qw = quaternion[3];
  const px = position[0], py = position[1], pz = position[2];
  // body +y's world y component: the vertical line's rise per unit body y
  const upY = 1 - 2 * (qx * qx + qz * qz);
  const n = Math.min(stations.length, out.length);
  for (let k = 0; k < n; k++) {
    const bx = stations[k].x;
    const bz = stations[k].z;
    if (!(upY > 0.1) || !Number.isFinite(bx) || !Number.isFinite(bz)) {
      out[k] = Number.NaN;
      continue;
    }
    let y = 0;
    for (let it = 0; it < 3; it++) {
      // world = p + q·(bx, y, bz), the rotation WaterPatch.build uses
      const tx = 2 * (qy * bz - qz * y);
      const ty = 2 * (qz * bx - qx * bz);
      const tz = 2 * (qx * y - qy * bx);
      const lx = px + bx + qw * tx + (qy * tz - qz * ty);
      const ly = py + y + qw * ty + (qz * tx - qx * tz);
      const lz = pz + bz + qw * tz + (qx * ty - qy * tx);
      const h = waterAt(lx, lz);
      if (!Number.isFinite(h)) { y = Number.NaN; break; }
      const step = (h - ly) / upY;
      y += step;
      // CONVERGENCE, not a fidelity cut. The iteration only exists because the
      // line LEANS, so the sample point moves as y does; on a level hull the
      // first step is already exact and the second measures zero. Measured in
      // the browser: `waterAt` is ~4 µs a call (the CPU ocean's spectrum sum)
      // and IS the whole cost of this function — the arithmetic around it is
      // 3.6 µs for eight hulls — so stopping as soon as the correction is
      // sub-millimetre takes a third off it for nothing.
      if (Math.abs(step) < 1e-3) break;
    }
    out[k] = Number.isFinite(y) ? y : Number.NaN;
  }
}
