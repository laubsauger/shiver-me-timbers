/**
 * §V.40 as an enforced budget, not a comment.
 *
 * The ocean surface material is the widest shader in the project and it binds
 * close to the WebGPU per-stage ceiling. Overrun does NOT degrade: creating the
 * bind group layout fails, the pipeline is invalid, the material never draws,
 * and the console names the DESCRIPTOR rather than the feature that added the
 * binding. That is a whole session lost every time, so the count lives here.
 *
 * WHY A SOURCE LEDGER AND NOT A BUILT GRAPH. The honest test would walk the
 * compiled node graph, but `material.colorNode` is `Fn(() => …)()` — the body
 * only runs inside `NodeBuilder.build()`, which needs a live GPUDevice. There
 * is none in vitest. So this file pins the two halves separately:
 *
 *   (1) a TRIPWIRE — the number of binding-creating call sites in every file
 *       the ocean material composes. Add a `texture()` anywhere on that path
 *       and this fails, with the recount instructions attached;
 *   (2) the LEDGER — how many bindings each of those call sites actually
 *       contributes per shader stage, hand-derived (a call site inside a
 *       `map`/helper contributes once per cascade, not once), and summed
 *       against the limit.
 *
 * (2) cannot be derived from (1) mechanically. (1) is what makes it impossible
 * to change one without being told to revisit the other.
 *
 * HOW THE COUNTING WORKS (three r180, verified in node_modules):
 *  - bindings are deduped per shader stage by TEXTURE UUID, not by node:
 *    `TextureNode.getUniformHash()` returns `this.value.uuid` and
 *    `UniformNode.generate` shares through `builder.getNodeFromHash`. Two
 *    `viewportDepthTexture()` calls therefore cost ONE binding.
 *  - the vertex and fragment stages get SEPARATE bindings for the same node:
 *    `WGSLNodeBuilder.getUniformFromNode` keys `uniformGPU` on
 *    `(node, shaderStage)`. `totalDisp` is used by `positionNode` AND inside
 *    `colorNode`, so the three displacement textures are bound TWICE, once per
 *    stage — and each stage is measured against the limit on its own.
 *  - every FILTERABLE texture gets its own `${name}_sampler` binding. Samplers
 *    are never shared between textures, so the sampler count is simply the
 *    number of filterable textures. Textures that are unfilterable
 *    (`minFilter === magFilter === NearestFilter` and no `compareFunction`)
 *    are read with `textureLoad` and cost NO sampler — that is why the
 *    FramebufferTexture and the shared viewport depth buffer are free here.
 *  - `shadow(light)` is normally TWO textures: the shadow map's DepthTexture
 *    (compare sampler) and the render target's COLOUR texture, which
 *    `ShadowNode.setupShadow` folds into `shadowOutput` unconditionally for
 *    coloured shadows. Both are `.toVar()`-ed, so neither compiles away — the
 *    only way to shed the second one is to never build that expression.
 *    `src/sky/uncoloredShadowNode.ts` does exactly that and publishes itself
 *    on `light.shadow.shadowNode`, so the `shadow()` call site below is a
 *    fallback that never fires and costs ONE texture, not two.
 *
 * THE NEXT RECLAMATION, AND THE THREE TRAPS IN IT (all read out of
 * node_modules/three@0.180.0 — do not re-derive, but do re-verify the EMITTED
 * WGSL, because the array path silently diverges from the 2D path).
 *
 * A 2D-array texture is ONE texture and ONE sampler for all its layers, so
 * folding the three cascades into one `THREE.StorageArrayTexture(n, n, 3)` and
 * sampling `texture(arr, uv).depth(i)` turns 3 bindings into 1. The whole path
 * exists in r180 and is wired end to end: `WGSLNodeBuilder.js:1753` emits
 * `texture_2d_array<f32>`, `:1749` emits `texture_storage_2d_array`,
 * `WebGPUBindingUtils.js:119/193` sets `viewDimension: '2d-array'`, and
 * `Textures.js:403` takes the layer count from `image.depth`. It has ZERO
 * usages and ZERO tests inside three itself — we would be its first user.
 *
 *  1. A FILTERABLE ARRAY TEXTURE CANNOT BE SAMPLED IN THE VERTEX STAGE AT ALL.
 *     `WGSLNodeBuilder.generateTextureSampleLevel` (and `generateTextureLevel`)
 *     DROP `depthSnippet` in the filterable branch — they return
 *     `textureSampleLevel(tex, tex_sampler, uv, level)` with no array index,
 *     which is not a valid overload for `texture_2d_array`. The vertex stage
 *     always routes there (`_generateTextureSample`, :236-238, because
 *     `textureSample` is fragment-only). `generateTextureGrad` is no escape
 *     either: it also drops the index AND `console.error`s outside fragment.
 *     Only the UNFILTERABLE path (`generateTextureLod` → `generateTextureLoad`)
 *     carries the index. ⟹ `derivatives` (fragment-only) is convertible;
 *     `displacement` (vertex AND fragment) is NOT, without giving up bilinear
 *     in the vertex stage.
 *
 *  2. `textureStore(tex, uv, val).depth(i)` STACKS THE WRONG NODE.
 *     `textureStore` calls `node.toStack()` IMMEDIATELY (StorageTextureNode.js
 *     :238) while `.depth()` returns a CLONE (TextureNode.js:713). So the
 *     un-layered node is what gets emitted and the layered clone is dropped on
 *     the floor — `textureStore(t, uv, val)` with no array index, invalid WGSL
 *     for `texture_storage_2d_array`. Write it as
 *       `storageTexture(arr, coord, value).depth(int(layer)).toWriteOnly()
 *          .toStack();`
 *     i.e. build the node, clone it WITH the layer, and stack that.
 *
 *  3. `.depth()` SILENTLY RESETS STORAGE ACCESS. `TextureNode.clone()` calls
 *     `new this.constructor(value, uvNode, levelNode, biasNode)` — for a
 *     `StorageTextureNode` that third slot is `storeNode`, and while
 *     `StorageTextureNode.clone()` repairs `storeNode` afterwards it never
 *     copies `access`, which therefore falls back to the `writeOnly` default.
 *     Any `.toReadOnly()`/`.toReadWrite()` placed BEFORE `.depth()` is lost.
 *     Always set access after the layer.
 *
 * THE VERTEX ESCAPE HATCH, recorded so it is not rediscovered. The vertex stage
 * is at 3/3 and under no pressure, so `displacement` stays three plain 2D
 * textures. But if the FRAGMENT side ever needs those three back: an array
 * `displacement` plus a hand-rolled 4-tap `textureLoad` bilinear in the vertex
 * stage is BETTER on bindings than today — 1 texture and ZERO samplers in
 * vertex, 1 + 1 in fragment, against 3 + 3 in each now. It is a real change and
 * not a refactor (four fetches instead of one, and the filtering maths becomes
 * ours), so it is an escape hatch, not a plan.
 */
import { describe, expect, it } from 'vitest';
// `?raw` rather than fs: this repo has no @types/node, and vite hands the
// source straight to the test as a string.
import appSource from '../src/core/app.ts?raw';
import surfaceMaterialSource from '../src/ocean/surfaceMaterial.ts?raw';
import foamSource from '../src/foam/index.ts?raw';
import foamShadingSource from '../src/foam/foamShading.ts?raw';
import flowFoamSource from '../src/flowfoam/index.ts?raw';
import seabedSource from '../src/island/seabed.ts?raw';
import reflectionShadingSource from '../src/reflection/reflectionShading.ts?raw';
import planarReflectionSource from '../src/reflection/planarReflection.ts?raw';
import uncoloredShadowSource from '../src/sky/uncoloredShadowNode.ts?raw';

/** WebGPU's DEFAULT per-stage limits — what an adapter grants if nobody asks */
const WEBGPU_DEFAULT_SAMPLED_TEXTURES_PER_STAGE = 16;
const WEBGPU_DEFAULT_SAMPLERS_PER_STAGE = 16;

/**
 * `maxSamplersPerShaderStage` is the one limit that raising is NOT guaranteed
 * to buy anything on: Metal caps samplers per function at 16, so on Apple
 * hardware `adapter.limits.maxSamplersPerShaderStage` IS 16 and
 * `src/core/app.ts` asking for the adapter's own value changes nothing.
 * Sampled textures are the roomy axis (Metal allows far more than 16 textures
 * per function); samplers are the wall. Budget against the wall.
 */
const SAMPLER_CEILING = WEBGPU_DEFAULT_SAMPLERS_PER_STAGE;

interface LedgerEntry {
  file: string;
  source: string;
  /** binding-creating call sites in the file, comments stripped */
  sites: number;
  /** sampled-texture bindings this file contributes to the FRAGMENT stage */
  fragmentTextures: number;
  /** of those, how many are filterable and therefore also cost a sampler */
  fragmentSamplers: number;
  /** sampled-texture bindings this file contributes to the VERTEX stage */
  vertexTextures: number;
  vertexSamplers: number;
  why: string;
}

const LEDGER: readonly LedgerEntry[] = [
  {
    file: 'src/ocean/surfaceMaterial.ts',
    source: surfaceMaterialSource,
    sites: 6,
    // 3 displacement + 3 derivatives (sampleDisp/sampleDeriv, once per
    // cascade) + shadow map DEPTH ONLY (§V.40: the coloured-shadow colour RT
    // is gone, see uncoloredShadowNode.ts) + the shared viewport depth buffer
    // (2 call sites, ONE texture) + the scene-colour FramebufferTexture
    fragmentTextures: 6 + 1 + 1 + 1,
    // the FramebufferTexture (Nearest/Nearest) and the shared DepthTexture
    // (Nearest/Nearest, no compareFunction) are unfilterable → textureLoad
    fragmentSamplers: 6 + 1,
    // positionNode re-samples the same three displacement textures
    vertexTextures: 3,
    vertexSamplers: 3,
    why: 'texture()×2 helpers × 3 cascades, shadow()=1 (depth only), viewportDepthTexture()×2=1, viewportTexture()=1',
  },
  {
    file: 'src/sky/uncoloredShadowNode.ts',
    source: uncoloredShadowSource,
    // ZERO. That is the whole point of the file: it reimplements
    // `ShadowNode.setupShadow` WITHOUT `texture( shadowMap.texture, … )`.
    // Adding a texture() here puts the sampler straight back into every
    // shadow receiver in the scene, ocean material included.
    sites: 0,
    fragmentTextures: 0,
    fragmentSamplers: 0,
    vertexTextures: 0,
    vertexSamplers: 0,
    why: 'the shadow node that binds depth only — tripwire, must stay at 0',
  },
  {
    file: 'src/foam/index.ts',
    source: foamSource,
    sites: 2,
    // shadingNode: lane.front for all 3 cascades + lane.coarse on cascade 0.
    // The 128² lane.coarseMid is COMPUTED EVERY FRAME AND NEVER SAMPLED — see
    // the DIAGNOSED, NOT YET FIXED block. Sampling it is +1 texture +1 sampler.
    fragmentTextures: 4,
    fragmentSamplers: 4,
    vertexTextures: 0,
    vertexSamplers: 0,
    why: 'texture(lane.front) × 3 lanes + texture(lane.coarse) × 1 lane',
  },
  {
    file: 'src/foam/foamShading.ts',
    source: foamShadingSource,
    sites: 1,
    // foamDetailMask / foamTintNode / foamWarpVec / capVariationNode are all
    // procedural (terrain/noise). The one texture() lives in foamShadingNode,
    // which the ocean material does not call. Listed so an addition trips (1).
    fragmentTextures: 0,
    fragmentSamplers: 0,
    vertexTextures: 0,
    vertexSamplers: 0,
    why: 'foamShadingNode is not on the ocean path — tripwire only',
  },
  {
    file: 'src/flowfoam/index.ts',
    source: flowFoamSource,
    sites: 3,
    // The ocean now calls ALL THREE — foamSampleNode (white paint),
    // wakeSmoothNode (capillary damping) and wakeSlopeNode (the wake's own
    // surface). It costs NOTHING extra: all three read the SAME two storage
    // textures (acc.foamTexture, far.foamTexture) and bindings dedupe by
    // texture UUID per stage, so 3 call sites are still 2 textures.
    fragmentTextures: 2,
    fragmentSamplers: 2,
    vertexTextures: 0,
    vertexSamplers: 0,
    why: 'foamSampleNode: acc.foamTexture + far.foamTexture',
  },
  {
    file: 'src/island/seabed.ts',
    source: seabedSource,
    sites: 1,
    // §V.24 shallows tint. Half-float DataTexture, LinearFilter → filterable.
    fragmentTextures: 1,
    fragmentSamplers: 1,
    vertexTextures: 0,
    vertexSamplers: 0,
    why: 'seabedShallowFactorNode → texture(field.texture)',
  },
  {
    file: 'src/reflection/reflectionShading.ts',
    source: reflectionShadingSource,
    sites: 1,
    // reflectionNode.sample(uv) — .sample() clones the node but keeps the same
    // texture value, so the mip-level variant costs no extra binding.
    fragmentTextures: 1,
    fragmentSamplers: 1,
    vertexTextures: 0,
    vertexSamplers: 0,
    why: 'the mirror pass render target',
  },
  {
    file: 'src/reflection/planarReflection.ts',
    source: planarReflectionSource,
    sites: 1,
    // reflector() builds the node counted above; it adds no binding of its own.
    fragmentTextures: 0,
    fragmentSamplers: 0,
    vertexTextures: 0,
    vertexSamplers: 0,
    why: 'reflector() construction only — the binding is counted in reflectionShading',
  },
];

/** every TSL call that creates a texture (and therefore possibly a sampler) */
const BINDING_PATTERNS: readonly RegExp[] = [
  /\btexture\s*\(/g,
  /\btexture3D\s*\(/g,
  /\bcubeTexture\s*\(/g,
  /\bviewportTexture\s*\(/g,
  /\bviewportDepthTexture\s*\(/g,
  /\bviewportSharedTexture\b/g,
  /\bshadow\s*\(/g,
  /\breflector\s*\(/g,
  /\.sample\s*\(/g,
  /\btextureLoad\s*\(/g,
];

/** block and line comments carry example code; they bind nothing */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function countSites(rawSource: string): number {
  const source = stripComments(rawSource);
  let total = 0;
  for (const pattern of BINDING_PATTERNS) {
    total += (source.match(pattern) ?? []).length;
  }
  return total;
}

const sum = (pick: (e: LedgerEntry) => number): number =>
  LEDGER.reduce((acc, e) => acc + pick(e), 0);

describe('§V.40 ocean material binding budget', () => {
  it('has no unaccounted binding call site on the ocean path', () => {
    for (const entry of LEDGER) {
      expect(
        countSites(entry.source),
        `${entry.file}: binding call sites changed. §V.40 — RECOUNT the ocean ` +
          `material's per-stage bindings and update the ledger in this file ` +
          `before shipping. Existing sites: ${entry.why}`,
      ).toBe(entry.sites);
    }
  });

  it('fits the FRAGMENT sampler ceiling with exactly one sampler spare', () => {
    const samplers = sum((e) => e.fragmentSamplers);
    // 15 of 16. The one free sampler was bought by dropping three's
    // coloured-shadow colour texture (uncoloredShadowNode.ts) and it is
    // SPOKEN FOR: it is what affords the foam mid-tier fix (§foam/index.ts
    // DIAGNOSED block, +1 filterable texture), which is the reason that fix
    // blanked the page. Spend it there, not somewhere else — and when it is
    // spent, this number becomes 16 again and nothing further may be added
    // without reclaiming first.
    //
    // Still far too tight for a 3-cascade CSMShadowNode: three builds one full
    // ShadowNode per cascade, so even with this subclass that is +1 texture
    // and +1 sampler PER EXTRA CASCADE on top of the 15 here.
    expect(samplers).toBe(15);
    expect(samplers).toBeLessThanOrEqual(SAMPLER_CEILING);
    expect(sum((e) => e.vertexSamplers)).toBeLessThanOrEqual(SAMPLER_CEILING);
  });

  it('exceeds the DEFAULT sampled-texture limit, so app.ts must raise it', () => {
    const textures = sum((e) => e.fragmentTextures);
    expect(textures).toBe(17);
    // The whole point of §V.40: this material cannot be drawn by a device
    // created with the WebGPU defaults.
    expect(textures).toBeGreaterThan(WEBGPU_DEFAULT_SAMPLED_TEXTURES_PER_STAGE);
    // 3/3 and under no pressure — the vertex stage samples only the three
    // displacement textures. If the FRAGMENT side ever needs them, see "THE
    // VERTEX ESCAPE HATCH" in this file's header: an array displacement with a
    // hand-rolled 4-tap bilinear costs 1 texture and 0 samplers here.
    expect(sum((e) => e.vertexTextures)).toBe(3);
  });

  it('still requests the raised limits at device creation', () => {
    const app = appSource;
    // Deleting any of these silently returns the device to the 16-texture
    // default and the ocean stops drawing — with an error naming the
    // descriptor, not this change.
    for (const limit of [
      'maxSampledTexturesPerShaderStage',
      'maxSamplersPerShaderStage',
      'maxStorageTexturesPerShaderStage',
      'maxUniformBuffersPerShaderStage',
    ]) {
      expect(app, `app.ts must keep requesting ${limit} (§V.40)`).toContain(limit);
    }
    expect(app).toContain('requiredLimits');
  });
});
