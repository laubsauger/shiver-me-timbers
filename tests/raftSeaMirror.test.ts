/**
 * §T.173 — THE RAFT FLOATS ON THE SEA SHE IS DRAWN IN, AT HER OWN DRAFT.
 *
 * Two ways the raft's buoyancy read a different sea from the one the GPU
 * draws around her, and each group below is the property that was broken:
 *
 * (a) §V.68 the CPU mirror attenuates every wave by e^(−k·T) at `hullDraft` of
 *     the params it is BUILT with. The raft sea was built with the galleon's
 *     (2.0 m) while her buoyancy stepped on her own (0.3 m) — so a 10 m chop
 *     arrived at 0.28 of its pressure instead of 0.83, and she was calmed by a
 *     keel she does not have. The property: the mirror's params are the SAME
 *     object her buoyancy integrates with (one draft, §V.77; a live tweak of
 *     her draft drives both, §V.62).
 *
 * (b) §V.8/§V.77 `speedScale` (§T.161) reached the wake's GPU uniforms but not
 *     the CPU mirror, so at 2 m/s she was DRAWN in a 0.62 m bow mound and FELT
 *     0.16 m of it (§T.163 W0). The property: a vessel at speed scale s is, on
 *     the path buoyancy reads, exactly the wake authored with both ramp ends
 *     ×s — which is by construction what the GPU uniforms carry. And the scale
 *     reaches every ramp reader through ONE expression, so there is no second
 *     copy to fall out of step.
 */
import { describe, expect, it, vi } from 'vitest';
import { createFlowFoam } from '../src/flowfoam/index';
import { flowFoamParams } from '../src/params/flowfoam';
import { raftSeaParams, seaPhysicsParams } from '../src/params/seaPhysics';
import { raftParams } from '../src/params/raft';
import { raftWakeParams } from '../src/params/raftSailing';
import { SIM_DT } from '../src/core/loop';
import wakeInjectionSource from '../src/flowfoam/wakeInjection.ts?raw';

const seaCalls: Array<{ seaParams: unknown; wakeSpeedScale: number }> = [];
vi.mock('../src/core/seaScene', () => ({
  buildSea: (_app: unknown, _state: unknown, _sky: unknown, _weather: unknown, opts: never) => {
    seaCalls.push(opts);
    return {};
  },
}));

describe('§T.173(a) the raft mirror attenuates at her own draft', () => {
  it('the sea is built with the params her buoyancy steps with, not a galleon\'s', async () => {
    const { buildRaftSea } = await import('../src/raft/raftScene');
    seaCalls.length = 0;
    buildRaftSea({} as never, { seed: 7 } as never, {} as never, {} as never);
    expect(seaCalls).toHaveLength(1);
    const sp = seaCalls[0].seaParams as typeof raftSeaParams;
    // the Smith depth the mirror will use is HER draft — one log radius
    expect(sp.hullDraft * sp.smithDepthScale, 'the raft mirror low-passes the sea by a galleon\'s keel')
      .toBeCloseTo((raftParams.logDiameterMax / 2) * raftSeaParams.smithDepthScale, 9);
    expect(sp.hullDraft).not.toBe(seaPhysicsParams.hullDraft);
    // ONE object, not an equal copy: `raftFrame.tickSea` steps buoyancy on
    // `raftSeaParams`, and a tweak of her draft must move the mirror with it
    expect(sp).toBe(raftSeaParams);
  });
});

/** a raft-sized hull, sailing up to 2 m/s and then turning (lag + curved track) */
const BOW = raftSeaParams.hullBowZ;
const STERN = raftSeaParams.hullSternZ;
const BEAM = raftSeaParams.hullHalfBeam * 2;

function sail(ff: ReturnType<typeof createFlowFoam>, seconds: number): { x: number; z: number; yaw: number } {
  let x = 0;
  let z = 0;
  let yaw = 0;
  let t = 0;
  for (let i = 0; i < Math.round(seconds / SIM_DT); i++) {
    t += SIM_DT;
    const speed = Math.min(2, 0.4 * t);
    if (t > 12) yaw += 0.08 * SIM_DT;
    x += Math.sin(yaw) * speed * SIM_DT;
    z += Math.cos(yaw) * speed * SIM_DT;
    ff.setCenter(x, z);
    ff.setShip([x, z], yaw, speed, BOW, STERN, BEAM);
    ff.advanceWake(SIM_DT);
  }
  return { x, z, yaw };
}

/** probes from ahead of the stem to 30 m astern, across the whole wedge */
function probes(s: { x: number; z: number; yaw: number }): Array<[number, number]> {
  const fx = Math.sin(s.yaw);
  const fz = Math.cos(s.yaw);
  const out: Array<[number, number]> = [];
  for (let aft = -3; aft <= 30; aft += 0.75) {
    for (let across = -10; across <= 10; across += 1.25) {
      const hx = s.x + fx * BOW;
      const hz = s.z + fz * BOW;
      out.push([hx - fx * aft + fz * across, hz - fz * aft - fx * across]);
    }
  }
  return out;
}

describe('§T.173(b) the felt wake of a speed-scaled vessel is the drawn one', () => {
  for (const scale of [raftWakeParams.speedScale, 1]) {
    it(`speedScale ${scale}: the mirror equals the wake authored with its ramp ×${scale}`, () => {
      // what the GPU draws for a scaled vessel: its uniforms carry
      // speedThreshold·s and fullWakeSpeed·s over otherwise identical params
      const drawnP = {
        ...flowFoamParams,
        speedThreshold: flowFoamParams.speedThreshold * scale,
        fullWakeSpeed: flowFoamParams.fullWakeSpeed * scale,
      };
      const drawn = createFlowFoam({ params: drawnP });
      // what buoyancy reads: the shipped params, scaled the way buildSea scales them
      const felt = createFlowFoam();
      felt.setSpeedScale(scale);
      const s = sail(drawn, 25);
      sail(felt, 25);
      let peak = 0;
      let worst = 0;
      for (const [x, z] of probes(s)) {
        for (const depth of [0, raftSeaParams.hullDraft * raftSeaParams.smithDepthScale]) {
          const d = drawn.wakeHeightCpu(x, z, depth);
          worst = Math.max(worst, Math.abs(felt.wakeHeightCpu(x, z, depth) - d));
          peak = Math.max(peak, Math.abs(d));
        }
      }
      expect(peak, 'the field is alive — a residual of 0 between two zeros proves nothing').toBeGreaterThan(0.1);
      expect(worst, 'buoyancy feels a different wake from the one drawn').toBeLessThan(1e-12);
    });
  }

  it('the scale is not a no-op: at her cruising speed the raft wake is the developed one', () => {
    const galleonRamp = createFlowFoam();
    const raft = createFlowFoam();
    raft.setSpeedScale(raftWakeParams.speedScale);
    const s = sail(galleonRamp, 25);
    sail(raft, 25);
    let g = 0;
    let r = 0;
    for (const [x, z] of probes(s)) {
      g = Math.max(g, galleonRamp.wakeHeightCpu(x, z));
      r = Math.max(r, raft.wakeHeightCpu(x, z));
    }
    // W0 measured 0.16 m on the galleon ramp vs 0.62 m drawn at 2 m/s; the
    // ratio, not the metres, is the claim (§V66)
    expect(r / Math.max(g, 1e-9)).toBeGreaterThan(2);
  });

  it('§V77 every ramp reader takes the scale through the one scaled view', () => {
    // a raw read of either ramp end outside the view is a second copy of the
    // decision — exactly how the mirror missed §T.161's scale
    const raw = [...wakeInjectionSource.matchAll(/\bp\.(speedThreshold|fullWakeSpeed)\b/g)];
    const inView = [...wakeInjectionSource.matchAll(/get: \(\) => p\.(speedThreshold|fullWakeSpeed) \* speedScale/g)];
    expect(raw.length).toBe(2);
    expect(inView.length).toBe(2);
    expect([...wakeInjectionSource.matchAll(/\*\s*speedScale\b/g)].length, 'the scale is applied a second time').toBe(2);
    // the slick injector reads the ramp too (its wave-speed floor) and has no
    // scale of its own — handed raw `p` it would draw the raft on a galleon floor
    expect(wakeInjectionSource).not.toMatch(/createSlickInjector\(p\)/);
  });
});
