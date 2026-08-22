/**
 * §T.112d — terrain-info texture + layered sierra shading (§V80: properties,
 * not decisions; §V88: GPU-free through the CPU bake and sampler).
 *
 * Synthetic grids pin the channel maths (a flat field, a pit, a dome, a bowl,
 * a tilted plane, a valley, an elliptical dome); a real sierra island pins
 * range, determinism and bake time; the binding ledger and the §V48 audit
 * pin the material's cost.
 */
import { describe, expect, it } from 'vitest';
import { generateIslandHeightmap, type IslandHeightmap } from '../src/island/heightmap';
import { sierraIslandParams } from '../src/island/sierraSites';
import { bakeHorizonMap, horizonMapFor } from '../src/island/horizonMap';
import {
  TERRAIN_INFO_CHANNELS,
  TerrainInfoChannels,
  decodeTerrainInfo,
  sampleTerrainChannel,
  sampleTerrainInfo,
  sheetingDirectionCpu,
} from '../src/island/terrainInfo';
import { bakeTerrainInfo, jointNoiseOffset, terrainInfoFor } from '../src/island/terrainInfoBake';
import { createIslandMaterials } from '../src/island/islandMaterials';
import { createSierraRockMaterial, createSierraTerrainMaterial } from '../src/island/sierraMaterial';
import { createSierraAtlas } from '../src/island/sierraAtlas';
import { sierraParams } from '../src/params/sierra';
import terrainInfoSource from '../src/island/terrainInfo.ts?raw';
import sierraMaterialSource from '../src/island/sierraMaterial.ts?raw';
import horizonMapSource from '../src/island/horizonMap.ts?raw';

// ── fixtures ──────────────────────────────────────────────────────────────

/** a heightmap over [-R, R]² from an analytic field — no archetype, no erosion */
function synthetic(size: number, radius: number, f: (x: number, z: number) => number): IslandHeightmap {
  const data = new Float32Array(size * size);
  const cell = (2 * radius) / (size - 1);
  for (let iz = 0; iz < size; iz++) {
    for (let ix = 0; ix < size; ix++) data[iz * size + ix] = f(-radius + ix * cell, -radius + iz * cell);
  }
  const heightAt = (x: number, z: number): number => {
    const gx = Math.min(Math.max((x + radius) / cell, 0), size - 1);
    const gz = Math.min(Math.max((z + radius) / cell, 0), size - 1);
    const x0 = Math.min(Math.floor(gx), size - 2);
    const z0 = Math.min(Math.floor(gz), size - 2);
    const fx = gx - x0;
    const fz = gz - z0;
    const a = data[z0 * size + x0] + (data[z0 * size + x0 + 1] - data[z0 * size + x0]) * fx;
    const b = data[(z0 + 1) * size + x0] + (data[(z0 + 1) * size + x0 + 1] - data[(z0 + 1) * size + x0]) * fx;
    return a + (b - a) * fz;
  };
  return { archetype: 'crestedDome', features: [], data, size, worldRadius: radius, lagoonCenter: null, heightAt };
}

/** bake with the horizon done first, so the timing below is THIS bake's */
function bake(hm: IslandHeightmap, opts: Parameters<typeof bakeTerrainInfo>[1] = {}) {
  return bakeTerrainInfo(hm, { horizon: bakeHorizonMap(hm.data, hm.size, hm.worldRadius), ...opts });
}

const SIZE = 65;
const R = 64;
let realDome: IslandHeightmap | null = null;
const dome = (): IslandHeightmap => {
  if (!realDome) realDome = generateIslandHeightmap(988, sierraIslandParams('dome', 250, 256));
  return realDome;
};

// ── the contract ──────────────────────────────────────────────────────────

describe('§T.112d channel layout (the shared interface)', () => {
  it('names every channel once: four in the RGBA8 texture, four derived at the fragment', () => {
    const inTexture = Object.keys(TerrainInfoChannels.texture);
    const derived = Object.keys(TerrainInfoChannels.derived);
    expect(new Set(TerrainInfoChannels.texture && Object.values(TerrainInfoChannels.texture)).size).toBe(4);
    expect([...inTexture, ...derived].sort()).toEqual([...TERRAIN_INFO_CHANNELS].sort());
  });

  it('every channel is in [0, 1] on a real sierra island, and the bytes match the float channels', () => {
    const info = terrainInfoFor(dome());
    for (const ch of TERRAIN_INFO_CHANNELS) {
      const arr = info.channels[ch];
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] < lo) lo = arr[i];
        if (arr[i] > hi) hi = arr[i];
      }
      expect(lo, ch).toBeGreaterThanOrEqual(0);
      expect(hi, ch).toBeLessThanOrEqual(1);
      expect(Number.isNaN(lo) || Number.isNaN(hi), ch).toBe(false);
    }
    const i = (info.size >> 1) * info.size + (info.size >> 1);
    expect(info.bytes[i * 4]).toBe(Math.round(info.channels.curvature[i] * 255));
    expect(info.bytes[i * 4 + 3]).toBe(Math.round(info.channels.debris[i] * 255));
    // the real island ran the erosion bake: debris is present somewhere
    expect(Math.max(...info.channels.debris)).toBeGreaterThan(0);
    expect(info.hasPath).toBe(typeof (dome() as { path?: unknown }).path !== 'undefined');
  });

  it('is deterministic and memoised per heightmap', () => {
    const hm = dome();
    const a = terrainInfoFor(hm);
    expect(terrainInfoFor(hm)).toBe(a);
    const b = bake(hm, { horizon: horizonMapFor(hm) });
    expect(b.bytes).toEqual(a.bytes);
    expect(b.channels.moisture).toEqual(a.channels.moisture);
    expect(jointNoiseOffset(hm)).toEqual(a.jointNoiseOffset);
  });

  it('bakes a 256² island in ≤ 40 ms (the horizon map reused, not rebaked)', () => {
    const hm = dome();
    const horizon = horizonMapFor(hm);
    // warm once (JIT), then measure the median of three
    bakeTerrainInfo(hm, { horizon });
    const ms: number[] = [];
    for (let i = 0; i < 3; i++) ms.push(bakeTerrainInfo(hm, { horizon }).bakeMs);
    ms.sort((a, b) => a - b);
    expect(hm.size).toBe(256);
    expect(ms[1]).toBeLessThanOrEqual(40);
  });
});

// ── channel maths on synthetic grids ──────────────────────────────────────

describe('§T.112d channels on synthetic fields', () => {
  it('skyAO = 1 on a flat field, < 1 in a pit', () => {
    const flat = bake(synthetic(SIZE, R, () => 10));
    expect(sampleTerrainChannel(flat, 'skyAO', 0, 0)).toBe(1);
    expect(sampleTerrainChannel(flat, 'slope', 0, 0)).toBe(0);
    // a 20 m deep pit, 12 m across, in a 30 m plain — ABOVE the sea: the
    // horizon bake leaves submerged cells open by design (nobody reads AO
    // through the seabed), so a pit below the waterline is not a pit to it
    const pit = bake(synthetic(SIZE, R, (x, z) => (Math.hypot(x, z) < 12 ? 10 : 30)));
    expect(sampleTerrainChannel(pit, 'skyAO', 0, 0)).toBeLessThan(1);
  });

  it('curvature is + on a dome crown and − in a bowl, with the encoded mid at 0.5', () => {
    const crown = bake(synthetic(SIZE, R, (x, z) => 40 * Math.exp(-(x * x + z * z) / 800)));
    const bowl = bake(synthetic(SIZE, R, (x, z) => 50 - 40 * Math.exp(-(x * x + z * z) / 800)));
    const kCrown = decodeTerrainInfo.curvaturePerMetre(sampleTerrainChannel(crown, 'curvature', 0, 0));
    const kBowl = decodeTerrainInfo.curvaturePerMetre(sampleTerrainChannel(bowl, 'curvature', 0, 0));
    expect(kCrown).toBeGreaterThan(0);
    expect(kBowl).toBeLessThan(0);
    // analytic: κ = −(hxx + hzz)/2 = 40·2/800 = 0.1 at the crown, clamped to the ±0.05 range
    expect(sampleTerrainChannel(crown, 'curvature', 0, 0)).toBe(1);
    const flat = bake(synthetic(SIZE, R, () => 10));
    expect(sampleTerrainChannel(flat, 'curvature', 0, 0)).toBeCloseTo(0.5, 6);
  });

  it('moisture is higher on a valley floor than on a ridge crest', () => {
    // a V valley along z, tilted so the floor drains toward +z; all above sea
    const valley = bake(synthetic(SIZE, R, (x, z) => 20 + 0.5 * Math.abs(x) - 0.05 * z));
    const floor = sampleTerrainChannel(valley, 'moisture', 0, 40);
    const crest = sampleTerrainChannel(valley, 'moisture', 50, 40);
    expect(floor).toBeGreaterThan(crest);
    // an inverted V (a ridge) along z: its crest is the driest line
    const ridge = bake(synthetic(SIZE, R, (x, z) => 50 - 0.5 * Math.abs(x) - 0.05 * z));
    expect(sampleTerrainChannel(ridge, 'moisture', 0, 40)).toBeLessThan(sampleTerrainChannel(ridge, 'moisture', 50, 40));
  });

  it('aspect and slope match the analytic values on a tilted plane', () => {
    // h rises with +x and +z equally: downhill points to (−1, −1), azimuth 225°
    const plane = bake(synthetic(SIZE, R, (x, z) => 30 + 0.2 * x + 0.2 * z));
    const s = sampleTerrainInfo(plane, 5, -7);
    expect(decodeTerrainInfo.aspectRad(s.aspect)).toBeCloseTo((225 * Math.PI) / 180, 4);
    expect(decodeTerrainInfo.slopeTan(s.slope)).toBeCloseTo(Math.hypot(0.2, 0.2), 4);
    // h falls with +x only: downhill is +x, azimuth 0
    const east = bake(synthetic(SIZE, R, (x) => 30 - 0.3 * x));
    expect(decodeTerrainInfo.aspectRad(sampleTerrainInfo(east, 0, 0).aspect)).toBeCloseTo(0, 4);
  });

  it('pathDistance is 0 on a stubbed route and grows outward; +∞ (1) when hm.path is absent', () => {
    const hm = synthetic(SIZE, R, () => 10);
    const cell = (2 * R) / (SIZE - 1);
    // a route along x = 0: distance = |x|
    const distance = new Float32Array(SIZE * SIZE);
    for (let iz = 0; iz < SIZE; iz++) for (let ix = 0; ix < SIZE; ix++) distance[iz * SIZE + ix] = Math.abs(-R + ix * cell);
    const withPath = bake(hm, { path: { distance } });
    expect(withPath.hasPath).toBe(true);
    expect(decodeTerrainInfo.pathDistanceMetres(sampleTerrainChannel(withPath, 'pathDistance', 0, 0))).toBeCloseTo(0, 6);
    expect(decodeTerrainInfo.pathDistanceMetres(sampleTerrainChannel(withPath, 'pathDistance', 8, 0))).toBeCloseTo(8, 6);
    expect(sampleTerrainChannel(withPath, 'pathDistance', 60, 0)).toBe(1); // clamped at 32 m
    // the other branch: no path published → no wear anywhere
    const without = bake(hm, { path: null });
    expect(without.hasPath).toBe(false);
    expect(sampleTerrainChannel(without, 'pathDistance', 0, 0)).toBe(1);
    // and the property the shader relies on: a heightmap carrying `path` is consumed without a stub
    const published = Object.assign(synthetic(SIZE, R, () => 10), { path: { distance } });
    expect(bake(published).hasPath).toBe(true);
    // a malformed publication fails loud (§Rule 8)
    expect(() => bake(hm, { path: { distance: new Float32Array(3) } })).toThrow(/path distance length/);
  });

  it('debris comes from hm.erosion when present, 0 otherwise, metres/4 clamped', () => {
    const hm = synthetic(SIZE, R, () => 10);
    expect(sampleTerrainChannel(bake(hm), 'debris', 0, 0)).toBe(0);
    const debris = new Float32Array(SIZE * SIZE).fill(2);
    expect(decodeTerrainInfo.debrisMetres(sampleTerrainChannel(bake(hm, { debris }), 'debris', 0, 0))).toBeCloseTo(2, 6);
    expect(sampleTerrainChannel(bake(hm, { debris: new Float32Array(SIZE * SIZE).fill(9) }), 'debris', 0, 0)).toBe(1);
  });

  it('sheeting direction follows the principal (tighter) curvature axis on an elliptical dome', () => {
    // a = 20 m along x (tight), b = 40 m along z (loose): ∇κ ∝ (x/a², z/b²)
    // near the crown. 10 m high so the crown's κ = 10·(1/a² + 1/b²) = 0.031/m
    // stays INSIDE the ±0.05 encoding (a saturated byte has no gradient; a
    // real 250 m dome sits near 0.002/m)
    const a2 = 20 * 20;
    const b2 = 40 * 40;
    const ell = bake(synthetic(SIZE, R, (x, z) => 10 * Math.exp(-(x * x) / a2 - (z * z) / b2)));
    const ice = 0.7; // any azimuth: it must not matter where ∇κ is alive
    const onX = sheetingDirectionCpu(ell, 8, 0, ice);
    const onZ = sheetingDirectionCpu(ell, 0, 8, ice);
    const diag = sheetingDirectionCpu(ell, 6, 6, ice);
    expect(Math.abs(onX[0])).toBeGreaterThan(0.98); // along x on the x axis
    expect(Math.abs(onZ[1])).toBeGreaterThan(0.98); // along z on the z axis
    // on the diagonal the axis leans to the TIGHT direction: |x| > |z|, and
    // more than the position vector does (which is at exactly 45°)
    expect(Math.abs(diag[0])).toBeGreaterThan(Math.abs(diag[1]));
    expect(Math.abs(diag[0]) / Math.abs(diag[1])).toBeGreaterThan(1.5);
    // and a flat field falls back to the ice axis instead of a NaN
    const flat = bake(synthetic(SIZE, R, () => 10));
    const fb = sheetingDirectionCpu(flat, 0, 0, ice);
    expect(fb[0]).toBeCloseTo(Math.cos(ice), 6);
    expect(fb[1]).toBeCloseTo(Math.sin(ice), 6);
  });

  it('the sampler clamps at the grid edge and every channel of a sample is finite', () => {
    const info = bake(synthetic(SIZE, R, (x, z) => 20 - 0.1 * Math.hypot(x, z)));
    const s = sampleTerrainInfo(info, 500, -500);
    for (const v of Object.values(s)) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

// ── the material ──────────────────────────────────────────────────────────

/** three's binding-creating call sites, the method of tests/shipBindingBudget.test.ts */
const BINDING_PATTERNS: readonly RegExp[] = [/\btexture\s*\(/g, /\btextureNode\s*\(/g, /\.sample\s*\(/g, /\bshadow\s*\(/g];
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
function countSites(raw: string): number {
  const s = stripComments(raw);
  return BINDING_PATTERNS.reduce((n, p) => n + (s.match(p) ?? []).length, 0);
}

describe('§T.112d sierra material', () => {
  it('binds the info texture + horizon on the shared handle and builds without one (R0 path)', () => {
    const m = createIslandMaterials();
    try {
      const hm = dome();
      const h = m.sierraTerrain(hm);
      expect(h.material.aoNode).not.toBeNull();
      expect(h.material.normalNode).not.toBeNull();
      expect(m.sierraRock(hm).material.aoNode).not.toBeNull();
      // §T.132: the handle is the WORLD's, not this island's — asking without
      // a heightmap returns the same material, because which island a draw
      // belongs to is object state now, not graph state
      expect(m.sierraTerrain()).toBe(h);
      h.updateFromParams();
      expect(h.uniforms.rock.baseColor.value.getHex()).toBe(sierraParams.graniteBaseColor);
    } finally {
      m.dispose();
    }
    const bare = createSierraTerrainMaterial();
    expect(bare.material.aoNode).toBeNull();
    bare.dispose();
    const atlas = createSierraAtlas(1);
    atlas.bind(dome());
    const rock = createSierraRockMaterial(undefined, { atlas });
    expect(rock.material.colorNode).not.toBeNull();
    rock.dispose();
    atlas.dispose();
  });

  it('§V40 ledger: sierra terrain fragment ≤ 9 samplers (the deck family budget)', () => {
    // Measured against three's dedupe-by-texture-UUID rule:
    //   6  the shared blend base: wetline 1, caustics derivatives array 1,
    //      caustics displacement 3, sun shadow depth 1 (the same six the
    //      pirate terrain pays — see tests/shipBindingBudget.test.ts)
    //   2  horizon planes (T112a)
    //   1  terrain-info RGBA8 (T112d)
    //
    // §T.132: all three are now ARRAY textures with one layer per island, so
    // the ledger below is the WHOLE WORLD's, not one island's — it used to be
    // three textures PER sierra island. The info reader's five taps went
    // through one `tap()` helper when the layer index arrived, so the source
    // scan sees one call site where it saw five; the texture count is what the
    // budget is about and it is unchanged.
    const SHARED_BASE = 6;
    expect(countSites(horizonMapSource)).toBe(2);
    expect(countSites(terrainInfoSource)).toBe(1);
    // the material file itself must add no binding of its own
    expect(countSites(sierraMaterialSource)).toBe(0);
    const horizonTextures = 2;
    const infoTextures = 1;
    expect(SHARED_BASE + horizonTextures + infoTextures).toBeLessThanOrEqual(9);
    // and the layout constant agrees there is exactly one info texture
    expect(new Set(Object.values(TerrainInfoChannels.texture)).size).toBe(4);
  });

  it('every T112d tunable is a registered sierra param with a Tweakpane range (§V16)', () => {
    const keys = [
      'polishCurvature', 'polishSlope', 'polishDebrisMax', 'fracturedJoint', 'fracturedSlope',
      'fracturedRoughness', 'grusDebrisMin', 'litterMoisture', 'lichenAspectAzimuth',
      'lichenAspectStrength', 'lichenShadeStrength', 'pathWearWidth', 'pathWearStrength',
      'sheetBandSpacing', 'sheetBandRiser', 'sheetBandStrength', 'sheetBandConvexity', 'sheetBandRelief',
      'layerBlendWidth', 'layerHeightAmp', 'bandLowHeight', 'bandMidHeight', 'bandHighHeight', 'bandWidth', 'bandStrength',
    ] as const;
    for (const k of keys) expect(typeof sierraParams[k], k).toBe('number');
    // the colours too
    for (const k of ['polishedColor', 'fracturedColor', 'pathWornColor', 'bandLowTint', 'bandMidTint', 'bandHighTint', 'bandCrownTint'] as const) {
      expect(typeof sierraParams[k], k).toBe('number');
    }
    // the tuned-by-numbers defaults: polish where κ > +0.02/m and slope < 15°
    expect(sierraParams.polishCurvature).toBeGreaterThan(0);
    expect(sierraParams.polishSlope).toBeLessThan(sierraParams.coverGrusSlope);
    // the implied trail is WIDE and soft: its wear width is several cells of a 256² slice island
    expect(sierraParams.pathWearWidth).toBeGreaterThan((2 * 250) / 255);
  });
});
