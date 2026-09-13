/**
 * Swell shelter measurement for course sectors (§T.187 on §T.174).
 *
 * A gate's sector is MEASURED, never authored: the diffraction coefficient K
 * of the swell shadow (ocean/swellShadow.ts, docs/ocean/swell-shadow.md) is
 * read at the gate from the same fetch field the drawn sea and the CPU mirror
 * use, built over the circuit's own seabed.
 *
 * The REFERENCE SEA is the shipped default ('swell' preset, "Working sea"),
 * snapshotted — not the live `oceanParams`, which the weather presets and the
 * settings store mutate. A sector is a property of the circuit (it gates Surge
 * earning, design doc §3), so it must not move when the player picks Calm.
 * Other sea states shift the lee with the swell bearing; that is expected and
 * is the sea doing its job.
 */
import { oceanParams, type OceanParams } from '../params/ocean';
import { weatherPresets } from '../weather/presets';
import { createSeabedField, type SeabedField, type SeabedIsland } from '../island/seabed';
import { createFetchField, type FetchField } from '../ocean/fetchField';

/** the sea the sectors are measured in: the shipped default preset, frozen at import */
export const REFERENCE_SEA: Readonly<OceanParams> = Object.freeze({ ...oceanParams, ...weatherPresets.swell.ocean });

/**
 * Sector thresholds on K. Tagging splits at SECTOR_SPLIT_K; a gate must also be
 * DECISIVE — K ≤ SHELTERED_MAX_K or ≥ EXPOSED_MIN_K — so a small change in the
 * shadow model cannot flip a tag (tests/circuit.test.ts). K = 0.5 is a quarter
 * of the swell's energy; 0.8 is 64%.
 */
export const SHELTERED_MAX_K = 0.5;
export const EXPOSED_MIN_K = 0.8;
export const SECTOR_SPLIT_K = 0.65;

export interface ShelterField {
  seabed: SeabedField;
  fetch: FetchField;
  /** swell diffraction coefficient K at a world XZ, reference sea */
  kAt(x: number, z: number): number;
  dispose(): void;
}

/**
 * Build the reference shelter over a set of island heightmaps. `seabed` may be
 * passed in (the page already has the archipelago's); the fetch field is always
 * its own, on REFERENCE_SEA.
 */
export function createShelterField(islands: readonly SeabedIsland[], seabed?: SeabedField): ShelterField {
  const bed = seabed ?? createSeabedField(islands);
  const fetch = createFetchField(bed, { ...REFERENCE_SEA });
  return {
    seabed: bed,
    fetch,
    kAt: (x, z) => fetch.shadowAt(x, z),
    dispose() {
      fetch.dispose();
      if (!seabed) bed.dispose();
    },
  };
}

export function sectorOf(k: number): 'exposed' | 'sheltered' {
  return k < SECTOR_SPLIT_K ? 'sheltered' : 'exposed';
}
