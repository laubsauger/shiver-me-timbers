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
