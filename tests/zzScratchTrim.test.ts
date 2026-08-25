import { describe, it, expect } from 'vitest';
import { probeStations, equilibriumDraft } from '../src/sea-physics/buoyancy';
import { seaPhysicsParams } from '../src/params/seaPhysics';

const RUN = process.env.TRIM_PROBE === '1';
describe.skipIf(!RUN)('§scratch bow trim', () => {
  it('reports the waterplane geometry', () => {
    const s = probeStations(seaPhysicsParams.probeSlices);
    let wSum = 0, wz = 0, zMin = Infinity, zMax = -Infinity;
    for (const st of s.stations) { wSum += st.weight; wz += st.weight * st.local[2]; zMin = Math.min(zMin, st.local[2]); zMax = Math.max(zMax, st.local[2]); }
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      nStations: s.stations.length,
      wSum: +wSum.toFixed(6),
      weightedMeanZ: +(wz / wSum).toFixed(6),
      zMin: +zMin.toFixed(3), zMax: +zMax.toFixed(3),
      zSpan: +(zMax - zMin).toFixed(3),
      midpointZ: +(((zMax + zMin) / 2)).toFixed(3),
      draft: +equilibriumDraft().toFixed(4),
      hullLength: seaPhysicsParams.hullLength,
      hullDraft: seaPhysicsParams.hullDraft,
    }, null, 1));
    expect(Math.abs(wz / wSum)).toBeLessThan(1e-9);
  });
});
