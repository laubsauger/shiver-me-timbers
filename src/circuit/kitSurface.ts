/**
 * RACE KIT SURFACE MASKS (§T.194) — what the ground of a kit island IS, baked
 * once per island on the CPU from its finished heightmap, uploaded as one
 * RGBA8 layer next to the sierra atlas layer (kitMaterial.ts reads it).
 *
 * The sierra material decides rock/grus/sand by slope, curvature and a shore
 * band keyed to height. That is right for a 30-500 m granite dome whose foot is
 * a DG beach, and wrong for every race island: the rock garden's whalebacks are
 * bedrock DOWN INTO the surf, a cay is sand to its crest, and a drowned town's
 * knoll is rubble. At a race boat's range (5-30 m at speed) that is the whole
 * read, so the kit says it explicitly:
 *
 *   R  bedrock   granite (tidal zonation below, sierra granite above)
 *   G  rubble    concrete/asphalt/brick fragments and soil (the drowned town)
 *   B  exposure  0 in the lee … 1 facing the open swell: splash height, salt
 *   A  strand    sand that carries a strandline (wrack, shell litter)
 *
 * Pure CPU, zero three imports, deterministic in (heightmap, kind, swell).
 */
import type { IslandHeightmap } from '../island/heightmap';
import { fbm2Cpu } from '../terrain/noiseCpu';
import type { KitSpec } from './kitFamilies';

export type KitKind = KitSpec['kind'];

export interface KitSurfaceMask {
  size: number;
  radius: number;
  /** RGBA8 row-major, size² × 4 */
  bytes: Uint8Array;
  bakeMs: number;
}

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
const smooth = (e0: number, e1: number, x: number): number => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** what the surface bake needs to know about one kit island */
export interface KitSurfaceInput {
  kind: KitKind;
  /** unit swell TRAVEL direction in the island's world-aligned local frame */
  swellTravel: readonly [number, number];
  /** a per-island noise offset so two islands' patches differ */
  seed: number;
}

/** metres of upswell fetch the exposure march looks along */
const EXPOSURE_FETCH = 160;
const EXPOSURE_STEP = 6;

export function bakeKitSurface(hm: IslandHeightmap, input: KitSurfaceInput): KitSurfaceMask {
  const t0 = performance.now();
  const n = hm.size;
  const R = hm.worldRadius;
  const cell = (2 * R) / (n - 1);
  const d = hm.data;
  const bytes = new Uint8Array(n * n * 4);
  const o = (input.seed % 997) * 0.731;
  const [tx, tz] = input.swellTravel;
  const at = (ix: number, iz: number): number =>
    d[Math.min(Math.max(iz, 0), n - 1) * n + Math.min(Math.max(ix, 0), n - 1)];

  for (let iz = 0; iz < n; iz++) {
    const z = -R + iz * cell;
    for (let ix = 0; ix < n; ix++) {
      const x = -R + ix * cell;
      const h = d[iz * n + ix];
      const hx = (at(ix + 1, iz) - at(ix - 1, iz)) / (2 * cell);
      const hz = (at(ix, iz + 1) - at(ix, iz - 1)) / (2 * cell);
      const slope = Math.hypot(hx, hz);
      const lap = (at(ix + 1, iz) + at(ix - 1, iz) + at(ix, iz + 1) + at(ix, iz - 1) - 4 * h) / (cell * cell);
      const patch = fbm2Cpu(x / 11 + o, z / 11 - o, 3);

      // ── exposure: open upswell water AND a face turned toward it ──────────
      let blocked = 0;
      if (h > -4) {
        for (let s = EXPOSURE_STEP; s <= EXPOSURE_FETCH; s += EXPOSURE_STEP) {
          const gx = Math.round((x - tx * s + R) / cell);
          const gz = Math.round((z - tz * s + R) / cell);
          if (gx < 0 || gz < 0 || gx >= n || gz >= n) break;
          const hh = d[gz * n + gx];
          if (hh > h + 0.5 && hh > 0.3) {
            blocked = Math.max(blocked, 1 - s / EXPOSURE_FETCH);
          }
        }
      }
      // the downhill direction is the way the ground faces; facing the swell = against its travel
      const facing = slope > 1e-3 ? clamp01(((hx * tx + hz * tz) / slope) * 0.5 + 0.5) : 0.5;
      const exposure = clamp01((1 - blocked) * (0.25 + 0.75 * facing));

      let bedrock = 0;
      let rubble = 0;
      let strand = 0;
      switch (input.kind) {
        case 'rockGarden': {
          // the whole garden is granite; sand only collects in flat, concave
          // pockets at the waterline and in patches on the platform floor
          const pocket =
            smooth(0.16, 0.06, slope) * smooth(-3.5, -1.5, h) * smooth(1.6, 0.6, h) * smooth(0.002, -0.01, lap) * smooth(0.46, 0.56, patch);
          const floorSand = smooth(-4, -9, h) * smooth(0.5, 0.62, patch);
          bedrock = clamp01(smooth(-14, -10, h) * (1 - pocket) * (1 - floorSand));
          strand = pocket * smooth(-0.5, 0.2, h);
          break;
        }
        case 'sandCay': {
          // beachrock: cemented sand slabs exposed in the intertidal, in patches
          const beachrock = smooth(-1.1, -0.6, h) * smooth(0.7, 0.3, h) * smooth(0.58, 0.66, patch) * smooth(0.25, 0.08, slope);
          bedrock = beachrock;
          strand = smooth(-0.6, 0.1, h) * (1 - beachrock);
          break;
        }
        case 'drownedTown': {
          // rubble on the bench and the knoll; bare rock where the knoll is steep
          const steep = smooth(0.55, 0.9, slope) * smooth(-2, 1, h);
          bedrock = steep;
          rubble = smooth(-11, -8, h) * (1 - steep) * (0.55 + 0.45 * smooth(0.35, 0.6, patch));
          strand = smooth(-0.5, 0.2, h) * smooth(4, 2, h) * (1 - steep) * smooth(0.5, 0.35, patch);
          break;
        }
      }
      const b = (iz * n + ix) * 4;
      bytes[b] = Math.round(bedrock * 255);
      bytes[b + 1] = Math.round(rubble * 255);
      bytes[b + 2] = Math.round(exposure * 255);
      bytes[b + 3] = Math.round(strand * 255);
    }
  }
  return { size: n, radius: R, bytes, bakeMs: performance.now() - t0 };
}

/** bilinear CPU read of one mask channel (0 R, 1 G, 2 B, 3 A) at island-local x, z — decor placement */
export function sampleKitSurface(mask: KitSurfaceMask, channel: 0 | 1 | 2 | 3, x: number, z: number): number {
  const n = mask.size;
  const cell = (2 * mask.radius) / (n - 1);
  const gx = Math.min(Math.max((x + mask.radius) / cell, 0), n - 1);
  const gz = Math.min(Math.max((z + mask.radius) / cell, 0), n - 1);
  const x0 = Math.min(Math.floor(gx), n - 2);
  const z0 = Math.min(Math.floor(gz), n - 2);
  const fx = gx - x0;
  const fz = gz - z0;
  const v = (i: number, j: number): number => mask.bytes[(j * n + i) * 4 + channel] / 255;
  const top = v(x0, z0) + (v(x0 + 1, z0) - v(x0, z0)) * fx;
  const bot = v(x0, z0 + 1) + (v(x0 + 1, z0 + 1) - v(x0, z0 + 1)) * fx;
  return top + (bot - top) * fz;
}
