/**
 * THE WORLD THE RIVALS FLOAT IN (§T.191, §V110, §V8). Plain, structured-clone-safe data that lets a sim worker's own
 * `CpuOcean` shoal over, be fetch-limited and swell-shadowed by, and ground on EXACTLY what the page's mirror uses for
 * the player — bit for bit, not "close enough":
 *
 *   seabed   The archipelago seabed's `heightAt` is a closure over the island heightmaps (not transferable). Instead
 *            both sides sample ONE Float32 grid baked at texel centres (origin + (i + 0.5)·cell, the convention the
 *            GPU seabed texture is baked on and `sampleGrid` reads): the page calls
 *            `cpuOcean.setSeabed(gridSeabed(world), −openHeight)`, the core does the same with its copy. Same
 *            numbers, same expression ⇒ same shoaling on both sides.
 *   fetch    The fetch/swell-shadow grids are private to `ocean/fetchField.ts` and rebuild from the LIVE params on read
 *            (§B119), keyed by `FetchField.version`. Copying them per version would cost MBs per wind shift and texel
 *            read-back is not bit-exact. The grids are a deterministic function of (land mask, params), so the worker
 *            rebuilds its own field with `createFetchField` over a seabed that answers the PAGE's land mask bit at
 *            each fetch texel centre: same mask, same params per tick (the batch rows carry them) ⇒ the same sweeps,
 *            marches, versions and samples as the page's field (tests/simWorkerWorldData.test.ts).
 *   bed      Hull↔terrain contact reads `createRaceSeabed(gridSeabed.heightAt, bars)` on BOTH sides (sandbars pass
 *            boats through, §T.187).
 *
 * Pure: no three.js here (the masked fetch field is built by `ocean/fetchField`, which the worker core already
 * imports through the ocean mirror).
 */
import { createRaceSeabed } from '../circuit/raceSeabed';
import { createFetchField, sampleGrid, type FetchField } from '../ocean/fetchField';
import type { OceanParams } from '../params/ocean';
import type { SeabedField } from '../island/seabed';

export interface SimWorldData {
  version: 1;
  /** texel-centre grid of the archipelago seabed heightAt (origin + (i+0.5)·cell), Float32 */
  seabed: { res: number; origin: [number, number]; size: number; openHeight: number; heights: Float32Array };
  /** land mask (seabed.heightAt >= 0) at the FETCH field's texel centres, computed with createFetchField's exact expressions; seabedOrigin/seabedSize = the seabed the page fetch field was built over */
  fetch: { res: number; seabedOrigin: [number, number]; seabedSize: number; land: Uint8Array };
  /** circuit bar zones (createRaceSeabed pass-through) */
  bars: { crest: [number, number][]; halfWidth: number }[];
}

export interface SeabedSource {
  heightAt(x: number, z: number): number;
  origin: readonly [number, number];
  size: number;
  openHeight: number;
}

/**
 * Default grid resolution. Tower Reach's seabed spans 3086 m: 1024² = 3.01 m texels, 3.9 MB, 1.27 s bake measured
 * under parallel-agent load (2048² = 1.51 m, 15.6 MB, 3.4 s). Pass `res` for a finer bed.
 */
export const SIM_WORLD_SEABED_RES = 1024;

/** the fetch grid geometry `createFetchField(seabed, op)` derives — the SAME expressions, in the same order */
function fetchGeometry(seabedOrigin: readonly [number, number], seabedSize: number, op: OceanParams): { res: number; origin: [number, number]; cell: number } {
  const res = Math.max(8, Math.floor(op.fetchFieldSize));
  const margin = Math.max(op.fetchFieldMargin, 0);
  const size = seabedSize + margin * 2;
  const origin: [number, number] = [seabedOrigin[0] - margin, seabedOrigin[1] - margin];
  return { res, origin, cell: size / res };
}

export function bakeSimWorldData(
  seabed: SeabedSource,
  oceanParams: OceanParams,
  bars: readonly { crest: readonly (readonly [number, number])[]; halfWidth: number }[],
  res: number = SIM_WORLD_SEABED_RES,
): SimWorldData {
  const n = Math.max(4, Math.floor(res));
  const origin: [number, number] = [seabed.origin[0], seabed.origin[1]];
  const size = seabed.size;
  const cell = size / n;
  const heights = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const wz = origin[1] + (j + 0.5) * cell;
    for (let i = 0; i < n; i++) heights[j * n + i] = seabed.heightAt(origin[0] + (i + 0.5) * cell, wz);
  }
  // the land mask exactly as createFetchField bakes it (wx/wz expressions copied from there, §B.34 class)
  const fg = fetchGeometry(seabed.origin, seabed.size, oceanParams);
  const land = new Uint8Array(fg.res * fg.res);
  for (let j = 0; j < fg.res; j++) {
    const wz = fg.origin[1] + (j + 0.5) * fg.cell;
    for (let i = 0; i < fg.res; i++) {
      const wx = fg.origin[0] + (i + 0.5) * fg.cell;
      land[j * fg.res + i] = seabed.heightAt(wx, wz) >= 0 ? 1 : 0;
    }
  }
  return {
    version: 1,
    seabed: { res: n, origin, size, openHeight: seabed.openHeight, heights },
    fetch: { res: fg.res, seabedOrigin: [seabed.origin[0], seabed.origin[1]], seabedSize: seabed.size, land },
    bars: bars.map((b) => ({ crest: b.crest.map((p) => [p[0], p[1]] as [number, number]), halfWidth: b.halfWidth })),
  };
}

export function gridSeabed(d: SimWorldData): { heightAt(x: number, z: number): number; origin: [number, number]; size: number; openHeight: number } {
  const s = d.seabed;
  const cell = s.size / s.res;
  return {
    heightAt: (x, z) => sampleGrid(s.heights, s.res, s.origin, cell, x, z),
    origin: s.origin,
    size: s.size,
    openHeight: s.openHeight,
  };
}

/**
 * `createFetchField` over the baked land mask: `heightAt` at a fetch texel centre answers 0 (land) or −1 (water) from
 * the page's own mask, so every grid the field builds equals the page field's for the same params. Throws when the
 * params' fetch geometry is not the one the mask was baked for (a silently different grid is §V8 by another route).
 */
export function maskedFetchField(d: SimWorldData, oceanParams: OceanParams): FetchField {
  const f = d.fetch;
  const fg = fetchGeometry(f.seabedOrigin, f.seabedSize, oceanParams);
  if (fg.res !== f.res) throw new Error(`sim world: fetch mask baked at ${f.res}², params ask for ${fg.res}² (fetchFieldSize changed after the bake)`);
  const res = f.res;
  const seabed = {
    origin: f.seabedOrigin,
    size: f.seabedSize,
    heightAt(x: number, z: number): number {
      const i = Math.round((x - fg.origin[0]) / fg.cell - 0.5);
      const j = Math.round((z - fg.origin[1]) / fg.cell - 0.5);
      if (i < 0 || j < 0 || i >= res || j >= res) return -1;
      return f.land[j * res + i] === 1 ? 0 : -1;
    },
  };
  return createFetchField(seabed as unknown as SeabedField, oceanParams);
}

export function raceBed(d: SimWorldData): { heightAt(x: number, z: number): number } {
  return createRaceSeabed(gridSeabed(d).heightAt, d.bars);
}
