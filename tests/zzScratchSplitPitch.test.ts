/**
 * SCRATCH — §V.69 re-measured ON CURVATURE for a SPLIT change.
 * Gated on SPLIT_PITCH=1, skipped otherwise.
 *
 * WHY THIS EXISTS, and why the existing mirror-error phase of
 * `zzScratchCascadeWiden` cannot answer it: `docs/research-cascade-tiling.md`
 * §6 records the method correction. §V.8 was first cleared on mirror HEIGHT
 * error and called free; the hull integrates CURVATURE, and on the same seas
 * halving the mirror cell moved peak pitch angular acceleration a controlled
 * −20% while the height error said "free". So the statistic here is
 * bow-to-stern difference, twice in time, in two forms:
 *
 *   A. SEA-SIDE forcing — 18 stations along the hull axis through the CPU
 *      mirror, least-squares slope over them (that IS the bow-to-stern
 *      difference), second-differenced in time. No ship, no integrator, so
 *      its variance is the sea's alone.
 *   B. SHIP-SIDE — the §V.69 statistic proper: peak pitch angular
 *      acceleration of the real buoyancy integrator over a heading ensemble.
 *
 * A split change is a CONTROLLED perturbation in a way a domain change never
 * was: `generateH0` draws `gaussianPair(rng)` for EVERY texel and only then
 * masks by band, so moving the band edge leaves every mode that keeps its
 * cascade with a bit-identical gaussian, amplitude and phase. Only the
 * octave that changes owner is re-drawn. §V.69's realisation scatter is
 * therefore bounded rather than total, which the sweep below checks directly.
 */
import { describe, expect, it } from 'vitest';
import { oceanParams, type OceanParams } from '../src/params/ocean';
import { seaPhysicsParams, type SeaPhysicsParams } from '../src/params/seaPhysics';
import { CpuOcean } from '../src/sea-physics/cpuOcean';
import { equilibriumDraft, stepShipBuoyancy } from '../src/sea-physics/buoyancy';
import { quatFromAxisAngle, quatMul, rotateVec } from '../src/combat/quatMath';
import type { ShipState } from '../src/state/simState';

const RUN = process.env.SPLIT_PITCH === '1';
const maybe = RUN ? it : it.skip;

const DT = 1 / 60;
/** waterline length the §V.69 block measures this hull at */
const LWL = 35.5;

function clamp1(x: number): number {
  return x < -1 ? -1 : x > 1 ? 1 : x;
}
function pitchOf(ship: ShipState): number {
  return Math.asin(clamp1(rotateVec(ship.quaternion, [0, 0, 1])[1]));
}
function stripPitchLikeSailing(ship: ShipState): void {
  const fwd3 = rotateVec(ship.quaternion, [0, 0, 1]);
  const yaw = Math.atan2(fwd3[0], fwd3[2]);
  const heel = Math.asin(clamp1(rotateVec(ship.quaternion, [1, 0, 0])[1]));
  ship.quaternion = quatMul(
    quatFromAxisAngle([0, 1, 0], yaw),
    quatFromAxisAngle([0, 0, 1], heel),
  );
}
function makeShip(): ShipState {
  return {
    id: 's', kind: 'player', position: [0, 0, 0], quaternion: [0, 0, 0, 1],
    velocity: [0, 0, 0], angularVelocity: [0, 0, 0], rudder: 0, sailTrim: 0,
    flood: 0, damage: {},
  };
}

function withSplit(s: [number, number]): OceanParams {
  return { ...oceanParams, splitWavelengths: s };
}
const SP: SeaPhysicsParams = { ...seaPhysicsParams, mirrorResolution: 64 };

function stats(v: number[]) {
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const rms = Math.sqrt(v.reduce((a, b) => a + b * b, 0) / v.length);
  return { mean, rms, peak: Math.max(...v.map(Math.abs)) };
}

/**
 * A — the sea's own bow-to-stern curvature forcing, no ship in the loop.
 * `pressureHeadAt` is the Smith-attenuated field the hull actually integrates
 * (§V.68); `heightAt` is the geometric surface, reported alongside because the
 * two answer different questions and the split moves a band the attenuation
 * treats very differently (e^(−k·d) at λ 5–8.3 m over a 2 m draft).
 */
function seaForcing(op: OceanParams, seeds: number[], headings: number[]) {
  const STATIONS = 18;
  const TICKS = 1800;
  const WARM = 300;
  // least-squares slope weights over stations at x_j (centred) → Σw·h = dh/dx
  const xs: number[] = [];
  for (let j = 0; j < STATIONS; j++) {
    xs.push(-LWL / 2 + (LWL * j) / (STATIONS - 1));
  }
  const sxx = xs.reduce((a, x) => a + x * x, 0);
  const w = xs.map((x) => x / sxx);

  const headPeak: number[] = [];
  const headRms: number[] = [];
  const geoPeak: number[] = [];
  for (const seed of seeds) {
    const ocean = new CpuOcean(seed, op, SP);
    // one series per (heading, offset) — the offsets are just decorrelated
    // patches of the same sea, which is what an ensemble needs
    const spots = headings.flatMap((yaw) =>
      [0, 137, 311].map((o) => ({ yaw, ox: o * 1.7, oz: o * 2.3 })),
    );
    const seriesHead = spots.map(() => [] as number[]);
    const seriesGeo = spots.map(() => [] as number[]);
    for (let i = 0; i < TICKS; i++) {
      const t = (i + 1) * DT;
      ocean.update(t);
      if (i < WARM) continue;
      for (let s = 0; s < spots.length; s++) {
        const { yaw, ox, oz } = spots[s];
        const cs = Math.cos(yaw);
        const sn = Math.sin(yaw);
        let slopeH = 0;
        let slopeG = 0;
        for (let j = 0; j < STATIONS; j++) {
          const x = ox + xs[j] * sn;
          const z = oz + xs[j] * cs;
          slopeH += w[j] * ocean.pressureHeadAt(x, z, t);
          slopeG += w[j] * ocean.heightAt(x, z, t);
        }
        seriesHead[s].push(Math.atan(slopeH));
        seriesGeo[s].push(Math.atan(slopeG));
      }
    }
    const secondDiff = (v: number[]) => {
      const out: number[] = [];
      for (let i = 2; i < v.length; i++) {
        out.push(((v[i] - 2 * v[i - 1] + v[i - 2]) / (DT * DT)) * (180 / Math.PI));
      }
      return out;
    };
    for (const s of seriesHead) {
      const a = stats(secondDiff(s));
      headPeak.push(a.peak);
      headRms.push(a.rms);
    }
    for (const s of seriesGeo) geoPeak.push(stats(secondDiff(s)).peak);
  }
  return {
    headPeak: Math.max(...headPeak),
    headPeakMean: headPeak.reduce((a, b) => a + b, 0) / headPeak.length,
    headRms: Math.sqrt(headRms.reduce((a, b) => a + b * b, 0) / headRms.length),
    geoPeak: Math.max(...geoPeak),
  };
}

/** B — the §V.69 statistic proper, through the real buoyancy integrator */
function shipKick(op: OceanParams, seeds: number[], headings: number[]) {
  const TICKS = 2400;
  const WARM = 600;
  let worstAcc = 0;
  let worstAngle = 0;
  const accs: number[] = [];
  for (const seed of seeds) {
    const ocean = new CpuOcean(seed, op, SP);
    const ships = headings.map((yaw) => {
      const s = makeShip();
      s.position[1] = equilibriumDraft(SP);
      s.quaternion = quatFromAxisAngle([0, 1, 0], yaw);
      return s;
    });
    const series = headings.map(() => [] as number[]);
    for (let i = 0; i < TICKS; i++) {
      const t = (i + 1) * DT;
      ocean.update(t);
      for (let h = 0; h < ships.length; h++) {
        stripPitchLikeSailing(ships[h]);
        stepShipBuoyancy(ships[h], ocean, DT, SP);
        if (i >= WARM) series[h].push(pitchOf(ships[h]));
      }
    }
    for (const p of series) {
      for (let i = 2; i < p.length; i++) {
        const a = ((p[i] - 2 * p[i - 1] + p[i - 2]) / (DT * DT)) * (180 / Math.PI);
        accs.push(a);
        worstAcc = Math.max(worstAcc, Math.abs(a));
      }
      worstAngle = Math.max(worstAngle, ...p.map((v) => Math.abs((v * 180) / Math.PI)));
    }
  }
  return { worstAcc, rmsAcc: stats(accs).rms, worstAngle };
}

describe('SCRATCH: §V.69 on curvature vs splitWavelengths[1]', () => {
  maybe('sea-side bow-to-stern forcing + ship-side pitch kick', () => {
    /* eslint-disable no-console */
    const splits: Array<[number, number]> = (
      process.env.SP_SPLITS ?? '40:8.3,40:7,40:6,40:5.5,40:5,40:4.5,40:4,33:5'
    ).split(',').map((s) => s.split(':').map(Number) as [number, number]);
    const seeds = (process.env.SP_SEEDS ?? '11,17,23').split(',').map(Number);
    const headings = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
    console.log('\n=== A: SEA-SIDE bow-to-stern curvature forcing (°/s², 35.5 m hull) ===');
    console.log('split        peakHead  meanPeakHead  rmsHead   peakGeom');
    const rowsA: Record<string, ReturnType<typeof seaForcing>> = {};
    for (const s of splits) {
      const r = seaForcing(withSplit(s), seeds, headings);
      rowsA[s.join('/')] = r;
      console.log(
        `${s.join('/').padEnd(12)} ${r.headPeak.toFixed(3).padEnd(9)} ` +
        `${r.headPeakMean.toFixed(3).padEnd(13)} ${r.headRms.toFixed(3).padEnd(9)} ` +
        `${r.geoPeak.toFixed(3)}`,
      );
    }
    console.log('\n=== B: SHIP-SIDE peak pitch angular acceleration (§V.69) ===');
    console.log('split        peakAcc(°/s²)  rmsAcc   peakAngle(°)');
    for (const s of splits) {
      const r = shipKick(withSplit(s), seeds, headings);
      console.log(
        `${s.join('/').padEnd(12)} ${r.worstAcc.toFixed(3).padEnd(14)} ` +
        `${r.rmsAcc.toFixed(3).padEnd(8)} ${r.worstAngle.toFixed(3)}`,
      );
    }
    expect(true).toBe(true);
    /* eslint-enable no-console */
  }, 3600_000);
});
