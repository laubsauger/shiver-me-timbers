/**
 * §T.128 — THE RAFT'S MATERIAL GRAPHS MUST STAY LINEAR IN GRAPH SIZE.
 *
 * WHAT WENT WRONG, TWICE. §B84: an inline chain of 35 `smin` levels in the
 * face SDF cost ~4^35 node visits because three's `getNodeType` re-walks its
 * inputs with no memo. §T.79 answered that globally with
 * `src/core/nodeTypeCache.ts` — and then §T.128 measured the boot and found
 * the memo does not cover the VERTEX stage at all: `NodeMaterial.setupPosition`
 * builds the whole vertex graph inside `subBuild(…, 'VERTEX')`
 * (three r180 NodeMaterial.js:460), every `varying` does the same
 * (VaryingNode.js:135), and `nodeTypeCache.ts:164` bypasses the memo for the
 * entire duration of any sub-build. Measured on `piece-sail`: 4,049,507
 * `getNodeType` entries, 100% of them bypassing the memo, 590 per distinct
 * node — §B84 alive again in the one place the fix for it cannot reach.
 *
 * So a material that does real work in the vertex stage has to defend itself,
 * and the defence is the same one §B84 landed: a TYPED `Fn`.
 * `ShaderCallNodeInternal.getNodeType` is
 * `shaderNode.nodeType || getOutputNode(builder).getNodeType(builder)`
 * (TSLCore.js:461) — pin the type and the walk stops at that level instead of
 * re-entering the body.
 *
 * WHAT THIS ASSERTS, AND WHY IT IS NOT A DURATION. `getNodeType` entries per
 * DISTINCT node, over one real `NodeBuilder.build()` of each material the raft
 * actually draws. That is the property the defect violates; a millisecond
 * threshold would pin this machine instead of the decision (§V.80). Measured
 * here, sail before → after typing the 18 cloth `Fn`s:
 *
 *   piece-sail          590x/node -> 135x/node      (366 ms -> 119 ms build)
 *
 * and the rest of the raft's kinds, today, unchanged by that edit:
 *
 *   splashboard 131x · guara 131x · mast 115x · yard 115x · thatch-roof 92x
 *   bipod-mast/crossbeam/stern-block/steering-oar 67x · log 60x
 *   bamboo-deck 13x · cabin-wall 13x · pennant 26x
 *   crate 5x · lashing 5x · rope-rail 5x · radio 5x
 *
 * THE BOUND sits above every one of those and below the defect: removing the
 * typed `Fn`s from `sailClothNodes.ts` puts the sail back at 590x and this
 * fails. It is deliberately loose for the others — they are carried so a new
 * deep chain anywhere in the raft's material tree trips the same wire.
 *
 * WHY THIS RUNS WITHOUT A GPU: `NodeBuilder.build()` — TSL setup, WGSL codegen
 * and binding setup — never touches a GPUDevice; only the pipeline creation
 * after it does. See `tests/nodeTypeCache.test.ts`, whose harness this is.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { lights } from 'three/tsl';
import { installNodeTypeCache } from '../src/core/nodeTypeCache';
import { createPieceMaterial } from '../src/ship/pieceMaterials';
import { buildRaftBlueprint } from '../src/ship/raftBlueprint';
import type { PieceKind } from '../src/ship/pieceTypes';

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

/**
 * Count `getNodeType` entries and the distinct nodes they land on.
 *
 * `Node.prototype` alone is not enough — ~30 subclasses override it — so wrap
 * every prototype on three's export surface. `OperatorNode` / `MathNode` /
 * `ShaderCallNodeInternal` are NOT exported and so are not counted, which only
 * makes the measured ratio an UNDER-count: the safe direction for an upper
 * bound.
 */
function countTypeCalls(): { stop: () => { calls: number; nodes: number } } {
  let calls = 0;
  const seen = new Set<unknown>();
  const restore: Array<() => void> = [];
  for (const value of Object.values(THREE as unknown as Record<string, unknown>)) {
    const proto = (value as { prototype?: Record<string, unknown> } | undefined)?.prototype;
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

interface Built {
  calls: number;
  nodes: number;
  /** wall ms — REPORTED so a regression has something to read, never asserted */
  ms: number;
  wgslBytes: number;
}

/**
 * One real `NodeBuilder.build()` of `material`, under the lighting the raft
 * actually draws in — a shadow-casting sun plus ambient. The lights matter:
 * they are what pull the vertex-stage varyings into the graph, which is the
 * half the §T.79 memo cannot see.
 */
function build(material: THREE.Material, geometry: THREE.BufferGeometry): Built {
  const renderer = new THREE.WebGPURenderer({ canvas: stubCanvas() });
  const mesh = new THREE.Mesh(geometry, material);
  const backend = (renderer as unknown as { backend: Record<string, unknown> }).backend;
  // both normally assigned by `backend.init(renderer)`, which needs a device
  backend.renderer = renderer;
  (renderer as unknown as { hasFeature: (n: string) => boolean }).hasFeature = (
    name: string,
  ): boolean => name === 'float32-filterable';
  const builder = (
    backend as unknown as {
      createNodeBuilder: (o: THREE.Object3D, r: THREE.WebGPURenderer) => Record<string, unknown>;
    }
  ).createNodeBuilder(mesh, renderer);
  const scene = new THREE.Scene();
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.castShadow = true;
  scene.add(sun, sun.target);
  builder.scene = scene;
  builder.material = material;
  builder.camera = new THREE.PerspectiveCamera();
  (builder.context as Record<string, unknown>).material = material;
  builder.lightsNode = lights([sun, new THREE.HemisphereLight()] as never);

  const probe = countTypeCalls();
  const t0 = performance.now();
  (builder as unknown as { build: () => void }).build();
  const ms = performance.now() - t0;
  const { calls, nodes } = probe.stop();
  return {
    calls,
    nodes,
    ms,
    wgslBytes:
      ((builder.vertexShader as string) ?? '').length +
      ((builder.fragmentShader as string) ?? '').length,
  };
}

/** see the header — above every kind measured today, below the §B84 shape */
const MAX_TYPE_CALLS_PER_NODE = 300;

describe('§T.128 raft material graph cost', () => {
  it('walks each piece graph a bounded number of times per node', () => {
    // the memo is installed by both entries before the first build; measure
    // what the game measures (`main-raft.ts:42`, `main.ts:116`)
    installNodeTypeCache();

    // EVERY KIND THE RAFT ACTUALLY CARRIES, read off the blueprint rather than
    // listed here — a kind added to the raft is a material that boots, so it
    // joins this bound automatically (§V.37).
    const kinds = [...new Set(buildRaftBlueprint().map((p) => p.kind))];
    expect(kinds.length).toBeGreaterThan(10);

    const box = new THREE.BoxGeometry(1, 1, 1);
    const rows: string[] = [];
    for (const kind of kinds) {
      const material = createPieceMaterial(kind as PieceKind);
      // GUARD: `NodeBuilder.build()` silently substitutes a default
      // NodeMaterial for anything that is not one, and would then measure a
      // default shader and pass while testing nothing (§V.80).
      expect(
        (material as unknown as { isNodeMaterial?: boolean }).isNodeMaterial,
        `${kind}: not a NodeMaterial, this case would test nothing`,
      ).toBe(true);
      const r = build(material, box);
      const ratio = r.calls / Math.max(1, r.nodes);
      expect(
        ratio,
        `piece-${kind}: ${r.calls} getNodeType calls over ${r.nodes} distinct ` +
          `nodes = ${ratio.toFixed(0)}x — a deep TSL chain lost its typed Fn (§B84)`,
      ).toBeLessThan(MAX_TYPE_CALLS_PER_NODE);
      rows.push(
        `piece-${kind.padEnd(16)} ${ratio.toFixed(0).padStart(5)}x/node over ` +
          `${String(r.nodes).padStart(5)} nodes  ${r.ms.toFixed(0).padStart(5)} ms  ` +
          `${(r.wgslBytes / 1024).toFixed(1).padStart(6)} KB`,
      );
    }
    console.log('§T.128 raft piece graphs\n' + rows.join('\n'));
  }, 600_000);
});
