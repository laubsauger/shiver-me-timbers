/**
 * §T.79 — MEMOISE `getNodeType`. THE BUG IS IN THREE r180, NOT IN OUR SHADERS.
 *
 * Every TSL node infers its own type by asking its CHILDREN for theirs, and
 * nothing memoises the answer: `OperatorNode.getNodeType` queries both
 * operands, `MathNode` queries up to three through `getInputType`, and
 * `SplitNode` / `VarNode` / `ContextNode` / `CacheNode` all forward. A TSL
 * expression is a DAG, not a tree — every shared subexpression has several
 * parents — so ONE type query at the root re-walks each shared subgraph once
 * per path that reaches it. That is exponential in expression DEPTH, and it is
 * the whole of the cost. Measured headless on `ocean-surface`, one
 * `NodeBuilder.build()` (`tests/zzScratchOceanCompile.test.ts`):
 *
 *   14,570 ms of main thread to emit 43,187 B of WGSL  = 2.9 B/ms
 *   34,763,406 `getNodeType` calls over 1,170 distinct nodes = 29,712x
 *     (that count is only the classes three EXPORTS; OperatorNode, MathNode
 *      and ShaderCallNodeInternal are not on the export surface and are not in
 *      it, so the true call count is higher still)
 *   `Node.build` itself, same run: 8,715 over 1,738 unique = 5.0x — healthy
 *
 * It is invisible in a wall clock because it is not the driver, not Tint and
 * not pipeline creation. It is our tab's own JavaScript, which is why a second
 * boot was never faster and why no pipeline cache could ever help (§T.79).
 *
 * WHY A CACHE IS SAFE HERE, AND EXACTLY WHEN IT IS NOT. A node's type is a
 * function of the node and of the builder state that type inference reads.
 * Five things move under it, and all five are accounted for:
 *
 *  - `cache` — `CacheNode.getNodeType` swaps the builder's NodeCache around a
 *    child query, and node data (including `outputNode`) is PER CACHE. Keyed.
 *    This is also why there is a small SET of slots rather than one: a single
 *    slot let that swap-and-restore throw the memo away twice per query —
 *    measured at 559,483 resets over 19.9M calls, a 17% hit rate.
 *  - `buildStage` / `shaderStage` — vertex and fragment are separate builds of
 *    one graph, and a type answered mid-`setup` is not the final one. Keyed.
 *  - `subBuildFn` — decides which sub-build output a `Fn` call resolves to.
 *    Keyed.
 *  - `subBuildLayers` — `SubBuildNode.getNodeType` pushes a layer, and what a
 *    node's type resolves to then depends on the whole STACK: `subBuild` is
 *    what `getClosestSubBuild` searches (NodeBuilder.js:2699) and what decides
 *    which sub-build output a call resolves to. Keyed, on the stack JOINED —
 *    it is an array of one-word names ('VERTEX', 'NORMAL', 'POSITION') and
 *    never more than about three deep, so it is as comparable as the four
 *    scalar fields beside it, and a joined string is a conservative key: it
 *    distinguishes stacks that `getClosestSubBuild` would treat alike, never
 *    the reverse.
 *
 *    §T.128 — THIS FIELD WAS BYPASSED, AND IT COST ~40 s OF RAFT BOOT. Reading
 *    "depends on the whole stack" as "cannot be keyed" turned the memo OFF for
 *    the entire vertex stage, because `NodeMaterial.setupPosition` wraps the
 *    whole vertex setup in `subBuild(…, 'VERTEX')` (NodeMaterial.js:460) and
 *    every `varying` wraps its node the same way (VaryingNode.js:135). So the
 *    exponential re-walk this file exists to kill was still running, in full,
 *    on every material that displaces or carries a varying. Measured on the
 *    raft's boot: `piece-sail` 4,049,507 `getNodeType` entries, 100% bypassed,
 *    0% hit; the sierra terrain 7,791,113, likewise 100% bypassed — against
 *    the 15%/52% a fragment-only material like the rock was already getting.
 *    `compileAsync` was 79.2 s of pure main-thread JavaScript, which is what a
 *    "this tab is not responsive" dialog is made of.
 *  - late `setup` — `Node.build` forces a missing setup stage on demand, so an
 *    `outputNode` can be assigned long after the generate stage began and
 *    every type derived from it changes. An epoch counter bumped on every
 *    setup-stage build invalidates every slot. Setup itself runs effectively
 *    unmemoised, which is fine: it is the 5.0x half that never had a problem.
 *
 * Also never cached: a call with an explicit `output` (the answer then depends
 * on an argument), and any falsy result — `null` is what an un-set-up node
 * returns, and it is the one value that legitimately changes under us.
 *
 * VERIFICATION: `tests/nodeTypeCache.test.ts` builds every material this
 * project ships, with the cache and without it, and requires the emitted WGSL
 * to be BYTE-IDENTICAL — a wrong type cannot hide, since types are printed
 * into declarations, casts and swizzles. It asserts the PROPERTY this file
 * exists for (visits bounded per unique node), never a duration (§V.80).
 */
import * as THREE from 'three/webgpu';
import { Fn, float, mix } from 'three/tsl';

/** three's builder, reduced to the fields type inference reads. */
interface TypeBuilder {
  buildStage: string | null;
  shaderStage: string | null;
  subBuildLayers: string[];
  cache: { id: number } | null;
  subBuildFn: string | null;
}

interface Slot {
  cacheId: number;
  buildStage: string | null;
  shaderStage: string | null;
  subBuildFn: string | null;
  /** `subBuildLayers` joined — '' when the stack is empty (the common case) */
  subBuildKey: string;
  types: Map<object, string>;
}

/**
 * How many (cache, stage) coordinates one builder keeps memoised at once. A
 * CacheNode query needs two live at the same time and nesting adds a few; the
 * list is scanned linearly and evicted from the tail, so this trades a handful
 * of integer compares against unbounded retention.
 */
const SLOTS_PER_BUILDER = 8;

let installed = false;

/**
 * Live counters, so the memo is a measurement and not a claim (§V.62).
 * `resets` counts coordinates the cache could not carry across; each one
 * restarts a slot from empty.
 */
export const nodeTypeCacheStats = {
  calls: 0,
  hits: 0,
  resets: 0,
  bypasses: 0,
  epochs: 0,
  /**
   * Queries the memo HANDLED inside a sub-build — the vertex stage and every
   * varying (§T.128). Incremented past the bypass on purpose, so this reads
   * ZERO the moment sub-builds stop being memoised: it is the direct evidence
   * that the half of the graph this file used to skip is now covered, and
   * `tests/nodeTypeCache.test.ts` asserts it is non-zero for the cases carried
   * to exercise the vertex stage. A ratio bound cannot stand in for it — with
   * the bypass restored, every material in that suite still clears 400.
   */
  subBuildQueries: 0,
};

/** zero the counters — for a test that measures one build */
export function resetNodeTypeCacheStats(): void {
  nodeTypeCacheStats.calls = 0;
  nodeTypeCacheStats.hits = 0;
  nodeTypeCacheStats.resets = 0;
  nodeTypeCacheStats.bypasses = 0;
  nodeTypeCacheStats.epochs = 0;
  nodeTypeCacheStats.subBuildQueries = 0;
}

/**
 * Install the memo. Idempotent, and safe to call before any renderer exists —
 * it only touches node prototypes.
 *
 * MUST run before the first `NodeBuilder.build()`, i.e. before the first
 * `compileAsync` / first draw.
 */
export function installNodeTypeCache(): void {
  if (installed) return;
  installed = true;

  const slots = new WeakMap<object, Slot[]>();
  const epochOf = new WeakMap<object, number>();
  let epoch = 0;

  // Any setup-stage build can assign an `outputNode` and change the type of
  // everything above it. Bumping here is conservative and costs one string
  // compare per `Node.build` — 8,715 of them against ~20M type queries.
  const nodeProto = (THREE as unknown as { Node: { prototype: object } }).Node
    .prototype as {
    build: (builder: TypeBuilder, ...rest: unknown[]) => unknown;
  };
  const originalBuild = nodeProto.build;
  nodeProto.build = function (
    this: object,
    builder: TypeBuilder,
    ...rest: unknown[]
  ): unknown {
    if (builder !== undefined && builder.buildStage === 'setup') {
      epoch++;
      nodeTypeCacheStats.epochs++;
    }
    return originalBuild.call(this, builder, ...rest);
  };

  const memoise = (proto: object): void => {
    const target = proto as {
      getNodeType: (builder: TypeBuilder, output?: unknown) => unknown;
    };
    const original = target.getNodeType;
    if (typeof original !== 'function') return;
    target.getNodeType = function (
      this: object,
      builder: TypeBuilder,
      output?: unknown,
    ): unknown {
      nodeTypeCacheStats.calls++;
      // NO BUILDER AT ALL is a real call shape, not a defensive guard:
      // `UniformArrayElementNode.generate` (and several `getNodeType()`
      // overrides that ignore the argument) call it with none. There is
      // nothing to key on, so it cannot be cached.
      if (
        builder === undefined ||
        builder === null ||
        (output !== undefined && output !== null)
      ) {
        nodeTypeCacheStats.bypasses++;
        return original.call(this, builder, output);
      }

      let list = slots.get(builder);
      if (list === undefined || epochOf.get(builder) !== epoch) {
        list = [];
        slots.set(builder, list);
        epochOf.set(builder, epoch);
      }

      const cacheId = builder.cache === null ? -1 : builder.cache.id;
      // the empty case is the common one and costs no allocation; a sub-build
      // stack is one to three one-word names, so the join is a few characters
      const layers = builder.subBuildLayers;
      const subBuildKey = layers.length === 0 ? '' : layers.join(' ');
      if (subBuildKey !== '') nodeTypeCacheStats.subBuildQueries++;
      let slot: Slot | undefined;
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (
          s.cacheId === cacheId &&
          s.buildStage === builder.buildStage &&
          s.shaderStage === builder.shaderStage &&
          s.subBuildFn === builder.subBuildFn &&
          s.subBuildKey === subBuildKey
        ) {
          slot = s;
          if (i > 0) {
            list.splice(i, 1);
            list.unshift(s);
          }
          break;
        }
      }
      if (slot === undefined) {
        slot = {
          cacheId,
          buildStage: builder.buildStage,
          shaderStage: builder.shaderStage,
          subBuildFn: builder.subBuildFn,
          subBuildKey,
          types: new Map(),
        };
        list.unshift(slot);
        if (list.length > SLOTS_PER_BUILDER) list.pop();
        nodeTypeCacheStats.resets++;
      }

      const hit = slot.types.get(this);
      if (hit !== undefined) {
        nodeTypeCacheStats.hits++;
        return hit;
      }
      const type = original.call(this, builder, output) as string;
      if (type) slot.types.set(this, type);
      return type;
    };
  };

  // Every class that overrides `getNodeType` has to be wrapped, or its
  // override recurses into children the wrapped classes cannot see. Most are
  // on three/webgpu's export surface; OperatorNode, MathNode and
  // ShaderCallNodeInternal are not, so reach those through one instance each
  // (`nodeObject` wraps nodes in a Proxy; `getPrototypeOf` forwards to it).
  const protos = new Set<object>();
  for (const value of Object.values(THREE as unknown as Record<string, unknown>)) {
    const proto = (value as { prototype?: object } | undefined)?.prototype;
    if (proto && Object.prototype.hasOwnProperty.call(proto, 'getNodeType')) {
      protos.add(proto);
    }
  }
  protos.add(Object.getPrototypeOf(float(1).add(1) as unknown as object) as object);
  protos.add(
    Object.getPrototypeOf(
      mix(float(0), float(1), float(0.5)) as unknown as object,
    ) as object,
  );
  protos.add(Object.getPrototypeOf(Fn(() => float(0))() as unknown as object) as object);
  for (const proto of protos) memoise(proto);
}
