/**
 * §T.79 — the two things `src/core/nodeTypeCache.ts` has to be true for.
 *
 * (1) IT CHANGES NOTHING THAT IS DRAWN. Every material below is built twice
 *     from a fresh graph — once against stock three, once with the memo
 *     installed — and the emitted WGSL must be BYTE-IDENTICAL. This is the
 *     whole safety argument: a wrong type cannot hide, because types are
 *     printed into every declaration, cast and swizzle in the shader.
 *
 * (2) THE WALK IS LINEAR IN GRAPH SIZE, NOT EXPONENTIAL IN DEPTH. Asserted as
 *     a PROPERTY — `getNodeType` calls per DISTINCT node — never as a duration
 *     (§V.80: a threshold in ms pins a machine, not a decision). Stock r180
 *     measured 29,712 calls per distinct node on `ocean-surface`; with the memo
 *     it is 21. The bound below is two orders of magnitude above the measured
 *     value and still two orders below the defect, so it fails on a regression
 *     and survives any legitimate change to the shader.
 *
 * (3) §T.128 — IT COVERS THE VERTEX STAGE, WHICH FOR TWO MONTHS IT DID NOT.
 *     `NodeMaterial.setupPosition` builds the whole vertex setup inside
 *     `subBuild(…, 'VERTEX')` (three r180 NodeMaterial.js:460) and every
 *     `varying` wraps its node the same way (VaryingNode.js:135), and the memo
 *     used to BYPASS itself for the entire duration of any sub-build. So every
 *     material that displaces or carries a varying still paid the full
 *     exponential re-walk, and this test passed anyway — because a ratio that
 *     is 29x instead of 5x still clears a bound of 400. The numbers that were
 *     hiding under that, measured on the raft's boot:
 *
 *       piece-sail       4,049,507 getNodeType entries, 100% bypassed, 0% hit
 *       sierra terrain   7,791,113 entries,             100% bypassed, 0% hit
 *       rock (fragment)     30,270 entries,              16% bypassed, 54% hit
 *
 *     `compileAsync` on `/raft.html` was 79.2 s of main-thread JavaScript,
 *     which is what a "this tab is not responsive" dialog is made of.
 *
 *     Keying the sub-build stack instead of bypassing it moved every material
 *     in the table below, including ones that had nothing to do with the raft:
 *
 *       ocean-surface             20x -> 6x     (24 ms -> 15 ms)
 *       ship piece: hull-section 143x -> 6x     (42 ms -> 12 ms)
 *       ship piece: deck         137x -> 6x     (39 ms -> 10 ms)
 *       sand                      58x -> 5x     (26 ms -> 10 ms)
 *       terrain blend            29x  -> 5x     (65 ms -> 39 ms)
 *
 *     THE GUARD, AND WHY THE BOUND CANNOT REPLACE IT — measured, not assumed.
 *     Reinstating the bypass in a snapshot with the guard removed, this suite
 *     STILL PASSES: no case's ratio crosses 400 under the defect, not even the
 *     sierra terrain's. A ratio bound is the wrong instrument for "the memo
 *     was never consulted", because the un-memoised walk is still linear-ish
 *     in a small graph. So the property is asserted directly:
 *     `subBuildQueries` counts the queries the memo HANDLED inside a sub-build
 *     (it is incremented past the bypass, so a bypassed memo reads zero by
 *     construction), and this test fails if the vertex-stage cases stop
 *     producing any. With the bypass restored it fails on the sail case at
 *     "expected 0 to be greater than 0", which is the defect named exactly.
 *
 * WHY THIS RUNS AT ALL WITHOUT A GPU. `NodeBuilder.build()` — TSL setup, WGSL
 * codegen and binding setup, i.e. exactly the `sync` column of
 * `src/core/compileProfile.ts` — never touches a GPUDevice; only the pipeline
 * creation that follows it does. A `WebGPURenderer` that was never `init()`ed
 * is enough, given a stub canvas and the two fields `backend.init` would have
 * assigned. (The comment in `tests/oceanBindingBudget.test.ts` saying the body
 * of a `Fn()` "only runs inside NodeBuilder.build(), which needs a live
 * GPUDevice" is wrong on the second half — that file's own approach is still
 * the right one for a BINDING LEDGER, which this cannot replace.)
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { lights } from 'three/tsl';
import { OceanSimulation } from '../src/ocean/oceanCascades';
import { buildOceanSurfaceMaterial } from '../src/ocean/surfaceMaterial';
import { buildOceanGrid, type SurfaceGridOptions } from '../src/ocean/surfaceGeometry';
import { oceanSurfaceParams as sp } from '../src/params/oceanSurface';
import {
  installNodeTypeCache,
  nodeTypeCacheStats,
  resetNodeTypeCacheStats,
} from '../src/core/nodeTypeCache';
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
  wgsl: string;
  /** wall ms of `NodeBuilder.build()` — REPORTED, never asserted (§V.80) */
  ms: number;
  /** `getNodeType` entries */
  typeCalls: number;
  /** distinct nodes those entries landed on */
  typeNodes: number;
}

/**
 * Count `getNodeType` entries per class. `Node.prototype` alone is not enough —
 * ~30 subclasses override it — so wrap every prototype on three's export
 * surface. OperatorNode / MathNode are NOT exported and so are not counted
 * here; that only makes the measured ratio an UNDER-count, which is the safe
 * direction for an upper bound.
 */
function countTypeCalls(): { stop: () => { calls: number; nodes: number } } {
  let calls = 0;
  const seen = new Set<unknown>();
  const restore: Array<() => void> = [];
  for (const value of Object.values(THREE as unknown as Record<string, unknown>)) {
    const proto = (value as { prototype?: Record<string, unknown> } | undefined)
      ?.prototype;
    if (!proto || !Object.prototype.hasOwnProperty.call(proto, 'getNodeType')) continue;
    const original = proto.getNodeType;
    if (typeof original !== 'function') continue;
    proto.getNodeType = function (this: unknown, ...args: unknown[]): unknown {
      calls++;
      seen.add(this);
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
    restore.push(() => {
      proto.getNodeType = original;
    });
  }
  return {
    stop: () => {
      for (const r of restore) r();
      return { calls, nodes: seen.size };
    },
  };
}

/**
 * THE ONE THING THAT LEGITIMATELY DIFFERS BETWEEN TWO BUILDS OF THE SAME
 * SHADER, and it is not a type. `WGSLNodeBuilder` names an unnamed uniform
 * buffer `NodeBuffer_` + the node's GLOBAL id (`WGSLNodeBuilder.js:982`), and
 * that counter advances for every node any code in the process has ever
 * constructed. The second leg therefore gets a higher number for the same
 * buffer — a rename, in one identifier, with no semantic content. Everything
 * else, including every type, cast and swizzle, is compared verbatim.
 */
const normalise = (wgsl: string): string =>
  wgsl.replace(/NodeBuffer_\d+/g, 'NodeBuffer_N');

function build(material: THREE.Material, geometry: THREE.BufferGeometry): Built {
  const renderer = new THREE.WebGPURenderer({ canvas: stubCanvas() });
  const mesh = new THREE.Mesh(geometry, material);
  const backend = (renderer as unknown as { backend: Record<string, unknown> })
    .backend;
  // both normally assigned by `backend.init(renderer)`, which needs a device.
  // codegen reads `backend.renderer` only for sample counts, and `hasFeature`
  // only to pick a texture path — pinned to the browser's answer so the WGSL
  // this test compares is the WGSL the game ships.
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

  const probe = countTypeCalls();
  const t0 = performance.now();
  (builder as unknown as { build: () => void }).build();
  const ms = performance.now() - t0;
  const { calls, nodes } = probe.stop();
  return {
    wgsl: normalise(
      `${builder.vertexShader as string}\n/*---*/\n${builder.fragmentShader as string}`,
    ),
    ms,
    typeCalls: calls,
    typeNodes: nodes,
  };
}

const GRID: SurfaceGridOptions = {
  segments: sp.gridSegments,
  coreSpacing: sp.gridCoreSpacing,
  horizonRadius: sp.gridHorizonRadius,
  rimRound: sp.gridRimRound,
};

/**
 * One entry per material under test. Each is a FACTORY, not a material: the
 * two legs must build from graphs that were constructed independently, or the
 * second leg would be reading node properties the first one left behind.
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
 * THE BOUND, and what it is a wall between. Measured on this machine, stock
 * r180 against the memo, `getNodeType` calls per DISTINCT node:
 *
 *   ocean-surface            29,712x ->  21x     (26,454 ms -> 36 ms)
 *   ocean-surface (hdr)      29,712x ->  21x     (25,923 ms -> 36 ms)
 *   ship piece: hull-section  1,033x -> 143x        (262 ms -> 62 ms)
 *   sand                        682x ->  58x        (183 ms -> 39 ms)
 *   terrain blend (islands)     496x ->  29x        (466 ms -> 100 ms)
 *   ship piece: deck            433x -> 137x        (117 ms -> 58 ms)
 *   rock                        272x ->   5x        (147 ms -> 25 ms)
 *
 * 400 sits above every memoised ratio and below every stock ratio in that
 * list, so each of those seven cases FAILS this test if the memo is removed or
 * stops hitting. The remaining cases (palm 14x, waterline 46x, rain 33x,
 * impact rings 6x, the two stock three materials) are small enough that they
 * never had the problem and would pass either way — they are carried for the
 * BYTE-IDENTITY half, which is where their value is.
 *
 * The ratio is what is asserted, never the ms: the times are reported so a
 * regression has something to be compared against, but a duration pins a
 * machine rather than a decision (§V.80).
 */
const MAX_TYPE_CALLS_PER_NODE = 400;

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
  it('emits byte-identical WGSL and walks the graph a bounded number of times', () => {
    const before = new Map<string, Built>();
    for (const c of CASES) {
      const { material, geometry } = c.make();
      // GUARD: `NodeBuilder.build()` silently substitutes a default
      // NodeMaterial for anything that is not one, and would then compare two
      // identical DEFAULT shaders and pass while testing nothing (§V.80's
      // "passes while enforcing the defect"). Fail instead.
      expect(
        (material as unknown as { isNodeMaterial?: boolean }).isNodeMaterial,
        `${c.name}: not a NodeMaterial, this case would test nothing`,
      ).toBe(true);
      before.set(c.name, build(material, geometry));
    }

    installNodeTypeCache();

    const rows: string[] = [];
    /** how many memoised queries arrived inside a sub-build, per case (§T.128) */
    let subBuildTotal = 0;
    const subBuildByCase = new Map<string, number>();
    for (const c of CASES) {
      const { material, geometry } = c.make();
      resetNodeTypeCacheStats();
      const after = build(material, geometry);
      const memo = { ...nodeTypeCacheStats };
      subBuildTotal += memo.subBuildQueries;
      const stock = before.get(c.name);
      expect(stock, c.name).toBeDefined();
      // (1) same picture — the emitted shader is the same text
      expect(after.wgsl, `${c.name}: WGSL changed`).toBe(stock?.wgsl);
      // (2) the walk is linear in graph size
      const ratio = after.typeCalls / Math.max(1, after.typeNodes);
      expect(
        ratio,
        `${c.name}: ${after.typeCalls} getNodeType calls over ` +
          `${after.typeNodes} distinct nodes = ${ratio.toFixed(0)}x`,
      ).toBeLessThan(MAX_TYPE_CALLS_PER_NODE);
      subBuildByCase.set(c.name, memo.subBuildQueries);
      const s0 = stock as Built;
      rows.push(
        `${c.name.padEnd(34)} ` +
          `${s0.ms.toFixed(0).padStart(7)} -> ${after.ms.toFixed(0).padStart(5)} ms   ` +
          `${(s0.typeCalls / Math.max(1, s0.typeNodes)).toFixed(0).padStart(6)}x -> ` +
          `${ratio.toFixed(0).padStart(3)}x   over ${String(after.typeNodes).padStart(5)} nodes  ` +
          `sub-build queries ${String(memo.subBuildQueries).padStart(7)}, ` +
          `${((100 * memo.hits) / Math.max(1, memo.calls)).toFixed(0).padStart(3)}% hit`,
      );
    }
    /**
     * §T.128 — THE SUITE MUST LIGHT THE VERTEX STAGE UP.
     *
     * Not every material sub-builds: a flat quad with no `positionNode` and no
     * varyings (the waterline band, the impact rings) resolves its types
     * without one, and demanding otherwise of every case would only be a false
     * requirement on new cases. What must hold is that the SET reaches the
     * vertex stage, and that the two cases carried FOR that reach it — a
     * fragment-only suite measures half a graph and is exactly how a memo that
     * bypassed 100% of the vertex stage passed this file once already.
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
      'material                             build ms          getNodeType per node\n' +
        rows.join('\n'),
    );
  }, 600_000);
});
