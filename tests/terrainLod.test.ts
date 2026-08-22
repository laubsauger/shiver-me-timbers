/**
 * §T.112g TERRAIN LOD WITHOUT POP — CDLOD morph guards.
 *
 * WHY EACH MATTERS. The old LOD swapped a stride-1 grid for a stride-2 grid at
 * one distance. §T.64 already recorded what that costs on the ocean: a step
 * change in tessellation is a step change in the slope distribution, therefore
 * in the normals, therefore in the shading — a seam that swims under motion,
 * which is worse than one you can see in a still. So the property under test
 * is not "there is a morph" (a decision) but "the two levels AGREE where they
 * trade places, and the approach to that agreement is continuous" (§V80). A
 * hard swap fails every assertion in the first block, and one of them is
 * written explicitly to prove that.
 *
 * Everything here is heightmap + geometry arithmetic. No renderer (§V88).
 */
import { describe, expect, it } from 'vitest';
import { generateIslandHeightmap } from '../src/island/heightmap';
import {
  applyTerrainMorph,
  buildIslandGeometry,
  buildTerrainMorph,
  lodCellOf,
  lodGridSize,
  lodSrcIndex,
  strideSurfaceHeight,
  terrainLodPlan,
  terrainMorphBytes,
} from '../src/island/islandMesh';
import { islandParams } from '../src/params/island';

const SEED = 1712;
/** the shipped slice-island grid (sierraParams.sliceGridSize) */
const SLICE_GRID = 256;
const STRIDE = islandParams.lodTerrainStride;

const hmFor = (gridSize: number) =>
  generateIslandHeightmap(SEED, { ...islandParams, gridSize, radius: 250 });

const slice = hmFor(SLICE_GRID);
const cellSize = (2 * slice.worldRadius) / (SLICE_GRID - 1);

const morphedHeights = (
  hm: ReturnType<typeof hmFor>,
  k: number,
): { max: number; mean: number } => {
  const fine = buildIslandGeometry(hm, islandParams.skirtDepth, 1);
  const coarse = buildIslandGeometry(hm, islandParams.skirtDepth, STRIDE);
  const morph = buildTerrainMorph(hm, fine, coarse, 1, STRIDE);
  const pos = fine.getAttribute('position').array as Float32Array;
  const n = lodGridSize(hm.size, 1);
  let max = 0;
  let sum = 0;
  for (let i = 0; i < n * n; i++) {
    const drawn = pos[i * 3 + 1] + morph.position[i * 3 + 1] * k;
    const target = strideSurfaceHeight(hm, STRIDE, pos[i * 3], pos[i * 3 + 2]);
    const d = Math.abs(drawn - target);
    if (d > max) max = d;
    sum += d;
  }
  return { max, mean: sum / (n * n) };
};

describe('§T.112g the decimation index maths', () => {
  it('every source index lands in a cell that brackets it, at a fraction in [0,1]', () => {
    for (const stride of [1, 2, 3, 4, 8]) {
      const n = lodGridSize(SLICE_GRID, stride);
      for (let si = 0; si < SLICE_GRID; si++) {
        const { cell, t } = lodCellOf(si, stride, SLICE_GRID);
        expect(cell).toBeGreaterThanOrEqual(0);
        expect(cell).toBeLessThanOrEqual(n - 2);
        const lo = lodSrcIndex(cell, stride, SLICE_GRID);
        const hi = lodSrcIndex(cell + 1, stride, SLICE_GRID);
        expect(si).toBeGreaterThanOrEqual(lo);
        expect(si).toBeLessThanOrEqual(hi);
        expect(t).toBeGreaterThanOrEqual(0);
        expect(t).toBeLessThanOrEqual(1);
        // the fraction has to reconstruct the source index EXACTLY, or the
        // morph in the short final cell is computed against a cell width the
        // decimation does not have (255 is a multiple of neither 2 nor 4)
        expect(lo + t * (hi - lo)).toBeCloseTo(si, 9);
      }
    }
  });

  it('the last cell is SHORT at every shipped grid size — the case that breaks a naive /stride', () => {
    // if this ever stops being true the clamp is inert and the general form
    // costs nothing; if it is true, a naive fraction is wrong on the last row
    for (const stride of [2, 4]) {
      expect((SLICE_GRID - 1) % stride).not.toBe(0);
      const n = lodGridSize(SLICE_GRID, stride);
      expect(lodSrcIndex(n - 1, stride, SLICE_GRID)).toBe(SLICE_GRID - 1);
      expect(lodSrcIndex(n - 1, stride, SLICE_GRID) - lodSrcIndex(n - 2, stride, SLICE_GRID)).toBeLessThan(
        stride,
      );
    }
  });

  it('stride 1 reproduces the field exactly at grid vertices', () => {
    const hm = hmFor(65);
    const R = hm.worldRadius;
    const c = (2 * R) / (hm.size - 1);
    for (let iz = 0; iz < hm.size; iz += 7) {
      for (let ix = 0; ix < hm.size; ix += 7) {
        expect(strideSurfaceHeight(hm, 1, -R + ix * c, -R + iz * c)).toBeCloseTo(
          hm.data[iz * hm.size + ix],
          6,
        );
      }
    }
  });
});

describe('§T.112g the morph reaches its parent EXACTLY (§V80: the property, not the swap)', () => {
  it('at morph 1 every vertex sits on the coarse triangulated surface', () => {
    const { max } = morphedHeights(slice, 1);
    // float32 positions: the residual is rounding, not a shape difference
    expect(max).toBeLessThan(1e-3);
  });

  it('a HARD SWAP fails the same assertion — the test can detect the defect it exists for', () => {
    const { max, mean } = morphedHeights(slice, 0);
    // this IS the pop: what the surface would have to jump, in one frame, at
    // the swap distance if nothing morphed
    expect(max).toBeGreaterThan(1);
    expect(mean).toBeGreaterThan(0.01);
  });

  it('the morph moves height ONLY — x and z are untouched by construction', () => {
    const fine = buildIslandGeometry(slice, islandParams.skirtDepth, 1);
    const coarse = buildIslandGeometry(slice, islandParams.skirtDepth, STRIDE);
    const m = buildTerrainMorph(slice, fine, coarse, 1, STRIDE);
    let maxLateral = 0;
    for (let i = 0; i < m.position.length / 3; i++) {
      maxLateral = Math.max(maxLateral, Math.abs(m.position[i * 3]), Math.abs(m.position[i * 3 + 2]));
    }
    expect(maxLateral).toBe(0);
  });

  it('the apron and skirt do not morph — they are the same surface at every stride', () => {
    const fine = buildIslandGeometry(slice, islandParams.skirtDepth, 1);
    const coarse = buildIslandGeometry(slice, islandParams.skirtDepth, STRIDE);
    const m = buildTerrainMorph(slice, fine, coarse, 1, STRIDE);
    const interior = lodGridSize(SLICE_GRID, 1) ** 2;
    const total = m.position.length / 3;
    expect(total).toBeGreaterThan(interior); // there IS an apron to check
    for (let i = interior; i < total; i++) {
      expect(m.position[i * 3 + 1]).toBe(0);
    }
  });

  it('shading morphs too: at morph 1 the normals are the coarse mesh\'s, not the fine mesh\'s', () => {
    const fine = buildIslandGeometry(slice, islandParams.skirtDepth, 1);
    const coarse = buildIslandGeometry(slice, islandParams.skirtDepth, STRIDE);
    const m = buildTerrainMorph(slice, fine, coarse, 1, STRIDE);
    const nrm = fine.getAttribute('normal').array as Float32Array;
    const interior = lodGridSize(SLICE_GRID, 1) ** 2;
    let moved = 0;
    let maxLen = 0;
    for (let i = 0; i < interior; i++) {
      const x = nrm[i * 3] + m.normal[i * 3];
      const y = nrm[i * 3 + 1] + m.normal[i * 3 + 1];
      const z = nrm[i * 3 + 2] + m.normal[i * 3 + 2];
      const len = Math.hypot(x, y, z);
      maxLen = Math.max(maxLen, Math.abs(len - 1));
      if (Math.hypot(m.normal[i * 3], m.normal[i * 3 + 1], m.normal[i * 3 + 2]) > 1e-4) moved++;
    }
    // the morphed normal is a UNIT normal — the delta lands on the coarse
    // mesh's own interpolated normal, it is not an arbitrary offset
    expect(maxLen).toBeLessThan(1e-5);
    // and the shading really does change: if this were 0 the "colour change"
    // §T.64 describes would still be there at the swap
    expect(moved / interior).toBeGreaterThan(0.5);
  });
});

describe('§T.112g the approach is continuous', () => {
  const p = islandParams;

  it('the morph ramp is monotone, starts at 0 and reaches exactly 1 at the swap', () => {
    const start = p.lodTerrainDistance - p.lodTerrainMorphBand;
    let prev = -1;
    for (let d = start - 50; d < p.lodTerrainDistance; d += 5) {
      const plan = terrainLodPlan(d, p);
      expect(plan.level).toBe(0);
      expect(plan.morph).toBeGreaterThanOrEqual(prev);
      prev = plan.morph;
    }
    expect(terrainLodPlan(start, p).morph).toBe(0);
    expect(terrainLodPlan(p.lodTerrainDistance - 1e-9, p).morph).toBeCloseTo(1, 6);
    expect(terrainLodPlan(p.lodTerrainDistance, p).level).toBe(1);
  });

  it('the drawn surface is continuous ACROSS the level swap, to under one texel', () => {
    const fine = buildIslandGeometry(slice, islandParams.skirtDepth, 1);
    const coarse = buildIslandGeometry(slice, islandParams.skirtDepth, STRIDE);
    const m = buildTerrainMorph(slice, fine, coarse, 1, STRIDE);
    const pos = fine.getAttribute('position').array as Float32Array;
    const inside = terrainLodPlan(p.lodTerrainDistance - 1e-6, p);
    const outside = terrainLodPlan(p.lodTerrainDistance + 1e-6, p);
    expect(inside.level).toBe(0);
    expect(outside.level).toBe(1);
    const n = lodGridSize(SLICE_GRID, 1);
    let max = 0;
    for (let i = 0; i < n * n; i++) {
      // level 0 at its last morph value…
      const drawnInside = pos[i * 3 + 1] + m.position[i * 3 + 1] * inside.morph;
      // …against what level 1 draws at the same place, one frame later
      const drawnOutside = strideSurfaceHeight(slice, STRIDE, pos[i * 3], pos[i * 3 + 2]);
      max = Math.max(max, Math.abs(drawnInside - drawnOutside));
    }
    // "below a texel" — the heightmap's own cell is the finest thing the field
    // can express, and the swap moves the surface by less than a thousandth of
    // one. The un-morphed number is in the block above: metres.
    expect(max).toBeLessThan(cellSize * 1e-3);
  });

  it('per-frame motion during the morph is BELOW THE PIXEL — the reason a band works at all', () => {
    const fine = buildIslandGeometry(slice, islandParams.skirtDepth, 1);
    const coarse = buildIslandGeometry(slice, islandParams.skirtDepth, STRIDE);
    const m = buildTerrainMorph(slice, fine, coarse, 1, STRIDE);
    // A raft under sail moves ~6 m/s, so one 60 Hz frame crosses 0.1 m of the
    // band and the surface travels that fraction of its whole delta.
    const perFrameMetres = (m.maxHeightDelta * 0.1) / p.lodTerrainMorphBand;
    // The number that decides whether an eye can see it is ANGULAR, not
    // metric: the morph runs between `lodTerrainDistance − band` and
    // `lodTerrainDistance`, so take the near (worst) end.
    const near = p.lodTerrainDistance - p.lodTerrainMorphBand;
    const radPerFrame = perFrameMetres / near;
    // one pixel of a 1440-line viewport at a 50° vertical fov
    const pixel = (2 * Math.tan((50 * Math.PI) / 360)) / 1440;
    expect(radPerFrame / pixel).toBeLessThan(0.05);
    // and the whole travel is a property of the terrain's relief over two
    // cells, not of the LOD: it must stay small against the island itself
    expect(m.maxHeightDelta).toBeLessThan(slice.worldRadius * 0.1);
  });
});

describe('§T.112g determinism and cost', () => {
  it('same heightmap → byte-identical morph (§V2)', () => {
    const a = hmFor(65);
    const b = hmFor(65);
    const ga = buildIslandGeometry(a, islandParams.skirtDepth, 1);
    const gb = buildIslandGeometry(b, islandParams.skirtDepth, 1);
    const ca = buildIslandGeometry(a, islandParams.skirtDepth, STRIDE);
    const cb = buildIslandGeometry(b, islandParams.skirtDepth, STRIDE);
    const ma = buildTerrainMorph(a, ga, ca, 1, STRIDE);
    const mb = buildTerrainMorph(b, gb, cb, 1, STRIDE);
    expect(Array.from(ma.position)).toEqual(Array.from(mb.position));
    expect(Array.from(ma.normal)).toEqual(Array.from(mb.normal));
  });

  it('the morph mounts as a RELATIVE target three r180 will apply on its own', () => {
    const g = buildIslandGeometry(slice, islandParams.skirtDepth, 1);
    const c = buildIslandGeometry(slice, islandParams.skirtDepth, STRIDE);
    applyTerrainMorph(g, buildTerrainMorph(slice, g, c, 1, STRIDE));
    // NodeMaterial.setupPosition mounts `morphReference` on exactly this
    // condition (materials/nodes/NodeMaterial.js:736) — no material edit
    expect(g.morphAttributes.position).toHaveLength(1);
    expect(g.morphAttributes.normal).toHaveLength(1);
    expect(g.morphTargetsRelative).toBe(true);
    expect(g.morphAttributes.position![0].count).toBe(g.getAttribute('position').count);
  });

  it('triangle counts and the morph\'s VRAM are what the budget was justified against (§V17)', () => {
    const fine = buildIslandGeometry(slice, islandParams.skirtDepth, 1);
    const coarse = buildIslandGeometry(slice, islandParams.skirtDepth, STRIDE);
    const triFine = fine.getIndex()!.count / 3;
    const triCoarse = coarse.getIndex()!.count / 3;
    // stride 2 is a quarter of the GRID quads; the apron is the same at both
    // levels only in shape, not in count, so this is not exactly 4×
    expect(triFine / triCoarse).toBeGreaterThan(3.4);
    expect(triFine / triCoarse).toBeLessThan(4.1);
    const verts = fine.getAttribute('position').count;
    const bytes = terrainMorphBytes(verts, 1);
    // one RGBA32F DataArrayTexture per island: keep it under 4 MB or three
    // slice islands alone are more standing VRAM than the seabed texture
    expect(bytes).toBeLessThan(4 * 1024 * 1024);
    // eslint-disable-next-line no-console
    console.log(
      `[T112g terrain] ${SLICE_GRID}² slice: ${verts} verts, ${triFine} tris L0 / ${triCoarse} tris L1, ` +
        `morph VRAM ${(bytes / 1024 / 1024).toFixed(2)} MB, max morph travel ` +
        `${buildTerrainMorph(slice, fine, coarse, 1, STRIDE).maxHeightDelta.toFixed(2)} m`,
    );
  });
});
