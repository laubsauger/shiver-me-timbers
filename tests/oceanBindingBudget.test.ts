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
 *  - `shadow(light)` is TWO textures: the shadow map's DepthTexture (compare
 *    sampler) and the render target's colour texture, which
 *    `ShadowNode.setup` folds into `shadowOutput` unconditionally for coloured
 *    shadows. Both are `.toVar()`-ed, so neither compiles away.
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
    // cascade) + shadow map depth + shadow map colour + the shared viewport
    // depth buffer (2 call sites, ONE texture) + the scene-colour
    // FramebufferTexture
    fragmentTextures: 6 + 2 + 1 + 1,
    // the FramebufferTexture (Nearest/Nearest) and the shared DepthTexture
    // (Nearest/Nearest, no compareFunction) are unfilterable → textureLoad
    fragmentSamplers: 6 + 2,
    // positionNode re-samples the same three displacement textures
    vertexTextures: 3,
    vertexSamplers: 3,
    why: 'texture()×2 helpers × 3 cascades, shadow()=2, viewportDepthTexture()×2=1, viewportTexture()=1',
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
    // the ocean calls foamSampleNode only: near region + far region.
    // wakeSmoothNode/wakeSlopeNode are the other two sites and are unwired.
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

  it('fits the FRAGMENT sampler ceiling with zero headroom', () => {
    const samplers = sum((e) => e.fragmentSamplers);
    // Exactly at the wall today. This is not a comfortable pass — it is the
    // reason the foam mid-tier fix (§foam/index.ts DIAGNOSED block, +1
    // filterable texture) blanked the page, and the reason a 3-cascade
    // CSMShadowNode (+2 textures and +2 samplers per extra cascade, because
    // three builds one full ShadowNode per cascade) cannot be adopted as-is.
    expect(samplers).toBe(16);
    expect(samplers).toBeLessThanOrEqual(SAMPLER_CEILING);
    expect(sum((e) => e.vertexSamplers)).toBeLessThanOrEqual(SAMPLER_CEILING);
  });

  it('exceeds the DEFAULT sampled-texture limit, so app.ts must raise it', () => {
    const textures = sum((e) => e.fragmentTextures);
    expect(textures).toBe(18);
    // The whole point of §V.40: this material cannot be drawn by a device
    // created with the WebGPU defaults.
    expect(textures).toBeGreaterThan(WEBGPU_DEFAULT_SAMPLED_TEXTURES_PER_STAGE);
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
