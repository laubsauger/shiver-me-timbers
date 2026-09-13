/**
 * COSMETIC DAMAGE (§T.188; design doc §3 "Damage": scuffs, tape peeling, windscreen crack, bent hoop brace, missing
 * hatch — cosmetic for the race, no handling effect). Per-zone values 0..1 the render maps onto its scuff/dent mask;
 * they only grow during a race (saturating), and `resetDamage` clears them for the next one.
 *
 * Zones, body frame (x across, y up from the CG, z forward; the render reads the index). SIDES: right-handed with y up,
 * a pilot facing +z has forward × up = z × y = −x on the right, so STARBOARD is body −x and PORT is body +x:
 *   0 BOW_PORT  1 BOW_STARBOARD  (z > bow line)
 *   2 SIDE_PORT 3 SIDE_STARBOARD (between)
 *   4 STERN (z < stern line: transom, bracket, cowls)
 *   5 COCKPIT (above the deck: windscreen, roll hoop, hatch)
 */
import type { CrashKind } from './detect';

export const DAMAGE_ZONES = ['bowPort', 'bowStarboard', 'sidePort', 'sideStarboard', 'stern', 'cockpit'] as const;
export type DamageZone = (typeof DAMAGE_ZONES)[number];
export const ZONE = Object.freeze({ BOW_PORT: 0, BOW_STARBOARD: 1, SIDE_PORT: 2, SIDE_STARBOARD: 3, STERN: 4, COCKPIT: 5 });

export interface DamageState {
  /** per zone 0..1, index = ZONE.* */
  zones: Float32Array;
  /** bumps whenever a zone changes (the render re-uploads its mask only then) */
  version: number;
}

export function createDamage(): DamageState {
  return { zones: new Float32Array(DAMAGE_ZONES.length), version: 0 };
}

export function resetDamage(d: DamageState): void {
  d.zones.fill(0);
  d.version++;
}

export interface DamageGeometry {
  /** body z forward of which a hit is a bow hit, m */
  bowZ: number;
  /** body z aft of which a hit is a stern hit, m */
  sternZ: number;
  /** body y above which a hit is in the cockpit (deck level), m */
  deckY: number;
}

/** below this |Δv| a contact leaves no mark, m/s (a rub) */
export const DAMAGE_MIN_DV = 1;
/** |Δv| that fills an empty zone halfway, m/s */
export const DAMAGE_HALF_DV = 10;

function add(d: DamageState, zone: number, amount: number): void {
  if (!(amount > 0)) return;
  const z = d.zones[zone];
  d.zones[zone] = z + Math.min(1, amount) * (1 - z);
  d.version++;
}

export function zoneAt(g: Readonly<DamageGeometry>, bx: number, by: number, bz: number): number {
  if (by > g.deckY) return ZONE.COCKPIT;
  if (bz < g.sternZ) return ZONE.STERN;
  const starboard = bx < 0;
  if (bz > g.bowZ) return starboard ? ZONE.BOW_STARBOARD : ZONE.BOW_PORT;
  return starboard ? ZONE.SIDE_STARBOARD : ZONE.SIDE_PORT;
}

/** a collision at a body-frame point with this boat's |Δv| */
export function addContactDamage(d: DamageState, g: Readonly<DamageGeometry>, bx: number, by: number, bz: number, deltaV: number): void {
  if (deltaV < DAMAGE_MIN_DV) return;
  const e = deltaV - DAMAGE_MIN_DV;
  add(d, zoneAt(g, bx, by, bz), e / (e + DAMAGE_HALF_DV - DAMAGE_MIN_DV));
}

/** the wear a crash kind leaves without a collision (green water, a roll onto the hoop, a transom-first landing) */
export function addCrashDamage(d: DamageState, kind: CrashKind, heelDeg: number): void {
  switch (kind) {
    case 'stuff':
      add(d, ZONE.BOW_PORT, 0.25);
      add(d, ZONE.BOW_STARBOARD, 0.25);
      add(d, ZONE.COCKPIT, 0.2);
      break;
    case 'barrelRoll':
      add(d, ZONE.COCKPIT, 0.35);
      add(d, ZONE.SIDE_PORT, 0.15);
      add(d, ZONE.SIDE_STARBOARD, 0.15);
      break;
    case 'blowOver':
      add(d, ZONE.STERN, 0.3);
      add(d, ZONE.COCKPIT, 0.25);
      break;
    case 'hook':
      // the low side catches: heel > 0 lifts body +x (right·Ŷ > 0 for the +x axis), i.e. port up, starboard in the water
      add(d, heelDeg >= 0 ? ZONE.SIDE_STARBOARD : ZONE.SIDE_PORT, 0.2);
      break;
    case 'impact':
      break; // the contact itself marks the hull
  }
}

/** discrete pieces the render swaps in (design doc §3) */
export interface DamageFeatures {
  scuffs: boolean;
  tapePeeling: boolean;
  windscreenCrack: boolean;
  hoopBent: boolean;
  hatchMissing: boolean;
}

export function damageFeatures(d: Readonly<DamageState>, out: DamageFeatures = { scuffs: false, tapePeeling: false, windscreenCrack: false, hoopBent: false, hatchMissing: false }): DamageFeatures {
  const z = d.zones;
  let hull = 0;
  for (let i = 0; i < ZONE.COCKPIT; i++) hull = Math.max(hull, z[i]);
  out.scuffs = hull > 0.05;
  out.tapePeeling = hull > 0.3;
  out.windscreenCrack = z[ZONE.COCKPIT] > 0.3;
  out.hoopBent = z[ZONE.COCKPIT] > 0.6;
  out.hatchMissing = Math.max(z[ZONE.BOW_PORT], z[ZONE.BOW_STARBOARD]) > 0.5;
  return out;
}
