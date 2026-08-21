/**
 * Colour grade (§T.101, §V.89) — CPU mirror, GPU-free (§V.80).
 *
 * WHY THESE. A LUT stage has two classic silent failures and one loud one:
 *  * the half-texel offset is wrong, so the IDENTITY LUT is not identity —
 *    every grey shifts by up to half a texel and dark scenes go milky. Nobody
 *    sees it until a slot is authored and blamed for it. So: identity through
 *    the sampler mirror must be within the 8-bit quantum over a sweep.
 *  * `bake()` does not match the sliders — the CPU LGG and the shader LGG
 *    drift apart and the baked look is not the tuned one. So the CPU mirror
 *    pins the slider maths PROPERTIES (gain doubles, split leaves the pivot
 *    alone) that the shader is written to share.
 *  * the band blend pops or over-binds: weights that do not sum to 1 flash
 *    the frame, a discontinuity pops at an hour, >2 non-zero weights would
 *    need a third texture binding the node does not have.
 * Plus the §V.62 tell: the gate must reach the pipeline source, between the
 * tone map and vibrance, as a bypass — not an identity sample.
 */
import { describe, expect, it } from 'vitest';
import {
  IDENTITY_LGG,
  LUT_SIZE,
  gradeBandWeights,
  gradeCpu,
  identityLut,
  lutFromLgg,
  lutFromStrip,
  lutToRgba8,
  lutToStrip,
  pickTopTwo,
  sampleLutCpu,
  type BandParams,
  type LggParams,
} from '../src/core/gradeLut';
import { gradeParams } from '../src/params/grade';
import { getParamsEntry } from '../src/params/registry';
import pipelineSource from '../src/core/postPipeline.ts?raw';
import gradeSource from '../src/core/grade.ts?raw';

const lgg = (over: Partial<LggParams> = {}): LggParams => ({ ...IDENTITY_LGG, ...over });

/** named hours, not read off a knob (§V.80): the engine's sun sets at 18:00 */
const BANDS: BandParams = {
  dawnCentre: 6, dawnHold: 0.75,
  noonCentre: 12, noonHold: 3,
  duskCentre: 17.8, duskHold: 0.5,
  nightCentre: 23, nightHold: 4,
};

describe('§V.89 identity LUT through the sampler mirror', () => {
  it('returns the input within 1/255 over a 9³ sweep, from the 8-bit texture data', () => {
    const lut = identityLut(LUT_SIZE);
    const rgba = lutToRgba8(lut, LUT_SIZE);
    let worst = 0;
    for (let r = 0; r <= 8; r++)
      for (let g = 0; g <= 8; g++)
        for (let b = 0; b <= 8; b++) {
          const input: [number, number, number] = [r / 8, g / 8, b / 8];
          const out = sampleLutCpu(rgba, LUT_SIZE, input, 4, 1 / 255);
          for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(out[c] - input[c]));
        }
    expect(worst).toBeLessThan(1 / 255);
  });

  it('is exact on the float LUT off-grid too (the half-texel offset is right)', () => {
    const lut = identityLut(LUT_SIZE);
    for (const v of [0.013, 0.2, 0.5, 0.731, 0.999]) {
      const out = sampleLutCpu(lut, LUT_SIZE, [v, 1 - v, v * 0.5]);
      expect(out[0]).toBeCloseTo(v, 6);
      expect(out[1]).toBeCloseTo(1 - v, 6);
      expect(out[2]).toBeCloseTo(v * 0.5, 6);
    }
  });

  it('lutFromLgg at identity params equals identityLut within 1e-6', () => {
    const a = identityLut(LUT_SIZE);
    const b = lutFromLgg(IDENTITY_LGG, LUT_SIZE);
    expect(b.length).toBe(a.length);
    let worst = 0;
    for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
    expect(worst).toBeLessThan(1e-6);
  });

  it('the shipped defaults ARE the identity: the grade changes nothing until tuned', () => {
    for (const k of Object.keys(IDENTITY_LGG) as (keyof LggParams)[]) {
      expect(gradeParams[k]).toBe(IDENTITY_LGG[k]);
    }
    const out = gradeCpu([0.3, 0.6, 0.9], gradeParams);
    expect(out[0]).toBeCloseTo(0.3, 6);
    expect(out[1]).toBeCloseTo(0.6, 6);
    expect(out[2]).toBeCloseTo(0.9, 6);
  });
});

describe('gradeCpu slider maths (the shader mirror)', () => {
  it('gain 2 doubles before the clamp and clamps to [0,1]', () => {
    const p = lgg({ gainR: 2, gainG: 2, gainB: 2 });
    expect(gradeCpu([0.25, 0.25, 0.25], p)[0]).toBeCloseTo(0.5, 6);
    expect(gradeCpu([0.5, 0.5, 0.5], p)[1]).toBeCloseTo(1, 6);
    expect(gradeCpu([0.9, 0.9, 0.9], p)[2]).toBe(1);
    expect(gradeCpu([1, 1, 1], lgg({ gainR: -1 }))[0]).toBe(0);
  });

  it('lift raises black, gain scales white, gamma leaves both ends alone', () => {
    expect(gradeCpu([0, 0, 0], lgg({ liftR: 0.1 }))[0]).toBeCloseTo(0.1, 6);
    expect(gradeCpu([1, 1, 1], lgg({ liftR: 0.1 }))[0]).toBeCloseTo(1, 6);
    const g = lgg({ gammaG: 2.2 });
    expect(gradeCpu([0, 0, 0], g)[1]).toBe(0);
    expect(gradeCpu([1, 1, 1], g)[1]).toBeCloseTo(1, 6);
    expect(gradeCpu([0.5, 0.5, 0.5], g)[1]).toBeGreaterThan(0.5);
  });

  it('saturation 0 is greyscale at the Rec.709 luma; 1 is untouched', () => {
    const out = gradeCpu([1, 0, 0], lgg({ saturation: 0 }));
    expect(out[0]).toBeCloseTo(0.2126, 6);
    expect(out[1]).toBeCloseTo(0.2126, 6);
    expect(out[2]).toBeCloseTo(0.2126, 6);
  });

  it('split tone: shadows go toward shadowTint, highlights toward highlightTint, pivot unchanged', () => {
    // violet shadows / peach highlights, the R0 lookdev ask
    const p = lgg({
      splitStrength: 0.5, splitPivot: 0.5, splitSoftness: 0.25,
      shadowTintR: 0.6, shadowTintG: 0.4, shadowTintB: 0.8,
      highlightTintR: 0.9, highlightTintG: 0.7, highlightTintB: 0.4,
    });
    const sh = gradeCpu([0.1, 0.1, 0.1], p);
    expect(sh[0]).toBeGreaterThan(0.1); // +R
    expect(sh[1]).toBeLessThan(0.1); // −G
    expect(sh[2]).toBeGreaterThan(sh[0]); // B most: violet
    const hi = gradeCpu([0.9, 0.9, 0.9], p);
    expect(hi[0]).toBe(1); // +R, clamped
    expect(hi[1]).toBeGreaterThan(0.9);
    expect(hi[2]).toBeLessThan(0.9); // −B: peach
    const mid = gradeCpu([0.5, 0.5, 0.5], p);
    expect(mid[0]).toBeCloseTo(0.5, 6);
    expect(mid[1]).toBeCloseTo(0.5, 6);
    expect(mid[2]).toBeCloseTo(0.5, 6);
  });

  it('NaN / Infinity in the input or the params still produce finite 0..1 output', () => {
    const bad = lgg({ gammaR: NaN, gainG: Infinity, splitSoftness: 0, shadowTintB: NaN });
    for (const input of [[NaN, 0.5, 0.5], [Infinity, -Infinity, 0.2], [0.3, 0.3, 0.3]] as const) {
      const out = gradeCpu(input, bad);
      for (const v of out) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is deterministic', () => {
    const p = lgg({ liftB: 0.05, gammaR: 1.3, gainG: 1.2, saturation: 1.4, splitStrength: 0.3 });
    const a = lutFromLgg(p, 8);
    const b = lutFromLgg(p, 8);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

describe('strip codec', () => {
  it('lutToStrip → lutFromStrip round-trips a graded LUT to 8 bits', () => {
    const p = lgg({ liftR: 0.03, gammaB: 1.4, gainG: 1.1, splitStrength: 0.4, shadowTintB: 0.8 });
    const lut = lutFromLgg(p, LUT_SIZE);
    const strip = lutToStrip(lut, LUT_SIZE);
    expect(strip.width).toBe(LUT_SIZE * LUT_SIZE);
    expect(strip.height).toBe(LUT_SIZE);
    const back = lutFromStrip(strip);
    expect(back.size).toBe(LUT_SIZE);
    let worst = 0;
    for (let i = 0; i < lut.length; i++) worst = Math.max(worst, Math.abs(back.lut[i] - lut[i]));
    expect(worst).toBeLessThanOrEqual(0.5 / 255 + 1e-9);
  });

  it('puts the R axis along x, G down y, B across slices (documented layout)', () => {
    const strip = lutToStrip(identityLut(4), 4);
    const px = (x: number, y: number): number[] => Array.from(strip.data.slice((x + strip.width * y) * 4, (x + strip.width * y) * 4 + 3));
    expect(px(3, 0)).toEqual([255, 0, 0]);
    expect(px(0, 3)).toEqual([0, 255, 0]);
    expect(px(12, 0)).toEqual([0, 0, 255]);
  });

  it('rejects a strip with the wrong shape rather than reading it misaligned', () => {
    expect(() => lutFromStrip({ width: 64, height: 4, data: new Uint8ClampedArray(64 * 4 * 4) })).toThrow();
  });
});

describe('gradeBandWeights', () => {
  const hours = Array.from({ length: 2401 }, (_, i) => i / 100);

  it('sums to 1 and is non-negative at every hour', () => {
    for (const h of hours) {
      const w = gradeBandWeights(h, BANDS);
      const sum = w[0] + w[1] + w[2] + w[3];
      expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
      for (const v of w) expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it('is continuous: max change per 0.01 h is small, including across midnight', () => {
    let prev = gradeBandWeights(0, BANDS);
    let worst = 0;
    for (const h of hours.slice(1)) {
      const w = gradeBandWeights(h, BANDS);
      for (let i = 0; i < 4; i++) worst = Math.max(worst, Math.abs(w[i] - prev[i]));
      prev = w;
    }
    const wrap = gradeBandWeights(24.005, BANDS);
    const zero = gradeBandWeights(0.005, BANDS);
    for (let i = 0; i < 4; i++) expect(Math.abs(wrap[i] - zero[i])).toBeLessThan(1e-9);
    expect(worst).toBeLessThan(0.05);
  });

  it('each slot peaks at 1 at its own centre, and only then', () => {
    expect(gradeBandWeights(BANDS.dawnCentre, BANDS)).toEqual([1, 0, 0, 0]);
    expect(gradeBandWeights(BANDS.noonCentre, BANDS)).toEqual([0, 1, 0, 0]);
    expect(gradeBandWeights(BANDS.duskCentre, BANDS)).toEqual([0, 0, 1, 0]);
    expect(gradeBandWeights(BANDS.nightCentre, BANDS)).toEqual([0, 0, 0, 1]);
    // dawn weight is maximal at the dawn centre and strictly lower 2 h away
    expect(gradeBandWeights(4, BANDS)[0]).toBeLessThan(1);
    expect(gradeBandWeights(8, BANDS)[0]).toBeLessThan(1);
  });

  it('never has more than two non-zero weights (the node binds two textures)', () => {
    for (const h of hours) {
      const w = gradeBandWeights(h, BANDS);
      expect(w.filter((v) => v > 0).length).toBeLessThanOrEqual(2);
      const { a, b, blend } = pickTopTwo(w);
      expect(w[a]).toBeGreaterThanOrEqual(w[b]);
      expect(blend).toBeGreaterThanOrEqual(0);
      expect(blend).toBeLessThanOrEqual(0.5 + 1e-9);
      if (a === b) expect(blend).toBe(0);
    }
  });

  it('the shipped defaults cover the engine day: dusk before sunset, night after', () => {
    expect(gradeBandWeights(17.8, gradeParams)).toEqual([0, 0, 1, 0]);
    expect(gradeBandWeights(20, gradeParams)[3]).toBe(1);
    expect(gradeBandWeights(12, gradeParams)[1]).toBe(1);
    expect(gradeBandWeights(6, gradeParams)[0]).toBe(1);
  });

  it('survives NaN and unsorted / coincident centres without NaN weights', () => {
    for (const h of [NaN, Infinity, -3, 30]) {
      const w = gradeBandWeights(h, BANDS);
      expect(Math.abs(w[0] + w[1] + w[2] + w[3] - 1)).toBeLessThan(1e-9);
    }
    const odd: BandParams = { ...BANDS, dawnCentre: 12, noonCentre: 12, duskCentre: 12, nightCentre: 12 };
    const w = gradeBandWeights(7, odd);
    expect(w.every(Number.isFinite)).toBe(true);
    expect(Math.abs(w[0] + w[1] + w[2] + w[3] - 1)).toBeLessThan(1e-9);
  });
});

describe('wiring (§V.62: the knob reaches the pipeline)', () => {
  it('registers every grade tunable with a range (§V.16)', () => {
    const entry = getParamsEntry('grade');
    expect(entry).toBeDefined();
    for (const [k, v] of Object.entries(gradeParams)) {
      if (typeof v === 'number') expect(entry!.meta[k], k).toBeDefined();
    }
  });

  it('postPipeline inserts the grade after renderOutput and before vibrance, as a construction bypass', () => {
    const tonemap = pipelineSource.indexOf('renderOutput(vec4(hdr, 1))');
    const grade = pipelineSource.indexOf('createGradeNode(graded)');
    const vib = pipelineSource.indexOf('vibrance(graded, uVibrance)');
    expect(tonemap).toBeGreaterThan(0);
    expect(grade).toBeGreaterThan(tonemap);
    expect(vib).toBeGreaterThan(grade);
    // bypass: the node is constructed only behind the gate…
    expect(pipelineSource).toMatch(/gradeParams\.enabled \? createGradeNode\(graded\) : null/);
    // …the gate is in the drift list, and the node is updated per frame
    expect(pipelineSource).toContain("['grade.enabled', gradeParams.enabled, () => gradeParams.enabled]");
    expect(pipelineSource).toContain('grade?.update()');
  });

  it('the shader mirror uses the same LUT coordinate transform and luma as the CPU', () => {
    expect(gradeSource).toContain('mul((LUT_SIZE - 1) / LUT_SIZE).add(0.5 / LUT_SIZE)');
    expect(gradeSource).toContain('vec3(LUMA[0], LUMA[1], LUMA[2])');
    // two sampled textures, no more (binding budget)
    expect(gradeSource.match(/texture3D\(/g)?.length).toBe(2);
  });
});
