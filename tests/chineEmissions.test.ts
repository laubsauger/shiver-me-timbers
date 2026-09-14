import { describe, expect, it } from 'vitest';
import { ChineContactHistory } from '../src/wake/chineContact';
import { CHINE_EMISSION_LIFE, CHINE_EMISSION_SLOTS, SHEET_ENTRAINMENT_ONSET, packChineEmission, sheetAirShare } from '../src/wake/chineEmissions';
import { waterlineSheetLaunch } from '../src/foam/bowSpray';
import { createWaterlineSpray } from '../src/foam/sprayMath';
import { retainedChineFoamCpu, packedChineFoamCpu } from '../src/flowfoam/simFoam';

const wet = (x: number, z: number, flux = 0.1) => ({ ...createWaterlineSpray(), inContact: true, flux, launch: 2, halfWidth: 1, x, z });
const dt = 1 / 60;

describe('retained chine emissions', () => {
  it('expires only old packets across skipped ticks, then accepts a new impact after draining', () => {
    const h = new ChineContactHistory();
    h.update(0, 0, wet(0, 0), 0, 20, dt);
    h.resetContact(0);
    const two = h.update(0, 60, wet(0, 20), 0, 20, dt);
    expect(two.emissions).toHaveLength(2);
    const survivor = structuredClone(two.emissions[1]);
    const one = h.update(0, 91, createWaterlineSpray(), 0, 20, dt);
    expect(one.emissions).toEqual([survivor]);
    expect(h.update(0, 200, createWaterlineSpray(), 0, 20, dt).emissions).toHaveLength(0);
    const impact = h.update(0, 201, wet(0, 67), 0, 20, dt);
    expect(impact.emissions).toHaveLength(1);
    expect(impact.emissions[0].volume).toBeCloseTo(0.1 * dt, 12);
    expect(impact.emissions[0].z).toBe(67);
  });

  it('an abrupt turn cannot move, rotate or brighten previously emitted water', () => {
    const h = new ChineContactHistory();
    let e = h.update(0, 0, wet(0, 0), 0, 20, dt);
    for (let t = 1; t <= 20; t++) e = h.update(0, t, wet(0, t / 3), 0, 20, dt);
    const old = structuredClone(e.emissions[0]);
    e = h.update(0, 21, wet(0, 7, 20), 20, 0, dt);
    expect(e.emissions[0]).toEqual(old);
    const q = packChineEmission(old, e.time, 0.01, 0.45)!;
    expect(q.b.slice(0, 2)).toEqual([0, 1]);
    expect(retainedChineFoamCpu([e], 15, 7, 0.1)).toBe(0); // no prebuilt eastward trail
    expect(retainedChineFoamCpu([e], q.a[0] + q.a[2], q.a[1], 0.1)).toBeGreaterThan(0);
  });

  it('does not merge a sub-50 ms reversal into stationary water', () => {
    const h = new ChineContactHistory();
    h.update(0, 0, wet(0, 0), 0, 20, dt);
    const e = h.update(0, 1, wet(0, 0.3), 0, -20, dt);
    expect(e.emissions).toHaveLength(2);
    expect(e.emissions.map(p => p.vz)).toEqual([20, -20]);
    expect(e.emissions.every(p => packChineEmission(p, e.time, 0.01, 0.45) !== null)).toBe(true);
  });

  it('keeps a detached impact spreading after takeoff, then expires its source', () => {
    const h = new ChineContactHistory();
    let e = h.update(0, 0, wet(0, 0, 1), 0, 20, dt);
    const initial = structuredClone(e.emissions[0]);
    for (let t = 1; t <= 30; t++) e = h.update(0, t, createWaterlineSpray(), 20, 0, dt);
    expect(e.emissions).toHaveLength(1);
    const start = packChineEmission(initial, initial.time, 0.01, 0.45)!;
    const later = packChineEmission(initial, e.time, 0.01, 0.45)!;
    expect(later.a[2]).toBeGreaterThan(start.a[2]);
    expect(later.a[3]).toBeLessThan(start.a[3]);
    const end = packChineEmission(initial, initial.time + CHINE_EMISSION_LIFE - 1e-5, 0.01, 0.45)!;
    expect(end.a[3]).toBeLessThan(start.a[3] * 1e-4);
    for (let t = 31; t <= 100; t++) e = h.update(0, t, createWaterlineSpray(), 20, 0, dt);
    expect(e.emissions).toHaveLength(0);
  });

  it('preserves emitted volume while merging substeps and bounds long-running memory', () => {
    const h = new ChineContactHistory();
    let e = h.update(0, 0, wet(0, 0), 0, 20, dt);
    for (let t = 1; t < 30; t++) e = h.update(0, t, wet(0, t / 3), 0, 20, dt);
    expect(e.emissions.reduce((s, p) => s + p.volume, 0)).toBeCloseTo(0.1 * 30 * dt, 12);
    const volume = e.emissions.reduce((s, p) => s + p.volume, 0);
    e = h.update(0, 29, wet(0, 10), 0, 20, dt);
    expect(e.emissions.reduce((s, p) => s + p.volume, 0)).toBe(volume); // repeated worker record
    for (let t = 30; t < 10_000; t++) {
      e = h.update(0, t, wet(0, t / 3), 0, 20, dt);
      expect(e.emissions.length).toBeLessThanOrEqual(CHINE_EMISSION_SLOTS);
      expect(e.emissions.every(p => e.time - p.time < CHINE_EMISSION_LIFE)).toBe(true);
    }
  });

  it('retains rapidly alternating contact bursts without exceeding capacity', () => {
    const h = new ChineContactHistory();
    for (let t = 0; t < 600; t++) {
      if (t % 2 === 0) h.resetContact(0);
      const e = h.update(0, t, t % 2 ? createWaterlineSpray() : wet(t / 3, 0), 20, 0, dt);
      expect(e.emissions.length).toBeLessThanOrEqual(CHINE_EMISSION_SLOTS);
    }
  });

  it('overlaps packets without imprinting the emission cadence as stripes', () => {
    const h = new ChineContactHistory();
    const e = h.update(0, 0, wet(0, 0), 40, 0, dt);
    const packet = e.emissions[0];
    const packets = Array.from({ length: 11 }, (_, i) => packChineEmission({ ...packet, x: (i - 5) * 2 }, packet.time + 0.5, 0.01, 0.45)!);
    const centre = packets[5].a;
    const samples = Array.from({ length: 101 }, (_, i) => packedChineFoamCpu(packets, centre[0] + i * 0.02, centre[1] + centre[2], 0.234));
    expect((Math.max(...samples) - Math.min(...samples)) / Math.max(...samples)).toBeLessThan(0.06);
  });

  it('integrates the complete packet volume over its finite deposition lifetime', () => {
    const h = new ChineContactHistory();
    const e = h.update(0, 0, wet(0, 0, 2), 0, 20, dt);
    const p = e.emissions[0];
    let deposited = 0;
    const step = 0.0005;
    for (let age = step / 2; age < CHINE_EMISSION_LIFE; age += step) {
      deposited += packChineEmission(p, p.time + age, 0.01, 0.45)!.a[3] * 2 * step;
    }
    // W8: the landed water makes whitewater in proportion to the air it folds in, (1 − V_e/V) of its plunge speed
    expect(deposited).toBeCloseTo((sheetAirShare(waterlineSheetLaunch(p.speed, p.launch).up) * p.volume) / 0.01, 5);
  });

  it('W8: a sheet that lands slower than the air-entrainment onset lays no whitewater; a faster one lays its air share', () => {
    // a displacement-speed bow wave barely climbs the hull (v_n ≈ 1 m/s): it lands without folding air in
    const h = new ChineContactHistory();
    const slow = h.update(0, 0, { ...wet(0, 0), launch: 0.9 * SHEET_ENTRAINMENT_ONSET }, 0, 8, dt).emissions[0];
    expect(packChineEmission(slow, slow.time + 0.1, 0.01, 0.45)).toBeNull();
    expect(sheetAirShare(SHEET_ENTRAINMENT_ONSET)).toBe(0);
    expect(sheetAirShare(2 * SHEET_ENTRAINMENT_ONSET)).toBeCloseTo(0.5, 12);
    expect(sheetAirShare(Number.NaN)).toBe(0);
  });
});
