/**
 * SCRATCH — §T.79. Headless reproduction of the ocean-surface `sync` blowup.
 * Gated on OCEAN_COMPILE=1, skipped otherwise. Delete with the session.
 *
 * `sync` in compileProfile.ts is main-thread JS: TSL setup + WGSL codegen +
 * binding setup. None of that needs a GPUDevice — only the DEVICE-side pipeline
 * creation does — so the whole of it is reproducible in node if a NodeBuilder
 * can be constructed against a renderer that was never `init()`ed.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { lights } from 'three/tsl';
import { OceanSimulation } from '../src/ocean/oceanCascades';
import { buildOceanSurfaceMaterial } from '../src/ocean/surfaceMaterial';
import { buildOceanGrid, type SurfaceGridOptions } from '../src/ocean/surfaceGeometry';
import { oceanSurfaceParams as sp } from '../src/params/oceanSurface';
import { installNodeTypeCache, nodeTypeCacheStats } from '../src/core/nodeTypeCache';

/** stub canvas so WebGPURenderer's ctor never reaches for `document` */
function stubCanvas(): unknown {
  return {
    width: 4,
    height: 4,
    style: {},
    getContext: (): null => null,
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
    getRootNode: (): unknown => ({}),
    setAttribute: (): void => {},
  };
}

interface BuildResult {
  setupMs: number;
  buildMs: number;
  vertexShader: string;
  fragmentShader: string;
  vertexBytes: number;
  fragmentBytes: number;
  visits: number;
  unique: number;
  typeVisits: number;
  typeUnique: number;
  byClass: string;
}

/** count method entries against distinct node instances */
function instrument(method: string): {
  stop: () => { visits: number; unique: number };
} {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proto = (THREE as any).Node.prototype;
  const original = proto[method];
  let visits = 0;
  const seen = new Set<unknown>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proto[method] = function (this: any, ...args: any[]): unknown {
    visits++;
    seen.add(this);
    return original.apply(this, args);
  };
  return {
    stop: () => {
      proto[method] = original;
      return { visits, unique: seen.size };
    },
  };
}

/**
 * `getNodeType` is defined on ~30 subclasses, so patching `Node.prototype`
 * alone misses every override. Patch every prototype on the export surface.
 */
function instrumentGetNodeType(): {
  stop: () => { visits: number; unique: number; byClass: string };
} {
  let visits = 0;
  const seen = new Set<unknown>();
  const byClass = new Map<string, number>();
  const restore: Array<() => void> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const value of Object.values(THREE as any)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proto = (value as any)?.prototype;
    if (!proto || !Object.prototype.hasOwnProperty.call(proto, 'getNodeType')) continue;
    const original = proto.getNodeType;
    if (typeof original !== 'function') continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const name = proto.constructor?.name ?? '?';
    proto.getNodeType = function (this: any, ...args: any[]): unknown {
      visits++;
      seen.add(this);
      byClass.set(name, (byClass.get(name) ?? 0) + 1);
      return original.apply(this, args);
    };
    restore.push(() => {
      proto.getNodeType = original;
    });
  }
  return {
    stop: () => {
      for (const r of restore) r();
      const top = [...byClass.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ');
      return { visits, unique: seen.size, byClass: top };
    },
  };
}

function buildMaterial(
  material: THREE.Material,
  geometry: THREE.BufferGeometry,
): BuildResult {
  const renderer = new THREE.WebGPURenderer({
    canvas: stubCanvas() as HTMLCanvasElement,
  });
  const mesh = new THREE.Mesh(geometry, material);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const backend = (renderer as any).backend;
  // `backend.renderer` is normally assigned by `backend.init(renderer)`, which
  // needs a device. Codegen only ever reads it for sample counts.
  backend.renderer = renderer;
  // match the browser's feature set; hasFeature() otherwise warns and says no,
  // and 'float32-filterable' changes which texture path is emitted.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (renderer as any).hasFeature = (name: string): boolean =>
    name === 'float32-filterable';
  const builder = backend.createNodeBuilder(mesh, renderer);
  builder.scene = new THREE.Scene();
  builder.material = material;
  builder.camera = new THREE.PerspectiveCamera();
  builder.context.material = material;
  builder.lightsNode = lights([]);
  const probeBuild = instrument('build');
  const probeType = instrumentGetNodeType();
  const t0 = performance.now();
  builder.build();
  const t1 = performance.now();
  const built = probeBuild.stop();
  const typed = probeType.stop();
  return {
    setupMs: 0,
    buildMs: t1 - t0,
    vertexShader: builder.vertexShader,
    fragmentShader: builder.fragmentShader,
    vertexBytes: builder.vertexShader.length,
    fragmentBytes: builder.fragmentShader.length,
    visits: built.visits,
    unique: built.unique,
    typeVisits: typed.visits,
    typeUnique: typed.unique,
    byClass: typed.byClass,
  };
}

const RUN = process.env.OCEAN_COMPILE === '1';

/**
 * In-process V8 sampling profiler. `node --cpu-prof` profiles the parent, not
 * the vitest worker, so the profile has to be started from inside the worker.
 */
async function withProfile<T>(path: string, fn: () => T): Promise<T> {
  if (process.env.OCEAN_PROF !== '1') return fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inspector: any = await import('node:inspector');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fs: any = await import('node:fs');
  const session = new inspector.Session();
  session.connect();
  const post = (m: string, p?: unknown): Promise<unknown> =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new Promise((res, rej) => session.post(m, p, (e: any, r: any) => (e ? rej(e) : res(r))));
  await post('Profiler.enable');
  await post('Profiler.setSamplingInterval', { interval: 200 });
  await post('Profiler.start');
  const out = fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { profile } = (await post('Profiler.stop')) as any;
  fs.writeFileSync(path, JSON.stringify(profile));
  session.disconnect();
  return out;
}

describe.skipIf(!RUN)('SCRATCH: ocean-surface headless compile', () => {
  it('builds the ocean surface material and reports the walk', async () => {
    const grid: SurfaceGridOptions = {
      segments: sp.gridSegments,
      coreSpacing: sp.gridCoreSpacing,
      horizonRadius: sp.gridHorizonRadius,
      rimRound: sp.gridRimRound,
    };
    if (process.env.OCEAN_CACHE === '1') installNodeTypeCache();
    const tSim0 = performance.now();
    const sim = new OceanSimulation(1234);
    const tSim1 = performance.now();
    const tGraph0 = performance.now();
    const surface = buildOceanSurfaceMaterial(sim, undefined, undefined, grid);
    const tGraph1 = performance.now();
    // small geometry, same attribute set as the real 512² grid
    const geometry = buildOceanGrid({ ...grid, segments: 8 });
    const r = await withProfile(
      process.env.OCEAN_PROF_OUT ?? '/tmp/ocean.cpuprofile',
      () => buildMaterial(surface.material, geometry),
    );
    const report = (label: string, x: BuildResult): string =>
      [
        `${label} build   ${x.buildMs.toFixed(1)} ms`,
        `${label} wgsl    ${x.vertexBytes + x.fragmentBytes} B ` +
          `(v ${x.vertexBytes} / f ${x.fragmentBytes})`,
        `${label} build() ${x.visits} over ${x.unique} unique = ` +
          `${(x.visits / Math.max(1, x.unique)).toFixed(1)}x`,
        `${label} type()  ${x.typeVisits} over ${x.typeUnique} unique = ` +
          `${(x.typeVisits / Math.max(1, x.typeUnique)).toFixed(0)}x`,
        `${label} by cls  ${x.byClass}`,
      ].join('\n');
    console.log(
      [
        `sim ctor        ${(tSim1 - tSim0).toFixed(1)} ms`,
        `graph construct ${(tGraph1 - tGraph0).toFixed(1)} ms`,
        report('BEFORE', r),
      ].join('\n'),
    );

    // second half: same graph, cache installed
    installNodeTypeCache();
    const surface2 = buildOceanSurfaceMaterial(sim, undefined, undefined, grid);
    const r2 = buildMaterial(surface2.material, geometry);
    console.log(report('AFTER ', r2));
    console.log('cache stats     ' + JSON.stringify(nodeTypeCacheStats));
    console.log(
      `identical wgsl  ${
        r.vertexShader === r2.vertexShader && r.fragmentShader === r2.fragmentShader
      }`,
    );
    expect(r.vertexBytes).toBeGreaterThan(0);
  }, 600_000);
});

/**
 * The SHIPPED ocean material, as close as it can be reproduced headless: foam,
 * flow foam, the seabed field, the fetch field, the sky dome + sun terms and
 * the sun light (so the in-material shadow sample is built). This is the graph
 * `ocean-surface` actually compiles at boot; the case above is a stripped one.
 */
describe.skipIf(!RUN)('SCRATCH: shipped ocean configuration', () => {
  it('builds the full material', async () => {
    if (process.env.OCEAN_CACHE === '1') installNodeTypeCache();
    const grid: SurfaceGridOptions = {
      segments: sp.gridSegments,
      coreSpacing: sp.gridCoreSpacing,
      horizonRadius: sp.gridHorizonRadius,
      rimRound: sp.gridRimRound,
    };
    const { createOceanSim, oceanParams } = await import('../src/ocean');
    const { createFoamSim } = await import('../src/foam');
    const { createFlowFoam } = await import('../src/flowfoam');
    const { createSky } = await import('../src/sky');
    const { createArchipelago } = await import('../src/island');
    const { createFetchField } = await import('../src/ocean/fetchField');
    const { createCaustics, setActiveCaustics } = await import('../src/caustics');
    const THREE2 = THREE;

    const t0 = performance.now();
    const scene = new THREE2.Scene();
    const sky = createSky({ scene });
    const ocean = createOceanSim(7);
    const foam = createFoamSim(
      ocean.cascades.map((c) => ({
        displacement: c.displacement,
        derivatives: c.derivatives,
        domain: c.domain,
      })),
      oceanParams.resolution,
      ocean,
    );
    const flowFoam = createFlowFoam();
    setActiveCaustics(createCaustics(ocean, { sunLight: sky.sunLight }));
    const archipelago = createArchipelago({ seed: 7 });
    const fetchField = createFetchField(archipelago.seabed);
    const t1 = performance.now();

    const surface = buildOceanSurfaceMaterial(
      ocean,
      foam,
      flowFoam,
      grid,
      sky.sunLight,
      archipelago.seabed,
      null,
      true,
      sky.skyDomeColor,
      fetchField,
      sky.skySunTerm,
    );
    const t2 = performance.now();
    const geometry = buildOceanGrid({ ...grid, segments: 8 });
    const r = buildMaterial(surface.material, geometry);
    console.log(
      [
        `deps            ${(t1 - t0).toFixed(0)} ms`,
        `graph construct ${(t2 - t1).toFixed(0)} ms`,
        `builder.build   ${r.buildMs.toFixed(0)} ms`,
        `wgsl            ${r.vertexBytes + r.fragmentBytes} B`,
        `getNodeType     ${r.typeVisits} over ${r.typeUnique} unique = ` +
          `${(r.typeVisits / Math.max(1, r.typeUnique)).toFixed(0)}x`,
      ].join('\n'),
    );
  }, 1_800_000);
});
