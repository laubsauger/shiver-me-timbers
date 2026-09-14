/**
 * §T W2b — the per-page wake BACKEND switch (docs/wake/w2b-integration.md).
 * WHY each block exists:
 *
 *  1. PIRATE IS UNTOUCHED. The pirate page (main.ts) builds `createFlowFoam()`
 *     and must keep the analytic Kelvin surface byte-for-byte until it is
 *     wired to the sim deliberately. A default that drifted to 'sim', or a
 *     shared-graph edit that leaked into the analytic branch, would change the
 *     shipped sea with nobody asking for it.
 *  2. THE SIM COSTS THE OCEAN MATERIAL NO BINDING (§V40). It is resampled into
 *     flowfoam's existing channels in a COMPUTE pass, and its foam age (W5b)
 *     is read off the same foam textures, so every stage binds as many
 *     textures and samplers as the analytic backend. The fragment stage has
 *     one sampler of headroom.
 *  3. THE RAFT'S SURFACE IS THE SIM'S (§V100). Her near advect pass binds the
 *     solver's height + slope textures, and the analytic injector is asked for
 *     doses only, never for the crests/elevation the sim replaces.
 *  4. §V8 AMENDMENT (§T.168–§T.170): hulls do NOT feel the sim wake. Her
 *     buoyancy with the sim on is bit-identical to no wake at all, whatever
 *     state the sim is in — and the old analytic coupling demonstrably moved
 *     her, so this is not vacuous.
 *  5. §V105: the domain follows her SIM pose, snapped to texels, never a camera.
 *  6. §V104/§V2: one compute group per frame, advanced by banked SIM time.
 *  7. §V28: non-finite pose/samples/dt cannot poison the domain or the step.
 *  8. The .ba contract: the sim's slope is the WORLD gradient (∂/∂x, ∂/∂z) —
 *     the convention `wakeSlopeNode` consumers add straight onto slopeX/slopeZ —
 *     and it keeps its axis and sign through the solver-output packing, the
 *     resample and the rate packing (the ONE expression TSL and CPU both run).
 *  9. §V101/§V77: in game the wake samples come out of `stepShipBuoyancy`'s own
 *     station loop; asking for them changes nothing about the pirate hull.
 * 10. No first-use compile: the raft boot warm list builds the sim pipelines.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { float, lights, vec2, vec4 } from 'three/tsl';
import mainSource from '../src/main.ts?raw';
import mainRaftSource from '../src/main-raft.ts?raw';
import stationSourcesSource from '../src/wake/stationSources.ts?raw';
import raftSceneSource from '../src/raft/raftScene.ts?raw';
import raftFrameSource from '../src/raft/raftFrame.ts?raw';
import wakeSimSource from '../src/wake/wakeSim.ts?raw';
import { createFlowFoam, type FlowFoam } from '../src/flowfoam';
import { raftWakeBackend } from '../src/raft/raftScene';
import { installNodeTypeCache } from '../src/core/nodeTypeCache';
import { createSimWakeField, packSimRate, simSurfaceCpu } from '../src/flowfoam/simInjection';
import { buildOceanSurfaceMaterial } from '../src/ocean/surfaceMaterial';
import { buildOceanGrid, type SurfaceGridOptions } from '../src/ocean/surfaceGeometry';
import { oceanSurfaceParams as sp } from '../src/params/oceanSurface';
import { oceanParams, type OceanParams } from '../src/params/ocean';
import { raftSeaParams, seaPhysicsParams } from '../src/params/seaPhysics';
import { raftWakeParams } from '../src/params/raftSailing';
import { CpuOcean } from '../src/sea-physics/cpuOcean';
import { equilibriumDraft, stepShipBuoyancy } from '../src/sea-physics/buoyancy';
import { quatFromAxisAngle, rotateVec } from '../src/core/quat';
import { SIM_DT } from '../src/core/loop';
import type { ShipState } from '../src/state/simState';
import { stationSamples } from '../src/wake/stationSources';
import { WAKE_RAFT_TIER, stationFrame } from '../src/wake/wakeCalibration';
import { WakeSim } from '../src/wake/wakeSim';
import {
  WAKE_TEX_CHANNEL,
  WakeSolverCpu,
  WakeSourceBuffer,
  defaultSponge,
  splatSigma,
  wakeAnchor,
  type HydroSample,
} from '../src/wake/wakeSolverMath';
import { wakeDispatchCount } from '../src/wake/wakeSolverPasses';

// ---------------------------------------------------------------------------
// headless WGSL (codegen needs no GPUDevice — tests/zzScratchOceanCompile precedent)
// ---------------------------------------------------------------------------

function stubCanvas(): unknown {
  return {
    width: 4, height: 4, style: {}, getContext: (): null => null,
    addEventListener: (): void => {}, removeEventListener: (): void => {},
    getRootNode: (): unknown => ({}), setAttribute: (): void => {},
  };
}

function headlessBuilder(object: unknown): any {
  const renderer = new THREE.WebGPURenderer({ canvas: stubCanvas() as HTMLCanvasElement });
  const backend = (renderer as any).backend;
  backend.renderer = renderer;
  (renderer as any).hasFeature = (name: string): boolean => name === 'float32-filterable';
  return backend.createNodeBuilder(object, renderer);
}

/** textures bound by a built shader, any stage */
function boundTextures(builder: any): Set<unknown> {
  const out = new Set<unknown>();
  for (const group of builder.getBindings()) for (const b of group.bindings) if (b.texture) out.add(b.texture);
  return out;
}

/** uniform values bound by a built shader (buffer members) */
function boundValues(builder: any): unknown[] {
  const out: unknown[] = [];
  for (const group of builder.getBindings()) {
    for (const b of group.bindings) for (const u of b.uniforms ?? []) out.push(u.value);
  }
  return out;
}

interface Built {
  wgsl: string;
  textures: Set<unknown>;
  values: unknown[];
}

/**
 * Uniform-array buffers are named by a process-global node id
 * (`NodeBuffer_1317`), so two builds in one process differ only there; renumber
 * by first appearance. Everything else is emitted from stage-local counters.
 */
function canonical(wgsl: string): string {
  const ids = new Map<string, number>();
  return wgsl.replace(/NodeBuffer_(\d+)/g, (_m, id: string) => {
    if (!ids.has(id)) ids.set(id, ids.size);
    return `NodeBuffer_#${ids.get(id)}`;
  });
}

function buildCompute(node: unknown): Built {
  const b = headlessBuilder(node);
  b.build();
  return { wgsl: canonical(b.computeShader), textures: boundTextures(b), values: boundValues(b) };
}

// three's getNodeType memo — main.ts and main-raft.ts install it at boot, and
// it is what makes the shipped ocean material build in ~1 s instead of ~40 s
installNodeTypeCache();

/** a renderer that records what the frame asks of it */
function recorder() {
  const computes: unknown[] = [];
  let renders = 0;
  const r = {
    compute: (n: unknown) => { computes.push(n); },
    render: () => { renders++; },
    setRenderTarget: () => {}, getRenderTarget: () => null, getClearColor: () => {},
    getClearAlpha: () => 0, setClearColor: () => {}, clear: () => {},
  };
  return { r: r as never as THREE.WebGPURenderer, computes, renders: () => renders };
}

/** flowfoam's compute passes for one frame, built */
function flowfoamPasses(ff: FlowFoam): Built[] {
  const rec = recorder();
  ff.advanceWake(1 / 60);
  ff.update(rec.r, 1 / 60);
  // the wake's group is the one long array; the accumulation tiers submit [advect, blur] pairs since their batching
  return rec.computes.flatMap((c) => (Array.isArray(c) ? (c.length > 2 ? [] : c.map(buildCompute)) : [buildCompute(c)]));
}

let oceanDeps: Promise<any> | null = null;
function deps(): Promise<any> {
  oceanDeps ??= (async () => {
    const { createOceanSim } = await import('../src/ocean');
    const { createFoamSim } = await import('../src/foam');
    const { createSky } = await import('../src/sky');
    const { createArchipelago } = await import('../src/island');
    const { createFetchField } = await import('../src/ocean/fetchField');
    const { createCaustics, setActiveCaustics } = await import('../src/caustics');
    const sky = createSky({ scene: new THREE.Scene() });
    const ocean = createOceanSim(7);
    const foam = createFoamSim(
      ocean.cascades.map((c: any) => ({ displacement: c.displacement, derivatives: c.derivatives, domain: c.domain })),
      oceanParams.resolution,
      ocean,
    );
    setActiveCaustics(createCaustics(ocean, { sunLight: sky.sunLight }));
    const archipelago = createArchipelago({ seed: 7 });
    return { sky, ocean, foam, archipelago, fetchField: createFetchField(archipelago.seabed) };
  })();
  return oceanDeps;
}

/** the SHIPPED ocean-surface material's WGSL (vertex + fragment) against a given flowfoam */
async function oceanWgsl(ff: FlowFoam): Promise<Built> {
  const d = await deps();
  const grid: SurfaceGridOptions = {
    segments: sp.gridSegments, coreSpacing: sp.gridCoreSpacing,
    horizonRadius: sp.gridHorizonRadius, rimRound: sp.gridRimRound,
  };
  const surface = buildOceanSurfaceMaterial(
    d.ocean, d.foam, ff, grid, d.sky.sunLight, d.archipelago.seabed, null, true,
    d.sky.skyDomeColor, d.fetchField, d.sky.skySunTerm,
  );
  const mesh = new THREE.Mesh(buildOceanGrid({ ...grid, segments: 8 }), surface.material);
  const b = headlessBuilder(mesh);
  b.scene = new THREE.Scene();
  b.material = surface.material;
  b.camera = new THREE.PerspectiveCamera();
  b.context.material = surface.material;
  b.lightsNode = lights([]);
  b.build();
  return { wgsl: canonical(`${b.vertexShader}\n----\n${b.fragmentShader}`), textures: boundTextures(b), values: [] };
}

const simFoam = (): FlowFoam => createFlowFoam({ wakeBackend: 'sim', wakeTier: WAKE_RAFT_TIER });

// ---------------------------------------------------------------------------

describe('1. pirate: the analytic backend is the default and is untouched', () => {
  it('createFlowFoam() IS the analytic backend — same ocean + flowfoam WGSL, no solver, no sim texture bound', async () => {
    const dflt = createFlowFoam();
    const explicit = createFlowFoam({ wakeBackend: 'analytic' });
    expect(dflt.wakeBackend).toBe('analytic');
    expect(dflt.wakeSim).toBeNull();
    expect((await oceanWgsl(dflt)).wgsl).toBe((await oceanWgsl(explicit)).wgsl);
    const a = flowfoamPasses(dflt);
    const b = flowfoamPasses(explicit);
    expect(a.map((p) => p.wgsl)).toEqual(b.map((p) => p.wgsl));
    // the pirate page still builds the default — wiring it to the sim is a deliberate later step
    expect(mainSource).toMatch(/createFlowFoam\(\)/);
  }, 120_000);

  it('the analytic CPU mirror is live and identical between default and explicit analytic', () => {
    const run = (ff: FlowFoam): number[] => {
      const out: number[] = [];
      for (let i = 0; i < 240; i++) {
        const z = (6 * i) / 60;
        ff.setCenter(0, z);
        ff.setShip([0, z], 0, 6, 20, -18, 9);
        ff.advanceWake(1 / 60);
      }
      for (let dz = -40; dz <= 10; dz += 2) for (let dx = -12; dx <= 12; dx += 2) out.push(ff.wakeHeightCpu(dx, 24 + dz, 0));
      return out;
    };
    const a = run(createFlowFoam());
    expect(a).toEqual(run(createFlowFoam({ wakeBackend: 'analytic' })));
    expect(Math.max(...a.map(Math.abs))).toBeGreaterThan(0.05);
  });
});

describe('2. §V40: the sim adds no BINDING to the ocean material', () => {
  /**
   * Re-cut at W5b (§T.180 d). W2b pinned "WGSL byte-identical in both
   * backends" — a DECISION that held while the sim changed nothing the material
   * reads. W5b gives sim wake foam an AGE (flowfoam's two decay clocks, read off
   * the SAME foam textures), so the sim material legitimately differs. The
   * PROPERTY §V40 protects is the binding budget: every stage binds exactly as
   * many textures and samplers under the sim as under the analytic backend, and
   * no solver texture reaches the material. The pirate side is held by the
   * construction gate (`wakeFoamFreshnessNode === null` on analytic, so the
   * analytic material builds the pre-W5b graph) and by §1.
   */
  const perStage = (wgsl: string) => {
    const [vertex, fragment] = wgsl.split('\n----\n');
    const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;
    return {
      vTex: count(vertex, /:\s*texture_(?!storage)/g),
      vSmp: count(vertex, /:\s*sampler\b/g),
      fTex: count(fragment, /:\s*texture_(?!storage)/g),
      fSmp: count(fragment, /:\s*sampler\b/g),
    };
  };

  it('same per-stage texture + sampler count under the sim backend, no solver texture bound; the age term is sim-only', async () => {
    const analyticFf = createFlowFoam();
    expect(analyticFf.wakeFoamFreshnessNode).toBeNull();
    const analytic = await oceanWgsl(analyticFf);
    const ff = simFoam();
    expect(ff.wakeFoamFreshnessNode).not.toBeNull();
    const sim = await oceanWgsl(ff);
    expect(perStage(sim.wgsl)).toEqual(perStage(analytic.wgsl));
    expect(perStage(analytic.wgsl).fSmp).toBeGreaterThan(0);
    expect(sim.textures.size).toBe(analytic.textures.size);
    expect(sim.textures.has(ff.wakeSim!.solver.heightTexture)).toBe(false);
    expect(sim.textures.has(ff.wakeSim!.solver.slopeTexture)).toBe(false);
    expect(sim.textures.has(ff.wakeSim!.solver.headTarget.texture)).toBe(false);
    // liveness: the sim material really carries the age term
    expect(sim.wgsl).not.toBe(analytic.wgsl);
  }, 120_000);
});

describe('3. raft: the near tier draws the SIM surface; foam + slick doses are the sim\'s too (§T.171 W5)', () => {
  /**
   * Re-cut at W5. W2b pinned "far tier WGSL identical between backends" because
   * the far tier then carried the ANALYTIC doses on both. W5 moved the doses to
   * the sim (tests/wakeFoamSim.test.ts), so the property is now: the sim
   * backend's passes read the solver, and the analytic Kelvin walk (its
   * track uniform arrays) is compiled into NONE of them — while the analytic
   * backend's advect passes still carry it.
   */
  it('the near advect binds solver height + slope + head; the far advect binds slope + head, not height; no sim pass carries the analytic walk', () => {
    const ff = simFoam();
    const { heightTexture, slopeTexture, headTarget } = ff.wakeSim!.solver;
    const sim = flowfoamPasses(ff);
    const near = sim.filter((p) => p.textures.has(heightTexture));
    expect(near.length).toBe(1);
    expect(near[0].textures.has(slopeTexture)).toBe(true);
    // 4 flowfoam passes (near advect/blur, far advect/blur) — the surface is resampled in exactly one
    expect(sim.length).toBe(4);
    const analytic = flowfoamPasses(createFlowFoam());
    expect(analytic.length).toBe(4);
    // update order: near advect, near blur, far advect, far blur
    expect(sim[0]).toBe(near[0]);
    // W5: both advect passes inject from the sim (breaking off the slope, churn off the head)
    for (const adv of [sim[0], sim[2]]) {
      expect(adv.textures.has(slopeTexture)).toBe(true);
      expect(adv.textures.has(headTarget.texture)).toBe(true);
    }
    // the far tier carries doses only — never the surface
    expect(sim[2].textures.has(heightTexture)).toBe(false);
    // the analytic Kelvin walk is its track uniform arrays: live on the analytic backend, absent on the sim's
    const walk = /NodeBuffer_/;
    expect(analytic[0].wgsl).toMatch(walk);
    expect(analytic[2].wgsl).toMatch(walk);
    for (const pass of sim) expect(pass.wgsl).not.toMatch(walk);
    // the far blur is dose-independent, so it is still the analytic backend's
    expect(sim[3].wgsl).toBe(analytic[3].wgsl);
    // the near blur no longer smears .ba (research §5.3) — a real change, not a no-op flag
    expect(sim[1].wgsl).not.toBe(analytic[1].wgsl);
  });

  it('surface channels come from the sim textures; the analytic injector is only ever asked with detail = false', () => {
    const sim = new WakeSim(WAKE_RAFT_TIER);
    const asked: boolean[] = [];
    const sentinelElev = float(12345);
    const sentinelRate = vec4(1, 2, 3, 4);
    const analytic = (_xz: unknown, detail: boolean) => {
      asked.push(detail);
      return { rate: sentinelRate, elev: sentinelElev };
    };
    const { field } = createSimWakeField(analytic, sim);
    const near = field(vec2(1, 2), true, float(0.25));
    const far = field(vec2(1, 2), false, float(2));
    expect(asked).toEqual([false, false]);
    // far tier: the analytic field unchanged
    expect(far.elev).toBe(sentinelElev);
    // near tier: elevation and slope reach the solver's textures, never the analytic surface
    const reach = (root: unknown): Set<unknown> => {
      const seen = new Set<unknown>();
      const textures = new Set<unknown>();
      const walk = (n: any): void => {
        if (!n || seen.has(n)) return;
        seen.add(n);
        if (n.isTextureNode) textures.add(n.value);
        for (const c of n.getChildren()) walk(c);
      };
      walk(root);
      (textures as any).nodes = seen;
      return textures;
    };
    const elevTex = reach(near.elev);
    expect(elevTex.has(sim.solver.heightTexture)).toBe(true);
    expect((elevTex as any).nodes.has(sentinelElev)).toBe(false);
    const rateTex = reach(near.rate);
    expect(rateTex.has(sim.solver.slopeTexture)).toBe(true);
    /**
     * The TSL instantiation's own channel operator (`t[swizzle[c]]`) is the one
     * piece 8b's CPU evaluator cannot run. So read it off the built graph: in
     * rate.b every swizzle taken of a SLOPE-texture load must be the
     * SLOPE_DX channel, in rate.a the SLOPE_DZ channel.
     */
    const swz = ['x', 'y', 'z', 'w'];
    const channelsInto = (root: any, tex: unknown): Set<string> => {
      const out = new Set<string>();
      const seen = new Set<unknown>();
      const walk = (n: any): void => {
        if (!n || seen.has(n)) return;
        seen.add(n);
        if (n.isSplitNode && reach(n.node).has(tex)) out.add(n.components);
        for (const c of n.getChildren()) walk(c);
      };
      walk(root);
      return out;
    };
    const parts = (near.rate as any).nodes;
    expect(parts?.length).toBe(4);
    expect([...channelsInto(parts[2], sim.solver.slopeTexture)]).toEqual([swz[WAKE_TEX_CHANNEL.SLOPE_DX]]);
    expect([...channelsInto(parts[3], sim.solver.slopeTexture)]).toEqual([swz[WAKE_TEX_CHANNEL.SLOPE_DZ]]);
    expect([...channelsInto(near.elev, sim.solver.heightTexture)]).toEqual([swz[WAKE_TEX_CHANNEL.HEIGHT]]);
    sim.dispose();
  });
});

describe('4. §V8 amendment: raft buoyancy does not feel the sim wake', () => {
  const FLAT: OceanParams = { ...oceanParams, resolution: 128, amplitude: 0, swellAmplitude: 0 };
  const RAFT_BOW = 6.85;
  const RAFT_STERN = -10.55;
  const RAFT_BEAM = 6;

  /** her tick order (raftFrame.tickSea): ocean → wake track → buoyancy → wake sources */
  function tow(ff: FlowFoam | null, feedSim: boolean, seconds: number, speed = 2): number[] {
    const ocean = new CpuOcean(7, FLAT, raftSeaParams);
    if (ff) {
      ff.setSpeedScale(raftWakeParams.speedScale);
      ocean.setWakeField(ff);
    }
    const raft = {
      id: 'raft', kind: 'player', position: [0, equilibriumDraft(raftSeaParams), 0], quaternion: [0, 0, 0, 1],
      velocity: [0, 0, speed], angularVelocity: [0, 0, 0], rudder: 0, sailTrim: 0, flood: 0, damage: {},
    } as never as ShipState;
    const samples: HydroSample[] = [];
    const trace: number[] = [];
    let t = 0;
    for (let i = 0; i < Math.round(seconds / SIM_DT); i++) {
      t += SIM_DT;
      raft.position[0] = 0;
      raft.position[2] = speed * t;
      raft.velocity[0] = 0;
      raft.velocity[2] = speed;
      ocean.update(t);
      if (ff) {
        const f = rotateVec(raft.quaternion, [0, 0, 1]);
        ff.setCenter(raft.position[0], raft.position[2]);
        ff.setShip([raft.position[0], raft.position[2]], Math.atan2(f[0], f[2]), speed, RAFT_BOW, RAFT_STERN, RAFT_BEAM);
        ff.advanceWake(SIM_DT);
      }
      // her tick: the buoyancy step that floats her writes the wake samples (raftFrame.tickSea)
      stepShipBuoyancy(raft, ocean, SIM_DT, raftSeaParams, undefined, ff?.wakeSim && feedSim ? samples : undefined);
      if (ff?.wakeSim && feedSim) {
        expect(samples.length).toBe(54);
        ff.wakeSim.tick(raft, samples, stationFrame(raftSeaParams).stem, SIM_DT);
        if (i % 3 === 0) ff.wakeSim.step(recorder().r);
      }
      trace.push(raft.position[1], ...raft.quaternion, raft.velocity[1], ...raft.angularVelocity);
    }
    return trace;
  }

  it('sim on (fed or idle) floats her exactly as no wake; the old analytic coupling did move her', () => {
    const seconds = 12;
    const none = tow(null, false, seconds);
    expect(tow(simFoam(), true, seconds)).toEqual(none);
    expect(tow(simFoam(), false, seconds)).toEqual(none);
    // liveness: the analytic wake in her mirror changes the same run (measured 0.85° trim, 3.1 cm heave at 2 m/s)
    const analytic = tow(createFlowFoam(), false, seconds);
    const stride = 9;
    let maxDy = 0;
    for (let k = 0; k < none.length; k += stride) maxDy = Math.max(maxDy, Math.abs(analytic[k] - none[k]));
    expect(maxDy).toBeGreaterThan(0.005);
  }, 120_000);

  it('the sim backend’s CPU mirror reads 0 even where its analytic track would not', () => {
    const ff = simFoam();
    const ref = createFlowFoam();
    for (const f of [ff, ref]) {
      for (let i = 0; i < 240; i++) {
        f.setCenter(0, i * 0.1);
        f.setShip([0, i * 0.1], 0, 6, 20, -18, 9);
        f.advanceWake(1 / 60);
      }
    }
    let refPeak = 0;
    for (let dz = -30; dz <= 10; dz += 1) {
      for (let dx = -10; dx <= 10; dx += 1) {
        refPeak = Math.max(refPeak, Math.abs(ref.wakeHeightCpu(dx, 24 + dz, 0)));
        expect(ff.wakeHeightCpu(dx, 24 + dz, 0)).toBe(0);
        expect(ff.wakeHeightCpu(dx, 24 + dz, 0.3)).toBe(0);
      }
    }
    expect(refPeak).toBeGreaterThan(0.05);
  });

  it('the raft page selects the sim and feeds it from her own stations in the fixed tick', () => {
    expect(raftSceneSource).toMatch(/wakeBackend:\s*raftWakeBackend\(/);
    // the shipped raft page is the sim; only an explicit A/B query builds the analytic surface
    expect(raftWakeBackend('')).toBe('sim');
    expect(raftWakeBackend('?weather=calm')).toBe('sim');
    expect(raftWakeBackend('?wake=analytic')).toBe('analytic');
    expect(raftSceneSource).toMatch(/wakeTier:\s*WAKE_RAFT_TIER/);
    const tick = raftFrameSource.slice(raftFrameSource.indexOf('tickSea('), raftFrameSource.indexOf('renderSea('));
    // §V101: the samples come out of her buoyancy step, not a second evaluation of the sea
    expect(tick).toMatch(/stepShipBuoyancy\(raft, sea\.cpuOcean, dt, raftSeaParams, undefined, wakeSim \? wakeSamples/);
    expect(tick).toMatch(/wakeSim\.tick\(raft, wakeSamples,/);
    expect(tick).not.toMatch(/stationSamples|pressureHeadAt/);
  });
});

describe('5. §V105: the domain follows her sim pose, snapped to texels', () => {
  it('centre = bow-anchored, texel-snapped function of position + heading; the driver never sees a camera', () => {
    const sim = new WakeSim(WAKE_RAFT_TIER);
    const { solver } = sim;
    const bow = stationFrame(raftSeaParams).stem;
    const clearance = 4 * splatSigma(0, solver.texel, solver.n);
    for (const [x, z, yaw] of [[0, 0, 0], [123.37, -45.1, Math.PI / 2], [-800.2, 311.9, 2.3]] as const) {
      const pose = { position: [x, 0.1, z], quaternion: quatFromAxisAngle([0, 1, 0], yaw) };
      sim.tick(pose, [], bow, SIM_DT);
      const f = rotateVec(pose.quaternion, [0, 0, 1]);
      const want = wakeAnchor(x, z, f[0], f[2], bow, solver.domain, solver.sponge, clearance);
      expect(Math.abs(solver.centerX - want.x)).toBeLessThanOrEqual(solver.texel / 2 + 1e-9);
      expect(Math.abs(solver.centerZ - want.z)).toBeLessThanOrEqual(solver.texel / 2 + 1e-9);
      expect(Math.abs(solver.centerX / solver.texel - Math.round(solver.centerX / solver.texel))).toBeLessThan(1e-6);
      // the stem sits inside the unsponged interior, the rest of the interior astern
      const stemAlong = (x + f[0] * bow - solver.centerX) * f[0] + (z + f[2] * bow - solver.centerZ) * f[2];
      expect(stemAlong).toBeLessThan((0.5 - solver.sponge.width) * solver.domain);
      expect(stemAlong).toBeGreaterThan(0);
    }
    const code = wakeSimSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/camera/i);
    sim.dispose();
  });

  it('the advect pass resamples about the centre the dispatched group scrolled to', () => {
    const ff = simFoam();
    const sim = ff.wakeSim!;
    const pose = { position: [57.3, 0, -12.9], quaternion: quatFromAxisAngle([0, 1, 0], 0.7) };
    sim.tick(pose, [], 5, SIM_DT);
    expect(Math.hypot(sim.solver.centerX, sim.solver.centerZ)).toBeGreaterThan(10);
    // the near advect pass (built after a frame) reads a vec2 equal to the solver's centre
    const near = flowfoamPasses(ff).find((p) => p.textures.has(sim.solver.heightTexture));
    expect(near).toBeDefined();
    const centre = near!.values.filter(
      (v: any) => v?.isVector2 && v.x === sim.solver.centerX && v.y === sim.solver.centerZ,
    );
    expect(centre.length).toBe(1);
    ff.dispose();
  });
});

describe('6. §V104 + §V2: one compute group per frame, advanced by sim time', () => {
  it('N ticks then a frame → ONE compute call carrying the whole group and ONE splat, dt = Σ tick dt', () => {
    const ff = simFoam();
    const sim = ff.wakeSim!;
    const steps: number[] = [];
    const orig = sim.solver.step.bind(sim.solver);
    sim.solver.step = (r, dt) => { steps.push(dt); orig(r, dt); };
    const pose = { position: [0, 0, 0], quaternion: [0, 0, 0, 1] };
    for (let i = 0; i < 3; i++) sim.tick(pose, [], 5, SIM_DT);
    const rec = recorder();
    ff.advanceWake(SIM_DT);
    ff.update(rec.r, 1 / 20);
    const groups = rec.computes.filter((c) => Array.isArray(c) && c.length > 2) as unknown[][];
    expect(groups.length).toBe(1);
    expect(groups[0].length).toBe(wakeDispatchCount(WAKE_RAFT_TIER.n));
    expect(groups[0]).toBe(sim.solver.computeNodes);
    expect(rec.renders()).toBe(1);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toBeCloseTo(3 * SIM_DT, 12);
    // a frame with no tick behind it dispatches no wake work at all
    const idle = recorder();
    ff.update(idle.r, 1 / 144);
    expect(idle.computes.filter((c) => Array.isArray(c) && c.length > 2)).toHaveLength(0);
    expect(idle.renders()).toBe(0);
    expect(steps).toHaveLength(1);
    ff.dispose();
  });
});

describe('7. §V28: non-finite inputs cannot poison the wake domain', () => {
  it('NaN pose keeps the centre, a NaN sample drops the vessel, a NaN dt banks nothing', () => {
    const sim = new WakeSim(WAKE_RAFT_TIER);
    const good = { position: [10, 0, 20], quaternion: [0, 0, 0, 1] };
    const samples = stationSamples(
      { ...good, velocity: [0, 0, 0], angularVelocity: [0, 0, 0], flood: 0 } as never,
      raftSeaParams,
    );
    sim.tick(good, samples, 5, SIM_DT);
    const cx = sim.solver.centerX;
    const cz = sim.solver.centerZ;
    expect(sim.solver.sampleCount).toBeGreaterThan(0);
    sim.tick({ position: [NaN, 0, 20], quaternion: [0, 0, 0, 1] }, samples, 5, SIM_DT);
    expect([sim.solver.centerX, sim.solver.centerZ]).toEqual([cx, cz]);
    const bad = samples.map((s, i) => (i === 7 ? { ...s, fy: NaN } : s));
    sim.tick(good, bad, 5, NaN);
    expect(sim.solver.sampleCount).toBe(0);
    const dts: number[] = [];
    sim.solver.step = (_r, dt) => { dts.push(dt); };
    sim.step(recorder().r);
    // two good ticks banked, the NaN one added nothing
    expect(dts[0]).toBeCloseTo(2 * SIM_DT, 12);
    sim.dispose();
  });
});

describe('8. the .ba contract: the sim slope is the world gradient', () => {
  it('slopeX/slopeZ match the central difference of the drawn surface along world x/z', () => {
    const solver = new WakeSolverCpu({ n: 64, texel: 0.5 });
    const buf = new WakeSourceBuffer();
    for (let k = 0; k < 90; k++) {
      buf.clear();
      buf.push(-4 + k * 0.05, 3, 4e4, 0.8, 0.2);
      solver.splat(buf);
      solver.step(1 / 30, { slope: true });
    }
    const n = solver.n;
    let num = 0;
    let den = 0;
    for (let j = 16; j < 48; j++) {
      for (let i = 16; i < 48; i++) {
        const fdx = (solver.surface[j * n + i + 1] - solver.surface[j * n + i - 1]) / (2 * solver.texel);
        const fdz = (solver.surface[(j + 1) * n + i] - solver.surface[(j - 1) * n + i]) / (2 * solver.texel);
        num += fdx * solver.slopeX[j * n + i] + fdz * solver.slopeZ[j * n + i];
        den += Math.hypot(fdx, fdz) * Math.hypot(solver.slopeX[j * n + i], solver.slopeZ[j * n + i]);
      }
    }
    // correlation of the two gradient fields: +1 = same axes and sign (a swapped or negated axis is ≤ 0.5)
    expect(den).toBeGreaterThan(0);
    expect(num / den).toBeGreaterThan(0.9);
  });
});

describe('8b. the slope keeps its axis and sign through packing → resample → rate', () => {
  /**
   * A field with slope ONLY along one world axis goes through exactly what the
   * GPU path does: the solver's outputs packed by WAKE_TEX_CHANNEL (the table
   * the post pass writes by), the shared resample expression, the shared rate
   * packing. It must come out in rate[2] for x and rate[3] for z, with the
   * analytic sign and size.
   */
  function run(axis: 'x' | 'z') {
    const n = 64;
    const texel = 0.5;
    const solver = new WakeSolverCpu({ n, texel });
    const amp = 0.1;
    const k = (2 * Math.PI * 4) / (n * texel);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const w = ((axis === 'x' ? i : j) - n / 2) * texel;
        solver.zeta[j * n + i] = amp * Math.sin(k * w);
      }
    }
    solver.step(0, { slope: true }); // Δt = 0: the field is unchanged, the slope is its spectral gradient
    const height = new Float32Array(n * n * 4);
    const slope = new Float32Array(n * n * 4);
    for (let t = 0; t < n * n; t++) {
      height[t * 4 + WAKE_TEX_CHANNEL.HEIGHT] = solver.surface[t];
      slope[t * 4 + WAKE_TEX_CHANNEL.SLOPE_DX] = solver.slopeX[t];
      slope[t * 4 + WAKE_TEX_CHANNEL.SLOPE_DZ] = solver.slopeZ[t];
    }
    const grid = { n, texel, edge: Math.max(1, defaultSponge(n, texel).width * n) };
    let along = 0;
    let across = 0;
    let elevErr = 0;
    let peak = 0;
    for (let u = -9; u <= 9; u += 0.37) {
      for (let v = -9; v <= 9; v += 1.3) {
        const wx = axis === 'x' ? u : v;
        const wz = axis === 'x' ? v : u;
        const surf = simSurfaceCpu(grid, { height, slope }, wx, wz, 0, 0);
        const rate = packSimRate(0, 0, surf);
        const want = amp * k * Math.cos(k * u);
        const got = axis === 'x' ? rate[2] : rate[3];
        const other = axis === 'x' ? rate[3] : rate[2];
        along = Math.max(along, Math.abs(got - want));
        across = Math.max(across, Math.abs(other));
        elevErr = Math.max(elevErr, Math.abs(surf.elev - amp * Math.sin(k * u)));
        if (Math.abs(u) < 0.2) peak = Math.max(peak, got);
      }
    }
    return { along, across, elevErr, peak, scale: amp * k };
  }

  it('slope along +x lands in rate.b with its sign; slope along +z lands in rate.a with its sign', () => {
    for (const axis of ['x', 'z'] as const) {
      const r = run(axis);
      // inside the unsponged interior the window is 1: bilinear error only (λ = 16 texels)
      expect(r.peak, `${axis}: +slope at the zero crossing`).toBeGreaterThan(0.9 * r.scale);
      expect(r.along, `${axis}: matches ∂η/∂${axis}`).toBeLessThan(0.05 * r.scale);
      expect(r.across, `${axis}: nothing on the other axis`).toBeLessThan(0.05 * r.scale);
      expect(r.elevErr, `${axis}: elevation`).toBeLessThan(0.005);
    }
  });
});

describe('9. §V101: the wake samples come out of the buoyancy step that floats her', () => {
  it('asking for samples leaves the pirate hull bit-identical', () => {
    const run = (buffer: HydroSample[] | undefined): number[] => {
      const ocean = new CpuOcean(11, oceanParams, seaPhysicsParams);
      const ship = {
        id: 'player', kind: 'player', position: [3, equilibriumDraft() + 0.4, -2], quaternion: [0.02, 0.1, -0.03, 0.994],
        velocity: [0.5, -0.3, 6], angularVelocity: [0.05, 0.01, -0.04], rudder: 0, sailTrim: 0, flood: 0, damage: {},
      } as never as ShipState;
      const out: number[] = [];
      for (let i = 0; i < 300; i++) {
        ocean.update((i + 1) / 60);
        const slam = stepShipBuoyancy(ship, ocean, 1 / 60, seaPhysicsParams, [], buffer);
        out.push(...ship.position, ...ship.quaternion, ...ship.velocity, ...ship.angularVelocity, slam);
      }
      return out;
    };
    const buf: HydroSample[] = [];
    expect(run(buf)).toEqual(run(undefined));
    expect(buf.length).toBe(54);
  });

  it('the emitted samples ARE the station rule at the pose she was stepped from (one definition)', () => {
    for (const p of [seaPhysicsParams, raftSeaParams]) {
      const ocean = new CpuOcean(5, oceanParams, p);
      const ship = {
        id: 'player', kind: 'player', position: [10, equilibriumDraft(p) - 0.05, 4], quaternion: quatFromAxisAngle([0, 1, 0], 0.4),
        velocity: [0, 0, 2], angularVelocity: [0, 0, 0], rudder: 0, sailTrim: 0, flood: 0, damage: {},
      } as never as ShipState;
      const buf: HydroSample[] = [];
      for (let i = 0; i < 90; i++) {
        const t = (i + 1) / 60;
        ocean.update(t);
        const before = structuredClone(ship);
        stepShipBuoyancy(ship, ocean, 1 / 60, p, [], buf);
        const ref = stationSamples(before, p, [], (x, z) => ocean.pressureHeadAt(x, z, t));
        expect(buf).toEqual(ref);
      }
      expect(buf.some((s) => s.fy > 0)).toBe(true);
    }
    // and the reader no longer owns an immersion rule of its own
    const code = stationSourcesSource.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).toMatch(/writeStationSample\(/);
    expect(code).toMatch(/immersedDepth\(/);
    expect(code).not.toMatch(/hullFreeboard/);
  });
});

describe('10. no first-use compile: the raft boot warms the sim pipelines', () => {
  it('flowFoam.warmAsync builds the splat against the head target and runs the whole group; analytic warms nothing', async () => {
    const ff = simFoam();
    const solver = ff.wakeSim!.solver;
    const log: string[] = [];
    let target: unknown = 'canvas';
    let computed: unknown = null;
    let compiledScene: any = null;
    const r = {
      getRenderTarget: () => target,
      setRenderTarget: (t: unknown) => { target = t; },
      compileAsync: (scene: unknown) => {
        log.push(`compile@${target === solver.headTarget ? 'head' : String(target)}`);
        compiledScene = scene;
        return Promise.resolve();
      },
      computeAsync: (nodes: unknown) => { computed = nodes; log.push('compute'); return Promise.resolve(); },
    } as never as THREE.WebGPURenderer;
    await ff.warmAsync(r);
    expect(log).toEqual(['compile@head', 'compute']);
    expect(target).toBe('canvas');
    expect(computed).toBe(solver.computeNodes);
    expect((computed as unknown[]).length).toBe(wakeDispatchCount(WAKE_RAFT_TIER.n));
    let meshes = 0;
    compiledScene.traverse((o: any) => { if (o.isMesh) meshes++; });
    expect(meshes).toBe(1);
    const idle: string[] = [];
    await createFlowFoam().warmAsync({ compileAsync: () => idle.push('c'), computeAsync: () => idle.push('x') } as never);
    expect(idle).toEqual([]);
    ff.dispose();
  });

  it('the raft boot’s withFullCoverage warm list includes the sim wake, before the loop starts', () => {
    const at = mainRaftSource.indexOf('await withFullCoverage(');
    expect(at).toBeGreaterThan(0);
    const call = mainRaftSource.slice(at, mainRaftSource.indexOf(');', at));
    expect(call).toMatch(/sea\.flowFoam\.warmAsync\(app\.renderer\)/);
    expect(at).toBeLessThan(mainRaftSource.indexOf('loop.start()'));
  });
});
