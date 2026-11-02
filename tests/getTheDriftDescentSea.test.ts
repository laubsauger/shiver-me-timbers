/**
 * The descent's sea (src/drift/getTheDrift/descentSea.ts): the water under the eye from ~30 km down to the hand-over
 * into the sea's scene at 150 m. The 2026-11-02 review: "the wave pattern is perfectly regular and tiled, and that's
 * causing more ray effects … it looks a bit shitty and cheap" — seven long-crested ripple trains, band-limited past
 * Nyquist. What these hold:
 *   - it is THE SEA'S SEA: the same sea state as the sea's scene (wandering/sea.ts), and the same mean square slope as
 *     the FFT cascades that scene draws — so the glint the descent comes down through is the glint the hand-over cuts
 *     to, not a second look that changes in the 3 s crossfade;
 *   - it does not repeat: no comb of a few parallel trains, the short chop fanned out as the sea's spread fans it;
 *   - it is band-limited before Nyquist, with margin for the glint's non-linearity.
 */
import { describe, expect, it } from 'vitest';
import { CALM_SLOPE_VAR, DESCENT_BAND, SEA_STATE, descentSpectrum, seaSpectrumParams } from '../src/drift/getTheDrift/descentSea';
import { cascadeBand, slopeVarianceTotal, slopeWavelengthHistogram } from '../src/ocean/oceanMath';

const SEA_SRC = Object.values(
  import.meta.glob('../src/drift/wandering/sea.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>,
)[0];

const num = (re: RegExp): number => {
  const m = re.exec(SEA_SRC);
  if (!m) throw new Error(`sea.ts no longer has ${re}: the descent's SEA_STATE restates it — follow it there`);
  const v = m[1].trim();
  return v === 'Math.PI' ? Math.PI : Number(v);
};

describe("the descent's sea is the sea scene's sea", () => {
  it('restates the sea state sea.ts builds its spectrum from (or the hand-over shows a seam)', () => {
    const ripple = /const RIPPLE = \{ amplitude: ([\d.]+), windSpeed: ([\d.]+), choppiness: ([\d.]+) \}/.exec(SEA_SRC);
    expect(ripple, 'sea.ts RIPPLE').not.toBeNull();
    expect([Number(ripple![1]), Number(ripple![2]), Number(ripple![3])]).toEqual([SEA_STATE.ripple.amplitude, SEA_STATE.ripple.windSpeed, SEA_STATE.ripple.choppiness]);
    expect(num(/const SWELL_RMS = ([\d.]+);/)).toBe(SEA_STATE.swellRms);
    expect(num(/const SWELL_PERIOD = ([\d.]+);/)).toBe(SEA_STATE.swellPeriod);
    expect(num(/const WIND_TO = ([^;]+);/)).toBeCloseTo(SEA_STATE.windTo, 12);
    // ... over the game's glass preset, which seaSpectrumParams lays under it the same way
    expect(SEA_SRC).toMatch(/Object\.assign\(oceanParams, weatherPresets\.glass\.ocean, RIPPLE, \{ swellAmplitude: SWELL_RMS, swellPeriod: SWELL_PERIOD, windDirection: WIND_TO \}\)/);
  });

  it("carries the FFT cascades' mean square slope, so its glint is as wide as the sea's", () => {
    const p = seaSpectrumParams();
    const sea = p.cascades.reduce(
      (s, c, i) => s + slopeVarianceTotal(slopeWavelengthHistogram(p.resolution, c.domain, p, cascadeBand(i, p.splitWavelengths))),
      0,
    );
    const d = descentSpectrum(p);
    // (the cascades' grids end at ~9 cm, where the small-wave cutoff has taken nearly all; the descent integrates on)
    expect(d.total).toBeGreaterThan(sea * 0.9);
    expect(d.total).toBeLessThan(sea * 1.15);
  });

  it('loses no slope variance: what is drawn plus what is roughness is the whole spectrum', () => {
    const d = descentSpectrum();
    const drawn = d.waves.reduce((s, w) => s + (w.slope * w.slope) / 2, 0);
    expect(drawn + d.rest).toBeCloseTo(d.total, 6);
    // and from orbit, with every wave under a pixel, the glint's α² is the orbit's ~0.15² it hands over from
    // (earth.ts: α 0.07–0.22 by wind patch)
    expect(Math.sqrt(d.total + CALM_SLOPE_VAR)).toBeGreaterThan(0.1);
    expect(Math.sqrt(d.total + CALM_SLOPE_VAR)).toBeLessThan(0.2);
  });
});

describe("the descent's sea does not tile", () => {
  const d = descentSpectrum();
  const dir = (w: { kx: number; kz: number }) => Math.atan2(w.kz, w.kx);

  it('draws enough waves at enough scales that no few trains make a comb', () => {
    // the seven trains it replaced were one per scale; a field reads as a sea, not a pattern, with several per octave
    expect(d.waves.length).toBeGreaterThanOrEqual(20);
    const lambdas = d.waves.map((w) => (2 * Math.PI) / Math.hypot(w.kx, w.kz));
    expect(Math.log2(Math.max(...lambdas) / Math.min(...lambdas))).toBeGreaterThan(5);
  });

  it('never repeats: no two waves share a direction, nor a wavevector a small whole ratio of another along it', () => {
    for (let i = 0; i < d.waves.length; i++) {
      for (let j = i + 1; j < d.waves.length; j++) {
        const a = d.waves[i];
        const b = d.waves[j];
        let dth = Math.abs(dir(a) - dir(b)) % (2 * Math.PI);
        dth = Math.min(dth, 2 * Math.PI - dth);
        // parallel waves at a whole ratio of wavenumbers are one periodic train; any two at distinct directions
        // with incommensurate k never meet the same phase again
        expect(dth, `waves ${i} and ${j} run the same way`).toBeGreaterThan((1 * Math.PI) / 180);
      }
    }
  });

  it('fans the short chop out as the sea does (the old trains kept to fixed headings 1–14 m)', () => {
    const chop = d.waves.filter((w) => (2 * Math.PI) / Math.hypot(w.kx, w.kz) < 3);
    const [wx, wz] = d.wind;
    // axial spread: the RMS angle off the wind's axis
    const off = chop.map((w) => Math.acos(Math.abs((w.kx * wx + w.kz * wz) / Math.hypot(w.kx, w.kz))));
    const rms = Math.sqrt(off.reduce((s, a) => s + a * a, 0) / off.length);
    expect((rms * 180) / Math.PI).toBeGreaterThan(25);
  });

  it('is the same sea on every machine and every lane (a fixed seed: every frame a pure function of t)', () => {
    expect(descentSpectrum()).toEqual(d);
  });
});

describe("the descent's sea is band-limited", () => {
  it('fades every wave out before Nyquist, with room for the glint to make harmonics', () => {
    // (cycles a pixel: Nyquist is 0.5; the GGX lobe is sharply non-linear in the slope, so a wave needs to be gone by
    // 4 px a wavelength — the shoreline's OCT_BAND, measured on the same fault)
    expect(DESCENT_BAND[0]).toBeLessThan(DESCENT_BAND[1]);
    expect(DESCENT_BAND[1]).toBeLessThanOrEqual(0.25);
  });
});
