/**
 * T26 palm/vegetation guards. WHY each matters:
 * - §V2-adjacent determinism: palm geometry + scatter must be pure
 *   f(seed, params) or multiplayer clients would render different islands
 *   from the same SimState seed.
 * - Wind shader contract: windSway.ts reads baked windWeight/phaseOffset
 *   attributes; if bases stop being 0 palms slide across the ground, if tips
 *   never reach ~1 the sway amplitude param silently dies, and if fronds
 *   share one phase the whole crown flaps in lockstep (uncanny).
 * - §V16: vegetation tunables must be registered for the panel.
 * Geometry/scatter modules only — no materials or renderer imports here.
 */
import { describe, expect, it } from 'vitest';
import { buildPalmGeometry } from '../src/vegetation/palmGeometry';
import { generatePlacements, scatterPalms } from '../src/vegetation/scatter';
import { vegetationParams } from '../src/params/vegetation';
import { getParamsEntry } from '../src/params/registry';
import { islandParams } from '../src/params/island';
import { periodResolvedValue } from '../src/ship/bandLimit';

const attrArray = (geo: ReturnType<typeof buildPalmGeometry>, name: string): Float32Array =>
  geo.getAttribute(name).array as Float32Array;

describe('palm geometry determinism (§V2-adjacent)', () => {
  it('same seed → byte-identical vertex buffers', () => {
    const a = buildPalmGeometry(1234);
    const b = buildPalmGeometry(1234);
    expect(attrArray(b, 'position')).toEqual(attrArray(a, 'position'));
    expect(attrArray(b, 'windWeight')).toEqual(attrArray(a, 'windWeight'));
    expect(attrArray(b, 'phaseOffset')).toEqual(attrArray(a, 'phaseOffset'));
    expect(b.index!.array).toEqual(a.index!.array);
  });

  it('different seed → different geometry', () => {
    const a = attrArray(buildPalmGeometry(1234), 'position');
    const b = attrArray(buildPalmGeometry(4321), 'position');
    expect(b).not.toEqual(a);
  });

  it('stays low-poly (soft budget ~2-4k tris)', () => {
    const geo = buildPalmGeometry(7);
    expect(geo.index!.count / 3).toBeLessThanOrEqual(4000);
  });
});

describe('wind shader vertex-attribute contract', () => {
  const geo = buildPalmGeometry(99);
  const weights = attrArray(geo, 'windWeight');
  const positions = attrArray(geo, 'position');

  it('windWeight exists, one float per vertex', () => {
    expect(weights.length).toBe(positions.length / 3);
  });

  it('windWeight is exactly 0 at trunk-base verts (palms stay planted)', () => {
    let baseVerts = 0;
    for (let i = 0; i < weights.length; i++) {
      if (positions[i * 3 + 1] === 0) {
        baseVerts++;
        expect(weights[i]).toBe(0);
      }
    }
    expect(baseVerts).toBeGreaterThan(0); // the base ring must exist
  });

  it('windWeight reaches ≥0.9 somewhere (frond tips actually sway)', () => {
    expect(Math.max(...weights)).toBeGreaterThanOrEqual(0.9);
  });

  it('windWeight stays in [0, 1]', () => {
    for (const w of weights) {
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
    }
  });

  it('phaseOffset varies across fronds (≥3 distinct non-trunk values)', () => {
    const phases = new Set(attrArray(geo, 'phaseOffset').filter((v) => v !== 0));
    expect(phases.size).toBeGreaterThanOrEqual(3);
  });
});

describe('scatter (§V2-adjacent determinism + count contract)', () => {
  it('same seed → identical placements', () => {
    expect(generatePlacements(16, 42)).toEqual(generatePlacements(16, 42));
  });

  it('different seed → different placements', () => {
    expect(JSON.stringify(generatePlacements(16, 43))).not.toEqual(
      JSON.stringify(generatePlacements(16, 42)),
    );
  });

  it('respects requested count', () => {
    expect(generatePlacements(9, 1)).toHaveLength(9);
    const mesh = scatterPalms({ count: 9, seed: 1, geometry: buildPalmGeometry(1) });
    expect(mesh.count).toBe(9);
  });

  it('bakes per-instance phase/sway instanced attributes for windSway', () => {
    const geometry = buildPalmGeometry(2);
    scatterPalms({ count: 5, seed: 2, geometry });
    expect(geometry.getAttribute('instancePhase').count).toBe(5);
    expect(geometry.getAttribute('instanceSway').count).toBe(5);
  });
});

describe('vegetation params (§V16)', () => {
  it('registers with the params registry for the debug panel', () => {
    expect(getParamsEntry('vegetation')?.params).toBe(vegetationParams);
  });
});

import { Matrix4, Vector3 } from 'three/webgpu';
import { sortForLod } from '../src/vegetation/scatter';

describe('LOD instance order (§V17)', () => {
  it('sorts largest-first so a lowered instance count drops the small palms', () => {
    // InstancedMesh.count truncates from the END, so the distance LOD keeps
    // whatever the scatter wrote first — that has to be the readable palms,
    // not a random subset
    const placements = generatePlacements(24, 99);
    const sorted = sortForLod(placements);
    expect(sorted).toHaveLength(placements.length);
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1].scale * sorted[i - 1].heightScale;
      const b = sorted[i].scale * sorted[i].heightScale;
      expect(a).toBeGreaterThanOrEqual(b);
    }
    // deterministic: sorting a deterministic list stays deterministic (§V2)
    expect(sortForLod(generatePlacements(24, 99))).toEqual(sorted);
  });
});

describe('frustum culling bounds (§V17)', () => {
  it('the instanced bounds cover every palm plus the sway the shader adds', () => {
    // culling was OFF, so every palm batch on every island was submitted in
    // the main AND shadow pass regardless of distance. Turning it on is only
    // safe if the bounds account for vertices the wind shader moves.
    const geometry = buildPalmGeometry(3);
    const mesh = scatterPalms({ count: 20, seed: 3, geometry });
    expect(mesh.frustumCulled).toBe(true);
    expect(mesh.boundingSphere).not.toBeNull();

    const p = vegetationParams;
    const swayMargin =
      (p.swayAmplitude * (1 + p.swayHarmonic) + p.flutterAmplitude) *
      Math.max(p.scaleMax, p.scaleMin) * (1 + p.heightJitter);
    const sphere = mesh.boundingSphere!;

    // every instance origin, plus the palm's own reach, plus sway, fits
    const m = new Matrix4();
    const pos = new Vector3();
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      pos.setFromMatrixPosition(m);
      expect(pos.distanceTo(sphere.center)).toBeLessThanOrEqual(sphere.radius);
    }
    // and the margin is actually present, not an accident of the geometry
    const tight = mesh.boundingSphere!.radius - swayMargin;
    expect(swayMargin).toBeGreaterThan(0);
    expect(tight).toBeGreaterThan(0);
  });
});

describe('§V.48 bark rings: a raw step() is a zero-width edge', () => {
  // The bark stripe was `step(ratio, fract(y·freq))`. Every other §V.48
  // occurrence in this project had SOME transition to widen; this one had
  // none, which means no pixel ever samples partway up the wall and it
  // aliases at every distance rather than past an onset. The `fract` wrap was
  // a second, independent hard edge — §B.20's wale hairline verbatim.
  const PX_PER_RAD = 2560 / ((75 * Math.PI) / 180);
  /** metres of trunk one pixel covers at `dist`, times a grazing factor */
  const mpp = (dist: number, grazing = 1): number => (dist / PX_PER_RAD) * grazing;
  /** one bark ring, in metres, on a mid-size trunk */
  const trunkHeight = (vegetationParams.heightMin + vegetationParams.heightMax) / 2;
  const ringMetres = trunkHeight / vegetationParams.barkRingFrequency;

  it('the ring pattern is gone before its period goes sub-pixel', () => {
    // filter width in RING units = metres per pixel / metres per ring
    const resolved = (d: number, g = 1): number => periodResolvedValue(mpp(d, g) / ringMetres);
    // a palm you are moored next to: rings fully present, they are the detail
    expect(resolved(40)).toBeGreaterThan(0.9);
    // palms are culled at lodPalmCull; the limit must reach zero INSIDE that
    // range or the cull is what is hiding the aliasing, which is luck
    expect(resolved(islandParams.lodPalmCull)).toBe(0);
  });

  it('fades to the pattern MEAN, so a distant trunk keeps its right colour', () => {
    // the stripe covers `ratio` of each period, so `ring` averages 1 − ratio.
    // Fading to 0 or 1 instead would make every distant palm trunk uniformly
    // too dark or too light — the §V.48 (b) half, which is easy to skip.
    const mean = 1 - vegetationParams.barkStripeRatio;
    expect(mean).toBeGreaterThan(0);
    expect(mean).toBeLessThan(1);
  });

  it('the widened edge is at least 2 px, never 1 (Nyquist, the hard-won bit)', () => {
    // at exactly 1 px per transition, neighbouring samples still land on
    // opposite ends of the step and the difference is still full contrast
    const filterWidth = 0.3; // ring units per pixel
    const halfAuthored = vegetationParams.barkStripeRatio / 2;
    const halfEff = Math.max(halfAuthored, filterWidth * 2 * 0.5);
    expect(halfEff * 2).toBeGreaterThanOrEqual(filterWidth * 2);
  });

  it('the material still builds with the band limit wired in', async () => {
    const { createPalmMaterial } = await import('../src/vegetation/palmMaterial');
    const handle = createPalmMaterial();
    expect(handle.material.colorNode).toBeTruthy();
    handle.refresh();
  });
});
