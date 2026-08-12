/**
 * Island heightmap — pure CPU (T20). ZERO three.js imports on purpose: tests
 * (tests/island.test.ts) and sim code (buoyancy/grounding later) import this
 * without touching GPU/material modules.
 *
 * Shape = radial falloff dome × fbm (terrain/noiseCpu, same math as the T27
 * shader noise) + optional secondary gaussian peak. Deterministic per seed
 * (§V2-adjacent: createRng only — same seed → byte-identical Float32Array).
 *
 * Guarantees (pinned by tests):
 * - rim submerged: the dome shape is 0 at d ≥ radius, and noise is scaled by
 *   the shape, so every boundary sample sits exactly at -rimDepth < 0.
 * - interior peak ≥ minPeakHeight: positive heights are rescaled up if the
 *   noise undershoots the target (degenerate params that never break the
 *   waterline throw — fail loud, §Rule 8).
 * - beach apron: heights inside ±beachBandWidth of the waterline are slope-
 *   compressed (×beachFlatness at the line, blending to 1 at the band edge),
 *   giving the gentle 0..~2 m sand ring of the refs. The remap is monotone,
 *   so it never creates new waterline crossings.
 *
 * heightAt(x, z) bilinearly samples the grid (island-local coords, y-up,
 * x/z ∈ [-radius, radius]; outside → -rimDepth). Mesh vertices come from the
 * same grid, so heightAt matches the rendered surface exactly at vertices and
 * to within one triangle's diagonal split elsewhere.
 */
import { createRng } from '../state/rng';
import { fbm2Cpu } from '../terrain/noiseCpu';
import {
  buildArchetype,
  combineFeatures,
  pickArchetype,
  type ArchetypeName,
  type Feature,
} from './archetypes';

/** structural subset of params/island.ts `IslandParams` used by generation */
export interface IslandHeightmapParams {
  radius: number;
  gridSize: number;
  peakHeight: number;
  minPeakHeight: number;
  noiseScale: number;
  noiseStrength: number;
  noiseOctaves: number;
  /** fraction of the footprint the archetype's features may occupy */
  featureExtent: number;
  /** metres over which two features fuse instead of creasing */
  featureBlend: number;
  /** coastline noise: world frequency (1/m) and amplitude as a fraction of peak */
  coastNoiseScale: number;
  coastNoiseStrength: number;
  /** fraction of the radius inside which the rim envelope does not act */
  rimStart: number;
  beachBandWidth: number;
  beachFlatness: number;
  rimDepth: number;
}

export interface IslandHeightmap {
  /** which silhouette family this island belongs to — "the one with the spine" */
  archetype: ArchetypeName;
  /** the features that carry the landmass (silhouette debugging / tests) */
  features: Feature[];
  /** row-major heights, data[iz * size + ix], meters relative to waterline 0 */
  data: Float32Array;
  /** grid resolution per side */
  size: number;
  /** grid spans [-worldRadius, worldRadius] on x and z */
  worldRadius: number;
  /** bilinear height sample, island-local coords; outside grid → -rimDepth */
  heightAt(x: number, z: number): number;
}

/** monotone slope compression around the waterline (see header) */
function beachApron(h: number, band: number, flatness: number): number {
  const b = Math.max(band, 1e-3);
  const a = Math.min(Math.abs(h) / b, 1);
  const t = a * a * (3 - 2 * a); // smoothstep
  return h * (flatness + (1 - flatness) * t);
}

export function generateIslandHeightmap(
  seed: number,
  params: IslandHeightmapParams,
  /** archetypes the caller wants avoided — the archipelago spreads silhouettes */
  avoidArchetypes: readonly ArchetypeName[] = [],
): IslandHeightmap {
  const p = params;
  const size = Math.max(2, Math.floor(p.gridSize));
  const R = p.radius;
  const rng = createRng(seed);

  // seed-derived noise domain offsets (two independent fields: the coastline
  // one must not correlate with the surface-detail one, or headlands would
  // always coincide with ridges)
  const ox = rng() * 1024;
  const oz = rng() * 1024;
  const cx = rng() * 1024;
  const cz = rng() * 1024;

  const archetype = pickArchetype(rng, avoidArchetypes);
  const features = buildArchetype(archetype, rng, R * p.featureExtent, p.peakHeight);
  const blend = Math.max(p.featureBlend, 1e-3); // §V28 floored divisor
  // amplitude relative to peak, so a taller island gets a bolder coastline —
  // and so a zero-peak island stays fully submerged and throws below
  const coastAmp = p.peakHeight * p.coastNoiseStrength;
  const detailAmp = p.peakHeight * p.noiseStrength;
  const rimStart = Math.min(Math.max(p.rimStart, 0.05), 0.99);
  const rimSpan = Math.max(1 - rimStart, 1e-3); // §V28 floored divisor

  const rawHeight = (x: number, z: number): number => {
    const land = combineFeatures(features, x, z, blend);

    // COASTLINE NOISE at absolute amplitude. The old field multiplied noise by
    // the dome, which zeroed it exactly at the rim — the one place coastline
    // shape lives — and measured a shore-radius variation of only 10-16%.
    // Out here the features have already died to ~0, so this term alone
    // decides where the land meets the water: coves, spits and headlands.
    const coast = (fbm2Cpu(x * p.coastNoiseScale + cx, z * p.coastNoiseScale + cz, 3) * 2 - 1) * coastAmp;

    // surface detail, weighted up on high ground so summits are broken and
    // the beach apron stays walkable
    const n = fbm2Cpu(x * p.noiseScale + ox, z * p.noiseScale + oz, p.noiseOctaves) * 2 - 1;
    const relief = Math.min(Math.max(land / Math.max(p.peakHeight, 1e-3), 0), 1);
    const detail = n * detailAmp * (0.3 + 0.7 * relief);

    // RIM ENVELOPE. The rim guarantee used to be bought by multiplying the
    // whole field by a dome that vanished at d=1, which is what made every
    // coastline a circle. This instead leaves everything inside `rimStart`
    // completely free and only forces the last band under water, so the
    // guarantee costs nothing where the shore actually is.
    const d = Math.hypot(x, z) / Math.max(R, 1e-3);
    const t = Math.min(Math.max((d - rimStart) / rimSpan, 0), 1);
    const edge = t * t * (3 - 2 * t);
    const h = (land + coast + detail) * (1 - edge) + -p.rimDepth * edge;
    return beachApron(h, p.beachBandWidth, p.beachFlatness);
  };

  const data = new Float32Array(size * size);
  const cell = (2 * R) / (size - 1);
  let max = -Infinity;
  for (let iz = 0; iz < size; iz++) {
    const z = -R + iz * cell;
    for (let ix = 0; ix < size; ix++) {
      const h = rawHeight(-R + ix * cell, z);
      data[iz * size + ix] = h;
      if (h > max) max = h;
    }
  }

  // guarantee: interior peak ≥ minPeakHeight (scale positive heights only)
  if (max <= 0) {
    throw new Error(
      `generateIslandHeightmap: island never breaks the waterline (max=${max.toFixed(2)}m) — check radius/peakHeight/rimDepth params`,
    );
  }
  if (max < p.minPeakHeight) {
    const s = p.minPeakHeight / max;
    for (let i = 0; i < data.length; i++) {
      if (data[i] > 0) data[i] *= s;
    }
  }

  const heightAt = (x: number, z: number): number => {
    const gx = (x + R) / cell;
    const gz = (z + R) / cell;
    if (gx < 0 || gz < 0 || gx > size - 1 || gz > size - 1) return -p.rimDepth;
    const x0 = Math.min(Math.floor(gx), size - 2);
    const z0 = Math.min(Math.floor(gz), size - 2);
    const fx = gx - x0;
    const fz = gz - z0;
    const i00 = data[z0 * size + x0];
    const i10 = data[z0 * size + x0 + 1];
    const i01 = data[(z0 + 1) * size + x0];
    const i11 = data[(z0 + 1) * size + x0 + 1];
    const a = i00 + (i10 - i00) * fx;
    const b = i01 + (i11 - i01) * fx;
    return a + (b - a) * fz;
  };

  return { data, size, worldRadius: R, heightAt, archetype, features };
}

/**
 * Radial samples when locating the shoreline along a ray — resolution of the
 * search, not a look tunable, hence a named constant (comparable to gridSize).
 */
const SHORE_SAMPLES = 96;

/**
 * March a ray at `angle` from the rim INWARD and return the radius where the
 * terrain first rises above the waterline (the rim is guaranteed submerged,
 * so scanning outside-in never trips over interior noise valleys).
 * Fully-submerged rays (degenerate) return radius/2.
 */
export function findShoreRadius(hm: IslandHeightmap, angle: number): number {
  const cx = Math.cos(angle);
  const sz = Math.sin(angle);
  let prev = hm.worldRadius;
  for (let i = SHORE_SAMPLES; i >= 0; i--) {
    const r = (i / SHORE_SAMPLES) * hm.worldRadius;
    if (hm.heightAt(cx * r, sz * r) > 0) return (r + prev) / 2;
    prev = r;
  }
  return hm.worldRadius * 0.5;
}

/** central-difference gradient magnitude |∇h| (m/m) at an island-local point */
export function gradientAt(hm: IslandHeightmap, x: number, z: number): number {
  const eps = (2 * hm.worldRadius) / (hm.size - 1);
  const dhdx = (hm.heightAt(x + eps, z) - hm.heightAt(x - eps, z)) / (2 * eps);
  const dhdz = (hm.heightAt(x, z + eps) - hm.heightAt(x, z - eps)) / (2 * eps);
  return Math.hypot(dhdx, dhdz);
}
