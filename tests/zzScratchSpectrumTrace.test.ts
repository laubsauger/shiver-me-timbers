/**
 * HEADLESS FRAME-TIME TRACE for the §B.51 amortisation. Not a unit test — a
 * measurement harness. `ddd2d77` traced this defect in Node/V8 for the same
 * reason: the stall is pure main-thread JS with no device interaction, so the
 * browser adds contention and nothing else.
 *
 * BEFORE is not reconstructed from git — it is the EXACT set of calls the old
 * code made, all of which are still exported and unchanged:
 *   GPU     3 × generateSpectrumData(512)                 (OceanCascade.rebuild)
 *   mirror  2 × generateH0(512) + 2 × spectralMeanWavenumber(512)
 *                                + 3 × spectralJacobianRms(512)  (MirrorCascade
 *                                + totalJacobianRms)
 * both on the SAME tick, because both sides ran an identical arm-at-15
 * countdown. So the "before" worst tick is their sum, measured here.
 */
import { describe, it, expect } from 'vitest';
import { oceanParams, type OceanParams } from '../src/params/ocean';
import { seaPhysicsParams } from '../src/params/seaPhysics';
import { weatherPresets } from '../src/weather/presets';
import {
  cascadeBand,
  generateH0,
  generateSpectrumData,
  spectralJacobianRms,
  spectralMeanWavenumber,
} from '../src/ocean/oceanMath';
import { OceanSimulation } from '../src/ocean/oceanCascades';
import { CpuOcean } from '../src/sea-physics/cpuOcean';
import { SPECTRUM_REBUILD_STEPS, REBUILD_ARM_TICKS } from '../src/ocean/spectrumRebuild';

const stubRenderer = { compute: (): void => {} } as never;
const SIM_HZ = 60;

function stats(ticks: number[]): string {
  const worst = Math.max(...ticks);
  const total = ticks.reduce((a, b) => a + b, 0);
  const over8 = ticks.filter((t) => t > 8).length;
  const over16 = ticks.filter((t) => t > 16.7).length;
  return `worst ${worst.toFixed(1)} ms | total ${total.toFixed(0)} ms | ticks>8ms ${over8} | ticks>16.7ms ${over16}`;
}

/** exactly the work the pre-§B.51 rebuild tick did, on both sides */
function legacyRebuildTick(p: OceanParams): number {
  const t0 = performance.now();
  for (let i = 0; i < 3; i++) {
    generateSpectrumData(p.resolution, p.cascades[i].domain, 7 + i * 7919, p, cascadeBand(i, p.splitWavelengths));
  }
  const gpu = performance.now() - t0;
  const t1 = performance.now();
  for (let i = 0; i < 2; i++) {
    const band = cascadeBand(i, p.splitWavelengths);
    spectralMeanWavenumber(p.resolution, p.cascades[i].domain, p, band);
    generateH0(p.resolution, p.cascades[i].domain, 7 + i * 7919, p, band);
  }
  for (let i = 0; i < 3; i++) {
    spectralJacobianRms(p.resolution, p.cascades[i].domain, p, cascadeBand(i, p.splitWavelengths));
  }
  const mirror = performance.now() - t1;
  console.log(`  [before] one rebuild tick: total ${(gpu + mirror).toFixed(1)} ms  [gpu-side ${gpu.toFixed(1)} | cpuOcean mirror ${mirror.toFixed(1)}]`);
  return gpu + mirror;
}

describe('§B.51 frame-time trace (headless)', () => {
  it('A RUNG CLICK — one sea-state change', () => {
    const p: OceanParams = { ...oceanParams, cascades: oceanParams.cascades.map((c) => ({ ...c })) as OceanParams['cascades'] };
    console.log('\n=== A. RUNG CLICK: wind 11 -> 18 ===');

    // ---- BEFORE ----
    const storm: OceanParams = { ...p, windSpeed: 18, amplitude: 1.2 };
    legacyRebuildTick(storm); // warm
    const beforeWorst = legacyRebuildTick(storm);
    console.log(`  [before] settle: 1 tick (${(1000 / SIM_HZ).toFixed(0)} ms) — but the frame it lands on is ${beforeWorst.toFixed(0)} ms long`);

    // ---- AFTER ----
    const sim = new OceanSimulation(7, p);
    const mirror = new CpuOcean(7, p, { ...seaPhysicsParams }, sim.spectrum);
    // settle the harness
    for (let i = 0; i < 5; i++) { sim.advanceSpectrum(p); mirror.update(i * 0.016); sim.update(stubRenderer, i * 0.016, p); }

    const hsBefore = sim.significantWaveHeight();
    p.windSpeed = 18;
    p.amplitude = 1.2;
    const ticks: number[] = [];
    let swapTick = -1;
    for (let i = 0; i < 60; i++) {
      const t0 = performance.now();
      sim.advanceSpectrum(p);
      mirror.update((5 + i) * 0.016);
      const dt = performance.now() - t0;
      ticks.push(dt);
      if (swapTick < 0 && sim.significantWaveHeight() !== hsBefore) swapTick = i;
    }
    console.log(`  [after ] ${stats(ticks)}`);
    console.log(`  [after ] settle: ${swapTick + 1} ticks (${(((swapTick + 1) * 1000) / SIM_HZ / 1000).toFixed(2)} s)`);
    console.log(`  [after ] per-tick during build: ${ticks.slice(0, swapTick + 1).filter((t) => t > 0.5).map((t) => t.toFixed(1)).join(' ')}`);
    expect(swapTick).toBeGreaterThan(0);
  }, 300000);

  it('A FULL PRESET TRANSITION — 4 s lerp', () => {
    console.log('\n=== B. WEATHER PRESET TRANSITION: 4 s lerp, 240 ticks ===');
    const base = weatherPresets.calm?.ocean ?? {};
    const dest = weatherPresets.storm.ocean;
    const p: OceanParams = {
      ...oceanParams, ...base,
      cascades: oceanParams.cascades.map((c) => ({ ...c })) as OceanParams['cascades'],
    };
    const lerpKeys = ['windSpeed', 'amplitude', 'swellAmplitude', 'swellPeriod', 'swellDirectionality'] as const;
    const from: Record<string, number> = {};
    const to: Record<string, number> = {};
    for (const k of lerpKeys) {
      from[k] = (p as unknown as Record<string, number>)[k];
      to[k] = (dest as unknown as Record<string, number>)[k] ?? from[k];
    }
    const TICKS = 240;
    const applyLerp = (i: number): void => {
      const a = Math.min(1, i / TICKS);
      for (const k of lerpKeys) {
        (p as unknown as Record<string, number>)[k] = from[k] + (to[k] - from[k]) * a;
      }
    };

    // ---- AFTER (measured live) ----
    const sim = new OceanSimulation(7, p);
    const mirror = new CpuOcean(7, p, { ...seaPhysicsParams }, sim.spectrum);
    const ticks: number[] = [];
    let rebuilds = 0;
    const swapAt: number[] = [];
    let lastHs = sim.significantWaveHeight();
    for (let i = 0; i < TICKS + SPECTRUM_REBUILD_STEPS + REBUILD_ARM_TICKS; i++) {
      applyLerp(i);
      const t0 = performance.now();
      sim.advanceSpectrum(p);
      mirror.update(i * 0.016);
      sim.update(stubRenderer, i * 0.016, p);
      ticks.push(performance.now() - t0);
      const hs = sim.significantWaveHeight();
      if (hs !== lastHs) { rebuilds++; swapAt.push(i); lastHs = hs; }
    }
    console.log(`  [after ] REBUILDS FIRED: ${rebuilds} at ticks ${swapAt.join(',')}`);
    console.log(`  [after ] ${stats(ticks)}`);
    const ranked = ticks.map((t, i) => [t, i] as const).sort((a, b) => b[0] - a[0]).slice(0, 8);
    console.log(`  [after ] worst 8 ticks (ms@tick, * = swap): ${ranked.map(([t, i]) => `${t.toFixed(1)}@${i}${swapAt.includes(i) ? '*' : ''}`).join(' ')}`);
    const sorted = [...ticks].sort((a, b) => a - b);
    console.log(`  [after ] p50 ${sorted[Math.floor(sorted.length * 0.5)].toFixed(1)} | p95 ${sorted[Math.floor(sorted.length * 0.95)].toFixed(1)} | p99 ${sorted[Math.floor(sorted.length * 0.99)].toFixed(1)} ms`);

    // ---- BEFORE (the same transition's rebuild count x the same-tick cost) ----
    // the old cadence was 16 ticks and the signature moved every tick, so a
    // 240-tick lerp fired 240/16 = 15-16 rebuilds, each a single tick
    const legacyRebuilds = Math.floor(TICKS / 16);
    const one = legacyRebuildTick(p);
    console.log(`  [before] REBUILDS FIRED: ${legacyRebuilds} (cadence 16 ticks, signature moves every tick)`);
    console.log(`  [before] TOTAL MAIN-THREAD STALL: ${(legacyRebuilds * one).toFixed(0)} ms | worst tick ${one.toFixed(0)} ms | ticks>16.7ms ${legacyRebuilds}`);
    expect(rebuilds).toBeGreaterThan(0);
  }, 300000);
});
