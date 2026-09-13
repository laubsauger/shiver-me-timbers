/**
 * §T.171 W5 — THE BOW PILE-UP FROM HULL CONTACT (docs/wake/w5-foam.md §2).
 * WHY each block exists:
 *
 *  1. EMISSION IS THE WATER THE HULL SHOVES UP. A bluff galleon or raft bow
 *     makes no steady linear bow crest at these Froude numbers (Noblesse 2008,
 *     w2a §6), so the "heaving water out" read must come from contact: rate ∝
 *     relative normal velocity × immersion, capped by what the stagnation head
 *     v²/2g can lift. If either factor stops mattering, the sheet is back to
 *     being a speed ramp someone tunes per vessel.
 *  2. NO SPEED SCALE. The raft's `speedScale` existed only because the old ramp
 *     was authored for a galleon (§T.161). The contact model must give her a
 *     real sheet at her own cruising speed and nothing adrift, with no per-vessel
 *     number, and the raft page must stop feeding the scale to spray.
 *  3. §V28: a non-finite contact or velocity throws nothing.
 *  4. §T.59: ship-attached sheets are not faded by the crest-mist camera fade
 *     at follow-cam range — and the pool actually uses the override (§V62),
 *     without a shader change (the pirate page's bow WGSL is unchanged).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import raftFrameSource from '../src/raft/raftFrame.ts?raw';
import { GRAVITY } from '../src/ocean/oceanMath';
import { sprayParams } from '../src/params/spray';
import { raftSeaParams } from '../src/params/seaPhysics';
import { bowContactEmission, distanceFade, liftFraction, type BowContactInput } from '../src/foam/sprayMath';
import { createHullContact, waterlineFromBox, type HullWaterline } from '../src/sea-physics/hullContact';
import { createBowSpray } from '../src/foam/bowSpray';

/** a hull at rest on its marks with the sea `rise` above the waterline plane everywhere */
function contact(hull: HullWaterline, draft: number, rise: number): BowContactInput {
  const hc = createHullContact(hull);
  hc.update({ position: [0, 0, 0], quaternion: [0, 0, 0, 1] } as never, { currentTime: 0, heightAt: () => rise } as never, 0);
  return { inContact: hc.inContact, sliceZ: hc.sliceZ, sliceHalfWidth: hc.sliceHalfWidth, depth: hc.depth, draft };
}

/** a wall-sided box plan: the stem face is the only face that meets the water head-on */
const BOX: HullWaterline = { bowZ: 6, sternZ: -6, halfWidthAt: () => 2 };
const RAFT = waterlineFromBox(raftSeaParams.hullBowZ, raftSeaParams.hullSternZ, raftSeaParams.hullHalfBeam);
const flux = (c: BowContactInput, ux: number, uz: number): number => bowContactEmission(c, ux, uz, 0, 0.05, sprayParams).flux;

describe('1. emission scales with relative normal velocity × immersion (Bernoulli-capped)', () => {
  it('box bow, head-on, unlifted regime (d ≤ U²/2g): flux = U·d·beam — doubling EITHER doubles it', () => {
    const d = 0.2;
    const c = contact(BOX, d - 0.01, 0.01); // immersion = draft + rise = d
    for (const U of [3, 6]) {
      expect(U * U / (2 * GRAVITY)).toBeGreaterThanOrEqual(d);
      expect(flux(c, 0, U)).toBeCloseTo(U * d * 4, 9);
    }
    expect(flux(c, 0, 6) / flux(c, 0, 3)).toBeCloseTo(2, 9);
    const deeper = contact(BOX, 2 * d - 0.01, 0.01);
    expect(flux(deeper, 0, 6) / flux(c, 0, 6)).toBeCloseTo(2, 9);
    // and the particle rate follows the flux (no hidden speed term)
    const r = (cc: BowContactInput, U: number): number => bowContactEmission(cc, 0, U, 0, 0.05, sprayParams).rate;
    expect(r(c, 6) / r(c, 3)).toBeCloseTo(2, 9);
  });

  it('a slow hull cannot lift a deep column: past d = U²/2g the flux stops growing with immersion', () => {
    const U = 1;
    const head = (U * U) / (2 * GRAVITY); // 5 cm
    const shallow = contact(BOX, 2 * head - 0.01, 0.01);
    const deep = contact(BOX, 10 * head - 0.01, 0.01);
    expect(flux(deep, 0, U)).toBeCloseTo(flux(shallow, 0, U), 9);
    expect(flux(deep, 0, U)).toBeCloseTo(U * head * 4, 9);
    expect(liftFraction(U, 10 * head)).toBeCloseTo(0.1, 9);
  });

  it('only faces moving INTO the water throw: at rest nothing, going astern the stem throws nothing, crabbing the weather side does', () => {
    const c = contact(BOX, 0.3, 0.01);
    expect(bowContactEmission(c, 0, 0, 0, 0.05, sprayParams).rate).toBe(0);
    expect(flux(c, 0, -3)).toBe(0);
    // pure leeway: one flank pushes (the box's 12 m side), the stem does not
    expect(flux(c, 1.5, 0)).toBeGreaterThan(0);
    expect(flux(c, 1.5, 0)).toBeCloseTo(flux(c, -1.5, 0), 9);
  });

  it('airborne → nothing; a slam still throws with the hull stopped (the audio-shared slam, unchanged)', () => {
    const dry = contact(RAFT, raftSeaParams.hullDraft, -1);
    expect(dry.inContact).toBe(false);
    expect(bowContactEmission(dry, 0, 3, 0, 0, sprayParams).rate).toBe(0);
    const wet = contact(RAFT, raftSeaParams.hullDraft, 0.05);
    const slam = bowContactEmission(wet, 0, 0, sprayParams.bowSlamRateFull, 1, sprayParams);
    expect(slam.flux).toBe(0);
    expect(slam.slam).toBe(1);
    expect(slam.rate).toBeCloseTo(sprayParams.bowSlamRate, 9);
  });
});

describe('2. the raft gets a sheet from her own contact — no speedScale', () => {
  const c = contact(RAFT, raftSeaParams.hullDraft, 0.01);
  const rate = (U: number): number => bowContactEmission(c, 0, U, 0, 0.05, sprayParams).rate;

  it('a visible sheet at her cruising 2 m/s, almost nothing adrift, monotone across her polar', () => {
    expect(rate(2)).toBeGreaterThan(100);
    expect(rate(0.5)).toBeLessThan(0.05 * rate(2));
    let prev = -1;
    for (const U of [0.25, 0.5, 1, 1.5, 2, 2.5, 3, 3.4]) {
      expect(rate(U)).toBeGreaterThanOrEqual(prev);
      prev = rate(U);
    }
  });

  it('the emitter RUNS the contact model: at 2 m/s one tick spawns in contact mode, where the unscaled galleon ramp spawned nothing', () => {
    const passes = (withContact: boolean): number => {
      const bs = createBowSpray();
      let computes = 0;
      const rec = {
        compute: () => { computes++; }, render: () => {}, setRenderTarget: () => {}, getRenderTarget: () => null,
        getClearColor: () => {}, getClearAlpha: () => 0, setClearColor: () => {}, clear: () => {},
      };
      const V = THREE.Vector3;
      bs.update(rec as never, {
        bowWorldPos: new V(0, 0, 6), shipVelocity: new V(0, 0, 2), shipForward: new V(0, 0, 1), immersionDepth: 0.05,
        cutwater: { inContact: true, world: [0, 0, 6], depth: 0.05, rate: 0, halfWidth: 1 },
        contact: withContact ? c : undefined,
      });
      return computes; // init + physics, + spawn when the tick's budget is ≥ 1
    };
    expect(passes(true)).toBe(3);
    expect(passes(false)).toBe(2);
  });

  it('the raft page feeds spray her contact and no longer feeds it the speed scale', () => {
    const code = raftFrameSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const call = code.slice(code.indexOf('sea.bowSpray.update('));
    const args = call.slice(0, call.indexOf('});'));
    expect(args).toMatch(/contact:\s*bowContact/);
    expect(args).not.toMatch(/speedScale/);
    expect(code).toMatch(/sliceZ:\s*hull\.sliceZ/);
    expect(code).toMatch(/draft\(\)\s*\{\s*return raftSeaParams\.hullDraft/);
  });
});

describe('3. §V28: non-finite inputs throw nothing', () => {
  it('NaN velocity, burial, draft or station depth → rate 0', () => {
    const c = contact(RAFT, raftSeaParams.hullDraft, 0.05);
    expect(bowContactEmission(c, 0, 2, 0, 0.05, sprayParams).rate).toBeGreaterThan(0);
    for (const [ux, uz, br] of [[Number.NaN, 2, 0], [0, Number.POSITIVE_INFINITY, 0], [0, 2, Number.NaN]]) {
      expect(bowContactEmission(c, ux, uz, br, 0.05, sprayParams).rate).toBe(0);
    }
    expect(bowContactEmission({ ...c, draft: Number.NaN }, 0, 2, 0, 0.05, sprayParams).rate).toBe(0);
    const poisoned = Float64Array.from(c.depth);
    poisoned[3] = Number.NaN;
    expect(bowContactEmission({ ...c, depth: poisoned }, 0, 2, 0, 0.05, sprayParams).rate).toBe(0);
  });
});

describe('4. §T.59: contact-mode sheets are not faded at follow-cam range, and the pool uses the override', () => {
  it('at the shipped follow cam (25 m back, 17 m up ≈ 30 m; 37 m worst measured) the contact fade is 1, the mist fade is not', () => {
    for (const dist of [Math.hypot(25, 17), 37]) {
      expect(distanceFade(dist, sprayParams.bowContactFadeNear, sprayParams.bowContactFadeFar)).toBe(1);
    }
    // the measured T59 defect: the shared crest-mist fade had already taken a third off at 37 m
    expect(distanceFade(37, sprayParams.fadeNear, sprayParams.fadeFar)).toBeLessThan(0.75);
  });

  /** the sprite material's bound uniform values after one update in each mode */
  function spriteUniforms(withContact: boolean): { values: unknown[]; wgsl: string } {
    const bs = createBowSpray();
    const rec = {
      compute: () => {}, render: () => {}, setRenderTarget: () => {}, getRenderTarget: () => null,
      getClearColor: () => {}, getClearAlpha: () => 0, setClearColor: () => {}, clear: () => {},
    };
    const V = THREE.Vector3;
    bs.update(rec as never, {
      bowWorldPos: new V(0, 0, 6), shipVelocity: new V(0, 0, 2), shipForward: new V(0, 0, 1), immersionDepth: 0.1,
      cutwater: { inContact: true, world: [0, 0, 6], depth: 0.1, rate: 0, halfWidth: 1 },
      contact: withContact ? contact(RAFT, raftSeaParams.hullDraft, 0.05) : undefined,
    });
    const canvas = {
      width: 4, height: 4, style: {}, getContext: (): null => null, addEventListener: (): void => {},
      removeEventListener: (): void => {}, getRootNode: (): unknown => ({}), setAttribute: (): void => {},
    };
    const renderer = new THREE.WebGPURenderer({ canvas: canvas as never });
    const backend = (renderer as any).backend;
    backend.renderer = renderer;
    const b = backend.createNodeBuilder(bs.mesh, renderer);
    b.scene = new THREE.Scene();
    b.material = (bs.mesh as any).material;
    b.camera = new THREE.PerspectiveCamera();
    b.context.material = b.material;
    b.build();
    const values: unknown[] = [];
    for (const group of b.getBindings()) for (const bind of group.bindings) for (const u of bind.uniforms ?? []) values.push(u.value);
    const ids = new Map<string, number>();
    const wgsl = `${b.vertexShader}\n----\n${b.fragmentShader}`.replace(/NodeBuffer_(\d+)/g, (_m: string, id: string) => {
      if (!ids.has(id)) ids.set(id, ids.size);
      return `NodeBuffer_#${ids.get(id)}`;
    });
    return { values, wgsl };
  }

  it('contact mode binds the bow fade; the legacy (pirate) mode binds the shared fade; same shader either way', () => {
    const contactMode = spriteUniforms(true);
    const legacy = spriteUniforms(false);
    expect(contactMode.values).toContain(sprayParams.bowContactFadeNear);
    expect(contactMode.values).toContain(sprayParams.bowContactFadeFar);
    expect(legacy.values).toContain(sprayParams.fadeNear);
    expect(legacy.values).not.toContain(sprayParams.bowContactFadeNear);
    expect(contactMode.wgsl).toBe(legacy.wgsl);
  });
});
