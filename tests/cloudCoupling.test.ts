/**
 * §V.63 STORM COUPLING — the standing measurement, as a test.
 *
 * WHY THIS FILE EXISTS. The headline numbers for `7892e26` (r = 0.750 between
 * rain and storm-cloud overhead on a 20-minute sail track, and 0.0% of raining
 * grid cells with no cloud above them, down from 93.3%) were produced by a
 * throwaway driver and thrown away with it. That has now cost two separate
 * rebuilds from scratch, so the driver lives here. It is a RATCHET, not a
 * print: the thresholds below are deliberately loose enough to survive
 * retuning and tight enough that losing the coupling fails the build.
 *
 * WHAT IS ACTUALLY BEING MEASURED. A cloud is placed on a storm CELL
 * (`generateClusters` + `stormCellsNear`) while rain is gated on the storm
 * FIELD (`stormAt` vs `weatherParams.rainThreshold`). Those are two different
 * samplers over the same lattice, and before §V.63 the clouds were placed on a
 * ring around the world ORIGIN while the rain followed the ship — so they were
 * measurably uncorrelated (r = 0.00) even though both were driven by "the
 * weather". Correlation here is therefore a structural claim: the cloud you
 * sail toward is the squall that rains on you.
 */
import { describe, expect, it } from 'vitest';
import { createWeatherSystem } from '../src/weather';
import { createWeatherSample } from '../src/weather/sampler';
import { generateClusters, type CloudCluster } from '../src/clouds/cloudCores';
import { cloudParams } from '../src/params/clouds';
import { weatherParams } from '../src/params/weather';

/** does any CELL-ANCHORED cluster's footprint cover this world XZ? */
function cloudOverhead(clusters: readonly CloudCluster[], x: number, z: number): number {
  let best = 0;
  for (const c of clusters) {
    if (!c.cell) continue; // ring clusters are fair-weather, not the claim
    const dx = c.x - x;
    const dz = c.z - z;
    if (dx * dx + dz * dz <= c.radius * c.radius) best = Math.max(best, c.storm);
  }
  return best;
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  const den = Math.sqrt(da * db);
  // §V8 fail loud: a constant series has NO correlation, it does not have a
  // correlation of zero. Returning 0 here silently reported "the coupling is
  // gone" for what was really "this track never saw weather".
  if (den < 1e-12) return Number.NaN;
  return num / den;
}

/**
 * Sail a straight track for `minutes`, ticking the real weather system, and at
 * each step sample a grid around the ship. Returns the two headline numbers.
 */
function sailTrack(opts: { minutes: number; knots: number; seed: number }) {
  const weather = createWeatherSystem({ seed: opts.seed });
  const DT = 1 / 30;
  const steps = Math.round((opts.minutes * 60) / DT);
  const speed = opts.knots / 1.944; // m/s
  // sample every 15 s of sailing; a 20-min track is then 80 samples
  const sampleEvery = Math.round(15 / DT);

  const rainSeries: number[] = [];
  const cloudSeries: number[] = [];
  let rainingCells = 0;
  let rainingCellsNoCloud = 0;

  let x = 0;
  const z = 0;
  const pool: Parameters<typeof weather.stormCellsNear>[3] = [];
  // allocation-free sampler discipline: one scratch sample, reused
  const scratch = createWeatherSample();

  for (let s = 0; s < steps; s++) {
    weather.update(DT);
    x += speed * DT;
    if (s % sampleEvery !== 0) continue;

    const cells = weather.stormCellsNear(x, z, cloudParams.stormCellRange, pool);
    const clusters = generateClusters(opts.seed, cloudParams, weather.stormAt, cells);

    // A GRID AROUND THE SHIP, not her own column. The column is degenerate at
    // the default preset — she sails 4.9 km in 20 minutes and simply may not
    // cross a cell, which leaves `rain` constant and the correlation
    // undefined. Pooling the grid over every step is also what the claim
    // actually is: wherever it rains, there is cloud above it.
    const R = 3000;
    const STEP = 500;
    for (let gx = -R; gx <= R; gx += STEP) {
      for (let gz = -R; gz <= R; gz += STEP) {
        const rain = weather.weatherAt(x + gx, z + gz, scratch).rain;
        const cloud = cloudOverhead(clusters, x + gx, z + gz);
        rainSeries.push(rain);
        cloudSeries.push(cloud);
        if (rain <= 0) continue;
        rainingCells++;
        if (cloud <= 0) rainingCellsNoCloud++;
      }
    }
  }

  return {
    r: pearson(rainSeries, cloudSeries),
    rainingCells,
    orphanFraction: rainingCells === 0 ? 0 : rainingCellsNoCloud / rainingCells,
    samples: rainSeries.length,
  };
}

describe('§V.63 storm coupling: the cloud stands on the squall', () => {
  it('rain and storm-cloud overhead are correlated along a sail track', () => {
    const out = sailTrack({ minutes: 20, knots: 8, seed: 1337 });
    // eslint-disable-next-line no-console
    console.log(
      '[§V.63] 20-min track: r=%s, raining cells=%s, orphaned=%s%% (%s samples)',
      out.r.toFixed(3),
      out.rainingCells,
      (out.orphanFraction * 100).toFixed(1),
      out.samples,
    );
    expect(out.samples).toBeGreaterThan(50);
    // the pre-§V.63 value was 0.00 (ring around the origin, rain around the
    // ship). Anything above ~0.5 is a real structural coupling; the shipped
    // measurement was 0.750.
    expect(out.r).toBeGreaterThan(0.5);
  });

  it('rain never falls out of a clear sky', () => {
    const out = sailTrack({ minutes: 20, knots: 8, seed: 1337 });
    // 93.3% before §V.63. This is the one that has to stay near zero: rain
    // with no cloud above it is the defect a player actually sees.
    expect(out.rainingCells).toBeGreaterThan(0);
    expect(out.orphanFraction).toBeLessThan(0.05);
  });

  it('the cloud footprint covers the cell out to where rain actually starts', () => {
    // stormCellRadius must reach the radius fraction at which the field passes
    // rainThreshold, or there is a RING of rain outside the cloud that made it
    // — the failure the 93.3% above was made of.
    expect(cloudParams.stormCellRadius).toBeGreaterThanOrEqual(0.78);
    // and a cell must grow a cloud BEFORE it is allowed to rain
    expect(cloudParams.stormCellMin).toBeLessThan(weatherParams.rainThreshold);
  });
});
