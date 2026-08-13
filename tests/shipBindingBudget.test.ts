/**
 * §V.40 for the SHIP materials — the second budget, and the reason it exists.
 *
 * `tests/oceanBindingBudget.test.ts` pins the ocean, which is the widest shader
 * in the project and sits one sampler under the wall. The ship had NO
 * equivalent, so its count was folklore: the §B.48 deck work started by asking
 * "how many samplers does a wood material actually bind?" and the honest answer
 * was that nobody had ever counted, only assumed it was roomy. It IS roomy —
 * but "roomy" measured once in a session and written in a report decays, and
 * this material family is the one most likely to grow a texture, because every
 * proposal for more plank depth (a normal map, a parallax height map, an AO
 * map, a detail albedo) is a texture on this exact path.
 *
 * WHY THE SHIP GETS ITS OWN FILE RATHER THAN A ROW IN THE OCEAN'S. Bind group
 * layouts are PER PIPELINE. The 16-sampler Metal ceiling applies to each shader
 * separately, so the ocean's 15 and the ship's 9 do not add — they are two
 * independent budgets against the same limit, and merging them into one number
 * would be wrong in the direction that matters (it would read as 24/16 and
 * panic, or worse, be "fixed" by deleting something).
 *
 * THE FAILURE MODE IS THE POINT (§V.40). Overrun does not degrade: creating the
 * bind group layout fails, the pipeline is invalid, THE MATERIAL NEVER DRAWS,
 * and the console names the descriptor rather than the feature that added the
 * binding. On the ship that means an invisible hull, which reads as a geometry
 * bug and costs a session.
 *
 * COUNTING RULES are three's, and identical to the ocean file's — see its
 * header for the derivation out of node_modules. In short: bindings dedupe per
 * stage by texture UUID, vertex and fragment count separately, and every
 * FILTERABLE texture carries its own sampler (unfilterable ones are read with
 * `textureLoad` and are free).
 *
 * THE DECK FAMILY IS THE WIDEST WOOD MATERIAL, so it is what is budgeted here.
 * It is the only family that binds the deck heightfield (`WoodTones.deckField`)
 * and the only one that calls `deckWetness`; the hull family swaps those for
 * the waterline term, which is pure maths and binds nothing. Budget the worst
 * case, not the average.
 */
import { describe, expect, it } from 'vitest';
// `?raw` rather than fs: this repo has no @types/node, and vite hands the
// source straight to the test as a string.
import woodMaterialSource from '../src/ship/woodMaterial.ts?raw';
import fittingMaterialsSource from '../src/ship/fittingMaterials.ts?raw';
import waterLightingSource from '../src/caustics/waterLighting.ts?raw';
import causticsNodeSource from '../src/caustics/causticsNode.ts?raw';
import deckMaterialNodeSource from '../src/deckwater/deckMaterialNode.ts?raw';
import uncoloredShadowSource from '../src/sky/uncoloredShadowNode.ts?raw';

/**
 * Metal caps samplers per function at 16, so on Apple silicon
 * `adapter.limits.maxSamplersPerShaderStage` IS 16 and asking for more buys
 * nothing (§V.40). Samplers are the wall; sampled textures are the roomy axis.
 */
const SAMPLER_CEILING = 16;

interface LedgerEntry {
  file: string;
  source: string;
  /** binding-creating call sites in the file, comments stripped */
  sites: number;
  /** sampled-texture bindings this file contributes to a DECK wood material */
  fragmentTextures: number;
  /** of those, how many are filterable and therefore also cost a sampler */
  fragmentSamplers: number;
  why: string;
}

const LEDGER: readonly LedgerEntry[] = [
  {
    file: 'src/ship/woodMaterial.ts',
    source: woodMaterialSource,
    sites: 1,
    // the deck heightfield, RGBA half-float, LinearMipmapLinear/Linear →
    // filterable, so it carries a sampler. Deck family only.
    fragmentTextures: 1,
    fragmentSamplers: 1,
    why: 'textureNode(fld.texture) — the deck heightfield (deck family only)',
  },
  {
    file: 'src/caustics/waterLighting.ts',
    source: waterLightingSource,
    sites: 1,
    // the hull wetline's drying memory, LinearFilter → filterable
    fragmentTextures: 1,
    fragmentSamplers: 1,
    why: 'texture(ctx.wetline.texture) — the wetline drying memory',
  },
  {
    file: 'src/caustics/causticsNode.ts',
    source: causticsNodeSource,
    sites: 2,
    // BOTH call sites sit inside `for (const c of sim.cascades)`, so each is
    // one SITE and three BINDINGS — except the derivatives, which are one
    // StorageArrayTexture for all three layers (§V.40, one texture, one
    // sampler). Displacement is still three separate 2D textures.
    fragmentTextures: 1 + 3,
    // createOutputTexture sets LinearFilter on both → all four are filterable
    fragmentSamplers: 1 + 3,
    why: 'sampleCascadeLayer(c.derivatives)×3 = 1 array, texture(c.displacement)×3 = 3',
  },
  {
    file: 'src/deckwater/deckMaterialNode.ts',
    source: deckMaterialNodeSource,
    sites: 2,
    // the solver's front state + ONE band-limited tier (coarse2). Both are
    // StorageTextures with LinearFilter → filterable.
    fragmentTextures: 2,
    fragmentSamplers: 2,
    why: 'texture(ctx.state) + texture(ctx.coarse) — deck family only',
  },
  {
    file: 'src/sky/uncoloredShadowNode.ts',
    source: uncoloredShadowSource,
    // ZERO sites on purpose: this subclass exists precisely because it does
    // NOT build `texture(shadowMap.texture, shadowCoord)`. If a `texture()`
    // ever appears here, every shadow-receiving material in the project gains
    // a binding at once — including all ~30 ship piece materials.
    sites: 0,
    // the sun shadow map's DepthTexture, bound by three's own lighting node
    // rather than by any source file here. One, not two, because of this file.
    fragmentTextures: 1,
    // a depth texture with a compareFunction takes a comparison sampler
    fragmentSamplers: 1,
    why: 'the sun shadow map, depth only — the colour RT is what this file removes',
  },
  {
    file: 'src/ship/fittingMaterials.ts',
    source: fittingMaterialsSource,
    // iron and glass are procedural. Listed so that giving a fitting a texture
    // map trips this rather than being discovered as an invisible cannon.
    sites: 0,
    fragmentTextures: 0,
    fragmentSamplers: 0,
    why: 'iron/glass are fully procedural — no bindings',
  },
];

/** every TSL call that creates a texture (and therefore possibly a sampler) */
const BINDING_PATTERNS: readonly RegExp[] = [
  /\btexture\s*\(/g,
  // woodMaterial imports `texture as textureNode`, so the bare pattern above
  // does not see it. Both spellings are listed or the ship's own binding is
  // the one thing this file cannot count.
  /\btextureNode\s*\(/g,
  /\btexture3D\s*\(/g,
  /\bcubeTexture\s*\(/g,
  /\bviewportTexture\s*\(/g,
  /\bviewportDepthTexture\s*\(/g,
  /\bshadow\s*\(/g,
  /\breflector\s*\(/g,
  /\.sample\s*\(/g,
  /\btextureLoad\s*\(/g,
  /\bsampleCascadeLayer\s*\(/g,
];

/** block and line comments carry example code; they bind nothing */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
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

describe('§V.40 ship material binding budget', () => {
  it('has no unaccounted binding call site on the wood-material path', () => {
    for (const entry of LEDGER) {
      expect(
        countSites(entry.source),
        `${entry.file}: binding call sites changed. §V.40 — RECOUNT the deck ` +
          `wood material's fragment bindings and update the ledger in this ` +
          `file before shipping. Existing sites: ${entry.why}`,
      ).toBe(entry.sites);
    }
  });

  it('budgets the DECK wood material at 9 of 16 samplers', () => {
    // Measured, not assumed — this number is the whole point of the file.
    //   1  deck heightfield          (woodMaterial)
    //   1  hull wetline              (waterLighting)
    //   1  ocean derivatives ARRAY   (causticsNode, all three cascades)
    //   3  ocean displacement        (causticsNode, one per cascade)
    //   2  deck water state + tier   (deckMaterialNode)
    //   1  sun shadow map, depth     (three's lighting, kept to one by
    //                                 uncoloredShadowNode)
    expect(sum((e) => e.fragmentSamplers)).toBe(9);
    expect(sum((e) => e.fragmentTextures)).toBe(9);
    expect(sum((e) => e.fragmentSamplers)).toBeLessThanOrEqual(SAMPLER_CEILING);
  });

  it('keeps enough headroom to buy plank depth with a texture if it comes to it', () => {
    // WHY THIS ASSERTION IS PHRASED AS HEADROOM. §B.48 was fixed procedurally
    // — a band-limited plateau step (§V.70) and a procedural `aoNode`, both of
    // which add ZERO bindings. Parallax/POM was considered and declined on
    // cost, not on budget. If that decision is ever revisited, a height map
    // plus a normal map is +2 here, and this test says up front whether that
    // is affordable rather than leaving it to be discovered by an invisible
    // hull. It also fails loudly if someone quietly spends the room first.
    const spare = SAMPLER_CEILING - sum((e) => e.fragmentSamplers);
    expect(spare).toBeGreaterThanOrEqual(4);
  });

  it('binds nothing in the VERTEX stage, unlike the ocean', () => {
    // The ocean pays for its three displacement textures TWICE because
    // `positionNode` re-samples them (bindings key on (node, shaderStage)).
    // Wood materials set no `positionNode`: the ship is displaced by its
    // transform, not by a shader, so the whole vertex budget is free. Recorded
    // because "add vertex displacement to the deck for real plank geometry"
    // is a live idea and it would double-bind everything it samples.
    expect(woodMaterialSource).not.toContain('positionNode');
  });
});
