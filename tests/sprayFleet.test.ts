/**
 * §T.195 every boat marks the water — the fleet's spray (bow sheet, rooster tail) and prop bubble trail, and the
 * aeration the sim foam lays behind every drive. USER: 'rooster tails etc for all boats'; 'bubble trail from the
 * engine blades / rotors is maybe missing'.
 *
 * WHY these tests: eight boats share ONE particle pool per effect. A pool of `count` particles living `life` seconds
 * turns over at most count/life per second — ask for more and the cursor hands dead slots to whichever emitter it
 * happens to reach, so the rival 300 m away can starve the boat in front of the camera. The budget must be bounded
 * and SPENT NEAREST-FIRST. The bubble trail must come from the drive (thrust, lost power, ventilation, immersion),
 * not appear under a boat idling in neutral.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { BOW_FLEET_SLOTS, createBowSprayFleet, waterlineSheetLaunch } from '../src/foam/bowSpray';
import { BUBBLE_LIFE, BUBBLE_MAX_JETS, createPropBubbles, createRoosterTail, propBubbleRate, roosterTailEmission } from '../src/foam/roosterTail';
import { createWaterlineSpray, prioritiseEmitters, waterlineSprayEmission } from '../src/foam/sprayMath';
import { sprayParams } from '../src/params/spray';
import { flowFoamParams } from '../src/params/flowfoam';
import { MERCURY_450R, ventilationFactor } from '../src/sea-physics/engine';
import { AERATION_SHARE, JET_FOAM_REACH, packPropJet, propWashFoamCpu } from '../src/flowfoam/simFoam';
import { aerationSpeed, propLossPower, ventilationAirSpeed, type PropWashInput } from '../src/wake/propWash';
import { SpeedboatTow } from '../src/wake/speedboatTow';

function recorder() {
  const computes: unknown[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r: any = {
    compute: (n: unknown) => void computes.push(n),
    render: () => {}, setRenderTarget: () => {}, getRenderTarget: () => null, getClearColor: () => {},
    getClearAlpha: () => 0, setClearColor: () => {}, clear: () => {},
  };
  return { r, computes };
}

describe('§T.195 prioritiseEmitters: a fixed budget, spent nearest the camera first', () => {
  it('bounded: never more slots than the shader has, never more particles/s than the pool turns over', () => {
    const rates = Array.from({ length: 20 }, (_, i) => 300 + 10 * i);
    const dists = Array.from({ length: 20 }, (_, i) => (i * 37) % 23);
    const idx: number[] = [];
    const got: number[] = [];
    const n = prioritiseEmitters(rates, dists, 8, 1500, idx, got);
    expect(n).toBeLessThanOrEqual(8);
    expect(got.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1500 + 1e-9);
    for (let k = 0; k < n; k++) expect(got[k]).toBeLessThanOrEqual(rates[idx[k]]);
  });

  it('prioritised: slots in camera-distance order; a far emitter starves before a near one thins', () => {
    const idx: number[] = [];
    const got: number[] = [];
    // three boats asking 400/s each, budget 600: the nearest gets all it asked, the next the rest, the far one nothing
    prioritiseEmitters([400, 400, 400], [300, 20, 90], 8, 600, idx, got);
    expect(idx).toEqual([1, 2]);
    expect(got).toEqual([400, 200]);
    // idle and non-finite emitters take no slot; ties resolve by index (deterministic, §V2)
    prioritiseEmitters([0, Number.NaN, 50, 50], [1, 1, 5, 5], 8, 1e6, idx, got);
    expect(idx).toEqual([2, 3]);
  });
});

describe('§T.195 the bow sheet of a lifting waterline (speedboat contact)', () => {
  it('a planing hull lifts water along its spray root; the sheet fans OUTBOARD, barely forward, apex ≤ v_n²/2g', () => {
    const tow = new SpeedboatTow(40, 1);
    tow.advanceTo(40 * 5);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hw = (tow as any).hw;
    const b = waterlineSprayEmission({ waterline: hw.waterline, sections: hw.sections, stripZ: hw.mesh.strips.zCentre }, tow.pose.quaternion);
    expect(b.inContact).toBe(true);
    expect(b.flux).toBeGreaterThan(0);
    expect(b.launch).toBeGreaterThan(0);
    expect(b.launch).toBeLessThan(40 * 0.25); // the spray root is oblique, not a bluff stem
    const l = waterlineSheetLaunch(40, b.launch);
    expect(l.outboard).toBeGreaterThan(5 * l.forward);
    // a bluff entry at the same normal speed throws forward and nothing outboard
    const bluff = waterlineSheetLaunch(b.launch, b.launch);
    expect(bluff.outboard).toBe(0);
    expect(bluff.forward).toBeCloseTo(2 * b.launch, 12);
    expect(waterlineSheetLaunch(Number.NaN, 1)).toEqual({ forward: 0, outboard: 0, up: 0 });
  });

  it('the fleet pool: 12 boats asking → ≤ BOW_FLEET_SLOTS slots, Σ granted ≤ count/life, nearest boat first', () => {
    const fleet = createBowSprayFleet({ count: 512 });
    const rec = recorder();
    const emitters: { bow: ReturnType<typeof createWaterlineSpray>; speed: number }[] = Array.from({ length: 12 }, (_, i) => {
      const bow = createWaterlineSpray();
      Object.assign(bow, { inContact: true, flux: 3, lift: 0.6, launch: 1.5, x: 10 + 40 * ((i * 7) % 12), y: 0, z: 0, halfWidth: 0.5, fwdX: 1, fwdZ: 0 });
      return { bow, speed: 30 };
    });
    const total = fleet.update(rec.r, emitters, { x: 0, y: 5, z: 0 });
    const life = sprayParams.bowLife * (1 + Math.min(0.9, sprayParams.lifeVariation));
    expect(fleet.granted.index.length).toBeLessThanOrEqual(BOW_FLEET_SLOTS);
    expect(total).toBeLessThanOrEqual(fleet.count / life + 1e-6);
    expect(total).toBeGreaterThan(0);
    const nearest = emitters.map((e, i) => [e.bow.x, i] as const).sort((a, b) => a[0] - b[0])[0][1];
    expect(fleet.granted.index[0]).toBe(nearest);
    // an emitter with a non-finite pose is never granted (§V28)
    emitters[nearest].bow.x = Number.NaN;
    fleet.update(rec.r, emitters, { x: 0, y: 5, z: 0 });
    expect(fleet.granted.index).not.toContain(nearest);
  });
});

describe('§T.195 rooster tails for every boat, one pool', () => {
  const pierce = (x: number): PropWashInput => ({ x, z: 0, dirX: -1, dirZ: 0, thrust: 4000, discArea: 0.118, depth: 0.02, advance: 15, immersion: 0.5, surfaceY: 0, propRps: 50 });

  it('with a viewer: ≤ maxJets slots, the budget bounded by the pool, the nearest props first', () => {
    const rt = createRoosterTail({ maxJets: 24, count: 256 });
    const rec = recorder();
    const jets = Array.from({ length: 40 }, (_, i) => pierce(500 - 12 * i));
    const total = rt.update(rec.r, jets, { x: 0, y: 3, z: 0 });
    const perJet = roosterTailEmission(jets[0], sprayParams).rate;
    expect(perJet).toBeGreaterThan(0);
    // the pool (256) cannot sustain 40 × perJet: the grant is capped, not the sum of the asks
    expect(total).toBeLessThan(40 * perJet);
    expect(total).toBeGreaterThan(0);
  });

  it('without a viewer (the pre-§T.195 call) a lone boat\'s rate is exactly the sum of her props\' emission', () => {
    const rt = createRoosterTail();
    const rec = recorder();
    const jets = [pierce(0), pierce(0.6), pierce(-0.6)];
    const want = jets.reduce((a, j) => a + roosterTailEmission(j, sprayParams).rate, 0);
    expect(rt.update(rec.r, jets)).toBe(want);
  });
});

describe('§T.195 the prop bubble trail: from the drive, zero at idle-off, bounded', () => {
  it('zero in neutral / idle-off; more thrust → more aeration, more bubbles, a whiter ribbon', () => {
    const at = (thr: number): PropWashInput => {
      const tow = new SpeedboatTow(20, thr);
      tow.advanceTo(20 * 5);
      return tow.jets()[0];
    };
    const off = at(0);
    const half = at(0.5);
    const full = at(1);
    expect(off.lossPower).toBe(0);
    expect(aerationSpeed(off)).toBe(0);
    expect(propBubbleRate(off)).toBe(0);
    expect(packPropJet(off)!.meta[2]).toBe(0);
    expect(full.thrust).toBeGreaterThan(half.thrust);
    expect(aerationSpeed(full)).toBeGreaterThan(aerationSpeed(half));
    expect(aerationSpeed(half)).toBeGreaterThan(0);
    expect(propBubbleRate(full)).toBeGreaterThan(propBubbleRate(half));
    // the ribbon 8 m aft of the prop, on its axis
    const aft = (j: PropWashInput) => propWashFoamCpu([j], j.x + 8 * j.dirX, j.z + 8 * j.dirZ, 0.234);
    expect(aft(full)).toBeGreaterThan(aft(half));
    expect(aft(full)).toBeGreaterThan(aft({ ...full, lossPower: 0, ventAirSpeed: 0 }));
  }, 60_000);

  it('the aeration is linear in lost power and grows with ventilation at the same lost power', () => {
    const base: PropWashInput = { x: 0, z: 0, dirX: -1, dirZ: 0, thrust: 5000, discArea: 0.118, depth: 0.4, advance: 20, immersion: 1, lossPower: 50_000 };
    expect(aerationSpeed({ ...base, lossPower: 100_000 })).toBeCloseTo(2 * aerationSpeed(base), 9);
    // a fully buried prop above the ventilation J draws no air; the hole shot's low J and a half-out prop do
    const spec = MERCURY_450R;
    const pd = spec.propPitch / spec.propDiameter;
    const n = 50;
    expect(ventilationAirSpeed(1, ventilationFactor(spec, 1.0), spec.propPitch, n)).toBe(0);
    const holeShot = ventilationAirSpeed(1, ventilationFactor(spec, 0.05 / pd), spec.propPitch, n);
    const halfOut = ventilationAirSpeed(0.5, ventilationFactor(spec, 1.0), spec.propPitch, n);
    expect(holeShot).toBeGreaterThan(0);
    expect(halfOut).toBeGreaterThan(holeShot);
    expect(ventilationAirSpeed(0, ventilationFactor(spec, 0.05 / pd), spec.propPitch, n)).toBe(0);
    expect(aerationSpeed({ ...base, ventAirSpeed: halfOut })).toBeGreaterThan(aerationSpeed(base));
    // lost power: shaft minus thrust power, never negative
    expect(propLossPower(10, 1000, 5000, 3)).toBeCloseTo(2 * Math.PI * 10 * 1000 - 15000, 9);
    expect(propLossPower(1, 1, 1e6, 10)).toBe(0);
    expect(propLossPower(Number.NaN, 1, 1, 1)).toBe(0);
    expect(AERATION_SHARE).toBeGreaterThan(0);
  });

  it('vessel mode fades the fresh bubble source and bounds it at JET_FOAM_REACH', () => {
    const j: PropWashInput = { x: 0, z: 0, dirX: 1, dirZ: 0, thrust: 5000, discArea: 0.118, depth: 0.4, advance: 20, immersion: 1, lossPower: 80_000 };
    expect(propWashFoamCpu([j], 0, 0, 0.234, true)).toBe(propWashFoamCpu([j], 0, 0, 0.234));
    expect(propWashFoamCpu([j], 30, 0, 0.234, true)).toBeLessThan(propWashFoamCpu([j], 30, 0, 0.234) * 0.1);
    expect(propWashFoamCpu([j], JET_FOAM_REACH + 5, 0, 0.234, true)).toBe(0);
    expect(propWashFoamCpu([j], JET_FOAM_REACH + 5, 0, 0.234)).toBeGreaterThan(0);
    expect(flowFoamParams.simChurnRate).toBeGreaterThan(0);
  });

  it('the bubble pool: 40 props asking → ≤ BUBBLE_MAX_JETS slots, Σ ≤ count/life, nearest first; deterministic', () => {
    const jets = Array.from({ length: 40 }, (_, i): PropWashInput => ({
      x: 400 - 9 * i, z: 3, dirX: -1, dirZ: 0, thrust: 6000, discArea: 0.118, depth: 0.4, advance: 25, immersion: 1, surfaceY: 0, lossPower: 120_000,
    }));
    const a = createPropBubbles({ count: 1024 });
    const b = createPropBubbles({ count: 1024 });
    const ra = a.update(recorder().r, jets, { x: 0, y: 2, z: 0 });
    const rb = b.update(recorder().r, jets, { x: 0, y: 2, z: 0 });
    expect(a.granted.index.length).toBeLessThanOrEqual(BUBBLE_MAX_JETS);
    expect(ra).toBeLessThanOrEqual(a.count / BUBBLE_LIFE + 1e-6);
    expect(ra).toBeGreaterThan(0);
    expect(a.granted.index[0]).toBe(39); // x = 49 m, the closest
    expect(rb).toBe(ra);
    expect(b.granted.index).toEqual(a.granted.index);
    expect(b.granted.rate).toEqual(a.granted.rate);
    void THREE;
  });
});
