/**
 * §T.79 / §T.128: BOOT MUST NOT PAY AN EXPONENTIAL TYPE WALK.
 *
 * Every TSL node infers its type from its children's, and a TSL expression is a
 * DAG. Without a memo, one query at the root re-walks every shared subgraph once
 * per path that reaches it. On three r180 that cost 231 s of boot (34.8M
 * `getNodeType` calls over 1,170 nodes on `ocean-surface`), and
 * `src/core/nodeTypeCache.ts` patched a memo in. Three r186 memoises
 * `getNodeType` itself, in the builder's per-node data, so that patch is now a
 * no-op (its header has the measurements). This file keeps the protection and
 * asserts it on THREE ITSELF, so an upgrade that loses the memo fails here
 * instead of turning boot back into a "this tab is not responsive" dialog.
 *
 * (1) THE WALK IS LINEAR IN GRAPH SIZE, NOT EXPONENTIAL IN DEPTH. Asserted as a
 *     PROPERTY, `getNodeType` calls per DISTINCT node, never as a duration
 *     (§V.80: a threshold in ms pins a machine, not a decision).
 *
 * (2) §T.128: THE VERTEX STAGE IS COVERED TOO. `NodeMaterial.setupPosition`
 *     builds the whole vertex setup inside `subBuild(…, 'VERTEX')` and every
 *     `varying` wraps its node the same way. Three keys its memo by the closest
 *     sub-build, and a memo that misses inside sub-builds is exactly the defect
 *     §T.133 found in the old patch (piece-sail 4,049,507 calls, 100% bypassed).
 *     The ratio in (1) cannot see it. Measured on r186 with the memo bypassed
 *     inside sub-builds only, every case here stays under the (1) bound (the
 *     highest is hull-section at 164x). So it is asserted directly: inside a
 *     sub-build, a type is GENERATED (`generateNodeType`, which three runs only
 *     on a memo miss) a bounded number of times per distinct node.
 *
 * WHY THIS RUNS AT ALL WITHOUT A GPU. `NodeBuilder.build()` (TSL setup, WGSL
 * codegen and binding setup, i.e. exactly the `sync` column of
 * `src/core/compileProfile.ts`) never touches a GPUDevice. Only the pipeline
 * creation that follows it does. A `WebGPURenderer` that was never `init()`ed
 * is enough, given a stub canvas and the two fields `backend.init` would have
 * assigned.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { Fn, float, lights } from 'three/tsl';
import { OceanSimulation } from '../src/ocean/oceanCascades';
import { buildOceanSurfaceMaterial } from '../src/ocean/surfaceMaterial';
import { buildOceanGrid, type SurfaceGridOptions } from '../src/ocean/surfaceGeometry';
import { oceanSurfaceParams as sp } from '../src/params/oceanSurface';
import {
  createSandMaterial,
  terrainBlendMaterial,
} from '../src/terrain/sandMaterial';
import { createRockMaterial } from '../src/terrain/rockMaterial';
import { createPalmMaterial } from '../src/vegetation/palmMaterial';
import { createPieceMaterial } from '../src/ship/pieceMaterials';
import { createRain } from '../src/rain';
import { createWaterlineBand } from '../src/underwater/waterlineBand';
import { createImpactRings } from '../src/combat/impactRing';
import { combatFxParams } from '../src/params/combat';
import { createSierraTerrainMaterial } from '../src/island/sierraMaterial';

/** stub canvas — WebGPURenderer's ctor otherwise reaches for `document` */
function stubCanvas(): HTMLCanvasElement {
  return {
    width: 4,
    height: 4,
    style: {},
    getContext: (): null => null,
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
    getRootNode: (): unknown => ({}),
    setAttribute: (): void => {},
  } as unknown as HTMLCanvasElement;
}

interface Built {
  /** wall ms of `NodeBuilder.build()` — REPORTED, never asserted (§V.80) */
  ms: number;
  /** `getNodeType` entries */
  typeCalls: number;
  /** distinct nodes those entries landed on */
  typeNodes: number;
  /** `getNodeType` entries made while a sub-build was open */
  subBuildQueries: number;
  /** types GENERATED (memo misses) while a sub-build was open */
  subBuildGenerations: number;
  /** distinct nodes those generations landed on */
  subBuildGeneratedNodes: number;
}

/** every prototype that OWNS `method`, so an override is counted where it runs */
function prototypesOwning(method: string, extra: readonly object[]): Set<Record<string, unknown>> {
  const protos = new Set<Record<string, unknown>>();
  const add = (proto: unknown): void => {
    for (let p = proto as Record<string, unknown> | null; p; p = Object.getPrototypeOf(p)) {
      if (Object.prototype.hasOwnProperty.call(p, method)) {
        protos.add(p);
        return;
      }
    }
  };
  for (const value of Object.values(THREE as unknown as Record<string, unknown>)) {
    const proto = (value as { prototype?: object } | undefined)?.prototype;
    if (proto && Object.prototype.hasOwnProperty.call(proto, method)) protos.add(proto as Record<string, unknown>);
  }
  for (const node of extra) add(Object.getPrototypeOf(node));
  return protos;
}

/**
 * Count the type walk. Two instruments, both wrapping prototypes rather than
 * reading three's memo storage, so they measure what three DOES:
 *
 *  - `getNodeType` entries, on every prototype that owns one (Node and
 *    PropertyNode on r186; a future class that overrides it again is counted
 *    the same way). PropertyNode calls `super`, so its queries count twice:
 *    an OVER-count, the strict direction for an upper bound.
 *  - `generateNodeType` runs, which three makes only on a memo miss. Counted
 *    once per outermost run on a node, so a `super.generateNodeType` call
 *    (StorageBufferNode) is not a second miss. ShaderCallNodeInternal is not
 *    on the export surface, so it is reached through one `Fn` call: on r186 a
 *    call is a VarNode whose `.node` is the ShaderCallNodeInternal.
 */
function probeTypeWalk(): { stop: () => Omit<Built, 'ms'> } {
  let typeCalls = 0;
  let subBuildQueries = 0;
  let subBuildGenerations = 0;
  const typeNodes = new Set<unknown>();
  const subBuildGeneratedNodes = new Set<unknown>();
  const generating = new Set<unknown>();
  const inSubBuild = (builder: unknown): boolean =>
    ((builder as { subBuildLayers?: unknown[] } | undefined)?.subBuildLayers?.length ?? 0) > 0;
  const restore: Array<() => void> = [];
  const call = Fn(() => float(0))() as unknown as { node?: object };
  const internals = [call, ...(call.node ? [call.node] : [])];

  for (const proto of prototypesOwning('getNodeType', internals)) {
    const original = proto.getNodeType as (...a: unknown[]) => unknown;
    proto.getNodeType = function (this: unknown, ...args: unknown[]): unknown {
      typeCalls++;
      typeNodes.add(this);
      if (inSubBuild(args[0])) subBuildQueries++;
      return original.apply(this, args);
    };
    restore.push(() => {
      proto.getNodeType = original;
    });
  }
  for (const proto of prototypesOwning('generateNodeType', internals)) {
    const original = proto.generateNodeType as (...a: unknown[]) => unknown;
    proto.generateNodeType = function (this: unknown, ...args: unknown[]): unknown {
      if (generating.has(this)) return original.apply(this, args);
      if (inSubBuild(args[0])) {
        subBuildGenerations++;
        subBuildGeneratedNodes.add(this);
      }
      generating.add(this);
      try {
        return original.apply(this, args);
      } finally {
        generating.delete(this);
      }
    };
    restore.push(() => {
      proto.generateNodeType = original;
    });
  }
  return {
    stop: () => {
      for (const r of restore) r();
      return {
        typeCalls,
        typeNodes: typeNodes.size,
        subBuildQueries,
        subBuildGenerations,
        subBuildGeneratedNodes: subBuildGeneratedNodes.size,
      };
    },
  };
}

function build(material: THREE.Material, geometry: THREE.BufferGeometry): Built {
  const renderer = new THREE.WebGPURenderer({ canvas: stubCanvas() });
  const mesh = new THREE.Mesh(geometry, material);
  const backend = (renderer as unknown as { backend: Record<string, unknown> })
    .backend;
  // both normally assigned by `backend.init(renderer)`, which needs a device.
  // codegen reads `backend.renderer` only for sample counts, and `hasFeature`
  // only to pick a texture path — pinned to the browser's answer so the graph
  // this test walks is the graph the game ships.
  backend.renderer = renderer;
  (renderer as unknown as { hasFeature: (n: string) => boolean }).hasFeature = (
    name: string,
  ): boolean => name === 'float32-filterable';
  const builder = (
    backend as unknown as {
      createNodeBuilder: (o: THREE.Object3D, r: THREE.WebGPURenderer) => Record<string, unknown>;
    }
  ).createNodeBuilder(mesh, renderer);
  builder.scene = new THREE.Scene();
  builder.material = material;
  builder.camera = new THREE.PerspectiveCamera();
  (builder.context as Record<string, unknown>).material = material;
  builder.lightsNode = lights([]);

  const probe = probeTypeWalk();
  const t0 = performance.now();
  (builder as unknown as { build: () => void }).build();
  const ms = performance.now() - t0;
  return { ms, ...probe.stop() };
}

const GRID: SurfaceGridOptions = {
  segments: sp.gridSegments,
  coreSpacing: sp.gridCoreSpacing,
  horizonRadius: sp.gridHorizonRadius,
  rimRound: sp.gridRimRound,
};

/**
 * One entry per material under test. Each is a FACTORY, not a material, so
 * every case walks a graph that no earlier build has touched.
 */
const CASES: Array<{
  name: string;
  make: () => { material: THREE.Material; geometry: THREE.BufferGeometry };
}> = [
  {
    name: 'ocean-surface',
    make: () => {
      const sim = new OceanSimulation(1234);
      return {
        material: buildOceanSurfaceMaterial(sim, undefined, undefined, GRID).material,
        geometry: buildOceanGrid({ ...GRID, segments: 8 }),
      };
    },
  },
  {
    name: 'ocean-surface (hdr scene target)',
    make: () => {
      const sim = new OceanSimulation(99);
      return {
        material: buildOceanSurfaceMaterial(
          sim,
          undefined,
          undefined,
          GRID,
          undefined,
          null,
          null,
          true,
        ).material,
        geometry: buildOceanGrid({ ...GRID, segments: 8 }),
      };
    },
  },
  {
    name: 'terrain blend (islands)',
    make: () => ({
      material: terrainBlendMaterial().material,
      geometry: new THREE.PlaneGeometry(1, 1, 2, 2),
    }),
  },
  {
    name: 'rock',
    make: () => ({
      material: createRockMaterial().material,
      geometry: new THREE.PlaneGeometry(1, 1, 2, 2),
    }),
  },
  {
    name: 'sand',
    make: () => ({
      material: createSandMaterial().material,
      geometry: new THREE.PlaneGeometry(1, 1, 2, 2),
    }),
  },
  {
    name: 'palm',
    make: () => ({
      material: createPalmMaterial().material,
      geometry: new THREE.PlaneGeometry(1, 1, 2, 2),
    }),
  },
  {
    name: 'ship piece: hull-section',
    make: () => ({
      material: createPieceMaterial('hull-section'),
      geometry: new THREE.BoxGeometry(1, 1, 1),
    }),
  },
  {
    name: 'ship piece: deck',
    make: () => ({
      material: createPieceMaterial('deck'),
      geometry: new THREE.BoxGeometry(1, 1, 1),
    }),
  },
  {
    /**
     * §T.128 — THE VERTEX-STAGE CASE, and the reason this file needed one.
     * The sail's cloth shape is a tree of `Fn` calls each read several times
     * (`clothAt` -> `sparPushAll` -> three nested `sparPushAt`; the finite
     * differences that build the normal call `clothAt` four more times), all
     * of it in `positionNode` and therefore all of it inside
     * `subBuild(…, 'VERTEX')`. Measured at 590x per node with the memo
     * bypassing sub-builds and untyped `Fn`s; both were fixed, and this case
     * is what keeps either from coming back.
     */
    name: 'ship piece: sail (vertex-stage cloth)',
    make: () => ({
      material: createPieceMaterial('sail'),
      geometry: new THREE.PlaneGeometry(1, 1, 4, 4),
    }),
  },
  {
    /** the §T.112d layered stack — the heaviest single graph the raft boots */
    name: 'sierra terrain',
    make: () => ({
      material: createSierraTerrainMaterial().material,
      geometry: new THREE.PlaneGeometry(1, 1, 4, 4),
    }),
  },
  {
    name: 'rain',
    make: () => {
      const mesh = createRain().mesh as unknown as THREE.Mesh;
      return { material: mesh.material as THREE.Material, geometry: mesh.geometry };
    },
  },
  {
    name: 'waterline band',
    make: () => {
      const mesh = createWaterlineBand().mesh;
      return { material: mesh.material as THREE.Material, geometry: mesh.geometry };
    },
  },
  {
    name: 'impact rings',
    make: () => {
      const mesh = createImpactRings(combatFxParams).mesh as THREE.Mesh;
      return { material: mesh.material as THREE.Material, geometry: mesh.geometry };
    },
  },
  {
    name: 'MeshStandardNodeMaterial',
    make: () => ({
      material: new THREE.MeshStandardNodeMaterial(),
      geometry: new THREE.SphereGeometry(1, 8, 8),
    }),
  },
  {
    name: 'MeshPhysicalNodeMaterial',
    make: () => ({
      material: new THREE.MeshPhysicalNodeMaterial(),
      geometry: new THREE.BoxGeometry(1, 1, 1),
    }),
  },
];

/**
 * THE BOUND ON (1), and what it is a wall between. `getNodeType` calls per
 * DISTINCT node, measured on this machine with three r186 as shipped, against
 * the same r186 with its memo taken out (`getNodeType` calling
 * `generateNodeType` every time, which is r180's behaviour on today's graphs):
 *
 *   ocean-surface               4.1x -> 114,886x     (21 ms -> 79,335 ms)
 *   ocean-surface (hdr)         4.1x -> 114,886x     (20 ms -> 96,145 ms)
 *   sierra terrain              3.8x ->   3,300x     (41 ms ->  6,156 ms)
 *   ship piece: hull-section    3.8x ->   1,154x     (11 ms ->    569 ms)
 *   sand                        3.7x ->   1,146x     (10 ms ->    578 ms)
 *   terrain blend (islands)     3.7x ->     806x     (32 ms ->  1,087 ms)
 *   ship piece: deck            3.8x ->     492x     (11 ms ->    242 ms)
 *
 * 400 sits two orders above every memoised ratio and below every one of those
 * seven, so each of them FAILS this test if three's memo goes. The rest stay
 * under 400 even without it (rock 392x, sail 216x, waterline 52x, rain 33x,
 * palm 21x, the stock three materials 12x, impact rings 7x). They are carried
 * for (2), the sail above all, and because they are what boot builds.
 *
 * The ratio is what is asserted, never the ms: the times are reported so a
 * regression has something to be compared against, but a duration pins a
 * machine rather than a decision (§V.80).
 */
const MAX_TYPE_CALLS_PER_NODE = 400;

/**
 * THE BOUND ON (2). Inside a sub-build, types GENERATED per distinct node:
 * with three's memo working, 1.1x to 2.3x for every case (2.26x is the sail,
 * the deepest vertex graph here). That figure is bounded by how many memo
 * coordinates a node is asked under (cache, stage, sub-build), not by the
 * graph's depth. With the memo bypassed inside sub-builds only:
 *
 *   ocean-surface 332x, sierra terrain 300x, terrain blend 300x, sand 286x,
 *   hull-section 279x, deck 270x, sail 270x
 *
 * while every case's (1) ratio stays under 400. 25 sits about 11x above the
 * worst working figure and about 11x below the best of those.
 */
const MAX_SUB_BUILD_GENERATIONS_PER_NODE = 25;

/**
 * The cases that exist to exercise `subBuild(…, 'VERTEX')` (§T.128). Named
 * rather than inferred: the point is that SOMETHING in this file is known to
 * reach the vertex stage, and a rename that quietly drops one has to fail.
 */
const VERTEX_STAGE_CASES = [
  'ship piece: sail (vertex-stage cloth)',
  'sierra terrain',
  'ocean-surface',
] as const;

describe('§T.79 getNodeType memo', () => {
  it('three walks the type graph a bounded number of times, vertex stage included', () => {
    const rows: string[] = [];
    let subBuildTotal = 0;
    const subBuildByCase = new Map<string, number>();
    for (const c of CASES) {
      const { material, geometry } = c.make();
      // GUARD: `NodeBuilder.build()` silently substitutes a default
      // NodeMaterial for anything that is not one, and would then measure the
      // DEFAULT shader's walk and pass while testing nothing (§V.80's "passes
      // while enforcing the defect"). Fail instead.
      expect(
        (material as unknown as { isNodeMaterial?: boolean }).isNodeMaterial,
        `${c.name}: not a NodeMaterial, this case would test nothing`,
      ).toBe(true);
      const b = build(material, geometry);
      // (1) the walk is linear in graph size
      const ratio = b.typeCalls / Math.max(1, b.typeNodes);
      expect(
        ratio,
        `${c.name}: ${b.typeCalls} getNodeType calls over ` +
          `${b.typeNodes} distinct nodes = ${ratio.toFixed(0)}x`,
      ).toBeLessThan(MAX_TYPE_CALLS_PER_NODE);
      // (2) inside a sub-build the memo answers, rather than re-deriving
      const subRatio = b.subBuildGenerations / Math.max(1, b.subBuildGeneratedNodes);
      expect(
        subRatio,
        `${c.name}: ${b.subBuildGenerations} types generated inside sub-builds ` +
          `over ${b.subBuildGeneratedNodes} distinct nodes = ${subRatio.toFixed(1)}x — ` +
          `three's memo is missing in the vertex stage (§T.128)`,
      ).toBeLessThan(MAX_SUB_BUILD_GENERATIONS_PER_NODE);
      subBuildByCase.set(c.name, b.subBuildQueries);
      subBuildTotal += b.subBuildQueries;
      rows.push(
        `${c.name.padEnd(38)} ${b.ms.toFixed(0).padStart(5)} ms   ` +
          `${ratio.toFixed(1).padStart(5)}x over ${String(b.typeNodes).padStart(5)} nodes   ` +
          `sub-build queries ${String(b.subBuildQueries).padStart(6)}, ` +
          `generated ${subRatio.toFixed(2)}x per node`,
      );
    }
    /**
     * §T.128 — THE SUITE MUST LIGHT THE VERTEX STAGE UP.
     *
     * Not every material sub-builds much: a flat quad with no `positionNode`
     * and few varyings (the waterline band) resolves almost every type
     * without one, and demanding a floor of every case would only be a false
     * requirement on new cases. What must hold is that the SET reaches the
     * vertex stage, and that the cases carried FOR that reach it: (2) is
     * vacuous on a case that never opens a sub-build, and a fragment-only
     * suite is exactly how a memo that bypassed 100% of the vertex stage
     * passed this file once already.
     */
    for (const name of VERTEX_STAGE_CASES) {
      expect(
        subBuildByCase.get(name),
        `${name}: no type query arrived inside a sub-build — this case is ` +
          `carried to exercise the vertex stage and is no longer doing so`,
      ).toBeGreaterThan(0);
    }
    expect(
      subBuildTotal,
      'no case exercises a sub-build — this suite cannot detect the §T.128 defect',
    ).toBeGreaterThan(1000);
    console.log(
      'material                               build ms   getNodeType per node\n' +
        rows.join('\n'),
    );
  }, 600_000);
});
